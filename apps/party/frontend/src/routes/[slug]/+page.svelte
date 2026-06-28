<script lang="ts">
  // A party's catalog: productions grouped by competition, ranked, with a
  // detail panel that dispatches to the right viewer by medium — music → the
  // libopenmpt Player, images/video native where possible, text → NfoView,
  // demos/intros → an emulator placeholder (Phase 3). Everything downloadable.
  import {
    ChevronRight,
    Film,
    Image as ImageIcon,
    Monitor,
    Music,
    PanelLeft,
    Search,
    X,
  } from "@lucide/svelte";
  import {
    cueInOrder,
    playback,
    playInOrder,
    stop as stopPlayback,
    type Track,
    Transport,
  } from "@scene/player";
  import { untrack } from "svelte";

  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { api, type Production, type ProductionDetail } from "$lib/api";
  import FileBrowser from "$lib/FileBrowser.svelte";
  import { listKeys } from "$lib/listkeys";
  import Settings from "$lib/Settings.svelte";

  const slug = $derived(page.params.slug ?? "");
  let prods = $state<Production[]>([]);
  let kickstart = $state<string | null>(null);
  let error = $state<string | null>(null);
  let selected = $state<Production | null>(null);
  let detail = $state<ProductionDetail | null>(null);

  // The URL is the single source of truth for the selection (?p=<prodId>&f=<rel
  // _path>). Reads are reactive off page.url; writes go through goto() (a real
  // same-route navigation that updates page.url reactively — unlike shallow
  // replaceState). replaceState:true keeps it out of the history stack;
  // keepFocus/noScroll avoid disturbing the list. Reload + back/forward + share
  // all "just work" because the view derives from the URL.
  const pid = $derived(page.url.searchParams.get("p"));
  const fileParam = $derived(page.url.searchParams.get("f"));
  function nav(updates: Record<string, string | null>) {
    const u = new URL(page.url);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null) u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    void goto(u, { replaceState: true, keepFocus: true, noScroll: true });
  }

  // Mobile (≤720px): the catalog is a slide-over drawer, auto-closed on
  // selection so the detail/player gets the whole screen.
  let isMobile = $state(false);
  $effect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 720px)");
    const update = () => (isMobile = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  // Fetch the productions for the current party.
  $effect(() => {
    const s = slug;
    api
      .productions(s)
      .then((r) => {
        prods = r.productions;
        kickstart = r.kickstart_url;
      })
      .catch((e) => (error = String(e)));
  });

  // Selection is derived from the URL: this runs on click (goto changed ?p), on
  // load/reload (the param is already there), and on back/forward. Ignores a
  // stale response if ?p moved on while the fetch was in flight.
  $effect(() => {
    const id = pid;
    if (prods.length === 0) return;
    if (!id) {
      selected = null;
      detail = null;
      return;
    }
    if (selected?.id === id) return; // already loaded — don't refetch
    const prod = prods.find((x) => x.id === id);
    if (!prod) return;
    selected = prod;
    detail = null;
    // On a phone, slide the catalog drawer away so the detail fills the screen.
    if (isMobile) navOpen = false;
    // Reveal it in the catalog (cards are collapsed by default; unranked
    // entries hide behind "+N more").
    open[prod.compo] = true;
    if (prod.rank == null) showRest[prod.compo] = true;
    // Music: cue the track (stopped) so the transport renders even on a reload
    // restore — otherwise `{#if playback.current}` hides the controls. Skip if
    // it's already current (a click played it, or next/prev advanced to it), so
    // we don't reset live playback.
    if (
      prod.primary_kind === "music" &&
      prod.primary_hash &&
      playback.current?.hash !== prod.primary_hash
    ) {
      cueInOrder(musicTracks, toTrack(prod));
    }
    api
      .production(id)
      .then((d) => {
        if (selected?.id === id) detail = d;
      })
      .catch((e) => {
        if (selected?.id === id) error = String(e);
      });
  });

  // Follow the player: when next/prev/auto-advance changes the current track,
  // move the catalog selection + URL to match. Depend ONLY on playback.current
  // — `pid` is read untracked, so an explicit unselect (which clears ?p but
  // leaves the track playing) doesn't re-trigger this and re-select it.
  $effect(() => {
    const cur = playback.current;
    if (!cur || prods.length === 0) return;
    const prod = prods.find((p) => p.primary_hash === cur.hash);
    if (prod && prod.id !== untrack(() => pid)) nav({ p: prod.id, f: null });
  });

  // Catalog search: filters productions by title / group / compo. While a query
  // is active, every matching card is force-opened (see the template) so results
  // are visible without manual expansion.
  let query = $state("");
  const q = $derived(query.trim().toLowerCase());
  function matches(p: Production): boolean {
    if (!q) return true;
    return (
      (p.title?.toLowerCase().includes(q) ?? false) ||
      (p.group?.toLowerCase().includes(q) ?? false) ||
      p.compo.toLowerCase().includes(q)
    );
  }

  // Group by compo. The party-info bits (Info, Misc) are surfaced first — handy
  // as an overview — then the competitions alphabetically. Empty groups (none of
  // whose entries match the active query) drop out.
  const FIRST = ["Info", "Misc"];
  const groups = $derived.by(() => {
    // Plain Map: a throwaway grouping recomputed each run, not reactive state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const m = new Map<string, Production[]>();
    for (const p of prods) {
      if (!matches(p)) continue;
      const arr = m.get(p.compo);
      if (arr) arr.push(p);
      else m.set(p.compo, [p]);
    }
    const rank = (c: string) => (FIRST.includes(c) ? FIRST.indexOf(c) : FIRST.length);
    return [...m.entries()].sort(
      ([a], [b]) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }),
    );
  });

  // The transport's title doubles as "jump to what's playing": select the
  // production whose primary is the current track, opening its player view.
  function openPlayingView() {
    const cur = playback.current;
    if (!cur) return;
    const prod = prods.find((p) => p.primary_hash === cur.hash);
    if (prod) {
      nav({ p: prod.id, f: null });
      if (isMobile) navOpen = false;
    }
  }

  // Collapsible category cards, closed by default — the left panel is a scannable
  // overview (Info/Misc first); open a card to see its entries.
  let open = $state<Record<string, boolean>>({});
  function toggle(compo: string) {
    open[compo] = !open[compo];
  }

  // The catalog left panel is a drawer — collapsible to give the detail/emulator
  // the full width.
  let navOpen = $state(true);

  // Within a card, show only the ranked entries (the competition top results)
  // by default; the unranked `rest/` productions hide behind "show more".
  let showRest = $state<Record<string, boolean>>({});

  function toTrack(p: Production): Track {
    return {
      hash: p.primary_hash as string,
      // Real filename (with extension) — the display prefers `title`, but the
      // player reads the extension off this to tune the boing ball's pixels.
      filename: p.primary_filename ?? p.title ?? "untitled",
      title: p.title,
      group: p.group,
    };
  }

  const musicTracks = $derived(
    prods.filter((p) => p.primary_kind === "music" && p.primary_hash).map(toTrack),
  );

  function select(p: Production) {
    // Write the selection to the URL; the effect above reacts and loads detail.
    nav({ p: p.id, f: null });
    // Autoplay only on an explicit click (a user gesture) — never on URL
    // restore, where the browser would block audio anyway.
    if (p.primary_kind === "music" && p.primary_hash) {
      void playInOrder(musicTracks, toTrack(p));
    }
  }

  function clearSelection() {
    // Drop the selection from the URL (the effect clears selected/detail), stop
    // any playing music (the X closes the view, so the player goes with it), and
    // reveal the catalog drawer so you can pick another — forced open on both
    // desktop (if collapsed) and mobile (where it's the full-screen list).
    stopPlayback();
    nav({ p: null, f: null });
    navOpen = true;
  }

  function mediumIcon(m: string) {
    if (m === "music") return Music;
    if (m === "graphics") return ImageIcon;
    if (m === "animation") return Film;
    return Monitor;
  }
</script>

<header>
  <button
    class="navtoggle"
    onclick={() => (navOpen = !navOpen)}
    title="Toggle list"
    aria-label="Toggle list"
  >
    <PanelLeft size={18} />
  </button>
  <!-- The party name is the way home — click it to return to the parties list. -->
  <a class="title" href="/" title="Back to parties">{slug}</a>
  <span class="sub">{prods.length} productions</span>
  <Settings />
</header>

<main>
  {#if error}
    <p class="error">{error}</p>
  {/if}

  <div class="cols" class:nav-hidden={!navOpen}>
    <section class="catalog">
      <div class="catalog-inner">
        <div class="searchbar">
          <Search size={14} />
          <input
            type="search"
            placeholder="Search title, group, compo…"
            bind:value={query}
            aria-label="Search productions"
          />
          {#if q}
            <button class="clearq" onclick={() => (query = "")} aria-label="Clear search">
              <X size={14} />
            </button>
          {/if}
        </div>
        {#each groups as [compo, entries] (compo)}
          {@const isOpen = open[compo] || !!q}
          <div class="cat" class:open={isOpen}>
            <button class="cathead" onclick={() => toggle(compo)} aria-expanded={isOpen}>
              <ChevronRight class="chev" size={14} />
              {#key entries[0]?.medium}
                {@const Icon = mediumIcon(entries[0]?.medium ?? "")}
                <Icon class="catkind" size={14} />
              {/key}
              <span class="catname">{compo}</span>
              <span class="catcount">{entries.length}</span>
            </button>
            {#if isOpen}
              {@const ranked = entries.filter((e) => e.rank != null)}
              {@const rest = entries.filter((e) => e.rank == null)}
              {@const list = q || showRest[compo] || ranked.length === 0 ? entries : ranked}
              <ul use:listKeys>
                {#each list as p (p.id)}
                  <li>
                    <button
                      class:sel={selected?.id === p.id}
                      class:playing={p.primary_hash != null &&
                        p.primary_hash === playback.current?.hash}
                      onclick={() => select(p)}
                    >
                      <span class="rank">{p.rank ?? ""}</span>
                      <span class="name">
                        {#if p.group}<b>{p.group}</b>&nbsp;—&nbsp;{/if}{p.title ?? "(untitled)"}
                      </span>
                      {#if p.points != null}
                        <span class="pts">{p.points}p</span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
              {#if !q && ranked.length > 0 && rest.length > 0}
                <button class="more" onclick={() => (showRest[compo] = !showRest[compo])}>
                  {showRest[compo] ? "Show less" : `+${rest.length} more`}
                </button>
              {/if}
            {/if}
          </div>
        {:else}
          <p class="noresults">No productions match “{query}”.</p>
        {/each}
      </div>
    </section>

    <section class="detail">
      {#if !selected}
        <p class="muted">Select a production.</p>
      {:else}
        {@const prod = selected}
        <div class="dhead">
          <div class="dhead-info">
            <h2>{prod.title ?? "(untitled)"}</h2>
            <p class="credit">
              {#if prod.group}{prod.group} ·
              {/if}{prod.compo}
              {#if prod.rank}· #{prod.rank}{/if}
              {#if prod.points != null}· {prod.points} pts{/if}
            </p>
            {#if detail?.meta}
              <p class="meta">
                {detail.meta.type_long ?? ""}
                {#if detail.meta.channels}· {detail.meta.channels} ch{/if}
                {#if detail.meta.instruments}· {detail.meta.instruments} ins{/if}
                {#if detail.meta.tracker}· {detail.meta.tracker}{/if}
              </p>
            {/if}
          </div>
          <button class="unselect" onclick={clearSelection} title="Close" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <!-- One unified two-pane browser handles every production type: the
				     primary file (auto-selected) opens its "star" viewer — emulator
				     (DOS/C64/Amiga), music player, image or video — and the other
				     files (NFO, screenshots) open in the same pane. -->
        {#if detail}
          <FileBrowser
            files={detail.files}
            primary={prod.primary_hash}
            platform={prod.platform}
            prodId={prod.id}
            {kickstart}
            initialFile={fileParam}
            onfile={(relPath) => nav({ f: relPath })}
          />
        {/if}
      {/if}
    </section>
  </div>

  <!-- Global now-playing bar: spans both panes and stays visible whenever a
	     track is loaded, so music keeps its controls even after you navigate to
	     another production. The title jumps back to the playing entry. -->
  <Transport onOpenView={openPlayingView} showPos={false} />
</main>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
  }
  .navtoggle {
    color: var(--text);
    display: grid;
    place-items: center;
    background: none;
    border: 0;
    cursor: pointer;
    padding: 0;
  }
  .navtoggle:hover {
    color: var(--accent);
  }
  .title {
    margin: 0;
    font-family: var(--font-retro);
    font-size: 18px;
    color: var(--accent);
    text-decoration: none;
  }
  .title:hover {
    text-decoration: underline;
  }
  .sub {
    color: var(--muted);
    font-size: 13px;
    margin-right: auto;
  }
  main {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    padding: 0;
    /* Positioning context for the mobile catalog drawer (see @media below). */
    position: relative;
  }
  .cols {
    display: grid;
    grid-template-columns: 340px 1fr;
    flex: 1;
    min-height: 0;
    transition: grid-template-columns 0.22s ease;
  }
  .cols.nav-hidden {
    grid-template-columns: 0px 1fr;
  }
  .cols.nav-hidden .catalog {
    border-right-color: transparent;
  }
  /* The grid item only clips; the fixed-width inner keeps its layout so the
	   shrinking track slides it out cleanly instead of reflowing/wrapping its
	   text. (Same trick the FileBrowser list drawer uses.) */
  .catalog {
    overflow: hidden;
    border-right: 1px solid var(--border);
  }
  .catalog-inner {
    width: 340px;
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 12px 14px;
  }
  .cat {
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-bottom: 6px;
    overflow: hidden;
  }
  .cathead {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 7px 9px;
    border: 0;
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .cathead:hover {
    background: var(--panel-hi);
  }
  .cathead :global(.chev) {
    transition: transform 0.12s ease;
    color: var(--muted);
  }
  .cat.open .cathead :global(.chev) {
    transform: rotate(90deg);
  }
  .cathead :global(.catkind) {
    flex: 0 0 auto;
    color: var(--muted);
  }
  .catname {
    flex: 1;
    text-align: left;
    font-weight: 600;
  }
  .catcount {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .catalog ul {
    list-style: none;
    margin: 0;
    padding: 4px;
    border-top: 1px solid var(--border);
  }
  .catalog ul button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 5px 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
    font-size: 13px;
  }
  .catalog ul button:hover {
    background: var(--panel-hi);
  }
  .catalog ul button.sel {
    background: var(--accent-dim);
  }

  .catalog ul button.playing {
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .catalog ul button.playing .name {
    color: var(--accent);
  }
  .searchbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--muted);
  }
  .searchbar input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    outline: none;
  }
  .clearq {
    display: inline-flex;
    align-items: center;
    padding: 2px;
    border: 0;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .clearq:hover {
    color: var(--accent);
  }
  .noresults {
    color: var(--muted);
    font-size: 13px;
    padding: 8px 4px;
  }
  .more {
    width: 100%;
    padding: 5px;
    border: 0;
    border-top: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
  }
  .more:hover {
    background: var(--panel-hi);
    color: var(--accent);
  }
  .rank {
    flex: 0 0 22px;
    text-align: right;
    color: var(--muted);
    font-family: var(--font-mono-retro);
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pts {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--muted);
    font-size: 11px;
  }
  .detail {
    overflow: hidden;
    min-height: 0;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .dhead {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .dhead-info {
    flex: 1;
    min-width: 0;
  }
  .unselect {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }
  .unselect:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .dhead h2 {
    margin: 0;
    font-size: 20px;
  }
  .credit {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 13px;
  }
  .meta {
    color: var(--muted);
    font-size: 13px;
    margin: 0;
  }
  .error {
    color: #ff4136;
    padding: 0 20px;
  }
  .muted {
    color: var(--muted);
  }
  @media (max-width: 720px) {
    /* Single-pane: the detail fills the screen; the catalog is an off-canvas
		   drawer that slides in over it, toggled by the header list button and
		   auto-closed on selection (so the player/emulator gets the whole phone). */
    .cols,
    .cols.nav-hidden {
      grid-template-columns: 1fr;
    }
    .catalog {
      position: absolute;
      inset: 0;
      z-index: 8;
      width: 100%;
      background: var(--bg);
      border-right: 0;
      transform: translateX(0);
      transition: transform 0.22s ease;
    }
    .cols.nav-hidden .catalog {
      transform: translateX(-100%);
      border-right-color: var(--border);
      box-shadow: none;
    }
    .catalog-inner {
      width: 100%;
    }
    .detail {
      padding: 12px;
    }
  }
</style>

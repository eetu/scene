<script lang="ts">
  // The library content region: the scroll container + its states (scan / load /
  // error / empty), the virtualized grouped list, and the A-Z quick-jump rail.
  // Reads the shared stores directly (library data, view prefs, the derived
  // grouped list); the parent owns the overlays, so track actions come in as
  // callbacks (open the player view / add to playlist / rename), plus the
  // playlists tab's data (that tab's own state lives in +page for now).
  import { ChevronRight, ListPlus, Pencil, Play, Star, Trash2 } from "@lucide/svelte";
  import { BoingBall, playback } from "@scene/player";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { tick, untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";

  import AlphabetRail from "$lib/AlphabetRail.svelte";
  import type { Playlist, Track } from "$lib/api";
  import {
    buildRows,
    GROUPLESS,
    GROUPLESS_LABEL,
    letterRowMap,
    type LibRow,
    NO_ALBUM,
    NO_ALBUM_LABEL,
    rowKey,
    subLabel,
  } from "$lib/library";
  import { library, rescanLibrary, toggleFavorite } from "$lib/library.svelte";
  import { lib } from "$lib/library-view.svelte";
  import { manifestIndex } from "$lib/manifest.svelte";
  import PlaylistsTab from "$lib/PlaylistsTab.svelte";
  import { STANDALONE } from "$lib/standalone";
  import { remove as removeLocal } from "$lib/standalone/store.svelte";
  import { view } from "$lib/view.svelte";

  let {
    active,
    onOpen,
    onAdd,
    onEdit,
    playlists,
    onRefreshPlaylists,
    onPlayList,
    onToast,
  }: {
    // True when this list is the foreground view (the player overlay is closed).
    // Its rising edge is what triggers "reveal the current track" (see below).
    active: boolean;
    onOpen: (t: Track) => void;
    onAdd: (t: Track) => void;
    onEdit: (t: Track) => void;
    playlists: Playlist[];
    onRefreshPlaylists: () => void;
    onPlayList: (list: Track[], start?: Track) => void;
    onToast: (msg: string, kind?: "ok" | "err") => void;
  } = $props();

  function fmtTime(sec: number): string {
    if (!sec || !isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // Standalone (backend-less) build: delete a module from the browser-local
  // library (bytes + catalog). library.tracks is the store's array, so removing
  // updates the list reactively.
  async function deleteTrack(t: Track) {
    if (!confirm(`Remove "${t.title || t.filename}" from your browser?`)) return;
    await removeLocal(t.hash);
    onToast(`Removed ${t.title || t.filename}`);
  }

  // First-run scan progress (shown in the scan panel). null = indeterminate.
  const scanPct = $derived.by(() => {
    const total = library.status?.scan_total ?? 0;
    if (!total) return null;
    return Math.round((Math.min(library.status?.scan_processed ?? 0, total) / total) * 100);
  });

  // Group open/closed state. Few groups (≤12) default to open; a user toggle is
  // remembered per group in an override map (so auto-open groups can be closed
  // and vice-versa). The flat row list below only emits rows for open groups.
  const groupOverride = new SvelteMap<string, boolean>();
  const expandAll = $derived(lib.groups.length <= 12);
  function isOpen(name: string): boolean {
    return groupOverride.get(name) ?? expandAll;
  }
  function toggleGroup(name: string) {
    groupOverride.set(name, !isOpen(name));
  }

  // ---- virtualized library list ----
  // Flatten the grouped tree into one row stream (a header row per group, plus
  // the track rows of open groups) and virtualize it with TanStack Virtual, so
  // thousands of <li> never hit the DOM at once. (buildRows/rowKey in $lib/library.)
  const rows = $derived<LibRow[]>(buildRows(lib.groups, isOpen));

  // ≤640px: track rows stay ONE line (title/artist + duration), a touch taller
  // for a comfortable tap target; playcount is dropped and the name ellipsises
  // before it can overlap the duration (see the mobile CSS block).
  let isMobile = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => (isMobile = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  // Exact, fixed row heights (px) — must match the CSS below (driven from the
  // same ROW_H via --row-h, so they can't desync). Deterministic sizing (no
  // measureElement) keeps offsets above the viewport stable, so opening a group
  // never reflows/jumps the rows already on screen. The inline rename editor
  // lives in a modal precisely so every row stays a fixed height.
  const ROW_H = $derived(isMobile ? 40 : 34);
  const HEAD_H = 40;
  const CARD_GAP = 8;
  function rowSize(i: number): number {
    const r = rows[i];
    if (r.kind === "header") return HEAD_H + (r.first ? 0 : CARD_GAP);
    return ROW_H;
  }

  let scrollEl = $state<HTMLElement | undefined>(undefined);
  const virtualizer = createVirtualizer<HTMLElement, HTMLElement>({
    count: 0,
    getScrollElement: () => scrollEl ?? null,
    estimateSize: rowSize,
    overscan: 8,
    getItemKey: (i) => rowKey(rows[i]),
  });
  // Keep count / sizing / keys in sync with the (reactive) row list and
  // re-measure once the scroll element mounts. `untrack` stops the setOptions/
  // measure writes from re-triggering this effect (they notify the store).
  $effect(() => {
    const n = rows.length;
    void scrollEl;
    void ROW_H; // re-measure when the mobile breakpoint changes the row height
    untrack(() => {
      $virtualizer.setOptions({
        ...$virtualizer.options,
        count: n,
        estimateSize: rowSize,
        getItemKey: (i: number) => rowKey(rows[i]),
      });
      $virtualizer.measure();
    });
  });
  // When the grouping/filter changes, the row stream is a different list — jump
  // back to the top so the virtualizer can't hold an out-of-range scroll offset
  // from the previous (often longer) grouping. Without this, switching e.g.
  // artist→format while scrolled down left stale, unclickable cards at the
  // bottom until you scrolled. Tracked deps below define "a different list".
  $effect(() => {
    void view.groupBy;
    void lib.favView;
    void view.query;
    void view.fmtFilter;
    void view.trackerFilter;
    void view.trackSort;
    void view.groupSort;
    untrack(() => {
      if (!scrollEl) return;
      scrollEl.scrollTop = 0;
      $virtualizer.scrollToOffset(0);
    });
  });

  // ---- A-Z quick-jump rail ----
  // A long, alphabetically-ordered library means scrolling forever to reach the
  // Z's. This side rail jumps the virtualized list to the first group under a
  // letter — click a letter, or drag along it (a scrubber, handy on touch). Only
  // meaningful when the buckets are actually in A-Z order (groupSort "name") and
  // there are enough of them to be worth the reach.
  // letter -> row index of its first group header (letterRowMap in $lib/library).
  const letterRows = $derived(letterRowMap(rows));
  const showRail = $derived(lib.listView && view.groupSort === "name" && lib.groups.length > 12);
  const railItems = $derived.by(() => {
    const base = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
    const letters = letterRows.has("#") ? ["#", ...base] : base;
    return letters.map((letter) => ({ letter, index: letterRows.get(letter) ?? null }));
  });
  // Scroll the virtualized list to a row (the A-Z rail jumps here).
  function jumpToRow(index: number) {
    if (scrollEl) $virtualizer.scrollToIndex(index, { align: "start" });
  }

  // ---- reveal the currently-playing track when the list comes to the front ----
  // Returning from the player overlay (or a reload that cued a bookmarked ?t)
  // should surface the track you're on, not drop you at wherever you'd scrolled.
  // On the hidden→shown edge only, open its group and centre it — the edge guard
  // means passive auto-advance while you're browsing the list never yanks scroll.
  let wasActive = false;
  $effect(() => {
    const shown = active;
    if (shown && !wasActive) untrack(() => void revealCurrent());
    wasActive = shown;
  });

  async function revealCurrent() {
    const path = playback.current?.path;
    if (!path || !scrollEl || !lib.listView) return;
    // Open the group holding the current track — but only if the active
    // grouping/filter still lists it (a query or facet may exclude it).
    let inList = false;
    for (const [name, items] of lib.groups) {
      if (items.some((t) => t.path === path)) {
        inList = true;
        if (!isOpen(name)) groupOverride.set(name, true);
        break;
      }
    }
    if (!inList) return;
    // Let the (possibly) opened group flow through the derived row list and the
    // virtualizer's count/measure effect before we resolve the row index.
    await tick();
    const idx = rows.findIndex((r) => r.kind === "track" && r.track.path === path);
    if (idx < 0) return;
    // Skip the scroll when the row is already comfortably on screen, so a track
    // that's already in view doesn't get a pointless re-centre jump.
    const vis = $virtualizer.getVirtualItems();
    const onScreen = vis.length > 0 && idx > vis[0].index && idx < vis[vis.length - 1].index;
    if (!onScreen) $virtualizer.scrollToIndex(idx, { align: "center" });
  }
</script>

<div class="listwrap">
  <main bind:this={scrollEl} class:has-rail={showRail} style:--row-h="{ROW_H}px">
    {#if view.tab === "playlists"}
      <PlaylistsTab {playlists} onRefresh={onRefreshPlaylists} onPlay={onPlayList} {onToast} />
    {:else if library.scanning && library.tracks.length === 0}
      <div class="scan-panel">
        <div class="boing"><BoingBall /></div>
        <p>Scanning the collection…</p>
        <p class="scan-detail">
          {#if scanPct !== null}
            {scanPct}% — {(library.status?.scan_processed ?? 0).toLocaleString()} of {(
              library.status?.scan_total ?? 0
            ).toLocaleString()} modules
          {:else if (library.status?.scan_processed ?? 0) > 0}
            {(library.status?.scan_processed ?? 0).toLocaleString()} modules indexed…
          {:else}
            starting…
          {/if}
        </p>
        <p class="scan-note">First run hashes every file, later scans are quick(er).</p>
      </div>
    {:else if library.loading}
      <p class="msg">loading library…</p>
    {:else if library.error && library.tracks.length === 0}
      <!-- Cold failure (no library to fall back to): show the error full-width
           with a retry, instead of a dead-end error string. -->
      <div class="msg err">
        <p>{library.error}</p>
        <button class="link" onclick={rescanLibrary}>retry</button>
      </div>
    {:else if library.tracks.length === 0 && !STANDALONE}
      <p class="msg">
        No modules indexed yet — try <button class="link" onclick={rescanLibrary}>rescan</button>.
      </p>
    {:else if library.tracks.length === 0}
      <!-- Standalone (backend-less): the StandaloneIntake hero overlays this
           empty region with the drop zone, so the list itself stays blank. -->
      <div class="vlist"></div>
    {:else if lib.favView && lib.flatTracks.length === 0}
      <p class="msg">No favourites yet — tap the ☆ on any track.</p>
    {:else}
      <div class="vlist" style:height="{$virtualizer.getTotalSize()}px">
        {#each $virtualizer.getVirtualItems() as v (v.key)}
          {@const row = rows[v.index]}
          <div
            class="vrow"
            class:spaced={row?.kind === "header" && !row.first}
            style:transform="translateY({v.start}px)"
          >
            {#if row?.kind === "header"}
              {@const isGroupless = row.name === GROUPLESS}
              {@const isNoAlbum = row.name === NO_ALBUM}
              {@const isSentinel = isGroupless || isNoAlbum}
              <button
                class="card head"
                class:closed={!row.open}
                class:groupless={isSentinel}
                onclick={() => toggleGroup(row.name)}
                aria-expanded={row.open}
              >
                <span class="chev" aria-hidden="true"><ChevronRight size={16} /></span>
                <span class="grp-name"
                  >{isGroupless ? GROUPLESS_LABEL : isNoAlbum ? NO_ALBUM_LABEL : row.name}</span
                >
                {#if isGroupless}<span class="grp-tag">no group</span>{/if}
                <span class="grp-count">{row.count}</span>
              </button>
            {:else if row?.kind === "track"}
              {@const t = row.track}
              {@const isCurrent = playback.current?.path === t.path}
              {@const sub = subLabel(t, view.groupBy, manifestIndex())}
              <div class="card li" class:last={row.last} class:current={isCurrent}>
                <button class="row" title={t.path} onclick={() => onOpen(t)}>
                  <!-- Title leads (the primary identifier), muted artist/group
                       context trails — mirrors the transport's title-over-meta
                       order. The "—" placeholder is dropped when trailing (a bare
                       title reads cleaner than "title —" for no-artist tracks). -->
                  <span class="name"
                    ><span class="song">{t.title || t.filename}</span>{#if sub && sub !== "—"}<span
                        class="sub">&nbsp;{sub}</span
                      >{/if}</span
                  >
                  <span
                    class="plays"
                    title={t.play_count > 0 ? `${t.play_count} plays` : undefined}
                  >
                    {#if t.play_count > 0}<span class="chip"
                        ><Play size={8} fill="currentColor" />{t.play_count}</span
                      >{/if}
                  </span>
                  <span class="dur">{t.duration ? fmtTime(t.duration) : ""}</span>
                </button>
                <button
                  class="fav"
                  class:on={t.favorite}
                  title={t.favorite ? "unfavourite" : "favourite"}
                  aria-label="toggle favourite"
                  aria-pressed={t.favorite}
                  onclick={() => toggleFavorite(t)}
                >
                  <Star size={14} fill={t.favorite ? "currentColor" : "none"} />
                </button>
                <button
                  class="edit"
                  title="add to playlist"
                  aria-label="add to playlist"
                  onclick={() => onAdd(t)}
                >
                  <ListPlus size={14} />
                </button>
                {#if STANDALONE}
                  <button class="edit" title="remove from browser" onclick={() => deleteTrack(t)}>
                    <Trash2 size={14} />
                  </button>
                {:else}
                  <button class="edit" title="rename / move" onclick={() => onEdit(t)}>
                    <Pencil size={14} />
                  </button>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </main>
  {#if showRail}
    <AlphabetRail items={railItems} onJump={jumpToRow} />
  {/if}
  {#if library.error && library.tracks.length > 0}
    <!-- A rescan failed but we still have the previously-loaded library — keep it
         visible and surface the failure non-destructively (fixed overlay, so it
         doesn't offset the virtualizer's scroll math) with retry + dismiss. -->
    <div class="err-banner" role="alert">
      <span class="et">rescan failed: {library.error}</span>
      <button class="link" onclick={rescanLibrary}>retry</button>
      <button class="link" aria-label="dismiss" onclick={() => (library.error = null)}>✕</button>
    </div>
  {/if}
</div>

<style>
  /* Button base is global (see +layout); only list-specific styles here. */

  /* Wraps the scroll container so the A-Z rail can pin over it (main scrolls, the
     rail stays put). Takes over main's old flex role as the body-column child. */
  .listwrap {
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }
  main {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 14px 60px;
  }
  /* Give the last column clearance from the rail when it's shown. */
  main.has-rail {
    padding-right: 26px;
  }

  .msg {
    color: var(--muted);
    padding: 24px 0;
  }
  .msg.err {
    color: var(--halo-error);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .msg.err p {
    margin: 0;
  }
  .link {
    padding: 2px 8px;
  }
  /* Non-destructive rescan-failure bar — pinned above the mini-player, styled
     like the shared Toasts.svelte error toast but persistent (needs a retry). */
  .err-banner {
    position: fixed;
    left: 50%;
    bottom: 76px;
    transform: translateX(-50%);
    z-index: 20;
    max-width: calc(100vw - 32px);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 8px 14px;
    background: var(--panel-hi);
    border: 1px solid var(--halo-error);
    border-radius: 6px;
    color: var(--halo-error);
    font-size: 13px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  .err-banner .et {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scan-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    color: var(--muted);
    padding: 16px;
  }
  .boing {
    width: 100%;
    max-width: 560px;
    height: min(60vh, 460px);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 16px;
  }
  .scan-panel p {
    margin: 6px 0;
  }
  .scan-detail {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .scan-note {
    font-size: 12px;
    opacity: 0.7;
  }

  /* Virtualized list: absolutely-positioned rows inside a tall spacer. */
  .vlist {
    position: relative;
    width: 100%;
  }
  .vrow {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
  }
  /* Gap above each group card (except the first) — measured by the virtualizer
     since it's padding on the row, not a margin. */
  .vrow.spaced {
    padding-top: 8px;
  }
  /* Group = a card: the header rounds the top, the last track row rounds the
     bottom; side borders + panel bg run down the whole open group. */
  .card {
    background: var(--panel);
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
  }
  /* Fixed heights (match ROW_H/HEAD_H in the script) so the virtualizer's
     sizing is exact — no measureElement, no reflow/jump when a group opens. */
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 40px;
    padding: 0 12px;
    /* Recessed shelf: dimmer than --panel so the brighter track rows read as
       the content plane. --panel-sunk is derived per-theme (see +layout) — a
       darker band in dark, a soft-grey band in light. This overrides .card's
       --panel: .head is defined after .card, equal specificity, so it wins. */
    background: var(--panel-sunk);
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    border-radius: 6px 6px 0 0;
    cursor: pointer;
    text-align: left;
  }
  /* It's a collapse toggle — highlight on hover with the same off-bg the track
     rows use, so a hovered header reads as interactive (and consistent). */
  .head:hover {
    background: var(--panel-hi);
  }
  .head.closed {
    border-radius: 6px;
  }
  /* Disclosure chevron: right when closed, rotates down when open (calm 150ms). */
  .chev {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    color: var(--muted);
    transition: transform var(--halo-d-fast) ease;
  }
  .head:not(.closed) .chev {
    transform: rotate(90deg);
  }
  .grp-name {
    font-weight: 600;
    /* Slight tracking so the name reads as a section label, not a title. */
    letter-spacing: 0.02em;
  }
  .grp-count {
    margin-left: auto;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  /* Groupless bucket: pinned last (see the groups sort) and set apart — muted +
     italic, with a heavier top rule as a divider from the real groups above.
     (border-box keeps the 2px border from changing the virtualizer's row height.) */
  .head.groupless {
    border-top: 2px solid var(--border);
    color: var(--muted);
    font-style: italic;
  }
  .grp-tag {
    font-style: normal;
    font-size: 11px;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 5px;
  }
  .li {
    display: flex;
    align-items: center;
    gap: 12px;
    /* Single source of truth: --row-h is set from ROW_H (the virtualizer's row
       height), so the CSS and the virtualizer sizing can never desync. */
    height: var(--row-h, 34px);
    padding: 0 12px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }
  .li.last {
    border-bottom: 1px solid var(--border);
    border-radius: 0 0 6px 6px;
  }
  .li:hover:not(.current) {
    background: var(--panel-hi);
  }
  .li.current {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .li.current .song {
    color: var(--accent);
    font-weight: 600;
  }
  /* Muted artist/group prefix; main-text song title (the row's focus). */
  .sub {
    color: var(--muted);
  }
  .song {
    color: var(--text);
  }
  /* Right-aligned fixed-width metadata columns so the row's right edge lines up
     across rows (plays/duration are per-track optional — reserving the column
     keeps the edge from going ragged). */
  .plays {
    flex: 0 0 auto;
    width: 50px;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  /* Playcount as one fused badge: the play glyph + count read as a single
     "plays" token (a subtle pill), not an icon floating beside a number. The
     translucent-ink fill keeps the pill visible on both the row and its hover
     (--panel-hi) background, instead of merging into a hovered row. */
  .plays .chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px 1px 5px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--text) 14%, transparent);
    color: var(--text);
  }
  .plays :global(svg) {
    opacity: 0.9;
  }
  .dur {
    flex: 0 0 auto;
    width: 40px;
    text-align: right;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  /* Always present (faded) so favouriting is discoverable at rest rather than
     hover-only; solid + accent when set, and brightens on hover/focus. */
  .fav {
    opacity: 0.4;
    padding: 2px 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    color: var(--muted);
    transition:
      opacity 0.12s ease,
      color 0.12s ease;
  }
  .fav.on {
    opacity: 1;
    color: var(--accent);
  }
  .li:hover .fav,
  .fav:hover,
  .fav:focus-visible {
    opacity: 1;
  }
  /* The whole row is one click target → onOpen. */
  .row {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    color: var(--text);
    cursor: pointer;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .edit {
    visibility: hidden;
    padding: 2px 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .li:hover .edit {
    visibility: visible;
  }

  /* Touch has no hover — always show the rename affordance there. */
  @media (hover: none) {
    .edit {
      visibility: visible;
    }
    .fav {
      opacity: 1;
    }
  }

  @media (max-width: 640px) {
    main {
      padding: 10px 8px 80px;
    }
    .li {
      gap: 8px;
    }
    /* One line: title/artist + duration on a single row. Playcount is dropped
       (secondary on a phone); the name keeps its base ellipsis so it truncates
       before overlapping the fixed-width duration, instead of wrapping to a
       cramped second row of padded metadata. */
    .li .plays {
      display: none;
    }
    /* Declutter narrow rows: fav + rename move to the player-view header
       (tap a track to open it). The whole row stays a play target. */
    .li .fav,
    .li .edit {
      display: none;
    }
  }
</style>

<script lang="ts">
  import { CircleHelp, FolderPlus, Settings, X } from "@lucide/svelte";
  import {
    cueInOrder,
    playback,
    playInOrder,
    playNext,
    playPrev,
    seekSeconds,
    setEditing,
    setJamLevel,
    Transport,
    transportToggle,
  } from "@scene/player";
  import { onMount, tick, untrack } from "svelte";

  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import AddToPlaylist from "$lib/AddToPlaylist.svelte";
  import { api, ApiError, type Playlist, type Track } from "$lib/api";
  import DupesPanel from "$lib/DupesPanel.svelte";
  import FacetBar from "$lib/FacetBar.svelte";
  import { GROUPLESS } from "$lib/library";
  import { library } from "$lib/library.svelte";
  import { lib } from "$lib/library-view.svelte";
  import LibraryList from "$lib/LibraryList.svelte";
  import Modal from "$lib/Modal.svelte";
  import { pv } from "$lib/player-view.svelte";
  import PlayerView from "$lib/PlayerView.svelte";
  import SettingsPanel from "$lib/SettingsPanel.svelte";
  import { STANDALONE } from "$lib/standalone";
  import { pickFiles } from "$lib/standalone/intake";
  import StandaloneIntake from "$lib/StandaloneIntake.svelte";
  import Toasts from "$lib/Toasts.svelte";
  import { parsePos } from "$lib/url-state";
  import { bucketNoun, setTab, view } from "$lib/view.svelte";

  // View/filter state (tab, group-by, sorts, facets, query) lives in the shared
  // view store; the derived grouped list (filtered/groups/flatTracks + favView/
  // listView) lives in the shared `lib` store — both read directly, no props.

  let showPattern = $state(false);
  // Measured height of the fixed transport dock, so the player view reserves
  // exactly that much at the bottom (the dock overlays content; on mobile it
  // wraps to two rows, which a fixed padding can't track). Fixes the jam
  // keyboard being clipped behind the transport.
  let transportH = $state(56);
  let showSettings = $state(false);
  let showDupes = $state(false);
  let showHelp = $state(false);
  // The full-screen player overlay + its fullscreen/viz plumbing live in
  // PlayerView; its tab + visualizer are the shared `pv` store (read by the key
  // handler below too). +page owns only whether it's open (showPattern).

  // Pattern view style ('locked' centerline vs 'scroll'), persisted, set in
  // Settings, read by the player view — a shared pref, so it lives in the
  // settings rune store (see $lib/settings.svelte), not local component state.
  // Legacy tracker editing is keyboard-first (QWERTY note entry, hex fields), so
  // gate edit mode to real pointer+keyboard devices. Touch note entry needs a
  // purpose-built UI (future: the on-screen JamKeyboard feeding cells).
  let isDesktop = $state(true);
  $effect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const apply = () => {
      isDesktop = mq.matches;
      if (!mq.matches && playback.editing) setEditing(false);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  });

  // Library data + scan lifecycle live in the shared library store (driven by
  // scanMachine); read the reactive values here.
  const tracks = $derived(library.tracks);
  const status = $derived(library.status);
  const scanning = $derived(library.scanning);

  // The topbar filter input (query lives in the view store; this ref lets
  // type-to-filter focus it).
  let filterEl = $state<HTMLInputElement>();

  // Bulk metadata enrichment lives in the shared library store (enrich machine);
  // the Settings panel drives + displays it.

  // The library store inits itself on import (scanMachine boots); just load the
  // playlists here.
  onMount(() => {
    void refreshPlaylists();
  });

  // The open track is mirrored in the URL (?t=<content-hash>) so a song is
  // bookmarkable and survives a dev HMR reload. The `playback` store lives in
  // @scene/player and persists across a component hot-swap, but this component's
  // `showPattern` resets — so on HMR the song keeps playing while the view
  // closes; restoring from the URL reopens it without restarting.
  //
  // Captured once at init, before the writer effect below can clear it (on first
  // paint `playback.current` is null, which would otherwise wipe a bookmarked t).
  const initialTrackHash = page.url.searchParams.get("t");
  let urlRestored = $state(false);

  // An explicitly-shared start position (?t=&pos=<sec>, from the copy-link
  // button). Applied once, after the module decodes; never auto-persisted, so a
  // plain ?t or a fresh selection always starts at 0 (no surprise resumes).
  const initialPos = initialTrackHash ? parsePos(page.url.searchParams.get("pos")) : 0;
  let pendingSeek = $state<number | null>(initialPos > 0 ? initialPos : null);

  // Restore the bookmarked / pre-HMR track once the library has loaded. Runs
  // once.
  $effect(() => {
    if (urlRestored || !tracks.length) return;
    urlRestored = true;
    if (!initialTrackHash) return;
    // The decoded pattern data survived intact (a component-only HMR keeps the
    // @scene/player store): reopen the pattern view straight onto it.
    if (playback.current?.hash === initialTrackHash && playback.song) {
      showPattern = true;
      return;
    }
    // Fresh load / bookmark: CUE the track — decode its pattern in the worker
    // (no gesture needed) so the grid fills in, but do NOT autoplay: the browser
    // blocks audio on a cold load without a gesture, so the transport shows ▶ and
    // audio starts on the first tap. A shared ?pos seeks once decoded (below).
    const t = tracks.find((x) => x.hash === initialTrackHash);
    if (t) {
      cueInOrder(
        untrack(() => lib.flatTracks),
        t,
      );
      showPattern = true;
    }
  });

  // Write ?t as the current track changes (gated until restore has consumed the
  // initial URL, and fully untracked so it never re-triggers on its own write).
  // Also strips ?pos once we touch the URL — the shared start position is a
  // one-shot marker, never carried forward, so a reload can't re-seek.
  $effect(() => {
    if (!urlRestored) return;
    const hash = playback.current?.hash ?? null;
    untrack(() => {
      const u = new URL(page.url);
      const tChanged = (u.searchParams.get("t") ?? null) !== hash;
      if (!tChanged && !u.searchParams.has("pos")) return;
      if (hash) u.searchParams.set("t", hash);
      else u.searchParams.delete("t");
      u.searchParams.delete("pos");
      void goto(u, { replaceState: true, keepFocus: true, noScroll: true });
    });
  });

  // Apply the shared start position once the target module has decoded (song
  // present, so setPos works). One-shot; cleared on apply.
  $effect(() => {
    if (pendingSeek == null) return;
    if (playback.current?.hash === initialTrackHash && playback.song) {
      const pos = pendingSeek;
      pendingSeek = null;
      seekSeconds(pos);
    }
  });

  // Lock body scroll while the full-screen player overlay is open, so the
  // page's own (now-pointless) scrollbar for the list behind it disappears.
  $effect(() => {
    const open = !!playback.current && showPattern;
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  });

  const scanPct = $derived.by(() => {
    const total = status?.scan_total ?? 0;
    if (!total) return null;
    return Math.round((Math.min(status?.scan_processed ?? 0, total) / total) * 100);
  });

  // The grouped list (filter → group → flatten), the virtualizer, the A-Z rail
  // and the row markup all live in LibraryList now, driven by the shared `lib`
  // store. +page keeps only what feeds the topbar + player queue: lib.filtered /
  // lib.groups (count line) and lib.flatTracks (the play queue).

  const hasPrev = $derived(playback.queueIndex > 0);
  const hasNext = $derived(
    playback.queueIndex >= 0 &&
      (playback.shuffle
        ? playback.queueLength > 1
        : playback.queueIndex + 1 < playback.queueLength),
  );

  // Tapping a track opens the player (pattern) view. A new track starts playing
  // from the top (in the visible order); the already-loaded track just reopens
  // the view without disturbing playback.
  function openTrack(t: Track) {
    // Reload when it's a different track OR the current one has no decoded song
    // yet (e.g. mid-load): opening the pattern view on an un-decoded module would
    // freeze on "decoding pattern…". An already-loaded same track just reopens
    // the view (no rewind).
    if (playback.current?.path !== t.path || !playback.song) void playInOrder(lib.flatTracks, t);
    showPattern = true;
  }

  // Expand the current track into the full pattern view. A track that's only
  // cued (restored from ?t, never played) has no decoded song yet, and cueing
  // doesn't load — so load it here, else the grid freezes on "decoding pattern…".
  function openPlayerView() {
    const cur = playback.current;
    if (cur && !playback.song) void playInOrder(lib.flatTracks, cur);
    showPattern = true;
  }

  // Desktop shortcuts: space = play/pause, ←/→ = prev/next, esc = close view.
  // Ignored while typing in the filter or a rename field.
  function onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (e.key === "?") {
      showHelp = !showHelp;
      return;
    }
    if (e.key === "Escape" && showHelp) {
      showHelp = false;
      return;
    }
    if (e.key === "Escape" && addTrack) {
      addTrack = null;
      return;
    }
    if (e.key === "Escape" && showSettings) {
      showSettings = false;
      return;
    }
    if (e.key === "Escape" && showDupes) {
      showDupes = false;
      return;
    }
    if (e.key === "Escape" && editingTrack) {
      cancelEdit();
      return;
    }
    if (e.key === "Escape" && showPattern) {
      showPattern = false;
      return;
    }
    // ('f' fullscreens the visualiser — handled inside PlayerView.)
    // Type-to-filter: a bare alphanumeric keystroke while the library list is the
    // foreground jumps into the filter box (search-as-you-type, like a file
    // manager). Space stays play/pause and "?"/Esc/arrows keep their shortcuts
    // (none are alphanumeric); once the filter has focus, the input guard at the
    // top routes further typing straight to it. SELECT keeps its native
    // type-ahead. Works regardless of playback (must precede the guard below).
    const listForeground =
      lib.listView &&
      !showPattern &&
      !showHelp &&
      !showSettings &&
      !showDupes &&
      !addTrack &&
      !editingTrack;
    if (
      listForeground &&
      el?.tagName !== "SELECT" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      /^[\p{L}\p{N}]$/u.test(e.key)
    ) {
      e.preventDefault();
      view.query += e.key;
      filterEl?.focus();
      void tick().then(() => filterEl?.setSelectionRange(view.query.length, view.query.length));
      return;
    }
    if (!playback.current) return;
    // In the samples view, left/right set the jam level (not the track) — a
    // keyboard shortcut for the "vol" slider, and it keeps arrows from switching
    // tracks mid-jam.
    const inSamples = showPattern && pv.tab === "samples" && playback.canReadSamples;
    // Edit mode is modal: the focused grid owns row/field arrows (and stops their
    // propagation); globally, arrows must NOT switch tracks. Space still toggles —
    // transportToggle drives the pattern loop while editing.
    const inEdit = showPattern && pv.tab === "pattern" && playback.editing;
    if (e.key === " ") {
      e.preventDefault();
      transportToggle();
    } else if (inEdit) {
      return;
    } else if (e.key === "ArrowRight") {
      if (inSamples) {
        setJamLevel(playback.jamLevel + 0.05);
        e.preventDefault();
      } else if (hasNext) {
        playNext();
      }
    } else if (e.key === "ArrowLeft") {
      if (inSamples) {
        setJamLevel(playback.jamLevel - 0.05);
        e.preventDefault();
      } else if (hasPrev) {
        playPrev();
      }
    }
  }

  // ---- rename / move (modal, so list rows keep a fixed height) ----
  let editingTrack = $state<Track | null>(null);
  let dGroup = $state("");
  let dArtist = $state("");
  let dFilename = $state("");
  let renameError = $state<string | null>(null);
  let saving = $state(false);

  function startEdit(t: Track) {
    editingTrack = t;
    // Show groupless tracks with a blank group field — and blank saves back to
    // groupless (the backend maps an empty group to the _groupless/ dir).
    dGroup = t.group === GROUPLESS ? "" : t.group;
    dArtist = t.artist ?? "";
    dFilename = t.filename;
    renameError = null;
  }
  function cancelEdit() {
    editingTrack = null;
    renameError = null;
  }

  async function saveEdit(t: Track) {
    saving = true;
    renameError = null;
    try {
      const res = await api.rename({
        from: t.path,
        group: dGroup,
        artist: dArtist.trim() || null,
        filename: dFilename,
      });
      // Mutate in place: $state proxies the array, so the row re-groups.
      t.path = res.path;
      t.group = res.group;
      t.artist = res.artist;
      t.filename = res.filename;
      t.ext = res.ext;
      editingTrack = null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409)
        renameError = "A file with that name already exists there.";
      else if (e instanceof ApiError && e.status === 400)
        renameError = "Invalid name — keep a module extension, no slashes.";
      else renameError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function onEditKey(e: KeyboardEvent, t: Track) {
    if (e.key === "Enter") saveEdit(t);
    else if (e.key === "Escape") cancelEdit();
  }

  // ---- playlists ----
  let playlists = $state<Playlist[]>([]);

  async function refreshPlaylists() {
    try {
      playlists = await api.playlists();
    } catch {
      /* non-fatal — the tab still renders */
    }
  }

  // Play a playlist: its present tracks become the queue, in order.
  function playList(list: Track[], start?: Track) {
    if (!list.length) return;
    void playInOrder(list, start ?? list[0]);
    showPattern = true;
  }

  // Add-to-playlist chooser: which library track we're filing, if any. The add
  // flow itself lives in the AddToPlaylist component.
  let addTrack = $state<Track | null>(null);
  // Transient confirmation / error banner. Auto-dismisses so a silent modal-close
  // is never the only signal an action landed.
  let toast = $state<{ msg: string; kind: "ok" | "err" } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showToast(msg: string, kind: "ok" | "err" = "ok") {
    toast = { msg, kind };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2400);
  }

  function startAdd(t: Track) {
    addTrack = t;
    void refreshPlaylists();
  }
</script>

<svelte:window onkeydown={onKey} />

<header class="bar">
  <div class="brand">tracker</div>
  {#if lib.listView}
    <input
      bind:this={filterEl}
      class="filter"
      type="search"
      placeholder="filter…"
      bind:value={view.query}
      disabled={scanning}
    />
  {/if}
  <div class="count">
    {#if scanning}
      {#if (status?.scan_total ?? 0) > 0}
        {(status?.scan_processed ?? 0).toLocaleString()} / {(
          status?.scan_total ?? 0
        ).toLocaleString()}
      {:else}
        {(status?.scan_processed ?? 0).toLocaleString()} modules
      {/if}
      {#if status?.scan_hashed}· {status.scan_hashed.toLocaleString()} hashed{/if}
    {:else if view.tab === "playlists"}
      {playlists.length} {playlists.length === 1 ? "playlist" : "playlists"}
    {:else if status}
      {lib.filtered.length}{#if !lib.favView}
        / {tracks.length}{/if}
      {lib.favView ? "favourites" : "modules"} · {lib.groups.length}
      {bucketNoun()}
    {/if}
  </div>
  {#if STANDALONE}
    <button class="icon-btn" onclick={pickFiles} title="add modules" aria-label="add modules">
      <FolderPlus size={16} />
    </button>
  {/if}
  <button
    class="icon-btn"
    onclick={() => (showHelp = true)}
    title="help & shortcuts (?)"
    aria-label="help and keyboard shortcuts"
  >
    <CircleHelp size={16} />
  </button>
  <button
    class="icon-btn gear"
    onclick={() => (showSettings = true)}
    title="settings"
    aria-label="settings"
  >
    <Settings size={16} />
  </button>
</header>

<nav class="tabs" aria-label="view">
  <button class:on={view.tab === "library"} onclick={() => setTab("library")}>library</button>
  <button class:on={view.tab === "favourites"} onclick={() => setTab("favourites")}>
    favourites
  </button>
  <button class:on={view.tab === "playlists"} onclick={() => setTab("playlists")}>playlists</button>
</nav>

{#if lib.listView}
  <FacetBar />
{/if}

{#if scanning}
  <div class="progress" class:indeterminate={scanPct === null}>
    <div class="progress-fill" style:width="{scanPct ?? 100}%"></div>
  </div>
{:else if library.enriching}
  <div class="progress">
    <div
      class="progress-fill"
      style:width="{library.enrichTotal ? (library.enrichDone / library.enrichTotal) * 100 : 0}%"
    ></div>
  </div>
{/if}

<div class="content">
  <LibraryList
    active={!showPattern}
    onOpen={openTrack}
    onAdd={startAdd}
    onEdit={startEdit}
    {playlists}
    onRefreshPlaylists={refreshPlaylists}
    onPlayList={playList}
    onToast={showToast}
  />
  {#if STANDALONE}
    <StandaloneIntake onToast={showToast} />
  {/if}
</div>

{#if editingTrack}
  {@const et = editingTrack}
  <Modal label="rename or move" onClose={cancelEdit}>
    <h3>rename / move <span class="fmt">{et.ext}</span></h3>
    <label>
      group
      <input bind:value={dGroup} placeholder="group (blank = groupless)" />
    </label>
    <label>
      artist
      <input bind:value={dArtist} placeholder="artist (optional)" />
    </label>
    <label>
      filename
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={dFilename}
        placeholder="filename"
        autofocus
        onkeydown={(e) => onEditKey(e, et)}
      />
    </label>
    {#if renameError}<p class="rename-err">{renameError}</p>{/if}
    <div class="modal-actions">
      <button onclick={cancelEdit} disabled={saving}>cancel</button>
      <button class="ok" onclick={() => saveEdit(et)} disabled={saving}>save</button>
    </div>
  </Modal>
{/if}

{#if showSettings}
  <SettingsPanel
    onClose={() => (showSettings = false)}
    onDupes={() => {
      showSettings = false;
      showDupes = true;
    }}
  />
{/if}

{#if showDupes}
  <DupesPanel onClose={() => (showDupes = false)} onToast={showToast} />
{/if}

{#if addTrack}
  <AddToPlaylist
    track={addTrack}
    {playlists}
    onClose={() => (addTrack = null)}
    onAdded={(name) => {
      addTrack = null;
      void refreshPlaylists();
      showToast(`Added to ${name}`);
    }}
    onError={(m) => showToast(`Couldn't add: ${m}`, "err")}
  />
{/if}

{#if playback.current && showPattern}
  <PlayerView
    {transportH}
    {isDesktop}
    onClose={() => (showPattern = false)}
    onSettings={() => (showSettings = true)}
    onAdd={startAdd}
    onEdit={startEdit}
    onToast={showToast}
  />
{/if}

{#if showHelp}
  <Modal label="help and shortcuts" onClose={() => (showHelp = false)}>
    <div class="help-head">
      <h3>Help &amp; shortcuts</h3>
      <button class="icon-btn" onclick={() => (showHelp = false)} aria-label="close">
        <X size={16} />
      </button>
    </div>
    <dl class="keys">
      <dt><kbd>Space</kbd></dt>
      <dd>play / pause</dd>
      <dt><kbd>←</kbd> <kbd>→</kbd></dt>
      <dd>previous / next track</dd>
      <dt><kbd>Esc</kbd></dt>
      <dd>close the player view / dialogs</dd>
      <dt><kbd>f</kbd></dt>
      <dd>fullscreen the visualiser (on the viz tab)</dd>
      <dt><kbd>?</kbd></dt>
      <dd>toggle this help</dd>
    </dl>
    <ul class="tips">
      <li>Tap a track to open the player; tap the title in the bar to reopen it.</li>
      <li>Drag the <strong>A–Z</strong> rail to jump through a long list.</li>
      <li>
        Use <strong>☆</strong> to favourite a track and <strong>+</strong> to add it to a playlist.
      </li>
      <li>Sort within and across groups, and filter by format / tracker, from the toolbar.</li>
    </ul>
  </Modal>
{/if}

<Toasts {toast} />

{#if playback.current}
  <div class="transport-dock" bind:clientHeight={transportH}>
    <!-- The dock sits above the player overlay (z 5 > 4), so only offer "open
         player view" while it's closed — otherwise the expand affordance is a
         no-op over the very view it claims to open. -->
    <Transport onOpenView={showPattern ? undefined : openPlayerView} />
  </div>
{/if}

<style>
  .bar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 12px;
    /* Pad past the iOS status bar (translucent, overlays content under
       viewport-fit=cover) + the landscape notch. env() is 0 where there's none. */
    padding: calc(10px + env(safe-area-inset-top)) calc(14px + env(safe-area-inset-right)) 10px
      calc(14px + env(safe-area-inset-left));
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    font-family: var(--font-retro);
    font-size: 16px;
    color: var(--accent);
    text-transform: lowercase;
  }
  .filter {
    flex: 1;
    max-width: 320px;
    padding: 6px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
  }
  .count {
    margin-left: auto;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  /* View switcher: a thin segmented row under the toolbar. `main` is the only
	   scroll container, so this (a body-level sibling) stays pinned for free. */
  .tabs {
    display: flex;
    gap: 4px;
    padding: 6px 14px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    padding: 5px 14px;
    font-size: 13px;
    text-transform: lowercase;
    background: var(--panel-hi);
    color: var(--muted);
  }
  .tabs button.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }

  .progress {
    height: 3px;
    background: var(--panel-hi);
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
  }
  .progress.indeterminate .progress-fill {
    width: 35% !important;
    animation: slide 1.1s ease-in-out infinite;
  }
  @keyframes slide {
    0% {
      margin-left: -35%;
    }
    100% {
      margin-left: 100%;
    }
  }

  /* Positioning context so the standalone intake hero can overlay the list
     region (and flex host so LibraryList keeps filling the column). */
  .content {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .rename-err {
    color: var(--halo-error);
    font-size: 12px;
    margin: 0;
  }

  /* Rename / move modal (keeps list rows a fixed height for the virtualizer). */
  /* Modal chrome (.modal-bg/.modal-scrim/.modal + generic h3/label/input/
     .modal-actions) lives in Modal.svelte now; only panel-specific styles here. */
  .help-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .help-head h3 {
    font-size: 14px;
  }
  .keys {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    margin: 0;
    font-size: 13px;
  }
  .keys dt {
    display: flex;
    gap: 4px;
  }
  .keys dd {
    margin: 0;
    align-self: center;
    color: var(--muted);
  }
  kbd {
    font-family: var(--font-mono-retro, ui-monospace, monospace);
    font-size: 11px;
    line-height: 1;
    padding: 3px 6px;
    background: var(--panel-hi);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
  }
  .tips {
    margin: 4px 0 0;
    padding-left: 18px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--muted);
  }
  .tips strong {
    color: var(--text);
  }

  /* The shared <Transport> draws the bar; tracker docks it at the bottom. */
  .transport-dock {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 5;
    /* Keep the controls clear of the iOS home indicator / landscape notch; the
       dock's panel fill extends into the inset so the bar still meets the edge. */
    padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    background: var(--panel);
  }

  /* iPhone portrait (~375–430px): wrap the toolbar onto multiple rows, drop the
	   secondary line, stack the rename editor, and use bigger tap targets. */
  @media (max-width: 640px) {
    .bar {
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px 10px;
    }
    /* Row 1 is always [brand … gear]; everything else wraps below. */
    .bar > * {
      order: 2;
    }
    .brand {
      order: 0;
    }
    .bar .gear {
      order: 1;
      margin-left: auto;
    }
    /* Search is the primary action: first wrapped row (under brand+gear),
		   above the fav/group/sort cluster. */
    .filter {
      order: 2;
      max-width: none;
      flex-basis: 100%;
    }
    .count {
      order: 4;
      flex-basis: 100%;
      margin-left: 0;
    }
    .tabs button {
      flex: 1;
    }
  }
</style>

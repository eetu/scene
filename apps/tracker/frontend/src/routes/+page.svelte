<script lang="ts">
  import {
    CircleHelp,
    ListPlus,
    Monitor,
    Moon,
    Pencil,
    Play,
    RefreshCw,
    ScanLine,
    Settings,
    Square,
    SquarePen,
    Star,
    Sun,
    X,
  } from "@lucide/svelte";
  import { setAccent, setTheme, theme, trapFocus } from "@scene/design";
  import {
    BoingBall,
    ChannelStrip,
    CopperBars,
    DiscoBall,
    Equalizer,
    GlowWave,
    parseModule,
    PatternView,
    Plasma,
    playback,
    playInOrder,
    playNext,
    playPrev,
    SampleBrowser,
    Scope,
    seekToOrder,
    SeqScopes,
    seqToggle,
    setEditing,
    setJamLevel,
    Starfield,
    Transport,
    transportToggle,
    Tunnel,
    VuMeters,
  } from "@scene/player";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { onMount, untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";

  import { api, ApiError, fileUrl, type Playlist, type StatusResponse, type Track } from "$lib/api";
  import PatternViewScroll from "$lib/PatternViewScroll.svelte";
  import PlaylistsTab from "$lib/PlaylistsTab.svelte";

  type GroupKey = "group" | "artist" | "ext";

  // The main view is tabbed: the library list, the same list filtered to
  // favourites, or the playlists surface. Restored from last session.
  type Tab = "library" | "favourites" | "playlists";
  let activeTab = $state<Tab>(
    ((typeof localStorage !== "undefined" && localStorage.getItem("tracker:tab")) as Tab) ||
      "library",
  );
  function setTab(t: Tab) {
    activeTab = t;
    if (typeof localStorage !== "undefined") localStorage.setItem("tracker:tab", t);
  }
  // Library and Favourites share the grouped/virtualized list; only the filter
  // predicate differs. (Playlists tab renders its own surface.)
  const favView = $derived(activeTab === "favourites");
  const listView = $derived(activeTab === "library" || activeTab === "favourites");

  let showPattern = $state(false);
  // Measured height of the fixed transport dock, so the player view reserves
  // exactly that much at the bottom (the dock overlays content; on mobile it
  // wraps to two rows, which a fixed padding can't track). Fixes the jam
  // keyboard being clipped behind the transport.
  let transportH = $state(56);
  let showSettings = $state(false);
  let showHelp = $state(false);
  // The viz-view container — pressing 'f' while the viz tab is open toggles
  // browser fullscreen on it. In fullscreen the viz picker auto-hides (slides up
  // like a top drawer) after a pause with no pointer activity, and slides back on
  // movement — so the visualiser fills the screen unobstructed.
  let vizEl = $state<HTMLElement | undefined>(undefined);
  let vizFs = $state(false);
  let pickerShown = $state(true);
  let pickerTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePickerHide() {
    if (pickerTimer) clearTimeout(pickerTimer);
    pickerTimer = setTimeout(() => {
      if (vizFs) pickerShown = false;
    }, 2500);
  }
  function revealPicker() {
    pickerShown = true;
    if (vizFs) schedulePickerHide();
  }
  function onFsChange() {
    vizFs = !!document.fullscreenElement && document.fullscreenElement === vizEl;
    pickerShown = true;
    if (vizFs) schedulePickerHide();
    else if (pickerTimer) clearTimeout(pickerTimer);
  }
  $effect(() => {
    const el = vizEl;
    if (!el) return;
    el.addEventListener("pointermove", revealPicker);
    el.addEventListener("pointerdown", revealPicker);
    return () => {
      el.removeEventListener("pointermove", revealPicker);
      el.removeEventListener("pointerdown", revealPicker);
    };
  });
  let pvTab = $state<"pattern" | "samples" | "viz">("pattern");

  // Which visualizer the "viz" tab shows. Persists across tab switches.
  type VizMode =
    | "vu"
    | "bars"
    | "wave"
    | "stars"
    | "copper"
    | "plasma"
    | "tunnel"
    | "disco"
    | "ball";
  const VIZ: VizMode[] = [
    "vu",
    "bars",
    "wave",
    "stars",
    "copper",
    "plasma",
    "tunnel",
    "disco",
    "ball",
  ];
  let pvVizMode = $state<VizMode>("vu");
  // Pattern view style: 'locked' = fixed centerline + vertical VU; 'scroll' =
  // free-scrolling rows + header VU. Persisted across sessions; set in Settings.
  let patternMode = $state<"locked" | "scroll">(
    (typeof localStorage !== "undefined" && localStorage.getItem("tracker:patternMode")) ===
      "scroll"
      ? "scroll"
      : "locked",
  );
  function setPatternMode(m: "locked" | "scroll") {
    patternMode = m;
    if (typeof localStorage !== "undefined") localStorage.setItem("tracker:patternMode", m);
  }

  function fmtTime(sec: number): string {
    if (!sec || !isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  function hex2(n: number): string {
    return n.toString(16).toUpperCase().padStart(2, "0");
  }

  let tracks = $state<Track[]>([]);
  let status = $state<StatusResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let rescanning = $state(false);

  let groupBy = $state<GroupKey>("group");
  // Two independent sort axes: `trackSort` orders the tracks *within* a group;
  // `groupSort` orders the group buckets themselves. Plus two facet filters
  // over the enrichment (format, tracker) and the free-text query.
  let trackSort = $state<"name" | "duration" | "channels" | "plays">("name");
  let groupSort = $state<"name" | "plays" | "size">("name");
  let fmtFilter = $state("");
  let trackerFilter = $state("");
  let query = $state("");
  function resetControls() {
    trackSort = "name";
    groupSort = "name";
    fmtFilter = "";
    trackerFilter = "";
  }
  const controlsActive = $derived(
    trackSort !== "name" || groupSort !== "name" || !!fmtFilter || !!trackerFilter,
  );
  // What the buckets are called for the current group-by — used for the bucket
  // sort label and the count line so they read "artists" / "formats" / "groups".
  const bucketNoun = $derived(
    groupBy === "ext" ? "formats" : groupBy === "artist" ? "artists" : "groups",
  );

  async function toggleFavorite(t: Track) {
    const next = !t.favorite;
    t.favorite = next; // optimistic — $state proxy updates the row + facet
    try {
      await api.setFavorite(t.hash, next);
    } catch {
      t.favorite = !next; // revert on failure
    }
  }

  async function loadTracks() {
    tracks = await api.tracks();
  }
  async function refreshStatus() {
    status = await api.status();
  }

  // While a scan runs it holds the single DB connection, so poll only /status
  // (cheap, lock-free) — never /api/tracks, which would block until it ends.
  async function pollUntilIdle() {
    while (status?.scanning) {
      await new Promise((r) => setTimeout(r, 800));
      try {
        await refreshStatus();
      } catch {
        /* transient — keep polling */
      }
    }
    await loadTracks();
  }

  async function init() {
    loading = true;
    error = null;
    try {
      await refreshStatus();
      if (status?.scanning) await pollUntilIdle();
      else await loadTracks();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function rescan() {
    rescanning = true;
    error = null;
    // Poll for progress in parallel while the (synchronous) rescan runs.
    let done = false;
    const poller = (async () => {
      while (!done) {
        try {
          await refreshStatus();
        } catch {
          /* transient */
        }
        await new Promise((r) => setTimeout(r, 700));
      }
    })();
    try {
      await api.rescan();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      done = true;
      await poller;
      try {
        await refreshStatus();
        await loadTracks();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      rescanning = false;
    }
  }

  // ---- bulk metadata enrichment (parse every un-enriched module via WASM) ----
  let enriching = $state(false);
  let enrichDone = $state(0);
  let enrichTotal = $state(0);
  const unEnriched = $derived(tracks.filter((t) => !t.type_long).length);

  async function enrichAll() {
    const todo = tracks.filter((t) => !t.type_long);
    if (todo.length === 0) return;
    enrichTotal = todo.length;
    enrichDone = 0;
    enriching = true;
    try {
      for (const t of todo) {
        if (!enriching) break; // cancelled
        try {
          const buf = await (await fetch(fileUrl(t.hash))).arrayBuffer();
          const m = await parseModule(buf);
          if (m) {
            const payload = {
              title: m.title || null,
              type_long: m.type_long || null,
              tracker: m.tracker || null,
              duration: m.dur ?? null,
              channels: m.channels ?? null,
              instruments: m.instruments ?? null,
              samples: m.samples ?? null,
              n_orders: m.orders ?? null,
              n_patterns: m.patterns ?? null,
            };
            await api.putMeta(t.hash, payload);
            t.title = payload.title;
            t.type_long = payload.type_long;
            t.tracker = payload.tracker;
            t.duration = payload.duration;
            t.channels = payload.channels;
            t.instruments = payload.instruments;
            t.samples = payload.samples;
          }
        } catch {
          /* skip this module, keep going */
        }
        enrichDone++;
      }
    } finally {
      enriching = false;
    }
  }

  onMount(() => {
    void init();
    void refreshPlaylists();
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

  const scanning = $derived((status?.scanning ?? false) || rescanning);
  const scanPct = $derived.by(() => {
    const total = status?.scan_total ?? 0;
    if (!total) return null;
    return Math.round((Math.min(status?.scan_processed ?? 0, total) / total) * 100);
  });

  // Facet options come from the current tab's tracks (favourites vs all), so the
  // dropdowns only offer values that can actually match.
  const facetBase = $derived(favView ? tracks.filter((t) => t.favorite) : tracks);
  const formats = $derived(
    [...new Set(facetBase.map((t) => t.ext.toUpperCase()))].sort((a, b) => a.localeCompare(b)),
  );
  const trackers = $derived(
    [...new Set(facetBase.map((t) => t.tracker).filter((t): t is string => !!t))].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    ),
  );

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    let list = tracks;
    if (favView) list = list.filter((t) => t.favorite);
    if (fmtFilter) list = list.filter((t) => t.ext.toUpperCase() === fmtFilter);
    if (trackerFilter) list = list.filter((t) => (t.tracker ?? "") === trackerFilter);
    if (q)
      list = list.filter((t) =>
        [t.path, t.title, t.filename, t.group, t.artist, t.type_long]
          .filter(Boolean)
          .some((v) => (v as string).toLowerCase().includes(q)),
      );
    return list;
  });

  // Canonical "no group" bucket: files under the _groupless/ dir (or with an
  // empty group) collect here. Shown as "Groupless", pinned last, styled apart.
  const GROUPLESS = "_groupless";
  const GROUPLESS_LABEL = "Groupless";

  function keyOf(t: Track): string {
    if (groupBy === "group") return t.group || GROUPLESS;
    if (groupBy === "artist") return t.artist || "(unknown artist)";
    return t.ext.toUpperCase();
  }

  const groups = $derived.by(() => {
    const acc: Record<string, Track[]> = {};
    for (const t of filtered) {
      const k = keyOf(t);
      (acc[k] ??= []).push(t);
    }
    // Within a bucket: 'name' keeps the server's order; the others sort by an
    // enrichment field, biggest first, with un-enriched (null) values last.
    // JS sort is stable, so ties keep the server order.
    if (trackSort !== "name") {
      const metric: (t: Track) => number =
        trackSort === "duration"
          ? (t) => t.duration ?? -1
          : trackSort === "channels"
            ? (t) => t.channels ?? -1
            : (t) => t.play_count;
      for (const items of Object.values(acc)) items.sort((a, b) => metric(b) - metric(a));
    }
    // Order the buckets themselves. 'name' = A-Z; 'plays' = busiest bucket first
    // (sum of play counts); 'size' = most modules first. Non-name falls back to
    // A-Z on ties.
    const byName = (a: [string, Track[]], b: [string, Track[]]) =>
      a[0].localeCompare(b[0], undefined, { sensitivity: "base" });
    const plays = (items: Track[]) => items.reduce((n, t) => n + t.play_count, 0);
    return Object.entries(acc).sort((a, b) => {
      // Groupless always sinks to the bottom, whatever the bucket sort is.
      const ag = a[0] === GROUPLESS;
      const bg = b[0] === GROUPLESS;
      if (ag !== bg) return ag ? 1 : -1;
      if (groupSort === "plays") return plays(b[1]) - plays(a[1]) || byName(a, b);
      if (groupSort === "size") return b[1].length - a[1].length || byName(a, b);
      return byName(a, b);
    });
  });

  function subLabel(t: Track): string {
    // A groupless track has no real group to show as a prefix.
    const grp = t.group === GROUPLESS ? "" : t.group;
    if (groupBy === "group") return t.artist ?? "—";
    if (groupBy === "artist") return grp || "—";
    return [grp, t.artist].filter(Boolean).join(" · ") || "—";
  }

  // A row's label is rendered as styled parts (not one string): the *other*
  // dimension as a muted prefix (artist/group via subLabel), the song title in
  // the main text colour, and a format chip — unless the grouping is already by
  // format. See the list row markup below.

  // Group open/closed state. Few groups (≤12) default to open; a user toggle is
  // remembered per group in an override map (so auto-open groups can be closed
  // and vice-versa). The flat row list below only emits rows for open groups.
  const groupOverride = new SvelteMap<string, boolean>();
  const expandAll = $derived(groups.length <= 12);
  function isOpen(name: string): boolean {
    return groupOverride.get(name) ?? expandAll;
  }

  // The visible order is the play queue, so next/prev/auto-advance follow what
  // you see (current grouping + filter).
  const flatTracks = $derived(groups.flatMap(([, items]) => items));

  // ---- virtualized library list ----
  // Flatten the grouped tree into one row stream (a header row per group, plus
  // the track rows of open groups) and virtualize it with TanStack Virtual, so
  // thousands of <li> never hit the DOM at once.
  type LibRow =
    | { kind: "header"; name: string; count: number; open: boolean; first: boolean }
    | { kind: "track"; track: Track; last: boolean };

  const rows = $derived.by<LibRow[]>(() => {
    const out: LibRow[] = [];
    for (const [name, items] of groups) {
      const open = isOpen(name);
      out.push({ kind: "header", name, count: items.length, open, first: out.length === 0 });
      if (open)
        items.forEach((t, i) =>
          out.push({ kind: "track", track: t, last: i === items.length - 1 }),
        );
    }
    return out;
  });
  function rowKey(r: LibRow): string {
    return r.kind === "header" ? `h:${r.name}` : `t:${r.track.path}`;
  }
  function toggleGroup(name: string) {
    groupOverride.set(name, !isOpen(name));
  }

  // Exact, fixed row heights (px) — must match the CSS below. Deterministic
  // sizing (no measureElement) keeps offsets above the viewport stable, so
  // opening a group never reflows/jumps the rows already on screen. The inline
  // rename editor lives in a modal precisely so every row stays a fixed height.
  const ROW_H = 34;
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
    void groupBy;
    void favView;
    void query;
    void fmtFilter;
    void trackerFilter;
    void trackSort;
    void groupSort;
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
  function railLetter(name: string): string {
    const c = name[0]?.toUpperCase() ?? "#";
    return c >= "A" && c <= "Z" ? c : "#";
  }
  // letter -> row index of its first group header. Buckets are contiguous per
  // letter when sorted A-Z, so the first hit is the correct jump target.
  const letterRows = $derived.by(() => {
    // Throwaway lookup rebuilt each run (read-only), not reactive state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const m = new Map<string, number>();
    rows.forEach((r, i) => {
      if (r.kind === "header" && !m.has(railLetter(r.name))) m.set(railLetter(r.name), i);
    });
    return m;
  });
  const showRail = $derived(listView && groupSort === "name" && groups.length > 12);
  const railItems = $derived.by(() => {
    const base = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
    const letters = letterRows.has("#") ? ["#", ...base] : base;
    return letters.map((letter) => ({ letter, index: letterRows.get(letter) ?? null }));
  });

  let railEl = $state<HTMLElement | undefined>(undefined);
  let railActive = $state<string | null>(null);

  function jumpToRow(index: number) {
    if (scrollEl) $virtualizer.scrollToIndex(index, { align: "start" });
  }
  // Snap a rail position to the nearest letter that has a group, so dragging over
  // an empty letter still lands somewhere sensible instead of doing nothing.
  function railJump(target: number) {
    const items = railItems;
    for (let d = 0; d < items.length; d++) {
      const a = items[target - d];
      const b = items[target + d];
      if (a?.index != null) return ((railActive = a.letter), jumpToRow(a.index));
      if (b?.index != null) return ((railActive = b.letter), jumpToRow(b.index));
    }
  }
  function railIndexAtY(clientY: number): number {
    if (!railEl) return 0;
    const r = railEl.getBoundingClientRect();
    const rel = (clientY - r.top) / r.height;
    return Math.max(0, Math.min(railItems.length - 1, Math.floor(rel * railItems.length)));
  }
  function railDown(e: PointerEvent) {
    railEl?.setPointerCapture(e.pointerId);
    railJump(railIndexAtY(e.clientY));
  }
  function railMove(e: PointerEvent) {
    if (railEl?.hasPointerCapture(e.pointerId)) railJump(railIndexAtY(e.clientY));
  }
  function railUp(e: PointerEvent) {
    railEl?.releasePointerCapture(e.pointerId);
    railActive = null;
  }

  // Loudest channel VU drives the Boing-ball visualizer energy.
  const vuEnergy = $derived(playback.vu.length ? Math.max(...playback.vu) : 0);
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
  // The full library Track for the loaded module (the player store holds only a
  // minimal shape), so the player-view header can favourite / rename it.
  const currentTrack = $derived.by(() => {
    const c = playback.current;
    if (!c) return null;
    return tracks.find((t) => t.path === c.path) ?? null;
  });

  function openTrack(t: Track) {
    if (playback.current?.path !== t.path) void playInOrder(flatTracks, t);
    showPattern = true;
  }

  // Desktop shortcuts: space = play/pause, ←/→ = prev/next, esc = close view.
  // Ignored while typing in the filter or a rename field.
  function toggleVizFullscreen() {
    if (!vizEl) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void vizEl.requestFullscreen?.();
  }

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
    if (e.key === "Escape" && editingTrack) {
      cancelEdit();
      return;
    }
    if (e.key === "Escape" && showPattern) {
      showPattern = false;
      return;
    }
    if ((e.key === "f" || e.key === "F") && showPattern && pvTab === "viz") {
      e.preventDefault();
      toggleVizFullscreen();
      return;
    }
    if (!playback.current) return;
    // In the samples view, left/right set the jam level (not the track) — a
    // keyboard shortcut for the "vol" slider, and it keeps arrows from switching
    // tracks mid-jam.
    const inSamples = showPattern && pvTab === "samples" && playback.canReadSamples;
    if (e.key === " ") {
      e.preventDefault();
      transportToggle();
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

  // Add-to-playlist chooser: which library track we're filing, if any.
  let addTrack = $state<Track | null>(null);
  let addNewName = $state("");
  let addBusy = $state(false);
  // Transient confirmation / error banner (add-to-playlist). Auto-dismisses so a
  // silent modal-close is never the only signal an action landed.
  let toast = $state<{ msg: string; kind: "ok" | "err" } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showToast(msg: string, kind: "ok" | "err" = "ok") {
    toast = { msg, kind };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = null), 2400);
  }

  function startAdd(t: Track) {
    addTrack = t;
    addNewName = "";
    void refreshPlaylists();
  }
  // Playlist items are keyed by md5; carry the track's metadata as the cache.
  function trackItem(t: Track) {
    return {
      md5: t.md5 ?? "",
      title: t.title,
      artist: t.artist,
      format: t.ext,
      filename: t.filename,
    };
  }
  async function addToPlaylist(id: string) {
    if (!addTrack?.md5) return;
    const name = playlists.find((p) => p.id === id)?.name ?? "playlist";
    addBusy = true;
    try {
      await api.addToPlaylist(id, trackItem(addTrack));
      addTrack = null;
      await refreshPlaylists();
      showToast(`Added to ${name}`);
    } catch (e) {
      showToast(`Couldn't add: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      addBusy = false;
    }
  }
  async function addToNewPlaylist() {
    const name = addNewName.trim();
    if (!name || !addTrack?.md5) return;
    addBusy = true;
    try {
      const pl = await api.createPlaylist(name);
      await api.addToPlaylist(pl.id, trackItem(addTrack));
      addTrack = null;
      await refreshPlaylists();
      showToast(`Added to ${name}`);
    } catch (e) {
      showToast(`Couldn't add: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      addBusy = false;
    }
  }
</script>

<svelte:window onkeydown={onKey} />
<svelte:document onfullscreenchange={onFsChange} />

<header class="bar">
  <div class="brand">tracker</div>
  {#if listView}
    <input
      class="filter"
      type="search"
      placeholder="filter…"
      bind:value={query}
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
    {:else if activeTab === "playlists"}
      {playlists.length} {playlists.length === 1 ? "playlist" : "playlists"}
    {:else if status}
      {filtered.length}{#if !favView}
        / {tracks.length}{/if}
      {favView ? "favourites" : "modules"} · {groups.length}
      {bucketNoun}
    {/if}
  </div>
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
  <button class:on={activeTab === "library"} onclick={() => setTab("library")}>library</button>
  <button class:on={activeTab === "favourites"} onclick={() => setTab("favourites")}>
    favourites
  </button>
  <button class:on={activeTab === "playlists"} onclick={() => setTab("playlists")}>playlists</button
  >
</nav>

{#if listView}
  <div class="controls" aria-label="library controls">
    <!-- Cluster 1 — how the list is organised: bucket dimension + bucket order. -->
    <div class="cgroup">
      <label class="groupby">
        group by
        <select bind:value={groupBy} disabled={scanning}>
          <option value="group">group</option>
          <option value="artist">artist</option>
          <option value="ext">format</option>
        </select>
      </label>
      <label class="groupby opt">
        {bucketNoun}
        <select bind:value={groupSort} disabled={scanning} aria-label="order {bucketNoun}">
          <option value="name">A-Z</option>
          <option value="plays">play count</option>
          <option value="size">size</option>
        </select>
      </label>
    </div>
    <!-- Cluster 2 — how tracks are ordered within each bucket. -->
    <div class="cgroup">
      <label class="groupby">
        sort
        <select bind:value={trackSort} disabled={scanning}>
          <option value="name">name</option>
          <option value="duration">duration</option>
          <option value="channels">channels</option>
          <option value="plays">plays</option>
        </select>
      </label>
    </div>
    <!-- Cluster 3 — facet filters over the enrichment. -->
    <div class="cgroup">
      <label class="groupby">
        format
        <select bind:value={fmtFilter} disabled={scanning}>
          <option value="">all</option>
          {#each formats as f (f)}
            <option value={f}>{f}</option>
          {/each}
        </select>
      </label>
      <label class="groupby opt">
        tracker
        <select bind:value={trackerFilter} disabled={scanning}>
          <option value="">all</option>
          {#each trackers as tr (tr)}
            <option value={tr}>{tr}</option>
          {/each}
        </select>
      </label>
    </div>
    {#if controlsActive}
      <button class="reset" onclick={resetControls} disabled={scanning}>reset</button>
    {/if}
  </div>
{/if}

{#if scanning}
  <div class="progress" class:indeterminate={scanPct === null}>
    <div class="progress-fill" style:width="{scanPct ?? 100}%"></div>
  </div>
{:else if enriching}
  <div class="progress">
    <div
      class="progress-fill"
      style:width="{enrichTotal ? (enrichDone / enrichTotal) * 100 : 0}%"
    ></div>
  </div>
{/if}

<div class="listwrap">
  <main bind:this={scrollEl} class:has-rail={showRail}>
    {#if activeTab === "playlists"}
      <PlaylistsTab {playlists} onRefresh={refreshPlaylists} onPlay={playList} />
    {:else if scanning && tracks.length === 0}
      <div class="scan-panel">
        <div class="boing"><BoingBall /></div>
        <p>Scanning the collection…</p>
        <p class="scan-detail">
          {#if scanPct !== null}
            {scanPct}% — {(status?.scan_processed ?? 0).toLocaleString()} of {(
              status?.scan_total ?? 0
            ).toLocaleString()} modules
          {:else if (status?.scan_processed ?? 0) > 0}
            {(status?.scan_processed ?? 0).toLocaleString()} modules indexed…
          {:else}
            starting…
          {/if}
        </p>
        <p class="scan-note">First run hashes every file, later scans are quick(er).</p>
      </div>
    {:else if loading}
      <p class="msg">loading library…</p>
    {:else if error}
      <p class="msg err">{error}</p>
    {:else if tracks.length === 0}
      <p class="msg">
        No modules indexed yet — try <button class="link" onclick={rescan}>rescan</button>.
      </p>
    {:else if favView && flatTracks.length === 0}
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
              <button
                class="card head"
                class:closed={!row.open}
                class:groupless={isGroupless}
                onclick={() => toggleGroup(row.name)}
                aria-expanded={row.open}
              >
                <span class="grp-name">{isGroupless ? GROUPLESS_LABEL : row.name}</span>
                {#if isGroupless}<span class="grp-tag">no group</span>{/if}
                <span class="grp-count">{row.count}</span>
              </button>
            {:else if row?.kind === "track"}
              {@const t = row.track}
              {@const isCurrent = playback.current?.path === t.path}
              {@const sub = subLabel(t)}
              <div class="card li" class:last={row.last} class:current={isCurrent}>
                <button class="row" title={t.path} onclick={() => openTrack(t)}>
                  <span class="name"
                    ><span class="sub">{sub}&nbsp;</span><span class="song"
                      >{t.title || t.filename}</span
                    ></span
                  >
                  {#if groupBy !== "ext"}<span class="fmt-chip">{t.ext}</span>{/if}
                  <span
                    class="plays"
                    title={t.play_count > 0 ? `${t.play_count} plays` : undefined}
                  >
                    {#if t.play_count > 0}<Play size={9} fill="currentColor" />{t.play_count}{/if}
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
                  onclick={() => startAdd(t)}
                >
                  <ListPlus size={14} />
                </button>
                <button class="edit" title="rename / move" onclick={() => startEdit(t)}>
                  <Pencil size={14} />
                </button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </main>
  {#if showRail}
    <div
      class="az-rail"
      bind:this={railEl}
      role="navigation"
      aria-label="jump to letter"
      onpointerdown={railDown}
      onpointermove={railMove}
      onpointerup={railUp}
      onpointercancel={railUp}
    >
      {#each railItems as it (it.letter)}
        <button
          class="az-letter"
          class:present={it.index != null}
          class:active={railActive === it.letter}
          disabled={it.index == null}
          tabindex="-1"
          onclick={() => it.index != null && jumpToRow(it.index)}>{it.letter}</button
        >
      {/each}
    </div>
  {/if}
</div>

{#if editingTrack}
  {@const et = editingTrack}
  <div class="modal-bg">
    <button class="modal-scrim" aria-label="close" onclick={cancelEdit}></button>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="rename or move"
      tabindex="-1"
      use:trapFocus
    >
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
    </div>
  </div>
{/if}

{#if showSettings}
  <div class="modal-bg">
    <button class="modal-scrim" aria-label="close" onclick={() => (showSettings = false)}></button>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="settings"
      tabindex="-1"
      use:trapFocus
    >
      <h3>settings</h3>
      <div class="setting">
        <span class="setting-label">theme</span>
        <div class="seg">
          <button class:on={theme.mode === "light"} onclick={() => setTheme("light")}>
            <Sun size={15} /> light
          </button>
          <button class:on={theme.mode === "dark"} onclick={() => setTheme("dark")}>
            <Moon size={15} /> dark
          </button>
          <button class:on={theme.mode === "auto"} onclick={() => setTheme("auto")}>
            <Monitor size={15} /> auto
          </button>
        </div>
      </div>
      <div class="setting">
        <span class="setting-label">accent</span>
        <div class="seg">
          <button class:on={theme.accent === "orange"} onclick={() => setAccent("orange")}>
            <span class="swatch" style="background:#f78f08"></span> orange
          </button>
          <button class:on={theme.accent === "purple"} onclick={() => setAccent("purple")}>
            <span class="swatch" style="background:#a370f0"></span> purple
          </button>
        </div>
      </div>
      <div class="setting">
        <span class="setting-label">pattern view</span>
        <div class="seg">
          <button class:on={patternMode === "locked"} onclick={() => setPatternMode("locked")}>
            <ScanLine size={15} /> centerline
          </button>
          <button class:on={patternMode === "scroll"} onclick={() => setPatternMode("scroll")}>
            free scroll
          </button>
        </div>
      </div>
      <div class="setting">
        <span class="setting-label">library</span>
        <div class="seg">
          <button onclick={rescan} disabled={scanning}>
            <RefreshCw size={15} />
            {scanning ? "scanning…" : "rescan"}
          </button>
          {#if enriching}
            <button onclick={() => (enriching = false)}>cancel {enrichDone}/{enrichTotal}</button>
          {:else}
            <button onclick={enrichAll} disabled={scanning || unEnriched === 0}>
              {unEnriched > 0 ? `enrich ${unEnriched}` : "all enriched"}
            </button>
          {/if}
        </div>
        <span class="setting-hint">
          {#if scanning}
            scanning… {(
              status?.scan_processed ?? 0
            ).toLocaleString()}{#if (status?.scan_total ?? 0) > 0}/{(
                status?.scan_total ?? 0
              ).toLocaleString()}{/if}
          {:else}
            {tracks.length.toLocaleString()} modules{#if unEnriched > 0}
              · {unEnriched.toLocaleString()} need metadata{/if}
          {/if}
        </span>
      </div>
      <div class="modal-actions">
        <button onclick={() => (showSettings = false)}>close</button>
      </div>
    </div>
  </div>
{/if}

{#if addTrack}
  {@const at = addTrack}
  <div class="modal-bg">
    <button class="modal-scrim" aria-label="close" onclick={() => (addTrack = null)}></button>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="add to playlist"
      tabindex="-1"
      use:trapFocus
    >
      <h3>add to playlist</h3>
      <p class="add-track">{at.title || at.filename}</p>
      <div class="add-list">
        {#each playlists as p (p.id)}
          <button class="add-row" onclick={() => addToPlaylist(p.id)} disabled={addBusy}>
            <span class="pn">{p.name}</span>
            <span class="pc">{p.item_count}</span>
          </button>
        {:else}
          <p class="msg">no playlists yet — make one below</p>
        {/each}
      </div>
      <div class="newrow">
        <input
          placeholder="new playlist…"
          bind:value={addNewName}
          onkeydown={(e) => e.key === "Enter" && addToNewPlaylist()}
        />
        <button class="ok" onclick={addToNewPlaylist} disabled={addBusy || !addNewName.trim()}>
          create &amp; add
        </button>
      </div>
      <div class="modal-actions">
        <button onclick={() => (addTrack = null)} disabled={addBusy}>cancel</button>
      </div>
    </div>
  </div>
{/if}

{#if playback.current && showPattern}
  <div class="pattern-overlay">
    <div class="pv-bar">
      <div class="pv-tabs">
        <button class:on={pvTab === "pattern"} onclick={() => (pvTab = "pattern")}>pattern</button>
        <button class:on={pvTab === "samples"} onclick={() => (pvTab = "samples")}>samples</button>
        <button class:on={pvTab === "viz"} onclick={() => (pvTab = "viz")}>viz</button>
      </div>
      <div class="pv-actions">
        {#if pvTab === "pattern" && playback.canReadCells}
          <button
            class="icon-btn"
            class:on={playback.editing}
            onclick={() => setEditing(!playback.editing)}
            title={playback.editing ? "exit edit mode" : "edit pattern"}
            aria-label="toggle edit mode"
            aria-pressed={playback.editing}
          >
            <SquarePen size={16} />
          </button>
          {#if playback.editing}
            <button
              class="icon-btn"
              class:on={playback.seqPlaying}
              onclick={() => seqToggle()}
              title={playback.seqPlaying ? "stop pattern" : "play pattern (editor)"}
              aria-label="play or stop the edited pattern"
              aria-pressed={playback.seqPlaying}
            >
              {#if playback.seqPlaying}<Square size={16} />{:else}<Play size={16} />{/if}
            </button>
          {/if}
        {/if}
        {#if currentTrack}
          {@const ct = currentTrack}
          <button
            class="icon-btn"
            class:faved={ct.favorite}
            onclick={() => toggleFavorite(ct)}
            title={ct.favorite ? "unfavourite" : "favourite"}
            aria-label="toggle favourite"
            aria-pressed={ct.favorite}
          >
            <Star size={16} fill={ct.favorite ? "currentColor" : "none"} />
          </button>
          <button
            class="icon-btn"
            onclick={() => startEdit(ct)}
            title="rename / move"
            aria-label="rename / move"
          >
            <Pencil size={16} />
          </button>
        {/if}
        <button
          class="icon-btn gear"
          onclick={() => (showSettings = true)}
          title="settings"
          aria-label="settings"
        >
          <Settings size={16} />
        </button>
        <button
          class="icon-btn pv-close"
          onclick={() => (showPattern = false)}
          aria-label="close pattern view"
        >
          <X size={16} />
        </button>
      </div>
    </div>
    <div class="pv-wrap" style:padding-bottom="{transportH + 8}px">
      {#if pvTab === "pattern"}
        <div class="scope-strip"><Scope /></div>
        {#if (playback.song?.orders?.length ?? 0) > 1}
          <!-- Order list: click a position to jump there; current is highlighted. -->
          <div class="orders" aria-label="order list">
            {#each playback.song?.orders ?? [] as o, i (i)}
              <button
                type="button"
                class="ord"
                class:on={i === playback.order}
                onclick={() => seekToOrder(i)}
                title="order {hex2(i)} → pattern {hex2(o.pat)}"
              >
                {hex2(o.pat)}
              </button>
            {/each}
          </div>
        {/if}
        <ChannelStrip />
        {#if playback.editing}<SeqScopes />{/if}
        <div class="pfill">
          {#if patternMode === "locked"}<PatternView />{:else}<PatternViewScroll />{/if}
        </div>
      {:else if pvTab === "viz"}
        {@const vizActive = playback.playing && !playback.paused}
        <div class="viz-view" class:fs={vizFs} bind:this={vizEl}>
          <div class="vizpick" class:hide={!pickerShown}>
            {#each VIZ as m (m)}
              <button class:on={pvVizMode === m} onclick={() => (pvVizMode = m)}>{m}</button>
            {/each}
          </div>
          <div class="vizbody">
            {#if pvVizMode === "bars"}
              <Equalizer active={vizActive} />
            {:else if pvVizMode === "wave"}
              <GlowWave active={vizActive} />
            {:else if pvVizMode === "vu"}
              <VuMeters active={vizActive} />
            {:else if pvVizMode === "stars"}
              <Starfield active={vizActive} />
            {:else if pvVizMode === "copper"}
              <CopperBars active={vizActive} />
            {:else if pvVizMode === "plasma"}
              <Plasma active={vizActive} />
            {:else if pvVizMode === "tunnel"}
              <Tunnel active={vizActive} />
            {:else if pvVizMode === "disco"}
              <DiscoBall active={vizActive} />
            {:else}
              <BoingBall energy={vizActive ? vuEnergy : 0} live={vizActive} react />
            {/if}
          </div>
        </div>
      {:else}
        <SampleBrowser />
      {/if}
    </div>
  </div>
{/if}

{#if showHelp}
  <div class="modal-bg">
    <button class="modal-scrim" aria-label="close" onclick={() => (showHelp = false)}></button>
    <div
      class="modal help"
      role="dialog"
      aria-modal="true"
      aria-label="help and shortcuts"
      tabindex="-1"
      use:trapFocus
    >
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
    </div>
  </div>
{/if}

{#if toast}
  <div class="toast" class:err={toast.kind === "err"} role="status">{toast.msg}</div>
{/if}

{#if playback.current}
  <div class="transport-dock" bind:clientHeight={transportH}>
    <!-- The dock sits above the player overlay (z 5 > 4), so only offer "open
         player view" while it's closed — otherwise the expand affordance is a
         no-op over the very view it claims to open. -->
    <Transport onOpenView={showPattern ? undefined : () => (showPattern = true)} />
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
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 5px;
  }
  /* Active toggle (edit mode on, sequencer playing). */
  .icon-btn.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
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
  .groupby {
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  select,
  button {
    background: var(--panel-hi);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 10px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
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

  /* Facet/sort toolbar for the library + favourites lists. A body-level sibling
	   like the tabs, so it stays pinned while `main` scrolls. Related controls are
	   grouped into `.cgroup` clusters (organise / sort / filter); the wider
	   column-gap separates clusters, the tighter gap binds controls within one.
	   Clusters wrap as whole units rather than splitting mid-cluster. */
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 18px;
    padding: 8px 14px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .cgroup {
    display: flex;
    align-items: center;
    gap: 6px 10px;
  }
  .controls .reset {
    margin-left: auto;
    font-size: 12px;
    color: var(--muted);
    padding: 4px 10px;
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

  /* A-Z quick-jump rail: content-height, vertically centred over the list, clear
     of the fixed transport dock. Content-sized so the drag-scrubber maps finger
     Y → letter exactly (each letter is a fixed slice of the rail's height). */
  .az-rail {
    position: absolute;
    right: 2px;
    top: 50%;
    transform: translateY(-50%);
    max-height: calc(100% - 88px);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    z-index: 4;
    padding: 2px 1px;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .az-letter {
    appearance: none;
    border: 0;
    background: none;
    margin: 0;
    padding: 0;
    width: 18px;
    height: 14px;
    line-height: 14px;
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    text-align: center;
    color: var(--muted);
    opacity: 0.3;
    cursor: pointer;
  }
  .az-letter.present {
    opacity: 0.8;
  }
  .az-letter.present:hover,
  .az-letter.active {
    opacity: 1;
    color: var(--accent);
  }
  .az-letter:disabled {
    cursor: default;
  }
  .msg {
    color: var(--muted);
    padding: 24px 0;
  }
  .msg.err {
    color: var(--halo-error);
  }
  .link {
    padding: 2px 8px;
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
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    border-radius: 6px 6px 0 0;
    cursor: pointer;
    text-align: left;
  }
  .head.closed {
    border-radius: 6px;
  }
  .grp-name {
    font-weight: 600;
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
    height: 34px;
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
  /* Format as a small chip rather than inline "[XM]" text. */
  .fmt-chip {
    flex: 0 0 auto;
    font-size: 10px;
    line-height: 1;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    background: var(--panel-hi);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 3px 5px;
  }
  /* Right-aligned fixed-width metadata columns so the row's right edge lines up
	   across rows (plays/duration are per-track optional — reserving the column
	   keeps the edge from going ragged). */
  .plays {
    flex: 0 0 auto;
    width: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 3px;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .plays :global(svg) {
    opacity: 0.75;
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
  /* The whole row is one click target → openTrack. */
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
  .ok {
    border-color: var(--accent);
    color: var(--accent);
  }
  .rename-err {
    color: var(--halo-error);
    font-size: 12px;
    margin: 0;
  }

  /* Rename / move modal (keeps list rows a fixed height for the virtualizer). */
  .modal-bg {
    position: fixed;
    inset: 0;
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .modal-scrim {
    position: absolute;
    inset: 0;
    border: none;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.5);
    cursor: pointer;
  }
  .modal {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 420px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .modal h3 {
    margin: 0;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
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
  /* Transient confirmation / error banner — bottom-centred, above the dock. */
  .toast {
    position: fixed;
    left: 50%;
    bottom: 76px;
    transform: translateX(-50%);
    z-index: 20;
    max-width: calc(100vw - 32px);
    padding: 8px 14px;
    background: var(--panel-hi);
    border: 1px solid var(--accent);
    border-radius: 6px;
    color: var(--text);
    font-size: 13px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  .toast.err {
    border-color: var(--halo-error);
    color: var(--halo-error);
  }
  .modal label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .modal input {
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }

  /* Add-to-playlist chooser. */
  .add-track {
    margin: 0;
    color: var(--accent);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 240px;
    overflow-y: auto;
  }
  .add-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .add-row .pn {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .add-row .pc {
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .newrow {
    display: flex;
    gap: 8px;
  }
  .newrow input {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
  }

  /* Settings rows: a label above a segmented choice control. */
  .setting {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .setting-label {
    font-size: 12px;
    color: var(--muted);
  }
  /* Status line under a setting's controls (e.g. library counts / scan state). */
  .setting-hint {
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .seg {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .seg button {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 10px;
    white-space: nowrap;
  }
  .seg button.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .swatch {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
  }
  .dur {
    flex: 0 0 auto;
    width: 40px;
    text-align: right;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .pattern-overlay {
    position: fixed;
    inset: 0;
    z-index: 4;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }
  .pv-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    /* The overlay is full-bleed (inset: 0), so its toolbar sits under the iOS
       status bar without this inset (see the .bar note). */
    padding: calc(8px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right)) 8px
      calc(12px + env(safe-area-inset-left));
    background: var(--surface-bar);
    border-bottom: 1px solid var(--surface-line-2);
  }
  .pv-close {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  /* Right-hand cluster: fav + edit (tracker-only) + settings + close. The
	   title isn't repeated here (the docked transport already shows it), so the
	   tabs sit left and margin-auto pushes this cluster to the right. */
  .pv-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
  }
  .pv-actions .faved {
    color: var(--accent);
  }
  .pv-tabs {
    display: flex;
    gap: 4px;
  }
  .pv-tabs button {
    padding: 4px 10px;
    font-size: 12px;
  }
  .pv-tabs button.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .pv-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    /* leave room for the transport bar floating over the bottom */
    padding-bottom: 52px;
  }
  .scope-strip {
    flex: 0 0 auto;
    height: 72px;
    border-bottom: 1px solid var(--surface-line-2);
  }
  /* Order list strip — the song's pattern sequence; click to jump. */
  .orders {
    flex: 0 0 auto;
    display: flex;
    gap: 3px;
    padding: 5px 8px;
    overflow-x: auto;
    background: var(--surface-bar);
    border-bottom: 1px solid var(--surface-line-2);
    scrollbar-width: thin;
  }
  .orders .ord {
    flex: 0 0 auto;
    min-width: 30px;
    padding: 2px 6px;
    font-family: var(--font-mono-retro);
    font-size: 12px;
    border: 1px solid var(--surface-line-2);
    border-radius: 3px;
    background: var(--surface-2);
    /* --surface-fg-dim is halo's *lightest* text — near-invisible on the light
       theme's near-white bar. --surface-fg (muted) reads on both themes. */
    color: var(--surface-fg);
    cursor: pointer;
  }
  .orders .ord:hover {
    color: var(--surface-fg-active);
  }
  .orders .ord.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .pfill {
    flex: 1;
    min-height: 0;
  }
  .viz-view {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .vizpick {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--surface-line-2);
  }
  .vizpick button {
    padding: 2px 9px;
    font-size: 11px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-hi);
    color: var(--muted);
    cursor: pointer;
  }
  .vizpick button.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }
  /* Fullscreen: the picker floats as a top drawer that slides away after a pause
     and returns on pointer movement, so the viz fills the screen. */
  .viz-view.fs {
    position: relative;
  }
  .viz-view.fs .vizpick {
    position: absolute;
    inset: 0 0 auto 0;
    z-index: 3;
    background: color-mix(in srgb, var(--panel) 82%, transparent);
    backdrop-filter: blur(6px);
    transition:
      transform 0.3s ease,
      opacity 0.3s ease;
  }
  .viz-view.fs .vizpick.hide {
    transform: translateY(-100%);
    opacity: 0;
    pointer-events: none;
  }
  .vizbody {
    flex: 1;
    min-height: 0;
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

  /* Touch has no hover — always show the rename affordance there. */
  @media (hover: none) {
    .edit {
      visibility: visible;
    }
    .fav {
      opacity: 1;
    }
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
    .groupby {
      font-size: 12px;
    }
    .count {
      order: 4;
      flex-basis: 100%;
      margin-left: 0;
    }
    /* Library controls: tighter spacing and hide the least-used facets (bucket
		   order + tracker filter, marked `.opt`) so the row stays short on a phone.
		   Both remain available on desktop. group-by, track sort + format stay. */
    .controls {
      gap: 8px 12px;
      padding: 8px 10px;
    }
    .controls .opt {
      display: none;
    }
    .tabs button {
      flex: 1;
    }
    main {
      padding: 10px 8px 80px;
    }
    .li {
      gap: 8px;
    }
    button,
    select {
      padding: 8px 12px;
    }
    /* Declutter narrow rows: fav + rename move to the player-view header
		   (tap a track to open it). The whole row stays a play target. */
    .li .fav,
    .li .edit {
      display: none;
    }
    /* (Transport's own responsive rules live in @scene/player.) */
    .pv-bar {
      gap: 8px;
    }
  }
</style>

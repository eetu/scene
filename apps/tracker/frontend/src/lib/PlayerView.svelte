<script lang="ts">
  // The full-screen player overlay: pattern / samples / viz tabs, the pattern
  // editor toolbar, and the song-action cluster. The parent renders it only when
  // it's open (playback.current + showPattern) and owns the docked transport; the
  // overlay reads the shared stores (playback, the pv tab/viz store, settings for
  // the pattern mode, library for the current track) and takes leaf callbacks for
  // the parent-owned overlays (add / rename / settings) + close + toast.
  import {
    ChevronLeft,
    ChevronRight,
    LayoutGrid,
    Link2,
    ListPlus,
    Maximize,
    Minimize,
    Pencil,
    Play,
    Settings,
    Square,
    Star,
    X,
  } from "@lucide/svelte";
  import {
    BoingBall,
    CopperBars,
    crt,
    crtSuits,
    DancerScene,
    DiscoBall,
    FlipDots,
    GlowWave,
    HarmonyScope,
    LedBars,
    mountCrt,
    NixieScene,
    PatternView,
    Plasma,
    playback,
    prefetchTubes,
    SampleBrowser,
    Scope,
    ScrollerBoard,
    seekToOrder,
    seqToggle,
    setEditing,
    setEditInst,
    setEditOctave,
    setEditStep,
    setFollowPlay,
    SpeakerPaint,
    Starfield,
    toggleCrt,
    Tunnel,
    VuMeters,
  } from "@scene/player";

  import type { Track } from "$lib/api";
  import { library, toggleFavorite } from "$lib/library.svelte";
  import PatternViewScroll from "$lib/PatternViewScroll.svelte";
  import { pv, VIZ } from "$lib/player-view.svelte";
  import { settings } from "$lib/settings.svelte";
  import { buildShareUrl } from "$lib/url-state";

  let {
    transportH,
    isDesktop,
    onClose,
    onSettings,
    onAdd,
    onEdit,
    onToast,
  }: {
    transportH: number;
    isDesktop: boolean;
    onClose: () => void;
    onSettings: () => void;
    onAdd: (t: Track) => void;
    onEdit: (t: Track) => void;
    onToast: (msg: string, kind?: "ok" | "err") => void;
  } = $props();

  function fmtTime(sec: number): string {
    if (!sec || !isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  function hex2(n: number): string {
    return n.toString(16).toUpperCase().padStart(2, "0");
  }

  // The full library Track for the loaded module (the player store holds only a
  // minimal shape), so the header can favourite / add / rename it.
  const currentTrack = $derived.by(() => {
    const c = playback.current;
    if (!c) return null;
    return library.tracks.find((t) => t.path === c.path) ?? null;
  });

  // Loudest channel VU drives the Boing-ball visualizer energy.
  const vuEnergy = $derived(playback.vu.length ? Math.max(...playback.vu) : 0);

  // ≤640px hides the (keyboard-first) pattern editor toggle — no mobile editor
  // UI yet, and it crowds the narrow bar.
  let isMobile = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => (isMobile = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  // Keep the currently-playing pattern centred in the (horizontally-scrolling)
  // order list, so it never scrolls out of view as playback advances the order.
  let ordersEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    const o = playback.order;
    const el = ordersEl;
    if (!el) return;
    const on = el.querySelectorAll<HTMLElement>(".ord")[o];
    if (on) el.scrollLeft = on.offsetLeft - el.clientWidth / 2 + on.offsetWidth / 2;
  });

  // Copy a deep-link to the current track at the current position (?t=&pos=),
  // YouTube-style — the only thing that ever writes ?pos. Copies to the
  // clipboard; never touches the app's own URL (the writer keeps that clean).
  async function copyLinkAtPosition() {
    const cur = playback.current;
    if (!cur) return;
    const url = buildShareUrl(location.href, cur.hash, playback.position);
    try {
      await navigator.clipboard.writeText(url);
      onToast(`Link copied at ${fmtTime(playback.position)}`);
    } catch {
      onToast("Couldn't copy link", "err");
    }
  }

  // While the viz tab is open, warm the tubes (nixie) chunk in the background —
  // it pulls three.js, and doing that fetch+parse inline when tubes is selected
  // can glitch the audio on mobile. Only fires once the user is in the viz area
  // (so an unused viz tab costs nothing), and only fetches the module — no scene
  // is built until tubes is actually mounted.
  let tubesWarmed = false;
  $effect(() => {
    if (pv.tab === "viz" && !tubesWarmed) {
      tubesWarmed = true;
      const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200));
      idle(() => void prefetchTubes());
    }
  });

  // Fullscreen the visualiser (the 'f' shortcut + surfaces it below). In
  // fullscreen the viz picker auto-hides (slides up like a top drawer) after a
  // pause with no pointer activity, and slides back on movement.
  let vizEl = $state<HTMLElement | undefined>(undefined);
  // The pane the CRT screen wraps. Deliberately the body and not `vizEl`, so the
  // picker row stays outside the tube — buttons behind barrel distortion are hard
  // to hit, and the screen forwards pointer events to canvases, not to controls.
  let vizBody = $state<HTMLElement | undefined>(undefined);
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
  // Is a tube actually in front of the current visualiser? Drives the mount, the set's
  // bezel and the toggle together — gating only the mount once left the bezel drawn
  // around a flip-dot board with no tube inside it.
  const crtLive = $derived(crt.on && crtSuits(pv.vizMode));

  // The CRT screen over the viz pane — created ONCE, not per visualiser. It owns a
  // WebGL context, a browser allows only ~16 of those at a time, and every
  // visualiser holds one of its own; re-creating the screen on each switch burned
  // through the budget twice as fast and the browser started dropping live contexts
  // ("too many active WebGL contexts, the oldest context will be lost"), blacking out
  // whichever visualiser was on screen. The screen tracks canvases appearing and
  // disappearing by itself, so a switch needs nothing from us.
  // …and skipped entirely for the visualisers a tube does not belong in front of (see
  // crtSuits). Mounting is already keyed on the toggle, so this adds a mount/unmount
  // only when a switch crosses the mechanical/emissive line — not on every switch, which
  // is the case the warning above is about.
  $effect(() => {
    const host = vizBody;
    if (!host || !crtLive) return;
    return mountCrt(host);
  });

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
  // Whether a fullscreen button is worth showing at all. iOS Safari implements
  // fullscreen for <video> only — Element.requestFullscreen doesn't exist there — so on
  // an iPhone this is absent rather than present and dead. Desktop keeps the 'f' key
  // regardless; the button exists because a phone has no keyboard to press it with.
  const fullscreenOk = $derived(
    typeof document !== "undefined" &&
      !!document.fullscreenEnabled &&
      typeof Element !== "undefined" &&
      typeof Element.prototype.requestFullscreen === "function",
  );

  function toggleVizFullscreen() {
    if (!vizEl) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void vizEl.requestFullscreen?.();
  }
  // The visualiser sheet (narrow screens): the full set as a grid, since a stepper alone
  // means cycling past a dozen others to reach one. Its open state lives in the pv store
  // so +page's Escape cascade can treat it as the innermost layer.
  function stepViz(dir: number) {
    const i = VIZ.indexOf(pv.vizMode);
    pv.vizMode = VIZ[(i + dir + VIZ.length) % VIZ.length];
  }
  // Leaving the viz tab (or the whole overlay) must not strand the sheet open.
  $effect(() => {
    if (pv.tab !== "viz") pv.vizSheet = false;
  });

  // 'f' fullscreens the visualiser when the viz tab is open (ignored while typing).
  function onVizKey(e: KeyboardEvent) {
    if (pv.tab !== "viz" || (e.key !== "f" && e.key !== "F")) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    toggleVizFullscreen();
  }
</script>

<svelte:window onkeydown={onVizKey} />
<svelte:document onfullscreenchange={onFsChange} />

<div class="pattern-overlay">
  <div class="pv-bar">
    <div class="pv-tabs">
      <button class:on={pv.tab === "pattern"} onclick={() => (pv.tab = "pattern")}>pattern</button>
      <button class:on={pv.tab === "samples"} onclick={() => (pv.tab = "samples")}>samples</button>
      <button class:on={pv.tab === "viz"} onclick={() => (pv.tab = "viz")}>viz</button>
    </div>
    {#if pv.tab === "pattern" && playback.canReadCells && isDesktop && !isMobile}
      <!-- Pattern surface mode: view vs edit (a mode of the pattern tab, kept
           clear of the file-action pencil in the right cluster). Editing is
           keyboard-first, so it's gated to pointer+keyboard devices — and
           hidden on narrow viewports too (no mobile editor UI yet; it would
           also crowd the header). -->
      <div class="pv-mode" role="group" aria-label="pattern mode">
        <button class:on={!playback.editing} onclick={() => setEditing(false)}>view</button>
        <button class:on={playback.editing} onclick={() => setEditing(true)}>edit</button>
      </div>
      {#if playback.editing}
        <button
          class="icon-btn seq"
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
    <div class="pv-actions">
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
          onclick={() => onAdd(ct)}
          title="add to playlist"
          aria-label="add to playlist"
        >
          <ListPlus size={16} />
        </button>
        <button
          class="icon-btn pv-copylink"
          onclick={copyLinkAtPosition}
          title="copy link at current time"
          aria-label="copy link at current time"
        >
          <Link2 size={16} />
        </button>
        <button
          class="icon-btn pv-rename"
          onclick={() => onEdit(ct)}
          title="rename / move"
          aria-label="rename / move"
        >
          <Pencil size={16} />
        </button>
        <!-- Divider: song actions (left) vs view controls (settings/close). -->
        <div class="pv-sep" role="separator" aria-orientation="vertical"></div>
      {/if}
      <button class="icon-btn gear" onclick={onSettings} title="settings" aria-label="settings">
        <Settings size={16} />
      </button>
      <button class="icon-btn pv-close" onclick={onClose} aria-label="close pattern view">
        <X size={16} />
      </button>
    </div>
  </div>
  <div class="pv-wrap" style:padding-bottom="{transportH}px">
    {#if pv.tab === "pattern"}
      {#if settings.scope}
        <div class="scope-strip"><Scope /></div>
      {/if}
      {#if (playback.song?.orders?.length ?? 0) > 1}
        <!-- Order list: click a position to jump there; current is highlighted. -->
        <div class="orders" aria-label="order list" bind:this={ordersEl}>
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
      {#if playback.editing}
        <div class="editbar">
          <span class="lab">oct</span>
          <button onclick={() => setEditOctave(playback.editOctave - 1)} aria-label="octave down"
            >−</button
          >
          <span class="val">{playback.editOctave}</span>
          <button onclick={() => setEditOctave(playback.editOctave + 1)} aria-label="octave up"
            >+</button
          >
          <span class="lab">step</span>
          <button onclick={() => setEditStep(playback.editStep - 1)} aria-label="step down"
            >−</button
          >
          <span class="val">{playback.editStep}</span>
          <button onclick={() => setEditStep(playback.editStep + 1)} aria-label="step up">+</button>
          <span class="lab">inst</span>
          <button onclick={() => setEditInst(playback.editInst - 1)} aria-label="instrument down"
            >−</button
          >
          <span class="val inst"
            >{String(playback.editInst).padStart(2, "0")}
            {playback.samples[playback.editInst - 1] ?? ""}</span
          >
          <button onclick={() => setEditInst(playback.editInst + 1)} aria-label="instrument up"
            >+</button
          >
          <button
            class="follow"
            class:on={playback.followPlay}
            aria-pressed={playback.followPlay}
            title="follow playback: view + cursor ride the playing row"
            onclick={() => setFollowPlay(!playback.followPlay)}>follow</button
          >
          {#if playback.seqPlaying}
            <span class="lab">play</span>
            <span class="val play">{hex2(playback.seqRow)}</span>
          {/if}
        </div>
      {/if}
      <div class="pfill">
        {#if settings.patternMode === "locked"}<PatternView />{:else}<PatternViewScroll />{/if}
      </div>
    {:else if pv.tab === "viz"}
      {@const vizActive = playback.playing && !playback.paused}
      <div class="viz-view" class:fs={vizFs} bind:this={vizEl}>
        <div class="vizpick" class:hide={!pickerShown} class:one-row={isMobile}>
          <!-- Narrow screens get one fixed-height row instead of the full list. Fourteen
               pills already wrap onto two rows, the CRT toggle takes a third, and every
               new visualiser makes it worse — a large bite out of a full-screen player on
               a phone. Steppers cycle without leaving the picture; the name opens the
               whole set as a sheet. Desktop keeps the pills, where seeing all of them at
               once is worth the room it takes. -->
          {#if isMobile}
            <button class="step" onclick={() => stepViz(-1)} aria-label="Previous visualiser">
              <ChevronLeft />
            </button>
            <button
              class="current"
              onclick={() => (pv.vizSheet = true)}
              aria-haspopup="dialog"
              aria-label="Choose a visualiser"
            >
              <LayoutGrid />
              <span>{pv.vizMode}</span>
            </button>
            <button class="step" onclick={() => stepViz(1)} aria-label="Next visualiser">
              <ChevronRight />
            </button>
            {#if fullscreenOk}
              <button
                class="fs"
                onclick={toggleVizFullscreen}
                aria-pressed={vizFs}
                aria-label={vizFs ? "Leave fullscreen" : "Fill the screen"}
              >
                {#if vizFs}<Minimize />{:else}<Maximize />{/if}
              </button>
            {/if}
          {:else}
            {#each VIZ as m (m)}
              <button class:on={pv.vizMode === m} onclick={() => (pv.vizMode = m)}>{m}</button>
            {/each}
          {/if}
          <!-- Not a visualiser, so it sits apart from the mode list: a screen the
               chosen one is watched through. Disabled rather than hidden on the
               visualisers it doesn't apply to — the toggle keeping its place, greyed,
               says "not for this one"; vanishing would just look like a bug, and leaving
               it live would mean pressing it did nothing. -->
          <button
            class="crt"
            class:on={crtLive}
            disabled={!crtSuits(pv.vizMode)}
            onclick={toggleCrt}
            aria-pressed={crtLive}
            aria-label={!crtSuits(pv.vizMode)
              ? "The CRT screen doesn't apply to this visualiser"
              : crt.on
                ? "Turn the CRT screen off"
                : "Watch through a CRT screen"}>crt</button
          >
        </div>
        <!-- Inside .viz-view on purpose: that element is what goes fullscreen, and a
             sheet mounted outside it would be invisible while it is. -->
        {#if pv.vizSheet}
          <div class="vizsheet" role="dialog" aria-modal="true" aria-label="Choose a visualiser">
            <div class="sheethead">
              <span>visualiser</span>
              <button onclick={() => (pv.vizSheet = false)} aria-label="Close"><X /></button>
            </div>
            <div class="sheetgrid">
              {#each VIZ as m (m)}
                <button
                  class:on={pv.vizMode === m}
                  onclick={() => {
                    pv.vizMode = m;
                    pv.vizSheet = false;
                  }}>{m}</button
                >
              {/each}
            </div>
          </div>
        {/if}
        <div class="vizstage">
          <div class="vizbody" bind:this={vizBody}>
            {#if pv.vizMode === "flip"}
              <FlipDots active={vizActive} />
            {:else if pv.vizMode === "board"}
              <ScrollerBoard active={vizActive} />
            {:else if pv.vizMode === "harmony"}
              <HarmonyScope active={vizActive} />
            {:else if pv.vizMode === "cube"}
              <LedBars active={vizActive} />
            {:else if pv.vizMode === "wave"}
              <GlowWave active={vizActive} />
            {:else if pv.vizMode === "vu"}
              <VuMeters active={vizActive} />
            {:else if pv.vizMode === "stars"}
              <Starfield active={vizActive} />
            {:else if pv.vizMode === "copper"}
              <CopperBars active={vizActive} />
            {:else if pv.vizMode === "plasma"}
              <Plasma active={vizActive} />
            {:else if pv.vizMode === "tunnel"}
              <Tunnel active={vizActive} />
            {:else if pv.vizMode === "disco"}
              <DiscoBall active={vizActive} />
            {:else if pv.vizMode === "paint"}
              <SpeakerPaint active={vizActive} />
            {:else if pv.vizMode === "tubes"}
              <NixieScene active={vizActive} />
            {:else if pv.vizMode === "dancer"}
              <DancerScene active={vizActive} />
            {:else}
              <BoingBall energy={vizActive ? vuEnergy : 0} live={vizActive} react />
            {/if}
          </div>
          <!-- The set the tube is mounted in: a broadcast-monitor bezel, drawn over
               the curved face. Purely decorative and outside the CRT host, so it is
               never composited through the effect and never distorted by it. -->
          {#if crtLive}
            <div class="bezel" aria-hidden="true"></div>
            <!-- The maker's mark on the set. An invented wordmark in the style of the
                 era rather than a real manufacturer's — the look is the point, and
                 stamping someone's actual trademark on it isn't. Sits on the frame, so
                 it needs no extra bezel width. -->
            <span class="mark" aria-hidden="true">TRONITRIN</span>
          {/if}
        </div>
      </div>
    {:else}
      <SampleBrowser />
    {/if}
  </div>
</div>

<style>
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
  /* Thin rule splitting song actions (fav/add/link/rename) from view controls. */
  .pv-sep {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--border);
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
  /* Segmented view|edit control — a mode of the pattern surface. */
  .pv-mode {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  .pv-mode button {
    padding: 4px 10px;
    font-size: 12px;
    border: none;
    border-radius: 0;
    background: var(--panel-hi);
    color: var(--muted);
  }
  .pv-mode button.on {
    color: var(--bg);
    background: var(--accent);
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
  /* Edit status bar: base octave, cursor step, current instrument for entry. */
  .editbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--surface-bar);
    border-bottom: 1px solid var(--surface-line-2);
    font-family: var(--font-retro);
    font-size: 12px;
    color: var(--surface-fg);
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .editbar .lab {
    color: var(--muted);
  }
  .editbar .val {
    min-width: 1.5ch;
    text-align: center;
  }
  .editbar .val.inst {
    min-width: 6ch;
    max-width: 16ch;
    text-align: left;
    color: var(--accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .editbar button {
    padding: 2px 8px;
    font-size: 12px;
  }
  .editbar .follow.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .editbar .val.play {
    color: var(--accent);
    min-width: 2ch;
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
  /* The whole point of the narrow layout is ONE row of fixed height. The pill list wraps
     by design, and with five controls on a 390px screen this would wrap too — so it is
     pinned, and the current visualiser (the only flexible item) absorbs the difference. */
  .vizpick.one-row {
    flex-wrap: nowrap;
    align-items: stretch;
  }
  .vizpick.one-row .current {
    overflow: hidden;
  }
  .vizpick.one-row .current span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Narrow screens: the compact row. Square icon buttons so they read as controls rather
     than as short-named modes, and the current visualiser is the wide target. `.fs` shares
     their shape but keeps its own class — it toggles a state rather than cycling the list,
     and grouping it under .step made "the last stepper" mean the fullscreen button. */
  .vizpick .step,
  .vizpick .fs {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 26px;
    padding: 0;
  }
  .vizpick .current {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 0;
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
    font-weight: 600;
  }
  .vizpick .step :global(svg),
  .vizpick .fs :global(svg),
  .vizpick .current :global(svg) {
    width: 13px;
    height: 13px;
  }

  /* The whole set, as a sheet. Fills the pane at this width rather than floating as a
     card — the house pattern for dialogs on narrow screens. */
  .vizsheet {
    position: absolute;
    inset: 0;
    z-index: 6;
    display: flex;
    flex-direction: column;
    background: var(--panel);
  }
  .sheethead {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--surface-line-2);
    font-size: 12px;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .sheethead button {
    display: grid;
    place-items: center;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--panel-hi);
    color: var(--muted);
    cursor: pointer;
  }
  .sheethead button :global(svg) {
    width: 14px;
    height: 14px;
  }
  .sheetgrid {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
    gap: 6px;
    padding: 10px;
    align-content: start;
  }
  .sheetgrid button {
    padding: 10px 6px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-hi);
    color: var(--muted);
    cursor: pointer;
  }
  .sheetgrid button.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }

  /* The CRT toggle is not one of the modes — it's the screen they're watched
     through — so it's pushed to the far end, away from the mode list. */
  .vizpick button.crt {
    margin-left: auto;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  /* Doesn't apply to the mechanical displays (see crtSuits). Dimmed in place rather
     than removed, so the row keeps its shape as you step through visualisers. */
  .vizpick button.crt:disabled {
    opacity: 0.3;
    cursor: default;
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
  /* Etched into the top-left of the frame. Sized off the frame's own width so it can
     never outgrow it, and letter-spaced the way moulded plastic lettering reads.
     Slightly translucent: printed white on grey, not a lit element. */
  .mark {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 4;
    pointer-events: none;
    /* Height only — matching the frame's thickness centres it in the top band. Giving
       it a WIDTH of the frame thickness too made the box narrower than the word, so the
       text spilled out of it and sat flush against the pane's left edge. */
    height: var(--frame);
    display: flex;
    align-items: center;
    /* Lines the wordmark's left edge up with the tube's, since the opening starts one
       frame-width in. */
    padding-left: var(--frame);
    font:
      600 1.05cqmin/1 var(--halo-font-body, system-ui),
      sans-serif;
    letter-spacing: 0.16em;
    /* Printed on the plastic, so it has to INVERT with it, not merely track it: light
       lettering on a dark set, dark lettering on a light one. --text already flips that
       way; a little of the frame mixed back in keeps it printed rather than glowing. */
    color: color-mix(in srgb, var(--text) 88%, var(--bezel));
    text-shadow: 0 0.06cqmin 0.06cqmin rgb(0 0 0 / 0.35);
    white-space: nowrap;
  }

  /* Holds the pane and, when the CRT screen is on, the bezel drawn over it.
     A container so the bezel can be sized in proportion to the pane rather than in
     fixed pixels — the same frame has to read on a phone and on a 4K fullscreen. */
  .vizstage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    container-type: size;
    /* Clips the bezel's outsized ring (below) to the pane. */
    overflow: hidden;
    /* Thickness of the monitor frame. One value so the opening, the wordmark's inset
       and its height can't drift apart. Custom properties substitute as tokens, so the
       cqmin resolves where it's USED — against this element, which is the container. */
    --frame: 3.4cqmin;
    /* The set's plastic, derived from --panel-hi (i.e. --halo-off-bg) rather than the
       hard-coded greys this used to carry. That token is already dark on the dark theme
       and light on the light one, so the frame sits in the room's lighting instead of
       glowing out of a dark page — and it flips with the theme for free. A little accent
       mixed in keeps it warm moulded plastic rather than neutral grey, and follows a
       re-themed accent the way the visualisers now do. */
    --bezel: color-mix(in srgb, var(--panel-hi) 94%, var(--accent));
    --bezel-hi: color-mix(in srgb, var(--bezel) 82%, white);
    --bezel-lo: color-mix(in srgb, var(--bezel) 84%, black);
    --bezel-lip: color-mix(in srgb, var(--bezel) 52%, black);
  }
  .vizbody {
    flex: 1;
    min-height: 0;
  }
  /* A broadcast-monitor bezel, after the grey plastic Sony sets these demos were
     watched on. Only the border paints — the centre stays transparent, so the
     picture shows through — and the inset shadows are the dark lip where the glass
     meets the frame, which is what makes the tube look seated in something rather
     than pasted on. Sides are lit differently (top lighter, bottom darker) for the
     moulded bevel. */
  .bezel {
    position: absolute;
    /* This element IS the opening, not the frame: it is inset by the frame's width and
       the grey is a huge outset ring around it, clipped to the pane by .vizstage. Done
       as a border with border-radius instead, the OUTER corners round off too and the
       pane's own black shows through behind them — which is the notch that appeared in
       the top-left corner. A ring has square outer corners by construction. */
    inset: var(--frame);
    border-radius: 3cqmin;
    z-index: 3;
    pointer-events: none;
    /* Face plate, then a lighter top lip and darker bottom one for the moulded bevel,
       then the dark recess the glass sits in. All from --bezel, so the whole frame
       follows the theme together. */
    box-shadow:
      0 0 0 100cqmax var(--bezel),
      0 -0.4cqmin 0 0.2cqmin var(--bezel-hi),
      0 0.4cqmin 0 0.2cqmin var(--bezel-lo),
      inset 0 0 0 0.35cqmin var(--bezel-lip),
      inset 0 0 2.6cqmin 0.5cqmin rgb(0 0 0 / 0.8);
  }

  @media (max-width: 640px) {
    /* The action cluster overflows an iPhone-width header (close gets clipped).
       Drop the desktop-ish song actions — copy-link + rename/move — plus the
       now-orphaned divider; fav / add / settings / close stay reachable. */
    .pv-copylink,
    .pv-rename,
    .pv-sep {
      display: none;
    }
    .pv-bar {
      gap: 8px;
    }
  }
</style>

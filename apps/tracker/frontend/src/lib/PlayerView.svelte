<script lang="ts">
  // The full-screen player overlay: pattern / samples / viz tabs, the pattern
  // editor toolbar, and the song-action cluster. The parent renders it only when
  // it's open (playback.current + showPattern) and owns the docked transport; the
  // overlay reads the shared stores (playback, the pv tab/viz store, settings for
  // the pattern mode, library for the current track) and takes leaf callbacks for
  // the parent-owned overlays (add / rename / settings) + close + toast.
  import { Link2, ListPlus, Pencil, Play, Settings, Square, Star, X } from "@lucide/svelte";
  import {
    BoingBall,
    CopperBars,
    DiscoBall,
    Equalizer,
    GlowWave,
    LedBars,
    NixieScene,
    PatternView,
    Plasma,
    playback,
    SampleBrowser,
    Scope,
    seekToOrder,
    seqToggle,
    setEditing,
    setEditInst,
    setEditOctave,
    setEditStep,
    setFollowPlay,
    Starfield,
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

  // Fullscreen the visualiser (the 'f' shortcut + surfaces it below). In
  // fullscreen the viz picker auto-hides (slides up like a top drawer) after a
  // pause with no pointer activity, and slides back on movement.
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
  function toggleVizFullscreen() {
    if (!vizEl) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void vizEl.requestFullscreen?.();
  }
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
      <div class="scope-strip"><Scope /></div>
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
        <div class="vizpick" class:hide={!pickerShown}>
          {#each VIZ as m (m)}
            <button class:on={pv.vizMode === m} onclick={() => (pv.vizMode = m)}>{m}</button>
          {/each}
        </div>
        <div class="vizbody">
          {#if pv.vizMode === "bars"}
            <Equalizer active={vizActive} />
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
          {:else if pv.vizMode === "tubes"}
            <NixieScene active={vizActive} />
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

<script lang="ts">
  // Shared transport bar: seek strip + prev/play/next/shuffle/repeat, the
  // now-playing title/artist, and time + order/pattern/row readouts. Drives the
  // `playback` store. Layout-agnostic (no fixed positioning) — the host app
  // places it (tracker docks it at the bottom; party shows it inline).
  import {
    Maximize2,
    Pause,
    Play,
    Repeat,
    Shuffle,
    SkipBack,
    SkipForward,
    TriangleAlert,
  } from "@lucide/svelte";

  import {
    playback,
    playNext,
    playPrev,
    seekSeconds,
    toggleRepeat,
    toggleShuffle,
    transportToggle,
  } from "./player.svelte";

  let {
    onOpenView,
    showPos = true,
  }: {
    /** If given, the title/artist becomes a button that calls this (e.g. open a
     *  full-screen pattern view). Otherwise it's static text. */
    onOpenView?: () => void;
    /** Show the order/pattern/row teaser (hidden on narrow screens anyway). */
    showPos?: boolean;
  } = $props();

  const hasPrev = $derived(playback.queueIndex > 0);
  const hasNext = $derived(
    playback.queueIndex >= 0 &&
      (playback.shuffle
        ? playback.queueLength > 1
        : playback.queueIndex + 1 < playback.queueLength),
  );

  function fmtTime(sec: number): string {
    if (!sec || !isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // Draggable seek head. Pointer events cover mouse + touch; while dragging we
  // preview the position locally (dragFrac) and commit the seek on release, so a
  // scrub doesn't thrash the decoder mid-drag. A plain tap seeks on release too.
  let seeking = $state(false);
  let dragFrac = $state(0);
  // Fill/head position: the live drag preview while scrubbing, else the playhead.
  const pct = $derived(
    (seeking ? dragFrac : playback.duration ? playback.position / playback.duration : 0) * 100,
  );

  function fracAt(clientX: number, el: HTMLElement): number {
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }
  function onPointerDown(e: PointerEvent) {
    if (!playback.duration) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    seeking = true;
    dragFrac = fracAt(e.clientX, el);
  }
  function onPointerMove(e: PointerEvent) {
    if (!seeking) return;
    dragFrac = fracAt(e.clientX, e.currentTarget as HTMLElement);
  }
  function onPointerUp(e: PointerEvent) {
    if (!seeking) return;
    dragFrac = fracAt(e.clientX, e.currentTarget as HTMLElement);
    if (playback.duration) seekSeconds(dragFrac * playback.duration);
    seeking = false;
  }
  function onSeekKey(e: KeyboardEvent) {
    if (!playback.duration) return;
    const step = e.shiftKey ? 10 : 5; // seconds
    if (e.key === "ArrowLeft") {
      seekSeconds(Math.max(0, playback.position - step));
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      seekSeconds(Math.min(playback.duration, playback.position + step));
      e.preventDefault();
    }
  }
</script>

{#if playback.current}
  <div class="transport">
    <div
      class="seek"
      class:seeking
      role="slider"
      tabindex="0"
      aria-label="seek"
      aria-valuemin="0"
      aria-valuemax={Math.round(playback.duration) || 0}
      aria-valuenow={Math.round(playback.position) || 0}
      aria-valuetext="{fmtTime(playback.position)} of {fmtTime(playback.duration)}"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onkeydown={onSeekKey}
    >
      <div class="seek-fill" style:width="{pct}%"></div>
      <div class="seek-head" style:left="{pct}%"></div>
    </div>
    <div class="t-controls">
      <button class="t-btn" onclick={playPrev} disabled={!hasPrev} aria-label="previous">
        <SkipBack size={16} />
      </button>
      <button
        class="t-btn t-play"
        onclick={transportToggle}
        aria-label={playback.playing && !playback.paused ? "pause" : "play"}
      >
        {#if playback.playing && !playback.paused}<Pause size={16} />{:else}<Play size={16} />{/if}
      </button>
      <button class="t-btn" onclick={playNext} disabled={!hasNext} aria-label="next">
        <SkipForward size={16} />
      </button>
      {#if onOpenView}
        <button
          class="t-info t-info-btn"
          onclick={onOpenView}
          title="open player view"
          aria-label="open player view"
        >
          <span class="t-title-row">
            <span class="t-title">{playback.current.title || playback.current.filename}</span>
            <span class="t-open" aria-hidden="true"><Maximize2 size={12} /></span>
          </span>
          <span class="t-meta">
            {playback.current.group ?? ""}{playback.current.artist
              ? ` · ${playback.current.artist}`
              : ""}
          </span>
        </button>
      {:else}
        <div class="t-info">
          <span class="t-title">{playback.current.title || playback.current.filename}</span>
          <span class="t-meta">
            {playback.current.group ?? ""}{playback.current.artist
              ? ` · ${playback.current.artist}`
              : ""}
          </span>
        </div>
      {/if}
      <button
        class="t-btn t-mode"
        class:on={playback.shuffle}
        onclick={toggleShuffle}
        aria-label="shuffle"
        title="shuffle"
      >
        <Shuffle size={16} />
      </button>
      <button
        class="t-btn t-mode"
        class:on={playback.repeat}
        onclick={toggleRepeat}
        aria-label="repeat"
        title="repeat (loop)"
      >
        <Repeat size={16} />
      </button>
      <div class="t-time">
        {playback.duration
          ? `${fmtTime(playback.position)} / ${fmtTime(playback.duration)}`
          : fmtTime(playback.position)}
      </div>
      {#if showPos}
        <div class="t-pos">
          ord <span class="num">{playback.order}</span> · pat
          <span class="num">{playback.pattern}</span> · row
          <span class="num">{playback.row}</span>
        </div>
      {/if}
    </div>
    {#if playback.error}
      <div class="t-error" role="alert">
        <TriangleAlert size={13} /> Couldn't play this module — {playback.error}
      </div>
    {/if}
  </div>
{/if}

<style>
  .transport {
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-top: 1px solid var(--border);
  }
  .seek {
    position: relative;
    display: block;
    width: 100%;
    height: 8px;
    padding: 0;
    border: none;
    border-radius: 0;
    background: var(--panel-hi);
    cursor: pointer;
    touch-action: none; /* we handle the drag; don't let it scroll the page */
  }
  .seek:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .seek-fill {
    height: 100%;
    background: var(--accent);
    pointer-events: none;
  }
  /* Draggable head — a knob at the playhead; grows while scrubbing. */
  .seek-head {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    margin-left: -6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--panel);
    transform: translateY(-50%);
    transition:
      transform 0.1s ease,
      opacity 0.15s ease;
    pointer-events: none;
  }
  .seek.seeking .seek-head {
    transform: translateY(-50%) scale(1.35);
  }
  /* On pointer devices reveal the head only on hover/focus (or while scrubbing);
     touch devices (no hover) keep it visible so it's always grabbable. */
  @media (hover: hover) {
    .seek-head {
      opacity: 0;
    }
    .seek:hover .seek-head,
    .seek:focus-visible .seek-head,
    .seek.seeking .seek-head {
      opacity: 1;
    }
  }
  .t-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
  }
  .t-btn {
    flex: 0 0 auto;
    min-width: 40px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 5px 10px;
    background: var(--panel-hi);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
  }
  .t-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .t-btn.on {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
  }
  /* Play/pause is the primary control — accent-filled and a touch wider. */
  .t-play {
    color: var(--bg);
    background: var(--accent);
    border-color: var(--accent);
    min-width: 48px;
  }
  /* Shuffle/repeat are secondary toggles — ghost buttons, accent only when on. */
  .t-mode {
    min-width: 0;
    background: none;
    border-color: transparent;
    color: var(--muted);
  }
  .t-mode.on {
    color: var(--accent);
    background: none;
    border-color: transparent;
  }
  .t-btn :global(svg) {
    display: block;
    stroke-width: 2.5;
    stroke-linecap: square;
    stroke-linejoin: miter;
  }
  .t-info {
    flex: 1;
    min-width: 0;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    cursor: pointer;
    color: inherit;
  }
  .t-title {
    display: block;
    font-family: var(--font-retro, ui-monospace, monospace);
    font-size: 13px;
    color: var(--accent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .t-meta {
    display: block;
    margin-top: 3px;
    font-family: var(--font-retro, ui-monospace, monospace);
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* When the title is a button (open player view), signal it's interactive:
     a trailing expand glyph + underline/accent on hover & keyboard focus. */
  .t-info-btn {
    display: block;
  }
  .t-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .t-title-row .t-title {
    min-width: 0;
  }
  .t-open {
    flex: 0 0 auto;
    display: inline-flex;
    color: var(--muted);
    opacity: 0.7;
    transition:
      color 0.15s ease,
      opacity 0.15s ease;
  }
  .t-info-btn:hover .t-open,
  .t-info-btn:focus-visible .t-open {
    color: var(--accent);
    opacity: 1;
  }
  .t-info-btn:hover .t-title {
    text-decoration: underline;
  }
  .t-info-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
  /* Playback error — a full-width strip under the controls, not a whisper after
     the artist name, so a corrupt/unsupported module doesn't read as "muted". */
  .t-error {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 14px;
    font-size: 12px;
    color: var(--halo-error);
    background: color-mix(in srgb, var(--halo-error) 14%, transparent);
    border-top: 1px solid color-mix(in srgb, var(--halo-error) 35%, transparent);
  }
  .t-error :global(svg) {
    flex: 0 0 auto;
  }
  .t-time {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 13px;
    font-family: var(--font-mono-retro, ui-monospace, monospace);
    font-variant-numeric: tabular-nums;
  }
  .t-pos {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 12px;
    font-family: var(--font-mono-retro, ui-monospace, monospace);
    font-variant-numeric: tabular-nums;
  }
  .num {
    display: inline-block;
    min-width: 2ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  @media (max-width: 640px) {
    /* Fatter strip + bigger head so the playhead is easy to grab by thumb. */
    .seek {
      height: 16px;
    }
    .seek-head {
      width: 20px;
      height: 20px;
      margin-left: -10px;
    }
    .t-pos {
      display: none;
    }
    .t-controls {
      flex-wrap: wrap;
      gap: 6px;
      row-gap: 8px;
      padding: 8px 8px;
    }
    .t-info {
      order: -1;
      flex-basis: 100%;
    }
    .t-controls .t-btn {
      flex: 1;
      min-width: 0;
      padding: 8px 0;
    }
    .t-time {
      order: 1;
      align-self: center;
      padding-left: 4px;
    }
  }
</style>

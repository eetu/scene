<script lang="ts">
  // Flip-dot viz: an electromechanical departure-board matrix, showing one of several
  // faces (see flip-modes.ts for what may live on it and why).
  //
  // @glowbox/flip-dot renders real flip physics — each dot is a disc rotating about its
  // pivot, and a frame change sweeps the board as a driver scan rather than landing at
  // once. That sets a ceiling on how fast it can be driven, but the ceiling is higher
  // than it first looks: with the flip shortened to 38ms and the sweep to 70ms, a disc
  // has finished well inside a 70ms update, so the board can run at ~14Hz and still
  // show every change land. Frames also go out on the beat, so hits are on time rather
  // than up to a tick late.
  //
  // Content is one bit per dot, so nothing here dithers: at this resolution a clean cut
  // gives a stable silhouette where a halftone would shimmer between frames.
  import { onMount } from "svelte";

  import type { FlipDotBoard } from "@glowbox/flip-dot";
  import { flip, setFlipMode } from "./flip-mode.svelte";
  import { createFlipRenderer, FLIP_MODES } from "./flip-modes";
  import {
    loadReel,
    REEL_IDS,
    type Reel,
    reelFrameAt,
    reelIdFor,
    sampleReel,
    trackNames,
  } from "./flip-reel";
  import { playback } from "./state.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement | undefined = $state();

  /**
   * The reel, waved away.
   *
   * A clip takes the board over for the one tune it belongs to, and pressing any mode
   * hands it straight back — an easter egg you cannot get out of is a fault. Not
   * persisted and not remembered past the track: the next tune that has a reel gets to
   * show it, because the whole point is coming across it.
   */
  let reelOff = $state(false);

  // Dots are square, so the grid follows the pane's aspect rather than a fixed panel.
  // ~40 columns keeps them chunky enough to read as discs at typical pane sizes; the
  // resulting ~900 dots also puts the library's pre-squashed sprite atlas to work, which
  // it only reaches for above 512.
  const COLS = 40;

  function cssVar(name: string, fallback: string): string {
    if (typeof getComputedStyle !== "function") return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  onMount(() => {
    let stopped = false;
    let board: FlipDotBoard | null = null;
    let stopFrames: (() => void) | null = null;
    let ro: ResizeObserver | null = null;

    void (async () => {
      const { createFlipDots } = await import("@glowbox/flip-dot");
      if (stopped || !canvas) return;

      const r = host.getBoundingClientRect();
      const aspect = r.height > 0 ? r.width / r.height : 1.8;
      const rows = Math.max(8, Math.min(32, Math.round(COLS / Math.max(aspect, 0.5))));

      board = createFlipDots(canvas, {
        cols: COLS,
        rows,
        // Lit dots take the theme accent; the unlit face and the board behind stay dark
        // and distinct from each other, which is what makes an unlit dot read as a dot
        // rather than as a hole.
        onColor: cssVar("--accent", "#f78f08"),
        offColor: "#15161a",
        board: "#0a0b0d",
        // Flat matte is how the real boards photograph, and it holds up better behind the
        // CRT screen's mask than the shaded lighting does.
        shaded: false,
        stagger: "scan",
        // Quicker than the defaults (70/150). The real boards are this slow; at 14Hz
        // updates the default flip is still in flight when the next frame arrives, so
        // dots never quite arrive and the board smears.
        flipMs: 38,
        scanMs: 70,
        label: "spectrum on a flip-dot board",
      });
      if (!board) return; // no 2D context — leave the pane empty rather than half-built

      ro = new ResizeObserver(() => board?.resize());
      ro.observe(host);

      const render = createFlipRenderer();
      let lastBeat = -1;
      let sinceUpdate = 0;

      // The reel: a clip cut for one particular tune, if the folder holds one and the
      // loaded track is that tune. Nothing here is fetched otherwise — with no reels
      // built, `REEL_IDS` is empty and this is a string compare per track change.
      let reelTrack: string | null = null;
      let reelNotes = -1;
      let reel: Reel | null = null;
      let reelGrid = new Uint8Array(0);

      function pickReel() {
        const t = playback.current;
        const key = t ? (t.hash ?? t.filename ?? "") : "";
        // The notes are fetched after the track loads, and for a SID they are where the
        // thing it covers is written down — so a match has to be looked for again when
        // they land, not once when the tune starts.
        const notes = playback.notes.length;
        if (key === reelTrack && notes === reelNotes) return;
        const fresh = key !== reelTrack;
        reelTrack = key;
        reelNotes = notes;
        if (fresh) {
          reel = null;
          reelOff = false;
        } else if (reel) return; // already showing this track's reel
        if (!t || !REEL_IDS.length) return;
        const id = reelIdFor(REEL_IDS, ...trackNames(t, playback.notes));
        if (!id) return;
        void loadReel(id).then((r) => {
          // A track change while the fetch was in flight wins: the board belongs to
          // whatever is playing now, not to what was playing when this was asked for.
          if (!stopped && reelTrack === key) reel = r;
        });
      }

      stopFrames = driveFrames(
        (dt) => {
          const b = board;
          if (!b) return;
          pickReel();

          // ~14Hz, plus an immediate frame on the beat so hits land on time. Still
          // outside the 38ms flip, so a disc finishes before it is asked to turn again.
          sinceUpdate += dt;
          const onBeat = playback.beat !== lastBeat;
          if (!onBeat && sinceUpdate < 0.07) return;
          const step = sinceUpdate;
          lastBeat = playback.beat;
          sinceUpdate = 0;

          // A reel is not driven by dt: it is a film, and where it is up to is where
          // the playhead is. Seeking the tune seeks the picture, which is the only way
          // the two stay together over three minutes.
          if (reel && !reelOff) {
            if (reelGrid.length !== b.cols * b.rows) reelGrid = new Uint8Array(b.cols * b.rows);
            sampleReel(reel, reelFrameAt(reel, playback.position), b.cols, b.rows, reelGrid);
            b.setFrame((x, y) => reelGrid[y * b.cols + x] === 1);
            return;
          }

          render.render(flip.mode, b.cols, b.rows, step, active, onBeat);
          b.setFrame((x, y) => render.dot(x, y));
        },
        { active: () => active },
      );
    })();

    return () => {
      stopped = true;
      stopFrames?.();
      ro?.disconnect();
      board?.dispose();
    };
  });
</script>

<div class="flip" bind:this={host} data-testid="flip-dots">
  <canvas bind:this={canvas}></canvas>
  <!-- Sub-modes rather than four more entries in the pane's own picker: that list is
       already fifteen wide and grew a stepper on phones because of it. These are faces
       of one visualiser, not four visualisers. -->
  <div class="modes">
    {#each FLIP_MODES as m (m.id)}
      <button
        class:on={flip.mode === m.id}
        onclick={() => {
          reelOff = true;
          setFlipMode(m.id);
        }}
        aria-pressed={flip.mode === m.id}>{m.label}</button
      >
    {/each}
  </div>
</div>

<style>
  /* Dark surround: the board's own plastic is near-black, so the pane matches rather than
     framing it in a lighter box. Not theme-following, for the same reason the nixie and
     dancer scenes aren't — a lit display only reads in a dark room. */
  .flip {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    background: #0a0b0d;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* In front of the CRT glass, necessarily: the screen composites canvases and nothing
     else, so a DOM control can only sit on top. Same reasoning and treatment as the
     scroller board's pager. */
  /* Top right, not bottom right: the bottom edge is where a spectrum is densest, and
     small labels sat unreadable on top of a wall of lit dots. Every mode here leaves the
     top corners quiet — bars are short at the treble end, rings are circular, stars are
     sparse. */
  .modes {
    position: absolute;
    right: 0.4rem;
    top: 0.4rem;
    z-index: 3;
    display: flex;
    gap: 0.25rem;
  }
  .modes button {
    padding: 0.2rem 0.5rem;
    border: 1px solid color-mix(in srgb, var(--accent, #f78f08) 35%, transparent);
    border-radius: 3px;
    /* Opaque, not a tint: a translucent chip over lit dots washes out whichever way the
       contrast falls, and this has to stay readable against a board that changes. */
    background: #0a0b0d;
    color: var(--accent, #f78f08);
    font: inherit;
    font-size: 0.7rem;
    line-height: 1.1;
    cursor: pointer;
    /* Dim until wanted: the board is the thing being looked at. Not dimmer than this —
       below ~0.5 the labels stop being readable at a glance, and a control you have to
       hunt for is worse than one you can see. */
    opacity: 0.55;
    transition: opacity 120ms ease;
  }
  .modes button:hover,
  .modes button:focus-visible {
    opacity: 0.9;
  }
  .modes button.on {
    opacity: 1;
    border-color: var(--accent, #f78f08);
    background: color-mix(in srgb, var(--accent, #f78f08) 18%, #0a0b0d);
  }
  /* Touch: 2rem-ish text buttons are well under the 44px both platforms ask for, and
     these sit at the pane's edge. Keyed on pointer type, not width — a small laptop
     with a trackpad wants the compact version, a large tablet does not. */
  @media (pointer: coarse) {
    .modes button {
      min-width: 2.75rem;
      min-height: 2.75rem;
      font-size: 0.8rem;
    }
    /* Nothing hovers on touch, so the resting state has to be legible on its own. */
    .modes button {
      opacity: 0.7;
    }
  }
</style>

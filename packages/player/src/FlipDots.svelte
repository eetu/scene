<script lang="ts">
  // Flip-dot viz: the spectrum on an electromechanical departure board.
  //
  // @glowbox/flip-dot renders real flip physics — each dot is a disc rotating about its
  // pivot, and a frame change sweeps the board as a driver scan rather than landing at
  // once. That sets a ceiling on how fast it can be driven, but the ceiling is higher than
  // it first looks: with the flip shortened to 45ms and the sweep to 90ms, a disc has
  // finished well inside a 100ms update, so the board can run at 10Hz and still show every
  // change land. Frames also go out on the beat, so hits are on time rather than up to a
  // tick late.
  //
  // Driving it slower than this — a frame only per beat — was the first attempt and it
  // read as a static mass: at 2-3 updates a second the spectrum is a shape that occasionally
  // changes rather than something moving to the music.
  //
  // Content is one bit per dot, so the spectrum is drawn as bar heights directly rather
  // than dithered: at this resolution a clean cut gives a stable silhouette where a
  // halftone would shimmer between frames.
  import { onMount } from "svelte";

  import type { FlipDotBoard } from "@glowbox/flip-dot";
  import { playback, readSpectrum, SPECTRUM_SIZE, spectrumSampleRate } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement | undefined = $state();

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
        // Quicker than the defaults (70/150). The real boards are this slow; at 10Hz
        // updates the default flip is still in flight when the next frame arrives, so
        // dots never quite arrive and the board smears.
        flipMs: 38,
        scanMs: 70,
        label: "spectrum on a flip-dot board",
      });
      if (!board) return; // no 2D context — leave the pane empty rather than half-built

      ro = new ResizeObserver(() => board?.resize());
      ro.observe(host);

      const spec = new Uint8Array(SPECTRUM_SIZE);
      const F_MIN = 40;
      const F_MAX = 12000;
      const heights = new Float32Array(COLS); // eased column heights, 0..1
      const peaks = new Float32Array(COLS);

      // Per-column tilt. Music carries far more energy low down, so mapping magnitude
      // straight to height pegs the bass columns and barely lights the treble — the board
      // sits half-full on the left through most of a track and the right stays dead. This
      // is the analyser convention of tilting up with frequency (about +3dB/octave, i.e.
      // amplitude with the square root of f), clamped so the very top of the range can't
      // run away on hiss.
      const tilt = new Float32Array(COLS);
      for (let c = 0; c < COLS; c++) {
        const f0 = F_MIN * Math.pow(F_MAX / F_MIN, c / COLS);
        const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (c + 1) / COLS);
        tilt[c] = Math.min(2.8, Math.max(0.7, Math.pow(Math.sqrt(f0 * f1) / 320, 0.5)));
      }
      let lastBeat = -1;
      let sinceUpdate = 0;

      stopFrames = driveFrames(
        (dt) => {
          const b = board;
          if (!b) return;

          if (active && readSpectrum(spec)) {
            const hzPerBin = spectrumSampleRate() / 2 / SPECTRUM_SIZE;
            for (let c = 0; c < COLS; c++) {
              const f0 = F_MIN * Math.pow(F_MAX / F_MIN, c / COLS);
              const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (c + 1) / COLS);
              const lo = Math.max(1, Math.floor(f0 / hzPerBin));
              const hi = Math.min(SPECTRUM_SIZE, Math.max(lo + 1, Math.ceil(f1 / hzPerBin)));
              let sum = 0;
              for (let j = lo; j < hi; j++) sum += spec[j];
              // Gamma above 1 compresses toward the floor rather than the ceiling. The
              // original 0.8 did the opposite — it lifted every middling level toward
              // full, which is the other half of why the board looked permanently full.
              const v = Math.min(1, Math.pow((sum / (hi - lo) / 255) * tilt[c], 1.25));
              // Fast attack, and a fall quick enough to see. The original 0.08 release
              // held every bar near its recent maximum, so the lit area only ever grew
              // within a phrase — the "static bulk" that made the board look dead.
              heights[c] += (v - heights[c]) * (v > heights[c] ? 0.6 : 0.3);
              peaks[c] = Math.max(peaks[c] - dt * 0.5, heights[c]);
            }
          } else {
            for (let c = 0; c < COLS; c++) {
              heights[c] *= 0.86;
              peaks[c] = Math.max(peaks[c] - dt * 0.8, heights[c]);
            }
          }

          // ~14Hz, plus an immediate frame on the beat so hits land on time. Still outside
          // the 38ms flip, so a disc finishes before it is asked to turn again.
          sinceUpdate += dt;
          const onBeat = playback.beat !== lastBeat;
          if (!onBeat && sinceUpdate < 0.07) return;
          lastBeat = playback.beat;
          sinceUpdate = 0;

          const rowCount = b.rows;
          b.setFrame((x, y) => {
            // y counts down from the top, so a bar of height h lights the bottom h rows.
            const level = rowCount - y;
            const h = heights[x] * rowCount;
            if (level <= h) return true;
            // Peak marker: one dot riding above the bar, the flip-dot equivalent of a
            // peak-hold segment.
            return Math.ceil(peaks[x] * rowCount) === level;
          });
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
</style>

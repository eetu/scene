<script lang="ts">
  // Amiga raster bars — "copper bars", after the Copper, the display co-processor
  // that drew them. It rewrote the background colour register between scanlines,
  // so a band of colour could be laid across the screen without the CPU touching
  // a pixel, and into the border, which nothing else could reach at all. The
  // saturated per-line colour is the whole point of the effect, not decoration;
  // each bar is a gradient across its short axis (dark→bright→dark) for the
  // metallic sheen the technique is remembered for.
  //
  // Two forms, and this renders both. Horizontal is the classic (a colour change
  // per scanline). Vertical was a different trick — the same line of video memory
  // re-output every scanline, its pointer nudged during the blanking interval —
  // and because that pointer moved a whole word at a time, the bars stepped
  // sideways rather than gliding. That quantisation is deliberately NOT
  // reproduced: on the hardware the steps vanished because the bars swept fast,
  // whereas this bundle drifts a few dozen pixels a second, where a 16-pixel
  // quantum is a visible jump a few times a second and just reads as jank.
  //
  // The bars are drawn as one contiguous bundle that undulates, rather than as
  // seven independently-bouncing stripes. Bouncing them separately about a shared
  // centre piles them up mid-frame and leaves the edges empty — it reads as a
  // barcode, where the effect should read as one metallic ribbon.
  import { fitCanvas2d } from "./canvas2d";
  import { playback } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  const BARS = 7;

  // Which way the bars run. Derived from the track's content hash so a listen
  // gets both forms without a control to find, and a given tune always looks the
  // same; clicking overrides it for the current track.
  let flipped = $state(false);
  let vertical = $derived.by(() => {
    const key = playback.current?.hash ?? playback.current?.filename ?? "";
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    const fromHash = ((Math.abs(h) >> 2) & 1) === 1;
    return fromHash !== flipped; // XOR: the click inverts whatever the hash chose
  });

  // Reset the manual override when the track changes, so the hash gets to pick
  // again rather than the override sticking for the rest of the session.
  $effect(() => {
    void playback.current?.hash;
    flipped = false;
  });

  $effect(() => {
    const el = canvas;
    if (!el) return;
    const isVertical = vertical;

    let w = 0;
    let h = 0;
    const fit = fitCanvas2d(el, (fw, fh) => {
      w = fw;
      h = fh;
    });
    if (!fit) return;
    const g2 = fit.ctx;

    let t = 0; // frame phase (avoids Date dependency)
    let amp = 0; // eased travel amplitude

    // One hue per bar, sweeping warm→cool across the bundle. A copper list held a
    // colour per line, so a hue ramp down the stack is what the hardware actually
    // produced; muting it would be a period-inaccurate "improvement".
    const hues = Array.from({ length: BARS }, (_, i) => 20 + (i / BARS) * 260);

    const stopFrames = driveFrames(
      () => {
        const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
        const target = active ? 0.25 + energy * 0.75 : 0.12;
        amp += (target - amp) * 0.08;
        t += 0.007 + (active ? energy * 0.012 : 0);

        if (w > 0 && h > 0) {
          // Light theme: a pale panel so the glossy bars read as colour on light.
          g2.fillStyle = document.documentElement.dataset.theme === "light" ? "#e7e7ee" : "#0a0a12";
          g2.fillRect(0, 0, w, h);

          // `span` is the axis the bars stack along; they always run the full
          // length of the other one, edge to edge — the border-invasion the
          // effect was showing off.
          const span = isVertical ? w : h;
          // Two thirds of the pane, leaving a third for the bundle to travel in.
          // Raster bars are meant to leave backdrop showing — they were laid over
          // a logo or a starfield — but with nothing behind them here, a narrower
          // ribbon just reads as a gap.
          const barW = span * 0.095;
          const bundle = BARS * barW;
          // The bundle travels in the space it doesn't occupy, so it never walks
          // off the pane however hard the track is hitting.
          const travel = ((span - bundle) / 2) * amp;
          const top = (span - bundle) / 2;

          for (let i = 0; i < BARS; i++) {
            // A small per-bar phase offset makes the ribbon undulate instead of
            // sliding as one rigid block, while keeping the bars adjacent.
            const wobble = Math.sin(t + i * 0.35) * travel;
            const p = top + i * barW + wobble;

            const hue = hues[i];
            // The sheen runs across the bar's short axis, whichever way it lies.
            const grad = isVertical
              ? g2.createLinearGradient(p, 0, p + barW, 0)
              : g2.createLinearGradient(0, p, 0, p + barW);
            grad.addColorStop(0, `hsl(${hue}, 90%, 8%)`);
            grad.addColorStop(0.5, `hsl(${hue}, 95%, 65%)`);
            grad.addColorStop(0.55, `hsl(${hue}, 100%, 88%)`);
            grad.addColorStop(0.6, `hsl(${hue}, 95%, 65%)`);
            grad.addColorStop(1, `hsl(${hue}, 90%, 8%)`);
            g2.fillStyle = grad;
            if (isVertical) g2.fillRect(p, 0, barW, h);
            else g2.fillRect(0, p, w, barW);
          }
        }
      },
      { active: () => active },
    );

    return () => {
      stopFrames();
      fit.stop();
    };
  });
</script>

<!-- Click flips the orientation. A real button so it's keyboard-reachable and
     announced; the canvas underneath is decorative. -->
<button
  class="raster"
  type="button"
  onclick={() => (flipped = !flipped)}
  title={vertical ? "Horizontal bars" : "Vertical bars"}
  data-testid="copper-bars"
>
  <span class="sr">{vertical ? "Switch to horizontal bars" : "Switch to vertical bars"}</span>
  <canvas bind:this={canvas}></canvas>
</button>

<style>
  .raster {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .raster:focus-visible {
    outline: 2px solid var(--accent, #f78f08);
    outline-offset: -3px;
  }
  /* Visually hidden, still announced. */
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>

<script lang="ts">
  // Amiga copper/raster bars: stacked glossy horizontal bars that sine-bounce
  // vertically, their travel and shimmer driven by the music energy. Each bar is
  // a vertical gradient (dark→bright→dark) for the rounded metallic sheen, hues
  // cycling through a warm→cool sweep. Dark panel in both themes.
  import { playback } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  const BARS = 7;

  $effect(() => {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const g2: CanvasRenderingContext2D = ctx;

    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      w = r.width;
      h = r.height;
      el.width = Math.max(1, Math.round(w * dpr));
      el.height = Math.max(1, Math.round(h * dpr));
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    ro.observe(el);

    let t = 0; // frame phase (avoids Date dependency)
    let amp = 0; // eased bounce amplitude

    // Fixed copper palette (warm → cool), one hue per bar.
    const hues = Array.from({ length: BARS }, (_, i) => 20 + (i / BARS) * 260);

    const stopFrames = driveFrames(
      () => {
        const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
        const target = active ? 0.25 + energy * 0.75 : 0.12;
        amp += (target - amp) * 0.08;
        // Slower sweep — a calmer base cadence and a gentler energy term so the
        // bars don't race while a track plays.
        t += 0.007 + (active ? energy * 0.012 : 0);

        if (w > 0 && h > 0) {
          // Light theme: a pale panel so the glossy bars read as colour on light.
          g2.fillStyle = document.documentElement.dataset.theme === "light" ? "#e7e7ee" : "#0a0a12";
          g2.fillRect(0, 0, w, h);
          const barH = h * 0.12;
          const travel = (h - barH) * 0.5 * amp;
          const mid = h / 2;
          for (let i = 0; i < BARS; i++) {
            const phase = (i / BARS) * Math.PI * 2;
            const y = mid - barH / 2 + Math.sin(t + phase) * travel;
            const hue = hues[i];
            const grad = g2.createLinearGradient(0, y, 0, y + barH);
            grad.addColorStop(0, `hsl(${hue}, 90%, 8%)`);
            grad.addColorStop(0.5, `hsl(${hue}, 95%, 65%)`);
            grad.addColorStop(0.55, `hsl(${hue}, 100%, 88%)`);
            grad.addColorStop(0.6, `hsl(${hue}, 95%, 65%)`);
            grad.addColorStop(1, `hsl(${hue}, 90%, 8%)`);
            g2.fillStyle = grad;
            g2.fillRect(0, y, w, barH);
          }
        }
      },
      { fps: 60 },
    );

    return () => {
      stopFrames();
      ro.disconnect();
    };
  });
</script>

<canvas bind:this={canvas}></canvas>

<style>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>

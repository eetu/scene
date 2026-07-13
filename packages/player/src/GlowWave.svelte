<script lang="ts">
  // Neon glow-waveform visualizer. Draws the output waveform (from the player's
  // AnalyserNode) as a luminous ribbon: a short history of recent waveforms is
  // kept and redrawn oldest→newest with an alpha/width ramp, and the strokes are
  // blended additively ('lighter') so overlaps bloom into a soft neon glow — the
  // layered, feathered "strands" look. In dark theme it's accent-coloured on the
  // themed scope panel; in light theme the panel stays dark (neon glow only reads
  // on a dark field) and the wave goes neon purple — the inspiration's look.
  import { readScope, SCOPE_SIZE } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  const POINTS = 128; // resampled waveform width
  const TRAILS = 16; // history depth (feathered strands)

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

    const raw = new Uint8Array(SCOPE_SIZE);
    // Ring buffer of resampled waveforms (each POINTS long, values -1..1).
    const history: Float32Array[] = Array.from({ length: TRAILS }, () => new Float32Array(POINTS));
    let head = 0;

    // Neon purple in both themes. Dark theme keeps the (dark) scope panel and
    // blends strokes additively for the glow; light theme uses a lighter
    // lavender panel and draws normally (additive would wash to white on a
    // light field), so the purple still reads.
    let cachedTheme: string | null = null;
    let light = false;
    let cBg = "#08080f";
    let cGrid = "#1c1c28";
    const cWave = "#c46bff";
    const node: HTMLCanvasElement = el;
    function refreshColors(isLight: boolean) {
      if (isLight) {
        cBg = "#efeaf8";
        cGrid = "#d8cdef";
        return;
      }
      const cs = getComputedStyle(node);
      cBg = cs.getPropertyValue("--scope-bg").trim() || "#08080f";
      cGrid = cs.getPropertyValue("--scope-grid").trim() || "#1c1c28";
    }

    const stopFrames = driveFrames(
      () => {
        // Resolved theme (mode may be 'auto'): the layout writes it to <html>.
        const eff = document.documentElement.dataset.theme === "light" ? "light" : "dark";
        if (eff !== cachedTheme) {
          light = eff === "light";
          refreshColors(light);
          cachedTheme = eff;
        }

        // Push the current waveform (or silence) into the ring buffer.
        const cur = history[head];
        if (active && readScope(raw)) {
          const step = raw.length / POINTS;
          for (let i = 0; i < POINTS; i++) cur[i] = raw[Math.floor(i * step)] / 128 - 1;
        } else {
          cur.fill(0);
        }

        if (w > 0 && h > 0) {
          g2.globalCompositeOperation = "source-over";
          g2.fillStyle = cBg;
          g2.fillRect(0, 0, w, h);

          // Faint baseline grid line.
          const mid = h / 2;
          g2.globalAlpha = 1;
          g2.strokeStyle = cGrid;
          g2.lineWidth = 1;
          g2.beginPath();
          g2.moveTo(0, mid);
          g2.lineTo(w, mid);
          g2.stroke();

          const amp = h * 0.4;
          const xStep = w / (POINTS - 1);
          // Dark: additive so overlapping faint strands accumulate into glow.
          // Light: normal compositing (additive would blow out to white on a
          // light panel) — the strands read as translucent purple instead.
          g2.globalCompositeOperation = light ? "source-over" : "lighter";
          g2.strokeStyle = cWave;
          g2.lineJoin = "round";
          g2.lineCap = "round";
          for (let t = TRAILS - 1; t >= 0; t--) {
            const wave = history[(head - t + TRAILS) % TRAILS];
            // Newest (t=0) = brightest, thickest, with a glow halo; older trails
            // fade and thin out, fanning into feathered strands.
            const age = t / (TRAILS - 1);
            g2.globalAlpha = (light ? 0.7 : 0.5) * (1 - age) ** 1.6 + 0.04;
            g2.lineWidth = 2.2 * (1 - age) + 0.5;
            g2.shadowColor = cWave;
            g2.shadowBlur = t === 0 ? 16 : 6 * (1 - age);
            g2.beginPath();
            for (let i = 0; i < POINTS; i++) {
              const x = i * xStep;
              const y = mid - wave[i] * amp;
              if (i === 0) g2.moveTo(x, y);
              else g2.lineTo(x, y);
            }
            g2.stroke();
          }
          g2.shadowBlur = 0;
          g2.globalAlpha = 1;
          g2.globalCompositeOperation = "source-over";
        }

        head = (head + 1) % TRAILS;
      },
      { fps: () => (active ? 45 : 15) },
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

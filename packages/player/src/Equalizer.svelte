<script lang="ts">
  // Vintage hi-fi spectrum analyzer: a dense row of segmented "LED" bars on a
  // warm backlit glass panel. FFT bins are grouped into logarithmic bands (bass
  // gets its own bars), each bar has meter ballistics (fast attack / slow
  // release) and a peak-hold cap that floats and drifts down. Segments are small
  // uniform squares tinted by a horizontal amber→green wash (the classic
  // backlit-panel look); lit tips + caps bloom via a soft glow. Light theme
  // drops the glow and shows the unlit cells as a grey grid on a pale panel.
  import { readSpectrum, SPECTRUM_SIZE } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true, bands = 56 }: { active?: boolean; bands?: number } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  // Backlit-panel gradient endpoints (left → right): warm amber to cool green.
  const LEFT: [number, number, number] = [255, 156, 28];
  const RIGHT: [number, number, number] = [56, 212, 84];

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

    const buf = new Uint8Array(SPECTRUM_SIZE);
    const levels = new Float32Array(bands);
    const peaks = new Float32Array(bands);
    const peakHold = new Float32Array(bands);

    // Per-band colour (horizontal amber→green lerp) + log-spaced bin ranges,
    // computed once. Most musical energy sits low, so cap the top bin under
    // Nyquist to spread bars across audible content.
    const cols: Array<[number, number, number]> = [];
    const ranges: Array<[number, number]> = [];
    const TOP_BIN = Math.floor(SPECTRUM_SIZE * 0.7);
    for (let b = 0; b < bands; b++) {
      const f = b / (bands - 1);
      cols.push([
        Math.round(LEFT[0] + (RIGHT[0] - LEFT[0]) * f),
        Math.round(LEFT[1] + (RIGHT[1] - LEFT[1]) * f),
        Math.round(LEFT[2] + (RIGHT[2] - LEFT[2]) * f),
      ]);
      const lo = Math.floor(TOP_BIN ** (b / bands));
      const hi = Math.max(lo + 1, Math.floor(TOP_BIN ** ((b + 1) / bands)));
      ranges.push([lo, Math.min(hi, SPECTRUM_SIZE)]);
    }

    let cachedMode: string | null = null;
    let light = false;
    let cBg = "#08080f";
    const node: HTMLCanvasElement = el;
    function refreshColors() {
      const cs = getComputedStyle(node);
      cBg = cs.getPropertyValue("--scope-bg").trim() || cBg;
      light = document.documentElement.dataset.theme === "light";
    }

    const stopFrames = driveFrames(
      () => {
        const mode = document.documentElement.dataset.theme ?? "";
        if (mode !== cachedMode) {
          refreshColors();
          cachedMode = mode;
        }
        if (w > 0 && h > 0) {
          g2.globalCompositeOperation = "source-over";
          g2.fillStyle = cBg;
          g2.fillRect(0, 0, w, h);

          // Dim backlight wash so the glass panel glows even where unlit.
          const grad = g2.createLinearGradient(0, 0, w, 0);
          grad.addColorStop(0, `rgba(${LEFT[0]},${LEFT[1]},${LEFT[2]},0.10)`);
          grad.addColorStop(1, `rgba(${RIGHT[0]},${RIGHT[1]},${RIGHT[2]},0.10)`);
          g2.fillStyle = grad;
          g2.fillRect(0, 0, w, h);

          const have = active && readSpectrum(buf);
          const padX = Math.max(4, w * 0.015);
          const gapX = Math.max(1, w * 0.004);
          const barW = (w - padX * 2 - gapX * (bands - 1)) / bands;
          const padY = Math.max(3, h * 0.04);
          const fieldH = h - padY * 2;
          // Square-ish LED cells: pick a segment count that makes cell height
          // roughly match the bar width.
          const segGap = Math.max(1, barW * 0.16);
          const segments = Math.max(10, Math.min(64, Math.round(fieldH / (barW + segGap))));
          const segH = (fieldH - segGap * (segments - 1)) / segments;

          for (let b = 0; b < bands; b++) {
            let target = 0;
            if (have) {
              const [lo, hi] = ranges[b];
              let sum = 0;
              for (let i = lo; i < hi; i++) sum += buf[i];
              const raw = sum / (hi - lo) / 255;
              // Spectral tilt: bass naturally dominates, so attenuate low bands
              // and lift the highs — keeps the meter from pinning to the top.
              const tilt = 0.55 + 0.95 * (b / (bands - 1));
              target = Math.min(1, raw ** 0.8 * tilt);
            }
            const lv = levels[b];
            // Instant attack, faster release for a snappier, more dynamic fall.
            levels[b] = target > lv ? target : lv + (target - lv) * 0.34;

            if (levels[b] >= peaks[b]) {
              peaks[b] = levels[b];
              peakHold[b] = 14;
            } else if (peakHold[b] > 0) {
              peakHold[b] -= 1;
            } else {
              peaks[b] = Math.max(0, peaks[b] - 0.012);
            }

            const [r, gg, bb] = cols[b];
            const x = padX + b * (barW + gapX);
            const litCount = Math.round(levels[b] * segments);
            const peakSeg = Math.round(peaks[b] * segments);

            for (let s = 0; s < segments; s++) {
              const y = padY + fieldH - (s + 1) * segH - s * segGap;
              const lit = s < litCount;
              const isPeak = peakSeg > 0 && s === peakSeg - 1;
              const isTip = lit && s === litCount - 1;
              // Glow only reads on a dark panel; light theme draws flat.
              const glow = light ? 0 : Math.max(6, barW * 0.9);
              g2.fillStyle = `rgb(${r},${gg},${bb})`;
              if (isPeak && !lit) {
                // Floating peak cap.
                g2.globalAlpha = 1;
                g2.shadowColor = `rgb(${r},${gg},${bb})`;
                g2.shadowBlur = glow;
              } else if (lit) {
                // Fade the column body downward so the bright moving top edge
                // (where the action is) stands out instead of a solid block.
                const depth = litCount > 1 ? (litCount - 1 - s) / (litCount - 1) : 0;
                g2.globalAlpha = 1 - depth * (light ? 0.62 : 0.78);
                g2.shadowColor = `rgb(${r},${gg},${bb})`;
                g2.shadowBlur = isTip || isPeak ? glow : 0;
              } else {
                // Unlit cell: faint backlight on dark; a grey grid on light.
                g2.shadowBlur = 0;
                if (light) {
                  g2.globalAlpha = 0.12;
                  g2.fillStyle = "#000";
                } else {
                  g2.globalAlpha = 0.1;
                }
              }
              g2.fillRect(x, y, barW, segH);
            }
          }
          g2.shadowBlur = 0;
          g2.globalAlpha = 1;
        }
      },
      { active: () => active },
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

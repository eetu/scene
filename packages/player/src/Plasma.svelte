<script lang="ts">
  // Classic demoscene plasma: summed sine fields rendered into a small offscreen
  // buffer and upscaled nearest-neighbour (so it stays chunky + on-brand), with
  // a cycling colour palette whose speed rides the music energy. Fills the whole
  // area, so the panel colour is irrelevant — looks the same in both themes.
  import { playback } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  const PW = 128; // low-res buffer width
  const PH = 80;

  $effect(() => {
    const el = canvas;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const g2: CanvasRenderingContext2D = ctx;
    g2.imageSmoothingEnabled = false;

    // Offscreen low-res buffer.
    const buf = document.createElement("canvas");
    buf.width = PW;
    buf.height = PH;
    const bctx0 = buf.getContext("2d");
    if (!bctx0) return;
    const bctx: CanvasRenderingContext2D = bctx0;
    const img = bctx.createImageData(PW, PH);
    const data = img.data;

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
      g2.imageSmoothingEnabled = false;
    });
    ro.observe(el);

    // Accent-tinted 256-entry palette (HSL sweep around the accent hue).
    let palette = new Uint8Array(256 * 3);
    let cachedMode: string | null = null;
    const node: HTMLCanvasElement = el;
    function buildPalette() {
      const acc = getComputedStyle(node).getPropertyValue("--accent").trim() || "#f78f08";
      // Derive a base hue from the accent (hex); fall back to amber.
      const m = /^#?([0-9a-f]{6})$/i.exec(acc);
      let baseHue = 35;
      if (m) {
        const n = parseInt(m[1], 16);
        const r = (n >> 16) & 255;
        const gg = (n >> 8) & 255;
        const b = n & 255;
        const mx = Math.max(r, gg, b);
        const mn = Math.min(r, gg, b);
        const d = mx - mn;
        if (d) {
          let hh;
          if (mx === r) hh = ((gg - b) / d) % 6;
          else if (mx === gg) hh = (b - r) / d + 2;
          else hh = (r - gg) / d + 4;
          baseHue = (((hh * 60) % 360) + 360) % 360;
        }
      }
      for (let i = 0; i < 256; i++) {
        // Triangle 0→1→0 over the cycle. Sweep the accent (orange) hue toward
        // purple via the magenta side (never green) — on-style dark orange ↔ purple.
        const tri = (1 - Math.cos((i / 256) * Math.PI * 2)) / 2;
        const hue = (((baseHue - 110 * tri) % 360) + 360) % 360;
        const l = 46 + 16 * tri; // dark orange → brighter purple
        const [r, g, b] = hslToRgb(hue, 72, l);
        palette[i * 3] = r;
        palette[i * 3 + 1] = g;
        palette[i * 3 + 2] = b;
      }
    }
    function hslToRgb(hh: number, ss: number, ll: number): [number, number, number] {
      const s = ss / 100;
      const l = ll / 100;
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
      const m = l - c / 2;
      let r = 0;
      let g = 0;
      let b = 0;
      if (hh < 60) [r, g, b] = [c, x, 0];
      else if (hh < 120) [r, g, b] = [x, c, 0];
      else if (hh < 180) [r, g, b] = [0, c, x];
      else if (hh < 240) [r, g, b] = [0, x, c];
      else if (hh < 300) [r, g, b] = [x, 0, c];
      else [r, g, b] = [c, 0, x];
      return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    }

    let t = 0;
    const stopFrames = driveFrames(
      () => {
        const mode = document.documentElement.dataset.theme ?? "";
        if (mode !== cachedMode) {
          buildPalette();
          cachedMode = mode;
        }
        const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
        t += 0.02 + (active ? energy * 0.06 : 0.003);

        let p = 0;
        for (let y = 0; y < PH; y++) {
          for (let x = 0; x < PW; x++) {
            const v =
              Math.sin(x * 0.06 + t) +
              Math.sin(y * 0.07 - t * 0.8) +
              Math.sin((x + y) * 0.05 + t * 0.6) +
              Math.sin(Math.sqrt((x - PW / 2) ** 2 + (y - PH / 2) ** 2) * 0.08 - t);
            const idx = (((v + 4) / 8) * 255) & 255;
            const c = idx * 3;
            data[p++] = palette[c];
            data[p++] = palette[c + 1];
            data[p++] = palette[c + 2];
            data[p++] = 255;
          }
        }
        bctx.putImageData(img, 0, 0);
        if (w > 0 && h > 0) g2.drawImage(buf, 0, 0, w, h);
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

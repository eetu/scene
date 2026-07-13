<script lang="ts">
  // Classic demoscene plasma: summed sine fields rendered into a small offscreen
  // buffer and upscaled nearest-neighbour (so it stays chunky + on-brand), with
  // a cycling colour palette whose speed rides the music energy. Fills the whole
  // area, so the panel colour is irrelevant — looks the same in both themes.
  import { playback } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

  const PW = 160; // low-res buffer width
  const PH = 100;

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
        // Dark→bright range with a modest hot peak — kept well below white so the
        // magenta reads rich and deep, not a washed-out near-white wash. (The
        // plasma value distribution clusters at the palette's bright middle, so a
        // high peak lightness floods the whole field.)
        const l = 16 + 34 * tri + 6 * Math.pow(tri, 6);
        const [r, g, b] = hslToRgb(hue, 82, l);
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
        // Repaint on either theme OR accent change (both alter --accent's hue).
        const mode = `${document.documentElement.dataset.theme ?? ""}/${document.documentElement.dataset.accent ?? ""}`;
        if (mode !== cachedMode) {
          buildPalette();
          cachedMode = mode;
        }
        const energy = playback.vu.length ? Math.max(...playback.vu) : 0;
        t += 0.02 + (active ? energy * 0.06 : 0.003);

        // Two drifting hot-spots + higher-frequency sine layers give the field
        // moving interference detail and depth, not a couple of static soft blobs.
        const cx1 = PW * (0.5 + 0.32 * Math.sin(t * 0.6));
        const cy1 = PH * (0.5 + 0.3 * Math.cos(t * 0.5));
        const cx2 = PW * (0.5 + 0.34 * Math.sin(t * 0.37 + 2.0));
        const cy2 = PH * (0.5 + 0.33 * Math.cos(t * 0.43 + 1.0));

        let p = 0;
        for (let y = 0; y < PH; y++) {
          for (let x = 0; x < PW; x++) {
            const dx1 = x - cx1;
            const dy1 = y - cy1;
            const dx2 = x - cx2;
            const dy2 = y - cy2;
            const v =
              Math.sin(x * 0.09 + t) +
              Math.sin(y * 0.11 - t * 0.8) +
              Math.sin((x + y) * 0.07 + t * 0.6) +
              Math.sin(Math.sqrt(dx1 * dx1 + dy1 * dy1) * 0.11 - t * 1.3) +
              Math.sin(Math.sqrt(dx2 * dx2 + dy2 * dy2) * 0.14 + t * 0.9);
            const idx = (((v + 5) / 10) * 255) & 255;
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

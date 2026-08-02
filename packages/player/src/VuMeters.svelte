<script lang="ts">
  // Analog VU meters styled after a warm backlit hi-fi meter: a glowing amber
  // dial face, a curved numbered scale (denser, red near full scale), a slim
  // black needle and a dark bezel hiding the pivot. Two meters (L/R banks of the
  // VU channels) with meter ballistics — eased attack + slower release. The dial
  // is self-coloured, so it reads identically in both themes.
  import { playback } from "./player.svelte";
  import { driveFrames } from "./raf";
  import { drawVuMeter, vuEase } from "./vu-meter";

  let { active = true }: { active?: boolean } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);

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

    let posL = 0;
    let posR = 0;
    let posM = 0; // combined L+R needle (mono downmix → one meter)
    function bank(lo: number, hi: number): number {
      const vu = playback.vu;
      if (!vu.length) return 0;
      const a = Math.floor(vu.length * lo);
      const b = Math.max(a + 1, Math.floor(vu.length * hi));
      let s = 0;
      let n = 0;
      for (let i = a; i < b && i < vu.length; i++) {
        s += vu[i];
        n++;
      }
      return n ? Math.min(1, s / n) : 0;
    }

    // The dial itself lives in vu-meter.ts — the hi-fi deck wears the same instrument on
    // its faceplate, and two drawings of one object drift apart.
    const meter = (x0: number, y0: number, cw: number, ch: number, level: number, label: string) =>
      drawVuMeter(g2, x0, y0, cw, ch, level, label);

    // Retro brushed-aluminium hi-fi face (light theme): a near-uniform cool grey
    // with a faint vertical sheen, overlaid with dense, low-contrast horizontal
    // micro-striations + a slow broad band — deterministic per row so they don't
    // shimmer. Used as the panel behind the dials.
    function drawBrushedSteel() {
      const grad = g2.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "#cdcfd4");
      grad.addColorStop(0.5, "#bcbec4");
      grad.addColorStop(1, "#c6c8ce");
      g2.fillStyle = grad;
      g2.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y++) {
        const r = Math.sin(y * 12.9898) * 43758.5453;
        const micro = r - Math.floor(r) - 0.5; // -0.5..0.5 fine grain
        const broad = Math.sin(y * 0.025) * 0.5; // slow sheen bands
        const d = micro * 0.1 + broad * 0.04; // small brightness delta
        g2.fillStyle = d >= 0 ? `rgba(255,255,255,${d})` : `rgba(74,76,84,${-d})`;
        g2.fillRect(0, y, w, 1);
      }
    }

    const stopFrames = driveFrames(
      () => {
        // Mono downmix → one combined meter (the two banks carry the same signal,
        // so a single L+R dial is honest); stereo → the L/R pair.
        const mono = playback.mono;
        const tL = active && !mono ? bank(0, 0.5) : 0;
        const tR = active && !mono ? bank(0.5, 1) : 0;
        const tM = active && mono ? bank(0, 1) : 0;
        // Eased attack, slower release (≈ VU ballistics).
        posL = vuEase(posL, tL);
        posR = vuEase(posR, tR);
        posM = vuEase(posM, tM);

        if (w > 0 && h > 0) {
          if (document.documentElement.dataset.theme === "light") drawBrushedSteel();
          else {
            g2.fillStyle = "#120d07";
            g2.fillRect(0, 0, w, h);
          }
          if (mono) {
            meter(0, 0, w, h, posM, "L+R");
          } else {
            meter(0, 0, w / 2, h, posL, "L");
            meter(w / 2, 0, w / 2, h, posR, "R");
          }
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

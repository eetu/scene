<script lang="ts">
  // Master output oscilloscope — draws the playback waveform from the player's
  // AnalyserNode. (A first scope; per-channel FT2 scopes would need the worklet
  // to expose per-channel PCM.)
  import { playback, readScope, SCOPE_SIZE } from "./player.svelte";
  import { driveFrames } from "./raf";
  import { theme } from "@scene/design";

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

    const buf = new Uint8Array(SCOPE_SIZE);
    // Canvas can't use CSS vars directly — resolve the themed colours from
    // the element's computed style, re-reading only when the theme flips.
    let cachedMode: string | null = null;
    let cBg = "#08080f";
    let cGrid = "#2a2a3a";
    let cWave = "#f0a02a";
    const node: HTMLCanvasElement = el;
    function refreshColors() {
      const cs = getComputedStyle(node);
      cBg = cs.getPropertyValue("--scope-bg").trim() || cBg;
      cGrid = cs.getPropertyValue("--scope-grid").trim() || cGrid;
      cWave = cs.getPropertyValue("--accent").trim() || cWave;
    }

    const stopFrames = driveFrames(
      () => {
        if (theme.mode !== cachedMode) {
          refreshColors();
          cachedMode = theme.mode;
        }
        if (w > 0 && h > 0) {
          g2.fillStyle = cBg;
          g2.fillRect(0, 0, w, h);
          const mid = h / 2;
          g2.strokeStyle = cGrid;
          g2.lineWidth = 1;
          g2.beginPath();
          g2.moveTo(0, mid);
          g2.lineTo(w, mid);
          g2.stroke();

          // Only trace the waveform while actually playing (paused/stopped =
          // silence = flat); cap the point count so wide screens don't draw
          // thousands of segments per frame.
          if (playback.playing && !playback.paused && readScope(buf)) {
            g2.strokeStyle = cWave; // halo accent
            g2.lineWidth = 1.5;
            g2.beginPath();
            const points = Math.min(Math.floor(w), 512);
            const sStep = buf.length / points;
            const xStep = w / points;
            for (let i = 0; i < points; i++) {
              const v = buf[Math.floor(i * sStep)] / 128 - 1; // -1..1
              const y = mid - v * (mid * 0.9);
              const x = i * xStep;
              if (i === 0) g2.moveTo(x, y);
              else g2.lineTo(x, y);
            }
            g2.stroke();
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

<script lang="ts">
  // Draws one sample's waveform (given its SampleData) with loop + sustain-loop
  // markers and a live play cursor while jamming. Click the waveform to audition
  // from that point (like FT2). Gate on `playback.canReadSamples` in the caller.
  import { jamNote, jamStop, playback, type SampleData } from "./player.svelte";

  let { data, index }: { data: SampleData | null; index: number } = $props();

  let canvas = $state<HTMLCanvasElement | undefined>(undefined);

  // Live play cursor: playback.jamPos is the jammed note's sample-frame position
  // (synced to audio). Shown as a thin overlay so the canvas isn't redrawn per
  // tick. Only meaningful while a note is sounding (jamPos >= 0).
  const cursorPct = $derived(
    playback.jamPos >= 0 && data && data.info.length > 0
      ? Math.min(100, (playback.jamPos / data.info.length) * 100)
      : -1,
  );

  // Click-to-audition: play the sample from the clicked position at middle C.
  let auditionId = -1;
  async function onDown(e: PointerEvent) {
    if (!data || data.info.length === 0 || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const frame = Math.floor(frac * data.info.length);
    canvas.setPointerCapture?.(e.pointerId);
    auditionId = await jamNote(index, 60, frame);
  }
  function onUp() {
    if (auditionId >= 0) {
      jamStop(auditionId);
      auditionId = -1;
    }
  }

  // Redraw when data or the canvas element changes.
  $effect(() => {
    const cv = canvas;
    const d = data;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = cv.clientWidth || 300;
    const h = cv.clientHeight || 120;
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(cv);
    const accent = css.getPropertyValue("--accent").trim() || "#e8a";
    const line = css.getPropertyValue("--muted").trim() || "#888";
    const mid = h / 2;

    // zero line
    ctx.strokeStyle = line;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.globalAlpha = 1;

    const pcm = d?.pcm;
    if (!pcm || pcm.length === 0) return;

    // Peak envelope per pixel column, drawn as a filled shape (top = max, bottom
    // = min) with a crisp outline — smoother than per-column hairlines.
    const n = pcm.length;
    const hiY = new Float32Array(w);
    const loY = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * n);
      const b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
      let lo = 1;
      let hi = -1;
      for (let i = a; i < b && i < n; i++) {
        const v = pcm[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      // Guarantee at least a hairline of thickness so quiet/DC samples still show.
      hiY[x] = mid - Math.max(hi, lo + 0.004) * mid;
      loY[x] = mid - lo * mid;
    }
    ctx.beginPath();
    ctx.moveTo(0, hiY[0]);
    for (let x = 1; x < w; x++) ctx.lineTo(x, hiY[x]);
    for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, loY[x]);
    ctx.closePath();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.strokeStyle = accent;
    ctx.stroke();

    // Loop / sustain markers.
    const info = d.info;
    const xOf = (frame: number) => (frame / n) * w;
    const marker = (frame: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(xOf(frame) + 0.5, 0);
      ctx.lineTo(xOf(frame) + 0.5, h);
      ctx.stroke();
    };
    if (info.flags & 1 && info.loopEnd > info.loopStart) {
      ctx.globalAlpha = 0.7;
      marker(info.loopStart, accent);
      marker(info.loopEnd, accent);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = accent;
      ctx.fillRect(xOf(info.loopStart), 0, xOf(info.loopEnd) - xOf(info.loopStart), h);
      ctx.globalAlpha = 1;
    }
    if (info.flags & 4 && info.sustainEnd > info.sustainStart) {
      marker(info.sustainStart, line);
      marker(info.sustainEnd, line);
    }
  });
</script>

<div class="canvaswrap">
  <canvas
    bind:this={canvas}
    title="click to audition from here"
    onpointerdown={onDown}
    onpointerup={onUp}
    onpointerleave={(e) => e.buttons && onUp()}
    onpointercancel={onUp}
  ></canvas>
  {#if cursorPct >= 0}
    <div class="cursor" style="left:{cursorPct}%"></div>
  {/if}
</div>

<style>
  .canvaswrap {
    position: relative;
  }
  canvas {
    width: 100%;
    height: 120px;
    display: block;
    background: var(--panel);
    border: 1px solid var(--surface-line-2, var(--border));
    border-radius: 4px;
    cursor: text;
    touch-action: none;
  }
  @media (max-width: 560px) {
    canvas {
      height: 88px;
    }
  }
  .cursor {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: var(--text, #fff);
    mix-blend-mode: difference;
    pointer-events: none;
  }
</style>

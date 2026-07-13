<script lang="ts">
  // One channel's oscilloscope, sized to fill its column header so it sits
  // directly above that channel's notes (tied to the track, scrolls with the
  // grid). Driven by the editor sequencer's per-channel analyser tap; flat when
  // not playing (no idle rAF — driveFrames only loops while seqPlaying).
  import { playback, readSeqScope, SEQ_SCOPE_SIZE } from "./player.svelte";
  import { driveFrames } from "./raf";

  let { ch, h = 16 }: { ch: number; h?: number } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let w = $state(0);

  function draw(ctx: CanvasRenderingContext2D, buf: Uint8Array, col: string) {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = buf.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = (1 - (buf[i] - 128) / 128) * (h / 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  $effect(() => {
    const el = canvas;
    if (!el || w < 2) return;
    const playing = playback.seqPlaying;
    const col = getComputedStyle(el).getPropertyValue("--accent").trim() || "#f78f08";
    const buf = new Uint8Array(SEQ_SCOPE_SIZE);
    const flat = new Uint8Array(SEQ_SCOPE_SIZE).fill(128);
    const paint = () => {
      const ctx = el.getContext("2d");
      if (!ctx) return;
      draw(ctx, playing && readSeqScope(ch, buf) ? buf : flat, col);
    };
    if (!playing) {
      paint(); // one flat frame, no loop
      return;
    }
    return driveFrames(paint, { active: () => true });
  });
</script>

<div class="cs" bind:clientWidth={w}>
  <canvas bind:this={canvas} width={w} height={h}></canvas>
</div>

<style>
  .cs {
    width: 100%;
    line-height: 0;
  }
  canvas {
    display: block;
    width: 100%;
  }
</style>

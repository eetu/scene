<script lang="ts">
  // Per-channel oscilloscopes for the editor sequencer. Each channel has its own
  // Web Audio gain→analyser tap (see player.svelte.ts), so this is a true
  // per-track waveform — impossible off libopenmpt's single mixed output, but
  // free here because our sequencer plays each channel as its own node.
  import { playback, readSeqScope, SEQ_SCOPE_SIZE } from "./player.svelte";
  import { driveFrames } from "./raf";

  const channels = $derived(playback.song?.channels ?? []);
  let canvases = $state<(HTMLCanvasElement | null)[]>([]);

  function accent(el: HTMLElement): string {
    return getComputedStyle(el).getPropertyValue("--accent").trim() || "#f78f08";
  }

  function draw(ctx: CanvasRenderingContext2D, w: number, h: number, buf: Uint8Array, col: string) {
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
    const chans = channels.length;
    if (!chans) return;
    const buf = new Uint8Array(SEQ_SCOPE_SIZE);
    // Depend on seqPlaying so we (re)start animating on play and settle to a flat
    // line once stopped.
    const playing = playback.seqPlaying;
    const flat = new Uint8Array(SEQ_SCOPE_SIZE).fill(128);

    const paint = () => {
      for (let c = 0; c < chans; c++) {
        const cv = canvases[c];
        if (!cv) continue;
        const ctx = cv.getContext("2d");
        if (!ctx) continue;
        const got = playing && readSeqScope(c, buf);
        draw(ctx, cv.width, cv.height, got ? buf : flat, accent(cv));
      }
    };

    if (!playing) {
      paint(); // one flat frame
      return;
    }
    return driveFrames(paint, { fps: 60 });
  });
</script>

{#if playback.canReadCells && channels.length > 1}
  <div class="scopes" aria-label="per-channel scopes">
    {#each channels as ch, c (c)}
      <div class="scope" title={ch || `channel ${c + 1}`}>
        <canvas bind:this={canvases[c]} width="72" height="30"></canvas>
        <span class="lbl">{String(c + 1).padStart(2, "0")}</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .scopes {
    display: flex;
    gap: 3px;
    padding: 3px 6px;
    overflow-x: auto;
    background: var(--surface);
    border-bottom: 1px solid var(--surface-line-2);
    scrollbar-width: thin;
  }
  .scope {
    position: relative;
    flex: 0 0 auto;
    border: 1px solid var(--surface-line-2);
    border-radius: 2px;
    background: var(--scope-bg, var(--surface-2));
  }
  canvas {
    display: block;
  }
  .lbl {
    position: absolute;
    top: 1px;
    left: 3px;
    font-family: var(--font-mono-retro);
    font-size: 9px;
    color: var(--surface-fg);
    opacity: 0.7;
    pointer-events: none;
  }
</style>

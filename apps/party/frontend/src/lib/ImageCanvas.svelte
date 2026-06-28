<script lang="ts">
  // Canvas image viewer. Draws a (browser-native) image to a canvas at its
  // native resolution with nearest-neighbour scaling, so pixel art stays crisp.
  // Built on canvas (not <img>) so it can later render raw decoded pixels from
  // the transcoder / a client-side LBM/PCX decoder. Clicking the image opens a
  // full-screen overlay (same crisp scaling, fit to the viewport); Esc or a
  // click closes it.
  let { src, alt = "" }: { src: string; alt?: string } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let error = $state(false);
  let fs = $state(false);

  $effect(() => {
    const el = canvas;
    const url = src;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    error = false;
    const img = new Image();
    img.onload = () => {
      el.width = img.naturalWidth;
      el.height = img.naturalHeight;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.drawImage(img, 0, 0);
    };
    img.onerror = () => (error = true);
    img.src = url;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  });

  function onKey(e: KeyboardEvent) {
    if (fs && e.key === "Escape") fs = false;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if error}
  <p class="err">could not decode image</p>
{:else}
  <canvas
    bind:this={canvas}
    aria-label={alt}
    role="button"
    tabindex="0"
    title="Click to view full screen"
    onclick={() => (fs = true)}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fs = true;
      }
    }}
  ></canvas>
{/if}

{#if fs}
  <div class="overlay" onclick={() => (fs = false)} role="presentation">
    <img class="full" {src} {alt} />
    <span class="esc">Esc to close</span>
  </div>
{/if}

<style>
  canvas {
    display: block;
    max-width: 100%;
    height: auto;
    image-rendering: pixelated;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    cursor: zoom-in;
  }
  .err {
    color: #ff4136;
  }
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.92);
    cursor: zoom-out;
  }
  .full {
    max-width: 100vw;
    max-height: 100vh;
    object-fit: contain;
    image-rendering: pixelated;
  }
  .esc {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    color: var(--muted);
    font-size: 12px;
    font-family: var(--font-mono-retro, ui-monospace, monospace);
    pointer-events: none;
  }
</style>

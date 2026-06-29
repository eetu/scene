<script lang="ts">
  // Canvas image viewer. Draws a (browser-native) image to a canvas at its native
  // resolution with nearest-neighbour scaling, so pixel art stays crisp. Built on
  // canvas (not <img>) so it can later render raw decoded pixels from the
  // transcoder / a client-side LBM/PCX decoder. Clicking the image goes full
  // screen: true OS fullscreen via the Fullscreen API where supported, else a
  // fixed viewport overlay (iOS Safari blocks element fullscreen). Either way the
  // image scales up to fill the screen (aspect-preserved, still crisp); Esc or a
  // click closes it.
  import { tick } from "svelte";

  let { src, alt = "" }: { src: string; alt?: string } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let overlay = $state<HTMLDivElement | null>(null);
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

  // Leaving OS fullscreen by any means (Esc / F11 / system gesture) tears the
  // overlay down too, so the two stay in sync.
  $effect(() => {
    const sync = () => {
      if (fs && !document.fullscreenElement) fs = false;
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  });

  async function openFs() {
    fs = true;
    await tick(); // let the overlay mount before requesting fullscreen on it
    try {
      // Throws / is absent on iOS Safari (no element fullscreen) → fall through to
      // the fixed overlay, which already fills the viewport.
      await overlay?.requestFullscreen();
    } catch {
      /* unsupported or denied — overlay covers the viewport instead */
    }
  }

  function closeFs() {
    if (document.fullscreenElement) void document.exitFullscreen();
    fs = false;
  }

  function onKey(e: KeyboardEvent) {
    // In OS fullscreen the browser handles Esc itself (→ the sync effect closes
    // the overlay); only the fallback-overlay case needs handling here.
    if (fs && e.key === "Escape" && !document.fullscreenElement) closeFs();
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
    onclick={openFs}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void openFs();
      }
    }}
  ></canvas>
{/if}

{#if fs}
  <div bind:this={overlay} class="overlay" onclick={closeFs} role="presentation">
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
    background: #000;
    cursor: zoom-out;
  }
  .full {
    display: block;
    width: 100%;
    height: 100%;
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

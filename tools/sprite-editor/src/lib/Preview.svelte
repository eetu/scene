<script lang="ts">
  // The preview: the sprite actually animating, at a size you can judge.
  //
  // Highlighting a cell in the frame strip tells you which frame is up; it does
  // not tell you whether the wheel looks like it is turning or whether the sign
  // flickers or strobes. That is the whole reason a multi-frame sprite exists,
  // so it gets its own window — and it owns the play head, which the strip then
  // follows, so the two can never disagree.
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import SkipBack from "@lucide/svelte/icons/skip-back";
  import { cellColour } from "@scene/player/sprite-file";

  import { editor } from "./editor.svelte";
  import type { Backdrop } from "./viewport.svelte";

  let { backdrop = "checker" as Backdrop }: { backdrop?: Backdrop } = $props();

  let canvas: HTMLCanvasElement | null = $state(null);
  let paneW = $state(0);
  /** "fit", or a whole zoom the user pinned. */
  let zoomMode = $state<"fit" | number>("fit");

  const sprite = $derived(editor.sprite);
  const frames = $derived(sprite.frames);
  const animated = $derived(frames.length > 1);

  // The play head. One interval, here, because this component is the reason it
  // exists; the strip reads editor.playhead.
  $effect(() => {
    if (!editor.playing || !animated) return;
    const id = setInterval(
      () => (editor.playhead = (editor.playhead + 1) % editor.sprite.frames.length),
      1000 / Math.max(1, editor.fps),
    );
    return () => clearInterval(id);
  });

  // Stopped, the preview shows the frame being edited — so it doubles as a
  // clean look at the current frame without the grid and the cursor over it.
  const shown = $derived(editor.playing ? editor.playhead % frames.length : editor.frame);

  /** Height budget inside the stage box, in pixels — see `.stage` below. */
  const STAGE_H = 88;

  // Fit both ways, so a 5×5 spoke fills the box instead of sitting in the middle
  // of it at ×8 while a 72×18 car is still bounded by the panel's width.
  const zoom = $derived(
    zoomMode === "fit"
      ? Math.max(
          1,
          Math.min(
            16,
            Math.floor(
              Math.min((paneW - 12) / Math.max(1, sprite.w), STAGE_H / Math.max(1, sprite.h)),
            ),
          ),
        )
      : zoomMode,
  );

  $effect(() => {
    const el = canvas;
    const rows = frames[shown];
    if (!el || !rows) return;
    el.width = sprite.w;
    el.height = sprite.h;
    const g = el.getContext("2d");
    if (!g) return;
    const tint = editor.tint;
    g.clearRect(0, 0, el.width, el.height);
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const colour = cellColour(sprite, row[x], tint);
        if (!colour) continue;
        g.fillStyle = colour;
        g.fillRect(x, y, 1, 1);
      }
    }
  });

  function rewind() {
    editor.playhead = 0;
    if (!editor.playing) editor.frame = 0;
  }
</script>

<section bind:clientWidth={paneW}>
  <header>
    <h2>Preview</h2>
    <div class="acts">
      <button onclick={rewind} title="Back to the first frame" aria-label="Rewind">
        <SkipBack size={14} />
      </button>
      <button
        class:on={editor.playing}
        onclick={() => (editor.playing = !editor.playing)}
        disabled={!animated}
        title={animated ? (editor.playing ? "Stop" : "Play") : "A single frame has nothing to play"}
        aria-label={editor.playing ? "Stop" : "Play"}
      >
        {#if editor.playing}<Pause size={14} />{:else}<Play size={14} />{/if}
      </button>
    </div>
  </header>

  <div class="stage" data-bg={backdrop}>
    <canvas
      bind:this={canvas}
      data-testid="preview"
      style:width={`${sprite.w * zoom}px`}
      style:height={`${sprite.h * zoom}px`}
    ></canvas>
  </div>

  <div class="controls">
    <label>
      <span>fps</span>
      <input type="range" min="1" max="30" bind:value={editor.fps} disabled={!animated} />
      <output>{editor.fps}</output>
    </label>
    <div class="zooms">
      <button class:on={zoomMode === "fit"} onclick={() => (zoomMode = "fit")}>Fit</button>
      {#each [1, 2, 4, 8] as z (z)}
        <button class:on={zoomMode === z} onclick={() => (zoomMode = z)}>×{z}</button>
      {/each}
    </div>
    <p class="read">
      {#if animated}
        frame {shown + 1}/{frames.length} · ×{zoom}
      {:else}
        single frame · ×{zoom}
      {/if}
    </p>
  </div>
</section>

<style>
  section {
    display: grid;
    gap: 0.35rem;
    align-content: start;
    min-width: 0;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--halo-text-muted);
  }
  .acts {
    display: flex;
    gap: 0.2rem;
  }
  .stage {
    display: grid;
    place-items: center;
    /* A fixed box: the preview must not resize as the frames play, or a sprite
       with a tall frame makes the whole panel jump. */
    min-height: 6rem;
    padding: 0.4rem;
    border: 1px solid var(--halo-border);
    border-radius: var(--halo-radius);
    overflow: hidden;
    background-image:
      linear-gradient(45deg, #2a2a2a 25%, transparent 25%),
      linear-gradient(-45deg, #2a2a2a 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #2a2a2a 75%),
      linear-gradient(-45deg, transparent 75%, #2a2a2a 75%);
    background-size: 10px 10px;
    background-position:
      0 0,
      0 5px,
      5px -5px,
      -5px 0;
    background-color: #1e1e1e;
  }
  .stage[data-bg="night"] {
    background-image: none;
    background-color: #0b0714;
  }
  .stage[data-bg="dark"] {
    background-image: none;
    background-color: #141414;
  }
  .stage[data-bg="light"] {
    background-image: none;
    background-color: #e9e9ee;
  }
  canvas {
    display: block;
    image-rendering: pixelated;
    max-width: 100%;
  }
  .controls {
    display: grid;
    gap: 0.3rem;
  }
  label {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--halo-text-muted);
  }
  output {
    font-variant-numeric: tabular-nums;
    min-width: 1.2rem;
    text-align: right;
  }
  input[type="range"] {
    width: 100%;
    accent-color: var(--halo-accent);
  }
  .zooms {
    display: flex;
    gap: 0.15rem;
  }
  .zooms button {
    flex: 1;
    font-size: 0.7rem;
    padding: 0.15rem 0;
  }
  button {
    display: grid;
    place-items: center;
    background: var(--halo-bg-main);
    color: var(--halo-text-main);
    border: 1px solid var(--halo-border);
    border-radius: 4px;
    cursor: pointer;
    min-width: 1.6rem;
    min-height: 1.5rem;
    padding: 0;
    font: inherit;
  }
  button.on {
    border-color: var(--halo-accent);
    color: var(--halo-accent);
    background: var(--halo-accent-soft);
  }
  button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .read {
    margin: 0;
    font-size: 0.7rem;
    color: var(--halo-text-light);
    font-variant-numeric: tabular-nums;
  }
</style>

<script lang="ts">
  // The frame strip: thumbnails, add/duplicate/remove/reorder, and a preview
  // that plays the animation at a rate you set. The strip is where a
  // multi-frame sprite is judged — the spokes and the sign flicker only make
  // sense in motion.
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Copy from "@lucide/svelte/icons/copy";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash from "@lucide/svelte/icons/trash-2";

  import { addFrame, duplicateFrame, editor, moveFrame, removeFrame } from "./editor.svelte";
  import FrameThumb from "./FrameThumb.svelte";

  const frames = $derived(editor.sprite.frames);

  // The play head belongs to the preview — the strip only follows it, so the
  // two can never be showing different frames.
  const playFrame = $derived(editor.playing ? editor.playhead % frames.length : editor.frame);
</script>

<section>
  <header>
    <h2>Frames</h2>
    <div class="acts">
      <button onclick={addFrame} title="Add a blank frame after this one" aria-label="Add frame">
        <Plus size={14} />
      </button>
      <button onclick={duplicateFrame} title="Duplicate this frame" aria-label="Duplicate frame">
        <Copy size={14} />
      </button>
      <button
        onclick={removeFrame}
        disabled={frames.length < 2}
        title="Remove this frame"
        aria-label="Remove frame"
      >
        <Trash size={14} />
      </button>
    </div>
  </header>

  <ol>
    {#each frames as _, i (i)}
      <li class:on={i === editor.frame} class:playing={editor.playing && i === playFrame}>
        <button class="pick" onclick={() => (editor.frame = i)} title={`Frame ${i + 1}`}>
          <FrameThumb sprite={editor.sprite} index={i} />
        </button>
        <!-- Reorder and number on one fixed row, so selecting a frame cannot
             change the strip's height and shuffle the others sideways. -->
        <div class="foot">
          <button onclick={() => moveFrame(i, i - 1)} disabled={i === 0} aria-label="Move earlier">
            <ChevronLeft size={12} />
          </button>
          <span>{i + 1}</span>
          <button
            onclick={() => moveFrame(i, i + 1)}
            disabled={i === frames.length - 1}
            aria-label="Move later"
          >
            <ChevronRight size={12} />
          </button>
        </div>
      </li>
    {/each}
  </ol>

  <label class="onion">
    <input type="checkbox" bind:checked={editor.onion} />
    Onion skin
  </label>
</section>

<style>
  section {
    display: grid;
    gap: 0.4rem;
    align-content: start;
    min-width: 0;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
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
    gap: 0.15rem;
    align-items: center;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    /* Brick-laid, not a scrolling row: a strip that runs off the edge hides the
       frames it is holding, and a sprite's frames are meant to be compared. As
       many as fit per row, then wrap. */
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(3.1rem, 1fr));
    gap: 0.3rem;
    align-items: start;
  }
  li {
    display: grid;
    gap: 2px;
    padding: 0.2rem;
    border: 1px solid transparent;
    border-radius: 4px;
    /* Reserve the selected border on every cell so picking one doesn't nudge
       its neighbours — the stagger that made the strip look broken. */
    box-sizing: border-box;
    min-width: 0;
  }
  li.on {
    border-color: var(--halo-accent);
  }
  li.playing {
    background: var(--halo-accent-soft);
  }
  .pick {
    display: grid;
    place-items: center;
    width: 100%;
    height: 2.4rem;
    background: #14141c;
    border: 1px solid var(--halo-border);
    border-radius: 3px;
    padding: 0.2rem;
    cursor: pointer;
  }
  .foot {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 2px;
    font-size: 0.68rem;
    color: var(--halo-text-muted);
  }
  .foot span {
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  button {
    display: grid;
    place-items: center;
    background: var(--halo-bg-main);
    color: var(--halo-text-main);
    border: 1px solid var(--halo-border);
    border-radius: 4px;
    cursor: pointer;
    min-width: 1.5rem;
    min-height: 1.5rem;
    padding: 0;
  }
  .foot button {
    min-width: 0;
    min-height: 1.1rem;
    border-color: transparent;
    background: none;
    color: var(--halo-text-muted);
  }
  .foot button:hover:not(:disabled) {
    color: var(--halo-text-main);
    border-color: var(--halo-border);
  }
  button:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .onion {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: var(--halo-text-muted);
  }
</style>

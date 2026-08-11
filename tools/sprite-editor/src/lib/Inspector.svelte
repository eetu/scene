<script lang="ts">
  // Name, size and zoom. Size is committed on Apply rather than per keystroke:
  // typing "8" on the way to "80" would crop the sprite to eight pixels and
  // there would be nothing left to widen.
  import { editor, rename, resize } from "./editor.svelte";
  import { cell, fit } from "./viewport.svelte";

  let w = $state(editor.sprite.w);
  let h = $state(editor.sprite.h);
  let name = $state(editor.sprite.name);
  let centred = $state(false);

  // Follow the document when it is loaded or resized from elsewhere (undo).
  $effect(() => {
    w = editor.sprite.w;
    h = editor.sprite.h;
    name = editor.sprite.name;
  });

  const changed = $derived(w !== editor.sprite.w || h !== editor.sprite.h);

  // The filename follows the sprite's name, and saving MOVES the file. The sheet
  // is globbed from the folder, so that is all a rename needs — unless the scene
  // asks for this sprite by name (SIGN_NAMES, CROWN_NAMES, "car", "spoke"), in
  // which case that constant has to follow. Say which, rather than leaving it to
  // be discovered as a hole in the picture.
  const willWrite = $derived(`${editor.sprite.name}.json`);
  const renamed = $derived(!!editor.file && editor.file !== willWrite);
</script>

<section>
  <h2>Sprite</h2>

  <label>
    <span>Name</span>
    <input
      value={name}
      spellcheck="false"
      onchange={(e) => rename((e.target as HTMLInputElement).value.trim())}
    />
  </label>
  {#if renamed}
    <p class="warn">
      Save moves <code>{editor.file}</code> → <code>{willWrite}</code>. The sheet is read from the
      folder, so nothing needs importing — but if the scene names this sprite (<code
        >SIGN_NAMES</code
      >, <code>CROWN_NAMES</code>, <code>car</code>, <code>spoke</code>), update it in
      <code>drive-sprites.ts</code>.
    </p>
  {/if}

  <div class="dim">
    <label>
      <span>Width</span>
      <input type="number" min="1" max="512" bind:value={w} />
      <input type="range" min="1" max="128" bind:value={w} />
    </label>
    <label>
      <span>Height</span>
      <input type="number" min="1" max="512" bind:value={h} />
      <input type="range" min="1" max="128" bind:value={h} />
    </label>
    <label class="row">
      <input type="checkbox" bind:checked={centred} />
      <span>Grow from the centre</span>
    </label>
    <button disabled={!changed} onclick={() => resize(w, h, centred)}>
      {changed ? `Resize to ${w}×${h}` : "Resize"}
    </button>
    <p class="note">Crops or pads — pixel art has no meaningful resample.</p>
  </div>

  <div class="row">
    <button onclick={() => fit(editor.sprite.w, editor.sprite.h)} title="Fit to view (0)">
      Fit ×{cell()}
    </button>
  </div>

  <label class="row">
    <input type="checkbox" bind:checked={editor.grid} />
    <span>Pixel grid</span>
  </label>
</section>

<style>
  section {
    display: grid;
    gap: 0.5rem;
    align-content: start;
  }
  h2 {
    margin: 0;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--halo-text-muted);
  }
  label {
    display: grid;
    gap: 0.2rem;
    font-size: 0.8rem;
    color: var(--halo-text-muted);
  }
  label.row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .dim {
    display: grid;
    gap: 0.4rem;
    padding: 0.5rem;
    border: 1px solid var(--halo-border);
    border-radius: var(--halo-radius);
  }
  input[type="number"],
  input:not([type]) {
    background: var(--halo-bg-main);
    color: var(--halo-text-main);
    border: 1px solid var(--halo-border);
    border-radius: 4px;
    padding: 0.25rem 0.4rem;
    font: inherit;
  }
  input[type="range"] {
    width: 100%;
    accent-color: var(--halo-accent);
  }
  button {
    background: var(--halo-bg-main);
    color: var(--halo-text-main);
    border: 1px solid var(--halo-border);
    border-radius: 4px;
    padding: 0.3rem;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .note {
    margin: 0;
    font-size: 0.7rem;
    color: var(--halo-text-light);
  }
  .warn {
    margin: 0;
    font-size: 0.7rem;
    line-height: 1.45;
    color: var(--halo-text-muted);
    border-left: 2px solid var(--halo-accent);
    padding-left: 0.4rem;
  }
  code {
    font-family: ui-monospace, monospace;
    font-size: 0.68rem;
    color: var(--halo-text-main);
  }
</style>

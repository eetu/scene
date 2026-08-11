<script lang="ts">
  // The palette: pick the ink, edit a colour, move a colour to a different
  // character, and drop one. Each swatch shows its character, because the
  // character is what ends up in the file and in the diff.
  import { cellColour, TRANSPARENT, unusedChars } from "@scene/player/sprite-file";

  import {
    addColour,
    addTint,
    editor,
    makeTinted,
    removeColour,
    removeTint,
    renameChar,
    setColour,
    setTint,
  } from "./editor.svelte";

  const entries = $derived(Object.entries(editor.sprite.palette));
  const unused = $derived(new Set(unusedChars(editor.sprite)));
  const tints = $derived(editor.sprite.tints ?? []);
  /** Does any frame actually use the neon characters? */
  const usesNeon = $derived(editor.sprite.frames.some((f) => f.some((row) => /[Nn]/.test(row))));

  let renaming = $state<string | null>(null);

  function commitRename(from: string, e: Event) {
    const to = (e.target as HTMLInputElement).value.trim();
    renaming = null;
    if (to.length === 1) renameChar(from, to);
  }
</script>

<section>
  <header>
    <h2>Palette</h2>
    <button onclick={() => addColour("#ffffff")} title="Add a colour">+</button>
  </header>

  <ul>
    <li>
      <button
        class="swatch transparent"
        class:on={editor.ink === TRANSPARENT}
        onclick={() => (editor.ink = TRANSPARENT)}
        title="Transparent (.)"
        aria-label="Transparent"
      ></button>
      <span class="ch">.</span>
      <span class="hex">transparent</span>
    </li>
    {#each entries as [ch, hex] (ch)}
      <li class:unused={unused.has(ch)}>
        <button
          class="swatch"
          class:on={editor.ink === ch}
          style:background={hex}
          onclick={() => (editor.ink = ch)}
          title={`Paint with ${ch}`}
          aria-label={`Colour ${ch}`}
        ></button>
        {#if renaming === ch}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="ch edit"
            maxlength="1"
            value={ch}
            autofocus
            onblur={(e) => commitRename(ch, e)}
            onkeydown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        {:else}
          <button class="ch" onclick={() => (renaming = ch)} title="Rename this character">
            {ch}
          </button>
        {/if}
        <input
          class="hex"
          type="color"
          value={hex}
          oninput={(e) => setColour(ch, (e.target as HTMLInputElement).value)}
        />
        <input
          class="hextext"
          value={hex}
          spellcheck="false"
          onchange={(e) => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) setColour(ch, v);
          }}
        />
        <button class="drop" onclick={() => removeColour(ch)} title="Remove (erases its pixels)">
          ×
        </button>
      </li>
    {/each}
  </ul>

  <!-- Neon. These two characters are not palette entries: the renderer bakes
       the sprite once per tint and colours them from that, which is how one
       sign sprite is magenta on one building and cyan on the next. They still
       have to be paintable, so they get swatches like any other ink. -->
  {#if tints.length}
    <h2 class="sub">Neon</h2>
    <ul>
      {#each [["N", "bright"], ["n", "dim"]] as [ch, label] (ch)}
        <li>
          <button
            class="swatch"
            class:on={editor.ink === ch}
            style:background={cellColour(editor.sprite, ch, editor.tint) ?? "#000"}
            onclick={() => (editor.ink = ch)}
            title={`Paint the ${label} half of the tube (${ch})`}
            aria-label={`Neon ${label}`}
          ></button>
          <span class="ch">{ch}</span>
          <span class="hex neon">{label}</span>
        </li>
      {/each}
    </ul>

    <h2 class="sub">
      Tints
      <button class="mini" onclick={() => addTint()} title="Add a tint" aria-label="Add tint">
        +
      </button>
    </h2>
    <ul>
      {#each tints as hex, i (i)}
        <li>
          <button
            class="swatch"
            class:on={editor.tint === i}
            style:background={hex}
            onclick={() => (editor.tint = i)}
            title="Show the sprite in this tint"
            aria-label={`Preview tint ${i + 1}`}
          ></button>
          <span class="ch">{i + 1}</span>
          <input
            class="hex"
            type="color"
            value={hex}
            oninput={(e) => setTint(i, (e.target as HTMLInputElement).value)}
          />
          <input
            class="hextext"
            value={hex}
            spellcheck="false"
            onchange={(e) => {
              const v = (e.target as HTMLInputElement).value.trim();
              if (/^#[0-9a-fA-F]{6}$/.test(v)) setTint(i, v);
            }}
          />
          <button class="drop" onclick={() => removeTint(i)} title="Remove this tint">×</button>
        </li>
      {/each}
    </ul>
    <p class="note">Baked once per tint; the canvas shows tint {editor.tint + 1}.</p>
  {:else}
    <p class="note">
      {#if usesNeon}
        This sprite paints <code>N</code>/<code>n</code> but names no tints — they will bake magenta.
      {:else}
        Neon cells (<code>N</code>/<code>n</code>) take their colour at bake time, so one sprite can
        be magenta on one building and cyan on the next.
      {/if}
      <button class="wide" onclick={makeTinted}>Make tintable</button>
    </p>
  {/if}
  {#if unused.size}
    <p class="note">{unused.size} unused {unused.size === 1 ? "colour" : "colours"} (dimmed).</p>
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: 0.4rem;
    align-content: start;
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
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  li {
    display: grid;
    grid-template-columns: 1.4rem 1.2rem 1.6rem 1fr 1.2rem;
    gap: 0.3rem;
    align-items: center;
  }
  li.unused {
    opacity: 0.45;
  }
  .swatch {
    width: 1.4rem;
    height: 1.4rem;
    border: 1px solid var(--halo-border);
    border-radius: 3px;
    padding: 0;
    cursor: pointer;
  }
  .swatch.on {
    outline: 2px solid var(--halo-accent);
    outline-offset: 1px;
  }
  .transparent {
    background:
      linear-gradient(45deg, #333 25%, transparent 25%),
      linear-gradient(-45deg, #333 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #333 75%),
      linear-gradient(-45deg, transparent 75%, #333 75%);
    background-size: 8px 8px;
    background-position:
      0 0,
      0 4px,
      4px -4px,
      -4px 0;
  }
  .ch {
    font-family: ui-monospace, monospace;
    text-align: center;
    background: none;
    border: 0;
    color: var(--halo-text-main);
    cursor: pointer;
    padding: 0;
  }
  .ch.edit {
    width: 1.2rem;
    border: 1px solid var(--halo-accent);
    border-radius: 2px;
    background: var(--halo-bg-main);
  }
  input[type="color"] {
    width: 1.6rem;
    height: 1.4rem;
    padding: 0;
    border: 1px solid var(--halo-border);
    background: none;
    border-radius: 3px;
  }
  .hextext {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    background: var(--halo-bg-main);
    color: var(--halo-text-main);
    border: 1px solid var(--halo-border);
    border-radius: 3px;
    padding: 0.15rem 0.3rem;
    min-width: 0;
  }
  .drop {
    background: none;
    border: 0;
    color: var(--halo-text-muted);
    cursor: pointer;
  }
  .drop:hover {
    color: var(--halo-error);
  }
  button {
    background: var(--halo-bg-main);
    color: var(--halo-text-main);
    border: 1px solid var(--halo-border);
    border-radius: 4px;
    cursor: pointer;
  }
  header button {
    width: 1.5rem;
    height: 1.5rem;
    line-height: 1;
  }
  .note {
    margin: 0;
    font-size: 0.72rem;
    color: var(--halo-text-muted);
    line-height: 1.45;
  }
  .sub {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0.35rem 0 0;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--halo-text-muted);
  }
  .mini {
    width: 1.2rem;
    height: 1.2rem;
    line-height: 1;
    padding: 0;
  }
  .wide {
    display: block;
    width: 100%;
    margin-top: 0.35rem;
    padding: 0.25rem;
  }
  .neon {
    color: var(--halo-text-light);
    font-size: 0.72rem;
    align-self: center;
  }
  code {
    font-family: ui-monospace, monospace;
  }
</style>

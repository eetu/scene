<script lang="ts">
  // The sprite editor: a dev tool for the character-grid sprites the scene's
  // visualisers draw from (packages/player/src/sprites/*.json).
  //
  // Not a shipped app — it is the other half of the sprite format. Point it at
  // the repo's sprites folder once and Save writes the file the visualiser
  // imports, so the loop is draw → save → look at the running scene.
  import "@scene/design/halo.css";

  import { cloneSprite, validateSprite } from "@scene/player/sprite-file";
  import { onMount } from "svelte";

  import Canvas from "./lib/Canvas.svelte";
  import {
    clearSelection,
    copySelection,
    cutSelection,
    deleteSelection,
    editor,
    hasSelection,
    history,
    loadSprite,
    newSprite,
    nudgeSelection,
    pasteClipboard,
    redoEdit,
    selectAll,
    type Tool,
    TOOLS,
    undoEdit,
  } from "./lib/editor.svelte";
  import {
    canWriteToDisk,
    downloadSprite,
    ensureWritable,
    type Entry,
    type Folder,
    isWritable,
    listSprites,
    pickFolder,
    readDroppedFiles,
    restoreFolder,
    saveSprite,
  } from "./lib/files";
  import Frames from "./lib/Frames.svelte";
  import Inspector from "./lib/Inspector.svelte";
  import Palette from "./lib/Palette.svelte";
  import { clearDraft, recallDraft, recallFile, rememberDraft, rememberFile } from "./lib/persist";
  import Preview from "./lib/Preview.svelte";
  import ToolRail from "./lib/ToolRail.svelte";
  import { type Backdrop, BACKDROPS, fit, zoomIn, zoomOut } from "./lib/viewport.svelte";

  let backdrop = $state<Backdrop>("checker");
  let folder = $state<Folder | null>(null);
  let entries = $state<Entry[]>([]);
  let problems = $state<{ file: string; errors: string[] }[]>([]);
  let dropping = $state(false);
  /** A remembered folder whose permission the browser dropped: it needs one
   *  click to come back, because requestPermission demands a user gesture. */
  let needsReconnect = $state(false);

  const say = (msg: string) => (editor.status = msg);

  async function openFolder() {
    try {
      const picked = await pickFolder();
      if (!picked) return;
      folder = picked;
      needsReconnect = false;
      await refresh();
      say(`${picked.name}: ${entries.length} sprites`);
    } catch {
      say("folder not opened");
    }
  }

  async function refresh() {
    if (!folder) return;
    const res = await listSprites(folder);
    entries = res.entries;
    problems = res.problems;
  }

  async function save() {
    const errors = validateSprite(editor.sprite);
    if (errors.length) return say(`not saved — ${errors[0]}`);
    if (folder && (await ensureWritable(folder))) {
      // A rename MOVES: the new file is written, then the old one removed. Two
      // files for one sprite leaves the folder lying about which is current.
      const { file, removed } = await saveSprite(folder, editor.sprite, editor.file);
      editor.file = file;
      editor.dirty = false;
      needsReconnect = false;
      // Remembered so the next save goes to the same place with no dialog —
      // including after a hot reload, which is most of them.
      rememberFile(file);
      clearDraft();
      await refresh();
      if (removed) return say(`renamed ${removed} → ${file}`);
      return say(`saved ${file}`);
    }
    downloadSprite(editor.sprite);
    editor.dirty = false;
    say(`downloaded ${editor.sprite.name}.json`);
  }

  function open(entry: Entry) {
    if (editor.dirty && !confirm(`Discard unsaved changes to ${editor.sprite.name}?`)) return;
    // cloneSprite, not structuredClone: `entries` is $state, so everything in
    // it is a deep proxy, and structuredClone refuses a proxy outright
    // (DataCloneError). Copying field by field reads straight through it.
    // Cloned at all so editing the open sprite doesn't mutate the list entry —
    // the list is what "discard changes" would otherwise have to restore from.
    loadSprite(cloneSprite(entry.sprite), entry.file);
    rememberFile(entry.file);
    clearDraft();
    say(`opened ${entry.file}`);
  }

  async function drop(e: DragEvent) {
    dropping = false;
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    const res = await readDroppedFiles(files);
    problems = res.problems;
    if (res.entries[0]) {
      loadSprite(res.entries[0].sprite, res.entries[0].file);
      say(`opened ${res.entries[0].file}`);
    } else say("no sprite in that drop");
  }

  function keydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
      return;
    }
    if (meta && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redoEdit();
      else undoEdit();
      return;
    }
    // The selection's clipboard is the editor's own, not the system one: what is
    // on it is a block of palette characters, which nothing outside this tool
    // would know what to do with.
    if (meta && e.key.toLowerCase() === "a") {
      e.preventDefault();
      editor.tool = "select";
      selectAll();
      return;
    }
    if (meta && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copySelection();
      return;
    }
    if (meta && e.key.toLowerCase() === "x") {
      e.preventDefault();
      cutSelection();
      return;
    }
    if (meta && e.key.toLowerCase() === "v") {
      e.preventDefault();
      editor.tool = "select";
      pasteClipboard();
      return;
    }
    if (meta) return;
    if (e.key === "Escape") {
      clearSelection();
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && hasSelection()) {
      e.preventDefault();
      deleteSelection();
      return;
    }
    const tool = TOOLS.find((x) => x.key === e.key.toLowerCase());
    if (tool) {
      editor.tool = tool.id as Tool;
      return;
    }
    // The arrows nudge a selection when there is one, and step frames when there
    // is not. A selected block is the thing you are working on at that moment,
    // and one pixel at a time is how it gets placed.
    if (hasSelection() && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 4 : 1;
      if (e.key === "ArrowLeft") nudgeSelection(-step, 0);
      if (e.key === "ArrowRight") nudgeSelection(step, 0);
      if (e.key === "ArrowUp") nudgeSelection(0, -step);
      if (e.key === "ArrowDown") nudgeSelection(0, step);
      return;
    }
    // Frame stepping on the arrows: the fastest way to check an animation lines
    // up is to flick between two frames with a thumb on one key.
    if (e.key === "ArrowLeft") editor.frame = Math.max(0, editor.frame - 1);
    if (e.key === "ArrowRight")
      editor.frame = Math.min(editor.sprite.frames.length - 1, editor.frame + 1);
    // View keys, as in nib: 0 fits, +/− step the zoom.
    if (e.key === "0") fit(editor.sprite.w, editor.sprite.h);
    if (e.key === "+" || e.key === "=" || e.key === "]") zoomIn();
    if (e.key === "-" || e.key === "_" || e.key === "[") zoomOut();
  }

  /**
   * Come back where we left off.
   *
   * The dev server reloads the page on every source edit, so "where we left
   * off" is a state this tool is in constantly. Order matters: the folder comes
   * back first (silently, if the browser kept the grant), then the file that was
   * open, and any unsaved draft wins over the saved copy of the same file.
   */
  onMount(async () => {
    const saved = await restoreFolder();
    if (saved) {
      if (await isWritable(saved)) {
        folder = saved;
        await refresh();
        const want = recallFile();
        const entry = want ? entries.find((e) => e.file === want) : null;
        if (entry) loadSprite(cloneSprite(entry.sprite), entry.file);
        say(`${saved.name}: ${entries.length} sprites`);
      } else {
        // The handle is still ours, the permission is not. One click fixes it,
        // and it has to be a click — the browser will not grant without one.
        folder = saved;
        needsReconnect = true;
        say(`${saved.name} needs one click to reconnect`);
      }
    }
    // A draft outranks whatever was just loaded: it is the newer state, and it
    // is the one nobody else has a copy of.
    const draft = recallDraft();
    if (draft) {
      loadSprite(draft.sprite, draft.file);
      editor.dirty = true;
      say("restored unsaved work");
    }
  });

  async function reconnect() {
    if (!folder) return;
    if (!(await ensureWritable(folder))) return say("permission refused");
    needsReconnect = false;
    await refresh();
    say(`${folder.name}: ${entries.length} sprites`);
  }

  // Keep a copy of unsaved work, so a reload — hot or otherwise — cannot eat a
  // drawing. Written on a timer rather than per stroke: a 72×18 sprite is a few
  // kB, but a pencil drag is hundreds of edits.
  $effect(() => {
    const sprite = editor.sprite;
    const file = editor.file;
    if (!editor.dirty) return;
    const id = setTimeout(() => rememberDraft(sprite, file), 400);
    return () => clearTimeout(id);
  });

  // A tab close with unsaved work is the one loss this tool can actually cause.
  $effect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (editor.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  });
</script>

<svelte:window onkeydown={keydown} />

<div
  class="app"
  class:dropping
  role="application"
  aria-label="Sprite editor"
  ondragover={(e) => {
    e.preventDefault();
    dropping = true;
  }}
  ondragleave={() => (dropping = false)}
  ondrop={(e) => {
    e.preventDefault();
    void drop(e);
  }}
>
  <header class="bar">
    <strong>sprite editor</strong>

    <label class="bg">
      Backdrop
      <select bind:value={backdrop} aria-label="Canvas backdrop">
        {#each BACKDROPS as b (b.id)}
          <option value={b.id}>{b.label}</option>
        {/each}
      </select>
    </label>

    <div class="acts">
      <button onclick={undoEdit} disabled={history.undo === 0} title="Undo (⌘Z)">Undo</button>
      <button onclick={redoEdit} disabled={history.redo === 0} title="Redo (⇧⌘Z)">Redo</button>
      <button onclick={() => newSprite("untitled", 16, 16)}>New</button>
      {#if needsReconnect}
        <button class="save" onclick={reconnect} title="Grant access to the remembered folder">
          Reconnect {folder?.name}
        </button>
      {:else}
        <button onclick={openFolder} title="Pick packages/player/src/sprites">
          {folder ? `Folder: ${folder.name}` : "Open folder…"}
        </button>
      {/if}
      <button class="save" onclick={save} title="Save (⌘S)">
        Save{editor.dirty ? " •" : ""}
      </button>
    </div>
  </header>

  <aside class="left">
    <section>
      <h2>Sprites</h2>
      {#if !folder}
        <p class="note">
          {#if canWriteToDisk()}
            Open <code>packages/player/src/sprites</code> to load and save in place.
          {:else}
            This browser has no file-system access: drop a <code>.json</code> here to open one, and Save
            downloads. Chrome or Edge writes in place.
          {/if}
        </p>
      {/if}
      <ul class="list">
        {#each entries as e (e.file)}
          <li>
            <button class:on={editor.file === e.file} onclick={() => open(e)}>
              {e.sprite.name}
              <small
                >{e.sprite.w}×{e.sprite.h}{e.sprite.frames.length > 1
                  ? ` ·${e.sprite.frames.length}f`
                  : ""}</small
              >
            </button>
          </li>
        {/each}
      </ul>
      {#each problems as p (p.file)}
        <p class="bad">{p.file}: {p.errors[0]}</p>
      {/each}
    </section>
    <Inspector />
  </aside>

  <ToolRail />

  <main><Canvas {backdrop} /></main>

  <aside class="right">
    <Palette />
    <Preview {backdrop} />
    <Frames />
  </aside>

  <footer class="status">{editor.status}</footer>
</div>

<style>
  .app {
    height: 100dvh;
    display: grid;
    grid-template-columns: 15rem auto 1fr 16rem;
    grid-template-rows: auto 1fr auto;
    grid-template-areas:
      "bar bar bar bar"
      "left rail main right"
      "status status status status";
    background: var(--halo-body);
    color: var(--halo-text-main);
    font-family: var(--halo-font-body);
  }
  .app.dropping {
    outline: 2px dashed var(--halo-accent);
    outline-offset: -6px;
  }
  .bar {
    grid-area: bar;
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--halo-border);
    background: var(--halo-bg-light);
  }
  .bar strong {
    letter-spacing: 0.04em;
  }
  .acts {
    display: flex;
    gap: 0.25rem;
  }
  .bg {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.78rem;
    color: var(--halo-text-muted);
  }
  .bg select {
    background: var(--halo-bg-main);
    color: var(--halo-text-main);
    border: 1px solid var(--halo-border);
    border-radius: var(--halo-radius-pill);
    padding: 0.2rem 0.3rem;
    font: inherit;
    font-size: 0.78rem;
  }
  .acts {
    margin-left: auto;
  }
  aside {
    padding: 0.75rem;
    display: grid;
    gap: 1rem;
    align-content: start;
    overflow-y: auto;
    /* Without this the panel's content sets its minimum height, the middle grid
       row grows past the viewport, and the bottom of the rail — the frame strip —
       goes off the screen with no scrollbar to bring it back. A grid item has to
       be allowed to be shorter than its contents before `auto` can scroll. */
    min-height: 0;
    background: var(--halo-bg-light);
  }
  .left {
    grid-area: left;
    border-right: 1px solid var(--halo-border);
  }
  .right {
    grid-area: right;
    border-left: 1px solid var(--halo-border);
  }
  main {
    grid-area: main;
    display: grid;
    /* The canvas pane owns its own panning, so nothing here scrolls. */
    overflow: hidden;
    min-width: 0;
  }
  .status {
    grid-area: status;
    padding: 0.35rem 0.75rem;
    border-top: 1px solid var(--halo-border);
    background: var(--halo-bg-light);
    color: var(--halo-text-muted);
    font-size: 0.78rem;
    min-height: 1.6rem;
  }
  h2 {
    margin: 0 0 0.4rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--halo-text-muted);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  .list button {
    width: 100%;
    text-align: left;
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .list small {
    color: var(--halo-text-light);
  }
  button {
    background: var(--halo-bg-main);
    color: var(--halo-text-main);
    border: 1px solid var(--halo-border);
    border-radius: var(--halo-radius-pill);
    padding: 0.3rem 0.55rem;
    font: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--halo-accent);
  }
  button.on {
    border-color: var(--halo-accent);
    background: var(--halo-accent-soft);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .save {
    border-color: var(--halo-accent);
  }
  .note {
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    color: var(--halo-text-muted);
    line-height: 1.4;
  }
  .bad {
    margin: 0.25rem 0 0;
    font-size: 0.72rem;
    color: var(--halo-error);
  }
  code {
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
  }
</style>

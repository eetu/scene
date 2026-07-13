<script lang="ts">
  // Backend-less intake: the whole-window drag-drop target, the hidden file /
  // folder pickers, and the empty-state hero. Only mounted in the STANDALONE
  // build; adds dropped/picked modules (and zips) to the browser-local library.
  import { FolderOpen, MousePointerClick, Music } from "@lucide/svelte";

  import { library } from "$lib/library.svelte";
  import { ACCEPT } from "$lib/standalone";
  import { registerFiles, registerFolder } from "$lib/standalone/intake";
  import { addFiles, addFsEntries } from "$lib/standalone/store.svelte";

  let { onToast }: { onToast: (msg: string, kind?: "ok" | "err") => void } = $props();

  let dragging = $state(false);
  let busy = $state(false);
  let depth = 0; // dragenter/leave fire per child; count to know when we truly left
  let filesEl = $state<HTMLInputElement>();
  let folderEl = $state<HTMLInputElement>();

  const empty = $derived(library.tracks.length === 0);

  // Register the pickers with the shared controller (so the header "add" button
  // can open them too), and set the non-standard folder attribute as a property.
  $effect(() => {
    registerFiles(filesEl ?? null);
    return () => registerFiles(null);
  });
  $effect(() => {
    if (folderEl) folderEl.webkitdirectory = true;
    registerFolder(folderEl ?? null);
    return () => registerFolder(null);
  });

  async function take(add: () => Promise<number>) {
    if (busy) return;
    busy = true;
    try {
      const n = await add();
      onToast(
        n > 0 ? `Added ${n} module${n === 1 ? "" : "s"}` : "No playable modules found",
        n > 0 ? "ok" : "err",
      );
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Couldn't read those files", "err");
    } finally {
      busy = false;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    depth = 0;
    // Prefer the entries API so dropped *folders* recurse (DataTransfer.files
    // skips folder contents). Capture entries synchronously — the DataTransfer is
    // invalid once the event returns. Fall back to the flat file list.
    const items = e.dataTransfer?.items;
    const entries = items
      ? Array.from(items)
          .map((it) => (it.kind === "file" ? it.webkitGetAsEntry?.() : null))
          .filter((en): en is FileSystemEntry => !!en)
      : [];
    if (entries.length) void take(() => addFsEntries(entries));
    else if (e.dataTransfer?.files?.length) {
      const files = e.dataTransfer.files;
      void take(() => addFiles(files));
    }
  }
  function onDragEnter(e: DragEvent) {
    if (e.dataTransfer?.types.includes("Files")) {
      depth++;
      dragging = true;
    }
  }
  function onDragLeave() {
    if (--depth <= 0) dragging = false;
  }
  function onInput(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const files = el.files;
    if (files?.length) void take(() => addFiles(files));
    el.value = ""; // allow re-picking the same file
  }
</script>

<svelte:window
  ondragenter={onDragEnter}
  ondragover={(e) => e.preventDefault()}
  ondragleave={onDragLeave}
  ondrop={onDrop}
/>

<!-- Hidden pickers, opened by the hero buttons or the header add button. -->
<input bind:this={filesEl} class="hidden" type="file" multiple accept={ACCEPT} onchange={onInput} />
<input bind:this={folderEl} class="hidden" type="file" onchange={onInput} />

{#if empty}
  <div class="hero">
    <div class="card">
      <Music size={40} strokeWidth={1.5} />
      <h2>Drop a module to play it</h2>
      <p>
        MOD · XM · S3M · IT and the legacy zoo — or a <code>.zip</code> of them. Nothing is uploaded;
        everything runs and stays in your browser.
      </p>
      <div class="acts">
        <button class="ok" onclick={() => filesEl?.click()} disabled={busy}>
          <MousePointerClick size={15} /> Choose files
        </button>
        <button onclick={() => folderEl?.click()} disabled={busy}>
          <FolderOpen size={15} /> Choose folder
        </button>
      </div>
    </div>
  </div>
{/if}

{#if dragging}
  <div class="scrim"><div class="scrim-inner">Drop to add modules</div></div>
{/if}

<style>
  .hidden {
    display: none;
  }
  /* Empty-state hero, centred over the (empty) list region. */
  .hero {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    pointer-events: none;
  }
  .card {
    pointer-events: auto;
    max-width: 460px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 32px 28px;
    border: 1px dashed var(--border);
    border-radius: 12px;
    background: var(--panel);
    color: var(--muted);
  }
  .card h2 {
    margin: 4px 0 0;
    font-size: 18px;
    color: var(--text);
  }
  .card p {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
  }
  .card code {
    font-family: var(--font-mono-retro, ui-monospace, monospace);
    color: var(--text);
  }
  .acts {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }
  .acts button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
  }
  /* Full-window drop scrim while dragging files over the page. */
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--bg) 72%, transparent);
    backdrop-filter: blur(2px);
    pointer-events: none;
  }
  .scrim-inner {
    padding: 24px 36px;
    border: 2px dashed var(--accent);
    border-radius: 12px;
    color: var(--accent);
    font-size: 18px;
    font-family: var(--font-retro);
  }
</style>

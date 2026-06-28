<script lang="ts">
  // Renders an NFO/DIZ/TXT file. The backend decodes CP437 → UTF-8; we just show
  // it monospaced in the Amiga Topaz font so box-drawing art lines up.
  import { api } from "./api";

  let { hash, filename }: { hash: string; filename?: string } = $props();

  let text = $state("");
  let loading = $state(true);

  $effect(() => {
    const h = hash;
    loading = true;
    text = "";
    api
      .text(h)
      .then((t) => {
        if (h === hash) {
          text = t;
          loading = false;
        }
      })
      .catch(() => {
        text = "(failed to load)";
        loading = false;
      });
  });
</script>

{#if filename}<p class="name">{filename}</p>{/if}
{#if loading}
  <p class="muted">loading…</p>
{:else}
  <pre class="nfo">{text}</pre>
{/if}

<style>
  .name {
    margin: 0 0 6px;
    color: var(--muted);
    font-size: 12px;
  }
  .nfo {
    margin: 0;
    padding: 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    /* CP437 VGA font at its native 16px cell with line-height 1 → box-drawing
		   glyphs tile both horizontally and vertically. */
    font-family: var(--font-dos);
    font-size: 16px;
    line-height: 1;
    letter-spacing: 0;
    overflow: auto;
    max-height: 70vh;
    white-space: pre;
  }
  .muted {
    color: var(--muted);
  }
</style>

<script lang="ts">
  // Shared modal chrome: scrim + centred dialog with focus trap + close. The
  // panels (settings / add-to-playlist / rename / help) pass their content as
  // children; generic content chrome (h3 / label / input / .modal-actions) is
  // styled here via :global so slotted markup picks it up, while panel-specific
  // styles stay in the panel.
  import { trapFocus } from "@scene/design";
  import type { Snippet } from "svelte";

  let { label, onClose, children }: { label: string; onClose: () => void; children: Snippet } =
    $props();
</script>

<div class="modal-bg">
  <button class="modal-scrim" aria-label="close" onclick={onClose}></button>
  <div class="modal" role="dialog" aria-modal="true" aria-label={label} tabindex="-1" use:trapFocus>
    {@render children()}
  </div>
</div>

<style>
  .modal-bg {
    position: fixed;
    inset: 0;
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .modal-scrim {
    position: absolute;
    inset: 0;
    border: none;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.5);
    cursor: pointer;
  }
  .modal {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 420px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  /* Generic content chrome — styles the slotted panel markup. */
  .modal :global(h3) {
    margin: 0;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .modal :global(label) {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .modal :global(input) {
    padding: 8px 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
  }
  .modal :global(.modal-actions) {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
</style>

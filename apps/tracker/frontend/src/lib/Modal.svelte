<script lang="ts">
  // Shared modal chrome: scrim + centred dialog with focus trap + close. The
  // panels (settings / add-to-playlist / rename / help) pass their content as
  // children; generic content chrome (h3 / label / input / .modal-actions) is
  // styled here via :global so slotted markup picks it up (the themed button/
  // select base is global, in +layout); panel-specific styles stay in the panel.
  import "@scene/design/modal.css";

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
  /* Shell (scrim + card + phone-fullscreen) comes from @scene/design/modal.css;
     only the stacking layer is this app's own. */
  .modal-bg {
    --modal-z: 6;
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
  .modal :global(input),
  .modal :global(textarea) {
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
  /* Primary/confirm action button, shared across modals (rename save, add create). */
  .modal :global(.ok) {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>

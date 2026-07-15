<script lang="ts">
  // Generic draggable divider. Sizes the flex sibling *before* it (drag right →
  // wider) and mirrors that width into `size` (bindable). If `storageKey` is set
  // it restores/persists the width in localStorage, so a user's column layout
  // sticks across reloads. Pointer-based → mouse + touch; keyboard-nudgeable for
  // a11y (WAI-ARIA window-splitter pattern). Horizontal/column split.
  import { onMount } from "svelte";

  let {
    size = $bindable(200),
    storageKey,
    min = 120,
    max = 640,
    label = "Resize column",
  }: {
    size?: number;
    storageKey?: string;
    min?: number;
    max?: number;
    label?: string;
  } = $props();

  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  // Restore the persisted width once on mount (guarded for SSR / private mode
  // where localStorage is absent or throws).
  onMount(() => {
    if (!storageKey) return;
    try {
      const v = localStorage.getItem(storageKey);
      if (v != null && Number.isFinite(Number(v))) size = clamp(Number(v));
    } catch {
      /* no storage — use the default */
    }
  });

  let dragging = $state(false);
  let startX = 0;
  let startSize = 0;

  function persist() {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(Math.round(size)));
    } catch {
      /* no storage */
    }
  }

  function down(e: PointerEvent) {
    dragging = true;
    startX = e.clientX;
    startSize = size;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    e.preventDefault();
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    size = clamp(startSize + (e.clientX - startX));
  }
  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    document.body.style.userSelect = "";
    persist();
  }
  function key(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") size = clamp(size - 16);
    else if (e.key === "ArrowRight") size = clamp(size + 16);
    else return;
    persist();
    e.preventDefault();
  }
</script>

<!-- Intentional WAI-ARIA window-splitter: a focusable separator with pointer
     drag + arrow-key nudge. The a11y rules flag "separator" as non-interactive,
     which is the wrong call for this pattern. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="rh"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={Math.round(size)}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onkeydown={key}
></div>

<style>
  /* A fat, invisible hit target with a thin visible line centred in it, pulled
     over its neighbours so it doesn't widen the layout. */
  .rh {
    flex: 0 0 auto;
    align-self: stretch;
    width: 9px;
    margin: 0 -4px;
    z-index: 1;
    cursor: col-resize;
    background: transparent;
    position: relative;
    touch-action: none;
  }
  .rh::before {
    content: "";
    position: absolute;
    inset: 0 4px;
    background: var(--surface-line-2, var(--surface-line, var(--border)));
    transition: background 0.1s;
  }
  .rh:hover::before,
  .rh.dragging::before {
    background: var(--accent);
  }
  .rh:focus-visible {
    outline: none;
  }
  .rh:focus-visible::before {
    background: var(--accent);
    inset: 0 3px;
  }
</style>

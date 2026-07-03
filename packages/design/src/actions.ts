// @scene/design — shared DOM behaviours (Svelte actions).

/** Focus-trap for modal dialogs. On mount it moves focus into the node (first
 *  focusable element, else the node itself) and keeps Tab / Shift-Tab cycling
 *  within it; on destroy it restores focus to whatever was focused before the
 *  dialog opened. Apply with `use:trapFocus` on the dialog container and give it
 *  `tabindex="-1"` so the fallback focus target works. */
export function trapFocus(node: HTMLElement) {
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const previouslyFocused = document.activeElement as HTMLElement | null;

  // Visible, tabbable descendants (skip display:none via offsetParent).
  function focusable(): HTMLElement[] {
    return Array.from(node.querySelectorAll<HTMLElement>(selector)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    const items = focusable();
    if (items.length === 0) {
      e.preventDefault();
      node.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === node)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  node.addEventListener("keydown", onKeydown);
  (focusable()[0] ?? node).focus();

  return {
    destroy() {
      node.removeEventListener("keydown", onKeydown);
      previouslyFocused?.focus?.();
    },
  };
}

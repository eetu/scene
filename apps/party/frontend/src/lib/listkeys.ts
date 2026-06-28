// Svelte action: roving Up/Down arrow-key navigation over a list's focusable
// children. Attach to a container (ul, grid, …); ArrowDown/ArrowUp move focus to
// the next/previous matching descendant. Activation stays native (Enter/Space on
// a button, Enter on a link). Defaults to direct `button`/`a` children-ish via a
// selector; pass a custom selector for other markup.
export function listKeys(node: HTMLElement, selector: string = "button, a") {
  let sel = selector;
  function onKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...node.querySelectorAll<HTMLElement>(sel)].filter(
      (el) => !el.hasAttribute("disabled"),
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    const next =
      idx === -1
        ? 0
        : e.key === "ArrowDown"
          ? Math.min(items.length - 1, idx + 1)
          : Math.max(0, idx - 1);
    items[next]?.focus();
  }
  node.addEventListener("keydown", onKey);
  return {
    update(s: string = "button, a") {
      sel = s;
    },
    destroy() {
      node.removeEventListener("keydown", onKey);
    },
  };
}

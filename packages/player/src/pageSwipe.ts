// Svelte action: horizontal touch/pen swipe → page the channel window by ±1.
// Axis-aware so it never fights vertical row-scrolling — a drag only pages once
// it's clearly horizontal (|dx| dominates and clears a threshold). Mouse is left
// alone (desktop uses the chevrons + click-to-place-cursor). Pair with
// `touch-action: pan-y` on the node so the browser keeps vertical panning while
// horizontal moves reach us.
export type PageSwipeOpts = { onPage: (dir: 1 | -1) => void };

const DECIDE = 10; // px before we commit to "this is a horizontal swipe"
const FIRE = 45; // px of horizontal travel that counts as one page

export function pageSwipe(node: HTMLElement, opts: PageSwipeOpts) {
  let o = opts;
  let x0 = 0;
  let y0 = 0;
  let active = false;
  let horizontal = false;

  function down(e: PointerEvent) {
    if (e.pointerType === "mouse") return;
    active = true;
    horizontal = false;
    x0 = e.clientX;
    y0 = e.clientY;
  }
  function move(e: PointerEvent) {
    if (!active) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!horizontal && Math.abs(dx) > DECIDE && Math.abs(dx) > Math.abs(dy)) horizontal = true;
    if (horizontal) e.preventDefault(); // stop text-select / rubber-band once committed
  }
  function up(e: PointerEvent) {
    if (!active) return;
    active = false;
    if (!horizontal) return;
    const dx = e.clientX - x0;
    if (Math.abs(dx) > FIRE) o.onPage(dx < 0 ? 1 : -1); // drag left → next channels
  }

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointercancel", up);

  return {
    update(next: PageSwipeOpts) {
      o = next;
    },
    destroy() {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
    },
  };
}

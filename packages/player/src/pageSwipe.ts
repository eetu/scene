// Svelte action: horizontal touch/pen swipe → page the channel window.
// Axis-aware so it never fights vertical row-scrolling — a drag only pages once
// it's clearly horizontal (|dx| dominates and clears a threshold). It pages
// CONTINUOUSLY: every STEP px of horizontal travel advances one more channel, so
// a long drag glides through several tracks (not just one per release). Mouse is
// left alone (desktop uses the chevrons + click-to-place-cursor). Pair with
// `touch-action: pan-y` on the node so the browser keeps vertical panning while
// horizontal moves reach us.
export type PageSwipeOpts = { onPage: (dir: 1 | -1) => void };

const DECIDE = 10; // px before we commit to "this is a horizontal swipe"
const STEP = 60; // px of horizontal travel per channel paged (continuous stepping)
const FLICK = 34; // a short committed swipe still pages once, even under one STEP

export function pageSwipe(node: HTMLElement, opts: PageSwipeOpts) {
  let o = opts;
  let x0 = 0;
  let y0 = 0;
  let anchorX = 0; // moving reference: advances by STEP each time we page
  let active = false;
  let horizontal = false;
  let paged = false; // did we fire at least one page this gesture?

  function down(e: PointerEvent) {
    if (e.pointerType === "mouse") return;
    active = true;
    horizontal = false;
    paged = false;
    x0 = e.clientX;
    y0 = e.clientY;
    anchorX = e.clientX;
  }
  function move(e: PointerEvent) {
    if (!active) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (!horizontal && Math.abs(dx) > DECIDE && Math.abs(dx) > Math.abs(dy)) {
      horizontal = true;
      anchorX = e.clientX; // start stepping from here, so DECIDE slop isn't counted
    }
    if (!horizontal) return;
    e.preventDefault(); // stop text-select / rubber-band once committed
    // Page one channel for each STEP crossed since the last page — so holding the
    // drag keeps advancing tracks smoothly instead of stopping after one.
    while (e.clientX - anchorX <= -STEP) {
      o.onPage(1); // drag left → next channels
      anchorX -= STEP;
      paged = true;
    }
    while (e.clientX - anchorX >= STEP) {
      o.onPage(-1); // drag right → previous channels
      anchorX += STEP;
      paged = true;
    }
  }
  function up(e: PointerEvent) {
    if (!active) return;
    active = false;
    if (!horizontal || paged) return; // long drag already paged continuously
    const dx = e.clientX - x0; // short committed flick → one page
    if (Math.abs(dx) > FLICK) o.onPage(dx < 0 ? 1 : -1);
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

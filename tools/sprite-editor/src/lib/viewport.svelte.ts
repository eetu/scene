// Where the sprite sits on screen: a zoom and a pan offset, driven by the same
// gesture vocabulary as nib — pinch, two-finger scroll, ⌘/ctrl-wheel, space-drag.
//
// Zoom is continuous while a gesture is running but SNAPS TO A WHOLE NUMBER for
// drawing whenever it is above 1: this is pixel art, and a sprite pixel drawn
// 7.3 screen pixels wide gets a seam every few columns however good the
// smoothing is off. Below 1 (a sprite larger than the pane) the fraction is
// kept, because there the alternative is not fitting at all.
//
// Fit is automatic until you touch the zoom: opening a 3×8 crown and then a
// 72×18 car should both fill the pane without a word, but once you have zoomed
// in on something the view must stop moving under you.

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 64;
/** Room left around the sprite so its edge pixels aren't against the pane wall. */
const PAD = 32;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const viewport = $state({
  /** Continuous, for gestures. Use `cell()` to draw with. */
  zoom: 8,
  /** Pan in screen pixels, from the pane's centre. */
  tx: 0,
  ty: 0,
  /** Pane size, kept current by the canvas component. */
  paneW: 0,
  paneH: 0,
  /** Cleared by fit(), set by any manual zoom — see the note above. */
  manual: false,
});

/** Screen pixels per sprite pixel, as drawn. Whole above 1 (see the header). */
export const cell = (): number => (viewport.zoom >= 1 ? Math.round(viewport.zoom) : viewport.zoom);

/** The zoom at which the sprite just fits the pane. */
export function fitZoom(w: number, h: number): number {
  if (w <= 0 || h <= 0 || viewport.paneW <= 0 || viewport.paneH <= 0) return viewport.zoom;
  const raw = Math.min((viewport.paneW - PAD * 2) / w, (viewport.paneH - PAD * 2) / h);
  // Floor to a whole zoom when there is room for one, so a fit lands crisp.
  return clamp(raw >= 1 ? Math.floor(raw) : raw, MIN_ZOOM, MAX_ZOOM);
}

/** Fill the pane and centre — the fit button, the `0` key, and every load. */
export function fit(w: number, h: number) {
  viewport.zoom = fitZoom(w, h);
  viewport.tx = 0;
  viewport.ty = 0;
  viewport.manual = false;
}

/**
 * Scale by `factor`, keeping the sprite pixel under `screen` where it is.
 *
 * Without the anchor, zooming in on a detail walks it off the pane and the next
 * gesture is always a pan to find it again — the most annoying thing a pixel
 * editor can do. `screen` is relative to the pane's top-left.
 */
export function zoomBy(factor: number, screen: { x: number; y: number } | null) {
  const next = clamp(viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  if (next === viewport.zoom) return;
  const k = next / viewport.zoom;
  if (screen) {
    // tx/ty are offsets from the pane centre, so anchor in those coordinates.
    const cx = screen.x - viewport.paneW / 2;
    const cy = screen.y - viewport.paneH / 2;
    viewport.tx = cx - (cx - viewport.tx) * k;
    viewport.ty = cy - (cy - viewport.ty) * k;
  } else {
    viewport.tx *= k;
    viewport.ty *= k;
  }
  viewport.zoom = next;
  viewport.manual = true;
}

/** A step of the keyboard/button zoom: whole numbers near 1, proportional above. */
export const zoomIn = (at: { x: number; y: number } | null = null) =>
  zoomBy(
    (Math.round(viewport.zoom) + Math.max(1, Math.round(viewport.zoom * 0.25))) / viewport.zoom,
    at,
  );
export const zoomOut = (at: { x: number; y: number } | null = null) =>
  zoomBy(
    Math.max(0.05, Math.round(viewport.zoom) - Math.max(1, Math.round(viewport.zoom * 0.2))) /
      viewport.zoom,
    at,
  );

export function panBy(dx: number, dy: number) {
  viewport.tx += dx;
  viewport.ty += dy;
}

/** What the artwork is judged against. Absolute colours, deliberately not the
 *  UI theme: these sprites are neon on near-black, and a light editor chrome
 *  should still be able to preview them on the surface they will live on. */
export const BACKDROPS = [
  { id: "checker", label: "Checker" },
  { id: "night", label: "Night" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
] as const;

export type Backdrop = (typeof BACKDROPS)[number]["id"];

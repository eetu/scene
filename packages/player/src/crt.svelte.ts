// CRT screen for the visualiser pane — @glowbox/crt in element mode, wrapping the
// whole pane rather than each effect. One call covers every visualiser and forwards
// pointer/wheel events, so the scenes that support drag-orbit and zoom (paint,
// tubes) still do.
//
// On by default — demoscene material was made to be watched on a tube; the toggle is
// a persisted preference.
import { createCrtScreen, type CrtOptions, type CrtScreen } from "@glowbox/crt";

import { readPref, writePref } from "./persist";

const KEY = "scene-viz-crt";

export const crt = $state({ on: readPref(KEY) !== "0" });

export function setCrt(on: boolean) {
  crt.on = on;
  writePref(KEY, on ? "1" : "0");
}

export function toggleCrt() {
  setCrt(!crt.on);
}

/** Visualisers the CRT screen does not belong in front of.
 *
 *  One rule: the screen simulates a phosphor tube, so it belongs in front of a PICTURE
 *  (a raster of light) and not an OBJECT (something drawn as sitting in a room, with a
 *  case, a front panel and its own light). Over an object the raster claims the object is
 *  emitting, the barrel warp bends panels that are supposed to be flat, and several carry
 *  controls drawn into the panel that the screen cannot composite. The hi-fi DOES contain
 *  a display, but the visualiser draws the stereo, not the strip. */
const PHYSICAL = new Set(["flip", "board", "hifi", "tubes", "vu"]);

/** Should the CRT screen be mounted for this visualiser? */
export function crtSuits(viz: string): boolean {
  return !PHYSICAL.has(viz);
}

export const CRT_OPTIONS: CrtOptions = {
  // Gentle. The pane carries overlaid readouts near its edges and the effects have
  // fine detail (the dancer's fringes, the tunnel's rings) that a strong barrel
  // warp smears; this reads as a tube without bending the picture out of shape.
  curvature: 0.14,
  // A touch above the package default (0.45). The raster is the most recognisable part
  // of the effect and, with every temporal artifact switched off below, it and the
  // phosphor mask are what carry it.
  scanlines: 0.58,
  // Every temporal brightness artifact off. Each one modulates the whole frame over
  // time, and over an effect that is already moving they read as dropped frames rather
  // than as period hardware.
  //
  // `persistence` is the important one and the least obvious: it blends real frame
  // history, and these visualisers render at 30fps while the screen composites at 60.
  // Half its frames therefore see an unchanged source, so the phosphor decay
  // alternates between fading and refreshing — a 30Hz pulse, worst on the dancer,
  // which has the highest contrast in the set.
  flicker: 0,
  band: 0,
  persistence: 0,
};

/**
 * Mount a CRT screen over `host`. Returns the teardown, so callers can use it
 * straight from an `$effect`.
 *
 * Deliberately just the one call. It can be made before the pane has been laid out or
 * has produced a canvas — the object visualisers build their renderers
 * renderers asynchronously — because @glowbox/crt tracks canvases as they appear and
 * heals its own output size every frame. Those two properties are what make this safe
 * to call blind, and crt-element-mode.svelte.test.ts pins them, so losing either fails
 * there rather than showing up as a black pane.
 *
 * Mount it ONCE and leave it. The screen handles canvases appearing and disappearing
 * itself, and re-creating it per visualiser is actively harmful: it owns a WebGL
 * context, browsers allow only ~16 live at a time, and each visualiser holds one too —
 * so a rebuild per switch walks over the limit and the browser drops live contexts,
 * blacking out whatever is on screen. Tearing down also un-hides every source canvas
 * and re-hides it a frame later, which flickers.
 */
export function mountCrt(host: HTMLElement): () => void {
  const screen: CrtScreen | null = createCrtScreen(host, CRT_OPTIONS);
  return () => screen?.dispose();
}

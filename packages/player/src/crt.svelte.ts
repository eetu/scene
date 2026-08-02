// CRT screen for the visualiser pane — @glowbox/crt in element mode, wrapping the
// whole pane rather than each effect. One call covers every visualiser and forwards
// pointer/wheel events, so the scenes that support drag-orbit and zoom (paint,
// tubes) still do.
//
// On by default: this is demoscene material, and it was made to be watched on a
// tube. The toggle is persisted because it's a preference about how you like to
// watch, not a per-session accident.
import { createCrtScreen, type CrtOptions, type CrtScreen } from "@glowbox/crt";

const KEY = "scene-viz-crt";

function initial(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true; // no storage — default to on
  }
}

export const crt = $state({ on: initial() });

export function setCrt(on: boolean) {
  crt.on = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* no storage — the choice just won't outlive the session */
  }
}

export function toggleCrt() {
  setCrt(!crt.on);
}

/** Visualisers the CRT screen does not belong in front of.
 *
 *  One rule, and it is not a taste call: the screen simulates a phosphor tube — scanlines, a
 *  shadow mask, a barrel-warped glass face — so it belongs in front of a PICTURE and not in
 *  front of an OBJECT.
 *
 *  Most of the set is a picture: a raster of light with no depth and no housing, which is
 *  what a tube in a chain shows and why the screen reads as period hardware over them. The
 *  ones listed here are objects instead — things drawn as though they are sitting in a room,
 *  with a case, a front panel and their own light:
 *
 *    flip   a flip-dot matrix: printed discs, lit by whatever light is around them
 *    board  a Solari split-flap: physical cards that fall
 *    hifi   a mini system: a brushed faceplate, a cassette door, two speaker cabinets
 *    tubes  nixies in a chassis — glass envelopes you look INTO, not a surface
 *    vu     moving-coil meters: a needle behind a window, an instrument rather than an image
 *
 *  Over any of these the raster claims the object is emitting, which is exactly the illusion
 *  they trade on not doing, and the barrel warp bends front panels and printed cards that are
 *  supposed to be flat. Several also carry controls drawn into the panel, which the screen
 *  cannot composite.
 *
 *  The hi-fi is the interesting case, because it DOES contain a display. But the display is a
 *  strip screwed into a faceplate, and what the visualiser draws is the stereo, not the
 *  strip — so a tube in front is a third display in a chain that already has two. */
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
 * has produced a canvas — the visualisers lazy-import three.js and build their
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

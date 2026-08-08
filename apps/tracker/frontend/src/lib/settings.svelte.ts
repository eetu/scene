// App preferences as a shared rune store — Svelte's equivalent of a jotai atom /
// React `useSettings` hook: import `settings` anywhere and read/write it directly,
// no prop-drilling. `theme` (in @scene/design) and `playback` (@scene/player) are
// the same pattern; this holds the tracker's own persisted prefs.
//
// Persistence is explicit (in the setters) rather than a $effect, because a
// module-level rune store has no component/effect context to run one in.

import { type FpsMode, perf, readPref, writePref } from "@scene/player";

export type PatternMode = "locked" | "scroll";

const PATTERN_MODE_KEY = "tracker:patternMode";
const FRAME_RATE_KEY = "tracker:frameRate";
const SCOPE_KEY = "tracker:scope";
/**
 * The pattern editor — off, and deliberately not exposed in the UI.
 *
 * It half-works: notes go in and the Web Audio sequencer plays them back, but
 * nothing is saved, undo doesn't exist, and there's no mobile surface at all.
 * Shipping a visible "edit" button for that promises something the app can't
 * keep, so the whole feature hides behind this until it's finished rather than
 * being deleted and rebuilt later.
 *
 * There's no settings toggle on purpose — a switch for an unfinished feature is
 * still shipping it. To work on the editor, from the browser console:
 *
 *     localStorage.setItem("tracker:editor", "1")  // then reload
 */
const EDITOR_KEY = "tracker:editor";

const loadedFrameRate: FpsMode = ((v) => (v === "smooth" || v === "battery" ? v : "auto"))(
  readPref(FRAME_RATE_KEY),
);
// Push the persisted choice into the shared player frame-rate policy at startup.
perf.mode = loadedFrameRate;

export const settings = $state({
  /** Player pattern view: locked centre-line vs free scroll. */
  patternMode: (readPref(PATTERN_MODE_KEY) === "scroll" ? "scroll" : "locked") as PatternMode,
  /** Visualiser frame rate: auto (adaptive) / smooth (60) / battery (30). */
  frameRate: loadedFrameRate,
  /** Master oscilloscope strip on the pattern tab. On by default; opt-out to
   *  save the per-frame canvas draw while playing. */
  scope: readPref(SCOPE_KEY) !== "0",
  /** Pattern editor. Off unless explicitly enabled — see EDITOR_KEY. Read once
   *  at startup, so flipping it takes a reload; that's fine for a dev flag and
   *  keeps every gate a plain boolean read. */
  editor: readPref(EDITOR_KEY) === "1",
});

export function setPatternMode(m: PatternMode) {
  settings.patternMode = m;
  writePref(PATTERN_MODE_KEY, m);
}

export function setFrameRate(m: FpsMode) {
  settings.frameRate = m;
  perf.mode = m;
  writePref(FRAME_RATE_KEY, m);
}

export function setScope(on: boolean) {
  settings.scope = on;
  writePref(SCOPE_KEY, on ? "1" : "0");
}

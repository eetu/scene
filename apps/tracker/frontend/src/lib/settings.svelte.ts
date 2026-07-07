// App preferences as a shared rune store — Svelte's equivalent of a jotai atom /
// React `useSettings` hook: import `settings` anywhere and read/write it directly,
// no prop-drilling. `theme` (in @scene/design) and `playback` (@scene/player) are
// the same pattern; this holds the tracker's own persisted prefs.
//
// Persistence is explicit (in the setters) rather than a $effect, because a
// module-level rune store has no component/effect context to run one in.

export type PatternMode = "locked" | "scroll";

const PATTERN_MODE_KEY = "tracker:patternMode";

function read(key: string): string | null {
  return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
}

export const settings = $state({
  /** Player pattern view: locked centre-line vs free scroll. */
  patternMode: (read(PATTERN_MODE_KEY) === "scroll" ? "scroll" : "locked") as PatternMode,
});

export function setPatternMode(m: PatternMode) {
  settings.patternMode = m;
  try {
    localStorage.setItem(PATTERN_MODE_KEY, m);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

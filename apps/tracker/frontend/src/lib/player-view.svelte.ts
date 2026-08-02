// Shared player-view UI state: which tab the overlay shows (pattern / samples /
// viz) and which visualizer the viz tab renders. A rune store (like view /
// settings) so the PlayerView overlay and +page's global key handler both read
// it without prop-drilling. In-memory only — it resets on reload, like the
// overlay's open state.
export type PvTab = "pattern" | "samples" | "viz";

export type VizMode =
  | "vu"
  | "flip"
  | "board"
  | "hifi"
  | "harmony"
  | "cube"
  | "wave"
  | "stars"
  | "copper"
  | "plasma"
  | "tunnel"
  | "disco"
  | "paint"
  | "tubes"
  | "dancer"
  | "ball";

export const VIZ: VizMode[] = [
  "vu",
  "flip",
  "board",
  "hifi",
  "harmony",
  "cube",
  "wave",
  "stars",
  "copper",
  "plasma",
  "tunnel",
  "disco",
  "paint",
  "tubes",
  "dancer",
  "ball",
];

export const pv = $state({
  tab: "pattern" as PvTab,
  // Copper bars rather than the VU meters, which is what this was and which are the most
  // modest thing in the set — two needles behind a window. Two reasons beyond taste:
  // copper is a cheap 2D effect, so it is up the instant the tab opens (the three.js
  // scenes drag a lazy import and a scene build first, and a blank pane is nobody's first
  // impression); and the CRT screen does not mount over `vu` at all — it is on the
  // `crtSuits` exception list as an object rather than a picture — so defaulting there
  // meant arriving at a player whose signature screen effect was invisible.
  vizMode: "copper" as VizMode,
  // The visualiser sheet (narrow screens show the set as a grid rather than a pill row).
  // Shared rather than local to PlayerView so +page's Escape cascade can close it as the
  // innermost layer — otherwise one Escape dismissed the sheet AND the whole overlay.
  vizSheet: false,
});

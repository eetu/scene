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
  vizMode: "vu" as VizMode,
  // The visualiser sheet (narrow screens show the set as a grid rather than a pill row).
  // Shared rather than local to PlayerView so +page's Escape cascade can close it as the
  // innermost layer — otherwise one Escape dismissed the sheet AND the whole overlay.
  vizSheet: false,
});

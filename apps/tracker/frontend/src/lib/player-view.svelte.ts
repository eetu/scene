// Shared player-view UI state: which tab the overlay shows (pattern / samples /
// viz) and which visualizer the viz tab renders. A rune store (like view /
// settings) so the PlayerView overlay and +page's global key handler both read
// it without prop-drilling. In-memory only — it resets on reload, like the
// overlay's open state.
export type PvTab = "pattern" | "samples" | "viz";

export type VizMode =
  | "vu"
  | "bars"
  | "cube"
  | "wave"
  | "stars"
  | "copper"
  | "plasma"
  | "tunnel"
  | "disco"
  | "tubes"
  | "ball";

export const VIZ: VizMode[] = [
  "vu",
  "bars",
  "cube",
  "wave",
  "stars",
  "copper",
  "plasma",
  "tunnel",
  "disco",
  "tubes",
  "ball",
];

export const pv = $state({
  tab: "pattern" as PvTab,
  vizMode: "vu" as VizMode,
});

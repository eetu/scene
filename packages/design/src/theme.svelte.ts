// Theme preference: light / dark / auto. This app does NOT follow the system
// theme by default — it defaults to **dark** (the FT2/Amiga surface is dark by
// nature). Only the explicit `auto` mode tracks `prefers-color-scheme`.
//
// The chosen mode is persisted; the *resolved* effective theme ('light' |
// 'dark') is applied as `data-theme` on <html> by the layout (see
// +layout.svelte), which the CSS tokens key off.

export type ThemeMode = "auto" | "light" | "dark";
// Accent colour — orthogonal to light/dark. The family default is the warm
// orange; purple is an opt-in. Applied as `data-accent` on <html>.
export type Accent = "orange" | "purple";

const KEY = "scene:theme";
const ACCENT_KEY = "scene:accent";

function initialMode(): ThemeMode {
  if (typeof localStorage === "undefined") return "dark";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "auto" || v === "dark" ? v : "dark";
}

function initialAccent(): Accent {
  if (typeof localStorage === "undefined") return "orange";
  return localStorage.getItem(ACCENT_KEY) === "purple" ? "purple" : "orange";
}

export const theme = $state<{ mode: ThemeMode; accent: Accent }>({
  mode: initialMode(),
  accent: initialAccent(),
});

export function setTheme(mode: ThemeMode) {
  theme.mode = mode;
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, mode);
}

export function setAccent(accent: Accent) {
  theme.accent = accent;
  if (typeof localStorage !== "undefined") localStorage.setItem(ACCENT_KEY, accent);
}

// Cycle order for the single toolbar button: dark → light → auto → dark.
const ORDER: ThemeMode[] = ["dark", "light", "auto"];
export function cycleTheme() {
  setTheme(ORDER[(ORDER.indexOf(theme.mode) + 1) % ORDER.length]);
}

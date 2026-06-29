// Theme preference: light / dark / auto. This app does NOT follow the system
// theme by default — it defaults to **dark** (the FT2/Amiga surface is dark by
// nature). Only the explicit `auto` mode tracks `prefers-color-scheme`.
//
// The chosen mode is persisted; the *resolved* effective theme ('light' |
// 'dark') is applied as `data-theme` on <html> by the layout (see
// +layout.svelte), which the CSS tokens key off.

export type ThemeMode = "auto" | "light" | "dark";

const KEY = "scene:theme";

function initialMode(): ThemeMode {
  if (typeof localStorage === "undefined") return "dark";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "auto" || v === "dark" ? v : "dark";
}

export const theme = $state<{ mode: ThemeMode }>({ mode: initialMode() });

export function setTheme(mode: ThemeMode) {
  theme.mode = mode;
  if (typeof localStorage !== "undefined") localStorage.setItem(KEY, mode);
}

// Cycle order for the single toolbar button: dark → light → auto → dark.
const ORDER: ThemeMode[] = ["dark", "light", "auto"];
export function cycleTheme() {
  setTheme(ORDER[(ORDER.indexOf(theme.mode) + 1) % ORDER.length]);
}

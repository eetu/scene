// Which face the split-flap board is showing. Persisted and manual-only, like the
// flip-dot board's modes and the CRT toggle — a preference about how you like to watch.
import { persistedMode } from "./persisted-mode.svelte";

export type BoardMode = "scroll" | "departures";

export const BOARD_MODES: { id: BoardMode; label: string }[] = [
  { id: "scroll", label: "text" },
  { id: "departures", label: "queue" },
];

const { view: boardView, set: setBoardMode } = persistedMode<BoardMode>(
  "scene-board-mode",
  BOARD_MODES,
  "scroll",
);

export { boardView, setBoardMode };

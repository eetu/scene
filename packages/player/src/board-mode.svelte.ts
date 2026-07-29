// Which face the split-flap board is showing. Persisted and manual-only, like the
// flip-dot board's modes and the CRT toggle — a preference about how you like to watch.
export type BoardMode = "scroll" | "departures";

export const BOARD_MODES: { id: BoardMode; label: string }[] = [
  { id: "scroll", label: "text" },
  { id: "departures", label: "queue" },
];

export function isBoardMode(v: unknown): v is BoardMode {
  return BOARD_MODES.some((m) => m.id === v);
}

const KEY = "scene-board-mode";

function initial(): BoardMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (isBoardMode(saved)) return saved;
  } catch {
    /* no storage — fall through to the default */
  }
  return "scroll";
}

export const boardView = $state({ mode: initial() });

export function setBoardMode(mode: BoardMode) {
  boardView.mode = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* no storage — the choice just won't outlive the session */
  }
}

// Which face the flip-dot board is showing. Persisted, like the CRT toggle and for the
// same reason: it is a preference about how you like to watch, not a per-session
// accident. Manual only — the board never rotates modes on its own, because a display
// that changes what it means while you are reading it is a worse display.
import { type FlipMode, isFlipMode } from "./flip-modes";

const KEY = "scene-flip-mode";

function initial(): FlipMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (isFlipMode(saved)) return saved;
  } catch {
    /* no storage — fall through to the default */
  }
  return "bars";
}

export const flip = $state({ mode: initial() });

export function setFlipMode(mode: FlipMode) {
  flip.mode = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* no storage — the choice just won't outlive the session */
  }
}

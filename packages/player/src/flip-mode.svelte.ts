// Which face the flip-dot board is showing. Persisted, like the CRT toggle and for the
// same reason: it is a preference about how you like to watch, not a per-session
// accident. Manual only — the board never rotates modes on its own, because a display
// that changes what it means while you are reading it is a worse display.
import { type FlipMode, FLIP_MODES } from "./flip-modes";
import { persistedMode } from "./persisted-mode.svelte";

const { view: flip, set: setFlipMode } = persistedMode<FlipMode>(
  "scene-flip-mode",
  FLIP_MODES,
  "bars",
);

export { flip, setFlipMode };

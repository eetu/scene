// A persisted, manual-only display mode (the flip-dot board's modes, the
// split-flap's faces, the hi-fi's DISPLAY button): a $state view over one of a
// fixed set of ids, restored from localStorage when the saved value is still a
// member, written back on every set.
import { readPref, writePref } from "./persist";

export function persistedMode<M extends string>(
  key: string,
  modes: readonly { id: M; label: string }[],
  fallback: M,
): { view: { mode: M }; set: (mode: M) => void } {
  const saved = readPref(key);
  const view = $state({ mode: modes.some((m) => m.id === saved) ? (saved as M) : fallback });
  function set(mode: M) {
    view.mode = mode;
    writePref(key, mode);
  }
  return { view, set };
}

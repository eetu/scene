// How you have the hi-fi set up. Persisted and manual-only, like the flip-dot board's modes
// and the split-flap's faces — preferences about how you like to watch, not something the
// app should decide for you.
//
// `face` is the DISPLAY button. On the real thing it was a momentary press that cycled the
// window between the analyser, the level meter, the text field and the dial.
//
// `grilles` is whether the speakers are wearing their covers, which is the other thing
// everyone had an opinion about and the only one you set by touching the speaker itself.
import { isVfdFace, type VfdFace, VFD_FACES } from "./vfd-face";

export { type VfdFace, VFD_FACES };

const KEY = "scene-vfd-face";
const GRILLE_KEY = "scene-hifi-grilles";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // no storage — fall through to the default
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no storage — the choice just won't outlive the session */
  }
}

function initialFace(): VfdFace {
  const saved = read(KEY);
  return isVfdFace(saved) ? saved : "spectrum";
}

/** Covers on by default: that is how the thing arrived in the box, and taking them off is
 *  the discovery. */
function initialGrilles(): boolean {
  return read(GRILLE_KEY) !== "off";
}

export const vfdView = $state({ face: initialFace(), grilles: initialGrilles() });

export function setVfdFace(face: VfdFace) {
  vfdView.face = face;
  write(KEY, face);
}

export function setGrilles(on: boolean) {
  vfdView.grilles = on;
  write(GRILLE_KEY, on ? "on" : "off");
}

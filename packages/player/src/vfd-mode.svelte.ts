// How you have the hi-fi set up. Persisted and manual-only, like the flip-dot board's modes
// and the split-flap's faces — preferences about how you like to watch, not something the
// app should decide for you.
//
// `face` is the DISPLAY button. On the real thing it was a momentary press that cycled the
// window between the analyser, the level meter, the text field and the dial.
//
// `grilles` is whether the speakers are wearing their covers, which is the other thing
// everyone had an opinion about and the only one you set by touching the speaker itself.
import { readPref, writePref } from "./persist";
import { persistedMode } from "./persisted-mode.svelte";
import { type VfdFace, VFD_FACES } from "./vfd-face";

export { type VfdFace, VFD_FACES };

const GRILLE_KEY = "scene-hifi-grilles";

const face = persistedMode<VfdFace>("scene-vfd-face", VFD_FACES, "spectrum");

/** Covers on by default: that is how the thing arrived in the box, and taking them off is
 *  the discovery. */
const grilleState = $state({ on: readPref(GRILLE_KEY) !== "off" });

export const vfdView = {
  get face(): VfdFace {
    return face.view.mode;
  },
  set face(f: VfdFace) {
    face.view.mode = f;
  },
  get grilles(): boolean {
    return grilleState.on;
  },
  set grilles(on: boolean) {
    grilleState.on = on;
  },
};

export function setVfdFace(f: VfdFace) {
  face.set(f);
}

export function setGrilles(on: boolean) {
  grilleState.on = on;
  writePref(GRILLE_KEY, on ? "on" : "off");
}

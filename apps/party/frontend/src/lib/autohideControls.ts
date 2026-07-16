import type { Action } from "svelte/action";

// Auto-hide a surface's control bar after inactivity while it's "immersive" —
// either real fullscreen of this node (desktop) or the iOS pseudo-fullscreen
// overlay the emulators fall back to (Safari has no Fullscreen API on a <div>).
// Any pointer, touch, or key activity reveals the controls and restarts the idle
// countdown, like a video player's chrome. Reports visibility via onVisibility so
// the host drives a `class:` toggle; a no-op (controls always shown) when not
// immersive. Listeners are capture-phase so they still fire even though js-dos /
// EmulatorJS grab pointer + keyboard events on their own surfaces.
const IDLE_MS = 2500;

type AutohideParams = {
  /** CSS pseudo-fullscreen is active (iOS Safari has no Fullscreen API on a div). */
  pseudo: boolean;
  /** Called with true to hide the controls, false to reveal them. */
  onVisibility: (hidden: boolean) => void;
};

export const autohideControls: Action<HTMLElement, AutohideParams> = (node, params) => {
  let pseudo = params.pseudo;
  let onVisibility = params.onVisibility;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wired = false;

  const immersive = () => pseudo || document.fullscreenElement === node;
  const opts = { capture: true, passive: true } as const;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function reveal() {
    onVisibility(false);
    clearTimer();
    timer = setTimeout(() => onVisibility(true), IDLE_MS);
  }
  const onActivity = () => reveal();

  function enable() {
    if (wired) return;
    wired = true;
    node.addEventListener("pointermove", onActivity, opts);
    node.addEventListener("pointerdown", onActivity, opts);
    node.addEventListener("touchstart", onActivity, opts);
    node.addEventListener("keydown", onActivity, opts);
    reveal(); // show now, then start the idle countdown
  }
  function disable() {
    wired = false;
    node.removeEventListener("pointermove", onActivity, opts);
    node.removeEventListener("pointerdown", onActivity, opts);
    node.removeEventListener("touchstart", onActivity, opts);
    node.removeEventListener("keydown", onActivity, opts);
    clearTimer();
    onVisibility(false); // never leave the controls hidden once out of immersive
  }
  function recompute() {
    if (immersive()) enable();
    else if (wired) disable();
  }

  const onFsChange = () => recompute();
  document.addEventListener("fullscreenchange", onFsChange);
  recompute();

  return {
    update(next) {
      pseudo = next.pseudo;
      onVisibility = next.onVisibility;
      recompute();
    },
    destroy() {
      document.removeEventListener("fullscreenchange", onFsChange);
      if (wired) disable();
    },
  };
};

// Shared frame-rate policy for the visualisers — one place that decides how fast
// each effect should run, so an always-on viz doesn't drain the battery.
//
// The app sets `perf.mode`:
//   - "auto"    — adaptive: target 60fps, but step down when the device can't
//                 sustain it (reported by driveFrames + the nixie loop), and
//                 recover slowly when it's calm again.
//   - "smooth"  — pin 60fps.
//   - "battery" — pin 30fps.
// `prefers-reduced-motion` always forces the low end (honoured here directly, so
// no app wiring is needed). Idle (paused/stopped) is always throttled hard.
//
// Battery *detection* is deliberately not used: the Battery Status API is Chrome-
// only and privacy-gated (Firefox/Safari removed it), so "auto" infers capability
// from actual frame timing instead.

export type FpsMode = "auto" | "smooth" | "battery";

export const perf = $state({
  mode: "auto" as FpsMode,
  reduced: false, // prefers-reduced-motion
  autoFps: 60, // adaptive ceiling for "auto" (reactive, so prop-bound caps follow it)
});

// Honour prefers-reduced-motion (browser only; @scene/player is app-agnostic, so
// no `$app/environment` — guard on window).
if (typeof window !== "undefined" && window.matchMedia) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  perf.reduced = mq.matches;
  mq.addEventListener("change", () => (perf.reduced = mq.matches));
}

// "auto" settles perf.autoFps to a sustainable rate.
let miss = 0;
let clean = 0;
const FLOOR = 30;
const CEIL = 60;

/** driveFrames (and the nixie loop) report each rendered frame's real interval vs
 *  its target. Sustained overshoot = the device can't hold this rate → step down;
 *  a long calm stretch → step back up. Only meaningful in "auto". */
export function reportFrame(elapsedMs: number, targetMs: number): void {
  if (perf.mode !== "auto") return;
  if (elapsedMs > targetMs * 1.5) {
    clean = 0;
    if (++miss >= 20 && perf.autoFps > FLOOR) {
      perf.autoFps = Math.max(FLOOR, perf.autoFps - 9);
      miss = 0;
    }
  } else {
    miss = 0;
    if (++clean >= 900 && perf.autoFps < CEIL) {
      perf.autoFps = Math.min(CEIL, perf.autoFps + 6);
      clean = 0;
    }
  }
}

/** Cap while the effect is animating (playing). */
export function activeFps(): number {
  if (perf.reduced) return 30;
  if (perf.mode === "smooth") return CEIL;
  if (perf.mode === "battery") return FLOOR;
  return perf.autoFps;
}

/** Cap while idle (paused / stopped) — always low. */
export function idleFps(): number {
  return perf.reduced || perf.mode === "battery" ? 10 : 15;
}

/** The cap a viz should run at right now, given whether it's animating. */
export function vizFps(active: boolean): number {
  return active ? activeFps() : idleFps();
}

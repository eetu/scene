// Shared animation-frame driver for the visualisers, tuned for heat/battery.
//
// Two things every effect wants but the raw rAF loop doesn't give:
//  - a frame-rate cap: a 120Hz ProMotion iPad fires rAF twice as often as a
//    60Hz screen, so an uncapped full-screen raymarcher renders (and heats)
//    twice as hard for no visible gain. We render at most `fps` times/second.
//  - hidden-tab stop: tear the loop down entirely while the document is hidden
//    (deterministic, not just the browser's background-rAF throttling), and reset
//    the clock on return so the first visible frame doesn't get a huge dt.
//
// `render(dt, now)` receives the real elapsed seconds since the last *rendered*
// frame (clamped to 50ms), so animation speed is independent of the cap. Returns
// a stop() to cancel the loop and detach listeners.
//
// Pass `active: () => boolean` (preferred) and the shared frame-rate policy picks
// the cap — playing → the auto/smooth/battery active rate — and the loop feeds
// real frame timing back to the policy so "auto" can adapt. When it goes inactive
// (paused/stopped) the loop paints a brief settle window then FREEZES (tears down
// rAF, wakes on a cheap watchdog): a paused full-screen viz re-painting at an idle
// cap still burns ~10% CPU, frozen it costs nothing.
// (Or pass a raw `fps` number/function to opt out of the policy — those loops run
// continuously and never freeze, e.g. non-viz/always-on loops.)
import { reportFrame, vizFps } from "./perf.svelte";

export function driveFrames(
  render: (dt: number, now: number) => void,
  opts: { fps?: number | (() => number); active?: () => boolean } = {},
): () => void {
  if (typeof requestAnimationFrame === "undefined") return () => {};
  const fpsOpt = opts.fps ?? 60;
  const activeFn = opts.active;
  const targetFps = () =>
    activeFn ? vizFps(activeFn()) : typeof fpsOpt === "function" ? fpsOpt() : fpsOpt;
  const hidden = () => typeof document !== "undefined" && document.hidden;

  let raf = 0;
  let watch: ReturnType<typeof setTimeout> | 0 = 0;
  let last = performance.now();
  // When did the effect go inactive? (0 while active.) An `active`-driven loop
  // paints a short settle window after going idle — so damped motion (orbit
  // damping, particle/pulse decay) lands on a resting frame — then FREEZES: the
  // rAF loop is torn down and a cheap watchdog wakes it when active again. A
  // paused viz that just re-paints a near-static frame at the idle cap still
  // costs real canvas/compositing CPU (≈10% for a full-screen 2D effect); frozen
  // it costs nothing. Loops with no `active` predicate (fps-only) never freeze.
  let idleSince = 0;
  const SETTLE_MS = 1500;
  const WATCH_MS = 250;

  function startRaf() {
    if (!raf && !hidden()) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }
  function stopRaf() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  function clearWatch() {
    if (watch) clearTimeout(watch);
    watch = 0;
  }

  function tick(now: number) {
    raf = requestAnimationFrame(tick);
    let settling = false;
    if (activeFn && !activeFn()) {
      if (!idleSince) idleSince = now;
      if (now - idleSince > SETTLE_MS) return freeze();
      settling = true;
    } else {
      idleSince = 0;
    }
    // Paint the settle window at the ACTIVE cap (not the idle cap): when pause is
    // hit, damped motion winding down to rest — particle fall, spin/pulse/glow
    // decay — keeps rendering smoothly right up to the resting frame instead of
    // stuttering at ~12fps the instant it goes idle. Then it freezes.
    const fps = settling ? vizFps(true) : targetFps();
    const elapsed = now - last;
    // −1ms slack so two 8.33ms (120Hz) ticks clear the 60fps gate cleanly.
    if (elapsed < 1000 / fps - 1) return; // too soon — skip this tick
    last = now;
    // Adapt only on policy-managed loops while playing (idle timings are noise).
    if (activeFn && activeFn()) reportFrame(elapsed, 1000 / fps);
    render(Math.min(0.05, elapsed / 1000), now);
  }

  // Inactive → stop painting; poll cheaply for reactivation, then resume. Parks
  // silently while hidden (onVis resumes it), so it never spins in the background.
  function freeze() {
    stopRaf();
    const check = () => {
      watch = 0;
      if (hidden()) return;
      if (activeFn && activeFn()) {
        idleSince = 0;
        startRaf();
      } else {
        watch = setTimeout(check, WATCH_MS);
      }
    };
    watch = setTimeout(check, WATCH_MS);
  }

  // Tab hidden/minimized → tear the loop (and any watchdog) down entirely so it
  // burns zero cycles in the background; resume on return. (Stronger than relying
  // on the browser's own background-rAF throttling.)
  const onVis = () => {
    if (hidden()) {
      stopRaf();
      clearWatch();
    } else {
      idleSince = 0;
      startRaf();
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVis);
  }

  startRaf();

  return () => {
    stopRaf();
    clearWatch();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVis);
    }
  };
}

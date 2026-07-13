// Shared animation-frame driver for the visualisers, tuned for heat/battery.
//
// Two things every effect wants but the raw rAF loop doesn't give:
//  - a frame-rate cap: a 120Hz ProMotion iPad fires rAF twice as often as a
//    60Hz screen, so an uncapped full-screen raymarcher renders (and heats)
//    twice as hard for no visible gain. We render at most `fps` times/second.
//  - hidden-tab pause: skip rendering entirely while the document is hidden
//    (belt-and-braces over the browser's own background throttling), and reset
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
  let raf = 0;
  let watch: ReturnType<typeof setTimeout> | 0 = 0;
  let last = performance.now();
  // When did the effect go inactive? (0 while active.) An `active`-driven loop
  // paints a short settle window after going idle — so damped motion (orbit
  // damping, particle/pulse decay) lands on a resting frame — then FREEZES: the
  // rAF loop is torn down and a cheap watchdog wakes it when it's active again.
  // A paused viz that just re-paints a near-static frame at the idle cap still
  // costs real canvas/compositing CPU (≈10% for a full-screen 2D effect); frozen
  // it costs nothing. Loops with no `active` predicate (fps-only) never freeze.
  let idleSince = 0;
  const SETTLE_MS = 800;

  function tick(now: number) {
    raf = requestAnimationFrame(tick);
    if (typeof document !== "undefined" && document.hidden) return;
    if (activeFn && !activeFn()) {
      if (!idleSince) idleSince = now;
      if (now - idleSince > SETTLE_MS) return freeze();
    } else {
      idleSince = 0;
    }
    const fps = targetFps();
    const elapsed = now - last;
    // −1ms slack so two 8.33ms (120Hz) ticks clear the 60fps gate cleanly.
    if (elapsed < 1000 / fps - 1) return; // too soon — skip this tick
    last = now;
    // Adapt only on policy-managed loops while playing (idle timings are noise).
    if (activeFn && activeFn()) reportFrame(elapsed, 1000 / fps);
    render(Math.min(0.05, elapsed / 1000), now);
  }

  // Stop painting entirely; poll (cheaply) for reactivation, then resume the loop.
  function freeze() {
    cancelAnimationFrame(raf);
    raf = 0;
    const check = () => {
      if (activeFn && activeFn()) {
        idleSince = 0;
        last = performance.now();
        raf = requestAnimationFrame(tick);
      } else {
        watch = setTimeout(check, 250);
      }
    };
    watch = setTimeout(check, 250);
  }

  raf = requestAnimationFrame(tick);

  const onVis = () => {
    if (!document.hidden) last = performance.now();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVis);
  }

  return () => {
    cancelAnimationFrame(raf);
    if (watch) clearTimeout(watch);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVis);
    }
  };
}

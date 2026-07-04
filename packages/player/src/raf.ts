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
export function driveFrames(
  render: (dt: number, now: number) => void,
  opts: { fps?: number } = {},
): () => void {
  if (typeof requestAnimationFrame === "undefined") return () => {};
  // −1ms slack so two 8.33ms (120Hz) ticks clear the 60fps gate cleanly.
  const minInterval = 1000 / (opts.fps ?? 60) - 1;
  let raf = 0;
  let last = performance.now();

  function tick(now: number) {
    raf = requestAnimationFrame(tick);
    if (typeof document !== "undefined" && document.hidden) return;
    const elapsed = now - last;
    if (elapsed < minInterval) return; // too soon — skip this tick
    last = now;
    render(Math.min(0.05, elapsed / 1000), now);
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
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVis);
    }
  };
}

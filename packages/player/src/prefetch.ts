// Warm the heavy lazy-loaded viz chunks ahead of use. The tubes (nixie) viz
// pulls in three.js + @glowbox/nixie on first select; doing that fetch+parse
// inline at the moment of switching can, on mobile, starve the PCM-render worker
// long enough to underrun the audio worklet → an audible glitch. Kicking the
// dynamic import early (while the user is already in the viz area) means the
// chunk is cached + parsed before they pick tubes, so the switch is just scene
// construction. Fire-and-forget; the browser dedupes with the real import.
//
// This only warms the *module* — it does not construct the WebGL scene, so it
// costs no render/GPU work until the tubes viz is actually mounted.
let warmed: Promise<unknown> | null = null;

export function prefetchTubes(): Promise<unknown> {
  if (!warmed) warmed = import("./nixie-scene").catch(() => {});
  return warmed;
}

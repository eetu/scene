import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";

import LedBars from "../LedBars.svelte";

// Smoke test (browser — needs a real WebGL context): the 3D "cube" spectrum viz
// mounts, lazy-loads @glowbox/svelte and paints a canvas without throwing, idle
// (active:false → no audio graph, the draw() just clears). Polls for the canvas —
// the lazy import resolves a tick after mount. Guards the wiring — the glowbox
// import, the prop contract, the per-frame draw — and would catch a breaking bump.
test("LedBars mounts and renders a canvas over glowbox", async () => {
  render(LedBars, { props: { active: false } });
  await expect.poll(() => document.querySelector("canvas"), { timeout: 8000 }).toBeTruthy();
});

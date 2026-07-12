import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";

import LedBars from "../LedBars.svelte";

// Smoke test (browser — needs a real WebGL context): the 3D "cube" spectrum viz
// mounts over @glowbox/svelte's <LedGrid> and paints a canvas without throwing,
// idle (active:false → no audio graph, the draw() just clears). Guards the
// wiring — the glowbox import, the prop contract, and the per-frame draw
// callback — and would catch a breaking @glowbox bump.
test("LedBars mounts and renders a canvas over glowbox", async () => {
  render(LedBars, { props: { active: false } });
  // glowbox creates its WebGL canvas on mount (in an effect) — give it a beat.
  await new Promise((r) => setTimeout(r, 60));
  expect(document.querySelector("canvas"), "glowbox LedGrid created a <canvas>").toBeTruthy();
});

import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";

import DancerScene from "../DancerScene.svelte";

// The scene is laid out in container-query units, so give it a real box to fill —
// an unsized host collapses every slot to 0 and tests nothing useful.
function sizedBody() {
  document.body.style.cssText = "width:640px;height:360px;margin:0";
}

// Smoke test (browser — the seven-segment core renders to canvas): the clock
// radio mounts, builds its MM:SS row of @glowbox/seven-segment displays, and
// paints them without throwing. Guards the wiring — the @glowbox/svelte import,
// the wrapper's prop names (`displayStyle`, not `style`), a breaking bump.
test("DancerScene renders the seven-segment row", async () => {
  sizedBody();
  render(DancerScene, { props: { active: false } });
  // Five slots — MM, the colon, SS — one canvas each. Counted by slot rather than by
  // every canvas in the display, because the readout also paints its own face canvas
  // behind them (a CSS background is invisible to the CRT screen, which composites
  // canvases only). Scoped to the display either way, so the scene's own WebGL canvas
  // isn't counted.
  await expect
    .poll(
      () => document.querySelectorAll('[data-testid="dancer-viz"] .display .slot canvas').length,
      { timeout: 8000 },
    )
    .toBe(5);
  // And the face is there, behind them.
  expect(document.querySelectorAll('[data-testid="dancer-viz"] .display canvas.face').length).toBe(
    1,
  );
});

// The backdrop and the dancer share one WebGL scene, so the canvas must appear
// whether or not a dancer model is present — a missing asset costs the figure,
// not the whole viz.
test("DancerScene mounts the WebGL scene", async () => {
  sizedBody();
  render(DancerScene, { props: { active: false } });
  await expect
    .poll(() => document.querySelector('[data-testid="dancer-scene"] canvas'), {
      timeout: 8000,
    })
    .toBeTruthy();
});

// The readout is the only static bright element on screen, so it wanders slowly to
// avoid burning into an OLED. A broken style binding would be invisible for months,
// so check the custom properties actually reach the element.
test("readout carries its burn-in drift offsets", async () => {
  sizedBody();
  render(DancerScene, { props: { active: false } });
  const panel = await expect
    .poll(() => document.querySelector(".display") as HTMLElement | null, { timeout: 8000 })
    .toBeTruthy();
  const el = document.querySelector(".display") as HTMLElement;
  for (const prop of ["--dx", "--dy"]) {
    const v = el.style.getPropertyValue(prop);
    expect(v, prop).not.toBe("");
    expect(Number.isFinite(Number(v)), `${prop}=${v}`).toBe(true);
  }
  expect(panel).toBeDefined();
});

// Clicking the scene hides the readout and clicking again brings it back. The
// target has to be the whole surface: a toggle on the readout itself would be
// unreachable once hidden.
test("clicking the scene toggles the readout, and the choice persists", async () => {
  sizedBody();
  try {
    localStorage.removeItem("scene-dancer-readout");
  } catch {
    /* no storage in this environment */
  }
  render(DancerScene, { props: { active: false } });

  await expect.poll(() => document.querySelectorAll(".display").length, { timeout: 8000 }).toBe(1);
  const tap = document.querySelector(".tap") as HTMLButtonElement;
  expect(tap).toBeTruthy();

  tap.click();
  await expect.poll(() => document.querySelectorAll(".display").length).toBe(0);
  expect(localStorage.getItem("scene-dancer-readout")).toBe("0");

  tap.click();
  await expect.poll(() => document.querySelectorAll(".display").length).toBe(1);
  expect(localStorage.getItem("scene-dancer-readout")).toBe("1");
});

// A hidden readout must stay hidden across a remount — the stage is rebuilt on
// every track change, so a preference that didn't survive would be useless.
test("a hidden readout stays hidden on remount", async () => {
  sizedBody();
  localStorage.setItem("scene-dancer-readout", "0");
  render(DancerScene, { props: { active: false } });
  await expect.poll(() => document.querySelector(".tap"), { timeout: 8000 }).toBeTruthy();
  expect(document.querySelectorAll(".display").length).toBe(0);
  localStorage.removeItem("scene-dancer-readout");
});

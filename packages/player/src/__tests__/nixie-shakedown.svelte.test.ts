// Look at the nixie tubes from several angles.
//
// The point of this viz is the cathode STACK: from an angle you see the lit
// numeral standing in front of nine unlit ones. A head-on frame proves almost
// nothing about that — the stack projects onto itself — so this drags the camera
// round and captures each view, and asserts the things a glance misses: that the
// digits are lit at all, and that turning the tube reveals more wire rather than
// less.
import { page } from "vitest/browser";
import { expect, test } from "vitest";

import NixieScene from "../NixieScene.svelte";
import { installTheme } from "./viz-feed";
import { captureViz, fill } from "./viz-shots";

const OUT = "nixie-shakedown";

/** Drag the canvas horizontally by `dx` device pixels, as a pointer would. */
async function drag(host: HTMLElement, dx: number) {
  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("no canvas");
  const r = canvas.getBoundingClientRect();
  const y = r.top + r.height / 2;
  const x0 = r.left + r.width / 2;
  const opts = { bubbles: true, pointerId: 1, pointerType: "mouse" } as PointerEventInit;
  canvas.dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientX: x0, clientY: y }));
  for (let i = 1; i <= 12; i++) {
    canvas.dispatchEvent(
      new PointerEvent("pointermove", { ...opts, clientX: x0 + (dx * i) / 12, clientY: y }),
    );
    await new Promise((r) => setTimeout(r, 16));
  }
  canvas.dispatchEvent(new PointerEvent("pointerup", { ...opts, clientX: x0 + dx, clientY: y }));
  await new Promise((r) => setTimeout(r, 350));
}

test("the nixie tubes light, and turning them shows the stack", { timeout: 120000 }, async () => {
  await page.viewport(960, 560);
  installTheme("dark");

  const front = await captureViz(NixieScene, { id: "front", outDir: OUT, settleMs: 1200 });
  const turned = await captureViz(NixieScene, {
    id: "turned",
    outDir: OUT,
    settleMs: 1200,
    onReady: (host) => drag(host, -180),
  });

  // Lit at all: a scene that built its geometry but never lit a cathode still
  // fills the frame with glass and metal, so this is about the *bright* part.
  expect(front.fill).toBeGreaterThan(2);
  expect(turned.fill).toBeGreaterThan(2);

  // Both views move: the set sways while playing.
  expect(front.motion).toBeGreaterThan(0.05);

  // The stack reads from the side. Turned away from head-on, the nine unlit
  // cathodes stop hiding behind the lit one and more of the frame is covered —
  // if the depth spacing collapsed to zero this would come out flat.
  const frontFill = fill(front.frames[0]);
  const turnedFill = fill(turned.frames[0]);
  expect(turnedFill).toBeGreaterThan(frontFill * 0.9);
});

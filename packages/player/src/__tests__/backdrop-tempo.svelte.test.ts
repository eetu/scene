import { expect, test } from "vitest";

import { createSotaScene } from "../sota-scene";

// How much of the backdrop changes over a short window — a proxy for drift speed.
// The window is deliberately tiny: over a full second the measure saturates,
// because a fine ring pattern flips most pixels under even a small movement, and
// a fast tempo then looks barely different from a slow one.
async function driftOver(ms: number, bpm: number): Promise<number> {
  const host = document.createElement("div");
  host.style.cssText = "width:200px;height:200px;position:relative";
  document.body.appendChild(host);
  // No model: this is about the backdrop, and it keeps the test quick.
  const scene = await createSotaScene(host, { url: null });
  const gl = host.querySelector("canvas") as HTMLCanvasElement;
  const probe = document.createElement("canvas");
  probe.width = gl.width;
  probe.height = gl.height;
  const ctx = probe.getContext("2d")!;
  const grab = () => {
    ctx.drawImage(gl, 0, 0);
    return ctx.getImageData(0, 0, probe.width, probe.height).data;
  };

  scene.advance(0.001, bpm);
  const before = new Uint8ClampedArray(grab());
  const step = ms / 1000 / 4;
  for (let i = 0; i < 4; i++) scene.advance(step, bpm);
  const after = grab();

  let changed = 0;
  for (let i = 0; i < after.length; i += 4) {
    if (Math.abs(after[i] - before[i]) > 40) changed++;
  }
  scene.dispose();
  host.remove();
  return changed / (probe.width * probe.height);
}

test("backdrop drifts faster under a faster tune", async () => {
  const slow = await driftOver(80, 60);
  const fast = await driftOver(80, 150);
  // Both must actually move, and the fast tune must move the pattern meaningfully
  // further in the same wall-clock time.
  expect(slow).toBeGreaterThan(0.005);
  expect(fast).toBeGreaterThan(slow * 1.5);
});

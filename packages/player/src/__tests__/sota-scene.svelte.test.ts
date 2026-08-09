import { expect, test } from "vitest";

import urlA from "../assets/dancer-a.bin?url";
import urlB from "../assets/dancer-b.bin?url";
import urlC from "../assets/dancer-c.bin?url";
import { createSotaScene, PALETTES } from "../sota-gl";

// The figure can vanish while every structural check still passes — the model
// loads, the canvas is sized, nothing throws, and the frame holds only backdrop.
// Three separate causes have done exactly that here: a collapsed host box, a
// camera beyond the default far plane, and root-motion cancellation measured in
// the bone's own space (a glTF export can leave the armature rotated 90°, making
// bone-local Z vertical, so cancelling it launched the figure out of shot).
//
// That last one only showed on *some* frames — mostly hidden, occasionally
// streaking past — so this samples across the clip rather than trusting one
// frame. The discriminator is colour: the backdrop is strictly black and white
// and the figure is tinted, so any non-greyscale pixel is dancer.
function colouredFraction(gl: HTMLCanvasElement, probe: HTMLCanvasElement): number {
  const ctx = probe.getContext("2d")!;
  ctx.drawImage(gl, 0, 0);
  const px = ctx.getImageData(0, 0, probe.width, probe.height).data;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) > 24) n++;
  }
  return n / (probe.width * probe.height);
}

test("dancer holds the frame across the clip", async () => {
  const host = document.createElement("div");
  host.style.cssText = "width:320px;height:320px;position:relative";
  document.body.appendChild(host);

  const scene = await createSotaScene(host, { urls: [urlA] });
  expect(scene.hasDancer()).toBe(true);

  const gl = host.querySelector("canvas") as HTMLCanvasElement;
  const probe = document.createElement("canvas");
  probe.width = gl.width;
  probe.height = gl.height;

  for (let i = 0; i < 8; i++) {
    scene.advance(1.1, 120); // over a second each step, so the dance really moves
    const covered = colouredFraction(gl, probe);
    // Zero means it drew nothing or drifted out of shot; near-total means it's
    // clipped into the camera's face.
    expect.soft(covered, `frame ${i}`).toBeGreaterThan(0.02);
    expect.soft(covered, `frame ${i}`).toBeLessThan(0.7);
  }

  scene.dispose();
  host.remove();
});

// Every dance the model carries should be selectable and should render — a clip
// index that silently fell back to clip 0, or posed nothing, would look fine
// until you noticed every track dancing the same.
test("each clip and palette renders", async () => {
  const host = document.createElement("div");
  host.style.cssText = "width:280px;height:280px;position:relative";
  document.body.appendChild(host);

  const scene = await createSotaScene(host, { urls: [urlA, urlB, urlC] });
  expect(scene.clipCount()).toBeGreaterThan(1);

  const gl = host.querySelector("canvas") as HTMLCanvasElement;
  const probe = document.createElement("canvas");
  probe.width = gl.width;
  probe.height = gl.height;

  for (let c = 0; c < scene.clipCount(); c++) {
    scene.setClip(c);
    scene.setPalette(c % PALETTES.length);
    // A dance's poses are fetched the first time it is selected, so the figure
    // is not on screen the instant setClip returns.
    await expect.poll(() => scene.hasDancer(), { timeout: 5000 }).toBe(true);
    scene.advance(2.0, 120);
    expect.soft(colouredFraction(gl, probe), `clip ${c}`).toBeGreaterThan(0.02);
  }

  scene.dispose();
  host.remove();
});

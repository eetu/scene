// Look at the night drive across a stretch of road.
//
// A gallery frame proves the scene draws; it does not prove the scene *drives*.
// The things that can quietly break here are all temporal or spatial: the layers
// can scroll at the same rate (parallax gone, and every frame still looks
// correct), the buffer can be magnified with smoothing on (pixel art gone, and
// only a close look catches it), and the car can drift off its mark as the pane
// changes shape. So this samples a run, and measures those three.
import { page } from "vitest/browser";
import { expect, test } from "vitest";

import NeonDrive from "../NeonDrive.svelte";
import { installTheme } from "./viz-feed";
import { captureViz, centroid, fill } from "./viz-shots";

const OUT = "drive-shakedown";

test("the drive scrolls, in layers, in hard pixels", { timeout: 120000 }, async () => {
  await page.viewport(960, 560);
  installTheme("dark");

  const wide = await captureViz(NeonDrive, {
    id: "wide",
    outDir: OUT,
    settleMs: 2000,
    count: 8,
  });

  // Lit at all. The sky alone clears this, so it only guards a scene that failed
  // to build its world.
  expect(wide.fill).toBeGreaterThan(20);

  // Moving, and moving continuously rather than in one jump: every consecutive
  // pair differs. A world that scrolled only when a beat landed would pass a
  // mean-motion check and fail this.
  expect(wide.motion).toBeGreaterThan(0.15);
  for (let i = 1; i < wide.frames.length; i++) {
    const a = wide.frames[i - 1];
    const b = wide.frames[i];
    let diff = 0;
    for (let px = 0; px < a.data.length; px += 4) {
      if (Math.abs(a.data[px] - b.data[px]) > 6) diff++;
    }
    expect(diff, `frames ${i - 1}→${i} are identical`).toBeGreaterThan(0);
  }

  // Parallax, measured rather than eyeballed: collapse a band of rows to a
  // luma profile and find the horizontal shift that best matches the first
  // frame's profile to the last one's. The far skyline must have travelled less
  // than the near one. A raw pixel-diff cannot see this — the sky's twinkle and
  // sign blink swamp it, which is exactly how a flat scroll would slip through.
  // Per-column PEAK luma (a dash or cat's eye survives the max where a mean
  // buries it under the road gradient), then differentiated so smooth glows
  // (underglow, beam) contribute nothing — the shift search keys on hard edges.
  const profile = (img: ImageData, y0: number, y1: number) => {
    const peak = new Float64Array(img.width);
    for (let x = 0; x < img.width; x++) {
      let m = 0;
      for (let y = y0; y < y1; y++) {
        const i = (y * img.width + x) * 4;
        const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
        if (l > m) m = l;
      }
      peak[x] = m;
    }
    const out = new Float64Array(img.width - 1);
    for (let x = 0; x < out.length; x++) out[x] = peak[x + 1] - peak[x];
    return out;
  };
  const shift = (a: Float64Array, b: Float64Array, max: number) => {
    let best = 0;
    let bestErr = Infinity;
    for (let s = 0; s <= max; s++) {
      let err = 0;
      let n = 0;
      for (let x = s; x < a.length; x++) {
        err += Math.abs(a[x] - b[x - s]);
        n++;
      }
      if (err / n < bestErr) {
        bestErr = err / n;
        best = s;
      }
    }
    return best;
  };
  // Bands chosen off the layout: rows 20-40 of the 100-row downscale are the
  // mid skyline (0.22× scroll), rows 92-98 the lane dashes and cat's eyes
  // (1×+). Compare across ADJACENT frames and sum: over a long window both
  // profiles alias (a shift of one tower-spacing matches as well as zero).
  const farShift = [];
  const nearShift = [];
  for (let i = 1; i < wide.frames.length; i++) {
    const a = wide.frames[i - 1];
    const b = wide.frames[i];
    // Search capped at 15: at 115ms a frame the road cannot move further, and a
    // wider window starts matching the dash pattern one period over.
    farShift.push(shift(profile(a, 20, 40), profile(b, 20, 40), 15));
    nearShift.push(shift(profile(a, 90, 99), profile(b, 90, 99), 15));
  }
  const farSum = farShift.reduce((s, v) => s + v, 0);
  const nearSum = nearShift.reduce((s, v) => s + v, 0);
  expect(nearSum, "nothing scrolled").toBeGreaterThan(4);
  expect(
    nearSum,
    "the near layer is not outrunning the far one — parallax is flat",
  ).toBeGreaterThan(farSum);

  // The car holds its mark: a third in, and low. Measured as the centroid of the
  // *bottom* half, where the car and its glow are the only bright things.
  const [cx, cy] = centroid(wide.frames[wide.frames.length - 1]);
  expect(cy).toBeGreaterThan(35); // weight below the horizon, not floating
  expect(cx).toBeGreaterThan(15);
  expect(cx).toBeLessThan(75);

  // The coast: stop the music and the shot travels a little further than the car
  // does, leaving it back toward the left edge. Measured off the brightest column
  // of the car's band — the sprite, its glow and the head of its beam all live
  // there, and all of them move with it — because the whole-frame centroid is
  // dominated by the skyline and cannot see the car move at all.
  const carColumn = (img: ImageData) => {
    let best = 0;
    let bestX = 0;
    for (let x = 0; x < img.width; x++) {
      let m = 0;
      for (let y = 78; y < img.height; y++) {
        const i = (y * img.width + x) * 4;
        const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
        if (l > m) m = l;
      }
      if (m > best) {
        best = m;
        bestX = x;
      }
    }
    return (bestX / img.width) * 100;
  };
  // Long enough to have finished coasting: the slide is about a second, and the
  // loop is held open until it has parked.
  const idle = await captureViz(NeonDrive, {
    id: "idle",
    outDir: OUT,
    props: { active: false },
    settleMs: 2000,
    count: 2,
  });
  const drivingX = carColumn(wide.frames[wide.frames.length - 1]);
  const idleX = carColumn(idle.frames[idle.frames.length - 1]);
  expect(idleX, `the car did not drop back on pause (${idleX} vs ${drivingX})`).toBeLessThan(
    drivingX - 8,
  );
  // ...but it stays in shot. Parking it off the left edge is not the effect.
  expect(idleX, "the car coasted out of frame").toBeGreaterThan(1);

  // A tall narrow pane must not letterbox or crop the scene away.
  await page.viewport(420, 760);
  const tall = await captureViz(NeonDrive, { id: "tall", outDir: OUT, settleMs: 1500, count: 3 });
  expect(fill(tall.frames[0])).toBeGreaterThan(20);
});

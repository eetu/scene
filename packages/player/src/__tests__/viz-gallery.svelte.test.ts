// Renders every visualiser under a synthetic beat, saves frames for review, and
// asserts the things that are cheap to get wrong and invisible to a smoke test.
//
// Why pixels: each of these can fail while every structural check passes — the
// canvas is sized, the shader compiles, nothing throws, and the frame is empty,
// or clipped, or so harsh it fights whatever is in front of it. All three have
// happened here.
//
// Thresholds are deliberately loose. Several of these scenes auto-orbit, so fill
// and motion swing run to run with the camera's phase; the assertions sit well
// inside the fixed behaviour and well outside the broken behaviour they guard,
// rather than being pinned to a measurement.
import { page } from "vitest/browser";
import { expect, test } from "vitest";

import { installTheme } from "./viz-feed";
import { minFill, settleFor, VIZ } from "./viz-list";
import { captureViz } from "./viz-shots";

const OUT = "viz-gallery";

test("every visualiser draws and moves", { timeout: 600000 }, async () => {
  // The harness page is a narrow portrait iframe by default; the viz pane in the
  // app is a wide landscape panel, and several effects frame themselves off the
  // aspect ratio — the dancer's backdrop density and the disco ball's fit both
  // depend on it.
  await page.viewport(960, 560);
  installTheme("dark");

  const shots: Record<string, Awaited<ReturnType<typeof captureViz>>> = {};
  for (const v of VIZ) {
    shots[v.id] = await captureViz(v.comp, {
      id: v.id,
      outDir: OUT,
      props: v.props,
      settleMs: settleFor(v.id),
    });
  }

  for (const v of VIZ) {
    const s = shots[v.id];
    // Something is on screen, against a floor that suits the effect (see minFill).
    expect.soft(s.fill, `${v.id} drew nothing`).toBeGreaterThan(minFill(v.id));
    // And it is animating, not a frozen first frame.
    expect.soft(s.motion, `${v.id} is static`).toBeGreaterThan(0.05);
  }

  // The dancer's moiré backdrop is scenery behind a figure. At the theme's own
  // surface-vs-text contrast (~7:1) a dense fringe field reads as a hard
  // checkerboard competing with the dancer; it measured 75 before being pulled in.
  expect.soft(shots.dancer.contrast, "dancer backdrop too harsh").toBeLessThan(66);

  // Copper's bars are one contiguous ribbon. Bouncing them individually about a
  // shared centre smears them through each other, and measured ~17.
  expect.soft(shots.copper.motion, "copper bars are smearing").toBeLessThan(14);

  // The LED cube's camera orbits the grid centre while its bars grow from the
  // floor, so pulling the camera in magnifies that offset and starts cutting the
  // bars off the bottom edge. A small non-zero value is the orbit bringing a corner
  // close; 3.5 units of distance clipped outright, 3.9 does not.
  expect.soft(shots.cube.edges[2], "cube is clipping at the bottom").toBeLessThan(4);

  // Note on the disco ball: its top clipping is deliberately NOT asserted here.
  // The room behind it is lit, so an edge-coverage metric cannot tell ball from
  // backdrop — the number reads 100 either way. That fix is geometric and checked
  // by reading DiscoBall.svelte instead: uv is normalised by the short axis, which
  // fixes the half-FOV at atan(0.5/1.5) = 18.4°, so the ball's centre lift plus its
  // angular radius has to stay inside that.
});

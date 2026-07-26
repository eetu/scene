// A screenshot suite — see VISUAL in vitest.config.ts. Not part of `yarn test`.
import { page } from "vitest/browser";
import { expect, test } from "vitest";

import DancerScene from "../DancerScene.svelte";
import { installTheme } from "./viz-feed";
import { captureViz } from "./viz-shots";

// The digits have to be VISIBLE, not merely present — and with no CRT screen involved,
// which is where this broke. The readout paints its own face canvas behind them (a CSS
// background is invisible to the CRT compositor), and the face is absolutely positioned
// while the digit slots were static: a positioned element paints over a non-positioned
// sibling whatever the DOM order, so the face covered the digits and the readout showed
// as a solid black box. Counting canvases cannot see that; only pixels can. It looked
// correct under CRT throughout, because that composites in DOM order.
test("DancerScene readout digits paint over their own face", { timeout: 60000 }, async () => {
  await page.viewport(960, 560);
  installTheme("dark");
  // captureViz mounts into a fixed, full-viewport host and screenshots that host. Both
  // details matter: a full-page screenshot captures the harness shell rather than the
  // test frame (it comes back blank white), and an element screenshot of the readout
  // waits for it to be stable, which never happens — it carries a per-frame drift
  // transform.
  const shot = await captureViz(DancerScene, { id: "readout", outDir: null, count: 2 });

  // The VFD phosphor is the only strongly cyan-green thing in this scene — the figure is
  // accent orange and the backdrop its two greys — so cyan anywhere in frame is a lit
  // segment and nothing else.
  const lit = shot.frames.reduce((n, img) => {
    for (let i = 0; i < img.data.length; i += 4) {
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (g > 70 && b > 60 && g > r + 30) n++;
    }
    return n;
  }, 0);
  expect(lit, "no lit segments — the face canvas is covering the digits").toBeGreaterThan(0);
});

// The CRT screen (@glowbox/crt, element mode) over the viz pane. Mounts a visualiser in
// a host and wraps the host the way PlayerView does, so this covers the real integration
// rather than the package in isolation.
//
// EVERY visualiser, not a sample of them. An earlier version checked three, and the LED
// cube turned out to render black under the screen while being perfectly fine without
// it — the exact failure this suite exists to catch, walked straight past. Compositing
// depends on how each effect draws (which context type, how often, whether it repaints
// unprompted), so "one 2D and one WebGL effect work" generalises to nothing.
//
// A screenshot suite — see VISUAL in vitest.config.ts. Not part of `yarn test`.
import { page } from "vitest/browser";
import { expect, test } from "vitest";

import { mountCrt } from "../crt.svelte";
import { installTheme } from "./viz-feed";
import { minFill, settleFor, VIZ } from "./viz-list";
import { captureViz } from "./viz-shots";

const OUT = "crt";

test("crt screen composites every visualiser", { timeout: 900000 }, async () => {
  await page.viewport(960, 560);
  installTheme("dark");

  for (const v of VIZ) {
    let off: (() => void) | null = null;
    const shot = await captureViz(v.comp, {
      id: v.id,
      outDir: OUT,
      props: v.props,
      settleMs: settleFor(v.id),
      onReady: (host) => {
        off = mountCrt(host);
      },
    });
    off?.();
    const seen = `${v.id} fill=${shot.fill.toFixed(0)}% motion=${shot.motion.toFixed(2)}`;

    // The screen is a real compositor: if it fails to build, or composites nothing, the
    // pane goes black and the effect vanishes even though it is drawing fine underneath.
    expect.soft(shot.fill, `${v.id} went dark under crt (${seen})`).toBeGreaterThan(minFill(v.id));
    expect.soft(shot.motion, `${v.id} froze under crt (${seen})`).toBeGreaterThan(0.05);
    // Barrel curvature leaves the tube face's corners dark, which is the clearest sign
    // the effect is actually in the pipeline rather than silently skipped.
    const [top, , bottom] = shot.edges;
    expect.soft(top, `${v.id} has no curved tube face (${seen})`).toBeLessThan(80);
    expect.soft(bottom, `${v.id} has no curved tube face (${seen})`).toBeLessThan(80);
  }
});

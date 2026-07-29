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

import { crtSuits, mountCrt } from "../crt.svelte";
import { installTheme } from "./viz-feed";
import { minFill, minMotion, settleFor, VIZ } from "./viz-list";
import { captureViz } from "./viz-shots";

const OUT = "crt";

test("crt screen composites every visualiser", { timeout: 900000 }, async () => {
  await page.viewport(960, 560);
  installTheme("dark");

  // The mechanical displays are exempt — the app never mounts a screen over them, so
  // compositing them here would test a configuration that does not ship. Asserted rather
  // than silently skipped, so the exemption list and this suite cannot drift apart.
  const exempt = VIZ.filter((v) => !crtSuits(v.id)).map((v) => v.id);
  expect(exempt, "the CRT exemption list changed").toEqual(["flip", "board"]);

  let checkedContract = false;
  for (const v of VIZ) {
    if (!crtSuits(v.id)) continue;
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
    // Cross-package contract, checked once on the first composited visualiser: the
    // screen has to hide its sources WITHOUT taking them out of the accessibility tree.
    // Through @glowbox/crt 1.6.0 it used `visibility: hidden`, which does both — so every
    // wrapped display went silent to assistive tech while looking perfectly fine. 1.7.0
    // uses `opacity: 0`. Neither package's own tests can see this; ours can.
    if (!checkedContract) {
      checkedContract = true;
      const src = document.querySelector("canvas:not([data-glowbox-crt])") as HTMLCanvasElement;
      if (src) {
        const st = getComputedStyle(src);
        expect.soft(st.visibility, "CRT hid a source out of the a11y tree").toBe("visible");
        expect.soft(st.opacity, "CRT is not hiding its sources").toBe("0");
      }
    }
    off?.();
    const seen = `${v.id} fill=${shot.fill.toFixed(0)}% motion=${shot.motion.toFixed(2)}`;

    // The screen is a real compositor: if it fails to build, or composites nothing, the
    // pane goes black and the effect vanishes even though it is drawing fine underneath.
    expect.soft(shot.fill, `${v.id} went dark under crt (${seen})`).toBeGreaterThan(minFill(v.id));
    expect
      .soft(shot.motion, `${v.id} froze under crt (${seen})`)
      .toBeGreaterThanOrEqual(minMotion(v.id));
    // Barrel curvature leaves the tube face's corners dark, which is the clearest sign
    // the effect is actually in the pipeline rather than silently skipped.
    const [top, , bottom] = shot.edges;
    expect.soft(top, `${v.id} has no curved tube face (${seen})`).toBeLessThan(80);
    expect.soft(bottom, `${v.id} has no curved tube face (${seen})`).toBeLessThan(80);
  }
});

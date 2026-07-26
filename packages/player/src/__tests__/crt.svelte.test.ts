// The CRT screen (@glowbox/crt, element mode) over the viz pane. Mounts a
// visualiser in a host and wraps the host the way PlayerView does, so this covers
// the real integration rather than the package in isolation.
import { page } from "vitest/browser";
import { expect, test } from "vitest";

import CopperBars from "../CopperBars.svelte";
import { mountCrt } from "../crt.svelte";
import DancerScene from "../DancerScene.svelte";
import Tunnel from "../Tunnel.svelte";
import { installTheme } from "./viz-feed";
import { captureViz } from "./viz-shots";

const OUT = "crt";

test("crt screen composites the viz pane", { timeout: 300000 }, async () => {
  await page.viewport(960, 560);
  installTheme("dark");

  const cases = [
    { id: "copper", comp: CopperBars, settleMs: 600 },
    { id: "tunnel", comp: Tunnel, settleMs: 2200 },
    { id: "dancer", comp: DancerScene, settleMs: 2200 },
  ];

  for (const c of cases) {
    let off: (() => void) | null = null;
    const shot = await captureViz(c.comp, {
      id: c.id,
      outDir: OUT,
      settleMs: c.settleMs,
      onReady: (host) => {
        off = mountCrt(host);
      },
    });
    off?.();

    // The screen is a real WebGL compositor — if it failed to build, or composited
    // nothing, the pane goes black and every viz vanishes at once.
    expect.soft(shot.fill, `${c.id} went dark under crt`).toBeGreaterThan(5);
    expect.soft(shot.motion, `${c.id} froze under crt`).toBeGreaterThan(0.05);
    // Barrel curvature leaves the tube face's corners black, which is the clearest
    // signal the effect is actually in the pipeline and not silently skipped.
    const [top, , bottom] = shot.edges;
    expect.soft(top, `${c.id} has no curved tube face`).toBeLessThan(75);
    expect.soft(bottom, `${c.id} has no curved tube face`).toBeLessThan(75);
  }
});

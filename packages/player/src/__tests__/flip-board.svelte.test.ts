// The flip-dot board's faces, rendered for review.
//
// flip-modes.test.ts holds the arithmetic (churn per frame); this renders each mode
// through the real @glowbox/flip-dot board and saves a frame, because the numbers
// cannot tell you whether a starfield reads as stars or as dirt.
//
// A screenshot suite — see VISUAL in vitest.config.ts. Not part of `yarn test`.
import { mount, unmount } from "svelte";
import { page } from "vitest/browser";
import { afterEach, expect, test } from "vitest";

import FlipDots from "../FlipDots.svelte";
import { FLIP_MODES } from "../flip-modes";
import { setFlipMode } from "../flip-mode.svelte";
import { startVizFeed } from "./viz-feed";

let host: HTMLDivElement | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any = null;
let feed: { stop: () => void } | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  feed?.stop();
  feed = null;
  host?.remove();
  host = null;
  setFlipMode("bars");
});

test("every mode draws on the real board", { timeout: 120000 }, async () => {
  await page.viewport(1000, 620);
  feed = startVizFeed();

  host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;width:960px;height:540px;background:#0a0b0d";
  document.body.appendChild(host);

  app = mount(FlipDots, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 1500));

  const canvas = host.querySelector("canvas");
  expect(canvas, "no canvas mounted").toBeTruthy();

  // The mode buttons are the control, so drive them rather than the store — that also
  // covers the buttons being present and wired.
  for (const m of FLIP_MODES) {
    const btn = [...host.querySelectorAll(".modes button")].find(
      (b) => b.textContent?.trim() === m.label,
    ) as HTMLButtonElement | undefined;
    expect(btn, `no button for ${m.id}`).toBeTruthy();
    btn!.click();
    // Long enough for a few frames plus a flip to land.
    await new Promise((r) => setTimeout(r, 1600));
    expect(btn!.getAttribute("aria-pressed"), `${m.id} button not marked active`).toBe("true");
    await page.elementLocator(host).screenshot({ path: `viz-gallery/flip-${m.id}.png` });
  }
});

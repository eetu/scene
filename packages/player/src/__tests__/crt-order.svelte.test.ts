// Reproduces the ORDER the app uses: the CRT screen is mounted at the same moment
// as the visualiser, before the visualiser's lazily-built canvas exists. Every
// earlier test let the canvas settle first, which is the case that already worked —
// so it never covered the reported "black until you toggle it off and on".
//
// Also counts how many times the screen is torn down and rebuilt, since a rebuild
// loop is the obvious suspect for the reported flicker.
import { page } from "vitest/browser";
import { mount, unmount } from "svelte";
import { expect, test } from "vitest";

import { mountCrt } from "../crt.svelte";
import DancerScene from "../DancerScene.svelte";
import { installTheme, startVizFeed } from "./viz-feed";
import { grab } from "./viz-shots";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isGlowbox = (n: Node) =>
  n instanceof HTMLCanvasElement && "glowboxCrt" in (n as HTMLCanvasElement).dataset;

test("crt mounted at the same time as the viz", { timeout: 180000 }, async () => {
  await page.viewport(960, 560);
  installTheme("dark");
  const feed = startVizFeed({});

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;overflow:hidden;background:#000";
  document.body.appendChild(host);

  // Count screen creations/removals for the whole run.
  let created = 0;
  let removed = 0;
  const spy = new MutationObserver((recs) => {
    for (const r of recs) {
      r.addedNodes.forEach((n) => isGlowbox(n) && created++);
      r.removedNodes.forEach((n) => isGlowbox(n) && removed++);
    }
  });
  spy.observe(host, { childList: true, subtree: true });

  // The app's ordering: viz and screen in the same tick.
  const app = mount(DancerScene as never, { target: host, props: { active: true } as never });
  const off = mountCrt(host);

  const lit = async (label: string) => {
    const img = await grab(
      (page as unknown as { elementLocator: (e: Element) => unknown }).elementLocator(host),
      null,
    );
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if (Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) > 40) n++;
    }
    return `${label} lit=${((n / (img.data.length / 4)) * 100).toFixed(0)}%`;
  };

  const early = await lit("early");
  await sleep(2500);
  const mid = await lit("mid");
  const settled = created;
  await sleep(2500);
  const late = await lit("late");

  off();
  unmount(app);
  host.remove();
  feed.stop();
  spy.disconnect();

  // The pane has a picture. This is the reported bug: mounted in this order against
  // 1.4.0-rc.1 it stayed black until the screen was toggled off and on by hand.
  for (const [label, s] of [
    ["early", early],
    ["mid", mid],
    ["late", late],
  ] as const) {
    const pct = Number(/lit=(\d+)/.exec(s)![1]);
    expect.soft(pct, `${label}: pane is black (${s})`).toBeGreaterThan(20);
  }

  // Exactly one screen for the whole run, and none after the scene settled. Rebuilding
  // it un-hides every source canvas and re-hides it a frame later, which flickers.
  expect.soft(created, "more than one screen was built").toBe(1);
  expect.soft(removed, "the screen was torn down mid-run").toBe(0);
  expect.soft(created - settled, "screens rebuilt after settling").toBe(0);
});

// The scroller board, rendered with a module's text the way a real one carries it.
//
// The gallery suite proves it lights up; this one proves it is READABLE, which is the
// only thing this visualiser is for. It waits out the cascade and asserts the board's
// target text is the module's own words, then saves a settled frame to look at.
//
// A screenshot suite — see VISUAL in vitest.config.ts. Not part of `yarn test`.
import { mount, unmount } from "svelte";
import { page } from "vitest/browser";
import { afterEach, expect, test } from "vitest";

import { mountCrt } from "../crt.svelte";
import ScrollerBoard from "../ScrollerBoard.svelte";
import { playback } from "../state.svelte";
import { startVizFeed } from "./viz-feed";

// A module whose sample slots hold a message rather than an inventory — which is what
// the prose filter is for, and what the board is worth looking at with.
const MESSAGE = [
  "greetings from the void",
  "written in 3 hours at 4am",
  "hello to everyone at the party",
  "bd1.wav",
  "sn2.wav",
  "hh.wav",
];

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
});

function stage(): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;inset:0;width:960px;height:560px;background:#0a0b0d";
  document.body.appendChild(el);
  return el;
}

test("the board settles on the module's own words", { timeout: 60000 }, async () => {
  // The browser project's default viewport is phone-sized (414 wide). The stage below
  // is 960, so without this an element screenshot is clipped at the viewport edge and
  // a correctly wrapped board looks like a narrow one with words missing — which is
  // exactly how this was misread once already.
  await page.viewport(1000, 620);

  feed = startVizFeed();
  playback.samples = MESSAGE;
  playback.instruments = [];

  host = stage();
  app = mount(ScrollerBoard, { target: host, props: { active: true } });

  // Long enough for the lazy import, the first setText, and the cascade to land.
  await new Promise((r) => setTimeout(r, 6000));

  const canvas = host.querySelector("canvas");
  expect(canvas, "no canvas mounted").toBeTruthy();

  // Shoot the element, not the page: the stage is larger than the headless viewport,
  // so a page screenshot crops the board's right-hand columns and makes correct wraps
  // look like dropped words.
  await page.elementLocator(host).screenshot({ path: "viz-gallery/board-settled.png" });

  // The label carries the board's shown text (the library appends it), so the DOM can
  // say what the board reads without us reaching into the canvas.
  const label = canvas!.getAttribute("aria-label") ?? "";
  expect(label.length, "board exposed no text").toBeGreaterThan(0);

  // The prose filter should have kept the message lines and dropped the .wav inventory.
  const shown = label.toUpperCase();
  const prose = MESSAGE.filter((m) => !m.endsWith(".wav")).map((m) => m.toUpperCase());
  const hit = prose.some((line) => shown.includes(line.slice(0, 10)));
  expect(hit, `no message line on the board — label was ${JSON.stringify(label)}`).toBe(true);
});

// The gallery's motion check is switched off for this effect (see minMotion), because
// across two frames a second apart a board mid-hold is legitimately still. That leaves
// nothing asserting it ever moves — so assert it here, on the timescale it actually
// works at: hold the page ~15s, then turn.
test("the board turns the page", { timeout: 90000 }, async () => {
  await page.viewport(1000, 620);
  feed = startVizFeed();
  // Long enough to overflow the board — a script that fits is deliberately static
  // (asserted below), so testing the drift with a short one measures nothing.
  playback.samples = Array.from({ length: 24 }, (_, i) => `line number ${i} of the message`);
  playback.instruments = [];

  host = stage();
  app = mount(ScrollerBoard, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 6000));

  const canvas = host.querySelector("canvas")!;
  const first = canvas.getAttribute("aria-label") ?? "";
  expect(first.length, "board exposed no text").toBeGreaterThan(0);

  // One hold is 32 beats at the feed's 125bpm (~15.4s), with a 22s hard fallback.
  await new Promise((r) => setTimeout(r, 26000));
  const second = canvas.getAttribute("aria-label") ?? "";

  expect(second, `board never turned the page — still ${JSON.stringify(first)}`).not.toBe(first);
});

// The other half of clamping the drift: when the whole script already fits on the
// board there is nowhere to scroll to, so it holds still. It used to cycle regardless —
// the text rotated under you for no reason, and the module's own message was never all
// on screen at once even though it would have fit.
test("a script that fits the board stays put", { timeout: 90000 }, async () => {
  await page.viewport(1000, 620);
  feed = startVizFeed();
  playback.samples = MESSAGE;
  playback.instruments = [];

  host = stage();
  app = mount(ScrollerBoard, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 6000));

  const canvas = host.querySelector("canvas")!;
  const first = canvas.getAttribute("aria-label") ?? "";
  expect(first, "board exposed no text").toContain("GREETINGS FROM THE VOID");
  // No arrows either: there is nothing to page to.
  expect(host.querySelector(".pager"), "pager shown for a script that fits").toBeNull();

  await new Promise((r) => setTimeout(r, 26000));
  expect(canvas.getAttribute("aria-label"), "a script that fits scrolled anyway").toBe(first);
});

// The pager is a DOM control inside the pane the CRT screen wraps. The screen
// composites canvases and hides the sources, so anything that isn't a canvas has to be
// deliberately placed in front of the glass — and has to still receive clicks, because
// the screen's own canvas covers the pane. Both have gone wrong here before (a readout
// that vanished behind the screen, and one that painted over it).
test("the pager reaches the board through the CRT screen", { timeout: 90000 }, async () => {
  await page.viewport(1000, 620);
  feed = startVizFeed();
  // A script long enough to page through — the arrows hide when everything fits.
  playback.samples = Array.from({ length: 24 }, (_, i) => `line number ${i} of the message`);
  playback.instruments = [];

  host = stage();
  app = mount(ScrollerBoard, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 6000));

  const drop = mountCrt(host);
  try {
    await new Promise((r) => setTimeout(r, 1200));

    const down = host.querySelector('button[aria-label="Next lines"]') as HTMLButtonElement | null;
    expect(down, "no pager button rendered").toBeTruthy();

    // Visible in front of the screen, not covered by it: the topmost element at the
    // button's centre must be the button (or its icon), not the CRT's output canvas.
    const r = down!.getBoundingClientRect();
    expect(r.width, "pager has no layout box").toBeGreaterThan(0);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    expect(
      down!.contains(hit),
      `CRT output is covering the pager — topmost element was ${hit?.nodeName}`,
    ).toBe(true);

    await page.elementLocator(host).screenshot({ path: "viz-gallery/board-pager.png" });

    const canvas = host.querySelector("canvas")!;
    const before = canvas.getAttribute("aria-label") ?? "";
    down!.click();
    await new Promise((r2) => setTimeout(r2, 400));
    const after = canvas.getAttribute("aria-label") ?? "";
    expect(after, "clicking the pager did not move the board").not.toBe(before);
  } finally {
    drop();
  }
});

// Hand paging clamps; only the unattended drift loops. The rail between the arrows is a
// scrollbar, and a thumb resting at the bottom has to mean there is nothing below it.
test("paging clamps at both ends instead of wrapping", { timeout: 90000 }, async () => {
  await page.viewport(1000, 620);
  feed = startVizFeed();
  playback.samples = Array.from({ length: 24 }, (_, i) => `line number ${i} of the message`);
  playback.instruments = [];

  host = stage();
  app = mount(ScrollerBoard, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 6000));

  const canvas = host.querySelector("canvas")!;
  const up = host.querySelector('button[aria-label="Previous lines"]') as HTMLButtonElement;
  const down = host.querySelector('button[aria-label="Next lines"]') as HTMLButtonElement;
  expect(up && down, "pager did not render").toBeTruthy();

  // Starts at the top, so back is already the end of the road.
  expect(up.disabled, "up should be disabled at the top of the script").toBe(true);
  expect(down.disabled, "down should be live at the top of a long script").toBe(false);
  const head = canvas.getAttribute("aria-label") ?? "";
  up.click();
  await new Promise((r) => setTimeout(r, 300));
  expect(canvas.getAttribute("aria-label"), "up wrapped to the end from the top").toBe(head);

  // Page to the bottom. More clicks than there are lines, to prove it stops rather than
  // rolling over — 60 steps through a ~50-line script would wrap more than once.
  for (let i = 0; i < 60; i++) down.click();
  await new Promise((r) => setTimeout(r, 600));

  expect(down.disabled, "down should be disabled at the end of the script").toBe(true);
  expect(up.disabled, "up should be live once away from the top").toBe(false);
  const tail = canvas.getAttribute("aria-label") ?? "";
  expect(tail, "60 clicks wrapped back around to the head").not.toBe(head);
  down.click();
  await new Promise((r) => setTimeout(r, 300));
  expect(canvas.getAttribute("aria-label"), "down moved past the end").toBe(tail);
});

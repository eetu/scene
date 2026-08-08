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
// board there is nowhere to scroll to, so it holds still rather than rotating the text
// under the reader.
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

// The pager is a DOM control inside the pane the CRT screen wraps: the screen composites
// canvases and hides the sources, so anything that isn't a canvas has to be deliberately
// placed in front of the glass — and still receive clicks, because the screen's own
// canvas covers the pane.
// The scrollbar is drawn INTO the panel, so the pointer path is what has to work: a tap
// on the last column moves the board. No CRT here on purpose — the app does not mount a
// screen over the mechanical displays (see crtSuits); the cross-package compositing
// contract lives in crt.svelte.test.ts, over a visualiser that ships with one.
test("a tap on the scrollbar column scrolls the board", { timeout: 90000 }, async () => {
  await page.viewport(1000, 620);
  feed = startVizFeed();
  playback.samples = Array.from({ length: 24 }, (_, i) => `line number ${i} of the message`);
  playback.instruments = [];

  host = stage();
  app = mount(ScrollerBoard, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 6000));

  const canvas = host.querySelector("canvas")! as HTMLCanvasElement;
  const box = canvas.getBoundingClientRect();
  const colW = box.width / 27; // matches the board's own sizing at this pane size

  await page.elementLocator(host).screenshot({ path: "viz-gallery/board-pager.png" });

  const before = canvas.getAttribute("aria-label") ?? "";
  canvas.dispatchEvent(
    new PointerEvent("pointerdown", {
      clientX: box.right - colW / 2,
      clientY: box.bottom - 8,
      bubbles: true,
    }),
  );
  await new Promise((r) => setTimeout(r, 400));
  expect(
    canvas.getAttribute("aria-label"),
    "tapping the scrollbar column did not move the board",
  ).not.toBe(before);

  // The control a canvas cannot be: named, focusable, and in the accessibility tree.
  const scrub = host.querySelector("input.scrub") as HTMLInputElement | null;
  expect(scrub, "no range control for the scrollbar").toBeTruthy();
  expect(scrub!.getAttribute("aria-label"), "range has no accessible name").toBeTruthy();
  expect(getComputedStyle(scrub!).visibility, "range is out of the a11y tree").toBe("visible");
});

// Hand scrolling clamps; only the unattended drift loops. The column IS a scrollbar, and
// a thumb resting at the bottom has to mean there is nothing below it.
test("scrolling clamps at both ends instead of wrapping", { timeout: 90000 }, async () => {
  await page.viewport(1000, 620);
  feed = startVizFeed();
  playback.samples = Array.from({ length: 24 }, (_, i) => `line number ${i} of the message`);
  playback.instruments = [];

  host = stage();
  app = mount(ScrollerBoard, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 6000));

  const canvas = host.querySelector("canvas")!;
  const scrub = host.querySelector("input.scrub") as HTMLInputElement;
  expect(scrub, "no range control rendered").toBeTruthy();

  const max = Number(scrub.max);
  expect(max, "range has no travel on a long script").toBeGreaterThan(0);

  const drive = async (value: number) => {
    scrub.value = String(value);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  };

  // Starts at the top, so back is already the end of the road.
  expect(Number(scrub.value), "did not start at the top").toBe(0);
  const head = canvas.getAttribute("aria-label") ?? "";
  await drive(-5);
  expect(canvas.getAttribute("aria-label"), "scrolled above the top").toBe(head);

  // Well past the end, to prove it stops rather than rolling over.
  await drive(max + 40);
  const tail = canvas.getAttribute("aria-label") ?? "";
  expect(tail, "driving past the end wrapped back to the head").not.toBe(head);
  await drive(max + 200);
  expect(canvas.getAttribute("aria-label"), "scrolled past the end").toBe(tail);
});

// The column has to SHOW the position, not just carry it: arrows at the ends and a thumb
// that moves. Read off the board's own target characters rather than pixels.
test("the scrollbar column draws arrows and a moving thumb", { timeout: 90000 }, async () => {
  await page.viewport(1000, 620);
  feed = startVizFeed();
  playback.samples = Array.from({ length: 24 }, (_, i) => `line number ${i} of the message`);
  playback.instruments = [];

  host = stage();
  app = mount(ScrollerBoard, { target: host, props: { active: true } });
  await new Promise((r) => setTimeout(r, 6000));

  const canvas = host.querySelector("canvas")!;
  const label = () => canvas.getAttribute("aria-label") ?? "";
  const scrub = host.querySelector("input.scrub") as HTMLInputElement;

  // The label carries the board's shown text, last column included, so the arrows and
  // thumb are readable from it without reaching into the canvas.
  const top = label();
  expect(top, "no up arrow drawn").toContain("\u25b2");
  expect(top, "no down arrow drawn").toContain("\u25bc");
  expect(top, "no thumb drawn").toContain("\u2588");

  // Move to the end; the thumb must be somewhere else in the column than it was.
  const thumbRows = (text: string) =>
    text
      .split(" / ")
      .map((line, i) => (line.trimEnd().endsWith("\u2588") ? i : -1))
      .filter((i) => i >= 0)
      .join(",");
  const atTop = thumbRows(top);
  scrub.value = scrub.max;
  scrub.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  expect(thumbRows(label()), `thumb did not move (was rows ${atTop})`).not.toBe(atTop);
});

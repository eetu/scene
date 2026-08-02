// The faceplate on its own, big enough to read every anode on it. The hi-fi renders the
// plate about 300px wide inside a 960px pane, which is the right size for the scene and
// far too small to review — a legend that has come out as a solid slab, a hole that did
// not knock out, an element sitting on top of its neighbour all look identical at that
// scale. This suite exists to be LOOKED at while working on the layout.
//
// A screenshot suite — see VISUAL in vitest.config.ts. Not part of `yarn test`.
import { page } from "vitest/browser";
import { expect, test } from "vitest";

import { createVfdPanel } from "@glowbox/vfd";

import { createFaceDriver, type FaceInput, PANEL_FRAME, panelLayout, VFD_FACES } from "../vfd-face";
import { startVizFeed } from "./viz-feed";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("every face of the plate, at reading size", { timeout: 300000 }, async () => {
  await page.viewport(1280, 320);
  const feed = startVizFeed();

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:0;top:0;width:1280px;height:256px;display:block";
  document.body.style.margin = "0";
  document.body.style.background = "#05070a";
  document.body.appendChild(canvas);

  const input: FaceInput = {
    title: "A VERY LONG MODULE TITLE THAT MARCHES",
    message: "GREETINGS TO EVERYONE STILL READING SAMPLE SLOTS IN 2026",
    elapsed: 95,
    counter: "0432",
    playing: true,
    paused: false,
    vu: [0.9, 0.4, 0.6, 0.8, 0.3, 0.7, 0.5, 0.2],
    mono: false,
    repeat: true,
    shuffle: false,
  };

  for (const face of VFD_FACES) {
    const panel = createVfdPanel(canvas, {
      frame: PANEL_FRAME,
      layout: panelLayout(face.id),
      phosphor: "zn-o",
      filter: "green",
      persistence: 0.12,
      glow: 0.75,
      bezel: "#101216",
      selfTest: false,
      label: `${face.id} face`,
    });
    expect(panel, `${face.id}: createVfdPanel returned null`).toBeTruthy();
    const driver = createFaceDriver();
    // A few frames so the analyser's attack settles and the ticker has moved off zero.
    for (let i = 0; i < 40; i++) {
      driver.furniture(panel!, face.id, 1 / 60, input);
      driver.window(panel!, face.id, 1 / 60, input);
      await sleep(16);
    }
    await page.screenshot({
      element: (page as unknown as { elementLocator: (e: Element) => unknown }).elementLocator(
        canvas,
      ) as never,
      path: `vfd-plate/${face.id}.png`,
    } as never);
    panel!.dispose();
  }

  canvas.remove();
  feed.stop();
});

// The character faces at a size where a wrong segment mask is obvious. Two of this
// visualiser's four displays are segment fields, so what the repertoire actually looks
// like is not a detail — and a 12-character title field 300px wide will not show you that
// a letter is upside down.
test("the segment repertoires, big", { timeout: 300000 }, async () => {
  await page.viewport(1400, 260);
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:0;top:0;width:1400px;height:240px;display:block";
  document.body.style.margin = "0";
  document.body.style.background = "#05070a";
  document.body.appendChild(canvas);

  const ROWS = [
    "ABCDEFGHIJKLM",
    "NOPQRSTUVWXYZ",
    "0123456789+-*",
    // The letters built from diagonals, which are the ones a 14/16-segment face gets wrong
    // and the ones a 13-across sheet is too small to judge. V has been drawn as a Λ, as a Y
    // and as a checkmark across three releases; each time the small sheet looked plausible.
    "  UVWXY  ",
  ];
  for (const glyphs of ["14seg", "16seg", "7seg"] as const) {
    const panel = createVfdPanel(canvas, {
      frame: [280, 200],
      layout: ROWS.map((row, i) => ({
        kind: "digits" as const,
        name: `r${i}`,
        chars: row.length,
        glyphs,
        x: 10,
        y: 8 + i * 48,
        w: 260,
        h: 40,
      })),
      phosphor: "zn-o",
      // No tint and no mesh: this sheet is about the glyph shapes, and both of those exist
      // to make the panel look like hardware rather than to make it legible.
      filter: "none",
      grid: false,
      filament: false,
      persistence: 0,
      selfTest: false,
      label: "",
    });
    expect(panel, `${glyphs}: createVfdPanel returned null`).toBeTruthy();
    ROWS.forEach((r, i) => panel!.set(`r${i}`, r));
    await sleep(300);
    await page.screenshot({
      element: (page as unknown as { elementLocator: (e: Element) => unknown }).elementLocator(
        canvas,
      ) as never,
      path: `vfd-plate/glyphs-${glyphs}.png`,
    } as never);
    panel!.dispose();
  }
  canvas.remove();
});

// The point and the colon, one cell tall. The README gives them a section of their own, so
// where they land relative to the glyph is worth being able to see.
test("the point and the colon, big enough to place", { timeout: 120000 }, async () => {
  await page.viewport(900, 260);
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:0;top:0;width:900px;height:240px;display:block";
  document.body.style.margin = "0";
  document.body.style.background = "#05070a";
  document.body.appendChild(canvas);

  const panel = createVfdPanel(canvas, {
    frame: [150, 40],
    layout: [
      { kind: "digits", name: "a", chars: 5, glyphs: "7seg", x: 6, y: 4, w: 68, h: 32 },
      { kind: "digits", name: "b", chars: 5, glyphs: "14seg", x: 78, y: 4, w: 68, h: 32 },
    ],
    filter: "none",
    grid: false,
    filament: false,
    persistence: 0,
    selfTest: false,
    label: "",
  })!;
  expect(panel).toBeTruthy();
  panel.set("a", "12:34");
  panel.set("b", "98.76");
  await sleep(300);
  await page.screenshot({
    element: (page as unknown as { elementLocator: (e: Element) => unknown }).elementLocator(
      canvas,
    ) as never,
    path: "vfd-plate/punctuation.png",
  } as never);
  panel.dispose();
  canvas.remove();
});

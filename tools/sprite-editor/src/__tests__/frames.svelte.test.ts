// The frame strip. Its one real failure mode is a stale thumbnail: the art is
// painted to a canvas, so nothing in the DOM says which frame — or which
// sprite — a thumbnail is actually showing. These read the pixels back.
import { mount, unmount } from "svelte";
import { expect, test } from "vitest";
import { page } from "vitest/browser";

import App from "../App.svelte";
import { editor, loadSprite } from "../lib/editor.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RED = {
  name: "red",
  w: 2,
  h: 2,
  palette: { A: "#ff0000" },
  frames: [
    ["A.", ".."],
    ["..", ".A"],
  ],
};
const BLUE = { name: "blue", w: 2, h: 2, palette: { B: "#0000ff" }, frames: [["BB", "BB"]] };

/** A pixel of the nth frame thumbnail, as `r,g,b,a`.
 *
 *  Selected from inside the strip rather than by position among all canvases:
 *  the app grew a preview canvas between the drawing surface and the strip, and
 *  a positional index quietly started reading the wrong one. */
function thumbPixel(host: HTMLElement, n: number, x: number, y: number) {
  const c = [...host.querySelectorAll("ol li canvas")][n] as HTMLCanvasElement;
  const g = c.getContext("2d")!;
  return [...g.getImageData(x, y, 1, 1).data];
}

test("each thumbnail shows its own frame, and follows a sprite change", async () => {
  await page.viewport(1200, 800);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.appendChild(host);
  const app = mount(App, { target: host });
  await sleep(40);

  loadSprite(structuredClone(RED), "red.json");
  await sleep(60);
  // Frame 1 has its pixel top-left, frame 2 bottom-right — a shared painter
  // would show the same art in both.
  expect(thumbPixel(host, 0, 0, 0)).toEqual([255, 0, 0, 255]);
  expect(thumbPixel(host, 0, 1, 1)).toEqual([0, 0, 0, 0]);
  expect(thumbPixel(host, 1, 0, 0)).toEqual([0, 0, 0, 0]);
  expect(thumbPixel(host, 1, 1, 1)).toEqual([255, 0, 0, 255]);

  // Open a different sprite: the strip must repaint, not keep the old art.
  loadSprite(structuredClone(BLUE), "blue.json");
  await sleep(60);
  expect(editor.sprite.frames).toHaveLength(1);
  expect(thumbPixel(host, 0, 0, 0)).toEqual([0, 0, 255, 255]);

  unmount(app);
  host.remove();
});

test("drawing repaints the thumbnail of the frame being drawn on", async () => {
  await page.viewport(1200, 800);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.appendChild(host);
  const app = mount(App, { target: host });
  loadSprite(structuredClone(BLUE), "blue.json");
  await sleep(60);
  expect(thumbPixel(host, 0, 0, 0)).toEqual([0, 0, 255, 255]);

  editor.tool = "eraser";
  const canvas = host.querySelector("canvas")!;
  const r = canvas.getBoundingClientRect();
  const opts = {
    bubbles: true,
    pointerId: 1,
    pointerType: "mouse",
    clientX: r.left + r.width * 0.25,
    clientY: r.top + r.height * 0.25,
  };
  canvas.dispatchEvent(new PointerEvent("pointerdown", opts));
  canvas.dispatchEvent(new PointerEvent("pointerup", opts));
  await sleep(60);
  expect(thumbPixel(host, 0, 0, 0)).toEqual([0, 0, 0, 0]);

  unmount(app);
  host.remove();
});

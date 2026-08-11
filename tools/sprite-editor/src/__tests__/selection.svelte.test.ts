// The selection tool, driven through the canvas the way a hand drives it.
//
// What is only checkable here is the gesture split: a press that never leaves
// its cell picks the shape under it, a press with travel draws a box, and a
// press that starts inside a selection carries it. The block operations
// themselves (lift, put down) are tested in @scene/player, where they live.
import { mount, unmount } from "svelte";
import { beforeEach, expect, test } from "vitest";

import App from "../App.svelte";
import {
  clearSelection,
  copySelection,
  deleteSelection,
  editor,
  hasSelection,
  loadSprite,
  pasteClipboard,
  selection,
  undoEdit,
} from "../lib/editor.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A 8×6 sprite with a 2×2 red block at (1,1) and a single pixel at (6,4). */
const sprite = () => ({
  name: "blocks",
  w: 8,
  h: 6,
  palette: { R: "#ff0000", B: "#0000ff" },
  frames: [["........", ".RR.....", ".RR.....", "........", "......B.", "........"]],
});

async function mountApp() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.appendChild(host);
  const app = mount(App, { target: host });
  await sleep(40);
  loadSprite(structuredClone(sprite()), "blocks.json");
  editor.tool = "select";
  clearSelection();
  await sleep(60);
  return {
    host,
    stop: () => {
      unmount(app);
      host.remove();
    },
  };
}

function centre(host: HTMLElement, x: number, y: number) {
  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("no canvas");
  const r = canvas.getBoundingClientRect();
  return {
    clientX: r.left + ((x + 0.5) / editor.sprite.w) * r.width,
    clientY: r.top + ((y + 0.5) / editor.sprite.h) * r.height,
  };
}

/** Press, optionally travel through the given cells, release. */
async function drag(host: HTMLElement, path: [number, number][]) {
  const canvas = host.querySelector("canvas")!;
  const base = { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 };
  canvas.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...centre(host, ...path[0]) }));
  for (const step of path.slice(1)) {
    canvas.dispatchEvent(new PointerEvent("pointermove", { ...base, ...centre(host, ...step) }));
    await sleep(10);
  }
  const last = path[path.length - 1];
  canvas.dispatchEvent(new PointerEvent("pointerup", { ...base, ...centre(host, ...last) }));
  await sleep(30);
}

const rows = () => editor.sprite.frames[0];

let app: { host: HTMLElement; stop: () => void };
beforeEach(async () => {
  app = await mountApp();
  return () => app.stop();
});

test("a click picks the connected shape under it", async () => {
  await drag(app.host, [[1, 1]]);
  expect(hasSelection()).toBe(true);
  // The 2×2 block, and nothing else.
  expect(selection.cells.size).toBe(4);
  expect([selection.x0, selection.y0, selection.x1, selection.y1]).toEqual([1, 1, 2, 2]);
});

test("a click ignores colour: one shape, however many colours are in it", async () => {
  loadSprite(
    {
      name: "mixed",
      w: 8,
      h: 6,
      palette: { R: "#ff0000", B: "#0000ff" },
      frames: [["........", ".RRB....", ".RBB....", "........", "......B.", "........"]],
    },
    "mixed.json",
  );
  editor.tool = "select";
  await sleep(60);
  await drag(app.host, [[1, 1]]);
  // Six cells across two colours — and NOT the lone pixel at (6,4), which is a
  // different shape however much it shares a colour with this one.
  expect(selection.cells.size).toBe(6);
  expect([selection.x0, selection.y0, selection.x1, selection.y1]).toEqual([1, 1, 3, 2]);
});

test("a click on empty space drops the selection rather than selecting nothing", async () => {
  await drag(app.host, [[1, 1]]);
  expect(hasSelection()).toBe(true);
  await drag(app.host, [[5, 5]]);
  expect(hasSelection()).toBe(false);
});

test("a drag picks the box it drew", async () => {
  await drag(app.host, [
    [4, 3],
    [6, 4],
  ]);
  expect(selection.cells.size).toBe(6); // 3 wide, 2 tall
  expect([selection.x0, selection.y0, selection.x1, selection.y1]).toEqual([4, 3, 6, 4]);
});

test("dragging a selection moves its pixels, and the whole drag is one undo", async () => {
  await drag(app.host, [[1, 1]]); // pick the block
  const before = rows().join("\n");
  await drag(app.host, [
    [1, 1],
    [2, 1],
    [3, 1],
  ]);
  // Moved two to the right: the old cells are transparent, the new ones red.
  expect(rows()[1]).toBe("...RR...");
  expect(rows()[2]).toBe("...RR...");
  // And the marquee travelled with it.
  expect([selection.x0, selection.x1]).toEqual([3, 4]);
  undoEdit();
  expect(rows().join("\n")).toBe(before);
});

test("a moved block leaves nothing behind, holes included", async () => {
  // Select a box bigger than the shape, so the block carries transparent cells.
  await drag(app.host, [
    [0, 0],
    [3, 3],
  ]);
  await drag(app.host, [
    [1, 1],
    [1, 2],
    [1, 3],
  ]);
  // The block moved down two: row 1 is empty, rows 3 and 4 hold it.
  expect(rows()[1]).toBe("........");
  expect(rows()[3]).toBe(".RR.....");
  expect(rows()[4]).toBe(".RR...B.");
});

test("delete clears the selected cells only", async () => {
  await drag(app.host, [[1, 1]]);
  deleteSelection();
  expect(rows()[1]).toBe("........");
  expect(rows()[4]).toBe("......B."); // the lone pixel is untouched
});

test("copy and paste puts the block down where the selection is", async () => {
  await drag(app.host, [[1, 1]]);
  copySelection();
  // Move the marquee to an empty patch and paste there.
  await drag(app.host, [
    [5, 0],
    [6, 1],
  ]);
  pasteClipboard();
  expect(rows()[0]).toBe(".....RR.");
  expect(rows()[1]).toBe(".RR..RR.");
  // The paste is selected, ready to be dragged.
  expect([selection.x0, selection.y0]).toEqual([5, 0]);
});

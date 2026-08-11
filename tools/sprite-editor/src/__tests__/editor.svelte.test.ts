// The editor, in a real browser: mount it, draw on it, and check the document
// it would save. The format's own rules are tested in @scene/player — what is
// only checkable here is that a pointer landing on a canvas cell ends up as the
// right character in the right row.
import { cloneSprite, toJson } from "@scene/player/sprite-file";
import { mount, unmount } from "svelte";
import { beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";

import App from "../App.svelte";
import { addColour, editor, loadSprite, newSprite, undoEdit } from "../lib/editor.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mountApp() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.appendChild(host);
  const app = mount(App, { target: host });
  // Wait for layout: a click against a canvas that has not been laid out yet
  // maps to NaN and lands nowhere, which looks exactly like a broken tool.
  await sleep(40);
  return {
    host,
    stop: () => {
      unmount(app);
      host.remove();
    },
  };
}

/** Click a sprite pixel through the real canvas, the way a hand would. */
async function clickCell(host: HTMLElement, x: number, y: number) {
  const canvas = host.querySelector("canvas");
  if (!canvas) throw new Error("no canvas");
  const r = canvas.getBoundingClientRect();
  const cx = r.left + ((x + 0.5) / editor.sprite.w) * r.width;
  const cy = r.top + ((y + 0.5) / editor.sprite.h) * r.height;
  const opts = { bubbles: true, pointerId: 1, pointerType: "mouse", clientX: cx, clientY: cy };
  canvas.dispatchEvent(new PointerEvent("pointerdown", opts));
  canvas.dispatchEvent(new PointerEvent("pointerup", opts));
  await sleep(20);
}

beforeEach(() => {
  newSprite("test", 8, 6);
});

test("a click paints the pixel under the cursor, and undo takes it back", async () => {
  await page.viewport(1200, 800);
  const { host, stop } = await mountApp();
  addColour("#ff0000");
  editor.ink = "A";
  editor.tool = "pencil";

  await clickCell(host, 3, 2);
  expect(editor.sprite.frames[0][2]).toBe("...A....");
  // Every other row untouched — an off-by-one in the row index would still
  // paint something and still look plausible on screen.
  expect(editor.sprite.frames[0][1]).toBe("........");
  expect(editor.dirty).toBe(true);

  undoEdit();
  expect(editor.sprite.frames[0][2]).toBe("........");
  stop();
});

test("the eraser puts transparency back without touching the palette", async () => {
  await page.viewport(1200, 800);
  const { host, stop } = await mountApp();
  loadSprite(
    { name: "t", w: 4, h: 2, palette: { A: "#00ff00" }, frames: [["AAAA", "AAAA"]] },
    "t.json",
  );
  editor.tool = "eraser";
  await clickCell(host, 1, 0);
  expect(editor.sprite.frames[0][0]).toBe("A.AA");
  expect(editor.sprite.palette).toEqual({ A: "#00ff00" });
  stop();
});

test("fill floods the connected run only", async () => {
  await page.viewport(1200, 800);
  const { host, stop } = await mountApp();
  loadSprite(
    {
      name: "t",
      w: 4,
      h: 3,
      palette: { A: "#00ff00", B: "#0000ff" },
      frames: [["..B.", "..B.", "..B."]],
    },
    "t.json",
  );
  editor.ink = "A";
  editor.tool = "fill";
  await clickCell(host, 0, 0);
  // Left of the wall filled, right of it untouched.
  expect(editor.sprite.frames[0]).toEqual(["AAB.", "AAB.", "AAB."]);
  stop();
});

test("a dragged rectangle previews before it is committed", async () => {
  await page.viewport(1200, 800);
  const { host, stop } = await mountApp();
  addColour("#ffffff");
  editor.ink = "A";
  editor.tool = "rect";
  const canvas = host.querySelector("canvas")!;
  const r = canvas.getBoundingClientRect();
  const at = (x: number, y: number) => ({
    bubbles: true,
    pointerId: 1,
    pointerType: "mouse",
    clientX: r.left + ((x + 0.5) / editor.sprite.w) * r.width,
    clientY: r.top + ((y + 0.5) / editor.sprite.h) * r.height,
  });
  canvas.dispatchEvent(new PointerEvent("pointerdown", at(1, 1)));
  canvas.dispatchEvent(new PointerEvent("pointermove", at(5, 4)));
  await sleep(20);
  // Mid-drag the document is untouched: the box on screen is a preview.
  expect(editor.sprite.frames[0].join("")).not.toContain("A");
  canvas.dispatchEvent(new PointerEvent("pointerup", at(5, 4)));
  await sleep(20);
  expect(editor.sprite.frames[0][1]).toBe(".AAAAA..");
  expect(editor.sprite.frames[0][2]).toBe(".A...A..");
  expect(editor.sprite.frames[0][4]).toBe(".AAAAA..");
  stop();
});

test("a sprite held in state can still be copied and serialised", () => {
  // Everything in $state is a deep proxy, and structuredClone refuses a proxy
  // outright — which is how opening a sprite from the file list threw
  // DataCloneError. Every copy in this app goes through cloneSprite instead,
  // which reads field by field, straight through the proxy.
  const source = {
    name: "proxied",
    w: 3,
    h: 2,
    palette: { A: "#ff0000" },
    frames: [["A..", ".A."]],
  };
  loadSprite(source, "proxied.json");
  expect(() => structuredClone(editor.sprite)).toThrow();

  const copy = cloneSprite(editor.sprite);
  expect(copy).toEqual(source);
  expect(() => structuredClone(copy)).not.toThrow();
  // …and a proxy still serialises, so Save works on the open document.
  expect(toJson(editor.sprite)).toContain('"A.."');

  // The copy is detached: editing it must not reach back into the document.
  copy.frames[0][0] = "...";
  expect(editor.sprite.frames[0][0]).toBe("A..");
});

test("frames are independent — drawing on one leaves the others alone", async () => {
  await page.viewport(1200, 800);
  const { host, stop } = await mountApp();
  addColour("#ff00ff");
  editor.ink = "A";
  editor.tool = "pencil";
  await clickCell(host, 0, 0);
  const before = editor.sprite.frames[0].join("|");
  // Add a frame and draw somewhere else on it.
  const add = [...host.querySelectorAll("button")].find((b) => b.title.startsWith("Add a blank"));
  add?.click();
  await sleep(20);
  editor.frame = 1;
  await clickCell(host, 4, 3);
  expect(editor.sprite.frames).toHaveLength(2);
  expect(editor.sprite.frames[0].join("|")).toBe(before);
  expect(editor.sprite.frames[1][3][4]).toBe("A");
  stop();
});

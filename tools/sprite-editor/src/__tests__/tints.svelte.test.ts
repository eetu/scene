// Tinted sprites — the signs, the lamps, the gantry.
//
// Their lit cells are `N`/`n`, which are NOT palette entries: the renderer bakes
// the sprite once per tint and colours them from that. Before this the palette
// panel showed those sprites as having no colours at all, so there was nothing
// to paint with and the art could only be edited by hand in the JSON.
import { cellColour, neonColour } from "@scene/player/sprite-file";
import { mount, unmount } from "svelte";
import { expect, test } from "vitest";
import { page } from "vitest/browser";

import App from "../App.svelte";
import { editor, loadSprite, makeTinted } from "../lib/editor.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SIGN = {
  name: "sign",
  w: 2,
  h: 1,
  palette: {},
  tints: ["#ff0000", "#00ff00"],
  frames: [["Nn"]],
};

function boot() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.appendChild(host);
  const app = mount(App, { target: host });
  return { host, stop: () => (unmount(app), host.remove()) };
}

const previewPixel = (host: HTMLElement, x: number) => {
  const c = host.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
  return [...c.getContext("2d")!.getImageData(x, 0, 1, 1).data];
};

test("neon cells are paintable inks, so a tinted sprite can be drawn at all", async () => {
  await page.viewport(1200, 800);
  const { host, stop } = boot();
  loadSprite(structuredClone(SIGN), "sign.json");
  await sleep(60);

  // Both halves of the tube are offered even though the palette is empty.
  const bright = host.querySelector('[aria-label="Neon bright"]') as HTMLButtonElement;
  const dim = host.querySelector('[aria-label="Neon dim"]') as HTMLButtonElement;
  expect(bright).toBeTruthy();
  expect(dim).toBeTruthy();

  bright.click();
  expect(editor.ink).toBe("N");
  editor.tool = "pencil";
  const canvas = host.querySelector("canvas")!;
  const r = canvas.getBoundingClientRect();
  const opts = {
    bubbles: true,
    pointerId: 1,
    pointerType: "mouse",
    clientX: r.left + r.width * 0.75,
    clientY: r.top + r.height * 0.5,
  };
  canvas.dispatchEvent(new PointerEvent("pointerdown", opts));
  canvas.dispatchEvent(new PointerEvent("pointerup", opts));
  await sleep(30);
  // The dim cell became a bright one — a real edit, in the file's own alphabet.
  expect(editor.sprite.frames[0][0]).toBe("NN");
  stop();
});

test("the canvas shows the tint being previewed, and switching tint repaints", async () => {
  await page.viewport(1200, 800);
  const { host, stop } = boot();
  loadSprite(structuredClone(SIGN), "sign.json");
  editor.tint = 0;
  await sleep(60);
  expect(previewPixel(host, 0)).toEqual([255, 0, 0, 255]);

  // Tint 2 is green: the same pixels, baked the other way.
  (host.querySelector('[aria-label="Preview tint 2"]') as HTMLButtonElement).click();
  await sleep(60);
  expect(editor.tint).toBe(1);
  expect(previewPixel(host, 0)).toEqual([0, 255, 0, 255]);
  stop();
});

test("the dim half is the bake's own dim, not an editor approximation", () => {
  // Both sides call the same function, so a sign that looks right in the editor
  // looks the same in the scene.
  expect(cellColour(SIGN, "N", 0)).toBe("#ff0000");
  expect(cellColour(SIGN, "n", 0)).toBe(neonColour("#ff0000", "n"));
  expect(cellColour(SIGN, "n", 1)).toBe(neonColour("#00ff00", "n"));
  // A sprite with no tints still has to render something rather than nothing.
  expect(cellColour({ ...SIGN, tints: undefined }, "N", 0)).toBe("#ff3bd4");
});

test("a plain sprite can be made tintable, which is what unlocks the neon inks", async () => {
  await page.viewport(1200, 800);
  const { host, stop } = boot();
  loadSprite(
    { name: "plain", w: 1, h: 1, palette: { A: "#ffffff" }, frames: [["A"]] },
    "plain.json",
  );
  await sleep(60);
  expect(host.querySelector('[aria-label="Neon bright"]')).toBe(null);

  makeTinted();
  await sleep(60);
  expect(editor.sprite.tints).toEqual(["#ff3bd4", "#39f6ff"]);
  expect(host.querySelector('[aria-label="Neon bright"]')).toBeTruthy();
  stop();
});

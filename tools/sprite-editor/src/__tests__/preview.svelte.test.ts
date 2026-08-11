// The preview window. It is the only place the animation can actually be
// judged, so what matters is that it really cycles the frames — and that it
// and the frame strip are never showing different ones.
import { mount, unmount } from "svelte";
import { expect, test } from "vitest";
import { page } from "vitest/browser";

import App from "../App.svelte";
import { editor, loadSprite } from "../lib/editor.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Three frames, each a different colour, so a pixel read says which is up.
const FLASH = {
  name: "flash",
  w: 1,
  h: 1,
  palette: { A: "#ff0000", B: "#00ff00", C: "#0000ff" },
  frames: [["A"], ["B"], ["C"]],
};
const STILL = { name: "still", w: 1, h: 1, palette: { A: "#ff0000" }, frames: [["A"]] };

function boot() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.appendChild(host);
  const app = mount(App, { target: host });
  return { host, stop: () => (unmount(app), host.remove()) };
}

/** The preview's own canvas.
 *
 *  By test id, not by class: the drawing pane has a `.stage` too, and picking
 *  the first one silently read the main canvas — which shows the frame being
 *  edited, so a preview that never advanced would have looked fine. */
const previewPixel = (host: HTMLElement) => {
  const c = host.querySelector('[data-testid="preview"]') as HTMLCanvasElement;
  return [...c.getContext("2d")!.getImageData(0, 0, 1, 1).data];
};

test("the preview cycles the frames while playing, and the strip follows it", async () => {
  await page.viewport(1200, 800);
  const { host, stop } = boot();
  loadSprite(structuredClone(FLASH), "flash.json");
  editor.fps = 30;
  await sleep(60);

  // Stopped, it shows the frame being edited — so it doubles as a clean look
  // at the current frame, without the grid over it.
  editor.frame = 2;
  await sleep(60);
  expect(previewPixel(host)).toEqual([0, 0, 255, 255]);

  editor.playing = true;
  editor.playhead = 0;
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    await sleep(20);
    seen.add(previewPixel(host).join(","));
    // Whatever the preview is showing, the strip's highlight agrees with it.
    expect(editor.playhead % 3).toBe(editor.playhead % editor.sprite.frames.length);
  }
  editor.playing = false;
  // All three frames came up — a preview stuck on one would collect one entry.
  expect(seen.size).toBe(3);
  stop();
});

test("a single-frame sprite cannot be played", async () => {
  await page.viewport(1200, 800);
  const { host, stop } = boot();
  loadSprite(structuredClone(STILL), "still.json");
  await sleep(60);
  const play = [...host.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "Play",
  );
  expect(play?.disabled).toBe(true);
  stop();
});

// What this app relies on @glowbox/crt's element mode to do, checked against the
// package directly (no visualisers involved) so a version bump that breaks any of it
// fails here rather than showing up as a black or half-empty viz pane. Requires 1.4.0
// or newer.
import { page } from "vitest/browser";
import { expect, test } from "vitest";

import { createCrtScreen } from "@glowbox/crt";

import { grab } from "./viz-shots";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeCanvas(fill: string, css: string, w = 320, h = 180): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.style.cssText = css + ";display:block";
  const g = c.getContext("2d")!;
  g.fillStyle = fill;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

/**
 * Count pixels matching `pick` in a SCREENSHOT of `el`.
 *
 * Screenshot, not drawImage on the output canvas: the screen's output is WebGL
 * without preserveDrawingBuffer, so reading it back after presentation yields an
 * empty buffer and everything measures as absent — including content that is plainly
 * on screen. That false negative invalidated an earlier round of this diagnosis.
 */
async function count(
  el: HTMLElement,
  pick: (r: number, g: number, b: number) => boolean,
): Promise<number> {
  const img = await grab(
    (page as unknown as { elementLocator: (e: Element) => unknown }).elementLocator(el),
    null,
  );
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (pick(img.data[i], img.data[i + 1], img.data[i + 2])) n++;
  }
  return n;
}

const isTeal = (r: number, g: number, b: number) => g > 70 && b > 60 && g > r + 30;
const isRed = (r: number, g: number, b: number) => r > 80 && r > g + 30 && r > b + 30;

function host(): HTMLElement {
  const h = document.createElement("div");
  h.style.cssText = "position:fixed;inset:0;overflow:hidden;background:#000";
  document.body.appendChild(h);
  return h;
}

test("element mode composites late, swapped and nested canvases", { timeout: 180000 }, async () => {
  await page.viewport(960, 560);
  const out: string[] = [];

  // ---- A: two canvases present before creation -----------------------------
  {
    const h = host();
    const big = makeCanvas("#803010", "position:absolute;inset:0;width:100%;height:100%");
    const small = makeCanvas("#20e0c0", "position:absolute;right:60px;bottom:60px", 33, 50);
    h.appendChild(big);
    h.appendChild(small);
    await sleep(60);
    const s = createCrtScreen(h)!;
    await sleep(500);
    out.push(
      `A both-before-create: bigHidden=${big.style.visibility} smallHidden=${small.style.visibility} ` +
        `outRed=${await count(h, isRed)} outTeal=${await count(h, isTeal)} (expect both > 0)`,
    );
    s.dispose();
    h.remove();
  }

  // ---- B1: canvas appears after creation -----------------------------------
  {
    const h = host();
    await sleep(30);
    const s = createCrtScreen(h)!; // nothing to composite yet
    await sleep(200);
    const late = makeCanvas("#803010", "position:absolute;inset:0;width:100%;height:100%");
    h.appendChild(late);
    await sleep(700); // well past any observer/rAF coalescing
    out.push(
      `B1 canvas-after-create: lateHidden=${late.style.visibility || "(unset)"} ` +
        `outRed=${await count(h, isRed)} (expect > 0)`,
    );
    s.dispose();
    h.remove();
  }

  // ---- B2: canvas swapped after creation (a visualiser change) -------------
  {
    const h = host();
    const first = makeCanvas("#803010", "position:absolute;inset:0;width:100%;height:100%");
    h.appendChild(first);
    await sleep(60);
    const s = createCrtScreen(h)!;
    await sleep(400);
    const beforeSwap = await count(h, isRed);
    first.remove();
    const second = makeCanvas("#20e0c0", "position:absolute;inset:0;width:100%;height:100%");
    h.appendChild(second);
    await sleep(700);
    out.push(
      `B2 canvas-swapped: outRedBeforeSwap=${beforeSwap} ` +
        `secondHidden=${second.style.visibility || "(unset)"} ` +
        `outTealAfterSwap=${await count(h, isTeal)} (expect > 0)`,
    );
    s.dispose();
    h.remove();
  }

  // ---- C: created before the host has been laid out ------------------------
  // The creation-order race behind a black pane: the screen is created from an
  // effect that runs before layout, so the container is 0x0 at that moment.
  {
    const h = host();
    h.style.width = "0px";
    h.style.height = "0px";
    h.style.inset = "auto";
    const c = makeCanvas("#803010", "position:absolute;inset:0;width:100%;height:100%");
    h.appendChild(c);
    const s = createCrtScreen(h)!;
    await sleep(200);
    // Now give the pane its real size, as a flex layout would a frame later.
    h.style.width = "";
    h.style.height = "";
    h.style.inset = "0";
    await sleep(800);
    out.push(`C created-before-layout: outRed=${await count(h, isRed)} (expect > 0)`);
    s.dispose();
    h.remove();
  }

  // ---- D: a small canvas NESTED the way the dancer's readout digits are --------
  // .display (CSS background, transform, z-index, pointer-events:none)
  //   > .slot (flex child)
  //     > canvas
  // This is the one structural difference between the readout and case A, which
  // composites fine.
  {
    const h = host();
    const big = makeCanvas("#803010", "position:absolute;inset:0;width:100%;height:100%");
    h.appendChild(big);

    const small = makeCanvas("#20e0c0", "width:33px;height:50px", 33, 50);
    const slot = document.createElement("div");
    slot.style.cssText = "flex:1 1 0;min-width:9px";
    slot.appendChild(small);
    const display = document.createElement("div");
    display.style.cssText =
      "position:absolute;z-index:2;pointer-events:none;right:60px;bottom:60px;" +
      "display:flex;padding:5px;border-radius:10px;background:#06050b;" +
      "transform:translate(1px,6px)";
    display.appendChild(slot);
    h.appendChild(display);

    await sleep(60);
    const s = createCrtScreen(h)!;
    await sleep(600);
    out.push(
      `D nested-in-panel: smallHidden=${small.style.visibility || "(unset)"} ` +
        `outTeal=${await count(h, isTeal)} (expect > 0, case A got 44)`,
    );
    s.dispose();
    h.remove();
  }

  // Every case must have put its content on screen. Counts are pixel areas at the
  // downscaled probe size, so the bars are low — presence is the claim, not amount.
  for (const line of out) expect.soft(line, line).not.toMatch(/=0 /);
});

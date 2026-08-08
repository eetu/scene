// A shakedown of @glowbox/flip-dot against the way this app actually uses it, run
// before the package is released. Not a regression suite for our code — it probes the
// library's edges: teardown, being driven far faster than the hardware it models, and
// whether the optional sound engine costs an AudioContext we didn't ask for.
//
// A screenshot suite — see VISUAL in vitest.config.ts. Not part of `yarn test`.
import { expect, test } from "vitest";

import { createFlipDots } from "@glowbox/flip-dot";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function host(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.style.cssText = "position:fixed;left:0;top:0;width:400px;height:200px;display:block";
  document.body.appendChild(c);
  return c;
}

test("board survives repeated create/dispose", { timeout: 60000 }, async () => {
  const c = host();
  for (let i = 0; i < 20; i++) {
    const b = createFlipDots(c, { cols: 28, rows: 14 });
    expect(b, `cycle ${i}: createFlipDots returned null`).toBeTruthy();
    b!.setFrame((x, y) => (x + y + i) % 3 === 0);
    await sleep(10);
    b!.dispose();
  }
  // dispose() is documented to hand the canvas back clean, so the same element has to be
  // reusable — an app that switches visualisers does exactly this.
  const again = createFlipDots(c, { cols: 28, rows: 14 });
  expect(again, "canvas unusable after 20 dispose cycles").toBeTruthy();
  again!.dispose();
  c.remove();
});

test("driving it far faster than the dots can flip", { timeout: 60000 }, async () => {
  const c = host();
  const b = createFlipDots(c, { cols: 40, rows: 24, flipMs: 70, scanMs: 150 })!;
  expect(b).toBeTruthy();
  // A disc takes 70ms and the sweep 150ms, so this re-targets every dot several times
  // per flip — the pathological case the README warns about. It should degrade into
  // visual mush, not throw, hang, or leave dots stuck edge-on.
  for (let i = 0; i < 200; i++) {
    b.setFrame((x, y) => (x * 7 + y * 13 + i * 3) % 5 < 2);
    await sleep(5);
  }
  // Settle on a known frame and let the flips finish.
  b.clear();
  await sleep(400);
  expect(b.get(0, 0), "clear() did not settle after a fast-drive burst").toBe(false);
  b.fill();
  await sleep(400);
  expect(b.get(0, 0), "fill() did not settle after a fast-drive burst").toBe(true);
  b.dispose();
  c.remove();
});

test("options and geometry can change live", { timeout: 60000 }, async () => {
  const c = host();
  const b = createFlipDots(c, { cols: 28, rows: 14 })!;
  b.fill();
  await sleep(200);
  for (const patch of [
    { shape: "square" as const },
    { shaded: true },
    { stagger: "random" as const },
    { stagger: "none" as const },
    { axis: 45 },
    { onColor: "#f78f08" },
    { onColor: [1, 0.5, 0] as [number, number, number] },
    { gap: 0.3 },
    { flipMs: 0 },
    { cols: 56, rows: 28 },
  ]) {
    b.setOptions(patch);
    await sleep(30);
  }
  // A grid resize has to be reflected, not silently ignored — the app sizes the board
  // from the pane's aspect ratio.
  expect(b.cols, "cols did not follow setOptions").toBe(56);
  expect(b.rows, "rows did not follow setOptions").toBe(28);
  // And addressing the new geometry must not throw or read stale.
  b.set(55, 27, true);
  expect(b.get(55, 27)).toBe(true);
  expect(typeof b.snapshot()).toBe("string");
  b.dispose();
  c.remove();
});

test("out-of-range addressing is ignored rather than fatal", { timeout: 30000 }, async () => {
  const c = host();
  const b = createFlipDots(c, { cols: 10, rows: 5 })!;
  for (const [x, y] of [
    [-1, 0],
    [0, -1],
    [10, 0],
    [0, 5],
    [999, 999],
    [1.5, 2.5],
    [NaN, 0],
  ]) {
    expect(() => b.set(x, y, true), `set(${x},${y}) threw`).not.toThrow();
    expect(() => b.get(x, y), `get(${x},${y}) threw`).not.toThrow();
  }
  b.dispose();
  c.remove();
});

// The one that matters most here: this app already runs an AudioContext for playback, and
// browsers cap how many a page may have. A display core opening its own — especially
// before any user gesture, which the autoplay policy would leave suspended — would be a
// real cost, so check it is lazy.
test("sound does not open an AudioContext until it is used", { timeout: 30000 }, async () => {
  const c = host();
  const Real = window.AudioContext;
  let built = 0;
  class Counting extends Real {
    constructor(...args: ConstructorParameters<typeof Real>) {
      super(...args);
      built++;
    }
  }
  (window as unknown as { AudioContext: typeof Real }).AudioContext =
    Counting as unknown as typeof Real;
  try {
    // Default (no sound) first: that is what this app uses, so it decides whether any of
    // this affects us at all.
    const quiet = createFlipDots(c, { cols: 28, rows: 14 })!;
    quiet.setFrame((x, y) => (x + y) % 2 === 0);
    await sleep(200);
    const afterQuiet = built;
    quiet.dispose();

    // Then with sound on, separating construction from the first flip: a context opened
    // at construction is unconditional, one opened on a flip still arrives without a
    // gesture, since flips come from data.
    const loud = createFlipDots(c, { cols: 28, rows: 14, sound: true })!;
    const afterConstruct = built;
    loud.setFrame((x, y) => (x + y) % 2 === 0);
    await sleep(300);
    const afterFlip = built;
    loud.dispose();
    await sleep(50);
    const afterDispose = built;

    const report = `default=${afterQuiet} construct=${afterConstruct} flip=${afterFlip} dispose=${afterDispose}`;
    // No AudioContext at all without a user gesture — not at construction, and not on a
    // flip, which arrives from data rather than from a gesture. This is what a page that
    // already runs one (this app, for playback) needs from a display core, and browsers
    // cap how many a page may have.
    expect(afterQuiet, `sound:false opened a context — ${report}`).toBe(0);
    expect(afterConstruct, `sound:true allocated at construction — ${report}`).toBe(0);
    expect(afterFlip, `a flip opened an AudioContext with no user gesture — ${report}`).toBe(0);
  } finally {
    (window as unknown as { AudioContext: typeof Real }).AudioContext = Real;
  }
  c.remove();
});

// A shakedown of @glowbox/split-flap against the way this app would actually use it,
// run before the package is released. Not a regression suite for our code — it probes
// the library's edges: teardown, being driven far faster than the hardware it models,
// the drum's handling of text it wasn't carded for, and whether the optional sound
// engine costs an AudioContext we didn't ask for.
//
// A screenshot suite — see VISUAL in vitest.config.ts. Not part of `yarn test`.
import { expect, test } from "vitest";

import {
  createSplitFlap,
  DRUM_ALNUM,
  DRUM_DIGITS,
  DRUM_NORDIC,
  flapIndex,
  flapsOf,
  padCells,
  stepsBetween,
} from "@glowbox/split-flap";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function host(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.style.cssText = "position:fixed;left:0;top:0;width:600px;height:200px;display:block";
  document.body.appendChild(c);
  return c;
}

test("board survives repeated create/dispose", { timeout: 60000 }, async () => {
  const c = host();
  for (let i = 0; i < 20; i++) {
    const b = createSplitFlap(c, { cols: 16, rows: 4 });
    expect(b, `cycle ${i}: createSplitFlap returned null`).toBeTruthy();
    b!.setText([`ROW ${i}`, "DEPARTURES", "TRACKER", "MOD"]);
    await sleep(10);
    b!.dispose();
  }
  // dispose() has to hand the canvas back clean — an app that switches visualisers
  // does exactly this.
  const again = createSplitFlap(c, { cols: 16, rows: 4 });
  expect(again, "canvas unusable after 20 dispose cycles").toBeTruthy();
  again!.dispose();
  c.remove();
});

test("driving it far faster than the flaps can fall", { timeout: 60000 }, async () => {
  const c = host();
  const b = createSplitFlap(c, { cols: 12, rows: 2, flipMs: 90 })!;
  expect(b).toBeTruthy();
  // One flap falls in 90ms and a run is a fall per flap, so a wrap across the 53-flap
  // Nordic drum is ~4.8s. Re-targeting every 5ms re-aims each module dozens of times
  // mid-cascade — the pathological case. It should degrade into visual mush, not
  // throw, hang, or strand a module between flaps.
  const words = ["HELSINKI", "TAMPERE", "OULU", "TURKU", "ROVANIEMI"];
  for (let i = 0; i < 200; i++) {
    b.setText([words[i % words.length], String(i).padStart(4, "0")]);
    await sleep(5);
  }
  // Settle on a known target and let the cascade finish.
  b.setText(["OULU", "0001"]);
  await sleep(3000);
  expect(b.getText()[0], "board did not settle after a fast-drive burst").toBe("OULU");
  expect(b.getChar(0, 0), "module 0 stranded after a fast-drive burst").toBe("O");
  b.clear();
  await sleep(3000);
  expect(b.getText().join(""), "clear() did not settle").toBe("");
  b.dispose();
  c.remove();
});

test("options and geometry can change live", { timeout: 60000 }, async () => {
  const c = host();
  const b = createSplitFlap(c, { cols: 12, rows: 1 })!;
  b.setText("DEPARTURES");
  await sleep(200);
  for (const patch of [
    { shaded: true },
    { gap: 0.3 },
    { card: "#101014" },
    { ink: "#f78f08" },
    { ink: [1, 0.5, 0] as [number, number, number] },
    { font: "monospace" },
    { flipMs: 0 },
    { charset: DRUM_DIGITS },
    { charset: DRUM_NORDIC },
    { cols: 20, rows: 6 },
  ]) {
    b.setOptions(patch);
    await sleep(30);
  }
  // A grid resize has to be reflected, not silently ignored — a viz sizes the board
  // from the pane.
  expect(b.cols, "cols did not follow setOptions").toBe(20);
  expect(b.rows, "rows did not follow setOptions").toBe(6);
  // And addressing the new geometry must not throw or read stale.
  b.setChar(19, 5, "X");
  expect(b.getChar(19, 5)).toBe("X");
  expect(typeof b.snapshot()).toBe("string");
  b.dispose();
  c.remove();
});

test(
  "out-of-range and malformed addressing is ignored rather than fatal",
  { timeout: 30000 },
  async () => {
    const c = host();
    const b = createSplitFlap(c, { cols: 10, rows: 2 })!;
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [10, 0],
      [0, 2],
      [999, 999],
      [1.5, 0.5],
      [NaN, 0],
    ]) {
      expect(() => b.setChar(x, y, "A"), `setChar(${x},${y}) threw`).not.toThrow();
      expect(() => b.getChar(x, y), `getChar(${x},${y}) threw`).not.toThrow();
    }
    // Over-long lines and empty input are the other half: setText is fed whatever a
    // song title happens to be.
    expect(() => b.setText("X".repeat(500)), "over-long line threw").not.toThrow();
    expect(() => b.setText(""), "empty string threw").not.toThrow();
    expect(() => b.setText([]), "empty array threw").not.toThrow();
    expect(() => b.setLine(99, "OFF THE BOARD"), "setLine out of range threw").not.toThrow();
    b.dispose();
    c.remove();
  },
);

// The drum only carries what it was carded with, and this app would feed it module
// titles and scener handles — text nobody sanitised. The library documents the rules
// (uppercase fallback, blank for anything else, NFC-normalised input); this checks
// they hold, because the failure mode is a silently half-blank board.
test("text the drum wasn't carded for", { timeout: 30000 }, async () => {
  const c = host();
  const b = createSplitFlap(c, { cols: 12, rows: 1, charset: DRUM_NORDIC })!;
  const flaps = flapsOf(DRUM_NORDIC);
  const blank = flapIndex(flaps, " ");

  // Lowercase folds to the caps drum rather than blanking.
  expect(flapIndex(flaps, "a"), "lowercase did not fold to uppercase").toBe(flapIndex(flaps, "A"));

  // The library's own artist folders include "Mäkä" and "löylynlyömä", and this mount
  // is macOS SMB — which hands out decomposed (NFD) filenames, where Ä is A + U+0308.
  // A naive lookup blanks those; the docs claim NFC normalisation, so check it.
  // Escapes, not literals: the two forms are visually identical, so written as
  // characters whatever saves this file collapses them into one and the assertion
  // below silently becomes "x equals x".
  const COMPOSED = "\u00C4";
  const DECOMPOSED = "A\u0308";
  expect(COMPOSED === DECOMPOSED, "the two forms must differ to test anything").toBe(false);
  const composed = flapIndex(flaps, COMPOSED);
  const decomposed = flapIndex(flaps, DECOMPOSED);
  expect(composed, "composed Ä is not on the Nordic drum").not.toBe(blank);
  expect(decomposed, "decomposed Ä did not normalise to the same flap").toBe(composed);

  // 1.6.0 added ( ) @ , ' & + to the Nordic drum. That set is not decoration for this
  // app — it is most of what tracker sample text is made of: "don't touch my things",
  // "(c) 1994", "soft&ice", and the email addresses sceners left in their slots. On the
  // 40-flap alnum drum every one of those characters blanks, so pin that they are here.
  for (const ch of ["(", ")", "@", ",", "'", "&", "+", ".", ":", "/", "-", "?", "!"]) {
    expect(flapIndex(flaps, ch), `${ch} is missing from the Nordic drum`).not.toBe(blank);
  }
  // And that they are NOT on the alnum drum — which is why this board picks Nordic.
  const alnum = flapsOf(DRUM_ALNUM);
  const alnumBlank = flapIndex(alnum, " ");
  for (const ch of ["(", "@", "'", "&"]) {
    expect(flapIndex(alnum, ch), `${ch} unexpectedly on the alnum drum`).toBe(alnumBlank);
  }

  // Genuinely un-carded characters blank instead of throwing or printing garbage.
  for (const ch of ["中", "©", "€", "🎵"]) {
    expect(flapIndex(flaps, ch), `${ch} should blank on the Nordic drum`).toBe(blank);
  }

  // padCells is grapheme-aware, so an emoji costs one module, not two code units.
  expect(padCells("AB", 4).length).toBe(4);
  expect(padCells("🎵X", 4)[0]).toBe("🎵");

  // A title with all of it at once must still land, and must not throw.
  expect(() => b.setText("MÄKÄ 🎵 2026"), "mixed text threw").not.toThrow();
  await sleep(100);
  b.dispose();
  c.remove();
});

// The drum turns one way, like the real hardware. If stepsBetween ever went backwards
// the cascade would reverse and the illusion dies, so pin the arithmetic.
test("the drum only turns forward", () => {
  const n = 10;
  expect(stepsBetween(0, 3, n)).toBe(3);
  expect(stepsBetween(3, 0, n), "going back to 0 should wrap, not reverse").toBe(7);
  expect(stepsBetween(4, 4, n), "same flap is no movement").toBe(0);
  for (let from = 0; from < n; from++) {
    for (let to = 0; to < n; to++) {
      const s = stepsBetween(from, to, n);
      expect(s, `stepsBetween(${from},${to}) out of range`).toBeGreaterThanOrEqual(0);
      expect(s, `stepsBetween(${from},${to}) overshoots the drum`).toBeLessThan(n);
      expect((from + s) % n, `stepsBetween(${from},${to}) lands wrong`).toBe(to);
    }
  }
});

// The one that matters most here: this app already runs an AudioContext for playback,
// and browsers cap how many a page may have. The flip-dot core opened one on its first
// data-driven flip, which arrives without a user gesture — this checks split-flap
// shipped with that lesson applied.
test("sound does not open an AudioContext until it is used", { timeout: 30000 }, async (ctx) => {
  // Precondition, not a formality. The library's contract is that sound waits for a user
  // gesture, so "no context yet" is only meaningful while the page has had none. The test
  // harness creates a real activation of its own when an earlier test in this file fails,
  // and that is enough to arm the handler — verified by putting a deliberate failure in
  // front of this measurement on a version with no bug in it and watching it read 1.
  //
  // That is precisely how this probe once reported a phantom regression: a genuine
  // unrelated bug failed an earlier test, the failure armed the audio path, and the flip
  // below opened a context exactly as designed. Skipping is the honest outcome — the
  // question cannot be answered on a page that has already been interacted with.
  if (navigator.userActivation?.hasBeenActive) {
    ctx.skip(
      "page already has user activation (an earlier failure in this file?) — " +
        "the no-gesture precondition is gone, so this cannot measure anything",
    );
  }
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
    // Control: prove the interception works before trusting a zero from it. Without
    // this the whole test passes just as happily if the patch never took effect —
    // an assertion that cannot fail is not evidence.
    const probe = new (window as unknown as { AudioContext: typeof Real }).AudioContext();
    expect(built, "the AudioContext counter is not counting").toBe(1);
    void probe.close();
    built = 0;

    // Default (no sound) first: that is what this app would use, so it decides
    // whether any of this affects us at all.
    const quiet = createSplitFlap(c, { cols: 12, rows: 1 })!;
    quiet.setText("DEPARTURES");
    await sleep(300);
    const afterQuiet = built;
    quiet.dispose();

    // Then with sound on, separating construction from the first flip: a context
    // opened at construction is unconditional, one opened on a flip still arrives
    // without a gesture, since flips come from data.
    const loud = createSplitFlap(c, { cols: 12, rows: 1, sound: true })!;
    const afterConstruct = built;
    loud.setText("ARRIVALS");
    await sleep(500);
    const afterFlip = built;
    loud.dispose();
    await sleep(50);
    const afterDispose = built;

    const report = `default=${afterQuiet} construct=${afterConstruct} flip=${afterFlip} dispose=${afterDispose}`;
    expect(afterQuiet, `sound:false opened a context — ${report}`).toBe(0);
    expect(afterConstruct, `sound:true allocated at construction — ${report}`).toBe(0);
    expect(afterFlip, `a flip opened an AudioContext with no user gesture — ${report}`).toBe(0);
  } finally {
    (window as unknown as { AudioContext: typeof Real }).AudioContext = Real;
  }
  c.remove();
});

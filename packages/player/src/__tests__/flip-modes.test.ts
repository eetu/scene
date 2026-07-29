// The rule that decides what may live on the flip-dot board: how many dots a frame
// re-targets, because that is how many discs are mid-rotation at once.
//
// The board sweeps changes as a 70ms driver scan with a 38ms flip behind it, and takes
// a new frame every ~70ms. The sweep's duration is fixed, so the thing that varies with
// churn is how much of the board is in motion rather than showing a state — light that
// up everywhere at once and the image never resolves. Plasma and a scrolling
// spectrogram are absent from FLIP_MODES for that reason: they re-decide every dot
// every frame by construction.
//
// The budget is calibrated, not derived. `bars` is the reference — it shipped, it is
// known to read well — so the ceiling sits above its real peak with headroom, and this
// test's job is to catch a NEW mode that is dramatically churnier than the one we know
// works. Without it the rule lives only in a comment, and the next mode added is the
// one that quietly breaks it.
import { beforeEach, expect, test } from "vitest";

import { createFlipRenderer, FLIP_MODES } from "../flip-modes";
import { SCOPE_SIZE, setScopeSource, SPECTRUM_SIZE } from "../scope";

const COLS = 40;
const ROWS = 22;
const DOTS = COLS * ROWS;
// Measured on the signal below, peak dots changed per frame: bars 109, scope 163,
// stars 41, rings 196. 40% of the board (352) leaves the busiest mode room on a denser
// track while still failing a full-frame effect by a wide margin — those run 400+.
const BUDGET = Math.round(DOTS * 0.4);

/** A plausible moving signal: a three-band spectrum and a sine through the scope.
 *
 *  Bands move independently, which matters — an earlier version of this fixture applied
 *  one envelope to every bin, so the whole spectrum rose and fell as a block and every
 *  bar on the board moved together. That measured `bars` at nearly twice its real
 *  churn. Music does not do that: a kick moves the bass bins and leaves the treble
 *  where it was. */
function fakeAnalyser(tRef: { t: number }) {
  return {
    context: { sampleRate: 48000 },
    getByteFrequencyData(buf: Uint8Array) {
      const beats = tRef.t * (125 / 60);
      const bass = 0.86 * Math.exp(-(beats % 1) * 5.5) + 0.1;
      const mid = 0.44 + 0.16 * Math.sin((beats / 4) * Math.PI * 2);
      const treble = 0.32 * Math.exp(-((beats * 2) % 1) * 12) + 0.07;
      const hzPerBin = 24000 / buf.length;
      for (let i = 0; i < buf.length; i++) {
        const hz = i * hzPerBin;
        const band = hz < 200 ? bass : hz < 2000 ? mid : treble;
        const rolloff = 1 / (1 + hz / 900);
        buf[i] = Math.min(255, Math.round(band * rolloff * 340));
      }
    },
    // The same three-tone signal viz-feed drives the browser suite with (55/440/3200Hz,
    // phase advancing with wall time), because the scope's cost depends entirely on how
    // triggerable the signal is and a friendlier waveform here would flatter it.
    //
    // Two earlier fixtures were wrong in opposite directions: a pure stationary sine
    // locked so perfectly that churn measured 0 — the assertion stopped testing
    // anything — and a single-partial-plus-noise version had no high harmonic to
    // mislead the trigger, which is exactly the case that broke it on the real feed.
    getByteTimeDomainData(buf: Uint8Array) {
      const beats = tRef.t * (125 / 60);
      const bass = 0.86 * Math.exp(-(beats % 1) * 5.5) + 0.1;
      const mid = 0.44 + 0.16 * Math.sin((beats / 4) * Math.PI * 2);
      const treble = 0.32 * Math.exp(-((beats * 2) % 1) * 12) + 0.07;
      for (let i = 0; i < buf.length; i++) {
        const s = i / 48000;
        const v =
          bass * Math.sin(2 * Math.PI * 55 * (tRef.t + s)) +
          mid * 0.5 * Math.sin(2 * Math.PI * 440 * (tRef.t + s)) +
          treble * 0.3 * Math.sin(2 * Math.PI * 3200 * (tRef.t + s));
        buf[i] = Math.max(0, Math.min(255, Math.round(128 + v * 70)));
      }
    },
  } as unknown as AnalyserNode;
}

const tRef = { t: 0 };

beforeEach(() => {
  tRef.t = 0;
  setScopeSource(fakeAnalyser(tRef));
});

test("every mode stays inside the flip budget", () => {
  const report: string[] = [];
  for (const mode of FLIP_MODES) {
    const r = createFlipRenderer();
    // Warm up so first-frame fill (an empty board lighting up) isn't counted as churn.
    for (let i = 0; i < 5; i++) {
      tRef.t += 0.07;
      r.render(mode.id, COLS, ROWS, 0.07, true, i % 6 === 0);
    }
    let peak = 0;
    let total = 0;
    const frames = 60;
    for (let i = 0; i < frames; i++) {
      tRef.t += 0.07;
      // A beat every ~6 frames at 14Hz / 125bpm, which is when rings spawn.
      r.render(mode.id, COLS, ROWS, 0.07, true, i % 6 === 0);
      peak = Math.max(peak, r.churn);
      total += r.churn;
    }
    const mean = total / frames;
    report.push(`${mode.id}: mean ${mean.toFixed(1)}, peak ${peak} of ${DOTS}`);
    expect(
      peak,
      `${mode.id} re-targets too much of the board — ${report.at(-1)}`,
    ).toBeLessThanOrEqual(BUDGET);
  }
  console.log(report.join("\n"));
});

// Guard the guard: the budget only means something if a full-frame effect would blow
// it. If this ever passes, the measurement is broken rather than the modes being good.
test("a full-frame effect would blow the budget", () => {
  const r = createFlipRenderer();
  // Stand-in for the plasma/spectrogram class: every dot decided afresh each frame.
  let churn = 0;
  const grid = new Uint8Array(DOTS);
  const prev = new Uint8Array(DOTS);
  for (let f = 0; f < 10; f++) {
    prev.set(grid);
    for (let i = 0; i < DOTS; i++) {
      grid[i] = Math.sin(i * 0.7 + f * 1.3) > 0 ? 1 : 0;
    }
    churn = 0;
    for (let i = 0; i < DOTS; i++) if (grid[i] !== prev[i]) churn++;
  }
  expect(churn, "a full-frame effect should exceed the budget").toBeGreaterThan(BUDGET);
  expect(r.churn, "a fresh renderer has drawn nothing yet").toBe(0);
});

test("modes render something and are addressable", () => {
  for (const mode of FLIP_MODES) {
    const r = createFlipRenderer();
    for (let i = 0; i < 10; i++) {
      tRef.t += 0.07;
      r.render(mode.id, COLS, ROWS, 0.07, true, i % 6 === 0);
    }
    let lit = 0;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (r.dot(x, y)) lit++;
    expect(lit, `${mode.id} lit nothing`).toBeGreaterThan(0);
    expect(lit, `${mode.id} lit the whole board`).toBeLessThan(DOTS);
    // Out of range must not throw or read as lit.
    expect(r.dot(-1, 0)).toBe(false);
    expect(r.dot(COLS, 0)).toBe(false);
    expect(r.dot(0, ROWS)).toBe(false);
  }
});

test("a resize re-allocates instead of reading off the old grid", () => {
  const r = createFlipRenderer();
  r.render("bars", COLS, ROWS, 0.07, true, false);
  r.render("bars", 20, 10, 0.07, true, false);
  expect(() => r.dot(19, 9)).not.toThrow();
  expect(r.dot(20, 0), "reading past the new width should be dark").toBe(false);
});

// The onset-detected beat, used for formats with no pattern grid.
//
// A SID has no rows to count, and the chip's ~50Hz interrupt is a *tick* rate,
// not a musical beat — so the pulse ~7 visualisers rely on has to come from the
// audio itself. These pin the two properties that make it usable rather than
// merely present: it adapts to a tune's own loudness, and it doesn't retrigger
// on a single hit's decay.
import { describe, expect, test } from "vitest";

import { BeatTracker } from "../beat";

/** Feed `n` frames of steady `level`, 20ms apart (the ~47Hz chunk cadence). */
function steady(b: BeatTracker, level: number, n: number, t0 = 0): number {
  let t = t0;
  for (let i = 0; i < n; i++) {
    b.energy(level, t);
    t += 20;
  }
  return t;
}

describe("energy onset", () => {
  test("a jump above the running average fires a beat", () => {
    const b = new BeatTracker();
    const t = steady(b, 0.1, 30);
    expect(b.energy(0.9, t)).toBe(true);
  });

  test("steady loudness is not a beat — it's the new normal", () => {
    // A sustained pad must not pulse forever; the average catches up to it.
    const b = new BeatTracker();
    let t = steady(b, 0.5, 60);
    let fired = 0;
    for (let i = 0; i < 40; i++, t += 20) if (b.energy(0.5, t)) fired++;
    expect(fired).toBe(0);
  });

  test("it adapts to the tune's own level, loud or quiet", () => {
    // SID output levels vary enormously between tunes, so a fixed threshold
    // would either miss quiet tunes entirely or strobe on loud ones.
    const quiet = new BeatTracker();
    const tq = steady(quiet, 0.05, 30);
    expect(quiet.energy(0.4, tq), "quiet tune still detects its own hits").toBe(true);

    const loud = new BeatTracker();
    const tl = steady(loud, 0.8, 30);
    expect(loud.energy(0.8, tl), "loud tune doesn't fire on its baseline").toBe(false);
  });

  test("near-silence never fires, however relatively loud", () => {
    // Between tracks, or during a rest, tiny numerical noise is many times its
    // own average — an absolute floor is what stops that reading as a beat.
    const b = new BeatTracker();
    const t = steady(b, 0.0001, 30);
    expect(b.energy(0.01, t)).toBe(false);
  });

  test("a decaying hit fires once, not on every frame of its tail", () => {
    // Without a refractory window the visualisers strobe through a drum's decay.
    const b = new BeatTracker();
    let t = steady(b, 0.1, 30);
    let fired = 0;
    for (const lvl of [0.9, 0.85, 0.8, 0.7, 0.6]) {
      if (b.energy(lvl, t)) fired++;
      t += 20;
    }
    expect(fired).toBe(1);
  });

  test("beats give a plausible tempo and a phase ramp", () => {
    const b = new BeatTracker();
    let t = steady(b, 0.1, 30);
    // Hits every 500ms → 120 BPM.
    for (let i = 0; i < 6; i++) {
      b.energy(0.9, t);
      t = steady(b, 0.1, 24, t + 20); // 480ms of quiet, then the next hit
    }
    expect(b.bpm()).toBeGreaterThan(90);
    expect(b.bpm()).toBeLessThan(150);
    expect(b.phase(t)).toBeGreaterThanOrEqual(0);
    expect(b.phase(t)).toBeLessThanOrEqual(1);
  });

  test("reset clears the learned average", () => {
    const b = new BeatTracker();
    steady(b, 0.8, 40);
    b.reset();
    // With the average cleared, a modest level is once again an onset.
    expect(b.energy(0.3, 1000)).toBe(true);
  });
});

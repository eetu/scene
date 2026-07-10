import { describe, expect, test } from "vitest";

import { BeatTracker } from "../beat";

describe("BeatTracker", () => {
  test("no beat until the first row-0 onset", () => {
    const b = new BeatTracker();
    expect(b.phase(0)).toBe(0);
    expect(b.bpm()).toBe(0);
  });

  test("row divisible by 4 is a beat; others aren't", () => {
    const b = new BeatTracker();
    expect(b.row(0, 0, 0, 1000)).toBe(true); // first beat
    expect(b.row(0, 0, 1, 1100)).toBe(false);
    expect(b.row(0, 0, 2, 1200)).toBe(false);
    expect(b.row(0, 0, 3, 1300)).toBe(false);
    expect(b.row(0, 0, 4, 1400)).toBe(true); // next beat
  });

  test("a repeated (order,pattern,row) doesn't re-trigger", () => {
    const b = new BeatTracker();
    expect(b.row(0, 0, 0, 1000)).toBe(true);
    expect(b.row(0, 0, 0, 1050)).toBe(false); // not advanced
  });

  test("phase ramps 0→1 across the interval and clamps at 1", () => {
    const b = new BeatTracker();
    b.row(0, 0, 0, 1000); // interval defaults to 500
    expect(b.phase(1000)).toBe(0);
    expect(b.phase(1250)).toBeCloseTo(0.5, 5);
    expect(b.phase(1500)).toBe(1);
    expect(b.phase(9999)).toBe(1); // clamped
  });

  test("bpm eases toward the measured inter-beat gap", () => {
    const b = new BeatTracker();
    b.row(0, 0, 0, 1000); // interval 500 → 120 bpm
    expect(b.bpm()).toBeCloseTo(120, 5);
    // Second beat 250ms later: interval += (250-500)*0.25 = 437.5.
    b.row(0, 0, 4, 1250);
    expect(b.bpm()).toBeCloseTo(60000 / 437.5, 5);
  });

  test("implausible gaps (seek/stall) don't move the interval", () => {
    const b = new BeatTracker();
    b.row(0, 0, 0, 1000);
    b.row(0, 0, 4, 1000 + 5000); // 5s gap — out of the 30–2000ms window
    expect(b.bpm()).toBeCloseTo(120, 5); // interval unchanged at 500
  });

  test("reset clears everything", () => {
    const b = new BeatTracker();
    b.row(0, 0, 0, 1000);
    b.reset();
    expect(b.phase(2000)).toBe(0);
    expect(b.bpm()).toBe(0);
  });
});

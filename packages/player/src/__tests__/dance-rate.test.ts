import { describe, expect, it } from "vitest";

import { danceRate } from "../sota-gl";

describe("danceRate", () => {
  it("runs at reference speed when the tempo is unknown", () => {
    expect(danceRate(0)).toBe(1);
  });

  it("scales with tempo around the reference", () => {
    expect(danceRate(125)).toBeCloseTo(1);
    expect(danceRate(90)).toBeLessThan(1);
    expect(danceRate(150)).toBeGreaterThan(1);
  });

  // The point of the whole function: a slow tune must not get a manic dancer.
  it("gives a slow tune a slow dance", () => {
    expect(danceRate(60)).toBeLessThan(0.6);
    expect(danceRate(45)).toBeLessThan(0.5);
  });

  // Onset detection counts events, not beats, so a busy slow pattern reports
  // double or quadruple time. Fold that down rather than dancing to it — but only
  // until the result is plausible for a dance, so 320 lands on 160 (a fast dance)
  // rather than being halved again to 80.
  it("folds implausibly fast detections down to a danceable tempo", () => {
    expect(danceRate(240)).toBeCloseTo(danceRate(120));
    expect(danceRate(320)).toBeCloseTo(danceRate(160));
    expect(danceRate(600)).toBeCloseTo(danceRate(150));
  });

  // ...but never folds upwards, or a genuinely slow tune gets sped up.
  it("never speeds a slow tune up", () => {
    for (const bpm of [40, 55, 70, 85]) {
      expect(danceRate(bpm)).toBeLessThan(danceRate(125));
    }
  });

  it("stays within a sane range for any input", () => {
    for (const bpm of [1, 40, 125, 300, 1000]) {
      const r = danceRate(bpm);
      expect(r).toBeGreaterThanOrEqual(0.3);
      expect(r).toBeLessThanOrEqual(1.5);
    }
  });
});

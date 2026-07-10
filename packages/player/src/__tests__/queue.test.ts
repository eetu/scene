import { describe, expect, test } from "vitest";

import { plannedNext } from "../queue";

describe("plannedNext", () => {
  test("null when there's nothing to play next", () => {
    expect(plannedNext(0, -1, false)).toBeNull(); // empty queue
    expect(plannedNext(3, -1, false)).toBeNull(); // no current selection
    expect(plannedNext(3, 2, false)).toBeNull(); // at the end, sequential
  });

  test("sequential steps to the next index", () => {
    expect(plannedNext(3, 0, false)).toBe(1);
    expect(plannedNext(3, 1, false)).toBe(2);
  });

  test("a single-item queue has no next, even when shuffling", () => {
    expect(plannedNext(1, 0, true)).toBeNull();
  });

  test("shuffle returns an in-range index that isn't the current one", () => {
    // rng first lands on the current index (must be rejected), then on 2.
    const seq = [0.5, 0.9]; // floor(0.5*3)=1 (==current, retry), floor(0.9*3)=2
    let i = 0;
    const rng = () => seq[i++];
    expect(plannedNext(3, 1, true, rng)).toBe(2);
  });

  test("shuffle never yields the current index across many draws", () => {
    let x = 0;
    const rng = () => {
      // cycle through values that repeatedly hit the current index first
      x = (x + 1) % 7;
      return x / 7;
    };
    for (let n = 0; n < 200; n++) {
      const next = plannedNext(5, 2, true, rng);
      expect(next).not.toBeNull();
      expect(next).not.toBe(2);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(5);
    }
  });
});

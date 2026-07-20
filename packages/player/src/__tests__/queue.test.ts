import { describe, expect, test } from "vitest";

import { mulberry32, plannedNext, plannedPrev, shuffledOrder } from "../queue";

describe("mulberry32", () => {
  test("same seed → same stream; different seeds differ", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seq = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(seq);
    const c = mulberry32(999);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(seq);
    for (const x of seq) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("shuffledOrder", () => {
  test("is a permutation of 0..len-1", () => {
    const o = shuffledOrder(50, 42);
    expect(o).toHaveLength(50);
    expect([...o].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  test("deterministic per seed; different seeds → (almost surely) different order", () => {
    expect(shuffledOrder(30, 7)).toEqual(shuffledOrder(30, 7));
    expect(shuffledOrder(30, 7)).not.toEqual(shuffledOrder(30, 8));
  });
});

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
    expect(plannedNext(1, 0, true, [0])).toBeNull();
  });

  test("shuffle walks the seeded order and wraps at the end (endless)", () => {
    const order = [2, 0, 3, 1]; // an explicit permutation
    expect(plannedNext(4, 2, true, order)).toBe(0); // 2 → 0
    expect(plannedNext(4, 3, true, order)).toBe(1); // 3 → 1
    expect(plannedNext(4, 1, true, order)).toBe(2); // last in order → wraps to first
  });

  test("shuffle falls back to sequential when the order is missing/mismatched", () => {
    expect(plannedNext(4, 1, true)).toBe(2); // no order
    expect(plannedNext(4, 1, true, [0, 1])).toBe(2); // wrong-length order
  });
});

describe("plannedPrev", () => {
  test("sequential steps back, null at the start", () => {
    expect(plannedPrev(3, 2, false)).toBe(1);
    expect(plannedPrev(3, 0, false)).toBeNull();
  });

  test("shuffle walks the seeded order backwards and wraps at the start", () => {
    const order = [2, 0, 3, 1];
    expect(plannedPrev(4, 0, true, order)).toBe(2); // 0 → 2
    expect(plannedPrev(4, 2, true, order)).toBe(1); // first in order → wraps to last
  });
});

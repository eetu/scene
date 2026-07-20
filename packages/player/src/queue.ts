// Pure queue-advance logic (which track plays next/prev), split out so the
// shuffle + sequential stepping is testable. Shuffle is a *deterministic* seeded
// order (a Fisher–Yates permutation of the queue) rather than a random pick each
// step: it never repeats until the queue cycles, prev walks the same history, and
// the order is reproducible from its seed — so it can be persisted across reloads.

/** mulberry32 — a tiny, fast, seedable PRNG. Same seed → same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic shuffled permutation of [0, len) from `seed` (Fisher–Yates). */
export function shuffledOrder(len: number, seed: number): number[] {
  const order = Array.from({ length: len }, (_, i) => i);
  const rng = mulberry32(seed);
  for (let i = len - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

/** The queue index to play after `current`, or null if there is none.
 *  - shuffle: the next entry in the shuffled `order`, wrapping at the end (endless
 *    shuffle); falls back to sequential if the order is missing/mismatched;
 *  - sequential: `current + 1`, or null at the end of the queue.
 *  Returns null for an empty queue or no current selection (current < 0). */
export function plannedNext(
  len: number,
  current: number,
  shuffle: boolean,
  order?: number[],
): number | null {
  if (len === 0 || current < 0) return null;
  if (shuffle && len > 1 && order && order.length === len) {
    const pos = order.indexOf(current);
    if (pos < 0) return order[0];
    return order[(pos + 1) % len]; // wrap → endless shuffle
  }
  const i = current + 1;
  return i < len ? i : null;
}

/** The queue index to play before `current`, or null.
 *  - shuffle: the previous entry in the shuffled `order`, wrapping at the start;
 *  - sequential: `current - 1`, or null at the start of the queue. */
export function plannedPrev(
  len: number,
  current: number,
  shuffle: boolean,
  order?: number[],
): number | null {
  if (len === 0 || current < 0) return null;
  if (shuffle && len > 1 && order && order.length === len) {
    const pos = order.indexOf(current);
    if (pos < 0) return order[len - 1];
    return order[(pos - 1 + len) % len];
  }
  return current - 1 >= 0 ? current - 1 : null;
}

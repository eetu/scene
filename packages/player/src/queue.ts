// Pure queue-advance logic (which track plays next), split out so the shuffle +
// sequential stepping is testable with a deterministic rng.

/** The index to play after `current`, or null if there is none.
 *  - shuffle (len > 1): a random index that isn't the current one;
 *  - sequential: the next index, or null at the end of the queue.
 *  Returns null for an empty queue or no current selection (current < 0). */
export function plannedNext(
  len: number,
  current: number,
  shuffle: boolean,
  rng: () => number = Math.random,
): number | null {
  if (len === 0 || current < 0) return null;
  if (shuffle && len > 1) {
    let i: number;
    do {
      i = Math.floor(rng() * len);
    } while (i === current);
    return i;
  }
  const i = current + 1;
  return i < len ? i : null;
}

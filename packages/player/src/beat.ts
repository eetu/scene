// Musical-beat tracking derived from the pattern row, with no store or clock
// dependency (the caller passes `now`), so the easing + clamping — which every
// visualizer's pulse relies on — is unit-testable.

const ROWS_PER_BEAT = 4;

/** Tracks beat onsets from the stream of played rows and eases the inter-beat
 *  interval, exposing a 0→1 phase ramp and an estimated BPM. Stateful but pure
 *  w.r.t. time: pass the current timestamp into `row()`/`phase()`. */
export class BeatTracker {
  private lastRow = -1;
  private lastOrder = -1;
  private lastPattern = -1;
  private lastBeatAt = 0; // timestamp of the last beat onset (0 = none yet)
  private interval = 500; // eased ms between beats, for the phase ramp

  reset() {
    this.lastRow = -1;
    this.lastOrder = -1;
    this.lastPattern = -1;
    this.lastBeatAt = 0;
    this.interval = 500;
  }

  /** Feed the currently-playing (order, pattern, row) at time `now`. Returns true
   *  exactly when a new beat onset occurs (a row divisible by ROWS_PER_BEAT that
   *  we haven't already counted), so the caller can pulse the store. */
  row(order: number, pattern: number, row: number, now: number): boolean {
    const advanced =
      row !== this.lastRow || order !== this.lastOrder || pattern !== this.lastPattern;
    if (!advanced) return false;
    this.lastRow = row;
    this.lastOrder = order;
    this.lastPattern = pattern;
    if (row % ROWS_PER_BEAT !== 0) return false;
    if (this.lastBeatAt > 0) {
      const dt = now - this.lastBeatAt;
      // Ease the interval toward the latest gap, ignoring seeks/stalls (out of a
      // plausible 30ms–2s beat range) so the phase ramp stays smooth.
      if (dt > 30 && dt < 2000) this.interval += (dt - this.interval) * 0.25;
    }
    this.lastBeatAt = now;
    return true;
  }

  /** A 0→1 ramp since the last beat, from the eased interval (clamped at 1, and 0
   *  until the first beat). */
  phase(now: number): number {
    if (!this.lastBeatAt) return 0;
    return Math.min(1, (now - this.lastBeatAt) / this.interval);
  }

  /** Estimated tempo in BPM from the eased interval, clamped to a sane range so a
   *  stall/seek can't spike it. ~0 until the first beat. */
  bpm(): number {
    if (!this.lastBeatAt) return 0;
    return Math.max(40, Math.min(300, 60000 / this.interval));
  }
}

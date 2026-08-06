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
  private avg = 0; // running mean energy, for the onset detector below

  reset() {
    this.lastRow = -1;
    this.lastOrder = -1;
    this.lastPattern = -1;
    this.lastBeatAt = 0;
    this.interval = 500;
    this.avg = 0;
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

  /** Feed a low-band energy sample at `now`, for formats with no pattern grid.
   *
   *  A SID has no rows to count — its music is 6502 code, and the chip exposes
   *  only a ~50Hz interrupt rate, which is a *tick* rate and not a musical beat.
   *  So the beat has to come from the audio: this is an onset detector on the
   *  bass band, firing when energy jumps well above its own running average.
   *
   *  Adaptive rather than a fixed threshold, because SID output levels vary
   *  enormously between tunes; and rate-limited, because without a refractory
   *  window a single drum hit's decay retriggers for several frames and the
   *  visualisers strobe. */
  energy(level: number, now: number): boolean {
    // Running mean of recent energy — the "normal" this sample is judged against.
    this.avg += (level - this.avg) * 0.1;
    const loud = level > this.avg * 1.35 && level > 0.02;
    const settled = now - this.lastBeatAt > Math.max(120, this.interval * 0.4);
    if (!loud || !settled) return false;
    if (this.lastBeatAt > 0) {
      const dt = now - this.lastBeatAt;
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

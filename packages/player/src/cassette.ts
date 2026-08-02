// The mechanics of a compact cassette, as maths — kept out of the drawing code so the
// parts that are physics can be checked without a canvas (see cassette.test.ts).
//
// Everything here follows from one fact: the tape moves at a CONSTANT LINEAR SPEED
// (4.76 cm/s, the standard) while the two packs it spools between are different sizes.
// That single constraint produces every behaviour a real deck shows and a naive
// implementation misses:
//
//   - the supply reel speeds up as it empties and the take-up reel slows as it fills, so
//     the two hubs are never turning at the same rate;
//   - the pack radii move as a SQUARE ROOT of position, not linearly, so most of the
//     visible radius change happens in the first third of the side;
//   - the counter runs fast at the start of a side and slow at the end, because it is
//     geared off the take-up hub rather than off a clock. Anyone who ever tried to find a
//     song again by its counter number knows this one.
//
// Drawing a cassette with two equal reels turning at one speed is the tell that it was
// drawn from memory. This module is why this one isn't.

/** Hub radius, in the same units as the pack radii below (millimetres). */
export const HUB_R = 11;
/** Pack radius with a full C-90 side wound on. */
export const FULL_R = 24;
/** Standard tape speed, mm/s. */
export const TAPE_SPEED = 47.6;
/** The corner guide rollers the tape is turned around, radius in mm. Tiny, so they spin
 *  many times faster than the hubs — which is most of what makes them worth drawing. */
export const GUIDE_R = 2.5;
/** How much pack area one side of tape is worth: r² grows linearly with tape used. */
const PACK_A = FULL_R * FULL_R - HUB_R * HUB_R;
/** Overall tape thickness including backing, mm. A C-90 side is ~1170 wraps over the
 *  13mm of radius the pack grows by, which is where this comes from. */
const TAPE_T = (FULL_R - HUB_R) / 1170;
/** Counter gearing. Real 4-digit counters were belted off the take-up hub at a ratio that
 *  put the end of a C-90 side somewhere in the 6000s rather than at a round number —
 *  there was nothing to calibrate them against, which is the whole reason they were
 *  useless for finding anything twice. */
const COUNTER_GEAR = 5.4;

export type ReelState = {
  /** Pack radius on each hub, in the same units as HUB_R. */
  supplyR: number;
  takeupR: number;
  /** Angular speed, radians/second, at full tape speed. Sign is the winding direction:
   *  both hubs turn the same way, so both are positive here and the caller negates for
   *  rewind. */
  supplyW: number;
  takeupW: number;
};

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);

/** The two packs at `frac` (0 = head of the side, 1 = end).
 *
 *  Tape conserves area: a pack's cross-section is π(r² − hub²), so r² is what moves
 *  linearly with how much tape is on it, and r itself moves as a square root. The two
 *  radii therefore satisfy supplyR² + takeupR² = HUB_R² + FULL_R² at every position,
 *  which is the invariant cassette.test.ts pins. */
export function reelState(frac: number): ReelState {
  const f = clamp01(Number.isFinite(frac) ? frac : 0);
  const supplyR = Math.sqrt(HUB_R * HUB_R + PACK_A * (1 - f));
  const takeupR = Math.sqrt(HUB_R * HUB_R + PACK_A * f);
  return {
    supplyR,
    takeupR,
    // ω = v / r. The empty hub is the fast one.
    supplyW: TAPE_SPEED / supplyR,
    takeupW: TAPE_SPEED / takeupR,
  };
}

/** The mechanical counter reading at `frac`, 0000–9999.
 *
 *  Every wrap of tape adds one tape-thickness to the take-up pack's radius, so the number
 *  of turns the hub has made is just how far that radius has grown divided by the
 *  thickness — no integral needed, and the non-linearity falls out for free. */
export function tapeCounter(frac: number): number {
  const { takeupR } = reelState(frac);
  const turns = (takeupR - HUB_R) / TAPE_T;
  return Math.min(9999, Math.max(0, Math.round(turns * COUNTER_GEAR)));
}

/** Counter reading as the four characters a 7-segment field shows. */
export function counterText(frac: number): string {
  return String(tapeCounter(frac)).padStart(4, "0");
}

/** What the mechanism is doing. `eject` is the door being open with the well empty —
 *  the moment between one cassette coming out and the next going in. */
export type Deck = "play" | "pause" | "stop" | "eject";

export type DeckState = {
  /** Hub angles, radians, wrapped to [0, 2π). Kept as absolute angles so the drawing can
   *  just use them. They DECREASE while playing — see SPIN below. */
  supplyAngle: number;
  takeupAngle: number;
  /** The corner guide rollers, which turn with the tape and are much smaller, so much
   *  faster. One angle for both: they see the same tape at the same speed. */
  guideAngle: number;
  /** Door travel: 0 shut, 1 fully dropped open. */
  door: number;
  /** How far through the side the tape is, 0..1 — drives the pack radii and the counter. */
  frac: number;
  /** Spin-down: the reels have inertia, so STOP is not an instant freeze. 0..1. */
  spin: number;
  /**
   * How far the head carriage has come UP into the cassette, 0..1.
   *
   * One value for the whole carriage, because that is what it is: the record/play head and
   * the pinch roller are bolted to one plate and thrown by one solenoid, so they go in
   * together on play and come out together on stop. Pause holds them in — the tape stops
   * because the capstan stops driving it, not because anything let go of it, which is why
   * pause resumes without a gap.
   */
  engage: number;
};

export function initialDeck(): DeckState {
  return {
    supplyAngle: 0,
    takeupAngle: 0,
    guideAngle: 0,
    door: 0,
    frac: 0,
    spin: 0,
    engage: 0,
  };
}

/**
 * Which way the hubs turn on screen, playing side A forwards: ANTICLOCKWISE.
 *
 * Worth writing down, because it is easy to talk yourself into the other one and this code
 * did. Follow the tape rather than the reels. It leaves the supply pack on the pack's OUTER
 * (left) side heading DOWN, is turned through ninety degrees by a guide roller in the
 * bottom-left corner, runs left-to-right along the bottom past the head, is turned again by
 * the bottom-right roller, and goes UP the outer side of the take-up pack.
 *
 * So the left pack's left edge moves down, and the right pack's right edge moves up. On a
 * screen (y down) both of those are anticlockwise, and they agree — which is the check that
 * matters, since one tape cannot drive two hubs in opposite directions.
 *
 * The wrong answer comes from assuming the tape leaves the pack at its BOTTOM heading left,
 * which is self-consistent too and gives clockwise. What rules it out is that the guides are
 * in the corners, outboard of the hubs: the tape has to get past the pack's widest point to
 * reach them, so it comes off the side.
 */
const SPIN = -1;

/** How long the door takes to fall open or be pushed shut, in seconds. Slow enough to
 *  read as a sprung mechanism rather than a cut. */
export const DOOR_S = 0.42;
/** Reel spin-up / spin-down time constant. Real hubs coast; an instant stop looks like a
 *  paused GIF. */
const SPIN_TAU = 0.35;
/** How long the head and pinch roller take to come up into the cassette. A solenoid, not a
 *  motor: quick, and the same speed in both directions. */
const ENGAGE_S = 0.16;

/**
 * Advance the mechanism by `dt` seconds.
 *
 * `frac` is passed in rather than integrated here, because the truth about where we are
 * in the track lives in the player's own position — integrating tape speed separately
 * would drift away from it over a long module and the counter would start lying.
 *
 * Mutates and returns `s`, so the caller can keep one object across frames.
 */
export function stepDeck(s: DeckState, dt: number, mode: Deck, frac: number): DeckState {
  // Clamped at both ends, and a non-finite dt is worth zero. The frame driver already caps
  // its own dt, but this state is integrated — one NaN gets into an angle and the reels are
  // NaN for the rest of the session, with nothing on screen to say why.
  const step = Number.isFinite(dt) ? Math.min(0.05, Math.max(0, dt)) : 0;
  s.frac = clamp01(Number.isFinite(frac) ? frac : 0);

  // Toward the target and no further. Clamping to 0/1 rather than to `wantDoor` looks
  // equivalent and is not: the frame that lands exactly ON the target takes the other
  // branch next time and steps back off it, so a door held open sits there vibrating by
  // one frame of travel. cassette.test.ts is where that showed up.
  const wantDoor = mode === "eject" ? 1 : 0;
  const travel = step / DOOR_S;
  s.door =
    wantDoor > s.door ? Math.min(wantDoor, s.door + travel) : Math.max(wantDoor, s.door - travel);

  // Only PLAY drives the capstan. Everything else coasts to a stop — including eject,
  // where the hubs are lifted off their spindles.
  const wantSpin = mode === "play" ? 1 : 0;
  s.spin += (wantSpin - s.spin) * (1 - Math.exp(-step / SPIN_TAU));
  if (s.spin < 1e-3 && wantSpin === 0) s.spin = 0;

  // The transport engaging. A solenoid throws in about a sixth of a second, so this is a
  // linear travel at a fixed rate rather than an ease — it is a mechanism being thrown, not
  // something settling, and the thunk at the end of it is the point.
  //
  // In for play and pause, out for stop and eject. Clamped toward the target the same way
  // the door is, and for the same reason — see the note above.
  const wantEngage = mode === "play" || mode === "pause" ? 1 : 0;
  const throw_ = step / ENGAGE_S;
  s.engage =
    wantEngage > s.engage
      ? Math.min(wantEngage, s.engage + throw_)
      : Math.max(wantEngage, s.engage - throw_);

  const TAU = Math.PI * 2;
  const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
  const { supplyW, takeupW } = reelState(s.frac);
  s.supplyAngle = wrap(s.supplyAngle + SPIN * supplyW * s.spin * step);
  s.takeupAngle = wrap(s.takeupAngle + SPIN * takeupW * s.spin * step);
  s.guideAngle = wrap(s.guideAngle + SPIN * (TAPE_SPEED / GUIDE_R) * s.spin * step);
  return s;
}

/**
 * The eject cycle a track change triggers: door drops, the cassette is swapped at the
 * bottom of the travel, door closes.
 *
 * Modelled as a countdown rather than a queue of timers so it survives the visualiser
 * being frozen mid-cycle by the frame driver (a paused pane tears its rAF loop down —
 * see raf.ts) and resumes from wherever it actually got to.
 */
export type Swap = {
  /** Seconds left in the cycle; 0 when nothing is happening. */
  left: number;
  /** Has the cassette in the well already been exchanged this cycle? */
  swapped: boolean;
};

/** Down, hold at the bottom, and back up. */
export const SWAP_S = DOOR_S * 2 + 0.5;

export function startSwap(): Swap {
  return { left: SWAP_S, swapped: false };
}

/** Advance a swap. Returns whether THIS call is the moment to exchange the cassette —
 *  true exactly once per cycle, at the bottom of the door's travel. */
export function stepSwap(sw: Swap, dt: number): boolean {
  if (sw.left <= 0) return false;
  const step = Number.isFinite(dt) ? Math.min(0.05, Math.max(0, dt)) : 0;
  sw.left = Math.max(0, sw.left - step);
  // Past the halfway mark the door is at or near the bottom of its travel and the well is
  // as hidden as it is going to get, which is where a swap can happen unseen.
  if (!sw.swapped && sw.left <= SWAP_S - DOOR_S) {
    sw.swapped = true;
    return true;
  }
  return false;
}

/** Is the door open (or on its way) for this swap? */
export function swapOpen(sw: Swap): boolean {
  return sw.left > 0 && sw.left > DOOR_S * 0.5;
}

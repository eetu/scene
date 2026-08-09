// The demo parts.
//
// Each one is what a C64 demo called a "part": a single effect that owns the
// screen for a while. They're plain functions of (screen, time, feed) with no
// state of their own except where the effect genuinely is a simulation (fire has
// a heat buffer; the starfield has stars), so the director can cut between them
// freely and a test can run one for ten seconds and look at the result.
//
// Everything here is constrained the way the hardware was, and the constraints
// are why these particular effects exist. There are 16 fixed colours and one
// 8×8 character ROM that cannot be scaled or redefined, so:
//   * a plasma is made of colour, not of pixels — solid cells, and the whole
//     effect lives in colour RAM;
//   * anything that needs sub-cell resolution uses the eighth-block characters,
//     which fill a cell from the bottom in eight steps;
//   * a logo is drawn out of solid cells, because there is no bigger type.

import {
  BLACK,
  COOL_RAMP,
  DEPTH_RAMP,
  FIRE_RAMP,
  HUE_WHEEL,
  RASTER_RAMP,
  WARM_RAMP,
} from "./c64-palette";
import { BIG_HEIGHT, bigWidth, CHAR, clear, COLS, poke, printBig, type Screen } from "./c64-screen";

/** What every part is given. The band levels are roughly 0–1. */
export type PartFeed = {
  bass: number;
  mid: number;
  treble: number;
  /** Rises on every detected beat; parts compare it, they don't read it. */
  beat: number;
  /** The output waveform, 0–255 with 128 at silence, or empty before the graph
   *  exists. The scope part plots it directly. */
  wave: Uint8Array | number[];
  /** Big text for the logo — the tune, or the artist. */
  title: string;
};

/**
 * Rows a part owns — 0 to PART_ROWS-1.
 *
 * The rest of the screen belongs to the scroller, the way a raster split gave
 * the bottom of a real screen to a separate routine: one row for the divider,
 * then five for the scroller's sine to swing through.
 */
export const PART_ROWS = 19;

const ramp = <T>(list: readonly T[], f: number): T =>
  list[Math.min(list.length - 1, Math.max(0, Math.floor(f * list.length)))];

/** Index a ramp that wraps, for fields that cycle rather than climb. */
const wrapRamp = <T>(list: readonly T[], f: number): T =>
  list[((Math.floor(f * list.length) % list.length) + list.length) % list.length];

// ---------- plasma ----------

/**
 * Interfering sine fields, in colour.
 *
 * The C64 version of this puts nothing in screen RAM but solid blocks and does
 * the whole effect in colour RAM, because that is the only thing it could
 * change fast enough — 1000 bytes a frame was affordable where redrawing
 * characters was not. Doing it the same way here is not nostalgia: the palette
 * is 16 fixed colours, so a plasma that tried to shade with characters would
 * band far worse than one that cycles hue.
 */
export function plasma(s: Screen, t: number, feed: PartFeed): void {
  // The music widens and narrows the field rather than changing its speed —
  // tempo is already carried by the colour cycling, and modulating both reads
  // as the effect stuttering.
  const zoom = 0.28 + feed.mid * 0.22;
  for (let y = 0; y < PART_ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const v =
        Math.sin(x * zoom + t * 1.7) +
        Math.sin(y * zoom * 1.6 + t * 1.1) +
        Math.sin((x + y) * zoom * 0.7 + t * 0.8) +
        Math.sin(Math.hypot(x - COLS / 2, (y - PART_ROWS / 2) * 1.6) * zoom * 0.9 - t * 2.1);
      poke(s, x, y, CHAR.FILL[8], wrapRamp(HUE_WHEEL, (v + 4) / 8 + t * 0.12));
    }
  }
}

// ---------- fire ----------

export type Fire = { heat: Float32Array; seed: number };

export const createFire = (): Fire => ({ heat: new Float32Array(COLS * (PART_ROWS + 1)), seed: 1 });

/** A cheap deterministic PRNG. `Math.random` is unavailable to the workflow
 *  tooling and untestable besides; fire only needs noise, not entropy. */
function rnd(f: Fire): number {
  f.seed = (f.seed * 1664525 + 1013904223) >>> 0;
  return f.seed / 4294967296;
}

/**
 * The doom fire, one cell per character.
 *
 * The classic routine: seed the row below the screen with heat, then propagate
 * upward with a random horizontal drift and a decay. Character resolution makes
 * it coarse, so the flame *tips* are drawn with the eighth-blocks — a cell
 * that's half-hot shows as a half-height block rather than snapping to the next
 * colour, which is what stops it looking like a bar chart.
 */
export function fire(s: Screen, f: Fire, feed: PartFeed): void {
  const W = COLS;
  const H = PART_ROWS + 1;
  // The bass is the bellows. A floor keeps it burning through quiet passages —
  // a fire that goes out is not an effect, it's a blank screen.
  // Over 1.0 on purpose, and clamped when it's drawn. The seed row sits below
  // the screen and the top row of the fire is already a decay step down from
  // it, so seeding at exactly full heat means the visible base is one ramp stop
  // short and the fire never reaches white — it burns orange at its hottest.
  const fuel = 0.85 + Math.min(1, feed.bass * 1.6) * 0.55;
  // Cold spots in the seed row, not just dimmer ones: the gaps between flames
  // start here and the drift widens them on the way up. Seeding evenly gives a
  // sheet of fire rather than flames.
  for (let x = 0; x < W; x++) f.heat[(H - 1) * W + x] = rnd(f) < 0.75 ? fuel : fuel * 0.15;

  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const drift = Math.floor(rnd(f) * 3) - 1;
      const src = Math.min(W - 1, Math.max(0, x + drift));
      // Tuned so the flame is out by about the top of the screen: over 19 rows
      // the mean here lands near the cold threshold. Gentler and the part is a
      // solid slab of orange with no flame shape at all.
      const decay = 0.8 + rnd(f) * 0.12;
      f.heat[y * W + x] = f.heat[(y + 1) * W + src] * decay;
    }
  }

  for (let y = 0; y < PART_ROWS; y++) {
    for (let x = 0; x < W; x++) {
      const h = Math.min(1, f.heat[y * W + x]);
      if (h < COLD) {
        poke(s, x, y, CHAR.FILL[0], BLACK);
        continue;
      }
      // Colour is the temperature. The character is solid wherever the flame
      // continues upward, and only its topmost cell fills part-way — so the
      // flame is a mass with a feathered tip. Shading every cell by its own
      // heat instead draws a row of one-eighth bars per line, which reads as
      // scanlines rather than as fire.
      const capped = y === 0 || f.heat[(y - 1) * W + x] < COLD;
      // A tip is never thinner than a quarter cell: one-eighth of a cell across
      // a whole row is a hairline, and rows of hairlines above the flames read
      // as interference rather than as heat.
      const shade = capped ? Math.max(2, Math.min(8, Math.round(h * 12))) : 8;
      poke(s, x, y, CHAR.FILL[shade], ramp(FIRE_RAMP, h));
    }
  }
}

/** Below this a cell is out, not merely dim. */
const COLD = 0.1;

// ---------- starfield ----------

export type Stars = { x: Float32Array; y: Float32Array; z: Float32Array; seed: number };

export function createStars(count = 120): Stars {
  const st: Stars = {
    x: new Float32Array(count),
    y: new Float32Array(count),
    z: new Float32Array(count),
    seed: 7,
  };
  for (let i = 0; i < count; i++) respawn(st, i, rndStar(st));
  return st;
}

function rndStar(st: Stars): number {
  st.seed = (st.seed * 1664525 + 1013904223) >>> 0;
  return st.seed / 4294967296;
}

function respawn(st: Stars, i: number, r: number): void {
  st.x[i] = (r - 0.5) * 2;
  st.y[i] = (rndStar(st) - 0.5) * 2;
  st.z[i] = 0.2 + rndStar(st) * 0.8;
}

/**
 * Stars flying at the viewer, four characters deep.
 *
 * Depth is drawn twice over — as a bigger character (`.` `+` `*` `●`) and as a
 * brighter grey. Either alone reads as noise on a 40×25 grid; together the
 * field has an obvious front and back, which is the whole illusion.
 */
export function starfield(s: Screen, st: Stars, dt: number, feed: PartFeed): void {
  clear(s, BLACK, PART_ROWS);
  const speed = 0.28 + feed.treble * 0.5;
  const CHARS = [CHAR.DOT, CHAR.PLUS, CHAR.STAR, CHAR.DISC];
  for (let i = 0; i < st.z.length; i++) {
    st.z[i] -= dt * speed;
    if (st.z[i] <= 0.05) respawn(st, i, rndStar(st));
    const px = Math.round(COLS / 2 + (st.x[i] / st.z[i]) * (COLS / 4));
    const py = Math.round(PART_ROWS / 2 + (st.y[i] / st.z[i]) * (PART_ROWS / 4));
    if (px < 0 || px >= COLS || py < 0 || py >= PART_ROWS) continue;
    const near = 1 - Math.min(1, st.z[i]);
    poke(s, px, py, CHARS[Math.min(3, Math.floor(near * 4))], ramp(DEPTH_RAMP, 1 - near));
  }
}

// ---------- twister ----------

/**
 * A column of stripes twisting about its own axis.
 *
 * Modelled as a cylinder rather than as a flat strip. A flat strip is the
 * obvious reading of the name and it does not work: every point on one of its
 * rows shares a surface normal, so each row can only be a single flat colour,
 * and the result is a stack of horizontal bars that bulges and pinches — an
 * hourglass, not a turn. A cylinder gives each row a *run* of stripes at
 * different depths, and depth across the row is what the eye reads as round.
 *
 * The stripes are painted far side first so the near side covers them, and they
 * alternate between a cool and a warm ramp: sixteen fixed colours can't shade an
 * arbitrary hue, so two ramps climbing to white from opposite ends of the wheel
 * is how a striped object stays striped *and* stays lit.
 *
 * The twist per row is deliberately well under a full turn across the screen.
 * More than one turn and the waists line up into that same hourglass.
 */
export function twister(s: Screen, t: number, feed: PartFeed): void {
  clear(s, BLACK, PART_ROWS);
  const STRIPES = 8;
  const TAU = Math.PI * 2;
  const mid = (COLS - 1) / 2;
  const radius = 13 + feed.bass * 4;
  const twist = 0.15 + feed.mid * 0.06;

  for (let y = 0; y < PART_ROWS; y++) {
    const phase = t * 1.5 + y * twist;
    const bands = [];
    for (let i = 0; i < STRIPES; i++) {
      const a0 = phase + (i * TAU) / STRIPES;
      const a1 = phase + ((i + 1) * TAU) / STRIPES;
      bands.push({
        i,
        lo: Math.round(mid + Math.min(Math.sin(a0), Math.sin(a1)) * radius),
        hi: Math.round(mid + Math.max(Math.sin(a0), Math.sin(a1)) * radius),
        // −1 is the far side of the cylinder, +1 the near.
        depth: (Math.cos(a0) + Math.cos(a1)) / 2,
      });
    }
    bands.sort((a, b) => a.depth - b.depth);
    for (const b of bands) {
      const lit = (b.depth + 1) / 2;
      const color = ramp(b.i % 2 ? WARM_RAMP : COOL_RAMP, lit);
      for (let x = b.lo; x <= b.hi; x++) poke(s, x, y, CHAR.FILL[8], color);
    }
  }
}

// ---------- vector balls ----------

/**
 * A rotating ring of balls.
 *
 * Vector balls were sprites on the real hardware, which is why they were
 * everywhere: the VIC drew eight of them for free. In characters the cost is
 * the painter's sort — draw far to near so the near ones overwrite, or the ring
 * turns inside out. Colour carries depth, as in the starfield.
 */
export function vectorBalls(s: Screen, t: number, feed: PartFeed): void {
  clear(s, BLACK, PART_ROWS);
  const N = 16;
  const spin = t * 1.1;
  const tilt = Math.sin(t * 0.7) * 0.6;
  const pulse = 1 + feed.bass * 0.35;

  const balls: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + spin;
    // A ring, tipped — two rings crossing would read as noise at this size.
    const rx = Math.cos(a) * 1.5 * pulse;
    const rz = Math.sin(a) * 1.5 * pulse;
    const ry = Math.sin(a * 2 + t) * 0.45;
    balls.push({
      x: rx,
      y: ry * Math.cos(tilt) - rz * Math.sin(tilt),
      z: ry * Math.sin(tilt) + rz * Math.cos(tilt),
    });
  }
  balls.sort((a, b) => b.z - a.z);

  for (const b of balls) {
    const d = 4 + b.z;
    const px = Math.round(COLS / 2 + (b.x / d) * COLS * 0.75);
    const py = Math.round(PART_ROWS / 2 + (b.y / d) * PART_ROWS * 1.5);
    if (px < 0 || px >= COLS || py < 0 || py >= PART_ROWS) continue;
    const near = Math.min(1, Math.max(0, (b.z + 1.6) / 3.2));
    poke(s, px, py, CHAR.DISC, ramp(DEPTH_RAMP, 1 - near));
  }
}

// ---------- scope ----------

/**
 * The output waveform, plotted.
 *
 * The one part that draws the music itself rather than a field modulated by it.
 * Each column takes a slice of the sample window and fills from the centre
 * outward, in eighths, so the trace has sub-character resolution — the
 * difference between a waveform and a staircase.
 */
export function scope(s: Screen, t: number, feed: PartFeed): void {
  clear(s, BLACK, PART_ROWS);
  const mid = (PART_ROWS - 1) / 2;
  const w = feed.wave;
  // A short window rather than the whole buffer, and the extremes of each slice
  // rather than one sample from it. Two thousand samples is twenty periods of a
  // bass note, and twenty periods across forty columns is aliasing — the trace
  // comes out as a jagged mess that moves with the sampling rather than with the
  // music. Min-to-max per column is also just what a scope's trace *is* once the
  // signal is finer than the display.
  const span = Math.min(w.length, 512);
  const reach = PART_ROWS / 2 - 1;
  for (let x = 0; x < COLS; x++) {
    let lo = 0;
    let hi = 0;
    if (span > 0) {
      const from = Math.floor((x / COLS) * span);
      const to = Math.max(from + 1, Math.floor(((x + 1) / COLS) * span));
      lo = 1;
      hi = -1;
      for (let i = from; i < to; i++) {
        const v = (w[i] - 128) / 128;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    // Silence is a flat line down the middle, not an empty screen.
    const top = Math.floor(mid + Math.min(lo, hi) * reach);
    const bottom = Math.ceil(mid + Math.max(lo, hi) * reach);
    for (let y = top; y <= bottom; y++) {
      if (y < 0 || y >= PART_ROWS) continue;
      // Distance from the centre picks the colour, so the loud parts of the
      // trace light up rather than the whole line changing together.
      const heat = Math.min(1, Math.abs(y - mid) / (PART_ROWS / 2));
      poke(s, x, y, CHAR.FILL[8], wrapRamp(HUE_WHEEL, heat * 0.5 + t * 0.15));
    }
  }
}

// ---------- logo ----------

/**
 * The title card: block letters over raster bars.
 *
 * Every demo opens on one. The letters cycle colour by column, which is a
 * one-line effect that reads as a sweep across the logo — the trick that made
 * flat block type look lit on hardware that could not shade it.
 */
export function logo(s: Screen, t: number, feed: PartFeed): void {
  clear(s, BLACK, PART_ROWS);

  // Bars behind, so the card isn't type on a void.
  for (let y = 0; y < PART_ROWS; y++) {
    const f = Math.sin(t * 1.3 + y * 0.45) * 0.5 + 0.5;
    if (f > 0.62) {
      const color = ramp(RASTER_RAMP, (f - 0.62) / 0.38);
      for (let x = 0; x < COLS; x++) poke(s, x, y, CHAR.FILL[8], color);
    }
  }

  const lines = wrapBig(feed.title || "SCENE", 8);
  const top = Math.floor((PART_ROWS - lines.length * (BIG_HEIGHT + 1)) / 2);
  for (let i = 0; i < lines.length; i++) {
    const y = top + i * (BIG_HEIGHT + 1);
    const x = Math.floor((COLS - bigWidth(lines[i])) / 2);
    // Shadow first: one cell down-right in black, so the letters lift off the
    // bars. Without it the type disappears wherever a bar crosses it.
    printBig(s, x + 1, y + 1, lines[i], BLACK);
    printBig(s, x, y, lines[i], (cx) => wrapRamp(HUE_WHEEL, cx * 0.06 - t * 0.5 + feed.bass * 0.3));
  }
}

/** Break `text` into lines of at most `per` block characters, on word breaks
 *  where it can and mid-word where a single word is simply too long. */
export function wrapBig(text: string, per: number): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const raw of words) {
    for (let word = raw; word.length;) {
      const chunk = word.slice(0, per);
      word = word.slice(per);
      if (!line.length) line = chunk;
      else if (line.length + 1 + chunk.length <= per) line = `${line} ${chunk}`;
      else {
        out.push(line);
        line = chunk;
      }
    }
  }
  if (line.length) out.push(line);
  // Three lines of block type is the most that fits above the scroller.
  return out.slice(0, 3);
}

// ---------- the running order ----------

export type PartId = "logo" | "plasma" | "twister" | "stars" | "balls" | "fire" | "scope";

/** Shown at the top of the screen as each part opens, the way a demo names its
 *  own parts. */
export const PART_NAMES: Record<PartId, string> = {
  logo: "PRESENTS",
  plasma: "PLASMA",
  twister: "TWISTER",
  stars: "STARFIELD",
  balls: "VECTOR BALLS",
  fire: "FIRE",
  scope: "OSCILLOSCOPE",
};

/** Order of play. Deliberately alternating in character — two full-screen
 *  colour fields back to back read as one long part. */
export const RUNNING_ORDER: PartId[] = [
  "logo",
  "plasma",
  "stars",
  "twister",
  "scope",
  "balls",
  "fire",
];

// The demo itself: what runs, in what order, and what stays on screen throughout.
//
// A C64 demo is not one effect, it's a running order — the machine loads, a
// title card comes up, and then parts follow one another with a scroller
// carrying the greetings underneath all of them. That structure is the point of
// this visualiser, so it lives here, separate from the parts it sequences.
//
// Two things persist across every part, both for the same reason they did on
// hardware: the screen was split by raster interrupt, so the bottom few rows
// could run a scroller while a completely different routine owned the rest, and
// the border was a single register that could be changed at any time.

import {
  BLACK,
  BLUE,
  type C64Color,
  CYAN,
  DARK_GREY,
  HUE_WHEEL,
  LIGHT_BLUE,
  LIGHT_GREY,
  RASTER_RAMP,
  WHITE,
} from "./c64-palette";
import {
  createFire,
  createStars,
  fire,
  type Fire,
  logo,
  PART_NAMES,
  PART_ROWS,
  type PartFeed,
  type PartId,
  plasma,
  RUNNING_ORDER,
  scope,
  starfield,
  type Stars,
  twister,
  vectorBalls,
} from "./c64-parts";
import {
  CHAR,
  clear,
  COLS,
  createScreen,
  poke,
  print,
  ROWS,
  type Screen,
  screenCode,
  SOLID,
  SPACE,
} from "./c64-screen";

/** What the demo reacts to. Everything comes from the component; nothing in
 *  here reaches for the audio graph or the store. */
export type Feed = PartFeed & {
  /** The scroller's script — title, artist, whatever notes exist. */
  lines: string[];
};

type Phase = "boot" | "typing" | "loading" | "part";

export type Demo = {
  screen: Screen;
  phase: Phase;
  /** Seconds spent in the current phase or part. */
  t: number;
  /** Total seconds since the demo started, for effects that must not restart
   *  when a part changes. */
  clock: number;
  /** Index into the running order. */
  part: number;
  scrollX: number;
  sinceBeat: number;
  lastBeat: number;
  fire: Fire;
  stars: Stars;
};

const BOOT_HOLD = 1.1; // seconds of READY. before the tape starts
const TYPE_RATE = 26; // characters a second
const LOAD_HOLD = 1.3; // SEARCHING / LOADING before it runs
const SCROLL_RATE = 9; // characters a second
const CURSOR_HZ = 2.4; // the real one is ~1.7Hz; a shade quicker reads as alive

/** How long each part holds the screen. Long enough to watch an effect breathe,
 *  short enough that nothing outstays its welcome. */
const PART_SECS = 15;
/** The wipe in and out, inside those seconds. */
const WIPE_SECS = 0.45;
/** How long a part announces itself for, after the wipe. */
const NAME_SECS = 2.2;

/** Where the scroller lives: row PART_ROWS is the divider, and the sine swings
 *  through the five rows below it. */
const SCROLL_TOP = PART_ROWS + 1;
const SCROLL_MID = PART_ROWS + 3;
const SCROLL_AMP = 2;

/**
 * Start at a different part per tune.
 *
 * The same habit CopperBars has for its orientation: a listen gets variety
 * without a control to find, and a given tune always opens the same way. Hashed
 * rather than random because the demo is otherwise deterministic, and a viz
 * that differs between two runs of the same tune is one you can't screenshot.
 */
function openingPart(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  // Always after the title card: a demo opens on its logo.
  return RUNNING_ORDER.length > 1 ? 1 + (Math.abs(h >> 3) % (RUNNING_ORDER.length - 1)) : 0;
}

export function createDemo(key = ""): Demo {
  return {
    screen: createScreen(),
    phase: "boot",
    t: 0,
    clock: 0,
    part: openingPart(key),
    scrollX: 0,
    sinceBeat: 99,
    lastBeat: -1,
    fire: createFire(),
    stars: createStars(),
  };
}

/** The tune's name as a filename would carry it: uppercase, and short enough
 *  that the LOAD line still fits in 40 columns. */
const loadName = (title: string) => (title || "TUNE").toUpperCase().slice(0, 16);
const loadLine = (title: string) => `LOAD"${loadName(title)}",8,1`;

/** The boot screen, drawn fresh each frame it's visible. */
function drawBanner(s: Screen): void {
  clear(s, LIGHT_BLUE);
  s.border = LIGHT_BLUE;
  s.background = BLUE;
  print(s, 4, 1, "**** COMMODORE 64 BASIC V2 ****", LIGHT_BLUE);
  print(s, 1, 3, "64K RAM SYSTEM  38911 BASIC BYTES FREE", LIGHT_BLUE);
  print(s, 0, 5, "READY.", LIGHT_BLUE);
}

/** The blinking block cursor, at (x, y). */
function cursor(s: Screen, x: number, y: number, t: number): void {
  if (Math.floor(t * CURSOR_HZ) % 2 === 0) poke(s, x, y, SOLID, LIGHT_BLUE);
}

/**
 * The scroller's script as one line.
 *
 * Padded with a screen's worth of leading space so it enters from the right
 * rather than appearing already half-written, and separated so the end of one
 * line and the start of the next don't read as one sentence.
 */
export function scrollText(lines: string[]): string {
  const body = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join("  ***  ");
  return `${" ".repeat(COLS)}${body || "SCENE"}  ***  `;
}

/**
 * The DYCP scroller: "different Y character position".
 *
 * Named for what it cost to do — putting each character of a line at its own
 * height meant re-plotting the whole row as software sprites, and doing it at
 * 50Hz was a party trick. A sine down the row is the shape everyone used.
 */
function drawScroller(s: Screen, text: string, scrollX: number, t: number): void {
  // The scroller's own strip, cleared each frame so parts can't bleed into it.
  for (let y = SCROLL_TOP; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) poke(s, x, y, SPACE, BLACK);
  }
  const head = Math.floor(scrollX);
  for (let x = 0; x < COLS; x++) {
    const ch = text[(head + x) % text.length];
    if (!ch || ch === " ") continue;
    // Roughly one and a bit waves across the screen. Steeper and consecutive
    // letters land rows apart, which scatters the words into confetti — the
    // sine is meant to carry the text, not shred it.
    const y = SCROLL_MID + Math.round(Math.sin(t * 2.6 + x * 0.2) * SCROLL_AMP);
    // Cyan on the crest, white in the trough — the depth cue every C64 scroller
    // used, and it keeps the letters legible wherever they are in the sweep.
    poke(s, x, y, screenCode(ch), y <= SCROLL_MID ? CYAN : WHITE);
  }
}

/**
 * The wipe between parts.
 *
 * Solid rows closing in from the top and bottom and then opening again. Cheap,
 * and it's what a demo with no bitmap mode had: you can't fade 16 fixed
 * colours, so you cover the screen instead.
 */
function wipe(s: Screen, closed: number, color: C64Color): void {
  // Ceil, so a fully-shut wipe really does cover the middle row rather than
  // leaving a one-row slot of the outgoing part showing through.
  const rows = Math.ceil((PART_ROWS / 2) * Math.min(1, Math.max(0, closed)));
  for (let i = 0; i < rows; i++) {
    for (const y of [i, PART_ROWS - 1 - i]) {
      for (let x = 0; x < COLS; x++) poke(s, x, y, SOLID, color);
    }
  }
}

/** The part's name, centred at the top, the way a demo captions itself. */
function partName(s: Screen, id: PartId, fade: number): void {
  const text = PART_NAMES[id];
  const x = Math.floor((COLS - text.length) / 2);
  // Blink out rather than fade — there is no dimmer between two palette entries.
  print(s, x, 1, text, fade > 0.25 || Math.floor(fade * 24) % 2 === 0 ? WHITE : BLACK);
}

function runPart(d: Demo, id: PartId, dt: number, feed: Feed): void {
  switch (id) {
    case "logo":
      return logo(d.screen, d.clock, feed);
    case "plasma":
      return plasma(d.screen, d.clock, feed);
    case "twister":
      return twister(d.screen, d.clock, feed);
    case "stars":
      return starfield(d.screen, d.stars, dt, feed);
    case "balls":
      return vectorBalls(d.screen, d.clock, feed);
    case "fire":
      return fire(d.screen, d.fire, feed);
    case "scope":
      return scope(d.screen, d.clock, feed);
  }
}

/**
 * Advance the demo by `dt` seconds and redraw its screen.
 *
 * Mutates rather than returning a new state: it's a 1000-cell screen redrawn at
 * frame rate, and allocating two typed arrays per frame to be pure would be the
 * most expensive thing the visualiser does.
 */
export function stepDemo(d: Demo, dt: number, feed: Feed): void {
  d.t += dt;
  d.clock += dt;
  d.sinceBeat = feed.beat !== d.lastBeat ? 0 : d.sinceBeat + dt;
  d.lastBeat = feed.beat;

  const line = loadLine(feed.title);

  if (d.phase === "boot") {
    drawBanner(d.screen);
    cursor(d.screen, 0, 6, d.t);
    if (d.t >= BOOT_HOLD) {
      d.phase = "typing";
      d.t = 0;
    }
    return;
  }

  if (d.phase === "typing") {
    drawBanner(d.screen);
    const typed = Math.min(line.length, Math.floor(d.t * TYPE_RATE));
    print(d.screen, 0, 6, line.slice(0, typed), LIGHT_BLUE);
    cursor(d.screen, typed, 6, d.t);
    if (typed >= line.length) {
      d.phase = "loading";
      d.t = 0;
    }
    return;
  }

  if (d.phase === "loading") {
    drawBanner(d.screen);
    print(d.screen, 0, 6, line, LIGHT_BLUE);
    print(d.screen, 0, 8, `SEARCHING FOR ${loadName(feed.title)}`, LIGHT_BLUE);
    if (d.t > 0.45) print(d.screen, 0, 9, "LOADING", LIGHT_BLUE);
    if (d.t > 0.9) {
      print(d.screen, 0, 10, "READY.", LIGHT_BLUE);
      print(d.screen, 0, 11, "SYS 4096", LIGHT_BLUE);
      cursor(d.screen, 0, 12, d.t);
    }
    if (d.t >= LOAD_HOLD) {
      d.phase = "part";
      d.t = 0;
      clear(d.screen, WHITE);
      d.screen.background = BLACK;
    }
    return;
  }

  // Running the order.
  if (d.t >= PART_SECS) {
    d.t -= PART_SECS;
    d.part = (d.part + 1) % RUNNING_ORDER.length;
  }
  const id = RUNNING_ORDER[d.part];
  runPart(d, id, dt, feed);

  // Opening and closing wipes live inside the part's own slot, so the running
  // effect is what's revealed rather than a blank screen.
  const opening = 1 - Math.min(1, d.t / WIPE_SECS);
  const closing = Math.max(0, (d.t - (PART_SECS - WIPE_SECS)) / WIPE_SECS);
  const shut = Math.max(opening, closing);
  if (shut > 0) wipe(d.screen, shut, HUE_WHEEL[d.part % HUE_WHEEL.length]);
  else if (d.t < WIPE_SECS + NAME_SECS) {
    partName(d.screen, id, (d.t - WIPE_SECS) / NAME_SECS);
  }

  d.scrollX += dt * SCROLL_RATE;
  const text = scrollText(feed.lines);
  if (d.scrollX >= text.length) d.scrollX -= text.length;
  drawScroller(d.screen, text, d.scrollX, d.clock);

  // The border is a single register, so a beat can only be a colour change —
  // which is exactly what a C64 demo did with it.
  //
  // A COLOUR change, though, and never white. Snapping the whole border to white
  // on every beat is a full-frame strobe twice a second at any normal tempo: the
  // border is a quarter of the picture, white is the brightest thing the VIC has,
  // and 125BPM is squarely in the range that is a problem to look at rather than
  // merely loud. It steps up the raster ramp instead, as far as the kick pushes it
  // and no further than the ramp's cool half, then falls back over a fifth of a
  // second — so a beat still lands on the border, as a bar of colour rather than
  // as a flash. Quiet passages barely move it.
  const decay = Math.max(0, 1 - d.sinceBeat / 0.2);
  const kick = Math.min(1, decay * (0.3 + feed.bass * 0.7));
  const COOL = 2; // BLUE, PURPLE, LIGHT_BLUE — the ramp's dark end
  d.screen.border = kick > 0.1 ? RASTER_RAMP[Math.round(kick * COOL)] : BLACK;
  // …and a bar of it either side of the scroller strip, so the split reads as
  // deliberate rather than as the effect having stopped short. One row of
  // characters rather than a quarter of the frame, so this one may brighten.
  for (let x = 0; x < COLS; x++) {
    poke(d.screen, x, PART_ROWS, CHAR.HLINE, kick > 0.1 ? LIGHT_GREY : DARK_GREY);
  }
}

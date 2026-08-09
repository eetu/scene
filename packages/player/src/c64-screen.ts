// A C64 text screen: the surface every demo part draws on.
//
// Modelled the way the machine did it, because the font lets us: C64 Pro Mono
// maps the character ROM into the Private Use Area at `0xEE00 + code`, so a
// glyph is addressable by *screen code*. That makes the natural model the real
// one — 1000 bytes of screen RAM and 1000 of colour RAM, plus the border and
// background registers — rather than a grid of Unicode strings with a lookup
// table in front of it. Reverse video comes free at `code | 0x80`, which is how
// the fills and the cursor are drawn.
//
// Renderer-free on purpose, like nixie-geometry.ts beside it: c64-parts.ts and
// c64-demo.ts are the interesting halves and this way they test without a canvas.

import { type C64Color, LIGHT_BLUE, BLUE } from "./c64-palette";

export const COLS = 40;
export const ROWS = 25;
const CELLS = COLS * ROWS;

/** Reverse space — a solid block in the cell's colour. The C64's fill. */
export const SOLID = 0xa0;
/** Screen code for a blank cell. */
export const SPACE = 0x20;

/**
 * Screen codes for the graphics characters the effects draw with.
 *
 * Read out of the font rather than off a PETSCII chart: the two are not in the
 * order you would guess (the diagonals are the wrong way round against most
 * published tables), and a wrong code here is a silently different picture
 * rather than an error. Derived by matching each glyph's name between its
 * Unicode mapping and its `0xEE00 + code` one.
 */
export const CHAR = {
  /** ▁▂▃▄▅▆▇█ — a cell filling from the bottom in eighths. */
  FILL: [SPACE, 100, 111, 121, 98, 248, 247, 227, SOLID] as const,
  /** ▒ — the checkerboard. The only isotropic half-tone in the ROM. */
  CHECKER: 102,
  /** ▀ (reverse of ▄) and ▄. */
  TOP_HALF: 226,
  BOTTOM_HALF: 98,
  /** ▌ and ▐. */
  LEFT_HALF: 97,
  RIGHT_HALF: 225,
  /** ● and ○ — the ball characters. */
  DISC: 81,
  RING: 87,
  /** ╱ and ╲. Note the codes: these are the opposite way round to the usual
   *  listing, which is exactly the sort of thing the font was asked about. */
  SLASH: 78,
  BACKSLASH: 77,
  CROSS: 86,
  /** ─ and │. */
  HLINE: 64,
  VLINE: 93,
  /** The card suits, and π — the C64's own decorations. */
  HEART: 83,
  SPADE: 65,
  CLUB: 88,
  DIAMOND: 90,
  PI: 94,
  /** Punctuation reused as star sizes: `.` `+` `*`. */
  DOT: 46,
  PLUS: 43,
  STAR: 42,
} as const;

/** Reverse video, which the ROM gives for free in the top half of the table. */
export const reverse = (code: number): number => code | 0x80;

/**
 * A 4×5 block alphabet, for the parts that need letters bigger than a cell.
 *
 * The character ROM is one size and cannot be scaled, so a demo that wants a
 * logo draws it out of solid cells — which is what every C64 logo actually is,
 * only with a bespoke charset instead of a bitmap. Four columns is the widest
 * that still fits eight characters across a 40-column screen with gaps.
 */
const GLYPH_ROWS = 5;
const GLYPH_COLS = 4;
// prettier-ignore
const BIG: Record<string, string[]> = {
  A: [".##.", "#..#", "####", "#..#", "#..#"],
  B: ["###.", "#..#", "###.", "#..#", "###."],
  C: [".###", "#...", "#...", "#...", ".###"],
  D: ["###.", "#..#", "#..#", "#..#", "###."],
  E: ["####", "#...", "###.", "#...", "####"],
  F: ["####", "#...", "###.", "#...", "#..."],
  G: [".###", "#...", "#.##", "#..#", ".###"],
  H: ["#..#", "#..#", "####", "#..#", "#..#"],
  I: ["###.", ".#..", ".#..", ".#..", "###."],
  J: ["..##", "...#", "...#", "#..#", ".##."],
  K: ["#..#", "#.#.", "##..", "#.#.", "#..#"],
  L: ["#...", "#...", "#...", "#...", "####"],
  M: ["#..#", "####", "####", "#..#", "#..#"],
  N: ["#..#", "##.#", "#.##", "#..#", "#..#"],
  O: [".##.", "#..#", "#..#", "#..#", ".##."],
  P: ["###.", "#..#", "###.", "#...", "#..."],
  Q: [".##.", "#..#", "#..#", "#.#.", ".#.#"],
  R: ["###.", "#..#", "###.", "#.#.", "#..#"],
  S: [".###", "#...", ".##.", "...#", "###."],
  T: ["####", ".#..", ".#..", ".#..", ".#.."],
  U: ["#..#", "#..#", "#..#", "#..#", ".##."],
  V: ["#..#", "#..#", "#..#", ".##.", "..#."],
  W: ["#..#", "#..#", "####", "####", "#..#"],
  X: ["#..#", "#..#", ".##.", "#..#", "#..#"],
  Y: ["#..#", "#..#", ".##.", ".#..", ".#.."],
  Z: ["####", "...#", ".##.", "#...", "####"],
  "0": [".##.", "#.##", "##.#", "#..#", ".##."],
  "1": [".#..", "##..", ".#..", ".#..", "###."],
  "2": ["###.", "...#", ".##.", "#...", "####"],
  "3": ["###.", "...#", ".##.", "...#", "###."],
  "4": ["#..#", "#..#", "####", "...#", "...#"],
  "5": ["####", "#...", "###.", "...#", "###."],
  "6": [".###", "#...", "###.", "#..#", ".##."],
  "7": ["####", "...#", "..#.", ".#..", ".#.."],
  "8": [".##.", "#..#", ".##.", "#..#", ".##."],
  "9": [".##.", "#..#", ".###", "...#", "###."],
  "-": ["....", "....", "####", "....", "...."],
  ".": ["....", "....", "....", "....", ".#.."],
  "'": [".#..", ".#..", "....", "....", "...."],
  "!": [".#..", ".#..", ".#..", "....", ".#.."],
  "?": ["###.", "...#", ".##.", "....", ".#.."],
};

/** Cells one line of `printBig` occupies: 5 per character less the last gap. */
export const bigWidth = (text: string) => Math.max(0, text.length * (GLYPH_COLS + 1) - 1);
export const BIG_HEIGHT = GLYPH_ROWS;

/**
 * Draw `text` in block letters with its top-left at (x, y).
 *
 * `color` may be a function of the cell so a caller can run a gradient or a
 * cycle through the letters — which is most of what makes a logo look like a
 * logo rather than like large text.
 */
export function printBig(
  s: Screen,
  x: number,
  y: number,
  text: string,
  color: C64Color | ((cx: number, cy: number) => C64Color),
  code: number = SOLID,
): void {
  const pick = typeof color === "function" ? color : () => color;
  for (let i = 0; i < text.length; i++) {
    const rows = BIG[text[i].toUpperCase()];
    if (!rows) continue;
    const ox = x + i * (GLYPH_COLS + 1);
    for (let ry = 0; ry < rows.length; ry++) {
      for (let rx = 0; rx < GLYPH_COLS; rx++) {
        if (rows[ry][rx] !== "#") continue;
        poke(s, ox + rx, y + ry, code, pick(ox + rx, y + ry));
      }
    }
  }
}

export type Screen = {
  /** Screen RAM: one screen code per cell, row-major. */
  chars: Uint8Array;
  /** Colour RAM: one palette index per cell. */
  colors: Uint8Array;
  border: C64Color;
  background: C64Color;
};

export function createScreen(): Screen {
  return {
    chars: new Uint8Array(CELLS).fill(SPACE),
    colors: new Uint8Array(CELLS).fill(LIGHT_BLUE),
    border: LIGHT_BLUE,
    background: BLUE,
  };
}

/** Blank the screen, or just its top `rows` — a part owns the top of the screen
 *  and must not wipe the scroller running underneath it. */
export function clear(s: Screen, color: C64Color, rows = ROWS): void {
  const end = Math.max(0, Math.min(ROWS, rows)) * COLS;
  s.chars.fill(SPACE, 0, end);
  s.colors.fill(color, 0, end);
}

/**
 * ASCII → screen code, for the unshifted (uppercase/graphics) character set.
 *
 * Screen codes are not PETSCII and not ASCII: `@` is 0, `A`–`Z` are 1–26, and
 * only the run from space to `?` happens to coincide with ASCII. Lower case
 * folds to upper because the unshifted set has no lower case — that set is what
 * a C64 boots into, and what the banner below is written in.
 */
export function screenCode(ch: string): number {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c === 64) return 0; // @
  if (c >= 65 && c <= 90) return c - 64; // A-Z
  if (c >= 32 && c <= 63) return c; // space ! " … 0-9 : ; < = > ?
  if (c === 91) return 27; // [
  if (c === 93) return 29; // ]
  return SPACE;
}

/** Write `text` at (x, y). Clipped at the right edge rather than wrapping — a
 *  line that runs off is a bug in the caller, not something to reflow. */
export function print(s: Screen, x: number, y: number, text: string, color: C64Color): void {
  if (y < 0 || y >= ROWS) return;
  for (let i = 0; i < text.length; i++) {
    const cx = x + i;
    if (cx < 0 || cx >= COLS) continue;
    const at = y * COLS + cx;
    s.chars[at] = screenCode(text[i]);
    s.colors[at] = color;
  }
}

/** Poke one cell. */
export function poke(s: Screen, x: number, y: number, code: number, color: C64Color): void {
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return;
  s.chars[y * COLS + x] = code & 0xff;
  s.colors[y * COLS + x] = color;
}

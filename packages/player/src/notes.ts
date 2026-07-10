// Pure note / tracker-cell helpers — no store, engine, or browser deps, so they
// unit-test in isolation. Shared by the store, the pattern view, and the editor.

/** Index of each value within a structured pattern cell (libopenmpt order). */
export const CELL = { note: 0, inst: 1, volcmd: 2, vol: 3, fx: 4, param: 5 } as const;

/** Editor cursor fields (note / instrument / volume / effect / param). */
export const FIELD = { note: 0, inst: 1, vol: 2, fx: 3, param: 4 } as const;
export const NUM_FIELDS = 5;
/** Cursor field → cell index. */
export const EDIT_FIELDS = [CELL.note, CELL.inst, CELL.vol, CELL.fx, CELL.param];

// libopenmpt note values (soundlib/modcommand.h): 0 empty, 1..120 real notes
// (NOTE_MIDDLEC = 61 = C-5), 253 fade, 254 cut, 255 key-off.
const NOTE_MIN = 1;
const NOTE_MAX = 120;
const NOTE_MIDDLEC = 61;
export const NOTE_FADE = 253;
export const NOTE_CUT = 254;
export const NOTE_OFF = 255;
const SEMI = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];

/** True for a playable pitch (not empty/off/cut/fade). */
export function isRealNote(n: number): boolean {
  return n >= NOTE_MIN && n <= NOTE_MAX;
}
/** libopenmpt note value → display name ("C-5", "===", "^^^", "~~~", "..."). */
export function noteName(n: number): string {
  if (isRealNote(n)) return SEMI[(n - 1) % 12] + Math.floor((n - 1) / 12);
  if (n === NOTE_OFF) return "===";
  if (n === NOTE_CUT) return "^^^";
  if (n === NOTE_FADE) return "~~~";
  return "...";
}
/** libopenmpt note value → jam/playbackRate note (jamNote's 60 = sample middle-C,
 *  libopenmpt's 61 = NOTE_MIDDLEC), so pattern note N plays at the right pitch. */
export function noteToJam(n: number): number {
  return n - (NOTE_MIDDLEC - 60);
}

// QWERTY → semitone offset from the base octave's C (two-octave tracker layout,
// same map as JamKeyboard). Bottom row 0..12, top row 12..24.
export const NOTE_KEYS: Record<string, number> = {
  z: 0,
  s: 1,
  x: 2,
  d: 3,
  c: 4,
  v: 5,
  g: 6,
  b: 7,
  h: 8,
  n: 9,
  j: 10,
  m: 11,
  ",": 12,
  q: 12,
  "2": 13,
  w: 14,
  "3": 15,
  e: 16,
  r: 17,
  "5": 18,
  t: 19,
  "6": 20,
  y: 21,
  "7": 22,
  u: 23,
  i: 24,
};
export const HEX: Record<string, number> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  a: 10,
  b: 11,
  c: 12,
  d: 13,
  e: 14,
  f: 15,
};

/** Uppercase hex, zero-padded to `w` digits. */
export function hx(n: number, w: number): string {
  return n.toString(16).toUpperCase().padStart(w, "0");
}

/** Display text for one field of a structured cell (editor render). */
export function cellFieldText(cell: number[], field: number): string {
  switch (field) {
    case FIELD.note:
      return noteName(cell[CELL.note]);
    case FIELD.inst:
      return cell[CELL.inst] ? hx(cell[CELL.inst], 2) : "··";
    case FIELD.vol:
      return cell[CELL.volcmd] ? hx(cell[CELL.vol], 2) : "··";
    case FIELD.fx:
      return cell[CELL.fx] || cell[CELL.param] ? hx(cell[CELL.fx], 1) : "·";
    case FIELD.param:
      return cell[CELL.fx] || cell[CELL.param] ? hx(cell[CELL.param], 2) : "··";
    default:
      return "";
  }
}

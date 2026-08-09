// Turning a raster frame of SID registers into a row of the trace grid.
//
// Pure and dependency-free, like registers.ts beside it, so the layout rules
// that make the grid readable are testable without a browser or an engine.
//
// The central rule is *change detection*. A SID play routine rewrites most of
// the register file every frame whether or not anything happened, so printing
// each frame's values verbatim yields a wall of identical text with the actual
// events invisible inside it. A tracker pattern shows an event on the row it
// occurs and continuation dots elsewhere; this reconstructs that by diffing each
// frame against the one before it.

import { type Chip, decodeChips, noteFor, type Voice } from "./registers";

/** One voice's cell on one row. Dotted fields are continuations, not silence. */
export type TraceCell = {
  /** Voice index across all chips, so a 2SID tune runs 0..5. */
  index: number;
  /** Note name on the frame it was struck, else null for a continuation. */
  note: string | null;
  /** Waveform glyphs; several at once is legal and common. */
  wave: string;
  waveChanged: boolean;
  /** ADSR packed as four nibbles, `AADSR` style — the form siddump prints. */
  adsr: string;
  adsrChanged: boolean;
  /** 12-bit pulse width, null when this voice isn't using the pulse waveform
   *  (where it has no audible effect and would just be noise on screen). */
  pulse: string | null;
  pulseChanged: boolean;
  gate: boolean;
};

/** Waveform glyphs, chosen from the C64's own character ROM.
 *
 *  The grid renders in C64 Pro Mono, whose repertoire is exactly the 304 glyphs
 *  of that ROM — a shape outside it falls back to another face and lands with a
 *  different advance width, which breaks the column. So these are all PETSCII:
 *  the two diagonals, the upper half block and the checkerboard. The diagonals
 *  read as ramps (up for triangle, down for saw) and the checkerboard as noise;
 *  the column header carries the legend, because ╱ and ╲ don't self-explain. */
const GLYPH = { triangle: "╱", saw: "╲", pulse: "▀", noise: "▒" } as const;

/** Placeholder for a field that hasn't changed, or a voice with no waveform.
 *
 *  A period rather than the typographic middle dot: U+00B7 is NOT in the C64
 *  character ROM, so it would fall back mid-row and break the grid it's meant
 *  to quiet down. */
export const DOT = ".";

const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, "0");

/** The waveform select as glyphs, or a dot for none (which is silence, whatever
 *  the gate says). */
export function waveGlyph(v: Voice): string {
  if (!v.waveforms.length) return DOT;
  return v.waveforms.map((w) => GLYPH[w]).join("");
}

/** Was this frame the *start* of a note on this voice?
 *
 *  Either the gate just went high, or it stayed high while the frequency moved
 *  — a legato slide is still a new pitch worth printing. A voice holding one
 *  note across fifty frames prints it once, which is what makes the grid
 *  scannable. */
function struck(v: Voice, was: Voice | undefined): boolean {
  if (!v.gate) return false;
  if (!was || !was.gate) return true;
  return was.freq !== v.freq;
}

/** Decode one frame into cells, diffed against the previous frame.
 *
 *  `prev` absent (the first frame of a tune) means everything reads as changed,
 *  which is right: at that point every value is news. */
export function traceCells(row: ArrayLike<number>, prev?: ArrayLike<number>): TraceCell[] {
  const now: Chip[] = decodeChips(row);
  const before: Chip[] | null = prev ? decodeChips(prev) : null;
  const out: TraceCell[] = [];
  for (let c = 0; c < now.length; c++) {
    for (let i = 0; i < now[c].voices.length; i++) {
      const v = now[c].voices[i];
      const was = before?.[c]?.voices[i];
      const usesPulse = v.waveforms.includes("pulse");
      out.push({
        index: v.index,
        note: struck(v, was) ? noteFor(v.hz) || null : null,
        wave: waveGlyph(v),
        waveChanged: !was || waveGlyph(was) !== waveGlyph(v),
        adsr: hex((v.attack << 12) | (v.decay << 8) | (v.sustain << 4) | v.release, 4),
        adsrChanged:
          !was ||
          was.attack !== v.attack ||
          was.decay !== v.decay ||
          was.sustain !== v.sustain ||
          was.release !== v.release,
        pulse: usesPulse ? hex(v.pulseWidth, 3) : null,
        pulseChanged: usesPulse && (!was || was.pulseWidth !== v.pulseWidth),
        gate: v.gate,
      });
    }
  }
  return out;
}

/** Memoised [`traceCells`], keyed by the row itself.
 *
 *  The grid re-renders at the frame rate while showing ~48 rows, so decoding on
 *  every render would mean thousands of decodes a second for rows that cannot
 *  have changed — a recorded frame is immutable once captured. Each row is
 *  decoded once, ever. A WeakMap so trimmed-off rows are collectable. */
const memo = new WeakMap<object, TraceCell[]>();

export function traceRow(row: Uint8Array, prev?: Uint8Array): TraceCell[] {
  const hit = memo.get(row);
  if (hit) return hit;
  const cells = traceCells(row, prev);
  memo.set(row, cells);
  return cells;
}

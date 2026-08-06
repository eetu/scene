// Decoding the MOS 6581/8580 register file into something a UI can draw.
//
// Pure and dependency-free so it unit-tests without an engine or a browser. The
// numbers come straight off the chip (see sid.worker.ts), so this is the whole
// truth about what a SID is doing at a given instant — there is no pattern grid
// behind it to consult.
//
// Per voice, at `base = voice * 7`:
//   +0,+1  frequency (16-bit LE)
//   +2,+3  pulse width (12-bit LE, only meaningful for the pulse waveform)
//   +4     control: bit0 gate, bit1 sync, bit2 ring mod, bit3 test,
//          bits 4-7 waveform select (triangle/saw/pulse/noise)
//   +5     attack (hi nibble) / decay (lo)
//   +6     sustain (hi) / release (lo)
// Then, per chip:
//   +21,+22 filter cutoff, +23 resonance + routing, +24 mode + master volume

/** Registers per SID chip. */
export const CHIP_REGS = 32;
/** Voices per SID chip. */
export const VOICES_PER_CHIP = 3;
const VOICE_STRIDE = 7;

/** Waveform select bits, in register order (bit 4 → bit 7). */
export type Waveform = "triangle" | "saw" | "pulse" | "noise";

export type Voice = {
  /** 0-based index across all chips, so a 2SID tune runs 0..5. */
  index: number;
  /** Raw 16-bit frequency register. */
  freq: number;
  /** Hz at the PAL clock — what you'd actually hear. */
  hz: number;
  /** 12-bit pulse width; only audible with the pulse waveform. */
  pulseWidth: number;
  /** Selected waveforms. More than one at a time is legal (and combined
   *  waveforms are a real SID technique); none means silence. */
  waveforms: Waveform[];
  gate: boolean;
  sync: boolean;
  ring: boolean;
  test: boolean;
  /** ADSR, each 0-15 as stored. */
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Routed through the chip's filter. */
  filtered: boolean;
};

export type Chip = {
  index: number;
  voices: Voice[];
  /** 11-bit filter cutoff. */
  cutoff: number;
  /** 4-bit resonance. */
  resonance: number;
  /** Filter mode bits — a SID can run several at once. */
  lowPass: boolean;
  bandPass: boolean;
  highPass: boolean;
  /** Voice 3 muted from the output (the classic "use it for modulation" bit). */
  voice3Off: boolean;
  /** 4-bit master volume. Tunes that play digis hammer this register. */
  volume: number;
};

/** PAL system clock. NTSC is 1_022_727; the difference is why a tune played at
 *  the wrong standard is audibly detuned. */
export const PAL_CLOCK = 985_248;

/** Register frequency → Hz. The SID's oscillator advances its accumulator by
 *  `freq` each clock over a 24-bit range, so the output is
 *  `freq * clock / 2^24`. */
export function freqToHz(freq: number, clock = PAL_CLOCK): number {
  return (freq * clock) / 16777216;
}

const WAVEFORMS: [number, Waveform][] = [
  [0x10, "triangle"],
  [0x20, "saw"],
  [0x40, "pulse"],
  [0x80, "noise"],
];

/** Decode one chip's worth of registers. */
function decodeChip(r: ArrayLike<number>, index: number, clock: number): Chip {
  const at = (o: number) => r[o] ?? 0;
  const voices: Voice[] = [];
  for (let v = 0; v < VOICES_PER_CHIP; v++) {
    const b = v * VOICE_STRIDE;
    const ctrl = at(b + 4);
    const freq = at(b) | (at(b + 1) << 8);
    voices.push({
      index: index * VOICES_PER_CHIP + v,
      freq,
      hz: freqToHz(freq, clock),
      pulseWidth: (at(b + 2) | (at(b + 3) << 8)) & 0x0fff,
      waveforms: WAVEFORMS.filter(([bit]) => ctrl & bit).map(([, name]) => name),
      gate: !!(ctrl & 0x01),
      sync: !!(ctrl & 0x02),
      ring: !!(ctrl & 0x04),
      test: !!(ctrl & 0x08),
      attack: at(b + 5) >> 4,
      decay: at(b + 5) & 0x0f,
      sustain: at(b + 6) >> 4,
      release: at(b + 6) & 0x0f,
      filtered: !!(at(23) & (1 << v)),
    });
  }
  const mode = at(24);
  return {
    index,
    voices,
    cutoff: (at(21) & 0x07) | (at(22) << 3), // 3 low bits + 8 high
    resonance: at(23) >> 4,
    lowPass: !!(mode & 0x10),
    bandPass: !!(mode & 0x20),
    highPass: !!(mode & 0x40),
    voice3Off: !!(mode & 0x80),
    volume: mode & 0x0f,
  };
}

/** Decode the flattened register dump into one entry per installed chip. */
/** `regs` is `ArrayLike` rather than `number[]` so the trace grid can decode a
 *  `Uint8Array` row straight out of the ring buffer without copying it first —
 *  at 50 rows a second that copy is the whole cost of the view. */
export function decodeChips(regs: ArrayLike<number>, clock = PAL_CLOCK): Chip[] {
  const chips: Chip[] = [];
  for (let c = 0; c * CHIP_REGS < regs.length; c++) {
    chips.push(decodeChip(window(regs, c * CHIP_REGS, CHIP_REGS), c, clock));
  }
  return chips;
}

/** A zero-copy view of `len` items from `start`. */
function window(regs: ArrayLike<number>, start: number, len: number): ArrayLike<number> {
  if (ArrayBuffer.isView(regs) && regs instanceof Uint8Array) {
    return regs.subarray(start, start + len);
  }
  return Array.prototype.slice.call(regs, start, start + len);
}

/** Note name for a frequency, e.g. `A-4`. Empty below hearing — a gated-off
 *  voice often leaves a stale frequency behind, and labelling that as a note
 *  would imply it's sounding. */
export function noteFor(hz: number): string {
  if (hz < 16) return "";
  const NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
  // MIDI 69 = A4 = 440Hz; C0 is MIDI 12, which is octave 0 in tracker notation.
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const octave = Math.floor(midi / 12) - 1;
  if (octave < 0 || octave > 9) return "";
  return `${NAMES[midi % 12]}${octave}`;
}

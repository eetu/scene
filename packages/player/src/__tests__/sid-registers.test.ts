// Decoding the SID register file. Pure maths and bit-twiddling, so it's worth
// pinning precisely — the voice monitor is only as truthful as this, and a
// wrong shift silently draws a plausible-looking lie.
import { describe, expect, test } from "vitest";

import { CHIP_REGS, decodeChips, freqToHz, noteFor, PAL_CLOCK } from "../sid/registers";

/** A chip's registers with `set` applied by absolute offset. */
function chip(set: Record<number, number> = {}): number[] {
  const r = new Array(CHIP_REGS).fill(0);
  for (const [o, v] of Object.entries(set)) r[Number(o)] = v;
  return r;
}

describe("voice decoding", () => {
  test("splits frequency, pulse width and ADSR out of the register pairs", () => {
    const v = decodeChips(
      chip({
        0: 0x34,
        1: 0x12, // freq = 0x1234, little-endian
        2: 0x88,
        3: 0x07, // pulse width = 0x0788 (12-bit)
        5: 0x9a, // attack 9, decay 10
        6: 0xf3, // sustain 15, release 3
      }),
    )[0].voices[0];
    expect(v.freq).toBe(0x1234);
    expect(v.pulseWidth).toBe(0x0788);
    expect([v.attack, v.decay, v.sustain, v.release]).toEqual([9, 10, 15, 3]);
  });

  test("pulse width keeps only its 12 significant bits", () => {
    // The top nibble of the high byte isn't part of the value; including it
    // would report widths beyond full scale.
    const v = decodeChips(chip({ 2: 0xff, 3: 0xff }))[0].voices[0];
    expect(v.pulseWidth).toBe(0x0fff);
  });

  test("reads every control bit, and allows combined waveforms", () => {
    // Triangle+pulse together is a real SID technique, not an error — so the
    // decoder reports a set, never a single winner.
    const v = decodeChips(chip({ 4: 0x10 | 0x40 | 0x01 | 0x04 }))[0].voices[0];
    expect(v.waveforms).toEqual(["triangle", "pulse"]);
    expect(v.gate).toBe(true);
    expect(v.ring).toBe(true);
    expect(v.sync).toBe(false);
    expect(v.test).toBe(false);
  });

  test("no waveform selected is silence, not a default", () => {
    expect(decodeChips(chip({ 4: 0x01 }))[0].voices[0].waveforms).toEqual([]);
  });

  test("filter routing is per voice, from one shared register", () => {
    // $17 low nibble: bit0 → voice 1, bit1 → voice 2, bit2 → voice 3.
    const c = decodeChips(chip({ 23: 0b0101 }))[0];
    expect(c.voices.map((v) => v.filtered)).toEqual([true, false, true]);
  });
});

describe("chip decoding", () => {
  test("cutoff is 3 low bits plus 8 high bits, not two bytes", () => {
    // $15 holds only the low 3 bits; treating it as a full byte would put the
    // cutoff wildly off.
    const c = decodeChips(chip({ 21: 0xff, 22: 0xff }))[0];
    expect(c.cutoff).toBe(0b111 | (0xff << 3));
    expect(c.cutoff).toBe(2047, "11-bit maximum");
  });

  test("splits resonance, filter modes and master volume", () => {
    const c = decodeChips(chip({ 23: 0xa0, 24: 0x10 | 0x40 | 0x80 | 0x0b }))[0];
    expect(c.resonance).toBe(0xa);
    expect(c.lowPass).toBe(true);
    expect(c.highPass).toBe(true);
    expect(c.bandPass).toBe(false);
    expect(c.voice3Off).toBe(true);
    expect(c.volume).toBe(0xb);
  });

  test("a multi-SID dump decodes into one chip each, with voices numbered across", () => {
    // 2SID and 3SID tunes drive six or nine voices; the monitor numbers them
    // continuously so "voice 5" is unambiguous.
    const two = decodeChips([...chip({ 0: 0x11 }), ...chip({ 0: 0x22 })]);
    expect(two).toHaveLength(2);
    expect(two[1].voices.map((v) => v.index)).toEqual([3, 4, 5]);
    expect(two[1].voices[0].freq).toBe(0x22);
  });

  test("an empty dump (module playback) decodes to nothing", () => {
    expect(decodeChips([])).toEqual([]);
  });
});

describe("frequency", () => {
  test("register value converts to Hz at the system clock", () => {
    // The oscillator advances a 24-bit accumulator by `freq` per clock.
    expect(freqToHz(0x1000, PAL_CLOCK)).toBeCloseTo((0x1000 * PAL_CLOCK) / 2 ** 24, 6);
    // NTSC's faster clock is exactly why a tune played on the wrong standard
    // sounds detuned.
    expect(freqToHz(0x1000, 1_022_727)).toBeGreaterThan(freqToHz(0x1000, PAL_CLOCK));
  });

  test("note names land on the right pitches", () => {
    expect(noteFor(440)).toBe("A-4");
    expect(noteFor(261.63)).toBe("C-4");
  });

  test("a silent or stale voice gets no note rather than a wrong one", () => {
    // A gated-off voice often leaves its frequency behind; labelling that as a
    // note would imply it's sounding.
    expect(noteFor(0)).toBe("");
    expect(noteFor(3)).toBe("");
  });
});

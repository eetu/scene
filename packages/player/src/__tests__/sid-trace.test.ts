// Turning raster frames of SID registers into readable tracker rows.
//
// A SID play routine rewrites the register file every frame whether anything
// happened or not, so the grid lives or dies on change detection: print
// everything and the events vanish into a wall of identical text. These pin the
// rules that decide what counts as an event.
import { describe, expect, test } from "vitest";

import { CHIP_REGS } from "../sid/registers";
import { traceCells, traceRow, waveGlyph } from "../sid/trace";

/** One chip's registers. `freq` is the raw 16-bit value. */
function frame(
  voices: { freq?: number; gate?: boolean; wave?: number; adsr?: [number, number]; pw?: number }[],
): Uint8Array {
  const r = new Uint8Array(CHIP_REGS);
  voices.forEach((v, i) => {
    const b = i * 7;
    const freq = v.freq ?? 0x2000;
    r[b] = freq & 0xff;
    r[b + 1] = freq >> 8;
    const pw = v.pw ?? 0x800;
    r[b + 2] = pw & 0xff;
    r[b + 3] = pw >> 8;
    r[b + 4] = (v.wave ?? 0x40) | (v.gate ? 1 : 0);
    r[b + 5] = v.adsr?.[0] ?? 0x09;
    r[b + 6] = v.adsr?.[1] ?? 0xa0;
  });
  return r;
}

const V = { freq: 0x2000, gate: true };

describe("traceCells", () => {
  test("the first frame of a tune is all news", () => {
    // Nothing to diff against, so every field reads as changed — which is right:
    // at that point every value genuinely is new.
    const [c] = traceCells(frame([V]));
    expect(c.note).not.toBeNull();
    expect(c.waveChanged).toBe(true);
    expect(c.adsrChanged).toBe(true);
  });

  test("a held note prints once, not on every frame it sounds", () => {
    // The whole reason the grid is readable. A voice holding one pitch across
    // fifty frames would otherwise print it fifty times.
    const a = frame([V]);
    const b = frame([V]);
    expect(traceCells(a)[0].note).not.toBeNull();
    expect(traceCells(b, a)[0].note).toBeNull();
  });

  test("a retrigger at the same pitch prints again", () => {
    // Gate low then high is a new note even though the frequency never moved —
    // it's audibly a second note, so it gets a second row entry.
    const on = frame([V]);
    const off = frame([{ ...V, gate: false }]);
    expect(traceCells(off, on)[0].note).toBeNull();
    expect(traceCells(on, off)[0].note).not.toBeNull();
  });

  test("a slide to a new pitch prints, gate untouched", () => {
    // Legato: the gate stays high while the frequency moves. Still a new pitch.
    const a = frame([V]);
    const b = frame([{ freq: 0x2400, gate: true }]);
    expect(traceCells(b, a)[0].note).not.toBeNull();
  });

  test("a gated-off voice never prints a note", () => {
    // The frequency register keeps its last value after note-off; printing it
    // would claim a voice is sounding when it isn't.
    const off = frame([{ ...V, gate: false }]);
    expect(traceCells(off)[0].note).toBeNull();
    expect(traceCells(off)[0].gate).toBe(false);
  });

  test("ADSR and pulse report only when they move", () => {
    const a = frame([{ ...V, adsr: [0x09, 0xa0], pw: 0x800 }]);
    const same = frame([{ ...V, adsr: [0x09, 0xa0], pw: 0x800 }]);
    const moved = frame([{ ...V, adsr: [0x0a, 0xa0], pw: 0x900 }]);
    expect(traceCells(same, a)[0].adsrChanged).toBe(false);
    expect(traceCells(same, a)[0].pulseChanged).toBe(false);
    expect(traceCells(moved, a)[0].adsrChanged).toBe(true);
    expect(traceCells(moved, a)[0].pulseChanged).toBe(true);
  });

  test("pulse width is withheld from waveforms it can't affect", () => {
    // Only the pulse waveform has a pulse width; showing the register for a saw
    // voice is a number that means nothing, in a view already dense with them.
    const saw = frame([{ ...V, wave: 0x20 }]);
    const pulse = frame([{ ...V, wave: 0x40 }]);
    expect(traceCells(saw)[0].pulse).toBeNull();
    expect(traceCells(pulse)[0].pulse).not.toBeNull();
  });

  test("ADSR packs to the four nibbles siddump prints", () => {
    const f = frame([{ ...V, adsr: [0x12, 0x34] }]);
    expect(traceCells(f)[0].adsr).toBe("1234");
  });

  test("every voice of every chip gets a cell, numbered across chips", () => {
    // A 2SID tune has six voices; the grid draws them all.
    const two = new Uint8Array(CHIP_REGS * 2);
    two.set(frame([V, V, V]), 0);
    two.set(frame([V, V, V]), CHIP_REGS);
    expect(traceCells(two).map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("waveGlyph", () => {
  test("combined waveforms show as combined, and none reads as silence", () => {
    const combined = traceCells(frame([{ ...V, wave: 0x50 }]))[0]; // triangle+pulse
    expect(combined.wave.length).toBe(2);
    // No waveform bits at all is silence whatever the gate says.
    expect(traceCells(frame([{ ...V, wave: 0x00 }]))[0].wave).toBe("·");
  });
});

describe("traceRow", () => {
  test("decodes a given row once and reuses it", () => {
    // The grid re-renders at the frame rate over ~48 rows; without this it would
    // re-decode thousands of immutable rows a second.
    const a = frame([V]);
    const b = frame([{ freq: 0x2400, gate: true }]);
    const first = traceRow(b, a);
    expect(traceRow(b, a)).toBe(first);
    // Same object identity means the memo hit, not merely equal values.
    expect(traceRow(b, undefined)).toBe(first);
  });
});

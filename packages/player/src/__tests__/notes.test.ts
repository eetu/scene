import { describe, expect, test } from "vitest";

import {
  CELL,
  cellFieldText,
  FIELD,
  HEX,
  isRealNote,
  NOTE_CUT,
  NOTE_FADE,
  NOTE_KEYS,
  NOTE_OFF,
  noteName,
  noteToJam,
} from "../notes";

describe("isRealNote", () => {
  test("only 1..120 are playable pitches", () => {
    expect(isRealNote(0)).toBe(false); // empty
    expect(isRealNote(1)).toBe(true);
    expect(isRealNote(120)).toBe(true);
    expect(isRealNote(121)).toBe(false);
    expect(isRealNote(NOTE_FADE)).toBe(false);
    expect(isRealNote(NOTE_CUT)).toBe(false);
    expect(isRealNote(NOTE_OFF)).toBe(false);
  });
});

describe("noteName", () => {
  test("real notes map to name + octave (61 = middle C-5)", () => {
    expect(noteName(1)).toBe("C-0");
    expect(noteName(61)).toBe("C-5");
    expect(noteName(62)).toBe("C#5");
    expect(noteName(72)).toBe("B-5");
    expect(noteName(73)).toBe("C-6");
  });
  test("special values render as glyphs", () => {
    expect(noteName(0)).toBe("...");
    expect(noteName(NOTE_OFF)).toBe("===");
    expect(noteName(NOTE_CUT)).toBe("^^^");
    expect(noteName(NOTE_FADE)).toBe("~~~");
  });
});

describe("noteToJam", () => {
  test("shifts libopenmpt's middle-C (61) to the sampler's (60)", () => {
    expect(noteToJam(61)).toBe(60);
    expect(noteToJam(73)).toBe(72);
    expect(noteToJam(1)).toBe(0);
  });
});

describe("keymaps", () => {
  test("QWERTY two-octave layout anchors", () => {
    expect(NOTE_KEYS.z).toBe(0);
    expect(NOTE_KEYS.q).toBe(12);
    expect(NOTE_KEYS.i).toBe(24);
  });
  test("hex digit map", () => {
    expect(HEX["0"]).toBe(0);
    expect(HEX["9"]).toBe(9);
    expect(HEX.a).toBe(10);
    expect(HEX.f).toBe(15);
  });
});

describe("cellFieldText", () => {
  // cell = [note, inst, volcmd, vol, fx, param]
  test("renders each field of a populated cell", () => {
    const cell = [61, 1, 1, 0x40, 0xa, 0x04];
    expect(cellFieldText(cell, FIELD.note)).toBe("C-5");
    expect(cellFieldText(cell, FIELD.inst)).toBe("01");
    expect(cellFieldText(cell, FIELD.vol)).toBe("40"); // volcmd set → show volume
    expect(cellFieldText(cell, FIELD.fx)).toBe("A"); // 1-wide effect nibble
    expect(cellFieldText(cell, FIELD.param)).toBe("04");
  });
  test("empty fields render as dots", () => {
    const empty = [0, 0, 0, 0, 0, 0];
    expect(cellFieldText(empty, FIELD.note)).toBe("...");
    expect(cellFieldText(empty, FIELD.inst)).toBe("··");
    expect(cellFieldText(empty, FIELD.vol)).toBe("··"); // volcmd 0 → no volume
    expect(cellFieldText(empty, FIELD.fx)).toBe("·");
    expect(cellFieldText(empty, FIELD.param)).toBe("··");
  });
  test("effect shows when only the param is set", () => {
    const cell = [0, 0, 0, 0, 0, 0x0f];
    expect(cellFieldText(cell, FIELD.fx)).toBe("0");
    expect(cellFieldText(cell, FIELD.param)).toBe("0F");
  });
  test("CELL indices are the documented order", () => {
    expect(CELL).toEqual({ note: 0, inst: 1, volcmd: 2, vol: 3, fx: 4, param: 5 });
  });
});

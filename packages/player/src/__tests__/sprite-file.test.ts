// The reader half of the sprite format: the four questions the scene asks of a
// sprite. The editing operations and the validator live in ../dab, which owns the
// format and tests them there — this file used to be a copy of those tests, and
// two copies of a format that has grown parts and nesting is two readers that
// drift apart.
import { describe, expect, test } from "vitest";

import {
  cellColour,
  clipFrames,
  flipRows,
  isPartBody,
  isPartRef,
  type Part,
  partNamed,
  type SpriteFile,
  variantNames,
} from "../sprite-file";

const sprite = (over: Partial<SpriteFile> = {}): SpriteFile => ({
  name: "test",
  w: 2,
  h: 1,
  palette: { A: "#ff3bd4", B: "#0b0512" },
  frames: [["AB"]],
  ...over,
});

describe("colour", () => {
  test("a cell takes the variant's colour where it has one, the palette's otherwise", () => {
    const s = sprite({ variants: { cyan: { A: "#39f6ff" } } });
    expect(cellColour(s, "A")).toBe("#ff3bd4");
    expect(cellColour(s, "A", "cyan")).toBe("#39f6ff");
    // Not named by that variant, so it stays as the palette has it.
    expect(cellColour(s, "B", "cyan")).toBe("#0b0512");
    // A variant nobody declared is not an error, it is just the palette.
    expect(cellColour(s, "A", "amber")).toBe("#ff3bd4");
    expect(cellColour(s, ".", "cyan")).toBe(null);
    // Nothing about a character is reserved: an unknown one has no colour, and
    // that is all it means.
    expect(cellColour(s, "Z")).toBe(null);
  });

  test("looks are the palette and then the variants, in declaration order", () => {
    expect(variantNames(sprite())).toEqual([]);
    expect(variantNames(sprite({ variants: { cyan: {}, amber: {} } }))).toEqual(["cyan", "amber"]);
  });
});

describe("clips", () => {
  test("a clip is its frames in order, and an unknown name is null", () => {
    const s = sprite({ frames: [["AB"], ["BA"], ["AA"]], clips: { open: [0, 1, 2], up: [2] } });
    expect(clipFrames(s, "open")).toEqual([0, 1, 2]);
    expect(clipFrames(s, "up")).toEqual([2]);
    // Null rather than the whole strip: a silent fallback hides a typo.
    expect(clipFrames(s, "nope")).toBe(null);
    expect(clipFrames(sprite(), "open")).toBe(null);
  });

  test("the list is copied, so a consumer cannot edit the sprite by playing it", () => {
    const s = sprite({ clips: { open: [0] } });
    clipFrames(s, "open")!.push(9);
    expect(s.clips!.open).toEqual([0]);
  });
});

describe("parts", () => {
  const wheel: Part = { name: "wheel_f", x: 49, y: 10, use: "wheel" };
  const lamp: Part = {
    name: "lights",
    x: 66,
    y: 6,
    w: 1,
    h: 1,
    palette: { b: "#c8253f" },
    frames: [["."], ["b"]],
    clips: { open: [0, 1] },
  };

  test("a part either names a sprite or carries its own pixels", () => {
    expect(isPartRef(wheel)).toBe(true);
    expect(isPartBody(wheel)).toBe(false);
    expect(isPartRef(lamp)).toBe(false);
    expect(isPartBody(lamp)).toBe(true);
  });

  test("a part with pixels IS a sprite, so the readers work on it unchanged", () => {
    expect(isPartBody(lamp) && cellColour(lamp, "b")).toBe("#c8253f");
    expect(isPartBody(lamp) && clipFrames(lamp, "open")).toEqual([0, 1]);
  });

  test("parts are found by name", () => {
    const s = sprite({ parts: [wheel, lamp] });
    expect(partNamed(s, "lights")).toBe(lamp);
    expect(partNamed(s, "wheel_f")).toBe(wheel);
    expect(partNamed(s, "boot")).toBe(null);
    expect(partNamed(sprite(), "lights")).toBe(null);
  });
});

describe("flip", () => {
  const rows = ["AB.", "..C"];

  test("no flip is the rows themselves", () => {
    expect(flipRows(rows)).toBe(rows);
  });

  test("h mirrors each row, v reverses their order, hv does both", () => {
    expect(flipRows(rows, "h")).toEqual([".BA", "C.."]);
    expect(flipRows(rows, "v")).toEqual(["..C", "AB."]);
    expect(flipRows(rows, "hv")).toEqual(["C..", ".BA"]);
  });

  test("flipping twice is where it started", () => {
    expect(flipRows(flipRows(rows, "hv"), "hv")).toEqual(rows);
  });
});

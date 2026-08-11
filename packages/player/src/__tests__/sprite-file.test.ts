// The sprite format and its edit operations. Every tool in the editor ends in
// one of these functions, so this is where a paint bug is caught — a canvas is
// the worst place to find out that flood fill leaks through a diagonal.
import { describe, expect, test } from "vitest";

import {
  addColour,
  addFrame,
  blankSprite,
  cloneSprite,
  duplicateFrame,
  ellipsePoints,
  floodPoints,
  fromJson,
  linePoints,
  moveFrame,
  rectPoints,
  removeColour,
  removeFrame,
  renameChar,
  resizeSprite,
  setPixel,
  setPixels,
  type SpriteFile,
  toJson,
  unusedChars,
  validateSprite,
} from "../sprite-file";

const sprite = (
  rows: string[],
  palette: Record<string, string> = { A: "#ff0000" },
): SpriteFile => ({
  name: "test",
  w: rows[0].length,
  h: rows.length,
  palette,
  frames: [rows],
});

describe("validation", () => {
  test("a blank sprite is valid", () => {
    expect(validateSprite(blankSprite("x", 4, 3))).toEqual([]);
  });

  test("it names every way a file can be wrong, not just the first", () => {
    const errors = validateSprite({
      name: "",
      w: 3,
      h: 2,
      palette: { AB: "#fff", C: "nope" },
      frames: [["...", "..", "..."]],
    });
    expect(errors.some((e) => e.includes("name"))).toBe(true);
    expect(errors.some((e) => e.includes("one character"))).toBe(true);
    expect(errors.some((e) => e.includes("#rrggbb"))).toBe(true);
    expect(errors.some((e) => e.includes("rows"))).toBe(true);
  });

  test("a pixel with no colour behind it is an error", () => {
    expect(validateSprite(sprite(["A.Z"]))).toEqual(["frame 0 row 0 uses Z, which has no colour"]);
  });

  test("`.` is transparent and may not be given a colour", () => {
    expect(validateSprite(sprite(["..."], { ".": "#ffffff" })).join(" ")).toContain("transparent");
  });

  test("the neon characters need no palette entry — the tint pass colours them", () => {
    expect(validateSprite(sprite(["NnN", "..."], {}))).toEqual([]);
  });
});

describe("pixels", () => {
  test("setPixel replaces one cell and leaves the row's length alone", () => {
    const frame = ["....", "...."];
    const out = setPixel(frame, 2, 1, "A");
    expect(out[1]).toBe("..A.");
    expect(out[0]).toBe("....");
    expect(out[1].length).toBe(4);
  });

  test("writing off the edge is a no-op, not a ragged row", () => {
    const frame = ["...."];
    expect(setPixel(frame, 9, 0, "A")).toBe(frame);
    expect(setPixel(frame, 0, -1, "A")).toBe(frame);
  });

  test("an edit that changes nothing returns the same array", () => {
    // The editor's undo stack pushes on identity, so a no-op stroke must not
    // fill history with copies of the same frame.
    const frame = ["A..."];
    expect(setPixel(frame, 0, 0, "A")).toBe(frame);
    expect(setPixels(frame, [[0, 0]], "A")).toBe(frame);
  });

  test("setPixels writes a whole stroke at once", () => {
    const out = setPixels(
      ["....", "...."],
      [
        [0, 0],
        [1, 1],
        [9, 9],
      ],
      "A",
    );
    expect(out).toEqual(["A...", ".A.."]);
  });
});

describe("shapes", () => {
  test("a line is a Bresenham run with no gaps and no doubled pixels", () => {
    const pts = linePoints(0, 0, 5, 2);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([5, 2]);
    expect(new Set(pts.map((p) => p.join(","))).size).toBe(pts.length);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.abs(pts[i][0] - pts[i - 1][0])).toBeLessThanOrEqual(1);
      expect(Math.abs(pts[i][1] - pts[i - 1][1])).toBeLessThanOrEqual(1);
    }
  });

  test("a line drawn backwards covers the same pixels", () => {
    const key = (p: [number, number][]) =>
      p
        .map((q) => q.join(","))
        .sort()
        .join(" ");
    expect(key(linePoints(1, 4, 7, 0))).toBe(key(linePoints(7, 0, 1, 4)));
  });

  test("an unfilled rectangle is its border only", () => {
    const pts = rectPoints(0, 0, 3, 2, false);
    expect(pts.length).toBe(4 * 2 + (3 - 1) * 2 - 2 * 2 + 2); // perimeter of 4x3
    expect(pts.some(([x, y]) => x === 1 && y === 1)).toBe(false);
    expect(rectPoints(0, 0, 3, 2, true).length).toBe(12);
  });

  test("a rectangle is the same whichever corner the drag started from", () => {
    const key = (p: [number, number][]) =>
      p
        .map((q) => q.join(","))
        .sort()
        .join(" ");
    expect(key(rectPoints(3, 2, 0, 0, true))).toBe(key(rectPoints(0, 0, 3, 2, true)));
  });

  test("a square drag gives a circle, and the outline is hollow", () => {
    const filled = ellipsePoints(0, 0, 8, 8, true);
    const ring = ellipsePoints(0, 0, 8, 8, false);
    expect(ring.length).toBeLessThan(filled.length);
    expect(ring.some(([x, y]) => x === 4 && y === 4)).toBe(false);
    expect(filled.some(([x, y]) => x === 4 && y === 4)).toBe(true);
    // Round, not square: the corners of the drag box are outside the disc.
    expect(filled.some(([x, y]) => x === 0 && y === 0)).toBe(false);
  });
});

describe("flood fill", () => {
  const frame = ["AA..", "A.B.", "..BB", "AAAA"];

  test("it takes the connected run and stops at a different colour", () => {
    const pts = floodPoints(frame, 0, 0);
    expect(pts).toContainEqual([0, 0]);
    expect(pts).toContainEqual([1, 0]);
    expect(pts).toContainEqual([0, 1]);
    expect(pts).not.toContainEqual([2, 2]); // B
    expect(pts).not.toContainEqual([0, 3]); // same colour, not connected
  });

  test("it is 4-connected: it does not leak through a diagonal", () => {
    // The `.` at (1,1) reaches (1,2) and (0,2) straight down and left. The `.`
    // at (2,0) is the same colour and touches the region only at a corner —
    // an 8-connected fill would take it, a 4-connected one must not.
    const pts = floodPoints(frame, 1, 1);
    expect(pts).toContainEqual([0, 2]);
    expect(pts).not.toContainEqual([2, 0]);
    expect(pts).not.toContainEqual([2, 2]); // B, a different colour
  });

  test("a seed outside the frame fills nothing", () => {
    expect(floodPoints(frame, -1, 0)).toEqual([]);
    expect(floodPoints(frame, 0, 99)).toEqual([]);
  });
});

describe("resize", () => {
  const s = sprite(["AB", "CD"], { A: "#000000", B: "#111111", C: "#222222", D: "#333333" });

  test("growing pads with transparent and keeps the art where it was", () => {
    const out = resizeSprite(s, 4, 3);
    expect(out.frames[0]).toEqual(["AB..", "CD..", "...."]);
    expect(out.w).toBe(4);
    expect(out.h).toBe(3);
  });

  test("shrinking crops rather than scaling — pixel art has no resample", () => {
    expect(resizeSprite(s, 1, 1).frames[0]).toEqual(["A"]);
  });

  test("centred growth puts the old art in the middle", () => {
    expect(resizeSprite(s, 4, 4, "center").frames[0]).toEqual(["....", ".AB.", ".CD.", "...."]);
  });

  test("every frame resizes, not just the first", () => {
    const two = duplicateFrame(s, 0);
    const out = resizeSprite(two, 3, 2);
    expect(out.frames).toHaveLength(2);
    for (const f of out.frames) expect(f.every((r) => r.length === 3)).toBe(true);
  });
});

describe("frames", () => {
  const s = blankSprite("x", 2, 1);

  test("add, duplicate, move and remove", () => {
    let out = addFrame(s);
    expect(out.frames).toHaveLength(2);
    out = { ...out, frames: [["AA"], ["BB"]] };
    out = duplicateFrame(out, 0);
    expect(out.frames.map((f) => f[0])).toEqual(["AA", "AA", "BB"]);
    out = moveFrame(out, 2, 0);
    expect(out.frames.map((f) => f[0])).toEqual(["BB", "AA", "AA"]);
    out = removeFrame(out, 0);
    expect(out.frames.map((f) => f[0])).toEqual(["AA", "AA"]);
  });

  test("the last frame cannot be removed — a sprite with no frames is not a sprite", () => {
    expect(removeFrame(s, 0).frames).toHaveLength(1);
  });

  test("duplicating copies the rows rather than aliasing them", () => {
    const two = duplicateFrame(sprite(["AA"]), 0);
    const edited = { ...two, frames: [setPixel(two.frames[0], 0, 0, "."), two.frames[1]] };
    expect(edited.frames[1][0]).toBe("AA");
  });
});

describe("palette", () => {
  test("a new colour takes the next free character", () => {
    const out = addColour(blankSprite("x", 1, 1), "#123456");
    expect(Object.entries(out.palette)).toEqual([["A", "#123456"]]);
    expect(Object.keys(addColour(out, "#654321").palette)).toEqual(["A", "B"]);
  });

  test("dropping a colour erases the pixels that used it", () => {
    const out = removeColour(sprite(["AB.", "BA."], { A: "#000000", B: "#ffffff" }), "B");
    expect(out.frames[0]).toEqual(["A..", ".A."]);
    expect(out.palette).toEqual({ A: "#000000" });
  });

  test("renaming a character rewrites every pixel that used it", () => {
    const out = renameChar(sprite(["AA."], { A: "#000000" }), "A", "Z");
    expect(out.frames[0]).toEqual(["ZZ."]);
    expect(out.palette).toEqual({ Z: "#000000" });
  });

  test("renaming onto a taken character is refused rather than merging two colours", () => {
    const s = sprite(["AB"], { A: "#000000", B: "#ffffff" });
    expect(renameChar(s, "A", "B")).toBe(s);
  });

  test("unused entries are reported so they can be swept up", () => {
    expect(unusedChars(sprite(["A."], { A: "#000000", Q: "#ffffff" }))).toEqual(["Q"]);
  });
});

describe("serialisation", () => {
  const s: SpriteFile = {
    name: "sign",
    w: 3,
    h: 2,
    palette: { A: "#ff00ff" },
    tints: ["#ff3bd4", "#39f6ff"],
    frames: [
      ["A.A", ".A."],
      ["...", "AAA"],
    ],
  };

  test("a round trip through JSON is the same sprite", () => {
    const back = fromJson(toJson(s));
    expect("sprite" in back && back.sprite).toEqual(s);
  });

  test("one row per line, so a frame reads as a picture in the diff", () => {
    expect(toJson(s)).toContain('      "A.A",\n      ".A."');
  });

  test("a bad file comes back as errors rather than throwing", () => {
    expect(fromJson("{oh no")).toHaveProperty("errors");
    expect(fromJson('{"name":"x"}')).toHaveProperty("errors");
  });

  test("cloning leaves the original alone", () => {
    const copy = cloneSprite(s);
    copy.frames[0][0] = "...";
    copy.palette.A = "#000000";
    expect(s.frames[0][0]).toBe("A.A");
    expect(s.palette.A).toBe("#ff00ff");
  });
});

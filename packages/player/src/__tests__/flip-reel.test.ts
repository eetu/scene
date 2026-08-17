// The flip-dot board's one-bit films: the format, the matching rule, and what a clip
// costs the hardware.
//
// The clips themselves are not in the repository (see ../assets/README.md), so nothing
// here reads a file. What is testable without one is everything that matters: that the
// decoder and the format agree, that a reel is only ever put in front of the tune it
// was cut for, and that fitting a clip to a board of another shape does not hand the
// discs more work than the generated modes do.
import { describe, expect, test } from "vitest";

import {
  decodeReel,
  frameBytes,
  REEL_IDS,
  reelDot,
  reelFrameAt,
  reelIdFor,
  reelKey,
  sampleReel,
  trackNames,
} from "../flip-reel";

/** The build script's encoder, in miniature: header, then XOR deltas run-length
 *  encoded in bits, alternating unchanged/flipped and starting with unchanged. Kept
 *  here rather than in the source because the player only ever reads a reel — this is
 *  the other half of the format, written out so the decoder is tested against the
 *  spec and not against itself. */
function encodeReel(cols: number, rows: number, fps: number, frames: boolean[][]): ArrayBuffer {
  const total = cols * rows;
  const stride = frameBytes(cols, rows);
  const varint = (n: number, out: number[]) => {
    for (;;) {
      const b = n & 0x7f;
      n >>>= 7;
      out.push(n ? b | 0x80 : b);
      if (!n) return;
    }
  };
  const body: number[] = [];
  let prev = new Uint8Array(stride);
  for (const frame of frames) {
    const cur = new Uint8Array(stride);
    for (let i = 0; i < total; i++) if (frame[i]) cur[i >> 3] |= 0x80 >> (i & 7);
    let run = 0;
    let flip = false;
    for (let i = 0; i < total; i++) {
      const bit = 0x80 >> (i & 7);
      const changed = ((prev[i >> 3] ^ cur[i >> 3]) & bit) !== 0;
      if (changed === flip) run++;
      else {
        varint(run, body);
        run = 1;
        flip = changed;
      }
    }
    varint(run, body);
    prev = cur;
  }
  const out = new Uint8Array(12 + body.length);
  const head = new DataView(out.buffer);
  head.setUint32(0, 0x5245454c, false); // "REEL"
  out[4] = 1;
  out[5] = cols;
  out[6] = rows;
  out[7] = fps;
  head.setUint32(8, frames.length, true);
  out.set(body, 12);
  return out.buffer;
}

/** A frame from a predicate, for readability at these sizes. */
const frame = (cols: number, rows: number, f: (x: number, y: number) => boolean): boolean[] =>
  Array.from({ length: cols * rows }, (_, i) => f(i % cols, Math.floor(i / cols)));

describe("the format", () => {
  test("a clip survives the round trip, frame for frame", () => {
    const cols = 11; // not a multiple of 8: the last byte of a row is a partial one
    const rows = 7;
    const frames = [
      frame(cols, rows, () => false),
      frame(cols, rows, (x, y) => x === y),
      frame(cols, rows, (x) => x < 5),
      frame(cols, rows, () => true),
    ];
    const reel = decodeReel("test", encodeReel(cols, rows, 12, frames));
    expect(reel).not.toBe(null);
    expect(reel!.cols).toBe(cols);
    expect(reel!.rows).toBe(rows);
    expect(reel!.fps).toBe(12);
    expect(reel!.count).toBe(frames.length);
    for (let f = 0; f < frames.length; f++) {
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          expect(reelDot(reel!, f, x, y), `frame ${f} at ${x},${y}`).toBe(frames[f][y * cols + x]);
        }
      }
    }
  });

  test("a frame that changes nothing costs one run", () => {
    // The reason the format is deltas: shadow animation holds still for long stretches,
    // and a held frame should be a couple of bytes rather than a picture.
    const still = frame(8, 8, (x) => x < 3);
    const one = encodeReel(8, 8, 12, [still]).byteLength;
    const ten = encodeReel(
      8,
      8,
      12,
      Array.from({ length: 10 }, () => still),
    ).byteLength;
    expect(ten - one).toBeLessThanOrEqual(9 * 2);
  });

  test("a file that is not a reel, or is cut short, decodes to nothing", () => {
    expect(decodeReel("x", new ArrayBuffer(4))).toBe(null);
    const good = encodeReel(8, 8, 12, [frame(8, 8, (x) => x < 3)]);
    const wrongMagic = good.slice(0);
    new Uint8Array(wrongMagic)[0] = 0x00;
    expect(decodeReel("x", wrongMagic)).toBe(null);
    // Truncated mid-stream: a half-decoded reel would draw as a corrupt frame that
    // never resolves, which on this board looks like a hardware fault.
    expect(decodeReel("x", good.slice(0, good.byteLength - 1))).toBe(null);
  });

  test("out of range is dark, not a throw or a wrap onto the next row", () => {
    const reel = decodeReel("x", encodeReel(8, 4, 12, [frame(8, 4, () => true)]))!;
    expect(reelDot(reel, 0, -1, 0)).toBe(false);
    expect(reelDot(reel, 0, 8, 0)).toBe(false);
    expect(reelDot(reel, 0, 0, 4)).toBe(false);
    expect(reelDot(reel, 1, 0, 0)).toBe(false);
    expect(reelDot(reel, -1, 0, 0)).toBe(false);
  });
});

describe("finding the tune", () => {
  const ids = ["badapple", "someothertune"];

  test("a module is matched however it has been named", () => {
    expect(reelIdFor(ids, "Bad Apple!! (XM cover)", "bad_apple.xm")).toBe("badapple");
    expect(reelIdFor(ids, null, "BADAPPLE.MOD")).toBe("badapple");
    expect(reelIdFor(ids, "bad apple - shadow art", undefined)).toBe("badapple");
  });

  test("and nothing else is", () => {
    // The reel takes the board over. Playing it against a tune it was not cut for is
    // three minutes of an animation that has nothing to do with what you can hear.
    expect(reelIdFor(ids, "Apple Juice", "apples.mod")).toBe(null);
    expect(reelIdFor(ids, "Bad Loop", "bad.mod")).toBe(null);
    expect(reelIdFor(ids, null, null)).toBe(null);
    expect(reelIdFor([], "Bad Apple", "badapple.xm")).toBe(null);
  });

  test("an id too short to mean anything never matches", () => {
    // Ids come from filenames, so a stray `a.bin` would otherwise play against every
    // module with an `a` in it — which is all of them.
    expect(reelIdFor(["ab"], "Absolutely Anything", "ab.mod")).toBe(null);
  });

  test("a SID cover is found in its curator notes, not in its own name", () => {
    // The case this was written for. A C64 arrangement is filed under the arranger's
    // own title — the tune it covers is only written down in HVSC's STIL, which is why
    // `trackNames` reaches for the notes at all. Matching the track's own strings alone
    // finds nothing here, which is exactly what happened.
    const track = { title: "Touhou Medley", filename: "Touhou_Medley.sid" };
    const notes = [{ title: "Bad Apple!!", name: "Touhou Medley" }];
    expect(reelIdFor(ids, ...trackNames(track))).toBe(null);
    expect(reelIdFor(ids, ...trackNames(track, notes))).toBe("badapple");
  });

  test("a note that only mentions the tune in prose does not count", () => {
    // Comments are paragraphs. Matching inside one is how a reel ends up over a tune
    // that merely name-drops another, so `trackNames` never reads them — a comment is
    // not in the list at all.
    const track = { title: "Chip Jam", filename: "chipjam.sid" };
    const names = trackNames(track, [{ title: null, name: "Chip Jam" }]);
    expect(names).not.toContain("in the style of bad apple");
    expect(reelIdFor(ids, ...names)).toBe(null);
  });

  test("names survive a track with nothing filled in", () => {
    expect(reelIdFor(ids, ...trackNames(null))).toBe(null);
    expect(reelIdFor(ids, ...trackNames(undefined, []))).toBe(null);
    expect(reelIdFor(ids, ...trackNames({}, [{ title: null, name: null }]))).toBe(null);
  });

  test("the key is letters and digits, folded down", () => {
    expect(reelKey("Bad Apple!! (XM cover).xm")).toBe("badapplexmcoverxm");
    expect(reelKey("")).toBe("");
  });

  test("no reel ships with the source", () => {
    // The folder is gitignored on purpose: these are derived frames of somebody else's
    // video. A clip appearing in a clean checkout is a licence problem, not a feature.
    expect(REEL_IDS).toEqual([]);
  });
});

describe("playing it", () => {
  const reel = decodeReel(
    "x",
    encodeReel(
      8,
      8,
      10,
      Array.from({ length: 30 }, (_, f) => frame(8, 8, (x) => x === f % 8)),
    ),
  )!;

  test("the playhead picks the frame, and the ends hold", () => {
    expect(reelFrameAt(reel, 0)).toBe(0);
    expect(reelFrameAt(reel, 1)).toBe(10);
    expect(reelFrameAt(reel, 1.04)).toBe(10); // rounded, not floored
    // A clip and a tune are never the same length; running out mid-song must read as a
    // still frame rather than as the board having stopped.
    expect(reelFrameAt(reel, 999)).toBe(29);
    expect(reelFrameAt(reel, -5)).toBe(0);
  });

  test("a clip is fitted and centred on the board, never stretched", () => {
    // A 1:1 clip on a wide board: the picture keeps its shape and the rest of the
    // board stays dark, which on flip dots is a letterbox of unlit discs.
    const cols = 40;
    const rows = 22;
    const out = new Uint8Array(cols * rows);
    const solid = decodeReel("s", encodeReel(8, 8, 10, [frame(8, 8, () => true)]))!;
    sampleReel(solid, 0, cols, rows, out);
    let minX = cols;
    let maxX = -1;
    let minY = rows;
    let maxY = -1;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (!out[y * cols + x]) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    expect(h).toBe(rows); // the short axis is what fits
    expect(Math.abs(w - h)).toBeLessThanOrEqual(1); // and the aspect survived
    // Centred: the margins either side match to within a dot.
    expect(Math.abs(minX - (cols - w - minX))).toBeLessThanOrEqual(1);
  });

  test("a board smaller than the clip loses no more than resolution", () => {
    const out = new Uint8Array(6 * 6);
    sampleReel(reel, 3, 6, 6, out);
    expect(out.some((v) => v === 1)).toBe(true);
    expect(out.length).toBe(36); // nothing written past the end
  });

  test("a reel asks the discs for no more than the generated modes do", () => {
    // The board's own budget (flip-modes.test.ts): 40% of the dots may change per
    // update, because churn is how much of the board is mid-rotation rather than
    // showing a state. This guards the SAMPLER — the fitting and the majority
    // downsample — against a clip of the kind these are for: a shape moving across a
    // held field. What a particular film costs is a build-time question, which is why
    // the script bakes at 12fps and the README says why.
    const cols = 40;
    const rows = 22;
    const BUDGET = Math.round(cols * rows * 0.4);
    const clip = decodeReel(
      "m",
      encodeReel(
        48,
        36,
        12,
        // A disc sweeping across a field, plus a horizon: the two things shadow
        // animation is mostly made of.
        Array.from({ length: 60 }, (_, f) =>
          frame(48, 36, (x, y) => {
            const cx = 6 + (f / 59) * 36;
            return y > 30 || Math.hypot(x - cx, y - 16) < 7;
          }),
        ),
      ),
    )!;
    const a = new Uint8Array(cols * rows);
    const b = new Uint8Array(cols * rows);
    let total = 0;
    let peak = 0;
    for (let f = 1; f < clip.count; f++) {
      sampleReel(clip, f - 1, cols, rows, a);
      sampleReel(clip, f, cols, rows, b);
      let churn = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) churn++;
      total += churn;
      peak = Math.max(peak, churn);
    }
    const mean = total / (clip.count - 1);
    expect(mean, `mean churn ${mean.toFixed(1)} of ${cols * rows} dots`).toBeLessThanOrEqual(
      BUDGET,
    );
    expect(peak, "a single frame moved most of the board").toBeLessThan(cols * rows);
  });
});

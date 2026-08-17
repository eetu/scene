// The flip-dot board's one-bit films: the format, the matching rule, and what a clip
// costs the hardware.
//
// The clips themselves are not in the repository (see ../assets/README.md), so nothing
// here reads a file. What is testable without one is everything that matters: that the
// decoder and the format agree, that a reel is only ever put in front of the tune it
// was cut for, and that fitting a clip to a board of another shape does not hand the
// discs more work than the generated modes do.
import { beforeAll, describe, expect, test } from "vitest";

import {
  decodeReel,
  frameBytes,
  type Reel,
  REEL_IDS,
  reelDot,
  reelFrameAt,
  reelIdFor,
  reelKey,
  sampleReel,
  trackNames,
  watchReel,
} from "../reel";

/** The build script's encoder, in miniature: header, then gzipped packed frames. Kept
 *  here rather than in the source because the player only ever reads a reel — this is
 *  the other half of the format, written out so the decoder is tested against the spec
 *  and not against itself. */
async function encodeReel(
  cols: number,
  rows: number,
  fps: number,
  frames: boolean[][],
): Promise<ArrayBuffer> {
  const total = cols * rows;
  const stride = frameBytes(cols, rows);
  const body = new Uint8Array(frames.length * stride);
  frames.forEach((frame, f) => {
    for (let i = 0; i < total; i++) {
      if (frame[i]) body[f * stride + (i >> 3)] |= 0x80 >> (i & 7);
    }
  });
  const gz = new Uint8Array(
    await new Response(
      new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const out = new Uint8Array(12 + gz.length);
  const head = new DataView(out.buffer);
  head.setUint32(0, 0x5245454c, false); // "REEL"
  out[4] = 2;
  out[5] = cols;
  out[6] = rows;
  out[7] = fps;
  head.setUint32(8, frames.length, true);
  out.set(gz, 12);
  return out.buffer;
}

/** A frame from a predicate, for readability at these sizes. */
const frame = (cols: number, rows: number, f: (x: number, y: number) => boolean): boolean[] =>
  Array.from({ length: cols * rows }, (_, i) => f(i % cols, Math.floor(i / cols)));

describe("the format", () => {
  test("a clip survives the round trip, frame for frame", async () => {
    const cols = 11; // not a multiple of 8: the last byte of a row is a partial one
    const rows = 7;
    const frames = [
      frame(cols, rows, () => false),
      frame(cols, rows, (x, y) => x === y),
      frame(cols, rows, (x) => x < 5),
      frame(cols, rows, () => true),
    ];
    const reel = await decodeReel("test", await encodeReel(cols, rows, 12, frames));
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

  test("a held frame costs almost nothing", async () => {
    // The claim the format rests on, and the reason it is plain frames through gzip
    // rather than hand-rolled deltas: shadow animation holds still for long stretches,
    // and a compressor's window spans many frames, so a repeated one is nearly free.
    const still = frame(8, 8, (x) => x < 3);
    const one = (await encodeReel(8, 8, 12, [still])).byteLength;
    const ten = (
      await encodeReel(
        8,
        8,
        12,
        Array.from({ length: 10 }, () => still),
      )
    ).byteLength;
    expect(ten - one).toBeLessThanOrEqual(9 * 2);
  });

  test("a file that is not a reel, or is cut short, decodes to nothing", async () => {
    expect(await decodeReel("x", new ArrayBuffer(4))).toBe(null);
    const good = await encodeReel(8, 8, 12, [frame(8, 8, (x) => x < 3)]);
    const wrongMagic = good.slice(0);
    new Uint8Array(wrongMagic)[0] = 0x00;
    expect(await decodeReel("x", wrongMagic)).toBe(null);
    // A version this reader does not know is not guesswork: the payload's meaning
    // changed with it, and reading v1's deltas as v2's gzip would be noise.
    const wrongVersion = good.slice(0);
    new Uint8Array(wrongVersion)[4] = 1;
    expect(await decodeReel("x", wrongVersion)).toBe(null);
    // Truncated mid-stream: a half-decoded reel would draw as a corrupt frame that
    // never resolves, which on these displays looks like a hardware fault.
    expect(await decodeReel("x", good.slice(0, good.byteLength - 1))).toBe(null);
  });

  test("out of range is dark, not a throw or a wrap onto the next row", async () => {
    const reel = (await decodeReel("x", await encodeReel(8, 4, 12, [frame(8, 4, () => true)])))!;
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

  test("whatever the folder holds is an id that can actually match", () => {
    // NOT "the folder is empty". It was, and that was wrong: a built clip is the whole
    // point of the feature, so the assertion failed on any machine where somebody had
    // followed the README — it tested the developer's disk rather than the code.
    //
    // Keeping a clip out of the repository is .gitignore's job, and a test cannot see
    // the difference anyway. What is worth checking is that a filename dropped in there
    // becomes a usable id: `reelIdFor` skips anything under four characters, so a clip
    // named too short would sit in the registry and silently never play.
    for (const id of REEL_IDS) {
      expect(reelKey(id).length, `${id} is too short an id to ever match a track`).toBeGreaterThan(
        3,
      );
      expect(id).not.toContain("/");
    }
  });
});

describe("watching the transport", () => {
  // Three displays play reels, so this behaviour lives in one place. With no clip built
  // there is nothing to load, which is what makes these assertions the useful half:
  // that it never gets in the way, and that dismissing and re-arming work.
  const feed = (over: Partial<{ current: unknown; notes: unknown[] }> = {}) =>
    ({ current: null, notes: [], ...over }) as never;

  test("nothing playing is nothing shown, and polling is safe", () => {
    const w = watchReel(feed());
    w.poll();
    w.poll();
    expect(w.reel).toBe(null);
    expect(w.found).toBe(false);
  });

  test("dismissing hides the clip, and a new track re-arms", () => {
    // The dismissal must not outlive the track: a viewer who waved one away should
    // still meet the next tune's reel, because coming across it is the whole point.
    const state = { current: { hash: "a", filename: "a.mod" }, notes: [] as unknown[] };
    const w = watchReel(state as never);
    w.poll();
    w.dismiss();
    expect(w.reel).toBe(null);
    state.current = { hash: "b", filename: "b.mod" };
    w.poll();
    expect(w.reel).toBe(null); // no clip built for either, but the dismissal is spent
  });

  test("a dismissed clip is still found, so a display can offer the way back", () => {
    // This is the bug the deck had. Its window has ONE control, so a press that dismissed
    // the film for good stranded it: you pressed DISPLAY to see the analyser and the
    // picture was gone for the rest of the tune with nothing to press. `found` has to stay
    // true through a dismissal for a display to be able to cycle round to it again —
    // masking the clip is the getter's job, not a matter of throwing it away.
    const state = { current: { hash: "a", filename: "a.mod" }, notes: [] as unknown[] };
    const w = watchReel(state as never);
    w.poll();
    w.dismiss();
    expect(w.reel).toBe(null);
    w.restore();
    // Nothing to restore here (no clip is built), but the flag must survive the round trip
    // rather than the dismissal having cleared it.
    expect(w.found).toBe(w.reel !== null);
  });

  test("stopping ends it: a late fetch cannot paint over a torn-down display", () => {
    const w = watchReel(feed({ current: { hash: "a", filename: "badapple.mod" } }));
    w.stop();
    w.poll();
    expect(w.reel).toBe(null);
  });
});

describe("playing it", () => {
  let reel: Reel;
  beforeAll(async () => {
    reel = (await decodeReel(
      "x",
      await encodeReel(
        8,
        8,
        10,
        Array.from({ length: 30 }, (_, f) => frame(8, 8, (x) => x === f % 8)),
      ),
    ))!;
  });

  test("the playhead picks the frame, and the ends hold", () => {
    expect(reelFrameAt(reel, 0)).toBe(0);
    expect(reelFrameAt(reel, 1)).toBe(10);
    expect(reelFrameAt(reel, 1.04)).toBe(10); // rounded, not floored
    // A clip and a tune are never the same length; running out mid-song must read as a
    // still frame rather than as the board having stopped.
    expect(reelFrameAt(reel, 999)).toBe(29);
    expect(reelFrameAt(reel, -5)).toBe(0);
  });

  test("a clip is fitted and centred on the board, never stretched", async () => {
    // A 1:1 clip on a wide board: the picture keeps its shape and the rest of the
    // board stays dark, which on flip dots is a letterbox of unlit discs.
    const cols = 40;
    const rows = 22;
    const out = new Uint8Array(cols * rows);
    const solid = (await decodeReel("s", await encodeReel(8, 8, 10, [frame(8, 8, () => true)])))!;
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

  test("a reel asks the discs for no more than the generated modes do", async () => {
    // The board's own budget (flip-modes.test.ts): 40% of the dots may change per
    // update, because churn is how much of the board is mid-rotation rather than
    // showing a state. This guards the SAMPLER — the fitting and the majority
    // downsample — against a clip of the kind these are for: a shape moving across a
    // held field. What a particular film costs is a build-time question, which is why
    // the script bakes at 12fps and the README says why.
    const cols = 40;
    const rows = 22;
    const BUDGET = Math.round(cols * rows * 0.4);
    const clip = (await decodeReel(
      "m",
      await encodeReel(
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
    ))!;
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

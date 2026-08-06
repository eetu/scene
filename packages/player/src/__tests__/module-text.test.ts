// What the text visualisers (split-flap board, hi-fi text face) put on screen.
//
// Two sources feed one display: the prose tracker composers hid in sample slots,
// and — for C64 tunes, which have no such slots — HVSC's STIL commentary. The
// interesting cases are the seam between them and the fallbacks, since an empty
// display reads as a broken one.
import { describe, expect, test } from "vitest";

import type { Track, TrackNote } from "../host";
import { isProse, moduleLines } from "../module-text";

const track = (over: Partial<Track> = {}) =>
  ({ title: "Commando", filename: "Commando.sid", artist: "Rob Hubbard", ...over }) as Track;

const note = (over: Partial<TrackNote> = {}): TrackNote => ({
  subsong: -1,
  comment: null,
  title: null,
  artist: null,
  name: null,
  author: null,
  ...over,
});

describe("moduleLines", () => {
  test("a module's sample prose is unaffected by the notes parameter", () => {
    // Regression guard for the STIL addition: modules must render exactly as
    // before when no notes exist, which is every module.
    const lines = moduleLines(
      track({ title: "Elysium" }),
      ["hello there friends"],
      ["greets to everyone"],
    );
    expect(lines).toEqual([
      "Elysium",
      "BY Rob Hubbard",
      "",
      "hello there friends",
      "greets to everyone",
    ]);
  });

  test("a SID with no slots shows its STIL comment instead of nothing", () => {
    // The whole point: without this a C64 tune is a bare title card, because a
    // SID has no sample or instrument names to read.
    const lines = moduleLines(track(), [], [], [note({ comment: "One of the best known." })]);
    expect(lines).toEqual(["Commando", "BY Rob Hubbard", "", "One of the best known."]);
  });

  test("a cover credit reads as a sentence, not a contradicting second title", () => {
    // STIL's TITLE/ARTIST name the original being covered. Shown bare they'd sit
    // under the tune's own title looking like a disagreement about its name.
    // Asserted on the joined body because a long credit wraps like any prose,
    // and the visualisers scroll it as one run either way.
    const lines = moduleLines(
      track(),
      [],
      [],
      [note({ title: "Rock Me Amadeus", artist: "Falco" })],
    );
    expect(lines.slice(3).join(" ")).toBe("COVER OF Rock Me Amadeus BY Falco");
  });

  test("an unattributed cover still names what it covers", () => {
    const lines = moduleLines(track(), [], [], [note({ title: "Axel F" })]);
    expect(lines).toContain("COVER OF Axel F");
  });

  test("a long comment is wrapped, not left as one unreadable line", () => {
    // Sample slots arrive pre-chunked at ~22 characters; a STIL comment is a
    // paragraph, and both visualisers scroll a line at a time.
    const long = "word ".repeat(40).trim();
    const lines = moduleLines(track(), [], [], [note({ comment: long })]);
    const body = lines.slice(3);
    expect(body.length).toBeGreaterThan(4);
    for (const l of body) expect(l.length).toBeLessThanOrEqual(28);
    // Nothing is dropped in the wrapping.
    expect(body.join(" ")).toBe(long);
  });

  test("file-scope and subtune notes both show, in that order", () => {
    const lines = moduleLines(
      track(),
      [],
      [],
      [note({ comment: "About the file." }), note({ subsong: 1, comment: "About tune two." })],
    );
    expect(lines.slice(3)).toEqual(["About the file.", "About tune two."]);
  });

  test("notes precede sample prose, separated by a blank", () => {
    // Both can exist (a curated .sid alongside a module in one library). The
    // notes are written about this tune; a sample name is at best incidental.
    const lines = moduleLines(track(), [], ["greets to everyone"], [note({ comment: "A note." })]);
    expect(lines).toEqual(["Commando", "BY Rob Hubbard", "", "A note.", "", "greets to everyone"]);
  });

  test("an empty note list adds no stray blank line", () => {
    const lines = moduleLines(track(), [], ["greets to everyone"], []);
    expect(lines).toEqual(["Commando", "BY Rob Hubbard", "", "greets to everyone"]);
  });
});

describe("isProse", () => {
  test("separates a message from an inventory label", () => {
    expect(isProse("written in 3 hours at 4am")).toBe(true);
    expect(isProse("bd1.wav")).toBe(false);
    expect(isProse("STRG-D1.WAV")).toBe(false);
    // Long enough that it can't be an instrument name.
    expect(isProse("greetingstoall")).toBe(true);
  });
});

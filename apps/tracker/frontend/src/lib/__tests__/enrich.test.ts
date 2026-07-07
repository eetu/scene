import type { ParsedMeta } from "@scene/player";
import { describe, expect, test, vi } from "vitest";

import type { MetaIn, Track } from "$lib/api";
import { enrichTracks, toMeta } from "$lib/enrich";

function track(hash: string): Track {
  return {
    hash,
    md5: null,
    path: hash,
    group: "G",
    artist: null,
    filename: "s.mod",
    ext: "mod",
    size: 0,
    title: null,
    type_long: null,
    tracker: null,
    duration: null,
    channels: null,
    instruments: null,
    samples: null,
    favorite: false,
    play_count: 0,
  };
}

describe("toMeta", () => {
  test("maps parsed fields (dur→duration, orders→n_orders, empty→null)", () => {
    const m: ParsedMeta = {
      title: "Intro",
      type_long: "FastTracker II",
      tracker: "",
      dur: 42,
      channels: 8,
      instruments: 3,
      samples: 5,
      orders: 12,
      patterns: 9,
    };
    expect(toMeta(m)).toEqual({
      title: "Intro",
      type_long: "FastTracker II",
      tracker: null, // "" → null
      duration: 42,
      channels: 8,
      instruments: 3,
      samples: 5,
      n_orders: 12,
      n_patterns: 9,
    });
  });
});

describe("enrichTracks", () => {
  const okMeta: ParsedMeta = { title: "T", type_long: "XM", dur: 10 };

  test("parses, saves, applies onto the track, and reports progress", async () => {
    const tracks = [track("a"), track("b")];
    const save = vi.fn(async (_h: string, _m: MetaIn) => {});
    const onProgress = vi.fn();
    await enrichTracks(
      tracks,
      { fetchBytes: async () => new ArrayBuffer(0), parse: async () => okMeta, save },
      { shouldContinue: () => true, onProgress },
    );
    expect(save).toHaveBeenCalledTimes(2);
    expect(tracks[0].title).toBe("T");
    expect(tracks[0].type_long).toBe("XM");
    expect(onProgress).toHaveBeenLastCalledWith(2);
  });

  test("skips a module whose parse throws, but keeps going", async () => {
    const tracks = [track("bad"), track("good")];
    const save = vi.fn(async () => {});
    let call = 0;
    await enrichTracks(
      tracks,
      {
        fetchBytes: async () => new ArrayBuffer(0),
        parse: async (): Promise<ParsedMeta> => {
          if (++call === 1) throw new Error("bad module"); // first module fails
          return okMeta;
        },
        save,
      },
      { shouldContinue: () => true, onProgress: () => {} },
    );
    // First threw (nothing saved for it), second saved.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("good", expect.anything());
  });

  test("stops early when shouldContinue() turns false (cancel)", async () => {
    const tracks = [track("a"), track("b"), track("c")];
    const save = vi.fn(async () => {});
    let processed = 0;
    await enrichTracks(
      tracks,
      { fetchBytes: async () => new ArrayBuffer(0), parse: async () => okMeta, save },
      { shouldContinue: () => processed < 1, onProgress: () => (processed += 1) },
    );
    expect(save).toHaveBeenCalledTimes(1); // only the first got through before cancel
  });
});

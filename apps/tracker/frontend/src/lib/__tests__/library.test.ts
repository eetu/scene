import { describe, expect, test } from "vitest";

import type { Manifest, Track } from "$lib/api";
import {
  buildRows,
  facetFormats,
  facetTrackers,
  filterTracks,
  GROUPLESS,
  groupTracks,
  keyOf,
  keysOf,
  letterRowMap,
  NO_ALBUM,
  railLetter,
  rowKey,
  subLabel,
} from "$lib/library";
import { buildIndex } from "$lib/manifest";

/** A Track with sensible defaults; override the fields a test cares about. */
function track(p: Partial<Track>): Track {
  return {
    hash: p.path ?? p.hash ?? "h",
    md5: null,
    path: p.path ?? "p",
    group: p.group ?? "G",
    artist: p.artist ?? null,
    filename: p.filename ?? "song.mod",
    ext: p.ext ?? "mod",
    size: 0,
    title: p.title ?? null,
    type_long: p.type_long ?? null,
    tracker: p.tracker ?? null,
    duration: p.duration ?? null,
    channels: p.channels ?? null,
    instruments: null,
    samples: null,
    favorite: p.favorite ?? false,
    play_count: p.play_count ?? 0,
    ...p,
  };
}

describe("keyOf / subLabel", () => {
  test("keyOf buckets by the active dimension; empty group → groupless", () => {
    expect(keyOf(track({ group: "Acme" }), "group")).toBe("Acme");
    expect(keyOf(track({ group: "" }), "group")).toBe(GROUPLESS);
    expect(keyOf(track({ artist: null }), "artist")).toBe("(unknown artist)");
    expect(keyOf(track({ ext: "xm" }), "ext")).toBe("XM");
  });

  test("subLabel shows the other dimension, hiding the groupless sentinel", () => {
    expect(subLabel(track({ artist: "Coder" }), "group")).toBe("Coder");
    expect(subLabel(track({ group: GROUPLESS }), "artist")).toBe("—");
    expect(subLabel(track({ group: "Acme", artist: "Coder" }), "ext")).toBe("Acme · Coder");
  });
});

describe("filterTracks", () => {
  const tracks = [
    track({ path: "a", ext: "mod", tracker: "PT", title: "Intro", favorite: true }),
    track({ path: "b", ext: "xm", tracker: "FT2", title: "Outro" }),
    track({ path: "c", ext: "mod", tracker: null, title: "Loop", favorite: true }),
  ];
  const base = { favView: false, fmtFilter: "", trackerFilter: "", query: "" };

  test("favourites view keeps only favorites", () => {
    expect(filterTracks(tracks, { ...base, favView: true }).map((t) => t.path)).toEqual(["a", "c"]);
  });
  test("format + tracker facets match exactly", () => {
    expect(filterTracks(tracks, { ...base, fmtFilter: "MOD" }).map((t) => t.path)).toEqual([
      "a",
      "c",
    ]);
    expect(filterTracks(tracks, { ...base, trackerFilter: "FT2" }).map((t) => t.path)).toEqual([
      "b",
    ]);
  });
  test("free-text query is case-insensitive across fields", () => {
    expect(filterTracks(tracks, { ...base, query: "loop" }).map((t) => t.path)).toEqual(["c"]);
  });
});

describe("groupTracks", () => {
  const opts = {
    groupBy: "group" as const,
    trackSort: "name" as const,
    groupSort: "name" as const,
  };

  test("groups by key, A-Z, with groupless pinned last", () => {
    const g = groupTracks(
      [
        track({ path: "1", group: "Beta" }),
        track({ path: "2", group: "" }),
        track({ path: "3", group: "Alpha" }),
      ],
      opts,
    );
    expect(g.map(([name]) => name)).toEqual(["Alpha", "Beta", GROUPLESS]);
  });

  test("groupSort=size orders buckets by module count (ties A-Z)", () => {
    const g = groupTracks(
      [
        track({ path: "1", group: "A" }),
        track({ path: "2", group: "B" }),
        track({ path: "3", group: "B" }),
      ],
      { ...opts, groupSort: "size" },
    );
    expect(g.map(([name]) => name)).toEqual(["B", "A"]);
  });

  test("trackSort=plays orders within a bucket, most-played first (stable)", () => {
    const g = groupTracks(
      [
        track({ path: "x", group: "A", play_count: 1 }),
        track({ path: "y", group: "A", play_count: 9 }),
        track({ path: "z", group: "A", play_count: 1 }),
      ],
      { ...opts, trackSort: "plays" },
    );
    expect(g[0][1].map((t) => t.path)).toEqual(["y", "x", "z"]); // 9, then the two 1s in server order
  });
});

describe("buildRows", () => {
  test("emits a header per group + track rows only for open groups", () => {
    const groups = groupTracks(
      [track({ path: "1", group: "A" }), track({ path: "2", group: "B" })],
      { groupBy: "group", trackSort: "name", groupSort: "name" },
    );
    const rows = buildRows(groups, (name) => name === "A"); // only A open
    expect(rows.map((r) => (r.kind === "header" ? `H:${r.name}` : `T:${r.track.path}`))).toEqual([
      "H:A",
      "T:1",
      "H:B",
    ]);
    expect(rows[0]).toMatchObject({ kind: "header", first: true });
  });
});

describe("rail math", () => {
  test("railLetter maps to A-Z or # for non-alpha", () => {
    expect(railLetter("Alpha")).toBe("A");
    expect(railLetter("3xz")).toBe("#");
    expect(railLetter(GROUPLESS)).toBe("#");
  });

  test("letterRowMap points each letter at its first header row", () => {
    const groups = groupTracks(
      [
        track({ path: "1", group: "Abba" }),
        track({ path: "2", group: "Ace" }),
        track({ path: "3", group: "Bee" }),
      ],
      { groupBy: "group", trackSort: "name", groupSort: "name" },
    );
    const rows = buildRows(groups, () => true);
    const map = letterRowMap(rows);
    expect(map.get("A")).toBe(0); // first "A…" header
    expect(map.get("B")).toBeGreaterThan(map.get("A")!);
  });
});

describe("facets", () => {
  const base = [
    track({ ext: "mod", tracker: "PT" }),
    track({ ext: "xm", tracker: "FT2" }),
    track({ ext: "mod", tracker: null }),
  ];
  test("formats are unique, upper-cased, sorted", () => {
    expect(facetFormats(base)).toEqual(["MOD", "XM"]);
  });
  test("trackers are unique, non-null, sorted", () => {
    expect(facetTrackers(base)).toEqual(["FT2", "PT"]);
  });
});

describe("manifest-driven facets", () => {
  const manifest: Manifest = {
    artists: {
      "Purple Motion": { aka: ["PM"], groups: ["Future Crew"] },
      Skaven: { aka: ["Peter Hajba"], groups: ["Future Crew", "Epileptic Gängbang"] },
    },
    albums: {
      "sr-ost": { title: "Second Reality — OST", songs: ["aaaa", "BBBB"] },
      sfx: { title: "SFX", songs: ["aaaa"] },
    },
    songs: { aaaa: { forGroup: "Future Crew", year: 1993 } },
  };
  const idx = buildIndex(manifest);

  test("alias resolves to canonical for group-by artist", () => {
    // A track whose folder is the alias "PM" buckets under "Purple Motion".
    expect(keysOf(track({ artist: "PM" }), "artist", idx)).toEqual(["Purple Motion"]);
    // Case-insensitive.
    expect(keyOf(track({ artist: "peter hajba" }), "artist", idx)).toBe("Skaven");
  });

  test("group-by group uses manifest membership (many-to-many)", () => {
    // Skaven is in two groups → the track appears under both.
    expect(keysOf(track({ artist: "Skaven" }), "group", idx)).toEqual([
      "Future Crew",
      "Epileptic Gängbang",
    ]);
    // No manifest artist → falls back to the path group.
    expect(keysOf(track({ artist: null, group: "Legacy" }), "group", idx)).toEqual(["Legacy"]);
  });

  test("group-by album spreads a track across its albums; unfiled → sentinel", () => {
    // md5 aaaa is in two albums (case-insensitive match).
    expect(keysOf(track({ md5: "AAAA" }), "album", idx).sort()).toEqual([
      "SFX",
      "Second Reality — OST",
    ]);
    expect(keysOf(track({ md5: "zzzz" }), "album", idx)).toEqual([NO_ALBUM]);
  });

  test("a multi-bucket track gets a unique row key per bucket", () => {
    const groups = groupTracks(
      [track({ path: "p1", artist: "Skaven" })],
      {
        groupBy: "group",
        trackSort: "name",
        groupSort: "name",
      },
      idx,
    );
    const rows = buildRows(groups, () => true);
    const keys = rows.filter((r) => r.kind === "track").map(rowKey);
    expect(new Set(keys).size).toBe(keys.length); // all unique
    expect(keys).toEqual(["t:Epileptic Gängbang:p1", "t:Future Crew:p1"]);
  });

  test("credit lookup is md5 case-insensitive", () => {
    expect(idx.credit("AAAA")?.forGroup).toBe("Future Crew");
    expect(idx.credit("nope")).toBeNull();
  });

  test("no index → path-derived grouping unchanged", () => {
    expect(keysOf(track({ artist: "PM" }), "artist")).toEqual(["PM"]);
    expect(keysOf(track({ group: "Acme" }), "group")).toEqual(["Acme"]);
  });
});

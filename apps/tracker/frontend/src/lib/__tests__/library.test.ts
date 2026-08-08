import { describe, expect, test } from "vitest";

import type { Manifest, Track } from "$lib/api";
import {
  buildRows,
  favSubLabel,
  filterTracks,
  flatRows,
  GROUPLESS,
  groupTracks,
  keysOf,
  letterRowMap,
  NO_ALBUM,
  playLength,
  railLetter,
  rowKey,
  sortFlatTracks,
  subLabel,
  tuneLabel,
} from "$lib/library";
import { buildIndex } from "$lib/manifest";

/** A Track with sensible defaults; override the fields a test cares about. */
function track(p: Partial<Track>): Track {
  return {
    id: p.id ?? 0,
    subsong: p.subsong ?? 0,
    subsongs: p.subsongs ?? 0,
    hash: p.path ?? p.hash ?? "h",
    md5: null,
    path: p.path ?? "p",
    collection: p.collection ?? "mods",
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

describe("keysOf / subLabel", () => {
  test("keysOf buckets by the active dimension; empty group → groupless", () => {
    expect(keysOf(track({ group: "Acme" }), "group")).toEqual(["Acme"]);
    expect(keysOf(track({ group: "" }), "group")).toEqual([GROUPLESS]);
    expect(keysOf(track({ artist: null }), "artist")).toEqual(["(unknown artist)"]);
    expect(keysOf(track({ ext: "xm" }), "ext")).toEqual(["XM"]);
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

/** Grouped tracks reduced to the id buckets the row stream is built from —
 *  the shape `/api/library/ids` returns, so the same rows are produced whether
 *  the shaping ran here or on the server. */
const idBuckets = (groups: [string, Track[]][]): [string, number[]][] =>
  groups.map(([name, items]) => [name, items.map((t) => t.id)]);

describe("buildRows", () => {
  test("emits a header per group + track rows only for open groups", () => {
    const groups = groupTracks(
      [track({ id: 1, path: "1", group: "A" }), track({ id: 2, path: "2", group: "B" })],
      { groupBy: "group", trackSort: "name", groupSort: "name" },
    );
    const rows = buildRows(idBuckets(groups), (name) => name === "A"); // only A open
    expect(rows.map((r) => (r.kind === "header" ? `H:${r.name}` : `T:${r.id}`))).toEqual([
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
    const rows = buildRows(idBuckets(groups), () => true);
    const map = letterRowMap(rows);
    expect(map.get("A")).toBe(0); // first "A…" header
    expect(map.get("B")).toBeGreaterThan(map.get("A")!);
  });
});

describe("song length", () => {
  test("a known duration is used as-is, whatever the format", () => {
    expect(playLength(track({ ext: "mod", duration: 210 }), 180)).toBe(210);
    expect(playLength(track({ ext: "sid", duration: 97 }), 180)).toBe(97);
  });

  test("an unknown-length SID falls back so it can be played at all", () => {
    // The format carries no duration; without a window there'd be nothing for
    // the transport or auto-advance to work against.
    expect(playLength(track({ ext: "sid", duration: null }), 180)).toBe(180);
    expect(playLength(track({ ext: "psid", duration: null }), 240)).toBe(240);
  });

  test("a module with no duration yet does NOT get the SID fallback", () => {
    // The engine reports a module's real length once it decodes, so inventing
    // one here would only fight it.
    expect(playLength(track({ ext: "mod", duration: null }), 180)).toBe(0);
  });

  test("tuneLabel only appears for genuinely multi-tune files", () => {
    expect(tuneLabel(track({ subsong: 0, subsongs: 0 }))).toBe("");
    expect(tuneLabel(track({ subsong: 0, subsongs: 1 }))).toBe("");
    // 1-based for display; the stored index is 0-based.
    expect(tuneLabel(track({ subsong: 2, subsongs: 12 }))).toBe("Tune 3/12");
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
    expect(keysOf(track({ artist: "peter hajba" }), "artist", idx)).toEqual(["Skaven"]);
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
      [track({ id: 7, path: "p1", artist: "Skaven" })],
      {
        groupBy: "group",
        trackSort: "name",
        groupSort: "name",
      },
      idx,
    );
    const rows = buildRows(idBuckets(groups), () => true);
    const keys = rows.filter((r) => r.kind === "track").map(rowKey);
    // One track, two buckets: the bucket name is what keeps the keys distinct.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["t:Epileptic Gängbang:7", "t:Future Crew:7"]);
  });

  test("credit lookup is md5 case-insensitive", () => {
    expect(idx.credit("AAAA")?.forGroup).toBe("Future Crew");
    expect(idx.credit("nope")).toBeNull();
  });

  test("no index → path-derived grouping unchanged", () => {
    expect(keysOf(track({ artist: "PM" }), "artist")).toEqual(["PM"]);
    expect(keysOf(track({ group: "Acme" }), "group")).toEqual(["Acme"]);
  });

  test("favSubLabel uses manifest membership for the group (first bucket)", () => {
    // Skaven is in two groups → the flat favourites row shows the first.
    expect(favSubLabel(track({ artist: "Skaven" }), idx)).toBe("Skaven · Future Crew");
    // Alias resolves to the canonical artist.
    expect(favSubLabel(track({ artist: "PM" }), idx)).toBe("Purple Motion · Future Crew");
  });
});

describe("flat favourites view", () => {
  test("sortFlatTracks name orders by song title A-Z (case-insensitive)", () => {
    const s = sortFlatTracks(
      [
        track({ path: "1", title: "Zap" }),
        track({ path: "2", title: "amber" }),
        track({ path: "3", title: "Mono" }),
      ],
      "name",
    );
    expect(s.map((t) => t.title)).toEqual(["amber", "Mono", "Zap"]);
  });

  test("sortFlatTracks name falls back to filename when title is null", () => {
    const s = sortFlatTracks(
      [track({ path: "1", title: null, filename: "b.mod" }), track({ path: "2", title: "a" })],
      "name",
    );
    expect(s.map((t) => t.title ?? t.filename)).toEqual(["a", "b.mod"]);
  });

  test("sortFlatTracks plays/duration order high-to-low", () => {
    const plays = sortFlatTracks(
      [
        track({ path: "1", play_count: 2 }),
        track({ path: "2", play_count: 9 }),
        track({ path: "3", play_count: 5 }),
      ],
      "plays",
    );
    expect(plays.map((t) => t.play_count)).toEqual([9, 5, 2]);
    const dur = sortFlatTracks(
      [track({ path: "1", duration: 60 }), track({ path: "2", duration: 200 })],
      "duration",
    );
    expect(dur.map((t) => t.duration)).toEqual([200, 60]);
  });

  test("sortFlatTracks does not mutate the input array", () => {
    const input = [track({ path: "1", title: "b" }), track({ path: "2", title: "a" })];
    sortFlatTracks(input, "name");
    expect(input.map((t) => t.title)).toEqual(["b", "a"]);
  });

  test("flatRows emits track rows only (no headers), last flag on the final row", () => {
    const rows = flatRows([1, 2, 3]);
    expect(rows.every((r) => r.kind === "track")).toBe(true);
    expect(rows.map((r) => (r.kind === "track" ? r.last : null))).toEqual([false, false, true]);
    const keys = rows.map(rowKey);
    expect(new Set(keys).size).toBe(keys.length); // stable, unique keys
  });

  test("flatRows drops a repeated id, which would key two rows the same", () => {
    // A track in two buckets (multi-group / multi-album) arrives twice in the
    // flattened id stream; flattening keys by bucket + id, so rendering both
    // crashed the list with each_key_duplicate.
    const rows = flatRows([7, 9, 7]);
    expect(rows.map((r) => (r.kind === "track" ? r.id : null))).toEqual([7, 9]);
    expect(rows.map((r) => (r.kind === "track" ? r.last : null))).toEqual([false, true]);
    const keys = rows.map(rowKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("favSubLabel shows artist · group, hiding the groupless sentinel", () => {
    expect(favSubLabel(track({ artist: "Coder", group: "Acme" }))).toBe("Coder · Acme");
    expect(favSubLabel(track({ artist: "Coder", group: GROUPLESS }))).toBe("Coder");
    expect(favSubLabel(track({ artist: null, group: "Acme" }))).toBe("Acme");
    expect(favSubLabel(track({ artist: null, group: GROUPLESS }))).toBe("—");
  });
});

// Shared backend mock for the e2e specs.
//
// The library index lives server-side now: the SPA asks for a *shaped* ordered
// id stream (`/api/library/ids`) and hydrates windows of it
// (`/api/tracks/batch`), rather than pulling the whole `/api/tracks` payload.
// So a spec can't just hand over an array of tracks any more — the mock has to
// do the shaping the backend would.
//
// It does that with the app's own pure helpers (`filterTracks` / `groupTracks`),
// which are the same transforms `library.rs` mirrors. That keeps the fixture
// honest — a spec asserting "the format facet filters the list" is exercising
// real filtering, not a hand-rolled stub that happens to agree.
import type { BrowserContext } from "@playwright/test";

import type { Track } from "../src/lib/api";
import { FAV_BUCKET, filterTracks, groupTracks, sortFlatTracks } from "../src/lib/library";

type GroupKey = "group" | "artist" | "ext" | "album";
type TrackSort = "name" | "duration" | "channels" | "plays";
type GroupSort = "name" | "plays" | "size";

/** Fill in what a real index row always carries but fixtures rarely spell out:
 *  a surrogate id and a collection. Done here so specs can keep declaring only
 *  the fields they actually assert on. */
function normalise(tracks: Track[]): Track[] {
  return tracks.map((t, i) => ({ ...t, id: t.id || i + 1, collection: t.collection || "mods" }));
}

function shape(tracks: Track[], url: URL) {
  const p = url.searchParams;
  const fav = p.get("fav") === "true";
  const filtered = filterTracks(tracks, {
    favView: fav,
    fmtFilter: p.get("fmt") ?? "",
    trackerFilter: p.get("tracker") ?? "",
    query: p.get("q") ?? "",
  }).filter((t) => {
    const c = p.get("collection");
    return !c || t.collection === c;
  });

  const trackSort = (p.get("track_sort") ?? "name") as TrackSort;
  const groups = fav
    ? filtered.length
      ? [[FAV_BUCKET, sortFlatTracks(filtered, trackSort)] as [string, Track[]]]
      : []
    : groupTracks(filtered, {
        groupBy: (p.get("group_by") ?? "group") as GroupKey,
        trackSort,
        groupSort: (p.get("group_sort") ?? "name") as GroupSort,
      });

  return {
    groups: groups.map(([name, items]) => ({ name, ids: items.map((t) => t.id) })),
    total: groups.reduce((n, [, items]) => n + items.length, 0),
    formats: [...new Set(tracks.map((t) => t.ext.toUpperCase()))].sort(),
    trackers: [...new Set(tracks.map((t) => t.tracker).filter((t): t is string => !!t))].sort(),
  };
}

export type StatusOverrides = Partial<{
  scanning: boolean;
  scan_total: number;
  scan_processed: number;
  scan_hashed: number;
  track_count: number;
  /** Configured collection roots. More than one reveals the source selector. */
  roots: { id: string; label: string; kind: string; path: string; count: number | null }[];
  /** Per-root HVSC facts. Empty (the default) means no HVSC root is configured,
   *  which is what keeps the version chip and reindex control out of the DOM. */
  hvsc: Record<
    string,
    { version: number | null; tunes: number; subtunes: number; indexed_at: string } | null
  >;
}>;

/** Route the library endpoints against an in-memory fixture. Call before
 *  `page.goto`. Specs may still add their own routes for `/api/file/*` etc. */
export async function mockLibrary(
  context: BrowserContext,
  fixture: Track[],
  status: StatusOverrides = {},
) {
  const tracks = normalise(fixture);
  await context.route("**/api/library/ids*", (r) =>
    r.fulfill({ json: shape(tracks, new URL(r.request().url())) }),
  );
  await context.route("**/api/tracks/batch*", (r) => {
    const ids = (new URL(r.request().url()).searchParams.get("ids") ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    // Echoed in the order asked for, like the real endpoint.
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return r.fulfill({ json: { tracks: ids.map((id) => byId.get(id)).filter(Boolean) } });
  });
  await context.route("**/api/track/*", (r) => {
    const hash = new URL(r.request().url()).pathname.split("/").pop();
    const t = tracks.find((x) => x.hash === hash);
    return t ? r.fulfill({ json: { track: t } }) : r.fulfill({ status: 404, body: "" });
  });
  await context.route("**/api/library/unenriched", (r) =>
    r.fulfill({ json: { count: 0, tracks: [] } }),
  );
  // Curator notes. Specs that care about STIL re-route this with their own.
  await context.route("**/api/stil/*", (r) => r.fulfill({ json: { notes: [] } }));
  // Still routed: a few specs assert against it, and nothing should 404.
  await context.route("**/api/tracks", (r) => r.fulfill({ json: { tracks } }));
  await context.route("**/status", (r) =>
    r.fulfill({
      json: {
        service: "t",
        version: "x",
        db_healthy: true,
        track_count: tracks.length,
        root: "/x",
        roots: [{ id: "mods", label: "Mods", kind: "scan", path: "/x", count: tracks.length }],
        hvsc: {},
        scanning: false,
        scan_total: 0,
        scan_processed: 0,
        scan_hashed: 0,
        ...status,
      },
    }),
  );
}

// Shared *derived* library view: the ordered bucket list the UI renders and the
// play queue follows. Svelte won't let a module `export` a `$derived`, so the
// derivations live as fields on a singleton class instance — the idiomatic
// shared-derived-state pattern (like a memoised selector). Read `lib.groups`
// anywhere; no prop-drilling, and the work runs once per change, not per
// consumer.
//
// Two shapes, one interface. With a backend the filter → group → sort runs
// *server-side* (`/api/library/ids`) and what arrives is buckets of `files.id`;
// the whole index no longer fits in the browser once HVSC is in the collection.
// The backend-less GitHub Pages build has its whole (small) library in memory,
// so it shapes locally with the same pure helpers as before. Both end up as
// `[name, ids][]`, and rows are read through the hydration cache either way.
import type { LibraryQuery } from "$lib/api";
import { FAV_BUCKET, filterTracks, groupTracks, sortFlatTracks } from "$lib/library";
import { library } from "$lib/library.svelte";
import { manifestIndex } from "$lib/manifest.svelte";
import { STANDALONE } from "$lib/standalone";
import { put } from "$lib/tracks.svelte";
import { queryFromView, view } from "$lib/view.svelte";

/** Bucket name → the ordered ids it renders. */
export type Bucket = [string, number[]];

class LibraryView {
  /** Favourites tab: same list, favourites-only predicate. */
  favView = $derived(view.tab === "favourites");
  /** Library or Favourites (both render the list + facet toolbar). */
  listView = $derived(view.tab === "library" || view.tab === "favourites");

  /** The view store mirrored onto the API's query shape. This is what drives the
   *  server fetch; the page effect re-runs `reshapeIfChanged` when it changes. */
  query = $derived<LibraryQuery>(queryFromView());

  groups = $derived<Bucket[]>(STANDALONE ? shapeLocally(this.favView) : shapeFromServer());

  /** The visible order flattened — this is the play queue, as ids (next/prev and
   *  auto-advance follow what you see). */
  flatIds = $derived(this.groups.flatMap(([, ids]) => ids));

  /** Rows the list will render, counting a track once per bucket it appears in. */
  total = $derived(this.flatIds.length);

  /** Facet dropdown options. Server-supplied when there is a backend — it sees
   *  the whole index, which the browser no longer does. */
  formats = $derived(
    STANDALONE
      ? [...new Set(library.tracks.map((t) => t.ext.toUpperCase()))].sort()
      : (library.shaped?.formats ?? []),
  );
  trackers = $derived(
    STANDALONE
      ? [...new Set(library.tracks.map((t) => t.tracker).filter((t): t is string => !!t))].sort()
      : (library.shaped?.trackers ?? []),
  );
}

function shapeFromServer(): Bucket[] {
  return (library.shaped?.groups ?? []).map((g) => [g.name, g.ids] as Bucket);
}

/** The backend-less build: shape in the browser with the pure helpers, then seed
 *  the hydration cache so every consumer reads rows the same way. */
function shapeLocally(favView: boolean): Bucket[] {
  const filtered = filterTracks(library.tracks, {
    favView,
    fmtFilter: view.fmtFilter,
    trackerFilter: view.trackerFilter,
    query: view.query,
  });
  for (const t of filtered) put(t);

  // Favourites render as ONE flat, deduped song list (no group cards) — so the
  // manifest's many-to-many spread can't show the same tune twice.
  if (favView) {
    if (!filtered.length) return [];
    return [[FAV_BUCKET, sortFlatTracks(filtered, view.trackSort).map((t) => t.id)]];
  }
  return groupTracks(
    filtered,
    { groupBy: view.groupBy, trackSort: view.trackSort, groupSort: view.groupSort },
    manifestIndex(),
  ).map(([name, items]) => [name, items.map((t) => t.id)] as Bucket);
}

export const lib = new LibraryView();

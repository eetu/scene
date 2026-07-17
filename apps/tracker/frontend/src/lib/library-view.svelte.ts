// Shared *derived* library view: the filter → group → flatten pipeline, computed
// once from the library + view stores and read in several places (the topbar
// count, the play queue in +page, and the LibraryList component). Svelte won't
// let a module `export` a `$derived`, so the derivations live as fields on a
// singleton class instance — the idiomatic shared-derived-state pattern (like a
// memoised selector). Read `lib.groups` etc. anywhere; no prop-drilling, and the
// grouping runs once per change rather than once per consumer.
import type { Track } from "$lib/api";
import { FAV_BUCKET, filterTracks, groupTracks, sortFlatTracks } from "$lib/library";
import { library } from "$lib/library.svelte";
import { manifestIndex } from "$lib/manifest.svelte";
import { view } from "$lib/view.svelte";

class LibraryView {
  /** Favourites tab: same grouped list, favourites-only predicate. */
  favView = $derived(view.tab === "favourites");
  /** Library or Favourites (both render the grouped list + facet toolbar). */
  listView = $derived(view.tab === "library" || view.tab === "favourites");

  filtered = $derived(
    filterTracks(library.tracks, {
      favView: this.favView,
      fmtFilter: view.fmtFilter,
      trackerFilter: view.trackerFilter,
      query: view.query,
    }),
  );

  // Favourites render as ONE flat, deduped song list (no group cards): a single
  // bucket of the favourited tracks (lib.filtered is per-track, not group-
  // expanded, so no manifest many-to-many duplicates) ordered by the track sort.
  // Because flatTracks — and thus the play queue — derives from `groups`, the
  // queue stays consistent with the visible flat order for free. The library tab
  // keeps the real grouped/faceted buckets.
  groups = $derived<[string, Track[]][]>(
    this.favView
      ? this.filtered.length
        ? [[FAV_BUCKET, sortFlatTracks(this.filtered, view.trackSort)]]
        : []
      : groupTracks(
          this.filtered,
          {
            groupBy: view.groupBy,
            trackSort: view.trackSort,
            groupSort: view.groupSort,
          },
          manifestIndex(),
        ),
  );

  /** The visible order flattened — this is the play queue (next/prev/auto-advance
   *  follow what you see). */
  flatTracks = $derived(this.groups.flatMap(([, items]) => items));
}

export const lib = new LibraryView();

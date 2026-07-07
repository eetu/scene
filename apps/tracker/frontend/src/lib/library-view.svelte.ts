// Shared *derived* library view: the filter → group → flatten pipeline, computed
// once from the library + view stores and read in several places (the topbar
// count, the play queue in +page, and the LibraryList component). Svelte won't
// let a module `export` a `$derived`, so the derivations live as fields on a
// singleton class instance — the idiomatic shared-derived-state pattern (like a
// memoised selector). Read `lib.groups` etc. anywhere; no prop-drilling, and the
// grouping runs once per change rather than once per consumer.
import { filterTracks, groupTracks } from "$lib/library";
import { library } from "$lib/library.svelte";
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

  groups = $derived(
    groupTracks(this.filtered, {
      groupBy: view.groupBy,
      trackSort: view.trackSort,
      groupSort: view.groupSort,
    }),
  );

  /** The visible order flattened — this is the play queue (next/prev/auto-advance
   *  follow what you see). */
  flatTracks = $derived(this.groups.flatMap(([, items]) => items));
}

export const lib = new LibraryView();

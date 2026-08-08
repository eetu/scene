// Shared library view/filter state — a rune store (like settings/library). The
// FacetBar controls, the topbar tabs + count, and the list derivations all read
// it, so it's shared, not prop-drilled. Plain state (no machine — it's just view
// prefs); only the tab is persisted.
import { readPref, writePref } from "@scene/player";

import type { LibraryQuery } from "$lib/api";
import type { GroupKey, GroupSort, TrackSort } from "$lib/library";

export type Tab = "library" | "favourites" | "playlists";

const TAB_KEY = "tracker:tab";
const VIEW_KEY = "tracker:view";

/** Persisted slice of the view. The free-text query is deliberately excluded —
 *  a search you typed once shouldn't still be filtering the library tomorrow.
 *  The rest *is* persisted, and `collection` especially: with two collections in
 *  one library, a source you didn't pick shouldn't turn up in shuffle. */
type Persisted = {
  collection: string;
  groupBy: GroupKey;
  trackSort: TrackSort;
  groupSort: GroupSort;
  fmtFilter: string;
  trackerFilter: string;
};

const DEFAULTS: Persisted = {
  // The primary root. A collection you haven't opted into stays out of the
  // library — and therefore out of the play queue.
  collection: "mods",
  groupBy: "group",
  trackSort: "name",
  groupSort: "name",
  fmtFilter: "",
  trackerFilter: "",
};

function load(): Persisted {
  try {
    const raw = readPref(VIEW_KEY);
    if (!raw) return { ...DEFAULTS };
    // Spread over the defaults so a stored blob from an older shape (or a
    // hand-edited one) can't leave a field undefined.
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Persisted>) };
  } catch {
    return { ...DEFAULTS };
  }
}

const storedTab = readPref(TAB_KEY) as Tab | null;

export const view = $state({
  tab: storedTab ?? "library",
  ...load(),
  query: "",
});

/** Persist the sticky slice. Call after any control change. */
export function saveView() {
  writePref(
    VIEW_KEY,
    JSON.stringify({
      collection: view.collection,
      groupBy: view.groupBy,
      trackSort: view.trackSort,
      groupSort: view.groupSort,
      fmtFilter: view.fmtFilter,
      trackerFilter: view.trackerFilter,
    } satisfies Persisted),
  );
}

export function setTab(t: Tab) {
  view.tab = t;
  writePref(TAB_KEY, t);
}

/** Switch the source scope (Mods / HVSC / All — "" means all). Clears the
 *  format filter, which is scoped to the collection you were browsing. */
export function setCollection(id: string) {
  view.collection = id;
  view.fmtFilter = "";
  saveView();
}

/** Reset the sort + facet controls (leaves the tab and free-text query alone). */
export function resetControls() {
  view.trackSort = "name";
  view.groupSort = "name";
  view.fmtFilter = "";
  view.trackerFilter = "";
  saveView();
}

/** True when any sort/facet control is off its default (drives the reset button). */
export function controlsActive(): boolean {
  return (
    view.trackSort !== "name" ||
    view.groupSort !== "name" ||
    !!view.fmtFilter ||
    !!view.trackerFilter
  );
}

/** The view mirrored onto the API's library query. Lives here (not in the
 *  derived view) because both the store's own loader and the page's change
 *  effect need it, and the store can't import the derived view without a cycle.
 *  Reads reactive state, so it stays reactive inside a `$derived` / `$effect`. */
export function queryFromView(): LibraryQuery {
  return {
    collection: view.collection,
    fav: view.tab === "favourites",
    fmt: view.fmtFilter,
    tracker: view.trackerFilter,
    q: view.query,
    group_by: view.groupBy,
    track_sort: view.trackSort,
    group_sort: view.groupSort,
  };
}

/** What the buckets are called for the current group-by (count line + FacetBar). */
export function bucketNoun(): string {
  if (view.groupBy === "ext") return "formats";
  if (view.groupBy === "artist") return "artists";
  if (view.groupBy === "album") return "albums";
  return "groups";
}

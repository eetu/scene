// Shared library view/filter state — a rune store (like settings/library). The
// FacetBar controls, the topbar tabs + count, and the list derivations all read
// it, so it's shared, not prop-drilled. Plain state (no machine — it's just view
// prefs); only the tab is persisted.
import type { GroupKey, GroupSort, TrackSort } from "$lib/library";

export type Tab = "library" | "favourites" | "playlists";

const TAB_KEY = "tracker:tab";
const storedTab =
  typeof localStorage !== "undefined" ? (localStorage.getItem(TAB_KEY) as Tab | null) : null;

export const view = $state({
  tab: storedTab ?? "library",
  groupBy: "group" as GroupKey,
  trackSort: "name" as TrackSort,
  groupSort: "name" as GroupSort,
  fmtFilter: "",
  trackerFilter: "",
  query: "",
});

export function setTab(t: Tab) {
  view.tab = t;
  try {
    localStorage.setItem(TAB_KEY, t);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

/** Reset the sort + facet controls (leaves the tab and free-text query alone). */
export function resetControls() {
  view.trackSort = "name";
  view.groupSort = "name";
  view.fmtFilter = "";
  view.trackerFilter = "";
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

/** What the buckets are called for the current group-by (count line + FacetBar). */
export function bucketNoun(): string {
  return view.groupBy === "ext" ? "formats" : view.groupBy === "artist" ? "artists" : "groups";
}

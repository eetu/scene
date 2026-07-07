// Pure library grouping / filtering / sort / rail logic, extracted from
// +page.svelte so it's node-unit-testable (see __tests__/library.test.ts). The
// component keeps the reactive `$derived` wrappers; the transforms live here.
import type { Track } from "$lib/api";

export type GroupKey = "group" | "artist" | "ext";
export type TrackSort = "name" | "duration" | "channels" | "plays";
export type GroupSort = "name" | "plays" | "size";

/** Files with no group collect here (the `_groupless/` dir or an empty group);
 *  shown as "Groupless" and pinned last. */
export const GROUPLESS = "_groupless";
export const GROUPLESS_LABEL = "Groupless";

/** The bucket a track falls under for the current group-by. */
export function keyOf(t: Track, groupBy: GroupKey): string {
  if (groupBy === "group") return t.group || GROUPLESS;
  if (groupBy === "artist") return t.artist || "(unknown artist)";
  return t.ext.toUpperCase();
}

/** The muted prefix shown beside a row title — the *other* dimension. */
export function subLabel(t: Track, groupBy: GroupKey): string {
  const grp = t.group === GROUPLESS ? "" : t.group;
  if (groupBy === "group") return t.artist ?? "—";
  if (groupBy === "artist") return grp || "—";
  return [grp, t.artist].filter(Boolean).join(" · ") || "—";
}

export type FilterOpts = {
  favView: boolean;
  fmtFilter: string;
  trackerFilter: string;
  query: string;
};

/** Apply the favourites view + facet filters + free-text query. */
export function filterTracks(tracks: Track[], o: FilterOpts): Track[] {
  const q = o.query.trim().toLowerCase();
  let list = tracks;
  if (o.favView) list = list.filter((t) => t.favorite);
  if (o.fmtFilter) list = list.filter((t) => t.ext.toUpperCase() === o.fmtFilter);
  if (o.trackerFilter) list = list.filter((t) => (t.tracker ?? "") === o.trackerFilter);
  if (q)
    list = list.filter((t) =>
      [t.path, t.title, t.filename, t.group, t.artist, t.type_long]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q)),
    );
  return list;
}

export type GroupOpts = { groupBy: GroupKey; trackSort: TrackSort; groupSort: GroupSort };

/** Group tracks into buckets and order both the tracks within each bucket and the
 *  buckets themselves. Groupless always sinks last. JS sort is stable, so `name`
 *  keeps the server order and non-name sorts fall back to A-Z on ties. */
export function groupTracks(filtered: Track[], o: GroupOpts): [string, Track[]][] {
  const acc: Record<string, Track[]> = {};
  for (const t of filtered) (acc[keyOf(t, o.groupBy)] ??= []).push(t);

  if (o.trackSort !== "name") {
    const metric: (t: Track) => number =
      o.trackSort === "duration"
        ? (t) => t.duration ?? -1
        : o.trackSort === "channels"
          ? (t) => t.channels ?? -1
          : (t) => t.play_count;
    for (const items of Object.values(acc)) items.sort((a, b) => metric(b) - metric(a));
  }

  const byName = (a: [string, Track[]], b: [string, Track[]]) =>
    a[0].localeCompare(b[0], undefined, { sensitivity: "base" });
  const plays = (items: Track[]) => items.reduce((n, t) => n + t.play_count, 0);
  return Object.entries(acc).sort((a, b) => {
    const ag = a[0] === GROUPLESS;
    const bg = b[0] === GROUPLESS;
    if (ag !== bg) return ag ? 1 : -1;
    if (o.groupSort === "plays") return plays(b[1]) - plays(a[1]) || byName(a, b);
    if (o.groupSort === "size") return b[1].length - a[1].length || byName(a, b);
    return byName(a, b);
  });
}

/** Facet dropdown options from the current base list (upper-cased formats). */
export function facetFormats(base: Track[]): string[] {
  return [...new Set(base.map((t) => t.ext.toUpperCase()))].sort((a, b) => a.localeCompare(b));
}
export function facetTrackers(base: Track[]): string[] {
  return [...new Set(base.map((t) => t.tracker).filter((t): t is string => !!t))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/** Flattened virtualizer row stream: a header per group + the track rows of open
 *  groups. */
export type LibRow =
  | { kind: "header"; name: string; count: number; open: boolean; first: boolean }
  | { kind: "track"; track: Track; last: boolean };

export function buildRows(
  groups: [string, Track[]][],
  isOpen: (name: string) => boolean,
): LibRow[] {
  const out: LibRow[] = [];
  for (const [name, items] of groups) {
    const open = isOpen(name);
    out.push({ kind: "header", name, count: items.length, open, first: out.length === 0 });
    if (open)
      items.forEach((t, i) => out.push({ kind: "track", track: t, last: i === items.length - 1 }));
  }
  return out;
}

/** Stable virtualizer key for a row. */
export function rowKey(r: LibRow): string {
  return r.kind === "header" ? `h:${r.name}` : `t:${r.track.path}`;
}

/** A-Z rail: the letter bucket for a group name (`#` for non-alpha). */
export function railLetter(name: string): string {
  const c = name[0]?.toUpperCase() ?? "#";
  return c >= "A" && c <= "Z" ? c : "#";
}

/** letter → row index of its first group header (buckets are contiguous per
 *  letter when A-Z sorted, so the first hit is the jump target). */
export function letterRowMap(rows: LibRow[]): Map<string, number> {
  const m = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.kind === "header" && !m.has(railLetter(r.name))) m.set(railLetter(r.name), i);
  });
  return m;
}

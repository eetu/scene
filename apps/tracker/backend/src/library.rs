//! Server-side library shaping: filter → group → sort, over the whole index.
//!
//! This is the Rust twin of the frontend's `lib/library.ts`, which used to do
//! all of this in the browser over the entire `/api/tracks` payload. That stops
//! working once HVSC is in the collection — ~91k tracks is tens of megabytes of
//! JSON — so the shaping moved here and the client now receives an *ordered id
//! stream* plus a hydrated window of it.
//!
//! The transforms are deliberately pure functions over [`Row`] (a lean
//! projection, never serialised) so they can be unit-tested without a DB, and so
//! the frontend's existing `library.test.ts` cases can be mirrored here as the
//! behavioural spec.
//!
//! **Collation caveat.** The browser compared names with
//! `localeCompare(…, { sensitivity: "base" })`, which ignores case *and*
//! accents. Rust has no locale collation in std, so ordering here folds case
//! only — `é` and `e` sort apart. That matches the rest of the backend (the
//! index's `COLLATE NOCASE`, and `manifest::norm`, whose doc comment already
//! flags Unicode normalisation as a follow-up).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::manifest::Resolved;

/// Files with no group collect here; shown as "Groupless" and pinned last.
pub const GROUPLESS: &str = "_groupless";
/// Bucket for tracks in no album (group-by album); pinned last, like GROUPLESS.
pub const NO_ALBUM: &str = " no-album";
/// Single bucket for the favourites view — rendered flat, so the name is unused.
pub const FAV_BUCKET: &str = " favourites";
/// Bucket for a track whose path carries no artist directory.
pub const UNKNOWN_ARTIST: &str = "(unknown artist)";

/// Buckets pinned to the bottom of the list (sentinels, not real names).
fn is_sentinel(name: &str) -> bool {
    name == GROUPLESS || name == NO_ALBUM
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GroupKey {
    #[default]
    Group,
    Artist,
    Ext,
    Album,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TrackSort {
    #[default]
    Name,
    Duration,
    Channels,
    Plays,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum GroupSort {
    #[default]
    Name,
    Plays,
    Size,
}

/// Subtune slots reserved per file in a track id. A SID header caps at 256
/// subtunes, so this is exact rather than a guess.
pub const SUBSONG_SLOTS: i64 = 256;

/// A playable track's id: the file's surrogate id with its subtune folded in.
///
/// One integer identifies one *playable thing*, which is what the client's
/// queue, the shaped id stream and the hydration cache all key on — a SID file
/// holding twelve tunes is twelve entries, not one. Stays well inside JS's safe
/// integer range: 91k files × 256 is ~23 million.
pub fn track_id(file_id: i64, subsong: i64) -> i64 {
    file_id * SUBSONG_SLOTS + subsong
}

/// Split a track id back into `(file_id, subsong)`.
pub fn split_track_id(id: i64) -> (i64, i64) {
    (id / SUBSONG_SLOTS, id % SUBSONG_SLOTS)
}

/// One indexed track, projected lean: only what filtering, grouping and sorting
/// need. Display fields are fetched separately for the visible window.
#[derive(Debug, Clone, Default)]
pub struct Row {
    /// The encoded track id (see [`track_id`]), not the raw `files.id`.
    pub id: i64,
    pub collection: String,
    pub path: String,
    pub group: String,
    pub artist: Option<String>,
    pub filename: String,
    pub ext: String,
    pub md5: Option<String>,
    pub title: Option<String>,
    pub type_long: Option<String>,
    pub tracker: Option<String>,
    pub duration: Option<f64>,
    pub channels: Option<i64>,
    pub favorite: bool,
    pub play_count: i64,
}

/// The library query — the server-side counterpart of the frontend's view store.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Query {
    /// Restrict to one configured root (the source selector). Empty = all.
    pub collection: String,
    /// Favourites view: a single flat bucket of favourited tracks.
    pub fav: bool,
    /// Upper-cased file extension, e.g. `MOD`.
    pub fmt: String,
    /// Exact `meta.tracker` match.
    pub tracker: String,
    /// Free-text query over path/title/filename/group/artist/type.
    pub q: String,
    pub group_by: GroupKey,
    pub track_sort: TrackSort,
    pub group_sort: GroupSort,
}

/// One bucket of the shaped library: a header name plus its track ids in order.
#[derive(Debug, Serialize)]
pub struct Bucket {
    pub name: String,
    pub ids: Vec<i64>,
}

/// The shaped library. `ids` across all buckets, in order, *is* the play queue —
/// the client permutes indices into it for shuffle, exactly as it did over the
/// flattened client-side list.
#[derive(Debug, Serialize)]
pub struct Shaped {
    pub groups: Vec<Bucket>,
    /// Total track rows across all buckets (a track in two groups counts twice,
    /// matching what the list actually renders).
    pub total: usize,
    /// Facet options, derived from the collection-scoped base list so the
    /// dropdowns don't offer values that can't match.
    pub formats: Vec<String>,
    pub trackers: Vec<String>,
}

/// Case-folded comparison, standing in for the browser's base-sensitivity
/// collation (see the module docs).
fn fold(s: &str) -> String {
    s.to_lowercase()
}

fn cmp_name(a: &str, b: &str) -> std::cmp::Ordering {
    fold(a).cmp(&fold(b))
}

/// The bucket(s) a track falls under for the current group-by. `group` and
/// `album` are many-to-many, so this returns 1+ keys; `artist` and `ext` one.
fn keys_of(t: &Row, group_by: GroupKey, idx: &Resolved) -> Vec<String> {
    match group_by {
        GroupKey::Artist => match t.artist.as_deref().filter(|a| !a.is_empty()) {
            Some(a) => vec![idx.canonical(a)],
            None => vec![UNKNOWN_ARTIST.to_string()],
        },
        GroupKey::Ext => vec![t.ext.to_uppercase()],
        GroupKey::Album => {
            let albums = t
                .md5
                .as_deref()
                .map(|m| idx.album_labels(m))
                .unwrap_or_default();
            if albums.is_empty() {
                vec![NO_ALBUM.to_string()]
            } else {
                albums
            }
        }
        GroupKey::Group => {
            // Prefer manifest membership (many-to-many); fall back to the path
            // group so an un-seeded manifest still browses by group.
            if let Some(a) = t.artist.as_deref().filter(|a| !a.is_empty()) {
                let groups = idx.groups_of(&idx.canonical(a));
                if !groups.is_empty() {
                    return groups;
                }
            }
            let g = if !t.group.is_empty() && t.group != GROUPLESS {
                t.group.clone()
            } else {
                GROUPLESS.to_string()
            };
            vec![g]
        }
    }
}

/// Apply the favourites view + facet filters + free-text query.
fn matches(t: &Row, q: &Query, needle: &str) -> bool {
    if q.fav && !t.favorite {
        return false;
    }
    if !q.collection.is_empty() && t.collection != q.collection {
        return false;
    }
    if !q.fmt.is_empty() && t.ext.to_uppercase() != q.fmt {
        return false;
    }
    if !q.tracker.is_empty() && t.tracker.as_deref().unwrap_or("") != q.tracker {
        return false;
    }
    if !needle.is_empty() {
        let hit = [
            Some(t.path.as_str()),
            t.title.as_deref(),
            Some(t.filename.as_str()),
            Some(t.group.as_str()),
            t.artist.as_deref(),
            t.type_long.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|v| fold(v).contains(needle));
        if !hit {
            return false;
        }
    }
    true
}

/// Metric for the high-to-low track sorts. `name` is handled separately (it
/// keeps the incoming A-Z order, or sorts by title for the flat view).
fn metric(t: &Row, sort: TrackSort) -> f64 {
    match sort {
        TrackSort::Duration => t.duration.unwrap_or(-1.0),
        TrackSort::Channels => t.channels.unwrap_or(-1) as f64,
        TrackSort::Plays => t.play_count as f64,
        TrackSort::Name => 0.0,
    }
}

/// Shape the index: filter, bucket, and order both the tracks within each bucket
/// and the buckets themselves.
///
/// `rows` must arrive in the index's base A-Z order — sorts here are stable, so
/// that order is what non-name sorts tie-break to (the same contract the browser
/// relied on from `Array.prototype.sort`).
pub fn shape(rows: &[Row], q: &Query, idx: &Resolved) -> Shaped {
    let needle = fold(q.q.trim());

    // Facet options come from the collection-scoped list, before the other
    // filters — so choosing a format doesn't empty the format dropdown.
    let mut formats: Vec<String> = Vec::new();
    let mut trackers: Vec<String> = Vec::new();
    {
        let mut seen_f = std::collections::HashSet::new();
        let mut seen_t = std::collections::HashSet::new();
        for t in rows {
            if !q.collection.is_empty() && t.collection != q.collection {
                continue;
            }
            let f = t.ext.to_uppercase();
            if seen_f.insert(f.clone()) {
                formats.push(f);
            }
            if let Some(tr) = t.tracker.as_deref().filter(|s| !s.is_empty()) {
                if seen_t.insert(tr.to_string()) {
                    trackers.push(tr.to_string());
                }
            }
        }
        formats.sort();
        trackers.sort_by(|a, b| cmp_name(a, b));
    }

    let matched: Vec<&Row> = rows.iter().filter(|t| matches(t, q, &needle)).collect();

    // Favourites render as ONE flat, deduped song list — no group headers, and
    // no manifest many-to-many duplicates.
    if q.fav {
        if matched.is_empty() {
            return Shaped {
                groups: Vec::new(),
                total: 0,
                formats,
                trackers,
            };
        }
        let mut items: Vec<&Row> = matched;
        match q.track_sort {
            TrackSort::Name => items.sort_by(|a, b| {
                let (an, bn) = (
                    a.title
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&a.filename),
                    b.title
                        .as_deref()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&b.filename),
                );
                cmp_name(an, bn)
            }),
            s => items.sort_by(|a, b| {
                metric(b, s)
                    .partial_cmp(&metric(a, s))
                    .unwrap_or(std::cmp::Ordering::Equal)
            }),
        }
        let ids: Vec<i64> = items.iter().map(|t| t.id).collect();
        let total = ids.len();
        return Shaped {
            groups: vec![Bucket {
                name: FAV_BUCKET.to_string(),
                ids,
            }],
            total,
            formats,
            trackers,
        };
    }

    // Bucket. Insertion order is the incoming A-Z order, which the stable sorts
    // below preserve on ties.
    let mut order: Vec<String> = Vec::new();
    let mut acc: HashMap<String, Vec<&Row>> = HashMap::new();
    for t in &matched {
        for k in keys_of(t, q.group_by, idx) {
            acc.entry(k.clone())
                .or_insert_with(|| {
                    order.push(k.clone());
                    Vec::new()
                })
                .push(t);
        }
    }

    if q.track_sort != TrackSort::Name {
        for items in acc.values_mut() {
            items.sort_by(|a, b| {
                metric(b, q.track_sort)
                    .partial_cmp(&metric(a, q.track_sort))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        }
    }

    let plays = |items: &Vec<&Row>| -> i64 { items.iter().map(|t| t.play_count).sum() };
    order.sort_by(|a, b| {
        // Sentinels always sink, whatever the sort.
        match (is_sentinel(a), is_sentinel(b)) {
            (true, false) => return std::cmp::Ordering::Greater,
            (false, true) => return std::cmp::Ordering::Less,
            _ => {}
        }
        match q.group_sort {
            GroupSort::Plays => plays(&acc[b])
                .cmp(&plays(&acc[a]))
                .then_with(|| cmp_name(a, b)),
            GroupSort::Size => acc[b].len().cmp(&acc[a].len()).then_with(|| cmp_name(a, b)),
            GroupSort::Name => cmp_name(a, b),
        }
    });

    let mut total = 0;
    let groups = order
        .into_iter()
        .map(|name| {
            let ids: Vec<i64> = acc[&name].iter().map(|t| t.id).collect();
            total += ids.len();
            Bucket { name, ids }
        })
        .collect();

    Shaped {
        groups,
        total,
        formats,
        trackers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{Artist, Manifest};

    fn row(id: i64, artist: &str, filename: &str) -> Row {
        Row {
            id,
            collection: "mods".into(),
            path: format!("{artist}/{filename}"),
            group: String::new(),
            artist: Some(artist.into()),
            filename: filename.into(),
            ext: filename.rsplit('.').next().unwrap_or("").into(),
            ..Row::default()
        }
    }

    fn empty_idx() -> Resolved {
        Resolved::build(Manifest::default())
    }

    #[test]
    fn track_ids_round_trip_through_the_subsong_encoding() {
        for (file, sub) in [(1i64, 0i64), (1, 255), (91_400, 12), (61_157, 255)] {
            assert_eq!(split_track_id(track_id(file, sub)), (file, sub));
        }
        // Distinct subtunes of one file are distinct tracks, and never collide
        // with a neighbouring file's.
        assert_ne!(track_id(7, 0), track_id(7, 1));
        assert_ne!(track_id(7, 255), track_id(8, 0));
        // Comfortably inside JS's safe integer range at HVSC scale.
        assert!(track_id(100_000, 255) < 2i64.pow(53));
    }

    #[test]
    fn groups_by_artist_and_sinks_unknown_to_its_own_bucket() {
        let rows = vec![
            row(1, "Purple Motion", "sundance.xm"),
            row(2, "4-Mat", "enigma.mod"),
            Row {
                artist: None,
                ..row(3, "", "loose.mod")
            },
        ];
        let q = Query {
            group_by: GroupKey::Artist,
            ..Query::default()
        };
        let out = shape(&rows, &q, &empty_idx());
        let names: Vec<&str> = out.groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, ["(unknown artist)", "4-Mat", "Purple Motion"]);
        assert_eq!(out.total, 3);
    }

    #[test]
    fn groupless_sinks_last_whatever_the_sort() {
        let rows = vec![
            Row {
                group: GROUPLESS.into(),
                ..row(1, "Nobody", "a.mod")
            },
            Row {
                group: "Zenith".into(),
                ..row(2, "Someone", "b.mod")
            },
        ];
        for group_sort in [GroupSort::Name, GroupSort::Plays, GroupSort::Size] {
            let q = Query {
                group_by: GroupKey::Group,
                group_sort,
                ..Query::default()
            };
            let out = shape(&rows, &q, &empty_idx());
            let names: Vec<&str> = out.groups.iter().map(|g| g.name.as_str()).collect();
            assert_eq!(names, ["Zenith", GROUPLESS], "sort {group_sort:?}");
        }
    }

    #[test]
    fn manifest_membership_spreads_a_track_across_groups() {
        let mut m = Manifest::default();
        m.artists.insert(
            "Coder".into(),
            Artist {
                aka: vec!["cdr".into()],
                groups: vec!["Alpha".into(), "Beta".into()],
            },
        );
        let idx = Resolved::build(m);
        // The path uses the alias, which must resolve to the canonical artist.
        let rows = vec![row(1, "cdr", "song.mod")];
        let q = Query {
            group_by: GroupKey::Group,
            ..Query::default()
        };
        let out = shape(&rows, &q, &idx);
        let names: Vec<&str> = out.groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "Beta"]);
        // The same track counts once per bucket it renders in.
        assert_eq!(out.total, 2);
    }

    #[test]
    fn collection_filter_scopes_both_rows_and_facets() {
        let rows = vec![
            Row {
                ext: "mod".into(),
                ..row(1, "A", "a.mod")
            },
            Row {
                collection: "hvsc".into(),
                ext: "sid".into(),
                ..row(2, "B", "b.sid")
            },
        ];
        let q = Query {
            collection: "hvsc".into(),
            group_by: GroupKey::Artist,
            ..Query::default()
        };
        let out = shape(&rows, &q, &empty_idx());
        assert_eq!(out.total, 1);
        assert_eq!(out.groups[0].ids, vec![2]);
        // The format dropdown must not offer MOD while scoped to HVSC.
        assert_eq!(out.formats, vec!["SID"]);
    }

    #[test]
    fn track_sort_orders_within_a_bucket_high_to_low() {
        let rows = vec![
            Row {
                play_count: 1,
                ..row(1, "A", "a.mod")
            },
            Row {
                play_count: 9,
                ..row(2, "A", "b.mod")
            },
            Row {
                play_count: 5,
                ..row(3, "A", "c.mod")
            },
        ];
        let q = Query {
            group_by: GroupKey::Artist,
            track_sort: TrackSort::Plays,
            ..Query::default()
        };
        let out = shape(&rows, &q, &empty_idx());
        assert_eq!(out.groups[0].ids, vec![2, 3, 1]);
    }

    #[test]
    fn name_track_sort_keeps_the_incoming_index_order() {
        // `name` must not reorder — the caller supplies A-Z from SQL, and the
        // stable sorts elsewhere tie-break to it.
        let rows = vec![
            row(1, "A", "aaa.mod"),
            row(2, "A", "bbb.mod"),
            row(3, "A", "ccc.mod"),
        ];
        let q = Query {
            group_by: GroupKey::Artist,
            ..Query::default()
        };
        let out = shape(&rows, &q, &empty_idx());
        assert_eq!(out.groups[0].ids, vec![1, 2, 3]);
    }

    #[test]
    fn favourites_are_one_flat_bucket_without_group_duplicates() {
        let mut m = Manifest::default();
        m.artists.insert(
            "Coder".into(),
            Artist {
                aka: vec![],
                groups: vec!["Alpha".into(), "Beta".into()],
            },
        );
        let rows = vec![
            Row {
                favorite: true,
                ..row(1, "Coder", "fav.mod")
            },
            row(2, "Coder", "plain.mod"),
        ];
        let q = Query {
            fav: true,
            group_by: GroupKey::Group,
            ..Query::default()
        };
        let out = shape(&rows, &q, &Resolved::build(m));
        assert_eq!(out.groups.len(), 1);
        assert_eq!(out.groups[0].name, FAV_BUCKET);
        // Once, not once per group the artist belongs to.
        assert_eq!(out.groups[0].ids, vec![1]);
    }

    #[test]
    fn query_matches_across_the_display_fields_case_insensitively() {
        let rows = vec![
            Row {
                title: Some("Sundance".into()),
                ..row(1, "Purple Motion", "pm.xm")
            },
            row(2, "Other", "b.mod"),
        ];
        for needle in ["sundance", "SUNDANCE", "purple", "pm.xm"] {
            let q = Query {
                q: needle.into(),
                group_by: GroupKey::Artist,
                ..Query::default()
            };
            let out = shape(&rows, &q, &empty_idx());
            assert_eq!(out.total, 1, "needle {needle:?}");
        }
    }

    #[test]
    fn album_grouping_falls_back_to_the_no_album_bucket() {
        let rows = vec![Row {
            md5: Some("abc".into()),
            ..row(1, "A", "a.mod")
        }];
        let q = Query {
            group_by: GroupKey::Album,
            ..Query::default()
        };
        let out = shape(&rows, &q, &empty_idx());
        assert_eq!(out.groups[0].name, NO_ALBUM);
    }
}

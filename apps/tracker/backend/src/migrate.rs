//! Offline migration planner. Reads an `md5<TAB>size<TAB>relpath` snapshot of
//! the current (legacy `group/artist/song`) collection and derives, **purely
//! over the TSV** (no filesystem walk, no SMB contention — safe while the mount
//! is being edited):
//!
//! 1. a **seeded `library.json`** — each artist's `groups[]` inferred from the
//!    group segments its files sit under (the group knowledge moves from path to
//!    manifest, not lost);
//! 2. **alias candidates** — the same md5 under two *different* artist folders,
//!    i.e. one artist released under both handles (flagged for review, never
//!    auto-merged);
//! 3. an **exact-duplicate report** — identical bytes at several paths (the
//!    dedup worklist).
//!
//! The physical `group/artist → artist` file moves are a separate, gated step
//! run against a fresh snapshot once the gap-filling session is done — a move
//! plan built from this snapshot would go stale, so it's intentionally not
//! produced here. The seed manifest, by contrast, is durable: it's keyed by
//! artist name + md5, so it stays correct as files are added.

use std::collections::{BTreeMap, BTreeSet};

use indexmap::IndexMap;
use serde::Serialize;

use crate::manifest::{Artist, Manifest};
use crate::scan::GROUPLESS;

/// One row of the md5 manifest.
pub struct Entry {
    pub md5: String,
    pub size: u64,
    pub path: String,
}

/// Where a file with no derivable author is filed in the artist-primary tree.
pub const UNKNOWN_ARTIST: &str = "_unknown";

/// Parse the md5-manifest TSV (`md5<TAB>size<TAB>relpath`). A leading header row
/// (`md5\t…`) and blank/short lines are skipped; the path uses forward slashes.
pub fn parse_tsv(text: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut cols = line.splitn(3, '\t');
        let (Some(md5), Some(size), Some(path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        // Skip the header row.
        if md5.eq_ignore_ascii_case("md5") {
            continue;
        }
        out.push(Entry {
            md5: md5.trim().to_lowercase(),
            size: size.trim().parse().unwrap_or(0),
            path: path.trim().to_string(),
        });
    }
    out
}

/// Derive the artist-primary `(artist, group, filename)` for a legacy path.
///
/// A path always ends in the file, so only 3+ segments carry an artist:
/// `Group/Artist/…/file` → (Artist, Some(Group), file); `_groupless/Artist/file`
/// → (Artist, None, file). Anything shorter (`Group/file`, `_groupless/file`, a
/// loose root file) has no artist directory → (`_unknown`, None, file); the group
/// is unattachable without an author, so it's dropped and counted for review.
pub fn derive_target(path: &str) -> (String, Option<String>, String) {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let filename = segs.last().copied().unwrap_or(path).to_string();
    match segs.as_slice() {
        [group, artist, _, ..] => {
            let group = (*group != GROUPLESS).then(|| (*group).to_string());
            ((*artist).to_string(), group, filename)
        }
        _ => (UNKNOWN_ARTIST.to_string(), None, filename),
    }
}

#[derive(Serialize)]
pub struct Dupe {
    pub md5: String,
    pub paths: Vec<String>,
}

#[derive(Serialize)]
pub struct AliasCandidate {
    pub md5: String,
    /// The distinct artist folders these identical bytes appear under.
    pub artists: Vec<String>,
    pub paths: Vec<String>,
}

#[derive(Serialize, Default)]
pub struct Stats {
    pub files: usize,
    pub unique_md5: usize,
    pub artists: usize,
    pub groups: usize,
    pub exact_dupe_sets: usize,
    /// Copies beyond one-per-md5 — the bytes that dedup would reclaim.
    pub redundant_copies: usize,
    pub unknown_artist_files: usize,
    pub alias_candidate_sets: usize,
}

pub struct Seed {
    pub manifest: Manifest,
    pub exact_dupes: Vec<Dupe>,
    pub alias_candidates: Vec<AliasCandidate>,
    pub stats: Stats,
}

/// Build the seed manifest + reports from the parsed entries.
pub fn build_seed(entries: &[Entry]) -> Seed {
    // artist → set of groups (BTreeSet keeps output deterministic + de-duped).
    let mut artist_groups: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    // md5 → the entry indices carrying those bytes.
    let mut by_md5: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let mut unknown_artist_files = 0usize;

    for (i, e) in entries.iter().enumerate() {
        let (artist, group, _file) = derive_target(&e.path);
        if artist == UNKNOWN_ARTIST {
            unknown_artist_files += 1;
        }
        let set = artist_groups.entry(artist).or_default();
        if let Some(g) = group {
            set.insert(g);
        }
        by_md5.entry(e.md5.clone()).or_default().push(i);
    }

    // Only artists with real group memberships go in the manifest — an artist
    // with no groups (and no aka) carries no info and still browses (canonical
    // resolves to itself). Skip the _unknown bucket entirely.
    let mut artists: IndexMap<String, Artist> = IndexMap::new();
    for (name, groups) in &artist_groups {
        if name == UNKNOWN_ARTIST || groups.is_empty() {
            continue;
        }
        artists.insert(
            name.clone(),
            Artist {
                aka: Vec::new(),
                groups: groups.iter().cloned().collect(),
            },
        );
    }

    let mut exact_dupes = Vec::new();
    let mut alias_candidates = Vec::new();
    let mut redundant_copies = 0usize;
    for (md5, idxs) in &by_md5 {
        if idxs.len() <= 1 {
            continue;
        }
        redundant_copies += idxs.len() - 1;
        let paths: Vec<String> = idxs.iter().map(|&i| entries[i].path.clone()).collect();
        let artists_here: BTreeSet<String> = idxs
            .iter()
            .map(|&i| derive_target(&entries[i].path).0)
            .collect();
        if artists_here.len() > 1 {
            alias_candidates.push(AliasCandidate {
                md5: md5.clone(),
                artists: artists_here.into_iter().collect(),
                paths: paths.clone(),
            });
        }
        exact_dupes.push(Dupe {
            md5: md5.clone(),
            paths,
        });
    }

    let group_count = artist_groups
        .values()
        .flat_map(|s| s.iter())
        .collect::<BTreeSet<_>>()
        .len();

    let stats = Stats {
        files: entries.len(),
        unique_md5: by_md5.len(),
        artists: artists.len(),
        groups: group_count,
        exact_dupe_sets: exact_dupes.len(),
        redundant_copies,
        unknown_artist_files,
        alias_candidate_sets: alias_candidates.len(),
    };

    Seed {
        manifest: Manifest {
            artists,
            albums: IndexMap::new(),
            songs: IndexMap::new(),
        },
        exact_dupes,
        alias_candidates,
        stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tsv_skipping_header_and_junk() {
        let tsv = "md5\tsize\tpath\n\
                   abc\t10\tAcme/Coder/song.mod\n\
                   \n\
                   # comment\n\
                   DEF\t20\t_groupless/Purple Motion/x.xm\n";
        let e = parse_tsv(tsv);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].md5, "abc");
        assert_eq!(e[0].size, 10);
        assert_eq!(e[1].md5, "def"); // lowercased
        assert_eq!(e[1].path, "_groupless/Purple Motion/x.xm");
    }

    #[test]
    fn derive_target_layouts() {
        assert_eq!(
            derive_target("Anarchy/4-Mat/enigma.mod"),
            ("4-Mat".into(), Some("Anarchy".into()), "enigma.mod".into())
        );
        // _groupless carries an artist but no group.
        assert_eq!(
            derive_target("_groupless/Purple Motion/x.xm"),
            ("Purple Motion".into(), None, "x.xm".into())
        );
        // Deeper nesting: group/artist keep seg0/seg1, filename is the leaf.
        assert_eq!(
            derive_target("Anarchy/4-Mat/1993/enigma.mod"),
            ("4-Mat".into(), Some("Anarchy".into()), "enigma.mod".into())
        );
        // A group with no artist subdir → unknown author (group unattachable).
        assert_eq!(
            derive_target("Anarchy/loose.mod"),
            (UNKNOWN_ARTIST.into(), None, "loose.mod".into())
        );
        // _groupless with no artist → unknown.
        assert_eq!(
            derive_target("_groupless/loose.mod"),
            (UNKNOWN_ARTIST.into(), None, "loose.mod".into())
        );
    }

    #[test]
    fn seeds_groups_and_flags_dupes_and_aliases() {
        let entries = parse_tsv(
            "md5\tsize\tpath\n\
             aaaa\t1\tAnarchy/4-Mat/a.mod\n\
             aaaa\t1\tRebels/4-Mat/a.mod\n\
             bbbb\t1\tFuture Crew/Purple Motion/b.xm\n\
             bbbb\t1\tFuture Crew/PM/b.xm\n\
             cccc\t1\t_groupless/Soloist/c.it\n",
        );
        let seed = build_seed(&entries);

        // 4-Mat's files sit under two groups → both seeded.
        assert_eq!(
            seed.manifest.artists["4-Mat"].groups,
            vec!["Anarchy", "Rebels"]
        );
        // Purple Motion is in Future Crew; the Soloist has no group → not in the
        // manifest (empty entry skipped).
        assert_eq!(
            seed.manifest.artists["Purple Motion"].groups,
            vec!["Future Crew"]
        );
        assert!(!seed.manifest.artists.contains_key("Soloist"));

        // md5 aaaa: same artist, two groups → a dupe but NOT an alias candidate.
        // md5 bbbb: same bytes under "Purple Motion" and "PM" → alias candidate.
        assert_eq!(seed.stats.exact_dupe_sets, 2);
        assert_eq!(seed.stats.redundant_copies, 2);
        assert_eq!(seed.alias_candidates.len(), 1);
        assert_eq!(seed.alias_candidates[0].md5, "bbbb");
        assert_eq!(seed.alias_candidates[0].artists, vec!["PM", "Purple Motion"]);
    }
}

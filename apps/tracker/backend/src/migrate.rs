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
use std::path::Path;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

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

// ---------- move plan (artist-primary relayout) ----------

#[derive(Serialize, Deserialize)]
pub struct Move {
    pub from: String,
    pub to: String,
    pub md5: String,
}

#[derive(Serialize, Deserialize)]
pub struct Delete {
    pub path: String,
    pub md5: String,
    /// The surviving copy these identical bytes fold into.
    pub dup_of: String,
}

#[derive(Serialize, Deserialize)]
pub struct Collision {
    /// The `artist/filename` two different tunes both wanted.
    pub target: String,
    /// The later source paths that got `~N`-suffixed to avoid clobbering.
    pub suffixed: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct MoveStats {
    pub moves: usize,
    pub deletes: usize,
    pub collisions: usize,
    /// Bytes reclaimed by dropping redundant exact-duplicate copies.
    pub bytes_reclaimed: u64,
}

#[derive(Serialize, Deserialize)]
pub struct MovePlan {
    pub moves: Vec<Move>,
    pub deletes: Vec<Delete>,
    pub collisions: Vec<Collision>,
    pub stats: MoveStats,
}

fn split_ext(name: &str) -> (String, String) {
    match name.rsplit_once('.') {
        Some((stem, ext)) => (stem.to_string(), format!(".{ext}")),
        None => (name.to_string(), String::new()),
    }
}

/// Plan the `group/artist/song → artist/song` relayout, purely over the snapshot
/// (no filesystem access — this is a dry run; the apply is separate and gated).
///
/// Exact duplicates collapse **per artist**: within one md5, each distinct artist
/// keeps one copy (the shortest path) and the rest are deletes. So a tune filed
/// under two *groups* by the same artist collapses to one, while the same bytes
/// under two *different* artist folders (an alias candidate) keeps one per handle
/// — both survive until you merge the handles (`aka`) and re-run dedup. Distinct
/// tunes that would land on the same `artist/filename` get `~N`-suffixed.
pub fn plan_moves(entries: &[Entry]) -> MovePlan {
    let mut by_md5: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, e) in entries.iter().enumerate() {
        by_md5.entry(e.md5.as_str()).or_default().push(i);
    }

    // Pick one survivor per (md5, artist); the rest are redundant copies.
    let mut survivors: Vec<usize> = Vec::new();
    let mut deletes: Vec<Delete> = Vec::new();
    let mut bytes_reclaimed = 0u64;
    for (md5, idxs) in &by_md5 {
        let mut by_artist: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for &i in idxs {
            by_artist
                .entry(derive_target(&entries[i].path).0)
                .or_default()
                .push(i);
        }
        for (_artist, mut group) in by_artist {
            group.sort_by(|&a, &b| {
                entries[a]
                    .path
                    .len()
                    .cmp(&entries[b].path.len())
                    .then_with(|| entries[a].path.cmp(&entries[b].path))
            });
            let canon = group[0];
            survivors.push(canon);
            for &i in &group[1..] {
                bytes_reclaimed += entries[i].size;
                deletes.push(Delete {
                    path: entries[i].path.clone(),
                    md5: (*md5).to_string(),
                    dup_of: entries[canon].path.clone(),
                });
            }
        }
    }

    // Assign destinations deterministically (by source path); suffix collisions so
    // a move never clobbers another tune's destination.
    survivors.sort_by(|&a, &b| entries[a].path.cmp(&entries[b].path));
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut moves: Vec<Move> = Vec::new();
    let mut collisions: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for &i in &survivors {
        let (artist, _group, filename) = derive_target(&entries[i].path);
        let base = format!("{artist}/{filename}");
        let mut to = base.clone();
        if used.contains(&to) {
            let (stem, ext) = split_ext(&filename);
            let mut n = 2;
            loop {
                let cand = format!("{artist}/{stem}~{n}{ext}");
                if !used.contains(&cand) {
                    to = cand;
                    break;
                }
                n += 1;
            }
            collisions
                .entry(base)
                .or_default()
                .push(entries[i].path.clone());
        }
        used.insert(to.clone());
        if to != entries[i].path {
            moves.push(Move {
                from: entries[i].path.clone(),
                to,
                md5: entries[i].md5.clone(),
            });
        }
    }

    let collisions: Vec<Collision> = collisions
        .into_iter()
        .map(|(target, suffixed)| Collision { target, suffixed })
        .collect();
    let stats = MoveStats {
        moves: moves.len(),
        deletes: deletes.len(),
        collisions: collisions.len(),
        bytes_reclaimed,
    };
    MovePlan {
        moves,
        deletes,
        collisions,
        stats,
    }
}

// ---------- apply (the gated, destructive step) ----------

#[derive(Default, Serialize)]
pub struct ApplyReport {
    pub moved: usize,
    /// Source no longer on disk (already migrated / removed) — skipped.
    pub move_skipped_missing: usize,
    /// Destination already existed — skipped rather than clobbered.
    pub move_conflicts: usize,
    pub deleted: usize,
    pub delete_skipped_missing: usize,
    pub dirs_removed: usize,
    pub errors: Vec<String>,
}

/// The ancestor directories of `rel` under `root`, deepest first (for empty-dir
/// cleanup after files move out).
fn ancestors_under(root: &Path, rel: &str) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut cur = Path::new(rel).parent();
    while let Some(p) = cur {
        if p.as_os_str().is_empty() {
            break;
        }
        out.push(root.join(p));
        cur = p.parent();
    }
    out // shallow→deep; caller sorts by depth desc
}

/// Execute (or dry-run) a [`MovePlan`] against `root`. Defensive and idempotent:
/// a missing source is skipped (already migrated), an existing destination is
/// **never clobbered** (skipped + counted), and emptied source directories are
/// removed. With `execute = false` nothing is touched — it just reports what the
/// live tree would allow. The apply re-checks the disk itself, so a snapshot
/// that's slightly stale can't cause a bad move.
pub fn apply_plan(root: &Path, plan: &MovePlan, execute: bool) -> ApplyReport {
    let mut r = ApplyReport::default();
    let mut touched_dirs: BTreeSet<std::path::PathBuf> = BTreeSet::new();

    for m in &plan.moves {
        let src = root.join(&m.from);
        let dst = root.join(&m.to);
        if !src.is_file() {
            r.move_skipped_missing += 1;
            continue;
        }
        if dst.exists() {
            r.move_conflicts += 1;
            continue;
        }
        if execute {
            if let Some(parent) = dst.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    r.errors.push(format!("mkdir {}: {e}", parent.display()));
                    continue;
                }
            }
            if let Err(e) = std::fs::rename(&src, &dst) {
                r.errors.push(format!("mv {} -> {}: {e}", m.from, m.to));
                continue;
            }
        }
        for d in ancestors_under(root, &m.from) {
            touched_dirs.insert(d);
        }
        r.moved += 1;
    }

    for d in &plan.deletes {
        let path = root.join(&d.path);
        if !path.is_file() {
            r.delete_skipped_missing += 1;
            continue;
        }
        if execute {
            if let Err(e) = std::fs::remove_file(&path) {
                r.errors.push(format!("rm {}: {e}", d.path));
                continue;
            }
        }
        for a in ancestors_under(root, &d.path) {
            touched_dirs.insert(a);
        }
        r.deleted += 1;
    }

    // Remove now-empty source dirs, deepest first. `remove_dir` only succeeds on
    // an empty directory, so this never deletes anything holding files.
    if execute {
        let mut dirs: Vec<_> = touched_dirs.into_iter().collect();
        dirs.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        for d in dirs {
            if std::fs::remove_dir(&d).is_ok() {
                r.dirs_removed += 1;
            }
        }
    }
    r
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

    #[test]
    fn move_plan_collapses_same_artist_keeps_alias_and_suffixes_collisions() {
        let entries = parse_tsv(
            "md5\tsize\tpath\n\
             aaaa\t100\tAnarchy/4-Mat/a.mod\n\
             aaaa\t100\tRebels/4-Mat/a.mod\n\
             bbbb\t50\tOrange/99/x.mod\n\
             bbbb\t50\tdmn/löylynlyömä/x.mod\n\
             cccc\t70\tAnarchy/4-Mat/other.mod\n\
             dddd\t70\tRebels/4-Mat/other.mod\n",
        );
        let plan = plan_moves(&entries);

        // aaaa: same artist (4-Mat) under two groups → collapse to one (100 bytes
        // reclaimed); the survivor moves to 4-Mat/a.mod.
        assert!(plan.moves.iter().any(|m| m.to == "4-Mat/a.mod"));
        assert!(plan.deletes.iter().any(|d| d.md5 == "aaaa"));
        assert_eq!(plan.stats.bytes_reclaimed, 100);
        // bbbb: alias candidate (99 vs löylynlyömä) → both survive under their
        // handles, nothing deleted for bbbb.
        assert!(plan.moves.iter().any(|m| m.to == "99/x.mod"));
        assert!(plan.moves.iter().any(|m| m.to == "löylynlyömä/x.mod"));
        assert!(!plan.deletes.iter().any(|d| d.md5 == "bbbb"));
        // cccc + dddd: distinct tunes both want 4-Mat/other.mod → one suffixed.
        assert!(plan.moves.iter().any(|m| m.to == "4-Mat/other.mod"));
        assert!(plan.moves.iter().any(|m| m.to == "4-Mat/other~2.mod"));
        assert_eq!(plan.stats.collisions, 1);
    }

    #[test]
    fn apply_moves_deletes_and_prunes_empty_dirs() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("Anarchy/4-Mat")).unwrap();
        fs::create_dir_all(root.join("Rebels/4-Mat")).unwrap();
        fs::write(root.join("Anarchy/4-Mat/a.mod"), b"AAAA").unwrap();
        fs::write(root.join("Rebels/4-Mat/a.mod"), b"AAAA").unwrap(); // exact dupe

        let entries = parse_tsv(
            "md5\tsize\tpath\n\
             aaaa\t4\tAnarchy/4-Mat/a.mod\n\
             aaaa\t4\tRebels/4-Mat/a.mod\n",
        );
        let plan = plan_moves(&entries);

        // Dry run touches nothing but reports the intent.
        let dry = apply_plan(root, &plan, false);
        assert_eq!((dry.moved, dry.deleted), (1, 1));
        assert!(root.join("Anarchy/4-Mat/a.mod").exists());

        // Execute: the shorter-path copy (Rebels) is canonical → moves to
        // 4-Mat/a.mod; the Anarchy dupe is deleted; both emptied group dirs prune.
        let rep = apply_plan(root, &plan, true);
        assert_eq!((rep.moved, rep.deleted), (1, 1));
        assert!(rep.errors.is_empty());
        assert!(root.join("4-Mat/a.mod").is_file());
        assert!(!root.join("Anarchy").exists());
        assert!(!root.join("Rebels").exists());

        // Idempotent: a second apply is a clean no-op (sources gone).
        let again = apply_plan(root, &plan, true);
        assert_eq!((again.moved, again.deleted), (0, 0));
        assert_eq!(again.move_skipped_missing, 1);
        assert_eq!(again.delete_skipped_missing, 1);
    }
}

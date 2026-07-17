//! Filesystem scanner. Walks `TRACKER_ROOT`, indexes module files into the
//! `files` table, and reuses cached content hashes when a file's (size, mtime)
//! is unchanged so a rescan doesn't re-read the whole NAS over CIFS.
//!
//! The filesystem is the source of truth, artist-primary: `artist/song.ext`.
//! The first path segment is the artist (a file at the root has none); groups
//! live in the manifest, not the path.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::UNIX_EPOCH;

use rayon::prelude::*;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use walkdir::{DirEntry, WalkDir};

use crate::state::ScanProgress;

/// Module extensions libopenmpt can open. Generous on purpose — the collection
/// has obscure legacy formats; unknown extensions are simply skipped. Lowercase.
pub const MODULE_EXTS: &[&str] = &[
    "mod", "xm", "s3m", "it", "mptm", "stm", "nst", "m15", "stk", "wow", "ult", "669", "mtm",
    "med", "far", "amf", "ams", "dbm", "digi", "dmf", "dsm", "dtm", "fmt", "imf", "j2b", "mdl",
    "mo3", "mt2", "okt", "okta", "plm", "psm", "pt36", "ptm", "sfx", "sfx2", "st26", "stp", "umx",
    "gdm", "gmc", "ice", "itp", "med", "mms", "oct", "tcb", "ftm", "rtm", "c67", "symmod",
];

fn is_junk(name: &str) -> bool {
    name == ".DS_Store"
        || name.starts_with("._")
        || name == ".Trashes"
        || name == ".Spotlight-V100"
        || name == ".AppleDouble"
        || name == ".fseventsd"
        || name == ".DocumentRevisions-V100"
        || name == ".TemporaryItems"
}

/// True if this entry is a hidden/junk directory we should not descend into.
fn is_hidden_dir(e: &DirEntry) -> bool {
    e.depth() > 0 && e.file_type().is_dir() && e.file_name().to_string_lossy().starts_with('.')
}

fn module_ext(name: &str) -> Option<String> {
    let ext = Path::new(name)
        .extension()?
        .to_string_lossy()
        .to_lowercase();
    if MODULE_EXTS.contains(&ext.as_str()) {
        Some(ext)
    } else {
        None
    }
}

/// True if `name` ends in a recognised module extension (used by rename to keep
/// the index consistent — a renamed file must stay a module the scanner indexes).
pub(crate) fn has_module_ext(name: &str) -> bool {
    module_ext(name).is_some()
}

/// Derive (group, artist, filename, ext) from a forward-slash relative path.
/// Shared by the scanner's reasoning and the rename endpoint. `group` is always
/// empty (artist-primary has no path-group — groups live in the manifest); it's
/// carried only so the `files.grp` column keeps a value.
pub(crate) fn derive_fields(rel: &str) -> (String, Option<String>, String, String) {
    let artist = artist_from_path(rel);
    let filename = rel.rsplit('/').next().unwrap_or(rel).to_string();
    let ext = Path::new(&filename)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    (String::new(), artist, filename, ext)
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ScanResult {
    /// Module files present on disk after the scan.
    pub indexed: usize,
    /// Files whose bytes were (re)hashed this scan (new or changed).
    pub hashed: usize,
    /// Stale rows removed (files that disappeared from disk).
    pub removed: usize,
}

#[derive(Clone)]
struct Cached {
    size: i64,
    mtime: i64,
    hash: String,
    /// MD5 (lowercase hex), or None for a row indexed before the md5 column
    /// existed — such a row is re-hashed once to backfill it.
    md5: Option<String>,
}

/// SHA-256 (our canonical key) + MD5 (to match The Mod Archive) in one read
/// pass — hashing dominates a scan over CIFS, so don't read the file twice.
fn hash_file(path: &Path) -> std::io::Result<(String, String)> {
    let mut f = std::fs::File::open(path)?;
    let mut sha = Sha256::new();
    let mut md5 = md5::Context::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
        md5.consume(&buf[..n]);
    }
    Ok((hex::encode(sha.finalize()), format!("{:x}", md5.finalize())))
}

/// SHA-256 + MD5 (both lowercase hex) of an in-memory buffer, using the same
/// algorithms as [`hash_file`]. Used by the Top Favourites sync so a freshly
/// downloaded module gets the exact `content_hash` the scanner will later
/// assign on disk, and an `md5` to dedup against the existing collection.
pub fn hash_bytes(bytes: &[u8]) -> (String, String) {
    let sha = hex::encode(Sha256::digest(bytes));
    let md5 = format!("{:x}", md5::compute(bytes));
    (sha, md5)
}

/// Canonical top-level directory for tracks with no group. Files under it parse
/// as `group == GROUPLESS`; the UI shows that bucket distinctly (pinned last),
/// and the rename endpoint writes here when the group field is left blank.
pub const GROUPLESS: &str = "_groupless";

/// The artist of a module from its forward-slash relative path, artist-primary
/// (`artist/song.ext`): segment[0] is the artist when there's a further segment
/// (the file). Deeper nesting collapses to seg[0]. A file directly at the root
/// (no artist dir) has artist `None`. There is **no path-group** — groups live
/// in the manifest.
fn artist_from_path(rel: &str) -> Option<String> {
    let segs: Vec<&str> = rel.split('/').collect();
    if segs.len() >= 2 {
        segs.first().map(|s| s.to_string())
    } else {
        None
    }
}

/// Walk `root` and reconcile the `files` table. Blocking I/O — call from
/// `tokio::task::spawn_blocking`. Hashes only new/changed files.
pub fn scan_into(
    conn: &mut Connection,
    root: &Path,
    progress: &ScanProgress,
) -> anyhow::Result<ScanResult> {
    progress.processed.store(0, Ordering::Relaxed);
    progress.hashed.store(0, Ordering::Relaxed);
    progress.total.store(0, Ordering::Relaxed);

    // Load the existing index so we can reuse hashes for unchanged files. Its
    // size is a free, instant denominator for the progress bar — exact on a
    // rescan, and 0 on the very first scan (the UI shows a live climbing count
    // until rows exist). Avoids a second full CIFS walk just to count.
    let mut cache: HashMap<String, Cached> = HashMap::new();
    {
        let mut stmt =
            conn.prepare("SELECT rel_path, size, mtime, content_hash, md5 FROM files")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Cached {
                    size: r.get(1)?,
                    mtime: r.get(2)?,
                    hash: r.get(3)?,
                    md5: r.get(4)?,
                },
            ))
        })?;
        for row in rows {
            let (k, v) = row?;
            cache.insert(k, v);
        }
    }
    progress.total.store(cache.len(), Ordering::Relaxed);

    let mut result = ScanResult::default();

    // 1) Walk the tree (WalkDir is inherently sequential) and collect the module
    // files. `file_type()` uses the directory entry's type, so this needs no
    // per-file stat — the expensive stat + hash happens in parallel below.
    let mut cands: Vec<(PathBuf, String, String, String)> = Vec::new();
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden_dir(e));
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(error = %e, "walk error; skipping");
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_junk(&name) {
            continue;
        }
        let Some(ext) = module_ext(&name) else {
            continue;
        };
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel_path = rel.to_string_lossy().replace('\\', "/");
        cands.push((entry.path().to_path_buf(), rel_path, name, ext));
    }

    // 2) Resolve each file's stat + hash in parallel — the network-heavy part over
    // CIFS. Unchanged files (size + mtime match, md5 already backfilled) reuse the
    // cached digests; only new/changed files are read + hashed. Spreading it across
    // rayon threads overlaps the per-file NAS round-trips instead of paying them
    // one after another (a big win on a cold or large-change scan).
    struct Resolved {
        rel_path: String,
        grp: String,
        artist: Option<String>,
        name: String,
        ext: String,
        size: i64,
        mtime: i64,
        hash: String,
        md5: String,
        hashed: bool,
    }
    let resolved: Vec<Resolved> = cands
        .par_iter()
        .filter_map(|(path, rel_path, name, ext)| {
            let meta = match std::fs::metadata(path) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(path = %rel_path, error = %e, "stat failed; skipping");
                    return None;
                }
            };
            let size = meta.len() as i64;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            // Reuse the cached hashes if nothing changed *and* the md5 backfill is
            // already done; otherwise read + hash (computes both digests).
            let (hash, md5, hashed) = match cache.get(rel_path) {
                Some(c) if c.size == size && c.mtime == mtime && c.md5.is_some() => {
                    (c.hash.clone(), c.md5.clone().unwrap(), false)
                }
                _ => match hash_file(path) {
                    Ok((sha, m)) => {
                        progress.hashed.fetch_add(1, Ordering::Relaxed);
                        (sha, m, true)
                    }
                    Err(e) => {
                        tracing::warn!(path = %rel_path, error = %e, "hash failed; skipping");
                        return None;
                    }
                },
            };
            progress.processed.fetch_add(1, Ordering::Relaxed);
            let artist = artist_from_path(rel_path);
            Some(Resolved {
                rel_path: rel_path.clone(),
                grp: String::new(),
                artist,
                name: name.clone(),
                ext: ext.clone(),
                size,
                mtime,
                hash,
                md5,
                hashed,
            })
        })
        .collect();
    result.hashed = resolved.iter().filter(|r| r.hashed).count();

    // 3) Write the index sequentially (SQLite is single-connection): upsert every
    // resolved file, then drop rows for files that no longer exist on disk.
    let tx = conn.transaction()?;
    {
        let mut upsert = tx.prepare(
            "INSERT INTO files (rel_path, grp, artist, filename, ext, size, mtime, content_hash, md5)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(rel_path) DO UPDATE SET
               grp=excluded.grp, artist=excluded.artist, filename=excluded.filename,
               ext=excluded.ext, size=excluded.size, mtime=excluded.mtime,
               content_hash=excluded.content_hash, md5=excluded.md5",
        )?;
        for r in &resolved {
            upsert.execute(rusqlite::params![
                r.rel_path, r.grp, r.artist, r.name, r.ext, r.size, r.mtime, r.hash, r.md5
            ])?;
            result.indexed += 1;
        }
        drop(upsert);

        // Drop rows for files that no longer exist on disk.
        let seen: std::collections::HashSet<&String> =
            resolved.iter().map(|r| &r.rel_path).collect();
        let stale: Vec<String> = cache
            .keys()
            .filter(|k| !seen.contains(k))
            .cloned()
            .collect();
        for rel_path in &stale {
            tx.execute("DELETE FROM files WHERE rel_path = ?1", [rel_path])?;
            result.removed += 1;
        }
    }
    tx.commit()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artist_from_path_derivation() {
        // seg0 is the artist; there is no path-group.
        assert_eq!(artist_from_path("Purple Motion/sundance.xm"), Some("Purple Motion".into()));
        // The unknown-author bucket is just another first segment.
        assert_eq!(artist_from_path("_unknown/ripped.mod"), Some("_unknown".into()));
        // Deeper nesting collapses to seg0.
        assert_eq!(artist_from_path("4-Mat/1993/enigma.mod"), Some("4-Mat".into()));
        // A file at the root has no artist.
        assert_eq!(artist_from_path("loose.mod"), None);
    }

    #[test]
    fn ext_filtering() {
        assert_eq!(module_ext("song.mod").as_deref(), Some("mod"));
        assert_eq!(module_ext("SONG.XM").as_deref(), Some("xm"));
        assert_eq!(module_ext("readme.txt"), None);
        assert_eq!(module_ext("noext"), None);
    }

    #[test]
    fn junk_is_skipped() {
        assert!(is_junk("._song.mod"));
        assert!(is_junk(".DS_Store"));
        assert!(!is_junk("song.mod"));
    }

    #[test]
    fn scans_a_tree_and_reuses_hashes() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("Acme/Coder")).unwrap();
        fs::write(root.join("Acme/Coder/song.mod"), b"MODDATA").unwrap();
        fs::write(root.join("Acme/Coder/._song.mod"), b"junk").unwrap();
        fs::write(root.join("Acme/Coder/readme.txt"), b"nope").unwrap();

        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema_sql()).unwrap();
        let progress = ScanProgress::default();

        let r1 = scan_into(&mut conn, root, &progress).unwrap();
        assert_eq!(r1.indexed, 1, "only the .mod is indexed");
        assert_eq!(r1.hashed, 1);
        // Both digests are computed and stored. MD5 of b"MODDATA".
        let (sha, md5): (String, Option<String>) = conn
            .query_row("SELECT content_hash, md5 FROM files LIMIT 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(sha.len(), 64, "sha-256 hex");
        assert_eq!(
            md5.as_deref(),
            Some(format!("{:x}", md5::compute(b"MODDATA")).as_str())
        );
        // First scan: empty cache → denominator 0 (UI shows a live count).
        assert_eq!(progress.total.load(Ordering::Relaxed), 0);
        assert_eq!(progress.processed.load(Ordering::Relaxed), 1);

        // Second scan with no changes reuses the cached hash; the previous
        // index size (1) is now the denominator.
        let r2 = scan_into(&mut conn, root, &progress).unwrap();
        assert_eq!(r2.indexed, 1);
        assert_eq!(r2.hashed, 0, "unchanged file is not re-hashed");
        assert_eq!(progress.total.load(Ordering::Relaxed), 1);

        // Deleting the file removes the row.
        fs::remove_file(root.join("Acme/Coder/song.mod")).unwrap();
        let r3 = scan_into(&mut conn, root, &progress).unwrap();
        assert_eq!(r3.indexed, 0);
        assert_eq!(r3.removed, 1);
    }
}

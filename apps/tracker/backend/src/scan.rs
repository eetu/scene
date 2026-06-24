//! Filesystem scanner. Walks `TRACKER_ROOT`, indexes module files into the
//! `files` table, and reuses cached content hashes when a file's (size, mtime)
//! is unchanged so a rescan doesn't re-read the whole NAS over CIFS.
//!
//! The filesystem is the source of truth: `group/artist/song.ext`. The first
//! path segment is the group, the second (when present) the artist.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::UNIX_EPOCH;

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
/// Shared by the scanner's reasoning and the rename endpoint.
pub(crate) fn derive_fields(rel: &str) -> (String, Option<String>, String, String) {
    let (grp, artist) = group_artist(rel);
    let filename = rel.rsplit('/').next().unwrap_or(rel).to_string();
    let ext = Path::new(&filename)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    (grp, artist, filename, ext)
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
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Split a relative path (forward-slash separated) into (group, artist).
/// `group/artist/song.ext` → ("group", Some("artist")); `group/song.ext` →
/// ("group", None). Deeper nesting keeps segment[0]/segment[1].
fn group_artist(rel: &str) -> (String, Option<String>) {
    let segs: Vec<&str> = rel.split('/').collect();
    let group = segs.first().copied().unwrap_or("").to_string();
    // Only treat segment[1] as artist if there's a further segment (the file),
    // i.e. the file isn't directly inside the group dir.
    let artist = if segs.len() >= 3 {
        Some(segs[1].to_string())
    } else {
        None
    };
    (group, artist)
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
        let mut stmt = conn.prepare("SELECT rel_path, size, mtime, content_hash FROM files")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Cached {
                    size: r.get(1)?,
                    mtime: r.get(2)?,
                    hash: r.get(3)?,
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
    let tx = conn.transaction()?;
    {
        let mut seen: Vec<String> = Vec::new();
        let mut upsert = tx.prepare(
            "INSERT INTO files (rel_path, grp, artist, filename, ext, size, mtime, content_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(rel_path) DO UPDATE SET
               grp=excluded.grp, artist=excluded.artist, filename=excluded.filename,
               ext=excluded.ext, size=excluded.size, mtime=excluded.mtime,
               content_hash=excluded.content_hash",
        )?;

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
            progress.processed.fetch_add(1, Ordering::Relaxed);
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let rel_path = rel.to_string_lossy().replace('\\', "/");

            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(path = %rel_path, error = %e, "stat failed; skipping");
                    continue;
                }
            };
            let size = meta.len() as i64;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            // Reuse the cached hash if nothing changed; otherwise read + hash.
            let hash = match cache.get(&rel_path) {
                Some(c) if c.size == size && c.mtime == mtime => c.hash.clone(),
                _ => match hash_file(path) {
                    Ok(h) => {
                        result.hashed += 1;
                        progress.hashed.fetch_add(1, Ordering::Relaxed);
                        h
                    }
                    Err(e) => {
                        tracing::warn!(path = %rel_path, error = %e, "hash failed; skipping");
                        continue;
                    }
                },
            };

            let (grp, artist) = group_artist(&rel_path);
            upsert.execute(rusqlite::params![
                rel_path, grp, artist, name, ext, size, mtime, hash
            ])?;
            seen.push(rel_path);
            result.indexed += 1;
        }
        drop(upsert);

        // Drop rows for files that no longer exist on disk.
        let seen_set: std::collections::HashSet<&String> = seen.iter().collect();
        let stale: Vec<String> = cache
            .keys()
            .filter(|k| !seen_set.contains(k))
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
    fn group_artist_layouts() {
        assert_eq!(
            group_artist("Acme/Coder/song.mod"),
            ("Acme".into(), Some("Coder".into()))
        );
        assert_eq!(group_artist("Acme/song.mod"), ("Acme".into(), None));
        assert_eq!(
            group_artist("Acme/Coder/sub/song.mod"),
            ("Acme".into(), Some("Coder".into()))
        );
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

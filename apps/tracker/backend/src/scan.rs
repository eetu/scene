//! Filesystem scanner. Walks a configured root of kind `scan`, indexes module
//! files into the `files` table, and reuses cached content hashes when a file's
//! (size, mtime) is unchanged so a rescan doesn't re-read the whole NAS over
//! CIFS. Each call reconciles exactly one root; other roots are untouched.
//! (An `hvsc` root never comes through here — see `hvsc.rs`.)
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

/// The pool the stat-and-hash pass runs in.
///
/// Rayon's default pool is sized to CPU cores, which suits CPU-bound work. This
/// pass isn't: over a network mount it's dominated by per-file round-trip
/// latency, so throughput follows how many requests are in flight rather than
/// how many cores can run.
///
/// Measured, warm (stat-only) pass over 8,301 modules on the SMB mount:
///
/// ```text
///   1 thread   28.07  25.30  23.88   mean 25.8s
///  16 threads  18.75  19.03  19.06   mean 18.9s
/// ```
///
/// ~1.37×, and far steadier — a 0.3s spread against 4s. Worth saying that a
/// single run of each showed the opposite; the effect only separates from the
/// noise with repeats. 8, 16 and 32 were indistinguishable, so the exact number
/// matters much less than not being 1. The remaining ~19s is serial work this
/// pool can't touch (the directory walk and the SQLite write pass).
///
/// A dedicated pool rather than resizing rayon's global one, which is shared
/// with anything else in the process that uses rayon. `TRACKER_SCAN_THREADS`
/// overrides the default of cores × 4, capped at 32.
fn scan_pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        let threads = std::env::var("TRACKER_SCAN_THREADS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or_else(|| (cores * 4).min(32));
        tracing::info!(threads, cores, "scan thread pool");
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|i| format!("scan-{i}"))
            .build()
            .expect("build scan thread pool")
    })
}

use scene_backend::scan::is_macos_junk as is_junk;
pub use scene_backend::scan::MODULE_EXTS;

/// Every indexed extension: the libopenmpt zoo plus SID, which is decoded by a
/// different engine entirely (see `crate::sid`) but lives in the same index.
fn indexed_ext(ext: &str) -> bool {
    MODULE_EXTS.contains(&ext) || crate::sid::is_sid_ext(ext)
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
    if indexed_ext(&ext) {
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

/// The bytes `hash_file` hands back alongside the digests — enough for any
/// format header we parse server-side (currently SID's 124-byte one).
const HEAD_BYTES: usize = crate::sid::HEADER_LEN;

/// SHA-256 (our canonical key) + MD5 (to match The Mod Archive, and HVSC's
/// Songlengths database) in one read pass — hashing dominates a scan over CIFS,
/// so don't read the file twice. The file's first [`HEAD_BYTES`] come back too,
/// so a header parse costs no second open.
fn hash_file(path: &Path) -> std::io::Result<(String, String, Vec<u8>)> {
    let mut f = std::fs::File::open(path)?;
    let mut sha = Sha256::new();
    let mut md5 = md5::Context::new();
    let mut buf = [0u8; 64 * 1024];
    let mut head = Vec::new();
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if head.len() < HEAD_BYTES {
            let take = (HEAD_BYTES - head.len()).min(n);
            head.extend_from_slice(&buf[..take]);
        }
        sha.update(&buf[..n]);
        md5.consume(&buf[..n]);
    }
    Ok((
        hex::encode(sha.finalize()),
        format!("{:x}", md5.finalize()),
        head,
    ))
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

/// Where a file with no derivable author is filed in the artist-primary tree.
pub const UNKNOWN_ARTIST: &str = "_unknown";

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

/// Walk `root` and reconcile the `files` table rows belonging to `root_id`.
/// Blocking I/O — call from `tokio::task::spawn_blocking`. Hashes only
/// new/changed files. Other roots' rows are left untouched, so scanning one
/// collection never disturbs another.
pub fn scan_into(
    conn: &mut Connection,
    root_id: &str,
    root: &Path,
    progress: &ScanProgress,
) -> anyhow::Result<ScanResult> {
    progress.processed.store(0, Ordering::Relaxed);
    progress.hashed.store(0, Ordering::Relaxed);
    progress.total.store(0, Ordering::Relaxed);

    // Load this root's existing index so we can reuse hashes for unchanged
    // files. Its size is a free, instant denominator for the progress bar —
    // exact on a rescan, and 0 on the very first scan (the UI shows a live
    // climbing count until rows exist). Avoids a second full CIFS walk to count.
    let mut cache: HashMap<String, Cached> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT rel_path, size, mtime, content_hash, md5 FROM files WHERE root_id = ?1",
        )?;
        let rows = stmt.query_map([root_id], |r| {
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
        /// Parsed PSID/RSID header, for the SID files among the candidates.
        sid: Option<crate::sid::SidInfo>,
    }
    // `install` blocks until the pass finishes, so the closure can borrow the
    // candidate list and the hash cache rather than taking ownership.
    let resolved: Vec<Resolved> = scan_pool().install(|| {
        cands
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
                let (hash, md5, hashed, head) = match cache.get(rel_path) {
                    Some(c) if c.size == size && c.mtime == mtime && c.md5.is_some() => {
                        (c.hash.clone(), c.md5.clone().unwrap(), false, Vec::new())
                    }
                    _ => match hash_file(path) {
                        Ok((sha, m, head)) => {
                            progress.hashed.fetch_add(1, Ordering::Relaxed);
                            (sha, m, true, head)
                        }
                        Err(e) => {
                            tracing::warn!(path = %rel_path, error = %e, "hash failed; skipping");
                            return None;
                        }
                    },
                };
                // Parse the SID header off the bytes we just read. Only for a file
                // we actually (re)hashed — an unchanged one already has its rows.
                let sid = (crate::sid::is_sid_ext(ext) && hashed)
                    .then(|| crate::sid::parse(&head))
                    .flatten();
                // A `.sid` without a SID header isn't music. The old sidplay v1
                // "SIDPLAY INFOFILE" is a *text sidecar* — it describes a separate
                // C64 binary (`ADDRESS=`, `SONGS=`, `NAME=`…) and carries no tune
                // data at all, so on its own there is nothing any engine could play.
                // Collections that passed through sidplay1 are littered with them,
                // usually orphaned from the data file they described.
                //
                // Skip rather than index: a row that can only ever fail to play is
                // worse than no row. Decided only when we actually read the header,
                // which is guaranteed for a file that has never been indexed.
                if crate::sid::is_sid_ext(ext) && hashed && sid.is_none() {
                    tracing::info!(
                        path = %rel_path,
                        "skipping .sid with no PSID/RSID header (sidplay info file?)"
                    );
                    return None;
                }
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
                    sid,
                })
            })
            .collect()
    });
    result.hashed = resolved.iter().filter(|r| r.hashed).count();

    // 3) Write the index sequentially (SQLite is single-connection): upsert every
    // resolved file, then drop rows for files that no longer exist on disk.
    let tx = conn.transaction()?;
    {
        // ON CONFLICT targets the (root_id, rel_path) unique index, so an
        // unchanged file keeps its `id` — the API's track id stays stable across
        // rescans, which the client's queue depends on.
        let mut upsert = tx.prepare(
            "INSERT INTO files (root_id, rel_path, grp, artist, filename, ext, size, mtime, content_hash, md5)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(root_id, rel_path) DO UPDATE SET
               grp=excluded.grp, artist=excluded.artist, filename=excluded.filename,
               ext=excluded.ext, size=excluded.size, mtime=excluded.mtime,
               content_hash=excluded.content_hash, md5=excluded.md5",
        )?;
        for r in &resolved {
            upsert.execute(rusqlite::params![
                root_id, r.rel_path, r.grp, r.artist, r.name, r.ext, r.size, r.mtime, r.hash, r.md5
            ])?;
            result.indexed += 1;
        }
        drop(upsert);

        // SID metadata, straight from the header we parsed above. Two tables:
        // `songs` gets one row per subtune (each is its own library entry), and
        // `meta` gets the file-level description so a SID looks like any other
        // track in the listing. Both are keyed by content hash, so this survives
        // the file being moved — and only files we actually (re)hashed have a
        // parsed header, so an unchanged collection rewrites nothing.
        let now = chrono::Utc::now().to_rfc3339();
        let mut song = tx.prepare(
            "INSERT INTO songs (content_hash, subsong, title, author, released)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(content_hash, subsong) DO UPDATE SET
               title=excluded.title, author=excluded.author, released=excluded.released",
        )?;
        let mut smeta = tx.prepare(
            "INSERT INTO meta (content_hash, title, type_long, tracker, channels, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(content_hash) DO UPDATE SET
               title=excluded.title, type_long=excluded.type_long,
               tracker=excluded.tracker, channels=excluded.channels,
               updated_at=excluded.updated_at",
        )?;
        for r in &resolved {
            let Some(s) = &r.sid else { continue };
            for sub in 0..s.songs {
                song.execute(rusqlite::params![
                    r.hash, sub as i64, s.name, s.author, s.released
                ])?;
            }
            // A SID's "tracker" is the machine it was written for — the clock and
            // chip model are what actually decide how it sounds, and they make a
            // useful facet. Voices, not pattern channels: 3 per SID chip.
            let machine = [s.clock.as_str(), s.sid_model.as_str()]
                .into_iter()
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            smeta.execute(rusqlite::params![
                r.hash,
                s.name,
                s.type_long(),
                (!machine.is_empty()).then_some(machine),
                (s.chips as i64) * 3,
                now,
            ])?;
        }
        drop(song);
        drop(smeta);

        // Drop rows for files that no longer exist on disk — this root's only.
        let seen: std::collections::HashSet<&String> =
            resolved.iter().map(|r| &r.rel_path).collect();
        let stale: Vec<String> = cache
            .keys()
            .filter(|k| !seen.contains(k))
            .cloned()
            .collect();
        for rel_path in &stale {
            tx.execute(
                "DELETE FROM files WHERE root_id = ?1 AND rel_path = ?2",
                rusqlite::params![root_id, rel_path],
            )?;
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
        assert_eq!(
            artist_from_path("Purple Motion/sundance.xm"),
            Some("Purple Motion".into())
        );
        // The unknown-author bucket is just another first segment.
        assert_eq!(
            artist_from_path("_unknown/ripped.mod"),
            Some("_unknown".into())
        );
        // Deeper nesting collapses to seg0.
        assert_eq!(
            artist_from_path("4-Mat/1993/enigma.mod"),
            Some("4-Mat".into())
        );
        // A file at the root has no artist.
        assert_eq!(artist_from_path("loose.mod"), None);
    }

    #[test]
    fn ext_filtering() {
        assert_eq!(module_ext("song.mod").as_deref(), Some("mod"));
        assert_eq!(module_ext("SONG.XM").as_deref(), Some("xm"));
        assert_eq!(module_ext("readme.txt"), None);
        assert_eq!(module_ext("noext"), None);
        // SIDs are indexed too, though a different engine decodes them.
        assert_eq!(module_ext("Commando.sid").as_deref(), Some("sid"));
        assert_eq!(module_ext("tune.PSID").as_deref(), Some("psid"));
    }

    #[test]
    fn the_extension_list_has_no_duplicates() {
        // It's hand-maintained and long; a duplicate is harmless but a signal
        // that an entry was added twice rather than checked.
        let mut seen = std::collections::HashSet::new();
        let dupes: Vec<_> = MODULE_EXTS.iter().filter(|e| !seen.insert(**e)).collect();
        assert!(dupes.is_empty(), "duplicate extensions: {dupes:?}");
    }

    #[test]
    fn a_sid_that_is_not_a_sid_tune_is_not_indexed() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("Dr.Voice")).unwrap();
        // A real specimen: sidplay v1's text sidecar, which describes a separate
        // C64 binary and holds no tune data. Orphaned from its data file (as
        // these usually are), there is nothing to play.
        fs::write(
            root.join("Dr.Voice/COMPOMUS.sid"),
            b"SIDPLAY INFOFILE\r\nADDRESS=0,1000,1003\r\nSONGS=1\r\nNAME=Compomusic\r\n",
        )
        .unwrap();
        // A genuine one alongside it, to prove the filter is about content.
        let mut real = vec![0u8; crate::sid::HEADER_LEN];
        real[0..4].copy_from_slice(b"PSID");
        real[4..6].copy_from_slice(&2u16.to_be_bytes());
        real[6..8].copy_from_slice(&0x7C_u16.to_be_bytes());
        real[0x0E..0x10].copy_from_slice(&1u16.to_be_bytes());
        real[0x10..0x12].copy_from_slice(&1u16.to_be_bytes());
        fs::write(root.join("Dr.Voice/real.sid"), &real).unwrap();

        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema_sql()).unwrap();
        let r = scan_into(&mut conn, "mods", root, &ScanProgress::default()).unwrap();
        assert_eq!(r.indexed, 1, "only the real tune is indexed");
        let name: String = conn
            .query_row("SELECT filename FROM files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "real.sid");
    }

    #[test]
    fn scanning_a_sid_writes_a_row_per_subtune_and_its_metadata() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("Hubbard_Rob")).unwrap();

        // A minimal but real 3-subtune PSID v2 header.
        let mut sid = vec![0u8; crate::sid::HEADER_LEN];
        sid[0..4].copy_from_slice(b"PSID");
        sid[4..6].copy_from_slice(&2u16.to_be_bytes());
        sid[6..8].copy_from_slice(&0x7C_u16.to_be_bytes());
        sid[0x0E..0x10].copy_from_slice(&3u16.to_be_bytes());
        sid[0x10..0x12].copy_from_slice(&1u16.to_be_bytes());
        sid[0x16..0x1E].copy_from_slice(b"Commando");
        sid[0x36..0x41].copy_from_slice(b"Rob Hubbard");
        // PAL + MOS6581
        sid[0x76..0x78].copy_from_slice(&((0b01u16 << 2) | (0b01u16 << 4)).to_be_bytes());
        fs::write(root.join("Hubbard_Rob/Commando.sid"), &sid).unwrap();

        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema_sql()).unwrap();
        let progress = ScanProgress::default();
        let r = scan_into(&mut conn, "mods", root, &progress).unwrap();
        assert_eq!(r.indexed, 1, "one file");

        // One `songs` row per subtune — each becomes its own library entry.
        let subs: i64 = conn
            .query_row("SELECT COUNT(*) FROM songs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(subs, 3);

        let (title, author): (String, String) = conn
            .query_row(
                "SELECT title, author FROM songs WHERE subsong = 2",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Commando");
        assert_eq!(author, "Rob Hubbard");

        // File-level metadata, so a SID reads like any other track in the list.
        let (tl, tracker, channels): (String, String, i64) = conn
            .query_row("SELECT type_long, tracker, channels FROM meta", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(tl, "PSID v2");
        assert_eq!(tracker, "PAL MOS6581");
        assert_eq!(channels, 3, "three voices per SID chip");

        // A rescan with nothing changed must not re-parse or duplicate rows.
        let r2 = scan_into(&mut conn, "mods", root, &progress).unwrap();
        assert_eq!(r2.hashed, 0);
        let subs2: i64 = conn
            .query_row("SELECT COUNT(*) FROM songs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(subs2, 3);
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

        let r1 = scan_into(&mut conn, "mods", root, &progress).unwrap();
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
        let r2 = scan_into(&mut conn, "mods", root, &progress).unwrap();
        assert_eq!(r2.indexed, 1);
        assert_eq!(r2.hashed, 0, "unchanged file is not re-hashed");
        assert_eq!(progress.total.load(Ordering::Relaxed), 1);

        // Deleting the file removes the row.
        fs::remove_file(root.join("Acme/Coder/song.mod")).unwrap();
        let r3 = scan_into(&mut conn, "mods", root, &progress).unwrap();
        assert_eq!(r3.indexed, 0);
        assert_eq!(r3.removed, 1);
    }
}

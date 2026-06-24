//! Filesystem scanner. Walks `PARTY_ROOT` (the `Parties/` tree), indexes every
//! file into `files`, groups them into `productions` (one per competition
//! entry) using each party's config, and reconciles the `parties` table. Reuses
//! cached content hashes when a file's (size, mtime) is unchanged.
//!
//! The filesystem is the source of truth. Layout: `Parties/<party>/<category>/
//! <NN - Group - Title>/...`, where `<category>` may be one or two segments
//! (e.g. `demo`, `amiga/demo`) per the party config, and unranked entries live
//! under a `rest/` folder.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use sha2::{Digest, Sha256};
use walkdir::{DirEntry, WalkDir};

use crate::party::{slugify, PartyConfigs};
use crate::state::ScanProgress;

/// Module extensions libopenmpt can open (from tracker). Lowercase.
pub const MODULE_EXTS: &[&str] = &[
    "mod", "xm", "s3m", "it", "mptm", "stm", "nst", "m15", "stk", "wow", "ult", "669", "mtm", "med",
    "far", "amf", "ams", "dbm", "digi", "dmf", "dsm", "dtm", "fmt", "imf", "j2b", "mdl", "mo3",
    "mt2", "okt", "okta", "plm", "psm", "pt36", "ptm", "sfx", "sfx2", "st26", "stp", "umx", "gdm",
    "gmc", "ice", "itp", "mms", "oct", "tcb", "ftm", "rtm", "c67", "symmod",
];

const IMAGE_EXTS: &[&str] = &[
    "lbm", "iff", "ilbm", "ham", "pcx", "tif", "tiff", "gif", "jpg", "jpeg", "png", "tga", "bmp",
];
const VIDEO_EXTS: &[&str] = &["mpg", "mpeg", "avi", "fli", "flc", "mp4", "mov", "webm", "m2v"];
const EXE_EXTS: &[&str] = &["exe", "com", "run", "bat"];
const DISKIMAGE_EXTS: &[&str] = &["d64", "t64", "g64", "prg", "adf", "hdf", "dms"];
const TEXT_EXTS: &[&str] = &[
    "nfo", "diz", "txt", "doc", "me", "1st", "asc", "ans", "faq", "org", "tut",
];
const ARCHIVE_EXTS: &[&str] = &["zip", "lha", "lzh", "arj", "rar", "7z", "gz", "dms"];

/// Classify a file into a `kind` from its extension (and filename for
/// extensionless README/NFO-style files).
pub fn classify(filename: &str, ext: &str) -> &'static str {
    if MODULE_EXTS.contains(&ext) {
        return "music";
    }
    if IMAGE_EXTS.contains(&ext) {
        return "image";
    }
    if VIDEO_EXTS.contains(&ext) {
        return "video";
    }
    if DISKIMAGE_EXTS.contains(&ext) {
        return "diskimage";
    }
    if EXE_EXTS.contains(&ext) {
        return "exe";
    }
    if TEXT_EXTS.contains(&ext) {
        return "text";
    }
    if ARCHIVE_EXTS.contains(&ext) {
        return "archive";
    }
    if ext.is_empty() {
        let up = filename.to_ascii_uppercase();
        if up.contains("README") || up.contains("READ.ME") || up.starts_with("FILE_ID") {
            return "text";
        }
    }
    "data"
}

/// Best-effort MIME for a file, used by the frontend file browser to pick a
/// viewer. Scene-aware (NFO/DIZ → text, ILBM/PCX → image) with an
/// `application/octet-stream` fallback for binaries.
pub fn mime_for(ext: &str, filename: &str) -> &'static str {
    match ext {
        "txt" | "nfo" | "diz" | "asc" | "ans" | "me" | "1st" | "faq" | "org" | "tut" | "doc" => {
            "text/plain"
        }
        "gif" => "image/gif",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "lbm" | "iff" | "ilbm" | "ham" => "image/x-ilbm",
        "pcx" => "image/x-pcx",
        "tga" => "image/x-tga",
        "mpg" | "mpeg" | "m2v" => "video/mpeg",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "fli" | "flc" => "video/x-fli",
        _ if MODULE_EXTS.contains(&ext) => "audio/x-mod",
        "" => {
            let up = filename.to_ascii_uppercase();
            if up.contains("README") || up.contains("READ.ME") || up.starts_with("FILE_ID") {
                "text/plain"
            } else {
                "application/octet-stream"
            }
        }
        _ => "application/octet-stream",
    }
}

/// Sniff whether a file is textual by sampling its head — for scene docs with
/// non-standard extensions (`.AS`, `.ME`, none at all). CP437/ANSI art uses the
/// high bytes (0x80–0xFF) freely, so we can't reject those; instead reject any
/// NUL and bail if too many stray control bytes appear (binaries are riddled
/// with both). Tab/newlines/CR/FF/EOF(0x1A)/ESC(0x1B, ANSI) are allowed.
fn looks_textual(path: &Path) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 8192];
    let n = match f.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    if n == 0 {
        return false;
    }
    let mut suspicious = 0usize;
    for &b in &buf[..n] {
        if b == 0 {
            return false;
        }
        if b < 0x20 && !matches!(b, 0x09 | 0x0A | 0x0C | 0x0D | 0x1A | 0x1B) {
            suspicious += 1;
        }
    }
    suspicious * 100 / n < 5
}

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

fn is_hidden_dir(e: &DirEntry) -> bool {
    if e.depth() == 0 || !e.file_type().is_dir() {
        return false;
    }
    let name = e.file_name().to_string_lossy();
    if !name.starts_with('.') {
        return false;
    }
    // A `.support` dir nested inside a party (depth >= 2 — i.e. within a
    // production folder) is scanned: it holds our own additions, like a
    // custom-packaged Amiga disk image, kept separate from the scraped
    // originals. The shared root `<PARTY_ROOT>/.support` (depth 1, holding BIOS
    // ROMs) stays skipped, as do all other dot-dirs.
    !(name == ".support" && e.depth() >= 2)
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
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

/// Stable production id from its relative directory (path under PARTY_ROOT).
fn prod_id(rel_dir: &str) -> String {
    hex::encode(Sha256::digest(rel_dir.as_bytes()))[..16].to_string()
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ScanResult {
    pub indexed: usize,
    pub hashed: usize,
    pub removed: usize,
    pub productions: usize,
    pub parties: usize,
}

#[derive(Clone)]
struct Cached {
    size: i64,
    mtime: i64,
    hash: String,
}

/// A file as walked, with everything needed to index it and assign it to a
/// production.
struct Walked {
    rel_path: String,
    party_slug: String,
    party_dir: String,
    category: String,
    prod_dir: Option<String>,
    entry_name: Option<String>,
    is_file_entry: bool,
    filename: String,
    ext: String,
    kind: &'static str,
    size: i64,
    mtime: i64,
    hash: String,
}

/// Parse a `NN - Group - Title` entry name into (rank, group, title). Handles:
/// title-only (`Bit`), rank-only (`09 - Bit`), and group flattened with `-`
/// (`Barti!-Nooon`). `strip_ext` removes a trailing extension first (single-file
/// entries like `01 - X - Y.lbm`).
pub fn parse_entry(name: &str, strip_ext: bool) -> (Option<i64>, Option<String>, Option<String>) {
    let mut base = name.to_string();
    if strip_ext {
        if let Some(stem) = Path::new(name).file_stem() {
            base = stem.to_string_lossy().to_string();
        }
    }
    let base = base.trim();

    // Leading "NN - " (or "NN-") is the rank.
    let (rank, rest) = match base.find('-') {
        Some(dash) => {
            let head = base[..dash].trim();
            if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) {
                (head.parse::<i64>().ok(), base[dash + 1..].trim())
            } else {
                (None, base)
            }
        }
        None => (None, base),
    };

    if rest.is_empty() {
        return (rank, None, None);
    }
    // Split remaining on " - " → group + title (title keeps any further " - ").
    match rest.split_once(" - ") {
        Some((g, t)) => (
            rank,
            Some(g.trim().to_string()),
            Some(t.trim().to_string()),
        ),
        None => (rank, None, Some(rest.to_string())),
    }
}

fn humanize(category: &str) -> String {
    category
        .split(['/', '_', '-'])
        .filter(|s| !s.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Platform implied by a primary file's extension — the most reliable signal
/// for productions in unconfigured folders (e.g. a C64 `.d64` under `info/`).
fn platform_from_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "d64" | "t64" | "g64" | "prg" | "d71" | "d81" | "crt" => Some("c64"),
        "adf" | "hdf" | "adz" => Some("amiga"),
        "exe" | "com" => Some("pc"),
        _ => None,
    }
}

fn platform_heuristic(category: &str) -> &'static str {
    if category.starts_with("amiga") {
        "amiga"
    } else if category.starts_with("c64") {
        "c64"
    } else if category.starts_with("anim") {
        "video"
    } else {
        "pc"
    }
}

fn medium_from_kind(kind: &str) -> &'static str {
    match kind {
        "music" => "music",
        "image" => "graphics",
        "video" => "animation",
        "exe" | "diskimage" => "demo",
        _ => "info",
    }
}

/// A production's files as (rel_path, kind, ext, size).
type ProdFile = (String, &'static str, String, i64);

/// Pick the main playable file for a production given its platform and an
/// optional medium hint from config.
fn pick_primary<'a>(
    files: &'a [ProdFile],
    platform: &str,
    medium_hint: Option<&str>,
) -> Option<&'a ProdFile> {
    let largest_of = |k: &str| {
        files
            .iter()
            .filter(|f| f.1 == k)
            .max_by_key(|f| f.3)
    };
    // Runnable: ext groups in priority order per platform.
    let runnable = || -> Option<&ProdFile> {
        let groups: &[&[&str]] = match platform {
            "amiga" => &[&["adf", "hdf"], &["run"], &["exe"]],
            "c64" => &[&["d64", "t64", "g64"], &["prg"]],
            _ => &[&["exe", "com"], &["bat"], &["d64", "adf"]],
        };
        for grp in groups {
            if let Some(f) = files
                .iter()
                .filter(|f| grp.contains(&f.2.as_str()))
                .max_by_key(|f| f.3)
            {
                return Some(f);
            }
        }
        None
    };

    match medium_hint {
        Some("music") => largest_of("music"),
        Some("graphics") => largest_of("image"),
        Some("animation") => largest_of("video"),
        Some("demo") | Some("intro") => runnable()
            .or_else(|| largest_of("diskimage"))
            .or_else(|| largest_of("exe")),
        _ => runnable()
            .or_else(|| largest_of("diskimage"))
            .or_else(|| largest_of("music"))
            .or_else(|| largest_of("image"))
            .or_else(|| largest_of("video"))
            .or_else(|| files.iter().max_by_key(|f| f.3)),
    }
}

/// Walk `root` and reconcile the DB. Blocking I/O — call from
/// `tokio::task::spawn_blocking`.
pub fn scan_into(
    conn: &mut Connection,
    root: &Path,
    configs: &PartyConfigs,
    progress: &ScanProgress,
) -> anyhow::Result<ScanResult> {
    progress.processed.store(0, Ordering::Relaxed);
    progress.hashed.store(0, Ordering::Relaxed);
    progress.total.store(0, Ordering::Relaxed);

    // Reuse cached hashes for unchanged files.
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

    // 1) Walk and collect.
    let mut walked: Vec<Walked> = Vec::new();
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
        let path = entry.path();
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel_path = rel.to_string_lossy().replace('\\', "/");
        let segs: Vec<&str> = rel_path.split('/').collect();
        if segs.len() < 2 {
            // File directly under PARTY_ROOT (not inside any party) — skip.
            continue;
        }
        progress.processed.fetch_add(1, Ordering::Relaxed);

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

        let hash = match cache.get(&rel_path) {
            Some(c) if c.size == size && c.mtime == mtime => c.hash.clone(),
            _ => match hash_file(path) {
                Ok(h) => {
                    progress.hashed.fetch_add(1, Ordering::Relaxed);
                    h
                }
                Err(e) => {
                    tracing::warn!(path = %rel_path, error = %e, "hash failed; skipping");
                    continue;
                }
            },
        };

        let party_dir = segs[0].to_string();
        let party_slug = slugify(&party_dir);
        let cfg = configs.for_dir(&party_dir);
        let within = &segs[1..];
        let ext = ext_of(&name);
        // Extension-based first; for unknown ("data") files, sniff the content so
        // oddly-named scene docs (.AS, .ME, …) still render as text.
        let kind = match classify(&name, &ext) {
            "data" if looks_textual(path) => "text",
            k => k,
        };

        // Determine category (1 or 2 segments) and the production this file
        // belongs to.
        let (category, prod_dir, entry_name, is_file_entry) =
            decompose(&party_dir, within, &cfg);

        walked.push(Walked {
            rel_path,
            party_slug,
            party_dir,
            category,
            prod_dir,
            entry_name,
            is_file_entry,
            filename: name,
            ext,
            kind,
            size,
            mtime,
            hash,
        });
    }

    // 2) Group files into productions.
    struct Accum {
        party_slug: String,
        party_dir: String,
        category: String,
        entry_name: String,
        is_file_entry: bool,
        files: Vec<ProdFile>,
    }
    let mut prods: HashMap<String, Accum> = HashMap::new();
    for w in &walked {
        let (Some(prod_dir), Some(entry_name)) = (&w.prod_dir, &w.entry_name) else {
            continue;
        };
        let acc = prods.entry(prod_dir.clone()).or_insert_with(|| Accum {
            party_slug: w.party_slug.clone(),
            party_dir: w.party_dir.clone(),
            category: w.category.clone(),
            entry_name: entry_name.clone(),
            is_file_entry: w.is_file_entry,
            files: Vec::new(),
        });
        acc.files
            .push((w.rel_path.clone(), w.kind, w.ext.clone(), w.size));
    }

    let mut result = ScanResult::default();
    let tx = conn.transaction()?;
    {
        // --- parties ---
        let mut seen_parties: Vec<String> = Vec::new();
        {
            let mut party_dirs: HashMap<String, String> = HashMap::new();
            for w in &walked {
                party_dirs.insert(w.party_slug.clone(), w.party_dir.clone());
            }
            let mut up = tx.prepare(
                "INSERT INTO parties (slug, dir, name, year, location, organizer, logo_rel)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(slug) DO UPDATE SET
                   dir=excluded.dir, name=excluded.name, year=excluded.year,
                   location=excluded.location, organizer=excluded.organizer,
                   logo_rel=excluded.logo_rel",
            )?;
            for (slug, dir) in &party_dirs {
                let cfg = configs.for_dir(dir);
                let logo_rel = cfg.logo.as_ref().map(|l| format!("{dir}/{l}"));
                up.execute(rusqlite::params![
                    slug,
                    dir,
                    cfg.name,
                    cfg.year,
                    cfg.location,
                    cfg.organizer,
                    logo_rel,
                ])?;
                seen_parties.push(slug.clone());
            }
        }
        result.parties = seen_parties.len();

        // --- productions ---
        let mut seen_prods: Vec<String> = Vec::new();
        let mut prod_id_by_dir: HashMap<String, String> = HashMap::new();
        {
            let mut up = tx.prepare(
                "INSERT INTO productions
                   (id, party_slug, rel_dir, category, compo, platform, medium,
                    rank, grp, title, points, primary_rel, primary_kind)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                   party_slug=excluded.party_slug, rel_dir=excluded.rel_dir,
                   category=excluded.category, compo=excluded.compo,
                   platform=excluded.platform, medium=excluded.medium,
                   rank=excluded.rank, grp=excluded.grp, title=excluded.title,
                   primary_rel=excluded.primary_rel, primary_kind=excluded.primary_kind",
            )?;
            for (rel_dir, acc) in &prods {
                let cfg = configs.for_dir(&acc.party_dir);
                let cat_cfg = cfg.category(&acc.category);
                let medium_hint = cat_cfg.map(|c| c.medium.as_str());
                // Provisional platform (config or folder heuristic) just to steer
                // primary-file selection; refined below from the primary's ext.
                let provisional = cat_cfg
                    .map(|c| c.platform.as_str())
                    .unwrap_or_else(|| platform_heuristic(&acc.category))
                    .to_string();
                let primary = pick_primary(&acc.files, &provisional, medium_hint);
                let (primary_rel, primary_kind, primary_ext) = match primary {
                    Some((rel, kind, ext, _)) => (Some(rel.clone()), Some(*kind), Some(ext.clone())),
                    None => (None, None, None),
                };
                // Final platform: explicit config wins; else the primary file's
                // extension (a .d64 is C64 even when it sits under info/); else the
                // folder heuristic.
                let platform = cat_cfg
                    .map(|c| c.platform.clone())
                    .or_else(|| primary_ext.as_deref().and_then(platform_from_ext).map(str::to_string))
                    .unwrap_or(provisional);
                let medium = match medium_hint {
                    Some(m) => m.to_string(),
                    None => medium_from_kind(primary_kind.unwrap_or("data")).to_string(),
                };
                let compo = cat_cfg
                    .map(|c| c.compo.clone())
                    .unwrap_or_else(|| humanize(&acc.category));
                let (rank, grp, title) = parse_entry(&acc.entry_name, acc.is_file_entry);

                let id = prod_id(rel_dir);
                up.execute(rusqlite::params![
                    id,
                    acc.party_slug,
                    rel_dir,
                    acc.category,
                    compo,
                    platform,
                    medium,
                    rank,
                    grp,
                    title,
                    primary_rel,
                    primary_kind,
                ])?;
                prod_id_by_dir.insert(rel_dir.clone(), id.clone());
                seen_prods.push(id);
            }
        }
        result.productions = seen_prods.len();

        // --- files ---
        let mut seen_files: Vec<String> = Vec::new();
        {
            let mut up = tx.prepare(
                "INSERT INTO files
                   (rel_path, party_slug, prod_id, category, filename, ext, kind, size, mtime, content_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(rel_path) DO UPDATE SET
                   party_slug=excluded.party_slug, prod_id=excluded.prod_id,
                   category=excluded.category, filename=excluded.filename,
                   ext=excluded.ext, kind=excluded.kind, size=excluded.size,
                   mtime=excluded.mtime, content_hash=excluded.content_hash",
            )?;
            for w in &walked {
                let pid = w
                    .prod_dir
                    .as_ref()
                    .and_then(|d| prod_id_by_dir.get(d))
                    .cloned();
                up.execute(rusqlite::params![
                    w.rel_path,
                    w.party_slug,
                    pid,
                    w.category,
                    w.filename,
                    w.ext,
                    w.kind,
                    w.size,
                    w.mtime,
                    w.hash,
                ])?;
                seen_files.push(w.rel_path.clone());
                result.indexed += 1;
            }
        }
        result.hashed = progress.hashed.load(Ordering::Relaxed);

        // --- drop stale rows ---
        let seen_files_set: std::collections::HashSet<&String> = seen_files.iter().collect();
        let stale_files: Vec<String> = cache
            .keys()
            .filter(|k| !seen_files_set.contains(k))
            .cloned()
            .collect();
        for rel_path in &stale_files {
            tx.execute("DELETE FROM files WHERE rel_path = ?1", [rel_path])?;
            result.removed += 1;
        }
        // Productions / parties no longer present.
        {
            let seen_p: std::collections::HashSet<&String> = seen_prods.iter().collect();
            let existing: Vec<String> = {
                let mut stmt = tx.prepare("SELECT id FROM productions")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for id in existing.iter().filter(|id| !seen_p.contains(id)) {
                tx.execute("DELETE FROM productions WHERE id = ?1", [id])?;
            }
        }
        {
            let seen_s: std::collections::HashSet<&String> = seen_parties.iter().collect();
            let existing: Vec<String> = {
                let mut stmt = tx.prepare("SELECT slug FROM parties")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for slug in existing.iter().filter(|s| !seen_s.contains(s)) {
                tx.execute("DELETE FROM parties WHERE slug = ?1", [slug])?;
            }
        }

        // --- party counts ---
        tx.execute(
            "UPDATE parties SET
               n_files = (SELECT COUNT(*) FROM files f WHERE f.party_slug = parties.slug),
               n_productions = (SELECT COUNT(*) FROM productions p WHERE p.party_slug = parties.slug)",
            [],
        )?;
    }
    tx.commit()?;

    // 3) Join results.txt points per party (best-effort).
    let party_dirs: HashMap<String, String> = walked
        .iter()
        .map(|w| (w.party_slug.clone(), w.party_dir.clone()))
        .collect();
    for (slug, dir) in &party_dirs {
        let cfg = configs.for_dir(dir);
        if let Err(e) = crate::results::apply(conn, root, slug, dir, &cfg) {
            tracing::warn!(party = %slug, error = %e, "results join failed");
        }
    }

    Ok(result)
}

/// Decompose a file's path within a party into (category, production dir, entry
/// name, is-single-file-entry). `within` is the path segments under the party
/// folder. Returns `prod_dir`/`entry_name` = None for files not inside a
/// recognisable competition entry.
fn decompose(
    party_dir: &str,
    within: &[&str],
    cfg: &crate::party::PartyCfg,
) -> (String, Option<String>, Option<String>, bool) {
    if within.is_empty() {
        return (String::new(), None, None, false);
    }
    let seg0 = within[0];
    let depth = if within.len() >= 2 && cfg.is_two_level(seg0) {
        2
    } else {
        1
    };
    let category = within[..depth].join("/");
    let rest = &within[depth..];

    // tail = the path under the category that identifies the production;
    // entry_name = the leaf segment to parse for rank/group/title.
    let (tail, entry_name, is_file_entry) = if rest.is_empty() {
        // File directly inside the category folder is its own production.
        return (
            category.clone(),
            Some(format!("{party_dir}/{category}")),
            None,
            false,
        );
    } else if rest[0].eq_ignore_ascii_case("rest") {
        if rest.len() >= 2 {
            // rest/<entry>; entry is a file iff it's the leaf (len == 2).
            (
                format!("rest/{}", rest[1]),
                rest[1].to_string(),
                rest.len() == 2,
            )
        } else {
            return (category, None, None, false);
        }
    } else {
        // <entry>; entry is a file iff it's the leaf (len == 1).
        (rest[0].to_string(), rest[0].to_string(), rest.len() == 1)
    };

    let prod_dir = format!("{party_dir}/{category}/{tail}");
    (category, Some(prod_dir), Some(entry_name), is_file_entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_text_vs_binary() {
        let dir = tempfile::tempdir().unwrap();
        // CP437 text with a high byte (0x86 = å) and CRLF — like ONLINE.AS.
        let txt = dir.path().join("ONLINE.AS");
        std::fs::write(&txt, b"Online party diary \x86\r\n--- day 1 ---\r\n").unwrap();
        assert!(looks_textual(&txt));
        // Binary with NUL bytes is rejected.
        let bin = dir.path().join("DEMO.DAT");
        std::fs::write(&bin, [0u8, 1, 2, 0, 255, 7, 0, 9]).unwrap();
        assert!(!looks_textual(&bin));
    }

    #[test]
    fn classify_by_ext() {
        assert_eq!(classify("song.mod", "mod"), "music");
        assert_eq!(classify("PIC.LBM", "lbm"), "image");
        assert_eq!(classify("flow.mpg", "mpg"), "video");
        assert_eq!(classify("DEMO.EXE", "exe"), "exe");
        assert_eq!(classify("disk.d64", "d64"), "diskimage");
        assert_eq!(classify("info.nfo", "nfo"), "text");
        assert_eq!(classify("README", ""), "text");
        assert_eq!(classify("BOOTY.DAT", "dat"), "data");
    }

    #[test]
    fn parse_entry_layouts() {
        assert_eq!(
            parse_entry("01 - Nooon - Stars - Wonders of the world", false),
            (Some(1), Some("Nooon".into()), Some("Stars - Wonders of the world".into()))
        );
        assert_eq!(
            parse_entry("09 - Bit", false),
            (Some(9), None, Some("Bit".into()))
        );
        assert_eq!(
            parse_entry("02 - Barti!-Nooon - Heaven", false),
            (Some(2), Some("Barti!-Nooon".into()), Some("Heaven".into()))
        );
        assert_eq!(
            parse_entry("Television", false),
            (None, None, Some("Television".into()))
        );
        // single-file entry: strip extension
        assert_eq!(
            parse_entry("01 - Visualize - Fiction.lbm", true),
            (Some(1), Some("Visualize".into()), Some("Fiction".into()))
        );
    }

    #[test]
    fn decompose_layouts() {
        let mut cfg = crate::party::PartyCfg::default_for("Assembly95");
        cfg.categories.insert(
            "amiga/demo".into(),
            crate::party::CategoryCfg {
                compo: "Amiga demo".into(),
                platform: "amiga".into(),
                medium: "demo".into(),
                results_title: None,
            },
        );

        // PC demo, file inside ranked entry folder + subfolder.
        let (cat, dir, name, is_file) =
            decompose("Assembly95", &["demo", "01 - Nooon - Stars", "stars", "STARS.EXE"], &cfg);
        assert_eq!(cat, "demo");
        assert_eq!(dir.as_deref(), Some("Assembly95/demo/01 - Nooon - Stars"));
        assert_eq!(name.as_deref(), Some("01 - Nooon - Stars"));
        assert!(!is_file);

        // Two-level category (amiga/demo).
        let (cat, dir, _, _) =
            decompose("Assembly95", &["amiga", "demo", "01 - Parallax - ZIF", "x.run"], &cfg);
        assert_eq!(cat, "amiga/demo");
        assert_eq!(dir.as_deref(), Some("Assembly95/amiga/demo/01 - Parallax - ZIF"));

        // rest/ entry (single file).
        let (_, dir, name, is_file) =
            decompose("Assembly95", &["mmul", "rest", "tune.s3m"], &cfg);
        assert_eq!(dir.as_deref(), Some("Assembly95/mmul/rest/tune.s3m"));
        assert_eq!(name.as_deref(), Some("tune.s3m"));
        assert!(is_file);

        // A custom disk image under a production's .support/ maps to that
        // production (so it becomes the primary), not a separate entry.
        let (cat, dir, name, _) = decompose(
            "Assembly95",
            &["amiga", "demo", "01 - Parallax - ZIF", ".support", "ZIF (AGA).hdf"],
            &cfg,
        );
        assert_eq!(cat, "amiga/demo");
        assert_eq!(dir.as_deref(), Some("Assembly95/amiga/demo/01 - Parallax - ZIF"));
        assert_eq!(name.as_deref(), Some("01 - Parallax - ZIF"));
    }
}

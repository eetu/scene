//! The High Voltage SID Collection as a read-only, self-describing source.
//!
//! HVSC ships its own complete index, so this never walks the tree: one 5 MB
//! read of `DOCUMENTS/Songlengths.md5` yields every tune's path, content MD5 and
//! per-subtune length — 61,157 files / 87,868 subtunes for HVSC #85, in seconds
//! rather than the minutes a stat-and-hash pass would take over a network mount.
//!
//! **The package is never modified.** Everything we learn about it lives in the
//! SQLite cache; the tree is only ever read. That also means an HVSC root can be
//! a read-only mount, or a container image mounted read-only.
//!
//! Format of the database (per `Songlengths.faq`, "the new format"):
//!
//! ```text
//! [Database]
//! ; /DEMOS/0-9/12th_Sector_Music.sid
//! c7c299ce06ec5ccffb2261fb11b42a73=4:33.108
//! ```
//!
//! The hash is MD5 over the **full file content including the header** — the
//! same digest `scan::hash_file` computes — and the count of whitespace-
//! separated lengths on each line *is* the subtune count.

use std::path::Path;

/// Where HVSC keeps the files we read. Relative to the root, which is the
/// `C64Music` directory of an unpacked release.
const SONGLENGTHS: &str = "DOCUMENTS/Songlengths.md5";
const VERSION_DOC: &str = "DOCUMENTS/HVSC.txt";
const STIL_DOC: &str = "DOCUMENTS/STIL.txt";

/// One tune as the database describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// Path relative to the HVSC root, without a leading slash.
    pub rel_path: String,
    /// MD5 of the whole file — the join key, and our `content_hash` for these
    /// rows (see `index_into`).
    pub md5: String,
    /// One length per subtune, in seconds. Never empty.
    pub lengths: Vec<f64>,
}

/// `M:SS(.mmm)` → seconds. Returns None for anything that isn't a duration, so
/// a malformed line degrades to "no length" instead of poisoning the index.
fn parse_length(s: &str) -> Option<f64> {
    let (m, rest) = s.split_once(':')?;
    let mins: f64 = m.trim().parse().ok()?;
    let secs: f64 = rest.trim().parse().ok()?;
    if !mins.is_finite() || !secs.is_finite() || mins < 0.0 || secs < 0.0 {
        return None;
    }
    Some(mins * 60.0 + secs)
}

/// Parse the songlengths database.
///
/// Entries are `; <path>` followed by `<md5>=<len> <len> …`. A path with no
/// following hash line (or vice versa) is skipped rather than guessed at.
pub fn parse_songlengths(text: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    for line in text.lines() {
        let line = line.trim_end();
        if let Some(p) = line.strip_prefix(';') {
            // Paths are absolute within the collection (`/DEMOS/…`); store them
            // relative, matching how `files.rel_path` works everywhere else.
            path = Some(p.trim().trim_start_matches('/').to_string());
            continue;
        }
        let Some((md5, lens)) = line.split_once('=') else {
            continue; // "[Database]", blank lines, comments
        };
        let md5 = md5.trim();
        if md5.len() != 32 || !md5.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let Some(rel_path) = path.take() else {
            continue;
        };
        let lengths: Vec<f64> = lens.split_whitespace().filter_map(parse_length).collect();
        if lengths.is_empty() {
            continue;
        }
        out.push(Entry {
            rel_path,
            md5: md5.to_ascii_lowercase(),
            lengths,
        });
    }
    out
}

/// The release version, e.g. `85`, read from `DOCUMENTS/HVSC.txt`.
///
/// Used to label the collection and to detect that a new release was mounted.
/// Best-effort: an unrecognised or missing document simply means "unknown", not
/// a failure — the index is built from Songlengths either way.
///
/// HVSC #85 announces itself as `Release 85` in its banner. A bare `#` search
/// is deliberately *not* used as a general fallback: the same document contains
/// "Tunes #1 and #2", "(Update #31)" and similar prose, so it would happily
/// report a version of 1.
pub fn parse_version(text: &str) -> Option<u32> {
    let num_after = |line: &str, kw: &str| -> Option<u32> {
        let lower = line.to_ascii_lowercase();
        let i = lower.find(kw)? + kw.len();
        let digits: String = line[i..]
            .trim_start()
            .trim_start_matches('#')
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        digits.parse().ok()
    };
    // Only the banner, so later prose can't be mistaken for a version.
    for line in text.lines().take(40) {
        if let Some(v) = num_after(line, "release") {
            return Some(v);
        }
        if let Some(v) = num_after(line, "hvsc #") {
            return Some(v);
        }
    }
    None
}

/// One STIL record: what HVSC's curators wrote about a tune, or about one of
/// its subtunes.
///
/// `TITLE`/`ARTIST` are **cover-song credits** — the original this tune is a
/// version of — not the tune's own title and author (that's `NAME`/`AUTHOR`).
/// Conflating them would rewrite half the library's titles with the names of
/// 80s pop songs, so they stay in their own columns and their own display.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StilRecord {
    pub rel_path: String,
    /// The subtune this applies to, 0-based to match `songs.subsong`. `-1` is
    /// the file-scope record, which applies to every subtune.
    pub subsong: i64,
    pub comment: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub name: Option<String>,
    pub author: Option<String>,
}

impl StilRecord {
    fn is_empty(&self) -> bool {
        self.comment.is_none()
            && self.title.is_none()
            && self.artist.is_none()
            && self.name.is_none()
            && self.author.is_none()
    }

    fn slot(&mut self, field: &str) -> &mut Option<String> {
        match field {
            "COMMENT" => &mut self.comment,
            "TITLE" => &mut self.title,
            "ARTIST" => &mut self.artist,
            "NAME" => &mut self.name,
            _ => &mut self.author,
        }
    }
}

/// The fields worth keeping. Anything else STIL grows later is ignored rather
/// than stored blind.
const STIL_FIELDS: [&str; 5] = ["COMMENT", "TITLE", "ARTIST", "NAME", "AUTHOR"];

/// Is this a field line, and which field?
///
/// STIL right-aligns field names in a 7-column gutter (`COMMENT: `, ` ARTIST: `,
/// `   NAME: `), which is what separates a real field from prose inside a
/// comment — the collection contains lines like `Q: …` and `BTW: …` that would
/// otherwise parse as fields and truncate the comment they belong to.
fn stil_field(line: &str) -> Option<(&'static str, &str)> {
    let head = line.get(..7)?;
    let rest = line.get(7..)?.strip_prefix(':')?;
    // Right-aligned in the gutter: leading padding only, never trailing.
    let name = head.trim_start();
    if !head.ends_with(name) {
        return None;
    }
    let field = STIL_FIELDS.iter().find(|f| **f == name)?;
    Some((field, rest.trim()))
}

/// Parse `DOCUMENTS/STIL.txt`.
///
/// ```text
/// /DEMOS/A-F/Bugle_Boy_BASIC.sid
/// COMMENT: All subtunes start after 7 seconds.
/// (#1)
///   TITLE: First Call
///  ARTIST: Military Traditional
/// ```
///
/// Continuation lines are indented to exactly 9 columns, under the value. Entry
/// paths that name a directory (they end in `/`) are per-artist notes with no
/// tune to attach to, so they're skipped.
pub fn parse_stil(text: &str) -> Vec<StilRecord> {
    let mut out: Vec<StilRecord> = Vec::new();
    let mut cur: Option<StilRecord> = None;
    let mut open: Option<&'static str> = None;

    fn flush(out: &mut Vec<StilRecord>, cur: &mut Option<StilRecord>) {
        if let Some(r) = cur.take() {
            if !r.is_empty() {
                out.push(r);
            }
        }
    }

    for raw in text.lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            // A blank line always ends an entry: verified against #85, no
            // continuation line in the collection is ever preceded by one.
            flush(&mut out, &mut cur);
            open = None;
            continue;
        }
        if line.starts_with('#') {
            continue; // banner and `### /DEMOS/ ###` section rules
        }
        if let Some(p) = line.strip_prefix('/') {
            flush(&mut out, &mut cur);
            open = None;
            if !p.ends_with('/') {
                cur = Some(StilRecord {
                    rel_path: p.to_string(),
                    subsong: -1,
                    ..Default::default()
                });
            }
            continue;
        }
        // `(#3)` opens a subtune section within the current entry. STIL numbers
        // subtunes from 1; `songs.subsong` counts from 0.
        if let Some(n) = line
            .strip_prefix("(#")
            .and_then(|s| s.strip_suffix(')'))
            .and_then(|s| s.trim().parse::<i64>().ok())
        {
            let Some(prev) = cur.as_ref() else { continue };
            let path = prev.rel_path.clone();
            flush(&mut out, &mut cur);
            open = None;
            cur = Some(StilRecord {
                rel_path: path,
                subsong: n - 1,
                ..Default::default()
            });
            continue;
        }
        let Some(rec) = cur.as_mut() else { continue };
        if let Some((field, value)) = stil_field(line) {
            open = Some(field);
            let slot = rec.slot(field);
            // A repeated field within one record (STIL does this for multi-part
            // comments) appends rather than replaces, so nothing is lost.
            match slot {
                Some(existing) => {
                    existing.push(' ');
                    existing.push_str(value);
                }
                None => *slot = Some(value.to_string()),
            }
        } else if let (Some(field), Some(text)) = (open, line.strip_prefix("         ")) {
            if let Some(existing) = rec.slot(field) {
                existing.push(' ');
                existing.push_str(text.trim());
            }
        }
    }
    flush(&mut out, &mut cur);
    out
}

/// Read and parse STIL for `root`. Absent is normal — it's an optional document
/// and every caller degrades to "no notes".
pub fn read_stil(root: &Path) -> Vec<StilRecord> {
    read_text(&root.join(STIL_DOC))
        .map(|t| parse_stil(&t))
        .unwrap_or_default()
}

/// What a root looks like on disk right now — enough to tell whether the
/// indexed state is still current without reading the 5 MB database again.
#[derive(Debug, Clone, PartialEq)]
pub struct Stamp {
    pub size: i64,
    pub mtime: i64,
    pub version: Option<u32>,
}

/// Read a file HVSC ships as text.
///
/// **Not** `read_to_string`: these documents are Latin-1, not UTF-8 (member
/// names like "Inge Høie Pedersen" carry high bytes), so the strict decoder
/// fails on the whole file — which silently cost us the version number until a
/// test ran against a real release. Lossy is right here: we're scanning for
/// ASCII markers, and a replacement char in a name we never read is harmless.
fn read_text(path: &Path) -> std::io::Result<String> {
    Ok(String::from_utf8_lossy(&std::fs::read(path)?).into_owned())
}

/// Stat the songlengths database (and read the version doc). Cheap — one stat
/// plus a small read — so it's safe to run at every boot.
pub fn stamp(root: &Path) -> std::io::Result<Stamp> {
    let meta = std::fs::metadata(root.join(SONGLENGTHS))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let version = read_text(&root.join(VERSION_DOC))
        .ok()
        .and_then(|t| parse_version(&t));
    Ok(Stamp {
        size: meta.len() as i64,
        mtime,
        version,
    })
}

/// Read and parse the songlengths database for `root`.
pub fn read_entries(root: &Path) -> std::io::Result<Vec<Entry>> {
    Ok(parse_songlengths(&read_text(&root.join(SONGLENGTHS))?))
}

/// True if `root` looks like an unpacked HVSC release.
pub fn looks_like_hvsc(root: &Path) -> bool {
    root.join(SONGLENGTHS).is_file()
}

/// The artist of an HVSC tune, from its path.
///
/// `MUSICIANS/<letter>/<Artist>/tune.sid` names the composer directly, which is
/// the whole point of that layout. `DEMOS/` and `GAMES/` don't — their first
/// segment is a category, so they have no path artist and fall back to the PSID
/// header's author (filled in later by the lazy backfill).
pub fn artist_from_path(rel: &str) -> Option<String> {
    let segs: Vec<&str> = rel.split('/').collect();
    if segs.first() == Some(&"MUSICIANS") && segs.len() >= 4 {
        return Some(segs[2].to_string());
    }
    None
}

/// A display title from the filename, for the listing before the PSID header is
/// backfilled. HVSC filenames are meaningful — `12th_Sector_Music.sid` — so this
/// is a usable library on day one with no file reads at all.
pub fn title_from_filename(filename: &str) -> String {
    filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(filename)
        .replace('_', " ")
}

/// What an index pass did.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct IndexResult {
    pub tunes: usize,
    pub subtunes: usize,
    pub removed: usize,
    /// STIL records stored. Zero when the collection ships no STIL.txt, which is
    /// a supported configuration rather than a failure.
    pub notes: usize,
}

/// Build this root's index from the songlengths database.
///
/// No walk, no stat, no hashing: every row comes from the one file. Rows the
/// database no longer lists are dropped, so applying an HVSC update and
/// reindexing reconciles removals as well as additions.
///
/// **`content_hash` is the Songlengths MD5.** That column is just "the key
/// content-addressed metadata hangs off"; for scanned files it's a SHA-256 we
/// computed, and here it's the digest HVSC already published — the same MD5
/// `scan::hash_file` would produce. Using it avoids reading 375 MB to learn
/// something the database already told us. (The two are trivially
/// distinguishable — 32 hex chars vs 64 — so they cannot collide.)
pub fn index_into(
    conn: &mut rusqlite::Connection,
    root_id: &str,
    root: &Path,
) -> anyhow::Result<IndexResult> {
    let entries = read_entries(root)?;
    let stamp = stamp(root)?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut result = IndexResult::default();

    let tx = conn.transaction()?;
    {
        let mut file = tx.prepare(
            "INSERT INTO files (root_id, rel_path, grp, artist, filename, ext, size, mtime,
                                content_hash, md5)
             VALUES (?1, ?2, '', ?3, ?4, ?5, 0, 0, ?6, ?6)
             ON CONFLICT(root_id, rel_path) DO UPDATE SET
               artist=excluded.artist, filename=excluded.filename, ext=excluded.ext,
               content_hash=excluded.content_hash, md5=excluded.md5",
        )?;
        let mut song = tx.prepare(
            "INSERT INTO songs (content_hash, subsong, title, duration)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(content_hash, subsong) DO UPDATE SET
               duration=excluded.duration,
               -- Keep a title the PSID backfill already established; the
               -- filename-derived one is only a first approximation.
               title=COALESCE(songs.title, excluded.title)",
        )?;

        for e in &entries {
            let filename = e.rel_path.rsplit('/').next().unwrap_or(&e.rel_path);
            let ext = filename
                .rsplit_once('.')
                .map(|(_, x)| x.to_lowercase())
                .unwrap_or_else(|| "sid".into());
            file.execute(rusqlite::params![
                root_id,
                e.rel_path,
                artist_from_path(&e.rel_path),
                filename,
                ext,
                e.md5,
            ])?;
            let title = title_from_filename(filename);
            for (i, len) in e.lengths.iter().enumerate() {
                song.execute(rusqlite::params![e.md5, i as i64, title, len])?;
            }
            result.tunes += 1;
            result.subtunes += e.lengths.len();
        }
        drop(file);
        drop(song);

        // STIL, in the same pass. Replaced wholesale rather than merged: it's a
        // document that ships with the release, so the release's copy is the
        // truth and a stale note from the previous one shouldn't survive.
        let notes = read_stil(root);
        if !notes.is_empty() {
            tx.execute("DELETE FROM stil WHERE root_id = ?1", [root_id])?;
            let mut ins = tx.prepare(
                "INSERT INTO stil (root_id, rel_path, subsong, comment, title, artist, name, author)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(root_id, rel_path, subsong) DO NOTHING",
            )?;
            for n in &notes {
                ins.execute(rusqlite::params![
                    root_id, n.rel_path, n.subsong, n.comment, n.title, n.artist, n.name, n.author,
                ])?;
            }
            result.notes = notes.len();
        }

        // Drop rows for tunes this release no longer lists.
        let listed: std::collections::HashSet<&str> =
            entries.iter().map(|e| e.rel_path.as_str()).collect();
        let stale: Vec<String> = {
            let mut s = tx.prepare("SELECT rel_path FROM files WHERE root_id = ?1")?;
            let rows = s.query_map([root_id], |r| r.get::<_, String>(0))?;
            rows.filter_map(Result::ok)
                .filter(|p| !listed.contains(p.as_str()))
                .collect()
        };
        for p in &stale {
            tx.execute(
                "DELETE FROM files WHERE root_id = ?1 AND rel_path = ?2",
                rusqlite::params![root_id, p],
            )?;
            result.removed += 1;
        }

        tx.execute(
            "INSERT INTO hvsc_state (root_id, version, sl_size, sl_mtime, tunes, subtunes, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(root_id) DO UPDATE SET
               version=excluded.version, sl_size=excluded.sl_size, sl_mtime=excluded.sl_mtime,
               tunes=excluded.tunes, subtunes=excluded.subtunes, indexed_at=excluded.indexed_at",
            rusqlite::params![
                root_id,
                stamp.version,
                stamp.size,
                stamp.mtime,
                result.tunes as i64,
                result.subtunes as i64,
                now,
            ],
        )?;
    }
    tx.commit()?;
    Ok(result)
}

/// Is this root's index already current? Compares the stored stamp with the
/// database file on disk — one stat, so it's free to check at every boot.
pub fn is_current(conn: &rusqlite::Connection, root_id: &str, root: &Path) -> bool {
    let Ok(s) = stamp(root) else { return false };
    conn.query_row(
        "SELECT sl_size, sl_mtime FROM hvsc_state WHERE root_id = ?1",
        [root_id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )
    .map(|(size, mtime)| size == s.size && mtime == s.mtime)
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "[Database]\n\
; /DEMOS/0-9/12th_Sector_Music.sid\n\
c7c299ce06ec5ccffb2261fb11b42a73=4:33.108\n\
; /MUSICIANS/H/Hubbard_Rob/Commando.sid\n\
5f08a730b280e54fd1e75a7046b93fdc=1:17 0:56 2:03.4\n";

    #[test]
    fn parses_paths_hashes_and_per_subtune_lengths() {
        let e = parse_songlengths(SAMPLE);
        assert_eq!(e.len(), 2);
        // Paths are stored relative — no leading slash — like every other row.
        assert_eq!(e[0].rel_path, "DEMOS/0-9/12th_Sector_Music.sid");
        assert_eq!(e[0].md5, "c7c299ce06ec5ccffb2261fb11b42a73");
        assert_eq!(e[0].lengths, vec![273.108]);
        // The count of lengths IS the subtune count.
        assert_eq!(e[1].lengths.len(), 3);
        assert_eq!(e[1].lengths[1], 56.0);
        assert_eq!(e[1].lengths[2], 123.4);
    }

    #[test]
    fn ignores_the_header_and_malformed_lines() {
        let text = "[Database]\n\n\
; /A/ok.sid\n\
5f08a730b280e54fd1e75a7046b93fdc=1:00\n\
notahash=1:00\n\
; /A/orphan-with-no-hash.sid\n";
        let e = parse_songlengths(text);
        assert_eq!(e.len(), 1, "only the well-formed entry");
        assert_eq!(e[0].rel_path, "A/ok.sid");
    }

    #[test]
    fn an_entry_with_no_usable_length_is_skipped_not_zeroed() {
        // A zero length would auto-advance instantly; absent is honest.
        let e = parse_songlengths("; /A/x.sid\n5f08a730b280e54fd1e75a7046b93fdc=\n");
        assert!(e.is_empty());
    }

    #[test]
    fn lengths_parse_with_and_without_fractions() {
        assert_eq!(parse_length("0:56"), Some(56.0));
        assert_eq!(parse_length("4:33.108"), Some(273.108));
        assert_eq!(parse_length("10:00"), Some(600.0));
        assert_eq!(parse_length("garbage"), None);
        assert_eq!(parse_length("-1:00"), None);
    }

    #[test]
    fn reads_the_release_number_from_the_banner() {
        // HVSC #85's actual banner.
        let real = "-------------\n      T H E   H I G H   V O L T A G E\n\
                    S I D   C O L L E C T I O N\n\n\
                              Release 85\n\n            June 28, 2026\n";
        assert_eq!(parse_version(real), Some(85));
        // Older phrasing.
        assert_eq!(parse_version("The HVSC #71 release\n"), Some(71));
        assert_eq!(parse_version("no number here"), None);
    }

    #[test]
    fn version_is_not_fooled_by_prose_further_down() {
        // HVSC.txt is thousands of lines and mentions "Tunes #1 and #2" and
        // "(Update #31)". A bare '#' scan would report version 1.
        let doc = format!(
            "The High Voltage SID Collection\n{}\n(Fixes a pic mover. Tunes #1 and #2 in\n\
             As of HVSC 4.6 (Update #31) there is also...\n",
            "\n".repeat(60)
        );
        assert_eq!(
            parse_version(&doc),
            None,
            "no banner → unknown, not a guess"
        );
    }

    #[test]
    fn artist_comes_from_the_musicians_layout_only() {
        // MUSICIANS/<letter>/<Artist>/ names the composer.
        assert_eq!(
            artist_from_path("MUSICIANS/H/Hubbard_Rob/Commando.sid").as_deref(),
            Some("Hubbard_Rob")
        );
        // DEMOS/GAMES start with a category, not a person — the generic
        // seg[0] rule would file thousands of tunes under "DEMOS".
        assert_eq!(artist_from_path("DEMOS/0-9/Tune.sid"), None);
        assert_eq!(artist_from_path("GAMES/A-F/Game.sid"), None);
    }

    /// STIL, in the shape the real document uses: CRLF, a 7-column right-aligned
    /// field gutter, and continuations indented to 9.
    const STIL: &str = "\
##############################################################################\r
#  STIL v85 - SID Tune Information List\r
##############################################################################\r
\r
### /DEMOS/ ##################################################################\r
\r
/DEMOS/0-9/12345.sid\r
  TITLE: 1.2.3.4.5.6.7.8\r
 ARTIST: Ken Laszlo\r
\r
/DEMOS/A-F/Bugle_Boy_BASIC.sid\r
COMMENT: All subtunes start\r
         after 7 seconds.\r
(#1)\r
  TITLE: First Call\r
 ARTIST: Military Traditional\r
(#3)\r
  TITLE: Assembly\r
\r
/MUSICIANS/0-9/4-Mat/\r
COMMENT: A note about the artist, not a tune.\r
";

    #[test]
    fn parses_file_scope_and_subtune_records() {
        let r = parse_stil(STIL);
        // The directory entry is dropped — it has no tune to attach to.
        assert_eq!(r.len(), 4);

        // File scope is -1: it applies to every subtune.
        assert_eq!(r[0].rel_path, "DEMOS/0-9/12345.sid");
        assert_eq!(r[0].subsong, -1);
        // TITLE/ARTIST are the *covered original*, kept apart from the tune's
        // own name — merging them would retitle the library with pop songs.
        assert_eq!(r[0].title.as_deref(), Some("1.2.3.4.5.6.7.8"));
        assert_eq!(r[0].artist.as_deref(), Some("Ken Laszlo"));
        assert!(r[0].comment.is_none());

        // A continuation line folds into the field it continues.
        assert_eq!(
            r[1].comment.as_deref(),
            Some("All subtunes start after 7 seconds.")
        );

        // `(#1)` is subsong 0 — STIL counts from one, `songs` from zero. A gap
        // in the numbering is real (not every subtune is annotated).
        assert_eq!(
            (r[2].subsong, r[2].title.as_deref()),
            (0, Some("First Call"))
        );
        assert_eq!((r[3].subsong, r[3].title.as_deref()), (2, Some("Assembly")));
    }

    #[test]
    fn prose_that_looks_like_a_field_stays_in_the_comment() {
        // Real #85 comments contain lines like `Q:` / `BTW:`. Only the 7-column
        // right-aligned gutter marks a field, so these must not truncate it.
        let t = "/A/x.sid\r\nCOMMENT: He asked\r\n         Q: why?\r\n         BTW: no idea.\r\n";
        let r = parse_stil(t);
        assert_eq!(r.len(), 1);
        assert_eq!(
            r[0].comment.as_deref(),
            Some("He asked Q: why? BTW: no idea.")
        );
    }

    #[test]
    fn a_collection_without_stil_is_not_an_error() {
        // STIL is optional; `read_stil` degrades to no notes rather than failing
        // the whole index pass.
        assert!(read_stil(std::path::Path::new("/nonexistent")).is_empty());
        assert!(parse_stil("").is_empty());
    }

    /// Parse a real release's database. Sample text proves the parser agrees
    /// with itself; this proves it agrees with HVSC — every line consumed, the
    /// entry count matching the release, and no duplicate paths.
    ///
    /// Ignored by default. `HVSC_DIR=/path/to/C64Music cargo test -p
    /// tracker-backend --lib hvsc::tests::parses_a_real_release -- --ignored
    /// --nocapture`
    #[test]
    #[ignore]
    fn parses_a_real_release() {
        let Ok(dir) = std::env::var("HVSC_DIR") else {
            panic!("set HVSC_DIR to an unpacked C64Music tree");
        };
        let root = std::path::PathBuf::from(&dir);
        let text = std::fs::read_to_string(root.join(SONGLENGTHS)).expect("songlengths");
        let entries = parse_songlengths(&text);

        // Every `; /path` comment must have produced an entry — a silent drop
        // would mean tunes missing from the library with no error anywhere.
        let paths = text.lines().filter(|l| l.starts_with("; /")).count();
        assert_eq!(entries.len(), paths, "an entry per path comment");

        let subtunes: usize = entries.iter().map(|e| e.lengths.len()).sum();
        println!(
            "{} tunes, {} subtunes, version {:?}",
            entries.len(),
            subtunes,
            stamp(&root).ok().and_then(|s| s.version)
        );
        assert!(entries.len() > 1000, "suspiciously small database");

        let uniq: std::collections::HashSet<&str> =
            entries.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(uniq.len(), entries.len(), "paths are unique");
        // Every file the database names must actually be on disk, or the index
        // would list tunes that 404 on play.
        for e in entries.iter().take(500) {
            assert!(root.join(&e.rel_path).is_file(), "missing: {}", e.rel_path);
        }
    }

    /// Parse a real release's STIL. The hand-written sample can't cover 3.7 MB
    /// of curator prose — this checks the parser against it: every entry path
    /// resolves, nothing is duplicated, and the notes actually attach to tunes
    /// the songlengths database lists.
    ///
    /// Ignored by default; same `HVSC_DIR` as above.
    #[test]
    #[ignore]
    fn parses_a_real_stil() {
        let Ok(dir) = std::env::var("HVSC_DIR") else {
            panic!("set HVSC_DIR to an unpacked C64Music tree");
        };
        let root = std::path::PathBuf::from(&dir);
        let records = read_stil(&root);
        assert!(records.len() > 1000, "suspiciously few STIL records");

        // One record per (path, subtune) — a duplicate would mean the parser
        // split one entry in two, losing half the note to a primary-key clash.
        let keys: std::collections::HashSet<(&str, i64)> = records
            .iter()
            .map(|r| (r.rel_path.as_str(), r.subsong))
            .collect();
        assert_eq!(keys.len(), records.len(), "(path, subsong) is unique");

        // Every annotated tune must be one the collection actually indexes,
        // otherwise the notes would never be reachable from a track.
        let listed: std::collections::HashSet<String> = read_entries(&root)
            .expect("songlengths")
            .into_iter()
            .map(|e| e.rel_path)
            .collect();
        let orphans: Vec<&str> = records
            .iter()
            .map(|r| r.rel_path.as_str())
            .filter(|p| !listed.contains(*p))
            .collect();
        assert!(
            orphans.is_empty(),
            "notes with no tune: {:?}",
            &orphans[..5.min(orphans.len())]
        );

        let comments = records.iter().filter(|r| r.comment.is_some()).count();
        println!(
            "{} STIL records over {} tunes, {comments} comments",
            records.len(),
            records
                .iter()
                .map(|r| r.rel_path.as_str())
                .collect::<std::collections::HashSet<_>>()
                .len(),
        );
    }

    /// Build a minimal HVSC-shaped tree: the songlengths database, the version
    /// banner, and the tune files it names.
    fn fake_hvsc(dir: &Path, db: &str) {
        std::fs::create_dir_all(dir.join("DOCUMENTS")).unwrap();
        std::fs::write(dir.join("DOCUMENTS/Songlengths.md5"), db).unwrap();
        std::fs::write(
            dir.join("DOCUMENTS/HVSC.txt"),
            "T H E   H I G H   V O L T A G E\n\n     Release 85\n",
        )
        .unwrap();
        for e in parse_songlengths(db) {
            let p = dir.join(&e.rel_path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"not really a sid").unwrap();
        }
    }

    fn conn() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(crate::db::schema_sql()).unwrap();
        c
    }

    #[test]
    fn indexes_from_the_database_without_reading_any_tune() {
        let dir = tempfile::tempdir().unwrap();
        fake_hvsc(dir.path(), SAMPLE);
        // Delete the tune files: indexing must not need them. This is the whole
        // premise — 61k stats and hashes replaced by one 5 MB read.
        std::fs::remove_dir_all(dir.path().join("MUSICIANS")).unwrap();
        std::fs::remove_dir_all(dir.path().join("DEMOS")).unwrap();

        let mut c = conn();
        let r = index_into(&mut c, "hvsc", dir.path()).unwrap();
        assert_eq!(r.tunes, 2);
        assert_eq!(r.subtunes, 4, "1 + 3 subtunes");

        // One files row per tune, one songs row per subtune.
        let files: i64 = c
            .query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))
            .unwrap();
        let songs: i64 = c
            .query_row("SELECT COUNT(*) FROM songs", [], |r| r.get(0))
            .unwrap();
        assert_eq!((files, songs), (2, 4));

        // Durations come straight from the database — the only source a SID has.
        let d: f64 = c
            .query_row(
                "SELECT duration FROM songs s JOIN files f ON f.content_hash = s.content_hash
                 WHERE f.filename = 'Commando.sid' AND s.subsong = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(d, 123.4);

        // The published MD5 is the content key, so nothing had to be hashed.
        let (hash, md5): (String, String) = c
            .query_row(
                "SELECT content_hash, md5 FROM files WHERE filename = 'Commando.sid'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(hash, md5);
        assert_eq!(hash.len(), 32, "an MD5, not a SHA-256");
    }

    #[test]
    fn artists_and_titles_come_from_the_paths() {
        let dir = tempfile::tempdir().unwrap();
        fake_hvsc(dir.path(), SAMPLE);
        let mut c = conn();
        index_into(&mut c, "hvsc", dir.path()).unwrap();

        let artist: Option<String> = c
            .query_row(
                "SELECT artist FROM files WHERE filename = 'Commando.sid'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(artist.as_deref(), Some("Hubbard_Rob"));

        // A DEMOS tune has a category, not a person, in seg[0] — so no artist
        // rather than thousands of tunes filed under "DEMOS".
        let demo: Option<String> = c
            .query_row(
                "SELECT artist FROM files WHERE filename = '12th_Sector_Music.sid'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(demo, None);

        let title: String = c
            .query_row(
                "SELECT title FROM songs WHERE content_hash =
                   (SELECT content_hash FROM files WHERE filename = '12th_Sector_Music.sid')
                 LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(title, "12th Sector Music");
    }

    #[test]
    fn reindexing_an_update_adds_removes_and_restamps() {
        let dir = tempfile::tempdir().unwrap();
        fake_hvsc(dir.path(), SAMPLE);
        let mut c = conn();
        index_into(&mut c, "hvsc", dir.path()).unwrap();
        assert!(is_current(&c, "hvsc", dir.path()), "freshly indexed");

        // A new release: one tune dropped, one added, one length corrected.
        let updated = "[Database]\n\
; /MUSICIANS/H/Hubbard_Rob/Commando.sid\n\
5f08a730b280e54fd1e75a7046b93fdc=1:30 0:56 2:03.4\n\
; /MUSICIANS/G/Galway_Martin/Wizball.sid\n\
aa08a730b280e54fd1e75a7046b93fdc=3:00\n";
        std::fs::write(dir.path().join("DOCUMENTS/Songlengths.md5"), updated).unwrap();

        let r = index_into(&mut c, "hvsc", dir.path()).unwrap();
        assert_eq!(r.tunes, 2);
        assert_eq!(r.removed, 1, "the dropped tune's row is gone");

        let names: Vec<String> = c
            .prepare("SELECT filename FROM files ORDER BY filename")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(names, vec!["Commando.sid", "Wizball.sid"]);

        let d: f64 = c
            .query_row(
                "SELECT duration FROM songs WHERE content_hash =
                   '5f08a730b280e54fd1e75a7046b93fdc' AND subsong = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(d, 90.0, "the corrected length replaced the old one");

        let (ver, tunes): (Option<u32>, i64) = c
            .query_row("SELECT version, tunes FROM hvsc_state", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((ver, tunes), (Some(85), 2));
    }

    #[test]
    fn a_changed_database_is_detected_as_stale() {
        let dir = tempfile::tempdir().unwrap();
        fake_hvsc(dir.path(), SAMPLE);
        let mut c = conn();
        index_into(&mut c, "hvsc", dir.path()).unwrap();
        assert!(is_current(&c, "hvsc", dir.path()));

        // Applying an update rewrites the database; size change alone is enough.
        std::fs::write(
            dir.path().join("DOCUMENTS/Songlengths.md5"),
            format!("{SAMPLE}; /A/extra.sid\nbb08a730b280e54fd1e75a7046b93fdc=1:00\n"),
        )
        .unwrap();
        assert!(
            !is_current(&c, "hvsc", dir.path()),
            "a new release is noticed"
        );
    }

    #[test]
    fn an_unindexed_or_missing_root_is_never_current() {
        let dir = tempfile::tempdir().unwrap();
        let c = conn();
        assert!(
            !is_current(&c, "hvsc", dir.path()),
            "not an HVSC tree at all"
        );
        fake_hvsc(dir.path(), SAMPLE);
        assert!(
            !is_current(&c, "hvsc", dir.path()),
            "present but never indexed"
        );
        assert!(looks_like_hvsc(dir.path()));
    }

    #[test]
    fn titles_come_from_the_filename_without_reading_the_file() {
        assert_eq!(
            title_from_filename("12th_Sector_Music.sid"),
            "12th Sector Music"
        );
        assert_eq!(title_from_filename("Commando.sid"), "Commando");
    }
}

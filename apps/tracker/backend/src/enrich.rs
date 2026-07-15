//! Metadata-enrichment helpers for filling the `library.json` graph from the
//! modules themselves. Two halves, both offline:
//!
//! 1. **extract** — sceners used the sample/instrument-name slots (and the song
//!    message) as a text area for their handle, group, greetings and year. A
//!    printable-strings sweep of each module pulls that text out ([`extract_text`],
//!    [`build_corpus`]); the corpus (one JSON line per module, keyed by md5 +
//!    artist) is what an LLM triages into proposals.
//! 2. **merge** — fold a reviewed proposal document (artist `aka`/`groups`,
//!    per-song `forGroup`/`with`/`year`) into the manifest additively
//!    ([`merge`]) — never clobbering existing curation, only adding.
//!
//! The strings sweep is deliberately crude but format-agnostic (works for MOD /
//! XM / S3M / IT / the legacy zoo alike) — see MODULES-PLAYBOOK.md "Workflow D".

use std::collections::HashSet;
use std::path::Path;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use walkdir::{DirEntry, WalkDir};

use crate::manifest::Manifest;

/// One module's extracted text, ready for LLM triage.
#[derive(Debug, Serialize)]
pub struct CorpusEntry {
    pub md5: String,
    /// The artist folder (first path segment) in the artist-primary tree.
    pub artist: String,
    pub filename: String,
    pub path: String,
    /// Printable-ASCII runs found in the bytes (module/sample/instrument names,
    /// embedded messages) — deduped, letters-only, capped.
    pub text: Vec<String>,
}

/// Extract the human text from a module. For the Protracker/MOD family the
/// sample-name table sits at fixed offsets *before* the sample PCM, so it's read
/// directly (clean — no 8-bit-PCM garbage). Everything else falls back to a
/// printable-strings sweep (16-bit-sample formats leave far less printable junk).
pub fn extract_text(bytes: &[u8], ext: &str) -> Vec<String> {
    if matches!(ext, "mod" | "nst" | "m15" | "stk" | "wow") {
        extract_mod_names(bytes)
    } else {
        strings_sweep(bytes)
    }
}

/// A MOD's 20-byte title + 31 × 22-byte sample names (each in a 30-byte header
/// starting at offset 20). PCM lives past the pattern data, so this table is
/// clean; garbage from a shorter (15-sample) variant's out-of-range fields is
/// dropped by the per-field filter.
fn extract_mod_names(bytes: &[u8]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    field(bytes, 0, 20, &mut out, &mut seen);
    for i in 0..31 {
        field(bytes, 20 + i * 30, 22, &mut out, &mut seen);
    }
    out
}

/// A fixed-width, NUL-padded text field: printable ASCII up to the first NUL,
/// trimmed, kept if it has a letter and isn't a dup.
fn field(bytes: &[u8], start: usize, len: usize, out: &mut Vec<String>, seen: &mut HashSet<String>) {
    let end = (start + len).min(bytes.len());
    if start >= end {
        return;
    }
    let s: String = bytes[start..end]
        .iter()
        .take_while(|&&b| b != 0)
        .filter(|&&b| (0x20..=0x7e).contains(&b))
        .map(|&b| b as char)
        .collect();
    let s = s.trim().to_string();
    if s.chars().count() >= 2
        && s.chars().any(|c| c.is_ascii_alphabetic())
        && seen.insert(s.to_lowercase())
    {
        out.push(s);
    }
}

/// Printable-ASCII runs (>= 5 chars, majority letters) in `bytes`, deduped and
/// capped — the format-agnostic fallback for non-MOD modules.
fn strings_sweep(bytes: &[u8]) -> Vec<String> {
    const MIN_LEN: usize = 5;
    const MAX_RUNS: usize = 80;
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut cur: Vec<u8> = Vec::new();
    for &b in bytes {
        if (0x20..=0x7e).contains(&b) {
            cur.push(b);
        } else if !cur.is_empty() {
            take_run(&cur, MIN_LEN, &mut out, &mut seen);
            cur.clear();
            if out.len() >= MAX_RUNS {
                return out;
            }
        }
    }
    take_run(&cur, MIN_LEN, &mut out, &mut seen);
    out
}

fn take_run(run: &[u8], min_len: usize, out: &mut Vec<String>, seen: &mut HashSet<String>) {
    let s = String::from_utf8_lossy(run).trim().to_string();
    let chars = s.chars().count();
    if chars < min_len {
        return;
    }
    // Reject raw sample-PCM that happens to land in printable ASCII: real names
    // are mostly letters, and never carry these markers. Requiring a majority of
    // alphabetic chars + no PCM-marker symbols drops the garbage while keeping
    // handles, group tags, BBS ads and years.
    let letters = s.chars().filter(|c| c.is_ascii_alphabetic()).count();
    if letters * 2 < chars {
        return;
    }
    if s.chars().any(|c| matches!(c, '\\' | '|' | '^' | '~' | '{' | '}' | '`')) {
        return;
    }
    if seen.insert(s.to_lowercase()) {
        out.push(s);
    }
}

fn is_hidden(e: &DirEntry) -> bool {
    e.depth() > 0 && e.file_name().to_string_lossy().starts_with('.')
}

/// Walk `root`, read each module, and build the text corpus. Reads the full
/// bytes (for the md5 key + the sweep), so it's a one-time pass over the mount —
/// call from a blocking context.
pub fn build_corpus(root: &Path) -> Vec<CorpusEntry> {
    let mut out = Vec::new();
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden(e));
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = match entry.path().extension() {
            Some(e) => e.to_string_lossy().to_lowercase(),
            None => continue,
        };
        if !crate::scan::MODULE_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let (_sha, md5) = crate::scan::hash_bytes(&bytes);
        let artist = match rel.split_once('/') {
            Some((seg0, _)) => seg0.to_string(),
            None => String::new(),
        };
        let filename = entry.file_name().to_string_lossy().to_string();
        let text = extract_text(&bytes, &ext);
        out.push(CorpusEntry {
            md5,
            artist,
            filename,
            path: rel,
            text,
        });
    }
    out
}

// ---------- merge (apply reviewed proposals) ----------

#[derive(Debug, Default, Deserialize)]
pub struct ArtistProposal {
    #[serde(default)]
    pub aka: Vec<String>,
    #[serde(default)]
    pub groups: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct SongProposal {
    #[serde(default, rename = "forGroup")]
    pub for_group: Option<String>,
    #[serde(default)]
    pub with: Vec<String>,
    #[serde(default)]
    pub year: Option<i64>,
}

/// A reviewed proposal document — the LLM's triage of the corpus. Same shape as
/// the manifest's artist/song sections, applied additively.
#[derive(Debug, Default, Deserialize)]
pub struct Proposals {
    #[serde(default)]
    pub artists: IndexMap<String, ArtistProposal>,
    #[serde(default)]
    pub songs: IndexMap<String, SongProposal>,
}

#[derive(Debug, Default, Serialize)]
pub struct MergeStats {
    pub artists_touched: usize,
    pub aka_added: usize,
    pub groups_added: usize,
    pub songs_touched: usize,
}

fn contains_ci(haystack: &[String], needle: &str) -> bool {
    haystack.iter().any(|x| x.eq_ignore_ascii_case(needle))
}

/// Fold `proposals` into `manifest` **additively**: union new `aka`/`groups`
/// into each artist (never removing existing), and set per-song credits (a
/// provided `forGroup`/`year` overrides; `with` unions). Returns what changed.
pub fn merge(manifest: &mut Manifest, proposals: &Proposals) -> MergeStats {
    let mut st = MergeStats::default();

    for (name, p) in &proposals.artists {
        let cur = manifest.artists.get(name);
        let cur_aka = cur.map(|e| e.aka.clone()).unwrap_or_default();
        let cur_groups = cur.map(|e| e.groups.clone()).unwrap_or_default();

        let mut add_aka: Vec<String> = Vec::new();
        for a in &p.aka {
            let a = a.trim();
            if !a.is_empty()
                && !a.eq_ignore_ascii_case(name)
                && !contains_ci(&cur_aka, a)
                && !contains_ci(&add_aka, a)
            {
                add_aka.push(a.to_string());
            }
        }
        let mut add_groups: Vec<String> = Vec::new();
        for g in &p.groups {
            let g = g.trim();
            if !g.is_empty() && !contains_ci(&cur_groups, g) && !contains_ci(&add_groups, g) {
                add_groups.push(g.to_string());
            }
        }
        if add_aka.is_empty() && add_groups.is_empty() {
            continue; // nothing new — don't create an empty entry
        }
        let entry = manifest.artists.entry(name.clone()).or_default();
        st.aka_added += add_aka.len();
        st.groups_added += add_groups.len();
        entry.aka.extend(add_aka);
        entry.groups.extend(add_groups);
        st.artists_touched += 1;
    }

    for (md5, p) in &proposals.songs {
        let for_group = p
            .for_group
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let with: Vec<&str> = p.with.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        if for_group.is_none() && p.year.is_none() && with.is_empty() {
            continue;
        }
        let entry = manifest.songs.entry(md5.trim().to_lowercase()).or_default();
        if let Some(fg) = for_group {
            entry.for_group = Some(fg.to_string());
        }
        if let Some(y) = p.year {
            entry.year = Some(y);
        }
        for w in with {
            if !contains_ci(&entry.with, w) {
                entry.with.push(w.to_string());
            }
        }
        st.songs_touched += 1;
    }

    st
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_sweep_dedups_and_filters() {
        // Non-MOD path: title + a signature, NUL-separated, with junk to drop.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"the enigma variations");
        bytes.push(0);
        bytes.extend_from_slice(b"4-mat/anarchy 1993");
        bytes.push(0);
        bytes.extend_from_slice(b"ab"); // too short
        bytes.push(0);
        bytes.extend_from_slice(&[0x01, 0x02, 0xff]); // non-printable
        bytes.extend_from_slice(b"12345"); // no letters
        bytes.push(0);
        bytes.extend_from_slice(b"the enigma variations"); // dup (case-insensitive)
        let runs = extract_text(&bytes, "s3m");
        assert_eq!(runs, vec!["the enigma variations", "4-mat/anarchy 1993"]);
    }

    #[test]
    fn mod_names_read_title_and_samples_skip_pcm() {
        // Build a minimal MOD: 20-byte title, 31 × 30-byte sample headers (name in
        // the first 22), then "PCM" bytes that must NOT leak in.
        let mut b = vec![0u8; 20 + 31 * 30 + 64];
        b[0..5].copy_from_slice(b"intro");
        // sample 0 name at offset 20.
        b[20..20 + 12].copy_from_slice(b"4mat/anarchy");
        // trailing region = fake 8-bit PCM ramp (printable but must be ignored).
        for (i, x) in b[20 + 31 * 30..].iter_mut().enumerate() {
            *x = 0x20 + (i % 90) as u8;
        }
        let runs = extract_text(&b, "mod");
        assert!(runs.contains(&"intro".to_string()));
        assert!(runs.contains(&"4mat/anarchy".to_string()));
        // The PCM ramp after the header table never appears.
        assert!(!runs.iter().any(|r| r.contains("!\"#$")));
    }

    #[test]
    fn build_corpus_reads_modules_and_derives_artist() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("4-Mat")).unwrap();
        // .xm → the strings-sweep path, so the whole signature is one run.
        std::fs::write(root.join("4-Mat/enigma.xm"), b"hello from 4-mat of anarchy").unwrap();
        std::fs::write(root.join("4-Mat/._enigma.xm"), b"junk").unwrap(); // skipped
        std::fs::write(root.join("4-Mat/readme.txt"), b"not a module").unwrap(); // skipped

        let corpus = build_corpus(root);
        assert_eq!(corpus.len(), 1);
        assert_eq!(corpus[0].artist, "4-Mat");
        assert_eq!(corpus[0].filename, "enigma.xm");
        assert!(corpus[0].text.iter().any(|t| t.contains("4-mat of anarchy")));
    }

    #[test]
    fn merge_is_additive_and_skips_empty() {
        let mut m: Manifest = serde_json::from_str(
            r#"{ "artists": { "4-Mat": { "groups": ["Anarchy"] } } }"#,
        )
        .unwrap();
        let proposals: Proposals = serde_json::from_str(
            r#"{
              "artists": {
                "4-Mat": { "aka": ["Matt Simmonds", "4-Mat"], "groups": ["Anarchy", "Rebels"] },
                "Nobody": { "aka": [], "groups": [] }
              },
              "songs": { "AB12": { "forGroup": "Sanity", "year": 1993, "with": ["Skaven"] } }
            }"#,
        )
        .unwrap();
        let st = merge(&mut m, &proposals);

        // Existing "Anarchy" kept; "Rebels" + the alias added; self-alias dropped.
        assert_eq!(m.artists["4-Mat"].groups, vec!["Anarchy", "Rebels"]);
        assert_eq!(m.artists["4-Mat"].aka, vec!["Matt Simmonds"]);
        // Empty proposal creates no entry.
        assert!(!m.artists.contains_key("Nobody"));
        // Song credit keyed lowercase.
        assert_eq!(m.songs["ab12"].for_group.as_deref(), Some("Sanity"));
        assert_eq!(m.songs["ab12"].year, Some(1993));
        assert_eq!(st.artists_touched, 1);
        assert_eq!(st.songs_touched, 1);
        assert_eq!(st.aka_added, 1);
        assert_eq!(st.groups_added, 1);
    }
}

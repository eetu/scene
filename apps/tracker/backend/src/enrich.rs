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

/// Printable-ASCII runs (>= 5 chars, containing a letter) in `bytes`, deduped
/// case-insensitively and capped. This is where a scener's handle / group /
/// greets / year live in a module.
pub fn extract_text(bytes: &[u8]) -> Vec<String> {
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
    if s.len() < min_len || !s.chars().any(|c| c.is_ascii_alphabetic()) {
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
        out.push(CorpusEntry {
            md5,
            artist,
            filename,
            path: rel,
            text: extract_text(&bytes),
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
    fn extract_text_pulls_runs_dedup_and_filters() {
        // A MOD-ish buffer: title + a sample-name signature, separated by NULs,
        // with short/garbage runs that must be dropped.
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
        let runs = extract_text(&bytes);
        assert_eq!(runs, vec!["the enigma variations", "4-mat/anarchy 1993"]);
    }

    #[test]
    fn build_corpus_reads_modules_and_derives_artist() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("4-Mat")).unwrap();
        std::fs::write(root.join("4-Mat/enigma.mod"), b"hello from 4-mat of anarchy").unwrap();
        std::fs::write(root.join("4-Mat/._enigma.mod"), b"junk").unwrap(); // skipped
        std::fs::write(root.join("4-Mat/readme.txt"), b"not a module").unwrap(); // skipped

        let corpus = build_corpus(root);
        assert_eq!(corpus.len(), 1);
        assert_eq!(corpus[0].artist, "4-Mat");
        assert_eq!(corpus[0].filename, "enigma.mod");
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

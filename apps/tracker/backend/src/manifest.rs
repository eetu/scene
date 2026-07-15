//! The library manifest (`library.json`) — the human-asserted relational graph
//! the filesystem tree can't express.
//!
//! The tree is a tree (one location per file); artist ↔ group ↔ alias ↔ album is
//! a graph. So the tree carries one axis (the artist), and everything relational
//! lives here as data: an artist's alternate handles (`aka`) and group
//! memberships, named albums (ordered sets of song md5s — NOT directories, since
//! a tune can be in several), and per-song facts that aren't derivable from the
//! bytes (`forGroup` / co-authors / `year`).
//!
//! This file is the **source of truth for everything not recomputable from the
//! module bytes** — losing the SQLite cache costs a rescan, but the graph only
//! lives here (and survives on the SMB mount). Song references are md5s (portable,
//! matching the playlist items + The Mod Archive), so they follow a file across
//! moves/renames like the hash-keyed `meta`/`stats`.
//!
//! [`ManifestStore`] holds the parsed + resolved manifest behind a lock-free-read
//! pointer (an `RwLock<Arc<Resolved>>`): request handlers `get()` a snapshot
//! without blocking, and reload/curation swap the whole thing atomically. Writes
//! are serialized by a separate async mutex so a read-modify-write never races.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::Context;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// A canonical artist: alternate handles they released under, and the groups
/// they were part of. Both drive *views* — `aka` folds alias-named folders into
/// this artist; `groups` is inverted into a group→members facet.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Artist {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aka: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<String>,
}

/// A named, ordered collection of songs (by md5). Deliberately not a directory:
/// a tune can belong to several albums (a demo's soundtrack *and* an SFX pack)
/// and an album can span artists — the same many-to-many that keeps groups out
/// of the path.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Album {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Free-form category tag (e.g. `soundtrack`, `sfx`, `sid`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub songs: Vec<String>,
}

/// Per-song human-asserted facts that libopenmpt can't derive from the bytes.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SongCredit {
    /// The group the tune was released *for* (may differ from the author's own
    /// group — a musician doing a track for another crew's demo).
    #[serde(default, rename = "forGroup", skip_serializing_if = "Option::is_none")]
    pub for_group: Option<String>,
    /// Co-authors (secondary artists on the tune).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub with: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
}

/// The on-disk `library.json`. `IndexMap` keeps human-edited key order stable
/// across a save round-trip (so hand-edits and tool-writes don't reshuffle the
/// file).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub artists: IndexMap<String, Artist>,
    #[serde(default)]
    pub albums: IndexMap<String, Album>,
    /// Sparse — only annotated tunes appear, keyed by md5. Keeps one file viable
    /// at thousands of modules.
    #[serde(default)]
    pub songs: IndexMap<String, SongCredit>,
}

/// A manifest plus the inverse indexes the facet resolver needs, rebuilt on each
/// load. Cheap lookups: alias→canonical, group→members, md5→albums, md5→credit.
#[derive(Debug, Default)]
pub struct Resolved {
    manifest: Manifest,
    /// Normalised handle (any `aka` or a canonical name) → canonical artist.
    alias_to_canonical: HashMap<String, String>,
    /// Group name → its canonical-artist members.
    group_members: HashMap<String, Vec<String>>,
    /// Normalised md5 → album ids containing it.
    song_albums: HashMap<String, Vec<String>>,
    /// Normalised md5 → its credit (mirrors `manifest.songs`, keyed normalised).
    song_credits: HashMap<String, SongCredit>,
}

/// Normalise an artist handle / md5 for case-insensitive lookup. (NFC Unicode
/// normalisation for macOS-NFD vs Samba-NFC folder names is a follow-up — it
/// needs the `unicode-normalization` crate.)
fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

fn insert_alias(map: &mut HashMap<String, String>, handle: &str, canonical: &str) {
    let key = norm(handle);
    if key.is_empty() {
        return;
    }
    if let Some(existing) = map.get(&key) {
        if existing != canonical {
            tracing::warn!(
                handle,
                kept = existing,
                ignored = canonical,
                "duplicate artist handle in library.json — keeping the first"
            );
        }
        return;
    }
    map.insert(key, canonical.to_string());
}

impl Resolved {
    /// Build the inverse indexes from a manifest.
    pub fn build(manifest: Manifest) -> Self {
        let mut alias_to_canonical = HashMap::new();
        let mut group_members: HashMap<String, Vec<String>> = HashMap::new();
        for (name, artist) in &manifest.artists {
            insert_alias(&mut alias_to_canonical, name, name);
            for aka in &artist.aka {
                insert_alias(&mut alias_to_canonical, aka, name);
            }
            for g in &artist.groups {
                let members = group_members.entry(g.clone()).or_default();
                if !members.contains(name) {
                    members.push(name.clone());
                }
            }
        }
        let mut song_albums: HashMap<String, Vec<String>> = HashMap::new();
        for (id, album) in &manifest.albums {
            for md5 in &album.songs {
                song_albums.entry(norm(md5)).or_default().push(id.clone());
            }
        }
        let song_credits = manifest
            .songs
            .iter()
            .map(|(md5, c)| (norm(md5), c.clone()))
            .collect();
        Self {
            manifest,
            alias_to_canonical,
            group_members,
            song_albums,
            song_credits,
        }
    }

    /// The underlying manifest (for `GET /api/manifest` and read-modify-write).
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// Resolve any handle (a folder name or `aka`) to its canonical artist. An
    /// unknown handle maps to itself, so an un-declared artist still browses.
    pub fn canonical(&self, handle: &str) -> String {
        self.alias_to_canonical
            .get(&norm(handle))
            .cloned()
            .unwrap_or_else(|| handle.to_string())
    }

    /// Groups a canonical artist belongs to (as authored).
    pub fn groups_of(&self, canonical: &str) -> Vec<String> {
        self.manifest
            .artists
            .get(canonical)
            .map(|a| a.groups.clone())
            .unwrap_or_default()
    }

    /// Canonical-artist members of a group.
    pub fn group_members(&self, group: &str) -> Vec<String> {
        self.group_members.get(group).cloned().unwrap_or_default()
    }

    /// Album ids a song (by md5) belongs to.
    pub fn albums_of(&self, md5: &str) -> Vec<String> {
        self.song_albums
            .get(&norm(md5))
            .cloned()
            .unwrap_or_default()
    }

    /// A song's credit (by md5), if annotated.
    pub fn credit(&self, md5: &str) -> Option<&SongCredit> {
        self.song_credits.get(&norm(md5))
    }
}

/// Load `library.json` from disk. A missing file is not an error — it yields an
/// empty manifest (the pre-manifest state), so the app works before one exists.
pub fn load(path: &Path) -> anyhow::Result<Manifest> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .with_context(|| format!("parse manifest {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Manifest::default()),
        Err(e) => Err(anyhow::Error::from(e)).with_context(|| format!("read {}", path.display())),
    }
}

/// Write `library.json` atomically: serialise, write a sibling temp file, then
/// rename over the target — so a crash mid-write never leaves a truncated
/// manifest (and the rename is atomic on the same filesystem).
pub fn save(path: &Path, manifest: &Manifest) -> anyhow::Result<()> {
    let mut json = serde_json::to_vec_pretty(manifest).context("serialise manifest")?;
    json.push(b'\n');
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("library.json");
    let tmp = path.with_file_name(format!(".{file_name}.tmp"));
    std::fs::write(&tmp, &json).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Holds the parsed + resolved manifest, swappable at runtime. Reads are
/// lock-free-ish (`RwLock<Arc<_>>`: take the read lock, clone the `Arc`, drop the
/// guard — never held across an await). Curation writes go through [`update`],
/// which serialises read-modify-write behind an async mutex.
///
/// [`update`]: ManifestStore::update
pub struct ManifestStore {
    path: PathBuf,
    current: RwLock<Arc<Resolved>>,
    /// Serialises read-modify-write curation so two edits can't clobber each
    /// other (the in-memory `current` is authoritative between writes — single
    /// writer — so an edit starts from it, not a re-read).
    write: tokio::sync::Mutex<()>,
}

impl ManifestStore {
    /// Open at boot. An invalid manifest is logged and treated as empty rather
    /// than failing the server — the graph is optional enrichment, not liveness.
    pub fn open(path: PathBuf) -> Self {
        let manifest = load(&path).unwrap_or_else(|e| {
            tracing::warn!(path = %path.display(), error = %e,
                "invalid library.json — starting with an empty manifest");
            Manifest::default()
        });
        Self {
            path,
            current: RwLock::new(Arc::new(Resolved::build(manifest))),
            write: tokio::sync::Mutex::new(()),
        }
    }

    /// A cheap snapshot of the current resolved manifest.
    pub fn get(&self) -> Arc<Resolved> {
        self.current.read().expect("manifest lock poisoned").clone()
    }

    /// Re-read `library.json` from disk and swap it in. Cheap (no hashing) —
    /// distinct from the module rescan, so curating the graph is instant.
    pub async fn reload(&self) -> anyhow::Result<()> {
        let manifest = match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("parse manifest {}", self.path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Manifest::default(),
            Err(e) => {
                return Err(anyhow::Error::from(e))
                    .with_context(|| format!("read {}", self.path.display()))
            }
        };
        *self.current.write().expect("manifest lock poisoned") =
            Arc::new(Resolved::build(manifest));
        Ok(())
    }

    /// Read-modify-write the manifest: apply `mutate` to a copy of the current
    /// manifest, and — only if it returns `true` — persist atomically and swap in
    /// the rebuilt resolution. Returning `false` aborts without writing (e.g. the
    /// edit targeted an album that doesn't exist), and is surfaced as the return
    /// value so the caller can 404. The async mutex serialises concurrent edits;
    /// the check-and-mutate runs inside it, so an existence test can't race a
    /// concurrent write.
    pub async fn update(&self, mutate: impl FnOnce(&mut Manifest) -> bool) -> anyhow::Result<bool> {
        let _guard = self.write.lock().await;
        let mut manifest = self.get().manifest.clone();
        if !mutate(&mut manifest) {
            return Ok(false);
        }
        save(&self.path, &manifest)?;
        *self.current.write().expect("manifest lock poisoned") =
            Arc::new(Resolved::build(manifest));
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "artists": {
        "4-Mat":         { "aka": ["Matt Simmonds"], "groups": ["Anarchy", "Rebels"] },
        "Purple Motion": { "groups": ["Future Crew"] }
      },
      "albums": {
        "second-reality-ost": { "title": "Second Reality", "kind": "soundtrack",
                                "songs": ["AB12F9", "cd34a1"] }
      },
      "songs": { "ab12f9": { "forGroup": "Future Crew", "with": ["Skaven"], "year": 1993 } }
    }"#;

    fn resolved() -> Resolved {
        Resolved::build(serde_json::from_str(SAMPLE).unwrap())
    }

    #[test]
    fn parses_and_inverts() {
        let r = resolved();
        // Alias + canonical (case-insensitive) both resolve to the canonical.
        assert_eq!(r.canonical("Matt Simmonds"), "4-Mat");
        assert_eq!(r.canonical("matt simmonds"), "4-Mat");
        assert_eq!(r.canonical("4-Mat"), "4-Mat");
        // An unknown handle maps to itself.
        assert_eq!(r.canonical("Nobody"), "Nobody");
        // group → members and artist → groups.
        assert_eq!(r.group_members("Future Crew"), vec!["Purple Motion"]);
        assert_eq!(r.groups_of("4-Mat"), vec!["Anarchy", "Rebels"]);
    }

    #[test]
    fn album_and_credit_lookup_is_md5_case_insensitive() {
        let r = resolved();
        // Album membership resolves regardless of md5 case in file vs query.
        assert_eq!(r.albums_of("ab12f9"), vec!["second-reality-ost"]);
        assert_eq!(r.albums_of("AB12F9"), vec!["second-reality-ost"]);
        assert_eq!(r.albums_of("CD34A1"), vec!["second-reality-ost"]);
        assert!(r.albums_of("deadbeef").is_empty());
        // Credit (song key is lowercase; query upper).
        let c = r.credit("AB12F9").expect("credit present");
        assert_eq!(c.for_group.as_deref(), Some("Future Crew"));
        assert_eq!(c.with, vec!["Skaven"]);
        assert_eq!(c.year, Some(1993));
        assert!(r.credit("cd34a1").is_none());
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let m = load(&dir.path().join("nope.json")).unwrap();
        assert!(m.artists.is_empty() && m.albums.is_empty() && m.songs.is_empty());
    }

    #[test]
    fn save_then_load_round_trips_and_preserves_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let manifest: Manifest = serde_json::from_str(SAMPLE).unwrap();
        save(&path, &manifest).unwrap();
        let back = load(&path).unwrap();
        // Key order is preserved (IndexMap): 4-Mat before Purple Motion.
        let names: Vec<&String> = back.artists.keys().collect();
        assert_eq!(names, vec!["4-Mat", "Purple Motion"]);
        assert_eq!(back.artists["Purple Motion"].groups, vec!["Future Crew"]);
        // The temp file is cleaned up by the rename.
        assert!(!dir.path().join(".library.json.tmp").exists());
    }

    #[tokio::test]
    async fn update_persists_and_swaps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let store = ManifestStore::open(path.clone());
        assert!(store.get().manifest().artists.is_empty());

        let committed = store
            .update(|m| {
                m.artists.insert(
                    "Skaven".to_string(),
                    Artist {
                        aka: vec!["Peter Hajba".into()],
                        groups: vec!["Future Crew".into()],
                    },
                );
                true
            })
            .await
            .unwrap();
        assert!(committed);

        // Reflected in the live snapshot…
        assert_eq!(store.get().canonical("Peter Hajba"), "Skaven");
        // …and persisted (a fresh store reads it back).
        let store2 = ManifestStore::open(path.clone());
        assert_eq!(store2.get().group_members("Future Crew"), vec!["Skaven"]);
    }

    #[tokio::test]
    async fn update_abort_does_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("library.json");
        let store = ManifestStore::open(path.clone());
        // A closure returning false aborts — nothing persisted, no file created.
        let committed = store.update(|_m| false).await.unwrap();
        assert!(!committed);
        assert!(!path.exists());
    }
}

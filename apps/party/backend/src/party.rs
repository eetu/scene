//! Per-party configuration — the generic seam that lets the scanner absorb
//! differently-shaped party scrapes. Each party gets `parties/<slug>.json`
//! describing its competition layout; a built-in default applies when a party
//! folder has no matching file, so a new scrape "just works" and is refined by
//! authoring a JSON later.

use std::collections::HashMap;
use std::path::Path;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// Per-party config filename, living inside each party folder (so the tree is
/// self-contained). The scanner skips it (see `scan::is_junk`) so it never shows
/// as a browsable production file.
pub const CONFIG_FILE: &str = ".party.json";

/// One placement in a competition. Scraped from the party's original
/// `results.txt` (and cross-checked against demozoo/pouët) into the config — the
/// app does **not** parse `results.txt` at runtime, which kept needing a new
/// per-party parser. Joined onto a scanned production by `(category, rank)`:
/// `points` always (tie-safe — tied entries share points), and `group`/`title`
/// only when the rank is unique in the category (avoids the tie ambiguity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultRow {
    pub rank: i64,
    #[serde(default)]
    pub points: Option<i64>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

/// Group/title for an unranked entry (one that didn't place / isn't in the
/// results). Scraped from the prod's `FILE_ID.DIZ`/`.nfo` so the `rest/` tail
/// reads as names instead of cryptic archive stems.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntryMeta {
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

/// A competition folder's descriptor. Overrides the heuristics the scanner would
/// otherwise derive from the folder name and the productions' file kinds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryCfg {
    /// Human label for the competition (e.g. "PC 64K intro").
    pub compo: String,
    /// `pc` | `amiga` | `c64` | `video` | `na`.
    pub platform: String,
    /// `demo` | `intro` | `music` | `graphics` | `animation` | `info`.
    pub medium: String,
    /// Scraped competition placements (see [`ResultRow`]). Empty = no ranking.
    #[serde(default)]
    pub results: Vec<ResultRow>,
    /// Metadata for unranked entries, keyed by the entry's folder/file stem (its
    /// fallback title). Joined onto unranked productions so the `rest/` tail shows
    /// real names. Optional and empty by default.
    #[serde(default)]
    pub unranked: IndexMap<String, EntryMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartyCfg {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub year: Option<i64>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub organizer: Option<String>,
    /// Relative path (within the party folder) to a logo/key image for the
    /// landing card. Transcoded on demand if it isn't browser-native.
    #[serde(default)]
    pub logo: Option<String>,
    /// Entry-folder naming convention. Currently only `rank-group-title`.
    #[serde(default = "default_folder_name")]
    pub folder_name: String,
    /// Folder (one or two path segments, e.g. `demo`, `amiga/demo`) →
    /// competition descriptor. Missing folders fall back to heuristics.
    /// `IndexMap` so the JSON key order is preserved and drives the compo
    /// display order in the SPA.
    #[serde(default)]
    pub categories: IndexMap<String, CategoryCfg>,
}

fn default_folder_name() -> String {
    "rank-group-title".into()
}

impl PartyCfg {
    /// A reasonable default for a party folder with no authored JSON: slug/name
    /// derived from the directory name, no explicit categories (the scanner
    /// derives platform/medium heuristically), and `results.txt` parsed with the
    /// classic Assembly format if present.
    pub fn default_for(dir_name: &str) -> Self {
        Self {
            slug: slugify(dir_name),
            name: dir_name.to_string(),
            year: None,
            location: None,
            organizer: None,
            logo: None,
            folder_name: default_folder_name(),
            categories: IndexMap::new(),
        }
    }

    /// True if any configured category is two-segment under `seg0` (e.g.
    /// `amiga/demo`), meaning the scanner should treat `seg0` as a two-level
    /// category root rather than a single competition.
    pub fn is_two_level(&self, seg0: &str) -> bool {
        let prefix = format!("{seg0}/");
        self.categories.keys().any(|k| k.starts_with(&prefix))
    }

    pub fn category(&self, key: &str) -> Option<&CategoryCfg> {
        self.categories.get(key)
    }

    /// Position of a category in the JSON `categories` map — the SPA sorts compos
    /// by this so the display order is whatever the author listed.
    pub fn category_order(&self, key: &str) -> Option<usize> {
        self.categories.get_index_of(key)
    }
}

/// Loaded party configs, keyed by slug, with a default template for unknown
/// parties.
pub struct PartyConfigs {
    by_slug: HashMap<String, PartyCfg>,
}

impl PartyConfigs {
    /// Read each party folder's `.party.json` under `root` (one config per
    /// party, living with its data — self-contained, baked into the data image).
    /// Keyed by the folder's slug so `for_dir` matches regardless of the config's
    /// own `slug` field. Folders without a config fall back to a humanized default.
    pub fn load(root: &Path) -> Self {
        let mut by_slug = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let path = entry.path().join(CONFIG_FILE);
                let text = match std::fs::read_to_string(&path) {
                    Ok(t) => t,
                    Err(_) => continue, // party folder with no config → defaults
                };
                let slug = slugify(&entry.file_name().to_string_lossy());
                match serde_json::from_str::<PartyCfg>(&text) {
                    Ok(cfg) => {
                        by_slug.insert(slug, cfg);
                    }
                    Err(e) => {
                        tracing::warn!(path = %path.display(), error = %e, "skipping bad party config")
                    }
                }
            }
        }
        if by_slug.is_empty() {
            tracing::warn!(
                root = %root.display(),
                "no party configs loaded — productions fall back to humanized defaults \
                 (no compo labels/results, categories not split). Each party folder needs \
                 a `.party.json`."
            );
        } else {
            tracing::info!(count = by_slug.len(), root = %root.display(), "loaded party configs");
        }
        Self { by_slug }
    }

    /// The config for a party folder, by its directory name. Falls back to a
    /// default derived from the folder name.
    pub fn for_dir(&self, dir_name: &str) -> PartyCfg {
        let slug = slugify(dir_name);
        self.by_slug
            .get(&slug)
            .cloned()
            .unwrap_or_else(|| PartyCfg::default_for(dir_name))
    }
}

/// Lowercase, keep alphanumerics, drop everything else: `Assembly '95` →
/// `assembly95`, `Assembly95` → `assembly95`.
pub fn slugify(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_strips_and_lowercases() {
        assert_eq!(slugify("Assembly95"), "assembly95");
        assert_eq!(slugify("Assembly '95"), "assembly95");
        assert_eq!(slugify("The Party 1996"), "theparty1996");
    }

    #[test]
    fn default_config_is_empty() {
        let c = PartyCfg::default_for("Assembly95");
        assert_eq!(c.slug, "assembly95");
        assert!(c.categories.is_empty());
    }

    #[test]
    fn two_level_detection() {
        let mut cfg = PartyCfg::default_for("x");
        cfg.categories.insert(
            "amiga/demo".into(),
            CategoryCfg {
                compo: "Amiga demo".into(),
                platform: "amiga".into(),
                medium: "demo".into(),
                results: Vec::new(),
                unranked: Default::default(),
            },
        );
        assert!(cfg.is_two_level("amiga"));
        assert!(!cfg.is_two_level("demo"));
    }
}

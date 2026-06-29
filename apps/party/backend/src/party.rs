//! Per-party configuration — the generic seam that lets the scanner absorb
//! differently-shaped party scrapes. Each party gets `parties/<slug>.json`
//! describing its competition layout; a built-in default applies when a party
//! folder has no matching file, so a new scrape "just works" and is refined by
//! authoring a JSON later.

use std::collections::HashMap;
use std::path::Path;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

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
    /// Exact results-file section header for this competition, so points join
    /// precisely even when the display `compo` label differs (e.g. folder
    /// `mmul` → "Multichannel musax competiton"). Optional; null skips the join.
    #[serde(default)]
    pub results_title: Option<String>,
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
    /// Relative path to the results file to parse (e.g. `results.txt`).
    #[serde(default)]
    pub results_file: Option<String>,
    /// Which results parser to use: `assembly_classic` | `none`.
    #[serde(default = "default_results_format")]
    pub results_format: String,
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

fn default_results_format() -> String {
    "none".into()
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
            results_file: Some("results.txt".into()),
            results_format: "assembly_classic".into(),
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
    /// Read every `*.json` in `dir` (missing dir → empty set). Each file's
    /// `slug` is the lookup key.
    pub fn load(dir: &Path) -> Self {
        let mut by_slug = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                match std::fs::read_to_string(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|s| serde_json::from_str::<PartyCfg>(&s).map_err(|e| e.to_string()))
                {
                    Ok(cfg) => {
                        by_slug.insert(cfg.slug.clone(), cfg);
                    }
                    Err(e) => tracing::warn!(path = %path.display(), error = %e, "skipping bad party config"),
                }
            }
        }
        if by_slug.is_empty() {
            tracing::warn!(
                dir = %dir.display(),
                "no party configs loaded — productions fall back to humanized defaults \
                 (no compo labels/points, categories not split). Check PARTY_CONFIG_DIR."
            );
        } else {
            tracing::info!(count = by_slug.len(), dir = %dir.display(), "loaded party configs");
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
    fn default_config_parses_results() {
        let c = PartyCfg::default_for("Assembly95");
        assert_eq!(c.slug, "assembly95");
        assert_eq!(c.results_format, "assembly_classic");
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
                results_title: None,
            },
        );
        assert!(cfg.is_two_level("amiga"));
        assert!(!cfg.is_two_level("demo"));
    }
}

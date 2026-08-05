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

/// Playback overrides for one file, keyed in [`PartyCfg::files`] by its path
/// relative to the party folder. The escape hatch for archive quirks no scan can
/// infer — currently all about the Assembly animation compos, whose entries are
/// silent video-only MPEG-1 streams that also mis-declare their frame rate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCfg {
    /// Authored playback rate, overriding the container's own (wrong) header.
    /// Takes precedence over [`CategoryCfg::video_fps`].
    #[serde(default)]
    pub fps: Option<f64>,
    /// Opt out of [`CategoryCfg::video_fps`] and keep the source's own timing.
    ///
    /// For a real container (AVI/MP4) the timestamps are authoritative and may be
    /// *variable*, so forcing any constant rate discards them: the Assembly '95
    /// `anim` folder holds two later DivX re-encodes whose picture drifts ~9 s out
    /// from their own muxed audio if the compo's 12.5 fps is applied.
    #[serde(default)]
    pub native_fps: bool,
    /// Sibling file holding the soundtrack, muxed in as the audio track.
    /// Party-relative, like the keys of [`PartyCfg::files`].
    #[serde(default)]
    pub audio: Option<String>,
    /// Raw PCM sample format of `audio` (`u8`, `s8`, `s16le`, …) when it's a
    /// headerless dump. Omit for a container (WAV/MP3) — ffmpeg reads its header,
    /// which is both less to author and impossible to get wrong.
    #[serde(default)]
    pub audio_format: Option<String>,
    /// Sample rate, required alongside `audio_format`.
    #[serde(default)]
    pub audio_rate: Option<u32>,
    /// Channel count, defaults to mono.
    #[serde(default)]
    pub audio_channels: Option<u32>,
    /// DOSBox `cputype` for a DOS executable that needs a specific CPU. Anything
    /// the light core can't do (`pentium_mmx` and up — Byterapers' protocode0x28
    /// CPUID-gates on MMX and aborts without it) switches the whole bundle to the
    /// DOSBox-X core: a 7.9 MB download and a slower interpreter, hence per-file
    /// rather than global. See [`cpu_target`] for the accepted values and for why
    /// `pentium_mmx` resolves to a Pentium II; an unknown value is warned about at
    /// load and ignored.
    #[serde(default)]
    pub cputype: Option<String>,
}

/// Which js-dos core runs a given `cputype`, and the value that core's config
/// wants — `None` for a value neither core knows.
///
/// The two vendored cores accept different sets, so the authored CPU picks the
/// core: `wdosbox` is plain DOSBox (small, fast, tops out at Pentium without
/// MMX), `wdosbox-x` is DOSBox-X (8086 through Pentium III, MMX).
///
/// `pentium_mmx` is the one value that isn't passed through, because neither
/// DOSBox-X-in-js-dos spelling of it delivers a CPU that *reports* MMX:
/// `pentium_mmx` logs `not supported (using pentium instead)`, and the fork's own
/// `jsdos_pentium_mmx` logs `pentium_mmx is enabled` yet still fails a demo's
/// CPUID check (protocode0x28: "This machine does not report MMX support").
/// `pentium_ii` is the lowest setting whose CPUID advertises MMX, and it runs
/// that demo — so an authored `pentium_mmx` means "give me a CPU with MMX" and
/// resolves here. Write `jsdos_pentium_mmx` explicitly for the fork's own mode.
pub fn cpu_target(cputype: &str) -> Option<(&'static str, &'static str)> {
    Some(match cputype {
        "auto" => ("dosbox", "auto"),
        "386_slow" => ("dosbox", "386_slow"),
        "386_prefetch" => ("dosbox", "386_prefetch"),
        "486_slow" => ("dosbox", "486_slow"),
        "486_prefetch" => ("dosbox", "486_prefetch"),
        "pentium_slow" => ("dosbox", "pentium_slow"),
        "pentium_mmx" => ("dosboxX", "pentium_ii"),
        "jsdos_pentium_mmx" => ("dosboxX", "jsdos_pentium_mmx"),
        "8086" => ("dosboxX", "8086"),
        "8086_prefetch" => ("dosboxX", "8086_prefetch"),
        "80186" => ("dosboxX", "80186"),
        "80186_prefetch" => ("dosboxX", "80186_prefetch"),
        "286" => ("dosboxX", "286"),
        "286_prefetch" => ("dosboxX", "286_prefetch"),
        "386" => ("dosboxX", "386"),
        "486old" => ("dosboxX", "486old"),
        "486old_prefetch" => ("dosboxX", "486old_prefetch"),
        "486" => ("dosboxX", "486"),
        "pentium" => ("dosboxX", "pentium"),
        "ppro_slow" => ("dosboxX", "ppro_slow"),
        "pentium_ii" => ("dosboxX", "pentium_ii"),
        "pentium_iii" => ("dosboxX", "pentium_iii"),
        "experimental" => ("dosboxX", "experimental"),
        _ => return None,
    })
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
    /// Default playback rate for every video in this competition. A whole compo
    /// tends to share one authoring pipeline (the Assembly animation compos are
    /// 12.5 fps throughout), so this saves repeating `fps` per entry;
    /// [`FileCfg::fps`] overrides it for the odd one out.
    #[serde(default)]
    pub video_fps: Option<f64>,
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
    /// Per-file playback overrides, keyed by path relative to the party folder
    /// (e.g. `anim/01 - Jaco - Flow/flow.mpg`). Empty for most parties.
    #[serde(default)]
    pub files: IndexMap<String, FileCfg>,
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
            files: IndexMap::new(),
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

    /// Overrides for one file, by its party-relative path. Case-sensitive — the key
    /// has to match the name on disk exactly.
    pub fn file(&self, party_rel: &str) -> Option<&FileCfg> {
        self.files.get(party_rel)
    }

    /// Playback rate for a video: its own override, else its competition's default,
    /// else none (leave the source's declared rate alone).
    pub fn video_fps(&self, party_rel: &str, category: &str) -> Option<f64> {
        if let Some(file) = self.file(party_rel) {
            if file.native_fps {
                return None;
            }
            if file.fps.is_some() {
                return file.fps;
            }
        }
        self.category(category).and_then(|c| c.video_fps)
    }

    /// The js-dos core and DOSBox `cputype` for a DOS executable, by its
    /// party-relative path. `None` when the file has no authored `cputype` (the
    /// default core and `cputype=auto`) or when the value isn't recognised.
    pub fn cpu(&self, party_rel: &str) -> Option<(&'static str, &'static str)> {
        cpu_target(self.file(party_rel)?.cputype.as_deref()?)
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
                        // A mistyped `cputype` is otherwise silent: the file keeps
                        // the default core and the demo fails exactly as before.
                        for (file, f) in &cfg.files {
                            if let Some(cpu) = f.cputype.as_deref() {
                                if cpu_target(cpu).is_none() {
                                    tracing::warn!(
                                        path = %path.display(),
                                        file, cputype = cpu,
                                        "unknown cputype in party config — ignoring it"
                                    );
                                }
                            }
                        }
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
                video_fps: None,
                results: Vec::new(),
                unranked: Default::default(),
            },
        );
        assert!(cfg.is_two_level("amiga"));
        assert!(!cfg.is_two_level("demo"));
    }

    /// Every party config predates `files`/`video_fps`, so both have to be
    /// optional — a config without them must still load.
    #[test]
    fn overrides_are_optional() {
        let cfg: PartyCfg = serde_json::from_str(
            r#"{"slug":"x","name":"X","categories":{"anim":{"compo":"Animation",
               "platform":"video","medium":"animation"}}}"#,
        )
        .unwrap();
        assert!(cfg.files.is_empty());
        assert_eq!(cfg.video_fps("anim/a.mpg", "anim"), None);
        assert_eq!(cfg.cpu("pc/demo/x.exe"), None);
    }

    /// The authored `cputype` picks the core, and `pentium_mmx` has to reach the
    /// conf as `pentium_ii` — neither MMX spelling this core accepts produces a
    /// CPU that reports MMX, so a demo gated on it would still abort.
    #[test]
    fn cputype_selects_the_core() {
        let cfg: PartyCfg = serde_json::from_str(
            r#"{"slug":"botb","name":"B",
                "files":{"pc/11 - byterapers - protocode0x28/PROT0X28.EXE":
                           {"cputype":"pentium_mmx"},
                         "pc/slowdemo/SLOW.EXE":{"cputype":"386_slow"},
                         "pc/typo/T.EXE":{"cputype":"pentum_mmx"}}}"#,
        )
        .unwrap();

        assert_eq!(
            cfg.cpu("pc/11 - byterapers - protocode0x28/PROT0X28.EXE"),
            Some(("dosboxX", "pentium_ii"))
        );
        // The fork's own mode stays reachable, but only if asked for by name.
        assert_eq!(
            cpu_target("jsdos_pentium_mmx"),
            Some(("dosboxX", "jsdos_pentium_mmx"))
        );
        assert_eq!(
            cfg.cpu("pc/slowdemo/SLOW.EXE"),
            Some(("dosbox", "386_slow"))
        );
        // Unknown value → no override at all (warned about at load).
        assert_eq!(cfg.cpu("pc/typo/T.EXE"), None);
        // A file with overrides but no cputype stays on the default core.
        assert_eq!(cfg.cpu("pc/unlisted/U.EXE"), None);
    }

    #[test]
    fn file_overrides_deserialize() {
        let cfg: PartyCfg = serde_json::from_str(
            r#"{"slug":"asm95","name":"Assembly '95",
                "categories":{"anim":{"compo":"Animation","platform":"video",
                  "medium":"animation","video_fps":12.5}},
                "files":{
                  "anim/01 - Jaco - Flow/flow.mpg":{"audio":"anim/01 - Jaco - Flow/flow.snd",
                    "audio_format":"u8","audio_rate":12288,"audio_channels":1},
                  "anim/01 - Vaapukka/x.mpg":{"fps":24}}}"#,
        )
        .unwrap();

        let f = cfg.file("anim/01 - Jaco - Flow/flow.mpg").unwrap();
        assert_eq!(f.audio.as_deref(), Some("anim/01 - Jaco - Flow/flow.snd"));
        assert_eq!(f.audio_format.as_deref(), Some("u8"));
        assert_eq!(f.audio_rate, Some(12288));
        assert_eq!(f.audio_channels, Some(1));
        assert!(f.fps.is_none());

        // No per-file fps → the competition default applies.
        assert_eq!(
            cfg.video_fps("anim/01 - Jaco - Flow/flow.mpg", "anim"),
            Some(12.5)
        );
        // A per-file fps wins over it.
        assert_eq!(
            cfg.video_fps("anim/01 - Vaapukka/x.mpg", "anim"),
            Some(24.0)
        );
        // An unconfigured category has no default at all.
        assert_eq!(cfg.video_fps("demo/whatever.mpg", "demo"), None);
    }

    /// `native_fps` has to beat the competition default, or a container whose own
    /// timestamps are correct (and possibly variable) gets retimed and desyncs.
    #[test]
    fn native_fps_opts_out_of_the_category_default() {
        let cfg: PartyCfg = serde_json::from_str(
            r#"{"slug":"asm95","name":"A",
                "categories":{"anim":{"compo":"Animation","platform":"video",
                  "medium":"animation","video_fps":12.5}},
                "files":{"anim/re-encode.avi":{"native_fps":true}}}"#,
        )
        .unwrap();
        assert_eq!(cfg.video_fps("anim/re-encode.avi", "anim"), None);
        // Its neighbours in the same compo still get the default.
        assert_eq!(cfg.video_fps("anim/raw.mpg", "anim"), Some(12.5));
    }
}

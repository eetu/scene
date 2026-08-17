use std::env;
use std::path::PathBuf;

/// How a root's index is built. The distinction is not cosmetic: an [`Hvsc`]
/// root is never walked or hashed at all.
///
/// [`Hvsc`]: RootKind::Hvsc
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootKind {
    /// Walk the tree, hash the bytes, parse headers — the original pipeline.
    Scan,
    /// The High Voltage SID Collection. Indexed from its own
    /// `DOCUMENTS/Songlengths.md5`, which lists every tune's path, content MD5
    /// and per-subtune lengths — so the whole collection is indexed from one
    /// file read instead of 61k stats and hashes over a network mount.
    /// Read-only: rename/delete are refused on these roots.
    Hvsc,
}

impl RootKind {
    fn parse(s: &str) -> anyhow::Result<Self> {
        match s {
            "scan" => Ok(Self::Scan),
            "hvsc" => Ok(Self::Hvsc),
            other => anyhow::bail!("unknown root kind {other:?} (expected `scan` or `hvsc`)"),
        }
    }

    /// Whether files under this root may be renamed, moved or deleted.
    pub fn writable(self) -> bool {
        matches!(self, Self::Scan)
    }
}

/// One configured collection root. `id` is a stable slug used as the DB key and
/// in the API, so it must stay URL- and filename-safe.
#[derive(Debug, Clone)]
pub struct Root {
    pub id: String,
    pub kind: RootKind,
    pub path: PathBuf,
}

impl Root {
    /// Display name for the source selector. Ids are lowercase slugs; a few
    /// well-known ones have a conventional casing.
    pub fn label(&self) -> String {
        match self.id.as_str() {
            "hvsc" => "HVSC".into(),
            "mods" => "Mods".into(),
            other => scene_backend::capitalize_first(other),
        }
    }
}

/// All durable state is the SQLite cache at `db_path` (a path index of the
/// collection plus parsed metadata). The music itself lives under the
/// configured [`roots`] (NAS mounts in prod). Auth is the edge's job
/// (oauth2-proxy forward-auth headers) or `DEV_AUTH`; see [`crate::auth`].
///
/// The human-asserted relational graph (artist aliases + group memberships,
/// albums, per-song credits) lives in `manifest_path` (`library.json` on the
/// mount) — the source of truth for everything not recomputable from the bytes.
/// It describes the module collection only, so it hangs off the primary root.
///
/// [`roots`]: Config::roots
#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    /// When set, `/api/*` is reachable without forward-auth headers. Enabled by
    /// `DEV_AUTH=1` (local dev) or `TRACKER_OPEN=1` (a LAN-only deploy with no
    /// oauth2-proxy in front — the collection is a single shared read-only
    /// library, so edge SSO is optional when the host is network-restricted).
    pub dev_auth: bool,
    /// The configured collection roots, in declaration order. Never empty; the
    /// first is the primary (see [`Config::primary`]).
    pub roots: Vec<Root>,
    /// SQLite cache file (path index + parsed metadata).
    pub db_path: PathBuf,
    /// Directory of the built SPA to serve (Vite `dist/`).
    pub static_dir: PathBuf,
    /// Base for Modland — the md5→author index (`allmods.zip`) and by-md5 module
    /// downloads used to fetch a playlist's missing songs. Overridable for tests.
    pub modland_base: String,
    /// The library manifest (`library.json`). Defaults to
    /// `<primary root>/library.json`, overridable with `TRACKER_MANIFEST`.
    pub manifest_path: PathBuf,
    /// How long to play a SID that has no known length, in seconds.
    ///
    /// A SID header carries no duration at all — HVSC's Songlengths database is
    /// the only real source, and that covers HVSC tunes only. A hand-dropped SID
    /// therefore has nothing to auto-advance on, so playback falls back to this.
    /// 180s is the sidplayfp convention. It is deliberately *not* written into
    /// the track's `duration`: the listing keeps showing "unknown" rather than
    /// claiming every SID is exactly three minutes.
    pub sid_default_length: u32,
    /// Directory holding the C64 system ROMs, served to the browser for SID
    /// playback (`TRACKER_ROMS_DIR`).
    ///
    /// KERNAL / BASIC / CHARGEN are Commodore copyright, so they are never
    /// bundled or baked into an image — the operator supplies them, exactly like
    /// the Amiga Kickstart (see `THIRD_PARTY_NOTICES.md`). Unset simply means no
    /// ROMs: libsidplayfp falls back to built-in images and most tunes still
    /// play, but a BASIC-driven RSID renders as near-silence.
    pub roms_dir: Option<PathBuf>,
    /// Directory of built visualiser reels (`<id>.bin` — see the player's
    /// `assets/README.md`), served by `/api/reels`. Defaults to
    /// `<primary root>/.support/reels`, overridable with `TRACKER_REELS_DIR`.
    ///
    /// On the mount rather than in the image, and for the same reason as the ROMs:
    /// a reel is derived frames of somebody else's video, so the operator builds
    /// it from a file they have and neither this repository nor the image CI
    /// produces ever carries one. An empty or missing directory simply means the
    /// visualisers show their own faces.
    pub reels_dir: Option<PathBuf>,
}

impl Config {
    /// The root that receives writes — Modland fetches land here, and it owns
    /// the manifest. The first declared root, which `TRACKER_ROOT` makes `mods`.
    pub fn primary(&self) -> &Root {
        &self.roots[0]
    }

    pub fn root(&self, id: &str) -> Option<&Root> {
        self.roots.iter().find(|r| r.id == id)
    }

    pub fn from_env() -> anyhow::Result<Self> {
        let dev_auth = env::var("DEV_AUTH").as_deref() == Ok("1")
            || env::var("TRACKER_OPEN").as_deref() == Ok("1");
        let roots = Self::roots_from_env()?;
        let manifest_path = env::var("TRACKER_MANIFEST")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| roots[0].path.join("library.json"));
        // Both read `roots` before it is moved into the struct below.
        //
        // Under `.support` on the primary root, which is where this collection already
        // keeps operator-supplied binaries — the C64 ROMs and the Amiga Kickstart. The
        // dot matters: the scanner does not descend into a hidden directory, so a reel
        // costs the walk nothing on a mount where the scan is latency-bound. It also
        // means prod needs no configuration, since the share is mounted at the root.
        let reels_dir = env::var("TRACKER_REELS_DIR")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| roots[0].path.join(".support").join("reels"));
        Ok(Self {
            dev_auth,
            bind: env::var("TRACKER_BIND").unwrap_or_else(|_| "0.0.0.0:3010".into()),
            roots,
            db_path: PathBuf::from(
                env::var("TRACKER_DB_PATH").unwrap_or_else(|_| "tracker.db".into()),
            ),
            static_dir: PathBuf::from(env::var("STATIC_DIR").unwrap_or_else(|_| "./dist".into())),
            modland_base: env::var("MODLAND_BASE")
                .unwrap_or_else(|_| "https://ftp.modland.com".into()),
            manifest_path,
            roms_dir: env::var("TRACKER_ROMS_DIR")
                .ok()
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
            // Defaults to `reels/` on the primary root, so a built clip dropped on the
            // mount is found with no configuration — the same habit as the manifest.
            reels_dir: Some(reels_dir),
            sid_default_length: env::var("TRACKER_SID_DEFAULT_LENGTH")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|v| *v > 0)
                .unwrap_or(180),
        })
    }

    /// `TRACKER_ROOTS` wins; `TRACKER_ROOT` remains as sugar for a single
    /// module root, so existing deploys and `.env` files keep working.
    fn roots_from_env() -> anyhow::Result<Vec<Root>> {
        let spec = env::var("TRACKER_ROOTS")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let roots = match spec {
            Some(spec) => parse_roots(&spec)?,
            None => {
                let path = env::var("TRACKER_ROOT")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "TRACKER_ROOTS or TRACKER_ROOT is required \
                             (TRACKER_ROOTS=id:kind:path[,id:kind:path…])"
                        )
                    })?;
                vec![Root {
                    id: "mods".into(),
                    kind: RootKind::Scan,
                    path,
                }]
            }
        };
        for r in &roots {
            if !r.path.is_dir() {
                anyhow::bail!("root {} path {} is not a directory", r.id, r.path.display());
            }
        }
        Ok(roots)
    }
}

/// Parse `id:kind:path[,id:kind:path…]`. Split is `splitn(3, ':')` so a path may
/// contain colons; a path containing a comma cannot be expressed and is refused
/// by the emptiness check rather than silently truncated.
fn parse_roots(spec: &str) -> anyhow::Result<Vec<Root>> {
    let mut roots: Vec<Root> = Vec::new();
    for entry in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let mut parts = entry.splitn(3, ':');
        let (Some(id), Some(kind), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            anyhow::bail!("root entry {entry:?} is not `id:kind:path`");
        };
        let (id, path) = (id.trim(), path.trim());
        if id.is_empty() || path.is_empty() {
            anyhow::bail!("root entry {entry:?} has an empty id or path");
        }
        if !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            anyhow::bail!("root id {id:?} must be lowercase ascii, digits or `-`");
        }
        if roots.iter().any(|r| r.id == id) {
            anyhow::bail!("duplicate root id {id:?}");
        }
        roots.push(Root {
            id: id.into(),
            kind: RootKind::parse(kind.trim())?,
            path: PathBuf::from(path),
        });
    }
    if roots.is_empty() {
        anyhow::bail!("TRACKER_ROOTS is set but declares no roots");
    }
    Ok(roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiple_roots() {
        let roots = parse_roots("mods:scan:/a/mods, hvsc:hvsc:/b/C64Music").unwrap();
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].id, "mods");
        assert_eq!(roots[0].kind, RootKind::Scan);
        assert_eq!(roots[1].kind, RootKind::Hvsc);
        assert_eq!(roots[1].path, PathBuf::from("/b/C64Music"));
    }

    #[test]
    fn keeps_colons_in_paths() {
        let roots = parse_roots("mods:scan:/vol/odd:name").unwrap();
        assert_eq!(roots[0].path, PathBuf::from("/vol/odd:name"));
    }

    #[test]
    fn rejects_duplicate_ids_and_bad_kinds() {
        assert!(parse_roots("mods:scan:/a,mods:scan:/b").is_err());
        assert!(parse_roots("mods:walk:/a").is_err());
        assert!(parse_roots("Mods:scan:/a").is_err());
        assert!(parse_roots("mods:scan").is_err());
    }

    #[test]
    fn labels_known_ids() {
        let mk = |id: &str| Root {
            id: id.into(),
            kind: RootKind::Scan,
            path: PathBuf::new(),
        };
        assert_eq!(mk("hvsc").label(), "HVSC");
        assert_eq!(mk("mods").label(), "Mods");
        assert_eq!(mk("chiptunes").label(), "Chiptunes");
    }

    #[test]
    fn only_scan_roots_are_writable() {
        assert!(RootKind::Scan.writable());
        assert!(!RootKind::Hvsc.writable());
    }
}

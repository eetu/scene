use std::env;
use std::path::PathBuf;

/// All durable state is the SQLite cache at `db_path` (a path index of the
/// `Parties/` tree plus parsed enrichment keyed by content hash) and the
/// derived-asset cache under `cache_dir` (transcoded images/videos). The party
/// content itself lives read-only under `root` (a NAS mount in prod). Auth is
/// the edge's job (oauth2-proxy forward-auth headers) or `DEV_AUTH`; see
/// [`crate::auth`].
#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    /// When set, `/api/*` is reachable without forward-auth headers. Enabled by
    /// `DEV_AUTH=1` (local dev) or `PARTY_OPEN=1` (a LAN-only deploy with no
    /// oauth2-proxy in front).
    pub dev_auth: bool,
    /// Read-only public mode (`PARTY_KIOSK=1`). Refuses operator mutations
    /// (`POST /api/rescan` → 403) and redacts the filesystem `root` from
    /// `/status`, so a publicly-exposed instance is browse/play/run only. This is
    /// orthogonal to auth: `dev_auth`/`PARTY_OPEN` controls *who* can reach the
    /// API; `kiosk` controls *what actions exist*. The immutable data-image
    /// deploy runs with this on (the tree never changes at runtime, so rescan is
    /// meaningless there). The initial boot scan still runs; only the
    /// operator-triggered rescan endpoint is disabled. `/api/meta` enrichment
    /// stays on — it's idempotent and content-hash-keyed.
    pub kiosk: bool,
    /// Root of the `Parties/` tree. Each immediate subdirectory is one party.
    pub root: PathBuf,
    /// Directory of checked-in per-party config JSONs (`<slug>.json`).
    pub config_dir: PathBuf,
    /// Directory for derived (transcoded) assets, owned by us.
    pub cache_dir: PathBuf,
    /// SQLite cache file (path index + parsed metadata).
    pub db_path: PathBuf,
    /// Directory of the built SPA to serve (Vite `dist/`).
    pub static_dir: PathBuf,
    /// Shared, *unscanned* support data spanning all parties (e.g. emulator BIOS
    /// ROMs). Defaults to `<root>/.support` — a dot-dir the scanner skips. Served
    /// read-only via `/api/support/{file}`.
    pub support_dir: PathBuf,
    /// Transcoder sidecar base URL (Phase 2). Optional — image/video assets are
    /// unavailable until it is configured and reachable.
    pub transcoder_url: Option<String>,
    /// Optional bearer shared with the transcoder.
    pub transcoder_token: Option<String>,
}

fn env_path(key: &str, default: &str) -> PathBuf {
    PathBuf::from(env::var(key).unwrap_or_else(|_| default.into()))
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let dev_auth = env::var("DEV_AUTH").as_deref() == Ok("1")
            || env::var("PARTY_OPEN").as_deref() == Ok("1");
        let kiosk = env::var("PARTY_KIOSK").as_deref() == Ok("1");
        let root = env::var("PARTY_ROOT")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| anyhow::anyhow!("PARTY_ROOT is required (path to the Parties/ tree)"))?;
        if !root.is_dir() {
            anyhow::bail!("PARTY_ROOT {} is not a directory", root.display());
        }
        let support_dir = env::var("PARTY_SUPPORT_DIR")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join(".support"));
        Ok(Self {
            dev_auth,
            kiosk,
            bind: env::var("PARTY_BIND").unwrap_or_else(|_| "0.0.0.0:3020".into()),
            support_dir,
            root,
            config_dir: env_path("PARTY_CONFIG_DIR", "./parties"),
            cache_dir: env_path("PARTY_CACHE_DIR", "./cache"),
            db_path: env_path("PARTY_DB_PATH", "party.db"),
            static_dir: env_path("STATIC_DIR", "./dist"),
            transcoder_url: env::var("PARTY_TRANSCODER_URL")
                .ok()
                .filter(|s| !s.is_empty()),
            transcoder_token: env::var("PARTY_TRANSCODER_TOKEN")
                .ok()
                .filter(|s| !s.is_empty()),
        })
    }
}

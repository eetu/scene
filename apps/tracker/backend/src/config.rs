use std::env;
use std::path::PathBuf;

/// All durable state is the SQLite cache at `db_path` (a path index of the
/// collection plus libopenmpt-parsed metadata keyed by content hash). The
/// modules themselves live read-only under `root` (a NAS mount in prod). Auth
/// is the edge's job (oauth2-proxy forward-auth headers) or `DEV_AUTH`; see
/// [`crate::auth`].
#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    /// When set, `/api/*` is reachable without forward-auth headers. Enabled by
    /// `DEV_AUTH=1` (local dev) or `TRACKER_OPEN=1` (a LAN-only deploy with no
    /// oauth2-proxy in front — the collection is a single shared read-only
    /// library, so edge SSO is optional when the host is network-restricted).
    pub dev_auth: bool,
    /// Root of the module collection. Required — the scanner walks this tree.
    pub root: PathBuf,
    /// SQLite cache file (path index + parsed metadata).
    pub db_path: PathBuf,
    /// Directory of the built SPA to serve (Vite `dist/`).
    pub static_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let dev_auth = env::var("DEV_AUTH").as_deref() == Ok("1")
            || env::var("TRACKER_OPEN").as_deref() == Ok("1");
        let root = env::var("TRACKER_ROOT")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                anyhow::anyhow!("TRACKER_ROOT is required (path to the module collection)")
            })?;
        if !root.is_dir() {
            anyhow::bail!("TRACKER_ROOT {} is not a directory", root.display());
        }
        Ok(Self {
            dev_auth,
            bind: env::var("TRACKER_BIND").unwrap_or_else(|_| "0.0.0.0:3010".into()),
            root,
            db_path: PathBuf::from(
                env::var("TRACKER_DB_PATH").unwrap_or_else(|_| "tracker.db".into()),
            ),
            static_dir: PathBuf::from(env::var("STATIC_DIR").unwrap_or_else(|_| "./dist".into())),
        })
    }
}

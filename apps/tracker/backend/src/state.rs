use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Arc;

use crate::config::Config;
use crate::db::Db;
use crate::manifest::ManifestStore;

/// Live scan progress, updated by the scanner via lock-free atomics. It is
/// deliberately *not* DB-backed: the scan holds the single SQLite connection
/// for its whole duration, so progress must be readable without touching the
/// DB (see `routes::status`). `total` is 0 until the count pass finishes.
#[derive(Default)]
pub struct ScanProgress {
    pub scanning: AtomicBool,
    pub total: AtomicUsize,
    pub processed: AtomicUsize,
    pub hashed: AtomicUsize,
}

/// Live progress for a playlist "fetch missing" run (download missing md5s via
/// Modland → rescan). Lock-free like [`ScanProgress`] so `/api/fetch/status`
/// reports it while the rescan holds the DB. `running` gates one fetch at a time.
#[derive(Default)]
pub struct FetchProgress {
    pub running: AtomicBool,
    /// Missing items to fetch this run.
    pub total: AtomicUsize,
    /// Fetched (downloaded + written) so far.
    pub fetched: AtomicUsize,
    /// Items that failed (not in Modland / download error).
    pub failed: AtomicUsize,
}

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: Db,
    pub scan: Arc<ScanProgress>,
    pub fetch: Arc<FetchProgress>,
    /// The library manifest (`library.json`) — aliases, group memberships,
    /// albums, per-song credits. Loaded at boot; swapped in place on reload /
    /// curation edits.
    pub manifest: Arc<ManifestStore>,
}

impl AppState {
    pub fn new(cfg: Config, db: Db) -> Self {
        let manifest = Arc::new(ManifestStore::open(cfg.manifest_path.clone()));
        Self {
            cfg: Arc::new(cfg),
            db,
            scan: Arc::new(ScanProgress::default()),
            fetch: Arc::new(FetchProgress::default()),
            manifest,
        }
    }
}

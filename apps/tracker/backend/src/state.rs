use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Arc;

use crate::config::Config;
use crate::db::Db;

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

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: Db,
    pub scan: Arc<ScanProgress>,
}

impl AppState {
    pub fn new(cfg: Config, db: Db) -> Self {
        Self {
            cfg: Arc::new(cfg),
            db,
            scan: Arc::new(ScanProgress::default()),
        }
    }
}

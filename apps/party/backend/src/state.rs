use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, RwLock};

use crate::config::Config;
use crate::db::Db;
use crate::party::PartyConfigs;

/// Live scan progress, updated by the scanner via lock-free atomics. Not
/// DB-backed: the scan holds the single SQLite connection for its whole
/// duration, so progress must be readable without touching the DB.
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
    // Swappable so `reload_parties()` can pick up `.party.json` edits on a rescan
    // without restarting the process (configs are only read at scan + request time).
    pub parties: Arc<RwLock<Arc<PartyConfigs>>>,
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(cfg: Config, db: Db, parties: PartyConfigs) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("party/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("reqwest client");
        Self {
            cfg: Arc::new(cfg),
            db,
            scan: Arc::new(ScanProgress::default()),
            parties: Arc::new(RwLock::new(Arc::new(parties))),
            http,
        }
    }

    /// Current party configs (cheap `Arc` clone of the live snapshot).
    pub fn parties(&self) -> Arc<PartyConfigs> {
        self.parties.read().unwrap().clone()
    }

    /// Re-read every `.party.json` under the root so config edits take effect on
    /// the next scan without a process restart.
    pub fn reload_parties(&self) {
        let fresh = PartyConfigs::load(&self.cfg.root);
        *self.parties.write().unwrap() = Arc::new(fresh);
    }
}

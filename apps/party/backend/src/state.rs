use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Arc;

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
    pub parties: Arc<PartyConfigs>,
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
            parties: Arc::new(parties),
            http,
        }
    }
}

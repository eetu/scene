pub mod auth;
pub mod config;
pub mod db;
pub mod enrich;
pub mod error;
pub mod hvsc;
pub mod library;
pub mod manifest;
pub mod modland;
pub mod routes;
pub mod scan;
pub mod sid;
pub mod state;

use std::path::PathBuf;
use std::sync::Arc;

use tower_http::set_header::SetResponseHeaderLayer;
use tracing_subscriber::EnvFilter;

use config::Config;
use db::Db;
use scan::ScanResult;
use state::{AppState, ScanProgress};

/// Run a full scan of one root on a blocking thread (hashing new files can take
/// minutes over CIFS) and return the reconciliation counts. Flips the `scanning`
/// flag so `/status` can report live progress without touching the (locked) DB.
pub async fn run_scan(
    db: Db,
    root_id: String,
    root: PathBuf,
    progress: Arc<ScanProgress>,
) -> anyhow::Result<ScanResult> {
    // Own the `scanning` flag INSIDE the blocking task, not around the `.await`.
    // spawn_blocking runs to completion even if the awaiting future is cancelled
    // — e.g. the client aborts POST /api/rescan (a UI reload / navigation) — so
    // resetting the flag after the await would leak `scanning = true` forever
    // while the scan actually finished. A drop guard resets it on any exit
    // (return, error, or panic), and the blocking task can't be cancelled.
    tokio::task::spawn_blocking(move || {
        let _done = scene_backend::scan::ScanFlagGuard::set(progress.clone());
        let mut conn = db.blocking_lock();
        let result = scan::scan_into(&mut conn, &root_id, &root, &progress);

        // Publish the outcome *here*, inside the blocking task, so it is written
        // before `_done` clears `scanning` — the SPA polls "scanning went false
        // → read last_scan" and must never see the gap. It also makes
        // `last_scan` an invariant of "a scan finished" (the boot scan included),
        // not of "someone asked for one over HTTP".
        if let Ok(mut slot) = progress.last.lock() {
            let (counts, error) = match &result {
                Ok(r) => ((r.indexed, r.hashed, r.removed), None),
                Err(e) => ((0, 0, 0), Some(e.to_string())),
            };
            *slot = Some(state::ScanOutcome {
                root: root_id.clone(),
                indexed: counts.0,
                hashed: counts.1,
                removed: counts.2,
                finished_at: chrono::Utc::now().to_rfc3339(),
                error,
            });
        }
        result
    })
    .await?
}

/// Index one HVSC root from its own songlengths database. Blocking (one 5 MB
/// read plus a transaction), so it runs on the blocking pool like a scan, and
/// flips the same `scanning` flag so `/status` reports it.
pub async fn run_hvsc_index(
    db: Db,
    root_id: String,
    root: PathBuf,
    progress: Arc<ScanProgress>,
) -> anyhow::Result<hvsc::IndexResult> {
    tokio::task::spawn_blocking(move || {
        let _done = scene_backend::scan::ScanFlagGuard::set(progress.clone());
        let mut conn = db.blocking_lock();
        hvsc::index_into(&mut conn, &root_id, &root)
    })
    .await?
}

pub async fn run_server() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tracker_backend=debug")),
        )
        .init();

    let cfg = Config::from_env()?;
    if cfg.dev_auth {
        tracing::warn!("DEV_AUTH=1 — forward-auth gate bypassed; do not use in prod");
    }

    let db = Db::open(&cfg.db_path)
        .map_err(|e| anyhow::anyhow!("db {} unusable: {e}", cfg.db_path.display()))?;

    let state = AppState::new(cfg, db);
    let bind = state.cfg.bind.clone();

    // Only scan automatically on first run (empty cache). On a normal restart we
    // serve the persisted index instantly — re-walking the NAS over CIFS on
    // every boot is the slow part. Use `POST /api/rescan` to pick up on-disk
    // changes; in-app renames already keep the index in sync without a scan.
    let track_count: i64 = state
        .db
        .with(|c| c.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0)))
        .await
        .unwrap_or(0);
    if track_count == 0 {
        let db = state.db.clone();
        let root_id = state.cfg.primary().id.clone();
        let root = state.cfg.primary().path.clone();
        let progress = state.scan.clone();
        tokio::spawn(async move {
            tracing::info!(root = %root.display(), "empty index — initial scan started");
            match run_scan(db, root_id, root, progress).await {
                Ok(r) => tracing::info!(
                    indexed = r.indexed,
                    hashed = r.hashed,
                    "initial scan complete"
                ),
                Err(e) => tracing::error!(error = %e, "initial scan failed"),
            }
        });
        // (falls through to the HVSC check below)
    } else {
        tracing::info!(
            track_count,
            "serving cached index; POST /api/rescan to refresh"
        );
    }

    // HVSC roots index themselves from their own catalogue, which costs one
    // stat to check and seconds to redo — so unlike a filesystem scan this can
    // run at every boot. Unchanged release → nothing happens; a newly mounted
    // one is picked up without anyone pressing a button.
    for root in state
        .cfg
        .roots
        .iter()
        .filter(|r| r.kind == config::RootKind::Hvsc)
    {
        let (id, path) = (root.id.clone(), root.path.clone());
        if !hvsc::looks_like_hvsc(&path) {
            tracing::warn!(
                root = %id, path = %path.display(),
                "root is configured as hvsc but has no DOCUMENTS/Songlengths.md5 — skipping"
            );
            continue;
        }
        let current = state
            .db
            .with({
                let (id, path) = (id.clone(), path.clone());
                move |c| Ok(hvsc::is_current(c, &id, &path))
            })
            .await
            .unwrap_or(false);
        if current {
            tracing::info!(root = %id, "HVSC index is current");
            continue;
        }
        let (db, progress) = (state.db.clone(), state.scan.clone());
        tokio::spawn(async move {
            tracing::info!(root = %id, "indexing HVSC from its songlengths database");
            match run_hvsc_index(db, id.clone(), path, progress).await {
                Ok(r) => tracing::info!(
                    root = %id, tunes = r.tunes, subtunes = r.subtunes, removed = r.removed,
                    "HVSC index complete"
                ),
                Err(e) => tracing::error!(root = %id, error = %e, "HVSC index failed"),
            }
        });
    }

    // Hash the SPA's inline bootstrap script(s) so the CSP can allow exactly
    // them. Read once at boot; the built index.html is immutable for the run.
    let index_path = state.cfg.static_dir.join("index.html");
    let hashes = std::fs::read_to_string(&index_path)
        .map(|h| scene_backend::csp::inline_script_hashes(&h))
        .unwrap_or_default();
    if hashes.is_empty() {
        tracing::warn!(
            path = %index_path.display(),
            "no inline-script hashes (index.html missing or no inline scripts); \
             CSP script-src has no hashes"
        );
    }
    // No emulator blobs here, but `'unsafe-eval'` is still required — by the SID
    // engine, and only by it: libsidplayfp is bound through Emscripten's Embind,
    // which builds its invokers with the `Function` constructor (string
    // evaluation, which `'wasm-unsafe-eval'` does not cover). libopenmpt uses
    // `cwrap` and needs none of this — which is why modules played and SIDs died
    // only once the app was served by *this* backend; `vite preview` (what the
    // e2e runs against) sends no CSP. Narrowing it means rebuilding the wasm
    // with `-sDYNAMIC_EXECUTION=0` — upstream work. See scene_backend::csp.
    let csp_value =
        axum::http::HeaderValue::from_str(&scene_backend::csp::build_csp(&hashes, false))
            .map_err(|e| anyhow::anyhow!("invalid CSP header: {e}"))?;
    let app = routes::router(state).layer(SetResponseHeaderLayer::if_not_present(
        axum::http::header::CONTENT_SECURITY_POLICY,
        csp_value,
    ));

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "tracker listening");
    axum::serve(listener, app).await?;
    Ok(())
}

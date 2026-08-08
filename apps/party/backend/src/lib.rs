pub mod auth;
pub mod config;
pub mod cp437;
pub mod db;
pub mod error;
pub mod party;
pub mod results;
pub mod routes;
pub mod scan;
pub mod state;
pub mod transcoder;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tower_http::set_header::SetResponseHeaderLayer;
use tracing_subscriber::EnvFilter;

use config::Config;
use db::Db;
use party::PartyConfigs;
use scan::ScanResult;
use state::{AppState, ScanProgress};

/// Run a full scan on a blocking thread and return the reconciliation counts.
pub async fn run_scan(
    db: Db,
    root: PathBuf,
    parties: Arc<PartyConfigs>,
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
        scan::scan_into(&mut conn, &root, &parties, &progress)
    })
    .await?
}

/// Whether real party data is present under `root`. The mountpoint always
/// exists, so `exists()` proves nothing; require at least one non-hidden,
/// non-empty subdirectory (a party folder like `Assembly95`). A mounted-but-empty
/// volume — a bad data-image build, or content not yet materialized — fails this,
/// which keeps the startup (re)scan from clobbering a good index with an empty one.
fn data_present(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.file_type().is_ok_and(|t| t.is_dir())
            && !e.file_name().to_string_lossy().starts_with('.')
            && std::fs::read_dir(e.path()).is_ok_and(|mut it| it.next().is_some())
    })
}

pub async fn run_server() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,party_backend=debug")),
        )
        .init();

    let cfg = Config::from_env()?;
    if cfg.dev_auth {
        tracing::warn!("DEV_AUTH/PARTY_OPEN set — forward-auth gate bypassed; do not use in prod");
    }
    std::fs::create_dir_all(&cfg.cache_dir).ok();

    let parties = PartyConfigs::load(&cfg.root);

    let db = Db::open(&cfg.db_path)
        .map_err(|e| anyhow::anyhow!("db {} unusable: {e}", cfg.db_path.display()))?;

    let state = AppState::new(cfg, db, parties);
    let bind = state.cfg.bind.clone();

    // Scan on startup when the index is empty — or always in kiosk mode. A kiosk
    // serves an immutable data image that gets swapped for a new version on
    // deploy, and it disables the manual rescan endpoint, so it must refresh
    // itself on boot to pick up the new image. The hash cache (path+size+mtime →
    // hash) keeps an unchanged rescan cheap. Non-kiosk (admin/dev) keeps the
    // cached index and refreshes via POST /api/rescan.
    let file_count: i64 = state
        .db
        .with(|c| c.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0)))
        .await
        .unwrap_or(0);
    let want_scan = file_count == 0 || state.cfg.kiosk;
    if want_scan && !data_present(&state.cfg.root) {
        // PARTY_ROOT is the mountpoint and always exists, so existence proves
        // nothing — real data means at least one non-empty party subdir (e.g.
        // `Assembly95`). None here = a mounted-but-empty volume (a bad data-image
        // build / wrong content) or a first boot with no archive. Do NOT rescan
        // an empty tree: that would clobber the last-known-good `/data` index and
        // (in kiosk) publish an empty library. Skip the scan, keep serving the
        // existing index, and log loudly — better a visible misbuild than a
        // crash-looped public endpoint.
        tracing::error!(
            root = %state.cfg.root.display(),
            indexed = file_count,
            "no party data under PARTY_ROOT (mounted-but-empty / bad data image?) — \
             skipping startup scan, serving the existing index; check the data image build"
        );
    } else if want_scan {
        let db = state.db.clone();
        let root = state.cfg.root.clone();
        let parties = state.parties();
        let progress = state.scan.clone();
        let reason = if file_count == 0 {
            "empty index"
        } else {
            "kiosk startup"
        };
        tokio::spawn(async move {
            tracing::info!(root = %root.display(), %reason, "scan started");
            match run_scan(db, root, parties, progress).await {
                Ok(r) => tracing::info!(
                    indexed = r.indexed,
                    hashed = r.hashed,
                    productions = r.productions,
                    parties = r.parties,
                    "initial scan complete"
                ),
                Err(e) => tracing::error!(error = %e, "initial scan failed"),
            }
        });
    } else {
        tracing::info!(
            file_count,
            "serving cached index; POST /api/rescan to refresh"
        );
    }

    let index_path = state.cfg.static_dir.join("index.html");
    let hashes = std::fs::read_to_string(&index_path)
        .map(|h| scene_backend::csp::inline_script_hashes(&h))
        .unwrap_or_default();
    if hashes.is_empty() {
        tracing::warn!(
            path = %index_path.display(),
            "no inline-script hashes (index.html missing or no inline scripts)"
        );
    }
    // `emulator_blobs`: js-dos and EmulatorJS's libretro cores `eval()` JS at
    // runtime (only `'unsafe-eval'` permits that), and EmulatorJS decompresses
    // its core to a `blob:` URL and runs/fetches it from there — so `blob:`
    // joins `script-src`/`connect-src`/`media-src`. Acceptable here: a LAN-only
    // archive whose whole point is running sandboxed WASM demos. See
    // scene_backend::csp.
    let csp_value =
        axum::http::HeaderValue::from_str(&scene_backend::csp::build_csp(&hashes, true))
            .map_err(|e| anyhow::anyhow!("invalid CSP header: {e}"))?;
    // Cross-origin isolation (COOP + COEP) exposes SharedArrayBuffer, which lets
    // the WASM emulators (EmulatorJS) run their cores in a worker thread — far
    // smoother in fullscreen, and required for heavier cores. Safe here because
    // everything we load is same-origin (fonts self-hosted; no cross-origin
    // subresources). js-dos stays single-threaded regardless.
    use axum::http::{HeaderName, HeaderValue};
    let app = routes::router(state)
        .layer(SetResponseHeaderLayer::if_not_present(
            axum::http::header::CONTENT_SECURITY_POLICY,
            csp_value,
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
        ));

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "party listening");
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_present_requires_nonempty_party_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(!data_present(root), "empty mountpoint is not ready");
        std::fs::create_dir(root.join("empty")).unwrap();
        assert!(!data_present(root), "an empty subdir doesn't count");
        std::fs::write(root.join("stray.txt"), b"x").unwrap();
        assert!(!data_present(root), "a top-level file isn't a party folder");
        std::fs::create_dir(root.join(".hidden")).unwrap();
        std::fs::write(root.join(".hidden/x"), b"x").unwrap();
        assert!(!data_present(root), "a hidden non-empty dir doesn't count");
        std::fs::create_dir(root.join("Assembly95")).unwrap();
        std::fs::write(root.join("Assembly95/results.txt"), b"x").unwrap();
        assert!(data_present(root), "a non-empty party subdir → ready");
    }
}

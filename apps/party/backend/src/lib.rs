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

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tower_http::set_header::SetResponseHeaderLayer;
use tracing_subscriber::EnvFilter;

use config::Config;
use db::Db;
use party::PartyConfigs;
use scan::ScanResult;
use state::{AppState, ScanProgress};

/// Content-Security-Policy. Same-origin plus the Google Fonts hosts halo-design
/// uses. The music player runs libopenmpt as WebAssembly inside an AudioWorklet
/// (`'wasm-unsafe-eval'`). The emulators go further: js-dos and EmulatorJS's
/// libretro cores `eval()` JavaScript at runtime (the cores ship as code the
/// loader evaluates), which only `'unsafe-eval'` permits — `'wasm-unsafe-eval'`
/// alone blocks it. Acceptable here: a LAN-only archive whose whole point is
/// running sandboxed WASM demos. Plus `worker-src 'self' blob:`. HSTS /
/// X-Frame-Options are the edge's job.
fn build_csp(script_hashes: &[String]) -> String {
    let mut script_src = String::from("'self' 'wasm-unsafe-eval' 'unsafe-eval'");
    for h in script_hashes {
        script_src.push(' ');
        script_src.push_str(h);
    }
    format!(
        "default-src 'self'; \
         script-src {script_src}; \
         style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; \
         font-src 'self' data: https://fonts.gstatic.com; \
         img-src 'self' data: blob:; \
         media-src 'self' blob:; \
         connect-src 'self'; \
         worker-src 'self' blob:; \
         child-src 'self' blob:; \
         frame-ancestors 'none'; \
         base-uri 'self'; \
         object-src 'none'; \
         form-action 'self'"
    )
}

/// CSP `'sha256-…'` source for every inline `<script>` (no `src=`) in `html`.
fn inline_script_hashes(html: &str) -> Vec<String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    let mut out = Vec::new();
    let mut idx = 0;
    while let Some(rel) = html[idx..].find("<script") {
        let tag = idx + rel;
        let Some(gt) = html[tag..].find('>') else {
            break;
        };
        let open = &html[tag..tag + gt + 1];
        let body_start = tag + gt + 1;
        let Some(close) = html[body_start..].find("</script>") else {
            break;
        };
        let body = &html[body_start..body_start + close];
        if !open.contains("src=") {
            let digest = Sha256::digest(body.as_bytes());
            out.push(format!("'sha256-{}'", STANDARD.encode(digest)));
        }
        idx = body_start + close + "</script>".len();
    }
    out
}

/// Run a full scan on a blocking thread and return the reconciliation counts.
pub async fn run_scan(
    db: Db,
    root: PathBuf,
    parties: Arc<PartyConfigs>,
    progress: Arc<ScanProgress>,
) -> anyhow::Result<ScanResult> {
    progress.scanning.store(true, Ordering::Relaxed);
    let joined = tokio::task::spawn_blocking({
        let progress = progress.clone();
        move || {
            let mut conn = db.blocking_lock();
            scan::scan_into(&mut conn, &root, &parties, &progress)
        }
    })
    .await;
    progress.scanning.store(false, Ordering::Relaxed);
    joined?
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

    let parties = PartyConfigs::load(&cfg.config_dir);

    let db = Db::open(&cfg.db_path)
        .map_err(|e| anyhow::anyhow!("db {} unusable: {e}", cfg.db_path.display()))?;

    let state = AppState::new(cfg, db, parties);
    let bind = state.cfg.bind.clone();

    // Only scan automatically on first run (empty index). Use POST /api/rescan
    // to pick up on-disk changes.
    let file_count: i64 = state
        .db
        .with(|c| c.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0)))
        .await
        .unwrap_or(0);
    if file_count == 0 {
        let db = state.db.clone();
        let root = state.cfg.root.clone();
        let parties = state.parties.clone();
        let progress = state.scan.clone();
        tokio::spawn(async move {
            tracing::info!(root = %root.display(), "empty index — initial scan started");
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
        tracing::info!(file_count, "serving cached index; POST /api/rescan to refresh");
    }

    let index_path = state.cfg.static_dir.join("index.html");
    let hashes = std::fs::read_to_string(&index_path)
        .map(|h| inline_script_hashes(&h))
        .unwrap_or_default();
    if hashes.is_empty() {
        tracing::warn!(
            path = %index_path.display(),
            "no inline-script hashes (index.html missing or no inline scripts)"
        );
    }
    let csp_value = axum::http::HeaderValue::from_str(&build_csp(&hashes))
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
    fn hashes_inline_scripts_skips_external() {
        let html = r#"<script src="/app.js"></script><script>abc</script>"#;
        assert_eq!(
            inline_script_hashes(html),
            vec!["'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='"]
        );
    }

    #[test]
    fn csp_allows_wasm_and_media() {
        let csp = build_csp(&["'sha256-X'".into()]);
        assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' 'sha256-X'"));
        assert!(csp.contains("worker-src 'self' blob:"));
        assert!(csp.contains("media-src 'self' blob:"));
    }
}

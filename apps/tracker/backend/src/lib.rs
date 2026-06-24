pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod routes;
pub mod scan;
pub mod state;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tower_http::set_header::SetResponseHeaderLayer;
use tracing_subscriber::EnvFilter;

use config::Config;
use db::Db;
use scan::ScanResult;
use state::{AppState, ScanProgress};

/// Content-Security-Policy. Same-origin except the Google Fonts hosts
/// halo-design uses. The player runs libopenmpt as WebAssembly inside an
/// AudioWorklet, so we additionally allow `'wasm-unsafe-eval'` (wasm
/// instantiation) and `worker-src 'self' blob:` (the worklet module). HSTS /
/// X-Frame-Options / X-Content-Type-Options are Traefik's job, not ours.
///
/// SvelteKit inlines its bootstrap `<script>` in index.html with a per-build
/// hash, so we hash whatever inline scripts the built index.html contains at
/// boot and allow exactly those — no `'unsafe-inline'` for scripts.
fn build_csp(script_hashes: &[String]) -> String {
    let mut script_src = String::from("'self' 'wasm-unsafe-eval'");
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

/// Run a full scan on a blocking thread (hashing new files can take minutes
/// over CIFS) and return the reconciliation counts. Flips the `scanning` flag
/// so `/status` can report live progress without touching the (locked) DB.
pub async fn run_scan(
    db: Db,
    root: PathBuf,
    progress: Arc<ScanProgress>,
) -> anyhow::Result<ScanResult> {
    progress.scanning.store(true, Ordering::Relaxed);
    let joined = tokio::task::spawn_blocking({
        let progress = progress.clone();
        move || {
            let mut conn = db.blocking_lock();
            scan::scan_into(&mut conn, &root, &progress)
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
        let root = state.cfg.root.clone();
        let progress = state.scan.clone();
        tokio::spawn(async move {
            tracing::info!(root = %root.display(), "empty index — initial scan started");
            match run_scan(db, root, progress).await {
                Ok(r) => tracing::info!(
                    indexed = r.indexed,
                    hashed = r.hashed,
                    "initial scan complete"
                ),
                Err(e) => tracing::error!(error = %e, "initial scan failed"),
            }
        });
    } else {
        tracing::info!(
            track_count,
            "serving cached index; POST /api/rescan to refresh"
        );
    }

    // Hash the SPA's inline bootstrap script(s) so the CSP can allow exactly
    // them. Read once at boot; the built index.html is immutable for the run.
    let index_path = state.cfg.static_dir.join("index.html");
    let hashes = std::fs::read_to_string(&index_path)
        .map(|h| inline_script_hashes(&h))
        .unwrap_or_default();
    if hashes.is_empty() {
        tracing::warn!(
            path = %index_path.display(),
            "no inline-script hashes (index.html missing or no inline scripts); \
             CSP script-src has no hashes"
        );
    }
    let csp_value = axum::http::HeaderValue::from_str(&build_csp(&hashes))
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
    fn csp_allows_wasm_and_workers() {
        let csp = build_csp(&["'sha256-X'".into()]);
        assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval' 'sha256-X'"));
        assert!(csp.contains("worker-src 'self' blob:"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
    }
}

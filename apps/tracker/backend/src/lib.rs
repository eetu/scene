pub mod auth;
pub mod config;
pub mod db;
pub mod enrich;
pub mod error;
pub mod hvsc;
pub mod library;
pub mod manifest;
pub mod migrate;
pub mod modland;
pub mod routes;
pub mod scan;
pub mod sid;
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
///
/// **`'unsafe-eval'` is required by the SID engine, and only by it.**
/// libsidplayfp is bound through Emscripten's Embind, which builds its invoker
/// functions with the `Function` constructor — string evaluation, which
/// `'wasm-unsafe-eval'` does not cover (that permits wasm compilation and
/// nothing else). libopenmpt reaches its C API through `cwrap` and needs none
/// of this, which is why modules played and SIDs died with "Couldn't play this
/// module" only once the app was served by *this* backend — `vite preview`,
/// which the e2e suite runs against, sends no CSP at all.
///
/// Neither shipped artifact avoids it (residfp and sidlite both use Embind),
/// and a worker cannot relax an inherited policy — a dedicated worker's CSP is
/// the union of its own and its owner's. So the choice is this or no SID
/// playback. Narrowing it would mean rebuilding the wasm with
/// `-sDYNAMIC_EXECUTION=0`, which is upstream work.
///
/// Everything else stays strict: no `'unsafe-inline'` for scripts, the inline
/// bootstrap is hashed, and `connect-src`/`img-src`/`frame-ancestors` are
/// unchanged.
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
        progress.scanning.store(true, Ordering::Relaxed);
        let _done = ScanFlagGuard(progress.clone());
        let mut conn = db.blocking_lock();
        let result = scan::scan_into(&mut conn, &root_id, &root, &progress);

        // Publish the outcome *here*, inside the blocking task, so it is written
        // before `_done` clears `scanning`.
        //
        // The caller used to record it after awaiting this future, which left a
        // window where `/status` said `scanning: false` while `last_scan` was
        // still the previous run's — or null. That is precisely what a client
        // polling "wait for scanning to go false, then read the result" hits,
        // which is what the SPA does and what caught this in CI.
        //
        // Doing it here also means the boot scan records its outcome, which the
        // caller-side version never did: `last_scan` is now an invariant of "a
        // scan finished", not of "someone asked for one over HTTP".
        if let Ok(mut slot) = progress.last.lock() {
            *slot = Some(match &result {
                Ok(r) => state::ScanOutcome {
                    root: root_id.clone(),
                    indexed: r.indexed,
                    hashed: r.hashed,
                    removed: r.removed,
                    finished_at: chrono::Utc::now().to_rfc3339(),
                    error: None,
                },
                Err(e) => state::ScanOutcome {
                    root: root_id.clone(),
                    indexed: 0,
                    hashed: 0,
                    removed: 0,
                    finished_at: chrono::Utc::now().to_rfc3339(),
                    error: Some(e.to_string()),
                },
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
        progress.scanning.store(true, Ordering::Relaxed);
        let _done = ScanFlagGuard(progress.clone());
        let mut conn = db.blocking_lock();
        hvsc::index_into(&mut conn, &root_id, &root)
    })
    .await?
}

/// Resets the `scanning` flag to false when dropped, so a scan always clears it
/// regardless of how it ends. Lives inside the (non-cancellable) blocking task.
struct ScanFlagGuard(Arc<ScanProgress>);
impl Drop for ScanFlagGuard {
    fn drop(&mut self) {
        self.0.scanning.store(false, Ordering::Relaxed);
    }
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
        assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' 'sha256-X'"));
        assert!(csp.contains("worker-src 'self' blob:"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
    }

    /// `'unsafe-eval'` looks like something to tighten, and tightening it breaks
    /// SID playback with an error that names the CSP but not the cause — and no
    /// test catches it, because the e2e suite runs against `vite preview`, which
    /// sends no CSP. Embind builds libsidplayfp's invokers with the `Function`
    /// constructor; `'wasm-unsafe-eval'` does not cover string evaluation.
    #[test]
    fn csp_keeps_unsafe_eval_for_embind() {
        let csp = build_csp(&[]);
        assert!(
            csp.contains("'unsafe-eval'"),
            "removing this silently disables SID playback: {csp}"
        );
    }
}

//! Stateless media transcoder sidecar (Rust port of the old Python one).
//!
//! The pure-Rust party backend stays a tiny scratch binary; anything that needs
//! ffmpeg is offloaded here. Endpoints take raw file bytes in the request body
//! plus an `ext` hint, and return web-native bytes:
//!
//!   POST /image?ext=lbm  →  PNG   (ffmpeg: ILBM/LBM, PCX, TIFF, TGA, BMP, …)
//!   POST /video?ext=mpg  →  MP4   (ffmpeg: MPEG-1, AVI, FLI/FLC, …)
//!
//! ffmpeg handles both — its image decoders cover the Amiga/DOS still formats
//! (ILBM, PCX, TGA, TIFF) that ImageMagick builds often lack a delegate for. No
//! state is kept; the backend owns the derived-asset cache. Binds loopback; an
//! optional bearer (PARTY_TRANSCODER_TOKEN) is defense-in-depth.
//!
//! Same shape as `../scribe`'s `press` Rust ffmpeg worker: it shells out to the
//! `ffmpeg` CLI, so there's no need for a non-Rust runtime.

use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

const MAX_BYTES: usize = 256 * 1024 * 1024;
const IMAGE_TIMEOUT: u64 = 30;
const VIDEO_TIMEOUT: u64 = 600;

struct Config {
    token: Option<String>,
    ffmpeg: String,
}

#[derive(Deserialize)]
struct ExtQuery {
    #[serde(default)]
    ext: String,
}

/// Errors map to the same HTTP statuses the Python version returned.
enum Error {
    Unauthorized,
    BadExt,
    Empty,
    TooLarge,
    Timeout,
    ToolMissing,
    Failed(String),
    Internal,
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (code, msg) = match self {
            Error::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            Error::BadExt => (StatusCode::BAD_REQUEST, "bad ext".to_string()),
            Error::Empty => (StatusCode::BAD_REQUEST, "empty body".to_string()),
            Error::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "input too large".to_string()),
            Error::Timeout => (
                StatusCode::GATEWAY_TIMEOUT,
                "transcode timed out".to_string(),
            ),
            Error::ToolMissing => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "ffmpeg not installed".to_string(),
            ),
            Error::Failed(m) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("transcode failed: {m}"),
            ),
            Error::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal error".to_string(),
            ),
        };
        (code, Json(json!({ "error": msg }))).into_response()
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let token = std::env::var("PARTY_TRANSCODER_TOKEN")
        .ok()
        .filter(|t| !t.is_empty());
    if token.is_none() {
        tracing::warn!(
            "PARTY_TRANSCODER_TOKEN unset — no bearer auth; relying on the loopback bind alone"
        );
    }
    let ffmpeg = std::env::var("PARTY_TRANSCODER_FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
    let host = std::env::var("PARTY_TRANSCODER_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("PARTY_TRANSCODER_PORT").unwrap_or_else(|_| "3021".into());

    let state = Arc::new(Config { token, ffmpeg });

    let app = Router::new()
        .route("/image", post(image))
        .route("/video", post(video))
        .route("/health", get(health))
        .layer(middleware::from_fn_with_state(state.clone(), require_token))
        // Raise the body limit well past axum's 2 MB default for whole modules /
        // animations.
        .layer(DefaultBodyLimit::max(MAX_BYTES))
        .with_state(state);

    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "scene-transcoder listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Bearer-token gate (constant-time), skipped for /health.
async fn require_token(
    State(cfg): State<Arc<Config>>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    if let Some(token) = &cfg.token {
        if req.uri().path() != "/health" {
            let presented = req
                .headers()
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| {
                    s.strip_prefix("Bearer ")
                        .or_else(|| s.strip_prefix("bearer "))
                })
                .unwrap_or("")
                .trim();
            if !ct_eq(presented.as_bytes(), token.as_bytes()) {
                return Error::Unauthorized.into_response();
            }
        }
    }
    next.run(req).await
}

/// Constant-time byte compare (length is allowed to leak — the token isn't).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn health(State(cfg): State<Arc<Config>>) -> Json<serde_json::Value> {
    let ffmpeg_ok = tokio::process::Command::new(&cfg.ffmpeg)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "ffmpeg": ffmpeg_ok }))
}

/// A short alphanumeric extension, for naming the temp input so ffmpeg
/// auto-detects the format. Rejects anything fishy.
fn safe_ext(ext: &str) -> Result<String, Error> {
    let e = ext.trim_start_matches('.').to_ascii_lowercase();
    if e.is_empty() || e.len() > 8 || !e.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(Error::BadExt);
    }
    Ok(e)
}

fn check_body(body: &Bytes) -> Result<(), Error> {
    if body.is_empty() {
        return Err(Error::Empty);
    }
    if body.len() > MAX_BYTES {
        return Err(Error::TooLarge);
    }
    Ok(())
}

/// Run ffmpeg with a timeout; kills the child on timeout (kill_on_drop).
async fn run_ffmpeg(ffmpeg: &str, args: &[&str], timeout_s: u64) -> Result<(), Error> {
    let child = tokio::process::Command::new(ffmpeg)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let child = match child {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Error::ToolMissing),
        Err(_) => return Err(Error::Internal),
    };
    match tokio::time::timeout(Duration::from_secs(timeout_s), child.wait_with_output()).await {
        Err(_) => Err(Error::Timeout), // child dropped here → killed
        Ok(Err(_)) => Err(Error::Internal),
        Ok(Ok(out)) if out.status.success() => Ok(()),
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let tail: String = stderr
                .trim()
                .chars()
                .rev()
                .take(400)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            tracing::warn!(error = %tail, "transcode failed");
            Err(Error::Failed(tail))
        }
    }
}

async fn transcode(
    cfg: &Config,
    ext: &str,
    body: Bytes,
    out_name: &str,
    args_for: impl FnOnce(&str, &str) -> Vec<String>,
    timeout_s: u64,
) -> Result<Vec<u8>, Error> {
    let dir = tempfile::tempdir().map_err(|_| Error::Internal)?;
    let src = dir.path().join(format!("in.{ext}"));
    let out = dir.path().join(out_name);
    tokio::fs::write(&src, &body)
        .await
        .map_err(|_| Error::Internal)?;
    let (src_s, out_s) = (
        src.to_str().ok_or(Error::Internal)?,
        out.to_str().ok_or(Error::Internal)?,
    );
    let args = args_for(src_s, out_s);
    let argrefs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_ffmpeg(&cfg.ffmpeg, &argrefs, timeout_s).await?;
    tokio::fs::read(&out).await.map_err(|_| Error::Internal)
}

async fn image(
    State(cfg): State<Arc<Config>>,
    Query(q): Query<ExtQuery>,
    body: Bytes,
) -> Result<Response, Error> {
    let ext = safe_ext(&q.ext)?;
    check_body(&body)?;
    // `-frames:v 1` takes the first frame of multi-image/animated inputs.
    let png = transcode(
        &cfg,
        &ext,
        body,
        "out.png",
        |src, out| {
            [
                "-y",
                "-loglevel",
                "error",
                "-i",
                src,
                "-frames:v",
                "1",
                // Bake the source sample aspect into square pixels, so Amiga
                // non-square-pixel graphics (e.g. an ILBM tagged 5:6 via CAMG)
                // display at their intended proportions instead of stretched.
                // No-op for square-pixel sources (sar 1:1 / undefined → 1).
                "-vf",
                "scale=iw*sar:ih,setsar=1",
                out,
            ]
            .map(String::from)
            .to_vec()
        },
        IMAGE_TIMEOUT,
    )
    .await?;
    Ok(([(header::CONTENT_TYPE, "image/png")], png).into_response())
}

async fn video(
    State(cfg): State<Arc<Config>>,
    Query(q): Query<ExtQuery>,
    body: Bytes,
) -> Result<Response, Error> {
    let ext = safe_ext(&q.ext)?;
    check_body(&body)?;
    let mp4 = transcode(
        &cfg,
        &ext,
        body,
        "out.mp4",
        |src, out| {
            [
                "-y",
                "-loglevel",
                "error",
                "-i",
                src,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-pix_fmt",
                "yuv420p",
                // Even dimensions are required by yuv420p/H.264.
                "-vf",
                "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                out,
            ]
            .map(String::from)
            .to_vec()
        },
        VIDEO_TIMEOUT,
    )
    .await?;
    Ok(([(header::CONTENT_TYPE, "video/mp4")], mp4).into_response())
}

//! Stateless media transcoder sidecar (Rust port of the old Python one).
//!
//! The pure-Rust party backend stays a tiny scratch binary; anything that needs
//! ffmpeg is offloaded here. Endpoints take file bytes plus an `ext` hint, and
//! return web-native bytes:
//!
//!   POST /image?ext=lbm  →  PNG   (ffmpeg: ILBM/LBM, PCX, TIFF, TGA, BMP, …)
//!   POST /video?ext=mpg  →  MP4   (ffmpeg: MPEG-1, AVI, FLI/FLC, …)
//!
//! `/image` takes the raw bytes as the body. `/video` takes `multipart/form-data`
//! with a `video` part and an optional `audio` part, because some archived
//! productions ship the soundtrack *beside* the picture rather than inside it —
//! the Assembly '95/'96 animation compos are video-only MPEG-1 streams with a
//! headerless raw-PCM `.snd` next to them. Those also mis-declare their frame
//! rate, hence `fps`. See the `VideoQuery` fields.
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
use axum::extract::{DefaultBodyLimit, Multipart, Query, State};
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

/// Raw PCM sample formats accepted for a headerless audio sidecar. Allowlisted
/// because the value is handed straight to ffmpeg's `-f`.
const RAW_AUDIO_FORMATS: &[&str] = &["u8", "s8", "s16le", "s16be", "u16le", "u16be"];

#[derive(Deserialize)]
struct ExtQuery {
    #[serde(default)]
    ext: String,
}

#[derive(Deserialize)]
struct VideoQuery {
    /// Source extension, so the temp file is named for ffmpeg to sniff.
    #[serde(default)]
    ext: String,
    /// Authored playback rate, when the source's own header gets it wrong (the
    /// Assembly animation MPEGs declare 25 fps but run at 12.5). Applied as an
    /// *input* option, so it retimes the stream rather than resampling frames.
    #[serde(default)]
    fps: Option<f64>,
    /// Extension of the `audio` part, same purpose as `ext`.
    #[serde(default)]
    aext: Option<String>,
    /// Raw PCM sample format of the `audio` part (see [`RAW_AUDIO_FORMATS`]).
    /// Omit for a self-describing container (WAV/MP3), which ffmpeg probes.
    #[serde(default)]
    af: Option<String>,
    /// Sample rate, required alongside `af`.
    #[serde(default)]
    ar: Option<u32>,
    /// Channel count, defaults to mono.
    #[serde(default)]
    ac: Option<u32>,
}

/// Errors map to the same HTTP statuses the Python version returned.
enum Error {
    Unauthorized,
    BadExt,
    BadParam(&'static str),
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
            Error::BadParam(m) => (StatusCode::BAD_REQUEST, m.to_string()),
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

/// A frame rate as an ffmpeg argument. Rendered with `{}` so an integral rate
/// comes out `24` and a fractional one `12.5` — never in exponent notation.
fn safe_fps(fps: f64) -> Result<String, Error> {
    if !fps.is_finite() || !(1.0..=120.0).contains(&fps) {
        return Err(Error::BadParam("fps out of range (1..=120)"));
    }
    Ok(format!("{fps}"))
}

/// A validated external audio track.
struct AudioSpec {
    /// Extension for the temp file.
    ext: String,
    /// ffmpeg *input* options describing headerless PCM. Empty for a container'd
    /// sidecar, which ffmpeg probes on its own.
    raw_opts: Vec<String>,
}

impl AudioSpec {
    fn from_query(q: &VideoQuery) -> Result<Self, Error> {
        // Nothing sniffs `.bin`; harmless, since raw PCM is described by `raw_opts`
        // and a container is recognised by content.
        let ext = safe_ext(q.aext.as_deref().unwrap_or("bin"))?;
        let mut raw_opts = Vec::new();
        if let Some(af) = &q.af {
            if !RAW_AUDIO_FORMATS.contains(&af.as_str()) {
                return Err(Error::BadParam("unsupported raw audio format"));
            }
            // A headerless stream carries no rate, so there's nothing to fall back
            // on — refuse rather than let ffmpeg guess.
            let ar = q.ar.ok_or(Error::BadParam("ar required with af"))?;
            if !(1000..=192_000).contains(&ar) {
                return Err(Error::BadParam("ar out of range (1000..=192000)"));
            }
            let ac = q.ac.unwrap_or(1);
            if !(1..=8).contains(&ac) {
                return Err(Error::BadParam("ac out of range (1..=8)"));
            }
            raw_opts = vec![
                "-f".into(),
                af.clone(),
                "-ar".into(),
                ar.to_string(),
                "-ac".into(),
                ac.to_string(),
            ];
        }
        Ok(Self { ext, raw_opts })
    }
}

/// Pull the `video` (required) and `audio` (optional) parts out of a multipart
/// body. Unknown parts are ignored.
async fn read_parts(mut mp: Multipart) -> Result<(Bytes, Option<Bytes>), Error> {
    let mut video = None;
    let mut audio = None;
    while let Some(field) = mp
        .next_field()
        .await
        .map_err(|_| Error::BadParam("malformed multipart body"))?
    {
        // `name()` borrows the field, which `bytes()` consumes.
        let name = field.name().unwrap_or_default().to_string();
        match name.as_str() {
            "video" | "audio" => {
                let data = field
                    .bytes()
                    .await
                    .map_err(|_| Error::BadParam("unreadable multipart part"))?;
                if name == "video" {
                    video = Some(data);
                } else {
                    audio = Some(data);
                }
            }
            _ => {}
        }
    }
    Ok((video.ok_or(Error::BadParam("missing `video` part"))?, audio))
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

/// Materialise each `(ext, bytes)` input as `in<N>.<ext>` in a scratch dir, run
/// the args `args_for` builds from those paths, and return the output file.
/// `args_for` gets the input paths in order, so a two-input mux indexes `[0]` and
/// `[1]`. The dir (inputs and output) is removed when this returns.
async fn transcode(
    cfg: &Config,
    inputs: &[(String, Bytes)],
    out_name: &str,
    args_for: impl FnOnce(&[String], &str) -> Vec<String>,
    timeout_s: u64,
) -> Result<Vec<u8>, Error> {
    let dir = tempfile::tempdir().map_err(|_| Error::Internal)?;
    let mut paths = Vec::with_capacity(inputs.len());
    for (i, (ext, bytes)) in inputs.iter().enumerate() {
        let p = dir.path().join(format!("in{i}.{ext}"));
        tokio::fs::write(&p, bytes)
            .await
            .map_err(|_| Error::Internal)?;
        paths.push(p.to_str().ok_or(Error::Internal)?.to_string());
    }
    let out = dir.path().join(out_name);
    let out_s = out.to_str().ok_or(Error::Internal)?;
    let args = args_for(&paths, out_s);
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
        &[(ext, body)],
        "out.png",
        |paths, out| {
            [
                "-y",
                "-loglevel",
                "error",
                "-i",
                paths[0].as_str(),
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

/// `multipart/form-data`: a `video` part, plus an optional `audio` part muxed in
/// as the soundtrack. With neither `fps` nor `audio` the ffmpeg args are exactly
/// what a plain single-input transcode has always used.
///
/// `Multipart` consumes the body, so it comes last in the argument list.
async fn video(
    State(cfg): State<Arc<Config>>,
    Query(q): Query<VideoQuery>,
    mp: Multipart,
) -> Result<Response, Error> {
    let ext = safe_ext(&q.ext)?;
    let fps = q.fps.map(safe_fps).transpose()?;
    let (vbytes, abytes) = read_parts(mp).await?;
    check_body(&vbytes)?;
    let audio = match &abytes {
        Some(b) => {
            check_body(b)?;
            Some(AudioSpec::from_query(&q)?)
        }
        None => None,
    };
    // The body-limit layer bounds the request as a whole; this bounds what we're
    // about to write to disk and hand ffmpeg.
    if vbytes.len() + abytes.as_ref().map_or(0, Bytes::len) > MAX_BYTES {
        return Err(Error::TooLarge);
    }

    let mut inputs = vec![(ext, vbytes)];
    if let (Some(spec), Some(bytes)) = (&audio, abytes) {
        inputs.push((spec.ext.clone(), bytes));
    }

    let mp4 = transcode(
        &cfg,
        &inputs,
        "out.mp4",
        |paths, out| {
            let mut a: Vec<String> = ["-y", "-loglevel", "error"].map(String::from).to_vec();
            // Input option: retimes the stream, overriding a header that lies.
            if let Some(fps) = &fps {
                a.extend(["-r".to_string(), fps.clone()]);
            }
            a.extend(["-i".to_string(), paths[0].clone()]);
            if let Some(spec) = &audio {
                // Raw-PCM options describe the *next* input, so they sit between
                // the two `-i`s.
                a.extend(spec.raw_opts.iter().cloned());
                a.extend(["-i".to_string(), paths[1].clone()]);
                // Only needed for two inputs: take the picture from the source and
                // the soundtrack from the sidecar. Deliberately no `-shortest` —
                // these sidecars are often a few percent longer or (when the dump
                // is truncated) much shorter than the picture, and neither stream
                // should cut the other off.
                a.extend(["-map", "0:v:0", "-map", "1:a:0"].map(String::from));
            }
            a.extend(
                [
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
                ]
                .map(String::from),
            );
            a.push(out.to_string());
            a
        },
        VIDEO_TIMEOUT,
    )
    .await?;
    Ok(([(header::CONTENT_TYPE, "video/mp4")], mp4).into_response())
}

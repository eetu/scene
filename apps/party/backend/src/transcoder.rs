//! HTTP client for the transcoder sidecar (see `transcoder/`). Mirrors scribe's
//! `ShimClient`: a thin typed wrapper over the shared `reqwest` client, with an
//! optional shared-secret bearer and fail-closed errors (`AppError::Upstream` →
//! 502) so the SPA can fall back to a download when the sidecar is down.

use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub struct TranscoderClient<'a> {
    state: &'a AppState,
}

/// A soundtrack stored beside a video rather than inside it, to be muxed in as
/// the audio track. Resolved from the party config's per-file overrides.
pub struct AuxAudio {
    /// Extension hint for the sidecar's temp file.
    pub ext: String,
    pub bytes: Vec<u8>,
    /// Raw PCM sample format (e.g. `u8`) when the file is headerless. `None` for a
    /// self-describing container (WAV/MP3), where the rest is read from its header.
    pub format: Option<String>,
    pub rate: Option<u32>,
    pub channels: Option<u32>,
}

impl<'a> TranscoderClient<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    pub fn is_configured(&self) -> bool {
        self.state.cfg.transcoder_url.is_some()
    }

    fn base(&self) -> AppResult<&str> {
        self.state
            .cfg
            .transcoder_url
            .as_deref()
            .map(|u| u.trim_end_matches('/'))
            .ok_or_else(|| AppError::Upstream("transcoder not configured".into()))
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self.state.cfg.transcoder_token.as_deref() {
            Some(t) if !t.is_empty() => rb.bearer_auth(t),
            _ => rb,
        }
    }

    pub async fn health(&self) -> bool {
        let Ok(base) = self.base() else {
            return false;
        };
        matches!(
            self.auth(self.state.http.get(format!("{base}/health"))).send().await,
            Ok(r) if r.status().is_success()
        )
    }

    /// Transcode an image: `src` bytes in, PNG bytes out. `ext` is the source
    /// file's extension hint. Takes the raw bytes as the body.
    pub async fn transcode_image(&self, ext: &str, src: Vec<u8>) -> AppResult<Vec<u8>> {
        let base = self.base()?;
        let rb = self
            .state
            .http
            .post(format!("{base}/image"))
            .query(&[("ext", ext)])
            .body(src);
        self.send("image", ext, rb).await
    }

    /// Transcode a video: `src` bytes in, MP4 bytes out.
    ///
    /// `fps` overrides the source's declared frame rate (for containers that
    /// mis-declare it) and `audio` supplies a soundtrack stored beside the file.
    /// Both come from the party config's per-file overrides; with neither, this is
    /// a plain single-input transcode. Sent as multipart, which is the sidecar's
    /// only body shape for `/video`.
    pub async fn transcode_video(
        &self,
        ext: &str,
        src: Vec<u8>,
        fps: Option<f64>,
        audio: Option<AuxAudio>,
    ) -> AppResult<Vec<u8>> {
        let base = self.base()?;
        // Built as pairs rather than interpolated, so a config-authored value can't
        // smuggle in extra query parameters.
        let mut params: Vec<(&str, String)> = vec![("ext", ext.to_string())];
        if let Some(fps) = fps {
            params.push(("fps", fps.to_string()));
        }
        let mut form =
            reqwest::multipart::Form::new().part("video", reqwest::multipart::Part::bytes(src));
        if let Some(a) = audio {
            params.push(("aext", a.ext));
            if let Some(f) = a.format {
                params.push(("af", f));
            }
            if let Some(r) = a.rate {
                params.push(("ar", r.to_string()));
            }
            if let Some(c) = a.channels {
                params.push(("ac", c.to_string()));
            }
            form = form.part("audio", reqwest::multipart::Part::bytes(a.bytes));
        }
        let rb = self
            .state
            .http
            .post(format!("{base}/video"))
            .query(&params)
            .multipart(form);
        self.send("video", ext, rb).await
    }

    /// Send a prepared request, apply the bearer, and map the response status onto
    /// the transient/permanent split the asset cache depends on.
    async fn send(&self, kind: &str, ext: &str, rb: reqwest::RequestBuilder) -> AppResult<Vec<u8>> {
        // The shared client's default timeout (120s) is far shorter than the
        // sidecar's own transcode budget (video ≤600s, image ≤30s — see
        // transcoder `VIDEO_TIMEOUT`/`IMAGE_TIMEOUT`). Without a per-request
        // override the backend aborts a long video encode mid-flight → 502, even
        // though the sidecar would have finished (and it re-encodes from scratch
        // on the next view). Give each request a ceiling just above the sidecar's
        // so its clean 504 wins over a client-side abort.
        let timeout = match kind {
            "video" => std::time::Duration::from_secs(630),
            _ => std::time::Duration::from_secs(60),
        };
        let resp = self.auth(rb.timeout(timeout)).send().await?;
        let status = resp.status();
        // Permanent failures — the sidecar can never convert this source (ffmpeg
        // failed → 422, unsupported ext → 400, too large → 413). Surface these as
        // `Unprocessable` (not `Upstream`) so the asset handler negatively caches
        // them instead of re-running ffmpeg on every view. Everything else
        // (unreachable, 504 timeout, 500 misconfig) stays a transient `Upstream`.
        use reqwest::StatusCode;
        if matches!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY
                | StatusCode::BAD_REQUEST
                | StatusCode::PAYLOAD_TOO_LARGE
        ) {
            return Err(AppError::Unprocessable(format!(
                "transcoder rejected the source ({kind}, .{ext}): {status}"
            )));
        }
        let resp = resp.error_for_status()?;
        Ok(resp.bytes().await?.to_vec())
    }
}

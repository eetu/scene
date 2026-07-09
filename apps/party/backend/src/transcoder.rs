//! HTTP client for the transcoder sidecar (see `transcoder/`). Mirrors scribe's
//! `ShimClient`: a thin typed wrapper over the shared `reqwest` client, with an
//! optional shared-secret bearer and fail-closed errors (`AppError::Upstream` →
//! 502) so the SPA can fall back to a download when the sidecar is down.

use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub struct TranscoderClient<'a> {
    state: &'a AppState,
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

    /// Transcode `src` bytes. `kind` is `"image"` (→ PNG) or `"video"` (→ MP4);
    /// `ext` is the source file's extension hint. Returns the transcoded bytes.
    pub async fn transcode(&self, kind: &str, ext: &str, src: Vec<u8>) -> AppResult<Vec<u8>> {
        let base = self.base()?;
        let url = format!("{base}/{kind}?ext={ext}");
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
        let resp = self
            .auth(self.state.http.post(url).body(src).timeout(timeout))
            .send()
            .await?;
        let status = resp.status();
        // Permanent failures — the sidecar can never convert this source (ffmpeg
        // failed → 422, unsupported ext → 400, too large → 413). Surface these as
        // `Unprocessable` (not `Upstream`) so the asset handler negatively caches
        // them instead of re-running ffmpeg on every view. Everything else
        // (unreachable, 504 timeout, 500 misconfig) stays a transient `Upstream`.
        use reqwest::StatusCode;
        if matches!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST | StatusCode::PAYLOAD_TOO_LARGE
        ) {
            return Err(AppError::Unprocessable(format!(
                "transcoder rejected the source ({kind}, .{ext}): {status}"
            )));
        }
        let resp = resp.error_for_status()?;
        Ok(resp.bytes().await?.to_vec())
    }
}

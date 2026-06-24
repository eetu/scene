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
        let resp = self
            .auth(self.state.http.post(url).body(src))
            .send()
            .await?
            .error_for_status()?;
        Ok(resp.bytes().await?.to_vec())
    }
}

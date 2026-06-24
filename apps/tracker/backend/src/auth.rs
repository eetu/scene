//! Edge-trust auth. The collection is a single shared, read-only library —
//! there's no per-user state — so the binary doesn't run its own login. It
//! sits behind oauth2-proxy forward-auth on the Pi and only asserts that the
//! edge vouched for the request via `X-Auth-Request-User`, returning 401 if the
//! header is absent (defence in depth; the edge is the real gate). The check is
//! bypassed by `DEV_AUTH=1` (local work) or `TRACKER_OPEN=1` (a LAN-only deploy
//! with no oauth2-proxy in front). `/status` stays unauthenticated.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;

use crate::error::AppError;
use crate::state::AppState;

const HDR_USER: &str = "x-auth-request-user";

/// Zero-sized proof the request is authenticated. Required by every `/api/*`
/// handler; there's no identity to carry because data isn't per-user.
pub struct Auth;

impl FromRequestParts<AppState> for Auth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if state.cfg.dev_auth {
            return Ok(Auth);
        }
        let user = parts
            .headers
            .get(HDR_USER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !user.is_empty() {
            return Ok(Auth);
        }
        Err(AppError::Unauthorized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::db::Db;
    use axum::http::Request;
    use std::path::PathBuf;

    fn state(dev_auth: bool) -> AppState {
        let cfg = Config {
            bind: String::new(),
            dev_auth,
            root: PathBuf::new(),
            db_path: PathBuf::new(),
            static_dir: PathBuf::new(),
        };
        AppState::new(cfg, Db::open_in_memory().unwrap())
    }

    async fn extract(req: Request<()>, dev_auth: bool) -> Result<Auth, AppError> {
        let (mut parts, _) = req.into_parts();
        Auth::from_request_parts(&mut parts, &state(dev_auth)).await
    }

    #[tokio::test]
    async fn rejects_without_header_in_prod() {
        let req = Request::builder().body(()).unwrap();
        assert!(matches!(
            extract(req, false).await,
            Err(AppError::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn accepts_forward_auth_header() {
        let req = Request::builder()
            .header(HDR_USER, "alice")
            .body(())
            .unwrap();
        assert!(extract(req, false).await.is_ok());
    }

    #[tokio::test]
    async fn dev_auth_bypasses() {
        let req = Request::builder().body(()).unwrap();
        assert!(extract(req, true).await.is_ok());
    }
}

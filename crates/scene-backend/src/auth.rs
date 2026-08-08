//! Edge-trust auth. Each collection is a single shared, read-only library —
//! there's no per-user state — so the binaries don't run their own login. They
//! sit behind oauth2-proxy forward-auth and only assert that the edge vouched
//! for the request via `X-Auth-Request-User`, returning 401 if the header is
//! absent (defence in depth; the edge is the real gate). The check is bypassed
//! when the app's config says so (`DEV_AUTH=1`, or the app's `*_OPEN=1` for a
//! LAN-only deploy). `/status` stays unauthenticated.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;

use crate::error::AppError;

const HDR_USER: &str = "x-auth-request-user";

/// How an app's state reports the auth bypass (`DEV_AUTH` / `*_OPEN`).
pub trait AuthGate {
    fn auth_bypassed(&self) -> bool;
}

/// Zero-sized proof the request is authenticated. Required by every `/api/*`
/// handler; there's no identity to carry because data isn't per-user.
pub struct Auth;

impl<S: AuthGate + Send + Sync> FromRequestParts<S> for Auth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        if state.auth_bypassed() {
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
    use axum::http::Request;

    struct TestState(bool);
    impl AuthGate for TestState {
        fn auth_bypassed(&self) -> bool {
            self.0
        }
    }

    async fn extract(req: Request<()>, bypass: bool) -> Result<Auth, AppError> {
        let (mut parts, _) = req.into_parts();
        Auth::from_request_parts(&mut parts, &TestState(bypass)).await
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

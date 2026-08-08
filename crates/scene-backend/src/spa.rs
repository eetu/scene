use std::path::Path;

use axum::http::{header, StatusCode, Uri};
use axum::response::{Html, IntoResponse, Response};

/// SPA fallback — serve a real built asset under `base`, else index.html with
/// 200 so the client router owns the route. NOT tower-http ServeDir (its
/// not_found_service leaks a 404 onto every client route).
pub async fn spa_response(base: &Path, uri: &Uri) -> Response {
    let rel = uri.path().trim_start_matches('/');

    if !rel.is_empty() {
        let candidate = base.join(rel);
        if let Ok(canon) = candidate.canonicalize() {
            if let Ok(canon_base) = base.canonicalize() {
                if canon.starts_with(&canon_base) && canon.is_file() {
                    if let Ok(bytes) = tokio::fs::read(&canon).await {
                        let mime = mime_guess::from_path(&canon).first_or_octet_stream();
                        return ([(header::CONTENT_TYPE, mime.as_ref())], bytes).into_response();
                    }
                }
            }
        }
    }

    match tokio::fs::read_to_string(base.join("index.html")).await {
        Ok(html) => Html(html).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

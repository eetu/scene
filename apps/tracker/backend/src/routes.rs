use std::sync::atomic::Ordering;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::Auth;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        // Unauthenticated liveness — gatus probes this; keep it auth-free and on
        // a Traefik monitor router that bypasses oauth2-proxy.
        .route("/status", get(status))
        // The whole library index (path-derived fields + cached metadata).
        .route("/api/tracks", get(api_tracks))
        // Raw module bytes by content hash (player + WASM metadata extraction).
        .route("/api/file/{hash}", get(api_file))
        // Enrichment the frontend parsed via libopenmpt WASM.
        .route("/api/meta/{hash}", post(api_meta))
        // Listener state: toggle favourite, bump play count (both by content hash).
        .route("/api/favorite/{hash}", post(api_favorite))
        .route("/api/play/{hash}", post(api_play))
        // Rename / move a module on disk (organise the collection in place).
        .route("/api/rename", post(api_rename))
        // Re-walk the collection (e.g. after moving files around).
        .route("/api/rescan", post(api_rescan))
        // SPA fallback — serve a real built asset, else index.html with 200 so
        // the client router owns the route. NOT tower-http ServeDir (its
        // not_found_service leaks a 404 onto every client route).
        .fallback(get(serve_spa))
        .with_state(state)
}

async fn serve_spa(
    State(state): State<AppState>,
    uri: axum::http::Uri,
) -> axum::response::Response {
    use axum::response::Html;

    let base = &state.cfg.static_dir;
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

// ---------- public probe ----------

async fn status(State(state): State<AppState>) -> Json<Value> {
    let scanning = state.scan.scanning.load(Ordering::Relaxed);
    // The scan holds the single DB connection for its whole duration, so don't
    // touch the DB while it runs — that query would block until the scan ends.
    // Report live progress from the lock-free counters instead.
    let track_count: Option<i64> = if scanning {
        None
    } else {
        state
            .db
            .with(|c| c.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0)))
            .await
            .ok()
    };
    Json(json!({
        "service": "tracker",
        "version": env!("CARGO_PKG_VERSION"),
        "db_healthy": scanning || track_count.is_some(),
        "track_count": track_count,
        "root": state.cfg.root.display().to_string(),
        "scanning": scanning,
        "scan_total": state.scan.total.load(Ordering::Relaxed),
        "scan_processed": state.scan.processed.load(Ordering::Relaxed),
        "scan_hashed": state.scan.hashed.load(Ordering::Relaxed),
    }))
}

// ---------- gated api ----------

/// One library entry. Path-derived fields are always present; the rest come
/// from the `meta` cache (LEFT JOIN) and are null until enrichment fills them.
#[derive(Serialize)]
struct Track {
    hash: String,
    path: String,
    group: String,
    artist: Option<String>,
    filename: String,
    ext: String,
    size: i64,
    title: Option<String>,
    type_long: Option<String>,
    tracker: Option<String>,
    duration: Option<f64>,
    channels: Option<i64>,
    instruments: Option<i64>,
    samples: Option<i64>,
    favorite: bool,
    play_count: i64,
}

async fn api_tracks(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let tracks = state
        .db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT f.content_hash, f.rel_path, f.grp, f.artist, f.filename, f.ext, f.size,
                        m.title, m.type_long, m.tracker, m.duration, m.channels,
                        m.instruments, m.samples,
                        COALESCE(s.favorite, 0), COALESCE(s.play_count, 0)
                 FROM files f
                 LEFT JOIN meta m ON m.content_hash = f.content_hash
                 LEFT JOIN stats s ON s.content_hash = f.content_hash
                 ORDER BY f.grp COLLATE NOCASE, f.artist COLLATE NOCASE, f.filename COLLATE NOCASE",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(Track {
                    hash: r.get(0)?,
                    path: r.get(1)?,
                    group: r.get(2)?,
                    artist: r.get(3)?,
                    filename: r.get(4)?,
                    ext: r.get(5)?,
                    size: r.get(6)?,
                    title: r.get(7)?,
                    type_long: r.get(8)?,
                    tracker: r.get(9)?,
                    duration: r.get(10)?,
                    channels: r.get(11)?,
                    instruments: r.get(12)?,
                    samples: r.get(13)?,
                    favorite: r.get::<_, i64>(14)? != 0,
                    play_count: r.get(15)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    Ok(Json(json!({ "tracks": tracks })))
}

async fn api_file(
    _auth: Auth,
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> AppResult<impl IntoResponse> {
    // Any path with these bytes will do — duplicates share a hash.
    let rel_path: String = state
        .db
        .with(|c| {
            c.query_row(
                "SELECT rel_path FROM files WHERE content_hash = ?1 LIMIT 1",
                [&hash],
                |r| r.get(0),
            )
        })
        .await
        .map_err(|_| AppError::NotFound)?;

    // rel_path comes from our own scan, but canonicalize + prefix-check anyway.
    let full = state.cfg.root.join(&rel_path);
    let (canon, canon_root) = match (full.canonicalize(), state.cfg.root.canonicalize()) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return Err(AppError::NotFound),
    };
    if !canon.starts_with(&canon_root) || !canon.is_file() {
        return Err(AppError::NotFound);
    }

    let bytes = tokio::fs::read(&canon).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CACHE_CONTROL, "private, max-age=3600".to_string()),
        ],
        bytes,
    ))
}

/// libopenmpt-parsed metadata, posted by the frontend after it loads a module.
/// All optional — a module may carry no title, etc.
#[derive(Deserialize)]
struct MetaIn {
    title: Option<String>,
    type_long: Option<String>,
    tracker: Option<String>,
    duration: Option<f64>,
    channels: Option<i64>,
    instruments: Option<i64>,
    samples: Option<i64>,
    n_orders: Option<i64>,
    n_patterns: Option<i64>,
}

async fn api_meta(
    _auth: Auth,
    State(state): State<AppState>,
    Path(hash): Path<String>,
    Json(m): Json<MetaIn>,
) -> AppResult<StatusCode> {
    let now = chrono::Utc::now().to_rfc3339();
    state
        .db
        .with(|c| {
            c.execute(
                "INSERT INTO meta (content_hash, title, type_long, tracker, duration, channels,
                                   instruments, samples, n_orders, n_patterns, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(content_hash) DO UPDATE SET
                   title=excluded.title, type_long=excluded.type_long, tracker=excluded.tracker,
                   duration=excluded.duration, channels=excluded.channels,
                   instruments=excluded.instruments, samples=excluded.samples,
                   n_orders=excluded.n_orders, n_patterns=excluded.n_patterns,
                   updated_at=excluded.updated_at",
                rusqlite::params![
                    hash,
                    m.title,
                    m.type_long,
                    m.tracker,
                    m.duration,
                    m.channels,
                    m.instruments,
                    m.samples,
                    m.n_orders,
                    m.n_patterns,
                    now,
                ],
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct FavoriteIn {
    favorite: bool,
}

/// Toggle a tune's favourite flag (keyed by content hash, so it survives moves).
async fn api_favorite(
    _auth: Auth,
    State(state): State<AppState>,
    Path(hash): Path<String>,
    Json(req): Json<FavoriteIn>,
) -> AppResult<StatusCode> {
    state
        .db
        .with(move |c| {
            c.execute(
                "INSERT INTO stats (content_hash, favorite) VALUES (?1, ?2)
                 ON CONFLICT(content_hash) DO UPDATE SET favorite = excluded.favorite",
                rusqlite::params![hash, req.favorite as i64],
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Increment a tune's play count (called when playback actually starts).
async fn api_play(
    _auth: Auth,
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> AppResult<Json<Value>> {
    let now = chrono::Utc::now().to_rfc3339();
    let count: i64 = state
        .db
        .with(move |c| {
            c.execute(
                "INSERT INTO stats (content_hash, play_count, last_played) VALUES (?1, 1, ?2)
                 ON CONFLICT(content_hash) DO UPDATE SET
                   play_count = play_count + 1, last_played = excluded.last_played",
                rusqlite::params![hash, now],
            )?;
            c.query_row(
                "SELECT play_count FROM stats WHERE content_hash = ?1",
                [&hash],
                |r| r.get(0),
            )
        })
        .await?;
    Ok(Json(json!({ "play_count": count })))
}

/// Rename or move a module by editing its group / artist / filename — the three
/// path segments the collection is organised by. Reconstructs the destination
/// from clean segments (no `..`/separators), refuses to overwrite, performs the
/// filesystem move, and updates the index row in place. Because metadata is
/// keyed by content hash (unchanged by a move), enrichment follows the file for
/// free.
#[derive(Deserialize)]
struct RenameIn {
    /// Current relative path under the root (the track's `path`).
    from: String,
    group: String,
    artist: Option<String>,
    filename: String,
}

/// A single safe path segment: non-empty, not `.`/`..`, no separators.
fn clean_segment(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() || t == "." || t == ".." || t.contains(['/', '\\', '\0']) {
        None
    } else {
        Some(t.to_string())
    }
}

async fn api_rename(
    _auth: Auth,
    State(state): State<AppState>,
    Json(req): Json<RenameIn>,
) -> AppResult<Json<Value>> {
    let group =
        clean_segment(&req.group).ok_or_else(|| AppError::BadRequest("invalid group".into()))?;
    let filename = clean_segment(&req.filename)
        .ok_or_else(|| AppError::BadRequest("invalid filename".into()))?;
    if !crate::scan::has_module_ext(&filename) {
        return Err(AppError::BadRequest(
            "filename must keep a recognised module extension".into(),
        ));
    }
    let artist = match req
        .artist
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(a) => {
            Some(clean_segment(a).ok_or_else(|| AppError::BadRequest("invalid artist".into()))?)
        }
        None => None,
    };
    let to_rel = match &artist {
        Some(a) => format!("{group}/{a}/{filename}"),
        None => format!("{group}/{filename}"),
    };
    let from_rel = req.from.clone();
    if from_rel == to_rel {
        return Err(AppError::BadRequest(
            "source and destination are the same".into(),
        ));
    }

    let root = state.cfg.root.clone();
    // Validate the source is a real file inside the root (rejects `..` escapes).
    let from_abs = root.join(&from_rel);
    let (from_canon, root_canon) = match (from_abs.canonicalize(), root.canonicalize()) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return Err(AppError::NotFound),
    };
    if !from_canon.starts_with(&root_canon) || !from_canon.is_file() {
        return Err(AppError::NotFound);
    }
    // to_rel is built from clean segments, so it can't escape the root.
    let to_abs = root.join(&to_rel);

    // Filesystem move on a blocking thread; never overwrite an existing file.
    let from_for_fs = from_canon.clone();
    let to_for_fs = to_abs.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        if to_for_fs.exists() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "destination exists",
            ));
        }
        if let Some(parent) = to_for_fs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&from_for_fs, &to_for_fs)
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?
    .map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => {
            AppError::Conflict("destination already exists".into())
        }
        std::io::ErrorKind::NotFound => AppError::NotFound,
        _ => AppError::Internal(e.into()),
    })?;

    // Update the index row in place (hash unchanged → meta still matches).
    let (grp, art, fname, ext) = crate::scan::derive_fields(&to_rel);
    let to_for_db = to_rel.clone();
    state
        .db
        .with(move |c| {
            c.execute(
                "UPDATE files SET rel_path=?1, grp=?2, artist=?3, filename=?4, ext=?5
                 WHERE rel_path=?6",
                rusqlite::params![to_for_db, grp, art, fname, ext, from_rel],
            )
        })
        .await?;

    let (grp, art, fname, ext) = crate::scan::derive_fields(&to_rel);
    Ok(Json(json!({
        "path": to_rel,
        "group": grp,
        "artist": art,
        "filename": fname,
        "ext": ext,
    })))
}

async fn api_rescan(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let result = crate::run_scan(state.db.clone(), state.cfg.root.clone(), state.scan.clone())
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(json!({
        "indexed": result.indexed,
        "hashed": result.hashed,
        "removed": result.removed,
    })))
}

#[cfg(test)]
mod tests {
    use super::clean_segment;

    #[test]
    fn clean_segment_rejects_unsafe() {
        assert_eq!(clean_segment("Acme").as_deref(), Some("Acme"));
        assert_eq!(clean_segment("  spaced  ").as_deref(), Some("spaced"));
        assert_eq!(clean_segment(""), None);
        assert_eq!(clean_segment("."), None);
        assert_eq!(clean_segment(".."), None);
        assert_eq!(clean_segment("a/b"), None);
        assert_eq!(clean_segment("a\\b"), None);
    }
}

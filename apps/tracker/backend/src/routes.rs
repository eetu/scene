use std::sync::atomic::Ordering;

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use rusqlite::OptionalExtension;
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
        .route("/api/delete", post(api_delete))
        // Re-walk the collection (e.g. after moving files around).
        .route("/api/rescan", post(api_rescan))
        // Playlists: list/create, fetch/rename/delete one, manage its items.
        .route(
            "/api/playlists",
            get(api_playlists).post(api_create_playlist),
        )
        // Import a md5-keyed playlist document (static segment before {id}).
        .route("/api/playlists/import", post(api_import_playlist))
        .route(
            "/api/playlists/{id}",
            get(api_playlist)
                .post(api_rename_playlist)
                .delete(api_delete_playlist),
        )
        .route("/api/playlists/{id}/export", get(api_export_playlist))
        .route(
            "/api/playlists/{id}/items",
            post(api_add_item).put(api_reorder_items),
        )
        .route(
            "/api/playlists/{id}/items/{item_id}",
            delete(api_remove_item),
        )
        // Download a playlist's missing songs by md5 via Modland; poll progress.
        .route("/api/playlists/{id}/fetch-missing", post(api_fetch_missing))
        .route("/api/fetch/status", get(api_fetch_status))
        // All local md5s (for external curation/diffing).
        .route("/api/library/md5", get(api_library_md5))
        // The library manifest (aliases / group memberships / albums / credits)
        // and a cheap reload after a hand-edit (no rescan / hashing).
        .route("/api/manifest", get(api_manifest))
        .route("/api/library/reload", post(api_reload_manifest))
        // Curation: edit the manifest from the UI / an LLM (all write library.json
        // atomically then hot-swap — no rescan).
        .route("/api/artist/{name}", put(api_set_artist))
        .route("/api/albums", post(api_create_album))
        .route(
            "/api/albums/{id}",
            put(api_update_album).delete(api_delete_album),
        )
        .route("/api/albums/{id}/songs", post(api_add_album_song))
        .route("/api/albums/{id}/songs/{md5}", delete(api_remove_album_song))
        .route("/api/song/{md5}", put(api_set_song))
        // Duplicate report (exact + likely).
        .route("/api/dupes", get(api_dupes))
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
    md5: Option<String>,
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

/// The `Track` projection (16 columns, in struct field order), assuming `files`
/// aliased `f`, `meta` `m`, `stats` `s`. Shared by `api_tracks` and the playlist
/// detail query so the row mapper [`track_from_row`] works for both.
const TRACK_COLS: &str = "f.content_hash, f.rel_path, f.grp, f.artist, f.filename, f.ext, f.size,
    m.title, m.type_long, m.tracker, m.duration, m.channels, m.instruments, m.samples,
    COALESCE(s.favorite, 0), COALESCE(s.play_count, 0), f.md5";

/// Map a row projected by [`TRACK_COLS`] (optionally with leading extra columns,
/// hence `base` offset) into a [`Track`].
fn track_from_row(r: &rusqlite::Row, base: usize) -> rusqlite::Result<Track> {
    Ok(Track {
        hash: r.get(base)?,
        md5: r.get(base + 16)?,
        path: r.get(base + 1)?,
        group: r.get(base + 2)?,
        artist: r.get(base + 3)?,
        filename: r.get(base + 4)?,
        ext: r.get(base + 5)?,
        size: r.get(base + 6)?,
        title: r.get(base + 7)?,
        type_long: r.get(base + 8)?,
        tracker: r.get(base + 9)?,
        duration: r.get(base + 10)?,
        channels: r.get(base + 11)?,
        instruments: r.get(base + 12)?,
        samples: r.get(base + 13)?,
        favorite: r.get::<_, i64>(base + 14)? != 0,
        play_count: r.get(base + 15)?,
    })
}

async fn api_tracks(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let tracks = state
        .db
        .with(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {TRACK_COLS}
                 FROM files f
                 LEFT JOIN meta m ON m.content_hash = f.content_hash
                 LEFT JOIN stats s ON s.content_hash = f.content_hash
                 ORDER BY f.grp COLLATE NOCASE, f.artist COLLATE NOCASE, f.filename COLLATE NOCASE",
            ))?;
            let rows = stmt.query_map([], |r| track_from_row(r, 0))?;
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
    // A blank group means "no group" → the canonical _groupless directory.
    let group = if req.group.trim().is_empty() {
        crate::scan::GROUPLESS.to_string()
    } else {
        clean_segment(&req.group).ok_or_else(|| AppError::BadRequest("invalid group".into()))?
    };
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
    let (grp, art, fname, ext) = crate::scan::derive_fields(&to_rel, state.cfg.layout);
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

    let (grp, art, fname, ext) = crate::scan::derive_fields(&to_rel, state.cfg.layout);
    Ok(Json(json!({
        "path": to_rel,
        "group": grp,
        "artist": art,
        "filename": fname,
        "ext": ext,
    })))
}

#[derive(Deserialize)]
struct DeleteIn {
    /// Relative path under the root (the track's `path`) — as stored in the
    /// index, which is where the dupes report's paths come from.
    path: String,
}

/// Permanently delete a module file (primarily to clean up duplicates). Removes
/// it from disk and drops its index row; hash-keyed `meta`/`stats` are retained
/// (they follow the content — other copies of an exact dupe still reference them,
/// and a rescan reconciles regardless). Irreversible; the collection mount is
/// read-write (see the tracker CLAUDE.md).
async fn api_delete(
    _auth: Auth,
    State(state): State<AppState>,
    Json(req): Json<DeleteIn>,
) -> AppResult<Json<Value>> {
    let root = state.cfg.root.clone();
    let rel = req.path.clone();
    // Validate the target is a real file inside the root (rejects `..` escapes).
    let abs = root.join(&rel);
    let (canon, root_canon) = match (abs.canonicalize(), root.canonicalize()) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return Err(AppError::NotFound),
    };
    if !canon.starts_with(&root_canon) || !canon.is_file() {
        return Err(AppError::NotFound);
    }

    // Remove the file on a blocking thread.
    let for_fs = canon.clone();
    tokio::task::spawn_blocking(move || std::fs::remove_file(&for_fs))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound,
            _ => AppError::Internal(e.into()),
        })?;

    // Drop the index row (rel_path is unique; the path came from the index).
    let for_db = rel.clone();
    let removed = state
        .db
        .with(move |c| c.execute("DELETE FROM files WHERE rel_path=?1", [for_db]))
        .await?;

    Ok(Json(json!({ "path": rel, "removed": removed })))
}

async fn api_rescan(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let result = crate::run_scan(
        state.db.clone(),
        state.cfg.root.clone(),
        state.cfg.layout,
        state.scan.clone(),
    )
    .await
    .map_err(AppError::Internal)?;
    Ok(Json(json!({
        "indexed": result.indexed,
        "hashed": result.hashed,
        "removed": result.removed,
    })))
}

// ---------- playlists ----------

#[derive(Serialize)]
struct PlaylistSummary {
    id: String,
    name: String,
    kind: String,
    source_ref: Option<String>,
    item_count: i64,
    created_at: String,
    updated_at: String,
}

/// A playlist entry. `id` is the stable surrogate (reorder/remove). When the
/// module is present locally (md5 matches a file) the fields come from the
/// library and `hash` is its content_hash for playback; when missing they fall
/// back to the cached metadata and `present=false` (greyed, fetchable).
#[derive(Serialize)]
struct PlaylistTrack {
    id: i64,
    position: i64,
    md5: Option<String>,
    present: bool,
    hash: Option<String>,
    path: Option<String>,
    group: Option<String>,
    artist: Option<String>,
    filename: Option<String>,
    ext: Option<String>,
    size: Option<i64>,
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

/// A URL/id-safe slug from a playlist name (lowercase alphanumerics, single
/// dashes), falling back to "playlist" when the name has no usable characters.
fn slug(name: &str) -> String {
    let mut s = String::new();
    let mut prev_dash = false;
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
            prev_dash = false;
        } else if !prev_dash {
            s.push('-');
            prev_dash = true;
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "playlist".to_string()
    } else {
        s
    }
}

async fn api_playlists(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let lists = state
        .db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT p.id, p.name, p.kind, p.source_ref, p.created_at, p.updated_at,
                        (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id)
                 FROM playlists p
                 ORDER BY p.updated_at DESC, p.name COLLATE NOCASE",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(PlaylistSummary {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    source_ref: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                    item_count: r.get(6)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    Ok(Json(json!({ "playlists": lists })))
}

#[derive(Deserialize)]
struct CreatePlaylistIn {
    name: String,
}

async fn api_create_playlist(
    _auth: Auth,
    State(state): State<AppState>,
    Json(req): Json<CreatePlaylistIn>,
) -> AppResult<Json<PlaylistSummary>> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    let now = chrono::Utc::now();
    let id = format!("{}-{}", slug(&name), now.timestamp_millis());
    let now = now.to_rfc3339();
    let summary = PlaylistSummary {
        id: id.clone(),
        name: name.clone(),
        kind: "user".into(),
        source_ref: None,
        item_count: 0,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    state
        .db
        .with(move |c| {
            c.execute(
                "INSERT INTO playlists (id, name, kind, source_ref, created_at, updated_at)
                 VALUES (?1, ?2, 'user', NULL, ?3, ?3)",
                rusqlite::params![id, name, now],
            )
        })
        .await?;
    Ok(Json(summary))
}

async fn api_playlist(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let (summary, items) = state
        .db
        .with(move |c| {
            let summary = c.query_row(
                "SELECT p.id, p.name, p.kind, p.source_ref, p.created_at, p.updated_at,
                        (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id)
                 FROM playlists p WHERE p.id = ?1",
                [&id],
                |r| {
                    Ok(PlaylistSummary {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        kind: r.get(2)?,
                        source_ref: r.get(3)?,
                        created_at: r.get(4)?,
                        updated_at: r.get(5)?,
                        item_count: r.get(6)?,
                    })
                },
            )?;
            // Resolve each md5 to a local file (if present); an md5 can map to
            // several `files` rows (duplicate files), GROUP BY collapses to one.
            // Display fields prefer the local data, falling back to the cached
            // import metadata (pi.title/artist/format/filename) when missing.
            let mut stmt = c.prepare(
                "SELECT pi.id, pi.position, pi.md5,
                        f.content_hash, f.rel_path, f.grp, f.artist, f.filename, f.ext, f.size,
                        m.title, m.type_long, m.tracker, m.duration, m.channels,
                        m.instruments, m.samples,
                        COALESCE(s.favorite, 0), COALESCE(s.play_count, 0),
                        pi.title, pi.artist, pi.format, pi.filename
                 FROM playlist_items pi
                 LEFT JOIN files f ON f.rel_path = COALESCE(
                     (SELECT rel_path FROM files WHERE md5 = pi.md5 LIMIT 1),
                     (SELECT rel_path FROM files WHERE LOWER(filename) = LOWER(pi.filename)
                      LIMIT 1))
                 LEFT JOIN meta  m ON m.content_hash = f.content_hash
                 LEFT JOIN stats s ON s.content_hash = f.content_hash
                 WHERE pi.playlist_id = ?1
                 ORDER BY pi.position, pi.id",
            )?;
            let items = stmt
                .query_map([&id], |r| {
                    let hash: Option<String> = r.get(3)?;
                    let present = hash.is_some();
                    let loc_artist: Option<String> = r.get(6)?;
                    let loc_filename: Option<String> = r.get(7)?;
                    let loc_ext: Option<String> = r.get(8)?;
                    let loc_title: Option<String> = r.get(10)?;
                    let cached_title: Option<String> = r.get(19)?;
                    let cached_artist: Option<String> = r.get(20)?;
                    let cached_format: Option<String> = r.get(21)?;
                    let cached_filename: Option<String> = r.get(22)?;
                    Ok(PlaylistTrack {
                        id: r.get(0)?,
                        position: r.get(1)?,
                        md5: r.get(2)?,
                        present,
                        hash,
                        path: r.get(4)?,
                        group: r.get(5)?,
                        artist: loc_artist.or(cached_artist),
                        filename: loc_filename.or(cached_filename),
                        ext: loc_ext.or(cached_format),
                        size: r.get(9)?,
                        title: loc_title.or(cached_title),
                        type_long: r.get(11)?,
                        tracker: r.get(12)?,
                        duration: r.get(13)?,
                        channels: r.get(14)?,
                        instruments: r.get(15)?,
                        samples: r.get(16)?,
                        favorite: r.get::<_, i64>(17)? != 0,
                        play_count: r.get(18)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((summary, items))
        })
        .await?;
    Ok(Json(json!({ "playlist": summary, "items": items })))
}

async fn api_rename_playlist(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<CreatePlaylistIn>,
) -> AppResult<StatusCode> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let changed = state
        .db
        .with(move |c| {
            c.execute(
                "UPDATE playlists SET name = ?2, updated_at = ?3 WHERE id = ?1",
                rusqlite::params![id, name, now],
            )
        })
        .await?;
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn api_delete_playlist(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let changed = state
        .db
        .with(move |c| c.execute("DELETE FROM playlists WHERE id = ?1", [&id]))
        .await?;
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// One item to add/import. Hybrid identity: `md5` (local-library match key, when
/// known) and/or a fetch reference — `path` (a Modland `Format/Author/file`) and/
/// or `url` (a direct-download URL for sources Modland doesn't carry). At least
/// one must be present; the rest is cached display metadata.
#[derive(Deserialize, Clone)]
struct ItemIn {
    #[serde(default)]
    md5: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    url: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    format: Option<String>,
    filename: Option<String>,
}

impl ItemIn {
    /// Normalised md5 (lowercased, blanked if not a 32-hex string).
    fn norm_md5(&self) -> Option<String> {
        self.md5.as_deref().and_then(normalize_md5)
    }
    fn norm_path(&self) -> Option<String> {
        self.path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string)
    }
    /// Normalised url (http/https only — never let an import write arbitrary
    /// schemes like file:// into a fetch reference).
    fn norm_url(&self) -> Option<String> {
        self.url
            .as_deref()
            .map(str::trim)
            .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
            .map(str::to_string)
    }
    /// De-dup / identity key: md5 if present, else path, else url.
    fn key(&self) -> Option<String> {
        self.norm_md5()
            .or_else(|| self.norm_path())
            .or_else(|| self.norm_url())
    }
}

async fn api_add_item(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ItemIn>,
) -> AppResult<StatusCode> {
    let md5 = req.norm_md5();
    let path = req.norm_path();
    let url = req.norm_url();
    if md5.is_none() && path.is_none() && url.is_none() {
        return Err(AppError::BadRequest("md5, path, or url is required".into()));
    }
    let (title, artist, format, filename) = (
        req.title.clone(),
        req.artist.clone(),
        req.format.clone(),
        req.filename.clone(),
    );
    let touched = chrono::Utc::now().to_rfc3339();
    state
        .db
        .with_mut(move |c| {
            let tx = c.transaction()?;
            let exists: bool = tx
                .query_row("SELECT 1 FROM playlists WHERE id = ?1", [&id], |_| Ok(true))
                .optional()?
                .unwrap_or(false);
            if !exists {
                return Ok(false);
            }
            // Idempotent: dedup by md5 if present, else path, else url.
            let dup: bool = match (&md5, &path, &url) {
                (Some(m), _, _) => tx
                    .query_row(
                        "SELECT 1 FROM playlist_items WHERE playlist_id = ?1 AND md5 = ?2",
                        rusqlite::params![id, m],
                        |_| Ok(true),
                    )
                    .optional()?
                    .is_some(),
                (None, Some(p), _) => tx
                    .query_row(
                        "SELECT 1 FROM playlist_items WHERE playlist_id = ?1 AND path = ?2",
                        rusqlite::params![id, p],
                        |_| Ok(true),
                    )
                    .optional()?
                    .is_some(),
                (None, None, Some(u)) => tx
                    .query_row(
                        "SELECT 1 FROM playlist_items WHERE playlist_id = ?1 AND url = ?2",
                        rusqlite::params![id, u],
                        |_| Ok(true),
                    )
                    .optional()?
                    .is_some(),
                _ => false,
            };
            if !dup {
                let next: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_items WHERE playlist_id = ?1",
                    [&id],
                    |r| r.get(0),
                )?;
                tx.execute(
                    "INSERT INTO playlist_items
                       (playlist_id, position, md5, path, url, title, artist, format, filename)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    rusqlite::params![id, next, md5, path, url, title, artist, format, filename],
                )?;
            }
            tx.execute(
                "UPDATE playlists SET updated_at = ?2 WHERE id = ?1",
                rusqlite::params![id, touched],
            )?;
            tx.commit()?;
            Ok(true)
        })
        .await?
        .then_some(StatusCode::NO_CONTENT)
        .ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
struct ReorderIn {
    /// The playlist's item ids in the desired order (the frontend sends the full
    /// list). Items not listed keep their old position.
    ids: Vec<i64>,
}

async fn api_reorder_items(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ReorderIn>,
) -> AppResult<StatusCode> {
    let touched = chrono::Utc::now().to_rfc3339();
    state
        .db
        .with_mut(move |c| {
            let tx = c.transaction()?;
            let exists: bool = tx
                .query_row("SELECT 1 FROM playlists WHERE id = ?1", [&id], |_| Ok(true))
                .optional()?
                .unwrap_or(false);
            if !exists {
                return Ok(false);
            }
            for (pos, item_id) in req.ids.iter().enumerate() {
                tx.execute(
                    "UPDATE playlist_items SET position = ?1 WHERE id = ?2 AND playlist_id = ?3",
                    rusqlite::params![pos as i64, item_id, id],
                )?;
            }
            tx.execute(
                "UPDATE playlists SET updated_at = ?2 WHERE id = ?1",
                rusqlite::params![id, touched],
            )?;
            tx.commit()?;
            Ok(true)
        })
        .await?
        .then_some(StatusCode::NO_CONTENT)
        .ok_or(AppError::NotFound)
}

async fn api_remove_item(
    _auth: Auth,
    State(state): State<AppState>,
    Path((id, item_id)): Path<(String, i64)>,
) -> AppResult<StatusCode> {
    let changed = state
        .db
        .with(move |c| {
            c.execute(
                "DELETE FROM playlist_items WHERE playlist_id = ?1 AND id = ?2",
                rusqlite::params![id, item_id],
            )
        })
        .await?;
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---------- import / export ----------

#[derive(Deserialize)]
struct ImportIn {
    name: String,
    source: Option<String>,
    items: Vec<ItemIn>,
}

/// Import a playlist document. Each item needs an md5 and/or a Modland path;
/// de-duplicated by that key in order. Cached metadata is stored for display +
/// later fetching. Items resolve to local files by `files.md5`.
async fn api_import_playlist(
    _auth: Auth,
    State(state): State<AppState>,
    Json(req): Json<ImportIn>,
) -> AppResult<Json<PlaylistSummary>> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    // Keep items with a usable key (md5 or path), de-duped, first-seen order.
    let mut seen = std::collections::HashSet::new();
    let mut items: Vec<ItemIn> = Vec::new();
    for it in req.items {
        if let Some(k) = it.key() {
            if seen.insert(k) {
                items.push(it);
            }
        }
    }
    let now = chrono::Utc::now();
    let id = format!("{}-{}", slug(&name), now.timestamp_millis());
    let now = now.to_rfc3339();
    let source = req.source.clone();
    let summary = PlaylistSummary {
        id: id.clone(),
        name: name.clone(),
        kind: "imported".into(),
        source_ref: source.clone(),
        item_count: items.len() as i64,
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    state
        .db
        .with_mut(move |c| {
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO playlists (id, name, kind, source_ref, created_at, updated_at)
                 VALUES (?1, ?2, 'imported', ?3, ?4, ?4)",
                rusqlite::params![id, name, source, now],
            )?;
            {
                let mut ins = tx.prepare(
                    "INSERT INTO playlist_items
                       (playlist_id, position, md5, path, url, title, artist, format, filename)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )?;
                for (pos, it) in items.iter().enumerate() {
                    ins.execute(rusqlite::params![
                        id,
                        pos as i64,
                        it.norm_md5(),
                        it.norm_path(),
                        it.norm_url(),
                        it.title,
                        it.artist,
                        it.format,
                        it.filename
                    ])?;
                }
            }
            tx.commit()
        })
        .await?;
    Ok(Json(summary))
}

/// Export a playlist as an import document (md5 + best-known metadata, preferring
/// the cached values, falling back to the local library).
async fn api_export_playlist(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let (name, source, items) = state
        .db
        .with(move |c| {
            let (name, source): (String, Option<String>) = c.query_row(
                "SELECT name, source_ref FROM playlists WHERE id = ?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let mut stmt = c.prepare(
                "SELECT COALESCE(pi.md5, f.md5), pi.path, pi.url,
                        COALESCE(pi.title, m.title),
                        COALESCE(pi.artist, f.artist),
                        COALESCE(pi.format, f.ext),
                        COALESCE(pi.filename, f.filename)
                 FROM playlist_items pi
                 LEFT JOIN files f ON f.md5 = pi.md5
                 LEFT JOIN meta  m ON m.content_hash = f.content_hash
                 WHERE pi.playlist_id = ?1
                 GROUP BY pi.id
                 ORDER BY pi.position, pi.id",
            )?;
            let items = stmt
                .query_map([&id], |r| {
                    Ok(json!({
                        "md5": r.get::<_, Option<String>>(0)?,
                        "path": r.get::<_, Option<String>>(1)?,
                        "url": r.get::<_, Option<String>>(2)?,
                        "title": r.get::<_, Option<String>>(3)?,
                        "artist": r.get::<_, Option<String>>(4)?,
                        "format": r.get::<_, Option<String>>(5)?,
                        "filename": r.get::<_, Option<String>>(6)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((name, source, items))
        })
        .await?;
    Ok(Json(
        json!({ "name": name, "source": source, "items": items }),
    ))
}

/// All distinct content MD5s in the library — lets an external curator diff a
/// candidate list against the collection before producing an import doc.
async fn api_library_md5(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let md5s: Vec<String> = state
        .db
        .with(|c| {
            let mut s = c.prepare("SELECT DISTINCT md5 FROM files WHERE md5 IS NOT NULL")?;
            let rows = s.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    Ok(Json(json!({ "md5": md5s })))
}

// ---------- library manifest ----------

/// The library manifest (`library.json`): artist aliases + group memberships,
/// albums (by md5), per-song credits. The frontend joins it against the track
/// index client-side to build the group / artist / album facets.
async fn api_manifest(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let resolved = state.manifest.get();
    Ok(Json(serde_json::to_value(resolved.manifest()).map_err(
        |e| AppError::Internal(anyhow::anyhow!("serialise manifest: {e}")),
    )?))
}

/// Re-read `library.json` from disk (cheap — no rescan / hashing) so a hand-edit
/// on the mount takes effect without restarting or re-walking the collection.
async fn api_reload_manifest(_auth: Auth, State(state): State<AppState>) -> AppResult<StatusCode> {
    state.manifest.reload().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- library manifest curation ----------

/// Normalise an md5: lowercased, only if it's a 32-hex string.
fn normalize_md5(raw: &str) -> Option<String> {
    let m = raw.trim().to_lowercase();
    (m.len() == 32 && m.bytes().all(|b| b.is_ascii_hexdigit())).then_some(m)
}

/// Trim + drop-empty + de-dup a list of free-text values (groups, co-authors),
/// preserving first-seen order.
fn clean_str_list(items: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for it in items {
        let t = it.trim();
        if !t.is_empty() && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    out
}

/// Normalise + de-dup a list of md5s (dropping any that aren't 32-hex).
fn clean_md5_list(items: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for it in items {
        if let Some(m) = normalize_md5(it) {
            if !out.contains(&m) {
                out.push(m);
            }
        }
    }
    out
}

#[derive(Deserialize)]
struct ArtistIn {
    #[serde(default)]
    aka: Vec<String>,
    #[serde(default)]
    groups: Vec<String>,
}

/// Set an artist's alternate handles + group memberships (upsert by canonical
/// name = the folder name). Clearing both removes the entry — an undeclared
/// artist still browses (it resolves to itself). `aka` values must be folder-safe
/// handles; `groups` is free text.
async fn api_set_artist(
    _auth: Auth,
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<ArtistIn>,
) -> AppResult<StatusCode> {
    let name =
        clean_segment(&name).ok_or_else(|| AppError::BadRequest("invalid artist name".into()))?;
    let mut aka: Vec<String> = Vec::new();
    for a in &req.aka {
        if a.trim().is_empty() {
            continue;
        }
        let c = clean_segment(a).ok_or_else(|| AppError::BadRequest("invalid aka handle".into()))?;
        if c != name && !aka.contains(&c) {
            aka.push(c);
        }
    }
    let groups = clean_str_list(&req.groups);
    state
        .manifest
        .update(move |m| {
            if aka.is_empty() && groups.is_empty() {
                m.artists.shift_remove(&name);
            } else {
                m.artists
                    .insert(name, crate::manifest::Artist { aka, groups });
            }
            true
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct AlbumIn {
    id: Option<String>,
    title: Option<String>,
    kind: Option<String>,
    #[serde(default)]
    songs: Vec<String>,
}

/// Create an album (an ordered set of song md5s — a durable, ships-with-the-
/// archive collection). The id is the given slug, else derived from the title;
/// a collision is a 409 (pick another id).
async fn api_create_album(
    _auth: Auth,
    State(state): State<AppState>,
    Json(req): Json<AlbumIn>,
) -> AppResult<Json<Value>> {
    let id = match req.id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => slug(raw),
        None => slug(req.title.as_deref().unwrap_or("album")),
    };
    let album = crate::manifest::Album {
        title: req.title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
        kind: req.kind.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()),
        songs: clean_md5_list(&req.songs),
    };
    let id_for_db = id.clone();
    let created = state
        .manifest
        .update(move |m| {
            if m.albums.contains_key(&id_for_db) {
                return false;
            }
            m.albums.insert(id_for_db, album);
            true
        })
        .await?;
    if !created {
        return Err(AppError::Conflict("an album with that id already exists".into()));
    }
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct AlbumPatch {
    title: Option<String>,
    kind: Option<String>,
    /// When present, replaces the song list (normalised + de-duped).
    songs: Option<Vec<String>>,
}

/// Update an album's title / kind / songs. Fields absent from the body are left
/// unchanged; an empty `title`/`kind` string clears it. 404 if the id is unknown.
async fn api_update_album(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<AlbumPatch>,
) -> AppResult<StatusCode> {
    let songs = req.songs.as_ref().map(|s| clean_md5_list(s));
    let ok = state
        .manifest
        .update(move |m| {
            let Some(a) = m.albums.get_mut(&id) else {
                return false;
            };
            if let Some(t) = req.title {
                let t = t.trim();
                a.title = (!t.is_empty()).then(|| t.to_string());
            }
            if let Some(k) = req.kind {
                let k = k.trim();
                a.kind = (!k.is_empty()).then(|| k.to_string());
            }
            if let Some(s) = songs {
                a.songs = s;
            }
            true
        })
        .await?;
    ok.then_some(StatusCode::NO_CONTENT).ok_or(AppError::NotFound)
}

async fn api_delete_album(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let ok = state
        .manifest
        .update(move |m| m.albums.shift_remove(&id).is_some())
        .await?;
    ok.then_some(StatusCode::NO_CONTENT).ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
struct AlbumSongIn {
    md5: String,
}

/// Append a song (by md5) to an album, idempotently (a repeat is a no-op).
async fn api_add_album_song(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<AlbumSongIn>,
) -> AppResult<StatusCode> {
    let md5 = normalize_md5(&req.md5).ok_or_else(|| AppError::BadRequest("invalid md5".into()))?;
    let ok = state
        .manifest
        .update(move |m| {
            let Some(a) = m.albums.get_mut(&id) else {
                return false;
            };
            if !a.songs.iter().any(|s| normalize_md5(s).as_deref() == Some(md5.as_str())) {
                a.songs.push(md5);
            }
            true
        })
        .await?;
    ok.then_some(StatusCode::NO_CONTENT).ok_or(AppError::NotFound)
}

async fn api_remove_album_song(
    _auth: Auth,
    State(state): State<AppState>,
    Path((id, md5)): Path<(String, String)>,
) -> AppResult<StatusCode> {
    let md5 = normalize_md5(&md5).ok_or_else(|| AppError::BadRequest("invalid md5".into()))?;
    let ok = state
        .manifest
        .update(move |m| {
            let Some(a) = m.albums.get_mut(&id) else {
                return false;
            };
            a.songs.retain(|s| normalize_md5(s).as_deref() != Some(md5.as_str()));
            true
        })
        .await?;
    ok.then_some(StatusCode::NO_CONTENT).ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
struct SongIn {
    #[serde(rename = "forGroup")]
    for_group: Option<String>,
    #[serde(default)]
    with: Vec<String>,
    year: Option<i64>,
}

/// Set a song's non-derivable credit (forGroup / co-authors / year), keyed by
/// md5 so it follows the file across moves. Clearing every field removes the
/// entry (keeps the sparse `songs` map tidy).
async fn api_set_song(
    _auth: Auth,
    State(state): State<AppState>,
    Path(md5): Path<String>,
    Json(req): Json<SongIn>,
) -> AppResult<StatusCode> {
    let md5 = normalize_md5(&md5).ok_or_else(|| AppError::BadRequest("invalid md5".into()))?;
    let credit = crate::manifest::SongCredit {
        for_group: req
            .for_group
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty()),
        with: clean_str_list(&req.with),
        year: req.year,
    };
    let empty = credit.for_group.is_none() && credit.with.is_empty() && credit.year.is_none();
    state
        .manifest
        .update(move |m| {
            if empty {
                m.songs.shift_remove(&md5);
            } else {
                m.songs.insert(md5, credit);
            }
            true
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- fetch missing (download by Modland path) ----------

/// Fallback group for a fetched module whose Modland path carries no author.
const DL_FALLBACK_GROUP: &str = "Modland";
/// Safety cap on downloads per fetch run (be kind to a volunteer-run service).
const FETCH_MAX: usize = 500;

async fn api_fetch_status(_auth: Auth, State(state): State<AppState>) -> Json<Value> {
    use std::sync::atomic::Ordering;
    Json(json!({
        "running": state.fetch.running.load(Ordering::Relaxed),
        "total": state.fetch.total.load(Ordering::Relaxed),
        "fetched": state.fetch.fetched.load(Ordering::Relaxed),
        "failed": state.fetch.failed.load(Ordering::Relaxed),
    }))
}

async fn api_fetch_missing(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    use std::sync::atomic::Ordering;
    // Playlist must exist.
    let exists: bool = state
        .db
        .with({
            let id = id.clone();
            move |c| {
                c.query_row("SELECT 1 FROM playlists WHERE id = ?1", [&id], |_| Ok(true))
                    .optional()
                    .map(|o| o.unwrap_or(false))
            }
        })
        .await?;
    if !exists {
        return Err(AppError::NotFound);
    }
    if state
        .fetch
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(AppError::Conflict("a fetch is already running".into()));
    }
    state.fetch.total.store(0, Ordering::Relaxed);
    state.fetch.fetched.store(0, Ordering::Relaxed);
    state.fetch.failed.store(0, Ordering::Relaxed);

    let bg = state.clone();
    tokio::spawn(async move {
        if let Err(e) = run_fetch_missing(&bg, &id).await {
            tracing::error!(error = %e, "fetch-missing failed");
        }
        bg.fetch.running.store(false, Ordering::Relaxed);
    });
    Ok(Json(json!({ "started": true })))
}

/// A missing playlist item to fetch: its id plus the fetch references and the
/// cached filename/artist used to place a by-`url` download.
struct Missing {
    item_id: i64,
    path: Option<String>,
    url: Option<String>,
    filename: Option<String>,
    artist: Option<String>,
}

/// Download a playlist's missing items — by Modland `path` (preferred), else by
/// the generic `url` — placing each under `<author>/<filename>` (suffixed on
/// collision), recording the downloaded md5 on the item, then rescanning so they
/// resolve as present.
async fn run_fetch_missing(state: &AppState, id: &str) -> anyhow::Result<()> {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    // Missing = items with a fetch reference (path or url) not yet resolved to a
    // local file (md5 unknown, or md5 set but no matching file, and no filename
    // match either).
    let missing: Vec<Missing> = state
        .db
        .with({
            let id = id.to_string();
            move |c| {
                let mut s = c.prepare(
                    "SELECT pi.id, pi.path, pi.url, pi.filename, pi.artist FROM playlist_items pi
                     WHERE pi.playlist_id = ?1 AND (pi.path IS NOT NULL OR pi.url IS NOT NULL)
                       AND NOT EXISTS (SELECT 1 FROM files f WHERE f.md5 = pi.md5)
                       AND NOT EXISTS (
                         SELECT 1 FROM files f WHERE LOWER(f.filename) = LOWER(pi.filename))
                     ORDER BY pi.position",
                )?;
                let rows = s.query_map([&id], |r| {
                    Ok(Missing {
                        item_id: r.get(0)?,
                        path: r.get(1)?,
                        url: r.get(2)?,
                        filename: r.get(3)?,
                        artist: r.get(4)?,
                    })
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            }
        })
        .await?;
    state.fetch.total.store(missing.len(), Ordering::Relaxed);
    tracing::info!(count = missing.len(), "fetch-missing: downloading");

    if missing.len() > FETCH_MAX {
        tracing::warn!(
            cap = FETCH_MAX,
            total = missing.len(),
            "capping downloads this run"
        );
    }
    let client = crate::modland::Client::new(state.cfg.modland_base.clone())?;
    let mut wrote_any = false;
    for m in missing.iter().take(FETCH_MAX) {
        // Prefer the Modland path; fall back to a generic url.
        let dl = match (&m.path, &m.url) {
            (Some(p), _) => client.download_path(p).await,
            (None, Some(u)) => client.download_url(u).await,
            (None, None) => continue,
        };
        let bytes = match dl {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(path = ?m.path, url = ?m.url, error = %e, "download failed");
                state.fetch.failed.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };
        let (_sha, md5) = crate::scan::hash_bytes(&bytes);
        // Already have these exact bytes under another name? Just resolve the item.
        let have = state
            .db
            .with({
                let md5 = md5.clone();
                move |c| {
                    c.query_row("SELECT 1 FROM files WHERE md5 = ?1", [&md5], |_| Ok(()))
                        .optional()
                }
            })
            .await?
            .is_some();
        if !have {
            let (group, artist, filename) = place_download(m);
            if let Err(e) = write_module(
                &state.cfg.root,
                &group,
                artist.as_deref(),
                &filename,
                &bytes,
            )
            .await
            {
                tracing::warn!(file = %filename, error = %e, "write failed");
                state.fetch.failed.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            wrote_any = true;
        }
        // Record the resolved md5 on the item so it links to the file.
        let item_id = m.item_id;
        let md5_for_db = md5.clone();
        state
            .db
            .with(move |c| {
                c.execute(
                    "UPDATE playlist_items SET md5 = ?1 WHERE id = ?2",
                    rusqlite::params![md5_for_db, item_id],
                )
            })
            .await?;
        state.fetch.fetched.fetch_add(1, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    // Index the new files so their md5s exist → playlist items resolve as present.
    if wrote_any {
        crate::run_scan(
            state.db.clone(),
            state.cfg.root.clone(),
            state.cfg.layout,
            state.scan.clone(),
        )
        .await?;
    }
    tracing::info!(
        fetched = state.fetch.fetched.load(Ordering::Relaxed),
        failed = state.fetch.failed.load(Ordering::Relaxed),
        "fetch-missing complete"
    );
    Ok(())
}

/// Where a fetched module is filed: `(group, artist, filename)`, at the library's
/// `group/artist/song` convention.
///
/// From a Modland `path` (`Format/Author/.../file`): group = format, artist =
/// author, both straight from the path. From a `url` (no path — e.g. a Mod
/// Archive item): the library's canonical no-group bucket, so group =
/// [`GROUPLESS`](crate::scan::GROUPLESS) and artist = the item's curated artist
/// when present — landing at `_groupless/<artist>/<file>` (or `_groupless/<file>`
/// when unknown), never a phantom host-named group.
fn place_download(m: &Missing) -> (String, Option<String>, String) {
    match &m.path {
        Some(p) => (
            crate::modland::format_from_path(p).unwrap_or_else(|| DL_FALLBACK_GROUP.to_string()),
            crate::modland::author_from_path(p),
            p.rsplit('/').next().unwrap_or("module").to_string(),
        ),
        None => (
            crate::scan::GROUPLESS.to_string(),
            m.artist.clone().filter(|a| !a.trim().is_empty()),
            m.filename.clone().unwrap_or_else(|| "module".to_string()),
        ),
    }
}

/// Write a downloaded module under `<group>/<artist>/<filename>` (the library's
/// `group/artist/song` convention), or `<group>/<filename>` when no artist is
/// known. Suffixes the filename (`name~2.ext`) on collision so a fetch never
/// overwrites an existing file.
async fn write_module(
    root: &std::path::Path,
    group: &str,
    artist: Option<&str>,
    filename: &str,
    bytes: &[u8],
) -> anyhow::Result<()> {
    let g = clean_segment(group).unwrap_or_else(|| DL_FALLBACK_GROUP.to_string());
    let name = clean_segment(filename)
        .filter(|n| crate::scan::has_module_ext(n))
        .ok_or_else(|| anyhow::anyhow!("unsafe or non-module filename: {filename}"))?;
    let dir = match artist.and_then(clean_segment) {
        Some(a) => root.join(&g).join(a),
        None => root.join(&g),
    };
    tokio::fs::create_dir_all(&dir).await?;
    let dest = unique_dest(&dir, &name);
    tokio::fs::write(&dest, bytes).await?;
    Ok(())
}

/// A non-existing destination in `dir` for `name`, suffixing `~2`, `~3`, … on the
/// stem when the plain name is taken.
fn unique_dest(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let plain = dir.join(name);
    if !plain.exists() {
        return plain;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.to_string(), String::new()),
    };
    for n in 2..1000 {
        let cand = dir.join(format!("{stem}~{n}{ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    plain
}

// ---------- duplicate report ----------

/// Report duplicate modules: **exact** (identical md5 at multiple paths) and
/// **likely** (same filename, different md5 — probably the same tune re-encoded).
/// Tracker only reports; resolution (rename/delete) stays manual / external.
async fn api_dupes(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    use std::collections::BTreeMap;
    let (exact, likely) = state
        .db
        .with(|c| {
            // Exact: same md5, multiple files.
            let mut by_md5: BTreeMap<String, Vec<String>> = BTreeMap::new();
            {
                let mut s = c.prepare(
                    "SELECT md5, rel_path FROM files
                     WHERE md5 IS NOT NULL AND md5 IN (
                       SELECT md5 FROM files WHERE md5 IS NOT NULL
                       GROUP BY md5 HAVING COUNT(*) > 1)
                     ORDER BY md5, rel_path",
                )?;
                let mut rows = s.query([])?;
                while let Some(r) = rows.next()? {
                    by_md5.entry(r.get(0)?).or_default().push(r.get(1)?);
                }
            }
            // Likely: same filename, >1 distinct md5. Each file carries its
            // favourite / play-count / playlist membership (all keyed to its own
            // bytes) so the UI can show which copy is referenced somewhere — you
            // delete the orphan that's in no list.
            let mut by_name: BTreeMap<String, Vec<Value>> = BTreeMap::new();
            {
                let mut s = c.prepare(
                    "SELECT LOWER(f.filename) fn, f.rel_path, f.md5, f.content_hash,
                            COALESCE(st.favorite, 0), COALESCE(st.play_count, 0),
                            (SELECT GROUP_CONCAT(p.name, '||') FROM playlist_items pi
                             JOIN playlists p ON p.id = pi.playlist_id WHERE pi.md5 = f.md5)
                     FROM files f
                     LEFT JOIN stats st ON st.content_hash = f.content_hash
                     WHERE f.md5 IS NOT NULL AND LOWER(f.filename) IN (
                       SELECT LOWER(filename) FROM files WHERE md5 IS NOT NULL
                       GROUP BY LOWER(filename) HAVING COUNT(DISTINCT md5) > 1)
                     ORDER BY fn, f.rel_path",
                )?;
                let mut rows = s.query([])?;
                while let Some(r) = rows.next()? {
                    let fname: String = r.get(0)?;
                    let playlists_raw: Option<String> = r.get(6)?;
                    let playlists: Vec<&str> = playlists_raw
                        .as_deref()
                        .map(|s| s.split("||").collect())
                        .unwrap_or_default();
                    by_name.entry(fname).or_default().push(json!({
                        "path": r.get::<_, String>(1)?,
                        "md5": r.get::<_, String>(2)?,
                        "hash": r.get::<_, String>(3)?,
                        "favorite": r.get::<_, i64>(4)? != 0,
                        "play_count": r.get::<_, i64>(5)?,
                        "playlists": playlists,
                    }));
                }
            }
            let exact: Vec<Value> = by_md5
                .into_iter()
                .map(|(md5, paths)| json!({ "md5": md5, "paths": paths }))
                .collect();
            let likely: Vec<Value> = by_name
                .into_iter()
                .map(|(filename, files)| json!({ "filename": filename, "files": files }))
                .collect();
            Ok((exact, likely))
        })
        .await?;
    Ok(Json(json!({ "exact": exact, "likely": likely })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn missing(path: Option<&str>, url: Option<&str>, artist: Option<&str>) -> Missing {
        Missing {
            item_id: 1,
            path: path.map(str::to_string),
            url: url.map(str::to_string),
            filename: Some("newtune.mod".into()),
            artist: artist.map(str::to_string),
        }
    }

    #[test]
    fn place_from_modland_path() {
        // group = format, artist = author, filename = last segment.
        let (g, a, f) = place_download(&missing(Some("Protracker/coma/newtune.mod"), None, None));
        assert_eq!(
            (g.as_str(), a.as_deref(), f.as_str()),
            ("Protracker", Some("coma"), "newtune.mod")
        );
    }

    #[test]
    fn place_url_with_artist_goes_to_groupless() {
        // A url item (no path) with a curated artist → _groupless/<artist>/<file>,
        // never a host-derived group.
        let (g, a, f) = place_download(&missing(
            None,
            Some("https://api.modarchive.org/downloads.php?moduleid=42"),
            Some("4-mat"),
        ));
        assert_eq!(
            (g.as_str(), a.as_deref(), f.as_str()),
            (crate::scan::GROUPLESS, Some("4-mat"), "newtune.mod")
        );
    }

    #[test]
    fn place_url_without_artist_is_groupless_flat() {
        // No usable artist (absent or blank) → _groupless with no artist subdir.
        for artist in [None, Some("   ")] {
            let (g, a, _) = place_download(&missing(
                None,
                Some("https://api.modarchive.org/downloads.php?moduleid=42"),
                artist,
            ));
            assert_eq!(g, crate::scan::GROUPLESS);
            assert_eq!(a, None);
        }
    }
}

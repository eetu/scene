use std::collections::HashMap;
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
        .route("/api/tracks", get(api_tracks))
        .route("/api/file/{hash}", get(api_file))
        .route("/api/meta/{hash}", post(api_meta))
        .route("/api/favorite/{hash}", post(api_favorite))
        .route("/api/play/{hash}", post(api_play))
        .route("/api/rename", post(api_rename))
        .route("/api/delete", post(api_delete))
        .route("/api/library/ids", get(api_library_ids))
        .route("/api/tracks/batch", get(api_tracks_batch))
        .route("/api/track/{hash}", get(api_track_by_hash))
        .route("/api/library/unenriched", get(api_unenriched))
        .route("/api/song-length/{hash}", post(api_song_length))
        .route("/api/stil/{id}", get(api_stil))
        .route("/api/roms/{which}", get(api_rom))
        .route("/api/reels", get(api_reels))
        .route("/api/reels/{id}", get(api_reel))
        .route("/api/rescan", post(api_rescan))
        .route("/api/rescan/{root}", post(api_rescan_root))
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
        .route("/api/playlists/{id}/fetch-missing", post(api_fetch_missing))
        .route("/api/fetch/status", get(api_fetch_status))
        .route("/api/library/md5", get(api_library_md5))
        .route("/api/manifest", get(api_manifest))
        .route("/api/library/reload", post(api_reload_manifest))
        .route("/api/artist/{name}", put(api_set_artist))
        .route("/api/albums", post(api_create_album))
        .route(
            "/api/albums/{id}",
            put(api_update_album).delete(api_delete_album),
        )
        .route("/api/albums/{id}/songs", post(api_add_album_song))
        .route(
            "/api/albums/{id}/songs/{md5}",
            delete(api_remove_album_song),
        )
        .route("/api/song/{md5}", put(api_set_song))
        .route("/api/dupes", get(api_dupes))
        // NOT tower-http ServeDir (its not_found_service leaks a 404 onto every
        // client route).
        .fallback(get(serve_spa))
        .with_state(state)
}

async fn serve_spa(
    State(state): State<AppState>,
    uri: axum::http::Uri,
) -> axum::response::Response {
    scene_backend::spa::spa_response(&state.cfg.static_dir, &uri).await
}

/// Map a blocking filesystem task's error onto the API error space.
fn io_to_app(e: std::io::Error) -> AppError {
    match e.kind() {
        std::io::ErrorKind::AlreadyExists => {
            AppError::Conflict("destination already exists".into())
        }
        std::io::ErrorKind::NotFound => AppError::NotFound,
        _ => AppError::Internal(e.into()),
    }
}

/// 204 for a row-touching statement, 404 when it matched nothing.
fn changed_or_404(changed: usize) -> AppResult<StatusCode> {
    if changed == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Trimmed, non-empty `name` field, else 400.
fn required_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name is required".into()));
    }
    Ok(name.to_string())
}

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
    // Per-root counts, so the source selector can label each collection. Same
    // scanning caveat as above; the UI simply omits the count until it's known.
    let counts: std::collections::HashMap<String, i64> = if scanning {
        std::collections::HashMap::new()
    } else {
        state
            .db
            .with(|c| {
                let mut s = c.prepare("SELECT root_id, COUNT(*) FROM files GROUP BY root_id")?;
                let rows = s
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows.into_iter().collect())
            })
            .await
            .unwrap_or_default()
    };
    // HVSC facts, per root. Absent entirely when no HVSC root is configured —
    // that absence *is* the feature flag: the SPA shows nothing HVSC-specific
    // unless a collection is actually mounted.
    let hvsc: HashMap<String, Value> = if scanning {
        HashMap::new()
    } else {
        let ids: Vec<String> = state
            .cfg
            .roots
            .iter()
            .filter(|r| r.kind == crate::config::RootKind::Hvsc)
            .map(|r| r.id.clone())
            .collect();
        if ids.is_empty() {
            HashMap::new()
        } else {
            state
                .db
                .with(move |c| {
                    let mut out = HashMap::new();
                    let mut s = c.prepare(
                        "SELECT version, tunes, subtunes, indexed_at FROM hvsc_state
                         WHERE root_id = ?1",
                    )?;
                    for id in ids {
                        let row = s
                            .query_row([&id], |r| {
                                Ok(json!({
                                    "version": r.get::<_, Option<i64>>(0)?,
                                    "tunes": r.get::<_, i64>(1)?,
                                    "subtunes": r.get::<_, i64>(2)?,
                                    "indexed_at": r.get::<_, String>(3)?,
                                }))
                            })
                            .optional()?;
                        // A configured-but-unindexed root still appears, so the
                        // UI can say "not indexed yet" rather than nothing.
                        out.insert(id, row.unwrap_or(Value::Null));
                    }
                    Ok(out)
                })
                .await
                .unwrap_or_default()
        }
    };

    Json(json!({
        "service": "tracker",
        "version": env!("CARGO_PKG_VERSION"),
        "db_healthy": scanning || track_count.is_some(),
        "track_count": track_count,
        "root": state.cfg.primary().path.display().to_string(),
        "roots": state.cfg.roots.iter().map(|r| json!({
            "id": r.id,
            "label": r.label(),
            "kind": if r.kind.writable() { "scan" } else { "hvsc" },
            "path": r.path.display().to_string(),
            "count": counts.get(&r.id).copied(),
        })).collect::<Vec<_>>(),
        // Playback fallback for a SID with no known length (see Config).
        "sid_default_length": state.cfg.sid_default_length,
        "hvsc": hvsc,
        "scanning": scanning,
        "scan_total": state.scan.total.load(Ordering::Relaxed),
        "scan_processed": state.scan.processed.load(Ordering::Relaxed),
        "scan_hashed": state.scan.hashed.load(Ordering::Relaxed),
        // What the last finished scan did. `POST /api/rescan` answers 202 before
        // there's anything to report, so this is where the counts (or the
        // failure) surface. Null until one has run in this process.
        "last_scan": state.scan.last.lock().ok().and_then(|s| s.clone()),
    }))
}

/// One library entry. Path-derived fields are always present; the rest come
/// from the `meta` cache (LEFT JOIN) and are null until enrichment fills them.
#[derive(Serialize)]
struct Track {
    /// The playable track's id: the file's surrogate id with its subtune folded
    /// in (see `library::track_id`). The key the shaped library streams and the
    /// client hydrates, queues and plays by.
    id: i64,
    /// Which subtune of the file this is (0 for a module, and for a SID holding
    /// only one). The engine needs it to select the tune after loading.
    subsong: i64,
    /// How many subtunes the file holds; 0 for anything that isn't multi-tune.
    /// Drives the `Tune 3/12` sub-label.
    subsongs: i64,
    hash: String,
    md5: Option<String>,
    path: String,
    /// The configured root this file lives in (`config::Root::id`) — the axis
    /// the library's source selector filters on.
    collection: String,
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

/// The `Track` projection, assuming `files` aliased `f`, `meta` `m`, `stats` `s`.
/// Shared by `api_tracks` and the playlist detail query so the row mapper
/// [`track_from_row`] works for both.
///
/// Column order here and the offsets in [`track_from_row`] are coupled by
/// position, and the mapper reads some columns out of struct-field order — so
/// **append new columns at the end** rather than inserting. `projection_matches_mapper`
/// guards the pairing.
const TRACK_COLS: &str = "f.content_hash, f.rel_path, f.grp, f.artist, f.filename, f.ext, f.size,
    COALESCE(sg.title, m.title), m.type_long, m.tracker,
    COALESCE(sg.duration, m.duration), m.channels, m.instruments, m.samples,
    COALESCE(s.favorite, 0), COALESCE(s.play_count, 0), f.md5, f.root_id, f.id,
    COALESCE(sg.subsong, 0),
    (SELECT COUNT(*) FROM songs s2 WHERE s2.content_hash = f.content_hash)";

/// Number of columns [`TRACK_COLS`] projects. Only the guard test needs it —
/// it catches a column added to the list without a matching mapper offset.
#[cfg(test)]
const TRACK_COL_COUNT: usize = 21;

/// Map a row projected by [`TRACK_COLS`] (optionally with leading extra columns,
/// hence `base` offset) into a [`Track`].
fn track_from_row(r: &rusqlite::Row, base: usize) -> rusqlite::Result<Track> {
    let subsong: i64 = r.get(base + 19)?;
    Ok(Track {
        id: crate::library::track_id(r.get(base + 18)?, subsong),
        subsong,
        subsongs: r.get(base + 20)?,
        hash: r.get(base)?,
        md5: r.get(base + 16)?,
        path: r.get(base + 1)?,
        collection: r.get(base + 17)?,
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
                 {TRACK_JOINS}
                 ORDER BY f.grp COLLATE NOCASE, f.artist COLLATE NOCASE, f.filename COLLATE NOCASE",
            ))?;
            let rows = stmt.query_map([], |r| track_from_row(r, 0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    Ok(Json(json!({ "tracks": tracks })))
}

/// The lean projection the shaper works over — every indexed row, but only the
/// columns filtering / grouping / sorting need. Ordered A-Z, which is the base
/// order the shaper's stable sorts tie-break to.
/// Joins `songs`, so a file holding several subtunes yields one row per subtune
/// and a plain module (no `songs` rows) yields exactly one. Per-subtune title
/// and duration win over the file-level ones.
const SHAPE_COLS: &str = "f.id, f.root_id, f.rel_path, f.grp, f.artist, f.filename, f.ext, f.md5,
    COALESCE(sg.title, m.title), m.type_long, m.tracker,
    COALESCE(sg.duration, m.duration), m.channels,
    COALESCE(s.favorite, 0), COALESCE(s.play_count, 0), COALESCE(sg.subsong, 0)";

/// The joins every track projection needs. `songs` is LEFT so modules survive it.
const TRACK_JOINS: &str = "LEFT JOIN songs sg ON sg.content_hash = f.content_hash
     LEFT JOIN meta  m  ON m.content_hash = f.content_hash
     LEFT JOIN stats s  ON s.content_hash = f.content_hash AND s.subsong = COALESCE(sg.subsong, 0)";

fn shape_row(r: &rusqlite::Row) -> rusqlite::Result<crate::library::Row> {
    let file_id: i64 = r.get(0)?;
    let subsong: i64 = r.get(15)?;
    Ok(crate::library::Row {
        id: crate::library::track_id(file_id, subsong),
        collection: r.get(1)?,
        path: r.get(2)?,
        group: r.get(3)?,
        artist: r.get(4)?,
        filename: r.get(5)?,
        ext: r.get(6)?,
        md5: r.get(7)?,
        title: r.get(8)?,
        type_long: r.get(9)?,
        tracker: r.get(10)?,
        duration: r.get(11)?,
        channels: r.get(12)?,
        favorite: r.get::<_, i64>(13)? != 0,
        play_count: r.get(14)?,
    })
}

/// The shaped library: an ordered id stream grouped into buckets, plus the facet
/// options. This replaces shipping the whole index to the browser — at ~91k
/// tracks the old `/api/tracks` payload is tens of megabytes.
///
/// The client renders headers + rows from this and hydrates only the visible
/// window via [`api_tracks_batch`]. Crucially it stays an *ordered list*, so the
/// seeded shuffle keeps permuting indices into it exactly as it did over the
/// client-side flattened list — `prev` still walks the same history, and the
/// order still survives a reload.
async fn api_library_ids(
    _auth: Auth,
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<crate::library::Query>,
) -> AppResult<Json<crate::library::Shaped>> {
    let idx = state.manifest.get();
    let shaped = state
        .db
        .with(move |c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {SHAPE_COLS}
                 FROM files f
                 {TRACK_JOINS}
                 ORDER BY f.grp COLLATE NOCASE, f.artist COLLATE NOCASE,
                          f.filename COLLATE NOCASE, COALESCE(sg.subsong, 0)",
            ))?;
            let rows = stmt
                .query_map([], shape_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(crate::library::shape(&rows, &q, &idx))
        })
        .await?;
    Ok(Json(shaped))
}

/// Tracks with no parsed metadata yet, plus the total outstanding.
///
/// Bulk enrichment decodes each module in the browser (libopenmpt WASM) and
/// POSTs the result back, so it needs the actual rows — and it can no longer
/// filter them out of a full index the browser holds. Returns a page at a time;
/// the run loops until the count reaches zero.
///
/// `sid` files are excluded: their metadata is parsed server-side from the PSID
/// header, so handing 61k of them to libopenmpt would be pure waste.
async fn api_unenriched(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    const PAGE: usize = 500;
    let (count, tracks) = state
        .db
        .with(move |c| {
            let count: i64 = c.query_row(
                "SELECT COUNT(*) FROM files f
                 LEFT JOIN meta m ON m.content_hash = f.content_hash
                 WHERE m.type_long IS NULL AND f.ext NOT IN ('sid','psid','rsid')",
                [],
                |r| r.get(0),
            )?;
            let mut stmt = c.prepare(&format!(
                "SELECT {TRACK_COLS}
                 FROM files f
                 {TRACK_JOINS}
                 WHERE m.type_long IS NULL AND f.ext NOT IN ('sid','psid','rsid')
                 LIMIT {PAGE}"
            ))?;
            let rows = stmt
                .query_map([], |r| track_from_row(r, 0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok((count, rows))
        })
        .await?;
    Ok(Json(json!({ "count": count, "tracks": tracks })))
}

#[derive(Deserialize)]
struct SongLengthIn {
    #[serde(default)]
    subsong: i64,
    /// Seconds, or null to forget the override and fall back to the default.
    duration: Option<f64>,
}

/// Set (or clear) one subtune's known length.
///
/// SID headers carry no duration, and HVSC's Songlengths database only covers
/// HVSC. So a hand-curated SID's length is something you establish by listening
/// — the UI writes here with the position you stopped at. Stored in `songs`,
/// the same column an HVSC index fills, so both sources agree afterwards.
async fn api_song_length(
    _auth: Auth,
    State(state): State<AppState>,
    Path(hash): Path<String>,
    Json(req): Json<SongLengthIn>,
) -> AppResult<StatusCode> {
    if req.subsong < 0 || req.subsong >= crate::library::SUBSONG_SLOTS {
        return Err(AppError::BadRequest("subsong out of range".into()));
    }
    if req.duration.is_some_and(|d| !d.is_finite() || d <= 0.0) {
        return Err(AppError::BadRequest("duration must be positive".into()));
    }
    state
        .db
        .with(move |c| {
            c.execute(
                "INSERT INTO songs (content_hash, subsong, duration) VALUES (?1, ?2, ?3)
                 ON CONFLICT(content_hash, subsong) DO UPDATE SET duration = excluded.duration",
                rusqlite::params![hash, req.subsong, req.duration],
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Serve one C64 system ROM to the SID decoder.
///
/// `which` is a fixed allowlist (`kernal` | `basic` | `chargen`) matched against
/// the *start* of the filename, so any KERNAL revision works —
/// `kernal-901227-03.bin` is what VICE calls rev 3, but rev 1 or a regional
/// variant would serve just as well. Nothing from the request reaches the
/// filesystem, so there is no traversal surface here at all.
///
/// The size check is the real guard: a truncated or wrong-machine ROM would
/// otherwise be accepted and produce a subtly broken emulation rather than an
/// error. 404 when unconfigured or absent — the engine then uses its built-in
/// images, which is a degraded but working state.
async fn api_rom(
    _auth: Auth,
    State(state): State<AppState>,
    Path(which): Path<String>,
) -> AppResult<impl IntoResponse> {
    let expect_len = match which.as_str() {
        "kernal" | "basic" => 8192,
        "chargen" => 4096,
        _ => return Err(AppError::NotFound),
    };
    let dir = state.cfg.roms_dir.as_ref().ok_or(AppError::NotFound)?;
    let entries = std::fs::read_dir(dir).map_err(|_| AppError::NotFound)?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_lowercase();
        if !name.starts_with(&which) {
            continue;
        }
        let bytes = match std::fs::read(e.path()) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if bytes.len() != expect_len {
            tracing::warn!(
                file = %name, len = bytes.len(), expect_len,
                "ignoring ROM of the wrong size"
            );
            continue;
        }
        return Ok((
            [
                (header::CONTENT_TYPE, "application/octet-stream".to_string()),
                // Content-addressed by name + immutable in practice.
                (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
            ],
            bytes,
        ));
    }
    Err(AppError::NotFound)
}

/// The visualiser reels this machine has — their ids, for the player to match a track
/// against.
///
/// On the mount and not in the image, for the same reason as the ROMs above: a reel is
/// derived frames of somebody else's video (see the player's `assets/README.md`), so the
/// operator builds one and the repository never carries it. That is also why this is a
/// route at all rather than a bundled asset — a build-time glob would put the file in the
/// image, which is exactly what must not happen.
///
/// A missing directory is an empty list, not an error: no reels is the normal state.
async fn api_reels(_auth: Auth, State(state): State<AppState>) -> AppResult<impl IntoResponse> {
    let mut ids: Vec<String> = Vec::new();
    if let Some(dir) = state.cfg.reels_dir.as_ref() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                // Finder's AppleDouble sidecars are `._<name>` and end in `.bin` too, so
                // they listed as ids — and `._badapple` sorts BEFORE `badapple` and folds
                // to the same key once punctuation is stripped, so the junk won the match,
                // 404'd (an id may not contain a dot), and the client cached the failure.
                // The reel was dead on any share macOS had touched, which is all of them.
                // Same predicate the scanner uses to ignore this stuff.
                if scene_backend::scan::is_macos_junk(&name) {
                    continue;
                }
                if let Some(id) = name.strip_suffix(".bin") {
                    if !id.is_empty() {
                        ids.push(id.to_string());
                    }
                }
            }
        }
    }
    ids.sort();
    Ok(Json(json!({ "reels": ids })))
}

/// One reel's bytes.
///
/// The id comes from the client, so it is checked rather than joined: a single path
/// segment of the characters an id may contain, which is what `api_reels` published. A
/// bare `contains("..")` test would still admit a slash, and `Path` will hand over
/// anything that is not one.
async fn api_reel(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::NotFound);
    }
    let dir = state.cfg.reels_dir.as_ref().ok_or(AppError::NotFound)?;
    let bytes = std::fs::read(dir.join(format!("{id}.bin"))).map_err(|_| AppError::NotFound)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            // Immutable in practice — a rebuilt clip is a rebuilt file, and the player
            // fetches each one once per session anyway.
            (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
        ],
        bytes,
    ))
}

/// One track by content hash — the deep-link (`?t=<hash>`) restore path. The
/// client can't search for it any more: the browser no longer holds the index,
/// and a stored filter may exclude the bookmarked track from the visible list
/// entirely, so it has to be fetchable on its own.
async fn api_track_by_hash(
    _auth: Auth,
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> AppResult<Json<Value>> {
    let track = state
        .db
        .with(move |c| {
            c.query_row(
                &format!(
                    // A deep link names a file, not a subtune — take its first.
                    "SELECT {TRACK_COLS}
                     FROM files f
                     {TRACK_JOINS}
                     WHERE f.content_hash = ?1
                     ORDER BY COALESCE(sg.subsong, 0) LIMIT 1"
                ),
                [&hash],
                |r| track_from_row(r, 0),
            )
            .optional()
        })
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(json!({ "track": track })))
}

/// The STIL notes for one track — HVSC's curator commentary.
///
/// Its own endpoint rather than a column on the track projection: the notes run
/// to paragraphs (one tune in #85 carries a 60-line essay), and the library list
/// never shows them. Only the player pane asks, once per tune played, where it
/// substitutes for the instrument/sample name text a module supplies.
///
/// Returns both the file-scope record and the subtune's, in that order — a tune
/// commonly has a general note plus a per-subtune credit. Empty for anything
/// with no notes, which is most of the collection and not an error.
async fn api_stil(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    let (file_id, subsong) = crate::library::split_track_id(id);
    let notes = state
        .db
        .with(move |c| {
            let Some((root_id, rel_path)) = c
                .query_row(
                    "SELECT root_id, rel_path FROM files WHERE id = ?1",
                    [file_id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?
            else {
                return Ok(Vec::new());
            };
            let mut s = c.prepare(
                "SELECT subsong, comment, title, artist, name, author FROM stil
                 WHERE root_id = ?1 AND rel_path = ?2 AND subsong IN (-1, ?3)
                 ORDER BY subsong",
            )?;
            let rows = s.query_map(rusqlite::params![root_id, rel_path, subsong], |r| {
                Ok(json!({
                    "subsong": r.get::<_, i64>(0)?,
                    "comment": r.get::<_, Option<String>>(1)?,
                    "title": r.get::<_, Option<String>>(2)?,
                    "artist": r.get::<_, Option<String>>(3)?,
                    "name": r.get::<_, Option<String>>(4)?,
                    "author": r.get::<_, Option<String>>(5)?,
                }))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    Ok(Json(json!({ "notes": notes })))
}

/// Hydrate a window of the id stream. Ids are echoed back in the order the
/// caller asked for, so the virtualizer can splice rows without re-sorting.
#[derive(Deserialize)]
struct BatchQuery {
    /// Comma-separated `files.id` list.
    ids: String,
}

/// Cap on one hydration request — a viewport is tens of rows, so this is only a
/// guard against a caller asking for the whole 91k-row library in one go.
const BATCH_MAX: usize = 1000;

async fn api_tracks_batch(
    _auth: Auth,
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<BatchQuery>,
) -> AppResult<Json<Value>> {
    let ids: Vec<i64> = q
        .ids
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<i64>())
        .collect::<Result<_, _>>()
        .map_err(|_| AppError::BadRequest("ids must be integers".into()))?;
    if ids.len() > BATCH_MAX {
        return Err(AppError::BadRequest(format!(
            "at most {BATCH_MAX} ids per request"
        )));
    }
    if ids.is_empty() {
        return Ok(Json(json!({ "tracks": [] })));
    }

    // Track ids fold the subtune in, so query the *files* they name and let the
    // `songs` join expand each back into its subtunes; the map below then picks
    // out exactly the ones asked for. A window over a multi-tune file therefore
    // costs one row per requested subtune, not one query per subtune.
    let mut file_ids: Vec<i64> = ids
        .iter()
        .map(|id| crate::library::split_track_id(*id).0)
        .collect();
    file_ids.sort_unstable();
    file_ids.dedup();

    let placeholders = std::iter::repeat_n("?", file_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let wanted = file_ids;
    let tracks = state
        .db
        .with(move |c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {TRACK_COLS}
                 FROM files f
                 {TRACK_JOINS}
                 WHERE f.id IN ({placeholders})",
            ))?;
            let params = rusqlite::params_from_iter(wanted.iter());
            let out = stmt
                .query_map(params, |r| track_from_row(r, 0))?
                .collect::<rusqlite::Result<Vec<_>>>();
            out
        })
        .await?;

    // Restore the requested order — SQL's `IN` says nothing about it.
    let by_id: std::collections::HashMap<i64, Track> =
        tracks.into_iter().map(|t| (t.id, t)).collect();
    let ordered: Vec<&Track> = ids.iter().filter_map(|id| by_id.get(id)).collect();
    Ok(Json(json!({ "tracks": ordered })))
}

/// Resolve an index pair `(root_id, rel_path)` to a real file on disk.
///
/// Both halves matter. `root_id` must name a *currently configured* root, so a
/// row left behind by a root that was removed from the config resolves to
/// nothing rather than being reinterpreted against some other root's tree. And
/// the canonicalized result must still sit inside that root, so a symlink or a
/// `..` that slipped past the scan can't escape it. Returns `None` on any
/// failure — callers map that to 404 rather than leaking which check failed.
fn resolve_in_root(
    cfg: &crate::config::Config,
    root_id: &str,
    rel_path: &str,
) -> Option<std::path::PathBuf> {
    let root = cfg.root(root_id)?;
    let canon = root.path.join(rel_path).canonicalize().ok()?;
    let canon_root = root.path.canonicalize().ok()?;
    (canon.starts_with(&canon_root) && canon.is_file()).then_some(canon)
}

async fn api_file(
    _auth: Auth,
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> AppResult<impl IntoResponse> {
    // Any path with these bytes will do — duplicates share a hash. The root
    // comes from the row, not from a default: two roots can hold the same bytes.
    let (root_id, rel_path): (String, String) = state
        .db
        .with(|c| {
            c.query_row(
                "SELECT root_id, rel_path FROM files WHERE content_hash = ?1 LIMIT 1",
                [&hash],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .await
        .map_err(|_| AppError::NotFound)?;

    // rel_path comes from our own scan, but canonicalize + prefix-check anyway.
    let canon = resolve_in_root(&state.cfg, &root_id, &rel_path).ok_or(AppError::NotFound)?;

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
    /// Which subtune — a SID's tunes are favourited separately. Absent → 0,
    /// which is every module and every single-tune file.
    #[serde(default)]
    subsong: i64,
}

/// The subtune a play/meta write applies to, as `?subsong=N`. Defaults to 0.
#[derive(Deserialize, Default)]
struct SubsongQuery {
    #[serde(default)]
    subsong: i64,
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
                "INSERT INTO stats (content_hash, subsong, favorite) VALUES (?1, ?2, ?3)
                 ON CONFLICT(content_hash, subsong) DO UPDATE SET favorite = excluded.favorite",
                rusqlite::params![hash, req.subsong, req.favorite as i64],
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
    axum::extract::Query(q): axum::extract::Query<SubsongQuery>,
) -> AppResult<Json<Value>> {
    let now = chrono::Utc::now().to_rfc3339();
    let count: i64 = state
        .db
        .with(move |c| {
            c.execute(
                "INSERT INTO stats (content_hash, subsong, play_count, last_played)
                 VALUES (?1, ?2, 1, ?3)
                 ON CONFLICT(content_hash, subsong) DO UPDATE SET
                   play_count = play_count + 1, last_played = excluded.last_played",
                rusqlite::params![hash, q.subsong, now],
            )?;
            c.query_row(
                "SELECT play_count FROM stats WHERE content_hash = ?1 AND subsong = ?2",
                rusqlite::params![hash, q.subsong],
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
    /// The collection the file belongs to (the track's `collection`). Omitted
    /// by older callers → the primary root.
    #[serde(default)]
    root: Option<String>,
    group: String,
    artist: Option<String>,
    filename: String,
}

/// Resolve a mutating request's target root and refuse the ones that are
/// read-only by nature. An `hvsc` root is a versioned upstream distribution —
/// renaming or deleting inside it would desync it from its own index and be
/// undone by the next release, so it is never writable.
fn writable_root<'a>(
    cfg: &'a crate::config::Config,
    root: Option<&str>,
) -> AppResult<&'a crate::config::Root> {
    let root = match root {
        Some(id) => cfg
            .root(id)
            .ok_or_else(|| AppError::BadRequest(format!("unknown root {id:?}")))?,
        None => cfg.primary(),
    };
    if !root.kind.writable() {
        return Err(AppError::BadRequest(format!(
            "root {:?} is read-only",
            root.id
        )));
    }
    Ok(root)
}

/// A single safe path segment: non-empty, not `.`/`..`, and free of separators
/// and Windows/SMB-illegal characters (so a name is portable across the share).
fn clean_segment(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty()
        || t == "."
        || t == ".."
        || t.contains(['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|'])
    {
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
    // Artist-primary: the folder is the artist, falling back to the group field
    // (for a caller that only knows a group), else the _unknown bucket. No group
    // directory — groups live in the manifest.
    let folder = artist.clone().unwrap_or_else(|| {
        if group == crate::scan::GROUPLESS {
            crate::scan::UNKNOWN_ARTIST.to_string()
        } else {
            group.clone()
        }
    });
    let to_rel = format!("{folder}/{filename}");
    let from_rel = req.from.clone();
    if from_rel == to_rel {
        return Err(AppError::BadRequest(
            "source and destination are the same".into(),
        ));
    }

    let target = writable_root(&state.cfg, req.root.as_deref())?;
    let (root_id, root) = (target.id.clone(), target.path.clone());
    // Validate the source is a real file inside the root (rejects `..` escapes).
    let from_canon = resolve_in_root(&state.cfg, &root_id, &from_rel).ok_or(AppError::NotFound)?;
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
    .map_err(io_to_app)?;

    // Update the index row in place (hash unchanged → meta still matches).
    let (grp, art, fname, ext) = crate::scan::derive_fields(&to_rel);
    let to_for_db = to_rel.clone();
    let db_fields = (grp.clone(), art.clone(), fname.clone(), ext.clone());
    state
        .db
        .with(move |c| {
            let (grp, art, fname, ext) = db_fields;
            c.execute(
                "UPDATE files SET rel_path=?1, grp=?2, artist=?3, filename=?4, ext=?5
                 WHERE root_id=?6 AND rel_path=?7",
                rusqlite::params![to_for_db, grp, art, fname, ext, root_id, from_rel],
            )
        })
        .await?;

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
    /// The collection the file belongs to; omitted → the primary root.
    #[serde(default)]
    root: Option<String>,
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
    let root_id = writable_root(&state.cfg, req.root.as_deref())?.id.clone();
    let rel = req.path.clone();
    // Validate the target is a real file inside the root (rejects `..` escapes).
    let canon = resolve_in_root(&state.cfg, &root_id, &rel).ok_or(AppError::NotFound)?;

    // Remove the file on a blocking thread.
    let for_fs = canon.clone();
    tokio::task::spawn_blocking(move || std::fs::remove_file(&for_fs))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .map_err(io_to_app)?;

    // Drop the index row ((root_id, rel_path) is unique; both came from the index).
    let for_db = rel.clone();
    let removed = state
        .db
        .with(move |c| {
            c.execute(
                "DELETE FROM files WHERE root_id=?1 AND rel_path=?2",
                rusqlite::params![root_id, for_db],
            )
        })
        .await?;

    Ok(Json(json!({ "path": rel, "removed": removed })))
}

/// Rescan the primary root. Kept for callers that predate multiple roots.
async fn api_rescan(
    _auth: Auth,
    State(state): State<AppState>,
) -> AppResult<(StatusCode, Json<Value>)> {
    let id = state.cfg.primary().id.clone();
    rescan_root(&state, &id).await
}

/// Rescan one named root, leaving the others' rows alone.
async fn api_rescan_root(
    _auth: Auth,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> AppResult<(StatusCode, Json<Value>)> {
    rescan_root(&state, &root).await
}

/// Walked roots answer `202` and scan in the background; an HVSC root answers
/// `200` with its counts, because reindexing one is a single catalogue read that
/// finishes in seconds — detaching it would trade a useful synchronous result
/// for nothing.
async fn rescan_root(state: &AppState, root_id: &str) -> AppResult<(StatusCode, Json<Value>)> {
    let root = state
        .cfg
        .root(root_id)
        .ok_or_else(|| AppError::BadRequest(format!("unknown root {root_id:?}")))?;
    // An HVSC root rebuilds from its own catalogue rather than being walked, so
    // "rescan" means "reindex" — one 5MB read instead of 61k stats and hashes.
    if root.kind == crate::config::RootKind::Hvsc {
        // Configured as HVSC but not actually one. That's a misconfigured path,
        // not a server fault, so say so plainly instead of surfacing an IO error
        // as a 500.
        if !crate::hvsc::looks_like_hvsc(&root.path) {
            return Err(AppError::BadRequest(format!(
                "root {root_id:?} has no DOCUMENTS/Songlengths.md5 — not an HVSC collection"
            )));
        }
        let r = crate::run_hvsc_index(
            state.db.clone(),
            root.id.clone(),
            root.path.clone(),
            state.scan.clone(),
        )
        .await
        .map_err(AppError::Internal)?;
        return Ok((
            StatusCode::OK,
            Json(json!({
                "indexed": r.tunes,
                "subtunes": r.subtunes,
                "removed": r.removed,
                "notes": r.notes,
                "hashed": 0,
            })),
        ));
    }
    // One at a time. Two scans would serialise on the single SQLite connection
    // anyway, but they'd also interleave their writes to the shared progress
    // counters, so `/status` would report a meaningless blend of the two.
    //
    // Claimed with compare-exchange rather than a load-then-store: now that the
    // request returns before the scan starts, two arriving together would both
    // pass a plain check. `run_scan` sets the same flag again (harmlessly) and
    // its drop guard is what clears it, on any exit including a panic.
    if state
        .scan
        .scanning
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(AppError::Conflict("a scan is already running".into()));
    }

    // Answer 202 and walk detached: a scan is minutes of stat-and-hash over a
    // network mount, and `spawn_blocking` runs to completion whether or not
    // anyone awaits it anyway. Progress comes from the lock-free counters
    // `/status` reads; the outcome lands in `scan.last` (written by `run_scan`
    // *before* it clears the `scanning` flag, so a client polling "scanning
    // went false → read last_scan" can't observe the gap).
    let db = state.db.clone();
    let progress = state.scan.clone();
    let id = root.id.clone();
    let path = root.path.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::run_scan(db, id.clone(), path, progress).await {
            tracing::error!(root = %id, error = %e, "scan failed");
        }
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "started": true, "root": root_id })),
    ))
}

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
    /// The root of the local file this item resolved to; null when the item
    /// isn't present locally (nothing to serve, nothing to filter).
    collection: Option<String>,
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

/// Columns for [`playlist_summary_row`] — the two must stay in sync.
const PLAYLIST_COLS: &str = "p.id, p.name, p.kind, p.source_ref, p.created_at, p.updated_at,
     (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id)";

fn playlist_summary_row(r: &rusqlite::Row) -> rusqlite::Result<PlaylistSummary> {
    Ok(PlaylistSummary {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        source_ref: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        item_count: r.get(6)?,
    })
}

async fn api_playlists(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let lists = state
        .db
        .with(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {PLAYLIST_COLS} FROM playlists p
                 ORDER BY p.updated_at DESC, p.name COLLATE NOCASE"
            ))?;
            let rows = stmt.query_map([], playlist_summary_row)?;
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
    let name = required_name(&req.name)?;
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
                &format!("SELECT {PLAYLIST_COLS} FROM playlists p WHERE p.id = ?1"),
                [&id],
                playlist_summary_row,
            )?;
            // Resolve each md5 to a local file (if present); an md5 can map to
            // several `files` rows (duplicate files), GROUP BY collapses to one.
            // Display fields prefer the local data, falling back to the cached
            // import metadata (pi.title/artist/format/filename) when missing.
            // Join on the surrogate `files.id`: rel_path is only unique within a
            // root, so matching on it would collapse same-named files from two
            // collections onto each other.
            let mut stmt = c.prepare(
                "SELECT pi.id, pi.position, pi.md5,
                        f.content_hash, f.rel_path, f.grp, f.artist, f.filename, f.ext, f.size,
                        m.title, m.type_long, m.tracker, m.duration, m.channels,
                        m.instruments, m.samples,
                        COALESCE(s.favorite, 0), COALESCE(s.play_count, 0),
                        pi.title, pi.artist, pi.format, pi.filename, f.root_id
                 FROM playlist_items pi
                 LEFT JOIN files f ON f.id = COALESCE(
                     (SELECT id FROM files WHERE md5 = pi.md5 LIMIT 1),
                     (SELECT id FROM files WHERE LOWER(filename) = LOWER(pi.filename)
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
                        collection: r.get(23)?,
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
    let name = required_name(&req.name)?;
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
    changed_or_404(changed)
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
    changed_or_404(changed)
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
            let key = md5
                .as_ref()
                .map(|v| ("md5", v))
                .or_else(|| path.as_ref().map(|v| ("path", v)))
                .or_else(|| url.as_ref().map(|v| ("url", v)));
            let dup: bool = match key {
                Some((col, val)) => tx
                    .query_row(
                        &format!(
                            "SELECT 1 FROM playlist_items WHERE playlist_id = ?1 AND {col} = ?2"
                        ),
                        rusqlite::params![id, val],
                        |_| Ok(true),
                    )
                    .optional()?
                    .is_some(),
                None => false,
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
    changed_or_404(changed)
}

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
    let name = required_name(&req.name)?;
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
        let c =
            clean_segment(a).ok_or_else(|| AppError::BadRequest("invalid aka handle".into()))?;
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
        title: req
            .title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty()),
        kind: req
            .kind
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty()),
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
        return Err(AppError::Conflict(
            "an album with that id already exists".into(),
        ));
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

/// Run a manifest update; 204 when the closure reports success, else 404.
async fn manifest_204(
    state: &AppState,
    mutate: impl FnOnce(&mut crate::manifest::Manifest) -> bool,
) -> AppResult<StatusCode> {
    let ok = state.manifest.update(mutate).await?;
    ok.then_some(StatusCode::NO_CONTENT)
        .ok_or(AppError::NotFound)
}

/// Mutate album `id`; 404 for an unknown id.
async fn album_204(
    state: &AppState,
    id: String,
    mutate: impl FnOnce(&mut crate::manifest::Album),
) -> AppResult<StatusCode> {
    manifest_204(state, move |m| {
        let Some(a) = m.albums.get_mut(&id) else {
            return false;
        };
        mutate(a);
        true
    })
    .await
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
    album_204(&state, id, move |a| {
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
    })
    .await
}

async fn api_delete_album(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    manifest_204(&state, move |m| m.albums.shift_remove(&id).is_some()).await
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
    album_204(&state, id, move |a| {
        if !a
            .songs
            .iter()
            .any(|s| normalize_md5(s).as_deref() == Some(md5.as_str()))
        {
            a.songs.push(md5);
        }
    })
    .await
}

async fn api_remove_album_song(
    _auth: Auth,
    State(state): State<AppState>,
    Path((id, md5)): Path<(String, String)>,
) -> AppResult<StatusCode> {
    let md5 = normalize_md5(&md5).ok_or_else(|| AppError::BadRequest("invalid md5".into()))?;
    album_204(&state, id, move |a| {
        a.songs
            .retain(|s| normalize_md5(s).as_deref() != Some(md5.as_str()));
    })
    .await
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

/// Fallback group for a fetched module whose Modland path carries no author.
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
            let (artist, filename) = place_download(m);
            if let Err(e) = write_module(
                &state.cfg.primary().path,
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
            state.cfg.primary().id.clone(),
            state.cfg.primary().path.clone(),
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

/// Where a fetched module is filed: `(artist, filename)`, artist-primary.
///
/// From a Modland `path` (`Format/Author/.../file`): artist = the author segment
/// (the format is a facet, not a directory). From a `url` (no path — e.g. a Mod
/// Archive item): artist = the item's curated artist when present. Either way the
/// module lands at `<artist>/<file>`, or the `_unknown/` bucket when no artist is
/// known (see [`write_module`]).
fn place_download(m: &Missing) -> (Option<String>, String) {
    let filename = match &m.path {
        Some(p) => p.rsplit('/').next().unwrap_or("module").to_string(),
        None => m.filename.clone().unwrap_or_else(|| "module".to_string()),
    };
    let artist = m
        .path
        .as_deref()
        .and_then(crate::modland::author_from_path)
        .or_else(|| m.artist.clone())
        .filter(|a| !a.trim().is_empty());
    (artist, filename)
}

/// Write a downloaded module under `<artist>/<filename>` (artist-primary), or the
/// canonical `_unknown/<filename>` bucket when no artist is known. Suffixes the
/// filename (`name~2.ext`) on collision so a fetch never overwrites an existing
/// file.
async fn write_module(
    root: &std::path::Path,
    artist: Option<&str>,
    filename: &str,
    bytes: &[u8],
) -> anyhow::Result<()> {
    let name = clean_segment(filename)
        .filter(|n| crate::scan::has_module_ext(n))
        .ok_or_else(|| anyhow::anyhow!("unsafe or non-module filename: {filename}"))?;
    let folder = artist
        .and_then(clean_segment)
        .unwrap_or_else(|| crate::scan::UNKNOWN_ARTIST.to_string());
    let dir = root.join(folder);
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

/// Report duplicate modules: **exact** (identical md5 at multiple paths) and
/// **likely** (same filename, different md5 — probably the same tune re-encoded).
/// Tracker only reports; resolution (rename/delete) stays manual / external.
async fn api_dupes(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    use std::collections::BTreeMap;
    let (exact, likely) = state
        .db
        .with(|c| {
            // Exact: same md5, multiple files.
            // The content hash comes along so the UI can play a copy: identical
            // bytes share one hash by definition, and the browser no longer holds
            // an index it could look the path up in.
            let mut by_md5: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
            {
                let mut s = c.prepare(
                    "SELECT md5, rel_path, content_hash FROM files
                     WHERE md5 IS NOT NULL AND md5 IN (
                       SELECT md5 FROM files WHERE md5 IS NOT NULL
                       GROUP BY md5 HAVING COUNT(*) > 1)
                     ORDER BY md5, rel_path",
                )?;
                let mut rows = s.query([])?;
                while let Some(r) = rows.next()? {
                    let (md5, path, hash): (String, String, String) =
                        (r.get(0)?, r.get(1)?, r.get(2)?);
                    by_md5.entry(md5).or_insert((hash, Vec::new())).1.push(path);
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
                .map(|(md5, (hash, paths))| json!({ "md5": md5, "hash": hash, "paths": paths }))
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

    /// `TRACK_COLS` and `track_from_row` are coupled by column position, with
    /// `md5`/`root_id` appended out of struct order — inserting a column in the
    /// middle would silently mis-map every field after it. Project the real
    /// columns over a real row and assert each landed in the right field.
    #[test]
    fn projection_matches_mapper() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::db::schema_sql()).unwrap();
        conn.execute(
            "INSERT INTO files (root_id, rel_path, grp, artist, filename, ext, size, mtime,
                                content_hash, md5)
             VALUES ('hvsc', 'MUSICIANS/H/Hubbard_Rob/Commando.sid', '', 'Hubbard_Rob',
                     'Commando.sid', 'sid', 4242, 0, 'sha-here', 'md5-here')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO meta (content_hash, title, type_long, tracker, duration, channels,
                               instruments, samples, n_orders, n_patterns, updated_at)
             VALUES ('sha-here', 'Commando', 'PSID', 'Rob Hubbard', 213.5, 3, 0, 0, 0, 0, '')",
            [],
        )
        .unwrap();
        // Three subtunes, and the favourite belongs to the middle one only —
        // per-subtune stats are the point of the composite key.
        conn.execute(
            "INSERT INTO songs (content_hash, subsong, title, author, duration)
             VALUES ('sha-here', 0, 'Tune One', 'Rob Hubbard', 60.0),
                    ('sha-here', 1, 'Tune Two', 'Rob Hubbard', 90.0),
                    ('sha-here', 2, 'Tune Three', 'Rob Hubbard', 30.0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO stats (content_hash, subsong, favorite, play_count)
             VALUES ('sha-here', 1, 1, 7)",
            [],
        )
        .unwrap();

        let sql = format!("SELECT {TRACK_COLS} FROM files f {TRACK_JOINS} WHERE sg.subsong = 1");
        let mut stmt = conn.prepare(&sql).unwrap();
        assert_eq!(
            stmt.column_count(),
            TRACK_COL_COUNT,
            "TRACK_COL_COUNT is out of date with TRACK_COLS"
        );
        let t = stmt.query_row([], |r| track_from_row(r, 0)).unwrap();

        // The subtune's own title and duration win over the file-level ones.
        assert_eq!(t.title.as_deref(), Some("Tune Two"));
        assert_eq!(t.duration, Some(90.0));
        assert_eq!(t.subsong, 1);
        assert_eq!(t.subsongs, 3);
        assert_eq!(t.id, crate::library::track_id(t.id / 256, 1));
        assert_eq!(t.hash, "sha-here");
        assert_eq!(t.md5.as_deref(), Some("md5-here"));
        assert_eq!(t.path, "MUSICIANS/H/Hubbard_Rob/Commando.sid");
        assert_eq!(t.collection, "hvsc");
        assert_eq!(t.group, "");
        assert_eq!(t.artist.as_deref(), Some("Hubbard_Rob"));
        assert_eq!(t.filename, "Commando.sid");
        assert_eq!(t.ext, "sid");
        assert_eq!(t.size, 4242);
        assert_eq!(t.type_long.as_deref(), Some("PSID"));
        assert_eq!(t.tracker.as_deref(), Some("Rob Hubbard"));
        assert_eq!(t.channels, Some(3));
        assert!(t.favorite);
        assert_eq!(t.play_count, 7);

        // The *other* subtunes carry their own titles and none of subtune 1's
        // listener state — a favourite on one tune is not a favourite on twelve.
        let sql = format!("SELECT {TRACK_COLS} FROM files f {TRACK_JOINS} WHERE sg.subsong = 2");
        let other = conn
            .prepare(&sql)
            .unwrap()
            .query_row([], |r| track_from_row(r, 0))
            .unwrap();
        assert_eq!(other.title.as_deref(), Some("Tune Three"));
        assert!(!other.favorite);
        assert_eq!(other.play_count, 0);
        assert_ne!(other.id, t.id, "each subtune is its own track");
    }

    /// Finder leaves `._<name>` beside every file it touches on a CIFS share, and those
    /// end in `.bin` too — so they listed as reel ids. `._badapple` then sorted ahead of
    /// `badapple`, folded to the same key once the client stripped punctuation, won the
    /// match, and 404'd on a dot the id rule forbids: the real clip was never fetched and
    /// the feature was silently dead on every share macOS had opened.
    #[test]
    fn the_reel_listing_ignores_macos_junk() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "badapple.bin",
            "._badapple.bin",
            "._other.bin",
            ".DS_Store",
            "notes.txt",
            ".bin",
        ] {
            std::fs::write(dir.path().join(name), b"x").unwrap();
        }
        let mut ids: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !scene_backend::scan::is_macos_junk(n))
            .filter_map(|n| n.strip_suffix(".bin").map(str::to_string))
            .filter(|id| !id.is_empty())
            .collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["badapple"],
            "junk or non-reels leaked into the list"
        );
    }

    /// Two scans would serialise on the single SQLite connection anyway, but they would
    /// also interleave their writes to the shared progress counters, so `/status` would
    /// report a meaningless blend of the two runs.
    ///
    /// Tested by setting the flag rather than by racing a real scan. The integration suite
    /// used to seed 800 files so that a second request would land while the first was
    /// still walking — a bet on the machine being slower than a round trip, which is not
    /// something a test should depend on. Here "a scan is running" is a fact.
    #[tokio::test]
    async fn a_second_rescan_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::config::Config {
            bind: "127.0.0.1:0".into(),
            dev_auth: true,
            roots: vec![crate::config::Root {
                id: "mods".into(),
                kind: crate::config::RootKind::Scan,
                path: dir.path().to_path_buf(),
            }],
            db_path: ":memory:".into(),
            static_dir: dir.path().to_path_buf(),
            modland_base: String::new(),
            manifest_path: dir.path().join("library.json"),
            roms_dir: None,
            reels_dir: None,
            sid_default_length: 180,
        };
        let state = AppState::new(cfg, crate::db::Db::open_in_memory().unwrap());

        // Nothing running: the claim succeeds and the scan is accepted.
        let (code, _) = rescan_root(&state, "mods").await.unwrap();
        assert_eq!(code, StatusCode::ACCEPTED);

        // The handler spawned a real scan of an empty directory, which may or may not have
        // finished by now — so assert the guard against a flag we set ourselves rather
        // than against whatever that scan is doing. Same code path, no timing.
        state.scan.scanning.store(true, Ordering::SeqCst);
        let err = rescan_root(&state, "mods").await.unwrap_err();
        assert!(
            matches!(err, AppError::Conflict(_)),
            "a concurrent scan must be refused, got {err:?}"
        );

        // …and once the flag clears, scanning is possible again.
        state.scan.scanning.store(false, Ordering::SeqCst);
        let (code, _) = rescan_root(&state, "mods").await.unwrap();
        assert_eq!(code, StatusCode::ACCEPTED);
    }

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
        // artist = the author segment (the format is a facet, not a directory);
        // filename = last segment.
        let (a, f) = place_download(&missing(Some("Protracker/coma/newtune.mod"), None, None));
        assert_eq!((a.as_deref(), f.as_str()), (Some("coma"), "newtune.mod"));
    }

    #[test]
    fn place_url_with_artist() {
        // A url item (no path) with a curated artist → <artist>/<file>.
        let (a, f) = place_download(&missing(
            None,
            Some("https://api.modarchive.org/downloads.php?moduleid=42"),
            Some("4-mat"),
        ));
        assert_eq!((a.as_deref(), f.as_str()), (Some("4-mat"), "newtune.mod"));
    }

    #[test]
    fn place_url_without_artist_is_unknown() {
        // No usable artist (absent or blank) → None; write_module files it under
        // the canonical _unknown bucket.
        for artist in [None, Some("   ")] {
            let (a, _) = place_download(&missing(
                None,
                Some("https://api.modarchive.org/downloads.php?moduleid=42"),
                artist,
            ));
            assert_eq!(a, None);
        }
    }
}

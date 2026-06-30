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
        // Unauthenticated liveness probe.
        .route("/status", get(status))
        // Landing: the list of parties.
        .route("/api/parties", get(api_parties))
        // A party's catalog of productions (grouped/ordered by competition).
        .route("/api/parties/{slug}/productions", get(api_productions))
        // One production with its files + music metadata.
        .route("/api/production/{id}", get(api_production))
        // Raw file bytes by content hash (player + emulator + download).
        .route("/api/file/{hash}", get(api_file))
        // Same bytes, name-in-URL variant so emulators can read the extension.
        .route("/api/file/{hash}/{name}", get(api_file_named))
        // Shared, unscanned support data (e.g. emulator BIOS) served by filename.
        .route("/api/support/{file}", get(api_support))
        // Text/NFO/DIZ content, decoded CP437 → UTF-8.
        .route("/api/text/{hash}", get(api_text))
        // Derived (transcoded) asset: `<hash>.png` | `<hash>.mp4`. Cached on disk.
        .route("/api/asset/{file}", get(api_asset))
        // js-dos bundle (`<prod_id>.jsdos`) for running a PC demo/intro in-browser.
        .route("/api/bundle/{file}", get(api_bundle))
        // libopenmpt enrichment posted by the frontend after parsing a module.
        .route("/api/meta/{hash}", post(api_meta))
        // Re-walk the tree.
        .route("/api/rescan", post(api_rescan))
        // SPA fallback.
        .fallback(get(serve_spa))
        .with_state(state)
}

async fn serve_spa(State(state): State<AppState>, uri: axum::http::Uri) -> axum::response::Response {
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
    let counts: Option<(i64, i64, i64)> = if scanning {
        None
    } else {
        state
            .db
            .with(|c| {
                let files: i64 = c.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?;
                let prods: i64 =
                    c.query_row("SELECT COUNT(*) FROM productions", [], |r| r.get(0))?;
                let parties: i64 = c.query_row("SELECT COUNT(*) FROM parties", [], |r| r.get(0))?;
                Ok((files, prods, parties))
            })
            .await
            .ok()
    };
    Json(json!({
        "service": "party",
        "version": env!("CARGO_PKG_VERSION"),
        "db_healthy": scanning || counts.is_some(),
        "file_count": counts.map(|c| c.0),
        "production_count": counts.map(|c| c.1),
        "party_count": counts.map(|c| c.2),
        // Kiosk redacts the server's filesystem path from a public probe.
        "root": if state.cfg.kiosk {
            Value::Null
        } else {
            Value::String(state.cfg.root.display().to_string())
        },
        "kiosk": state.cfg.kiosk,
        "scanning": scanning,
        "scan_total": state.scan.total.load(Ordering::Relaxed),
        "scan_processed": state.scan.processed.load(Ordering::Relaxed),
        "scan_hashed": state.scan.hashed.load(Ordering::Relaxed),
    }))
}

// ---------- gated api ----------

#[derive(Serialize)]
struct PartyOut {
    slug: String,
    name: String,
    year: Option<i64>,
    location: Option<String>,
    organizer: Option<String>,
    n_productions: i64,
    n_files: i64,
    logo_hash: Option<String>,
    logo_kind: Option<String>,
}

async fn api_parties(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let parties = state
        .db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT p.slug, p.name, p.year, p.location, p.organizer,
                        p.n_productions, p.n_files, f.content_hash, f.kind
                 FROM parties p
                 LEFT JOIN files f ON f.rel_path = p.logo_rel
                 ORDER BY p.year, p.name COLLATE NOCASE",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok(PartyOut {
                    slug: r.get(0)?,
                    name: r.get(1)?,
                    year: r.get(2)?,
                    location: r.get(3)?,
                    organizer: r.get(4)?,
                    n_productions: r.get(5)?,
                    n_files: r.get(6)?,
                    logo_hash: r.get(7)?,
                    logo_kind: r.get(8)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    Ok(Json(json!({ "parties": parties })))
}

#[derive(Serialize)]
struct ProductionOut {
    id: String,
    category: String,
    compo: String,
    platform: String,
    medium: String,
    rank: Option<i64>,
    group: Option<String>,
    title: Option<String>,
    points: Option<i64>,
    primary_hash: Option<String>,
    primary_kind: Option<String>,
    primary_filename: Option<String>,
    n_files: i64,
    /// Position of this prod's category in the party JSON's `categories` map;
    /// the SPA sorts compos by it. `None` for folders with no authored category.
    order: Option<i64>,
    /// True for a ranked entry that's in the config results but was never archived
    /// (no production folder). Synthesized so the SPA can show the full results;
    /// it has no files and the SPA renders it disabled.
    #[serde(default)]
    missing: bool,
}

async fn api_productions(
    _auth: Auth,
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> AppResult<Json<Value>> {
    let slug_q = slug.clone();
    let prods = state
        .db
        .with(move |c| {
            let mut stmt = c.prepare(
                "SELECT p.id, p.category, p.compo, p.platform, p.medium, p.rank, p.grp, p.title,
                        p.points, f.content_hash, p.primary_kind, f.filename,
                        (SELECT COUNT(*) FROM files x WHERE x.prod_id = p.id)
                 FROM productions p
                 LEFT JOIN files f ON f.rel_path = p.primary_rel
                 WHERE p.party_slug = ?1
                 ORDER BY p.compo COLLATE NOCASE,
                          CASE WHEN p.rank IS NULL THEN 1 ELSE 0 END,
                          p.rank,
                          p.title COLLATE NOCASE",
            )?;
            let rows = stmt.query_map([&slug_q], |r| {
                Ok(ProductionOut {
                    id: r.get(0)?,
                    category: r.get(1)?,
                    compo: r.get(2)?,
                    platform: r.get(3)?,
                    medium: r.get(4)?,
                    rank: r.get(5)?,
                    group: r.get(6)?,
                    title: r.get(7)?,
                    points: r.get(8)?,
                    primary_hash: r.get(9)?,
                    primary_kind: r.get(10)?,
                    primary_filename: r.get(11)?,
                    n_files: r.get(12)?,
                    order: None,
                    missing: false,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .await?;
    // Tag each prod with its category's position in the party JSON so the SPA can
    // present compos in authored order.
    let mut prods = prods;
    let cfg = state.parties.for_dir(&slug);
    for p in &mut prods {
        p.order = cfg.category_order(&p.category).map(|i| i as i64);
    }

    // Surface ranked entries that are in the config results but were never
    // archived (no production folder — the upload was incomplete) as disabled
    // "missing" rows, so the SPA shows the full competition results. Match a
    // result to a present production by normalized title (or, for title-less
    // compos like graphics, by group).
    fn norm(s: &str) -> String {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(|c| c.to_lowercase())
            .collect()
    }
    let mut present_titles: std::collections::HashSet<(String, String)> = Default::default();
    let mut present_groups: std::collections::HashSet<(String, String)> = Default::default();
    for p in &prods {
        if let Some(t) = p.title.as_deref().filter(|s| !s.is_empty()) {
            present_titles.insert((p.category.clone(), norm(t)));
        } else if let Some(g) = p.group.as_deref().filter(|s| !s.is_empty()) {
            present_groups.insert((p.category.clone(), norm(g)));
        }
    }
    let mut missing = Vec::new();
    for (cat, c) in &cfg.categories {
        let order = cfg.category_order(cat).map(|i| i as i64);
        for row in &c.results {
            let has = match (row.title.as_deref(), row.group.as_deref()) {
                (Some(t), _) if !t.is_empty() => {
                    present_titles.contains(&(cat.clone(), norm(t)))
                }
                (_, Some(g)) if !g.is_empty() => {
                    present_groups.contains(&(cat.clone(), norm(g)))
                }
                _ => true, // nothing to match on → don't synthesize
            };
            if has {
                continue;
            }
            missing.push(ProductionOut {
                id: format!("missing-{cat}-{}-{}", row.rank, norm(row.title.as_deref().or(row.group.as_deref()).unwrap_or(""))),
                category: cat.clone(),
                compo: c.compo.clone(),
                platform: c.platform.clone(),
                medium: c.medium.clone(),
                rank: Some(row.rank),
                group: row.group.clone(),
                title: row.title.clone(),
                points: row.points,
                primary_hash: None,
                primary_kind: None,
                primary_filename: None,
                n_files: 0,
                order,
                missing: true,
            });
        }
    }
    prods.extend(missing);
    // Shared Amiga Kickstart from the support dir (spans all parties), as a URL
    // the SPA hands to EJS_biosUrl. Named so PUAE's A1200 finds it.
    let kickstart_url = state
        .cfg
        .support_dir
        .join("kick40068.A1200")
        .is_file()
        .then(|| "/api/support/kick40068.A1200".to_string());

    if prods.is_empty() {
        // Distinguish unknown party from an empty one.
        let exists: bool = state
            .db
            .with(move |c| {
                c.query_row("SELECT 1 FROM parties WHERE slug = ?1", [&slug], |_| Ok(true))
                    .or(Ok(false))
            })
            .await?;
        if !exists {
            return Err(AppError::NotFound);
        }
    }
    Ok(Json(json!({ "productions": prods, "kickstart_url": kickstart_url })))
}

#[derive(Serialize)]
struct FileOut {
    hash: String,
    rel_path: String,
    filename: String,
    ext: String,
    kind: String,
    mime: String,
    size: i64,
}

async fn api_production(
    _auth: Auth,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let (prod, files, meta) = state
        .db
        .with(move |c| {
            let prod = c.query_row(
                "SELECT p.id, p.party_slug, p.category, p.compo, p.platform, p.medium, p.rank,
                        p.grp, p.title, p.points, p.primary_rel, p.primary_kind, f.content_hash
                 FROM productions p
                 LEFT JOIN files f ON f.rel_path = p.primary_rel
                 WHERE p.id = ?1",
                [&id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "party_slug": r.get::<_, String>(1)?,
                        "category": r.get::<_, String>(2)?,
                        "compo": r.get::<_, String>(3)?,
                        "platform": r.get::<_, String>(4)?,
                        "medium": r.get::<_, String>(5)?,
                        "rank": r.get::<_, Option<i64>>(6)?,
                        "group": r.get::<_, Option<String>>(7)?,
                        "title": r.get::<_, Option<String>>(8)?,
                        "points": r.get::<_, Option<i64>>(9)?,
                        "primary_rel": r.get::<_, Option<String>>(10)?,
                        "primary_kind": r.get::<_, Option<String>>(11)?,
                        "primary_hash": r.get::<_, Option<String>>(12)?,
                    }))
                },
            )?;

            let mut stmt = c.prepare(
                "SELECT content_hash, rel_path, filename, ext, kind, size
                 FROM files WHERE prod_id = ?1
                 ORDER BY kind, filename COLLATE NOCASE",
            )?;
            let files = stmt
                .query_map([&id], |r| {
                    let filename: String = r.get(2)?;
                    let ext: String = r.get(3)?;
                    let kind: String = r.get(4)?;
                    // The scanner may have sniffed an unknown-extension file as
                    // text; reflect that in the MIME so the viewer dispatches.
                    let mut mime = crate::scan::mime_for(&ext, &filename).to_string();
                    if kind == "text" && mime == "application/octet-stream" {
                        mime = "text/plain".to_string();
                    }
                    Ok(FileOut {
                        hash: r.get(0)?,
                        rel_path: r.get(1)?,
                        size: r.get(5)?,
                        kind,
                        mime,
                        filename,
                        ext,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            // Music metadata for the primary file, if any.
            let primary_hash = prod.get("primary_hash").and_then(|v| v.as_str());
            let meta: Option<Value> = match primary_hash {
                Some(h) => c
                    .query_row(
                        "SELECT title, type_long, tracker, duration, channels, instruments,
                                samples, n_orders, n_patterns
                         FROM meta WHERE content_hash = ?1",
                        [h],
                        |r| {
                            Ok(json!({
                                "title": r.get::<_, Option<String>>(0)?,
                                "type_long": r.get::<_, Option<String>>(1)?,
                                "tracker": r.get::<_, Option<String>>(2)?,
                                "duration": r.get::<_, Option<f64>>(3)?,
                                "channels": r.get::<_, Option<i64>>(4)?,
                                "instruments": r.get::<_, Option<i64>>(5)?,
                                "samples": r.get::<_, Option<i64>>(6)?,
                                "n_orders": r.get::<_, Option<i64>>(7)?,
                                "n_patterns": r.get::<_, Option<i64>>(8)?,
                            }))
                        },
                    )
                    .ok(),
                None => None,
            };

            Ok((prod, files, meta))
        })
        .await
        .map_err(|_| AppError::NotFound)?;

    Ok(Json(json!({
        "production": prod,
        "files": files,
        "meta": meta,
    })))
}

/// Resolve a content hash to an on-disk path inside the root (canonicalised).
async fn resolve_file(state: &AppState, hash: &str) -> AppResult<std::path::PathBuf> {
    let rel_path: String = state
        .db
        .with({
            let hash = hash.to_string();
            move |c| {
                c.query_row(
                    "SELECT rel_path FROM files WHERE content_hash = ?1 LIMIT 1",
                    [&hash],
                    |r| r.get(0),
                )
            }
        })
        .await
        .map_err(|_| AppError::NotFound)?;

    let full = state.cfg.root.join(&rel_path);
    let (canon, canon_root) = match (full.canonicalize(), state.cfg.root.canonicalize()) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return Err(AppError::NotFound),
    };
    if !canon.starts_with(&canon_root) || !canon.is_file() {
        return Err(AppError::NotFound);
    }
    Ok(canon)
}

async fn api_file(
    _auth: Auth,
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> AppResult<impl IntoResponse> {
    serve_file(&state, &hash).await
}

/// Same bytes as `api_file`, but the URL carries a trailing `{name}` so the
/// emulators (EmulatorJS) can read the file extension off the URL — PUAE needs
/// `.adf`/`.hdf` in the name to mount, and the hash alone has none.
async fn api_file_named(
    _auth: Auth,
    State(state): State<AppState>,
    Path((hash, _name)): Path<(String, String)>,
) -> AppResult<impl IntoResponse> {
    serve_file(&state, &hash).await
}

async fn serve_file(state: &AppState, hash: &str) -> AppResult<impl IntoResponse> {
    let canon = resolve_file(state, hash).await?;
    let bytes = tokio::fs::read(&canon).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CACHE_CONTROL, "private, max-age=3600".to_string()),
        ],
        bytes,
    ))
}

/// Serve a file from the shared support dir (e.g. an emulator BIOS) by filename.
async fn api_support(
    _auth: Auth,
    State(state): State<AppState>,
    Path(file): Path<String>,
) -> AppResult<impl IntoResponse> {
    let full = state.cfg.support_dir.join(&file);
    let (canon, base) = match (full.canonicalize(), state.cfg.support_dir.canonicalize()) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return Err(AppError::NotFound),
    };
    if !canon.starts_with(&base) || !canon.is_file() {
        return Err(AppError::NotFound);
    }
    let bytes = tokio::fs::read(&canon).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
        ],
        bytes,
    ))
}

async fn api_text(
    _auth: Auth,
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> AppResult<impl IntoResponse> {
    let canon = resolve_file(&state, &hash).await?;
    let bytes = tokio::fs::read(&canon).await?;
    let text = crate::cp437::decode(&bytes);
    Ok((
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8".to_string()),
            (header::CACHE_CONTROL, "private, max-age=3600".to_string()),
        ],
        text,
    ))
}

fn asset_response(content_type: &'static str, bytes: Vec<u8>) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
        ],
        bytes,
    )
}

/// Derived asset by `<hash>.<target>` (png|mp4). Served from the on-disk cache;
/// on a miss, the source bytes are sent to the transcoder sidecar, the result
/// cached (write-to-`.partial`-then-rename), recorded in `derived`, and served.
/// 502 if the sidecar is unconfigured/unreachable so the SPA falls back.
async fn api_asset(
    _auth: Auth,
    State(state): State<AppState>,
    Path(file): Path<String>,
) -> AppResult<impl IntoResponse> {
    let (hash, target) = file.rsplit_once('.').ok_or(AppError::NotFound)?;
    let (content_type, kind) = match target {
        "png" => ("image/png", "image"),
        "mp4" => ("video/mp4", "video"),
        _ => return Err(AppError::BadRequest("unsupported asset target".into())),
    };
    let hash = hash.to_string();
    let target = target.to_string();
    let cache_rel = format!("{hash}.{target}");
    let cache_path = state.cfg.cache_dir.join(&cache_rel);

    // Serve from cache if recorded `ok` and present on disk.
    let have_cached: bool = state
        .db
        .with({
            let hash = hash.clone();
            let target = target.clone();
            move |c| {
                c.query_row(
                    "SELECT 1 FROM derived WHERE content_hash=?1 AND target=?2 AND status='ok'",
                    rusqlite::params![hash, target],
                    |_| Ok(true),
                )
                .or(Ok(false))
            }
        })
        .await?;
    if have_cached && cache_path.is_file() {
        let bytes = tokio::fs::read(&cache_path).await?;
        return Ok(asset_response(content_type, bytes));
    }

    let tc = crate::transcoder::TranscoderClient::new(&state);
    if !tc.is_configured() {
        return Err(AppError::Upstream("transcoder not configured".into()));
    }

    // Resolve the source file (path within root) + its extension hint.
    let (rel_path, src_ext): (String, String) = state
        .db
        .with({
            let hash = hash.clone();
            move |c| {
                c.query_row(
                    "SELECT rel_path, ext FROM files WHERE content_hash=?1 LIMIT 1",
                    [&hash],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            }
        })
        .await
        .map_err(|_| AppError::NotFound)?;
    let full = state.cfg.root.join(&rel_path);
    let (canon, canon_root) = match (full.canonicalize(), state.cfg.root.canonicalize()) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return Err(AppError::NotFound),
    };
    if !canon.starts_with(&canon_root) || !canon.is_file() {
        return Err(AppError::NotFound);
    }

    let src = tokio::fs::read(&canon).await?;
    let out = tc.transcode(kind, &src_ext, src).await?;

    tokio::fs::create_dir_all(&state.cfg.cache_dir).await.ok();
    let partial = state.cfg.cache_dir.join(format!("{cache_rel}.partial"));
    tokio::fs::write(&partial, &out).await?;
    tokio::fs::rename(&partial, &cache_path).await?;

    let now = chrono::Utc::now().to_rfc3339();
    let bytes_len = out.len() as i64;
    state
        .db
        .with(move |c| {
            c.execute(
                "INSERT INTO derived (content_hash, target, rel_cache, status, bytes, updated_at)
                 VALUES (?1, ?2, ?3, 'ok', ?4, ?5)
                 ON CONFLICT(content_hash, target) DO UPDATE SET
                   rel_cache=excluded.rel_cache, status='ok',
                   bytes=excluded.bytes, updated_at=excluded.updated_at",
                rusqlite::params![hash, target, cache_rel, bytes_len, now],
            )
        })
        .await?;

    Ok(asset_response(content_type, out))
}

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

/// DOSBox config baked into every `.jsdos` bundle, tuned for demos/intros:
/// `cycles=max` for raw speed (the framerate lever), a generous mixer prebuffer
/// to stop audio underruns, an SB16, and a **Gravis UltraSound** — vital for
/// 90s PC demos. The `BLASTER`/`ULTRASND` env vars let the productions detect
/// both cards (and pick GUS for module music). SVGA S3 + 32 MB cover VESA demos.
fn dosbox_conf(exe: &str) -> String {
    format!(
        "[dosbox]
machine=svga_s3
memsize=32

[cpu]
core=auto
cputype=auto
cycles=max

[mixer]
nosound=false
rate=44100
blocksize=1024
prebuffer=50

[sblaster]
sbtype=sb16
sbbase=220
irq=7
dma=1
hdma=5
oplmode=auto
oplrate=44100

[gus]
gus=true
gusrate=44100
gusbase=240
irq1=5
dma1=3

[autoexec]
@echo off
mount c .
c:
set BLASTER=A220 I7 D1 H5 P330 T6
set ULTRASND=240,3,3,5,5
set ULTRADIR=C:\\
{exe}
"
    )
}

/// Build a js-dos `.jsdos` bundle for a PC demo/intro: a zip of the primary
/// executable's directory plus a `.jsdos/dosbox.conf` that mounts it as C: and
/// autoruns the exe. The SPA hands the URL straight to `Dos(el, { url })`.
#[derive(serde::Deserialize)]
struct BundleQuery {
    /// rel_path of the executable to autorun (a fix/v2 the user picked); falls
    /// back to the production's primary when absent or not one of its files.
    exe: Option<String>,
}

async fn api_bundle(
    _auth: Auth,
    State(state): State<AppState>,
    Path(file): Path<String>,
    axum::extract::Query(q): axum::extract::Query<BundleQuery>,
) -> AppResult<impl IntoResponse> {
    let prod_id = file.strip_suffix(".jsdos").ok_or(AppError::NotFound)?.to_string();

    let primary_rel: Option<String> = state
        .db
        .with({
            let id = prod_id.clone();
            move |c| {
                c.query_row(
                    "SELECT primary_rel FROM productions WHERE id = ?1",
                    [&id],
                    |r| r.get(0),
                )
            }
        })
        .await
        .map_err(|_| AppError::NotFound)?;
    let primary_rel = primary_rel.ok_or(AppError::NotFound)?;

    let rels: Vec<String> = state
        .db
        .with({
            let id = prod_id.clone();
            move |c| {
                let mut stmt = c.prepare("SELECT rel_path FROM files WHERE prod_id = ?1")?;
                let rows = stmt.query_map([&id], |r| r.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            }
        })
        .await?;

    // Which executable to autorun: the caller's ?exe (validated to be one of the
    // prod's own files) lets the user pick a different build (a fix/v2); else the
    // primary. Bundle root = that exe's directory; autorun its basename.
    let run_rel = q
        .exe
        .filter(|e| rels.iter().any(|r| r == e))
        .unwrap_or(primary_rel);
    let root_prefix = match run_rel.rfind('/') {
        Some(i) => run_rel[..i].to_string(),
        None => String::new(),
    };
    let exe_name = run_rel.rsplit('/').next().unwrap_or(&run_rel).to_string();

    let canon_root = state
        .cfg
        .root
        .canonicalize()
        .map_err(|_| AppError::NotFound)?;
    let prefix = if root_prefix.is_empty() {
        String::new()
    } else {
        format!("{root_prefix}/")
    };

    // Read the bytes of every file inside the exe's directory.
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for rel in &rels {
        if !prefix.is_empty() && !rel.starts_with(&prefix) {
            continue;
        }
        let arc_name = rel[prefix.len()..].to_string();
        if arc_name.is_empty() {
            continue;
        }
        let full = state.cfg.root.join(rel);
        let Ok(canon) = full.canonicalize() else {
            continue;
        };
        if !canon.starts_with(&canon_root) || !canon.is_file() {
            continue;
        }
        if let Ok(bytes) = tokio::fs::read(&canon).await {
            entries.push((arc_name, bytes));
        }
    }
    if entries.is_empty() {
        return Err(AppError::NotFound);
    }

    // Assemble the zip on a blocking thread (the zip crate is synchronous).
    let zip_bytes = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        use std::io::Write as _;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::<u8>::new()));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            zip.start_file(name, opts)?;
            zip.write_all(&bytes)?;
        }
        zip.start_file(".jsdos/dosbox.conf", opts)?;
        zip.write_all(dosbox_conf(&exe_name).as_bytes())?;
        Ok(zip.finish()?.into_inner())
    })
    .await
    .map_err(|e| AppError::Internal(e.into()))?
    .map_err(|e| AppError::Internal(e.into()))?;

    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (header::CACHE_CONTROL, "private, max-age=3600".to_string()),
        ],
        zip_bytes,
    ))
}

async fn api_rescan(_auth: Auth, State(state): State<AppState>) -> AppResult<Json<Value>> {
    // Kiosk (public, read-only) refuses operator mutations. The button is hidden
    // in the SPA, but enforce it here too — the endpoint is reachable directly.
    if state.cfg.kiosk {
        return Err(AppError::Forbidden);
    }
    let result = crate::run_scan(
        state.db.clone(),
        state.cfg.root.clone(),
        state.parties.clone(),
        state.scan.clone(),
    )
    .await
    .map_err(AppError::Internal)?;
    Ok(Json(json!({
        "indexed": result.indexed,
        "hashed": result.hashed,
        "removed": result.removed,
        "productions": result.productions,
        "parties": result.parties,
    })))
}

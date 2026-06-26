//! Single-writer SQLite connection guarded by a tokio Mutex (house pattern —
//! see represent/scribe). This is a *cache*, not the source of truth: the
//! `files` table is a path index of the collection, and `meta` holds
//! libopenmpt-parsed enrichment keyed by content hash. Both are rebuilt from
//! the filesystem on demand, so losing the DB only costs a rescan.

use std::path::Path;
use std::sync::Arc;

use rusqlite::Connection;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Db {
    inner: Arc<Mutex<Connection>>,
}

/// Informational schema marker. Migrations don't gate on it — the schema below
/// is declarative + idempotent and runs every boot, so the DB always converges
/// to match the code (the app restarts under bacon/quadlet auto-restart).
const SCHEMA_VERSION: i64 = 1;

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        // Enforce FKs so deleting a playlist cascades to its items.
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // Tuned for the Raspberry Pi target (slow SD-card I/O): keep sort/group
        // temporaries in RAM rather than spilling to the card, give the page
        // cache some room (~16 MB, negative = KiB), and wait out a transient lock
        // instead of erroring. One connection (a tokio Mutex) means no real
        // contention, but the timeout is cheap insurance against WAL checkpoints.
        conn.pragma_update(None, "temp_store", "MEMORY")?;
        conn.pragma_update(None, "cache_size", -16_000)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Self::migrate(&conn)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(conn)),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Self::migrate(&conn)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(conn)),
        })
    }

    /// Run a closure with the locked connection. The closure may use a
    /// transaction internally (the scanner does).
    pub async fn with<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> rusqlite::Result<R> {
        let guard = self.inner.lock().await;
        f(&guard)
    }

    /// Like [`Db::with`], but the closure gets a mutable connection so it can
    /// open a transaction (`conn.transaction()`).
    pub async fn with_mut<R>(
        &self,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<R>,
    ) -> rusqlite::Result<R> {
        let mut guard = self.inner.lock().await;
        f(&mut guard)
    }

    /// Acquire the connection from a blocking thread. Only call inside
    /// `tokio::task::spawn_blocking` — the scan holds the lock for seconds to
    /// minutes (hashing new files over CIFS) and must not block an async worker.
    pub fn blocking_lock(&self) -> tokio::sync::MutexGuard<'_, Connection> {
        self.inner.blocking_lock()
    }

    fn migrate(conn: &Connection) -> anyhow::Result<()> {
        // `playlist_items` has been reshaped a couple of times during development
        // (content_hash → md5 → hybrid md5+path with a surrogate id). Drop any
        // table lacking the `path` column so SCHEMA recreates the current shape.
        // Safe: this feature is unreleased, so there's no real data to keep.
        if table_exists(conn, "playlist_items") && !has_column(conn, "playlist_items", "path") {
            conn.execute("DROP TABLE playlist_items", [])?;
        }
        conn.execute_batch(SCHEMA)?;
        // `CREATE TABLE IF NOT EXISTS` won't add a new column to a `files` table
        // that already exists from a pre-md5 boot. Add it idempotently: SQLite
        // has no `ADD COLUMN IF NOT EXISTS`, so swallow the duplicate-column
        // error and let everything else propagate. The `idx_files_md5` index in
        // SCHEMA is created after, so it lands once the column exists.
        add_column_if_missing(conn, "files", "md5", "TEXT")?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_files_md5 ON files(md5)", [])?;
        // `url` was added after the hybrid reshape; add it to an existing table.
        add_column_if_missing(conn, "playlist_items", "url", "TEXT")?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    }
}

/// Columns of `table` (empty if the table doesn't exist).
fn columns(conn: &Connection, table: &str) -> Vec<String> {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default()
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    !columns(conn, table).is_empty()
}

fn has_column(conn: &Connection, table: &str, col: &str) -> bool {
    columns(conn, table).iter().any(|c| c == col)
}

/// Idempotently add `col` to `table`. No-op if the column already exists.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    col: &str,
    decl: &str,
) -> anyhow::Result<()> {
    if !has_column(conn, table, col) {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {col} {decl}"), [])?;
    }
    Ok(())
}

/// The declarative schema, for tests that need a raw connection (the scanner
/// takes `&mut Connection`, not a [`Db`]).
#[cfg(test)]
pub fn schema_sql() -> &'static str {
    SCHEMA
}

const SCHEMA: &str = r#"
-- Path index of the collection. Rebuilt on each scan, but rows persist between
-- scans so a cached content_hash can be reused when (size, mtime) are
-- unchanged — avoids re-reading the whole NAS over CIFS every scan.
-- `grp` (not `group`, a SQL keyword) is the first path segment under the root.
-- `md5` is the MD5 of the file bytes (alongside the SHA-256 `content_hash`):
-- The Mod Archive identifies modules by MD5, so it's how top-list entries are
-- matched against the local collection. Nullable so a pre-md5 row triggers a
-- one-time re-hash on the next scan (see scan.rs). `content_hash` stays the
-- canonical key for meta/stats/playlists.
CREATE TABLE IF NOT EXISTS files (
  rel_path     TEXT PRIMARY KEY,
  grp          TEXT NOT NULL,
  artist       TEXT,
  filename     TEXT NOT NULL,
  ext          TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  md5          TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
CREATE INDEX IF NOT EXISTS idx_files_grp ON files(grp);
-- Case-insensitive filename lookup, so a playlist item resolves to a local file
-- by name (the md5-or-filename fallback in the detail query) without scanning
-- the whole `files` table per item.
CREATE INDEX IF NOT EXISTS idx_files_fname_lower ON files(LOWER(filename));
-- idx_files_md5 is created in migrate(), after the md5 column is ensured to
-- exist (an older `files` table predates it).

-- libopenmpt-parsed enrichment, keyed by content hash so it survives a file
-- being moved/renamed (the path changes, the bytes don't). Filled lazily by
-- the frontend via POST /api/meta/:hash.
CREATE TABLE IF NOT EXISTS meta (
  content_hash TEXT PRIMARY KEY,
  title        TEXT,
  type_long    TEXT,
  tracker      TEXT,
  duration     REAL,
  channels     INTEGER,
  instruments  INTEGER,
  samples      INTEGER,
  n_orders     INTEGER,
  n_patterns   INTEGER,
  updated_at   TEXT NOT NULL
);

-- Per-tune listener state, keyed by content hash (so a favourite / play count
-- follows the file across moves, like meta). Global, not per-user — the library
-- is a single shared collection behind edge auth.
CREATE TABLE IF NOT EXISTS stats (
  content_hash TEXT PRIMARY KEY,
  favorite     INTEGER NOT NULL DEFAULT 0,
  play_count   INTEGER NOT NULL DEFAULT 0,
  last_played  TEXT
);

-- User-curated playlists, plus the synthesised 'top_favourites' list mirroring
-- The Mod Archive chart. `kind` distinguishes them; `source_ref` records the
-- external origin for synced lists (e.g. 'modarchive:top_favourites').
CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'user',
  source_ref  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Ordered playlist entries (hybrid identity). `md5` is the local-library match
-- key (when known); `path` is a Modland `Format/Author/file` fetch path; `url`
-- is a generic direct-download URL (e.g. a Mod Archive `downloads.php?moduleid`)
-- for sources Modland doesn't carry. A library-added item has md5 + null fetch
-- refs; an imported item has a path and/or url + maybe md5 (filled on fetch). An
-- entry resolves to a local file via `files.md5`; absent → "missing" (shown from
-- the cached metadata, fetched by path first, else url). `id` is a stable
-- surrogate for reorder/remove. The backend stays service-agnostic: it downloads
-- whatever `url` the curation supplied and verifies the bytes' md5.
CREATE TABLE IF NOT EXISTS playlist_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id  TEXT NOT NULL,
  position     INTEGER NOT NULL,
  md5          TEXT,
  path         TEXT,
  url          TEXT,
  -- Cached display metadata (from the import doc / library at add time), used
  -- when the module isn't present locally.
  title        TEXT,
  artist       TEXT,
  format       TEXT,
  filename     TEXT,
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pli_playlist ON playlist_items(playlist_id);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrate_is_idempotent() {
        // Opening twice over the same in-memory schema (re-running migrate)
        // must not error — declarative CREATE IF NOT EXISTS.
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            Db::migrate(c).unwrap();
            c.query_row("SELECT COUNT(*) FROM files", [], |r| r.get::<_, i64>(0))
        })
        .await
        .unwrap();
    }
}

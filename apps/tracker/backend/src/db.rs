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
        Self::migrate(&conn)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(conn)),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
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
        conn.execute_batch(SCHEMA)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    }
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
CREATE TABLE IF NOT EXISTS files (
  rel_path     TEXT PRIMARY KEY,
  grp          TEXT NOT NULL,
  artist       TEXT,
  filename     TEXT NOT NULL,
  ext          TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
CREATE INDEX IF NOT EXISTS idx_files_grp ON files(grp);

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

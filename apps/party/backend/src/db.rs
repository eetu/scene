//! Single-writer SQLite connection guarded by a tokio Mutex (house pattern —
//! see tracker/scribe). This is a *cache*, not the source of truth: the tables
//! are a path index of the `Parties/` tree (`files`), the productions derived
//! from it (`productions`), the parties themselves (`parties`), libopenmpt
//! enrichment (`meta`), and a transcoded-asset ledger (`derived`). Everything is
//! rebuilt from the filesystem on demand, so losing the DB only costs a rescan
//! (and re-transcoding cached assets).

use std::path::Path;
use std::sync::Arc;

use rusqlite::Connection;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Db {
    inner: Arc<Mutex<Connection>>,
}

/// Informational schema marker. Migrations don't gate on it — the schema below
/// is declarative + idempotent and runs every boot.
const SCHEMA_VERSION: i64 = 1;

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
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

    /// Run a closure with the locked connection.
    pub async fn with<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> rusqlite::Result<R> {
        let guard = self.inner.lock().await;
        f(&guard)
    }

    /// Like [`Db::with`], but the closure gets a mutable connection so it can
    /// open a transaction.
    pub async fn with_mut<R>(
        &self,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<R>,
    ) -> rusqlite::Result<R> {
        let mut guard = self.inner.lock().await;
        f(&mut guard)
    }

    /// Acquire the connection from a blocking thread. Only call inside
    /// `tokio::task::spawn_blocking` — the scan holds the lock for seconds.
    pub fn blocking_lock(&self) -> tokio::sync::MutexGuard<'_, Connection> {
        self.inner.blocking_lock()
    }

    fn migrate(conn: &Connection) -> anyhow::Result<()> {
        conn.execute_batch(SCHEMA)?;
        // Additive column migrations — `CREATE TABLE IF NOT EXISTS` won't alter a
        // table that already exists, so columns added after first run need this.
        // Safe + idempotent every boot. (table/col are code constants, not input.)
        ensure_column(conn, "parties", "kickstart_rel", "TEXT")?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    }
}

fn ensure_column(conn: &Connection, table: &str, col: &str, decl: &str) -> anyhow::Result<()> {
    let present: i64 = conn
        .prepare(&format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"))?
        .query_row([col], |r| r.get(0))?;
    if present == 0 {
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
-- One row per party (an immediate subdirectory of PARTY_ROOT). `dir` is the
-- actual folder name (used in rel_path); `slug` is the sanitised id.
CREATE TABLE IF NOT EXISTS parties (
  slug          TEXT PRIMARY KEY,
  dir           TEXT NOT NULL,
  name          TEXT NOT NULL,
  year          INTEGER,
  location      TEXT,
  organizer     TEXT,
  logo_rel      TEXT,
  kickstart_rel TEXT,
  n_productions INTEGER NOT NULL DEFAULT 0,
  n_files       INTEGER NOT NULL DEFAULT 0
);

-- One row per competition entry (a production = an entry folder, or a single
-- file directly under a category). Derived from the filesystem + party config +
-- results.txt; rebuilt on each scan.
CREATE TABLE IF NOT EXISTS productions (
  id          TEXT PRIMARY KEY,        -- stable hash of (slug, rel_dir)
  party_slug  TEXT NOT NULL,
  rel_dir     TEXT NOT NULL UNIQUE,    -- path under PARTY_ROOT (includes party dir)
  category    TEXT NOT NULL,           -- competition folder key (e.g. demo, amiga/demo)
  compo       TEXT NOT NULL,           -- human competition label
  platform    TEXT NOT NULL,           -- pc|amiga|c64|video|na
  medium      TEXT NOT NULL,           -- demo|intro|music|graphics|animation|info
  rank        INTEGER,                 -- 1.. or null (rest/ entries)
  grp         TEXT,                    -- group/artist credited
  title       TEXT,
  points      INTEGER,                 -- from results.txt
  primary_rel TEXT,                    -- rel_path of the main playable file
  primary_kind TEXT                    -- kind of that file
);
CREATE INDEX IF NOT EXISTS idx_prod_party ON productions(party_slug);

-- Path index of every file under PARTY_ROOT. Rows persist between scans so a
-- cached content_hash can be reused when (size, mtime) are unchanged.
CREATE TABLE IF NOT EXISTS files (
  rel_path     TEXT PRIMARY KEY,
  party_slug   TEXT NOT NULL,
  prod_id      TEXT,                   -- FK -> productions.id (null for loose files)
  category     TEXT NOT NULL,
  filename     TEXT NOT NULL,
  ext          TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- music|image|video|exe|diskimage|text|archive|data
  size         INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);
CREATE INDEX IF NOT EXISTS idx_files_prod ON files(prod_id);
CREATE INDEX IF NOT EXISTS idx_files_party ON files(party_slug);

-- libopenmpt-parsed enrichment for music, keyed by content hash so it survives
-- a file being moved/renamed. Filled lazily by the frontend via POST /api/meta.
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

-- Transcoded-asset ledger, keyed by (source content hash, target format). The
-- bytes live at cache_dir/<rel_cache>; this row records that they exist.
CREATE TABLE IF NOT EXISTS derived (
  content_hash TEXT NOT NULL,
  target       TEXT NOT NULL,          -- png|mp4
  rel_cache    TEXT NOT NULL,
  status       TEXT NOT NULL,          -- ok|failed
  width        INTEGER,
  height       INTEGER,
  bytes        INTEGER,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (content_hash, target)
);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrate_is_idempotent() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            Db::migrate(c).unwrap();
            c.query_row("SELECT COUNT(*) FROM productions", [], |r| r.get::<_, i64>(0))
        })
        .await
        .unwrap();
    }
}

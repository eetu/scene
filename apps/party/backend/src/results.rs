//! Competition results join. Placements are scraped into each party's config
//! (`CategoryCfg::results`, see [`crate::party`]) at ingest time and cross-checked
//! against demozoo/pouët — the app does **not** parse `results.txt` at runtime
//! (every party tended to need its own fragile parser). The original
//! `results.txt` stays in the tree as a browsable document.
//!
//! [`apply`] writes the config placements onto the scanned productions by
//! `(category, rank)`.

use rusqlite::Connection;

use crate::party::PartyCfg;

/// Write the config's scraped placements onto productions. Best-effort: ranks
/// with no matching production are skipped. `points` joins by `(category, rank)`
/// unconditionally — safe for ties, since tied entries share the same points.
/// `group`/`title` are applied only when exactly one production has that rank in
/// the category, so a tie (two folders at the same rank) never gets one entry's
/// name stamped onto the other; those keep their folder-derived metadata.
pub fn apply(conn: &Connection, party_slug: &str, cfg: &PartyCfg) -> anyhow::Result<()> {
    let mut updated = 0usize;
    for (category, c) in &cfg.categories {
        for row in &c.results {
            if let Some(points) = row.points {
                updated += conn.execute(
                    "UPDATE productions SET points = ?1
                     WHERE party_slug = ?2 AND category = ?3 AND rank = ?4",
                    rusqlite::params![points, party_slug, category, row.rank],
                )?;
            }
            if row.group.is_some() || row.title.is_some() {
                let n: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM productions
                     WHERE party_slug = ?1 AND category = ?2 AND rank = ?3",
                    rusqlite::params![party_slug, category, row.rank],
                    |r| r.get(0),
                )?;
                if n == 1 {
                    conn.execute(
                        "UPDATE productions
                         SET grp = COALESCE(?1, grp), title = COALESCE(?2, title)
                         WHERE party_slug = ?3 AND category = ?4 AND rank = ?5",
                        rusqlite::params![row.group, row.title, party_slug, category, row.rank],
                    )?;
                }
            }
        }
        // Unranked-entry metadata: keyed by the entry's fallback title (its
        // folder/file stem), joined onto unranked productions so the `rest/` tail
        // reads as names. Match by (category, rank IS NULL, title == stem).
        for (stem, meta) in &c.unranked {
            if meta.group.is_none() && meta.title.is_none() {
                continue;
            }
            conn.execute(
                "UPDATE productions
                 SET grp = COALESCE(?1, grp), title = COALESCE(?2, title)
                 WHERE party_slug = ?3 AND category = ?4 AND rank IS NULL AND title = ?5",
                rusqlite::params![meta.group, meta.title, party_slug, category, stem],
            )?;
        }
    }
    tracing::info!(party = %party_slug, updated, "config results joined");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::party::{CategoryCfg, PartyCfg, ResultRow};
    use indexmap::IndexMap;

    fn seed_db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE productions (
                 party_slug TEXT, category TEXT, rank INTEGER,
                 grp TEXT, title TEXT, points INTEGER
             );
             INSERT INTO productions VALUES ('tg','in4k',1,'folderG','folderT',NULL);
             INSERT INTO productions VALUES ('tg','in4k',3,'aG','aT',NULL);
             INSERT INTO productions VALUES ('tg','in4k',3,'bG','bT',NULL);",
        )
        .unwrap();
        c
    }

    fn cfg_with(results: Vec<ResultRow>) -> PartyCfg {
        let mut categories = IndexMap::new();
        categories.insert(
            "in4k".into(),
            CategoryCfg {
                compo: "PC 4k".into(),
                platform: "pc".into(),
                medium: "intro".into(),
                results,
                unranked: Default::default(),
            },
        );
        PartyCfg {
            slug: "tg".into(),
            name: "TG".into(),
            year: None,
            location: None,
            organizer: None,
            logo: None,
            folder_name: "rank-group-title".into(),
            categories,
        }
    }

    #[test]
    fn joins_points_and_tie_safe_metadata() {
        let conn = seed_db();
        let cfg = cfg_with(vec![
            ResultRow {
                rank: 1,
                points: Some(203),
                group: Some("Scoop".into()),
                title: Some("Waterworld".into()),
            },
            ResultRow {
                rank: 3,
                points: Some(102),
                group: Some("ShouldNotApply".into()),
                title: Some("ShouldNotApply".into()),
            },
        ]);
        apply(&conn, "tg", &cfg).unwrap();

        // Unique rank 1 → points set and group/title overridden from config.
        let (g, t, p): (String, String, i64) = conn
            .query_row(
                "SELECT grp, title, points FROM productions WHERE rank = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((g.as_str(), t.as_str(), p), ("Scoop", "Waterworld", 203));

        // Tied rank 3 → BOTH get points, but neither's group/title is overwritten.
        let with_points: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM productions WHERE rank = 3 AND points = 102",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(with_points, 2);
        let untouched: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM productions WHERE rank = 3 AND grp IN ('aG','bG')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(untouched, 2);
    }
}

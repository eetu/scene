//! Results-file parsing + points join. The `assembly_classic` format is the
//! Assembly '95 `results.txt`: CP437, per-competition sections like
//!
//! ```text
//!     PC demo competition:
//!
//!     1    10 (3646 points)     Nooon "Stars : Wonders of the world"
//!     2     7 (1482 points)     Juice "Psychic link"
//! ```
//!
//! Each section maps to a category via that category's configured
//! `results_title`; rows are joined onto productions by (category, rank).

use std::path::Path;

use rusqlite::Connection;

use crate::cp437;
use crate::party::PartyCfg;

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub rank: i64,
    pub points: i64,
    pub group: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub title: String,
    pub rows: Vec<Row>,
}

/// Normalise a section title for matching: lowercase, alphanumerics + single
/// spaces only.
fn norm(s: &str) -> String {
    let mut out = String::new();
    let mut prev_space = true;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_space = false;
        } else if !prev_space {
            out.push(' ');
            prev_space = true;
        }
    }
    out.trim().to_string()
}

/// Split a credit string into (group, title). Handles `Group "Title"`,
/// `Title by Group` (animations), bare names, and `-`/`?` non-entries.
fn split_credit(credit: &str) -> (Option<String>, Option<String>) {
    let c = credit.trim();
    if c.is_empty() || c == "-" || c == "?" {
        return (None, None);
    }
    if let Some(q1) = c.find('"') {
        let group = c[..q1].trim().trim_end_matches('/').trim();
        let after = &c[q1 + 1..];
        let title = after.find('"').map(|q2| after[..q2].trim().to_string());
        let group = if group.is_empty() {
            None
        } else {
            Some(group.to_string())
        };
        return (group, title);
    }
    if let Some((t, g)) = c.split_once(" by ") {
        return (Some(g.trim().to_string()), Some(t.trim().to_string()));
    }
    (Some(c.trim_end_matches([' ', '?']).trim().to_string()), None)
}

/// Parse a single results row `rank entry (NNN points) credit`. Returns None for
/// lines that aren't rows.
fn parse_row(line: &str) -> Option<Row> {
    let t = line.trim();
    let op = t.find('(')?;
    let cp = t.find(')')?;
    if cp < op {
        return None;
    }
    let head = &t[..op];
    let inside = &t[op + 1..cp];
    let credit = t[cp + 1..].trim();

    let rank = head.split_whitespace().next()?.parse::<i64>().ok()?;
    let points = inside.split_whitespace().next()?.parse::<i64>().ok()?;
    let (group, title) = split_credit(credit);
    Some(Row {
        rank,
        points,
        group,
        title,
    })
}

/// Parse the full results text into sections.
pub fn parse(text: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(row) = parse_row(line) {
            if let Some(sec) = sections.last_mut() {
                sec.rows.push(row);
            }
            continue;
        }
        // A header is a non-row line ending in ':'.
        if trimmed.ends_with(':') {
            sections.push(Section {
                title: trimmed.trim_end_matches(':').trim().to_string(),
                rows: Vec::new(),
            });
        }
    }
    // Drop the decorative pre-amble (no rows) sections.
    sections.retain(|s| !s.rows.is_empty());
    sections
}

/// Read the party's results file, parse it, and write points onto matching
/// productions. Best-effort: unmatched sections / ranks are skipped.
pub fn apply(
    conn: &Connection,
    root: &Path,
    party_slug: &str,
    party_dir: &str,
    cfg: &PartyCfg,
) -> anyhow::Result<()> {
    if cfg.results_format != "assembly_classic" {
        return Ok(());
    }
    let Some(results_file) = &cfg.results_file else {
        return Ok(());
    };
    let path = root.join(party_dir).join(results_file);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Ok(()), // no results file for this party
    };
    let text = cp437::decode(&bytes);
    let sections = parse(&text);

    // normalised results title → category key
    let mut title_to_cat: std::collections::HashMap<String, &str> = std::collections::HashMap::new();
    for (cat, c) in &cfg.categories {
        if let Some(rt) = &c.results_title {
            title_to_cat.insert(norm(rt), cat.as_str());
        }
    }

    let mut matched = 0usize;
    for sec in &sections {
        let Some(category) = title_to_cat.get(&norm(&sec.title)) else {
            continue;
        };
        for row in &sec.rows {
            let n = conn.execute(
                "UPDATE productions SET points = ?1
                 WHERE party_slug = ?2 AND category = ?3 AND rank = ?4",
                rusqlite::params![row.points, party_slug, category, row.rank],
            )?;
            matched += n;
        }
    }
    tracing::info!(party = %party_slug, sections = sections.len(), updated = matched, "results joined");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = concat!(
        "\n\n",
        "\t\tA S S E M B L Y  ' 9 5\n\n",
        "\tPC demo competition:\n\n",
        "    1    10 (3646 points)     Nooon \"Stars : Wonders of the world\"\n",
        "    2     7 (1482 points)     Juice \"Psychic link\"\n",
        "   11     4 (224 points)      Masque \"Mystery\"\n\n",
        "\tAnimation competition:\n\n",
        "    1     5 (2247 points)     Flow by Jaco\n",
        "   15    15 (6 points)\t      -\n",
    );

    #[test]
    fn parses_sections_and_rows() {
        let secs = parse(SAMPLE);
        assert_eq!(secs.len(), 2);
        assert_eq!(secs[0].title, "PC demo competition");
        assert_eq!(secs[0].rows.len(), 3);
        assert_eq!(
            secs[0].rows[0],
            Row {
                rank: 1,
                points: 3646,
                group: Some("Nooon".into()),
                title: Some("Stars : Wonders of the world".into()),
            }
        );
        assert_eq!(secs[0].rows[2].group.as_deref(), Some("Masque"));
    }

    #[test]
    fn parses_animation_by_form() {
        let secs = parse(SAMPLE);
        let anim = &secs[1];
        assert_eq!(anim.title, "Animation competition");
        assert_eq!(
            anim.rows[0],
            Row {
                rank: 1,
                points: 2247,
                group: Some("Jaco".into()),
                title: Some("Flow".into()),
            }
        );
        // "-" non-entry: no group/title, still has rank+points.
        assert_eq!(anim.rows[1].rank, 15);
        assert_eq!(anim.rows[1].group, None);
    }

    #[test]
    fn norm_matches_despite_typo() {
        assert_eq!(norm("Multichannel musax competiton:"), "multichannel musax competiton");
        assert_eq!(norm("  PC  4K intro  "), "pc 4k intro");
    }

    #[test]
    fn split_credit_forms() {
        assert_eq!(
            split_credit("Barti!/Nooon \"Heaven\""),
            (Some("Barti!/Nooon".into()), Some("Heaven".into()))
        );
        assert_eq!(split_credit("-"), (None, None));
        assert_eq!(split_credit("Black Lotus ?"), (Some("Black Lotus".into()), None));
    }
}

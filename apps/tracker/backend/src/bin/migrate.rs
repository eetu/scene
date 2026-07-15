//! `tracker-migrate <md5-manifest.tsv> [out-dir]`
//!
//! Reads an `md5<TAB>size<TAB>relpath` snapshot of the legacy collection and
//! writes, next to it (or into `out-dir`):
//!   - `library.seed.json`     — the seeded manifest (artists → groups)
//!   - `dupes.json`            — exact md5 duplicates (the dedup worklist)
//!   - `alias-candidates.json` — same bytes under different artist folders
//!
//! Read-only over the collection (it works on the TSV, never the mount), so it's
//! safe to run while the archive is being edited. Copy `library.seed.json` to
//! `<TRACKER_ROOT>/library.json` and `POST /api/library/reload` to apply the
//! graph — no file moves, no rescan. The physical `group/artist → artist` moves
//! are a separate, gated step against a fresh snapshot.

use std::path::PathBuf;

use tracker_backend::manifest;
use tracker_backend::migrate::{build_seed, parse_tsv};

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let tsv_path = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("usage: tracker-migrate <md5-manifest.tsv> [out-dir]"))?,
    );
    let out_dir = args.next().map(PathBuf::from).unwrap_or_else(|| {
        tsv_path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    });

    let text = std::fs::read_to_string(&tsv_path)?;
    let entries = parse_tsv(&text);
    let seed = build_seed(&entries);

    let seed_path = out_dir.join("library.seed.json");
    manifest::save(&seed_path, &seed.manifest)?;
    let dupes_path = out_dir.join("dupes.json");
    std::fs::write(&dupes_path, serde_json::to_vec_pretty(&seed.exact_dupes)?)?;
    let alias_path = out_dir.join("alias-candidates.json");
    std::fs::write(&alias_path, serde_json::to_vec_pretty(&seed.alias_candidates)?)?;

    let s = &seed.stats;
    println!("── snapshot ─────────────────────────────");
    println!("  files              {}", s.files);
    println!("  unique md5         {}", s.unique_md5);
    println!("  artists (w/ group) {}", s.artists);
    println!("  distinct groups    {}", s.groups);
    println!("  unknown-author     {}", s.unknown_artist_files);
    println!("── dedup ────────────────────────────────");
    println!("  exact-dupe sets    {}", s.exact_dupe_sets);
    println!("  redundant copies   {}", s.redundant_copies);
    println!("  alias candidates   {}", s.alias_candidate_sets);
    println!("── wrote ────────────────────────────────");
    println!("  {}", seed_path.display());
    println!("  {}", dupes_path.display());
    println!("  {}", alias_path.display());
    Ok(())
}

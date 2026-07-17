//! Two modes:
//!
//! - `tracker-migrate <md5-manifest.tsv> [out-dir]` — plan (read-only)
//! - `tracker-migrate apply <migration-plan.json> <root> [--go]` — apply (gated)
//!
//! **plan** reads an `md5<TAB>size<TAB>relpath` snapshot of the legacy collection
//! and writes four files next to it (or into `out-dir`): `library.seed.json` (the
//! seeded manifest, artists → groups), `dupes.json` (exact md5 duplicates — the
//! dedup worklist), `alias-candidates.json` (same bytes under different artist
//! folders), and `migration-plan.json` (the `group/artist → artist` move plan).
//! It never touches the mount (works on the TSV), so it's safe to run anytime.
//! Copy `library.seed.json` to `<TRACKER_ROOT>/library.json` and
//! `POST /api/library/reload` to apply the graph — no file moves, no rescan.
//!
//! **apply** executes a reviewed `migration-plan.json` against `<root>` — but only
//! with `--go`; without it, it's a dry run that reports what the *live* tree
//! would allow. Idempotent + defensive: missing sources are skipped, existing
//! destinations are never clobbered, emptied group dirs are pruned. After a real
//! apply, rescan so the index re-derives the artist-primary paths. (This is a
//! historical one-shot tool: the backend is now artist-primary unconditionally.)

use std::path::{Path, PathBuf};

use tracker_backend::manifest;
use tracker_backend::migrate::{apply_plan, build_seed, parse_tsv, plan_moves, MovePlan};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("apply") => apply_cmd(&args[1..]),
        _ => plan_cmd(&args),
    }
}

fn plan_cmd(args: &[String]) -> anyhow::Result<()> {
    let tsv_path =
        PathBuf::from(args.first().ok_or_else(|| {
            anyhow::anyhow!("usage: tracker-migrate <md5-manifest.tsv> [out-dir]")
        })?);
    let out_dir = args.get(1).map(PathBuf::from).unwrap_or_else(|| {
        tsv_path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    });

    let entries = parse_tsv(&std::fs::read_to_string(&tsv_path)?);
    let seed = build_seed(&entries);
    let plan = plan_moves(&entries);

    let seed_path = out_dir.join("library.seed.json");
    manifest::save(&seed_path, &seed.manifest)?;
    let dupes_path = out_dir.join("dupes.json");
    std::fs::write(&dupes_path, serde_json::to_vec_pretty(&seed.exact_dupes)?)?;
    let alias_path = out_dir.join("alias-candidates.json");
    std::fs::write(
        &alias_path,
        serde_json::to_vec_pretty(&seed.alias_candidates)?,
    )?;
    let plan_path = out_dir.join("migration-plan.json");
    std::fs::write(&plan_path, serde_json::to_vec_pretty(&plan)?)?;

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
    println!("── move plan (dry run) ──────────────────");
    println!("  moves              {}", plan.stats.moves);
    println!("  deletes (dupes)    {}", plan.stats.deletes);
    println!("  name collisions    {}", plan.stats.collisions);
    println!(
        "  bytes reclaimed    {} ({:.1} MB)",
        plan.stats.bytes_reclaimed,
        plan.stats.bytes_reclaimed as f64 / 1_048_576.0
    );
    println!("── wrote ────────────────────────────────");
    for p in [&seed_path, &dupes_path, &alias_path, &plan_path] {
        println!("  {}", p.display());
    }
    Ok(())
}

fn apply_cmd(args: &[String]) -> anyhow::Result<()> {
    let plan_path = args.first().ok_or_else(|| {
        anyhow::anyhow!("usage: tracker-migrate apply <migration-plan.json> <root> [--go]")
    })?;
    let root = args
        .get(1)
        .ok_or_else(|| anyhow::anyhow!("apply needs a <root> (the collection mount)"))?;
    let execute = args.iter().any(|a| a == "--go");

    let plan: MovePlan = serde_json::from_slice(&std::fs::read(plan_path)?)?;
    let report = apply_plan(Path::new(root), &plan, execute);

    println!(
        "── apply {} ──",
        if execute { "(LIVE)" } else { "(dry run)" }
    );
    println!("  moved              {}", report.moved);
    println!("  move skipped (gone) {}", report.move_skipped_missing);
    println!("  move conflicts     {}", report.move_conflicts);
    println!("  deleted            {}", report.deleted);
    println!("  delete skipped     {}", report.delete_skipped_missing);
    println!("  empty dirs removed {}", report.dirs_removed);
    if !report.errors.is_empty() {
        println!("── errors ({}) ──", report.errors.len());
        for e in report.errors.iter().take(20) {
            println!("  {e}");
        }
    }
    if !execute {
        println!("\nDRY RUN — nothing changed. Re-run with --go to execute.");
    }
    Ok(())
}

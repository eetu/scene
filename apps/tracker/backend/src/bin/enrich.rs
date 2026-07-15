//! `tracker-enrich extract <root> [out.jsonl]` — pull each module's embedded
//! text (sample/instrument names + messages) into a corpus for LLM triage.
//! `tracker-enrich merge <proposals.json> <library.json> [--write]` — fold the
//! reviewed proposals into the manifest additively (dry-run without `--write`).
//!
//! The pipeline: extract → an LLM triages the corpus into proposals.json
//! (artist aka/groups, per-song forGroup/with/year) → merge. Extract reads bytes
//! off the mount (a one-time pass, like a rescan); merge touches only the local
//! library.json. Apply the merged file by copying it to <root>/library.json +
//! POST /api/library/reload.

use std::io::Write;
use std::path::{Path, PathBuf};

use tracker_backend::enrich::{build_corpus, merge, Proposals};
use tracker_backend::manifest;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("extract") => extract_cmd(&args[1..]),
        Some("merge") => merge_cmd(&args[1..]),
        _ => {
            eprintln!(
                "usage:\n  tracker-enrich extract <root> [out.jsonl]\n  \
                 tracker-enrich merge <proposals.json> <library.json> [--write]"
            );
            std::process::exit(2);
        }
    }
}

fn extract_cmd(args: &[String]) -> anyhow::Result<()> {
    let root = args
        .first()
        .ok_or_else(|| anyhow::anyhow!("extract needs a <root>"))?;
    let out = args
        .get(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("enrich-corpus.jsonl"));

    let corpus = build_corpus(Path::new(root));
    let mut f = std::fs::File::create(&out)?;
    for e in &corpus {
        writeln!(f, "{}", serde_json::to_string(e)?)?;
    }
    let with_text = corpus.iter().filter(|e| !e.text.is_empty()).count();
    println!(
        "modules {}  with text {}  → {}",
        corpus.len(),
        with_text,
        out.display()
    );
    Ok(())
}

fn merge_cmd(args: &[String]) -> anyhow::Result<()> {
    let proposals_path = args
        .first()
        .ok_or_else(|| anyhow::anyhow!("merge needs <proposals.json>"))?;
    let manifest_path = args
        .get(1)
        .ok_or_else(|| anyhow::anyhow!("merge needs <library.json>"))?;
    let write = args.iter().any(|a| a == "--write");

    let proposals: Proposals = serde_json::from_slice(&std::fs::read(proposals_path)?)?;
    let mut m = manifest::load(Path::new(manifest_path))?;
    let st = merge(&mut m, &proposals);

    println!(
        "artists touched {}  aka +{}  groups +{}  songs {}",
        st.artists_touched, st.aka_added, st.groups_added, st.songs_touched
    );
    if write {
        manifest::save(Path::new(manifest_path), &m)?;
        println!("wrote {manifest_path}");
    } else {
        println!("DRY RUN — pass --write to apply");
    }
    Ok(())
}

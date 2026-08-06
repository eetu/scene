//! HVSC as a mounted, read-only source, end to end through the real binary.
//!
//! Three claims worth proving outside a unit test:
//!   * the collection is indexed **without reading any tune** — the whole point
//!     of using its own catalogue instead of a filesystem walk;
//!   * the package is never written to, so it can be a read-only mount;
//!   * everything HVSC-specific is absent unless a root is configured, which is
//!     what makes it a feature flag rather than dead UI.

use std::path::Path;

use tracker_integration::Stack;

const DB: &str = "[Database]\n\
; /MUSICIANS/H/Hubbard_Rob/Commando.sid\n\
5f08a730b280e54fd1e75a7046b93fdc=1:17 0:56 2:03.4\n\
; /DEMOS/0-9/12th_Sector_Music.sid\n\
c7c299ce06ec5ccffb2261fb11b42a73=4:33.108\n";

/// STIL as the real document is shaped: CRLF, a 7-column right-aligned field
/// gutter, a file-scope note and a per-subtune one.
const STIL: &str = "\
##############################################################################\r
#  STIL v85 - SID Tune Information List\r
##############################################################################\r
\r
/MUSICIANS/H/Hubbard_Rob/Commando.sid\r
COMMENT: One of the best known\r
         C64 soundtracks.\r
(#2)\r
  TITLE: Commando (title)\r
 ARTIST: Rob Hubbard\r
";

/// Lay out a minimal but structurally real HVSC release.
fn seed_hvsc(root: &Path) {
    std::fs::create_dir_all(root.join("DOCUMENTS")).unwrap();
    std::fs::write(root.join("DOCUMENTS/Songlengths.md5"), DB).unwrap();
    std::fs::write(root.join("DOCUMENTS/STIL.txt"), STIL).unwrap();
    std::fs::write(
        root.join("DOCUMENTS/HVSC.txt"),
        // Latin-1, like the real document — a strict UTF-8 read fails on this.
        [
            b"T H E   H I G H   V O L T A G E\n\n    Release 85\n\nInge H".to_vec(),
            vec![0xf8],
            b"ie Pedersen\n".to_vec(),
        ]
        .concat(),
    )
    .unwrap();
    for p in [
        "MUSICIANS/H/Hubbard_Rob/Commando.sid",
        "DEMOS/0-9/12th_Sector_Music.sid",
    ] {
        let f = root.join(p);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, b"tune bytes").unwrap();
    }
}

#[tokio::test]
#[ignore]
async fn indexes_itself_at_boot_and_reports_its_release() -> anyhow::Result<()> {
    let s = Stack::start_with_second_root("hvsc", "hvsc").await?;
    let root = s.root2.clone().unwrap();
    seed_hvsc(&root);

    // Boot already ran before the tree existed, so trigger the index explicitly;
    // this is also the "Reindex HVSC" button's path.
    let r = s.post_empty("/api/rescan/hvsc").await;
    assert!(r.status().is_success(), "reindex: {}", r.status());
    let body: serde_json::Value = r.json().await?;
    assert_eq!(body["indexed"], 2, "two tunes");
    assert_eq!(body["subtunes"], 4, "3 + 1 subtunes");
    assert_eq!(body["hashed"], 0, "nothing was hashed — that's the point");

    // The release number comes from a Latin-1 document; a strict UTF-8 read
    // would fail on the whole file and silently report no version.
    let status = s.get_json("/status").await;
    assert_eq!(status["hvsc"]["hvsc"]["version"], 85);
    assert_eq!(status["hvsc"]["hvsc"]["tunes"], 2);
    assert_eq!(status["hvsc"]["hvsc"]["subtunes"], 4);

    // One library entry per subtune, with durations from the catalogue.
    let ids = s
        .get_json("/api/library/ids?collection=hvsc&group_by=artist")
        .await;
    let flat: Vec<i64> = ids["groups"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|g| {
            g["ids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_i64().unwrap())
        })
        .collect();
    assert_eq!(flat.len(), 4);

    let hydrated = s
        .get_json(&format!(
            "/api/tracks/batch?ids={}",
            flat.iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",")
        ))
        .await;
    let tracks = hydrated["tracks"].as_array().unwrap();
    let commando: Vec<_> = tracks
        .iter()
        .filter(|t| t["filename"] == "Commando.sid")
        .collect();
    assert_eq!(commando.len(), 3);
    // MUSICIANS/<letter>/<Artist>/ names the composer…
    assert_eq!(commando[0]["artist"], "Hubbard_Rob");
    assert_eq!(commando[1]["duration"], 56.0);
    // …while DEMOS/ starts with a category, so no artist is invented.
    let demo = tracks
        .iter()
        .find(|t| t["filename"] == "12th_Sector_Music.sid")
        .unwrap();
    assert!(demo["artist"].is_null());
    assert_eq!(demo["title"], "12th Sector Music");
    assert_eq!(demo["duration"], 273.108);

    // STIL is read in the same pass. A tune's notes come back file-scope first,
    // then the subtune's — and only that subtune's.
    let id = commando[1]["id"].as_i64().unwrap(); // subtune index 1 = STIL (#2)
    let notes = s.get_json(&format!("/api/stil/{id}")).await;
    let notes = notes["notes"].as_array().unwrap();
    assert_eq!(notes.len(), 2);
    assert_eq!(notes[0]["subsong"], -1);
    // The continuation line folded into the comment it continues.
    assert_eq!(
        notes[0]["comment"],
        "One of the best known C64 soundtracks."
    );
    assert_eq!(notes[1]["subsong"], 1);
    assert_eq!(notes[1]["artist"], "Rob Hubbard");

    // A subtune with no note of its own still gets the file-scope one.
    let id0 = commando[0]["id"].as_i64().unwrap();
    let only_file = s.get_json(&format!("/api/stil/{id0}")).await;
    let only_file = only_file["notes"].as_array().unwrap();
    assert_eq!(only_file.len(), 1);
    assert_eq!(only_file[0]["subsong"], -1);

    // A tune STIL says nothing about is empty, not an error — that's most of
    // the collection.
    let demo_id = demo["id"].as_i64().unwrap();
    let none = s.get_json(&format!("/api/stil/{demo_id}")).await;
    assert!(none["notes"].as_array().unwrap().is_empty());
    Ok(())
}

/// The package is read-only: indexing must not create, modify or delete
/// anything inside it, so an HVSC root can be a read-only mount or image.
#[tokio::test]
#[ignore]
async fn never_writes_into_the_collection() -> anyhow::Result<()> {
    let s = Stack::start_with_second_root("hvsc", "hvsc").await?;
    let root = s.root2.clone().unwrap();
    seed_hvsc(&root);

    /// Every path under `dir`, with its size and mtime.
    fn snapshot(dir: &Path) -> Vec<(String, u64, std::time::SystemTime)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                let m = e.metadata().unwrap();
                if m.is_dir() {
                    stack.push(p);
                } else {
                    out.push((
                        p.strip_prefix(dir).unwrap().to_string_lossy().into_owned(),
                        m.len(),
                        m.modified().unwrap(),
                    ));
                }
            }
        }
        out.sort();
        out
    }

    let before = snapshot(&root);
    s.post_empty("/api/rescan/hvsc").await;
    assert_eq!(snapshot(&root), before, "the collection was modified");

    // And mutating routes stay refused on it (see roots.rs for the guard).
    let r = s
        .client
        .post(format!("{}/api/delete", s.base))
        .json(&serde_json::json!({
            "path": "MUSICIANS/H/Hubbard_Rob/Commando.sid",
            "root": "hvsc",
        }))
        .send()
        .await?;
    assert_eq!(r.status(), 400);
    assert!(root.join("MUSICIANS/H/Hubbard_Rob/Commando.sid").is_file());
    Ok(())
}

/// With no HVSC root configured there is nothing HVSC-specific to report — that
/// absence is the feature flag the SPA keys off.
#[tokio::test]
#[ignore]
async fn is_absent_entirely_without_a_configured_root() -> anyhow::Result<()> {
    let s = Stack::start().await?;
    s.rescan().await;
    let status = s.get_json("/status").await;
    assert_eq!(
        status["hvsc"].as_object().map(|o| o.len()),
        Some(0),
        "no HVSC root → no HVSC facts"
    );
    // And the reindex route has no root to act on.
    assert_eq!(s.post_empty("/api/rescan/hvsc").await.status(), 400);
    Ok(())
}

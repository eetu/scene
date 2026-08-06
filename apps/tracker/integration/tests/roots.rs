//! Multiple collection roots. Identity in the index is `(root_id, rel_path)`,
//! not `rel_path` — two roots can legitimately hold the same relative path — and
//! every filesystem access resolves against the *row's own* root, never a
//! default. These are the security-relevant guards, so they get real assertions
//! against a spawned backend rather than unit coverage alone.

use serde_json::json;
use tracker_integration::Stack;

/// The same `rel_path` in two roots must index as two distinct tracks, each
/// serving its own bytes. A regression here would silently collapse one
/// collection onto the other.
#[tokio::test]
#[ignore]
async fn same_rel_path_in_two_roots_stays_distinct() -> anyhow::Result<()> {
    let s = Stack::start_with_second_root("extra", "scan").await?;
    s.rescan().await;
    s.rescan_root("extra").await;

    let tracks = s.tracks().await;
    let songs: Vec<_> = tracks
        .iter()
        .filter(|t| t["path"] == "Coder/song.mod")
        .collect();
    assert_eq!(songs.len(), 2, "one row per root, not one shared row");

    let mods = songs.iter().find(|t| t["collection"] == "mods").unwrap();
    let extra = songs.iter().find(|t| t["collection"] == "extra").unwrap();
    assert_ne!(
        mods["hash"], extra["hash"],
        "different bytes must hash differently"
    );

    // Each hash serves the bytes from its *own* root.
    let body = s
        .get(&format!("/api/file/{}", extra["hash"].as_str().unwrap()))
        .await
        .bytes()
        .await?;
    assert_eq!(&body[..], b"second-root-mod-zzz");
    Ok(())
}

/// An `hvsc` root is a versioned upstream distribution: mutating it would
/// desync it from its own catalogue and be undone by the next release, so
/// rename and delete are refused before any path is touched.
#[tokio::test]
#[ignore]
async fn hvsc_root_refuses_mutation() -> anyhow::Result<()> {
    let s = Stack::start_with_second_root("hvsc", "hvsc").await?;

    let r = s
        .post_json(
            "/api/rename",
            json!({
                "from": "Coder/song.mod",
                "root": "hvsc",
                "group": "",
                "artist": "Coder",
                "filename": "renamed.mod",
            }),
        )
        .await;
    assert_eq!(r.status(), 400, "rename into a read-only root");

    let r = s
        .client
        .post(format!("{}/api/delete", s.base))
        .json(&json!({ "path": "Coder/song.mod", "root": "hvsc" }))
        .send()
        .await?;
    assert_eq!(r.status(), 400, "delete inside a read-only root");

    // The file is still there — the guard ran before any filesystem access.
    assert!(s.root2.as_ref().unwrap().join("Coder/song.mod").is_file());

    // And it is not walked: an hvsc root rebuilds from its own catalogue. This
    // fixture has no catalogue, which is a misconfigured path rather than a
    // server fault — so it reports 400, not 500. (tests/hvsc.rs covers the
    // successful path against a real HVSC layout.)
    let r = s.post_empty("/api/rescan/hvsc").await;
    assert_eq!(r.status(), 400, "not an HVSC collection");
    Ok(())
}

/// An unknown root id is rejected outright rather than silently falling back to
/// the primary root — the fallback would let a caller reach another tree.
#[tokio::test]
#[ignore]
async fn unknown_root_is_rejected_not_defaulted() -> anyhow::Result<()> {
    let s = Stack::start().await?;
    s.rescan().await;

    let r = s
        .client
        .post(format!("{}/api/delete", s.base))
        .json(&json!({ "path": "Coder/song.mod", "root": "nope" }))
        .send()
        .await?;
    assert_eq!(r.status(), 400);
    assert!(s.root.join("Coder/song.mod").is_file());
    Ok(())
}

/// `/status` advertises the configured roots so the SPA can build its source
/// selector without a second call.
#[tokio::test]
#[ignore]
async fn status_lists_configured_roots() -> anyhow::Result<()> {
    let s = Stack::start_with_second_root("hvsc", "hvsc").await?;
    s.rescan().await;
    let body = s.get_json("/status").await;
    let roots = body["roots"].as_array().expect("roots array");
    assert_eq!(roots.len(), 2);
    assert_eq!(roots[0]["id"], "mods");
    assert_eq!(roots[0]["kind"], "scan");
    assert_eq!(roots[1]["id"], "hvsc");
    assert_eq!(roots[1]["kind"], "hvsc");
    assert_eq!(roots[1]["label"], "HVSC");

    // Per-root counts label the source selector. The hvsc root has no indexer
    // yet, so it reports null (absent) rather than a misleading zero.
    assert_eq!(roots[0]["count"], 3, "the mods fixture has three modules");
    assert!(roots[1]["count"].is_null());
    Ok(())
}

//! End-to-end API tests. `cargo test -p tracker-e2e -- --ignored`
//! (build the binary first: `cargo build -p tracker-backend`).

use tracker_e2e::Stack;

#[tokio::test]
#[ignore]
async fn status_is_unauthenticated_and_healthy() {
    let s = Stack::start().await.unwrap();
    let r = s.get("/status").await;
    assert!(r.status().is_success());
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["service"], "tracker");
    assert_eq!(body["db_healthy"], true);
}

#[tokio::test]
#[ignore]
async fn rescan_indexes_modules_and_derives_group_artist() {
    let s = Stack::start().await.unwrap();
    let counts = s.rescan().await;
    // 3 modules; junk + non-module files skipped.
    assert_eq!(counts["indexed"], 3, "counts: {counts}");

    let tracks = s.tracks().await;
    assert_eq!(tracks.len(), 3);

    let song = tracks
        .iter()
        .find(|t| t["path"] == "Acme/Coder/song.mod")
        .expect("song.mod indexed");
    assert_eq!(song["group"], "Acme");
    assert_eq!(song["artist"], "Coder");
    assert_eq!(song["ext"], "mod");

    // group/song.ext layout → artist is null.
    let intro = tracks
        .iter()
        .find(|t| t["path"] == "Demo/intro.s3m")
        .expect("intro.s3m indexed");
    assert_eq!(intro["group"], "Demo");
    assert!(intro["artist"].is_null());
}

#[tokio::test]
#[ignore]
async fn file_by_hash_returns_bytes() {
    let s = Stack::start().await.unwrap();
    s.rescan().await;
    let tracks = s.tracks().await;
    let song = tracks
        .iter()
        .find(|t| t["path"] == "Acme/Coder/song.mod")
        .unwrap();
    let hash = song["hash"].as_str().unwrap();

    let r = s.get(&format!("/api/file/{hash}")).await;
    assert!(r.status().is_success());
    let bytes = r.bytes().await.unwrap();
    assert_eq!(&bytes[..], b"fixture-mod-aaa");
}

#[tokio::test]
#[ignore]
async fn metadata_survives_a_file_move() {
    let s = Stack::start().await.unwrap();
    s.rescan().await;

    let hash = {
        let tracks = s.tracks().await;
        tracks
            .iter()
            .find(|t| t["path"] == "Acme/Coder/song.mod")
            .unwrap()["hash"]
            .as_str()
            .unwrap()
            .to_string()
    };

    // Enrich by content hash.
    let r = s
        .post_json(
            &format!("/api/meta/{hash}"),
            serde_json::json!({ "title": "Cool Song", "type_long": "ProTracker", "channels": 4 }),
        )
        .await;
    assert!(r.status().is_success());

    // Move the file to a different group/artist; bytes (hash) unchanged.
    std::fs::create_dir_all(s.root.join("NewGroup/NewArtist")).unwrap();
    std::fs::rename(
        s.root.join("Acme/Coder/song.mod"),
        s.root.join("NewGroup/NewArtist/renamed.mod"),
    )
    .unwrap();
    s.rescan().await;

    let tracks = s.tracks().await;
    let moved = tracks
        .iter()
        .find(|t| t["path"] == "NewGroup/NewArtist/renamed.mod")
        .expect("moved file re-indexed at new path");
    assert_eq!(moved["hash"].as_str().unwrap(), hash, "hash unchanged");
    assert_eq!(moved["title"], "Cool Song", "enrichment followed the bytes");
    assert_eq!(moved["group"], "NewGroup");
    assert_eq!(moved["artist"], "NewArtist");
}

#[tokio::test]
#[ignore]
async fn rename_moves_file_keeps_hash_and_metadata() {
    let s = Stack::start().await.unwrap();
    s.rescan().await;

    let hash = {
        let tracks = s.tracks().await;
        tracks
            .iter()
            .find(|t| t["path"] == "Acme/Coder/song.mod")
            .unwrap()["hash"]
            .as_str()
            .unwrap()
            .to_string()
    };
    s.post_json(
        &format!("/api/meta/{hash}"),
        serde_json::json!({ "title": "Cleaned Up" }),
    )
    .await;

    // Rename + move to a new group/artist with a tidy filename.
    let r = s
        .post_json(
            "/api/rename",
            serde_json::json!({
                "from": "Acme/Coder/song.mod",
                "group": "Acme",
                "artist": "Coder",
                "filename": "Proper Title.mod"
            }),
        )
        .await;
    assert!(r.status().is_success(), "rename failed: {}", r.status());
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["path"], "Acme/Coder/Proper Title.mod");

    // The file is on disk at the new path, gone from the old, and the index +
    // metadata followed it (no rescan needed for the in-place update).
    assert!(s.root.join("Acme/Coder/Proper Title.mod").is_file());
    assert!(!s.root.join("Acme/Coder/song.mod").exists());

    let tracks = s.tracks().await;
    assert!(tracks.iter().all(|t| t["path"] != "Acme/Coder/song.mod"));
    let moved = tracks
        .iter()
        .find(|t| t["path"] == "Acme/Coder/Proper Title.mod")
        .expect("renamed file in index");
    assert_eq!(moved["hash"].as_str().unwrap(), hash, "hash unchanged");
    assert_eq!(moved["title"], "Cleaned Up", "metadata preserved");
    assert_eq!(moved["filename"], "Proper Title.mod");
}

#[tokio::test]
#[ignore]
async fn rename_refuses_overwrite_and_bad_names() {
    let s = Stack::start().await.unwrap();
    s.rescan().await;

    // Overwriting an existing module → 409.
    let conflict = s
        .post_json(
            "/api/rename",
            serde_json::json!({
                "from": "Acme/Coder/song.mod",
                "group": "Acme",
                "artist": "Coder",
                "filename": "tune.xm"
            }),
        )
        .await;
    assert_eq!(conflict.status().as_u16(), 409);

    // Dropping the module extension → 400 (would vanish from the index).
    let bad_ext = s
        .post_json(
            "/api/rename",
            serde_json::json!({
                "from": "Acme/Coder/song.mod",
                "group": "Acme",
                "artist": "Coder",
                "filename": "song"
            }),
        )
        .await;
    assert_eq!(bad_ext.status().as_u16(), 400);

    // Path-escape attempt in a segment → 400.
    let escape = s
        .post_json(
            "/api/rename",
            serde_json::json!({
                "from": "Acme/Coder/song.mod",
                "group": "../../etc",
                "artist": null,
                "filename": "song.mod"
            }),
        )
        .await;
    assert_eq!(escape.status().as_u16(), 400);

    // The original file is untouched after all the rejected attempts.
    assert!(s.root.join("Acme/Coder/song.mod").is_file());
}

#[tokio::test]
#[ignore]
async fn api_requires_auth_header_without_dev_auth() {
    // The harness runs with DEV_AUTH=1, so this just documents that /api is
    // reachable in dev; the prod gate is unit-tested in backend/src/auth.rs.
    let s = Stack::start().await.unwrap();
    let r = s.get("/api/tracks").await;
    assert!(r.status().is_success());
}

//! End-to-end API tests. `cargo test -p tracker-e2e -- --ignored`
//! (build the binary first: `cargo build -p tracker-backend`).

use tracker_integration::Stack;

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
async fn rescan_indexes_modules_and_derives_artist() {
    let s = Stack::start().await.unwrap();
    let counts = s.rescan().await;
    // 3 modules; junk + non-module files skipped.
    assert_eq!(counts["indexed"], 3, "counts: {counts}");

    let tracks = s.tracks().await;
    assert_eq!(tracks.len(), 3);

    let song = tracks
        .iter()
        .find(|t| t["path"] == "Coder/song.mod")
        .expect("song.mod indexed");
    // Artist-primary: seg0 is the artist; there is no path-group.
    assert_eq!(song["group"], "");
    assert_eq!(song["artist"], "Coder");
    assert_eq!(song["ext"], "mod");

    // A module at the root (no artist dir) → artist is null.
    let intro = tracks
        .iter()
        .find(|t| t["path"] == "intro.s3m")
        .expect("intro.s3m indexed");
    assert_eq!(intro["group"], "");
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
        .find(|t| t["path"] == "Coder/song.mod")
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
            .find(|t| t["path"] == "Coder/song.mod")
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

    // Move the file to a different artist; bytes (hash) unchanged.
    std::fs::create_dir_all(s.root.join("NewArtist")).unwrap();
    std::fs::rename(
        s.root.join("Coder/song.mod"),
        s.root.join("NewArtist/renamed.mod"),
    )
    .unwrap();
    s.rescan().await;

    let tracks = s.tracks().await;
    let moved = tracks
        .iter()
        .find(|t| t["path"] == "NewArtist/renamed.mod")
        .expect("moved file re-indexed at new path");
    assert_eq!(moved["hash"].as_str().unwrap(), hash, "hash unchanged");
    assert_eq!(moved["title"], "Cool Song", "enrichment followed the bytes");
    assert_eq!(moved["group"], "");
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
            .find(|t| t["path"] == "Coder/song.mod")
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

    // Rename + move to a new artist with a tidy filename.
    let r = s
        .post_json(
            "/api/rename",
            serde_json::json!({
                "from": "Coder/song.mod",
                "group": "",
                "artist": "Coder",
                "filename": "Proper Title.mod"
            }),
        )
        .await;
    assert!(r.status().is_success(), "rename failed: {}", r.status());
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["path"], "Coder/Proper Title.mod");

    // The file is on disk at the new path, gone from the old, and the index +
    // metadata followed it (no rescan needed for the in-place update).
    assert!(s.root.join("Coder/Proper Title.mod").is_file());
    assert!(!s.root.join("Coder/song.mod").exists());

    let tracks = s.tracks().await;
    assert!(tracks.iter().all(|t| t["path"] != "Coder/song.mod"));
    let moved = tracks
        .iter()
        .find(|t| t["path"] == "Coder/Proper Title.mod")
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
                "from": "Coder/song.mod",
                "group": "",
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
                "from": "Coder/song.mod",
                "group": "",
                "artist": "Coder",
                "filename": "song"
            }),
        )
        .await;
    assert_eq!(bad_ext.status().as_u16(), 400);

    // Path-escape attempt in the artist segment → 400.
    let escape = s
        .post_json(
            "/api/rename",
            serde_json::json!({
                "from": "Coder/song.mod",
                "group": "",
                "artist": "../../etc",
                "filename": "song.mod"
            }),
        )
        .await;
    assert_eq!(escape.status().as_u16(), 400);

    // The original file is untouched after all the rejected attempts.
    assert!(s.root.join("Coder/song.mod").is_file());
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

#[tokio::test]
#[ignore]
async fn delete_removes_file_and_clears_the_dupe_report() {
    let s = Stack::start().await.unwrap();
    // Add an exact copy of song.mod under a second artist (same bytes → same md5).
    std::fs::create_dir_all(s.root.join("Ripper")).unwrap();
    std::fs::write(s.root.join("Ripper/song.mod"), b"fixture-mod-aaa").unwrap();
    s.rescan().await;
    assert_eq!(s.tracks().await.len(), 4);

    // The two copies are reported as one exact-duplicate set.
    let dupes = s.get_json("/api/dupes").await;
    let exact = dupes["exact"].as_array().unwrap();
    assert_eq!(exact.len(), 1, "one exact dupe set: {dupes}");
    let paths: Vec<&str> = exact[0]["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    assert!(paths.contains(&"Coder/song.mod") && paths.contains(&"Ripper/song.mod"));

    // Delete one copy.
    let r = s
        .post_json(
            "/api/delete",
            serde_json::json!({ "path": "Ripper/song.mod" }),
        )
        .await;
    assert!(r.status().is_success(), "delete failed: {}", r.status());
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["removed"], 1);

    // Gone from disk + index; the other copy is untouched; no longer a dupe.
    assert!(!s.root.join("Ripper/song.mod").exists());
    assert!(s.root.join("Coder/song.mod").is_file());
    let tracks = s.tracks().await;
    assert_eq!(tracks.len(), 3);
    assert!(tracks.iter().all(|t| t["path"] != "Ripper/song.mod"));
    let dupes = s.get_json("/api/dupes").await;
    assert!(
        dupes["exact"].as_array().unwrap().is_empty(),
        "dupes cleared: {dupes}"
    );
}

#[tokio::test]
#[ignore]
async fn delete_rejects_path_escape_and_unknown() {
    let s = Stack::start().await.unwrap();
    s.rescan().await;

    // Escaping the root (canonicalize + prefix check) → 404, not a real delete.
    let escape = s
        .post_json(
            "/api/delete",
            serde_json::json!({ "path": "../../etc/hosts" }),
        )
        .await;
    assert_eq!(escape.status().as_u16(), 404);

    // A path not under the root's index → 404.
    let missing = s
        .post_json(
            "/api/delete",
            serde_json::json!({ "path": "Coder/nope.mod" }),
        )
        .await;
    assert_eq!(missing.status().as_u16(), 404);

    // Nothing was touched.
    assert!(s.root.join("Coder/song.mod").is_file());
    assert_eq!(s.tracks().await.len(), 3);
}

/// Scanning a network mount is minutes of work, so the request that starts it
/// must not be the thing that reports it finished: one dropped connection — a UI
/// reload, a proxy timeout — used to look like a failure while the scan carried
/// on regardless, with no way to tell the difference.
#[tokio::test]
#[ignore]
async fn rescan_is_accepted_and_reports_its_outcome_afterwards() {
    let s = Stack::start().await.unwrap();

    let r = s.post_empty("/api/rescan").await;
    assert_eq!(r.status(), 202, "the scan is started, not awaited");
    let body: serde_json::Value = r.json().await.unwrap();
    assert_eq!(body["started"], true);

    // There was an `assert_eq!(status["scanning"], true)` here, and it was a race the
    // test could only lose: the fixture is three files, so the scan can finish before a
    // second HTTP round trip lands, and then `scanning` is legitimately false. It failed
    // in CI on an unrelated PR and passed on a re-run of the same commit.
    //
    // Nothing is lost by dropping it. The flag being claimed before the 202 is what
    // `a_second_rescan_is_refused_while_one_runs` proves, deterministically, in the unit
    // tests — and that a scan's outcome is readable the moment the flag clears is what
    // the test below this one proves. Neither needs to catch a scan mid-flight.

    // A 202 has no counts to give, so the outcome surfaces on /status instead —
    // otherwise a failed scan would be indistinguishable from one that found
    // nothing. Waited for, not re-POSTed: the scan already running would refuse
    // a second one.
    let last = s.await_scan().await;
    assert_eq!(last["indexed"], 3, "last_scan: {last}");
    assert!(last["error"].is_null(), "unexpected error: {last}");
    assert_eq!(last["root"], "mods");
    assert!(!last["finished_at"].as_str().unwrap_or("").is_empty());
}

/// `last_scan` describes the last scan that *finished*, not the last one
/// somebody asked for over HTTP — so the scan the backend runs at boot records
/// its outcome too.
#[tokio::test]
#[ignore]
async fn the_boot_scan_records_its_outcome_as_well() {
    let s = Stack::start().await.unwrap();
    // Waiting for `scanning` to go false isn't enough here: the boot scan is
    // spawned, so it may not have *started* when the first poll lands — and
    // "not scanning, nothing finished yet" is a truthful state, not a bug. Wait
    // for the outcome itself.
    let mut last = serde_json::Value::Null;
    for _ in 0..600 {
        let st = s.get_json("/status").await;
        if !st["last_scan"].is_null() {
            last = st["last_scan"].clone();
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(last["indexed"], 3, "last_scan: {last}");
    assert_eq!(last["root"], "mods");
    assert!(last["error"].is_null());
}

// `the_outcome_is_readable_the_instant_scanning_stops` used to live here: POST a rescan,
// poll /status as fast as possible, and assert that the moment `scanning` reads false the
// outcome is published. It guarded a real bug — the flag was once cleared by a drop guard
// before the outcome was written, and the SPA polls exactly that transition.
//
// It is gone because it could not fail. As written it asserted `last_scan` was merely
// non-null, and `last_scan` is only ever set and never cleared, so once the boot scan had
// populated it the assertion was unfalsifiable. Rewriting it to assert `finished_at` had
// MOVED made it non-vacuous — and it still passed with the bug deliberately reintroduced
// (dropping the flag guard before the publish), because the gap is sub-microsecond and an
// HTTP round trip is a hundred times longer. A test that cannot observe the window it
// exists for is a test that reports a pass it did not earn.
//
// What actually holds the invariant is the structure of `run_scan`: the outcome is
// published inside the blocking closure, so it is written before `_done` drops at the end
// of that scope. That is lexical, not timing-dependent, and the comment there says so.

// The concurrent-scan refusal used to be tested here, by seeding 800 files so the scan
// would still be running when a second request landed — a race with a ~100ms margin,
// which is a bet on how fast the machine is rather than an assertion about the code. It
// moved to a unit test that sets the flag and calls the handler (see
// `routes::tests::a_second_rescan_is_refused`), where "a scan is running" is a fact
// rather than a hope, and the 800-file fixture stopped being written at all.

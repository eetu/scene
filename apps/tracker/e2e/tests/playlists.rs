//! End-to-end tests for playlists + the Top Favourites sync.
//! `cargo test -p tracker-e2e -- --ignored` (build the binary first).

use serde_json::json;
use tracker_e2e::Stack;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
#[ignore]
async fn playlist_crud_and_ordering() {
    let s = Stack::start().await.unwrap();
    s.rescan().await;
    let tracks = s.tracks().await;
    let h0 = tracks[0]["hash"].as_str().unwrap().to_string();
    let h1 = tracks[1]["hash"].as_str().unwrap().to_string();

    // Create.
    let pl: serde_json::Value = s
        .post_json("/api/playlists", json!({ "name": "My Mix" }))
        .await
        .json()
        .await
        .unwrap();
    let id = pl["id"].as_str().unwrap().to_string();
    assert_eq!(pl["name"], "My Mix");
    assert_eq!(pl["kind"], "user");

    // It shows up in the list.
    let list = s.get_json("/api/playlists").await;
    assert!(list["playlists"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["id"] == id.as_str()));

    // Add two items; adding a dup is idempotent.
    s.post_json(&format!("/api/playlists/{id}/items"), json!({ "hash": h0 }))
        .await;
    s.post_json(&format!("/api/playlists/{id}/items"), json!({ "hash": h1 }))
        .await;
    s.post_json(&format!("/api/playlists/{id}/items"), json!({ "hash": h0 }))
        .await; // dup

    let detail = s.get_json(&format!("/api/playlists/{id}")).await;
    let items = detail["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "dup not appended");
    assert_eq!(items[0]["hash"], h0.as_str());
    assert_eq!(items[0]["present"], true);
    assert_eq!(items[1]["hash"], h1.as_str());

    // Reorder: h1 then h0.
    s.put_json(
        &format!("/api/playlists/{id}/items"),
        json!({ "hashes": [h1, h0] }),
    )
    .await;
    let detail = s.get_json(&format!("/api/playlists/{id}")).await;
    assert_eq!(detail["items"][0]["hash"], h1.as_str());
    assert_eq!(detail["items"][1]["hash"], h0.as_str());

    // Remove one item.
    let r = s.delete(&format!("/api/playlists/{id}/items/{h0}")).await;
    assert!(r.status().is_success());
    let detail = s.get_json(&format!("/api/playlists/{id}")).await;
    assert_eq!(detail["items"].as_array().unwrap().len(), 1);

    // Delete the playlist.
    let r = s.delete(&format!("/api/playlists/{id}")).await;
    assert!(r.status().is_success());
    let r = s.get(&format!("/api/playlists/{id}")).await;
    assert_eq!(r.status().as_u16(), 404);
}

#[tokio::test]
#[ignore]
async fn top_sync_downloads_missing_and_builds_playlist() {
    // Stub Mod Archive: the chart page links one module; the download serves
    // real bytes. The client de-dups by id, so serving the same HTML for every
    // page makes it stop after page 2 (no new ids).
    let server = MockServer::start().await;
    let chart = r#"<a href="downloads.php?moduleid=999#newtune.mod">dl</a>"#;
    Mock::given(method("GET"))
        .and(path("/index.php"))
        .respond_with(ResponseTemplate::new(200).set_body_string(chart))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/downloads.php"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"BRAND-NEW-MODULE".to_vec()))
        .mount(&server)
        .await;

    let uri = server.uri();
    let s = Stack::start_with_env(&[("MODARCHIVE_WEB_BASE", &uri), ("MODARCHIVE_DL_BASE", &uri)])
        .await
        .unwrap();
    s.rescan().await;

    // Kick off the sync; poll status until it finishes.
    let r = s.post_empty("/api/top/sync").await;
    assert!(r.status().is_success(), "sync start: {}", r.status());
    let mut done = false;
    for _ in 0..100 {
        let st = s.get_json("/api/top/status").await;
        if st["syncing"] == false && st["total"].as_u64().unwrap_or(0) > 0 {
            assert_eq!(st["fetched"], 1, "one new module fetched: {st}");
            done = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    assert!(done, "sync did not complete");

    // The module landed in the tree under the Top Favourites group and indexed.
    assert!(s.root.join("Top Favourites/newtune.mod").is_file());
    let tracks = s.tracks().await;
    let fetched = tracks
        .iter()
        .find(|t| t["path"] == "Top Favourites/newtune.mod")
        .expect("downloaded module indexed");
    assert_eq!(fetched["group"], "Top Favourites");

    // A top_favourites playlist exists, contains the fetched track, present.
    let list = s.get_json("/api/playlists").await;
    let tp = list["playlists"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["kind"] == "top_favourites")
        .expect("top favourites playlist created");
    let detail = s
        .get_json(&format!("/api/playlists/{}", tp["id"].as_str().unwrap()))
        .await;
    let items = detail["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["present"], true);
    assert_eq!(items[0]["filename"], "newtune.mod");

    // Re-sync: we now have it (by filename) → no second download.
    let r = s.post_empty("/api/top/sync").await;
    assert!(r.status().is_success());
    for _ in 0..100 {
        let st = s.get_json("/api/top/status").await;
        if st["syncing"] == false {
            assert_eq!(
                st["have"], 1,
                "already-present module not re-downloaded: {st}"
            );
            assert_eq!(st["fetched"], 0);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
}

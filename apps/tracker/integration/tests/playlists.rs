//! End-to-end tests for playlists + the Modland fetch-missing flow.
//! `cargo test -p tracker-e2e -- --ignored` (build the binary first).
//!
//! Items are keyed by md5/path/url (a module follows its bytes across moves):
//! add with `{md5}` for a local track, reorder by the item `id`s, remove by
//! item `id`. Missing items carry a Modland `path` (or generic `url`) that
//! `fetch-missing` downloads into the tree.

use serde_json::json;
use tracker_integration::Stack;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
#[ignore]
async fn playlist_crud_and_ordering() {
    let s = Stack::start().await.unwrap();
    s.rescan().await;
    let tracks = s.tracks().await;
    // Items are md5-keyed; capture each track's md5 (the add key) and its
    // content_hash (what a present item resolves to for playback).
    let m0 = tracks[0]["md5"].as_str().expect("track md5").to_string();
    let m1 = tracks[1]["md5"].as_str().expect("track md5").to_string();
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

    // Add two items; adding a dup (same md5) is idempotent.
    let route = format!("/api/playlists/{id}/items");
    assert!(s
        .post_json(&route, json!({ "md5": m0 }))
        .await
        .status()
        .is_success());
    assert!(s
        .post_json(&route, json!({ "md5": m1 }))
        .await
        .status()
        .is_success());
    assert!(s
        .post_json(&route, json!({ "md5": m0 }))
        .await
        .status()
        .is_success()); // dup

    let detail = s.get_json(&format!("/api/playlists/{id}")).await;
    let items = detail["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "dup not appended");
    assert_eq!(items[0]["md5"], m0.as_str());
    assert_eq!(items[0]["hash"], h0.as_str());
    assert_eq!(items[0]["present"], true);
    assert_eq!(items[1]["md5"], m1.as_str());
    assert_eq!(items[1]["hash"], h1.as_str());

    // Reorder by item id: second item first.
    let id0 = items[0]["id"].as_i64().unwrap();
    let id1 = items[1]["id"].as_i64().unwrap();
    s.put_json(
        &format!("/api/playlists/{id}/items"),
        json!({ "ids": [id1, id0] }),
    )
    .await;
    let detail = s.get_json(&format!("/api/playlists/{id}")).await;
    assert_eq!(detail["items"][0]["md5"], m1.as_str());
    assert_eq!(detail["items"][1]["md5"], m0.as_str());

    // Remove one item (by item id).
    let r = s.delete(&format!("/api/playlists/{id}/items/{id0}")).await;
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
async fn fetch_missing_downloads_and_resolves_item() {
    // Stub Modland: any GET serves the module bytes (download_path hits
    // `{base}/pub/modules/<path>`).
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"BRAND-NEW-MODULE-BYTES".to_vec()))
        .mount(&server)
        .await;

    let s = Stack::start_with_env(&[("MODLAND_BASE", &server.uri())])
        .await
        .unwrap();
    s.rescan().await;

    // Import a curated list whose one item is missing locally but carries a
    // Modland path → group=format, artist=author, filename from the path.
    let pl: serde_json::Value = s
        .post_json(
            "/api/playlists/import",
            json!({
                "name": "Curated",
                "source": "test",
                "items": [{ "path": "Protracker/coma/newtune.mod", "filename": "newtune.mod" }],
            }),
        )
        .await
        .json()
        .await
        .unwrap();
    let id = pl["id"].as_str().unwrap().to_string();
    assert_eq!(pl["kind"], "imported");

    // Before fetching, the item is missing.
    let detail = s.get_json(&format!("/api/playlists/{id}")).await;
    assert_eq!(detail["items"][0]["present"], false);

    // Kick off the fetch; poll status until it finishes having seen work.
    let r = s
        .post_empty(&format!("/api/playlists/{id}/fetch-missing"))
        .await;
    assert!(r.status().is_success(), "fetch start: {}", r.status());
    let mut done = false;
    for _ in 0..100 {
        let st = s.get_json("/api/fetch/status").await;
        if st["running"] == false && st["total"].as_u64().unwrap_or(0) > 0 {
            assert_eq!(st["fetched"], 1, "one missing module fetched: {st}");
            assert_eq!(st["failed"], 0);
            done = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    assert!(done, "fetch did not complete");

    // The module landed at the library convention and indexed.
    assert!(s.root.join("Protracker/coma/newtune.mod").is_file());
    let tracks = s.tracks().await;
    let fetched = tracks
        .iter()
        .find(|t| t["path"] == "Protracker/coma/newtune.mod")
        .expect("downloaded module indexed");
    assert_eq!(fetched["group"], "Protracker");
    assert_eq!(fetched["artist"], "coma");

    // The playlist item now resolves as present.
    let detail = s.get_json(&format!("/api/playlists/{id}")).await;
    assert_eq!(detail["items"][0]["present"], true);
    assert_eq!(detail["items"][0]["filename"], "newtune.mod");

    // Re-fetch: it's present now (file with that md5 exists) → nothing to do.
    let r = s
        .post_empty(&format!("/api/playlists/{id}/fetch-missing"))
        .await;
    assert!(r.status().is_success());
    for _ in 0..100 {
        let st = s.get_json("/api/fetch/status").await;
        if st["running"] == false {
            assert_eq!(st["total"], 0, "already-present item not re-fetched: {st}");
            assert_eq!(st["fetched"], 0);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
}

//! End-to-end tests for the library manifest (`library.json`): the read/reload
//! endpoints and the curation write API (artist aliases + groups, albums,
//! per-song credits). `cargo test -p tracker-integration -- --ignored`.
//!
//! The backend defaults the manifest to `<TRACKER_ROOT>/library.json`, which the
//! harness roots in a writable temp dir — so curation actually writes a file we
//! can read back both via the API and off disk.

use serde_json::json;
use tracker_integration::Stack;

const MD5_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MD5_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[tokio::test]
#[ignore]
async fn manifest_starts_empty() {
    let s = Stack::start().await.unwrap();
    let m = s.get_json("/api/manifest").await;
    assert_eq!(m["artists"], json!({}));
    assert_eq!(m["albums"], json!({}));
    assert_eq!(m["songs"], json!({}));
}

#[tokio::test]
#[ignore]
async fn rename_files_under_artist() {
    // Artist-primary: the destination is artist/filename — no group directory.
    let s = Stack::start().await.unwrap();
    s.rescan().await;

    let res = s
        .post_json(
            "/api/rename",
            json!({ "from": "Coder/song.mod", "group": "",
                    "artist": "Purple Motion", "filename": "song.mod" }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["path"], "Purple Motion/song.mod");
    assert_eq!(body["artist"], "Purple Motion");
    assert_eq!(body["group"], ""); // no path group
    assert!(s.root.join("Purple Motion/song.mod").is_file());
}

#[tokio::test]
#[ignore]
async fn artist_alias_and_groups_round_trip() {
    let s = Stack::start().await.unwrap();

    // Upsert an artist with an alias + two groups (name is URL-encoded).
    let r = s
        .put_json(
            "/api/artist/Purple%20Motion",
            json!({ "aka": ["PM", "  "], "groups": ["Future Crew", "Future Crew"] }),
        )
        .await;
    assert_eq!(r.status(), 204);

    let m = s.get_json("/api/manifest").await;
    assert_eq!(m["artists"]["Purple Motion"]["aka"], json!(["PM"]));
    // Blank aka dropped, duplicate group collapsed.
    assert_eq!(m["artists"]["Purple Motion"]["groups"], json!(["Future Crew"]));

    // A bad aka handle (contains a slash) is rejected.
    let bad = s
        .put_json("/api/artist/Skaven", json!({ "aka": ["a/b"] }))
        .await;
    assert_eq!(bad.status(), 400);

    // Clearing both fields removes the entry.
    let cleared = s
        .put_json("/api/artist/Purple%20Motion", json!({ "aka": [], "groups": [] }))
        .await;
    assert_eq!(cleared.status(), 204);
    let m = s.get_json("/api/manifest").await;
    assert!(m["artists"].get("Purple Motion").is_none());
}

#[tokio::test]
#[ignore]
async fn album_lifecycle() {
    let s = Stack::start().await.unwrap();

    // Create with an explicit id + one song.
    let created: serde_json::Value = s
        .post_json(
            "/api/albums",
            json!({ "id": "Second Reality!", "title": "Second Reality",
                    "kind": "soundtrack", "songs": [MD5_A] }),
        )
        .await
        .json()
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(id, "second-reality"); // slugified

    // A colliding id is a 409.
    let dup = s
        .post_json("/api/albums", json!({ "id": "second-reality", "title": "x" }))
        .await;
    assert_eq!(dup.status(), 409);

    // Add a song, then a duplicate add is a no-op.
    assert_eq!(
        s.post_json(&format!("/api/albums/{id}/songs"), json!({ "md5": MD5_B }))
            .await
            .status(),
        204
    );
    assert_eq!(
        s.post_json(&format!("/api/albums/{id}/songs"), json!({ "md5": MD5_B.to_uppercase() }))
            .await
            .status(),
        204
    );
    let m = s.get_json("/api/manifest").await;
    assert_eq!(m["albums"][&id]["songs"], json!([MD5_A, MD5_B]));
    assert_eq!(m["albums"][&id]["kind"], "soundtrack");

    // Remove a song.
    assert_eq!(
        s.delete(&format!("/api/albums/{id}/songs/{MD5_A}")).await.status(),
        204
    );
    let m = s.get_json("/api/manifest").await;
    assert_eq!(m["albums"][&id]["songs"], json!([MD5_B]));

    // Patch the title (kind + songs left alone).
    assert_eq!(
        s.put_json(&format!("/api/albums/{id}"), json!({ "title": "Second Reality — OST" }))
            .await
            .status(),
        204
    );
    let m = s.get_json("/api/manifest").await;
    assert_eq!(m["albums"][&id]["title"], "Second Reality — OST");
    assert_eq!(m["albums"][&id]["songs"], json!([MD5_B]));

    // Editing / adding to a missing album is a 404.
    assert_eq!(s.put_json("/api/albums/nope", json!({ "title": "x" })).await.status(), 404);
    assert_eq!(
        s.post_json("/api/albums/nope/songs", json!({ "md5": MD5_A })).await.status(),
        404
    );

    // Delete.
    assert_eq!(s.delete(&format!("/api/albums/{id}")).await.status(), 204);
    assert_eq!(s.delete(&format!("/api/albums/{id}")).await.status(), 404);
}

#[tokio::test]
#[ignore]
async fn song_credit_and_reload() {
    let s = Stack::start().await.unwrap();

    // Set a credit.
    assert_eq!(
        s.put_json(
            &format!("/api/song/{MD5_A}"),
            json!({ "forGroup": "Future Crew", "with": ["Skaven"], "year": 1993 }),
        )
        .await
        .status(),
        204
    );
    let m = s.get_json("/api/manifest").await;
    assert_eq!(m["songs"][MD5_A]["forGroup"], "Future Crew");
    assert_eq!(m["songs"][MD5_A]["year"], 1993);

    // A bad md5 is a 400.
    assert_eq!(s.put_json("/api/song/notanmd5", json!({ "year": 2000 })).await.status(), 400);

    // Clearing every field removes the entry.
    assert_eq!(s.put_json(&format!("/api/song/{MD5_A}"), json!({})).await.status(), 204);
    let m = s.get_json("/api/manifest").await;
    assert!(m["songs"].get(MD5_A).is_none());

    // A hand-edit on disk is picked up by reload (no rescan).
    std::fs::write(
        s.root.join("library.json"),
        r#"{ "artists": { "Skaven": { "groups": ["Future Crew"] } } }"#,
    )
    .unwrap();
    assert_eq!(s.post_empty("/api/library/reload").await.status(), 204);
    let m = s.get_json("/api/manifest").await;
    assert_eq!(m["artists"]["Skaven"]["groups"], json!(["Future Crew"]));
}

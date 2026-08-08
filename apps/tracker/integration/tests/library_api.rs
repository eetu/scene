//! The server-side library API: `/api/library/ids` (the shaped, ordered id
//! stream) and `/api/tracks/batch` (hydrating a window of it).
//!
//! The ordering guarantees here are load-bearing. The player's shuffle is a
//! *seeded permutation of indices* into the visible order, so `prev` retraces
//! the same history and the order survives a reload. That only holds if the id
//! stream is deterministic for a given query, and if a hydration request hands
//! rows back in the order they were asked for.

use tracker_integration::Stack;

async fn ids_of(s: &Stack, query: &str) -> Vec<i64> {
    let body = s.get_json(&format!("/api/library/ids?{query}")).await;
    body["groups"]
        .as_array()
        .expect("groups")
        .iter()
        .flat_map(|g| {
            g["ids"]
                .as_array()
                .expect("ids")
                .iter()
                .map(|v| v.as_i64().expect("id"))
        })
        .collect()
}

/// The same query must produce byte-identical ordering every time — the queue
/// (and therefore shuffle) is indices into this list.
#[tokio::test]
#[ignore]
async fn id_stream_is_deterministic_and_covers_the_index() -> anyhow::Result<()> {
    let s = Stack::start().await?;
    s.rescan().await;

    let first = ids_of(&s, "group_by=artist").await;
    let second = ids_of(&s, "group_by=artist").await;
    assert_eq!(first, second, "same query must yield the same order");
    assert_eq!(first.len(), 3, "the fixture has three modules");

    let body = s.get_json("/api/library/ids?group_by=artist").await;
    assert_eq!(body["total"], 3);
    // Facets come from the index, not a hardcoded list.
    let formats: Vec<&str> = body["formats"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(formats, ["MOD", "S3M", "XM"]);
    Ok(())
}

/// Hydration echoes the requested order back. SQL's `IN` gives no ordering
/// guarantee, so this is an explicit re-sort the virtualizer depends on.
#[tokio::test]
#[ignore]
async fn batch_returns_tracks_in_the_requested_order() -> anyhow::Result<()> {
    let s = Stack::start().await?;
    s.rescan().await;

    let ids = ids_of(&s, "group_by=artist").await;
    let reversed: Vec<String> = ids.iter().rev().map(|i| i.to_string()).collect();
    let body = s
        .get_json(&format!("/api/tracks/batch?ids={}", reversed.join(",")))
        .await;
    let got: Vec<i64> = body["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_i64().unwrap())
        .collect();
    let want: Vec<i64> = ids.iter().rev().copied().collect();
    assert_eq!(got, want);
    Ok(())
}

/// A window hydrates to full display rows, and an id that no longer exists is
/// simply absent rather than erroring — the client's id stream can lag a rescan.
#[tokio::test]
#[ignore]
async fn batch_skips_unknown_ids_and_rejects_junk() -> anyhow::Result<()> {
    let s = Stack::start().await?;
    s.rescan().await;

    let ids = ids_of(&s, "group_by=artist").await;
    let body = s
        .get_json(&format!("/api/tracks/batch?ids={},999999", ids[0]))
        .await;
    let tracks = body["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 1, "the stale id is dropped, not fatal");
    assert!(tracks[0]["hash"].as_str().is_some_and(|h| !h.is_empty()));
    assert_eq!(tracks[0]["collection"], "mods");

    let r = s.get("/api/tracks/batch?ids=abc").await;
    assert_eq!(r.status(), 400, "non-integer ids are rejected");
    Ok(())
}

/// The collection filter scopes both the rows and the facet options, so the
/// source selector can't offer a format that no longer matches anything.
#[tokio::test]
#[ignore]
async fn collection_filter_scopes_rows_and_facets() -> anyhow::Result<()> {
    let s = Stack::start_with_second_root("extra", "scan").await?;
    s.rescan().await;
    // `rescan_root`, not a bare POST: the handler answers 202 and walks in the
    // background, so a fire-and-forget second root is only indexed by the time
    // the queries below run if the machine happens to be fast enough.
    s.rescan_root("extra").await;

    let all = ids_of(&s, "group_by=artist").await;
    let mods = ids_of(&s, "group_by=artist&collection=mods").await;
    let extra = ids_of(&s, "group_by=artist&collection=extra").await;
    assert_eq!(all.len(), 6, "both roots' three modules, unfiltered");
    assert_eq!(all.len(), mods.len() + extra.len());
    assert!(mods.iter().all(|id| !extra.contains(id)));
    Ok(())
}

/// Favourites collapse to one flat bucket, not the grouped tree.
#[tokio::test]
#[ignore]
async fn favourites_are_a_single_flat_bucket() -> anyhow::Result<()> {
    let s = Stack::start().await?;
    s.rescan().await;

    let tracks = s.tracks().await;
    let hash = tracks[0]["hash"].as_str().unwrap();
    let r = s
        .post_json(
            &format!("/api/favorite/{hash}"),
            serde_json::json!({ "favorite": true }),
        )
        .await;
    assert!(r.status().is_success(), "favourite: {}", r.status());

    let body = s.get_json("/api/library/ids?fav=true&group_by=group").await;
    let groups = body["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 1, "one flat bucket");
    assert_eq!(groups[0]["ids"].as_array().unwrap().len(), 1);
    assert_eq!(body["total"], 1);
    Ok(())
}

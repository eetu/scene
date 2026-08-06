//! SID as an indexed format, end to end through the real binary.
//!
//! The load-bearing claim is that **a subtune is a track**. A SID file holding
//! twelve tunes is twelve library entries, each separately favouritable and
//! counted — not one row that hides eleven of them. Everything downstream (the
//! shaped id stream, the play queue, shuffle) follows from that.

use serde_json::json;
use tracker_integration::{psid_bytes, Stack};

#[tokio::test]
#[ignore]
async fn a_sid_is_indexed_once_per_subtune() -> anyhow::Result<()> {
    let s = Stack::start().await?;
    std::fs::create_dir_all(s.root.join("Hubbard_Rob"))?;
    std::fs::write(
        s.root.join("Hubbard_Rob/Commando.sid"),
        psid_bytes(3, "Commando", "Rob Hubbard"),
    )?;
    // A single-tune SID must still be exactly one row — no "Tune 1/1" noise.
    std::fs::write(
        s.root.join("Hubbard_Rob/Monty.sid"),
        psid_bytes(1, "Monty on the Run", "Rob Hubbard"),
    )?;
    s.rescan().await;

    let body = s.get_json("/api/library/ids?group_by=artist").await;
    let ids: Vec<i64> = body["groups"]
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
    // 3 fixture modules + 3 Commando subtunes + 1 Monty.
    assert_eq!(ids.len(), 7, "one entry per subtune, not per file");

    let hydrated = s
        .get_json(&format!(
            "/api/tracks/batch?ids={}",
            ids.iter()
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
    let subs: Vec<i64> = commando
        .iter()
        .map(|t| t["subsong"].as_i64().unwrap())
        .collect();
    assert_eq!(subs, vec![0, 1, 2], "subtunes in order");
    for t in &commando {
        assert_eq!(t["subsongs"], 3);
        assert_eq!(t["title"], "Commando");
        // Parsed from the header in Rust — no browser decoder involved.
        assert_eq!(t["type_long"], "PSID v2");
        assert_eq!(t["tracker"], "PAL MOS6581");
        assert_eq!(t["channels"], 3, "three voices per SID chip");
    }
    // Each subtune is a distinct playable id.
    let uniq: std::collections::HashSet<_> = commando.iter().map(|t| &t["id"]).collect();
    assert_eq!(uniq.len(), 3);

    let monty: Vec<_> = tracks
        .iter()
        .filter(|t| t["filename"] == "Monty.sid")
        .collect();
    assert_eq!(monty.len(), 1);
    assert_eq!(monty[0]["subsongs"], 1);
    Ok(())
}

/// A SID header carries no duration, so a scanned SID's length is unknown until
/// someone establishes it. The listing must say so rather than inventing one,
/// and the fallback used for *playback* is reported separately.
#[tokio::test]
#[ignore]
async fn song_length_is_unknown_until_set_then_per_subtune() -> anyhow::Result<()> {
    let s = Stack::start().await?;
    std::fs::create_dir_all(s.root.join("Galway_Martin"))?;
    std::fs::write(
        s.root.join("Galway_Martin/Rambo.sid"),
        psid_bytes(2, "Rambo", "Martin Galway"),
    )?;
    s.rescan().await;

    // The playback fallback is config, not data — it never lands in `duration`.
    let status = s.get_json("/status").await;
    assert_eq!(status["sid_default_length"], 180);

    let hash = {
        let all = s.tracks().await;
        all.iter().find(|t| t["filename"] == "Rambo.sid").unwrap()["hash"]
            .as_str()
            .unwrap()
            .to_string()
    };
    async fn fetch(s: &Stack) -> serde_json::Value {
        let body = s.get_json("/api/library/ids?group_by=artist").await;
        let ids: Vec<String> = body["groups"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| {
                g["ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_i64().unwrap().to_string())
            })
            .collect();
        s.get_json(&format!("/api/tracks/batch?ids={}", ids.join(",")))
            .await
    }

    let before = fetch(&s).await;
    for t in before["tracks"].as_array().unwrap() {
        if t["filename"] == "Rambo.sid" {
            assert!(
                t["duration"].is_null(),
                "no length is claimed for a raw SID"
            );
        }
    }

    // Establish subtune 1's length by listening; subtune 0 stays unknown.
    let r = s
        .post_json(
            &format!("/api/song-length/{hash}"),
            json!({ "subsong": 1, "duration": 97.5 }),
        )
        .await;
    assert!(r.status().is_success(), "set length: {}", r.status());

    let after = fetch(&s).await;
    for t in after["tracks"].as_array().unwrap() {
        if t["filename"] != "Rambo.sid" {
            continue;
        }
        match t["subsong"].as_i64().unwrap() {
            1 => assert_eq!(t["duration"], 97.5),
            _ => assert!(
                t["duration"].is_null(),
                "only the tune we set gets a length"
            ),
        }
    }

    // Clearing it forgets the override rather than storing 0.
    let r = s
        .post_json(
            &format!("/api/song-length/{hash}"),
            json!({ "subsong": 1, "duration": null }),
        )
        .await;
    assert!(r.status().is_success());
    let cleared = fetch(&s).await;
    for t in cleared["tracks"].as_array().unwrap() {
        if t["filename"] == "Rambo.sid" {
            assert!(t["duration"].is_null());
        }
    }

    // Nonsense is refused rather than stored.
    for bad in [
        json!({"subsong": 0, "duration": -5}),
        json!({"subsong": 999}),
    ] {
        let r = s.post_json(&format!("/api/song-length/{hash}"), bad).await;
        assert_eq!(r.status(), 400);
    }
    Ok(())
}

/// The C64 ROMs are copyrighted and operator-supplied, so the SID decoder
/// fetches them at runtime. The route serves a fixed allowlist by filename
/// prefix (any KERNAL revision works) and — the part that matters — refuses a
/// file of the wrong size, which would otherwise be accepted and produce a
/// subtly broken emulation instead of an error.
#[tokio::test]
#[ignore]
async fn roms_are_served_by_role_and_size_checked() -> anyhow::Result<()> {
    let dir = tempfile::tempdir()?;
    std::fs::write(dir.path().join("kernal-901227-03.bin"), vec![0u8; 8192])?;
    std::fs::write(dir.path().join("basic-901226-01.bin"), vec![0u8; 8192])?;
    // Deliberately truncated: a real dump is 4096.
    std::fs::write(dir.path().join("chargen-901225-01.bin"), vec![0u8; 100])?;
    let s = Stack::start_with_env(&[("TRACKER_ROMS_DIR", dir.path().to_str().unwrap())]).await?;

    for (role, len) in [("kernal", 8192), ("basic", 8192)] {
        let r = s.get(&format!("/api/roms/{role}")).await;
        assert!(r.status().is_success(), "{role}: {}", r.status());
        assert_eq!(r.bytes().await?.len(), len, "{role} served whole");
    }
    // Wrong size → not served, rather than served and silently wrong.
    assert_eq!(s.get("/api/roms/chargen").await.status(), 404);
    // Only the three roles exist; nothing from the request reaches the filesystem.
    for bad in ["kernal.bin", "..%2F..%2Fetc%2Fpasswd", "evil"] {
        assert_eq!(
            s.get(&format!("/api/roms/{bad}")).await.status(),
            404,
            "{bad}"
        );
    }
    Ok(())
}

/// With no ROM dir configured the route is simply absent — the engine falls back
/// to built-in images, which is degraded but working, not broken.
#[tokio::test]
#[ignore]
async fn roms_are_absent_when_unconfigured() -> anyhow::Result<()> {
    let s = Stack::start().await?;
    assert_eq!(s.get("/api/roms/kernal").await.status(), 404);
    Ok(())
}

/// A favourite on one subtune must not favourite the other eleven — that's the
/// whole reason `stats` gained a composite key.
#[tokio::test]
#[ignore]
async fn favourites_and_play_counts_are_per_subtune() -> anyhow::Result<()> {
    let s = Stack::start().await?;
    std::fs::create_dir_all(s.root.join("Galway_Martin"))?;
    std::fs::write(
        s.root.join("Galway_Martin/Wizball.sid"),
        psid_bytes(4, "Wizball", "Martin Galway"),
    )?;
    s.rescan().await;

    let hash = {
        let all = s.tracks().await;
        all.iter().find(|t| t["filename"] == "Wizball.sid").unwrap()["hash"]
            .as_str()
            .unwrap()
            .to_string()
    };

    // Favourite subtune 2 and play it twice.
    let r = s
        .post_json(
            &format!("/api/favorite/{hash}"),
            json!({ "favorite": true, "subsong": 2 }),
        )
        .await;
    assert!(r.status().is_success());
    for _ in 0..2 {
        let r = s.post_empty(&format!("/api/play/{hash}?subsong=2")).await;
        assert!(r.status().is_success());
    }

    let body = s.get_json("/api/library/ids?group_by=artist").await;
    let ids: Vec<i64> = body["groups"]
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
    let hydrated = s
        .get_json(&format!(
            "/api/tracks/batch?ids={}",
            ids.iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>()
                .join(",")
        ))
        .await;
    let wiz: Vec<_> = hydrated["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["filename"] == "Wizball.sid")
        .collect();
    assert_eq!(wiz.len(), 4);
    for t in &wiz {
        let sub = t["subsong"].as_i64().unwrap();
        let fav = t["favorite"].as_bool().unwrap();
        let plays = t["play_count"].as_i64().unwrap();
        if sub == 2 {
            assert!(fav, "subtune 2 is favourited");
            assert_eq!(plays, 2);
        } else {
            assert!(!fav, "subtune {sub} must not inherit the favourite");
            assert_eq!(plays, 0, "nor the play count");
        }
    }

    // The favourites view therefore holds exactly one entry.
    let favs = s.get_json("/api/library/ids?fav=true&group_by=group").await;
    assert_eq!(favs["total"], 1);
    Ok(())
}

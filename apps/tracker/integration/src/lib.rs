//! Integration harness: spawns the real `tracker-backend` binary with
//! `DEV_AUTH=1` against a temp collection root + temp SQLite + stub dist/,
//! polls `/status` until up, and exposes a `reqwest` client. The child is
//! killed on `Drop`.
//!
//! Tests are `#[ignore]` (they spawn a process + bind a port); run them with
//! `cargo test -p tracker-e2e -- --ignored`.

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;

use tempfile::TempDir;

pub struct Stack {
    child: Child,
    pub base: String,
    pub client: reqwest::Client,
    /// The collection root the backend scans — tests create/move files here.
    pub root: PathBuf,
    /// The second root, when started via [`Stack::start_with_second_root`].
    pub root2: Option<PathBuf>,
    _root_tmp: TempDir,
    _root2_tmp: Option<TempDir>,
    _data_tmp: TempDir,
    _static_tmp: TempDir,
}

impl Stack {
    pub async fn start() -> anyhow::Result<Self> {
        Self::start_with_env(&[]).await
    }

    /// Like [`Stack::start`] but with extra environment variables (e.g. pointing
    /// the Mod Archive client at a stub via `MODARCHIVE_WEB_BASE`/`_DL_BASE`).
    pub async fn start_with_env(extra: &[(&str, &str)]) -> anyhow::Result<Self> {
        Self::start_inner(extra, None).await
    }

    /// Start with two configured roots: the usual `mods` fixture plus a second
    /// one of `kind`, seeded with the same relative paths so the tests can prove
    /// identity is `(root, rel_path)` and not `rel_path` alone.
    pub async fn start_with_second_root(id: &str, kind: &str) -> anyhow::Result<Self> {
        Self::start_inner(&[], Some((id.to_string(), kind.to_string()))).await
    }

    async fn start_inner(
        extra: &[(&str, &str)],
        second: Option<(String, String)>,
    ) -> anyhow::Result<Self> {
        let root_tmp = tempfile::tempdir()?;
        let root = root_tmp.path().to_path_buf();
        seed_fixture(&root)?;

        let (root2_tmp, root2) = match &second {
            Some(_) => {
                let t = tempfile::tempdir()?;
                let p = t.path().to_path_buf();
                seed_fixture(&p)?;
                // Same rel_path, different bytes — proves the two rows are distinct.
                std::fs::write(p.join("Coder/song.mod"), b"second-root-mod-zzz")?;
                (Some(t), Some(p))
            }
            None => (None, None),
        };

        let data_tmp = tempfile::tempdir()?;
        let db_path = data_tmp.path().join("tracker.db");

        let static_tmp = tempfile::tempdir()?;
        std::fs::write(
            static_tmp.path().join("index.html"),
            "<html><body>tracker</body></html>",
        )?;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;

        // Spawn, and retry on a lost port race.
        //
        // `free_port` binds :0, reads the port and drops the listener, so the
        // port is only *probably* still free when the child gets to it. The
        // suite runs a couple of dozen backends across its test binaries
        // concurrently, so two occasionally pick the same one: the loser can't
        // bind, exits immediately, and every later assertion in that test fails
        // for reasons that look nothing like the cause. (Diagnosed the hard way
        // — it presented as "startup is slow under load", and raising the wait
        // just made the failure take longer.)
        //
        // So: notice the child is gone rather than polling a corpse, and try
        // again on a fresh port.
        let mut child = None;
        let mut base = String::new();
        let mut last_err = String::new();
        for attempt in 0..5 {
            let port = free_port()?;
            base = format!("http://127.0.0.1:{port}");

            let mut cmd = Command::new(bin_path());
            cmd.env("DEV_AUTH", "1")
                .env("TRACKER_BIND", format!("127.0.0.1:{port}"))
                .env("TRACKER_ROOT", &root)
                .env("TRACKER_DB_PATH", &db_path)
                .env("STATIC_DIR", static_tmp.path())
                .env("RUST_LOG", "warn");
            if let (Some((id, kind)), Some(p2)) = (&second, &root2) {
                cmd.env(
                    "TRACKER_ROOTS",
                    format!("mods:scan:{},{id}:{kind}:{}", root.display(), p2.display()),
                );
            }
            for (k, v) in extra {
                cmd.env(k, v);
            }
            let mut c = cmd.spawn()?;

            // 30s of headroom for a genuinely slow start; a dead child is caught
            // within ~100ms of dying, so the budget only ever costs time when
            // the process is alive and busy.
            let mut up = false;
            for _ in 0..300 {
                if let Ok(Some(status)) = c.try_wait() {
                    last_err = format!("backend exited early ({status}) on port {port}");
                    break;
                }
                if let Ok(r) = client.get(format!("{base}/status")).send().await {
                    if r.status().is_success() {
                        up = true;
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if up {
                child = Some(c);
                break;
            }
            let _ = c.kill();
            let _ = c.wait();
            if last_err.is_empty() {
                // Alive but not answering: retrying on another port won't help.
                last_err = format!("backend did not answer /status within 30s (attempt {attempt})");
                break;
            }
            last_err.clear(); // it died — try another port
        }
        let (child, up) = match child {
            Some(c) => (c, true),
            // Keep the struct construction below intact so the tempdirs are
            // still owned (and cleaned up) when we bail.
            None => (Command::new("true").spawn()?, false),
        };
        let stack = Stack {
            child,
            base,
            client,
            root,
            root2,
            _root_tmp: root_tmp,
            _root2_tmp: root2_tmp,
            _data_tmp: data_tmp,
            _static_tmp: static_tmp,
        };
        if !up {
            anyhow::bail!("backend never came up: {last_err}");
        }
        Ok(stack)
    }

    pub async fn get(&self, route: &str) -> reqwest::Response {
        self.client
            .get(format!("{}{route}", self.base))
            .send()
            .await
            .expect("request failed")
    }

    pub async fn post_empty(&self, route: &str) -> reqwest::Response {
        self.client
            .post(format!("{}{route}", self.base))
            .send()
            .await
            .expect("request failed")
    }

    pub async fn post_json(&self, route: &str, body: serde_json::Value) -> reqwest::Response {
        self.client
            .post(format!("{}{route}", self.base))
            .json(&body)
            .send()
            .await
            .expect("request failed")
    }

    pub async fn put_json(&self, route: &str, body: serde_json::Value) -> reqwest::Response {
        self.client
            .put(format!("{}{route}", self.base))
            .json(&body)
            .send()
            .await
            .expect("request failed")
    }

    pub async fn delete(&self, route: &str) -> reqwest::Response {
        self.client
            .delete(format!("{}{route}", self.base))
            .send()
            .await
            .expect("request failed")
    }

    pub async fn get_json(&self, route: &str) -> serde_json::Value {
        let r = self.get(route).await;
        assert!(r.status().is_success(), "GET {route} → {}", r.status());
        r.json().await.expect("json")
    }

    /// Run a synchronous rescan and return it once the index is up to date.
    /// Start a scan of the primary root and wait for it to finish, returning
    /// what it did (`/status.last_scan`).
    ///
    /// `POST /api/rescan` answers `202` and walks in the background, so for a
    /// test "rescan" means start-and-await. There's no race with the poll: the
    /// handler claims the `scanning` flag before it answers, so this can never
    /// observe "not scanning" and return before the work has begun.
    pub async fn rescan(&self) -> serde_json::Value {
        self.rescan_root("").await
    }

    /// As [`Self::rescan`], for one named root. An empty id targets the primary.
    pub async fn rescan_root(&self, root: &str) -> serde_json::Value {
        let path = if root.is_empty() {
            "/api/rescan".to_string()
        } else {
            format!("/api/rescan/{root}")
        };
        let r = self.post_empty(&path).await;
        assert_eq!(
            r.status(),
            reqwest::StatusCode::ACCEPTED,
            "rescan should be accepted, got {}",
            r.status()
        );
        self.await_scan().await
    }

    /// Wait for any running scan to finish, and return what it did. Separate
    /// from starting one, so a test can start a scan, observe the server while
    /// it runs, and then wait — without a second POST being refused by the
    /// one-at-a-time guard.
    pub async fn await_scan(&self) -> serde_json::Value {
        for _ in 0..600 {
            let s = self.get_json("/status").await;
            if s["scanning"] == false {
                return s["last_scan"].clone();
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("scan did not finish within 30s");
    }

    /// Add `n` throwaway modules to the primary root, so a scan takes long
    /// enough to be observed mid-flight. The three-file fixture finishes faster
    /// than a request round-trip, which makes any "while it runs" assertion a
    /// coin toss.
    pub fn seed_bulk(&self, n: usize) {
        let dir = self.root.join("Bulk");
        std::fs::create_dir_all(&dir).expect("bulk dir");
        for i in 0..n {
            std::fs::write(dir.join(format!("t{i:05}.mod")), format!("bulk-{i}")).expect("bulk");
        }
    }

    pub async fn tracks(&self) -> Vec<serde_json::Value> {
        let r = self.get("/api/tracks").await;
        assert!(r.status().is_success());
        let body: serde_json::Value = r.json().await.expect("tracks json");
        body["tracks"].as_array().cloned().unwrap_or_default()
    }
}

impl Drop for Stack {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Artist-primary `artist/song.ext` fixtures across formats, plus a root-level
/// module (no artist dir → artist `None`) and macOS junk that must be skipped.
/// A minimal but structurally real PSID v2 header with `songs` subtunes.
/// Enough for the scanner to parse and index it; it is not playable audio.
pub fn psid_bytes(songs: u16, name: &str, author: &str) -> Vec<u8> {
    let mut b = vec![0u8; 0x7C];
    b[0..4].copy_from_slice(b"PSID");
    b[4..6].copy_from_slice(&2u16.to_be_bytes());
    b[6..8].copy_from_slice(&0x7C_u16.to_be_bytes());
    b[0x0E..0x10].copy_from_slice(&songs.to_be_bytes());
    b[0x10..0x12].copy_from_slice(&1u16.to_be_bytes());
    b[0x16..0x16 + name.len()].copy_from_slice(name.as_bytes());
    b[0x36..0x36 + author.len()].copy_from_slice(author.as_bytes());
    // PAL + MOS6581
    b[0x76..0x78].copy_from_slice(&((0b01u16 << 2) | (0b01u16 << 4)).to_be_bytes());
    b
}

fn seed_fixture(root: &std::path::Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(root.join("Coder"))?;
    std::fs::write(root.join("Coder/song.mod"), b"fixture-mod-aaa")?;
    std::fs::write(root.join("Coder/tune.xm"), b"fixture-xm-bbb")?;
    std::fs::write(root.join("intro.s3m"), b"fixture-s3m-ccc")?;
    // macOS junk that must be skipped.
    std::fs::write(root.join("Coder/._song.mod"), b"junk")?;
    std::fs::write(root.join(".DS_Store"), b"junk")?;
    std::fs::write(root.join("readme.txt"), b"not a module")?;
    Ok(())
}

fn free_port() -> anyhow::Result<u16> {
    let l = TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

fn bin_path() -> PathBuf {
    let mut p = std::env::current_exe().expect("current_exe");
    p.pop();
    if p.ends_with("deps") {
        p.pop();
    }
    p.join("tracker-backend")
}

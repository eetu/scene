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
    _root_tmp: TempDir,
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
        let root_tmp = tempfile::tempdir()?;
        let root = root_tmp.path().to_path_buf();
        seed_fixture(&root)?;

        let data_tmp = tempfile::tempdir()?;
        let db_path = data_tmp.path().join("tracker.db");

        let static_tmp = tempfile::tempdir()?;
        std::fs::write(
            static_tmp.path().join("index.html"),
            "<html><body>tracker</body></html>",
        )?;

        let port = free_port()?;
        let base = format!("http://127.0.0.1:{port}");

        let mut cmd = Command::new(bin_path());
        cmd.env("DEV_AUTH", "1")
            .env("TRACKER_BIND", format!("127.0.0.1:{port}"))
            .env("TRACKER_ROOT", &root)
            .env("TRACKER_DB_PATH", &db_path)
            .env("STATIC_DIR", static_tmp.path())
            .env("RUST_LOG", "warn");
        for (k, v) in extra {
            cmd.env(k, v);
        }
        let child = cmd.spawn()?;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;

        // Generous: the suite spawns several backends in parallel, so process
        // startup can lag under load. /status never touches the DB, so a slow
        // response means the process isn't up yet, not that it's busy scanning.
        let mut up = false;
        for _ in 0..200 {
            if let Ok(r) = client.get(format!("{base}/status")).send().await {
                if r.status().is_success() {
                    up = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let stack = Stack {
            child,
            base,
            client,
            root,
            _root_tmp: root_tmp,
            _data_tmp: data_tmp,
            _static_tmp: static_tmp,
        };
        if !up {
            anyhow::bail!("backend did not come up within 20s");
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
    pub async fn rescan(&self) -> serde_json::Value {
        let r = self.post_empty("/api/rescan").await;
        assert!(r.status().is_success(), "rescan failed: {}", r.status());
        r.json().await.expect("rescan json")
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

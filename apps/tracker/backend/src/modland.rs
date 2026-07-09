//! Minimal Modland client — the by-path downloader behind a playlist's
//! "fetch missing" action.
//!
//! Modland (https://modland.com) organises modules as `pub/modules/Format/
//! Author/.../file`, so an author + filename come straight from a path. Modland
//! is path-addressed (its bulk `allmods.txt` lists size+path, *not* md5), so a
//! playlist's missing items carry the Modland `path` to fetch by; md5 is computed
//! on arrival and becomes the local-library key.
//!
//! Curation lives outside tracker: external tooling produces import documents
//! (md5 where known + a Modland path); this module only downloads what's missing.

use anyhow::Context;

const USER_AGENT: &str = concat!(
    "scene-tracker/",
    env!("CARGO_PKG_VERSION"),
    " (+homebrew demoscene archive player)"
);

pub struct Client {
    http: reqwest::Client,
    base: String,
}

impl Client {
    pub fn new(base: String) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .context("build http client")?;
        Ok(Self { http, base })
    }

    /// Download a module by its **raw** `pub/modules/` path (as it appears in a
    /// Modland listing). The path is percent-encoded here (paths contain spaces).
    pub async fn download_path(&self, raw_path: &str) -> anyhow::Result<Vec<u8>> {
        let url = format!("{}/pub/modules/{}", self.base, encode_path(raw_path));
        self.download_url(&url).await
    }

    /// Download from an absolute URL (the generic by-`url` fetch fallback for
    /// sources Modland doesn't carry — e.g. a Mod Archive `downloads.php` link).
    /// The caller supplies the URL verbatim; we stay agnostic about the service.
    pub async fn download_url(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        let bytes = self
            .http
            .get(url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?
            .error_for_status()?
            .bytes()
            .await?;
        Ok(bytes.to_vec())
    }
}

/// A folder name derived from a URL's host (scheme + leading `api.`/`www.`
/// stripped) — where a by-`url` download lands when its item carries no artist.
pub fn host_group(url: &str) -> Option<String> {
    let after = url.split("://").nth(1).unwrap_or(url);
    let host = after.split('/').next().unwrap_or(after);
    let host = host.strip_prefix("api.").unwrap_or(host);
    let host = host.strip_prefix("www.").unwrap_or(host);
    let host = host.trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// Author = the second path segment of a Modland path (`Format/Author/.../file`).
/// `None` for a path too shallow to carry one. Maps to the library **artist**.
pub fn author_from_path(path: &str) -> Option<String> {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() >= 3 {
        Some(segs[1].to_string())
    } else {
        None
    }
}

/// Format = the first path segment of a Modland path (e.g. `Fasttracker 2`).
/// Maps to the library **group** so a fetched module lands at the convention's
/// `group/artist/file` — not `author/file` (which would file the author *as* a
/// group). `None` for an empty path.
pub fn format_from_path(path: &str) -> Option<String> {
    path.split('/').find(|s| !s.is_empty()).map(str::to_string)
}

const HEX: &[u8; 16] = b"0123456789ABCDEF";

/// Percent-encode a raw path for a URL, keeping `/` and the unreserved set.
fn encode_path(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0xf) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn author_from_modland_path() {
        assert_eq!(
            author_from_path("Protracker/4-Mat/intro.mod").as_deref(),
            Some("4-Mat")
        );
        assert_eq!(
            author_from_path("Fasttracker 2/Purple Motion/sundance.xm").as_deref(),
            Some("Purple Motion")
        );
        assert_eq!(author_from_path("Protracker/song.mod"), None); // no author segment
    }

    #[test]
    fn path_encoding() {
        assert_eq!(
            encode_path("Protracker/Jogeir Liljedahl/guitar slinger.mod"),
            "Protracker/Jogeir%20Liljedahl/guitar%20slinger.mod"
        );
        assert_eq!(encode_path("plain/a.mod"), "plain/a.mod");
    }
}

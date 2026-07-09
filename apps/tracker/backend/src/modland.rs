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

use std::net::{IpAddr, Ipv4Addr};

use anyhow::Context;

const USER_AGENT: &str = concat!(
    "scene-tracker/",
    env!("CARGO_PKG_VERSION"),
    " (+homebrew demoscene archive player)"
);

/// Cap on a single download's body. Modules are small (a big multichannel IT/XM
/// is a few MB); this stops a malicious/oversized item from buffering an
/// unbounded body into memory and OOM-ing the process.
const MAX_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;

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
    /// The base is operator config (`MODLAND_BASE`), so this trusts the host and
    /// only applies the size cap.
    pub async fn download_path(&self, raw_path: &str) -> anyhow::Result<Vec<u8>> {
        let url = format!("{}/pub/modules/{}", self.base, encode_path(raw_path));
        self.get_capped(&url).await
    }

    /// Download from an absolute URL supplied by an import document (the generic
    /// fallback for sources Modland doesn't carry — e.g. a Mod Archive link).
    /// Unlike the Modland base this URL is **untrusted**, so guard against SSRF:
    /// resolve the host and refuse any non-public address (loopback/private/
    /// link-local/metadata) before fetching, then cap the body.
    pub async fn download_url(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        ensure_public_url(url).await?;
        self.get_capped(url).await
    }

    /// Shared fetch with a streamed size cap — never buffer more than
    /// [`MAX_DOWNLOAD_BYTES`], rejecting early on a declared Content-Length too.
    async fn get_capped(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        let mut resp = self
            .http
            .get(url)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?
            .error_for_status()?;
        if let Some(len) = resp.content_length() {
            anyhow::ensure!(
                len as usize <= MAX_DOWNLOAD_BYTES,
                "download too large: {len} bytes (cap {MAX_DOWNLOAD_BYTES})"
            );
        }
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await? {
            anyhow::ensure!(
                buf.len() + chunk.len() <= MAX_DOWNLOAD_BYTES,
                "download exceeded the {MAX_DOWNLOAD_BYTES}-byte cap"
            );
            buf.extend_from_slice(&chunk);
        }
        Ok(buf)
    }
}

/// SSRF guard for an untrusted download URL: http/https only, and every address
/// the host resolves to must be public. Resolving up-front (rather than trusting
/// the hostname) blocks a name that points at a private/loopback/metadata IP.
/// (A DNS-rebind between this check and reqwest's own resolution is a residual
/// TOCTOU window; the host is also egress-restricted at the network layer.)
async fn ensure_public_url(url: &str) -> anyhow::Result<()> {
    let parsed = reqwest::Url::parse(url).with_context(|| format!("parse url {url}"))?;
    anyhow::ensure!(
        matches!(parsed.scheme(), "http" | "https"),
        "unsupported url scheme"
    );
    let host = parsed.host_str().context("url has no host")?;
    let port = parsed.port_or_known_default().unwrap_or(80);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .with_context(|| format!("resolve {host}"))?
        .collect();
    anyhow::ensure!(!addrs.is_empty(), "host {host} did not resolve");
    if let Some(bad) = addrs.iter().find(|a| !is_public_ip(a.ip())) {
        anyhow::bail!("refusing to fetch a non-public address ({})", bad.ip());
    }
    Ok(())
}

/// Is `ip` a routable public address (i.e. NOT loopback/private/link-local/
/// CGNAT/unique-local/etc.)? Conservative — anything not clearly public is
/// treated as blocked. (`IpAddr::is_global` is still unstable, hence this.)
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public_v4(v4),
            None => {
                let s0 = v6.segments()[0];
                !(v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    || (s0 & 0xfe00) == 0xfc00  // unique local  fc00::/7
                    || (s0 & 0xffc0) == 0xfe80) // link-local    fe80::/10
            }
        },
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || (a == 100 && (b & 0xc0) == 0x40)) // CGNAT / shared 100.64.0.0/10
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
        assert_eq!(author_from_path("Protracker/4-Mat/intro.mod").as_deref(), Some("4-Mat"));
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

    #[test]
    fn public_vs_private_ips() {
        let pub_ = |s: &str| is_public_ip(s.parse().unwrap());
        // Public.
        assert!(pub_("1.1.1.1"));
        assert!(pub_("93.184.216.34"));
        assert!(pub_("2606:4700:4700::1111"));
        // Blocked ranges the SSRF guard must reject.
        assert!(!pub_("127.0.0.1")); // loopback
        assert!(!pub_("10.0.0.5")); // private
        assert!(!pub_("192.168.1.1")); // private
        assert!(!pub_("172.16.0.1")); // private
        assert!(!pub_("169.254.169.254")); // link-local / cloud metadata
        assert!(!pub_("100.64.0.1")); // CGNAT
        assert!(!pub_("0.0.0.0")); // unspecified
        assert!(!pub_("::1")); // v6 loopback
        assert!(!pub_("fc00::1")); // v6 unique-local
        assert!(!pub_("fe80::1")); // v6 link-local
        assert!(!pub_("::ffff:127.0.0.1")); // v4-mapped loopback
    }

    #[tokio::test]
    async fn ssrf_guard_rejects_local_and_bad_schemes() {
        // Loopback literal (resolves offline) → refused.
        assert!(ensure_public_url("http://127.0.0.1:8080/x").await.is_err());
        assert!(ensure_public_url("http://[::1]/x").await.is_err());
        // Non-http scheme → refused before any resolution.
        assert!(ensure_public_url("file:///etc/passwd").await.is_err());
        assert!(ensure_public_url("gopher://example.com/").await.is_err());
    }
}

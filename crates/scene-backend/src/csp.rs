//! Content-Security-Policy shared between the app backends. Same-origin plus
//! the Google Fonts hosts halo-design uses; `'wasm-unsafe-eval'` for the
//! libopenmpt AudioWorklet and `'unsafe-eval'` because both apps run
//! Emscripten/Embind code that builds invokers with the `Function` constructor
//! (tracker: libsidplayfp; party: the emulator cores) — `'wasm-unsafe-eval'`
//! covers wasm compilation only. The app-specific *why* lives at each call
//! site. HSTS / X-Frame-Options / X-Content-Type-Options are the edge's job.

/// Build the CSP header value. `emulator_blobs` adds what EmulatorJS/js-dos
/// need on top (party): cores decompressed to and run from `blob:` URLs, so
/// `blob:` joins `script-src`/`connect-src` and `media-src` is allowed.
pub fn build_csp(script_hashes: &[String], emulator_blobs: bool) -> String {
    let blob = if emulator_blobs { " blob:" } else { "" };
    let mut script_src = format!("'self' 'wasm-unsafe-eval' 'unsafe-eval'{blob}");
    for h in script_hashes {
        script_src.push(' ');
        script_src.push_str(h);
    }
    let media = if emulator_blobs {
        "media-src 'self' blob:; "
    } else {
        ""
    };
    format!(
        "default-src 'self'; \
         script-src {script_src}; \
         style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; \
         font-src 'self' data: https://fonts.gstatic.com; \
         img-src 'self' data: blob:; \
         {media}connect-src 'self'{blob}; \
         worker-src 'self' blob:; \
         child-src 'self' blob:; \
         frame-ancestors 'none'; \
         base-uri 'self'; \
         object-src 'none'; \
         form-action 'self'"
    )
}

/// CSP `'sha256-…'` source for every inline `<script>` (no `src=`) in `html`.
pub fn inline_script_hashes(html: &str) -> Vec<String> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    let mut out = Vec::new();
    let mut idx = 0;
    while let Some(rel) = html[idx..].find("<script") {
        let tag = idx + rel;
        let Some(gt) = html[tag..].find('>') else {
            break;
        };
        let open = &html[tag..tag + gt + 1];
        let body_start = tag + gt + 1;
        let Some(close) = html[body_start..].find("</script>") else {
            break;
        };
        let body = &html[body_start..body_start + close];
        if !open.contains("src=") {
            let digest = Sha256::digest(body.as_bytes());
            out.push(format!("'sha256-{}'", STANDARD.encode(digest)));
        }
        idx = body_start + close + "</script>".len();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_inline_scripts_skips_external() {
        let html = r#"<script src="/app.js"></script><script>abc</script>"#;
        assert_eq!(
            inline_script_hashes(html),
            vec!["'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='"]
        );
    }

    #[test]
    fn csp_allows_wasm_and_workers() {
        let csp = build_csp(&["'sha256-X'".into()], false);
        assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' 'sha256-X'"));
        assert!(csp.contains("worker-src 'self' blob:"));
        assert!(!csp.contains("media-src"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
    }

    #[test]
    fn csp_emulator_blobs_extends_script_connect_media() {
        let csp = build_csp(&["'sha256-X'".into()], true);
        assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob: 'sha256-X'"));
        assert!(csp.contains("media-src 'self' blob:"));
        assert!(csp.contains("connect-src 'self' blob:"));
    }

    /// `'unsafe-eval'` looks like something to tighten, and tightening it breaks
    /// SID playback (tracker) and the emulators (party) with an error that names
    /// the CSP but not the cause — and no e2e catches it, because those suites
    /// run against `vite preview`, which sends no CSP. Embind builds its
    /// invokers with the `Function` constructor; `'wasm-unsafe-eval'` does not
    /// cover string evaluation.
    #[test]
    fn csp_keeps_unsafe_eval_for_embind() {
        for emulator_blobs in [false, true] {
            let csp = build_csp(&[], emulator_blobs);
            assert!(
                csp.contains("'unsafe-eval'"),
                "removing this silently disables SID/emulator playback: {csp}"
            );
        }
    }
}

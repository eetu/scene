//! Shared plumbing for the scene app backends (tracker, party): the error
//! type, edge-trust auth extractor, CSP builder, SPA fallback and scanner
//! utilities. App-specific behaviour stays in the apps; this crate only holds
//! what was byte-identical between them.

pub mod auth;
pub mod csp;
pub mod error;
pub mod scan;
pub mod spa;

/// `word` with its first character upper-cased (display labels from slugs).
pub fn capitalize_first(word: &str) -> String {
    let mut c = word.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

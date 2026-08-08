use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Module extensions libopenmpt can open. Generous on purpose — the collections
/// have obscure legacy formats; unknown extensions are simply skipped. Lowercase.
pub const MODULE_EXTS: &[&str] = &[
    "mod", "xm", "s3m", "it", "mptm", "stm", "nst", "m15", "stk", "wow", "ult", "669", "mtm",
    "med", "far", "amf", "ams", "dbm", "digi", "dmf", "dsm", "dtm", "fmt", "imf", "j2b", "mdl",
    "mo3", "mt2", "okt", "okta", "plm", "psm", "pt36", "ptm", "sfx", "sfx2", "st26", "stp", "umx",
    "gdm", "gmc", "ice", "itp", "mms", "oct", "tcb", "ftm", "rtm", "c67", "symmod",
];

/// macOS filesystem junk (Finder/Spotlight droppings on SMB shares).
pub fn is_macos_junk(name: &str) -> bool {
    name == ".DS_Store"
        || name.starts_with("._")
        || name == ".Trashes"
        || name == ".Spotlight-V100"
        || name == ".AppleDouble"
        || name == ".fseventsd"
        || name == ".DocumentRevisions-V100"
        || name == ".TemporaryItems"
}

/// Sets a `scanning` flag on creation and resets it when dropped, so a scan
/// always clears it regardless of how it ends. Lives inside the
/// (non-cancellable) blocking task. The app's progress struct exposes the flag
/// via `AsRef<AtomicBool>`.
pub struct ScanFlagGuard<T: AsRef<AtomicBool>>(Arc<T>);

impl<T: AsRef<AtomicBool>> ScanFlagGuard<T> {
    pub fn set(progress: Arc<T>) -> Self {
        progress.as_ref().as_ref().store(true, Ordering::Relaxed);
        Self(progress)
    }
}

impl<T: AsRef<AtomicBool>> Drop for ScanFlagGuard<T> {
    fn drop(&mut self) {
        self.0.as_ref().as_ref().store(false, Ordering::Relaxed);
    }
}

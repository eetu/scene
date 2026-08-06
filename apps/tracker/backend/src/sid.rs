//! PSID / RSID header parsing.
//!
//! Unlike a tracker module, a SID needs no decoder to describe itself: the first
//! 124 bytes are a fixed big-endian header carrying the title, author, release
//! note, subtune count and the machine flags. So SIDs are parsed **here**, at
//! scan time, and never enter the browser's libopenmpt enrichment path — which
//! matters at HVSC scale, where handing 61k files to a WASM decoder that can't
//! read them would be pure waste.
//!
//! Layout per HVSC's `DOCUMENTS/SID_file_format.txt` (v1 ends at +76; v2-v4 add
//! the flags block and end at +7C):
//!
//! ```text
//! +00 4  magic 'PSID' | 'RSID'      +12 4  speed
//! +04 2  version 1..4               +16 32 name
//! +06 2  dataOffset 0x76 | 0x7C     +36 32 author
//! +08 2  loadAddress                +56 32 released
//! +0A 2  initAddress                +76 2  flags          (v2+)
//! +0C 2  playAddress                +78 1  startPage      (v2+)
//! +0E 2  songs 1..256               +79 1  pageLength     (v2+)
//! +10 2  startSong 1..songs         +7A 1  secondSIDAddress (v3+)
//!                                   +7B 1  thirdSIDAddress  (v4)
//! ```

/// Bytes of a SID file we need in order to describe it — the full v2+ header.
pub const HEADER_LEN: usize = 0x7C;

/// File extensions carrying a SID header.
pub const SID_EXTS: &[&str] = &["sid", "psid", "rsid"];

pub fn is_sid_ext(ext: &str) -> bool {
    SID_EXTS.contains(&ext)
}

/// Which environment the tune demands. RSID requires a true C64 (real interrupt
/// handlers, KERNAL routines); PSID is the older, more forgiving format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Magic {
    Psid,
    Rsid,
}

/// Video standard the tune was written for. Not a ROM difference — a clock
/// difference (PAL 985248 Hz vs NTSC 1022727 Hz), so a tune played at the wrong
/// one is audibly detuned and its ADSR timing can break outright.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clock {
    Unknown,
    Pal,
    Ntsc,
    Both,
}

/// SID chip revision. The 6581 and 8580 have, per the format spec, "totally
/// different" analog filter characteristics — the single biggest axis in how a
/// tune actually sounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidModel {
    Unknown,
    Mos6581,
    Mos8580,
    Both,
}

impl Clock {
    fn from_bits(b: u16) -> Self {
        match b {
            1 => Self::Pal,
            2 => Self::Ntsc,
            3 => Self::Both,
            _ => Self::Unknown,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pal => "PAL",
            Self::Ntsc => "NTSC",
            Self::Both => "PAL/NTSC",
            Self::Unknown => "",
        }
    }
}

impl SidModel {
    fn from_bits(b: u16) -> Self {
        match b {
            1 => Self::Mos6581,
            2 => Self::Mos8580,
            3 => Self::Both,
            _ => Self::Unknown,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mos6581 => "MOS6581",
            Self::Mos8580 => "MOS8580",
            Self::Both => "MOS6581/8580",
            Self::Unknown => "",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SidInfo {
    pub magic: Magic,
    pub version: u16,
    /// Number of subtunes (1..=256). Each becomes its own library row.
    pub songs: u16,
    /// The subtune played by default, 1-based as stored in the header.
    pub start_song: u16,
    pub name: Option<String>,
    pub author: Option<String>,
    pub released: Option<String>,
    pub clock: Clock,
    pub sid_model: SidModel,
    /// 1, 2 or 3 — a 2SID/3SID tune drives six or nine voices.
    pub chips: u8,
    /// RSID tunes whose player is a BASIC program (the flag is reused for this).
    pub basic: bool,
}

impl SidInfo {
    /// The format label shown in the library's "type" column, e.g. `RSID v3`.
    pub fn type_long(&self) -> String {
        let base = match self.magic {
            Magic::Psid => "PSID",
            Magic::Rsid => "RSID",
        };
        format!("{base} v{}", self.version)
    }
}

fn be16(b: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([b[at], b[at + 1]])
}

/// Windows-1252 → char for the 0x80-0x9F block, which is where CP1252 differs
/// from Latin-1. Everything outside it maps 1:1 to the same Unicode scalar.
/// Undefined slots become U+FFFD rather than silently vanishing.
const CP1252_HIGH: [char; 32] = [
    '€', '\u{FFFD}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{FFFD}', 'Ž',
    '\u{FFFD}', '\u{FFFD}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{FFFD}',
    'ž', 'Ÿ',
];

/// Decode one of the header's three 32-byte fields.
///
/// They are Windows-1252 and, per the spec, "may hold a character string of 32
/// bytes which is not zero terminated" — so stop at the first NUL *or* the field
/// end. HVSC writes `<?>` for genuinely unknown values; that's noise in a
/// library listing, so it becomes `None` along with the empty string.
fn field(bytes: &[u8]) -> Option<String> {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    let s: String = bytes[..end]
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => CP1252_HIGH[(b - 0x80) as usize],
            _ => b as char,
        })
        .collect();
    let t = s.trim();
    if t.is_empty() || t == "<?>" {
        None
    } else {
        Some(t.to_string())
    }
}

/// Second/third SID base addresses encode the middle nibbles of `$Dxx0`: 0x42 →
/// `$D420` … 0xFE → `$DFE0`. Only even values in 0x42-0x7F / 0xE0-0xFE mean a
/// real extra chip; anything else (including 0) means "not present".
fn has_extra_chip(v: u8) -> bool {
    v.is_multiple_of(2) && ((0x42..=0x7F).contains(&v) || (0xE0..=0xFE).contains(&v))
}

/// Parse a SID header. Returns `None` for anything that isn't a well-formed
/// PSID/RSID — a truncated file, a wrong magic, or a nonsense subtune count.
pub fn parse(bytes: &[u8]) -> Option<SidInfo> {
    if bytes.len() < 0x76 {
        return None;
    }
    let magic = match &bytes[0..4] {
        b"PSID" => Magic::Psid,
        b"RSID" => Magic::Rsid,
        _ => return None,
    };
    let version = be16(bytes, 0x04);
    if !(1..=4).contains(&version) {
        return None;
    }
    // RSID is defined only from v2 up; a v1 RSID is malformed.
    if magic == Magic::Rsid && version < 2 {
        return None;
    }
    let songs = be16(bytes, 0x0E);
    if songs == 0 || songs > 256 {
        return None;
    }
    let start_song = be16(bytes, 0x10);
    // Optional per the spec, and files do get this wrong — clamp rather than
    // reject, so one bad byte can't drop a tune from the library.
    let start_song = if (1..=songs).contains(&start_song) {
        start_song
    } else {
        1
    };

    // v1 has no flags block; everything below it defaults to unknown/absent.
    let (clock, sid_model, chips, basic) = if version >= 2 && bytes.len() >= HEADER_LEN {
        let flags = be16(bytes, 0x76);
        let mut chips = 1u8;
        if version >= 3 && has_extra_chip(bytes[0x7A]) {
            chips += 1;
        }
        if version >= 4 && has_extra_chip(bytes[0x7B]) {
            chips += 1;
        }
        (
            Clock::from_bits((flags >> 2) & 0b11),
            SidModel::from_bits((flags >> 4) & 0b11),
            chips,
            magic == Magic::Rsid && flags & 0b10 != 0,
        )
    } else {
        (Clock::Unknown, SidModel::Unknown, 1, false)
    };

    Some(SidInfo {
        magic,
        version,
        songs,
        start_song,
        name: field(&bytes[0x16..0x36]),
        author: field(&bytes[0x36..0x56]),
        released: field(&bytes[0x56..0x76]),
        clock,
        sid_model,
        chips,
        basic,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic v2 PSID header; tweak fields per test.
    fn header(magic: &[u8; 4], version: u16, songs: u16, start: u16) -> Vec<u8> {
        let mut b = vec![0u8; HEADER_LEN];
        b[0..4].copy_from_slice(magic);
        b[4..6].copy_from_slice(&version.to_be_bytes());
        b[6..8].copy_from_slice(&0x7C_u16.to_be_bytes());
        b[0x0E..0x10].copy_from_slice(&songs.to_be_bytes());
        b[0x10..0x12].copy_from_slice(&start.to_be_bytes());
        b
    }

    fn put(b: &mut [u8], at: usize, s: &str) {
        b[at..at + s.len()].copy_from_slice(s.as_bytes());
    }

    #[test]
    fn reads_the_identifying_fields() {
        let mut b = header(b"PSID", 2, 12, 3);
        put(&mut b, 0x16, "Commando");
        put(&mut b, 0x36, "Rob Hubbard");
        put(&mut b, 0x56, "1985 Elite");
        let i = parse(&b).unwrap();
        assert_eq!(i.magic, Magic::Psid);
        assert_eq!(i.songs, 12);
        assert_eq!(i.start_song, 3);
        assert_eq!(i.name.as_deref(), Some("Commando"));
        assert_eq!(i.author.as_deref(), Some("Rob Hubbard"));
        assert_eq!(i.released.as_deref(), Some("1985 Elite"));
        assert_eq!(i.type_long(), "PSID v2");
    }

    #[test]
    fn unknown_and_empty_fields_become_none() {
        // HVSC writes "<?>" for a genuinely unknown author; that's noise in a
        // listing, not a value worth displaying.
        let mut b = header(b"PSID", 2, 1, 1);
        put(&mut b, 0x36, "<?>");
        let i = parse(&b).unwrap();
        assert_eq!(i.author, None);
        assert_eq!(i.name, None, "an all-NUL field is absent, not empty-string");
    }

    #[test]
    fn decodes_windows_1252_not_utf8() {
        let mut b = header(b"PSID", 2, 1, 1);
        // 0x92 is a CP1252 right single quote — invalid as UTF-8, and Latin-1
        // would render it as a control character.
        b[0x16] = b'J';
        b[0x17] = 0x92;
        b[0x18] = b'A';
        let i = parse(&b).unwrap();
        assert_eq!(i.name.as_deref(), Some("J’A"));
    }

    #[test]
    fn an_unterminated_32_byte_field_is_read_whole() {
        let mut b = header(b"PSID", 2, 1, 1);
        let full = "X".repeat(32);
        put(&mut b, 0x16, &full);
        assert_eq!(parse(&b).unwrap().name.as_deref(), Some(full.as_str()));
    }

    #[test]
    fn reads_clock_and_model_from_the_flags() {
        let mut b = header(b"PSID", 2, 1, 1);
        // bits 2-3 = 10 (NTSC), bits 4-5 = 10 (8580)
        let flags: u16 = (0b10 << 2) | (0b10 << 4);
        b[0x76..0x78].copy_from_slice(&flags.to_be_bytes());
        let i = parse(&b).unwrap();
        assert_eq!(i.clock, Clock::Ntsc);
        assert_eq!(i.sid_model, SidModel::Mos8580);
    }

    #[test]
    fn counts_extra_sid_chips_only_at_valid_addresses() {
        let mut b = header(b"PSID", 4, 1, 1);
        b[0x7A] = 0x42; // $D420 — a real second chip
        b[0x7B] = 0x00; // absent
        assert_eq!(parse(&b).unwrap().chips, 2);

        b[0x7B] = 0xE0; // $DE00 — a real third chip
        assert_eq!(parse(&b).unwrap().chips, 3);

        // Odd and out-of-range values mean "no chip", not a chip at a bad place.
        b[0x7A] = 0x43;
        b[0x7B] = 0x20;
        assert_eq!(parse(&b).unwrap().chips, 1);
    }

    #[test]
    fn v3_ignores_the_v4_only_third_chip_field() {
        let mut b = header(b"PSID", 3, 1, 1);
        b[0x7A] = 0x42;
        b[0x7B] = 0xE0; // only meaningful in v4
        assert_eq!(parse(&b).unwrap().chips, 2);
    }

    #[test]
    fn rsid_basic_flag_is_read_only_for_rsid() {
        let flags: u16 = 0b10;
        let mut r = header(b"RSID", 2, 1, 1);
        r[0x76..0x78].copy_from_slice(&flags.to_be_bytes());
        assert!(parse(&r).unwrap().basic);

        // The same bit on a PSID means "PlaySID specific", not BASIC.
        let mut p = header(b"PSID", 2, 1, 1);
        p[0x76..0x78].copy_from_slice(&flags.to_be_bytes());
        assert!(!parse(&p).unwrap().basic);
    }

    #[test]
    fn v1_has_no_flags_block() {
        let mut b = header(b"PSID", 1, 1, 1);
        b.truncate(0x76); // a v1 file genuinely ends here
        let i = parse(&b).unwrap();
        assert_eq!(i.clock, Clock::Unknown);
        assert_eq!(i.chips, 1);
    }

    #[test]
    fn rejects_what_is_not_a_sid() {
        assert!(parse(b"not a sid file at all").is_none());
        assert!(parse(&header(b"MTHD", 2, 1, 1)).is_none(), "wrong magic");
        assert!(parse(&header(b"PSID", 9, 1, 1)).is_none(), "bad version");
        assert!(parse(&header(b"PSID", 2, 0, 1)).is_none(), "zero subtunes");
        // RSID is defined from v2 up.
        assert!(parse(&header(b"RSID", 1, 1, 1)).is_none());
        // Truncated mid-header.
        assert!(parse(&header(b"PSID", 2, 1, 1)[..0x40]).is_none());
    }

    #[test]
    fn an_out_of_range_start_song_clamps_rather_than_rejecting() {
        // One bad byte shouldn't drop a tune from the library.
        assert_eq!(parse(&header(b"PSID", 2, 4, 99)).unwrap().start_song, 1);
        assert_eq!(parse(&header(b"PSID", 2, 4, 0)).unwrap().start_song, 1);
    }

    /// Validate against a real HVSC tree, cross-checking the parser's subtune
    /// count against an *independent* source: `Songlengths.md5` lists one
    /// duration per subtune, authored upstream. Synthetic headers only prove the
    /// parser agrees with itself; this proves it agrees with HVSC.
    ///
    /// Ignored by default (needs the collection). Run with a tree that has both
    /// the tunes and `DOCUMENTS/Songlengths.md5`:
    ///
    /// ```sh
    /// HVSC_DIR=/path/to/C64Music cargo test -p tracker-backend --lib \
    ///   sid::tests::agrees_with_hvsc -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn agrees_with_hvsc() {
        use std::collections::HashMap;
        use std::path::PathBuf;

        let Ok(dir) = std::env::var("HVSC_DIR") else {
            panic!("set HVSC_DIR to an unpacked C64Music tree");
        };
        let root = PathBuf::from(&dir);

        // path (lowercased, leading '/') → subtune count from Songlengths.
        let mut want: HashMap<String, usize> = HashMap::new();
        if let Ok(db) = std::fs::read_to_string(root.join("DOCUMENTS/Songlengths.md5")) {
            let mut path: Option<String> = None;
            for line in db.lines() {
                if let Some(p) = line.strip_prefix("; ") {
                    path = Some(p.trim().to_lowercase());
                } else if let Some((_, lens)) = line.split_once('=') {
                    if let Some(p) = path.take() {
                        want.insert(p, lens.split_whitespace().count());
                    }
                }
            }
        }

        let mut checked = 0usize;
        let mut mismatched = Vec::new();
        let mut unparsed = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(d) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else {
                continue;
            };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                if p.extension().and_then(|e| e.to_str()) != Some("sid") {
                    continue;
                }
                let Ok(bytes) = std::fs::read(&p) else {
                    continue;
                };
                let Some(info) = parse(&bytes) else {
                    unparsed.push(p.clone());
                    continue;
                };
                checked += 1;
                let rel = format!(
                    "/{}",
                    p.strip_prefix(&root)
                        .unwrap()
                        .to_string_lossy()
                        .to_lowercase()
                );
                if let Some(&n) = want.get(&rel) {
                    if n != info.songs as usize {
                        mismatched.push((rel, info.songs as usize, n));
                    }
                }
            }
        }

        println!(
            "parsed {checked} tunes; {} cross-checked",
            want.len().min(checked)
        );
        assert!(checked > 0, "no .sid files found under {dir}");
        assert!(unparsed.is_empty(), "failed to parse: {unparsed:?}");
        assert!(
            mismatched.is_empty(),
            "subtune count disagrees with Songlengths (path, header, db): {mismatched:?}"
        );
    }
}

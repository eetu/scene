//! CP437 (the IBM PC OEM code page) → UTF-8 decoding. Scene `.nfo`/`.diz` files
//! and the Assembly `results.txt` are CP437: box-drawing art plus the high
//! Latin letters Finnish/Swedish/German names use (å ä ö ü …). `encoding_rs`
//! ships web encodings but not CP437, so we embed the canonical 0x80–0xFF table.
//! The low 128 code points are ASCII.

/// Unicode scalar for each byte 0x80..=0xFF, in order.
const HIGH: [char; 128] = [
    'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å', // 0x80
    'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ', // 0x90
    'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»', // 0xA0
    '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐', // 0xB0
    '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧', // 0xC0
    '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀', // 0xD0
    'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩', // 0xE0
    '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²', '■', '\u{00A0}', // 0xF0
];

/// Decode CP437 bytes to a `String`. Never fails — every byte maps.
pub fn decode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| {
            if b < 0x80 {
                b as char
            } else {
                HIGH[(b - 0x80) as usize]
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn ascii_passthrough() {
        assert_eq!(decode(b"hello world"), "hello world");
    }

    #[test]
    fn high_letters() {
        // 0x84 ä, 0x86 å, 0x94 ö — "Pauli Rämä" was stored CP437.
        assert_eq!(decode(&[b'R', 0x84, b'm', 0x84]), "Rämä");
        assert_eq!(decode(&[0x86]), "å");
    }
}

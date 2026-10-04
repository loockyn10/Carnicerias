//! Codificación ESC/POS de un documento de texto para una impresora térmica.
//!
//! El POS (TypeScript) decide el *layout*: cada línea ya llega con el padding/alineación hecho para
//! el ancho de columnas del papel, y con un estilo (`normal` / `bold` / `double`). Acá sólo se
//! traduce a bytes: inicialización, juego de caracteres (única conversión Unicode → byte del
//! sistema, centralizada en `encode_char`), estilos y avance/corte de papel. No hay comandos
//! específicos de una marca más allá del subconjunto ESC/POS que hablan las térmicas habituales.

use serde::{Deserialize, Serialize};

const ESC: u8 = 0x1B;
const GS: u8 = 0x1D;
const LF: u8 = 0x0A;

/// Cantidad de líneas que se avanzan antes del corte automático: el cortador está unos 12 mm
/// debajo de la cabeza de impresión, así que sin este avance cortaría el pie del ticket.
pub const FEED_LINES_BEFORE_CUT: u8 = 5;
/// Sin corte automático sólo se avanza un poco de papel para poder cortar a mano.
pub const FEED_LINES_WITHOUT_CUT: u8 = 4;
/// Tope defensivo: un documento válido (un ticket de 100 líneas con detalle) está muy por debajo.
pub const MAX_LINES: usize = 2_000;

/// Juego de caracteres del que la impresora lee los bytes `0x80..=0xFF` (comando `ESC t n`).
/// CP858 es el estándar de las Epson y de casi todas las compatibles (CP850 + €); si una impresora
/// concreta muestra mal las tildes se prueba WPC1252 desde la pantalla de configuración.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CodePage {
    #[default]
    Cp858,
    Wpc1252,
}

impl CodePage {
    /// Número de tabla del comando `ESC t n` (Epson: 19 = PC858 Euro, 16 = WPC1252).
    pub const fn escpos_table(self) -> u8 {
        match self {
            CodePage::Cp858 => 19,
            CodePage::Wpc1252 => 16,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineStyle {
    #[default]
    Normal,
    /// Negrita (mismo tamaño).
    Bold,
    /// Negrita + doble ancho y alto: la mitad de columnas por línea (lo resuelve el layout).
    Double,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintLine {
    pub text: String,
    #[serde(default)]
    pub style: LineStyle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintDocument {
    pub lines: Vec<PrintLine>,
}

/// CP858 (CP850 con € en 0xD5): letras latinas y signos del español y de los idiomas vecinos.
/// Los caracteres de dibujo de cajas no se incluyen: un nombre de producto no los usa.
const CP858: &[(char, u8)] = &[
    ('Ç', 0x80), ('ü', 0x81), ('é', 0x82), ('â', 0x83), ('ä', 0x84), ('à', 0x85), ('å', 0x86), ('ç', 0x87),
    ('ê', 0x88), ('ë', 0x89), ('è', 0x8A), ('ï', 0x8B), ('î', 0x8C), ('ì', 0x8D), ('Ä', 0x8E), ('Å', 0x8F),
    ('É', 0x90), ('æ', 0x91), ('Æ', 0x92), ('ô', 0x93), ('ö', 0x94), ('ò', 0x95), ('û', 0x96), ('ù', 0x97),
    ('ÿ', 0x98), ('Ö', 0x99), ('Ü', 0x9A), ('ø', 0x9B), ('£', 0x9C), ('Ø', 0x9D), ('×', 0x9E), ('ƒ', 0x9F),
    ('á', 0xA0), ('í', 0xA1), ('ó', 0xA2), ('ú', 0xA3), ('ñ', 0xA4), ('Ñ', 0xA5), ('ª', 0xA6), ('º', 0xA7),
    ('¿', 0xA8), ('®', 0xA9), ('¬', 0xAA), ('½', 0xAB), ('¼', 0xAC), ('¡', 0xAD), ('«', 0xAE), ('»', 0xAF),
    ('Á', 0xB5), ('Â', 0xB6), ('À', 0xB7), ('©', 0xB8), ('¢', 0xBD), ('¥', 0xBE),
    ('ã', 0xC6), ('Ã', 0xC7), ('¤', 0xCF), ('ð', 0xD0), ('Ð', 0xD1), ('Ê', 0xD2), ('Ë', 0xD3), ('È', 0xD4),
    ('€', 0xD5), ('Í', 0xD6), ('Î', 0xD7), ('Ï', 0xD8), ('¦', 0xDD), ('Ì', 0xDE),
    ('Ó', 0xE0), ('ß', 0xE1), ('Ô', 0xE2), ('Ò', 0xE3), ('õ', 0xE4), ('Õ', 0xE5), ('µ', 0xE6), ('þ', 0xE7), ('Þ', 0xE8),
    ('Ú', 0xE9), ('Û', 0xEA), ('Ù', 0xEB), ('ý', 0xEC), ('Ý', 0xED), ('¯', 0xEE), ('´', 0xEF),
    ('±', 0xF1), ('¾', 0xF3), ('¶', 0xF4), ('§', 0xF5), ('÷', 0xF6), ('¸', 0xF7), ('°', 0xF8), ('¨', 0xF9),
    ('·', 0xFA), ('¹', 0xFB), ('³', 0xFC), ('²', 0xFD),
];

/// Windows-1252 puntuación tipográfica (el rango Latin-1 `U+00A0..=U+00FF` coincide byte a byte).
const WPC1252_EXTRA: &[(char, u8)] = &[
    ('€', 0x80), ('‘', 0x91), ('’', 0x92), ('“', 0x93), ('”', 0x94), ('•', 0x95), ('–', 0x96), ('—', 0x97),
];

/// Carácter sin representación en el juego elegido: un signo visible, nunca un byte inventado.
pub const UNSUPPORTED_CHAR: u8 = b'?';

/// Único punto de conversión Unicode → byte. Espacios raros (NBSP, finos, ideográficos) pasan a
/// un espacio común; controles se descartan; lo que el juego no tiene queda como `?`.
pub fn encode_char(character: char, code_page: CodePage) -> Option<u8> {
    if character.is_control() {
        return None;
    }
    if character.is_whitespace() {
        return Some(b' ');
    }
    let code = character as u32;
    if (0x20..0x7F).contains(&code) {
        return Some(code as u8);
    }
    let mapped = match code_page {
        CodePage::Cp858 => CP858.iter().find(|(known, _)| *known == character).map(|(_, byte)| *byte),
        CodePage::Wpc1252 => {
            if (0xA0..=0xFF).contains(&code) {
                Some(code as u8)
            } else {
                WPC1252_EXTRA.iter().find(|(known, _)| *known == character).map(|(_, byte)| *byte)
            }
        }
    };
    Some(mapped.unwrap_or(UNSUPPORTED_CHAR))
}

pub fn encode_text(text: &str, code_page: CodePage) -> Vec<u8> {
    text.chars().filter_map(|character| encode_char(character, code_page)).collect()
}

fn style_bytes(style: LineStyle) -> [u8; 6] {
    // ESC E n (negrita) + GS ! n (tamaño: 0x00 normal, 0x11 doble ancho y alto).
    match style {
        LineStyle::Normal => [ESC, b'E', 0, GS, b'!', 0x00],
        LineStyle::Bold => [ESC, b'E', 1, GS, b'!', 0x00],
        LineStyle::Double => [ESC, b'E', 1, GS, b'!', 0x11],
    }
}

/// Bytes del trabajo RAW completo: inicializar, elegir fuente A y juego de caracteres, imprimir
/// las líneas y cerrar con avance (+ corte parcial si `cut`).
pub fn encode_document(document: &PrintDocument, code_page: CodePage, cut: bool) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(256 + document.lines.iter().map(|line| line.text.len() + 8).sum::<usize>());
    out.extend_from_slice(&[ESC, b'@']); // inicializar
    out.extend_from_slice(&[ESC, b'M', 0]); // fuente A
    out.extend_from_slice(&[ESC, b't', code_page.escpos_table()]);
    for line in &document.lines {
        out.extend_from_slice(&style_bytes(line.style));
        out.extend(encode_text(&line.text, code_page));
        out.push(LF);
    }
    out.extend_from_slice(&style_bytes(LineStyle::Normal));
    if cut {
        out.extend_from_slice(&[ESC, b'd', FEED_LINES_BEFORE_CUT]);
        out.extend_from_slice(&[GS, b'V', 1]); // corte parcial
    } else {
        out.extend_from_slice(&[ESC, b'd', FEED_LINES_WITHOUT_CUT]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(lines: &[(&str, LineStyle)]) -> PrintDocument {
        PrintDocument { lines: lines.iter().map(|(text, style)| PrintLine { text: (*text).to_string(), style: *style }).collect() }
    }

    #[test]
    fn spanish_characters_use_the_cp858_bytes() {
        assert_eq!(encode_text("á é í ó ú ñ Ñ ¿ ¡", CodePage::Cp858), vec![0xA0, b' ', 0x82, b' ', 0xA1, b' ', 0xA2, b' ', 0xA3, b' ', 0xA4, b' ', 0xA5, b' ', 0xA8, b' ', 0xAD]);
        assert_eq!(encode_text("Á É Í Ó Ú Ü", CodePage::Cp858), vec![0xB5, b' ', 0x90, b' ', 0xD6, b' ', 0xE0, b' ', 0xE9, b' ', 0x9A]);
    }

    #[test]
    fn spanish_characters_use_the_windows_1252_bytes() {
        assert_eq!(encode_text("á é í ó ú ñ Ñ ¿ ¡ €", CodePage::Wpc1252), vec![0xE1, b' ', 0xE9, b' ', 0xED, b' ', 0xF3, b' ', 0xFA, b' ', 0xF1, b' ', 0xD1, b' ', 0xBF, b' ', 0xA1, b' ', 0x80]);
    }

    #[test]
    fn ascii_money_and_percent_pass_through_untouched() {
        assert_eq!(encode_text("TOTAL $23.180 15% -$600", CodePage::Cp858), b"TOTAL $23.180 15% -$600".to_vec());
    }

    #[test]
    fn unsupported_characters_become_a_visible_question_mark_one_per_character() {
        // Emoji y CJK: un `?` por carácter (el layout cuenta un carácter por code point, así el ancho se conserva).
        assert_eq!(encode_text("🥩 肉", CodePage::Cp858), vec![b'?', b' ', b'?']);
        assert_eq!(encode_text("Ž", CodePage::Wpc1252), vec![b'?']);
    }

    #[test]
    fn control_characters_are_dropped_and_odd_spaces_become_spaces() {
        assert_eq!(encode_text("a\u{1B}@b\r\nc\td", CodePage::Cp858), b"a@bcd".to_vec());
        assert_eq!(encode_text("a\u{00A0}b\u{202F}c", CodePage::Cp858), b"a b c".to_vec());
    }

    #[test]
    fn a_text_can_never_inject_a_printer_command() {
        // ESC/GS son controles: se descartan, así que un nombre de producto no puede abrir el cajón ni cortar.
        let bytes = encode_text("\u{1B}p\u{0}\u{1D}V\u{1}", CodePage::Cp858);
        assert!(bytes.iter().all(|byte| *byte >= 0x20));
    }

    #[test]
    fn a_job_starts_with_init_font_and_code_page() {
        let bytes = encode_document(&doc(&[("hola", LineStyle::Normal)]), CodePage::Cp858, true);
        assert_eq!(&bytes[..2], &[0x1B, b'@']);
        assert_eq!(&bytes[2..5], &[0x1B, b'M', 0]);
        assert_eq!(&bytes[5..8], &[0x1B, b't', 19]);
        let wpc = encode_document(&doc(&[("hola", LineStyle::Normal)]), CodePage::Wpc1252, true);
        assert_eq!(&wpc[5..8], &[0x1B, b't', 16]);
    }

    #[test]
    fn auto_cut_feeds_then_cuts_and_no_cut_only_feeds() {
        let document = doc(&[("hola", LineStyle::Normal)]);
        let with_cut = encode_document(&document, CodePage::Cp858, true);
        assert_eq!(&with_cut[with_cut.len() - 6..], &[0x1B, b'd', FEED_LINES_BEFORE_CUT, 0x1D, b'V', 1]);
        let without_cut = encode_document(&document, CodePage::Cp858, false);
        assert_eq!(&without_cut[without_cut.len() - 3..], &[0x1B, b'd', FEED_LINES_WITHOUT_CUT]);
        assert!(!without_cut.windows(3).any(|window| window == [0x1D, b'V', 1]), "no cut command without auto-cut");
    }

    #[test]
    fn each_line_carries_its_style_and_ends_with_a_line_feed() {
        let bytes = encode_document(&doc(&[("a", LineStyle::Normal), ("TOTAL", LineStyle::Double), ("b", LineStyle::Bold)]), CodePage::Cp858, false);
        let body = &bytes[8..];
        let mut expected: Vec<u8> = Vec::new();
        expected.extend_from_slice(&[0x1B, b'E', 0, 0x1D, b'!', 0x00]);
        expected.extend_from_slice(b"a\n");
        expected.extend_from_slice(&[0x1B, b'E', 1, 0x1D, b'!', 0x11]);
        expected.extend_from_slice(b"TOTAL\n");
        expected.extend_from_slice(&[0x1B, b'E', 1, 0x1D, b'!', 0x00]);
        expected.extend_from_slice(b"b\n");
        assert!(body.starts_with(&expected), "styled lines: {body:02X?}");
        // Después de la última línea el estilo se restablece antes de avanzar.
        assert_eq!(&body[expected.len()..expected.len() + 6], &[0x1B, b'E', 0, 0x1D, b'!', 0x00]);
    }

    #[test]
    fn the_document_json_from_the_pos_deserializes_with_a_default_style() {
        let parsed: PrintDocument = serde_json::from_str(r#"{"lines":[{"text":"x"},{"text":"y","style":"double"}]}"#).unwrap();
        assert_eq!(parsed.lines[0].style, LineStyle::Normal);
        assert_eq!(parsed.lines[1].style, LineStyle::Double);
        let page: CodePage = serde_json::from_str("\"WPC1252\"").unwrap();
        assert_eq!(page, CodePage::Wpc1252);
        assert_eq!(serde_json::to_string(&CodePage::Cp858).unwrap(), "\"CP858\"");
    }
}

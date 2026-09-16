//! Pure, hardware-free parser for the KRETZ Novel Eco 2 continuous weight
//! transmission protocol (see docs/SCALE_INTEGRATION.md). No I/O here: it
//! only turns raw serial bytes into integer-gram weight frames, so it can be
//! unit tested without a scale or a serial port.
//!
//! Documented frame (continuous weight mode): STX (0x02) + net weight in
//! ASCII kilograms with a decimal point (e.g. "01.250") + CR (0x0D).

const STX: u8 = 0x02;
const CR: u8 = 0x0D;

/// Frames longer than this without a terminator are treated as corrupted
/// noise and dropped; the real protocol frame is a handful of bytes.
const MAX_FRAME_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ScaleFrameError {
    #[error("Empty scale frame")]
    Empty,
    #[error("Scale frame is not valid ASCII")]
    InvalidEncoding,
    #[error("Scale frame is missing the decimal point")]
    MissingDecimalPoint,
    #[error("Scale frame contains unexpected characters")]
    InvalidCharacters,
    #[error("Scale frame was discarded because it exceeded the maximum expected length")]
    FrameTooLong,
}

/// Converts one already-extracted frame payload (the bytes between STX and
/// CR) into an integer gram weight. Never panics and never guesses: any
/// byte that does not match the documented "digits.digits" shape is
/// rejected rather than clamped or truncated.
pub fn parse_weight_frame(bytes: &[u8]) -> Result<i64, ScaleFrameError> {
    if bytes.is_empty() {
        return Err(ScaleFrameError::Empty);
    }
    if bytes.len() > MAX_FRAME_LEN {
        return Err(ScaleFrameError::FrameTooLong);
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ScaleFrameError::InvalidEncoding)?
        .trim();
    let (integer_part, fractional_part) = text
        .split_once('.')
        .ok_or(ScaleFrameError::MissingDecimalPoint)?;

    let is_ascii_digits = |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit());
    // Bounds are a defensive sanity cap on corrupted transmissions (nothing a
    // butcher's scale would legitimately send), not a documented protocol limit.
    if !is_ascii_digits(integer_part) || integer_part.len() > 3 {
        return Err(ScaleFrameError::InvalidCharacters);
    }
    if !is_ascii_digits(fractional_part) || fractional_part.len() > 3 {
        return Err(ScaleFrameError::InvalidCharacters);
    }

    let kilograms: i64 = integer_part.parse().map_err(|_| ScaleFrameError::InvalidCharacters)?;
    let mut fractional = fractional_part.to_string();
    while fractional.len() < 3 {
        fractional.push('0');
    }
    let gram_fraction: i64 = fractional.parse().map_err(|_| ScaleFrameError::InvalidCharacters)?;
    Ok(kilograms * 1_000 + gram_fraction)
}

/// Incremental byte-stream framer. A single `read()` from a serial port is
/// not guaranteed to align with protocol frames: it can deliver a partial
/// frame, several frames back to back, or leading garbage. This buffers
/// across calls to `feed` and only reports complete frames.
#[derive(Debug, Default)]
pub struct KretzFrameParser {
    buffer: Vec<u8>,
    in_frame: bool,
}

impl KretzFrameParser {
    pub fn new() -> Self {
        Self { buffer: Vec::new(), in_frame: false }
    }

    /// Feeds newly-read bytes and returns the parse result for every
    /// complete frame found, in the order they were terminated by CR.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Result<i64, ScaleFrameError>> {
        let mut results = Vec::new();
        for &byte in chunk {
            if byte == STX {
                // A new STX always starts a fresh frame: any partially
                // buffered data without its own CR is corrupt and dropped.
                self.buffer.clear();
                self.in_frame = true;
                continue;
            }
            if !self.in_frame {
                // Bytes before the first STX are noise, not buffered.
                continue;
            }
            if byte == CR {
                let frame = std::mem::take(&mut self.buffer);
                self.in_frame = false;
                results.push(parse_weight_frame(&frame));
                continue;
            }
            self.buffer.push(byte);
            if self.buffer.len() > MAX_FRAME_LEN {
                results.push(Err(ScaleFrameError::FrameTooLong));
                self.buffer.clear();
                self.in_frame = false;
            }
        }
        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_complete_frame() {
        let mut parser = KretzFrameParser::new();
        let results = parser.feed(&[STX, b'0', b'1', b'.', b'2', b'5', b'0', CR]);
        assert_eq!(results, vec![Ok(1_250)]);
    }

    #[test]
    fn parses_a_frame_split_across_two_reads() {
        let mut parser = KretzFrameParser::new();
        assert_eq!(parser.feed(&[STX, b'0', b'1']), Vec::new());
        assert_eq!(parser.feed(&[b'.', b'2', b'5', b'0', CR]), vec![Ok(1_250)]);
    }

    #[test]
    fn parses_two_frames_concatenated_in_one_read() {
        let mut parser = KretzFrameParser::new();
        let mut chunk = vec![STX, b'0', b'.', b'5', b'0', b'0', CR];
        chunk.extend_from_slice(&[STX, b'0', b'1', b'.', b'2', b'5', b'0', CR]);
        assert_eq!(parser.feed(&chunk), vec![Ok(500), Ok(1_250)]);
    }

    #[test]
    fn ignores_garbage_bytes_before_the_first_stx() {
        let mut parser = KretzFrameParser::new();
        let results = parser.feed(&[0xFF, 0xFE, 0x00, STX, b'0', b'.', b'5', b'0', b'0', CR]);
        assert_eq!(results, vec![Ok(500)]);
    }

    #[test]
    fn a_new_stx_discards_a_never_terminated_frame() {
        let mut parser = KretzFrameParser::new();
        assert_eq!(parser.feed(&[STX, b'9', b'9', b'.', b'9']), Vec::new());
        let results = parser.feed(&[STX, b'0', b'.', b'5', b'0', b'0', CR]);
        assert_eq!(results, vec![Ok(500)]);
    }

    #[test]
    fn incomplete_frame_without_cr_reports_nothing_yet() {
        let mut parser = KretzFrameParser::new();
        assert_eq!(parser.feed(&[STX, b'0', b'.', b'5', b'0', b'0']), Vec::new());
    }

    #[test]
    fn zero_weight_is_a_valid_reading() {
        assert_eq!(parse_weight_frame(b"0.000"), Ok(0));
    }

    #[test]
    fn five_hundred_grams() {
        assert_eq!(parse_weight_frame(b"0.500"), Ok(500));
    }

    #[test]
    fn one_point_two_five_kilograms() {
        assert_eq!(parse_weight_frame(b"1.250"), Ok(1_250));
    }

    #[test]
    fn twelve_point_three_four_five_kilograms() {
        assert_eq!(parse_weight_frame(b"12.345"), Ok(12_345));
    }

    #[test]
    fn rejects_invalid_characters() {
        assert_eq!(parse_weight_frame(b"AB.CDE"), Err(ScaleFrameError::InvalidCharacters));
        assert_eq!(parse_weight_frame(b"1.25X"), Err(ScaleFrameError::InvalidCharacters));
    }

    #[test]
    fn rejects_frames_without_a_decimal_point() {
        assert_eq!(parse_weight_frame(b"01250"), Err(ScaleFrameError::MissingDecimalPoint));
    }

    #[test]
    fn rejects_empty_frames() {
        assert_eq!(parse_weight_frame(b""), Err(ScaleFrameError::Empty));
        let mut parser = KretzFrameParser::new();
        assert_eq!(parser.feed(&[STX, CR]), vec![Err(ScaleFrameError::Empty)]);
    }

    #[test]
    fn rejects_oversized_frames_and_resyncs() {
        let mut parser = KretzFrameParser::new();
        let mut chunk = vec![STX];
        chunk.extend(std::iter::repeat(b'1').take(MAX_FRAME_LEN + 1));
        chunk.push(CR);
        chunk.extend_from_slice(&[STX, b'0', b'.', b'5', b'0', b'0', CR]);
        let results = parser.feed(&chunk);
        assert_eq!(results, vec![Err(ScaleFrameError::FrameTooLong), Ok(500)]);
    }
}

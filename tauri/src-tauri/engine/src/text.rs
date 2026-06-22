//! Text preprocessing: normalization, pause/silence markers, segmentation, and
//! sub-chunking. Ported from tauri/sidecar/tts-worker.ts.
use regex::Regex;
use std::sync::LazyLock;

pub const SAMPLE_RATE: u32 = 24000;
pub const MODEL_CONTEXT_WINDOW: usize = 512;
/// Max tokens per inference chunk (room for the two padding zeros).
pub const TOKENS_PER_CHUNK: usize = MODEL_CONTEXT_WINDOW - 2;

/// Smart-quote / CJK-punctuation / whitespace normalization (per-segment).
pub fn normalize_text(text: &str) -> String {
    text.replace('\u{2018}', "'")
        .replace('\u{2019}', "'")
        .replace('«', "(")
        .replace('»', ")")
        .replace('\u{201C}', "\"")
        .replace('\u{201D}', "\"")
        .replace('、', ", ")
        .replace('。', ". ")
        .replace('！', "! ")
        .replace('，', ", ")
        .replace('：', ": ")
        .replace('；', "; ")
        .replace('？', "? ")
        .replace('\n', "  ")
        .replace('\t', "  ")
        .trim()
        .to_string()
}

static RE_PAUSE_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<\s*pause\s*=\s*"?([0-9]*\.?[0-9]+)\s*(ms|s)?"?\s*/?\s*>"#).unwrap());
static RE_BREAK_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<\s*break\s+time\s*=\s*["']?([0-9]*\.?[0-9]+)\s*(ms|s)?["']?\s*/?\s*>"#).unwrap()
});
static RE_BRACKET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\[\s*([0-9]*\.?[0-9]+)\s*(ms|s)\s*\]").unwrap());

fn to_marker(value: &str, unit: &str) -> String {
    let n: f64 = value.parse().unwrap_or(0.0);
    let seconds = if unit.eq_ignore_ascii_case("ms") { n / 1000.0 } else { n };
    format!("[{seconds}s]")
}

/// Normalize the user-facing pause syntaxes into the canonical `[Ns]` marker.
pub fn normalize_pause_tags(text: &str) -> String {
    let repl = |caps: &regex::Captures| -> String {
        to_marker(&caps[1], caps.get(2).map_or("", |m| m.as_str()))
    };
    let t = RE_PAUSE_TAG.replace_all(text, repl).into_owned();
    let t = RE_BREAK_TAG.replace_all(&t, repl).into_owned();
    RE_BRACKET.replace_all(&t, repl).into_owned()
}

static RE_ELLIPSIS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*(?:…|\.{3,})\s*").unwrap());
static RE_EMDASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*—\s*").unwrap());
static RE_ENDASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+[–-]\s+").unwrap());
static RE_PERIOD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.\s+").unwrap());
static RE_COMMA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",\s+").unwrap());
static RE_SEMI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r";\s+").unwrap());
static RE_COLON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":\s+").unwrap());
static RE_BANG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\s+").unwrap());
static RE_QUES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\?\s+").unwrap());
static RE_NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n+").unwrap());

/// Inject silence markers from punctuation (mirrors sanitizeText).
pub fn sanitize_text(raw: &str) -> String {
    let t = normalize_pause_tags(raw);
    let t = RE_ELLIPSIS.replace_all(&t, "[0.5s]").into_owned();
    let t = RE_EMDASH.replace_all(&t, "[0.3s]").into_owned();
    let t = RE_ENDASH.replace_all(&t, "[0.3s]").into_owned();
    let t = RE_PERIOD.replace_all(&t, "[0.4s]").into_owned();
    let t = RE_COMMA.replace_all(&t, "[0.2s]").into_owned();
    let t = RE_SEMI.replace_all(&t, "[0.4s]").into_owned();
    let t = RE_COLON.replace_all(&t, "[0.3s]").into_owned();
    let t = RE_BANG.replace_all(&t, "![0.1s]").into_owned();
    let t = RE_QUES.replace_all(&t, "?[0.1s]").into_owned();
    let t = RE_NEWLINES.replace_all(&t, "[0.4s]").into_owned();
    t.trim().to_string()
}

static RE_MARKER_SPLIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[[0-9]+(?:\.[0-9]+)?s\]").unwrap());
static RE_MARKER_FULL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[([0-9]+(?:\.[0-9]+)?)s\]$").unwrap());

/// Split sanitized text into segments, keeping the `[Ns]` markers as their own
/// segments (mirrors segmentText, which splits on a capturing group).
pub fn segment_text(sanitized: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut last = 0usize;
    for m in RE_MARKER_SPLIT.find_iter(sanitized) {
        let before = sanitized[last..m.start()].trim();
        if !before.is_empty() {
            out.push(before.to_string());
        }
        out.push(m.as_str().trim().to_string());
        last = m.end();
    }
    let tail = sanitized[last..].trim();
    if !tail.is_empty() {
        out.push(tail.to_string());
    }
    out
}

pub fn is_silence_marker(seg: &str) -> bool {
    RE_MARKER_FULL.is_match(seg.trim())
}

pub fn extract_silence_seconds(marker: &str) -> f32 {
    RE_MARKER_FULL
        .captures(marker.trim())
        .and_then(|c| c[1].parse::<f32>().ok())
        .unwrap_or(0.0)
}

/// A unit of synthesis: spoken text or a span of silence (sample count).
#[derive(Debug, Clone, PartialEq)]
pub enum Unit {
    Text(String),
    Silence(usize),
}

/// sanitize → segment → typed units (mirrors buildUnits).
pub fn build_units(text: &str) -> Vec<Unit> {
    segment_text(&sanitize_text(text))
        .into_iter()
        .map(|seg| {
            if is_silence_marker(&seg) {
                Unit::Silence((extract_silence_seconds(&seg) * SAMPLE_RATE as f32).floor() as usize)
            } else {
                Unit::Text(seg)
            }
        })
        .collect()
}

/// Split a phoneme string into sub-chunks of at most `tokens_per_chunk` chars
/// (one char ≈ one token), so each inference stays under the context window.
pub fn create_phoneme_sub_chunks(phonemes: &str, tokens_per_chunk: usize) -> Vec<String> {
    let chars: Vec<char> = phonemes.chars().collect();
    if chars.len() <= tokens_per_chunk {
        return vec![phonemes.to_string()];
    }
    chars
        .chunks(tokens_per_chunk)
        .map(|c| c.iter().collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_basics() {
        assert_eq!(normalize_text("\u{201C}hi\u{201D}\n there "), "\"hi\"   there");
    }

    #[test]
    fn sanitize_and_segment() {
        let units = build_units("Hello, world. Done");
        // "Hello" , [0.2s] , "world" , [0.4s] , "Done"
        assert_eq!(units[0], Unit::Text("Hello".into()));
        assert!(matches!(units[1], Unit::Silence(n) if n == (0.2 * 24000.0) as usize));
        assert_eq!(units[2], Unit::Text("world".into()));
        assert!(matches!(units[3], Unit::Silence(n) if n == (0.4 * 24000.0) as usize));
        assert_eq!(units[4], Unit::Text("Done".into()));
    }

    #[test]
    fn pause_tag_forms() {
        assert_eq!(normalize_pause_tags("a<pause=500ms>b"), "a[0.5s]b");
        assert_eq!(normalize_pause_tags("a[1s]b"), "a[1s]b");
    }

    #[test]
    fn subchunk_limits() {
        let s: String = std::iter::repeat('a').take(1025).collect();
        let chunks = create_phoneme_sub_chunks(&s, 510);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].chars().count(), 510);
        assert_eq!(chunks[2].chars().count(), 5);
    }
}

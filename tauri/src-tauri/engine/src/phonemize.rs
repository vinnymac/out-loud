//! Text → IPA phonemes via espeak-rs (FFI to vendored espeak-ng). The data dir is
//! configured via `PIPER_ESPEAKNG_DATA_DIRECTORY` (set by `Engine::new`).
use anyhow::{anyhow, Result};

/// espeak-ng 1.52 renamed some regional voices; map app codes to accepted names.
fn map_voice(lang: &str) -> &str {
    match lang {
        "en-gb" => "en-gb-x-rp",
        other => other,
    }
}

/// Phonemize a single segment (already split on punctuation upstream) to IPA.
pub fn phonemize(text: &str, lang: &str) -> Result<String> {
    let norm = crate::text::normalize_text(text);
    if norm.is_empty() {
        return Ok(String::new());
    }
    // text_to_phonemes returns one String per clause; for a single segment this is
    // typically one element. Join with a space to mirror the WASM CLI output.
    let parts = espeak_rs::text_to_phonemes(&norm, map_voice(lang), None)
        .map_err(|e| anyhow!("espeak phonemize ({lang}) failed: {e:?}"))?;
    Ok(parts.join(" ").trim().to_string())
}

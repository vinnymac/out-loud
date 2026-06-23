//! Native Rust Kokoro-82M TTS engine for Out Loud.
//!
//! Pipeline (faithful port of the former Node sidecar): text → espeak-rs IPA →
//! tokenize → voice style slice → ONNX (ort + bundled libonnxruntime 1.20.1) →
//! trim → WAV. Runs in-process; the HTTP/WS server lives in the host crate.
pub mod audio;
pub mod infer;
pub mod office;
pub mod phonemize;
pub mod text;
pub mod tokenize;
pub mod voices;

pub mod server;

pub use text::{build_units, Unit, SAMPLE_RATE};

use anyhow::Result;
use ort::session::Session;
use std::path::{Path, PathBuf};
use std::sync::Once;

// ort's environment is process-global and may be initialized exactly once.
static ORT_ONCE: Once = Once::new();

/// The TTS engine: a cached ONNX session plus voice cache, bound to a models dir.
pub struct Engine {
    session: Session,
    models_dir: PathBuf,
    voice_cache: voices::VoiceCache,
}

impl Engine {
    /// Create the engine. `dylib_path` is the libonnxruntime to dlopen;
    /// `espeak_data_dir` is the directory containing `espeak-ng-data`.
    pub fn new(
        models_dir: impl AsRef<Path>,
        dylib_path: impl AsRef<Path>,
        espeak_data_dir: impl AsRef<Path>,
    ) -> Result<Self> {
        // espeak-rs reads this on first phonemize — set before any synthesis.
        std::env::set_var("PIPER_ESPEAKNG_DATA_DIRECTORY", espeak_data_dir.as_ref());

        let dylib = dylib_path.as_ref().to_string_lossy().into_owned();
        let mut init_err: Option<String> = None;
        ORT_ONCE.call_once(|| {
            if let Err(e) = ort::init_from(dylib.as_str()).commit() {
                init_err = Some(format!("ort init from {dylib}: {e}"));
            }
        });
        if let Some(e) = init_err {
            return Err(anyhow::anyhow!(e));
        }

        let models_dir = models_dir.as_ref().to_path_buf();
        let model_path = models_dir.join("model_q8f16.onnx");
        let session = Session::builder()?.commit_from_file(&model_path)?;

        Ok(Self {
            session,
            models_dir,
            voice_cache: Default::default(),
        })
    }

    /// Combine one or more voices (formula) into a flat style buffer. Compute once
    /// per request and reuse across segments.
    pub fn combine_voice(&self, voice_formula: &str) -> Result<Vec<f32>> {
        voices::combine(&self.models_dir, voice_formula, &self.voice_cache)
    }

    /// Synthesize a text segment as a list of per-sub-chunk trimmed waveforms
    /// (reader mode emits each; quick-speak concatenates them).
    pub fn synth_segment_chunks(
        &self,
        segment: &str,
        lang: &str,
        combined: &[f32],
        speed: f32,
    ) -> Result<Vec<Vec<f32>>> {
        let ipa = phonemize::phonemize(segment, lang)?;
        let mut chunks: Vec<Vec<f32>> = Vec::new();
        for sub in text::create_phoneme_sub_chunks(&ipa, text::TOKENS_PER_CHUNK) {
            let tokens = tokenize::tokenize(&sub);
            if tokens.is_empty() {
                continue;
            }
            let style = voices::style_slice(combined, tokens.len())?;
            let wav = infer::infer(&self.session, &tokens, style, speed)?;
            chunks.push(audio::trim(&wav).to_vec());
        }
        Ok(chunks)
    }

    /// Synthesize one text segment → a single trimmed waveform (sub-chunks
    /// concatenated). Mirrors processChunk for a text unit.
    pub fn synth_segment(
        &self,
        segment: &str,
        lang: &str,
        combined: &[f32],
        speed: f32,
    ) -> Result<Vec<f32>> {
        Ok(self.synth_segment_chunks(segment, lang, combined, speed)?.concat())
    }

    /// Convenience: combine the voice and synthesize a single segment.
    pub fn generate_segment(
        &self,
        text: &str,
        lang: &str,
        voice_formula: &str,
        speed: f32,
    ) -> Result<Vec<f32>> {
        let combined = self.combine_voice(voice_formula)?;
        self.synth_segment(text, lang, &combined, speed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Integration tests need the ONNX dylib + a models dir + espeak data. They
    // skip (rather than fail) when ORT_DYLIB_PATH is not set, so plain
    // `cargo test` of the pure-logic modules still runs everywhere.
    fn test_engine() -> Option<Engine> {
        let dylib = std::env::var("ORT_DYLIB_PATH").ok()?;
        let models = std::env::var("OUT_LOUD_MODELS_DIR")
            .unwrap_or_else(|_| "/Users/vinnymac/Sites/vinnymac/out-loud/electron/models".into());
        let espeak = std::env::var("PIPER_ESPEAKNG_DATA_DIRECTORY")
            .unwrap_or_else(|_| "/usr/local/Cellar/espeak-ng/1.52.0/share".into());
        match Engine::new(models, dylib, espeak) {
            Ok(e) => Some(e),
            Err(e) => {
                eprintln!("engine init failed: {e}");
                None
            }
        }
    }

    #[test]
    fn generate_segment_smoke() {
        let Some(engine) = test_engine() else {
            eprintln!("skip generate_segment_smoke: set ORT_DYLIB_PATH to run");
            return;
        };
        let w = engine
            .generate_segment("this is a test of the speech engine", "en-us", "af_heart", 1.0)
            .expect("generate");
        // ~1.78 s of 24 kHz audio for this phrase (matches the Node engine).
        assert!(w.len() > 30_000, "waveform too short: {}", w.len());
        // deterministic
        let w2 = engine
            .generate_segment("this is a test of the speech engine", "en-us", "af_heart", 1.0)
            .unwrap();
        assert_eq!(w.len(), w2.len());
    }
}

// Generate a WAV via the engine for cross-checking against the Node engine.
use out_loud_engine::{audio, Engine};

fn main() {
    let dylib = std::env::var("ORT_DYLIB_PATH").unwrap();
    let models = std::env::var("OUT_LOUD_MODELS_DIR").unwrap();
    let espeak = std::env::var("PIPER_ESPEAKNG_DATA_DIRECTORY").unwrap();
    let text = std::env::var("GEN_TEXT").unwrap_or_else(|_| "this is a test of the speech engine".into());
    let voice = std::env::var("GEN_VOICE").unwrap_or_else(|_| "af_heart".into());
    let lang = std::env::var("GEN_LANG").unwrap_or_else(|_| "en-us".into());
    let out = std::env::var("GEN_OUT").unwrap_or_else(|_| "/tmp/engine.wav".into());

    let engine = Engine::new(models, dylib, espeak).unwrap();
    let w = engine.generate_segment(&text, &lang, &voice, 1.0).unwrap();
    eprintln!("samples: {}", w.len());
    std::fs::write(&out, audio::to_wav(&w).unwrap()).unwrap();
    eprintln!("wrote {out}");
}

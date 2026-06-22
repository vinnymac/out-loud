//! Starts the in-process native TTS engine (replaces the former Node sidecar).
//! The engine serves the same HTTP+WS contract on 127.0.0.1:51730, on its own
//! dedicated tokio runtime in a background thread. There is no child process to
//! kill — it dies with the app.
use out_loud_engine::server::{serve, ServeConfig};
use out_loud_engine::Engine;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

const API_PORT: u16 = 51730;
// macOS only for now (the Intel build target). TODO: win/linux dylib names.
const DYLIB_NAME: &str = "libonnxruntime.1.20.1.dylib";

struct Paths {
    models: PathBuf,
    dylib: PathBuf,
    espeak_data: PathBuf,
    openapi: PathBuf,
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key).ok().filter(|s| !s.is_empty()).map(PathBuf::from)
}

fn first_existing(cands: Vec<PathBuf>) -> Option<PathBuf> {
    cands.into_iter().find(|p| p.exists())
}

fn resolve(app: &AppHandle) -> Paths {
    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // …/tauri/src-tauri
        let root = manifest.parent().unwrap().to_path_buf(); // …/tauri
        let repo = root.parent().unwrap().to_path_buf(); // …/out-loud
        let res = manifest.join("resources");
        let dylib = first_existing(
            [
                env_path("OUT_LOUD_ORT_DYLIB"),
                Some(res.join("onnxruntime").join(DYLIB_NAME)),
                Some(root.join("node_modules/onnxruntime-node/bin/napi-v3/darwin/x64").join(DYLIB_NAME)),
            ]
            .into_iter()
            .flatten()
            .collect(),
        )
        .unwrap_or_else(|| res.join("onnxruntime").join(DYLIB_NAME));
        let espeak_data = first_existing(
            [
                env_path("PIPER_ESPEAKNG_DATA_DIRECTORY"),
                Some(res.join("espeak")),
                Some(PathBuf::from("/usr/local/Cellar/espeak-ng/1.52.0/share")),
                Some(PathBuf::from("/opt/homebrew/share")),
            ]
            .into_iter()
            .flatten()
            .collect(),
        )
        .unwrap_or_else(|| res.join("espeak"));
        Paths {
            models: repo.join("electron/models"),
            dylib,
            espeak_data,
            openapi: repo.join("docs/app/openapi.yaml"),
        }
    } else {
        let res = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
        Paths {
            models: res.join("models"),
            dylib: res.join("onnxruntime").join(DYLIB_NAME),
            espeak_data: res.join("espeak"),
            openapi: res.join("openapi.yaml"),
        }
    }
}

/// Spawn the engine on a dedicated multi-threaded tokio runtime in its own thread.
pub fn start(app: &AppHandle) {
    let paths = resolve(app);
    println!(
        "[engine] starting: models={} dylib={} espeak={}",
        paths.models.display(),
        paths.dylib.display(),
        paths.espeak_data.display()
    );
    let _ = std::thread::Builder::new().name("tts-engine".into()).spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[engine] failed to build runtime: {e}");
                return;
            }
        };
        rt.block_on(async move {
            let engine = match Engine::new(&paths.models, &paths.dylib, &paths.espeak_data) {
                Ok(e) => Arc::new(e),
                Err(e) => {
                    eprintln!("[engine] init failed: {e}");
                    return;
                }
            };
            let cfg = ServeConfig {
                port: API_PORT,
                openapi_path: Some(paths.openapi),
            };
            if let Err(e) = serve(engine, cfg).await {
                eprintln!("[engine] serve failed: {e}");
            }
        });
    });
}

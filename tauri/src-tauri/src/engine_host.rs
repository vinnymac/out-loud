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

// The onnxruntime dylib filename per OS (as shipped by onnxruntime-node 1.20.1
// and staged into resources/onnxruntime/ by stage-resources.mjs).
fn dylib_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.1.20.1.dylib"
    } else {
        "libonnxruntime.so.1.20.1"
    }
}

// onnxruntime-node binary layout for the dev fallback: bin/napi-v3/<plat>/<arch>.
fn napi_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}
fn napi_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

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
        let node_ort = root
            .join("node_modules/onnxruntime-node/bin/napi-v3")
            .join(napi_platform())
            .join(napi_arch())
            .join(dylib_name());
        let dylib = first_existing(
            [
                env_path("OUT_LOUD_ORT_DYLIB"),
                Some(res.join("onnxruntime").join(dylib_name())),
                Some(node_ort),
            ]
            .into_iter()
            .flatten()
            .collect(),
        )
        .unwrap_or_else(|| res.join("onnxruntime").join(dylib_name()));
        let espeak_data = first_existing(
            [
                env_path("PIPER_ESPEAKNG_DATA_DIRECTORY"),
                Some(res.join("espeak")),
                Some(repo.clone()), // vendored espeak-ng-data/ lives at the repo root
                Some(PathBuf::from("/usr/local/Cellar/espeak-ng/1.52.0/share")),
                Some(PathBuf::from("/opt/homebrew/share")),
                Some(PathBuf::from("/usr/share")),
                Some(PathBuf::from("/usr/lib/x86_64-linux-gnu")),
            ]
            .into_iter()
            .flatten()
            .collect(),
        )
        .unwrap_or_else(|| res.join("espeak"));
        Paths {
            models: repo.join("models"),
            dylib,
            espeak_data,
            openapi: repo.join("docs/app/openapi.yaml"),
        }
    } else {
        let res = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
        Paths {
            models: res.join("models"),
            dylib: res.join("onnxruntime").join(dylib_name()),
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

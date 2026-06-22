// Run the engine HTTP+WS server standalone for testing.
use out_loud_engine::server::{serve, ServeConfig};
use out_loud_engine::Engine;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dylib = std::env::var("ORT_DYLIB_PATH")?;
    let models = std::env::var("OUT_LOUD_MODELS_DIR")?;
    let espeak = std::env::var("PIPER_ESPEAKNG_DATA_DIRECTORY")?;
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(51730);
    let openapi = std::env::var("OUT_LOUD_OPENAPI_PATH").ok().map(Into::into);

    let engine = Arc::new(Engine::new(models, dylib, espeak)?);
    serve(engine, ServeConfig { port, openapi_path: openapi }).await
}

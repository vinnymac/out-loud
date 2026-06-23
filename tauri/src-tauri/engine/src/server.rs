//! HTTP + WebSocket server exposing the same `127.0.0.1:51730` contract the Node
//! sidecar served, so the Vue frontend and browser extensions are unchanged.
//!
//! Bound to loopback only (so the old non-localhost 403 check is unnecessary).
//! Telemetry is intentionally dropped: `/api/v1/telemetry` accepts and discards.
use crate::{audio, build_units, Engine, Unit};
use axum::{
    body::Bytes,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, watch};

const B64: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::STANDARD;

// ---- Shared settings (synced between app + extensions) ----

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SharedSettings {
    pub text: String,
    pub language: String,
    pub voice: String,
    pub volume: i64,
    #[serde(rename = "highlightChunk")]
    pub highlight_chunk: bool,
}

impl Default for SharedSettings {
    fn default() -> Self {
        Self {
            text: String::new(),
            language: "en-us".into(),
            voice: "af_heart".into(),
            volume: 80,
            highlight_chunk: false,
        }
    }
}

/// Voice prefix → espeak language code (mirrors getVoiceLang).
pub fn voice_lang(voice_id: &str) -> &'static str {
    match voice_id.get(0..2).unwrap_or("") {
        "af" | "am" => "en-us",
        "bf" | "bm" => "en-gb",
        "jf" | "jm" => "ja",
        "zf" | "zm" => "cmn",
        "ef" | "em" => "es-419",
        "hf" | "hm" => "hi",
        "if" | "im" => "it",
        "pf" | "pm" => "pt-br",
        _ => "en-us",
    }
}

fn voices_list() -> Value {
    json!({"voices": [
        {"id":"af_heart","name":"Heart","lang":"en-us","engine":"kokoro"},
        {"id":"af_bella","name":"Bella","lang":"en-us","engine":"kokoro"},
        {"id":"am_michael","name":"Michael","lang":"en-us","engine":"kokoro"},
        {"id":"am_adam","name":"Adam","lang":"en-us","engine":"kokoro"},
        {"id":"bf_emma","name":"Emma","lang":"en-gb","engine":"kokoro"},
        {"id":"bm_george","name":"George","lang":"en-gb","engine":"kokoro"},
        {"id":"jf_alpha","name":"Alpha","lang":"ja","engine":"kokoro"},
        {"id":"jm_kumo","name":"Kumo","lang":"ja","engine":"kokoro"},
        {"id":"zf_xiaobei","name":"Xiaobei","lang":"cmn","engine":"kokoro"},
        {"id":"zm_yunjian","name":"Yunjian","lang":"cmn","engine":"kokoro"},
    ]})
}

// ---- App state ----

#[derive(Clone)]
pub struct AppState {
    engine: Arc<Engine>,
    settings: Arc<Mutex<SharedSettings>>,
    settings_tx: broadcast::Sender<SharedSettings>,
    openapi_path: Option<PathBuf>,
}

pub struct ServeConfig {
    pub port: u16,
    pub openapi_path: Option<PathBuf>,
}

/// Start the server (runs until the process exits). Bind is loopback-only.
pub async fn serve(engine: Arc<Engine>, config: ServeConfig) -> anyhow::Result<()> {
    let (settings_tx, _) = broadcast::channel(16);
    let state = AppState {
        engine,
        settings: Arc::new(Mutex::new(SharedSettings::default())),
        settings_tx,
        openapi_path: config.openapi_path,
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/v1/audio/voices", get(get_voices))
        .route("/api/v1/settings", get(get_settings).post(post_settings))
        .route("/api/v1/audio/speech", post(speech))
        .route("/api/v1/audio/speech/stream", post(speech_stream))
        .route("/api/v1/openapi.yaml", get(openapi))
        .route("/api/v1/telemetry", post(telemetry))
        .route("/api/v1/extract-doc", post(extract_doc))
        .route("/ws", get(ws_handler))
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", config.port)).await?;
    println!("[engine] HTTP + WS server on http://127.0.0.1:{}", config.port);
    axum::serve(listener, app).await?;
    Ok(())
}

// ---- HTTP handlers ----

async fn health() -> Response {
    json_response(StatusCode::OK, json!({"ok": true}))
}

async fn get_voices() -> Response {
    json_response(StatusCode::OK, voices_list())
}

async fn get_settings(State(s): State<AppState>) -> Response {
    let settings = s.settings.lock().unwrap().clone();
    (StatusCode::OK, axum::Json(settings)).into_response()
}

async fn post_settings(State(s): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let updates: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return json_response(StatusCode::BAD_REQUEST, json!({"error": e.to_string()})),
    };
    let from_app = headers
        .get("x-out-loud-client")
        .and_then(|v| v.to_str().ok())
        == Some("app");

    let next = {
        let mut cur = s.settings.lock().unwrap();
        if let Some(t) = updates.get("text").and_then(Value::as_str) { cur.text = t.into(); }
        if let Some(t) = updates.get("language").and_then(Value::as_str) { cur.language = t.into(); }
        if let Some(t) = updates.get("voice").and_then(Value::as_str) { cur.voice = t.into(); }
        if let Some(t) = updates.get("volume").and_then(Value::as_i64) { cur.volume = t; }
        if let Some(t) = updates.get("highlightChunk").and_then(Value::as_bool) { cur.highlight_chunk = t; }
        cur.clone()
    };
    // Broadcast to WS clients unless the change came from the app itself.
    if !from_app {
        let _ = s.settings_tx.send(next.clone());
    }
    (StatusCode::OK, axum::Json(next)).into_response()
}

async fn openapi(State(s): State<AppState>) -> Response {
    match &s.openapi_path {
        Some(p) => match tokio::fs::read(p).await {
            Ok(bytes) => (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "application/yaml")],
                bytes,
            )
                .into_response(),
            Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": e.to_string()})),
        },
        None => json_response(StatusCode::NOT_FOUND, json!({"error": "openapi not configured"})),
    }
}

async fn telemetry() -> Response {
    // Telemetry intentionally dropped — accept and discard for contract compat.
    StatusCode::NO_CONTENT.into_response()
}

async fn extract_doc(body: Bytes) -> Response {
    match tokio::task::spawn_blocking(move || crate::office::extract_text(&body)).await {
        Ok(Ok(text)) => json_response(StatusCode::OK, json!({ "text": text })),
        _ => json_response(
            StatusCode::OK,
            json!({"error": "Couldn't read this document — it may be corrupt, encrypted, or not a supported format."}),
        ),
    }
}

/// Blocking synthesis (extension API). Returns the full audio in one response.
async fn speech(State(s): State<AppState>, body: Bytes) -> Response {
    let p: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return json_response(StatusCode::BAD_REQUEST, json!({"error": e.to_string()})),
    };
    let voice = p.get("voice").and_then(Value::as_str).unwrap_or("af_heart").to_string();
    let input = p.get("input").and_then(Value::as_str).unwrap_or("").to_string();
    let speed = p.get("speed").and_then(Value::as_f64).unwrap_or(1.0) as f32;
    let mp3 = p.get("response_format").and_then(Value::as_str) == Some("mp3");

    let engine = s.engine.clone();
    // Synthesize and encode (wav or real mp3) on the blocking pool.
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<(Vec<u8>, &'static str)> {
        let samples = synth_all(&engine, &input, &voice, speed)?;
        if mp3 {
            Ok((audio::to_mp3(&samples)?, "audio/mpeg"))
        } else {
            Ok((audio::to_wav(&samples)?, "audio/wav"))
        }
    })
    .await;
    match result {
        Ok(Ok((bytes, ct))) => ([(header::CONTENT_TYPE, ct)], bytes).into_response(),
        Ok(Err(e)) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": e.to_string()})),
        Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": e.to_string()})),
    }
}

/// Streaming synthesis (extension API). 12-byte LE frame per chunk:
/// [chunkIndex u32][totalChunks u32][wavLen u32][wav…].
async fn speech_stream(State(s): State<AppState>, body: Bytes) -> Response {
    let p: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return json_response(StatusCode::BAD_REQUEST, json!({"error": e.to_string()})),
    };
    let voice = p.get("voice").and_then(Value::as_str).unwrap_or("af_heart").to_string();
    let input = p.get("input").and_then(Value::as_str).unwrap_or("").to_string();
    let speed = p.get("speed").and_then(Value::as_f64).unwrap_or(1.0) as f32;

    let engine = s.engine.clone();
    let framed = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let chunks = synth_units(&engine, &input, &voice, speed)?;
        let total = chunks.len() as u32;
        let mut out = Vec::new();
        for (i, samples) in chunks.iter().enumerate() {
            let wav = audio::to_wav(samples)?;
            out.extend_from_slice(&(i as u32).to_le_bytes());
            out.extend_from_slice(&total.to_le_bytes());
            out.extend_from_slice(&(wav.len() as u32).to_le_bytes());
            out.extend_from_slice(&wav);
        }
        Ok(out)
    })
    .await;

    match framed {
        Ok(Ok(bytes)) => ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response(),
        Ok(Err(e)) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": e.to_string()})),
        Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": e.to_string()})),
    }
}

// ---- synthesis helpers (blocking; call inside spawn_blocking) ----

/// Per-unit waveforms for the full text (text segments synthesized, silences as
/// zero-fill). Used by the streaming endpoint and WS quick-speak.
fn synth_units(engine: &Engine, text: &str, voice: &str, speed: f32) -> anyhow::Result<Vec<Vec<f32>>> {
    let lang = voice_lang(voice);
    let combined = engine.combine_voice(voice)?;
    let mut out = Vec::new();
    for unit in build_units(text) {
        match unit {
            Unit::Text(seg) => out.push(engine.synth_segment(&seg, lang, &combined, speed)?),
            Unit::Silence(n) => out.push(vec![0f32; n]),
        }
    }
    Ok(out)
}

/// Full text → one concatenated waveform (blocking endpoint).
fn synth_all(engine: &Engine, text: &str, voice: &str, speed: f32) -> anyhow::Result<Vec<f32>> {
    Ok(synth_units(engine, text, voice, speed)?.concat())
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

// ---- WebSocket channel ----

#[derive(Clone, Copy)]
struct Ctl {
    target: i64,
    cancelled: bool,
}

type CtlMap = Arc<Mutex<HashMap<String, watch::Sender<Ctl>>>>;

async fn ws_handler(ws: WebSocketUpgrade, State(s): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, s))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    println!("[engine] App WS connected");
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();

    // Single writer owns the sink.
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
    });

    // hello
    let hello = json!({
        "type": "hello",
        "settings": &*state.settings.lock().unwrap(),
        "voices": voices_list()["voices"],
    });
    let _ = out_tx.send(Message::Text(hello.to_string().into()));

    // settings broadcast → this client
    let mut bcast = state.settings_tx.subscribe();
    let bcast_out = out_tx.clone();
    let bcast_task = tokio::spawn(async move {
        while let Ok(settings) = bcast.recv().await {
            let msg = json!({"type": "settings", "settings": settings});
            if bcast_out.send(Message::Text(msg.to_string().into())).is_err() {
                break;
            }
        }
    });

    let ctls: CtlMap = Arc::new(Mutex::new(HashMap::new()));
    let active_reader: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        handle_ws_message(v, &state, &out_tx, &ctls, &active_reader);
    }

    // Cleanup: cancel all in-flight work owned by this connection.
    for (_, tx) in ctls.lock().unwrap().drain() {
        tx.send_modify(|c| c.cancelled = true);
    }
    bcast_task.abort();
    writer.abort();
    println!("[engine] App WS disconnected");
}

fn handle_ws_message(
    v: Value,
    state: &AppState,
    out_tx: &mpsc::UnboundedSender<Message>,
    ctls: &CtlMap,
    active_reader: &Arc<Mutex<Option<String>>>,
) {
    let msg_type = v.get("type").and_then(Value::as_str).unwrap_or("");
    let request_id = v.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();

    match msg_type {
        "generate" => {
            let voice = v.get("voice").and_then(Value::as_str).unwrap_or("af_heart").to_string();
            let text = v.get("text").and_then(Value::as_str).unwrap_or("").to_string();
            let speed = v.get("speed").and_then(Value::as_f64).unwrap_or(1.0) as f32;
            let initial_target = v.get("initialTarget").and_then(Value::as_i64).unwrap_or(i64::MAX);

            let (tx, rx) = watch::channel(Ctl { target: initial_target, cancelled: false });
            ctls.lock().unwrap().insert(request_id.clone(), tx);
            tokio::spawn(run_generate(
                state.engine.clone(),
                out_tx.clone(),
                ctls.clone(),
                request_id,
                voice,
                text,
                speed,
                rx,
            ));
        }
        "setTarget" => {
            if let Some(target) = v.get("targetChunk").and_then(Value::as_i64) {
                if let Some(tx) = ctls.lock().unwrap().get(&request_id) {
                    tx.send_modify(|c| c.target = target);
                }
            }
        }
        "cancel" => {
            if let Some(tx) = ctls.lock().unwrap().get(&request_id) {
                tx.send_modify(|c| c.cancelled = true);
            }
        }
        "reader:generate" => {
            let voice = v.get("voice").and_then(Value::as_str).unwrap_or("af_heart").to_string();
            let units: Vec<(String, String)> = v
                .get("units")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|u| {
                            (
                                u.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                                u.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();

            // Cancel any previously active reader request.
            {
                let mut active = active_reader.lock().unwrap();
                if let Some(prev) = active.take() {
                    if prev != request_id {
                        if let Some(tx) = ctls.lock().unwrap().get(&prev) {
                            tx.send_modify(|c| c.cancelled = true);
                        }
                    }
                }
                *active = Some(request_id.clone());
            }
            let (tx, rx) = watch::channel(Ctl { target: i64::MAX, cancelled: false });
            ctls.lock().unwrap().insert(request_id.clone(), tx);
            tokio::spawn(run_reader(
                state.engine.clone(),
                out_tx.clone(),
                ctls.clone(),
                active_reader.clone(),
                request_id,
                voice,
                units,
                rx,
            ));
        }
        "reader:cancel" => {
            if let Some(tx) = ctls.lock().unwrap().get(&request_id) {
                tx.send_modify(|c| c.cancelled = true);
            }
        }
        _ => {}
    }
}

fn send_json(out_tx: &mpsc::UnboundedSender<Message>, v: Value) {
    let _ = out_tx.send(Message::Text(v.to_string().into()));
}

/// Quick-speak: one chunk per unit, in order, honouring backpressure (target)
/// and cancellation.
#[allow(clippy::too_many_arguments)]
async fn run_generate(
    engine: Arc<Engine>,
    out_tx: mpsc::UnboundedSender<Message>,
    ctls: CtlMap,
    request_id: String,
    voice: String,
    text: String,
    speed: f32,
    mut rx: watch::Receiver<Ctl>,
) {
    let lang = voice_lang(&voice);
    let combined = {
        let e = engine.clone();
        let v = voice.clone();
        match tokio::task::spawn_blocking(move || e.combine_voice(&v)).await {
            Ok(Ok(c)) => Arc::new(c),
            Ok(Err(e)) => {
                send_json(&out_tx, json!({"type":"error","requestId":request_id,"error":e.to_string()}));
                ctls.lock().unwrap().remove(&request_id);
                return;
            }
            Err(e) => {
                send_json(&out_tx, json!({"type":"error","requestId":request_id,"error":e.to_string()}));
                ctls.lock().unwrap().remove(&request_id);
                return;
            }
        }
    };

    let units = build_units(&text);
    let total = units.len();

    for (i, unit) in units.into_iter().enumerate() {
        // Backpressure: wait until i <= target, or cancelled.
        loop {
            let c = *rx.borrow();
            if c.cancelled {
                send_json(&out_tx, json!({"type":"cancelled","requestId":request_id}));
                ctls.lock().unwrap().remove(&request_id);
                return;
            }
            if (i as i64) <= c.target {
                break;
            }
            if rx.changed().await.is_err() {
                ctls.lock().unwrap().remove(&request_id);
                return;
            }
        }

        let samples = match unit {
            Unit::Silence(n) => vec![0f32; n],
            Unit::Text(seg) => {
                let e = engine.clone();
                let c = combined.clone();
                let lang = lang.to_string();
                match tokio::task::spawn_blocking(move || e.synth_segment(&seg, &lang, &c, speed)).await {
                    Ok(Ok(s)) => s,
                    Ok(Err(e)) => {
                        send_json(&out_tx, json!({"type":"error","requestId":request_id,"error":e.to_string()}));
                        ctls.lock().unwrap().remove(&request_id);
                        return;
                    }
                    Err(e) => {
                        send_json(&out_tx, json!({"type":"error","requestId":request_id,"error":e.to_string()}));
                        ctls.lock().unwrap().remove(&request_id);
                        return;
                    }
                }
            }
        };
        let wav = audio::to_wav(&samples).unwrap_or_default();
        let b64 = B64.encode(&wav);
        send_json(
            &out_tx,
            json!({"type":"chunk","requestId":request_id,"chunkIndex":i,"totalChunks":total,"base64":b64}),
        );
    }

    send_json(&out_tx, json!({"type":"complete","requestId":request_id}));
    ctls.lock().unwrap().remove(&request_id);
}

/// Reader: per-unit windowed synthesis, emitting reader:unitChunk per sub-chunk
/// and reader:unitDone after each unit. No client backpressure (matches Node).
#[allow(clippy::too_many_arguments)]
async fn run_reader(
    engine: Arc<Engine>,
    out_tx: mpsc::UnboundedSender<Message>,
    ctls: CtlMap,
    active_reader: Arc<Mutex<Option<String>>>,
    request_id: String,
    voice: String,
    units: Vec<(String, String)>,
    rx: watch::Receiver<Ctl>,
) {
    let lang = voice_lang(&voice);
    let cancelled = || rx.borrow().cancelled;

    let finish = |ctls: &CtlMap, active: &Arc<Mutex<Option<String>>>| {
        ctls.lock().unwrap().remove(&request_id);
        let mut a = active.lock().unwrap();
        if a.as_deref() == Some(request_id.as_str()) {
            *a = None;
        }
    };

    let combined = {
        let e = engine.clone();
        let v = voice.clone();
        match tokio::task::spawn_blocking(move || e.combine_voice(&v)).await {
            Ok(Ok(c)) => Arc::new(c),
            Ok(Err(e)) => {
                send_json(&out_tx, json!({"type":"reader:error","requestId":request_id,"error":e.to_string()}));
                finish(&ctls, &active_reader);
                return;
            }
            Err(e) => {
                send_json(&out_tx, json!({"type":"reader:error","requestId":request_id,"error":e.to_string()}));
                finish(&ctls, &active_reader);
                return;
            }
        }
    };

    for (unit_id, unit_text) in units {
        if cancelled() {
            send_json(&out_tx, json!({"type":"reader:aborted","requestId":request_id}));
            finish(&ctls, &active_reader);
            return;
        }
        // A unit's text → its own text/silence sub-units → per-sub-chunk audio.
        let mut emissions: Vec<Vec<f32>> = Vec::new();
        for sub in build_units(&unit_text) {
            match sub {
                Unit::Silence(n) => emissions.push(vec![0f32; n]),
                Unit::Text(seg) => {
                    let e = engine.clone();
                    let c = combined.clone();
                    let lang = lang.to_string();
                    match tokio::task::spawn_blocking(move || e.synth_segment_chunks(&seg, &lang, &c, 1.0)).await {
                        Ok(Ok(chunks)) => emissions.extend(chunks),
                        Ok(Err(e)) => {
                            send_json(&out_tx, json!({"type":"reader:error","requestId":request_id,"error":e.to_string()}));
                            finish(&ctls, &active_reader);
                            return;
                        }
                        Err(e) => {
                            send_json(&out_tx, json!({"type":"reader:error","requestId":request_id,"error":e.to_string()}));
                            finish(&ctls, &active_reader);
                            return;
                        }
                    }
                }
            }
            if cancelled() {
                send_json(&out_tx, json!({"type":"reader:aborted","requestId":request_id}));
                finish(&ctls, &active_reader);
                return;
            }
        }

        for samples in &emissions {
            let wav = audio::to_wav(samples).unwrap_or_default();
            let b64 = B64.encode(&wav);
            send_json(
                &out_tx,
                json!({"type":"reader:unitChunk","requestId":request_id,"unitId":unit_id,"base64":b64,"mimeType":"audio/wav"}),
            );
        }
        send_json(&out_tx, json!({"type":"reader:unitDone","requestId":request_id,"unitId":unit_id}));
    }

    send_json(&out_tx, json!({"type":"reader:genComplete","requestId":request_id}));
    finish(&ctls, &active_reader);
}

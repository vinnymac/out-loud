// WebSocket client to the TTS engine (the Node sidecar). It faithfully carries
// the worker's bidirectional protocol — generate / setTarget / cancel from the
// app, and chunk / complete / error / cancelled back — so backpressure,
// cancellation and forced-full export all behave exactly as in the Electron
// build. Auto-reconnects because the sidecar may still be starting up.
import { WS_URL, type SharedSettings } from "./ipc";

export interface GenerateParams {
  voice: string;
  text: string;
  speed?: number;
  requestId: string;
  initialTarget?: number;
}

export interface ChunkData {
  chunkIndex: number;
  totalChunks: number;
  base64: string;
}

export interface GenerateHandlers {
  onChunk?: (data: ChunkData) => void;
  onComplete?: () => void;
  onError?: (error: string) => void;
  onCancelled?: () => void;
}

const handlers = new Map<string, GenerateHandlers>();
const settingsListeners = new Set<(s: SharedSettings) => void>();
const connectListeners = new Set<(connected: boolean) => void>();

let ws: WebSocket | null = null;
let connected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let outbox: string[] = [];

function setConnected(value: boolean) {
  if (connected === value) return;
  connected = value;
  connectListeners.forEach((cb) => cb(value));
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    setConnected(true);
    const pending = outbox;
    outbox = [];
    for (const msg of pending) ws?.send(msg);
  };
  ws.onclose = () => {
    setConnected(false);
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose will follow and trigger the reconnect.
  };
  ws.onmessage = (e) => {
    let msg: any;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    route(msg);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 600);
}

function route(msg: any) {
  switch (msg.type) {
    case "hello":
    case "settings":
      if (msg.settings) settingsListeners.forEach((cb) => cb(msg.settings));
      break;
    case "chunk": {
      const h = handlers.get(msg.requestId);
      h?.onChunk?.({
        chunkIndex: msg.chunkIndex,
        totalChunks: msg.totalChunks,
        base64: msg.base64,
      });
      break;
    }
    case "complete": {
      const h = handlers.get(msg.requestId);
      handlers.delete(msg.requestId);
      h?.onComplete?.();
      break;
    }
    case "cancelled": {
      const h = handlers.get(msg.requestId);
      handlers.delete(msg.requestId);
      h?.onCancelled?.();
      break;
    }
    case "error": {
      const h = handlers.get(msg.requestId);
      handlers.delete(msg.requestId);
      h?.onError?.(msg.error);
      break;
    }
  }
}

function send(obj: unknown) {
  const data = JSON.stringify(obj);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  } else {
    outbox.push(data);
    connect();
  }
}

export function ensureConnected() {
  connect();
}

export function isConnected() {
  return connected;
}

/** Resolve true once connected, or false after `timeoutMs`. */
export function waitConnected(timeoutMs: number): Promise<boolean> {
  if (connected) return Promise.resolve(true);
  ensureConnected();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      connectListeners.delete(onChange);
      resolve(false);
    }, timeoutMs);
    const onChange = (value: boolean) => {
      if (value) {
        clearTimeout(timer);
        connectListeners.delete(onChange);
        resolve(true);
      }
    };
    connectListeners.add(onChange);
  });
}

export function generate(params: GenerateParams, h: GenerateHandlers) {
  handlers.set(params.requestId, h);
  send({
    type: "generate",
    requestId: params.requestId,
    voice: params.voice,
    text: params.text,
    speed: params.speed ?? 1,
    initialTarget: params.initialTarget,
  });
}

export function setBufferTarget(requestId: string, targetChunk: number) {
  send({ type: "setTarget", requestId, targetChunk });
}

export function forceFullGeneration(requestId: string) {
  send({ type: "setTarget", requestId, targetChunk: Number.MAX_SAFE_INTEGER });
}

export function cancelGeneration(requestId: string) {
  handlers.delete(requestId);
  send({ type: "cancel", requestId });
}

export function onSettings(cb: (s: SharedSettings) => void): () => void {
  settingsListeners.add(cb);
  return () => settingsListeners.delete(cb);
}

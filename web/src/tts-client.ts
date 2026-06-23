// Web replacement for the desktop `tauri/src/lib/tts-client.ts`. Exposes the
// identical public surface (generate / setBufferTarget / forceFullGeneration /
// cancelGeneration / waitConnected / ensureConnected / isConnected / onSettings)
// so the shared useTts.ts is unchanged — but the transport is a Web Worker
// running the in-browser TTS engine, not a WebSocket to a local server.
//
// Extra, web-only exports (onEngineProgress / warmEngine) drive the StartGate
// download interstitial. The Vite seamSwap plugin redirects `~/lib/tts-client`
// imports here.
import { DEFAULT_MODEL, DEFAULT_VOICE } from "./engine/assets";
import type { WorkerRequest, WorkerResponse, EngineProgress } from "./protocol";
import type { SharedSettings } from "~/lib/ipc";

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

// useTts keeps the engine ~20 chunks ahead of the playhead; mirror that default
// when a caller doesn't pass an explicit target.
const DEFAULT_INITIAL_TARGET = 20;

const handlers = new Map<string, GenerateHandlers>();
const progressListeners = new Set<(p: EngineProgress) => void>();
const readyListeners = new Set<(ready: boolean) => void>();

let worker: Worker | null = null;
let ready = false;
let warmResolve: (() => void) | null = null;
let warmReject: ((err: Error) => void) | null = null;

function setReady(value: boolean) {
  if (ready === value) return;
  ready = value;
  readyListeners.forEach((cb) => cb(value));
}

function send(msg: WorkerRequest) {
  ensureConnected();
  worker?.postMessage(msg);
}

function route(msg: WorkerResponse) {
  switch (msg.kind) {
    case "ready":
      setReady(true);
      break;
    case "progress":
      progressListeners.forEach((cb) => cb(msg.progress));
      break;
    case "warmed":
      warmResolve?.();
      warmResolve = warmReject = null;
      break;
    case "warmError":
      warmReject?.(new Error(msg.error));
      warmResolve = warmReject = null;
      break;
    case "chunk": {
      handlers.get(msg.requestId)?.onChunk?.({
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

export function ensureConnected() {
  if (worker) return;
  worker = new Worker(new URL("./tts.worker.ts", import.meta.url), {
    type: "module",
    name: "out-loud-tts",
  });
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => route(e.data);
  worker.onerror = () => {
    // A worker construction/runtime failure surfaces as an engine error on any
    // in-flight request rather than a silent hang.
    handlers.forEach((h) => h.onError?.("The speech engine failed to start."));
    handlers.clear();
  };
}

export function isConnected() {
  return ready;
}

/** Resolve true once the worker is ready, or false after `timeoutMs`. */
export function waitConnected(timeoutMs: number): Promise<boolean> {
  if (ready) return Promise.resolve(true);
  ensureConnected();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      readyListeners.delete(onChange);
      resolve(false);
    }, timeoutMs);
    const onChange = (value: boolean) => {
      if (value) {
        clearTimeout(timer);
        readyListeners.delete(onChange);
        resolve(true);
      }
    };
    readyListeners.add(onChange);
  });
}

export function generate(params: GenerateParams, h: GenerateHandlers) {
  handlers.set(params.requestId, h);
  send({
    kind: "generate",
    requestId: params.requestId,
    voice: params.voice,
    text: params.text,
    speed: params.speed ?? 1,
    initialTarget: params.initialTarget ?? DEFAULT_INITIAL_TARGET,
    model: DEFAULT_MODEL,
  });
}

export function setBufferTarget(requestId: string, targetChunk: number) {
  send({ kind: "setTarget", requestId, targetChunk });
}

export function forceFullGeneration(requestId: string) {
  send({ kind: "setTarget", requestId, targetChunk: Number.MAX_SAFE_INTEGER });
}

export function cancelGeneration(requestId: string) {
  handlers.delete(requestId);
  send({ kind: "cancel", requestId });
}

// On desktop the settings broadcast keeps browser extensions in sync via the
// server. The web build has no such peer, so this never fires; the subscription
// exists only to satisfy useSettings.
export function onSettings(_cb: (s: SharedSettings) => void): () => void {
  return () => {};
}

// ---- Web-only: drive the StartGate interstitial ----

/** Subscribe to engine download/load progress (warm + first synthesis). */
export function onEngineProgress(cb: (p: EngineProgress) => void): () => void {
  progressListeners.add(cb);
  return () => progressListeners.delete(cb);
}

/** Pre-fetch the model + default voice. Resolves when the engine is warm. */
export function warmEngine(model = DEFAULT_MODEL, voice?: string): Promise<void> {
  ensureConnected();
  return new Promise<void>((resolve, reject) => {
    warmResolve = resolve;
    warmReject = reject;
    send({ kind: "warm", model, voice: voice ?? DEFAULT_VOICE });
  });
}

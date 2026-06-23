// Message contract between the window (web/src/tts-client.ts) and the TTS Web
// Worker (web/src/tts.worker.ts). The worker plays the role the local Rust
// server plays on desktop: it speaks the same generate / chunk / complete /
// cancel / setTarget protocol, just over postMessage instead of WebSocket — so
// the shared `useTts.ts` and every UI component stay identical.

export interface EngineProgress {
  /** Coarse phase: "download" | "model" | "voice" | "init" | "process" | "generate" | "finalize" | "warm". */
  stage: string;
  /** 0–100 for the current stage (best-effort; byte-accurate during downloads). */
  progress: number;
  message: string;
}

/** window → worker */
export type WorkerRequest =
  | { kind: "warm"; model: string; voice: string }
  | {
      kind: "generate";
      requestId: string;
      voice: string;
      text: string;
      speed: number;
      initialTarget: number;
      model: string;
    }
  | { kind: "setTarget"; requestId: string; targetChunk: number }
  | { kind: "cancel"; requestId: string };

/** worker → window */
export type WorkerResponse =
  | { kind: "ready" }
  | { kind: "progress"; requestId: string | null; progress: EngineProgress }
  | { kind: "warmed" }
  | { kind: "warmError"; error: string }
  | { kind: "chunk"; requestId: string; chunkIndex: number; totalChunks: number; base64: string }
  | { kind: "complete"; requestId: string }
  | { kind: "error"; requestId: string; error: string }
  | { kind: "cancelled"; requestId: string };

/// <reference lib="webworker" />
// The TTS Web Worker — the browser's stand-in for the desktop's local Rust
// server. It speaks the same protocol (generate / setTarget / cancel → chunk /
// complete / error / cancelled) over postMessage, so the shared useTts.ts drives
// it unchanged. Backpressure falls out of the engine's pull-based generator: we
// only call .next() (which runs the next inference) when useTts's target allows.

import { warm, synthesize } from "./engine/tts-engine";
import type { WorkerRequest, WorkerResponse, EngineProgress } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const block = 0x8000;
  for (let i = 0; i < bytes.length; i += block) {
    binary += String.fromCharCode(...bytes.subarray(i, i + block));
  }
  return btoa(binary);
}

interface RequestState {
  target: number;
  cancelled: boolean;
  wake: (() => void) | null;
  gen: AsyncGenerator<{ wav: ArrayBuffer; totalChunks: number }> | null;
}

const active = new Map<string, RequestState>();

async function handleGenerate(req: Extract<WorkerRequest, { kind: "generate" }>): Promise<void> {
  const state: RequestState = {
    target: req.initialTarget,
    cancelled: false,
    wake: null,
    gen: null,
  };
  active.set(req.requestId, state);

  const onProgress = (e: EngineProgress) =>
    post({ kind: "progress", requestId: req.requestId, progress: e });

  let emitted = 0;
  try {
    const gen = synthesize(
      { text: req.text, voice: req.voice, speed: req.speed, model: req.model },
      onProgress
    );
    state.gen = gen;

    for (;;) {
      if (state.cancelled) break;
      // Backpressure: don't compute/emit chunk `emitted` until useTts's target
      // reaches it. Parked here, the worker still drains its message queue, so
      // setTarget/cancel land and wake() resumes us.
      while (emitted > state.target && !state.cancelled) {
        await new Promise<void>((resolve) => {
          state.wake = resolve;
        });
        state.wake = null;
      }
      if (state.cancelled) break;

      const { value, done } = await gen.next();
      if (done) {
        post({ kind: "complete", requestId: req.requestId });
        active.delete(req.requestId);
        return;
      }
      post({
        kind: "chunk",
        requestId: req.requestId,
        chunkIndex: emitted,
        totalChunks: value.totalChunks,
        base64: arrayBufferToBase64(value.wav),
      });
      emitted++;
    }

    // Cancelled mid-stream.
    await safeReturn(state.gen);
    post({ kind: "cancelled", requestId: req.requestId });
    active.delete(req.requestId);
  } catch (err) {
    await safeReturn(state.gen);
    if (state.cancelled) post({ kind: "cancelled", requestId: req.requestId });
    else post({ kind: "error", requestId: req.requestId, error: errorMessage(err) });
    active.delete(req.requestId);
  }
}

async function safeReturn(
  gen: AsyncGenerator<{ wav: ArrayBuffer; totalChunks: number }> | null
): Promise<void> {
  try {
    await gen?.return(undefined as never);
  } catch {
    /* ignore */
  }
}

async function handleWarm(req: Extract<WorkerRequest, { kind: "warm" }>): Promise<void> {
  try {
    await warm(req.model, req.voice, (e) =>
      post({ kind: "progress", requestId: null, progress: e })
    );
    post({ kind: "warmed" });
  } catch (err) {
    post({ kind: "warmError", error: errorMessage(err) });
  }
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.kind) {
    case "warm":
      void handleWarm(msg);
      break;
    case "generate":
      void handleGenerate(msg);
      break;
    case "setTarget": {
      const state = active.get(msg.requestId);
      if (state) {
        state.target = Math.max(state.target, msg.targetChunk);
        state.wake?.();
      }
      break;
    }
    case "cancel": {
      const state = active.get(msg.requestId);
      if (state) {
        state.cancelled = true;
        state.wake?.();
      }
      break;
    }
  }
};

// Tell the window the worker module has loaded (waitConnected resolves on this).
post({ kind: "ready" });

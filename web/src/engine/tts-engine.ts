// Out Loud TTS engine — runs entirely in the browser.
//
// Ported from chrome-extension/src/tts-engine.js (dormant there) and adapted for
// the web app: TypeScript, a streaming async generator (one WAV chunk at a time
// for backpressure + early playback), byte-level download progress, and a
// warm() entry the StartGate uses to pre-fetch the model behind an interstitial.
//
// The pipeline is the SAME parity-proven algorithm shipped in the native Rust
// engine: 149-entry vocab (unknown → 16), input_ids = [0, ...tokens, 0], voice
// embedding reshaped to [510,1,256] with ref_s = voice[tokenLen-1], and the
// identical trim (256-window, 5% threshold, +256 sample buffer). Kokoro-82M ONNX
// runs via onnxruntime-web; espeak-ng WASM does phonemization. Assets stream from
// HuggingFace + jsDelivr and are cached in CacheStorage after first load.

import * as ort from "onnxruntime-web";
import { CACHE_NAME, DEFAULT_MODEL, DEFAULT_VOICE, MODELS, modelUrl, voiceUrl } from "./assets";

// ---- Constants ----

const MODEL_CONTEXT_WINDOW = 512;
const TOKENS_PER_CHUNK = MODEL_CONTEXT_WINDOW - 2;
const SAMPLE_RATE = 24000;

const ESPEAK_NG_VERSION = "1.0.2";
const ESPEAK_NG_WASM_URL = `https://cdn.jsdelivr.net/npm/espeak-ng@${ESPEAK_NG_VERSION}/dist/espeak-ng.wasm`;
// The package ships dist/espeak-ng.js (ESM with `export default ESpeakNG`) — NOT
// a .mjs (that path 404s; the original dormant engine had it wrong).
const ESPEAK_NG_JS_URL = `https://cdn.jsdelivr.net/npm/espeak-ng@${ESPEAK_NG_VERSION}/dist/espeak-ng.js`;
// Keep the ORT WASM runtime pinned to the SAME version as the imported package
// (package.json: onnxruntime-web@1.23.2) — a mismatch silently breaks ops.
const ORT_VERSION = "1.23.2";

// Language espeak voice ids, keyed by the app's language id.
const LANGS: Record<string, string> = {
  "en-us": "en-us",
  "en-gb": "en-gb",
  ja: "ja",
  cmn: "cmn",
  "es-419": "es-419",
  hi: "hi",
  it: "it",
  "pt-br": "pt-br",
};

// Voice id prefix → language id. Lets the worker derive language from the voice
// alone (matches the desktop, where voice selection drives language).
const VOICE_PREFIX_LANG: Record<string, string> = {
  a: "en-us", // af_*, am_*
  b: "en-gb", // bf_*, bm_*
  j: "ja",
  z: "cmn",
  e: "es-419",
  h: "hi",
  i: "it",
  p: "pt-br",
};

// Tokenizer vocabulary. Slots 14/15 are the LEFT/RIGHT double quotation marks,
// written as Unicode escapes so formatters don't normalize them to ASCII ".
const VOCAB: Record<string, number> = {
  ";": 1,
  ":": 2,
  ",": 3,
  ".": 4,
  "!": 5,
  "?": 6,
  "—": 9,
  "…": 10,
  '"': 11,
  "(": 12,
  ")": 13,
  "“": 14,
  "”": 15,
  " ": 16,
  "̃": 17,
  ʣ: 18,
  ʥ: 19,
  ʦ: 20,
  ʨ: 21,
  ᵝ: 22,
  ꭧ: 23,
  A: 24,
  I: 25,
  O: 31,
  Q: 33,
  S: 35,
  T: 36,
  W: 39,
  Y: 41,
  ᵊ: 42,
  a: 43,
  b: 44,
  c: 45,
  d: 46,
  e: 47,
  f: 48,
  h: 50,
  i: 51,
  j: 52,
  k: 53,
  l: 54,
  m: 55,
  n: 56,
  o: 57,
  p: 58,
  q: 59,
  r: 60,
  s: 61,
  t: 62,
  u: 63,
  v: 64,
  w: 65,
  x: 66,
  y: 67,
  z: 68,
  ɑ: 69,
  ɐ: 70,
  ɒ: 71,
  æ: 72,
  β: 75,
  ɔ: 76,
  ɕ: 77,
  ç: 78,
  ɖ: 80,
  ð: 81,
  ʤ: 82,
  ə: 83,
  ɚ: 85,
  ɛ: 86,
  ɜ: 87,
  ɟ: 90,
  ɡ: 92,
  ɥ: 99,
  ɨ: 101,
  ɪ: 102,
  ʝ: 103,
  ɯ: 110,
  ɰ: 111,
  ŋ: 112,
  ɳ: 113,
  ɲ: 114,
  ɴ: 115,
  ø: 116,
  ɸ: 118,
  θ: 119,
  œ: 120,
  ɹ: 123,
  ɾ: 125,
  ɻ: 126,
  ʁ: 128,
  ɽ: 129,
  ʂ: 130,
  ʃ: 131,
  ʈ: 132,
  ʧ: 133,
  ʊ: 135,
  ʋ: 136,
  ʌ: 138,
  ɣ: 139,
  ɤ: 140,
  χ: 142,
  ʎ: 143,
  ʒ: 147,
  ʔ: 148,
  ˈ: 156,
  ˌ: 157,
  ː: 158,
  ʰ: 162,
  ʲ: 164,
  "↓": 169,
  "→": 171,
  "↗": 172,
  "↘": 173,
  ᵻ: 177,
};

// ---- Types ----

export interface ProgressEvent {
  stage: string;
  progress: number;
  message: string;
}
export type ProgressCallback = (e: ProgressEvent) => void;

export interface SynthChunk {
  /** 32-bit-float WAV (24 kHz mono) for a single audio chunk. */
  wav: ArrayBuffer;
  /** Upper bound on the number of chunks this synthesis will emit. */
  totalChunks: number;
}

export interface SynthParams {
  text: string;
  voice: string;
  speed?: number;
  model?: string;
}

// ---- Module cache ----

interface EngineCache {
  session: ort.InferenceSession | null;
  modelId: string | null;
  voices: Map<string, number[][][]>;
  espeakFactory: EspeakFactory | null;
}

type EspeakFactory = (opts: {
  locateFile: () => string;
  arguments: string[];
}) => Promise<{ FS: { readFile: (path: string, opts: { encoding: "utf8" }) => string } }>;

const cache: EngineCache = {
  session: null,
  modelId: null,
  voices: new Map(),
  espeakFactory: null,
};

// ---- Asset loading ----

/**
 * Download with CacheStorage caching and byte-level progress. Streams the
 * response body so a big model reports real progress instead of a 0→100 jump.
 */
async function downloadFile(
  url: string,
  label: string,
  onProgress?: ProgressCallback
): Promise<ArrayBuffer> {
  try {
    const store = await caches.open(CACHE_NAME);
    const hit = await store.match(url);
    if (hit) return await hit.arrayBuffer();
  } catch {
    /* CacheStorage unavailable (e.g. insecure context) — fall through to fetch */
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get("Content-Length")) || 0;
  const reader = response.body?.getReader();

  let buffer: Uint8Array<ArrayBuffer>;
  if (!reader) {
    buffer = new Uint8Array(await response.arrayBuffer());
  } else {
    const parts: Uint8Array[] = [];
    let received = 0;
    onProgress?.({ stage: "download", progress: 0, message: `Downloading ${label}…` });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
      onProgress?.({
        stage: "download",
        progress: pct,
        message:
          total > 0
            ? `Downloading ${label}… ${formatMB(received)} / ${formatMB(total)}`
            : `Downloading ${label}… ${formatMB(received)}`,
      });
    }
    buffer = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
      buffer.set(part, offset);
      offset += part.length;
    }
  }

  try {
    const store = await caches.open(CACHE_NAME);
    await store.put(url, new Response(buffer.slice(0)));
  } catch {
    /* caching is best-effort */
  }

  onProgress?.({ stage: "download", progress: 100, message: `Downloaded ${label}` });
  return buffer.buffer;
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadModel(
  modelId: string,
  onProgress?: ProgressCallback
): Promise<ort.InferenceSession> {
  if (cache.session && cache.modelId === modelId) return cache.session;

  const info = MODELS[modelId] ?? MODELS[DEFAULT_MODEL];
  onProgress?.({ stage: "model", progress: 0, message: `Loading model ${info.name}…` });
  const buffer = await downloadFile(modelUrl(modelId), info.name, onProgress);

  onProgress?.({ stage: "init", progress: 50, message: "Initializing ONNX runtime…" });
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  const session = await ort.InferenceSession.create(buffer, { executionProviders: ["wasm"] });

  cache.session = session;
  cache.modelId = modelId;
  onProgress?.({ stage: "model", progress: 100, message: "Model loaded" });
  return session;
}

async function loadVoice(voiceId: string, onProgress?: ProgressCallback): Promise<number[][][]> {
  const cached = cache.voices.get(voiceId);
  if (cached) return cached;

  onProgress?.({ stage: "voice", progress: 0, message: "Loading voice…" });
  const buffer = await downloadFile(voiceUrl(voiceId), `voice ${voiceId}`, onProgress);

  // The .bin is 130560 float32 = [510, 1, 256] (one 256-d style vector per
  // possible unpadded token length).
  const flat = new Float32Array(buffer);
  const reshaped: number[][][] = [];
  for (let from = 0; from < flat.length; from += 256) {
    const to = Math.min(from + 256, flat.length);
    reshaped.push([Array.from(flat.slice(from, to))]);
  }
  cache.voices.set(voiceId, reshaped);
  onProgress?.({ stage: "voice", progress: 100, message: "Voice loaded" });
  return reshaped;
}

async function loadEspeakFactory(): Promise<EspeakFactory> {
  if (cache.espeakFactory) return cache.espeakFactory;
  const mod = (await import(/* @vite-ignore */ ESPEAK_NG_JS_URL)) as { default: EspeakFactory };
  cache.espeakFactory = mod.default;
  return mod.default;
}

// ---- Phonemization ----

function normalizeText(text: string): string {
  return text
    .replaceAll("'", "'")
    .replaceAll("'", "'")
    .replaceAll("«", "(")
    .replaceAll("»", ")")
    .replaceAll('"', '"')
    .replaceAll('"', '"')
    .replace(/、/g, ", ")
    .replace(/。/g, ". ")
    .replace(/！/g, "! ")
    .replace(/，/g, ", ")
    .replace(/：/g, ": ")
    .replace(/；/g, "; ")
    .replace(/？/g, "? ")
    .replaceAll("\n", "  ")
    .replaceAll("\t", "  ")
    .trim();
}

async function phonemize(text: string, langId: string): Promise<string> {
  const espeakId = LANGS[langId] ?? LANGS["en-us"];
  const normalized = normalizeText(text);
  const factory = await loadEspeakFactory();
  const espeak = await factory({
    locateFile: () => ESPEAK_NG_WASM_URL,
    arguments: ["--phonout", "generated", "-q", "--ipa", "-v", espeakId, normalized],
  });
  const generated = espeak.FS.readFile("generated", { encoding: "utf8" });
  return generated.split("\n").join(" ").trim();
}

// ---- Text → chunks ----

function sanitizeText(rawText: string): string {
  return rawText
    .replace(/\.\s+/g, "[0.4s]")
    .replace(/,\s+/g, "[0.2s]")
    .replace(/;\s+/g, "[0.4s]")
    .replace(/:\s+/g, "[0.3s]")
    .replace(/!\s+/g, "![0.1s]")
    .replace(/\?\s+/g, "?[0.1s]")
    .replace(/\n+/g, "[0.4s]")
    .trim();
}

function segmentText(sanitized: string): string[] {
  const regex = /(\[[0-9]+(?:\.[0-9]+)?s\])/g;
  return sanitized
    .split(regex)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function isSilenceMarker(segment: string): boolean {
  return /^\[[0-9]+(?:\.[0-9]+)?s\]$/.test(segment.trim());
}

function extractSilenceDuration(marker: string): number {
  const match = marker.trim().match(/^\[([0-9]+(?:\.[0-9]+)?)s\]$/);
  return match ? parseFloat(match[1]) : 0;
}

function createPhonemeSubChunks(phonemes: string, tokensPerChunk: number): string[] {
  if (phonemes.length <= tokensPerChunk) return [phonemes];
  const chunks: string[] = [];
  let current = "";
  for (const phoneme of phonemes) {
    if (current.length >= tokensPerChunk) {
      chunks.push(current);
      current = "";
    }
    current += phoneme;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function tokenize(phonemes: string): number[] {
  const fallback = 16;
  return [...phonemes].map((char) => VOCAB[char] ?? fallback);
}

type Unit = { type: "silence"; durationSeconds: number } | { type: "text"; tokens: number[] };

async function preprocessText(text: string, langId: string): Promise<Unit[]> {
  const units: Unit[] = [];
  for (const segment of segmentText(sanitizeText(text))) {
    if (isSilenceMarker(segment)) {
      units.push({ type: "silence", durationSeconds: extractSilenceDuration(segment) });
      continue;
    }
    const phonemized = await phonemize(segment, langId);
    for (const sub of createPhonemeSubChunks(phonemized, TOKENS_PER_CHUNK)) {
      units.push({ type: "text", tokens: tokenize(sub) });
    }
  }
  return units;
}

// ---- Voices ----

interface WeightedVoice {
  voiceId: string;
  weight: number;
}

function parseVoiceFormula(formula: string): WeightedVoice[] {
  const cleaned = formula.replace(/\s+/g, "");
  if (cleaned === "") throw new Error("Voice formula cannot be empty");

  const terms = cleaned.split("+").filter((t) => t !== "");
  if (terms.length === 1 && !terms[0].includes("*")) {
    return [{ voiceId: terms[0], weight: 1 }];
  }

  const voices: WeightedVoice[] = [];
  for (const term of terms) {
    if (!term.includes("*")) throw new Error(`Invalid term: ${term}`);
    const [voiceId, weightStr] = term.split("*");
    let weight = parseFloat(weightStr);
    if (isNaN(weight) || weight < 0 || weight > 1) {
      throw new Error(`Invalid weight for voice ${voiceId}`);
    }
    weight = Math.round(weight * 10) / 10;
    voices.push({ voiceId, weight });
  }

  const totalWeight = voices.reduce((sum, v) => sum + v.weight, 0);
  if (Math.round(totalWeight * 10) / 10 !== 1) {
    throw new Error(`Weights must sum to 1, got ${totalWeight}`);
  }
  return voices;
}

async function combineVoices(
  voices: WeightedVoice[],
  onProgress?: ProgressCallback
): Promise<number[][][]> {
  if (voices.length === 0) throw new Error("At least one voice required");

  const arrays = await Promise.all(voices.map((v) => loadVoice(v.voiceId, onProgress)));
  if (arrays.length === 1 && voices[0].weight === 1) return arrays[0];

  const chunks = arrays[0].length;
  const inner = arrays[0][0].length;
  const len = arrays[0][0][0].length;

  const combined: number[][][] = [];
  for (let i = 0; i < chunks; i++) {
    combined[i] = [];
    for (let j = 0; j < inner; j++) combined[i][j] = new Array(len).fill(0);
  }
  for (let v = 0; v < arrays.length; v++) {
    const weight = voices[v].weight;
    const voice = arrays[v];
    for (let i = 0; i < chunks; i++) {
      for (let j = 0; j < inner; j++) {
        for (let k = 0; k < len; k++) combined[i][j][k] += weight * voice[i][j][k];
      }
    }
  }
  return combined;
}

/** First voice's prefix → app language id (af_heart → en-us). */
export function voiceToLang(formula: string): string {
  const first = formula.replace(/\s+/g, "").split(/[+*]/)[0] ?? "";
  return VOICE_PREFIX_LANG[first[0]] ?? "en-us";
}

// ---- Inference + audio ----

function runInference(
  session: ort.InferenceSession,
  tokens: number[],
  refS: number[],
  speed: number
): Promise<Float32Array> {
  const padded = [0, ...tokens, 0];
  const inputIds = new ort.Tensor("int64", BigInt64Array.from(padded.map(BigInt)), [
    1,
    padded.length,
  ]);
  const style = new ort.Tensor("float32", Float32Array.from(refS), [1, refS.length]);
  const speedTensor = new ort.Tensor("float32", Float32Array.from([speed]), [1]);
  return session
    .run({ input_ids: inputIds, style, speed: speedTensor })
    .then((result) => result.waveform.data as Float32Array);
}

/** Trim leading/trailing near-silence (256-window, 5% threshold, +256 buffer). */
function trimWaveform(waveform: Float32Array): Float32Array {
  const windowSize = 256;
  const bufferSamples = 256;
  const numWindows = Math.ceil(waveform.length / windowSize);
  const amps = new Float32Array(numWindows);
  let maxAmp = 0;

  for (let i = 0; i < numWindows; i++) {
    const start = i * windowSize;
    const end = Math.min(start + windowSize, waveform.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += Math.abs(waveform[j]);
    const avg = sum / (end - start);
    amps[i] = avg;
    if (avg > maxAmp) maxAmp = avg;
  }

  const threshold = maxAmp * 0.05;

  let startSample = 0;
  for (let i = 0; i < numWindows; i++) {
    if (amps[i] > threshold) {
      const winStart = i * windowSize;
      const winEnd = Math.min(winStart + windowSize, waveform.length);
      for (let j = winStart; j < winEnd; j++) {
        if (Math.abs(waveform[j]) > threshold) {
          startSample = j;
          break;
        }
      }
      break;
    }
  }

  let endSample = waveform.length;
  for (let i = numWindows - 1; i >= 0; i--) {
    if (amps[i] > threshold) {
      const winStart = i * windowSize;
      const winEnd = Math.min(winStart + windowSize, waveform.length);
      for (let j = winEnd - 1; j >= winStart; j--) {
        if (Math.abs(waveform[j]) > threshold) {
          endSample = j + 1;
          break;
        }
      }
      break;
    }
  }

  startSample = Math.max(0, startSample - bufferSamples);
  endSample = Math.min(waveform.length, endSample + bufferSamples);
  return waveform.slice(startSample, endSample);
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/** 32-bit IEEE-float mono WAV — the exact format useTts.ts decodes per chunk. */
function createWavBuffer(waveform: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 32;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = waveform.length * bytesPerSample;
  const totalSize = 44 + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  new Float32Array(buffer, 44).set(waveform);
  return buffer;
}

// ---- Public API ----

/**
 * Pre-fetch and initialize everything needed to synthesize (ORT runtime, model,
 * default voice, espeak module) without producing audio — drives the StartGate's
 * download interstitial.
 */
export async function warm(
  modelId = DEFAULT_MODEL,
  voiceId = DEFAULT_VOICE,
  onProgress?: ProgressCallback
): Promise<void> {
  onProgress?.({ stage: "warm", progress: 0, message: "Preparing engine…" });
  await loadModel(modelId, onProgress);
  await loadVoice(voiceId, onProgress);
  await loadEspeakFactory();
  onProgress?.({ stage: "warm", progress: 100, message: "Ready" });
}

/**
 * Stream synthesized audio one WAV chunk at a time. Pull-based: the caller (the
 * worker) only advances the generator when its backpressure target allows, so
 * inference for chunk N+1 doesn't run until chunk N is wanted. Cancellation is
 * `generator.return()`.
 */
export async function* synthesize(
  params: SynthParams,
  onProgress?: ProgressCallback
): AsyncGenerator<SynthChunk> {
  const { text, voice, speed = 1, model = DEFAULT_MODEL } = params;
  if (!text || text.trim() === "") throw new Error("Text cannot be empty");

  const session = await loadModel(model, onProgress);
  const lang = voiceToLang(voice);

  onProgress?.({ stage: "voice", progress: 0, message: "Loading voice…" });
  const combined = await combineVoices(parseVoiceFormula(voice), onProgress);

  onProgress?.({ stage: "process", progress: 0, message: "Processing text…" });
  const units = await preprocessText(text, lang);
  const totalChunks = units.length;

  for (const unit of units) {
    if (unit.type === "silence") {
      const samples = Math.floor(unit.durationSeconds * SAMPLE_RATE);
      // Skip zero-length silence (an empty AudioBuffer is invalid downstream).
      if (samples <= 0) continue;
      yield { wav: createWavBuffer(new Float32Array(samples), SAMPLE_RATE), totalChunks };
      continue;
    }

    if (unit.tokens.length < 1) continue;
    const refS = combined[unit.tokens.length - 1][0];
    const waveform = trimWaveform(await runInference(session, unit.tokens, refS, speed));
    if (waveform.length === 0) continue;
    yield { wav: createWavBuffer(waveform, SAMPLE_RATE), totalChunks };
  }
}

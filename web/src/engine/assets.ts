// Lightweight asset descriptors shared by the engine (worker side) and the cache
// manager (window side). Kept free of any heavy import (no onnxruntime-web) so
// importing it into the main bundle doesn't drag the ORT runtime along — that
// belongs only in the worker chunk.

export const CACHE_NAME = "out-loud-tts-cache";

// Pinned HuggingFace revision of onnx-community/Kokoro-82M-v1.0-ONNX.
export const DOWNLOAD_URL =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231";

export const DEFAULT_MODEL = "model_q8f16";
export const DEFAULT_VOICE = "af_heart";

export interface ModelInfo {
  id: string;
  name: string;
  size: string;
  /** Approximate download size in bytes, for the pre-download size warning. */
  approxBytes: number;
}

export const MODELS: Record<string, ModelInfo> = {
  model: { id: "model", name: "Default (fp32)", size: "326 MB", approxBytes: 326_000_000 },
  model_q8f16: {
    id: "model_q8f16",
    name: "Quantized q8f16 (Recommended)",
    size: "86 MB",
    approxBytes: 86_000_000,
  },
  model_quantized: {
    id: "model_quantized",
    name: "Quantized 8-bit",
    size: "92.4 MB",
    approxBytes: 92_400_000,
  },
  model_fp16: { id: "model_fp16", name: "FP16", size: "163 MB", approxBytes: 163_000_000 },
  model_uint8: { id: "model_uint8", name: "UINT8", size: "177 MB", approxBytes: 177_000_000 },
};

export function modelUrl(modelId: string): string {
  const model = MODELS[modelId] ?? MODELS[DEFAULT_MODEL];
  return `${DOWNLOAD_URL}/onnx/${model.id}.onnx`;
}

export function voiceUrl(voiceId: string): string {
  return `${DOWNLOAD_URL}/voices/${voiceId}.bin`;
}

/** The assets that must be cached for offline-after-first-load to hold. */
export function coreAssetUrls(modelId: string, voiceId: string): string[] {
  return [modelUrl(modelId), voiceUrl(voiceId)];
}

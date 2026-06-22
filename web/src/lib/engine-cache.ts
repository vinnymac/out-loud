// Window-side cache management for the in-browser engine's downloaded assets.
// The worker writes the model/voices into CacheStorage; the window reads, sizes,
// and clears them here (CacheStorage is shared per-origin across both threads).
// Imports only the lightweight asset descriptors — never the engine — so the ORT
// runtime stays in the worker chunk.
import { CACHE_NAME, MODELS, DEFAULT_MODEL, DEFAULT_VOICE, coreAssetUrls } from "../engine/assets";

/** True if the model + default voice are already in CacheStorage. */
export async function isModelCached(
  model: string = DEFAULT_MODEL,
  voice: string = DEFAULT_VOICE
): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const store = await caches.open(CACHE_NAME);
    const hits = await Promise.all(coreAssetUrls(model, voice).map((url) => store.match(url)));
    return hits.every((hit) => hit !== undefined);
  } catch {
    return false;
  }
}

export interface StorageEstimate {
  usage: number | null;
  quota: number | null;
}

/** Best-effort actual storage usage/quota for this origin. */
export async function estimateStorage(): Promise<StorageEstimate> {
  try {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage ?? null, quota: quota ?? null };
    }
  } catch {
    /* not supported */
  }
  return { usage: null, quota: null };
}

/** Approx one-time download size to warn about before the user opts in. */
export function expectedDownloadBytes(model: string = DEFAULT_MODEL): number {
  // Model + espeak-ng wasm (~2 MB) + ORT runtime wasm (~1 MB) + default voice (~0.5 MB).
  const overhead = 3_500_000;
  return (MODELS[model]?.approxBytes ?? 86_000_000) + overhead;
}

/** Ask the browser to keep our cache from being evicted under storage pressure. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* not supported */
  }
  return false;
}

/** Delete all cached model/voice/runtime assets. */
export async function clearEngineCache(): Promise<void> {
  try {
    if (typeof caches !== "undefined") await caches.delete(CACHE_NAME);
  } catch {
    /* nothing to clear */
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

/** True when CacheStorage is usable (secure context). */
export function cacheAvailable(): boolean {
  return typeof caches !== "undefined";
}

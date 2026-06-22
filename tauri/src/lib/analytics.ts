// Renderer-side usage analytics — forwards shape-only metadata to the sidecar,
// which attaches identity/context and strips anything that isn't shape-only.
// NEVER pass text being read, file names, document titles, or any content —
// counts, buckets, enums, booleans and durations only.
import { track as ipcTrack } from "./ipc";

export function track(event: string, properties?: Record<string, unknown>): void {
  ipcTrack(event, properties);
}

// These mirror the sidecar's telemetry buckets so both sides bucket identically.
export function lengthBucket(chars: number): string {
  if (chars <= 0) return "0";
  if (chars <= 100) return "1-100";
  if (chars <= 500) return "101-500";
  if (chars <= 2000) return "501-2k";
  if (chars <= 10000) return "2k-10k";
  return "10k+";
}

export function countBucket(n: number): string {
  if (n <= 0) return "0";
  if (n <= 50) return "1-50";
  if (n <= 200) return "51-200";
  if (n <= 1000) return "201-1k";
  return "1k+";
}

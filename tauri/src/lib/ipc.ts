// Bridge to the native shell (Tauri commands/events) and the local TTS engine
// (the Node sidecar's HTTP API). This is the Tauri equivalent of the old
// Electron `window.electronAPI` preload surface.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platform as osPlatform } from "@tauri-apps/plugin-os";
import { toArrayBuffer } from "./bytes";

export const API_BASE = "http://127.0.0.1:51730";
export const WS_URL = "ws://127.0.0.1:51730/ws";

const DOC_EXTENSIONS = [
  "txt",
  "text",
  "md",
  "markdown",
  "epub",
  "pdf",
  "docx",
  "doc",
  "mobi",
  "azw",
  "azw3",
  "prc",
];

export interface SharedSettings {
  text: string;
  language: string;
  voice: string;
  volume: number;
  highlightChunk: boolean;
}

export interface UpdateInfo {
  available: boolean;
  latest: string;
  notesUrl: string;
  downloadUrl: string;
}

export interface ReaderFile {
  path: string;
  name: string;
  bytes: ArrayBuffer;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

// ---- Native shell (Tauri) ----

export function platformName(): string {
  try {
    return osPlatform();
  } catch {
    return "unknown";
  }
}

export const isMac = platformName() === "macos";

export async function getAppVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

export function openExternal(url: string): void {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    void openUrl(url).catch(() => {});
  }
}

export function quit(): void {
  void invoke("quit_app").catch(() => {});
}

export function setSidebar(open: boolean): Promise<void> {
  return invoke("set_sidebar", { open });
}

export function setPlaying(playing: boolean): void {
  void invoke("set_playing", { playing }).catch(() => {});
}

// ---- File reading + dialog (reader) ----

export async function openFiles(): Promise<Array<{ path: string; name: string }> | null> {
  const result = await openDialog({
    multiple: true,
    directory: false,
    filters: [
      { name: "Documents", extensions: DOC_EXTENSIONS },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (!result) return null;
  const paths = Array.isArray(result) ? result : [result];
  if (paths.length === 0) return null;
  return paths.map((p) => ({ path: p, name: basename(p) }));
}

export async function readFile(filePath: string): Promise<ReaderFile> {
  const buf = await invoke<ArrayBuffer>("read_file_bytes", { path: filePath });
  return { path: filePath, name: basename(filePath), bytes: buf };
}

export async function extractDoc(bytes: Uint8Array): Promise<{ text: string } | { error: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/extract-doc`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(bytes),
    });
    return (await res.json()) as { text: string } | { error: string };
  } catch {
    return { error: "Reading .doc files isn't available right now." };
  }
}

// ---- Recents (sidebar) ----

export function recentsGet(): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("recents_get");
}
export function recentsPut(entry: RecentEntry): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("recents_put", { entry });
}
export function recentsRemove(key: string): Promise<RecentEntry[]> {
  return invoke<RecentEntry[]>("recents_remove", { key });
}

// ---- Shared settings (synced with browser extensions via the sidecar) ----

export async function getSettings(): Promise<SharedSettings | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/settings`);
    return (await res.json()) as SharedSettings;
  } catch {
    return null;
  }
}

export function updateSettings(updates: Partial<SharedSettings>): void {
  // The X-Out-Loud-Client header tells the sidecar this change came from the
  // app, so it won't echo it straight back over the WS settings broadcast.
  void fetch(`${API_BASE}/api/v1/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Out-Loud-Client": "app" },
    body: JSON.stringify(updates),
  }).catch(() => {});
}

// ---- Updates ----

export function getUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("update_get");
}

export function skipVersion(version: string): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("update_skip", { version });
}

export function onUpdateAvailable(cb: (update: UpdateInfo | null) => void): () => void {
  const unlistenP = listen<UpdateInfo | null>("update-available", (e) => cb(e.payload));
  return () => {
    void unlistenP.then((un) => un());
  };
}

// ---- Telemetry (forwarded to the sidecar, the single content-free sender) ----

export function track(name: string, properties?: Record<string, unknown>): void {
  try {
    void fetch(`${API_BASE}/api/v1/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, properties: properties ?? {} }),
    }).catch(() => {});
  } catch {
    // Telemetry must never break the UI.
  }
}

// Web replacement for the desktop `tauri/src/lib/ipc.ts`. Same exported surface,
// browser implementations. The Vite `seamSwap` plugin redirects every import of
// the shared ipc module here (including the relative ones in analytics.ts and
// reader/parsers/doc.ts), so the shared UI runs unchanged with no Tauri runtime.
//
// `RecentEntry` / `RecentFile` / `RecentSession` are global (tauri/src/types/recents.d.ts).

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

// ---- Native shell (Tauri) → web equivalents / no-ops ----

export function platformName(): string {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "macos";
  if (/Win/i.test(ua)) return "windows";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}

export const isMac = platformName() === "macos";

export function getAppVersion(): Promise<string> {
  return Promise.resolve(typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "");
}

export function openExternal(url: string): void {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function quit(): void {
  // No OS process to quit in the browser. `window.close()` only works for
  // script-opened windows; otherwise this is a no-op (the button stays inert).
  try {
    window.close();
  } catch {
    /* ignore */
  }
}

export function setSidebar(_open: boolean): Promise<void> {
  // Sidebar state lives entirely in the Vue component on web; nothing to notify.
  return Promise.resolve();
}

export function setPlaying(_playing: boolean): void {
  // Desktop uses this for media keys / global hotkeys; not available on web.
}

// ---- File reading + dialog (reader) ----
//
// The browser has no filesystem paths, so we mint a synthetic `mem:` path for
// each picked File and keep the File alive in a module map. `readFile(path)`
// then resolves the bytes from that map — preserving the desktop's
// openFiles() → readFile(path) contract without touching useLibrary.ts.

const fileStash = new Map<string, File>();
let stashCounter = 0;

export function openFiles(): Promise<Array<{ path: string; name: string }> | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = DOC_EXTENSIONS.map((e) => `.${e}`).join(",");
    input.style.display = "none";

    let settled = false;
    const cleanup = () => {
      window.removeEventListener("focus", onFocus, true);
      input.remove();
    };
    const finish = (value: Array<{ path: string; name: string }> | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return finish(null);
      const picked = files.map((file) => {
        const path = `mem:${++stashCounter}:${file.name}`;
        fileStash.set(path, file);
        return { path, name: file.name };
      });
      finish(picked);
    });

    // If the picker is dismissed, `change` never fires; the window regaining
    // focus is our cue to resolve null so callers don't hang forever.
    const onFocus = () => setTimeout(() => finish(null), 300);
    window.addEventListener("focus", onFocus, true);

    document.body.appendChild(input);
    input.click();
  });
}

export async function readFile(filePath: string): Promise<ReaderFile> {
  const file = fileStash.get(filePath);
  if (!file) {
    throw new Error("This file is no longer available — please open it again.");
  }
  const bytes = await file.arrayBuffer();
  return { path: filePath, name: file.name, bytes };
}

export function extractDoc(_bytes: Uint8Array): Promise<{ text: string } | { error: string }> {
  // Legacy binary .doc (OLE2) extraction lives in the native Rust engine
  // (office_oxide) on desktop; there's no usable browser parser. Every other
  // format (txt/md/epub/pdf/docx/mobi) is parsed client-side and works here.
  return Promise.resolve({
    error:
      "Reading legacy .doc files isn't available in the web version. Try .docx, .pdf, or .epub.",
  });
}

// ---- Recents (sidebar) — localStorage, text sessions only ----
//
// Browsers can't re-open a file by absolute path, so persisting file entries
// would create un-openable recents. We keep only text sessions (which carry
// their full text and reopen perfectly); file opens still work, they just don't
// linger in the sidebar.

const RECENTS_KEY = "out-loud-recents";
const RECENTS_MAX = 50;

function recentKey(e: RecentEntry): string {
  return e.kind === "text" ? `text:${e.id}` : `file:${e.path}`;
}

function loadRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

function saveRecents(entries: RecentEntry[]): RecentEntry[] {
  const trimmed = entries.slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage full / unavailable — recents are best-effort */
  }
  return trimmed;
}

export function recentsGet(): Promise<RecentEntry[]> {
  return Promise.resolve(loadRecents());
}

export function recentsPut(entry: RecentEntry): Promise<RecentEntry[]> {
  // Only text sessions persist on web (see note above).
  if (entry.kind !== "text") return Promise.resolve(loadRecents());
  const key = recentKey(entry);
  const rest = loadRecents().filter((e) => recentKey(e) !== key);
  return Promise.resolve(saveRecents([entry, ...rest]));
}

export function recentsRemove(key: string): Promise<RecentEntry[]> {
  const next = loadRecents().filter((e) => recentKey(e) !== key);
  return Promise.resolve(saveRecents(next));
}

// ---- Shared settings — localStorage is already the source of truth ----
//
// On desktop these sync the sidecar so extensions stay in step. On web there's
// no sidecar and no extension peer, and useSettings already persists to
// localStorage, so these are inert.

export function getSettings(): Promise<SharedSettings | null> {
  return Promise.resolve(null);
}

export function updateSettings(_updates: Partial<SharedSettings>): void {
  /* no-op: useSettings persists to localStorage directly */
}

// ---- Updates — desktop-only (GitHub release check via the Rust shell) ----

export function getUpdate(): Promise<UpdateInfo | null> {
  return Promise.resolve(null);
}

export function skipVersion(_version: string): Promise<UpdateInfo | null> {
  return Promise.resolve(null);
}

export function onUpdateAvailable(_cb: (update: UpdateInfo | null) => void): () => void {
  return () => {};
}

// ---- Telemetry — dropped (analytics.ts routes here) ----

export function track(_name: string, _properties?: Record<string, unknown>): void {
  /* no-op */
}

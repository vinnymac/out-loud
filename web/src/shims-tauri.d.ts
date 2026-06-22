// Type-check shims for the desktop-only Tauri APIs.
//
// The web build never executes the shared `tauri/src/lib/ipc.ts` — the Vite
// `seamSwap` plugin replaces it with `web/src/ipc.ts` at build time. But the
// type-checker still reaches the real file through relative imports in shared
// code (e.g. `analytics.ts` → `./ipc`, `reader/parsers/doc.ts` → `../../lib/ipc`),
// so we declare just enough of the `@tauri-apps/*` surface for `vue-tsc` to pass
// without installing the desktop dependencies. None of this ships to the browser.

declare module "@tauri-apps/api/core" {
  export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

declare module "@tauri-apps/api/event" {
  export function listen<T = unknown>(
    event: string,
    handler: (event: { payload: T }) => void
  ): Promise<() => void>;
}

declare module "@tauri-apps/api/app" {
  export function getVersion(): Promise<string>;
}

declare module "@tauri-apps/plugin-dialog" {
  export function open(options?: unknown): Promise<string | string[] | null>;
}

declare module "@tauri-apps/plugin-opener" {
  export function openUrl(url: string): Promise<void>;
}

declare module "@tauri-apps/plugin-os" {
  export function platform(): string;
}

# Out Loud — Tauri + Vue + UnoCSS

A rewrite of the Out Loud desktop app (an offline AI text‑to‑speech app powered
by **Kokoro‑82M**) on **Tauri** (Rust shell + system webview) with a **Vue 3 +
Vite + UnoCSS** frontend, replacing the previous Electron + React stack.

It follows the Vue/UnoCSS conventions established in `../../npmx.dev`:
`presetWind4`, CSS‑variable design tokens, a custom a11y preset that steers
arbitrary font sizes to named tokens, an RTL flip helper, `<script setup>` with
typed `defineProps`/`defineEmits`, composables that return plain objects,
logical CSS properties (`ps`/`pe`/`start`/`end`), and first‑class `vue-i18n`.

## Architecture

```
┌──────────────────────────── Tauri app ────────────────────────────┐
│                                                                    │
│  Vue 3 + UnoCSS frontend  ──HTTP/WebSocket──►  Node sidecar        │
│  (system webview)                              (the TTS engine)    │
│        │                                          │  worker_thread │
│        │  invoke / events                         ▼                │
│        ▼                                    ONNX (Kokoro‑82M)      │
│  Rust shell (tauri)                         + espeak‑ng + ffmpeg   │
│  • window / tray / menus                                           │
│  • file dialog + file read                                         │
│  • recents + prefs store                  ┌── HTTP :51730 ──┐      │
│  • update check (GitHub)                  │ extension API   │◄── Chrome /
│  • spawns + supervises the sidecar        │ (unchanged)     │     Safari ext
│                                           └─────────────────┘      │
└────────────────────────────────────────────────────────────────────┘
```

**Why a Node sidecar?** The TTS pipeline depends on Node‑only packages
(`onnxruntime-node`, `espeak-ng` (WASM), `ffmpeg-static`, `wavefile`,
`word-extractor`). Rather than re‑implement Kokoro inference + phonemisation in
Rust, the proven engine from the Electron build is reused **verbatim** as a Node
sidecar. The Rust shell manages its lifecycle. This also keeps the local HTTP
API on `127.0.0.1:51730` exactly as before, so the existing **Chrome/Safari
extensions keep working unchanged**.

The app talks to the engine two ways:

- **WebSocket** (`/ws`) for its own playback — carries the full worker protocol
  (`generate` / `setTarget` / `cancel` → `chunk` / `complete` / `error`), so
  streaming, **backpressure**, cancellation and forced‑full export behave exactly
  as in the Electron build.
- **HTTP** for shared settings, `.doc` extraction, and telemetry.

Native concerns (file dialog/read, recents, update check, tray, window resize,
quit, open‑external) go through Tauri `invoke`/events.

## Project layout

```
tauri/
├── src/                  Vue frontend
│   ├── App.vue           Root layout (header, sidebar, drop, modals)
│   ├── components/       TextInput, VoiceSelect, PlaybackControls, …
│   ├── composables/      useTts (audio engine), useSettings, useLibrary, useUpdateCheck
│   ├── reader/           Document parsers (pdf/epub/mobi/docx/doc/txt)
│   ├── lib/              ipc (Tauri bridge), tts-client (WS), analytics, sound, voices
│   └── i18n/             vue-i18n setup + locales/en.json
├── sidecar/              Node TTS engine (server.ts + tts-worker.ts + shared-audio.ts)
├── src-tauri/            Rust shell (commands, tray, sidecar mgmt, update, recents)
├── uno.config.ts         UnoCSS (presetWind4 + a11y/rtl presets + theme tokens)
└── vite.config.ts
```

## Develop

Requirements: **Node ≥ 22**, **Rust** (stable), and a working Tauri toolchain
(Xcode CLT on macOS). The dev sidecar runs with the system `node` and reads the
model files from the repo's existing `../electron/models`.

```bash
cd tauri
npm install
npm run tauri:dev      # builds the sidecar, starts Vite, launches the app
```

or from the repo root: `npm run tauri:install` then `npm run tauri:dev`.

Useful scripts:

| Script                  | What it does                                       |
| ----------------------- | -------------------------------------------------- |
| `npm run dev`           | Vite dev server only                               |
| `npm run sidecar:build` | Bundle the Node sidecar (esbuild → `sidecar/dist`) |
| `npm run typecheck`     | `vue-tsc --noEmit`                                 |
| `npm run build`         | Typecheck + production frontend build              |
| `npm run tauri:dev`     | Sidecar build + `tauri dev`                        |
| `npm run tauri:build`   | Sidecar build + `tauri build`                      |

## Packaging notes (production)

The dev flow above is fully functional. A self‑contained installer additionally
needs three things bundled as Tauri resources and resolved by `src-tauri/src/sidecar.rs`
(release branch):

1. **The sidecar** — `sidecar/dist` plus the runtime `node_modules` it needs
   (`onnxruntime-node` native binary, `ffmpeg-static` binary, `espeak-ng` WASM,
   `wavefile`, `word-extractor`, `ws`, `fluent-ffmpeg`).
2. **The model files** — copy `electron/models` into the app resources.
3. **A Node runtime** — either require system Node, or bundle a Node binary and
   point `OUT_LOUD_NODE` at it.

Wire these via `bundle.resources` in `tauri.conf.json`; `sidecar.rs` already
resolves `resource_dir()/sidecar/server.js` and `resource_dir()/models` in
release builds. Code signing / notarization mirrors the existing Electron release
process.

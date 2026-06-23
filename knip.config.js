/** @type {import('knip').KnipConfig} */
export default {
  // Follow classic <script src="..."> tags in the extension's HTML so knip
  // treats those scripts (and what they reach) as used.
  compilers: {
    html: (text) =>
      [...text.matchAll(/<script[^>]+src=['"]([^'"]+)['"]/g)]
        .map((m) => (m[1].startsWith("/") ? `.${m[1]}` : m[1]))
        .map((p) => `import '${p}';`)
        .join("\n"),
  },
  // `tauri` (Tauri CLI); `stage`/`dmg` are tauri package scripts invoked as
  // `pnpm stage`/`pnpm dmg` from release.yml (working-directory: tauri), which
  // knip can't resolve to the workspace from the repo root.
  ignoreBinaries: ["tauri", "stage", "dmg"],
  // Keep module-internal "API surface" exports (used within their own file) — the
  // lib modules (ipc, tts-client, engine) export types/helpers consumed in-file.
  ignoreExportsUsedInFile: true,
  workspaces: {
    // Root: release/util scripts. `sharp` is used ad-hoc by the icon script and
    // intentionally not a workspace dependency.
    ".": {
      entry: ["scripts/*.mjs"],
      project: ["scripts/**/*.mjs"],
      ignoreDependencies: ["sharp"],
    },
    // Desktop app (Vite + Vue). The Vite/Vue plugins resolve index.html →
    // src/main.ts and the .vue graph; we add the Node build scripts. src-tauri is
    // Rust (no JS to analyze).
    tauri: {
      // index.html → src/main.ts (resolved by the html compiler above); knip's
      // Vite plugin can't load this workspace's vite.config from the repo root.
      entry: ["index.html", "scripts/*.mjs"],
      project: ["src/**/*.{ts,vue}", "scripts/**/*.mjs"],
      ignore: ["src/reader/vendor/**"],
      // UnoCSS presets/icons are used by uno.config.ts; the ORT dylib source is
      // resolved by stage-resources.mjs via a filesystem path; uno.css is a
      // UnoCSS virtual module — none are imports knip can see.
      ignoreDependencies: ["@iconify-json/lucide", "@unocss/.*", "onnxruntime-node", "uno.css"],
    },
    // Web app (Vite + Vue + Playwright). The worker is referenced via
    // new Worker(new URL(...)); ipc.ts and tts-client.ts are swapped in for the
    // shared Tauri modules by the Vite seam plugin and consumed from tauri/src —
    // all are entry points, not dead code.
    web: {
      entry: ["src/main.ts", "src/tts.worker.ts", "src/ipc.ts", "src/tts-client.ts"],
      project: ["src/**/*.{ts,vue}", "e2e/**/*.ts"],
      // jszip/pdfjs power the shared reader and lamejs the shared MP3 export
      // (all in tauri/src, reused by the web build); UnoCSS deps come via
      // tauri/uno.config.ts (no web uno.config for knip).
      ignoreDependencies: [
        "jszip",
        "pdfjs-dist",
        "@breezystack/lamejs",
        "@iconify-json/lucide",
        "@unocss/.*",
        "uno.css",
      ],
    },
    // Browser extension: classic scripts loaded from the manifest + HTML.
    "chrome-extension": {
      entry: [
        "manifest.json",
        "background.js",
        "content.js",
        "sidepanel.html",
        "options.html",
        "src/tts-engine.js",
      ],
      project: ["**/*.{js,html}"],
      ignore: ["lib/**", "dist/**", "native-host/**", "icons/**"],
    },
  },
};

import { defineConfig, type PluginOption } from "vite";
import vue from "@vitejs/plugin-vue";
import unocss from "unocss/vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

const tauriSrc = fileURLToPath(new URL("../tauri/src", import.meta.url));
const webSrc = fileURLToPath(new URL("./src", import.meta.url));

// The two seam modules from the shared Tauri/Vue source, mapped to their web
// replacements. The desktop talks to a local Rust server (WebSocket + Tauri
// IPC); on the web those don't exist, so we swap the transport for a Web Worker
// and the native bridge for browser stubs — without touching any shared file.
const SEAM: Record<string, string> = {
  [`${tauriSrc}/lib/ipc.ts`]: `${webSrc}/ipc.ts`,
  [`${tauriSrc}/lib/tts-client.ts`]: `${webSrc}/tts-client.ts`,
};

// Redirect regardless of how the shared code imports the seam (`~/lib/ipc` via
// alias, or a relative `../../lib/ipc` as in reader/parsers/doc.ts). We let Vite
// fully resolve the id first, then remap by absolute path — so every import form
// is caught, not just the alias.
function seamSwap(): PluginOption {
  return {
    name: "out-loud-web-seam",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved && SEAM[resolved.id]) return SEAM[resolved.id];
      return null;
    },
  };
}

// onnxruntime-web references its wasm via `new URL(..., import.meta.url)`, so
// Vite emits a ~24 MB copy into dist. We load the ORT runtime from the CDN
// (see ort.env.wasm.wasmPaths in the engine), so that bundled copy is never
// fetched — drop it instead of shipping dead weight.
function dropBundledOrtWasm(): PluginOption {
  return {
    name: "out-loud-drop-ort-wasm",
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (/ort-.*\.wasm$/.test(fileName)) {
          delete bundle[fileName];
          this.warn(`dropped unused bundled ORT wasm "${fileName}" (loaded from CDN at runtime)`);
        }
      }
    },
  };
}

const version = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")
).version as string;

export default defineConfig({
  plugins: [
    seamSwap(),
    vue(),
    // Reuse the desktop app's UnoCSS config verbatim (presets, theme, shortcuts).
    unocss({ configFile: fileURLToPath(new URL("../tauri/uno.config.ts", import.meta.url)) }),
    dropBundledOrtWasm(),
  ],
  resolve: {
    alias: {
      "~": tauriSrc,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  worker: {
    // The TTS engine runs in a module worker (dynamic import of espeak-ng ESM,
    // onnxruntime-web).
    format: "es",
  },
  build: {
    target: ["es2022", "chrome111", "safari16"],
    outDir: "dist",
    emptyOutDir: true,
  },
});

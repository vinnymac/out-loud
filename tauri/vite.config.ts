import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import unocss from "unocss/vite";
import { fileURLToPath, URL } from "node:url";

// Tauri serves the built frontend from the app's custom protocol at the root,
// and runs the Vite dev server on a fixed port during `tauri dev`.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), unocss()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Vite options tailored for Tauri development.
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Don't watch the Rust side — it has its own watcher.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // WKWebView (macOS) / WebView2 (Windows) targets.
    target: ["es2021", "chrome105", "safari15"],
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});

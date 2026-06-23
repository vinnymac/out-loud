/*! Cross-origin isolation via service worker.
 *
 * Enabling SharedArrayBuffer (and therefore ONNX Runtime's multithreaded WASM)
 * requires the page to be "cross-origin isolated", which normally means setting
 * COOP/COEP response headers on the server. This app is a static, backend-less,
 * 100%-in-browser bundle, so we have no server to set those headers.
 *
 * This worker provides them client-side instead (the "proxy the CDN" idea, but
 * running in the browser): it adds COOP + COEP to the document and
 * Cross-Origin-Resource-Policy to every cross-origin subresource it proxies.
 * Our two external origins are both readable by the worker — jsDelivr sends
 * `ACAO: *` + CORP already, and HuggingFace reflects the request Origin — so the
 * worker can re-serve them with the CORP header `require-corp` demands.
 *
 * If anything here fails, the page simply isn't isolated and the engine runs
 * single-threaded (see createSession in tts-engine.ts, which gates threads on
 * crossOriginIsolated). The app keeps working either way.
 *
 * Adapted from github.com/gzuidhof/coi-serviceworker (MIT). To turn this off,
 * remove the <script src="/coi-serviceworker.js"> tag from index.html.
 */
if (typeof window === "undefined") {
  // ---------- Service worker context ----------
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (event) => {
    if (event.data && event.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => clients.forEach((client) => client.navigate(client.url)));
    }
  });

  self.addEventListener("fetch", (event) => {
    const request = event.request;
    // Range requests served from cache without a matching entry would 404; skip.
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;

    event.respondWith(
      fetch(request)
        .then((response) => {
          // Opaque cross-origin responses (no-cors) can't be rewritten; pass
          // through. We have none of these — every external fetch is CORS.
          if (response.status === 0) return response;

          const headers = new Headers(response.headers);
          headers.set("Cross-Origin-Embedder-Policy", "require-corp");
          headers.set("Cross-Origin-Opener-Policy", "same-origin");
          headers.set("Cross-Origin-Resource-Policy", "cross-origin");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        .catch((err) => console.error("[coi] proxy fetch failed:", err))
    );
  });
} else {
  // ---------- Page context: register self, reload once to take control ----------
  (() => {
    // `crossOriginIsolated`: true → already isolated (nothing to do); undefined →
    // SharedArrayBuffer unsupported (can't isolate); false → supported but not yet
    // isolated (register + reload). Only the `false` case proceeds.
    if (window.crossOriginIsolated !== false) return;
    if (!window.isSecureContext) return; // needs https or localhost
    if (!navigator.serviceWorker) return;

    const scriptUrl = window.document.currentScript && window.document.currentScript.src;
    if (!scriptUrl) return;

    navigator.serviceWorker.register(scriptUrl).then(
      (registration) => {
        // A new worker means a reload will give us a controlled, isolated page.
        registration.addEventListener("updatefound", () => window.location.reload());
        if (registration.active && !navigator.serviceWorker.controller) {
          window.location.reload();
        }
      },
      (err) => console.error("[coi] service worker registration failed:", err)
    );
  })();
}

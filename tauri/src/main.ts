import { createApp } from "vue";
import "uno.css";
import "./styles/main.css";
import App from "./App.vue";
import { i18n } from "./i18n";
import { ensureConnected } from "./lib/tts-client";

// Open the WebSocket to the TTS engine as early as possible (the sidecar may
// still be starting); the client auto-reconnects until it's up.
ensureConnected();

createApp(App).use(i18n).mount("#app");

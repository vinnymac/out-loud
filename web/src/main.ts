import { createApp } from "vue";
import "uno.css";
import "~/styles/main.css";
import Root from "./App.web.vue";
import { i18n } from "./i18n";
import { ensureConnected } from "./tts-client";

// Spin up the engine worker early so its module loads and posts `ready` (the
// StartGate's warm() awaits actual model load before revealing the app).
ensureConnected();

createApp(Root).use(i18n).mount("#app");

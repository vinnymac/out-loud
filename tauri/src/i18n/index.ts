import { createI18n } from "vue-i18n";
import en from "./locales/en.json";

// English-only today, but structured for first-class i18n: add locale JSON files
// and register them here. Composition API mode (legacy: false) so components use
// `useI18n()` and templates use `$t`.
export const i18n = createI18n({
  legacy: false,
  locale: "en",
  fallbackLocale: "en",
  messages: { en },
});

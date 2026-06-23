import { createI18n } from "vue-i18n";
import en from "~/i18n/locales/en.json";
import { webMessages } from "./i18n-web";

// Same shared (desktop) message catalog, augmented with the web-only chrome
// strings (download interstitial + storage manager). We build our own instance
// here rather than touching the desktop's i18n module.
export const i18n = createI18n({
  legacy: false,
  locale: "en",
  fallbackLocale: "en",
  messages: {
    en: { ...en, ...webMessages.en },
  },
});

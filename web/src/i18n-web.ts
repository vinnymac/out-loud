// Web-only message strings, merged into the shared vue-i18n instance at startup
// (see main.ts) so the desktop locale files stay untouched while the browser
// chrome (the download interstitial + storage manager) is still translatable.

export const webMessages = {
  en: {
    web: {
      gate: {
        title: "Out Loud runs in your browser",
        intro:
          "Turn text into natural speech entirely on your device — no account, no server, fully private.",
        downloadExplainer:
          "To do that, Out Loud downloads its AI voice model once (about {size}). It's cached afterward, so future visits start instantly.",
        meteredHint: "Best on Wi-Fi. The download resumes from cache if you come back later.",
        download: "Download & start",
        preparing: "Preparing the voice engine…",
        checking: "Checking…",
        downloading: "Downloading voice model…",
        cancel: "Cancel",
        retry: "Try again",
        errorTitle: "Couldn't load the voice engine",
        errorHelp:
          "Check your connection and try again. The model is fetched from HuggingFace; a network or browser-storage issue can interrupt it.",
      },
      links: {
        github: "GitHub",
        githubHint: "View Out Loud's source on GitHub",
        also: "Also available as a",
        desktop: "desktop app",
        desktopHint: "Download the desktop app for macOS, Windows & Linux",
        extension: "browser extension",
        extensionHint: "Get the Chrome / Safari browser extension",
      },
      storage: {
        button: "Storage",
        title: "Downloaded data",
        ready: "Voice model is downloaded and ready to use offline.",
        notCached: "No voice model is cached yet.",
        usage: "Using {used} of browser storage on this site.",
        persisted: "Protected from automatic cleanup.",
        notPersisted: "May be cleared by the browser if storage runs low.",
        clear: "Clear downloaded model & voices",
        clearing: "Clearing…",
        cleared: "Cleared. The download screen will appear next time you reload.",
        close: "Close",
      },
    },
  },
};

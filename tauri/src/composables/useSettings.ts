import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import {
  DEFAULT_SETTINGS,
  DEFAULT_TEXT,
  SETTINGS_STORAGE_KEY,
  type Settings,
} from "~/constants";
import { updateSettings } from "~/lib/ipc";
import { onSettings } from "~/lib/tts-client";

// App settings. localStorage is the source of truth for the UI; the sidecar
// holds a shared copy so browser extensions stay in sync. On mount we SEED the
// sidecar from localStorage (the sidecar starts fresh with the app each launch),
// then adopt any live changes an extension makes via the WS settings broadcast.
//
// NOTE: this differs from the Electron build, which pulled the main process's
// in-memory defaults on mount and clobbered the user's saved voice/volume/
// highlight on every launch. Seeding (push) instead of pulling fixes that.
export function useSettings() {
  const settings = ref<Settings>(loadInitial());
  let initialized = false;

  function loadInitial(): Settings {
    try {
      const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    } catch {
      // ignore parse errors
    }
    // First-ever launch: pre-fill the example so users see what the app does.
    // After they edit/clear it, the result persists (never re-injected).
    return { ...DEFAULT_SETTINGS, text: DEFAULT_TEXT };
  }

  onMounted(() => {
    // Seed the sidecar's shared settings from our source of truth.
    updateSettings(settings.value);
    initialized = true;
  });

  // Adopt live changes pushed by an external source (e.g. a browser extension).
  const off = onSettings((shared) => {
    settings.value = {
      ...settings.value,
      text: shared.text ?? settings.value.text,
      language: shared.language || settings.value.language,
      voice: shared.voice || settings.value.voice,
      volume: shared.volume ?? settings.value.volume,
      highlightChunk: shared.highlightChunk ?? settings.value.highlightChunk,
    };
  });
  onBeforeUnmount(off);

  watch(
    settings,
    (s) => {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
      if (initialized) updateSettings(s);
    },
    { deep: true }
  );

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    settings.value = { ...settings.value, [key]: value };
  }

  return { settings, updateSetting };
}

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { onEngineProgress, warmEngine } from "../tts-client";
import {
  cacheAvailable,
  clearEngineCache,
  estimateStorage,
  expectedDownloadBytes,
  formatBytes,
  isModelCached,
  requestPersistentStorage,
} from "../lib/engine-cache";

type GateState = "checking" | "needs-download" | "downloading" | "ready" | "error";

// Public project links (web-only chrome). The canonical public repo is
// light-cloud-com/out-loud — where the desktop installers and the packaged
// browser extension (out-loud-chrome.zip) are published as release assets.
const REPO_URL = "https://github.com/light-cloud-com/out-loud";
const RELEASES_URL = `${REPO_URL}/releases/latest`;
const EXTENSION_URL = `${REPO_URL}/tree/main/chrome-extension`;

const { t } = useI18n();

const state = ref<GateState>("checking");
const progress = ref(0);
const progressMessage = ref("");
const errorMessage = ref("");

// Storage manager (reachable once ready).
const manageOpen = ref(false);
const usageBytes = ref<number | null>(null);
const persisted = ref(false);
const cached = ref(false);
const clearing = ref(false);
const cleared = ref(false);

const downloadSize = computed(() => formatBytes(expectedDownloadBytes()));

let stopProgress: (() => void) | null = null;

onMounted(async () => {
  cached.value = await isModelCached();
  if (cached.value) {
    // Already downloaded — just (re)instantiate the session from cache. Fast.
    void warm();
  } else {
    state.value = "needs-download";
  }
});

function listenProgress() {
  stopProgress?.();
  stopProgress = onEngineProgress((p) => {
    progress.value = p.progress;
    progressMessage.value = p.message;
  });
}

async function warm() {
  state.value = cached.value ? "checking" : "downloading";
  progress.value = 0;
  progressMessage.value = cached.value ? t("web.gate.preparing") : t("web.gate.downloading");
  errorMessage.value = "";
  listenProgress();
  try {
    await warmEngine();
    state.value = "ready";
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
    state.value = "error";
  } finally {
    stopProgress?.();
    stopProgress = null;
  }
}

async function start() {
  // Ask the browser not to evict the ~86 MB model under storage pressure.
  await requestPersistentStorage();
  await warm();
}

function cancel() {
  // Terminating the page aborts the in-flight worker fetch; the interstitial
  // returns on reload. (Partial downloads are never cached, so nothing leaks.)
  window.location.reload();
}

async function openManage() {
  cached.value = await isModelCached();
  const est = await estimateStorage();
  usageBytes.value = est.usage;
  persisted.value =
    typeof navigator !== "undefined" && navigator.storage?.persisted
      ? await navigator.storage.persisted()
      : false;
  cleared.value = false;
  manageOpen.value = true;
}

async function clearStorage() {
  clearing.value = true;
  await clearEngineCache();
  clearing.value = false;
  cleared.value = true;
  cached.value = false;
  const est = await estimateStorage();
  usageBytes.value = est.usage;
}
</script>

<template>
  <!-- The app only mounts once the engine is ready, so playback is never gated
       by a mid-download watchdog. -->
  <template v-if="state === 'ready'">
    <slot />
    <!-- Unobtrusive storage manager entry (web-only). -->
    <button
      class="btn-ghost fixed bottom-2 start-2 z-30 h-7 px-2 text-2xs opacity-60 transition-opacity hover:opacity-100"
      :title="t('web.storage.title')"
      @click="openManage"
    >
      <span class="i-lucide-hard-drive align-middle" aria-hidden="true" />
      <span class="ms-1 align-middle">{{ t("web.storage.button") }}</span>
    </button>

    <div
      v-if="manageOpen"
      class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="storage-title"
      @click.self="manageOpen = false"
    >
      <div
        class="w-full max-w-md rounded-lg border border-border bg-bg-elevated p-6 text-fg shadow-xl"
      >
        <h2 id="storage-title" class="mb-3 text-base font-semibold">
          {{ t("web.storage.title") }}
        </h2>
        <p class="mb-2 text-sm text-fg-muted">
          {{ cached ? t("web.storage.ready") : t("web.storage.notCached") }}
        </p>
        <p v-if="usageBytes != null" class="mb-1 text-sm text-fg-muted">
          {{ t("web.storage.usage", { used: formatBytes(usageBytes) }) }}
        </p>
        <p class="mb-4 text-2xs text-fg-subtle">
          {{ persisted ? t("web.storage.persisted") : t("web.storage.notPersisted") }}
        </p>
        <p v-if="cleared" class="mb-4 text-sm text-accent" role="status">
          {{ t("web.storage.cleared") }}
        </p>
        <div class="flex justify-end gap-2">
          <button class="btn-ghost h-9 px-3 text-sm" @click="manageOpen = false">
            {{ t("web.storage.close") }}
          </button>
          <button
            class="btn-ghost h-9 px-3 text-sm text-red-300 hover:text-red-100"
            :disabled="clearing || !cached"
            @click="clearStorage"
          >
            {{ clearing ? t("web.storage.clearing") : t("web.storage.clear") }}
          </button>
        </div>
      </div>
    </div>
  </template>

  <!-- Gate overlay (checking / needs-download / downloading / error) -->
  <div
    v-else
    class="fixed inset-0 z-50 flex items-center justify-center bg-bg p-6 text-fg"
    role="dialog"
    aria-modal="true"
    aria-labelledby="gate-title"
    aria-describedby="gate-desc"
  >
    <div class="w-full max-w-lg text-center">
      <h1 id="gate-title" class="mb-3 text-2xl font-semibold">{{ t("web.gate.title") }}</h1>
      <p id="gate-desc" class="mb-2 text-fg-muted">{{ t("web.gate.intro") }}</p>

      <!-- First run: explain the one-time download and let the user opt in. -->
      <template v-if="state === 'needs-download'">
        <p class="mb-2 text-fg-muted">
          {{ t("web.gate.downloadExplainer", { size: downloadSize }) }}
        </p>
        <p class="mb-6 text-2xs text-fg-subtle">{{ t("web.gate.meteredHint") }}</p>
        <button class="btn-primary h-11 px-6 text-sm" @click="start">
          {{ t("web.gate.download") }}
        </button>
        <p v-if="!cacheAvailable()" class="mt-4 text-2xs text-amber-300">
          This site isn't served over HTTPS, so the model can't be cached and will re-download each
          visit.
        </p>
      </template>

      <!-- Downloading / preparing -->
      <template v-else-if="state === 'downloading' || state === 'checking'">
        <div
          class="mx-auto mt-6 h-2 w-full max-w-sm overflow-hidden rounded-full bg-bg-muted"
          role="progressbar"
          :aria-valuenow="progress"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="t('web.gate.downloading')"
        >
          <div
            class="h-full bg-accent transition-[width] duration-200"
            :style="{ width: `${progress}%` }"
          />
        </div>
        <p class="mt-3 text-sm text-fg-muted" aria-live="polite">
          {{ progressMessage || t("web.gate.checking") }}
        </p>
        <button
          v-if="state === 'downloading'"
          class="btn-ghost mt-6 h-9 px-4 text-sm"
          @click="cancel"
        >
          {{ t("web.gate.cancel") }}
        </button>
      </template>

      <!-- Error -->
      <template v-else-if="state === 'error'">
        <h2 class="mt-6 text-lg font-medium text-red-200">{{ t("web.gate.errorTitle") }}</h2>
        <p class="mt-2 text-sm text-fg-muted">{{ t("web.gate.errorHelp") }}</p>
        <pre
          v-if="errorMessage"
          class="mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-red-500/40 bg-red-950/40 p-3 text-start font-mono text-2xs text-red-200"
          >{{ errorMessage }}</pre
        >
        <button class="btn-primary mt-6 h-11 px-6 text-sm" @click="start">
          {{ t("web.gate.retry") }}
        </button>
      </template>
    </div>
  </div>

  <!-- Project links (web-only): source on GitHub, plus a nudge that native
       desktop apps and a browser extension exist. Sits above the gate overlay
       (z-[60] > z-50) so it's present on the download screen too. -->
  <footer
    class="fixed bottom-2 end-2 z-[60] flex flex-col items-end gap-0.5 text-end text-2xs text-fg-subtle"
  >
    <a
      :href="REPO_URL"
      target="_blank"
      rel="noopener noreferrer"
      class="focus-ring flex items-center gap-1 rounded text-fg-muted opacity-70 transition-opacity hover:(text-fg opacity-100)"
      :title="t('web.links.githubHint')"
    >
      <span class="i-lucide-github" aria-hidden="true" />
      <span>{{ t("web.links.github") }}</span>
    </a>
    <p class="opacity-70">
      {{ t("web.links.also") }}
      <a
        :href="RELEASES_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="focus-ring rounded underline decoration-dotted underline-offset-2 hover:text-fg"
        :title="t('web.links.desktopHint')"
        >{{ t("web.links.desktop") }}</a
      >
      ·
      <a
        :href="EXTENSION_URL"
        target="_blank"
        rel="noopener noreferrer"
        class="focus-ring rounded underline decoration-dotted underline-offset-2 hover:text-fg"
        :title="t('web.links.extensionHint')"
        >{{ t("web.links.extension") }}</a
      >
    </p>
  </footer>
</template>

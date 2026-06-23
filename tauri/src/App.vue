<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import TextInput from "~/components/TextInput.vue";
import VoiceSelect from "~/components/VoiceSelect.vue";
import VolumeSlider from "~/components/VolumeSlider.vue";
import PlaybackControls from "~/components/PlaybackControls.vue";
import ProgressBar from "~/components/ProgressBar.vue";
import SettingsCheckbox from "~/components/SettingsCheckbox.vue";
import UpdateBanner from "~/components/UpdateBanner.vue";
import AboutDialog from "~/components/AboutDialog.vue";
import RecentsSidebar from "~/components/RecentsSidebar.vue";
import { useSettings } from "~/composables/useSettings";
import { useTts, type DownloadFormat } from "~/composables/useTts";
import { useLibrary } from "~/composables/useLibrary";
import { useUpdateCheck } from "~/composables/useUpdateCheck";
import { playClick } from "~/lib/sound";
import { track, lengthBucket } from "~/lib/analytics";
import { isMac, setSidebar, quit, getAppVersion, openExternal } from "~/lib/ipc";
import { ensureConnected } from "~/lib/tts-client";
import { DEFAULT_TEXT } from "~/constants";
import iconUrl from "~/assets/icon.png";
import bmcButtonUrl from "~/assets/bmc-button.svg";

const { t } = useI18n();
const { settings, updateSetting } = useSettings();
const { update, skipUpdate, open } = useUpdateCheck();
const lib = useLibrary();

const getVolume = () => settings.value.volume;
const player = useTts(getVolume);

// Remembered download format (WAV / MP3), persisted across launches.
const DOWNLOAD_FORMAT_KEY = "out-loud-download-format";
function loadDownloadFormat(): DownloadFormat {
  const v = localStorage.getItem(DOWNLOAD_FORMAT_KEY);
  return v === "wav" || v === "mp3" ? v : "mp3";
}
const downloadFormat = ref<DownloadFormat>(loadDownloadFormat());
watch(downloadFormat, (v) => localStorage.setItem(DOWNLOAD_FORMAT_KEY, v));

const aboutOpen = ref(false);
const sidebarOpen = ref(false);
const dragging = ref(false);
const version = ref("");
const textInput = ref<InstanceType<typeof TextInput> | null>(null);
let dragDepth = 0;

const text = computed(() => settings.value.text);
function setText(v: string) {
  updateSetting("text", v);
}

const controlsDisabled = computed(() => player.isPlaying && !player.isPaused);

watch(
  () => settings.value.volume,
  (v) => player.setVolume(v)
);

ensureConnected();

onMounted(async () => {
  version.value = await getAppVersion();
  window.addEventListener("keydown", onWindowKeydown);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onWindowKeydown));

function onWindowKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (aboutOpen.value) aboutOpen.value = false;
  else textInput.value?.focus();
}

function toggleSidebar() {
  sidebarOpen.value = !sidebarOpen.value;
  void setSidebar(sidebarOpen.value);
}

function loadIntoEditor(value: string | null) {
  if (value != null) {
    setText(value);
    textInput.value?.focus();
  }
}

async function onOpenFileDialog() {
  loadIntoEditor(await lib.openViaDialog());
}
async function onPickFile(rec: RecentFile) {
  loadIntoEditor(await lib.openRecentFile(rec));
}
function onPickSession(rec: RecentSession) {
  loadIntoEditor(lib.loadSession(rec));
}

function handlePlayPause() {
  if (!player.isPlaying && text.value.trim()) {
    track("quick_speak_initiated", {
      text_length_bucket: lengthBucket(text.value.length),
      language: settings.value.language,
      voice_id: settings.value.voice,
      trigger_type: "button",
    });
    void lib.addSession(text.value, settings.value.voice, settings.value.language);
  }
  void player.play(text.value, settings.value.voice, settings.value.language);
}

function speak() {
  if (!text.value.trim()) return;
  track("quick_speak_initiated", {
    text_length_bucket: lengthBucket(text.value.length),
    language: settings.value.language,
    voice_id: settings.value.voice,
    trigger_type: "keyboard",
  });
  void lib.addSession(text.value, settings.value.voice, settings.value.language);
  playClick();
  void player.play(text.value, settings.value.voice, settings.value.language, {
    forceRestart: true,
  });
  setText("");
}

async function onDrop(e: DragEvent) {
  e.preventDefault();
  dragDepth = 0;
  dragging.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) loadIntoEditor(await lib.openDroppedFile(file));
}
function onDragEnter(e: DragEvent) {
  e.preventDefault();
  dragDepth += 1;
  dragging.value = true;
}
function onDragLeave() {
  dragDepth -= 1;
  if (dragDepth <= 0) dragging.value = false;
}

function onLanguageChange(lang: string) {
  track("language_changed", { new_language: lang });
  updateSetting("language", lang);
}
function onVoiceChange(v: string) {
  track("voice_changed", { new_voice_id: v, language: settings.value.language });
  updateSetting("voice", v);
}

function onBmcClick() {
  openExternal("https://buymeacoffee.com/julia_hk");
}

function openAbout() {
  track("about_dialog_opened");
  aboutOpen.value = true;
}

const srStatus = computed(() => {
  if (player.error) return t("status.errorGenerating");
  if (!player.isPlaying) return "";
  return player.chunkProgress < 100 ? t("status.generatingSpeech") : t("status.speaking");
});
</script>

<template>
  <div class="flex h-full select-none flex-col overflow-hidden">
    <!-- Full-width top: drag strip + header -->
    <div class="px-5">
      <div class="h-8 w-full" :data-tauri-drag-region="isMac ? '' : undefined" />
      <div class="mb-4 flex items-center justify-between">
        <h1 class="flex items-center gap-2.5 text-lg">
          <img :src="iconUrl" :alt="t('app.title')" class="h-7 w-7" />
          {{ t("app.title") }}
        </h1>
        <button
          :aria-label="t('app.buyMeACoffee')"
          :title="t('app.buyMeACoffee')"
          class="inline-flex cursor-pointer items-center transition-opacity hover:opacity-90"
          @click="onBmcClick"
        >
          <img :src="bmcButtonUrl" :alt="t('app.buyMeACoffee')" class="h-8 w-auto" />
        </button>
      </div>
    </div>

    <!-- Row: hidden-by-default sidebar | main content -->
    <div class="flex min-h-0 flex-1">
      <RecentsSidebar
        v-if="sidebarOpen"
        :recents="lib.recents.value"
        @open-file-dialog="onOpenFileDialog"
        @pick-file="onPickFile"
        @pick-session="onPickSession"
        @remove="lib.removeRecent"
      />

      <div
        class="relative flex min-h-0 flex-1 flex-col px-5 pb-5"
        @dragenter="onDragEnter"
        @dragover.prevent
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <!-- Slim sidebar toggle in the start gutter -->
        <button
          :aria-label="sidebarOpen ? t('sidebar.hide') : t('sidebar.show')"
          :aria-pressed="sidebarOpen"
          :title="t('sidebar.tooltip')"
          class="absolute bottom-0 start-0 top-0 z-10 flex w-5 items-center justify-center text-gray-600 opacity-70 transition-all duration-200 hover:bg-gray-800/40 hover:text-gray-300 hover:opacity-100"
          @click="toggleSidebar"
        >
          <span class="rtl-flip text-sm leading-none">{{ sidebarOpen ? "‹" : "›" }}</span>
        </button>

        <UpdateBanner :update="update" @open="open" @skip="skipUpdate" />

        <div class="flex min-h-0 flex-1 flex-col">
          <div class="flex min-h-0 flex-1 items-stretch gap-3">
            <div class="flex min-h-0 flex-1 flex-col">
              <TextInput
                ref="textInput"
                :model-value="text"
                :highlight-chunk="settings.highlightChunk"
                :current-chunk-index="player.currentChunkIndex"
                :total-chunks="player.totalChunks"
                :is-playing="player.isPlaying"
                :example-text="DEFAULT_TEXT"
                @update:model-value="setText"
                @speak="speak"
              />
              <VoiceSelect
                :language="settings.language"
                :voice="settings.voice"
                :disabled="controlsDisabled"
                @language-change="onLanguageChange"
                @voice-change="onVoiceChange"
              />
              <PlaybackControls
                :is-playing="player.isPlaying"
                :is-paused="player.isPaused"
                :can-download="player.canDownload"
                :is-exporting="player.isExporting"
                :export-progress="player.chunkProgress"
                :format="downloadFormat"
                @play-pause="handlePlayPause"
                @update:format="downloadFormat = $event"
                @download="player.download(downloadFormat)"
                @cancel-export="player.cancelExport"
              />
            </div>

            <VolumeSlider
              :model-value="settings.volume"
              @update:model-value="(v) => updateSetting('volume', v)"
            />
          </div>

          <!-- Error banner -->
          <div
            v-if="player.error || lib.error.value"
            role="alert"
            class="mt-3 flex max-h-32 items-start justify-between gap-3 overflow-auto rounded-md border border-red-500/40 bg-red-950/40 p-3 text-xs text-red-200"
          >
            <div class="min-w-0">
              <div class="mb-1 font-semibold text-red-100">
                {{ player.error ? t("errors.ttsError") : t("errors.couldntOpenFile") }}
              </div>
              <pre class="whitespace-pre-wrap break-words font-mono text-2xs leading-snug">{{
                player.error || lib.error.value
              }}</pre>
            </div>
            <button
              v-if="lib.error.value && !player.error"
              class="shrink-0 text-red-300 hover:text-red-100"
              @click="lib.clearError"
            >
              ✕
            </button>
          </div>

          <ProgressBar
            :chunk-progress="player.chunkProgress"
            :play-progress="player.playProgress"
            :stats="player.stats"
          />

          <div class="sr-only" role="status" aria-live="polite">{{ srStatus }}</div>
        </div>

        <!-- Footer -->
        <div class="mt-auto flex items-center justify-between pt-2">
          <div class="mt-3 flex flex-col gap-2">
            <SettingsCheckbox
              :label="t('settings.highlight')"
              :model-value="settings.highlightChunk"
              @update:model-value="(v) => updateSetting('highlightChunk', v)"
            />
          </div>
          <div class="flex items-center gap-2">
            <button
              :aria-label="t('app.helpAndAbout')"
              :title="t('app.helpAndAbout')"
              class="btn-ghost h-[38px] w-[38px] text-xs font-medium"
              @click="openAbout"
            >
              ?
            </button>
            <button class="btn-ghost h-[38px] w-[50px] py-2.5 text-xs font-medium" @click="quit">
              {{ t("app.quit") }}
            </button>
          </div>
        </div>

        <!-- Drop overlay -->
        <div
          v-if="dragging"
          class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-indigo-950/60 text-sm font-medium text-indigo-100"
        >
          {{ t("drop.overlay") }}
        </div>
      </div>
    </div>

    <AboutDialog :open="aboutOpen" :version="version" @close="aboutOpen = false" @open-url="open" />
  </div>
</template>

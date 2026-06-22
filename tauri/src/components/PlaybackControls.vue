<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    isPlaying: boolean;
    isPaused: boolean;
    canDownload: boolean;
    isExporting?: boolean;
    /** Export generation progress (0–100), shown on the button while exporting. */
    exportProgress?: number;
  }>(),
  {
    isExporting: false,
    exportProgress: 0,
  }
);

const emit = defineEmits<{
  playPause: [];
  download: [];
  cancelExport: [];
}>();

const { t } = useI18n();

const buttonText = computed(() =>
  props.isPlaying && !props.isPaused ? t("controls.pause") : t("controls.play")
);
const pct = computed(() => Math.max(0, Math.min(100, Math.round(props.exportProgress))));

const downloadTitle = computed(() => {
  if (props.isExporting) return t("controls.exporting", { pct: pct.value });
  return props.canDownload ? t("controls.downloadTooltip") : t("controls.generateFirst");
});
const downloadAria = computed(() =>
  props.isExporting ? t("controls.cancelExport", { pct: pct.value }) : t("controls.downloadAudio")
);

function onDownloadClick() {
  if (props.isExporting) emit("cancelExport");
  else emit("download");
}
</script>

<template>
  <div class="mt-2.5 flex gap-2.5">
    <button class="btn-primary flex-1 py-3 text-sm" @click="emit('playPause')">
      {{ buttonText }}
    </button>
    <button
      class="relative flex min-w-[52px] cursor-pointer items-center justify-center overflow-hidden rounded-md border-none bg-gray-700 px-4 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-gray-600 focus-ring active:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-gray-700"
      :disabled="!isExporting && !canDownload"
      :title="downloadTitle"
      :aria-label="downloadAria"
      @click="onDownloadClick"
    >
      <span v-if="isExporting" class="text-xs font-semibold tabular-nums">{{ pct }}%</span>
      <svg
        v-else
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span
        v-if="isExporting"
        class="absolute bottom-0 start-0 h-[3px] bg-indigo-400 transition-[width] duration-200"
        :style="{ width: `${pct}%` }"
        aria-hidden="true"
      />
    </button>
  </div>
</template>

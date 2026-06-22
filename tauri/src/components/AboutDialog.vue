<script setup lang="ts">
import { useI18n } from "vue-i18n";
import iconUrl from "~/assets/icon.png";

defineProps<{
  open: boolean;
  version: string;
}>();

const emit = defineEmits<{
  close: [];
  openUrl: [url: string];
}>();

const { t } = useI18n();

const REPO_URL = "https://github.com/light-cloud-com/out-loud";
const PAUSE_TAGS = ["[1s]", "[500ms]", "<pause=1s>", '<break time="1s"/>'];

const shortcuts = [
  { keys: "Enter", desc: "about.shortcutEnter" },
  { keys: "Shift + Enter", desc: "about.shortcutShiftEnter" },
  { keys: "Esc", desc: "about.shortcutEsc" },
];
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
    @click="emit('close')"
  >
    <div
      role="dialog"
      aria-modal="true"
      :aria-label="t('about.title')"
      class="max-h-full w-full max-w-md overflow-auto rounded-lg border border-gray-700 bg-gray-900 p-5 text-xs text-gray-300 shadow-2xl animate-scale-in"
      @click.stop
    >
      <div class="mb-3 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-sm font-semibold text-gray-100">
          <img :src="iconUrl" alt="" class="h-5 w-5" />
          {{ t("about.title") }}
          <span class="font-normal text-gray-500">v{{ version || "—" }}</span>
        </h2>
        <button
          :aria-label="t('about.close')"
          class="rounded p-1 text-base leading-none text-gray-400 hover:text-gray-100 focus-ring"
          @click="emit('close')"
        >
          ×
        </button>
      </div>

      <section class="mb-4">
        <h3 class="mb-1 font-semibold text-gray-200">{{ t("about.shortcutsHeading") }}</h3>
        <div
          v-for="row in shortcuts"
          :key="row.keys"
          class="flex items-baseline justify-between gap-3 py-0.5"
        >
          <kbd
            class="rounded border border-gray-600 bg-gray-800 px-1.5 py-0.5 font-mono text-3xs text-gray-200"
          >
            {{ row.keys }}
          </kbd>
          <span class="flex-1 text-end text-gray-400">{{ t(row.desc) }}</span>
        </div>
      </section>

      <section class="mb-4">
        <h3 class="mb-1 font-semibold text-gray-200">{{ t("about.typeSpeakHeading") }}</h3>
        <p class="text-gray-400">{{ t("about.typeSpeakBody") }}</p>
      </section>

      <section class="mb-4">
        <h3 class="mb-1 font-semibold text-gray-200">{{ t("about.pausesHeading") }}</h3>
        <p class="mb-1 text-gray-400">{{ t("about.pausesBody") }}</p>
        <div class="mb-2 flex flex-wrap gap-1.5">
          <code
            v-for="tag in PAUSE_TAGS"
            :key="tag"
            class="rounded border border-gray-700 bg-gray-800 px-1.5 py-0.5 font-mono text-3xs text-indigo-200"
          >
            {{ tag }}
          </code>
        </div>
        <p class="text-gray-400">{{ t("about.pausesPunctuation") }}</p>
      </section>

      <section class="flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-800 pt-3 text-gray-400">
        <button class="hover:text-gray-200" @click="emit('openUrl', 'https://www.out-loud.io')">
          {{ t("about.website") }}
        </button>
        <button class="hover:text-gray-200" @click="emit('openUrl', REPO_URL)">
          {{ t("about.github") }}
        </button>
        <button class="hover:text-gray-200" @click="emit('openUrl', `${REPO_URL}/issues`)">
          {{ t("about.reportIssue") }}
        </button>
      </section>
    </div>
  </div>
</template>

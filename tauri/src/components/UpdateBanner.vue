<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { UpdateInfo } from "~/composables/useUpdateCheck";

defineProps<{
  update: UpdateInfo | null;
}>();

const emit = defineEmits<{
  open: [url: string];
  skip: [version: string];
}>();

const { t } = useI18n();
</script>

<template>
  <div
    v-if="update?.available"
    class="mb-3 mt-3 rounded-md border border-sky-500/40 bg-sky-950/40 p-3 text-xs text-sky-100"
  >
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <div class="font-semibold">{{ t("update.available", { version: update.latest }) }}</div>
        <p class="mt-0.5 leading-snug opacity-90">{{ t("update.ready") }}</p>
        <div class="mt-2 flex items-center gap-2">
          <button
            class="rounded border border-sky-400/50 bg-sky-500/20 px-2.5 py-1 text-2xs font-medium transition-colors hover:bg-sky-500/30 focus-ring"
            @click="emit('open', update.downloadUrl)"
          >
            {{ t("update.download") }}
          </button>
          <button
            class="rounded px-2 py-1 text-2xs opacity-70 transition-opacity hover:opacity-100 focus-ring"
            @click="emit('skip', update.latest)"
          >
            {{ t("update.skip") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

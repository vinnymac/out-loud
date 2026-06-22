<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { recentKey } from "~/composables/useLibrary";

defineProps<{
  recents: RecentEntry[];
}>();

const emit = defineEmits<{
  openFileDialog: [];
  pickFile: [rec: RecentFile];
  pickSession: [rec: RecentSession];
  remove: [key: string];
}>();

const { t } = useI18n();

const FORMAT_STYLES: Record<string, string> = {
  pdf: "bg-rose-500/20 text-rose-300 border-rose-500/30",
  epub: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  txt: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  docx: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  doc: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  mobi: "bg-amber-500/20 text-amber-300 border-amber-500/30",
};

function badgeClass(format: string): string {
  return (
    FORMAT_STYLES[(format || "doc").toLowerCase()] ??
    "bg-gray-600/30 text-gray-300 border-gray-500/40"
  );
}
</script>

<template>
  <aside
    class="flex h-full w-1/5 min-w-[140px] shrink-0 flex-col border-e border-gray-700/40 bg-gray-900/40"
  >
    <div class="min-h-0 flex-1 overflow-auto p-2">
      <p v-if="recents.length === 0" class="px-2 py-3 text-xs leading-relaxed text-gray-500">
        {{ t("sidebar.empty") }}
      </p>
      <div v-for="r in recents" :key="recentKey(r)" class="group relative mb-1">
        <button
          class="flex w-full items-center justify-between gap-2 rounded-md border border-gray-700/40 bg-gray-800/40 py-2 ps-2.5 pe-9 text-start text-sm text-gray-300 transition-colors hover:border-gray-600 hover:bg-gray-800/70"
          @click="r.kind === 'file' ? emit('pickFile', r) : emit('pickSession', r)"
        >
          <span class="truncate">
            {{ r.kind === "file" ? r.title || r.name : r.preview || "Text" }}
          </span>
          <span
            v-if="r.kind === 'file'"
            class="shrink-0 rounded border px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide"
            :class="badgeClass(r.format)"
          >
            {{ r.format }}
          </span>
          <span
            v-else
            class="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/20 px-1.5 py-0.5 text-3xs font-semibold uppercase tracking-wide text-emerald-300"
          >
            {{ t("sidebar.textBadge") }}
          </span>
        </button>
        <button
          :title="t('sidebar.removeTooltip')"
          :aria-label="t('sidebar.remove')"
          class="absolute end-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-gray-700 hover:text-rose-300 focus:opacity-100 group-hover:opacity-100"
          @click="emit('remove', recentKey(r))"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
      </div>
    </div>

    <div class="border-t border-gray-700/40 p-2">
      <button
        :title="t('sidebar.openFileTooltip')"
        class="w-full rounded-md border border-gray-600/50 bg-gray-700/70 px-2 py-1.5 text-xs text-gray-200 transition-colors hover:bg-gray-600 focus-ring"
        @click="emit('openFileDialog')"
      >
        {{ t("sidebar.openFile") }}
      </button>
    </div>
  </aside>
</template>

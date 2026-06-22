<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { VOICES, LANGUAGES } from "~/lib/voices";

const props = defineProps<{
  language: string;
  voice: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  languageChange: [lang: string];
  voiceChange: [voice: string];
}>();

const { t } = useI18n();

const voices = computed(() => VOICES[props.language] || VOICES["en-us"]);

// When the language changes, fall back to that language's first voice if the
// current voice doesn't belong to it.
watch(
  () => props.language,
  (lang) => {
    const list = VOICES[lang] || VOICES["en-us"];
    if (!list.find((v) => v.id === props.voice)) emit("voiceChange", list[0].id);
  }
);

const selectClass =
  "field w-full appearance-none cursor-pointer px-3.5 py-2.5 pe-10 text-sm text-gray-100 focus:(border-indigo-500/70 ring-2 ring-indigo-500/20 bg-gray-800/80)";
</script>

<template>
  <div class="mb-4 flex gap-3">
    <div class="flex-1">
      <label class="mb-2 block text-2xs font-medium uppercase tracking-wider text-gray-400">
        {{ t("voice.language") }}
      </label>
      <div class="relative">
        <select
          :value="language"
          :disabled="disabled"
          :class="selectClass"
          :aria-label="t('voice.language')"
          @change="emit('languageChange', ($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="lang in LANGUAGES"
            :key="lang.value"
            :value="lang.value"
            class="bg-gray-800 text-gray-100"
          >
            {{ t(`voice.languages.${lang.key}`) }}
          </option>
        </select>
        <span
          class="i-lucide-chevron-down pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-gray-400"
          aria-hidden="true"
        />
      </div>
    </div>
    <div class="flex-1">
      <label class="mb-2 block text-2xs font-medium uppercase tracking-wider text-gray-400">
        {{ t("voice.voice") }}
      </label>
      <div class="relative">
        <select
          :value="voice"
          :disabled="disabled"
          :class="selectClass"
          :aria-label="t('voice.voice')"
          @change="emit('voiceChange', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="v in voices" :key="v.id" :value="v.id" class="bg-gray-800 text-gray-100">
            {{ v.name }}
          </option>
        </select>
        <span
          class="i-lucide-chevron-down pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-gray-400"
          aria-hidden="true"
        />
      </div>
    </div>
  </div>
</template>

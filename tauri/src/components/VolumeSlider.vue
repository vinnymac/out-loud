<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  modelValue: number;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: number];
}>();

const { t } = useI18n();
const trackEl = ref<HTMLDivElement | null>(null);
let dragging = false;

function updateValue(clientY: number) {
  if (!trackEl.value) return;
  const rect = trackEl.value.getBoundingClientRect();
  const y = clientY - rect.top;
  const pct = Math.round(Math.max(0, Math.min(100, 100 - (y / rect.height) * 100)));
  emit("update:modelValue", pct);
}

function onMouseDown(e: MouseEvent) {
  dragging = true;
  updateValue(e.clientY);
  const onMove = (ev: MouseEvent) => {
    if (dragging) updateValue(ev.clientY);
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onTouchStart(e: TouchEvent) {
  e.preventDefault();
  updateValue(e.touches[0].clientY);
  const onMove = (ev: TouchEvent) => {
    ev.preventDefault();
    updateValue(ev.touches[0].clientY);
  };
  const onEnd = () => {
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
  };
  document.addEventListener("touchmove", onMove, { passive: false });
  document.addEventListener("touchend", onEnd);
}

onMounted(() => {
  trackEl.value?.addEventListener("touchstart", onTouchStart, { passive: false });
});

onBeforeUnmount(() => {
  trackEl.value?.removeEventListener("touchstart", onTouchStart);
});
</script>

<template>
  <div class="flex w-[36px] flex-col items-center self-stretch">
    <label class="mb-2 text-3xs font-medium uppercase tracking-wider text-gray-400">
      {{ t("volume.label") }}
    </label>

    <div
      ref="trackEl"
      class="relative w-2 flex-1 cursor-pointer rounded-full bg-gray-700/50"
      role="slider"
      :aria-valuenow="modelValue"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="t('volume.label')"
      @mousedown="onMouseDown"
    >
      <div
        class="absolute inset-x-0 bottom-0 rounded-full bg-gradient-to-t from-indigo-500 to-indigo-400 transition-all duration-75"
        :style="{ height: `${props.modelValue}%` }"
      />
      <div
        class="absolute start-1/2 h-5 w-5 -translate-x-1/2 rounded-full border-2 border-indigo-400 bg-white shadow-md shadow-black/30 transition-all duration-75"
        :style="{ bottom: `calc(${props.modelValue}% - 10px)` }"
      />
    </div>

    <span class="pt-2 text-3xs font-medium tabular-nums text-gray-400">{{ modelValue }}%</span>
  </div>
</template>

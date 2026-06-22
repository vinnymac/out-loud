<script setup lang="ts">
defineProps<{
  chunkProgress: number;
  playProgress: number;
  stats: string;
}>();
</script>

<template>
  <div class="mt-4">
    <div class="mb-2 text-center text-2xs font-medium tabular-nums tracking-wide text-gray-400">
      {{ stats }}
    </div>
    <div class="relative mb-2.5 h-2 overflow-hidden rounded-full bg-gray-800/80 shadow-inner">
      <div
        class="absolute start-0 top-0 h-full rounded-full bg-amber-500/40 transition-all duration-150 ease-out"
        :style="{ width: `${chunkProgress}%` }"
      />
      <div
        class="absolute start-0 top-0 h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 shadow-sm shadow-emerald-500/30 transition-all duration-150 ease-out"
        :style="{ width: `${playProgress}%` }"
      />
    </div>
  </div>
</template>

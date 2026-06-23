<script setup lang="ts">
defineProps<{
  label: string;
  modelValue: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
}>();
</script>

<template>
  <label class="group flex cursor-pointer select-none items-center gap-2">
    <div class="relative">
      <input
        type="checkbox"
        :checked="modelValue"
        class="peer sr-only"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      <div
        class="h-4 w-4 rounded border border-gray-600 bg-gray-800/50 transition-all duration-200 group-hover:border-gray-500 peer-checked:border-indigo-500 peer-checked:bg-indigo-500 peer-focus:ring-2 peer-focus:ring-indigo-500/30"
      />
      <svg
        class="pointer-events-none absolute start-0.5 top-0.5 h-3 w-3 text-white opacity-0 transition-opacity peer-checked:opacity-100"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        :stroke-width="3"
        aria-hidden="true"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    </div>
    <span class="text-2xs text-gray-400 transition-colors group-hover:text-gray-300">
      {{ label }}
    </span>
  </label>
</template>

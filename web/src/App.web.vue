<script setup lang="ts">
// Web root: the download/storage gate wrapping the shared Tauri/Vue app. The
// shared App only renders once the engine is warm (see StartGate), so playback
// is never gated by a mid-download watchdog.
import StartGate from "./components/StartGate.vue";
import App from "~/App.vue";
</script>

<template>
  <StartGate>
    <App />
  </StartGate>
</template>

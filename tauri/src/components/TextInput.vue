<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { track } from "~/lib/analytics";

// Pause tags the engine turns into silence (mirrors normalizePauseTags in the
// worker): [1s] / [500ms] / <pause=1s> / <break time="1s"/>.
const PAUSE_TAG_SOURCE =
  String.raw`\[\s*\d*\.?\d+\s*(?:ms|s)\s*\]` +
  String.raw`|<\s*pause\s*=\s*"?\d*\.?\d+\s*(?:ms|s)?"?\s*\/?\s*>` +
  String.raw`|<\s*break\s+time\s*=\s*["']?\d*\.?\d+\s*(?:ms|s)?["']?\s*\/?\s*>`;
const PAUSE_TAG_RE = new RegExp(`^(?:${PAUSE_TAG_SOURCE})$`, "i");

interface Chunk {
  text: string;
  start: number;
  end: number;
  isSilence: boolean;
}
interface TextChunk {
  text: string;
  start: number;
  end: number;
  index: number;
}

// Replicate the worker's text splitting exactly so the highlight stays aligned
// with the audio through every pause.
function splitIntoChunks(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  const splitRegex = new RegExp(
    `(\\s*(?:…|\\.{3,})\\s*|\\s*—\\s*|\\s+[–-]\\s+|[.,;:!?]\\s+|\\n+|${PAUSE_TAG_SOURCE})`,
    "gi"
  );

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = splitRegex.exec(text)) !== null) {
    const delimiter = match[0];
    const isPause = PAUSE_TAG_RE.test(delimiter);
    const punct = delimiter.charAt(0);
    const keepsPunct = !isPause && (punct === "!" || punct === "?");

    if (match.index > lastIndex) {
      const textBefore = text.slice(lastIndex, match.index);
      if (textBefore.trim()) {
        chunks.push({
          text: keepsPunct ? textBefore + punct : textBefore,
          start: lastIndex,
          end: keepsPunct ? match.index + 1 : match.index,
          isSilence: false,
        });
      }
    }

    if (keepsPunct) {
      if (delimiter.length > 1) {
        chunks.push({
          text: delimiter.slice(1),
          start: match.index + 1,
          end: match.index + delimiter.length,
          isSilence: true,
        });
      }
    } else {
      chunks.push({
        text: delimiter,
        start: match.index,
        end: match.index + delimiter.length,
        isSilence: true,
      });
    }

    lastIndex = match.index + delimiter.length;
  }

  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    if (remaining.trim()) {
      chunks.push({ text: remaining, start: lastIndex, end: text.length, isSilence: false });
    }
  }

  return chunks;
}

function getTextChunks(text: string): TextChunk[] {
  const allChunks = splitIntoChunks(text);
  const textChunks: TextChunk[] = [];
  allChunks.forEach((chunk, i) => {
    if (!chunk.isSilence) {
      textChunks.push({ text: chunk.text, start: chunk.start, end: chunk.end, index: i });
    }
  });
  return textChunks;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    disabled?: boolean;
    highlightChunk?: boolean;
    currentChunkIndex?: number;
    totalChunks?: number;
    isPlaying?: boolean;
    exampleText?: string;
  }>(),
  {
    disabled: false,
    highlightChunk: false,
    currentChunkIndex: -1,
    totalChunks: 0,
    isPlaying: false,
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  speak: [];
}>();

const { t } = useI18n();

const textareaEl = ref<HTMLTextAreaElement | null>(null);
const overlayEl = ref<HTMLDivElement | null>(null);
const highlightSpanEl = ref<HTMLElement | null>(null);

const textChunks = computed(() => getTextChunks(props.modelValue));

const showHighlight = computed(
  () =>
    props.highlightChunk &&
    props.isPlaying &&
    props.currentChunkIndex >= 0 &&
    props.totalChunks > 0
);

const highlightedTextChunkIndex = computed(() => {
  if (!showHighlight.value || textChunks.value.length === 0) return -1;
  const chunks = textChunks.value;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].index === props.currentChunkIndex) return i;
    if (chunks[i].index > props.currentChunkIndex) return Math.max(0, i - 1);
  }
  return chunks.length - 1;
});

interface Segment {
  text: string;
  isHighlighted: boolean;
}

const segments = computed<Segment[]>(() => {
  const value = props.modelValue;
  const out: Segment[] = [];
  let lastEnd = 0;
  textChunks.value.forEach((chunk, i) => {
    if (chunk.start > lastEnd) {
      out.push({ text: value.slice(lastEnd, chunk.start), isHighlighted: false });
    }
    out.push({
      text: value.slice(chunk.start, chunk.end),
      isHighlighted: i === highlightedTextChunkIndex.value,
    });
    lastEnd = chunk.end;
  });
  if (lastEnd < value.length) {
    out.push({ text: value.slice(lastEnd), isHighlighted: false });
  }
  return out;
});

// Keep the spoken chunk centred while highlighting; the textarea is the source
// of truth for scroll position and the overlay mirrors it.
watch([highlightedTextChunkIndex, showHighlight], async () => {
  if (!showHighlight.value) return;
  await nextTick();
  const span = highlightSpanEl.value;
  const ta = textareaEl.value;
  if (!span || !ta) return;
  const target = Math.max(0, span.offsetTop - ta.clientHeight / 2 + span.offsetHeight / 2);
  ta.scrollTop = target;
  if (overlayEl.value) overlayEl.value.scrollTop = target;
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    emit("speak");
  }
}

function onScroll(e: Event) {
  const overlay = overlayEl.value;
  const ta = e.currentTarget as HTMLTextAreaElement;
  if (overlay) {
    overlay.scrollTop = ta.scrollTop;
    overlay.scrollLeft = ta.scrollLeft;
  }
}

function loadExample() {
  if (!props.exampleText) return;
  track("example_text_loaded");
  emit("update:modelValue", props.exampleText);
}

function setHighlightRef(el: Element | null) {
  if (el) highlightSpanEl.value = el as HTMLElement;
}

onMounted(() => textareaEl.value?.focus());

defineExpose({
  focus: () => textareaEl.value?.focus(),
});
</script>

<template>
  <div class="mb-4 flex min-h-0 flex-1 flex-col">
    <div class="relative min-h-0 flex-1">
      <textarea
        ref="textareaEl"
        :value="modelValue"
        :disabled="disabled"
        :aria-label="t('editor.label')"
        :placeholder="t('editor.placeholder')"
        :class="[
          'field h-full w-full select-text resize-none overflow-x-hidden break-words px-3.5 py-3 text-base leading-relaxed text-gray-100 placeholder:text-gray-500',
          showHighlight ? 'text-transparent caret-gray-100' : '',
        ]"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @keydown="onKeydown"
        @scroll="onScroll"
      />
      <button
        v-if="!modelValue && !disabled && exampleText"
        type="button"
        class="absolute bottom-3 end-3 cursor-pointer rounded-md border border-gray-700/60 bg-gray-900/70 px-2 py-1 text-2xs text-gray-400 transition-colors hover:border-gray-600 hover:text-gray-200"
        @click="loadExample"
      >
        {{ t("editor.loadExample") }}
      </button>
      <div
        v-if="showHighlight"
        ref="overlayEl"
        class="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words rounded-md border border-transparent px-3.5 py-3 text-base leading-relaxed"
        aria-hidden="true"
      >
        <span
          v-for="(seg, i) in segments"
          :key="i"
          :ref="seg.isHighlighted ? (el) => setHighlightRef(el as Element | null) : undefined"
          :class="seg.isHighlighted ? 'rounded-sm bg-indigo-500/90 text-white' : 'text-gray-400'"
          :style="
            seg.isHighlighted
              ? { boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone' }
              : undefined
          "
          >{{ seg.text }}</span
        >
      </div>
    </div>
  </div>
</template>

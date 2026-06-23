import { reactive, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { track } from "~/lib/analytics";
import { setPlaying } from "~/lib/ipc";
import {
  generate,
  setBufferTarget,
  forceFullGeneration,
  cancelGeneration,
  waitConnected,
} from "~/lib/tts-client";
import { Mp3Encoder } from "@breezystack/lamejs";

export type DownloadFormat = "wav" | "mp3";

// How many chunks ahead of the playhead the engine may generate during normal
// playback (backpressure). Download/export lifts this cap to generate fully.
const AHEAD = 20;
// If the engine produces nothing within this window, surface a clear error
// instead of spinning forever (e.g. the sidecar failed to start).
const FIRST_RESPONSE_TIMEOUT_MS = 20_000;
// Underrun handling (matters on the web build, where in-browser synthesis can be
// slower than real time; on desktop the engine generates faster than playback so
// these never trigger). If the scheduled audio ahead of the playhead drops below
// UNDERRUN_GUARD while more chunks are still coming, we suspend the AudioContext
// — which freezes audio AND the clock together — instead of playing silence, then
// resume once RESUME_LEAD seconds of audio are buffered again. This keeps pauses
// exact and the timer honest rather than counting real seconds through the gaps.
const UNDERRUN_GUARD = 0.12;
const RESUME_LEAD = 0.5;

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface ChunkTiming {
  startTime: number;
  endTime: number;
}

export function useTts(getVolume: () => number) {
  const { t } = useI18n();

  const player = reactive({
    isPlaying: false,
    isPaused: false,
    isBuffering: false,
    chunkProgress: 0,
    playProgress: 0,
    stats: "-",
    error: null as string | null,
    currentChunkIndex: -1,
    totalChunks: 0,
    canDownload: false,
    isExporting: false,
  });

  // --- audio machinery (non-reactive closure state) ---
  let audioCtx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let scheduledSources: AudioBufferSourceNode[] = [];
  let lastPlayedText = "";
  let cachedAudioBuffers: AudioBuffer[] = [];
  let cachedKey = "";
  let animationFrame: number | null = null;

  let playbackStartTime = 0;
  let scheduledEndTime = 0;
  let totalScheduledDuration = 0;
  let allChunksReceived = false;
  let chunksReceived = 0;
  let totalChunksCount = 0;
  let textBasedEstimate = 0;
  let chunkTimings: ChunkTiming[] = [];

  let currentReqId: string | null = null;
  let lastSentTarget = -1;
  let pendingExport = false;
  let exportFormat: DownloadFormat = "wav";
  let firstResponseTimer: ReturnType<typeof setTimeout> | null = null;
  // True while we've suspended the context to rebuffer after an underrun.
  let buffering = false;

  // Resume from a rebuffering suspend once we have enough audio queued ahead (or
  // the stream finished). Driven by chunk arrivals, not the rAF loop, since the
  // loop is parked while suspended.
  function maybeResume() {
    if (!buffering || !audioCtx || player.isPaused) return;
    const ahead = scheduledEndTime - audioCtx.currentTime;
    if (!allChunksReceived && ahead < RESUME_LEAD) return;
    buffering = false;
    player.isBuffering = false;
    audioCtx.resume();
    if (animationFrame === null) animationFrame = requestAnimationFrame(updatePlayback);
  }

  function clearFirstResponseTimer() {
    if (firstResponseTimer) {
      clearTimeout(firstResponseTimer);
      firstResponseTimer = null;
    }
  }

  function stopAudio() {
    if (currentReqId) {
      cancelGeneration(currentReqId);
      currentReqId = null;
    }
    pendingExport = false;
    clearFirstResponseTimer();
    if (animationFrame) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    scheduledSources.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* ignore */
      }
    });
    scheduledSources = [];
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    gainNode = null;
    buffering = false;
    player.isPlaying = false;
    player.isPaused = false;
    player.isBuffering = false;
    player.isExporting = false;
    player.canDownload = false;
    player.currentChunkIndex = -1;
    setPlaying(false);
  }

  function stop() {
    stopAudio();
    player.playProgress = 0;
    player.stats = t("status.stopped");
  }

  function setVolume(vol: number) {
    if (gainNode) gainNode.gain.value = vol / 100;
  }

  function getCurrentChunkIndex(currentTime: number): number {
    for (let i = 0; i < chunkTimings.length; i++) {
      if (currentTime >= chunkTimings[i].startTime && currentTime < chunkTimings[i].endTime) {
        return i;
      }
    }
    if (chunkTimings.length > 0 && currentTime >= chunkTimings[chunkTimings.length - 1].endTime) {
      return chunkTimings.length - 1;
    }
    return -1;
  }

  function updatePlayback() {
    if (!audioCtx || playbackStartTime === 0) return;

    const now = audioCtx.currentTime;
    const elapsed = Math.max(0, now - playbackStartTime);
    const remaining = Math.max(0, scheduledEndTime - now);
    const currentChunk = getCurrentChunkIndex(now);

    // Backpressure: keep the engine generating ~AHEAD chunks past the playhead.
    if (currentChunk >= 0 && !allChunksReceived && currentReqId) {
      const target = currentChunk + AHEAD;
      if (target > lastSentTarget) {
        lastSentTarget = target;
        setBufferTarget(currentReqId, target);
      }
    }

    // Underrun guard: if generation can't keep up and we're about to run past the
    // last scheduled audio, suspend the context instead of playing through silence.
    // Suspending freezes audioCtx.currentTime, so `elapsed` (and the highlight)
    // stop with the audio — the timer never overruns the real audio. We resume in
    // maybeResume() once enough audio is buffered again. Don't reschedule the rAF
    // loop here; chunk arrivals drive the resume.
    if (
      !allChunksReceived &&
      !player.isPaused &&
      currentReqId &&
      scheduledEndTime - now <= UNDERRUN_GUARD
    ) {
      buffering = true;
      player.isBuffering = true;
      audioCtx.suspend();
      // Keep the engine working while we wait, regardless of where the (frozen)
      // playhead sits, so backpressure can't park it and deadlock the rebuffer.
      const target = chunksReceived + AHEAD;
      if (target > lastSentTarget) {
        lastSentTarget = target;
        setBufferTarget(currentReqId, target);
      }
      player.stats = t("status.buffering");
      animationFrame = null;
      return;
    }

    let displayDuration: number;
    if (allChunksReceived) {
      displayDuration = scheduledEndTime - playbackStartTime;
    } else if (chunksReceived > 0 && totalChunksCount > 0) {
      const actualDuration = scheduledEndTime - playbackStartTime;
      const avgChunkDuration = totalScheduledDuration / chunksReceived;
      const remainingChunks = totalChunksCount - chunksReceived;
      const chunkBasedEstimate = actualDuration + remainingChunks * avgChunkDuration;
      const weight = chunksReceived / totalChunksCount;
      displayDuration = textBasedEstimate * (1 - weight) + chunkBasedEstimate * weight;
    } else {
      displayDuration = textBasedEstimate;
    }

    // The streamed total is an estimate until allChunksReceived; never let it read
    // below the time already elapsed, so the timer can't show e.g. 9.9 / ~9.
    if (!allChunksReceived) displayDuration = Math.max(displayDuration, elapsed);

    if (displayDuration > 0) {
      const pct = Math.min(100, (elapsed / displayDuration) * 100);
      const suffix = allChunksReceived ? "" : "~";
      player.playProgress = pct;
      player.stats = `${formatTime(elapsed)} / ${suffix}${formatTime(displayDuration)}`;
      player.currentChunkIndex = currentChunk;
      player.totalChunks = totalChunksCount;
    }

    if (remaining > 0.05 || !allChunksReceived) {
      animationFrame = requestAnimationFrame(updatePlayback);
    } else {
      const finalDuration = scheduledEndTime - playbackStartTime;
      player.isPlaying = false;
      player.playProgress = 100;
      player.stats = t("status.done", { time: formatTime(finalDuration) });
      player.currentChunkIndex = -1;
      setPlaying(false);
    }
  }

  function updateCachedPlayback() {
    if (!audioCtx) return;

    const now = audioCtx.currentTime;
    const elapsed = Math.max(0, now - playbackStartTime);
    const totalDuration = scheduledEndTime - playbackStartTime;
    const pct = Math.min(100, (elapsed / totalDuration) * 100);
    const currentChunk = getCurrentChunkIndex(now);

    player.playProgress = pct;
    player.stats = `${formatTime(elapsed)} / ${formatTime(totalDuration)}`;
    player.currentChunkIndex = currentChunk;
    player.totalChunks = chunkTimings.length;

    if (now < scheduledEndTime - 0.05) {
      animationFrame = requestAnimationFrame(updateCachedPlayback);
    } else {
      player.isPlaying = false;
      player.playProgress = 100;
      player.stats = t("status.done", { time: formatTime(totalDuration) });
      player.currentChunkIndex = -1;
      setPlaying(false);
    }
  }

  async function play(
    text: string,
    voice: string,
    language: string,
    opts?: { forceRestart?: boolean }
  ) {
    if (!text.trim()) return;

    // Pause / resume / restart when already playing.
    if (!opts?.forceRestart && player.isPlaying && audioCtx) {
      if (player.isPaused) {
        if (text !== lastPlayedText) {
          stopAudio();
          // fall through to start fresh
        } else {
          // User resume takes precedence over any rebuffering suspend; if the
          // buffer is still thin the underrun guard will re-engage on its own.
          buffering = false;
          player.isBuffering = false;
          audioCtx.resume();
          player.isPaused = false;
          animationFrame = requestAnimationFrame(
            cachedKey === `${text}|${voice}|${language}` && allChunksReceived
              ? updateCachedPlayback
              : updatePlayback
          );
          return;
        }
      } else {
        const now = audioCtx.currentTime;
        const elapsed = Math.max(0, now - playbackStartTime);
        const duration = scheduledEndTime - playbackStartTime;
        const wasCached = cachedKey === `${text}|${voice}|${language}` && allChunksReceived;
        audioCtx.suspend();
        if (animationFrame) {
          cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }
        player.isPaused = true;
        track("quick_speak_paused", {
          ...(duration > 0
            ? { progress_pct: Math.min(100, Math.max(0, (elapsed / duration) * 100)) }
            : {}),
          was_cached: wasCached,
        });
        return;
      }
    }

    stopAudio();
    lastPlayedText = text;

    playbackStartTime = 0;
    scheduledEndTime = 0;
    totalScheduledDuration = 0;
    allChunksReceived = false;
    chunksReceived = 0;
    totalChunksCount = 0;
    chunkTimings = [];
    buffering = false;

    player.isPlaying = true;
    player.isPaused = false;
    player.isBuffering = false;
    player.chunkProgress = 0;
    player.playProgress = 0;
    player.stats = "-";
    player.error = null;
    player.canDownload = false;
    setPlaying(true);

    const currentKey = `${text}|${voice}|${language}`;

    // Cached playback (same text/voice/lang as last time).
    if (cachedKey === currentKey && cachedAudioBuffers.length > 0) {
      player.chunkProgress = 100;
      player.stats = t("status.cached");
      player.canDownload = true;
      try {
        audioCtx = new AudioContext();
        gainNode = audioCtx.createGain();
        gainNode.gain.value = getVolume() / 100;
        gainNode.connect(audioCtx.destination);
        scheduledSources = [];
        chunkTimings = [];

        let endTime = audioCtx.currentTime + 0.1;
        playbackStartTime = endTime;
        for (const buffer of cachedAudioBuffers) {
          const source = audioCtx.createBufferSource();
          source.buffer = buffer;
          source.connect(gainNode);
          source.start(endTime);
          chunkTimings.push({ startTime: endTime, endTime: endTime + buffer.duration });
          endTime += buffer.duration;
          scheduledSources.push(source);
        }
        scheduledEndTime = endTime;
        allChunksReceived = true;
        totalChunksCount = cachedAudioBuffers.length;
        animationFrame = requestAnimationFrame(updateCachedPlayback);
        return;
      } catch (e) {
        console.error("Cache playback error:", e);
      }
    }

    cachedAudioBuffers = [];
    cachedKey = currentKey;

    const reqId = crypto.randomUUID();
    currentReqId = reqId;
    lastSentTarget = -1;
    pendingExport = false;

    const CHARS_PER_SECOND = 14;
    textBasedEstimate = text.trim().length / CHARS_PER_SECOND;

    player.stats = t("status.starting");

    try {
      audioCtx = new AudioContext();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = getVolume() / 100;
      gainNode.connect(audioCtx.destination);
      scheduledSources = [];

      let firstChunkSeen = false;
      const BUFFER_TIME = 0.1;

      // Watchdog: if nothing arrives, the engine is probably down.
      clearFirstResponseTimer();
      firstResponseTimer = setTimeout(() => {
        if (chunksReceived === 0 && currentReqId === reqId) {
          player.error = t("errors.engineUnreachable");
          stopAudio();
        }
      }, FIRST_RESPONSE_TIMEOUT_MS);

      void waitConnected(FIRST_RESPONSE_TIMEOUT_MS);

      generate(
        { voice, text, speed: 1, requestId: reqId, initialTarget: AHEAD },
        {
          onChunk: async (data) => {
            const { chunkIndex, totalChunks, base64 } = data;
            totalChunksCount = totalChunks;
            chunksReceived++;
            clearFirstResponseTimer();

            if (!firstChunkSeen && audioCtx) {
              firstChunkSeen = true;
              playbackStartTime = audioCtx.currentTime + BUFFER_TIME;
              scheduledEndTime = playbackStartTime;
              animationFrame = requestAnimationFrame(updatePlayback);
            }

            try {
              if (!audioCtx || !gainNode) return;
              const bytes = base64ToBytes(base64);
              // Decode the known WAV format deterministically (WKWebView's
              // decodeAudioData is pickier about 32-bit-float WAV than Chromium);
              // fall back to the platform decoder if anything looks unexpected.
              let audioBuffer: AudioBuffer;
              try {
                audioBuffer = wavBytesToAudioBuffer(audioCtx, bytes);
              } catch {
                audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
              }
              cachedAudioBuffers.push(audioBuffer);
              const source = audioCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(gainNode);

              const now = audioCtx.currentTime;
              if (scheduledEndTime < now) scheduledEndTime = now + 0.01;

              chunkTimings.push({
                startTime: scheduledEndTime,
                endTime: scheduledEndTime + audioBuffer.duration,
              });
              source.start(scheduledEndTime);
              scheduledEndTime += audioBuffer.duration;
              totalScheduledDuration += audioBuffer.duration;
              scheduledSources.push(source);
            } catch (decodeErr) {
              console.error("Decode error:", decodeErr);
            }

            player.chunkProgress =
              totalChunks > 0
                ? Math.round(((chunkIndex + 1) / totalChunks) * 100)
                : Math.min(95, (chunksReceived / (chunksReceived + 2)) * 100);
            player.canDownload = true;

            // While rebuffering after an underrun: keep the engine generating
            // (so it can't park on backpressure) and resume once we have a lead.
            if (buffering) {
              const target = chunksReceived + AHEAD;
              if (currentReqId && target > lastSentTarget) {
                lastSentTarget = target;
                setBufferTarget(currentReqId, target);
              }
              maybeResume();
            }
          },
          onComplete: () => {
            allChunksReceived = true;
            clearFirstResponseTimer();
            if (chunksReceived === 0) {
              player.error = t("errors.noAudio");
              player.isPlaying = false;
              stopAudio();
              return;
            }
            player.canDownload = true;
            // If we were rebuffering, the stream ending means "play out what's
            // left" — resume immediately rather than waiting for a lead.
            maybeResume();
            if (pendingExport) {
              pendingExport = false;
              player.isExporting = false;
              exportAudio();
            }
          },
          onError: (error) => {
            player.error = error;
            player.isPlaying = false;
            stopAudio();
          },
        }
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      player.error = message;
      player.isPlaying = false;
      stopAudio();
    }
  }

  // Build an audio file (WAV or MP3) from all generated chunks and download it.
  function exportAudio() {
    if (cachedAudioBuffers.length === 0) return;

    const buffers = cachedAudioBuffers;
    const sampleRate = buffers[0].sampleRate;
    const numChannels = buffers[0].numberOfChannels;
    const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);

    const offlineCtx = new OfflineAudioContext(numChannels, totalLength, sampleRate);
    let offset = 0;
    for (const buffer of buffers) {
      const source = offlineCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(offlineCtx.destination);
      source.start(offset / sampleRate);
      offset += buffer.length;
    }

    const format = exportFormat;
    offlineCtx.startRendering().then((renderedBuffer) => {
      const { blob, ext } =
        format === "mp3"
          ? { blob: new Blob([encodeMp3(renderedBuffer)], { type: "audio/mpeg" }), ext: "mp3" }
          : {
              blob: new Blob([audioBufferToWav(renderedBuffer)], { type: "audio/wav" }),
              ext: "wav",
            };
      const url = URL.createObjectURL(blob);

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.T]/g, "-").slice(0, 19);
      const filename = `out-loud-${timestamp}.${ext}`;

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      track("audio_downloaded", { duration_seconds: renderedBuffer.duration, format });
    });
  }

  function download(format: DownloadFormat = "wav") {
    exportFormat = format;
    if (allChunksReceived) {
      exportAudio();
      return;
    }
    if (!currentReqId) return;
    pendingExport = true;
    player.isExporting = true;
    lastSentTarget = Number.MAX_SAFE_INTEGER;
    forceFullGeneration(currentReqId);
  }

  function cancelExport() {
    if (!pendingExport) return;
    pendingExport = false;
    player.isExporting = false;
    if (currentReqId && audioCtx) {
      const currentChunk = getCurrentChunkIndex(audioCtx.currentTime);
      const target = Math.max(0, currentChunk) + AHEAD;
      lastSentTarget = target;
      setBufferTarget(currentReqId, target);
    }
  }

  onBeforeUnmount(() => {
    if (currentReqId) cancelGeneration(currentReqId);
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (audioCtx) audioCtx.close();
  });

  return Object.assign(player, { play, stop, setVolume, download, cancelExport });
}

// Encode an AudioBuffer to MP3 via lamejs — the client-side equivalent of the
// engine's mp3lame `response_format: mp3`. 24 kHz mono speech compresses ~10×
// vs WAV. Returns the full MP3 bytes (one ArrayBuffer-backed Uint8Array).
function encodeMp3(buffer: AudioBuffer): Uint8Array<ArrayBuffer> {
  const channels = Math.min(buffer.numberOfChannels, 2);
  const encoder = new Mp3Encoder(channels, buffer.sampleRate, 128);
  const left = floatTo16BitPCM(buffer.getChannelData(0));
  const right = channels > 1 ? floatTo16BitPCM(buffer.getChannelData(1)) : undefined;

  const blockSize = 1152; // one MPEG frame's worth of samples
  const frames: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < left.length; i += blockSize) {
    const l = left.subarray(i, i + blockSize);
    const r = right ? right.subarray(i, i + blockSize) : undefined;
    const encoded = encoder.encodeBuffer(l, r);
    if (encoded.length > 0) {
      frames.push(encoded);
      total += encoded.length;
    }
  }
  const end = encoder.flush();
  if (end.length > 0) {
    frames.push(end);
    total += end.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Convert an AudioBuffer to a 16-bit PCM WAV (matches the original export).
function audioBufferToWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  const dataLength = buffer.length * blockAlign;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const arrayBuffer = new ArrayBuffer(totalLength);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  const channels: Float32Array[] = [];
  for (let i = 0; i < numChannels; i++) channels.push(buffer.getChannelData(i));

  let writeOffset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(writeOffset, int16, true);
      writeOffset += 2;
    }
  }

  return arrayBuffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Decode a canonical RIFF/WAVE buffer into an AudioBuffer. Handles the engine's
// 32-bit float output plus 8/16/32-bit PCM, so playback never depends on the
// webview's built-in WAV decoder.
function wavBytesToAudioBuffer(ctx: BaseAudioContext, bytes: Uint8Array): AudioBuffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 44 || view.getUint32(0, false) !== 0x52494646 /* "RIFF" */) {
    throw new Error("not a RIFF/WAVE buffer");
  }

  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null =
    null;
  let dataOffset = -1;
  let dataLen = 0;
  while (offset + 8 <= view.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420 /* "fmt " */) {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 0x64617461 /* "data" */) {
      dataOffset = body;
      dataLen = Math.min(size, view.byteLength - body);
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || dataOffset < 0) throw new Error("missing fmt/data chunk");

  const { audioFormat, channels, sampleRate, bits } = fmt;
  const bytesPerSample = bits / 8;
  if (!channels || !bytesPerSample) throw new Error("invalid wav fmt");
  const frameCount = Math.floor(dataLen / (bytesPerSample * channels));
  const buffer = ctx.createBuffer(channels, frameCount, sampleRate);

  for (let ch = 0; ch < channels; ch++) {
    const out = buffer.getChannelData(ch);
    for (let i = 0; i < frameCount; i++) {
      const o = dataOffset + (i * channels + ch) * bytesPerSample;
      let v: number;
      if (audioFormat === 3 && bits === 32) v = view.getFloat32(o, true);
      else if (audioFormat === 1 && bits === 16) v = view.getInt16(o, true) / 0x8000;
      else if (audioFormat === 1 && bits === 8) v = (view.getUint8(o) - 128) / 128;
      else if (audioFormat === 1 && bits === 32) v = view.getInt32(o, true) / 0x80000000;
      else throw new Error(`unsupported wav format ${audioFormat}/${bits}`);
      out[i] = v;
    }
  }
  return buffer;
}

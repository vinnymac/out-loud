import { ref, onMounted } from "vue";
import type { NormalizedDoc } from "~/reader/types";
import { parseDocument } from "~/reader/parseDocument";
import { detectFormat, stripExt } from "~/reader/parsers/shared";
import { track, countBucket } from "~/lib/analytics";
import { openFiles, readFile, recentsGet, recentsPut, recentsRemove } from "~/lib/ipc";

// Stable identity for a recent entry (mirrors the Rust keyOf).
export function recentKey(e: RecentEntry): string {
  return e.kind === "text" ? `text:${e.id}` : `file:${e.path}`;
}

// Flatten a parsed document back to plain text for the editor.
function docToText(doc: NormalizedDoc): string {
  return doc.blocks
    .map((b) => b.sentences.map((s) => s.text).join(" "))
    .filter((t) => t.trim().length > 0)
    .join("\n\n");
}

type OpenSource = "dialog" | "drop" | "recents";

/**
 * The unified "library": the sidebar's recents (opened files + listened text
 * sessions) plus the actions that load any of them into the editor as text.
 */
export function useLibrary() {
  const recents = ref<RecentEntry[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function refresh() {
    recents.value = (await recentsGet()) ?? [];
  }

  onMounted(refresh);

  async function loadBytes(
    bytes: Uint8Array,
    name: string,
    sourcePath: string | undefined,
    source: OpenSource
  ): Promise<string | null> {
    loading.value = true;
    error.value = null;
    try {
      const doc = await parseDocument({ bytes, name, sourcePath });
      const text = docToText(doc);
      if (sourcePath) {
        await recentsPut({
          kind: "file",
          path: sourcePath,
          name,
          title: doc.title || stripExt(name),
          format: doc.format,
          addedAt: Date.now(),
        });
        await refresh();
      }
      if (source === "recents") {
        track("book_from_recents_opened", { format: doc.format, resume_position_available: false });
      } else {
        track("book_opened", {
          format: doc.format,
          page_count_bucket: countBucket(doc.pages.length),
          open_source: source,
        });
      }
      loading.value = false;
      return text;
    } catch (e) {
      track("document_parse_error", {
        error_type: e instanceof Error ? e.name : "parse_failed",
        format: detectFormat(name, bytes),
      });
      error.value = e instanceof Error ? e.message : String(e);
      loading.value = false;
      return null;
    }
  }

  async function openViaDialog(): Promise<string | null> {
    const files = await openFiles();
    if (!files || files.length === 0) return null;
    const first = files[0];
    try {
      const res = await readFile(first.path);
      return loadBytes(new Uint8Array(res.bytes), res.name, res.path, "dialog");
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async function openDroppedFile(file: File): Promise<string | null> {
    const buf = await file.arrayBuffer();
    return loadBytes(new Uint8Array(buf), file.name, undefined, "drop");
  }

  async function openRecentFile(rec: RecentFile): Promise<string | null> {
    try {
      const res = await readFile(rec.path);
      return loadBytes(new Uint8Array(res.bytes), res.name, res.path, "recents");
    } catch (e) {
      error.value = `Couldn't open "${rec.title}": ${e instanceof Error ? e.message : String(e)}`;
      await refresh();
      return null;
    }
  }

  function loadSession(rec: RecentSession): string {
    void recentsPut({ ...rec, addedAt: Date.now() }).then(refresh);
    return rec.text;
  }

  async function addSession(text: string, voice?: string, language?: string) {
    const t = text.trim();
    if (!t || t.length > 20000) return;
    await recentsPut({
      kind: "text",
      id: crypto.randomUUID(),
      text: t,
      preview: t.replace(/\s+/g, " ").slice(0, 80),
      voice,
      language,
      addedAt: Date.now(),
    });
    await refresh();
  }

  async function removeRecent(key: string) {
    recents.value = (await recentsRemove(key)) ?? [];
  }

  function clearError() {
    error.value = null;
  }

  return {
    recents,
    loading,
    error,
    openViaDialog,
    openDroppedFile,
    openRecentFile,
    loadSession,
    addSession,
    removeRecent,
    clearError,
  };
}

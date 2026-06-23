// Sidebar recents DTOs, kept global so the reader modules and components can
// reference them directly (mirrors the Electron build's electron.d.ts).
declare global {
  interface RecentFile {
    kind: "file";
    path: string;
    name: string;
    title: string;
    format: string;
    addedAt: number;
  }

  interface RecentSession {
    kind: "text";
    id: string;
    preview: string;
    text: string;
    voice?: string;
    language?: string;
    addedAt: number;
  }

  type RecentEntry = RecentFile | RecentSession;
}

export {};

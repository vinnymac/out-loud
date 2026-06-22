import { ref, onMounted, onBeforeUnmount } from "vue";
import { getUpdate, skipVersion, openExternal, onUpdateAvailable, type UpdateInfo } from "~/lib/ipc";
import { track } from "~/lib/analytics";

export type { UpdateInfo };

// Subscribes to the native update check (GitHub latest release vs the running
// version). Exposes the available update (or null), plus actions to skip a
// version and open the download link.
export function useUpdateCheck() {
  const update = ref<UpdateInfo | null>(null);
  let off: (() => void) | null = null;
  let lastAnnounced: string | null = null;

  onMounted(async () => {
    update.value = await getUpdate();
    off = onUpdateAvailable((u) => {
      update.value = u;
      if (u?.available && u.latest !== lastAnnounced) {
        lastAnnounced = u.latest;
        track("update_available", { latest_version: u.latest });
      }
    });
  });

  onBeforeUnmount(() => off?.());

  async function skipUpdate(version: string) {
    track("update_skipped", { skipped_version: version });
    update.value = await skipVersion(version);
  }

  function open(url: string) {
    openExternal(url);
  }

  return { update, skipUpdate, open };
}

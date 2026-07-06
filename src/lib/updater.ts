import { useEffect } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";

const TOAST_ID = "app-update";

// One update flow at a time: a second "Check for updates" click while a
// download is running must not start a parallel downloadAndInstall.
let busy = false;

/* ------------------------------------------------------------------ */
/* Toast presentation                                                  */
/*                                                                     */
/* The whole update UI is these four toasts (there is no dedicated     */
/* window). They're factored out so the real flow and the dev preview  */
/* render the exact same thing and can't drift apart.                  */
/* ------------------------------------------------------------------ */

function toastAvailable(
  version: string,
  onInstall: () => void,
  onLater: () => void,
): void {
  toast.info(`Update ${version} is available`, {
    id: TOAST_ID,
    duration: Infinity,
    action: { label: "Install", onClick: onInstall },
    cancel: { label: "Later", onClick: onLater },
    onDismiss: onLater,
  });
}

function toastDownloading(pct: number | null): void {
  toast.loading(
    pct === null ? "Downloading update…" : `Downloading update… ${pct}%`,
    { id: TOAST_ID, duration: Infinity },
  );
}

function toastInstalling(): void {
  toast.loading("Installing…", { id: TOAST_ID, duration: Infinity });
}

function toastInstalled(onRestart: () => void): void {
  toast.success("Update installed", {
    id: TOAST_ID,
    duration: Infinity,
    description: "Restart to switch to the new version.",
    action: { label: "Restart now", onClick: onRestart },
    cancel: { label: "Later", onClick: () => {} },
  });
}

/**
 * Check GitHub Releases for a newer version and walk the user through
 * install + restart via toasts.
 *
 * `silent` is the startup path: no feedback when already up to date or
 * when the check fails (offline, rate-limit) — the user didn't ask, so
 * we don't nag. The manual menu path reports every outcome.
 */
export async function checkForUpdates({ silent }: { silent: boolean }): Promise<void> {
  // The updater only works in packaged builds; in `tauri dev` the
  // current version is a moving target and there's nothing to install.
  // A manual check in dev replays the toast flow with mock data instead
  // so the UI can be eyeballed without cutting a real release.
  if (import.meta.env.DEV) {
    if (!silent && !busy) {
      busy = true;
      void previewUpdateFlow().finally(() => {
        busy = false;
      });
    }
    return;
  }
  if (busy) return;
  busy = true;
  try {
    let update: Update | null;
    try {
      update = await check();
    } catch (e) {
      if (!silent) {
        toast.error("Couldn't check for updates", {
          id: TOAST_ID,
          description: String(e),
        });
      }
      return;
    }

    if (!update) {
      if (!silent) toast.success("You're on the latest version.", { id: TOAST_ID });
      return;
    }

    // Found one. Both paths (silent and manual) surface it — that's the
    // whole point of the startup check.
    const version = update.version;
    await new Promise<void>((resolve) => {
      toastAvailable(
        version,
        () => {
          void installAndRestart(update);
          resolve();
        },
        () => resolve(),
      );
    });
  } finally {
    busy = false;
  }
}

async function installAndRestart(update: Update): Promise<void> {
  let total = 0;
  let received = 0;
  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          toastDownloading(0);
          break;
        case "Progress": {
          received += event.data.chunkLength;
          const pct = total > 0 ? Math.round((received / total) * 100) : null;
          toastDownloading(pct);
          break;
        }
        case "Finished":
          toastInstalling();
          break;
      }
    });
  } catch (e) {
    toast.error("Update failed", { id: TOAST_ID, description: String(e) });
    return;
  }

  toastInstalled(() => {
    void relaunch();
  });
}

/**
 * DEV-only: replay the update toast sequence with mock data so the UI
 * can be reviewed without publishing a real release. No network, no
 * download, no relaunch — the progress bar is a timer and "Restart now"
 * just clears the toast. Reached by clicking the manual "Check for
 * updates" control while running in dev.
 */
async function previewUpdateFlow(): Promise<void> {
  const version = "9.9.9";

  const install = await new Promise<boolean>((resolve) => {
    toastAvailable(
      version,
      () => resolve(true),
      () => resolve(false),
    );
  });
  if (!install) return;

  // Simulated download: tick 0 -> 100 over ~2.5s.
  toastDownloading(0);
  await new Promise<void>((resolve) => {
    let pct = 0;
    const timer = window.setInterval(() => {
      pct += 10;
      if (pct >= 100) {
        window.clearInterval(timer);
        toastDownloading(100);
        resolve();
      } else {
        toastDownloading(pct);
      }
    }, 250);
  });

  toastInstalling();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 800));

  toastInstalled(() => {
    toast.success("Preview only: a real update would restart here.", {
      id: TOAST_ID,
      duration: 4000,
    });
  });
}

/**
 * Mount once in AppShell: quiet update check shortly after launch.
 * Delayed a few seconds so it never competes with first paint, feed
 * loading, or the yt-dlp bootstrap for attention/bandwidth.
 */
export function useUpdateStartupCheck(): void {
  useEffect(() => {
    const t = window.setTimeout(() => {
      void checkForUpdates({ silent: true });
    }, 5000);
    return () => window.clearTimeout(t);
  }, []);
}

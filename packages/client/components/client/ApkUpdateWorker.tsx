import { onMount } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

const UPDATE_MANIFEST_URL = "https://app.sloga.gg/updates/android/latest.json";

/** Native bridge for sideloaded APK self-update (Android app only) */
const ApkUpdaterNative = Capacitor.isNativePlatform()
  ? registerPlugin<{
      getVersion(): Promise<{ versionCode: number; versionName: string }>;
      downloadAndInstall(options: { url: string }): Promise<void>;
    }>("ApkUpdater")
  : undefined;

interface UpdateManifest {
  versionCode: number;
  versionName: string;
  url: string;
  notes?: string;
}

/**
 * Checks the published Android manifest once on startup and offers to
 * download + install when a newer versionCode is available.
 */
export function ApkUpdateWorker() {
  onMount(async () => {
    if (!ApkUpdaterNative) return;

    try {
      const [{ versionCode }, response] = await Promise.all([
        ApkUpdaterNative.getVersion(),
        fetch(UPDATE_MANIFEST_URL),
      ]);

      if (!response.ok) return;
      const manifest: UpdateManifest = await response.json();

      if (!manifest?.url || manifest.versionCode <= versionCode) return;

      const notes = manifest.notes ? `\n\n${manifest.notes}` : "";
      if (
        confirm(
          `Sloga ${manifest.versionName} is available. Download and install now?${notes}`,
        )
      ) {
        await ApkUpdaterNative.downloadAndInstall({ url: manifest.url });
      }
    } catch (err) {
      console.error("APK update check failed:", err);
    }
  });

  return null;
}

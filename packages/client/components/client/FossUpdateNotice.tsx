import { onMount } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

import { useLingui } from "@lingui-solid/solid/macro";

const FOSS_MANIFEST_URL =
  "https://app.sloga.gg/updates/android/latest-foss.json";
const FOSS_DOWNLOAD_URL = "https://sloga.gg/dl/android-foss";

/** Installers that deliver this app's updates themselves (package ids INFERRED, plan U3 row). */
const UPDATING_INSTALLERS: readonly string[] = [
  "org.fdroid.fdroid",
  "org.fdroid.basic",
  "com.looker.droidify",
  "com.machiav3lli.fdroid",
  "dev.imranr.obtainium",
  "dev.imranr.obtainium.fdroid",
];

/**
 * Native bridge reporting this build's versionCode and installer (the foss
 * APK only). The plugin ships in the foss source set alone, so this is
 * undefined on play, sideload and web.
 */
const UpdateNoticeNative = Capacitor.isPluginAvailable("UpdateNotice")
  ? registerPlugin<{
      get(): Promise<{ versionCode: number; installer: string | null }>;
    }>("UpdateNotice")
  : undefined;

/** `latest-foss.json`; `url` is never read, the notice links the pinned page */
interface FossUpdateManifest {
  versionCode: number;
  versionName: string;
  url: string;
}

/**
 * Tells a website install of the foss APK, once per launch, that a newer
 * build is on sloga.gg, and offers to open the download page.
 *
 * The foss sibling of `ApkUpdateWorker`: it installs nothing and needs no
 * permission. Installs from an app store that updates the app itself
 * (F-Droid clients, Obtainium) get no notice, and make no request.
 */
export function FossUpdateNotice() {
  const { t } = useLingui();

  onMount(async () => {
    if (!UpdateNoticeNative) return;

    try {
      const { versionCode, installer } = await UpdateNoticeNative.get();

      // Before any network request, so a store install makes none.
      if (installer && UPDATING_INSTALLERS.includes(installer)) return;

      const response = await fetch(FOSS_MANIFEST_URL, { cache: "no-store" });
      if (!response.ok) return;
      const manifest: FossUpdateManifest = await response.json();

      const newer =
        Number.isInteger(manifest?.versionCode) &&
        typeof manifest?.versionName === "string" &&
        manifest.versionCode > versionCode;
      if (!newer) return;

      const versionName = manifest.versionName;
      if (
        confirm(
          t`Sloga ${versionName} is available. Open sloga.gg to download it?`,
        )
      ) {
        window.open(FOSS_DOWNLOAD_URL, "_blank");
      }
    } catch (err) {
      console.error("Foss update check failed:", err);
    }
  });

  return null;
}

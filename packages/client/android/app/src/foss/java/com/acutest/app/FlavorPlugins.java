package com.acutest.app;

import com.getcapacitor.BridgeActivity;

/**
 * FOSS distribution: F-Droid and the Google-free APK on sloga.gg.
 *
 * This flavor ships no self-updater: as on Play, ApkUpdaterPlugin and
 * REQUEST_INSTALL_PACKAGES live only in the `sideload` source set and are
 * absent from this build entirely. There is no FCM here either: the Google
 * messaging code sits in src/gms, which this flavor never compiles.
 *
 * Background push for this flavor comes from UnifiedPushPlugin (src/foss),
 * registered below.
 *
 * UpdateNoticePlugin (src/foss), also registered below, only tells website
 * installs that a newer APK is out and installs nothing itself, so this
 * flavor still ships no self-updater.
 */
final class FlavorPlugins {
    private FlavorPlugins() {}

    static void register(BridgeActivity activity) {
        // UnifiedPush replaces FCM here. No self-update on foss builds; see class docs.
        activity.registerPlugin(UnifiedPushPlugin.class);
        // Tells website installs a newer APK is out; installs nothing itself.
        activity.registerPlugin(UpdateNoticePlugin.class);
    }
}

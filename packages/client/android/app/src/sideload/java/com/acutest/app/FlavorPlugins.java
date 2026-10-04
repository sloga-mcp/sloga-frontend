package com.acutest.app;

import com.getcapacitor.BridgeActivity;

/**
 * Sideload distribution: the APK is served from sloga.gg, so the app carries
 * its own updater (ApkUpdaterPlugin + REQUEST_INSTALL_PACKAGES, both declared
 * only in this source set).
 *
 * The `play` flavor ships a no-op twin of this class — see
 * src/play/java/com/acutest/app/FlavorPlugins.java. The `foss` flavor's twin,
 * src/foss/java/com/acutest/app/FlavorPlugins.java, registers
 * UnifiedPushPlugin and the website-install update notice
 * (UpdateNoticePlugin) instead.
 */
final class FlavorPlugins {
    private FlavorPlugins() {}

    static void register(BridgeActivity activity) {
        activity.registerPlugin(ApkUpdaterPlugin.class);
    }
}

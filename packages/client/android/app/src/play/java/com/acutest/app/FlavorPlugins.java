package com.acutest.app;

import com.getcapacitor.BridgeActivity;

/**
 * Play Store distribution: registers only the Play Billing plugin.
 *
 * Google Play's Device and Network Abuse policy forbids an app distributed on
 * Play from modifying, replacing or updating itself by any mechanism other than
 * Play, and REQUEST_INSTALL_PACKAGES is restricted to apps whose core purpose
 * is installing packages — which a chat app is not. So ApkUpdaterPlugin and
 * that permission live only in the `sideload` source set and are absent from
 * this build entirely, rather than merely being disabled at runtime.
 *
 * Play Billing: Prot packs bought on Play must go through Google Play's
 * billing system, so this flavor, and only this one, registers
 * ProtStorePlugin (src/play), which wraps Play Billing Library. The billing
 * dependency is `playImplementation` in app/build.gradle, and the build
 * fails if the sideload or foss classpath resolves it. The plugin hands
 * purchase tokens to the server and never consumes a purchase: the server
 * verifies, credits and consumes it.
 */
final class FlavorPlugins {
    private FlavorPlugins() {}

    static void register(BridgeActivity activity) {
        // No self-update on Play builds; see class docs before adding anything.
        // Prot in-app purchases through Play Billing (play flavor only).
        activity.registerPlugin(ProtStorePlugin.class);
    }
}

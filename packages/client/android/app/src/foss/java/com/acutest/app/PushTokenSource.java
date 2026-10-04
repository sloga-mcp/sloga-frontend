package com.acutest.app;

import com.getcapacitor.PluginCall;

/**
 * F-Droid (foss) distribution: there is no FCM token to hand out.
 *
 * This build carries no Google or Firebase code, so FirebaseMessaging does not
 * exist here. Background push on foss comes from UnifiedPush, which has its own
 * plugin and never goes through PushToken.getToken. This twin exists only so
 * that PushTokenPlugin in src/main compiles in every flavor; the play and
 * sideload twin lives in src/gms.
 */
final class PushTokenSource {
    private PushTokenSource() {}

    static void fetch(PluginCall call) {
        call.reject("Push notifications are not available in this build", "PUSH_UNAVAILABLE");
    }
}

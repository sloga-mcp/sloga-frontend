package com.acutest.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * FCM token source for the play and sideload builds.
 *
 * This lives in src/gms so the foss build never compiles Firebase: F-Droid
 * rejects any Google code in the APK. The foss twin of this class has the same
 * signature and rejects the call instead.
 */
final class PushTokenSource {
    private PushTokenSource() {}

    static void fetch(PluginCall call) {
        FirebaseMessaging.getInstance().getToken()
                .addOnSuccessListener(token -> {
                    JSObject result = new JSObject();
                    result.put("token", token);
                    call.resolve(result);
                })
                .addOnFailureListener(e -> call.reject("Failed to get FCM token", e));
    }
}

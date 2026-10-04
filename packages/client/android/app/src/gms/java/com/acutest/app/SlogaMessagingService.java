package com.acutest.app;

import android.util.Log;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * FCM entry point for the play and sideload flavors only. This source dir is
 * not compiled into foss, so F-Droid's build carries no Google code. The
 * notification logic is shared with other push transports in SlogaNotifier.
 */
public class SlogaMessagingService extends FirebaseMessagingService {
    private static final String TAG = "SlogaFCM";

    @Override
    public void onNewToken(String token) {
        // FCM can rotate the token while the app is killed. The web layer only
        // re-syncs on the next app launch, so without this the backend would
        // hold a stale token and silently drop notifications until the user
        // reopens the app. Re-subscribe directly using credentials the web
        // layer persisted on its last successful subscribe.
        Log.i(TAG, "FCM token rotated; re-syncing with backend");
        if (token == null) return;

        JSONObject body;
        try {
            // pushd's FCM subscription shape: the token rides in "auth".
            body = new JSONObject()
                    .put("endpoint", "fcm")
                    .put("p256dh", "")
                    .put("auth", token);
        } catch (JSONException e) {
            Log.w(TAG, "Token re-sync error: " + e.getMessage());
            return;
        }
        PushResubscriber.post(this, body);
    }

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        SlogaNotifier.handle(this, remoteMessage.getData());
    }
}

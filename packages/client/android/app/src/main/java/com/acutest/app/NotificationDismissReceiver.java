package com.acutest.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Handles the Decline action on a ringing call notification. It stops the
 * ring on this phone, tells a running web layer, and tells the server.
 */
public class NotificationDismissReceiver extends BroadcastReceiver {
    private static final String TAG = "SlogaCalls";

    @Override
    public void onReceive(Context context, Intent intent) {
        String channelId = null;
        try {
            channelId = intent.getStringExtra("sloga_channel_id");
            // Takes the ring notification down, which also stops its ringtone.
            SlogaNotifier.resolveCall(context, channelId, "declined", false);
            // A running web layer still has the incoming-call popup up and
            // does not otherwise find out the call was declined here.
            MainActivity.dispatchCallDeclined(channelId);
        } catch (RuntimeException e) {
            // A failure in the steps on this phone must not keep the decline
            // from the server, so it is noted and the last step still runs.
            Log.w(TAG, "decline handling failed: " + e.getClass().getSimpleName());
        }
        // The server is told from here as well, because this broadcast can be
        // the only part of the app that is running. The request outlives
        // onReceive, so the broadcast is kept open until the poster ends it.
        CallDeclinePoster.post(context.getApplicationContext(), channelId, goAsync());
    }
}

package com.acutest.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationManagerCompat;

/** Dismisses a notification (used by the Decline action on incoming calls). */
public class NotificationDismissReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int id = intent.getIntExtra("notification_id", -1);
        if (id != -1) {
            NotificationManagerCompat.from(context).cancel(id);
        }
        // Cancelling stops the notification's ringtone, but the running web
        // layer still has the incoming-call popup up and does not otherwise
        // find out the call was declined.
        MainActivity.dispatchCallDeclined(intent.getStringExtra("sloga_channel_id"));
    }
}

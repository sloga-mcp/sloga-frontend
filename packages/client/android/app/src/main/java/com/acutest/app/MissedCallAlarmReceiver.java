package com.acutest.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;

/**
 * The phone's own end to a ring that nobody answered. The notifier sets one
 * alarm per chat when a ring starts and cancels it when the ring is resolved
 * any other way; if the alarm fires first, the notifier is told the ring timed
 * out and decides whether a missed-call notification is due.
 *
 * From Android 8 the alarm is inexact on purpose, so it needs no permission.
 * The system may deliver it late (it batches inexact alarms, and holds them
 * back further while the phone is idle), which only delays the missed-call
 * notification: the ring notification stops by its own timeout.
 *
 * Android 7 has no notification timeout, so there this alarm is the only
 * thing that stops the looping ringtone. It is set exact there, which needs
 * no permission before Android 12.
 */
public class MissedCallAlarmReceiver extends BroadcastReceiver {
    private static final String EXTRA_CHANNEL_ID = "sloga_channel_id";
    private static final String EXTRA_CALL_ID = "sloga_call_id";

    /** Keeps this alarm's request code apart from the ones the ring notification uses. */
    private static final int REQUEST_CODE_OFFSET = 400000;

    /**
     * Inexact, allowed while idle, no new permission: AlarmManager.setAndAllowWhileIdle with
     * ELAPSED_REALTIME_WAKEUP at now + delayMs. Below Android 8 it is
     * setExactAndAllowWhileIdle instead (see CallRingPolicy.useExactRingAlarm). Replaces any
     * alarm for the same chat. Does nothing without a channel id or an alarm service, and
     * never throws.
     */
    static void schedule(Context ctx, String channelId, String callId, long delayMs) {
        if (ctx == null || channelId == null) return;
        try {
            AlarmManager alarms = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (alarms == null) return;
            Intent intent = alarmIntent(ctx, channelId);
            if (callId != null) intent.putExtra(EXTRA_CALL_ID, callId);
            // The pending intent for a chat is found again by receiver and request code
            // alone, so FLAG_UPDATE_CURRENT swaps in these extras and setting the alarm
            // on it drops the earlier one.
            PendingIntent pending = PendingIntent.getBroadcast(
                ctx,
                requestCode(channelId),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            long at = SystemClock.elapsedRealtime() + Math.max(0L, delayMs);
            if (CallRingPolicy.useExactRingAlarm(Build.VERSION.SDK_INT)) {
                try {
                    alarms.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending);
                    return;
                } catch (SecurityException e) {
                    // Not expected below Android 12. The inexact alarm below
                    // still stops the ring, later.
                }
            }
            alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pending);
        } catch (RuntimeException ignored) {
            // SecurityException included. A ring that cannot set its alarm still
            // rings and still stops by its own timeout; only the missed-call
            // notification for an unanswered ring is lost.
        }
    }

    /** Cancels the alarm for this chat, if one is set. Never throws. */
    static void cancel(Context ctx, String channelId) {
        if (ctx == null || channelId == null) return;
        try {
            // FLAG_NO_CREATE answers null when no alarm was ever set for this chat.
            PendingIntent pending = PendingIntent.getBroadcast(
                ctx,
                requestCode(channelId),
                alarmIntent(ctx, channelId),
                PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE
            );
            if (pending == null) return;
            AlarmManager alarms = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (alarms != null) alarms.cancel(pending);
            pending.cancel();
        } catch (RuntimeException ignored) {
            // An alarm that could not be cancelled fires into the notifier, which
            // ignores a timeout for a ring it no longer holds.
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String channelId = intent.getStringExtra(EXTRA_CHANNEL_ID);
        // schedule never sets an alarm without a channel id.
        if (channelId == null) return;
        SlogaNotifier.onRingTimeout(context, channelId, intent.getStringExtra(EXTRA_CALL_ID));
    }

    private static Intent alarmIntent(Context ctx, String channelId) {
        Intent intent = new Intent(ctx, MissedCallAlarmReceiver.class);
        intent.putExtra(EXTRA_CHANNEL_ID, channelId);
        return intent;
    }

    private static int requestCode(String channelId) {
        return SlogaNotifier.callNotificationId(channelId) + REQUEST_CODE_OFFSET;
    }
}

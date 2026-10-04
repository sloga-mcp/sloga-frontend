package com.acutest.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/**
 * Turns a Sloga push payload (pushd's data map) into a notification-bar
 * entry. Shared by the FCM service (play/sideload) and the UnifiedPush
 * service (foss), so it must stay free of Google push-SDK imports: callers
 * pass the push data map.
 *
 * Runs on the caller's thread. fetchBitmap does network I/O, so never call
 * handle() from the main thread.
 */
final class SlogaNotifier {
    private static final String TAG = "SlogaFCM";
    // Channel settings are immutable after creation — bump the suffix to
    // apply new defaults on existing installs.
    private static final String CHANNEL_MESSAGES = "messages_v2";
    private static final String CHANNEL_CALLS = "incoming_calls_v2";
    private static final String CHANNEL_SOCIAL = "social_v2";

    private SlogaNotifier() {}

    static void handle(Context ctx, Map<String, String> data) {
        String type = data.get("type");
        if (type == null) return;

        ensureChannels(ctx);

        switch (type) {
            case "push.message": {
                String author = data.get("author_name");
                String body = data.get("body");
                String channel = data.get("channel");
                notifyTapToOpen(
                        ctx,
                        CHANNEL_MESSAGES,
                        channel != null ? channel.hashCode() : 1,
                        author != null ? author : "New message",
                        body != null ? body : "",
                        data.get("image"),
                        channel != null ? "/channel/" + channel : null);
                break;
            }
            case "push.dm.call": {
                boolean ended = Boolean.parseBoolean(data.get("ended"));
                String channelId = data.get("channel_id");
                int notificationId = channelId != null ? channelId.hashCode() : 2;
                if (ended) {
                    // Remove the incoming call notification
                    NotificationManagerCompat.from(ctx).cancel(notificationId);
                } else {
                    notifyIncomingCall(ctx, notificationId, channelId, data.get("initiator_id"));
                }
                break;
            }
            case "push.fr.receive": {
                String username = data.get("username");
                notifyTapToOpen(ctx, CHANNEL_SOCIAL, 3, "Friend Request",
                        (username != null ? username : "Someone") + " sent you a friend request",
                        null, "/friends");
                break;
            }
            case "push.fr.accept": {
                String username = data.get("username");
                notifyTapToOpen(ctx, CHANNEL_SOCIAL, 4, "Friend Request Accepted",
                        (username != null ? username : "Someone") + " accepted your friend request",
                        null, "/friends");
                break;
            }
            case "push.generic": {
                notifyTapToOpen(ctx, CHANNEL_MESSAGES, 5,
                        data.getOrDefault("title", "Sloga"),
                        data.getOrDefault("body", ""),
                        data.get("image"), null);
                break;
            }
            case "push.calendar": {
                String kind = data.get("kind");
                String eventTitle = data.get("title");
                String serverId = data.get("server_id");
                String eventId = data.get("event_id");
                String channelId = data.get("channel_id");
                String offsetMs = data.get("offset_ms");
                String title;
                String body;
                String channel;
                // Reminders land in the linked channel (the voice channel to
                // join); invites/cancellations land on the events page, where
                // the RSVP affordances live. Mirrors the web service worker.
                String path = serverId != null ? "/server/" + serverId + "/events" : null;
                if ("cancelled".equals(kind)) {
                    title = "Event cancelled";
                    body = (eventTitle != null ? eventTitle : "An event") + " was cancelled";
                    channel = CHANNEL_SOCIAL;
                } else if ("reminder".equals(kind)) {
                    // offset 0 = the at-start firing (explicit on the wire; never
                    // inferred from clocks) — mirrors the server-side render().
                    boolean started = "0".equals(offsetMs);
                    title = started ? "Event started" : "Upcoming event";
                    body = (eventTitle != null ? eventTitle : "An event")
                            + (started ? " has started" : " is starting soon");
                    channel = CHANNEL_MESSAGES; // time-sensitive -> high importance
                    if (serverId != null && channelId != null) {
                        path = "/server/" + serverId + "/channel/" + channelId;
                    }
                } else { // "invited" (or an unknown future kind)
                    title = "Event invitation";
                    body = "You're invited to " + (eventTitle != null ? eventTitle : "an event");
                    channel = CHANNEL_SOCIAL;
                }
                notifyTapToOpen(
                        ctx,
                        channel,
                        eventId != null ? eventId.hashCode() : 6,
                        title, body, null,
                        path);
                break;
            }
        }
    }

    /** Ringing notification with Answer / Decline actions */
    private static void notifyIncomingCall(Context ctx, int notificationId, String channelId, String callerId) {
        // ONE ringing UI at a time. With the app in front AND its web layer
        // connected, that layer already shows an Accept/Decline popup, so a
        // notification here is the duplicate the user has to dismiss twice.
        // Both conditions are required — see isInAppCallUiActive().
        if (MainActivity.isForeground() && PushTokenPlugin.isInAppCallUiActive()) {
            Log.i(TAG, "Suppressing call notification; the in-app popup is showing it");
            return;
        }

        String path = channelId != null ? "/channel/" + channelId : null;

        // RING intent — drives the full-screen intent and tapping the notification
        // body. Android fires a full-screen intent AUTOMATICALLY when the screen is
        // off or locked, so this MUST NOT answer: it only wakes the screen and opens
        // the ringing UI, where the user picks Accept or Decline. (Wiring the answer
        // intent here made calls auto-join with the screen still off.)
        Intent ring = new Intent(ctx, MainActivity.class);
        ring.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) ring.putExtra("sloga_path", path);
        ring.putExtra("sloga_ring_call", true);
        if (callerId != null) ring.putExtra("sloga_caller_id", callerId);
        // Proves to the exported MainActivity that Sloga minted this Intent.
        ring.putExtra(IntentNonce.EXTRA, IntentNonce.get(ctx));
        PendingIntent ringIntent = PendingIntent.getActivity(
                ctx, notificationId + 300000, ring,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // ANSWER intent — ONLY the explicit "Answer" action button joins the call.
        Intent answer = new Intent(ctx, MainActivity.class);
        answer.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) answer.putExtra("sloga_path", path);
        answer.putExtra("sloga_answer_call", true);
        answer.putExtra(IntentNonce.EXTRA, IntentNonce.get(ctx));
        PendingIntent answerIntent = PendingIntent.getActivity(
                ctx, notificationId + 100000, answer,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent decline = new Intent(ctx, NotificationDismissReceiver.class);
        decline.putExtra("notification_id", notificationId);
        // Lets the receiver tell a running web layer which call was declined.
        if (channelId != null) decline.putExtra("sloga_channel_id", channelId);
        PendingIntent declineIntent = PendingIntent.getBroadcast(
                ctx, notificationId + 200000, decline,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_CALLS)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Incoming Call")
                .setContentText("Someone is calling you on Sloga")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setOngoing(true)
                .setAutoCancel(true)
                .setFullScreenIntent(ringIntent, true)
                .setContentIntent(ringIntent)
                .addAction(0, "Decline", declineIntent)
                .addAction(0, "Answer", answerIntent)
                .setTimeoutAfter(45_000);

        try {
            NotificationManagerCompat.from(ctx).notify(notificationId, builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Notification permission not granted");
        }
    }

    private static void notifyTapToOpen(
            Context ctx, String channelId, int notificationId, String title, String body,
            String imageUrl, String path) {
        Intent launch = new Intent(ctx, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) launch.putExtra("sloga_path", path);
        launch.putExtra(IntentNonce.EXTRA, IntentNonce.get(ctx));
        PendingIntent contentIntent = PendingIntent.getActivity(
                ctx, notificationId, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, channelId)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(contentIntent)
                .setPriority(CHANNEL_CALLS.equals(channelId)
                        ? NotificationCompat.PRIORITY_MAX
                        : NotificationCompat.PRIORITY_HIGH);

        Bitmap avatar = fetchBitmap(imageUrl);
        if (avatar != null) builder.setLargeIcon(avatar);

        try {
            NotificationManagerCompat.from(ctx).notify(notificationId, builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Notification permission not granted");
        }
    }

    private static Bitmap fetchBitmap(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);
            return BitmapFactory.decodeStream(conn.getInputStream());
        } catch (Exception e) {
            return null;
        }
    }

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = ctx.getSystemService(NotificationManager.class);
            android.media.AudioAttributes attrs = new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            android.net.Uri sound = android.media.RingtoneManager
                    .getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION);

            NotificationChannel messages = new NotificationChannel(
                    CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
            messages.setSound(sound, attrs);
            messages.enableVibration(true);
            manager.createNotificationChannel(messages);

            NotificationChannel calls = new NotificationChannel(
                    CHANNEL_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            calls.setDescription("Ringing for incoming voice calls");
            calls.setSound(android.media.RingtoneManager
                    .getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE), attrs);
            calls.enableVibration(true);
            manager.createNotificationChannel(calls);

            NotificationChannel social = new NotificationChannel(
                    CHANNEL_SOCIAL, "Friend requests", NotificationManager.IMPORTANCE_DEFAULT);
            social.setSound(sound, attrs);
            manager.createNotificationChannel(social);
        }
    }
}

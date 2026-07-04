package com.acutest.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;

/**
 * Receives data-only FCM messages from the Sloga backend (pushd) and posts
 * them to the notification bar. Runs even when the app is killed.
 */
public class SlogaMessagingService extends FirebaseMessagingService {
    private static final String TAG = "SlogaFCM";
    // Channel settings are immutable after creation — bump the suffix to
    // apply new defaults on existing installs.
    private static final String CHANNEL_MESSAGES = "messages_v2";
    private static final String CHANNEL_CALLS = "incoming_calls_v2";
    private static final String CHANNEL_SOCIAL = "social_v2";

    @Override
    public void onNewToken(String token) {
        // The web layer re-syncs the token on every app start, so nothing to
        // do here; log for debugging.
        Log.i(TAG, "FCM token rotated");
    }

    @Override
    public void onMessageReceived(RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        String type = data.get("type");
        if (type == null) return;

        createChannels();

        switch (type) {
            case "push.message": {
                String author = data.get("author_name");
                String body = data.get("body");
                String channel = data.get("channel");
                notifyTapToOpen(
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
                    NotificationManagerCompat.from(this).cancel(notificationId);
                } else {
                    notifyIncomingCall(notificationId, channelId);
                }
                break;
            }
            case "push.fr.receive": {
                String username = data.get("username");
                notifyTapToOpen(CHANNEL_SOCIAL, 3, "Friend Request",
                        (username != null ? username : "Someone") + " sent you a friend request",
                        null, "/friends");
                break;
            }
            case "push.fr.accept": {
                String username = data.get("username");
                notifyTapToOpen(CHANNEL_SOCIAL, 4, "Friend Request Accepted",
                        (username != null ? username : "Someone") + " accepted your friend request",
                        null, "/friends");
                break;
            }
            case "push.generic": {
                notifyTapToOpen(CHANNEL_MESSAGES, 5,
                        data.getOrDefault("title", "Sloga"),
                        data.getOrDefault("body", ""),
                        data.get("image"), null);
                break;
            }
        }
    }

    /** Ringing notification with Answer / Decline actions */
    private void notifyIncomingCall(int notificationId, String channelId) {
        String path = channelId != null ? "/channel/" + channelId : null;

        Intent answer = new Intent(this, MainActivity.class);
        answer.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) answer.putExtra("acutest_path", path);
        answer.putExtra("acutest_answer_call", true);
        PendingIntent answerIntent = PendingIntent.getActivity(
                this, notificationId + 100000, answer,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent decline = new Intent(this, NotificationDismissReceiver.class);
        decline.putExtra("notification_id", notificationId);
        PendingIntent declineIntent = PendingIntent.getBroadcast(
                this, notificationId + 200000, decline,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_CALLS)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Incoming Call")
                .setContentText("Someone is calling you on Sloga")
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setOngoing(true)
                .setAutoCancel(true)
                .setFullScreenIntent(answerIntent, true)
                .setContentIntent(answerIntent)
                .addAction(0, "Decline", declineIntent)
                .addAction(0, "Answer", answerIntent)
                .setTimeoutAfter(45_000);

        try {
            NotificationManagerCompat.from(this).notify(notificationId, builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Notification permission not granted");
        }
    }

    private void notifyTapToOpen(
            String channelId, int notificationId, String title, String body,
            String imageUrl, String path) {
        Intent launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) launch.putExtra("acutest_path", path);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, notificationId, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, channelId)
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
            NotificationManagerCompat.from(this).notify(notificationId, builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Notification permission not granted");
        }
    }

    private Bitmap fetchBitmap(String url) {
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

    private void createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
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

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
 * Receives data-only FCM messages from the Acutest backend (pushd) and posts
 * them to the notification bar. Runs even when the app is killed.
 */
public class AcutestMessagingService extends FirebaseMessagingService {
    private static final String TAG = "AcutestFCM";
    private static final String CHANNEL_MESSAGES = "messages";
    private static final String CHANNEL_CALLS = "incoming_calls";
    private static final String CHANNEL_SOCIAL = "social";

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
                if (ended) {
                    // Remove the incoming call notification
                    NotificationManagerCompat.from(this)
                            .cancel(channelId != null ? channelId.hashCode() : 2);
                } else {
                    notifyTapToOpen(
                            CHANNEL_CALLS,
                            channelId != null ? channelId.hashCode() : 2,
                            "Incoming Call",
                            "Someone is calling you",
                            null,
                            channelId != null ? "/channel/" + channelId : null);
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
                        data.getOrDefault("title", "Acutest"),
                        data.getOrDefault("body", ""),
                        data.get("image"), null);
                break;
            }
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
            manager.createNotificationChannel(new NotificationChannel(
                    CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH));
            NotificationChannel calls = new NotificationChannel(
                    CHANNEL_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            calls.setDescription("Ringing for incoming voice calls");
            manager.createNotificationChannel(calls);
            manager.createNotificationChannel(new NotificationChannel(
                    CHANNEL_SOCIAL, "Friend requests", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }
}

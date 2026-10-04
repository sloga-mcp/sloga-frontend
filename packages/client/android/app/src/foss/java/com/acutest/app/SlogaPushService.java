package com.acutest.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PublicKeySet;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * UnifiedPush entry point for the foss flavor only; the play and sideload twin
 * is SlogaMessagingService in src/gms. The connector binds this service through
 * the PUSH_EVENT action declared in the foss manifest and calls it on the main
 * thread.
 *
 * pushd sends the same flat data map it sends FCM, encrypted to the web push
 * keys the connector generated, so notifications go through SlogaNotifier as
 * on the other flavors. The endpoint and its keys are mirrored into the
 * "sloga_push" prefs for UnifiedPushPlugin, whose pending register() call this
 * service settles.
 */
public class SlogaPushService extends PushService {
    private static final String TAG = "SlogaUnifiedPush";
    private static final String PREFS = "sloga_push";
    private static final long WAKE_LOCK_TIMEOUT_MS = 30_000;

    // One worker for the whole process, so notifications are posted in the
    // order they arrived (a call's "ended" must not overtake its ring).
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();

    @Override
    public void onMessage(PushMessage message, String instance) {
        // When the connector can't decrypt a message it hands over the raw
        // bytes with decrypted=false. Only an old server sends those (legacy
        // aesgcm), and nothing unencrypted is trusted as a notification.
        if (!message.getDecrypted()) {
            Log.w(TAG, "Dropping a push message that was not encrypted for this device");
            return;
        }

        Map<String, String> data = parse(message.getContent());
        if (data == null) {
            Log.w(TAG, "Dropping a push message that is not a JSON object");
            return;
        }

        // SlogaNotifier does network I/O (avatars), so it can't run here on the
        // main thread. The connector unbinds this service a few seconds after
        // the event; the wake lock keeps the CPU up until the notification is
        // posted.
        Context ctx = getApplicationContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sloga:uppush");
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
        WORKER.execute(() -> {
            try {
                SlogaNotifier.handle(ctx, data);
            } catch (RuntimeException e) {
                Log.w(TAG, "Push notification error: " + e.getMessage());
            } finally {
                if (wakeLock.isHeld()) wakeLock.release();
            }
        });
    }

    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        PublicKeySet keys = endpoint.getPubKeySet();
        if (keys == null) {
            // pushd only sends encrypted web push, which needs these keys.
            Log.w(TAG, "New endpoint has no web push keys; not using it");
            clearRegistration(prefs);
            UnifiedPushPlugin.deliverRegistrationFailed("no web push keys");
            return;
        }

        String url = endpoint.getUrl();
        String p256dh = keys.getPubKey();
        String auth = keys.getAuth();

        SharedPreferences.Editor edit = prefs.edit()
                .putString("up_endpoint", url)
                .putString("up_p256dh", p256dh)
                .putString("up_auth", auth);
        // register() records the VAPID key it asked for, and this endpoint is
        // the answer, so that key is now the one the registration was made
        // with. With nothing pending the distributor replaced the endpoint on
        // its own and the stored key still applies.
        String requested = prefs.getString("up_vapid_requested", null);
        if (requested != null) {
            edit.putString("up_vapid", requested).remove("up_vapid_requested");
        }
        edit.apply();

        // Tell pushd now: the app may be closed, and the web layer only
        // re-syncs on its next launch.
        try {
            PushResubscriber.post(this, new JSONObject()
                    .put("endpoint", url)
                    .put("p256dh", p256dh)
                    .put("auth", auth)
                    .put("kind", "unifiedpush"));
        } catch (JSONException e) {
            Log.w(TAG, "Endpoint re-sync error: " + e.getMessage());
        }

        UnifiedPushPlugin.deliverEndpoint(url, p256dh, auth);
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {
        // The connector has already dropped this instance and its keys, so
        // nothing stored here describes a live endpoint any more.
        Log.w(TAG, "Registration failed: " + reason.name());
        clearRegistration(getSharedPreferences(PREFS, Context.MODE_PRIVATE));
        UnifiedPushPlugin.deliverRegistrationFailed(reason.name());
    }

    @Override
    public void onUnregistered(String instance) {
        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // No stored endpoint means the app unregistered itself and has
        // already cleared it.
        if (prefs.getString("up_endpoint", null) == null) return;

        // The distributor dropped us (the user removed Sloga in it, say).
        // pushd still holds the dead endpoint, so drop it there too.
        Log.i(TAG, "Unregistered by the distributor; unsubscribing");
        unsubscribe(prefs);
        clearRegistration(prefs);
    }

    /**
     * pushd's payload is the flat string map FCM carries. Numbers and booleans
     * are turned into strings; nulls, nested objects and arrays are skipped.
     * Returns null when the content isn't a JSON object.
     */
    private static Map<String, String> parse(byte[] content) {
        JSONObject json;
        try {
            json = new JSONObject(new String(content, StandardCharsets.UTF_8));
        } catch (JSONException e) {
            return null;
        }

        Map<String, String> data = new HashMap<>();
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = json.opt(key);
            if (value instanceof String) {
                data.put(key, (String) value);
            } else if (value instanceof Number || value instanceof Boolean) {
                data.put(key, String.valueOf(value));
            }
        }
        return data;
    }

    /**
     * Clears the UnifiedPush registration keys. Every clear removes all five,
     * here and in UnifiedPushPlugin, which has its own copy of this list.
     */
    private static void clearRegistration(SharedPreferences prefs) {
        prefs.edit()
                .remove("up_endpoint")
                .remove("up_p256dh")
                .remove("up_auth")
                .remove("up_vapid")
                .remove("up_vapid_requested")
                .apply();
    }

    /**
     * POST /push/unsubscribe with the credentials the web layer persisted,
     * the way PushResubscriber posts /push/subscribe. No-op when there are no
     * stored credentials. Runs on its own thread.
     */
    private static void unsubscribe(SharedPreferences prefs) {
        String apiUrl = prefs.getString("api_url", null);
        String sessionToken = prefs.getString("session_token", null);
        if (apiUrl == null || sessionToken == null) return;

        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(apiUrl.replaceAll("/+$", "") + "/push/unsubscribe");
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                // The route takes no body; send an explicit empty one.
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(0);
                conn.setRequestProperty("X-Session-Token", sessionToken);
                conn.getOutputStream().close();
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    Log.w(TAG, "Unsubscribe failed: HTTP " + code);
                }
            } catch (Exception e) {
                Log.w(TAG, "Unsubscribe error: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }
}

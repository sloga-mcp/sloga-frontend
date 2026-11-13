package com.acutest.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * Re-registers this device with pushd while the app may be killed. Used by the
 * FCM service (token rotation) and the UnifiedPush service (new endpoint), so
 * delivery keeps working before the web layer re-syncs on the next launch. The
 * body is built by the caller with JSONObject so endpoint URLs are escaped
 * correctly.
 */
final class PushResubscriber {
    private static final String TAG = "SlogaPush";

    private PushResubscriber() {}

    /**
     * POST the subscription body to pushd using the credentials the web layer
     * persisted on its last successful subscribe. No-op when the user isn't
     * subscribed/logged in (no stored credentials). Runs off the caller's
     * thread so it never blocks the push service.
     */
    static void post(Context ctx, JSONObject body) {
        SharedPreferences prefs = ctx.getSharedPreferences("sloga_push", Context.MODE_PRIVATE);
        String apiUrl = prefs.getString("api_url", null);
        String sessionToken = prefs.getString("session_token", null);
        if (apiUrl == null || sessionToken == null) return;

        // The web layer sends this device's two notification choices with
        // every subscribe, and each subscribe replaces the one before it. A
        // re-post from here without them would switch server notifications
        // and ringing back on for this device, so the stored choices are
        // added to the body first.
        //
        // The body is turned into bytes here, on the caller's thread.
        // JSONObject is not safe to share between threads, and this way the
        // worker below is handed nothing but bytes that can no longer change.
        final byte[] payload;
        try {
            JSONObject merged = withStoredPrefs(
                    body,
                    storedTrue(prefs, "pref_chats_only"),
                    storedTrue(prefs, "pref_no_ring"));
            payload = merged.toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            // A body that cannot be copied (a missing one, say) is not sent.
            // The web layer subscribes again on the next launch. Only the
            // kind of failure is logged.
            Log.w(TAG, "Token re-sync skipped: " + e.getClass().getSimpleName());
            return;
        }

        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(apiUrl.replaceAll("/+$", "") + "/push/subscribe");
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("X-Session-Token", sessionToken);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload);
                }
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    Log.w(TAG, "Token re-sync failed: HTTP " + code);
                }
            } catch (Exception e) {
                Log.w(TAG, "Token re-sync error: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    /**
     * A copy of body with this device's two notification choices added.
     *
     * "chats_only" is added only when chatsOnly is true, and "no_ring" only
     * when noRing is true. A choice that is off adds no key at all, because
     * the server reads a missing key as off and false is never sent. The web
     * layer decides which keys to send by the same rule (pushPrefs in
     * components/client/pushPolicy.ts). A key the body already has is left
     * with the value the caller gave it.
     *
     * body itself is not changed. The copy holds the same value objects as
     * body, so it is meant to be turned into text straight away, as post()
     * does, and not kept.
     */
    static JSONObject withStoredPrefs(JSONObject body, boolean chatsOnly, boolean noRing)
            throws JSONException {
        JSONObject out = new JSONObject();
        Iterator<String> keys = body.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            out.put(key, body.get(key));
        }
        if (chatsOnly && !out.has("chats_only")) out.put("chats_only", true);
        if (noRing && !out.has("no_ring")) out.put("no_ring", true);
        return out;
    }

    /**
     * Whether a choice is stored as on. Only a stored boolean true counts. A
     * missing key, or a value of some other type, reads as off.
     */
    private static boolean storedTrue(SharedPreferences prefs, String key) {
        try {
            return prefs.getBoolean(key, false);
        } catch (ClassCastException e) {
            return false;
        }
    }
}

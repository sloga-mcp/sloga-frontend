package com.acutest.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

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
                    os.write(body.toString().getBytes("UTF-8"));
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
}

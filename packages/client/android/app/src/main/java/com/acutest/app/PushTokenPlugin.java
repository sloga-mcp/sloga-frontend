package com.acutest.app;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * JS bridge for FCM push: request notification permission and fetch the
 * device registration token so the web layer can subscribe with the backend.
 */
@CapacitorPlugin(
        name = "PushToken",
        permissions = @Permission(
                strings = { "android.permission.POST_NOTIFICATIONS" },
                alias = "notifications"))
public class PushTokenPlugin extends Plugin {
    private static String pendingPath;
    private static boolean pendingAnswer;
    private static boolean pendingRing;
    private static String pendingCallerId;

    static void setPendingAction(String path, boolean answer, boolean ring, String callerId) {
        pendingPath = path;
        pendingAnswer = answer;
        pendingRing = ring;
        pendingCallerId = callerId;
    }

    /** Returns and clears the navigation requested by a tapped notification */
    @PluginMethod
    public void consumeLaunchAction(PluginCall call) {
        JSObject result = new JSObject();
        result.put("path", pendingPath);
        result.put("answer", pendingAnswer);
        result.put("ring", pendingRing);
        result.put("callerId", pendingCallerId);
        pendingPath = null;
        pendingAnswer = false;
        pendingRing = false;
        pendingCallerId = null;
        call.resolve(result);
    }

    /**
     * Cancel the ringing call notification for a channel. Called when the
     * in-app incoming-call popup is resolved (accepted, declined or timed out)
     * so the native ringtone stops instead of ringing on into the call. The
     * notification id is derived here so JS never has to reproduce Java's
     * String.hashCode().
     */
    @PluginMethod
    public void dismissCallNotification(PluginCall call) {
        String channelId = call.getString("channelId");
        if (channelId != null) {
            androidx.core.app.NotificationManagerCompat.from(getContext())
                    .cancel(channelId.hashCode());
        }
        // The ring is over — give up the lockscreen bypass the full-screen
        // intent asked for, so the app can't be read over the keyguard later.
        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).clearRingingWindowFlags();
        }
        call.resolve();
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permissionGranted");
        } else {
            resolveToken(call);
        }
    }

    @PermissionCallback
    private void permissionGranted(PluginCall call) {
        // Fetch the token regardless — notifications will show once permitted
        resolveToken(call);
    }

    private void resolveToken(PluginCall call) {
        FirebaseMessaging.getInstance().getToken()
                .addOnSuccessListener(token -> {
                    JSObject result = new JSObject();
                    result.put("token", token);
                    call.resolve(result);
                })
                .addOnFailureListener(e -> call.reject("Failed to get FCM token", e));
    }

    /**
     * Persist the API base URL + session token so SlogaMessagingService can
     * re-subscribe on its own when FCM rotates the token while the app is
     * killed. Called by the web layer after each successful /push/subscribe.
     */
    @PluginMethod
    public void saveSubscription(PluginCall call) {
        SharedPreferences prefs = getContext()
                .getSharedPreferences("sloga_push", Context.MODE_PRIVATE);
        prefs.edit()
                .putString("api_url", call.getString("apiUrl"))
                .putString("session_token", call.getString("sessionToken"))
                .apply();
        call.resolve();
    }

    /**
     * Clear stored credentials (logout / unsubscribe) so a later token
     * rotation can't re-register this now-invalid session.
     */
    @PluginMethod
    public void clearSubscription(PluginCall call) {
        getContext().getSharedPreferences("sloga_push", Context.MODE_PRIVATE)
                .edit().clear().apply();
        call.resolve();
    }
}

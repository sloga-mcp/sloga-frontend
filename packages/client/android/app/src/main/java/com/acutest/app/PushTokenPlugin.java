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

/**
 * JS bridge for native push: request notification permission and fetch a
 * device push token from the per-flavor PushTokenSource so the web layer can
 * subscribe with the backend. On play and sideload that is the FCM
 * registration token. foss has no FCM token and getToken rejects with
 * PUSH_UNAVAILABLE; its background push comes from UnifiedPush through
 * its own plugin instead.
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

    /**
     * Whether the web layer is connected and will therefore present its own
     * incoming-call popup. Set by the client on every connection-state change.
     *
     * This is the SECOND half of the notification-suppression guard, and it is
     * load-bearing: the in-app popup is driven by the websocket join event, so
     * a foregrounded app with a dead socket never shows one. Suppressing on
     * "foreground" alone would turn that into a silently missed call.
     */
    private static volatile boolean inAppCallUiActive = false;

    static boolean isInAppCallUiActive() {
        return inAppCallUiActive;
    }

    /** Web layer reporting whether it can currently show the ringing popup. */
    @PluginMethod
    public void setInAppCallUiActive(PluginCall call) {
        inAppCallUiActive = Boolean.TRUE.equals(call.getBoolean("active", Boolean.FALSE));
        call.resolve();
    }

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

    /**
     * Whether this app may show a ringing call over the lockscreen.
     *
     * From Android 14 the OS grants USE_FULL_SCREEN_INTENT only to apps it
     * classifies as calling/alarm apps; everyone else is denied by default and
     * a full-screen intent is silently DEMOTED to an ordinary heads-up
     * notification. On a sleeping phone that means the ringtone plays and the
     * screen never lights up — indistinguishable from a broken app.
     */
    @PluginMethod
    public void canUseFullScreenIntent(PluginCall call) {
        JSObject result = new JSObject();
        boolean allowed = true;
        if (android.os.Build.VERSION.SDK_INT >= 34) {
            android.app.NotificationManager nm =
                    getContext().getSystemService(android.app.NotificationManager.class);
            allowed = nm == null || nm.canUseFullScreenIntent();
        }
        result.put("allowed", allowed);
        result.put("applicable", android.os.Build.VERSION.SDK_INT >= 34);
        result.put("sdk", android.os.Build.VERSION.SDK_INT);
        call.resolve(result);
    }

    /**
     * Open the system screen for the permission above. OEM skins bury or
     * rename it, so deep-link by intent rather than describing a menu path.
     */
    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT < 34) {
            call.resolve();
            return;
        }
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                    android.net.Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open full-screen notification settings", e);
        }
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
        PushTokenSource.fetch(call);
    }

    /**
     * Ask for POST_NOTIFICATIONS on its own. getToken only asks as part of
     * the FCM flow, so builds without FCM (foss) need this to show anything.
     */
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (android.os.Build.VERSION.SDK_INT < 33
                || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("granted", true);
            call.resolve(result);
        } else {
            requestPermissionForAlias("notifications", call, "notificationPermissionResult");
        }
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(result);
    }

    /**
     * Persist the API base URL + session token for PushResubscriber, which
     * reads them back to re-subscribe on its own while the app is killed.
     * The FCM service (play/sideload) calls it when FCM rotates the token,
     * and it is written to serve a new UnifiedPush endpoint (foss) as well.
     * Called by the web layer after each successful /push/subscribe.
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

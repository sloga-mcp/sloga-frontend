package com.acutest.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /**
     * The live activity, so the Decline broadcast receiver can reach the
     * WebView. Weak so a destroyed activity is never held alive.
     */
    private static java.lang.ref.WeakReference<MainActivity> INSTANCE;

    /**
     * Tell the web layer a ringing call was declined from the notification's
     * action button. Cancelling the notification stops the system ringtone,
     * but the in-app popup has no other way to learn the call is over. No-op
     * when the app isn't running — there is no popup to dismiss then.
     */
    static void dispatchCallDeclined(String channelId) {
        MainActivity activity = INSTANCE == null ? null : INSTANCE.get();
        if (activity == null || activity.bridge == null) return;
        activity.runOnUiThread(() -> activity.bridge.triggerWindowJSEvent(
                "slogaNotificationAction",
                "{\"declined\":true,\"channelId\":"
                        + (channelId != null ? "\"" + channelId + "\"" : "null")
                        + "}"));
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        INSTANCE = new java.lang.ref.WeakReference<>(this);
        registerPlugin(VoiceCallServicePlugin.class);
        registerPlugin(PushTokenPlugin.class);
        registerPlugin(AppFlavorPlugin.class);
        // Sideload builds add the self-updater here; the Play flavor's twin of
        // this class registers nothing. See FlavorPlugins in src/{sideload,play}.
        FlavorPlugins.register(this);
        registerPlugin(SpeechToTextPlugin.class);
        registerPlugin(com.acutest.app.e2ee.E2eePlugin.class);
        registerPlugin(com.acutest.app.watch.JellyfinPlugin.class);
        registerPlugin(com.acutest.app.screenshare.ScreenSharePlugin.class);
        super.onCreate(savedInstanceState);
        // One WebViewClient serves both native interceptors: decrypted E2EE
        // attachments (/_e2ee-att/, in the E2eeWebViewClient base) and
        // watch-together Jellyfin media (/_jf/, saved servers only) — the
        // Android analogs of the desktop e2ee-att and jf protocol handlers.
        bridge.setWebViewClient(new com.acutest.app.watch.JellyfinWebViewClient(bridge));

        // DEBUG-ONLY WebView conveniences (slice-4 gate HIGH #1 / MEDIUM #2):
        // release ships with these OFF via capacitor.config so a local
        // attacker cannot attach devtools to read decrypted E2EE plaintext
        // or inject cleartext subresources into the plaintext-capable
        // origin. Re-enabled here strictly for debug builds.
        if (com.acutest.app.BuildConfig.DEBUG && bridge.getWebView() != null) {
            android.webkit.WebView.setWebContentsDebuggingEnabled(true);
            bridge.getWebView().getSettings().setMixedContentMode(
                    android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        handleNotificationIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleNotificationIntent(intent);
    }

    /** Route notification taps (message / ring / answer call) into the web app */
    private void handleNotificationIntent(Intent intent) {
        if (intent == null) return;
        String path = intent.getStringExtra("sloga_path");
        if (path == null) return;
        boolean answer = intent.getBooleanExtra("sloga_answer_call", false);
        boolean ring = intent.getBooleanExtra("sloga_ring_call", false);
        String callerId = intent.getStringExtra("sloga_caller_id");
        intent.removeExtra("sloga_path");
        intent.removeExtra("sloga_ring_call");
        intent.removeExtra("sloga_answer_call");

        // Action-button taps don't auto-dismiss notifications — clear the
        // call notification once we're handling the answer.
        if (answer) {
            String channelId = path.substring(path.lastIndexOf('/') + 1);
            androidx.core.app.NotificationManagerCompat.from(this)
                    .cancel(channelId.hashCode());
        }

        // A full-screen intent fires while the device is asleep or locked. Wake
        // the display and show over the keyguard so the Accept/Decline UI is
        // actually reachable — the call must NEVER be joined without that
        // explicit choice.
        if (ring) applyRingingWindowFlags();

        PushTokenPlugin.setPendingAction(path, answer, ring, callerId);
        if (bridge != null) {
            bridge.triggerWindowJSEvent(
                    "slogaNotificationAction",
                    "{\"path\":\"" + path + "\",\"answer\":" + answer
                            + ",\"ring\":" + ring
                            + ",\"callerId\":"
                            + (callerId != null ? "\"" + callerId + "\"" : "null")
                            + "}");
        }
    }

    /** Turn the screen on and show over the lockscreen while a call is ringing. */
    private void applyRingingWindowFlags() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                    android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        // Don't let the display sleep again mid-ring.
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /**
     * Drop the lockscreen bypass once the ring is over. Without this a single
     * incoming call would leave the app permanently showable over the keyguard —
     * anyone could read the user's DMs without unlocking.
     *
     * Deliberately NOT called from onPause: a full-screen intent that arrives
     * while the device is asleep can pause the activity during the launch race,
     * and clearing `turnScreenOn` there cancels the very wake it was asked for
     * (observed on a Retroid Pocket 5 / Android 13 — the screen stayed off).
     * The lifetime is tied to the RING instead: cleared when the popup is
     * resolved (accept / decline / timeout, via PushTokenPlugin), with onStop as
     * a backstop for when the activity is genuinely no longer visible.
     */
    void clearRingingWindowFlags() {
        runOnUiThread(() -> {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(false);
                setTurnScreenOn(false);
            } else {
                getWindow().clearFlags(
                        android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                                | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            }
            getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    @Override
    public void onStop() {
        super.onStop();
        clearRingingWindowFlags();
    }

    // Declared public, not protected: BridgeActivity widens some lifecycle
    // methods and a narrowing override fails to compile.
    @Override
    public void onDestroy() {
        if (INSTANCE != null && INSTANCE.get() == this) INSTANCE = null;
        super.onDestroy();
    }
}

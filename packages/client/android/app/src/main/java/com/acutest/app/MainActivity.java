package com.acutest.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceCallServicePlugin.class);
        registerPlugin(PushTokenPlugin.class);
        registerPlugin(ApkUpdaterPlugin.class);
        registerPlugin(SpeechToTextPlugin.class);
        registerPlugin(com.acutest.app.e2ee.E2eePlugin.class);
        super.onCreate(savedInstanceState);
        // Serve decrypted E2EE attachments from the native layer (the
        // Android analog of the desktop e2ee-att protocol handler)
        bridge.setWebViewClient(new com.acutest.app.e2ee.E2eeWebViewClient(bridge));

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
     * Drop the lockscreen bypass once the app leaves the foreground. Without
     * this a single incoming call would leave the app permanently showable over
     * the keyguard — anyone could read the user's DMs without unlocking.
     */
    private void clearRingingWindowFlags() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        } else {
            getWindow().clearFlags(
                    android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    public void onPause() {
        super.onPause();
        clearRingingWindowFlags();
    }
}

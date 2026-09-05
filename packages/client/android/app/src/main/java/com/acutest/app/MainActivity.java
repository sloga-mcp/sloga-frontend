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
     * Whether the activity is resumed. Read by SlogaMessagingService to decide
     * whether an incoming-call NOTIFICATION is needed at all: when the app is
     * in front, the web layer shows its own Accept/Decline popup and a
     * notification would give the user two separate things to decline.
     */
    private static volatile boolean FOREGROUND = false;

    static boolean isForeground() {
        return FOREGROUND;
    }

    @Override
    public void onResume() {
        super.onResume();
        FOREGROUND = true;
    }

    @Override
    public void onPause() {
        FOREGROUND = false;
        super.onPause();
    }

    /**
     * Tell the web layer a ringing call was declined from the notification's
     * action button. Cancelling the notification stops the system ringtone,
     * but the in-app popup has no other way to learn the call is over. No-op
     * when the app isn't running — there is no popup to dismiss then.
     */
    static void dispatchCallDeclined(String channelId) {
        MainActivity activity = INSTANCE == null ? null : INSTANCE.get();
        if (activity == null || activity.bridge == null) return;
        org.json.JSONObject detail = new org.json.JSONObject();
        try {
            detail.put("declined", true);
            detail.put(
                    "channelId",
                    channelId == null ? org.json.JSONObject.NULL : channelId);
        } catch (org.json.JSONException e) {
            return;
        }
        final String payload = detail.toString();
        activity.runOnUiThread(() -> activity.bridge.triggerWindowJSEvent(
                "slogaNotificationAction", payload));
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

        // This activity is exported, so anything on the device can start it
        // with crafted extras. Only Intents Sloga minted itself carry the
        // per-install nonce, so everything else is dropped before a single
        // field reaches the web layer. This is what stops a zero-permission
        // app from driving the WebView -- or from forcing a mic-live call
        // join by handing us sloga_answer_call.
        if (!IntentNonce.matches(this, intent.getStringExtra(IntentNonce.EXTRA))) {
            intent.removeExtra("sloga_path");
            intent.removeExtra("sloga_ring_call");
            intent.removeExtra("sloga_answer_call");
            intent.removeExtra("sloga_caller_id");
            return;
        }

        boolean answer = intent.getBooleanExtra("sloga_answer_call", false);
        boolean ring = intent.getBooleanExtra("sloga_ring_call", false);
        String callerId = intent.getStringExtra("sloga_caller_id");
        intent.removeExtra("sloga_path");
        intent.removeExtra("sloga_ring_call");
        intent.removeExtra("sloga_answer_call");
        intent.removeExtra("sloga_caller_id");
        intent.removeExtra(IntentNonce.EXTRA);

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
                    notificationActionPayload(path, answer, ring, callerId));
        }
    }

    /**
     * Build the event detail as JSON rather than by concatenation. Capacitor
     * inlines this string into the JS source it hands to evaluateJavascript,
     * so a bare quote in any field used to escape straight into executable
     * code. JSON escaping makes that impossible; the nonce gate above decides
     * WHETHER we are called, and this decides that what we pass can only ever
     * be read as data.
     */
    private static String notificationActionPayload(
            String path, boolean answer, boolean ring, String callerId) {
        org.json.JSONObject detail = new org.json.JSONObject();
        try {
            detail.put("path", path);
            detail.put("answer", answer);
            detail.put("ring", ring);
            detail.put(
                    "callerId",
                    callerId == null ? org.json.JSONObject.NULL : callerId);
        } catch (org.json.JSONException e) {
            return "{}";
        }
        return detail.toString();
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

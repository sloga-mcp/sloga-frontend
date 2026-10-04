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
     * Whether the activity is resumed. Read by SlogaNotifier, through
     * isForeground(), to decide whether an incoming-call NOTIFICATION is
     * needed at all: when the app is in front, the web layer shows its own
     * Accept/Decline popup and a notification would give the user two
     * separate things to decline.
     */
    private static volatile boolean FOREGROUND = false;

    /**
     * Window event fired for every back press. The web layer's
     * AndroidBackWorker walks the dismissal ladder and, only when nothing was
     * left to dismiss, calls back in through SlogaBackPlugin.exitApp().
     */
    private static final String BACK_EVENT = "slogaBackPressed";

    /**
     * Wedge escape hatch. A back press is ALWAYS consumed here (see
     * {@link #onBackGesture()}), so a web layer that has stopped listening —
     * a JS crash after boot, say — would otherwise leave a back key that does
     * nothing at all, forever.
     *
     * Deliberately set well above any plausible deliberate peel: eight presses
     * inside two seconds is four a second, which is a user mashing a dead key,
     * not a user closing eight stacked overlays one at a time.
     */
    private static final int WEDGE_PRESS_COUNT = 8;

    private static final long WEDGE_WINDOW_MS = 2000L;

    private int backPressesSinceReply = 0;
    private long backBurstStartedAt = 0L;

    /** API 33+ predictive-back registration. Null on API 24-32. */
    @androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.TIRAMISU)
    private Api33Back api33Back;

    /** API 24-32 registration. Null on API 33+. */
    private androidx.activity.OnBackPressedCallback legacyBackCallback;

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
        // A user who left and came back starts a fresh burst: the wedge hatch
        // must never fire on presses accumulated in an earlier visit.
        backPressesSinceReply = 0;
        backBurstStartedAt = 0L;
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
        registerPlugin(SlogaBackPlugin.class);
        // Sideload adds the self-updater; foss adds UnifiedPush and the
        // website-install update notice; the Play twin registers nothing. See
        // FlavorPlugins in src/{sideload,play,foss}.
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

        // Must come after super.onCreate(): getOnBackInvokedDispatcher() reads
        // the activity's window, which does not exist before then.
        registerBackHandling();

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

        // A recreated activity (process death, then back via Recents) or a
        // launch from history is handed the ORIGINAL Intent again, not the
        // copy handleNotificationIntent stripped in memory. Replaying it would
        // re-run a stale Answer tap and join that call, mic live, long after
        // the ring ended; the nonce cannot catch it because it is our own.
        boolean fromHistory =
                (getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
        if (savedInstanceState == null && !fromHistory) {
            handleNotificationIntent(getIntent());
        }
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
        // Every notification extra is read below the nonce gate. A new extra
        // must be read there too, never above it.
        String path = intent.getStringExtra("sloga_path");
        if (path == null) return;

        // This activity is exported, so anything on the device can start it
        // with crafted extras. Only Intents Sloga minted itself carry the
        // per-install nonce, so everything else is dropped before a single
        // field reaches the web layer. This is what stops a zero-permission
        // app from driving the WebView -- or from forcing a mic-live call
        // join by handing us sloga_answer_call.
        if (!IntentNonce.matches(this, intent.getStringExtra(IntentNonce.EXTRA))) {
            // No field is logged: the extras are untrusted input.
            android.util.Log.w("SlogaIntent", "dropped a notification Intent without this install's nonce");
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
     * Route the hardware Back key and the predictive-back gesture into the web
     * app instead of letting the Activity finish.
     *
     * Reported 2026-09-12: viewing a profile and pressing Back closed the whole
     * app. Nothing in this project handled back — not this class, not
     * Capacitor's BridgeActivity, not the web layer — so the press fell through
     * to the Activity default and finished the task, for EVERY overlay rather
     * than only profiles.
     *
     * Two registrations, and the if/else below makes them mutually exclusive,
     * so a single press can never run the handler twice:
     *
     * <ul>
     *   <li>API 33+ (TIRAMISU): {@code targetSdkVersion = 36} opts this app
     *       into predictive back, so the platform dispatches through
     *       OnBackInvokedDispatcher and {@code onBackPressed()} is never
     *       called. An {@code onBackPressed()} override would be dead code on
     *       exactly the devices that matter, while still passing on an API-32
     *       emulator.
     *   <li>API 24-32: no platform dispatcher exists, so androidx's
     *       OnBackPressedDispatcher is the only route.
     * </ul>
     *
     * Registering both on 33+ would be wrong rather than merely redundant:
     * androidx activity 1.11.0 bridges its own dispatcher onto the platform one
     * (OnBackPressedDispatcher$Api33Impl calls registerOnBackInvokedCallback),
     * so the two registrations would compete for the same PRIORITY_DEFAULT slot
     * and which of them the platform invoked would depend on registration
     * order. The platform invokes only the topmost callback, so the visible
     * result would be a coin flip, not a double fire — but it would be a coin
     * flip between two paths that must stay identical forever.
     */
    private void registerBackHandling() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            api33Back = new Api33Back(this);
            api33Back.register();
        } else {
            legacyBackCallback =
                    new androidx.activity.OnBackPressedCallback(true) {
                        @Override
                        public void handleOnBackPressed() {
                            onBackGesture();
                        }
                    };
            // Tied to this activity's lifecycle, so androidx removes it on
            // DESTROY and it cannot outlive the activity it captures.
            getOnBackPressedDispatcher().addCallback(this, legacyBackCallback);
        }
    }

    /**
     * API 33+ predictive-back registration, kept in its own class so the
     * {@code android.window} types it names are never resolved on an older
     * device. Same shape androidx.activity uses for its own Api33Impl.
     *
     * The annotation is load-bearing for the build, not decoration. Lint's
     * ApiDetector is not inter-procedural: it sees the guarded construction in
     * registerBackHandling() but analyses register() and unregister() on their
     * own, where {@code android.window.OnBackInvokedDispatcher} is an API-33
     * type reached with no version check in sight — a NewApi error, and NewApi
     * is fatal by default (there is no {@code lint} block and no lint.xml, so
     * {@code abortOnError} is true and lintVitalRelease runs on release
     * assembly). androidx annotates its own OnBackPressedDispatcher$Api33Impl
     * exactly this way. @RequiresApi is CLASS-retention, so nothing about it
     * survives into the running app.
     */
    @androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.TIRAMISU)
    private static final class Api33Back {
        private final MainActivity activity;
        private final android.window.OnBackInvokedCallback callback;

        Api33Back(MainActivity activity) {
            this.activity = activity;
            this.callback = activity::onBackGesture;
        }

        void register() {
            activity
                    .getOnBackInvokedDispatcher()
                    .registerOnBackInvokedCallback(
                            android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
        }

        void unregister() {
            activity.getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(callback);
        }
    }

    /**
     * One back press, from whichever of the two registrations is live.
     *
     * The press is ALWAYS consumed. The ladder that decides what a press means
     * — fullscreen, floating elements, modals, the channel side column, the
     * slide drawer, history — lives in the web layer and answers
     * asynchronously, so there is no way to tell the platform "not handled" in
     * time. That is why the last rung of that ladder has to call back in
     * through SlogaBackPlugin rather than simply declining the event.
     */
    private void onBackGesture() {
        long now = android.os.SystemClock.uptimeMillis();
        if (now - backBurstStartedAt > WEDGE_WINDOW_MS) {
            backBurstStartedAt = now;
            backPressesSinceReply = 0;
        }
        backPressesSinceReply++;

        // There is nobody to ask. Consuming here would be a back key that can
        // never do anything, so take the platform's own behaviour instead.
        if (bridge == null || bridge.getWebView() == null) {
            leaveApp();
            return;
        }

        if (backPressesSinceReply >= WEDGE_PRESS_COUNT) {
            android.util.Log.w(
                    "SlogaBack",
                    "web layer answered none of " + backPressesSinceReply + " back presses; leaving");
            leaveApp();
            return;
        }

        bridge.triggerWindowJSEvent(BACK_EVENT, "{\"seq\":" + backPressesSinceReply + "}");
    }

    /**
     * The web layer walked its whole dismissal ladder and found nothing to
     * dismiss and nowhere to navigate. Called from SlogaBackPlugin.exitApp(),
     * which may be delivered on a background thread.
     */
    void exitFromWebLayer() {
        runOnUiThread(this::leaveApp);
    }

    /**
     * Leave the app the way the platform itself has for a root launcher
     * activity since Android 12: background the task rather than finish it, so
     * the next launch is warm and the web app keeps its state. finish() is only
     * the fallback for the cases moveTaskToBack declines — an activity that is
     * not the root of its task.
     */
    private void leaveApp() {
        backPressesSinceReply = 0;
        backBurstStartedAt = 0L;
        if (!moveTaskToBack(true)) finish();
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
        // The platform dispatcher holds a strong reference to the callback, and
        // the callback holds this activity: without this the whole Activity
        // leaks for as long as its window lives. Before super.onDestroy(), so
        // the window getOnBackInvokedDispatcher() reads is still there.
        //
        // The SDK_INT test is redundant at runtime — api33Back is assigned only
        // inside the identical check in registerBackHandling(), so non-null
        // already implies API 33+ — and is here for lint. @RequiresApi
        // propagates to callers, so once Api33Back carries it an unguarded call
        // site is itself a NewApi error; a null test is not a version check.
        // Nested rather than `&&` so every annotated usage sits plainly inside
        // the version-checked block. Unregistration is unchanged: every device
        // that ever registered still unregisters, at the same point in
        // onDestroy, before super.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            if (api33Back != null) {
                api33Back.unregister();
                api33Back = null;
            }
        }
        // The API 24-32 callback was added with addCallback(this, ...), so
        // androidx already removes it on DESTROY; dropping the reference here
        // only keeps the two paths symmetrical.
        legacyBackCallback = null;
        if (INSTANCE != null && INSTANCE.get() == this) INSTANCE = null;
        super.onDestroy();
    }
}

package com.acutest.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /**
     * The live activity, so the Decline broadcast receiver and the notifier
     * can reach it from their own threads. Weak so a destroyed activity is
     * never held alive; volatile so those threads see the current one.
     */
    private static volatile java.lang.ref.WeakReference<MainActivity> INSTANCE;

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

    /**
     * How long an Answer tap may wait for the lock screen to go away. An older
     * tap is forgotten, so an unlock much later can never join a call the user
     * has stopped thinking about. It applies on every Android version: the
     * platform can report a dismissal late, and this bounds how late.
     */
    private static final long HELD_ANSWER_MAX_MS = 60_000L;

    /*
     * Right after the platform reports the lock screen dismissed, the keyguard
     * query can still read locked while the lock screen animates away. The
     * Answer is handed on only once the query reads unlocked, so it is asked
     * again every CallRingPolicy.UNLOCK_SETTLE_POLL_MS, for at most
     * CallRingPolicy.UNLOCK_SETTLE_MAX_MS. PushTokenPlugin.ensureUnlocked
     * waits for the query the same way.
     */

    /**
     * The chat whose ring put the lock-screen window flags on, or null while
     * they are off. Only the end of that chat's ring takes them off early;
     * the safety timer and every other exit take them off whatever the chat.
     * Main thread only.
     */
    private String ringFlagsChannelId;

    /** Token of the timer that takes the ring flags off when the ring's time is up. */
    private final Object ringFlagsTimer = new Object();

    /**
     * The one Answer tap that is waiting for the user to unlock, or null.
     *
     * It lives in this field and nowhere else. It is not written to the saved
     * instance state and it is not static, so a recreated activity starts
     * without it, and onDestroy clears it. Nothing about it reaches the web
     * layer or PushTokenPlugin until {@link #proceedWithAnswer} runs.
     *
     * Read and written on the main thread only.
     */
    private HeldAnswer heldAnswer;

    /** Whether this activity instance is between onResume and onPause. */
    private boolean resumed = false;

    /** Runs the held Answer's expiry and its unlock re-checks. */
    private final android.os.Handler mainHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());

    static boolean isForeground() {
        return FOREGROUND;
    }

    @Override
    public void onResume() {
        super.onResume();
        FOREGROUND = true;
        resumed = true;
        // An Answer taken while the lock screen was up continues from here:
        // the platform only accepts an unlock request from a resumed activity,
        // and on Android 7 a resume with the lock screen gone is the only
        // signal that the user unlocked.
        advanceHeldAnswer();
    }

    @Override
    public void onPause() {
        FOREGROUND = false;
        resumed = false;
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
     *
     * A Decline also withdraws an Answer for the same chat that is still
     * waiting for the unlock. Without that, Answer, then Decline, then an
     * unlock inside the waiting time would join the call the user declined.
     */
    static void dispatchCallDeclined(String channelId) {
        MainActivity activity = liveInstance();
        if (activity == null) return;
        org.json.JSONObject detail = new org.json.JSONObject();
        String built;
        try {
            detail.put("declined", true);
            detail.put(
                    "channelId",
                    channelId == null ? org.json.JSONObject.NULL : channelId);
            built = detail.toString();
        } catch (org.json.JSONException e) {
            built = null;
        }
        final String payload = built;
        activity.runOnUiThread(() -> {
            // First, and whether or not there is a web layer to tell.
            activity.dropHeldAnswerFor(channelId);
            if (payload != null && activity.bridge != null) {
                activity.bridge.triggerWindowJSEvent("slogaNotificationAction", payload);
            }
        });
    }

    /**
     * The ring for this chat is over on this device, for any reason: answered
     * here or elsewhere, declined, ended, timed out or dismissed. Called by
     * SlogaNotifier.resolveCall from any thread, after the stored ring is
     * gone. On the activity's main thread it drops an Answer still waiting
     * for the unlock for this chat, and takes the lock-screen window flags
     * off when this chat's ring put them on. Another chat's waiting Answer
     * and another chat's ringing flags are left alone. Never throws.
     *
     * The stored ring is gone before this runs, and the ring Intent only puts
     * the flags on while its ring is stored (see handleNotificationIntent),
     * so the flags cannot come back for this ring afterwards.
     */
    static void onRingResolved(final String channelId) {
        final MainActivity activity = liveInstance();
        if (activity == null) return;
        try {
            activity.runOnUiThread(() -> activity.ringOver(channelId, false));
        } catch (RuntimeException e) {
            android.util.Log.w("SlogaIntent", "could not end a ring on the activity");
        }
    }

    /**
     * Sign-out: drop any waiting Answer and the lock-screen window flags,
     * whatever chat they were for. Any thread. Never throws.
     */
    static void onSignedOut() {
        final MainActivity activity = liveInstance();
        if (activity == null) return;
        try {
            activity.runOnUiThread(() -> activity.ringOver(null, true));
        } catch (RuntimeException e) {
            android.util.Log.w("SlogaIntent", "could not clear the rings on the activity");
        }
    }

    private static MainActivity liveInstance() {
        java.lang.ref.WeakReference<MainActivity> ref = INSTANCE;
        return ref == null ? null : ref.get();
    }

    /** The two halves of onRingResolved and onSignedOut. Main thread only. */
    private void ringOver(String channelId, boolean everyChat) {
        HeldAnswer held = heldAnswer;
        String heldChannelId = held == null ? null : held.action.channelId;
        if (held != null
                && (everyChat || CallRingPolicy.ringResolutionApplies(channelId, heldChannelId))) {
            clearHeldAnswer();
        }
        if (everyChat || CallRingPolicy.ringResolutionApplies(channelId, ringFlagsChannelId)) {
            removeRingingWindowFlags();
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        INSTANCE = new java.lang.ref.WeakReference<>(this);
        registerPlugin(VoiceCallServicePlugin.class);
        registerPlugin(PushTokenPlugin.class);
        registerPlugin(AppFlavorPlugin.class);
        registerPlugin(SlogaBackPlugin.class);
        registerPlugin(CallAudioRoutePlugin.class);
        // Sideload adds the self-updater; foss adds UnifiedPush and the
        // website-install update notice; the Play twin registers nothing. See
        // FlavorPlugins in src/{sideload,play,foss}.
        FlavorPlugins.register(this);
        registerPlugin(SpeechToTextPlugin.class);
        registerPlugin(com.acutest.app.e2ee.E2eePlugin.class);
        registerPlugin(com.acutest.app.watch.JellyfinPlugin.class);
        registerPlugin(com.acutest.app.screenshare.ScreenSharePlugin.class);
        registerPlugin(PasskeyPlugin.class);
        // Empty capability marker. JS reads
        // Capacitor.isPluginAvailable("ScreenShareAudio") synchronously at
        // module load to learn whether system-audio capture
        // (AudioPlaybackCapture, API 29) exists. JS must never ask through
        // ScreenShare.isAvailable(): @capacitor/android 8.4.x can lose the
        // reply to the first native call after a WebView reload (screen-leg
        // plan wave 4h; see androidLegStartPolicy.ts). Registered only when
        // the APK was built with screen audio (BuildConfig.SCREEN_SHARE_AUDIO)
        // AND on API 29+, so the header itself is the answer and a dark APK
        // never offers audio.
        if (com.acutest.app.BuildConfig.SCREEN_SHARE_AUDIO
                && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            registerPlugin(com.acutest.app.screenshare.ScreenShareAudioPlugin.class);
        }
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
            intent.removeExtra("sloga_call_id");
            intent.removeExtra("sloga_video");
            return;
        }

        boolean answer = intent.getBooleanExtra("sloga_answer_call", false);
        boolean ring = intent.getBooleanExtra("sloga_ring_call", false);
        String callerId = intent.getStringExtra("sloga_caller_id");
        String callId = intent.getStringExtra("sloga_call_id");
        boolean video = intent.getBooleanExtra("sloga_video", false);
        intent.removeExtra("sloga_path");
        intent.removeExtra("sloga_ring_call");
        intent.removeExtra("sloga_answer_call");
        intent.removeExtra("sloga_caller_id");
        intent.removeExtra("sloga_call_id");
        intent.removeExtra("sloga_video");
        intent.removeExtra(IntentNonce.EXTRA);

        // Asked now, for this Intent, and never remembered from an earlier one.
        boolean locked = keyguardLockedOrUnknown();

        if (answer) {
            // An Answer takes its own route and never falls through to the
            // code below, which can only ever say "not an answer". The ring
            // extra is ignored here: the notifier never sets both, and an
            // Answer must not ask to be shown over the lock screen. The time
            // of the tap goes with it: the Answer's age counts from here.
            onAnswerTapped(
                    new AnswerAction(
                            path, callerId, callId, video,
                            android.os.SystemClock.elapsedRealtime()),
                    locked);
            return;
        }

        // A full-screen intent fires while the device is asleep or locked. Wake
        // the display and show over the keyguard so the Accept/Decline UI is
        // actually reachable — the call must NEVER be joined without that
        // explicit choice. Only for a ring that is still on record and still
        // has time left: a ring that was resolved, or one that ran out, never
        // gets the lock screen bypass again.
        if (ring) {
            String ringChannelId = CallRingPolicy.channelIdFromPath(path);
            long holdMs = SlogaNotifier.ringFlagsHoldMs(this, ringChannelId, callId);
            if (holdMs > 0L) applyRingingWindowFlags(ringChannelId, holdMs);
        }

        // The literal false is the point: this path opens a chat or shows the
        // ring, and has no way to tell the web layer to join. The lock state
        // is passed along for the ring screen to read and decides nothing
        // here. An Answer that is waiting for the unlock is left alone; it
        // carries its own chat and call and cannot pick up this Intent's.
        PushTokenPlugin.setPendingAction(path, false, ring, callerId, callId, video, locked);
        if (bridge != null) {
            bridge.triggerWindowJSEvent(
                    "slogaNotificationAction",
                    notificationActionPayload(path, false, ring, callerId, callId, video, locked));
        }
    }

    /**
     * Whether the lock screen is up. A missing service or a failed query reads
     * as locked, so a broken answer can only ever make the app more careful.
     */
    private boolean keyguardLockedOrUnknown() {
        try {
            android.app.KeyguardManager keyguard = (android.app.KeyguardManager)
                    getSystemService(android.content.Context.KEYGUARD_SERVICE);
            return keyguard == null || keyguard.isKeyguardLocked();
        } catch (RuntimeException e) {
            return true;
        }
    }

    /** What one Answer tap asked for. Never changes after the tap. */
    private static final class AnswerAction {
        final String path;
        final String channelId;
        final String callerId;
        final String callId;
        final boolean video;
        /** SystemClock.elapsedRealtime() when the tap reached the activity. */
        final long tappedAt;

        AnswerAction(
                String path, String callerId, String callId, boolean video, long tappedAt) {
            this.path = path;
            this.channelId = CallRingPolicy.channelIdFromPath(path);
            this.callerId = callerId;
            this.callId = callId;
            this.video = video;
            this.tappedAt = tappedAt;
        }
    }

    /** An Answer tap that arrived while the lock screen was up. */
    private static final class HeldAnswer {
        final AnswerAction action;
        /** SystemClock.elapsedRealtime() at the tap; it keeps counting in sleep. */
        final long heldAt;
        /** The platform was asked to dismiss the lock screen for this tap. */
        boolean dismissRequested;
        /** The platform reported that dismissal as done. */
        boolean unlockReported;
        long unlockReportedAt;
        /** A re-check of the lock state is already queued. */
        boolean settleCheckQueued;

        HeldAnswer(AnswerAction action, long heldAt) {
            this.action = action;
            this.heldAt = heldAt;
        }
    }

    /**
     * The user pressed Answer on the call notification.
     *
     * With the lock screen down the call is answered at once. With it up the
     * tap is only remembered: the notification keeps ringing, the stored ring
     * stays, and the web layer is told nothing until the user has unlocked.
     */
    private void onAnswerTapped(AnswerAction action, boolean locked) {
        // One Answer waits at a time, and the newest tap is the one the user
        // means. Whatever was waiting is forgotten, whichever chat it was for.
        clearHeldAnswer();

        if (!locked) {
            proceedWithAnswer(action);
            return;
        }

        final HeldAnswer held =
                new HeldAnswer(action, android.os.SystemClock.elapsedRealtime());
        heldAnswer = held;
        // Frees the memory on time. The age check in advanceHeldAnswer is what
        // actually refuses a late Answer, because this timer does not count
        // time the phone spent asleep.
        mainHandler.postAtTime(
                () -> {
                    if (heldAnswer == held) clearHeldAnswer();
                },
                held,
                android.os.SystemClock.uptimeMillis() + HELD_ANSWER_MAX_MS);
        // Resumed already: ask for the unlock now. Otherwise onResume does.
        advanceHeldAnswer();
    }

    /**
     * Move the waiting Answer one step: forget it when it is too old, answer
     * when the lock screen is gone, otherwise ask the platform to dismiss the
     * lock screen (Android 8 and later, once, and only while resumed) or keep
     * waiting for the user to unlock by themselves (Android 7).
     */
    private void advanceHeldAnswer() {
        final HeldAnswer held = heldAnswer;
        if (held == null) return;

        long now = android.os.SystemClock.elapsedRealtime();
        if (isDestroyed() || now - held.heldAt >= HELD_ANSWER_MAX_MS) {
            clearHeldAnswer();
            return;
        }

        if (!keyguardLockedOrUnknown()) {
            // Taken out of the field first, so no later callback or timer can
            // answer the same tap a second time.
            clearHeldAnswer();
            proceedWithAnswer(held.action);
            return;
        }

        if (held.unlockReported) {
            // Dismissed according to the platform, still locked according to
            // the query. Ask again shortly, and give up if it never agrees.
            if (!CallRingPolicy.unlockSettleKeepWaiting(held.unlockReportedAt, now)) {
                clearHeldAnswer();
                return;
            }
            if (!held.settleCheckQueued) {
                held.settleCheckQueued = true;
                mainHandler.postAtTime(
                        () -> {
                            held.settleCheckQueued = false;
                            if (heldAnswer == held) advanceHeldAnswer();
                        },
                        held,
                        android.os.SystemClock.uptimeMillis()
                                + CallRingPolicy.UNLOCK_SETTLE_POLL_MS);
            }
            return;
        }

        if (!resumed) return;

        // On Android 7 there is nothing to ask: the Answer waits for a later
        // resume with the lock screen gone. Nested rather than `&&`, so the
        // annotated call sits plainly inside the version-checked block.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            if (!held.dismissRequested) {
                held.dismissRequested = true;
                if (!Api26Keyguard.requestDismiss(this, held)) {
                    // The request could not even be made. Same as a failed unlock.
                    android.util.Log.i(
                            "SlogaIntent",
                            "an Answer was dropped: the unlock could not be requested");
                    if (heldAnswer == held) clearHeldAnswer();
                }
            }
        }
    }

    /**
     * The platform's reply to the unlock request made for one waiting Answer.
     * A reply for an Answer that has since been replaced, withdrawn, answered
     * or forgotten is ignored: only the very object the request was made for
     * can still be in the field.
     */
    private void onKeyguardDismissResult(HeldAnswer held, boolean succeeded) {
        if (heldAnswer != held) return;
        if (!succeeded) {
            // Cancelled or failed. The Answer is gone for good: nothing was
            // parked, nothing was sent, and the ring was never touched, so it
            // keeps going and the user can press Answer again.
            android.util.Log.i("SlogaIntent", "an Answer was dropped: the unlock did not complete");
            clearHeldAnswer();
            return;
        }
        held.unlockReported = true;
        held.unlockReportedAt = android.os.SystemClock.elapsedRealtime();
        advanceHeldAnswer();
    }

    /** Forget the waiting Answer, if any, and its timers. Main thread only. */
    private void clearHeldAnswer() {
        HeldAnswer held = heldAnswer;
        if (held == null) return;
        heldAnswer = null;
        mainHandler.removeCallbacksAndMessages(held);
    }

    /** Forget the waiting Answer when it is for this chat, or for any chat when none is named. */
    private void dropHeldAnswerFor(String channelId) {
        HeldAnswer held = heldAnswer;
        if (held == null) return;
        if (channelId == null || channelId.equals(held.action.channelId)) clearHeldAnswer();
    }

    /**
     * Answer the call. This is the only code that tells the web layer to join:
     * no other call to setPendingAction or notificationActionPayload in this
     * file passes true for the answer.
     *
     * It refuses while the lock screen is up, whoever called it, so an Answer
     * can not reach the web layer, parked or sent, before the user unlocked.
     *
     * The order matters. The ring is closed as answered first, so it stops and
     * is not counted as a missed call. The lock screen bypass the ring asked
     * for is given up next. Only then is the action parked for a web layer
     * that is still starting and sent to one that is already running. The
     * parked action carries the time of the tap, so the time spent waiting
     * for the unlock counts against its age limit too.
     */
    private void proceedWithAnswer(AnswerAction action) {
        if (isDestroyed() || keyguardLockedOrUnknown()) return;

        SlogaNotifier.resolveCall(this, action.channelId, "answered", false);
        clearRingingWindowFlags();
        PushTokenPlugin.setPendingAction(
                action.path, true, false, action.callerId, action.callId, action.video, false,
                action.tappedAt);
        if (bridge != null) {
            bridge.triggerWindowJSEvent(
                    "slogaNotificationAction",
                    notificationActionPayload(
                            action.path, true, false, action.callerId, action.callId,
                            action.video, false));
        }
    }

    /**
     * The Android 8+ unlock request, kept in its own class so the callback
     * type it names is never resolved on Android 7. Same reason and same
     * annotation as {@link Api33Back}.
     */
    @androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.O)
    private static final class Api26Keyguard {
        private Api26Keyguard() {}

        /**
         * Ask the platform to dismiss the lock screen, showing the PIN,
         * pattern or password prompt when there is one. Returns false when
         * the request could not be made at all.
         */
        static boolean requestDismiss(final MainActivity activity, final HeldAnswer held) {
            try {
                android.app.KeyguardManager keyguard = (android.app.KeyguardManager)
                        activity.getSystemService(android.content.Context.KEYGUARD_SERVICE);
                if (keyguard == null) return false;
                keyguard.requestDismissKeyguard(
                        activity,
                        new android.app.KeyguardManager.KeyguardDismissCallback() {
                            @Override
                            public void onDismissSucceeded() {
                                reply(true);
                            }

                            @Override
                            public void onDismissCancelled() {
                                reply(false);
                            }

                            @Override
                            public void onDismissError() {
                                reply(false);
                            }

                            private void reply(boolean succeeded) {
                                // The platform already replies on the main
                                // thread. This keeps the held Answer on one
                                // thread even if a device does not.
                                activity.runOnUiThread(
                                        () -> activity.onKeyguardDismissResult(held, succeeded));
                            }
                        });
                return true;
            } catch (RuntimeException e) {
                return false;
            }
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
     *
     * {@code locked} is the lock state when the Intent was handled. It is
     * there for the ring screen to read. The web layer asks again, through
     * PushToken.isLocked(), before it acts on an Answer.
     */
    private static String notificationActionPayload(
            String path, boolean answer, boolean ring, String callerId, String callId,
            boolean video, boolean locked) {
        org.json.JSONObject detail = new org.json.JSONObject();
        try {
            detail.put("path", path);
            detail.put("answer", answer);
            detail.put("ring", ring);
            detail.put(
                    "callerId",
                    callerId == null ? org.json.JSONObject.NULL : callerId);
            detail.put(
                    "callId",
                    callId == null ? org.json.JSONObject.NULL : callId);
            detail.put("video", video);
            detail.put("locked", locked);
        } catch (org.json.JSONException e) {
            return "{}";
        }
        return detail.toString();
    }

    /**
     * Turn the screen on and show over the lockscreen while a call is ringing.
     * The flags now belong to this chat's ring, and a timer takes them off
     * after holdMs (the ring's time left plus a margin) even if nothing else
     * does. A later ring takes the flags over and restarts the timer.
     */
    private void applyRingingWindowFlags(String channelId, long holdMs) {
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
        ringFlagsChannelId = channelId;
        mainHandler.removeCallbacksAndMessages(ringFlagsTimer);
        mainHandler.postAtTime(
                this::removeRingingWindowFlags,
                ringFlagsTimer,
                android.os.SystemClock.uptimeMillis() + holdMs);
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
     * resolved (accept / decline / timeout, via PushTokenPlugin), when the
     * ring ends natively (onRingResolved), and by the safety timer set with
     * the flags, with onStop as a backstop for when the activity is genuinely
     * no longer visible.
     *
     * Every caller of this method is saying the ring is over, so an Answer
     * that is still waiting for the unlock is forgotten here too. That covers
     * a Decline or a timeout in the in-app popup while a notification Answer
     * waits: unlocking afterwards must not join that call. onStop does not go
     * through here, see below.
     */
    void clearRingingWindowFlags() {
        runOnUiThread(() -> {
            clearHeldAnswer();
            removeRingingWindowFlags();
        });
    }

    /**
     * The window half of clearRingingWindowFlags, and the one place the ring
     * flags come off: the end of the ring (onRingResolved), the web layer,
     * an Answer, the safety timer, onStop and sign-out all come here. Main
     * thread only.
     */
    private void removeRingingWindowFlags() {
        ringFlagsChannelId = null;
        mainHandler.removeCallbacksAndMessages(ringFlagsTimer);
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
    public void onStop() {
        super.onStop();
        // Only the window flags, as before. The unlock prompt can stop this
        // activity while an Answer waits behind it, and being stopped is not
        // the user changing their mind, so the waiting Answer stays. Giving up
        // the flags here does not end the ring either: the ring is the
        // notification, which keeps sounding on the lock screen with its
        // Answer and Decline buttons.
        removeRingingWindowFlags();
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
        // An Answer waiting for the unlock dies with this activity. Its
        // timers go with it, and a late reply from the platform finds the
        // field empty and does nothing.
        clearHeldAnswer();
        mainHandler.removeCallbacksAndMessages(null);
        if (INSTANCE != null && INSTANCE.get() == this) INSTANCE = null;
        super.onDestroy();
    }
}

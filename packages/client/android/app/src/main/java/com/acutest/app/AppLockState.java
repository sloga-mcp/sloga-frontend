package com.acutest.app;

import android.app.Dialog;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.LayerDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;

import androidx.annotation.NonNull;
import androidx.annotation.RequiresApi;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.function.Consumer;

/**
 * The app lock of this device: whether it is on, whether the app is locked
 * right now, the cover drawn over the web view, the recent-apps protection
 * and the unlock prompt. One per process. It works without AppLockPlugin,
 * which is only the web layer's window onto it.
 *
 * Whether the app is unlocked is kept in memory only and starts false, so a
 * new process is locked whenever the lock is on. Only a prompt the user
 * passed sets it. Settings that cannot be read count as "on".
 *
 * Main thread only, except get() and hideNotificationText().
 *
 * Public only for trackDialog, which the e2ee package calls. Everything
 * else stays inside this package.
 */
public final class AppLockState {
    interface Listener {
        void onLockChanged(boolean locked, boolean enabled);
    }

    /** Preferences file sloga_applock.xml. Kept out of backups. */
    static final String PREFS = "sloga_applock";

    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_TIMEOUT_SEC = "timeout_sec";
    private static final String KEY_HIDE_TEXT = "hide_text";

    private static final String CODE_NO_DEVICE_LOCK = "NO_DEVICE_LOCK";
    private static final String CODE_CANCELLED = "CANCELLED";
    private static final String CODE_LOCKED = "LOCKED";
    private static final String CODE_FAILED = "FAILED";

    private static final String TAG = "SlogaAppLock";

    /** How long the cover waits for the web lock screen before it offers its own Unlock. */
    private static final long COVER_BUTTON_DELAY_MS = 4_000L;

    /** How long a dialog that comes back at unlock takes no touches. */
    private static final long DIALOG_TOUCH_DELAY_MS = 700L;

    private static final int SECURE = 1;
    private static final int NOT_SECURE = 0;
    /** The phone could not say whether it has a screen lock. */
    private static final int SECURITY_UNKNOWN = -1;

    private static final int KIND_UNLOCK = 0;
    private static final int KIND_ENABLE = 1;
    private static final int KIND_DISABLE = 2;

    private static AppLockState instance;

    private final Context app;
    private final SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private boolean enabled;
    private int timeoutSec;
    private boolean hideText;

    /** Set only by a prompt the user passed. Never saved. */
    private boolean unlocked = false;
    /** The session ended while locked: stay locked although the lock is now off. */
    private boolean stickyLocked = false;
    /** An auto-off happened and the web layer has not been told yet. */
    private boolean autoDisabled = false;

    /** elapsedRealtime at the last onStop, or 0 when the app has not left. */
    private long leftAtMs = 0L;
    /** A screen was opened for a result and no onStop has used the stamp up yet. */
    private boolean excursionPending = false;
    private long excursionPendingAtMs = 0L;
    /** The last onStop was for such a screen. */
    private boolean excursionActive = false;
    private long excursionStartedMs = 0L;

    /** Between onStart and onStop. */
    private boolean started = false;

    /**
     * The last onStop came while a prompt of this class was open. Up to
     * Android 10 the phone's PIN screen is a separate activity, so the stop
     * and the start around it are the prompt itself and not a return to the
     * app. While this is set, the app does not open the prompt by itself.
     * Never set on Android 11 and later, where the prompt is an overlay.
     */
    private boolean stoppedUnderPrompt = false;

    private Listener listener;

    /** The live activity. Weak, and dropped in onActivityDestroyed. */
    private WeakReference<MainActivity> activityRef;

    /**
     * The request whose prompt is open, or null. It only stops a second
     * prompt from opening and never feeds the lock decision.
     */
    private Request prompt;
    /** The unlock request waiting for the phone's lock screen to go away, or null. */
    private Request dismissWait;

    /** The cover and what hangs off it. All null while the cover is down. */
    private View cover;
    private Button coverButton;
    private final Object coverTimer = new Object();
    /** Views hidden from screen readers while the cover is up, with their old setting. */
    private final ArrayList<View> a11yHidden = new ArrayList<>();
    private final ArrayList<Integer> a11yPrevious = new ArrayList<>();

    /** Dialogs of the app that must not sit on top of the lock. Held weakly. */
    private final ArrayList<TrackedDialog> dialogs = new ArrayList<>();

    private static final class TrackedDialog {
        final WeakReference<Dialog> ref;
        /** Hidden by the lock, so the lock shows it again. */
        boolean hidden;
        /** The app was locked at some point while this was hidden. */
        boolean hiddenLocked;
        /** Times the lock showed it again. Only the newest lets touches back in. */
        int reshown;

        TrackedDialog(Dialog d) {
            this.ref = new WeakReference<>(d);
        }
    }

    /** One enable, disable or unlock request. Answered exactly once. */
    private static final class Request {
        final int kind;
        final WeakReference<MainActivity> host;
        Consumer<Boolean> unlockDone;
        Consumer<String> codeDone;
        boolean finished;

        Request(int kind, MainActivity host, Consumer<Boolean> unlockDone,
                Consumer<String> codeDone) {
            this.kind = kind;
            this.host = new WeakReference<>(host);
            this.unlockDone = unlockDone;
            this.codeDone = codeDone;
        }
    }

    private AppLockState(Context app) {
        this.app = app;
        this.prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // A value that cannot be read counts as the careful one.
        try {
            enabled = prefs.getBoolean(KEY_ENABLED, false);
        } catch (RuntimeException e) {
            enabled = true;
        }
        try {
            int sec = prefs.getInt(KEY_TIMEOUT_SEC, 0);
            timeoutSec = AppLockPolicy.validTimeout(sec) ? sec : 0;
        } catch (RuntimeException e) {
            timeoutSec = 0;
        }
        try {
            hideText = prefs.getBoolean(KEY_HIDE_TEXT, false);
        } catch (RuntimeException e) {
            hideText = true;
        }
    }

    static synchronized AppLockState get(Context ctx) {
        if (instance == null) {
            Context app = ctx.getApplicationContext();
            instance = new AppLockState(app != null ? app : ctx);
        }
        return instance;
    }

    /**
     * Whether notifications must leave the message text out. Any thread.
     * Reads the saved settings only. Settings that cannot be read hide it.
     */
    static boolean hideNotificationText(Context ctx) {
        try {
            Context app = ctx.getApplicationContext();
            SharedPreferences p =
                    (app != null ? app : ctx).getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            return p.getBoolean(KEY_ENABLED, false) && p.getBoolean(KEY_HIDE_TEXT, false);
        } catch (RuntimeException e) {
            return true;
        }
    }

    /**
     * Main thread. Call right after d.show(). The dialog is hidden while the
     * app lock covers the app and shown again when it no longer does. Holds
     * the dialog weakly. No-op for null.
     */
    public static void trackDialog(Dialog d) {
        if (d == null) return;
        // Never throws to the caller: the dialog is then simply not tracked.
        try {
            final AppLockState state = get(d.getContext());
            if (Looper.myLooper() == Looper.getMainLooper()) {
                state.track(d);
            } else {
                state.handler.post(() -> {
                    try {
                        state.track(d);
                    } catch (RuntimeException e) {
                        Log.w(TAG, "a dialog could not be tracked");
                    }
                });
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "a dialog could not be tracked");
        }
    }

    boolean isEnabled() {
        return enabled;
    }

    boolean isLocked() {
        return (enabled || stickyLocked) && !unlocked;
    }

    int timeoutSec() {
        return timeoutSec;
    }

    boolean hideText() {
        return hideText;
    }

    /**
     * False only when the phone says for certain that it has no screen lock.
     * A phone that cannot answer counts as having one, so the lock is never
     * turned off on a failed query.
     */
    boolean isDeviceSecure() {
        return deviceSecurity() != NOT_SECURE;
    }

    /** True once after the lock turned itself off. */
    boolean consumeAutoDisabled() {
        boolean was = autoDisabled;
        autoDisabled = false;
        return was;
    }

    void setListener(Listener l) {
        listener = l;
    }

    // Activity lifecycle, called by MainActivity.

    /** After super.onCreate. A locked app is covered before the web view draws. */
    void onActivityCreated(MainActivity a) {
        // Whatever belonged to an earlier activity goes first.
        failRequestsNotOf(a);
        detachCover();
        activityRef = new WeakReference<>(a);
        started = false;

        boolean turnedOff = autoOffIfNoDeviceLock();
        applyRecentsPrivacy(a);
        if (isLocked()) showCover(a);
        syncDialogs();
        if (turnedOff) notifyListener();
    }

    /** The window flags do not always stick before the window is attached. */
    void onWindowAttached(MainActivity a) {
        applyRecentsPrivacy(a);
    }

    void onActivityStarted(MainActivity a, long nowMs) {
        if (liveActivity() != a) activityRef = new WeakReference<>(a);
        started = true;

        boolean changed = autoOffIfNoDeviceLock();
        if (changed) applyRecentsPrivacy(a);

        if (enabled && unlocked
                && AppLockPolicy.shouldLock(
                        true, false, leftAtMs, nowMs, timeoutSec,
                        excursionActive, excursionStartedMs)) {
            unlocked = false;
            changed = true;
        }
        leftAtMs = 0L;
        excursionActive = false;
        excursionStartedMs = 0L;

        boolean covered = false;
        if (!isLocked()) {
            detachCover();
        } else {
            // The cover is normally up since onStop or onCreate.
            if (enabled && !coverIsOn(a)) showCover(a);
            if (coverIsOn(a)) {
                startCoverTimer();
                covered = true;
            }
        }
        // Hidden while locked, back when the start ends unlocked.
        syncDialogs();
        // Locked under the cover: the web layer is told every time, so it
        // can draw its lock screen again and report it with gateShown.
        if (changed || covered) notifyListener();
    }

    /**
     * A new page is loading in the web view. A lock that was only kept
     * because the session ended while locked ends with the old page.
     */
    void onPageStarted() {
        stickyLocked = false;
        // Off screen the cover stays; onActivityStarted takes it down.
        if (started && !isLocked()) detachCover();
        syncDialogs();
        notifyListener();
    }

    /** Back in front without having been stopped: the stamp was not needed. */
    void onActivityResumed() {
        excursionPending = false;
        excursionPendingAtMs = 0L;
    }

    void onActivityStopped(long nowMs) {
        started = false;
        // Zero means "never left", so a real stop is never stored as zero.
        leftAtMs = nowMs > 0L ? nowMs : 1L;
        excursionActive = excursionPending;
        excursionStartedMs = excursionPending ? excursionPendingAtMs : 0L;
        excursionPending = false;
        excursionPendingAtMs = 0L;
        // A stop with no prompt of ours open is the user leaving, and clears
        // this. Android 11 and later never stop the activity for the prompt.
        stoppedUnderPrompt =
                Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q && prompt != null;
        // Up while the app is off screen, whether or not it is locked. With
        // started false, a gateShown from before this stop no longer counts.
        if (enabled) showCover(liveActivity());
        syncDialogs();
    }

    void onActivityDestroyed(MainActivity a) {
        failRequestsOf(a);
        if (cover != null && cover.getContext() == a) detachCover();
        if (liveActivity() == a) {
            activityRef = null;
            started = false;
        }
    }

    /** A screen was opened for a result. The next onStop is exempt, once. */
    void noteForResultLaunch(long nowMs) {
        excursionPending = true;
        excursionPendingAtMs = nowMs;
    }

    // Prompts.

    /**
     * Ask for the unlock. auto is the prompt the app opens by itself, which
     * never shows while the phone's own lock screen is up.
     */
    void authenticate(MainActivity a, boolean auto, Consumer<Boolean> done) {
        if (!isLocked()) {
            reply(done, true);
            return;
        }
        if (!usable(a)) {
            reply(done, false);
            return;
        }
        if (auto && stoppedUnderPrompt) {
            // This return to the app is the PIN screen closing. Opening the
            // prompt again would bring it straight back on every cancel, so
            // the user is left on the lock screen and unlocks from there.
            reply(done, false);
            return;
        }
        if (prompt != null) {
            // An open prompt takes the window focus. With the focus still
            // here, the prompt went away without an answer: that request
            // is failed, and any late answer to it is ignored.
            if (auto || !a.hasWindowFocus()) {
                reply(done, false);
                return;
            }
            finish(prompt, CODE_FAILED);
        }
        if (!keyguardLockedOrUnknown()) {
            startPrompt(a, new Request(KIND_UNLOCK, a, done, null));
            return;
        }
        if (auto) {
            reply(done, false);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // The newest tap is the one that counts.
            if (dismissWait != null) finish(dismissWait, CODE_FAILED);
            final Request r = new Request(KIND_UNLOCK, a, done, null);
            dismissWait = r;
            if (!Api26Keyguard.requestDismiss(a, ok -> onKeyguardDismissResult(r, ok))) {
                finish(r, CODE_FAILED);
            }
        } else {
            reply(done, false);
        }
    }

    /** Turn the lock on. done gets null on success, otherwise an error code. */
    void enable(MainActivity a, Consumer<String> done) {
        Request r = new Request(KIND_ENABLE, a, null, done);
        if (deviceSecurity() == NOT_SECURE) {
            finish(r, CODE_NO_DEVICE_LOCK);
            return;
        }
        if (!usable(a) || keyguardLockedOrUnknown()) {
            finish(r, CODE_FAILED);
            return;
        }
        // A phone that could not say whether it has a screen lock gets the
        // prompt anyway, and the prompt decides.
        startPrompt(a, r);
    }

    /** Turn the lock off. Refused while locked. */
    void disable(MainActivity a, Consumer<String> done) {
        Request r = new Request(KIND_DISABLE, a, null, done);
        if (isLocked()) {
            finish(r, CODE_LOCKED);
            return;
        }
        if (!usable(a) || keyguardLockedOrUnknown()) {
            finish(r, CODE_FAILED);
            return;
        }
        startPrompt(a, r);
    }

    /** False while locked, for a timing that is not offered, or when it could not be saved. */
    boolean setTimeoutSec(int sec) {
        if (isLocked() || !AppLockPolicy.validTimeout(sec)) return false;
        try {
            if (!prefs.edit().putInt(KEY_TIMEOUT_SEC, sec).commit()) return false;
        } catch (RuntimeException e) {
            return false;
        }
        timeoutSec = sec;
        return true;
    }

    /** False while locked, or when it could not be saved. */
    boolean setHideNotificationText(boolean hide) {
        if (isLocked()) return false;
        if (!saveBoolean(KEY_HIDE_TEXT, hide)) return false;
        hideText = hide;
        return true;
    }

    /**
     * The web lock screen is drawn, so the cover can go. Changes nothing
     * else. Ignored while the app is off screen.
     */
    void gateShown() {
        if (isLocked() && started) detachCover();
    }

    /**
     * The session ended. The lock setting is cleared, but an app that was
     * locked stays locked until a prompt is passed or the process ends.
     */
    void reset() {
        // A waiting enable or disable is answered now, so its prompt can no
        // longer change anything. An unlock prompt is left alone.
        Request waiting = prompt;
        if (waiting != null && waiting.kind != KIND_UNLOCK) finish(waiting, CODE_FAILED);
        if (isLocked()) stickyLocked = true;
        try {
            if (!prefs.edit()
                    .putBoolean(KEY_ENABLED, false)
                    .putBoolean(KEY_HIDE_TEXT, false)
                    .putInt(KEY_TIMEOUT_SEC, 0)
                    .commit()) {
                Log.w(TAG, "the cleared settings could not be saved");
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "the cleared settings could not be saved");
        }
        enabled = false;
        hideText = false;
        timeoutSec = 0;
        applyRecentsPrivacy(liveActivity());
        // Still locked keeps them hidden. Not locked, the lock is now off.
        syncDialogs();
        notifyListener();
    }

    // Prompt plumbing.

    private void onKeyguardDismissResult(Request r, boolean ok) {
        if (r.finished || dismissWait != r) return;
        dismissWait = null;
        if (!ok) {
            finish(r, CODE_FAILED);
            return;
        }
        if (!isLocked()) {
            finish(r, null);
            return;
        }
        startPrompt(r.host.get(), r);
    }

    /** Open the system prompt for one request. Any failure to open answers FAILED. */
    private void startPrompt(MainActivity a, final Request r) {
        if (prompt != null || !canPrompt(a)) {
            finish(r, CODE_FAILED);
            return;
        }
        prompt = r;
        try {
            // No negative button: it is not allowed together with the
            // phone's PIN, pattern or password.
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(promptTitle(r.kind))
                    .setAllowedAuthenticators(
                            BiometricManager.Authenticators.BIOMETRIC_WEAK
                                    | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                    .build();
            BiometricPrompt.AuthenticationCallback callback =
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(
                                @NonNull BiometricPrompt.AuthenticationResult result) {
                            onPromptSucceeded(r);
                        }

                        @Override
                        public void onAuthenticationError(
                                int errorCode, @NonNull CharSequence errString) {
                            onPromptError(r, errorCode);
                        }
                        // onAuthenticationFailed is one rejected try. The
                        // prompt stays open, so there is nothing to do.
                    };
            // Replies arrive on the main thread.
            new BiometricPrompt(a, ContextCompat.getMainExecutor(a), callback).authenticate(info);
        } catch (RuntimeException e) {
            finish(r, CODE_FAILED);
        }
    }

    private static String promptTitle(int kind) {
        switch (kind) {
            case KIND_ENABLE:
                return "Turn on app lock";
            case KIND_DISABLE:
                return "Turn off app lock";
            default:
                return "Unlock Sloga";
        }
    }

    private void onPromptSucceeded(Request r) {
        // A reply for a request that was already answered changes nothing.
        if (r.finished) return;
        MainActivity a = liveActivity();
        switch (r.kind) {
            case KIND_ENABLE:
                if (!saveBoolean(KEY_ENABLED, true)) {
                    finish(r, CODE_FAILED);
                    return;
                }
                enabled = true;
                unlocked = true;
                stickyLocked = false;
                applyRecentsPrivacy(a);
                break;
            case KIND_DISABLE:
                // Not saved means the next start is still locked, which is
                // the careful side.
                if (!saveBoolean(KEY_ENABLED, false)) {
                    Log.w(TAG, "turning the lock off could not be saved");
                }
                enabled = false;
                applyRecentsPrivacy(a);
                break;
            default:
                unlocked = true;
                stickyLocked = false;
                break;
        }
        // The user passed a prompt, so the next return to the app is a new one.
        stoppedUnderPrompt = false;
        // Off screen the cover stays; onActivityStarted takes it down.
        if (started && !isLocked()) detachCover();
        // Only the unlock prompt brings back a dialog hidden while locked.
        syncDialogs(r.kind == KIND_UNLOCK);
        notifyListener();
        finish(r, null);
    }

    private void onPromptError(Request r, int errorCode) {
        if (r.finished) return;
        String code;
        switch (errorCode) {
            case BiometricPrompt.ERROR_USER_CANCELED:
            case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
            case BiometricPrompt.ERROR_CANCELED:
                code = CODE_CANCELLED;
                break;
            case BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL:
                code = CODE_NO_DEVICE_LOCK;
                break;
            default:
                code = CODE_FAILED;
                break;
        }
        if (errorCode == BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL) {
            // The screen lock may have been removed while the app was open.
            // The phone is asked again, and only its own answer turns the
            // lock off.
            if (autoOffIfNoDeviceLock()) {
                applyRecentsPrivacy(liveActivity());
                if (started && !isLocked()) detachCover();
                syncDialogs();
                notifyListener();
            }
        }
        finish(r, code);
    }

    /** Answer a request, once. A null code is success. */
    private void finish(Request r, String code) {
        if (r.finished) return;
        r.finished = true;
        if (prompt == r) prompt = null;
        if (dismissWait == r) dismissWait = null;
        Consumer<Boolean> unlockDone = r.unlockDone;
        Consumer<String> codeDone = r.codeDone;
        r.unlockDone = null;
        r.codeDone = null;
        try {
            if (unlockDone != null) unlockDone.accept(code == null);
            if (codeDone != null) codeDone.accept(code);
        } catch (RuntimeException e) {
            Log.w(TAG, "a prompt answer could not be delivered");
        }
    }

    private static void reply(Consumer<Boolean> done, boolean value) {
        if (done == null) return;
        try {
            done.accept(value);
        } catch (RuntimeException e) {
            Log.w(TAG, "a prompt answer could not be delivered");
        }
    }

    /** Requests of this activity, or of one that is already gone. */
    private void failRequestsOf(MainActivity a) {
        Request p = prompt;
        if (p != null) {
            MainActivity host = p.host.get();
            if (host == null || host == a) finish(p, CODE_FAILED);
        }
        Request d = dismissWait;
        if (d != null) {
            MainActivity host = d.host.get();
            if (host == null || host == a) finish(d, CODE_FAILED);
        }
    }

    /** Requests left over from any activity other than this one. */
    private void failRequestsNotOf(MainActivity a) {
        Request p = prompt;
        if (p != null && p.host.get() != a) finish(p, CODE_FAILED);
        Request d = dismissWait;
        if (d != null && d.host.get() != a) finish(d, CODE_FAILED);
    }

    private static boolean usable(MainActivity a) {
        return a != null && !a.isFinishing() && !a.isDestroyed();
    }

    /**
     * Whether a prompt can open on this activity now. The prompt library
     * drops a request made after the state was saved without any reply, so
     * that case is refused here.
     */
    private boolean canPrompt(MainActivity a) {
        if (!usable(a) || !started || liveActivity() != a) return false;
        try {
            return !a.getSupportFragmentManager().isStateSaved();
        } catch (RuntimeException e) {
            return false;
        }
    }

    // Phone state.

    private int deviceSecurity() {
        try {
            KeyguardManager keyguard =
                    (KeyguardManager) app.getSystemService(Context.KEYGUARD_SERVICE);
            if (keyguard == null) return SECURITY_UNKNOWN;
            return keyguard.isDeviceSecure() ? SECURE : NOT_SECURE;
        } catch (RuntimeException e) {
            return SECURITY_UNKNOWN;
        }
    }

    /** Whether the phone's lock screen is up. No answer reads as locked. */
    private boolean keyguardLockedOrUnknown() {
        try {
            KeyguardManager keyguard =
                    (KeyguardManager) app.getSystemService(Context.KEYGUARD_SERVICE);
            return keyguard == null || keyguard.isKeyguardLocked();
        } catch (RuntimeException e) {
            return true;
        }
    }

    /**
     * Turn the lock off when the phone says for certain that it has no
     * screen lock. Returns whether it did. The caller redraws and notifies.
     */
    private boolean autoOffIfNoDeviceLock() {
        if (!enabled) return false;
        if (deviceSecurity() != NOT_SECURE) return false;
        if (!saveBoolean(KEY_ENABLED, false)) {
            Log.w(TAG, "the auto-off could not be saved");
        }
        enabled = false;
        autoDisabled = true;
        return true;
    }

    private boolean saveBoolean(String key, boolean value) {
        try {
            return prefs.edit().putBoolean(key, value).commit();
        } catch (RuntimeException e) {
            return false;
        }
    }

    private MainActivity liveActivity() {
        WeakReference<MainActivity> ref = activityRef;
        return ref == null ? null : ref.get();
    }

    private void notifyListener() {
        Listener l = listener;
        if (l == null) return;
        try {
            l.onLockChanged(isLocked(), enabled);
        } catch (RuntimeException e) {
            Log.w(TAG, "the lock listener failed");
        }
    }

    // Recent-apps protection.

    /**
     * While the lock is on: no recent-apps picture on Android 13 and later,
     * FLAG_SECURE below. Off again when the lock is off.
     */
    private void applyRecentsPrivacy(MainActivity a) {
        if (!usable(a)) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                Api33Recents.setScreenshotEnabled(a, !enabled);
            } else {
                Window window = a.getWindow();
                if (window == null) return;
                if (enabled) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                }
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "the recent-apps protection could not be set");
        }
    }

    /** Kept in its own class so the API 33 call is never resolved on an older phone. */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private static final class Api33Recents {
        private Api33Recents() {}

        static void setScreenshotEnabled(MainActivity a, boolean enabled) {
            a.setRecentsScreenshotEnabled(enabled);
        }
    }

    /** The Android 8+ request to dismiss the phone's lock screen. */
    @RequiresApi(Build.VERSION_CODES.O)
    private static final class Api26Keyguard {
        private Api26Keyguard() {}

        /** Returns false when the request could not be made at all. */
        static boolean requestDismiss(MainActivity a, final Consumer<Boolean> reply) {
            try {
                KeyguardManager keyguard =
                        (KeyguardManager) a.getSystemService(Context.KEYGUARD_SERVICE);
                if (keyguard == null) return false;
                final Handler main = new Handler(Looper.getMainLooper());
                keyguard.requestDismissKeyguard(
                        a,
                        new KeyguardManager.KeyguardDismissCallback() {
                            @Override
                            public void onDismissSucceeded() {
                                post(true);
                            }

                            @Override
                            public void onDismissCancelled() {
                                post(false);
                            }

                            @Override
                            public void onDismissError() {
                                post(false);
                            }

                            private void post(final boolean ok) {
                                main.post(() -> reply.accept(ok));
                            }
                        });
                return true;
            } catch (RuntimeException e) {
                return false;
            }
        }
    }

    // The cover.

    private boolean coverIsOn(MainActivity a) {
        return cover != null && cover.getContext() == a && cover.getParent() != null;
    }

    /** Put the cover over the web view, with its Unlock button hidden. */
    private void showCover(MainActivity a) {
        if (!usable(a)) return;
        if (coverIsOn(a)) {
            handler.removeCallbacksAndMessages(coverTimer);
            if (coverButton != null) coverButton.setVisibility(View.INVISIBLE);
            cover.bringToFront();
            return;
        }
        detachCover();
        try {
            View found = a.findViewById(android.R.id.content);
            if (!(found instanceof ViewGroup)) {
                Log.w(TAG, "no content view to cover");
                return;
            }
            ViewGroup content = (ViewGroup) found;

            FrameLayout root = new FrameLayout(a);
            root.setBackground(coverBackground(a));
            // Takes every touch, scroll and key so none reaches the web view.
            root.setClickable(true);
            root.setSoundEffectsEnabled(false);
            root.setFocusable(true);
            root.setFocusableInTouchMode(true);
            root.setOnGenericMotionListener((v, e) -> true);
            root.setOnHoverListener((v, e) -> true);
            root.setContentDescription("Sloga is locked");

            LinearLayout column = new LinearLayout(a);
            column.setOrientation(LinearLayout.VERTICAL);
            column.setGravity(Gravity.CENTER_HORIZONTAL);

            ImageView icon = new ImageView(a);
            try {
                icon.setImageDrawable(
                        a.getPackageManager().getApplicationIcon(a.getApplicationInfo()));
            } catch (RuntimeException e) {
                // No icon then. The cover still covers.
            }
            int iconSize = dp(a, 96);
            column.addView(icon, new LinearLayout.LayoutParams(iconSize, iconSize));

            // In the middle of the screen, clear of the system bars.
            Button button = new Button(a);
            button.setText("Unlock");
            button.setAllCaps(false);
            button.setVisibility(View.INVISIBLE);
            button.setOnClickListener(v -> authenticate(liveActivity(), false, null));
            LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            buttonParams.topMargin = dp(a, 24);
            column.addView(button, buttonParams);

            root.addView(column, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER));

            // A screen reader must not read the chat under the cover.
            for (int i = 0; i < content.getChildCount(); i++) {
                View child = content.getChildAt(i);
                a11yHidden.add(child);
                a11yPrevious.add(child.getImportantForAccessibility());
                child.setImportantForAccessibility(
                        View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            }

            content.addView(root, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.bringToFront();
            root.requestFocus();
            cover = root;
            coverButton = button;
        } catch (RuntimeException e) {
            Log.w(TAG, "the cover could not be shown");
            detachCover();
        }
    }

    /** Take the cover down and let go of every view of its activity. */
    private void detachCover() {
        handler.removeCallbacksAndMessages(coverTimer);
        for (int i = 0; i < a11yHidden.size(); i++) {
            try {
                a11yHidden.get(i).setImportantForAccessibility(a11yPrevious.get(i));
            } catch (RuntimeException e) {
                // The view is gone with its activity.
            }
        }
        a11yHidden.clear();
        a11yPrevious.clear();
        View c = cover;
        cover = null;
        coverButton = null;
        if (c == null) return;
        try {
            ViewParent parent = c.getParent();
            if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(c);
        } catch (RuntimeException e) {
            Log.w(TAG, "the cover could not be removed");
        }
    }

    /**
     * Still locked and still covered after the delay: the web lock screen did
     * not report in, so the cover offers the unlock itself.
     */
    private void startCoverTimer() {
        handler.removeCallbacksAndMessages(coverTimer);
        handler.postAtTime(
                () -> {
                    if (cover != null && coverButton != null && isLocked()) {
                        coverButton.setVisibility(View.VISIBLE);
                    }
                },
                coverTimer,
                SystemClock.uptimeMillis() + COVER_BUTTON_DELAY_MS);
    }

    // Dialogs. A dialog is its own window above the activity, so neither the
    // cover nor the web lock screen is in front of it.

    private void track(Dialog d) {
        boolean known = false;
        for (int i = 0; i < dialogs.size(); i++) {
            if (dialogs.get(i).ref.get() == d) {
                known = true;
                break;
            }
        }
        if (!known) dialogs.add(new TrackedDialog(d));
        syncDialogs();
    }

    /**
     * Whether tracked dialogs must be out of sight: while locked, and while
     * the app is off screen with the lock on. Always false with the lock off.
     * Lifting the cover for the web lock screen does not change it.
     */
    private boolean dialogsMustHide() {
        return isLocked() || (enabled && !started);
    }

    /** Every change except a passed unlock prompt. */
    private void syncDialogs() {
        syncDialogs(false);
    }

    /**
     * Hide or bring back the tracked dialogs to match the lock, and forget
     * the ones that are gone. Only a dialog the lock hid is shown again, and
     * one that was closed while hidden is not brought back.
     *
     * A dialog that was hidden while the app was locked comes back only after
     * a passed unlock prompt, which is what passedUnlock says. When the lock
     * ends any other way, such as a sign out from the lock screen, it is
     * closed instead: nobody proved they may see it.
     */
    private void syncDialogs(boolean passedUnlock) {
        boolean hide = dialogsMustHide();
        boolean locked = isLocked();
        // A copy, because closing a dialog runs its owner's listeners, and
        // those may track another dialog.
        TrackedDialog[] all = dialogs.toArray(new TrackedDialog[0]);
        for (TrackedDialog t : all) {
            Dialog d = t.ref.get();
            if (d == null) {
                dialogs.remove(t);
                continue;
            }
            try {
                View decor = dialogDecor(d);
                // isShowing is false for a hidden dialog on some Android
                // versions, so a dialog whose window is still attached also
                // counts as open.
                boolean open = d.isShowing() || (decor != null && decor.getParent() != null);
                if (!open) {
                    dialogs.remove(t);
                    continue;
                }
                // The unlock was passed, also when the app is still off
                // screen and the dialog stays hidden until the next start.
                if (passedUnlock && !locked) t.hiddenLocked = false;
                boolean visible =
                        decor != null ? decor.getVisibility() == View.VISIBLE : !t.hidden;
                if (hide) {
                    if (visible) {
                        d.hide();
                        t.hidden = true;
                    }
                    // Also a dialog hidden earlier, when the app locks later.
                    if (t.hidden && locked) t.hiddenLocked = true;
                } else if (t.hidden) {
                    if (t.hiddenLocked) {
                        // The lock ended without an unlock. dismiss, so the
                        // owner's listener lets go of what waits on it.
                        dialogs.remove(t);
                        d.dismiss();
                        continue;
                    }
                    t.hidden = false;
                    // Armed before show, so a failed show still gets its
                    // touches back.
                    blockTouchesBriefly(t, d);
                    d.show();
                }
            } catch (RuntimeException e) {
                // The window went away with its activity. A dialog that had
                // to stay out of sight is closed rather than left as it is.
                dialogs.remove(t);
                if (hide || t.hiddenLocked) {
                    try {
                        d.dismiss();
                    } catch (RuntimeException e2) {
                        // Nothing left to close.
                    }
                }
            }
        }
    }

    /**
     * A dialog that comes back at unlock takes no touches for a moment, so
     * the tap that unlocked the app cannot land on one of its buttons. Each
     * time it comes back the wait starts again, and the newest wait always
     * ends with touches allowed.
     */
    private void blockTouchesBriefly(final TrackedDialog t, Dialog d) {
        Window window = d.getWindow();
        if (window == null) return;
        final int turn = ++t.reshown;
        // Posted first: once the flag is set, the clear is already on its way.
        handler.postDelayed(
                () -> {
                    // A later return of the dialog has its own wait.
                    if (t.reshown != turn) return;
                    Dialog later = t.ref.get();
                    if (later == null) return;
                    try {
                        Window w = later.getWindow();
                        if (w != null) {
                            w.clearFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
                        }
                    } catch (RuntimeException e) {
                        // The window went away with its activity.
                    }
                },
                DIALOG_TOUCH_DELAY_MS);
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
    }

    private static View dialogDecor(Dialog d) {
        Window window = d.getWindow();
        return window == null ? null : window.peekDecorView();
    }

    /** The theme's window background over black, so the cover is opaque whatever the theme. */
    private static Drawable coverBackground(MainActivity a) {
        ColorDrawable black = new ColorDrawable(Color.BLACK);
        try {
            TypedValue value = new TypedValue();
            if (a.getTheme().resolveAttribute(android.R.attr.windowBackground, value, true)) {
                if (value.type >= TypedValue.TYPE_FIRST_COLOR_INT
                        && value.type <= TypedValue.TYPE_LAST_COLOR_INT) {
                    return new ColorDrawable(value.data | 0xFF000000);
                }
                if (value.resourceId != 0) {
                    Drawable themed = ContextCompat.getDrawable(a, value.resourceId);
                    if (themed != null) return new LayerDrawable(new Drawable[] {black, themed});
                }
            }
        } catch (RuntimeException e) {
            // Black then.
        }
        return black;
    }

    private static int dp(Context ctx, int dp) {
        return Math.round(dp * ctx.getResources().getDisplayMetrics().density);
    }
}

package com.acutest.app;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import androidx.annotation.RequiresApi;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * JS bridge for native push: request notification permission and fetch a
 * device push token from the per-flavor PushTokenSource so the web layer can
 * subscribe with the backend. On play and sideload that is the FCM
 * registration token. foss has no FCM token and getToken rejects with
 * PUSH_UNAVAILABLE; its background push comes from UnifiedPush through
 * its own plugin instead.
 *
 * It is also the web layer's way to the native side of a ringing call: the
 * action of a tapped notification, the end of a ring, the lock state of the
 * phone, the push preferences and the list of people who can call.
 */
@CapacitorPlugin(
        name = "PushToken",
        permissions = @Permission(
                strings = { "android.permission.POST_NOTIFICATIONS" },
                alias = "notifications"))
public class PushTokenPlugin extends Plugin {
    /** How long ensureUnlocked waits for the phone to be unlocked before it answers false. */
    private static final long UNLOCK_WAIT_MS = 60_000L;

    /**
     * How long a parked Answer or ring stays usable. After that the action
     * only opens the chat.
     */
    static final long PARKED_ACTION_MAX_AGE_MS = 60_000L;

    private static String pendingPath;
    private static boolean pendingAnswer;
    private static boolean pendingRing;
    private static String pendingCallerId;
    private static String pendingCallId;
    private static boolean pendingVideo;
    private static boolean pendingLocked;
    /** SystemClock.elapsedRealtime() when the action was parked. */
    private static long pendingParkedAtMs;
    /**
     * SystemClock.elapsedRealtime() of the Answer tap that led to the action,
     * or 0 when it did not come from one. The age limit counts from here.
     */
    private static long pendingTappedAtMs;

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

    /**
     * One worker for the contact list. Its writes stay off the main thread and
     * off the thread every plugin call shares, and a new list and the sign-out
     * clear that follows it are applied in the order they were asked for. The
     * worker thread ends after 30 seconds without work.
     */
    private static final ThreadPoolExecutor CONTACTS_IO = contactsExecutor();

    /** The ensureUnlocked calls still waiting for an answer. Guarded by its own lock. */
    private final HashSet<UnlockWait> unlockWaits = new HashSet<>();

    /** Set once the plugin is destroyed. Written under the unlockWaits lock. */
    private boolean destroyed = false;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private static ThreadPoolExecutor contactsExecutor() {
        ThreadPoolExecutor executor = new ThreadPoolExecutor(
                1, 1, 30L, TimeUnit.SECONDS, new LinkedBlockingQueue<Runnable>());
        executor.allowCoreThreadTimeOut(true);
        return executor;
    }

    static boolean isInAppCallUiActive() {
        return inAppCallUiActive;
    }

    /** Web layer reporting whether it can currently show the ringing popup. */
    @PluginMethod
    public void setInAppCallUiActive(PluginCall call) {
        inAppCallUiActive = Boolean.TRUE.equals(call.getBoolean("active", Boolean.FALSE));
        call.resolve();
    }

    /**
     * Park the action of a tapped notification until the web layer asks for
     * it. The activity parks on the main thread and consumeLaunchAction reads
     * on the plugin thread, so both hold the class lock. The seven fields are
     * always written and read as one action, and an answer can never be paired
     * with the chat of another action.
     *
     * The time of parking is kept with it. The web layer may not ask until
     * much later, after a reload for instance, and by then the call the
     * action was about is over.
     */
    static void setPendingAction(
            String path,
            boolean answer,
            boolean ring,
            String callerId,
            String callId,
            boolean video,
            boolean locked) {
        setPendingAction(path, answer, ring, callerId, callId, video, locked, 0L);
    }

    /**
     * The same, for an Answer: tappedAtMs is SystemClock.elapsedRealtime()
     * at the tap. The age limit then counts from the tap, so an Answer that
     * waited for the unlock has that much less time left in the slot.
     */
    static synchronized void setPendingAction(
            String path,
            boolean answer,
            boolean ring,
            String callerId,
            String callId,
            boolean video,
            boolean locked,
            long tappedAtMs) {
        pendingPath = path;
        pendingAnswer = answer;
        pendingRing = ring;
        pendingCallerId = callerId;
        pendingCallId = callId;
        pendingVideo = video;
        pendingLocked = locked;
        pendingParkedAtMs = SystemClock.elapsedRealtime();
        pendingTappedAtMs = tappedAtMs;
    }

    /** Empty the slot. For sign-out. */
    static synchronized void clearPendingAction() {
        pendingParkedAtMs = 0L;
        pendingTappedAtMs = 0L;
        pendingPath = null;
        pendingAnswer = false;
        pendingRing = false;
        pendingCallerId = null;
        pendingCallId = null;
        pendingVideo = false;
        pendingLocked = false;
    }

    /**
     * Whether a parked action is still young enough to answer a call or show
     * a ring: parked no more than PARKED_ACTION_MAX_AGE_MS ago. A parking
     * time later than now cannot be right, so it counts as too old. For an
     * Answer, consumeLaunchAction passes the time of the tap, not of the
     * parking (CallRingPolicy.actionAgeFrom).
     */
    static boolean parkedActionFresh(long parkedAtMs, long nowMs) {
        if (parkedAtMs > nowMs) return false;
        long age = nowMs - parkedAtMs;
        // A difference too large for a long wraps around to a negative number.
        return age >= 0L && age <= PARKED_ACTION_MAX_AGE_MS;
    }

    /**
     * Returns and clears the navigation requested by a tapped notification.
     *
     * An action that has waited too long keeps only its chat: the path and
     * the caller are returned, and everything about the call reads as if
     * there were none. A late read can open the chat, and can never answer a
     * call or show a ring. The slot is emptied either way.
     *
     * An Answer that waited too long is a call the user tried to take and
     * did not get: the ring was already closed as answered when it was
     * parked, so nothing else would tell them. It is reported as a missed
     * call, which also ends whatever is left of that ring on this phone.
     */
    @PluginMethod
    public void consumeLaunchAction(PluginCall call) {
        JSObject result = new JSObject();
        String staleAnswerChannelId = null;
        synchronized (PushTokenPlugin.class) {
            // The clock is read inside the lock, so an action parked a moment
            // ago can never look as if it were parked in the future. An
            // Answer's age counts from its tap.
            boolean fresh = parkedActionFresh(
                    CallRingPolicy.actionAgeFrom(pendingTappedAtMs, pendingParkedAtMs),
                    SystemClock.elapsedRealtime());
            if (pendingAnswer && !fresh) {
                staleAnswerChannelId = CallRingPolicy.channelIdFromPath(pendingPath);
            }
            result.put("path", pendingPath);
            result.put("answer", fresh && pendingAnswer);
            result.put("ring", fresh && pendingRing);
            result.put("callerId", pendingCallerId);
            // An unknown call id is sent as an explicit null. A null String
            // would drop the key from the result instead.
            Object callId = fresh && pendingCallId != null ? pendingCallId : JSONObject.NULL;
            result.put("callId", callId);
            result.put("video", fresh && pendingVideo);
            result.put("locked", fresh && pendingLocked);
            pendingParkedAtMs = 0L;
            pendingTappedAtMs = 0L;
            pendingPath = null;
            pendingAnswer = false;
            pendingRing = false;
            pendingCallerId = null;
            pendingCallId = null;
            pendingVideo = false;
            pendingLocked = false;
        }
        call.resolve(result);
        if (staleAnswerChannelId != null) {
            // "timeout" with the web layer's ring counted: a missed call is
            // posted for the chat, and the activity drops what it still
            // holds for that ring. Never throws.
            SlogaNotifier.resolveCall(getContext(), staleAnswerChannelId, "timeout", true);
        }
    }

    /**
     * The ring for a chat is over in the web layer. Called when the in-app
     * incoming-call popup is resolved (accepted, declined or timed out) so
     * the native ringtone stops instead of ringing on into the call. The
     * notifier cancels the ring notification and decides from the reason
     * whether the call was missed.
     */
    @PluginMethod
    public void dismissCallNotification(PluginCall call) {
        String channelId = call.getString("channelId");
        String reason = call.getString("reason");
        // The notifier treats no reason at all as a missed call. A dismiss
        // that gives none says nothing about why the ring ended, so it is
        // passed on under a name the ring rules do not know and never counts
        // as missed.
        if (reason == null || reason.isEmpty()) reason = "dismissed";
        if (channelId != null) {
            SlogaNotifier.resolveCall(getContext(), channelId, reason, true);
        }
        // The ring is over, so give up the lockscreen bypass the full-screen
        // intent asked for. The app must not stay readable over the keyguard.
        clearRingingWindowFlags();
        call.resolve();
    }

    /**
     * Whether the phone is locked right now. The web layer asks at the moment
     * Answer is pressed. When the lock state cannot be read the answer is
     * locked, so an unreadable state can never pass for an unlocked phone.
     */
    @PluginMethod
    public void isLocked(PluginCall call) {
        JSObject result = new JSObject();
        result.put("locked", keyguardLocked());
        call.resolve(result);
    }

    /**
     * Have the user unlock the phone, and say whether they did. An unlocked
     * phone answers true at once. Otherwise Android 8 and later show the
     * system's own unlock screen, and Android 7 waits for the user to unlock.
     *
     * The call is answered exactly once on every path. A wait ends with the
     * first of: the system's answer, the 60 second limit, or the plugin being
     * destroyed. Everything except a confirmed unlock answers false.
     */
    @PluginMethod
    public void ensureUnlocked(PluginCall call) {
        final UnlockWait wait = new UnlockWait(call);
        try {
            final KeyguardManager keyguard = keyguard();
            if (keyguard == null) {
                wait.finish(false, false);
                return;
            }
            if (!keyguard.isKeyguardLocked()) {
                wait.finish(true, false);
                return;
            }
            final Activity activity = getActivity();
            if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
                wait.finish(false, false);
                return;
            }
            if (!wait.begin()) {
                wait.finish(false, false);
                return;
            }
            activity.runOnUiThread(() -> wait.start(keyguard, activity));
        } catch (Exception e) {
            wait.finish(false, false);
        }
    }

    /**
     * Store the two push preferences so a re-subscribe made while the web
     * layer is not running sends the same choices. A key missing from the
     * call is stored as false. Signing out wipes them with the rest of this
     * file, so the web layer sends them again after every subscribe.
     */
    @PluginMethod
    public void setPushPrefs(PluginCall call) {
        boolean chatsOnly = Boolean.TRUE.equals(call.getBoolean("chatsOnly", Boolean.FALSE));
        boolean noRing = Boolean.TRUE.equals(call.getBoolean("noRing", Boolean.FALSE));
        getContext().getSharedPreferences("sloga_push", Context.MODE_PRIVATE)
                .edit()
                .putBoolean("pref_chats_only", chatsOnly)
                .putBoolean("pref_no_ring", noRing)
                .apply();
        call.resolve();
    }

    /**
     * Replace the names and photos the ring notification can show. The call
     * resolves once the list is stored.
     *
     * Storing replaces the whole list, so both lists have to be arrays. A
     * call with a missing or mistyped list resolves without storing, and the
     * names already on the phone stay as they are.
     */
    @PluginMethod
    public void setCallContacts(PluginCall call) {
        final JSONArray users;
        final JSONArray channels;
        final Context context;
        try {
            users = call.getArray("users");
            channels = call.getArray("channels");
            context = getContext().getApplicationContext();
        } catch (Exception e) {
            call.resolve();
            return;
        }
        if (users == null || channels == null || context == null) {
            call.resolve();
            return;
        }
        runContactsTask(call, () -> CallContactStore.replace(context, users, channels));
    }

    /** Forget every stored name and photo. For sign-out. Resolves once they are gone. */
    @PluginMethod
    public void clearCallContacts(PluginCall call) {
        final Context context;
        try {
            context = getContext().getApplicationContext();
        } catch (Exception e) {
            call.resolve();
            return;
        }
        if (context == null) {
            call.resolve();
            return;
        }
        runContactsTask(call, () -> CallContactStore.clear(context));
    }

    /** Run one contact-list change on the worker and resolve the call when it is done. */
    private static void runContactsTask(final PluginCall call, final Runnable task) {
        try {
            CONTACTS_IO.execute(() -> {
                try {
                    task.run();
                } catch (Exception e) {
                    // The store handles its own failures and the ring works
                    // without a list, so there is nothing to report here.
                }
                call.resolve();
            });
        } catch (Exception e) {
            call.resolve();
        }
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
     *
     * Also clears everything about calls this session left on the phone:
     * every notification of the app (rings and missed calls carry names),
     * the stored rings and their alarms, a parked action, and any Answer
     * waiting for the unlock along with the lock-screen window flags. Turning
     * push off comes through here as well, and clears the same.
     */
    @PluginMethod
    public void clearSubscription(PluginCall call) {
        Context context = getContext();
        clearPendingAction();
        SlogaNotifier.forgetAllCalls(context);
        context.getSharedPreferences("sloga_push", Context.MODE_PRIVATE)
                .edit().clear().apply();
        call.resolve();
    }

    /**
     * The activity is going away. Every unlock still being waited for is
     * answered false here, which also takes down its receiver and its timer,
     * so nothing of a wait outlives the plugin.
     */
    @Override
    protected void handleOnDestroy() {
        UnlockWait[] waits;
        synchronized (unlockWaits) {
            destroyed = true;
            waits = unlockWaits.toArray(new UnlockWait[0]);
            unlockWaits.clear();
        }
        for (UnlockWait wait : waits) {
            wait.finish(false, false);
        }
        super.handleOnDestroy();
    }

    private KeyguardManager keyguard() {
        Context context = getContext();
        if (context == null) return null;
        return (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
    }

    /** True unless the keyguard can be read and says the phone is unlocked. */
    private boolean keyguardLocked() {
        try {
            KeyguardManager keyguard = keyguard();
            return keyguard == null || keyguard.isKeyguardLocked();
        } catch (Exception e) {
            return true;
        }
    }

    /** Drop the show-over-lockscreen window flags a ring put on the activity. */
    private void clearRingingWindowFlags() {
        Activity activity = getActivity();
        if (activity instanceof MainActivity) {
            ((MainActivity) activity).clearRingingWindowFlags();
        }
    }

    /**
     * One ensureUnlocked call that is waiting for the phone to be unlocked.
     *
     * finish() is the only place the call is answered, and it lets one caller
     * through. Whichever of the system's answer, the time limit and the
     * plugin's destruction comes first answers the call, and the others find
     * it answered and do nothing.
     */
    private final class UnlockWait {
        private final PluginCall call;
        private final Runnable timeout = () -> finish(false, false);
        private final Runnable settleCheck = this::settleCheckDue;

        // The fields below are guarded by this object's lock.
        private boolean answered = false;
        private BroadcastReceiver receiver;
        private Context receiverContext;
        /** elapsedRealtime of the first unlock the system reported, or -1. */
        private long unlockReportedAt = -1L;
        /** A re-check of the keyguard is already queued. */
        private boolean settleQueued = false;

        UnlockWait(PluginCall call) {
            this.call = call;
        }

        /**
         * Start the time limit and list the wait so a destroyed plugin can
         * end it. Answers false, starting nothing, when the plugin is already
         * destroyed.
         */
        boolean begin() {
            synchronized (unlockWaits) {
                if (destroyed) return false;
                unlockWaits.add(this);
            }
            mainHandler.postDelayed(timeout, UNLOCK_WAIT_MS);
            return true;
        }

        /** Ask the system for the unlock. Runs on the main thread. */
        void start(KeyguardManager keyguard, Activity activity) {
            try {
                if (isAnswered()) return;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    Api26Unlock.request(keyguard, activity, this);
                } else {
                    listenForUnlock(activity.getApplicationContext());
                }
            } catch (Exception e) {
                finish(false, false);
            }
        }

        /**
         * Android 7 has no call that asks for an unlock, so this waits for
         * the broadcast the system sends once the user has unlocked. The
         * receiver exists for this one wait and finish() takes it down.
         */
        private void listenForUnlock(Context context) {
            BroadcastReceiver unlockReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    if (intent != null && Intent.ACTION_USER_PRESENT.equals(intent.getAction())) {
                        unlockReported();
                    }
                }
            };
            synchronized (this) {
                if (answered) return;
                context.registerReceiver(
                        unlockReceiver, new IntentFilter(Intent.ACTION_USER_PRESENT));
                receiver = unlockReceiver;
                receiverContext = context;
            }
            // The user may have unlocked between the first look at the
            // keyguard and the registration. That broadcast is gone, so look
            // again now that the receiver is in place.
            if (!keyguardLocked()) unlockReported();
        }

        /**
         * The system says the phone was unlocked. It is believed only when
         * the keyguard agrees. An unlock is never reported while the lock
         * screen is still up.
         *
         * Right after the system's report the keyguard can still read locked
         * while the lock screen animates away, so it is asked again every
         * CallRingPolicy.UNLOCK_SETTLE_POLL_MS for up to UNLOCK_SETTLE_MAX_MS
         * from the first report, the same as MainActivity does for an
         * Answer. If it never agrees the answer is false.
         */
        void unlockReported() {
            if (!keyguardLocked()) {
                finish(true, true);
                return;
            }
            long now = SystemClock.elapsedRealtime();
            boolean keepWaiting;
            synchronized (this) {
                if (answered) return;
                if (unlockReportedAt < 0L) unlockReportedAt = now;
                keepWaiting = CallRingPolicy.unlockSettleKeepWaiting(unlockReportedAt, now);
                if (keepWaiting) {
                    if (settleQueued) return;
                    settleQueued = true;
                }
            }
            if (!keepWaiting) {
                finish(false, false);
                return;
            }
            mainHandler.postDelayed(settleCheck, CallRingPolicy.UNLOCK_SETTLE_POLL_MS);
        }

        /** The queued re-check of the keyguard. */
        private void settleCheckDue() {
            synchronized (this) {
                settleQueued = false;
                if (answered) return;
            }
            unlockReported();
        }

        private synchronized boolean isAnswered() {
            return answered;
        }

        /**
         * Answer the call, once. Later callers return without doing anything.
         * dropRingFlags is set only for an unlock the system reported, and
         * gives up the lockscreen bypass before the web layer hears of it.
         */
        void finish(boolean unlocked, boolean dropRingFlags) {
            BroadcastReceiver registered;
            Context registeredOn;
            synchronized (this) {
                if (answered) return;
                answered = true;
                registered = receiver;
                registeredOn = receiverContext;
                receiver = null;
                receiverContext = null;
            }
            mainHandler.removeCallbacks(timeout);
            mainHandler.removeCallbacks(settleCheck);
            synchronized (unlockWaits) {
                unlockWaits.remove(this);
            }
            if (registered != null) {
                try {
                    registeredOn.unregisterReceiver(registered);
                } catch (Exception e) {
                    // Already unregistered. The call is still answered below.
                }
            }
            if (dropRingFlags) {
                try {
                    clearRingingWindowFlags();
                } catch (Exception e) {
                    // The activity is gone, and its window flags with it.
                }
            }
            JSObject result = new JSObject();
            result.put("unlocked", unlocked);
            call.resolve(result);
        }
    }

    /**
     * The Android 8 unlock request, kept in its own class so the API 26
     * callback type is never loaded on an older phone.
     */
    @RequiresApi(Build.VERSION_CODES.O)
    private static final class Api26Unlock {
        private Api26Unlock() {}

        static void request(KeyguardManager keyguard, Activity activity, final UnlockWait wait) {
            keyguard.requestDismissKeyguard(
                    activity,
                    new KeyguardManager.KeyguardDismissCallback() {
                        @Override
                        public void onDismissSucceeded() {
                            wait.unlockReported();
                        }

                        @Override
                        public void onDismissCancelled() {
                            wait.finish(false, false);
                        }

                        @Override
                        public void onDismissError() {
                            wait.finish(false, false);
                        }
                    });
        }
    }
}

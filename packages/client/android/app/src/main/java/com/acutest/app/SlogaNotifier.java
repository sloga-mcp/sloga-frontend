package com.acutest.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Shader;
import android.os.Build;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import androidx.core.graphics.drawable.IconCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * Turns a Sloga push payload (pushd's data map) into a notification-bar
 * entry. Shared by the FCM service (play/sideload) and the UnifiedPush
 * service (foss), so it must stay free of Google push-SDK imports: callers
 * pass the push data map.
 *
 * Runs on the caller's thread. handle() does network I/O (message images and
 * the caller's photo), so never call it from the main thread. Both push
 * services call it from a worker thread: FCM's own, and the single worker of
 * the UnifiedPush service. Should it ever run on the main thread anyway, the
 * ring goes out at once without the photo. resolveCall() and onRingTimeout()
 * touch only preferences and notifications, and may be called from any
 * thread.
 *
 * Calls. A ring is a notification with the tag "call". While it lasts, a
 * note of it is kept in the "sloga_push" preferences under "ring:<chat id>".
 * The note is what says a ring was showing when something ends it, and that
 * decides whether a missed call is reported. Every read and write of the
 * note, and every post and cancel of the ring notification, happens while
 * holding the lock on this class. They can therefore never interleave: a
 * ring that was resolved while its photo loaded is never posted.
 *
 * A ring is posted exactly once. Posting it again, even only to add the
 * photo, stops its looping ringtone on Android 10 and later, so the photo is
 * fetched first, within CallRingPolicy.PHOTO_BUDGET_MS.
 */
final class SlogaNotifier {
    private static final String TAG = "SlogaFCM";
    // Channel settings are immutable after creation — bump the suffix to
    // apply new defaults on existing installs.
    private static final String CHANNEL_MESSAGES = "messages_v2";
    private static final String CHANNEL_CALLS = "incoming_calls_v3";
    private static final String CHANNEL_CALLS_OLD = "incoming_calls_v2";
    private static final String CHANNEL_MISSED = "missed_calls_v1";
    private static final String CHANNEL_SOCIAL = "social_v2";

    /** Tag of the ring notification. Message notifications have no tag. */
    static final String CALL_TAG = "call";
    /** Tag of the missed-call notification. */
    static final String MISSED_TAG = "missed_call";

    private static final String PREFS = "sloga_push";
    private static final String RING_KEY = "ring:";

    /** The Answer button's own action, so its PendingIntent is never another notification's. */
    static final String ACTION_ANSWER_CALL = "com.acutest.app.action.ANSWER_CALL";

    /** A photo larger than this is not read to the end. */
    private static final int PHOTO_MAX_BYTES = 2 * 1024 * 1024;
    /** Width and height of the photo as handed to the notification. */
    private static final int PHOTO_PX = 256;

    /** Goes between two names on one line. A middle dot with a space each side. */
    private static final String SEPARATOR = " \u00b7 ";

    /**
     * How long after a missed-call notification a second request for the
     * same chat, with no ring on record, is taken to be about the same call.
     */
    private static final long MISSED_REPEAT_MS = 10_000L;
    // Both guarded by the lock on this class.
    private static String lastMissedKey;
    private static long lastMissedAt;

    private SlogaNotifier() {}

    static void handle(Context ctx, Map<String, String> data) {
        String type = data.get("type");
        if (type == null) return;

        ensureChannels(ctx);

        switch (type) {
            case "push.message": {
                String author = data.get("author_name");
                String body = data.get("body");
                String channel = data.get("channel");
                notifyTapToOpen(
                        ctx,
                        CHANNEL_MESSAGES,
                        channel != null ? channel.hashCode() : 1,
                        author != null ? author : "New message",
                        body != null ? body : "",
                        data.get("image"),
                        channel != null ? "/channel/" + channel : null);
                break;
            }
            case "push.dm.call": {
                handleCall(ctx, data);
                break;
            }
            case "push.fr.receive": {
                String username = data.get("username");
                notifyTapToOpen(ctx, CHANNEL_SOCIAL, 3, "Friend Request",
                        (username != null ? username : "Someone") + " sent you a friend request",
                        null, "/friends");
                break;
            }
            case "push.fr.accept": {
                String username = data.get("username");
                notifyTapToOpen(ctx, CHANNEL_SOCIAL, 4, "Friend Request Accepted",
                        (username != null ? username : "Someone") + " accepted your friend request",
                        null, "/friends");
                break;
            }
            case "push.generic": {
                notifyTapToOpen(ctx, CHANNEL_MESSAGES, 5,
                        data.getOrDefault("title", "Sloga"),
                        data.getOrDefault("body", ""),
                        data.get("image"), null);
                break;
            }
            case "push.calendar": {
                String kind = data.get("kind");
                String eventTitle = data.get("title");
                String serverId = data.get("server_id");
                String eventId = data.get("event_id");
                String channelId = data.get("channel_id");
                String offsetMs = data.get("offset_ms");
                String title;
                String body;
                String channel;
                // Reminders land in the linked channel (the voice channel to
                // join); invites/cancellations land on the events page, where
                // the RSVP affordances live. Mirrors the web service worker.
                String path = serverId != null ? "/server/" + serverId + "/events" : null;
                if ("cancelled".equals(kind)) {
                    title = "Event cancelled";
                    body = (eventTitle != null ? eventTitle : "An event") + " was cancelled";
                    channel = CHANNEL_SOCIAL;
                } else if ("reminder".equals(kind)) {
                    // offset 0 = the at-start firing (explicit on the wire; never
                    // inferred from clocks) — mirrors the server-side render().
                    boolean started = "0".equals(offsetMs);
                    title = started ? "Event started" : "Upcoming event";
                    body = (eventTitle != null ? eventTitle : "An event")
                            + (started ? " has started" : " is starting soon");
                    channel = CHANNEL_MESSAGES; // time-sensitive -> high importance
                    if (serverId != null && channelId != null) {
                        path = "/server/" + serverId + "/channel/" + channelId;
                    }
                } else { // "invited" (or an unknown future kind)
                    title = "Event invitation";
                    body = "You're invited to " + (eventTitle != null ? eventTitle : "an event");
                    channel = CHANNEL_SOCIAL;
                }
                notifyTapToOpen(
                        ctx,
                        channel,
                        eventId != null ? eventId.hashCode() : 6,
                        title, body, null,
                        path);
                break;
            }
        }
    }

    /** channelId != null ? channelId.hashCode() : 2 */
    static int callNotificationId(String channelId) {
        return channelId != null ? channelId.hashCode() : 2;
    }

    /**
     * The ring for this chat is over on this device. Cancels the ring
     * notification (tag "call"), cancels the missed-call alarm, takes the
     * stored ring, and posts a missed-call notification when
     * CallRingPolicy.isMissed(reason, wasRinging) holds, where wasRinging
     * means a stored ring existed or webWasRinging is true.
     *
     * Safe to call twice: the second call finds no stored ring. When the
     * second call says the web layer was ringing, it would report the same
     * missed call again, so a repeat within a few seconds of the first
     * report is left out. Never throws. Does no network I/O.
     *
     * Whatever the reason, and even when something above failed, the activity
     * is told last that this chat's ring is over: it drops an Answer still
     * waiting for the unlock for this chat, and the lock-screen window flags
     * this chat's ring put on.
     */
    static void resolveCall(Context ctx, String channelId, String reason, boolean webWasRinging) {
        try {
            synchronized (SlogaNotifier.class) {
                StoredRing ring = readRing(ctx, channelId, System.currentTimeMillis());
                resolveLocked(ctx, channelId, reason, webWasRinging, ring);
            }
        } catch (Throwable t) {
            // Only the kind of failure is logged, never an id or a name.
            Log.w(TAG, "Could not resolve a call: " + t.getClass().getSimpleName());
        }
        ringOverOnActivity(channelId);
    }

    /**
     * The local ring timer ran out. Resolves with reason "timeout", but only
     * when the stored ring still exists and (callId == null || its call id
     * is null || they are equal). An alarm that was already on its way when
     * the ring was resolved or replaced finds no ring, or another call's
     * ring, and does nothing. Never throws. Does no network I/O.
     *
     * The stored ring is read here without its age limit. The alarm is
     * cancelled whenever a ring is resolved, and an alarm does not outlive a
     * restart, so one that fires proves its ring was never resolved, however
     * late the system delivered it. A late alarm still reports the missed
     * call.
     */
    static void onRingTimeout(Context ctx, String channelId, String callId) {
        boolean resolving = false;
        try {
            // Held across the check and the resolve, so the ring that was
            // checked is the ring that is resolved.
            synchronized (SlogaNotifier.class) {
                StoredRing ring = readRingAnyAge(ctx, channelId);
                if (ring == null) return;
                if (!CallRingPolicy.timeoutMatches(ring.callId, callId)) return;
                resolving = true;
                resolveLocked(ctx, channelId, "timeout", false, ring);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Could not end a ring: " + t.getClass().getSimpleName());
        } finally {
            if (resolving) ringOverOnActivity(channelId);
        }
    }

    /**
     * The body of a resolve, for a stored ring already read (null when there
     * is none). Call with the class lock held.
     */
    private static void resolveLocked(
            Context ctx, String channelId, String reason, boolean webWasRinging, StoredRing ring) {
        if (ring != null) removeRing(ctx, channelId);
        cancelRing(ctx, channelId);
        cancelAlarm(ctx, channelId);
        if (!CallRingPolicy.isMissed(reason, ring != null || webWasRinging)) return;
        if (ring == null && missedJustPosted(channelId)) return;
        postMissedCall(ctx, channelId, ring != null ? ring.callerId : null);
    }

    /** Tell the activity, if there is one, that this chat's ring is over. Never throws. */
    private static void ringOverOnActivity(String channelId) {
        try {
            MainActivity.onRingResolved(channelId);
        } catch (Throwable t) {
            Log.w(TAG, "Could not tell the app a ring ended: " + t.getClass().getSimpleName());
        }
    }

    /**
     * Sign-out. Every stored ring and its alarm goes, and every notification
     * this app posted is taken down: rings and missed calls carry names. The
     * activity drops any Answer waiting for the unlock and the lock-screen
     * window flags. Never throws.
     */
    static void forgetAllCalls(Context ctx) {
        try {
            synchronized (SlogaNotifier.class) {
                try {
                    SharedPreferences prefs = prefs(ctx);
                    SharedPreferences.Editor edit = prefs.edit();
                    for (String key : prefs.getAll().keySet()) {
                        if (key == null || !key.startsWith(RING_KEY)) continue;
                        cancelAlarm(ctx, key.substring(RING_KEY.length()));
                        edit.remove(key);
                    }
                    edit.commit();
                } catch (RuntimeException e) {
                    Log.w(TAG, "Stored rings could not be removed: "
                            + e.getClass().getSimpleName());
                }
                lastMissedKey = null;
                lastMissedAt = 0L;
                // Inside the lock, so a ring being posted right now is either
                // taken down here or posted after this, never half of each.
                NotificationManagerCompat.from(ctx).cancelAll();
            }
        } catch (Throwable t) {
            Log.w(TAG, "Could not clear the calls: " + t.getClass().getSimpleName());
        }
        try {
            MainActivity.onSignedOut();
        } catch (Throwable t) {
            Log.w(TAG, "Could not tell the app about the sign-out: "
                    + t.getClass().getSimpleName());
        }
    }

    /**
     * How long the lock-screen window flags may stay on for this chat's ring,
     * or -1 when they must not go on: there is no stored ring for the chat,
     * it belongs to another call, or its time is up. A ring that was resolved
     * is no longer stored, so it can never put the flags on again. Never
     * throws; a failure answers -1.
     */
    static long ringFlagsHoldMs(Context ctx, String channelId, String callId) {
        try {
            synchronized (SlogaNotifier.class) {
                long now = System.currentTimeMillis();
                StoredRing ring = readRing(ctx, channelId, now);
                if (ring == null) return -1L;
                if (callId != null && ring.callId != null && !callId.equals(ring.callId)) {
                    return -1L;
                }
                return CallRingPolicy.ringFlagsHoldMs(ring.postedAt, ring.shownMs, now);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Could not read a ring: " + t.getClass().getSimpleName());
            return -1L;
        }
    }

    /** A call push: a ring, or the news that a ring is over. */
    private static void handleCall(Context ctx, Map<String, String> data) {
        String channelId = data.get("channel_id");
        String callId = textOrNull(data.get("call_id"));
        long now = System.currentTimeMillis();

        if (Boolean.parseBoolean(data.get("ended"))) {
            synchronized (SlogaNotifier.class) {
                StoredRing ring = readRing(ctx, channelId, now);
                if (callId != null && ring != null && ring.callId != null
                        && !callId.equals(ring.callId)) {
                    // This push is about an older ring in the same chat. The
                    // ring that is showing now belongs to another call and
                    // is left alone.
                    return;
                }
                // An old server sends no reason, which reads as a missed
                // call when a ring was showing.
                resolveCall(ctx, channelId, data.get("reason"), false);
            }
            return;
        }

        String callerId = textOrNull(data.get("initiator_id"));
        boolean video = CallRingPolicy.isVideo(data.get("video"));
        long started = CallRingPolicy.parseStartedAt(data.get("started_at"));
        long ringMs = CallRingPolicy.ringMs(data.get("duration"));

        if (CallRingPolicy.shouldDrop(started, ringMs, now)) {
            // Too old to ring. The user did miss a call, so it is reported
            // as one. Nothing is stored and a ring that is showing for
            // another call in this chat is not touched.
            synchronized (SlogaNotifier.class) {
                postMissedCall(ctx, channelId, callerId);
            }
            return;
        }

        long shownMs = CallRingPolicy.shownMs(started, ringMs, now);
        // The push carries ids only. Names come from the list the web layer
        // left on the phone, and are null when it does not know them.
        Ring ring = new Ring(
                channelId, callerId, callId, video,
                CallContactStore.userName(ctx, callerId),
                CallContactStore.channelName(ctx, channelId));

        long postedAt;
        long writtenElapsed;
        synchronized (SlogaNotifier.class) {
            // The ring is stored and its alarm set even when the notification
            // is left out below, so the end of the ring is judged the same
            // way whichever of the two was ringing.
            postedAt = writeRing(ctx, ring, shownMs, now);
            writtenElapsed = SystemClock.elapsedRealtime();
            scheduleAlarm(ctx, channelId, callId, shownMs);

            // ONE ringing UI at a time. With the app in front AND its web layer
            // connected, that layer already shows an Accept/Decline popup, so a
            // notification here is the duplicate the user has to dismiss twice.
            // Both conditions are required: see isInAppCallUiActive().
            if (MainActivity.isForeground() && PushTokenPlugin.isInAppCallUiActive()) {
                Log.i(TAG, "Suppressing call notification; the in-app popup is showing it");
                return;
            }
        }

        // Outside the lock: this is network I/O, and resolving a ring must
        // never wait for it. It is bounded by PHOTO_BUDGET_MS, and skipped on
        // the main thread, which must never wait for the network.
        Bitmap photo = onMainThread()
                ? null
                : fetchPhoto(CallContactStore.userAvatar(ctx, callerId));

        synchronized (SlogaNotifier.class) {
            // Only the ring stored above is posted. If it was resolved while
            // the photo loaded the note is gone, and if another ring for this
            // chat took its place the note has another time.
            StoredRing stored = readRing(ctx, channelId, System.currentTimeMillis());
            if (stored == null || stored.postedAt != postedAt) return;
            // Ends when the alarm set above fires.
            long timeoutMs = CallRingPolicy.ringTimeoutAfterWaitMs(
                    shownMs, SystemClock.elapsedRealtime() - writtenElapsed);
            postRing(ctx, ring, photo, timeoutMs);
        }
    }

    /** Whether this is the app's main thread. Not knowing reads as yes. */
    private static boolean onMainThread() {
        try {
            return Looper.myLooper() == Looper.getMainLooper();
        } catch (RuntimeException e) {
            return true;
        }
    }

    /** What a ring notification shows and carries. Names are null when unknown. */
    private static final class Ring {
        final String channelId;
        final String callerId;
        final String callId;
        final boolean video;
        final String callerName;
        final String groupName;

        Ring(String channelId, String callerId, String callId, boolean video,
                String callerName, String groupName) {
            this.channelId = channelId;
            this.callerId = callerId;
            this.callId = callId;
            this.video = video;
            this.callerName = callerName;
            this.groupName = groupName;
        }
    }

    /**
     * Posts the ring notification, once per ring. Tries the system's call
     * style first. If building or posting that fails in any way, the same
     * ring is posted in the plain style with the same three intents, because
     * a ring that looks plainer is better than no ring. Answers whether a
     * notification was posted. Call with the class lock held.
     *
     * Never call it a second time for a ring that is sounding: on Android 10
     * and later that update stops the looping ringtone.
     */
    private static boolean postRing(Context ctx, Ring ring, Bitmap photo, long timeoutMs) {
        int id = callNotificationId(ring.channelId);
        NotificationManagerCompat manager = NotificationManagerCompat.from(ctx);

        Notification styled = null;
        try {
            styled = insistent(ringBuilder(ctx, ring, photo, timeoutMs, true).build());
        } catch (Throwable t) {
            Log.w(TAG, "Call style could not be built: " + t.getClass().getSimpleName());
        }
        if (styled != null) {
            try {
                manager.notify(CALL_TAG, id, styled);
                return true;
            } catch (SecurityException e) {
                Log.w(TAG, "Call style was refused; trying the plain style");
            } catch (RuntimeException e) {
                // The system checks a call-style notification when it is
                // posted and can refuse it there.
                Log.w(TAG, "Call style could not be posted: " + e.getClass().getSimpleName());
            }
        }

        try {
            Notification plain =
                    insistent(ringBuilder(ctx, ring, photo, timeoutMs, false).build());
            manager.notify(CALL_TAG, id, plain);
            return true;
        } catch (SecurityException e) {
            Log.w(TAG, "Notification permission not granted");
        } catch (RuntimeException e) {
            Log.w(TAG, "Call notification could not be posted: " + e.getClass().getSimpleName());
        }
        return false;
    }

    /** Makes the ringtone repeat until the notification goes away. */
    private static Notification insistent(Notification notification) {
        notification.flags |= Notification.FLAG_INSISTENT;
        return notification;
    }

    private static NotificationCompat.Builder ringBuilder(
            Context ctx, Ring ring, Bitmap photo, long timeoutMs, boolean callStyle) {
        int notificationId = callNotificationId(ring.channelId);
        String path = ring.channelId != null ? "/channel/" + ring.channelId : null;

        // RING intent: drives the full-screen intent and tapping the notification
        // body. Android fires a full-screen intent AUTOMATICALLY when the screen is
        // off or locked, so this MUST NOT answer: it only wakes the screen and opens
        // the ringing UI, where the user picks Accept or Decline. (Wiring the answer
        // intent here made calls auto-join with the screen still off.)
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) open.putExtra("sloga_path", path);
        open.putExtra("sloga_ring_call", true);
        if (ring.callerId != null) open.putExtra("sloga_caller_id", ring.callerId);
        if (ring.callId != null) open.putExtra("sloga_call_id", ring.callId);
        open.putExtra("sloga_video", ring.video);
        // Proves to the exported MainActivity that Sloga minted this Intent.
        open.putExtra(IntentNonce.EXTRA, IntentNonce.get(ctx));
        PendingIntent ringIntent = PendingIntent.getActivity(
                ctx, notificationId + 300000, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // ANSWER intent: ONLY the explicit "Answer" action button carries it.
        // Its own action keeps its PendingIntent apart from every other one
        // that opens the activity (ring, message and missed-call taps): the
        // system tells PendingIntents apart by request code and Intent, not
        // by extras, and FLAG_UPDATE_CURRENT would otherwise let another
        // notification's request code land on this one and rewrite it. The
        // activity reads extras only, behind the nonce, so the action changes
        // nothing there; the platform does not hold an app's own
        // PendingIntent to the activity's intent filters.
        Intent answer = new Intent(ctx, MainActivity.class);
        answer.setAction(ACTION_ANSWER_CALL);
        answer.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) answer.putExtra("sloga_path", path);
        answer.putExtra("sloga_answer_call", true);
        if (ring.callId != null) answer.putExtra("sloga_call_id", ring.callId);
        answer.putExtra("sloga_video", ring.video);
        answer.putExtra(IntentNonce.EXTRA, IntentNonce.get(ctx));
        PendingIntent answerIntent = PendingIntent.getActivity(
                ctx, notificationId + 100000, answer,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent decline = new Intent(ctx, NotificationDismissReceiver.class);
        decline.putExtra("notification_id", notificationId);
        // Lets the receiver tell a running web layer which call was declined.
        if (ring.channelId != null) decline.putExtra("sloga_channel_id", ring.channelId);
        if (ring.callId != null) decline.putExtra("sloga_call_id", ring.callId);
        PendingIntent declineIntent = PendingIntent.getBroadcast(
                ctx, notificationId + 200000, decline,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // The first line is the caller's name. When the phone does not know
        // the caller, it is the kind of call, so the ring never has to make
        // up a name.
        String kind = CallRingPolicy.title(ring.video);
        String heading = ring.callerName != null ? ring.callerName : kind;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_CALLS)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(heading)
                .setContentText(ringText(ctx, ring, kind))
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                // The lock screen shows the ring whole: who is calling, and the
                // photo. Nothing in it comes from a chat.
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(true)
                .setFullScreenIntent(ringIntent, true)
                .setContentIntent(ringIntent)
                // This is what stops the ring. Before Android 8 it does
                // nothing, and the ring stops when it is resolved.
                .setTimeoutAfter(timeoutMs);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Before Android 8 there are no channels, so the ringtone the
            // channel gives newer phones is set here.
            builder.setSound(
                    android.media.RingtoneManager.getDefaultUri(
                            android.media.RingtoneManager.TYPE_RINGTONE),
                    android.media.AudioManager.STREAM_RING);
        }

        if (callStyle) {
            // The call style needs a person with a name that is not empty.
            // heading never is.
            Person.Builder person = new Person.Builder().setName(heading).setImportant(true);
            if (photo != null) person.setIcon(IconCompat.createWithBitmap(photo));
            builder.setStyle(
                    NotificationCompat.CallStyle
                            .forIncomingCall(person.build(), declineIntent, answerIntent)
                            .setIsVideo(ring.video));
        } else {
            if (photo != null) builder.setLargeIcon(photo);
            builder.addAction(0, "Decline", declineIntent);
            builder.addAction(0, "Answer", answerIntent);
        }
        return builder;
    }

    /**
     * The ring's second line. With a known caller it is the kind of call,
     * followed by the group's name for a group call. With an unknown caller
     * the kind of call is already the first line, so this is the group's
     * name, or the app's name when there is no group either.
     */
    private static String ringText(Context ctx, Ring ring, String kind) {
        if (ring.callerName != null) {
            return ring.groupName != null ? kind + SEPARATOR + ring.groupName : kind;
        }
        if (ring.groupName != null) return ring.groupName;
        return ctx.getString(R.string.app_name);
    }

    /**
     * "Missed call" for a chat, with the caller's and the group's name when
     * the phone knows them. Tapping it opens the chat. Its contents stay
     * hidden on the lock screen. Call with the class lock held.
     */
    private static void postMissedCall(Context ctx, String channelId, String callerId) {
        lastMissedKey = ringKey(channelId);
        lastMissedAt = SystemClock.elapsedRealtime();
        try {
            // This can run before any push has, from the decline button or
            // the web layer, so the channel may not exist yet.
            ensureChannels(ctx);

            String caller = CallContactStore.userName(ctx, callerId);
            String group = CallContactStore.channelName(ctx, channelId);
            String text;
            if (caller != null && group != null) {
                text = caller + SEPARATOR + group;
            } else if (caller != null) {
                text = caller;
            } else {
                text = group != null ? group : "";
            }

            int id = callNotificationId(channelId);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_MISSED)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle("Missed call")
                    .setContentText(text)
                    .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setAutoCancel(true)
                    // A second report for a chat replaces the first without
                    // sounding again while the first is still there.
                    .setOnlyAlertOnce(true)
                    .setContentIntent(tapIntent(
                            ctx, id + 500000, channelId != null ? "/channel/" + channelId : null));
            NotificationManagerCompat.from(ctx).notify(MISSED_TAG, id, builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Notification permission not granted");
        } catch (RuntimeException e) {
            Log.w(TAG, "Missed call could not be posted: " + e.getClass().getSimpleName());
        }
    }

    /** Whether a missed call for this chat was reported a moment ago. Lock held. */
    private static boolean missedJustPosted(String channelId) {
        if (lastMissedKey == null || !lastMissedKey.equals(ringKey(channelId))) return false;
        long since = SystemClock.elapsedRealtime() - lastMissedAt;
        return since >= 0 && since < MISSED_REPEAT_MS;
    }

    /** Lock held. */
    private static void cancelRing(Context ctx, String channelId) {
        try {
            NotificationManagerCompat.from(ctx).cancel(CALL_TAG, callNotificationId(channelId));
        } catch (RuntimeException e) {
            Log.w(TAG, "Call notification could not be cancelled: "
                    + e.getClass().getSimpleName());
        }
    }

    private static void scheduleAlarm(Context ctx, String channelId, String callId, long delayMs) {
        try {
            MissedCallAlarmReceiver.schedule(ctx, channelId, callId, delayMs);
        } catch (RuntimeException e) {
            // The ring still stops by its own timeout. Only the missed-call
            // notification for an unanswered ring depends on the alarm.
            Log.w(TAG, "Ring alarm could not be set: " + e.getClass().getSimpleName());
        }
    }

    private static void cancelAlarm(Context ctx, String channelId) {
        try {
            MissedCallAlarmReceiver.cancel(ctx, channelId);
        } catch (RuntimeException e) {
            // An alarm that still fires finds no stored ring and does nothing.
            Log.w(TAG, "Ring alarm could not be cancelled: " + e.getClass().getSimpleName());
        }
    }

    // The stored ring. Everything below is called with the class lock held.

    /**
     * The note of one ring, as kept in the preferences: a small JSON object
     * {callId, callerId, video, postedAt, shownMs}. callId and callerId are
     * left out when unknown. postedAt is the phone's clock when the ring was
     * written, and shownMs is how long the ring was to be shown.
     */
    private static final class StoredRing {
        final String callId;
        final String callerId;
        final boolean video;
        final long postedAt;
        final long shownMs;

        StoredRing(String callId, String callerId, boolean video, long postedAt, long shownMs) {
            this.callId = callId;
            this.callerId = callerId;
            this.video = video;
            this.postedAt = postedAt;
            this.shownMs = shownMs;
        }

        String toJson() throws JSONException {
            JSONObject json = new JSONObject();
            if (callId != null) json.put("callId", callId);
            if (callerId != null) json.put("callerId", callerId);
            json.put("video", video);
            json.put("postedAt", postedAt);
            json.put("shownMs", shownMs);
            return json.toString();
        }

        /** Null when the text is not a note this class wrote. */
        static StoredRing parse(String raw) {
            try {
                JSONObject json = new JSONObject(raw);
                return new StoredRing(
                        text(json, "callId"),
                        text(json, "callerId"),
                        json.optBoolean("video", false),
                        json.optLong("postedAt", 0L),
                        json.optLong("shownMs", 0L));
            } catch (JSONException e) {
                return null;
            }
        }

        /** The value under key when it is text that is not empty, else null. */
        private static String text(JSONObject json, String key) {
            Object value = json.opt(key);
            return value instanceof String ? textOrNull((String) value) : null;
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String ringKey(String channelId) {
        return RING_KEY + (channelId != null ? channelId : "");
    }

    /**
     * The stored ring for this chat, or null when there is none that can be
     * believed. A note that is damaged, or older than the policy allows, is
     * thrown away here and does not count as a ring: the alarm that should
     * have ended it can be lost when the phone restarts, and a note left
     * behind must not turn the end of some later call into a missed call.
     * A ring notification that outlived such a note is removed with it.
     */
    private static StoredRing readRing(Context ctx, String channelId, long now) {
        try {
            String raw = prefs(ctx).getString(ringKey(channelId), null);
            if (raw == null) return null;
            StoredRing ring = StoredRing.parse(raw);
            if (ring != null
                    && !CallRingPolicy.storedRingExpired(ring.postedAt, ring.shownMs, now)) {
                return ring;
            }
            removeRing(ctx, channelId);
            cancelRing(ctx, channelId);
            cancelAlarm(ctx, channelId);
            return null;
        } catch (RuntimeException e) {
            // A store that cannot be read holds no ring.
            return null;
        }
    }

    /**
     * The stored ring for this chat whatever its age, or null when there is
     * none or the note is damaged. Only for a ring alarm that fired, see
     * onRingTimeout. Leaves the note where it is.
     */
    private static StoredRing readRingAnyAge(Context ctx, String channelId) {
        try {
            String raw = prefs(ctx).getString(ringKey(channelId), null);
            return raw == null ? null : StoredRing.parse(raw);
        } catch (RuntimeException e) {
            // A store that cannot be read holds no ring.
            return null;
        }
    }

    /**
     * Stores the ring and answers the time it was stored under, which is
     * what identifies this ring when it is posted once its photo is in.
     */
    private static long writeRing(Context ctx, Ring ring, long shownMs, long now) {
        long postedAt = now;
        try {
            SharedPreferences prefs = prefs(ctx);
            String key = ringKey(ring.channelId);
            String previousRaw = prefs.getString(key, null);
            StoredRing previous = previousRaw != null ? StoredRing.parse(previousRaw) : null;
            // Two rings for one chat never share a time, even when they are
            // written within the same millisecond. A time far in the future
            // is not followed, or one bad note would date every later ring.
            if (previous != null && previous.postedAt >= postedAt
                    && previous.postedAt - postedAt < 1_000L) {
                postedAt = previous.postedAt + 1;
            }
            String json =
                    new StoredRing(ring.callId, ring.callerId, ring.video, postedAt, shownMs)
                            .toJson();
            // commit(), not apply(): the push service can be stopped as soon
            // as this returns, and a ring that is not on disk by then would
            // never be reported as missed.
            prefs.edit().putString(key, json).commit();
        } catch (JSONException e) {
            Log.w(TAG, "Ring could not be written down");
        } catch (RuntimeException e) {
            // The ring still shows. Without the note its end cannot be
            // reported as a missed call.
            Log.w(TAG, "Ring could not be stored: " + e.getClass().getSimpleName());
        }
        return postedAt;
    }

    private static void removeRing(Context ctx, String channelId) {
        try {
            prefs(ctx).edit().remove(ringKey(channelId)).commit();
        } catch (RuntimeException e) {
            Log.w(TAG, "Stored ring could not be removed: " + e.getClass().getSimpleName());
        }
    }

    private static String textOrNull(String value) {
        return value == null || value.isEmpty() ? null : value;
    }

    // The caller's photo.

    /**
     * The photo behind an https URL, round and small, or null. Gives up once
     * CallRingPolicy.PHOTO_BUDGET_MS has passed since it began, whatever the
     * network or the decoder is doing: the download runs on its own thread
     * and this one stops waiting for it. The ring is posted right after this
     * returns, with the photo or without.
     */
    private static Bitmap fetchPhoto(String url) {
        if (!CallRingPolicy.photoUrlAllowed(url)) return null;
        final long started = SystemClock.elapsedRealtime();
        FutureTask<Bitmap> task = new FutureTask<>(() -> downloadPhoto(url, started));
        try {
            Thread worker = new Thread(task, "sloga-call-photo");
            worker.setDaemon(true);
            worker.start();
            long wait = CallRingPolicy.photoTimeLeftMs(started, SystemClock.elapsedRealtime());
            if (wait <= 0L) {
                task.cancel(true);
                return null;
            }
            return task.get(wait, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            task.cancel(true);
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception | OutOfMemoryError e) {
            // Too slow, or the download failed. The ring goes without it.
            task.cancel(true);
            return null;
        }
    }

    /** The download itself, on its own thread. Stops at the same budget as the wait. */
    private static Bitmap downloadPhoto(String url, long started) {
        HttpURLConnection conn = null;
        try {
            long left = CallRingPolicy.photoTimeLeftMs(started, SystemClock.elapsedRealtime());
            // A timeout of 0 would mean no limit at all.
            if (left <= 0L) return null;
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout((int) left);
            conn.setReadTimeout((int) left);
            // A redirect is followed only to another https address, which is
            // what HttpURLConnection does by itself. Nothing but the URL is
            // sent: no session token and no cookie.
            if (conn.getResponseCode() != HttpURLConnection.HTTP_OK) return null;

            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[16 * 1024];
            try (InputStream in = conn.getInputStream()) {
                int read;
                while ((read = in.read(chunk)) != -1) {
                    bytes.write(chunk, 0, read);
                    if (bytes.size() > PHOTO_MAX_BYTES) return null;
                    long now = SystemClock.elapsedRealtime();
                    if (CallRingPolicy.photoTimeLeftMs(started, now) <= 0L) return null;
                }
            }
            byte[] data = bytes.toByteArray();

            // Read the size first, so a very large picture is decoded small
            // instead of whole.
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            int sample = 1;
            while (Math.min(bounds.outWidth, bounds.outHeight) / (sample * 2) >= PHOTO_PX) {
                sample *= 2;
            }
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sample;
            Bitmap decoded = BitmapFactory.decodeByteArray(data, 0, data.length, options);
            return decoded != null ? roundPhoto(decoded) : null;
        } catch (Exception | OutOfMemoryError e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** The middle of the picture as a circle, PHOTO_PX across. */
    private static Bitmap roundPhoto(Bitmap source) {
        Bitmap round = Bitmap.createBitmap(PHOTO_PX, PHOTO_PX, Bitmap.Config.ARGB_8888);
        float scale = PHOTO_PX / (float) Math.min(source.getWidth(), source.getHeight());
        Matrix matrix = new Matrix();
        matrix.setScale(scale, scale);
        matrix.postTranslate(
                (PHOTO_PX - source.getWidth() * scale) / 2f,
                (PHOTO_PX - source.getHeight() * scale) / 2f);
        BitmapShader shader =
                new BitmapShader(source, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        shader.setLocalMatrix(matrix);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        paint.setShader(shader);
        new Canvas(round).drawCircle(PHOTO_PX / 2f, PHOTO_PX / 2f, PHOTO_PX / 2f, paint);
        return round;
    }

    /** The nonce-carrying Intent that opens the app at a path when a notification is tapped. */
    private static PendingIntent tapIntent(Context ctx, int requestCode, String path) {
        Intent launch = new Intent(ctx, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (path != null) launch.putExtra("sloga_path", path);
        launch.putExtra(IntentNonce.EXTRA, IntentNonce.get(ctx));
        return PendingIntent.getActivity(
                ctx, requestCode, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void notifyTapToOpen(
            Context ctx, String channelId, int notificationId, String title, String body,
            String imageUrl, String path) {
        PendingIntent contentIntent = tapIntent(ctx, notificationId, path);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, channelId)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(contentIntent)
                .setPriority(CHANNEL_CALLS.equals(channelId)
                        ? NotificationCompat.PRIORITY_MAX
                        : NotificationCompat.PRIORITY_HIGH);

        Bitmap avatar = fetchBitmap(imageUrl);
        if (avatar != null) builder.setLargeIcon(avatar);

        try {
            NotificationManagerCompat.from(ctx).notify(notificationId, builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "Notification permission not granted");
        }
    }

    private static Bitmap fetchBitmap(String url) {
        if (url == null || url.isEmpty()) return null;
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);
            return BitmapFactory.decodeStream(conn.getInputStream());
        } catch (Exception e) {
            return null;
        }
    }

    static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = ctx.getSystemService(NotificationManager.class);
            android.media.AudioAttributes attrs = new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            android.net.Uri sound = android.media.RingtoneManager
                    .getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION);

            NotificationChannel messages = new NotificationChannel(
                    CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
            messages.setSound(sound, attrs);
            messages.enableVibration(true);
            manager.createNotificationChannel(messages);

            // A ring is played as a ringtone, not as a notification sound, so
            // it follows the phone's ring volume and its rules for calls.
            android.media.AudioAttributes ringAttrs = new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            NotificationChannel calls = new NotificationChannel(
                    CHANNEL_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
            calls.setDescription("Ringing for incoming voice calls");
            calls.setSound(android.media.RingtoneManager
                    .getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE), ringAttrs);
            calls.enableVibration(true);
            manager.createNotificationChannel(calls);
            // The channel the ring used before this one. Its settings cannot
            // be changed, so it is replaced and removed.
            manager.deleteNotificationChannel(CHANNEL_CALLS_OLD);

            NotificationChannel missed = new NotificationChannel(
                    CHANNEL_MISSED, "Missed calls", NotificationManager.IMPORTANCE_DEFAULT);
            missed.setSound(sound, attrs);
            manager.createNotificationChannel(missed);

            NotificationChannel social = new NotificationChannel(
                    CHANNEL_SOCIAL, "Friend requests", NotificationManager.IMPORTANCE_DEFAULT);
            social.setSound(sound, attrs);
            manager.createNotificationChannel(social);
        }
    }
}

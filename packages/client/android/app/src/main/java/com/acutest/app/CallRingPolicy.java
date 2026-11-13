package com.acutest.app;

/**
 * The rules for an incoming-call ring, kept apart from the notification code
 * so they run on a plain JVM. Nothing here touches Android: the caller reads
 * the push's fields and the clock and passes them in.
 *
 * A call push says when the ring began ("started_at", by the server's clock)
 * and how long the server lets it ring ("duration", in seconds). A push can
 * arrive late, so these rules answer three questions for the notifier: is
 * this ring too old to show, how long may it still sound, and does a ring
 * that stopped count as a missed call.
 *
 * The phone's clock is the least reliable input here. The server already
 * expires the push after the ring length, and its "ended" push stops the ring
 * on time, so the notifier decides with shouldDrop and shownMs, which allow
 * for a clock that is off. isStale and remainingMs are the exact rules those
 * two are built on.
 */
public final class CallRingPolicy {
    /** Ring length used when the push gives none, or one that is out of range. */
    public static final long DEFAULT_RING_MS = 45_000L;

    private static final long MIN_RING_SECS = 5L;
    private static final long MAX_RING_SECS = 120L;
    /** The shortest time a ring that is shown at all is left on screen. */
    private static final long MIN_REMAINING_MS = 1_000L;

    /** How far the phone's clock may be off before a push is treated as too old to ring. */
    public static final long CLOCK_TOLERANCE_MS = 120_000L;
    /** The shortest ring shown for a push that is not dropped. */
    public static final long MIN_SHOWN_MS = 15_000L;
    /** How long past its end a ring the notifier wrote down is still believed. */
    public static final long STORED_RING_GRACE_MS = 300_000L;

    private CallRingPolicy() {}

    /**
     * Ring length from the push's "duration" field (seconds). Missing,
     * unparseable or outside 5..=120 answers 45 s.
     *
     * Only a plain run of the digits 0 to 9 is read as a number. A sign, a
     * decimal point, a space or any other character makes the value
     * unparseable.
     */
    public static long ringMs(String durationSecs) {
        if (durationSecs == null || durationSecs.isEmpty()) return DEFAULT_RING_MS;
        long secs = 0;
        for (int i = 0; i < durationSecs.length(); i++) {
            char c = durationSecs.charAt(i);
            if (!isDigit(c)) return DEFAULT_RING_MS;
            secs = secs * 10 + (c - '0');
            // Leaving here keeps a long run of digits from overflowing.
            if (secs > MAX_RING_SECS) return DEFAULT_RING_MS;
        }
        if (secs < MIN_RING_SECS) return DEFAULT_RING_MS;
        return secs * 1000L;
    }

    /**
     * Epoch millis of the push's "started_at", or -1 when it is missing or
     * unparseable.
     *
     * Accepts an ISO 8601 timestamp in UTC: 2026-11-13T14:19:45Z, the same
     * with fractional seconds of any length (2026-11-13T14:19:45.123456Z),
     * and +00:00 in place of Z. Digits past the third of a fraction are
     * dropped, not rounded. Any other shape answers -1, including another
     * offset, a missing zone, a date that does not exist and a second of 60.
     *
     * Written by hand because java.time needs API 26 and the app runs on 24.
     */
    public static long parseStartedAt(String iso) {
        if (iso == null) return -1L;
        int length = iso.length();
        // The shortest accepted form, 2026-11-13T14:19:45Z, is 20 characters.
        if (length < 20) return -1L;
        if (iso.charAt(4) != '-' || iso.charAt(7) != '-' || iso.charAt(10) != 'T'
                || iso.charAt(13) != ':' || iso.charAt(16) != ':') {
            return -1L;
        }

        int year = number(iso, 0, 4);
        int month = number(iso, 5, 2);
        int day = number(iso, 8, 2);
        int hour = number(iso, 11, 2);
        int minute = number(iso, 14, 2);
        int second = number(iso, 17, 2);
        if (year < 0 || month < 0 || day < 0 || hour < 0 || minute < 0 || second < 0) {
            return -1L;
        }
        // A start before 1970 would be a negative number, which callers could
        // not tell apart from the -1 answer. No real call starts there.
        if (year < 1970) return -1L;
        if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return -1L;
        if (hour > 23 || minute > 59 || second > 59) return -1L;

        int pos = 19;
        long millis = 0;
        if (iso.charAt(pos) == '.') {
            pos++;
            int count = 0;
            while (pos < length && isDigit(iso.charAt(pos))) {
                // Only the first three digits are milliseconds.
                if (count < 3) millis = millis * 10 + (iso.charAt(pos) - '0');
                count++;
                pos++;
            }
            if (count == 0) return -1L;
            // ".1" is 100 ms and ".12" is 120 ms.
            for (int i = count; i < 3; i++) millis *= 10;
        }

        String zone = iso.substring(pos);
        if (!"Z".equals(zone) && !"+00:00".equals(zone)) return -1L;

        long seconds = ((daysSince1970(year, month, day) * 24L + hour) * 60L + minute) * 60L
                + second;
        return seconds * 1000L + millis;
    }

    /**
     * A ring is stale when its start is known and now is past start + ringMs.
     * Unknown start is never stale: a push without a usable "started_at"
     * still rings. A start of zero or less counts as unknown.
     */
    public static boolean isStale(long startedAtMs, long ringMs, long nowMs) {
        if (startedAtMs <= 0) return false;
        // A start that is still to come is not stale. Checking it first also
        // keeps the subtraction below from overflowing on a nonsense clock.
        if (nowMs <= startedAtMs) return false;
        return nowMs - startedAtMs > ringMs;
    }

    /**
     * How long the notification may keep ringing: ringMs minus the time
     * already elapsed, at least 1000 and at most ringMs. Answers ringMs when
     * the start is unknown (zero or less).
     *
     * The upper limit covers a phone whose clock is behind the server's, so
     * the start looks like it is still to come. The lower limit keeps a ring
     * that is about to end on screen long enough to be seen.
     */
    public static long remainingMs(long startedAtMs, long ringMs, long nowMs) {
        if (startedAtMs <= 0) return ringMs;
        if (nowMs <= startedAtMs) return ringMs;
        long remaining = ringMs - (nowMs - startedAtMs);
        if (remaining < MIN_REMAINING_MS) remaining = MIN_REMAINING_MS;
        return remaining;
    }

    /**
     * Drop the ring: the start is known and now is past start + ringMs +
     * CLOCK_TOLERANCE_MS. A start of zero or less counts as unknown and is
     * never dropped.
     *
     * The tolerance is there because the comparison uses the phone's clock
     * against the server's. Without it a phone whose clock runs a minute
     * fast would see every 45 second ring as already over and never ring.
     * Nothing is lost by waiting the extra two minutes: the server expires
     * the push after the ring length, so a push that still arrives is almost
     * always for a ring that is going on, and the server's "ended" push
     * stops a ring that is not.
     */
    public static boolean shouldDrop(long startedAtMs, long ringMs, long nowMs) {
        if (startedAtMs <= 0) return false;
        // A start that is still to come is never too old. Checking it first
        // also keeps the subtraction below from overflowing.
        if (nowMs <= startedAtMs) return false;
        // Written this way round so a nonsense ring length cannot overflow.
        long allowed = ringMs > Long.MAX_VALUE - CLOCK_TOLERANCE_MS
                ? Long.MAX_VALUE
                : ringMs + CLOCK_TOLERANCE_MS;
        return nowMs - startedAtMs > allowed;
    }

    /**
     * How long to show a ring that is not dropped: remainingMs, at least
     * MIN_SHOWN_MS, never more than ringMs.
     *
     * The floor is for the same unreliable clock. A phone that is 40 seconds
     * fast would otherwise show a 45 second ring for five seconds. The ring
     * length is the upper limit even when it is shorter than the floor, so a
     * ring never outlasts the time the server lets the call ring.
     */
    public static long shownMs(long startedAtMs, long ringMs, long nowMs) {
        long shown = remainingMs(startedAtMs, ringMs, nowMs);
        if (shown < MIN_SHOWN_MS) shown = MIN_SHOWN_MS;
        if (shown > ringMs) shown = ringMs;
        return shown;
    }

    /**
     * Whether a ring the notifier wrote down is too old to believe. postedAtMs
     * is the phone's clock when the ring was written and shownMs is how long
     * it was to be shown.
     *
     * The notifier keeps a note of each ring until something ends it. The
     * phone's own timer for that is an alarm, which is lost when the phone
     * restarts or the app is force-stopped, so a note can be left behind.
     * Days later an "ended" push for some other call in that chat would find
     * it and report a missed call that never rang here. A note is therefore
     * believed only until five minutes past the end of its ring.
     *
     * A note written more than five minutes in the future is expired too:
     * the clock was set back since, so its age cannot be known. A note with
     * no usable time (zero or less) is expired. A shown time outside
     * 0..=120 s is read as the nearest end of that range, so a damaged note
     * cannot keep itself alive.
     */
    public static boolean storedRingExpired(long postedAtMs, long shownMs, long nowMs) {
        if (postedAtMs <= 0) return true;
        if (nowMs < postedAtMs) {
            long ahead = postedAtMs - nowMs;
            // A negative difference is an overflow on a nonsense clock.
            return ahead < 0 || ahead > STORED_RING_GRACE_MS;
        }
        long shown = shownMs;
        if (shown < 0) shown = 0;
        if (shown > MAX_RING_SECS * 1000L) shown = MAX_RING_SECS * 1000L;
        return nowMs - postedAtMs > shown + STORED_RING_GRACE_MS;
    }

    /**
     * Whether a ring that stopped counts as a missed call. reason is the
     * push's "reason" for an ended push, or the local dismiss reason.
     * wasRinging says a ring for that chat was showing.
     *
     * Missed: no reason at all, "cancelled", "ended" and "timeout". Not
     * missed: "answered", "declined", "answered_elsewhere" and "elsewhere",
     * because the user dealt with the call on some device. A reason this
     * build does not know is not missed either, so a newer server cannot make
     * an older app report calls the user may have answered.
     */
    public static boolean isMissed(String reason, boolean wasRinging) {
        if (!wasRinging) return false;
        if (reason == null) return true;
        switch (reason) {
            case "":
            case "cancelled":
            case "ended":
            case "timeout":
                return true;
            case "answered":
            case "declined":
            case "answered_elsewhere":
            case "elsewhere":
                return false;
            default:
                return false;
        }
    }

    // The ring on the phone: the caller's photo, the lock-screen window
    // flags, the ring alarm, the Answer's age and the unlock check.

    /**
     * The longest the caller's photo may hold up the ring, from the start of
     * the download to the decoded picture. The ring is posted once, with the
     * photo or without it: a second post of a ring that is already sounding
     * stops its ringtone on Android 10 and later.
     */
    public static final long PHOTO_BUDGET_MS = 1_500L;

    /** How long past the end of its ring the lock-screen window flags may stay. */
    public static final long RING_FLAGS_MARGIN_MS = 5_000L;

    /**
     * After the platform reports the lock screen gone, the keyguard query can
     * still read locked for a moment. It is asked again at this interval.
     */
    public static final long UNLOCK_SETTLE_POLL_MS = 100L;

    /** How long that asking again may go on before the unlock is given up. */
    public static final long UNLOCK_SETTLE_MAX_MS = 5_000L;

    /** Only a photo behind an https link is fetched. */
    public static boolean photoUrlAllowed(String url) {
        return url != null && url.startsWith("https://");
    }

    /**
     * How much of PHOTO_BUDGET_MS is left at nowMs for a download that began
     * at startedMs, both on the same clock that never goes back: 0 when it
     * is spent. A clock that reads earlier than the start cannot be right,
     * so it leaves nothing.
     */
    public static long photoTimeLeftMs(long startedMs, long nowMs) {
        if (nowMs < startedMs) return 0L;
        long spent = nowMs - startedMs;
        // A difference too large for a long wraps around to a negative number.
        if (spent < 0L || spent >= PHOTO_BUDGET_MS) return 0L;
        return PHOTO_BUDGET_MS - spent;
    }

    /**
     * The timeout of a ring posted sinceWrittenMs after it was stored, so it
     * ends when the alarm set at that moment fires: shownMs less the time
     * spent, never under MIN_REMAINING_MS. A negative time spent counts as
     * none.
     */
    public static long ringTimeoutAfterWaitMs(long shownMs, long sinceWrittenMs) {
        long spent = sinceWrittenMs < 0L ? 0L : sinceWrittenMs;
        long left = spent >= shownMs ? 0L : shownMs - spent;
        return left < MIN_REMAINING_MS ? MIN_REMAINING_MS : left;
    }

    /**
     * Whether the end of the ring for resolvedChannelId reaches something the
     * activity keeps for ownerChannelId: an Answer waiting for the unlock, or
     * the lock-screen window flags. Only the same chat does. A null on either
     * side matches nothing, so the end of one chat's ring never takes away
     * another chat's.
     */
    public static boolean ringResolutionApplies(String resolvedChannelId, String ownerChannelId) {
        return resolvedChannelId != null && resolvedChannelId.equals(ownerChannelId);
    }

    /**
     * How long the lock-screen window flags of a ring may stay on, or -1 when
     * they must not go on at all. postedAtMs and shownMs are the stored
     * ring's, on the phone's wall clock. A ring whose time is up gets -1;
     * otherwise the time it has left (never more than its shown time, and
     * never more than MAX_RING_SECS) plus RING_FLAGS_MARGIN_MS. A clock that
     * reads earlier than the ring counts as the moment it was posted.
     */
    public static long ringFlagsHoldMs(long postedAtMs, long shownMs, long nowMs) {
        if (postedAtMs <= 0L || shownMs <= 0L) return -1L;
        long shown = shownMs > MAX_RING_SECS * 1000L ? MAX_RING_SECS * 1000L : shownMs;
        long elapsed = nowMs > postedAtMs ? nowMs - postedAtMs : 0L;
        if (elapsed < 0L || elapsed >= shown) return -1L;
        return shown - elapsed + RING_FLAGS_MARGIN_MS;
    }

    /**
     * Where the age of a parked action is counted from. For an Answer that is
     * the moment of the tap, so the time it waited for the unlock counts
     * against the same limit as the time it waited in the slot. tappedAtMs
     * of zero or less means there was no tap to count from, and the parking
     * time is used. A tap later than the parking cannot be right, and the
     * earlier of the two is used.
     */
    public static long actionAgeFrom(long tappedAtMs, long parkedAtMs) {
        if (tappedAtMs <= 0L) return parkedAtMs;
        return tappedAtMs < parkedAtMs ? tappedAtMs : parkedAtMs;
    }

    /**
     * Whether a ring alarm that fired belongs to the stored ring: either side
     * not knowing the call id, or both naming the same call. No age limit
     * applies here. An alarm that fires proves its ring was never resolved,
     * however late the system delivered it.
     */
    public static boolean timeoutMatches(String storedCallId, String alarmCallId) {
        return alarmCallId == null || storedCallId == null || alarmCallId.equals(storedCallId);
    }

    /**
     * Whether the ring alarm is set as an exact one. Android 7 has no
     * notification timeout, so this alarm is all that stops the looping
     * ringtone, and an exact alarm needs no permission there. From Android 8
     * the notification stops itself and the inexact alarm is kept.
     */
    public static boolean useExactRingAlarm(int sdkInt) {
        return sdkInt < 26;
    }

    /**
     * After the platform said the lock screen was dismissed at reportedAtMs
     * while the keyguard query still reads locked: whether to ask again
     * (true) or give the unlock up (false). It is given up after
     * UNLOCK_SETTLE_MAX_MS, and at once when the clock reads earlier than
     * the report, which cannot be right.
     */
    public static boolean unlockSettleKeepWaiting(long reportedAtMs, long nowMs) {
        if (nowMs < reportedAtMs) return false;
        long waited = nowMs - reportedAtMs;
        return waited >= 0L && waited < UNLOCK_SETTLE_MAX_MS;
    }

    /** The chat id at the end of a "/channel/<id>" path, or null without a path. */
    public static String channelIdFromPath(String path) {
        if (path == null) return null;
        return path.substring(path.lastIndexOf('/') + 1);
    }

    /** Notification title. */
    public static String title(boolean video) {
        return video ? "Incoming video call" : "Incoming call";
    }

    /** Whether the push's "video" field says video. Only the exact text "true" does. */
    public static boolean isVideo(String video) {
        return "true".equals(video);
    }

    /** ASCII digits only. Character.isDigit would also accept other scripts' digits. */
    private static boolean isDigit(char c) {
        return c >= '0' && c <= '9';
    }

    /** The number written by count digits starting at from, or -1 if any is not a digit. */
    private static int number(String s, int from, int count) {
        int value = 0;
        for (int i = from; i < from + count; i++) {
            char c = s.charAt(i);
            if (!isDigit(c)) return -1;
            value = value * 10 + (c - '0');
        }
        return value;
    }

    private static boolean isLeapYear(int year) {
        return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    }

    private static int daysInMonth(int year, int month) {
        switch (month) {
            case 2:
                return isLeapYear(year) ? 29 : 28;
            case 4:
            case 6:
            case 9:
            case 11:
                return 30;
            default:
                return 31;
        }
    }

    /**
     * Days from 1970-01-01 to the given date in the Gregorian calendar. The
     * year is counted from March so the leap day falls at its end, which
     * makes the day of the year a plain formula of the month. Expects a year
     * of 1970 or later.
     */
    private static long daysSince1970(int year, int month, int day) {
        long y = month <= 2 ? year - 1 : year;
        long era = y / 400;
        long yearOfEra = y - era * 400;
        long monthFromMarch = month > 2 ? month - 3 : month + 9;
        long dayOfYear = (153 * monthFromMarch + 2) / 5 + day - 1;
        long dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear;
        return era * 146097 + dayOfEra - 719468;
    }
}

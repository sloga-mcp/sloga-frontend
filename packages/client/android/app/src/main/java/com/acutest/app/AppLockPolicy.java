package com.acutest.app;

/**
 * The rule for when a return to the app must ask for the unlock again, kept
 * apart from the activity code so it runs on a plain JVM. Nothing here
 * touches Android: the caller reads the saved settings and the clock and
 * passes them in.
 *
 * All times are SystemClock.elapsedRealtime() in milliseconds. That clock
 * keeps counting while the phone sleeps and ignores changes to the wall
 * clock, so a phone asleep for hours reads as away for hours.
 *
 * Any input that cannot be right answers "lock". Whether an unlock prompt is
 * open is not an input: that flag only stops a second prompt from opening.
 */
final class AppLockPolicy {
    /**
     * The longest a screen the app opened for a result (photo picker, camera,
     * file chooser, screen-share consent) may keep the app from locking.
     */
    static final long EXCURSION_CAP_MS = 180_000L;

    private AppLockPolicy() {}

    /** The timings the settings offer: at once, one minute, fifteen minutes. */
    static boolean validTimeout(int sec) {
        return sec == 0 || sec == 60 || sec == 900;
    }

    /**
     * Whether a return to the foreground must lock. Times are
     * SystemClock.elapsedRealtime() ms. leftAtMs of zero or less means the
     * app never left the screen, and the answer is coldStart alone.
     *
     * excursion says the app left for a screen it opened for a result, and
     * excursionStartedMs is when that screen was launched. Such a trip does
     * not lock while it is no older than EXCURSION_CAP_MS, whatever the
     * timing. A launch time later than now cannot be right and gives no
     * exemption.
     *
     * Otherwise the app locks once the time away reaches the timing, so a
     * timing of 0 locks on every return.
     */
    static boolean shouldLock(boolean enabled, boolean coldStart, long leftAtMs, long nowMs,
                              int timeoutSec, boolean excursion, long excursionStartedMs) {
        if (!enabled) return false;
        if (coldStart) return true;
        if (leftAtMs <= 0L) return false;
        // The clock went backwards, so the time away cannot be known.
        if (nowMs < leftAtMs) return true;
        if (!validTimeout(timeoutSec)) return true;
        if (excursion) {
            // A difference too large for a long wraps around to a negative
            // number, which gives no exemption either.
            long sinceLaunch = nowMs - excursionStartedMs;
            if (sinceLaunch >= 0L && sinceLaunch <= EXCURSION_CAP_MS) return false;
        }
        // leftAtMs is above zero and not after nowMs, so this cannot overflow.
        return nowMs - leftAtMs >= timeoutSec * 1000L;
    }
}

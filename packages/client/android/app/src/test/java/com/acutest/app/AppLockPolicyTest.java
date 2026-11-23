package com.acutest.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Host tests for {@link AppLockPolicy}. The class is plain Java, so these run
 * on the JVM with nothing standing in for Android.
 *
 * The rules under test, in the order the class applies them: a lock that is
 * off never locks, a cold start always locks, an app that never left the
 * screen does not lock, a clock that went backwards locks, a timing the
 * settings do not offer locks, a trip to a screen opened for a result does
 * not lock for three minutes, and otherwise the app locks once the time away
 * reaches the timing.
 *
 * The numbers in these tests are written out, not read from the class, so a
 * changed constant fails here.
 */
public class AppLockPolicyTest {
    /** When the app left the screen, on the clock that counts through sleep. */
    private static final long LEFT = 5_000_000L;
    /** The three timings the settings offer, in seconds. */
    private static final int[] TIMEOUTS = {0, 60, 900};

    /** A warm return with no trip to another screen. */
    private static boolean warm(long leftAtMs, long nowMs, int timeoutSec) {
        return AppLockPolicy.shouldLock(true, false, leftAtMs, nowMs, timeoutSec, false, 0L);
    }

    /** A warm return from a screen opened for a result at startedMs. */
    private static boolean excursion(long leftAtMs, long nowMs, int timeoutSec, long startedMs) {
        return AppLockPolicy.shouldLock(true, false, leftAtMs, nowMs, timeoutSec, true, startedMs);
    }

    // validTimeout

    @Test
    public void validTimeout_onlyTheThreeOfferedTimings() {
        assertTrue(AppLockPolicy.validTimeout(0));
        assertTrue(AppLockPolicy.validTimeout(60));
        assertTrue(AppLockPolicy.validTimeout(900));
        for (int bad : new int[] {
            -1, 1, 30, 59, 61, 300, 899, 901, 3_600, 60_000, 900_000, -60, -900,
            Integer.MAX_VALUE, Integer.MIN_VALUE
        }) {
            assertFalse("timeout " + bad, AppLockPolicy.validTimeout(bad));
        }
    }

    @Test
    public void theExcursionCapIsThreeMinutes() {
        assertEquals(180_000L, AppLockPolicy.EXCURSION_CAP_MS);
    }

    // Rule 1: the lock is off.

    @Test
    public void aLockThatIsOffNeverLocks() {
        // Not on a cold start.
        assertFalse(AppLockPolicy.shouldLock(false, true, 0L, LEFT, 0, false, 0L));
        assertFalse(AppLockPolicy.shouldLock(false, true, LEFT, LEFT + 1L, 0, false, 0L));
        // Not after any time away.
        assertFalse(AppLockPolicy.shouldLock(false, false, LEFT, LEFT, 0, false, 0L));
        assertFalse(
                AppLockPolicy.shouldLock(false, false, LEFT, LEFT + 86_400_000L, 60, false, 0L));
        assertFalse(AppLockPolicy.shouldLock(false, false, LEFT, Long.MAX_VALUE, 900, false, 0L));
        // Not on inputs that lock when it is on.
        assertFalse(AppLockPolicy.shouldLock(false, false, LEFT, LEFT - 1L, 0, false, 0L));
        assertFalse(AppLockPolicy.shouldLock(false, false, LEFT, LEFT + 1L, 30, false, 0L));
        assertFalse(
                AppLockPolicy.shouldLock(false, true, LEFT, LEFT - 1L, -1, true, Long.MAX_VALUE));
    }

    // Rule 2: a cold start.

    @Test
    public void aColdStartAlwaysLocks() {
        for (int timeout : TIMEOUTS) {
            String row = "timeout " + timeout;
            // A new process has no leaving time.
            assertTrue(row, AppLockPolicy.shouldLock(true, true, 0L, LEFT, timeout, false, 0L));
            assertTrue(row, AppLockPolicy.shouldLock(true, true, -1L, LEFT, timeout, false, 0L));
            // A leaving time inside the timing does not help.
            assertTrue(
                    row, AppLockPolicy.shouldLock(true, true, LEFT, LEFT + 1L, timeout, false, 0L));
        }
        // An excursion that would exempt a warm return does not exempt a cold start.
        assertTrue(AppLockPolicy.shouldLock(true, true, LEFT, LEFT + 1_000L, 900, true, LEFT));
        assertTrue(AppLockPolicy.shouldLock(true, true, 0L, LEFT, 900, true, LEFT));
    }

    // Rule 3: the app never left the screen.

    @Test
    public void anAppThatNeverLeftDoesNotLock() {
        for (int timeout : TIMEOUTS) {
            String row = "timeout " + timeout;
            assertFalse(row, warm(0L, LEFT, timeout));
            assertFalse(row, warm(-1L, LEFT, timeout));
            assertFalse(row, warm(Long.MIN_VALUE, LEFT, timeout));
            assertFalse(row, warm(0L, Long.MAX_VALUE, timeout));
            assertFalse(row, warm(0L, 0L, timeout));
        }
    }

    @Test
    public void neverLeftIsDecidedBeforeTheClockAndTheTimingAreRead() {
        // A clock below the leaving time, which would lock had the app left.
        assertFalse(warm(0L, -1L, 0));
        assertFalse(warm(-5L, -10L, 0));
        assertFalse(warm(0L, Long.MIN_VALUE, 0));
        // A timing the settings do not offer, which would lock had the app left.
        assertFalse(warm(0L, LEFT, 30));
        assertFalse(warm(0L, LEFT, -1));
        // The smallest leaving time that counts as having left.
        assertTrue(warm(1L, 1L, 0));
    }

    // Rule 4: the clock went backwards.

    @Test
    public void aClockThatWentBackwardsLocks() {
        for (int timeout : TIMEOUTS) {
            String row = "timeout " + timeout;
            assertTrue(row, warm(LEFT, LEFT - 1L, timeout));
            assertTrue(row, warm(LEFT, LEFT - 3_600_000L, timeout));
            assertTrue(row, warm(LEFT, 0L, timeout));
            assertTrue(row, warm(LEFT, -1L, timeout));
            // Clocks no phone has: the answer must not flip through overflow.
            assertTrue(row, warm(LEFT, Long.MIN_VALUE, timeout));
            assertTrue(row, warm(Long.MAX_VALUE, Long.MIN_VALUE, timeout));
            assertTrue(row, warm(Long.MAX_VALUE, Long.MAX_VALUE - 1L, timeout));
        }
    }

    @Test
    public void aClockThatWentBackwardsLocksEvenOnAnExcursion() {
        // The trip started before the app left and the clock then went back
        // to a moment between the two, so the trip alone looks fresh.
        assertTrue(excursion(LEFT, LEFT - 1L, 900, LEFT - 100L));
        assertTrue(excursion(LEFT, LEFT - 1L, 0, LEFT - 1L));
        assertTrue(excursion(LEFT, LEFT - 50_000L, 60, LEFT - 60_000L));
    }

    // Rule 5: a timing the settings do not offer.

    @Test
    public void anUnknownTimingLocks() {
        for (int bad : new int[] {
            -1, 1, 30, 59, 61, 300, 899, 901, 3_600, -60, Integer.MAX_VALUE, Integer.MIN_VALUE
        }) {
            String row = "timeout " + bad;
            // Back at once, which every offered timing but 0 would let through.
            assertTrue(row, warm(LEFT, LEFT, bad));
            assertTrue(row, warm(LEFT, LEFT + 1L, bad));
            assertTrue(row, warm(LEFT, LEFT + 86_400_000L, bad));
        }
    }

    @Test
    public void anUnknownTimingLocksEvenOnAnExcursion() {
        assertTrue(excursion(LEFT, LEFT + 1_000L, 30, LEFT));
        assertTrue(excursion(LEFT, LEFT + 1_000L, -1, LEFT));
        assertTrue(excursion(LEFT, LEFT + 1_000L, 3_600, LEFT - 500L));
    }

    // Rule 6: a trip to a screen the app opened for a result.

    @Test
    public void anExcursionInsideTheCapDoesNotLock() {
        // The screen is launched half a second before the app leaves.
        long started = LEFT - 500L;
        for (int timeout : TIMEOUTS) {
            String row = "timeout " + timeout;
            assertFalse(row, excursion(LEFT, LEFT, timeout, started));
            assertFalse(row, excursion(LEFT, LEFT + 30_000L, timeout, started));
            assertFalse(row, excursion(LEFT, started + 179_999L, timeout, started));
            // Exactly at the cap is still inside it.
            assertFalse(row, excursion(LEFT, started + 180_000L, timeout, started));
        }
        // Launched at the very moment of the return.
        assertFalse(excursion(LEFT, LEFT + 10_000L, 0, LEFT + 10_000L));
    }

    @Test
    public void anExcursionOutlastsTheTiming() {
        // Two minutes in the photo picker with a one minute timing: without
        // the excursion this return locks.
        assertTrue(warm(LEFT, LEFT + 120_000L, 60));
        assertFalse(excursion(LEFT, LEFT + 120_000L, 60, LEFT - 500L));
        // "Immediately" locks on every plain return and not on this one.
        assertTrue(warm(LEFT, LEFT + 1L, 0));
        assertFalse(excursion(LEFT, LEFT + 1L, 0, LEFT - 500L));
    }

    @Test
    public void anExcursionPastTheCapFallsBackToTheTiming() {
        long started = LEFT - 500L;
        // One millisecond past the cap. The app has been away 179.501 s.
        long now = started + 180_001L;
        assertTrue(excursion(LEFT, now, 0, started));
        assertTrue(excursion(LEFT, now, 60, started));
        // Fifteen minutes have not gone by, so the timing still lets it in.
        assertFalse(excursion(LEFT, now, 900, started));
        // Past the cap and past every timing.
        assertTrue(excursion(LEFT, LEFT + 900_000L, 900, started));
        assertTrue(excursion(LEFT, LEFT + 86_400_000L, 900, started));
        assertTrue(excursion(LEFT, Long.MAX_VALUE, 900, started));
    }

    @Test
    public void anExcursionWithANegativeStartDeltaFallsBackToTheTiming() {
        // The launch time reads later than now, which cannot be right.
        long now = LEFT + 10_000L;
        assertTrue(excursion(LEFT, now, 0, now + 1L));
        assertTrue(excursion(LEFT, now, 0, now + 3_600_000L));
        assertTrue(excursion(LEFT, now, 0, Long.MAX_VALUE));
        // No exemption means the timing decides: ten seconds away.
        assertFalse(excursion(LEFT, now, 60, now + 1L));
        assertFalse(excursion(LEFT, now, 900, Long.MAX_VALUE));
        assertTrue(excursion(LEFT, LEFT + 60_000L, 60, LEFT + 60_001L));
    }

    @Test
    public void anExcursionStartFarInThePastDoesNotOverflowIntoAnExemption() {
        // now minus a start this far back is too large for a long.
        assertTrue(excursion(LEFT, LEFT + 1L, 0, Long.MIN_VALUE));
        assertTrue(excursion(LEFT, Long.MAX_VALUE, 0, Long.MIN_VALUE));
        assertTrue(excursion(LEFT, Long.MAX_VALUE, 900, -1L));
        assertTrue(excursion(LEFT, LEFT + 60_000L, 60, Long.MIN_VALUE + 1L));
        // A start of zero is only a very old launch.
        assertTrue(excursion(LEFT, LEFT + 1L, 0, 0L));
    }

    @Test
    public void anExcursionTimeIsIgnoredWithoutTheExcursionFlag() {
        // A fresh launch time with the flag off exempts nothing.
        assertTrue(AppLockPolicy.shouldLock(true, false, LEFT, LEFT + 1L, 0, false, LEFT));
        assertTrue(
                AppLockPolicy.shouldLock(true, false, LEFT, LEFT + 60_000L, 60, false, LEFT - 1L));
    }

    // Rule 7: the time away against the timing.

    @Test
    public void immediatelyLocksOnEveryReturn() {
        assertTrue(warm(LEFT, LEFT, 0));
        assertTrue(warm(LEFT, LEFT + 1L, 0));
        assertTrue(warm(LEFT, LEFT + 1_000L, 0));
        assertTrue(warm(LEFT, LEFT + 86_400_000L, 0));
        assertTrue(warm(LEFT, Long.MAX_VALUE, 0));
    }

    @Test
    public void oneMinuteLocksOnceAMinuteHasGoneBy() {
        assertFalse(warm(LEFT, LEFT, 60));
        assertFalse(warm(LEFT, LEFT + 1L, 60));
        assertFalse(warm(LEFT, LEFT + 30_000L, 60));
        assertFalse(warm(LEFT, LEFT + 59_999L, 60));
        // Exactly at the timing locks.
        assertTrue(warm(LEFT, LEFT + 60_000L, 60));
        assertTrue(warm(LEFT, LEFT + 60_001L, 60));
        assertTrue(warm(LEFT, LEFT + 900_000L, 60));
    }

    @Test
    public void fifteenMinutesLocksOnceFifteenMinutesHaveGoneBy() {
        assertFalse(warm(LEFT, LEFT, 900));
        assertFalse(warm(LEFT, LEFT + 60_000L, 900));
        assertFalse(warm(LEFT, LEFT + 899_999L, 900));
        assertTrue(warm(LEFT, LEFT + 900_000L, 900));
        assertTrue(warm(LEFT, LEFT + 900_001L, 900));
    }

    @Test
    public void aPhoneThatSleptPastTheTimingLocks() {
        // The clock keeps counting through sleep, so eight hours asleep is
        // eight hours away, whatever the timing.
        long eightHours = 8L * 3_600_000L;
        for (int timeout : TIMEOUTS) {
            assertTrue("timeout " + timeout, warm(LEFT, LEFT + eightHours, timeout));
        }
        // An excursion does not save it either: the cap is long past.
        assertTrue(excursion(LEFT, LEFT + eightHours, 900, LEFT - 500L));
        // Clocks no phone has.
        assertTrue(warm(1L, Long.MAX_VALUE, 900));
        assertTrue(warm(LEFT, Long.MAX_VALUE, 60));
    }

    @Test
    public void theTimingHoldsAcrossTheWholeFirstHalfHour() {
        int checked = 0;
        for (int timeout : TIMEOUTS) {
            long limit = timeout * 1000L;
            for (long away = 0L; away <= 1_800_000L; away += 250L) {
                String row = "timeout " + timeout + " away " + away;
                assertEquals(row, away >= limit, warm(LEFT, LEFT + away, timeout));
                checked++;
            }
        }
        assertTrue("the walk must cover many returns, covered " + checked, checked > 20_000);
    }

    // The rule fed the way the activity feeds it.

    @Test
    public void aPhotoPickedInTwentySecondsComesBackUnlocked() {
        long launched = LEFT - 300L;
        long back = LEFT + 20_000L;
        assertFalse(AppLockPolicy.shouldLock(true, false, LEFT, back, 0, true, launched));
        // The next time the app leaves, the excursion is used up and
        // "Immediately" locks again.
        long leftAgain = back + 5_000L;
        assertTrue(warm(leftAgain, leftAgain + 2_000L, 0));
    }
}

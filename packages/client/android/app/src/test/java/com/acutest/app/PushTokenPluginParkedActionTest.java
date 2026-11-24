package com.acutest.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Host tests for {@link PushTokenPlugin#parkedActionFresh}, the rule that
 * decides whether a parked notification action may still answer a call or
 * show a ring.
 *
 * The rule is plain arithmetic on two clock readings. Calling it loads the
 * plugin class, whose static state is one executor and nothing from Android,
 * so it runs on the JVM as it is. No plugin is created here.
 *
 * The rule: fresh from the instant it is parked up to and including sixty
 * seconds later, stale from one millisecond after that, and stale whenever
 * the parking time is later than now. The numbers are written out, not read
 * from the class, so a changed limit fails here.
 */
public class PushTokenPluginParkedActionTest {
    private static void assertFresh(long parkedAtMs, long nowMs) {
        assertTrue(
                "must be fresh: parked " + parkedAtMs + ", now " + nowMs,
                PushTokenPlugin.parkedActionFresh(parkedAtMs, nowMs));
    }

    private static void assertStale(long parkedAtMs, long nowMs) {
        assertFalse(
                "must be stale: parked " + parkedAtMs + ", now " + nowMs,
                PushTokenPlugin.parkedActionFresh(parkedAtMs, nowMs));
    }

    /** Clock readings to park at, from boot to years of uptime. */
    private static final long[] PARKED_AT = {
        0L, 1L, 999L, 60_000L, 60_001L, 3_600_000L, 86_400_000L, 1_794_579_585_000L,
    };

    @Test
    public void theLimitIsSixtySeconds() {
        assertEquals(60_000L, PushTokenPlugin.PARKED_ACTION_MAX_AGE_MS);
    }

    @Test
    public void anActionReadTheInstantItIsParkedIsFresh() {
        for (long parkedAt : PARKED_AT) {
            assertFresh(parkedAt, parkedAt);
        }
    }

    @Test
    public void anActionIsFreshUpToAndIncludingSixtySeconds() {
        for (long parkedAt : PARKED_AT) {
            assertFresh(parkedAt, parkedAt + 1L);
            assertFresh(parkedAt, parkedAt + 30_000L);
            assertFresh(parkedAt, parkedAt + 59_999L);
            assertFresh(parkedAt, parkedAt + 60_000L);
        }
    }

    @Test
    public void anActionIsStaleOneMillisecondPastSixtySeconds() {
        for (long parkedAt : PARKED_AT) {
            assertStale(parkedAt, parkedAt + 60_001L);
            assertStale(parkedAt, parkedAt + 60_002L);
            assertStale(parkedAt, parkedAt + 120_000L);
            assertStale(parkedAt, parkedAt + 3_600_000L);
            assertStale(parkedAt, parkedAt + 86_400_000L);
        }
    }

    @Test
    public void aParkingTimeLaterThanNowIsStale() {
        for (long now : PARKED_AT) {
            assertStale(now + 1L, now);
            assertStale(now + 59_999L, now);
            assertStale(now + 60_000L, now);
            assertStale(now + 60_001L, now);
            assertStale(now + 86_400_000L, now);
        }
    }

    @Test
    public void readingsBelowZeroFollowTheSameRule() {
        // The clock never reads below zero, but the rule is only arithmetic.
        assertFresh(-1L, -1L);
        assertFresh(-60_000L, 0L);
        assertFresh(-30_000L, 30_000L);
        assertStale(-60_001L, 0L);
        assertStale(-30_000L, 30_001L);
        assertStale(0L, -1L);
        assertStale(-1L, -2L);
    }

    @Test
    public void theLargestReadingsFollowTheSameRule() {
        assertFresh(Long.MAX_VALUE, Long.MAX_VALUE);
        assertFresh(Long.MAX_VALUE - 60_000L, Long.MAX_VALUE);
        assertStale(Long.MAX_VALUE - 60_001L, Long.MAX_VALUE);
        assertStale(Long.MAX_VALUE, Long.MAX_VALUE - 1L);
        assertFresh(Long.MIN_VALUE, Long.MIN_VALUE);
        assertFresh(Long.MIN_VALUE, Long.MIN_VALUE + 60_000L);
        assertStale(Long.MIN_VALUE, Long.MIN_VALUE + 60_001L);
        assertStale(Long.MIN_VALUE + 1L, Long.MIN_VALUE);
    }

    @Test
    public void anAgeTooLargeForALongIsStale() {
        // now - parkedAt wraps around to a negative number in each of these.
        assertStale(Long.MIN_VALUE, Long.MAX_VALUE);
        assertStale(Long.MIN_VALUE, 0L);
        assertStale(Long.MIN_VALUE, 60_000L);
        assertStale(-1L, Long.MAX_VALUE);
        assertStale(-60_000L, Long.MAX_VALUE);
        assertStale(Long.MIN_VALUE + 60_000L, Long.MAX_VALUE);
    }

    @Test
    public void aParkingTimeFarAheadOfNowIsStaleEvenWhereTheAgeWrapsIntoRange() {
        // Long.MIN_VALUE - Long.MAX_VALUE wraps around to 1, an age that
        // would read as fresh. The two after it wrap around to 60,000.
        assertStale(Long.MAX_VALUE, Long.MIN_VALUE);
        assertStale(Long.MAX_VALUE, Long.MIN_VALUE + 59_999L);
        assertStale(Long.MAX_VALUE - 59_999L, Long.MIN_VALUE);
    }
}

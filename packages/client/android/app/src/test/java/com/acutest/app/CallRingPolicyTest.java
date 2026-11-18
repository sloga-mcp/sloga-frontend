package com.acutest.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Host tests for {@link CallRingPolicy}. The class is plain Java, so these run
 * on the JVM with nothing standing in for Android.
 *
 * The rules under test: a ring whose start is unknown always rings for the
 * full time, a ring is stale only once the clock is past its end, the time
 * left never leaves the range of one second to the full ring, and only a ring
 * that was showing and stopped unanswered counts as a missed call.
 *
 * The notifier decides with shouldDrop and shownMs, which allow for a phone
 * whose clock is off: a push is dropped only once the clock is two minutes
 * past the end of the ring, and a ring that is shown stays for fifteen
 * seconds or its whole length, whichever is shorter. A ring the notifier
 * wrote down is believed until five minutes past its end and no longer. The
 * numbers in these tests are written out, not read from the class, so a
 * changed constant fails here.
 */
public class CallRingPolicyTest {
    /** 2026-11-13T14:19:45Z, checked with `date -u -d 2026-11-13T14:19:45Z +%s`. */
    private static final long SAMPLE_MS = 1_794_579_585_000L;
    private static final long RING = 45_000L;
    /** Ring lengths across the range the server may advertise. */
    private static final long[] RINGS = {5_000L, 30_000L, 45_000L, 120_000L};

    // ringMs

    @Test
    public void ringMs_usesTheAdvertisedSecondsInsideTheRange() {
        assertEquals(5_000L, CallRingPolicy.ringMs("5"));
        assertEquals(30_000L, CallRingPolicy.ringMs("30"));
        assertEquals(45_000L, CallRingPolicy.ringMs("45"));
        assertEquals(120_000L, CallRingPolicy.ringMs("120"));
        assertEquals(30_000L, CallRingPolicy.ringMs("030"));
    }

    @Test
    public void ringMs_fallsBackOutsideTheRange() {
        assertEquals(45_000L, CallRingPolicy.DEFAULT_RING_MS);
        for (String outside : new String[] {
            "0", "1", "4", "121", "600", "86400", "99999999999999999999999999999999"
        }) {
            assertEquals(outside, CallRingPolicy.DEFAULT_RING_MS, CallRingPolicy.ringMs(outside));
        }
    }

    @Test
    public void ringMs_fallsBackWhenMissingOrUnparseable() {
        assertEquals(CallRingPolicy.DEFAULT_RING_MS, CallRingPolicy.ringMs(null));
        for (String bad : new String[] {
            "", " ", "abc", "-30", "+30", "30.5", "30.0", "3e1", "0x1E", " 30", "30 ", "30s",
            "thirty", "true", "\u0663\u0660"
        }) {
            assertEquals(bad, CallRingPolicy.DEFAULT_RING_MS, CallRingPolicy.ringMs(bad));
        }
    }

    // parseStartedAt

    @Test
    public void parseStartedAt_readsWholeSeconds() {
        assertEquals(SAMPLE_MS, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45Z"));
        assertEquals(0L, CallRingPolicy.parseStartedAt("1970-01-01T00:00:00Z"));
        assertEquals(1_000L, CallRingPolicy.parseStartedAt("1970-01-01T00:00:01Z"));
        // Checked with `date -u -d 2099-12-31T23:59:59Z +%s`.
        assertEquals(4_102_444_799_000L, CallRingPolicy.parseStartedAt("2099-12-31T23:59:59Z"));
    }

    @Test
    public void parseStartedAt_truncatesFractionsToMilliseconds() {
        assertEquals(SAMPLE_MS, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.000Z"));
        assertEquals(SAMPLE_MS + 123, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.123Z"));
        assertEquals(
                SAMPLE_MS + 123, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.123456Z"));
        assertEquals(
                SAMPLE_MS + 123, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.123456789Z"));
        // Shorter than three digits: the missing places are zeros.
        assertEquals(SAMPLE_MS + 100, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.1Z"));
        assertEquals(SAMPLE_MS + 120, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.12Z"));
        assertEquals(SAMPLE_MS + 7, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.007Z"));
        assertEquals(SAMPLE_MS, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.0Z"));
        // Dropped, not rounded: this must not become the next second.
        assertEquals(
                SAMPLE_MS + 999, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.999999999Z"));
        assertEquals(SAMPLE_MS, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.0009Z"));
        // Far more digits than any clock gives.
        assertEquals(
                SAMPLE_MS + 500,
                CallRingPolicy.parseStartedAt(
                        "2026-11-13T14:19:45.5000000000000000000000000000000000000009Z"));
    }

    @Test
    public void parseStartedAt_acceptsANumericUtcOffset() {
        assertEquals(SAMPLE_MS, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45+00:00"));
        assertEquals(
                SAMPLE_MS + 123, CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.123+00:00"));
        assertEquals(
                SAMPLE_MS + 123,
                CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.123456+00:00"));
    }

    @Test
    public void parseStartedAt_knowsLeapYears() {
        // Checked with `date -u -d ... +%s`.
        assertEquals(1_709_164_800_000L, CallRingPolicy.parseStartedAt("2024-02-29T00:00:00Z"));
        assertEquals(951_825_600_000L, CallRingPolicy.parseStartedAt("2000-02-29T12:00:00Z"));
        // The day after a leap day and the day after a plain February.
        assertEquals(
                1_709_164_800_000L + 86_400_000L,
                CallRingPolicy.parseStartedAt("2024-03-01T00:00:00Z"));
        assertEquals(
                CallRingPolicy.parseStartedAt("2026-02-28T00:00:00Z") + 86_400_000L,
                CallRingPolicy.parseStartedAt("2026-03-01T00:00:00Z"));
        assertEquals(-1L, CallRingPolicy.parseStartedAt("2026-02-29T00:00:00Z"));
        assertEquals(-1L, CallRingPolicy.parseStartedAt("2025-02-29T00:00:00Z"));
        // Divisible by 100 but not by 400.
        assertEquals(-1L, CallRingPolicy.parseStartedAt("2100-02-29T00:00:00Z"));
    }

    @Test
    public void parseStartedAt_agreesWithTheJdkAcrossManyInstants() {
        SimpleDateFormat seconds = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        SimpleDateFormat millis = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        SimpleDateFormat offset =
                new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'+00:00'", Locale.US);
        TimeZone utc = TimeZone.getTimeZone("UTC");
        seconds.setTimeZone(utc);
        millis.setTimeZone(utc);
        offset.setTimeZone(utc);

        // 2200-01-01T00:00:00Z. The step is a little over three days, so the
        // walk lands on every month, hour, minute, second and millisecond.
        long end = 7_258_118_400_000L;
        long step = 3L * 86_400_000L + 3_723_457L;
        int checked = 0;
        for (long t = 0; t < end; t += step) {
            Date date = new Date(t);
            String withMillis = millis.format(date);
            assertEquals(withMillis, t, CallRingPolicy.parseStartedAt(withMillis));
            String withOffset = offset.format(date);
            assertEquals(withOffset, t, CallRingPolicy.parseStartedAt(withOffset));
            String wholeSeconds = seconds.format(date);
            assertEquals(
                    wholeSeconds, t - t % 1000, CallRingPolicy.parseStartedAt(wholeSeconds));
            checked++;
        }
        assertTrue("the walk must cover many instants, covered " + checked, checked > 20_000);
    }

    @Test
    public void parseStartedAt_rejectsEverythingElse() {
        assertEquals(-1L, CallRingPolicy.parseStartedAt(null));
        for (String bad : new String[] {
            "",
            " ",
            "Z",
            "now",
            "null",
            // Epoch numbers are not what the server sends.
            "1794579585",
            "1794579585000",
            // Parts missing.
            "2026-11-13",
            "2026-11-13T14:19:45",
            "2026-11-13T14:19:45.123",
            "2026-11-13T14:19Z",
            "2026-11-13T14Z",
            "14:19:45Z",
            // Not UTC, or UTC written another way.
            "2026-11-13T14:19:45+02:00",
            "2026-11-13T14:19:45-05:00",
            "2026-11-13T14:19:45+00:01",
            "2026-11-13T14:19:45-00:00",
            "2026-11-13T14:19:45+0000",
            "2026-11-13T14:19:45+00",
            "2026-11-13T14:19:45 UTC",
            "2026-11-13T14:19:45GMT",
            "2026-11-13T14:19:45z",
            // Wrong separators.
            "2026-11-13 14:19:45Z",
            "2026-11-13t14:19:45Z",
            "2026/11/13T14:19:45Z",
            "2026-11-13T14.19.45Z",
            "2026-11-13T14:19:45,123Z",
            "20261113T141945Z",
            // Fields of the wrong width.
            "2026-1-13T14:19:45Z",
            "2026-11-3T14:19:45Z",
            "2026-11-13T4:19:45Z",
            "26-11-13T14:19:45Z",
            "12026-11-13T14:19:45Z",
            // A fraction with no digits, or with something else in it.
            "2026-11-13T14:19:45.Z",
            "2026-11-13T14:19:45.+00:00",
            "2026-11-13T14:19:45.12a4Z",
            "2026-11-13T14:19:45.-12Z",
            "2026-11-13T14:19:45.1.2Z",
            // Extra text around a good value.
            " 2026-11-13T14:19:45Z",
            "2026-11-13T14:19:45Z ",
            "2026-11-13T14:19:45ZZ",
            "2026-11-13T14:19:45Z+00:00",
            "2026-11-13T14:19:45.123Z\n",
            // Signs and letters where digits belong.
            "-026-11-13T14:19:45Z",
            "2026-+1-13T14:19:45Z",
            "2026-11-13T14:19:4xZ",
            "2O26-11-13T14:19:45Z",
            // Digits of another script.
            "\u0662\u0660\u0662\u0666-11-13T14:19:45Z",
        }) {
            assertEquals(bad, -1L, CallRingPolicy.parseStartedAt(bad));
        }
    }

    @Test
    public void parseStartedAt_rejectsOutOfRangeFields() {
        for (String bad : new String[] {
            "2026-00-13T14:19:45Z",
            "2026-13-13T14:19:45Z",
            "2026-11-00T14:19:45Z",
            "2026-11-31T14:19:45Z",
            "2026-04-31T14:19:45Z",
            "2026-06-31T14:19:45Z",
            "2026-09-31T14:19:45Z",
            "2026-01-32T14:19:45Z",
            "2026-12-32T14:19:45Z",
            "2026-02-30T14:19:45Z",
            "2026-11-13T24:00:00Z",
            "2026-11-13T25:19:45Z",
            "2026-11-13T14:60:45Z",
            "2026-11-13T14:19:60Z",
            "2026-11-13T14:19:61Z",
            "2026-11-13T99:99:99Z",
        }) {
            assertEquals(bad, -1L, CallRingPolicy.parseStartedAt(bad));
        }
        // The last valid value of each field is still read.
        assertEquals(
                SAMPLE_MS - 45_000L - 19 * 60_000L - 14 * 3_600_000L + 86_399_000L,
                CallRingPolicy.parseStartedAt("2026-11-13T23:59:59Z"));
        assertTrue(CallRingPolicy.parseStartedAt("2026-12-31T00:00:00Z") > SAMPLE_MS);
        assertTrue(CallRingPolicy.parseStartedAt("2026-01-31T00:00:00Z") > 0);
    }

    @Test
    public void parseStartedAt_rejectsStartsBefore1970() {
        // A negative answer could not be told apart from "unparseable".
        assertEquals(-1L, CallRingPolicy.parseStartedAt("1969-12-31T23:59:59Z"));
        assertEquals(-1L, CallRingPolicy.parseStartedAt("1969-12-31T23:59:59.999Z"));
        assertEquals(-1L, CallRingPolicy.parseStartedAt("1900-01-01T00:00:00Z"));
        assertEquals(-1L, CallRingPolicy.parseStartedAt("0000-01-01T00:00:00Z"));
        assertEquals(-1L, CallRingPolicy.parseStartedAt("0001-03-01T00:00:00Z"));
    }

    // isStale

    @Test
    public void isStale_unknownStartIsNeverStale() {
        assertFalse(CallRingPolicy.isStale(-1L, RING, SAMPLE_MS));
        assertFalse(CallRingPolicy.isStale(-1L, RING, Long.MAX_VALUE));
        assertFalse(CallRingPolicy.isStale(-1L, RING, 0L));
        assertFalse(CallRingPolicy.isStale(0L, RING, SAMPLE_MS));
        assertFalse(CallRingPolicy.isStale(Long.MIN_VALUE, RING, SAMPLE_MS));
        // Straight from the parser: an unusable "started_at" still rings.
        assertFalse(
                CallRingPolicy.isStale(CallRingPolicy.parseStartedAt(null), RING, SAMPLE_MS));
        assertFalse(
                CallRingPolicy.isStale(CallRingPolicy.parseStartedAt("soon"), RING, SAMPLE_MS));
    }

    @Test
    public void isStale_turnsStaleOnlyAfterTheRingTime() {
        assertFalse(CallRingPolicy.isStale(SAMPLE_MS, RING, SAMPLE_MS));
        assertFalse(CallRingPolicy.isStale(SAMPLE_MS, RING, SAMPLE_MS + 1));
        assertFalse(CallRingPolicy.isStale(SAMPLE_MS, RING, SAMPLE_MS + RING - 1));
        // Exactly at the end is not yet past it.
        assertFalse(CallRingPolicy.isStale(SAMPLE_MS, RING, SAMPLE_MS + RING));
        assertTrue(CallRingPolicy.isStale(SAMPLE_MS, RING, SAMPLE_MS + RING + 1));
        assertTrue(CallRingPolicy.isStale(SAMPLE_MS, RING, SAMPLE_MS + 3_600_000L));
        // The ring time decides, not the default.
        assertTrue(CallRingPolicy.isStale(SAMPLE_MS, 5_000L, SAMPLE_MS + 5_001L));
        assertFalse(CallRingPolicy.isStale(SAMPLE_MS, 120_000L, SAMPLE_MS + 119_999L));
        assertFalse(CallRingPolicy.isStale(SAMPLE_MS, 120_000L, SAMPLE_MS + RING + 1));
    }

    @Test
    public void isStale_aStartStillToComeIsNotStale() {
        // The phone's clock is behind the server's.
        assertFalse(CallRingPolicy.isStale(SAMPLE_MS, RING, SAMPLE_MS - 1));
        assertFalse(CallRingPolicy.isStale(SAMPLE_MS, RING, SAMPLE_MS - 3_600_000L));
        // Clocks no phone has: the answer must not flip through overflow.
        assertFalse(CallRingPolicy.isStale(SAMPLE_MS, RING, 0L));
        assertFalse(CallRingPolicy.isStale(SAMPLE_MS, RING, Long.MIN_VALUE));
        assertTrue(CallRingPolicy.isStale(SAMPLE_MS, RING, Long.MAX_VALUE));
    }

    // remainingMs

    @Test
    public void remainingMs_unknownStartRingsForTheFullTime() {
        assertEquals(RING, CallRingPolicy.remainingMs(-1L, RING, SAMPLE_MS));
        assertEquals(RING, CallRingPolicy.remainingMs(0L, RING, SAMPLE_MS));
        assertEquals(30_000L, CallRingPolicy.remainingMs(-1L, 30_000L, SAMPLE_MS));
        assertEquals(RING, CallRingPolicy.remainingMs(-1L, RING, Long.MAX_VALUE));
    }

    @Test
    public void remainingMs_countsDownFromTheStart() {
        assertEquals(RING, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS));
        assertEquals(RING - 1, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS + 1));
        assertEquals(35_000L, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS + 10_000L));
        assertEquals(1_001L, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS + 43_999L));
        assertEquals(1_000L, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS + 44_000L));
        assertEquals(
                110_000L, CallRingPolicy.remainingMs(SAMPLE_MS, 120_000L, SAMPLE_MS + 10_000L));
    }

    @Test
    public void remainingMs_isNeverBelowOneSecond() {
        assertEquals(1_000L, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS + 44_001L));
        assertEquals(1_000L, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS + RING - 1));
        assertEquals(1_000L, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS + RING));
        assertEquals(1_000L, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS + RING + 1));
        assertEquals(
                1_000L, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS + 3_600_000L));
    }

    @Test
    public void remainingMs_isNeverAboveTheRingTime() {
        // The phone's clock is behind the server's.
        assertEquals(RING, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS - 1));
        assertEquals(RING, CallRingPolicy.remainingMs(SAMPLE_MS, RING, SAMPLE_MS - 3_600_000L));
        assertEquals(5_000L, CallRingPolicy.remainingMs(SAMPLE_MS, 5_000L, SAMPLE_MS - 60_000L));
        // Clocks no phone has: the answer stays inside the range.
        assertEquals(RING, CallRingPolicy.remainingMs(SAMPLE_MS, RING, Long.MIN_VALUE));
        assertEquals(1_000L, CallRingPolicy.remainingMs(SAMPLE_MS, RING, Long.MAX_VALUE));
    }

    // shouldDrop

    @Test
    public void shouldDrop_theToleranceIsTwoMinutes() {
        assertEquals(120_000L, CallRingPolicy.CLOCK_TOLERANCE_MS);
    }

    @Test
    public void shouldDrop_unknownStartIsNeverDropped() {
        assertFalse(CallRingPolicy.shouldDrop(-1L, RING, SAMPLE_MS));
        assertFalse(CallRingPolicy.shouldDrop(-1L, RING, Long.MAX_VALUE));
        assertFalse(CallRingPolicy.shouldDrop(-1L, RING, 0L));
        assertFalse(CallRingPolicy.shouldDrop(0L, RING, SAMPLE_MS));
        assertFalse(CallRingPolicy.shouldDrop(Long.MIN_VALUE, RING, SAMPLE_MS));
        // Straight from the parser: the push's "started_at" may be empty.
        assertFalse(
                CallRingPolicy.shouldDrop(CallRingPolicy.parseStartedAt(null), RING, SAMPLE_MS));
        assertFalse(
                CallRingPolicy.shouldDrop(CallRingPolicy.parseStartedAt(""), RING, SAMPLE_MS));
    }

    @Test
    public void shouldDrop_onlyPastTheRingTimePlusTheTolerance() {
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, SAMPLE_MS));
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, SAMPLE_MS + 1));
        // Past the ring time alone is not enough.
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, SAMPLE_MS + RING + 1));
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, SAMPLE_MS + RING + 119_999L));
        // Exactly at the limit is not yet past it.
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, SAMPLE_MS + RING + 120_000L));
        assertTrue(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, SAMPLE_MS + RING + 120_001L));
        assertTrue(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, SAMPLE_MS + 3_600_000L));
        // The ring time decides, not the default.
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, 5_000L, SAMPLE_MS + 125_000L));
        assertTrue(CallRingPolicy.shouldDrop(SAMPLE_MS, 5_000L, SAMPLE_MS + 125_001L));
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, 120_000L, SAMPLE_MS + 240_000L));
        assertTrue(CallRingPolicy.shouldDrop(SAMPLE_MS, 120_000L, SAMPLE_MS + 240_001L));
        assertFalse(
                CallRingPolicy.shouldDrop(SAMPLE_MS, 120_000L, SAMPLE_MS + RING + 120_001L));
    }

    @Test
    public void shouldDrop_aStartStillToComeIsNeverDropped() {
        // The phone's clock is behind the server's, by a little or by a lot.
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, SAMPLE_MS - 1));
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, SAMPLE_MS - 165_001L));
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, SAMPLE_MS - 3_600_000L));
        // Clocks no phone has: the answer must not flip through overflow.
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, 0L));
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, Long.MIN_VALUE));
        assertTrue(CallRingPolicy.shouldDrop(SAMPLE_MS, RING, Long.MAX_VALUE));
    }

    @Test
    public void shouldDrop_aNonsenseRingLengthDoesNotOverflow() {
        // Adding the tolerance to a huge ring length must not wrap around to
        // a negative limit, which would drop every ring.
        assertFalse(
                CallRingPolicy.shouldDrop(SAMPLE_MS, Long.MAX_VALUE, SAMPLE_MS + 3_600_000L));
        assertFalse(CallRingPolicy.shouldDrop(SAMPLE_MS, Long.MAX_VALUE, Long.MAX_VALUE));
        assertFalse(
                CallRingPolicy.shouldDrop(
                        SAMPLE_MS, Long.MAX_VALUE - 1_000L, SAMPLE_MS + 3_600_000L));
    }

    // shownMs

    @Test
    public void shownMs_theShortestRingIsFifteenSeconds() {
        assertEquals(15_000L, CallRingPolicy.MIN_SHOWN_MS);
    }

    @Test
    public void shownMs_unknownStartShowsTheFullRing() {
        assertEquals(RING, CallRingPolicy.shownMs(-1L, RING, SAMPLE_MS));
        assertEquals(RING, CallRingPolicy.shownMs(0L, RING, SAMPLE_MS));
        assertEquals(30_000L, CallRingPolicy.shownMs(-1L, 30_000L, SAMPLE_MS));
        assertEquals(120_000L, CallRingPolicy.shownMs(-1L, 120_000L, Long.MAX_VALUE));
        assertEquals(5_000L, CallRingPolicy.shownMs(-1L, 5_000L, SAMPLE_MS));
        assertEquals(
                RING, CallRingPolicy.shownMs(CallRingPolicy.parseStartedAt(""), RING, SAMPLE_MS));
    }

    @Test
    public void shownMs_countsDownWithTheRing() {
        assertEquals(RING, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS));
        assertEquals(RING - 1, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS + 1));
        assertEquals(43_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS + 2_000L));
        assertEquals(35_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS + 10_000L));
        assertEquals(15_001L, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS + 29_999L));
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS + 30_000L));
        assertEquals(
                110_000L, CallRingPolicy.shownMs(SAMPLE_MS, 120_000L, SAMPLE_MS + 10_000L));
    }

    @Test
    public void shownMs_isNeverBelowTheShortestRing() {
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS + 30_001L));
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS + 44_000L));
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS + RING));
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS + RING + 1));
        // Late, but not late enough to be dropped: still long enough to notice.
        assertEquals(
                15_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS + RING + 120_000L));
        assertEquals(
                15_000L, CallRingPolicy.shownMs(SAMPLE_MS, 120_000L, SAMPLE_MS + 240_000L));
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, Long.MAX_VALUE));
    }

    @Test
    public void shownMs_isNeverAboveTheRingTime() {
        // A ring shorter than fifteen seconds is shown for its own length.
        assertEquals(5_000L, CallRingPolicy.shownMs(SAMPLE_MS, 5_000L, SAMPLE_MS));
        assertEquals(5_000L, CallRingPolicy.shownMs(SAMPLE_MS, 5_000L, SAMPLE_MS + 4_000L));
        assertEquals(5_000L, CallRingPolicy.shownMs(SAMPLE_MS, 5_000L, SAMPLE_MS + 60_000L));
        assertEquals(10_000L, CallRingPolicy.shownMs(SAMPLE_MS, 10_000L, SAMPLE_MS + 9_000L));
        assertEquals(14_000L, CallRingPolicy.shownMs(SAMPLE_MS, 14_000L, SAMPLE_MS + 1));
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, 15_000L, SAMPLE_MS + 14_000L));
        // The phone's clock is behind the server's.
        assertEquals(RING, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS - 1));
        assertEquals(RING, CallRingPolicy.shownMs(SAMPLE_MS, RING, SAMPLE_MS - 3_600_000L));
        assertEquals(RING, CallRingPolicy.shownMs(SAMPLE_MS, RING, Long.MIN_VALUE));
    }

    @Test
    public void shownMs_staysInsideItsRangeForEveryClock() {
        int checked = 0;
        for (long ring : new long[] {5_000L, 10_000L, 15_000L, 30_000L, 45_000L, 120_000L}) {
            long least = Math.min(15_000L, ring);
            // From ten minutes before the start to ten minutes after it.
            for (long offset = -600_000L; offset <= 600_000L; offset += 250L) {
                long shown = CallRingPolicy.shownMs(SAMPLE_MS, ring, SAMPLE_MS + offset);
                String row = "ring " + ring + " offset " + offset;
                assertTrue(row + " shown " + shown, shown >= least);
                assertTrue(row + " shown " + shown, shown <= ring);
                checked++;
            }
        }
        assertTrue("the walk must cover many clocks, covered " + checked, checked > 20_000);
    }

    // A phone whose clock is off. The push arrives one second after the ring
    // began, and the phone reads the time with its own clock.

    /** The phone's time at delivery, with its clock this far ahead (negative: behind). */
    private static long phoneClock(long aheadMs) {
        return SAMPLE_MS + 1_000L + aheadMs;
    }

    @Test
    public void aPhoneThirtySecondsAheadStillRings() {
        long now = phoneClock(30_000L);
        for (long ring : RINGS) {
            assertFalse("ring " + ring, CallRingPolicy.shouldDrop(SAMPLE_MS, ring, now));
        }
        // The phone believes 31 seconds have gone by.
        assertEquals(89_000L, CallRingPolicy.shownMs(SAMPLE_MS, 120_000L, now));
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, now));
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, 30_000L, now));
        assertEquals(5_000L, CallRingPolicy.shownMs(SAMPLE_MS, 5_000L, now));
    }

    @Test
    public void aPhoneSixtySecondsAheadStillRings() {
        long now = phoneClock(60_000L);
        // The exact rule calls the default ring over. This is the phone the
        // tolerance is for.
        assertTrue(CallRingPolicy.isStale(SAMPLE_MS, RING, now));
        for (long ring : RINGS) {
            assertFalse("ring " + ring, CallRingPolicy.shouldDrop(SAMPLE_MS, ring, now));
        }
        assertEquals(59_000L, CallRingPolicy.shownMs(SAMPLE_MS, 120_000L, now));
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, RING, now));
        assertEquals(15_000L, CallRingPolicy.shownMs(SAMPLE_MS, 30_000L, now));
        assertEquals(5_000L, CallRingPolicy.shownMs(SAMPLE_MS, 5_000L, now));
    }

    @Test
    public void aPhoneFiveMinutesAheadIsPastTheTolerance() {
        long now = phoneClock(300_000L);
        // Five minutes is more than any ring length plus the two minutes, so
        // the push reads as too old whatever the ring length. The notifier
        // then shows a missed call in place of the ring.
        for (long ring : RINGS) {
            assertTrue("ring " + ring, CallRingPolicy.shouldDrop(SAMPLE_MS, ring, now));
        }
    }

    @Test
    public void aPhoneThirtySecondsBehindRingsForTheFullTime() {
        long now = phoneClock(-30_000L);
        for (long ring : RINGS) {
            assertFalse("ring " + ring, CallRingPolicy.shouldDrop(SAMPLE_MS, ring, now));
            assertEquals("ring " + ring, ring, CallRingPolicy.shownMs(SAMPLE_MS, ring, now));
        }
    }

    @Test
    public void aPhoneSixtySecondsBehindRingsForTheFullTime() {
        long now = phoneClock(-60_000L);
        for (long ring : RINGS) {
            assertFalse("ring " + ring, CallRingPolicy.shouldDrop(SAMPLE_MS, ring, now));
            assertEquals("ring " + ring, ring, CallRingPolicy.shownMs(SAMPLE_MS, ring, now));
        }
    }

    @Test
    public void aPhoneFiveMinutesBehindRingsForTheFullTime() {
        long now = phoneClock(-300_000L);
        for (long ring : RINGS) {
            assertFalse("ring " + ring, CallRingPolicy.shouldDrop(SAMPLE_MS, ring, now));
            assertEquals("ring " + ring, ring, CallRingPolicy.shownMs(SAMPLE_MS, ring, now));
        }
    }

    // storedRingExpired

    @Test
    public void storedRingExpired_theGraceIsFiveMinutes() {
        assertEquals(300_000L, CallRingPolicy.STORED_RING_GRACE_MS);
    }

    @Test
    public void storedRingExpired_aRingIsBelievedUntilFiveMinutesPastItsEnd() {
        assertFalse(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS));
        assertFalse(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS + 1));
        // While it rings, at its end, and after it.
        assertFalse(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS + 20_000L));
        assertFalse(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS + RING));
        assertFalse(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS + RING + 1));
        assertFalse(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS + RING + 299_999L));
        // Exactly at the limit is not yet past it.
        assertFalse(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS + RING + 300_000L));
        assertTrue(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS + RING + 300_001L));
        assertTrue(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS + 86_400_000L));
        assertTrue(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, Long.MAX_VALUE));
        // The shown time counts, not the default ring.
        assertFalse(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, 15_000L, SAMPLE_MS + 315_000L));
        assertTrue(CallRingPolicy.storedRingExpired(SAMPLE_MS, 15_000L, SAMPLE_MS + 315_001L));
        assertFalse(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, 120_000L, SAMPLE_MS + 420_000L));
        assertTrue(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, 120_000L, SAMPLE_MS + 420_001L));
    }

    @Test
    public void storedRingExpired_aRingWrittenInTheFutureIsBelievedForFiveMinutesOnly() {
        // The phone's clock was set back after the ring was written.
        assertFalse(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS - 1));
        assertFalse(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS - 300_000L));
        assertTrue(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS - 300_001L));
        assertTrue(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS - 86_400_000L));
        // Clocks no phone has: the answer must not flip through overflow.
        assertTrue(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, 0L));
        assertTrue(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, Long.MIN_VALUE));
        assertTrue(CallRingPolicy.storedRingExpired(Long.MAX_VALUE, RING, Long.MIN_VALUE));
    }

    @Test
    public void storedRingExpired_aRingWithNoUsableTimeIsExpired() {
        assertTrue(CallRingPolicy.storedRingExpired(0L, RING, SAMPLE_MS));
        assertTrue(CallRingPolicy.storedRingExpired(-1L, RING, SAMPLE_MS));
        assertTrue(CallRingPolicy.storedRingExpired(Long.MIN_VALUE, RING, SAMPLE_MS));
        // Even with a clock that would make it look fresh.
        assertTrue(CallRingPolicy.storedRingExpired(0L, RING, 0L));
        assertTrue(CallRingPolicy.storedRingExpired(0L, RING, 1_000L));
        assertTrue(CallRingPolicy.storedRingExpired(-1L, RING, -1L));
    }

    @Test
    public void storedRingExpired_aDamagedShownTimeCannotKeepARingAlive() {
        // Too long is read as the longest ring there is, 120 seconds.
        assertFalse(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, Long.MAX_VALUE, SAMPLE_MS + 420_000L));
        assertTrue(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, Long.MAX_VALUE, SAMPLE_MS + 420_001L));
        assertTrue(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, 86_400_000L, SAMPLE_MS + 420_001L));
        // Below zero is read as zero.
        assertFalse(CallRingPolicy.storedRingExpired(SAMPLE_MS, -1L, SAMPLE_MS + 300_000L));
        assertTrue(CallRingPolicy.storedRingExpired(SAMPLE_MS, -1L, SAMPLE_MS + 300_001L));
        assertFalse(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, Long.MIN_VALUE, SAMPLE_MS + 300_000L));
        assertTrue(
                CallRingPolicy.storedRingExpired(SAMPLE_MS, Long.MIN_VALUE, SAMPLE_MS + 300_001L));
    }

    // isMissed

    @Test
    public void isMissed_nothingIsMissedWhenNoRingWasShowing() {
        for (String reason : new String[] {
            null, "", "cancelled", "ended", "timeout", "answered", "declined",
            "answered_elsewhere", "elsewhere", "something_new"
        }) {
            assertFalse(String.valueOf(reason), CallRingPolicy.isMissed(reason, false));
        }
    }

    @Test
    public void isMissed_aRingThatStoppedUnansweredIsMissed() {
        assertTrue(CallRingPolicy.isMissed(null, true));
        assertTrue(CallRingPolicy.isMissed("", true));
        assertTrue(CallRingPolicy.isMissed("cancelled", true));
        assertTrue(CallRingPolicy.isMissed("ended", true));
        assertTrue(CallRingPolicy.isMissed("timeout", true));
    }

    @Test
    public void isMissed_anAnsweredCallIsNotMissed() {
        assertFalse(CallRingPolicy.isMissed("answered", true));
        assertFalse(CallRingPolicy.isMissed("answered_elsewhere", true));
        assertFalse(CallRingPolicy.isMissed("elsewhere", true));
    }

    @Test
    public void isMissed_aDeclinedCallIsNotMissed() {
        assertFalse(CallRingPolicy.isMissed("declined", true));
    }

    @Test
    public void isMissed_anUnknownReasonIsNotMissed() {
        for (String reason : new String[] {
            "something_new", "busy", "Declined", "TIMEOUT", "Ended", " timeout", "timeout ",
            "cancelled\n", "canceled", "true", "null"
        }) {
            assertFalse(reason, CallRingPolicy.isMissed(reason, true));
        }
    }

    // title and isVideo

    @Test
    public void title_saysWhetherTheCallIsVideo() {
        assertEquals("Incoming call", CallRingPolicy.title(false));
        assertEquals("Incoming video call", CallRingPolicy.title(true));
    }

    @Test
    public void isVideo_onlyTheExactTextTrue() {
        assertTrue(CallRingPolicy.isVideo("true"));
        for (String notVideo : new String[] {
            null, "", "false", "TRUE", "True", " true", "true ", "1", "yes", "video"
        }) {
            assertFalse(String.valueOf(notVideo), CallRingPolicy.isVideo(notVideo));
        }
    }

    // The rules together, fed the way the notifier will feed them.

    @Test
    public void aLatePushIsDroppedAndAnEarlyOneRingsForWhatIsLeft() {
        long start = CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.250Z");
        long ring = CallRingPolicy.ringMs("30");
        assertEquals(SAMPLE_MS + 250, start);
        assertEquals(30_000L, ring);

        // Delivered two seconds in: 28 seconds of ringing are left.
        assertFalse(CallRingPolicy.isStale(start, ring, start + 2_000L));
        assertEquals(28_000L, CallRingPolicy.remainingMs(start, ring, start + 2_000L));

        // Delivered a minute in: the ring is over and nothing is shown.
        assertTrue(CallRingPolicy.isStale(start, ring, start + 60_000L));

        // No usable fields: the full default ring.
        long unknown = CallRingPolicy.parseStartedAt(null);
        long fallback = CallRingPolicy.ringMs(null);
        assertFalse(CallRingPolicy.isStale(unknown, fallback, start + 60_000L));
        assertEquals(45_000L, CallRingPolicy.remainingMs(unknown, fallback, start + 60_000L));
    }

    @Test
    public void aLatePushRingsInsideTheToleranceAndIsDroppedPastIt() {
        long start = CallRingPolicy.parseStartedAt("2026-11-13T14:19:45.250Z");
        long ring = CallRingPolicy.ringMs("30");

        // Delivered two seconds in: 28 seconds of ringing are left.
        assertFalse(CallRingPolicy.shouldDrop(start, ring, start + 2_000L));
        assertEquals(28_000L, CallRingPolicy.shownMs(start, ring, start + 2_000L));

        // Delivered a minute in. By the exact rule the ring is over, but the
        // phone's clock is not trusted that far, so it still rings.
        assertTrue(CallRingPolicy.isStale(start, ring, start + 60_000L));
        assertFalse(CallRingPolicy.shouldDrop(start, ring, start + 60_000L));
        assertEquals(15_000L, CallRingPolicy.shownMs(start, ring, start + 60_000L));

        // Delivered more than two minutes after the ring ended: dropped.
        assertFalse(CallRingPolicy.shouldDrop(start, ring, start + 150_000L));
        assertTrue(CallRingPolicy.shouldDrop(start, ring, start + 150_001L));

        // No usable fields: never dropped, and the full default ring.
        long unknown = CallRingPolicy.parseStartedAt("");
        long fallback = CallRingPolicy.ringMs(null);
        assertFalse(CallRingPolicy.shouldDrop(unknown, fallback, start + 3_600_000L));
        assertEquals(45_000L, CallRingPolicy.shownMs(unknown, fallback, start + 3_600_000L));
    }

    // The ring on the phone: the photo, the lock-screen flags, the Answer's
    // age, the ring alarm and the unlock check.

    @Test
    public void thePhotoGetsOneAndAHalfSecondsInAll() {
        long start = 1_000_000L;
        assertEquals(1_500L, CallRingPolicy.photoTimeLeftMs(start, start));
        assertEquals(501L, CallRingPolicy.photoTimeLeftMs(start, start + 999L));
        assertEquals(1L, CallRingPolicy.photoTimeLeftMs(start, start + 1_499L));
        assertEquals(0L, CallRingPolicy.photoTimeLeftMs(start, start + 1_500L));
        assertEquals(0L, CallRingPolicy.photoTimeLeftMs(start, start + 60_000L));
        // A clock that reads earlier than the start leaves nothing to wait.
        assertEquals(0L, CallRingPolicy.photoTimeLeftMs(start, start - 1L));
        // A difference too large for a long leaves nothing either.
        assertEquals(0L, CallRingPolicy.photoTimeLeftMs(Long.MIN_VALUE + 1L, Long.MAX_VALUE));
    }

    @Test
    public void onlyAnHttpsPhotoIsFetched() {
        assertTrue(CallRingPolicy.photoUrlAllowed("https://cdn.example/a.png"));
        assertFalse(CallRingPolicy.photoUrlAllowed("http://cdn.example/a.png"));
        assertFalse(CallRingPolicy.photoUrlAllowed("file:///sdcard/a.png"));
        assertFalse(CallRingPolicy.photoUrlAllowed(""));
        assertFalse(CallRingPolicy.photoUrlAllowed(null));
    }

    @Test
    public void theRingEndsWithItsAlarmAfterWaitingForThePhoto() {
        assertEquals(45_000L, CallRingPolicy.ringTimeoutAfterWaitMs(45_000L, 0L));
        // The full photo budget spent: a second and a half less.
        assertEquals(43_500L, CallRingPolicy.ringTimeoutAfterWaitMs(45_000L, 1_500L));
        assertEquals(13_500L, CallRingPolicy.ringTimeoutAfterWaitMs(15_000L, 1_500L));
        // A clock that went back counts as no wait.
        assertEquals(45_000L, CallRingPolicy.ringTimeoutAfterWaitMs(45_000L, -5L));
        // Never under a second.
        assertEquals(1_000L, CallRingPolicy.ringTimeoutAfterWaitMs(45_000L, 44_500L));
        assertEquals(1_000L, CallRingPolicy.ringTimeoutAfterWaitMs(45_000L, 45_000L));
        assertEquals(1_000L, CallRingPolicy.ringTimeoutAfterWaitMs(45_000L, Long.MAX_VALUE));
    }

    @Test
    public void theEndOfARingReachesOnlyItsOwnChat() {
        assertTrue(CallRingPolicy.ringResolutionApplies("01AAAA", "01AAAA"));
        // Another chat's waiting Answer, or another chat's ringing flags.
        assertFalse(CallRingPolicy.ringResolutionApplies("01AAAA", "01BBBB"));
        // Nothing held, or no chat named: nothing to drop.
        assertFalse(CallRingPolicy.ringResolutionApplies("01AAAA", null));
        assertFalse(CallRingPolicy.ringResolutionApplies(null, "01AAAA"));
        assertFalse(CallRingPolicy.ringResolutionApplies(null, null));
    }

    @Test
    public void theLockScreenFlagsLastTheRingsTimeLeftAndFiveSeconds() {
        long posted = SAMPLE_MS;
        assertEquals(50_000L, CallRingPolicy.ringFlagsHoldMs(posted, RING, posted));
        assertEquals(10_000L, CallRingPolicy.ringFlagsHoldMs(posted, RING, posted + 40_000L));
        assertEquals(5_001L, CallRingPolicy.ringFlagsHoldMs(posted, RING, posted + 44_999L));
        // The ring's time is up: the flags do not go on at all.
        assertEquals(-1L, CallRingPolicy.ringFlagsHoldMs(posted, RING, posted + 45_000L));
        assertEquals(-1L, CallRingPolicy.ringFlagsHoldMs(posted, RING, posted + 600_000L));
        // No usable ring.
        assertEquals(-1L, CallRingPolicy.ringFlagsHoldMs(0L, RING, posted));
        assertEquals(-1L, CallRingPolicy.ringFlagsHoldMs(posted, 0L, posted));
        // A clock set back counts as the moment of posting.
        assertEquals(50_000L, CallRingPolicy.ringFlagsHoldMs(posted, RING, posted - 60_000L));
        // A damaged shown time is held to the longest ring.
        assertEquals(125_000L, CallRingPolicy.ringFlagsHoldMs(posted, 600_000L, posted));
    }

    @Test
    public void anAnswersAgeCountsFromTheTapAcrossTheHoldAndTheSlot() {
        long tapped = 1_000_000L;
        // Held for 50 s waiting for the unlock, then parked.
        long parked = tapped + 50_000L;
        // Read from the slot 15 s later.
        long read = parked + 15_000L;
        assertEquals(tapped, CallRingPolicy.actionAgeFrom(tapped, parked));
        // 65 s since the tap: past the 60 s limit, although it sat in the
        // slot for only 15 s.
        assertTrue(read - CallRingPolicy.actionAgeFrom(tapped, parked) > 60_000L);
        assertTrue(read - parked <= 60_000L);
        // Not from a tap: the parking time.
        assertEquals(parked, CallRingPolicy.actionAgeFrom(0L, parked));
        assertEquals(parked, CallRingPolicy.actionAgeFrom(-1L, parked));
        // A tap after the parking cannot be right: the earlier of the two.
        assertEquals(parked, CallRingPolicy.actionAgeFrom(parked + 1L, parked));
    }

    @Test
    public void aRingAlarmMatchesItsRingByCallIdWhateverItsAge() {
        assertTrue(CallRingPolicy.timeoutMatches("CALL1", "CALL1"));
        assertFalse(CallRingPolicy.timeoutMatches("CALL1", "CALL2"));
        assertTrue(CallRingPolicy.timeoutMatches(null, "CALL2"));
        assertTrue(CallRingPolicy.timeoutMatches("CALL1", null));
        assertTrue(CallRingPolicy.timeoutMatches(null, null));
        // Ten minutes after it was posted the stored ring has expired for
        // every other reader, and an alarm the system held back that long
        // still belongs to it: the match takes no time at all.
        assertTrue(CallRingPolicy.storedRingExpired(SAMPLE_MS, RING, SAMPLE_MS + 600_000L));
    }

    @Test
    public void theRingAlarmIsExactOnlyBeforeAndroid8() {
        assertTrue(CallRingPolicy.useExactRingAlarm(24));
        assertTrue(CallRingPolicy.useExactRingAlarm(25));
        assertFalse(CallRingPolicy.useExactRingAlarm(26));
        assertFalse(CallRingPolicy.useExactRingAlarm(31));
        assertFalse(CallRingPolicy.useExactRingAlarm(36));
    }

    @Test
    public void aReportedUnlockIsCheckedAgainForFiveSeconds() {
        long reported = 2_000_000L;
        assertTrue(CallRingPolicy.unlockSettleKeepWaiting(reported, reported));
        assertTrue(CallRingPolicy.unlockSettleKeepWaiting(reported, reported + 4_999L));
        assertFalse(CallRingPolicy.unlockSettleKeepWaiting(reported, reported + 5_000L));
        // Any doubt gives the unlock up.
        assertFalse(CallRingPolicy.unlockSettleKeepWaiting(reported, reported - 1L));
        assertFalse(CallRingPolicy.unlockSettleKeepWaiting(Long.MIN_VALUE + 1L, Long.MAX_VALUE));
        assertEquals(100L, CallRingPolicy.UNLOCK_SETTLE_POLL_MS);
    }

    @Test
    public void theChatIdIsTheEndOfTheChannelPath() {
        assertEquals("01AAAA", CallRingPolicy.channelIdFromPath("/channel/01AAAA"));
        assertEquals(null, CallRingPolicy.channelIdFromPath(null));
    }
}

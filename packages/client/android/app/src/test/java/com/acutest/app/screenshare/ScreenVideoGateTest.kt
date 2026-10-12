package com.acutest.app.screenshare

import livekit.org.webrtc.VideoFrame
import livekit.org.webrtc.VideoProcessor
import livekit.org.webrtc.VideoSink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Host tests for [ScreenVideoGate], driven through its [ScreenVideoGate.admitWith] seam with plain
 * objects standing in for the SDK: `Any()` instances play the transceivers, a mutable supplier plays
 * the track's current-transceiver accessor, a second one plays the track's count of additional
 * senders, and a counting buffer backs a real [VideoFrame].
 *
 * The invariant under test: a frame reaches the sink only while the gate is admitted, not closed,
 * the supplier still returns the very transceiver the gate was admitted for, and the track has no
 * other sender. Every other state drops the frame, and the gate never changes the frame's reference
 * count (the caller owns it).
 */
class ScreenVideoGateTest {
    /** A frame buffer that only counts reference changes; any pixel access fails the test. */
    private class CountingBuffer : VideoFrame.Buffer {
        var retains = 0
        var releases = 0

        override fun getWidth(): Int = 16

        override fun getHeight(): Int = 16

        override fun toI420(): VideoFrame.I420Buffer = throw AssertionError("the gate must not read pixels")

        override fun retain() {
            retains++
        }

        override fun release() {
            releases++
        }

        override fun cropAndScale(
            cropX: Int,
            cropY: Int,
            cropWidth: Int,
            cropHeight: Int,
            scaleWidth: Int,
            scaleHeight: Int,
        ): VideoFrame.Buffer = throw AssertionError("the gate must not adapt frames")
    }

    /** A sink that records every frame it receives, without touching its reference count. */
    private class RecordingSink : VideoSink {
        val frames = mutableListOf<VideoFrame>()

        override fun onFrame(frame: VideoFrame) {
            frames.add(frame)
        }
    }

    /** The track's current transceiver as the gate sees it; tests reassign [value] mid-share. */
    private class Supplier(var value: Any?) {
        var reads = 0

        fun read(): Any? {
            reads++
            return value
        }
    }

    /**
     * The number of senders the track has besides its admitted transceiver; tests reassign [value]
     * mid-share, or set [failing] to make the read throw.
     */
    private class SenderCount(var value: Int) {
        var reads = 0
        var failing = false

        fun read(): Int {
            reads++
            if (failing) throw IllegalStateException("sender count unavailable")
            return value
        }
    }

    private val buffer = CountingBuffer()
    private val sink = RecordingSink()

    /** No extra sender; the tests that change it declare their own [SenderCount]. */
    private val extras = SenderCount(0)

    private fun frame(): VideoFrame = VideoFrame(buffer, 0, 0L)

    private fun gateWithSink(): ScreenVideoGate = ScreenVideoGate().also { it.setSink(sink) }

    private fun assertRejected(block: () -> Unit) {
        try {
            block()
        } catch (expected: IllegalStateException) {
            return
        }
        fail("expected IllegalStateException")
    }

    @Test
    fun startsClosedAndDropsFrames() {
        val gate = gateWithSink()

        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun admittedForTheCurrentTransceiverForwardsEachFrameOnce() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val gate = gateWithSink()

        gate.admitWith(transceiver, { current.read() }) { extras.read() }
        assertFalse("admission alone forwards nothing", gate.forwardedAny)
        val first = frame()
        gate.onFrameCaptured(first)

        assertEquals(1, sink.frames.size)
        assertSame(first, sink.frames[0])
        assertTrue(gate.forwardedAny)

        val second = frame()
        gate.onFrameCaptured(second)

        assertEquals(2, sink.frames.size)
        assertSame(second, sink.frames[1])
    }

    @Test
    fun readsTheSupplierOnEveryFrame() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val gate = gateWithSink()
        gate.admitWith(transceiver, { current.read() }) { extras.read() }
        val readsAfterAdmit = current.reads

        repeat(3) { gate.onFrameCaptured(frame()) }

        assertTrue(
            "each frame must re-read the current transceiver",
            current.reads - readsAfterAdmit >= 3,
        )
        assertEquals(3, sink.frames.size)
    }

    @Test
    fun dropsFramesOnceTheTrackMovesToAnotherTransceiver() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val gate = gateWithSink()
        gate.admitWith(transceiver, { current.read() }) { extras.read() }
        gate.onFrameCaptured(frame())
        assertEquals(1, sink.frames.size)

        current.value = Any()
        gate.onFrameCaptured(frame())
        gate.onFrameCaptured(frame())

        assertEquals(1, sink.frames.size)
    }

    @Test
    fun keepsDroppingEvenIfTheAdmittedTransceiverComesBack() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val gate = gateWithSink()
        gate.admitWith(transceiver, { current.read() }) { extras.read() }

        current.value = Any()
        gate.onFrameCaptured(frame())
        current.value = transceiver
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun dropsFramesWhenTheAccessorThrows() {
        val transceiver = Any()
        var failing = false
        val gate = gateWithSink()
        gate.admitWith(
            transceiver,
            {
                if (failing) throw IllegalStateException("accessor unavailable")
                transceiver
            },
        ) { extras.read() }

        failing = true
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun dropsFramesWhenTheTrackHasNoTransceiver() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val gate = gateWithSink()
        gate.admitWith(transceiver, { current.read() }) { extras.read() }

        current.value = null
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun closeDropsEveryLaterFrameAndIsIdempotent() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val gate = gateWithSink()
        gate.admitWith(transceiver, { current.read() }) { extras.read() }
        gate.onFrameCaptured(frame())
        assertEquals(1, sink.frames.size)

        gate.close()
        gate.onFrameCaptured(frame())
        assertEquals(1, sink.frames.size)

        gate.close()
        gate.onFrameCaptured(frame())
        assertEquals(1, sink.frames.size)

        // A sink attached after close receives nothing either.
        val later = RecordingSink()
        gate.setSink(later)
        gate.onFrameCaptured(frame())

        assertTrue(later.frames.isEmpty())
        assertEquals(1, sink.frames.size)
    }

    @Test
    fun closeBeforeAdmitIsIdempotent() {
        val gate = gateWithSink()

        gate.close()
        gate.close()
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun admitRejectsAMismatchedTransceiverAndStaysClosed() {
        val expected = Any()
        val current = Supplier(Any())
        val gate = gateWithSink()

        assertRejected { gate.admitWith(expected, { current.read() }) { extras.read() } }

        // Even once the supplier agrees, the refused admission must not have opened the gate.
        current.value = expected
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun admitRejectsAMissingTransceiverAndStaysClosed() {
        val expected = Any()
        val current = Supplier(null)
        val gate = gateWithSink()

        assertRejected { gate.admitWith(expected, { current.read() }) { extras.read() } }
        current.value = expected
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun admitRejectsATrackWithAnotherSenderAndStaysClosed() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val senders = SenderCount(1)
        val gate = gateWithSink()

        assertRejected { gate.admitWith(transceiver, { current.read() }) { senders.read() } }
        assertTrue("admission must read the sender count", senders.reads >= 1)

        // Even once the extra sender is gone, the refused admission must not have opened the gate.
        senders.value = 0
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun admitFailsClosedWhenTheSenderCountCannotBeRead() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val senders = SenderCount(0).apply { failing = true }
        val gate = gateWithSink()

        var threw = false
        try {
            gate.admitWith(transceiver, { current.read() }) { senders.read() }
        } catch (expected: Exception) {
            threw = true
        }
        assertTrue("admission must not succeed without a sender count", threw)

        senders.failing = false
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun secondAdmitIsRejected() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val gate = gateWithSink()
        gate.admitWith(transceiver, { current.read() }) { extras.read() }

        assertRejected { gate.admitWith(transceiver, { current.read() }) { extras.read() } }
    }

    @Test
    fun secondAdmitCannotRetargetTheGate() {
        val first = Any()
        val second = Any()
        val current = Supplier(first)
        val gate = gateWithSink()
        gate.admitWith(first, { current.read() }) { extras.read() }

        current.value = second
        assertRejected { gate.admitWith(second, { current.read() }) { extras.read() } }
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun admitAfterCloseIsRejected() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val gate = gateWithSink()
        gate.close()

        assertRejected { gate.admitWith(transceiver, { current.read() }) { extras.read() } }
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun readsTheSenderCountOnEveryFrame() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val senders = SenderCount(0)
        val gate = gateWithSink()
        gate.admitWith(transceiver, { current.read() }) { senders.read() }
        val readsAfterAdmit = senders.reads

        repeat(3) { gate.onFrameCaptured(frame()) }

        assertTrue(
            "each frame must re-read the sender count",
            senders.reads - readsAfterAdmit >= 3,
        )
        assertEquals(3, sink.frames.size)
    }

    @Test
    fun dropsFramesForGoodOnceTheTrackGainsAnotherSender() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val senders = SenderCount(0)
        val gate = gateWithSink()
        gate.admitWith(transceiver, { current.read() }) { senders.read() }
        gate.onFrameCaptured(frame())
        assertEquals(1, sink.frames.size)

        senders.value = 1
        gate.onFrameCaptured(frame())
        assertEquals(1, sink.frames.size)

        // The extra sender going away again does not reopen the gate.
        senders.value = 0
        gate.onFrameCaptured(frame())
        gate.onFrameCaptured(frame())

        assertEquals(1, sink.frames.size)
        assertEquals(0, buffer.retains)
        assertEquals(0, buffer.releases)
    }

    @Test
    fun dropsFramesForGoodWhenTheSenderCountThrows() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val senders = SenderCount(0)
        val gate = gateWithSink()
        gate.admitWith(transceiver, { current.read() }) { senders.read() }
        gate.onFrameCaptured(frame())
        assertEquals(1, sink.frames.size)

        senders.failing = true
        gate.onFrameCaptured(frame())
        assertEquals(1, sink.frames.size)

        // A later read that returns 0 again does not reopen the gate.
        senders.failing = false
        gate.onFrameCaptured(frame())

        assertEquals(1, sink.frames.size)
        assertEquals(0, buffer.retains)
        assertEquals(0, buffer.releases)
    }

    @Test
    fun noSinkDropsFramesWithoutFailing() {
        val transceiver = Any()
        val current = Supplier(transceiver)
        val gate = ScreenVideoGate()
        gate.admitWith(transceiver, { current.read() }) { extras.read() }

        gate.onFrameCaptured(frame())
        assertFalse(gate.forwardedAny)

        gate.setSink(sink)
        gate.setSink(null)
        gate.onFrameCaptured(frame())

        assertTrue(sink.frames.isEmpty())
        assertFalse(gate.forwardedAny)
    }

    @Test
    fun neverChangesTheFrameReferenceCount() {
        val transceiver = Any()
        val current = Supplier(null)
        val gate = gateWithSink()

        gate.onFrameCaptured(frame())
        current.value = transceiver
        gate.admitWith(transceiver, { current.read() }) { extras.read() }
        gate.onFrameCaptured(frame())
        current.value = Any()
        gate.onFrameCaptured(frame())
        current.value = null
        gate.onFrameCaptured(frame())
        current.value = transceiver
        gate.close()
        gate.onFrameCaptured(frame())

        assertEquals(1, sink.frames.size)
        assertEquals(0, buffer.retains)
        assertEquals(0, buffer.releases)
    }

    @Test
    fun leavesFrameAdaptationToTheDefaultTwoArgumentPath() {
        val overrides =
            ScreenVideoGate::class.java.declaredMethods.filter {
                it.name == "onFrameCaptured" && it.parameterTypes.size == 2
            }

        assertTrue(VideoProcessor::class.java.isAssignableFrom(ScreenVideoGate::class.java))
        assertTrue(
            "the two-argument onFrameCaptured must keep its default (adapt, forward, release)",
            overrides.isEmpty(),
        )
    }
}

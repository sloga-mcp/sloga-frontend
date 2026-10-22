package com.acutest.app.screenshare

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Host tests for [ScreenAudioSenderGate], driven through its [ScreenAudioSenderGate.admitWith] seam
 * with plain objects standing in for the SDK: `Any()` instances play the transceiver and the
 * publication, and two counting suppliers play the track's current-transceiver accessor and the
 * participant's current screen-audio publication.
 *
 * The invariant under test: [ScreenAudioSenderGate.allows] is true only after one successful
 * admission, and only while both reads still return the very transceiver and publication that were
 * admitted. Before admission it is false and changes nothing; after admission the first mismatch,
 * absence or failed read ends the gate for good, and no later admission opens it again.
 */
class ScreenAudioSenderGateTest {
    /** A current-value read as the gate sees it; tests reassign [value] or set [failing] mid-share. */
    private class Supplier(var value: Any?) {
        var reads = 0
        var failing = false

        fun read(): Any? {
            reads++
            if (failing) throw IllegalStateException("read unavailable")
            return value
        }
    }

    private val transceiver = Any()
    private val publication = Any()
    private val currentTransceiver = Supplier(transceiver)
    private val currentPublication = Supplier(publication)

    private fun admit(gate: ScreenAudioSenderGate): Boolean =
        gate.admitWith(transceiver, { currentTransceiver.read() }, publication) {
            currentPublication.read()
        }

    private fun admittedGate(): ScreenAudioSenderGate =
        ScreenAudioSenderGate().also { assertTrue("the matching admission must succeed", admit(it)) }

    @Test
    fun startsUnadmittedAndRefusesAudio() {
        val gate = ScreenAudioSenderGate()

        assertFalse(gate.allows())
        assertFalse(gate.allows())
    }

    @Test
    fun readsNothingBeforeAnAdmissionExists() {
        val gate = ScreenAudioSenderGate()

        repeat(3) { assertFalse(gate.allows()) }

        assertEquals(0, currentTransceiver.reads)
        assertEquals(0, currentPublication.reads)
    }

    @Test
    fun refusingBeforeAdmissionDoesNotEndTheGate() {
        val gate = ScreenAudioSenderGate()
        repeat(3) { assertFalse(gate.allows()) }

        assertTrue("a later matching admission must still succeed", admit(gate))
        assertTrue(gate.allows())
    }

    @Test
    fun matchingAdmissionAllowsEveryBuffer() {
        val gate = ScreenAudioSenderGate()

        assertTrue(admit(gate))
        repeat(3) { assertTrue(gate.allows()) }
    }

    @Test
    fun readsBothCurrentValuesOnEveryBuffer() {
        val gate = admittedGate()
        val transceiverReads = currentTransceiver.reads
        val publicationReads = currentPublication.reads

        repeat(3) { assertTrue(gate.allows()) }

        // Every buffer re-reads both values while they still match
        assertEquals(3, currentTransceiver.reads - transceiverReads)
        assertEquals(3, currentPublication.reads - publicationReads)
    }

    @Test
    fun endsForGoodWhenTheTrackMovesToAnotherTransceiver() {
        val gate = admittedGate()
        assertTrue(gate.allows())

        currentTransceiver.value = Any()
        assertFalse(gate.allows())

        currentTransceiver.value = transceiver
        assertFalse("the admitted transceiver coming back must not reopen the gate", gate.allows())
        assertFalse(gate.allows())
    }

    @Test
    fun endsForGoodWhenTheTrackHasNoTransceiver() {
        val gate = admittedGate()

        currentTransceiver.value = null
        assertFalse(gate.allows())

        currentTransceiver.value = transceiver
        assertFalse(gate.allows())
    }

    @Test
    fun endsForGoodWhenTheTransceiverCannotBeRead() {
        val gate = admittedGate()

        currentTransceiver.failing = true
        assertFalse(gate.allows())

        currentTransceiver.failing = false
        assertFalse(gate.allows())
    }

    @Test
    fun endsForGoodWhenThePublicationIsGone() {
        val gate = admittedGate()

        currentPublication.value = null
        assertFalse(gate.allows())

        currentPublication.value = publication
        assertFalse(gate.allows())
    }

    @Test
    fun endsForGoodWhenThePublicationIsReplaced() {
        val gate = admittedGate()
        assertTrue(gate.allows())

        currentPublication.value = Any()
        assertFalse(gate.allows())

        currentPublication.value = publication
        assertFalse("the admitted publication coming back must not reopen the gate", gate.allows())
    }

    @Test
    fun endsForGoodWhenThePublicationCannotBeRead() {
        val gate = admittedGate()

        currentPublication.failing = true
        assertFalse(gate.allows())

        currentPublication.failing = false
        assertFalse(gate.allows())
    }

    @Test
    fun admitRejectsAnotherTransceiverAndRecordsNothing() {
        val gate = ScreenAudioSenderGate()
        currentTransceiver.value = Any()

        assertFalse(admit(gate))
        currentTransceiver.value = transceiver
        assertFalse("a refused admission must not open the gate", gate.allows())

        // Nothing was recorded, so a matching admission still succeeds
        assertTrue(admit(gate))
        assertTrue(gate.allows())
    }

    @Test
    fun admitRejectsATrackWithNoTransceiver() {
        val gate = ScreenAudioSenderGate()
        currentTransceiver.value = null

        assertFalse(admit(gate))
        currentTransceiver.value = transceiver
        assertFalse(gate.allows())
    }

    @Test
    fun admitRejectsAnotherPublicationAndRecordsNothing() {
        val gate = ScreenAudioSenderGate()
        currentPublication.value = Any()

        assertFalse(admit(gate))
        currentPublication.value = publication
        assertFalse("a refused admission must not open the gate", gate.allows())

        assertTrue(admit(gate))
        assertTrue(gate.allows())
    }

    @Test
    fun admitRejectsAParticipantWithNoPublication() {
        val gate = ScreenAudioSenderGate()
        currentPublication.value = null

        assertFalse(admit(gate))
        currentPublication.value = publication
        assertFalse(gate.allows())
    }

    @Test
    fun admitReturnsFalseWhenEitherReadFails() {
        val gate = ScreenAudioSenderGate()

        currentTransceiver.failing = true
        assertFalse(admit(gate))
        currentTransceiver.failing = false

        currentPublication.failing = true
        assertFalse(admit(gate))
        currentPublication.failing = false

        assertFalse("a refused admission must not open the gate", gate.allows())
        assertTrue(admit(gate))
        assertTrue(gate.allows())
    }

    @Test
    fun secondAdmitIsRejectedWhileTheFirstHolds() {
        val gate = admittedGate()
        val otherTransceiver = Any()
        val otherPublication = Any()

        assertFalse(
            gate.admitWith(otherTransceiver, { otherTransceiver }, otherPublication) {
                otherPublication
            },
        )
        assertFalse(admit(gate))

        assertTrue("the first admission still governs", gate.allows())
    }

    @Test
    fun secondAdmitCannotRetargetTheGate() {
        val gate = admittedGate()
        val otherTransceiver = Any()
        val otherPublication = Any()
        currentTransceiver.value = otherTransceiver
        currentPublication.value = otherPublication

        assertFalse(
            gate.admitWith(otherTransceiver, { currentTransceiver.read() }, otherPublication) {
                currentPublication.read()
            },
        )

        assertFalse("the first admission still governs and no longer matches", gate.allows())
        currentTransceiver.value = transceiver
        currentPublication.value = publication
        assertFalse(gate.allows())
    }

    @Test
    fun admitAfterTheGateEndedIsRejected() {
        val gate = admittedGate()
        currentPublication.value = Any()
        assertFalse(gate.allows())

        currentPublication.value = publication
        assertFalse(admit(gate))

        val fresh = Any()
        assertFalse(gate.admitWith(fresh, { fresh }, publication) { publication })
        assertFalse(gate.allows())
    }
}

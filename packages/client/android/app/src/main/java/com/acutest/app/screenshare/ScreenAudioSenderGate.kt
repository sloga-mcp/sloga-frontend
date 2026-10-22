package com.acutest.app.screenshare

import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalTrackPublication
import io.livekit.android.room.track.Track
import livekit.org.webrtc.RtpTransceiver

/**
 * The per-buffer sender check of the screen audio source.
 *
 * Captured audio may reach the buffer only while the sender admitted behind
 * the witness is still the track's sender and its publication is still the
 * participant's screen-audio publication. Both are compared by identity with
 * what [admit] accepted, through the same reads [admit] checked
 * ([ScreenTrackAccess.audioTransceiverOf] and
 * `LocalParticipant.getTrackPublication(Track.Source.SCREEN_SHARE_AUDIO)`).
 *
 * Guarantees:
 *  - It starts unadmitted: [allows] is false until [admit] succeeds, and a
 *    call to [allows] before that changes nothing.
 *  - [admit] succeeds at most once, and only if the track's current sender is
 *    the given transceiver and the participant's current screen-audio
 *    publication is the given publication. A rejected [admit] records nothing.
 *  - After admission, any mismatch, absence or failure to read either one ends
 *    the gate for good: [allows] is false from then on, even if the admitted
 *    sender and publication later come back, and no later [admit] succeeds.
 *
 * Threads: [admit] runs on Main; [allows] is called from the audio record
 * thread for every buffer. [allows] is cheap and non-blocking: it takes no
 * lock, reads two volatile fields and the two accessors, and never throws.
 *
 * It holds nothing and owns nothing: the plugin owns the track, its
 * publication and their lifetimes.
 */
class ScreenAudioSenderGate {

    /** What [admitWith] accepted: the sender, the publication and the reads for both. */
    private class Admission(
        val expected: Any,
        val current: () -> Any?,
        val expectedPublication: Any,
        val currentPublication: () -> Any?,
    )

    @Volatile
    private var admission: Admission? = null

    /** Terminal: set by the first [allows] call that finds another sender or publication. */
    @Volatile
    private var ended = false

    /**
     * Admits the gate once, on Main, after the witness for [transceiver].
     * True only if the current transceiver of [track]
     * ([ScreenTrackAccess.audioTransceiverOf]) is [transceiver] itself and the
     * current screen-audio publication of [participant] is [publication]
     * itself. Otherwise, when already admitted or ended, or when either read
     * throws, it returns false and records nothing.
     */
    fun admit(
        track: LocalAudioTrack,
        transceiver: RtpTransceiver,
        participant: LocalParticipant,
        publication: LocalTrackPublication,
    ): Boolean = admitWith(
        transceiver,
        { ScreenTrackAccess.audioTransceiverOf(track) },
        publication,
        { participant.getTrackPublication(Track.Source.SCREEN_SHARE_AUDIO) },
    )

    /** [admit] with the checks unchanged and the reads supplied (unit tests). */
    @Synchronized
    internal fun admitWith(
        expected: Any,
        current: () -> Any?,
        expectedPublication: Any,
        currentPublication: () -> Any?,
    ): Boolean {
        if (ended || admission != null) return false
        if (!sameSender(expected, current, expectedPublication, currentPublication)) return false
        admission = Admission(expected, current, expectedPublication, currentPublication)
        return true
    }

    /**
     * Audio record thread, once per buffer. True only when admitted, not
     * ended, and both reads still return the admitted sender and publication.
     * Before admission it is false and records nothing; after admission the
     * first mismatch, absence or failed read ends the gate for good.
     */
    fun allows(): Boolean {
        // The admission is read before either supplier is called
        val admitted = admission ?: return false
        if (ended) return false
        if (!sameSender(
                admitted.expected,
                admitted.current,
                admitted.expectedPublication,
                admitted.currentPublication,
            )
        ) {
            ended = true
            return false
        }
        return true
    }

    /** True only if both reads return the expected objects; any throw counts as false. */
    private fun sameSender(
        expected: Any,
        current: () -> Any?,
        expectedPublication: Any,
        currentPublication: () -> Any?,
    ): Boolean = try {
        current() === expected && currentPublication() === expectedPublication
    } catch (_: Throwable) {
        false
    }
}

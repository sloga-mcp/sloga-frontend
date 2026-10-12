package com.acutest.app.screenshare

import io.livekit.android.room.track.LocalVideoTrack
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.VideoFrame
import livekit.org.webrtc.VideoProcessor
import livekit.org.webrtc.VideoSink

/**
 * The screen track's [VideoProcessor], and with it the only path from the
 * screen capturer to the track's video source:
 * `LocalScreencastVideoTrack.createTrack` installs it with
 * `VideoSource.setVideoProcessor`, so every captured frame passes through
 * [onFrameCaptured]. The video source feeds EVERY sender of the track, so the
 * gate forwards only while the track is on the admitted transceiver and the
 * SDK has recorded no additional transceiver for it. What keeps additional
 * senders from being added at all is the plugin's sender-layout check before
 * [admit]; the per-frame read is a backstop.
 *
 * Guarantees:
 *  - It starts closed. Nothing is forwarded until [admit] succeeds. With
 *    E2EE, the plugin admits only after the screen sender's frame cryptor is
 *    witnessed at the current key index (`ScreenSharePlugin.doConnect`).
 *  - After admission a frame reaches the video source only while the track
 *    is still on the transceiver that was admitted AND has no additional
 *    transceiver recorded, both read on every frame through the same accessors
 *    [admit] checked ([ScreenTrackAccess.transceiverOf],
 *    [ScreenTrackAccess.extraTransceiverCountOf]). The first frame that finds
 *    another transceiver, none (a republish onto a new transceiver, or an
 *    unpublish that removes it), or an additional transceiver ends the
 *    gate: every later frame is dropped for
 *    good, even if the SDK later restores the admitted layout (a failed
 *    publish can restore the previous transceiver,
 *    `LocalParticipant.publishTrackImpl`).
 *  - [close] is terminal: after it nothing is ever forwarded again.
 *
 * Frame ownership: the gate never retains or releases a frame. It implements
 * only the one-argument [onFrameCaptured]; the interface's two-argument
 * default (the form `VideoSource` calls) applies the crop/scale/drop
 * adaptation, passes the adapted frame here and releases it afterwards.
 *
 * Threads: frames arrive on the capture thread, [admit] and [close] run on
 * Main, and `VideoSource` calls [setSink] under its processor lock. All state
 * lives in volatile fields, and [close] only writes a flag, so it never
 * blocks.
 *
 * It never touches a frame cryptor and never disposes anything: the plugin
 * owns the track, its cryptor and their lifetimes.
 */
class ScreenVideoGate : VideoProcessor {

    /** What [admitWith] accepted: the transceiver and the accessors for the track's senders. */
    private class Admission(
        val expected: Any,
        val current: () -> Any?,
        val extraSenders: () -> Int,
    )

    private val admitLock = Any()

    /**
     * Terminal: set by [close], or by the first frame that finds another
     * transceiver or an additional sender.
     */
    @Volatile
    private var ended = false

    @Volatile
    private var admission: Admission? = null

    @Volatile
    private var sink: VideoSink? = null

    /** True once at least one frame reached the sink. */
    @Volatile
    var forwardedAny: Boolean = false
        private set

    /**
     * Admits the gate once, after the sender's frame cryptor was witnessed for
     * [transceiver] (with E2EE). Re-reads the track's current transceiver
     * through [ScreenTrackAccess.transceiverOf], the accessor every frame uses,
     * and throws [IllegalStateException] unless it is [transceiver] itself, so
     * a broken accessor fails the connect instead of producing a blank share.
     * Also throws when the track has any additional sender transceiver
     * ([ScreenTrackAccess.extraTransceiverCountOf] is not 0), or when already
     * admitted or closed. On a throw the gate stays unadmitted.
     */
    fun admit(track: LocalVideoTrack, transceiver: RtpTransceiver) {
        admitWith(
            transceiver,
            { ScreenTrackAccess.transceiverOf(track) },
            { ScreenTrackAccess.extraTransceiverCountOf(track) },
        )
    }

    /** [admit] with the checks unchanged and the track accessors supplied (unit tests). */
    internal fun admitWith(expected: Any, current: () -> Any?, extraSenders: () -> Int) {
        synchronized(admitLock) {
            check(!ended) { "screen video gate is closed" }
            check(admission == null) { "screen video gate is already admitted" }
            val now = current()
            checkNotNull(now) { "screen track has no transceiver" }
            check(now === expected) { "screen track is on another transceiver" }
            val extras = extraSenders()
            check(extras == 0) { "screen track has $extras additional sender transceiver(s)" }
            admission = Admission(expected, current, extraSenders)
        }
    }

    /** Idempotent and terminal; safe on Main (writes one flag, takes no lock). */
    fun close() {
        ended = true
    }

    // VideoSource reports the capturer state to its native source itself;
    // the gate is the end of the chain and has nothing to pass on.
    override fun onCapturerStarted(started: Boolean) {}

    override fun onCapturerStopped() {}

    override fun setSink(sink: VideoSink?) {
        this.sink = sink
    }

    /**
     * Capture thread. Forwards [frame] to the sink only when admitted, not
     * closed, the track is still on the admitted transceiver and it has no
     * additional sender; otherwise drops it, and a changed sender layout ends
     * the gate. The caller owns [frame].
     */
    override fun onFrameCaptured(frame: VideoFrame) {
        if (ended) return
        val admitted = admission ?: return
        if (!singleAdmittedSender(admitted)) {
            ended = true
            return
        }
        val target = sink ?: return
        target.onFrame(frame)
        if (!forwardedAny) forwardedAny = true
    }

    /**
     * True only while the track is on the admitted transceiver and has no
     * other sender. Any throw from either accessor counts as false.
     */
    private fun singleAdmittedSender(admitted: Admission): Boolean {
        val now = try {
            admitted.current()
        } catch (_: Exception) {
            null
        }
        if (now == null || now !== admitted.expected) return false
        val extras = try {
            admitted.extraSenders()
        } catch (_: Exception) {
            return false
        }
        return extras == 0
    }
}

package com.acutest.app.screenshare

import android.annotation.SuppressLint
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.annotation.RequiresApi
import com.getcapacitor.Plugin
import com.getcapacitor.annotation.CapacitorPlugin
import io.livekit.android.audio.AudioBufferCallback
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max

/**
 * The screen leg's SYSTEM AUDIO source (Android screen-share slice 4, plan
 * Design 4-5): the phone's playback audio (games, video), captured through
 * AudioPlaybackCapture and handed to the leg's audio track one ADM buffer at
 * a time.
 *
 * Wiring (done by the plugin): the leg's JavaAudioDeviceModule has its own
 * microphone record DISABLED (setAudioRecordEnabled(false)), so the ADM never
 * opens a mic AudioRecord and the phone's call mic in the WebView is never
 * touched. In that mode the ADM record thread still loops, zeroes its
 * buffer, and calls this callback with it; whatever this writes into the
 * buffer is what the audio track sends (through the leg's sender frame
 * cryptor under E2EE).
 *
 * Why not the SDK's ScreenAudioCapturer: it is final, it cannot tell "not
 * initialized" from "failed", it retries its init on every buffer, it MIXES
 * rather than replaces, and it does not exclude our own UID. This class owns
 * its own playback-capture AudioRecord instead.
 *
 * Behaviour:
 *  - the AudioRecord is built LAZILY, on the first [onBuffer] call (the ADM
 *    record thread), with the format, channel count and sample rate the ADM
 *    passes. One attempt only: any failure latches FAILED for good;
 *  - the capture matches USAGE_MEDIA, USAGE_GAME and USAGE_UNKNOWN and
 *    EXCLUDES this app's UID, so Sloga's own sounds never loop back into the
 *    share. The call itself plays as USAGE_VOICE_COMMUNICATION, which
 *    playback capture can never match; the UID exclusion is the second wall;
 *  - the GATE starts CLOSED. Closed: the capture is still read (so stale
 *    audio queued in the AudioRecord is drained and never released when the
 *    gate opens) and the buffer is zeroed. Open: the captured audio REPLACES
 *    the buffer. The plugin opens the gate only once the sender cryptor is
 *    witnessed holding the current key (or right after publish without
 *    E2EE), so nothing real is sent in the pre-cryptor window;
 *  - PACING: with the mic record disabled, the ADM loop calls this with no
 *    sleep of its own and would spin a core. A call that did a full blocking
 *    read was already paced by the read; any other call (gate closed with no
 *    capture yet, FAILED, released) sleeps to a deadline one buffer after
 *    the previous call returned. See [pace];
 *  - [onFailure] runs AT MOST ONCE, on the record thread, only while the
 *    gate is open, and never once [release] has started. A failure that
 *    latches while the gate is closed is held back and delivered on the
 *    first open-gate buffer after it, so a capture that died before the
 *    witness still reaches the sharer as a toast rather than as a silent
 *    "live" share. The callback must not block and must never wait on the
 *    Main thread: it runs under [lock], and [release] on Main takes [lock]
 *    (the plugin only posts it to Main, which is fine).
 *
 * Threading: [onBuffer] runs on the ADM record thread only. [openGate],
 * [closeGate] and [release] are called from Main; they are idempotent,
 * non-suspending, and never wait on a read. [release] can wait on [lock]
 * for at most one AudioRecord construction (a bounded audioserver IPC), and
 * only if it races the very first buffer. The ADM keeps calling [onBuffer]
 * after [release] until the leg Room disconnects (the plugin never clears
 * the callback, which would re-arm the busy loop); those calls pace zeros.
 *
 * The constructor never throws and does no I/O. Hygiene: audio only, no key
 * material passes through here, and logs carry states and error codes only.
 *
 * It implements BOTH callback interfaces, whose single method has the same
 * JVM signature: the pinned contract names the WebRTC ADM interface, while
 * LocalAudioTrack.setAudioBufferCallback (livekit-android 2.28.0) takes the
 * SDK's own io.livekit.android.audio.AudioBufferCallback.
 */
@RequiresApi(Build.VERSION_CODES.Q)
class ScreenAudioSource(
    private val projection: MediaProjection,
    private val onFailure: () -> Unit,
) : JavaAudioDeviceModule.AudioBufferCallback, AudioBufferCallback {

    /** Guards [record] publication and release, the init, the [released]
     *  transition and the [onFailure] delivery. Never held across a read or
     *  a pacing sleep. */
    private val lock = Any()

    /** Set from Main by [openGate] / [closeGate] / [release]. Starts CLOSED:
     *  nothing captured is sent until the plugin's E2EE witness passes. */
    @Volatile
    private var gateOpen = false

    /** Terminal. Written only under [lock]. */
    @Volatile
    private var released = false

    /** Terminal. Written only by the record thread. */
    @Volatile
    private var failed = false

    /** Written only under [lock]. */
    @Volatile
    private var failureDelivered = false

    /** Written only under [lock]; read lock-free by the record thread, which
     *  may therefore hold a reference that [release] has just stopped (see
     *  [release] for why that is safe). */
    @Volatile
    private var record: AudioRecord? = null

    // Record-thread state. Volatile only for the hand-off between successive
    // ADM record threads (the ADM starts a new thread per recording session).
    @Volatile
    private var initAttempted = false
    @Volatile
    private var readBuf: ByteBuffer? = null
    @Volatile
    private var zeros = ByteArray(0)
    @Volatile
    private var nextDeadlineNs = 0L

    // The ADM format the AudioRecord was built for; a later buffer in another
    // format would be filled with mis-shaped audio, so it fails instead.
    // Written in initRecord before the volatile write of [record], read only
    // after a volatile read of it, so they need no volatile of their own.
    private var builtEncoding = 0
    private var builtChannels = 0
    private var builtRate = 0

    /** Open the gate: captured audio replaces the buffer from the next
     *  buffer on. No effect once released. */
    fun openGate() {
        gateOpen = true
        // Re-check AFTER the write: [release] sets [released] and then clears
        // the gate, so either this sees released, or release's clear lands
        // after this write. Either way a released source ends gate-closed.
        if (released) gateOpen = false
    }

    /** Close the gate: zeros from the next buffer on (the capture keeps
     *  being drained). Holds back any failure until the gate reopens. */
    fun closeGate() {
        gateOpen = false
    }

    /**
     * Close the gate for good, suppress any later [onFailure], and STOP and
     * release the AudioRecord before returning, so the playback-capture
     * client is gone before the plugin stops the MediaProjection.
     *
     * The record thread may be blocked in AudioRecord.read on that record
     * when this runs. Calling stop() from here is the designed way out:
     * AudioRecord.stop() interrupts the client proxy, so a blocked read
     * returns early (a short count, or 0) instead of being waited for, and
     * the JNI read holds its own strong reference to the native record, so a
     * release() from this thread cannot free it under the read; a read
     * started afterwards gets ERROR_INVALID_OPERATION. The SDK's own
     * ScreenAudioCapturer.releaseAudioResources relies on the same thing (it
     * releases from the app's thread while onBufferRequest reads without its
     * lock). [onBuffer] treats any error or short count after [released] as
     * "released", never as a failure. Holding [lock] across the read instead
     * would make Main wait out a read, and a wedged read would be an ANR.
     */
    fun release() {
        gateOpen = false
        val rec = synchronized(lock) {
            released = true
            val r = record
            record = null
            r
        }
        gateOpen = false
        stopAndRelease(rec)
    }

    override fun onBuffer(
        buffer: ByteBuffer,
        audioFormat: Int,
        channelCount: Int,
        sampleRate: Int,
        bytesRead: Int,
        captureTimeNs: Long,
    ): Long {
        val capacity = buffer.capacity()
        val durationNs = bufferDurationNs(capacity, audioFormat, channelCount, sampleRate)
        var blocked = false
        try {
            blocked = produce(buffer, capacity, audioFormat, channelCount, sampleRate)
        } catch (e: Exception) {
            // Nothing may escape onto the ADM thread: an uncaught throw there
            // takes the whole app (and the WebView call) down.
            // blocked stays false: at worst one extra paced sleep.
            latchFailure("unexpected " + e.javaClass.simpleName)
            zeroFill(buffer, capacity)
        }
        deliverFailureIfDue()
        if (blocked) {
            // The read paced this buffer. Never sleep after it (that would
            // halve the rate); just anchor the next deadline in case the
            // next call has no read to block on.
            nextDeadlineNs = SystemClock.elapsedRealtimeNanos() + durationNs
        } else {
            pace(durationNs)
        }
        // Follow the SDK's MixerAudioBufferCallback convention: pass the
        // ADM's timestamp through. With the mic record disabled it is 0,
        // which the ADM reads as "not available".
        return captureTimeNs
    }

    /**
     * Fill [buffer]; returns true only if a FULL blocking read happened in
     * this call (the only case that is already paced).
     */
    private fun produce(
        buffer: ByteBuffer,
        capacity: Int,
        audioFormat: Int,
        channelCount: Int,
        sampleRate: Int,
    ): Boolean {
        if (!initAttempted) {
            initAttempted = true
            initRecord(capacity, audioFormat, channelCount, sampleRate)
        }
        val rec = record
        val scratch = readBuf
        if (rec == null || scratch == null) {
            zeroFill(buffer, capacity)
            return false
        }
        if (normalizeEncoding(audioFormat) != builtEncoding ||
            channelCount != builtChannels ||
            sampleRate != builtRate ||
            capacity != scratch.capacity()
        ) {
            latchFailure("ADM format changed")
            zeroFill(buffer, capacity)
            return false
        }
        // AudioRecord.read into a direct buffer writes from offset 0 and
        // leaves the position alone.
        val got = rec.read(scratch, capacity, AudioRecord.READ_BLOCKING)
        if (got < 0) {
            // After release() this is the stopped/released record answering;
            // otherwise the capture is dead (projection stopped, audioserver
            // died, permission revoked).
            if (!released) latchFailure("read " + got)
            zeroFill(buffer, capacity)
            return false
        }
        if (gateOpen && !released) {
            // REPLACE, never mix: the ADM buffer is zeros in mic-off mode,
            // but nothing of it is kept either way.
            buffer.clear()
            scratch.clear()
            scratch.limit(got)
            buffer.put(scratch)
            if (got < capacity) buffer.put(zerosOf(capacity), 0, capacity - got)
            buffer.position(0)
            scratch.clear()
        } else {
            // Gate closed: the read above was the drain; send silence.
            zeroFill(buffer, capacity)
        }
        // A short read (stop() racing, or an overrun) did not block for a
        // whole buffer, so it is paced like any other non-blocking call.
        return got == capacity
    }

    /**
     * Build and start the playback-capture AudioRecord, once, on the record
     * thread, under [lock] so a racing [release] either prevents it or finds
     * it published. Any failure latches FAILED (never retried).
     *
     * The format, channel mask and buffer sizing follow LiveKit's
     * ScreenAudioCapturer.initAudioRecord (livekit-android 2.28.0,
     * io/livekit/android/audio/ScreenAudioCapturer.kt, Copyright 2024-2026
     * LiveKit, Inc., Apache License 2.0). Changes from it: the match rules
     * add excludeUid, the read size is the ADM buffer's own capacity (it is
     * copied into that buffer one to one), and the record must reach
     * STATE_INITIALIZED.
     *
     * RECORD_AUDIO: the plugin checks it before building this source; a
     * permission revoked since then surfaces here as a throw, caught below
     * and latched as FAILED, hence the MissingPermission suppression.
     */
    @SuppressLint("MissingPermission")
    private fun initRecord(capacity: Int, audioFormat: Int, channelCount: Int, sampleRate: Int) {
        var why: String? = null
        synchronized(lock) {
            if (released) return
            val encoding = normalizeEncoding(audioFormat)
            val bytesPerSample = bytesPerSample(encoding)
            val bytesPerFrame = channelCount * bytesPerSample
            if (channelCount != 1 && channelCount != 2) {
                why = "unsupported channel count " + channelCount
            } else if (bytesPerSample <= 0) {
                why = "unsupported encoding " + audioFormat
            } else if (sampleRate <= 0 || capacity <= 0 || capacity % bytesPerFrame != 0) {
                why = "bad ADM buffer " + capacity + " at " + sampleRate
            } else {
                val channelMask = if (channelCount == 1) {
                    AudioFormat.CHANNEL_IN_MONO
                } else {
                    AudioFormat.CHANNEL_IN_STEREO
                }
                var built: AudioRecord? = null
                try {
                    val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelMask, encoding)
                    if (minBufferSize <= 0) {
                        why = "getMinBufferSize " + minBufferSize
                    } else {
                        val config = AudioPlaybackCaptureConfiguration.Builder(projection)
                            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                            .addMatchingUsage(AudioAttributes.USAGE_GAME)
                            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                            .excludeUid(Process.myUid())
                            .build()
                        val made: AudioRecord = AudioRecord.Builder()
                            .setAudioFormat(
                                AudioFormat.Builder()
                                    .setEncoding(encoding)
                                    .setSampleRate(sampleRate)
                                    .setChannelMask(channelMask)
                                    .build(),
                            )
                            .setBufferSizeInBytes(max(BUFFER_SIZE_FACTOR * minBufferSize, capacity))
                            .setAudioPlaybackCaptureConfig(config)
                            .build()
                        built = made
                        if (made.state != AudioRecord.STATE_INITIALIZED) {
                            why = "state " + made.state
                        } else {
                            made.startRecording()
                            if (made.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                                why = "recordingState " + made.recordingState
                            }
                        }
                    }
                } catch (e: Exception) {
                    // SecurityException (no RECORD_AUDIO), UnsupportedOperation
                    // (device or projection refused), IllegalState (start).
                    why = "init " + e.javaClass.simpleName
                }
                if (why != null || built == null) {
                    if (why == null) why = "no record"
                    stopAndRelease(built)
                } else {
                    val scratch = ByteBuffer.allocateDirect(capacity).order(ByteOrder.nativeOrder())
                    builtEncoding = encoding
                    builtChannels = channelCount
                    builtRate = sampleRate
                    readBuf = scratch
                    record = built
                    Log.i(TAG, "capture started rate=" + sampleRate + " ch=" + channelCount)
                }
            }
        }
        val reason = why
        if (reason != null) latchFailure(reason)
    }

    /** Latch FAILED (record thread only): stop and drop the capture, and
     *  leave delivery to [deliverFailureIfDue]. From here on every buffer is
     *  zeros, paced. */
    private fun latchFailure(why: String) {
        if (failed) return
        failed = true
        Log.w(TAG, "screen audio capture failed: " + why)
        val rec = synchronized(lock) {
            val r = record
            record = null
            r
        }
        stopAndRelease(rec)
    }

    /** Deliver a latched failure at most once, only with the gate open, and
     *  never once [release] has taken [lock]: the check and the call are
     *  both under it. */
    private fun deliverFailureIfDue() {
        if (!failed || failureDelivered || !gateOpen || released) return
        synchronized(lock) {
            if (released || failureDelivered || !gateOpen) return
            failureDelivered = true
            try {
                onFailure()
            } catch (e: Exception) {
                Log.w(TAG, "onFailure threw " + e.javaClass.simpleName)
            }
        }
    }

    /**
     * Deadline pacing for a call that did not block on a full read.
     *
     * [nextDeadlineNs] is the earliest time this call may return. It advances
     * by one buffer per call, so the average rate is exact even though each
     * sleep is rounded. A call that arrives less than one buffer late returns
     * at once and keeps the cadence; one that is more than a buffer late (or
     * the first call, with the deadline still 0) re-anchors to now, so a
     * stall never turns into a catch-up burst. By construction the wait is
     * never longer than one buffer.
     *
     * An interrupt restores the flag and returns. The ADM never interrupts
     * its record thread (it stops it with a keep-alive flag and an
     * uninterruptible join), so that path is defensive only.
     */
    private fun pace(durationNs: Long) {
        val now = SystemClock.elapsedRealtimeNanos()
        var deadline = nextDeadlineNs
        if (now - deadline > durationNs) deadline = now
        nextDeadlineNs = deadline + durationNs
        val waitNs = minOf(deadline - now, durationNs)
        if (waitNs <= 0L) return
        try {
            Thread.sleep(waitNs / NS_PER_MS, (waitNs % NS_PER_MS).toInt())
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun zeroFill(buffer: ByteBuffer, capacity: Int) {
        buffer.clear()
        buffer.put(zerosOf(capacity), 0, capacity)
        buffer.position(0)
    }

    private fun zerosOf(capacity: Int): ByteArray {
        if (zeros.size < capacity) zeros = ByteArray(capacity)
        return zeros
    }

    companion object {
        private const val TAG = "ScreenAudioSource"

        /** As in the SDK's ScreenAudioCapturer: the AudioRecord's own buffer
         *  is twice the platform minimum (or one ADM buffer, if larger). */
        private const val BUFFER_SIZE_FACTOR = 2

        private const val NS_PER_MS = 1_000_000L

        /** The ADM's buffer is 10 ms (WebRtcAudioRecord: sampleRate / 100
         *  frames). Used when the arguments cannot give a duration. */
        private const val DEFAULT_BUFFER_NS = 10L * NS_PER_MS
        private const val MIN_BUFFER_NS = 1L * NS_PER_MS
        private const val MAX_BUFFER_NS = 50L * NS_PER_MS

        /** ENCODING_DEFAULT means 16-bit PCM (the SDK's callback contract). */
        private fun normalizeEncoding(audioFormat: Int): Int =
            if (audioFormat == AudioFormat.ENCODING_DEFAULT) AudioFormat.ENCODING_PCM_16BIT else audioFormat

        /** Bytes per sample, or 0 for an encoding this does not capture. */
        private fun bytesPerSample(encoding: Int): Int = when (encoding) {
            AudioFormat.ENCODING_PCM_8BIT -> 1
            AudioFormat.ENCODING_PCM_16BIT -> 2
            AudioFormat.ENCODING_PCM_FLOAT -> 4
            else -> 0
        }

        /**
         * One buffer's playing time, from its byte size and format rather
         * than a hard-coded 10 ms, in case an ADM buffers differently. The
         * ADM's bytesRead argument is 0 with the mic record disabled, so the
         * buffer's CAPACITY (what the ADM sends) is what counts. Falls back to
         * 10 ms for arguments that give no sane duration.
         */
        private fun bufferDurationNs(capacity: Int, audioFormat: Int, channelCount: Int, sampleRate: Int): Long {
            val bytesPerFrame = channelCount * bytesPerSample(normalizeEncoding(audioFormat))
            if (bytesPerFrame <= 0 || sampleRate <= 0 || capacity <= 0) return DEFAULT_BUFFER_NS
            val ns = (capacity / bytesPerFrame).toLong() * 1_000_000_000L / sampleRate
            return if (ns in MIN_BUFFER_NS..MAX_BUFFER_NS) ns else DEFAULT_BUFFER_NS
        }

        private fun stopAndRelease(rec: AudioRecord?) {
            if (rec == null) return
            try {
                rec.stop()
            } catch (_: Exception) {
                // IllegalStateException: never started, or already released.
            }
            try {
                rec.release()
            } catch (e: Exception) {
                Log.w(TAG, "AudioRecord.release threw " + e.javaClass.simpleName)
            }
        }
    }
}

/**
 * Empty CAPABILITY MARKER for screen-share system audio. MainActivity
 * registers it only on API 29+ (AudioPlaybackCapture), before
 * super.onCreate, so its presence in the plugin header IS the answer: JS
 * reads Capacitor.isPluginAvailable("ScreenShareAudio") synchronously at
 * module load and never calls into it.
 *
 * It must never gain methods that JS calls at load: @capacitor/android 8.4.x
 * can lose the reply to the first native call after a WebView reload
 * (screen-leg plan wave 4h), which is exactly why the capability is a
 * header lookup and not an isAvailable() round trip.
 */
@CapacitorPlugin(name = "ScreenShareAudio")
class ScreenShareAudioPlugin : Plugin()

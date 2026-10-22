package com.acutest.app.screenshare;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import io.livekit.android.room.track.LocalAudioTrack;
import io.livekit.android.room.track.LocalVideoTrack;
import livekit.org.webrtc.RtpTransceiver;

/**
 * Reads local tracks' transceivers for {@link ScreenVideoGate} and
 * {@link ScreenAudioSenderGate}.
 *
 * livekit-android keeps {@code LocalVideoTrack.transceiver} and
 * {@code LocalVideoTrack.simulcastTransceivers} Kotlin-internal, so Kotlin code
 * outside the SDK cannot name them. The compiled accessors are public with a
 * module-mangled name, and Java can call them directly. Keeping the calls in
 * Java makes them compile-time references: if an SDK upgrade renames or removes
 * an accessor, the app stops compiling instead of the gate failing at runtime.
 */
public final class ScreenTrackAccess {
    private ScreenTrackAccess() {}

    /**
     * The track's current transceiver, read through the SDK's internal accessor.
     *
     * Null before the track's first publish. The SDK clears it when the track is
     * unpublished while the engine is connected; an unpublish in any other engine
     * connection state, and the preparation for a full reconnect, leave the old
     * transceiver set. So null does not mean "unpublished" and non-null does not
     * mean "published". A republish assigns a new transceiver object, so callers
     * compare the result by identity with the transceiver they checked.
     */
    @Nullable
    public static RtpTransceiver transceiverOf(@NonNull LocalVideoTrack track) {
        return track.getTransceiver$livekit_android_sdk_release();
    }

    /**
     * How many transceivers the track has besides {@link #transceiverOf}: the
     * ones the SDK creates for additional codecs, each with its own sender of
     * the same track. Zero means the SDK has recorded no additional
     * transceiver; one it is still creating is not counted yet, so callers
     * use this as a backstop, not as the guarantee.
     *
     * The SDK builds the list from a map it does not synchronize, so a call off
     * the SDK's thread can throw while the SDK changes it; callers treat a throw
     * the same as a non-zero count.
     */
    public static int extraTransceiverCountOf(@NonNull LocalVideoTrack track) {
        return track.getSimulcastTransceivers$livekit_android_sdk_release().size();
    }

    /**
     * The audio track's current transceiver, read through the SDK's internal
     * accessor.
     *
     * Null before the track's first publish. Unlike {@link #transceiverOf} for
     * a video track, it is never cleared by an unpublish: it changes only when
     * a publish assigns a new transceiver, or when a failed publish restores
     * the previous value (the earlier transceiver, or null). So non-null does
     * not mean published. Callers compare the result by identity with the
     * transceiver they checked, and read the track's publication separately.
     */
    @Nullable
    public static RtpTransceiver audioTransceiverOf(@NonNull LocalAudioTrack track) {
        return track.getTransceiver$livekit_android_sdk_release();
    }
}

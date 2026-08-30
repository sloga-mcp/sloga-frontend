package com.acutest.app.screenshare

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.core.app.NotificationCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.e2ee.E2EEState
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import livekit.org.webrtc.FrameCryptor
import livekit.org.webrtc.RtpParameters

/**
 * The native SCREEN LEG publisher (Android screen-share plan §4) — a SECOND
 * LiveKit participant, `{user_id}:{device_id}:screen`, publishing only the
 * MediaProjection capture and subscribing to nothing. The WebView cannot do
 * this itself: no Android web runtime exposes `getDisplayMedia`, and a native
 * capture cannot cross into the WebView's sealed WebRTC stack as a track.
 *
 * TWO-PHASE by design (§4.2): `prepare()` runs the OS consent dialog (which is
 * user-paced and easily outlives the 10 s leg token), THEN the JS side mints
 * the token, THEN `connect()` uses it immediately. The single-use
 * `getMediaProjection()` only happens inside the SDK's track start at publish
 * time, so a failed `connect()` does not burn the consent (probe (e)).
 *
 * E2EE is FAIL-CLOSED, witnessed rather than assumed (§0.4 / §0-R.5):
 *  - the raw-byte key provider is built with `discardFrameWhenCryptorNotReady
 *    = true`, so nothing — not plaintext, not garbage — leaves the phone
 *    before the sender cryptor holds the key (probe (c-i): zero frames over
 *    12 s with no key);
 *  - publish happens only after the E2EE manager reports enabled AND the send
 *    key + key index are installed;
 *  - any sender cryptor state other than OK disconnects the leg (the
 *    manager's own observer surfaces them as `TrackE2EEStateEvent`s);
 *  - `setFrameKey` resolves only after `setKey` AND `setKeyIndex` land on
 *    every sender cryptor — libwebrtc's `setKey` alone does NOT move the
 *    sender's index (§0-R.6, empirical in probe (c-iii)), and a rotation that
 *    silently kept encrypting under the removed member's key is exactly the
 *    hole this contract closes.
 *
 * Hygiene (§4.2): key material is held only inside the native key provider
 * (dropped in [tearDown] via `dispose()`), never logged, and never echoed
 * back through resolve/reject/events.
 */
@CapacitorPlugin(name = "ScreenShare")
class ScreenSharePlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /** The MediaProjection consent, between `prepare()` and first publish. */
    private var consentIntent: Intent? = null

    private var room: Room? = null
    /** The Room the last [tearDown] CLAIMED responsibility for releasing —
     *  set before it touches it, not after. Lets a connect attempt that was
     *  cancelled mid-flight tell "a teardown owns my Room's release" from
     *  "a successor owns `room` now, and mine is unreleased": reaching the
     *  abandon path looks identical otherwise, and guessing wrong means
     *  either a double native dispose or a ghost participant left on the
     *  SFU. */
    private var releasedRoom: Room? = null
    private var keyProvider: RawScreenKeyProvider? = null
    private var legIdentity: String? = null
    private var currentKeyIndex: Int = 0
    private var eventsJob: Job? = null

    /** Set while [tearDown] runs so event handlers do not double-report. */
    private var stopping = false

    /**
     * Cancellation for [doConnect] — the native mirror of the JS generation
     * token, which stops at the bridge. Every [tearDown] bumps this; a connect
     * attempt stamps it at entry and re-checks after each suspension point, so
     * a stop that lands mid-`room.connect` cancels the attempt instead of
     * letting it publish (and fire `started`) into a share that already ended.
     * Main-dispatcher confined, like every other field here.
     */
    private var connectGeneration = 0

    /**
     * The MLS epoch of the key the sender currently encrypts under. Frame-key
     * pushes race (a rotation against the post-connect reconcile), and the
     * bridge does not promise ordering — without a fence the OLDER push could
     * land last and stick. Epochs are only comparable within one group; the
     * JS side guarantees a single group per share (it refuses cross-group
     * pushes), so within a connect this is monotonic.
     */
    private var currentEpoch = -1

    /**
     * The WebView call's audio mode, snapshotted before the leg's Room is
     * created. Probe (f) showed `NoAudioHandler` keeps AudioManager untouched
     * through create → connect → publish, but Room/audio TEARDOWN reset the
     * global mode to NORMAL even under NoAudioHandler — which would yank the
     * live WebView call out of `MODE_IN_COMMUNICATION`. Re-asserted in
     * [tearDown] if teardown moved it.
     */
    private var savedAudioMode: Int? = null

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val result = JSObject()
        // MediaProjection exists on every supported API level (21+; minSdk 24).
        result.put("available", true)
        // AudioPlaybackCapture (slice 4) needs API 29.
        result.put("audioCapture", Build.VERSION.SDK_INT >= 29)
        call.resolve(result)
    }

    /**
     * Phase 1: the OS consent dialog + (deferred) FGS. Resolves once the user
     * has granted capture; the JS side then mints the 10 s leg token and calls
     * [connect]. Consent is per-share by OS rule — every share re-prompts.
     */
    @PluginMethod
    fun prepare(call: PluginCall) {
        val activity: Activity = activity ?: run {
            call.reject("no_activity")
            return
        }
        val manager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
            as MediaProjectionManager
        startActivityForResult(call, manager.createScreenCaptureIntent(), "onConsentResult")
    }

    @ActivityCallback
    private fun onConsentResult(call: PluginCall, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            call.reject("consent_denied")
            return
        }
        consentIntent = data
        val ok = JSObject()
        ok.put("ok", true)
        call.resolve(ok)
    }

    /**
     * Phase 2: connect the leg and publish. `e2ee` is REQUIRED for a share
     * inside an encrypted call — the JS gate (§7.2) only omits it on a
     * positively-plaintext call. `audio` is accepted for API stability but
     * inert until slice 4 (§0.6): v1 publishes video only.
     */
    @PluginMethod
    fun connect(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("invalid_argument:url")
        val token = call.getString("token") ?: return call.reject("invalid_argument:token")
        val quality = call.getObject("quality") ?: return call.reject("invalid_argument:quality")
        val e2ee = call.getObject("e2ee")

        if (room != null) {
            call.reject("already_connected")
            return
        }
        val intent = consentIntent
        if (intent == null) {
            call.reject("not_prepared")
            return
        }

        scope.launch {
            // Claim the attempt. Any tearDown (JS stop, room event, plugin
            // destroy) bumps the counter and thereby cancels this connect at
            // its next check; a competing connect supersedes it the same way.
            val generation = ++connectGeneration
            try {
                doConnect(generation, call, url, token, quality, e2ee, intent)
            } catch (t: Throwable) {
                // OWNERSHIP RULE, and the ONLY thing that decides cleanup
                // here: a SUPERSEDED attempt owns nothing global. The
                // tearDown that cancelled it already released the plugin's
                // state, and anything now in `room`/`keyProvider`/
                // `consentIntent` may belong to a SUCCESSOR the user started
                // in the meantime — tearing that down would silently kill a
                // live share (and with `reason = null`, without even telling
                // JS). doConnect has already disposed the Room this attempt
                // created, which is the one thing that IS its own; that is
                // deliberately not left to the cancelling tearDown, because
                // whether `disconnect()` aborts an in-flight `connect()` is
                // not a documented lk-android guarantee.
                if (generation != connectGeneration) {
                    call.reject("connect_failed: cancelled")
                } else {
                    // Still the current attempt: this failure is ours to
                    // clean up. The consent survives a failed connect (probe
                    // (e)) — the single-use getMediaProjection only happens
                    // at publish, so JS may retry connect() with a fresh
                    // token and no new dialog. tearDown clears the stored
                    // consent (right for an ACTIVE share ending), so restore
                    // it around the cleanup — unless the failure was the
                    // publish itself, which consumed it.
                    val consent = consentIntent
                    tearDown(reason = null)
                    consentIntent = consent
                    call.reject("connect_failed: ${t.message ?: t.javaClass.simpleName}")
                }
            }
        }
    }

    private suspend fun doConnect(
        generation: Int,
        call: PluginCall,
        url: String,
        token: String,
        quality: JSObject,
        e2ee: JSObject?,
        intent: Intent,
    ) {
        val appContext = context.applicationContext
        val audioManager = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        savedAudioMode = audioManager.mode

        // Constructing any KeyProvider before the first LiveKit.create()
        // throws UnsatisfiedLinkError (probe (a) integration fact 2) — the
        // FrameCryptorFactory JNI lives in the SDK's libwebrtc.
        ensureWebRtcLoaded()

        val provider = if (e2ee != null) RawScreenKeyProvider() else null
        keyProvider = provider

        val longSide = quality.getInteger("longSide") ?: 1080
        val fps = quality.getInteger("fps") ?: 30
        val maxBitrateKbps = quality.getInteger("maxBitrateKbps") ?: 3000
        val degradation = when (quality.getString("degradation")) {
            "maintain-framerate" -> RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
            "maintain-resolution" -> RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
            else -> RtpParameters.DegradationPreference.BALANCED
        }
        val (width, height) = captureDimensions(longSide)

        val room = LiveKit.create(
            appContext,
            RoomOptions(
                // The leg subscribes to nothing, so adaptiveStream has nothing
                // to adapt and dynacast's layer bookkeeping is one more thing
                // between the encoder and the wire. Single layer, VP8, no
                // backup codec, no simulcast — the phone table (§7.4 / §0.7):
                // fewer encoders on a thermally-constrained device and no
                // E2EE-backup-codec trap (a silently-dropped backup reads as
                // a black tile on viewers).
                adaptiveStream = false,
                dynacast = false,
                e2eeOptions = provider?.let { E2EEOptions(keyProvider = it) },
                screenShareTrackCaptureDefaults = LocalVideoTrackOptions(
                    isScreencast = true,
                    captureParams = VideoCaptureParameter(width, height, fps),
                ),
                screenShareTrackPublishDefaults = VideoTrackPublishDefaults(
                    videoEncoding = VideoEncoding(maxBitrateKbps * 1000, fps),
                    simulcast = false,
                    videoCodec = "vp8",
                    backupCodec = null,
                    degradationPreference = degradation,
                ),
            ),
            LiveKitOverrides(
                // The default AudioSwitchHandler flips the GLOBAL AudioManager
                // into MODE_IN_COMMUNICATION and re-routes speaker/earpiece AT
                // CONNECT, even for a publish-only room with no audio track
                // (probe (f) control run) — which would fight the live WebView
                // call sharing this process. NoAudioHandler leaves it alone.
                audioOptions = AudioOptions(audioHandler = NoAudioHandler()),
            ),
        )
        this.room = room
        // From here this attempt OWNS `room` until it either hands it over by
        // resolving, or disposes it below. Nothing else can: a tearDown that
        // cancels us nulls `this.room` and may hand the field to a successor,
        // so the cancelling tearDown is NOT a reliable owner of this object.
        // The collector belongs to THIS Room, so it is cancelled wherever the
        // Room is disposed — including the abandon path below. Leaving it
        // running against a discarded Room means the `Disconnected` that
        // discarding provokes reaches `onRoomEvent`, which resolves
        // `this.room` — a SUCCESSOR's — and tears down a live share. Same
        // ownership rule as the Room itself, so it is declared out here with
        // the Room rather than inside the try.
        var events: Job? = null
        try {
            eventsJob?.cancel()
            events = scope.launch {
                room.events.collect { event -> onRoomEvent(event) }
            }
            eventsJob = events

            // Belt-and-braces on the token's canSubscribe=false (§4.3 step 2).
            room.connect(url, token, ConnectOptions(autoSubscribe = false))
            // First suspension behind us: a stop may have torn the room down
            // while connect was in flight. Abandon before touching E2EE state
            // or publishing.
            ensureConnectCurrent(generation)

            val identity = room.localParticipant.identity?.value
                ?: throw IllegalStateException("no local identity after connect")
            legIdentity = identity

            if (provider != null) {
                // Witness, not assumption (§0.4): the manager only reports
                // enabled once its setup() ran against this Room. Publishing
                // without it would be libwebrtc's cryptor-not-ready
                // PASSTHROUGH — plaintext.
                val manager = room.e2eeManager
                if (manager == null || !manager.enabled) {
                    throw IllegalStateException("e2ee manager not enabled")
                }
                val keyB64 = e2ee!!.getString("keyB64")
                    ?: throw IllegalArgumentException("e2ee.keyB64 missing")
                val keyIndex = e2ee.getInteger("keyIndex") ?: 0
                currentKeyIndex = keyIndex
                currentEpoch = e2ee.getInteger("epoch") ?: 0
                // Raw 32-byte HKDF material at (identity, index) — the
                // provider's getLatestKeyIndex() hands this index to every
                // cryptor the manager creates from now on, which fixes the
                // at-creation and at-reconnect index for free (probe (a)).
                provider.setRawKey(identity, keyIndex, Base64.decode(keyB64, Base64.DEFAULT))
            }

            // The FGS runs with OUR notification (§4.3 step 1, option (a)):
            // the SDK auto-starts its own ScreenCaptureService inside the
            // track start, declared with
            // foregroundServiceType="mediaProjection" via manifest merge, and
            // only builds a default notification when none is passed —
            // exactly one notification on API 34/35/36 (probe (e)).
            val params = ScreenCaptureParams(
                mediaProjectionPermissionResultData = intent,
                notificationId = NOTIFICATION_ID,
                notification = buildNotification(),
                onStop = {
                    // System chip / notification Stop / OS revoke.
                    scope.launch { tearDown("system") }
                },
            )
            // The consent is consumed by this publish (single-use by OS rule).
            consentIntent = null
            val published = room.localParticipant.setScreenShareEnabled(true, params)
            // Second suspension: a stop that landed during the publish has
            // already released the plugin's state — the publication is moot,
            // and announcing `started` for it would resurrect the share in JS.
            ensureConnectCurrent(generation)
            if (published != true) {
                throw IllegalStateException("screen share publish refused")
            }

            if (provider != null) {
                // Re-assert the send index on the live sender cryptor(s):
                // getLatestKeyIndex covers creation, but verify rather than
                // trust (§0-R.6) — a cryptor sitting at the wrong index
                // encrypts under a key the wrong epoch's members hold.
                assertSenderKeyIndex(room, currentKeyIndex)
            }

            ensureConnectCurrent(generation)
            notifyListeners("started", JSObject())
            val ok = JSObject()
            ok.put("ok", true)
            call.resolve(ok)
        } catch (t: Throwable) {
            // Superseded ⇒ `this.room` is null or a SUCCESSOR's, so nothing
            // else will ever finish tearing down the Room this attempt
            // created. Do it here rather than assuming the cancelling
            // tearDown's `disconnect()` aborted an in-flight `connect()` —
            // lk-android documents no such guarantee, and if it does not
            // hold, a connected leg would linger on the SFU (visible in
            // every client's roster) for the life of the process.
            if (this.room !== room) {
                // Cancel BEFORE discarding: the disconnect below would
                // otherwise reach `onRoomEvent`, which reads `this.room` —
                // a successor's by now — and tear down its live share.
                events?.cancel()
                if (events != null && eventsJob === events) eventsJob = null
                // `releasedRoom` distinguishes the two cases that reaching
                // here otherwise looks identical for: the COMMON one, where
                // the cancelling tearDown already released this very Room
                // (so releasing again would be a second native dispose), and
                // the successor case, where nobody has. Only the release is
                // conditional — the disconnect and the capture stop below
                // are what scenario B still needs either way.
                discardRoom(room, alreadyReleased = releasedRoom === room)
            }
            throw t
        }
    }

    /**
     * Stop a screen capture, before the Room that owns it goes away. NOT
     * redundant with disconnecting: stopping the track is what releases the
     * MediaProjection and lets the SDK's ScreenCaptureService go, so a Room
     * torn down without it can leave the OS cast chip and our notification
     * up while the app believes nothing is shared.
     *
     * 🔴 MUST STAY NON-SUSPENDING — see [tearDown]'s invariant. `Track.stop()`
     * is `public void stop()` in livekit-android 2.28.0 (checked against the
     * .aar, not assumed). The obvious-looking `setScreenShareEnabled(false)`
     * is NOT usable here: it is `suspend`, and `LocalParticipant` serializes
     * per-source publish/unpublish behind a mutex, so it would block for the
     * whole of an in-flight publish — turning teardown into a suspending
     * section and making every field it has not yet written readable as
     * stale. It also buys nothing: it reaches the track through the same
     * publication lookup this does.
     *
     * 🔴 Residual, needs HARDWARE: a track that never reached
     * `trackPublications` (a stop landing mid-publish) is invisible to this
     * lookup as much as to the SDK's own cleanup. Owed before the flag
     * lights: one device leg that ends the call from the other participant
     * DURING the publish, then checks the shade and
     * `adb shell dumpsys media_projection`.
     */
    private fun stopCapture(room: Room) {
        try {
            room.localParticipant
                .getTrackPublication(Track.Source.SCREEN_SHARE)
                ?.track
                ?.stop()
        } catch (_: Throwable) {}
    }

    /** Thrown by [ensureConnectCurrent]. Reaches [connect]'s catch, which
     *  distinguishes superseded from current by the generation, not by the
     *  exception type. */
    private class ConnectCancelled : IllegalStateException("cancelled")

    /** Tear down a Room this attempt created but no longer owns: stop any
     *  capture it started, disconnect, and release unless a tearDown already
     *  did. Never touches plugin-global state — that belongs to whoever
     *  holds `this.room` now. */
    private fun discardRoom(room: Room, alreadyReleased: Boolean) {
        stopCapture(room)
        try {
            room.disconnect()
        } catch (_: Throwable) {}
        if (alreadyReleased) return
        try {
            room.release()
        } catch (_: Throwable) {}
    }

    private fun ensureConnectCurrent(generation: Int) {
        if (generation != connectGeneration) {
            throw ConnectCancelled()
        }
    }

    /**
     * Rotation push from `MlsKeyProvider.applyLocalKey` (§5.2). Resolves only
     * after BOTH the key install and the sender-cryptor index switch landed —
     * the JS side awaits this before reporting the local key installed, so a
     * Remove-driven rotation cannot complete while the leg still encrypts
     * under the removed member's key. Any failure here must be treated by the
     * caller as "stop the leg".
     */
    @PluginMethod
    fun setFrameKey(call: PluginCall) {
        val keyB64 = call.getString("keyB64") ?: return call.reject("invalid_argument:keyB64")
        val keyIndex = call.getInt("keyIndex") ?: return call.reject("invalid_argument:keyIndex")
        val epoch = call.getInt("epoch") ?: return call.reject("invalid_argument:epoch")
        scope.launch {
            val provider = keyProvider
            val identity = legIdentity
            // Bound to the Room this push was VALIDATED against, so the
            // cryptor assertion below cannot land on a later one.
            val activeRoom = room
            if (provider == null || identity == null || activeRoom == null) {
                call.reject("not_connected")
                return@launch
            }
            // The push fence: never step the sender BACKWARDS. Pushes race
            // (a rotation against the post-connect reconcile) and the older
            // one can arrive last; applying it would stick the sender on a
            // superseded key past the JS idempotence guard. A superseded push
            // RESOLVES as a no-op rather than rejecting — the newer key
            // already won, and a rejection would trip the caller's
            // fail-closed path into stopping a correctly-keyed leg.
            //
            // 🔴 Comparing epochs is only sound WITHIN one MLS group, and the
            // JS side guarantees that: it refuses to push a key whose
            // group_id differs from the one the leg connected under, so this
            // counter never sees two groups' epochs. That in turn rests on
            // group ids being unique per establish (OpenMLS mints a random
            // id at creation) — if a re-established group could ever reuse an
            // id AND restart its epochs, a fresh epoch-0 key would no-op here
            // and the leg would keep encrypting under the superseded group's
            // key, readable by whoever that re-establish removed.
            if (epoch < currentEpoch) {
                call.resolve()
                return@launch
            }
            try {
                provider.setRawKey(identity, keyIndex, Base64.decode(keyB64, Base64.DEFAULT))
                currentKeyIndex = keyIndex
                currentEpoch = epoch
                assertSenderKeyIndex(activeRoom, keyIndex)
                call.resolve()
            } catch (t: Throwable) {
                call.reject("set_frame_key_failed: ${t.message ?: t.javaClass.simpleName}")
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        scope.launch {
            // The PluginCall settles NO MATTER WHAT tearDown does: an
            // unsettled promise here latches the JS side's in-flight stop
            // forever, and every later stop hook then waits on a teardown
            // that already died. tearDown itself guards each step, so a throw
            // out of it is already the pathological case — never compound it
            // by also losing the resolve.
            try {
                tearDown("user")
            } finally {
                call.resolve()
            }
        }
    }

    // ------------------------------------------------------------------

    private fun onRoomEvent(event: RoomEvent) {
        val room = this.room ?: return
        when (event) {
            is RoomEvent.TrackE2EEStateEvent -> {
                // The manager's own per-sender observer, surfaced as an event.
                // NEW is the pre-key transient (discardFrameWhenCryptorNotReady
                // means nothing leaves the phone during it); everything else
                // that is not OK is a sender that cannot be trusted — fail
                // closed, never keep publishing (§4.3 step 3).
                if (event.state != E2EEState.OK && event.state != E2EEState.NEW) {
                    scope.launch { tearDown("error") }
                }
            }
            is RoomEvent.Reconnected -> {
                // A full reconnect does NOT re-publish the screencast track —
                // consent data is single-use, so the SDK cannot silently
                // re-acquire it (probe (c-iv)). No publication after
                // Reconnected ⇒ the share is over; with one, re-assert the
                // send index (a re-created cryptor resets key_index_ to 0).
                val pub = room.localParticipant.getTrackPublication(Track.Source.SCREEN_SHARE)
                if (pub == null) {
                    scope.launch { tearDown("disconnected") }
                } else if (keyProvider != null) {
                    try {
                        assertSenderKeyIndex(room, currentKeyIndex)
                    } catch (t: Throwable) {
                        scope.launch { tearDown("error") }
                    }
                }
            }
            is RoomEvent.TrackPublished -> {
                if (event.participant === room.localParticipant && keyProvider != null) {
                    try {
                        assertSenderKeyIndex(room, currentKeyIndex)
                    } catch (t: Throwable) {
                        scope.launch { tearDown("error") }
                    }
                }
            }
            is RoomEvent.TrackMuted -> {
                // Only the server mutes a leg track (mute_track_identity —
                // out-of-band shape or video cap). Surface it; the WebView
                // shows the toast (§4.2 events).
                if (event.participant === room.localParticipant) {
                    val data = JSObject()
                    data.put("muted", true)
                    notifyListeners("muted", data)
                }
            }
            is RoomEvent.TrackUnmuted -> {
                if (event.participant === room.localParticipant) {
                    val data = JSObject()
                    data.put("muted", false)
                    notifyListeners("muted", data)
                }
            }
            is RoomEvent.Disconnected -> {
                // Server-side removal: primary left (ingress removes the leg),
                // moderator kick, orphan eject. tearDown is a no-op when this
                // arrived because WE disconnected.
                if (!stopping) {
                    scope.launch { tearDown("disconnected") }
                }
            }
            else -> {}
        }
    }

    /**
     * `setKey` stores material; only `setKeyIndex` moves the SENDER's index
     * (§0-R.6). `E2EEManager.frameCryptors` is private with no accessor in
     * 2.28.0 — the anticipated reflection interim from probe (a); works with
     * `minifyEnabled false`, verified live in probe (c-iii). Every cryptor in
     * the leg's manager is a sender (the leg subscribes to nothing). Verified
     * after the switch: a cryptor still at the old index after this call is a
     * hole, not a hiccup — throw so callers fail closed.
     */
    private fun senderCryptors(room: Room?): Collection<FrameCryptor> {
        val manager = room?.e2eeManager ?: return emptyList()
        val field = manager.javaClass.getDeclaredField("frameCryptors")
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        val map = field.get(manager) as Map<*, FrameCryptor>
        return map.values
    }

    /** Takes the OWNING Room explicitly rather than reading `this.room`: a
     *  superseded attempt reading the field would drive `setKeyIndex` on a
     *  SUCCESSOR's sender cryptors — a wrong-epoch send. Safe today only
     *  because no suspension separates the callers' generation check from
     *  the call; passing the Room makes it safe by construction instead. */
    private fun assertSenderKeyIndex(room: Room?, index: Int) {
        for (cryptor in senderCryptors(room)) {
            cryptor.setKeyIndex(index)
        }
        for (cryptor in senderCryptors(room)) {
            if (cryptor.keyIndex != index) {
                throw IllegalStateException("sender cryptor refused key index switch")
            }
        }
    }

    /**
     * 🔴 INVARIANT, and everything below depends on it: this function must
     * contain NO SUSPENSION POINT. Every coroutine here is Main-confined, so
     * a teardown without one runs atomically against `doConnect` — which is
     * what makes the whole ownership scheme sound: no successor can claim
     * `room` mid-teardown, no re-entrant teardown can pass `stopping` and
     * settle a PluginCall early, and no attempt can read a field this has
     * not yet written.
     *
     * It was briefly violated by calling the SUSPENDING
     * `setScreenShareEnabled(false)` from [stopCapture], and the cost was
     * immediate and deterministic rather than theoretical: `LocalParticipant`
     * serializes per-source publish/unpublish behind a mutex, so a teardown
     * during a publish blocked until that publish finished, and the abandon
     * path then read `releasedRoom` before this had written it — releasing
     * the same native Room twice, on exactly the stop-during-publish path
     * [stopCapture] exists to serve. Anything called from here ([stopCapture],
     * [discardRoom]) must stay non-suspending.
     */
    private fun tearDown(reason: String?) {
        // Cancel any in-flight connect FIRST — even a re-entrant tearDown
        // that returns at the guard below must orphan it (see
        // [ensureConnectCurrent]); the bump is idempotent and harmless.
        connectGeneration++
        if (stopping) return
        stopping = true
        eventsJob?.cancel()
        eventsJob = null
        val room = this.room
        this.room = null
        legIdentity = null
        // CLAIM the Room before touching it, not after releasing it: this
        // flag is what an attempt cancelled mid-connect reads to tell
        // "a teardown owns my Room's release" from "a successor owns `room`
        // now, and mine is unreleased". Written first so it is already true
        // for any reader, which keeps it correct even if a suspension is
        // ever reintroduced above (it must not be — see the invariant).
        //
        // Only ever OVERWRITTEN by a teardown that has a Room to claim: a
        // later teardown finding `this.room` already null (a second §7.4
        // hook firing inside one publish window — they no longer coalesce
        // in JS once the previous stop resolved) would otherwise blank a
        // still-live claim, and the attempt it belonged to would then
        // release its Room a second time.
        room?.let { releasedRoom = it }
        // Stop the capture before the Room goes: stopping the track is what
        // releases the MediaProjection and its foreground service, and a
        // Room disconnected without it can leave the OS cast chip up (see
        // [stopCapture]).
        room?.let { stopCapture(it) }
        try {
            room?.disconnect()
        } catch (_: Throwable) {}
        try {
            room?.release()
        } catch (_: Throwable) {}
        // Drop the native keyring (§4.2 hygiene) — the provider outlives the
        // Room, so its rtcKeyProvider must be disposed explicitly.
        try {
            keyProvider?.dispose()
        } catch (_: Throwable) {}
        keyProvider = null
        // Probe (f) caveat: Room/audio teardown reset the GLOBAL audio mode
        // to NORMAL even under NoAudioHandler. Re-assert the WebView call's
        // mode if teardown moved it, so ending a share does not silently break
        // the call's audio routing. Guarded like every other step: a throw
        // here (the service lookup as much as the mode write) must not abort
        // the rest of the teardown — an aborted teardown leaves `stopping`
        // latched and the stop() call unsettled on old callers.
        try {
            savedAudioMode?.let { saved ->
                val audioManager = context.applicationContext
                    .getSystemService(Context.AUDIO_SERVICE) as AudioManager
                if (audioManager.mode != saved) {
                    audioManager.mode = saved
                }
            }
        } catch (_: Throwable) {}
        savedAudioMode = null
        consentIntent = null
        currentEpoch = -1
        currentKeyIndex = 0
        // Cleared HERE, not only on a successful connect. `stopping` exists to
        // make a teardown re-entrant-safe for its own duration; leaving it set
        // afterwards latched it for the rest of the process, so the next
        // tearDown returned at the guard above and skipped everything — no
        // disconnect, no keyProvider dispose, no audio-mode restore. That also
        // silently defeated the JS stop funnel: a share stopped, then a second
        // share whose connect failed early could not be torn down at all.
        stopping = false
        if (reason != null) {
            // Guarded for the same reason as every step above: the event is
            // best-effort (the JS side settles its own state off the stop()
            // resolution too), and a bridge throw here must not escape a
            // teardown that has otherwise completed.
            try {
                val data = JSObject()
                data.put("reason", reason)
                notifyListeners("stopped", data)
            } catch (_: Throwable) {}
        }
    }

    /**
     * The capture size as (LONG side, SHORT side) — always, regardless of the
     * device's current orientation.
     *
     * 🔴 That is livekit-android's contract for a SCREENCAST track, not a
     * guess: `LocalScreencastVideoTrack.startCapture` ignores
     * `super.startCapture` and re-derives the format itself, documenting
     * *"Use captureParams.width as longest side and captureParams.height as
     * shortest side"* — for a portrait display it passes
     * (params.height, params.width) to the capturer. Handing it a
     * portrait-ordered pair therefore publishes the TRANSPOSE: proven live on
     * 2026-08-25, where a portrait 1080x2340 emulator produced a landscape
     * `WebRTC_ScreenCapture ... 1080 x 498` virtual display and a 1080x498
     * track on the viewer. The SDK also owns rotation from here (see the note
     * further down), so orientation never enters this calculation.
     *
     * The aspect still follows the REAL display — MediaProjection letterboxes
     * a mismatched one — with the long side capped by the tier and both
     * dimensions forced even for the encoder.
     */
    private fun captureDimensions(longSide: Int): Pair<Int, Int> {
        // 🔴 The metrics MUST come from a VISUAL context (the Activity), not
        // the application context. `WindowManager` from an application context
        // is documented as not tracking the display's current configuration,
        // and on the API-36 emulator it reported the screen LANDSCAPE while
        // the device was portrait 1080x2340 — which published a transposed
        // 1080x498 capture (proven on the virtual display: "WebRTC_
        // ScreenCapture ... 1080 x 498"). MediaProjection letterboxes a
        // mismatched aspect, so that is a visibly wrong share on every device
        // the misreport happens on. Fall back to the application resources
        // only if there is no Activity, which cannot happen on the consent
        // path that precedes this.
        val visual: Context = activity ?: context
        val (screenW, screenH) = if (Build.VERSION.SDK_INT >= 30) {
            val windowManager = visual
                .getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
            val bounds = windowManager.currentWindowMetrics.bounds
            Pair(bounds.width(), bounds.height())
        } else {
            val metrics = android.util.DisplayMetrics()
            @Suppress("DEPRECATION")
            (visual.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager)
                .defaultDisplay.getRealMetrics(metrics)
            Pair(metrics.widthPixels, metrics.heightPixels)
        }
        val longPx = maxOf(screenW, screenH)
        val shortPx = minOf(screenW, screenH)
        val long = minOf(longSide, longPx)
        val short = (long.toLong() * shortPx / longPx).toInt()
        fun even(v: Int) = v and 0x1.inv()
        val dims = Pair(even(long), even(short))
        // Dimensions only — no key material, no call data (§4.2 hygiene). This
        // is the one field-diagnosable cause of a letterboxed share, and it is
        // invisible without a log: MediaProjection silently pillarboxes a
        // mismatched aspect rather than failing.
        android.util.Log.i(
            "ScreenSharePlugin",
            "capture long=${dims.first} short=${dims.second} " +
                "(screen ${screenW}x${screenH}, tier long side $longSide)",
        )
        return dims
    }

    // 🔴 Rotation is the SDK's job, not ours (proven live 2026-08-25).
    // `LocalScreencastVideoTrack` installs its own `OrientationEventListener`
    // and re-runs `changeCaptureFormat` whenever the display dimensions
    // change. An `onConfigurationChanged` hook here would race that with a
    // second, differently-derived format — plan §4.3 step 3's rotation
    // instruction is already satisfied by the SDK, so this plugin
    // deliberately registers nothing.

    private fun buildNotification(): Notification {
        val channelId = CHANNEL_ID
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE)
                as NotificationManager
            if (manager.getNotificationChannel(channelId) == null) {
                manager.createNotificationChannel(
                    // Native strings stay hard-coded English like the voice
                    // call service's — the FGS notification renders before the
                    // WebView (and its lingui catalogs) exist.
                    NotificationChannel(
                        channelId,
                        "Screen sharing",
                        NotificationManager.IMPORTANCE_LOW,
                    ),
                )
            }
        }
        return NotificationCompat.Builder(context, channelId)
            .setContentTitle("Sloga")
            .setContentText("Sharing your screen")
            .setSmallIcon(com.acutest.app.R.mipmap.ic_launcher)
            .setOngoing(true)
            .build()
    }

    override fun handleOnDestroy() {
        scope.launch { tearDown(null) }
        super.handleOnDestroy()
    }

    companion object {
        private const val NOTIFICATION_ID = 4243
        private const val CHANNEL_ID = "sloga_screenshare"

        private var webRtcLoaded = false

        @Synchronized
        private fun ensureWebRtcLoaded() {
            if (webRtcLoaded) return
            System.loadLibrary("lkjingle_peerconnection_so")
            webRtcLoaded = true
        }
    }
}

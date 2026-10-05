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
import android.os.SystemClock
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
import io.livekit.android.e2ee.E2EEManager
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
import kotlinx.coroutines.delay
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
 * Hygiene (§4.2): key material is held only inside the native key provider,
 * never logged, and never echoed back through resolve/reject/events. It is
 * released in [disposeDetached], possibly [SETTLE_MS] after the share ended:
 * first the leg's sender frame cryptors (each native transformer holds its
 * own reference to the key ring, and the SDK never disposes them on a
 * disconnect), then the provider via `dispose()`. Released means the native
 * memory is freed, not zeroized.
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
    /** The leg Room's E2EE manager, captured in [doConnect] once it is
     *  witnessed enabled, so [disposeDetached] can still reach the sender
     *  frame cryptors after `disconnect()`. Capturing it at teardown would be
     *  too late: the SDK's disconnect cleanup nulls `Room.e2eeManager`, and
     *  on a server `Disconnected` that has already happened when [tearDown]
     *  runs. */
    private var e2eeManager: E2EEManager? = null
    /** Detached legs whose native teardown is waiting out [SETTLE_MS]
     *  ([scheduleDisposal]). A list, not a slot: a second settled teardown
     *  inside the window must not strand the first Room and its key ring.
     *  Entries are matched by IDENTITY only (`===`), never by `equals`:
     *  neither `Room` nor [Detached] declares one today, and anything keyed
     *  on `equals` would silently change meaning if an SDK upgrade added it.
     *  Main-dispatcher confined, like every other field here. */
    private val pendingDisposals = ArrayList<Detached>()
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
     * The [connectGeneration] that a `tearDown("revoked")` cancelled, so the
     * cancelled attempt rejects with `connect_failed: revoked` instead of
     * `connect_failed: cancelled`. A revoke during connect is a moderator's
     * decision, not a superseded attempt, and JS shows the revoke toast only
     * off that exact text. Keyed by generation rather than "the last
     * teardown's reason": a later stop or a successor connect must not
     * relabel an attempt that something else cancelled. Stamps start at 1,
     * so -1 never matches.
     */
    private var revokedGeneration = -1

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
     * [disposeDetached], possibly [SETTLE_MS] later, if teardown moved it, but
     * NOT from this snapshot: it puts back the mode it reads just before its
     * own disconnect. Restoring the snapshot after the window would force
     * call mode on a user who left the call inside it. So this field is only
     * a record now, cleared with the rest of the share's state in [tearDown].
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
            // The previous leg leaves before this one joins: a disposal still
            // waiting out its settle window runs now, not over the new leg's
            // connect. Inside the launch (Main) rather than beside the guards
            // above, because `pendingDisposals` is Main-confined. A snapshot,
            // since each disposal removes itself from the list.
            for (pending in ArrayList(pendingDisposals)) {
                disposeDetached(pending)
            }
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
                // not a documented lk-android guarantee. (One exception: a
                // SETTLED teardown that claimed it still holds it in
                // `pendingDisposals`. This attempt is no longer in flight by
                // then, so doConnect only stopped the capture and left the
                // rest to that disposal; see [discardRoom].)
                if (generation != connectGeneration) {
                    // Only the rejection TEXT depends on who cancelled; the
                    // ownership rule above is identical for a revoke. The
                    // revoking tearDown has already emitted
                    // `stopped{"revoked"}` by the time this runs.
                    if (generation == revokedGeneration) {
                        call.reject("connect_failed: revoked")
                    } else {
                        call.reject("connect_failed: cancelled")
                    }
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
                // Kept for [disposeDetached], which must dispose this
                // manager's sender cryptors after the SDK has nulled
                // `room.e2eeManager` (see [e2eeManager]). No suspension since
                // the generation check above, so this attempt still owns the
                // plugin's fields.
                e2eeManager = manager
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
                    // System chip / notification Stop / OS revoke. The SDK
                    // has just unpublished the track and may be renegotiating
                    // the publisher, so the native teardown is settled
                    // ([SETTLE_MS]).
                    scope.launch { tearDown("system", settle = true) }
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
                // the cancelling tearDown already claimed this very Room, so
                // its disconnect and release are owned, possibly deferred by
                // [SETTLE_MS] (releasing again would be a second native
                // dispose), and the successor case, where nobody has. The
                // capture stop is what scenario B needs either way; whether
                // [discardRoom] also disconnects depends on whether a pending
                // disposal owns the Room, and only the release depends on
                // this flag.
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
     *  capture it started, disconnect, dispose its sender frame cryptors, and
     *  release unless a tearDown already did. Never touches plugin-global
     *  state — that belongs to whoever holds `this.room` now; it only READS
     *  `pendingDisposals`.
     *
     *  If a settled teardown claimed this Room and its disposal is still
     *  pending, only the capture stop happens here. Disconnecting now would
     *  reopen the race the settle window exists for, and that pending
     *  [disposeDetached] disconnects, disposes and releases the Room itself.
     *  MUST stay non-suspending, like [tearDown]. */
    private fun discardRoom(room: Room, alreadyReleased: Boolean) {
        stopCapture(room)
        if (pendingDisposals.any { it.room === room }) return
        // Read before the disconnect: the SDK's cleanup nulls it, and it is
        // then the only way left to this Room's sender cryptors.
        val manager = room.e2eeManager
        try {
            room.disconnect()
        } catch (_: Throwable) {}
        // Same position as in [disposeDetached]: after the disconnect,
        // before the release.
        trace("discard sender cryptors disposed=${disposeSenderCryptors(manager)}")
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
                // On a full reconnect the SDK unpublishes the screencast but
                // keeps the still-running track for its own
                // `republishTracks`, which WOULD put it back on air; when
                // this event arrives the publication is gone (probe
                // (c-iv)). No publication after Reconnected ⇒ the share is
                // over, and this teardown is deliberately NOT settled: its
                // immediate disconnect is what pre-empts the republish. A
                // deferred one would let the screen return for up to
                // [SETTLE_MS] after `stopped{disconnected}`, under a key that
                // no longer receives rotations. (The immediate teardown can
                // still race the republish: a recorded residual.) With a
                // publication, re-assert the send index (a re-created
                // cryptor resets key_index_ to 0).
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
            is RoomEvent.ParticipantPermissionsChanged -> {
                // A moderator revoked Video, or AFK-designated the sharer: the
                // backend pushes the leg `canPublish = false` with an empty
                // source list, the SFU force-unpublishes the track, and the SDK
                // stops the capture on its own. The leg itself stays
                // CONNECTED, so no Disconnected ever follows. Without this
                // branch the leg sat in the room with zero publications while
                // JS still showed a live share.
                //
                // An EMPTY `canPublishSources` is LiveKit's "no restriction",
                // never a revoke on its own. The backend only sends it
                // alongside `canPublish = false`, so only a NON-empty list
                // that lacks SCREEN_SHARE counts.
                //
                // `newPermissions` is @Nullable in 2.28.0; a null carries no
                // decision and is ignored. The reason is "revoked", not
                // "disconnected": the user must learn that a moderator ended
                // the share. A disconnect toast would invite a re-share that
                // the same grant refuses.
                val p = event.newPermissions
                if (event.participant === room.localParticipant && !stopping && p != null) {
                    val screenAllowed = p.canPublishSources.isEmpty() ||
                        Track.Source.SCREEN_SHARE in p.canPublishSources
                    if (!p.canPublish || !screenAllowed) {
                        // Only if THIS share is still the live one when the
                        // launch runs. Two events handled back to back would
                        // otherwise each queue a teardown, and the second
                        // (finding `room` already null) would emit a second
                        // `stopped`.
                        //
                        // Settled: the SFU's forced unpublish and the
                        // renegotiation it triggers may still be running in
                        // the SDK, so only the logical stop happens now.
                        scope.launch {
                            if (this@ScreenSharePlugin.room === room) {
                                tearDown("revoked", settle = true)
                            }
                        }
                    }
                }
            }
            is RoomEvent.TrackUnpublished -> {
                // Second liveness bound for a revoke, independent of the
                // permission event above. livekit-android 2.28.0 DOES re-emit a
                // LOCAL unpublish as this RoomEvent
                // (`LocalParticipant.unpublishTrack` -> its internal listener,
                // which is the Room -> `Room.onTrackUnpublished(Local...)`;
                // checked in the .aar bytecode), including the SFU-forced one
                // (`handleLocalTrackUnpublished`).
                //
                // The forced unpublish is not the only local one, though. The
                // SDK also unpublishes on a full reconnect
                // (`prepareForFullReconnect`, state already RECONNECTING;
                // Reconnected decides that case), in disconnect cleanup (state
                // already DISCONNECTED), and when MediaProjection stops (BEFORE
                // it calls our onStop, which reports "system"). The first two
                // are excluded HERE, by requiring CONNECTED when the event
                // arrives: checking it only after the wait would let a full
                // reconnect that completes inside the grace pass as a revoke.
                // The system stop happens while CONNECTED, so it cannot be
                // told apart on the spot; the grace period covers it, and the
                // re-check after the wait reports "revoked" only for a leg that
                // is still THIS share, still CONNECTED, and still has no screen
                // publication. The wait sits in the launched coroutine, never
                // inside tearDown (see its invariant).
                if (event.participant === room.localParticipant &&
                    event.publication.source == Track.Source.SCREEN_SHARE
                ) {
                    // Diagnostic: ties a later teardown's steps to this
                    // unpublish. No identity, no key material.
                    trace("local screen unpublished state=${room.state} stopping=$stopping")
                }
                if (event.participant === room.localParticipant &&
                    event.publication.source == Track.Source.SCREEN_SHARE &&
                    !stopping &&
                    room.state == Room.State.CONNECTED
                ) {
                    scope.launch {
                        delay(UNPUBLISH_GRACE_MS)
                        if (this@ScreenSharePlugin.room === room &&
                            !stopping &&
                            room.state == Room.State.CONNECTED &&
                            room.localParticipant
                                .getTrackPublication(Track.Source.SCREEN_SHARE) == null
                        ) {
                            // Settled like the permission branch: the forced
                            // unpublish's renegotiation may still be running.
                            tearDown("revoked", settle = true)
                        }
                    }
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
        return frameCryptorMap(manager).values
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
     * [disposeDetached]) must stay non-suspending, and so must [discardRoom],
     * which runs on the same ownership scheme from [doConnect]'s abandon path.
     *
     * `settle` splits off the native half. Everything above still happens
     * here, atomically: the generation bump, the claim, the capture stop and
     * the clearing of every plugin field. But the Room's disconnect and
     * release, its sender cryptors and the key ring go to [disposeDetached]
     * [SETTLE_MS] later, through [scheduleDisposal], which holds the only
     * wait (inside its launched coroutine, never here). Only for a teardown
     * that follows a forced unpublish the SDK is still processing: the two
     * revoke branches and the MediaProjection system stop. Every other caller
     * disposes inline.
     */
    private fun tearDown(reason: String?, settle: Boolean = false) {
        trace("tearDown reason=$reason settle=$settle stopping=$stopping")
        // Cancel any in-flight connect FIRST — even a re-entrant tearDown
        // that returns at the guard below must orphan it (see
        // [ensureConnectCurrent]); the bump is idempotent and harmless.
        // A revoke records the generation it is about to cancel first, so an
        // in-flight attempt can tell JS why it died (see [revokedGeneration]).
        // If no attempt is in flight, the stamp names one that has already
        // settled and is never read.
        if (reason == "revoked") revokedGeneration = connectGeneration
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
        trace("tearDown capture stopped")
        // Everything a successor or a late push could read is cleared NOW,
        // before this returns, on both paths: inside a settle window
        // `setFrameKey` rejects `not_connected` instead of keying a leg that
        // is going away, and a successor's epoch fence starts clean. What the
        // native half still needs moves into a [Detached] that only
        // [disposeDetached] reads.
        val provider = keyProvider
        keyProvider = null
        val manager = e2eeManager
        e2eeManager = null
        savedAudioMode = null
        consentIntent = null
        currentEpoch = -1
        currentKeyIndex = 0
        if (room != null) {
            val detached = Detached(room, manager, provider)
            if (settle) {
                scheduleDisposal(detached)
            } else {
                disposeDetached(detached)
            }
        } else {
            // No Room to detach: the attempt failed before creating one (the
            // provider is built first). Nothing to disconnect and no audio
            // mode a Room could have moved; drop the native keyring (§4.2
            // hygiene) all the same.
            try {
                provider?.dispose()
            } catch (_: Throwable) {}
        }
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
     * A leg the plugin has let go of, carrying exactly what its native
     * teardown needs. [tearDown] builds it after clearing the plugin's
     * fields; from then on only [disposeDetached] touches these. [disposed]
     * makes the disposal run once, whichever of the inline call, the settle
     * timer or a [connect] drain gets there first.
     */
    private class Detached(
        val room: Room,
        val e2eeManager: E2EEManager?,
        val keyProvider: RawScreenKeyProvider?,
    ) {
        var disposed = false
    }

    /**
     * Defer [d]'s native teardown by [SETTLE_MS]. The only place a teardown
     * waits, and the wait sits inside the launched coroutine, so [tearDown]
     * itself stays non-suspending. `scope` is never cancelled, so the timer
     * still fires after [handleOnDestroy]; a [connect] inside the window runs
     * the disposal early instead.
     */
    private fun scheduleDisposal(d: Detached) {
        pendingDisposals.add(d)
        trace("disposal scheduled in ${SETTLE_MS}ms")
        scope.launch {
            delay(SETTLE_MS)
            disposeDetached(d)
        }
    }

    /**
     * The native half of a teardown: disconnect, sender frame cryptors,
     * release, key provider, audio mode, in that order. Runs inline from
     * [tearDown], [SETTLE_MS] later from [scheduleDisposal], or early from a
     * [connect] drain.
     *
     * Idempotent, and it reads ONLY [d] and the application context. The one
     * plugin field it touches is [pendingDisposals], to remove [d] by
     * identity. By the time a deferred disposal runs, `room`, `keyProvider`,
     * `releasedRoom`, `stopping` and the generation may all belong to a
     * successor share. Each step is guarded on its own, so one throw cannot
     * skip the rest. MUST stay non-suspending, like [tearDown].
     */
    private fun disposeDetached(d: Detached) {
        if (d.disposed) return
        d.disposed = true
        pendingDisposals.removeAll { it === d }
        val audioManager = try {
            context.applicationContext
                .getSystemService(Context.AUDIO_SERVICE) as AudioManager
        } catch (_: Throwable) {
            null
        }
        // Read just before the disconnect, not snapshotted at connect (see
        // the restore below).
        val modeBefore = try {
            audioManager?.mode
        } catch (_: Throwable) {
            null
        }
        trace("dispose disconnect begin")
        try {
            d.room.disconnect()
        } catch (_: Throwable) {}
        trace("dispose disconnect end")
        // After the disconnect, so no SDK path can still reach
        // `removePublishedTrack` with a cryptor disposed under it; before the
        // release, because each transformer posts to the factory's signaling
        // thread, which the release ends.
        val cryptors = disposeSenderCryptors(d.e2eeManager)
        trace("dispose sender cryptors disposed=$cryptors")
        trace("dispose release begin")
        try {
            d.room.release()
        } catch (_: Throwable) {}
        trace("dispose release end")
        // Drop the native keyring (§4.2 hygiene) — the provider outlives the
        // Room, so its rtcKeyProvider must be disposed explicitly. The sender
        // cryptors above held their own references to it.
        try {
            d.keyProvider?.dispose()
        } catch (_: Throwable) {}
        trace("dispose key provider released")
        // Probe (f) caveat: Room/audio teardown reset the GLOBAL audio mode
        // to NORMAL even under NoAudioHandler. Put back the mode read just
        // before the disconnect if the teardown moved it, so ending a share
        // does not silently break the call's audio routing. Not the
        // connect-time snapshot: this can run SETTLE_MS after the share
        // ended, and forcing call mode back on a user who left the call in
        // between would be wrong (inline, a leave racing the stop has the
        // same shape). Guarded like every other step: inline, a throw here
        // would abort the rest of [tearDown] and leave `stopping` latched.
        try {
            if (audioManager != null && modeBefore != null && audioManager.mode != modeBefore) {
                audioManager.mode = modeBefore
            }
        } catch (_: Throwable) {}
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

        /** How long a local screen unpublish, seen while the leg is
         *  CONNECTED, waits before it is reported as a revoke. Of the three
         *  non-revoke unpublishes, only the MediaProjection system stop needs
         *  it: the SDK unpublishes and then calls our onStop, whose
         *  tearDown("system") runs within milliseconds and clears `room`, so
         *  the post-wait same-Room check fails. A full reconnect (state
         *  RECONNECTING) and disconnect cleanup (state DISCONNECTED) are not
         *  covered by this wait at all; the CONNECTED check at event arrival
         *  excludes them, and the post-wait CONNECTED check is a second
         *  guard. A permission-event revoke that tears down first also clears
         *  `room`. The capture is already stopped, so the wait only delays
         *  the toast. */
        private const val UNPUBLISH_GRACE_MS = 1_000L

        /** How long a SETTLED teardown waits before its native half
         *  ([disposeDetached]) runs: the two revoke branches and the
         *  MediaProjection system stop, where the SDK has just unpublished
         *  the screen track and is renegotiating the publisher on its own
         *  coroutines. Disconnecting and releasing under that renegotiation
         *  aborted the app on the leg's WebRTC network thread (wave 4f).
         *  livekit-android 2.28.0 exposes no public "publisher negotiation
         *  stable" signal. The local `TrackUnpublished` marks the end of the
         *  synchronous half, and 4 s covers the offer/answer on a loaded
         *  device. A heuristic that narrows the race on a heavily loaded
         *  device, not a proof. On the permission branch it is measured from
         *  the permission event, which can precede the forced unpublish. */
        private const val SETTLE_MS = 4_000L

        /** Teardown diagnostics with a monotonic timestamp, so a log ties a
         *  teardown's native steps to the local screen unpublish. Step names,
         *  reasons and counts only: no key material, no identities. */
        private fun trace(step: String) {
            android.util.Log.i("ScreenSharePlugin", "$step t=${SystemClock.elapsedRealtime()}")
        }

        /** `E2EEManager.frameCryptors`, through the reflection described at
         *  [senderCryptors] (private, no accessor in 2.28.0). */
        @Suppress("UNCHECKED_CAST")
        private fun frameCryptorMap(manager: E2EEManager): MutableMap<*, FrameCryptor> {
            val field = manager.javaClass.getDeclaredField("frameCryptors")
            field.isAccessible = true
            return field.get(manager) as MutableMap<*, FrameCryptor>
        }

        /**
         * Dispose every sender frame cryptor in [manager], for a leg whose
         * Room is already disconnected; returns how many were disposed. The
         * SDK never does it on that path: `E2EEManager.dispose()` frees only
         * the data-packet cryptor, and its cleanup nulls `Room.e2eeManager`
         * before `removePublishedTrack` could run, so each native transformer
         * (its own OS thread, its own reference to the key ring) would live
         * until process exit. Snapshot, clear the map (so nothing disposes a
         * cryptor twice: a second `dispose()` throws), then dispose each in
         * its own try/catch. Never sets `isEnabled = false` first: disposing
         * needs no disable, and a disabled sender cryptor passes frames
         * through unencrypted.
         */
        private fun disposeSenderCryptors(manager: E2EEManager?): Int {
            if (manager == null) return 0
            val snapshot = try {
                val map = frameCryptorMap(manager)
                val copy = ArrayList(map.values)
                map.clear()
                copy
            } catch (_: Throwable) {
                return 0
            }
            var disposed = 0
            for (cryptor in snapshot) {
                try {
                    cryptor.dispose()
                    disposed++
                } catch (_: Throwable) {}
            }
            return disposed
        }

        private var webRtcLoaded = false

        @Synchronized
        private fun ensureWebRtcLoaded() {
            if (webRtcLoaded) return
            System.loadLibrary("lkjingle_peerconnection_so")
            webRtcLoaded = true
        }
    }
}

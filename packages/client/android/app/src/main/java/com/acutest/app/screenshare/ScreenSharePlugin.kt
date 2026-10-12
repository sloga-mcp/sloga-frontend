package com.acutest.app.screenshare

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.acutest.app.BuildConfig
import com.acutest.app.VoiceCallService
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import io.livekit.android.AudioOptions
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.AudioBufferCallback
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.e2ee.E2EEManager
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.e2ee.E2EEState
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishOptions
import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.participant.VideoTrackPublishOptions
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.LocalScreencastVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import livekit.org.webrtc.FrameCryptor
import livekit.org.webrtc.RtpParameters
import livekit.org.webrtc.ScreenCapturerAndroid
import livekit.org.webrtc.audio.JavaAudioDeviceModule

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
 * `getMediaProjection()` only happens when the plugin starts the capture,
 * after the publish and the sender witness, so a `connect()` that fails
 * before the capture setup does not burn the consent (probe (e)).
 *
 * E2EE is FAIL-CLOSED, witnessed rather than assumed (§0.4 / §0-R.5):
 *  - the screen capture starts only after the screen sender's frame cryptor
 *    is witnessed enabled at the current key index, and the track keeps that
 *    sender as its only one. The plugin owns the track: it publishes it
 *    first, witnesses the cryptor the SDK attached to that sender, checks
 *    that the track keeps that one sender ([screenSenderLayoutOk]), admits a
 *    [ScreenVideoGate] for that sender's transceiver, and only then starts
 *    the capture. The gate
 *    forwards frames only while the track is still on the witnessed
 *    transceiver with no additional transceiver recorded; once that stops
 *    holding, it drops every frame for good;
 *  - the raw-byte key provider is built with `discardFrameWhenCryptorNotReady
 *    = true`: a sender's cryptor drops its frames while it holds no key
 *    (probe (c-i): zero frames over 12 s with a keyless cryptor);
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
 *
 * System audio (slice 4) is a second, optional publication on the same leg:
 * `SCREEN_SHARE_AUDIO`, fed by [ScreenAudioSource] from the projection's
 * playback capture. The leg never opens the microphone (the WebView call owns
 * it): the ADM's recording is disabled on every leg, audio or not, and the
 * source fills the zeroed buffer the ADM hands its callback instead. Every
 * way the audio can fail costs the audio alone and reports it; the video
 * keeps going. Its sender is E2EE-framed like the video's, and the source's
 * gate opens only once that sender's cryptor is witnessed keyed.
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

    /**
     * The live share's system-audio source, set only with its gate OPEN.
     * Owned by [doConnect] as a local until the hand-over next to
     * `call.resolve`, then by the share: [tearDown] releases it, and so does
     * an audio-only loss ([onScreenAudioLost]), which nulls it so one loss
     * reports once. Released BEFORE the video capture stops, everywhere:
     * stopping the video capturer calls `MediaProjection.stop()`, which the
     * playback capture sits on (see [stopShareCapture]). Never unset as the
     * track's buffer callback: `setAudioBufferCallback(null)` would put the
     * ADM's mic-off record loop back into a busy spin, and a released source
     * keeps pacing zeros until the Room disconnects. Main-dispatcher
     * confined, like every other field here.
     */
    private var screenAudio: ScreenAudioSource? = null

    /**
     * The live share's screen track and its [ScreenVideoGate], held BY
     * REFERENCE so every stop path reaches them without a publication
     * lookup (a full reconnect drops the publication while the track keeps
     * running). Written by [doConnect] only, after the sender witness and
     * the admit and right before the capture starts, with no suspension
     * since its last generation check: so they always belong to the current
     * attempt. Before that the attempt holds both as locals, and its catch
     * handles them ([releaseAttemptVideo]); a superseded attempt never
     * writes or clears these. Taken out (nulled) by [tearDown]. The
     * Reconnecting arm closes the gate and stops the capture at arrival
     * without nulling them. Main-dispatcher confined, like every other field
     * here.
     */
    private var screenVideo: LocalScreencastVideoTrack? = null

    /** The gate in front of [screenVideo]'s video source; same rules. */
    private var screenVideoGate: ScreenVideoGate? = null

    /**
     * Sids of the system-audio publications this plugin muted itself
     * ([muteSilentAudio]). The SDK re-posts that mute as a `TrackMuted`,
     * and JS reads every `muted` event as a server mute: forwarding it would
     * add a second, contradictory notice to the audio state JS already has.
     * The mute arms skip these sids. Cleared by [tearDown]. Main-dispatcher
     * confined, like every other field here.
     */
    private val selfMutedSids = HashSet<String>()

    /** Set while [tearDown] runs so event handlers do not double-report. */
    private var stopping = false

    /** Whether [handleOnStart] has added the page-start listener. Once per
     *  plugin instance: `handleOnStart` runs on every return to the
     *  foreground, and each run must not stack another teardown. Plain var:
     *  only ever read and written on the main thread, in the Activity's
     *  `onStart`. */
    private var pageListenerRegistered = false

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
        // AudioPlaybackCapture (slice 4) needs API 29, and a build with the
        // system audio switched on (the same flag [screenAudioRefusal]
        // checks first).
        result.put("audioCapture", BuildConfig.SCREEN_SHARE_AUDIO && Build.VERSION.SDK_INT >= 29)
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
     * positively-plaintext call. `audio` asks for the system audio too
     * (slice 4); absent or not a boolean means false, so an older page gets a
     * video-only leg. Resolves `{ ok: true, audio }` with the audio's final
     * state: "live", "off" (not asked for), "unsupported" (a build without
     * system audio, or below API 29),
     * "no_permission" (RECORD_AUDIO not held; never requested from here),
     * "no_mic_service" (no microphone-type foreground service, so background
     * capture would be silenced) or "failed". Only the video decides whether
     * the connect itself succeeds.
     */
    @PluginMethod
    fun connect(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("invalid_argument:url")
        val token = call.getString("token") ?: return call.reject("invalid_argument:token")
        val quality = call.getObject("quality") ?: return call.reject("invalid_argument:quality")
        val e2ee = call.getObject("e2ee")
        val audio = call.getBoolean("audio", false) == true

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
            // The guards above ran on the plugin thread, and this launch is
            // queued behind whatever Main already holds. Every [tearDown]
            // nulls `consentIntent`, so a different value here means one ran
            // in between: a page-start teardown (this connect came from the
            // dying page, and connecting now would start a leg with no JS
            // owner), [handleOnDestroy], or a stop. Re-checked on Main, where
            // the field is written. Normal flows keep the same object: a
            // failed connect restores the consent it held, and its retry
            // re-captures it above.
            if (consentIntent !== intent) {
                call.reject("connect_failed: cancelled")
                return@launch
            }
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
                doConnect(generation, call, url, token, quality, e2ee, intent, audio)
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
                    // clean up. The consent survives a connect that failed
                    // before the capture setup (probe (e)): the single-use
                    // getMediaProjection only happens at the capture start,
                    // so JS may retry connect() with a fresh token and no new
                    // dialog. tearDown clears the stored consent (right for
                    // an ACTIVE share ending), so restore it around the
                    // cleanup. A failure from the capture setup on finds it
                    // already null: doConnect hands it to the screen track
                    // there, and that track is gone with the attempt.
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
        audioRequested: Boolean,
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
                //
                // No prewarming either: the prewarmer starts the ADM's
                // recording ahead of a publish (`prewarmRecording`), and the
                // leg must never record from the microphone. Set on every
                // leg, audio or not.
                audioOptions = AudioOptions(
                    audioHandler = NoAudioHandler(),
                    disableAudioPrewarming = true,
                ),
            ),
        )
        // The leg never opens the microphone: the WebView call owns it, and a
        // second mic client in this process would fight it. With recording
        // disabled the ADM builds no mic AudioRecord at all and hands the
        // track's buffer callback a zeroed buffer, which [ScreenAudioSource]
        // fills from the playback capture. Done for EVERY leg, before
        // anything can start a recording. `Room.setMicrophoneMute` would
        // still open the mic, and `AudioManager.setMicrophoneMute` would mute
        // the WebView call, so neither is a substitute. If the cast or the
        // call fails, the audio is refused below ("failed"); a video-only leg
        // never records, so it is unaffected. Guarded: a throw here, before
        // this attempt owns the Room, would leak it.
        val micRecordingOff = try {
            val adm = room.lkObjects.audioDeviceModule as? JavaAudioDeviceModule
            adm?.setAudioRecordEnabled(false)
            adm != null
        } catch (_: Throwable) {
            false
        }
        trace("connect adm micRecordingOff=$micRecordingOff")
        // No RTC metrics on the leg. It publishes one screen track, subscribes
        // to nothing and its grant is `can_publish_data: false`, so it needs no
        // telemetry. With metrics on, `collectMetrics` keeps calling
        // `DataChannel.send` while `handleDisconnect` runs `engine.close()`
        // BEFORE cancelling the Room scope that owns the collector: a race on
        // every disconnect, which crashed the leg's WebRTC network thread
        // (SIGSEGV, tombstone 28, crash class B). The post-join coroutine reads
        // the flag once, so it MUST be set before `room.connect`. Re-check on
        // any SDK upgrade: livekit-android 2.28.0 Room.kt:578/1013/1019. On
        // any SDK upgrade also re-check that `removePublishedTrack` disables
        // the cryptor only after the sender is detached, and that
        // `dataChannelEncryptionEnabled` stays off by default.
        room.enableMetrics = false
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
        // The system-audio source, under the same rule: this attempt's own
        // until the hand-over beside `call.resolve` moves it to
        // [screenAudio]. Every throw out of the try below releases it first,
        // superseded or current, since nothing else can reach it.
        var audio: ScreenAudioSource? = null
        // The screen track and its gate, under the same rule: this attempt's
        // own from creation. Copied into [screenVideo]/[screenVideoGate]
        // right before the capture starts, but the attempt keeps its own
        // reference, and every throw out of the try below handles the track
        // through it ([releaseAttemptVideo]), superseded or current: before
        // the copy nothing else can reach it, and after it the fields may
        // already belong to a successor.
        var video: LocalScreencastVideoTrack? = null
        var videoGate: ScreenVideoGate? = null
        try {
            eventsJob?.cancel()
            events = scope.launch {
                room.events.collect { event -> onRoomEvent(event) }
            }
            eventsJob = events

            trace("connect metrics=${room.enableMetrics}")
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

            // The plugin owns the screen track, so the capture can start
            // after the sender witness. The order is create, foreground
            // service, publish, sender witness, single-sender check, admit,
            // and only then the capture start.
            //
            // The gate is a VideoProcessor between the capturer and the
            // track's video source, which feeds every sender of the track,
            // and it starts closed: no frame reaches that source until
            // [ScreenVideoGate.admit] binds it to the witnessed sender's
            // transceiver below.
            val gate = ScreenVideoGate()
            videoGate = gate
            val track = room.localParticipant.createScreencastTrack(
                mediaProjectionPermissionResultData = intent,
                videoProcessor = gate,
                onStop = { stopped ->
                    // System chip / notification Stop / OS revoke, on the
                    // projection's callback thread. The same first step as
                    // the SDK's own wrapper: unpublish the track (guarded,
                    // see [unpublishOnProjectionStop]), after which the SDK
                    // may be renegotiating the publisher. The native
                    // teardown is settled ([SETTLE_MS]): a conservative
                    // heuristic against a suspected race, not a crash fix
                    // (see [SETTLE_MS]). Only if THIS attempt's Room is
                    // still the live share when the launch runs: a late stop
                    // from an earlier share never ends a successor.
                    unpublishOnProjectionStop(room, stopped)
                    scope.launch {
                        if (this@ScreenSharePlugin.room === room) {
                            tearDown("system", settle = true)
                        }
                    }
                },
            )
            video = track
            // The FGS runs with OUR notification (plan section 4.3 step 1,
            // option (a)): the track binds the SDK's own
            // ScreenCaptureService, declared with
            // foregroundServiceType="mediaProjection" via manifest merge,
            // which only builds a default notification when none is passed:
            // exactly one notification on API 34/35/36 (probe (e)). Started
            // before the capture, as the projection requires.
            //
            // The consent now belongs to the track, which consumes it at the
            // capture start (single-use by OS rule).
            consentIntent = null
            track.startForegroundService(NOTIFICATION_ID, buildNotification())
            // The service bind suspends: a stop may have landed meanwhile.
            ensureConnectCurrent(generation)
            // Published BEFORE anything is captured. The defaults are the
            // screencast ones: a screencast track picks
            // `screenShareTrackPublishDefaults` and the SCREEN_SHARE source
            // (livekit-android 2.28.0 LocalParticipant.kt:529-534 and
            // :1778-1784), the same options the SDK's wrapper passes.
            val published = room.localParticipant.publishVideoTrack(track)
            // Suspension again: a stop that landed during the publish has
            // already released the plugin's state — the publication is moot,
            // and announcing `started` for it would resurrect the share in JS.
            ensureConnectCurrent(generation)
            if (published != true) {
                throw IllegalStateException("screen share publish refused")
            }

            // The sender witness, BEFORE the capture starts. The SDK attaches
            // the sender's frame cryptor synchronously inside the publish
            // (`Room.onTrackPublished`), and getLatestKeyIndex gave it the
            // current index. First re-assert the send index on the live
            // sender cryptor(s): verify rather than trust (section 0-R.6),
            // since a cryptor at the wrong index encrypts under a key the wrong
            // epoch's members hold. Then require THIS sender's own cryptor,
            // enabled and at the current index. A failed witness fails the
            // whole leg with the capture never started, and the track is NOT
            // unpublished (a renegotiation, crash class A): the catch below
            // handles it and the disconnect does the rest. No retry: the
            // attach is synchronous, so a failure is deterministic.
            //
            // The transceiver is read on both sides of the witness, with or
            // without E2EE, and both reads must be the same non-null object:
            // the gate is admitted for exactly that transceiver.
            if (provider != null) {
                assertSenderKeyIndex(room, currentKeyIndex)
            }
            val before = ScreenTrackAccess.transceiverOf(track)
            if (provider != null &&
                !senderCryptorWitnessed(room, Track.Source.SCREEN_SHARE, currentKeyIndex)
            ) {
                throw IllegalStateException("screen sender cryptor not witnessed")
            }
            // No suspension since the publish check; checked again so the
            // admit and the capture start sit directly behind one.
            ensureConnectCurrent(generation)
            val after = ScreenTrackAccess.transceiverOf(track)
            if (before == null || after == null || before !== after) {
                throw IllegalStateException("screen sender transceiver changed")
            }
            // The witnessed sender must stay the track's ONLY one, with or
            // without E2EE: the gate feeds the track's video source, which
            // feeds every sender of the track. See [screenSenderLayoutOk].
            // Fails closed, with the capture never started and, as for the
            // witness, no unpublish.
            if (!screenSenderLayoutOk(room, track)) {
                throw IllegalStateException("screen share sender layout refused")
            }
            // Admitted BEFORE the capture starts, so the first frame is not
            // dropped. admit re-reads the transceiver through the accessor the
            // frames use and throws unless it matches, so a broken accessor
            // fails this connect instead of giving a black share.
            gate.admit(track, after)
            // Into the fields NOW (no suspension since the last generation
            // check), so every stop path reaches the track and its gate from
            // here on, the audio publish below included.
            screenVideo = track
            screenVideoGate = gate
            // The ONLY capture start in this plugin; the projection is
            // obtained here.
            track.startCapture()

            // The first frame, directly behind the capture start and before
            // the audio, so nothing suspends between the audio source's gate
            // opening and the hand-over below. `started` means "capturing",
            // so it resolves only once the gate has passed at least one frame
            // on. A share that was admitted but never forwards (a capture
            // that delivers nothing, a sender that moved) would otherwise
            // read as live while viewers see black. Polled: the flag is set
            // on the capture thread. A stop that bumps the generation ends
            // the wait at the next poll, and the check right after it
            // throws; one that only closes the gate ends it at the timeout.
            val firstFrameBy = SystemClock.elapsedRealtime() + FIRST_FRAME_TIMEOUT_MS
            while (!gate.forwardedAny &&
                generation == connectGeneration &&
                SystemClock.elapsedRealtime() < firstFrameBy
            ) {
                delay(FIRST_FRAME_POLL_MS)
            }
            ensureConnectCurrent(generation)
            if (!gate.forwardedAny) {
                throw IllegalStateException("no first frame")
            }

            // System audio (slice 4): after the video is up and keyed, before
            // `started`, so the resolve carries the audio's final state. The
            // exception taxonomy is deliberate. Audio-only failures (the
            // refusals, a missing projection, the source or track build, a
            // publish that returns false or throws) leave the audio "failed"
            // and the video running. Cancellation is rethrown. A throw from
            // the post-publish key-index assertion fails the WHOLE leg: by
            // then a second E2EE sender is on air, and one that refuses its
            // key index is a hole for the video's cryptor too.
            var audioState = if (audioRequested) screenAudioRefusal(micRecordingOff) else "off"
            if (audioState == null && Build.VERSION.SDK_INT >= 29) {
                audioState = "failed"
                // Set from the ADM record thread if the source fails while
                // its gate is still closed. The marshalled report drops
                // anything that arrives before the hand-over (there is no
                // live audio to report yet), so the gate checks this instead.
                val failedEarly = AtomicBoolean(false)
                var audioPublished = false
                try {
                    // The projection the video capture holds since its start
                    // above, read off this attempt's own track. The
                    // playback capture rides on it; stopping the video
                    // capturer stops it, which is why every stop path
                    // releases the source first.
                    val capturer = track.capturer as? ScreenCapturerAndroid
                    val projection = capturer?.mediaProjection
                        ?: throw IllegalStateException("no media projection")
                    val source = ScreenAudioSource(projection) {
                        failedEarly.set(true)
                        scope.launch { onScreenAudioLost(room, "failed") }
                    }
                    audio = source
                    val audioTrack = room.localParticipant.createAudioTrack(
                        "screen_audio",
                        LocalAudioTrackOptions(
                            noiseSuppression = false,
                            echoCancellation = false,
                            autoGainControl = false,
                            highPassFilter = false,
                            typingNoiseDetection = false,
                        ),
                    )
                    // Before the publish, so the first buffer the ADM asks
                    // for already goes through the (closed) gate.
                    audioTrack.setAudioBufferCallback(SourceCallback(source))
                    // RED off: livekit-client never sends RED under E2EE
                    // (`disableRed: this.isE2EEEnabled || ...`), so the web
                    // viewers' decrypt path is only proven without it. DTX
                    // off: it is built for speech pauses, and playback audio
                    // has none worth cutting to comfort noise.
                    audioPublished = room.localParticipant.publishAudioTrack(
                        audioTrack,
                        AudioTrackPublishOptions(
                            name = "screen_audio",
                            audioBitrate = 96_000,
                            dtx = false,
                            red = false,
                            source = Track.Source.SCREEN_SHARE_AUDIO,
                        ),
                    )
                } catch (t: Throwable) {
                    if (t is ConnectCancelled || t is CancellationException) throw t
                    trace("audio publish failed ${t.javaClass.simpleName}")
                }
                // A stop that landed during the audio publish has already
                // released the plugin's state, as after the video publish.
                ensureConnectCurrent(generation)
                val source = audio
                if (audioPublished && source != null) {
                    // E2EE: the audio sender's cryptor exists by now (the
                    // SDK attaches it synchronously inside the publish), and
                    // getLatestKeyIndex gave it the current index. Verify
                    // rather than trust, as for the video. Outside the
                    // audio-only catch on purpose: a throw here ends the leg.
                    if (provider != null) {
                        assertSenderKeyIndex(room, currentKeyIndex)
                    }
                    // The gate opens only on a witness that THIS sender is
                    // keyed, enabled and at the current index. Before that
                    // the source feeds zeros, so nothing but digital silence
                    // can leave the phone, encrypted or not.
                    val witnessed = provider == null ||
                        senderCryptorWitnessed(
                            room,
                            Track.Source.SCREEN_SHARE_AUDIO,
                            currentKeyIndex,
                        )
                    if (witnessed && !failedEarly.get()) {
                        source.openGate()
                        audioState = "live"
                    } else {
                        trace("audio gate kept closed witnessed=$witnessed")
                    }
                }
                if (audioState != "live") {
                    // Never unpublished (a renegotiation, crash class A) and
                    // never unset as the buffer callback: released, it sends
                    // only silence until the Room goes.
                    releaseAudio(audio)
                    audio = null
                    // A publication that made it on air (the witness failed,
                    // the source failed before the gate opened, or the
                    // publish threw after registering it) is marked muted, so
                    // viewers never show that silence as playing. A no-op
                    // when nothing was published. Guarded inside, so it can
                    // never end the video.
                    muteSilentAudio(room)
                }
            }
            trace("audio state=$audioState")

            ensureConnectCurrent(generation)
            // Hand-over: from here the share owns the source. Same
            // non-suspending stretch as the resolve, so no stop can land
            // between the two.
            screenAudio = audio
            audio = null
            notifyListeners("started", JSObject())
            val ok = JSObject()
            ok.put("ok", true)
            ok.put("audio", audioState ?: "failed")
            call.resolve(ok)
        } catch (t: Throwable) {
            // Released on EVERY path, superseded or current, before anything
            // else: a source still held here was never handed over, so
            // nothing else will release it, and a superseded attempt's
            // [discardRoom] is about to stop the video capture under it.
            // Idempotent, so the release in [discardRoom] is harmless.
            releaseAudio(audio)
            // Then the screen track this attempt created, through its OWN
            // reference and never through a field, on every path too:
            // stopped, and disposed when no publication holds it (see
            // [releaseAttemptVideo]). After the audio, which rides on its
            // projection; before any disconnect below, which would unpublish
            // it and blur published from unpublished. Harmless again in
            // [discardRoom] and in a current attempt's tearDown.
            releaseAttemptVideo(room, video, videoGate)
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
                discardRoom(
                    room,
                    alreadyReleased = releasedRoom === room,
                    audio = audio,
                    video = video,
                    gate = videoGate,
                )
            }
            throw t
        }
    }

    /**
     * Stop a screen capture, before the Room that owns it goes away. BY
     * REFERENCE whenever the caller holds the track ([video]: the share's
     * [screenVideo], or a discarded attempt's own local), which reaches it
     * whatever the SDK has done to its publication: a full reconnect drops
     * the publication while the capture keeps running. Only without a
     * reference does it fall back to the publication lookup: a teardown
     * that lands before the attempt copied its track into the fields. That
     * attempt, cancelled at its next check, then handles its own track in
     * its catch ([releaseAttemptVideo]), including one the lookup cannot see
     * because it never reached `trackPublications` (a stop landing
     * mid-publish).
     *
     * Order: the system-audio source [audio] first (below), then [gate]
     * closes for good, then the capture stops. The closed gate alone keeps
     * every later frame from the track's video source; the capture stop
     * ends the projection.
     *
     * Redundant with `disconnect()` for any published track
     * (`LocalParticipant.cleanup()` stops and disposes it). Its value is
     * timing: it stops the capture immediately on paths where the
     * disconnect is deferred (the settle paths, and `discardRoom` while a
     * disposal is pending). Harmless twice: the gate close and the capture
     * stop are idempotent, and every step is guarded ([closeVideoGate],
     * [stopVideoCapture]).
     *
     * Not suspending, but it can BLOCK. By reference it is the capturer's
     * own stop, which posts to the capture thread and waits for it there.
     * The fallback `Track.stop()` reaches `executeBlockingOnRTCThread` (via
     * `setEnabled`), so on the permission branch Main can park behind
     * `LK_RTC_THREAD` while the SDK renegotiates (tombstone 27). An ANR
     * exposure, pre-existing.
     *
     * 🔴 MUST STAY NON-SUSPENDING — see [tearDown]'s invariant. `Track.stop()`
     * and `LocalVideoTrack.stopCapture` are both plain (non-`suspend`) calls
     * in livekit-android 2.28.0 (checked against the sources, not assumed).
     * The SDK's screen-share disable
     * (`setScreenShareEnabled` with false) is NOT usable here: it is
     * `suspend`, and `LocalParticipant` serializes per-source
     * publish/unpublish behind a mutex, so it would block for the whole of
     * an in-flight publish, turning teardown into a suspending section and
     * making every field it has not yet written readable as stale.
     *
     * Device check still owed for the mid-publish stop: one device leg that
     * ends the call from the other participant DURING the publish, then
     * checks the shade and `adb shell dumpsys media_projection`.
     *
     * The system-audio source [audio] is released FIRST, always (a
     * null [room] still releases it). Stopping the video capturer calls
     * `MediaProjection.stop()`, and the playback-capture AudioRecord sits
     * on that projection: stopped under a live capture, it errors on the ADM
     * record thread and would report a failure for a share that is merely
     * ending. Taking the source as a parameter makes every caller decide
     * about the audio before it can stop the video. The audio track itself
     * is NOT stopped or unpublished here: it keeps its sender until the
     * Room disconnects, and the released source keeps pacing zeros into it.
     */
    private fun stopShareCapture(
        room: Room?,
        audio: ScreenAudioSource?,
        video: LocalScreencastVideoTrack?,
        gate: ScreenVideoGate?,
    ) {
        releaseAudio(audio)
        closeVideoGate(gate)
        if (video != null) {
            stopVideoCapture(video)
            return
        }
        if (room == null) return
        try {
            room.localParticipant
                .getTrackPublication(Track.Source.SCREEN_SHARE)
                ?.track
                ?.stop()
        } catch (_: Throwable) {}
    }

    /** Close a [ScreenVideoGate] for good; null-safe, idempotent,
     *  non-suspending and guarded like every teardown step. Safe on Main at
     *  any time, including inside `onRoomEvent`. */
    private fun closeVideoGate(gate: ScreenVideoGate?) {
        try {
            gate?.close()
        } catch (_: Throwable) {}
    }

    /** Stop a screen track's capture by reference: the capturer's own stop
     *  (`LocalVideoTrack.stopCapture`), the only place this plugin calls it.
     *  Null-safe, idempotent (a second stop finds nothing running), and
     *  guarded: on a disposed track the capturer throws, and an SDK throw
     *  inside `onRoomEvent` would crash the app. Non-suspending; it can
     *  block on the capture thread (see [stopShareCapture]). Leaves the
     *  track, its foreground service and its publication to the Room's
     *  disconnect. */
    private fun stopVideoCapture(video: LocalScreencastVideoTrack?) {
        try {
            video?.stopCapture()
        } catch (_: Throwable) {}
    }

    /**
     * The [doConnect] catch's handling of the screen track that attempt
     * created, through the attempt's own reference (never a field: by then
     * the fields may hold a successor's). It mirrors the SDK wrapper's own
     * failure cleanup (livekit-android 2.28.0 LocalParticipant.kt:427-435),
     * keyed on whether a publication still holds the track and NOT on the
     * publish result, since the publish can throw after it registered the
     * publication. The gate closes first either way.
     *  - Published: only the capture stops, now. The Room's disconnect
     *    (`LocalParticipant.cleanup()`) stops and disposes the track.
     *  - Not published: nothing else would ever reach it, so it is stopped
     *    and disposed here; `stop()` also unbinds the screen-capture
     *    foreground service. The capture stops before the dispose, always
     *    (`VideoSource.dispose()` drops the processor).
     *
     * `localTrackPublications`, which the SDK keys its own check on, is
     * private in 2.28.0; this reads the public `trackPublications` map it
     * is derived from. An unreadable map counts as "not published": a
     * second dispose is caught by the SDK, a track left running is not.
     *
     * Harmless twice. Once the fields hold the track, a current attempt's
     * tearDown (from [connect]'s catch) reaches it too, and the gate close
     * and the capture stop are idempotent. The dispose happens only on the
     * unpublished branch; a disconnect reaches such a track only when the
     * SDK parked it for a republish, and its cleanup catches the second
     * dispose. Every step guarded; non-suspending.
     */
    private fun releaseAttemptVideo(
        room: Room,
        video: LocalScreencastVideoTrack?,
        gate: ScreenVideoGate?,
    ) {
        closeVideoGate(gate)
        if (video == null) return
        val published = try {
            room.localParticipant.trackPublications.values.any { it.track === video }
        } catch (_: Throwable) {
            false
        }
        stopVideoCapture(video)
        trace("attempt screen track released published=$published")
        if (published) return
        try {
            video.stop()
        } catch (_: Throwable) {}
        try {
            video.dispose()
        } catch (_: Throwable) {}
    }

    /** The SDK wrapper's first step on a MediaProjection stop, kept for a
     *  track this plugin owns: unpublish it, with the SDK's own default of
     *  stopping it too. Runs on the projection's callback thread, as the
     *  wrapper's does. Guarded: a throw there would end the process. */
    private fun unpublishOnProjectionStop(room: Room, track: Track) {
        try {
            room.localParticipant.unpublishTrack(track)
        } catch (_: Throwable) {}
    }

    /** Release a system-audio source; null-safe, idempotent, non-suspending
     *  and guarded like every teardown step. The version check is for lint
     *  only: a source can only exist on API 29+. */
    private fun releaseAudio(audio: ScreenAudioSource?) {
        if (audio != null && Build.VERSION.SDK_INT >= 29) {
            try {
                audio.release()
            } catch (_: Throwable) {}
        }
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
     *  pending, only the capture stop happens here. That pending
     *  [disposeDetached] disconnects, disposes and releases the Room itself,
     *  and disconnecting now would bypass the settle window (a heuristic,
     *  see [SETTLE_MS]).
     *  The attempt's system-audio source [audio] goes first, inside
     *  [stopShareCapture] and so before the video stop and before the
     *  pending-disposal return: no disposal ever learns of it. The
     *  attempt's own screen track [video] and its [gate] follow in the same
     *  call, by reference, before anything else touches the Room (the catch
     *  has already handled them through [releaseAttemptVideo], so this stop
     *  is the idempotent second one).
     *  MUST stay non-suspending, like [tearDown]. */
    private fun discardRoom(
        room: Room,
        alreadyReleased: Boolean,
        audio: ScreenAudioSource?,
        video: LocalScreencastVideoTrack?,
        gate: ScreenVideoGate?,
    ) {
        stopShareCapture(room, audio, video, gate)
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
                // NEW is the pre-key transient, during which
                // discardFrameWhenCryptorNotReady drops that sender's
                // frames. The screen capture starts only after the screen sender's
                // cryptor is witnessed at the current key index, the track
                // keeps that sender as its only one, and the video gate
                // forwards only while that holds; the audio source's gate
                // likewise opens only after its own sender's witness (see
                // [doConnect]). Everything else that is not OK
                // is a sender that cannot be trusted, and the leg must fail
                // closed, never keep publishing (§4.3 step 3).
                //
                // Deliberately NOT filtered by source: an error on the
                // system-audio sender ends the whole leg too, video included.
                // Both senders share one key ring and one index; a cryptor
                // that cannot be trusted says nothing good about the other,
                // and dropping only the audio would keep publishing under
                // exactly the state this branch exists to refuse.
                if (event.state != E2EEState.OK && event.state != E2EEState.NEW) {
                    scope.launch { tearDown("error") }
                }
            }
            is RoomEvent.Reconnecting -> {
                // A FULL reconnect has begun, and the share ends here, before
                // the SDK can put any of it back on air. In livekit-android
                // 2.28.0 this event comes only from `onEngineReconnecting`,
                // which the engine calls only on its full-reconnect branch
                // (RTCEngine.kt:615-620; Room.kt:1191-1194). A RESUME (the
                // common network blip, which keeps the senders) goes through
                // `onEngineResuming`, which Room does not override, so it
                // posts no room event at all and never reaches this branch.
                //
                // Why not wait for Reconnected: `prepareForFullReconnect`
                // drops the publications but keeps the tracks running, and
                // `onPostReconnect -> republishTracks` publishes them again
                // on NEW senders, the video and then the audio, AFTER
                // Reconnected is posted. Nobody has witnessed those senders'
                // cryptors, and what reaches them first would then depend on
                // SDK timing. Neither gate may ever be open on an unwitnessed
                // sender, so both close right here, synchronously: the audio
                // source is released first (released, it only paces zeros),
                // then the video gate closes for good and the capture stops,
                // by reference, since the publication a lookup would need is
                // already gone. The teardown that follows disconnects at
                // once (not settled), and that disconnect cancels the
                // reconnect job, which pre-empts the republish of both
                // senders. Same reason and toast as the Reconnected backstop
                // below (probe (c-iv) already showed a full reconnect ends
                // the share).
                //
                // Launched, like every other teardown from this collector,
                // and only if THIS share is still the live one when it runs
                // (see the permission branch). Taking [screenAudio] out of
                // the field first leaves the teardown nothing to release,
                // and a queued audio-loss report nothing to report. The
                // video fields stay set: the teardown takes them, and its
                // second gate close and capture stop are no-ops.
                //
                // Only the live share's own Room may take its audio. The
                // field read below is synchronous, ahead of the launched
                // same-share check, so a Reconnecting from any other Room (a
                // collector that outlived its attempt) would otherwise
                // release the live share's source. Checked first, before
                // anything is touched.
                if (event.room !== room) return
                val audio = screenAudio
                screenAudio = null
                releaseAudio(audio)
                closeVideoGate(screenVideoGate)
                stopVideoCapture(screenVideo)
                trace("full reconnect began audioReleased=${audio != null}")
                scope.launch {
                    if (this@ScreenSharePlugin.room === room) {
                        tearDown("disconnected")
                    }
                }
            }
            is RoomEvent.Reconnected -> {
                // The backstop only. The Reconnecting branch above ends the
                // share when the full reconnect BEGINS, so a live share
                // should never see this event; reaching it means that event
                // was missed or handled late. On a full reconnect the SDK
                // unpublishes the screencast but keeps the still-running
                // track for its own `republishTracks`, which WOULD put it
                // back on air on a new sender whose cryptor nobody has
                // witnessed. So this ends the share ALWAYS, with or without
                // a screen publication: a share is never carried across a
                // full reconnect, which is also why there is no key-index
                // re-assertion here any more (that kept a republished share
                // alive). Deliberately NOT settled: the immediate disconnect
                // is what pre-empts the republish. A deferred one would let
                // the screen return for up to [SETTLE_MS] after
                // `stopped{disconnected}`, under a key that no longer
                // receives rotations. (The immediate teardown can still race
                // the republish: a recorded residual. The gate narrows it:
                // from the moment the track's transceiver is cleared or
                // replaced, it drops every frame for good.)
                //
                // Same guards as the Reconnecting branch: only this share's
                // own Room may end it, and only while it is still the live
                // share when the launch runs.
                if (event.room !== room) return
                scope.launch {
                    if (this@ScreenSharePlugin.room === room) {
                        tearDown("disconnected")
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
                // `source` tells JS whether the video or the system audio
                // was muted; each gets its own copy.
                // A mute this plugin set itself ([muteSilentAudio]) is not a
                // server mute, and JS already knows that audio's state, so
                // it is skipped, here and in the unmute arm.
                if (event.participant === room.localParticipant &&
                    event.publication.sid !in selfMutedSids
                ) {
                    val data = JSObject()
                    data.put("muted", true)
                    sourceName(event.publication.source)?.let { data.put("source", it) }
                    notifyListeners("muted", data)
                }
            }
            is RoomEvent.TrackUnmuted -> {
                if (event.participant === room.localParticipant &&
                    event.publication.sid !in selfMutedSids
                ) {
                    val data = JSObject()
                    data.put("muted", false)
                    sourceName(event.publication.source)?.let { data.put("source", it) }
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
                        // Settled ([SETTLE_MS]): only the logical stop
                        // happens now, the native half later. A conservative
                        // heuristic against our disconnect landing under the
                        // forced unpublish's renegotiation; it does not
                        // prevent either observed crash class (see
                        // [SETTLE_MS]).
                        //
                        // The video gate closes NOW, at arrival, ahead of the
                        // launch: a revoked share forwards no further frame,
                        // however long Main takes to reach the teardown.
                        closeVideoGate(screenVideoGate)
                        scope.launch {
                            if (this@ScreenSharePlugin.room === room) {
                                tearDown("revoked", settle = true)
                            }
                        }
                    } else if (p.canPublishSources.isNotEmpty() &&
                        Track.Source.SCREEN_SHARE_AUDIO !in p.canPublishSources
                    ) {
                        // The audio alone was revoked, the video stays
                        // allowed: an audio-only loss, never a stop. Same
                        // empty-list rule as above. Reported through the
                        // grace-guarded path the unpublish below also takes,
                        // so the two together still report once.
                        onScreenAudioLost(room, "lost")
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
                // the Reconnecting branch ends that share), in disconnect
                // cleanup (state already DISCONNECTED), and when
                // MediaProjection stops (the plugin's own onStop unpublishes
                // the track, then launches the teardown that reports
                // "system"). The first two are excluded HERE, by requiring
                // CONNECTED when the event arrives: checking it only after
                // the wait would let a full reconnect that completes inside
                // the grace pass as a revoke.
                // The system stop happens while CONNECTED, so it cannot be
                // told apart on the spot; the grace period covers it, and the
                // re-check after the wait reports "revoked" only for a leg that
                // is still THIS share, still CONNECTED, and still has no screen
                // publication. The wait sits in the launched coroutine, never
                // inside tearDown (see its invariant).
                if (event.participant === room.localParticipant &&
                    event.publication.source == Track.Source.SCREEN_SHARE
                ) {
                    // The video gate closes at arrival, before the state
                    // checks and the grace below: whatever unpublished it (a
                    // forced unpublish, a full reconnect, the system stop,
                    // disconnect cleanup), the track is off its witnessed
                    // sender and forwards nothing more.
                    closeVideoGate(screenVideoGate)
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
                            // Settled like the permission branch (see
                            // [SETTLE_MS]; a heuristic, not a crash fix). The
                            // disposal runs UNPUBLISH_GRACE_MS + SETTLE_MS
                            // after the unpublish.
                            tearDown("revoked", settle = true)
                        }
                    }
                }
                // The system-audio publication gone on its own: the audio
                // branch of the same bound. Every exclusion above carries
                // over (CONNECTED at arrival, the grace, the same-share
                // re-check), plus one: it reports only while the SCREEN
                // publication is still present. A Video revoke unpublishes
                // both tracks, and that is the revoke path's single toast,
                // not an audio loss on top of it.
                if (event.participant === room.localParticipant &&
                    event.publication.source == Track.Source.SCREEN_SHARE_AUDIO
                ) {
                    // The source's gate closes at arrival, ahead of the grace
                    // in [onScreenAudioLost]: zeros from the next buffer on,
                    // whatever that path then decides.
                    // A source exists only on API 29+; the check is for lint.
                    if (Build.VERSION.SDK_INT >= 29) screenAudio?.closeGate()
                    trace("local screen audio unpublished state=${room.state} stopping=$stopping")
                    onScreenAudioLost(room, "lost")
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
     * Why a requested system audio cannot start, or null if it may. Checked
     * in this order, so the state names the first thing the user can act on.
     * RECORD_AUDIO is only read, never requested: a prompt mid-connect would
     * outlive the 10 s leg token, and the WebView call asked for it already.
     * [VoiceCallService.micForegroundActive]: without a microphone-type
     * foreground service the OS silences a background playback capture, so
     * starting one would publish silence while reporting "live".
     * [BuildConfig.SCREEN_SHARE_AUDIO] comes first: a build with the system
     * audio switched off refuses it here, whatever the page asked for.
     */
    private fun screenAudioRefusal(micRecordingOff: Boolean): String? = when {
        !BuildConfig.SCREEN_SHARE_AUDIO -> "unsupported"
        Build.VERSION.SDK_INT < 29 -> "unsupported"
        !micRecordingOff -> "failed"
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED -> "no_permission"
        !VoiceCallService.micForegroundActive -> "no_mic_service"
        else -> null
    }

    /**
     * The witness [doConnect] holds each sender to before anything captured
     * may reach it: the screen video's (the capture starts only after it)
     * and the system audio's (its source's gate opens only after it). The
     * [source] publication's OWN sender cryptor, found by its key in the
     * manager's map (the publication sid and the leg's identity, as
     * `E2EEManager` stores it), enabled, and at [index]. Read through the
     * same reflection as [senderCryptors]. Anything missing or unreadable is
     * "not witnessed", never a pass: a cryptor that is absent or disabled
     * does not encrypt that sender's frames.
     */
    private fun senderCryptorWitnessed(room: Room, source: Track.Source, index: Int): Boolean {
        return try {
            val manager = room.e2eeManager ?: return false
            if (!manager.enabled) return false
            val pub = room.localParticipant
                .getTrackPublication(source) ?: return false
            val identity = room.localParticipant.identity ?: return false
            val key = Pair(pub.sid, identity)
            val cryptor = frameCryptorMap(manager).entries
                .firstOrNull { it.key == key }
                ?.value ?: return false
            cryptor.isEnabled && cryptor.keyIndex == index
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * Whether [track], just published, has exactly ONE sender: the one whose
     * cryptor [doConnect] witnessed. [ScreenVideoGate] controls what reaches
     * the track's video source, and that source feeds every sender of the
     * track, so the track must keep that one sender for the whole share.
     * The conditions below are read from the Room, from the publication's
     * options (which do not change after its publish) and from the track's
     * transceivers, so they hold for the rest of the share too. Checked
     * against livekit-android 2.28.0. Non-suspending; anything missing or
     * unreadable, or any throw, is false (fail closed).
     */
    private fun screenSenderLayoutOk(room: Room, track: LocalScreencastVideoTrack): Boolean {
        return try {
            if (room.dynacast) return false
            val pub = room.localParticipant
                .getTrackPublication(Track.Source.SCREEN_SHARE) ?: return false
            if (pub.track !== track) return false
            val options = pub.options as? VideoTrackPublishOptions ?: return false
            options.videoCodec.equals("vp8", ignoreCase = true) &&
                options.backupCodec == null &&
                ScreenTrackAccess.extraTransceiverCountOf(track) == 0
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * An audio-only loss: the system-audio publication unpublished or its
     * source revoked while the video stays, or the source failing mid-share
     * ([state] "failed", marshalled here from the ADM record thread). The
     * mirror of the video's `TrackUnpublished` bound: CONNECTED at arrival,
     * [UNPUBLISH_GRACE_MS] of grace, then it releases the source and emits
     * `audio` only if this is still the same share, not stopping, still
     * CONNECTED, still holding live audio, and still publishing its SCREEN
     * track. The last check is what keeps a Video revoke or a system stop
     * (both take the audio down with the video) at the stop path's single
     * toast, and the grace is what lets that stop path win the race.
     * Nulling [screenAudio] makes the first report the only one: an
     * unpublish, a permission change and a capture error for one loss all
     * land here. A failure from a source whose gate never opened finds
     * [screenAudio] null and is dropped; [doConnect] checks for that itself.
     * The source is never unset as the buffer callback and its track is never
     * unpublished from here (a renegotiation; see crash class A). A
     * publication still on air is marked muted instead ([muteSilentAudio]),
     * so viewers never show the released source's silence as playing.
     */
    private fun onScreenAudioLost(room: Room, state: String) {
        if (this.room !== room || stopping || screenAudio == null ||
            room.state != Room.State.CONNECTED
        ) {
            return
        }
        scope.launch {
            delay(UNPUBLISH_GRACE_MS)
            val audio = screenAudio
            if (audio == null ||
                this@ScreenSharePlugin.room !== room ||
                stopping ||
                room.state != Room.State.CONNECTED ||
                room.localParticipant.getTrackPublication(Track.Source.SCREEN_SHARE) == null
            ) {
                return@launch
            }
            screenAudio = null
            releaseAudio(audio)
            trace("audio lost state=$state")
            // After the same-share checks above, so it only ever touches
            // this share's Room. A no-op once the publication is gone.
            muteSilentAudio(room)
            try {
                val data = JSObject()
                data.put("state", state)
                notifyListeners("audio", data)
            } catch (_: Throwable) {}
        }
    }

    /**
     * Mark [room]'s system-audio publication muted: a track that stays on
     * air but will only ever carry silence, because its gate never opened in
     * [doConnect] or its source was lost mid-share ([onScreenAudioLost]).
     * Viewers then show it muted instead of playing. The track is neither
     * unpublished (a renegotiation, crash class A) nor stopped.
     *
     * The sid is recorded in [selfMutedSids] BEFORE the mute, so the
     * `TrackMuted` the SDK re-posts for it (asynchronously, through the
     * Room's event bus) is skipped rather than reported to JS as a server
     * mute. A no-op when there is no audio publication.
     *
     * Not suspending, but it can BLOCK: the setter
     * (`LocalTrackPublication.muted`, public in livekit-android 2.28.0)
     * disables the track on the RTC thread, the same class as `Track.stop()`
     * in [stopShareCapture]. Guarded on its own and never throws: a failure
     * costs the badge alone, never the video. Never called from [tearDown],
     * [stopShareCapture] or [discardRoom]: a share that is ending needs no
     * mute.
     */
    private fun muteSilentAudio(room: Room) {
        try {
            val pub = room.localParticipant
                .getTrackPublication(Track.Source.SCREEN_SHARE_AUDIO) ?: return
            selfMutedSids.add(pub.sid)
            pub.muted = true
            trace("audio publication muted")
        } catch (t: Throwable) {
            trace("audio mute failed ${t.javaClass.simpleName}")
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
     * It was briefly violated by calling the SUSPENDING screen-share disable
     * (`setScreenShareEnabled` with false) from the capture stop, and the
     * cost was immediate and deterministic rather than theoretical:
     * `LocalParticipant` serializes per-source publish/unpublish behind a
     * mutex, so a teardown during a publish blocked until that publish
     * finished, and the abandon path then read `releasedRoom` before this
     * had written it, releasing the same native Room twice, on exactly the
     * stop-during-publish path the capture stop exists to serve. Anything
     * called from here ([stopShareCapture] and its guarded helpers,
     * [disposeDetached]) must stay non-suspending, and so must [discardRoom],
     * which runs on the same ownership scheme from [doConnect]'s abandon path.
     * That includes [releaseAudio] and the `ScreenAudioSource.release()` it
     * calls, which is non-suspending by contract.
     *
     * `settle` splits off the native half. Everything above still happens
     * here, atomically: the generation bump, the claim, the capture stop and
     * the clearing of every plugin field. But the Room's disconnect and
     * release, its sender cryptors and the key ring go to [disposeDetached]
     * [SETTLE_MS] later, through [scheduleDisposal], which holds the only
     * wait (inside its launched coroutine, never here). Only for a teardown
     * that follows a forced unpublish the SDK may still be processing: the
     * two revoke branches and the MediaProjection system stop. Every other
     * caller disposes inline. The deferral was added in wave 4f against a
     * SUSPECTED race (our disconnect/release under that renegotiation);
     * neither observed crash class is that race, so it is a conservative
     * heuristic, not a crash fix (see [SETTLE_MS], including its cost).
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
        // The system audio leaves with the share, released inside
        // [stopShareCapture] BEFORE the video stop (which stops the
        // projection the playback capture rides on). Taken out of the field
        // first, so a queued audio-loss report finds nothing to report.
        val audio = screenAudio
        screenAudio = null
        // The screen track and its gate, taken out of the fields the same
        // way: the gate closes and the capture stops BY REFERENCE inside
        // [stopShareCapture], whatever happened to the publication. Only
        // that non-blocking capture stop happens here, never a dispose: the
        // Room's disconnect stops and disposes a published track.
        val video = screenVideo
        screenVideo = null
        val gate = screenVideoGate
        screenVideoGate = null
        // Stop the capture before the Room goes. Redundant with
        // `disconnect()` for any published track (`LocalParticipant.cleanup()`
        // stops it). Its value is timing: it stops the capture immediately on
        // paths where the disconnect is deferred (the settle paths, and
        // `discardRoom` while a disposal is pending).
        // Diagnostic: whether a screen publication still existed when the
        // capture stop ran, and whether it stopped by reference. No
        // identity, no key material.
        val hadScreenPub =
            room?.localParticipant?.getTrackPublication(Track.Source.SCREEN_SHARE) != null
        stopShareCapture(room, audio, video, gate)
        trace("tearDown capture stopped screenPub=${hadScreenPub} byRef=${video != null}")
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
        // The share's self-mutes end with it; the collector that would have
        // read them is already cancelled above.
        selfMutedSids.clear()
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
     * Hands the ADM's buffers to a [ScreenAudioSource].
     * `LocalAudioTrack.setAudioBufferCallback` takes livekit-android's own
     * `io.livekit.android.audio.AudioBufferCallback`, a different interface
     * from WebRTC's `JavaAudioDeviceModule.AudioBufferCallback` with the same
     * method, so the source cannot be passed directly. One extra virtual call
     * per 10 ms buffer, on the ADM record thread. Holds no state of its own.
     */
    @RequiresApi(29)
    private class SourceCallback(private val source: ScreenAudioSource) : AudioBufferCallback {
        override fun onBuffer(
            buffer: ByteBuffer,
            audioFormat: Int,
            channelCount: Int,
            sampleRate: Int,
            bytesRead: Int,
            captureTimeNs: Long,
        ): Long = source.onBuffer(buffer, audioFormat, channelCount, sampleRate, bytesRead, captureTimeNs)
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

    /**
     * Ends the leg whenever a new page starts loading in the WebView. A full
     * page load (a `window.location.assign` from FlowLogin or Connections, a
     * reload) replaces the JS that owned the leg, and the new page has no
     * `#androidLeg`: its rotations return early, so nothing re-keys the leg,
     * and only the server's best-effort eviction on primary leave would end
     * it. Until then it keeps encrypting under the dying page's epoch key
     * (stage-6 MAJOR, wave 4i).
     *
     * Registered HERE, not in `load()`: Capacitor calls `load()` inside the
     * `Bridge` constructor (`registerAllPlugins`), and `Bridge.Builder.create()`
     * then REPLACES the listener list with its own (`setWebViewListeners`,
     * Capacitor 8.4.3 Bridge.java:1623), so a listener added there is silently
     * dropped. `handleOnStart` runs from the Activity's `onStart`, after
     * `create()` has returned; missing the cold-start page that began loading
     * before it is harmless (no leg exists yet). It fires on main-frame full
     * loads only, on the main thread, after `bridge.reset()` and before the
     * new page's JS runs.
     *
     * Reason `null`: no `stopped` event, because nothing on the new page owns
     * the leg. The call is UNCONDITIONAL and must stay so: with no Room (a
     * cold start, or a share already ended) [tearDown] only bumps the
     * generation and clears empty fields; the bump cancels only an attempt
     * the dying page started; a settled disposal still pending in
     * [pendingDisposals] is left to its timer. The trace sits outside the
     * launch so the log shows the listener fired even if Main is busy.
     */
    override fun handleOnStart() {
        super.handleOnStart()
        if (pageListenerRegistered) return
        pageListenerRegistered = true
        bridge.addWebViewListener(object : WebViewListener() {
            override fun onPageStarted(webView: WebView) {
                trace("page started")
                scope.launch { tearDown(null) }
            }
        })
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
         *  it: the plugin's own onStop unpublishes the track and then
         *  launches tearDown("system"), which runs within milliseconds and
         *  clears `room`, so the post-wait same-Room check fails. A full
         *  reconnect (state RECONNECTING) and disconnect cleanup (state
         *  DISCONNECTED) are not covered by this wait at all; the CONNECTED
         *  check at event arrival excludes them, and the post-wait CONNECTED
         *  check is a second guard. A permission-event revoke that tears down first also clears
         *  `room`. The capture is already stopped, so the wait delays the
         *  toast and also the disposal: a settled revoke from this path is
         *  disposed UNPUBLISH_GRACE_MS + [SETTLE_MS] after the unpublish. */
        private const val UNPUBLISH_GRACE_MS = 1_000L

        /** How long a SETTLED teardown waits before its native half
         *  ([disposeDetached]) runs: the two revoke branches and the
         *  MediaProjection system stop, where the SDK has just unpublished
         *  the screen track and may still be renegotiating the publisher on
         *  its own coroutines. Added in wave 4f against a SUSPECTED race: our
         *  disconnect/release under that in-flight renegotiation. Neither
         *  observed crash class is that race. Class B (LiveKit metrics
         *  `DataChannel.send` racing `engine.close()`) is removed by
         *  `enableMetrics = false` in [doConnect]; class A (SIGABRT) fires
         *  inside the SDK's own renegotiation after the forced unpublish,
         *  before any disconnect of ours. This does NOT prevent a crash. It
         *  is kept as a conservative heuristic, at a cost: the leg's key ring
         *  stays resident, and a connected leg that no longer receives key
         *  rotations stays on the SFU, for up to SETTLE_MS after the teardown
         *  (plus the 1 s [UNPUBLISH_GRACE_MS] on the `TrackUnpublished`
         *  path). livekit-android 2.28.0 exposes no public "publisher
         *  negotiation stable" signal; the local `TrackUnpublished` marks the
         *  end of the synchronous half. On the permission branch the window
         *  is measured from the permission event, which can precede the
         *  forced unpublish. */
        private const val SETTLE_MS = 4_000L

        /** How long [doConnect] waits, right after the capture started and
         *  before the system audio, for the [ScreenVideoGate] to pass its
         *  first frame on before it fails the connect (`no first frame`). A
         *  started share must be a capturing one, not a silent black tile. */
        private const val FIRST_FRAME_TIMEOUT_MS = 4_000L

        /** The poll step of that wait: the gate's flag is written on the
         *  capture thread, so it is read, not awaited. */
        private const val FIRST_FRAME_POLL_MS = 50L

        /** Teardown diagnostics with a monotonic timestamp, so a log ties a
         *  teardown's native steps to the local screen unpublish. Step names,
         *  reasons and counts only: no key material, no identities. */
        private fun trace(step: String) {
            android.util.Log.i("ScreenSharePlugin", "$step t=${SystemClock.elapsedRealtime()}")
        }

        /** A leg publication's source as the bridge names it in `muted`
         *  events; null (the field is left out) for anything a leg does not
         *  publish. */
        private fun sourceName(source: Track.Source): String? = when (source) {
            Track.Source.SCREEN_SHARE -> "screen_share"
            Track.Source.SCREEN_SHARE_AUDIO -> "screen_share_audio"
            else -> null
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

import {
  Accessor,
  batch,
  createContext,
  createRoot,
  createSignal,
  JSX,
  Setter,
  useContext,
} from "solid-js";
import {
  RoomContext,
  TrackReferenceOrPlaceholder,
  useTracks,
} from "solid-livekit-components";

import {
  LocalVideoTrack,
  Room,
  ScreenSharePresets,
  Track,
  type TrackPublishOptions,
  type VideoCaptureOptions,
  VideoResolution,
  isE2EESupported,
} from "livekit-client";
// Self-hosted LiveKit E2EE worker — Vite `?worker` bundling ships it inside
// the npm package (dist/livekit-client.e2ee.worker.mjs), fully first-party,
// NO CDN (§4.1). External worker origins are blocked by the desktop shell CSP
// (slice 6.2b) and violate the no-CDN policy everywhere else.
import E2EEWorker from "livekit-client/e2ee-worker?worker";
import { DenoiseTrackProcessor } from "livekit-rnnoise-processor";

class GainTrackProcessor {
  name = "gain-processor";
  processedTrack: MediaStreamTrack | undefined;
  #gainNode: GainNode | undefined;
  #gainValue: number;
  #ctx: AudioContext | undefined;

  constructor(gain: number) {
    this.#gainValue = gain;
  }

  async init(opts: { track: MediaStreamTrack; audioContext: AudioContext; sourceNode: AudioNode }) {
    this.#ctx = opts.audioContext;
    this.#gainNode = opts.audioContext.createGain();
    this.#gainNode.gain.value = this.#gainValue / 100;
    const dest = opts.audioContext.createMediaStreamDestination();
    opts.sourceNode.connect(this.#gainNode);
    this.#gainNode.connect(dest);
    this.processedTrack = dest.stream.getAudioTracks()[0];
  }

  async destroy() {
    this.#gainNode?.disconnect();
    this.#gainNode = undefined;
    this.processedTrack = undefined;
  }
}
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Channel } from "stoat.js";

/** Native Android foreground service keeping calls alive in the background */
const VoiceCallServiceNative = Capacitor.isNativePlatform()
  ? registerPlugin<{ start(): Promise<void>; stop(): Promise<void> }>(
      "VoiceCallService",
    )
  : undefined;

function nativeCallServiceStart() {
  VoiceCallServiceNative?.start().catch(() => {});
}

function nativeCallServiceStop() {
  VoiceCallServiceNative?.stop().catch(() => {});
}

import {
  type E2EEBridge,
  SoundController,
  nativeE2EEAvailable,
  useClient,
  useSound,
} from "@revolt/client";
import { ReactiveMap } from "@solid-primitives/map";
import { CONFIGURATION } from "@revolt/common";
import { ModalControllerExtended, useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  CameraBackgroundMode,
  CameraQualityName,
  ScreenShareQualityName,
  Voice as VoiceSettings,
} from "@revolt/state/stores/Voice";
import { VoiceCallCardContext } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";

import {
  CameraEffectsController,
  type CameraBackgroundStatus,
} from "./cameraEffects";
import { InRoom } from "./components/InRoom";
import { RoomAudioManager } from "./components/RoomAudioManager";
import { MlsKeyProvider } from "./mlsCallKeys";
import { type MlsMediaBinding, MlsCallSession } from "./mlsCallSession";

type State =
  | "READY"
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING";

type ScreenShareQuality = {
  name: ScreenShareQualityName;
  resolution: VideoResolution;
  fullName: string;
  contentHint: string;
  /**
   * Upper bound on the encoded bitrate (kbps). Without this, LiveKit picks an
   * effectively-uncapped default from the source resolution; at 1440p/4K that
   * saturates a relayed (TURN) publisher path and collapses the peer
   * connection — disconnecting off-LAN callers. Capping keeps the high-res
   * option usable over the relay. LAN publishers rarely hit the cap.
   */
  maxBitrateKbps: number;
};

class Voice {
  #settings: VoiceSettings;
  /** Shared engine that owns the camera track's processor slot + brightness. */
  #cameraEffects = new CameraEffectsController();

  /** Runtime-only: whether the active camera exposes a hardware brightness control. */
  cameraHwBrightness: Accessor<boolean>;
  #setCameraHwBrightness: Setter<boolean>;

  /** Runtime-only: background processor status (intent lives in the store). */
  cameraBackgroundStatus: Accessor<CameraBackgroundStatus>;
  #setCameraBackgroundStatus: Setter<CameraBackgroundStatus>;

  /**
   * Runtime-only: increments AFTER each live camera-effects apply settles (the
   * processed track may have been swapped). The settings preview depends on
   * this to re-read the live track's `mediaStreamTrack` — a bare brightness
   * signal fires on the sync store write, before the async processor swap.
   */
  cameraEffectsApplied: Accessor<number>;
  #setCameraEffectsApplied: Setter<number>;

  channel: Accessor<Channel | undefined>;
  #setChannel: Setter<Channel | undefined>;

  room: Accessor<Room | undefined>;
  #setRoom: Setter<Room | undefined>;

  vidTracks: Accessor<TrackReferenceOrPlaceholder[]>;

  state: Accessor<State>;
  #setState: Setter<State>;

  deafen: Accessor<boolean>;
  microphone: Accessor<boolean>;

  video: Accessor<boolean>;
  #setVideo: Setter<boolean>;

  screenshare: Accessor<boolean>;
  #setScreenshare: Setter<boolean>;

  fullscreen: Accessor<boolean>;
  #setFullscreen: Setter<boolean>;

  focusId: Accessor<string | undefined>;
  #setFocus: Setter<string | undefined>;

  showBar: Accessor<boolean>;
  #setShowBar: Setter<boolean>;

  /** "Theater" mode: only the selected window, no other participants or chrome. */
  immersive: Accessor<boolean>;
  #setImmersive: Setter<boolean>;

  private sound: SoundController;

  private openModal;
  private getClient;
  /** App MFA password prompt — reused to mint the MLS first-publish ticket
   * (slice 6.4); the password is entered natively and never reaches the store. */
  #mfaFlow: ModalControllerExtended["mfaFlow"];
  private screenShareTracks: Set<string>;
  private disposeTrackRoot: (() => void) | undefined;
  #pttKeydown: ((e: KeyboardEvent) => void) | undefined;
  #pttKeyup: ((e: KeyboardEvent) => void) | undefined;
  #vadStream: MediaStream | undefined;
  #vadCtx: AudioContext | undefined;
  #vadFrame: number | undefined;
  #vadSilenceTimer: ReturnType<typeof setTimeout> | undefined;

  // --- Media E2EE (slice 6.3) ---------------------------------------
  // The native-derived key provider + self-hosted worker are constructed per
  // call whenever the shell can do media E2EE (`isE2EESupported()` + a native
  // layer), so the Room is ALWAYS E2EE-capable and `setE2EEEnabled(true/false)`
  // can toggle mode mid-call without a reconnect (§4.1 amendment A4). They are
  // undefined on unsupported/web shells (treated as non-enrolled).
  #mlsKeyProvider: MlsKeyProvider | undefined;
  #e2eeWorker: Worker | undefined;
  /**
   * The MLS control-plane session for this call (slice 6.4). Constructed once
   * the device-qualified identity is proven; drives create-or-join, admission,
   * rotation, roster reconciliation, and the enable gate. Undefined on
   * non-E2EE-capable shells. With `media_e2ee_enabled` off, every `/mls` route
   * returns FeatureDisabled and the session quietly stays plaintext (a normal
   * voice call), so this wiring is inert until 6.5 flips the flag.
   */
  #mlsSession: MlsCallSession | undefined;
  /** Unsubscribe for the native `e2ee:call-keys-changed` push (§3.5). */
  #unlistenCallKeys: (() => void) | undefined;
  /**
   * Monotonic per-`connect()` token. `connect()` awaits (native listen, join,
   * room.connect); a newer `connect()` (which runs `disconnect()` first) bumps
   * this, so a stale invocation resuming after an await can detect it was
   * superseded and bail instead of leaking its worker/listener or reviving an
   * abandoned Room.
   */
  #connectGen = 0;
  /**
   * LiveKit's observed per-participant encryption status (identity → encrypted)
   * — a REQUIRED gating input for the green lock (§4.4 invariant 11: native
   * "keys pushed" is NOT "encryption happened"; only this webview-observed
   * signal witnesses the media plane). Wired in 6.3; the dual-gated chip state
   * machine that consumes it is 6.5.
   */
  readonly callEncryption = new ReactiveMap<string, boolean>();
  /**
   * First latched call-key/encryption error for this call — the STRUCTURED
   * value (native error object or LiveKit error), never stringified, so 6.5
   * can classify rotation-window `RE-SECURING` vs loud `NOT ENCRYPTED`
   * (invariant 11).
   */
  callEncryptionError: Accessor<unknown>;
  #setCallEncryptionError: Setter<unknown>;
  /**
   * Non-enrolled participant identities in the current call (slice 6.4 §3.4) —
   * empty ⇒ every SFU participant is in the MLS group. The state signal where
   * 6.4's roster-reconciliation DETECTION meets 6.5's mixed-call banner + the
   * downgrade UX; driven from the session's `onRosterReconciled`. The session
   * has already PAUSED local publishing (fail-closed) whenever this is
   * non-empty — 6.4 never opens a plaintext path.
   */
  callNonEnrolled: Accessor<readonly string[]>;
  #setCallNonEnrolled: Setter<readonly string[]>;

  constructor(
    voiceSettings: VoiceSettings,
    modals: ModalControllerExtended,
    sound: SoundController,
  ) {
    this.#settings = voiceSettings;
    this.sound = sound;

    const [channel, setChannel] = createSignal<Channel>();
    this.channel = channel;
    this.#setChannel = setChannel;

    const [room, setRoom] = createSignal<Room>();
    this.room = room;
    this.#setRoom = setRoom;

    this.vidTracks = () => [];

    const [state, setState] = createSignal<State>("READY");
    this.state = state;
    this.#setState = setState;

    this.deafen = () => voiceSettings.deafen;
    this.microphone = () => voiceSettings.micOn && !voiceSettings.deafen;

    const [video, setVideo] = createSignal(false);
    this.video = video;
    this.#setVideo = setVideo;

    const [screenshare, setScreenshare] = createSignal(false);
    this.screenshare = screenshare;
    this.#setScreenshare = setScreenshare;

    const [fullscreen, setFullscreen] = createSignal(false);
    this.fullscreen = fullscreen;
    this.#setFullscreen = setFullscreen;

    const [focus, setFocus] = createSignal<string>();
    this.focusId = focus;
    this.#setFocus = setFocus;

    const [showBar, setShowBar] = createSignal(true);
    this.showBar = showBar;
    this.#setShowBar = setShowBar;

    const [immersive, setImmersive] = createSignal(false);
    this.immersive = immersive;
    this.#setImmersive = setImmersive;

    const [hwBrightness, setHwBrightness] = createSignal(false);
    this.cameraHwBrightness = hwBrightness;
    this.#setCameraHwBrightness = setHwBrightness;

    const [bgStatus, setBgStatus] = createSignal<CameraBackgroundStatus>("idle");
    this.cameraBackgroundStatus = bgStatus;
    this.#setCameraBackgroundStatus = setBgStatus;

    const [effectsApplied, setEffectsApplied] = createSignal(0);
    this.cameraEffectsApplied = effectsApplied;
    this.#setCameraEffectsApplied = setEffectsApplied;

    const [callEncryptionError, setCallEncryptionError] =
      createSignal<unknown>();
    this.callEncryptionError = callEncryptionError;
    this.#setCallEncryptionError = setCallEncryptionError;

    const [callNonEnrolled, setCallNonEnrolled] = createSignal<
      readonly string[]
    >([]);
    this.callNonEnrolled = callNonEnrolled;
    this.#setCallNonEnrolled = setCallNonEnrolled;

    this.#cameraEffects.onHwSupportChange = (hw) =>
      this.#setCameraHwBrightness(hw);
    this.#cameraEffects.onImageMissing = () => {
      this.#settings.cameraBackgroundMode = "none";
    };

    this.openModal = modals.openModal;
    this.#mfaFlow = modals.mfaFlow;

    this.getClient = useClient();

    this.screenShareTracks = new Set();
  }

  async connect(channel: Channel, auth?: { url: string; token: string }) {
    this.disconnect();
    // Supersession token: a later connect() runs disconnect() first and bumps
    // this, so a stale invocation resuming after an await can detect it lost
    // and bail (gate HIGH — async-registration race).
    const gen = ++this.#connectGen;

    // Media E2EE (§4.1, amendment A4): construct the Room E2EE-capable on ANY
    // shell that can do media E2EE (`isE2EESupported()` + a native layer),
    // REGARDLESS of whether THIS call is currently E2EE-eligible. LiveKit's
    // `setE2EEEnabled()` THROWS if the `e2ee` option was omitted at
    // construction (the E2EEManager only attaches in the constructor), so
    // omitting it whenever a non-enrolled participant is present would make the
    // §3.4 auto-re-upgrade impossible without a full reconnect. The option is
    // INERT until `setE2EEEnabled(true)` (driven in 6.4/6.5); unsupported
    // shells get no option and are treated as non-enrolled (loud downgrade
    // path), never a silent plaintext Room.
    //
    // Fail-safe (gate HIGH): a worker/provider that cannot construct — e.g.
    // the bundled `?worker` asset blocked by a `worker-src`-less CSP — must
    // NOT break the call. Degrade to a NON-E2EE-capable Room (the same
    // loud-non-enrolled path as an unsupported shell, never a silent plaintext
    // lock) so voice still works.
    //
    // Fail-CLOSED on a no-key-push shell (slice 6.4 step 7, audit H3/NEW-4):
    // `nativeE2EEAvailable()` is TRUE on the Capacitor Android shell, but that
    // shell cannot yet RECEIVE `e2ee:call-keys-changed` (its listener is 6.7),
    // so an E2EE-capable Room there would never install a first local key — the
    // pause-publish window would stay open forever and publish plaintext under
    // an "encrypted" Room (invariant 1). `nativeKeyPushAvailable()` is a
    // SYNCHRONOUS probe decided HERE, at construction (never gated on the async
    // `onCallKeysChanged` return, which resolves too late); a shell without the
    // key-push channel is built as a non-E2EE shell (the loud non-enrolled
    // path). The bridge is sourced once here and reused below.
    const bridge = this.getClient()?.e2ee as E2EEBridge | undefined;
    let e2eeCapable =
      isE2EESupported() &&
      nativeE2EEAvailable() &&
      !!bridge?.nativeKeyPushAvailable();
    if (e2eeCapable) {
      try {
        this.#mlsKeyProvider = new MlsKeyProvider();
        this.#e2eeWorker = new E2EEWorker();
      } catch (error) {
        this.#e2eeWorker?.terminate();
        this.#mlsKeyProvider = undefined;
        this.#e2eeWorker = undefined;
        e2eeCapable = false;
        this.onErr(error);
      }
    }

    // Device-qualified LiveKit identity (slice 6.1/6.4 item 3): source the
    // E2EE device id so `joinCall` mints identity `{user_id}:{device_id}` —
    // MlsKeyProvider's local-last send-key switch matches frame keys by that
    // exact identity. Undefined ⇒ we request no qualified identity (non-E2EE
    // / not-yet-provisioned), and the identity assertion below is skipped.
    const selfUserId = this.getClient()?.user?.id;
    const e2eeDeviceId = e2eeCapable
      ? bridge?.status.get("state")?.device_id
      : undefined;

    const room = new Room({
      e2ee:
        e2eeCapable && this.#mlsKeyProvider && this.#e2eeWorker
          ? { keyProvider: this.#mlsKeyProvider, worker: this.#e2eeWorker }
          : undefined,
      // Stop pushing upstream for tracks nobody is subscribed to — trims
      // wasted bitrate on the (relayed) publisher path. Safe with the manual
      // autoSubscribe:false flow below. adaptiveStream is intentionally left
      // off: it pauses subscribed tracks by attached-element visibility, which
      // the custom PiP/tile/fullscreen renderers here don't reliably signal.
      dynacast: true,
      audioCaptureDefaults: {
        deviceId: this.#settings.preferredAudioInputDevice,
        echoCancellation: this.#settings.echoCancellation,
        noiseSuppression: this.#settings.noiseSupression === "browser",
        autoGainControl: this.#settings.autoGainControl,
      },
      audioOutput: {
        deviceId: this.#settings.preferredAudioOutputDevice,
      },
      videoCaptureDefaults: {
        deviceId: this.#settings.preferredVideoDevice,
      },
    });

    this.disposeTrackRoot?.();
    this.disposeTrackRoot = createRoot((dispose) => {
      this.vidTracks = useTracks(
        [
          { source: Track.Source.Camera, withPlaceholder: true },
          { source: Track.Source.ScreenShare, withPlaceholder: false },
        ],
        { room, onlySubscribed: false },
      );
      return dispose;
    });

    batch(() => {
      this.#setRoom(room);
      this.#setChannel(channel);
      this.#setState("CONNECTING");
      this.#setVideo(false);
      this.#setScreenshare(false);
    });

    room.addListener("connected", () => {
      this.#setState("CONNECTED");
      nativeCallServiceStart();
      this.#startPushToTalk(room);
      this.#startVAD(room);
      const isAfk = channel.name?.toLowerCase() === "afk";
      if (this.speakingPermission)
        room.localParticipant
          .setMicrophoneEnabled(isAfk ? false : (this.#settings.openMic || this.#settings.micOn))
          .then((track) => {
            this.#settings.micOn = track != null;
            if (!isAfk && track?.audioTrack) {
              const gain = this.#settings.microphoneGain ?? 100;
              // Processor/E2EE ordering (§4.3) — DO NOT REORDER: denoise
              // (this AudioWorklet) and camera effects are PRE-encode track
              // processors on the raw media; LiveKit E2EE runs POST-encode on
              // encoded frames (RTCRtpScriptTransform). The fixed pipeline is
              // processor → encoder → E2EE encrypt → SFU, so there is no slot
              // conflict and denoise + E2EE coexist (test T-10). Moving E2EE
              // ahead of the encoder, or a processor after it, would break
              // one or the other.
              if (this.#settings.noiseSupression === "enhanced") {
                track.audioTrack.setProcessor(
                  new DenoiseTrackProcessor({
                    // Self-hosted worklet assets (public/rnnoise/) — never the
                    // package's jsdelivr default: external script origins are
                    // blocked by the desktop shell CSP (slice 6.2b) and violate
                    // the no-CDN policy everywhere else. Must be absolute: the
                    // lib resolves it with base-less `new URL(...)`.
                    workletCDNURL: new URL(
                      CONFIGURATION.RNNOISE_WORKLET_CDN_URL ||
                        `${import.meta.env.BASE_URL}rnnoise/`,
                      window.location.origin,
                    ).href,
                  }),
                );
              } else if (gain !== 100) {
                track.audioTrack.setProcessor(new GainTrackProcessor(gain));
              }
            }
          });
      if (isAfk) room.localParticipant.setCameraEnabled(false);
      for (const p of room.remoteParticipants.values()) {
        const screenShareTrack = p.getTrackPublication(
          Track.Source.ScreenShare,
        );
        if (screenShareTrack) {
          this.screenShareTracks.add(screenShareTrack.trackSid);
        }
      }
      this.sound.playSound("userJoinVoice");
    });

    room.addListener("disconnected", () => {
      this.#setState("DISCONNECTED");
      nativeCallServiceStop();
    });

    room.addListener("participantConnected", (participant) => {
      this.sound.playSound("userJoinVoice");
      // Roster reconciliation (6.4 step 5): a reconnect within leave-grace
      // cancels a pending Remove; a new SFU participant kicks a fresh reconcile.
      this.#mlsSession?.onParticipantJoined(participant.identity);
    });

    room.addListener("participantDisconnected", (participant) => {
      this.sound.playSound("userLeaveVoice");
      // Arm the 10 s leave-grace before removing the departed leaf from the MLS
      // group (a transient blip must not churn remove+rejoin).
      this.#mlsSession?.onParticipantLeft(participant.identity);
    });

    // Fires AFTER LiveKit finishes restarting the camera track for a new
    // device. Re-apply effects here (not on the store write) so hardware
    // brightness — dropped by restart — is re-established on the NEW source.
    room.addListener("activeDeviceChanged", (kind) => {
      if (kind === "videoinput") void this.reapplyCameraEffects();
    });

    room.addListener("trackPublished", (pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        pub.once("subscribed", (track) => {
          // Play the sound once playback starts, which might be quite a bit after subscription
          // as it starts paused for the screen share settings modal.
          track.once("videoPlaybackStarted", () => {
            this.sound.playSound("streamStart");
            if (track.sid) {
              this.screenShareTracks.add(track.sid);
            }
          });
        });
      }
    });

    room.addListener("trackUnpublished", (unpub) => {
      if (this.screenShareTracks.has(unpub.trackSid)) {
        this.sound.playSound("streamEnd");
        this.screenShareTracks.delete(unpub.trackSid);
      }
    });

    // --- Media E2EE wiring (slice 6.3/6.4) ----------------------------
    // The frame-key path + the media-plane observers are wired here; the MLS
    // control-plane session (constructed after room.connect, below) is the SOLE
    // driver of all of it. Inert until `media_e2ee_enabled` flips (6.5).
    if (e2eeCapable) {
      // Keys-changed loop (§3.5): native pushes `e2ee:call-keys-changed` on
      // every LOCAL epoch advance. Route it INTO the session (the SOLE
      // `applyKeys` driver, NEW-3): it fetches the §7.2 frame-key egress and
      // installs them under the Add-grace/Remove-immediate timing + the §4.4
      // loud-state debounce — replacing 6.3's direct `provider.applyKeys`.
      // (`bridge` is non-null here — `e2eeCapable` required it.)
      if (bridge) {
        const unlisten = await bridge.onCallKeysChanged((event) => {
          void this.#mlsSession?.onLocalKeysChanged(
            event.group_id,
            event.epoch,
          );
        });
        // A newer connect() may have superseded us across the await — drop
        // this listener immediately rather than orphaning it, and never clobber
        // the newer invocation's shared state (gate HIGH).
        if (gen !== this.#connectGen) {
          unlisten();
          room.disconnect();
          return;
        }
        this.#unlistenCallKeys = unlisten;
      }

      // LiveKit's observed per-participant encryption status — a REQUIRED
      // media-plane gating input for the green lock (§4.4 invariant 11:
      // native "keys pushed" ≠ "encryption happened"; only this webview signal
      // witnesses the media plane). 6.3 records it; 6.5 builds the chip.
      room.addListener(
        "participantEncryptionStatusChanged",
        (encrypted, participant) => {
          const identity =
            participant?.identity ?? room.localParticipant.identity;
          if (identity) this.callEncryption.set(identity, encrypted);
          // A participant observed encrypted again clears a transient
          // RE-SECURING in the session's §4.4 debounce before it goes loud.
          if (encrypted) this.#mlsSession?.noteEncryptionRecovered();
        },
      );
      // LiveKit emits ONE `encryptionError` then silently drops frames
      // (failureTolerance:0, §1.5) — LATCH the first, STRUCTURED (6.5
      // classifies rotation-window vs loud failure), and hand it to the session
      // for the §4.4 rotation-window-vs-loud classification.
      room.addListener("encryptionError", (error) => {
        this.#setCallEncryptionError((prev) => prev ?? error);
        this.#mlsSession?.noteEncryptionError(error);
      });
    }

    try {
      if (!auth) {
        auth = await channel.joinCall(
          "worldwide",
          true,
          undefined,
          e2eeDeviceId,
        );
      }
      // Superseded during joinCall → abandon this Room, leave the newer
      // connect()'s shared state intact.
      if (gen !== this.#connectGen) {
        room.disconnect();
        return;
      }

      await room.connect(auth.url, auth.token, {
        autoSubscribe: false,
      });
      if (gen !== this.#connectGen) {
        room.disconnect();
        return;
      }

      // Assert the device-qualified identity the SFU actually minted (slice
      // 6.1/6.4 item 3): if it isn't exactly `{user_id}:{device_id}`,
      // MlsKeyProvider's local-last send-key would silently never install
      // (frame keys are matched by this identity). Fail LOUD and latch the
      // error rather than let a later setE2EEEnabled(true) publish plaintext
      // under an encrypted flag; the enable gate (6.4 step 6) refuses to
      // encrypt while callEncryptionError is set.
      let e2eeIdentityOk = false;
      if (e2eeCapable && selfUserId && e2eeDeviceId) {
        const expectedIdentity = `${selfUserId}:${e2eeDeviceId}`;
        const actualIdentity = room.localParticipant.identity;
        if (actualIdentity !== expectedIdentity) {
          this.#setCallEncryptionError(
            (prev) =>
              prev ??
              new Error(
                `E2EE call identity mismatch: expected "${expectedIdentity}", ` +
                  `got "${actualIdentity}" — refusing call encryption ` +
                  `(device-qualified identity, slice 6.1/6.4).`,
              ),
          );
        } else {
          e2eeIdentityOk = true;
        }
      }

      // Construct + start the MLS control-plane session (slice 6.4 step 6). Only
      // once the identity is proven (else local-last never matches). No await
      // has run since the gen check above, so we still own the shared state; a
      // later connect() disposes this session via disconnect(). `start()` is
      // fire-and-forget — with `media_e2ee_enabled` off it enrols, gets
      // FeatureDisabled, and settles into "plaintext" (a normal voice call).
      if (
        e2eeCapable &&
        e2eeIdentityOk &&
        bridge &&
        this.#mlsKeyProvider &&
        selfUserId &&
        e2eeDeviceId
      ) {
        const session = new MlsCallSession({
          bridge,
          userId: selfUserId,
          deviceId: e2eeDeviceId,
          channelId: channel.id,
          requestMfaTicket: () => this.#requestMfaTicket(),
        });
        session.bindMedia(this.#buildMediaBinding(room, this.#mlsKeyProvider));
        this.#mlsSession = session;
        void session.start();
      }
    } catch (error) {
      // Failed connect: tear down THIS invocation's E2EE resources so the
      // worker + native listener never leak (gate MEDIUM). Only if we still
      // own the shared state — a newer connect() may already have taken it
      // over (and cleaned ours) via its disconnect().
      if (gen === this.#connectGen) {
        this.#mlsSession?.dispose();
        this.#mlsSession = undefined;
        this.#unlistenCallKeys?.();
        this.#unlistenCallKeys = undefined;
        this.#e2eeWorker?.terminate();
        this.#e2eeWorker = undefined;
        this.#mlsKeyProvider = undefined;
      }
      try {
        room.disconnect();
      } catch {
        /* not connected */
      }
      throw error;
    }
  }

  disconnect() {
    try {
      nativeCallServiceStop();

      // Media E2EE teardown (§4.2 / §7.2): dispose the MLS session FIRST (its
      // best-effort self-`callRemove` wants the DS still reachable — before
      // room.disconnect), then stop listening for native epoch pushes, terminate
      // the worker (its residual per-participant key sets — LiveKit has no
      // key-deletion API — die WITH it, bounding the §7.2 blast radius to the
      // call), and drop the provider + observed status. Runs before the no-room
      // guard so a half-set-up call still tears down.
      this.#mlsSession?.dispose();
      this.#mlsSession = undefined;
      this.#unlistenCallKeys?.();
      this.#unlistenCallKeys = undefined;
      this.#e2eeWorker?.terminate();
      this.#e2eeWorker = undefined;
      this.#mlsKeyProvider = undefined;
      this.callEncryption.clear();
      this.#setCallEncryptionError(undefined);
      this.#setCallNonEnrolled([]);

      const room = this.room();
      if (!room) return;

      room.removeAllListeners();
      room.disconnect();

      batch(() => {
        this.#setState("READY");
        this.#setRoom();
        this.#setChannel();
        this.#setFullscreen(false);
        this.#setImmersive(false);
        this.vidTracks = () => [];
      });

      this.screenShareTracks = new Set();
      this.disposeTrackRoot?.();
      this.disposeTrackRoot = undefined;
      this.#stopPushToTalk();
      this.#stopVAD();

      // Room disconnect stops tracks (destroying attached processors); drop the
      // controller's references and release any virtual-background image URL.
      this.#cameraEffects.reset();
      this.#setCameraBackgroundStatus("idle");

      this.sound.playSound("userLeaveVoice");
    } catch (e) {
      this.onErr(e);
    }
  }

  /**
   * Mint an MFA ticket for the MLS session's FIRST KeyPackage publish (slice
   * 6.4). Reuses the app's `mfaFlow` password prompt — the password is entered
   * in the native modal and never reaches the store/session. Returns the ticket
   * token, or undefined if the user declines or there is no client.
   */
  async #requestMfaTicket(): Promise<string | undefined> {
    const client = this.getClient();
    if (!client) return undefined;
    const mfa = await client.account.mfa();
    const ticket = await this.#mfaFlow(mfa);
    return ticket?.token;
  }

  /**
   * Build the Room/provider binding the MLS session drives (slice 6.4 step 6).
   * Every closure reads the LIVE Room so a reconnect / track change / roster
   * change is reflected. The session owns all timing + the enable state machine;
   * these are just its thin Room-facing effects.
   */
  #buildMediaBinding(room: Room, provider: MlsKeyProvider): MlsMediaBinding {
    return {
      installer: provider,
      localIdentity: () => room.localParticipant.identity,
      sfuParticipants: () => [
        room.localParticipant.identity,
        ...[...room.remoteParticipants.values()].map((p) => p.identity),
      ],
      onEncryptionState: (state, error) => {
        // Latch a loud media-plane failure into the existing structured signal
        // (6.5 classifies RE-SECURING vs NOT-ENCRYPTED from callEncryption +
        // this). A transient RE-SECURING is not latched (it may recover).
        if (state === "loud" && error !== undefined) {
          this.#setCallEncryptionError((prev) => prev ?? error);
        }
      },
      onRosterReconciled: (result) => {
        // 6.4 DETECTION → the state signal where 6.5's mixed-call banner + pause
        // UX plug in. The session has ALREADY paused local publishing whenever
        // this is non-empty (fail-closed) — 6.4 never opens a plaintext path.
        this.#setCallNonEnrolled(result.nonEnrolled);
      },
      setEncryptionEnabled: (enabled) => room.setE2EEEnabled(enabled),
      pausePublishing: () => this.#setUpstreamPaused(room, true),
      resumePublishing: () => this.#setUpstreamPaused(room, false),
    };
  }

  /**
   * Pause / resume all local upstream publications — the plaintext-until-first-
   * key guard + the mix fail-closed pause (§1.5/§3.4). LiveKit keeps the tracks
   * captured but stops sending them upstream, so no frame is published while the
   * send key is not yet installed (or while the call is mixed).
   */
  async #setUpstreamPaused(room: Room, paused: boolean): Promise<void> {
    const ops: Promise<void>[] = [];
    for (const pub of room.localParticipant.trackPublications.values()) {
      if (!pub.track) continue;
      ops.push(paused ? pub.pauseUpstream() : pub.resumeUpstream());
    }
    await Promise.allSettled(ops);
  }

  async toggleDeafen(fromMute?: boolean) {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setMicrophoneEnabled(
        (this.#settings.micOn || !!fromMute) &&
          !room.localParticipant.isMicrophoneEnabled,
      );

      this.#settings.deafen = !this.#settings.deafen;
      if (fromMute) {
        this.#settings.micOn = room.localParticipant.isMicrophoneEnabled;
      }
      if (this.#settings.deafen) {
        this.sound.playSound("deafen");
      } else {
        this.sound.playSound("undeafen");
      }
    } catch (e) {
      this.onErr(e);
    }
  }

  async toggleMute() {
    if (this.#settings.deafen) {
      this.toggleDeafen(true);
      return;
    }
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setMicrophoneEnabled(
        !room.localParticipant.isMicrophoneEnabled,
      );

      this.#settings.micOn = room.localParticipant.isMicrophoneEnabled;

      if (this.#settings.micOn) {
        this.sound.playSound("unmute");
      } else {
        this.sound.playSound("mute");
      }
    } catch (e) {
      this.onErr(e);
    }
  }

  async toggleCamera() {
    try {
      const room = this.room();
      if (!room) throw "invalid state";

      const enabling = !room.localParticipant.isCameraEnabled;

      if (enabling) {
        const { capture, publish } = this.#cameraCaptureOptions();
        const pub = await room.localParticipant.setCameraEnabled(
          true,
          capture,
          publish,
        );
        if (pub?.videoTrack) {
          const mode = this.#settings.cameraBackgroundMode ?? "none";
          this.#setCameraBackgroundStatus(
            mode === "none" ? "idle" : "initializing",
          );
          await this.#applyCameraEffects(pub.videoTrack as LocalVideoTrack);
        }
      } else {
        await room.localParticipant.setCameraEnabled(false);
        // The track is gone; LiveKit destroyed any attached processor. Drop the
        // controller's now-stale references (and release the background image
        // URL) so a later re-enable rebuilds cleanly rather than switching a
        // dead wrapper.
        this.#cameraEffects.reset();
        this.#setCameraBackgroundStatus("idle");
      }

      this.#setVideo(room.localParticipant.isCameraEnabled);
    } catch (e) {
      this.onErr(e);
    }
  }

  /**
   * Capture + publish options for enabling the camera at the selected quality.
   * Resolution is clamped to the server limit; bitrate is set ONLY when
   * non-auto — `maxBitrate` is required and in bps, so `0` would freeze video,
   * hence we omit `videoEncoding` entirely for "auto".
   */
  #cameraCaptureOptions(): {
    capture: VideoCaptureOptions;
    publish?: TrackPublishOptions;
  } {
    const capture: VideoCaptureOptions = {
      deviceId: this.#settings.preferredVideoDevice,
    };
    const q =
      this.getEnabledCameraQualities()[this.#settings.cameraQuality ?? "auto"];
    if (q?.resolution) capture.resolution = q.resolution;

    const kbps = this.#settings.cameraMaxBitrateKbps ?? 0;
    let publish: TrackPublishOptions | undefined;
    if (kbps > 0) {
      publish = {
        videoEncoding: {
          maxBitrate: kbps * 1000, // kbps -> bps (LiveKit unit)
          maxFramerate: q?.resolution?.frameRate,
        },
      };
    }
    return { capture, publish };
  }

  /**
   * Clamp a resolution to the server's video_resolution limit (0 on an axis =
   * unlimited). Shared by camera + screenshare so neither can exceed the limit.
   */
  #clampResolutionToServerLimit(res: VideoResolution): VideoResolution {
    const limit = this.getClient().configured()
      ? this.getClient().configuration?.features.limits.default.video_resolution
      : undefined;
    if (!limit) return res;
    const [maxW, maxH] = limit;
    const out: VideoResolution = { ...res };
    if (maxW && maxW > 0 && out.width > maxW) out.width = maxW;
    if (maxH && maxH > 0 && out.height > maxH) out.height = maxH;
    return out;
  }

  /**
   * Selectable camera capture qualities. Every non-auto tier is clamped to the
   * server limit so the published track can never exceed it.
   */
  getEnabledCameraQualities(): Record<
    CameraQualityName,
    { resolution?: VideoResolution; fullName: string }
  > {
    const clamp = (res: VideoResolution) =>
      this.#clampResolutionToServerLimit(res);
    return {
      auto: { fullName: "Auto" },
      sd: {
        resolution: clamp({ width: 640, height: 480, frameRate: 30 }),
        fullName: "480p",
      },
      hd: {
        resolution: clamp({ width: 1280, height: 720, frameRate: 30 }),
        fullName: "720p",
      },
      fhd: {
        resolution: clamp({ width: 1920, height: 1080, frameRate: 30 }),
        fullName: "1080p",
      },
    };
  }

  /**
   * Apply all configured camera effects to a live camera track via the shared
   * CameraEffectsController. Idempotent — safe on enable and on any live change.
   * Fail-safe: on error the raw camera keeps publishing.
   */
  async #applyCameraEffects(videoTrack: LocalVideoTrack) {
    const mode = this.#settings.cameraBackgroundMode ?? "none";
    try {
      await this.#cameraEffects.apply(videoTrack, {
        backgroundMode: mode,
        blurRadius: this.#settings.cameraBlurRadius ?? 10,
        backgroundImageId: this.#settings.cameraBackgroundImageId,
        brightness: this.#settings.cameraBrightness ?? 100,
      });
      this.#setCameraBackgroundStatus(
        this.#cameraEffects.backgroundActive ? "active" : "idle",
      );
    } catch (e) {
      console.error("camera effects failed", e);
      this.#setCameraBackgroundStatus(mode === "none" ? "idle" : "failed");
    } finally {
      // Signal that the (possibly track-swapping) apply has settled so the
      // preview re-reads mediaStreamTrack — covers brightness-only changes too.
      this.#setCameraEffectsApplied((n) => n + 1);
    }
  }

  /** Live-update camera brightness. Persists to the store and reapplies. */
  async setCameraBrightness(brightness: number) {
    this.#settings.cameraBrightness = brightness;
    const room = this.room();
    if (!room?.localParticipant.isCameraEnabled) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (pub?.videoTrack) {
      await this.#applyCameraEffects(pub.videoTrack as LocalVideoTrack).catch(
        (e) => this.onErr(e),
      );
    }
  }

  /**
   * Re-apply camera effects to the current live camera track — used after a
   * live device switch (the picker swaps the device; effects/brightness must be
   * re-established on the new source).
   */
  async reapplyCameraEffects() {
    const room = this.room();
    if (!room?.localParticipant.isCameraEnabled) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (pub?.videoTrack) {
      await this.#applyCameraEffects(pub.videoTrack as LocalVideoTrack).catch(
        (e) => this.onErr(e),
      );
    }
  }

  /** Live-update the camera background mode/options. Persists and reapplies. */
  async setCameraBackground(
    mode: CameraBackgroundMode,
    opts?: { blurRadius?: number; imageId?: string },
  ) {
    this.#settings.cameraBackgroundMode = mode;
    if (opts?.blurRadius != null)
      this.#settings.cameraBlurRadius = opts.blurRadius;
    if (opts?.imageId !== undefined)
      this.#settings.cameraBackgroundImageId = opts.imageId;

    const room = this.room();
    if (!room?.localParticipant.isCameraEnabled) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (pub?.videoTrack) {
      if (mode !== "none") this.#setCameraBackgroundStatus("initializing");
      await this.#applyCameraEffects(pub.videoTrack as LocalVideoTrack).catch(
        (e) => this.onErr(e),
      );
    }
  }

  /**
   * Cap the live screen-share sender's bitrate/framerate to the given quality
   * tier via RTCRtpSender.setParameters. Needed when the picker changes quality
   * after the track is already published — setScreenShareEnabled's encoding is
   * fixed at publish time, and applyConstraints only touches the captured
   * resolution, not the RTP bitrate. Best-effort: if a browser rejects
   * setParameters mid-stream, the publish-time cap stays in force.
   */
  async #applyScreenShareEncoding(
    videoTrack: LocalVideoTrack,
    quality: ScreenShareQuality,
  ) {
    const sender = videoTrack.sender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = quality.maxBitrateKbps * 1000;
      if (quality.resolution.frameRate) {
        params.encodings[0].maxFramerate = quality.resolution.frameRate;
      }
      await sender.setParameters(params);
    } catch (e) {
      console.warn("could not apply screen-share encoding", e);
    }
  }

  /**
   * Get the enabled screen share qualities. "low" will always be enabled.
   * Each screen share quality is checked against the limit if the limit is available on the client.
   *
   * TODO: Translate the fullNames here, I can't figure out how to do it.
   *
   * @param name The name of the screen share quality to get
   * @returns A partial record of ScreenShareQualityName to ScreenShareQuality. Will always contain "low" quality.
   */
  getEnabledScreenShareQualities(): Partial<
    Record<ScreenShareQualityName, ScreenShareQuality>
  > {
    // Always enable low
    const qualities: Partial<
      Record<ScreenShareQualityName, ScreenShareQuality>
    > = {
      low: {
        name: "low",
        resolution: ScreenSharePresets.h720fps30.resolution,
        fullName: `720p 30FPS`,
        contentHint: "motion",
        maxBitrateKbps: 1500,
      },
    };

    if (this.getClient().configured()) {
      // TODO: Use new user limits if the user is new - I don't think there's a way to do that now?
      const limit =
        this.getClient().configuration?.features.limits.default
          .video_resolution;

      // TODO: Add more resolutions to stream from if they're enabled. May tie into premium users in the future?
      if (limit) {
        if (
          (limit[0] === 0 || limit[0] >= 1920) &&
          (limit[1] === 0 || limit[1] >= 1080)
        ) {
          qualities.high = {
            name: "high",
            resolution: ScreenSharePresets.h1080fps30.resolution,
            fullName: `1080p 30FPS`,
            contentHint: "motion",
            maxBitrateKbps: 2500,
          };
          // Clone before mutating — ScreenSharePresets.original is a shared
          // livekit-client singleton; writing to it in place corrupts it
          // process-wide for any other consumer.
          const originalResolution = { ...ScreenSharePresets.original.resolution };
          originalResolution.frameRate = 5;
          originalResolution.aspectRatio = 0;
          if (this.getClient().configured()) {
            // TODO: Use new user limits if the user is new - I don't think there's a way to do that now?
            const limit =
              this.getClient().configuration?.features.limits.default
                .video_resolution;
            if (limit) {
              originalResolution.width = limit[0];
              originalResolution.height = limit[1];
              // If both resolutions are limited, set aspect ratio
              if (
                originalResolution.height !== 0 &&
                originalResolution.width !== 0
              ) {
                originalResolution.aspectRatio =
                  originalResolution.width / originalResolution.height;
              }
            }
          }
          qualities.text = {
            name: "text",
            resolution: originalResolution,
            fullName: `Source 5FPS`,
            contentHint: "text",
            maxBitrateKbps: 1500,
          };
        }
      }
    }

    // Offer higher quality options, each clamped to the server limit so a
    // selection can never exceed video_resolution.
    qualities.fhd = {
      name: "fhd",
      resolution: this.#clampResolutionToServerLimit({
        width: 1920,
        height: 1080,
        frameRate: 60,
      }),
      fullName: `1080p 60FPS`,
      contentHint: "motion",
      maxBitrateKbps: 4000,
    };
    qualities.qhd = {
      name: "qhd",
      resolution: this.#clampResolutionToServerLimit({
        width: 2560,
        height: 1440,
        frameRate: 30,
      }),
      fullName: `1440p 30FPS`,
      contentHint: "motion",
      maxBitrateKbps: 4000,
    };
    qualities.uhd = {
      name: "uhd",
      resolution: this.#clampResolutionToServerLimit({
        width: 3840,
        height: 2160,
        frameRate: 30,
      }),
      fullName: `4K 30FPS`,
      contentHint: "motion",
      maxBitrateKbps: 8000,
    };

    return qualities;
  }

  async toggleScreenshare() {
    const room = this.room();
    if (!room) throw "invalid state";

    if (this.screenshare()) {
      await room.localParticipant.setScreenShareEnabled(false);

      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

      this.sound.playSound("streamEnd");
    } else {
      const qualities = this.getEnabledScreenShareQualities();
      let screenPickerQualityName: ScreenShareQualityName | undefined;
      let screenPickerAudio: boolean | undefined;

      // Register the modal on screen picker handler if it exists
      if (window.native && window.native.onceScreenPicker) {
        window.native.onceScreenPicker((sources) => {
          this.openModal({
            type: "screen_share_picker",
            onCancel: () => {
              window.native.screenPickerCallback(-1, false);
            },
            callback: (
              idx: number,
              qualityName: ScreenShareQualityName,
              audio: boolean,
            ) => {
              window.native.screenPickerCallback(idx, audio);
              screenPickerQualityName = qualityName;
              screenPickerAudio = audio;
            },
            sources: sources,
            qualities: Object.keys(qualities).map((k) => {
              const v = qualities[k as ScreenShareQualityName]!;
              return { name: k, fullName: v.fullName };
            }),
          });
        });
      }

      try {
        // Bitrate/framerate for the publish encoding come from the initial
        // (stored) quality. If the picker changes the quality afterwards, the
        // `callback` below re-applies the encoding to the new tier — a bare
        // resolution swap via applyConstraints does NOT touch the publish
        // bitrate cap, so we update the sender directly there.
        const initialQuality =
          qualities[this.#settings.screenShareQuality || "low"] ||
          qualities.low!;

        const localTrack = await room.localParticipant.setScreenShareEnabled(
          true,
          {
            resolution: initialQuality.resolution,
            audio: true,
          },
          {
            videoEncoding: {
              maxBitrate: initialQuality.maxBitrateKbps * 1000, // kbps -> bps
              maxFramerate: initialQuality.resolution.frameRate,
            },
          },
        );

        const screenAudioTrack = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio,
        );

        this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

        if (localTrack) {
          // This event is only fired if the screen share is ended by closing the window being streamed.
          // This catches the ending and disables screen sharing on our side. If this weren't here,
          // livekit would still share stream audio after closing the window being streamed.
          localTrack.on("ended", () => {
            this.toggleScreenshare();
            const oldAudioTrack = room.localParticipant.getTrackPublication(
              Track.Source.ScreenShareAudio,
            );
            if (oldAudioTrack && oldAudioTrack.track) {
              room.localParticipant.unpublishTrack(oldAudioTrack.track);
            }
          });

          const callback = async (
            qualityName: ScreenShareQualityName,
            audio: boolean,
          ) => {
            const quality = qualities[qualityName] || qualities.low!;

            if (localTrack.videoTrack) {
              await localTrack.videoTrack.mediaStreamTrack.applyConstraints({
                frameRate: { max: quality.resolution.frameRate },
                width:
                  quality.resolution.width === 0
                    ? undefined
                    : { max: quality.resolution.width },
                height:
                  quality.resolution.width === 0
                    ? undefined
                    : { max: quality.resolution.height },
              });
              localTrack.videoTrack.mediaStreamTrack.contentHint =
                quality.contentHint;
              // Re-cap the publish bitrate to the picked tier. applyConstraints
              // above only changes the captured resolution/framerate; the RTP
              // sender keeps whatever maxBitrate was set at publish time, so a
              // 720p->1440p switch would otherwise stay starved (or, going the
              // other way, keep an over-large cap). Best-effort — a failure
              // just leaves the publish-time cap in place.
              await this.#applyScreenShareEncoding(
                localTrack.videoTrack,
                quality,
              );
              if (!audio && screenAudioTrack?.track) {
                room.localParticipant.unpublishTrack(screenAudioTrack.track);
              }
              this.sound.playSound("streamStart");
            }
          };

          if (screenPickerQualityName) {
            callback(
              screenPickerQualityName || "low",
              screenPickerAudio || false,
            );
          } else if (this.#settings.screenShareQualityAsk) {
            if (Object.keys(qualities).length > 1) {
              localTrack.pauseUpstream();
              screenAudioTrack?.pauseUpstream();
              this.openModal({
                onCancel: async () => {
                  await room.localParticipant.setScreenShareEnabled(false);
                  this.#setScreenshare(
                    room.localParticipant.isScreenShareEnabled,
                  );
                },
                type: "screen_share_settings",
                trackReference: {
                  participant: room.localParticipant,
                  publication: localTrack,
                  source: Track.Source.ScreenShare,
                },
                qualities: Object.keys(qualities).map((k) => {
                  const v = qualities[k as ScreenShareQualityName]!;
                  return { name: k, fullName: v.fullName };
                }),
                audio: !!screenAudioTrack,
                callback: async (qualityName, audio) => {
                  callback(qualityName, audio);
                  localTrack.resumeUpstream();
                  if (audio) {
                    screenAudioTrack?.resumeUpstream();
                  }
                },
              });
            } else {
              callback(
                this.#settings.screenShareQuality || "low",
                this.#settings.screenShareAudio,
              );
            }
          }
        }
      } catch (e) {
        this.onErr(e);
      }
    }
  }

  toggleFullscreen(fullscreen: boolean = !this.fullscreen()) {
    this.#setFullscreen(fullscreen);
    // Theater mode only makes sense inside fullscreen — leaving fullscreen (via
    // the button or the browser's Escape) always drops back to the normal view.
    if (!fullscreen) this.toggleImmersive(false);
  }

  trackId(t: TrackReferenceOrPlaceholder) {
    return `${t.source}_${t.participant.sid}`;
  }

  toggleFocus(t?: TrackReferenceOrPlaceholder) {
    const id = t ? this.trackId(t) : undefined;
    this.#setFocus(
      this.focusId() === id || this.vidTracks().length < 2 ? undefined : id,
    );
  }

  isFocus(t: TrackReferenceOrPlaceholder) {
    return this.trackId(t) === this.focusId();
  }

  focusTrack() {
    const id = this.focusId();
    return id
      ? this.vidTracks().find((t) => this.trackId(t) === id)
      : undefined;
  }

  toggleShowBar() {
    this.#setShowBar((s) => !s);
  }

  /**
   * "Theater" mode: hide every other participant and the call chrome so the
   * selected (focused) camera/screen-share fills the whole fullscreen view.
   * Entering with nothing selected auto-picks a screen-share, else the first
   * live video track — a no-op if there's no video to show. Exiting restores
   * the other-participants strip so the normal fullscreen view comes straight
   * back.
   */
  toggleImmersive(force?: boolean) {
    const next = force ?? !this.immersive();
    if (next) {
      if (!this.focusTrack()) {
        const withVideo = this.vidTracks().filter(
          (t) => "publication" in t && t.publication,
        );
        const pick =
          withVideo.find((t) => t.source === Track.Source.ScreenShare) ??
          withVideo[0];
        if (!pick) return;
        this.#setFocus(this.trackId(pick));
      }
      batch(() => {
        this.#setShowBar(false);
        this.#setImmersive(true);
      });
    } else {
      batch(() => {
        this.#setImmersive(false);
        this.#setShowBar(true);
      });
    }
  }

  getConnectedUser(userId: string) {
    return this.room()?.getParticipantByIdentity(userId);
  }

  /**
   * The live local camera track, if the camera is on. Used by the settings
   * preview to bind directly to the transmitted track (true WYSIWYG, no second
   * camera open) instead of opening its own capture.
   */
  localCameraTrack(): LocalVideoTrack | undefined {
    const pub = this.room()?.localParticipant.getTrackPublication(
      Track.Source.Camera,
    );
    return pub?.videoTrack as LocalVideoTrack | undefined;
  }

  showCard(channel: Channel) {
    return (
      channel.isVoice &&
      (this.channel()?.id === channel.id ||
        channel.type === "TextChannel" ||
        channel.voiceParticipants.size)
    );
  }

  get listenPermission() {
    const channel = this.channel();
    if (!channel) return false;
    if (channel.type === "DirectMessage" || channel.type === "Group") return true;
    return !!channel.havePermission("Listen");
  }

  get speakingPermission() {
    const channel = this.channel();
    if (!channel) return false;
    // DMs and group DMs don't have server permissions — always allow speaking
    if (channel.type === "DirectMessage" || channel.type === "Group") return true;
    return !!channel.havePermission("Speak");
  }

  #startPushToTalk(room: Room) {
    this.#stopPushToTalk();

    this.#pttKeydown = (e: KeyboardEvent) => {
      if (!this.#settings.pushToTalk) return;
      if (e.code !== this.#settings.pushToTalkKey) return;
      if (e.repeat) return;
      if (room.localParticipant.isMicrophoneEnabled) return;
      room.localParticipant.setMicrophoneEnabled(true);
    };

    this.#pttKeyup = (e: KeyboardEvent) => {
      if (!this.#settings.pushToTalk) return;
      if (e.code !== this.#settings.pushToTalkKey) return;
      if (!room.localParticipant.isMicrophoneEnabled) return;
      room.localParticipant.setMicrophoneEnabled(false);
    };

    window.addEventListener("keydown", this.#pttKeydown);
    window.addEventListener("keyup", this.#pttKeyup);
  }

  #stopPushToTalk() {
    if (this.#pttKeydown) window.removeEventListener("keydown", this.#pttKeydown);
    if (this.#pttKeyup) window.removeEventListener("keyup", this.#pttKeyup);
    this.#pttKeydown = undefined;
    this.#pttKeyup = undefined;
  }

  async #startVAD(room: Room) {
    this.#stopVAD();
    if (!this.#settings.vadEnabled) return;

    try {
      this.#vadStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.#vadCtx = new AudioContext();
      const analyser = this.#vadCtx.createAnalyser();
      analyser.fftSize = 512;
      this.#vadCtx.createMediaStreamSource(this.#vadStream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        const level = Math.min(100, avg * 2.5);
        const threshold = this.#settings.vadThreshold;

        if (level > threshold) {
          clearTimeout(this.#vadSilenceTimer);
          this.#vadSilenceTimer = undefined;
          if (!room.localParticipant.isMicrophoneEnabled) {
            room.localParticipant.setMicrophoneEnabled(true);
          }
        } else if (room.localParticipant.isMicrophoneEnabled && !this.#vadSilenceTimer) {
          this.#vadSilenceTimer = setTimeout(() => {
            room.localParticipant.setMicrophoneEnabled(false);
            this.#vadSilenceTimer = undefined;
          }, 600);
        }

        this.#vadFrame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // mic access denied — VAD won't run
    }
  }

  #stopVAD() {
    if (this.#vadFrame !== undefined) cancelAnimationFrame(this.#vadFrame);
    clearTimeout(this.#vadSilenceTimer);
    this.#vadStream?.getTracks().forEach((t) => t.stop());
    this.#vadCtx?.close();
    this.#vadFrame = undefined;
    this.#vadStream = undefined;
    this.#vadCtx = undefined;
    this.#vadSilenceTimer = undefined;
  }

  private onErr(e: unknown) {
    if ((e as Error).name !== "NotAllowedError")
      this.openModal({ type: "error2", error: e });
  }
}

const voiceContext = createContext<Voice>(null as unknown as Voice);

/**
 * Mount global voice context and room audio manager
 */
export function VoiceContext(props: { children: JSX.Element }) {
  const state = useState();
  const modals = useModals();
  const sound = useSound();
  const voice = new Voice(state.voice, modals, sound);

  return (
    <voiceContext.Provider value={voice}>
      <RoomContext.Provider value={voice.room}>
        <VoiceCallCardContext>{props.children}</VoiceCallCardContext>
        <InRoom>
          <RoomAudioManager />
        </InRoom>
      </RoomContext.Provider>
    </voiceContext.Provider>
  );
}

export const useVoice = () => useContext(voiceContext);

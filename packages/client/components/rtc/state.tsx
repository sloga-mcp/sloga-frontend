import {
  Accessor,
  batch,
  createContext,
  createEffect,
  createRoot,
  createSignal,
  JSX,
  onCleanup,
  Setter,
  untrack,
  useContext,
} from "solid-js";
import {
  RoomContext,
  TrackReferenceOrPlaceholder,
  useTracks,
} from "solid-livekit-components";

import {
  type TrackPublishOptions,
  type VideoCaptureOptions,
  isE2EESupported,
  LocalVideoTrack,
  Room,
  RoomEvent,
  ScreenSharePresets,
  Track,
  TrackEvent,
  VideoResolution,
} from "livekit-client";
// Self-hosted LiveKit E2EE worker — Vite `?worker` bundling ships it inside
// the npm package (dist/livekit-client.e2ee.worker.mjs), fully first-party,
// NO CDN (§4.1). External worker origins are blocked by the desktop shell CSP
// (slice 6.2b) and violate the no-CDN policy everywhere else.
import { Capacitor, registerPlugin } from "@capacitor/core";
import E2EEWorker from "livekit-client/e2ee-worker?worker";
import { DenoiseTrackProcessor } from "livekit-rnnoise-processor";
import { Channel, Message } from "stoat.js";

class GainTrackProcessor {
  name = "gain-processor";
  processedTrack: MediaStreamTrack | undefined;
  #gainNode: GainNode | undefined;
  #gainValue: number;
  #ctx: AudioContext | undefined;

  constructor(gain: number) {
    this.#gainValue = gain;
  }

  async init(opts: {
    track: MediaStreamTrack;
    audioContext: AudioContext;
    sourceNode: AudioNode;
  }) {
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
  nativeE2EEAvailable,
  SoundController,
  useClient,
  useSound,
} from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { ModalControllerExtended, useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  type CameraColorLookId,
  type CameraFaceFilterId,
  CameraBackgroundMode,
  CameraQualityName,
  ScreenShareQualityName,
  Voice as VoiceSettings,
} from "@revolt/state/stores/Voice";
import { VoiceCallCardContext } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";
import { ReactiveMap } from "@solid-primitives/map";
import { CaptureClaim } from "./captureClaim";
import { watchLocalUserId } from "./localUserIdentity";
import { RemoteControl } from "./remoteControl";
import {
  type RemoteControlQueue,
  addToQueue,
  EMPTY_REMOTE_CONTROL_QUEUE,
  removeFromQueue,
  retainPresent,
} from "./remoteControlQueue";
import {
  type RemoteControlSessionMap,
  applyRemoteControlActive,
  applyRemoteControlEnded,
  EMPTY_REMOTE_CONTROL_SESSIONS,
} from "./remoteControlVisibility";
import { CallTranscriber } from "./transcription/callTranscriber";
import {
  type TranscriptFormat,
  toTxt,
  toVtt,
  transcriptFilename,
} from "./transcription/transcriptExport";
import { TranscriptStore } from "./transcription/transcriptStore";
import {
  getTranscriptionEngine,
  transcriptionSupported,
} from "./transcription/transcriptionEngine";
import {
  type TurnRequests,
  addTurnRequest,
  EMPTY_TURN_REQUESTS,
  removeTurnRequest,
  retainPresentRequests,
} from "./turnRequests";

import { LiveAnnotations } from "./annotations/liveAnnotations";
import {
  type RecordingTarget,
  CallRecorder,
  callRecordingSupported,
  isSaveCancelled,
  pickRecordingTarget,
  recordingFilename,
  recordingMimeType,
  saveDialogSupported,
  saveRecording,
} from "./callRecorder";
import {
  type CameraBackgroundStatus,
  CameraEffectsController,
} from "./cameraEffects";
import { createCaptionEngine } from "./captions/captionEngine";
import { LiveCaptions } from "./captions/liveCaptions";
import { CaptionPublisher } from "./components/CaptionPublisher";
import { CaptionSpeaker } from "./components/CaptionSpeaker";
import { InRoom } from "./components/InRoom";
import { RoomAudioManager } from "./components/RoomAudioManager";
import { isDiceRollMessage, summariseDiceRoll } from "./diceRoll";
import { faceSettingsActive } from "./faceFilterCatalog";
import { MlsKeyProvider } from "./mlsCallKeys";
import {
  type CallMode,
  type ChipState,
  chipState,
  isTerminalLoud,
} from "./mlsCallModePolicy";
import {
  type MlsMediaBinding,
  type MlsRosterMember,
  MlsCallSession,
} from "./mlsCallSession";
import { ScreenShieldProcessor } from "./screenShieldProcessor";
import { SoundboardPlayback } from "./soundboardPlayback";
import { WhisperController } from "./whisper";

/**
 * A dice-roll result shown briefly over the call's video (e.g. "Jeff rolled
 * a 20"). Pushed when a DiceRoll-flagged message lands in the channel we're
 * currently in a call for, and auto-removed after {@link DICE_TOAST_MS}.
 */
export interface DiceRollToast {
  /** Monotonic id (list key / removal handle). */
  id: number;
  /** Display name of whoever rolled. */
  username: string;
  /** Rolled notation, e.g. `1d20` (shown small under the headline). */
  notation: string;
  /** Final total, as printed by the server. */
  total: string;
  /** Natural 20 / natural 1 accent, if any. */
  natural?: "crit" | "fumble";
}

/**
 * How long a dice-roll toast stays on the video before it's removed. Kept in
 * sync with the `diceRollToast` keyframe duration in panda.config.ts (the
 * animation fades the toast out just as this timer unmounts it).
 */
export const DICE_TOAST_MS = 3400;

/**
 * Whether THIS platform's shell has an AUDITED media-E2EE path (EL1 audit
 * S7, hard exit criterion). FALSE whenever the Electron shell
 * (`slogaShell`) is present — for ANY platform it may ever claim, not
 * just Linux (a hypothetical mac shell must not claim media E2EE with
 * zero audit work) — even though insertable streams and the key-push
 * channel both probe TRUE there. Flipped per-platform only by EL4's own
 * audited slice. Windows Tauri / Android Capacitor are unaffected.
 */
export function platformMediaE2EESupported(): boolean {
  return !("slogaShell" in window);
}

/**
 * Cap the visible toast stack (roomy enough for a party rolling initiative at
 * once) so a burst of rolls can't wall off the video. Older toasts drop early;
 * their removal timers no-op against the already-trimmed list.
 */
const MAX_DICE_TOASTS = 5;

/** A3(b) product gate: video/screenshare off above this many participants in
 *  an E2EE call (control-plane cost scales with roster). Trivially tunable. */
const MAX_VIDEO_PARTICIPANTS = 30;

/**
 * Upper bound on the open-group probe (T0d): the fail-safe holds the publish
 * gate while the probe is "pending", so a HUNG fetch would keep a live call
 * paused (publishing nothing) indefinitely. A timeout rejects into the probe's
 * catch, which resolves "none" — the ratified probe-error availability escape
 * (R2-6, same origin as the DS).
 */
const OPEN_GROUP_PROBE_TIMEOUT_MS = 10_000;

/**
 * Console escape hatch for the shared Web Audio mix, checked alongside the
 * persisted `voice.webAudioMix` setting.
 *
 * The setting itself lives in localforage/IndexedDB, which is awkward to edit
 * while someone's audio is broken; this is flippable in one line
 * (`localStorage.slogaDisableWebAudioMix = "1"`, then rejoin the call) so
 * support can drop a user back to the plain-element path without a redeploy.
 * Costs boosting — volume clamps to 100% — but audio plays.
 */
const DISABLE_WEB_AUDIO_MIX_KEY = "slogaDisableWebAudioMix";

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
   * What the encoder should protect when it cannot afford both. Mirrors
   * `contentHint`: tiers the user picked FOR resolution keep pixels and shed
   * frames, while the 720p fallback and the 60FPS tier keep frames and shed
   * pixels. Left unset the sender defaults to "balanced", which silently
   * downscales screen content and is what made shared text look soft.
   */
  degradationPreference: RTCDegradationPreference;
  /**
   * Upper bound on the encoded bitrate (kbps). Without this, LiveKit picks an
   * effectively-uncapped default from the source resolution; at 1440p/4K that
   * saturates a relayed (TURN) publisher path and collapses the peer
   * connection — disconnecting off-LAN callers. Capping keeps the high-res
   * option usable over the relay. LAN publishers rarely hit the cap.
   */
  maxBitrateKbps: number;
  /**
   * Set false to publish a single encoding instead of a simulcast ladder.
   * With one subscriber (the couch co-op / game-night case) the downscaled
   * rung is encode spent on a layer nobody watches; a single encoding gets
   * the full bitrate budget. Costs multi-viewer quality adaptation, so only
   * the Game tier opts out.
   */
  simulcast?: boolean;
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
   * Runtime-only: face-filter processor status, parallel to
   * {@link cameraBackgroundStatus} (plan §5). "Inert" (filters configured but
   * a background holds the slot) reads as "idle" here — the UI derives the
   * paused badge from the STORE state, not this signal.
   */
  cameraFaceFilterStatus: Accessor<CameraBackgroundStatus>;
  #setCameraFaceFilterStatus: Setter<CameraBackgroundStatus>;

  /** Runtime-only: face-filter degrade-ladder step (0 = full quality). */
  cameraFaceFilterDegraded: Accessor<number>;
  #setCameraFaceFilterDegraded: Setter<number>;

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

  /**
   * TRUE while the browser refuses to play the call's audio (autoplay
   * policy: no user gesture yet, or sound blocked for the site). Under
   * `webAudioMix` every remote participant plays through ONE shared
   * AudioContext, so a suspended context is total silence for the whole
   * call — not a per-user nuisance. The SDK's only automatic rescue is
   * `startAudio` on mic-publish, which never fires for a listener who
   * joined muted or has no microphone. `startCallAudio()` is the user
   * gesture that clears this.
   */
  audioPlaybackBlocked: Accessor<boolean>;
  #setAudioPlaybackBlocked: Setter<boolean>;

  deafen: Accessor<boolean>;
  microphone: Accessor<boolean>;

  video: Accessor<boolean>;
  #setVideo: Setter<boolean>;

  screenshare: Accessor<boolean>;
  #setScreenshare: Setter<boolean>;

  /**
   * WHAT is being shared: `"monitor"` (a whole screen), `"window"` (one
   * application window), `"browser"` (a tab), or `undefined` when there is no
   * share or the platform does not report it.
   *
   * Straight off the published track's `getSettings().displaySurface`. It
   * exists for remote control: injection is addressed to a MONITOR, so a
   * window share would let a controller drive the sharer's entire screen
   * while seeing only the one window — including parts the sharer believes
   * are private. See the gate in `VoiceGiveControlButton`.
   *
   * Derived rather than stored: it depends on `screenshare()` and `room()`,
   * both signals, and a track's settings cannot change without a new track —
   * so re-reading on those two is exact, and there is no fourth call site to
   * keep in sync with `#setScreenshare`.
   */
  screenShareSurface: Accessor<string | undefined>;

  fullscreen: Accessor<boolean>;
  #setFullscreen: Setter<boolean>;

  focusId: Accessor<string | undefined>;
  #setFocus: Setter<string | undefined>;

  showBar: Accessor<boolean>;
  #setShowBar: Setter<boolean>;

  /** "Theater" mode: only the selected window, no other participants or chrome. */
  immersive: Accessor<boolean>;
  #setImmersive: Setter<boolean>;

  /** Dice-roll results currently shown over the video (see DiceRollToast). */
  diceRolls: Accessor<DiceRollToast[]>;
  #setDiceRolls: Setter<DiceRollToast[]>;
  /** Monotonic id source for dice toasts. */
  #diceToastSeq = 0;
  /** Pending removal timers, cleared on disconnect so none fire post-call. */
  #diceToastTimers = new Set<ReturnType<typeof setTimeout>>();

  private sound: SoundController;

  private openModal;
  private getClient;
  /** App MFA password prompt — reused to mint the MLS first-publish ticket
   * (slice 6.4); the password is entered natively and never reaches the store. */
  #mfaFlow: ModalControllerExtended["mfaFlow"];
  private screenShareTracks: Set<string>;
  /**
   * Screen-share track ids auto-focus has already had its one chance at (see
   * `#watchScreenShareFocus`). Pruned as shares end, so a re-share counts as a
   * new event — but a share the viewer deliberately un-focused is never
   * re-grabbed while it is still running.
   */
  #autoFocusedShares = new Set<string>();
  private disposeTrackRoot: (() => void) | undefined;
  #pttKeydown: ((e: KeyboardEvent) => void) | undefined;
  #pttKeyup: ((e: KeyboardEvent) => void) | undefined;
  /** EL-PTT: key the desktop shell's global hook is armed to (undefined =
   * not armed — web build, unmappable key, or shell without the commands) */
  #pttNativeKey: string | undefined;
  #pttNativeUnlisten: (() => void)[] = [];
  #pttNativeArming = false;
  #vadStream: MediaStream | undefined;
  #vadCtx: AudioContext | undefined;
  #vadFrame: number | undefined;
  #vadSilenceTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Supersession token for `#startVAD`'s async capture, bumped by `#stopVAD`:
   * a start superseded mid-getUserMedia (device switch, call ended) must stop
   * the stream it acquired rather than leak a live mic capture — a leaked VAD
   * stream keeps the OS mic indicator lit after the call.
   */
  #vadGen = 0;

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
   * Monotonic call-ownership token. `connect()` awaits (device enumeration,
   * native listen, join, room.connect); BOTH a newer `connect()` and any
   * `disconnect()` bump this, so a stale invocation resuming after an await
   * can detect it no longer owns the call and bail instead of leaking its
   * worker/listener or reviving a Room the teardown already disposed. The
   * disconnect() bump is load-bearing: without it, hanging up while still
   * CONNECTING was silently lost — connect() resumed and joined anyway.
   */
  #connectGen = 0;
  /**
   * The mic id `connect()` pinned `{ exact }` into `audioCaptureDefaults` for
   * the CURRENT call; undefined when no pin is in force. Lets
   * `#setMicEnabled`'s rescue distinguish OUR join-time pin (safe to un-pin
   * when the device has vanished) from an exact constraint the user picked
   * mid-call via `switchActiveDevice` (never silently dropped).
   */
  #pinnedMicId: string | undefined;
  /**
   * LiveKit's observed per-participant encryption status (identity → encrypted)
   * — a REQUIRED gating input for the green lock (§4.4 invariant 11: native
   * "keys pushed" is NOT "encryption happened"; only this webview-observed
   * signal witnesses the media plane). Wired in 6.3; the dual-gated chip state
   * machine that consumes it is 6.5.
   */
  readonly callEncryption = new ReactiveMap<string, boolean>();
  /**
   * Translated live captions for this call (STT → server relay → per-receiver
   * translation). Attached on connect, torn down on disconnect. Local
   * broadcasting is gated OFF on E2EE calls (audio would reach the speech
   * vendor and the transcript would pass through the server in plaintext).
   *
   * Captions deliberately do NOT use a LiveKit data channel: the voice token
   * is minted `can_publish_data: false`, so the SFU silently drops every
   * packet a speaker publishes. Finalized lines POST to the server, which
   * fans a `CallCaption` event to the call's participants.
   */
  readonly captions = new LiveCaptions(createCaptionEngine);
  /**
   * Screen-share annotations (tech-support mode §2): relayed ink batches
   * per sharer surface + the mirrored draw-consent state. Attached on
   * connect, torn down on disconnect; ingestion is app-lifetime client
   * subscriptions in the constructor (the captions shape). Consent is
   * ENFORCED server-side — the mirror here only drives affordances and
   * closes the revoke-beats-stroke event race.
   */
  readonly annotations = new LiveAnnotations();
  /** Palette INDEX the local user draws with (bounded by the fixed table). */
  annotationColor: Accessor<number>;
  #setAnnotationColor: Setter<number>;
  /** Pick a palette index to draw with (clamped to the fixed table). */
  setAnnotationColor(index: number) {
    this.#setAnnotationColor(Math.max(0, Math.min(4, Math.floor(index))));
  }
  /**
   * Private-aside audio to one participant (second published audio track,
   * SFU-restricted via subscription permissions — see whisper.ts for the
   * fail-closed ordering and the honest privacy model). Auto-ends (restoring
   * the mic) if the target leaves the call.
   */
  readonly whisper = new WhisperController(() => void this.stopWhisper());
  /** Identity of a participant currently whispering TO US (from the audio
   * manager, which is where addressed whisper tracks surface), for the
   * receiving-side indicator. */
  incomingWhisperFrom: Accessor<string | undefined>;
  #setIncomingWhisperFrom: Setter<string | undefined>;
  /** Live screenshare privacy-shield processor, when attached (the handle is
   * ours because livekit exposes no reliable current-processor getter). */
  #screenShield: ScreenShieldProcessor | undefined;
  /** Primary-mic state captured when a whisper began, to restore on stop. */
  #whisperPriorMic = false;
  /**
   * Remote desktop control during screen share. Owned by this class rather
   * than by any component, because a tile is destroyed and rebuilt by
   * ordinary actions — the grid and the focus box are DIFFERENT `TrackLoop`s,
   * so toggling focus unmounts and remounts the tile mid-drag, taking any
   * state it held with it. Held keys, held buttons, pointer capture and the
   * seal pipeline all have to outlive that.
   *
   * Two subscriptions, on the two precedents in this file: an app-lifetime
   * client-event subscription for the handshake events (the soundboard
   * shape — a connect/disconnect one would go dead after the first call),
   * and a room-scoped `attach`/`detach` for the data channel, including the
   * explicit `off`. Remote control is now the only user of that second shape:
   * captions used to share it and no longer do, because the SFU was dropping
   * everything they published.
   */
  readonly remoteControl = new RemoteControl();
  /**
   * Client-local soundboard playback. Subscribes to the `soundboardSound`
   * client event app-lifetime (in the constructor) and plays a received clip
   * only if we are in the triggering call — never on the LiveKit/MLS path.
   */
  #soundboard: SoundboardPlayback;
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
  /**
   * The §3.4 call mode (slice 6.5): `negotiating` | `off` | `e2ee` | `mixed` |
   * `interlude` | `call_full`. The banner + chip + roster panel render from it.
   * Undefined when there is no session (a non-capable shell / a plain call).
   */
  callMode: Accessor<CallMode | undefined>;
  #setCallMode: Setter<CallMode | undefined>;
  /**
   * Whether THIS call is E2EE-capable — the connect-time `e2eeCapable` snapshot
   * (isE2EESupported + native layer + key-push + "Encrypt my calls"). The
   * caption fail-closed gate reads it: on a capable call captions broadcast
   * ONLY when the mode is POSITIVELY plaintext ("off"); a non-capable call is
   * always plaintext, so an undefined mode there is safe.
   */
  callE2EECapable: Accessor<boolean>;
  #setCallE2EECapable: Setter<boolean>;
  /** For a remote announce (T4): the user who announced plaintext (banner copy). */
  callAnnouncedBy: Accessor<string | undefined>;
  #setCallAnnouncedBy: Setter<string | undefined>;
  /** The VERIFIED MLS roster + divergent ghosts for the 6.5 roster panel. */
  callRoster: Accessor<{
    members: readonly MlsRosterMember[];
    ghosts: readonly string[];
  }>;
  #setCallRoster: Setter<{
    members: readonly MlsRosterMember[];
    ghosts: readonly string[];
  }>;
  /** The channel has an open MLS group (the pre-join probe; chip input FE-7). */
  callChannelHasOpenGroup: Accessor<boolean>;
  #setCallChannelHasOpenGroup: Setter<boolean>;
  /** LiveKit encryption-status version bump — the chip's non-reactive
   *  participant/track domain changed (R2-3/FE-8). */
  callParticipantsVersion: Accessor<number>;
  #setCallParticipantsVersion: Setter<number>;
  /** Whether the call roster / verification panel is open (chip click). */
  callRosterPanelOpen: Accessor<boolean>;
  #setCallRosterPanelOpen: Setter<boolean>;

  /**
   * Channel-wide "who is controlling whom" (pass-the-controller slice 0):
   * `channelId → (sharerId → controllerId)`, fed by the redacted
   * channel-topic `remoteControlActive`/`remoteControlEnded` pair. Read by
   * the screenshare tile badge and the roster panel; unlike
   * `remoteControl.sharing()`/`controlling()` this covers sessions we are
   * not a party to — that reach is the §2.2 third-party/moderator
   * visibility, not a leak.
   */
  remoteControlSessions: Accessor<RemoteControlSessionMap>;
  #setRemoteControlSessions: Setter<RemoteControlSessionMap>;

  /**
   * The streamer's rotation order (pass-the-controller slice 1).
   *
   * Local to THIS client and never sent anywhere. A server-ordered rotation
   * would be a server-chosen controller, and §0.4's claim discipline is that
   * nothing the server says about who is on the other end means anything —
   * so the queue is an ORDER the sharer keeps, not an authorization. Every
   * turn still costs a native `RcArm` on the sharer's own machine.
   *
   * Only meaningful while this user is the sharer; it is simply empty for
   * everyone else. Resets on disconnect with the rest of the call state.
   */
  controllerQueue: Accessor<RemoteControlQueue>;
  #setControllerQueue: Setter<RemoteControlQueue>;

  /**
   * Pending "ask for a turn" requests, on the SHARER's client only
   * (pass-the-controller slice 2, §2.4).
   *
   * Fed by the private `callControlRequest` event, whose `requesterId` the
   * server stamps from the authenticated asker. These are SUGGESTIONS: a
   * request grants nothing and enters the rotation queue only if the sharer
   * acts on it. Empty for anyone who is not being asked. Resets on disconnect
   * with the rest of the call state.
   */
  pendingTurnRequests: Accessor<TurnRequests>;
  #setPendingTurnRequests: Setter<TurnRequests>;

  /**
   * Wall-clock ms after which the current turn should auto-advance, or
   * `undefined` for no timer (the default — an automatic handoff is a
   * session ending on a schedule the person driving did not choose, so it
   * is opt-in).
   */
  turnDeadline: Accessor<number | undefined>;
  #setTurnDeadline: Setter<number | undefined>;

  /** Turn length in ms the streamer picked, kept so each new turn can be
   *  re-armed with the same length. `undefined` = timer off. */
  turnLengthMs: Accessor<number | undefined>;
  #setTurnLengthMs: Setter<number | undefined>;

  // --- Local call recording (call-recording plan §1) -----------------
  /**
   * Whether THIS client is recording. Set only once the server has accepted
   * the claim (see `toggleRecording` — disclosure precedes capture), so it can
   * never read true while the rest of the call believes otherwise.
   */
  recording: Accessor<boolean>;
  #setRecording: Setter<boolean>;
  /** In-flight start/stop, to keep the button from double-firing. */
  recordingBusy: Accessor<boolean>;
  #setRecordingBusy: Setter<boolean>;
  /** Last recording failure, shown on the button; cleared on the next try. */
  recordingError: Accessor<string | undefined>;
  #setRecordingError: Setter<string | undefined>;
  /**
   * One-shot user-facing notice about a recording (saved / couldn't save).
   * Consumed and cleared by `CallRecordingNotices`, which turns it into a
   * snackbar — the Voice instance is constructed OUTSIDE `SnackbarProvider`, so
   * it cannot show one itself.
   *
   * This exists because the save used to fail SILENTLY: the fallback anchor
   * download reports success and writes nothing in an embedded webview, so a
   * recording could vanish with no error anywhere. Every terminal outcome now
   * says something.
   */
  recordingNotice: Accessor<
    | { kind: "saved" | "handed-off" | "failed"; message: string; at: number }
    | undefined
  >;
  #setRecordingNotice: Setter<
    | { kind: "saved" | "handed-off" | "failed"; message: string; at: number }
    | undefined
  >;
  /**
   * Recorders whose banner this user has dismissed, by user id.
   *
   * Per-RECORDER rather than a single boolean: dismissing Jeff's banner must
   * not pre-hide the one for whoever starts recording next. Cleared when the
   * call ends, so a dismissal never outlives the recording it was about.
   */
  #recordingDismissed = new ReactiveMap<string, true>();
  #recorder: CallRecorder | undefined;

  /**
   * The only path to the `recording` voice-state flag.
   *
   * The flag is shared: the recorder raises it, and so will the on-device
   * transcriber. It is refcounted, serialised and generation-checked there so
   * that stopping one capture cannot retract the disclosure another one is
   * still relying on — see `captureClaim.ts` for the races each rule closes.
   * Nothing in this file may PUT or DELETE the flag directly.
   */
  #captureClaim = new CaptureClaim((channelId, claimed) =>
    this.#claimRecording(channelId, claimed),
  );

  // --- On-device call transcription -----------------------------------
  /** Whether THIS client is transcribing. Set only once the claim is held. */
  transcribing: Accessor<boolean>;
  #setTranscribing: Setter<boolean>;
  /** In-flight start/stop, to keep the button from double-firing. */
  transcriptionBusy: Accessor<boolean>;
  #setTranscriptionBusy: Setter<boolean>;
  /** Last transcription failure, shown on the button. */
  transcriptionError: Accessor<string | undefined>;
  #setTranscriptionError: Setter<string | undefined>;
  /** Model download progress, 0..1; undefined when not loading. */
  transcriptionLoading: Accessor<number | undefined>;
  #setTranscriptionLoading: Setter<number | undefined>;
  #transcriber: CallTranscriber | undefined;
  /**
   * A stopped session still finishing text for audio it already captured.
   *
   * Kept because export must wait on it: stop hands the button back straight
   * away, so an export can easily begin while the tail is still being
   * transcribed, and writing then would silently truncate the file.
   */
  #draining: Promise<void> | undefined;
  /** Utterances the model still owes, for the panel's "finishing N". */
  transcriptionPending: Accessor<number>;
  #setTranscriptionPending: Setter<number>;
  /**
   * The transcript itself.
   *
   * Lives on the Voice instance, NOT on the transcriber, because it has to
   * outlive both the session and the call — see `transcriptStore.ts`. A call
   * that ends unexpectedly must leave the words exportable.
   */
  readonly transcript = new TranscriptStore();

  /**
   * The single publish-gate reason SET (FE-3/R2-1/R2-7). Local upstream
   * publishing flows ONLY when this is empty; the session adds/removes its
   * reasons (`negotiating`/`enable-window`/`mixed`). The screenshare quality
   * modal keeps its own PER-TRACK pause but its resume defers to this gate
   * (it only resumes when the set is empty — the gate owner resumes every
   * publication when the set empties). Every LocalTrackPublished +
   * UpstreamResumed/TrackProcessorUpdate re-asserts the gate so a late
   * publication or livekit's unconditional resumes can never bypass it.
   */
  #publishGate = new Set<string>();
  /**
   * Open-group probe lifecycle for the CURRENT call (media-gate LOW-2): the
   * T0d fail-safe must distinguish a COMPLETED "no open group" verdict from a
   * still-pending probe — releasing the gate on a merely-slow probe for a call
   * that turns out E2EE would auto-resume plaintext. Tri-state read by the
   * session via `channelHasOpenGroup`.
   */
  #openGroupProbe: "pending" | "open" | "none" = "pending";

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

    const [audioPlaybackBlocked, setAudioPlaybackBlocked] = createSignal(false);
    this.audioPlaybackBlocked = audioPlaybackBlocked;
    this.#setAudioPlaybackBlocked = setAudioPlaybackBlocked;

    this.deafen = () => voiceSettings.deafen;
    // Whispering suppresses the primary room mic (the aside rides its own
    // track), so `microphone()` reports off for its duration. This is the
    // single source the mute button AND the caption publisher both read, so
    // one term keeps the button honest and stops captions broadcasting the
    // aside to the whole call.
    this.microphone = () =>
      voiceSettings.micOn && !voiceSettings.deafen && !this.whisper.target();

    const [video, setVideo] = createSignal(false);
    this.video = video;
    this.#setVideo = setVideo;

    const [screenshare, setScreenshare] = createSignal(false);
    this.screenshare = screenshare;
    this.#setScreenshare = setScreenshare;

    this.screenShareSurface = () => {
      // Both reads are the reactive dependencies — see the field's doc.
      if (!screenshare()) return undefined;
      const room = this.room();
      if (!room) return undefined;
      const track = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShare,
      )?.track?.mediaStreamTrack;
      // `displaySurface` is a screen-capture-only setting, so it is absent
      // from the base `MediaTrackSettings` type in this TS lib version.
      return (
        track?.getSettings() as MediaTrackSettings & {
          displaySurface?: string;
        }
      )?.displaySurface;
    };

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

    const [diceRolls, setDiceRolls] = createSignal<DiceRollToast[]>([]);
    this.diceRolls = diceRolls;
    this.#setDiceRolls = setDiceRolls;

    const [incomingWhisperFrom, setIncomingWhisperFrom] =
      createSignal<string>();
    this.incomingWhisperFrom = incomingWhisperFrom;
    this.#setIncomingWhisperFrom = setIncomingWhisperFrom;

    const [annotationColor, setAnnotationColor] = createSignal(0);
    this.annotationColor = annotationColor;
    this.#setAnnotationColor = setAnnotationColor;

    const [hwBrightness, setHwBrightness] = createSignal(false);
    this.cameraHwBrightness = hwBrightness;
    this.#setCameraHwBrightness = setHwBrightness;

    const [bgStatus, setBgStatus] =
      createSignal<CameraBackgroundStatus>("idle");
    this.cameraBackgroundStatus = bgStatus;
    this.#setCameraBackgroundStatus = setBgStatus;

    const [ffStatus, setFfStatus] =
      createSignal<CameraBackgroundStatus>("idle");
    this.cameraFaceFilterStatus = ffStatus;
    this.#setCameraFaceFilterStatus = setFfStatus;

    const [ffDegraded, setFfDegraded] = createSignal(0);
    this.cameraFaceFilterDegraded = ffDegraded;
    this.#setCameraFaceFilterDegraded = setFfDegraded;

    const [effectsApplied, setEffectsApplied] = createSignal(0);
    this.cameraEffectsApplied = effectsApplied;
    this.#setCameraEffectsApplied = setEffectsApplied;

    const [callEncryptionError, setCallEncryptionError] =
      createSignal<unknown>();
    this.callEncryptionError = callEncryptionError;
    this.#setCallEncryptionError = setCallEncryptionError;

    const [recording, setRecording] = createSignal(false);
    this.recording = recording;
    this.#setRecording = setRecording;

    const [recordingBusy, setRecordingBusy] = createSignal(false);
    this.recordingBusy = recordingBusy;
    this.#setRecordingBusy = setRecordingBusy;

    const [recordingError, setRecordingError] = createSignal<string>();
    this.recordingError = recordingError;
    this.#setRecordingError = setRecordingError;

    const [recordingNotice, setRecordingNotice] = createSignal<{
      kind: "saved" | "handed-off" | "failed";
      message: string;
      at: number;
    }>();
    this.recordingNotice = recordingNotice;
    this.#setRecordingNotice = setRecordingNotice;

    const [transcribing, setTranscribing] = createSignal(false);
    this.transcribing = transcribing;
    this.#setTranscribing = setTranscribing;

    const [transcriptionBusy, setTranscriptionBusy] = createSignal(false);
    this.transcriptionBusy = transcriptionBusy;
    this.#setTranscriptionBusy = setTranscriptionBusy;

    const [transcriptionError, setTranscriptionError] = createSignal<string>();
    this.transcriptionError = transcriptionError;
    this.#setTranscriptionError = setTranscriptionError;

    // undefined = not loading. 0..1 while the model downloads, which is the
    // one part of starting that takes long enough to need a progress bar.
    const [transcriptionLoading, setTranscriptionLoading] =
      createSignal<number>();
    this.transcriptionLoading = transcriptionLoading;
    this.#setTranscriptionLoading = setTranscriptionLoading;

    const [transcriptionPending, setTranscriptionPending] = createSignal(0);
    this.transcriptionPending = transcriptionPending;
    this.#setTranscriptionPending = setTranscriptionPending;

    const [callNonEnrolled, setCallNonEnrolled] = createSignal<
      readonly string[]
    >([]);
    this.callNonEnrolled = callNonEnrolled;
    this.#setCallNonEnrolled = setCallNonEnrolled;

    const [callMode, setCallMode] = createSignal<CallMode | undefined>();
    this.callMode = callMode;
    this.#setCallMode = setCallMode;

    const [callE2EECapable, setCallE2EECapable] = createSignal(false);
    this.callE2EECapable = callE2EECapable;
    this.#setCallE2EECapable = setCallE2EECapable;

    const [callAnnouncedBy, setCallAnnouncedBy] = createSignal<
      string | undefined
    >();
    this.callAnnouncedBy = callAnnouncedBy;
    this.#setCallAnnouncedBy = setCallAnnouncedBy;

    const [callRoster, setCallRoster] = createSignal<{
      members: readonly MlsRosterMember[];
      ghosts: readonly string[];
    }>({ members: [], ghosts: [] });
    this.callRoster = callRoster;
    this.#setCallRoster = setCallRoster;

    const [callChannelHasOpenGroup, setCallChannelHasOpenGroup] =
      createSignal(false);
    this.callChannelHasOpenGroup = callChannelHasOpenGroup;
    this.#setCallChannelHasOpenGroup = setCallChannelHasOpenGroup;

    const [callParticipantsVersion, setCallParticipantsVersion] =
      createSignal(0);
    this.callParticipantsVersion = callParticipantsVersion;
    this.#setCallParticipantsVersion = setCallParticipantsVersion;

    const [callRosterPanelOpen, setCallRosterPanelOpen] = createSignal(false);
    this.callRosterPanelOpen = callRosterPanelOpen;
    this.#setCallRosterPanelOpen = setCallRosterPanelOpen;

    const [remoteControlSessions, setRemoteControlSessions] =
      createSignal<RemoteControlSessionMap>(EMPTY_REMOTE_CONTROL_SESSIONS);
    this.remoteControlSessions = remoteControlSessions;
    this.#setRemoteControlSessions = setRemoteControlSessions;

    const [controllerQueue, setControllerQueue] =
      createSignal<RemoteControlQueue>(EMPTY_REMOTE_CONTROL_QUEUE);
    this.controllerQueue = controllerQueue;
    this.#setControllerQueue = setControllerQueue;

    const [pendingTurnRequests, setPendingTurnRequests] =
      createSignal<TurnRequests>(EMPTY_TURN_REQUESTS);
    this.pendingTurnRequests = pendingTurnRequests;
    this.#setPendingTurnRequests = setPendingTurnRequests;

    const [turnDeadline, setTurnDeadline] = createSignal<number | undefined>();
    this.turnDeadline = turnDeadline;
    this.#setTurnDeadline = setTurnDeadline;

    const [turnLengthMs, setTurnLengthMs] = createSignal<number | undefined>();
    this.turnLengthMs = turnLengthMs;
    this.#setTurnLengthMs = setTurnLengthMs;

    this.#cameraEffects.onHwSupportChange = (hw) =>
      this.#setCameraHwBrightness(hw);
    this.#cameraEffects.onImageMissing = () => {
      this.#settings.cameraBackgroundMode = "none";
    };
    this.#cameraEffects.onFaceFilterStatus = (s) => {
      // Live processor reports: landmark tracking died (→ failed, look-only
      // keeps drawing) or the degrade ladder moved.
      this.#setCameraFaceFilterStatus(s.landmarksFailed ? "failed" : "active");
      this.#setCameraFaceFilterDegraded(s.degraded);
    };

    this.openModal = modals.openModal;
    this.#mfaFlow = modals.mfaFlow;

    this.getClient = useClient();

    /**
     * Mirror the instance's `remote_control` switch into the store.
     *
     * 🔴 TRACKS `ready()`, NOT `configuration`, and that is the whole point.
     * `Client.configuration` is a PLAIN FIELD, so reading it inside an effect
     * registers no dependency, and `getClient()` is not reactive either. The
     * client object exists before the config has been fetched, so a lone read
     * returns `undefined` on the first and ONLY run and the value latches
     * there forever. Measured 2026-08-06: with the server flag off, a
     * 0.15.93 client still showed "Give control" and the offer dead-ended at
     * `400 FeatureDisabled` — exactly the failure the gate was added to
     * prevent, reintroduced by the same mistake `localUserIdentity.ts` was
     * written about.
     *
     * `ready()` is a real signal, set in the Ready handler and reset on every
     * `connect()`, and the configuration fetch completes before it — so this
     * re-runs with the value present, and re-asserts it after a reconnect.
     *
     * Its own effect rather than folded into the RC listener effect below:
     * adding a `ready()` dependency there would re-bind those listeners on
     * every reconnect, which is a behaviour change this fix does not need.
     */
    createEffect(() => {
      const client = this.getClient();
      if (!client?.ready()) {
        this.remoteControl.setServerEnabled(undefined);
        return;
      }
      this.remoteControl.setServerEnabled(
        (
          client.configuration?.features as
            | { remote_control?: boolean }
            | undefined
        )?.remote_control,
      );
    });

    // Client-local soundboard playback. The `soundboardSound` client event is
    // app-lifetime (not room-scoped), so subscribe ONCE here and do all
    // scoping in the handler — this survives leave/rejoin (a connect/disconnect
    // subscription would go dead after the first call). The effect re-binds if
    // the client instance itself changes (reconnect).
    this.#soundboard = new SoundboardPlayback({
      isActiveChannel: (channelId) =>
        this.state() === "CONNECTED" && this.channel()?.id === channelId,
      deafened: () => this.deafen(),
      outputVolume: () => this.#settings.outputVolume,
      outputDeviceId: () => this.#settings.preferredAudioOutputDevice,
    });
    createEffect(() => {
      const client = this.getClient();
      if (!client) return;
      const handler = (detail: {
        channelId: string;
        soundId: string;
        serverId: string;
        emoji?: string;
      }) => this.#soundboard.handleTrigger(detail);
      client.addListener("soundboardSound", handler);
      onCleanup(() => client.removeListener("soundboardSound", handler));
    });

    // Live captions relayed by the server. Same app-lifetime shape as the
    // soundboard above, and for the same reason: a connect/disconnect
    // subscription would go dead after the first call.
    //
    // Scoping matters here — `CallCaption` arrives on this user's PRIVATE
    // topic, which reaches every session including ones not in the call, so
    // drop anything that isn't the call we're currently connected to.
    createEffect(() => {
      const client = this.getClient();
      if (!client) return;
      const handler = (detail: {
        channelId: string;
        identity: string;
        userId: string;
        text: string;
        lang: string;
      }) => {
        if (this.state() !== "CONNECTED") return;
        if (this.channel()?.id !== detail.channelId) return;
        this.captions.handleRemoteCaption(detail);
      };
      client.addListener("callCaption", handler);
      onCleanup(() => client.removeListener("callCaption", handler));
    });

    // "Ask for a turn" requests (pass-the-controller slice 2). Same
    // app-lifetime, private-topic shape as captions above — a
    // `CallControlRequest` reaches every session of the sharer, so drop
    // anything that is not the call we are connected to. Also drop anything
    // not addressed to US as the sharer: the server addresses these privately
    // by sharer id, but a client must never take a server-asserted "this is
    // for you" as more than a hint, so re-check against our own id.
    createEffect(() => {
      const client = this.getClient();
      if (!client) return;
      const handler = (detail: {
        channelId: string;
        requesterId: string;
        sharerId: string;
      }) => {
        if (this.state() !== "CONNECTED") return;
        if (this.channel()?.id !== detail.channelId) return;
        if (detail.sharerId !== client.user?.id) return;
        // The requester id is server-stamped; the timestamp is ours (it only
        // orders and ages the on-screen list, it is trusted for nothing).
        this.#setPendingTurnRequests((requests) =>
          addTurnRequest(requests, detail.requesterId, Date.now()),
        );
      };
      client.addListener("callControlRequest", handler);
      onCleanup(() => client.removeListener("callControlRequest", handler));
    });

    // Screen-share annotations + their consent state. Same app-lifetime,
    // private-topic shape as captions: both events reach every session of
    // this user, so drop anything that is not the call we are connected to.
    // The store additionally drops stroke batches whose annotator is not on
    // the mirrored allowlist (the server enforces consent regardless — the
    // local check only closes the revoke-beats-stroke race).
    createEffect(() => {
      const client = this.getClient();
      if (!client) return;
      const strokeHandler = (detail: {
        channelId: string;
        annotatorIdentity: string;
        annotatorId: string;
        targetIdentity: string;
        targetId: string;
        strokes: { points: number[]; color: number; width: number }[];
        seq: number;
      }) => {
        if (this.state() !== "CONNECTED") return;
        if (this.channel()?.id !== detail.channelId) return;
        this.annotations.handleRemoteAnnotation(detail);
      };
      const consentHandler = (detail: {
        channelId: string;
        sharerId: string;
        allowed: string[];
      }) => {
        if (this.state() !== "CONNECTED") return;
        if (this.channel()?.id !== detail.channelId) return;
        this.annotations.handleConsent(detail);
      };
      client.addListener("callAnnotation", strokeHandler);
      client.addListener("callAnnotationConsent", consentHandler);
      onCleanup(() => {
        client.removeListener("callAnnotation", strokeHandler);
        client.removeListener("callAnnotationConsent", consentHandler);
      });
    });
    // Re-point any in-flight soundboard playback when the output device
    // changes mid-call (future plays read the device per-play already).
    createEffect(() => {
      this.#settings.preferredAudioOutputDevice;
      this.#soundboard.refreshOutputDevice();
    });
    // Re-point the VAD capture when the input device changes mid-call: the
    // in-call switcher restarts the PUBLISHED track itself (switchActiveDevice)
    // but the VAD stream is opened by us and would otherwise keep listening on
    // the old device. `#startVAD` no-ops unless voice-activity mode is on.
    createEffect(() => {
      this.#settings.preferredAudioInputDevice;
      // Untracked as a block: `#startVAD` synchronously reads `vadEnabled`
      // (and re-reads the preference) before its first await, which would
      // otherwise silently join this effect's dependency set and make the
      // mid-call VAD checkbox live-apply only in calls where the device
      // preference had been touched.
      untrack(() => {
        const room = this.room();
        if (room && this.state() === "CONNECTED") void this.#startVAD(room);
      });
    });

    // Identify this device to native as soon as the session is hydrated.
    // BOTH handshake commands fail closed until this is set — it is what
    // stops a hostile server supplying both halves of the key-derivation
    // transcript by having the controller echo back a server-asserted id.
    // The reactivity trap this closes, and why it is its own module rather
    // than an effect written inline here, is in `localUserIdentity.ts`.
    watchLocalUserId(
      () => this.getClient(),
      (userId) => void this.remoteControl.setLocalUser(userId),
    );

    // Remote control. App-lifetime like the soundboard above, and for the
    // same reason: these are client events, not room events.
    createEffect(() => {
      const client = this.getClient();
      if (!client) return;

      this.remoteControl.setApiContext({
        apiBase: client.options.baseURL,
        authHeader: client.authenticationHeader as [string, string],
      });

      const onOffered = (detail: {
        channelId: string;
        offerId: string;
        sharerId: string;
        targetId: string;
        sharerEphemeralPub: string;
        rcSessionId: string;
      }) => {
        // `EventV1::private(id)` publishes to EVERY session of the target —
        // off-call desktops, web, Android. Only the session that is actually
        // in this call can complete the exchange, and the offer is
        // single-use and offer-addressed, so a web tab answering first
        // BURNS it and the desktop that could have taken it can no longer
        // accept. Filter hard, and stay silent rather than showing a prompt
        // that cannot be honoured.
        if (this.state() !== "CONNECTED") return;
        if (this.channel()?.id !== detail.channelId) return;
        void this.remoteControl.supported().then((ok) => {
          if (!ok) return;
          this.remoteControl.presentOffer({
            channelId: detail.channelId,
            offerId: detail.offerId,
            sharerId: detail.sharerId,
            sharerEphemeralPub: detail.sharerEphemeralPub,
            rcSessionId: detail.rcSessionId,
          });
        });
      };

      // Both responses are matched against the OUTSTANDING OFFER, not merely
      // the channel. A cancelled offer survives server-side to its 90 s TTL,
      // so "offer A, cancel, offer B" leaves A's response in flight: matched
      // on channel alone, A declining would tear down the live session with
      // B, and A accepting would arm the current session against the wrong
      // peer key — failing inside `armSession`, whose catch then clears the
      // panel while native stays armed and the indicator stays up. The phase
      // check is the second half: a response can only act on an offer that
      // is still outstanding.
      const respondsToOurOffer = (
        sharing:
          | { channelId: string; offerId?: string; phase: string }
          | undefined,
        detail: { channelId: string; offerId?: string },
      ) =>
        !!sharing &&
        sharing.phase === "offered" &&
        sharing.channelId === detail.channelId &&
        // A server that omits the id gets the old channel-only behaviour
        // rather than a session that can never be answered.
        (!sharing.offerId ||
          !detail.offerId ||
          sharing.offerId === detail.offerId);

      const onAccepted = (detail: {
        channelId: string;
        offerId?: string;
        grantId: string;
        controllerEphemeralPub: string;
      }) => {
        const sharing = this.remoteControl.sharing();
        if (!respondsToOurOffer(sharing, detail)) return;
        void this.remoteControl.armSession({
          grantId: detail.grantId,
          controllerEphemeralPub: detail.controllerEphemeralPub,
          durationMs: 0,
        });
      };

      const onDeclined = (detail: { channelId: string; offerId?: string }) => {
        if (!respondsToOurOffer(this.remoteControl.sharing(), detail)) return;
        void this.remoteControl.endSharing("declined");
      };

      const onEnded = (detail: {
        channelId: string;
        sharerId: string;
        reason: string;
      }) =>
        this.remoteControl.onServerEnded(
          detail.channelId,
          detail.sharerId,
          detail.reason,
          // `RemoteControlEnded` is a CHANNEL-TOPIC event: it reaches every
          // `ViewChannel` subscriber, and §0.7 permits several sharers per
          // call. Without our own id to compare against, any other person's
          // session ending in this channel would tear ours down.
          client.user?.id,
        );

      client.addListener("remoteControlOffered", onOffered);
      client.addListener("remoteControlAccepted", onAccepted);
      client.addListener("remoteControlDeclined", onDeclined);
      client.addListener("remoteControlEnded", onEnded);
      onCleanup(() => {
        client.removeListener("remoteControlOffered", onOffered);
        client.removeListener("remoteControlAccepted", onAccepted);
        client.removeListener("remoteControlDeclined", onDeclined);
        client.removeListener("remoteControlEnded", onEnded);
      });
    });

    // Channel-wide "who is controlling whom" visibility (pass-the-controller
    // slice 0). App-lifetime like the soundboard above, and its OWN
    // `remoteControlEnded` listener — deliberately additive to the one in the
    // session effect: that handler tears down OUR OWN sharing session (it
    // compares against `client.user?.id`); this one only maintains the
    // channel-keyed map every `ViewChannel` subscriber is meant to see.
    //
    // No call-membership filter, unlike captions: both events arrive on the
    // CHANNEL topic, already server-scoped to `ViewChannel`, and reaching
    // text members who never joined the call is the intended third-party /
    // moderator visibility. Scoping is the channel key itself; readers pick
    // the channel they render.
    createEffect(() => {
      const client = this.getClient();
      if (!client) return;
      const onActive = (detail: {
        channelId: string;
        sharerId: string;
        controllerId: string;
      }) =>
        this.#setRemoteControlSessions((map) =>
          applyRemoteControlActive(map, detail),
        );
      // `reason` is an OPEN string (the server keeps growing the vocabulary
      // and the doc-comment enumeration is already stale) — never switch on
      // it here; any end clears the entry.
      const onEndedVisibility = (detail: {
        channelId: string;
        sharerId: string;
        reason: string;
      }) =>
        this.#setRemoteControlSessions((map) =>
          applyRemoteControlEnded(map, detail),
        );
      client.addListener("remoteControlActive", onActive);
      client.addListener("remoteControlEnded", onEndedVisibility);
      onCleanup(() => {
        client.removeListener("remoteControlActive", onActive);
        client.removeListener("remoteControlEnded", onEndedVisibility);
      });
    });

    // The map above is event-sourced with no backfill, so an `Ended` missed
    // across a WS gap would leave a permanently stale "X is controlling"
    // claim — the worst failure mode an abuse-visibility surface can have.
    // `ready()` resets on every (re)connect, so whenever the socket is down
    // or re-establishing, drop everything and let live events rebuild it: a
    // false-negative until the next `RemoteControlActive`, never a
    // false-positive. Its OWN effect, not a `ready()` read in the listener
    // effect above — that would re-bind the listeners on every reconnect
    // (see the serverEnabled effect's comment).
    createEffect(() => {
      const client = this.getClient();
      if (!client?.ready()) {
        this.#setRemoteControlSessions(EMPTY_REMOTE_CONTROL_SESSIONS);
      }
    });

    // Dice-roll toasts. A server-authoritative /roll is just a flagged message
    // on the channel, which every call participant already receives — so, like
    // the soundboard, subscribe app-lifetime here and scope in the handler
    // (survives leave/rejoin). When a DiceRoll message lands in the channel we
    // have a call open for, flash "<user> rolled a <total>" over the video.
    createEffect(() => {
      const client = this.getClient();
      if (!client) return;
      const handler = (message: Message) =>
        this.#onMessageForDiceToast(message);
      client.addListener("messageCreate", handler);
      onCleanup(() => client.removeListener("messageCreate", handler));
    });

    this.screenShareTracks = new Set();
  }

  /**
   * Handle an incoming message for the dice-roll overlay: show a toast only if
   * it's a server-authoritative roll in the channel we're actively in a call
   * for. All scoping lives here (the listener is app-lifetime).
   */
  #onMessageForDiceToast(message: Message): void {
    if (this.state() !== "CONNECTED") return;
    if (message.channelId !== this.channel()?.id) return;
    if (!isDiceRollMessage(message.flags, message.content)) return;

    const summary = summariseDiceRoll(message.content);
    if (!summary) return;

    const id = ++this.#diceToastSeq;
    this.#setDiceRolls((prev) =>
      [
        ...prev,
        { id, username: message.username ?? "Someone", ...summary },
      ].slice(-MAX_DICE_TOASTS),
    );

    const timer = setTimeout(() => {
      this.#diceToastTimers.delete(timer);
      this.#setDiceRolls((prev) => prev.filter((t) => t.id !== id));
    }, DICE_TOAST_MS);
    this.#diceToastTimers.add(timer);
  }

  /** Drop any pending dice toasts + their removal timers (call teardown). */
  #clearDiceToasts(): void {
    for (const timer of this.#diceToastTimers) clearTimeout(timer);
    this.#diceToastTimers.clear();
    this.#setDiceRolls([]);
  }

  /**
   * Join the given channel's call. Resolves `true` only when THIS invocation
   * still owned the call at completion — `false` when it was doomed mid-join
   * (the user hung up while connecting, or a newer join superseded it).
   * Callers chaining capture toggles ("start a video call") must gate on it:
   * an ungated toggle after a doomed join lands in whatever call survived.
   */
  async connect(
    channel: Channel,
    auth?: { url: string; token: string },
  ): Promise<boolean> {
    this.disconnect();
    // Supersession token: a later connect() runs disconnect() first and bumps
    // this, so a stale invocation resuming after an await can detect it lost
    // and bail (gate HIGH — async-registration race).
    const gen = ++this.#connectGen;

    // Pin the saved microphone with an EXACT constraint when it is currently
    // present. `audioCaptureDefaults` hands getUserMedia a bare string, which
    // is only an "ideal" hint — a saved mic that is busy (Windows exclusive
    // mode) or whose id has gone stale silently yields a DIFFERENT
    // microphone, while every picker keeps showing the saved one as selected:
    // "mic connected, no audio" until the user reselects it in the in-call
    // switcher (which works precisely because `switchActiveDevice` uses
    // `{ exact }`). A device absent from the enumeration keeps the bare
    // string (first join before the permission grant, mic currently
    // unplugged), so joining is never stricter than before when the id could
    // not have matched anyway.
    let audioInputDevice: ConstrainDOMString | undefined =
      this.#settings.preferredAudioInputDevice;
    this.#pinnedMicId = undefined;
    if (audioInputDevice) {
      let present = false;
      try {
        const inputs = await Room.getLocalDevices("audioinput", false);
        present = inputs.some((d) => d.deviceId === audioInputDevice);
      } catch {
        // enumeration unavailable — keep the best-effort hint
      }
      // Superseded while enumerating: nothing constructed yet, just yield
      // (and leave the newer invocation's pin marker alone).
      if (gen !== this.#connectGen) return false;
      if (present) {
        this.#pinnedMicId = audioInputDevice as string;
        audioInputDevice = { exact: audioInputDevice as string };
      }
    }

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
    // Wire the "Encrypt my calls" accessor into the bridge (§0.2 #9) so the
    // media-E2EE KeyPackage pre-publish is gated on the local toggle (ME-14).
    bridge?.setCallsEnabled(() => this.#settings.e2eeCallsEnabled);
    let e2eeCapable =
      isE2EESupported() &&
      nativeE2EEAvailable() &&
      !!bridge?.nativeKeyPushAvailable() &&
      // Media E2EE is NOT audited on the Electron shell yet (EL1 audit S7,
      // hard exit criterion): fail-closed there even though insertable
      // streams + the key-push channel both probe TRUE — flipped
      // per-platform only by EL4's own audited slice.
      platformMediaE2EESupported() &&
      // "Encrypt my calls" (§0.2 #9): with it OFF we negotiate plaintext —
      // no session, no E2EE Room — and appear non-enrolled to E2EE peers
      // (their loud downgrade attributes it to us). LOCAL per-device toggle.
      this.#settings.e2eeCallsEnabled;
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

    // Snapshot the call's E2EE capability for the caption fail-closed gate:
    // captions must never broadcast on a call that can be encrypted unless the
    // mode is positively plaintext.
    this.#setCallE2EECapable(e2eeCapable);

    // Device-qualified LiveKit identity (slice 6.1/6.4 item 3): source the
    // E2EE device id so `joinCall` mints identity `{user_id}:{device_id}` —
    // MlsKeyProvider's local-last send-key switch matches frame keys by that
    // exact identity. Undefined ⇒ we request no qualified identity (non-E2EE
    // / not-yet-provisioned), and the identity assertion below is skipped.
    const selfUserId = this.getClient()?.user?.id;
    const e2eeDeviceId = e2eeCapable
      ? bridge?.status.get("state")?.device_id
      : undefined;

    // Resolved once so the Room option and the post-connect sink switch below
    // can never disagree about which audio path this call is on.
    const webAudioMix =
      this.#settings.webAudioMix &&
      localStorage.getItem(DISABLE_WEB_AUDIO_MIX_KEY) !== "1";

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
      // Mix remote audio through one shared AudioContext owned by the SDK.
      // This is what makes per-user volume above 100% work: with a context
      // set, livekit's `setVolume` drives a GainNode rather than
      // `HTMLMediaElement.volume` (capped at 1.0). Critically it also re-wires
      // the graph on every track attach, so a boosted participant survives a
      // reconnect — the hand-rolled graph this replaces stayed bound to the
      // pre-reconnect MediaStreamTrack and went permanently silent.
      //
      // Read once, here: flipping the setting mid-call does nothing until the
      // next join. See `TypeVoice.webAudioMix` for the kill-switch rationale.
      webAudioMix,
      audioCaptureDefaults: {
        deviceId: audioInputDevice,
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

    // A Muted event on OUR OWN screenshare video can only be the server: no
    // client path calls mute() on it (the quality dialog and the E2EE
    // publish gate pause upstream, a different event, and a browser capture
    // stall also only pauses upstream — verified against livekit-client
    // 2.15.13). voice-ingress muting the track — an out-of-band aspect
    // ratio, or the call being over the video cap — was previously invisible
    // to the sharer: their preview kept playing while nobody received a
    // frame. Room-level rather than per-publication so it survives a
    // reconnect's republish (which creates a fresh publication and would
    // strand a listener on the old one).
    room.on(RoomEvent.TrackMuted, (publication, participant) => {
      if (participant !== room.localParticipant) return;
      if (publication.source !== Track.Source.ScreenShare) return;
      this.onErr(
        new Error(
          "The server turned off your screenshare video — the share may be an unsupported shape, or the call may be full for video. You're still in the call.",
        ),
      );
    });

    // Autoplay gate. livekit flips `canPlaybackAudio` false when the browser
    // refuses playback (suspended AudioContext / element play() rejection)
    // and back to true once playback succeeds — including via its own
    // startAudio-on-mic-publish rescue, so the banner self-clears for users
    // the rescue reaches. Room-level and registered before connect: the
    // failure can fire during the initial track attach.
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      this.#setAudioPlaybackBlocked(!room.canPlaybackAudio);
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
      // Lives in this root (not in a component) so it is armed for the whole
      // call and torn down with the track list on disconnect — the call card
      // unmounts whenever the user browses to another channel.
      this.#watchScreenShareFocus();
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
      // Captions relay through the SERVER, not a LiveKit data channel: the
      // voice token is minted `can_publish_data: false`, so the SFU silently
      // drops anything published and no remote participant ever sees a line.
      // Ingestion is the app-lifetime `callCaption` subscription in the
      // constructor; this half is send-only.
      this.captions.attach(room.localParticipant.identity, (text, lang) => {
        void channel.sendCaption(text, lang).catch((error) => {
          // Best-effort, exactly like the old data-channel path: a dropped
          // line (offline blip, ratelimit) is superseded by the next
          // utterance and must never break the call.
          console.error("caption relay failed", error);
        });
      });
      // Annotations: bind the local identity for the self-mirror, and seed
      // the draw-consent mirror over REST — a client joining mid-call has
      // missed every consent event, and without the seed it would neither
      // show the draw affordance nor render already-allowed helpers' ink
      // (the pass-the-controller slice-0 backfill lesson, applied on day
      // one). Best-effort: the events keep it current from here.
      this.annotations.attach(
        room.localParticipant.identity,
        this.getClient()?.user?.id ?? "",
      );
      void channel
        .fetchAnnotationConsent()
        .then((entries) => this.annotations.seedConsent(entries))
        .catch(() => {});
      this.remoteControl.attach(room, room.localParticipant.identity);
      // Capability beacon (pass-the-controller slice 2): tell the call this
      // client could RECEIVE control, so a sharer's rotation queue can mark
      // desktop peers rather than discovering non-desktop ones via a 90 s
      // offer timeout. Gated on the FULL native probe (server flag +
      // ENABLE_REMOTE_CONTROL + Tauri + rc_status), not the build flag alone:
      // a desktop build where injection is unsupported must not advertise.
      // Best-effort with one retry, because we fire at connect and the
      // voice-ingress webhook that creates our voice state can race this —
      // an announce that lands before the state exists would 400.
      void this.#announceRcCapable(channel, gen);
      this.#startPushToTalk(room);
      this.#startVAD(room);
      const isAfk = channel.name?.toLowerCase() === "afk";
      // Honour the persisted pre-call state (the sidebar user bar makes
      // muting/deafening before a call a first-class action): a deafened or
      // explicitly muted user must never join with a hot microphone, even in
      // open-mic mode. Only reconcile micOn against the actual track when we
      // asked for it — a deafen/AFK-forced "off" is not a mute preference.
      const wantMic = !isAfk && !this.#settings.deafen && this.#settings.micOn;
      if (this.speakingPermission)
        this.#setMicEnabled(room, wantMic)
          .then((track) => {
            if (wantMic) this.#settings.micOn = track != null;
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
          })
          .catch(() => {
            // Capture failed even after the rescue (or permission denied) —
            // or a processor attach above threw post-publish. Reconcile the
            // mute button with the room's ACTUAL state rather than forcing
            // "muted": a hot mic must never be shown as off. Only while we
            // still own the call: when the rejection IS the hang-up (teardown
            // aborting the capture), writing the torn-down room's "off" here
            // would persist a mute preference the user never chose.
            if (wantMic && gen === this.#connectGen)
              this.#settings.micOn = room.localParticipant.isMicrophoneEnabled;
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
      // The chip's participant/track domain changed (R2-3/FE-8): bump the
      // version so the derived chip re-runs (remoteParticipants is not reactive).
      this.#setCallParticipantsVersion((v) => v + 1);
    });

    room.addListener("participantDisconnected", (participant) => {
      this.sound.playSound("userLeaveVoice");
      // Arm the 10 s leave-grace before removing the departed leaf from the MLS
      // group (a transient blip must not churn remove+rejoin).
      this.#mlsSession?.onParticipantLeft(participant.identity);
      this.#setCallParticipantsVersion((v) => v + 1);
    });

    // Fires AFTER LiveKit finishes restarting the camera track for a new
    // device. Re-apply effects here (not on the store write) so hardware
    // brightness — dropped by restart — is re-established on the NEW source.
    room.addListener("activeDeviceChanged", (kind) => {
      if (kind === "videoinput") void this.reapplyCameraEffects();
    });

    room.addListener("trackPublished", (pub) => {
      // Gate (b)'s quantification domain changed (R2-3): a trackless-then-
      // publishing REMOTE participant must drop the chip from green
      // immediately, not on the next unrelated join/leave.
      this.#setCallParticipantsVersion((v) => v + 1);
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
      // Gate (b)'s quantification domain changed (R2-3): re-derive the chip.
      this.#setCallParticipantsVersion((v) => v + 1);
    });

    // Publish-gate hardening (R2-1): a NEW local publication, or livekit's
    // two unconditional resume paths, must never bypass a held gate:
    //  (a) `setMediaStreamTrack` (device switch / unmute-restart / reconnect)
    //      ends in an unconditional `resumeUpstream()` — `_isUpstreamPaused`
    //      goes false and `UpstreamResumed` fires, so a bare `pauseUpstream()`
    //      re-asserts cleanly.
    //  (b) `setProcessor` (denoise/gain/camera-effects attach) calls
    //      `sender.replaceTrack(processedTrack)` DIRECTLY without touching
    //      `_isUpstreamPaused` and emits only `TrackProcessorUpdate` — the
    //      flag stays stale-true, so a bare `pauseUpstream()` would no-op on
    //      its own idempotency guard while real RTP flows. The re-assert for
    //      this path is resume-then-pause (the resume resets the flag; its
    //      nested `UpstreamResumed` triggers arm (a), whose bare pause
    //      serializes behind livekit's per-track lock and early-returns —
    //      bounded, no loop; verified against the pinned 2.15.13 source).
    room.addListener("localTrackPublished", (pub) => {
      this.#setCallParticipantsVersion((v) => v + 1);
      if (this.#publishGate.size > 0) void this.#applyPublishGate(room);
      const track = pub.track;
      if (!track) return;
      track.on(TrackEvent.UpstreamResumed, () => {
        if (this.#publishGate.size > 0) void this.#applyPublishGate(room);
      });
      track.on(TrackEvent.TrackProcessorUpdate, () => {
        if (this.#publishGate.size === 0) return;
        void (async () => {
          try {
            await track.resumeUpstream(); // reset the stale pause flag
          } catch {
            /* unsupported/edge — the pause below still applies */
          }
          // The gate may have EMPTIED while we serialized behind livekit's
          // per-track lock (e.g. the session settled plaintext and released
          // `negotiating` mid-sequence) — re-check before the trailing pause,
          // or a healthy call ends silently muted with nothing left to resume
          // it (re-verify MED-A).
          if (this.#publishGate.size === 0) return;
          try {
            await track.pauseUpstream();
          } catch {
            /* torn-down track */
          }
        })();
      });
    });

    try {
      // --- Media E2EE wiring (slice 6.3/6.4) --------------------------
      // The frame-key path + the media-plane observers are wired here; the
      // MLS control-plane session (constructed after room.connect, below) is
      // the SOLE driver of all of it. Inert until `media_e2ee_enabled` flips
      // (6.5). Inside the try DELIBERATELY: `await bridge.onCallKeysChanged`
      // can reject (native listener registration), and an owned rejection
      // outside the try escaped with no teardown — worker/provider held and
      // the UI stuck on CONNECTING until the next user action.
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
            // Strip THIS room's listeners before abandoning it (FE-9c): its
            // async `disconnected` event would otherwise fire `#setState(
            // "DISCONNECTED")` + `nativeCallServiceStop()` and clobber the newer
            // call's state / kill its foreground service.
            room.removeAllListeners();
            room.disconnect();
            return false;
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
        // (failureTolerance:0, §1.5) — hand it to the session's §4.4
        // rotation-window-vs-loud classification. Latching happens ONLY via the
        // session's verdict (`onEncryptionState("loud")` in #buildMediaBinding),
        // NOT directly here (6.7b fix): a joiner receiving already-encrypted
        // frames before its Welcome resolves raises EXPECTED missing-key errors,
        // and a direct latch pinned the chip loud past a successful join. A
        // session-less error can't latch — but session-less means torn down /
        // never constructed, where the ME-7 no-session policy arm already keeps
        // an E2EE-known call loud (chipState `channelHasOpenGroup` branch).
        room.addListener("encryptionError", (error) => {
          this.#mlsSession?.noteEncryptionError(error);
        });
      }

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
        room.removeAllListeners(); // FE-9c — don't let its `disconnected` clobber
        room.disconnect();
        return false;
      }

      // Assert the `negotiating` publish gate BEFORE connect (R2-5): a plain
      // mic publish is initiated in the `connected` handler, which races
      // session construction — the gate must already hold so no plaintext
      // frame escapes the negotiation window. The session takes over managing
      // this reason once bound (releases it on its verdict). Only for E2EE-
      // capable shells (an unsupported shell is a normal plaintext call).
      if (e2eeCapable) this.#publishGate.add("negotiating");

      await room.connect(auth.url, auth.token, {
        autoSubscribe: false,
      });
      if (gen !== this.#connectGen) {
        // Deliberately NOT `publishGate.delete("negotiating")`: every gen
        // bump comes via disconnect(), which already CLEARED the gate — and
        // a newer connect() may have re-added its OWN `negotiating` since,
        // which this stale invocation must not strip (the gate is what stops
        // plaintext escaping the newer call's negotiation window).
        room.removeAllListeners(); // FE-9c
        room.disconnect();
        return false;
      }
      // Sweep any already-published local track under the gate (a track can
      // publish during `await room.connect`).
      if (this.#publishGate.size > 0) await this.#applyPublishGate(room);
      // That sweep awaited: re-check ownership before touching shared state
      // below (`#mlsSession` assignment) — a stale write there would leave a
      // live MLS session bound to a disposed Room after a hang-up, or
      // clobber the newer call's session.
      if (gen !== this.#connectGen) {
        room.removeAllListeners(); // FE-9c
        room.disconnect();
        return false;
      }

      // Point the shared AudioContext at the preferred output device.
      //
      // Under `webAudioMix` the SDK mutes every <audio> element and plays
      // through the context instead, but it only ever calls
      // `audioContext.setSinkId` from `switchActiveDevice` — the `audioOutput`
      // option passed to the Room constructor reaches the (muted) elements
      // only. Without this, a user whose output is not the system default
      // hears the call from the WRONG device until they touch the picker.
      // Non-fatal: a failed switch still plays, just on the default device.
      if (webAudioMix && this.#settings.preferredAudioOutputDevice) {
        try {
          await room.switchActiveDevice(
            "audiooutput",
            this.#settings.preferredAudioOutputDevice,
          );
        } catch (error) {
          console.warn(
            "[rtc] could not apply preferred output device to the audio mix",
            error,
          );
        }
        if (gen !== this.#connectGen) {
          room.removeAllListeners(); // FE-9c
          room.disconnect();
          return false;
        }
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

      // Probe whether this channel already has an open E2EE group — the chip's
      // in-call FE-7 input, the §0.2 #9 self-attribution for web/toggle-off
      // shells (gate F4: this must run for EVERY call, not just E2EE-capable
      // ones), and the T0d fail-safe's tri-state gate (media-gate LOW-2: the
      // fail-safe holds the publish gate while the probe is PENDING; a
      // completed 404 / feature-off / error resolves "none" — probe-error ⇒
      // availability escape is RATIFIED, same origin as the DS, R2-6). Raw
      // authenticated fetch so it works without the desktop bridge.
      this.#openGroupProbe = "pending";
      {
        const apiClient = this.getClient();
        if (apiClient) {
          const [authHeader, authValue] = apiClient.authenticationHeader;
          void fetch(
            `${apiClient.options.baseURL}/mls/channels/${channel.id}/open_group`,
            {
              headers: { [authHeader]: authValue },
              signal: AbortSignal.timeout(OPEN_GROUP_PROBE_TIMEOUT_MS),
            },
          )
            .then(async (response) => {
              // Ownership guard: a stale probe resolving after a hang-up /
              // rejoin must not clobber the NEXT call's tri-state (the T0d
              // fail-safe reads it; the new call runs its own probe).
              if (gen !== this.#connectGen) return;
              const open = response.ok;
              this.#openGroupProbe = open ? "open" : "none";
              this.#setCallChannelHasOpenGroup(open);
            })
            .catch(() => {
              if (gen !== this.#connectGen) return;
              this.#openGroupProbe = "none";
            });
        } else {
          this.#openGroupProbe = "none";
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
          channelHasOpenGroup: () => this.#openGroupProbe,
        });
        session.bindMedia(this.#buildMediaBinding(room, this.#mlsKeyProvider));
        this.#mlsSession = session;
        void session.start();
      } else if (e2eeCapable) {
        // Capable shell but identity/provider setup failed: release the gate
        // (no session will manage it) so the plain call is not stuck muted.
        this.#publishGate.delete("negotiating");
        if (this.room() === room) void this.#applyPublishGate(room);
      }
    } catch (error) {
      // Ownership decides everything below — snapshot BEFORE disconnect(),
      // which bumps the token.
      const owned = gen === this.#connectGen;
      if (owned) {
        // We still own the call: tear the half-built call down FULLY.
        // Anything narrower leaves `negotiating` held in the publish gate
        // and the UI stuck on CONNECTING with a dead room until the next
        // user action. disconnect() also disposes this invocation's E2EE
        // resources (session, native listener, worker — gate MEDIUM), which
        // an inline cleanup here used to do by hand.
        this.disconnect();
        throw error;
      }
      // Doomed: whoever bumped the token already tore down the shared state
      // and (normally) this room — belt-and-braces, since the rejection can
      // land before the teardown's own room.disconnect() settles. The
      // failure itself is not actionable: it is usually OUR teardown
      // aborting `room.connect()` (the user hung up while still connecting,
      // or a newer join took over), and several call sites run
      // `voice.connect()` unawaited — a rethrow would surface an error for
      // a hang-up the user asked for.
      try {
        room.disconnect();
      } catch {
        /* not connected */
      }
      return false;
    }
    return true;
  }

  disconnect() {
    try {
      // Doom any in-flight connect() FIRST: every await in connect() re-checks
      // this token and bails with its own room teardown. Without the bump a
      // disconnect landing mid-await was silently lost — connect() resumed,
      // called room.connect() on the Room this teardown had already disposed,
      // and the user ended up joined to a call they had just left. (A fresh
      // join still supersedes cleanly: connect()'s own leading disconnect()
      // is followed by its own bump.)
      this.#connectGen++;
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
      this.captions.detach();
      this.annotations.detach();
      // Whisper state dies with the call: the room is going away, so there
      // is nothing to unpublish or restore — just stop the capture.
      this.whisper.reset();
      this.#setIncomingWhisperFrom(undefined);
      this.#screenShield = undefined;
      // Ends the capture surface and releases every held key and button. A
      // controller who leaves the call while holding Ctrl must not leave it
      // held down on someone else's machine — the sharer's native watchdog
      // is the real guarantee, but there is no reason to make it do the work.
      void this.remoteControl.endControlling("call_disconnected");
      void this.remoteControl.endSharing("call_disconnected");
      this.remoteControl.detach();
      this.#clearDiceToasts();
      this.callEncryption.clear();
      this.#publishGate.clear();
      this.#pinnedMicId = undefined;
      this.#setCallEncryptionError(undefined);
      this.#setCallNonEnrolled([]);
      // Reset the 6.5 signals so the next call's card never flashes this
      // call's latched mode/roster/attribution (FE-9a).
      this.#setCallMode(undefined);
      this.#setCallE2EECapable(false);
      this.#setCallAnnouncedBy(undefined);
      this.#setCallRoster({ members: [], ghosts: [] });
      this.#setCallChannelHasOpenGroup(false);
      this.#setCallRosterPanelOpen(false);
      this.#openGroupProbe = "pending";
      // Reset on disconnect (the audited slice-0 shape): prefer a
      // false-negative over any chance of a stale claim. The cost is real —
      // leaving and rejoining a call whose session is still live shows no
      // badge until the NEXT `remoteControlActive`, because the map is
      // event-sourced with no backfill. That late-joiner gap is a known
      // slice-0 limit; a Ready-payload/on-join snapshot in a later slice is
      // the fix, not retaining state we can no longer trust here.
      this.#setRemoteControlSessions(EMPTY_REMOTE_CONTROL_SESSIONS);
      // The rotation queue is per-call by definition — it names participants
      // of the call being left. Carrying it into the next one would offer
      // turns to people who are not there.
      this.#setControllerQueue(EMPTY_REMOTE_CONTROL_QUEUE);
      // Turn requests name participants of the call being left — carrying
      // them forward would show the next call a stale raised hand.
      this.#setPendingTurnRequests(EMPTY_TURN_REQUESTS);
      this.#setTurnDeadline(undefined);
      this.#setTurnLengthMs(undefined);

      const room = this.room();
      if (!room) return;

      // Finalise the recording BEFORE the room is torn down, because
      // `room.disconnect()` stops every track and the graph would then feed
      // silence into a still-running MediaRecorder.
      //
      // NOT awaited, and this method must stay synchronous: `connect()` calls
      // `disconnect()` without awaiting and then bumps `#connectGen`, so an
      // async teardown here would let a new call start mid-teardown and defeat
      // the supersession token. It is safe unawaited because
      // `MediaRecorder.stop()` runs in this same synchronous turn (the promise
      // executor inside `CallRecorder.stop()` is reached before any await), so
      // the capture boundary lands ahead of the track teardown — only the
      // final flush and the blob assembly finish later, and neither needs the
      // tracks alive.
      //
      // The `disconnect` cause also skips the retraction call: voice-state
      // teardown clears the flag server-side, and the channel is about to go.
      if (this.#recorder) void this.#stopRecording("disconnect");
      // Same shape as the recorder: capture stops in this synchronous turn,
      // and the model finishes whatever it already holds afterwards. The
      // transcript itself is NOT cleared — a call that drops must still leave
      // the words exportable.
      if (this.#transcriber) void this.#stopTranscribing("disconnect");
      this.transcript.clearSpeaking();
      this.#setTranscribing(false);
      this.#setTranscriptionError(undefined);
      this.#setTranscriptionLoading(undefined);
      // Synchronously, and AFTER the stop above so the finalise still reads the
      // generation it started with. This is what makes every in-flight claim
      // stand down: a capture whose start is still resolving (a save dialog
      // left open, a model still loading) must not raise a flag on the call the
      // user has just left, or on the next one.
      this.#captureClaim.reset();
      this.#recordingDismissed.clear();
      this.#setRecordingError(undefined);

      room.removeAllListeners();
      room.disconnect();

      batch(() => {
        this.#setState("READY");
        this.#setRoom();
        this.#setChannel();
        this.#setFullscreen(false);
        this.#setImmersive(false);
        // Per-room state: the next call starts with a fresh Room whose
        // playback status arrives via its own event, not this one's.
        this.#setAudioPlaybackBlocked(false);
        // Focus is per-track-list state: leaving it set would start the NEXT
        // call in the focus layout with nothing to focus, until the card's
        // clearing effect gets a chance to run.
        this.#setFocus(undefined);
        this.vidTracks = () => [];
      });

      this.screenShareTracks = new Set();
      this.#autoFocusedShares.clear();
      this.disposeTrackRoot?.();
      this.disposeTrackRoot = undefined;
      this.#stopPushToTalk();
      this.#stopVAD();

      // Room disconnect stops tracks (destroying attached processors); drop the
      // controller's references and release any virtual-background image URL.
      this.#cameraEffects.reset();
      this.#setCameraBackgroundStatus("idle");
      this.#setCameraFaceFilterStatus("idle");
      this.#setCameraFaceFilterDegraded(0);

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
    // Ownership snapshot: connect() calls this synchronously while it owns
    // the call (no await since its last gen check), so this is that call's
    // token. autoLeave compares against it before acting — see below.
    const gen = this.#connectGen;
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
      onCallModeChanged: (mode, detail) => {
        // §3.4 mode → the 6.5 UI (chip / banner / roster panel). Batched so an
        // intermediate chip state never renders for a frame (FE-8).
        batch(() => {
          this.#setCallMode(mode);
          this.#setCallNonEnrolled(detail.nonEnrolled);
          this.#setCallAnnouncedBy(detail.announcedBy);
        });
      },
      onRosterState: (members, ghosts) => {
        this.#setCallRoster({ members, ghosts });
      },
      autoLeave: (reason) => {
        // ME-10 / A3: never `disconnect()` synchronously from inside the
        // session's own callback — defer (FE-9b). The explainer modal names
        // why the call ended.
        queueMicrotask(() => {
          // Only while the call this binding was built for is still the
          // current one: a stale session continuation surviving dispose()
          // must not tear down the call the user has since joined — the
          // disconnect() below DOOMS an in-flight connect() — nor blame a
          // call they already left with an error modal.
          if (gen !== this.#connectGen) return;
          console.warn("[mls] auto-leaving call:", reason);
          this.disconnect();
          this.openModal({ type: "error2", error: reason });
        });
      },
      setEncryptionEnabled: (enabled) => room.setE2EEEnabled(enabled),
      pausePublishing: (reason) => this.#pauseGate(room, reason),
      resumePublishing: (reason) => this.#resumeGate(room, reason),
    };
  }

  /**
   * The publish-gate reason SET (FE-3/R2-1/R2-7). Publishing flows only when
   * the set is empty; adding a reason SWEEPS existing publications, removing
   * the last reason resumes them. Hardened against livekit-client 2.15.13's
   * unconditional resumes (`setMediaStreamTrack`/`setProcessor`): the
   * LocalTrackPublished + UpstreamResumed listeners (wired at connect) re-apply
   * the gate, so a device switch, unmute-restart, or processor attach can never
   * bypass it while a reason is held.
   */
  async #pauseGate(room: Room, reason: string): Promise<void> {
    // Stale-writer guard: a binding built for a PREVIOUS call must not add
    // reasons to the gate it shares with the current one — its session is
    // disposed, so nothing would ever release them and every new publication
    // would be swept paused (publishing silence with no UI cause).
    if (this.room() !== room) return;
    this.#publishGate.add(reason);
    await this.#applyPublishGate(room);
  }

  async #resumeGate(room: Room, reason: string): Promise<void> {
    // Same stale-writer guard, for the inverse hazard: a stale resume must
    // not release a reason the CURRENT call's session is still relying on.
    if (this.room() !== room) return;
    this.#publishGate.delete(reason);
    await this.#applyPublishGate(room);
  }

  /** Sweep every local publication to match the gate (empty ⇒ resume all). */
  async #applyPublishGate(room: Room): Promise<void> {
    const paused = this.#publishGate.size > 0;
    const ops: Promise<void>[] = [];
    for (const pub of room.localParticipant.trackPublications.values()) {
      if (!pub.track) continue;
      // Re-assert unconditionally: `pauseUpstream` is idempotent, and a
      // resume must only happen when the gate is truly empty.
      ops.push(paused ? pub.pauseUpstream() : pub.resumeUpstream());
    }
    await Promise.allSettled(ops);
  }

  /**
   * Every mic enable goes through here: `setMicrophoneEnabled` plus the
   * exact-pin rescue. When `connect()` pinned the saved mic `{ exact }` and
   * that device has since vanished while no live track existed (unplugged
   * while muted — livekit's own ended-track fallback only runs for a live
   * track), every plain enable would reject with OverconstrainedError
   * forever. Un-pin OUR OWN pin — never an exact constraint the user picked
   * mid-call via `switchActiveDevice` — and retry once on browser defaults:
   * a fallback mic beats a mic that can never come back. Mutating `options`
   * is livekit's own rollback idiom (see Room.switchActiveDevice).
   */
  async #setMicEnabled(room: Room, enabled: boolean) {
    try {
      return await room.localParticipant.setMicrophoneEnabled(enabled);
    } catch (error) {
      const defaults = room.options.audioCaptureDefaults;
      const pinned = this.#pinnedMicId;
      if (
        !enabled ||
        !pinned ||
        typeof defaults?.deviceId !== "object" ||
        (defaults.deviceId as { exact?: string }).exact !== pinned
      )
        throw error;
      this.#pinnedMicId = undefined;
      defaults.deviceId = undefined;
      return room.localParticipant.setMicrophoneEnabled(enabled);
    }
  }

  /**
   * The user gesture that resumes the shared AudioContext after the browser's
   * autoplay policy blocked it. On success livekit emits
   * `AudioPlaybackStatusChanged` and `audioPlaybackBlocked` clears itself; on
   * failure the banner stays up, which is the honest state — silently
   * pretending audio works is exactly the failure mode this exists to fix.
   */
  async startCallAudio() {
    const room = this.room();
    if (!room) return;
    try {
      await room.startAudio();
    } catch (error) {
      // Keep the banner (the event won't have flipped) and log for the
      // console-side diagnosis path — this should be unreachable from a real
      // click, since the click IS the gesture the policy wants.
      console.error("[rtc] startAudio failed — audio is still blocked", error);
    }
  }

  async toggleDeafen(fromMute?: boolean) {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await this.#setMicEnabled(
        room,
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
    // While whispering, the primary mic is intentionally suppressed and the
    // button reads "muted". Pressing it ends the aside and restores the mic
    // rather than toggling the room mic underneath the whisper — otherwise a
    // mute press would silently make the room hot mid-whisper.
    if (this.whisper.target()) {
      await this.stopWhisper();
      return;
    }
    if (this.#settings.deafen) {
      this.toggleDeafen(true);
      return;
    }
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await this.#setMicEnabled(
        room,
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

  /**
   * Whether the "anywhere" toggles should drive the live room. While still
   * CONNECTING the room's mic state is not authoritative (the `connected`
   * handler applies the persisted settings), so route writes to the settings
   * instead — the join path picks them up.
   */
  #liveToggleReady() {
    return this.room() && this.state() !== "CONNECTING";
  }

  /**
   * Mute toggle for persistent UI (the sidebar user bar): applies to the live
   * call when connected, otherwise flips the persisted preference so the next
   * call starts in the chosen state. {@link toggleMute} throws without a room.
   */
  toggleMuteAnywhere() {
    if (this.#liveToggleReady()) return this.toggleMute();
    if (this.#settings.deafen) {
      // Mirror toggleMute's in-call behaviour: unmuting while deafened
      // undeafens and re-enables the microphone.
      this.#settings.deafen = false;
      this.#settings.micOn = true;
      this.sound.playSound("undeafen");
      return;
    }
    this.#settings.micOn = !this.#settings.micOn;
    this.sound.playSound(this.#settings.micOn ? "unmute" : "mute");
  }

  /** Deafen counterpart to {@link toggleMuteAnywhere}. */
  toggleDeafenAnywhere() {
    if (this.#liveToggleReady()) return this.toggleDeafen();
    this.#settings.deafen = !this.#settings.deafen;
    this.sound.playSound(this.#settings.deafen ? "deafen" : "undeafen");
  }

  /**
   * Start (or retarget) a whisper to the given user. Refused while the
   * publish gate is held: the whisper track would sit upstream-paused and
   * the whisperer would be talking to nobody without knowing it.
   *
   * Suppresses the primary room mic through the pin-aware `#setMicEnabled`
   * (so a vanished pinned device rescues rather than silently sticking off)
   * and remembers its prior state to restore on stop.
   */
  async startWhisper(targetUserId: string) {
    const room = this.room();
    try {
      if (!room || this.state() !== "CONNECTED") throw "invalid state";
      if (this.#publishGate.size > 0) throw "call still negotiating";

      this.#whisperPriorMic = room.localParticipant.isMicrophoneEnabled;
      if (this.#whisperPriorMic) await this.#setMicEnabled(room, false);

      await this.whisper.start(room, targetUserId);

      // Aborted mid-start (a stop landed during setup) — undo the mute.
      if (!this.whisper.target()) await this.#restoreWhisperMic(room);
    } catch (e) {
      if (room) await this.#restoreWhisperMic(room).catch(() => undefined);
      this.onErr(e);
    }
  }

  /** End the active whisper, restoring default subscription permissions and
   * the primary mic. */
  async stopWhisper() {
    await this.whisper.stop();
    const room = this.room();
    if (room) await this.#restoreWhisperMic(room);
  }

  /** Re-enable the primary mic to its pre-whisper state, if it was on. */
  async #restoreWhisperMic(room: Room) {
    if (this.#whisperPriorMic && !room.localParticipant.isMicrophoneEnabled) {
      await this.#setMicEnabled(room, true).catch(() => undefined);
    }
    this.#whisperPriorMic = false;
  }

  /** Receiving-side indicator plumbing, written by RoomAudioManager (the
   * one place addressed whisper tracks surface). */
  noteIncomingWhisper(identity: string | undefined) {
    this.#setIncomingWhisperFrom(identity);
  }

  /**
   * Sync the privacy shield on a LIVE screenshare to the stored setting
   * (the pre-share modal's checkbox lands after the track has published, so
   * flipping it must attach/detach in place). No-op without a live share.
   */
  async applyScreenShareShield() {
    const room = this.room();
    const track = room?.localParticipant.getTrackPublication(
      Track.Source.ScreenShare,
    )?.videoTrack as LocalVideoTrack | undefined;
    if (!track) return;

    const want = this.#settings.screenShareShield;
    try {
      if (want && !this.#screenShield) {
        const surface = (
          track.mediaStreamTrack.getSettings() as MediaTrackSettings & {
            displaySurface?: string;
          }
        ).displaySurface;
        // Same monitor gate as the attach at publish time.
        if (surface !== "monitor" && surface !== undefined) return;
        const shield = new ScreenShieldProcessor();
        await track.setProcessor(shield);
        this.#screenShield = shield;
      } else if (!want && this.#screenShield) {
        await track.stopProcessor();
        this.#screenShield = undefined;
      }
    } catch (error) {
      console.error("screen shield sync failed", error);
      this.#screenShield = undefined;
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
          this.#setCameraFaceFilterStatus(
            mode === "none" && this.#faceSettings() ? "initializing" : "idle",
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
        this.#setCameraFaceFilterStatus("idle");
        this.#setCameraFaceFilterDegraded(0);
      }

      this.#setVideo(room.localParticipant.isCameraEnabled);
    } catch (e) {
      this.onErr(e);
    }
  }

  // --- Local call recording (call-recording plan §1) -----------------

  /** Whether this shell can record at all (MediaRecorder + WebAudio + Opus). */
  get recordingSupported(): boolean {
    return callRecordingSupported();
  }

  /**
   * Whether pressing record will open a real save dialog and stream to that
   * file. False on shells without the File System Access API, which fall back
   * to buffering and an anchor download — a path that cannot confirm it
   * worked, so the button copy must not promise a dialog there.
   */
  get recordingSavesToFile(): boolean {
    return saveDialogSupported();
  }

  /** Whether this shell can run the speech model at all. */
  get transcriptionSupported(): boolean {
    return transcriptionSupported();
  }

  /**
   * Participants who say they are recording, as user ids — including this
   * client when it is recording. Drives the banner and the pre-join warning.
   *
   * Read from the CHANNEL's voice participants rather than the LiveKit room:
   * that map is populated from the roster fetch, so it is already correct for
   * someone who joined after a recording began, and it is a `ReactiveMap` so
   * this tracks without a version counter.
   */
  /**
   * Does the SERVER currently believe this user is publishing screen video?
   *
   * `voice.screenshare()` and the local LiveKit publication are both
   * CLIENT-side beliefs, and 2026-08-06 showed they can outlive the truth: a
   * reconnect left the OS capture running, `screenshare()` true, and the
   * local publication resolving a live track with `displaySurface: "monitor"`
   * — while the SFU had no screen-share track at all and the server's
   * `screen_video` was false. Every client-side signal agreed on the wrong
   * answer, so the Give-control button was offered against a share that did
   * not exist and the offer could only ever 400.
   *
   * `VoiceParticipant.isScreenVideo` is fed from the same `screen_video`
   * field the offer route gates on, and it is reactive, so this
   * self-corrects the moment the server's view changes.
   *
   * Returns `undefined` when this user's participant record cannot be
   * resolved at all — no call, or a server that does not send the field —
   * so callers can distinguish "the server says no" from "the server has
   * not said". Never treat `undefined` as a refusal: that would hide the
   * affordance outright on any deployment that omits the field.
   */
  serverSeesScreenVideo(): boolean | undefined {
    const channel = this.channel();
    const self = this.getClient()?.user?.id;
    if (!channel || !self) return undefined;
    const participant = channel.voiceParticipants.get(self);
    if (!participant) return undefined;
    return participant.isScreenVideo();
  }

  recordersInCall(): string[] {
    const channel = this.channel();
    if (!channel) return [];
    const ids: string[] = [];
    for (const participant of channel.voiceParticipants.values()) {
      if (participant.isRecording()) ids.push(participant.userId);
    }
    return ids;
  }

  /**
   * Whether a participant announced remote-control capability
   * (pass-the-controller slice 2). Reactive — reads
   * `VoiceParticipant.isRcCapable`.
   *
   * 🔴 TRUE means "said it can take control"; false is UNKNOWN, not "cannot".
   * A capable desktop that predates the beacon (the slice-1 0.34 build) never
   * announces, so its flag is false — the same value an absent participant
   * has. Callers must therefore only ever use `true` to ADD an affordance (a
   * "Desktop" chip), never to remove one: greying a row on false would hide a
   * peer who can in fact take control. The slice-1 offer-TTL timeout stays the
   * honest fallback for a peer who genuinely cannot.
   */
  participantRcCapable(userId: string): boolean {
    const channel = this.channel();
    if (!channel) return false;
    return channel.voiceParticipants.get(userId)?.isRcCapable() ?? false;
  }

  /** Recorders this user has not dismissed the banner for. */
  undismissedRecorders(): string[] {
    return this.recordersInCall().filter(
      (id) => !this.#recordingDismissed.has(id),
    );
  }

  /** Hide the banner for the recordings currently running. The persistent
   *  indicator stays — see `VoiceCallRecordingBanner`. */
  dismissRecordingBanner(): void {
    for (const id of this.recordersInCall()) {
      this.#recordingDismissed.set(id, true);
    }
  }

  /**
   * Start or stop recording this call locally.
   *
   * **Disclosure precedes capture, deliberately.** The server claim goes out
   * FIRST and capture only begins once it is accepted; if capture then fails
   * we retract the claim. The failure modes are not symmetric — a claim with
   * no recording over-warns for one round trip, while a recording with no
   * claim is exactly the undisclosed capture this feature exists to prevent.
   * So the order is never "start, then tell them".
   *
   * On stop the file is handed to the user even if the retraction call fails:
   * losing someone's recording to a network blip would be worse, and leaving
   * the call clears the flag server-side regardless.
   */
  async toggleRecording(): Promise<void> {
    if (this.recordingBusy()) return;

    const room = this.room();
    const channel = this.channel();
    if (!room || !channel) return;

    // Pin the call this toggle belongs to. The save dialog can sit open for as
    // long as the user likes, so by the time anything below resumes the call
    // may be over — or replaced by a different one.
    const generation = this.#captureClaim.generation;

    if (this.recording()) {
      this.#setRecordingBusy(true);
      this.#setRecordingError(undefined);
      try {
        await this.#stopRecording("user");
      } finally {
        this.#setRecordingBusy(false);
      }
      return;
    }

    if (!callRecordingSupported()) {
      this.#setRecordingError("Recording isn't supported on this device.");
      return;
    }

    // THE PICKER GOES FIRST, AND BEFORE ANY `await`.
    //
    // `showSaveFilePicker` needs transient user activation, which the click
    // that got us here provides — but awaiting anything first spends it and the
    // picker then throws. So: no `await`, no busy flag, no server call ahead of
    // this line.
    //
    // Asking up front (rather than at stop) is also what makes the recording
    // crash-safe and unbounded: audio streams to the file as it is captured, so
    // a browser crash mid-call leaves a valid partial recording instead of
    // losing everything held in memory.
    let target: RecordingTarget | undefined;
    if (saveDialogSupported()) {
      try {
        target = await pickRecordingTarget(
          recordingFilename(
            channel.name,
            Date.now(),
            // The container this shell will really encode, so the suggested
            // extension matches the bytes.
            recordingMimeType() ?? "audio/webm",
          ),
        );
      } catch (error) {
        // Cancelling the dialog is a decision, not a failure: nothing has been
        // claimed and nothing captured, so leave no error on screen.
        if (isSaveCancelled(error)) return;
        this.#setRecordingError("Couldn't open the save dialog.");
        console.error("[rtc] save picker failed", error);
        return;
      }
    }

    this.#setRecordingBusy(true);
    this.#setRecordingError(undefined);

    try {
      // Disclosure precedes capture: the claim goes out BEFORE the recorder
      // starts, and is retracted if the recorder fails to start.
      //
      // A false result means the call ended while the dialog or the claim was
      // open. Nothing was claimed and nothing may be captured, so give up
      // quietly — there is no failure to report to someone who has left.
      const disclosed = await this.#captureClaim.acquire(
        "recording",
        channel.id,
        generation,
      );
      if (!disclosed) {
        await target?.abort().catch(() => undefined);
        return;
      }

      const recorder = new CallRecorder(
        room,
        (reason) => {
          this.#setRecordingError(reason);
          void this.#stopRecording("auto");
        },
        target,
      );

      try {
        await recorder.start();
      } catch (error) {
        // Retract rather than leave the call warned about a recording that
        // never began, and release the file handle we opened.
        //
        // This releases only the RECORDER's share of the claim. If another
        // capture is running, the flag stays up — retracting it here would
        // clear everyone's banner while that capture is still reading audio,
        // which is the one failure this feature exists to prevent.
        await this.#captureClaim
          .release("recording", channel.id, generation)
          .catch(() => undefined);
        await target?.abort().catch(() => undefined);
        throw error;
      }

      this.#recorder = recorder;
      this.#setRecording(true);
    } catch (error) {
      await target?.abort().catch(() => undefined);
      this.#setRecordingError(
        error instanceof Error ? error.message : "Couldn't start recording.",
      );
      console.error("[rtc] recording toggle failed", error);
    } finally {
      this.#setRecordingBusy(false);
    }
  }

  /**
   * Tear down the recorder, save the audio, and clear the claim.
   *
   * Called by the user's Stop, by the recorder's own error/size auto-stop, and
   * by call teardown. Idempotent: `CallRecorder.stop()` returns undefined once
   * already stopped, which matters because disconnect can race the user.
   */
  async #stopRecording(cause: "user" | "auto" | "disconnect"): Promise<void> {
    const recorder = this.#recorder;
    this.#recorder = undefined;
    this.#setRecording(false);

    // Pinned before finalising, which can take a moment on a large file.
    const generation = this.#captureClaim.generation;
    const channelId = this.channel()?.id;
    const channelName = this.channel()?.name;

    if (recorder) {
      // Read BEFORE stop(): finalising clears the handle, so reading it in the
      // catch below would always come back undefined and the error message
      // would never name the file it failed to write.
      const targetName = recorder.targetName;
      try {
        const result = await recorder.stop();
        const mb = result
          ? Math.max(1, Math.round(result.bytes / 1_048_576))
          : 0;

        if (!result) {
          // Started and stopped before a single chunk landed. Say so — silence
          // here would read as a save.
          this.#setRecordingNotice({
            kind: "failed",
            message: "That recording was too short to save.",
            at: Date.now(),
          });
        } else if (result.savedAs) {
          // Streamed: already on disk, and we know its name.
          this.#setRecordingNotice({
            kind: "saved",
            message: `Recording saved to ${result.savedAs} (${mb} MB).`,
            at: Date.now(),
          });
        } else if (result.blob) {
          // Fallback path. `saveRecording` CANNOT confirm it worked (it writes
          // nothing at all in some embedded webviews while reporting success),
          // so the wording claims only what is true: it was handed to the
          // browser.
          const filename = recordingFilename(
            channelName,
            recorder.startedAt,
            result.blob.type,
          );
          saveRecording(result.blob, filename);
          this.#setRecordingNotice({
            kind: "handed-off",
            message: `Recording sent to your downloads as ${filename} (${mb} MB). If it doesn't appear, this app can't save files directly.`,
            at: Date.now(),
          });
        }
      } catch (error) {
        console.error("[rtc] failed to finalise the recording", error);
        this.#setRecordingError("The recording could not be saved.");
        this.#setRecordingNotice({
          kind: "failed",
          message:
            targetName !== undefined
              ? `Couldn't finish writing ${targetName}. Any audio already written is still in the file.`
              : "The recording could not be saved.",
          at: Date.now(),
        });
      }
    }

    // On disconnect the server clears the flag with the voice state, so the
    // retraction is redundant there — and the channel may already be gone. The
    // claim would stand down on the stale generation by itself; the explicit
    // cause keeps that from depending on teardown ordering.
    //
    // Note this only lowers the flag if nothing else is capturing.
    if (channelId && cause !== "disconnect") {
      await this.#captureClaim
        .release("recording", channelId, generation)
        .catch((error) => {
          console.error("[rtc] failed to clear the recording flag", error);
        });
    }
  }

  /**
   * Start or stop transcribing this call on this machine.
   *
   * **The order is warm → claim → capture, and it is not negotiable.**
   *
   * Loading the model can take half a minute on a cold cache. That happens
   * FIRST, before any claim, because a progress bar is not a reason to show
   * everyone in the call a recording banner for something that may never
   * start. Connecting the taps is capture — decrypted audio landing in
   * buffers, whether or not the model has seen it yet — so the claim goes out
   * before that and the taps only follow once the room has been told.
   *
   * Every step re-checks the generation it started with. A model download can
   * easily outlive the call it was started in, and without that check it would
   * raise a flag on a channel the user has already left, or on the next call.
   */
  async toggleTranscription(
    options: { language?: string } = {},
  ): Promise<void> {
    if (this.transcriptionBusy()) return;

    const room = this.room();
    const channel = this.channel();
    if (!room || !channel) return;

    const generation = this.#captureClaim.generation;

    if (this.transcribing()) {
      // NOT awaited, and the busy flag is deliberately not held.
      //
      // Capture ends synchronously inside `#stopTranscribing`; everything the
      // promise is still waiting on is the model finishing text for audio that
      // was already captured. Holding the button disabled through that made
      // stop look broken during a long backlog — reported from a real
      // two-party call. The button frees immediately; the panel reports the
      // remaining work as "finishing N".
      void this.#stopTranscribing("user");
      return;
    }

    if (!transcriptionSupported()) {
      this.#setTranscriptionError(
        "Transcription isn't supported on this device.",
      );
      return;
    }

    this.#setTranscriptionBusy(true);
    this.#setTranscriptionError(undefined);

    try {
      // 1. Warm the model. No claim, no taps, no capture — nothing has been
      //    read and nobody has been told anything yet.
      const engine = getTranscriptionEngine();
      this.#setTranscriptionLoading(0);
      try {
        await engine.load((fraction) => {
          if (generation === this.#captureClaim.generation) {
            this.#setTranscriptionLoading(fraction);
          }
        });
      } finally {
        this.#setTranscriptionLoading(undefined);
      }

      if (generation !== this.#captureClaim.generation) return;

      // 2. Disclosure. Only now does the room learn about it.
      const disclosed = await this.#captureClaim.acquire(
        "transcription",
        channel.id,
        generation,
      );
      if (!disclosed) return;

      // 3. Capture.
      const transcriber = new CallTranscriber(
        room,
        engine,
        this.transcript,
        // Passed in rather than read here: Voice holds the voice settings, not
        // the settings store, and the caller already has it.
        { language: options.language },
        (message) => this.#setTranscriptionError(message),
        (count) => this.#setTranscriptionPending(count),
      );

      try {
        await transcriber.start();
      } catch (error) {
        // Retract this feature's share of the claim. If a recording is also
        // running the flag stays up, which is correct — it is still true.
        await this.#captureClaim
          .release("transcription", channel.id, generation)
          .catch(() => undefined);
        throw error;
      }

      this.#transcriber = transcriber;
      this.#setTranscribing(true);
    } catch (error) {
      this.#setTranscriptionError(
        error instanceof Error
          ? error.message
          : "Couldn't start transcribing this call.",
      );
      console.error("[rtc] transcription toggle failed", error);
    } finally {
      this.#setTranscriptionBusy(false);
    }
  }

  /**
   * Stop transcribing and clear the claim.
   *
   * The transcript is deliberately left alone — it is the product of the
   * feature and must survive until the user exports or discards it.
   */
  async #stopTranscribing(
    cause: "user" | "auto" | "disconnect",
  ): Promise<void> {
    const transcriber = this.#transcriber;
    this.#transcriber = undefined;
    this.#setTranscribing(false);

    const generation = this.#captureClaim.generation;
    const channelId = this.channel()?.id;

    // Capture ends synchronously inside stop(); the returned promise is the
    // model finishing what it already has. Held so that an export started
    // after stop still waits for the tail rather than writing a truncated file.
    const drained = transcriber?.stop();
    this.#draining = drained;
    void drained?.finally(() => {
      if (this.#draining === drained) this.#draining = undefined;
    });

    if (channelId && cause !== "disconnect") {
      await this.#captureClaim
        .release("transcription", channelId, generation)
        .catch((error) => {
          console.error("[rtc] failed to clear the recording flag", error);
        });
    }

    await drained?.catch(() => undefined);
  }

  /**
   * Write the transcript to a file the user picks.
   *
   * **Two phases, and the order matters.** The save dialog is opened
   * SYNCHRONOUSLY from the click, because it needs transient user activation
   * and anything awaited first spends it. Only then does this wait for the
   * model to finish what it is still holding — the queue runs a few seconds
   * behind live speech, so writing at the moment of the click would reliably
   * drop the last thing anyone said, which is usually the reason someone is
   * exporting at all.
   */
  async exportTranscript(
    format: TranscriptFormat,
    names: Map<string, string>,
  ): Promise<void> {
    const startedAt = this.transcript.startedAt ?? Date.now();
    const channelName = this.channel()?.name;
    const filename = transcriptFilename(channelName, startedAt, format);

    // PHASE 1 — the picker, before any await.
    let target: RecordingTarget | undefined;
    if (saveDialogSupported()) {
      try {
        target = await pickRecordingTarget(filename);
      } catch (error) {
        // Cancelling is a decision, not a failure.
        if (isSaveCancelled(error)) return;
        this.#setTranscriptionError("Couldn't open the save dialog.");
        return;
      }
    }

    // PHASE 2 — let the queue drain, THEN write.
    await this.#settleTranscription();

    const text = this.#renderTranscript(format, names, startedAt, channelName);

    if (target) {
      try {
        await target.write(new Blob([text], { type: "text/plain" }));
        await target.close();
      } catch (error) {
        console.error("[rtc] failed to write the transcript", error);
        this.#setTranscriptionError("The transcript could not be saved.");
      }
      return;
    }

    // No picker in this shell. The anchor fallback cannot confirm it worked
    // (it writes nothing at all in some embedded webviews while reporting
    // success), so the copy promises only what is true.
    saveRecording(new Blob([text], { type: "text/plain" }), filename);
  }

  /**
   * Put the transcript on the clipboard.
   *
   * The reliable route where no save dialog exists — and often the one people
   * actually want, since a transcript usually ends up pasted somewhere.
   */
  async copyTranscript(names: Map<string, string>): Promise<void> {
    await this.#settleTranscription();
    const startedAt = this.transcript.startedAt ?? Date.now();
    const text = this.#renderTranscript(
      "txt",
      names,
      startedAt,
      this.channel()?.name,
    );
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("[rtc] failed to copy the transcript", error);
      this.#setTranscriptionError("Couldn't copy the transcript.");
    }
  }

  /**
   * Wait until nothing more is going to be added to the transcript.
   *
   * Two cases, and both have to be covered or an export writes a file that is
   * missing the last thing anyone said: a session still RUNNING (stop it, then
   * wait), and one already stopped whose backlog is still being transcribed in
   * the background. Both are bounded — see `CallTranscriber`'s drain timeout.
   */
  async #settleTranscription(): Promise<void> {
    const running = this.#transcriber;
    if (running) {
      await this.#stopTranscribing("user").catch(() => undefined);
      return;
    }
    await this.#draining?.catch(() => undefined);
  }

  #renderTranscript(
    format: TranscriptFormat,
    names: Map<string, string>,
    startedAt: number,
    channelName: string | undefined,
  ): string {
    const segments = this.transcript.segments();
    return format === "vtt"
      ? toVtt(segments, names)
      : toTxt(segments, names, { channelName, startedAt });
  }

  /**
   * Tell the server whether we are recording. Raw fetch, not the typed
   * client: the generated client sends `{}` for routes it does not know, so a
   * typed call here could silently no-op — and a silent no-op means an
   * undisclosed recording.
   */
  async #claimRecording(channelId: string, recording: boolean): Promise<void> {
    const client = this.getClient();
    if (!client) throw new Error("Not connected.");

    const [header, value] = client.authenticationHeader;
    const response = await fetch(
      `${client.options.baseURL}/channels/${channelId}/recording`,
      { method: recording ? "PUT" : "DELETE", headers: { [header]: value } },
    );

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("You don't have permission to record this call.");
      }

      // The route's 400s are specific and actionable, and a bare status code
      // is not: "(400)" told a user nothing when their voice state had been
      // taken over by a second session and the server correctly refused the
      // claim. Only a participant may claim to be capturing — that rule is
      // what stops someone faking a recording warning for a call they are not
      // in — so the honest message is that they are no longer in the call.
      const reason = await response
        .clone()
        .json()
        .then((body: { type?: string }) => body?.type)
        .catch(() => undefined);

      if (reason === "NotInVoiceChannel") {
        throw new Error("You're not in this call any more.");
      }
      if (reason === "NotAVoiceChannel") {
        throw new Error("This channel isn't a call.");
      }

      throw new Error(
        recording
          ? `Couldn't tell the call about the recording (${reason ?? response.status}).`
          : `Couldn't clear the recording indicator (${reason ?? response.status}).`,
      );
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
    const wantFace = this.#faceSettings();
    try {
      await this.#cameraEffects.apply(videoTrack, {
        backgroundMode: mode,
        blurRadius: this.#settings.cameraBlurRadius ?? 10,
        backgroundImageId: this.#settings.cameraBackgroundImageId,
        brightness: this.#settings.cameraBrightness ?? 100,
        faceFilterId: this.#settings.cameraFaceFilterId,
        beautify: this.#settings.cameraBeautify ?? 0,
        colorLookId: this.#settings.cameraColorLookId,
      });
      this.#setCameraBackgroundStatus(
        this.#cameraEffects.backgroundActive ? "active" : "idle",
      );
      // Inert (background holds the slot) and off both read as idle; the
      // paused badge is derived from the store, not this signal.
      this.#setCameraFaceFilterStatus(
        this.#cameraEffects.faceFilterActive ? "active" : "idle",
      );
    } catch (e) {
      console.error("camera effects failed", e);
      this.#setCameraBackgroundStatus(mode === "none" ? "idle" : "failed");
      // Attribute the failure to the occupant that was actually BUILT: with a
      // background configured, filters were inert and never attempted — a
      // segmenter failure must not read as "Face tracking failed"
      // (diff-review finding 4).
      this.#setCameraFaceFilterStatus(
        wantFace && mode === "none" ? "failed" : "idle",
      );
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

  /** Whether any face-filter setting is active in the store. */
  #faceSettings(): boolean {
    return faceSettingsActive({
      backgroundMode: this.#settings.cameraBackgroundMode ?? "none",
      faceFilterId: this.#settings.cameraFaceFilterId,
      beautify: this.#settings.cameraBeautify ?? 0,
      colorLookId: this.#settings.cameraColorLookId,
      brightness: this.#settings.cameraBrightness ?? 100,
    });
  }

  /**
   * Live-update face-filter settings (sticker / beautify / color look).
   * Persists to the store and reapplies. While a background effect is active
   * the settings write through but stay INERT (plan §5 — the UI shows a
   * paused badge and they take effect when the background is turned off).
   */
  async setCameraFaceFilter(opts: {
    filterId?: CameraFaceFilterId | null;
    beautify?: number;
    colorLookId?: CameraColorLookId | null;
  }) {
    if (opts.filterId !== undefined) {
      this.#settings.cameraFaceFilterId = opts.filterId ?? undefined;
    }
    if (opts.beautify !== undefined) {
      this.#settings.cameraBeautify = opts.beautify;
    }
    if (opts.colorLookId !== undefined) {
      this.#settings.cameraColorLookId = opts.colorLookId ?? undefined;
    }

    const room = this.room();
    if (!room?.localParticipant.isCameraEnabled) return;
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    if (pub?.videoTrack) {
      if (
        this.#faceSettings() &&
        !this.#cameraEffects.faceFilterActive &&
        (this.#settings.cameraBackgroundMode ?? "none") === "none"
      ) {
        this.#setCameraFaceFilterStatus("initializing");
      }
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
      // A simulcast share has multiple encodings, and which index is the
      // full-res layer is a livekit-client convention (low-first), not a
      // WebRTC guarantee — and the rid letters actively lie (`h` is the
      // FULL-res layer). Key off scaleResolutionDownBy: the smallest scale
      // is the layer the tier's numbers were chosen for. Writing them onto
      // encodings[0] put the picker's bitrate/framerate on the half-res rung
      // while full res kept the 15fps default — the "1080p 60FPS never
      // delivers 1080p60" inversion.
      //
      // `active` is deliberately never touched, even for a single-encoding
      // tier (Game) picked mid-share: dynacast owns layer activation, and a
      // unilateral setParameters write desyncs livekit's bookkeeping (the
      // SFU still believes the layer exists and re-enables it with stale
      // caps on a SubscribedQualityUpdate) — and Firefox rejects
      // `active: false` outright, which would atomically discard the
      // full-res write in the same setParameters call. With one viewer on
      // the full-res layer dynacast pauses the unwatched rung anyway, which
      // is the same encode outcome Game's single-encoding publish buys; the
      // rung still carries tier-scaled caps below so any reactivation is
      // honest.
      const scaleOf = (e: RTCRtpEncodingParameters) =>
        e.scaleResolutionDownBy ?? 1;
      const scales = params.encodings.map(scaleOf);
      const fullScale = Math.min(...scales);
      if (params.encodings.length > 1 && scales.every((s) => s === fullScale)) {
        // Defensive: a browser that omits scaleResolutionDownBy from
        // getParameters() makes the rungs indistinguishable, and treating
        // them all as full-res would hand every layer the full tier budget.
        // Fall back to livekit's low-first ordering convention: write the
        // tier onto the LAST encoding only and leave the rest untouched.
        const full = params.encodings[params.encodings.length - 1];
        full.maxBitrate = quality.maxBitrateKbps * 1000;
        if (quality.resolution.frameRate) {
          full.maxFramerate = quality.resolution.frameRate;
        }
      } else {
        for (const encoding of params.encodings) {
          const relativeScale = scaleOf(encoding) / fullScale;
          if (relativeScale === 1) {
            encoding.maxBitrate = quality.maxBitrateKbps * 1000;
          } else {
            // Downscaled rung: livekit's own screenshare ladder — the
            // tier's framerate at bitrate ÷ scale², floored at 150 kbps.
            encoding.maxBitrate = Math.max(
              150_000,
              Math.floor((quality.maxBitrateKbps * 1000) / relativeScale ** 2),
            );
          }
          if (quality.resolution.frameRate) {
            encoding.maxFramerate = quality.resolution.frameRate;
          }
        }
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
        degradationPreference: "maintain-framerate",
        maxBitrateKbps: 3000,
      },
    };

    // Built inside the >=1080p gate below (it needs the same server limit)
    // but assigned AFTER the resolution tiers, so it lists last: it is the
    // odd one out, a static-content option rather than a rung on the ladder.
    let sourceQuality: ScreenShareQuality | undefined;

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
            contentHint: "detail",
            degradationPreference: "maintain-resolution",
            maxBitrateKbps: 5000,
          };
          // Clone before mutating — ScreenSharePresets.original is a shared
          // livekit-client singleton; writing to it in place corrupts it
          // process-wide for any other consumer.
          const originalResolution = {
            ...ScreenSharePresets.original.resolution,
          };
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
          sourceQuality = {
            name: "text",
            resolution: originalResolution,
            fullName: `Source 5FPS`,
            contentHint: "text",
            degradationPreference: "maintain-resolution",
            maxBitrateKbps: 3000,
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
      degradationPreference: "maintain-framerate",
      maxBitrateKbps: 8000,
    };
    // What `fhd` promises, actually delivered: `fhd` splits its budget across
    // a simulcast ladder, so a viewer gets full res OR full framerate. One
    // encoding puts the whole 8 Mbps at 1080p60 — right when one person is
    // watching you play (couch co-op); wrong for a big audience, which loses
    // the quality-adaptation rung, hence a separate tier and not a change to
    // `fhd`.
    //
    // The encoding COUNT is fixed at publish time from the STORED quality
    // (setParameters can't add or remove negotiated encodings), so
    // `simulcast: false` only takes effect when Game is the stored tier at
    // share start. Picked mid-share (either dialog), Game rides the ladder
    // re-apply instead: full-res gets the whole tier budget and dynacast
    // pauses the unwatched rung — the same encode outcome with one viewer.
    // The mirror also holds: with Game stored, a simulcast tier picked
    // mid-share keeps the single encoding for that share.
    qualities.game = {
      name: "game",
      resolution: this.#clampResolutionToServerLimit({
        width: 1920,
        height: 1080,
        frameRate: 60,
      }),
      // No parens: ScreenShareQualityLabel splits on the LAST space, so
      // "Game 1080p 60FPS" renders "Game 1080p" over "60FPS" like the
      // other tiers; parens would strand one on each line.
      fullName: `Game 1080p 60FPS`,
      contentHint: "motion",
      degradationPreference: "maintain-framerate",
      maxBitrateKbps: 8000,
      simulcast: false,
    };
    qualities.qhd = {
      name: "qhd",
      resolution: this.#clampResolutionToServerLimit({
        width: 2560,
        height: 1440,
        frameRate: 30,
      }),
      fullName: `1440p 30FPS`,
      contentHint: "detail",
      degradationPreference: "maintain-resolution",
      maxBitrateKbps: 8000,
    };
    qualities.uhd = {
      name: "uhd",
      resolution: this.#clampResolutionToServerLimit({
        width: 3840,
        height: 2160,
        frameRate: 30,
      }),
      fullName: `4K 30FPS`,
      contentHint: "detail",
      degradationPreference: "maintain-resolution",
      maxBitrateKbps: 16000,
    };

    // Last in the picker, after the resolution ladder.
    if (sourceQuality) qualities.text = sourceQuality;

    return qualities;
  }

  async toggleScreenshare() {
    const room = this.room();
    if (!room) throw "invalid state";

    if (this.screenshare()) {
      await room.localParticipant.setScreenShareEnabled(false);

      // The track's stop() already tore the processor down; just drop the
      // handle so the next share starts from a clean slate.
      this.#screenShield = undefined;

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
            // MUST be screenShareEncoding: livekit-client silently ignores
            // `videoEncoding` for screenshare tracks (computeVideoEncodings
            // reads options.screenShareEncoding for them), so passing the
            // tier as videoEncoding left every share seeded from the
            // h1080fps15 default — 15 fps / 2.5 Mbps at full res, whatever
            // the picker said. With this set, livekit scales the whole
            // ladder from the tier natively (full res carries the tier; the
            // downscaled rung gets tier ÷ 4 at tier fps).
            screenShareEncoding: {
              maxBitrate: initialQuality.maxBitrateKbps * 1000, // kbps -> bps
              maxFramerate: initialQuality.resolution.frameRate,
            },
            simulcast: initialQuality.simulcast !== false,
            degradationPreference: initialQuality.degradationPreference,
          },
        );

        const screenAudioTrack = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio,
        );

        this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

        if (localTrack) {
          // Tell the encoder what to protect BEFORE anything else. `callback`
          // below sets this too, but it only runs when the picker returned a
          // quality or the ask-dialog is on — a share started from a stored
          // quality would otherwise publish with the browser's default hint,
          // which treats screen content as motion and spends the bitrate on
          // holding framerate instead of keeping text legible.
          if (localTrack.videoTrack) {
            localTrack.videoTrack.mediaStreamTrack.contentHint =
              initialQuality.contentHint;
          }

          // Privacy shield: pixelates the OS-toast corner when something
          // pops in, before frames reach the encoder (and therefore before
          // E2EE/SFU — the shielded frame is the only frame that exists off
          // this machine). Monitor shares only: a window share does not
          // capture other apps' toasts, and its corner is ordinary content
          // that would false-trigger. Attach failure is logged and the share
          // continues RAW — the user chose to share; silently blocking the
          // share would be the worse surprise. The gate's
          // TrackProcessorUpdate handler squares this with pause/resume.
          if (this.#settings.screenShareShield && localTrack.videoTrack) {
            const surface = (
              localTrack.videoTrack.mediaStreamTrack.getSettings() as MediaTrackSettings & {
                displaySurface?: string;
              }
            ).displaySurface;
            if (surface === "monitor" || surface === undefined) {
              try {
                const shield = new ScreenShieldProcessor();
                await (localTrack.videoTrack as LocalVideoTrack).setProcessor(
                  shield,
                );
                this.#screenShield = shield;
              } catch (error) {
                console.error("screen shield attach failed", error);
              }
            }
          }

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
              // Tiers disagree about what to protect, so this has to move with
              // the tier rather than being set once at publish. Best-effort:
              // a failure just leaves the previous preference in place.
              await localTrack.videoTrack
                .setDegradationPreference(quality.degradationPreference)
                .catch(() => undefined);
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
                  // Publish-gate coexistence (R2-8): the quality modal's
                  // per-track resume must never override a held session gate
                  // (negotiating / mixed / enable-window) — a direct resume
                  // here would briefly publish a plaintext screenshare into a
                  // mixed call before the UpstreamResumed backstop re-pauses
                  // it. If the gate is held, skip the resume: the gate owner
                  // resumes EVERY publication when the set empties.
                  if (this.#publishGate.size === 0) {
                    localTrack.resumeUpstream();
                    if (audio) {
                      screenAudioTrack?.resumeUpstream();
                    }
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

  /**
   * Focus a screen share as soon as it appears, so the shared screen takes the
   * whole frame and everyone else drops into the side column.
   *
   * Deliberately narrow, because a focus change moves the viewer's video
   * around underneath them:
   * - each share gets exactly ONE chance (ids remembered until the share
   *   ends), so un-focusing it is respected for as long as it runs;
   * - a viewer already watching another share is never yanked to the new one.
   *
   * The sharer's OWN screen is focused too (operator decision 2026-08-02, taken
   * while watching the default layout in a live call). It does recurse — their
   * card shows their card — but that recursion is already on screen in the
   * unfocused tile, and leaving the share small while two avatar tiles take the
   * frame was the worse trade. One chance per share id still applies, so a
   * sharer who un-focuses their own screen keeps it that way.
   */
  #watchScreenShareFocus() {
    createEffect(() => {
      const shares = this.vidTracks().filter(
        (t) =>
          t.source === Track.Source.ScreenShare &&
          "publication" in t &&
          t.publication,
      );

      const live = new Set(shares.map((t) => this.trackId(t)));
      for (const id of this.#autoFocusedShares)
        if (!live.has(id)) this.#autoFocusedShares.delete(id);

      const fresh = shares.find(
        (t) => !this.#autoFocusedShares.has(this.trackId(t)),
      );
      if (!fresh) return;
      for (const id of live) this.#autoFocusedShares.add(id);

      // Read (and write) the focus untracked: this effect only ever reacts to
      // the track list, never to its own write.
      untrack(() => {
        // Same guard as `toggleFocus` — focusing the only window there is
        // would leave an empty side column.
        if (this.vidTracks().length < 2) return;
        if (this.focusTrack()?.source === Track.Source.ScreenShare) return;
        this.#setFocus(this.trackId(fresh));
      });
    });
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
    if (channel.type === "DirectMessage" || channel.type === "Group")
      return true;
    return !!channel.havePermission("Listen");
  }

  get speakingPermission() {
    const channel = this.channel();
    if (!channel) return false;
    // DMs and group DMs don't have server permissions — always allow speaking
    if (channel.type === "DirectMessage" || channel.type === "Group")
      return true;
    return !!channel.havePermission("Speak");
  }

  /**
   * The §4.4 dual-gated encryption chip state (slice 6.5). Derived from the
   * session mode/state, LiveKit's observed per-participant encryption, the
   * verified MLS roster, the latched error, and the open-group probe — via the
   * pure `chipState` policy (unit-tested). Reactive: reads the participants
   * version so it re-runs when the SFU roster / published tracks change.
   */
  callEncryptionChip(): ChipState {
    this.callParticipantsVersion(); // reactive dependency (FE-8/R2-3)
    const room = this.room();
    const session = this.#mlsSession;
    const mode = this.callMode();
    const publishing: string[] = [];
    if (room) {
      for (const [identity, p] of [
        [room.localParticipant.identity, room.localParticipant] as const,
        ...[...room.remoteParticipants.values()].map(
          (p) => [p.identity, p] as const,
        ),
      ]) {
        // Only participants with ≥1 published track ever report an encryption
        // status (FE-2); trackless listeners are covered by MLS membership.
        if (p.trackPublications.size > 0) publishing.push(identity);
      }
    }
    const observed = new Map<string, boolean>();
    for (const identity of publishing) {
      const v = this.callEncryption.get(identity);
      if (v !== undefined) observed.set(identity, v);
    }
    return chipState({
      hasSession: !!session,
      sessionState: session?.state(),
      mode,
      e2eeEnabled: mode?.kind === "e2ee",
      hasLocalKey: mode?.kind === "e2ee",
      resecuring: session?.state() === "resecuring",
      latchedError: this.callEncryptionError() !== undefined,
      publishingIdentities: publishing,
      observedEncrypted: observed,
      rosterVerified: this.callRoster().members.map((m) => m.user_verified),
      channelHasOpenGroup: this.callChannelHasOpenGroup(),
      capableAndEnabled: this.#settings.e2eeCallsEnabled,
    });
  }

  /**
   * The user confirmed the whole-call plaintext downgrade (§3.4 T3/T5) from the
   * 6.5 banner. Delegates to the session, which shows the BLOCKING native
   * confirm dialog (native-computed non-enrolled roster), then transitions to a
   * confirmed interlude. `displayNames` labels the natively-selected ids only.
   */
  async confirmCallPlaintext(): Promise<void> {
    const session = this.#mlsSession;
    if (!session) return;
    const client = this.getClient();
    const names: Record<string, string> = {};
    for (const identity of this.callNonEnrolled()) {
      const userId = identity.split(":")[0];
      const user = client?.users.get(userId);
      if (user?.username) names[userId] = user.username;
    }
    await session.confirmPlaintext(names);
  }

  /** Toggle the call roster / verification panel (chip click, slice 6.5). */
  toggleCallRosterPanel(): void {
    this.#setCallRosterPanelOpen((open) => !open);
  }

  // --- pass-the-controller rotation queue (slice 1) -------------------
  //
  // Plain mutators over the pure module. Nothing here talks to the server:
  // the queue is the sharer's own running order and grants no authority
  // (see the `controllerQueue` doc-comment).

  /** Put someone in the rotation, at the back. Idempotent. */
  enqueueController(userId: string): void {
    this.#setControllerQueue((queue) => addToQueue(queue, userId));
  }

  /** Take someone out of the rotation. */
  dequeueController(userId: string): void {
    this.#setControllerQueue((queue) => removeFromQueue(queue, userId));
  }

  /**
   * Drop anyone who has left the call.
   *
   * Called from the rotation panel against the same deduped participant list
   * the offer picker builds, rather than from a room event: a queue member
   * who left would otherwise stall the rotation at the 90 s offer TTL, which
   * reads as the app being stuck.
   */
  retainPresentControllers(present: Iterable<string>): void {
    this.#setControllerQueue((queue) => retainPresent(queue, present));
  }

  /** Empty the rotation (the panel's "clear" affordance). */
  clearControllerQueue(): void {
    this.#setControllerQueue(EMPTY_REMOTE_CONTROL_QUEUE);
  }

  // --- pass-the-controller "ask for a turn" (slice 2) ----------------

  /**
   * Announce this client's remote-control capability once per join.
   *
   * Only if the native probe actually reports support — the beacon is a hint
   * for other people's queue UIs, and announcing from a shell that cannot
   * inject would make the queue offer to a peer who then dead-ends at the
   * offer TTL, the exact failure the beacon exists to remove.
   *
   * One retry on failure: we fire this from the room `connected` handler, and
   * the voice-ingress webhook that creates our server-side voice state can
   * land just after, so a first announce can 400 with "not in the call". The
   * `gen` guard drops the retry if the call was left/superseded meanwhile —
   * announcing into a call we already left would be harmless (it 400s) but
   * pointless.
   */
  async #announceRcCapable(channel: Channel, gen: number): Promise<void> {
    if (!(await this.remoteControl.supported())) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (gen !== this.#connectGen) return;
      try {
        await channel.announceRcCapable();
        return;
      } catch (error) {
        if (attempt === 1) {
          console.error("rc capability announce failed", error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /**
   * Ask a streaming participant for a control turn ("raise hand").
   *
   * Fire-and-forget from the asker's tile button. Returns the HTTP status so
   * the caller can distinguish a 429 (asked too often — the button should
   * stay in its "asked" state and not surface an error) from a real failure.
   * Grants nothing: the sharer sees a suggestion and decides.
   */
  async requestControlTurn(sharerId: string): Promise<number | undefined> {
    const channel = this.channel();
    if (!channel) return undefined;
    try {
      return await channel.requestControlTurn(sharerId);
    } catch (error) {
      console.error("control turn request failed", error);
      return undefined;
    }
  }

  /** Clear one pending request — the sharer queued the asker, or dismissed. */
  clearTurnRequest(userId: string): void {
    this.#setPendingTurnRequests((requests) =>
      removeTurnRequest(requests, userId),
    );
  }

  /**
   * Drop requests from anyone who has left the call — mirror of
   * `retainPresentControllers`, called from the panel against the same
   * deduped participant list so a request from a departed asker cannot
   * linger on the sharer's screen.
   */
  retainPresentTurnRequests(present: Iterable<string>): void {
    this.#setPendingTurnRequests((requests) =>
      retainPresentRequests(requests, present),
    );
  }

  /**
   * Set the turn length, or `undefined` to switch the timer off.
   *
   * Switching it off also drops any deadline already armed — otherwise the
   * current turn would still auto-advance once after the streamer turned
   * the timer off, which is the opposite of what they asked for.
   */
  setTurnLength(ms: number | undefined): void {
    this.#setTurnLengthMs(ms);
    if (ms === undefined) this.#setTurnDeadline(undefined);
  }

  /**
   * Start the clock for a turn that just began, if a timer is configured.
   * `now` is a parameter so the caller (and tests) own the clock.
   */
  armTurnDeadline(now: number): void {
    const length = this.turnLengthMs();
    this.#setTurnDeadline(length === undefined ? undefined : now + length);
  }

  /** Stop the clock without touching the configured length. */
  clearTurnDeadline(): void {
    this.#setTurnDeadline(undefined);
  }

  /**
   * ME-10 terminal-loud state (slice 6.5): the call FAILED to secure while
   * still negotiating — or before the session ever emitted a mode verdict,
   * which is where a refusal thrown inside establish() (store-owner mismatch)
   * lands. Publishing is gated and the banner offers the blocking Leave /
   * Stay-unencrypted choice (the "stay" leg runs the same native-confirmed
   * plaintext path as a mixed-call downgrade). Distinct from mixed/interlude,
   * which have their own banner.
   */
  callTerminalLoud(): boolean {
    return isTerminalLoud(
      this.callMode(),
      this.callEncryptionChip(),
      this.callEncryptionError() !== undefined,
    );
  }

  /**
   * Whether enabling video/screenshare is refused by the A3(b) product gate
   * (slice 6.5): while an E2EE call has more than `MAX_VIDEO_PARTICIPANTS`
   * participants, video is off (control-plane cost scales with roster). The
   * >30-after-video-on direction + the join-side refusal need the 6.6 server
   * leg (D12) — this is the client half. Only gates ENCRYPTED calls.
   */
  videoCapReached(): boolean {
    if (this.callMode()?.kind !== "e2ee") return false;
    const room = this.room();
    if (!room) return false;
    return room.remoteParticipants.size + 1 > MAX_VIDEO_PARTICIPANTS;
  }

  #startPushToTalk(room: Room) {
    this.#stopPushToTalk();

    this.#pttKeydown = (e: KeyboardEvent) => {
      if (!this.#settings.pushToTalk) return;
      if (e.code !== this.#settings.pushToTalkKey) return;
      if (e.repeat) return;
      // EL-PTT: the user can only change the setting/keybind while focused,
      // so a focused keydown is the perfect lazy re-arm point for the
      // global hook (covers mid-call enable + keybind changes).
      void this.#ensureNativePtt(room);
      // While whispering the room mic is deliberately suppressed; the talk
      // key must not unmute it into the room behind the aside.
      if (this.whisper.target()) return;
      if (room.localParticipant.isMicrophoneEnabled) return;
      void this.#setMicEnabled(room, true).catch(() => {});
    };

    this.#pttKeyup = (e: KeyboardEvent) => {
      if (!this.#settings.pushToTalk) return;
      if (e.code !== this.#settings.pushToTalkKey) return;
      if (!room.localParticipant.isMicrophoneEnabled) return;
      room.localParticipant.setMicrophoneEnabled(false);
    };

    window.addEventListener("keydown", this.#pttKeydown);
    window.addEventListener("keyup", this.#pttKeyup);

    if (this.#settings.pushToTalk) void this.#ensureNativePtt(room);
  }

  /**
   * EL-PTT (global push-to-talk, P1 + P4): arm the desktop shell's native
   * key hook and subscribe to its `ptt:down`/`ptt:up` events so
   * hold-to-talk works while the app is unfocused (alt-tabbed into a
   * game). The focused window listeners above stay active alongside — the
   * already-enabled/already-disabled guards make the dual sources
   * idempotent. No-ops on the web build and on shells without the
   * `ptt_arm` command (older installs, Linux until its EL-PTT legs land):
   * PTT then stays focused-only, exactly the pre-slice behavior.
   */
  async #ensureNativePtt(room: Room) {
    const tauri = (
      window as {
        __TAURI__?: {
          core?: {
            invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
          };
          event?: {
            listen<T>(
              event: string,
              handler: (event: { payload: T }) => void,
            ): Promise<() => void>;
          };
        };
      }
    ).__TAURI__;
    if (!tauri?.core?.invoke || !tauri.event) return;
    if (this.#pttNativeArming) return;
    const key = this.#settings.pushToTalkKey;
    if (this.#pttNativeKey === key) return;

    this.#pttNativeArming = true;
    try {
      // Re-arming with a new key just retargets the existing hook.
      const armed = await tauri.core.invoke<boolean>("ptt_arm", { key });
      if (!armed) return;

      if (this.#pttNativeUnlisten.length === 0) {
        const down = await tauri.event.listen<void>("ptt:down", () => {
          if (!this.#settings.pushToTalk) {
            // Setting turned off mid-call: drop the global hook entirely
            // (it must not outlive the feature being on — EL-PTT P3/P4).
            void this.#disarmNativePtt();
            return;
          }
          // Suppressed during a whisper, same as the focused handler.
          if (this.whisper.target()) return;
          if (room.localParticipant.isMicrophoneEnabled) return;
          void this.#setMicEnabled(room, true).catch(() => {});
        });
        const up = await tauri.event.listen<void>("ptt:up", () => {
          if (!this.#settings.pushToTalk) return;
          if (!room.localParticipant.isMicrophoneEnabled) return;
          room.localParticipant.setMicrophoneEnabled(false);
        });
        this.#pttNativeUnlisten.push(down, up);
      }
      this.#pttNativeKey = key;
    } catch {
      // Shell without the ptt commands — focused-only fallback.
    } finally {
      this.#pttNativeArming = false;
    }
  }

  async #disarmNativePtt() {
    for (const unlisten of this.#pttNativeUnlisten) unlisten();
    this.#pttNativeUnlisten = [];
    if (this.#pttNativeKey === undefined) return;
    this.#pttNativeKey = undefined;
    const tauri = (
      window as {
        __TAURI__?: { core?: { invoke<T>(cmd: string): Promise<T> } };
      }
    ).__TAURI__;
    await tauri?.core?.invoke("ptt_disarm").catch(() => {});
  }

  #stopPushToTalk() {
    if (this.#pttKeydown)
      window.removeEventListener("keydown", this.#pttKeydown);
    if (this.#pttKeyup) window.removeEventListener("keyup", this.#pttKeyup);
    this.#pttKeydown = undefined;
    this.#pttKeyup = undefined;
    void this.#disarmNativePtt();
  }

  async #startVAD(room: Room) {
    this.#stopVAD();
    if (!this.#settings.vadEnabled) return;
    const gen = ++this.#vadGen;

    try {
      // VAD must listen on the SAME microphone the call publishes:
      // `{ audio: true }` is the OS-default device, and when that differs
      // from the saved mic (dead onboard jack, virtual device) VAD hears
      // silence and force-mutes a perfectly working call mic. Fall back to
      // the default device if the saved one cannot be opened, mirroring the
      // publish path's fallback.
      const preferred = this.#settings.preferredAudioInputDevice;
      const stream = await navigator.mediaDevices
        .getUserMedia({
          audio: preferred ? { deviceId: { exact: preferred } } : true,
          video: false,
        })
        .catch((error) => {
          if (!preferred) throw error;
          return navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false,
          });
        });
      if (gen !== this.#vadGen) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.#vadStream = stream;
      // A dying VAD mic must not force-mute a working call: with the source
      // gone the analyser reads zeros forever, and every manual unmute would
      // be re-muted 600 ms later. Restart on `ended` — the exact pin above
      // then fails over to `audio: true`, landing on the surviving default
      // device; if no mic is left at all, the outer catch stops VAD outright
      // (fail open, no force-muting without a live source).
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (gen === this.#vadGen) void this.#startVAD(room);
      });
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

        if (level > threshold && !this.whisper.target()) {
          // Voice-activity must not open the room mic while whispering — the
          // aside would otherwise be spoken to the whole call.
          clearTimeout(this.#vadSilenceTimer);
          this.#vadSilenceTimer = undefined;
          if (!room.localParticipant.isMicrophoneEnabled) {
            void this.#setMicEnabled(room, true).catch(() => {});
          }
        } else if (
          room.localParticipant.isMicrophoneEnabled &&
          !this.#vadSilenceTimer
        ) {
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
    this.#vadGen++;
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
          <CaptionPublisher />
          <CaptionSpeaker />
        </InRoom>
      </RoomContext.Provider>
    </voiceContext.Provider>
  );
}

export const useVoice = () => useContext(voiceContext);

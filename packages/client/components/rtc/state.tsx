import {
  Accessor,
  batch,
  createContext,
  createEffect,
  createMemo,
  createRenderEffect,
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
  type AudioCaptureOptions,
  type LocalTrack,
  type LocalTrackPublication,
  type TrackPublishOptions,
  type VideoCaptureOptions,
  ConnectionState,
  isE2EESupported,
  isLocalTrack,
  LocalAudioTrack,
  LocalVideoTrack,
  ParticipantEvent,
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
import { type Events, type VoiceMoveRequest, Channel, Message } from "stoat.js";

/** What the mic processor should be doing, read from settings. */
interface MicPipelineWants {
  denoise: boolean;
  gainPercent: number;
  tonePreset: VoiceTonePresetId;
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

import { t } from "@lingui/core/macro";

import {
  type E2EEBridge,
  nativeE2EEAvailable,
  SoundController,
  useClient,
  useClientLifecycle,
  useSound,
} from "@revolt/client";
import { CONFIGURATION, tauriInvoke } from "@revolt/common";
// The dependency-free leaf, by deep specifier on purpose: the `@revolt/keybinds`
// barrel pulls `keybindActions` -> `suppress`, which calls `createSignal` at
// module scope. `globalKeybinds` documents that import direction as the thing to
// avoid, and this file is on the init path of the whole app.
import {
  type GlobalKeybindAction,
  KEYBIND_COMMANDS,
  KEYBIND_MIN_INTERVAL_MS,
  KEYBIND_REQUIREMENT,
} from "@revolt/keybinds/globalKeybinds";
import { ModalControllerExtended, useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import {
  type CameraColorLookId,
  type CameraFaceFilterId,
  CameraBackgroundMode,
  CameraQualityName,
  ScreenShareQualityName,
  Voice as VoiceSettings,
} from "@revolt/state/stores/Voice";
import type { SnackbarController } from "@revolt/ui/components/design/Snackbar";
import { VoiceCallCardContext } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";
// By file, never through the `@revolt/ui` barrel: a pure leaf with no
// imports, and the barrel's import cycles blank the page (module-scope TDZ).
import { liveVideoCount } from "@revolt/ui/components/features/voice/callCard/callTileSelection";
import {
  dropLegPlaceholders,
  isScreenLeg,
  participantUserId,
  stripLeg,
} from "@revolt/ui/components/features/voice/participantIdentity";
import { ReactiveMap } from "@solid-primitives/map";
import {
  type PublishRefusal,
  afkJoinPlan,
  isAfkChannel,
  permissionFallReasons,
  publishToggleRefusal,
  voicePublishPermission,
} from "./afkPolicy";
import {
  type LegStopNotice,
  type RekeyFailureNotice,
  gateStopNotice,
  keyActionAfterConnect,
  nativeStopNotice,
  rekeyFailureNotice,
  staleExitNotice,
  startAttemptCancelled,
  startAttemptStale,
} from "./androidLegStartPolicy";
import {
  type AndroidScreenShareTier,
  type LegE2EEKey,
  ANDROID_SCREEN_SHARE_TIERS,
  AndroidScreenLeg,
  createAndroidScreenLeg,
  nativeScreenShareAvailable,
} from "./androidScreenShare";
import { Attenuation } from "./attenuation";
import { CaptureClaim } from "./captureClaim";
import { entranceSoundFor } from "./entranceSound";
import {
  type IdleWorld,
  IDLE_REFRESH_MS,
  IDLE_TICK_MS,
  idleFailureDisposition,
  idleForSeconds,
  idleStep,
} from "./idlePolicy";
import { dismissIncomingCall, incomingCall } from "./incomingCall";
import {
  type JoinBlockedReason,
  type JoinRefusalLatch,
  type JoinRefusalReason,
  classifyJoinRefusal,
  JOIN_REFUSAL_HOLD_MS,
  joinBlockedReason,
  refusalSuperseded,
} from "./joinRefusalPolicy";
import { decideKeybindDispatch } from "./keybindDispatchPolicy";
import { watchLocalUserId } from "./localUserIdentity";
import { isPermissionDeniedError } from "./mediaAccessPolicy";
import { anyPeerCouldEncrypt } from "./mlsRosterPolicy";
import {
  CONN_NONCE_ATTRIBUTE,
  MOVE_PRECONNECT_BUDGET_MS,
  moveDecision,
} from "./movePolicy";
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
import {
  type WatchPub,
  liveShareIdentities,
  nextWatchPruneAt,
  pruneWatchedWithGrace,
  WATCH_ABSENCE_GRACE_MS,
  watchedAfterStop,
  watchedAfterWatch,
} from "./screenShareWatchPolicy";
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
import { vadGateDecision } from "./vadGatePolicy";
import {
  createNoiseFloorTracker,
  levelFromFrequencyData,
  VAD_AUDIO_CONSTRAINTS,
  VAD_FFT_SIZE,
  VAD_FRAME_MS,
  VAD_TICK_MS,
} from "./vadLevel";
import { VoiceAudioPipeline } from "./voiceAudioPipeline";
import {
  moveAuthDecision,
  moveBypassesRefusalLatch,
  moveTokenUsable,
} from "./voiceMovePolicy";
import { voiceNodeForChannel } from "./voiceNode";
import {
  isRejoinPreempted,
  MAX_REJOIN_ATTEMPTS,
  rejoinDelayMs,
  shouldAutoRejoin,
} from "./voiceRejoinPolicy";
import {
  VOICE_TONE_PRESET_DEFAULT,
  VoiceTonePresetId,
} from "./voiceTonePresets";
import { WatchDuck } from "./watchDuck";
import { WatchTogether } from "./watchTogether";

// By file: a leaf that imports only two zero-import leaves of its own, so it
// adds no cycle to this file's init path. The same check the sidebar uses.
import { isChannelGatedForMember } from "../../src/interface/channels/memberGate";
import {
  fetchWithRatelimitPolicy,
  isRateLimited,
  MLS_REQUEST_DEADLINE_MS,
  RATELIMIT_MAX_RETRIES,
  requestDeadlineSignal,
} from "../client/e2eeRatelimitPolicy";
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
import { chipPublicationsOf, chipStateFrom } from "./chipInputs.ts";
import { CaptionPublisher } from "./components/CaptionPublisher";
import { CaptionSpeaker } from "./components/CaptionSpeaker";
import { InRoom } from "./components/InRoom";
import { RoomAudioManager } from "./components/RoomAudioManager";
import {
  createDecodeWitnessListener,
  DECODE_WITNESS_INITIAL,
  sameWitness,
} from "./decodeWitnessListener.ts";
import { isDiceRollMessage, summariseDiceRoll } from "./diceRoll";
import {
  type CallEncryptionReadiness,
  callEncryptionCapable,
  callEncryptionReadiness,
  encryptionSetupAvailable,
} from "./e2eeDeviceReadiness";
import { faceSettingsActive } from "./faceFilterCatalog";
import { micPipelineAction } from "./micPipelinePolicy";
import { MlsKeyProvider } from "./mlsCallKeys";
import {
  type CallBanner,
  type CallMode,
  type ChipLatch,
  type ChipState,
  type DecodeWitness,
  type LoudLatchOrigin,
  callBanner,
  plaintextReleaseAvailable,
} from "./mlsCallModePolicy";
import {
  type MlsCallSessionDeps,
  type MlsMediaBinding,
  type MlsRosterMember,
  type MlsSessionState,
  type PublishGateReason,
  MlsCallSession,
} from "./mlsCallSession";
import {
  canConfirmNoSessionPlaintext,
  sessionSetupDecision,
} from "./mlsSessionSetupPolicy";
import { pauseVerdictReaders } from "./pauseVerdict";
import {
  applyPublishGate,
  coalescingSweeper,
  publishGateOp,
} from "./publishGate";
import {
  type PauseDisproofVerdict,
  gatedPublicationFromSender,
  gatedPublicationsFrom,
  pauseAtBirth,
  PublishGateEpisode,
  upstreamOf,
} from "./publishGateEpisode";
import { publishKickAction } from "./publishKickPolicy";
import {
  SCREEN_AUDIO_WATCH_MS,
  screenAudioDeviceGone,
} from "./screenAudioLiveness";
import {
  type ScreenAudioTargets,
  captureScreenAudio,
  listScreenAudioApps,
  onScreenAudioEnded,
  resolveScreenAudioTarget,
  screenAudioSupported,
  stopScreenAudio,
} from "./screenAudioNative";
// 🔴 The Windows/WASAPI body, under aliases. It is a SEPARATE module from
// `screenAudioNative.ts` above, which is the Linux/Electron PipeWire body and
// owns the same three names (`screenAudioSupported`, `captureScreenAudio`,
// `ScreenAudioCapture`) for an entirely different mechanism. Aliasing rather
// than re-exporting is deliberate: a single dispatching `screenAudioSupported`
// answering true on Windows would route Windows into the Electron shell path,
// which does not exist there. The platform branch is at ONE call site, below.
import {
  type ScreenAudioFailure as WinScreenAudioFailure,
  beginScreenAudioPublish as beginWinScreenAudioPublish,
  captureScreenAudio as captureWinScreenAudio,
  finishScreenAudioPublish as finishWinScreenAudioPublish,
  primeScreenAudioProbe as primeWinScreenAudioProbe,
  teardownScreenAudio as teardownWinScreenAudio,
  screenAudioActive as winScreenAudioActive,
  screenAudioDiagnostics as winScreenAudioDiagnostics,
  screenAudioEncryptionFailed as winScreenAudioEncryptionFailed,
  screenAudioPickerAudioSuppressed as winScreenAudioPickerSuppressed,
  screenAudioSenderEncrypted as winScreenAudioSenderEncrypted,
  screenAudioSupported as winScreenAudioSupported,
} from "./screenAudioNativeWin";
import { isScreenShareCancel } from "./screenShareCancel";
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
 * S7, hard exit criterion; EL4 flip, mechanism A). TRUE with no Electron
 * shell at all (Windows Tauri / Android Capacitor / web — unchanged), or
 * when the shell's nonce-gated e2ee surface itself advertises the audited
 * capability: `slogaShell.e2ee.mediaE2EE === true`, set only by the Linux
 * shell's preload (platform-gated there, so a future mac build from the
 * shared shell source cannot inherit it — I6). FALSE for any other
 * `slogaShell` (older Linux shells, any unaudited shell) even though
 * insertable streams and the key-push channel both probe TRUE there.
 * Skew fails closed: a new dist over an old shell finds no flag and stays
 * closed, an old dist over a new shell never consults it (I9
 * defense-in-depth beyond the one-artifact rule). The real trust boundary
 * is contextIsolation on Electron (a page cannot mint the preload flag);
 * on web, fabricating the whole surface — flag included — requires
 * page-script execution, which is already total renderer compromise, and
 * the failure direction of a fabricated-but-dead bridge is a broken loud
 * call, never a false "encrypted" claim (chips derive from the
 * media-plane witness, I10).
 */
export function platformMediaE2EESupported(): boolean {
  if (!("slogaShell" in window)) return true;
  const shell = (window as { slogaShell?: { e2ee?: { mediaE2EE?: unknown } } })
    .slogaShell;
  return shell?.e2ee?.mediaE2EE === true;
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
 * Upper bound on the open-group probe. The probe decides nothing about the
 * publish gate any more (the T0d availability escape it used to feed was
 * withdrawn 2026-09-06 — the gate is never released without a DS verdict,
 * whatever the probe says); what it still owns is attribution: the chip's
 * open-group input for the no-session branches, and the RE-SECURING reason
 * the fail-safe logs when the DS has not answered at 5 s. A probe that hangs
 * would leave both reading "pending" for the whole call, so the timeout
 * rejects into the probe's catch and settles "none" — a completed verdict for
 * the chip, and only that.
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
export const DISABLE_WEB_AUDIO_MIX_KEY = "slogaDisableWebAudioMix";

/**
 * How long `canPlaybackAudio === false` must HOLD before the "enable audio"
 * banner shows. A reconnect's re-attach churn emits a transient false while
 * audio keeps audibly flowing (live leg 2026-08-16: a ~10s Wi-Fi drop put the
 * banner on BOTH participants' screens over working audio), and a genuinely
 * suspended AudioContext stays false until a user gesture — so waiting loses
 * nothing on the real case and swallows the blip. 1.5s comfortably outlives
 * the attach churn without feeling laggy to a user who joined truly blocked.
 */
const AUDIO_BLOCKED_HOLD_MS = 1_500;

/**
 * Waits before each retry of a failed "active again" DELETE of the AFK idle
 * claim (`#postAfkIdle`). A lost DELETE leaves a claim standing that says an
 * active user is idle, and the sweep moves on that claim, so this call is the
 * one worth retrying. Bounded, because the claim's 180 s server TTL ends it
 * anyway: three retries inside ~15 s cover a 429 or a network blip without a
 * loop that could outlive the call.
 */
const AFK_IDLE_CLEAR_RETRY_DELAYS_MS = [1_000, 4_000, 10_000];

/**
 * How long one AFK idle request (`#postAfkIdle`, PUT or DELETE) may run before
 * it is aborted — the whole exchange, error-body read included. A request with
 * no bound can hang for as long as the socket does — a phone waking from sleep
 * is the usual case — and a hung PUT would hold `#idlePutInFlight` for good
 * while a hung DELETE would stall its own bounded retries. An aborted PUT is an
 * UNKNOWN outcome, handled as one (see there); an aborted DELETE is simply
 * retried.
 */
const AFK_IDLE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Refusal shown when the Android screen leg cannot start (screen-leg plan
 * §7.2). One string for every such check — the cheap one before the dialogs,
 * its repeat once the tier sheet closes, and the binding one just before
 * `connect()` — because to the user they are the same answer, and a later one
 * must not read as a different, scarier failure.
 */
const SHARE_UNAVAILABLE_NOW =
  "You can't share your screen right now — the call is re-securing or paused. Try again in a moment.";

/**
 * A publish-gate pulse (a re-secure, a pause) ended a leg start that had
 * already claimed the leg: `gate-start`, from `gateStopNotice` when the pulse
 * landed during the attempt. `staleExitNotice` can answer it too, for a
 * reason already held at a stale check — defense in depth, unreachable in
 * production today (see `#exitStaleAndroidLegStart`). Without it the user
 * consents and nothing happens.
 */
const LEG_GATE_START_NOTICE =
  "Your screen share didn't start because the call is re-securing or paused. Try again in a moment.";

/**
 * A publish-gate pulse stopped a LIVE leg (`gate-share`). The stop is one-way
 * (§0.4): the share does not come back by itself when the gate clears.
 */
const LEG_GATE_SHARE_NOTICE =
  "Your screen share stopped because the call is re-securing or paused. Share again in a moment.";

/**
 * The server took the leg's publish permission away while the primary kept
 * its own (`revoked`): native's `stopped{"revoked"}`, or a connect it rejected
 * as `connect_failed: revoked`. A primary-wide loss (the AFK channel, a
 * moderator mute) is left to the primary's own toast — see `nativeStopNotice`.
 */
const LEG_REVOKED_NOTICE =
  "Your screen share ended because you no longer have permission to share video in this channel.";

/**
 * A leg re-key failed and the fail-closed stop that followed took the share
 * down (`rekeyFailureNotice`: `stopped`). Also native's own
 * `stopped{"encryption"}` (`#legStopNoticeMessage`): one copy for both.
 */
const LEG_REKEY_STOPPED_NOTICE =
  "Your screen share stopped because it could no longer be encrypted.";

/**
 * A leg re-key failed and the fail-closed stop that followed did NOT end the
 * share (`rekeyFailureNotice`: `unstoppable`): the native stop was rejected or
 * timed out, and the leg is still live for the same share.
 *
 * "Leave the call", not "Stop sharing": the share button re-enters the same
 * hung native stop. Leaving does not depend on it: the leave fires the leg
 * stop without awaiting it (`#stopAndroidLeg` in the disconnect path), and
 * voice-ingress evicts `{identity}:screen` on the primary's
 * `participant_left` (BE `api.rs:803-825`).
 *
 * "May", not "is": a native re-key that lands after its timeout may have put
 * the leg on the new key after all. Until one does, the frames stay
 * end-to-end encrypted under the previous key, readable only by its holders
 * (the SFU holds no keys), which is why the copy names who could see it
 * rather than saying "unencrypted".
 */
const LEG_REKEY_UNSTOPPABLE_NOTICE =
  "Your screen share couldn't be stopped and may be visible to someone who left the call. Leave the call to end it.";

/**
 * A gate-share stop (`#pauseGate`) that did not end the share: the native
 * stop was rejected or timed out, and the leg is still live for the same
 * share after `LEG_GATE_SHARE_NOTICE` already said it stopped. Key-neutral
 * (the gate stopped it for a pause or a re-secure, not a failed re-key), and
 * "Leave the call" for the reason given on `LEG_REKEY_UNSTOPPABLE_NOTICE`.
 */
const LEG_UNSTOPPABLE_NOTICE =
  "Your screen share couldn't be stopped. Leave the call to end it.";

/**
 * `#androidScreenShareError`'s "no notice": the one value the leg start's
 * catch does not toast. A dedicated marker rather than `undefined`, so only
 * the revoke branch that returns it can silence that catch — anything else
 * the mapper returns, a literal `undefined` rejection included, still reaches
 * `onErr`.
 */
const NO_LEG_NOTICE = Symbol("no-leg-notice");

/**
 * The SDK event a moderator move (or our own move from another device)
 * arrives as. The emitter accepts any string, so a misspelled name would
 * register a listener that never fires; `satisfies` pins it to the SDK's
 * declared events at compile time.
 */
const VOICE_MOVE_REQUESTED = "voiceMoveRequested" satisfies keyof Events;

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

/**
 * `[gate-trace]` census entry, one per local publication, shared by the
 * `localSenderCreated` and `localTrackPublished.entry` records so the two are
 * element-wise comparable (see `Voice.#gateTraceCensus`). Trace only: nothing
 * but those two records constructs or reads one.
 */
type GateTraceCensusEntry = {
  name: string;
  source: string;
  trackSid: string;
  upstreamPaused: boolean | null;
  hasSender: boolean;
  senderHasTrack: boolean;
  transportState: string | null;
  upstream: string;
  op: string;
};

/**
 * The latched call-encryption failure, with what the session knew about it
 * at latch time. `error` is the STRUCTURED value (native error object or
 * LiveKit error), never stringified. `origin` and `mediaKeyed` ride only on
 * a session-emitted `loud`; the two direct writers in this file (identity
 * mismatch, `hold_loud`) latch a bare `{ error }`, and an absent origin is
 * read by the chip as `not_encrypted` — the fail-closed reading.
 */
type CallEncryptionLatch = {
  error: unknown;
  origin?: LoudLatchOrigin;
  mediaKeyed?: boolean;
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

  /**
   * Click-to-watch screen shares (plan decision A): the REMOTE participant
   * identities whose screen share this viewer has chosen to receive. Keyed
   * by the device-qualified LiveKit identity (legs included), never the user
   * id, so another of your own devices' shares needs its own Watch.
   *
   * A watch lasts for the current share only: it is pruned at once when an
   * identity that never left the room stops publishing both ScreenShare and
   * ScreenShareAudio. An identity that leaves the room (reconnect churn)
   * keeps its watch for up to `WATCH_ABSENCE_GRACE_MS` from when it was
   * first seen absent, whether it is still away or back in the room but not
   * yet sharing; it is dropped at that deadline unless its share is live
   * again, and a share that returns after the deadline is a new share
   * (re-run by `#watchPruneTimer`). The set is cleared on connect and on
   * every disconnect, so a re-share needs a new Watch. The local participant
   * and our own device's screen leg can never be in it (`watchShare` accepts
   * only a live remote share).
   *
   * Written only through `watchShare` / `stopWatchingShare` / the prune and
   * the clears, each of which SKIPS a no-op write (the policy helpers always
   * return a new Set), so subscribers never re-run on an unchanged set. No
   * `equals` comparator on purpose: one that wrongly returns true would
   * freeze the accessor on a stale set.
   */
  watchedShares: Accessor<ReadonlySet<string>>;
  #setWatchedShares: Setter<ReadonlySet<string>>;
  /**
   * The watch prune's absence record (`pruneWatchedWithGrace`): when each
   * watched identity was first seen absent from the room, on
   * `performance.now()`. Not a signal: nothing renders it, and only the
   * prune reads it. Cleared with the watch set.
   */
  #watchGoneSince: ReadonlyMap<string, number> = new Map();
  /**
   * The one pending re-prune, at the earliest absence deadline
   * (`nextWatchPruneAt`), so a watch whose identity never comes back is
   * dropped on time even if nothing else in the room changes.
   */
  #watchPruneTimer: ReturnType<typeof setTimeout> | undefined;

  state: Accessor<State>;
  #setState: Setter<State>;

  /**
   * Channel id of a `connect()` that has started and not settled. The join
   * affordances go inert on it so a second press cannot restart the join
   * (joinRefusalPolicy); `disconnect()` clears it, so a hang-up always
   * re-enables joining even after an attempt that hung.
   */
  joinPending: Accessor<string | undefined>;
  #setJoinPending: Setter<string | undefined>;
  #joinPendingSeq = 0;

  /**
   * Terminal `join_call` refusals by channel id (joinRefusalPolicy).
   * Replaced wholesale on change so readers are reactive; a latch leaves on
   * the channel's next update event or on its hold timer.
   */
  #joinRefusals: Accessor<ReadonlyMap<string, JoinRefusalLatch>>;
  #setJoinRefusals: Setter<ReadonlyMap<string, JoinRefusalLatch>>;
  #joinRefusalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Update counter per LATCHED channel (tracked only while a latch exists):
   * `channelUpdate` / `voiceChannelLeave` bump it, which is the pure rule's
   * release condition, and the latch is dropped in the same step.
   */
  #channelVersions = new Map<string, number>();

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
  /**
   * The app's snackbar queue, for notices that must not be a modal. Handed in
   * through `setSnackbar` by `VoiceContext` and `undefined` until then, so
   * every reader needs a fallback.
   */
  #snackbar: SnackbarController | undefined;
  /**
   * Whether a channel is behind an age, password or spoiler check this
   * member has not passed on this device (`isChannelGatedForMember`). A move
   * into such a channel is not followed (`#handleVoiceMove`). Handed in
   * through `setMemberGate` by `VoiceContext`, because the answer lives in
   * layout state this class cannot reach.
   *
   * 🔴 The default answers "gated" for every channel, and that is the point:
   * a `Voice` whose gate was never wired refuses every move with a notice
   * rather than joining a channel it cannot check. Fail closed.
   */
  #memberGate: (channel: Channel) => boolean = () => true;
  /** Dismiss stale dialogs whose subject this class just tore down. */
  #closeModalsOfType: ModalControllerExtended["removeOfType"];
  /** A web screen-share start is in flight (the user is in the OS picker). */
  #screenshareStarting = false;
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
  /** The single mic processor (denoise + voice shaper + gain). Attached
   *  lazily by `#syncMicPipeline`; dropped on disconnect, where the room
   *  stops the track and the SDK destroys the processor with it. */
  #micPipeline: VoiceAudioPipeline | undefined;
  #pttKeydown: ((e: KeyboardEvent) => void) | undefined;
  #pttKeyup: ((e: KeyboardEvent) => void) | undefined;
  /** EL-PTT: key the desktop shell's global hook is armed to (undefined =
   * not armed — web build, unmappable key, or shell without the commands) */
  #pttNativeKey: string | undefined;
  #pttNativeUnlisten: (() => void)[] = [];
  #pttNativeArming = false;
  /**
   * A push-to-talk key is HELD, so the microphone being hot is the hold's
   * doing and not the user's mute preference. Read only by
   * {@link pttActive} / {@link dispatchKeybind}.
   *
   * 🔴 **A latch, and the clears are the feature.** It cannot be derived
   * honestly: "is the talk key down" exists nowhere else in this process —
   * the four PTT edges (`#pttKeydown` / `#pttKeyup` and the native
   * `ptt:down` / `ptt:up` listeners) are the only observations of it, and
   * inferring it from `isMicrophoneEnabled && !#settings.micOn` would also
   * be true for a VAD-opened gate and for a mid-whisper restore. So it
   * latches, and every path that can end a hold must clear it:
   *
   * - `#pttKeyup` and the native `ptt:up` — the two real up edges;
   * - `#disarmNativePtt`, because native `disarm()` clears its own `IS_DOWN`
   *   and emits **no** `ptt:up` ("the frontend force-disables the mic on the
   *   paths that call this" — `ptt.rs`), so waiting for one latches forever;
   * - `#stopPushToTalk`, which is also where the DOM listeners go away;
   * - `disconnect()`, above its no-room guard, so a half-set-up call clears
   *   too;
   * - `window` blur, because a DOM key-up is delivered only to the focused
   *   window — alt-tabbing mid-hold means that up never arrives at all.
   *
   * The native layer treats the same latch as unacceptable for the same
   * reason: `fire_panic` (`ptt.rs`) force-clears `IS_DOWN` "rather than
   * latching the microphone open". A latched flag here is milder but just as
   * invisible — it makes the mute keybind silently dead with no cause the
   * user can see.
   */
  #pttHeld = false;
  /**
   * Keybind actions whose dispatch is awaiting an async call right now.
   *
   * 🔴 None of the voice toggles has an in-flight guard of its own; on the
   * click path the guard comes free from the input device (a finger cannot
   * produce two presses inside one renegotiation). A key gives no such
   * guarantee, so the guard lives here. A press arriving while the action is
   * in flight is DROPPED, never queued — a queued second toggle lands in a
   * state the user can no longer see the reason for.
   */
  #keybindInFlight = new Set<GlobalKeybindAction>();
  /**
   * `performance.now()` of the last ACCEPTED press edge, per action, for the
   * {@link KEYBIND_MIN_INTERVAL_MS} floor. Monotonic clock deliberately: a
   * wall-clock step (NTP, sleep/resume) must not be able to open the window
   * this floor exists to keep shut.
   *
   * Separate from `#keybindInFlight` because the publish-gate sweep OUTLIVES
   * the await — see the constant's own comment for the dropped-sweep failure.
   */
  #keybindLastAccepted = new Map<GlobalKeybindAction, number>();
  /**
   * Router navigation, captured at construction (`VoiceContext` mounts inside
   * the `Router` root, so the hook is in scope there and nowhere else in this
   * class). Only `accept-call` uses it — the overlay's Accept button navigates
   * to the conversation as it joins, and a keybind must do the same thing.
   */
  #navigate: ((path: string) => void) | undefined;
  #vadStream: MediaStream | undefined;
  #vadCtx: AudioContext | undefined;
  #vadTimer: ReturnType<typeof setInterval> | undefined;
  #vadSilenceTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Pending delayed re-check behind the autoplay-gate banner: set while a
   * `canPlaybackAudio === false` edge is waiting out `AUDIO_BLOCKED_HOLD_MS`
   * before it is believed. Cleared by the true edge, by `disconnect()`, and
   * by the re-check itself when it resolves.
   */
  #audioBlockedRecheck: ReturnType<typeof setTimeout> | undefined;
  /**
   * Supersession token for `#startVAD`'s async capture, bumped by `#stopVAD`:
   * a start superseded mid-getUserMedia (device switch, call ended) must stop
   * the stream it acquired rather than leak a live mic capture — a leaked VAD
   * stream keeps the OS mic indicator lit after the call.
   */
  #vadGen = 0;
  /**
   * AFK idle watch (Wave 5b-2): the per-connection state behind the idle
   * beacon (`PUT`/`DELETE /channels/{id}/afk_idle`). The rules are
   * `idlePolicy.ts`'s; these fields are only what they read and what the
   * outcome of each request writes back. Started by `#startIdleWatch` in the
   * room's `connected` listener, reset by `#stopIdleWatch` in `disconnect()`.
   *
   * Every time here is `performance.now()`, never wall-clock: a clock step
   * (NTP, sleep/resume) must not be able to make an active user look idle.
   *
   * 🔴 The beacon is a CLIENT-CLAIMED self-report and grants nothing. The
   * server clamps it to the join and applies the server's own timeout; the
   * most a lying client can do is get itself moved.
   */
  #idleTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Runs one idle tick right now, outside the interval. Set by
   * `#startIdleWatch` for the connection it watches; `undefined` otherwise.
   * See `#noteIdleActivity` for why a tick is ever run early.
   */
  #idleKick: (() => void) | undefined;
  /**
   * Removes every Room listener `#startIdleWatch` added for this connection
   * (`ActiveSpeakersChanged`, `Reconnecting`, `Reconnected`).
   */
  #idleUnlistenRoom: (() => void) | undefined;
  /**
   * The last moment this user was seen doing something. Written by the
   * discrete activity events (the local speaking edge, a PTT down, a keybind,
   * input in the visible window) and carried forward by `idleStep`.
   */
  #idleLastActivityAt = 0;
  /** When the previous tick ran; a long gap is missing evidence, not idle. */
  #idleLastTickAt: number | undefined;
  /** An idle claim this connection made is standing on the server. */
  #idlePosted = false;
  /** When the standing claim was last sent (the refresh cadence). */
  #idleLastPostAt: number | undefined;
  /** A PUT is in flight; the tick sends no second one on top of it. */
  #idlePutInFlight = false;
  /** Consecutive failed PUTs, for `idleFailureDisposition`. */
  #idleFailures = 0;
  /** A failed PUT backed off: no PUT before this moment. */
  #idleNextPutAt: number | undefined;
  /**
   * This connection has stopped posting (P2-6). Reset when the server's AFK
   * channel or timeout changes, since those are what a refusal can depend on.
   * Stops PUTs only: a standing claim is still withdrawn on activity.
   */
  #idleLatched = false;
  /** The AFK configuration the latch and failure count were taken under. */
  #idleConfigKey: string | undefined;
  /**
   * Global attenuation ("duck other apps while someone speaks"). Follows the
   * room's active speakers between connect and teardown; a no-op off desktop.
   */
  #attenuation: Attenuation;
  /**
   * Reactive: attenuation is suspended because this client is publishing
   * system/tab audio (ducking would lower the shared stream itself). The
   * settings UI discloses this next to the strength slider.
   */
  attenuationSuspended: Accessor<boolean>;
  /**
   * Entrance sound lookup (server id → soundboard sound id), read from the
   * synced settings store by VoiceContext. Undefined = feature not wired.
   */
  #entranceSound: ((serverId: string) => string | undefined) | undefined;

  // --- Media E2EE (slice 6.3) ---------------------------------------
  // The native-derived key provider + self-hosted worker are constructed per
  // call whenever the shell can do media E2EE (`isE2EESupported()` + a native
  // layer), so the Room is ALWAYS E2EE-capable and `setE2EEEnabled(true/false)`
  // can toggle mode mid-call without a reconnect (§4.1 amendment A4). They are
  // undefined on unsupported/web shells (treated as non-enrolled).
  #mlsKeyProvider: MlsKeyProvider | undefined;
  #e2eeWorker: Worker | undefined;
  /** Tear down the decode-witness listener + staleness timer (gate d). */
  #decodeWitnessStop: (() => void) | undefined;
  #setCallDecodeWitness!: Setter<DecodeWitness>;
  /**
   * The shared web-audio context handed to livekit via
   * `webAudioMix: { audioContext }`. Owned HERE, not by the SDK — livekit
   * only closes contexts it created itself (boolean-option form), so passing
   * one in makes teardown our job. Owning it is what lets the incoming-voice
   * normalizer (rtc/audioNormalizer.ts) build nodes in the same graph the
   * SDK wires remote audio through; nodes from a different context cannot
   * connect. Undefined when the mix kill-switch is off or no call is up.
   */
  #callAudioContext: AudioContext | undefined;
  /**
   * The MLS control-plane session for this call (slice 6.4). Constructed once
   * the device-qualified identity is proven; drives create-or-join, admission,
   * rotation, roster reconciliation, and the enable gate. Undefined on
   * non-E2EE-capable shells. With `media_e2ee_enabled` off, every `/mls` route
   * returns FeatureDisabled and the session quietly stays plaintext (a normal
   * voice call), so this wiring is inert until 6.5 flips the flag.
   */
  #mlsSession: MlsCallSession | undefined;
  /**
   * Aborts the current connect attempt's resume prefetch (join-latency plan,
   * R2-m2 / R-W2-7). There is no connect-generation signal — `#connectGen` is
   * a counter — so each attempt that starts a prefetch makes its own
   * controller. The abort is what hands a claimed kept group back to the
   * bridge: `disconnect()` fires it before disposing the session, and an
   * attempt that builds no session fires it on its way out, or the claim
   * would hold the kept group's expiry off for the whole call.
   */
  #resumePrefetchAbort: AbortController | undefined;
  /**
   * The bridge the last session was built with. NOT cleared by a plain
   * `disconnect()`: sign-out must reach it to discard every kept local group
   * even when the call had already ended (plan M9 / R-W2-7). The sign-out
   * disconnect (`discardMls`) clears it right after firing that discard, so
   * the signed-out account's bridge is not retained (W2-n2).
   */
  #mlsSessionBridge: E2EEBridge | undefined;
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
   * Ownership token for the auto-rejoin loop (`#autoRejoin`). Bumped by every
   * loop entry AND by any user-driven `disconnect()` (hang-up, or a manual
   * join's leading teardown), so a loop resuming after an await can detect it
   * was cancelled and stop. The loop's OWN attempts also pass through
   * `disconnect()` — `#rejoinConnectInFlight` marks those so they don't
   * cancel the very loop that issued them.
   */
  #rejoinSeq = 0;
  /**
   * TRUE while `#autoRejoin`'s own connect() attempt is running — a fact
   * about the LOOP, read by `disconnect()` so the loop's own leading teardown
   * does not cancel the loop that issued it.
   *
   * 🔴 NOT an answer to "is THIS attempt the rejoin's". `connect()` used to
   * read it that way when deciding whether to retire the involuntary-drop
   * marker, and a join the USER made while the loop already had a connect in
   * flight then kept a marker for a channel it was not dialing. That
   * decision is per attempt now — see `opts.rejoinAttempt` on `connect()`.
   */
  #rejoinConnectInFlight = false;
  /**
   * TRUE across the SYNCHRONOUS prefix of a server-ordered MOVE's
   * `connect()` — which is exactly the leading `disconnect()` that tears the
   * old room down (`UserMoveVoiceChannel`; see `#handleVoiceMove`). A move is
   * ONE event to the user — "a moderator put me in another channel" — not a
   * hang-up followed by a join, so the leave chime that teardown would play
   * must be suppressed: leave-then-enter a second apart reads as the call
   * dying and restarting.
   *
   * 🔴 Scoped to that prefix rather than held until the connect settles, and
   * the narrow scope is the correct one twice over. `connect()` is `async`
   * and runs the refusal latch, the marker clear and `disconnect()` before
   * its first await, so the prefix covers the teardown completely; while a
   * flag held to the end also answered for teardowns that are not this
   * move's — a HANG-UP during the move's connect was silenced, and a second
   * move event re-set the flag so the first attempt's clear ran under the
   * second. A move whose connect FAILS does now play one leave chime, from
   * `#connectAttempt`'s own failure teardown, which is honest: that path
   * ends in no call, with no join chime to pair it with.
   *
   * Deliberately its OWN flag rather than borrowing `#rejoinConnectInFlight`.
   * That one also suppresses the `#rejoinSeq` bump in `disconnect()` (which a
   * move needs — see `#handleVoiceMove`), and `#autoRejoin`'s `finally`
   * clears it unconditionally, so a move landing during a rejoin loop would
   * have its suppression torn off by a loop it has nothing to do with.
   */
  #moveLeadingTeardown = false;
  /**
   * The channel this session was in when the SFU dropped it WITHOUT the user
   * asking, and the wall-clock moment that happened. Together they are the
   * two inputs `moveDecision`'s clause (b) addresses a move by.
   *
   * Why they have to exist even though the backend now publishes the move
   * FIRST. `move_user_to_voice_channel_expecting`
   * (`crates/core/database/src/voice/mod.rs`) emits
   * `EventV1::UserMoveVoiceChannel` and only THEN evicts every connection the
   * SFU lists for the user in `from` via
   * `voice_client.remove_identity_if_present` — verified in-tree, and the
   * comment above that emit says the order is the fix. What the reordering
   * buys is the removal of a GUARANTEED loss, not of the race: that removal
   * is a LiveKit `RemoveParticipant`, which puts a `Leave` straight down our
   * signaling socket in one hop, while the event still has to travel
   * LiveKit→delta, a Redis publish, bonfire and then our socket — at least
   * two hops more. Both legs leave delta at nearly the same instant by
   * different routes, so
   * either can win on jitter or a busy fan-out: the `disconnected` listener
   * can STILL run first, and whenever it does this session is no longer
   * `CONNECTED` to `from` and has nothing but
   * this marker left to prove it was the session being moved. Without it the
   * real target answers `ignore`/`not-in-call` and the member lands in no
   * call at all — silently. Under the old order that outcome was certain;
   * under this one it is a scheduling accident, which is no comfort to the
   * member it happens to.
   *
   * 🔴 SET from the Room's `disconnected` listener and nowhere else, and that
   * is the whole point rather than an accident of convenience: a plain
   * hang-up never reaches that listener, because `disconnect()` strips the
   * listeners before tearing the room down. Arriving there IS the proof that
   * the drop was not asked for. Recording on the `disconnect()` path, or
   * inferring involuntariness from a state sniff, would mark a deliberate
   * leave as involuntary and let a stale move yank the session back into a
   * call the user had just chosen to leave.
   *
   * CLEARED at two places, both of which mean "this session has gone
   * somewhere of its own accord, so what last happened to it is no longer the
   * drop": the top of `connect()` (a join that has STARTED) and the Room's
   * `connected` listener (a join that has FINISHED). See each for why one is
   * not enough. A third, `#handleVoiceMove`'s `moved-elsewhere` arm, retires
   * it once the server has moved ANOTHER connection of this user: the drop is
   * accounted for, and a repeat of the event must not re-trigger the notice.
   */
  #lastInvoluntaryChannelId: string | undefined;
  #lastInvoluntaryLeftAt: number | undefined;
  /**
   * The third field of the involuntary-drop marker: the per-connection nonce
   * (`CONN_NONCE_ATTRIBUTE` on the LiveKit token) of the connection that was
   * dropped, or `undefined` when that connection carried none. Written and
   * cleared at exactly the sites the two fields above are, and never on its
   * own — half a marker is not a marker.
   *
   * 🔴 Recorded off the dropped ATTEMPT's own captured nonce, never off
   * `#connNonce`. LiveKit emits `disconnected` asynchronously, so a
   * superseded room's late drop can land after the next connection is up,
   * and `#connNonce` would by then name the NEWER connection — which would
   * let a move addressed to that newer seat read as addressed to the old drop.
   */
  #lastInvoluntaryConnNonce: string | undefined;
  /**
   * S-a: the connection an auto-rejoin REPLACED. When the loop's own attempt
   * reconnects to the channel the marker names, the `connected` listener
   * copies the marker's nonce and drop time here just before it retires the
   * marker, so a move event that arrives late and names the dead connection
   * (the ghost) can still be recognized as addressed to this seat. Without it
   * that event reads as naming ANOTHER connection and ends this call as
   * `moved-elsewhere`, although no other connection exists.
   *
   * 🔴 Widening only, and only from this session's own history: recorded
   * once, from `#lastInvoluntaryConnNonce`, never from an event. The drop time
   * is the ORIGINAL drop's (same clock as `#lastInvoluntaryLeftAt`), so the
   * existing move windows are measured from when the user actually lost the
   * call. Cleared as every join starts and in the `moved-elsewhere` arm.
   */
  #replacedConnNonce: string | undefined;
  #replacedLeftAt: number | undefined;
  /**
   * The per-connection nonce this session's CURRENT connection was minted
   * with — `CONN_NONCE_ATTRIBUTE` among the LiveKit token attributes, which
   * the SDK exposes on `room.localParticipant.attributes` before `connected`
   * fires — or `undefined` when the token carried none (an SFU that does not
   * propagate token attributes, or a token minted before the backend began
   * issuing them). The server reads the SAME attribute off the SFU when it
   * orders a move and names the moved connection by it (`connNonce` on the
   * event), so the two sides cannot disagree: both see the nonce or neither.
   *
   * Written ONCE per connection, in the `connected` listener beside the
   * `CONNECTED` state write, and cleared as `connect()` starts every join.
   * An SDK full reconnect emits `Reconnected`, not `Connected`, and reuses
   * the same token, so the value holds for the life of the connection.
   */
  #connNonce: string | undefined;
  /**
   * The device id this session's LiveKit identity was qualified with on its
   * most recent join — the `{device_id}` half of `{user_id}:{device_id}` — or
   * `undefined` when it joined bare (not E2EE-capable, the store is owned
   * elsewhere, or the key provider/worker failed to construct; see where
   * `e2eeDeviceId` is resolved in `#connectAttempt`).
   *
   * It is the one input `moveDecision` addresses a move by that another
   * session of the same user cannot forge. Both channel-keyed clauses can be
   * satisfied by two sessions at once: `Channel.joinCall` defaults
   * `forceDisconnect = true`, so a user carrying their own call from desktop
   * to phone makes the DESKTOP record an involuntary drop from A at the
   * moment the phone joins A. A move out of A landing inside
   * `MOVE_VERIFIED_WINDOW_MS` is then answered by the phone under clause (a)
   * AND by the idle desktop under clause (b) — and the move token is minted
   * ONCE, for ONE identity. Both redeem it, the SFU evicts one on duplicate
   * identity, and the evicted one can be the seat the user is actually
   * sitting at; the idle desktop can meanwhile land in the destination and
   * publish its microphone into a call nobody is sitting at. The AFK sweep that
   * drives these moves is a timer, so "within ten seconds of a join" is not a
   * coincidence to be waved away, it is the schedule.
   *
   * The server names the identity it minted the token for (`device_id` on the
   * event, `deviceId` once stoat.js has normalized it), so the addressed
   * session can prove it is the one and the bystanders cannot.
   *
   * 🔴 Sourced from the id we actually PRESENTED at join time, NOT from the
   * E2EE bridge read live when the event arrives. The two disagree exactly
   * where it matters: `#connectAttempt` deliberately withholds the qualified
   * identity on an `owned_elsewhere` verdict or a failed provider/worker, and
   * the bridge can provision a different device id mid-session — while the
   * token is minted for the connection the server picks from the OLD room's
   * SFU participant list (`select_move_connection`; the `voice_identity`
   * mapping is only a preference). A live bridge read would both
   * miss real moves and hand a matching answer to a session whose identity
   * never carried that id.
   *
   * 🔴 On the MOVE path there is no "id we are about to present" to record at
   * join time: the identity is fixed by the PRE-MINTED token, which the
   * server built for the connection it picks from the OLD room's SFU
   * participant list (`select_move_connection`; the `voice_identity` mapping
   * is only a preference), and the bridge's current answer is not it. That
   * path therefore leaves this field standing until `room.connect()` has
   * returned and then re-states it from
   * `room.localParticipant.identity` — the identity the SFU actually issued.
   * Writing the bridge's answer there instead reproduced the very bug the
   * device test exists to stop: a bridge that re-provisions mid-session
   * leaves the session sitting in B as `{user}:D1` while this field claims
   * `D2`, and the NEXT move — minted for the identity the SFU lists in B, so
   * `D1` again — fails the device test, is ignored in silence, and leaves the
   * member in no call at all once the server's eviction has removed them.
   *
   * 🔴 NOT cleared by `disconnect()`, and that is deliberate rather than an
   * omission: clause (b) is consulted precisely AFTER this session has been
   * dropped, so a field cleared on teardown would read `undefined` on every
   * move that needs the marker at all — which `moveDecision` treats as "this
   * session cannot prove it is the one" and ignores, disabling the feature on
   * its main path. The value belongs to the seat, not to the call, so it is
   * simply re-stated by each join, to a device id or to `undefined`, and
   * never goes stale against the identity we last presented.
   */
  #sessionDeviceId: string | undefined;
  /** Resolves the rejoin loop's pending backoff wait early (cancellation). */
  #cancelRejoinWait: (() => void) | undefined;
  /**
   * The LiveKit identity this connection held the last time one of its
   * Rooms connected, for `#handleVoiceMove`: the event's token must name it
   * for `tokenForThisConnection` (`moveTokenUsable`), and whether it is
   * device-qualified is `lastIdentityIsDevice`. With no nonce to compare,
   * those two are how a dropped connection proves a move is its own, so a
   * move meant for another of the user's sessions cannot pull this device
   * into the call. Written at `connected` only by a Room whose generation
   * still owns the call, so a superseded Room cannot overwrite it. Kept
   * across the rejoin loop's attempts, which is when a dropped session needs
   * it: there may be no Room then. Our own identity, never anything from the
   * move event.
   */
  #lastLocalIdentity: string | undefined;
  /**
   * One-shot "you were moved" notice for the UI to show as a snackbar, the
   * `recordingNotice` shape: the Voice instance sits outside
   * `SnackbarProvider`, so it cannot show one itself. `at` keys repeats.
   * Only the destination's display name goes in, never the move event.
   */
  moveNotice: Accessor<{ message: string; at: number } | undefined>;
  #setMoveNotice: Setter<{ message: string; at: number } | undefined>;
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
  /**
   * Staleness token for the Linux native screen-audio capture
   * (screenshare-audio design §6, review F2): the capture path awaits IPC,
   * enumerate, gUM and publish — windows the atomic Windows path does not
   * have. Bumped by every share toggle and by `disconnect()`; an in-flight
   * capture re-checks it after every await and tears itself down when
   * stale, so a dangling ScreenShareAudio publication (with a live OS
   * capture!) can never land in a call whose share is gone.
   */
  #screenAudioGen = 0;
  /** Session token of the LIVE native screen-audio capture (set when its
   * publication lands). Every stop path passes it so the shell can no-op
   * a stale stop instead of tearing down a successor share's session. */
  #screenAudioSessionId: number | undefined;
  /** Generation whose "which app?" chooser has already been raised. The
   * ask-modal's confirm action has no in-flight lock, so a double-click
   * would otherwise stack two choosers on one share, produce two picks,
   * and publish twice — and only ONE ScreenShareAudio publication is
   * reachable by teardown, leaving the other live for the rest of the
   * call. One question per share attempt. */
  #screenAudioChooserGen: number | undefined;
  /** Disarms the live capture's death guard (#armScreenAudioGuard), or
   * undefined when none is armed. */
  #screenAudioGuard: (() => void) | undefined;
  /**
   * WINDOWS ONLY. Latched the moment this call publishes native screen audio
   * through a sender carrying no E2EE transform, and cleared only by the next
   * call (see the disconnect reset).
   *
   * Without it the failure is per-share and self-repeating: the module's state
   * machine returns to IDLE, the next share reaches `#publishWinScreenAudio`
   * again, and the only gate in its way is `room.isE2EEEnabled` — which is set
   * from the worker's own reply and stays true. Each retry re-runs the same
   * sender setup that just failed and produces another silent share and
   * another modal.
   *
   * 🔴 This is an AVAILABILITY refusal, not a disclosure one. Measured (design
   * §7, L15): a sender with no transform emits ZERO RTP under
   * `encodedInsertableStreams`, which livekit sets for every E2EE room. A
   * retry re-opens no plaintext window; what it costs is the user's time and a
   * second identical failure. It is scoped to the whole call because the cause
   * is unattributable from here — there is no signal a retry could be
   * conditioned on, so a new call is the natural scope.
   */
  #screenAudioPlaintext = false;
  /**
   * The native Android screen leg (screen-leg plan §7), when this shell can
   * publish one. Constructed lazily on first share and reused: the plugin
   * listeners are app-lifetime, and `active()` spans exactly one share. Every
   * stop hook in §7.4 funnels through `#stopAndroidLeg`.
   */
  #androidLeg: AndroidScreenLeg | undefined;
  /**
   * Start-attempt token for the leg, bumped by every start AND every stop.
   *
   * The start path is a chain of awaits around two USER-PACED dialogs (tier
   * sheet, OS consent), so seconds pass in which the call can end, be kicked,
   * gate, re-secure or rotate its epoch — and until `connect()` resolves the
   * leg is not `active()`, so every §7.4 stop hook would no-op against it and
   * the share would come up into a world that no longer wants it. Comparing
   * this token after each await is what makes the whole window cancellable.
   */
  #androidLegGeneration = 0;
  /**
   * The generation of the start attempt currently between `prepare()` and its
   * own settlement, or undefined when none is. The companion to the token: it
   * tells `#stopAndroidLeg` that a leg it cannot see yet may still be coming
   * up — consent is granted and the foreground service is running — so native
   * must be torn down even though `active()` is false.
   *
   * Keyed by generation rather than a bare boolean so that a STOP (which
   * bumps the token without starting anything) still lets the owning attempt
   * clear it, while a superseded attempt cannot clear its successor's.
   */
  #androidLegStartingFor: number | undefined;
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
   * Watch together (synced YouTube/Jellyfin playback in the call). Owned
   * here for the same reason as remote control: the player element must
   * outlive the call card (it unmounts on channel navigation) and must
   * NEVER be detached — so the store owns the one player host and
   * `VoiceCallCard.tsx` mounts it in its persistent `<Float>`. Session
   * events are app-lifetime client subscriptions (the annotations shape),
   * scoped to the call we are connected to. Sloga relays control state
   * only; the media is fetched by each viewer from the provider.
   */
  readonly watch = new WatchTogether();
  /**
   * Movie ducking for watch-together (plan §7.3 4d): follows the room's
   * REMOTE active speakers and hands the watch store a volume multiplier.
   */
  #watchDuck = new WatchDuck(
    () => this.watch.duckEnabled(),
    (mult) => this.watch.setDuckMult(mult),
  );
  /**
   * Client-local soundboard playback. Subscribes to the `soundboardSound`
   * client event app-lifetime (in the constructor) and plays a received clip
   * only if we are in the triggering call — never on the LiveKit/MLS path.
   */
  #soundboard: SoundboardPlayback;
  /**
   * First latched call-key/encryption failure for this call, as ONE
   * composite value: the structured error plus the session's `origin` and
   * its send-side `mediaKeyed` snapshot (see `CallEncryptionLatch`). One
   * signal, so the chip can never read an origin that belongs to a different
   * error than the banner is showing.
   */
  callEncryptionLatch: Accessor<CallEncryptionLatch | undefined>;
  #setCallEncryptionLatch: Setter<CallEncryptionLatch | undefined>;
  /**
   * The latched error alone — the STRUCTURED value (native error object or
   * LiveKit error), never stringified, so 6.5 can classify rotation-window
   * `RE-SECURING` vs loud `NOT ENCRYPTED` (invariant 11) and the banner can
   * run `storeOwnerMismatch` on it. Derived from `callEncryptionLatch`; every
   * reader that only needs "is a gate held" keeps this accessor.
   */
  callEncryptionError: Accessor<unknown>;
  /**
   * A media-plane join-race hold is open: the session has DEFERRED its verdict
   * on a decode missing key while the install that would answer it is still
   * expected (`MlsCallSession.#holdJoinRace`), and cannot vouch for one peer's
   * frames until it resolves either way.
   *
   * The §4.4 chip's own `resecuring` input reads the session LIFECYCLE state,
   * so a media-plane re-securing never reached it — an error suppressed on
   * that plane read as a green chip while the worker dropped that peer's
   * frames at an index it had marked invalid (the reverted 2026-09-08
   * join-race attempt). A hold gets its own reactive signal so the chip goes
   * AMBER for exactly as long as the verdict is open.
   */
  callMediaHold: Accessor<boolean>;
  /**
   * Gate (d): the E2EE worker's decode witness for the current window — which
   * senders' frames are arriving and being DROPPED at an index this device
   * silenced. `available: false` while no heartbeat is arriving, which the chip
   * reads as amber.
   */
  callDecodeWitness: Accessor<DecodeWitness>;
  #setCallMediaHold: Setter<boolean>;
  /**
   * The ONLY writer of the one signal behind {@link callPauseDisproved} and
   * {@link callPauseDisproofConfirmed}. The signal itself is a constructor
   * local (`pauseVerdict`); both public readers are memos over it and neither
   * has a setter of its own, so no code anywhere in this class can write one
   * of them without the other.
   *
   * 🔴 That is a defect class, not tidiness. The alarm and its confidence
   * used to be two `Setter<boolean>`s written from one positionally-typed dep
   * call. Transposing them typechecked, linted, formatted and passed the whole
   * suite — and this file cannot be imported under `node --test` and carries
   * no mutation entries, so nothing in the repo would have caught it. A
   * transposed pair makes a budget-exhausted verdict on a genuinely live wire
   * present as a CONFIRMED disproof: chip green, media on the wire. One field
   * per verdict, written whole, leaves nothing to transpose.
   *
   * Tearing was never the hazard — Solid's `writeSignal` assigns `node.value`
   * synchronously and `batch` only defers the observer flush, so two adjacent
   * setter calls were never observably half-applied. The hazard was the two
   * values disagreeing about WHICH verdict they describe, which one object
   * makes unrepresentable.
   */
  #setPauseVerdict: Setter<PauseDisproofVerdict>;
  /**
   * The publish gate is held and a sweep found local media still on the wire.
   * Read by `callBanner()`, which turns a CONFIRMED disproof into the banner's
   * "disproved" pause clause; no arm asserts a pause as fact any more (the
   * sentence the 2026-09-08 legs disproved is gone, `held` copy hedges).
   *
   * 🔴 A ONE-DIRECTIONAL ALARM. TRUE is "a held gate could not prove the wire
   * quiet". FALSE is "no live disproof" and NOTHING MORE: it is also what
   * every episode start, every 1→0 transition and every empty gate leave
   * behind. It never means "proven paused".
   *
   * It does NOT raise the banner on its own: that needs a chip precedence and
   * an affordance this signal has no opinion about (the honest-visibility
   * slice). It withdraws a claim the banner is already making.
   *
   * 🔴 Its CONFIDENCE is {@link callPauseDisproofConfirmed}, and this signal
   * alone is not enough to act on. An earlier version of this comment said "a
   * CONFIRMED sweep found local media still on the wire"; that was only ever
   * true of one of the two paths that write TRUE here (W2-3).
   *
   * DERIVED off the one `pauseVerdict` signal — written only through
   * `#setPauseVerdict` — and not a signal of its own: there is no setter here,
   * and so no way to write this apart from its confidence.
   */
  callPauseDisproved: Accessor<boolean>;
  /**
   * How much evidence {@link callPauseDisproved}'s current TRUE rests on
   * (W2-3). Read off the SAME signal as it, so there is no pair to tear and
   * none to transpose.
   *
   *  - TRUE — the disproof was reached after a confirming re-sweep ACTUALLY
   *    RAN: a second look at the same wire, a macrotask after the first.
   *    `PublishGateEpisode` schedules that re-sweep precisely because a
   *    livekit op in flight legitimately leaves the wire live for a few
   *    microtasks, so one observation is not a verdict.
   *  - FALSE — EITHER there is no live disproof at all, OR the episode's
   *    consecutive-confirm budget was exhausted and a SINGLE unconfirmed
   *    observation was promoted to the verdict.
   *
   * 🔴 READ IT ONLY WHERE {@link callPauseDisproved} IS TRUE, and never as a
   * statement about the pause. FALSE here is NOT "the pause is confirmed" and
   * NOT "the wire is confirmed quiet" — this grades a DISPROOF and has nothing
   * to say when there is none. The name keeps `Disproof` in it for exactly
   * that reason: `!callPauseDisproofConfirmed()` reads "the disproof is not
   * confirmed", which is what it means, rather than "the pause is confirmed",
   * which it never means.
   *
   * 🔴 It does NOT decide the chip. WHICH confidence may redden or downgrade,
   * and at what precedence, is wave 2's rule and is audited on its own terms.
   * All this seam owes wave 2 is that the distinction exists and travels with
   * the value, instead of dying in a `console.error` `detail` field where the
   * two verdicts are indistinguishable to any consumer.
   *
   * DERIVED off the same `pauseVerdict` signal as {@link callPauseDisproved}
   * — not a signal of its own — so the two can never come to describe
   * different verdicts.
   */
  callPauseDisproofConfirmed: Accessor<boolean>;
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
   * The MLS session's lifecycle state, REACTIVELY (rejoin plan §4.5): driven
   * by the session's `onStateChange` so `callEncryptionChip` re-runs when the
   * session re-secures/fails — a `session.state()` read alone re-renders
   * nothing, which is how an amber "Re-securing…" chip could sit stale.
   * Undefined when no session exists.
   */
  callSessionState: Accessor<MlsSessionState | undefined>;
  #setCallSessionState: Setter<MlsSessionState | undefined>;
  /**
   * Whether THIS call is E2EE-capable — the connect-time `e2eeCapable` snapshot
   * (isE2EESupported + native layer + key-push + "Encrypt my calls"). The
   * caption fail-closed gate reads it: on a capable call captions broadcast
   * ONLY when the mode is POSITIVELY plaintext ("off"); a non-capable call is
   * always plaintext, so an undefined mode there is safe.
   */
  callE2EECapable: Accessor<boolean>;
  #setCallE2EECapable: Setter<boolean>;
  /**
   * WHY this call is or is not encrypting on this device — the reason behind
   * the boolean above (`e2eeDeviceReadiness`). A connect-time snapshot, like
   * `callE2EECapable`: the chrome describes the call it joined, and the bridge
   * facts it reads move only on a reconnect. The banner reads it to tell "set
   * encryption up on this device" from "this shell can never encrypt".
   */
  callEncryptionReadiness: Accessor<CallEncryptionReadiness>;
  #setCallEncryptionReadiness: Setter<CallEncryptionReadiness>;
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
  /**
   * Chip-only bump: a remote publication's subscription status changed (a
   * Stop watching turns `isDesired` false, a subscription lands), which the
   * share-only contradiction reads and nothing bumps the participants
   * version for. Kept apart from `callParticipantsVersion` so its other
   * readers do not re-run on every subscription edge.
   */
  #chipPublicationsVersion: Accessor<number>;
  #setChipPublicationsVersion: Setter<number>;
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
   * it cannot call `useSnackbar()` itself. (`setSnackbar` now hands it the
   * controller directly; this notice keeps its own consumer.)
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
   * modal keeps its own PER-TRACK pause, named apart from this set in
   * `#consentHeld`: its consent callback resumes directly only over an EMPTY
   * set and otherwise defers to the gate's own 1->0 sweep, and that sweep
   * never resumes a track still consent-held (the `resume` arm in
   * `publishGate.ts` skips a `consentHeld` publication). Every
   * LocalTrackPublished + UpstreamResumed/TrackProcessorUpdate re-asserts
   * the gate so a late publication or livekit's unconditional resumes can
   * never bypass it.
   */
  #publishGate = new Set<PublishGateReason>();
  /**
   * Serializes gate sweeps and collapses the re-entrant triggers a sweep's own
   * livekit ops produce (`coalescingSweeper` explains why nesting there is a
   * live-lock). Rebuilt per connect, so an episode's state never crosses calls.
   */
  #gateSweeper: { sweep(): Promise<void>; passes(): number } | undefined;
  /**
   * The Room `#gateSweeper` was built for. Its ONE consumer is
   * `scheduleConfirm`, which has to capture a Room when a confirm is ARMED
   * rather than read one when it fires.
   *
   * 🔴 NOT the stale-writer guard, and it cannot be one: it is a mutable
   * field, so a sweep for call N parked on an awaited `pauseUpstream()`
   * resumes after the user hung up and joined call N+1 — by which point this
   * field names call N+1's Room and `this.room() === this.#gateRoom` answers
   * TRUE for a sweep that belongs to a disposed call. The guard is `#gateGen`
   * plus the `room` each sweeper captures in its own closure; see
   * `#applyPublishGate`.
   */
  #gateRoom: Room | undefined;
  /**
   * Monotonic sweeper-ownership token — the `#connectGen` idiom (see there)
   * applied to the gate. Bumped when a sweeper is BUILT, and again at both
   * sites that drop one (connect and disconnect), so the `gen` a sweeper
   * captured can only equal this while that sweeper is the live one.
   *
   * The token and the captured Room are checked together: the token alone
   * would not survive a call that never builds a sweeper, and the Room alone
   * would not survive livekit handing out the same object twice.
   */
  #gateGen = 0;
  /**
   * The LIVE sweeper's own `stillCurrent`, for the one consumer that has no
   * sweep to ask with. `EpisodeDeps.stillCurrent` is called from the deferred
   * confirm as well as from `consume`, and the episode is per-Voice — it
   * outlives every sweeper, so it cannot capture one. This field answers the
   * weaker question it can answer: "is there a live gate sweeper for the
   * current call at all". Every call site that HAS a sweep passes that sweep's
   * own captured closure instead.
   */
  #gateStillCurrent: (() => boolean) | undefined;
  /**
   * "Publishing must not leave this device." ONE closure, handed both to
   * `applyPublishGate` as its thunk and to the episode as
   * `EpisodeDeps.gateHeld` — the 6.5 breakdown's wave-1 replacement for the
   * inline `() => this.#publishGate.size > 0`, so the sweep and the episode
   * can never disagree about whether the gate is held.
   */
  #gateHeld = (): boolean => this.#publishGate.size > 0;
  /**
   * The tracks the `LocalSenderCreated` hook RAN THE GATE OP over
   * (`pauseAtBirth` returned a sweep: the gate was held at the emit).
   * Tagged whenever the hook ran the op, NOT only when a pause was actually
   * issued: `publishGateOp` answers `none` over a sender whose transport is
   * already closed (the publication reads `unpublished`), and that track is
   * tagged all the same. Harmless -- the `resumeLanded` arm's op re-reads
   * the wire at the landing and is a no-op over a live sender.
   * Consumed -- deleted -- at that track's next `LocalTrackPublished`
   * whatever the gate state is by then, so the tag can never outlive one
   * publish; a republish creates a new sender, re-runs the hook and re-tags.
   * The `LocalTrackPublished` handler reads it to tell the one born-paused
   * publication an emptied gate still owes a resume apart from every other
   * `{flag: true, quiet}` publication in the map -- the screen-share
   * consent-pending pause -- which an empty-gate map sweep used to wrongly
   * resume (final audit F1). Since wave 4 that pause is ALSO named by
   * `#consentHeld`, and the `resumeLanded` arm passes the hold as the born
   * adapter's flag: a share whose republish straddled the 1->0 edge is
   * re-tagged here but not resumed while its consent is pending. A WeakSet
   * so a track dropped by livekit is never held here.
   */
  #bornPaused = new WeakSet<object>();
  /**
   * The tracks whose upstream is paused for VIEWER CONSENT -- the screen
   * share (and its audio) while the quality ask-modal is open -- keyed by
   * the `LocalTrack` object, never the publication or its sid.
   *
   * Why the track: the E2EE-flip republish every escape press causes
   * (`setE2EEEnabled` -> `republishAllTracks`) lands the SAME `LocalTrack`
   * under a NEW `trackSid` and a NEW publication (`unpublishTrack` runs
   * `publication.setTrack(undefined)`; `republishAllTracks` builds a fresh
   * publication over the same track), so a name-keyed ledger would be
   * looking for a name the republish retired while the pause it named is
   * still in force, and a resume issued over the captured PUBLICATION is
   * `this.track?.resumeUpstream()` over `undefined` -- a masked no-op. The
   * track survives the republish; the pause and the hold ride with it, and
   * every pause/resume on the consent path is issued over the track.
   *
   * Read at the two empty-gate resume paths: `#sweepPublishGate` hands
   * `(t) => this.#consentHeld.has(t)` to `gatedPublicationsFrom`, so the
   * 1->0 sweep's `resume` arm skips a held track, and the `resumeLanded`
   * kick passes the same read as the born adapter's flag. Written only on
   * the screen-share start path: added as soon as `consentPending` is
   * decided (before the first await that could let a 1->0 edge land),
   * re-added at each consent pause. Released: the share FIRST in the
   * consent callback, the audio only when audio was GRANTED (declined,
   * it stays held until the untick unpublish drops the object);
   * `onCancel` deletes both only AFTER its unpublish RESOLVES and keeps
   * them on a rejection -- livekit awaits a pending republish before it
   * unpublishes, so a rejecting republish leaves the share published and
   * paused, and a `finally` release would hand it to the next 1->0 sweep
   * unconsented. The born-paused mic is never added, so the wave-1 F1
   * strand stays resumed at 1->0. A WeakSet for the same reason as
   * `#bornPaused`.
   */
  #consentHeld = new WeakSet<object>();
  /**
   * Every flag a held-gate episode carries — the permanent spend set, the
   * DRIVE-scoped pending set, the confirm dedupe, the confirming-pass phase
   * and the dropped pass — and every rule over them.
   *
   * They live in `publishGateEpisode.ts` rather than here because this file
   * cannot be imported under `node --test`, so a rule left in it is a rule no
   * spec and no mutation can reach. `wiring-upstream-always-quiet` CARRIED an
   * `expect="green"` admission for exactly that reason, while the adapter it
   * mutates still lived in this file; wave 1's extraction is what let it
   * become an ordinary red-expecting entry against `publishGateEpisode.ts`,
   * and two reviewed defects had lived inside the region it used to declare
   * uncovered (D6).
   */
  #gateEpisode = new PublishGateEpisode({
    gateHeld: this.#gateHeld,
    /**
     * The stale-writer guard, in the only form the EPISODE can ask for it:
     * "is there a live gate sweeper for the current call at all". It is what
     * the deferred confirm needs, and it is a correct SECOND layer under
     * `consume` — but it is not, and cannot be, the guard that stops a
     * disposed call's sweep, because this object outlives every sweeper and
     * has no way to know which sweep is asking.
     *
     * 🔴 That is why `#sweepPublishGate` re-checks the CALLING sweep's own
     * captured predicate before `consume`, and why `beginPass`/`noteDropped`
     * are guarded at their call sites. A previous comment here claimed this
     * was "the same `this.room() === room` predicate the sweep used to apply
     * inline"; it was not — it read the mutable `#gateRoom`, which by the time
     * a stale sweep resumes already names the CURRENT call, so the predicate
     * returned TRUE exactly in the case it exists to refuse.
     */
    stillCurrent: () => this.#gateStillCurrent?.() ?? false,
    /**
     * ONE bounded re-sweep, on a macrotask so every queued `replaceTrack` task
     * has run. A livekit op in flight legitimately leaves the wire live for a
     * few microtasks, so a single observation is not a verdict.
     *
     * A BARE deferral, deliberately: the dedupe, the flag clear, the
     * `stillCurrent() && gateHeld()` precondition and the confirming-pass flag
     * are all inside `run`, where a spec can drive them.
     *
     * 🔴 The sweep KICK cannot move with them — `EpisodeDeps` has no seam
     * that starts a sweep — so this file re-applies `gateHeld()` to decide
     * whether to issue one. It is the same predicate `run` just applied, so
     * the behaviour is what it was, but it IS a duplicated rule and the only
     * gate rule still living in an unloadable file. A 6th dep would remove it.
     *
     * The Room is captured HERE, not read when the timer fires, exactly as the
     * `#scheduleGateConfirm` this replaces did: a confirm armed for a call
     * that has since been torn down must die on `#applyPublishGate`'s room
     * guard, not kick a sweep on whatever Room `#gateRoom` names by then.
     */
    scheduleConfirm: (run) => {
      const room = this.#gateRoom;
      setTimeout(() => {
        run();
        // `#applyPublishGate` re-checks room identity itself.
        if (room && this.#gateHeld()) void this.#applyPublishGate(room);
      }, 0);
    },
    /**
     * The PRODUCER side of `callPauseDisproved` and of its confidence sibling
     * `callPauseDisproofConfirmed`. The signal stays here — the banner reads
     * it; the chip does NOT, by pinned design, because a disproof is a
     * withdrawal-only signal and never a chip input — and both accessors keep
     * their names and their shapes; only who writes them moved.
     *
     * 🔴 ONE object into ONE signal, and that is the whole point. The alarm
     * and its confidence are not two things that have to be kept in step;
     * they are one verdict, and `PauseDisproofVerdict` carries them across the
     * module boundary as one. A previous version took them as two positional
     * `boolean`s and fanned them out to two setters: transposing the pair
     * typechecked, linted, formatted and passed every spec, and this file
     * cannot be imported under `node --test`, so no gate in the repo could
     * have caught it. A transposed pair presents a budget-exhausted guess as a
     * CONFIRMED disproof — the silent downgrade this slice exists to kill,
     * sitting at the one seam with no coverage.
     *
     * Fanning the object out to two signals HERE would move that seam one
     * layer down rather than close it, so there is exactly one signal behind
     * both readers and no pair to write apart.
     *
     * That also retires the `batch()` this replaces, whose justification named
     * a residual that does not exist: Solid's `writeSignal` assigns
     * `node.value` synchronously and `batch` only defers the observer FLUSH,
     * and no user code ran between the two setter calls, so the pair was never
     * observably torn. What `batch` never guarded was the swap.
     */
    setPauseDisproved: (verdict) => this.#setPauseVerdict(verdict),
    /**
     * The two console reports, and the only part of the verdict this file
     * still owns.
     */
    report: (kind, detail) => {
      // A resume that threw, or left the sender detached, is the OPPOSITE
      // failure — a call that should be publishing and may be stuck muted
      // upstream, which only a device switch recovers. Nothing fixes it
      // automatically, so at least make it findable.
      if (kind === "failed") {
        console.error("[mls] publish gate could not resume publishing", detail);
        return;
      }
      // The gate is held and the wire is still live. Publishing is escaping a
      // gate every layer above believes is closed.
      //
      // This callback is LOG-ONLY for the DETAIL, and only for the detail.
      // The user-facing side of a disproof no longer needs anything from
      // here — it is not latched through the session, not written to the
      // chip (a disproof is a withdrawal-only signal and never a chip input,
      // by pinned design), and not raised from this callback:
      //
      //  - The verdict itself reached `callPauseDisproved` /
      //    `callPauseDisproofConfirmed` through `setPauseDisproved` above,
      //    BEFORE this runs.
      //  - The banner is derived from that verdict by the pure policy
      //    (`callBanner`, `mlsCallModePolicy.ts`, read via this class's
      //    `callBanner()`), on two axes: `kind` — which surface — and `pause`
      //    — what the second line may say about the gate. `kind` now includes
      //    `securing` for the held-gate stretch of a join (session present,
      //    mode still `undefined` or `negotiating`, chip not red), so plain
      //    `negotiating` — the enable window, a stuck
      //    `#assertLocalDeclarations`, the 409-join stretch — is no longer
      //    bannerless: there is a surface to correct through the held-gate
      //    stretch, not only under `mixed` / `interlude` / terminal-loud.
      //    The one residual is BEFORE `#mlsSession` is assigned (the connect
      //    sweep's `await room.switchActiveDevice` under the R2-5 pre-connect
      //    gate): `hasSession` is `securing`'s discriminator, so a disproof
      //    observed there is still log-only unless a device arm or a latch
      //    has already raised a banner.
      //  - A CONFIRMED disproof (`{ value: true, confirmed: true }`) flips the
      //    `pause` axis to `"disproved"`, and the banner's second line says
      //    the microphone, camera or screen share may still be sending. A
      //    budget-exhausted single observation
      //    (`{ value: true, confirmed: false }`) stays `"held"`, whose copy is
      //    hedged ("should stay paused") rather than a claim of fact, so a
      //    lone live-wire read is never presented as a confirmed leak.
      //  - The way DOWN from `"disproved"` is held for 15 s by the pure
      //    `holdPauseClause` (`pauseClauseHold.ts`, same figure and rationale
      //    as `REUPGRADE_HYSTERESIS_MS`) so a bounce inside a confirm cycle
      //    reads as one warning; the hold drops immediately when the kind or
      //    the pause goes `none`, because that 1→0 resume is real. The banner
      //    component owns that one timer.
      //
      // What stays here is the detail no surface carries: the publication
      // names (`${source}/${trackSid}`) never leave the episode's `consume`,
      // and the reason set on the gate at the moment of the observation is
      // only visible from this file.
      console.error("[mls] publish gate could not prove the wire quiet", {
        ...detail,
        reasons: [...this.#publishGate],
      });
    },
  });
  /**
   * Open-group probe lifecycle for the CURRENT call, read by the session via
   * `channelHasOpenGroup`. It no longer decides anything about the publish
   * gate (the T0d availability escape that released on a completed "none"
   * was withdrawn 2026-09-06 — every value holds); the session's fail-safe
   * reads it only to NAME the hold in its RE-SECURING reason (pending / rate
   * limited / open group known), and the chip's no-session branches read it
   * for open-group attribution. "pending" is kept distinct from "none" so
   * neither reader mistakes a probe that has not answered for a verdict.
   */
  #openGroupProbe: "pending" | "open" | "none" | "ratelimited" = "pending";

  constructor(
    voiceSettings: VoiceSettings,
    modals: ModalControllerExtended,
    sound: SoundController,
    entranceSound?: (serverId: string) => string | undefined,
  ) {
    this.#settings = voiceSettings;
    this.sound = sound;
    this.#entranceSound = entranceSound;
    this.#attenuation = new Attenuation(voiceSettings);
    this.attenuationSuspended = this.#attenuation.suspended;
    // Strength / who-counts changes land on an active duck immediately; the
    // reads are store getters, so this tracks exactly those three keys.
    createEffect(() => {
      void this.#settings.attenuationStrength;
      void this.#settings.attenuateWhenISpeak;
      void this.#settings.attenuateWhenOthersSpeak;
      untrack(() => this.#attenuation.refresh());
    });
    // The duck toggle lands on an active duck immediately, same shape.
    createEffect(() => {
      void this.watch.duckEnabled();
      untrack(() => this.#watchDuck.refresh());
    });

    const [channel, setChannel] = createSignal<Channel>();
    this.channel = channel;
    this.#setChannel = setChannel;

    const [room, setRoom] = createSignal<Room>();
    this.room = room;
    this.#setRoom = setRoom;

    this.vidTracks = () => [];

    const [watchedShares, setWatchedShares] = createSignal<ReadonlySet<string>>(
      new Set<string>(),
    );
    this.watchedShares = watchedShares;
    this.#setWatchedShares = setWatchedShares;

    const [state, setState] = createSignal<State>("READY");
    this.state = state;
    this.#setState = setState;

    const [joinPending, setJoinPending] = createSignal<string>();
    this.joinPending = joinPending;
    this.#setJoinPending = setJoinPending;

    const [joinRefusals, setJoinRefusals] = createSignal<
      ReadonlyMap<string, JoinRefusalLatch>
    >(new Map());
    this.#joinRefusals = joinRefusals;
    this.#setJoinRefusals = setJoinRefusals;

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

    const [callEncryptionLatch, setCallEncryptionLatch] = createSignal<
      CallEncryptionLatch | undefined
    >();
    this.callEncryptionLatch = callEncryptionLatch;
    this.#setCallEncryptionLatch = setCallEncryptionLatch;
    // Derived, never written: the error is one field of the latch, so the two
    // accessors cannot disagree.
    this.callEncryptionError = createMemo(() => callEncryptionLatch()?.error);

    const [callMediaHold, setCallMediaHold] = createSignal(false);
    this.callMediaHold = callMediaHold;
    // Starts UNAVAILABLE, so a call that never arms the witness reads amber
    // rather than green (gate d is fail-closed by construction). The value is
    // imported rather than written here because THIS file has no spec: a
    // reviewer flipped it to an available witness and every spec stayed green.
    const [callDecodeWitness, setCallDecodeWitness] =
      createSignal<DecodeWitness>(DECODE_WITNESS_INITIAL, {
        // The worker posts a NEW object every second, and Solid's default
        // equality is reference identity — so without this the chip, which
        // walks every participant and every publication, re-ran once a second
        // for the life of every call, defeating the `callParticipantsVersion`
        // dependency that exists to stop exactly that. Only a change in what
        // the witness SAYS is a change.
        //
        // 🔴 The comparator itself is in `decodeWitnessListener.ts`, where a
        // spec can load it: Solid SKIPS the write when it returns true, so
        // loosening it freezes the chip green over a peer whose frames are
        // being discarded.
        equals: sameWitness,
      });
    this.callDecodeWitness = callDecodeWitness;
    this.#setCallDecodeWitness = setCallDecodeWitness;
    this.#setCallMediaHold = setCallMediaHold;
    // ONE signal for the whole verdict. Both public readers are derived off
    // it, so the alarm and its confidence are written together or not at all.
    const [pauseVerdict, setPauseVerdict] = createSignal<PauseDisproofVerdict>({
      value: false,
      confirmed: false,
    });
    this.#setPauseVerdict = setPauseVerdict;
    // The DERIVATION lives in `pauseVerdict.ts`, where a spec and a mutation
    // entry can reach it. This file cannot be imported under `node --test`
    // (Solid, livekit, `@revolt/client`) and carries no mutation entries, so
    // for as long as the two reader bodies were written out here, swapping
    // them was checked by nothing: a completion audit transposed them and
    // `tsc`, `prettier`, `eslint`, every spec and both scripts stayed green.
    // In production that swap would have reached the wave-1 `<Show>` as
    // `callPauseDisproved() === false`; today `callBanner()`'s symmetric fold
    // reads `held` either way, and the readers stay named so a
    // `disproved`-only consumer cannot be fed a transposed pair.
    //
    // 🔴 That is NOT now a compile error, and nothing here should say it
    // is. `disproved` and `disproofConfirmed` are two same-typed accessors and
    // transpose exactly as silently as the two positional booleans they
    // replaced. What moving the derivation buys is COVERAGE, not enforcement:
    // the uncovered surface shrinks from the derivation to the two assignment
    // lines below, which are still two same-typed `Accessor<boolean>` writes
    // that would swap without complaint from any check in this repo.
    //
    // The memo wrapping STAYS here, for two reasons. `createMemo`'s `===`
    // equality preserves the notification shape the two original boolean
    // signals had, so a fresh verdict object whose `.value` did not change
    // does not churn the banner's `<Show>`; and `pauseVerdict.ts` has to stay
    // free of Solid to remain loadable under `node --test`. Both memos are
    // created in this constructor, which `VoiceContext` runs inside its own
    // component owner, so they are disposed with it.
    //
    // Names, types and arity are unchanged — `state.tsx`'s `callBanner()`
    // feeds both readers to the policy.
    const readers = pauseVerdictReaders(pauseVerdict);
    this.callPauseDisproved = createMemo(readers.disproved);
    this.callPauseDisproofConfirmed = createMemo(readers.disproofConfirmed);

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

    const [moveNotice, setMoveNotice] = createSignal<{
      message: string;
      at: number;
    }>();
    this.moveNotice = moveNotice;
    this.#setMoveNotice = setMoveNotice;

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

    const [callSessionState, setCallSessionState] = createSignal<
      MlsSessionState | undefined
    >();
    this.callSessionState = callSessionState;
    this.#setCallSessionState = setCallSessionState;

    const [callE2EECapable, setCallE2EECapable] = createSignal(false);
    this.callE2EECapable = callE2EECapable;
    this.#setCallE2EECapable = setCallE2EECapable;

    const [encryptionReadiness, setEncryptionReadiness] =
      createSignal<CallEncryptionReadiness>("unsupported");
    this.callEncryptionReadiness = encryptionReadiness;
    this.#setCallEncryptionReadiness = setEncryptionReadiness;

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

    const [chipPublicationsVersion, setChipPublicationsVersion] =
      createSignal(0);
    this.#chipPublicationsVersion = chipPublicationsVersion;
    this.#setChipPublicationsVersion = setChipPublicationsVersion;

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
    this.#closeModalsOfType = modals.removeOfType;
    this.#mfaFlow = modals.mfaFlow;

    this.getClient = useClient();

    // Same shape as `useClient()` above — a hook read in the constructor,
    // which is legal because it runs synchronously inside `VoiceContext`'s
    // body and `VoiceContext` is mounted inside the `Router` root. Guarded
    // because a Voice built outside a router (a harness) must not fail to
    // construct over a convenience `accept-call` uses and nothing else does.
    try {
      this.#navigate = useNavigate();
    } catch {
      /* no router in scope — accept-call joins without navigating */
    }

    // Rejoin plan §4.6 (hardening ONLY — the crash shape has no unload event,
    // so the §4.1 startup fresh-rejoin carries the real fix): a reload with a
    // live call never ran `disconnect()`, leaving the SFU connection and the
    // native call service to die by timeout while the peer heard silence.
    // Best-effort `room.disconnect()` + `nativeCallServiceStop()`; NO MLS
    // self-remove (the never-self-remove design stays — peers' leave-grace /
    // the DS rejoin affordance clears our leaf).
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        const room = this.room();
        if (!room) return;
        try {
          room.disconnect();
        } catch {
          /* best-effort */
        }
        try {
          nativeCallServiceStop();
        } catch {
          /* best-effort */
        }
      });

      // One of `#pttHeld`'s mandatory clears (see the field): a DOM `keyup`
      // only reaches the FOCUSED window, so alt-tabbing while holding the
      // talk key means `#pttKeyup` never fires and the latch would survive
      // with nothing left to clear it. On the desktop shell the native hook
      // still delivers `ptt:up` and clears it properly; on web and Electron
      // this listener is the only clear there is. Fail-safe direction: the
      // cost of clearing early is that the mute keybind starts working again
      // mid-hold, which is strictly better than a mute key that is dead for
      // the rest of the session. Deliberately does NOT touch the microphone —
      // that would be a behavior change to push-to-talk itself.
      window.addEventListener("blur", () => {
        this.#pttHeld = false;
      });

      // AFK idle watch (D-5b2-7): input in the VISIBLE window is activity.
      // App-lifetime like the blur listener above, and just as cheap — each
      // one only stamps a time, and the stamp is read solely by the idle tick,
      // which runs only while a call is up. Capture phase so a handler that
      // stops propagation cannot hide input; passive, so a touch or wheel is
      // never held up by this. A hidden window receives no real input, so the
      // visibility test is a guard against synthetic events, not a policy.
      const noteInput = () => {
        if (document.visibilityState === "visible") this.#noteIdleActivity();
      };
      for (const type of ["keydown", "pointerdown", "wheel", "touchstart"])
        window.addEventListener(type, noteInput, {
          capture: true,
          passive: true,
        });
    }

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

    // Release a join-refusal latch on the events that can change the
    // server's answer (joinRefusalPolicy): the owner turning calls on or a
    // permission change arrive as `channelUpdate`, a seat freeing up in a
    // full call as `voiceChannelLeave`. App-lifetime, like the soundboard
    // subscription above; re-bound if the client instance changes.
    createEffect(() => {
      const client = this.getClient();
      if (!client) return;
      const onChannelChanged = (channel: Channel) =>
        this.#bumpChannelVersion(channel.id);
      client.addListener("channelUpdate", onChannelChanged);
      client.addListener("voiceChannelLeave", onChannelChanged);
      onCleanup(() => {
        client.removeListener("channelUpdate", onChannelChanged);
        client.removeListener("voiceChannelLeave", onChannelChanged);
      });
    });

    // The server moved this user to another voice channel (a moderator, or
    // the AFK sweep — one event, one handler, one copy). App-lifetime for
    // the same reason as the two subscriptions above: the event can arrive
    // while this session is in NO call at all, so a connect/disconnect-scoped
    // subscription would be deaf exactly when the decision "is this about
    // me?" has to be taken. `#handleVoiceMove` takes that decision.
    //
    // Delivery: the merged backend sends this private event only to the
    // session its voice record names (the one that joined the call). An
    // older, voice-move-only backend broadcast it to every session of the
    // user, so the handler must not assume it is the only session that saw
    // it; the nonce and token checks in `moveDecision` are what hold there.
    //
    // The roster caches are NOT this handler's business: stoat.js keeps them
    // itself off `VoiceChannelMove`, which the server publishes only on the
    // destination channel's topic. This is only the moved session's own leg.
    createEffect(() => {
      const client = this.getClient();
      if (!client) return;
      const handler = (move: VoiceMoveRequest) =>
        void this.#handleVoiceMove(move);
      client.addListener(VOICE_MOVE_REQUESTED, handler);
      onCleanup(() => client.removeListener(VOICE_MOVE_REQUESTED, handler));
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
    // Watch together: same app-lifetime, private-topic shape. Both events
    // reach every session of this user, so drop anything that is not the
    // call we are connected to. A bonfire `ready` (reconnect) fires no
    // VoiceChannelJoin for self, so re-GET the session there too.
    this.watch.setContext({
      channel: () => this.channel(),
      connected: () => this.state() === "CONNECTED",
      localUserId: () => this.getClient()?.user?.id,
    });
    createEffect(() => {
      const client = this.getClient();
      if (!client) return;
      const onWatchUpdate = (detail: {
        channelId: string;
        session: import("stoat.js").WatchSessionData;
      }) => {
        if (this.state() !== "CONNECTED") return;
        if (this.channel()?.id !== detail.channelId) return;
        this.watch.onUpdate(detail);
      };
      const onWatchEnd = (detail: { channelId: string; id: string }) => {
        if (this.channel()?.id !== detail.channelId) return;
        this.watch.onEnd(detail);
      };
      const onReady = () => {
        if (this.state() === "CONNECTED") void this.watch.attach();
      };
      client.addListener("watchSessionUpdate", onWatchUpdate);
      client.addListener("watchSessionEnd", onWatchEnd);
      client.addListener("ready", onReady);
      onCleanup(() => {
        client.removeListener("watchSessionUpdate", onWatchUpdate);
        client.removeListener("watchSessionEnd", onWatchEnd);
        client.removeListener("ready", onReady);
      });
    });
    // Re-point any in-flight soundboard playback when the output device
    // changes mid-call (future plays read the device per-play already).
    createEffect(() => {
      // Read purely to register the reactive dependency; `void` marks that as
      // deliberate rather than a dropped expression.
      void this.#settings.preferredAudioOutputDevice;
      this.#soundboard.refreshOutputDevice();
    });
    // Re-point the VAD capture when the input device changes mid-call: the
    // in-call switcher restarts the PUBLISHED track itself (switchActiveDevice)
    // but the VAD stream is opened by us and would otherwise keep listening on
    // the old device. `#startVAD` no-ops unless voice-activity mode is on.
    createEffect(() => {
      // Dependency-registering read (see above).
      void this.#settings.preferredAudioInputDevice;
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
   *
   * `auth` pre-empts the `joinCall` round trip with credentials the caller
   * already holds — the server-ordered move path, which is handed a token
   * minted for it. `#connectAttempt` drops it unless it names exactly the
   * identity and room this attempt would join (M3), and the attempt then
   * joins the normal way. `opts.movePreConnectBudgetMs` is the move path's
   * wall-clock bound on everything BEFORE `room.connect()`, and M3 lifts it
   * together with a dropped token; both are absent on every user-initiated
   * join, which keeps its existing unbounded behavior.
   *
   * `opts.rejoinAttempt` marks the auto-rejoin loop's OWN attempt — the one
   * join that must NOT retire the involuntary-drop marker (see below). It is
   * passed per attempt on purpose: the field that used to answer this
   * question, `#rejoinConnectInFlight`, is true for as long as the LOOP has a
   * connect in flight, which includes the whole of a join the user makes
   * alongside it.
   *
   * `opts.moveLatchBypass` lets a move token step past a latched refusal for
   * `channel`, only for the reasons `moveBypassesRefusalLatch` allows
   * (a moderator may move someone where they could not join themselves);
   * the latch itself stays.
   */
  async connect(
    channel: Channel,
    auth?: { url: string; token: string },
    opts?: {
      movePreConnectBudgetMs?: number;
      rejoinAttempt?: boolean;
      moveLatchBypass?: boolean;
    },
  ): Promise<boolean> {
    // A terminal refusal the server already gave for this channel and that
    // a retry cannot change (joinRefusalPolicy): answer from the latch —
    // the same dialog, no request, and no `disconnect()`: the 2026-09-06
    // storm's first attempt tore down the call the user was in before the
    // server had said no. Every driver lands here, so a notification
    // "Answer", a profile "Call" or an event "Join" is covered as well as
    // the card and header buttons that also render the latch. An attempt
    // already in flight is NOT coalesced here: a later connect() superseding
    // an earlier one is the designed semantics (the `#connectGen` token),
    // and the affordances disable on `joinPending` so a press cannot
    // reach it anyway.
    const refusal = this.#joinRefusals().get(channel.id);
    const latchedReason =
      refusal && this.joinBlocked(channel) === "refused"
        ? refusal.reason
        : undefined;
    if (
      latchedReason !== undefined &&
      !(
        auth &&
        opts?.moveLatchBypass &&
        moveBypassesRefusalLatch(latchedReason)
      )
    ) {
      this.onErr(new Error(this.#joinRefusalText(channel, latchedReason)));
      return false;
    }
    // 🔴 Retire the involuntary-drop marker as soon as a join STARTS, not only
    // when one finishes. The `connected` listener also clears it, and that
    // clear is not enough on its own: between here and it the state is
    // `CONNECTING`, which is exactly what `moveDecision`'s clause (b) requires
    // (`callState !== "CONNECTED"`), so a session dropped from A whose user has
    // just chosen to join C is still "addressed" by an A-move for the whole
    // length of `room.connect()` — and answering it aborts the user's own
    // deliberate join and sends them somewhere they did not ask to go. Starting
    // a join is itself the proof that the drop is no longer the last thing that
    // happened to this session.
    //
    // NOT for the auto-rejoin loop's own attempt. That attempt is dialing the
    // channel we were just dropped FROM, on nobody's instruction, and losing
    // the marker under it hands the race back to the bug `#handleVoiceMove`
    // cancels the loop for: the move arrives mid-rejoin, clause (a) is false
    // (not `CONNECTED` yet) and clause (b) would now be false too, so the move
    // is dropped in silence and the session rejoins the channel a moderator
    // just moved it out of. The marker still expires on its own clock, so
    // holding it across a rejoin costs nothing beyond
    // `MOVE_VERIFIED_WINDOW_MS`. A move's OWN `connect()` does clear it: its
    // decision has already been taken off that marker and acted on.
    //
    // 🔴 Read off THIS attempt's own option, never off `#rejoinConnectInFlight`.
    // That field says "the rejoin loop has a connect in flight somewhere",
    // which is a different question and answers this one wrongly in the case
    // that matters: dropped from A, the loop waits out its backoff and dials
    // A, and while that is in flight the user clicks C. `connect(C)` reading
    // the flag takes itself for the rejoin, skips the clear, and carries A's
    // marker through C's entire CONNECTING window — where an A-move landing
    // inside it supersedes the join the user just made, which is the exact
    // thing this clear was added to stop. The loop only ever dials the channel
    // the marker names, so the option carries the whole distinction.
    if (!opts?.rejoinAttempt) {
      this.#lastInvoluntaryChannelId = undefined;
      this.#lastInvoluntaryLeftAt = undefined;
      this.#lastInvoluntaryConnNonce = undefined;
    }
    // Unconditional, rejoin attempts included: the connection the nonce named
    // is torn down by the `disconnect()` below whichever join this is, and
    // the new one's is written only once it is `CONNECTED`. Placed below the
    // refusal latch on purpose — that early return leaves the current call
    // up, and stripping its nonce would blind the move gate for a call that
    // is still live.
    this.#connNonce = undefined;
    // S-a: the replaced connection belongs to the join that recorded it, and
    // this join is a different one, so the record goes with it. A rejoin
    // re-records it in its own `connected` listener if it reconnects.
    this.#replacedConnNonce = undefined;
    this.#replacedLeftAt = undefined;
    this.disconnect();
    const pendingToken = ++this.#joinPendingSeq;
    this.#setJoinPending(channel.id);
    try {
      // Past the check above, a latched reason means the move token alone
      // let this attempt through: `#connectAttempt` answers from the latch
      // if M3 then drops that token (F4).
      return await this.#connectAttempt(channel, auth, opts, latchedReason);
    } finally {
      // Only the newest attempt owns the flag: a superseded attempt settling
      // late must not clear what its successor set.
      if (this.#joinPendingSeq === pendingToken) this.#setJoinPending();
    }
  }

  /**
   * The body of `connect()`; the previous call has already been left.
   * `opts` are `connect()`'s own. `bypassedRefusal` is the latched refusal a
   * move token stepped past, if any.
   */
  async #connectAttempt(
    channel: Channel,
    auth?: { url: string; token: string },
    opts?: {
      movePreConnectBudgetMs?: number;
      rejoinAttempt?: boolean;
      moveLatchBypass?: boolean;
    },
    bypassedRefusal?: JoinRefusalReason,
  ): Promise<boolean> {
    // Supersession token: a later connect() runs disconnect() first and bumps
    // this, so a stale invocation resuming after an await can detect it lost
    // and bail (gate HIGH — async-registration race).
    const gen = ++this.#connectGen;

    // 🔴 A server-ordered move is handed a token that is ALREADY TICKING: the
    // backend mints it with a ten-second TTL and the user is out of the old
    // room before the event even leaves the server. A normal join is immune
    // to that clock because it mints its own token BELOW, after every piece
    // of setup has finished — the move path cannot, so the setup above
    // `room.connect()` has to be bounded or the token dies inside it. The
    // worst offender is the MLS keys-changed registration, which races
    // `MLS_REQUEST_DEADLINE_MS` = 45 s: more than four times the token's
    // whole life, so a slow key exchange would eat it outright, every time,
    // and land the user in NEITHER channel.
    //
    // ONE shared wall-clock deadline rather than a budget per await: two
    // independent 3 s budgets sum to 6 s and put the connect handshake past
    // the TTL with nothing over-budget anywhere. Undefined for every
    // user-initiated join, where each `?? unbounded` arm below is the
    // behavior that shipped.
    //
    // `let`, because M3 below lifts it when it drops the token: the attempt
    // then mints its own token after setup like any other join, and the
    // token's clock no longer applies. Keeping the budget there would clamp
    // the MLS key listener to what is left of 3 s for no reason and hold an
    // E2EE call loud on every move whose token M3 dropped.
    let preConnectDeadlineAt =
      opts?.movePreConnectBudgetMs === undefined
        ? undefined
        : Date.now() + opts.movePreConnectBudgetMs;
    /** Milliseconds left of the move budget, or undefined when unbounded. */
    const preConnectBudgetLeft = () =>
      preConnectDeadlineAt === undefined
        ? undefined
        : Math.max(0, preConnectDeadlineAt - Date.now());
    /**
     * TRUE when this attempt is a move, for the chime suppression below.
     * Fixed here, before M3 can lift the budget: a move whose token M3
     * dropped is still a move, and still enters without the chime.
     */
    const isMove = preConnectDeadlineAt !== undefined;

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
        // Device enumeration carries no timeout of its own and can hang
        // behind a stalled OS audio service. On a normal join that is just a
        // slow join; on a move it is the token expiring, so bound it against
        // the shared budget and treat a timeout exactly as the catch below
        // does — "not enumerable", keep the bare string hint, never a
        // stricter constraint than before.
        const enumeration = Room.getLocalDevices("audioinput", false);
        const budgetMs = preConnectBudgetLeft();
        const inputs = await (budgetMs === undefined
          ? enumeration
          : Promise.race([
              enumeration,
              new Promise<MediaDeviceInfo[]>((resolve) =>
                setTimeout(() => resolve([]), budgetMs),
              ),
            ]));
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
    // §3.4 auto-re-upgrade impossible without a full reconnect. Only the SEND
    // path is inert until `setE2EEEnabled(true)` (driven in 6.4/6.5) — the
    // RECEIVE path is armed from construction: livekit installs its decode
    // transform on every subscribed remote track and arms the per-participant
    // cryptor from `trackInfo.encryption !== NONE`, which misreads a missing
    // field as "encrypted" and silently destroys a plaintext publisher's
    // frames (the 2026-08-30 silent-Linux-peer bug). RoomAudioManager's
    // plaintext disarm (rtc/plaintextCryptorPolicy.ts) asserts the correct
    // state per publication. Unsupported shells get no option and are treated
    // as non-enrolled (loud downgrade path), never a silent plaintext Room.
    //
    // Fail-safe (gate HIGH): a worker/provider that cannot construct — e.g.
    // the bundled `?worker` asset blocked by a `worker-src`-less CSP — must
    // NOT break the call. It no longer DEGRADES to a non-E2EE-capable Room,
    // which was a silent-plaintext hole (see the catch below): the call still
    // connects and audio is held rather than lost, and one explicit press
    // releases it.
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
    // The PLATFORM terms — what this SHELL could do, independent of whether
    // this install has any encryption set up. Split from the device terms
    // below so the call chrome can tell "this browser can never encrypt"
    // from "encryption is not set up on this desktop": the same red chip,
    // two different remedies (`e2eeDeviceReadiness`).
    const shellSupported =
      isE2EESupported() &&
      nativeE2EEAvailable() &&
      !!bridge?.nativeKeyPushAvailable() &&
      // Media E2EE arms on Electron only for an audited shell build that
      // advertises the nonce-gated capability flag (EL4 mechanism A);
      // every other slogaShell stays fail-closed even though insertable
      // streams + the key-push channel both probe TRUE there (EL1 audit
      // S7, hard exit criterion).
      platformMediaE2EESupported() &&
      // "Encrypt my calls" (§0.2 #9): with it OFF we negotiate plaintext —
      // no session, no E2EE Room — and appear non-enrolled to E2EE peers
      // (their loud downgrade attributes it to us). LOCAL per-device toggle.
      // 🔴 Folded into the SHELL term, so an install with it off would be told
      // "encrypted calls aren't available on this device" — a lie about the
      // shell. Harmless only because the accessor hard-returns true today
      // (media E2EE is mandatory); whoever makes that toggle real must give it
      // its own readiness reason first.
      this.#settings.e2eeCallsEnabled;
    // The DEVICE terms. E2EE proven OFF here is the same class as the
    // toggle: no identity, no session, not an E2EE call — a plain voice call
    // the peers attribute to us. Only a PROVEN off counts (`e2eeProvenOff`:
    // a LOADED snapshot saying `enabled: false`, which the bridge writes at
    // boot for a never-provisioned device and after a wipe). An unloaded
    // snapshot cannot be told from an enrolled device, so it stays capable
    // and the session-setup decision below holds the gate loud rather than
    // let plaintext out on a device that may be enrolled (R2-4, fail-closed).
    // `const`, and that is the point: capability and readiness are two
    // names for one fact, and the only bug that ever made them disagree was
    // a later assignment to one of them (media-e2ee-reviewer, HIGH-1).
    const readiness = callEncryptionReadiness({
      shellSupported,
      status: bridge?.status.get("state"),
      // Signing out does not wipe the E2EE store, so a second account on
      // this install holds a device the server will not accept for it. The
      // bridge raises this durably from a rejected device claim with an
      // absent server row; the join refusal below is the backstop for the
      // very first call after the switch.
      // Either verdict is enough, and they are deliberately separate facts:
      // the first is the server's (a rejected claim plus an absent directory
      // row), the second is this disk's (`mls_signature_key.user_id` via the
      // native accessor). The local one is the only unforgeable half.
      deviceOwnedElsewhere:
        bridge?.deviceOwnedElsewhere.has("state") === true ||
        bridge?.storeOwnedByAnotherAccount.has("state") === true,
    });
    const e2eeCapable = callEncryptionCapable(readiness);
    if (e2eeCapable) {
      try {
        this.#mlsKeyProvider = new MlsKeyProvider();
        // Rotation push to the native Android leg (§5.2): awaited by
        // `applyLocalKey`, so a Remove-driven rotation does not report the
        // local key installed until the phone has taken the new one. The
        // listener OWNS its failure (see the provider docstring): a push
        // that cannot land stops the leg — fail closed, never continue on
        // the old key — and RESOLVES, so the rotation itself completes.
        // Wired unconditionally rather than behind
        // `nativeScreenShareAvailable()`: that accessor is fed by an ASYNC
        // Capacitor probe, so gating the wiring on it left every call joined
        // before the probe landed (cold start into a call, accepting a call
        // from a push notification) with no rotation listener at all, for the
        // call's whole life — a share started later would then keep
        // encrypting under a key a removed member still holds. The body is
        // inert without a leg, so always wiring it costs nothing.
        const provider = this.#mlsKeyProvider;
        provider.onLocalScreenKey = async (key) => {
          const leg = this.#androidLeg;
          // A leg still CONNECTING has no sender to re-key yet. Returning
          // loses nothing: the start path re-reads `lastLocalScreenKey()`
          // once `connect()` resolves and pushes whatever landed here in
          // between, so the leg cannot end up on a stale epoch.
          if (!leg?.active()) return;
          try {
            await leg.setFrameKey({
              keyB64: key.keyB64,
              keyIndex: key.keyIndex,
              // The push fence, both halves: the leg refuses a key from a
              // group other than the one it connected under (epochs are not
              // comparable across groups), and native refuses to apply an
              // epoch behind the one it already holds — so two racing
              // pushes can no longer settle on the OLDER key.
              epoch: key.epoch,
              groupId: key.groupId,
            });
          } catch {
            // Read BEFORE the stop: a leg already stopping, or no longer
            // `active()`, was ended by something that spoke for itself — a
            // gate-share (a re-secure mid-share pushes its key into the leg
            // `#pauseGate` is already stopping), a revoke, a native stop — or
            // deliberately said nothing (a tap, a hang-up), so "stopped"
            // would only contradict it. The stop runs either way. A stop that
            // FAILED or timed out is reported regardless, as `unstoppable`
            // (`rekeyFailureNotice`): the leg is still `active()` after it for
            // the SAME share (`shareToken()`, sampled before the stop, is
            // unchanged; a share started meanwhile is not the one that
            // failed), so the share is live and the user is told to leave the
            // call (see `LEG_REKEY_UNSTOPPABLE_NOTICE`). Nothing rejects out
            // of the listener and nothing retries: the rotation completes.
            const token = leg.shareToken();
            const spoken = leg.stopping() || !leg.active();
            await this.#stopAndroidLeg();
            const message = this.#rekeyFailureMessage(
              rekeyFailureNotice({
                spoken,
                activeAfterStop: leg.active() && leg.shareToken() === token,
              }),
            );
            if (message) this.onErr(new Error(message));
          }
        };
        this.#e2eeWorker = new E2EEWorker();
      } catch (error) {
        this.#e2eeWorker?.terminate();
        this.#mlsKeyProvider = undefined;
        this.#e2eeWorker = undefined;
        // 🔴 Deliberately does NOT drop `e2eeCapable`. It used to, as a
        // fail-safe so a worker that cannot construct (a `worker-src`-less
        // CSP, OOM, a bad bundle) would not break the call — but the
        // 2026-09-06 rule that made every other capable-but-sessionless arm a
        // loud HOLD applies here word for word, and `sessionSetupDecision`
        // has carried the arm for it ("the call key provider is unavailable")
        // the whole time; `connect()` was short-circuiting its own policy.
        //
        // Dropping it also could not be done safely: capability and
        // `readiness` are two names for one fact, and this assignment moved
        // only one of them. With `owned_elsewhere` that gave no gate, no
        // latch and — where the open-group probe had not seen a group — no
        // chip either, i.e. silent plaintext; with `ready` it gave a red strip
        // promising "your audio and video stay paused" over a live, ungated
        // mic (media-e2ee-reviewer, HIGH-1, twice).
        //
        // So the provider and worker stay undefined, the R2-5 gate stays
        // asserted, `sessionSetupDecision` holds it loud, and the user's
        // explicit press is the only way out — with `onErr` still surfacing
        // the underlying exception.
        this.onErr(error);
      }
    }

    // Snapshot the call's E2EE capability for the caption fail-closed gate:
    // captions must never broadcast on a call that can be encrypted unless the
    // mode is positively plaintext.
    this.#setCallE2EECapable(e2eeCapable);
    this.#setCallEncryptionReadiness(readiness);

    // Device-qualified LiveKit identity (slice 6.1/6.4 item 3): source the
    // E2EE device id so `joinCall` mints identity `{user_id}:{device_id}` —
    // MlsKeyProvider's local-last send-key switch matches frame keys by that
    // exact identity. Undefined ⇒ we request no qualified identity (non-E2EE
    // / not-yet-provisioned), and the identity assertion below is skipped.
    const selfUserId = this.getClient()?.user?.id;
    // Withheld once the corroborated verdict says the server will refuse it:
    // sending it would fail the join outright, and the whole point is that
    // this device joins, unqualified and loud, rather than losing voice.
    //
    // Also withheld when the provider or worker failed to construct. That hold
    // can never resolve, and a device-qualified identity makes every peer read
    // us as `pending` and spend their admit grace on a member that will never
    // arrive; bare, they classify us non-enrolled at once and go loud on their
    // own side immediately (round 4, LOW).
    const e2eeDeviceId =
      e2eeCapable &&
      readiness !== "owned_elsewhere" &&
      this.#mlsKeyProvider !== undefined &&
      this.#e2eeWorker !== undefined
        ? bridge?.status.get("state")?.device_id
        : undefined;

    // M3 (move plan, Rev 3): a pre-minted token is used only when it admits
    // exactly the identity THIS attempt would request, for THIS attempt's
    // channel. Anything else (another device, bare versus qualified, another
    // room, a token that does not decode) joins the normal way instead, so a
    // token can never make this device join as someone it is not. The claims
    // are compared and dropped here, never logged. The identity assertion
    // after `room.connect` stays as the backstop.
    //
    // 🔴 SEC5-1: this is the ONLY place a pre-minted token is kept or
    // dropped, and every path to `room.connect` with one passes through it.
    // A seat that presents `{user}:{device}` never connects on a bare
    // `{user}` token: M3 answers `join`, and the attempt mints its own
    // device-qualified token through `joinCall` below.
    //
    // Placed ABOVE everything that reads "is this a pre-minted join?" (the
    // `#sessionDeviceId` write just below, the budget, the post-connect
    // re-statement): a dropped token makes this an ordinary join, and each of
    // those must see it as one. No await separates this from the device-id
    // computation above.
    //
    // F4: a dropped token whose latch bypass is all that let this attempt
    // past a refusal that STILL holds answers from that latch, exactly as
    // `connect()` would have without the bypass, and never `joinCall`. The
    // latch is read again HERE rather than taken from `connect()`: it may
    // have been released during the device enumeration above.
    const authDecision = moveAuthDecision({
      hasAuth: !!auth,
      tokenUsable:
        !!auth &&
        moveTokenUsable({
          token: auth.token,
          expectedIdentity: !selfUserId
            ? ""
            : e2eeDeviceId
              ? `${selfUserId}:${e2eeDeviceId}`
              : selfUserId,
          to: channel.id,
        }),
      latchStillRefused:
        bypassedRefusal !== undefined && this.#refusalLatchHolds(channel),
    });
    switch (authDecision) {
      case "use":
        break;
      case "join":
        // The dropped token takes its clock with it: this attempt mints its
        // own token below, after setup, like any other join.
        auth = undefined;
        preConnectDeadlineAt = undefined;
        break;
      case "answer_latch":
        // No await separates this from the generation check after the
        // device enumeration, so this cannot fail today. It stays so that
        // an await added above can never raise a superseded attempt's
        // refusal over the newer call.
        if (gen !== this.#connectGen) return false;
        // `connect()` has already left the previous call; `disconnect()`
        // releases the worker and provider constructed above (no Room
        // exists yet). `latchStillRefused` implies `bypassedRefusal`.
        this.disconnect();
        this.onErr(new Error(this.#joinRefusalText(channel, bypassedRefusal!)));
        return false;
      default: {
        const exhaustive: never = authDecision;
        return exhaustive;
      }
    }

    /**
     * TRUE when this attempt connects with a token it did not mint — a move
     * whose token M3 kept. Kept distinct from `isMove` deliberately: that one
     * asks whether this attempt STARTED as a move, this one asks whether the
     * identity we present is the SERVER's choice rather than ours, which is
     * the question both `#sessionDeviceId` writes turn on. Read only after
     * M3: a dropped token is an ordinary join, identity and all.
     */
    const preMintedAuth = auth !== undefined;

    // Record the id THIS session is about to present, because
    // `#handleVoiceMove` cannot reach this local and must not read the bridge
    // live instead (see `#sessionDeviceId` for why those two answers differ
    // exactly when it matters).
    //
    // Written unconditionally, including the `undefined` case: a bare identity
    // is a fact about this session as much as a qualified one is, and the
    // server derives no device id from a bare identity either, so the two ends
    // agree on `undefined` without either of them special-casing it. Leaving a
    // previous call's id standing here instead would let a plaintext join
    // inherit an encrypted call's proof of identity. `?? undefined` because
    // `device_id` is nullable on the status record and `moveDecision` must have
    // ONE absent value to test — the same normalization stoat.js does on the
    // wire field.
    //
    // Gated on the supersession token: a doomed attempt that resumes from an
    // await after a newer join has already passed this line must not overwrite
    // the identity that newer join is presenting. It will bail at its next
    // generation check regardless.
    //
    // 🔴 And NOT on the move path, where `preMintedAuth` says the identity is
    // not ours to choose: the token was built by the server for the
    // connection it picks from the OLD room's SFU participant list
    // (`select_move_connection`; the `voice_identity` mapping is only a
    // preference), while `e2eeDeviceId` above is only what the bridge thinks
    // TODAY. The two part company the moment the bridge re-provisions
    // mid-session, and writing the bridge's answer here is what
    // re-opened the hole the device test closes (see `#sessionDeviceId`). That
    // path re-states the field below, after `room.connect()`, from the
    // identity the SFU actually issued; until then the id we last presented
    // stands — which is also the right answer if this move never connects.
    if (!preMintedAuth && gen === this.#connectGen)
      this.#sessionDeviceId = e2eeDeviceId ?? undefined;

    // Resolved once so the Room option and the post-connect sink switch below
    // can never disagree about which audio path this call is on.
    const webAudioMix =
      this.#settings.webAudioMix &&
      localStorage.getItem(DISABLE_WEB_AUDIO_MIX_KEY) !== "1";

    // Our context, not the SDK's (see the field's doc). A superseded connect
    // attempt dies at its next generation check without reaching teardown, so
    // the incoming attempt closes its predecessor's context here — closing a
    // context under a doomed attempt is safe, no audio has flowed yet.
    void this.#callAudioContext?.close().catch(() => undefined);
    const callAudioContext = webAudioMix ? new AudioContext() : undefined;
    this.#callAudioContext = callAudioContext;

    const e2eeRoom = !!(
      e2eeCapable &&
      this.#mlsKeyProvider &&
      this.#e2eeWorker
    );
    const room = new Room({
      e2ee: e2eeRoom
        ? { keyProvider: this.#mlsKeyProvider!, worker: this.#e2eeWorker! }
        : undefined,
      publishDefaults: {
        // E2EE INVARIANT, not a bandwidth knob — the same rule the
        // ScreenShareAudio publish states at its own call site (§7/E5), which
        // the microphone was never given. Empty DTX frames take the
        // zero-length passthrough in the worker (`encodedFrame.data.byteLength
        // === 0` returns before both the encrypt and decrypt paths), so they
        // are never encrypted: per-participant speech/silence timing rides on
        // the wire in cleartext for the whole call.
        //
        // livekit already forces `disableRed` whenever E2EE is on
        // (`LocalParticipant`: `disableRed: this.isE2EEEnabled || ...`) but
        // applies no such rule to DTX (`disableDtx` reads `opts.dtx` alone,
        // default true), so RED is handled for us and DTX has to be set here.
        // Setting `red: false` as well would only degrade PLAINTEXT calls.
        //
        // Scoped to E2EE-capable calls: on a plain voice call there is no
        // timing to protect and DTX is exactly the saving it is meant to be.
        ...(e2eeRoom ? { dtx: false } : {}),
      },
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
      // The object form supplies OUR context (same SDK code path as `true`,
      // minus the SDK-side ownership) — see `#callAudioContext`.
      webAudioMix: callAudioContext
        ? { audioContext: callAudioContext }
        : false,
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

    // Server mute / server deafen, as it lands on the person it was applied
    // to. The SFU revokes the grant and unpublishes the mic, so without this
    // their mic button just flips to muted on its own, pressing unmute is
    // refused, and nothing anywhere says why — the moderator's side of this
    // feature is legible and the moderated side was not. Room-level for the
    // same reason as TrackMuted above: it must survive a republish.
    //
    // Guarded on the FALLING edge only: the initial grant arrives as a change
    // from undefined, and a re-grant (the mute being lifted) is not something
    // to interrupt anyone about.
    //
    // 🔴 The publish edge has TWO causes now. The AFK channel revokes publish
    // at the SFU for everyone who enters it — the server owner included — so
    // the old unconditional "a moderator muted you" would have told every
    // single AFK member something untrue. The classification lives in
    // `afkPolicy.permissionFallReasons` so it is testable; only the copy is
    // here.
    room.on(RoomEvent.ParticipantPermissionsChanged, (prev, participant) => {
      if (participant !== room.localParticipant) return;
      const now = participant.permissions;

      const reasons = permissionFallReasons({
        prevCanPublish: prev?.canPublish,
        nowCanPublish: now?.canPublish,
        prevCanSubscribe: prev?.canSubscribe,
        nowCanSubscribe: now?.canSubscribe,
        isAfkChannel: this.isAfkChannel,
      });

      for (const reason of reasons) {
        if (reason === "afk-publish") {
          this.onErr(
            new Error(
              t`You're in the AFK channel. Your microphone and camera stay off for everyone here — move to another voice channel to talk.`,
            ),
          );
        } else if (reason === "moderator-mute") {
          this.onErr(
            new Error(
              t`A moderator muted you in this server. Your microphone and camera stay off for everyone until they lift it.`,
            ),
          );
        } else {
          this.onErr(
            new Error(
              t`A moderator deafened you in this server. You won't hear this call until they lift it.`,
            ),
          );
        }
      }
    });

    // Autoplay gate. livekit flips `canPlaybackAudio` false when the browser
    // refuses playback (suspended AudioContext / element play() rejection)
    // and back to true once playback succeeds — including via its own
    // startAudio-on-mic-publish rescue, so the banner self-clears for users
    // the rescue reaches. Room-level and registered before connect: the
    // failure can fire during the initial track attach.
    //
    // The edges are asymmetric on purpose: true clears the banner (and any
    // pending re-check) immediately, but false only ARMS a delayed re-check —
    // see `#armAudioBlockedRecheck` for why the false edge cannot be trusted
    // as it lands.
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (room.canPlaybackAudio) {
        clearTimeout(this.#audioBlockedRecheck);
        this.#audioBlockedRecheck = undefined;
        this.#setAudioPlaybackBlocked(false);
        return;
      }
      this.#armAudioBlockedRecheck(room);
    });

    // Click-to-watch: a new call starts with nothing watched. `connect()`'s
    // leading `disconnect()` already cleared it; this also covers a connect
    // that superseded one mid-flight.
    this.#clearWatchedShares();
    this.disposeTrackRoot?.();
    this.disposeTrackRoot = createRoot((dispose) => {
      const allVidTracks = useTracks(
        [
          { source: Track.Source.Camera, withPlaceholder: true },
          { source: Track.Source.ScreenShare, withPlaceholder: false },
        ],
        { room, onlySubscribed: false },
      );
      // The widest of the three placeholder sites (plan §6.2): `vidTracks()`
      // feeds the grid, focus, theater, the PiP video row, `shares` and
      // `#watchScreenShareFocus`. A screen leg publishes screen share only, so
      // the Camera placeholder would put a second, permanently-muted avatar
      // for the sharer in every one of them. Its REAL ScreenShare publication
      // has no placeholder and survives — that tile is the feature.
      this.vidTracks = createMemo(() => dropLegPlaceholders(allVidTracks()));
      // Lives in this root (not in a component) so it is armed for the whole
      // call and torn down with the track list on disconnect — the call card
      // unmounts whenever the user browses to another channel.
      this.#watchScreenShareFocus();
      // Click-to-watch (plan decision A), same lifetime for the same reason:
      // drop a watch whose share ended, and keep a remote-control session's
      // feed watched.
      this.#pruneWatchedShares();
      this.#watchControlledShares();
      // Voice shaper, input gain and the noise filter apply LIVE: the mic
      // runs one processor and every stage of it is tunable in place. The
      // settings reads are tracked, the apply is not — nothing it writes
      // may re-trigger it. Runs once at root creation too, which is a no-op
      // until the mic track exists (the join path attaches it explicitly).
      createEffect(() => {
        const want = this.#micPipelineWants();
        untrack(() => this.#syncMicPipeline(room, want));
      });
      return dispose;
    });

    batch(() => {
      this.#setRoom(room);
      this.#setChannel(channel);
      this.#setState("CONNECTING");
      this.#setVideo(false);
      this.#setScreenshare(false);
    });

    /**
     * THIS attempt's per-connection nonce, captured when its own `connected`
     * fires. A local rather than a read of `#connNonce` because this room's
     * `disconnected` can land after a newer connection has overwritten the
     * field, and the drop marker must name the connection that dropped.
     */
    let attemptConnNonce: string | undefined;

    room.addListener("connected", () => {
      // Read here, not earlier: the SDK populates the local participant's
      // attributes from the JoinResponse before it emits `connected`. Written
      // unconditionally — `undefined` when the token carried no nonce — so a
      // previous connection's value can never survive into this one.
      attemptConnNonce =
        room.localParticipant.attributes?.[CONN_NONCE_ATTRIBUTE] || undefined;
      this.#connNonce = attemptConnNonce;
      this.#setState("CONNECTED");
      // A connect that succeeded retires any involuntary-drop marker:
      // wherever we were dropped from, it is not where this session is now.
      //
      // The second of the marker's two clear sites, and the pair is not
      // redundant. `connect()` clears on the way IN, which is what stops an
      // A-move from aborting the user's own deliberate join to C while it is
      // still `CONNECTING` — but it deliberately skips the auto-rejoin loop's
      // own attempt (see there), so for a rejoin this is the only clear there
      // is, and it is the one that retires the marker once the session is
      // demonstrably back in a call. For every other join this clear is
      // defense in depth: `moveDecision`'s clause (b) is already gated on the
      // session not being `CONNECTED`, so no rule hangs on it — but a marker
      // that outlives its meaning is a loaded footgun for the next reader of
      // those two fields, and retiring it at the one moment it is provably
      // stale costs three assignments.
      //
      // S-a, BEFORE that retirement because it reads the marker: when this is
      // the auto-rejoin loop's attempt reconnecting to the very channel the
      // marker names, the dropped connection it replaces is remembered, so a
      // move event that arrives late and names that dead connection is still
      // recognized as this seat's (`replacedConnNonce` in the move world).
      // Only for that rejoin: any other join replaced nothing of this seat's.
      if (
        opts?.rejoinAttempt &&
        channel.id === this.#lastInvoluntaryChannelId
      ) {
        this.#replacedConnNonce = this.#lastInvoluntaryConnNonce;
        this.#replacedLeftAt = this.#lastInvoluntaryLeftAt;
      }
      this.#lastInvoluntaryChannelId = undefined;
      this.#lastInvoluntaryLeftAt = undefined;
      this.#lastInvoluntaryConnNonce = undefined;
      // For the move rule's token check (see the field). Only while this
      // Room's generation owns the call.
      if (gen === this.#connectGen)
        this.#lastLocalIdentity = room.localParticipant.identity;
      // 🔴 The participants already in the call when we joined never bump this
      // otherwise. livekit routes `ParticipantConnected` through
      // `emitWhenConnected`, which DROPS it unless the room is already
      // connected, so the JoinResponse roster arrives silently — and `#setRoom`
      // ran before `room.connect()`, so `room()` does not change either. Every
      // chip term derived from `remoteParticipants` (`peerCouldEncrypt`, gate
      // (b)'s publisher set) therefore read an empty roster for the whole call
      // if nobody joined, left or published after us: a device that cannot
      // encrypt, joining a call an enrolled peer was already in, stayed on
      // chip `none` with no banner (media-e2ee-reviewer round 4, HIGH).
      this.#setCallParticipantsVersion((v) => v + 1);
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
      // Watch together: a late joiner has missed every session event —
      // GET it (retries once if ingress has not written our voice state
      // yet). Flag-dark builds simply get a 404 or nothing to render.
      if (CONFIGURATION.ENABLE_WATCH_TOGETHER) void this.watch.attach();
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
      // AFK idle watch: one per connection, owned by THIS attempt's `gen`, so
      // a tick that outlives its connection does nothing (see the tick).
      this.#startIdleWatch(room, channel, gen);
      this.#attenuation.attach(room);
      // 🔴 Warm the Windows screen-audio capability answer NOW, minutes before
      // anyone clicks Share. `winScreenAudioSupported()` sits on the
      // user-gesture path immediately before `getDisplayMedia`, where an
      // unresolved shell IPC would burn the transient-activation window and
      // break SCREENSHARING ENTIRELY, not just its audio. No-op off a lit
      // Windows shell; the Linux probe has its own refresh-on-share path.
      primeWinScreenAudioProbe();
      this.#watchDuck.attach(room);
      // Not on a server-ordered move. The entrance sound is the server's
      // "so-and-so has arrived" fanfare, played for everyone in the room; a
      // move already plays the leave/join pair's other half, and re-announcing
      // someone a moderator has just shuffled between two channels is the
      // room hearing the same person arrive twice in two seconds. Read off
      // the local, not a field: this handler fires inside `room.connect()`,
      // and a mutable flag cleared by whichever attempt settles first would
      // be the wrong one's answer.
      if (!isMove) this.#playEntranceSound(channel);
      // AFK is now the SERVER's designation (`Server.afk_channel_id`), read
      // through the reactive accessor — not the channel's name, which any
      // rename granted or removed. This is the only place the plan still
      // needs a value AT a moment in time (the join), and even here it is a
      // fresh read rather than a captured const.
      const { wantMic, attachMicPipeline, forceCameraOff } = afkJoinPlan({
        isAfkChannel: this.isAfkChannel,
        // Honor the persisted pre-call state (the sidebar user bar makes
        // muting/deafening before a call a first-class action): a deafened or
        // explicitly muted user must never join with a hot microphone, even
        // in open-mic mode. Only reconcile micOn against the actual track
        // when we asked for it — a deafen/AFK-forced "off" is not a mute
        // preference.
        deafened: this.#settings.deafen,
        micOn: this.#settings.micOn,
      });
      if (this.speakingPermission)
        this.#setMicEnabled(room, wantMic)
          .then((track) => {
            if (wantMic) this.#settings.micOn = track != null;
            if (attachMicPipeline && track?.audioTrack) {
              // Processor/E2EE ordering (§4.3) — DO NOT REORDER: the mic
              // pipeline (RNNoise AudioWorklet + voice shaper + gain) and
              // camera effects are PRE-encode track processors on the raw
              // media; LiveKit E2EE runs POST-encode on encoded frames
              // (RTCRtpScriptTransform). The fixed pipeline is
              // processor → encoder → E2EE encrypt → SFU, so there is no slot
              // conflict and denoise + E2EE coexist (test T-10). Moving E2EE
              // ahead of the encoder, or a processor after it, would break
              // one or the other.
              this.#syncMicPipeline(room, this.#micPipelineWants());
            }
          })
          .catch((error) => {
            // Capture failed even after the rescue (or permission denied) — a
            // processor attach failure is absorbed in `#syncMicPipeline` and
            // never lands here. Reconcile the
            // mute button with the room's ACTUAL state rather than forcing
            // "muted": a hot mic must never be shown as off. Only while we
            // still own the call: when the rejection IS the hang-up (teardown
            // aborting the capture), writing the torn-down room's "off" here
            // would persist a mute preference the user never chose.
            if (wantMic && gen === this.#connectGen) {
              this.#settings.micOn = room.localParticipant.isMicrophoneEnabled;
              // Blocked access is the one failure the user can act on, and
              // the one that used to reach nobody: the call connected, muted,
              // with nothing on screen (support report 2026-09-03).
              if (isPermissionDeniedError(error))
                this.#reportCaptureDenied("microphone");
            }
          });
      if (forceCameraOff) room.localParticipant.setCameraEnabled(false);
      // Shares already live when we joined: seeded silently, so they get the
      // end chime but no start chime.
      this.#seedLiveRemoteShares(room);
      this.sound.playSound("userJoinVoice");
    });

    room.addListener("disconnected", (reason) => {
      // 🔴 The involuntary-drop marker, recorded FIRST and unconditionally.
      // Reaching this listener at all is the signal: the SFU dropped us and
      // the user did not ask, because a deliberate hang-up goes through
      // `disconnect()`, which strips these listeners before it tears the room
      // down (the note below says the same thing from the other direction).
      // `moveDecision`'s clause (b) reads these two fields to recognize the
      // session a server-ordered MOVE is actually addressed to — see the
      // field declarations for why it cannot just ask whether we are
      // `CONNECTED` to `from`.
      //
      // Above the branch, not inside it, because BOTH outcomes are
      // involuntary. `PARTICIPANT_REMOVED` — what a moderator's move looks
      // like on the wire — is denied by `NO_REJOIN_DISCONNECT_REASONS` and
      // lands in the `DISCONNECTED` arm; a removal the SDK reports with an
      // absent or unrecognized reason fails OPEN and lands in the
      // `RECONNECTING` arm instead, which starts dialing the OLD channel
      // back. That second arm is the one where losing the marker silently
      // undoes the moderator, so recording per-arm would fix the visible half
      // of the bug and leave the worse half in place.
      this.#lastInvoluntaryChannelId = channel.id;
      this.#lastInvoluntaryLeftAt = Date.now();
      // THIS attempt's nonce, never `#connNonce`: a superseded room's late
      // `disconnected` would otherwise snapshot the newer connection's nonce.
      this.#lastInvoluntaryConnNonce = attemptConnNonce;
      // 🔴 The SFU dropped us, and this path does NOT run `disconnect()`. The
      // patched worker's heartbeat is a module-scope interval that keeps
      // posting `{participants: []}` regardless, and an empty window
      // summarizes to `available: true`; LiveKit meanwhile clears the remote
      // participants and unpublishes our tracks, so gate (b) goes vacuous and
      // the local declaration vacuously true. The roster stays populated and
      // verified and the session stays `active`. Net: a green VERIFIED lock
      // over a call that is no longer connected, refreshed once a second for
      // as long as it lasts. Gate (d) exists to stop a green outliving its
      // evidence, so it must be disarmed here even though the session is not.
      //
      // 🔴 Guarded by the connect generation. LiveKit emits `disconnected`
      // asynchronously (after an awaited `sendLeave()`), so a SUPERSEDED
      // room's late event can land during the next call — and since
      // `#armDecodeWitness` runs once per call and nothing re-arms, an
      // unguarded disarm here would pin the NEW call's chip amber for its
      // whole life. The state write below is unguarded too, but its effect is
      // transient and pre-existing; this one is not. An auto-rejoin re-arms
      // through `connect()`, which arms a fresh witness for its new session.
      if (gen === this.#connectGen) {
        try {
          this.#disarmDecodeWitness();
        } catch {
          /* teardown must not be abortable by a chip-derivation throw */
        }
        // Click-to-watch: every watch ends with the call, and the SFU drop
        // does not run `disconnect()`. Same generation guard: a superseded
        // room's late event must not clear the NEW call's watches.
        this.#clearWatchedShares();
      }
      nativeCallServiceStop();
      // Kick / `force_disconnect`: the server will remove the leg anyway
      // (ingress primary-left), but the native side should not wait for the
      // SFU timeout to stop capturing the screen (§7.4).
      void this.#stopAndroidLeg();
      // A deliberate end stays DISCONNECTED (a plain hang-up never even
      // lands here — disconnect() strips the listeners first). Anything
      // else is a transport death on a call the user was IN: auto-rejoin
      // via the full connect() path — the manual hang-up-and-rejoin that
      // always recovered by hand, automated. Gated on CONNECTED so a
      // failing initial join (which also emits `disconnected`) keeps its
      // existing surface-the-error path in connect()'s catch.
      if (shouldAutoRejoin({ state: this.state(), reason })) {
        this.#setState("RECONNECTING");
        void this.#autoRejoin(channel);
      } else {
        this.#setState("DISCONNECTED");
      }
    });

    room.addListener("participantConnected", (participant) => {
      // A screen leg is a share starting, not a person arriving (plan §6.8):
      // the join chime belongs to its owner's primary, which is already in the
      // call. `streamStart` on the ScreenShare publication below is the sound
      // this event actually deserves.
      if (!isScreenLeg(participant.identity))
        this.sound.playSound("userJoinVoice");
      // Roster reconciliation (6.4 step 5): a reconnect within leave-grace
      // cancels a pending Remove; a new SFU participant kicks a fresh reconcile.
      // Passed RAW, legs included (§5.3 rule 3) — a leg changes the SFU set and
      // must be reconciled, but canonicalizing here would let a leg cancel a
      // pending ghost-Remove of its owner.
      this.#mlsSession?.onParticipantJoined(participant.identity);
      // The chip's participant/track domain changed (R2-3/FE-8): bump the
      // version so the derived chip re-runs (remoteParticipants is not reactive).
      this.#setCallParticipantsVersion((v) => v + 1);
    });

    room.addListener("participantDisconnected", (participant) => {
      if (!isScreenLeg(participant.identity))
        this.sound.playSound("userLeaveVoice");
      // Arm the 10 s leave-grace before removing the departed leaf from the MLS
      // group (a transient blip must not churn remove+rejoin). RAW again: a
      // leg holds no MLS leaf, so this is inert for it — and MUST stay inert
      // rather than being canonicalized, or ending a share would arm a Remove
      // of the sharer, who never left (§5.3 rule 3).
      this.#mlsSession?.onParticipantLeft(participant.identity);
      // Forget its observed encryption status: the same identity rejoining
      // is a NEW participant whose publications start NONE-declared, and a
      // stale `true` here would let gate (b) read it encrypted until LiveKit
      // re-emits (it emits on the first publication, so the hole was brief —
      // but there is no reason to keep it).
      this.callEncryption.delete(participant.identity);
      this.#setCallParticipantsVersion((v) => v + 1);
    });

    // Fires AFTER LiveKit finishes restarting the camera track for a new
    // device. Re-apply effects here (not on the store write) so hardware
    // brightness — dropped by restart — is re-established on the NEW source.
    room.addListener("activeDeviceChanged", (kind) => {
      if (kind === "videoinput") void this.reapplyCameraEffects();
    });

    room.addListener("trackPublished", (pub, participant) => {
      // Gate (b)'s quantification domain changed (R2-3): a trackless-then-
      // publishing REMOTE participant must drop the chip from green
      // immediately, not on the next unrelated join/leave.
      this.#setCallParticipantsVersion((v) => v + 1);
      // Reconcile on the publication itself, for BOTH kinds of participant —
      // publishing is what changes the roster answer in each case:
      //  - a screen leg with ZERO publications and its owner present is
      //    INERT, in neither roster list (see `unpublishedLegs`). Its
      //    publications are what the roster then judges it by (§5.3 rule
      //    2(b), see `encryptedLegs`): all declaring encryption folds it onto
      //    its owner, any declaring plaintext makes it non-enrolled — so a
      //    plaintext leg goes loud on THIS reconcile, not the next tick;
      //  - a PRIMARY's publication changes the chip's media-plane gate and,
      //    for a bare (device-less) identity, is the moment its plaintext
      //    media becomes audible — the roster already reports it non-enrolled
      //    on sight, but the reconcile keeps the pause/banner state fresh
      //    rather than waiting up to a full tick.
      void this.#mlsSession?.reconcileNow();
      // The share start chime, off the PUBLICATION rather than playback: with
      // click-to-watch an unwatched share is never subscribed, so a
      // playback-tied chime would never sound for it. See
      // `#remoteShareStartChime` for why "published and unmuted" is the edge.
      this.#remoteShareStartChime(room, pub, participant);
    });

    // The other half of that edge: a consent-held share is muted while its
    // sharer answers the quality dialog, and this is it going live.
    room.addListener("trackUnmuted", (pub, participant) => {
      this.#remoteShareStartChime(room, pub, participant);
    });

    room.addListener("trackUnpublished", (unpub) => {
      // Only a share whose start chime sounded (or that was already live when
      // we joined or reconnected, `#seedLiveRemoteShares`) gets the end
      // chime, so a share cancelled at its consent dialog, never unmuted,
      // stays silent both ways.
      if (this.screenShareTracks.has(unpub.trackSid)) {
        this.sound.playSound("streamEnd");
        this.screenShareTracks.delete(unpub.trackSid);
      }
      // Gate (b)'s quantification domain changed (R2-3): re-derive the chip.
      this.#setCallParticipantsVersion((v) => v + 1);
    });

    // Our own FULL reconnect (livekit 2.15.13 `handleRestarting`) unwinds
    // every remote participant, so the end chime above has already consumed
    // every share's sid; the rejoined participants come back from the join
    // response, whose publications never reach `trackPublished` (livekit
    // builds them before it forwards participant events). Seed the shares
    // live now, silently, like the `connected` seed, so their real end still
    // chimes. After a full restart `reconnected` fires before livekit
    // flushes the events it buffered during the outage, so a buffered
    // publish or unmute of a seeded share finds its sid already here and
    // does not chime either. A RESUME is the other way round (livekit
    // flushes, then emits `reconnected`), but it unwound nothing, so the
    // flushed events meet the set as they would have without the outage,
    // and every share already in it makes this seed a no-op. Only what was
    // buffered AFTER `SignalResumed` is flushed, though: that event
    // DISCARDS the buffer (livekit 2.15.13 `Room.ts:498-499`), so a
    // publish from the part of the outage before it never arrives at all,
    // and this seed is what catches that share (silently, no start chime).
    room.addListener("reconnected", () => {
      if (this.room() !== room) return;
      this.#seedLiveRemoteShares(room);
      // The same discard can eat a `trackSubscriptionStatusChanged` (below).
      this.#setChipPublicationsVersion((v) => v + 1);
    });

    // A remote publication's subscription status moved: re-derive the chip,
    // whose share-only contradiction reads `isDesired` / `isSubscribed`.
    // Stop watching flips `isDesired` inside `setSubscribed(false)`, which
    // emits this at once (unless the room is reconnecting, below); nothing
    // else bumps a version the chip reads for it. Driven by this event and
    // NOT by `watchedShares()`: the chip could re-derive off the watch set
    // before RoomAudioManager's effect has called `setSubscribed(false)`, and
    // read the stale `isDesired`.
    // livekit routes it through `Room.emitWhenConnected`, which BUFFERS it
    // while the room is Reconnecting, `isResuming` or the engine has a
    // `pendingReconnect`. A resume DISCARDS that buffer at `SignalResumed`; a
    // full restart flushes it after `reconnected`. The `reconnected` listener
    // above re-bumps either way, so a Stop watching pressed during the
    // viewer's OWN reconnect can leave the chip stale until `reconnected`.
    // That window is accepted and bounded: the witness covered the share
    // while it was watched. Removed with the room's other listeners
    // (`removeAllListeners`).
    room.addListener("trackSubscriptionStatusChanged", () => {
      if (this.room() !== room) return;
      this.#setChipPublicationsVersion((v) => v + 1);
    });

    // Publish-gate hardening (R2-1): a NEW local publication, or any of
    // livekit's paths that move a sender underneath the gate, must never
    // bypass it. The sweep no longer has to enumerate them — it observes
    // whether the sender can still send (`publishGate.ts`) — but they are
    // worth naming, because they are why the flag alone cannot be trusted:
    //  (a) `setMediaStreamTrack` (device switch / unmute-restart / reconnect)
    //      ends in an unconditional `resumeUpstream()` — `_isUpstreamPaused`
    //      goes false and `UpstreamResumed` fires.
    //  (b) `setProcessor` (denoise/gain/camera-effects attach) calls
    //      `sender.replaceTrack(processedTrack)` DIRECTLY without touching
    //      `_isUpstreamPaused` and emits only `TrackProcessorUpdate` — the
    //      flag stays stale-true, so a bare `pauseUpstream()` would no-op on
    //      its own idempotency guard while real RTP flows. The re-assert for
    //      this path is resume-then-pause (the resume resets the flag; its
    //      nested `UpstreamResumed` re-enters the sweep, which by then reads
    //      a CLEARED flag over a live wire and issues a plain pause that
    //      serializes behind livekit's per-track lock — bounded at two levels,
    //      no recursion, and convergent because the later-reserved lock slot is
    //      always the pause. Verified against the pinned 2.15.13 source.)
    //  (c) `republishAllTracks` — `unpublishTrack` then
    //      `publishOrRepublishTrack` onto a NEW sender carrying the live
    //      track, with `_isUpstreamPaused` untouched: the same stale-true flag
    //      as (b), reached through `localTrackPublished` instead. Not an edge
    //      case — `setE2EEEnabled()` IS this call, so the session's own
    //      enable flip performs it INSIDE its `enable-window` pause, and the
    //      signal-reconnect republish performs it for every track it skips
    //      `restartTrack()` on (muted, screen-share, screen-share-audio).
    //      Missing it is what let a seat show ME-10 ("your audio and video
    //      stay paused") while the other seat decrypted its frames throughout
    //      (join-race legs, 2026-09-08).
    // All three share one remedy: `#applyPublishGate` sees a sender that is
    // still on the wire and re-pauses it, whichever path put it there — plus
    // a fourth that is not a path at all, a `replaceTrack(null)` that rejects
    // or is skipped over a closing transport, which no enumeration could have
    // caught.
    room.addListener("localTrackPublished", (pub) => {
      // [gate-trace] `localTrackPublished.entry`: the publication census at
      // handler ENTRY, before the kick below (see `#gateTrace`). Reads only;
      // the flag check here is what keeps the census off an off build.
      if (CONFIGURATION.ENABLE_GATE_TRACE)
        this.#gateTrace({
          at: "localTrackPublished.entry",
          subject: `${pub.source}/${pub.trackSid}`,
          subjectSource: pub.source,
          subjectSid: pub.trackSid,
          subjectSidInPublications: room.localParticipant.trackPublications.has(
            pub.trackSid,
          ),
          publicationCount: room.localParticipant.trackPublications.size,
          publicationKeys: [...room.localParticipant.trackPublications.keys()],
          publications: this.#gateTraceCensus(room),
          gate: [...this.#publishGate],
          gateSize: this.#publishGate.size,
          gateHeld: this.#gateHeld(),
          gateGen: this.#gateGen,
          connectGen: this.#connectGen,
          passes: this.#gateSweeper?.passes() ?? null,
          currentRoom: this.room() === room,
        });
      // 🔴 The `lk_e2ee` assertion for Windows native screen audio, bound here
      // rather than at the publish call site so it re-arms PER PUBLICATION,
      // not once per share. livekit's full-reconnect `republishAllTracks`
      // unpublishes and republishes ScreenShareAudio, constructing a NEW
      // RTCRtpSender — and `handleSender` opens
      // `if (E2EE_FLAG in sender || !this.worker) return`, so a fresh sender
      // with a dead worker is skipped IN SILENCE. Binding here covers the
      // first publish too: livekit emits this event inside `publishTrack` and
      // Room re-emits it before its first yield. Cheap no-op for every other
      // source and off the Windows path.
      if (pub.source === Track.Source.ScreenShareAudio)
        this.#assertWinScreenAudioEncrypted(room, pub);
      this.#setCallParticipantsVersion((v) => v + 1);
      // livekit's `onTrackUpstreamPaused -> onTrackMuted` sends the server
      // its `MuteTrackRequest` only when `track.sid` is set. The born-paused
      // pause issued at `LocalSenderCreated` (below) ran with NO sid on a
      // first publish and a STALE one on a republish, so the server never
      // marked THIS publication muted -- where the post-publish pause, which
      // carried the sid, did. Re-emit now that the sid is assigned, so the
      // peer-visible mute state (and the SFU's blank injection) stay
      // identical to a post-publish pause. Only livekit's own handler
      // listens to `UpstreamPaused`; `#reassertPublishGate` and the trace
      // pair below listen to `UpstreamResumed` / `TrackProcessorUpdate`, so
      // nothing of ours re-enters. The stale-sid pair a republish's repause
      // emitted is harmless server-side -- recorded so a log reader does not
      // chase it. One more thing not to chase: if the gate emptied during
      // the offer/answer, this re-emit (mute) is followed one op later by
      // the landed publication's own `resume` (unmute) -- the `resumeLanded`
      // arm below, scoped to this one publication -- a one-RTT mute flicker
      // for peers, ending in the right state.
      if (
        isLocalTrack(pub.track) &&
        pub.track.isUpstreamPaused &&
        upstreamOf(pub.track.sender) === "quiet"
      )
        pub.track.emit(TrackEvent.UpstreamPaused, pub.track);
      // A republish (the E2EE flip, the signal-reconnect republish, the
      // declaration seam) lands here on a brand-new sender with livekit's
      // pause flag left stale-true. The sweep observes the wire, so it needs
      // no hint about which track that was.
      //
      // The kick is DECIDED by `publishKickAction` (publishKickPolicy.ts),
      // no longer unconditional on the gate. HELD gate: the pre-wave sweep
      // over the whole map, whose `pause`/`repause` arms never resume, so it
      // is safe over every publication there. EMPTY gate: NO map sweep --
      // `publishGateOp` answers `resume` for EVERY `{flag: true, quiet}`
      // publication under an empty gate, and the map holds pauses the gate
      // does not own: the screen-share consent-pending pause
      // (`if (consentPending) shareTrack.pauseUpstream()` below, the track
      // held in `#consentHeld`), which an empty-gate map sweep resumed on
      // ANY later publish -- the share's own native audio landing, a camera
      // toggle while the ask-modal was open -- on every shell, plain web
      // included (final audit F1). What an
      // empty gate still owes is the F1 strand: a born-paused publication
      // whose gate emptied DURING its offer/answer lands here as
      // `{flag: true, sender.track: null}`, and the 1->0 resume sweep and
      // `#reassertPublishGate` read `trackPublications`, which did not
      // contain it yet. That publication is exactly the one `#bornPaused`
      // tagged at `LocalSenderCreated`, so the empty-gate arm resumes THAT
      // publication alone, through the same `applyPublishGate` op over a
      // publication built from the track (`resume`: no-op on a live sender,
      // `failed` if the attach threw) -- nothing is lost. The born adapter's
      // flag is `#consentHeld.has(pub.track)`: a republish under a held gate
      // whose offer/answer straddled the 1->0 edge re-tags the consent-held
      // share born-paused and lands it here on an empty gate, and without
      // the flag this arm would resume it ahead of its consent answer; at a
      // first publish the hold is not yet set and the flag reads false. The
      // tag is consumed here whichever arm runs, so it cannot outlive one
      // publish.
      // `failed` is the report key: `unproven` is filled by the op arms
      // (`pause`/`repause`, which an empty gate never reaches; the resume
      // arm's only route into it is the outer catch's `unreadable` path,
      // unreachable over a livekit `LocalTrack` whose `isUpstreamPaused` and
      // `sender` are plain reads), and `held` is read in this same
      // microtask. Both arms that leave the gate empty then run the F4 mic
      // re-sync (see `#syncMicPipelineIfLanded`); a held gate defers to its
      // 1->0 edge.
      const bornPaused =
        isLocalTrack(pub.track) && this.#bornPaused.delete(pub.track);
      const kick = publishKickAction({
        gateHeld: this.#gateHeld(),
        bornPaused,
      });
      if (kick === "sweep") {
        if (this.room() === room) void this.#applyPublishGate(room);
      } else if (
        kick === "resumeLanded" &&
        isLocalTrack(pub.track) &&
        this.room() === room
      ) {
        void applyPublishGate(
          [
            gatedPublicationFromSender(
              {
                source: pub.source,
                sid: pub.trackSid,
                track: pub.track,
              },
              this.#consentHeld.has(pub.track),
            ),
          ],
          this.#gateHeld,
          {},
        ).then(
          (s) => {
            if (s.failed.length > 0)
              console.error("[mls] publish gate could not resume publishing", {
                publications: s.failed,
                reasons: [...this.#publishGate],
                bornPaused: true,
                landed: true,
              });
            this.#syncMicPipelineIfLanded(room, pub);
          },
          () => this.#syncMicPipelineIfLanded(room, pub),
        );
      } else {
        this.#syncMicPipelineIfLanded(room, pub);
      }
      // A publish that was in flight across the session's E2EE flip lands
      // here declared NONE (livekit stamps the type when it builds the
      // request, and the flip republishes only what was registered). The
      // session re-declares it; until then the chip reads amber, never
      // green, off the same `trackInfo` (rtc/localPublicationEncryption.ts).
      if (this.room() === room)
        this.#mlsSession?.noteLocalPublicationsChanged();
      const track = pub.track;
      if (!track) return;
      // `off` BEFORE `on`: `republishAllTracks` reuses the SAME `LocalTrack`
      // instance and `unpublishTrack` removes only livekit's own handlers, so
      // without this a pair accumulates per republish — every enable flip,
      // re-secure and signal reconnect — and one event then fans out into k
      // concurrent sweeps. `Track`'s own `setMaxListeners(100)` keeps that
      // silent — the listeners are on the track, not the Room.
      track.off(TrackEvent.UpstreamResumed, this.#reassertPublishGate);
      track.off(TrackEvent.TrackProcessorUpdate, this.#reassertPublishGate);
      track.on(TrackEvent.UpstreamResumed, this.#reassertPublishGate);
      track.on(TrackEvent.TrackProcessorUpdate, this.#reassertPublishGate);
      // [gate-trace] `track.upstreamResumed` / `track.processorUpdate`: the
      // memoized log-only pair (see `#gateTraceListenersFor`), same `off`
      // BEFORE `on` idiom. Not registered at all on an off build.
      if (CONFIGURATION.ENABLE_GATE_TRACE) {
        const gtTrace = this.#gateTraceListenersFor(track, room);
        track.off(TrackEvent.UpstreamResumed, gtTrace.resumed);
        track.off(TrackEvent.TrackProcessorUpdate, gtTrace.processor);
        track.on(TrackEvent.UpstreamResumed, gtTrace.resumed);
        track.on(TrackEvent.TrackProcessorUpdate, gtTrace.processor);
      }
    });

    // Between `emit(LocalSenderCreated)` and the `LocalTrackPublished` that
    // triggers a sweep sits one offer/answer, and the publication is ABSENT
    // from `trackPublications` for all of it -- so no sweep can see the new
    // sender. The `[gate-trace]` `localSenderCreated` record (see
    // `#gateTrace`) is emitted FIRST, before the gate acts, so the leg
    // reducer's episode opens on the pre-pause state. This listener is
    // where the gate acts FIRST (born paused) -- first among OUR listeners:
    // livekit's own E2EE manager subscribed to this event at Room
    // construction and runs before us, attaching the sender transform, which
    // is independent of the track the sender carries. Run 3 (rejoin-leak
    // handoff 7.9) measured why
    // it must: livekit creates the sender ALREADY carrying the live track,
    // emits this one statement later, then awaits the offer/answer, and RTP
    // starts when the answer is applied -- so the earliest pause the sweep
    // could issue, at `LocalTrackPublished`, let the seat's first 1-4 RTP
    // packets (20-80 ms) leave as PLAINTEXT mic on every publish under a
    // held gate, and a processor re-attach inside the window reopened it
    // for seconds. Pausing here, one microtask after the emit and before
    // the 20 ms-debounced offer, is the only place that can NARROW it -- to
    // the detach-vs-answer race, which the `LocalTrackPublished` sweep still
    // backstops; the plan claims narrowing, not closure.
    room.localParticipant.on(
      ParticipantEvent.LocalSenderCreated,
      (sender, track) => {
        // [gate-trace] `localSenderCreated` (see `#gateTrace`). `track.sid`
        // is UNASSIGNED on a first publish (`track.sid = ti.sid` runs after
        // the awaited `negotiate()` this emit sits inside) and STALE on a
        // republish (`unpublishTrack` deletes the map entry and never
        // clears `track.sid`), so the record says which (`subjectSidAssigned`,
        // `subjectSidInPublications`) and the census is what a reader
        // compares against `localTrackPublished.entry`'s. Reads only; the
        // flag check here keeps the census off an off build.
        if (CONFIGURATION.ENABLE_GATE_TRACE) {
          const gtSid = track.sid ?? null;
          this.#gateTrace({
            at: "localSenderCreated",
            subject: `${track.source}/${gtSid ?? "no-sid"}`,
            subjectSource: track.source,
            subjectSid: gtSid,
            subjectSidAssigned: gtSid !== null,
            subjectSidInPublications:
              gtSid === null
                ? null
                : room.localParticipant.trackPublications.has(gtSid),
            publicationCount: room.localParticipant.trackPublications.size,
            publicationKeys: [
              ...room.localParticipant.trackPublications.keys(),
            ],
            publications: this.#gateTraceCensus(room),
            upstreamPaused: isLocalTrack(track) ? track.isUpstreamPaused : null,
            hasSender: !!sender,
            senderHasTrack: !!sender.track,
            transportState: sender.transport?.state ?? null,
            gate: [...this.#publishGate],
            gateSize: this.#publishGate.size,
            gateHeld: this.#gateHeld(),
            gateGen: this.#gateGen,
            connectGen: this.#connectGen,
            passes: this.#gateSweeper?.passes() ?? null,
            currentRoom: this.room() === room,
          });
        }
        // Born paused (D0). `pauseAtBirth` is the ONLY entry from here:
        // `#applyPublishGate` and the sweeper read `trackPublications`,
        // which does not hold this sender until `LocalTrackPublished`, and
        // the sweeper is per-drive. It runs the same `applyPublishGate` op
        // over ONE publication built from the track itself, so it yields
        // `pause` on a first publish and `repause` on a republish (the flag
        // is stale-true and the sender live), issued through livekit's own
        // `pauseUpstream()` -- never a bare `replaceTrack(null)`, which the
        // gate's resume could never undo. The `LocalTrackPublished` sweep
        // stays as the backstop: the detach races the answer, so this
        // narrows C0 rather than closing it, and the `#bornPaused` tag
        // added below is what lets the kick there resume THIS publication
        // if the gate empties during the offer/answer. The tag says the hook
        // RAN the gate op over this track (a sweep came back: the gate was
        // held at the emit), not that a pause was issued -- `publishGateOp`
        // answers `none` over a sender whose transport is already closed,
        // and that track is tagged too. Nothing here is awaited.
        // `unproven` is the report key, not an empty `proven`: `runOne`
        // returns null when the gate empties mid-op, which is not a failure.
        if (this.room() !== room || !isLocalTrack(track)) return;
        const sweep = pauseAtBirth(
          gatedPublicationFromSender({
            source: track.source,
            sid: track.sid ?? null,
            track,
          }),
          this.#gateHeld,
        );
        if (sweep) this.#bornPaused.add(track);
        if (sweep)
          void sweep.then(
            (s) => {
              if (s.unproven.length > 0)
                console.error(
                  "[mls] publish gate could not prove the wire quiet",
                  {
                    publications: s.unproven,
                    reasons: [...this.#publishGate],
                    bornPaused: true,
                  },
                );
            },
            () => undefined,
          );
      },
    );

    // Set only by the `join_call` step below, so the catch can tell the
    // server's answer to THIS join apart from a same-typed error thrown by
    // any other step in the try (joinRefusalPolicy classifies only the
    // former).
    let joinCallError: unknown;
    // This attempt's resume prefetch and its abort. The local is cleared once
    // a session owns the prefetch (from then on `disconnect()` aborts it);
    // while it is set, the `finally` below aborts it on every way out.
    let resumePrefetchAbort: AbortController | undefined;
    let resumePrefetch: MlsCallSessionDeps["resumePrefetch"];
    try {
      // Resume prefetch (join-latency plan, R2-m2 / R2-m3 / R-W2-7): the
      // natively read-only reads a resume needs, started now so they overlap
      // the listener registration, joinCall and room.connect below, and
      // handed UNAWAITED to the session. Only where a session could follow:
      // capable, a bridge, and not a device the server will not accept.
      // Started inside the try, not where `readiness` is computed: nothing
      // is awaited in between, and here the `finally` covers every exit —
      // above this try, a synchronous throw would leave a claim held until
      // the next `disconnect()`. The bridge never rejects it; `.catch` is
      // the belt, and `null` is what the session reads as "join".
      if (e2eeCapable && bridge && readiness !== "owned_elsewhere") {
        resumePrefetchAbort = new AbortController();
        this.#resumePrefetchAbort = resumePrefetchAbort;
        resumePrefetch = bridge
          .prefetchResume(channel.id, resumePrefetchAbort.signal)
          .catch(() => null);
      }
      // --- Media E2EE wiring (slice 6.3/6.4) --------------------------
      // The frame-key path + the media-plane observers are wired here; the
      // MLS control-plane session (constructed after room.connect, below) is
      // the SOLE driver of all of it. Inert until `media_e2ee_enabled` flips
      // (6.5). Inside the try DELIBERATELY: `await bridge.onCallKeysChanged`
      // can reject (native listener registration), and an owned rejection
      // outside the try escaped with no teardown — worker/provider held and
      // the UI stuck on CONNECTING until the next user action.
      // Whether the native keys-changed listener registered — the one
      // asynchronous setup step. An input to the session-setup decision
      // below: `false` on a capable shell is a hold, never a release.
      let keysListenerBound = false;
      if (e2eeCapable) {
        // Keys-changed loop (§3.5): native pushes `e2ee:call-keys-changed` on
        // every LOCAL epoch advance. Route it INTO the session (the SOLE
        // `applyKeys` driver, NEW-3): it fetches the §7.2 frame-key egress and
        // installs them under the Add-grace/Remove-immediate timing + the §4.4
        // loud-state debounce — replacing 6.3's direct `provider.applyKeys`.
        // (`bridge` is non-null here — `e2eeCapable` required it.)
        if (bridge) {
          // Bounded like every delivery-service wait (`MLS_REQUEST_DEADLINE_MS`;
          // R2-4 fail-closed): a registration that never settled used to hang
          // connect() on CONNECTING for good — nothing had published, so the
          // gate was fine, but the user was stuck. At the deadline the attempt
          // carries on WITHOUT the listener and the session-setup decision
          // below holds the gate loud, so the failure resolves to the Leave /
          // Stay banner. A registration that settles late is unlistened on
          // arrival — no session will ever be built for it. A native REFUSAL
          // lands on the same hold (it used to tear the call down).
          // 🔴 Clamped to what is left of a MOVE's budget when there is one.
          // `MLS_REQUEST_DEADLINE_MS` is 45 s against a move token that lives
          // 10 s, so the unclamped wait cannot be reached without the token
          // already being dead — waiting it out would trade "joined without
          // the listener, gate held loud" for "in neither channel". The
          // shorter deadline lands on the SAME arm: the attempt carries on
          // without the listener and `sessionSetupDecision`'s `hold_loud`
          // holds the publish gate, so nothing publishes unencrypted because
          // we hurried.
          const moveBudgetLeftMs = preConnectBudgetLeft();
          const deadline = requestDeadlineSignal(
            moveBudgetLeftMs === undefined
              ? MLS_REQUEST_DEADLINE_MS
              : Math.min(MLS_REQUEST_DEADLINE_MS, moveBudgetLeftMs),
            new Error(
              "E2EE call setup timed out: the native key-change listener did not register",
            ),
          );
          const registration = bridge.onCallKeysChanged((event) => {
            void this.#mlsSession?.onLocalKeysChanged(
              event.group_id,
              event.epoch,
            );
          });
          let unlisten: (() => void) | undefined;
          try {
            unlisten = await Promise.race([
              registration,
              new Promise<never>((_, reject) => {
                deadline.signal.addEventListener(
                  "abort",
                  () => reject(deadline.signal.reason),
                  { once: true },
                );
              }),
            ]);
            keysListenerBound = true;
          } catch (error) {
            console.error(
              "[rtc] E2EE keys-changed listener did not register; the publish gate holds",
              error,
            );
            void registration.then(
              (late) => late(),
              () => undefined,
            );
          } finally {
            deadline.release();
          }
          // A newer connect() may have superseded us across the await — drop
          // this listener immediately rather than orphaning it, and never clobber
          // the newer invocation's shared state (gate HIGH).
          if (gen !== this.#connectGen) {
            unlisten?.();
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
        // A full reconnect empties the remote set until the new join
        // response; a heal probe that fired inside that window could not
        // judge, so give it a fresh settle once the Room is back.
        room.addListener("reconnected", () => {
          this.#mlsSession?.noteSfuReconnected();
          // And re-assert the gate. NOT because a closed transport reopens —
          // `closed` is terminal in `RTCDtlsTransportState`. The two real
          // cases: a FULL reconnect whose `republishAllTracks` threw (livekit
          // catches and logs it, leaving some tracks unrepublished, and still
          // emits `reconnected`), and a mic that muted/unmuted across the
          // outage. A RESUMED reconnect republishes nothing, so neither
          // `localTrackPublished` nor `UpstreamResumed` fires and this is the
          // only sweep that window gets.
          if (this.#publishGate.size > 0 && this.room() === room)
            void this.#applyPublishGate(room);
        });
      }

      if (!auth) {
        // The server's configured voice region, else the lowest-latency
        // advertised node (cached 10 min; falls back to "worldwide"). Only
        // decisive for the room's first joiner — the server pins a channel
        // to the node that opened it.
        const node = await voiceNodeForChannel(this.getClient(), channel);
        try {
          auth = await channel.joinCall(
            node,
            true,
            undefined,
            // `device_id` is nullable on the status record; the route takes
            // "absent", not "explicitly null".
            e2eeDeviceId ?? undefined,
            // S-b: only the auto-rejoin loop's own attempt says so. The
            // server then answers `AlreadyConnected` instead of
            // force-disconnecting a live seat in another channel — the seat a
            // move carried there while this session was deaf to the event.
            // `#autoRejoin` ends quietly on that answer.
            opts?.rejoinAttempt,
          );
        } catch (error) {
          // 🔴 Deliberately NOT recovered here. delta refuses a device-qualified
          // join it cannot resolve for the signed-in account
          // (`assert_device_bound_session`), and the commonest cause is this
          // install's E2EE store belonging to a DIFFERENT account — sign-out
          // does not wipe it. Re-joining UNQUALIFIED would rescue the call, and
          // a first cut did exactly that; it hands a hostile or compromised
          // server a lever it does not otherwise have. One `FailedValidation`
          // reply would put this client on a BARE identity, which every peer
          // classifies as instantly non-enrolled (`mlsRosterPolicy`) — so the
          // whole call drops to `mixed` and everyone else is offered "Turn off
          // encryption" — and would raise a destructive "Reset encryption"
          // prompt here, on nothing but that server's say-so. The route builds
          // that message with a catch-all `map_err`, so a database error says
          // it too (media-e2ee-reviewer, HIGH-2).
          //
          // The account-switch case is recovered on the CORROBORATED path
          // instead: `E2EEBridge.#onClaimResult` (a rejected device claim plus
          // an absent device-directory row plus no §6.4 restore) raises
          // `deviceOwnedElsewhere`, `readiness` reads `owned_elsewhere` before
          // this join, and the device id is withheld above — so the call joins
          // unqualified, holds the gate loud, and never reaches this catch.
          // What the refusal earns is a name (`classifyJoinRefusal` →
          // `DeviceNotRegistered`) so the latched refusal can say what
          // happened instead of "The call couldn't be started right now".
          joinCallError = error;
          throw error;
        }
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
      // [gate-trace] `connect.add` (see `#gateTrace`). Reads only; the
      // record is built only when the instrument is on.
      if (CONFIGURATION.ENABLE_GATE_TRACE)
        this.#gateTrace({
          at: "connect.add",
          e2eeCapable,
          gate: [...this.#publishGate],
          gateSize: this.#publishGate.size,
          gateHeld: this.#gateHeld(),
          gateGen: this.#gateGen,
          connectGen: this.#connectGen,
          passes: this.#gateSweeper?.passes() ?? null,
          currentRoom: this.room() === room,
        });
      // Fresh sweeper per call: its in-flight/pending state must never cross
      // from a disposed Room to this one. The gen bump is what KILLS the old
      // sweeper — a sweep of it still parked on an awaited livekit op resumes
      // holding the previous token, so it is refused whatever the Room fields
      // say by then.
      this.#gateSweeper = undefined;
      this.#gateRoom = undefined;
      this.#gateStillCurrent = undefined;
      this.#gateGen++;
      // The call boundary clears EVERYTHING the episode holds, including
      // `callPauseDisproved` and the dropped-pass flag that survives the two
      // narrower episode boundaries.
      this.#gateEpisode.resetForCall();

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
      // 🔴 The move path's `#sessionDeviceId`, re-stated from the identity the
      // SFU actually issued instead of from the bridge (see the withheld write
      // above and the field's own note). We were handed this token, so its
      // identity — and with it the device half the NEXT move's token will be
      // minted for — is the server's answer off the OLD room's mapping, and
      // nothing local can predict it. Read off `{user_id}:{device_id}`, the
      // same grammar the identity assertion below asserts; a bare identity has
      // no device half and is recorded as `undefined`, exactly as a bare join
      // is. The ownership check immediately above guards it and no await
      // separates the two.
      if (preMintedAuth)
        this.#sessionDeviceId =
          room.localParticipant.identity.split(":")[1] || undefined;
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
      // under an encrypted flag; the session-construction gate (6.4 step 6,
      // `sessionSetupDecision`'s `identityOk`) then answers `hold_loud`, so no
      // session is built and the latch keeps the chip red.
      let e2eeIdentityOk = false;
      if (e2eeCapable && selfUserId && e2eeDeviceId) {
        const expectedIdentity = `${selfUserId}:${e2eeDeviceId}`;
        const actualIdentity = room.localParticipant.identity;
        if (actualIdentity !== expectedIdentity) {
          this.#setCallEncryptionLatch(
            (prev) =>
              prev ?? {
                error: new Error(
                  `E2EE call identity mismatch: expected "${expectedIdentity}", ` +
                    `got "${actualIdentity}" — refusing call encryption ` +
                    `(device-qualified identity, slice 6.1/6.4).`,
                ),
              },
          );
        } else {
          e2eeIdentityOk = true;
        }
      }

      // Probe whether this channel already has an open E2EE group — the chip's
      // in-call FE-7 input, the §0.2 #9 self-attribution for web/toggle-off
      // shells (gate F4: this must run for EVERY call, not just E2EE-capable
      // ones), and the name the T0d fail-safe gives its RE-SECURING hold when
      // the DS has not answered at 5 s. It decides NOTHING about the publish
      // gate: the availability escape that released on a completed "none"
      // (R2-6 / G-M2) was withdrawn 2026-09-06, and a 404 / feature-off /
      // error now settles "none" purely as the chip's completed verdict. Raw
      // authenticated fetch so it works without the desktop bridge.
      this.#openGroupProbe = "pending";
      {
        const apiClient = this.getClient();
        if (apiClient) {
          const [authHeader, authValue] = apiClient.authenticationHeader;
          const path = `/mls/channels/${channel.id}/open_group`;
          const url = `${apiClient.options.baseURL}${path}`;
          const probe = async (): Promise<"open" | "none" | "ratelimited"> => {
            try {
              const response = await fetchWithRatelimitPolicy(
                () =>
                  fetch(url, {
                    headers: { [authHeader]: authValue },
                    signal: AbortSignal.timeout(OPEN_GROUP_PROBE_TIMEOUT_MS),
                  }),
                "GET",
                path,
                {
                  // One wait more than the transport's own bound: the last
                  // retry lands after the server's LAST reset hint, so a
                  // bring-up burst that spent the whole window still gets
                  // a real verdict for the chip's open-group attribution
                  // (the no-session branches) instead of the fail-open
                  // default it kept when the probe gave up with the rest.
                  maxRetries: RATELIMIT_MAX_RETRIES + 1,
                  onRatelimited: () => {
                    // A 429 is not a verdict about the group: the DS
                    // answered, from this session's own MLS bucket, which
                    // only an E2EE call's bring-up spends. Tell the
                    // fail-safe NOW — it reads this at 5 s and the reset
                    // may be 10 s away — so its RE-SECURING reason names
                    // the exhausted budget (the gate holds either way),
                    // while the policy keeps asking (bounded) for the real
                    // verdict the chip attributes from.
                    if (gen === this.#connectGen) {
                      this.#openGroupProbe = "ratelimited";
                    }
                  },
                },
              );
              return response.ok ? "open" : "none";
            } catch (error) {
              if (isRateLimited(error)) return "ratelimited";
              throw error;
            }
          };
          void probe()
            .then((verdict) => {
              // Ownership guard: a stale probe resolving after a hang-up /
              // rejoin must not clobber the NEXT call's tri-state (the T0d
              // fail-safe reads it; the new call runs its own probe).
              if (gen !== this.#connectGen) return;
              this.#openGroupProbe = verdict;
              // `ratelimited` says nothing about the group: the chip's
              // open-group attribution keeps its default rather than
              // vouching either way.
              if (verdict !== "ratelimited") {
                this.#setCallChannelHasOpenGroup(verdict === "open");
              }
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
      const setup = sessionSetupDecision({
        e2eeCapable,
        bridge: !!bridge,
        keyProvider: this.#mlsKeyProvider !== undefined,
        userId: !!selfUserId,
        deviceId: !!e2eeDeviceId,
        identityOk: e2eeIdentityOk,
        keysListenerBound,
        deviceOwnedElsewhere: readiness === "owned_elsewhere",
      });
      if (
        setup.action === "session" &&
        bridge &&
        this.#mlsKeyProvider &&
        selfUserId &&
        e2eeDeviceId
      ) {
        // THIS attempt's controller, captured before the local is cleared
        // below — never the field, which a newer attempt may already own.
        // W2R-M1: inert until wave 3, whose session aborts it before any
        // join path it takes, so an abandoned prefetch never cleans up the
        // fallback's group.
        const prefetchAbort = resumePrefetchAbort;
        const session = new MlsCallSession({
          bridge,
          userId: selfUserId,
          deviceId: e2eeDeviceId,
          channelId: channel.id,
          requestMfaTicket: () => this.#requestMfaTicket(),
          channelHasOpenGroup: () => this.#openGroupProbe,
          // Rejoin plan §4.5: the chip reads the session state REACTIVELY.
          // Guarded by session identity so a disposed session's terminal
          // "closed" can never clobber a newer call's signal.
          onStateChange: (state) => {
            if (this.#mlsSession === session) this.#setCallSessionState(state);
          },
          resumePrefetch,
          abortResumePrefetch: prefetchAbort
            ? () => prefetchAbort.abort()
            : undefined,
        });
        session.bindMedia(this.#buildMediaBinding(room, this.#mlsKeyProvider));
        this.#mlsSession = session;
        this.#mlsSessionBridge = bridge;
        // The session owns the prefetch now; `disconnect()` aborts it.
        resumePrefetchAbort = undefined;
        this.#setCallSessionState(session.state());
        this.#armDecodeWitness(session);
        void session.start();
      } else if (e2eeCapable) {
        // Capable shell, no session — R2-4, withdrawn 2026-09-06 under the
        // T0d rule: the gate is never released without a DS verdict, and
        // with no session no verdict can ever come. `negotiating` stays where
        // the R2-5 assertion put it; the structured error latches so the
        // existing loud state renders — the NOT-ENCRYPTED chip, and the
        // Leave / Stay banner through `callBanner`'s `terminal_loud` arm
        // (red chip + `ready` device + latched) —
        // and the banner's "Stay unencrypted" is the only release
        // (`#confirmNoSessionPlaintext`). `prev ??` keeps the identity-
        // mismatch error latched above; the decision's reason names every
        // other arm. Re-sweep so a track published across the awaits above
        // is paused under the held gate. (`setup` is `hold_loud` here by
        // construction — the fallback text only satisfies the type.)
        const reason =
          setup.action === "hold_loud"
            ? setup.reason
            : "This call could not be encrypted: the call session could not be set up";
        console.error("[rtc] holding the publish gate:", reason);
        this.#setCallEncryptionLatch(
          (prev) => prev ?? { error: new Error(reason) },
        );
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
        // The server refused THIS join with an answer a retry cannot change
        // (joinRefusalPolicy): no voice on the channel (a group whose owner
        // has not turned calling on — owner opt-in server-side), no Connect
        // permission, a full call. Terminal and actionable, in the same
        // modal every other call failure uses, and latched so every join
        // affordance stays inert until the channel changes: the raw
        // `NotAVoiceChannel` body used to reach the caller as an unhandled
        // rejection with nothing to tell the user, and each press started
        // another attempt — dozens measured live 2026-09-06 on a fresh
        // group DM. Only `join_call`'s own answer is classified.
        const refusal =
          error === joinCallError ? classifyJoinRefusal(error) : undefined;
        if (refusal) {
          this.#recordJoinRefusal(channel, refusal);
          this.onErr(new Error(this.#joinRefusalText(channel, refusal)));
          return false;
        }
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
    } finally {
      // R-W2-7: no session was built (a `hold_loud` or plain-call arm, a
      // superseded return, a throw), so nobody else will ever consume the
      // prefetch: hand any claim back now. The LOCAL controller, never the
      // field — a newer attempt may already own that. Idempotent after
      // `disconnect()`'s own abort.
      resumePrefetchAbort?.abort();
    }
    return true;
  }

  disconnect(opts?: { discardMls?: boolean }) {
    // [gate-trace] `disconnect.entry` (see `#gateTrace`), ABOVE the try so a
    // teardown that throws still leaves its witness. `connectGen` is the
    // PRE-bump value (`this.#connectGen++` is the try's first statement), so
    // it names the call being torn down. Reads only, throw-free, and built
    // only when the instrument is on (a production teardown does no work here).
    if (CONFIGURATION.ENABLE_GATE_TRACE)
      this.#gateTrace({
        at: "disconnect.entry",
        gate: [...this.#publishGate],
        gateSize: this.#publishGate.size,
        gateHeld: this.#gateHeld(),
        gateGen: this.#gateGen,
        connectGen: this.#connectGen,
        connectGenPhase: "pre-bump",
        passes: this.#gateSweeper?.passes() ?? null,
      });
    try {
      // Doom any in-flight connect() FIRST: every await in connect() re-checks
      // this token and bails with its own room teardown. Without the bump a
      // disconnect landing mid-await was silently lost — connect() resumed,
      // called room.connect() on the Room this teardown had already disposed,
      // and the user ended up joined to a call they had just left. (A fresh
      // join still supersedes cleanly: connect()'s own leading disconnect()
      // is followed by its own bump.)
      this.#connectGen++;
      // With the doom, and so BEFORE the session is disposed below (R-W2-7):
      // a kept group the attempt's resume prefetch claimed and no session
      // consumed goes back to the bridge's keep timer, at its original
      // deadline.
      this.#resumePrefetchAbort?.abort();
      this.#resumePrefetchAbort = undefined;
      // Whatever attempt was pending is over (doomed by the bump above): the
      // join affordances must come back, even after an attempt that hung.
      this.#setJoinPending();
      // The caller hanging up before anyone answered must silence the
      // outgoing ring NOW — the VoiceChannelLeave echo also stops it, but
      // that round-trips the websocket (and never arrives if the socket is
      // the thing that died). Idempotent no-op when nothing is ringing.
      this.sound.stopRingtone();
      // A user-driven teardown (hang-up, or a manual join's leading
      // disconnect) also ends any pending auto-rejoin loop. The loop's OWN
      // attempts come through here too — connect()'s leading disconnect —
      // and must not cancel the loop that issued them.
      if (!this.#rejoinConnectInFlight) {
        this.#rejoinSeq++;
        this.#cancelRejoinWait?.();
      }
      nativeCallServiceStop();
      // The Android screen leg dies with the call (§7.4): kick / autoLeave /
      // session terminal / a fresh connect() all land here. Fire-and-forget —
      // this method must stay synchronous, and the native stop is idempotent.
      void this.#stopAndroidLeg();
      // Linux screen-share audio dies with the call too — this choke point
      // is the guaranteed backstop (F1): handleDisconnect stops tracks
      // programmatically, which never fires "ended", so without this a
      // dropped call would leave the virtual PipeWire device live in the
      // user's graph. Idempotent, no-op off the capable shell.
      this.#disarmScreenAudioGuard();
      this.#screenAudioGen++;
      void stopScreenAudio(this.#screenAudioSessionId);
      // Windows screen-share audio dies with the call at the SAME choke point,
      // for the same reason: `handleDisconnect` stops tracks programmatically,
      // which never fires `"ended"` — and on Windows that DOM event is
      // unreachable for our destination-node track in any case, so livekit's
      // auto-unpublish net cannot clean up after it either. Idempotent and
      // silent with no session; deliberately hung off this EXISTING choke
      // point rather than a second `"disconnected"` listener.
      void teardownWinScreenAudio();

      // Media E2EE teardown (§4.2 / §7.2): dispose the MLS session FIRST (its
      // best-effort self-`callRemove` wants the DS still reachable — before
      // room.disconnect), then stop listening for native epoch pushes, terminate
      // the worker (its residual per-participant key sets — LiveKit has no
      // key-deletion API — die WITH it, bounding the §7.2 blast radius to the
      // call), and drop the provider + observed status. Runs before the no-room
      // guard so a half-set-up call still tears down.
      //
      // Sign-out (`discardMls`) also tells the bridge the last session was
      // built with to delete every kept local group — ahead of the dispose,
      // so its keep refusal is already standing (plan M9) — then drops the
      // reference (W2-n2). Every other caller gets the session's default
      // dispose.
      const discardMls = opts?.discardMls === true;
      if (discardMls) {
        void this.#mlsSessionBridge?.discardKeptLocalGroups();
        this.#mlsSessionBridge = undefined;
      }
      this.#mlsSession?.dispose({ discard: discardMls });
      this.#mlsSession = undefined;
      this.#setCallSessionState(undefined); // no session ⇒ no state (§4.5)
      // Tauri 2.11's injected unlisten reads `listeners[id].handlerId`
      // without checking that the entry exists (tauri `src/event/mod.rs`,
      // `unlisten_js_script`), so an unlisten landing outside the entry's
      // lifetime rejects — seen as an uncaught "reading 'handlerId'" on
      // every failed group join. The listener is being abandoned either
      // way: it must not surface as an error, and if the bridge's unlisten
      // ever throws synchronously it must not abort this teardown.
      try {
        const pending = this.#unlistenCallKeys?.() as unknown;
        if (pending instanceof Promise) pending.catch(() => undefined);
      } catch {
        /* see above */
      }
      this.#unlistenCallKeys = undefined;
      // 🔴 Guarded for the same reason as the unlisten above. Disarming writes
      // UNAVAILABLE through a Solid setter, which synchronously re-runs the
      // chip derivation over the SFU's participants and publications. A throw
      // out of a half-disposed room would land in this method's single catch
      // and skip everything below — the worker would survive with its
      // per-participant key sets (the §7.2 bound this teardown exists to
      // enforce), and `room.disconnect()` would never run, so hanging up would
      // not actually hang up.
      try {
        this.#disarmDecodeWitness();
      } catch {
        /* see above */
      }
      this.#e2eeWorker?.terminate();
      this.#e2eeWorker = undefined;
      this.#mlsKeyProvider = undefined;
      this.captions.detach();
      this.annotations.detach();
      // Watch together dies with the call: the host's leave ends the
      // session server-side anyway (delete_voice_state hook) but we also
      // send a best-effort DELETE, and the player is disposed here — the
      // MinigameChip "dies with the call" rule.
      this.watch.detach();
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
      // Same gen bump as at connect: every sweep of the sweeper being dropped
      // here is refused from now on, including the ones still parked on an
      // awaited `pauseUpstream()` that resume inside the NEXT call.
      this.#gateSweeper = undefined;
      this.#gateRoom = undefined;
      this.#gateStillCurrent = undefined;
      this.#gateGen++;
      // The call boundary clears EVERYTHING the episode holds, including
      // `callPauseDisproved` and the dropped-pass flag that survives the two
      // narrower episode boundaries.
      this.#gateEpisode.resetForCall();
      this.#pinnedMicId = undefined;
      this.#setCallEncryptionLatch(undefined);
      // Clears with the call's other latched encryption state and nowhere
      // else — a new call is the only thing that clears it (see
      // `#publishWinScreenAudio`).
      this.#screenAudioPlaintext = false;
      this.#setCallMediaHold(false);
      this.#setCallNonEnrolled([]);
      // Reset the 6.5 signals so the next call's card never flashes this
      // call's latched mode/roster/attribution (FE-9a).
      this.#setCallMode(undefined);
      this.#setCallE2EECapable(false);
      this.#setCallEncryptionReadiness("unsupported");
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

      // Ours to close (see `#callAudioContext`): the SDK skips closing
      // provided contexts, and a leaked one keeps the tab flagged as playing
      // audio for the rest of the session. ABOVE the room guard on purpose:
      // if connect() threw between creating the context and #setRoom, the
      // error path lands here with no room and the context must still die.
      void this.#callAudioContext?.close().catch(() => undefined);
      this.#callAudioContext = undefined;

      // ABOVE the room guard on purpose, for the reason the audio-context
      // close above states: the call is over either way, and a hold recorded
      // against a call that never got a room must not outlive it. The
      // `#stopPushToTalk()` below clears it too, but that is under the guard.
      this.#pttHeld = false;
      // Click-to-watch: every watch ends with the call (plan decision A).
      // Above the room guard for the same reason as the hold above.
      this.#clearWatchedShares();

      // ABOVE the room guard for the same reason: a watch must not outlive
      // the call on the no-room path either. A standing idle claim is NOT
      // withdrawn here — leaving the call removes the voice pointer the claim
      // needs, and the next join deletes it outright; the tick's own
      // `#connectGen` test is what keeps a late response from acting.
      this.#stopIdleWatch();

      const room = this.room();
      if (!room) {
        // The rejoin loop keeps `channel`/state asserted with NO Room so the
        // card stays up as "Reconnecting" between attempts (and as the
        // actionable "Disconnected" after giving up) — a hang-up landing in
        // that window must still clear the call UI.
        batch(() => {
          this.#setState("READY");
          this.#setChannel();
          this.#setFocus(undefined);
        });
        return;
      }

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
        clearTimeout(this.#audioBlockedRecheck);
        this.#audioBlockedRecheck = undefined;
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
      this.#attenuation.detach();
      this.#watchDuck.detach();

      // Room disconnect stops tracks (destroying attached processors); drop the
      // controller's references and release any virtual-background image URL.
      this.#micPipeline = undefined;
      this.#cameraEffects.reset();
      this.#setCameraBackgroundStatus("idle");
      this.#setCameraFaceFilterStatus("idle");
      this.#setCameraFaceFilterDegraded(0);

      // Not during the rejoin loop's own churn: tearing down the dead room
      // before an attempt (and after a failed one) is not the user leaving,
      // and a leave blip per retry reads as the call dying over and over.
      // Nor during a server-ordered move's leading teardown, for the same
      // reason: the user did not leave, they were moved, and the leave chime
      // immediately followed by the join chime reads as the call dying.
      if (!this.#rejoinConnectInFlight && !this.#moveLeadingTeardown)
        this.sound.playSound("userLeaveVoice");
    } catch (e) {
      this.onErr(e);
    }
  }

  /**
   * Automatic rejoin after an unexpected disconnect. Each attempt is the FULL
   * `connect()` path — fresh token, fresh Room, fresh MLS session — because
   * that is exactly the manual hang-up-and-rejoin that always recovered by
   * hand while every SDK-level resume had given up. Backoff between attempts,
   * short-circuited by a visibility/online edge: a minimised window's
   * throttled timers are one way the original wedge happened, and those edges
   * are the moment a retry is most likely to succeed.
   *
   * Cancellation is `#rejoinSeq`, re-checked after every await: any
   * user-driven `disconnect()` (hang-up, or a manual join's leading teardown)
   * bumps it and resolves the pending wait. A `connect()` that reports
   * "superseded" (false) ends the loop the same way. After
   * `MAX_REJOIN_ATTEMPTS` consecutive failures the loop stops hammering and
   * leaves the card up as DISCONNECTED with the channel still asserted — the
   * Rejoin affordance renders from that exact state.
   */
  async #autoRejoin(channel: Channel) {
    const seq = ++this.#rejoinSeq;
    for (let attempt = 0; attempt < MAX_REJOIN_ATTEMPTS; attempt++) {
      const delay = rejoinDelayMs(attempt);
      await this.#rejoinWait(delay);
      if (seq !== this.#rejoinSeq) return;
      try {
        this.#rejoinConnectInFlight = true;
        // true ⇒ recovered (the `connected` handler set CONNECTED);
        // false ⇒ a manual join or hang-up took over mid-attempt. Done
        // either way. `rejoinAttempt` marks THIS attempt as the loop's, so it
        // keeps the involuntary-drop marker a move may still be addressed by
        // — a join the user makes alongside this one does not.
        await this.connect(channel, undefined, { rejoinAttempt: true });
        return;
      } catch (error) {
        // S-b: the server turned this rejoin away because the user's call is
        // live in another channel — a move carried another seat there while
        // this session was deaf to the event (its socket was down too). A
        // retry would get the same answer, and a Rejoin card would be a
        // force-join that kicks that seat, so the call ends here as a plain
        // leave: no channel on the card, no Rejoin, a non-modal notice.
        //
        // 🔴 NOT a join refusal and never latched (`isRejoinPreempted` is
        // not in `TERMINAL_JOIN_REFUSALS`): the user's own later return to
        // this channel is an ordinary join the server lets through.
        //
        // The failed attempt's teardown has already cleared the call
        // signals. The drop marker is retired here too (P2-19), as the
        // `moved-elsewhere` arm does, so the move event arriving late cannot
        // run that arm on top of this and tell the user twice.
        if (isRejoinPreempted(error)) {
          if (seq !== this.#rejoinSeq) return;
          this.#lastInvoluntaryChannelId = undefined;
          this.#lastInvoluntaryLeftAt = undefined;
          this.#lastInvoluntaryConnNonce = undefined;
          batch(() => {
            this.#setChannel();
            this.#setState("DISCONNECTED");
          });
          const notice = t`Your call continued in another window or on another device`;
          if (this.#snackbar) {
            this.#snackbar.show({
              message: notice,
              autoCloseDelay: 8000,
              closeable: true,
              messageLine: 2,
            });
          } else {
            this.onErr(new Error(notice));
          }
          return;
        }
        console.warn(`[rtc] rejoin attempt ${attempt + 1} failed`, error);
      } finally {
        this.#rejoinConnectInFlight = false;
      }
      if (seq !== this.#rejoinSeq) return;
      // The failed attempt's teardown cleared the call signals — re-assert
      // them so the card stays up as "Reconnecting" through the backoff
      // instead of flashing away to nothing.
      batch(() => {
        this.#setChannel(channel);
        this.#setState("RECONNECTING");
      });
    }
    if (seq !== this.#rejoinSeq) return;
    // Out of attempts: an actionable "Disconnected" (channel kept ⇒ the
    // card and its Rejoin button stay up), never a dead one.
    this.#setState("DISCONNECTED");
  }

  /**
   * Sleep between rejoin attempts. Resolves early when the document becomes
   * visible or the browser reports the network back — or when a user-driven
   * `disconnect()` cancels the loop (via `#cancelRejoinWait`; the caller's
   * `#rejoinSeq` check then stops it). Background throttling can stretch the
   * timer, but unlike the SDK's abandoned recovery it still fires.
   */
  #rejoinWait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const onVisible = () => {
        if (document.visibilityState === "visible") finish();
      };
      const onOnline = () => finish();
      const finish = () => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("online", onOnline);
        if (this.#cancelRejoinWait === finish)
          this.#cancelRejoinWait = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("online", onOnline);
      this.#cancelRejoinWait = finish;
    });
  }

  /**
   * S-a: the per-connection nonce of the connection this session is DIALING
   * right now, or `undefined` once it is `CONNECTED` (that nonce is then
   * `#connNonce`, and the move world must not see it twice) or when there is
   * none. The SDK fills the local participant's attributes from the
   * JoinResponse, before `connected`, so a rejoin the SFU already lists can be
   * named here while it is still `CONNECTING`.
   *
   * Read off this session's own Room through `CONN_NONCE_ATTRIBUTE`, never off
   * an event — it is the seat's proof, not the server's claim.
   */
  #dialingConnNonce(): string | undefined {
    if (this.state() === "CONNECTED") return undefined;
    return (
      this.room()?.localParticipant.attributes?.[CONN_NONCE_ATTRIBUTE] ||
      undefined
    );
  }

  /**
   * The server moved this user to another voice channel
   * (`voiceMoveRequested`, a `VoiceMoveRequest`) — a moderator's move, the
   * AFK sweep's, or the user's own move from the session that owns their
   * call, which all arrive as the same event with no reason on it. The
   * backend publishes this event and only THEN evicts the user's connections
   * from the old room — so the eviction is imminent, or has already landed if
   * the SFU's leave beat the event here. Either way a client that does
   * nothing leaves the user in no call at all. The connection being moved is
   * named by `connNonce` (the per-connection token attribute, see
   * `#connNonce`) when the event carries one, and by `deviceId` otherwise.
   *
   * 🔴 Which session (if any) may act on it is `moveDecision`'s call and
   * nothing here re-states it: this method resolves the world honestly, hands
   * it over, and obeys the answer. The merged backend sends this private event
   * only to the session its voice record names; an older, voice-move-only
   * backend sent it to EVERY session of the moved user — an idle phone, a
   * spare browser tab, a second desktop — and the rules still have to hold
   * there. An `ignore` is SILENT — no toast, no log line — because the
   * alternative is one real move plus one spurious error per device the user
   * owns.
   *
   * Following is always a full `connect()`: a fresh Room, worker, KeyProvider
   * and MLS session for the destination, never anything carried over from the
   * source. `move` dials the event's pre-minted token, which M3 in
   * `#connectAttempt` still drops unless it names exactly the identity that
   * attempt presents; `join` is the tokenless arm, an ordinary join through
   * the join route with no move budget and no latch bypass.
   *
   * 🔴 The event carries a live SFU credential. Nothing from it (nor the
   * token's decoded claims) is logged, put in a signal, stored, or written
   * into an Error: the user-facing text names the destination by its cached
   * channel name only. No `console` call here takes anything but a string
   * literal: a LiveKit error can quote the signal URL, which carries the
   * token as `access_token=`.
   */
  async #handleVoiceMove(move: VoiceMoveRequest): Promise<void> {
    // `node` is the node NAME and is not connectable; `url` is the endpoint.
    const destination = this.getClient()?.channels.get(move.to);
    // FE0-3: a destination behind an age, password or spoiler check this
    // member has not passed on this device is never joined by a move, a
    // moderator's or the AFK sweep's. The checks are client-side state, so
    // the server cannot hold this line; this is where it holds.
    const gated = destination !== undefined && this.#memberGate(destination);
    // Whether the event's token was minted for the identity THIS connection
    // last joined as, for exactly `to`, and whether that identity is
    // device-qualified. With no nonce to compare, the two together are the
    // proof a dropped connection needs (`moveDecision` step 4). Only the
    // verdicts are kept, never the claims.
    const forThisConnection = moveTokenUsable({
      token: move.token,
      expectedIdentity: this.#lastLocalIdentity ?? "",
      to: move.to,
    });
    const identityIsDevice = (this.#lastLocalIdentity ?? "").includes(":");
    const decision = moveDecision({
      callState: this.state(),
      currentChannelId: this.channel()?.id,
      lastInvoluntaryChannelId: this.#lastInvoluntaryChannelId,
      lastInvoluntaryLeftAt: this.#lastInvoluntaryLeftAt,
      now: Date.now(),
      from: move.from,
      to: move.to,
      url: move.url,
      token: move.token,
      tokenForThisConnection: forThisConnection,
      lastIdentityIsDevice: identityIsDevice,
      // The device the server minted this token for, against the device this
      // session actually presented at join time. Handed over as two separate
      // facts rather than compared here: the channel clauses alone let two of
      // the user's own sessions answer the same single-mint token (see
      // `#sessionDeviceId`), and which of them may act is `moveDecision`'s
      // call like every other addressing rule in this slice.
      deviceId: move.deviceId,
      sessionDeviceId: this.#sessionDeviceId,
      // The same pairing for the per-connection nonce: the source connection
      // the server named, against the nonce THIS session's current
      // connection and its last involuntary drop carried.
      connNonce: move.connNonce,
      sessionConnNonce: this.#connNonce,
      lastInvoluntaryConnNonce: this.#lastInvoluntaryConnNonce,
      // S-a: two more nonces this seat can prove are its own, both read out
      // of THIS session and never off the event. The nonce of the connection
      // it is dialing right now (a rejoin the SFU may already list), and the
      // dead connection a finished rejoin replaced, aged from the original
      // drop. Each can only turn a `moved-elsewhere` into an addressed move.
      pendingConnNonce: this.#dialingConnNonce(),
      replacedConnNonce: this.#replacedConnNonce,
      replacedLeftAt: this.#replacedLeftAt,
      destinationKnown: destination !== undefined,
      destinationGated: gated,
    });

    // Not addressed to this session, and silent — no toast, no log line —
    // because the alternative is one real move plus one spurious error per
    // device this user owns.
    //
    // 🔴 There is no exception to that rule here any more, and the absence is
    // the point. An earlier cut of this handler re-typed the "addressed, but
    // too late to act" test beside this line — the marker comparison, the
    // `!== "CONNECTED"` gate and the device match, all written out a second
    // time — so that it could turn one `ignore` loud. It was correct, and it
    // was still the defect: an addressing rule sitting where no spec in this
    // repo can reach it is a rule a one-token revert ships green. That case is
    // `moveDecision`'s step 6 now — `fail-loud` / `stale-notice`, which also
    // covers the unverifiable late seat the local copy dropped in silence — so
    // the whole ladder lives in ONE place, the pure module, under the spec.
    // Every `ignore` that reaches this line is genuinely nothing to tell
    // anyone about, and every loud outcome arrives below with a reason.
    if (decision.action === "ignore") return;

    // 🔴 THE single highest-value mitigation in this handler, and the reason
    // it runs unconditionally for every answer that gets past the return
    // above: past the addressing tests this session is either the one being
    // moved or (`moved-elsewhere`) a sibling connection of it, and the server
    // is evicting it from the old room either way. For the sibling this block
    // matters MORE, not less: an auto-rejoin of the old channel dials with
    // `forceDisconnect`, which would kick the seat that was actually moved.
    //
    // The old room's `disconnected` listener (registered in
    // `#connectAttempt`) closes over the OLD `channel` and runs
    // `#autoRejoin(channel)` whenever `shouldAutoRejoin` says yes — and that
    // rule is a DENY-list that FAILS OPEN: an absent reason recovers, and the
    // SDK omits the reason on some transport closes. A server eviction (a
    // LiveKit `RemoveParticipant`, from the move's `remove_identity_if_present`
    // or from `remove_user`) that arrives as `PARTICIPANT_REMOVED` is denied by
    // the list; the one that arrives bare is not, and a rejoin of the OLD
    // channel racing our move would silently undo a moderator's decision.
    //
    // `disconnect()` alone does not close it. It only bumps `#rejoinSeq` when
    // `#rejoinConnectInFlight` is false, so a rejoin whose own `connect()` is
    // already in flight is NOT canceled by it — whichever invocation bumps
    // `#connectGen` last wins, and by the time that settles the move token's
    // ten seconds are gone. So cancel the loop by hand, resolve any pending
    // backoff wait, and strip the old room's listeners outright (the same
    // "FE-9c" move `#connectAttempt`'s supersession checks make) so no late
    // `disconnected` can reach `shouldAutoRejoin` at all.
    this.#rejoinSeq++;
    this.#cancelRejoinWait?.();
    this.room()?.removeAllListeners();

    if (decision.action === "fail-loud") {
      // The move is happening whatever this client manages, so the local
      // state must stop claiming a call we are no longer in — a card left up
      // as CONNECTED shows a live call with nobody on the other end. It is
      // also what finally closes the rejoin loop: the `#rejoinSeq` bump above
      // does not cancel an attempt whose `connect()` is ALREADY in flight,
      // and the `#connectGen` bump in here dooms it.
      this.disconnect();
      // `moved-elsewhere`: the event named ANOTHER connection of this user, and
      // this one is a sibling the server is evicting alongside it. That other
      // connection may be a second tab or window on this same device, not only
      // another device, so the copy names both. The call lives on at that
      // other connection, so this one ends as a plain leave: no destination on
      // the card and no Rejoin — a Rejoin here is a join with
      // `forceDisconnect`, which would kick the seat that was actually moved.
      // The marker is retired too, so a repeat of the event cannot re-trigger
      // this arm. Tested before `unknown-channel` because the answer does not
      // depend on whether the destination is known; its name only improves
      // the notice.
      //
      // The notice is a NON-modal snackbar. This device may be an idle
      // desktop that handed its call off to a phone, and it used to say
      // nothing at all in that case; an `error2` modal waiting on its return
      // would treat a handoff the user did on purpose as a failure. The
      // controller comes in through `setSnackbar` (see there for why it cannot
      // come from `useSnackbar()`). Only when none was provided, as in a
      // `Voice` built outside `VoiceContext`, does the notice fall back to
      // the `onErr` modal, so the move is still said out loud.
      if (decision.reason === "moved-elsewhere") {
        this.#lastInvoluntaryChannelId = undefined;
        this.#lastInvoluntaryLeftAt = undefined;
        this.#lastInvoluntaryConnNonce = undefined;
        // The S-a record goes with the marker: the move it could have
        // matched has been answered.
        this.#replacedConnNonce = undefined;
        this.#replacedLeftAt = undefined;
        const channelName = destination?.name;
        const notice = channelName
          ? t`Your call was moved to #${channelName} in another window or on another device`
          : t`Your call was moved in another window or on another device`;
        if (this.#snackbar) {
          this.#snackbar.show({
            message: notice,
            autoCloseDelay: 8000,
            closeable: true,
            messageLine: 2,
          });
        } else {
          this.onErr(new Error(notice));
        }
        return;
      }
      // `unknown-channel`: nothing to point the card at, and deliberately NOT
      // the old channel — a Rejoin there would put the user straight back
      // into the channel a moderator just moved them out of. The `!destination`
      // half reads the same binding `destinationKnown` was taken from, so it
      // cannot disagree with the reason; it is there to narrow the type for
      // the arms below.
      if (decision.reason === "unknown-channel" || !destination) {
        this.onErr(
          new Error(
            t`You were moved to another voice channel, but this app doesn't know that channel yet. You've left your old call — reload Sloga, then open the channel you were moved to.`,
          ),
        );
        return;
      }
      // 🔴 `gated-destination` (FE0-3): the destination is behind an age,
      // password or spoiler check this member has not passed on this device.
      // The move is refused, and the destination is NOT put on the call card:
      // a card's Rejoin is an ordinary join that would walk straight past the
      // check. The user is told to open the channel, where the check is
      // offered, and join from there. Above the card batch below on purpose,
      // and never a case of the `switch` that runs after it.
      //
      // The marker and the S-a record are retired, as `moved-elsewhere` does:
      // the move they could have addressed has been answered, and a repeat of
      // the event must not re-run this arm.
      if (decision.reason === "gated-destination") {
        this.#lastInvoluntaryChannelId = undefined;
        this.#lastInvoluntaryLeftAt = undefined;
        this.#lastInvoluntaryConnNonce = undefined;
        this.#replacedConnNonce = undefined;
        this.#replacedLeftAt = undefined;
        const destinationName = destination.name;
        this.onErr(
          new Error(
            t`You were moved to #${destinationName}, but that channel has an age, password or spoiler check you haven't passed on this device, so you've left your old call. Open the channel to pass the check, then join the call.`,
          ),
        );
        return;
      }
      // Every other arm resolved the destination, so the card is re-asserted
      // ON IT: DISCONNECTED with a channel asserted is exactly the state the
      // Rejoin affordance renders from (`#autoRejoin`'s own give-up state),
      // and a Rejoin there is an ordinary join that mints its own token —
      // precisely the recovery each of these arms needs.
      batch(() => {
        this.#setChannel(destination);
        this.#setState("DISCONNECTED");
      });
      // D-5b2-2: every notice below names the destination and nobody else.
      // The same event carries a moderator's move and the AFK sweep's, and no
      // reason travels with it, so "a moderator moved you" would be false for
      // every sweep move.
      const destinationName = destination.name;
      // 🔴 A `switch` with a `never` default, rather than a chain of `if`s,
      // and the shape is the repair rather than a tidy-up. A chain that ends
      // in an unguarded arm hands any reason `movePolicy` grows later to that
      // arm's copy, describing a fault that had not happened, on a path no
      // textual scan in this repo asserts over. Under this shape a new reason
      // is a compile error at the default below, not a wrong toast in front
      // of a member.
      switch (decision.reason) {
        case "unverified-session":
          // 🔴 Nothing this user did, and nothing they can fix. This seat
          // cannot be shown to be the one addressed: no nonce on one side or
          // the other (the gate is off), and no token minted for the
          // device-qualified identity this connection last joined as — web,
          // the Electron shell, a member who has never enrolled a device, or
          // an event that carried no token — so no client-side proof exists
          // that this is the session the server moved. The move itself is
          // real and the server has already carried it out, so say that
          // plainly and point at the button rather than describing a fault.
          this.onErr(
            new Error(
              t`You were moved to #${destinationName}. This device can't follow a move on its own, so you've left your old call — the new channel is on your call card, press Rejoin to connect to it.`,
            ),
          );
          return;
        case "stale-notice":
          // The notice is real and the server carried the move out, but it
          // landed past `MOVE_VERIFIED_WINDOW_MS`: the token is dead, so no
          // client was going to follow it automatically. Telling the user is
          // what stops this session's rejoin loop quietly handing them the OLD
          // channel back with nobody told a moderator's decision was reversed.
          // One arm for both populations — the verified seat whose token
          // expired and the seat that can show no device at all — because past
          // that window the device distinction changes nothing either does.
          this.onErr(
            new Error(
              t`You were moved to #${destinationName}, but the notice reached this device too late to follow on its own. You've left your old call — the new channel is on your call card, so press Rejoin to connect to it.`,
            ),
          );
          return;
        default: {
          // Unreachable: `MoveFailReason` is exhausted above. The annotation is
          // the enforcement — add a reason to `movePolicy` without an arm here
          // and this assignment stops compiling.
          const unhandled: never = decision.reason;
          void unhandled;
          return;
        }
      }
    }

    // `move` or `join`. `destinationKnown` above was read off this exact
    // binding and both arms require it, so the re-test narrows the type; it
    // is not a second copy of the rule and cannot disagree with it.
    if (!destination) return;
    // Frozen: the msgid of the success notice below carries this name.
    const destName = destination.name;

    // Both read immediately before the first `connect()`, for the `false`
    // branch at the end: the generation tells a latched answer (which leaves
    // it where it was) from everything else, and the time tells a refusal
    // this move earned from one latched earlier.
    const startedAt = Date.now();
    const genBefore = this.#connectGen;
    // Undefined = every attempt threw.
    let joined: boolean | undefined;
    try {
      // Suppresses the leading teardown's leave chime (the entrance sound is
      // suppressed inside `#connectAttempt`, off its own local): a move is one
      // event to the user, not a hang-up followed by a join.
      this.#moveLeadingTeardown = true;
      let attempt: Promise<boolean>;
      if (decision.action === "move") {
        // The token arm. S1: a moderator may move someone into a channel
        // they could not join themselves, so a latched permission or
        // capacity refusal for the destination does not stand in the way of
        // the token (`moveBypassesRefusalLatch`). The latch itself stays and
        // is not released here: the bypass is scoped to this one attempt,
        // and a refusal M3 falls back on still answers (F4).
        attempt = this.connect(
          destination,
          { url: decision.url, token: decision.token },
          {
            // 🔴 The token is already ticking — see `MOVE_PRECONNECT_BUDGET_MS`.
            movePreConnectBudgetMs: MOVE_PRECONNECT_BUDGET_MS,
            moveLatchBypass: true,
          },
        );
      } else {
        // The tokenless arm: the event carried no token for this connection,
        // or no URL to dial one at. An ordinary join through the join route,
        // which mints its own token and checks the seat binding itself: no
        // move budget (no token is ticking), no latch bypass (without a
        // token there is nothing to bypass it with), and not a rejoin.
        attempt = this.connect(destination);
      }
      // The suppression is over here, not when the connect settles. `connect()`
      // is `async`, so by the time it handed back its promise it had already run
      // everything up to its first await — the leading `disconnect()` included.
      // Held any longer it answered for teardowns that are not this move's: a
      // hang-up mid-move went unheard, and a second move event's clear landed
      // under the first (see the field).
      this.#moveLeadingTeardown = false;
      joined = await attempt;
    } catch {
      // D5: one plain join if the pre-minted one failed. The likeliest cause
      // is a token that died on the way: `MOVE_PRECONNECT_BUDGET_MS` bounds
      // our own work AFTER the event arrives, but nothing bounds how long the
      // event took to arrive, and the SFU refuses a spent token outright. A
      // fresh join mints a fresh one. The error itself is not logged: a
      // transport failure can quote the SFU address and its token.
      if (decision.action === "move") {
        console.warn("[rtc] move: pre-minted join failed; joining normally");
        try {
          joined = await this.connect(destination);
        } catch {
          /* reported below */
        }
      }
    }

    if (joined === undefined) {
      // 🔴 Every attempt threw, and a bare `onErr(error)` would strand the
      // user on NO CALL CARD AT ALL. `connect()` opens with a `disconnect()`
      // and `connected` never fired, so the channel and state signals are
      // already cleared by the time we get here — and `#connectAttempt`
      // rethrows raw anything that is not `join_call`'s own classified
      // refusal. Net: an untranslated livekit `ConnectionError` in the modal
      // and nothing on screen to press.
      //
      // So re-assert the destination in the shape the loud arms above use:
      // DISCONNECTED with a channel asserted is the state the Rejoin
      // affordance renders from, and a Rejoin there is an ordinary join that
      // mints a FRESH token. Skipped when something else already owns the
      // card (a hang-up or a join of the user's own squeezing into the gap
      // between the failure and this line): re-asserting there would
      // resurrect a call they have already moved on from, so the copy changes
      // with it rather than promising a card that is not there.
      const carded = this.channel() === undefined;
      if (carded) {
        batch(() => {
          this.#setChannel(destination);
          this.#setState("DISCONNECTED");
        });
      }
      // Neutral copy (D-5b2-2), as in the arms above.
      const destinationName = destination.name;
      this.onErr(
        new Error(
          carded
            ? t`You were moved to #${destinationName}, but connecting to it failed. You've left your old call — the new channel is on your call card, so press Rejoin to connect to it.`
            : t`You were moved to #${destinationName}, but connecting to it failed. You've left your old call — open the channel you were moved to and join it again.`,
        ),
      );
      return;
    }
    if (joined) {
      this.#setMoveNotice({
        message: t`Moved to #${destName}`,
        at: Date.now(),
      });
      return;
    }
    // False. Three shapes, told apart by the generation and the latch.
    //
    // (a) `connect()` answered from a latched refusal for the destination
    // that no bypass covered, and has already put it in front of the user.
    // That is the one `false` that returns without tearing anything down,
    // before `connect()` reaches its `disconnect()` or `#connectAttempt`, the
    // only two places `#connectGen` moves; every other `connect()` (the
    // user's own rejoin of `from` included) bumps it. So with the generation
    // unchanged and the SOURCE call still asserted, leave it, rather than
    // strand a "Reconnecting" card (or a rejoin attempt the disarm above has
    // already cancelled) on a channel the server has taken us out of.
    if (
      this.#connectGen === genBefore &&
      this.channel()?.id === move.from &&
      this.joinBlocked(destination) === "refused"
    ) {
      this.disconnect();
      return;
    }
    // (b) `join_call` refused THIS move's join (a full call, no Connect
    // permission, ...): `#connectAttempt` tore the attempt down, latched the
    // refusal and showed it. Nothing owns the card, so the destination goes
    // on it as DISCONNECTED, with no copy of our own: the refusal already
    // said why, and a "press Rejoin" would promise a join the latch holds
    // inert. Recognized by a latch this move earned, recorded at or after
    // `startedAt`; F4 (M3 dropped the token and an older latch still
    // refuses) answers from a latch recorded BEFORE it, has already shown
    // its refusal once, and ends here with the call torn down and no card.
    //
    // (c) Anything else is a supersession or a hang-up: a newer join or the
    // user owns the call now. No card, no copy.
    const refusal = this.#joinRefusals().get(destination.id);
    if (
      this.channel() === undefined &&
      this.#connectGen !== genBefore &&
      refusal !== undefined &&
      refusal.at >= startedAt
    ) {
      batch(() => {
        this.#setChannel(destination);
        this.#setState("DISCONNECTED");
      });
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
      // §5.3 rule 2(b): the legs whose OWN declaration says they are
      // encrypted, which is the only witness a viewer has before a frame
      // decrypts. `Participant.isEncrypted` is `size > 0 && every(encrypted)`,
      // so a leg that has published nothing (yet, or any more) is NOT here:
      // it is never lent its owner's trust in advance. Unfolded, it is inert
      // while its owner is present (`unpublishedLegs` below) and loud as an
      // orphan. The `trackPublished` listener kicks a fresh reconcile, so a
      // leg is judged on its publish, not on the next periodic tick.
      encryptedLegs: () =>
        [...room.remoteParticipants.values()]
          .filter((p) => isScreenLeg(p.identity) && p.isEncrypted)
          .map((p) => p.identity),
      // Legs with ZERO publications: the join→publish window, and a leg the
      // server force-unpublished (a Video revoke, an AFK designation) before
      // native tears it down. The roster policy holds such a leg INERT — in
      // neither list, never `pending` — while its owner is present (or is
      // this device); an orphan stays loud. It sends nothing, so there is no
      // mix to report, and reporting one would one-way stop a newborn leg
      // (§0.4) and name a revoked sharer as unencrypted. 🔴 Exactly
      // `size === 0`: anything wider hides a leg that publishes plaintext.
      unpublishedLegs: () =>
        [...room.remoteParticipants.values()]
          .filter(
            (p) => isScreenLeg(p.identity) && p.trackPublications.size === 0,
          )
          .map((p) => p.identity),
      // No publication-derived inputs for PRIMARIES here on purpose. A
      // remote's publications say nothing about whether it is enrolling:
      // livekit stamps `encryption: NONE` on every publication until that
      // participant's own `setE2EEEnabled(true)` republishes it as GCM, which
      // an E2EE joiner does only after its Welcome + first key — so for the
      // whole admit beat an enrolling joiner is NONE-declared and
      // upstream-paused, indistinguishable on the wire from a plaintext
      // client. The roster policy classifies primaries by whether their SFU
      // identity names a device (`isDeviceQualified`) instead.
      // What `identity` publishes right now, by track SID. The session reads
      // it at a media loud latch and again from its heal probe: a peer that
      // re-added after the latch and publishes ONLY new tracks decrypts at the
      // freshly installed key index. Absent participant ⇒ nothing.
      participantTrackSids: (identity) => {
        const p =
          identity === room.localParticipant.identity
            ? room.localParticipant
            : room.remoteParticipants.get(identity);
        return p
          ? [...p.trackPublications.values()].map((pub) => pub.trackSid)
          : [];
      },
      // A full reconnect empties `remoteParticipants` until the new join
      // response; the heal probe must not read that as "everyone left".
      sfuConnected: () => room.state === ConnectionState.Connected,
      onEncryptionState: (state, error, meta) => {
        // Latch a loud failure into the ONE composite signal, together with
        // the origin and the send-side `mediaKeyed` snapshot the session took
        // at latch time (6.5 classifies RE-SECURING vs NOT-ENCRYPTED from
        // callEncryption + this). A transient RE-SECURING is not latched (it
        // may recover).
        //
        // First latch wins, with ONE exception — `meta.replaces`. The
        // session's media→control upgrade used to emit `clear(previous)` then
        // `loud(error)` as two callbacks, which tore this signal for a frame
        // (the banner's owner-mismatch read flapped through `undefined`). It
        // now emits ONE `loud` naming the error it supersedes; the write
        // below replaces the latch only when the held error IS that one, so
        // an unrelated later `loud` still cannot displace the first. ONE
        // functional write, so there is no intermediate value to observe. A
        // `loud` with no meta (nothing the session vouched for) latches a
        // bare `{ error }` — origin undefined, which the chip reads as
        // `not_encrypted` (fail-closed).
        if (state === "loud" && error !== undefined) {
          this.#setCallEncryptionLatch((prev) =>
            prev === undefined || prev.error === meta?.replaces
              ? { error, ...(meta ?? {}) }
              : prev,
          );
        }
        // The session forgot its latch — a re-establish replaced the group,
        // or the peer-scoped heal fired — and names the object it latched.
        // Clear exactly that one (identity-matched on `.error`): the
        // identity-mismatch and no-session holds never coexist with a session
        // (one is constructed only when the identity checks out), and a bare
        // `"clear"` (a transient re-securing ending) carries no error and
        // touches nothing. Until this the UI latch outlived the session's,
        // leaving a successfully re-established call red with no banner and
        // no escape.
        if (state === "clear" && error !== undefined) {
          this.#setCallEncryptionLatch((prev) =>
            prev?.error === error ? undefined : prev,
          );
        }
      },
      // A deferred missing-key verdict is open (or has just closed): the chip
      // must read amber throughout, never green.
      onMediaHold: (active) => this.#setCallMediaHold(active),
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
      // What the SFU has on record for OUR publications — the declaration
      // receivers arm their cryptors from, and the one gate (b) of the chip
      // reads for the local identity. `trackInfo` on a local publication is
      // the server's answer to our own AddTrack, present from registration.
      localPublications: () =>
        [...room.localParticipant.trackPublications.values()].map((pub) => ({
          trackSid: pub.trackSid,
          source: pub.source,
          encryption: pub.trackInfo?.encryption,
        })),
      // Re-declare the named publications under the participant's CURRENT
      // encryption type (GCM once the session flipped it). Same unpublish +
      // publish pair livekit's own `republishAllTracks` runs, restricted to
      // the sids that need it so a correctly declared screen share is not
      // torn down alongside a mis-declared mic. The session holds the
      // publish gate around this; `localTrackPublished` re-applies it to the
      // new publication. Stale-room guarded like the gate itself.
      republishLocalPublications: async (trackSids) => {
        if (this.room() !== room) return;
        for (const sid of trackSids) {
          const pub = room.localParticipant.trackPublications.get(sid);
          const track = pub?.track;
          if (!pub || !track) continue;
          await room.localParticipant.unpublishTrack(track, false);
          if (this.room() !== room) return;
          await room.localParticipant.publishTrack(track, pub.options);
        }
      },
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
  async #pauseGate(room: Room, reason: PublishGateReason): Promise<void> {
    // Stale-writer guard: a binding built for a PREVIOUS call must not add
    // reasons to the gate it shares with the current one — its session is
    // disposed, so nothing would ever release them and every new publication
    // would be swept paused (publishing silence with no UI cause).
    if (this.room() !== room) return;
    // A gate going from empty to held starts a new episode: whatever failed
    // last time is not evidence about this one.
    if (this.#publishGate.size === 0) this.#gateEpisode.beginEpisode();
    this.#publishGate.add(reason);
    // The Android leg STOPS (never pauses) the instant the primary pauses
    // (§0.4) — on reason ADD, before awaiting the WebView pause ops, and
    // deliberately NOT in #applyPublishGate, which re-runs on every
    // LocalTrackPublished. The gate cannot pause the leg: it is a separate
    // native participant the WebView's publication sweep never sees. The stop
    // is one-way, so name the reason that fired it.
    //
    // The user is told as well (`gateStopNotice`), sampled BEFORE the stop
    // bumps the generation — which is what makes it single-fire: a tap or a
    // hang-up that got there first has already bumped it (the starting owner
    // no longer matches), and a second reason during the teardown sees the
    // stop in flight. The attempt this stop cancels exits quietly at its own
    // stale check or catch (it is CANCELLED, so `staleExitNotice` answers
    // none and the catch skips its error), so this is its only notice.
    //
    // Sampled here, but SHOWN only once the primary's pause sweep below has
    // run: nothing new — a modal opening, its reactive fallout — runs between
    // the reason add and that sweep.
    const notice = gateStopNotice({
      startingFor: this.#androidLegStartingFor,
      currentGeneration: this.#androidLegGeneration,
      active: !!this.#androidLeg?.active(),
      stopInFlight: !!this.#androidLeg?.stopping(),
      roomConnected: room.state === ConnectionState.Connected,
    });
    if (this.#androidLeg?.active() || this.#androidLegStartingFor !== undefined)
      console.warn(
        `[rtc] publish gate "${reason}" stopped the Android screen leg`,
      );
    // A gate-share stop that fails or hangs (a rejected or timed-out native
    // stop) leaves the share live AFTER the notice below said it stopped, and
    // with no rotation to follow (a mixed or interlude pause, a loud
    // fallback) nothing else corrects it. So for `gate-share` the leg and its
    // `shareToken()` are sampled BEFORE the stop, and once THAT stop settles
    // a leg still `active()` for the same share gets `LEG_UNSTOPPABLE_NOTICE`.
    // The stop stays un-awaited: awaiting a stop that can hang for its whole
    // timeout would hold the primary's pause sweep behind it.
    const leg = notice === "gate-share" ? this.#androidLeg : undefined;
    const token = leg?.shareToken();
    const stopped = this.#stopAndroidLeg();
    await this.#applyPublishGate(room);
    if (notice === "gate-start") this.onErr(new Error(LEG_GATE_START_NOTICE));
    else if (notice === "gate-share")
      this.onErr(new Error(LEG_GATE_SHARE_NOTICE));
    // Chained only now, after "stopped" was shown, so it can never be the
    // last word over a live share. `#stopAndroidLeg` does not reject on a
    // failed native stop (`#doStop` catches the bridge's rejection and its
    // timeout), so the chain adds no catch.
    if (notice === "gate-share")
      void stopped.then(() => {
        if (leg?.active() && leg.shareToken() === token)
          this.onErr(new Error(LEG_UNSTOPPABLE_NOTICE));
      });
  }

  async #resumeGate(room: Room, reason: PublishGateReason): Promise<void> {
    // [gate-trace] `resumeGate` (see `#gateTrace`): a resume the stale-writer
    // guard below drops is recorded under the SAME `at`, `staleRoom: true`
    // and never `emptied`. Reads only; built only when the instrument is on.
    if (CONFIGURATION.ENABLE_GATE_TRACE && this.room() !== room)
      this.#gateTrace({
        at: "resumeGate",
        reason,
        emptied: false,
        staleRoom: true,
        gate: [...this.#publishGate],
        gateSize: this.#publishGate.size,
        gateHeld: this.#gateHeld(),
        gateGen: this.#gateGen,
        connectGen: this.#connectGen,
        passes: this.#gateSweeper?.passes() ?? null,
        currentRoom: this.room() === room,
      });
    // Same stale-writer guard, for the inverse hazard: a stale resume must
    // not release a reason the CURRENT call's session is still relying on.
    if (this.room() !== room) return;
    this.#publishGate.delete(reason);
    // Nothing promises a pause any more, so there is no claim to withdraw:
    // `endEpisode` clears `callPauseDisproved` along with the spend sets, and
    // deliberately NOT the dropped-pass flag.
    if (this.#publishGate.size === 0) this.#gateEpisode.endEpisode();
    // [gate-trace] `resumeGate`: the resulting set and whether it emptied --
    // `emptied: true` is the leg reducer's episode close. Built only when the
    // instrument is on.
    if (CONFIGURATION.ENABLE_GATE_TRACE)
      this.#gateTrace({
        at: "resumeGate",
        reason,
        emptied: this.#publishGate.size === 0,
        staleRoom: false,
        gate: [...this.#publishGate],
        gateSize: this.#publishGate.size,
        gateHeld: this.#gateHeld(),
        gateGen: this.#gateGen,
        connectGen: this.#connectGen,
        passes: this.#gateSweeper?.passes() ?? null,
        currentRoom: this.room() === room,
      });
    // The 1->0 resume sweep. Under an empty gate it resumes every
    // `{flag: true, quiet}` publication in `trackPublications` EXCEPT a
    // consent-held one: `#sweepPublishGate` hands `#consentHeld` to
    // `gatedPublicationsFrom` as its predicate, and the `resume` arm in
    // `publishGate.ts` returns null over a `consentHeld` publication. That
    // closes the gap the wave-4 completion audit named here (F3): a screen
    // share born-paused under a held gate whose consent-pending pause
    // (`if (consentPending) shareTrack.pauseUpstream()` below) landed on an
    // already-true flag was resumed by this sweep ahead of its viewer-consent
    // answer -- and every `local_confirm` press produces exactly this edge.
    // The hold is keyed by the `LocalTrack`, not by an episode or a name: an
    // episode-scoped set is cleared by the `endEpisode` above BEFORE this
    // sweep could read it, and a name-keyed ledger cannot work because the
    // E2EE-flip republish the same press causes lands the SAME track under a
    // NEW sid -- the name the ledger claimed is retired while the pause it
    // named is still in force. The track survives the republish, so the
    // hold does.
    await this.#applyPublishGate(room);
    // The gate's 1->0 edge (emitted on every resume that leaves the set
    // empty, not only the first). Re-run the mic pipeline sync AFTER the
    // awaited resume sweep, never before, for two reasons: the `size === 0`
    // re-check is only meaningful once the drive has settled (a refill
    // during the sweep must suppress the attach), and an attach must not be
    // issued while the sweep's own repause (resume-then-pause) may still be
    // mid-flight on the same sender. It is NOT a last-writer-wins race over
    // the raw track: livekit's `mediaStreamTrack` getter prefers
    // `processor.processedTrack`, and `setProcessor` assigns `processor`
    // before its `replaceTrack`, so a resume landing in either order
    // converges on the processed track (2.15.13, corrected by the wave-2
    // audit). Fire-and-forget: `#enable()` awaits `resumePublishing`, and
    // the attach's `init` is the worklet + wasm load (0.4-1.5 s measured as
    // the `track.processorUpdate` offset in rejoin-leak handoff 7.6/7.9).
    if (this.#publishGate.size === 0 && this.room() === room)
      this.#syncMicPipeline(room, this.#micPipelineWants());
  }

  /**
   * Sweep once, through the coalescing sweeper so a sweep's own
   * `UpstreamResumed` / `TrackProcessorUpdate` cannot nest. Callers await the
   * work in flight — `#enable()` awaits its pause before flipping E2EE on.
   */
  async #applyPublishGate(room: Room): Promise<void> {
    if (this.room() !== room) return;
    if (!this.#gateSweeper) {
      // 🔴 The stale-writer guard, bound PER SWEEPER rather than per field.
      // `gen` and `room` are captured HERE and never re-read, so this closure
      // keeps answering for THIS call however long one of its sweeps is parked
      // on an awaited livekit op — which is exactly the
      // `if (this.room() !== room) return;` the sweep used to apply inline.
      // Read out of a field instead, the guard says TRUE for a call-N sweep
      // resuming inside call N+1 (the field has been reassigned by then), and
      // that disposed sweep then spends publications in the LIVE episode,
      // re-arms its confirm chain, latches `callPauseDisproved` in a fresh
      // call and reports the new call's gate reasons against the old call's
      // publication names.
      const gen = ++this.#gateGen;
      this.#gateRoom = room;
      const stillCurrent = (): boolean =>
        gen === this.#gateGen && this.room() === room;
      this.#gateStillCurrent = stillCurrent;
      this.#gateSweeper = coalescingSweeper(
        () => {
          // The confirming pass goes through the SAME serialized path, so it
          // can never nest with a sweep a livekit event started in the
          // meantime. `beginPass` consumes the phase flag and any pending
          // confirm request together (P9) — a MUTATION of the live episode, so
          // a pass this sweeper runs after its own call ended must not make
          // it: it would eat the current call's confirming pass.
          if (stillCurrent()) this.#gateEpisode.beginPass();
          return this.#sweepPublishGate(room, stillCurrent);
        },
        undefined,
        // A dropped trailing pass is a sweep something asked for and did not
        // get. Recorded so the pass that observes it does not report a clean
        // bill — `#enable()` awaits its pause and then flips E2EE on.
        //
        // Guarded for the same reason as `beginPass`, and it is the hook that
        // most needs it: it fires at the END of a drive, after the loop, so it
        // is the one that most easily lands past a teardown. Unguarded, a
        // disposed call marks the live episode's next clean sweep unclean and
        // re-arms its confirm.
        () => {
          if (stillCurrent()) this.#gateEpisode.noteDropped();
        },
        // 🔴 The DRIVE boundary, and the reason this argument may not be
        // left off: `repausePending` is scoped by being cleared HERE, and the
        // three-argument call is source-compatible, so omitting it compiles
        // and silently degrades the suppression to no scope at all. That is
        // the rejected episode-scoped design, measured to leave the mic live
        // and the name latched through the mirror window for the rest of the
        // call (D1 (A), D6). It is a FOURTH scope, not one of the three
        // lifecycle boundaries.
        //
        // Deliberately NOT wrapped in `stillCurrent()` like the two hooks
        // above, and NOT because a stale call here is impossible. What the
        // code actually establishes is narrower: `onDriveStart` runs
        // synchronously as `drive()`'s first statement, `drive()` is invoked
        // synchronously by `sweep()`, and the only `sweep()` call is at the
        // tail of `#applyPublishGate` — the same synchronous turn as its
        // `this.room() !== room` re-check, so no teardown can interleave
        // between that check and this hook. Every `#gateGen` bump nulls
        // `#gateSweeper` in the same breath, so the live field never carries a
        // superseded gen either.
        //
        // What it does NOT establish is the sweeper's CAPTURED room: the
        // re-check reads the ARGUMENT room, and the two coincide only while
        // every path that reassigns `this.room()` also drops the sweeper — an
        // invariant spread over three sites with awaits between them, not
        // something this hook verifies.
        //
        // 🔴 It is unguarded because a stale call is HARMLESS here, which is
        // the real reason and the one that does not depend on that invariant:
        // `beginDrive` clears the drive-scoped pending set and nothing else,
        // so a spurious one RE-ARMS repauses — the fail-closed direction. The
        // two hooks above mutate spend and confirm state, where a stale call
        // corrupts the LIVE episode. Putting a predicate in front of the one
        // call that DEFINES drive scope trades that harmless clear for a
        // false negative that collapses the scope — the measured mic-live
        // regression the paragraph above is about.
        () => this.#gateEpisode.beginDrive(),
      );
    }
    await this.#gateSweeper.sweep();
  }

  /**
   * Sweep every local publication to match the gate (empty ⇒ resume all) and
   * hand the verdict to the episode.
   *
   * The decision, the op-to-call mapping and the post-condition live in
   * `publishGate.ts`; the livekit adapter lives in `gatedPublicationsFrom`;
   * and every rule over the RESULT — the stale-room guard, the `proven`
   * un-spend, the confirming re-sweep, the spend, `callPauseDisproved` —
   * lives in `PublishGateEpisode`, because none of them can be reached by a
   * spec or a mutation while they live in this file.
   *
   * A publication still on the wire after a held-gate sweep — a
   * `replaceTrack(null)` that rejected, a stale pause flag over a rebuilt
   * sender — is confirmed with one re-sweep and then LOGGED. Not latched, not
   * shown: see the block at the report site for the four user-facing dead ends
   * that rules out, and why making it visible is its own slice. What it must
   * never be is DROPPED, which `Promise.allSettled` used to do silently — that
   * is what turns one failed pause into a permanent false "your audio and video
   * stay paused".
   */
  async #sweepPublishGate(
    room: Room,
    stillCurrent: () => boolean,
  ): Promise<void> {
    const sweep = await applyPublishGate(
      // UNFILTERED on purpose: the no-track skip belongs to
      // `gatedPublicationsFrom`, where a spec reaches it. Pre-filtering here
      // would put that line back in the file nothing can load.
      gatedPublicationsFrom(
        room.localParticipant.trackPublications.values(),
        // Consulted only under an empty gate: the `resume` arm skips a track
        // still paused for viewer consent. Passed on EVERY pass -- this
        // closure is the coalescing sweeper's, shared by every trigger.
        (t) => this.#consentHeld.has(t),
      ),
      this.#gateHeld,
      // Re-supplied by reference on every pass, so the episode can arm the
      // next pass from this one's report. `repauseSpent` is PERMANENT for the
      // episode and fed only from `sweep.repauseThrew`; `repausePending` is
      // DRIVE-scoped and cleared by `beginDrive`.
      {
        repauseSpent: this.#gateEpisode.repauseSpent(),
        repausePending: this.#gateEpisode.repausePending(),
      },
    );
    // 🔴 THIS sweep's own captured identity, re-checked after the await that
    // is what makes staleness possible at all. `PublishGateEpisode.consume`
    // re-checks `EpisodeDeps.stillCurrent` first thing and that check stays —
    // but that dep can only answer "some sweeper is current", so it cannot
    // tell a resumed call-N sweep from a call-N+1 one, and this call site can.
    // Without it the disposed call reaches the live episode's `#spent`,
    // `#pending` and `callPauseDisproved`.
    if (!stillCurrent()) return;
    this.#gateEpisode.consume(sweep);
  }

  /**
   * Re-assert the gate after livekit moved a sender underneath it. ONE stable
   * reference, so `localTrackPublished` can `off` before `on` (see there), and
   * both events it serves now want exactly the same thing: another sweep,
   * which observes the wire rather than trusting what the event implies.
   * Reads the room from the SIGNAL, not a captured one, so a handler left on a
   * previous call's track sweeps the CURRENT room — which is the safe
   * direction: the sweep is idempotent and judges each publication on its own
   * wire, whereas capturing the old room would sweep a disposed one.
   */
  #reassertPublishGate = (): void => {
    const room = this.room();
    if (!room || this.#publishGate.size === 0) return;
    void this.#applyPublishGate(room);
  };

  /**
   * `[gate-trace]`: the publish-gate instrument the leg reducer
   * (`scripts/leg/toc-reduce.mjs`, its PINNED KEYS header) reads. One JSON
   * record per `console.error` line, serialized `{ t, p, at, ...record }`:
   * `t` = `Date.now()`, the wall clock the observer's frame tap is joined
   * on; `p` = `performance.now()`. Seven fiducials, and nothing else may
   * emit under the prefix: `connect.add`, `disconnect.entry`,
   * `localSenderCreated` and `localTrackPublished.entry` (both carrying the
   * `#gateTraceCensus`), `resumeGate` (`emptied: true` closes a reducer
   * episode), `track.upstreamResumed` and `track.processorUpdate` (the pair
   * from `#gateTraceListenersFor`).
   *
   * Build-time flag `CONFIGURATION.ENABLE_GATE_TRACE` (`VITE_CFG_GATE_TRACE`,
   * off by default, leg dists only). The guard is a RUNTIME early return --
   * one property read per fiducial -- not dead-code elimination: the flag is
   * a `.toLowerCase()` comparison on an object property, which no bundler
   * folds, so this code and the `[gate-trace]` literal stay in every dist
   * (the artifact discriminator is the inlined flag value in the entry
   * chunk). Every emit goes through here; the sites that do work beyond
   * plain reads -- the census and the listener registration -- also check
   * the flag themselves, so an off build computes no census and registers
   * no trace listener. OBSERVATION ONLY: no emit site pauses, resumes or
   * writes gate state.
   */
  #gateTrace(record: Record<string, unknown>): void {
    if (!CONFIGURATION.ENABLE_GATE_TRACE) return;
    console.error(
      "[gate-trace] " +
        JSON.stringify({ t: Date.now(), p: performance.now(), ...record }),
    );
  }

  /**
   * `[gate-trace]` listener pair per `LocalTrack`, MEMOIZED so the
   * `localTrackPublished` handler can `off` before `on` keyed on listener
   * IDENTITY (`republishAllTracks` reuses the same track; an inline arrow
   * would accumulate a pair per republish). Per TRACK because
   * `TrackProcessorUpdate` carries only the processor, so the `subject` is
   * read off the closed-over track at FIRE time. Separate from
   * `#reassertPublishGate`, which returns early on an empty gate and cannot
   * say which event fired. Trace only; see `#gateTrace`.
   */
  #gateTraceTrackListeners = new WeakMap<
    Track,
    { resumed: () => void; processor: () => void }
  >();

  /**
   * `[gate-trace]` publication CENSUS, built the same way for
   * `localTrackPublished.entry` and `localSenderCreated` so the two are
   * element-wise comparable (see `#gateTrace`).
   *
   * 🔴 `upstream` is derived through the SAME `gatedPublicationsFrom`
   * adapter the sweep uses, never from the two booleans: `UpstreamState` is
   * three-valued and the live/quiet split reads the TRANSPORT, so a
   * closed-transport sender would print `pause` where the sweep answers
   * `none`. The adapter SKIPS a publication with no track, so `not-gated` for
   * a present publication is itself a datum, and it names entries
   * `${source}/${trackSid}` -- the key `repauseSpent` / `repausePending` are
   * keyed by.
   *
   * OBSERVATION ONLY: every read is a getter, `gatedPublicationsFrom` and
   * `publishGateOp` are pure, and nothing here pauses, resumes or writes.
   */
  #gateTraceCensus(room: Room): GateTraceCensusEntry[] {
    const census: GateTraceCensusEntry[] = [];
    for (const gtPub of room.localParticipant.trackPublications.values()) {
      const gtGated = gatedPublicationsFrom([gtPub])[0];
      const gtTrack = gtPub.track;
      const gtUpstream = gtGated ? gtGated.upstream() : null;
      const gtOp = gtGated
        ? publishGateOp({
            gateHeld: this.#gateHeld(),
            upstreamPaused: gtGated.upstreamPaused,
            upstream: gtGated.upstream(),
          })
        : null;
      census.push({
        name: `${gtPub.source}/${gtPub.trackSid}`,
        source: gtPub.source,
        trackSid: gtPub.trackSid,
        upstreamPaused: gtTrack?.isUpstreamPaused ?? null,
        hasSender: !!gtTrack?.sender,
        senderHasTrack: !!gtTrack?.sender?.track,
        transportState: gtTrack?.sender?.transport?.state ?? null,
        upstream: gtUpstream ?? "not-gated",
        op: gtOp ?? "not-gated",
      });
    }
    return census;
  }

  /**
   * See {@link Voice.#gateTraceTrackListeners}. `track.upstreamResumed` and
   * `track.processorUpdate`, the former being the leg reducer's resume
   * fiducial. OBSERVATION ONLY.
   *
   * 🔴 `room` is the Room this track was published INTO, captured at
   * registration inside the `localTrackPublished` handler, and both records
   * carry `currentRoom: this.room() === room`: without it a resume on a
   * DOOMED Room's surviving `LocalTrack` is indistinguishable from one on the
   * live call. The pair is memoized per TRACK, so the captured Room is the
   * one that track was FIRST published into; across a real leave both the
   * Room and the `LocalTrack` are new, so the capture cannot go stale.
   */
  #gateTraceListenersFor(
    track: Track,
    room: Room,
  ): {
    resumed: () => void;
    processor: () => void;
  } {
    const existing = this.#gateTraceTrackListeners.get(track);
    if (existing) return existing;
    const made = {
      resumed: (): void => {
        this.#gateTrace({
          at: "track.upstreamResumed",
          subject: `${track.source}/${track.sid ?? "no-sid"}`,
          subjectSource: track.source,
          subjectSid: track.sid ?? null,
          gate: [...this.#publishGate],
          gateSize: this.#publishGate.size,
          gateHeld: this.#gateHeld(),
          gateGen: this.#gateGen,
          connectGen: this.#connectGen,
          passes: this.#gateSweeper?.passes() ?? null,
          currentRoom: this.room() === room,
        });
      },
      processor: (): void => {
        this.#gateTrace({
          at: "track.processorUpdate",
          subject: `${track.source}/${track.sid ?? "no-sid"}`,
          subjectSource: track.source,
          subjectSid: track.sid ?? null,
          gate: [...this.#publishGate],
          gateSize: this.#publishGate.size,
          gateHeld: this.#gateHeld(),
          gateGen: this.#gateGen,
          connectGen: this.#connectGen,
          passes: this.#gateSweeper?.passes() ?? null,
          currentRoom: this.room() === room,
        });
      },
    };
    this.#gateTraceTrackListeners.set(track, made);
    return made;
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
  #micPipelineWants(): MicPipelineWants {
    return {
      denoise: this.#settings.noiseSupression === "enhanced",
      gainPercent: this.#settings.microphoneGain ?? 100,
      tonePreset: this.#settings.voiceTonePreset,
    };
  }

  /**
   * The mic re-sync at `LocalTrackPublished` (final audit F4, its trigger
   * set stated in full by the wave-4 completion audit F2). It runs on EVERY
   * microphone landing under an empty gate, not only the F4 case:
   *  - the F4 case proper: `#resumeGate` re-runs `#syncMicPipeline` at the
   *    gate's 1->0 edge, but if the mic was mid-republish at that edge --
   *    unpublished, its new sender not yet in `trackPublications` -- that
   *    re-run found no microphone publication, attached nothing, and no
   *    later edge would come: the D6 attach was lost for the call. The
   *    landing is the one place left that can run it;
   *  - a plain non-E2EE join: the gate is never held, so the attach now
   *    starts HERE, inside livekit's `LocalTrackPublished` emit (synchronous
   *    in `publishOrRepublishTrack`, right after `addTrackPublication`),
   *    ahead of the join `.then` in `connect()` that used to be the first
   *    attach;
   *  - a mic enabled after joining muted -- the born-paused handoff's open
   *    question 5 ("may never get the pipeline"), resolved: the attach runs
   *    at the landing, with no settings change or gate edge needed;
   *  - a signal-reconnect republish (and any other republish that lands
   *    under an empty gate: the E2EE flip, the declaration seam).
   * Attach-at-publish on a plain call is INTENDED, not a side effect: an
   * empty gate is exactly what D6 allows an attach under. Safe at this
   * point of the emit for two reasons. livekit's `publishOrRepublishTrack`
   * calls `track.setAudioContext(...)` before anything else it does, so
   * `LocalAudioTrack.setProcessor` cannot throw for a missing context
   * (2.15.13, its only synchronous guard). And `#syncMicPipeline` assigns
   * `#micPipeline = created` synchronously, before its awaited
   * `setProcessor`, so the join `.then` -- which resolves after this emit
   * returns -- finds `hasPipeline` and takes the `tune` branch: one
   * pipeline, never two. `micPipelineAction` still decides (tune in place
   * / none / attach / defer), and a held gate still defers to its own 1->0
   * edge.
   *
   * 🔴 NOT RUN LIVE. The banked leg's 6/6 landings were all under a HELD
   * gate (the `sweep` arm), so the plain-call and enable-after-muted
   * triggers above have been reasoned from the pinned source, not
   * observed. A leg is owed.
   */
  #syncMicPipelineIfLanded(room: Room, pub: { source: Track.Source }) {
    if (pub.source !== Track.Source.Microphone) return;
    if (this.#gateHeld() || this.room() !== room) return;
    this.#syncMicPipeline(room, this.#micPipelineWants());
  }

  /**
   * Reconcile the mic processor with the settings. LiveKit gives a track
   * ONE processor slot, so every mic stage lives in the same
   * `VoiceAudioPipeline` and this is the only place that attaches one.
   * All-default settings (browser/no noise filter, unity gain, shaper off)
   * run the raw capture with no Web Audio hop at all; the pipeline is
   * attached the first time any stage is wanted WHILE THE PUBLISH GATE IS
   * EMPTY, and then stays for the life of the track, tuned in place. Under
   * a held gate the attach is deferred (plan D6) -- nothing is stored, and
   * `#resumeGate` re-runs this sync at the gate's 1->0 edge, after its
   * awaited resume sweep, re-reading `#micPipelineWants()` then. The
   * decision is `micPipelineAction` (`micPipelinePolicy.ts`), pure so it is
   * spec- and mutation-reachable; only the wiring lives here.
   */
  #syncMicPipeline(room: Room, want: MicPipelineWants) {
    if (this.room() !== room) return;
    const pipeline = this.#micPipeline;
    const action = micPipelineAction({
      gateHeld: this.#gateHeld(),
      hasPipeline: !!pipeline,
      wantsDefault:
        !want.denoise &&
        want.gainPercent === 100 &&
        want.tonePreset === VOICE_TONE_PRESET_DEFAULT,
    });
    if (action === "tune") {
      // "tune" is the `hasPipeline` arm, so the slot is live here; the guard
      // is for the type only and never falls through to a second attach.
      if (!pipeline) return;
      pipeline.setGain(want.gainPercent);
      pipeline.setTonePreset(want.tonePreset).catch(() => undefined);
      // Asset load can fail (offline at first enable): denoise stays off and
      // audio keeps flowing — the same fallback as a join-time failure.
      pipeline.setDenoiseEnabled(want.denoise).catch(() => undefined);
      return;
    }
    if (action === "none") return;
    if (action === "defer") {
      // The attach below would `replaceTrack(processedTrack)` inside a held
      // gate -- the processor mirror window (plan D6). Nothing is stored:
      // `#resumeGate` re-runs this sync at the gate's 1->0 edge, after the
      // awaited resume sweep, re-reading `#micPipelineWants()` at fire time.
      return;
    }
    const track = room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.audioTrack;
    if (!(track instanceof LocalAudioTrack)) return;
    const created = new VoiceAudioPipeline(want);
    this.#micPipeline = created;
    // [F11] A `disconnect()` racing `init` bumps `#connectGen` and drops
    // `#micPipeline`, so an attach that resolves for a dead call must not
    // leave a processor on the stopped track: destroy what was built.
    const gen = this.#connectGen;
    track.setProcessor(created).then(
      () => {
        if (gen !== this.#connectGen) void created.destroy();
      },
      () => {
        // Attach threw post-publish: the raw track keeps flowing. Forget the
        // pipeline so the next settings change can try again.
        // A rejection can arrive after `init` succeeded (`replaceTrack` on a
        // closing transport), with the graph built; if the call is already
        // gone, nothing else will ever destroy it (livekit's `stop()` only
        // destroys a processor assigned at stop time). `#teardown` is
        // idempotent, so a double destroy is safe.
        if (gen !== this.#connectGen) void created.destroy();
        if (this.#micPipeline === created) this.#micPipeline = undefined;
      },
    );
  }

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
   * (Re)arm the delayed re-check that stands between a `canPlaybackAudio`
   * false edge and the "enable audio" banner.
   *
   * The false edge is not trustworthy as it lands: a reconnect re-attaches
   * every remote audio track, and that churn emits a transient false while
   * audio keeps audibly flowing (live leg 2026-08-16 — the banner appeared on
   * both sides of a Wi-Fi-drop reconnect, over audio each could hear). A
   * genuinely suspended AudioContext stays false until a user gesture, so
   * only showing the banner once the status has HELD false costs the real
   * case nothing but the hold. livekit emits the recovering true edge when
   * playback succeeds, which cancels the pending re-check outright (the
   * event handler's fast path) — this re-check is the slow path that decides
   * a false that never recovered was real.
   *
   * If the room is still (signal-)reconnecting when the re-check fires, it
   * re-arms instead of deciding: attach state is exactly what a reconnect is
   * in the middle of rebuilding, so a verdict now would repeat the original
   * bug on any reconnect longer than the hold.
   */
  #armAudioBlockedRecheck(room: Room) {
    clearTimeout(this.#audioBlockedRecheck);
    this.#audioBlockedRecheck = setTimeout(() => {
      this.#audioBlockedRecheck = undefined;
      // Room swap or teardown while we waited: verdicts about a dead room
      // are nobody's business (disconnect() also clears this timer, so this
      // is belt-and-braces for a swap racing the timeout).
      if (this.room() !== room) return;
      if (room.canPlaybackAudio) return;
      if (
        room.state === ConnectionState.Reconnecting ||
        room.state === ConnectionState.SignalReconnecting
      ) {
        this.#armAudioBlockedRecheck(room);
        return;
      }
      // Ground truth beats the SDK flag. Under `webAudioMix` every remote
      // voice plays through OUR AudioContext and the per-track <audio>
      // elements are muted decoys — yet livekit still calls `element.play()`
      // on each attach and flips `canPlaybackAudio` false when THAT rejects,
      // with no true edge until some later element happens to play. So a
      // peer joining (fresh attach) can leave the flag stuck false for the
      // rest of the call while audio is audibly flowing (live leg
      // 2026-08-16: banner on the remote side after a rejoin, both parties
      // already hearing each other). A running context means the graph the
      // audio actually travels through is live; only a suspended one is the
      // silence this banner exists for. Undefined context = mix kill-switch
      // off = element playback IS the audio path, so the flag stands alone.
      if (this.#callAudioContext?.state === "running") return;
      this.#setAudioPlaybackBlocked(true);
    }, AUDIO_BLOCKED_HOLD_MS);
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

  /**
   * The shared web-audio context of the CURRENT call, for consumers that
   * build nodes into livekit's remote-audio graph (the incoming-voice
   * normalizer). Not reactive — read it from an effect that already tracks
   * something call-scoped (the track list), which cannot be non-empty before
   * the context exists. Undefined when the mix kill-switch is off; callers
   * must treat that as "feature unavailable", never build their own context.
   */
  callAudioContext(): AudioContext | undefined {
    return this.#callAudioContext;
  }

  async toggleDeafen(fromMute?: boolean) {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      // Undeafening is the half that restores the microphone, and "are we
      // deafened right now" is the persisted flag — NOT
      // `!isMicrophoneEnabled`. In voice-activity mode that is merely whether
      // the gate happens to be open this instant, so pressing DEAFEN during a
      // pause between words used to switch the microphone on.
      const undeafening = this.#settings.deafen;
      // 🔴 The AFK term belongs HERE too, not only in `toggleMute`. Pressing
      // Unmute while deafened does not run `toggleMute`'s body at all — it
      // delegates straight to this method with `fromMute`, which would have
      // walked around the guard and re-armed the microphone in the AFK
      // channel. Undeafening itself is never refused: AFK revokes publish,
      // never subscribe, so there is no reason to keep anyone from hearing.
      const wantMic =
        undeafening &&
        (this.#settings.micOn || !!fromMute) &&
        !publishToggleRefusal({
          enabling: true,
          isAfkChannel: this.isAfkChannel,
          permitted: this.speakingPermission,
        });
      await this.#setMicEnabled(room, wantMic);

      this.#settings.deafen = !undeafening;
      if (fromMute) {
        // Only the ON direction is reconciled against the real track: an
        // unmute that could not capture must not read as live, but a mute
        // always takes.
        this.#settings.micOn = wantMic
          ? room.localParticipant.isMicrophoneEnabled
          : false;
      }
      if (this.#settings.deafen) {
        this.sound.playSound("deafen");
      } else {
        this.sound.playSound("undeafen");
      }
    } catch (e) {
      this.#captureFailed(e, "microphone");
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
      // Toggle the user's INTENT, never the live track. Voice activity opens
      // and closes the published microphone from tick to tick, so
      // `!isMicrophoneEnabled` made this button mean whatever the gate
      // happened to be doing at the moment of the press — hit MUTE during a
      // pause between words and it turned the microphone ON.
      const want = !this.#settings.micOn;
      // 🔴 The AFK / permission guard. Without it the whole AFK feature was
      // defeated by one click: the join handler muted you, and the very next
      // Unmute press put you back on the wire. Only the ENABLING direction is
      // refused — a mute must always take.
      const refusal = publishToggleRefusal({
        enabling: want,
        isAfkChannel: this.isAfkChannel,
        permitted: this.speakingPermission,
      });
      if (refusal) {
        this.onErr(new Error(this.#publishRefusalText(refusal, "microphone")));
        return;
      }
      await this.#setMicEnabled(room, want);

      // Muting always takes. Unmuting can fail (permission denied, no
      // capture device), and a microphone that never came up must not be
      // shown as live — so only the ON direction is reconciled.
      this.#settings.micOn = want
        ? room.localParticipant.isMicrophoneEnabled
        : false;

      if (this.#settings.micOn) {
        this.sound.playSound("unmute");
      } else {
        this.sound.playSound("mute");
      }
    } catch (e) {
      this.#captureFailed(e, "microphone");
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

      // AFK, or a missing `Video` bit. Turning the camera OFF is never
      // refused, so a designation change mid-call cannot strand a live
      // camera behind a dead button.
      const refusal = publishToggleRefusal({
        enabling,
        isAfkChannel: this.isAfkChannel,
        permitted: this.videoPermission,
      });
      if (refusal) {
        this.onErr(new Error(this.#publishRefusalText(refusal, "camera")));
        return;
      }

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
      this.#captureFailed(e, "camera");
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
        // Record only the share audio the user chose to hear (plan decision
        // A). A getter, read at each decision, so a Watch or Stop watching
        // mid-recording applies at once rather than a set captured here.
        () => untrack(this.watchedShares),
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

  // --- AFK idle watch (Wave 5b-2) ------------------------------------

  /**
   * One discrete sign of life (D-5b2-7): the local speaking edge, a PTT down,
   * a keybind, input in the visible window. Stamps the monotonic clock.
   *
   * 🔴 With a claim standing, the tick runs AT ONCE rather than at the next
   * interval. The claim is only ever sent at the timeout, so a standing one
   * is already due: every second it outlives the user's return is a second in
   * which the sweep can move someone who is at the keyboard. Untracked,
   * because this can be reached from a keybind dispatched inside a
   * computation, and the tick reads signals.
   */
  #noteIdleActivity(): void {
    this.#idleLastActivityAt = performance.now();
    if (this.#idlePosted) untrack(() => this.#idleKick?.());
  }

  /**
   * Start watching THIS connection for idleness (D-5b2-7). Called once per
   * connection from the room's `connected` listener, with that attempt's
   * `gen`. The join itself counts as activity, so the idle clock starts at
   * the connect, never earlier.
   *
   * The speaking EDGE is recorded here; continuous speech is read per tick off
   * `isSpeaking` (I-7). Only the SFU writes the local `isSpeaking`, and it is
   * false while muted or with the PTT key up, which is the definition: a
   * self-muted user goes idle on the same timer as anyone else.
   */
  #startIdleWatch(room: Room, channel: Channel, gen: number): void {
    this.#stopIdleWatch();
    this.#idleLastActivityAt = performance.now();
    const onSpeakers = (speakers: { identity: string }[]) => {
      if (speakers.some((p) => p.identity === room.localParticipant.identity))
        this.#noteIdleActivity();
    };
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    // An SDK reconnect restarts the idle clock (S6-R1, FE-FU-1). A FULL
    // reconnect (`Reconnecting` … `Reconnected`) joins the SFU as a new
    // participant, so the server's `joined_at` moves forward, and the server
    // now refuses any claim whose `idle_for` exceeds `now - joined_at` by more
    // than its slack (`AFK_CLAIM_JOIN_SLACK_MS`, `voice/afk_idle.rs`). A
    // reconnect that completes between two ticks is never seen by `#idleTick`
    // as "not connected", so without this the old clock would outlive the new
    // `joined_at` and every claim would be refused: an idle user would never
    // be moved until they next did something.
    //
    // `Reconnected` is the load-bearing one: it fires after the new
    // participant has joined, so the restarted clock is never older than the
    // new `joined_at`. `Reconnecting` marks the start of the same outage.
    // `SignalReconnecting` is deliberately NOT heard: it is a signal-only
    // resume that keeps the same participant and `joined_at`, and when it
    // succeeds the SDK emits `Reconnected` anyway, and when it escalates to a
    // full reconnect the SDK emits `Reconnecting`.
    //
    // Safe direction: a restart can only delay a move, never hasten one. A
    // resume that did NOT change `joined_at` still fires `Reconnected` and so
    // delays the move by up to one timeout. A standing claim is withdrawn by
    // the next ordinary tick (`idleStep`: posted and under the threshold ->
    // `clear-idle`), so this stamps the clock and nothing else. It does not go
    // through `#noteIdleActivity`, which would also kick a tick at once.
    const onReconnect = () => {
      this.#idleLastActivityAt = performance.now();
    };
    room.on(RoomEvent.Reconnecting, onReconnect);
    room.on(RoomEvent.Reconnected, onReconnect);
    this.#idleUnlistenRoom = () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
      room.off(RoomEvent.Reconnecting, onReconnect);
      room.off(RoomEvent.Reconnected, onReconnect);
    };
    const tick = () => this.#idleTick(room, channel, gen);
    this.#idleKick = tick;
    this.#idleTimer = setInterval(tick, IDLE_TICK_MS);
  }

  /**
   * Stop the idle watch and forget everything it held, latch included — the
   * latch is per connection, and the next connection starts clean.
   */
  #stopIdleWatch(): void {
    if (this.#idleTimer !== undefined) clearInterval(this.#idleTimer);
    this.#idleTimer = undefined;
    this.#idleUnlistenRoom?.();
    this.#idleUnlistenRoom = undefined;
    this.#idleKick = undefined;
    this.#idleLastTickAt = undefined;
    this.#idlePosted = false;
    this.#idleLastPostAt = undefined;
    this.#idlePutInFlight = false;
    this.#idleFailures = 0;
    this.#idleNextPutAt = undefined;
    this.#idleLatched = false;
    this.#idleConfigKey = undefined;
  }

  /**
   * One idle tick: gather the world, let `idleStep` decide, act on it.
   *
   * 🔴 Every guard below exists because stopping the watch where the call
   * ends is not enough (I-6). An SFU drop goes `RECONNECTING` and into
   * `#autoRejoin` without `disconnect()`, and an SDK reconnect never changes
   * `state()` at all. So the tick proves, each time, that it still belongs to
   * the call (`gen`) and that the call is up in all three places — the state
   * machine, the Room this watch was started for, and the Room's own
   * transport. Anything less is "not connected": the idle clock restarts and
   * a standing claim is withdrawn.
   *
   * The timeout is read fresh every tick and passed through as SECONDS:
   * `idlePolicy.ts` is the only place it becomes milliseconds.
   */
  #idleTick(room: Room, channel: Channel, gen: number): void {
    if (gen !== this.#connectGen) return;
    const now = performance.now();
    const world: IdleWorld = {
      now,
      lastTickAt: this.#idleLastTickAt,
      lastActivityAt: this.#idleLastActivityAt,
      continuousActive:
        room.localParticipant.isSpeaking ||
        this.#pttHeld ||
        this.screenshare() ||
        this.video() ||
        this.watch.session() !== undefined,
      connected:
        this.state() === "CONNECTED" &&
        this.room() === room &&
        room.state === ConnectionState.Connected,
      isAfkChannel: this.isAfkChannel,
      afkChannelId: this.channel()?.server?.afkChannelId,
      afkTimeoutSeconds: this.channel()?.server?.afkTimeout,
      posted: this.#idlePosted,
      lastPostAt: this.#idleLastPostAt,
    };

    // The latch and the failure count answer for ONE configuration: a refusal
    // can depend on which channel is the AFK channel and on whether a timeout
    // is set, so a change to either earns a fresh start (P2-6).
    const configKey = `${world.afkChannelId ?? ""}|${world.afkTimeoutSeconds ?? ""}`;
    if (configKey !== this.#idleConfigKey) {
      this.#idleConfigKey = configKey;
      this.#idleLatched = false;
      this.#idleFailures = 0;
      this.#idleNextPutAt = undefined;
    }

    const step = idleStep(world);
    this.#idleLastTickAt = now;
    this.#idleLastActivityAt = step.lastActivityAt;

    if (step.action === "post-idle" || step.action === "refresh-idle") {
      // Only the CONNECTED session posts (I-13). `idleStep` already refuses to
      // claim when not connected; restated because a claim from a session
      // that is not in the call is the one outcome this must never produce.
      if (!world.connected) return;
      if (this.#idleLatched || this.#idlePutInFlight) return;
      if (this.#idleNextPutAt !== undefined && now < this.#idleNextPutAt)
        return;
      void this.#postAfkIdle(channel, true, gen);
    } else if (step.action === "clear-idle") {
      // Dropped locally BEFORE the request, so the next tick does not send a
      // second DELETE on top of this one's retries; a lost DELETE is covered
      // by those retries and, past them, by the claim's server TTL.
      this.#idlePosted = false;
      this.#idleLastPostAt = undefined;
      void this.#postAfkIdle(channel, false, gen);
    }
  }

  /**
   * The idle beacon: `PUT /channels/{id}/afk_idle` with `{ idle_for }` in
   * whole SECONDS (a claim, or a refresh of one — the server tells them
   * apart), or `DELETE` to withdraw it. Raw fetch, for `#claimRecording`'s
   * reason: the generated client sends `{}` for routes it does not know, and a
   * PUT that silently lost its body would claim nothing.
   *
   * CLIENT-CLAIMED, and grants nothing: the server stamps the time itself,
   * clamps it to the join, and applies its own timeout.
   *
   * Every await is followed by the `gen` test — a response for a call that
   * has since ended or been replaced must not touch the next call's state.
   *
   * A failed PUT goes through `idleFailureDisposition` (P2-6): `IsBot`,
   * `NotAVoiceChannel` and `NotOwner` stop this connection posting. `NotOwner`
   * is the 403 for a session that does not own the voice record (a foreign
   * session, or a call joined before the record existed), and it stays true
   * until that session rejoins. A 403 or 401 here can never sign the user
   * out: this is a raw `fetch`, outside the client whose session handling
   * does that. Anything else, a 429 or a network failure included, waits for
   * the next refresh, and a run of `IDLE_MAX_CONSECUTIVE_FAILURES` stops it
   * too. The latch only ever stops PUTs. A failed DELETE is the unsafe one (a
   * standing claim over an active user), so it is retried, boundedly, until a
   * newer claim supersedes it.
   *
   * 🔴 "Failed" means the server ANSWERED with a 4xx. A PUT that threw, timed
   * out, or got a 5xx has an unknown outcome — delta may well have applied it
   * before the response was lost or mangled — and is treated as having LANDED
   * (A1, R-2): posted, so the user's return sends the DELETE. See the arm
   * below for why.
   */
  async #postAfkIdle(
    channel: Channel,
    idle: boolean,
    gen: number,
  ): Promise<void> {
    const attempts = idle ? 1 : AFK_IDLE_CLEAR_RETRY_DELAYS_MS.length + 1;
    if (idle) this.#idlePutInFlight = true;
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, AFK_IDLE_CLEAR_RETRY_DELAYS_MS[attempt - 1]),
          );
          // A claim posted since then is newer than this withdrawal.
          if (gen !== this.#connectGen || this.#idlePosted) return;
        }
        const client = this.getClient();
        if (!client) return;
        const [header, value] = client.authenticationHeader;
        const activityAtSend = this.#idleLastActivityAt;
        const abort = new AbortController();
        const timeout = setTimeout(
          () => abort.abort(),
          AFK_IDLE_REQUEST_TIMEOUT_MS,
        );
        // 🔴 The timer stays armed until the request is FULLY settled — the
        // error body's read included (R-3) — and is cleared only in the
        // `finally` below. The abort bounds that read too: the fetch's
        // `signal` governs the response BODY as well as the request, so an
        // abort after the headers arrived makes `.json()` reject, and a body
        // that stalls can hold `#idlePutInFlight` no longer than the timeout.
        try {
          // `undefined` after this block means the request threw or was
          // aborted: no answer from the server, so no knowledge of what it did.
          let response: Response | undefined;
          try {
            response = await fetch(
              `${client.options.baseURL}/channels/${channel.id}/afk_idle`,
              {
                method: idle ? "PUT" : "DELETE",
                headers: idle
                  ? { [header]: value, "Content-Type": "application/json" }
                  : { [header]: value },
                body: idle
                  ? JSON.stringify({
                      idle_for: idleForSeconds(
                        performance.now(),
                        activityAtSend,
                      ),
                    })
                  : undefined,
                signal: abort.signal,
              },
            );
          } catch {
            response = undefined;
          }
          if (gen !== this.#connectGen) return;

          if (response?.ok) {
            if (idle) {
              this.#idlePosted = true;
              this.#idleLastPostAt = performance.now();
              this.#idleFailures = 0;
              this.#idleNextPutAt = undefined;
              // The user came back while the claim was in flight: withdraw it
              // now, not a tick from now (see `#noteIdleActivity`).
              if (this.#idleLastActivityAt !== activityAtSend)
                untrack(() => this.#idleKick?.());
            }
            return;
          }

          if (idle) {
            // 🔴 A1 — an UNKNOWN outcome counts as a claim that LANDED. The
            // unknown set is: the request threw, it was aborted, or the answer
            // was a 5xx (R-2) — a proxy's 502/504, or a delta 500 raised after
            // the SET had already landed, says nothing about the claim. The
            // two wrong guesses are not symmetric. Assuming it landed when it
            // did not costs one DELETE on the user's return, which the server
            // answers 204 whether or not a claim exists. Assuming it did not
            // land when it did leaves a due claim standing with nothing to
            // ever withdraw it: the user comes back, `idleStep` sees nothing
            // posted, and the sweep moves an ACTIVE user within one of its
            // ticks. A lost response is likeliest exactly when a phone wakes
            // from sleep, which is also when its user has just come back. A
            // refresh whose outcome is unknown is the same case. Recorded
            // synchronously, before any await, so no tick can run between the
            // loss and the record.
            const outcomeUnknown =
              response === undefined || response.status >= 500;
            if (outcomeUnknown) {
              this.#idlePosted = true;
              this.#idleLastPostAt = performance.now();
            }
            // A 4xx is the server's definite answer: the claim did not land,
            // and its type decides latch or back-off. An unknown outcome still
            // counts toward the latch — it is the "network failure" case of
            // P2-6 — and its type, when it has one, is read the same way. An
            // aborted or failed body read reads as no type at all.
            const errorType = await response
              ?.clone()
              .json()
              .then((body: { type?: string }) => body?.type)
              .catch(() => undefined);
            if (gen !== this.#connectGen) return;
            this.#idleFailures++;
            if (
              idleFailureDisposition(errorType, this.#idleFailures) === "latch"
            ) {
              this.#idleLatched = true;
            } else {
              this.#idleNextPutAt = performance.now() + IDLE_REFRESH_MS;
            }
            // As on success: activity during the unanswered request means the
            // claim, if it landed, is already stale — withdraw it now.
            if (outcomeUnknown && this.#idleLastActivityAt !== activityAtSend)
              untrack(() => this.#idleKick?.());
            return;
          }
        } finally {
          clearTimeout(timeout);
        }
      }
      console.warn(
        "[rtc] could not withdraw the AFK idle claim; it lapses with its server TTL",
      );
    } finally {
      if (idle && gen === this.#connectGen) this.#idlePutInFlight = false;
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

    // 🔴 AFK / `Video` guard, placed ABOVE the Android branch on purpose. The
    // Android screen leg is a second SFU participant that mints its own grant
    // and hard-codes both screen sources, so a guard inside the web path
    // would leave the phone able to share from the AFK channel. Screen share
    // was never blocked by the old name-keyed implementation at all.
    //
    // The leg's own state decides "enabling" there, because the local
    // participant's `screenshare()` stays false for the whole native share.
    // Stopping is never refused, on either surface.
    const enablingShare = nativeScreenShareAvailable()
      ? this.#androidLegStartingFor === undefined && !this.#androidLeg?.active()
      : !this.screenshare();
    const shareRefusal = publishToggleRefusal({
      enabling: enablingShare,
      isAfkChannel: this.isAfkChannel,
      permitted: this.videoPermission,
    });
    if (shareRefusal) {
      this.onErr(
        new Error(this.#publishRefusalText(shareRefusal, "screenshare")),
      );
      return;
    }

    // Native Android branch (screen-leg plan §7.2) — returns BEFORE the web
    // path so the three `#setScreenshare(isScreenShareEnabled)` reads below
    // never fight it: the leg is a SECOND SFU participant, so the local
    // participant's own screen-share state stays false for the whole share.
    if (nativeScreenShareAvailable()) {
      return this.#toggleAndroidScreenShare(room);
    }

    if (this.screenshare()) {
      // Doom any in-flight native audio capture first (F2), then tear the
      // native session down — setScreenShareEnabled(false) auto-unpublishes
      // the ScreenShareAudio publication and stops its track, but the
      // virtual PipeWire device is the shell's and needs its own stop.
      // No-op off the capable shell.
      this.#disarmScreenAudioGuard();
      this.#screenAudioGen++;
      void stopScreenAudio(this.#screenAudioSessionId);
      // 🔴 AWAITED, and BEFORE the unpublish. On Windows the native session,
      // the AudioContext and the worklet are ours and
      // `setScreenShareEnabled(false)` releases none of them — its
      // auto-unpublish of ScreenShareAudio stops the WRAPPED destination track
      // and nothing else. The teardown is internally bounded (two 2 s settles),
      // so this cannot wedge the stop branch. No-op on every other surface.
      await teardownWinScreenAudio();
      await room.localParticipant.setScreenShareEnabled(false);

      // The quality dialog is asking about a share that no longer exists, so
      // it goes with it. Without this it outlived every stop — including the
      // `ended` stop when the shared window closes — and the next start
      // opened another one on top of it. That is how a user who could not see
      // the dialogs at all (they were behind a fullscreen call — see
      // `leaveFullscreenForModal` in components/modal) stacked one per
      // attempt, 2026-09-10.
      //
      // NOT the source picker: its `onClose` is what answers
      // `window.native.screenPickerCallback`, and closing it from here would
      // bypass that and leave the shell's picker waiting forever. It also
      // cannot be open on this path — a share it has not answered yet has not
      // published, so `screenshare()` is false and this branch is unreachable.
      this.#closeModalsOfType("screen_share_settings");

      // The track's stop() already tore the processor down; just drop the
      // handle so the next share starts from a clean slate.
      this.#screenShield = undefined;

      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

      this.sound.playSound("streamEnd");
    } else {
      // A start is only observable in `screenshare()` once getDisplayMedia
      // has resolved, and the user is staring at the OS picker for all of
      // that. A second press inside that window used to land here again:
      // livekit dedupes the PUBLICATION (a pending publish of the same source
      // is awaited and returned), but everything this method does AROUND the
      // publish then ran a second time against that one track — another
      // privacy-shield processor, another `ended` handler, another quality
      // dialog. Guarding the START only: a press that arrives after the track
      // is up takes the stop branch above, which must stay reachable.
      if (this.#screenshareStarting) return;

      // Mint the native screen-audio staleness token for this attempt (F2)
      // — a second toggle, cancel, or disconnect bumps it and dooms any
      // capture still in flight below.
      const generation = ++this.#screenAudioGen;
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
        // Set inside the try so that a throw can never wedge screen share for
        // the rest of the call; nothing can interleave between the check
        // above and here, as there is no await in between.
        this.#screenshareStarting = true;

        // Bitrate/framerate for the publish encoding come from the initial
        // (stored) quality. If the picker changes the quality afterwards, the
        // `callback` below re-applies the encoding to the new tier — a bare
        // resolution swap via applyConstraints does NOT touch the publish
        // bitrate cap, so we update the sender directly there.
        const initialQuality =
          qualities[this.#settings.screenShareQuality || "low"] ||
          qualities.low!;

        // 🔴 TWO questions, deliberately answered separately, and this one is
        // SYNCHRONOUS.
        //
        // (1) Should the picker's "Also share system audio" checkbox be gone?
        //     That is a CAPABILITY question and never a preference: a capable
        //     user with the setting off would otherwise still see the
        //     checkbox, tick it, and resurrect the measured-broken browser
        //     loopback on the exact shell this feature fixes.
        // (2) Can the native capture actually run? That needs the shell's
        //     probe, and is asked separately at the call site below.
        //
        // Fusing them is a silent regression in the direction of the original
        // bug: an unsettled probe answering `false` would not merely skip the
        // native capture, it would hand the checkbox back. Keyed on what is
        // knowable without waiting (build flag, platform, Tauri bridge), an
        // incapable shell therefore gives a SILENT share — the acceptable
        // degrade — and never a loopback one. This is also the platform
        // discriminator for the branch at the call site, so it is read ONCE
        // and the two answers cannot disagree within a share.
        const suppressPickerAudio = winScreenAudioPickerSuppressed();

        const localTrack = await room.localParticipant.setScreenShareEnabled(
          true,
          {
            resolution: initialQuality.resolution,
            // Keep the call itself out of "share system audio". System-audio
            // loopback captures everything the machine plays — including the
            // other participants' voices coming out of this client — so a
            // plain `audio: true` share re-broadcast the call to everyone in
            // it (self-echo, feedback with open mics). `restrictOwnAudio`
            // (Chrome/Edge/WebView2 141+) filters audio produced by this
            // document out of the capture; engines that predate it ignore
            // the unknown constraint and behave as before. livekit passes
            // this object verbatim into getDisplayMedia
            // (screenCaptureToDisplayMediaStreamOptions), but its
            // AudioCaptureOptions type lags the spec, hence the cast.
            //
            // 🔴 On the SUPPRESSED (Windows, lit, Tauri) path this is `false`:
            // the shell captures the system mix natively, excluding our own
            // WebView2 process subtree, so there is nothing for the browser to
            // be asked for. livekit passes the value straight into
            // getDisplayMedia (`audio: options.audio ?? false`), so `false`
            // REMOVES the checkbox rather than merely unticking it. Everywhere
            // else — web, Android, Linux, macOS — this stays exactly as it
            // was.
            audio: suppressPickerAudio
              ? false
              : ({
                  restrictOwnAudio: true,
                } as AudioCaptureOptions),
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

        let screenAudioTrack = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio,
        );
        // The audio TRACK, re-captured after each `screenAudioTrack`
        // assignment. Its absence is a real state (no audio was captured),
        // so it is the one object on this path an optional chain may target.
        let audioTrack: LocalTrack | undefined = screenAudioTrack?.track;

        this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

        if (localTrack) {
          // The share TRACK, captured before any await: every pause/resume
          // on this path is issued over it, never over `localTrack`. A
          // republish (the E2EE flip, the signal reconnect, the declaration
          // seam) runs `publication.setTrack(undefined)` on THIS publication
          // and builds a new one over the SAME track, so a later
          // `localTrack.pauseUpstream()` / `.resumeUpstream()` is
          // `this.track?.…()` over `undefined` -- a silent no-op. Fail-loud
          // narrowing, inside the try so `onErr` surfaces it: livekit types
          // the field optional, and an optional chain here would be exactly
          // that no-op class. `videoTrack`, not `track`: the same object for
          // a ScreenShare publication (`isVideoTrack(this.track) ? this.track
          // : undefined`), typed `LocalVideoTrack`, so every video read below
          // -- hint, settings, shield, encoding -- goes through it instead of
          // a fresh read of the publication's getter, which a republish turns
          // `undefined` (the publication's track is cleared) and which then
          // silently skipped whatever it guarded.
          const shareTrack = localTrack.videoTrack;
          if (!shareTrack)
            throw new Error("screen share published without a video track");
          // The consent decision, made HERE (its inputs are all in hand) so
          // the hold is set before the first await below: a 1->0 edge
          // landing during `setProcessor(shield)` or `screenAudioSupported`
          // would otherwise resume a born-paused share ahead of the
          // ask-modal. Byte-for-byte the modal condition further down.
          const consentPending =
            !screenPickerQualityName &&
            this.#settings.screenShareQualityAsk &&
            Object.keys(qualities).length > 1;
          if (consentPending) this.#consentHeld.add(shareTrack);

          // Tell the encoder what to protect BEFORE anything else. `callback`
          // below sets this too, but it only runs when the picker returned a
          // quality or the ask-dialog is on — a share started from a stored
          // quality would otherwise publish with the browser's default hint,
          // which treats screen content as motion and spends the bitrate on
          // holding framerate instead of keeping text legible.
          shareTrack.mediaStreamTrack.contentHint = initialQuality.contentHint;

          // Privacy shield: pixelates the OS-toast corner when something
          // pops in, before frames reach the encoder (and therefore before
          // E2EE/SFU — the shielded frame is the only frame that exists off
          // this machine). Monitor shares only: a window share does not
          // capture other apps' toasts, and its corner is ordinary content
          // that would false-trigger. Attach failure is logged and the share
          // continues RAW — the user chose to share; silently blocking the
          // share would be the worse surprise. The gate's
          // TrackProcessorUpdate handler squares this with pause/resume.
          const displaySurface = (
            shareTrack.mediaStreamTrack.getSettings() as MediaTrackSettings & {
              displaySurface?: string;
            }
          ).displaySurface;
          // 🔴 ENTIRE SCREEN ONLY, and computed HERE — off the RAW track,
          // before the shield below replaces it.
          //
          // The Windows native capture is the whole system mix minus our own
          // process subtree, so publishing it for a WINDOW or TAB share would
          // send the user's music, their notifications and every other
          // application to the call while they believe they are sharing one
          // window — something Chromium never offered for a window share and
          // nothing in the UI would tell them.
          //
          // `undefined` counts as a monitor share: that is what the privacy
          // shield already assumes, and on this shell getDisplayMedia does
          // report the surface.
          //
          // 🔴 One value, read once, used by BOTH the publish decision below
          // and the settings modal. The modal cannot re-derive it: a
          // `LocalTrack`'s `mediaStreamTrack` getter returns
          // `processor?.processedTrack ?? _mediaStreamTrack`, and the shield
          // is attached and awaited before that modal opens, so by then the
          // surface reads as a canvas capture stream with no `displaySurface`
          // at all. It would land on the `undefined ⇒ monitor` fallback and be
          // right only by the coincidence that the shield attaches on monitor
          // shares — which ends the moment a window share can carry audio.
          const entireScreen =
            displaySurface === "monitor" || displaySurface === undefined;
          if (this.#settings.screenShareShield) {
            const surface = displaySurface;
            if (surface === "monitor" || surface === undefined) {
              try {
                const shield = new ScreenShieldProcessor();
                await shareTrack.setProcessor(shield);
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

          // Linux shell (screenshare-audio design §6): getDisplayMedia
          // returned no audio track — capture the shell's virtual PipeWire
          // source instead, when the flag + shell surface + probe allow it.
          // When the ask-modal will open, capture BEFORE it opens and
          // publish MUTED; the confirm callback unmutes (F8/E3). Failure
          // degrades to a no-audio share, never a failed share. When the
          // in-app picker ran (Windows/EL3), ITS audio answer governs, not
          // the stored setting — the two can disagree in both directions.
          // (`consentPending` itself is decided at the capture above.)
          const wantsAudio =
            consentPending ||
            (screenPickerQualityName !== undefined
              ? screenPickerAudio === true
              : this.#settings.screenShareAudio);
          // Slice 2: set when the shell could not attribute a shared
          // WINDOW to exactly one application, so the user has to say
          // which app's sound to send. Nothing is captured on this path
          // until they do — a silent wrong guess would broadcast an app
          // they never chose (design §9's privacy rule).
          let needsAudioChoice = false;
          // 🔴 THE PLATFORM BRANCH. The two native screen-audio bodies are
          // mutually exclusive mechanisms behind identically-named exports, so
          // exactly one of them may be consulted per share and the choice is
          // made here, at the one call site, on the SYNCHRONOUS suppression
          // answer computed above.
          //
          // `winScreenAudioPickerSuppressed()` is true only for a lit build on
          // a Windows Tauri shell, which is precisely the set of hosts where
          // `window.slogaShell.screenAudio` (the Electron/PipeWire surface the
          // Linux body probes) does not exist. Linux, macOS, Android and web
          // take the `else` and reach the byte-identical Linux path below
          // unchanged — including its `screenAudioSupported(true)` refresh,
          // which is never called on the Windows arm.
          if (suppressPickerAudio) {
            // `entireScreen` is computed once beside `displaySurface` above,
            // off the raw track — see its note there for why it cannot be
            // re-derived later, and why the settings modal is handed the same
            // value rather than asking the track again.
            //
            // The browser checkbox is GONE on this path, so the native capture
            // is the only source of system audio there is — and `wantsAudio`
            // (the stored setting, or the picker's answer, or a pending
            // consent) is the whole of the user's consent to send it.
            // 🔴 The SYNCHRONOUS conditions are hoisted into their own block so
            // the consent pause below lands BEFORE the first await, not after
            // it.
            if (!screenAudioTrack && wantsAudio && entireScreen) {
              // The capture path awaits a Tauri IPC round trip plus an
              // AudioWorklet module fetch — do not let the just-published
              // video stream to the call for that long before the user has
              // answered the ask-modal: pause it now; the modal path pauses
              // again idempotently below. Same rule and same shape as the
              // Linux arm's pause; the awaits differ, the exposure does not.
              // Safe even when the probe then says no: `consentPending` is
              // exactly the condition under which the ask-modal opens, and its
              // callback is what resumes the upstream. The hold re-add is
              // idempotent too (set at the capture above).
              if (consentPending) {
                this.#consentHeld.add(shareTrack);
                shareTrack.pauseUpstream();
              }
              // Probe-bounded, and answers "no" when unsettled. Safe HERE
              // precisely because the checkbox question was answered
              // separately and synchronously above: the degrade is a silent
              // share, never a loopback one.
              //
              // 🔴 Both of these awaits are BOUNDED all the way down, and the
              // paused upstream above is why — the same rule the Linux arm
              // states below. The upstream is resumed by the ask-modal's
              // callback, and that modal does not open until this block
              // returns, so a shell call that never settled would strand
              // viewers on a frozen tile with no modal, no error and no way
              // out. `winScreenAudioSupported` races the probe at 200 ms;
              // every await inside the capture path has its own bound and its
              // own spec (`screenAudioNativeWin.test.ts`, "The STARTING window
              // is bounded at EVERY await"). A wedged shell therefore costs a
              // silent share, never the video.
              if (await winScreenAudioSupported()) {
                screenAudioTrack =
                  (await this.#publishWinScreenAudio(
                    room,
                    generation,
                    consentPending,
                  )) ?? screenAudioTrack;
                audioTrack = screenAudioTrack?.track;
              }
            }
          } else if (
            !screenAudioTrack &&
            wantsAudio &&
            (await screenAudioSupported(true))
          ) {
            // The capture path awaits seconds (IPC, enumerate, gUM) — do
            // not let the just-published video stream to the call for that
            // long before the user has answered the ask-modal: pause it
            // now; the modal path pauses again idempotently below. The
            // hold re-add is idempotent too (set at the capture above).
            if (consentPending) {
              this.#consentHeld.add(shareTrack);
              shareTrack.pauseUpstream();
            }
            // Bounded inside resolveScreenAudioTarget: the upstream is
            // already paused here, so a shell call that never settled
            // would strand viewers on a frozen tile with no way out.
            const plan = await resolveScreenAudioTarget(displaySurface);
            if (this.#screenAudioStale(generation, room)) return;
            if (plan.mode === "ask") {
              // Leg evidence (L9-L11): the reason distinguishes an opaque
              // Wayland portal from a lying pid from a two-app tree, and
              // all three look identical from the UI.
              console.info(`screen audio needs a chooser: ${plan.reason}`);
              needsAudioChoice = true;
            } else if (plan.mode === "skip") {
              // This shell cannot say what the share covers and cannot be
              // narrowed either, so there is no safe capture and no
              // question worth asking. Silent share, logged.
              console.info(`screen audio skipped: ${plan.reason}`);
            } else {
              screenAudioTrack = await this.#publishNativeScreenAudio(
                room,
                generation,
                consentPending,
                plan,
              );
              audioTrack = screenAudioTrack?.track;
            }
          }

          const callback = async (
            qualityName: ScreenShareQualityName,
            audio: boolean,
          ) => {
            const quality = qualities[qualityName] || qualities.low!;

            // Through the captured `shareTrack`, never the publication getter:
            // after a republish that getter is `undefined` (the publication's
            // track was cleared) and the guard that used to wrap this body
            // silently skipped ALL of it -- the constraints, the hint, the
            // encoding, AND the audio-untick unpublish below, so declined
            // system audio kept streaming.
            await shareTrack.mediaStreamTrack.applyConstraints({
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
            shareTrack.mediaStreamTrack.contentHint = quality.contentHint;
            // Re-cap the publish bitrate to the picked tier. applyConstraints
            // above only changes the captured resolution/framerate; the RTP
            // sender keeps whatever maxBitrate was set at publish time, so a
            // 720p->1440p switch would otherwise stay starved (or, going the
            // other way, keep an over-large cap). Best-effort — a failure
            // just leaves the publish-time cap in place.
            await this.#applyScreenShareEncoding(shareTrack, quality);
            // Tiers disagree about what to protect, so this has to move with
            // the tier rather than being set once at publish. Best-effort:
            // a failure just leaves the previous preference in place.
            await shareTrack
              .setDegradationPreference(quality.degradationPreference)
              .catch(() => undefined);
            if (!audio && audioTrack) {
              // 🔴 Branch on PROVENANCE, not on liveness. `suppressPickerAudio`
              // is the same platform decision that chose the capture path for
              // this share, so a publication held here under it can only have
              // come from `#publishWinScreenAudio` — the browser checkbox was
              // removed, so gUM produced no audio track to publish. Asking
              // `winScreenAudioActive()` instead would be asking whether the
              // module is live RIGHT NOW: if it self-tore-down between the
              // publish and this untick (a death, or the E2EE assertion) while
              // `screenAudioTrack` is still held, that reads false and the
              // Linux unpublish/`stopScreenAudio` pair would run against a
              // Windows publication. Correct only by coincidence today.
              if (suppressPickerAudio) {
                // Windows: the module owns the unpublish (its host closure
                // resolves the publication BY TRACK, which is the only
                // lookup that survives the publish window and
                // `republishAllTracks`), and it also owns the AudioContext
                // and the worklet that a bare unpublish would leak.
                // Idempotent and silent when the session is already gone.
                await teardownWinScreenAudio();
              } else {
                room.localParticipant.unpublishTrack(audioTrack);
              }
              // The native PipeWire session (Linux) dies with the untick;
              // no-op on every other surface.
              void stopScreenAudio(this.#screenAudioSessionId);
            }
            this.sound.playSound("streamStart");
          };

          if (screenPickerQualityName) {
            callback(
              screenPickerQualityName || "low",
              screenPickerAudio || false,
            );
          } else if (consentPending) {
            // ONE decision: the hoisted `consentPending` the hold was set
            // on at the capture. Re-reading the setting here, four awaits
            // later, let a flip in another window run the stored callback
            // over a share still held -- paused for the whole call with
            // nothing left to release it.
            // Idempotent re-adds (the share was held at the capture); the
            // audio track joins the hold here, where it first exists.
            this.#consentHeld.add(shareTrack);
            if (audioTrack) this.#consentHeld.add(audioTrack);
            shareTrack.pauseUpstream();
            audioTrack?.pauseUpstream();
            this.openModal({
              onCancel: async () => {
                // Cancel never passes the toggle's disable branch (F1):
                // doom any in-flight capture and stop the native audio
                // session here too. livekit's own teardown unpublishes
                // and stops the tracks.
                this.#screenAudioGen++;
                void stopScreenAudio(this.#screenAudioSessionId);
                try {
                  // Windows: same stop path, and it must run BEFORE the
                  // unpublish for the same reason as the toggle's disable
                  // branch. A cancel landing while the graph is still being
                  // built sets the module's start-cancelled flag, so an
                  // in-flight capture abandons instead of publishing into a
                  // share the user has just cancelled.
                  await teardownWinScreenAudio();
                  await room.localParticipant.setScreenShareEnabled(false);
                } catch (error) {
                  // livekit awaits a pending republish BEFORE it
                  // unpublishes, so a rejection can leave the share
                  // published and consent-paused: keep the hold (a share
                  // stuck paused beats one streaming pre-consent), leave
                  // `screenshare()` true so the stop button stays the way
                  // out, and say so. Also the only handler this rejection
                  // has: `onCancel` is typed `() => void` and called bare.
                  console.error(
                    "screen share cancel could not unpublish; consent hold kept",
                    error,
                  );
                  this.onErr(error);
                  return;
                }
                // Only after a SUCCESSFUL unpublish, never before it: a
                // 1->0 sweep in that window would resume the doomed share
                // for the length of the unpublish.
                this.#consentHeld.delete(shareTrack);
                if (audioTrack) this.#consentHeld.delete(audioTrack);
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
              audioChoice: needsAudioChoice,
              entireScreen,
              callback: async (qualityName, audio) => {
                // Consent given: release the hold FIRST, so whichever
                // path resumes the share -- the direct resume below over
                // an empty gate, or the gate's own 1->0 sweep later -- is
                // no longer told to skip it.
                this.#consentHeld.delete(shareTrack);
                // The audio hold goes ONLY with a grant. Declined, the
                // track keeps its hold until the untick unpublish inside
                // `callback` drops the object: a 1->0 sweep landing in
                // that window could otherwise resume an unmuted,
                // upstream-paused getDisplayMedia audio track the user
                // just said no to.
                if (audioTrack && audio) this.#consentHeld.delete(audioTrack);
                callback(qualityName, audio);
                // Native screen audio was published MUTED while consent
                // was pending (F8/E3) — unmute now that the user said
                // yes, once the gate is empty and (on E2EE) the sender
                // transform is asserted. This covers the Windows arm too:
                // `#publishWinScreenAudio` mutes on the same edge, and
                // `#unmuteScreenAudioWhenSafe` is platform-neutral (it
                // keys on the publication's `LocalAudioTrack`, not on how
                // the track was captured). Read through the captured
                // TRACK: after a republish `screenAudioTrack.track` is
                // `undefined` and the helper would return silently,
                // leaving a live OS capture muted for the rest of the call.
                if (audio && audioTrack?.isMuted) {
                  void this.#unmuteScreenAudioWhenSafe(
                    room,
                    { track: audioTrack },
                    generation,
                  );
                }
                // Publish-gate coexistence (R2-8): the quality modal's
                // per-track resume must never override a held session gate
                // (negotiating / mixed / enable-window) — a direct resume
                // here would briefly publish a plaintext screenshare into a
                // mixed call before the UpstreamResumed backstop re-pauses
                // it. If the gate is held, skip the resume: the gate owner
                // resumes EVERY publication when the set empties, and the
                // hold deleted above is what lets its `resume` arm include
                // this share. Evaluated ONCE, here; the resume is over the
                // captured tracks (the publication is stale after a
                // republish, and its resume would be a masked no-op).
                if (this.#publishGate.size === 0) {
                  shareTrack.resumeUpstream();
                  if (audio) {
                    audioTrack?.resumeUpstream();
                  }
                }
                // Slice 2, LAST: the checkbox above was the consent to
                // send sound; the chooser asks which app. Deliberately
                // after this dialog has been answered and the video
                // share resumed, rather than stacked on top of it — one
                // question at a time, and the share is already settled
                // by the time the second one appears.
                if (audio && needsAudioChoice) {
                  this.#chooseScreenAudioApp(room, generation).catch((error) =>
                    this.onErr(error),
                  );
                }
              },
            });
          } else if (this.#settings.screenShareQualityAsk) {
            // Ask-mode with a single tier: nothing to ask, the stored
            // answer stands.
            callback(
              this.#settings.screenShareQuality || "low",
              this.#settings.screenShareAudio,
            );
          }

          // No ask-dialog will open (the picker answered, "don't ask me
          // again", or a single quality tier), so there is nothing to hang
          // the app question off — and this is the only route a
          // don't-ask-again user can ever get window-share audio. Their
          // stored "share audio" answer is already the consent to send
          // sound; the chooser asks the one thing we genuinely cannot
          // infer, and cancelling leaves the share silent.
          if (needsAudioChoice && !consentPending) {
            this.#chooseScreenAudioApp(room, generation).catch((error) =>
              this.onErr(error),
            );
          }
        }
      } catch (e) {
        // Backing out of a picker — the browser's NotAllowedError or the
        // Electron shell's AbortError "Error starting capture" — is not an
        // error to the user who just cancelled; everything else surfaces.
        //
        // A rejection PAST the hold (`captureScreenAudio`, awaited bare
        // inside `#publishNativeScreenAudio`, is the one call there that
        // can reject) leaves the share published, upstream-paused and
        // held, with no modal open: fail-closed. `onErr` says so and the
        // stop button is the way out. No teardown here on purpose -- an
        // await in an error path over a half-built share is more surface
        // than the stuck share.
        if (!isScreenShareCancel(e)) this.onErr(e);
      } finally {
        this.#screenshareStarting = false;
      }
    }
  }

  /** True when an in-flight native screen-audio step must abandon (F2).
   *
   * Liveness is the Voice-owned `screenshare()` signal, NOT livekit's
   * `isScreenShareEnabled` — that getter is just "does a ScreenShare
   * publication exist right now", and `republishAllTracks` unpublishes
   * and republishes every track, so it reads FALSE for hundreds of
   * milliseconds on each E2EE enable-window re-secure and each reconnect.
   * Keying on it made a poll landing in that window abandon the unmute
   * doorway silently: the track stays muted for the rest of the call with
   * a live OS capture behind it and nothing left that can unmute it,
   * which is the exact silent-failure class the doorway exists to kill.
   * `screenshare()` only changes when the share itself does (§6's F2 rule
   * names it for this reason). */
  #screenAudioStale(generation: number, room: Room) {
    return (
      generation !== this.#screenAudioGen ||
      room !== this.room() ||
      !this.screenshare()
    );
  }

  /**
   * WINDOWS ONLY — publish the shell's native WASAPI system-audio capture.
   *
   * Nothing here is shared with `#publishNativeScreenAudio` below, which is
   * the Linux/PipeWire path: that one captures a virtual device through gUM
   * and publishes MUTED behind a consent doorway, where this one owns an
   * AudioContext and a worklet fed over a Tauri binary `Channel` and publishes
   * live. Every failure DEGRADES TO A SILENT SHARE — the video share always
   * continues.
   *
   * Ordering is not incidental; each step is a rule from design §3.4/§3.6.
   */
  async #publishWinScreenAudio(
    room: Room,
    generation: number,
    consentPending: boolean,
  ) {
    if (this.#screenAudioStale(generation, room)) return undefined;

    // 🔴 REFUSE to re-arm after this call already published screen audio
    // through a sender with no E2EE transform (latched at detection, in
    // `#assertWinScreenAudioEncrypted`). See the field's own note for why the
    // scope is the call and why this is availability, not disclosure.
    if (this.#screenAudioPlaintext) {
      console.error(
        "[screen-audio] refusing to re-arm: this call already published screen audio through a sender with no E2EE transform",
      );
      return undefined;
    }

    // 🔴 §3.4 E3, checked BEFORE the shell is asked to capture anything, and
    // again immediately before `publishTrack` below — the gate can be acquired
    // across the awaits in between. This first check exists so a gated share
    // does not spin up a native capture and an AudioContext that the gate says
    // must not exist, only to tear them down.
    //
    // 🔴 This CONSULTS `#publishGate`; it never joins it. The module's
    // `beginScreenAudioPublish`/`finishScreenAudioPublish` latch is a separate,
    // module-local STARTING-window object. Adding a screen-audio reason to
    // `#publishGate` would pause the microphone and the camera too — that gate
    // pauses EVERY sender.
    if (this.#publishGate.size > 0) {
      console.error(
        "[screen-audio] not starting a capture while the publish gate is held:",
        [...this.#publishGate].join(", "),
      );
      return undefined;
    }

    // Assigned below, after the gate checks, and read by the host closure —
    // so it cannot be `const`.
    // eslint-disable-next-line prefer-const
    let audioTrack: LocalAudioTrack | undefined;

    const capture = await captureWinScreenAudio({
      mode: "system",
      host: {
        // Idempotent and non-throwing: this is called from a death path.
        // 🔴 Resolves the publication BY TRACK first. A death during the
        // publish window finds nothing by source (livekit registers the
        // publication only after `negotiate()` returns), and neither does a
        // teardown landing inside `republishAllTracks`'s unpublish/republish
        // gap, which is how every full reconnect works.
        unpublish: async () => {
          const target =
            audioTrack ??
            room.localParticipant.getTrackPublication(
              Track.Source.ScreenShareAudio,
            )?.track;
          if (!target) return;
          try {
            await room.localParticipant.unpublishTrack(target);
          } catch (error) {
            console.error("[screen-audio] unpublish failed", error);
          }
        },
        // 🔴 DROP a report that outlived its share. The `not-encrypted` LIVE
        // edge reports from `teardownScreenAudio().finally`, and that teardown
        // is two bounded 2 s settles plus a `context.close()` — precisely the
        // path a dropping socket makes slow. Hang up inside that window and
        // the modal would otherwise open over the NEXT call, announcing
        // unencrypted screen audio for a call that has shared nothing.
        report: (failure) => {
          if (this.#screenAudioStale(generation, room)) {
            console.error(
              "[screen-audio] dropping a failure report from a share that is gone",
              failure,
            );
            return;
          }
          this.#reportWinScreenAudioFailure(failure);
        },
      },
    });
    if (!capture) return undefined;

    // `captureWinScreenAudio` spans an IPC round trip plus a worklet module
    // load; the share or the call can end underneath it.
    if (this.#screenAudioStale(generation, room)) {
      await teardownWinScreenAudio();
      return undefined;
    }

    // 🔴 §3.4 E3 again, because the gate is checked BEFORE the publish, not
    // after. The `localTrackPublished` listener re-applies the gate, but only
    // once `negotiate()` has returned and the encoder is already producing —
    // so publishing into a held gate puts the whole desktop mix on the wire
    // and pauses it a task or two later. The house precedent is to refuse
    // outright (`startWhisper`), and a silent share is the right degrade.
    if (this.#publishGate.size > 0) {
      console.error(
        "[screen-audio] refusing to publish while the publish gate is held:",
        [...this.#publishGate].join(", "),
      );
      await teardownWinScreenAudio();
      return undefined;
    }

    // 🔴 Refuse a duplicate. livekit permits a second ScreenShareAudio
    // publication with only an info log, and two of them means two captures
    // and an invariant nobody enforces.
    if (
      room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)
    ) {
      console.error(
        "[screen-audio] a ScreenShareAudio publication already exists; refusing to publish a second",
      );
      await teardownWinScreenAudio();
      return undefined;
    }

    // `userProvidedTrack: true` — the track is ours, from a
    // MediaStreamAudioDestinationNode, and livekit must never try to
    // "reacquire" it the way it would a gUM track.
    audioTrack = new LocalAudioTrack(capture.track, undefined, true);

    // 🔴 PUBLISH MUTED WHILE CONSENT IS PENDING (§3.4 F8/E3), exactly as the
    // Linux arm does below. This is the whole of the user's protection on this
    // edge, and it is a REAL mute, not a pause.
    //
    // `wantsAudio` is true whenever the ask-modal will open — `consentPending
    // || …` — so this path is reached even when the stored "Share audio"
    // setting is OFF. The modal has not opened yet; the user has not agreed to
    // send anything. `pauseUpstream()` below does not cover it: livekit
    // attaches the sender at the top of `negotiate()`, on a transport the
    // video share has already connected, so RTP leaves before `publishTrack`
    // resolves and the pause lands afterwards. §3.4 names both
    // `mediaStreamTrack.enabled = false` and the pause as NOT a mute: only
    // `track.mute()` sets `req.muted` at signaling time, which is what stops
    // the SFU forwarding it.
    //
    // Without this, one signaling round trip of the user's entire desktop mix
    // reaches every participant before they are asked — and the modal then
    // renders the checkbox UNTICKED, so nothing tells them it happened.
    //
    // 🔴 Placed BEFORE `beginWinScreenAudioPublish()`, not after: the latch
    // below must stay adjacent to `publishTrack` with no suspension point
    // between them, or the two STARTING death rows stop being
    // distinguishable. Muting here costs that property nothing.
    if (consentPending) {
      try {
        await audioTrack.mute();
      } catch (error) {
        // A rejecting mute leaves a live capture we are no longer willing to
        // publish: degrade to a silent share rather than publish unmuted.
        console.error("[screen-audio] mute before publish failed", error);
        await teardownWinScreenAudio();
        return undefined;
      }
      // `mute()` is an await, so the share or the call can have ended under
      // it — the same re-check every other await in this method carries.
      if (this.#screenAudioStale(generation, room)) {
        await teardownWinScreenAudio();
        return undefined;
      }
    }

    // 🔴 No `await` between this and `publishTrack`. The two STARTING death
    // rows differ by exactly whether the publish has been ISSUED — before it
    // the publish is REFUSED, after it `negotiate()` has already put the track
    // on the wire and the only correct action is to UNPUBLISH. Because there
    // is no suspension point here, no death can land in between and the two
    // cases stay distinguishable.
    if (!beginWinScreenAudioPublish()) {
      await teardownWinScreenAudio();
      return undefined;
    }

    let publication: LocalTrackPublication;
    try {
      publication = await room.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.ScreenShareAudio,
        // 🔴 `forceStereo`: livekit reads channel count from settings and
        // constraints, and BOTH are empty on a synthetic worklet track — so
        // without forcing it the track negotiates MONO and the implicit
        // stereo dtx/red-off backstop never arms.
        forceStereo: true,
        // Stated explicitly rather than inherited from `forceStereo`: empty
        // DTX frames bypass frame encryption, which is an activity-pattern
        // leak on an E2EE call, and RED duplicates payload the frame cryptor
        // has already sealed.
        dtx: false,
        red: false,
      });
    } catch (error) {
      console.error("[screen-audio] publish failed", error);
      await teardownWinScreenAudio();
      return undefined;
    }

    // 🔴 ASSERT the mute survived the publish, rather than trusting it.
    // §3.4's rule is about what `req.muted` carried at signaling time, and
    // that is a livekit internal we do not own: `publishTrack` reads the
    // track's mute state while building the request, so a livekit change that
    // reordered or reset it would silently reopen exactly the window this
    // mute exists to close. Fail LOUD — unpublish and degrade to a silent
    // share — because the alternative is broadcasting the desktop mix to a
    // user who has not been asked yet.
    if (consentPending && !publication.isMuted) {
      console.error(
        "[screen-audio] published track is NOT muted while consent is pending; refusing to leave it up",
      );
      await teardownWinScreenAudio();
      return undefined;
    }

    // A death that landed during the publish window. There is no publish left
    // to refuse, so returning early would strand a live ScreenShareAudio
    // publication on the SFU against local state DEAD — encrypted silence both
    // ends believe is live, on the one path where the frames may be other
    // participants' voices.
    if (!finishWinScreenAudioPublish()) {
      // 🔴 BOUNDED, not merely caught — and this arm is where it matters most.
      // It is reached ONLY when a death or a stop path landed during the
      // publish window, i.e. precisely the dead-socket / dead-shell conditions
      // under which livekit's `unpublishTrack` hangs: it awaits
      // `pendingPublishPromises` and then `engine.negotiate()`, both of which
      // sit on a dead PeerConnection. A `try/catch` answers rejection and does
      // nothing about a hang.
      //
      // The caller is holding `shareTrack.pauseUpstream()` plus the
      // `#consentHeld` hold, and the ask-modal does not open until this
      // method returns, so an unbounded await here reproduces the
      // frozen-tile-with-no-modal failure the module's own STARTING-window
      // bounds exist to prevent — from the one call site that is outside
      // the module.
      //
      // Usually redundant: `die()` and `teardownScreenAudio()` each already
      // ran `host.unpublish()` under their own 2 s settle. It is kept for the
      // one ordering where it is not — a stop path that fired before livekit
      // registered the publication — and 2 s is the same number those use.
      await Promise.race([
        room.localParticipant.unpublishTrack(audioTrack).catch((error) => {
          console.error("[screen-audio] late unpublish failed", error);
        }),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            console.error(
              "[screen-audio] late unpublish did not settle within 2000ms",
            );
            resolve();
          }, 2_000),
        ),
      ]);
      return undefined;
    }

    // The `lk_e2ee` assertion for this publication is bound to
    // `localTrackPublished` in `connect`, and livekit emits that event INSIDE
    // `publishTrack` — so the listener has already seen this one. Asserting
    // again here would be a second, redundant check on the same sender.
    return publication;
  }

  /**
   * Turn a Windows screen-audio failure CODE into copy.
   *
   * 🔴 The copy lives here, not in `screenAudioNativeWin.ts`: the client's
   * user-facing strings are lingui macros with ~70 catalogs behind them, and a
   * raw literal in a platform module silently bypasses all of them. Each string
   * is wrapped in `new Error(...)` rather than passed bare because `onErr`
   * renders through `useError()`, whose only verbatim path is an Error's
   * `.message`; a bare string falls into ``t`Something went wrong! ${error}` ``
   * and arrives wearing a generic error's clothes.
   *
   * 🔴 BRANCHES ON `code`, NEVER ON DETAIL TEXT. The detail strings are
   * diagnostics for a user report and the same code covers genuinely different
   * causes — `"unsupported"` is emitted both for "this is not Windows / the
   * build is too old" and for a damaged system DLL. The retired literal
   * "ActivateAudioInterfaceAsync is not exported (Windows build < 19041)" no
   * longer means an old OS and must never be matched again.
   */
  #reportWinScreenAudioFailure(failure: WinScreenAudioFailure) {
    switch (failure.kind) {
      case "start":
        // 🔴 This arm also receives the ASYNCHRONOUS refusal.
        // `screen_audio_start` resolves `Ok` even where the OS gate will
        // refuse — the gate is reached on the capture thread, inside
        // `resolve_activate()`, after the command has already returned — so a
        // too-old Windows lands here later, off the died/end channel, as
        // `EndReason::CaptureError` with `code === "unsupported"`. The module
        // re-labels it as a START failure so it gets start copy rather than
        // "your screen audio stopped"; the video share continues, the audio
        // publication has already been torn down by the module's death path,
        // and the user is TOLD. A silent share with no explanation is the one
        // outcome this arm exists to prevent.
        if (failure.code === "no-root") {
          this.onErr(
            new Error(
              t`Screen audio is unavailable in this window. If you are running a second copy of Sloga, only the first one can share system audio.`,
            ),
          );
          return;
        }
        if (failure.code === "unsupported") {
          this.onErr(
            new Error(t`This version of Windows cannot share system audio.`),
          );
          return;
        }
        // A deliberate opt-out (`SLOGA_NO_SCREEN_AUDIO=1`) is not a failure.
        if (failure.code === "disabled-by-env") return;
        this.onErr(
          new Error(t`Screen audio could not start; sharing without it.`),
        );
        return;
      case "not-encrypted":
        // 🔴 This sentence says NOTHING LEAKED, and that is measured rather
        // than hoped. L15 (design §7): with `encodedInsertableStreams` — which
        // livekit sets for every E2EE room — Chromium withholds RTP from a
        // transformless sender entirely, at zero bytes and zero packets. What
        // is left to tell the user is an availability failure plus the reason
        // their next share in this call will also be silent.
        this.onErr(
          new Error(
            t`Screen audio could not be encrypted, so nothing was sent in the clear. Your computer's sound has stopped reaching the call and stays off for the rest of it — rejoin to try again.`,
          ),
        );
        return;
      case "graph":
        this.onErr(
          new Error(t`Screen audio could not start; sharing without it.`),
        );
        return;
      case "died":
      default:
        // 🔴 L13's discriminator goes in the log line: once "the audio engine
        // went idle" was retired, the two surviving causes — a throttled relay
        // and a dead audio render thread — present identically at the shell's
        // tick counter, and only the module's two delivery stamps separate
        // them. It also carries §11.9's exclusion verdict, so a user report
        // names which check ran.
        console.error(
          "[screen-audio] died:",
          failure,
          winScreenAudioDiagnostics(),
        );
        this.onErr(
          new Error(t`Screen audio stopped. The screen is still being shared.`),
        );
    }
  }

  /**
   * The `lk_e2ee` assertion, per publication — WINDOWS ONLY (gated on the
   * module's own `screenAudioActive()`, so a Linux PipeWire share never
   * reaches it).
   *
   * Fails LOUD: a dead E2EE worker plus one publish sends the whole
   * system-audio capture to the SFU as PLAINTEXT while the signaling still
   * stamps GCM at participant level. Receivers fail-decrypt and drop, so the
   * symptom is "the far end hears nothing" — indistinguishable from a quiet
   * desktop.
   */
  #assertWinScreenAudioEncrypted(room: Room, pub: LocalTrackPublication) {
    if (!winScreenAudioActive()) return;
    if (!room.isE2EEEnabled) return;
    const sender = pub.track?.sender;
    if (winScreenAudioSenderEncrypted(sender)) return;

    // 🔴 NO SENDER TO READ IS NOT EVIDENCE OF PLAINTEXT.
    // `winScreenAudioSenderEncrypted` answers false for a MISSING sender as
    // well as for a present one carrying no flag. Below this line the call is
    // latched for the rest of its life with no in-call recovery, so a
    // momentarily-undefined `pub.track` on a republish — or a livekit
    // API-shape change on a bump — would permanently disable screen audio on a
    // healthy call. A missing sender therefore keeps the per-track teardown
    // and skips the call-level latch: fail-closed on the track, no evidence on
    // the call.
    if (!sender) {
      console.error(
        "[screen-audio] no sender to assert on; tearing down this track without latching the call",
      );
      winScreenAudioEncryptionFailed();
      return;
    }

    // 🔴 Everything call-level happens HERE, synchronously, before the teardown
    // is even started. The module's LIVE edge reports only after its teardown
    // settles, which is two bounded 2 s awaits — a latch set from the report
    // would leave a racing `toggleScreenshare` free to re-arm inside the gap.
    console.error(
      "[screen-audio] E2EE transform missing on publication",
      pub.trackSid,
    );
    this.#screenAudioPlaintext = true;

    // 🔴 DELIBERATELY NOT `#setCallEncryptionLatch`, and this is the L15 result
    // rather than an oversight. Writing it here would fire the NOT-ENCRYPTED
    // chip on the premise that the sharer's tracks were reaching the SFU in the
    // clear; measured (design §7, L15), a sender with no transform emits ZERO
    // RTP, so a red lock on this call would be a false alarm — and the same
    // mechanism protects the mic and the screen video, which was the whole
    // argument for going call-wide. What is left is an AVAILABILITY failure:
    // this share is silent, the latch above stops it repeating, and the modal
    // from `#reportWinScreenAudioFailure` says so. The chip derivation is
    // therefore untouched by this lane.

    // 🔴 The response differs by state — a failure during the publish window
    // must LATCH and refuse the pending publish, where one on a live
    // publication must discard and unpublish first — so the rule lives in the
    // module that owns the state machine rather than here.
    winScreenAudioEncryptionFailed();
  }

  /**
   * Capture the Linux shell's virtual PipeWire source and publish it as
   * ScreenShareAudio (screenshare-audio design §6). Returns the publication
   * or undefined — failure degrades to a no-audio share (no modal-sized
   * error: audio is an enhancement and the video share already succeeded).
   *
   * Ordering rules (F2/F8/E2/E3): staleness re-checked after every await;
   * the track goes up MUTED whenever consent is pending, the publish gate
   * is held, or the call is E2EE — and is unmuted only through
   * #unmuteScreenAudioWhenSafe. `req.muted` is stamped from the track state
   * at publish, so no pre-consent/pre-transform frames ever escape.
   *
   * `targets` (slice 2) narrows the capture to one application. It is
   * applied inside `captureScreenAudio` before the device is captured, and
   * a shell that cannot apply it fails the capture rather than publishing
   * a system-wide one the user did not choose.
   */
  async #publishNativeScreenAudio(
    room: Room,
    generation: number,
    consentPending: boolean,
    targets: ScreenAudioTargets,
  ) {
    if (this.#screenAudioStale(generation, room)) return undefined;

    const captured = await captureScreenAudio(targets);
    if (!captured) {
      // The doc mandates a surfaced signal here (§4: "toast + share
      // continues without audio") — a silent no-audio share suppresses the
      // exact field evidence the fallback-(b) decision depends on.
      this.onErr(
        new Error("Screen audio could not start — sharing without sound."),
      );
      return undefined;
    }
    const { track: msTrack, sessionId } = captured;
    const abandon = () => {
      msTrack.stop();
      // By THIS capture's token: if a fresh share superseded us, its
      // session survives this stop untouched.
      void stopScreenAudio(sessionId);
      return undefined;
    };
    if (this.#screenAudioStale(generation, room)) return abandon();

    // Mirrors createScreenTracks' own wrapping (userProvidedTrack=false) so
    // the publication behaves exactly like a Windows screen-audio track in
    // every downstream path — ask-modal checkbox, pause/resume, unpublish
    // on untick/ended, and the reconnect republish that reuses the same
    // MediaStreamTrack (F4).
    //
    // ALWAYS published muted: #unmuteScreenAudioWhenSafe is the single
    // unmute doorway (consent, publish-gate and E2EE-transform checks live
    // there), so no ordering of gate transitions around the publish await
    // can leak first frames (E3's residue). The plaintext happy path pays
    // one near-immediate unmute round-trip for that.
    let audioTrack;
    let publication;
    try {
      // Inside the try with the publish: a mute() that rejects (torn-down
      // track, a livekit internal) would otherwise escape before
      // abandon() could run, leaving the native session and the gUM
      // capture live with no publication and nothing surfaced.
      audioTrack = new LocalAudioTrack(msTrack, undefined, false);
      await audioTrack.mute();
      if (this.#screenAudioStale(generation, room)) return abandon();

      publication = await room.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.ScreenShareAudio,
        // E2EE INVARIANT, not a bandwidth knob (§7/E5): empty DTX frames
        // bypass frame encryption (zero-length passthrough in the worker)
        // and would leak the share's silence/activity pattern in cleartext.
        dtx: false,
        red: false,
      });
    } catch (error) {
      console.error("screen audio publish failed", error);
      this.onErr(
        new Error("Screen audio could not start — sharing without sound."),
      );
      return abandon();
    }
    if (this.#screenAudioStale(generation, room)) {
      room.localParticipant.unpublishTrack(audioTrack);
      return abandon();
    }
    this.#screenAudioSessionId = sessionId;
    this.#armScreenAudioGuard(room, generation, sessionId, audioTrack);
    if (!consentPending) {
      void this.#unmuteScreenAudioWhenSafe(room, publication, generation);
    }
    return publication;
  }

  /**
   * Guard a live native capture against the failure nothing else reports:
   * the native session dying under the share. Design §4 assumed a dead
   * virtual source ends the gUM track and livekit unpublishes; under
   * pipewire-pulse the record stream is instead MIGRATED to the default
   * source — the microphone — and the ScreenShareAudio publication keeps
   * sending it, untouched by the mic mute (field record 2026-09-04,
   * PipeWire 1.0.5). Two independent tells, either of which ends the
   * capture: the shell's liveness notice for THIS session, and the matched
   * capture device dropping out of enumerateDevices. Both are scoped by the
   * generation token, so a guard that outlives its share is inert, and the
   * stop paths that end a share early disarm it explicitly.
   */
  #armScreenAudioGuard(
    room: Room,
    generation: number,
    sessionId: number,
    track: LocalAudioTrack,
  ) {
    this.#disarmScreenAudioGuard();
    const label = track.mediaStreamTrack.label;
    let fired = false;
    const died = (reason: string) => {
      if (fired) return;
      fired = true;
      this.#disarmScreenAudioGuard();
      if (this.#screenAudioStale(generation, room)) return;
      this.#screenAudioDied(room, sessionId, track, reason);
    };
    const unsubscribe = onScreenAudioEnded((event) => {
      if (event.sessionId === sessionId) {
        died(event.reason ?? "native session ended");
      }
    });
    const timer = setInterval(() => {
      if (this.#screenAudioStale(generation, room)) {
        this.#disarmScreenAudioGuard();
        return;
      }
      navigator.mediaDevices.enumerateDevices().then(
        (devices) => {
          if (!fired && screenAudioDeviceGone(devices, label)) {
            died("capture device disappeared");
          }
        },
        () => undefined,
      );
    }, SCREEN_AUDIO_WATCH_MS);
    this.#screenAudioGuard = () => {
      unsubscribe();
      clearInterval(timer);
    };
  }

  #disarmScreenAudioGuard() {
    const disarm = this.#screenAudioGuard;
    this.#screenAudioGuard = undefined;
    disarm?.();
  }

  /**
   * The native session is gone: end the capture NOW, before the migrated
   * stream can carry the microphone. Bumping the generation dooms any
   * in-flight unmute or chooser for this capture; `stopOnUnpublish` is
   * forced so the gUM track is stopped whatever the room's default, with
   * an explicit stop as the belt. The video share continues — audio is the
   * enhancement — and the user is told why it went, the same way a failed
   * start is reported.
   */
  #screenAudioDied(
    room: Room,
    sessionId: number,
    track: LocalAudioTrack,
    reason: string,
  ) {
    console.error(`screen audio session died: ${reason}`);
    this.#screenAudioGen++;
    void room.localParticipant.unpublishTrack(track, true);
    track.mediaStreamTrack.stop();
    void stopScreenAudio(sessionId);
    if (this.#screenAudioSessionId === sessionId) {
      this.#screenAudioSessionId = undefined;
    }
    this.onErr(
      new Error(
        `Screen audio stopped — sharing continues without sound (${reason}).`,
      ),
    );
  }

  /**
   * "Which app's audio?" — the explicit chooser for a Linux window share
   * the shell could not attribute to exactly one application
   * (screenshare-audio design §9). Reached only when the user has already
   * asked for audio on this share; the question left is which app, and
   * that one we refuse to guess.
   *
   * Nothing has been captured at this point and nothing is until a row is
   * picked, so every way out that is not a pick — cancel, dismiss, a
   * staleness abort, an empty roster — leaves the share silent with no
   * native session behind it. That makes this dialog's fail-open direction
   * the safe one, unlike the consent dialogs the repo warns about.
   */
  async #chooseScreenAudioApp(room: Room, generation: number) {
    if (this.#screenAudioStale(generation, room)) return;
    if (this.#screenAudioChooserGen === generation) return;
    this.#screenAudioChooserGen = generation;
    const apps = await listScreenAudioApps();
    if (this.#screenAudioStale(generation, room)) return;
    if (apps.length === 0) {
      // Nothing is playing, so there is nothing we could have linked
      // either way and no question worth putting on screen. Deliberately
      // NOT surfaced: this is §9's benign "chooser shows an app that
      // stops playing" state, it fires on every share of a quiet window,
      // and `onErr` is a full error dialog on top of a live call.
      console.info("screen audio chooser: no app is playing sound");
      return;
    }
    this.openModal({
      type: "screen_share_audio_source",
      apps,
      // Dismissing is a valid answer here (silent share); there is no
      // capture or publication to tear down.
      onCancel: () => {},
      callback: (key) => {
        if (!apps.some((app) => app.key === key)) return;
        // The share can end while this dialog sits open — say so rather
        // than letting the button read as broken. Nothing was captured,
        // so there is nothing to tear down.
        if (this.#screenAudioStale(generation, room)) {
          this.onErr(
            new Error("That share has already ended — nothing was shared."),
          );
          return;
        }
        // Straight back onto the one publish path — always-muted publish,
        // single unmute doorway, same staleness token. The pick IS the
        // consent, so consentPending is false. The target is the app's
        // stable identity, resolved to live nodes at apply time, so a
        // stream that died while the dialog was open cannot hand the
        // capture whatever now owns its recycled node id.
        // Explicit catch: this is a fire-and-forget call site with no
        // enclosing try, so a throw here would surface as an unhandled
        // rejection instead of telling the user the audio did not start.
        this.#publishNativeScreenAudio(room, generation, false, {
          mode: "targets",
          include: [key],
        }).catch((error) => this.onErr(error));
      },
    });
  }

  /**
   * Unmute the native screen-audio publication once it is safe: the publish
   * gate must be empty (E3 — the gate owner's release sweep resumes paused
   * upstreams but knows nothing of our mute), and on an E2EE call the
   * sender must demonstrably carry the worker's encode transform first (E2
   * — livekit stamps `lk_e2ee` on every sender it wired a cryptor onto; a
   * publish whose transform silently failed to attach would otherwise ship
   * PLAINTEXT frames on a declared-GCM publication, and the symptom on the
   * far side is indistinguishable from benign silence). Absent transform =
   * fail LOUD: drop the audio, keep the share.
   */
  /** The shared fail-LOUD exit for a screen-audio track that must not (or
   * can never) play: unpublish, stop the native session, tell the user. */
  #dropScreenAudio(room: Room, track: LocalAudioTrack, message: string) {
    console.error(`screen audio dropped: ${message}`);
    room.localParticipant.unpublishTrack(track);
    void stopScreenAudio(this.#screenAudioSessionId);
    this.onErr(new Error(message));
  }

  async #unmuteScreenAudioWhenSafe(
    room: Room,
    publication: { track?: { isMuted: boolean } },
    generation: number,
  ) {
    const track = publication.track;
    if (!(track instanceof LocalAudioTrack)) return;
    // The gate normally empties in seconds; a wedge past the deadline
    // takes the same LOUD exit as a missing transform — a permanently
    // muted track with a live OS capture behind it is the silent-failure
    // class E2 exists to kill, not a state to park in.
    const deadline = Date.now() + 15_000;
    while (this.#publishGate.size > 0) {
      if (this.#screenAudioStale(generation, room)) return;
      if (Date.now() > deadline) {
        this.#dropScreenAudio(
          room,
          track,
          "Screen audio was stopped because the call kept it paused too long.",
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (this.#screenAudioStale(generation, room)) return;
    if (this.callMode()?.kind === "e2ee") {
      // livekit stamps `lk_e2ee` on a sender AFTER attaching its encode
      // transform — verified on livekit-client 2.15.13 (handleSender), NOT
      // an API contract: re-verify this stamp's ordering on any livekit
      // bump, same list as the F4 republishAllTracks exclusion.
      let attached = false;
      for (let i = 0; i < 10 && !attached; i++) {
        const sender = track.sender;
        if (sender && "lk_e2ee" in sender) {
          attached = true;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (this.#screenAudioStale(generation, room)) return;
      if (!attached) {
        this.#dropScreenAudio(
          room,
          track,
          "Screen audio was stopped because it could not be encrypted.",
        );
        return;
      }
    }
    await track.unmute();
  }

  /**
   * Start/stop the native Android screen leg (screen-leg plan §7.2).
   *
   * Start preconditions are "the primary is actually publishing", checked
   * here rather than trusted to the button: the publish gate must be EMPTY
   * (a re-secure pauses via `pausePublishing("enable-window")` with the mode
   * UNCHANGED, so `callMode` is a trigger, never the gate), and under E2EE
   * the session must be active with the leg send key already derived —
   * `lastLocalScreenKey` is the provider's own record of the current epoch's
   * key (§5.2). A plaintext call (mode `off`/undefined, no session) starts a
   * plaintext leg.
   *
   * Flow (§4.2 two-phase): sheet (tier) → `prepare()` (OS consent + FGS) →
   * `joinScreenLeg` (the 10 s token, minted only now) → `connect()` with the
   * key. The OS re-prompts every share by rule; copy says so.
   */
  async #toggleAndroidScreenShare(room: Room) {
    // A tap while a start is in flight is a CANCEL, not a second start:
    // letting it fall through opened a SECOND OS consent dialog and the two
    // attempts tore each other down. `#stopAndroidLeg` bumps the generation,
    // which orphans the in-flight attempt at its next stale check (and that
    // check tears down natively, releasing the consent/FGS it took).
    if (this.#androidLegStartingFor !== undefined) {
      await this.#stopAndroidLeg();
      return;
    }
    const leg = this.#androidLeg;
    if (leg?.active()) {
      await this.#stopAndroidLeg();
      return;
    }

    const channel = this.channel();
    if (!channel) throw "invalid state";

    const mode = this.callMode();
    // Cheap up-front refusal so neither dialog is shown for a share that
    // cannot start. Deliberately does NOT capture the send key: between here
    // and `connect()` sit the tier sheet and the OS consent dialog, both
    // user-paced, and a key read now would be a snapshot of an epoch that may
    // be several rotations stale by the time the leg publishes. The binding
    // read is the one below, immediately before `connect()`.
    if (this.#androidLegRefusedNow(mode)) {
      this.onErr(new Error(SHARE_UNAVAILABLE_NOW));
      return;
    }

    // Tier sheet first: it is the cheap step, and cancelling it must not
    // have shown an OS consent dialog for nothing.
    const tier = await new Promise<AndroidScreenShareTier | undefined>(
      (resolve) => {
        this.openModal({
          type: "android_screen_share_sheet",
          tiers: ANDROID_SCREEN_SHARE_TIERS,
          initialTier: this.#settings.androidScreenShareTier,
          callback: (name) => {
            this.#settings.androidScreenShareTier = name;
            resolve(ANDROID_SCREEN_SHARE_TIERS.find((t) => t.name === name));
          },
          onCancel: () => resolve(undefined),
        });
      },
    );
    if (!tier) return;

    // The sheet is user-paced too. A call that ended or changed while it was
    // open is a cancellation: quiet, as the stale checks below treat it.
    if (this.room() !== room) return;
    // The same refusal again, now the sheet is closed: a gate reason added
    // while it was open (a re-secure, say) cancelled no attempt — none had
    // claimed yet — and would only surface at the first stale check, AFTER
    // the user had been through the OS consent dialog for nothing. Nothing
    // awaits between here and the claim, so any later reason reaches a
    // claimed attempt through `#pauseGate`.
    //
    // Asked of the mode as it is NOW, and only while it is still the one the
    // tap read. Checked against the tap-time `mode`, a re-upgrade completed
    // while the sheet was open (a plaintext interlude -> `negotiating` ->
    // `e2ee`, its gate pulse long since released) passed this check, and the
    // key read below then skipped the key and started a KEYLESS leg in an
    // encrypted call. A changed mode is refused rather than followed: the user
    // chose to share into the call they tapped in.
    const modeNow = this.callMode();
    if (modeNow?.kind !== mode?.kind || this.#androidLegRefusedNow(modeNow)) {
      this.onErr(new Error(SHARE_UNAVAILABLE_NOW));
      return;
    }

    // Claim the attempt. Any stop hook, or a competing tap, bumps this and so
    // orphans everything below.
    const generation = ++this.#androidLegGeneration;
    this.#androidLegStartingFor = generation;
    let activeLeg: AndroidScreenLeg | undefined;
    try {
      activeLeg = this.#ensureAndroidLeg();
      // Phase 1: consent + FGS. User-paced — can outlive any token TTL,
      // which is exactly why the token is minted AFTER it (§4.2).
      await activeLeg.prepare();
      // From here every exit must TEAR DOWN, never just return: `prepare()`
      // has taken the OS consent and started the foreground service, so a bare
      // return leaves the phone permitted to capture with nothing owning the
      // teardown.
      if (this.#androidLegStale(generation, room)) {
        await this.#exitStaleAndroidLegStart(generation, room);
        return;
      }

      // The device half of OUR OWN live identity — the route only mints a
      // leg for the device that IS the primary (§2.1 step 6), and refuses
      // with `FailedValidation` when this claim mismatches the mapping.
      const identity = room.localParticipant.identity;
      const deviceId = identity.split(":")[1] || undefined;
      const auth = await channel.joinScreenLeg(deviceId);
      if (this.#androidLegStale(generation, room)) {
        await this.#exitStaleAndroidLegStart(generation, room);
        return;
      }

      // THE binding read of the send key (§5.2). Taken here, after both
      // dialogs and the token mint, because `lastLocalScreenKey` is the
      // provider's record of "what key should the leg be using now" and a
      // rotation during the consent window has already advanced it. Publishing
      // under the pre-dialog key would hand the share to whoever that
      // rotation removed.
      //
      // The MODE is re-read here for the same reason, and the current mode
      // alone decides whether a key is needed. The OS consent dialog is
      // user-paced: a mode read at tap time could skip the key in a call that
      // has since become encrypted, publishing plaintext screen frames to the
      // SFU until the roster flags the leg. A mode that changed since the tap,
      // or one that may not publish plaintext (`#legPlaintextAuthorized`), is
      // refused; consent is already taken, so the refusal stops the leg.
      const modeAtConnect = this.callMode();
      if (
        modeAtConnect?.kind !== mode?.kind ||
        (modeAtConnect?.kind !== "e2ee" &&
          !this.#legPlaintextAuthorized(modeAtConnect))
      ) {
        await this.#stopAndroidLeg();
        this.onErr(new Error(SHARE_UNAVAILABLE_NOW));
        return;
      }
      let e2eeKey: LegE2EEKey | undefined;
      if (modeAtConnect?.kind === "e2ee") {
        const key = this.#mlsKeyProvider?.lastLocalScreenKey();
        // Bound to the CURRENT group, not just "a key exists": across the two
        // user-paced dialogs the session can have re-established, and the
        // provider's record then still holds the SUPERSEDED group's key until
        // the new group's first local install lands. Epochs are not
        // comparable across groups, so a leg started on that key could never
        // be fenced onto the new one — refuse instead.
        if (
          this.#mlsSession?.state() !== "active" ||
          !key ||
          key.groupId !== this.#mlsSession.groupId()
        ) {
          await this.#stopAndroidLeg();
          this.onErr(new Error(SHARE_UNAVAILABLE_NOW));
          return;
        }
        e2eeKey = {
          keyB64: key.keyB64,
          keyIndex: key.keyIndex,
          epoch: key.epoch,
          groupId: key.groupId,
        };
      }

      await activeLeg.connect({
        url: auth.url,
        token: auth.token,
        tier,
        e2ee: e2eeKey,
      });
      // `started` fires the signal + sound (the phone never subscribes to
      // its own leg, so the viewer-side sound path never runs here).

      // Past this line the leg is LIVE and capturing, so a world that moved
      // while `connect()` was in flight must be answered by tearing down, not
      // by returning — returning is what let a share outlive its own call.
      if (this.#androidLegStale(generation, room)) {
        await this.#exitStaleAndroidLegStart(generation, room);
        return;
      }
      await this.#syncLegKeyAfterConnect(activeLeg, e2eeKey);
    } catch (error) {
      // A failure anywhere above can still leave native capturing (consent is
      // granted in phase 1, and `connect()` can throw after publishing), so
      // the error path tears down rather than trusting `active()`.
      // Read BEFORE the stop below bumps the generation. CANCELLED, not
      // merely stale: a stop hook or a cancelling tap already ended this
      // attempt, native rejects the cancelled connect, and surfacing that
      // rejection would toast an error for a stop that was asked for. A
      // publish-gate pulse during the attempt IS such a cancellation —
      // `#pauseGate` stops the leg through `#stopAndroidLeg` and gives the
      // notice itself — so a failure racing it stays quiet. Merely stale is
      // not enough: a gate reason held since before the claim cancelled
      // nothing, and a genuine failure keeps its message (defense in depth,
      // unreachable in production today: see `#exitStaleAndroidLegStart`).
      const wasCancelled = this.#androidLegCancelled(generation, room);
      await this.#stopAndroidLeg();
      if (!wasCancelled) {
        // `NO_LEG_NOTICE` is the mapper's "no notice", returned only by its
        // revoke branch: a revoke the primary's own toast already explains.
        // Anything else it maps reaches `onErr` as it always has.
        const notice = this.#androidScreenShareError(error);
        if (notice !== NO_LEG_NOTICE) this.onErr(notice);
      }
    } finally {
      // Cleared only by the attempt that still owns the window. A stop bumps
      // the generation without claiming one, so keying on the token itself
      // would strand this flag set forever; keying on the OWNER lets this
      // attempt clean up after a stop while still refusing to unmask a
      // successor's start.
      if (this.#androidLegStartingFor === generation)
        this.#androidLegStartingFor = undefined;
    }
  }

  /**
   * Has the world moved since this start attempt claimed the leg? A stop hook
   * (hang-up, kick, socket loss, pause gate) bumps the generation, and the
   * room and gate are re-read because a start spans two user-paced dialogs.
   */
  #androidLegStale(generation: number, room: Room): boolean {
    return startAttemptStale(this.#androidLegWorld(generation, room));
  }

  /** Did something CLAIM the leg — a stop hook (a publish-gate pulse
   * included: `#pauseGate` stops through `#stopAndroidLeg`), a competing tap,
   * a call change — as opposed to the attempt merely finding a gate reason
   * that was already held when it claimed? Only a cancellation silences the
   * attempt's error: whatever claimed the leg speaks for itself. */
  #androidLegCancelled(generation: number, room: Room): boolean {
    return startAttemptCancelled(this.#androidLegWorld(generation, room));
  }

  #androidLegWorld(generation: number, room: Room) {
    return {
      generation,
      currentGeneration: this.#androidLegGeneration,
      roomChanged: this.room() !== room,
      publishGateSize: this.#publishGate.size,
    };
  }

  /**
   * The cheap "can a leg start right now" refusal, run before the tier sheet
   * and again once it closes: the publish gate must be empty and, under E2EE,
   * the session active with a leg send key derived. The first run is given
   * the mode the tap read; the second the mode current once the sheet
   * closes, and only after the caller checked it is still that one. The
   * binding key read before `connect()` re-checks the mode for itself.
   */
  #androidLegRefusedNow(mode: CallMode | undefined): boolean {
    return (
      this.#publishGate.size > 0 ||
      (mode?.kind === "e2ee" &&
        (this.#mlsSession?.state() !== "active" ||
          !this.#mlsKeyProvider?.lastLocalScreenKey()))
    );
  }

  /**
   * May a leg in a call of this mode connect WITHOUT a key? Asked by the
   * binding key read before `connect()` for every mode but `e2ee`, which
   * takes the keyed path instead. The evidence is `CallMode` and
   * `callModeTransition` in `mlsCallModePolicy.ts`:
   *
   * - `undefined`: no session, or a shell that cannot encrypt (a plain call;
   *   reset at every call boundary). A capable shell's session that has not
   *   reached its first verdict also reads `undefined`, but `connect()` holds
   *   the `negotiating` gate for it from before the Room connects, and every
   *   leg check refuses a held gate on its own.
   * - `off`: not an E2EE call, publishing normally; terminal in the machine.
   * - `interlude` with `localConfirmed`: this device's user confirmed
   *   plaintext (`local_confirm` turns E2EE off and releases the gate).
   *
   * Everything else is refused: `negotiating` (gated, no verdict), `mixed`
   * (paused), an unconfirmed `interlude` (a remote announce, which never
   * resumes publishing), `call_full` (terminal) and `e2ee` itself. The switch
   * is exhaustive, so a new mode fails to compile here rather than starting a
   * plaintext leg.
   */
  #legPlaintextAuthorized(mode: CallMode | undefined): boolean {
    if (mode === undefined) return true;
    switch (mode.kind) {
      case "off":
        return true;
      case "interlude":
        return mode.localConfirmed;
      case "negotiating":
      case "mixed":
      case "call_full":
      case "e2ee":
        return false;
    }
    const exhaustive: never = mode;
    return exhaustive;
  }

  /**
   * A start attempt's stale exit: tear down, and tell the user when nobody
   * else will. `staleExitNotice` is read BEFORE the stop bumps the
   * generation. Exactly one notice per attempt: it answers `gate-start` only
   * for a stale but NOT cancelled attempt (a gate reason held since before
   * the claim), while `#pauseGate` answers `gate-start` only for a pulse
   * DURING the attempt — and that pulse's stop bumps the generation, so the
   * attempt is cancelled here and this answers none. The catch never runs
   * for these exits; they return.
   *
   * The `gate-start` answer is DEFENSE IN DEPTH, unreachable in production
   * today: the second `#androidLegRefusedNow` check runs synchronously right
   * before the claim, so no reason is held AT the claim, and every later gate
   * add goes through `#pauseGate`, which bumps the generation — the attempt
   * then reads as cancelled and this answers none. It stays so that a gate
   * add that bypasses `#pauseGate`, or an await slipped in ahead of the claim,
   * still tells the user instead of aborting silently.
   */
  async #exitStaleAndroidLegStart(
    generation: number,
    room: Room,
  ): Promise<void> {
    const notice = staleExitNotice(this.#androidLegWorld(generation, room));
    await this.#stopAndroidLeg();
    if (notice === "gate-start") this.onErr(new Error(LEG_GATE_START_NOTICE));
  }

  /**
   * The copy for a native stop's [LegStopNotice] (`nativeStopNotice`), or
   * undefined for `none`. The gate kinds never come from a native stop; they
   * map here too so the switch stays exhaustive.
   */
  #legStopNoticeMessage(notice: LegStopNotice): string | undefined {
    switch (notice) {
      case "none":
        return undefined;
      case "connection":
        // Ingress removes a leg on the primary's reconnect/network switch
        // with no grace (§7.5), and a full native reconnect cannot
        // re-acquire the single-use consent (probe (c-iv)) — same UX.
        return "Your screen share ended because the connection changed. Share again when you're ready.";
      case "encryption":
        return LEG_REKEY_STOPPED_NOTICE;
      case "revoked":
        return LEG_REVOKED_NOTICE;
      case "gate-start":
        return LEG_GATE_START_NOTICE;
      case "gate-share":
        return LEG_GATE_SHARE_NOTICE;
      default: {
        const unknownNotice: never = notice;
        void unknownNotice;
        return undefined;
      }
    }
  }

  /**
   * The copy for a failed leg re-key's [RekeyFailureNotice]
   * (`rekeyFailureNotice`), or undefined for `none`. Shared by both re-key
   * sites: the rotation listener and `#syncLegKeyAfterConnect`.
   */
  #rekeyFailureMessage(n: RekeyFailureNotice): string | undefined {
    switch (n) {
      case "none":
        return undefined;
      case "stopped":
        return LEG_REKEY_STOPPED_NOTICE;
      case "unstoppable":
        return LEG_REKEY_UNSTOPPABLE_NOTICE;
      default: {
        const unknownNotice: never = n;
        void unknownNotice;
        return undefined;
      }
    }
  }

  /**
   * Close the last gap in the start path: a rotation that landed between the
   * key read above and `connect()` resolving was seen by `onLocalScreenKey`
   * while the leg was not yet `active()`, so it was dropped. The provider's
   * record is authoritative, so compare against it and push if it moved.
   *
   * 🔴 Residual, and it needs NATIVE work to close: the leg publishes the
   * instant `connect()` resolves, so frames encrypted under the previous
   * epoch's key can leave the phone for the length of one bridge round-trip.
   * Shrinking that from "the length of an OS consent dialog" to "one round
   * trip" is what this does; eliminating it needs the epoch carried across
   * the bridge so native can refuse to publish under a superseded key.
   */
  async #syncLegKeyAfterConnect(
    leg: AndroidScreenLeg,
    connectedWith: LegE2EEKey | undefined,
  ): Promise<void> {
    const action = keyActionAfterConnect(
      connectedWith,
      this.#mlsKeyProvider?.lastLocalScreenKey(),
    );
    if (action.kind === "none") return;
    try {
      if (action.kind === "stop")
        // The group re-established while the leg connected: its key belongs
        // to a superseded group and no push can fence it onto the new one.
        throw new Error("screen leg key is from a different group");
      await leg.setFrameKey(action.key);
    } catch {
      // Fail closed, exactly as the rotation listener does: a leg that cannot
      // take the current epoch's key must not keep publishing under the old.
      // Read BEFORE the stop, by the rotation listener's rule: a leg already
      // stopping (a gate-share, a tap, a hang-up) or no longer `active()` (a
      // revoke, a native error, a disconnect) was ended by something that
      // already said why — or deliberately said nothing — so "stopped"
      // would only contradict it. The stop runs either way. A stop that
      // FAILED or timed out is reported regardless, as `unstoppable`
      // (`rekeyFailureNotice`): the leg is still `active()` after it for the
      // SAME share (`shareToken()`, sampled before the stop, is unchanged),
      // so the share is live and the user is told to leave the call. No
      // rejection out of here and no retry, as in the listener.
      const token = leg.shareToken();
      const spoken = leg.stopping() || !leg.active();
      await this.#stopAndroidLeg();
      const message = this.#rekeyFailureMessage(
        rekeyFailureNotice({
          spoken,
          activeAfterStop: leg.active() && leg.shareToken() === token,
        }),
      );
      if (message) this.onErr(new Error(message));
    }
  }

  /** Map the route's refusals to copy (§3); pass anything else through.
   * `NO_LEG_NOTICE` means "no notice" — the caller skips its toast. */
  #androidScreenShareError(error: unknown): unknown {
    // A NATIVE-side cancellation that JS did not ask for — the leg's own room
    // was torn down mid-connect (the 10 s token expiring, a server close, an
    // E2EE sender fault). JS-side cancellations never reach here (they are
    // filtered as `wasCancelled`), and the native `stopped` event cannot
    // speak for this one either: the leg never reported started, so its
    // announcement is suppressed. Without this the raw bridge string reached
    // the toast.
    const message = (error as { message?: string })?.message;
    if (
      typeof message === "string" &&
      message.includes("connect_failed: cancelled")
    )
      return new Error("Your screen share couldn't start. Try sharing again.");
    // A revoke that cancelled the connect (C8): the server took the leg's
    // publish permission away mid-start. Read the same way as a native
    // `stopped{"revoked"}` — and, like it, silent when the primary lost
    // publishing too (its own toast explains), which returns `NO_LEG_NOTICE`.
    // EXACT match: the plugin rejects a revoke-cancelled connect with exactly
    // this text (`call.reject("connect_failed: revoked")`, which Capacitor
    // surfaces verbatim as the error's `message`), while every other failed
    // connect is `connect_failed: <the native exception's message>` — a
    // substring match would silence any of those that merely contained it.
    if (message === "connect_failed: revoked") {
      const text = this.#legStopNoticeMessage(
        nativeStopNotice("revoked", {
          canPublish: this.room()?.localParticipant.permissions?.canPublish,
          inAfkChannel: this.isAfkChannel,
        }),
      );
      return text === undefined ? NO_LEG_NOTICE : new Error(text);
    }
    const type = (error as { type?: string })?.type;
    switch (type) {
      case "FeatureDisabled":
        return new Error(
          "Screen sharing from Android isn't available on this server yet.",
        );
      case "NotInVoiceChannel":
      case "FailedValidation":
        return new Error(
          "You can only share your screen from the device that's in the call.",
        );
      case "VideoCallFull":
        return new Error(
          "The call is full for video right now — try again when someone stops sharing.",
        );
      default:
        return error;
    }
  }

  /**
   * Wire the leg controller once (plugin listeners are app-lifetime).
   * Callbacks own the §7.4 signal/sound/toast plumbing.
   */
  #ensureAndroidLeg(): AndroidScreenLeg {
    if (this.#androidLeg) return this.#androidLeg;
    const leg = createAndroidScreenLeg();
    if (!leg) throw new Error("native screen share unavailable");
    leg.onStarted = () => {
      this.#setScreenshare(true);
      this.sound.playSound("streamStart");
    };
    leg.onStopped = (reason) => {
      this.#setScreenshare(false);
      this.sound.playSound("streamEnd");
      // `user`/`system` (stops taken on this device) say nothing; a revoke
      // says nothing when the primary lost publishing too — its own AFK /
      // moderator-mute toast explains, and `inAfkChannel` covers the leg's
      // revoke landing before the primary's.
      const text = this.#legStopNoticeMessage(
        nativeStopNotice(reason, {
          canPublish: this.room()?.localParticipant.permissions?.canPublish,
          inAfkChannel: this.isAfkChannel,
        }),
      );
      if (text !== undefined) this.onErr(new Error(text));
    };
    leg.onMuted = (muted) => {
      if (muted)
        this.onErr(
          new Error(
            "The server turned off your screen share — the share may be an unsupported shape, or the call may be full for video. You're still in the call.",
          ),
        );
    };
    this.#androidLeg = leg;
    return leg;
  }

  /**
   * The §7.4 funnel: every stop hook lands here. Fire-and-forget safe — the
   * native stop is idempotent, and the server side (SFU timeout + ingress
   * leg-left) clears state even if the bridge call is lost.
   */
  async #stopAndroidLeg(): Promise<void> {
    // Bump FIRST, and unconditionally: this is what cancels a start attempt
    // that is mid-`connect()` and therefore invisible to `active()`. Doing it
    // before the early return matters — the hook that fires while nothing is
    // running yet is exactly the one that must orphan the attempt.
    this.#androidLegGeneration++;
    const leg = this.#androidLeg;
    if (!leg) return;
    // `active()` alone was the bug: between `prepare()` and `connect()`
    // resolving the OS is already capturing under a granted consent, so a
    // hook that trusted `active()` left the share to come up into a call that
    // had ended. `#androidLegStartingFor` covers exactly that window; native
    // `stop()` is idempotent, so a redundant call is free.
    if (!leg.active() && this.#androidLegStartingFor === undefined) return;
    await leg.stop();
    // Only reflect "not sharing" once the leg agrees: a REJECTED bridge stop
    // leaves `active()` true (native may still hold the MediaProjection), and
    // showing the share as ended while the phone still captures is the lie
    // the §7.4 funnel exists to prevent. The next hook — or the user's next
    // tap — retries the stop.
    if (!leg.active()) this.#setScreenshare(false);
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
   * Every REMOTE publication in the current call, shaped for the watch
   * policy (`screenShareWatchPolicy.ts`). Reactive through `room()` and
   * `callParticipantsVersion()`: the Room's participant and publication maps
   * are not signals, and every remote publish, unpublish, join and leave
   * bumps that version (the gate (b) domain uses it the same way).
   *
   * `isSelfLeg` is compared by DEVICE, as `#isSelfLegTrack` does: another of
   * our devices' legs is a genuine remote share and is watchable.
   */
  #remoteSharePubs(): WatchPub[] {
    void this.callParticipantsVersion();
    const room = this.room();
    if (!room) return [];
    const local = room.localParticipant.identity;
    const pubs: WatchPub[] = [];
    for (const participant of room.remoteParticipants.values()) {
      const identity = participant.identity;
      const isSelfLeg = isScreenLeg(identity) && stripLeg(identity) === local;
      for (const pub of participant.trackPublications.values())
        pubs.push({ identity, source: pub.source, isLocal: false, isSelfLeg });
    }
    return pubs;
  }

  /** Reactive: whether the viewer is watching this identity's share. */
  isWatchingShare(identity: string): boolean {
    return this.watchedShares().has(identity);
  }

  /**
   * Start receiving a remote screen share (the Watch button). A no-op unless
   * `identity` is publishing ScreenShare or ScreenShareAudio right now and is
   * neither us nor our own screen leg: a watch recorded for a share that has
   * already ended would otherwise sit in the set and silently apply to that
   * identity's NEXT share, which must need a new Watch.
   */
  watchShare(identity: string): void {
    const current = untrack(this.watchedShares);
    if (current.has(identity)) return;
    const live = untrack(() => liveShareIdentities(this.#remoteSharePubs()));
    if (!live.has(identity)) return;
    this.#setWatchedShares(watchedAfterWatch(current, identity));
  }

  /**
   * Stop receiving a remote screen share (Stop watching). A no-op when it is
   * not watched.
   *
   * Remote control (plan decision A): if we are controlling this user's
   * machine, the feed we drive against is going away, so capture is
   * hard-paused through the same path as any other lost feed. Matched by
   * USER, not device: `remoteControl.ts` keeps the controlled identity
   * private, and pausing on another of the sharer's devices errs toward
   * less control, never blind control.
   */
  stopWatchingShare(identity: string): void {
    const current = untrack(this.watchedShares);
    if (!current.has(identity)) return;
    this.#setWatchedShares(watchedAfterStop(current, identity));
    const controlling = untrack(this.remoteControl.controlling);
    if (controlling && participantUserId(identity) === controlling.sharerId)
      this.remoteControl.onFeedLost("unwatched");
  }

  /**
   * Reactive: the REMOTE identities of `userId` that are sharing right now
   * (ScreenShare or ScreenShareAudio), legs included (`u:d:screen`,
   * `u::screen`), in room order. Never the local participant or our own
   * device's screen leg, so for our own user id it lists only our OTHER
   * devices' shares.
   */
  shareIdentitiesOf(userId: string): string[] {
    return [...liveShareIdentities(this.#remoteSharePubs())].filter(
      (identity) => participantUserId(identity) === userId,
    );
  }

  /**
   * Reactive: the identity of every REMOTE participant in the room, screen
   * legs (`u:d:screen`) included, publishing or not. The watch prune's
   * `present`. Same reactivity as `#remoteSharePubs`.
   */
  #remoteIdentities(): Set<string> {
    void this.callParticipantsVersion();
    const room = this.room();
    const present = new Set<string>();
    if (!room) return present;
    for (const participant of room.remoteParticipants.values())
      present.add(participant.identity);
    return present;
  }

  /**
   * Empty the watch set (the write is skipped when already empty), and drop
   * its absence record and pending re-prune with it.
   */
  #clearWatchedShares() {
    this.#cancelWatchPrune();
    this.#watchGoneSince = new Map();
    if (untrack(this.watchedShares).size > 0)
      this.#setWatchedShares(new Set<string>());
  }

  #cancelWatchPrune() {
    clearTimeout(this.#watchPruneTimer);
    this.#watchPruneTimer = undefined;
  }

  /**
   * Drop every watch whose share ended, so a re-share needs a new Watch:
   * at once when an identity that never left the room shares nothing; for
   * one that left, `WATCH_ABSENCE_GRACE_MS` after it was first seen absent,
   * unless it is back AND sharing before then. Coming back without sharing
   * neither restarts nor ends the grace. Reacts to the participant and
   * publication domain only; the set is read untracked, so the effect never
   * re-runs on its own write. The re-prune timer dies with the call's track
   * root.
   */
  #pruneWatchedShares() {
    createEffect(() => {
      const live = liveShareIdentities(this.#remoteSharePubs());
      const present = this.#remoteIdentities();
      untrack(() => this.#applyWatchPrune(live, present));
    });
    onCleanup(() => this.#cancelWatchPrune());
  }

  /**
   * One prune pass. The result is a subset of the current set, so an
   * unchanged size means nothing was dropped and the write is skipped. Then
   * exactly one re-prune is armed for the earliest absence deadline (any
   * earlier one is replaced), and it runs this same pass on the room as it
   * is then. Call untracked.
   */
  #applyWatchPrune(live: ReadonlySet<string>, present: ReadonlySet<string>) {
    const current = this.watchedShares();
    const next = pruneWatchedWithGrace({
      watched: current,
      live,
      present,
      goneSince: this.#watchGoneSince,
      now: performance.now(),
      graceMs: WATCH_ABSENCE_GRACE_MS,
    });
    this.#watchGoneSince = next.goneSince;
    if (next.watched.size !== current.size)
      this.#setWatchedShares(next.watched);
    this.#cancelWatchPrune();
    const at = nextWatchPruneAt(next.goneSince, WATCH_ABSENCE_GRACE_MS);
    if (at === null) return;
    this.#watchPruneTimer = setTimeout(
      () => {
        this.#watchPruneTimer = undefined;
        untrack(() =>
          this.#applyWatchPrune(
            liveShareIdentities(this.#remoteSharePubs()),
            this.#remoteIdentities(),
          ),
        );
      },
      Math.max(0, Math.ceil(at - performance.now())),
    );
  }

  /**
   * Remote control needs the sharer's feed (plan decision A): while we are
   * controlling someone, watch every share identity of theirs.
   *
   * ONE chance per identity per session, the `#autoFocusedShares` shape: a
   * controller who then presses Stop watching is not re-watched behind their
   * back (that press has already paused capture, see `stopWatchingShare`).
   * An identity is forgotten once its share ends, by the watch prune's own
   * rule: at once if it never left and shares nothing; if it left, once
   * `WATCH_ABSENCE_GRACE_MS` has passed since it was first seen absent
   * without its share coming back live. So a re-share during the same
   * session is a new share and is watched again, while reconnect churn is
   * the same share and is not. No timer here: an absent identity has nothing
   * to watch, and its expiry is applied when it comes back (a join or a
   * publish re-runs this effect; an expired record forces a re-offer).
   */
  #watchControlledShares() {
    let session: string | undefined;
    let offered = new Set<string>();
    let offeredGoneSince: ReadonlyMap<string, number> = new Map();
    createEffect(() => {
      const controlling = this.remoteControl.controlling();
      if (!controlling) {
        session = undefined;
        offered = new Set<string>();
        offeredGoneSince = new Map();
        return;
      }
      if (controlling.rcSessionId !== session) {
        session = controlling.rcSessionId;
        offered = new Set<string>();
        offeredGoneSince = new Map();
      }
      const identities = this.shareIdentitiesOf(controlling.sharerId);
      const present = this.#remoteIdentities();
      untrack(() => {
        const kept = pruneWatchedWithGrace({
          watched: offered,
          live: new Set(identities),
          present,
          goneSince: offeredGoneSince,
          now: performance.now(),
          graceMs: WATCH_ABSENCE_GRACE_MS,
        });
        offered = kept.watched;
        offeredGoneSince = kept.goneSince;
        for (const identity of identities) {
          if (offered.has(identity)) continue;
          offered.add(identity);
          this.watchShare(identity);
        }
      });
    });
  }

  /**
   * The remote screen-share START chime, on the publication edge "published
   * and unmuted", once per publication (`screenShareTracks`, whose sids the
   * `trackUnpublished` end chime consumes).
   *
   * Why this edge (plan decision A, "Chimes"). The chime used to wait for
   * playback, which click-to-watch makes unreachable for a share nobody
   * watches. And a share still waiting on its sharer's quality dialog is held
   * with `pauseUpstream()` (`#consentHeld`), which livekit reports to the
   * server as a MUTE (`onTrackUpstreamPaused -> onTrackMuted ->
   * updateMuteStatus`), so peers see it muted until the sharer confirms and
   * the resume unmutes it. Gate pauses (negotiating, mixed call) mute and
   * unmute a live share the same way, hence once per publication.
   *
   * Not airtight: outside the held-gate (born-paused) path the consent pause
   * lands only after an await or two past the publish (the shield attach,
   * the screen-audio probe), so a peer can see the share published UNMUTED
   * for that moment and chime at the dialog rather than at the confirm. The
   * old playback chime had the same window whenever a frame got through.
   *
   * Local publications never get here through `trackPublished`, but
   * `trackUnmuted` is emitted for them too; they and our own screen leg are
   * chimed by the share paths themselves, never here.
   */
  #remoteShareStartChime(
    room: Room,
    pub: { source: Track.Source; trackSid: string; isMuted: boolean },
    participant: { identity: string; isLocal: boolean },
  ) {
    if (!this.#isChimeableRemoteShare(room, pub, participant)) return;
    if (this.screenShareTracks.has(pub.trackSid)) return;
    this.screenShareTracks.add(pub.trackSid);
    this.sound.playSound("streamStart");
  }

  /**
   * Record every remote share that is live right now for the end chime,
   * WITHOUT a start chime: at `connected` (shares already running when we
   * joined) and at `reconnected` (shares our own full reconnect unwound).
   * Only those `#remoteShareStartChime` would chime for (unmuted, not our own
   * leg): one still held at its sharer's consent dialog chimes when it
   * unmutes, and one cancelled there never chimes at all.
   */
  #seedLiveRemoteShares(room: Room) {
    for (const p of room.remoteParticipants.values()) {
      const pub = p.getTrackPublication(Track.Source.ScreenShare);
      if (pub && this.#isChimeableRemoteShare(room, pub, p))
        this.screenShareTracks.add(pub.trackSid);
    }
  }

  /**
   * Whether this publication is a remote ScreenShare on the chime edge:
   * published, unmuted, and neither local nor our own device's screen leg.
   * Shared by the start chime and `#seedLiveRemoteShares`, so a share the
   * start chime would skip is never seeded for an end chime either.
   */
  #isChimeableRemoteShare(
    room: Room,
    pub: { source: Track.Source; isMuted: boolean },
    participant: { identity: string; isLocal: boolean },
  ): boolean {
    if (pub.source !== Track.Source.ScreenShare) return false;
    if (participant.isLocal) return false;
    const identity = participant.identity;
    if (
      isScreenLeg(identity) &&
      stripLeg(identity) === room.localParticipant.identity
    )
      return false;
    return !pub.isMuted;
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
  /**
   * Whether this track belongs to OUR OWN Android screen leg (§7.3 / §0.9).
   * Compared by DEVICE, not user: another of our devices' legs is a genuine
   * remote share we render like anyone else's.
   */
  #isSelfLegTrack(t: TrackReferenceOrPlaceholder): boolean {
    const identity = t.participant.identity;
    if (!isScreenLeg(identity)) return false;
    const local = this.room()?.localParticipant.identity;
    return local !== undefined && stripLeg(identity) === local;
  }

  #watchScreenShareFocus() {
    createEffect(() => {
      const shares = this.vidTracks().filter(
        (t) =>
          t.source === Track.Source.ScreenShare &&
          "publication" in t &&
          t.publication &&
          // The sharer's own phone never auto-focuses its own leg (§7.3c):
          // the tile is a "You're sharing" placeholder, not the video.
          !this.#isSelfLegTrack(t),
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
        // "Hide participants without video" (plan decision B): with the
        // filter on and 2+ live videos, the videos sit side by side at equal
        // size instead. The share's one chance is still spent above, so
        // turning the filter off later never yanks the view to it.
        if (
          this.#settings.hideNonVideoParticipants &&
          liveVideoCount(this.vidTracks()) >= 2
        )
          return;
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
          (t) =>
            "publication" in t &&
            t.publication &&
            // Never auto-pick our own leg (§7.3c) — its tile has no video.
            !this.#isSelfLegTrack(t),
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

  /**
   * Why a join affordance for `channel` must be inert right now, if it must
   * (joinRefusalPolicy): an attempt for it is in flight, or the server's
   * last answer for it was a terminal refusal that still holds. Reactive:
   * re-evaluates on the attempt settling, on a new refusal and on the
   * latch's release (channel event or hold timer).
   */
  joinBlocked(channel: Channel): JoinBlockedReason | undefined {
    return this.#joinBlockedWith(channel, this.joinPending());
  }

  /**
   * Whether a refusal latch still holds for `channel`, whatever attempt is in
   * flight. F4 asks from INSIDE `#connectAttempt`, where `connect()` has
   * already set `joinPending` to this very channel, so `joinBlocked(channel)`
   * answers "in-flight" there and never "refused".
   */
  #refusalLatchHolds(channel: Channel): boolean {
    return this.#joinBlockedWith(channel, undefined) === "refused";
  }

  /** `joinBlocked`, with the in-flight channel supplied by the caller. */
  #joinBlockedWith(
    channel: Channel,
    inFlightChannelId: string | undefined,
  ): JoinBlockedReason | undefined {
    const latch = this.#joinRefusals().get(channel.id);
    return joinBlockedReason({
      channelId: channel.id,
      now: Date.now(),
      channelVersion: this.#channelVersions.get(channel.id) ?? 0,
      inFlightChannelId,
      latch,
      // A `DeviceNotRegistered` refusal is answered by the device claim that
      // lands a beat later: once the corroborated verdict is in, the next
      // attempt withholds the very device id the server rejected, so the
      // server's answer WILL differ and holding the user for the rest of the
      // 30 s is punishing them for a race. The claim needs two WS round trips
      // plus an HTTP GET after `ready`, so a cold start straight into a call
      // — the Answer button on a push notification — loses its first attempt
      // every single time without this (media-e2ee-reviewer round 3,
      // finding 4). Nothing here trusts the refusal itself: the release is
      // driven by state the CLIENT corroborated.
      // The scoping — only a latch the verdict PRECEDED — lives in
      // `refusalSuperseded` with its own spec; this is the wiring.
      superseded: refusalSuperseded(latch, this.#deviceRefusedAt()),
    });
  }

  /**
   * WHEN the corroborated "the server does not accept this device" verdict was
   * raised (`deviceOwnedElsewhere`), or undefined while it is not. Reactive —
   * a `ReactiveMap` read — so everything derived from it re-runs when the
   * device claim settles. The instant belongs to the VERDICT, stamped where it
   * is written; a time stamped on first observation would make the
   * refusal-supersession comparison depend on who happened to look.
   */
  #deviceRefusedAt(): number | undefined {
    const bridge = this.getClient()?.e2ee as E2EEBridge | undefined;
    // BOTH verdicts, earliest first. Only the server-derived one was read
    // before, so a server that keeps answering the device directory "present"
    // held `refusalSuperseded` off while the LOCAL verdict stood — and the
    // client really does withhold the device id on the next attempt, so the
    // user ate the full 30 s punish window on every join for an answer we
    // already knew had changed (media-e2ee-reviewer, MEDIUM-7).
    const times = [
      bridge?.deviceOwnedElsewhere.get("state"),
      bridge?.storeOwnedByAnotherAccount.get("state"),
    ].filter((at): at is number => at !== undefined);
    return times.length ? Math.min(...times) : undefined;
  }

  /**
   * The user-facing reason behind a holding refusal for `channel` — what the
   * dialog said, for the affordance to keep showing. Undefined when no
   * refusal holds (an in-flight attempt is `joinBlocked`'s business).
   */
  joinRefusalMessage(channel: Channel): string | undefined {
    if (this.joinBlocked(channel) !== "refused") return undefined;
    const latch = this.#joinRefusals().get(channel.id);
    return latch && this.#joinRefusalText(channel, latch.reason);
  }

  #joinRefusalText(channel: Channel, reason: JoinRefusalReason): string {
    switch (reason) {
      case "NotAVoiceChannel":
        return channel.type === "Group"
          ? t`Calls are turned off for this group. The group owner can turn them on in the group settings.`
          : t`Calls aren't available in this channel.`;
      case "MissingPermission":
        return t`You don't have permission to join calls in this channel.`;
      case "CannotJoinCall":
        return t`The call is full. Try again when someone leaves.`;
      case "DeviceNotRegistered":
        // 🔴 The specific sentence only when the CLAIM has corroborated it.
        // On an inherited store the Encryption page reads "on" (the snapshot
        // is the previous owner's), so "fix it there" means the disable flow —
        // which wipes local E2EE state including stored encrypted messages.
        // delta builds this refusal with a catch-all `map_err`, so a database
        // blip says it too, and sending a user to destroy their history over
        // a 400 ms hiccup is not something the app may do
        // (media-e2ee-reviewer round 3, finding 3). Uncorroborated, we report
        // the server's answer and nothing more; the corroborated case
        // resolves itself within a reconnect anyway.
        return this.#deviceRefusedAt() !== undefined
          ? t`Encryption on this device isn't registered to your account, so calls can't be joined here. Open Settings → Encryption to fix it.`
          : t`The call server wouldn't accept this device's encryption.`;
      case "MediaE2EEDisabled":
        return t`Encrypted calls are turned off on this server right now.`;
      default:
        // IsBot / FailedValidation / UnknownNode: nothing the user can act
        // on from here; the latch still stops the press-storm.
        return t`The call couldn't be started right now.`;
    }
  }

  /** Latch a terminal refusal for `channel` (joinRefusalPolicy). */
  #recordJoinRefusal(channel: Channel, reason: JoinRefusalReason) {
    const channelVersion = this.#channelVersions.get(channel.id) ?? 0;
    this.#channelVersions.set(channel.id, channelVersion);
    const next = new Map(this.#joinRefusals());
    next.set(channel.id, {
      channelId: channel.id,
      reason,
      at: Date.now(),
      channelVersion,
    });
    this.#setJoinRefusals(next);
    clearTimeout(this.#joinRefusalTimers.get(channel.id));
    this.#joinRefusalTimers.set(
      channel.id,
      setTimeout(
        () => this.#releaseJoinRefusal(channel.id),
        JOIN_REFUSAL_HOLD_MS,
      ),
    );
  }

  /** Drop a latch (channel event or hold timer); no-op without one. */
  #releaseJoinRefusal(channelId: string) {
    clearTimeout(this.#joinRefusalTimers.get(channelId));
    this.#joinRefusalTimers.delete(channelId);
    this.#channelVersions.delete(channelId);
    if (!this.#joinRefusals().has(channelId)) return;
    const next = new Map(this.#joinRefusals());
    next.delete(channelId);
    this.#setJoinRefusals(next);
  }

  /**
   * A channel event that can change the server's join answer: bump the
   * latched channel's version (the pure rule's release condition) and drop
   * the latch in the same step so the affordances react at once. Channels
   * without a latch are not tracked at all.
   */
  #bumpChannelVersion(channelId: string) {
    const version = this.#channelVersions.get(channelId);
    if (version === undefined) return;
    this.#channelVersions.set(channelId, version + 1);
    this.#releaseJoinRefusal(channelId);
  }

  /**
   * Forget every latch. A refusal is a verdict about the user who asked, so
   * on sign-out it must not answer for whoever signs in next — and the
   * release subscription was bound to the client that just went away.
   */
  forgetJoinRefusals() {
    for (const channelId of [...this.#joinRefusals().keys()]) {
      this.#releaseJoinRefusal(channelId);
    }
  }

  get listenPermission() {
    const channel = this.channel();
    if (!channel) return false;
    if (channel.type === "DirectMessage" || channel.type === "Group")
      return true;
    return !!channel.havePermission("Listen");
  }

  /**
   * Whether the channel we are in is the server's designated AFK channel.
   *
   * 🔴 A REACTIVE ACCESSOR, deliberately not a `const` read once inside the
   * one-shot `room "connected"` handler. What shipped before was exactly that
   * — a name check captured at join — which is why the whole feature died the
   * moment anything changed: pressing Unmute defeated it, and renaming a
   * channel granted or removed it. Read through here at every use site so the
   * mic button, the camera button and the toggles all follow a designation
   * that changes mid-call.
   */
  get isAfkChannel() {
    const channel = this.channel();
    return isAfkChannel(channel?.server?.afkChannelId, channel?.id);
  }

  get speakingPermission() {
    const channel = this.channel();
    // 🔴 AFK is folded in here rather than being a permission override,
    // because the backend gate has to sit outside the permission calculus
    // (plan D2): `calculate_channel_permissions` short-circuits to
    // `GrantAllSafe` for the server owner and for privileged accounts, so
    // `havePermission("Speak")` is structurally AFK-blind and stays TRUE in
    // the AFK channel. Without this term the owner's mic button stays
    // enabled and the press fails at the SFU with no explanation.
    return voicePublishPermission({
      hasChannel: !!channel,
      // DMs and group DMs don't have server permissions — always allow.
      isPrivateChannel:
        channel?.type === "DirectMessage" || channel?.type === "Group",
      isAfkChannel: this.isAfkChannel,
      havePermission: !!channel?.havePermission("Speak"),
    });
  }

  /**
   * The camera / screen-share counterpart to {@link speakingPermission}.
   *
   * New: the `Video` permission bit exists and is enforced at the SFU, but it
   * had no client affordance at all, so a denied publish reached the user as
   * an opaque capture error. The toggles below consult this, which makes both
   * a missing `Video` bit and the AFK designation legible instead of silent.
   */
  get videoPermission() {
    const channel = this.channel();
    return voicePublishPermission({
      hasChannel: !!channel,
      isPrivateChannel:
        channel?.type === "DirectMessage" || channel?.type === "Group",
      isAfkChannel: this.isAfkChannel,
      havePermission: !!channel?.havePermission("Video"),
    });
  }

  /**
   * User-facing copy for a refused publish toggle. Kept in `state.tsx` rather
   * than in `afkPolicy.ts` because the lingui macros must stay out of the
   * dependency-free module that `node --test` loads.
   */
  #publishRefusalText(
    refusal: PublishRefusal,
    kind: "microphone" | "camera" | "screenshare",
  ) {
    if (refusal === "afk") {
      if (kind === "microphone")
        return t`You're in the AFK channel, so your microphone stays off for everyone here. Move to another voice channel to talk.`;
      if (kind === "camera")
        return t`You're in the AFK channel, so your camera stays off for everyone here. Move to another voice channel to turn it on.`;
      return t`You're in the AFK channel, so you can't share your screen here. Move to another voice channel to share.`;
    }
    if (kind === "microphone")
      return t`You don't have permission to speak in this channel.`;
    if (kind === "camera")
      return t`You don't have permission to turn on your camera in this channel.`;
    return t`You don't have permission to share your screen in this channel.`;
  }

  /**
   * Gate (d): listen for the E2EE worker's decode witness.
   *
   * All of the judgement — the message-kind and session guards, the sample
   * parse, the three-beat staleness threshold, the one-time console warn and
   * the recovery line — lives in `decodeWitnessListener.ts`, which is pure and
   * loadable by `node --test`. This method is only the wiring that has to
   * touch a `Worker`, a timer and a Solid setter, because a reviewer showed
   * that anything left in THIS file is unspecced and unmutated: gate (d)'s
   * initial value was flipped to an available witness — green by default, the
   * posture the gate exists to remove — with every spec and every mutation
   * still passing.
   *
   * 🔴 ONE-WAY. This may withhold a green. It never resolves a hold, cancels an
   * escalation, clears a latch or promotes anything.
   */
  #armDecodeWitness(session: MlsCallSession): void {
    this.#disarmDecodeWitness();
    const worker = this.#e2eeWorker;
    if (!worker) return;
    const listener = createDecodeWitnessListener({
      now: () => performance.now(),
      onWitness: (witness) => this.#setCallDecodeWitness(witness),
      // Guarded by session identity so a disposed session's queued post can
      // never clobber a newer call's witness.
      isCurrentSession: () => this.#mlsSession === session,
    });
    const onMessage = (ev: MessageEvent) => listener.onMessage(ev.data);
    worker.addEventListener("message", onMessage);
    const stale = setInterval(() => listener.tick(), listener.checkMs);
    this.#decodeWitnessStop = () => {
      worker.removeEventListener("message", onMessage);
      clearInterval(stale);
      listener.stop();
    };
  }

  #disarmDecodeWitness(): void {
    const stop = this.#decodeWitnessStop;
    this.#decodeWitnessStop = undefined;
    stop?.();
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
    // The publications' `isDesired` / `isSubscribed` flip on their own (a
    // Stop watching, a subscription landing) without a participants bump;
    // see `#chipPublicationsVersion`.
    this.#chipPublicationsVersion();
    const room = this.room();
    const session = this.#mlsSession;
    // 🔴 BINDINGS ONLY — nothing is derived here any more. The screen-leg
    // exclusion, the FE-2 publication filter, the observed map, the local
    // declaration and the resecuring disjunction all moved to `chipInputs.ts`,
    // where `node --test` can load them and `rtc-mutations.py` can break them.
    // Three consecutive review rounds found the same defect one line further
    // down the object literal that used to sit here, because nothing in this
    // file is reachable by a spec; the derivation is no longer in it.
    //
    // Accessors rather than values so every signal read still happens inside
    // this memo's tracking scope, exactly where it did when this was inline.
    // 🔴 ONE call, no intermediate value. `chipStateFrom` assembles AND
    // judges, because a `chipInputsFrom(...)` result held here could be spread
    // into a literal that overrides any field — which passed every assertion
    // and every mutation for exactly one commit.
    return chipStateFrom({
      hasSession: () => !!session,
      // Rejoin plan §4.5: the session state via its SIGNAL (driven by
      // `onStateChange`), so a resecuring/failed flip re-runs this — a bare
      // `session.state()` read is non-reactive and left the chip stale.
      sessionState: () => this.callSessionState() ?? session?.state(),
      mode: () => this.callMode(),
      mediaHold: () => this.callMediaHold(),
      // The composite latch, narrowed to what the chip judges on: origin and
      // the send-side snapshot. `mediaKeyed` defaults FALSE — a latch nobody
      // vouched for (the two direct writers here) must never read keyed.
      latch: (): ChipLatch | undefined => {
        const l = this.callEncryptionLatch();
        return l && { origin: l.origin, mediaKeyed: l.mediaKeyed ?? false };
      },
      rosterVerified: () =>
        this.callRoster().members.map((m) => m.user_verified),
      channelHasOpenGroup: () => this.callChannelHasOpenGroup(),
      // The connect-time capability, NOT `settings.e2eeCallsEnabled`: that
      // accessor hard-returns true (media E2EE is mandatory), so passing it
      // collapsed the chip's two no-session branches — a browser took the
      // "capable shell, failed construction" arm. Both return not_encrypted,
      // so the chip never moved; the banner now has to tell them apart.
      // A LOCAL fact, so unlike the open-group probe it cannot go stale: this
      // device could encrypt calls and is not set up to.
      deviceNeedsSetup: () =>
        encryptionSetupAvailable(this.callEncryptionReadiness()),
      // ...and a LIVE one, so it says nothing on a call where there is no
      // encryption to be left out of. A device-qualified identity is minted
      // only for a participant that asked for one, which delta grants only
      // after resolving that device for that user — so its presence is proof
      // someone here can encrypt. Screen legs are their owner's device and
      // count the same.
      //
      // 🔴 `isDeviceQualified`, not `includes(":")`: the leg grammar is always
      // three segments, so a NON-device-qualified peer's leg is `"{user}::
      // screen"` and contains a colon while proving the opposite. And the
      // OWN-leg exclusion matters for the same reason it does in the publisher
      // loop above — `remoteParticipants` contains our own leg, so without it
      // a device that merely started a screen share would light its own chip
      // (media-e2ee-reviewer round 4, MEDIUM).
      peerCouldEncrypt: () =>
        room
          ? anyPeerCouldEncrypt(
              [...room.remoteParticipants.values()].map((p) => p.identity),
              room.localParticipant.identity,
            )
          : false,
      decodeWitness: () => this.callDecodeWitness(),
      observedEncryption: (identity) => this.callEncryption.get(identity),
      // Re-read on every participants-version bump above: a republish
      // registers a new publication, and `trackInfo.encryption` is the
      // declaration receivers arm their cryptors from.
      room: () =>
        room
          ? {
              localIdentity: room.localParticipant.identity,
              participants: [
                {
                  identity: room.localParticipant.identity,
                  publicationCount:
                    room.localParticipant.trackPublications.size,
                },
                ...[...room.remoteParticipants.values()].map((p) => ({
                  identity: p.identity,
                  publicationCount: p.trackPublications.size,
                  // For the share-only contradiction (F2). Read on the same
                  // participants-version bump, and on the chip-only
                  // subscription bump above; with autoSubscribe:false an
                  // unwatched share is undesired from its first publication.
                  publications: chipPublicationsOf(
                    p.trackPublications.values(),
                  ),
                })),
              ],
              localPublications: [
                ...room.localParticipant.trackPublications.values(),
              ].map((pub) => ({
                trackSid: pub.trackSid,
                source: pub.source,
                encryption: pub.trackInfo?.encryption,
              })),
            }
          : undefined,
    });
  }

  /**
   * The user confirmed the whole-call plaintext downgrade (§3.4 T3/T5) from the
   * 6.5 banner. Delegates to the session, which shows the BLOCKING native
   * confirm dialog (native-computed non-enrolled roster) — or, with no usable
   * group / a non-declined dialog failure, the in-app `confirmLocalPlaintext()`
   * — then transitions to a confirmed interlude. `displayNames` labels the
   * natively-selected ids only.
   */
  async confirmCallPlaintext(): Promise<void> {
    const session = this.#mlsSession;
    if (!session) {
      await this.#confirmNoSessionPlaintext();
      return;
    }
    const client = this.getClient();
    const names: Record<string, string> = {};
    for (const identity of this.callNonEnrolled()) {
      const userId = identity.split(":")[0];
      const user = client?.users.get(userId);
      if (user?.username) names[userId] = user.username;
    }
    await session.confirmPlaintext(names);
  }

  /**
   * "Stay unencrypted" for a call that has NO session: the R2-4 hold — an
   * E2EE-capable shell whose session could not be constructed (see
   * `sessionSetupDecision`). The session's `confirmPlaintext` cannot serve
   * it — nor can the in-app `confirmLocalPlaintext()` it routes to without a
   * group — because there is no session object to call either on.
   * The banner press is the explicit consent (`canConfirmNoSessionPlaintext`
   * says why that gives up nothing the dialog protects). Same order as a
   * `local_confirm`: the mode flips to a confirmed interlude BEFORE the
   * resume, so no frame leaves while the banner still promises a pause, and
   * the chip stays NOT-ENCRYPTED (the latched error keeps it red). No
   * `set_e2ee(false)`: the Room's send path was never enabled — that is the
   * session's `enabled` step — so every publication is plaintext-declared
   * already.
   */
  async #confirmNoSessionPlaintext(): Promise<void> {
    const room = this.room();
    if (
      !room ||
      !canConfirmNoSessionPlaintext({
        hasSession: this.#mlsSession !== undefined,
        e2eeCapable: this.callE2EECapable(),
        latchedError: this.callEncryptionError() !== undefined,
        gateHeld: this.#publishGate.has("negotiating"),
      })
    ) {
      return;
    }
    // Confirmed in-app (no native dialog ran, so no announcement either):
    // stamped `"app"` so the interlude is NOT sticky across a re-secure.
    this.#setCallMode({
      kind: "interlude",
      localConfirmed: true,
      confirmedVia: "app",
    });
    await this.#resumeGate(room, "negotiating");
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
   * Whether the Room for THIS call was actually built with the `e2ee` option —
   * i.e. both pieces it needs are present. Capability is not re-tested here
   * because neither field is ever constructed outside the `if (e2eeCapable)`
   * block that builds them.
   *
   * `callE2EECapable()` used to imply this — a provider or worker that failed
   * to construct dropped capability with it. It no longer does: that failure
   * is a loud HOLD now (see `connect()`), so a capable call can have no
   * provider and no worker, and the Room is built without the option. The one
   * reader that depends on the equivalence is `RoomAudioManager`'s
   * missing-manager probe, which uses it to tell a benign absence from an SDK
   * rename that would leave the arming transform installed and unreachable —
   * a warning that must stay meaningful.
   *
   * Deliberately not reactive: both fields are set once during `connect()`,
   * before anything that reads this runs, and every reader is inside an
   * event-driven sweep rather than a tracked scope.
   */
  callE2EERoomArmed(): boolean {
    return this.#mlsKeyProvider !== undefined && this.#e2eeWorker !== undefined;
  }

  /**
   * Which banner the call card owes this call, on two axes — `kind` (which
   * surface, incl. `securing` through the held-gate stretch of a join) and
   * `pause` (what the second line may say about the gate). The single
   * derivation the banner component and `WatchOverlay` switch on, so the
   * invariant it enforces (a red chip is never a dead end) and the one it
   * withdraws (a "stay paused" line over a wire the sweep proved live) are
   * both decided in one unit-tested place (`callBanner` in
   * `mlsCallModePolicy.ts`).
   *
   * `hasSession` is the same non-reactive `#mlsSession` read the plaintext
   * escape uses; re-evaluation rides the `callSessionState` signal, which is
   * written immediately after the session is assigned (and cleared with it),
   * and which `callEncryptionChip()` already reads inside this derivation.
   * `pauseDisproofConfirmed` gates `pause === "disproved"`: a budget-exhausted
   * single observation (`{ value: true, confirmed: false }`) stays `"held"`
   * with hedged copy, so this is the confidence sibling's first runtime read.
   */
  callBanner(): CallBanner {
    return callBanner({
      chip: this.callEncryptionChip(),
      mode: this.callMode(),
      latchedError: this.callEncryptionError() !== undefined,
      readiness: this.callEncryptionReadiness(),
      hasSession: this.#mlsSession !== undefined,
      pauseDisproved: this.callPauseDisproved(),
      pauseDisproofConfirmed: this.callPauseDisproofConfirmed(),
    });
  }

  /**
   * Whether the banner's plaintext release would release anything — the pure
   * `plaintextReleaseAvailable` rule, which owns the reasoning and the spec.
   */
  callCanStayUnencrypted(): boolean {
    return plaintextReleaseAvailable({
      mode: this.callMode(),
      hasSession: this.#mlsSession !== undefined,
      e2eeCapable: this.callE2EECapable(),
      latchedError: this.callEncryptionError() !== undefined,
    });
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
    // Count DEVICES, not SFU participants (plan §6.8): a screen leg is a
    // second participant for a device already counted, so counting raw
    // identities would let two phone shares push a 29-device call over the cap
    // and silently switch everyone's video off. Distinct `stripLeg` values,
    // plus ourselves.
    const devices = new Set<string>();
    for (const p of room.remoteParticipants.values())
      devices.add(stripLeg(p.identity));
    devices.delete(stripLeg(room.localParticipant.identity));
    return devices.size + 1 > MAX_VIDEO_PARTICIPANTS;
  }

  #startPushToTalk(room: Room) {
    this.#stopPushToTalk();

    this.#pttKeydown = (e: KeyboardEvent) => {
      if (!this.#settings.pushToTalk) return;
      if (e.code !== this.#settings.pushToTalkKey) return;
      if (e.repeat) return;
      // Record the hold HERE — above the whisper and already-hot early
      // returns, not next to the `#setMicEnabled` call below. The flag means
      // "a talk key is down", not "this edge turned the mic on": the matching
      // `#pttKeyup` mutes on `isMicrophoneEnabled` alone, so a hold that
      // found the mic already hot still ends in a mute, and a mute keybind
      // pressed in between would still be inverting against the wire. Set
      // after the setting/key/repeat guards so a press that PTT ignores
      // outright cannot set a flag nothing will clear.
      this.#pttHeld = true;
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
      // 🔴 The clear is ABOVE both remaining guards, and the asymmetry
      // against the set in `#pttKeydown` is deliberate: clear more eagerly
      // than you set. Turning push-to-talk off mid-hold makes the
      // `!pushToTalk` guard below return early, and the mic-state guard does
      // the same for a hold during a whisper — either would strand the latch.
      // Matched on physical key identity alone, exactly as the native hook
      // matches releases (see `bindingMatchesRelease` in `globalKeybinds`):
      // this handler already compares no modifiers, so a chord released in
      // any order still lands here.
      if (e.code === this.#settings.pushToTalkKey) this.#pttHeld = false;
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
          // Set above the whisper / already-hot returns for the same reason
          // as the focused handler, and AFTER the disarm branch above: a
          // disarm emits no `ptt:up`, so a flag set on that path would never
          // be cleared by an event.
          this.#pttHeld = true;
          // AFK idle watch: a talk-key press is activity even with the window
          // unfocused, which is the whole reason the global hook exists.
          this.#noteIdleActivity();
          // Suppressed during a whisper, same as the focused handler.
          if (this.whisper.target()) return;
          if (room.localParticipant.isMicrophoneEnabled) return;
          void this.#setMicEnabled(room, true).catch(() => {});
        });
        const up = await tauri.event.listen<void>("ptt:up", () => {
          // Above the guards, same eager-clear rule as `#pttKeyup`. This is
          // the up edge the native side promises for every down it emitted —
          // including the synthetic ones from `sweep_stuck_downs` and
          // `fire_panic`, which exist precisely so a hold that lost its real
          // key-up still ends.
          this.#pttHeld = false;
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
    // 🔴 Native `disarm()` stores `IS_DOWN = false` itself and its doc is
    // explicit that no `ptt:up` follows ("the frontend force-disables the mic
    // on the paths that call this"). So the up edge that would clear the
    // latch is not coming, and the drop has to happen HERE — before the
    // listeners go away, so it cannot depend on one of them.
    this.#pttHeld = false;
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
    // FIRST, and not left to `#disarmNativePtt` below: this is the method
    // that takes the DOM `keyup` listener away, so after it runs neither of
    // the real up edges can arrive. Stated here rather than relied upon
    // transitively so a later change to the native path cannot quietly
    // remove the only clear on the web build.
    this.#pttHeld = false;
    if (this.#pttKeydown)
      window.removeEventListener("keydown", this.#pttKeydown);
    if (this.#pttKeyup) window.removeEventListener("keyup", this.#pttKeyup);
    this.#pttKeydown = undefined;
    this.#pttKeyup = undefined;
    void this.#disarmNativePtt();
  }

  /* ------------------------------------------------------------------ *
   * Global keybind dispatch (`@revolt/keybinds/globalKeybinds`)
   * ------------------------------------------------------------------ */

  /**
   * Whether a push-to-talk hold is what is currently holding the microphone
   * open. See `#pttHeld` for the clearing discipline, which is the whole of
   * this feature.
   *
   * Not reactive, and the same shape/reason as {@link callAudioContext}: it
   * is read at the instant of a keypress by code that is not a computation,
   * so a signal would buy nothing and would add a re-render on every hold.
   */
  pttActive(): boolean {
    return this.#pttHeld;
  }

  /**
   * THE entry point for every global keybind. Nothing else in this class is
   * a keybind target; the arming/listening lanes call only this.
   *
   * 🔴 **The decision is not here.** {@link decideKeybindDispatch}
   * (`./keybindDispatchPolicy`) owns all five guards, their ORDER and their
   * named reasons, and carries the production failure each one prevents.
   * This method owns only the mutable state those guards read
   * (`#keybindInFlight`, `#keybindLastAccepted`, `#pttHeld`), the signal
   * reads that feed them, and the side effects. The split exists because the
   * guards had ZERO automated coverage while they lived here: this file is a
   * `.tsx` that imports `livekit-client/e2ee-worker?worker` and four other
   * Vite-only or aliased specifiers, so no unit runner can load it, and no
   * `components/rtc/*.test.ts` does.
   *
   * {@link KEYBIND_REQUIREMENT} is indexed here and never defaulted: an id
   * that is not a `GlobalKeybindAction` reads `undefined` there, and
   * `undefined` matches no `case` in the policy's requirement switch, whose
   * `never` arm then `return`s `undefined` — no verdict at all. That is not
   * benign: reading `.accept` off it throws a `TypeError` at the guard below,
   * which sits OUTSIDE this method's `try` (that wraps only `#runKeybind`),
   * so the throw escapes as an unhandled rejection from a keypress the user
   * may have made in another application — the outcome the precondition guard
   * exists to prevent. The optional read (`!verdict?.accept`) is what makes
   * that case fail CLOSED, i.e. indistinguishable from any other silent
   * rejection. Three layers keep it from arising at all: the parameter type
   * here, `isGlobalKeybindAction` at the wire boundary, and the policy's
   * `never` arm as a compile error if a fourth `KeybindRequirement` is added.
   *
   * A rejected press is dropped SILENTLY and never queued. There is no
   * feedback channel for a key pressed while unfocused, and a modal is the
   * specific outcome the precondition guard exists to prevent.
   *
   * Resolves when the action settles. Never rejects: the `catch` is
   * `console.error`, not `onErr`, because the paths that genuinely owe the
   * user a dialog already raise one themselves (`#captureFailed`,
   * `connect()`'s own `onErr`) — and turning every other failure into a
   * modal is exactly what makes an unfocused keypress hostile.
   */
  async dispatchKeybind(action: GlobalKeybindAction): Promise<void> {
    // AFK idle watch: a keybind press is activity whatever the guards below
    // make of it — even a press they drop proves someone is at the keys,
    // including one made while this window is unfocused.
    this.#noteIdleActivity();
    const now = performance.now();
    // Untracked for the reason the precondition read always was: `room()`,
    // `incomingCall()` and `fullscreen()` are signals, and this can be
    // reached from inside a computation (an in-app `keydown` handler created
    // in an effect), where a registered dependency would re-run that
    // computation on every room, ring or fullscreen change.
    const verdict = untrack(() =>
      decideKeybindDispatch({
        action,
        requirement: KEYBIND_REQUIREMENT[action],
        now,
        lastAccepted: this.#keybindLastAccepted.get(action),
        minIntervalMs: KEYBIND_MIN_INTERVAL_MS,
        inFlight: this.#keybindInFlight.has(action),
        hasRoom: this.room() !== undefined,
        hasIncomingCall: incomingCall() !== undefined,
        pttHeld: this.#pttHeld,
        isFullscreen: this.fullscreen(),
      }),
    );
    // 🔴 `verdict?.accept`, not `verdict.accept`. The optional read is the
    // fail-closed half of the comment above: the policy's `never` arm is a
    // compile-time check only, so a `requirement` outside the union still
    // returns `undefined` at runtime, and an unguarded `.accept` off that
    // throws a `TypeError` HERE — outside the `try`, which wraps only
    // `#runKeybind` — i.e. an unhandled rejection from a keypress possibly
    // made in another application, the exact outcome guard 3 exists to
    // prevent. `!undefined?.accept` is `true`, so a verdict-less press is
    // dropped silently like any other rejection.
    if (!verdict?.accept) return;

    // Stamped only for an ACCEPTED press, which is what the constant
    // specifies: a press dropped by a precondition never happened, and
    // stamping it would then rate-limit the first press that CAN run.
    this.#keybindLastAccepted.set(action, now);
    this.#keybindInFlight.add(action);
    try {
      await this.#runKeybind(action);
    } catch (error) {
      console.error(`[rtc] keybind "${action}" failed`, error);
    } finally {
      this.#keybindInFlight.delete(action);
    }
  }

  /** Guards are the caller's ({@link dispatchKeybind}); this only routes. */
  #runKeybind(action: GlobalKeybindAction): Promise<unknown> | void {
    switch (action) {
      // The `*Anywhere` variants, never the bare toggles: they check
      // `#liveToggleReady()` and otherwise write the persisted preference, so
      // they are safe with no room (hence `KEYBIND_REQUIREMENT` "none") where
      // the bare ones throw `"invalid state"` into a modal.
      case "toggle-mute":
        return this.toggleMuteAnywhere();
      case "toggle-deafen":
        return this.toggleDeafenAnywhere();

      case "toggle-camera":
        return this.toggleCamera();

      case "screenshare-stop":
        return this.stopScreenshare();

      // The full toggle, as the button uses. A press while already sharing
      // therefore STOPS — the same behavior the user has from the control
      // this is bound to, and the benign direction. The dangerous direction
      // (a "stop" key that starts a share) is what `stopScreenshare` exists
      // for. `"in-app"` tier, so this is only ever reached from a focused
      // keydown — `getDisplayMedia` has no transient activation otherwise.
      case "screenshare-start":
        return this.toggleScreenshare();

      case "disconnect-call":
        // Synchronous and genuinely idempotent: it bumps `#connectGen`,
        // stops the ringtone and returns early with no room.
        this.disconnect();
        return;

      case "accept-call":
        return this.#acceptRingingCall();
      case "dismiss-call":
        this.#dismissRingingCall();
        return;

      case "toggle-window":
        return this.#toggleWindowVisible();

      case "toggle-overlay":
        // 🔴 The voice OVERLAY setting, on the settings store this class
        // holds as `#settings` (`@revolt/state/stores/Voice`) — NOT an
        // invoke, and not this rtc singleton, which is also called `Voice`.
        // `OverlayBridgeWorker` arms on
        // `overlayShellAvailable() && state.voice.overlayEnabled`, so the
        // store write IS the toggle and the shell window follows reactively.
        // Writing it with no shell is harmless and correct: the preference
        // persists and the worker stays unarmed.
        this.#settings.overlayEnabled = !this.#settings.overlayEnabled;
        return;

      case "toggle-fullscreen":
        this.toggleFullscreen();
        return;

      case "toggle-theater":
        // The fullscreen precondition this case used to read inline is guard
        // 5 in `./keybindDispatchPolicy` — `KEYBIND_REQUIREMENT` is "none"
        // for theater because it cannot THROW, not because it is
        // unconditional, and without the gate `toggleImmersive()` sets
        // `immersive` and hides the call bar in the normal view where
        // nothing offers a way back. Reaching here means it passed.
        this.toggleImmersive();
        return;

      default: {
        // Exhaustiveness, for the same reason `KEYBIND_REQUIREMENT` is a
        // `Record<GlobalKeybindAction, …>`: a 13th action added to
        // `GLOBAL_KEYBIND_ACTIONS` must be a COMPILE error here, not a row
        // the settings UI renders as bound and which dispatches nothing.
        // Without this arm the switch just falls out returning `undefined`,
        // which is a legal `void` and passes the typecheck silently.
        const unreachable: never = action;
        return unreachable;
      }
    }
  }

  /**
   * STOP-ONLY screen share, for the `screenshare-stop` keybind.
   *
   * 🔴 A separate entry point because `toggleScreenshare()` cannot be used
   * for a stop: it reaches the stop branch only by falling through
   * `this.screenshare()`, and on Android it returns into
   * `#toggleAndroidScreenShare` BEFORE that read, where "not currently
   * sharing" means START — opening the OS consent dialog. A key the user
   * pressed to stop sharing must never be able to begin one, which is also
   * why this is the only `"global"`-tier share action (stopping needs no
   * transient activation; starting does).
   *
   * No-op, never a throw, when there is nothing to stop — unlike
   * `toggleScreenshare`, whose `"invalid state"` is raised outside any try.
   */
  async stopScreenshare(): Promise<void> {
    if (!this.room()) return;
    // The §7.4 funnel, and the honest stop for the phone: it also cancels a
    // start that is mid-`connect()` and therefore invisible to `active()`.
    if (nativeScreenShareAvailable()) {
      await this.#stopAndroidLeg();
      return;
    }
    // Web/desktop: `screenshare()` is true, so `toggleScreenshare()` takes
    // its stop branch — reached synchronously from here, with no await in
    // between for the flag to change under. Reusing it rather than
    // duplicating the teardown keeps the screen-audio token bump, the stale
    // quality dialog close and the shield drop in one place.
    if (!this.screenshare()) return;
    await this.toggleScreenshare();
  }

  /**
   * The `accept-call` keybind's target: exactly the `IncomingCallOverlay`
   * Accept body (stop the ringtone, dismiss the popup, navigate to the
   * conversation, join), reachable from here because `incomingCall` is a
   * module-level signal singleton rather than component state.
   */
  async #acceptRingingCall(): Promise<void> {
    const call = untrack(incomingCall);
    // Re-read after the guard: `dispatchKeybind` checked a ring existed, and
    // nothing has awaited since, but the ring is the one piece of state a
    // timeout can clear on its own (`INCOMING_CALL_TIMEOUT_MS`).
    if (!call) return;
    this.sound.stopRingtone();
    dismissIncomingCall();
    try {
      this.#navigate?.(call.channel.path);
    } catch {
      /* no router — join anyway rather than losing the call to a nav error */
    }
    await this.connect(call.channel);
  }

  /**
   * The `dismiss-call` keybind's target: silence the ring and take the popup
   * down.
   *
   * 🔴 This signals NOTHING to the caller. `dismissIncomingCall` is local
   * only — it clears a module signal, cancels the taskbar attention flash
   * and cancels the Android notification. There is no REST call and no
   * websocket event, so the caller keeps ringing until they give up or the
   * server times the call out. The overlay button labelled "Decline" does
   * exactly this and no more. 🔴 Any UI for this keybind must therefore call
   * it "Dismiss"/"Ignore" and never "Decline" or "Reject".
   */
  #dismissRingingCall(): void {
    this.sound.stopRingtone();
    dismissIncomingCall();
  }

  /**
   * The `toggle-window` keybind's target: show/hide the shell's main window.
   *
   * Through the sanctioned probe, not a local `__TAURI__` read: `tauriInvoke`
   * checks `__TAURI__.core.invoke`, which is present only when
   * `withGlobalTauri` is on AND the window has a capability file — i.e. it
   * doubles as "am I allowed to talk to the shell at all". A copy that
   * checked `__TAURI__` alone would read as available in windows where every
   * call ACL-fails.
   *
   * Undefined off the desktop shell (web, Android, Electron), where there is
   * no window to toggle and the press is correctly inert.
   */
  async #toggleWindowVisible(): Promise<void> {
    const invoke = tauriInvoke();
    if (!invoke) return;
    try {
      await invoke(KEYBIND_COMMANDS.toggleWindowVisible);
    } catch {
      // Older shell without the command, or an ACL refusal. Same
      // focused-only-fallback posture as `#ensureNativePtt`: inert, never a
      // dialog over whatever the user was actually doing.
    }
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
          audio: preferred
            ? { ...VAD_AUDIO_CONSTRAINTS, deviceId: { exact: preferred } }
            : VAD_AUDIO_CONSTRAINTS,
          video: false,
        })
        .catch((error) => {
          if (!preferred) throw error;
          return navigator.mediaDevices.getUserMedia({
            audio: VAD_AUDIO_CONSTRAINTS,
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
      analyser.fftSize = VAD_FFT_SIZE;
      this.#vadCtx.createMediaStreamSource(this.#vadStream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      // "Automatically adjust input sensitivity": the gate follows the room's
      // noise floor instead of the hand-set threshold. Same tracker the
      // settings meter runs, so what the meter shows is what the gate does.
      const auto = createNoiseFloorTracker();
      // Consecutive frames above the threshold; the gate only OPENS after
      // VAD_OPEN_FRAMES of sustained speech, but any single frame above it
      // keeps an already-open gate open (resets the silence countdown).
      let openStreak = 0;
      let lastTick = performance.now();

      const tick = () => {
        // Frames this tick stands in for. On a timer that a throttled window
        // can stretch, "one tick" is no longer "one frame", and both the
        // open streak and the noise floor are tuned in frames.
        const now = performance.now();
        const frames = Math.max(1, (now - lastTick) / VAD_FRAME_MS);
        lastTick = now;

        analyser.getByteFrequencyData(buf);
        const level = levelFromFrequencyData(buf);
        const autoThreshold = auto.update(level, frames);
        const threshold = this.#settings.vadAuto
          ? autoThreshold
          : this.#settings.vadThreshold;

        const decision = vadGateDecision({
          level,
          threshold,
          frames,
          openStreak,
          micLive: room.localParticipant.isMicrophoneEnabled,
          // The user's own mute/deafen outranks voice activity — see
          // `vadGatePolicy.ts` for why this gate cannot read it off the
          // published track.
          userMuted: !this.#settings.micOn || this.#settings.deafen,
          // Voice-activity must not open the room mic while whispering — the
          // aside would otherwise be spoken to the whole call.
          whispering: !!this.whisper.target(),
        });
        openStreak = decision.openStreak;

        if (decision.speaking) {
          clearTimeout(this.#vadSilenceTimer);
          this.#vadSilenceTimer = undefined;
          if (decision.open) {
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
      };

      // A TIMER, not requestAnimationFrame: rAF does not fire at all while
      // the window is hidden or minimized, which is most of a call for anyone
      // who alt-tabs into a game. The gate froze in whichever state it last
      // held — mic stuck shut so the user could not speak until they came
      // back, or stuck open as a hot mic. A call keeps the page audible, so
      // this timer is exempt from background throttling; if it is throttled
      // anyway, `frames` above keeps the arithmetic honest.
      tick();
      this.#vadTimer = setInterval(tick, VAD_TICK_MS);
    } catch {
      // mic access denied — VAD won't run
    }
  }

  /**
   * Trigger the user's entrance sound for this server, if one is chosen. Goes
   * through the ordinary soundboard trigger route (same UseSoundboard
   * permission, same fan-out, same local playback for everyone) after a short
   * beat so the join has settled and the others' clients are listening for
   * us. Best effort: a 403 (no soundboard permission here) or a vanished
   * sound is silently nothing.
   */
  #playEntranceSound(channel: Channel) {
    const serverId = channel.serverId;
    if (!serverId || !this.#entranceSound) return;
    const soundId = this.#entranceSound(serverId);
    if (!soundId) return;
    setTimeout(() => {
      if (this.state() !== "CONNECTED" || this.channel()?.id !== channel.id)
        return;
      void channel.triggerSound(soundId).catch(() => {});
    }, 800);
  }

  #stopVAD() {
    this.#vadGen++;
    if (this.#vadTimer !== undefined) clearInterval(this.#vadTimer);
    clearTimeout(this.#vadSilenceTimer);
    this.#vadStream?.getTracks().forEach((t) => t.stop());
    this.#vadCtx?.close();
    this.#vadTimer = undefined;
    this.#vadStream = undefined;
    this.#vadCtx = undefined;
    this.#vadSilenceTimer = undefined;
  }

  private onErr(e: unknown) {
    if ((e as Error).name !== "NotAllowedError")
      this.openModal({ type: "error2", error: e });
  }

  /**
   * Give this instance the app's snackbar controller, for notices that should
   * not open a modal. `useSnackbar()` cannot be used here: `VoiceContext`
   * constructs this class OUTSIDE `SnackbarProvider`, so the hook would throw.
   * The controller itself is a plain object that `src/index.tsx` builds in
   * `MountContext` BEFORE `VoiceContext` renders, so it can be passed down
   * without calling a hook. The parameter is required, so it cannot be unset
   * once given; readers still fall back to `onErr` before the first call.
   */
  setSnackbar(controller: SnackbarController) {
    this.#snackbar = controller;
  }

  /**
   * Give this instance the member-gate check for move destinations (see
   * `#memberGate`). A setter rather than a hook for the same reason as
   * `setSnackbar`: the answer reads app layout state, and this class is
   * constructed outside anything it could call a hook from.
   */
  setMemberGate(gate: (channel: Channel) => boolean): void {
    this.#memberGate = gate;
  }

  /**
   * Error path for a mic/camera capture: blocked access gets its own message,
   * everything else goes to `onErr` as before. `onErr` drops every
   * NotAllowedError because a cancelled screen-share picker rejects with that
   * name — which also dropped a DENIED microphone on unmute, undeafen and
   * camera-on, leaving the button flipping back with no explanation.
   */
  #captureFailed(error: unknown, kind: "microphone" | "camera") {
    if (isPermissionDeniedError(error)) this.#reportCaptureDenied(kind);
    else this.onErr(error);
  }

  /**
   * Tell the user their microphone/camera is blocked and where to fix it. A
   * plain Error (not the DOMException), so `onErr`'s NotAllowedError filter
   * cannot swallow it; the modal is the same "surfaced signal" the rest of
   * the call plumbing uses for a failure the user must know about.
   */
  #reportCaptureDenied(kind: "microphone" | "camera") {
    this.openModal({
      type: "error2",
      error: new Error(
        kind === "microphone"
          ? t`Microphone access is blocked, so nobody in the call can hear you. Allow the microphone in your system or browser settings, then unmute or rejoin.`
          : t`Camera access is blocked. Allow the camera in your system or browser settings, then try again.`,
      ),
    });
  }
}

const voiceContext = createContext<Voice>(null as unknown as Voice);

/**
 * Mount global voice context and room audio manager
 */
export function VoiceContext(props: {
  children: JSX.Element;
  /**
   * The app's snackbar controller, the same instance `SnackbarProvider` is
   * given in `src/index.tsx`. Required, so dropping it at the mount site is a
   * type error rather than a silent fallback to the `onErr` modal.
   */
  snackbar: SnackbarController;
}) {
  const state = useState();
  const modals = useModals();
  const sound = useSound();
  const voice = new Voice(state.voice, modals, sound, (serverId) =>
    entranceSoundFor(state.settings, serverId),
  );
  // Wired synchronously, before anything can deliver a move: the default
  // refuses every destination. The layout is read inside the closure, at the
  // moment a move arrives, so an unlock earned mid-session counts.
  voice.setMemberGate((channel) =>
    isChannelGatedForMember(
      channel,
      (key) => state.layout.getSectionState(key, false),
      LAYOUT_SECTIONS.MATURE,
    ),
  );
  // A render effect runs synchronously, here, before any child mounts, so the
  // controller is in place before anything can raise a notice, and it still
  // follows the prop if the controller is ever swapped.
  createRenderEffect(() => voice.setSnackbar(props.snackbar));

  // Signing out must end the call, and nothing else does: logout replaces
  // the stoat client, but the LiveKit room is owned HERE and outlived it —
  // the user stayed in the call, floating card and all, on top of the login
  // page, holding a session the server had just revoked. disconnect() is the
  // one teardown choke point (native call service, screen legs, screen
  // audio, MLS session, worker, room) and a no-op when idle. `discardMls`:
  // nothing of this account's MLS state may be kept for a resume past its
  // sign-out, including groups kept from a call that had already ended
  // (plan M9).
  const { lifecycle } = useClientLifecycle();
  onCleanup(
    lifecycle.onSignOut(() => {
      voice.disconnect({ discardMls: true });
      // A join refusal is a verdict about the user who just signed out; it
      // must not answer for whoever signs in next (joinRefusalPolicy).
      voice.forgetJoinRefusals();
    }),
  );

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

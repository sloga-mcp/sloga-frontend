import { State } from "..";

import {
  NORMALIZER_DEFAULT_STRENGTH,
  clampStrength,
} from "../../rtc/audioNormalizer";

import { AbstractStore } from ".";
import {
  OverlayCornerName,
  OverlayDisplayModeName,
  TypeVoiceOverlay,
  cleanOverlaySettings,
  defaultOverlaySettings,
} from "./voiceOverlay";

export { OverlayCornerNames, OverlayDisplayModeNames } from "./voiceOverlay";
export type {
  OverlayCornerName,
  OverlayDisplayModeName,
  TypeVoiceOverlay,
} from "./voiceOverlay";

/**
 * Possible noise suppresion states. Browser is browser noise suppresion and enhanced is machine learning suppression via RNNoise.
 */
export type NoiseSuppresionState = "disabled" | "browser" | "enhanced";

const NoiseSuppresionStates: NoiseSuppresionState[] = [
  "disabled",
  "browser",
  "enhanced",
];

/**
 * Microphone activation mode. Exactly one is active at a time: open mic
 * (always transmitting), voice activity detection, or push to talk.
 */
export type MicrophoneMode = "openMic" | "vad" | "pushToTalk";

/**
 * Possible screen share qualities. Low is 720p@30fps, high 1080p@30fps and
 * text is source@5fps. "game" is 1080p@60fps published as a single encoding
 * (no simulcast) so the full bitrate budget lands on the layer a single
 * viewer actually watches.
 */
export type ScreenShareQualityName =
  | "low"
  | "high"
  | "text"
  | "fhd"
  | "game"
  | "qhd"
  | "uhd";

/**
 * Array of available screen share quality names.
 */
export const ScreenShareQualityNames: ScreenShareQualityName[] = [
  "low",
  "high",
  "text",
  "fhd",
  "game",
  "qhd",
  "uhd",
];

/**
 * The native Android screen-share tiers (screen-leg plan §7.4) — a SEPARATE,
 * smaller ladder than the desktop one: the phone encodes a single VP8 layer
 * next to a live call, so the desktop names would promise rungs the device
 * cannot hold. The tier table itself lives in `rtc/androidScreenShare.ts`;
 * this is only the persisted selection.
 */
export type AndroidScreenShareTierName = "dataSaver" | "default" | "high";

export const AndroidScreenShareTierNames: AndroidScreenShareTierName[] = [
  "dataSaver",
  "default",
  "high",
];

/**
 * Possible camera capture qualities. "auto" lets LiveKit decide; the rest cap
 * the capture resolution/framerate (always further clamped to the server's
 * video_resolution limit at apply time).
 */
export type CameraQualityName = "auto" | "sd" | "hd" | "fhd";

/**
 * Array of available camera quality names.
 */
export const CameraQualityNames: CameraQualityName[] = [
  "auto",
  "sd",
  "hd",
  "fhd",
];

/**
 * Camera background effect mode. "none" = raw camera, "blur" = blurred
 * background, "image" = virtual background image (preset or user upload).
 */
export type CameraBackgroundMode = "none" | "blur" | "image";

/**
 * Array of available camera background modes.
 */
export const CameraBackgroundModes: CameraBackgroundMode[] = [
  "none",
  "blur",
  "image",
];

/**
 * Face-filter (AR sticker) ids. The store owns the VALID id list so `clean()`
 * can validate persisted data without importing from `@revolt/rtc` (which
 * imports this store — a runtime cycle). The rtc catalog maps each id to its
 * art/anchors and a test pins the 1:1 correspondence.
 */
export type CameraFaceFilterId =
  | "dog"
  | "cat"
  | "sunglasses"
  | "mustache"
  | "party-hat"
  | "heart-eyes"
  | "viking"
  | "gamer-headset"
  | "pixel-shades"
  | "health-bar"
  | "wizard-hat"
  | "dragon"
  | "d20"
  | "elf-ears";

/**
 * Array of available face-filter ids.
 */
export const CameraFaceFilterIds: CameraFaceFilterId[] = [
  "dog",
  "cat",
  "sunglasses",
  "mustache",
  "party-hat",
  "heart-eyes",
  "viking",
  "gamer-headset",
  "pixel-shades",
  "health-bar",
  "wizard-hat",
  "dragon",
  "d20",
  "elf-ears",
];

/**
 * Color-look (one-tap grade) ids. Same ownership rationale as
 * {@link CameraFaceFilterIds}.
 */
export type CameraColorLookId = "warm" | "cool" | "vintage" | "mono" | "vivid";

/**
 * Array of available color-look ids.
 */
export const CameraColorLookIds: CameraColorLookId[] = [
  "warm",
  "cool",
  "vintage",
  "mono",
  "vivid",
];

export interface TypeVoice extends TypeVoiceOverlay {
  preferredAudioInputDevice?: string;
  preferredAudioOutputDevice?: string;
  preferredVideoDevice?: string;

  echoCancellation: boolean;
  noiseSupression: NoiseSuppresionState;
  autoGainControl: boolean;

  openMic: boolean;
  vadEnabled: boolean;
  vadThreshold: number;
  /**
   * Voice-activity threshold picked automatically from the ambient noise
   * floor instead of `vadThreshold`. Discord's "Automatically adjust input
   * sensitivity" default.
   */
  vadAuto: boolean;
  pushToTalk: boolean;
  pushToTalkKey: string;

  /**
   * Global attenuation ("duck other apps while someone speaks"), desktop
   * only. Strength 0–100 = how far every OTHER application is lowered while
   * a speaker is active; 0 turns the feature off.
   */
  attenuationStrength: number;
  attenuateWhenISpeak: boolean;
  attenuateWhenOthersSpeak: boolean;

  screenShareQuality: ScreenShareQualityName;
  screenShareQualityAsk: boolean;
  screenShareAudio: boolean;
  /** Pixelate the OS-toast corner of monitor shares when something pops in. */
  screenShareShield: boolean;
  /** Native Android screen-share tier (screen-leg plan §7.4). */
  androidScreenShareTier: AndroidScreenShareTierName;

  microphoneGain: number;
  cameraBrightness: number;
  cameraQuality: CameraQualityName;
  cameraMaxBitrateKbps: number;
  cameraBackgroundMode: CameraBackgroundMode;
  cameraBlurRadius: number;
  cameraBackgroundImageId?: string;
  /** AR sticker filter; undefined = none. Inert while a background is active. */
  cameraFaceFilterId?: CameraFaceFilterId;
  /** Skin-smoothing strength 0–100; 0 (default) = off. */
  cameraBeautify: number;
  /** One-tap color grade; undefined = none. */
  cameraColorLookId?: CameraColorLookId;
  inputVolume: number;
  outputVolume: number;
  deafen: boolean;
  micOn: boolean;
  /**
   * "Encrypt my calls" (media E2EE, slice 6.5 §0.2 #9). LOCAL PER-DEVICE —
   * this store is NOT in the synced set (Sync.ts), deliberately: syncing it
   * would hand the server a write path into the E2EE-attempt gate.
   *
   * INERT as of the mandatory-E2EE change: the accessor always reports true
   * regardless of what is stored here. Kept in the schema so old persisted
   * profiles still parse. Do NOT reintroduce a read of this raw field.
   */
  e2eeCallsEnabled: boolean;

  /**
   * Route remote call audio through livekit's shared Web Audio graph
   * (`RoomOptions.webAudioMix`). ON by default: it is what makes per-user
   * volume above 100% work at all, because the SDK's `setVolume` drives a
   * GainNode instead of `HTMLMediaElement.volume` (which is capped at 1.0),
   * and it re-wires that graph on every track attach — the reason a boosted
   * participant survives a reconnect.
   *
   * Exposed only as a kill-switch: it moves ALL remote audio onto one shared
   * AudioContext, so if that path ever regresses this turns the whole client
   * back to the plain-element path without a redeploy. Turning it off costs
   * boosting — volume is clamped to 100% (see AudioTrack) — but audio plays.
   */
  webAudioMix: boolean;

  /**
   * Level incoming voices automatically (receive-side slow AGC + limiter,
   * rtc/audioNormalizer.ts). OFF by default for v1 — it changes how every
   * call sounds and its echo pressure is unmeasured. Applies to microphone
   * tracks only, never screen-share or unknown-source audio. Requires
   * `webAudioMix`; without the shared context the raw path plays untouched.
   */
  audioNormalization: boolean;

  /**
   * How far normalization may BOOST a quiet talker, 0–100. Scales only the
   * boost clamp (0 → never boost, 100 → +18 dB); taming loud talkers is
   * wanted at every strength so the cut side is fixed. Clamped in `clean()`
   * because the value flows into a live GainNode.
   */
  audioNormalizationStrength: number;

  // The six in-game overlay keys come from `TypeVoiceOverlay` (./voiceOverlay)
  // so their defaults and clamps can be unit-tested without loading the store.

  userVolumes: Record<string, number>;
  userMutes: Record<string, boolean>;

  screenShareVolumes: Record<string, number>;
  screenShareMutes: Record<string, boolean>;
}

/**
 * Handles enabling and disabling client experiments.
 */
export class Voice extends AbstractStore<"voice", TypeVoice> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "voice");
  }

  /**
   * Hydrate external context
   */
  hydrate(): void {
    /** nothing needs to be done */
  }

  /**
   * Generate default values
   */
  default(): TypeVoice {
    return {
      echoCancellation: true,
      // RNNoise by default: it is self-hosted, runs everywhere the app does
      // (AudioWorklet + wasm) and is what the product means by "noise
      // suppression". Existing installs keep whatever they persisted.
      noiseSupression: "enhanced",
      autoGainControl: true,
      openMic: true,
      vadEnabled: false,
      vadThreshold: 20,
      // OFF by default, deliberately. A stored settings blob from before this
      // key existed reads the default, so shipping `true` would silently
      // override a threshold an existing voice-activity user had tuned by
      // hand — a behavior change to the thing that decides whether their
      // microphone opens. They opt in.
      vadAuto: false,
      pushToTalk: false,
      attenuationStrength: 0,
      attenuateWhenISpeak: false,
      attenuateWhenOthersSpeak: true,
      pushToTalkKey: "Space",
      screenShareQuality: "low",
      screenShareQualityAsk: true,
      screenShareAudio: true,
      screenShareShield: false,
      androidScreenShareTier: "default",
      microphoneGain: 100,
      cameraBrightness: 100,
      cameraQuality: "auto",
      cameraMaxBitrateKbps: 0,
      cameraBackgroundMode: "none",
      cameraBlurRadius: 10,
      cameraBeautify: 0,
      inputVolume: 1.0,
      outputVolume: 1.0,
      deafen: false,
      micOn: true,
      // Inert — the accessor always reports true (media E2EE is mandatory).
      e2eeCallsEnabled: true,
      webAudioMix: true,
      audioNormalization: false,
      audioNormalizationStrength: NORMALIZER_DEFAULT_STRENGTH,
      ...defaultOverlaySettings(),
      userVolumes: {},
      userMutes: {},
      screenShareVolumes: {},
      screenShareMutes: {},
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeVoice>): TypeVoice {
    const data = this.default();

    // Non-empty: the pre-filter settings page could persist a pre-permission
    // placeholder's "" device id, which matches no real device and renders as
    // a blank selection — treat it as "default" (absent) on load.
    if (
      typeof input.preferredAudioInputDevice === "string" &&
      input.preferredAudioInputDevice
    ) {
      data.preferredAudioInputDevice = input.preferredAudioInputDevice;
    }

    if (
      typeof input.preferredAudioOutputDevice === "string" &&
      input.preferredAudioOutputDevice
    ) {
      data.preferredAudioOutputDevice = input.preferredAudioOutputDevice;
    }

    if (
      typeof input.preferredVideoDevice === "string" &&
      input.preferredVideoDevice
    ) {
      data.preferredVideoDevice = input.preferredVideoDevice;
    }

    if (typeof input.echoCancellation === "boolean") {
      data.echoCancellation = input.echoCancellation;
    }

    // migrate legacy noise suppression to new suppression state
    if ((input.noiseSupression as unknown) === "true") {
      data.noiseSupression = "browser";
    } else if ((input.noiseSupression as unknown) === "false") {
      data.noiseSupression = "disabled";
    } else if (
      input.noiseSupression &&
      NoiseSuppresionStates.includes(input.noiseSupression)
    ) {
      data.noiseSupression = input.noiseSupression;
    }

    if (typeof input.autoGainControl === "boolean") {
      data.autoGainControl = input.autoGainControl;
    }

    if (typeof input.openMic === "boolean") {
      data.openMic = input.openMic;
    }

    if (typeof input.vadEnabled === "boolean") {
      data.vadEnabled = input.vadEnabled;
    }

    if (typeof input.vadThreshold === "number") {
      data.vadThreshold = Math.max(0, Math.min(100, input.vadThreshold));
    }

    if (typeof input.vadAuto === "boolean") {
      data.vadAuto = input.vadAuto;
    }

    if (typeof input.attenuationStrength === "number") {
      data.attenuationStrength = Math.max(
        0,
        Math.min(100, Math.round(input.attenuationStrength)),
      );
    }

    if (typeof input.attenuateWhenISpeak === "boolean") {
      data.attenuateWhenISpeak = input.attenuateWhenISpeak;
    }

    if (typeof input.attenuateWhenOthersSpeak === "boolean") {
      data.attenuateWhenOthersSpeak = input.attenuateWhenOthersSpeak;
    }

    if (typeof input.pushToTalk === "boolean") {
      data.pushToTalk = input.pushToTalk;
    }

    // The microphone modes are mutually exclusive; persisted state from
    // before that invariant may have any combination enabled. Keep the most
    // deliberate choice (push to talk, then VAD), fall back to open mic.
    if (data.pushToTalk) {
      data.vadEnabled = false;
      data.openMic = false;
    } else if (data.vadEnabled) {
      data.openMic = false;
    } else {
      data.openMic = true;
    }

    if (typeof input.e2eeCallsEnabled === "boolean") {
      data.e2eeCallsEnabled = input.e2eeCallsEnabled;
    }

    if (typeof input.webAudioMix === "boolean") {
      data.webAudioMix = input.webAudioMix;
    }

    if (typeof input.audioNormalization === "boolean") {
      data.audioNormalization = input.audioNormalization;
    }

    if (typeof input.audioNormalizationStrength === "number") {
      data.audioNormalizationStrength = clampStrength(
        input.audioNormalizationStrength,
      );
    }

    if (typeof input.pushToTalkKey === "string") {
      data.pushToTalkKey = input.pushToTalkKey;
    }

    if (
      input.screenShareQuality &&
      ScreenShareQualityNames.includes(input.screenShareQuality)
    ) {
      data.screenShareQuality = input.screenShareQuality;
    }

    if (typeof input.screenShareQualityAsk === "boolean") {
      data.screenShareQualityAsk = input.screenShareQualityAsk;
    }

    if (typeof input.screenShareAudio === "boolean") {
      data.screenShareAudio = input.screenShareAudio;
    }

    if (typeof input.screenShareShield === "boolean") {
      data.screenShareShield = input.screenShareShield;
    }

    if (
      input.androidScreenShareTier &&
      AndroidScreenShareTierNames.includes(input.androidScreenShareTier)
    ) {
      data.androidScreenShareTier = input.androidScreenShareTier;
    }

    if (typeof input.microphoneGain === "number") {
      data.microphoneGain = Math.max(0, Math.min(200, input.microphoneGain));
    }

    if (typeof input.cameraBrightness === "number") {
      data.cameraBrightness = Math.max(
        0,
        Math.min(200, input.cameraBrightness),
      );
    }

    if (
      input.cameraQuality &&
      CameraQualityNames.includes(input.cameraQuality)
    ) {
      data.cameraQuality = input.cameraQuality;
    }

    if (typeof input.cameraMaxBitrateKbps === "number") {
      data.cameraMaxBitrateKbps = Math.max(
        0,
        Math.min(20000, input.cameraMaxBitrateKbps),
      );
    }

    if (
      input.cameraBackgroundMode &&
      CameraBackgroundModes.includes(input.cameraBackgroundMode)
    ) {
      data.cameraBackgroundMode = input.cameraBackgroundMode;
    }

    if (typeof input.cameraBlurRadius === "number") {
      data.cameraBlurRadius = Math.max(1, Math.min(20, input.cameraBlurRadius));
    }

    if (typeof input.cameraBackgroundImageId === "string") {
      data.cameraBackgroundImageId = input.cameraBackgroundImageId;
    }

    // Unknown/corrupt persisted filter ids clean to undefined (render as None).
    if (
      input.cameraFaceFilterId &&
      CameraFaceFilterIds.includes(input.cameraFaceFilterId)
    ) {
      data.cameraFaceFilterId = input.cameraFaceFilterId;
    }

    if (typeof input.cameraBeautify === "number") {
      data.cameraBeautify = Number.isFinite(input.cameraBeautify)
        ? Math.max(0, Math.min(100, input.cameraBeautify))
        : 0;
    }

    if (
      input.cameraColorLookId &&
      CameraColorLookIds.includes(input.cameraColorLookId)
    ) {
      data.cameraColorLookId = input.cameraColorLookId;
    }

    Object.assign(data, cleanOverlaySettings(input));

    // Both sliders run 0–3 (300%). These were the only unclamped numeric
    // fields in the store, and both flow straight into a live GainNode — a
    // corrupt persisted value must not become an ear-splitting gain.
    if (
      typeof input.inputVolume === "number" &&
      Number.isFinite(input.inputVolume)
    ) {
      data.inputVolume = Math.max(0, Math.min(3, input.inputVolume));
    }

    if (
      typeof input.outputVolume === "number" &&
      Number.isFinite(input.outputVolume)
    ) {
      data.outputVolume = Math.max(0, Math.min(3, input.outputVolume));
    }

    if (typeof input.deafen === "boolean") {
      data.deafen = input.deafen;
    }

    if (typeof input.micOn === "boolean") {
      data.micOn = input.micOn;
    }

    if (typeof input.userVolumes === "object") {
      Object.entries(input.userVolumes)
        .filter(
          ([userId, volume]) =>
            typeof userId === "string" && typeof volume === "number",
        )
        .forEach(([k, v]) => (data.userVolumes[k] = v));
    }

    if (typeof input.userMutes === "object") {
      Object.entries(input.userMutes)
        .filter(
          ([userId, muted]) => typeof userId === "string" && muted === true,
        )
        .forEach(([k, v]) => (data.userMutes[k] = v));
    }

    if (typeof input.screenShareVolumes === "object") {
      Object.entries(input.screenShareVolumes)
        .filter(
          ([userId, volume]) =>
            typeof userId === "string" && typeof volume === "number",
        )
        .forEach(([k, v]) => (data.screenShareVolumes[k] = v));
    }

    if (typeof input.screenShareMutes === "object") {
      Object.entries(input.screenShareMutes)
        .filter(
          ([userId, muted]) => typeof userId === "string" && muted === true,
        )
        .forEach(([k, v]) => (data.screenShareMutes[k] = v));
    }

    return data;
  }

  /**
   * Set a user's volume
   * @param userId User ID
   * @param volume Volume
   */
  setUserVolume(userId: string, volume: number) {
    this.set("userVolumes", userId, volume);
  }

  /**
   * Get a user's volume
   * @param userId User ID
   * @returns Volume or default
   */
  getUserVolume(userId: string): number {
    // NOT `|| 1.0`: the slider's minimum is 0, and `0 || 1.0` is 1.0 — the
    // old code snapped anyone dragged to 0% straight back to full volume.
    const volume = this.get().userVolumes[userId];
    return typeof volume === "number" && Number.isFinite(volume) ? volume : 1.0;
  }

  /**
   * Set whether a user is muted
   * @param userId User ID
   * @param muted Whether they should be muted
   */
  setUserMuted(userId: string, muted: boolean) {
    this.set("userMutes", userId, muted);
  }

  /**
   * Get whether a user is muted
   * @param userId User ID
   * @returns Whether muted
   */
  getUserMuted(userId: string): boolean {
    return this.get().userMutes[userId] || false;
  }

  /**
   * Set a user's screen share volume
   * @param userId User ID
   * @param volume Volume
   */
  setScreenShareVolume(userId: string, volume: number) {
    this.set("screenShareVolumes", userId, volume);
  }

  /**
   * Get a user's screen share volume
   * @param userId User ID
   * @returns Volume or default
   */
  getScreenShareVolume(userId: string): number {
    // Same 0-is-falsy trap as getUserVolume: a share dragged to 0% must
    // stay at 0%, not snap back to full volume.
    const volume = this.get().screenShareVolumes[userId];
    return typeof volume === "number" && Number.isFinite(volume) ? volume : 1.0;
  }

  /**
   * Set whether a user's screen share is muted
   * @param userId User ID
   * @param muted Whether they should be muted
   */
  setScreenShareMuted(userId: string, muted: boolean) {
    this.set("screenShareMutes", userId, muted);
  }

  /**
   * Get whether a user's screen share is muted
   * @param userId User ID
   * @returns Whether muted
   *
   * Unset = AUDIBLE. This shipped as `?? true` (upstream #1055), which made
   * every stream silent until the listener found "Mute Screen Share" in the
   * sharer's context menu and unticked it — reported three times in a day
   * as "no sound during screen sharing". Only an explicit mute silences a
   * share; stored `true` values from users who chose to mute are kept.
   */
  getScreenShareMuted(userId: string): boolean {
    return this.get().screenShareMutes[userId] ?? false;
  }

  /**
   * Set the preferred audio input device
   */
  set preferredAudioInputDevice(value: string | undefined) {
    this.set("preferredAudioInputDevice", value);
  }

  /**
   * Set the preferred audio output device
   */
  set preferredAudioOutputDevice(value: string | undefined) {
    this.set("preferredAudioOutputDevice", value);
  }

  /**
   * Set the preferred video input device
   */
  set preferredVideoDevice(value: string | undefined) {
    this.set("preferredVideoDevice", value);
  }

  /**
   * Set echo cancellation
   */
  set echoCancellation(value: boolean) {
    this.set("echoCancellation", value);
  }

  /**
   * Set noise cancellation
   */
  set noiseSupression(value: NoiseSuppresionState) {
    this.set("noiseSupression", value);
  }

  /**
   * Set auto gain control
   */
  set autoGainControl(value: boolean) {
    this.set("autoGainControl", value);
  }

  /**
   * Select the microphone mode. The three modes are mutually exclusive —
   * exactly one of openMic / vadEnabled / pushToTalk is true at any time.
   */
  setMicrophoneMode(mode: MicrophoneMode) {
    this.set({
      openMic: mode === "openMic",
      vadEnabled: mode === "vad",
      pushToTalk: mode === "pushToTalk",
    } as Partial<TypeVoice>);
  }

  set vadThreshold(value: number) {
    this.set("vadThreshold", value);
  }

  set vadAuto(value: boolean) {
    this.set("vadAuto", value);
  }

  set attenuationStrength(value: number) {
    this.set("attenuationStrength", value);
  }

  set attenuateWhenISpeak(value: boolean) {
    this.set("attenuateWhenISpeak", value);
  }

  set attenuateWhenOthersSpeak(value: boolean) {
    this.set("attenuateWhenOthersSpeak", value);
  }

  set pushToTalkKey(value: string) {
    this.set("pushToTalkKey", value);
  }

  /**
   * Set screen share quality
   */
  set screenShareQuality(value: ScreenShareQualityName) {
    this.set("screenShareQuality", value);
  }

  /**
   * Set screen share quality always ask
   */
  set screenShareQualityAsk(value: boolean) {
    this.set("screenShareQualityAsk", value);
  }

  /**
   * Set screen share audio
   */
  set screenShareAudio(value: boolean) {
    this.set("screenShareAudio", value);
  }

  /** Set the screenshare privacy shield */
  set screenShareShield(value: boolean) {
    this.set("screenShareShield", value);
  }

  /** Set the native Android screen-share tier */
  set androidScreenShareTier(value: AndroidScreenShareTierName) {
    this.set("androidScreenShareTier", value);
  }

  set microphoneGain(value: number) {
    this.set("microphoneGain", value);
  }

  get cameraBrightness(): number {
    return this.get().cameraBrightness ?? 100;
  }

  set cameraBrightness(value: number) {
    this.set("cameraBrightness", value);
  }

  get cameraQuality(): CameraQualityName {
    return this.get().cameraQuality ?? "auto";
  }

  set cameraQuality(value: CameraQualityName) {
    this.set("cameraQuality", value);
  }

  get cameraMaxBitrateKbps(): number {
    return this.get().cameraMaxBitrateKbps ?? 0;
  }

  set cameraMaxBitrateKbps(value: number) {
    this.set("cameraMaxBitrateKbps", value);
  }

  get cameraBackgroundMode(): CameraBackgroundMode {
    return this.get().cameraBackgroundMode ?? "none";
  }

  set cameraBackgroundMode(value: CameraBackgroundMode) {
    this.set("cameraBackgroundMode", value);
  }

  get cameraBlurRadius(): number {
    return this.get().cameraBlurRadius ?? 10;
  }

  set cameraBlurRadius(value: number) {
    this.set("cameraBlurRadius", value);
  }

  get cameraBackgroundImageId(): string | undefined {
    return this.get().cameraBackgroundImageId;
  }

  set cameraBackgroundImageId(value: string | undefined) {
    this.set("cameraBackgroundImageId", value);
  }

  get cameraFaceFilterId(): CameraFaceFilterId | undefined {
    return this.get().cameraFaceFilterId;
  }

  set cameraFaceFilterId(value: CameraFaceFilterId | undefined) {
    this.set("cameraFaceFilterId", value);
  }

  get cameraBeautify(): number {
    return this.get().cameraBeautify ?? 0;
  }

  set cameraBeautify(value: number) {
    this.set("cameraBeautify", value);
  }

  get cameraColorLookId(): CameraColorLookId | undefined {
    return this.get().cameraColorLookId;
  }

  set cameraColorLookId(value: CameraColorLookId | undefined) {
    this.set("cameraColorLookId", value);
  }

  get overlayEnabled(): boolean {
    return this.get().overlayEnabled ?? false;
  }

  set overlayEnabled(value: boolean) {
    this.set("overlayEnabled", value);
  }

  get overlayOpacity(): number {
    return this.get().overlayOpacity ?? 0.85;
  }

  set overlayOpacity(value: number) {
    this.set("overlayOpacity", value);
  }

  get overlayScale(): number {
    return this.get().overlayScale ?? 1;
  }

  set overlayScale(value: number) {
    this.set("overlayScale", value);
  }

  get overlayDisplayMode(): OverlayDisplayModeName {
    return this.get().overlayDisplayMode ?? "avatars-names";
  }

  set overlayDisplayMode(value: OverlayDisplayModeName) {
    this.set("overlayDisplayMode", value);
  }

  get overlayShowLatency(): boolean {
    return this.get().overlayShowLatency ?? false;
  }

  set overlayShowLatency(value: boolean) {
    this.set("overlayShowLatency", value);
  }

  get overlayCorner(): OverlayCornerName {
    return this.get().overlayCorner ?? "top-left";
  }

  set overlayCorner(value: OverlayCornerName) {
    this.set("overlayCorner", value);
  }

  /**
   * Set input volume
   */
  set inputVolume(value: number) {
    this.set("inputVolume", value);
  }

  /**
   * Set output volume
   */
  set outputVolume(value: number) {
    this.set("outputVolume", value);
  }

  /**
   * Set mic status
   */
  set micOn(value: boolean) {
    this.set("micOn", value);
  }

  /**
   * Set deafen status
   */
  set deafen(value: boolean) {
    this.set("deafen", value);
  }

  /**
   * Get the preferred audio input device
   */
  get preferredAudioInputDevice(): string | undefined {
    return this.get().preferredAudioInputDevice;
  }

  /**
   * Get the preferred audio output device
   */
  get preferredAudioOutputDevice(): string | undefined {
    return this.get().preferredAudioOutputDevice;
  }

  /**
   * Get the preferred video input device
   */
  get preferredVideoDevice(): string | undefined {
    return this.get().preferredVideoDevice;
  }

  /**
   * Get echo cancellation
   */
  get echoCancellation(): boolean | undefined {
    return this.get().echoCancellation;
  }

  /**
   * Get noise supression
   */
  get noiseSupression(): NoiseSuppresionState | undefined {
    return this.get().noiseSupression;
  }

  /**
   * Get auto gain control
   */
  get autoGainControl(): boolean | undefined {
    return this.get().autoGainControl;
  }

  get openMic(): boolean {
    return this.get().openMic;
  }

  get vadEnabled(): boolean {
    return this.get().vadEnabled;
  }

  get vadThreshold(): number {
    return this.get().vadThreshold;
  }

  get vadAuto(): boolean {
    return this.get().vadAuto;
  }

  get attenuationStrength(): number {
    return this.get().attenuationStrength;
  }

  get attenuateWhenISpeak(): boolean {
    return this.get().attenuateWhenISpeak;
  }

  get attenuateWhenOthersSpeak(): boolean {
    return this.get().attenuateWhenOthersSpeak;
  }

  get pushToTalk(): boolean {
    return this.get().pushToTalk;
  }

  get pushToTalkKey(): string {
    return this.get().pushToTalkKey;
  }

  /**
   * Get screen share quality
   */
  get screenShareQuality(): ScreenShareQualityName | undefined {
    return this.get().screenShareQuality;
  }

  /**
   * Get screen share quality always ask
   */
  get screenShareQualityAsk(): boolean {
    return this.get().screenShareQualityAsk;
  }

  /**
   * Get screen share audio
   */
  get screenShareAudio(): boolean {
    return this.get().screenShareAudio;
  }

  /** Get the screenshare privacy shield (default off: it redraws the share
   * through a canvas, which is not free at high resolutions) */
  get screenShareShield(): boolean {
    return this.get().screenShareShield ?? false;
  }

  /** Get the native Android screen-share tier */
  get androidScreenShareTier(): AndroidScreenShareTierName {
    return this.get().androidScreenShareTier ?? "default";
  }

  get microphoneGain(): number {
    return this.get().microphoneGain ?? 100;
  }

  /**
   * Get input volume
   */
  get inputVolume(): number {
    return this.get().inputVolume;
  }

  /**
   * Get output volume
   */
  get outputVolume(): number {
    return this.get().outputVolume;
  }

  /**
   * Get deafen status
   */
  get deafen(): boolean {
    return this.get().deafen;
  }

  /**
   * Get mic status
   */
  get micOn(): boolean {
    return this.get().micOn;
  }

  /**
   * Whether "Encrypt my calls" is on for THIS device (slice 6.5 §0.2 #9).
   *
   * ALWAYS TRUE — media E2EE is mandatory, matching Discord/DAVE, which made
   * A/V E2EE the default with no opt-out and is removing its unencrypted
   * fallback path entirely. Deliberately ignores the persisted value so that
   * existing installs carrying the old `false` default flip on without needing
   * a migration, and so no future code path can turn it back off.
   *
   * This removes the LOCAL toggle only. It does NOT make every call encrypted:
   * the real gate (rtc/state.tsx) additionally requires insertable streams, a
   * native key-push channel, a platform where media E2EE is audited (not the
   * Electron shell yet), and text-E2EE enrollment. Those still fail closed and
   * the settings card still reports them honestly — never claim encryption the
   * gate will not deliver (FE-6).
   */
  get e2eeCallsEnabled(): boolean {
    return true;
  }

  /**
   * No-op: "Encrypt my calls" can no longer be turned off (see the getter).
   * Retained so existing callers and the persisted field keep type-checking;
   * the stored value is inert.
   */
  set e2eeCallsEnabled(_value: boolean) {
    /* intentionally empty — media E2EE is mandatory */
  }

  /**
   * Kill-switch for livekit's shared Web Audio mix (see `TypeVoice`).
   * Read once per call, when the Room is constructed — flipping it mid-call
   * does nothing until the next join.
   */
  get webAudioMix(): boolean {
    return this.get().webAudioMix;
  }

  set webAudioMix(value: boolean) {
    this.set("webAudioMix", value);
  }

  /**
   * Level incoming voices (receive-side AGC + limiter). Unlike the mix
   * itself this applies LIVE — the room audio manager re-wires plugins
   * mid-call — but it still needs `webAudioMix` to have been on at join.
   */
  get audioNormalization(): boolean {
    return this.get().audioNormalization;
  }

  set audioNormalization(value: boolean) {
    this.set("audioNormalization", value);
  }

  /** Boost strength 0–100 (see `TypeVoice.audioNormalizationStrength`). */
  get audioNormalizationStrength(): number {
    return this.get().audioNormalizationStrength;
  }

  set audioNormalizationStrength(value: number) {
    this.set("audioNormalizationStrength", clampStrength(value));
  }
}

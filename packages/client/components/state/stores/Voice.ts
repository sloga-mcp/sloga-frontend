import { State } from "..";

import { AbstractStore } from ".";

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
 * Possible screen share qualities. Low is 720p@30fps, high 1080p@30fps and text is source@5fps.
 */
export type ScreenShareQualityName =
  | "low"
  | "high"
  | "text"
  | "fhd"
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
  "qhd",
  "uhd",
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
  | "health-bar";

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

export interface TypeVoice {
  preferredAudioInputDevice?: string;
  preferredAudioOutputDevice?: string;
  preferredVideoDevice?: string;

  echoCancellation: boolean;
  noiseSupression: NoiseSuppresionState;
  autoGainControl: boolean;

  openMic: boolean;
  vadEnabled: boolean;
  vadThreshold: number;
  pushToTalk: boolean;
  pushToTalkKey: string;

  screenShareQuality: ScreenShareQualityName;
  screenShareQualityAsk: boolean;
  screenShareAudio: boolean;

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
   * would hand the server a write path into the E2EE-attempt gate. Default
   * off; enabling requires text-E2EE enrollment (shared infrastructure).
   */
  e2eeCallsEnabled: boolean;

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
      noiseSupression: "browser",
      autoGainControl: true,
      openMic: true,
      vadEnabled: false,
      vadThreshold: 20,
      pushToTalk: false,
      pushToTalkKey: "Space",
      screenShareQuality: "low",
      screenShareQualityAsk: true,
      screenShareAudio: true,
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
      e2eeCallsEnabled: false,
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

    if (typeof input.preferredAudioInputDevice === "string") {
      data.preferredAudioInputDevice = input.preferredAudioInputDevice;
    }

    if (typeof input.preferredAudioOutputDevice === "string") {
      data.preferredAudioOutputDevice = input.preferredAudioOutputDevice;
    }

    if (typeof input.preferredVideoDevice === "string") {
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

    if (typeof input.pushToTalk === "boolean") {
      data.pushToTalk = input.pushToTalk;
    }

    if (typeof input.e2eeCallsEnabled === "boolean") {
      data.e2eeCallsEnabled = input.e2eeCallsEnabled;
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

    if (typeof input.inputVolume === "number") {
      data.inputVolume = input.inputVolume;
    }

    if (typeof input.outputVolume === "number") {
      data.outputVolume = input.outputVolume;
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
    return this.get().userVolumes[userId] || 1.0;
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
    return this.get().screenShareVolumes[userId] || 1.0;
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
   */
  getScreenShareMuted(userId: string): boolean {
    return this.get().screenShareMutes[userId] ?? true;
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

  set openMic(value: boolean) {
    this.set("openMic", value);
  }

  set vadEnabled(value: boolean) {
    this.set("vadEnabled", value);
  }

  set vadThreshold(value: number) {
    this.set("vadThreshold", value);
  }

  set pushToTalk(value: boolean) {
    this.set("pushToTalk", value);
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
   */
  get e2eeCallsEnabled(): boolean {
    return this.get().e2eeCallsEnabled;
  }

  /**
   * Toggle "Encrypt my calls" (local per-device). Enabling is only meaningful
   * once text-E2EE enrollment exists (the settings card routes through the
   * enroll flow first); this just persists the intent.
   */
  set e2eeCallsEnabled(value: boolean) {
    this.set("e2eeCallsEnabled", value);
  }
}

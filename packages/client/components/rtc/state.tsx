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
} from "livekit-client";
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

import { SoundController, useClient, useSound } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { ModalController, useModals } from "@revolt/modal";
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

  private sound: SoundController;

  private openModal;
  private getClient;
  private screenShareTracks: Set<string>;
  private disposeTrackRoot: (() => void) | undefined;
  #pttKeydown: ((e: KeyboardEvent) => void) | undefined;
  #pttKeyup: ((e: KeyboardEvent) => void) | undefined;
  #vadStream: MediaStream | undefined;
  #vadCtx: AudioContext | undefined;
  #vadFrame: number | undefined;
  #vadSilenceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    voiceSettings: VoiceSettings,
    modals: ModalController,
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

    const [hwBrightness, setHwBrightness] = createSignal(false);
    this.cameraHwBrightness = hwBrightness;
    this.#setCameraHwBrightness = setHwBrightness;

    const [bgStatus, setBgStatus] = createSignal<CameraBackgroundStatus>("idle");
    this.cameraBackgroundStatus = bgStatus;
    this.#setCameraBackgroundStatus = setBgStatus;

    const [effectsApplied, setEffectsApplied] = createSignal(0);
    this.cameraEffectsApplied = effectsApplied;
    this.#setCameraEffectsApplied = setEffectsApplied;

    this.#cameraEffects.onHwSupportChange = (hw) =>
      this.#setCameraHwBrightness(hw);
    this.#cameraEffects.onImageMissing = () => {
      this.#settings.cameraBackgroundMode = "none";
    };

    this.openModal = modals.openModal;

    this.getClient = useClient();

    this.screenShareTracks = new Set();
  }

  async connect(channel: Channel, auth?: { url: string; token: string }) {
    this.disconnect();

    const room = new Room({
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
              if (this.#settings.noiseSupression === "enhanced") {
                track.audioTrack.setProcessor(
                  new DenoiseTrackProcessor({
                    workletCDNURL: CONFIGURATION.RNNOISE_WORKLET_CDN_URL,
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

    room.addListener("participantConnected", () => {
      this.sound.playSound("userJoinVoice");
    });

    room.addListener("participantDisconnected", () => {
      this.sound.playSound("userLeaveVoice");
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

    if (!auth) {
      auth = await channel.joinCall("worldwide");
    }

    await room.connect(auth.url, auth.token, {
      autoSubscribe: false,
    });
  }

  disconnect() {
    try {
      nativeCallServiceStop();

      const room = this.room();
      if (!room) return;

      room.removeAllListeners();
      room.disconnect();

      batch(() => {
        this.#setState("READY");
        this.#setRoom();
        this.#setChannel();
        this.#setFullscreen(false);
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
        const localTrack = await room.localParticipant.setScreenShareEnabled(
          true,
          {
            resolution:
              this.getEnabledScreenShareQualities()[
                this.#settings.screenShareQuality || "low"
              ]?.resolution,
            audio: true,
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

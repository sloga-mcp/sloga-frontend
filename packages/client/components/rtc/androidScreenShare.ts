/**
 * Android screen-leg publisher bridge (screen-leg plan §7) — the JS half of
 * the two-phase `ScreenSharePlugin` (§4.2).
 *
 * The WebView cannot screen-share on Android (no runtime exposes
 * `getDisplayMedia`), so a share from the phone is a SECOND, native LiveKit
 * participant — `{user_id}:{device_id}:screen` — publishing only the
 * MediaProjection capture. This module owns the plugin surface, the phone
 * quality table (§7.4 — deliberately NOT the desktop ladder: single layer,
 * VP8, no simulcast, no backup codec), the availability gate, and the gate on
 * whether the share sheet may offer system audio (slice 4). The leg's
 * state machine lives in `androidLegStartPolicy.ts` ([AndroidLegLifecycle]);
 * call-level ordering (preconditions, stop hooks, key pushes) stays in
 * `rtc/state.tsx`, which owns the call.
 */
import type { Accessor } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

import { CONFIGURATION } from "@revolt/common";
import type { AndroidScreenShareTierName } from "@revolt/state/stores/Voice";

import {
  type LegAudioState,
  type LegSendKey,
  type NativeFrameKey,
  type NativeStopReason,
  AndroidLegLifecycle,
  isLegAudioState,
  nativeShareAudioAvailable,
  nativeShareAvailable,
  withTimeout,
} from "./androidLegStartPolicy";
import {
  type AndroidScreenShareTier,
  ANDROID_SCREEN_SHARE_TIERS,
} from "./androidScreenShareTiers";

export { ANDROID_SCREEN_SHARE_TIERS };
export type { AndroidScreenShareTier, AndroidScreenShareTierName };

/** A leg send key with its group binding — the ONE canonical shape, defined
 * in the policy leaf and re-exported here. Three structurally identical
 * copies used to exist (this, `LegSendKey`, and `mlsCallKeys`'s
 * `LocalScreenKey`); they agreed only by accident of structural typing, so a
 * field added to one would have silently stopped fencing in the others. */
export type LegE2EEKey = LegSendKey;

/** Ceiling on the OS consent dialog. The dialog is user-paced, so this is
 * generous — it exists for the pathological case (activity torn down, the
 * Capacitor callback lost) where `prepare()` would otherwise never settle
 * and the start attempt would hold `#androidLegStartingFor` forever, turning
 * every later share tap into a cancel of a corpse. */
const PREPARE_TIMEOUT_MS = 120_000;

/** Which of the leg's publications a native `muted` event is about. */
export type LegMuteSource = "screen_share" | "screen_share_audio";

/** A native `muted` event, normalized: a `source` this JS does not know
 * arrives as undefined, which `legMutedNotice` reads as the video, the only
 * meaning the event had before slice 4. */
export interface LegMutedEvent {
  muted: boolean;
  source?: LegMuteSource;
}

interface NativeScreenSharePlugin {
  prepare(): Promise<{ ok: boolean }>;
  connect(options: {
    url: string;
    token: string;
    quality: {
      longSide: number;
      fps: number;
      maxBitrateKbps: number;
      degradation: string;
    };
    /** Publish the phone's system audio beside the video (slice 4). Native
     * reads a missing value as false. */
    audio: boolean;
    e2ee?: NativeFrameKey;
  }): Promise<{
    ok: true;
    /** The leg's [LegAudioState] as native reports it. UNTRUSTED: an older
     * APK sends none, and a newer one may send a state this JS does not
     * know, so it is read only through [isLegAudioState]. */
    audio?: unknown;
  }>;
  setFrameKey(key: NativeFrameKey): Promise<void>;
  stop(): Promise<void>;
  addListener(
    event: "started" | "stopped" | "muted" | "audio" | "error",
    callback: (data: {
      reason?: NativeStopReason;
      muted?: boolean;
      /** `muted` only. Untrusted; see [muteSource]. */
      source?: unknown;
      /** `audio` only. Untrusted; anything but `lost`/`failed` is dropped. */
      state?: unknown;
      code?: string;
    }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/** A native `muted` event's `source`, or undefined for anything else. */
function muteSource(source: unknown): LegMuteSource | undefined {
  return source === "screen_share" || source === "screen_share_audio"
    ? source
    : undefined;
}

const isAndroidShell = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

const plugin: NativeScreenSharePlugin | undefined = isAndroidShell()
  ? registerPlugin<NativeScreenSharePlugin>("ScreenShare")
  : undefined;

const AVAILABLE = nativeShareAvailable({
  androidShell: isAndroidShell(),
  flag: CONFIGURATION.ENABLE_ANDROID_SCREEN_SHARE,
  pluginHeader: Capacitor.isPluginAvailable("ScreenShare"),
});

/**
 * Whether the NATIVE share path exists on this device: Android shell + the
 * build-time flag + the `ScreenShare` plugin registered by the native shell
 * (§7.1). Computed once, synchronously, at module load, and constant for the
 * session. It must never flip from true to false: `stopScreenshare`, the AFK
 * guard and `toggleScreenshare` all route on it, so a flip during a share
 * would send the stop down the web path and strand the native leg.
 *
 * This used to be a signal fed by an async native `isAvailable` probe. In
 * `@capacitor/android` 8.4.1 the reply to the first native call after a
 * WebView reload can be lost, and that probe was the first call, so the
 * share button could say "not supported" for the whole session. The native
 * method always answered `available: true`, so the round trip only proved
 * the plugin header exists, which `Capacitor.isPluginAvailable` reports
 * synchronously (the web bundle ships inside the APK, so the header always
 * matches the native plugin set). Screen-leg plan, wave 4h.
 */
export const nativeScreenShareAvailable: Accessor<boolean> = () => AVAILABLE;

/** See [nativeScreenShareAudioOffered]. Reads the share path through its
 * accessor, which returns the module-load constant above. */
const SHARE_AUDIO_OFFERED = nativeShareAudioAvailable({
  shareAvailable: nativeScreenShareAvailable(),
  audioFlag: CONFIGURATION.ENABLE_ANDROID_SCREEN_AUDIO,
  audioHeader: Capacitor.isPluginAvailable("ScreenShareAudio"),
});

/**
 * Whether the share sheet may offer system audio: the native share path
 * ([nativeScreenShareAvailable]), the `ENABLE_ANDROID_SCREEN_AUDIO` build
 * flag (dark by default), and the `ScreenShareAudio` marker plugin, which
 * native registers only on API 29+, where playback capture exists.
 *
 * Computed once, synchronously, at module load, for the reason given at
 * [nativeScreenShareAvailable]: the marker's header is read with
 * `Capacitor.isPluginAvailable`, never through a native call. Whether a
 * given share actually gets audio (microphone permission, a microphone
 * foreground service) is not known here; native answers that when
 * [AndroidScreenLeg.connect] resolves.
 */
export const nativeScreenShareAudioOffered: Accessor<boolean> = () =>
  SHARE_AUDIO_OFFERED;

/**
 * The live leg, at most one per call. Owned by `Voice` (rtc/state.tsx), which
 * drives every stop hook (§7.4) through [stop]; this class wires the plugin
 * to an [AndroidLegLifecycle], which holds the leg's state (active, stop
 * coalescing, the group fence, the connect generation).
 */
export class AndroidScreenLeg {
  /** The leg's state machine. The announcer reads `onStarted`/`onStopped` at
   * call time, not here: the owner assigns them after construction. */
  #core = new AndroidLegLifecycle(
    {
      setFrameKey: (k) => plugin!.setFrameKey(k),
      stop: () => plugin!.stop(),
    },
    {
      started: () => this.onStarted?.(),
      stopped: (r) => this.onStopped?.(r),
    },
  );
  #listeners: { remove: () => Promise<void> }[] = [];
  /** Resolves once the plugin listeners are attached — awaited by [prepare]
   * so no share can start with its event stream unwired. */
  #ready: Promise<void>;

  onStarted?: () => void;
  onStopped?: (reason: NativeStopReason) => void;
  /** The server muted or unmuted one of the leg's publications; `source`
   * names which (see [LegMutedEvent]). */
  onMuted?: (event: LegMutedEvent) => void;
  /** The leg's system audio ended while the video goes on: `lost` (the
   * audio publication went away) or `failed` (capture died). */
  onAudio?: (state: "lost" | "failed") => void;

  constructor() {
    if (!plugin) throw new Error("native screen share unavailable");
    this.#ready = this.#listen();
  }

  async #listen() {
    const p = plugin!;
    this.#listeners.push(
      await p.addListener("started", () => {
        this.#core.nativeStarted();
      }),
      await p.addListener("stopped", (data) => {
        this.#core.nativeStopped(data.reason);
      }),
      await p.addListener("muted", (data) => {
        this.onMuted?.({
          muted: data.muted ?? true,
          source: muteSource(data.source),
        });
      }),
      await p.addListener("audio", (data) => {
        const state = data.state;
        if (state === "lost" || state === "failed") this.onAudio?.(state);
      }),
    );
  }

  active(): boolean {
    return this.#core.active();
  }

  /** True while a [stop] is in flight ([AndroidLegLifecycle.stopping]). */
  stopping(): boolean {
    return this.#core.stopping();
  }

  /** Identifies the same share across an await; see
   * [AndroidLegLifecycle.shareToken]. */
  shareToken(): number {
    return this.#core.shareToken();
  }

  /** Phase 1: OS consent + FGS. User-paced — mint the token AFTER this.
   * Bounded by [PREPARE_TIMEOUT_MS] so a lost native callback cannot strand
   * the start attempt forever; a consent granted AFTER the timeout is stored
   * natively but never connected (the next share's `prepare()` overwrites
   * it, and consent is only consumed at publish, so nothing captures). */
  async prepare(): Promise<void> {
    await this.#ready;
    await withTimeout(
      plugin!.prepare(),
      PREPARE_TIMEOUT_MS,
      "screen share consent timed out",
    );
  }

  /**
   * Phase 2: connect + publish. The 10 s token must be minted between
   * [prepare] and this call (§4.2). Under E2EE `e2ee` is REQUIRED — the
   * caller's publish gate guarantees it (§7.2); a failed connect keeps the
   * consent, so a retry needs a fresh token but no new dialog (probe (e)).
   * The lifecycle binds the group and claims the generation before it
   * publishes, and hands the plugin the key without its group.
   *
   * `audio` asks native to publish the phone's system audio too; the caller
   * sends true only when the sheet offered it and the user left it on
   * (`legAudioRequested`). Resolves with the leg's audio as native reports
   * it. Native publishes the audio (or gives up on it) before it resolves, so
   * this is the final start-time state, never a guess. A report that is not
   * a [LegAudioState] (an older APK sends none) reads as `failed` when audio
   * was asked for, so the user is told it did not start rather than
   * sharing silence that looks like sound, and as `off` when it was not.
   */
  connect(options: {
    url: string;
    token: string;
    tier: AndroidScreenShareTier;
    audio: boolean;
    e2ee?: LegE2EEKey;
  }): Promise<LegAudioState> {
    let reported: unknown;
    return this.#core
      .connect(options.e2ee, (e2ee) =>
        plugin!
          .connect({
            url: options.url,
            token: options.token,
            quality: {
              longSide: options.tier.longSide,
              fps: options.tier.fps,
              maxBitrateKbps: options.tier.maxBitrateKbps,
              degradation: options.tier.degradation,
            },
            audio: options.audio,
            e2ee,
          })
          .then((result) => {
            reported = result?.audio;
          }),
      )
      .then(
        (): LegAudioState =>
          isLegAudioState(reported)
            ? reported
            : options.audio
              ? "failed"
              : "off",
      );
  }

  /**
   * Rotation push (§5.2). Resolves only once the native sender encrypts under
   * the new (key, index) — the provider AWAITS this before reporting the
   * local key installed, which is what locks a removed member out. A
   * rejection here, including a native call that does not settle within
   * [FRAME_KEY_TIMEOUT_MS] (the lifecycle bounds it), means the leg cannot
   * be trusted on the new epoch: the caller stops the leg (fail closed) and
   * resolves the provider's push. A no-op while the leg is not active; a key
   * from another group throws (see [AndroidLegLifecycle.setFrameKey]).
   */
  setFrameKey(key: LegE2EEKey): Promise<void> {
    return this.#core.setFrameKey(key);
  }

  /**
   * Stop — every §7.4 hook lands here. The native side unpublishes,
   * disconnects, releases the Room (dropping the native keyring) and stops
   * the FGS; the `stopped` event closes the loop. Concurrent stops coalesce,
   * and a rejected or timed-out native stop leaves the leg `active()` so the
   * next hook retries (see [AndroidLegLifecycle.stop]).
   */
  stop(): Promise<void> {
    return this.#core.stop();
  }

  /** Drop plugin listeners (app-lifetime hygiene; used by tests). */
  dispose(): void {
    for (const listener of this.#listeners.splice(0)) void listener.remove();
  }
}

/** Construct the leg controller, or undefined off the Android shell. */
export function createAndroidScreenLeg(): AndroidScreenLeg | undefined {
  if (!plugin || !CONFIGURATION.ENABLE_ANDROID_SCREEN_SHARE) return undefined;
  return new AndroidScreenLeg();
}

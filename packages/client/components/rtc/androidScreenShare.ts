/**
 * Android screen-leg publisher bridge (screen-leg plan §7) — the JS half of
 * the two-phase `ScreenSharePlugin` (§4.2).
 *
 * The WebView cannot screen-share on Android (no runtime exposes
 * `getDisplayMedia`), so a share from the phone is a SECOND, native LiveKit
 * participant — `{user_id}:{device_id}:screen` — publishing only the
 * MediaProjection capture. This module owns the plugin surface, the phone
 * quality table (§7.4 — deliberately NOT the desktop ladder: single layer,
 * VP8, no simulcast, no backup codec), and the availability gate. The leg's
 * state machine lives in `androidLegStartPolicy.ts` ([AndroidLegLifecycle]);
 * call-level ordering (preconditions, stop hooks, key pushes) stays in
 * `rtc/state.tsx`, which owns the call.
 */
import type { Accessor } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

import { CONFIGURATION } from "@revolt/common";
import type { AndroidScreenShareTierName } from "@revolt/state/stores/Voice";

import {
  type LegSendKey,
  type NativeFrameKey,
  type NativeStopReason,
  AndroidLegLifecycle,
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
    /** Inert until slice 4 (§0.6) — v1 publishes video only. */
    audio: boolean;
    e2ee?: NativeFrameKey;
  }): Promise<{ ok: boolean }>;
  setFrameKey(key: NativeFrameKey): Promise<void>;
  stop(): Promise<void>;
  addListener(
    event: "started" | "stopped" | "muted" | "error",
    callback: (data: {
      reason?: NativeStopReason;
      muted?: boolean;
      code?: string;
    }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
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
  onMuted?: (muted: boolean) => void;

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
        this.onMuted?.(data.muted ?? true);
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
   */
  connect(options: {
    url: string;
    token: string;
    tier: AndroidScreenShareTier;
    e2ee?: LegE2EEKey;
  }): Promise<void> {
    return this.#core.connect(options.e2ee, (e2ee) =>
      plugin!.connect({
        url: options.url,
        token: options.token,
        quality: {
          longSide: options.tier.longSide,
          fps: options.tier.fps,
          maxBitrateKbps: options.tier.maxBitrateKbps,
          degradation: options.tier.degradation,
        },
        audio: false,
        e2ee,
      }),
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

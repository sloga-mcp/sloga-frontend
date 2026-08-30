/**
 * Android screen-leg publisher bridge (screen-leg plan §7) — the JS half of
 * the two-phase `ScreenSharePlugin` (§4.2).
 *
 * The WebView cannot screen-share on Android (no runtime exposes
 * `getDisplayMedia`), so a share from the phone is a SECOND, native LiveKit
 * participant — `{user_id}:{device_id}:screen` — publishing only the
 * MediaProjection capture. This module owns the plugin surface, the phone
 * quality table (§7.4 — deliberately NOT the desktop ladder: single layer,
 * VP8, no simulcast, no backup codec), and the availability gate. Lifecycle
 * ordering (preconditions, stop hooks, key pushes) stays in `rtc/state.tsx`,
 * which owns the call.
 */
import { type Accessor, createSignal } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

import { CONFIGURATION } from "@revolt/common";
import type { AndroidScreenShareTierName } from "@revolt/state/stores/Voice";

import type { LegSendKey } from "./androidLegStartPolicy";
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

/** The key as it crosses the bridge. DERIVED from [LegE2EEKey] by dropping
 * `groupId`, which makes "the group binding stays JS-side" a structural fact
 * rather than a comment: epochs are only comparable WITHIN a group (a
 * re-established group restarts them), so the leg refuses a key from any
 * group other than the one it connected under rather than letting the native
 * epoch fence misjudge it.
 *
 * `epoch` DOES ride along, as that native fence: pushes race (a rotation
 * against the post-connect reconcile, two rotations back to back), the
 * bridge does not promise ordering, and without a fence the OLDER push can
 * land last and stick — the idempotence guard upstream then blocks any
 * retry. Native refuses to apply a key whose epoch is behind the one it
 * already holds. */
export type NativeFrameKey = Omit<LegE2EEKey, "groupId">;

/** Ceiling on the OS consent dialog. The dialog is user-paced, so this is
 * generous — it exists for the pathological case (activity torn down, the
 * Capacitor callback lost) where `prepare()` would otherwise never settle
 * and the start attempt would hold `#androidLegStartingFor` forever, turning
 * every later share tap into a cancel of a corpse. */
const PREPARE_TIMEOUT_MS = 120_000;

/** Ceiling on a native `stop()`. The Kotlin side settles in a `finally`, so
 * a lost settlement is already remote — but `#stopPromise` clears only when
 * the call settles, so without a bound every later hook AND the user's next
 * tap would coalesce onto a dead promise: an unstoppable share. A timeout
 * reads as "not stopped" (the leg stays `active()`), which is exactly the
 * state that lets the next hook retry. */
const STOP_TIMEOUT_MS = 15_000;

/** Reject `work` if it has not settled within `ms`. The loser's late
 * settlement is absorbed by the race rather than surfacing unhandled. */
function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export type NativeStopReason = "user" | "system" | "disconnected" | "error";

interface NativeScreenSharePlugin {
  isAvailable(): Promise<{ available: boolean; audioCapture: boolean }>;
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

const [available, setAvailable] = createSignal(false);

/**
 * Whether the NATIVE share path exists on this device — Android shell + the
 * build-time flag + the plugin answering (§7.1). A SIGNAL rather than a
 * const: `isAvailable()` is async, so the buttons it gates must react when
 * the probe lands rather than reading a stale `false` forever.
 */
export const nativeScreenShareAvailable: Accessor<boolean> = available;

if (plugin && CONFIGURATION.ENABLE_ANDROID_SCREEN_SHARE) {
  plugin
    .isAvailable()
    .then((result) => setAvailable(result.available))
    .catch(() => setAvailable(false));
}

/**
 * The live leg, at most one per call. Owned by `Voice` (rtc/state.tsx), which
 * drives every stop hook (§7.4) through [stop]; this class only tracks the
 * native side and fans plugin events out to the callbacks the owner set.
 *
 * `active` is true from a resolved [connect] until the terminal `stopped`
 * event — INCLUDING the whole native teardown, so a stop hook firing twice
 * (pause gate + disconnect, say) collapses into one native `stop()`.
 */
export class AndroidScreenLeg {
  #active = false;
  /** In-flight [stop], while one runs. Concurrent stops COALESCE onto it —
   * a hook that fires during a teardown must wait for that teardown, not be
   * discarded (a discarded stop resolves before native has released the
   * MediaProjection, and its caller then believes the capture is over). */
  #stopPromise: Promise<void> | undefined;
  /** The group the current share connected under — the JS half of the key
   * fence (see [LegE2EEKey]); undefined for a plaintext leg. */
  #e2eeGroupId: string | undefined;
  /** Claimed by each [connect] and invalidated by every definitive stop, so
   * a connect resolving after its share already ended cannot resurrect
   * `#active`. */
  #connectGeneration = 0;
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
        this.#active = true;
        this.onStarted?.();
      }),
      await p.addListener("stopped", (data) => {
        const wasActive = this.#active;
        this.#active = false;
        // Definitively down: orphan any connect still in flight so its
        // resolution cannot flip `#active` back on.
        this.#connectGeneration++;
        // A stopped for a leg that never reported started (connect() threw
        // after partial setup) has nothing to announce.
        if (wasActive) this.onStopped?.(data.reason ?? "error");
      }),
      await p.addListener("muted", (data) => {
        this.onMuted?.(data.muted ?? true);
      }),
    );
  }

  active(): boolean {
    return this.#active;
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
   */
  async connect(options: {
    url: string;
    token: string;
    tier: AndroidScreenShareTier;
    e2ee?: LegE2EEKey;
  }): Promise<void> {
    // Bind the group BEFORE the await, because `#active` does not wait for
    // this call to resolve: native fires `started` a bridge hop earlier and
    // the listener flips the flag there (deliberately — a stop hook must be
    // able to see the leg the instant it is capturing). Binding after the
    // await left a window where a rotation found `active()` true and
    // `#e2eeGroupId` still undefined (or the PREVIOUS share's group), so the
    // fence rejected a perfectly good key and fail-closed a healthy share —
    // any join or leave during a share start would do it. Assigned
    // unconditionally, so a plaintext share correctly rebinds to undefined;
    // a failed connect leaves `#active` false, which makes a stale value
    // unreadable.
    this.#e2eeGroupId = options.e2ee?.groupId;
    const generation = ++this.#connectGeneration;
    await plugin!.connect({
      url: options.url,
      token: options.token,
      quality: {
        longSide: options.tier.longSide,
        fps: options.tier.fps,
        maxBitrateKbps: options.tier.maxBitrateKbps,
        degradation: options.tier.degradation,
      },
      audio: false,
      e2ee: options.e2ee && {
        keyB64: options.e2ee.keyB64,
        keyIndex: options.e2ee.keyIndex,
        epoch: options.e2ee.epoch,
      },
    });
    // A stop that fully completed while this resolution was in flight must
    // not be undone by it: without the token the leg came back `active()`
    // with nothing running, and the caller's stale check then announced a
    // second stop (two end-of-share sounds). The caller tears down on that
    // stale check regardless of this flag, so declining to set it cannot
    // strand a live capture.
    if (generation !== this.#connectGeneration) return;
    this.#active = true;
  }

  /**
   * Rotation push (§5.2). Resolves only once the native sender encrypts under
   * the new (key, index) — the provider AWAITS this before reporting the
   * local key installed, which is what locks a removed member out. A
   * rejection here means the leg cannot be trusted on the new epoch: the
   * caller stops the leg (fail closed) and resolves the provider's push.
   */
  async setFrameKey(key: LegE2EEKey): Promise<void> {
    if (!this.#active) return;
    // Group fence (JS half): the native epoch fence can only order pushes
    // WITHIN one group. A key from any other group — a re-establish raced
    // the leg — is uncomparable and unsafe; throw so the caller's
    // fail-closed path stops the leg.
    if (key.groupId !== this.#e2eeGroupId)
      throw new Error("screen leg key is from a different group");
    await plugin!.setFrameKey({
      keyB64: key.keyB64,
      keyIndex: key.keyIndex,
      epoch: key.epoch,
    });
  }

  /**
   * Stop — every §7.4 hook lands here. The native side unpublishes,
   * disconnects, releases the Room (dropping the native keyring) and stops
   * the FGS; the `stopped` event closes the loop.
   *
   * Concurrent stops COALESCE: a second hook awaits the same in-flight
   * native teardown rather than resolving early (or being dropped). A
   * REJECTED bridge stop means the leg is NOT stopped — native may still
   * hold the MediaProjection — so nothing is announced and `active()` stays
   * true, which is what lets every later hook (and the user's next tap)
   * retry rather than no-op for the rest of the process. The SFU timeout and
   * voice-ingress's leg-left branch clear the SERVER state either way; only
   * the local capture needs the retry.
   */
  async stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    const attempt = this.#doStop().finally(() => {
      this.#stopPromise = undefined;
    });
    this.#stopPromise = attempt;
    return attempt;
  }

  async #doStop(): Promise<void> {
    // Claimed here so a resolution that arrives long after its own `stopped`
    // event cannot speak for whatever share is live BY THEN. The event is
    // emitted before native resolves the call, so the ordinary path is:
    // event clears `#active` and bumps, the user starts share 2, this
    // resolution lands — and without the token it would stop share 2 (UI off
    // + end-of-share sound) while share 2 is publishing happily.
    const generation = this.#connectGeneration;
    try {
      await withTimeout(
        plugin!.stop(),
        STOP_TIMEOUT_MS,
        "screen share stop timed out",
      );
    } catch {
      // NOT stopped: leave `#active` (and the UI) truthful so the next hook
      // retries. If native did tear down and only the resolution was lost,
      // its `stopped` event settles the state instead.
      return;
    }
    // A later share already owns the leg (its `stopped` event ran, or a new
    // connect claimed it) — this resolution is stale news, so announce
    // nothing.
    if (generation !== this.#connectGeneration) return;
    // Definitively down (native resolved the stop): orphan any connect still
    // in flight, as the `stopped` listener does.
    this.#connectGeneration++;
    // The native `stopped` event and this resolution race; whichever runs
    // first flips `#active` and announces — the other finds it already
    // false and stays quiet, so the end-of-share sound plays exactly once
    // even if the bridge drops the event.
    if (this.#active) {
      this.#active = false;
      this.onStopped?.("user");
    }
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

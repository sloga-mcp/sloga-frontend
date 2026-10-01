/**
 * The Android screen leg's decisions and lifecycle (screen-leg plan §7.2,
 * §7.4), kept import-free so `node --test` can load them.
 *
 * Split out of `state.tsx` and `androidScreenShare.ts` for the same reason as
 * `mlsRosterPolicy` and `mlsCallModePolicy`: the interesting cases here are
 * races (two USER-PACED dialogs on the start path; native events against
 * bridge resolutions on the stop path), and they are untestable while the
 * logic lives inside a class that needs a live Room, a client and a native
 * bridge to construct.
 *
 * The start-attempt checks serve one rule: an attempt owns the leg only until
 * something else claims it. Until `connect()` resolves the leg is not
 * `active()`, so the §7.4 stop hooks cannot see it — which is precisely why
 * the attempt has to keep checking whether it is still the current one.
 * [AndroidLegLifecycle] is the leg's state machine behind an injected bridge
 * and announcer; `androidScreenShare.ts` wires it to the plugin.
 */

/** A leg send key with its full provenance — §5.2's `LocalScreenKey`. */
export interface LegSendKey {
  keyB64: string;
  keyIndex: number;
  /** The MLS epoch the key belongs to — the native push fence. */
  epoch: number;
  /** The MLS group the key belongs to. Epochs are only comparable within one
   * group, so a group change makes two keys UNRELATABLE, not merely stale. */
  groupId: string;
}

export interface StartAttemptWorld {
  /** Generation this attempt claimed when it began. */
  generation: number;
  /** Generation now — bumped by every stop hook and every competing start. */
  currentGeneration: number;
  /** Whether the call room differs from the one the attempt started in. */
  roomChanged: boolean;
  /** Publish-gate reasons currently held; publishing flows only at zero. */
  publishGateSize: number;
}

/**
 * Was this attempt CANCELLED — did something else claim the leg?
 *
 * A stop hook, a competing tap, or leaving/switching the call. This is the
 * subset of staleness that means "somebody asked for this share to end", and
 * it is what decides whether a failure is worth REPORTING: a cancelled
 * attempt's rejection is the expected consequence of the cancellation, so
 * toasting it would show an error for a stop the user asked for.
 */
export function startAttemptCancelled(world: StartAttemptWorld): boolean {
  return world.generation !== world.currentGeneration || world.roomChanged;
}

/**
 * Has the world moved out from under this start attempt?
 *
 * TRUE means abandon — and, once `connect()` has resolved, TEAR DOWN rather
 * than merely return: past that point the OS is capturing and the leg is
 * publishing, so "give up quietly" is how a share outlives its own call.
 *
 * A held publish gate makes an attempt stale WITHOUT making it cancelled:
 * the leg must stop either way (§0.4), but nobody asked for this share to
 * end, so a genuine failure racing a transient gate pulse still deserves its
 * error message.
 */
export function startAttemptStale(world: StartAttemptWorld): boolean {
  return startAttemptCancelled(world) || world.publishGateSize > 0;
}

/** What `#syncLegKeyAfterConnect` must do once `connect()` resolves. */
export type PostConnectKeyAction =
  | { kind: "none" }
  | { kind: "push"; key: LegSendKey }
  | { kind: "stop" };

/**
 * Reconcile the key the leg connected with against the provider's current
 * record, immediately after `connect()` resolves.
 *
 * A rotation that lands while `connect()` is in flight reaches
 * `onLocalScreenKey` when the leg is not yet `active()`, and is dropped there.
 * The provider's `lastLocalScreenKey` is the authoritative record of "what key
 * should the leg be using now", so the attempt reconciles against it once the
 * sender exists.
 *
 * Compares the MATERIAL as well as the index: an index is only unique within
 * an epoch, so two epochs can legitimately reuse one and comparing indices
 * alone would silently skip a required rotation.
 *
 * A current key from a DIFFERENT group is a `stop`, not a push: the group was
 * re-established while the leg connected, epochs across groups are
 * uncomparable (so the native push fence cannot order the two keys), and a
 * leg keyed under a superseded group has no place in the new one.
 *
 * An E2EE leg with NO current key is a `stop` too: fail closed, because a leg
 * must never stay live under a key its group no longer vouches for. The
 * provider clears its record when the group is replaced (`resetForGroup`) or
 * when an install carries no entry for this device, and either can land while
 * `connect()` is in flight — the leg then comes up under the key it connected
 * with, which nothing current backs.
 */
export function keyActionAfterConnect(
  connectedWith: LegSendKey | undefined,
  current: LegSendKey | undefined,
): PostConnectKeyAction {
  // A plaintext leg has no send key and must not acquire one here: handing it
  // a key would be a silent, unannounced upgrade the rest of the call has not
  // agreed to.
  if (!connectedWith) return { kind: "none" };
  // The provider dropped its record while the leg connected (see above), so
  // the key the leg is publishing under is no longer vouched for: stop.
  if (!current) return { kind: "stop" };
  if (current.groupId !== connectedWith.groupId) return { kind: "stop" };
  if (
    current.epoch === connectedWith.epoch &&
    current.keyIndex === connectedWith.keyIndex &&
    current.keyB64 === connectedWith.keyB64
  )
    return { kind: "none" };
  return { kind: "push", key: current };
}

/** The key as it crosses the bridge. DERIVED from [LegSendKey] by dropping
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
export type NativeFrameKey = Omit<LegSendKey, "groupId">;

export type NativeStopReason = "user" | "system" | "disconnected" | "error";

/** Ceiling on a native `stop()`. The Kotlin side settles in a `finally`, so
 * a lost settlement is already remote — but the in-flight stop clears only
 * when the call settles, so without a bound every later hook AND the user's
 * next tap would coalesce onto a dead promise: an unstoppable share. A
 * timeout reads as "not stopped" (the leg stays `active()`), which is exactly
 * the state that lets the next hook retry. */
export const STOP_TIMEOUT_MS = 15_000;

/** Reject `work` if it has not settled within `ms`. The loser's late
 * settlement is absorbed by the race rather than surfacing unhandled. */
export function withTimeout<T>(
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

/** The native calls the lifecycle drives — the plugin, in production. */
export interface LegBridge {
  setFrameKey(key: NativeFrameKey): Promise<void>;
  stop(): Promise<void>;
}

/** Where the lifecycle reports the share's start and end. */
export interface LegAnnouncer {
  started(): void;
  stopped(reason: NativeStopReason): void;
}

/**
 * The live leg's state, at most one per call. The owner feeds it the native
 * `started`/`stopped` events and routes every §7.4 stop hook through [stop].
 *
 * `active` is true from a resolved [connect] until the terminal `stopped`
 * event — INCLUDING the whole native teardown, so a stop hook firing twice
 * (pause gate + disconnect, say) collapses into one native `stop()`.
 */
export class AndroidLegLifecycle {
  #bridge: LegBridge;
  #announce: LegAnnouncer;
  #stopTimeoutMs: number;
  #active = false;
  /** In-flight [stop], while one runs. Concurrent stops COALESCE onto it —
   * a hook that fires during a teardown must wait for that teardown, not be
   * discarded (a discarded stop resolves before native has released the
   * MediaProjection, and its caller then believes the capture is over). */
  #stopPromise: Promise<void> | undefined;
  /** The group the current share connected under — the JS half of the key
   * fence (see [NativeFrameKey]); undefined for a plaintext leg. */
  #e2eeGroupId: string | undefined;
  /** Claimed by each [connect] and invalidated by every definitive stop, so
   * a connect resolving after its share already ended cannot resurrect
   * `#active`. */
  #connectGeneration = 0;

  constructor(
    bridge: LegBridge,
    announce: LegAnnouncer,
    stopTimeoutMs: number = STOP_TIMEOUT_MS,
  ) {
    this.#bridge = bridge;
    this.#announce = announce;
    this.#stopTimeoutMs = stopTimeoutMs;
  }

  active(): boolean {
    return this.#active;
  }

  /** The native `started` event. */
  nativeStarted(): void {
    this.#active = true;
    this.#announce.started();
  }

  /** The native `stopped` event; a missing reason reads as `"error"`. */
  nativeStopped(reason: NativeStopReason | undefined): void {
    const wasActive = this.#active;
    this.#active = false;
    // Definitively down: orphan any connect still in flight so its
    // resolution cannot flip `#active` back on.
    this.#connectGeneration++;
    // A stopped for a leg that never reported started (connect() threw
    // after partial setup) has nothing to announce.
    if (wasActive) this.#announce.stopped(reason ?? "error");
  }

  /**
   * Phase 2 around the caller's `publish` (the native connect). `publish`
   * receives the key WITHOUT its group; a plaintext share passes undefined.
   */
  async connect(
    e2ee: LegSendKey | undefined,
    publish: (key: NativeFrameKey | undefined) => Promise<unknown>,
  ): Promise<void> {
    // Bind the group BEFORE the await, because `#active` does not wait for
    // this call to resolve: native fires `started` a bridge hop earlier and
    // [nativeStarted] flips the flag there (deliberately — a stop hook must
    // be able to see the leg the instant it is capturing). Binding after the
    // await left a window where a rotation found `active()` true and
    // `#e2eeGroupId` still undefined (or the PREVIOUS share's group), so the
    // fence rejected a perfectly good key and fail-closed a healthy share —
    // any join or leave during a share start would do it. Assigned
    // unconditionally, so a plaintext share correctly rebinds to undefined;
    // a failed connect leaves `#active` false, which makes a stale value
    // unreadable.
    this.#e2eeGroupId = e2ee?.groupId;
    const generation = ++this.#connectGeneration;
    await publish(
      e2ee && {
        keyB64: e2ee.keyB64,
        keyIndex: e2ee.keyIndex,
        epoch: e2ee.epoch,
      },
    );
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
  async setFrameKey(key: LegSendKey): Promise<void> {
    if (!this.#active) return;
    // Group fence (JS half): the native epoch fence can only order pushes
    // WITHIN one group. A key from any other group — a re-establish raced
    // the leg — is uncomparable and unsafe; throw so the caller's
    // fail-closed path stops the leg.
    if (key.groupId !== this.#e2eeGroupId)
      throw new Error("screen leg key is from a different group");
    await this.#bridge.setFrameKey({
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
        this.#bridge.stop(),
        this.#stopTimeoutMs,
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
    // in flight, as [nativeStopped] does.
    this.#connectGeneration++;
    // The native `stopped` event and this resolution race; whichever runs
    // first flips `#active` and announces — the other finds it already
    // false and stays quiet, so the end-of-share sound plays exactly once
    // even if the bridge drops the event.
    if (this.#active) {
      this.#active = false;
      this.#announce.stopped("user");
    }
  }
}

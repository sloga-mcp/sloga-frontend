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
 * What this leaf decides:
 *
 * - Whether a start attempt still owns the leg ([startAttemptStale],
 *   [startAttemptCancelled]). One rule: an attempt owns the leg only until
 *   something else claims it. Until `connect()` resolves the leg is not
 *   `active()`, so the §7.4 stop hooks cannot see it — which is precisely
 *   why the attempt has to keep checking whether it is still the current one.
 * - Which key the leg must use once `connect()` resolves
 *   ([keyActionAfterConnect]).
 * - Which notice, if any, an ended share deserves ([LegStopNotice]): a
 *   native stop by its reason ([nativeStopNotice]), a publish-gate pulse
 *   that stopped a starting or live leg ([gateStopNotice]), and a start
 *   attempt abandoned under a gate that was already held when it claimed
 *   ([staleExitNotice]). `state.tsx` maps the kind to copy; nothing here
 *   holds a string the user reads.
 * - Which notice, if any, a failed leg re-key deserves once the caller's
 *   fail-closed stop has settled ([rekeyFailureNotice]): none, stopped, or a
 *   share the stop could not end. Also a kind, mapped to copy in `state.tsx`.
 * - The leg's state machine ([AndroidLegLifecycle]), behind an injected
 *   bridge and announcer; `androidScreenShare.ts` wires it to the plugin.
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
 * As a predicate, a held publish gate makes an attempt stale WITHOUT making
 * it cancelled: the leg must stop either way (§0.4). In practice which of
 * the two a gate is depends on WHEN its reason was added:
 *
 * - DURING the attempt (after the claim): `#pauseGate` stops the leg through
 *   `#stopAndroidLeg`, which bumps the generation, so the pulse IS a
 *   cancellation — the attempt exits quietly, and a failure racing it is not
 *   toasted. The user hears about it from [gateStopNotice], which
 *   `#pauseGate` consults.
 * - BEFORE the claim (e.g. while the tier sheet was open): that stop bumped
 *   a generation this attempt had not taken yet, so nothing cancels it; it
 *   is stale but not cancelled at its first stale check while the reason is
 *   still held, and [staleExitNotice] reports it. [gateStopNotice] saw no
 *   starting attempt then, so the user is told once, not twice.
 */
export function startAttemptStale(world: StartAttemptWorld): boolean {
  return startAttemptCancelled(world) || world.publishGateSize > 0;
}

/**
 * The notice for a start attempt that exits at a stale check.
 *
 * Stale but NOT cancelled means a publish-gate reason was already held when
 * this attempt claimed the leg (see [startAttemptStale]): nobody asked for
 * the share to end and no stop hook announced anything, so the user is told
 * the share could not start. A cancelled attempt was ended by something that
 * speaks for itself (a tap, a hang-up, [gateStopNotice]); a fresh one is not
 * exiting at all.
 */
export function staleExitNotice(world: StartAttemptWorld): LegStopNotice {
  return startAttemptStale(world) && !startAttemptCancelled(world)
    ? "gate-start"
    : "none";
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

/** Why native ended the leg, as carried by its `stopped` event. `"revoked"`
 * is the SERVER ending it: the leg's publish permission was taken away (a
 * Video revoke, an AFK move), not anything this device asked for. */
export type NativeStopReason =
  | "user"
  | "system"
  | "disconnected"
  | "error"
  | "revoked";

/**
 * Which notice, if any, an ended (or never-started) share deserves. A KIND,
 * not copy: `state.tsx` maps each one to its message. `"none"` means stay
 * quiet — the user asked for the stop, or something else already says why.
 */
export type LegStopNotice =
  | "none"
  | "connection"
  | "encryption"
  | "revoked"
  | "gate-start"
  | "gate-share";

/**
 * The notice for a native `stopped` event.
 *
 * `user` and `system` are stops taken on this device (our own stop; the
 * system chip, the notification's Stop, or the OS ending the projection):
 * no notice. `disconnected` is the leg losing its connection; `error` is a
 * sender that can no longer be trusted to encrypt (and the reading of a
 * `stopped` with no reason — see [AndroidLegLifecycle.nativeStopped]).
 *
 * `revoked` is the server ending the share. It is QUIET when the loss is
 * primary-wide: the primary's own afk-publish / moderator-mute toast already
 * explains it, and a second toast for the leg would say the same thing
 * worse. `inAfkChannel` is read as well as `canPublish` because the two
 * revokes are pushed separately and the leg's can land FIRST — at that
 * moment the primary may still report `canPublish` true, but it is already
 * in the AFK channel. `canPublish` undefined (not yet known) is not a
 * primary-wide loss, so the leg's notice stands.
 *
 * Any reason outside the union — a newer native build ahead of this JS —
 * reads as `none`: an unknown stop is not worth a misleading message.
 */
export function nativeStopNotice(
  reason: NativeStopReason,
  primary: { canPublish: boolean | undefined; inAfkChannel: boolean },
): LegStopNotice {
  switch (reason) {
    case "user":
    case "system":
      return "none";
    case "disconnected":
      return "connection";
    case "error":
      return "encryption";
    case "revoked":
      return primary.canPublish === false || primary.inAfkChannel
        ? "none"
        : "revoked";
    default: {
      // Compile-time: a reason added to the union without an arm here fails
      // to type-check. Runtime: whatever native sent that is not in it.
      const unknownReason: never = reason;
      void unknownReason;
      return "none";
    }
  }
}

/** What [gateStopNotice] reads, sampled by `#pauseGate` BEFORE its stop
 * bumps the generation. */
export interface GateStopWorld {
  /** The generation of the start attempt between `prepare()` and its own
   * settlement (`#androidLegStartingFor`), or undefined when none is. */
  startingFor: number | undefined;
  /** The start-attempt generation now (`#androidLegGeneration`). */
  currentGeneration: number;
  /** The leg's [AndroidLegLifecycle.active]. */
  active: boolean;
  /** The leg's [AndroidLegLifecycle.stopping]: a teardown already under way. */
  stopInFlight: boolean;
  /** Whether the call room is still connected. */
  roomConnected: boolean;
}

/**
 * The notice for a publish-gate pulse that stops the leg — which it does,
 * through `#stopAndroidLeg`, on every reason ADD (§0.4). Without one the
 * share ends, or never arrives, with no word to the user.
 *
 * - A room that is no longer connected is a call ending, which explains
 *   itself: none.
 * - A LIVE leg the gate takes down: `gate-share`. Not when a stop is already
 *   in flight — that teardown was asked for by something else (a tap, a
 *   hook), and the gate merely coalesces onto it.
 * - A STARTING leg (not yet `active()`) whose attempt still owns the
 *   generation: `gate-start` — the stop is about to cancel it, so its own
 *   stale check will exit quietly. An owner whose generation was already
 *   bumped (a cancelling tap got there first) was ended by that tap: none.
 */
export function gateStopNotice(w: GateStopWorld): LegStopNotice {
  if (!w.roomConnected) return "none";
  if (w.active && !w.stopInFlight) return "gate-share";
  if (
    !w.active &&
    w.startingFor !== undefined &&
    w.startingFor === w.currentGeneration
  )
    return "gate-start";
  return "none";
}

/** Which notice, if any, a failed leg re-key deserves. A KIND, not copy:
 * `state.tsx` maps each one to its message. */
export type RekeyFailureNotice = "none" | "stopped" | "unstoppable";

/**
 * The notice for a leg re-key that failed (a rejected or timed-out
 * [AndroidLegLifecycle.setFrameKey], or a key the leg must not take), read
 * once the caller's fail-closed stop has settled.
 *
 * The caller samples the two inputs on either side of that stop. `spoken` is
 * read BEFORE it: a stop already in flight, or a leg already down, was ended
 * by something that spoke for itself (or deliberately said nothing).
 * `activeAfterStop` is read AFTER it, and only for the SAME share: the leg
 * still `active()` AND its [AndroidLegLifecycle.shareToken] unchanged across
 * the await. A new share started while the stop ran is not the one that
 * failed, and must not raise an alarm.
 *
 * - `activeAfterStop`: `unstoppable`, whoever spoke first. The stop failed
 *   or timed out and the share is still live. A gate-share stop in flight
 *   that then fails told the user "stopped" too, so a share still live must
 *   be reported whatever was said before.
 * - Otherwise `spoken`: none. The share is down and something else already
 *   explained (or deliberately did not explain) why.
 * - Otherwise `stopped`.
 *
 * Two rotations failing together coalesce on one stop and each may announce
 * (accepted). A native re-key that lands after its timeout may leave the leg
 * on the NEW key after all, which is why the unstoppable copy says "may".
 */
export function rekeyFailureNotice(w: {
  spoken: boolean;
  activeAfterStop: boolean;
}): RekeyFailureNotice {
  if (w.activeAfterStop) return "unstoppable";
  if (w.spoken) return "none";
  return "stopped";
}

/** Ceiling on a native `stop()`. The Kotlin side settles in a `finally`, so
 * a lost settlement is already remote — but the in-flight stop clears only
 * when the call settles, so without a bound every later hook AND the user's
 * next tap would coalesce onto a dead promise: an unstoppable share. A
 * timeout reads as "not stopped" (the leg stays `active()`), which is exactly
 * the state that lets the next hook retry. */
export const STOP_TIMEOUT_MS = 15_000;

/** Ceiling on a native re-key ([AndroidLegLifecycle.setFrameKey]). A push
 * that never settles would leave the leg encrypting under the previous
 * epoch's key — one a removed member still holds — and the provider's
 * rotation, which awaits this push before reporting the local key installed,
 * hung behind it. A timeout reads as a rejection, which the callers already
 * treat as fail closed (stop the leg, tell the user). 5 s is far above a
 * local Kotlin `setRawKey` round trip; [withTimeout] absorbs the loser's late
 * settlement. */
export const FRAME_KEY_TIMEOUT_MS = 5_000;

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
  #frameKeyTimeoutMs: number;
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
    frameKeyTimeoutMs: number = FRAME_KEY_TIMEOUT_MS,
  ) {
    this.#bridge = bridge;
    this.#announce = announce;
    this.#stopTimeoutMs = stopTimeoutMs;
    this.#frameKeyTimeoutMs = frameKeyTimeoutMs;
  }

  active(): boolean {
    return this.#active;
  }

  /** True while a [stop] is in flight — its memoized teardown has not
   * settled — and false otherwise. Lets [gateStopNotice] tell a gate that
   * ends the share from one that coalesces onto a stop already asked for. */
  stopping(): boolean {
    return this.#stopPromise !== undefined;
  }

  /** Identifies "the same share" across an await: a caller that samples it
   * before a stop and compares it after can tell the share it acted on from
   * one started meanwhile ([rekeyFailureNotice]'s `activeAfterStop`). Bumped
   * only by [connect], [nativeStopped] and a RESOLVED [stop] that still
   * speaks for the current share; never by a stop hook (hooks reach the leg
   * only through [stop]), a rejected stop or a timed-out stop. So across a
   * FAILED stop the token is unchanged, and a leg still `active()` with the
   * same token is the same share. */
  shareToken(): number {
    return this.#connectGeneration;
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
   * rejection here — including a native call that does not settle within
   * [FRAME_KEY_TIMEOUT_MS] — means the leg cannot be trusted on the new
   * epoch: the caller stops the leg (fail closed) and resolves the provider's
   * push. The lifecycle does not stop itself on a timeout: `active()` stays
   * as it was, and the stop and the notice are the caller's, exactly as for
   * a native rejection.
   */
  async setFrameKey(key: LegSendKey): Promise<void> {
    if (!this.#active) return;
    // Group fence (JS half): the native epoch fence can only order pushes
    // WITHIN one group. A key from any other group — a re-establish raced
    // the leg — is uncomparable and unsafe; throw so the caller's
    // fail-closed path stops the leg.
    if (key.groupId !== this.#e2eeGroupId)
      throw new Error("screen leg key is from a different group");
    await withTimeout(
      this.#bridge.setFrameKey({
        keyB64: key.keyB64,
        keyIndex: key.keyIndex,
        epoch: key.epoch,
      }),
      this.#frameKeyTimeoutMs,
      "screen share re-key timed out",
    );
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

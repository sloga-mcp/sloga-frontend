/**
 * Camera processor attach: the PURE decision core plus the defer/edge driver
 * for reconciling the camera's one LiveKit processor slot with the settings
 * while the publish gate may be held. Extracted so `node --test` can load it
 * and the mutation suite can reach every arm (the house no-vitest split; this
 * module must stay dependency-free, the track is a type parameter only).
 *
 * Why this exists. A camera effect (background blur or image, face filter,
 * the brightness fallback) occupies the track's single processor slot, and
 * putting one in or taking one out ends in `sender.replaceTrack`. Two things
 * were wrong with doing that straight from the settings:
 *
 * 1. The attach was not deferred while the publish gate is held. The gate
 *    pauses every sender while keys are negotiated; a `replaceTrack` issued
 *    inside that window puts media back on the sender until the gate's
 *    re-assert lands. The mic had the same hole and closed it in
 *    `micPipelinePolicy.ts`; this is the camera's twin. Nothing is queued
 *    while deferred: the caller fires `sync()` again at the gate's single
 *    1→0 edge and at the camera publication landing, and the decision is
 *    re-made from live state.
 *
 * 2. A wanted background could resume as RAW video. The gate's 1→0 resume
 *    knows nothing about effects, so a camera whose background was still
 *    pending (deferred, initializing, or failed) was resumed showing the
 *    room. A background is a privacy control, so the rule here is fail
 *    closed: while a background is wanted but not verifiably active the
 *    camera's upstream stays under a hold the gate resume skips, and when
 *    the background cannot be made active the camera is muted before
 *    anything is detached. A face filter or the brightness fallback is
 *    cosmetic, so those fail open: the effect drops and raw video continues.
 *
 * What the hold does and does not do. It keeps the gate's 1→0 resume, and
 * this driver's own release, away from a camera whose background is not
 * verified. It does NOT cover the raw transit of a swap: LiveKit writes the
 * sender directly inside `stopProcessor` / `setProcessor`, hold or no hold,
 * and the frames sent before a swap into a background already showed the
 * room.
 *
 * The decision is made before `apply` runs, and both the settings and the
 * gate can change in between. So the decision is also enforced at the
 * moment of each sender operation: `plan` returns the settings snapshot it
 * read, `apply` works from that same snapshot, and `apply` is handed a
 * guard it must ask synchronously before every `setProcessor` /
 * `stopProcessor`. The guard says yes only when the decision was "apply"
 * and the gate is still empty right then. A tune can therefore never issue
 * a sender operation, and an apply cannot once the gate has filled; a
 * refused operation comes back as `failed: "gate"` and the pass is
 * deferred like any other.
 *
 * What is stored between `sync()` calls: the promise chain that serializes
 * them, and which track currently carries this driver's hold (so a hold on
 * a track that has since been replaced or unpublished can be released on
 * that old track). No plan, no pending action, no result.
 *
 * Rejecting deps. `apply` is specified never to throw and the others are
 * not expected to, but none of them may wedge the chain or leave the camera
 * showing raw video behind a wanted background:
 *
 * - `plan` rejects: whether a background is wanted is unknown, so it is
 *   treated as wanted. Fail closed.
 * - `setHold(track, true)` rejects: the hold cannot be trusted. Fail closed.
 * - `apply` rejects: fail closed when the plan wanted a background;
 *   otherwise fail open, reported as `"face"` when a face filter was wanted
 *   and as `"brightness"` for anything else.
 * - `muteCamera` rejects inside the fail-closed sequence: the camera is not
 *   known to be muted, so nothing is torn down (a detach would put raw video
 *   on an unmuted sender) and the hold is taken and kept instead. The next
 *   `sync()` re-decides and retries. This is the one case where a hold stays
 *   on without an active background, and the outcome says `muted: false`.
 * - `teardown` rejects: the camera is already muted; the hold is released.
 * - `setHold(track, false)` rejects: the hold stays recorded and the next
 *   `sync()` releases it.
 *
 * `sync()` itself rejects only if the synchronous `track()` or `gateHeld()`
 * throws, and even then the chain continues with the next call.
 */

export type CameraOccupant =
  | "none"
  | "background"
  | "face"
  | "brightness-fallback";
export type CameraSenderOp = "setProcessor" | "stopProcessor";

export interface CameraPlan {
  /** What holds the LiveKit processor slot now. */
  current: CameraOccupant;
  /** What the settings + capabilities ask for (pickSlotOccupant result). */
  wanted: CameraOccupant;
  /** wanted === "background", image mode, and a SELECTED image id does not resolve. */
  backgroundUnresolved: boolean;
  /** current occupant is attached to the track AND its processedTrack is live. */
  active: boolean;
}

const NO_OPS: readonly CameraSenderOp[] = Object.freeze([]);
const ATTACH: readonly CameraSenderOp[] = Object.freeze(["setProcessor"]);
const DETACH: readonly CameraSenderOp[] = Object.freeze(["stopProcessor"]);
const SWAP: readonly CameraSenderOp[] = Object.freeze([
  "stopProcessor",
  "setProcessor",
]);

/**
 * Sender operations an apply of this plan would issue. Pure.
 *
 * - `backgroundUnresolved` → none. The background cannot be built, so there
 *   is nothing to attach; the driver treats this as a background FAILURE
 *   (fail closed), never as "show raw".
 * - `current === wanted` → none (a tune, or nothing at all).
 * - nothing attached → one `setProcessor`.
 * - nothing wanted → one `stopProcessor`.
 * - a different occupant wanted → `stopProcessor` then `setProcessor`.
 *   LiveKit transits the RAW track between the two. The hold does not
 *   prevent that; see the header.
 */
export function planCameraOps(plan: CameraPlan): readonly CameraSenderOp[] {
  if (plan.backgroundUnresolved) return NO_OPS;
  if (plan.current === plan.wanted) return NO_OPS;
  if (plan.current === "none") return ATTACH;
  if (plan.wanted === "none") return DETACH;
  return SWAP;
}

export type CameraAttachAction = "tune" | "none" | "defer" | "apply";

/**
 * Decide, in this order:
 *
 * 1. No ops and an occupant → `"tune"`, REGARDLESS of the gate. A tune
 *    changes the occupant's own parameters and issues zero sender
 *    operations, so there is nothing for the gate to protect, and deferring
 *    it would leave a settings change unapplied for the whole hold.
 * 2. No ops → `"none"`. A held gate must never turn "nothing to do" into a
 *    deferred apply that the edge would then wrongly perform.
 * 3. Gate held → `"defer"`. Every remaining plan issues a sender operation.
 * 4. Otherwise `"apply"`.
 *
 * The gate is consulted ONLY for plans that touch the sender.
 */
export function cameraAttachAction(i: {
  ops: readonly CameraSenderOp[];
  hasOccupant: boolean;
  gateHeld: boolean;
}): CameraAttachAction {
  if (i.ops.length === 0 && i.hasOccupant) return "tune";
  if (i.ops.length === 0) return "none";
  if (i.gateHeld) return "defer";
  return "apply";
}

/**
 * Camera upstream must stay paused until the plan lands (the privacy hold):
 * a background is wanted and it is not the case that a resolved background
 * is attached and live right now.
 */
export function cameraNeedsHold(plan: CameraPlan): boolean {
  return (
    plan.wanted === "background" &&
    !(
      plan.current === "background" &&
      plan.active &&
      !plan.backgroundUnresolved
    )
  );
}

/**
 * Handed to `apply`. It must be asked synchronously, immediately before
 * EVERY `setProcessor` / `stopProcessor`; on false the operation is not
 * issued and `apply` returns `failed: "gate"`.
 */
export interface CameraOpGuard {
  maySenderOp(): boolean;
}

export type CameraApplyResult =
  | { ok: true; occupant: CameraOccupant; active: boolean }
  | { ok: false; failed: "background" | "face" | "brightness"; error: unknown }
  /** The guard refused a sender operation; nothing was issued for it. */
  | { ok: false; failed: "gate"; error: undefined };

export type CameraAttachOutcome =
  | { kind: "none" | "tuned" | "deferred" | "applied" }
  /**
   * Background: the camera was muted. `muted` is false when `muteCamera()`
   * rejected; the camera is then kept under the hold instead.
   */
  | { kind: "failed-closed"; error: unknown; muted: boolean }
  /** The raw camera continues. */
  | { kind: "failed-open"; failed: "face" | "brightness"; error: unknown };

/** `S` is the settings snapshot `plan` read once and `apply` reuses. */
export interface CameraAttachDeps<T extends object, S> {
  gateHeld(): boolean;
  /** The published camera track of the current room, or undefined. */
  track(): T | undefined;
  plan(track: T): Promise<{ plan: CameraPlan; snapshot: S }>;
  /**
   * Apply the snapshot's settings (no second live read). Never throws. Asks
   * the guard before every sender op. Never issues stopProcessor on a
   * background failure.
   */
  apply(
    track: T,
    snapshot: S,
    guard: CameraOpGuard,
  ): Promise<CameraApplyResult>;
  /** Put the track under / release it from the privacy hold (pause upstream; kept out of gate resume). */
  setHold(track: T, held: boolean): Promise<void>;
  /** Mute the camera publication (no sender op). */
  muteCamera(): Promise<void>;
  /** Take the (now muted) camera down: unpublish it and drop its occupant. */
  teardown(track: T): Promise<void>;
}

export class CameraAttachDriver<T extends object, S> {
  readonly #deps: CameraAttachDeps<T, S>;
  /** Serializes `sync()`; never rejects. */
  #chain: Promise<void> = Promise.resolve();
  /** The track that carries this driver's hold, if any. */
  #held: T | undefined;

  constructor(deps: CameraAttachDeps<T, S>) {
    this.#deps = deps;
  }

  /**
   * Re-decide from live state. Serialized: a call made while another is in
   * flight runs after it and reads the state that one left. Callers may
   * fire it freely.
   */
  sync(): Promise<CameraAttachOutcome> {
    const run = this.#chain.then(() => this.#run());
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #run(): Promise<CameraAttachOutcome> {
    const deps = this.#deps;
    const track = deps.track();

    // A hold on a track that is no longer the camera is released on THAT
    // track; it protects nothing any more.
    if (this.#held !== undefined && this.#held !== track) {
      await this.#release(this.#held);
    }
    if (track === undefined) return { kind: "none" };

    let planned: { plan: CameraPlan; snapshot: S } | undefined;
    let planError: unknown;
    try {
      planned = await deps.plan(track);
    } catch (error) {
      planError = error;
    }
    // Stale: the camera changed under the plan. Drop any hold this driver
    // has on the old track and do nothing else; the caller fires again for
    // the new one.
    if (deps.track() !== track) {
      await this.#release(track);
      return { kind: "none" };
    }
    if (planned === undefined) return this.#failClosed(track, planError);
    const { plan, snapshot } = planned;

    // The hold goes on BEFORE the gate is consulted, and also when the
    // answer turns out to be "defer": the gate's 1→0 resume must skip this
    // camera until the background is verified.
    const needsHold = cameraNeedsHold(plan);
    if (needsHold) {
      this.#held = track;
      try {
        await deps.setHold(track, true);
      } catch (error) {
        return this.#failClosed(track, error);
      }
    }

    // Read AFTER the awaits above: a gate that filled meanwhile defers.
    const action = cameraAttachAction({
      ops: planCameraOps(plan),
      hasOccupant: plan.current !== "none",
      gateHeld: deps.gateHeld(),
    });

    if (plan.backgroundUnresolved) {
      return this.#failClosed(
        track,
        new Error("camera background image does not resolve"),
      );
    }
    if (action === "defer") return { kind: "deferred" };
    if (action === "none") {
      await this.#release(track);
      return { kind: "none" };
    }

    // Asked by apply at the moment of each sender op, not now: a tune may
    // never issue one, and an apply may not once the gate has filled.
    const guard: CameraOpGuard = {
      maySenderOp: () => action === "apply" && !deps.gateHeld(),
    };
    let result: CameraApplyResult;
    try {
      result = await deps.apply(track, snapshot, guard);
    } catch (error) {
      result = {
        ok: false,
        failed:
          plan.wanted === "background"
            ? "background"
            : plan.wanted === "face"
              ? "face"
              : "brightness",
        error,
      };
    }

    // Stale: the camera was replaced or unpublished while apply ran. Its
    // result says nothing about the new camera, so nothing is muted or torn
    // down for it; only a hold on the old track is dropped.
    if (deps.track() !== track) {
      await this.#release(track);
      return { kind: "none" };
    }

    if (!result.ok) {
      // A refused sender op: deferred like any other, and a hold stays.
      if (result.failed === "gate") return { kind: "deferred" };
      if (result.failed === "background") {
        return this.#failClosed(track, result.error);
      }
      // Raw video is what a failed cosmetic effect falls back to, so a hold
      // left over from an earlier background want has nothing to protect.
      await this.#release(track);
      return {
        kind: "failed-open",
        failed: result.failed,
        error: result.error,
      };
    }
    // A result that is not a background at all means the settings changed
    // while the apply ran (the user turned the background off): that is not
    // a failure, the hold goes and the outcome is the normal one. A
    // background that is attached but not live fails closed whether or not
    // this pass took the hold.
    if (result.occupant === "background" && !result.active) {
      return this.#failClosed(
        track,
        new Error("camera background is not active after apply"),
      );
    }
    // Only now, with the background verified active (or no longer wanted).
    await this.#release(track);
    return { kind: action === "tune" ? "tuned" : "applied" };
  }

  /**
   * The background cannot be made active. Order is the invariant: mute
   * FIRST, then tear down, then release the hold. Tearing down or releasing
   * before the mute would put raw video on a live sender.
   */
  async #failClosed(track: T, error: unknown): Promise<CameraAttachOutcome> {
    const deps = this.#deps;
    try {
      await deps.muteCamera();
    } catch {
      // Not known to be muted: keep the sender paused and detach nothing.
      this.#held = track;
      try {
        await deps.setHold(track, true);
      } catch {
        // The next sync() re-decides and retries.
      }
      return { kind: "failed-closed", error, muted: false };
    }
    try {
      await deps.teardown(track);
    } catch {
      // Muted already; a leftover occupant is re-planned on the next sync().
    }
    this.#held = track;
    await this.#release(track);
    return { kind: "failed-closed", error, muted: true };
  }

  /** Release this driver's hold on `track`, if it carries one. */
  async #release(track: T): Promise<void> {
    if (this.#held !== track) return;
    try {
      await this.#deps.setHold(track, false);
      this.#held = undefined;
    } catch {
      // Still recorded: the next sync() retries the release.
    }
  }
}

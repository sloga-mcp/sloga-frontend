/**
 * MlsCallSession — MLS call control plane (media E2EE, slice 6.4 steps 3-4).
 *
 * Drives the MLS Delivery Service control plane the 6.3 plumbing left inert:
 * one session per active call, owning create-or-join, the admit scheduler,
 * commit submit/arbitrate + rebase, and the per-group mailbox drain (step 3).
 *
 * Step 4 adds the ROTATION SEAM — the session's first contact with the media
 * plane, via an optional `bindMedia({installer, localIdentity, …})` binding (a
 * narrow `KeyInstaller` structural interface the `MlsKeyProvider` satisfies, so
 * the seam is auditable without a real Room). It becomes the SOLE `applyKeys`
 * driver (NEW-3): `state.tsx`'s keys-changed loop routes each local epoch
 * advance into `onLocalKeysChanged`, which classifies the epoch (own-won from
 * the staged-commit KIND, inbound from `MlsProcessOutcome.removed`, first-key,
 * fail-safe) and times the local-last send-key install — Remove-immediate vs a
 * ≤2 s epoch-fenced Add-grace (C1 + NEW-1). It also owns lag warn/desync and
 * the §4.4 loud-state debounce. The remaining Room-facing pieces stay out of
 * scope:
 *   - roster reconciliation + leave-grace — step 5;
 *   - `setE2EEEnabled(true)` + the plaintext-until-first-key guard + heartbeat
 *     + re-upgrade hysteresis + caps, and the actual `state.tsx` construction +
 *     wiring of this session (incl. replacing the 6.3 auto-loop with
 *     `onLocalKeysChanged`) — step 6.
 * Until step 6 constructs + binds it, this module is consumed only by its own
 * exported helpers (auditable in isolation, the house no-vitest split).
 *
 * Security-critical invariants folded from the media-e2ee-reviewer plan audit
 * (see `stoatchat/docs/e2ee-media-slice-6.4-breakdown.md`):
 *   - **H1 / NEW-2:** outbound submit and inbound drain share ONE per-group
 *     mutex spanning the submit round-trip; an inbound commit at the epoch our
 *     own commit is staged for clears the pending commit BEFORE processing (so
 *     native never poisons the group on a benign lost race); rebase +
 *     gap-refetch run INLINE within the current lock hold (a direct
 *     `processEnvelope` loop), never re-dispatched through the mutex-guarded
 *     queue (that would self-deadlock).
 *   - **M4 / carried item 4:** park/gap-refetch is bounded (→ rejoin-fresh),
 *     per-envelope error retry is bounded (→ ack+drop-as-poison), submit has a
 *     bounded timeout, and re-establish is bounded — nothing spins forever.
 *   - **L1:** a create-race loser leave-cleans its orphan epoch-0 group first.
 *   - **L2:** a 409-Lost / gap-refetch `MlsCommitInfo` is fed through the drain
 *     as a synthesized envelope (native dedups by epoch, not id).
 *   - **L4:** `feature_disabled` is "not an E2EE call" (quiet plaintext), never
 *     a loud failure.
 *   - **L5:** an inbound commit that removed US tears down + suppresses the
 *     keys-changed handling for the group.
 *   - **C1 (recorded here, consumed in step 4):** the staged-commit KIND of an
 *     own-won epoch is remembered so step 4 can classify Add-grace vs
 *     Remove-immediate — `commit_won` returns `removed: []` unconditionally, so
 *     the outcome alone would mis-classify an own-won Remove as Add-driven.
 *   - **NEW-6 (superseded):** teardown never blocks on the per-group mutex.
 *     The original best-effort self-`callRemove` was REMOVED — OpenMLS
 *     forbids self-removal (CannotRemoveSelf), so it could never execute;
 *     roster cleanup is peers' leave-grace removal / the DS rejoin
 *     affordance (see #teardownGroup).
 *   - **C1 / NEW-1 (step 4):** own-won epochs classify from the staged-commit
 *     KIND (`commit_won` returns `removed: []` unconditionally, so the outcome
 *     alone mis-reads an own-won Remove as Add-driven); unknown ⇒ fail-safe
 *     Remove-immediate; the deferred Add-grace local install is epoch-fenced
 *     and cancelled by any newer epoch / Remove-immediate, so a stale timer can
 *     never regress the send index back onto a removed-member-readable epoch.
 */
import type {
  E2EEBridge,
  MlsClaimResult,
  MlsClaimedKeyPackage,
  MlsCommitInfo,
  MlsEnvelope,
  MlsFrameKeys,
  MlsHttpResult,
  MlsJoinRequest,
  MlsProcessOutcome,
  MlsSinkEvent,
  MlsSubmitCommit,
  ResponseCreateMlsGroup,
  ResponseSubmitMlsCommit,
} from "@revolt/client";

import {
  type CallMode,
  type CallModeEvent,
  callModeTransition,
  parseCtlPayload,
} from "./mlsCallModePolicy";
import { drainAction } from "./mlsDrainPolicy";
import { joinRequestAction } from "./mlsJoinRequestPolicy";

// ---- Timings + bounds (plan §1.4 / §3.3; all bounded — nothing spins) -------

/** Admit stagger per leaf index (plan §1.4 step 2): `leafIndex · 2 s`. */
const ADMIT_STAGGER_MS = 2_000;
/** Joiner re-broadcast interval waiting for a Welcome (plan §1.4). */
const JOINER_RETRY_MS = 10_000;
/** Joiner re-broadcasts before giving up loudly (never plaintext). */
const MAX_JOINER_RETRIES = 3;
/** Bound on the whole locked submit critical section (H1) — no hung wedge. */
const SUBMIT_TIMEOUT_MS = 10_000;
/** Park/gap-refetch attempts before escalating to desync → rejoin (M4). */
const MAX_PARK_ATTEMPTS = 8;
/** Per-envelope transient-error retries before ack+drop-as-poison (item 4). */
const MAX_ENVELOPE_RETRIES = 5;
/** Backoff before re-draining a transiently-failed envelope. */
const RETRY_DELAY_MS = 500;
/** Bound on successive rejoin/successor re-establishes before failing loud. */
const MAX_REESTABLISH = 3;
/**
 * Fail-safe (T0d, R2-6): if the session produces NO verdict within this window
 * (DS unreachable — no create/join response) AND the channel has no known open
 * MLS group, release the `negotiating` publish gate so a plain voice call is
 * never stuck muted. If an open group IS known, the gate stays asserted and the
 * state goes loud RE-SECURING — an E2EE-known call never auto-resumes plaintext.
 */
const NEGOTIATING_FAILSAFE_MS = 5_000;
/** Bounded fail-safe re-arms while the open-group probe is still PENDING
 *  (LOW-2) — beyond this the probe shares the DS's unreachability and the
 *  availability escape applies. */
const MAX_FAILSAFE_REARMS = 2;

// ---- Rotation seam (step 4; plan §1.5 / §4.4) ------------------------------

/**
 * Add-grace: on an Add-driven epoch the sender keeps publishing on the OLD
 * local key for up to this long (plan §1.5, v1: 2 s) so lagging receivers
 * advance to the new epoch before the send-key switch. Remove-driven epochs
 * switch IMMEDIATELY (epoch hygiene beats continuity).
 */
const ADD_GRACE_MS = 2_000;
/**
 * How long a rotation window stays "known" for the §4.4 loud-state debounce,
 * beyond the Add-grace: covers commit propagation (R-1 p95 < 2 s) so a receiver
 * that eats one missing-key frame mid-rotation reads as RE-SECURING, not loud.
 */
const ROTATION_SETTLE_MS = 2_000;
/**
 * A RE-SECURING (missing key inside a known rotation window) escalates to a
 * loud NOT-ENCRYPTED state if it does not resolve within this bound (plan
 * §4.4, v1: 10 s).
 */
const RESECURE_ESCALATE_MS = 10_000;
/** Receiver-lag warn threshold (plan §1.5; pinned to native keys.rs:42). */
const LAG_WARN_THRESHOLD = 8;
/**
 * Receiver-lag desync threshold (plan §1.5; pinned to native keys.rs:44 —
 * strictly < the 16-slot keyring wrap). At/above this the local group state is
 * discarded and we rejoin fresh, never plaintext.
 */
const LAG_DESYNC_THRESHOLD = 12;

// ---- Roster reconciliation (step 5; plan §1.4 / §3.4) ----------------------

/**
 * Leave-grace (plan §1.4): a participant that disconnects is not removed from
 * the MLS group for this long, so a transient reconnect does not churn a
 * remove+rejoin. Must be < `GHOST_DIVERGENCE_MS` (the fast path for a clean
 * disconnect vs the slow backstop for an unexplained ghost leaf).
 */
const LEAVE_GRACE_MS = 10_000;
/**
 * Ghost-leaf divergence timeout (plan §1.4): an MLS leaf with NO SFU
 * participant that we did not see leave is removed after this long by any
 * member (arbitration dedups the herd).
 */
const GHOST_DIVERGENCE_MS = 30_000;
/** Periodic reconciliation tick — a safety net over the event-driven path. */
const RECONCILE_INTERVAL_MS = 5_000;

// ---- Enable + lifecycle (step 6; plan §1.4 / §3.4) -------------------------

/**
 * Re-upgrade hysteresis (plan §3.4): after the last non-enrolled participant
 * leaves, wait this long before resuming encrypted publishing, so a bouncing
 * non-enrolled participant cannot alternate pause/resume storms.
 */
const REUPGRADE_HYSTERESIS_MS = 15_000;
/** Heartbeat interval (plan §1.4): the lowest online leaf self-updates the
 *  group on a stable roster to bound stable-roster exposure. */
const HEARTBEAT_MS = 10 * 60 * 1_000;
/** Product cap (plan A3): the call stays E2EE and the 101st joiner is refused
 *  media-key admission (the "call full for E2EE" refusal; UX polish is 6.5). */
const MAX_E2EE_CALL_MEMBERS = 100;

// ---- Metrics R-1/R-2 (step 8; plan §7.3) — acceptance thresholds -----------

/** R-1 Add-driven receive-gap p95 bound (remotes install before the sender
 *  switches, so this should be small). */
const ADD_RECEIVE_GAP_P95_MS = 250;
/** R-1 Remove-driven receive-gap p95 bound (accepted + documented dropout). */
const REMOVE_RECEIVE_GAP_P95_MS = 1_000;
/** R-1 commit-propagation p95 bound: if a commit routinely takes longer than
 *  the Add-grace, the grace can't hide the gap (§7.3). */
const COMMIT_PROPAGATION_P95_MS = 2_000;
/** R-2 server per-recipient queue budgets (commits_submit.rs) — the server
 *  silently skips over these; we measure our own pressure against them. */
const MAX_QUEUE_DEPTH = 512;
const MAX_QUEUE_BYTES = 32 * 1024 * 1024;

// ============================================================================
// Pure decision helpers — session-independent, exported for audit (the house
// no-vitest split: unit-tested in isolation, no session/Room needed).
// ============================================================================

/** Admit-schedule delay for a member at `leafIndex` (0-based roster order). */
export function leafStaggerDelayMs(leafIndex: number): number {
  return Math.max(0, leafIndex) * ADMIT_STAGGER_MS;
}

/** Where a `POST /mls/groups` response routes the caller. */
export type CreateOrJoinDecision =
  | { action: "created" }
  | { action: "join"; openGroupId: string; dsChannelId: string }
  | { action: "plaintext" }
  | { action: "failed"; reason: string };

/**
 * Route a create response to create-vs-join (§1.2). `ok` + `Created` ⇒ we own
 * epoch 0; `conflict` (409) ⇒ another open group exists — take the join path
 * with the DS-asserted `channel_id` (the honest-DS T-15 leg). `feature_disabled`
 * ⇒ not an E2EE call (quiet plaintext, L4).
 */
export function routeCreateOrJoin(
  res: MlsHttpResult<ResponseCreateMlsGroup>,
): CreateOrJoinDecision {
  if (res.kind === "feature_disabled") return { action: "plaintext" };
  // `mfa_required` (publish route) and `not_found` (join-intent route) can
  // never come from a create (contract guards — keep the union exhaustive).
  if (res.kind === "mfa_required")
    return { action: "failed", reason: "unexpected mfa_required on create" };
  if (res.kind === "not_found")
    return { action: "failed", reason: "unexpected not_found on create" };
  if (res.kind === "call_full")
    return { action: "failed", reason: "unexpected call_full on create" };
  // A conflict body (from either a 409 OR a defensive 200-Conflict) means join.
  if (res.body.result === "Conflict") {
    return {
      action: "join",
      openGroupId: res.body.open_group_id,
      dsChannelId: res.body.channel_id,
    };
  }
  if (res.kind === "conflict") {
    // 409 without a Conflict body is a server-contract violation.
    return { action: "failed", reason: "409 create without an open group" };
  }
  return { action: "created" };
}

/** Outcome of a `POST /mls/groups/<id>/commits` arbitration. */
export type ArbitrationOutcome =
  | { outcome: "won" }
  | { outcome: "lost"; winning: MlsCommitInfo }
  | { outcome: "plaintext" }
  | { outcome: "failed"; reason: string };

/**
 * Classify a commit submission (§2.2.3). `ok` + `Won` ⇒ merge our staged
 * commit; `conflict` (409) + `Lost` ⇒ discard + rebase onto `winning`;
 * `feature_disabled` ⇒ quiet plaintext (L4).
 */
export function classifyArbitration(
  res: MlsHttpResult<ResponseSubmitMlsCommit>,
): ArbitrationOutcome {
  if (res.kind === "feature_disabled") return { outcome: "plaintext" };
  // `mfa_required` (publish route) and `not_found` (join-intent route) can
  // never come from a commit submit (contract guards — keep the union
  // exhaustive).
  if (res.kind === "mfa_required")
    return { outcome: "failed", reason: "unexpected mfa_required on commit" };
  if (res.kind === "not_found")
    return { outcome: "failed", reason: "unexpected not_found on commit" };
  if (res.kind === "call_full")
    return { outcome: "failed", reason: "unexpected call_full on commit" };
  if (res.body.result === "Lost")
    return { outcome: "lost", winning: res.body.winning };
  if (res.kind === "conflict") {
    return { outcome: "failed", reason: "409 commit without a winner" };
  }
  return { outcome: "won" };
}

/**
 * Flatten a `Claimed` KeyPackage-claim result into the `callAdmit` input, or
 * null on `Exhausted` / `NotFound` (admission then fails loudly — the joiner
 * republishes and retries, never a weak admit).
 */
export function claimedFromResult(
  result: MlsClaimResult | undefined,
): MlsClaimedKeyPackage | null {
  if (!result || result.status !== "Claimed") return null;
  return {
    user_id: result.user_id,
    device_id: result.device_id,
    key_package_ref: result.key_package_ref,
    key_package: result.key_package,
    mls_signature_key: result.mls_signature_key,
    binding_signature: result.binding_signature,
    reused: result.reused,
  };
}

// ---- Rotation-seam decision helpers (step 4) --------------------------------

/** The kind of a staged own commit — drives own-won rotation classification. */
export type StagedCommitKind = "admit" | "heartbeat" | "remove";

/**
 * Memory of the most recent OWN-WON epoch (C1). `mls_call_commit_won` returns
 * `removed: []` unconditionally, so an own-won epoch's Remove-vs-Add nature is
 * NOT in the outcome — it is only in what we staged. Recorded on win, read by
 * the rotation classifier.
 */
export interface OwnWonMemo {
  epoch: number;
  kind: StagedCommitKind;
}

/**
 * Memory of the most recent INBOUND epoch advance. `MlsProcessOutcome.removed`
 * IS trustworthy on the inbound path (it is read from the StagedCommit), so a
 * non-empty `removed` marks the epoch Remove-driven.
 */
export interface InboundMemo {
  epoch: number;
  removed: boolean;
}

/**
 * When to install the LOCAL send key for an epoch (§1.5 rotation seam):
 *  - `immediate` — install the local key at once (Remove-driven: lock the
 *    removed member out now; first key of a group; the fail-safe on an
 *    unclassifiable epoch — a spurious immediate switch costs at most one
 *    receiver gap, a wrong grace breaks invariant 7);
 *  - `grace` — install remotes now, defer the local send-key switch behind the
 *    ≤2 s Add-grace so lagging receivers catch up first (Add-driven only).
 */
export type LocalKeyInstall = "immediate" | "grace";

/**
 * Classify how to time an epoch's local send-key install (C1). Own-won epochs
 * classify from the staged-commit KIND memory (NOT the empty `commit_won`
 * outcome); inbound epochs from the recorded `removed` flag; the very first key
 * of a group installs immediately (nothing to keep decrypting, and we must be
 * able to send); anything unclassifiable is the **fail-safe: Remove-immediate**.
 */
export function classifyLocalKeyInstall(
  epoch: number,
  ownWon: OwnWonMemo | null,
  inbound: InboundMemo | null,
  hasInstalledLocal: boolean,
): LocalKeyInstall {
  if (!hasInstalledLocal) return "immediate"; // first key for the group
  if (ownWon && ownWon.epoch === epoch)
    return ownWon.kind === "remove" ? "immediate" : "grace";
  if (inbound && inbound.epoch === epoch)
    return inbound.removed ? "immediate" : "grace";
  return "immediate"; // fail-safe (C1): unknown ⇒ never delay the send-key
}

/** What a receiver-lag reading calls for (plan §1.5 wraparound). */
export type LagAction =
  | { do: "ok" }
  | { do: "warn"; lag: number }
  | { do: "desync"; lag: number };

/**
 * Map the gap between the group's current epoch and ours to a lag action
 * (§1.5): warn at 8, desync at 12 (both pinned to the native keyring bound), so
 * a member never lags 16 epochs and the key-index wrap stays safe. Desync ⇒
 * discard local state + rejoin fresh (never plaintext).
 */
export function lagAction(currentEpoch: number, ourEpoch: number): LagAction {
  const lag = currentEpoch - ourEpoch;
  if (lag >= LAG_DESYNC_THRESHOLD) return { do: "desync", lag };
  if (lag >= LAG_WARN_THRESHOLD) return { do: "warn", lag };
  return { do: "ok" };
}

/**
 * Classify a LiveKit `encryptionError` for the §4.4 loud-state debounce: a
 * missing key INSIDE a known rotation window (an epoch change we are mid-
 * processing, or within the Add-grace) is `resecuring` (transient, bounded);
 * the same error OUTSIDE a known window is immediately `loud`. Clean rotations
 * never flap because a correctly-graced rotation produces no missing-key error.
 */
export function classifyEncryptionError(
  inRotationWindow: boolean,
): "resecuring" | "loud" {
  return inRotationWindow ? "resecuring" : "loud";
}

// ---- Roster reconciliation (step 5; plan §1.4 / §3.4, carried item 5) --------

/**
 * The two-directional SFU∪MLS roster divergence (plan §1.4/§3.4):
 *  - `nonEnrolled` — device-qualified identities in the SFU call but NOT in the
 *    MLS group. The **trusted downgrade-trigger enumeration** (§3.4): a live
 *    participant we cannot encrypt to ⇒ the call is mixed ⇒ loud state + pause
 *    (the client can only ever OVER-warn here, never suppress a real one). Also
 *    the load-bearing hostile-DS T-15 backstop (audit H2): a DS that steers us
 *    into another channel's group yields a roster inconsistent with THIS
 *    channel's SFU set, caught here before enable/publish.
 *  - `ghosts` — MLS leaves with NO SFU participant. Render from the MLS roster
 *    (crypto truth), flag divergence, and after a bounded timeout any member
 *    removes the ghost leaf.
 */
export interface RosterReconcileResult {
  nonEnrolled: string[];
  ghosts: string[];
}

/**
 * Diff the SFU participant set against the MLS roster, both directions (§1.4).
 * `localIdentity` is excluded from BOTH sides: we are always in our own call and
 * driving our own group, so a transient self-asymmetry during join/leave must
 * never read as non-enrolled or a ghost. Pure + exported for audit.
 */
export function reconcileRoster(
  sfuIdentities: readonly string[],
  mlsIdentities: readonly string[],
  localIdentity: string,
): RosterReconcileResult {
  const sfu = new Set(sfuIdentities);
  const mls = new Set(mlsIdentities);
  sfu.delete(localIdentity);
  mls.delete(localIdentity);
  const nonEnrolled = [...sfu].filter((id) => !mls.has(id));
  const ghosts = [...mls].filter((id) => !sfu.has(id));
  return { nonEnrolled, ghosts };
}

// ---- Metrics decision helpers (step 8) --------------------------------------

/** Summary of one metric distribution. */
export interface Percentiles {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

/** Nearest-rank percentile of a sample set (`p` in 0..100). NaN when empty. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** Reduce a sample set to `{count, p50, p95, max}` (0s when empty). */
export function summarize(samples: readonly number[]): Percentiles {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: Math.max(...samples),
  };
}

// ---- Media binding (step 4) -------------------------------------------------

/**
 * The narrow key-install surface the rotation seam drives — structurally
 * satisfied by `MlsKeyProvider` (rtc/mlsCallKeys.ts). Kept as an interface so
 * the session's rotation logic is auditable against a fake, no Room needed.
 */
export interface KeyInstaller {
  /** Install everything incl. the local send key now (immediate / reconnect). */
  applyKeys(frameKeys: MlsFrameKeys, localIdentity: string): Promise<void>;
  /** Install previous+remote keys now; leave the send index untouched. */
  applyRemoteKeys(
    frameKeys: MlsFrameKeys,
    localIdentity: string,
  ): Promise<void>;
  /** Install the local send key — the deferred Add-grace switch. */
  applyLocalKey(frameKeys: MlsFrameKeys, localIdentity: string): Promise<void>;
}

/** The media-plane loud-state the session surfaces for the 6.5 chip. */
export type MediaEncryptionState = "clear" | "resecuring" | "loud";

/**
 * The Room/provider binding the session needs to drive rotations. Injected via
 * `bindMedia` when `state.tsx` constructs the session (step 6); absent until
 * then, so the step-3 control plane still runs Room-free.
 */
export interface MlsMediaBinding {
  /** The frame-key installer (the `MlsKeyProvider`). */
  installer: KeyInstaller;
  /** The LiveKit local participant identity `{userId}:{deviceId}`, or
   *  undefined before the Room mints it (then we cannot match local-last). */
  localIdentity(): string | undefined;
  /**
   * Device-qualified identities of ALL current SFU participants (local +
   * remote), for roster reconciliation (step 5). Read live from the Room.
   */
  sfuParticipants(): string[];
  /** Surface the media-plane state for the 6.5 chip / callEncryptionError. */
  onEncryptionState?(state: MediaEncryptionState, error?: unknown): void;
  /**
   * Surface the latest roster reconciliation (step 5). `state.tsx` renders the
   * mixed-call loud state + drives pause-publish (step 6) from `nonEnrolled`,
   * and the divergent-leaf roster panel (6.5) from `ghosts`.
   */
  onRosterReconciled?(result: RosterReconcileResult): void;
  /**
   * Surface the §3.4 call mode for the UI (6.5): the chip, the downgrade
   * banner, and the roster panel all render from this. `detail` carries the
   * non-enrolled set + (for a remote announce, T4) the announcing user.
   */
  onCallModeChanged?(mode: CallMode, detail: CallModeDetail): void;
  /**
   * Surface the full VERIFIED MLS roster + the divergent ghost leaves (6.5)
   * so the roster panel renders from crypto truth (not just LiveKit tracks).
   */
  onRosterState?(
    members: readonly MlsRosterMember[],
    ghosts: readonly string[],
  ): void;
  /**
   * Auto-leave the SFU call (A3 `call_full`, ME-10 terminal-loud): a refused /
   * failed joiner must not linger as a non-enrolled participant. The session
   * NEVER calls this synchronously from inside its own callback — `state.tsx`
   * defers `disconnect()` via `queueMicrotask` (FE-9b).
   */
  autoLeave?(reason: string): void;
  /**
   * Toggle LiveKit E2EE mode on the Room (`room.setE2EEEnabled`). `true` = the
   * enable driver (step 6). `false` = the §3.4 confirmed-plaintext downgrade
   * (6.5, T3/T5) — reached ONLY after the native confirm dialog returns Ok.
   */
  setEncryptionEnabled?(enabled: boolean): Promise<void>;
  /**
   * Pause / resume local upstream publishing under a NAMED reason (R2-7): the
   * gate owner (state.tsx) is a reason-SET, so `negotiating`/`enable-window`/
   * `mixed` pauses can't collapse or double-count, and a resume only lifts its
   * own reason. Publishing flows only when the set is empty — the
   * plaintext-until-first-key guard + the mix fail-closed pause (§1.5/§3.4).
   */
  pausePublishing?(reason: PublishGateReason): Promise<void>;
  resumePublishing?(reason: PublishGateReason): Promise<void>;
}

/** A publish-gate reason (R2-7) — the session's contribution to state.tsx's set. */
export type PublishGateReason = "negotiating" | "enable-window" | "mixed";

/** One verified MLS roster member for the 6.5 roster panel. */
export interface MlsRosterMember {
  user_id: string;
  device_id: string;
  user_verified: boolean;
}

/** Detail accompanying a call-mode change (6.5 UI). */
export interface CallModeDetail {
  /** Device-qualified non-enrolled SFU identities (drives the banner names). */
  nonEnrolled: readonly string[];
  /** For a remote announce (T4): the user who announced plaintext. */
  announcedBy?: string;
}

// ============================================================================
// Async mutex — the H1 per-group lock (one per session; a session owns one
// group at a time). Non-reentrant with direct ownership hand-off, plus a
// non-blocking `tryAcquire` for the NEW-6 teardown path.
// ============================================================================

class Mutex {
  #locked = false;
  #waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.#locked) {
      this.#locked = true;
      return () => this.#release();
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    // Ownership was handed to us — `#locked` stayed true across the hand-off.
    return () => this.#release();
  }

  /** Grab the lock only if free; else return null (never blocks). */
  tryAcquire(): (() => void) | null {
    if (this.#locked) return null;
    this.#locked = true;
    return () => this.#release();
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      // Hand ownership straight to the next waiter — never drop `#locked`
      // between, or a synchronous `acquire()` could double-hold.
      next();
    } else {
      this.#locked = false;
    }
  }
}

// ============================================================================
// Metrics recorder (step 8, plan §7.3). Off the correctness path — cheap
// pushes/counters only. The blocking numeric acceptance (R-1/R-2) is read from
// `summary()` by the live two-desktop proof (step 9); it is NOT a substitute
// for the T-03-at-the-remover correctness assertion (audit M3): a C1
// mis-classification would SHRINK the measured Remove gap, so R-1 can show
// green while invariant 7 is broken.
// ============================================================================

/** The R-1/R-2 session summary (asserted against the §7.3 thresholds). */
export interface MlsMetricsSummary {
  rotations: number;
  /** R-1 receive-gap `keys-changed → remote keys installed`, by rotation kind. */
  receiveGapAddMs: Percentiles;
  receiveGapRemoveMs: Percentiles;
  /** R-1 own-commit propagation `submit → Won`. */
  commitPropagationMs: Percentiles;
  /** R-2 mailbox pressure vs the server's 512 / 32 MiB per-recipient budgets. */
  mailbox: {
    peakQueueDepth: number;
    peakQueueBytes: number;
    dedupSkips: number;
    parks: number;
    gapRefetches: number;
    retries: number;
    desyncEscalations: number;
  };
  pass: boolean;
  /** Human-readable threshold breaches (empty ⇒ pass). */
  failures: string[];
}

class MlsMetrics {
  // R-1
  #receiveGapAdd: number[] = [];
  #receiveGapRemove: number[] = [];
  #commitPropagation: number[] = [];
  // R-2
  #peakQueueDepth = 0;
  #peakQueueBytes = 0;
  #dedupSkips = 0;
  #parks = 0;
  #gapRefetches = 0;
  #retries = 0;
  #desyncEscalations = 0;

  recordReceiveGap(isRemove: boolean, ms: number): void {
    (isRemove ? this.#receiveGapRemove : this.#receiveGapAdd).push(ms);
  }
  recordCommitPropagation(ms: number): void {
    this.#commitPropagation.push(ms);
  }
  recordEnqueue(depth: number, bytes: number): void {
    if (depth > this.#peakQueueDepth) this.#peakQueueDepth = depth;
    if (bytes > this.#peakQueueBytes) this.#peakQueueBytes = bytes;
  }
  recordDedupSkip(): void {
    this.#dedupSkips++;
  }
  recordPark(): void {
    this.#parks++;
  }
  recordGapRefetch(): void {
    this.#gapRefetches++;
  }
  recordRetry(): void {
    this.#retries++;
  }
  recordDesyncEscalation(): void {
    this.#desyncEscalations++;
  }

  summary(): MlsMetricsSummary {
    const receiveGapAddMs = summarize(this.#receiveGapAdd);
    const receiveGapRemoveMs = summarize(this.#receiveGapRemove);
    const commitPropagationMs = summarize(this.#commitPropagation);
    const failures: string[] = [];
    // Only assert a distribution once it has samples (an empty call passes).
    if (receiveGapAddMs.count && receiveGapAddMs.p95 > ADD_RECEIVE_GAP_P95_MS) {
      failures.push(
        `Add receive-gap p95 ${receiveGapAddMs.p95.toFixed(0)}ms > ${ADD_RECEIVE_GAP_P95_MS}ms`,
      );
    }
    if (
      receiveGapRemoveMs.count &&
      receiveGapRemoveMs.p95 > REMOVE_RECEIVE_GAP_P95_MS
    ) {
      failures.push(
        `Remove receive-gap p95 ${receiveGapRemoveMs.p95.toFixed(0)}ms > ${REMOVE_RECEIVE_GAP_P95_MS}ms`,
      );
    }
    if (
      commitPropagationMs.count &&
      commitPropagationMs.p95 > COMMIT_PROPAGATION_P95_MS
    ) {
      failures.push(
        `commit-propagation p95 ${commitPropagationMs.p95.toFixed(0)}ms > ${COMMIT_PROPAGATION_P95_MS}ms`,
      );
    }
    if (this.#peakQueueDepth > MAX_QUEUE_DEPTH) {
      failures.push(
        `peak queue depth ${this.#peakQueueDepth} > ${MAX_QUEUE_DEPTH}`,
      );
    }
    if (this.#peakQueueBytes > MAX_QUEUE_BYTES) {
      failures.push(
        `peak queue bytes ${this.#peakQueueBytes} > ${MAX_QUEUE_BYTES}`,
      );
    }
    return {
      rotations: receiveGapAddMs.count + receiveGapRemoveMs.count,
      receiveGapAddMs,
      receiveGapRemoveMs,
      commitPropagationMs,
      mailbox: {
        peakQueueDepth: this.#peakQueueDepth,
        peakQueueBytes: this.#peakQueueBytes,
        dedupSkips: this.#dedupSkips,
        parks: this.#parks,
        gapRefetches: this.#gapRefetches,
        retries: this.#retries,
        desyncEscalations: this.#desyncEscalations,
      },
      pass: failures.length === 0,
      failures,
    };
  }
}

/** Base64 ciphertext → decoded byte length (for R-2 queue-byte accounting). */
function envelopeBytes(envelope: MlsEnvelope): number {
  return Math.ceil(((envelope.ciphertext?.length ?? 0) * 3) / 4);
}

// ============================================================================

/** Public session lifecycle state. */
export type MlsSessionState =
  | "starting"
  | "active" // group established, driving the control plane
  | "plaintext" // feature off — not an E2EE call (quiet, L4)
  | "resecuring" // recovering: join timeout / park-exceeded / desync / poisoned
  | "failed" // loud terminal error
  | "closed";

export interface MlsCallSessionDeps {
  bridge: E2EEBridge;
  /** Our user id. */
  userId: string;
  /** Our E2EE device id (the LiveKit identity is `{userId}:{deviceId}`). */
  deviceId: string;
  /** The channel the user actually chose to join (route/UI truth — T-15). */
  channelId: string;
  /** Optional lifecycle-state observer (step 6 wires the call UI to it). */
  onStateChange?: (state: MlsSessionState) => void;
  /**
   * Mint an MFA ticket for the device's FIRST MLS KeyPackage publish (the
   * server MFA-gates it, mirroring the text-E2EE first key publish). Resolves to
   * the ticket token, or undefined if the user declines / no UI is bound. Wired
   * from the RTC layer to the app's `mfaFlow` (a native password prompt — the
   * password never reaches the session). Absent ⇒ enrol stays best-effort and a
   * fresh device simply fails admission loudly until provisioned.
   */
  requestMfaTicket?: () => Promise<string | undefined>;
  /**
   * The channel's open-group probe state (tri-state, media-gate LOW-2). Read
   * by the T0d fail-safe: `"open"` ⇒ hold the gate + loud RE-SECURING (an
   * E2EE-known call never auto-resumes plaintext); `"pending"` ⇒ hold the
   * gate and re-arm the fail-safe (bounded); `"none"` (a COMPLETED 404 /
   * feature-off / probe error — the error arm is RATIFIED, R2-6: the probe
   * and the DS share an origin) ⇒ the availability escape may release.
   */
  channelHasOpenGroup?: () => "open" | "none" | "pending";
}

/** One staged own commit awaiting arbitration (native pending mirror). */
interface StagedCommit {
  epoch: number;
  kind: StagedCommitKind;
}

export class MlsCallSession {
  #deps: MlsCallSessionDeps;

  #state: MlsSessionState = "starting";
  #lastError: unknown;

  /** The current group id, once create/join resolves; null before/after. */
  #groupId: string | null = null;

  /** Sink unregister fn (bridge → this session's inbound events). */
  #unregisterSink: (() => void) | null = null;

  // --- Submit/drain serialization (H1) ---
  #lock = new Mutex();
  /** Inbound MLS envelopes awaiting the drain (queued while the lock is held). */
  #inbound: MlsEnvelope[] = [];
  /** Single-flight guard for the drain pump. */
  #pumping = false;
  /** ULID dedup for the drain-vs-live-push race (invariant: never process 2×). */
  #seen = new Set<string>();
  /** Per-envelope transient-error retry counter (bounded, item 4). */
  #retries = new Map<string, number>();
  /** Consecutive park/gap-refetch attempts (bounded → rejoin, M4). */
  #parkAttempts = 0;
  /**
   * User-ids already device-reconciled via the reactive leaf-verify path for
   * the CURRENT group (progress detection, audit HIGH-2/MED-1): a reconcile is
   * deterministic per listing, so a user appearing here again means no
   * progress → rejoin fresh, never re-fetch. Cleared on group re-establish.
   */
  #identityFetches = new Set<string>();

  /** Our currently-staged own commit, kept in sync under the lock (H1 / C1). */
  #staged: StagedCommit | null = null;
  /**
   * The kind of the most recent OWN-WON epoch (C1). `commit_won` returns
   * `removed: []` unconditionally, so the rotation classifier must read
   * Add-grace vs Remove-immediate from THIS, not the outcome.
   */
  #lastOwnWon: OwnWonMemo | null = null;
  /**
   * The most recent INBOUND epoch advance + whether it was Remove-driven (its
   * outcome carried removed devices — trustworthy on the inbound path). Keyed
   * by epoch so the rotation classifier matches the exact keys-changed epoch.
   */
  #lastInbound: InboundMemo | null = null;

  // --- Timers + scheduled work (all cleared on dispose) ---
  #timers = new Set<ReturnType<typeof setTimeout>>();
  /** Admit timers keyed by `{user}:{device}` so we never double-schedule. */
  // `null` = reserved-before-await (a rejoin serve holds its dedup key
  // across its verify/reconcile round-trips before the timer exists).
  #scheduledAdmits = new Map<string, ReturnType<typeof setTimeout> | null>();
  /** Resolver for the joiner's Welcome wait; set only while waiting. */
  #welcomeResolve: ((joined: boolean) => void) | undefined;
  /** At most one group-level transition (rejoin/successor/removed) in flight. */
  #groupActionPending = false;
  /** Bound on successive re-establishes (rejoin/successor). */
  #reestablishes = 0;

  /** Last server-reported KeyPackage count (drives low-water replenish). */
  #serverKeyPackages = 0;

  // --- Rotation seam (step 4) — null until state.tsx binds the Room/provider --
  #media: MlsMediaBinding | null = null;
  /** Highest epoch we have begun installing keys for (the grace fence value). */
  #installEpoch = -1;
  /** Whether a LOCAL send key is installed for the CURRENT group yet (first-key). */
  #hasLocalKey = false;
  /** Outstanding epoch-fenced Add-grace local-install timer (NEW-1). */
  #graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a rotation is "known" for the §4.4 loud-state debounce. */
  #rotationWindow = false;
  #rotationWindowTimer: ReturnType<typeof setTimeout> | null = null;
  /** RE-SECURING → loud escalation timer (armed on the first in-window error). */
  #resecureTimer: ReturnType<typeof setTimeout> | null = null;
  /** Loud NOT-ENCRYPTED latched (terminal for the media chip until re-establish). */
  #loudLatched = false;

  // --- Roster reconciliation (step 5) ----------------------------------------
  /** Pending 10 s leave-grace removals, keyed by device-qualified identity. */
  #leaveGrace = new Map<string, ReturnType<typeof setTimeout>>();
  /** Pending 30 s ghost-divergence removals, keyed by identity. */
  #ghostTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Last-computed non-enrolled identities (step 6 reads this synchronously). */
  #nonEnrolled: string[] = [];
  /** Periodic reconcile tick (safety net over the event-driven path). */
  #reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  /** Gate on the self-rescheduling reconcile loop (stops the finally re-arm). */
  #reconcileEnabled = false;

  // --- Enable + lifecycle (step 6) -------------------------------------------
  /** Whether LiveKit E2EE mode is currently ON (`setEncryptionEnabled(true)`). */
  #e2eeEnabled = false;
  /** Whether local publishing is paused for a mixed (non-enrolled) call. */
  #mixPaused = false;
  /** Pending re-upgrade hysteresis timer (mix cleared → resume after 15 s). */
  #reupgradeTimer: ReturnType<typeof setTimeout> | null = null;

  // --- §3.4 call mode (slice 6.5) --------------------------------------------
  /** The §3.4 downgrade state machine's current mode — drives the 6.5 UI. */
  #callMode: CallMode = { kind: "negotiating" };
  /** For a remote announce (T4): the user who announced plaintext. */
  #announcedBy: string | undefined;
  /** Whether re-upgrade must go via a fresh successor (T6, after an interlude). */
  #reupgradeViaSuccessor = false;
  /** T0d fail-safe re-arms consumed while the open-group probe was pending. */
  #failsafeRearms = 0;
  /** Serializes §3.4 mode transitions + their awaited media effects (F8). */
  #modeChain: Promise<void> = Promise.resolve();
  /** Self-rescheduling heartbeat tick + its enabled gate. */
  #heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatEnabled = false;

  /** R-1/R-2 metrics recorder (step 8) — off the correctness path. */
  #metrics = new MlsMetrics();

  constructor(deps: MlsCallSessionDeps) {
    this.#deps = deps;
  }

  // ---- Public surface -------------------------------------------------------

  state(): MlsSessionState {
    return this.#state;
  }

  /** The §3.4 call mode (slice 6.5) — the 6.5 UI reads this. */
  callMode(): CallMode {
    return this.#callMode;
  }

  groupId(): string | null {
    return this.#groupId;
  }

  lastError(): unknown {
    return this.#lastError;
  }

  /** The R-1/R-2 metrics summary (§7.3) — the numeric input to the step-9
   *  proof; also logged on dispose. NOT a substitute for the T-03-at-the-remover
   *  correctness assertion (audit M3). */
  metrics(): MlsMetricsSummary {
    return this.#metrics.summary();
  }

  /**
   * Bind the Room/provider for the rotation seam (step 4). Called by `state.tsx`
   * when it constructs the session (step 6); until then the step-3 control
   * plane runs Room-free and `onLocalKeysChanged` is a no-op.
   */
  bindMedia(media: MlsMediaBinding): void {
    this.#media = media;
  }

  /**
   * Begin the control plane: register the inbound sink, enrol KeyPackages, then
   * create-or-join the call's MLS group. Safe to call once.
   */
  async start(): Promise<void> {
    if (this.#state !== "starting") return;
    this.#unregisterSink = this.#deps.bridge.registerMlsSink(this.#onSink);
    this.#armNegotiatingFailsafe();
    try {
      await this.#ensureKeyPackages();
      if (this.#terminal()) return;
      await this.#establish();
    } catch (error) {
      this.#onLoud(error);
    }
  }

  /**
   * T0d fail-safe (R2-6 + media-gate LOW-2, tri-state): if we are STILL
   * negotiating after the window (DS unreachable — no create/join verdict):
   *  - probe says "open"    ⇒ hold the gate + loud RE-SECURING (an E2EE-known
   *    call never auto-resumes plaintext);
   *  - probe says "pending" ⇒ hold the gate and RE-ARM (bounded — a hung
   *    probe eventually errors to "none" via fetch's own failure);
   *  - probe says "none" (a COMPLETED verdict, incl. the RATIFIED error arm)
   *    ⇒ availability escape: release the gate, keep negotiating quietly.
   */
  #armNegotiatingFailsafe(): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (this.#terminal() || this.#callMode.kind !== "negotiating") return;
      const probe = this.#deps.channelHasOpenGroup?.() ?? "none";
      if (probe === "open") {
        this.#toResecuring("negotiation timed out with an open E2EE group");
        return;
      }
      if (probe === "pending" && this.#failsafeRearms < MAX_FAILSAFE_REARMS) {
        this.#failsafeRearms++;
        this.#armNegotiatingFailsafe();
        return;
      }
      // Completed no-group verdict (or the probe never resolved past the
      // bounded re-arms — same-origin, so the DS is unreachable too) →
      // availability escape: release the gate, keep negotiating in the
      // background (a late verdict still applies).
      void this.#media?.resumePublishing?.("negotiating");
    }, NEGOTIATING_FAILSAFE_MS);
    this.#timers.add(timer);
  }

  /**
   * Tear the session down (call end): local leave-cleanup, timers, and sink.
   * There is NO self-Remove — RFC 9420/OpenMLS forbid removing one's own
   * leaf (CannotRemoveSelf); peers' SFU-departure leave-grace removal (or
   * the DS rejoin affordance, for a still-connected device) clears our
   * roster entry.
   */
  dispose(): void {
    if (this.#state === "closed") return;
    // Emit the R-1/R-2 session summary (§7.3) before tearing down.
    const summary = this.#metrics.summary();
    if (summary.rotations || summary.mailbox.gapRefetches) {
      const log = summary.pass ? console.info : console.warn;
      log("[mls] call metrics summary", summary);
    }
    this.#setState("closed"); // set first so every guard short-circuits
    this.#unregisterSink?.();
    this.#unregisterSink = null;

    this.#stopReconcile(); // gate off the self-rescheduling reconcile loop
    this.#stopHeartbeat();
    this.#cancelReupgrade();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const timer of this.#scheduledAdmits.values())
      if (timer) clearTimeout(timer);
    this.#scheduledAdmits.clear();
    this.#welcomeResolve?.(false);
    this.#welcomeResolve = undefined;
    this.#inbound = [];

    const groupId = this.#groupId;
    this.#groupId = null;
    if (groupId) void this.#teardownGroup(groupId);
  }

  async #teardownGroup(groupId: string): Promise<void> {
    // Local wipe ONLY. A self-Remove can never work — RFC 9420 / OpenMLS
    // forbid a committer removing its own leaf (CannotRemoveSelf) — so
    // call-end roster cleanup is the PEERS' job: our SFU departure arms
    // their leave-grace ghost-remove (#removeMember), and a device that
    // wiped state while STILL connected converges via the DS rejoin
    // affordance (flagged intent → members remove the stale leaf).
    await this.#safeLeave(groupId);
  }

  // ---- Enrol ----------------------------------------------------------------

  async #ensureKeyPackages(): Promise<void> {
    // Low-water replenish so admitters can claim our KeyPackage to add us.
    // Idempotent (rides the existing enrollment); a fresh device publishes its
    // first batch. Feature-off is tolerated quietly.
    let payload;
    try {
      payload = await this.#deps.bridge.mlsReplenish(
        this.#deps.userId,
        this.#serverKeyPackages,
      );
    } catch (error) {
      console.error("[mls] native KeyPackage replenish failed", error);
      return;
    }
    if (!payload) return; // above the watermark — nothing to publish

    try {
      // No MFA on any publish against an upgraded server (publish-UX plan
      // §3.1): the device-bound session + server-verified credential binding
      // is the credential, so a first E2EE call join never prompts for the
      // account password (DAVE-parity UX). The `mfa_required` arm below is a
      // LEGACY-SERVER fallback only (plan §3.3, remove after rollout) —
      // prompt for a ticket ONCE and retry. A declined / absent prompt
      // leaves us unpublished: admission then fails LOUDLY (Exhausted),
      // never a weak or plaintext admit.
      let res = await this.#deps.bridge.mlsPutKeyPackages(payload);
      if (res.kind === "mfa_required" && this.#deps.requestMfaTicket) {
        const ticket = await this.#deps.requestMfaTicket();
        if (this.#terminal()) return;
        if (ticket) {
          res = await this.#deps.bridge.mlsPutKeyPackages(payload, ticket);
        }
      }
      if (res.kind === "feature_disabled") {
        this.#toPlaintext();
        return;
      }
      if (res.kind === "ok") {
        this.#serverKeyPackages = res.body.key_package_count;
      } else {
        // mfa_required with no ticket minted (declined / no UI bound): enrol
        // stays best-effort. A joiner whose KeyPackages aren't published fails
        // admission LOUDLY (Exhausted) — the correct fail-closed signal.
        console.warn(
          "[mls] KeyPackage publish not completed (MFA ticket unavailable);",
          "admission will fail loudly until this device is provisioned",
        );
      }
    } catch (error) {
      console.error(
        "[mls] KeyPackage publish failed (enrol best-effort)",
        error,
      );
    }
  }

  // ---- Create-or-join -------------------------------------------------------

  /** Register (or, on a create-race, join) the call's MLS group. */
  async #establish(supersedes?: string): Promise<void> {
    if (this.#terminal()) return;

    // Native mints a local epoch-0 group + fires keys-changed(0). On a create
    // race (or a plaintext/feature-off verdict) we leave-clean this orphan.
    const created = await this.#deps.bridge.callCreate(
      this.#deps.channelId,
      this.#deps.userId,
      supersedes,
    );
    const orphanId = created.payload.group_id;
    // Adopt the freshly-minted group id NOW, before the arbitration round-trip
    // (step 6): callCreate ALREADY fired keys-changed(0), and that event can
    // reach `onLocalKeysChanged` before `mlsCreateGroup` resolves — without
    // #groupId set the rotation seam would drop it and our first local send-key
    // would never install (a solo creator would then never encrypt). On a
    // 409-join we re-point to the winner (resetting the rotation state so the
    // winner's first key is treated as first-key-immediate); plaintext/failed
    // clear it.
    this.#groupId = orphanId;
    const res = await this.#deps.bridge.mlsCreateGroup(created.payload);
    const decision = routeCreateOrJoin(res);

    switch (decision.action) {
      case "created":
        this.#toActive();
        // First-key install (race fix): `callCreate` already fired
        // keys-changed(0), but that event can reach `onLocalKeysChanged` BEFORE
        // `#groupId` was adopted above (during the `callCreate` await) and be
        // dropped by the group-id guard — leaving a solo creator's first local
        // send-key uninstalled (it would then never encrypt, despite E2EE being
        // requested). Now that `#groupId` is set, (re-)install epoch 0
        // explicitly; idempotent with the event when it wasn't dropped (an
        // equal-epoch re-assert is allowed).
        void this.onLocalKeysChanged(orphanId, 0);
        return;
      case "join":
        // L1: leave-cleanup our orphan epoch-0 group BEFORE joining the winner.
        await this.#safeLeave(orphanId);
        this.#groupId = null;
        this.#resetRotationState();
        await this.#joinPath(decision.openGroupId, decision.dsChannelId);
        return;
      case "plaintext":
        this.#groupId = null;
        await this.#safeLeave(orphanId);
        this.#toPlaintext();
        return;
      case "failed":
        this.#groupId = null;
        await this.#safeLeave(orphanId);
        this.#onLoud(new Error(decision.reason));
        return;
    }
  }

  async #joinPath(groupId: string, dsChannelId: string): Promise<void> {
    // Accept this group's inbound envelopes while we wait for the Welcome.
    this.#groupId = groupId;

    // Audit H2/H3: pin the current SFU roster's device identities up-front so
    // the admitter's (and any existing member's) leaf passes
    // verify_leaf_credential on the FIRST Welcome pass — instead of a
    // reject → reconcile → reprocess round-trip and a retry-window key gap.
    await this.#reconcileRoster();

    for (let attempt = 0; attempt <= MAX_JOINER_RETRIES; attempt++) {
      if (this.#terminal()) return;

      // The T-15 guard lives in callJoinIntent: it refuses (throws) unless the
      // DS-asserted channel equals the channel the user chose, and signs the
      // user-intended channel — never a server echo.
      let intent;
      try {
        intent = await this.#deps.bridge.callJoinIntent({
          groupId,
          intendedChannelId: this.#deps.channelId,
          dsResponseChannelId: dsChannelId,
          userId: this.#deps.userId,
        });
      } catch (error) {
        this.#onLoud(error); // T-15 mismatch or native error — loud, never plaintext
        return;
      }

      try {
        const res = await this.#deps.bridge.mlsJoinIntent(groupId, intent);
        if (res.kind === "feature_disabled") {
          this.#toPlaintext();
          return;
        }
        if (res.kind === "not_found") {
          // The DS closed the group (solo-stale rejoin close, plan §3.1, or
          // the call's group ended). Re-establish: routeCreateOrJoin either
          // CREATES fresh — the solo-stale recovery — or conflicts onto the
          // successor. Direct #rejoinFresh (bounded by MAX_REESTABLISH): a
          // re-establish already runs inside the single-flight group action,
          // where a nested #scheduleReestablish would be dropped.
          await this.#rejoinFresh("group closed during join");
          return;
        }
        if (res.kind === "call_full") {
          // A3 (6.5): the roster is at the ceiling and we are a NEW joiner —
          // the call stays E2EE and we are refused. Terminal `call_full`
          // mode + auto-leave the SFU (a lingering refused joiner would be
          // non-enrolled and trip everyone's downgrade banner).
          this.#onCallFull();
          return;
        }
        if (res.kind !== "ok") {
          this.#onLoud(new Error("join intent rejected"));
          return;
        }
      } catch (error) {
        // The broadcast can fail while we are STILL in the server-side roster
        // (join_intent 400s an already-member device — a rejoin racing our own
        // stale leaf's removal, or a re-broadcast landing after an admitter's
        // Add already won) or on a transient network error. Neither is
        // terminal, and the Welcome we need may already be in flight — so fall
        // through to the wait instead of throwing. The bounded attempt loop
        // (→ loud RE-SECURING below) is the backstop; never plaintext.
        console.warn(
          "[mls] join intent broadcast failed — awaiting Welcome",
          error,
        );
      }

      // The admitter's winning Add fans a Welcome to us; the drain processes it
      // and resolves this wait via #onEpochAdvanced(welcome_joined).
      const welcomed = await this.#waitForWelcome(JOINER_RETRY_MS);
      if (welcomed) return;
    }

    // Retries exhausted — loud RE-SECURING, never plaintext (§1.4).
    this.#toResecuring("join timed out after retries");
  }

  #waitForWelcome(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        if (this.#welcomeResolve) {
          this.#welcomeResolve = undefined;
          resolve(false);
        }
      }, timeoutMs);
      this.#timers.add(timer);
      this.#welcomeResolve = (joined) => {
        clearTimeout(timer);
        this.#timers.delete(timer);
        this.#welcomeResolve = undefined;
        resolve(joined);
      };
    });
  }

  /**
   * Proactively verify the current SFU roster's device identities (audit
   * H2/H3): reconcile each distinct participant user-id's signed device listing
   * so their MLS leaves pass `verify_leaf_credential` on the first Welcome /
   * commit pass. Used by the joiner before waiting for the Welcome, and by
   * every member on a join request before admit / before the Add fans out. Our
   * own leaf is self-authority (`verify_own_leaf`), so self is skipped.
   * Fail-closed: a user we can't verify has its leaf refused later.
   */
  async #reconcileRoster(extraUserIds: string[] = []): Promise<void> {
    const ids = new Set(extraUserIds);
    for (const identity of this.#media?.sfuParticipants() ?? []) {
      ids.add(identity.split(":")[0]);
    }
    ids.delete(this.#deps.userId);
    if (!ids.size) return;
    await this.#deps.bridge.reconcileCallRoster([...ids]);
  }

  // ---- Admit scheduler (existing member admitting a joiner) -----------------

  async #onJoinRequest(
    request: MlsJoinRequest,
    rejoin: boolean,
  ): Promise<void> {
    if (this.#state !== "active" || request.group_id !== this.#groupId) return;

    switch (
      joinRequestAction({
        rejoin,
        isSelf: request.user_id === this.#deps.userId,
      })
    ) {
      case "ignore":
        return;
      case "serve_rejoin":
        return this.#serveRejoin(request);
      case "schedule_admit":
        break; // fall through to the admit scheduling below
    }

    const key = `${request.user_id}:${request.device_id}`;
    if (this.#scheduledAdmits.has(key)) return; // already scheduled

    // Audit H3: verify the joiner's signed device listing BEFORE admit and
    // before the Add commit fans out, so this member accepts the joiner's leaf
    // instead of failing loud (admitter) / poisoning (existing member).
    await this.#reconcileRoster([request.user_id]);
    if (this.#state !== "active" || request.group_id !== this.#groupId) return;

    // Stagger by our leaf index (roster order): the low leaf admits first, the
    // higher leaves are liveness failover if it's wedged. Correctness never
    // depends on the heuristic — DS arbitration is total.
    let leaf: number;
    try {
      const state = await this.#deps.bridge.callState(this.#groupId);
      leaf = state.members.findIndex(
        (m) =>
          m.user_id === this.#deps.userId &&
          m.device_id === this.#deps.deviceId,
      );
    } catch {
      return;
    }
    if (leaf < 0) return; // we are not a member of this group

    const timer = setTimeout(() => {
      this.#scheduledAdmits.delete(key);
      this.#timers.delete(timer);
      void this.#tryAdmit(request);
    }, leafStaggerDelayMs(leaf));
    this.#scheduledAdmits.set(key, timer);
    this.#timers.add(timer);
  }

  /**
   * Serve a REJOIN (rejoin-affordance plan §3.4): the requesting device is
   * already a group member but wiped its local state (rejoin-fresh) — it can
   * never remove itself (CannotRemoveSelf), so a verifying member removes
   * the stale leaf; the device's next normal intent then rides the unchanged
   * admit path. No Add is staged here.
   */
  async #serveRejoin(request: MlsJoinRequest): Promise<void> {
    // Distinct key namespace so this timer can never collide with (or block)
    // the SAME device's subsequent normal admit. Reserved BEFORE the awaits.
    const key = `rejoin:${request.user_id}:${request.device_id}`;
    if (this.#scheduledAdmits.has(key)) return;
    this.#scheduledAdmits.set(key, null);

    // Pin-then-verify (audit H3 analog): an unpinned-but-honest rejoiner
    // verifies after a reconcile; a forged relay never does. NEVER stage a
    // Remove on the server relay alone.
    await this.#reconcileRoster([request.user_id]);
    try {
      await this.#deps.bridge.callVerifyJoinIntent(request);
    } catch {
      this.#scheduledAdmits.delete(key);
      return; // unverifiable — refuse to serve (fail closed, quiet)
    }
    if (this.#state !== "active" || request.group_id !== this.#groupId) {
      this.#scheduledAdmits.delete(key);
      return;
    }

    // Stale leaf still present? Another member's Remove may already have
    // won (idempotence — the roster check discriminates perfectly). Also
    // derive our leaf index for the same liveness stagger admits use.
    let leaf: number;
    try {
      const state = await this.#deps.bridge.callState(this.#groupId);
      if (
        !state.members.some(
          (m) =>
            m.user_id === request.user_id && m.device_id === request.device_id,
        )
      ) {
        this.#scheduledAdmits.delete(key);
        return; // already served
      }
      leaf = state.members.findIndex(
        (m) =>
          m.user_id === this.#deps.userId &&
          m.device_id === this.#deps.deviceId,
      );
    } catch {
      this.#scheduledAdmits.delete(key);
      return;
    }
    if (leaf < 0) {
      this.#scheduledAdmits.delete(key);
      return; // we are not a member of this group
    }

    const timer = setTimeout(() => {
      this.#scheduledAdmits.delete(key);
      this.#timers.delete(timer);
      void this.#removeStaleLeaf(request);
    }, leafStaggerDelayMs(leaf));
    this.#scheduledAdmits.set(key, timer);
    this.#timers.add(timer);
  }

  async #removeStaleLeaf(request: MlsJoinRequest): Promise<void> {
    if (
      this.#terminal() ||
      this.#state !== "active" ||
      request.group_id !== this.#groupId
    )
      return;
    // Re-check under FRESH state at fire time: the lowest leaf usually wins
    // during our stagger delay, making this a clean no-op.
    try {
      const state = await this.#deps.bridge.callState(this.#groupId);
      if (
        !state.members.some(
          (m) =>
            m.user_id === request.user_id && m.device_id === request.device_id,
        )
      ) {
        return; // another member's Remove won
      }
    } catch {
      return;
    }
    console.warn(
      `[mls] removing stale leaf for rejoin: ${request.user_id}:${request.device_id}`,
    );
    await this.#stageAndSubmit(
      () =>
        this.#deps.bridge.callRemove(
          this.#groupId!,
          request.user_id,
          request.device_id,
        ),
      "remove",
    );
  }

  async #tryAdmit(request: MlsJoinRequest): Promise<void> {
    if (this.#state !== "active" || request.group_id !== this.#groupId) return;

    // Still outstanding? A racing admitter's Add may have already won. Also the
    // cap gate: the call stays E2EE and the overflow joiner is refused
    // media-key admission (plan A3; the "call full for E2EE" refusal — its UX
    // is 6.5, this is the refusal itself).
    try {
      const state = await this.#deps.bridge.callState(this.#groupId);
      if (
        state.members.some(
          (m) =>
            m.user_id === request.user_id && m.device_id === request.device_id,
        )
      ) {
        return; // already admitted — nothing to do
      }
      if (state.members.length >= MAX_E2EE_CALL_MEMBERS) {
        console.warn(
          `[mls] refusing admission: E2EE call at cap ${MAX_E2EE_CALL_MEMBERS}`,
        );
        return; // call full for E2EE — do not admit
      }
    } catch {
      return;
    }

    const claimRes = await this.#deps.bridge.mlsClaimKeyPackage({
      device_id: this.#deps.deviceId,
      group_id: this.#groupId,
      targets: [{ user_id: request.user_id, device_id: request.device_id }],
    });
    if (claimRes.kind === "feature_disabled") {
      this.#toPlaintext();
      return;
    }
    if (claimRes.kind !== "ok") return;

    const claimed = claimedFromResult(claimRes.body.results[0]);
    if (!claimed) return; // Exhausted / NotFound → the joiner republishes + retries

    // callAdmit re-verifies the binding signature natively and stages the Add
    // (with Welcome). Submit it under the H1 lock.
    await this.#stageAndSubmit(
      () => this.#deps.bridge.callAdmit(request, claimed),
      "admit",
    );
  }

  // ---- Submit + arbitrate (the H1 / NEW-2 critical section) -----------------

  /**
   * Stage a commit (`build` calls the native admit/heartbeat/remove, which
   * stages the pending commit) and submit it — the ENTIRE round-trip under the
   * per-group lock, so no inbound envelope for this group can be processed
   * while our commit is staged (H1). On Lost, rebase INLINE within the same
   * hold (NEW-2 — never re-dispatch through the mutex-guarded queue).
   */
  async #stageAndSubmit(
    build: () => Promise<MlsSubmitCommit>,
    kind: StagedCommit["kind"],
  ): Promise<void> {
    if (!this.#groupId || this.#terminal()) return;
    const groupId = this.#groupId;

    const release = await this.#lock.acquire();
    try {
      let commit: MlsSubmitCommit;
      try {
        commit = await build();
      } catch (error) {
        // A Remove whose target already vanished (another member's Remove won
        // between our fresh-state re-check and the stage — the stagger design
        // makes this race LIKELY for rejoin serves, AUD-MED-1) reports as
        // native `mls_group_not_found`: a benign no-op, never a session
        // failure. Same for the group itself being gone (we left). Covers
        // #serveRejoin AND the pre-existing #removeMember ghost path.
        if (
          kind === "remove" &&
          (error as { type?: string } | null)?.type === "mls_group_not_found"
        ) {
          return;
        }
        this.#onLoud(error);
        return;
      }
      this.#staged = { epoch: commit.epoch, kind };

      let res: MlsHttpResult<ResponseSubmitMlsCommit>;
      const submitStart = performance.now();
      try {
        res = await this.#withTimeout(
          this.#deps.bridge.mlsSubmitCommit(groupId, commit),
          SUBMIT_TIMEOUT_MS,
        );
      } catch {
        // Timeout / network — clear pending, re-secure, never wedge the drain.
        await this.#safeCommitLost();
        this.#toResecuring("commit submit timed out");
        this.#scheduleReestablish("submit timeout");
        return;
      }

      const outcome = classifyArbitration(res);
      switch (outcome.outcome) {
        case "won":
          await this.#deps.bridge.callCommitWon(groupId, commit.epoch);
          this.#staged = null;
          // R-1 own-commit propagation (§7.3): submit → Won round-trip.
          this.#metrics.recordCommitPropagation(
            performance.now() - submitStart,
          );
          // C1: record the own-won KIND so step 4 classifies rotation timing
          // (commit_won returns removed:[] — the outcome would look Add-driven).
          this.#lastOwnWon = { epoch: commit.epoch, kind };
          break;
        case "lost":
          await this.#safeCommitLost();
          await this.#rebaseInline(outcome.winning); // INLINE — we hold the lock
          break;
        case "plaintext":
          await this.#safeCommitLost();
          this.#toPlaintext();
          break;
        case "failed":
          await this.#safeCommitLost();
          this.#onLoud(new Error(outcome.reason));
          break;
      }
    } catch (error) {
      this.#onLoud(error);
    } finally {
      release();
    }
  }

  /**
   * Rebase onto the winning commit after a Lost (still holding the lock).
   * Synthesize an envelope from the `MlsCommitInfo` (L2 — native dedups by
   * epoch, not id) and process it INLINE, then gap-refetch forward in case the
   * group already advanced past it (heartbeats, others building on the epoch).
   */
  async #rebaseInline(winning: MlsCommitInfo): Promise<void> {
    await this.#consume(this.#synthEnvelope(winning));
    await this.#gapRefetchInline(winning.epoch + 1);
  }

  async #safeCommitLost(): Promise<void> {
    if (this.#groupId) {
      try {
        await this.#deps.bridge.callCommitLost(this.#groupId);
      } catch {
        /* already cleared */
      }
    }
    this.#staged = null;
  }

  // ---- Mailbox drain --------------------------------------------------------

  /** Queue an inbound envelope and kick the (single-flight) drain pump. */
  #enqueue(envelope: MlsEnvelope): void {
    this.#inbound.push(envelope);
    // R-2 mailbox pressure (§7.3): our receive-queue depth + bytes vs the
    // server's per-recipient 512 / 32 MiB budgets (it silently skips over them,
    // recovered by gap-refetch — so we measure pressure, not "zero drops").
    this.#metrics.recordEnqueue(
      this.#inbound.length,
      this.#inbound.reduce((sum, e) => sum + envelopeBytes(e), 0),
    );
    void this.#pump();
  }

  /**
   * Drain queued envelopes under the per-group lock (shared with submit, H1).
   * Holds the lock for the whole current batch; a waiting submit gets its turn
   * at the batch boundary. Group-level transitions (rejoin / successor /
   * removed-self) are scheduled DETACHED (outside the lock) to avoid the
   * NEW-2 deadlock.
   */
  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#inbound.length && !this.#terminal()) {
        const release = await this.#lock.acquire();
        try {
          while (this.#inbound.length && !this.#terminal()) {
            await this.#consume(this.#inbound.shift()!);
          }
        } finally {
          release();
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  /**
   * Process one envelope. Called ONLY while holding the lock (the pump, or an
   * inline rebase/gap-refetch that already holds it) — it never touches the
   * lock itself, which is what keeps the inline rebase deadlock-free (NEW-2).
   */
  async #consume(envelope: MlsEnvelope): Promise<void> {
    if (this.#seen.has(envelope.id)) {
      this.#metrics.recordDedupSkip(); // ULID dedup (drain-vs-live-push race)
      return;
    }

    // H1: if this commit lands on the epoch our OWN commit is staged for, clear
    // the pending commit BEFORE processing — else native's process_message
    // errors and POISONS the group on a benign lost race. Fast-path on #staged
    // (kept in sync under this same lock); a reconnect dangling-pending is
    // handled by reconcilePendingCommit on reconnect (step 6).
    if (
      this.#staged &&
      envelope.epoch === this.#staged.epoch &&
      envelope.content_type === "mls_commit"
    ) {
      await this.#safeCommitLost();
    }

    const disp = await this.#deps.bridge.processEnvelope(
      envelope,
      this.#deps.userId,
    );
    const action = drainAction(
      disp,
      this.#retries.get(envelope.id) ?? 0,
      this.#parkAttempts,
      {
        maxRetries: MAX_ENVELOPE_RETRIES,
        maxParkAttempts: MAX_PARK_ATTEMPTS,
      },
      disp.kind === "needs_identity" && this.#identityFetches.has(disp.userId),
    );

    switch (action.do) {
      case "ack": {
        this.#seen.add(envelope.id);
        this.#retries.delete(envelope.id);
        this.#parkAttempts = 0; // progress resets the park bound
        this.#deps.bridge.ackEnvelopes([envelope.id]);
        if (disp.kind === "processed" && disp.outcome.kind !== "duplicate") {
          // A ctl-announce (6.5) carries no epoch — route it to the §3.4 mode
          // machine, NOT the rotation classifier (it never advances an epoch).
          if (disp.outcome.kind === "ctl_received" && disp.outcome.ctl) {
            this.#onCtlReceived(disp.outcome.ctl);
          } else {
            this.#onEpochAdvanced(disp.outcome);
          }
        }
        return;
      }
      case "ack_removed_self": {
        // L5: emit_keys_changed still fires on the commit that removed us — ack
        // it, tear the group down, and suppress its keys-changed handling.
        this.#seen.add(envelope.id);
        this.#deps.bridge.ackEnvelopes([envelope.id]);
        this.#scheduleGroupAction(() => this.#onRemovedSelf());
        return;
      }
      case "gap_refetch": {
        // Do NOT ack (invariant 10). Fetch the missing epochs and feed them
        // through #consume INLINE — never re-enqueue (that awaits the queue
        // that awaits this lock → deadlock, NEW-2).
        this.#parkAttempts++;
        this.#metrics.recordPark();
        this.#metrics.recordGapRefetch();
        await this.#gapRefetchInline(action.fromEpoch);
        return;
      }
      case "escalate_desync":
        // Park bound exceeded — discard local state + rejoin fresh, never
        // plaintext. Detached (outside the lock) to avoid the NEW-2 deadlock.
        this.#metrics.recordPark();
        this.#metrics.recordDesyncEscalation();
        this.#scheduleGroupAction(() =>
          this.#rejoinFresh("epoch gap did not resolve"),
        );
        return;
      case "successor": {
        this.#seen.add(envelope.id);
        this.#deps.bridge.ackEnvelopes([envelope.id]);
        this.#scheduleGroupAction(() => this.#poisonedSuccessor());
        return;
      }
      case "fetch_identity": {
        // Leaf-verify fix (audit MED-3): do NOT ack, keep OFF #seen so the
        // SAME envelope reprocesses. The reconcile is a network round-trip, so
        // run it DETACHED (we hold the per-group lock here — LOW-1), then
        // re-feed the envelope at the queue HEAD (preserves mailbox order) and
        // re-pump. NOT via #scheduleGroupAction — that is single-flight and a
        // pending transition would silently drop our re-feed.
        this.#metrics.recordRetry();
        const timer = setTimeout(async () => {
          this.#timers.delete(timer);
          if (this.#terminal()) return;
          try {
            await this.#deps.bridge.reconcileCallRoster([action.userId]);
            // Progress budget: only a COMPLETED reconcile counts — the escalation
            // to rejoin-fresh must mean "reconciled, leaf STILL unverifiable",
            // never "the reconcile never ran". A transient failure instead
            // consumes bounded envelope retries below, so an unreachable
            // listing can't spin the fetch loop forever either.
            this.#identityFetches.add(action.userId);
          } catch {
            this.#retries.set(
              envelope.id,
              (this.#retries.get(envelope.id) ?? 0) + 1,
            );
          }
          if (this.#terminal()) return;
          this.#inbound.unshift(envelope);
          void this.#pump();
        }, 0);
        this.#timers.add(timer);
        return;
      }
      case "rejoin_fresh":
        // No progress after a reconcile (audit MED-1): a bare ack-drop would
        // wedge the joiner (the admitter's roster already has us — it never
        // re-sends a Welcome). Discard local state + rejoin fresh, DETACHED
        // (we hold the lock). The un-acked envelope stays server-side; after
        // the rejoin its group is gone locally → reprocesses to a quiet
        // group-not-found ack+drop. Never plaintext.
        this.#scheduleGroupAction(() => this.#rejoinFresh(action.reason));
        return;
      case "retry": {
        // Transient — do NOT ack; bump the counter and re-drain after a
        // backoff (bounded → ack+drop-as-poison at the cap). Kept OFF #seen so
        // it can reprocess.
        this.#metrics.recordRetry();
        this.#retries.set(
          envelope.id,
          (this.#retries.get(envelope.id) ?? 0) + 1,
        );
        this.#scheduleRetry(envelope);
        return;
      }
      case "ack_drop_poison": {
        // carried item 4: an unrecognised terminal error can't spin forever.
        this.#seen.add(envelope.id);
        this.#retries.delete(envelope.id);
        this.#deps.bridge.ackEnvelopes([envelope.id]);
        if (disp.kind === "error") this.#onLoud(disp.error);
        return;
      }
    }
  }

  async #gapRefetchInline(fromEpoch: number): Promise<void> {
    if (!this.#groupId || this.#terminal()) return;
    const res = await this.#deps.bridge.mlsFetchCommits(
      this.#groupId,
      fromEpoch,
    );
    if (res.kind === "feature_disabled") {
      this.#toPlaintext();
      return;
    }
    if (res.kind !== "ok") return; // never a conflict on this route

    // Lag / wraparound guard (§1.5): if the group has advanced far past the
    // epoch we are missing from, don't grind a huge backlog through the drain —
    // the keyring wraps at 16, so at the desync threshold discard local state
    // and rejoin fresh (detached — we hold the lock; never plaintext).
    const lag = lagAction(res.body.current_epoch, fromEpoch);
    if (lag.do === "desync") {
      this.#scheduleGroupAction(() =>
        this.#rejoinFresh(`receiver lag ${lag.lag} ≥ desync threshold`),
      );
      return;
    }
    if (lag.do === "warn")
      console.warn(`[mls] receiver lag ${lag.lag} approaching desync`);

    for (const info of res.body.commits) {
      if (this.#terminal()) return;
      await this.#consume(this.#synthEnvelope(info)); // INLINE (we hold the lock)
    }
  }

  #synthEnvelope(info: MlsCommitInfo): MlsEnvelope {
    // A commit synthesized from MlsCommitInfo (409-Lost body / gap-refetch).
    // Native dedups by (group, epoch), so the synthetic id is only our own
    // in-session dedup key (L2).
    return {
      id: `mls-synth:${info.group_id}:${info.epoch}`,
      content_type: "mls_commit",
      group_id: info.group_id,
      epoch: info.epoch,
      ciphertext: info.commit,
    };
  }

  #scheduleRetry(envelope: MlsEnvelope): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (this.#terminal()) return;
      this.#inbound.push(envelope);
      void this.#pump();
    }, RETRY_DELAY_MS);
    this.#timers.add(timer);
  }

  // ---- Group-level transitions (run DETACHED, outside the lock) -------------

  /**
   * Schedule a group-level transition to run OUTSIDE the lock + drain pump, so
   * its own inbound processing (e.g. a rejoin awaiting a Welcome) can pump
   * freely — running it inline would deadlock (NEW-2). At most one at a time.
   */
  #scheduleGroupAction(fn: () => Promise<void>): void {
    if (this.#groupActionPending) return;
    this.#groupActionPending = true;
    const timer = setTimeout(async () => {
      this.#timers.delete(timer);
      if (this.#terminal()) {
        this.#groupActionPending = false;
        return;
      }
      try {
        // Hold the flag through the WHOLE transition (a rejoin can await a
        // Welcome for ~40 s): a second escalate mid-rejoin must be dropped, not
        // start an overlapping re-establish.
        await fn();
      } catch (error) {
        this.#onLoud(error);
      } finally {
        this.#groupActionPending = false;
      }
    }, 0);
    this.#timers.add(timer);
  }

  #scheduleReestablish(reason: string): void {
    this.#scheduleGroupAction(() => this.#rejoinFresh(reason));
  }

  async #onRemovedSelf(): Promise<void> {
    // The group removed us (L5). Leave-clean first, then decide.
    const groupId = this.#groupId;
    this.#groupId = null;
    this.#resetGroupBuffers();
    if (groupId) await this.#safeLeave(groupId);

    // AUD-HIGH-1: if this device is STILL an SFU participant, the removal
    // was not our departure — a replayed rejoin intent or a false-positive
    // ghost remove kicked a live member. Rejoin fresh (we are no longer in
    // the roster, so the fresh intent rides the plain admit path), bounded
    // by MAX_REESTABLISH and reset on every successful join — the kick
    // self-heals instead of wedging in RE-SECURING. Called DIRECTLY (we
    // already run inside the single-flight group action; a nested
    // #scheduleReestablish would be dropped). Not in the SFU = genuine call
    // end / our own leave → stay re-securing as before.
    const media = this.#media;
    const self = media?.localIdentity();
    if (media && self && media.sfuParticipants().includes(self)) {
      await this.#rejoinFresh("removed while still in the call — rejoining");
      return;
    }
    this.#toResecuring("removed from the call group");
  }

  async #rejoinFresh(reason: string): Promise<void> {
    const old = this.#groupId;
    this.#groupId = null;
    this.#resetGroupBuffers();
    if (old) {
      // Local wipe only — we can never remove our own stale leaf
      // (CannotRemoveSelf). Convergence is the DS rejoin affordance's job:
      // if our leaf is still in the roster, the fresh intent below is
      // accepted flagged `rejoin` and a verifying member removes it; the
      // NEXT intent retry then rides the plain admit path. Bounded-loud
      // (RE-SECURING → re-establish cap) if no member serves it.
      await this.#safeLeave(old);
    }
    this.#toResecuring(reason);

    if (this.#reestablishes >= MAX_REESTABLISH) {
      this.#onLoud(new Error(`re-establish limit reached: ${reason}`));
      return;
    }
    this.#reestablishes++;
    await this.#establish();
  }

  async #poisonedSuccessor(): Promise<void> {
    // Channel-scoped atomic close+create: POST /mls/groups {supersedes: old}.
    const old = this.#groupId;
    this.#groupId = null;
    this.#resetGroupBuffers();
    this.#toResecuring("poisoned epoch — migrating to a successor group");

    if (this.#reestablishes >= MAX_REESTABLISH) {
      this.#onLoud(new Error("successor limit reached"));
      return;
    }
    this.#reestablishes++;
    await this.#establish(old ?? undefined);
  }

  #resetGroupBuffers(): void {
    this.#staged = null;
    this.#parkAttempts = 0;
    this.#seen.clear();
    this.#retries.clear();
    this.#identityFetches.clear(); // fresh group ⇒ fresh reconcile budget
    this.#inbound = [];
    for (const timer of this.#scheduledAdmits.values())
      if (timer) clearTimeout(timer);
    this.#scheduledAdmits.clear();
    // A group re-establish is a fresh crypto context (new epoch-0 keys): drop
    // the rotation memos/timers so the next group's first key installs
    // immediately and no stale Add-grace can fire against it.
    this.#resetRotationState();
  }

  // ---- Inbound sink + epoch bookkeeping -------------------------------------

  #onSink = (event: MlsSinkEvent): void => {
    if (this.#terminal()) return;
    if (event.kind === "join_request") {
      void this.#onJoinRequest(event.request, event.rejoin);
      return;
    }
    // envelope — only our own device's copy (another device acks its own)
    if (event.recipientDeviceId !== this.#deps.deviceId) {
      return;
    }
    this.#enqueue(event.envelope);
  };

  #onEpochAdvanced(outcome: MlsProcessOutcome): void {
    if (outcome.kind === "welcome_joined") {
      this.#groupId = outcome.group_id;
      this.#reestablishes = 0;
      this.#toActive();
      this.#welcomeResolve?.(true);
    }
    // Record the inbound rotation kind for the rotation classifier, keyed by
    // epoch (Remove-driven iff the outcome carried removed devices —
    // trustworthy on the inbound path). Set synchronously here, BEFORE the
    // async `e2ee:call-keys-changed` for this epoch reaches onLocalKeysChanged,
    // so the classifier always sees it (closes the event-vs-outcome order
    // hazard, audit M1).
    this.#lastInbound = {
      epoch: outcome.epoch,
      removed: (outcome.removed?.length ?? 0) > 0,
    };

    // ME-4: `max_past_epochs` is 0, so a prior announce becomes undecryptable
    // to late processors after ANY epoch change. While a plaintext interlude
    // is locally confirmed, re-announce on each epoch advance so a member who
    // missed the first announce still gets the attribution (bounded by the
    // server ctl rate limit; native-gated by the downgrade-confirmed flag).
    if (
      this.#callMode.kind === "interlude" &&
      this.#callMode.localConfirmed &&
      outcome.kind !== "welcome_joined"
    ) {
      void this.#announceDowngrade();
    }
  }

  // ---- Rotation seam (step 4) — the SOLE applyKeys driver (NEW-3) -----------

  /**
   * Drive the local send-key install for one epoch advance — the SOLE
   * `applyKeys` driver (NEW-3). `state.tsx`'s `e2ee:call-keys-changed` loop
   * routes every LOCAL epoch advance here (replacing the 6.3 auto-loop's direct
   * `provider.applyKeys`, wired in step 6); it correlates the epoch with the
   * recorded staged-commit kind / inbound-removed memo and times the local-last
   * send-key install (§1.5):
   *   - Remove-immediate / first-key / fail-safe ⇒ install everything now;
   *   - Add-driven ⇒ install remotes now, defer the local send-key behind an
   *     epoch-fenced ≤2 s grace so lagging receivers advance first.
   * Any newer epoch (or a Remove-immediate) CANCELS an outstanding Add-grace so
   * a stale timer can never regress the send index onto a removed-member-
   * readable epoch (C1 / NEW-1). No-op until `bindMedia` (step 6).
   */
  async onLocalKeysChanged(groupId: string, epoch: number): Promise<void> {
    const media = this.#media;
    if (!media) return;
    // L5: suppress keys-changed for a group we've left (removed_self cleared
    // #groupId); and ignore an unrelated group.
    if (this.#terminal() || groupId !== this.#groupId) return;
    // Native epochs are monotonic per group; ignore a stale/reordered lower one
    // (an equal epoch is an idempotent reconnect re-assert, allowed).
    if (epoch < this.#installEpoch) return;

    const identity = media.localIdentity();
    if (!identity) return; // token identity not yet minted — cannot match local-last

    // NEW-1: a newer epoch supersedes any pending Add-grace local install.
    this.#cancelGrace();

    // Classify + open the §4.4 rotation window BEFORE fetching keys: we are
    // mid-rotation the moment keys-changed fires, so a transient error on the
    // fetch/install below classifies as recoverable RE-SECURING (not loud). The
    // classification needs only the epoch + memos, not the frame keys.
    const timing = classifyLocalKeyInstall(
      epoch,
      this.#lastOwnWon,
      this.#lastInbound,
      this.#hasLocalKey,
    );
    this.#installEpoch = epoch;
    this.#openRotationWindow(timing);

    let frameKeys: MlsFrameKeys;
    try {
      frameKeys = await this.#deps.bridge.callFrameKeys(groupId);
    } catch (error) {
      // Fail-closed (§4.2): a native frame-key error surfaces loud/re-securing,
      // never a silent unencrypted send.
      this.#onMediaError(error);
      return;
    }
    // Re-check across the await: a group transition / dispose may have raced.
    if (this.#terminal() || groupId !== this.#groupId) return;

    // R-1 receive-gap (§7.3): time to install the REMOTE keys is when THIS
    // client becomes able to decrypt peers' new-epoch frames — the observable
    // receive-gap. Classify by whether the epoch is Remove-driven (the same
    // signal the rotation classifier uses).
    const isRemove =
      (this.#lastOwnWon?.epoch === epoch &&
        this.#lastOwnWon.kind === "remove") ||
      (this.#lastInbound?.epoch === epoch && this.#lastInbound.removed);
    const installStart = performance.now();

    try {
      if (timing === "immediate") {
        await media.installer.applyKeys(frameKeys, identity);
        this.#metrics.recordReceiveGap(
          isRemove,
          performance.now() - installStart,
        );
        this.#onLocalKeyInstalled();
      } else {
        // Add-grace: remotes now; the local send-key switch is deferred and
        // epoch-fenced (NEW-1). We keep publishing on the OLD local key
        // meanwhile (already installed from the previous epoch).
        await media.installer.applyRemoteKeys(frameKeys, identity);
        this.#metrics.recordReceiveGap(
          isRemove,
          performance.now() - installStart,
        );
        this.#scheduleGraceLocal(frameKeys, identity, epoch);
      }
    } catch (error) {
      this.#onMediaError(error);
    }
  }

  /**
   * Mark the local send-key installed and, until E2EE is enabled, kick a fresh
   * reconcile so the enable gate (step 6) fires promptly once the first key is
   * ready (the periodic tick would otherwise take up to a full interval).
   */
  #onLocalKeyInstalled(): void {
    this.#hasLocalKey = true;
    if (!this.#e2eeEnabled) void this.reconcileNow();
  }

  /** Schedule the deferred, epoch-fenced local send-key install (Add-grace). */
  #scheduleGraceLocal(
    frameKeys: MlsFrameKeys,
    identity: string,
    epoch: number,
  ): void {
    const timer = setTimeout(async () => {
      this.#timers.delete(timer);
      if (this.#graceTimer === timer) this.#graceTimer = null;
      // Epoch fence (NEW-1): fire ONLY if still at this epoch. A newer epoch or
      // a Remove-immediate has already cancelled us, but double-guard so a stale
      // timer can never regress the send index back onto an old epoch a removed
      // member can still read.
      if (this.#terminal() || this.#installEpoch !== epoch) return;
      try {
        await this.#media?.installer.applyLocalKey(frameKeys, identity);
        this.#onLocalKeyInstalled();
      } catch (error) {
        this.#onMediaError(error);
      }
    }, ADD_GRACE_MS);
    this.#graceTimer = timer;
    this.#timers.add(timer);
  }

  /** Cancel any outstanding Add-grace local-install timer (NEW-1). */
  #cancelGrace(): void {
    if (this.#graceTimer) {
      clearTimeout(this.#graceTimer);
      this.#timers.delete(this.#graceTimer);
      this.#graceTimer = null;
    }
  }

  // ---- Loud-state debounce (§4.4) -------------------------------------------

  /**
   * Classify a LiveKit `encryptionError` (§4.4): inside a known rotation window
   * ⇒ RE-SECURING with a bounded escalation to loud; outside ⇒ immediately
   * loud. Latches the first loud error. `state.tsx` routes the Room's
   * `encryptionError` here (step 6). Clean rotations never flap because a
   * correctly-graced rotation raises no missing-key error.
   */
  noteEncryptionError(error: unknown): void {
    this.#surfaceError(error);
  }

  /**
   * Route a media-plane error through the §4.4 debounce: inside a known
   * rotation window ⇒ RE-SECURING with a bounded escalation to loud; outside ⇒
   * immediately loud. Shared by the LiveKit `encryptionError` path and the
   * native frame-key error path so a transient blip inside a rotation self-heals
   * (via `noteEncryptionRecovered`) instead of sticking the chip loud.
   */
  #surfaceError(error: unknown): void {
    const media = this.#media;
    if (!media || this.#terminal() || this.#loudLatched) return;

    if (classifyEncryptionError(this.#rotationWindow) === "resecuring") {
      media.onEncryptionState?.("resecuring", error);
      // Escalate to loud if the window does not resolve within the bound. Armed
      // once; refreshed only by a genuine recovery (noteEncryptionRecovered).
      if (!this.#resecureTimer) {
        const timer = setTimeout(() => {
          this.#resecureTimer = null;
          this.#timers.delete(timer);
          if (this.#terminal()) return;
          this.#latchLoud(error);
        }, RESECURE_ESCALATE_MS);
        this.#resecureTimer = timer;
        this.#timers.add(timer);
      }
    } else {
      this.#latchLoud(error);
    }
  }

  /**
   * The media plane was observed encrypted again (LiveKit
   * `participantEncryptionStatusChanged` → encrypted). Clears a transient
   * RE-SECURING before it escalates. `state.tsx` calls this (step 6); a loud
   * latch stays until the session re-establishes the group.
   */
  noteEncryptionRecovered(): void {
    if (this.#loudLatched) return; // loud is terminal until re-establish
    this.#clearResecureTimer();
    this.#media?.onEncryptionState?.("clear");
  }

  /** Open (or refresh) the §4.4 rotation window used to classify errors. */
  #openRotationWindow(timing: LocalKeyInstall): void {
    this.#rotationWindow = true;
    if (this.#rotationWindowTimer) {
      clearTimeout(this.#rotationWindowTimer);
      this.#timers.delete(this.#rotationWindowTimer);
    }
    // Grace rotations stay "known" through the grace + a propagation settle;
    // immediate ones just through the settle (receivers still need the commit
    // to propagate before they can decrypt the new index).
    const ms = (timing === "grace" ? ADD_GRACE_MS : 0) + ROTATION_SETTLE_MS;
    const timer = setTimeout(() => {
      this.#rotationWindowTimer = null;
      this.#timers.delete(timer);
      this.#rotationWindow = false;
    }, ms);
    this.#rotationWindowTimer = timer;
    this.#timers.add(timer);
  }

  #latchLoud(error: unknown): void {
    if (this.#loudLatched) return;
    this.#loudLatched = true;
    this.#clearResecureTimer();
    this.#media?.onEncryptionState?.("loud", error);
  }

  #clearResecureTimer(): void {
    if (this.#resecureTimer) {
      clearTimeout(this.#resecureTimer);
      this.#timers.delete(this.#resecureTimer);
      this.#resecureTimer = null;
    }
  }

  /**
   * Fail-closed handling of a native frame-key / install error on the rotation
   * path (§4.2): record + surface it (RE-SECURING inside the rotation window it
   * is raised in, else loud) — never a silent unencrypted send.
   */
  #onMediaError(error: unknown): void {
    console.error("[mls] rotation key path failed", error);
    this.#lastError = error;
    this.#surfaceError(error);
  }

  /** Reset all rotation/media bookkeeping on a group re-establish or teardown. */
  #resetRotationState(): void {
    this.#cancelGrace();
    if (this.#rotationWindowTimer) {
      clearTimeout(this.#rotationWindowTimer);
      this.#timers.delete(this.#rotationWindowTimer);
      this.#rotationWindowTimer = null;
    }
    this.#clearResecureTimer();
    this.#rotationWindow = false;
    this.#loudLatched = false;
    this.#installEpoch = -1;
    this.#hasLocalKey = false;
    this.#lastOwnWon = null;
    this.#lastInbound = null;
    this.#stopReconcile();
    this.#stopHeartbeat();
    this.#resetEnableState();
  }

  // ---- Roster reconciliation (step 5) — SFU∪MLS union both directions -------

  /**
   * A participant joined the SFU call. Cancels any pending leave-grace / ghost
   * removal for it (a reconnect within the grace must not churn a remove) and
   * kicks a fresh reconcile. Wired to the Room's `participantConnected` in
   * step 6; no-op before `bindMedia`.
   */
  onParticipantJoined(identity: string): void {
    if (this.#terminal()) return;
    this.#clearLeaveGrace(identity);
    this.#clearGhostTimer(identity);
    void this.reconcileNow();
  }

  /**
   * A participant left the SFU call. Arm a 10 s leave-grace before removing it
   * from the MLS group (a transient blip must not churn remove+rejoin). Wired
   * to the Room's `participantDisconnected` in step 6.
   */
  onParticipantLeft(identity: string): void {
    if (this.#terminal() || this.#state !== "active") return;
    if (identity === this.#media?.localIdentity()) return; // never remove self
    if (this.#leaveGrace.has(identity)) return; // already pending
    const timer = setTimeout(() => {
      this.#leaveGrace.delete(identity);
      this.#timers.delete(timer);
      void this.#removeMember(identity, "leave-grace expired");
    }, LEAVE_GRACE_MS);
    this.#leaveGrace.set(identity, timer);
    this.#timers.add(timer);
  }

  /**
   * Reconcile the SFU participant set against the MLS roster, both directions
   * (§1.4). Records the non-enrolled set (step 6's pause-publish + loud state
   * reads it), arms/disarms ghost-divergence timers, and surfaces the result.
   * Returns the diff, or null if not reconcilable yet (no group / no binding).
   * Also the fresh input to the enable-gate precondition (`rosterConsistent`).
   */
  async reconcileNow(): Promise<RosterReconcileResult | null> {
    const media = this.#media;
    if (!media || this.#state !== "active" || !this.#groupId) return null;

    let mlsIdentities: string[];
    let members: MlsRosterMember[];
    try {
      const state = await this.#deps.bridge.callState(this.#groupId);
      members = state.members;
      mlsIdentities = state.members.map((m) => `${m.user_id}:${m.device_id}`);
    } catch {
      return null; // transient — the next tick retries
    }
    if (this.#state !== "active" || !this.#groupId) return null;

    const localIdentity = media.localIdentity() ?? "";
    const result = reconcileRoster(
      media.sfuParticipants(),
      mlsIdentities,
      localIdentity,
    );
    this.#nonEnrolled = result.nonEnrolled;
    // Surface the VERIFIED MLS roster + divergent ghosts for the 6.5 panel.
    media.onRosterState?.(members, result.ghosts);

    // Arm a ghost-divergence timer for each newly-ghost leaf (unless a faster
    // leave-grace already covers it); clear timers for leaves no longer ghosts.
    const ghosts = new Set(result.ghosts);
    for (const identity of ghosts) {
      if (this.#ghostTimers.has(identity) || this.#leaveGrace.has(identity))
        continue;
      const timer = setTimeout(() => {
        this.#ghostTimers.delete(identity);
        this.#timers.delete(timer);
        void this.#removeMember(identity, "ghost-leaf divergence timeout");
      }, GHOST_DIVERGENCE_MS);
      this.#ghostTimers.set(identity, timer);
      this.#timers.add(timer);
    }
    for (const identity of [...this.#ghostTimers.keys()]) {
      if (!ghosts.has(identity)) this.#clearGhostTimer(identity);
    }

    media.onRosterReconciled?.(result);
    // Drive the enable state machine off this FRESH roster (step 6): enable when
    // consistent + first key ready, pause on a mix, re-upgrade on a mix clear.
    this.#evaluateEnable(result);
    return result;
  }

  /**
   * The hostile-DS T-15 backstop + mix precondition (audit H2, carried item 2):
   * true iff every SFU participant is in the MLS group (no non-enrolled). A HARD
   * precondition the step-6 enable gate awaits at enable-time (a fresh reconcile,
   * not a stale tick) before `setE2EEEnabled(true)` / publishing.
   */
  async rosterConsistent(): Promise<boolean> {
    const result = await this.reconcileNow();
    return !!result && result.nonEnrolled.length === 0;
  }

  /** The current non-enrolled identities (step 6 reads this synchronously). */
  nonEnrolled(): readonly string[] {
    return this.#nonEnrolled;
  }

  /**
   * Remove a departed / ghost member from the MLS group. Re-checks under fresh
   * state that it is still an MLS member AND still absent from the SFU (a
   * rejoin, or another member's winning Remove, makes this a no-op) before
   * staging an arbitrated `callRemove`. Never removes self.
   */
  async #removeMember(identity: string, reason: string): Promise<void> {
    if (this.#terminal() || this.#state !== "active" || !this.#groupId) return;
    const media = this.#media;
    if (!media || identity === media.localIdentity()) return;
    // Rejoined within/after the grace ⇒ keep the member.
    if (media.sfuParticipants().includes(identity)) return;

    let member: { user_id: string; device_id: string } | undefined;
    try {
      const state = await this.#deps.bridge.callState(this.#groupId);
      member = state.members.find(
        (m) => `${m.user_id}:${m.device_id}` === identity,
      );
    } catch {
      return;
    }
    if (!member) return; // already removed (another member won the Remove)
    if (this.#terminal() || this.#state !== "active" || !this.#groupId) return;

    console.warn(`[mls] removing ${identity}: ${reason}`);
    const target = member;
    await this.#stageAndSubmit(
      () =>
        this.#deps.bridge.callRemove(
          this.#groupId!,
          target.user_id,
          target.device_id,
        ),
      "remove",
    );
  }

  /** Start (or restart) the periodic reconcile tick — a safety net. */
  #startReconcile(): void {
    this.#stopReconcile();
    this.#reconcileEnabled = true;
    const tick = () => {
      if (!this.#reconcileEnabled || this.#terminal()) return;
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        if (this.#reconcileTimer === timer) this.#reconcileTimer = null;
        // Chain the next tick only after this reconcile settles; the enabled
        // flag (cleared by #stopReconcile) prevents a stale re-arm.
        void this.reconcileNow().finally(tick);
      }, RECONCILE_INTERVAL_MS);
      this.#reconcileTimer = timer;
      this.#timers.add(timer);
    };
    tick();
  }

  #stopReconcile(): void {
    this.#reconcileEnabled = false;
    if (this.#reconcileTimer) {
      clearTimeout(this.#reconcileTimer);
      this.#timers.delete(this.#reconcileTimer);
      this.#reconcileTimer = null;
    }
    for (const timer of this.#leaveGrace.values()) {
      clearTimeout(timer);
      this.#timers.delete(timer);
    }
    this.#leaveGrace.clear();
    for (const timer of this.#ghostTimers.values()) {
      clearTimeout(timer);
      this.#timers.delete(timer);
    }
    this.#ghostTimers.clear();
    this.#nonEnrolled = [];
  }

  #clearLeaveGrace(identity: string): void {
    const timer = this.#leaveGrace.get(identity);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(timer);
      this.#leaveGrace.delete(identity);
    }
  }

  #clearGhostTimer(identity: string): void {
    const timer = this.#ghostTimers.get(identity);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(timer);
      this.#ghostTimers.delete(identity);
    }
  }

  // ---- Enable + lifecycle (step 6) — the ratchet-toward-encrypted driver ----

  /**
   * Drive the enable state machine off a FRESH reconcile (§3.4). Never opens a
   * plaintext path: on a mix it PAUSES publishing (keeping E2EE on), and it only
   * re-upgrades after a hysteresis once the mix clears (6.5 owns the explicit
   * downgrade-to-plaintext confirm).
   *   - consistent + first key ready + not enabled ⇒ ENABLE;
   *   - non-enrolled present while enabled ⇒ PAUSE (fail-closed);
   *   - mix cleared while paused ⇒ schedule the 15 s re-upgrade.
   */
  #evaluateEnable(result: RosterReconcileResult): void {
    if (!this.#media || this.#state !== "active") return;
    const consistent = result.nonEnrolled.length === 0;
    const inInterlude = this.#callMode.kind === "interlude";

    if (!consistent) {
      // A live participant we cannot encrypt to ⇒ mixed call ⇒ pause (never
      // publish plaintext). In a confirmed interlude the pause is not
      // reasserted (the user authorized plaintext), but any pending
      // re-upgrade is cancelled so we don't resume-encrypt while a mix
      // persists (T4/turnover, ME-16).
      if (inInterlude) {
        this.#applyMode({ type: "mix_detected" });
      } else if (this.#e2eeEnabled) {
        this.#onMixDetected();
      }
      return;
    }
    // Consistent roster from here.
    if (inInterlude) {
      // T6 ONLY (ME-6): an interlude NEVER warm-enables the old group; its
      // sole exit is the fresh-successor re-upgrade after the hysteresis.
      this.#applyMode({ type: "mix_cleared" });
      return;
    }
    if (this.#hasLocalKey && !this.#e2eeEnabled) {
      void this.#enable();
    } else if (this.#mixPaused) {
      this.#applyMode({ type: "mix_cleared" }); // T2 warm resume
    }
  }

  /**
   * Enable LiveKit E2EE with the plaintext-until-first-key guard: PAUSE local
   * publishing, flip `setEncryptionEnabled(true)`, then RESUME (the first local
   * send-key is already installed — `#evaluateEnable` gates on `#hasLocalKey`),
   * so no plaintext frame is ever published under an encrypted flag (§1.5).
   */
  async #enable(): Promise<void> {
    const media = this.#media;
    if (!media || this.#e2eeEnabled || this.#state !== "active") return;
    this.#e2eeEnabled = true; // set first — re-entry guard across the awaits
    try {
      await media.pausePublishing?.("enable-window");
      await media.setEncryptionEnabled?.(true);
      await media.resumePublishing?.("enable-window");
      this.#mixPaused = false;
      this.#setMode({ kind: "e2ee" }); // T0b
    } catch (error) {
      // Enable failed ⇒ we are NOT encrypted; stay fail-closed (publishing
      // paused) and surface loud rather than resume into plaintext.
      this.#e2eeEnabled = false;
      this.#onMediaError(error);
    }
  }

  /**
   * A non-enrolled participant appeared in an encrypted call: PAUSE local
   * publishing (fail-closed — never open a plaintext path without the native
   * confirm). Sets the §3.4 `mixed` mode — the 6.5 banner + confirm flow read
   * it. `onRosterReconciled` already carried the non-enrolled set for the UI.
   */
  #onMixDetected(): void {
    this.#cancelReupgrade();
    if (!this.#mixPaused) {
      this.#mixPaused = true;
      void this.#media?.pausePublishing?.("mixed");
    }
    this.#setMode({ kind: "mixed" }); // T1
  }

  /**
   * Schedule the re-upgrade hysteresis (a bouncing participant must not flap
   * pause/resume). `viaSuccessor` (T6, after a confirmed interlude): re-secure
   * with a FRESH successor group + re-enable. Else (T2, warm): the group never
   * left E2EE mode and keys never reached a non-member, so just resume.
   */
  #scheduleReupgrade(viaSuccessor: boolean): void {
    if (this.#reupgradeTimer) return;
    this.#reupgradeViaSuccessor = viaSuccessor;
    const timer = setTimeout(async () => {
      this.#reupgradeTimer = null;
      this.#timers.delete(timer);
      if (this.#terminal() || this.#state !== "active") return;
      // Re-check at fire time: a participant may have bounced back in.
      if (!(await this.rosterConsistent())) return;
      try {
        if (viaSuccessor) {
          // Fresh-successor re-upgrade (§3.4 sticky direction, no confirm):
          // rejoin fresh drops to negotiating, then the normal enable path
          // pauses → setE2EEEnabled(true) → first key → resume. Close the
          // announce oracle WITH the interlude (media-gate LOW-1): clear the
          // native downgrade grant before migrating — best-effort, and the
          // SAFE direction (clearing only ever forces a fresh confirm).
          if (this.#groupId) {
            void this.#deps.bridge
              .callClearDowngrade(this.#groupId)
              .catch(() => {});
          }
          this.#announcedBy = undefined;
          this.#setMode({ kind: "negotiating" });
          this.#e2eeEnabled = false;
          this.#mixPaused = false;
          this.#scheduleGroupAction(() =>
            this.#rejoinFresh("re-upgrade after plaintext interlude"),
          );
        } else {
          await this.#media?.resumePublishing?.("mixed");
          this.#mixPaused = false;
          this.#setMode({ kind: "e2ee" }); // T2
        }
      } catch (error) {
        this.#onMediaError(error);
      }
    }, REUPGRADE_HYSTERESIS_MS);
    this.#reupgradeTimer = timer;
    this.#timers.add(timer);
  }

  // ---- §3.4 mode machine glue (slice 6.5) -----------------------------------

  /**
   * Set the mode + emit it to the UI binding. Keeps the publish-gate
   * `negotiating` reason in lockstep with the mode (R2-1/R2-5): state.tsx
   * asserts it BEFORE room.connect, and the session releases it the moment it
   * leaves `negotiating` (any verdict — e2ee/off/mixed/interlude/call_full),
   * or re-asserts it if it drops back to negotiating (a successor re-upgrade).
   */
  #setMode(mode: CallMode): void {
    const wasNegotiating = this.#callMode.kind === "negotiating";
    this.#callMode = mode;
    if (mode.kind === "negotiating" && !wasNegotiating) {
      void this.#media?.pausePublishing?.("negotiating");
    } else if (mode.kind !== "negotiating" && wasNegotiating) {
      void this.#media?.resumePublishing?.("negotiating");
    }
    this.#media?.onCallModeChanged?.(mode, {
      nonEnrolled: this.#nonEnrolled,
      announcedBy: this.#announcedBy,
    });
  }

  /**
   * Run one §3.4 transition through the pure machine and execute its effects.
   * Used for the genuinely-new 6.5 transitions (interlude / remote announce /
   * mix-cleared-in-interlude); the 6.4 negotiating/mixed/e2ee mechanics call
   * `#setMode` directly (they own their own pause/enable timing).
   */
  #applyMode(event: CallModeEvent): void {
    // Transitions are SERIALIZED on a chain: each event's transition is
    // computed against the freshest mode (two rapid events must not both
    // compute from the same stale mode), media-plane effects run serially and
    // AWAITED, and the mode (whose lockstep may release the `negotiating`
    // gate = a resume) is set only after they complete — so `set_e2ee(false)`
    // STRICTLY precedes any resume in COMPLETION order, not just initiation
    // order (gate F8: a resume racing ahead of the E2EE-off would briefly
    // publish encrypted frames to keyless peers). Timers/announce/auto-leave
    // dispatch without blocking the chain.
    this.#modeChain = this.#modeChain
      .then(async () => {
        const { mode, effects } = callModeTransition(this.#callMode, event);
        for (const effect of effects) {
          switch (effect.do) {
            case "pause":
              await this.#media?.pausePublishing?.(effect.reason);
              break;
            case "resume":
              await this.#media?.resumePublishing?.(effect.reason);
              break;
            case "set_e2ee":
              if (!effect.enabled) this.#e2eeEnabled = false;
              await this.#media?.setEncryptionEnabled?.(effect.enabled);
              break;
            case "announce":
              void this.#announceDowngrade();
              break;
            case "schedule_reupgrade":
              this.#scheduleReupgrade(effect.viaSuccessor);
              break;
            case "cancel_reupgrade":
              this.#cancelReupgrade();
              break;
            case "auto_leave":
              this.#media?.autoLeave?.("call full for E2EE");
              break;
          }
        }
        this.#setMode(mode);
      })
      .catch((error) => this.#onMediaError(error));
  }

  /**
   * The user confirmed the whole-call plaintext downgrade (§3.4 T3/T5). Public
   * entry from the 6.5 banner. Shows the BLOCKING native confirm dialog (its
   * non-enrolled roster is native-computed); on Ok, transitions to a confirmed
   * interlude — set_e2ee(false) STRICTLY before resume (invariant 1), then a
   * best-effort announce. Cancel keeps the mixed pause.
   */
  async confirmPlaintext(displayNames: Record<string, string>): Promise<void> {
    if (!this.#groupId || this.#terminal()) return;
    // Reachable from: mixed (T3), an unconfirmed interlude (T5), or — the
    // ME-10 terminal-loud escape — a call that FAILED to secure while still
    // `negotiating` (retry exhaustion / loud failure): "Stay unencrypted".
    // A HEALTHY negotiation is excluded (no UI offers the button there, and
    // the guard makes the API unmisusable).
    // Terminal-loud populations (re-verify MED-B): retry exhaustion / loud
    // failure (`failed`/`resecuring`) AND a LATCHED loud media-plane error
    // while the state is still nominally `active` (e.g. `#enable` threw —
    // the E2EE worker died — and `#latchLoud` latched without failing the
    // session). All show the same terminal banner; all must make its
    // "Stay unencrypted" button real.
    const terminalEscape =
      this.#callMode.kind === "negotiating" &&
      (this.#state === "failed" ||
        this.#state === "resecuring" ||
        this.#loudLatched);
    if (
      this.#callMode.kind !== "mixed" &&
      !(
        this.#callMode.kind === "interlude" && !this.#callMode.localConfirmed
      ) &&
      !terminalEscape
    ) {
      return; // not a confirmable state
    }
    const sfu = this.#media?.sfuParticipants() ?? [];
    try {
      // The native dialog computes its own non-enrolled set; Declined throws.
      await this.#deps.bridge.callConfirmDowngrade(
        this.#groupId,
        sfu,
        displayNames,
      );
    } catch {
      return; // Declined ⇒ stay mixed (paused, receive-only); banner persists
    }
    if (this.#terminal() || !this.#groupId) return;
    this.#announcedBy = undefined;
    this.#applyMode({ type: "local_confirm" });
  }

  /** Courier a best-effort §3.4 mode announcement (ME-4/ME-12). */
  async #announceDowngrade(): Promise<void> {
    if (!this.#groupId || this.#terminal()) return;
    try {
      const payload = await this.#deps.bridge.callAnnounce(
        this.#groupId,
        this.#deps.userId,
      );
      await this.#deps.bridge.mlsSendCtl(payload);
    } catch (error) {
      // Best-effort: an announce failure never blocks the local transition
      // (peers converge via their own mix detection, ME-4). Log for telemetry.
      console.warn(
        "[mls] downgrade announce failed (peers converge via mix)",
        error,
      );
    }
  }

  /**
   * A received §3.4 ctl-announce (T4/T5). Parse default-closed; act only on a
   * plaintext mode change from a verified member whose channel+group match the
   * live call. Never opens the local plaintext path — it re-words the banner
   * and offers the confirm.
   */
  #onCtlReceived(ctl: {
    sender_user_id: string;
    sender_device_id: string;
    payload: string;
  }): void {
    if (this.#terminal() || !this.#groupId) return;
    const parsed = parseCtlPayload(ctl.payload);
    if (!parsed) return; // unknown/forward-compat → quiet no-op (ME-15)
    if (parsed.groupId !== this.#groupId) return; // wrong group binding
    if (parsed.channelId !== this.#deps.channelId) return; // wrong channel
    // T4: only meaningful while mixed (an already-interlude member ignores a
    // duplicate announce — T5 dedupe). Publishing STAYS PAUSED.
    if (this.#callMode.kind !== "mixed") return;
    this.#announcedBy = ctl.sender_user_id;
    this.#applyMode({ type: "remote_announce" });
  }

  /** A3 (6.5): a NEW joiner refused at the roster cap — terminal + auto-leave. */
  #onCallFull(): void {
    if (this.#terminal()) return;
    this.#onLoud(new Error("call full for E2EE"));
    this.#applyMode({ type: "call_full" });
  }

  #cancelReupgrade(): void {
    if (this.#reupgradeTimer) {
      clearTimeout(this.#reupgradeTimer);
      this.#timers.delete(this.#reupgradeTimer);
      this.#reupgradeTimer = null;
    }
  }

  /**
   * Reset the enable state machine on a group re-establish / teardown. If E2EE
   * was active (or mix-paused), keep publishing PAUSED through the re-secure —
   * the successor group's keys are not installed yet, so publishing now would go
   * plaintext under the still-set E2EE flag (plan §1.4: re-securing publishes
   * nothing). `#enable` resumes once the successor's first key lands. E2EE mode
   * on the Room is left ON (6.4 never disables into plaintext).
   */
  #resetEnableState(): void {
    this.#cancelReupgrade();
    // A locally-confirmed interlude keeps publishing plaintext THROUGH a
    // control-plane re-secure (the authorization came from the user, not from
    // group state; Room E2EE is off, so there is no key dependency). Every
    // other state pauses through the re-secure (successor keys not installed).
    const confirmedInterlude =
      this.#callMode.kind === "interlude" && this.#callMode.localConfirmed;
    if (!confirmedInterlude && (this.#e2eeEnabled || this.#mixPaused)) {
      void this.#media?.pausePublishing?.("enable-window");
    }
    this.#e2eeEnabled = false;
    this.#mixPaused = false;
    if (!confirmedInterlude) this.#announcedBy = undefined;
  }

  // ---- Heartbeat (step 6; §1.4) — bound stable-roster exposure ---------------

  /** Start (or restart) the self-rescheduling heartbeat tick. */
  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatEnabled = true;
    const tick = () => {
      if (!this.#heartbeatEnabled || this.#terminal()) return;
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        if (this.#heartbeatTimer === timer) this.#heartbeatTimer = null;
        void this.#maybeHeartbeat().finally(tick);
      }, HEARTBEAT_MS);
      this.#heartbeatTimer = timer;
      this.#timers.add(timer);
    };
    tick();
  }

  #stopHeartbeat(): void {
    this.#heartbeatEnabled = false;
    if (this.#heartbeatTimer) {
      clearTimeout(this.#heartbeatTimer);
      this.#timers.delete(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  /**
   * Stage a heartbeat self-update iff we are the LOWEST online leaf (§1.4) — a
   * deterministic single committer on a stable roster (the roster reorders as
   * leaves depart, so the duty fails over). Submitted + arbitrated like any
   * commit; the empty self-update also exercises the desync machinery.
   */
  async #maybeHeartbeat(): Promise<void> {
    if (this.#state !== "active" || !this.#groupId) return;
    let lowest: { user_id: string; device_id: string } | undefined;
    try {
      const state = await this.#deps.bridge.callState(this.#groupId);
      lowest = state.members[0];
    } catch {
      return;
    }
    if (this.#state !== "active" || !this.#groupId) return;
    if (
      !lowest ||
      lowest.user_id !== this.#deps.userId ||
      lowest.device_id !== this.#deps.deviceId
    ) {
      return; // not the lowest leaf — another member heartbeats
    }
    const groupId = this.#groupId;
    await this.#stageAndSubmit(
      () => this.#deps.bridge.callHeartbeat(groupId),
      "heartbeat",
    );
  }

  // ---- Small utilities ------------------------------------------------------

  async #safeLeave(groupId: string): Promise<void> {
    try {
      await this.#deps.bridge.callLeaveCleanup(groupId);
    } catch (error) {
      console.error("[mls] leave-cleanup failed", error);
    }
  }

  async #withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("mls operation timed out")),
        ms,
      );
      this.#timers.add(timer);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        this.#timers.delete(timer);
      }
    }
  }

  #terminal(): boolean {
    return this.#state === "closed" || this.#state === "plaintext";
  }

  #toActive(): void {
    this.#reestablishes = 0;
    this.#setState("active");
    // Begin reconciling the SFU set against the MLS roster (step 5) + the
    // lowest-leaf heartbeat (step 6). Idempotent — a re-establish restarts fresh
    // loops; both no-op before `bindMedia` / on feature-off.
    this.#startReconcile();
    this.#startHeartbeat();
  }

  #toPlaintext(): void {
    // Quiet (L4) — feature off / not an E2EE call; NOT a loud failure.
    this.#setState("plaintext");
    this.#setMode({ kind: "off" }); // T0a — no chrome on a plain voice call
  }

  #toResecuring(reason: string): void {
    console.warn("[mls] re-securing:", reason);
    this.#setState("resecuring");
  }

  #onLoud(error: unknown): void {
    console.error("[mls] loud failure", error);
    this.#lastError = error;
    this.#setState("failed");
  }

  #setState(state: MlsSessionState): void {
    if (this.#state === "closed") return; // closed is terminal
    this.#state = state;
    this.#deps.onStateChange?.(state);
  }
}

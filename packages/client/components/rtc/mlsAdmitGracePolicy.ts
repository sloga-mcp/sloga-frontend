/**
 * Admit-grace BUDGET arithmetic — the pure core of the join-direction grace,
 * split out of `mlsCallSession` for the house reason: that module imports
 * extensionless paths and cannot be loaded by `node --test`, so anything worth
 * pinning with a spec has to live here (same rule as `mlsRosterPolicy` /
 * `mlsCallModePolicy` / `mlsAdmitPolicy`).
 *
 * What the grace is for: a mid-call joiner sits in the SFU for seconds before
 * its staggered Add commits, and calling it non-enrolled in that window flips
 * the call to `mixed`, pauses the mic and one-way stops an Android screen leg.
 *
 * What the budget is for: the grace SUPPRESSES a downgrade warning, so its
 * cost has to be bounded per identity for the life of the call. It is billed
 * as time actually SPENT in grace, not as an absolute deadline from the first
 * join, and that distinction is the whole design:
 *
 *  - billing time spent stops CHURN from resetting the ceiling. The window
 *    used to be minted fresh on every join, and a leave cleared it, so a peer
 *    cycling faster than the window could hold `pending` forever and the mix
 *    warning would never fire — accidentally on a flapping network, or
 *    deliberately, since a hostile SFU authors the connect/disconnect events.
 *    It also suppressed re-upgrade, because evaluation early-returns while
 *    anything is pending.
 *  - billing time spent, rather than stamping a per-call deadline, keeps a
 *    LEGITIMATE rejoin working: an identity that spent three seconds in grace
 *    an hour ago still has the rest of its budget for a genuine later admit.
 *
 * It also makes a full LiveKit reconnect safe. `handleSignalRestarted`
 * re-emits `ParticipantConnected` for every remote (buffered while the state
 * is `Reconnecting`, replayed on `Reconnected`), so the join hook fires for
 * participants that were already present and already loud; with a per-call
 * budget those replays cannot mint fresh windows and blank the mixed banner's
 * names.
 */
import { stripLeg } from "../ui/components/features/voice/participantIdentity.ts";

export interface AdmitGraceWindowInput {
  /** Grace milliseconds this identity has already spent in this call. */
  usedMs: number;
  /** Primary (non-leg) SFU participants — the staggered Add scales with it. */
  primaries: number;
  /** Base window before the stagger allowance. */
  baseMs: number;
  /** Per-primary allowance for the staggered Add ladder. */
  staggerMs: number;
  /** Hard per-identity, per-call ceiling on total suppression. */
  maxMs: number;
}

export interface AdmitGraceWindow {
  /** How long to wait before this window's first expiry check. */
  graceMs: number;
  /** Remaining budget — the refresh/re-arm ceiling for this window. */
  budgetMs: number;
}

/**
 * The window to arm for a joiner, or null when its budget is spent.
 *
 * Null is not an error: it means this identity has already had its full
 * allowance of suppression in this call and has not enrolled, so it falls
 * straight through to non-enrolled and the loud path on sight.
 */
export function admitGraceWindow(
  input: AdmitGraceWindowInput,
): AdmitGraceWindow | null {
  const budgetMs = input.maxMs - input.usedMs;
  if (budgetMs <= 0) return null;
  return {
    // Never longer than what is left: the stagger allowance widens the window
    // for a big call, it does not buy extra budget.
    graceMs: Math.min(
      input.baseMs + Math.max(0, input.primaries) * input.staggerMs,
      budgetMs,
    ),
    budgetMs,
  };
}

/**
 * Charge a closing window's elapsed time to the identity's running total.
 *
 * Clamped at both ends: a clock that jumped backwards must not refund budget,
 * and the total never exceeds the ceiling, so a single very long window
 * cannot make later arithmetic go negative.
 */
export function billAdmitGrace(
  usedMs: number,
  elapsedMs: number,
  maxMs: number,
): number {
  return Math.min(maxMs, usedMs + Math.max(0, elapsedMs));
}

/** The outcome of settling one open window against a roster observation. */
export interface AdmitGraceSettle {
  /** Pending milliseconds to charge to the identity's budget NOW. */
  billMs: number;
  /** The window's new pending-since stamp (null = currently inert). */
  pendingSince: number | null;
}

/**
 * Settle an OPEN window against the latest roster observation.
 *
 * The budget may only be charged for time the identity was actually REPORTED
 * pending — i.e. time its window suppressed a would-be non-enrolled verdict.
 * Charging an open window for its whole lifetime over-billed two legitimate
 * shapes into budget exhaustion:
 *
 *  - an identity that ADMITTED promptly keeps its window open by design (the
 *    eager-clear-at-admit hazard: a stale-leaf rejoin is momentarily in the
 *    roster, and clearing then left it graceless when the stale leaf was
 *    removed) — but the window is INERT from the admit on, and billing its
 *    full open duration charged a member for time it suppressed nothing;
 *  - a full LiveKit reconnect replays `ParticipantConnected` for every
 *    already-enrolled remote, arming inert windows for all of them — billing
 *    those at full duration meant a few network blips exhausted every
 *    legitimate member's budget, and their next REAL admit went loud.
 *
 * So the window carries `pendingSince`: set while the identity is reported
 * pending, null while inert. Each observation charges the stretch that just
 * ENDED (reported-pending → not) and restarts the stamp when suppression
 * resumes. Closing a window (leave, expiry, teardown) settles it as
 * not-pending, charging any open stretch. The hostile-SFU bound is intact:
 * an identity a hostile SFU keeps looking non-enrolled is continuously
 * reported pending, so its stretches sum to the same ceiling as before.
 */
export function settleAdmitGrace(
  pendingSince: number | null,
  reportedPending: boolean,
  nowMs: number,
): AdmitGraceSettle {
  if (reportedPending) {
    return { billMs: 0, pendingSince: pendingSince ?? nowMs };
  }
  return {
    billMs: pendingSince === null ? 0 : Math.max(0, nowMs - pendingSince),
    pendingSince: null,
  };
}

/**
 * When an OPEN window's timer should next fire after a re-arm (enrolment
 * evidence seen, or an expiry that found the admit still in progress), or
 * `null` when the window's budget deadline has passed and it must lapse.
 *
 * A re-arm may EXTEND a window, never SHORTEN it. The old arithmetic re-armed
 * to `now + base` unconditionally: the window a stayer arms at a rejoiner's
 * connect is `base + primaries × stagger` (14 s in a 1:1 with two primaries),
 * and the rejoiner's own intent — enrolment evidence, arriving within a
 * second — re-armed it to `now + 10 s`, so the very event that proves the
 * joiner is enrolling cut its window by a third and made it lapse inside the
 * Remove→Add gap of a served rejoin (2026-09-07, a contributor to the rejoin
 * beat). The deadline still caps: extension never buys budget.
 */
export function rearmAdmitGraceExpiry(input: {
  nowMs: number;
  /** When the window's current timer would fire. */
  currentExpiryMs: number;
  baseMs: number;
  /** The window's budget deadline (arm time + remaining budget). */
  deadlineMs: number;
}): number | null {
  if (input.deadlineMs <= input.nowMs) return null;
  return Math.min(
    input.deadlineMs,
    Math.max(input.currentExpiryMs, input.nowMs + input.baseMs),
  );
}

/**
 * Whether a screen leg's OWNER primary is in the call — the same owner rule
 * `reconcileRoster` applies before it graces an unfolded leg.
 *
 * `localIdentity` counts as present: the roster deletes our own identity from
 * the SFU set before it looks, and our own device's leg is the most legitimate
 * leg there is. Without it the SHARER's phone would be the first to lose its
 * own leg's grace. On a primary `stripLeg` is the identity itself, so this
 * reads as plain presence; callers only ask it about legs. An empty owner (a
 * malformed `::screen` identity) is never present, even against an empty
 * `localIdentity`.
 */
export function legOwnerPresent(
  leg: string,
  sfu: readonly string[],
  localIdentity: string,
): boolean {
  const owner = stripLeg(leg);
  return owner !== "" && (sfu.includes(owner) || owner === localIdentity);
}

/**
 * Whether a leg's spent grace is forgiven because it has now been seen
 * PUBLISHED.
 *
 * Legs are still billed like any joiner, but each share start bills its own
 * connect→publish gap against a ledger that lives for the whole call, so a
 * phone that shared enough times ran out of budget: its next leg was
 * non-enrolled on sight, the share self-stopped and every viewer went red. A
 * publication ends the leg's inert window, so it clears the slate. A churned
 * leg that never publishes never resets and still runs out at the per-call
 * ceiling, which keeps the anti-churn bound on `#admitGraceUsed`.
 */
export function admitGraceLedgerResets(i: {
  isLeg: boolean;
  legPublished: boolean;
}): boolean {
  return i.isLeg && i.legPublished;
}

export interface AdmitGraceRearmInput {
  /** The identity is a screen leg rather than a primary. */
  isLeg: boolean;
  /** This member's own admit machinery is still working on the identity. */
  admitInProgress: boolean;
  /** The leg has a publication (ignored for a primary). */
  legPublished: boolean;
  /** `legOwnerPresent` for the leg (ignored for a primary). */
  legOwnerPresent: boolean;
}

/**
 * Whether an expiring window is still enrolling and should re-arm.
 *
 * A primary re-arms while its admit is in progress, as before. A leg never
 * sends a join request, so that signal is always false for it and a slow
 * connect→publish lapsed straight into non-enrolled. A leg re-arms instead
 * while it is still in its inert window, unpublished with its owner present,
 * mirroring the roster's leg grace. Re-arms stay capped by the window's
 * remaining budget, so this never extends past the ceiling.
 */
export function shouldRearmAdmitGrace(i: AdmitGraceRearmInput): boolean {
  if (i.isLeg) return !i.legPublished && i.legOwnerPresent;
  return i.admitInProgress;
}

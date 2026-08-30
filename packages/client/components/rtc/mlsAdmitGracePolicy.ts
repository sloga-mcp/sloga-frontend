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

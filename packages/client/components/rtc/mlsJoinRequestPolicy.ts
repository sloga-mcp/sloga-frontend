/**
 * How a member session routes one fanned-out join request (extracted from
 * `mlsCallSession` so it is unit-testable in isolation — it is PURE).
 * Membership checks deliberately stay OUT of this policy: `#tryAdmit` and
 * `#removeStaleLeaf` re-check the roster under FRESH `callState` at timer
 * fire (fresh state at fire time beats stale state at event time).
 */

/** What the session does with one join request. */
export type JoinRequestAction = "schedule_admit" | "serve_rejoin" | "ignore";

export function joinRequestAction(opts: {
  /** The event carried the DS rejoin flag (already-member intent). */
  rejoin: boolean;
  /** The request names OUR OWN user. */
  isSelf: boolean;
}): JoinRequestAction {
  // Our own fan-out echo (every member USER receives the event — including
  // the rejoiner) and any post-readd replay of our own intent must never
  // schedule an admit of ourselves NOR a Remove of our own live leaf
  // (native would refuse the latter — CannotRemoveSelf — but loudly).
  if (opts.isSelf) return "ignore";
  return opts.rejoin ? "serve_rejoin" : "schedule_admit";
}

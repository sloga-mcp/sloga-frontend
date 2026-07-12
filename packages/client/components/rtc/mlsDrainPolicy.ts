import type { EnvelopeDisposition } from "@revolt/client";

/**
 * The mailbox-drain decision policy (extracted from `mlsCallSession` so it is
 * unit-testable in isolation — it is PURE). Maps a native envelope disposition
 * + the running counters/flags to the single action the drain takes.
 */

/** Bounds fed into `drainAction` so the cutoffs are explicit + auditable. */
export interface DrainBounds {
  maxRetries: number;
  maxParkAttempts: number;
}

/** What the mailbox drain does with one processed envelope. */
export type DrainAction =
  | { do: "ack" }
  | { do: "ack_removed_self" }
  | { do: "gap_refetch"; fromEpoch: number }
  | { do: "escalate_desync" }
  | { do: "retry" }
  | { do: "ack_drop_poison" }
  | { do: "successor" }
  // Leaf-verify fix: reconcile this user's signed device listing OFF the lock,
  // then re-feed the SAME envelope (no ack, off #seen) — audit MED-3.
  | { do: "fetch_identity"; userId: string }
  // Leaf-verify fix, audit MED-1: reconcile made no progress (same user
  // rejected again) — a bare ack-drop would wedge the joiner (the admitter
  // already has it in-roster and never re-sends a Welcome), so discard local
  // state and rejoin fresh. Never plaintext.
  | { do: "rejoin_fresh"; reason: string };

/**
 * Map a native disposition + the running retry/park counters to a drain action
 * (§3.3). Encodes the BOUNDS as pure logic: park/gap-refetch escalates to
 * desync after `maxParkAttempts` (M4); a transient error becomes
 * ack+drop-as-poison after `maxRetries` (carried item 4) so an unrecognised
 * terminal error can never spin the drain forever; and a `needs_identity` leaf
 * is progress-bounded — one COMPLETED reconcile per user (`identityFetched`)
 * and at most `maxRetries` transiently-failed reconcile attempts, else rejoin
 * fresh (leaf-verify fix, audit HIGH-2 / MED-1).
 */
export function drainAction(
  disp: EnvelopeDisposition,
  retries: number,
  parkAttempts: number,
  bounds: DrainBounds,
  identityFetched = false,
): DrainAction {
  switch (disp.kind) {
    case "processed":
      return disp.outcome.removed_self
        ? { do: "ack_removed_self" }
        : { do: "ack" };
    case "park":
      return parkAttempts >= bounds.maxParkAttempts
        ? { do: "escalate_desync" }
        : { do: "gap_refetch", fromEpoch: disp.expected };
    case "drop":
      return disp.successorNeeded ? { do: "successor" } : { do: "ack" };
    case "needs_identity":
      // PROGRESS-BOUNDED (audit HIGH-2 answer): a COMPLETED reconcile is
      // deterministic per server listing, so re-fetching the SAME user is
      // pointless — one completed reconcile per user per group.
      // `identityFetched` = this user's reconcile already COMPLETED for this
      // group (no progress) → rejoin fresh (MED-1), never spin, never
      // plaintext. A reconcile that FAILS transiently does NOT set the flag —
      // it burns an envelope retry instead, so an unreachable listing is
      // retried (bounded) rather than mistaken for "reconciled, still
      // unverifiable", and still can't spin past `maxRetries`.
      if (identityFetched) {
        return {
          do: "rejoin_fresh",
          reason: `leaf for ${disp.userId} unverifiable after reconcile`,
        };
      }
      if (retries >= bounds.maxRetries) {
        return {
          do: "rejoin_fresh",
          reason: `identity reconcile for ${disp.userId} unreachable`,
        };
      }
      return { do: "fetch_identity", userId: disp.userId };
    case "error":
      return retries >= bounds.maxRetries
        ? { do: "ack_drop_poison" }
        : { do: "retry" };
  }
}

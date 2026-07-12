import type { EnvelopeDisposition } from "./e2ee";

/**
 * Map a native `e2ee_call_process` rejection to a mailbox disposition (the
 * carried 6.2 ack-and-drop policy). Pure + exported so the policy is auditable
 * and unit-testable in isolation (the type-only import above is erased at
 * runtime — this module must stay dependency-free so `node --test` can load
 * it). The typed error crosses IPC as `{ type: "<snake_case>", … }` (see
 * e2ee-core `Error`, `#[serde(tag = "type")]`).
 *
 *  - `mls_epoch_gap` → PARK, gap-refetch, NEVER ack/skip (invariant 10).
 *  - `mls_poisoned_epoch` → ack+drop + successor-needed (channel-scoped
 *    successor flow, §1.4); loud.
 *  - `mls_group_not_found` → the group was left/wiped; ack+drop, quiet.
 *  - `mls_unsolicited_welcome` → the carried 6.1 defense fired natively;
 *    refuse + ack+drop, quiet (no group to disrupt).
 *  - `mls_welcome_context_mismatch` → hostile-DS cross-group relay (T-15);
 *    refuse LOUD + ack+drop.
 *  - `mls_leaf_rejected` → split by `reason` (leaf-verify fix): ONLY
 *    `binding_unverified` → `needs_identity` (reconcile + reprocess, no ack);
 *    every other/unknown reason → hostile, refuse LOUD + ack+drop.
 *  - anything else → surface loud, do NOT ack (may be reprocessable).
 */
export function classifyEnvelopeError(error: unknown): EnvelopeDisposition {
  const type = (error as { type?: string } | null)?.type;
  switch (type) {
    case "mls_epoch_gap": {
      const e = error as { expected: number; got: number };
      return { kind: "park", expected: e.expected, got: e.got, ack: false };
    }
    case "mls_poisoned_epoch":
      return {
        kind: "drop",
        reason: "poisoned",
        loud: true,
        successorNeeded: true,
        ack: true,
      };
    case "mls_group_not_found":
      return {
        kind: "drop",
        reason: "wiped",
        loud: false,
        successorNeeded: false,
        ack: true,
      };
    case "mls_unsolicited_welcome":
      return {
        kind: "drop",
        reason: "unsolicited_welcome",
        loud: false,
        successorNeeded: false,
        ack: true,
      };
    case "mls_leaf_rejected": {
      // ALLOW-LIST (leaf-verify fix, audit MED-2): ONLY `binding_unverified`
      // is recoverable — a signed device-listing reconcile upgrades the
      // curve-only stub and the same envelope reprocesses. `unknown_identity`
      // (no pin at all — reconcile cannot create one), every hostile reason
      // (identity_changed / *_mismatch / bad_binding_signature / malformed /
      // …), and any FUTURE reason default to the terminal loud drop below.
      const e = error as {
        user_id?: string;
        device_id?: string;
        reason?: string;
      };
      if (e.reason === "binding_unverified" && e.user_id && e.device_id) {
        return {
          kind: "needs_identity",
          userId: e.user_id,
          deviceId: e.device_id,
          ack: false,
        };
      }
      return {
        kind: "drop",
        reason: type,
        loud: true,
        successorNeeded: false,
        ack: true,
      };
    }
    case "mls_welcome_context_mismatch":
      return {
        kind: "drop",
        reason: type,
        loud: true,
        successorNeeded: false,
        ack: true,
      };
    // A §3.4 ctl-announce (6.5) that could not be decrypted/parsed — sent
    // under a prior epoch/generation this device no longer holds keys for
    // (`max_past_epochs` is 0), malformed, or the wrong content kind. QUIET
    // ack+drop: the announce is coordination-only and every member converges
    // via its own mix detection without it. Never loud, never a successor.
    case "mls_stale_ctl":
      return {
        kind: "drop",
        reason: type,
        loud: false,
        successorNeeded: false,
        ack: true,
      };
    // Terminal STRUCTURAL rejections — a malformed / undecodable / unsuitable
    // envelope never becomes valid on retry. An untrusted DS orders the
    // mailbox (invariant 5), so without a terminal disposition here it could
    // wedge one bad envelope at the HEAD of a victim's queue and block a
    // legitimate Remove behind it (invariant-7 degradation). Ack+drop as a
    // POISON PILL — distinct from the transient no-ack retries below.
    case "mls":
    case "invalid_argument":
    case "mls_not_published":
      return {
        kind: "drop",
        reason: type,
        loud: true,
        successorNeeded: false,
        ack: true,
      };
    default:
      // Genuinely transient (storage / protector / IPC / transport / an
      // error type we don't recognise): surface loud, do NOT ack — the
      // envelope may be reprocessable. The 6.4 drain MUST bound retries so an
      // unrecognised terminal error still can't spin forever.
      return { kind: "error", error, ack: false };
  }
}

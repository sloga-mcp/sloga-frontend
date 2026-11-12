/**
 * S2-D36: why a protected channel is re-securing, when its notice may
 * escalate, and which action to offer then (design 9.1 "Re-securing causes
 * and escalation", protected-channels-design.md @74390c37 :5057-5064).
 *
 * Pure and node-testable. Escalation is amber only: this module never
 * produces a shield state and never changes one. Red comes only from
 * verification failures (`explainShield` step 3 / 6 / 6c / 9); a caller
 * shows this result only while the shield is already `resecuring`.
 * Ids are compared, never returned.
 */
import type {
  ProtectedChannelView,
  ProtectedTextGroupResponse,
  TextChannelState,
} from "./protectedTextTypes.ts";

export const RESECURE_CAUSES = [
  "pending_removal",
  "stale_group",
  "poisoned_owner",
  "poisoned_member",
  "owner_device_lost",
  "owner_account_unavailable",
  "waiting_for_member",
  "other",
] as const;

export type ResecureCause = (typeof RESECURE_CAUSES)[number];

export const RESECURE_ACTIONS = [
  "retry_removal",
  "rejoin",
  "recreate",
  "recover_ownership",
] as const;

export type ResecureAction = (typeof RESECURE_ACTIONS)[number];

/** Delay from `resecuringSinceMs` to escalation, per cause. */
export const RESECURE_ESCALATION_MS = {
  // :5058-5059 "Pending removal: 2 min, then "Retry removal"".
  pending_removal: 120_000,
  // :5059 "Stale epoch or group: 2 min, then "Rejoin"".
  stale_group: 120_000,
  // :5059-5060 "Poisoned group on the owner's device: 1 min, then
  // "Re-create the protected group"".
  poisoned_owner: 60_000,
  // :5060-5061 "Poisoned group on a member device: 5 min, then "Waiting
  // for {owner}"" (copy only, no action).
  poisoned_member: 300_000,
  // :5061-5062 no timer: "Recover ownership on this device" on an
  // owner-user device, else the 9.2 copy (:5125), from the start.
  owner_device_lost: 0,
  // :5125 (9.2 row, no timer): "The owner's account is unavailable."
  owner_account_unavailable: 0,
  // :5062-5063 "Waiting for a member to come online: static after 2 min".
  waiting_for_member: 120_000,
  // Doc silent; the generic notice goes static after 2 min, no action.
  other: 120_000,
} as const satisfies Record<ResecureCause, number>;

/**
 * The view fields this policy reads, plus three the view does not carry
 * (the caller supplies them). `{ ...view, resecuringSinceMs, selfUserId,
 * selfDeviceId }` satisfies it.
 */
export interface ResecureInputs {
  groupError: ProtectedChannelView["groupError"];
  native: Pick<
    TextChannelState,
    "group_id" | "epoch" | "state" | "verdict" | "seat_list"
  > | null;
  serverGroup: Pick<
    ProtectedTextGroupResponse,
    | "group_id"
    | "current_epoch"
    | "pending_removals"
    | "pending_device_removals"
    | "signer_lost"
  > | null;
  welcomeRetriesExhausted: boolean;
  /**
   * NOT on the view: `port.now()` when the channel's shield entered
   * `resecuring`, null when unknown (never escalates).
   */
  resecuringSinceMs: number | null;
  /** NOT on the view: `port.selfUserId`. */
  selfUserId: string;
  /** NOT on the view: `port.selfDeviceId`. */
  selfDeviceId: string;
}

export interface ResecureEscalation {
  cause: ResecureCause;
  /** When the notice may escalate (static amber); null while unknown. */
  escalateAtMs: number | null;
  /** `now >= escalateAtMs`; false for a non-finite or earlier `now`. */
  escalated: boolean;
  /** Offered only once escalated; null otherwise. */
  action: ResecureAction | null;
}

/** Native errors that mean the held epoch is behind (rejoin fixes them). */
const STALE_GROUP_ERRORS: readonly string[] = [
  "mls_epoch_gap",
  "unknown_epoch",
  "catch_up_leaf_unresolvable",
];

const nonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

function finish(
  cause: ResecureCause,
  sinceMs: number | null,
  now: number,
  offered: ResecureAction | null,
): ResecureEscalation {
  const since =
    typeof sinceMs === "number" && Number.isFinite(sinceMs) ? sinceMs : null;
  const escalateAtMs =
    since === null ? null : since + RESECURE_ESCALATION_MS[cause];
  // A clock that went backwards (now < since) never escalates.
  const escalated =
    escalateAtMs !== null &&
    typeof now === "number" &&
    Number.isFinite(now) &&
    now >= escalateAtMs;
  const action = escalated ? offered : null;
  return { cause, escalateAtMs, escalated, action };
}

/**
 * The re-securing cause. Precedence: the lost signer first (nothing moves
 * until the owner recovers, 9.2 :5117 R12), then waiting for a member
 * (the shield's step 6d precedes step 7), poisoned, pending removal,
 * stale, other.
 */
export function resecureCause(
  i: ResecureInputs,
  now: number,
): ResecureEscalation {
  const since = i.resecuringSinceMs;
  const n = i.native;
  const g = i.serverGroup;

  const lost: unknown = g?.signer_lost;
  if (lost !== undefined && lost !== null) {
    if (typeof lost !== "object") return finish("other", since, now, null);
    const l = lost as Partial<
      NonNullable<ProtectedTextGroupResponse["signer_lost"]>
    >;
    if (l.cause === "account_unavailable") {
      return finish("owner_account_unavailable", since, now, null);
    }
    if (l.cause !== "device_revoked") return finish("other", since, now, null);
    // Only on another device of the owner user, never the lost one.
    const ownerUser =
      nonEmpty(i.selfUserId) &&
      nonEmpty(l.user_id) &&
      i.selfUserId === l.user_id &&
      nonEmpty(i.selfDeviceId) &&
      nonEmpty(l.device_id) &&
      i.selfDeviceId !== l.device_id;
    return finish(
      "owner_device_lost",
      since,
      now,
      ownerUser ? "recover_ownership" : null,
    );
  }

  if (i.welcomeRetriesExhausted === true) {
    return finish("waiting_for_member", since, now, null);
  }
  if (!n) return finish("other", since, now, null);

  if (n.state === "poisoned" || n.verdict === "poisoned") {
    // The bridge's own successor rule: this device signed the current list.
    const l = n.seat_list;
    const signer =
      nonEmpty(i.selfUserId) &&
      nonEmpty(i.selfDeviceId) &&
      l?.signer_user_id === i.selfUserId &&
      l?.signer_device_id === i.selfDeviceId;
    return signer
      ? finish("poisoned_owner", since, now, "recreate")
      : finish("poisoned_member", since, now, null);
  }

  if (g) {
    const users: unknown = g.pending_removals;
    const devices: unknown = g.pending_device_removals;
    // Malformed lists: no cause is inferred from them.
    if (
      !Array.isArray(users) ||
      (devices !== undefined && !Array.isArray(devices))
    ) {
      return finish("other", since, now, null);
    }
    if (users.length > 0 || (Array.isArray(devices) && devices.length > 0)) {
      return finish("pending_removal", since, now, "retry_removal");
    }
  }

  const holding = n.state === "active" && n.group_id !== null;
  const superseded = n.state === "active" && n.verdict === "no_group";
  const behind =
    holding &&
    g !== null &&
    // `!(a >= b)` so a null or NaN epoch counts as behind (shield step 7).
    (n.group_id !== g.group_id ||
      !((n.epoch ?? Number.NaN) >= g.current_epoch));
  if (
    superseded ||
    behind ||
    (holding &&
      i.groupError !== null &&
      STALE_GROUP_ERRORS.includes(i.groupError))
  ) {
    return finish("stale_group", since, now, "rejoin");
  }

  return finish("other", since, now, null);
}

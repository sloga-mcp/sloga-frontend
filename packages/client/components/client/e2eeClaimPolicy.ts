/**
 * What a refused device claim means, and what the bridge does next
 * (multi-device plan D4/D5/D8). Pure, so `node --test` covers it.
 *
 * Bonfire refuses a claim with `reason: "held_elsewhere"` while another live
 * session holds the device's claim lock, and with `reason: "removed"` for a
 * tombstoned device. Any other value (or none) is a claim refused for an old
 * reason, which keeps the pre-multi-device handling.
 */

/** Bonfire's claim lock TTL: `IDLE_TIMEOUT` (120 s) + 30 s. */
export const CLAIM_LOCK_TTL_MS = 150_000;

/**
 * One retry after a first `held_elsewhere`, timed past the lock TTL so a
 * lock left by a dead connection has expired by then.
 */
export const CLAIM_RETRY_DELAY_MS = 160_000;

export type ClaimRefusal = "held_elsewhere" | "removed" | null;

/** The refusal reasons this client acts on; anything else is absent. */
export function claimRefusal(reason: unknown): ClaimRefusal {
  return reason === "held_elsewhere" || reason === "removed" ? reason : null;
}

/**
 * The step for a `held_elsewhere` refusal, given the strike count on this
 * connection AFTER counting it and, when known, the instant of the first
 * refusal for this device across connections and reloads: the first
 * schedules one retry; a second on this connection, or any refusal at
 * least a lock TTL after that first one, says the device is shared and
 * stops retrying.
 */
export function heldElsewhereStep(
  strikes: number,
  firstAt: number | null = null,
  now: number = Date.now(),
): "retry" | "shared" {
  if (strikes >= 2) return "shared";
  if (firstAt !== null && now - firstAt >= CLAIM_LOCK_TTL_MS) return "shared";
  return "retry";
}

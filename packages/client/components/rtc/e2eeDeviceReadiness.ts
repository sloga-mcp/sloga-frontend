/**
 * WHY this install can or cannot encrypt calls — the reason behind the single
 * `e2eeCapable` boolean `connect()` computes, plus the one server refusal that
 * proves the reason from the outside.
 *
 * WHY THIS EXISTS. `e2eeCapable` is an AND of six terms and everything
 * downstream reads only the boolean. False means "not an E2EE call": no
 * session, no publish gate, plaintext publications — and, in a channel that
 * HAS an open MLS group, a red NOT-ENCRYPTED chip with no banner and nothing
 * to press (`chipState`'s no-session branches; `isTerminalLoud` needs a
 * latched error, and with no session nothing latches). That is honest for a
 * browser, which can never encrypt. It is NOT honest for a desktop install
 * that simply has no encryption set up on it: the same red, with a remedy the
 * user is never offered. Recorded live 2026-09-08 (rejoin-beat plan §7.4/§8 —
 * a device whose account owner changed, red chip, no banner, NONE-declared
 * publications).
 *
 * Splitting the boolean into a REASON costs nothing at the call site (`ready`
 * is still the only value that builds a session) and lets the call chrome say
 * which of the three states it is in.
 *
 * PURE: no I/O, no Room, no Client — `node --test` loads it directly.
 */

import {
  type E2EEStatusSnapshot,
  e2eeProvenOff,
} from "./mlsSessionSetupPolicy.ts";

/**
 * Why this install is (or is not) able to encrypt calls.
 *
 * - `ready` — attempt encryption (the only value that builds a session).
 * - `needs_setup` — the shell CAN encrypt, but E2EE has never been set up on
 *   this install, or it was wiped. A fresh desktop install reads this: the
 *   store is unprovisioned until the user enrols or restores, so calls are
 *   plaintext by default and nothing says so.
 * - `owned_elsewhere` — the shell CAN encrypt and this install IS provisioned,
 *   but the server will not accept the device it holds for the signed-in
 *   account. Sign-out does not wipe the E2EE store (`account` has no owner
 *   column; `mls_signature_key` is a single row bound to whoever enrolled it),
 *   so signing in as a second account lands here — but so does a device of
 *   YOUR OWN account that was hard-revoked, and the client cannot tell those
 *   apart, which is why the copy for it names neither. Still CAPABLE: see
 *   `callEncryptionCapable`. Remedy is a reset — see `e2eeStoreOwner`.
 * - `unsupported` — this shell can never encrypt calls (a browser, an
 *   unaudited Electron build, a shell with no native key-push channel). There
 *   is nothing for the user to set up.
 */
export type CallEncryptionReadiness =
  | "ready"
  | "needs_setup"
  | "owned_elsewhere"
  | "unsupported";

export interface CallEncryptionReadinessInput {
  /**
   * Every PLATFORM term of `e2eeCapable`: insertable streams, the native E2EE
   * layer, the native key-push channel, an audited media-E2EE platform, and
   * "Encrypt my calls". True means "this shell could encrypt calls if this
   * install were set up for it".
   */
  shellSupported: boolean;
  /**
   * The E2EE bridge's status snapshot. Read only through `e2eeProvenOff`, so
   * an UNRESOLVED snapshot keeps the shell `ready` (fail-closed, R2-4: an
   * unloaded status cannot be told from an enrolled device, and the
   * session-setup decision holds the gate loud rather than let plaintext out).
   */
  status: E2EEStatusSnapshot | undefined | null;
  /**
   * This install's E2EE device is not usable for the signed-in account. EITHER
   * durable bridge verdict raises it: the SERVER-derived one (a rejected
   * device claim whose directory row is absent) or the LOCAL one (the native
   * store-owner accessor finding `mls_signature_key.user_id` names someone
   * else). They are separate flags, cleared by separate evidence, and this
   * rule does not care which — the consequence is the same.
   */
  deviceOwnedElsewhere: boolean;
}

/**
 * The reason. `owned_elsewhere` outranks `needs_setup`: both are "not set up
 * for you here", but only the first has a store to clear, and telling a user
 * to "set up encryption" when the blocker is another account's store sends
 * them into an enable flow that cannot succeed.
 */
export function callEncryptionReadiness(
  input: CallEncryptionReadinessInput,
): CallEncryptionReadiness {
  if (!input.shellSupported) return "unsupported";
  if (input.deviceOwnedElsewhere) return "owned_elsewhere";
  if (e2eeProvenOff(input.status)) return "needs_setup";
  return "ready";
}

/**
 * Whether the user could fix this from Settings on this device. False for
 * `unsupported` (nothing to set up) and `ready` (nothing wrong).
 *
 * Also the chip's `deviceNeedsSetup` term, which is what makes a device that
 * cannot encrypt say so WITHOUT waiting on the open-group probe — see
 * `chipState`.
 */
export function encryptionSetupAvailable(
  readiness: CallEncryptionReadiness,
): boolean {
  return readiness === "needs_setup" || readiness === "owned_elsewhere";
}

/**
 * The `e2eeCapable` boolean `connect()` still branches on.
 *
 * 🔴 `owned_elsewhere` IS CAPABLE. It is tempting to read "the server will not
 * accept this device" as "not an E2EE call" and take the quiet plaintext path,
 * and that is exactly the hole: a non-capable shell asserts no publish gate and
 * builds no session, and `chipState`'s no-session branches are gated on
 * `channelHasOpenGroup` — so a device alone in a channel with no open group
 * yet gets chip `none`, no banner, and publishes plaintext with NO chrome at
 * all. That is the 2026-09-08 "while it sat alone" shape, reproduced by the
 * fix meant to close it (media-e2ee-reviewer, F1 CRITICAL).
 *
 * The store here is PROVISIONED — the device exists, it simply is not this
 * account's — so this is a FAILURE, and failures stay capable: the R2-5
 * `negotiating` gate is asserted, `sessionSetupDecision` returns `hold_loud`,
 * the structured error latches, and the chip is red through `latchedError`
 * with no dependence on any server probe. The user's explicit "Stay
 * unencrypted" press is then the only thing that releases a frame.
 *
 * `needs_setup` is genuinely NOT capable and stays that way: a never-enrolled
 * install has no identity to attempt anything with, and holding every fresh
 * desktop's first call behind a consent press is a product change this rule
 * has no business making.
 */
export function callEncryptionCapable(
  readiness: CallEncryptionReadiness,
): boolean {
  return readiness === "ready" || readiness === "owned_elsewhere";
}

/**
 * delta's refusal when a device-qualified join names a device the signed-in
 * account does not own (`assert_device_bound_session` →
 * `fetch_e2ee_identity(user, device)` misses →
 * `FailedValidation { error }`, `routes/channels/voice_join.rs`).
 *
 * Matched on the exact pair, not the type alone: `FailedValidation` is a
 * TERMINAL join refusal (`joinRefusalPolicy`), so without this the whole
 * channel's join affordances go inert for 30 s behind "The call couldn't be
 * started right now" — an account switch on an enrolled desktop takes voice
 * away entirely, with nothing said about encryption. A backend that reworded
 * this string degrades to exactly that pre-existing behaviour; it never
 * degrades to joining unencrypted by accident.
 *
 * 🔴 THIS STRING IS NOT PROOF OF OWNERSHIP. The route builds it with
 * `.map_err(|_| …)` over `fetch_e2ee_identity`, which returns `NotFound` for a
 * missing row AND propagates any `DatabaseError` — so a Mongo failover answers
 * byte-identically to a genuine mismatch (media-e2ee-reviewer, F2 HIGH). The
 * caller must therefore treat a match as a fact about THIS CALL only: it may
 * drop the device-qualified identity and hold the call loud, and it must NOT
 * write anything durable. The durable verdict needs the corroboration
 * `#onClaimResult` has (a rejected claim plus an absent device directory row),
 * and properly needs the owed native `e2ee_store_owner` accessor.
 */
const DEVICE_NOT_REGISTERED = "joining device is not registered";

export function isDeviceNotRegisteredRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const body = error as { type?: unknown; error?: unknown };
  return (
    body.type === "FailedValidation" && body.error === DEVICE_NOT_REGISTERED
  );
}

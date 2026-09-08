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
 *   but the device it holds does not belong to the signed-in account. Sign-out
 *   does not wipe the E2EE store (`account` has no owner column;
 *   `mls_signature_key` is a single row bound to whoever enrolled it), so
 *   signing in as a second account lands here. Same remedy as `needs_setup`
 *   plus a reset — see `e2eeStoreOwner`.
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
   * This install's E2EE device is not registered to the signed-in account —
   * the durable bridge flag raised by a rejected device claim whose server row
   * is absent, or by delta refusing a device-qualified call join.
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

/** The `e2eeCapable` boolean `connect()` still branches on. */
export function callEncryptionCapable(
  readiness: CallEncryptionReadiness,
): boolean {
  return readiness === "ready";
}

/**
 * Whether the user could fix this from settings on this device. False for
 * `unsupported` (nothing to set up) and for `ready` (nothing wrong).
 */
export function encryptionSetupAvailable(
  readiness: CallEncryptionReadiness,
): boolean {
  return readiness === "needs_setup" || readiness === "owned_elsewhere";
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
 */
const DEVICE_NOT_REGISTERED = "joining device is not registered";

export function isDeviceNotRegisteredRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const body = error as { type?: unknown; error?: unknown };
  return (
    body.type === "FailedValidation" && body.error === DEVICE_NOT_REGISTERED
  );
}

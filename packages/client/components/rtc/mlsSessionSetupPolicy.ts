/**
 * The connect-time decision for an E2EE-capable shell once the SFU has
 * answered: build the MLS call session, or — when the session CANNOT be
 * built — hold the `negotiating` publish gate and go loud.
 *
 * Split out of `state.tsx` for the same reason every other rule here is
 * (`mlsNegotiatingFailsafe`, `mlsCallModePolicy`, `mlsAdmitPolicy`): the
 * Voice class cannot be imported under `node --test`, and a rule with no
 * test is a rule nobody can control.
 *
 * 2026-09-06, user decision — the same rule that withdrew the T0d
 * availability escape: the publish gate is NEVER released to plaintext
 * without a Delivery-Service verdict. R2-4 was the one sibling path that
 * still released it. A capable shell whose session failed to construct — no
 * E2EE identity on the bridge, an unknown signed-in user, the SFU minting an
 * identity other than `{user_id}:{device_id}`, the key provider gone, the
 * native key-change listener never registering — `delete`d `negotiating`
 * and published plaintext under a chip that read nothing unless the
 * open-group probe happened to say `open`. In the identity-mismatch case the
 * chip was red and the banner promised "your audio and video stay paused"
 * while the gate was already released underneath it.
 *
 * Every capable-but-sessionless arm is now one outcome: keep the gate the
 * R2-5 pre-connect assertion put there, latch the structured error so the
 * existing loud state renders (the NOT-ENCRYPTED chip and the Leave / Stay
 * banner through `isTerminalLoud`), and let the user's explicit "Stay
 * unencrypted" press be the only path to plaintext
 * (`canConfirmNoSessionPlaintext`). Construction itself is synchronous, so
 * no new wait is needed; the one asynchronous setup step — registering the
 * native keys-changed listener — is bounded by the transport's 45 s
 * per-request deadline before this decision runs, so it always arrives here
 * as an input.
 *
 * A NON-capable shell (web without a bridge, a plain browser, "Encrypt my
 * calls" off, E2EE proven off on this device, a worker that failed to
 * construct) is not an E2EE call: no gate was ever asserted for it and none
 * is asserted here — `"plain"` is the only verdict such a shell can get.
 * "Proven off" is `e2eeProvenOff` below — a LOADED snapshot that says so,
 * never an unresolved one.
 */

/**
 * The part of the bridge's status snapshot the capability rule reads.
 * Structural on purpose: the bridge class cannot be imported under
 * `node --test`, and only `enabled` decides anything here.
 */
export interface E2EEStatusSnapshot {
  enabled: boolean;
}

/**
 * Whether E2EE is PROVEN off on this device — with "Encrypt my calls" off,
 * the one device-level fact that removes a shell from the E2EE-capable set.
 *
 * True ONLY for a LOADED snapshot that says `enabled: false`. The bridge
 * writes that value only from the side-effect-free filesystem check — at
 * boot for a never-provisioned device (`#onReady`, or the boot-race history
 * fetch's `#ensureBootStatus` when it resolves first) and after a wipe
 * (`#setDisabledStatus`) — so a fresh device and a wiped device read the
 * same. No runtime fault yields it: a provisioned store that fails to
 * open THROWS and leaves the snapshot untouched, so `false` is an honest
 * "never set up here" — no identity, no session, a plain call the peers
 * attribute to us.
 *
 * `undefined` (the boot status never resolved, or it threw) is NOT proven
 * off: it cannot be told from an enrolled device, so the shell stays capable
 * and `sessionSetupDecision` holds the gate loud (R2-4, fail-closed). A
 * snapshot with `enabled: true` is plainly not off. Before this rule the
 * predicate read the raw field, and a fresh desktop — whose snapshot was
 * never written at all — came out capable with no identity: a loud hold on
 * every call (R2-4 review MAJOR-1).
 */
export function e2eeProvenOff(
  snapshot: E2EEStatusSnapshot | undefined | null,
): boolean {
  return snapshot?.enabled === false;
}

export interface SessionSetupInput {
  /**
   * The connect-time capability snapshot: `isE2EESupported()` + the native
   * layer + the key-push channel + the shell's media-E2EE flag + "Encrypt my
   * calls" + E2EE not proven off on this device. The one term that decides
   * whether a gate exists at all.
   */
  e2eeCapable: boolean;
  /** The E2EE bridge is present (the predicate required it, re-checked). */
  bridge: boolean;
  /** The `MlsKeyProvider` constructed alongside the Room is still held. */
  keyProvider: boolean;
  /** The signed-in user's id is known. */
  userId: boolean;
  /** The bridge status names a provisioned E2EE device id. */
  deviceId: boolean;
  /**
   * The SFU minted exactly `{user_id}:{device_id}`. `false` for a mismatch
   * (the caller latches that error before asking) and also `false` when the
   * assertion never ran because `userId` / `deviceId` were missing.
   */
  identityOk: boolean;
  /** The native `e2ee:call-keys-changed` listener registered in time. */
  keysListenerBound: boolean;
  /**
   * The server will not accept this install's E2EE device for the signed-in
   * account (`e2eeDeviceReadiness` = `owned_elsewhere`). Capable, provisioned,
   * and refused — so it is a HOLD, never a `plain`.
   *
   * REQUIRED, like every other term here: an optional safety input defaults to
   * "no hold" when a caller forgets it, and the compiler is the right place to
   * enforce a decision of this shape.
   */
  deviceOwnedElsewhere: boolean;
}

export type SessionSetupDecision =
  /** Not an E2EE call: no gate was asserted, nothing to hold. */
  | { action: "plain" }
  /** Build + start the session; it owns the `negotiating` reason from here. */
  | { action: "session" }
  /**
   * Capable, but no session can exist: keep `negotiating` held and latch
   * `reason` as the call-encryption error so the loud state renders.
   */
  | { action: "hold_loud"; reason: string };

const HOLD_PREFIX = "This call could not be encrypted: ";

/**
 * What connect() does after the SFU answered, for the shell it snapshotted.
 *
 * The reason strings name the missing precondition for the console and the
 * structured error. None of them suggests resetting or wiping this device's
 * encryption: every one of these is a call-level fault (or a transient), and
 * the one device-level fault that has a remedy — the store-owner mismatch —
 * is detected by the session's establish and rendered by the banner from its
 * own typed error.
 */
export function sessionSetupDecision(
  input: SessionSetupInput,
): SessionSetupDecision {
  if (!input.e2eeCapable) return { action: "plain" };
  // Checked before the missing-device-id arm below, which it would otherwise
  // fall into with an unrelated reason: the caller deliberately withholds the
  // device id once the server has refused it, so "not available yet" would be
  // both wrong and unactionable. This is the account-switch / revoked-device
  // hold. 🔴 The banner does NOT offer a reset for it — the verdict is
  // assembled from server answers, and a destructive control may not be
  // summoned by those; it routes to Settings → Encryption instead. Reset stays
  // on the NATIVE `MlsStoreOwnedByAnotherAccount`, which read the store's row.
  if (input.deviceOwnedElsewhere) {
    return {
      action: "hold_loud",
      reason: `${HOLD_PREFIX}this device's encryption is not registered to the account you are signed in as`,
    };
  }
  if (!input.bridge) {
    return {
      action: "hold_loud",
      reason: `${HOLD_PREFIX}the E2EE bridge is unavailable`,
    };
  }
  if (!input.keyProvider) {
    return {
      action: "hold_loud",
      reason: `${HOLD_PREFIX}the call key provider is unavailable`,
    };
  }
  if (!input.userId) {
    return {
      action: "hold_loud",
      reason: `${HOLD_PREFIX}the signed-in user is not known yet`,
    };
  }
  if (!input.deviceId) {
    return {
      action: "hold_loud",
      reason: `${HOLD_PREFIX}this device's E2EE identity is not available yet`,
    };
  }
  if (!input.keysListenerBound) {
    return {
      action: "hold_loud",
      reason: `${HOLD_PREFIX}the native key-change listener did not register`,
    };
  }
  if (!input.identityOk) {
    return {
      action: "hold_loud",
      reason: `${HOLD_PREFIX}the call server minted an identity that does not name this device`,
    };
  }
  return { action: "session" };
}

export interface NoSessionConfirmInput {
  /** An MLS session exists — its own `confirmPlaintext` owns the escape. */
  hasSession: boolean;
  /** The call's connect-time capability snapshot (`callE2EECapable`). */
  e2eeCapable: boolean;
  /** A call-encryption error is latched (the hold above did it). */
  latchedError: boolean;
  /** The `negotiating` reason is still in the publish gate. */
  gateHeld: boolean;
}

/**
 * Whether the banner's "Stay unencrypted" may release the `negotiating` gate
 * WITHOUT a session — the escape for the hold above.
 *
 * All four terms are required: a session present means the session's
 * native-confirmed path runs instead; a non-capable call never had a gate; no
 * latched error means no hold is showing (nothing offered the button); and a
 * gate already empty has nothing to release. The native roster dialog the
 * session path shows cannot run here — it computes its non-enrolled set from
 * a group, and no group exists — so the press itself is the consent. That
 * weakens nothing the dialog protects: the dialog's teeth are the native
 * announce gate and the roster it renders, both group-level; with no group
 * there is nothing to announce and nobody to mis-render, and the publish
 * gate was always this webview's own `Set`.
 */
export function canConfirmNoSessionPlaintext(
  input: NoSessionConfirmInput,
): boolean {
  return (
    !input.hasSession &&
    input.e2eeCapable &&
    input.latchedError &&
    input.gateHeld
  );
}

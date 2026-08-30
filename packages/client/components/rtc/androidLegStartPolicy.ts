/**
 * Pure decisions for the Android screen-leg START path (screen-leg plan §7.2).
 *
 * Split out of `state.tsx` for the same reason as `mlsRosterPolicy` and
 * `mlsCallModePolicy`: the interesting cases here are races around two
 * USER-PACED dialogs (the tier sheet and the OS consent prompt), and they are
 * untestable while the decision lives inside a class that needs a live Room, a
 * client and a native bridge to construct.
 *
 * The rule both functions serve: a start attempt owns the leg only until
 * something else claims it. Until `connect()` resolves the leg is not
 * `active()`, so the §7.4 stop hooks cannot see it — which is precisely why
 * the attempt has to keep checking whether it is still the current one.
 */

/** A leg send key with its full provenance — §5.2's `LocalScreenKey`. */
export interface LegSendKey {
  keyB64: string;
  keyIndex: number;
  /** The MLS epoch the key belongs to — the native push fence. */
  epoch: number;
  /** The MLS group the key belongs to. Epochs are only comparable within one
   * group, so a group change makes two keys UNRELATABLE, not merely stale. */
  groupId: string;
}

export interface StartAttemptWorld {
  /** Generation this attempt claimed when it began. */
  generation: number;
  /** Generation now — bumped by every stop hook and every competing start. */
  currentGeneration: number;
  /** Whether the call room differs from the one the attempt started in. */
  roomChanged: boolean;
  /** Publish-gate reasons currently held; publishing flows only at zero. */
  publishGateSize: number;
}

/**
 * Was this attempt CANCELLED — did something else claim the leg?
 *
 * A stop hook, a competing tap, or leaving/switching the call. This is the
 * subset of staleness that means "somebody asked for this share to end", and
 * it is what decides whether a failure is worth REPORTING: a cancelled
 * attempt's rejection is the expected consequence of the cancellation, so
 * toasting it would show an error for a stop the user asked for.
 */
export function startAttemptCancelled(world: StartAttemptWorld): boolean {
  return world.generation !== world.currentGeneration || world.roomChanged;
}

/**
 * Has the world moved out from under this start attempt?
 *
 * TRUE means abandon — and, once `connect()` has resolved, TEAR DOWN rather
 * than merely return: past that point the OS is capturing and the leg is
 * publishing, so "give up quietly" is how a share outlives its own call.
 *
 * A held publish gate makes an attempt stale WITHOUT making it cancelled:
 * the leg must stop either way (§0.4), but nobody asked for this share to
 * end, so a genuine failure racing a transient gate pulse still deserves its
 * error message.
 */
export function startAttemptStale(world: StartAttemptWorld): boolean {
  return startAttemptCancelled(world) || world.publishGateSize > 0;
}

/** What `#syncLegKeyAfterConnect` must do once `connect()` resolves. */
export type PostConnectKeyAction =
  | { kind: "none" }
  | { kind: "push"; key: LegSendKey }
  | { kind: "stop" };

/**
 * Reconcile the key the leg connected with against the provider's current
 * record, immediately after `connect()` resolves.
 *
 * A rotation that lands while `connect()` is in flight reaches
 * `onLocalScreenKey` when the leg is not yet `active()`, and is dropped there.
 * The provider's `lastLocalScreenKey` is the authoritative record of "what key
 * should the leg be using now", so the attempt reconciles against it once the
 * sender exists.
 *
 * Compares the MATERIAL as well as the index: an index is only unique within
 * an epoch, so two epochs can legitimately reuse one and comparing indices
 * alone would silently skip a required rotation.
 *
 * A current key from a DIFFERENT group is a `stop`, not a push: the group was
 * re-established while the leg connected, epochs across groups are
 * uncomparable (so the native push fence cannot order the two keys), and a
 * leg keyed under a superseded group has no place in the new one.
 */
export function keyActionAfterConnect(
  connectedWith: LegSendKey | undefined,
  current: LegSendKey | undefined,
): PostConnectKeyAction {
  // A plaintext leg has no send key and must not acquire one here: handing it
  // a key would be a silent, unannounced upgrade the rest of the call has not
  // agreed to.
  if (!connectedWith) return { kind: "none" };
  // No current key means the provider has nothing better to offer; the
  // rotation listener owns the fail-closed path if one arrives later.
  if (!current) return { kind: "none" };
  if (current.groupId !== connectedWith.groupId) return { kind: "stop" };
  if (
    current.epoch === connectedWith.epoch &&
    current.keyIndex === connectedWith.keyIndex &&
    current.keyB64 === connectedWith.keyB64
  )
    return { kind: "none" };
  return { kind: "push", key: current };
}

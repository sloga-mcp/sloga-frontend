/**
 * The encryption chip's INPUT ASSEMBLY — the derivation that used to sit
 * inline in `state.tsx` between reading its signals and calling `chipState`.
 *
 * 🔴 Why this module exists, and it is not tidiness. Three consecutive
 * `media-e2ee-reviewer` rounds found the SAME defect one line further down the
 * object literal this replaces:
 *
 *   round 3  the witness signal's initial value could be flipped to available
 *   round 4  ...and when that was pinned, the chip's READ of the signal could
 *            be replaced by an available literal instead
 *   round 5  ...and when that was pinned, EIGHT more one-line edits in the
 *            same literal each turned an honest amber or red into green
 *
 * Round 5 drove the real `chipState` for each and measured them. The worst is
 * `rosterVerified: []` — `[].every(v => v)` is `true`, so emptying that one
 * read promotes `e2ee_unverified` to `e2ee`, manufacturing a VERIFIED lock
 * over unverified participants. Every one of those edits kept the whole suite
 * green, because `state.tsx` imports Solid, LiveKit and the Tauri bridge, so
 * `node --test` cannot load it: no spec, and no mutation, has ever reached it.
 *
 * The gate answered each round with another source-text assertion, and round 5
 * defeated all of them at once by commenting the required line out and putting
 * the fake one underneath. That is why this is a module and not a seventh
 * grep: source text cannot see a dead guard, and enumerating instances of an
 * unbounded class is not converging.
 *
 * 🔴 What this does NOT close, stated plainly so nobody reads more into it.
 * `state.tsx` still binds the accessors, and a lying binding — `rosterVerified:
 * () => []` — is still unreachable by any spec. What changes is the size of
 * that surface: it goes from 45 lines of derivation plus 14 fakeable fields
 * down to 14 one-line bindings with nothing computed among them, and taking
 * accessors rather than values means faking one means writing a function
 * instead of typing a literal. The derivation itself — the screen-leg
 * exclusion, the FE-2 publication filter, the observed map, the local
 * declaration, the resecuring disjunction — is now spec'd and mutated here.
 */

import {
  isScreenLeg,
  stripLeg,
} from "../ui/components/features/voice/participantIdentity.ts";
import {
  type LocalPublicationEncryption,
  localPublicationsEncrypted,
} from "./localPublicationEncryption.ts";
import {
  type CallMode,
  type ChipInputs,
  type ChipState,
  type DecodeWitness,
  chipState,
} from "./mlsCallModePolicy.ts";

/**
 * The session lifecycle states the chip distinguishes. Taken from `ChipInputs`
 * rather than imported from `mlsCallSession`, which `node --test` cannot load.
 */
export type ChipSessionState = ChipInputs["sessionState"];

/** One SFU participant, reduced to what the assembly actually reads. */
export interface ChipParticipant {
  identity: string;
  /**
   * `participant.trackPublications.size`. FE-2: only participants with at
   * least one published track ever report a LiveKit encryption status;
   * trackless listeners are covered by MLS membership, not gate (b).
   */
  publicationCount: number;
}

/** The SFU room, reduced to what the assembly actually reads. */
export interface ChipRoom {
  /** `room.localParticipant.identity`, for the own-screen-leg comparison. */
  localIdentity: string;
  /** The local participant FIRST, then the remotes — the walk order matters. */
  participants: readonly ChipParticipant[];
  /** Our own publications, as the SFU has them on record. */
  localPublications: readonly LocalPublicationEncryption[];
}

/**
 * Everything the chip reads, as ACCESSORS.
 *
 * 🔴 Accessors, not values, and not for laziness — every one is called exactly
 * once per assembly. It is so that the binding in `state.tsx` is a function
 * per field with nothing computed in it, and so that every Solid signal read
 * still happens inside the caller's tracking scope, exactly where it did when
 * this was inline.
 */
export interface ChipSources {
  /** No session at all (non-capable shell / never constructed). */
  hasSession: () => boolean;
  sessionState: () => ChipSessionState;
  mode: () => CallMode | undefined;
  /** The media-plane hold (rotation-window debounce). */
  mediaHold: () => boolean;
  /** A structured call-encryption error is latched. */
  latchedError: () => boolean;
  /** Every verified MLS roster member's `user_verified` flag. */
  rosterVerified: () => readonly boolean[];
  channelHasOpenGroup: () => boolean;
  capableAndEnabled: () => boolean;
  decodeWitness: () => DecodeWitness;
  /** The SFU room snapshot, or undefined when there is no room. */
  room: () => ChipRoom | undefined;
  /** LiveKit's observed encryption status for one identity, if it has one. */
  observedEncryption: (identity: string) => boolean | undefined;
}

/**
 * The SFU participants that gate (b) may judge.
 *
 * Two exclusions, both load-bearing:
 *
 * - 🔴 OUR OWN screen leg (plan §6.7). This device minted the leg's key and
 *   does not subscribe to it (§0.9), so LiveKit never reports an encryption
 *   status for it — leaving it here with nothing in the observed map reads as
 *   "a publisher we cannot vouch for" and pins the sharer's own phone at amber
 *   for the whole share. Compared by DEVICE, not user: another of our devices'
 *   legs is a genuine remote publisher that we DO observe.
 * - FE-2: participants with no published track never report a status at all.
 */
export function publishingIdentities(room: ChipRoom | undefined): string[] {
  if (!room) return [];
  const publishing: string[] = [];
  for (const participant of room.participants) {
    if (
      isScreenLeg(participant.identity) &&
      stripLeg(participant.identity) === room.localIdentity
    ) {
      continue;
    }
    if (participant.publicationCount > 0) publishing.push(participant.identity);
  }
  return publishing;
}

/**
 * LiveKit's observed encryption status, for the publishers gate (b) judges.
 *
 * 🔴 An identity with NO observed status is left OUT of the map rather than
 * entered as `false` or as `true`. `chipState` reads a publisher missing from
 * this map as one it cannot vouch for, which is the fail-closed reading;
 * defaulting it either way would either manufacture a green or a red out of an
 * absence.
 */
export function observedEncryptionMap(
  publishing: readonly string[],
  observedEncryption: (identity: string) => boolean | undefined,
): Map<string, boolean> {
  const observed = new Map<string, boolean>();
  for (const identity of publishing) {
    const status = observedEncryption(identity);
    if (status !== undefined) observed.set(identity, status);
  }
  return observed;
}

/**
 * Assemble the chip's inputs AND judge them.
 *
 * 🔴 This exists so `state.tsx` never holds a `ChipInputs` value. For exactly
 * one commit it did, and the gate asserted that the assembly was CALLED while
 * asserting nothing about what happened to the result. So this:
 *
 *     return chipState({
 *       ...chipInputsFrom({ ...every binding honest... }),
 *       decodeWitness: { available: true, dropping: [], live: [] },
 *       rosterVerified: [],
 *     });
 *
 * type-checked, formatted, passed all seven source-text assertions and every
 * mutation — a green VERIFIED lock with gate (d) satisfied by a literal. The
 * seam was created by the refactor meant to remove this class of hole, which
 * is the fifth time on this branch that a fix moved the defect one line down.
 * There is no intermediate value left to intercept.
 */
export function chipStateFrom(sources: ChipSources): ChipState {
  return chipState(chipInputsFrom(sources));
}

/** Assemble the chip's inputs. Every accessor is called exactly once. */
export function chipInputsFrom(sources: ChipSources): ChipInputs {
  const room = sources.room();
  const mode = sources.mode();
  const sessionState = sources.sessionState();
  const publishing = publishingIdentities(room);
  return {
    hasSession: sources.hasSession(),
    sessionState,
    mode,
    e2eeEnabled: mode?.kind === "e2ee",
    hasLocalKey: mode?.kind === "e2ee",
    // Short-circuits exactly as the inline version did: when the session is
    // already resecuring the hold is not read. The memo re-runs when the
    // session state changes, so the dependency is picked up then.
    resecuring: sessionState === "resecuring" || sources.mediaHold(),
    latchedError: sources.latchedError(),
    publishingIdentities: publishing,
    // Called THROUGH `sources`, not passed as a bare property value: every
    // other accessor is invoked as `sources.foo()`, and handing this one over
    // detached silently loses `this` for any implementation that is not an
    // arrow function.
    observedEncrypted: observedEncryptionMap(publishing, (identity) =>
      sources.observedEncryption(identity),
    ),
    // 🔴 The worker's "encrypted" status for OUR identity says the cryptor is
    // on, not what the SFU was told; the declaration receivers arm from is
    // `trackInfo.encryption` on our own publications. Vacuously true with no
    // room, because we are publishing nothing.
    localPublicationsEncrypted: room
      ? localPublicationsEncrypted(room.localPublications)
      : true,
    rosterVerified: sources.rosterVerified(),
    channelHasOpenGroup: sources.channelHasOpenGroup(),
    capableAndEnabled: sources.capableAndEnabled(),
    decodeWitness: sources.decodeWitness(),
  };
}

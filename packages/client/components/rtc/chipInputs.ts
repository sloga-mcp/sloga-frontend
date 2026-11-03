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
  ENCRYPTION_TYPE_GCM,
  localPublicationsEncrypted,
} from "./localPublicationEncryption.ts";
import {
  type CallMode,
  type ChipInputs,
  type ChipLatch,
  type ChipState,
  type DecodeWitness,
  chipState,
} from "./mlsCallModePolicy.ts";
import { isShareSource } from "./screenShareWatchPolicy.ts";

/**
 * The session lifecycle states the chip distinguishes. Taken from `ChipInputs`
 * rather than imported from `mlsCallSession`, which `node --test` cannot load.
 */
export type ChipSessionState = ChipInputs["sessionState"];

/**
 * One REMOTE publication, reduced to what the share-only contradiction reads
 * (see {@link shareOnlyDeclarationContradicts}).
 */
export interface ChipPublication {
  /** The LiveKit `Track.Source` string value. */
  source: string;
  /** `RemoteTrackPublication.isDesired`: we asked the SFU for it. */
  desired: boolean;
  /** `RemoteTrackPublication.isSubscribed`: its track is attached here. */
  subscribed: boolean;
  /**
   * `publication.trackInfo?.encryption`, the publisher's declaration as the
   * SFU relayed it. `undefined` when the field is missing.
   */
  encryption: number | undefined;
}

/**
 * A remote participant's publications, reduced to {@link ChipPublication}s.
 * `state.tsx` passes `participant.trackPublications.values()`.
 *
 * 🔴 This mapping used to sit inline in `state.tsx`, which `node --test`
 * cannot load. There, changing one token (`desired: true`, or dropping
 * `subscribed`) switched the F2 share-only contradiction off for every
 * participant and left every gate green. Keep it here, where specs and
 * mutations can reach it.
 *
 * Structural on purpose: no LiveKit import. `Track.Source` is a string enum,
 * so it is accepted as a string. `isDesired` and `isSubscribed` are getters
 * on `RemoteTrackPublication`, so each publication is read field by field;
 * spreading it would drop them. A missing `trackInfo`, or a `trackInfo`
 * without `encryption`, stays `undefined`, never a default: F2 compares with
 * exactly GCM, and a defaulted GCM would wave a dropped declaration through.
 */
export function chipPublicationsOf(
  pubs: Iterable<{
    source: string;
    isDesired: boolean;
    isSubscribed: boolean;
    trackInfo?: { encryption?: number };
  }>,
): ChipPublication[] {
  return Array.from(pubs, (pub) => ({
    source: pub.source,
    desired: pub.isDesired,
    subscribed: pub.isSubscribed,
    encryption: pub.trackInfo?.encryption,
  }));
}

/** One SFU participant, reduced to what the assembly actually reads. */
export interface ChipParticipant {
  identity: string;
  /**
   * `participant.trackPublications.size`. FE-2: only participants with at
   * least one published track ever report a LiveKit encryption status;
   * trackless listeners are covered by MLS membership, not gate (b).
   */
  publicationCount: number;
  /**
   * A REMOTE participant's publications, for the share-only contradiction.
   * Omitted for the local participant, whose declaration is judged through
   * `ChipRoom.localPublications` instead. Omitted or empty means the
   * contradiction never applies: the reading falls back to the observed
   * status alone, never to anything greener. Optional so the MLS session
   * harness, which models one generic publication per participant, keeps
   * building rooms without it.
   */
  publications?: readonly ChipPublication[];
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
  /**
   * The latched call-encryption error, reduced to what the chip judges, or
   * undefined when nothing is latched. `origin` is undefined for the two
   * direct `state.tsx` writers (identity mismatch, `hold_loud`), which carry
   * no session meta. `mediaKeyed` is the session's SEND-SIDE witness, taken
   * by `#latchLoud` at the latch instant: was this device holding a usable
   * frame key for the current epoch when the loud fired? It is the one fact
   * the mode cannot carry — under any latch the mode has already folded to
   * `negotiating`, so the mode-derived `e2eeEnabled`/`hasLocalKey` aliases
   * read false there regardless of what was keyed.
   */
  latch: () => ChipLatch | undefined;
  /** Every verified MLS roster member's `user_verified` flag. */
  rosterVerified: () => readonly boolean[];
  channelHasOpenGroup: () => boolean;
  /**
   * This device could encrypt calls and is not set up to — a LOCAL fact. See
   * `ChipInputs.deviceNeedsSetup`.
   */
  deviceNeedsSetup: () => boolean;
  /** Another participant is device-qualified — LIVE. See `ChipInputs`. */
  peerCouldEncrypt: () => boolean;
  decodeWitness: () => DecodeWitness;
  /**
   * The server's switch has encrypted calls paused for this shell for this
   * call. See `ChipInputs.pausedByServer`. Required: there is no default,
   * because "not paused" is the reassuring answer.
   */
  pausedByServer: () => boolean;
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
 *   does not subscribe to it (§0.9). Compared by DEVICE, not user: another
 *   of our devices' legs is a genuine remote publisher that we DO observe.
 *
 *   Media-e2ee final audit F7, and the reviewer's ruling on it. This
 *   exclusion was justified by two claims, and neither holds:
 *
 *   - "LiveKit never reports a status for the leg" is false. The pinned
 *     source (livekit-client 2.15.13 `src/e2ee/E2eeManager.ts` ~:221-236)
 *     sets a remote participant's status from `trackInfo.encryption !==
 *     NONE` on `TrackPublished` and on every `ConnectionStateChanged
 *     (Connected)`, subscribed or not, and the worker's `enable` reply emits
 *     it for any remote identity (~:173-180).
 *   - "No decode witness can vouch for it" is not a reason either. The
 *     witness never vouches for anyone; it can only contradict a green.
 *
 *   The ruling KEEPS the exclusion for now, for one reason only: removing it
 *   changes what the sharer's own phone shows. Before it goes, measure on a
 *   live Android leg whether this webview sees a status for its own leg
 *   within the admit grace. If it does, the leg is judged like any other
 *   publisher. If it does not, including it would hold that phone amber.
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
 *
 * 🔴 ONE-WAY share-only contradiction (media-e2ee final audit F2). After the
 * observed statuses are read, a publisher for which
 * {@link shareOnlyDeclarationContradicts} holds is entered as `false`,
 * whatever LiveKit observed and even when it observed nothing. It never
 * enters `true`, never deletes an entry, and never touches
 * `publishingIdentities`: it can only turn a green into a not-green.
 */
export function observedEncryptionMap(
  publishing: readonly string[],
  observedEncryption: (identity: string) => boolean | undefined,
  participants: readonly ChipParticipant[],
): Map<string, boolean> {
  const observed = new Map<string, boolean>();
  for (const identity of publishing) {
    const status = observedEncryption(identity);
    if (status !== undefined) observed.set(identity, status);
  }
  const judged = new Set(publishing);
  for (const participant of participants) {
    if (!judged.has(participant.identity)) continue;
    if (shareOnlyDeclarationContradicts(participant))
      observed.set(participant.identity, false);
  }
  return observed;
}

/**
 * Whether a remote participant's own declaration contradicts an "encrypted"
 * reading that nothing else on this device can check.
 *
 * LiveKit's observed status for a remote participant is
 * `trackInfo.encryption !== NONE` (livekit-client 2.15.13
 * `src/e2ee/E2eeManager.ts` ~:221-236), so a declaration that is missing, or
 * that is some value other than GCM, reads as encrypted. Before opt-in
 * shares every viewer subscribed every share, and the decode witness
 * (gate d) would catch plaintext frames behind such a declaration. A share
 * nobody here watches is never decoded here, so for a participant whose ONLY
 * publications are such shares nothing is left to contradict the lie: an
 * Android leg whose native cryptor failed but that declares a non-GCM value,
 * or an SFU that drops the field, would read green on every non-watching
 * viewer while the SFU receives plaintext.
 *
 * True when the participant has at least one publication, EVERY publication
 * is a share (video or its audio) that is neither desired nor subscribed,
 * and ANY of them is declared other than exactly GCM. The comparison is
 * `!== ENCRYPTION_TYPE_GCM`, never `=== NONE`: a missing field and an
 * unknown enum value both contradict.
 *
 * A mic, camera or any watched share returns false: that participant's
 * frames reach the decode witness, which remains the judge.
 */
export function shareOnlyDeclarationContradicts(
  participant: ChipParticipant,
): boolean {
  const publications = participant.publications ?? [];
  if (publications.length === 0) return false;
  const allUnwatchedShares = publications.every(
    (pub) => isShareSource(pub.source) && !pub.desired && !pub.subscribed,
  );
  if (!allUnwatchedShares) return false;
  return publications.some((pub) => pub.encryption !== ENCRYPTION_TYPE_GCM);
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
    // Mode ALIASES, not the session's own fields. Under any latch the mode has
    // folded to `negotiating` (`loudModeFallback`), so both read false there
    // whatever the session held; the send-side fact the chip needs under a
    // latch is `latch.mediaKeyed`, snapshotted by `#latchLoud` BEFORE that
    // fallback. Do not "repair" these by reading the session: that would put
    // a keyed read back over a plane that already failed.
    e2eeEnabled: mode?.kind === "e2ee",
    hasLocalKey: mode?.kind === "e2ee",
    // Short-circuits exactly as the inline version did: when the session is
    // already resecuring the hold is not read. The memo re-runs when the
    // session state changes, so the dependency is picked up then.
    resecuring: sessionState === "resecuring" || sources.mediaHold(),
    // Passed through whole. `chipState` reads origin and mediaKeyed together
    // (its order of record, rows 2–5); collapsing the latch to a boolean here
    // would make the split unreachable from any spec.
    latch: sources.latch(),
    publishingIdentities: publishing,
    // Called THROUGH `sources`, not passed as a bare property value: every
    // other accessor is invoked as `sources.foo()`, and handing this one over
    // detached silently loses `this` for any implementation that is not an
    // arrow function.
    observedEncrypted: observedEncryptionMap(
      publishing,
      (identity) => sources.observedEncryption(identity),
      room?.participants ?? [],
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
    deviceNeedsSetup: sources.deviceNeedsSetup(),
    peerCouldEncrypt: sources.peerCouldEncrypt(),
    decodeWitness: sources.decodeWitness(),
    pausedByServer: sources.pausedByServer(),
    // EVERY participant, trackless ones included: gate (d)'s time bound asks
    // whether a failing sender LEFT, and one that unpublished has not.
    presentIdentities: (room?.participants ?? []).map(
      (participant) => participant.identity,
    ),
  };
}

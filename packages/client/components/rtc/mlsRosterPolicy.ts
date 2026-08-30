/**
 * SFU∪MLS roster reconciliation — the PURE core of slice 6.4 step 5, extracted
 * from `mlsCallSession` so it is unit-testable in isolation (the house
 * no-vitest split; this module must stay dependency-free so `node --test` can
 * load it, same rule as `mlsCallModePolicy` / `mlsAdmitPolicy`).
 *
 * The extraction happened with the Android screen-leg rules (plan §5.3): they
 * are asymmetric, they fail in opposite directions, and they were the first
 * thing here worth pinning with a spec rather than reading carefully.
 */
import {
  isScreenLeg,
  stripLeg,
} from "../ui/components/features/voice/participantIdentity.ts";

/**
 * The two-directional SFU∪MLS roster divergence (plan §1.4/§3.4):
 *  - `nonEnrolled` — device-qualified identities in the SFU call but NOT in the
 *    MLS group. The **trusted downgrade-trigger enumeration** (§3.4): a live
 *    participant we cannot encrypt to ⇒ the call is mixed ⇒ loud state + pause
 *    (the client can only ever OVER-warn here, never suppress a real one). Also
 *    the load-bearing hostile-DS T-15 backstop (audit H2): a DS that steers us
 *    into another channel's group yields a roster inconsistent with THIS
 *    channel's SFU set, caught here before enable/publish.
 *  - `ghosts` — MLS leaves with NO SFU participant. Render from the MLS roster
 *    (crypto truth), flag divergence, and after a bounded timeout any member
 *    removes the ghost leaf.
 */
export interface RosterReconcileResult {
  nonEnrolled: string[];
  /**
   * Would-be non-enrolled identities still inside the caller's admit-grace
   * window (the join-direction mirror of the leave-grace): in the SFU, not yet
   * in the MLS group, and joined recently enough that the staggered Add is
   * plausibly still in flight. NOT a mix trigger — but also NOT consistent:
   * enable/resume must keep waiting for these to drain. When the caller's
   * window expires the identity moves to `nonEnrolled` and the loud path fires
   * as before, so a joiner that never admits still fails closed.
   */
  pending: string[];
  ghosts: string[];
}

/**
 * SCREEN-LEG inputs (Android screen-share plan §5.3). A leg
 * `{user}:{device}:screen` is a second SFU participant published natively by a
 * phone; it holds no MLS leaf, so without special handling every phone share
 * reads as a non-enrolled participant and drops the whole call to `mixed`.
 */
export interface RosterLegInputs {
  /**
   * Whether the call is in `e2ee` mode. Rule 2(b) is checked ONLY there: in a
   * confirmed-plaintext call every publication legitimately declares NONE, and
   * applying it would report a leg as non-enrolled in a call the user has
   * already agreed is unencrypted.
   */
  e2ee: boolean;
  /**
   * Leg identities where EVERY publication declares `trackInfo.encryption !==
   * NONE`. A leg absent from this set has at least one publication claiming
   * plaintext (or has not published at all yet), and is NOT folded onto its
   * owner.
   */
  encryptedLegs: readonly string[];
  /**
   * Leg identities with ZERO publications — the join→publish window. Such a
   * leg sends nothing (no frames exist to be plaintext) and receives nothing
   * (a leg's token is publish-only, `can_subscribe: false`), so within the
   * caller's admit-grace it reads as `pending` instead of non-enrolled when
   * its owner is present. Without this, the rule-2(b) over-warn in that
   * window fires `mixed`, and §0.4 turns the over-warn into a one-way stop
   * of the very leg that just connected — the share kills itself at birth
   * whenever a reconcile lands between the leg's SFU connect and its first
   * publication (measured live: ~1.6 s apart under emulator load).
   */
  unpublishedLegs?: readonly string[];
  /**
   * PRIMARY identities with at least one publication declaring
   * `encryption === NONE` — i.e. actually sending plaintext.
   *
   * What disqualifies a graced primary. The admit-grace covers a joiner whose
   * staggered Add is still in flight; it must not cover one that is already
   * putting readable media on the wire, because nothing else will catch that:
   * livekit-client DISABLES the cryptor for a publication declaring NONE, so
   * a plaintext sender raises no decrypt error and the media plane stays
   * silent. Before this, the grace was unconditional for primaries and the
   * check ran only when the window EXPIRED, so a plaintext client (a web
   * client — excluded from call E2EE by design) could join an encrypted call,
   * unmute, and have the mixed banner and the publish pause suppressed for
   * the whole 10-60 s while its audio played to the room.
   *
   * 🔴 This is deliberately NOT "has no publications". A publication object
   * existing does not mean media is flowing: the publish gate pauses UPSTREAM
   * (`pauseUpstream` is `replaceTrack(null)`), it never unpublishes, and a
   * client's mic publish is initiated in its `connected` handler — so a
   * perfectly ordinary E2EE joiner has a publication within milliseconds,
   * long before its Add commits. Keying on publication COUNT therefore
   * disqualifies almost every legitimate joiner, which re-fires §0.4 and
   * one-way stops an in-progress Android screen leg on essentially every
   * mid-call join. An E2EE joiner's publications declare GCM even while
   * upstream-paused; only a genuinely plaintext sender declares NONE.
   *
   * Server-attested, like `encryptedLegs` — a hostile SFU can misreport a
   * publication's encryption. The per-identity grace budget bounds that.
   */
  plaintextPublishers?: readonly string[];
}

/**
 * Diff the SFU participant set against the MLS roster, both directions (§1.4).
 * `localIdentity` is excluded from BOTH sides: we are always in our own call and
 * driving our own group, so a transient self-asymmetry during join/leave must
 * never read as non-enrolled or a ghost.
 *
 * 🔴 SCREEN LEGS ARE HANDLED ASYMMETRICALLY, AND THE ASYMMETRY IS THE POINT
 * (Android plan §5.3 / §0-R.4). Folding a leg onto its owner in BOTH
 * directions was the rev-1 design, and it re-opened two holes at once:
 *
 *  - the GHOST direction (the invariant-7 / T-18 backstop): a server-minted
 *    `victim:device:screen` under a DEPARTED device's identity would make that
 *    device look present, suppress the 30 s ghost Remove, and keep a departed
 *    leaf in the group indefinitely. So `ghosts` is computed from the RAW SFU
 *    set with legs dropped outright — a leg never keeps a leaf alive, whatever
 *    it is named.
 *
 *  - the NON-ENROLLED direction: folding unconditionally would turn a
 *    non-member plaintext publisher into an attributed, trusted-looking
 *    stream. A leg folds onto its owner only under BOTH guards:
 *      (a) the owner's primary is itself in the RAW SFU set — an ORPHAN leg is
 *          the §5.4 server-minted impostor and must still be reported; and
 *      (b) in `e2ee` mode, every publication of the leg declares encryption
 *          other than NONE — a leg declaring plaintext inside an encrypted
 *          call reads as non-enrolled, which is exactly the loud path.
 *
 * The client may only ever OVER-warn here, never suppress a real mix.
 *
 * `pendingAdmits` — identities the caller saw JOIN the SFU within its
 * admit-grace window (mirroring the leave-grace on the other direction).
 * A would-be non-enrolled identity in this set is reported as `pending`
 * instead of `nonEnrolled`, so a mid-call joiner whose staggered Add is still
 * in flight does not flip the call to `mixed` — which would pause the mic and
 * one-way STOP an Android screen leg (§0.4) on EVERY join. Three guards keep
 * this from weakening the mix detection:
 *  - it only ever applies to identities the caller watched join; the initial
 *    SFU set at enable time gets no grace, so the hostile-DS T-15 backstop
 *    (`rosterConsistent` before enable/publish) is untouched;
 *  - a SCREEN LEG is pending ONLY in its join→publish window (owner present
 *    AND zero publications — see `unpublishedLegs`, which is inert by
 *    construction): the §5.4 orphan impostor and a leg with any actual
 *    publication failing rule 2(b) both stay instantly loud;
 *  - `pending` is not "consistent" — callers gate enable/resume on BOTH lists
 *    being empty, and when the grace expires the identity falls through to
 *    `nonEnrolled` and the loud path fires exactly as before.
 * During the window the call keeps publishing under the CURRENT epoch's keys,
 * which the un-admitted joiner does not hold — no frame becomes readable to a
 * non-member, and no plaintext path opens.
 */
export function reconcileRoster(
  sfuIdentities: readonly string[],
  mlsIdentities: readonly string[],
  localIdentity: string,
  legs: RosterLegInputs = { e2ee: false, encryptedLegs: [] },
  pendingAdmits: readonly string[] = [],
): RosterReconcileResult {
  const rawSfu = new Set(sfuIdentities);
  const mls = new Set(mlsIdentities);
  rawSfu.delete(localIdentity);
  mls.delete(localIdentity);

  const encryptedLegs = new Set(legs.encryptedLegs);
  /** Rule 2: what a leg answers for, or itself when it must not fold. */
  const effective = (identity: string): string => {
    if (!isScreenLeg(identity)) return identity;
    const owner = stripLeg(identity);
    // (a) Owner present in the RAW set. `localIdentity` counts: it was deleted
    // from `rawSfu` above, and our own device's leg is the most legitimate leg
    // there is.
    if (!rawSfu.has(owner) && owner !== localIdentity) return identity;
    if (legs.e2ee && !encryptedLegs.has(identity)) return identity; // (b)
    return owner;
  };

  const graced = new Set(pendingAdmits);
  const unpublished = new Set(legs.unpublishedLegs ?? []);
  const plaintextPublishers = new Set(legs.plaintextPublishers ?? []);
  const nonEnrolled: string[] = [];
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const identity of rawSfu) {
    const id = effective(identity);
    // A folded leg collapses onto its owner: ONE non-enrolled participant, not
    // two rows for the same person.
    if (id === localIdentity || mls.has(id) || seen.has(id)) continue;
    seen.add(id);
    // Admit-grace: a freshly-joined primary is pending, not non-enrolled,
    // until the caller's window expires. An UNFOLDED leg gets the grace only
    // in its inert join→publish window AND with its owner present — the §5.4
    // orphan and any leg with an actual publication failing rule 2(b) stay
    // instantly loud.
    let inGrace = false;
    if (graced.has(id)) {
      if (!isScreenLeg(id)) {
        // A graced PRIMARY keeps its window unless it is actually sending
        // plaintext. Publishing is normal for a joiner mid-admit — the gate
        // pauses upstream rather than unpublishing — so the disqualifier is
        // the ENCRYPTION DECLARATION, not the existence of a publication.
        if (!legs.e2ee) {
          // Confirmed-plaintext call: every publication legitimately declares
          // NONE, so the test would disqualify everyone and there is no
          // downgrade to warn about anyway. Same reasoning as rule 2(b).
          inGrace = true;
        } else if (legs.plaintextPublishers === undefined) {
          // Unwired caller ⇒ no grace. This function may only ever over-warn,
          // so an absent input must cost the suppression, never grant it.
          inGrace = false;
        } else {
          inGrace = !plaintextPublishers.has(id);
        }
      } else {
        const owner = stripLeg(id);
        inGrace =
          unpublished.has(id) && (rawSfu.has(owner) || owner === localIdentity);
      }
    }
    if (inGrace) pending.push(id);
    else nonEnrolled.push(id);
  }

  const primaries = new Set(
    [...rawSfu].filter((identity) => !isScreenLeg(identity)),
  );
  const ghosts = [...mls].filter((id) => !primaries.has(id));
  return { nonEnrolled, pending, ghosts };
}

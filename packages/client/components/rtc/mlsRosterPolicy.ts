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
}

/**
 * Whether an SFU identity names a DEVICE — `{user_id}:{device_id}` (or that
 * device's `:screen` leg) — as opposed to a bare `{user_id}` (or the bare
 * leg grammar `{user_id}::screen`).
 *
 * This is the one fact about a participant that settles whether it can EVER
 * be in the MLS group. The join route mints the `:device` suffix only for a
 * caller that presents a registered E2EE device bound to its session
 * (`voice_client.rs` builds the identity from `device_id`; `voice_join.rs`
 * asserts the binding), the client requests it only when it is media-E2EE
 * capable, and every MLS leaf is keyed `user:device`. A bare identity is
 * therefore a client that joined without call encryption — a web browser, a
 * shell that never provisioned E2EE, a pre-E2EE build — and no admit, grace
 * or retry can change that.
 */
export function isDeviceQualified(identity: string): boolean {
  const segments = stripLeg(identity).split(":");
  return segments.length === 2 && segments[0] !== "" && segments[1] !== "";
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
 * one-way STOP an Android screen leg (§0.4) on EVERY join. Four guards keep
 * this from weakening the mix detection:
 *  - it only ever applies to identities the caller watched join; the initial
 *    SFU set at enable time gets no grace, so the hostile-DS T-15 backstop
 *    (`rosterConsistent` before enable/publish) is untouched;
 *  - it never applies to a BARE identity (`isDeviceQualified` false): such a
 *    participant has no E2EE device and can never be admitted, so it is
 *    non-enrolled on sight — the enrolled sides pause before it has published
 *    a frame;
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
  const nonEnrolled: string[] = [];
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const identity of rawSfu) {
    const id = effective(identity);
    // A folded leg collapses onto its owner: ONE non-enrolled participant, not
    // two rows for the same person.
    if (id === localIdentity || mls.has(id) || seen.has(id)) continue;
    seen.add(id);
    // A BARE identity can never hold an MLS leaf (see `isDeviceQualified`), so
    // there is no admit to wait for: it is non-enrolled the moment it is in
    // the SFU, grace or not. This is the earliest honest signal that a
    // plaintext client joined — before it publishes anything, before any
    // consent UI — and it is what lets the enrolled sides pause publishing
    // first (EL4 design I3/I4). Before this rule such a joiner was graced
    // like any other, and the re-arm at expiry kept a mic-muted browser
    // "pending" for tens of seconds while the enrolled sides kept publishing
    // ciphertext straight into its decoder.
    if (!isDeviceQualified(id)) {
      nonEnrolled.push(id);
      continue;
    }
    // Admit-grace: a freshly-joined DEVICE is pending, not non-enrolled,
    // until the caller's window expires. An UNFOLDED leg gets the grace only
    // in its inert join→publish window AND with its owner present — the §5.4
    // orphan and any leg with an actual publication failing rule 2(b) stay
    // instantly loud.
    //
    // A graced PRIMARY keeps its window whatever its publications declare.
    // Its publications are NOT evidence either way: livekit-client stamps
    // `encryption: NONE` on every publication until the participant's own
    // `setE2EEEnabled(true)` republishes them as GCM, and an E2EE joiner
    // only enables after its Welcome lands and its first key installs — so
    // from the far end an ENROLLING joiner looks exactly like a plaintext
    // publisher (NONE-declared, upstream paused by its own negotiating gate)
    // for the whole admit beat. Disqualifying on that declaration flipped
    // the call to `mixed` — pause, red banner, a "Turn off encryption"
    // button — on every single join, and resumed only after the 15 s
    // re-upgrade hysteresis. The genuinely plaintext client is caught above
    // by its bare identity instead; a device-qualified client that somehow
    // sends plaintext inside the window is bounded by the caller's grace
    // budget, and an announced downgrade reaches every member through the
    // ctl path regardless.
    let inGrace = false;
    if (graced.has(id)) {
      if (!isScreenLeg(id)) {
        inGrace = true;
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

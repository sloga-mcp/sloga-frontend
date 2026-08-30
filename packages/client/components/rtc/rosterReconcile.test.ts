// Specs for SFU∪MLS roster reconciliation with SCREEN LEGS (Android
// screen-share plan §5.3, rev-2 review item §0-R.4) — run with Node's
// built-in runner:
//   node --test components/rtc/rosterReconcile.test.ts
//
// This function decides two things that fail in opposite directions, which is
// why the leg rules are asymmetric and why each direction is pinned here:
//
//   nonEnrolled → drives the mixed banner, the loud chip and pause-publish.
//                 Over-warning is safe; under-warning silently attributes a
//                 non-member's plaintext stream to a member.
//   ghosts      → drives the 30 s Remove of a departed leaf. Over-warning
//                 removes a live member; UNDER-warning keeps a departed
//                 device's leaf in the group forever (invariant 7 / T-18).
//
// The rev-1 design folded legs onto their owner in BOTH directions and broke
// both. Reverting any single assertion below re-opens one of those holes.
import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileRoster } from "./mlsRosterPolicy.ts";

const SELF = "01SELF:devS";
const ALICE = "01ALICE:devA";
const BOB = "01BOB:devB";
const ALICE_LEG = `${ALICE}:screen`;
const BOB_LEG = `${BOB}:screen`;

/** In `e2ee` mode with every named leg declaring encryption. */
const keyed = (...legs: string[]) => ({ e2ee: true, encryptedLegs: legs });

/**
 * `keyed`, plus the set of identities actually sending PLAINTEXT. A graced
 * primary keeps its window unless it is in there.
 *
 * Every grace spec below has to pass this — even as an empty list — because
 * an absent input deliberately costs the grace. Publishing is NOT the
 * disqualifier: the publish gate pauses upstream rather than unpublishing and
 * a client's mic publish starts in its `connected` handler, so an ordinary
 * joiner has publications long before its Add commits.
 */
const keyedWithPlaintext = (plaintext: string[], ...legs: string[]) => ({
  ...keyed(...legs),
  plaintextPublishers: plaintext,
});

test("a keyed leg whose owner is present is silent in both directions", () => {
  const result = reconcileRoster(
    [SELF, ALICE, ALICE_LEG],
    [SELF, ALICE],
    SELF,
    keyed(ALICE_LEG),
  );
  assert.deepEqual(result.nonEnrolled, []);
  assert.deepEqual(result.ghosts, []);
});

test("🔴 an ORPHAN leg is non-enrolled AND its owner is still a ghost", () => {
  // The §5.4 server-minted impostor: a leg under a departed device's identity.
  // Folding it onto its owner would make the owner look present and suppress
  // the ghost Remove — a departed leaf kept alive by a participant the SERVER
  // named. Both directions must fire.
  const result = reconcileRoster(
    [SELF, ALICE_LEG],
    [SELF, ALICE],
    SELF,
    keyed(ALICE_LEG),
  );
  assert.deepEqual(
    result.nonEnrolled,
    [ALICE_LEG],
    "an orphan leg keeps its raw identity and is reported",
  );
  assert.deepEqual(
    result.ghosts,
    [ALICE],
    "a leg must never keep its owner's leaf alive",
  );
});

test("🔴 a leg declaring plaintext inside an e2ee call reads as non-enrolled", () => {
  // Rule 2(b). Without it, a publisher that says NONE borrows its owner's
  // membership and renders as an ordinary, trusted-looking share.
  const result = reconcileRoster(
    [SELF, ALICE, ALICE_LEG],
    [SELF, ALICE],
    SELF,
    { e2ee: true, encryptedLegs: [] },
  );
  assert.deepEqual(result.nonEnrolled, [ALICE_LEG]);
  // The owner is a member and present, so no ghost either way.
  assert.deepEqual(result.ghosts, []);
});

test("rule 2(b) is not applied outside e2ee mode", () => {
  // In a CONFIRMED-plaintext call every publication legitimately declares
  // NONE; applying 2(b) there would report a leg as non-enrolled in a call the
  // user has already agreed is unencrypted.
  const result = reconcileRoster(
    [SELF, ALICE, ALICE_LEG],
    [SELF, ALICE],
    SELF,
    {
      e2ee: false,
      encryptedLegs: [],
    },
  );
  assert.deepEqual(result.nonEnrolled, []);
});

test("a non-enrolled device and its leg collapse to ONE row", () => {
  // Both the primary and its leg are outside the group. The banner names a
  // person, so it must not list the same person twice.
  const result = reconcileRoster(
    [SELF, ALICE, ALICE, BOB, BOB_LEG],
    [SELF, ALICE],
    SELF,
    keyed(BOB_LEG),
  );
  assert.deepEqual(result.nonEnrolled, [BOB]);
});

test("a leg LEAVING does not make its owner a ghost", () => {
  // The share ended; the sharer never left. If the leg's absence armed a
  // Remove, ending a screen share would evict its owner from the group.
  const before = reconcileRoster(
    [SELF, ALICE, ALICE_LEG],
    [SELF, ALICE],
    SELF,
    keyed(ALICE_LEG),
  );
  const after = reconcileRoster([SELF, ALICE], [SELF, ALICE], SELF, keyed());
  assert.deepEqual(before.ghosts, []);
  assert.deepEqual(after.ghosts, []);
  assert.deepEqual(after.nonEnrolled, []);
});

test("our OWN leg is never reported against us", () => {
  const selfLeg = `${SELF}:screen`;
  const result = reconcileRoster(
    [SELF, selfLeg, ALICE],
    [SELF, ALICE],
    SELF,
    keyed(selfLeg),
  );
  assert.deepEqual(result.nonEnrolled, []);
  assert.deepEqual(result.ghosts, []);
});

test("🔴 the two-segment `user:screen` is a PRIMARY, not a leg", () => {
  // §0-R.3. `01BOB:screen` is the legitimate identity of a device whose id is
  // "screen". Reading it as a leg would fold it onto the bare `01BOB` and, if
  // some `01BOB` were in the group, exempt a stranger's device from the check
  // entirely.
  const result = reconcileRoster(
    [SELF, "01BOB:screen"],
    [SELF, "01BOB"],
    SELF,
    keyed("01BOB:screen"),
  );
  assert.deepEqual(result.nonEnrolled, ["01BOB:screen"]);
  assert.deepEqual(result.ghosts, ["01BOB"]);
});

test("the bare-primary grammar `user::screen` folds onto the bare user", () => {
  // A plaintext / unprovisioned primary carries a bare user id, and its leg
  // gets an EMPTY device segment. Reconcile does not run without a group, but
  // the mixed case (a bare joiner in an E2EE call) does reach here.
  const bare = "01CAROL";
  const bareLeg = "01CAROL::screen";
  const result = reconcileRoster(
    [SELF, ALICE, bare, bareLeg],
    [SELF, ALICE],
    SELF,
    keyed(bareLeg),
  );
  assert.deepEqual(
    result.nonEnrolled,
    [bare],
    "the bare primary is the one non-enrolled participant, listed once",
  );
});

// ---- Admit-grace (Android plan §17.7 finding F3) ---------------------------
// A mid-call joiner sits in the SFU seconds before its staggered Add commits;
// declaring it non-enrolled in that window flips the call to `mixed`, pauses
// the mic and one-way STOPS an Android screen leg (§0.4) on EVERY join. The
// caller passes the identities it watched join within the admit window; they
// are reported as `pending` — held out of the mix trigger but NOT consistent
// (enable/resume still wait on the caller side).

test("a pending-admit joiner is pending, not non-enrolled", () => {
  const result = reconcileRoster(
    [SELF, ALICE, BOB],
    [SELF, ALICE],
    SELF,
    keyedWithPlaintext([]),
    [BOB],
  );
  assert.deepEqual(result.nonEnrolled, []);
  assert.deepEqual(result.pending, [BOB]);
  assert.deepEqual(result.ghosts, []);
});

test("grace on one joiner never masks a different non-enrolled participant", () => {
  const result = reconcileRoster(
    [SELF, ALICE, BOB],
    [SELF],
    SELF,
    keyedWithPlaintext([]),
    [BOB],
  );
  assert.deepEqual(result.nonEnrolled, [ALICE]);
  assert.deepEqual(result.pending, [BOB]);
});

test("🔴 an ORDINARY joiner keeps its grace while its publications are encrypted", () => {
  // The F3 case, and the one a publication-COUNT test would break. A normal
  // E2EE joiner publishes its mic in its `connected` handler, seconds before
  // its staggered Add commits — and the publish gate pauses upstream rather
  // than unpublishing, so the publication object is there throughout. Its
  // tracks declare GCM, so it is not a plaintext publisher and keeps the
  // window. Losing it here would flip the call to `mixed` and one-way STOP an
  // in-progress Android screen leg on essentially every mid-call join.
  const result = reconcileRoster(
    [SELF, ALICE, BOB],
    [SELF, ALICE],
    SELF,
    keyedWithPlaintext([]), // BOB is publishing, but all of it encrypted
    [BOB],
  );
  assert.deepEqual(result.nonEnrolled, []);
  assert.deepEqual(result.pending, [BOB]);
});

test("🔴 a graced joiner publishing PLAINTEXT is loud immediately, not pending", () => {
  // The suppression hole: the grace was unconditional for primaries and the
  // check ran only at expiry, so a plaintext client (web is excluded from
  // call E2EE by design) could join an encrypted call, unmute, and have the
  // mixed banner and the publish pause suppressed for the whole 10-60 s
  // window while its audio played to everyone. Nothing else catches it:
  // livekit disables the cryptor for a publication declaring
  // `encryption === NONE`, so a plaintext sender raises no decrypt error.
  const result = reconcileRoster(
    [SELF, ALICE, BOB],
    [SELF, ALICE],
    SELF,
    keyedWithPlaintext([BOB]),
    [BOB],
  );
  assert.deepEqual(result.nonEnrolled, [BOB]);
  assert.deepEqual(result.pending, []);
});

test("🔴 unknown plaintext state gives a graced primary NO grace", () => {
  // `plaintextPublishers` omitted. The house rule for this function is that
  // it may only ever OVER-warn, so an unwired caller must lose the grace,
  // never gain a silent suppression.
  const result = reconcileRoster([SELF, BOB], [SELF], SELF, keyed(), [BOB]);
  assert.deepEqual(result.nonEnrolled, [BOB]);
  assert.deepEqual(result.pending, []);
});

test("outside e2ee the plaintext test does not apply — every publication is NONE", () => {
  // In a confirmed-plaintext call every publication legitimately declares
  // NONE, so applying the disqualifier would strip the grace from everyone
  // for no benefit: there is no encrypted state left to downgrade.
  const result = reconcileRoster(
    [SELF, BOB],
    [SELF],
    SELF,
    { e2ee: false, encryptedLegs: [], plaintextPublishers: [BOB] },
    [BOB],
  );
  assert.deepEqual(result.nonEnrolled, []);
  assert.deepEqual(result.pending, [BOB]);
});

test("🔴 the admit-grace never covers an orphan or a published plaintext leg", () => {
  // An unfolded leg with an actual publication is either the §5.4 orphan
  // impostor or a plaintext publication in an e2ee call (rule 2(b)); both
  // must stay instantly loud even if the caller graced the leg identity.
  const orphan = reconcileRoster(
    [SELF, ALICE_LEG],
    [SELF, ALICE],
    SELF,
    keyed(ALICE_LEG),
    [ALICE_LEG],
  );
  assert.deepEqual(orphan.nonEnrolled, [ALICE_LEG]);
  assert.deepEqual(orphan.pending, []);

  const plaintext = reconcileRoster(
    [SELF, ALICE, ALICE_LEG],
    [SELF, ALICE],
    SELF,
    { e2ee: true, encryptedLegs: [] },
    [ALICE_LEG],
  );
  assert.deepEqual(plaintext.nonEnrolled, [ALICE_LEG]);
  assert.deepEqual(plaintext.pending, []);
});

test("a graced UNPUBLISHED leg with its owner present is pending, not loud", () => {
  // The join→publish window: the leg is in the SFU but has zero publications
  // — it sends nothing (no frames exist) and its token cannot subscribe, so
  // there is nothing to fail closed against. Before this rule, a reconcile
  // landing in that window read the leg non-enrolled (rule 2(b) over-warn),
  // fired `mixed`, and §0.4 one-way stopped the leg that had just connected
  // — the share killed itself at birth under load.
  const result = reconcileRoster(
    [SELF, ALICE, ALICE_LEG],
    [SELF, ALICE],
    SELF,
    { e2ee: true, encryptedLegs: [], unpublishedLegs: [ALICE_LEG] },
    [ALICE_LEG],
  );
  assert.deepEqual(result.nonEnrolled, []);
  assert.deepEqual(result.pending, [ALICE_LEG]);
});

test("🔴 a graced unpublished leg is still loud when its owner is ABSENT", () => {
  // The §5.4 orphan direction wins over the join→publish grace: a
  // server-minted leg under a departed identity is reported immediately,
  // published or not.
  const result = reconcileRoster(
    [SELF, ALICE_LEG],
    [SELF, ALICE],
    SELF,
    { e2ee: true, encryptedLegs: [], unpublishedLegs: [ALICE_LEG] },
    [ALICE_LEG],
  );
  assert.deepEqual(result.nonEnrolled, [ALICE_LEG]);
  assert.deepEqual(result.pending, []);
});

test("an UNGRACED unpublished leg still over-warns (the grace is the caller's call)", () => {
  const result = reconcileRoster(
    [SELF, ALICE, ALICE_LEG],
    [SELF, ALICE],
    SELF,
    { e2ee: true, encryptedLegs: [], unpublishedLegs: [ALICE_LEG] },
  );
  assert.deepEqual(result.nonEnrolled, [ALICE_LEG]);
  assert.deepEqual(result.pending, []);
});

test("an admitted identity still in the grace set is neither pending nor non-enrolled", () => {
  const result = reconcileRoster([SELF, ALICE], [SELF, ALICE], SELF, keyed(), [
    ALICE,
  ]);
  assert.deepEqual(result.nonEnrolled, []);
  assert.deepEqual(result.pending, []);
});

test("a pending primary and its keyed leg collapse to ONE pending row", () => {
  // Same dedupe rule as non-enrolled: the banner-side consumer names people.
  const result = reconcileRoster(
    [SELF, BOB, BOB_LEG],
    [SELF],
    SELF,
    keyedWithPlaintext([], BOB_LEG),
    [BOB],
  );
  assert.deepEqual(result.nonEnrolled, []);
  assert.deepEqual(result.pending, [BOB]);
});

test("no pendingAdmits argument behaves exactly as before, with an empty pending", () => {
  const result = reconcileRoster([SELF, ALICE], [SELF], SELF, keyed());
  assert.deepEqual(result.nonEnrolled, [ALICE]);
  assert.deepEqual(result.pending, []);
});

test("legs change nothing about ordinary non-enrolled and ghost detection", () => {
  // The pre-leg behaviour, unchanged: a stranger in the SFU set is
  // non-enrolled, a member with no SFU participant is a ghost, and self is
  // excluded from both sides.
  const result = reconcileRoster([SELF, ALICE], [SELF, BOB], SELF, keyed());
  assert.deepEqual(result.nonEnrolled, [ALICE]);
  assert.deepEqual(result.ghosts, [BOB]);

  // Default leg inputs (no argument) behave as a plain, leg-free call.
  const legacy = reconcileRoster([SELF, ALICE], [SELF, BOB], SELF);
  assert.deepEqual(legacy, result);
});

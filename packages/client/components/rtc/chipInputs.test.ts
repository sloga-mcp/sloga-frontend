// Specs for the encryption chip's INPUT ASSEMBLY — run with Node's built-in
// runner:
//   node --test --conditions=browser components/rtc/chipInputs.test.ts
//
// 🔴 Every test here drives the REAL `chipState`, not a stub. That is the
// point: three consecutive `media-e2ee-reviewer` rounds found the same defect
// one line further down the object literal this module replaces, each time by
// making one honest amber or red come out green, and each time the whole suite
// stayed green because `state.tsx` cannot be loaded by `node --test`. Round 5
// measured NINE such one-line edits. The list below is those nine, asserted as
// the honest outcome, so a mutation that fakes any one of them goes red.
//
//   (b) a publisher with no observed status   honest = resecuring
//   (b) our own publication declared NONE     honest = resecuring
//   (c) one roster member unverified          honest = e2ee_unverified
//   (c) the roster read as empty              honest = e2ee_unverified
//   (d) the witness stale                     honest = resecuring
//   (d) the worker dropping a sender's frames honest = resecuring
//       a media hold / rotation window        honest = resecuring
//       a latched structured error            honest = not_encrypted
//       the session failed                    honest = not_encrypted
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ChipRoom,
  type ChipSources,
  chipInputsFrom,
  chipStateFrom,
  observedEncryptionMap,
  publishingIdentities,
} from "./chipInputs.ts";
import { type ChipState, chipState } from "./mlsCallModePolicy.ts";

const ME = "me:d1";
const BOB = "bob:d1";

/** A healthy encrypted call: we and Bob both publishing, both observed GCM. */
const room = (over: Partial<ChipRoom> = {}): ChipRoom => ({
  localIdentity: ME,
  participants: [
    { identity: ME, publicationCount: 1 },
    { identity: BOB, publicationCount: 1 },
  ],
  localPublications: [{ trackSid: "TR_a", encryption: 1 }],
  ...over,
});

const sources = (over: Partial<ChipSources> = {}): ChipSources => ({
  hasSession: () => true,
  sessionState: () => "active",
  mode: () => ({ kind: "e2ee" }),
  mediaHold: () => false,
  latchedError: () => false,
  rosterVerified: () => [true, true],
  channelHasOpenGroup: () => true,
  capableAndEnabled: () => true,
  decodeWitness: () => ({ available: true, dropping: [], live: [] }),
  room: () => room(),
  observedEncryption: (identity) =>
    identity === ME || identity === BOB ? true : undefined,
  ...over,
});

/** The chip a real `chipState` produces from an assembled set of sources. */
const chip = (over: Partial<ChipSources> = {}): ChipState =>
  chipStateFrom(sources(over));

/**
 * ME-7 / R2-4, the silent-fail guard: an E2EE-CAPABLE shell whose session
 * construction failed, in a channel that HAS an open MLS group. No verdict can
 * ever come, so the chip must be LOUD rather than quietly plain — a downgrade
 * the user cannot see is the thing this guard exists to prevent.
 */
const noSession = (over: Partial<ChipSources> = {}): ChipState =>
  chip({
    hasSession: () => false,
    sessionState: () => undefined,
    mode: () => undefined,
    rosterVerified: () => [],
    room: () => undefined,
    ...over,
  });

// --- the control -------------------------------------------------------------

test("a healthy encrypted call is green", () => {
  assert.equal(chip(), "e2ee");
});

// --- the nine one-line holes, asserted as their honest outcome ---------------

test("🔴 (b) a publisher with NO observed status is not vouched for", () => {
  // Bob is publishing and LiveKit has said nothing about him. Reading that
  // absence as "fine" is the posture this whole effort exists to delete.
  assert.equal(
    chip({ observedEncryption: (id) => (id === ME ? true : undefined) }),
    "resecuring",
  );
});

test("🔴 (b) a publisher observed NOT encrypted is not vouched for", () => {
  assert.equal(
    chip({ observedEncryption: (id) => (id === ME ? true : false) }),
    "resecuring",
  );
});

test("🔴 (b) our OWN publication declared NONE is not vouched for", () => {
  // The worker says the cryptor is on; the SFU's record is what receivers arm
  // from. Desktop 0.57.0 shipped a green over exactly this.
  assert.equal(
    chip({
      room: () =>
        room({ localPublications: [{ trackSid: "TR_a", encryption: 0 }] }),
    }),
    "resecuring",
  );
});

test("🔴 (c) one unverified roster member holds the lock open", () => {
  assert.equal(
    chip({ rosterVerified: () => [true, false] }),
    "e2ee_unverified",
  );
});

test("🔴 (c) an EMPTY roster CANNOT vouch — it is not 'all verified'", () => {
  // `[].every(v => v)` is `true`, so this used to promote e2ee_unverified
  // straight to e2ee: a VERIFIED lock, the strongest claim the product makes,
  // resting on nobody having been verified.
  //
  // It is reachable in a legitimate call, which is why it was fixed rather
  // than documented: `callRoster` is seeded empty and only written by
  // `#reconcileOnce`, which returns early unless the session is `active` — so
  // there is a window on every call before the first native `callState()`
  // round-trip resolves, and if that bridge call keeps throwing it is
  // swallowed and the roster stays empty for the life of the call while the
  // session stays active. §4.4 requires all leaf bindings verified for green;
  // an unloaded roster has verified none.
  assert.equal(chip({ rosterVerified: () => [] }), "e2ee_unverified");
});

test("the assembly passes the roster through exactly as given", () => {
  // The mutation target: an assembly that dropped or emptied this read would
  // silently satisfy the gate above for any roster.
  assert.deepEqual(
    chipInputsFrom(sources({ rosterVerified: () => [true, false, true] }))
      .rosterVerified,
    [true, false, true],
  );
});

test("🔴 (d) a stale decode witness holds the chip amber", () => {
  assert.equal(
    chip({
      decodeWitness: () => ({ available: false, dropping: [], live: [] }),
    }),
    "resecuring",
  );
});

test("🔴 (d) a sender whose frames are being DROPPED holds the chip amber", () => {
  assert.equal(
    chip({
      decodeWitness: () => ({ available: true, dropping: [BOB], live: [ME] }),
    }),
    "resecuring",
  );
});

test("🔴 a media hold holds the chip amber", () => {
  assert.equal(chip({ mediaHold: () => true }), "resecuring");
});

test("🔴 a latched structured error is NOT_ENCRYPTED", () => {
  assert.equal(chip({ latchedError: () => true }), "not_encrypted");
});

test("🔴 a FAILED session is NOT_ENCRYPTED", () => {
  assert.equal(chip({ sessionState: () => "failed" }), "not_encrypted");
});

// --- the five fields that had no spec at all ---------------------------------
//
// Round 6 extracted the derivation but covered only nine of the fourteen
// fields. These are the other five, and two of them turn the loudest state in
// the product into amber or into nothing at all.

test("🔴 ME-7: a capable shell with an open group and NO session is LOUD", () => {
  assert.equal(noSession(), "not_encrypted");
});

test("🔴 ME-7: faking hasSession turns that loud into a silent amber", () => {
  // No banner, no Leave/Stay, forever — the exact silent downgrade the guard
  // exists to prevent.
  assert.equal(noSession({ hasSession: () => true }), "resecuring");
});

test("🔴 ME-7: faking channelHasOpenGroup HIDES the chip entirely", () => {
  // `none` renders no encryption chrome at all on an E2EE call.
  assert.equal(noSession({ channelHasOpenGroup: () => false }), "none");
});

test("🔴 a call with no MODE cannot be green", () => {
  assert.equal(chip({ mode: () => undefined }), "resecuring");
});

test("🔴 e2eeEnabled and hasLocalKey are DERIVED from the mode, not assumed", () => {
  // Both are `mode?.kind === "e2ee"`. A mode that is not e2ee must not yield
  // an enabled, keyed call.
  const negotiating = chipInputsFrom(
    sources({ mode: () => ({ kind: "negotiating" }) }),
  );
  assert.equal(negotiating.e2eeEnabled, false);
  assert.equal(negotiating.hasLocalKey, false);
  const e2ee = chipInputsFrom(sources());
  assert.equal(e2ee.e2eeEnabled, true);
  assert.equal(e2ee.hasLocalKey, true);
});

test("capableAndEnabled is passed through unchanged", () => {
  // `chipState` deliberately returns not_encrypted for BOTH values in the
  // no-session case (§0.2 #9 self-attribution), so there is no scenario in
  // which the outcome discriminates it. Pin the pass-through instead, which
  // still catches an assembly that hardcodes it.
  assert.equal(
    chipInputsFrom(sources({ capableAndEnabled: () => false }))
      .capableAndEnabled,
    false,
  );
  assert.equal(
    chipInputsFrom(sources({ capableAndEnabled: () => true }))
      .capableAndEnabled,
    true,
  );
});

test("hasSession and channelHasOpenGroup are passed through unchanged", () => {
  const inputs = chipInputsFrom(
    sources({ hasSession: () => false, channelHasOpenGroup: () => false }),
  );
  assert.equal(inputs.hasSession, false);
  assert.equal(inputs.channelHasOpenGroup, false);
});

// --- the seam ----------------------------------------------------------------

test("🔴 chipStateFrom assembles AND judges, so no ChipInputs escapes", () => {
  // The caller must never hold the assembled object: spreading it into a
  // literal that overrides one field passed every source-text assertion and
  // every mutation for exactly one commit.
  const s = sources({
    decodeWitness: () => ({ available: false, dropping: [], live: [] }),
  });
  assert.equal(chipStateFrom(s), chipState(chipInputsFrom(s)));
  assert.equal(chipStateFrom(s), "resecuring");
});

// --- the derivation the literal used to hide ---------------------------------

test("🔴 our OWN screen leg is excluded from the publishers gate (b) judges", () => {
  // §6.7: this device minted the leg's key and does not subscribe to it, so
  // LiveKit never reports a status for it. Judging it would pin the sharer's
  // own phone amber for the whole share.
  const leg = `${ME}:screen`;
  assert.deepEqual(
    publishingIdentities(
      room({
        participants: [
          { identity: ME, publicationCount: 1 },
          { identity: leg, publicationCount: 1 },
        ],
      }),
    ),
    [ME],
  );
  assert.equal(
    chip({
      room: () =>
        room({
          participants: [
            { identity: ME, publicationCount: 1 },
            { identity: leg, publicationCount: 1 },
          ],
        }),
    }),
    "e2ee",
  );
});

test("🔴 ANOTHER device's screen leg is a real publisher and IS judged", () => {
  // Compared by device, not by user: a leg from our other device is remote.
  const otherLeg = "me:d2:screen";
  assert.deepEqual(
    publishingIdentities(
      room({
        participants: [
          { identity: ME, publicationCount: 1 },
          { identity: otherLeg, publicationCount: 1 },
        ],
      }),
    ),
    [ME, otherLeg],
  );
});

test("FE-2: a participant publishing NOTHING never reports a status, so is not judged", () => {
  assert.deepEqual(
    publishingIdentities(
      room({
        participants: [
          { identity: ME, publicationCount: 1 },
          { identity: BOB, publicationCount: 0 },
        ],
      }),
    ),
    [ME],
  );
  // ...and a trackless listener with no observed status stays green.
  assert.equal(
    chip({
      room: () =>
        room({
          participants: [
            { identity: ME, publicationCount: 1 },
            { identity: BOB, publicationCount: 0 },
          ],
        }),
      observedEncryption: (id) => (id === ME ? true : undefined),
    }),
    "e2ee",
  );
});

test("no room at all: nothing is publishing and our declaration is vacuous", () => {
  const inputs = chipInputsFrom(sources({ room: () => undefined }));
  assert.deepEqual(inputs.publishingIdentities, []);
  assert.equal(inputs.localPublicationsEncrypted, true);
  assert.equal(inputs.observedEncrypted.size, 0);
});

test("🔴 an identity with no observed status is LEFT OUT of the map, not defaulted", () => {
  // Entering it as true manufactures a green; entering it as false
  // manufactures a red. Absence is neither.
  const observed = observedEncryptionMap([ME, BOB], (id) =>
    id === ME ? true : undefined,
  );
  assert.deepEqual([...observed], [[ME, true]]);
  assert.equal(observed.has(BOB), false);
});

test("observedEncryptionMap keeps a FALSE status rather than dropping it", () => {
  const observed = observedEncryptionMap([BOB], () => false);
  assert.deepEqual([...observed], [[BOB, false]]);
});

// --- the mechanical contract -------------------------------------------------

test("every accessor is called exactly once per assembly", () => {
  // The assembly must not read a signal twice (a torn read) nor skip one (a
  // dependency the caller's memo then never registers).
  const calls: Record<string, number> = {};
  const count =
    <T>(name: string, value: T) =>
    () => {
      calls[name] = (calls[name] ?? 0) + 1;
      return value;
    };
  chipInputsFrom({
    hasSession: count("hasSession", true),
    sessionState: count("sessionState", "active"),
    mode: count("mode", { kind: "e2ee" as const }),
    mediaHold: count("mediaHold", false),
    latchedError: count("latchedError", false),
    rosterVerified: count("rosterVerified", [true]),
    channelHasOpenGroup: count("channelHasOpenGroup", true),
    capableAndEnabled: count("capableAndEnabled", true),
    decodeWitness: count("decodeWitness", {
      available: true,
      dropping: [],
      live: [],
    }),
    room: count("room", room()),
    observedEncryption: () => true,
  });
  assert.deepEqual(calls, {
    hasSession: 1,
    sessionState: 1,
    mode: 1,
    mediaHold: 1,
    latchedError: 1,
    rosterVerified: 1,
    channelHasOpenGroup: 1,
    capableAndEnabled: 1,
    decodeWitness: 1,
    room: 1,
  });
});

test("🔴 an already-resecuring session short-circuits the media-hold read", () => {
  // Preserved from the inline version deliberately: the memo re-runs when the
  // session state changes, so the hold dependency is picked up then. Pinned so
  // that changing it is a decision rather than an accident.
  let holdReads = 0;
  chipInputsFrom(
    sources({
      sessionState: () => "resecuring",
      mediaHold: () => {
        holdReads += 1;
        return false;
      },
    }),
  );
  assert.equal(holdReads, 0);
});

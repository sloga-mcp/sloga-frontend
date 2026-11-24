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
//       a latched error (bare / media / un-keyed control)
//                                             honest = not_encrypted
//       a KEYED control latch, media intact   honest = cannot_verify
//       the session failed                    honest = not_encrypted
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ChipPublication,
  type ChipRoom,
  type ChipSources,
  chipInputsFrom,
  chipPublicationsOf,
  chipStateFrom,
  observedEncryptionMap,
  publishingIdentities,
  shareOnlyDeclarationContradicts,
} from "./chipInputs.ts";
import {
  type ChipLatch,
  type ChipState,
  chipState,
} from "./mlsCallModePolicy.ts";

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
  latch: () => undefined,
  rosterVerified: () => [true, true],
  channelHasOpenGroup: () => true,
  deviceNeedsSetup: () => false,
  peerCouldEncrypt: () => true,
  decodeWitness: () => ({ available: true, dropping: [], live: [] }),
  pausedByServer: () => false,
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
  // The latch is a RECORD now, not a boolean, and the chip splits it by
  // origin and by whether the send side was keyed. Every shape that is not
  // the one keyed-control case reads loud-plain: a media latch (the plane
  // itself failed) and an UN-KEYED control latch (a spent join ladder, the
  // declaration seam, a media→control upgrade — `mediaKeyed: false`).
  assert.equal(
    chip({ latch: () => ({ origin: "media", mediaKeyed: false }) }),
    "not_encrypted",
  );
  assert.equal(
    chip({ latch: () => ({ origin: "media", mediaKeyed: true }) }),
    "not_encrypted",
  );
  assert.equal(
    chip({ latch: () => ({ origin: "control", mediaKeyed: false }) }),
    "not_encrypted",
  );
});

test("🔴 a BARE latch (origin undefined) is NOT_ENCRYPTED, and no latch is not", () => {
  // The two direct `state.tsx` writers — the store-owner identity mismatch
  // and `sessionSetupDecision`'s `hold_loud` — never went through
  // `#latchLoud`, so the binding narrows them to exactly this shape:
  // `{ origin: undefined, mediaKeyed: false }` (`mediaKeyed ?? false`).
  // There is no snapshot to split on, so they read loud-plain
  // unconditionally. This is the control that kills an assembly mapping the
  // latch to `undefined`: with the latch dropped, the same sources read a
  // green VERIFIED lock.
  const bare: ChipLatch = { origin: undefined, mediaKeyed: false };
  assert.equal(chip({ latch: () => bare }), "not_encrypted");
  // ...and the origin-less shape can never be softened by a keyed snapshot,
  // because nobody took one.
  assert.equal(
    chip({ latch: () => ({ origin: undefined, mediaKeyed: true }) }),
    "not_encrypted",
  );
  // The un-latched reading of the SAME sources, so the assertion above is
  // known to be carried by the latch and nothing else.
  assert.equal(chip({ latch: () => undefined }), "e2ee");
});

test("the assembly passes the latch record through UNCHANGED", () => {
  // `chipState` reads `origin` and `mediaKeyed` together (rows 2–5 of its
  // order of record). An assembly that collapsed the record to a boolean,
  // dropped a field, or rebuilt it with a default would make the split
  // unreachable from any spec — so every combination must survive the
  // mapping byte-for-byte, and the absence of a latch must stay `undefined`.
  const shapes: ChipLatch[] = [
    { origin: "control", mediaKeyed: true },
    { origin: "control", mediaKeyed: false },
    { origin: "media", mediaKeyed: true },
    { origin: "media", mediaKeyed: false },
    { origin: undefined, mediaKeyed: false },
  ];
  for (const latch of shapes) {
    assert.deepEqual(
      chipInputsFrom(sources({ latch: () => latch })).latch,
      latch,
    );
  }
  assert.equal(
    chipInputsFrom(sources({ latch: () => undefined })).latch,
    undefined,
  );
});

test("🔴 a KEYED control latch with media intact reads CANNOT_VERIFY end-to-end", () => {
  // The whole `sources → inputs → chip` path for the new state, in the shape
  // `#onLoud` leaves the session in: the mode folded to `negotiating`, the
  // lifecycle state `failed`, and a control-origin latch whose snapshot says
  // this device WAS keyed when the loud fired. With every local publication
  // declared GCM and the witness dropping nobody, the group can no longer be
  // vouched for but nothing says the media plane failed — "we can't
  // confirm", not "not encrypted". `failed` alone (row 6) must not win over
  // this: it is set BEFORE `#latchLoud` on every `#onLoud` path.
  const keyedControl = (over: Partial<ChipSources> = {}): ChipState =>
    chip({
      sessionState: () => "failed",
      mode: () => ({ kind: "negotiating" }),
      latch: () => ({ origin: "control", mediaKeyed: true }),
      ...over,
    });
  assert.equal(keyedControl(), "cannot_verify");
  // Both media-plane conjuncts are DERIVED by this module, so each is
  // exercised through the assembly rather than handed to `chipState` as a
  // value. The witness may only CONTRADICT: a sender being dropped is the
  // media plane failing, and the honest reading is loud-plain...
  assert.equal(
    keyedControl({
      decodeWitness: () => ({ available: true, dropping: [BOB], live: [ME] }),
    }),
    "not_encrypted",
  );
  // ...and so is our own publication on the SFU's record as NONE.
  assert.equal(
    keyedControl({
      room: () =>
        room({ localPublications: [{ trackSid: "TR_a", encryption: 0 }] }),
    }),
    "not_encrypted",
  );
  // An `unavailable` witness is not a contradiction — it cannot support the
  // POSITIVE claim "Not encrypted" either.
  assert.equal(
    keyedControl({
      decodeWitness: () => ({ available: false, dropping: [], live: [] }),
    }),
    "cannot_verify",
  );
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

test("deviceNeedsSetup and peerCouldEncrypt each reach the no-session chip", () => {
  // With no session and no open group, only the pair together raises the
  // chip: a device that could encrypt but is not set up, on a call where
  // someone else can. Either one hardcoded changes an outcome below.
  const noSession = (need: boolean, peer: boolean) =>
    chip({
      hasSession: () => false,
      channelHasOpenGroup: () => false,
      deviceNeedsSetup: () => need,
      peerCouldEncrypt: () => peer,
    });
  assert.equal(noSession(true, true), "not_encrypted");
  assert.equal(noSession(true, false), "none");
  assert.equal(noSession(false, true), "none");
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
  // §6.7: this device minted the leg's key and does not subscribe to it. Kept
  // by the F7 ruling until a live Android leg shows whether this webview sees
  // a status for its own leg within the admit grace; until then, judging it
  // could pin the sharer's own phone amber for the whole share.
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
  const observed = observedEncryptionMap(
    [ME, BOB],
    (id) => (id === ME ? true : undefined),
    [],
  );
  assert.deepEqual([...observed], [[ME, true]]);
  assert.equal(observed.has(BOB), false);
});

test("observedEncryptionMap keeps a FALSE status rather than dropping it", () => {
  const observed = observedEncryptionMap([BOB], () => false, []);
  assert.deepEqual([...observed], [[BOB, false]]);
});

// --- F2: the one-way share-only contradiction --------------------------------
//
// LiveKit reads a remote participant as encrypted whenever its declaration is
// not NONE, so a missing field or an unknown value reads green. For a
// participant whose ONLY publications are shares nobody here watches, the
// decode witness never sees a frame, so nothing else can catch that lie. The
// contradiction may only turn "encrypted" into "not encrypted", never back.

const GCM = 1;
const NONE = 0;

/** A share we neither asked for nor hold: the case gate (d) cannot see. */
const unwatched = (over: Partial<ChipPublication> = {}): ChipPublication => ({
  source: "screen_share",
  desired: false,
  subscribed: false,
  encryption: GCM,
  ...over,
});

/**
 * The whole assembly with Bob publishing exactly `publications` and LiveKit
 * reporting `status` for him. Asserts, for EVERY case, that the contradiction
 * never touched the publisher set, then hands back what it did to Bob.
 */
const judgeBob = (
  publications: ChipPublication[],
  status: boolean | undefined,
) => {
  const inputs = chipInputsFrom(
    sources({
      room: () =>
        room({
          participants: [
            { identity: ME, publicationCount: 1 },
            {
              identity: BOB,
              publicationCount: Math.max(publications.length, 1),
              publications,
            },
          ],
        }),
      observedEncryption: (id) =>
        id === ME ? true : id === BOB ? status : undefined,
    }),
  );
  assert.deepEqual(inputs.publishingIdentities, [ME, BOB]);
  // Never collateral: our own entry is exactly what LiveKit said.
  assert.equal(inputs.observedEncrypted.get(ME), true);
  return {
    has: inputs.observedEncrypted.has(BOB),
    bob: inputs.observedEncrypted.get(BOB),
    chip: chipState(inputs),
  };
};

test("F2: all-unwatched shares declared GCM keep an observed TRUE", () => {
  const r = judgeBob(
    [unwatched(), unwatched({ source: "screen_share_audio" })],
    true,
  );
  assert.equal(r.bob, true);
  assert.equal(r.chip, "e2ee");
});

test("🔴 F2: all-unwatched shares declared NONE turn an observed TRUE false", () => {
  const r = judgeBob([unwatched({ encryption: NONE })], true);
  assert.equal(r.bob, false);
  assert.equal(r.chip, "resecuring");
});

test("🔴 F2: a MISSING declaration contradicts, though LiveKit reads it encrypted", () => {
  // `undefined !== NONE`, so LiveKit's own reading is "encrypted". This is
  // the case a `!== NONE` comparison here would wave through.
  const r = judgeBob([unwatched({ encryption: undefined })], true);
  assert.equal(r.bob, false);
  assert.equal(r.chip, "resecuring");
});

test("🔴 F2: an UNKNOWN enum value contradicts, compared exactly with GCM", () => {
  for (const encryption of [2, 7, -1]) {
    const r = judgeBob([unwatched({ encryption })], true);
    assert.equal(r.bob, false, `encryption ${encryption}`);
  }
});

test("🔴 F2: ONE non-GCM share among unwatched shares is enough", () => {
  const r = judgeBob(
    [
      unwatched(),
      unwatched({ source: "screen_share_audio", encryption: undefined }),
    ],
    true,
  );
  assert.equal(r.bob, false);
});

test("F2: with NO observed status, a NONE declaration enters false", () => {
  const r = judgeBob([unwatched({ encryption: NONE })], undefined);
  assert.equal(r.has, true);
  assert.equal(r.bob, false);
});

test("🔴 F2 is ONE-WAY: no observed status plus GCM stays ABSENT, not promoted", () => {
  // This is not the wave-2.5 declaration fallback: a GCM declaration is not
  // evidence, and must not stand in for a measurement that never came.
  const r = judgeBob([unwatched()], undefined);
  assert.equal(r.has, false);
  assert.equal(r.chip, "resecuring");
});

test("🔴 F2 is ONE-WAY: an observed FALSE plus GCM stays false", () => {
  const r = judgeBob([unwatched()], false);
  assert.equal(r.bob, false);
  assert.equal(r.chip, "resecuring");
});

test("F2: a DESIRED or SUBSCRIBED share is the witness's to judge, not this rule's", () => {
  const cases: ChipPublication[][] = [
    [unwatched({ encryption: NONE, desired: true })],
    [unwatched({ encryption: NONE, subscribed: true })],
    [unwatched({ encryption: NONE, desired: true, subscribed: true })],
    // Not ALL unwatched: one watched share lets the witness see Bob.
    [
      unwatched({ encryption: NONE }),
      unwatched({ source: "screen_share_audio", desired: true }),
    ],
  ];
  for (const publications of cases) {
    const r = judgeBob(publications, true);
    assert.equal(r.bob, true, JSON.stringify(publications));
  }
});

test("F2: a mic (or camera) beside the share leaves the reading untouched", () => {
  for (const source of ["microphone", "camera"]) {
    const r = judgeBob(
      [
        unwatched({ source, desired: true, subscribed: true }),
        unwatched({ encryption: NONE }),
      ],
      true,
    );
    assert.equal(r.bob, true, source);
  }
  // Even an unwatched mic is not a share: the rule is scoped to shares.
  const r = judgeBob(
    [unwatched({ source: "microphone" }), unwatched({ encryption: NONE })],
    true,
  );
  assert.equal(r.bob, true);
});

test("F2: zero publications, or none supplied, leave the reading untouched", () => {
  assert.equal(judgeBob([], true).bob, true);
  assert.equal(judgeBob([], undefined).has, false);
  assert.equal(
    shareOnlyDeclarationContradicts({ identity: BOB, publicationCount: 1 }),
    false,
  );
  const observed = observedEncryptionMap([BOB], () => true, [
    { identity: BOB, publicationCount: 1 },
  ]);
  assert.deepEqual([...observed], [[BOB, true]]);
});

test("F2: a participant gate (b) does not judge gains no entry", () => {
  // Our own screen leg is excluded from the publisher set (§6.7). The rule
  // only rewrites identities that set already holds, and never adds one.
  const leg = `${ME}:screen`;
  const inputs = chipInputsFrom(
    sources({
      room: () =>
        room({
          participants: [
            { identity: ME, publicationCount: 1 },
            {
              identity: leg,
              publicationCount: 1,
              publications: [unwatched({ encryption: NONE })],
            },
          ],
        }),
    }),
  );
  assert.deepEqual(inputs.publishingIdentities, [ME]);
  assert.equal(inputs.observedEncrypted.has(leg), false);
});

// --- chipPublicationsOf: the F2 mapping that used to sit in state.tsx --------
//
// `state.tsx` reduces each remote publication to a `ChipPublication` for F2.
// Inline there, one token (`desired: true`, or a dropped `subscribed`)
// switched F2 off for every participant with every gate green, because
// `node --test` cannot load that file. These pin the mapping field for field.

/**
 * A stand-in for `RemoteTrackPublication`. There, `isDesired` and
 * `isSubscribed` are prototype GETTERS, so a mapping that spread the
 * publication instead of reading each field would silently lose both.
 */
class FakePub {
  readonly source: string;
  readonly trackInfo?: { encryption?: number };
  #desired: boolean;
  #subscribed: boolean;

  constructor(
    source: string,
    desired: boolean,
    subscribed: boolean,
    trackInfo?: { encryption?: number },
  ) {
    this.source = source;
    this.#desired = desired;
    this.#subscribed = subscribed;
    if (trackInfo) this.trackInfo = trackInfo;
  }

  get isDesired(): boolean {
    return this.#desired;
  }

  get isSubscribed(): boolean {
    return this.#subscribed;
  }
}

test("🔴 chipPublicationsOf maps each publication field for field, in order", () => {
  // Every desired/subscribed combination, so a swapped, constant or dropped
  // field changes at least one row.
  assert.deepEqual(
    chipPublicationsOf([
      new FakePub("screen_share", false, false, { encryption: GCM }),
      new FakePub("screen_share_audio", true, false, { encryption: GCM }),
      new FakePub("microphone", false, true, { encryption: GCM }),
      new FakePub("camera", true, true, { encryption: GCM }),
    ]),
    [
      {
        source: "screen_share",
        desired: false,
        subscribed: false,
        encryption: GCM,
      },
      {
        source: "screen_share_audio",
        desired: true,
        subscribed: false,
        encryption: GCM,
      },
      {
        source: "microphone",
        desired: false,
        subscribed: true,
        encryption: GCM,
      },
      { source: "camera", desired: true, subscribed: true, encryption: GCM },
    ],
  );
});

test("🔴 chipPublicationsOf: a MISSING trackInfo gives encryption undefined", () => {
  // Never a default: F2 compares with exactly GCM, so a defaulted GCM would
  // wave a dropped declaration through. The key is still present, exactly as
  // the inline mapping produced it.
  const absent = chipPublicationsOf([
    { source: "screen_share", isDesired: false, isSubscribed: false },
  ]);
  assert.deepEqual(absent, [
    {
      source: "screen_share",
      desired: false,
      subscribed: false,
      encryption: undefined,
    },
  ]);
  assert.equal(Object.hasOwn(absent[0], "encryption"), true);
  assert.deepEqual(
    chipPublicationsOf([
      {
        source: "screen_share",
        isDesired: false,
        isSubscribed: false,
        trackInfo: undefined,
      },
    ])[0].encryption,
    undefined,
  );
  assert.equal(
    chipPublicationsOf([new FakePub("screen_share", false, false)])[0]
      .encryption,
    undefined,
  );
});

test("🔴 chipPublicationsOf: a trackInfo WITHOUT encryption gives undefined", () => {
  assert.equal(
    chipPublicationsOf([new FakePub("screen_share", false, false, {})])[0]
      .encryption,
    undefined,
  );
});

test("chipPublicationsOf passes GCM, and every other value, through untouched", () => {
  // Judging the value is `shareOnlyDeclarationContradicts`'s job; the mapping
  // must not normalize NONE or an unknown enum value into anything else.
  for (const encryption of [GCM, NONE, 2, 7, -1]) {
    assert.equal(
      chipPublicationsOf([
        new FakePub("screen_share", false, false, { encryption }),
      ])[0].encryption,
      encryption,
    );
  }
});

test("chipPublicationsOf of an empty iterable is an empty array", () => {
  assert.deepEqual(chipPublicationsOf([]), []);
  assert.deepEqual(chipPublicationsOf(new Map<string, FakePub>().values()), []);
});

test("chipPublicationsOf reads a Map-values iterator, as trackPublications.values() is", () => {
  const trackPublications = new Map([
    ["TR_a", new FakePub("screen_share", false, false, { encryption: GCM })],
    ["TR_b", new FakePub("microphone", true, true)],
  ]);
  assert.deepEqual(chipPublicationsOf(trackPublications.values()), [
    {
      source: "screen_share",
      desired: false,
      subscribed: false,
      encryption: GCM,
    },
    {
      source: "microphone",
      desired: true,
      subscribed: true,
      encryption: undefined,
    },
  ]);
});

test("🔴 end to end: an unwatched share with NO declaration contradicts through chipPublicationsOf", () => {
  // The inline mapping's failure mode, driven through the real rule: with
  // `desired: true` hardcoded, or `subscribed` dropped, the first assertion
  // or one of the watched controls below flips.
  const bob = (pub: FakePub) => ({
    identity: BOB,
    publicationCount: 1,
    publications: chipPublicationsOf(new Map([["TR_s", pub]]).values()),
  });
  assert.equal(
    shareOnlyDeclarationContradicts(
      bob(new FakePub("screen_share", false, false)),
    ),
    true,
  );
  // ...and the whole assembly reads Bob not-encrypted, though LiveKit said
  // encrypted.
  const r = judgeBob(
    chipPublicationsOf([new FakePub("screen_share", false, false)]),
    true,
  );
  assert.equal(r.bob, false);
  assert.equal(r.chip, "resecuring");
  // The same share, watched in either sense, is the witness's to judge.
  assert.equal(
    shareOnlyDeclarationContradicts(
      bob(new FakePub("screen_share", true, false)),
    ),
    false,
  );
  assert.equal(
    shareOnlyDeclarationContradicts(
      bob(new FakePub("screen_share", false, true)),
    ),
    false,
  );
  // ...and unwatched but declared GCM, nothing contradicts.
  assert.equal(
    shareOnlyDeclarationContradicts(
      bob(new FakePub("screen_share", false, false, { encryption: GCM })),
    ),
    false,
  );
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
    latch: count("latch", undefined),
    rosterVerified: count("rosterVerified", [true]),
    channelHasOpenGroup: count("channelHasOpenGroup", true),
    deviceNeedsSetup: count("deviceNeedsSetup", false),
    peerCouldEncrypt: count("peerCouldEncrypt", true),
    decodeWitness: count("decodeWitness", {
      available: true,
      dropping: [],
      live: [],
    }),
    pausedByServer: count("pausedByServer", false),
    room: count("room", room()),
    observedEncryption: () => true,
  });
  assert.deepEqual(calls, {
    hasSession: 1,
    sessionState: 1,
    mode: 1,
    mediaHold: 1,
    latch: 1,
    rosterVerified: 1,
    channelHasOpenGroup: 1,
    deviceNeedsSetup: 1,
    peerCouldEncrypt: 1,
    decodeWitness: 1,
    pausedByServer: 1,
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

// --- fix round F: the paused seat and the presence the time bound reads ------

test("🔴 a paused device in a call is red through its accessor, with no group, no setup and no peer that could encrypt (B2)", () => {
  // The iPhone-to-iPhone call with the server switch off, and the one that
  // joined before the group opened: every no-session term says nothing.
  const seat = (paused: boolean) =>
    noSession({
      channelHasOpenGroup: () => false,
      deviceNeedsSetup: () => false,
      peerCouldEncrypt: () => false,
      pausedByServer: () => paused,
    });
  assert.equal(seat(true), "not_encrypted");
  assert.equal(seat(false), "none");
  assert.equal(
    chipInputsFrom(sources({ pausedByServer: () => true })).pausedByServer,
    true,
  );
});

test("🔴 presentIdentities is EVERY SFU participant, trackless ones and legs included, and empty with no room", () => {
  const LEG = "bob:d1:screen";
  const inputs = chipInputsFrom(
    sources({
      room: () =>
        room({
          participants: [
            { identity: ME, publicationCount: 1 },
            { identity: BOB, publicationCount: 0 },
            { identity: LEG, publicationCount: 1 },
          ],
        }),
    }),
  );
  assert.deepEqual(inputs.presentIdentities, [ME, BOB, LEG]);
  // ...where gate (b) only judges the publishers.
  assert.deepEqual(inputs.publishingIdentities, [ME, LEG]);
  assert.deepEqual(
    chipInputsFrom(sources({ room: () => undefined })).presentIdentities,
    [],
  );
});

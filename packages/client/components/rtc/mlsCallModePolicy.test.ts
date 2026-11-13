// Unit spec for the §3.4 mode machine + §4.4 chip + ctl parser (slice 6.5).
//   node --test components/rtc/mlsCallModePolicy.test.ts   (Node >=23.6 strips types)
// Focus: every numbered transition T0a–T7, the confirm-order invariant
// (set_e2ee(false) strictly before resume), T6-is-the-sole-interlude-exit
// (no warm-enable after a confirmed interlude), the chip precedence table
// (the seven-row loud order — `cannot_verify` from row 4 only) + each
// fail-closed degradation, the two-axis banner (kind + pause) every loud chip
// carries and the `securing` notice, the escape's `via` split, and
// default-closed ctl parsing.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CallBanner,
  type CallBannerInputs,
  type CallBannerKind,
  type CallMode,
  type CallModeEffect,
  type ChipInputs,
  type ChipLatch,
  type ChipState,
  type DecodeWitness,
  type LoudHealInputs,
  type PauseClause,
  DECODE_WITNESS_UNAVAILABLE,
  JOIN_WINDOW_PREDATES_DEPTH,
  MediaErrorLedger,
  WITNESS_AMBER_CONFIRM_MS,
  WITNESS_AMBER_ESCALATE_MS,
  WitnessAmberEscalation,
  bannerParksFloat,
  callBanner,
  callModeTransition,
  chipState,
  classifyEncryptionError,
  classifyMediaError,
  interludeStickyAcrossResecure,
  joinWindowMissPredatesEpoch,
  keyPairId,
  latestPresentAddedAt,
  loudHealVerdict,
  loudModeFallback,
  mixDetectedAction,
  modeUnderLoudLatch,
  parseCtlPayload,
  pauseClauseFor,
  plaintextReleaseAvailable,
  rotationWindowMs,
  summarizeDecodeWitness,
  witnessOnlyAmber,
} from "./mlsCallModePolicy.ts";

const NEGOTIATING: CallMode = { kind: "negotiating" };
const E2EE: CallMode = { kind: "e2ee" };
const MIXED: CallMode = { kind: "mixed" };
const INTERLUDE_UNCONF: CallMode = { kind: "interlude", localConfirmed: false };
const INTERLUDE_CONF: CallMode = { kind: "interlude", localConfirmed: true };
// What `local_confirm` mints since wave 2: every confirmed interlude carries
// WHO authorized it. `INTERLUDE_CONF` above is the shape with no
// `confirmedVia` — still a valid INPUT to the transitions that keep the mode.
const INTERLUDE_NATIVE: CallMode = {
  kind: "interlude",
  localConfirmed: true,
  confirmedVia: "native",
};
const INTERLUDE_APP: CallMode = {
  kind: "interlude",
  localConfirmed: true,
  confirmedVia: "app",
};

// ---- Mode machine ----------------------------------------------------------

test("T0a negotiating → off releases the negotiating gate (feature/toggle off)", () => {
  const t = callModeTransition(NEGOTIATING, { type: "verdict_plaintext" });
  assert.deepEqual(t.mode, { kind: "off" });
  assert.deepEqual(t.effects, [{ do: "resume", reason: "negotiating" }]);
});

test("T0b negotiating → e2ee on enable", () => {
  const t = callModeTransition(NEGOTIATING, { type: "enabled" });
  assert.deepEqual(t.mode, { kind: "e2ee" });
});

test("T0c negotiating → mixed swaps the gate (never publishes plaintext pre-enable)", () => {
  const t = callModeTransition(NEGOTIATING, { type: "mix_detected" });
  assert.deepEqual(t.mode, { kind: "mixed" });
  // Asserts the mixed gate BEFORE releasing negotiating — never a gap.
  assert.deepEqual(t.effects[0], { do: "pause", reason: "mixed" });
  assert.ok(
    t.effects.some((e) => e.do === "resume" && e.reason === "negotiating"),
  );
});

test("T1 e2ee → mixed pauses", () => {
  const t = callModeTransition(E2EE, { type: "mix_detected" });
  assert.deepEqual(t.mode, { kind: "mixed" });
  assert.ok(t.effects.some((e) => e.do === "pause" && e.reason === "mixed"));
});

test("T2 mixed → schedule warm reupgrade (viaSuccessor false) on mix clear", () => {
  const t = callModeTransition(MIXED, { type: "mix_cleared" });
  assert.deepEqual(t.mode, MIXED); // mode unchanged until the timer fires
  assert.deepEqual(t.effects, [
    { do: "schedule_reupgrade", viaSuccessor: false },
  ]);
});

test("T3 mixed → interlude(confirmed): set_e2ee(false) STRICTLY before resume, then announce", () => {
  const t = callModeTransition(MIXED, { type: "local_confirm" });
  assert.deepEqual(t.mode, INTERLUDE_NATIVE);
  const order = t.effects.map((e) => e.do);
  const iE2ee = order.indexOf("set_e2ee");
  const iResume = order.indexOf("resume");
  const iAnnounce = order.indexOf("announce");
  assert.ok(iE2ee >= 0 && iResume >= 0, "both present");
  assert.ok(iE2ee < iResume, "E2EE-off before resume (invariant 1)");
  assert.ok(iAnnounce > iResume || iAnnounce >= 0, "announce present");
  const setE2ee = t.effects.find((e) => e.do === "set_e2ee");
  assert.deepEqual(setE2ee, { do: "set_e2ee", enabled: false });
});

test("ME-10 terminal escape: local_confirm from negotiating → interlude(confirmed), E2EE-off first; releases enable-window but NOT negotiating (the lockstep releases that after effects)", () => {
  const t = callModeTransition(NEGOTIATING, { type: "local_confirm" });
  assert.deepEqual(t.mode, INTERLUDE_NATIVE);
  const order = t.effects.map((e) => e.do);
  assert.equal(order[0], "set_e2ee", "E2EE-off is the FIRST effect");
  assert.deepEqual(t.effects[0], { do: "set_e2ee", enabled: false });
  assert.ok(
    !t.effects.some((e) => e.do === "resume" && e.reason === "negotiating"),
    "no explicit `negotiating` resume — the mode lockstep releases it AFTER the effects complete",
  );
  // MED-B: a failed #enable leaves `enable-window` held — a confirmed
  // interlude must release it or the user stays paused forever.
  assert.ok(
    t.effects.some((e) => e.do === "resume" && e.reason === "enable-window"),
    "releases the enable-window gate reason",
  );
  const iE2ee = order.indexOf("set_e2ee");
  const iEnableResume = t.effects.findIndex(
    (e) => e.do === "resume" && e.reason === "enable-window",
  );
  assert.ok(iE2ee < iEnableResume, "E2EE-off strictly before any resume");
  assert.ok(order.includes("announce"));
});

test("MED-B: local_confirm from mixed ALSO releases enable-window (after set_e2ee + the mixed resume)", () => {
  const t = callModeTransition(MIXED, { type: "local_confirm" });
  const iE2ee = t.effects.findIndex((e) => e.do === "set_e2ee");
  const iEnableResume = t.effects.findIndex(
    (e) => e.do === "resume" && e.reason === "enable-window",
  );
  assert.ok(iEnableResume >= 0, "enable-window released");
  assert.ok(iE2ee < iEnableResume, "E2EE-off strictly first");
});

// The full effect list of a confirm, per route. Pinned as a WHOLE (not just by
// membership) so the ORDER — set_e2ee(false) strictly before any resume, the
// announce after the gate releases — cannot drift while the members stay.
const CONFIRM_EFFECTS_NATIVE: CallModeEffect[] = [
  { do: "set_e2ee", enabled: false },
  { do: "resume", reason: "mixed" },
  { do: "resume", reason: "enable-window" },
  { do: "announce" },
  { do: "cancel_reupgrade" },
];
const CONFIRM_EFFECTS_APP: CallModeEffect[] = CONFIRM_EFFECTS_NATIVE.filter(
  (e) => e.do !== "announce",
);

test("🔴 C1: local_confirm from negotiating ALSO releases `mixed` (kills escape-negotiating-keeps-mixed-held)", () => {
  // After a mix was declared and a re-establish ran, `#resetEnableState`
  // drops `#mixPaused` WITHOUT releasing the `mixed` gate reason, so a
  // terminal confirm from `negotiating` used to leave `mixed` held — paused,
  // under a banner saying the media was being sent. Releasing an un-held
  // reason is a no-op on the reason set, and `negotiating` itself stays held
  // until `#setMode` runs after these effects, so this cannot produce a
  // premature 1→0 edge.
  const t = callModeTransition(NEGOTIATING, { type: "local_confirm" });
  const iMixed = t.effects.findIndex(
    (e) => e.do === "resume" && e.reason === "mixed",
  );
  assert.ok(iMixed >= 0, "the mixed gate reason is released");
  const iE2ee = t.effects.findIndex((e) => e.do === "set_e2ee");
  assert.ok(iE2ee < iMixed, "E2EE-off strictly before the mixed resume");
  assert.deepEqual(t.effects, CONFIRM_EFFECTS_NATIVE);
});

test("local_confirm stamps confirmedVia: native when `via` is absent or native, and announces", () => {
  for (const mode of [MIXED, INTERLUDE_UNCONF, NEGOTIATING]) {
    const absent = callModeTransition(mode, { type: "local_confirm" });
    assert.deepEqual(absent.mode, INTERLUDE_NATIVE, mode.kind);
    const native = callModeTransition(mode, {
      type: "local_confirm",
      via: "native",
    });
    assert.deepEqual(native.mode, INTERLUDE_NATIVE, mode.kind);
    assert.deepEqual(native.effects, absent.effects, mode.kind);
    assert.ok(
      native.effects.some((e) => e.do === "announce"),
      mode.kind + ": the native route announces",
    );
  }
});

test("🔴 local_confirm via app OMITS the announce and stamps confirmedVia: app (kills escape-app-confirm-announces)", () => {
  // `callAnnounce` is native-gated on `mls_not_confirmed`; the in-app route
  // never armed a grant, so the announce would be refused (and a later T6
  // `callClearDowngrade` would run against a grant that never existed).
  // Everything else is identical: E2EE-off first, the same gate releases in
  // the same order, the same re-upgrade cancel.
  for (const mode of [MIXED, INTERLUDE_UNCONF, NEGOTIATING]) {
    const t = callModeTransition(mode, { type: "local_confirm", via: "app" });
    assert.deepEqual(t.mode, INTERLUDE_APP, mode.kind);
    assert.ok(
      !t.effects.some((e) => e.do === "announce"),
      mode.kind + ": no announce on the in-app route",
    );
    assert.deepEqual(t.effects, CONFIRM_EFFECTS_APP, mode.kind);
  }
});

test("local_confirm: the mixed / interlude arms keep their effect ORDER under the `via` split", () => {
  // T3 / T5 always ran set_e2ee(false) → resume mixed → resume enable-window
  // → announce → cancel_reupgrade; wave 2 only threads `via` through them.
  for (const mode of [MIXED, INTERLUDE_UNCONF])
    assert.deepEqual(
      callModeTransition(mode, { type: "local_confirm" }).effects,
      CONFIRM_EFFECTS_NATIVE,
      mode.kind,
    );
  // An already-confirmed interlude ignores a repeat confirm — no double
  // release, and an app confirm can never overwrite a native stamp.
  const repeat = callModeTransition(INTERLUDE_NATIVE, {
    type: "local_confirm",
    via: "app",
  });
  assert.deepEqual(repeat.mode, INTERLUDE_NATIVE);
  assert.deepEqual(repeat.effects, []);
});

test("T4 mixed → interlude(UNconfirmed) on remote announce — NEVER resumes publishing", () => {
  const t = callModeTransition(MIXED, { type: "remote_announce" });
  assert.deepEqual(t.mode, { kind: "interlude", localConfirmed: false });
  assert.ok(
    !t.effects.some((e) => e.do === "resume"),
    "a remote announce can never open the local plaintext path",
  );
  assert.ok(!t.effects.some((e) => e.do === "set_e2ee"));
});

test("T5 interlude(unconfirmed) → confirmed on local confirm, with the same confirm order", () => {
  const t = callModeTransition(INTERLUDE_UNCONF, { type: "local_confirm" });
  assert.deepEqual(t.mode, INTERLUDE_NATIVE);
  const order = t.effects.map((e) => e.do);
  assert.ok(order.indexOf("set_e2ee") < order.indexOf("resume"));
});

test("T6 interlude → schedule reupgrade viaSuccessor=true (fresh group, never warm)", () => {
  const t = callModeTransition(INTERLUDE_CONF, { type: "mix_cleared" });
  assert.deepEqual(t.effects, [
    { do: "schedule_reupgrade", viaSuccessor: true },
  ]);
});

test("T6 sole exit: an `enabled` event during an interlude NEVER warm-enables the old group (ME-6)", () => {
  for (const mode of [INTERLUDE_CONF, INTERLUDE_UNCONF]) {
    const t = callModeTransition(mode, { type: "enabled" });
    assert.deepEqual(
      t.mode,
      mode,
      "interlude ignores `enabled` — only mix_cleared→T6 exits",
    );
    assert.deepEqual(t.effects, []);
  }
});

test("T7 call_full is terminal + auto-leave, from any live mode", () => {
  for (const mode of [NEGOTIATING, E2EE, MIXED, INTERLUDE_CONF]) {
    const t = callModeTransition(mode, { type: "call_full" });
    assert.deepEqual(t.mode, { kind: "call_full" });
    assert.deepEqual(t.effects, [{ do: "auto_leave" }]);
  }
  // Terminal: further events keep call_full.
  const stay = callModeTransition(
    { kind: "call_full" },
    { type: "mix_cleared" },
  );
  assert.deepEqual(stay.mode, { kind: "call_full" });
});

test("interlude tolerates a NEW mix without changing mode (turnover, ME-16) but cancels reupgrade", () => {
  const t = callModeTransition(INTERLUDE_CONF, { type: "mix_detected" });
  assert.deepEqual(t.mode, INTERLUDE_CONF);
  assert.deepEqual(t.effects, [{ do: "cancel_reupgrade" }]);
});

test("resecure keeps the mode (the machine rides above group identity)", () => {
  for (const mode of [E2EE, MIXED, INTERLUDE_CONF]) {
    assert.deepEqual(callModeTransition(mode, { type: "resecure" }).mode, mode);
  }
});

test("🔴 interludeStickyAcrossResecure: only a NATIVE-confirmed interlude survives a re-secure (kills escape-app-interlude-sticky)", () => {
  // Consumed at `#dropModeToNegotiating` and `#resetEnableState` ONLY. A
  // native confirm is the per-device, group-bound authorization invariant 1
  // names and stays sticky; an app confirm authorized THIS plaintext window
  // and nothing about the group the re-secure is about to establish, so it is
  // withdrawn — without that the in-app route would mint a permanently
  // sticky interlude.
  assert.equal(interludeStickyAcrossResecure(INTERLUDE_NATIVE), true);
  // No `confirmedVia` at all: nothing mints this shape any more (the
  // transition always stamps; `state.tsx`'s in-app writer stamps `app`), and
  // the rule is pinned to its contract expression, `confirmedVia !== "app"`.
  assert.equal(interludeStickyAcrossResecure(INTERLUDE_CONF), true);
  assert.equal(interludeStickyAcrossResecure(INTERLUDE_APP), false);
  assert.equal(interludeStickyAcrossResecure(INTERLUDE_UNCONF), false);
  assert.equal(
    interludeStickyAcrossResecure({
      kind: "interlude",
      localConfirmed: false,
      confirmedVia: "app",
    }),
    false,
  );
  for (const mode of [
    undefined,
    NEGOTIATING,
    E2EE,
    MIXED,
    { kind: "off" } as const,
    { kind: "call_full" } as const,
  ])
    assert.equal(
      interludeStickyAcrossResecure(mode),
      false,
      mode?.kind ?? "undefined",
    );
});

test("off is terminal for mode purposes (a non-E2EE call has no group)", () => {
  const t = callModeTransition({ kind: "off" }, { type: "mix_detected" });
  assert.deepEqual(t.mode, { kind: "off" });
});

// ---- Chip precedence + fail-closed -----------------------------------------

// The latch shapes the chip splits on (`ChipLatch`). `DIRECT_LATCH` is what
// the two direct `state.tsx` writers produce (no `#latchLoud` snapshot);
// the others are `#latchLoud`'s `{ origin, mediaKeyed }` meta.
const DIRECT_LATCH: ChipLatch = { origin: undefined, mediaKeyed: false };
const MEDIA_KEYED: ChipLatch = { origin: "media", mediaKeyed: true };
const MEDIA_UNKEYED: ChipLatch = { origin: "media", mediaKeyed: false };
const CONTROL_KEYED: ChipLatch = { origin: "control", mediaKeyed: true };
const CONTROL_UNKEYED: ChipLatch = { origin: "control", mediaKeyed: false };

const baseChip = (over: Partial<ChipInputs>): ChipInputs => ({
  hasSession: true,
  sessionState: "active",
  mode: E2EE,
  e2eeEnabled: true,
  hasLocalKey: true,
  resecuring: false,
  latch: undefined,
  publishingIdentities: [],
  observedEncrypted: new Map(),
  localPublicationsEncrypted: true,
  rosterVerified: [true, true],
  channelHasOpenGroup: true,
  deviceNeedsSetup: false,
  peerCouldEncrypt: true,
  decodeWitness: { available: true, dropping: [], live: [] },
  pausedByServer: false,
  presentIdentities: ["alice:dA", "bob:d1"],
  ...over,
});

test("chip green requires ALL of (a) native, (b) observed-encrypted, (c) verified", () => {
  // Everyone muted (no publishers) ⇒ (b) vacuous ⇒ green off (a)+(c).
  assert.equal(chipState(baseChip({})), "e2ee");
  // A publishing participant observed encrypted ⇒ still green.
  assert.equal(
    chipState(
      baseChip({
        publishingIdentities: ["u:d"],
        observedEncrypted: new Map([["u:d", true]]),
      }),
    ),
    "e2ee",
  );
});

test("chip (b) fail-closed: a LOCAL publication not declared GCM is NOT green", () => {
  // The shipped-desktop shape (2026-09-06): worker status TRUE for us, the
  // peer observed encrypted, roster verified — and our mic on the SFU's
  // record as NONE. Every gate the old chip read was green.
  const inputs = baseChip({
    publishingIdentities: ["me:d", "peer:d"],
    observedEncrypted: new Map([
      ["me:d", true],
      ["peer:d", true],
    ]),
    localPublicationsEncrypted: false,
  });
  assert.equal(inputs.e2eeEnabled && inputs.hasLocalKey, true);
  assert.equal(
    chipState(inputs),
    "resecuring",
    "a NONE-declared local publication must never read green",
  );
  // Same inputs once the session has re-declared it: green (an unverified
  // roster still drops to amber-unverified as before).
  assert.equal(
    chipState({ ...inputs, localPublicationsEncrypted: true }),
    "e2ee",
  );
  assert.equal(
    chipState({
      ...inputs,
      localPublicationsEncrypted: true,
      rosterVerified: [true, false],
    }),
    "e2ee_unverified",
  );
});

test("chip: the local declaration never outranks a loud verdict or a mix", () => {
  // Even the keyed control latch: row 4 needs the declaration, so a NONE
  // publication drops it to row 5.
  assert.equal(
    chipState(
      baseChip({ localPublicationsEncrypted: false, latch: CONTROL_KEYED }),
    ),
    "not_encrypted",
  );
  assert.equal(
    chipState(baseChip({ localPublicationsEncrypted: false, mode: MIXED })),
    "not_encrypted",
  );
  // And it says nothing about a call that is not an E2EE call.
  assert.equal(
    chipState(
      baseChip({ localPublicationsEncrypted: false, mode: { kind: "off" } }),
    ),
    "none",
  );
});

test("chip (b) fail-closed: a publishing participant with missing/false status is NOT green", () => {
  assert.equal(
    chipState(
      baseChip({ publishingIdentities: ["u:d"], observedEncrypted: new Map() }),
    ),
    "resecuring",
    "missing status ⇒ amber, not green",
  );
  assert.equal(
    chipState(
      baseChip({
        publishingIdentities: ["u:d"],
        observedEncrypted: new Map([["u:d", false]]),
      }),
    ),
    "resecuring",
  );
});

test("chip trackless listener never blocks green (FE-2: only publishers gate (b))", () => {
  // A muted listener is NOT in publishingIdentities, so it cannot pin amber.
  assert.equal(
    chipState(
      baseChip({ publishingIdentities: [], observedEncrypted: new Map() }),
    ),
    "e2ee",
  );
});

test("chip (c): an unverified roster member ⇒ e2ee_unverified, not green", () => {
  assert.equal(
    chipState(baseChip({ rosterVerified: [true, false] })),
    "e2ee_unverified",
  );
});

test("chip precedence: not_encrypted beats everything", () => {
  assert.equal(chipState(baseChip({ mode: MIXED })), "not_encrypted");
  assert.equal(chipState(baseChip({ mode: INTERLUDE_CONF })), "not_encrypted");
  assert.equal(
    chipState(baseChip({ mode: { kind: "call_full" } })),
    "not_encrypted",
  );
  assert.equal(
    chipState(baseChip({ sessionState: "failed" })),
    "not_encrypted",
  );
  // Every latch shape that is not row 4 (rows 2, 3 and 5).
  for (const latch of [
    DIRECT_LATCH,
    MEDIA_KEYED,
    MEDIA_UNKEYED,
    CONTROL_UNKEYED,
  ])
    assert.equal(chipState(baseChip({ latch })), "not_encrypted", latch.origin);
});

// ---- The loud order of record (wave 2): rows 1–6 ----------------------------
//
// `cannot_verify` is reachable from exactly ONE rule (row 4): a CONTROL latch
// taken while this device was KEYED, with every local publication declared
// GCM and the decode witness reporting nothing dropping. Everything above it
// (a downgrade mode, an origin-less direct write, a media latch) and
// everything below it (any other latch, a `failed` nothing latched) reads
// `not_encrypted`. One spec per row; each names the mutation it kills.

test("chip row 1: a downgrade mode outranks even a keyed control latch", () => {
  for (const mode of [
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_NATIVE,
    { kind: "call_full" } as const,
  ])
    assert.equal(
      chipState(baseChip({ mode, latch: CONTROL_KEYED })),
      "not_encrypted",
      mode.kind,
    );
});

test("chip row 2: a latch with no origin (the direct state.tsx writers) → not_encrypted", () => {
  // The store-owner identity mismatch and `sessionSetupDecision`'s `hold_loud`
  // never went through `#latchLoud`, so there is no snapshot to split on —
  // whatever `mediaKeyed` says.
  assert.equal(chipState(baseChip({ latch: DIRECT_LATCH })), "not_encrypted");
  assert.equal(
    chipState(baseChip({ latch: { origin: undefined, mediaKeyed: true } })),
    "not_encrypted",
  );
});

test("chip row 3: a MEDIA latch → not_encrypted, even keyed", () => {
  // Frames failed to decrypt outside every window, or a re-securing never
  // resolved: the media plane itself is broken. Our send side being keyed
  // (the helper's path snapshots `mediaKeyed: true`) softens nothing.
  assert.equal(chipState(baseChip({ latch: MEDIA_KEYED })), "not_encrypted");
  assert.equal(chipState(baseChip({ latch: MEDIA_UNKEYED })), "not_encrypted");
});

test("🔴 chip row 4: control ∧ keyed ∧ local GCM ∧ witness not dropping → cannot_verify (kills chip-cannot-verify-collapses-to-not-encrypted)", () => {
  assert.equal(chipState(baseChip({ latch: CONTROL_KEYED })), "cannot_verify");
  // Unmoved by the gates below the loud rows: a publishing peer, an unverified
  // roster, a live witness, a rotation debounce.
  assert.equal(
    chipState(
      baseChip({
        latch: CONTROL_KEYED,
        publishingIdentities: ["u:d"],
        observedEncrypted: new Map([["u:d", true]]),
        rosterVerified: [true, false],
        resecuring: true,
        decodeWitness: { available: true, dropping: [], live: ["u:d"] },
      }),
    ),
    "cannot_verify",
  );
});

test("🔴 chip row 4 → 5: a DROPPING decode witness makes the keyed control latch not_encrypted (kills chip-cannot-verify-ignores-witness)", () => {
  // A sender's frames are arriving and being discarded: the media plane IS
  // failing, so "we can't confirm" would understate it.
  assert.equal(
    chipState(
      baseChip({
        latch: CONTROL_KEYED,
        decodeWitness: { available: true, dropping: ["u:d"], live: [] },
      }),
    ),
    "not_encrypted",
  );
});

test("🔴 chip row 4 → 5: an UN-KEYED control latch is not_encrypted (kills chip-cannot-verify-ignores-media-keyed)", () => {
  // `mediaKeyed: false` is what `#latchLoud` snapshots for a spent join
  // ladder, a media→control upgrade, a re-establish cap reached after the key
  // wipe, and a `MissingLocalFrameKeyError` (keyed while the CURRENT epoch
  // key is absent) — none may soften to "can't verify".
  assert.equal(
    chipState(baseChip({ latch: CONTROL_UNKEYED })),
    "not_encrypted",
  );
});

test("chip row 4 → 5: a local publication NOT declared GCM makes the keyed control latch not_encrypted", () => {
  assert.equal(
    chipState(
      baseChip({ latch: CONTROL_KEYED, localPublicationsEncrypted: false }),
    ),
    "not_encrypted",
  );
});

test("🔴 chip row 4 has NO `decodeWitness.available` conjunct: an unavailable witness still reads cannot_verify", () => {
  // An unpatched bundle, a dead worker, a stale tick — none can support the
  // POSITIVE claim "not encrypted"; "we can't confirm" is exactly what
  // `unavailable` means. (First-join control latches are un-keyed regardless,
  // so this cannot soften a first-join failure.)
  assert.equal(
    chipState(
      baseChip({
        latch: CONTROL_KEYED,
        decodeWitness: DECODE_WITNESS_UNAVAILABLE,
      }),
    ),
    "cannot_verify",
  );
});

test("🔴 chip row 6 sits BELOW row 4: `failed` + keyed control latch → cannot_verify (the #onLoud shape)", () => {
  // `#onLoud` sets `failed` BEFORE it calls `#latchLoud` — the only
  // `#setState("failed")` in the session — so every keyed mid-call control
  // site (a native build that threw, a DS commit arbitration classified
  // failed, a destroyed envelope) latches with `sessionState === "failed"`
  // and must still reach row 4.
  assert.equal(
    chipState(baseChip({ sessionState: "failed", latch: CONTROL_KEYED })),
    "cannot_verify",
  );
  // ...and it fails closed for a witness that IS dropping, as everywhere.
  assert.equal(
    chipState(
      baseChip({
        sessionState: "failed",
        latch: CONTROL_KEYED,
        decodeWitness: { available: true, dropping: ["u:d"], live: [] },
      }),
    ),
    "not_encrypted",
  );
});

test("chip row 6: `failed` with NO latch is the fail-closed backstop → not_encrypted", () => {
  assert.equal(
    chipState(baseChip({ sessionState: "failed", latch: undefined })),
    "not_encrypted",
  );
  // With an un-keyed latch it is row 5 — the same reading.
  assert.equal(
    chipState(baseChip({ sessionState: "failed", latch: CONTROL_UNKEYED })),
    "not_encrypted",
  );
});

test("chip resecuring beats unverified/green", () => {
  assert.equal(
    chipState(baseChip({ sessionState: "resecuring" })),
    "resecuring",
  );
  assert.equal(chipState(baseChip({ resecuring: true })), "resecuring");
});

// T-06-EXTENDED (6.6): a clean rotation's transient missing-key window must
// classify AMBER (resecuring), NEVER flip the chip loud to not_encrypted, and
// must RECOVER to green once media is observed encrypted again. Only a LATCHED
// error (past the session's 10 s escalation) is allowed to flip loud.
test("T-06-ext: a transient rotation-window resecuring stays amber, never not_encrypted", () => {
  // Rotation debounce active (media-plane), session still active, no latch.
  assert.equal(
    chipState(baseChip({ resecuring: true, latch: undefined })),
    "resecuring",
  );
  // Its media-plane form: a publishing participant momentarily lacks an
  // observed-encrypted status during the key swap ⇒ amber, NOT loud.
  assert.equal(
    chipState(
      baseChip({
        publishingIdentities: ["u:d"],
        observedEncrypted: new Map(), // status transiently missing mid-rotation
      }),
    ),
    "resecuring",
  );
});

test("T-06-ext: chip RECOVERS to green after the rotation window closes (no flap)", () => {
  // Same participant, status now observed encrypted again ⇒ back to green.
  assert.equal(
    chipState(
      baseChip({
        resecuring: false,
        publishingIdentities: ["u:d"],
        observedEncrypted: new Map([["u:d", true]]),
      }),
    ),
    "e2ee",
  );
});

test("T-06-ext: ONLY a latched error (post-escalation) flips a rotating call loud", () => {
  // Rotation window + a latched structured error ⇒ the latch wins (loud). This
  // is the 10 s-escalation outcome, not the transient window itself.
  assert.equal(
    chipState(baseChip({ resecuring: true, latch: MEDIA_KEYED })),
    "not_encrypted",
  );
  // The re-securing BACKSTOP (a control latch taken while re-securing, keys
  // intact, witness clean) is loud too — `cannot_verify`: the gate is held
  // and the copy says "can't confirm", never the positive "not encrypted".
  assert.equal(
    chipState(baseChip({ resecuring: true, latch: CONTROL_KEYED })),
    "cannot_verify",
  );
});

test("chip starting → none (no chrome flash on a plain voice call, FE-13)", () => {
  assert.equal(
    chipState(baseChip({ sessionState: "starting", mode: NEGOTIATING })),
    "none",
  );
});

test("chip plaintext/off/no-session with no open group → none", () => {
  assert.equal(
    chipState(
      baseChip({ sessionState: "plaintext", channelHasOpenGroup: false }),
    ),
    "none",
  );
  assert.equal(
    chipState(baseChip({ mode: { kind: "off" }, channelHasOpenGroup: false })),
    "none",
  );
  assert.equal(
    chipState({
      hasSession: false,
      e2eeEnabled: false,
      hasLocalKey: false,
      resecuring: false,
      latch: undefined,
      publishingIdentities: [],
      observedEncrypted: new Map(),
      localPublicationsEncrypted: true,
      rosterVerified: [],
      channelHasOpenGroup: false,
      deviceNeedsSetup: false,
      peerCouldEncrypt: true,
      decodeWitness: { available: true, dropping: [], live: [] },
      pausedByServer: false,
      presentIdentities: [],
    }),
    "none",
  );
});

test("chip ME-7/R2-4 + §0.2#9: NO session in a channel with an open group ⇒ not_encrypted", () => {
  assert.equal(
    chipState({
      hasSession: false,
      e2eeEnabled: false,
      hasLocalKey: false,
      resecuring: false,
      latch: undefined,
      publishingIdentities: [],
      observedEncrypted: new Map(),
      localPublicationsEncrypted: true,
      rosterVerified: [],
      channelHasOpenGroup: true,
      deviceNeedsSetup: false,
      peerCouldEncrypt: true,
      decodeWitness: { available: true, dropping: [], live: [] },
      pausedByServer: false,
      presentIdentities: [],
    }),
    "not_encrypted",
  );
});

test("chip: the open-group branch speaks for any shell, capable or not", () => {
  assert.equal(
    chipState({
      hasSession: false,
      e2eeEnabled: false,
      hasLocalKey: false,
      resecuring: false,
      latch: undefined,
      publishingIdentities: [],
      observedEncrypted: new Map(),
      localPublicationsEncrypted: true,
      rosterVerified: [],
      channelHasOpenGroup: true,
      deviceNeedsSetup: false,
      peerCouldEncrypt: true,
      decodeWitness: { available: true, dropping: [], live: [] },
      pausedByServer: false,
      presentIdentities: [],
    }),
    "not_encrypted",
  );
});

test("chip negotiating with an open group → amber (not green, not none)", () => {
  assert.equal(
    chipState(
      baseChip({ mode: NEGOTIATING, e2eeEnabled: false, hasLocalKey: false }),
    ),
    "resecuring",
  );
});

// ---- Which banner a chip carries (the no-dead-end invariant) ----------------

// Wave-3 defaults: a session exists — so the `securing` question is LIVE for
// any non-red chip a spec passes — and the pause verdict is quiet. The red
// table never reads `hasSession`, so the red-arm specs below are insensitive
// to it; the session-less seats say `hasSession: false` in full, because that
// is the discriminator that keeps them on their device arm.
const baseBanner = (over: Partial<CallBannerInputs>): CallBannerInputs => ({
  chip: "not_encrypted",
  mode: undefined,
  latchedError: false,
  readiness: "needs_setup",
  hasSession: true,
  pauseDisproved: false,
  pauseDisproofConfirmed: false,
  ...over,
});

test("banner: the §3.4 downgrade modes keep their own banners", () => {
  assert.equal(
    callBanner(baseBanner({ mode: MIXED, readiness: "ready" })).kind,
    "mixed",
  );
  assert.equal(
    callBanner(baseBanner({ mode: INTERLUDE_CONF, readiness: "ready" })).kind,
    "interlude",
  );
  assert.equal(
    callBanner(baseBanner({ mode: INTERLUDE_UNCONF, readiness: "ready" })).kind,
    "interlude",
  );
});

test("banner: a ready device with a red chip is a CALL failure — terminal loud", () => {
  assert.equal(
    callBanner(
      baseBanner({ mode: NEGOTIATING, latchedError: true, readiness: "ready" }),
    ).kind,
    "terminal_loud",
  );
  // The capable-but-sessionless R2-4 hold: `negotiating` is still in the
  // publish gate and the error IS latched, so "your audio and video stay
  // paused" is true.
  assert.equal(
    callBanner(baseBanner({ latchedError: true, readiness: "ready" })).kind,
    "terminal_loud",
  );
});

test("🔴 banner: call_full is no longer silent (it latches, and the gate is held)", () => {
  // `#onCallFull` runs `#onLoud` before `#applyMode({type:"call_full"})`, so
  // the error is latched and `loudModeFallback` has re-asserted the
  // negotiating gate — the loud copy is true. `redBannerKind` reads the latch,
  // not the mode: the old mode-keyed predicate the banner once routed through
  // read false here (the mode is not negotiating) and left this red chip bare.
  assert.equal(
    callBanner(
      baseBanner({
        mode: { kind: "call_full" },
        latchedError: true,
        readiness: "ready",
      }),
    ).kind,
    "terminal_loud",
  );
});

test("banner: a device that cannot encrypt owns the banner, whatever the call did", () => {
  // Nothing about the CALL is the cause, so the loud copy and a per-call
  // escape would both be wrong: this is the §7.4 red-chip-with-no-banner
  // state. Holds even with a latched error, which `owned_elsewhere` always
  // has (it stays capable and the setup decision holds it loud).
  assert.equal(
    callBanner(baseBanner({ readiness: "needs_setup" })).kind,
    "device_not_set_up",
  );
  assert.equal(
    callBanner(baseBanner({ readiness: "owned_elsewhere", latchedError: true }))
      .kind,
    "device_not_set_up",
  );
  assert.equal(
    callBanner(baseBanner({ readiness: "unsupported" })).kind,
    "device_unsupported",
  );
});

test("🔴 banner: an unknown-cause red chip never falls back to 'this app can't encrypt'", () => {
  // `unsupported` is a POSITIVE fact the shell knows about itself. Making it
  // the fallback for "we don't know" tells someone whose call just failed the
  // most reassuring and least actionable thing available (reviewer F4). The
  // floor is the loud banner when something latched, and the no-claims notice
  // when nothing did — never a statement about the shell.
  for (const latchedError of [false, true])
    assert.notEqual(
      callBanner(
        baseBanner({ readiness: "ready", mode: { kind: "off" }, latchedError }),
      ).kind,
      "device_unsupported",
    );
  assert.equal(
    callBanner(
      baseBanner({
        readiness: "ready",
        mode: { kind: "off" },
        latchedError: true,
      }),
    ).kind,
    "terminal_loud",
  );
});

test("banner: nothing to say on a green, amber or chrome-less chip", () => {
  for (const chip of ["e2ee", "e2ee_unverified", "resecuring", "none"] as const)
    for (const readiness of [
      "ready",
      "needs_setup",
      "owned_elsewhere",
      "unsupported",
      "paused",
    ] as const)
      assert.equal(
        callBanner(baseBanner({ chip, mode: E2EE, readiness })).kind,
        "none",
      );
});

test("🔴 banner: a cannot_verify chip is never bannerless (kills banner-state-cannot-verify-bannerless)", () => {
  // It is only reachable WITH a session (a keyed control latch), so the
  // device is `ready` by construction — but the rule is total, and it sits
  // ahead of the device arms and of the `!== "not_encrypted"` guard that
  // would otherwise read it as "not red" and return `none`.
  const MODES: (CallMode | undefined)[] = [
    undefined,
    NEGOTIATING,
    { kind: "off" },
    E2EE,
    { kind: "call_full" },
  ];
  for (const mode of MODES)
    for (const latchedError of [false, true])
      for (const hasSession of [false, true])
        for (const readiness of [
          "ready",
          "needs_setup",
          "owned_elsewhere",
          "unsupported",
          "paused",
        ] as const)
          assert.equal(
            callBanner({
              chip: "cannot_verify",
              mode,
              latchedError,
              readiness,
              hasSession,
              pauseDisproved: false,
              pauseDisproofConfirmed: false,
            }).kind,
            "cannot_verify",
            JSON.stringify({ mode, latchedError, readiness, hasSession }),
          );
  // The §3.4 downgrade modes keep their own banners ahead of it (row 1 wins
  // the chip too, so the pair never co-occurs; the banner rule is still
  // total).
  assert.equal(
    callBanner(
      baseBanner({ chip: "cannot_verify", mode: MIXED, readiness: "ready" }),
    ).kind,
    "mixed",
  );
  assert.equal(
    callBanner(
      baseBanner({
        chip: "cannot_verify",
        mode: INTERLUDE_NATIVE,
        readiness: "ready",
      }),
    ).kind,
    "interlude",
  );
  // ...and it parks the Watch Together player like the other actionable ones
  // — the KIND parks it, ahead of any pause verdict, so a quiet `held` row
  // parks exactly like the derived banner does.
  assert.equal(
    bannerParksFloat(
      callBanner(
        baseBanner({
          chip: "cannot_verify",
          mode: NEGOTIATING,
          latchedError: true,
          readiness: "ready",
        }),
      ),
    ),
    true,
  );
  assert.equal(
    bannerParksFloat({ kind: "cannot_verify", pause: "held" }),
    true,
  );
});

test("🔴 a REFUSED device is loud with no dependence on the open-group probe", () => {
  // The hole the first cut of this fix opened (reviewer F1, CRITICAL): a
  // device treated as non-capable asserts no gate, latches nothing, and
  // `chipState`'s no-session branches are gated on `channelHasOpenGroup` — so
  // alone in a channel with no group yet it published plaintext under chip
  // `none` with NO chrome at all. Staying CAPABLE is what fixes it: the setup
  // decision holds loud, the error latches as a direct `state.tsx` write (no
  // origin — row 2 of the chip's loud order), ahead of every probe-dependent
  // branch.
  for (const channelHasOpenGroup of [false, true]) {
    const chip = chipState(
      baseChip({
        hasSession: false,
        sessionState: undefined,
        mode: undefined,
        e2eeEnabled: false,
        hasLocalKey: false,
        latch: DIRECT_LATCH,
        rosterVerified: [],
        channelHasOpenGroup,
        deviceNeedsSetup: false,
        peerCouldEncrypt: true,
      }),
    );
    assert.equal(chip, "not_encrypted", `probe=${channelHasOpenGroup}`);
    assert.equal(
      callBanner({
        chip,
        mode: undefined,
        latchedError: true,
        readiness: "owned_elsewhere",
        // `hold_loud` builds no session: the device arm owns this seat, and
        // `securing` — which needs one — can never mask it.
        hasSession: false,
        pauseDisproved: false,
        pauseDisproofConfirmed: false,
      }).kind,
      "device_not_set_up",
    );
  }
});

test("🔴 a device that could be set up is loud with NO open group, if a peer can encrypt", () => {
  // Was a pinned KNOWN GAP. A never-enrolled desktop is not capable, so it
  // latches nothing, and `channelHasOpenGroup` is probed ONCE at connect: if
  // the group opened afterwards the device stayed on chip `none` for the whole
  // call while every peer paused behind a banner naming it. `deviceNeedsSetup`
  // is LOCAL and `peerCouldEncrypt` is LIVE, so together they cannot go stale.
  for (const channelHasOpenGroup of [false, true]) {
    const chip = chipState(
      baseChip({
        hasSession: false,
        sessionState: undefined,
        mode: undefined,
        e2eeEnabled: false,
        hasLocalKey: false,
        rosterVerified: [],
        channelHasOpenGroup,
        deviceNeedsSetup: true,
        peerCouldEncrypt: true,
      }),
    );
    assert.equal(chip, "not_encrypted", `probe=${channelHasOpenGroup}`);
    assert.equal(
      callBanner({
        chip,
        mode: undefined,
        latchedError: false,
        readiness: "needs_setup",
        // Never enrolled: nothing was attempted, so there is no session to
        // be securing with.
        hasSession: false,
        pauseDisproved: false,
        pauseDisproofConfirmed: false,
      }).kind,
      "device_not_set_up",
    );
  }
});

test("🔴 ...and says NOTHING on a call where nobody can encrypt", () => {
  // `shellSupported` is true on every Tauri desktop and every native Android
  // build, not just where media E2EE has shipped, so an unqualified local term
  // would put a red chip and an undismissable strip on EVERY call for every
  // install that never turned encryption on — including plain calls with
  // nothing to downgrade (media-e2ee-reviewer round 3, finding 2).
  assert.equal(
    chipState(
      baseChip({
        hasSession: false,
        sessionState: undefined,
        mode: undefined,
        e2eeEnabled: false,
        hasLocalKey: false,
        rosterVerified: [],
        channelHasOpenGroup: false,
        deviceNeedsSetup: true,
        peerCouldEncrypt: false,
      }),
    ),
    "none",
  );
});

test("a shell that can NEVER encrypt still rides the probe — no nagging on a plain call", () => {
  // `unsupported` has nothing to set up, so telling it on every call in every
  // channel would be noise. It speaks only when someone else in the call is
  // actually encrypting, which is what the open-group probe answers.
  const quiet = chipState(
    baseChip({
      hasSession: false,
      sessionState: undefined,
      mode: undefined,
      e2eeEnabled: false,
      hasLocalKey: false,
      rosterVerified: [],
      channelHasOpenGroup: false,
      deviceNeedsSetup: false,
      peerCouldEncrypt: true,
    }),
  );
  assert.equal(quiet, "none");
  assert.equal(
    callBanner({
      chip: quiet,
      mode: undefined,
      latchedError: false,
      readiness: "unsupported",
      hasSession: false,
      pauseDisproved: false,
      pauseDisproofConfirmed: false,
    }).kind,
    "none",
  );
});

test("🔴 an unlatched red chip on a ready device promises nothing (MEDIUM-1)", () => {
  // The term that decides whether a banner may say "your audio and video stay
  // paused". It was accepted and ignored once, and that is how a red strip
  // came to promise a pause over a live, ungated mic.
  assert.equal(
    callBanner(baseBanner({ readiness: "ready", latchedError: false })).kind,
    "unencrypted_notice",
  );
  assert.equal(
    callBanner(baseBanner({ readiness: "ready", latchedError: true })).kind,
    "terminal_loud",
  );
});

// ---- the securing notice and the pause axis (wave 3) -----------------------

// The ten kinds and six chips, pinned as records so an eleventh kind (or a
// seventh chip) cannot be added to the type without landing in every sweep
// below.
const KIND_TABLE: Record<CallBannerKind, 0> = {
  none: 0,
  securing: 0,
  mixed: 0,
  interlude: 0,
  terminal_loud: 0,
  cannot_verify: 0,
  device_not_set_up: 0,
  device_unsupported: 0,
  ios_paused: 0,
  unencrypted_notice: 0,
};
const ALL_KINDS = Object.keys(KIND_TABLE) as CallBannerKind[];
const CHIP_TABLE: Record<ChipState, 0> = {
  none: 0,
  e2ee: 0,
  e2ee_unverified: 0,
  resecuring: 0,
  cannot_verify: 0,
  not_encrypted: 0,
};
const ALL_CHIPS = Object.keys(CHIP_TABLE) as ChipState[];
const ALL_READINESS = [
  "ready",
  "needs_setup",
  "owned_elsewhere",
  "unsupported",
  "paused",
] as const;
const ALL_MODES: (CallMode | undefined)[] = [
  undefined,
  NEGOTIATING,
  { kind: "off" },
  E2EE,
  MIXED,
  INTERLUDE_UNCONF,
  INTERLUDE_CONF,
  INTERLUDE_NATIVE,
  INTERLUDE_APP,
  { kind: "call_full" },
];
// The four pause-verdict shapes: [pauseDisproved, pauseDisproofConfirmed].
const FLAGS: [boolean, boolean][] = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
];

// The rules of record (w3_CONTRACT / plan "Approach" wave 3), restated here
// independently of the policy's code so the sweeps have an oracle that is
// not the implementation:
//   raise     : kind !== "none" ⇔ the pre-wave-3 red condition ∨ securing
//   securing  : hasSession ∧ mode ∈ {undefined, negotiating} ∧ chip ∉ red
//   disproved : pauseDisproved ∧ pauseDisproofConfirmed, on a RAISED banner
//   held      : securing / mixed / interlude(!localConfirmed) / terminal_loud
//               / cannot_verify / device_not_set_up on a REFUSED device
//   none      : everything else — and every hidden banner, flags or not
const redChip = (chip: ChipState) =>
  chip === "not_encrypted" || chip === "cannot_verify";
const oldRedRaise = (i: CallBannerInputs) =>
  i.mode?.kind === "mixed" || i.mode?.kind === "interlude" || redChip(i.chip);
const securingRule = (i: CallBannerInputs) =>
  i.hasSession &&
  (i.mode === undefined || i.mode.kind === "negotiating") &&
  !redChip(i.chip);
const heldRule = (kind: CallBannerKind, i: CallBannerInputs): boolean => {
  switch (kind) {
    case "securing":
    case "mixed":
    case "terminal_loud":
    case "cannot_verify":
      return true;
    case "interlude":
      return !(i.mode?.kind === "interlude" && i.mode.localConfirmed);
    case "device_not_set_up":
      return i.readiness === "owned_elsewhere";
    case "device_unsupported":
    case "ios_paused":
    case "unencrypted_notice":
    case "none":
      return false;
  }
  const exhaustive: never = kind;
  return exhaustive;
};
const expectedPause = (
  kind: CallBannerKind,
  i: CallBannerInputs,
): PauseClause =>
  kind === "none"
    ? "none"
    : i.pauseDisproved && i.pauseDisproofConfirmed
      ? "disproved"
      : heldRule(kind, i)
        ? "held"
        : "none";

// One input per raised kind, each producing that kind THROUGH `callBanner` —
// so the pause table is pinned on derived banners, never on a kind handed in
// by name.
const KIND_INPUTS: Record<Exclude<CallBannerKind, "none">, CallBannerInputs> = {
  securing: baseBanner({ chip: "none", mode: undefined, readiness: "ready" }),
  mixed: baseBanner({ mode: MIXED, readiness: "ready" }),
  interlude: baseBanner({ mode: INTERLUDE_UNCONF, readiness: "ready" }),
  terminal_loud: baseBanner({
    mode: NEGOTIATING,
    latchedError: true,
    readiness: "ready",
  }),
  cannot_verify: baseBanner({
    chip: "cannot_verify",
    mode: NEGOTIATING,
    latchedError: true,
    readiness: "ready",
  }),
  // The refused device: `owned_elsewhere`, capable, held loud, no session.
  device_not_set_up: baseBanner({
    hasSession: false,
    latchedError: true,
    readiness: "owned_elsewhere",
  }),
  device_unsupported: baseBanner({
    hasSession: false,
    readiness: "unsupported",
  }),
  ios_paused: baseBanner({
    hasSession: false,
    readiness: "paused",
  }),
  unencrypted_notice: baseBanner({
    mode: { kind: "off" },
    latchedError: false,
    readiness: "ready",
  }),
};
const HELD_KINDS = [
  "securing",
  "mixed",
  "interlude",
  "terminal_loud",
  "cannot_verify",
  "device_not_set_up",
] as const;

test("🔴 securing: reachable EXACTLY for hasSession ∧ mode ∈ {undefined, negotiating} ∧ chip not red (kills banner-securing-unreachable)", () => {
  // Enumerated over every chip × every mode × both sessions × both latches ×
  // every readiness, asserting the rule in BOTH directions — then the two
  // shapes the product actually produces, by name.
  let hits = 0;
  for (const chip of ALL_CHIPS)
    for (const mode of ALL_MODES)
      for (const hasSession of [false, true])
        for (const latchedError of [false, true])
          for (const readiness of ALL_READINESS) {
            const inputs = baseBanner({
              chip,
              mode,
              hasSession,
              latchedError,
              readiness,
            });
            const { kind } = callBanner(inputs);
            assert.equal(
              kind === "securing",
              securingRule(inputs),
              JSON.stringify({ kind, ...inputs }),
            );
            if (kind === "securing") hits++;
          }
  // 4 non-red chips × 2 undecided modes × WITH a session × 2 latches × 5
  // readiness — the rule reads neither the latch nor the readiness.
  assert.equal(hits, 4 * 2 * 1 * 2 * 5);
  // First join, pre-verdict: the session's initial `negotiating` is a field
  // initialiser, never pushed through `#setMode`, so `mode` is undefined and
  // the chip is `none` (state `starting`).
  assert.deepEqual(
    callBanner(
      baseBanner({ chip: "none", mode: undefined, readiness: "ready" }),
    ),
    { kind: "securing", pause: "held" },
  );
  // Rejoin: `negotiating` was emitted and the chip is amber.
  assert.deepEqual(
    callBanner(
      baseBanner({ chip: "resecuring", mode: NEGOTIATING, readiness: "ready" }),
    ),
    { kind: "securing", pause: "held" },
  );
});

test("securing: never under a decided mode — e2ee, off, mixed, interlude, call_full — whatever the chip", () => {
  const DECIDED: CallMode[] = [
    E2EE,
    { kind: "off" },
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_CONF,
    INTERLUDE_NATIVE,
    INTERLUDE_APP,
    { kind: "call_full" },
  ];
  for (const chip of ALL_CHIPS)
    for (const mode of DECIDED)
      for (const latchedError of [false, true])
        assert.notEqual(
          callBanner(
            baseBanner({ chip, mode, latchedError, readiness: "ready" }),
          ).kind,
          "securing",
          JSON.stringify({ chip, mode, latchedError }),
        );
  // The green and plain rows stay bannerless: nothing is being secured.
  assert.deepEqual(
    callBanner(baseBanner({ chip: "e2ee", mode: E2EE, readiness: "ready" })),
    { kind: "none", pause: "none" },
  );
  assert.deepEqual(
    callBanner(
      baseBanner({ chip: "none", mode: { kind: "off" }, readiness: "ready" }),
    ),
    { kind: "none", pause: "none" },
  );
});

test("🔴 securing: never without a session — a session-less seat reads its device arm (hasSession is the discriminator)", () => {
  // The session-less setup arms (`hold_loud`, `owned_elsewhere`) hold the
  // `negotiating` gate without ever building a session, and `mode` is
  // undefined there exactly as it is on a first join. Only a session is
  // securing anything; without one the readiness arms own the banner.
  const seat = (over: Partial<CallBannerInputs>) =>
    callBanner(baseBanner({ mode: undefined, hasSession: false, ...over }));
  // R2-4: a refused device — capable, held loud, latched.
  assert.deepEqual(seat({ latchedError: true, readiness: "owned_elsewhere" }), {
    kind: "device_not_set_up",
    pause: "held",
  });
  // Never enrolled: nothing attempted, nothing held.
  assert.deepEqual(seat({ latchedError: false, readiness: "needs_setup" }), {
    kind: "device_not_set_up",
    pause: "none",
  });
  // The capable-but-sessionless hold on a ready device: loud, not securing.
  assert.deepEqual(seat({ latchedError: true, readiness: "ready" }), {
    kind: "terminal_loud",
    pause: "held",
  });
  // A browser: nothing to secure, nothing to set up.
  assert.deepEqual(seat({ latchedError: false, readiness: "unsupported" }), {
    kind: "device_unsupported",
    pause: "none",
  });
  // And a non-red chip with no session, under either undecided mode, on any
  // device: no banner at all — `securing` needs the session.
  for (const chip of ["none", "resecuring"] as const)
    for (const mode of [undefined, NEGOTIATING])
      for (const readiness of ALL_READINESS)
        assert.deepEqual(
          seat({ chip, mode, readiness }),
          { kind: "none", pause: "none" },
          JSON.stringify({ chip, mode, readiness }),
        );
});

test("🔴 securing: never over a red chip — cannot_verify and not_encrypted keep their red kind under an undecided mode", () => {
  for (const mode of [undefined, NEGOTIATING])
    for (const latchedError of [false, true]) {
      const red = (over: Partial<CallBannerInputs>) =>
        callBanner(baseBanner({ mode, latchedError, ...over })).kind;
      assert.equal(
        red({ chip: "cannot_verify", readiness: "ready" }),
        "cannot_verify",
      );
      assert.equal(
        red({ chip: "not_encrypted", readiness: "ready" }),
        latchedError ? "terminal_loud" : "unencrypted_notice",
      );
      for (const readiness of ["needs_setup", "owned_elsewhere"] as const)
        assert.equal(
          red({ chip: "not_encrypted", readiness }),
          "device_not_set_up",
        );
      assert.equal(
        red({ chip: "not_encrypted", readiness: "unsupported" }),
        "device_unsupported",
      );
      assert.equal(
        red({ chip: "not_encrypted", readiness: "paused" }),
        "ios_paused",
      );
    }
});

test("🔴 pause: disproved iff BOTH halves of the verdict (kills banner-disproof-raises-unconfirmed and banner-disproof-ignored)", () => {
  // `{ value: true, confirmed: false }` is a budget-exhausted single
  // observation: it stays on the kind's own row, whose `held` copy already
  // hedges. A CONFIRMED disproof overrides every raised kind — including the
  // `none`-pause ones, whose copy otherwise says nothing about a pause.
  for (const [kind, base] of Object.entries(KIND_INPUTS) as [
    CallBannerKind,
    CallBannerInputs,
  ][]) {
    const own = callBanner(base).pause;
    for (const [pauseDisproved, pauseDisproofConfirmed] of FLAGS) {
      const banner = callBanner({
        ...base,
        pauseDisproved,
        pauseDisproofConfirmed,
      });
      // The flags never move the KIND.
      assert.equal(
        banner.kind,
        kind,
        JSON.stringify({ expected: kind, ...banner }),
      );
      assert.equal(
        banner.pause,
        pauseDisproved && pauseDisproofConfirmed ? "disproved" : own,
        JSON.stringify({ kind, pauseDisproved, pauseDisproofConfirmed }),
      );
    }
  }
  const pauseOf = (
    kind: (typeof HELD_KINDS)[number],
    flags: [boolean, boolean],
  ) =>
    callBanner({
      ...KIND_INPUTS[kind],
      pauseDisproved: flags[0],
      pauseDisproofConfirmed: flags[1],
    }).pause;
  for (const kind of HELD_KINDS) {
    // {true, false}: the mutation that drops the `confirmed` conjunct reads
    // this as disproved.
    assert.equal(pauseOf(kind, [true, false]), "held", `${kind} {true,false}`);
    // {false, true}: a confirmation of NOTHING — no alarm to confirm.
    assert.equal(pauseOf(kind, [false, true]), "held", `${kind} {false,true}`);
    // {false, false}: the kind's own row.
    assert.equal(
      pauseOf(kind, [false, false]),
      "held",
      `${kind} {false,false}`,
    );
    // {true, true}: the mutation that ignores `pauseDisproved` reads this as
    // held.
    assert.equal(
      pauseOf(kind, [true, true]),
      "disproved",
      `${kind} {true,true}`,
    );
  }
});

test("🔴 a hidden banner carries no pause clause, flags or not (kills banner-hidden-carries-pause)", () => {
  // A transient `{ none, disproved }` would park the float for a beat through
  // `bannerParksFloat`, with nothing rendered to say why. The guard is the
  // FIRST line of `pauseClauseFor`: a hidden banner has no Line B.
  const HIDDEN: CallBannerInputs[] = [
    baseBanner({ chip: "e2ee", mode: E2EE, readiness: "ready" }),
    baseBanner({ chip: "e2ee_unverified", mode: E2EE, readiness: "ready" }),
    baseBanner({ chip: "resecuring", mode: E2EE, readiness: "ready" }),
    baseBanner({ chip: "none", mode: { kind: "off" }, readiness: "ready" }),
    baseBanner({
      chip: "none",
      mode: undefined,
      hasSession: false,
      readiness: "ready",
    }),
  ];
  for (const base of HIDDEN)
    for (const [pauseDisproved, pauseDisproofConfirmed] of FLAGS) {
      const inputs = { ...base, pauseDisproved, pauseDisproofConfirmed };
      assert.deepEqual(
        callBanner(inputs),
        { kind: "none", pause: "none" },
        JSON.stringify(inputs),
      );
      assert.equal(pauseClauseFor("none", inputs), "none");
      assert.equal(bannerParksFloat(callBanner(inputs)), false);
    }
});

test("pause: the held / none table, row by row (derived banners and the exported table agree)", () => {
  const rows: [CallBannerInputs, CallBanner][] = [
    [KIND_INPUTS.securing, { kind: "securing", pause: "held" }],
    [KIND_INPUTS.mixed, { kind: "mixed", pause: "held" }],
    [KIND_INPUTS.interlude, { kind: "interlude", pause: "held" }],
    [
      baseBanner({ mode: INTERLUDE_CONF, readiness: "ready" }),
      { kind: "interlude", pause: "none" },
    ],
    [
      baseBanner({ mode: INTERLUDE_NATIVE, readiness: "ready" }),
      { kind: "interlude", pause: "none" },
    ],
    [
      baseBanner({ mode: INTERLUDE_APP, readiness: "ready" }),
      { kind: "interlude", pause: "none" },
    ],
    [KIND_INPUTS.terminal_loud, { kind: "terminal_loud", pause: "held" }],
    [KIND_INPUTS.cannot_verify, { kind: "cannot_verify", pause: "held" }],
    // refused (`owned_elsewhere`) vs never enrolled (`needs_setup`)
    [
      KIND_INPUTS.device_not_set_up,
      { kind: "device_not_set_up", pause: "held" },
    ],
    [
      baseBanner({
        hasSession: false,
        latchedError: false,
        readiness: "needs_setup",
      }),
      { kind: "device_not_set_up", pause: "none" },
    ],
    [
      KIND_INPUTS.device_unsupported,
      { kind: "device_unsupported", pause: "none" },
    ],
    [
      KIND_INPUTS.unencrypted_notice,
      { kind: "unencrypted_notice", pause: "none" },
    ],
    [
      baseBanner({ chip: "e2ee", mode: E2EE, readiness: "ready" }),
      { kind: "none", pause: "none" },
    ],
  ];
  for (const [inputs, expected] of rows) {
    const banner = callBanner(inputs);
    assert.deepEqual(banner, expected, JSON.stringify(inputs));
    assert.equal(pauseClauseFor(banner.kind, inputs), expected.pause);
  }
  // The refused device is the one `device_not_set_up` that holds: it is
  // `owned_elsewhere`, still capable, so the setup decision answers
  // `hold_loud` — gate asserted, error latched in one step. `needs_setup`
  // attempts nothing and holds nothing, latched or not.
  assert.equal(
    callBanner(
      baseBanner({
        hasSession: false,
        latchedError: true,
        readiness: "needs_setup",
      }),
    ).pause,
    "none",
  );
});

test("🔴 the banner over its WHOLE input space: raise, securing, pause and park follow the rules of record (exhaustive)", () => {
  // 6 chips × 10 modes × 2 latches × 5 readiness × 2 sessions × 4 verdicts
  // = 4800 shapes — the banner's entire domain, so nothing here is sampled.
  // Every one of the ten kinds must be produced, or a rule is being
  // asserted over a row nobody reached.
  const seen = new Set<CallBannerKind>();
  let shapes = 0;
  for (const chip of ALL_CHIPS)
    for (const mode of ALL_MODES)
      for (const latchedError of [false, true])
        for (const readiness of ALL_READINESS)
          for (const hasSession of [false, true])
            for (const [pauseDisproved, pauseDisproofConfirmed] of FLAGS) {
              const inputs: CallBannerInputs = {
                chip,
                mode,
                latchedError,
                readiness,
                hasSession,
                pauseDisproved,
                pauseDisproofConfirmed,
              };
              const banner = callBanner(inputs);
              const at = () => JSON.stringify({ banner, ...inputs });
              shapes++;
              seen.add(banner.kind);
              assert.equal(
                banner.kind !== "none",
                oldRedRaise(inputs) || securingRule(inputs),
                `raise: ${at()}`,
              );
              assert.equal(
                banner.kind === "securing",
                securingRule(inputs),
                `securing: ${at()}`,
              );
              assert.equal(
                banner.pause,
                expectedPause(banner.kind, inputs),
                `pause: ${at()}`,
              );
              assert.equal(
                pauseClauseFor(banner.kind, inputs),
                banner.pause,
                `table: ${at()}`,
              );
              assert.equal(
                bannerParksFloat(banner),
                banner.kind === "mixed" ||
                  banner.kind === "interlude" ||
                  banner.kind === "terminal_loud" ||
                  banner.kind === "cannot_verify" ||
                  banner.pause === "disproved",
                `park: ${at()}`,
              );
            }
  assert.equal(shapes, 6 * 10 * 2 * 5 * 2 * 4);
  assert.equal(
    seen.size,
    ALL_KINDS.length,
    `kinds never produced: ${ALL_KINDS.filter((k) => !seen.has(k)).join(", ")}`,
  );
});

// ---- who may be offered a plaintext release --------------------------------

test("the release is offered with a session, and on the R2-4 hold", () => {
  assert.equal(
    plaintextReleaseAvailable({
      mode: NEGOTIATING,
      hasSession: true,
      e2eeCapable: true,
      latchedError: false,
    }),
    true,
  );
  assert.equal(
    plaintextReleaseAvailable({
      mode: undefined,
      hasSession: false,
      e2eeCapable: true,
      latchedError: true,
    }),
    true,
  );
});

test("🔴 a session alone is not enough — the gate must actually be held", () => {
  // `hasSession` used to be the whole test, which would offer "Turn off
  // encryption" on any session-bound red chip that had not latched: the same
  // silent no-op the `call_full` arm exists to prevent. `confirmPlaintext`
  // returns immediately once terminal, and its `confirmReachable()` guard
  // refuses a session that is neither in a downgrade mode nor
  // failed / re-securing / latched loud; a MISSING group no longer
  // short-circuits it (the escape routes to the in-app confirm,
  // `confirmLocalPlaintext`), so the latch is what proves there is a held
  // gate to release. The session's OWN downgrade states hold a gate by
  // construction; anything else has to show that latch.
  for (const mode of [MIXED, INTERLUDE_CONF, NEGOTIATING])
    assert.equal(
      plaintextReleaseAvailable({
        mode,
        hasSession: true,
        e2eeCapable: true,
        latchedError: false,
      }),
      true,
    );
  for (const mode of [E2EE, { kind: "off" } as const, undefined])
    assert.equal(
      plaintextReleaseAvailable({
        mode,
        hasSession: true,
        e2eeCapable: true,
        latchedError: false,
      }),
      false,
    );
  // ...and the latch restores it wherever the mode cannot vouch.
  assert.equal(
    plaintextReleaseAvailable({
      mode: undefined,
      hasSession: true,
      e2eeCapable: true,
      latchedError: true,
    }),
    true,
  );
});

test("🔴 the release is NOT offered where nothing is paused, nor once terminal", () => {
  // A never-enrolled device and an unsupported shell assert no gate, so the
  // press is a silent no-op; `call_full` is terminal in the session
  // (`#terminal()`), so `confirmReachable()` is false and `confirmPlaintext`
  // returns immediately — it is the terminal check that stops it, not a
  // missing group (a missing group now routes to the in-app confirm).
  assert.equal(
    plaintextReleaseAvailable({
      mode: undefined,
      hasSession: false,
      e2eeCapable: false,
      latchedError: false,
    }),
    false,
  );
  assert.equal(
    plaintextReleaseAvailable({
      mode: undefined,
      hasSession: false,
      e2eeCapable: true,
      latchedError: false,
    }),
    false,
  );
  assert.equal(
    plaintextReleaseAvailable({
      mode: { kind: "call_full" },
      hasSession: true,
      e2eeCapable: true,
      latchedError: true,
    }),
    false,
  );
});

test("🔴 INVARIANT: every LOUD chip (not_encrypted or cannot_verify) carries a banner (exhaustive)", () => {
  // The design rule this whole change exists to make checkable: a loud chip is
  // never a dead end. Swept over every input that can PRODUCE a loud chip —
  // which is not the same as every input, and saying so matters: the sweep
  // leaves the mode/state/latch/no-session axes free, because those are the
  // ones that make it loud, and since wave 2 ALSO sweeps
  // `localPublicationsEncrypted` and a clean-vs-dropping decode witness,
  // because row 4 reads both to pick WHICH loud value (neither can mint a red
  // — gate (d) may only WITHHOLD green — but each turns `cannot_verify` into
  // `not_encrypted`). The witness's third value (`unavailable`), the un-keyed
  // media latch and the app-confirmed interlude are held out of this product
  // — each is inert for the loud rows and pinned by its own spec (the next
  // one sweeps `unavailable` against every shape) — to keep the sweep at
  // ~1.3M shapes rather than 2.6M.
  // Written out rather than trusted to the handful of shapes anyone thought
  // of, which is how the ME-7 and §0.2 #9 no-session branches sat bannerless
  // through five reviews — and it is still no proof about a chip that is
  // NEVER red, which is the hole that got through twice.
  //
  // 🔴 The COMPUTED chip goes into `callBanner`. The first cut of this
  // sweep hard-coded `chip: "not_encrypted"` here, which sampled the banner
  // for a chip the sweep never produced and would have kept a bannerless
  // `cannot_verify` green (round-1 audit, B3) — the filter and the argument
  // move together, and the sweep must be shown to REACH `cannot_verify`.
  const MODES: (CallMode | undefined)[] = [
    undefined,
    NEGOTIATING,
    { kind: "off" },
    E2EE,
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_NATIVE,
    { kind: "call_full" },
  ];
  const STATES: ChipInputs["sessionState"][] = [
    undefined,
    "starting",
    "active",
    "plaintext",
    "resecuring",
    "failed",
    "closed",
  ];
  const READINESS = [
    "ready",
    "needs_setup",
    "owned_elsewhere",
    "unsupported",
    "paused",
  ] as const;
  const BOOLS = [false, true];
  const LATCHES: (ChipLatch | undefined)[] = [
    undefined,
    DIRECT_LATCH,
    MEDIA_KEYED,
    CONTROL_KEYED,
    CONTROL_UNKEYED,
  ];
  const WITNESSES: DecodeWitness[] = [
    { available: true, dropping: [], live: [] },
    { available: true, dropping: ["u:d"], live: [] },
  ];
  const PUBLISHERS: { p: string[]; o: Map<string, boolean> }[] = [
    { p: [], o: new Map() },
    { p: ["u:d"], o: new Map([["u:d", true]]) },
    { p: ["u:d"], o: new Map() },
  ];

  // Wave 3: every (chip, mode, latch, session) tuple the sweep REACHES is
  // recorded for the second pass below, which walks the banner's OWN axes —
  // readiness and the two pause flags — over those tuples. Deduplicated, so
  // the new axes multiply a few dozen distinct tuples, not the 1.3M shapes
  // here; the runtime of this spec is the chip sweep, as it was.
  const reachedKey = (
    chip: ChipState,
    modeIdx: number,
    latched: boolean,
    hasSession: boolean,
  ) =>
    ((ALL_CHIPS.indexOf(chip) * MODES.length + modeIdx) * 2 +
      (latched ? 1 : 0)) *
      2 +
    (hasSession ? 1 : 0);
  const reached = new Uint8Array(ALL_CHIPS.length * MODES.length * 4);
  let red = 0;
  let cannotVerify = 0;
  for (const hasSession of BOOLS)
    for (const sessionState of STATES)
      for (const [modeIdx, mode] of MODES.entries())
        for (const e2eeEnabled of BOOLS)
          for (const hasLocalKey of BOOLS)
            for (const resecuring of BOOLS)
              for (const latch of LATCHES)
                for (const channelHasOpenGroup of BOOLS)
                  for (const deviceNeedsSetup of BOOLS)
                    for (const peerCouldEncrypt of BOOLS)
                      for (const rosterVerified of [[], [true], [false]])
                        for (const localPublicationsEncrypted of BOOLS)
                          for (const decodeWitness of WITNESSES)
                            for (const pub of PUBLISHERS) {
                              const inputs: ChipInputs = {
                                hasSession,
                                sessionState,
                                mode,
                                e2eeEnabled,
                                hasLocalKey,
                                resecuring,
                                latch,
                                publishingIdentities: pub.p,
                                observedEncrypted: pub.o,
                                localPublicationsEncrypted,
                                rosterVerified,
                                channelHasOpenGroup,
                                deviceNeedsSetup,
                                peerCouldEncrypt,
                                decodeWitness,
                                // Row 0 is pinned by its own spec; true here
                                // would only fold every shape to one red.
                                pausedByServer: false,
                                presentIdentities: [],
                              };
                              const chip = chipState(inputs);
                              reached[
                                reachedKey(
                                  chip,
                                  modeIdx,
                                  latch !== undefined,
                                  hasSession,
                                )
                              ] = 1;
                              if (
                                chip !== "not_encrypted" &&
                                chip !== "cannot_verify"
                              )
                                continue;
                              red++;
                              const shape = () =>
                                JSON.stringify({
                                  chip,
                                  hasSession,
                                  sessionState,
                                  mode,
                                  latch,
                                  localPublicationsEncrypted,
                                  decodeWitness,
                                  channelHasOpenGroup,
                                  deviceNeedsSetup,
                                  peerCouldEncrypt,
                                });
                              if (chip === "cannot_verify") {
                                cannotVerify++;
                                // Exactly ONE rule yields it (row 4): pin
                                // every conjunct, and that no row above
                                // fired.
                                if (
                                  !(
                                    latch?.origin === "control" &&
                                    latch.mediaKeyed &&
                                    localPublicationsEncrypted &&
                                    decodeWitness.dropping.length === 0 &&
                                    mode?.kind !== "mixed" &&
                                    mode?.kind !== "interlude" &&
                                    mode?.kind !== "call_full"
                                  )
                                )
                                  assert.fail(
                                    `cannot_verify outside row 4: ${shape()}`,
                                  );
                              }
                              // The banner takes the boolean the product
                              // passes it: "a gate is held" — and the SAME
                              // `hasSession` the chip just read (both are
                              // `#mlsSession !== undefined` in state.tsx).
                              const latchedError = latch !== undefined;
                              for (const readiness of READINESS)
                                if (
                                  callBanner({
                                    chip,
                                    mode,
                                    latchedError,
                                    readiness,
                                    hasSession,
                                    pauseDisproved: false,
                                    pauseDisproofConfirmed: false,
                                  }).kind === "none"
                                )
                                  assert.fail(
                                    `loud chip with no banner: ${shape()} readiness=${readiness}`,
                                  );
                            }
  // A sweep that found no loud chips would pass vacuously — and one that never
  // produced `cannot_verify` would prove nothing about its banner.
  assert.ok(red > 1000, `expected a large loud-chip sample, got ${red}`);
  assert.ok(
    cannotVerify > 0,
    `the sweep never reached cannot_verify (${cannotVerify})`,
  );

  // 🔴 Second pass — the banner's own axes over every tuple the chip REACHED
  // (kills banner-securing-unreachable through `securing > 0`, and the two
  // disproof mutations through the pause rule). For each reached (chip, mode,
  // latch, session) × every readiness × all four pause-flag combinations:
  //   kind !== "none"       ⇔  the pre-wave-3 red condition ∨ the securing rule
  //   kind === "securing"   ⇔  the securing rule
  //   pause === "disproved" ⇔  both flags ∧ kind !== "none"
  // and the pass must actually SEE `securing` — the one kind the chip sweep
  // can produce only through a non-red chip under an undecided mode.
  let securing = 0;
  let disproved = 0;
  let tuples = 0;
  for (const chip of ALL_CHIPS)
    for (const [modeIdx, mode] of MODES.entries())
      for (const latchedError of BOOLS)
        for (const hasSession of BOOLS) {
          if (!reached[reachedKey(chip, modeIdx, latchedError, hasSession)])
            continue;
          tuples++;
          for (const readiness of READINESS)
            for (const pauseDisproved of BOOLS)
              for (const pauseDisproofConfirmed of BOOLS) {
                const inputs: CallBannerInputs = {
                  chip,
                  mode,
                  latchedError,
                  readiness,
                  hasSession,
                  pauseDisproved,
                  pauseDisproofConfirmed,
                };
                const banner = callBanner(inputs);
                const at = () => JSON.stringify({ banner, ...inputs });
                assert.equal(
                  banner.kind !== "none",
                  oldRedRaise(inputs) || securingRule(inputs),
                  `raise: ${at()}`,
                );
                assert.equal(
                  banner.kind === "securing",
                  securingRule(inputs),
                  `securing: ${at()}`,
                );
                assert.equal(
                  banner.pause === "disproved",
                  pauseDisproved &&
                    pauseDisproofConfirmed &&
                    banner.kind !== "none",
                  `disproved: ${at()}`,
                );
                if (banner.kind === "securing") securing++;
                if (banner.pause === "disproved") disproved++;
              }
        }
  assert.ok(tuples > 20, `expected a spread of reached tuples, got ${tuples}`);
  assert.ok(
    securing > 0,
    `the chip sweep never reached securing (${securing})`,
  );
  assert.ok(
    disproved > 0,
    `the pass never saw a disproved pause (${disproved})`,
  );
});

test("🔴 an UNAVAILABLE decode witness never changes a loud reading (no `available` conjunct, every shape)", () => {
  // The exhaustive sweep above holds the witness to clean / dropping; this
  // pins the third value across every mode × state × latch × declaration:
  // whatever the clean witness reads, the unavailable one reads the same —
  // it can neither rescue a red nor turn "can't verify" into the positive
  // "not encrypted".
  const MODES: (CallMode | undefined)[] = [
    undefined,
    NEGOTIATING,
    { kind: "off" },
    E2EE,
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_NATIVE,
    INTERLUDE_APP,
    { kind: "call_full" },
  ];
  const STATES: ChipInputs["sessionState"][] = [
    undefined,
    "starting",
    "active",
    "plaintext",
    "resecuring",
    "failed",
    "closed",
  ];
  const LATCHES: (ChipLatch | undefined)[] = [
    undefined,
    DIRECT_LATCH,
    MEDIA_KEYED,
    MEDIA_UNKEYED,
    CONTROL_KEYED,
    CONTROL_UNKEYED,
  ];
  let loud = 0;
  let cannotVerify = 0;
  for (const hasSession of [false, true])
    for (const mode of MODES)
      for (const sessionState of STATES)
        for (const latch of LATCHES)
          for (const localPublicationsEncrypted of [false, true]) {
            const shape = {
              hasSession,
              mode,
              sessionState,
              latch,
              localPublicationsEncrypted,
            };
            const clean = chipState(
              baseChip({
                ...shape,
                decodeWitness: { available: true, dropping: [], live: [] },
              }),
            );
            if (clean !== "not_encrypted" && clean !== "cannot_verify")
              continue;
            loud++;
            if (clean === "cannot_verify") cannotVerify++;
            assert.equal(
              chipState(
                baseChip({
                  ...shape,
                  decodeWitness: DECODE_WITNESS_UNAVAILABLE,
                }),
              ),
              clean,
              JSON.stringify(shape),
            );
          }
  assert.ok(loud > 0, `expected loud shapes, got ${loud}`);
  assert.ok(
    cannotVerify > 0,
    `expected cannot_verify shapes, got ${cannotVerify}`,
  );
});

test("🔴 only a banner the user can clear parks the Watch Together player (kills banner-securing-parks)", () => {
  // The player host floats above the card, so a banner the user must act on
  // has to displace it — and each §3.4 state, and `cannot_verify` (Rejoin /
  // Leave / Stay unencrypted), has an in-call control that clears it, so the
  // park is transient by construction. The KIND decides, whatever a quiet
  // pause clause says.
  const QUIET: PauseClause[] = ["none", "held"];
  for (const kind of [
    "mixed",
    "interlude",
    "terminal_loud",
    "cannot_verify",
  ] as const)
    for (const pause of QUIET)
      assert.equal(bannerParksFloat({ kind, pause }), true, `${kind}/${pause}`);
  // The DEVICE banners describe the device; NOTHING in the call clears them,
  // so parking on one un-anchors the video for the whole call with no control
  // that brings it back and no copy that says why. Nor does `securing`, HELD
  // or not: it is a notice over a join that is expected to succeed, with no
  // control that clears it — parking the player on every join would teach the
  // user the notice is an interruption.
  for (const kind of [
    "securing",
    "device_not_set_up",
    "device_unsupported",
    "ios_paused",
    "unencrypted_notice",
    "none",
  ] as const)
    for (const pause of QUIET)
      assert.equal(
        bannerParksFloat({ kind, pause }),
        false,
        `${kind}/${pause}`,
      );
  // The derived shape, not just the literal: a securing first join, held.
  const securing = callBanner(
    baseBanner({ chip: "none", mode: undefined, readiness: "ready" }),
  );
  assert.deepEqual(securing, { kind: "securing", pause: "held" });
  assert.equal(bannerParksFloat(securing), false);
});

test("🔴 ANY disproved pause parks the player, securing included (kills banner-disproved-does-not-park)", () => {
  // "Your microphone, camera or screen share may still be sending; leave the
  // call to stop it" is the one line the user must not be able to miss, and
  // Leave clears it — so it parks through the PAUSE axis on every kind,
  // including the two that never park on their own (`securing`, the device
  // banners) and even a `none` the policy no longer produces (pure over the
  // shape, so the rule stays total).
  for (const kind of ALL_KINDS)
    assert.equal(bannerParksFloat({ kind, pause: "disproved" }), true, kind);
  // Pinned by name: the securing notice parks ONLY when disproved.
  assert.equal(bannerParksFloat({ kind: "securing", pause: "held" }), false);
  assert.equal(
    bannerParksFloat({ kind: "securing", pause: "disproved" }),
    true,
  );
  // ...and the derived shape agrees: a securing rejoin whose gate was
  // disproved.
  const banner = callBanner(
    baseBanner({
      chip: "resecuring",
      mode: NEGOTIATING,
      readiness: "ready",
      pauseDisproved: true,
      pauseDisproofConfirmed: true,
    }),
  );
  assert.deepEqual(banner, { kind: "securing", pause: "disproved" });
  assert.equal(bannerParksFloat(banner), true);
});

// ---- ctl parser (default-closed) -------------------------------------------

test("parseCtlPayload accepts exactly {v:1, kind:mode, mode:plaintext, ids}", () => {
  const ok = parseCtlPayload(
    JSON.stringify({
      v: 1,
      kind: "mode",
      mode: "plaintext",
      channel_id: "c",
      group_id: "g",
    }),
  );
  assert.deepEqual(ok, {
    kind: "mode",
    mode: "plaintext",
    channelId: "c",
    groupId: "g",
  });
});

test("parseCtlPayload default-closed: unknown v/kind/mode, bad JSON, missing ids → null", () => {
  const cases = [
    "not json",
    JSON.stringify({
      v: 2,
      kind: "mode",
      mode: "plaintext",
      channel_id: "c",
      group_id: "g",
    }),
    JSON.stringify({
      v: 1,
      kind: "other",
      mode: "plaintext",
      channel_id: "c",
      group_id: "g",
    }),
    // There is NO mode:"e2ee" trigger — re-upgrade is automatic-only.
    JSON.stringify({
      v: 1,
      kind: "mode",
      mode: "e2ee",
      channel_id: "c",
      group_id: "g",
    }),
    JSON.stringify({ v: 1, kind: "mode", mode: "plaintext", group_id: "g" }),
    JSON.stringify(null),
    JSON.stringify(42),
  ];
  for (const c of cases) assert.equal(parseCtlPayload(c), null, c);
});

// ---- encryptionError classification (§4.4 debounce, 6.7b joiner window) -----

test("encryptionError inside a rotation window classifies resecuring", () => {
  assert.equal(classifyEncryptionError(true, false), "resecuring");
});

test("encryptionError while awaiting the first key classifies resecuring (6.7b joiner window)", () => {
  // A mid-call joiner receives already-encrypted frames before its Welcome
  // resolves — expected noise, bounded by the same resecure escalation.
  assert.equal(classifyEncryptionError(false, true), "resecuring");
});

test("encryptionError with keys installed and no window is immediately loud", () => {
  assert.equal(classifyEncryptionError(false, false), "loud");
});

test("both windows open still resecuring (no double-count to loud)", () => {
  assert.equal(classifyEncryptionError(true, true), "resecuring");
});

// ---- rotation-window length by opener (§4.4; the lost-arbitration race) -----

const BOUNDS = { addGraceMs: 2_000, settleMs: 2_000, submitTimeoutMs: 10_000 };

test("rotation window: an Add-grace install stays known through grace + settle", () => {
  assert.equal(rotationWindowMs("grace", BOUNDS), 4_000);
});

test("rotation window: an immediate install stays known through the settle only", () => {
  assert.equal(rotationWindowMs("immediate", BOUNDS), 2_000);
});

test("🔴 rotation window: a submitted commit is a known rotation for the whole round trip", () => {
  // The loser of a Remove race eats the winner's new-index frames while its
  // own submit is still in flight (its copy of the winning commit is queued
  // behind the same lock), so the window must already be open at submit and
  // outlast the submit bound — the install-opened windows start too late.
  assert.equal(rotationWindowMs("arbitration", BOUNDS), 12_000);
  assert.ok(
    rotationWindowMs("arbitration", BOUNDS) > rotationWindowMs("grace", BOUNDS),
  );
});

// ---- loud after e2ee: fold into the terminal-loud shape ---------------------

test("🔴 a loud latch in e2ee drops the mode to negotiating (banner + escape hatch)", () => {
  // The known gap "loud after mode reached e2ee → red chip, no banner, no
  // way out": confirmPlaintext keys on negotiating, and the banner's
  // `terminal_loud` arm under it is pinned on `callBanner` above.
  const fallback = loudModeFallback(E2EE);
  assert.deepEqual(fallback, NEGOTIATING);
});

test("a loud latch anywhere else keeps the mode", () => {
  // negotiating already renders the terminal banner; mixed/interlude carry
  // their own banners with the same native-confirmed escape; off is a plain
  // call; call_full is terminal.
  const keep: CallMode[] = [
    NEGOTIATING,
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_CONF,
    { kind: "off" },
    { kind: "call_full" },
  ];
  for (const mode of keep)
    assert.equal(loudModeFallback(mode), null, mode.kind);
});

// ---- the label a latched session may write ----------------------------------

test("🔴 under a loud latch, e2ee is unreachable: it folds to negotiating", () => {
  // The R2 dead end (2026-09-07): after the latch the machine kept running
  // and a mix_detected → mix_cleared cycle wrote `e2ee` back — red chip from
  // the latched error, no banner, no escape, the promised pause lifted.
  const folded = modeUnderLoudLatch(E2EE, true);
  assert.deepEqual(folded, NEGOTIATING);
});

test("without a latch the label passes through unchanged", () => {
  assert.deepEqual(modeUnderLoudLatch(E2EE, false), E2EE);
  assert.deepEqual(modeUnderLoudLatch(MIXED, false), MIXED);
});

test("every other label passes under a latch (they carry their own banners or are terminal)", () => {
  const pass: CallMode[] = [
    NEGOTIATING,
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_CONF,
    { kind: "off" },
    { kind: "call_full" },
  ];
  for (const mode of pass)
    assert.deepEqual(modeUnderLoudLatch(mode, true), mode, mode.kind);
});

test("composition: latch → mix → mix cleared → the T2 resume cannot reach e2ee", () => {
  // Latch in e2ee folds to negotiating; a rejoining peer's beat declares a
  // mix (T0c declare = the session sets `mixed`); the mix clears and the T2
  // timer labels e2ee — which must fold back to the terminal-loud shape.
  const latched = loudModeFallback(E2EE)!;
  assert.deepEqual(latched, NEGOTIATING);
  const mixed: CallMode = MIXED; // #onMixDetected's direct label
  const cleared = callModeTransition(mixed, { type: "mix_cleared" });
  assert.deepEqual(cleared.effects, [
    { do: "schedule_reupgrade", viaSuccessor: false },
  ]);
  const t2 = modeUnderLoudLatch(E2EE, true); // what the timer may write
  assert.deepEqual(t2, NEGOTIATING);
});

test("chip: negotiating + latched error is loud; negotiating without one is amber", () => {
  const base: ChipInputs = {
    hasSession: true,
    sessionState: "active",
    mode: NEGOTIATING,
    e2eeEnabled: false,
    hasLocalKey: false,
    resecuring: false,
    latch: undefined,
    publishingIdentities: [],
    observedEncrypted: new Map(),
    localPublicationsEncrypted: true,
    rosterVerified: [],
    channelHasOpenGroup: true,
    deviceNeedsSetup: false,
    peerCouldEncrypt: true,
    decodeWitness: { available: true, dropping: [], live: [] },
    pausedByServer: false,
    presentIdentities: [],
  };
  // A first-join control latch is un-keyed (`#hasLocalKey` is only set after
  // a Welcome install), so it reads not_encrypted at row 5, never row 4.
  assert.equal(chipState({ ...base, latch: CONTROL_UNKEYED }), "not_encrypted");
  // The heal's intermediate: the latch is gone, the label is still folded
  // until the chained `e2ee` lands.
  assert.equal(chipState(base), "resecuring");
});

// ---- healing a media latch: the peer-scoped witness ------------------------

const LEFT = { present: false, readdedAfterLatch: false, sidsAllNew: false };
const REKEYED = { present: true, readdedAfterLatch: true, sidsAllNew: true };
const HEAL_OK: LoudHealInputs = {
  origin: "media",
  latchedInstallSeq: 3,
  installSeq: 4,
  errorSinceInstall: false,
  settleElapsed: true,
  rosterConsistent: true,
  peers: [LEFT],
};

test("a media latch heals once the group re-keyed and the failing peer LEFT", () => {
  assert.equal(loudHealVerdict(HEAL_OK), "heal");
});

test("…or once that peer was re-added after the latch and publishes only NEW tracks", () => {
  assert.equal(loudHealVerdict({ ...HEAL_OK, peers: [REKEYED] }), "heal");
});

test("🔴 a present peer still publishing a latched-time track holds (silent drops at an invalid index)", () => {
  // The worker emits one error per key index and then drops silently; a peer
  // still sending at its old index after the re-key produces no error and no
  // decrypt. "No error since the install" alone would heal over dead air.
  assert.equal(
    loudHealVerdict({
      ...HEAL_OK,
      peers: [{ present: true, readdedAfterLatch: true, sidsAllNew: false }],
    }),
    "hold",
  );
  assert.equal(
    loudHealVerdict({
      ...HEAL_OK,
      peers: [{ present: true, readdedAfterLatch: false, sidsAllNew: true }],
    }),
    "hold",
  );
});

test("🔴 with no named device EVERY remote present at the latch must be gone or re-keyed", () => {
  // The worker posts a plain Error; only the MissingKey message names the
  // participant, so a decoy-key failure leaves the set = all remotes.
  assert.equal(loudHealVerdict({ ...HEAL_OK, peers: [LEFT, REKEYED] }), "heal");
  assert.equal(
    loudHealVerdict({
      ...HEAL_OK,
      peers: [
        REKEYED,
        { present: true, readdedAfterLatch: false, sidsAllNew: false },
      ],
    }),
    "hold",
  );
});

test("a bystander latch heals once this side installed the exact index it named", () => {
  // A missing key NAMES its participant, so the witness set is the bystander
  // that raised it — and a bystander never leaves and never re-publishes,
  // which is why leg 3a (2026-09-07) stayed red for the whole call. Filling
  // that index is the one witness such a latch can produce: `setKey` calls
  // `resetKeyStatus` for it, so a surviving failure re-emits inside the
  // settle and `errorSinceInstall` catches it.
  const stuck = { present: true, readdedAfterLatch: false, sidsAllNew: false };
  assert.equal(loudHealVerdict({ ...HEAL_OK, peers: [stuck] }), "hold");
  assert.equal(
    loudHealVerdict({
      ...HEAL_OK,
      peers: [stuck],
      originatingPairRefilled: true,
    }),
    "heal",
  );
});

test("🔴 the refilled-pair witness sits BEHIND the empty-witness hold, never in front", () => {
  // No device the failure could have come from means no witness at all, and
  // the latch holds whatever else is true. Ordering the refill clause ahead
  // of that check would let a latch with nothing to judge heal itself.
  assert.equal(
    loudHealVerdict({
      ...HEAL_OK,
      peers: [],
      originatingPairRefilled: true,
    }),
    "hold",
  );
});

test("🔴 the refilled-pair witness never substitutes for the other gates", () => {
  // It answers "was the failing index re-validated", nothing else: a hard
  // error since the install, an unsettled probe, a divergent roster and a
  // control-plane latch all still hold with it set.
  const holds: Partial<LoudHealInputs>[] = [
    { origin: "control" },
    { installSeq: 3 },
    { errorSinceInstall: true },
    { settleElapsed: false },
    { rosterConsistent: false },
  ];
  for (const over of holds)
    assert.equal(
      loudHealVerdict({
        ...HEAL_OK,
        peers: [{ present: true, readdedAfterLatch: false, sidsAllNew: false }],
        originatingPairRefilled: true,
        ...over,
      }),
      "hold",
      JSON.stringify(over),
    );
});

test("🔴 every other missing witness holds", () => {
  const holds: Partial<LoudHealInputs>[] = [
    { origin: "control" },
    { installSeq: 3 }, // no new epoch since the latch
    { installSeq: 2 },
    { errorSinceInstall: true },
    // Leg 9 (2026-09-07): judged before the settle since the latest Add.
    { settleElapsed: false },
    { rosterConsistent: false },
    { peers: [] }, // nobody the failure could have come from = no witness
  ];
  for (const over of holds)
    assert.equal(
      loudHealVerdict({ ...HEAL_OK, ...over }),
      "hold",
      JSON.stringify(over),
    );
});

test("the heal settle runs from the latest re-Add of a PRESENT witness only", () => {
  // Leg 9 (2026-09-07): the present rejoiner's later Add dominates.
  assert.equal(
    latestPresentAddedAt([
      { present: true, addedAt: 100 },
      { present: true, addedAt: 250 },
    ]),
    250,
  );
  // Leg 8: an absent witness's Add is ignored — its frames are gone.
  assert.equal(
    latestPresentAddedAt([
      { present: false, addedAt: 900 },
      { present: true, addedAt: 100 },
    ]),
    100,
  );
  // Never re-added / no witness: nothing later than the install.
  assert.equal(latestPresentAddedAt([{ present: true }]), 0);
  assert.equal(latestPresentAddedAt([]), 0);
});

// ---- media-plane errors vs. the install reference ---------------------------

const PEER = "01KWZ8SEDB282BE0ZS0H3TQA61:f5e41432ff82e08c83176f57c4a80a78";
const MISSING = (index: number, identity = PEER) =>
  new Error(
    `MissingKey: missing key at index ${index} for participant ${identity}`,
  );
const INVALID = new Error(
  "InvalidKey: Decryption failed: The operation failed for an operation-specific reason",
);
const entry = (index: number, identity = PEER) => ({
  livekit_identity: identity,
  key_index: index,
});

test("only the decode path's MissingKey names a key pair; everything else is hard", () => {
  assert.deepEqual(classifyMediaError(MISSING(13)), {
    kind: "missing_key",
    identity: PEER,
    pair: keyPairId(PEER, 13),
  });
  assert.deepEqual(classifyMediaError(MISSING(2, `${PEER}:screen`)), {
    kind: "missing_key",
    identity: `${PEER}:screen`,
    pair: `${PEER}:screen@2`,
  });
  // An index outside the worker's ring is a plaintext frame's last byte, not
  // a key pair (its failure count is NaN and it re-emits every frame).
  assert.deepEqual(classifyMediaError(MISSING(16)), { kind: "hard" });
  assert.deepEqual(classifyMediaError(MISSING(200)), { kind: "hard" });
  // The decoy / withheld key (leg 9): the key it holds is wrong.
  assert.deepEqual(classifyMediaError(INVALID), { kind: "hard" });
  // The encode path's missing key names no decode pair.
  assert.deepEqual(
    classifyMediaError(
      new Error(`MissingKey: key set not found for ${PEER} at index 3`),
    ),
    { kind: "hard" },
  );
  assert.deepEqual(classifyMediaError("not an error"), { kind: "hard" });
  assert.deepEqual(classifyMediaError(undefined), { kind: "hard" });
});

test("🔴 a hard error landing DURING the install counts against a reference taken before it", () => {
  // Review of 9e5fa880 (MED): the installer awaits importKey per entry after
  // each post; an InvalidKey between those awaits used to be stamped before a
  // reference taken after the install resolved, and the probe healed over the
  // silenced index 10 s later.
  const ledger = new MediaErrorLedger();
  const installRef = 1_000;
  ledger.noteError(INVALID, 1_005); // between the installer's awaits
  ledger.noteInstalled([entry(13)], 1_010); // the install resolves
  assert.equal(ledger.errorSince(installRef), true);
  // An error strictly before the reference is the latch's own, not since.
  const older = new MediaErrorLedger();
  older.noteError(INVALID, 999);
  older.noteInstalled([entry(13)], 1_010);
  assert.equal(older.errorSince(installRef), false);
  // At the reference itself: since (conservative).
  const same = new MediaErrorLedger();
  same.noteError(INVALID, installRef);
  assert.equal(same.errorSince(installRef), true);
  // No error ever: not "since" even a reference of 0.
  assert.equal(new MediaErrorLedger().errorSince(0), false);
});

test("a missing key for a pair the install covers is superseded, whichever lands first", () => {
  // The join-race MissingKey: the worker judged the frame before the setKey
  // message reached it, so the setKey resets the index afterwards.
  const before = new MediaErrorLedger();
  before.noteError(MISSING(13), 1_005);
  before.noteInstalled([entry(13)], 1_010);
  assert.equal(before.errorSince(1_000), false);
  assert.deepEqual(before.uncoveredPairs(), []);
  // Previous-epoch entries count as installed too.
  const prev = new MediaErrorLedger();
  prev.noteError(MISSING(12), 900);
  prev.noteInstalled([entry(12), entry(13)], 1_010);
  assert.equal(prev.errorSince(1_000), false);
});

test("🔴 a missing key that lands AFTER the sender's install completed is a withheld commit, and stands until the next install (M1)", () => {
  // Re-review of de4879c2: the DS withholds a roster-neutral Remove + re-Add
  // of P from this member only; P's new session sends at an index this side
  // never got. The one MissingKey is the only local sign — it must hold.
  const ledger = new MediaErrorLedger();
  ledger.noteInstalled([entry(2)], 1_010); // P installed at epoch 2
  ledger.noteError(MISSING(4), 5_000); // P sends at 4; this side never got 3, 4
  assert.equal(ledger.errorSince(1_000), true);
  assert.deepEqual(ledger.uncoveredPairs(), [keyPairId(PEER, 4)]);
  // A later install of P (any index) proves this side caught up.
  ledger.noteInstalled([entry(5)], 9_000);
  assert.equal(ledger.errorSince(1_000), false);
  // The join race whose error merely reached the main thread after the
  // install completed: the pair that install SET can only have been judged
  // before the worker processed the setKey (no path empties a slot), so it
  // is superseded whenever it lands — not a hold.
  const late = new MediaErrorLedger();
  late.noteInstalled([entry(13)], 1_010);
  late.noteError(MISSING(13), 1_020);
  assert.equal(late.errorSince(1_000), false);
  // ...while a pair that install did NOT set, landing after it, holds.
  late.noteError(MISSING(14), 1_030);
  assert.equal(late.errorSince(1_000), true);
  assert.deepEqual(late.uncoveredPairs(), [keyPairId(PEER, 14)]);
  // The sender's next install supersedes it whatever indexes it sets.
  late.noteInstalled([entry(15)], 2_000);
  assert.equal(late.errorSince(1_000), false);
  // LiveKit re-sets every known pair on each worker enable ack: a re-set of
  // an already-set pair records nothing and changes no verdict.
  const reset = new MediaErrorLedger();
  reset.noteInstalled([entry(13)], 1_010);
  reset.noteError(MISSING(14), 1_030); // foreign index: holds
  reset.noteInstalled([entry(13)], 1_500); // the replay, same pair
  assert.equal(reset.errorSince(1_000), true);
  assert.deepEqual(reset.uncoveredPairs(), [keyPairId(PEER, 14)]);
});

test("🔴 a missing key for a sender NO install covers holds while that sender is present, regardless of when it landed", () => {
  // A sender at an index this side does not hold: its index is silenced after
  // the one error (failureTolerance 0), so silence proves nothing.
  const OTHER = "01KWHY6P2RPHWNJADM59F97JGE:bee76df73dbf46725e328509842750b4";
  const ledger = new MediaErrorLedger();
  ledger.noteError(MISSING(14, OTHER), 500); // before the reference
  ledger.noteInstalled([entry(13)], 1_010); // PEER installed, OTHER never
  assert.equal(ledger.errorSince(1_000), true);
  assert.deepEqual(ledger.uncoveredPairs(), [keyPairId(OTHER, 14)]);
  // Gone from the SFU: its frames are gone with it (review of e2163ead, H1a).
  assert.equal(
    ledger.errorSince(1_000, (identity) => identity !== OTHER),
    false,
  );
  // Back, still uncovered: holds again. An install of that sender answers it.
  assert.equal(ledger.errorSince(1_000), true);
  ledger.noteInstalled([entry(14, OTHER)], 2_000);
  assert.equal(ledger.errorSince(1_000), false);
});

test("🔴 a Welcome joiner's pre-Welcome missing key is superseded by the sender's FIRST install (H1)", () => {
  // Review of e2163ead: a device joined by Welcome hears P's frames at epoch
  // E before it holds any key, then installs E+1 with `previous: []` (native
  // snapshots previous only across a commit it applied). P@E is never
  // installed; superseding by sender keeps the heal alive for the joiner.
  const ledger = new MediaErrorLedger();
  ledger.noteError(MISSING(4), 100); // P@4, before the Welcome
  ledger.noteInstalled([entry(5)], 1_010); // first install: P@5 only
  assert.equal(ledger.errorSince(1_000), false);
  assert.deepEqual(ledger.uncoveredPairs(), []);
});

test("forgetHardError keeps the uncovered senders; reset forgets the replaced group", () => {
  const OTHER = "01KWHY6P2RPHWNJADM59F97JGE:bee76df73dbf46725e328509842750b4";
  const ledger = new MediaErrorLedger();
  ledger.noteError(INVALID, 1_005);
  ledger.noteError(MISSING(14, OTHER), 1_006);
  ledger.forgetHardError(); // a healed latch
  assert.equal(ledger.errorSince(1_000), true); // OTHER still uncovered
  ledger.reset(); // group re-established
  assert.equal(ledger.errorSince(1_000), false);
  // After a reset a sender installed under the old group is unknown again, so
  // a missing key for it is a real hold until the new group installs it.
  ledger.noteError(MISSING(0), 2_000);
  assert.equal(ledger.errorSince(1_500), true);
  ledger.noteInstalled([entry(0)], 2_500);
  assert.equal(ledger.errorSince(1_500), false);
});

test("🔴 leg 9 ordering: the rejoiner's first new-key frame fails inside the settle → hold; leg 7: decrypts → heal", () => {
  // The session-level sequence, composed from the pure parts: the latch at
  // install seq 3, the Remove epoch (seq 4, ref 1_000), the Add epoch (seq 5,
  // ref 2_000), the peer re-added and publishing all-new SIDs.
  const witness = { present: true, readdedAfterLatch: true, sidsAllNew: true };
  const judge = (ledger: MediaErrorLedger, installRef: number) =>
    loudHealVerdict({
      origin: "media",
      latchedInstallSeq: 3,
      installSeq: 5,
      errorSinceInstall: ledger.errorSince(installRef),
      settleElapsed: true,
      rosterConsistent: true,
      peers: [witness],
    });
  // Leg 9: the key withheld and never released.
  const leg9 = new MediaErrorLedger();
  leg9.noteError(INVALID, 100); // the latch's own error
  leg9.noteInstalled([entry(12)], 1_010); // Remove epoch at 1_000
  leg9.noteError(MISSING(13), 2_005); // join-race frame during the Add install
  leg9.noteInstalled([entry(13)], 2_010); // Add epoch at 2_000, supersedes it
  assert.equal(judge(leg9, 2_000), "heal"); // nothing since — so far
  leg9.noteError(INVALID, 2_400); // first frame under the new key fails
  assert.equal(judge(leg9, 2_000), "hold");
  // Leg 7: released before the rejoin; the new-key frames decrypt.
  const leg7 = new MediaErrorLedger();
  leg7.noteError(INVALID, 100);
  leg7.noteInstalled([entry(12)], 1_010);
  leg7.noteError(MISSING(13), 2_005);
  leg7.noteInstalled([entry(13)], 2_010);
  assert.equal(judge(leg7, 2_000), "heal");
});

// ---- mix detected: what the session does, by mode ---------------------------

test("🔴 a mix found while still negotiating is DECLARED (T0c — the joiner into a mixed call)", () => {
  // A joiner lands in a call that already holds a plaintext participant.
  // Enable waits for a consistent roster, so gating the declaration on
  // "E2EE enabled" left it in negotiating forever: paused, amber, no banner,
  // no way to consent to plaintext.
  assert.equal(mixDetectedAction(NEGOTIATING), "declare");
});

test("a mix found in e2ee (T1) or while already mixed is declared", () => {
  assert.equal(mixDetectedAction(E2EE), "declare");
  assert.equal(mixDetectedAction(MIXED), "declare");
});

test("a mix found in an interlude only runs the machine (re-upgrade cancel)", () => {
  assert.equal(mixDetectedAction(INTERLUDE_UNCONF), "transition");
  assert.equal(mixDetectedAction(INTERLUDE_CONF), "transition");
});

test("a mix is ignored on a plain call and after call_full", () => {
  assert.equal(mixDetectedAction({ kind: "off" }), "ignore");
  assert.equal(mixDetectedAction({ kind: "call_full" }), "ignore");
});

// ---- Gate (d): the decode witness -------------------------------------------

const witness = (over: Partial<DecodeWitness> = {}): DecodeWitness => ({
  available: true,
  dropping: [],
  live: [],
  ...over,
});

test("gate (d): a sender whose frames are being DROPPED takes the chip amber", () => {
  // Every other gate is satisfied: native healthy, every publisher observed
  // encrypted, our own declarations GCM, roster verified. Before gate (d) this
  // was green — and it was green in exactly the case the worker was discarding
  // a peer's every frame at an index it had marked invalid.
  assert.equal(
    chipState(
      baseChip({
        publishingIdentities: ["bob:d1"],
        observedEncrypted: new Map([["bob:d1", true]]),
      }),
    ),
    "e2ee",
  );
  assert.equal(
    chipState(
      baseChip({
        publishingIdentities: ["bob:d1"],
        observedEncrypted: new Map([["bob:d1", true]]),
        decodeWitness: witness({ dropping: ["bob:d1"], live: [] }),
      }),
    ),
    "resecuring",
  );
});

test("🔴 gate (d): NO witness is amber, never green", () => {
  // The heartbeat is the whole mechanism. A build that lost the worker patch,
  // a dead worker, a listener never armed — each stops the sample, and each
  // must degrade the chip rather than quietly remove the gate. Exempting on
  // "no evidence" is the reasoning that produced the silent green six review
  // rounds kept finding somewhere new.
  assert.equal(
    chipState(baseChip({ decodeWitness: witness({ available: false }) })),
    "resecuring",
  );
});

test("🔴 gate (d) can only WITHHOLD green — it never produces a red", () => {
  // One-way, by construction: the witness may cost a green and may not mint a
  // loud verdict. Two earlier attempts at this area died of a FALSE RED, so
  // this is pinned rather than left to reading the code.
  for (const w of [
    witness({ available: false }),
    witness({ dropping: ["bob:d1"] }),
  ]) {
    assert.equal(chipState(baseChip({ decodeWitness: w })), "resecuring");
  }
  // ...and it cannot mask one either: a latched error still reads loud.
  assert.equal(
    chipState(
      baseChip({
        latch: MEDIA_KEYED,
        decodeWitness: witness({ available: false }),
      }),
    ),
    "not_encrypted",
  );
  // ...nor pick the loud SHADE beyond its `dropping` check: a keyed control
  // latch under an UNAVAILABLE witness is still loud — `cannot_verify`, since
  // "no sample" cannot support the positive claim "not encrypted" either.
  assert.equal(
    chipState(
      baseChip({
        latch: CONTROL_KEYED,
        decodeWitness: witness({ available: false }),
      }),
    ),
    "cannot_verify",
  );
});

test("summarizeDecodeWitness: dropped counts as dropping, delivered counts as live", () => {
  const w = summarizeDecodeWitness([
    { identity: "bob:d1", indexes: [{ keyIndex: 3, seen: 30, dropped: 30 }] },
    { identity: "carol:d1", indexes: [{ keyIndex: 3, seen: 30, dropped: 0 }] },
  ]);
  assert.deepEqual(w.dropping, ["bob:d1"]);
  assert.deepEqual(w.live, ["carol:d1"]);
  assert.equal(w.available, true);
});

test("summarizeDecodeWitness: a sender mid-rotation is BOTH, and dropping is what gates", () => {
  // Two indexes in flight at once: the new one gets through, the old one is
  // still being discarded. The gate must read the drop — the sender is still
  // sending frames this device cannot read.
  const w = summarizeDecodeWitness([
    {
      identity: "bob:d1",
      indexes: [
        { keyIndex: 2, seen: 5, dropped: 5 },
        { keyIndex: 3, seen: 25, dropped: 0 },
      ],
    },
  ]);
  assert.deepEqual(w.dropping, ["bob:d1"]);
  assert.deepEqual(w.live, ["bob:d1"]);
  assert.equal(
    chipState(baseChip({ decodeWitness: w })),
    "resecuring",
    "a live new index excused a dead old one",
  );
});

test("summarizeDecodeWitness: an empty window is available and clean", () => {
  // Nothing arriving is not a failure — nothing is being dropped. The
  // heartbeat itself is what proves the witness is wired.
  const w = summarizeDecodeWitness([]);
  assert.deepEqual(w, { available: true, dropping: [], live: [] });
  assert.equal(chipState(baseChip({ decodeWitness: w })), "e2ee");
});

// ---- Gate (d)'s bound: a witness-only amber goes loud (Wave J) -------------

// A sender this device cannot read: every frame it sends is discarded.
const W_DROPPING: DecodeWitness = {
  available: true,
  dropping: ["bob:d1"],
  live: [],
};
// Positive evidence: a fresh window in which nothing was discarded.
const W_CLEAN: DecodeWitness = {
  available: true,
  dropping: [],
  live: ["bob:d1"],
};

// The withheld-commit-at-join shape, everything but the witness green: the
// joiner is keyed and enabled (a), the SFU says both seats publish encrypted
// (b), our own publications are on record as GCM, the roster is verified (c).
// Only the frames say otherwise.
const withheld = (decodeWitness: DecodeWitness): ChipInputs =>
  baseChip({
    publishingIdentities: ["alice:dA", "bob:d1"],
    observedEncrypted: new Map([
      ["alice:dA", true],
      ["bob:d1", true],
    ]),
    decodeWitness,
  });

/** Judge `inputs` every `step` ms over [from, to): the readings, in order. */
const sweepJudge = (
  esc: WitnessAmberEscalation,
  inputs: ChipInputs,
  from: number,
  to: number,
  step = 1_000,
): [number, ChipState][] => {
  const out: [number, ChipState][] = [];
  for (let at = from; at < to; at += step) {
    out.push([at, esc.judge(inputs, at)]);
  }
  return out;
};

/** The banner a live session's seat derives for `chip` (nothing latched). */
const seatBanner = (chip: ChipState, mode: CallMode | undefined = E2EE) =>
  callBanner(
    baseBanner({
      chip,
      mode,
      readiness: "ready",
      latchedError: false,
      hasSession: true,
    }),
  );

test("🔴 a witness-only amber is NOT forever: a withheld commit at join goes loud at the verdict bound", () => {
  // One source with the session's join-race verdict bound
  // (`JOIN_RACE_DEFER_MS`, 10 s leave-grace + 10 s submit).
  assert.equal(WITNESS_AMBER_ESCALATE_MS, 20_000);
  assert.equal(WITNESS_AMBER_CONFIRM_MS, 500);
  const inputs = withheld(W_DROPPING);
  // The snapshot rule has no clock: this IS the amber-forever.
  assert.equal(chipState(inputs), "resecuring");
  assert.equal(witnessOnlyAmber(inputs), true);
  const esc = new WitnessAmberEscalation();
  for (const [at, chip] of sweepJudge(esc, inputs, 0, 21_000)) {
    assert.equal(chip, "resecuring", `loud before the bound, at ${at} ms`);
  }
  // 20 s accrued at the 20 000 ms reading; the 21 000 ms reading confirms.
  assert.equal(
    esc.judge(inputs, 21_000),
    "not_encrypted",
    "amber forever: 21 s of discarded frames and the chip never went loud",
  );
  assert.equal(esc.escalated, true);
  for (const [at, chip] of sweepJudge(esc, inputs, 22_000, 60_000)) {
    assert.equal(chip, "not_encrypted", `fell back to amber at ${at} ms`);
  }
  // A loud chip carries a banner: the honest floor, because nothing is
  // latched and no gate is held — no pause promised, no release offered.
  assert.deepEqual(seatBanner(esc.judge(inputs, 60_000)), {
    kind: "unencrypted_notice",
    pause: "none",
  });
});

test("🔴 a dead witness (no heartbeat) on a keyed call goes loud at the same bound", () => {
  const inputs = withheld(DECODE_WITNESS_UNAVAILABLE);
  assert.equal(witnessOnlyAmber(inputs), true);
  const esc = new WitnessAmberEscalation();
  for (const [at, chip] of sweepJudge(esc, inputs, 0, 20_500, 100)) {
    assert.equal(chip, "resecuring", `loud before bound + confirm, at ${at}`);
  }
  // Past the bound at 20 000 ms; 500 ms later the second reading agrees.
  assert.equal(esc.judge(inputs, 20_500), "not_encrypted");
});

test("🔴 once loud, returning evidence does NOT rescue it: only the end of the claim or a new call resets", () => {
  const esc = new WitnessAmberEscalation();
  sweepJudge(esc, withheld(W_DROPPING), 0, 22_000);
  assert.equal(esc.escalated, true);
  // bob goes quiet: nothing is dropped any more, and nothing was fixed.
  assert.equal(chipState(withheld(W_CLEAN)), "e2ee");
  assert.equal(esc.judge(withheld(W_CLEAN), 23_000), "not_encrypted");
  // Nor does a rejoin's negotiating amber.
  assert.equal(
    esc.judge(
      baseChip({ mode: NEGOTIATING, e2eeEnabled: false, hasLocalKey: false }),
      24_000,
    ),
    "not_encrypted",
  );
  // A latched loud chip passes through untouched: its latch owns the banner
  // and the gate, and `cannot_verify` stays `cannot_verify`.
  assert.equal(
    esc.judge(
      baseChip({
        latch: CONTROL_KEYED,
        mode: NEGOTIATING,
        sessionState: "failed",
      }),
      25_000,
    ),
    "cannot_verify",
  );
  assert.equal(esc.escalated, true);
  // No E2EE claim any more (no session, nothing to be left out of): reset.
  assert.equal(
    esc.judge(
      baseChip({
        hasSession: false,
        channelHasOpenGroup: false,
        peerCouldEncrypt: false,
      }),
      26_000,
    ),
    "none",
  );
  assert.equal(esc.escalated, false);
  assert.equal(esc.judge(withheld(W_CLEAN), 27_000), "e2ee");
  // A new call: `reset()`.
  sweepJudge(esc, withheld(W_DROPPING), 30_000, 52_000);
  assert.equal(esc.escalated, true);
  esc.reset();
  assert.equal(esc.escalated, false);
  assert.equal(esc.judge(withheld(W_DROPPING), 52_000), "resecuring");
});

test("🔴 false-red control: a healthy call that keeps briefly losing its witness never goes loud", () => {
  // Ten gaps of 19.9 s, each just short of the bound, each ended by one
  // fresh clean window: 200 s that are almost all amber, never once loud.
  const esc = new WitnessAmberEscalation();
  const gap = withheld(DECODE_WITNESS_UNAVAILABLE);
  let at = 0;
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 200; i++, at += 100) {
      assert.equal(esc.judge(gap, at), "resecuring", `round ${round}, ${at}`);
    }
    assert.equal(esc.judge(withheld(W_CLEAN), at), "e2ee", "evidence returned");
    at += 100;
  }
  assert.equal(esc.escalated, false);
  // A sender mid-rotation (a short run of dropped old-index frames) is the
  // same shape: brief, then clean.
  sweepJudge(esc, withheld(W_DROPPING), at, at + 7_000);
  assert.equal(esc.judge(withheld(W_CLEAN), at + 7_000), "e2ee");
  assert.equal(esc.escalated, false);
});

test("🔴 false-red control: a rotation's amber inside a join PAUSES the clock, it does not add to it", () => {
  const esc = new WitnessAmberEscalation();
  const drops = withheld(W_DROPPING);
  // An arbitration window (submit + settle = 12 s): amber, not witness-only.
  const rotating: ChipInputs = { ...drops, resecuring: true };
  assert.equal(witnessOnlyAmber(rotating), false);
  const readings = [
    ...sweepJudge(esc, drops, 0, 8_000),
    ...sweepJudge(esc, rotating, 8_000, 20_000),
    ...sweepJudge(esc, drops, 20_000, 28_000),
  ];
  // 28 s of wall clock, 14 s of witness-only time.
  for (const [at, chip] of readings) {
    assert.equal(
      chip,
      "resecuring",
      `a rotation counted as witness time, ${at}`,
    );
  }
  assert.equal(esc.judge(withheld(W_CLEAN), 28_000), "e2ee");
  // ...and a join's pre-key amber, however long, is not witness-only either.
  const preKey = baseChip({
    ...drops,
    mode: NEGOTIATING,
    e2eeEnabled: false,
    hasLocalKey: false,
  });
  assert.equal(witnessOnlyAmber(preKey), false);
  for (const [at, chip] of sweepJudge(esc, preKey, 30_000, 70_000)) {
    assert.equal(chip, "resecuring", `pre-key amber counted, ${at}`);
  }
  // Keyed: the Add-grace's old-index drops (well under the bound), then clean.
  for (const [at, chip] of sweepJudge(esc, drops, 70_000, 77_000)) {
    assert.equal(chip, "resecuring", `${at}`);
  }
  assert.equal(esc.judge(withheld(W_CLEAN), 77_000), "e2ee");
  assert.equal(esc.escalated, false);
});

test("🔴 an input that flaps cannot hold a witness-only amber forever: other amber pauses the clock, never resets it", () => {
  // An SFU toggling bob's declared encryption once every five readings.
  const esc = new WitnessAmberEscalation();
  const drops = withheld(W_DROPPING);
  const flapped: ChipInputs = {
    ...drops,
    observedEncrypted: new Map([
      ["alice:dA", true],
      ["bob:d1", false],
    ]),
  };
  assert.equal(chipState(flapped), "resecuring");
  assert.equal(witnessOnlyAmber(flapped), false);
  let at = 0;
  let loudAt: number | undefined;
  for (let cycle = 0; cycle < 20 && loudAt === undefined; cycle++) {
    for (let i = 0; i < 5 && loudAt === undefined; i++, at += 1_000) {
      if (esc.judge(drops, at) === "not_encrypted") loudAt = at;
    }
    if (loudAt === undefined) {
      assert.equal(esc.judge(flapped, at), "resecuring");
      at += 1_000;
    }
  }
  assert.ok(loudAt !== undefined, "the flapping input held amber forever");
  // 4 s of witness-only time per 6 s cycle: the bound accrues in cycle five
  // and confirms on the second reading of cycle six.
  assert.equal(loudAt, 31_000);
});

test("🔴 false-red control: a main thread resumed from a suspension reads the stale witness once, and that is not the bound", () => {
  const esc = new WitnessAmberEscalation();
  const gap = withheld(DECODE_WITNESS_UNAVAILABLE);
  sweepJudge(esc, gap, 0, 3_000);
  // Frozen for a minute; the first callback out of the burst reads the stale
  // witness, then the queued heartbeats drain.
  assert.equal(
    esc.judge(gap, 62_000),
    "resecuring",
    "one reading across a gap",
  );
  assert.equal(esc.judge(withheld(W_CLEAN), 62_050), "e2ee");
  assert.equal(esc.escalated, false);
  // Two callbacks fired back to back out of a burst are one observation.
  sweepJudge(esc, gap, 70_000, 73_000);
  assert.equal(esc.judge(gap, 133_000), "resecuring");
  assert.equal(esc.judge(gap, 133_010), "resecuring", "back-to-back = two");
  assert.equal(esc.judge(withheld(W_CLEAN), 133_020), "e2ee");
  // A clock step backwards adds nothing, then or on the next reading.
  sweepJudge(esc, gap, 140_000, 145_000);
  assert.equal(esc.judge(gap, 10_000), "resecuring");
  assert.equal(esc.judge(gap, 145_000), "resecuring");
  assert.equal(esc.judge(gap, 145_500), "resecuring", "re-added the span");
  assert.equal(esc.judge(withheld(W_CLEAN), 146_000), "e2ee");
  // But a witness still dead after the resume IS the bound.
  sweepJudge(esc, gap, 150_000, 153_000);
  assert.equal(esc.judge(gap, 213_000), "resecuring");
  assert.equal(esc.judge(gap, 213_500), "not_encrypted");
});

test("witnessOnlyAmber: true EXACTLY when gate (d) is the one thing between this snapshot and green", () => {
  const dropping: Partial<ChipInputs> = { decodeWitness: W_DROPPING };
  const rows: [string, Partial<ChipInputs>, boolean][] = [
    ["dropping, all else green", dropping, true],
    [
      "dead witness, all else green",
      { decodeWitness: DECODE_WITNESS_UNAVAILABLE },
      true,
    ],
    [
      "unverified roster (green would be e2ee_unverified)",
      { ...dropping, rosterVerified: [true, false] },
      true,
    ],
    ["witness clean: green, not amber", { decodeWitness: W_CLEAN }, false],
    [
      "gate (b): a publisher not observed encrypted",
      {
        ...dropping,
        publishingIdentities: ["bob:d1"],
        observedEncrypted: new Map(),
      },
      false,
    ],
    [
      "our own declaration not GCM",
      { ...dropping, localPublicationsEncrypted: false },
      false,
    ],
    ["a rotation window", { ...dropping, resecuring: true }, false],
    [
      "the session re-securing",
      { ...dropping, sessionState: "resecuring" },
      false,
    ],
    [
      "negotiating (no first key yet)",
      {
        ...dropping,
        mode: NEGOTIATING,
        e2eeEnabled: false,
        hasLocalKey: false,
      },
      false,
    ],
    [
      "a media latch: loud, not amber",
      { ...dropping, latch: MEDIA_KEYED },
      false,
    ],
    ["mixed: loud", { ...dropping, mode: MIXED }, false],
    ["a plain call", { ...dropping, mode: { kind: "off" } }, false],
  ];
  for (const [name, over, want] of rows) {
    assert.equal(witnessOnlyAmber(baseChip(over)), want, name);
  }
});

test("🔴 the escalated chip always carries a banner, in every mode and state it can stay loud into", () => {
  const states = [
    "starting",
    "active",
    "plaintext",
    "resecuring",
    "failed",
    "closed",
  ] as const;
  let loud = 0;
  for (const mode of ALL_MODES) {
    for (const sessionState of states) {
      const esc = new WitnessAmberEscalation();
      sweepJudge(esc, withheld(W_DROPPING), 0, 22_000);
      assert.equal(esc.escalated, true);
      const chip = esc.judge(baseChip({ mode, sessionState }), 23_000);
      const where = JSON.stringify({ mode, sessionState, chip });
      if (chip === "none") {
        // The claim ended (a plain call, still starting): reset, not hidden.
        assert.equal(esc.escalated, false, where);
        continue;
      }
      assert.ok(chip === "not_encrypted" || chip === "cannot_verify", where);
      const banner = seatBanner(chip, mode);
      assert.notEqual(
        banner.kind,
        "none",
        `a loud chip with no banner: ${where}`,
      );
      assert.notEqual(banner.kind, "securing", where);
      loud++;
    }
  }
  assert.ok(loud > 0);
});

test("🔴 readiness `paused` is `unsupported` on every banner input but for its own kind, `ios_paused`", () => {
  // Same precedence, same pause clause, same float rule: only the kind's
  // name differs, so the banner can say "paused" rather than "not available
  // on this device", which is false for a server switch.
  const asUnsupported = (b: CallBanner): CallBanner =>
    b.kind === "ios_paused" ? { ...b, kind: "device_unsupported" } : b;
  let hits = 0;
  let paused = 0;
  for (const chip of ALL_CHIPS)
    for (const mode of ALL_MODES)
      for (const hasSession of [false, true])
        for (const latchedError of [false, true])
          for (const [pauseDisproved, pauseDisproofConfirmed] of FLAGS) {
            const inputs = baseBanner({
              chip,
              mode,
              hasSession,
              latchedError,
              pauseDisproved,
              pauseDisproofConfirmed,
            });
            const got = callBanner({ ...inputs, readiness: "paused" });
            const unsupported = callBanner({
              ...inputs,
              readiness: "unsupported",
            });
            const where = JSON.stringify(inputs);
            assert.notEqual(got.kind, "device_unsupported", where);
            assert.deepEqual(asUnsupported(got), unsupported, where);
            assert.equal(
              bannerParksFloat(got),
              bannerParksFloat(unsupported),
              where,
            );
            hits++;
            if (got.kind === "ios_paused") paused++;
          }
  assert.ok(hits > 0 && paused > 0);
  const banner = callBanner(
    baseBanner({ hasSession: false, readiness: "paused" }),
  );
  assert.deepEqual(banner, { kind: "ios_paused", pause: "none" });
  assert.equal(bannerParksFloat(banner), false);
  // Even a confirmed disproof withdraws on it exactly as on `unsupported`.
  assert.deepEqual(
    callBanner(
      baseBanner({
        hasSession: false,
        readiness: "paused",
        pauseDisproved: true,
        pauseDisproofConfirmed: true,
      }),
    ),
    { kind: "ios_paused", pause: "disproved" },
  );
});

// ---- The Welcome-window exemption: only a provably pre-epoch pair ----------

test("joinWindowMissPredatesEpoch: exactly the eight epochs before the held one, clamped at 0", () => {
  assert.equal(JOIN_WINDOW_PREDATES_DEPTH, 8);
  const predates = joinWindowMissPredatesEpoch;
  // Held at 20 (index 4): epochs 12..19 predate it.
  for (const e of [12, 13, 14, 15, 16, 17, 18, 19]) {
    assert.equal(predates(e % 16, 20), true, `epoch ${e}`);
  }
  // 21..27 (indexes 5..11) are AHEAD and count; index 4 is the held one.
  for (const e of [20, 21, 22, 23, 24, 25, 26, 27]) {
    assert.equal(predates(e % 16, 20), false, `epoch ${e}`);
  }
  // Held at 1: only epoch 0 predates it.
  assert.equal(predates(0, 1), true);
  for (let i = 1; i < 16; i++)
    assert.equal(predates(i, 1), false, `index ${i}`);
  // Held at 0: nothing predates it.
  for (let i = 0; i < 16; i++)
    assert.equal(predates(i, 0), false, `index ${i}`);
});

test("joinWindowMissPredatesEpoch: anything malformed counts (fails closed)", () => {
  for (const [i, e] of [
    [-1, 20],
    [16, 20],
    [1.5, 20],
    [Number.NaN, 20],
    [3, Number.NaN],
    [3, -1],
    [3, Number.POSITIVE_INFINITY],
    [3, 4.5],
  ]) {
    assert.equal(joinWindowMissPredatesEpoch(i, e), false, `(${i}, ${e})`);
  }
});

test("🔴 unfilledPairs: a pre-first-key pair AHEAD of the held epoch stays counted (the sender a withheld commit left us behind)", () => {
  // Welcome at epoch 5. In the window bob was heard at 4 (the Add-grace's
  // old index: predates us) AND at 6 (he advanced while we joined, and the
  // commit that would give us 6 is withheld).
  const ledger = new MediaErrorLedger();
  ledger.noteError(MISSING(4), 1, true);
  ledger.noteError(MISSING(6), 2, true);
  ledger.noteInstalled([entry(5)], 3, 1);
  ledger.noteFirstHeldEpoch(5);
  assert.deepEqual(
    ledger.unfilledPairs(PEER),
    [keyPairId(PEER, 6)],
    "the ahead-of-epoch index was exempted for the life of the group",
  );
  // The genuinely pre-epoch index stays exempt (the H1 false-red guard).
  assert.ok(!ledger.unfilledPairs(PEER).includes(keyPairId(PEER, 4)));
  // Our copy of the commit lands: filled, no longer counted.
  ledger.noteInstalled([entry(6)], 4, 2);
  assert.deepEqual(ledger.unfilledPairs(PEER), []);
});

test("🔴 unfilledPairs: no held epoch recorded means nothing is provably pre-epoch, so every pair counts", () => {
  const ledger = new MediaErrorLedger();
  ledger.noteError(MISSING(4), 1, true);
  ledger.noteInstalled([entry(5)], 2, 1);
  assert.deepEqual(ledger.unfilledPairs(PEER), [keyPairId(PEER, 4)]);
  // A pair heard AFTER the first key never had the exemption.
  ledger.noteFirstHeldEpoch(5);
  ledger.noteError(MISSING(3), 3, false);
  assert.deepEqual(ledger.unfilledPairs(PEER), [keyPairId(PEER, 3)]);
});

test("🔴 unfilledPairs: only the FIRST held epoch judges the Welcome window, and reset forgets it", () => {
  const ledger = new MediaErrorLedger();
  ledger.noteError(MISSING(4), 1, true);
  ledger.noteFirstHeldEpoch(5);
  // Later installs move on; the window's pairs still predate epoch 5. Judged
  // against epoch 14 instead, index 4 would fall outside the eight before it.
  ledger.noteFirstHeldEpoch(14);
  assert.deepEqual(ledger.unfilledPairs(PEER), []);
  // Epoch 0 has nothing before it: index 15 is epoch -1, which never existed.
  const clamped = new MediaErrorLedger();
  clamped.noteError(MISSING(15), 1, true);
  clamped.noteFirstHeldEpoch(0);
  assert.deepEqual(clamped.unfilledPairs(PEER), [keyPairId(PEER, 15)]);
  // A new group: the old held epoch must not exempt the new window's pairs.
  ledger.reset();
  ledger.noteError(MISSING(4), 2, true);
  assert.deepEqual(ledger.unfilledPairs(PEER), [keyPairId(PEER, 4)]);
  ledger.noteFirstHeldEpoch(5);
  assert.deepEqual(ledger.unfilledPairs(PEER), []);
});

// ---- Fix round F: the paused seat, the quiet dropper, the re-arm -----------

// A paused device: the server switch is off, so no session was ever built.
const PAUSED_SEAT: Partial<ChipInputs> = {
  hasSession: false,
  sessionState: undefined,
  mode: undefined,
  e2eeEnabled: false,
  hasLocalKey: false,
  rosterVerified: [],
  pausedByServer: true,
};

test("🔴 a paused device in a call is LOUD whatever the probe, setup and peer terms say (B2)", () => {
  let shapes = 0;
  for (const channelHasOpenGroup of [false, true])
    for (const deviceNeedsSetup of [false, true])
      for (const peerCouldEncrypt of [false, true]) {
        const where = JSON.stringify({
          channelHasOpenGroup,
          deviceNeedsSetup,
          peerCouldEncrypt,
        });
        const chip = chipState(
          baseChip({
            ...PAUSED_SEAT,
            channelHasOpenGroup,
            deviceNeedsSetup,
            peerCouldEncrypt,
          }),
        );
        assert.equal(chip, "not_encrypted", where);
        assert.deepEqual(
          callBanner(
            baseBanner({
              chip,
              mode: undefined,
              hasSession: false,
              latchedError: false,
              readiness: "paused",
            }),
          ),
          { kind: "ios_paused", pause: "none" },
          where,
        );
        shapes++;
      }
  assert.equal(shapes, 8);
  // The shape that read `none` before: iPhone-to-iPhone, no group, nobody
  // else able to encrypt. Not paused, it still rides the probe.
  const quietSeat: Partial<ChipInputs> = {
    ...PAUSED_SEAT,
    channelHasOpenGroup: false,
    deviceNeedsSetup: false,
    peerCouldEncrypt: false,
  };
  assert.equal(chipState(baseChip(quietSeat)), "not_encrypted");
  assert.equal(
    chipState(baseChip({ ...quietSeat, pausedByServer: false })),
    "none",
  );
  // The escalation passes it through untouched and never fires on it.
  const esc = new WitnessAmberEscalation();
  assert.equal(esc.judge(baseChip(quietSeat), 0), "not_encrypted");
  assert.equal(esc.escalated, false);
});

test("🔴 paused outranks every other chip row, a keyed control latch included (never the softer cannot_verify)", () => {
  for (const latch of [
    undefined,
    DIRECT_LATCH,
    MEDIA_KEYED,
    CONTROL_KEYED,
    CONTROL_UNKEYED,
  ])
    for (const mode of ALL_MODES)
      for (const hasSession of [false, true])
        assert.equal(
          chipState(
            baseChip({ pausedByServer: true, latch, mode, hasSession }),
          ),
          "not_encrypted",
          JSON.stringify({ latch, mode, hasSession }),
        );
});

// The failing sender went quiet: nothing arrives, so nothing is decoded and
// nothing is dropped. A clean window that says nothing about bob.
const W_QUIET: DecodeWitness = { available: true, dropping: [], live: [] };

test("🔴 a failing sender that goes QUIET does not reset the clock: the bound is still reached when it sends again (M1)", () => {
  const esc = new WitnessAmberEscalation();
  const drops = withheld(W_DROPPING);
  const quiet = withheld(W_QUIET);
  assert.equal(chipState(quiet), "e2ee");
  for (const [at, chip] of sweepJudge(esc, drops, 0, 11_000)) {
    assert.equal(chip, "resecuring", `${at}`);
  }
  // bob mutes (or holds push-to-talk off) for 30 s: green windows.
  for (const [at, chip] of sweepJudge(esc, quiet, 11_000, 41_000)) {
    assert.equal(chip, "e2ee", `${at}`);
  }
  // He sends again, still at the index this device was never given: the
  // 10 s already accrued count, so the bound lands 10 s later.
  const loudAt = sweepJudge(esc, drops, 41_000, 60_000).find(
    ([, chip]) => chip === "not_encrypted",
  )?.[0];
  assert.equal(loudAt, 52_000, "the quiet stretch reset the clock");
});

test("🔴 an SFU holding the failing sender's packets ~3 s of every 19 s cannot keep the call amber-or-green forever (M1)", () => {
  const esc = new WitnessAmberEscalation();
  let at = 0;
  let loudAt: number | undefined;
  for (let cycle = 0; cycle < 10 && loudAt === undefined; cycle++) {
    for (let i = 0; i < 16 && loudAt === undefined; i++, at += 1_000) {
      if (esc.judge(withheld(W_DROPPING), at) === "not_encrypted") loudAt = at;
    }
    for (let i = 0; i < 3 && loudAt === undefined; i++, at += 1_000) {
      assert.equal(esc.judge(withheld(W_QUIET), at), "e2ee", `${at}`);
    }
  }
  assert.ok(loudAt !== undefined, "the held packets kept resetting the clock");
  // 15 s per 16-reading run: the bound lands in the second run and the next
  // reading confirms it.
  assert.equal(loudAt, 25_000);
});

test("🔴 false-red control: a failing sender seen DECODING, or gone from the call, lets a green reset the clock (M1)", () => {
  // (1) bob decodes again (his commit landed): the green resets.
  const esc = new WitnessAmberEscalation();
  sweepJudge(esc, withheld(W_DROPPING), 0, 15_000);
  assert.equal(esc.judge(withheld(W_CLEAN), 15_000), "e2ee");
  for (const [at, chip] of sweepJudge(
    esc,
    withheld(W_DROPPING),
    16_000,
    35_000,
  )) {
    assert.equal(chip, "resecuring", `bob's decode did not reset, ${at}`);
  }
  // (2) bob LEFT the SFU: the green resets although he was never seen
  // decoding, and carol's later failure starts a clock of its own.
  const gone = new WitnessAmberEscalation();
  sweepJudge(gone, withheld(W_DROPPING), 0, 15_000);
  assert.equal(
    gone.judge(
      { ...withheld(W_QUIET), presentIdentities: ["alice:dA"] },
      15_000,
    ),
    "e2ee",
  );
  const carol: ChipInputs = {
    ...withheld({ available: true, dropping: ["carol:d1"], live: [] }),
    presentIdentities: ["alice:dA", "carol:d1"],
  };
  for (const [at, chip] of sweepJudge(gone, carol, 16_000, 35_000)) {
    assert.equal(chip, "resecuring", `bob's departure did not reset, ${at}`);
  }
  // (3) Mid-rotation — decoding AND dropping in one window — is not "seen
  // decoding": the old index is still being discarded.
  const mid = new WitnessAmberEscalation();
  sweepJudge(mid, withheld(W_DROPPING), 0, 15_000);
  const both = withheld({
    available: true,
    dropping: ["bob:d1"],
    live: ["bob:d1"],
  });
  assert.equal(mid.judge(both, 15_000), "resecuring");
  assert.equal(mid.judge(withheld(W_QUIET), 16_000), "e2ee");
  sweepJudge(mid, withheld(W_DROPPING), 17_000, 23_000);
  assert.equal(mid.judge(withheld(W_DROPPING), 23_000), "not_encrypted");
  // ...and the same window arriving under a rotation's amber (not
  // witness-only, so nothing is recorded there) resolves nothing either.
  const rot = new WitnessAmberEscalation();
  sweepJudge(rot, withheld(W_DROPPING), 0, 15_000);
  assert.equal(rot.judge({ ...both, resecuring: true }, 15_000), "resecuring");
  assert.equal(rot.judge(withheld(W_QUIET), 16_000), "e2ee");
  sweepJudge(rot, withheld(W_DROPPING), 17_000, 24_000);
  assert.equal(
    rot.judge(withheld(W_DROPPING), 24_000),
    "not_encrypted",
    "a mid-rotation window counted as seen decoding",
  );
});

test("🔴 false-red control: a joiner's pre-key drops are not the amber run's, so a sender that then stays quiet holds nothing (M1)", () => {
  // Before the first key every frame is dropped by construction. bob then
  // mutes for the rest of the call, and this device's witness keeps briefly
  // going stale: each gap is witness-only, each ends in a clean window.
  const esc = new WitnessAmberEscalation();
  const preKey = baseChip({
    ...withheld(W_DROPPING),
    mode: NEGOTIATING,
    e2eeEnabled: false,
    hasLocalKey: false,
  });
  sweepJudge(esc, preKey, 0, 10_000);
  let at = 10_000;
  for (let round = 0; round < 5; round++) {
    for (const [t, chip] of sweepJudge(
      esc,
      withheld(DECODE_WITNESS_UNAVAILABLE),
      at,
      at + 15_000,
    )) {
      assert.equal(chip, "resecuring", `round ${round}, ${t}`);
    }
    at += 15_000;
    assert.equal(esc.judge(withheld(W_QUIET), at), "e2ee");
    at += 1_000;
  }
  assert.equal(esc.escalated, false, "pre-key noise pinned the clock");
});

test("🔴 rearm(): a healed media latch drops the escalation, and a LATER withheld commit escalates again after a full bound (m1)", () => {
  const esc = new WitnessAmberEscalation();
  sweepJudge(esc, withheld(W_DROPPING), 0, 22_000);
  assert.equal(esc.escalated, true);
  esc.rearm();
  assert.equal(esc.escalated, false);
  // Re-keyed, bob decodes: green again.
  assert.equal(esc.judge(withheld(W_CLEAN), 22_000), "e2ee");
  // A later withheld commit: amber for the whole bound, then loud.
  for (const [at, chip] of sweepJudge(
    esc,
    withheld(W_DROPPING),
    30_000,
    51_000,
  )) {
    assert.equal(chip, "resecuring", `re-fired early at ${at}`);
  }
  assert.equal(esc.judge(withheld(W_DROPPING), 51_000), "not_encrypted");
  assert.equal(esc.escalated, true);
  // A rearm in the middle of a drop forgets the time accrued before it.
  const busy = new WitnessAmberEscalation();
  sweepJudge(busy, withheld(W_DROPPING), 0, 22_000);
  busy.rearm();
  assert.equal(busy.judge(withheld(W_DROPPING), 22_000), "resecuring");
  assert.equal(
    busy.judge(withheld(W_DROPPING), 23_000),
    "resecuring",
    "rearm kept the time accrued before the heal",
  );
});

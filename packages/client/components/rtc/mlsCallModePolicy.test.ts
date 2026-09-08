// Unit spec for the §3.4 mode machine + §4.4 chip + ctl parser (slice 6.5).
//   node --test components/rtc/mlsCallModePolicy.test.ts   (Node >=23.6 strips types)
// Focus: every numbered transition T0a–T7, the confirm-order invariant
// (set_e2ee(false) strictly before resume), T6-is-the-sole-interlude-exit
// (no warm-enable after a confirmed interlude), the chip precedence table +
// each fail-closed degradation, and default-closed ctl parsing.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CallMode,
  type ChipInputs,
  type LoudHealInputs,
  MediaErrorLedger,
  callModeTransition,
  chipState,
  classifyEncryptionError,
  classifyMediaError,
  isTerminalLoud,
  keyPairId,
  latestPresentAddedAt,
  loudHealVerdict,
  loudModeFallback,
  mixDetectedAction,
  modeUnderLoudLatch,
  parseCtlPayload,
  rotationWindowMs,
} from "./mlsCallModePolicy.ts";

const NEGOTIATING: CallMode = { kind: "negotiating" };
const E2EE: CallMode = { kind: "e2ee" };
const MIXED: CallMode = { kind: "mixed" };
const INTERLUDE_UNCONF: CallMode = { kind: "interlude", localConfirmed: false };
const INTERLUDE_CONF: CallMode = { kind: "interlude", localConfirmed: true };

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
  assert.deepEqual(t.mode, { kind: "interlude", localConfirmed: true });
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
  assert.deepEqual(t.mode, { kind: "interlude", localConfirmed: true });
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
  assert.deepEqual(t.mode, { kind: "interlude", localConfirmed: true });
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

test("off is terminal for mode purposes (a non-E2EE call has no group)", () => {
  const t = callModeTransition({ kind: "off" }, { type: "mix_detected" });
  assert.deepEqual(t.mode, { kind: "off" });
});

// ---- Chip precedence + fail-closed -----------------------------------------

const baseChip = (over: Partial<ChipInputs>): ChipInputs => ({
  hasSession: true,
  sessionState: "active",
  mode: E2EE,
  e2eeEnabled: true,
  hasLocalKey: true,
  resecuring: false,
  latchedError: false,
  publishingIdentities: [],
  observedEncrypted: new Map(),
  localPublicationsEncrypted: true,
  rosterVerified: [true, true],
  channelHasOpenGroup: true,
  capableAndEnabled: true,
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
  assert.equal(
    chipState(
      baseChip({ localPublicationsEncrypted: false, latchedError: true }),
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
  assert.equal(chipState(baseChip({ latchedError: true })), "not_encrypted");
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
    chipState(baseChip({ resecuring: true, latchedError: false })),
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
    chipState(baseChip({ resecuring: true, latchedError: true })),
    "not_encrypted",
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
      latchedError: false,
      publishingIdentities: [],
      observedEncrypted: new Map(),
      localPublicationsEncrypted: true,
      rosterVerified: [],
      channelHasOpenGroup: false,
      capableAndEnabled: false,
    }),
    "none",
  );
});

test("chip ME-7/R2-4: capable+enabled, NO session, open E2EE group ⇒ not_encrypted (silent-fail guard)", () => {
  assert.equal(
    chipState({
      hasSession: false,
      e2eeEnabled: false,
      hasLocalKey: false,
      resecuring: false,
      latchedError: false,
      publishingIdentities: [],
      observedEncrypted: new Map(),
      localPublicationsEncrypted: true,
      rosterVerified: [],
      channelHasOpenGroup: true,
      capableAndEnabled: true,
    }),
    "not_encrypted",
  );
});

test("chip §0.2#9 self-attribution: toggle-OFF self in an E2EE channel ⇒ not_encrypted", () => {
  assert.equal(
    chipState({
      hasSession: false,
      e2eeEnabled: false,
      hasLocalKey: false,
      resecuring: false,
      latchedError: false,
      publishingIdentities: [],
      observedEncrypted: new Map(),
      localPublicationsEncrypted: true,
      rosterVerified: [],
      channelHasOpenGroup: true,
      capableAndEnabled: false,
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

// ---- terminal-loud banner predicate (ME-10) ---------------------------------

test("terminal-loud: loud failure while negotiating (original ME-10 shape)", () => {
  assert.equal(isTerminalLoud(NEGOTIATING, "not_encrypted", true), true);
  // Retry exhaustion can go loud without a structured error latched while
  // the mode still reads negotiating — the original condition, unchanged.
  assert.equal(isTerminalLoud(NEGOTIATING, "not_encrypted", false), true);
});

test("terminal-loud: refusal inside establish() — failed before ANY mode verdict (store-owner mismatch)", () => {
  // The session dies before onCallModeChanged ever fires, so the UI's mode
  // signal still reads undefined. This is the case the banner's Reset
  // encryption leg exists for; requiring `negotiating` made it unreachable.
  assert.equal(isTerminalLoud(undefined, "not_encrypted", true), true);
});

test("terminal-loud: attribution chips without a latched error never raise the banner", () => {
  // chipState reads not_encrypted with NO session for the ME-7/§0.2#9
  // branches (web participant, toggle-off self). Without a latched error
  // that is attribution, not a failure — no banner.
  assert.equal(isTerminalLoud(undefined, "not_encrypted", false), false);
});

test("terminal-loud: any emitted mode verdict other than negotiating is not terminal", () => {
  // mixed/interlude have their own banner arms; off is a quiet plain call.
  assert.equal(isTerminalLoud({ kind: "off" }, "not_encrypted", true), false);
  assert.equal(isTerminalLoud(MIXED, "not_encrypted", true), false);
});

test("terminal-loud: requires the loud chip", () => {
  assert.equal(isTerminalLoud(NEGOTIATING, "resecuring", true), false);
  assert.equal(isTerminalLoud(undefined, "none", true), false);
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
  // way out": isTerminalLoud and confirmPlaintext both key on negotiating.
  const fallback = loudModeFallback(E2EE);
  assert.deepEqual(fallback, NEGOTIATING);
  assert.equal(isTerminalLoud(fallback!, "not_encrypted", true), true);
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
  assert.equal(isTerminalLoud(folded, "not_encrypted", true), true);
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
  assert.equal(isTerminalLoud(t2, "not_encrypted", true), true);
});

test("chip: negotiating + latched error is loud; negotiating without one is amber", () => {
  const base: ChipInputs = {
    hasSession: true,
    sessionState: "active",
    mode: NEGOTIATING,
    e2eeEnabled: false,
    hasLocalKey: false,
    resecuring: false,
    latchedError: false,
    publishingIdentities: [],
    observedEncrypted: new Map(),
    localPublicationsEncrypted: true,
    rosterVerified: [],
    channelHasOpenGroup: true,
    capableAndEnabled: true,
  };
  assert.equal(chipState({ ...base, latchedError: true }), "not_encrypted");
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
    pair: keyPairId(PEER, 13),
  });
  assert.deepEqual(classifyMediaError(MISSING(2, `${PEER}:screen`)), {
    kind: "missing_key",
    pair: `${PEER}:screen@2`,
  });
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
  ledger.noteInstalled([entry(13)]); // the install resolves at ~1_010
  assert.equal(ledger.errorSince(installRef), true);
  // An error strictly before the reference is the latch's own, not since.
  const older = new MediaErrorLedger();
  older.noteError(INVALID, 999);
  older.noteInstalled([entry(13)]);
  assert.equal(older.errorSince(installRef), false);
  // At the reference itself: since (conservative).
  const same = new MediaErrorLedger();
  same.noteError(INVALID, installRef);
  assert.equal(same.errorSince(installRef), true);
});

test("a missing key for a pair the install covers is superseded, whichever lands first", () => {
  // The join-race MissingKey: the worker judged the frame before the setKey
  // message reached it, so the setKey resets the index afterwards.
  const before = new MediaErrorLedger();
  before.noteError(MISSING(13), 1_005);
  before.noteInstalled([entry(13)]);
  assert.equal(before.errorSince(1_000), false);
  assert.deepEqual(before.uncoveredPairs(), []);
  // The error reaches the main thread after the install resolved.
  const after = new MediaErrorLedger();
  after.noteInstalled([entry(13)]);
  after.noteError(MISSING(13), 1_020);
  assert.equal(after.errorSince(1_000), false);
  // Previous-epoch entries count as installed too.
  const prev = new MediaErrorLedger();
  prev.noteError(MISSING(12), 900);
  prev.noteInstalled([entry(12), entry(13)]);
  assert.equal(prev.errorSince(1_000), false);
});

test("🔴 a missing key for a pair NO install covers holds regardless of when it landed", () => {
  // A sender at an index this side does not hold: its index is silenced after
  // the one error (failureTolerance 0), so silence proves nothing.
  const ledger = new MediaErrorLedger();
  ledger.noteError(MISSING(14), 500); // before the reference
  ledger.noteInstalled([entry(13)]);
  assert.equal(ledger.errorSince(1_000), true);
  assert.deepEqual(ledger.uncoveredPairs(), [keyPairId(PEER, 14)]);
  // Only an install of that pair answers it.
  ledger.noteInstalled([entry(14)]);
  assert.equal(ledger.errorSince(1_000), false);
});

test("forgetHardError keeps the uncovered pairs; reset forgets the replaced group's indexes", () => {
  const ledger = new MediaErrorLedger();
  ledger.noteError(INVALID, 1_005);
  ledger.noteError(MISSING(14), 1_006);
  ledger.forgetHardError(); // a healed latch
  assert.equal(ledger.errorSince(1_000), true); // pair 14 still uncovered
  ledger.reset(); // group re-established: new indexes
  assert.equal(ledger.errorSince(1_000), false);
  // After a reset a pair installed under the old group is unknown again, so
  // a missing key for it is a real hold until the new group installs it.
  ledger.noteError(MISSING(0), 2_000);
  assert.equal(ledger.errorSince(1_500), true);
  ledger.noteInstalled([entry(0)]);
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
  leg9.noteInstalled([entry(12)]); // Remove epoch at 1_000
  leg9.noteError(MISSING(13), 2_005); // join-race frame during the Add install
  leg9.noteInstalled([entry(13)]); // Add epoch at 2_000, supersedes it
  assert.equal(judge(leg9, 2_000), "heal"); // nothing since — so far
  leg9.noteError(INVALID, 2_400); // first frame under the new key fails
  assert.equal(judge(leg9, 2_000), "hold");
  // Leg 7: released before the rejoin; the new-key frames decrypt.
  const leg7 = new MediaErrorLedger();
  leg7.noteError(INVALID, 100);
  leg7.noteInstalled([entry(12)]);
  leg7.noteError(MISSING(13), 2_005);
  leg7.noteInstalled([entry(13)]);
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

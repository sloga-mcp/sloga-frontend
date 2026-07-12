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
  callModeTransition,
  chipState,
  parseCtlPayload,
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

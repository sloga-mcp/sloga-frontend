// Unit spec for the §3.4 mode machine + §4.4 chip + ctl parser (slice 6.5).
//   node --test components/rtc/mlsCallModePolicy.test.ts   (Node >=23.6 strips types)
// Focus: every numbered transition T0a–T7, the confirm-order invariant
// (set_e2ee(false) strictly before resume), T6-is-the-sole-interlude-exit
// (no warm-enable after a confirmed interlude), the chip precedence table +
// each fail-closed degradation, and default-closed ctl parsing.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CallBannerInputs,
  type CallMode,
  type ChipInputs,
  type LoudHealInputs,
  callBannerState,
  callModeTransition,
  chipState,
  classifyEncryptionError,
  isTerminalLoud,
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

test("terminal-loud: attribution chips without a latched error are not a LOUD failure", () => {
  // chipState reads not_encrypted with NO session for the ME-7/§0.2#9
  // branches (web participant, a device with no encryption set up). Nothing
  // was attempted, so nothing latched and nothing is paused — the loud
  // banner's copy and its "Stay unencrypted" release would both be wrong.
  // They are NOT bannerless: `callBannerState` gives them the device arms.
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

// ---- Which banner a chip carries (the no-dead-end invariant) ----------------

const baseBanner = (over: Partial<CallBannerInputs>): CallBannerInputs => ({
  chip: "not_encrypted",
  mode: undefined,
  latchedError: false,
  readiness: "needs_setup",
  ...over,
});

test("banner: the §3.4 downgrade modes keep their own banners", () => {
  assert.equal(
    callBannerState(baseBanner({ mode: MIXED, readiness: "ready" })),
    "mixed",
  );
  assert.equal(
    callBannerState(baseBanner({ mode: INTERLUDE_CONF, readiness: "ready" })),
    "interlude",
  );
  assert.equal(
    callBannerState(baseBanner({ mode: INTERLUDE_UNCONF, readiness: "ready" })),
    "interlude",
  );
});

test("banner: a ready device with a red chip is a CALL failure — terminal loud", () => {
  assert.equal(
    callBannerState(
      baseBanner({ mode: NEGOTIATING, latchedError: true, readiness: "ready" }),
    ),
    "terminal_loud",
  );
  // The capable-but-sessionless R2-4 hold: `negotiating` is still in the
  // publish gate and the error IS latched, so "your audio and video stay
  // paused" is true.
  assert.equal(
    callBannerState(baseBanner({ latchedError: true, readiness: "ready" })),
    "terminal_loud",
  );
});

test("🔴 banner: call_full is no longer silent (it latches, and the gate is held)", () => {
  // `#onCallFull` runs `#onLoud` before `#applyMode({type:"call_full"})`, so
  // the error is latched and `loudModeFallback` has re-asserted the
  // negotiating gate — the loud copy is true. `isTerminalLoud` returns false
  // here (the mode is not negotiating), which is precisely why routing the
  // banner through it left this red chip bare.
  assert.equal(
    isTerminalLoud({ kind: "call_full" }, "not_encrypted", true),
    false,
  );
  assert.equal(
    callBannerState(
      baseBanner({
        mode: { kind: "call_full" },
        latchedError: true,
        readiness: "ready",
      }),
    ),
    "terminal_loud",
  );
});

test("banner: a device that cannot encrypt owns the banner, whatever the call did", () => {
  // Nothing about the CALL is the cause, so the loud copy and a per-call
  // escape would both be wrong: this is the §7.4 red-chip-with-no-banner
  // state. Holds even with a latched error, which `owned_elsewhere` always
  // has (it stays capable and the setup decision holds it loud).
  assert.equal(
    callBannerState(baseBanner({ readiness: "needs_setup" })),
    "device_not_set_up",
  );
  assert.equal(
    callBannerState(
      baseBanner({ readiness: "owned_elsewhere", latchedError: true }),
    ),
    "device_not_set_up",
  );
  assert.equal(
    callBannerState(baseBanner({ readiness: "unsupported" })),
    "device_unsupported",
  );
});

test("🔴 banner: an unknown-cause red chip never falls back to 'this app can't encrypt'", () => {
  // `unsupported` is a POSITIVE fact the shell knows about itself. Making it
  // the fallback for "we don't know" tells someone whose call just failed the
  // most reassuring and least actionable thing available (reviewer F4).
  assert.equal(
    callBannerState(baseBanner({ readiness: "ready", mode: { kind: "off" } })),
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
    ] as const)
      assert.equal(
        callBannerState(baseBanner({ chip, mode: E2EE, readiness })),
        "none",
      );
});

test("🔴 a REFUSED device is loud with no dependence on the open-group probe", () => {
  // The hole the first cut of this fix opened (reviewer F1, CRITICAL): a
  // device treated as non-capable asserts no gate, latches nothing, and
  // `chipState`'s no-session branches are gated on `channelHasOpenGroup` — so
  // alone in a channel with no group yet it published plaintext under chip
  // `none` with NO chrome at all. Staying CAPABLE is what fixes it: the setup
  // decision holds loud, the error latches, and `latchedError` is the FIRST
  // term of the chip, ahead of every probe-dependent branch.
  for (const channelHasOpenGroup of [false, true]) {
    const chip = chipState(
      baseChip({
        hasSession: false,
        sessionState: undefined,
        mode: undefined,
        e2eeEnabled: false,
        hasLocalKey: false,
        latchedError: true,
        rosterVerified: [],
        channelHasOpenGroup,
        capableAndEnabled: true,
      }),
    );
    assert.equal(chip, "not_encrypted", `probe=${channelHasOpenGroup}`);
    assert.equal(
      callBannerState({
        chip,
        mode: undefined,
        latchedError: true,
        readiness: "owned_elsewhere",
      }),
      "device_not_set_up",
    );
  }
});

test("🔴 KNOWN GAP (pre-existing): a NEVER-ENROLLED device is silent until the probe says open", () => {
  // `needs_setup` is genuinely not capable — no identity, no gate, no latch —
  // so its chrome rides on `channelHasOpenGroup`, which is probed ONCE at
  // connect. If the group opens after that, this device stays quiet for the
  // rest of the call while its peers pause behind the mixed banner naming it.
  // Asserted so the gap is visible and this spec fails the day someone
  // re-probes or wires a second signal — not because the behaviour is wanted.
  const quiet = chipState(
    baseChip({
      hasSession: false,
      sessionState: undefined,
      mode: undefined,
      e2eeEnabled: false,
      hasLocalKey: false,
      rosterVerified: [],
      channelHasOpenGroup: false,
      capableAndEnabled: false,
    }),
  );
  assert.equal(quiet, "none");
  assert.equal(
    callBannerState({
      chip: quiet,
      mode: undefined,
      latchedError: false,
      readiness: "needs_setup",
    }),
    "none",
  );
});

test("🔴 INVARIANT: every NOT-ENCRYPTED chip carries a banner (exhaustive)", () => {
  // The design rule this whole change exists to make checkable: a red chip is
  // never a dead end. Swept over the chip's entire input space rather than the
  // handful of shapes anyone thought to write down — that is how the ME-7 and
  // §0.2 #9 no-session branches sat bannerless through five reviews.
  const MODES: (CallMode | undefined)[] = [
    undefined,
    NEGOTIATING,
    { kind: "off" },
    E2EE,
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_CONF,
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
  ] as const;
  const BOOLS = [false, true];
  const PUBLISHERS: { p: string[]; o: Map<string, boolean> }[] = [
    { p: [], o: new Map() },
    { p: ["u:d"], o: new Map([["u:d", true]]) },
    { p: ["u:d"], o: new Map() },
  ];

  let red = 0;
  for (const hasSession of BOOLS)
    for (const sessionState of STATES)
      for (const mode of MODES)
        for (const e2eeEnabled of BOOLS)
          for (const hasLocalKey of BOOLS)
            for (const resecuring of BOOLS)
              for (const latchedError of BOOLS)
                for (const channelHasOpenGroup of BOOLS)
                  for (const capableAndEnabled of BOOLS)
                    for (const localPublicationsEncrypted of BOOLS)
                      for (const rosterVerified of [[], [true], [false]])
                        for (const pub of PUBLISHERS) {
                          const inputs: ChipInputs = {
                            hasSession,
                            sessionState,
                            mode,
                            e2eeEnabled,
                            hasLocalKey,
                            resecuring,
                            latchedError,
                            publishingIdentities: pub.p,
                            observedEncrypted: pub.o,
                            localPublicationsEncrypted,
                            rosterVerified,
                            channelHasOpenGroup,
                            capableAndEnabled,
                          };
                          if (chipState(inputs) !== "not_encrypted") continue;
                          red++;
                          for (const readiness of READINESS)
                            assert.notEqual(
                              callBannerState({
                                chip: "not_encrypted",
                                mode,
                                latchedError,
                                readiness,
                              }),
                              "none",
                              `red chip with no banner: ${JSON.stringify({
                                hasSession,
                                sessionState,
                                mode,
                                latchedError,
                                channelHasOpenGroup,
                                capableAndEnabled,
                                readiness,
                              })}`,
                            );
                        }
  // A sweep that found no red chips would pass vacuously.
  assert.ok(red > 1000, `expected a large red-chip sample, got ${red}`);
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

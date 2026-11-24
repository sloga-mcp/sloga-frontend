// Spec for the history rules of the Protected channel settings page (S4
// lane U5; design 9.5, 4.9 "S4", plan O-5), run with Node's built-in runner
// from packages/client:
//   node --conditions=browser --test components/app/interface/settings/channel/protected/protectedHistorySettings.test.ts
//
// The page's wiring to these rules is scanned by
// `protectedSettings.scan.test.ts` (S28 to S35).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type HistorySectionInput,
  type HistorySectionModel,
  type HistoryVerifyAsks,
  type HistoryVerifyInput,
  type ProtectDraft,
  HISTORY_CHECK_LINE_MS,
  historyCheckWaitMs,
  historyCheckingShown,
  historyFailureKind,
  historySectionModel,
  historyToggleClick,
  historyVerifyStep,
  newProtectDraft,
  protectDraftStep,
  protectOpts,
  protectOutcomeKind,
  wipeClickAllowed,
  wipeProgress,
} from "./protectedHistorySettings.ts";

const BOUNDARY = "01JD3K8Q2VZ0000000000000AB";

/** An owner on a capable device, flag on, native verified, page idle. */
const READY: HistorySectionInput = {
  isOwner: true,
  flag: true,
  canAct: true,
  native: {
    verified: true,
    historySetting: "hidden",
    boundary: BOUNDARY,
    preHistory: "kept",
  },
  serverWipe: { state: "none" },
  busy: false,
  storedChange: false,
};

const model = (over: Partial<HistorySectionInput> = {}): HistorySectionModel =>
  historySectionModel({ ...READY, ...over });

const native = (over: Record<string, unknown>) => ({
  ...READY.native!,
  ...over,
});

/** The owner arm, or a failure. */
function owner(over: Partial<HistorySectionInput> = {}) {
  const m = model(over);
  assert.equal(m.kind, "owner");
  if (m.kind !== "owner") throw new Error("unreachable");
  return m;
}

const CLOSED: ProtectDraft = {
  open: false,
  wipeTicked: false,
  wipeArmed: false,
};

test("U5: the protect form opens unticked every time, and nothing is restored", () => {
  assert.deepEqual(newProtectDraft(), CLOSED);
  assert.equal(newProtectDraft.length, 0, "no input: nothing to restore from");
  const opened = protectDraftStep(newProtectDraft(), { type: "open" });
  assert.deepEqual(opened, { open: true, wipeTicked: false, wipeArmed: false });
  // Opening again after a tick, an armed tick or a finished protect: unticked.
  const ticked = protectDraftStep(opened, { type: "tick", checked: true });
  assert.equal(ticked.wipeTicked, true);
  const armed = protectDraftStep(ticked, { type: "continue" });
  for (const from of [ticked, armed, CLOSED]) {
    assert.deepEqual(protectDraftStep(from, { type: "open" }), {
      open: true,
      wipeTicked: false,
      wipeArmed: false,
    });
  }
  // Closing forgets the tick.
  assert.deepEqual(protectDraftStep(ticked, { type: "cancel" }), CLOSED);
  assert.deepEqual(protectDraftStep(armed, { type: "cancel" }), CLOSED);
  assert.deepEqual(protectDraftStep(armed, { type: "done" }), CLOSED);
});

test("U5: a wipe is sent only for a tick made in the form that opened the picker", () => {
  const opened = protectDraftStep(newProtectDraft(), { type: "open" });
  // Continue without a tick: not armed.
  assert.equal(protectDraftStep(opened, { type: "continue" }).wipeArmed, false);
  // Ticked, then continue: armed, and the form is closed and unticked.
  const ticked = protectDraftStep(opened, { type: "tick", checked: true });
  assert.deepEqual(protectDraftStep(ticked, { type: "continue" }), {
    open: false,
    wipeTicked: false,
    wipeArmed: true,
  });
  // Ticked and unticked again: not armed.
  const unticked = protectDraftStep(ticked, { type: "tick", checked: false });
  assert.equal(
    protectDraftStep(unticked, { type: "continue" }).wipeArmed,
    false,
  );
  // Only a literal true ticks.
  for (const v of ["true", 1, {}, null, undefined, "on"]) {
    const t = protectDraftStep(opened, { type: "tick", checked: v });
    assert.equal(t.wipeTicked, false, `tick ${String(v)}`);
    assert.equal(protectDraftStep(t, { type: "continue" }).wipeArmed, false);
  }
  // A tick or a continue with no form open arms nothing.
  assert.deepEqual(
    protectDraftStep(CLOSED, { type: "tick", checked: true }),
    CLOSED,
  );
  assert.equal(protectDraftStep(CLOSED, { type: "continue" }).wipeArmed, false);
  // A state that claims a tick without an open form (a stale or restored
  // object) arms nothing either.
  assert.equal(
    protectDraftStep(
      { open: false, wipeTicked: true, wipeArmed: false },
      { type: "continue" },
    ).wipeArmed,
    false,
  );
  // A second continue never keeps an earlier arm.
  const armed = protectDraftStep(ticked, { type: "continue" });
  assert.equal(protectDraftStep(armed, { type: "continue" }).wipeArmed, false);
  // A tick after arming (the form reopened by another path) disarms.
  assert.equal(
    protectDraftStep({ ...armed, open: true }, { type: "tick", checked: false })
      .wipeArmed,
    false,
  );
  // An unknown event closes the form unticked.
  assert.deepEqual(
    protectDraftStep(ticked, { type: "restore" } as never),
    CLOSED,
  );
});

test("U5: protect opts are absent without history and carry the wipe only when armed", () => {
  // No history: the call made before S4, whatever the draft says.
  assert.equal(
    protectOpts({ withHistory: false, wipeArmed: false }),
    undefined,
  );
  assert.equal(protectOpts({ withHistory: false, wipeArmed: true }), undefined);
  assert.equal(
    protectOpts({ withHistory: undefined, wipeArmed: true }),
    undefined,
  );
  assert.equal(
    protectOpts({ withHistory: "true", wipeArmed: true }),
    undefined,
  );
  // History without a tick keeps the earlier messages.
  assert.deepEqual(protectOpts({ withHistory: true, wipeArmed: false }), {
    withHistory: true,
    wipe: false,
  });
  assert.deepEqual(protectOpts({ withHistory: true, wipeArmed: true }), {
    withHistory: true,
    wipe: true,
  });
  for (const v of [undefined, null, "true", 1, {}]) {
    assert.deepEqual(
      protectOpts({ withHistory: true, wipeArmed: v }),
      { withHistory: true, wipe: false },
      `armed ${String(v)}`,
    );
  }
  // End to end: a fresh form that was continued without a tick.
  const d = protectDraftStep(
    protectDraftStep(newProtectDraft(), { type: "open" }),
    { type: "continue" },
  );
  assert.deepEqual(protectOpts({ withHistory: true, wipeArmed: d.wipeArmed }), {
    withHistory: true,
    wipe: false,
  });
});

test("U5: no history section with the history flag off", () => {
  assert.equal(owner().kind, "owner");
  // Not fetched, fetch failed, an older server: all read as not true.
  for (const flag of [false, undefined, null, "true", 1, {}]) {
    assert.deepEqual(model({ flag }), { kind: "none" }, `flag ${String(flag)}`);
  }
});

test("U5: no history section for anyone but the owner", () => {
  for (const isOwner of [false, undefined, null, "true", 1]) {
    assert.deepEqual(
      model({ isOwner }),
      { kind: "none" },
      `isOwner ${String(isOwner)}`,
    );
  }
  // Not even with history visible and a wipe in progress.
  assert.deepEqual(
    model({
      isOwner: false,
      native: native({ historySetting: "visible" }),
      serverWipe: { state: "requested" },
    }),
    { kind: "none" },
  );
});

test("U5: no history section while native state is loading or unverified", () => {
  assert.deepEqual(model({ native: null }), { kind: "none" });
  assert.deepEqual(model({ native: undefined }), { kind: "none" });
  for (const verified of [false, undefined, null, "true", 1]) {
    assert.deepEqual(
      model({ native: native({ verified }) }),
      { kind: "none" },
      `verified ${String(verified)}`,
    );
  }
  // No known history line (no list held, or a newer value): nothing.
  for (const historySetting of [undefined, null, "", "shown", true]) {
    assert.deepEqual(
      model({ native: native({ historySetting }) }),
      { kind: "none" },
      `setting ${String(historySetting)}`,
    );
  }
  // A device that can't act on the channel gets nothing either.
  for (const canAct of [false, undefined, "true"]) {
    assert.deepEqual(model({ canAct }), { kind: "none" });
  }
});

test("U5: the toggle shows native's verified setting, never the server's", () => {
  assert.equal(owner().toggle.checked, false);
  assert.equal(
    owner({ native: native({ historySetting: "visible" }) }).toggle.checked,
    true,
  );
  // Whatever the server's object claims, native decides.
  const serverSaysVisible = {
    state: "none",
    history: "visible",
    history_setting: "visible",
    visible: true,
  };
  assert.equal(owner({ serverWipe: serverSaysVisible }).toggle.checked, false);
  const serverSaysHidden = {
    state: "none",
    history: "hidden",
    history_setting: "hidden",
    visible: false,
  };
  assert.equal(
    owner({
      native: native({ historySetting: "visible" }),
      serverWipe: serverSaysHidden,
    }).toggle.checked,
    true,
  );
});

test("U5: the removal note shows only while history is hidden", () => {
  assert.equal(owner().removalNote, true);
  assert.equal(
    owner({ native: native({ historySetting: "visible" }) }).removalNote,
    false,
  );
});

test("U5: the toggle and the wipe are disabled unless the page is idle", () => {
  const idle = owner();
  assert.equal(idle.toggle.disabled, false);
  assert.equal(idle.wipe.disabled, false);
  // Busy (an owner call or an unresolved publish), or anything not a plain
  // false, disables both.
  for (const busy of [true, undefined, null, "false", 0]) {
    const m = owner({ busy });
    assert.equal(m.toggle.disabled, true, `busy ${String(busy)}: toggle`);
    assert.equal(m.wipe.disabled, true, `busy ${String(busy)}: wipe`);
  }
  // A stored, unresolved change (a recovery included) disables both.
  for (const storedChange of [true, undefined, null]) {
    const m = owner({ storedChange });
    assert.equal(m.toggle.disabled, true);
    assert.equal(m.wipe.disabled, true);
  }
  // Disabled, the toggle still shows the verified setting.
  assert.equal(owner({ busy: true }).toggle.checked, false);
  assert.equal(
    owner({ busy: true, native: native({ historySetting: "visible" }) }).toggle
      .checked,
    true,
  );
});

test("U5: a toggle click is never optimistic and sends only a real change", () => {
  const hidden = owner();
  const visible = owner({ native: native({ historySetting: "visible" }) });
  // The box keeps the verified setting whatever the click asked for.
  assert.deepEqual(historyToggleClick(hidden, true), {
    shown: false,
    request: true,
  });
  assert.deepEqual(historyToggleClick(visible, false), {
    shown: true,
    request: false,
  });
  // No change: nothing sent.
  assert.deepEqual(historyToggleClick(hidden, false), {
    shown: false,
    request: null,
  });
  assert.deepEqual(historyToggleClick(visible, true), {
    shown: true,
    request: null,
  });
  // While a change is pending the toggle is disabled: nothing sent, and
  // the box still shows the verified setting.
  const pending = owner({ busy: true });
  assert.deepEqual(historyToggleClick(pending, true), {
    shown: false,
    request: null,
  });
  // Not a boolean: nothing sent.
  for (const asked of ["true", 1, null, undefined, {}]) {
    assert.deepEqual(historyToggleClick(hidden, asked), {
      shown: false,
      request: null,
    });
  }
  // No section: nothing sent, nothing shown as on.
  assert.deepEqual(historyToggleClick({ kind: "none" }, true), {
    shown: false,
    request: null,
  });
});

test("U5: the wipe is offered only while native says kept and holds a boundary", () => {
  assert.equal(owner().wipe.offered, true);
  // After the wipe native says wiped: never offered again.
  assert.equal(
    owner({ native: native({ preHistory: "wiped" }) }).wipe.offered,
    false,
  );
  for (const preHistory of [null, undefined, "", "KEPT", true]) {
    assert.equal(
      owner({ native: native({ preHistory }) }).wipe.offered,
      false,
      `pre_history ${String(preHistory)}`,
    );
  }
  // A channel protected while empty has no boundary: nothing to wipe.
  for (const boundary of [null, undefined, "", 5]) {
    assert.equal(
      owner({ native: native({ boundary }) }).wipe.offered,
      false,
      `boundary ${String(boundary)}`,
    );
  }
  // The server's wipe state never offers it.
  for (const state of ["none", "requested", "done"]) {
    assert.equal(
      owner({
        native: native({ preHistory: "wiped" }),
        serverWipe: { state, count: 3 },
      }).wipe.offered,
      false,
      `server ${state}`,
    );
  }
  // Nor does a server object that names the native fields.
  assert.equal(
    owner({
      native: native({ preHistory: null }),
      serverWipe: { state: "none", pre_history: "kept", preHistory: "kept" },
    }).wipe.offered,
    false,
  );
});

test("U5: a wipe click is refused while busy or when the wipe is not offered", () => {
  assert.equal(wipeClickAllowed(owner()), true);
  // The first click sets the page busy: the second is refused.
  assert.equal(wipeClickAllowed(owner({ busy: true })), false);
  assert.equal(wipeClickAllowed(owner({ storedChange: true })), false);
  assert.equal(
    wipeClickAllowed(owner({ native: native({ preHistory: "wiped" }) })),
    false,
  );
  assert.equal(wipeClickAllowed({ kind: "none" }), false);
  assert.equal(wipeClickAllowed(model({ flag: false })), false);
  assert.equal(wipeClickAllowed(model({ isOwner: false })), false);
  assert.equal(wipeClickAllowed(model({ native: null })), false);
});

test("U5: wipe progress text is chosen from the server's wipe state", () => {
  assert.deepEqual(wipeProgress({ state: "none" }), { kind: "none" });
  assert.deepEqual(wipeProgress({ state: "requested", at: "x", by: "U" }), {
    kind: "requested",
  });
  assert.deepEqual(wipeProgress({ state: "done", at: "x", count: 12 }), {
    kind: "done",
    count: 12,
  });
  assert.deepEqual(wipeProgress({ state: "done", count: 0 }), {
    kind: "done",
    count: 0,
  });
  // Only a whole number of 0 or more is a count.
  for (const count of [-1, 1.5, "12", null, undefined, NaN, 2 ** 53]) {
    assert.deepEqual(
      wipeProgress({ state: "done", count }),
      { kind: "done", count: null },
      `count ${String(count)}`,
    );
  }
  // Anything unreadable is no progress.
  for (const raw of [undefined, null, "done", 5, {}, { state: "running" }]) {
    assert.deepEqual(wipeProgress(raw), { kind: "none" });
  }
  // In the section: only once native says wiped (audit B8).
  for (const serverWipe of [
    { state: "requested" },
    { state: "done", count: 7 },
  ]) {
    assert.deepEqual(owner({ serverWipe }).progress, { kind: "none" });
  }
  assert.deepEqual(
    owner({
      native: native({ preHistory: "wiped" }),
      serverWipe: { state: "requested" },
    }).progress,
    { kind: "requested" },
  );
  assert.deepEqual(
    owner({
      native: native({ preHistory: "wiped" }),
      serverWipe: { state: "done", count: 7 },
    }).progress,
    { kind: "done", count: 7 },
  );
  assert.deepEqual(owner().progress, { kind: "none" });
  // A channel native holds no boundary for shows no wipe progress.
  assert.deepEqual(
    owner({
      native: native({ boundary: null }),
      serverWipe: { state: "done", count: 7 },
    }).progress,
    { kind: "none" },
  );
});

test("U5: only the three history failures have a line of their own", () => {
  for (const reason of ["protect_busy", "wipe_refused", "clock_behind"]) {
    assert.equal(historyFailureKind({ source: "client", reason }), reason);
  }
  // Anything else falls to the page's ordinary failure text.
  for (const reason of [
    "history_setting_off",
    "history_unavailable",
    "publish_in_flight",
    "protect_failed",
    "declined",
    "toString",
    "",
  ]) {
    assert.equal(
      historyFailureKind({ source: "client", reason }),
      null,
      reason,
    );
  }
  // Only the bridge's own client failures.
  assert.equal(
    historyFailureKind({ source: "native", reason: "protect_busy" }),
    null,
  );
  assert.equal(
    historyFailureKind({ source: "server", reason: "wipe_refused" }),
    null,
  );
  assert.equal(historyFailureKind({ reason: "clock_behind" }), null);
  assert.equal(historyFailureKind({ source: "client", reason: 5 }), null);
  for (const err of [null, undefined, "protect_busy", 5, new Error("x")]) {
    assert.equal(historyFailureKind(err), null);
  }
});

test("FXO B8: the wipe progress and the wipe button never show together", () => {
  const states = [
    undefined,
    { state: "none" },
    { state: "requested" },
    { state: "done", count: 3 },
  ];
  let progressShown = 0;
  for (const preHistory of ["kept", "wiped", null, undefined, "KEPT"]) {
    for (const boundary of [BOUNDARY, null, ""]) {
      for (const serverWipe of states) {
        const m = owner({
          native: native({ preHistory, boundary }),
          serverWipe,
        });
        const label = [preHistory, boundary, JSON.stringify(serverWipe)].join();
        const progress = m.progress.kind !== "none";
        assert.equal(m.wipe.offered && progress, false, label);
        // Progress needs native's wiped line and a boundary.
        if (progress) {
          progressShown++;
          assert.equal(preHistory, "wiped", label);
          assert.equal(boundary, BOUNDARY, label);
        }
      }
    }
  }
  assert.equal(progressShown, 2, "requested and done, under wiped only");
});

test("FXO B3: the model says when the earlier messages are kept behind a boundary", () => {
  assert.equal(owner().earlierKept, true);
  assert.equal(
    owner({ native: native({ historySetting: "visible" }) }).earlierKept,
    true,
  );
  assert.equal(
    owner({ native: native({ preHistory: "wiped" }) }).earlierKept,
    false,
  );
  for (const boundary of [null, undefined, "", 5]) {
    assert.equal(
      owner({ native: native({ boundary }) }).earlierKept,
      false,
      `boundary ${String(boundary)}`,
    );
  }
  for (const preHistory of [null, undefined, "", "KEPT", true]) {
    assert.equal(
      owner({ native: native({ preHistory }) }).earlierKept,
      false,
      `pre_history ${String(preHistory)}`,
    );
  }
  // Never from the server's object.
  assert.equal(
    owner({
      native: native({ preHistory: null }),
      serverWipe: { state: "none", pre_history: "kept", preHistory: "kept" },
    }).earlierKept,
    false,
  );
});

test("FXO B2 B7, RB2 RB3: only the five exact client reasons are a protect that went through, each its own outcome", () => {
  const OUTCOMES = [
    ["protected_members_pending", "members_pending"],
    ["protected_members_unconfirmed", "members_unconfirmed"],
    ["wipe_not_done", "wipe_not_done"],
    ["wipe_not_done_members_pending", "wipe_not_done_members_pending"],
    ["wipe_not_done_members_unconfirmed", "wipe_not_done_members_unconfirmed"],
  ] as const;
  for (const [reason, kind] of OUTCOMES) {
    assert.equal(protectOutcomeKind({ source: "client", reason }), kind);
    // Only the bridge's own client failures.
    for (const source of ["native", "server", "transport", undefined, 1]) {
      assert.equal(protectOutcomeKind({ source, reason }), null, reason);
    }
    // None is one of the inline history errors.
    assert.equal(historyFailureKind({ source: "client", reason }), null);
  }
  assert.equal(new Set(OUTCOMES.map(([, kind]) => kind)).size, 5);
});

test("FXO safety: any other rejection is a failed protect and gets the page's ordinary failure text", () => {
  for (const reason of [
    "protect_failed",
    "protect_busy",
    "publish_in_flight",
    "publish_refused",
    "declined",
    "protected_members_pendin",
    "PROTECTED_MEMBERS_PENDING",
    "wipe_not_done ",
    "wipe_not_done_members",
    "wipe_not_done_members_pending_",
    "members_pending",
    "members_unconfirmed",
    "protected_members",
    "wipe_refused",
    "toString",
    "",
    5,
    null,
    undefined,
    true,
  ]) {
    assert.equal(
      protectOutcomeKind({ source: "client", reason }),
      null,
      String(reason),
    );
  }
  // Only the bridge's own client failures.
  for (const source of ["native", "server", "transport", undefined, 1]) {
    for (const reason of ["protected_members_pending", "wipe_not_done"]) {
      assert.equal(protectOutcomeKind({ source, reason }), null);
    }
  }
  assert.equal(
    protectOutcomeKind({ source: "native", error: { type: "declined" } }),
    null,
  );
  for (const err of [null, undefined, "wipe_not_done", 5, new Error("x")]) {
    assert.equal(protectOutcomeKind(err), null);
  }
  // Neither is one of the inline history errors.
  assert.equal(
    historyFailureKind({ source: "client", reason: "wipe_not_done" }),
    null,
  );
  assert.equal(
    historyFailureKind({
      source: "client",
      reason: "protected_members_pending",
    }),
    null,
  );
});

const CH_A = "01JCHANNELA000000000000000";
const CH_B = "01JCHANNELB000000000000000";

/** The owner's page on a protected channel with no verified state yet. */
const UNVERIFIED: HistoryVerifyInput = {
  channelId: CH_A,
  isOwner: true,
  flag: true,
  canAct: true,
  modelKind: "none",
  nativeLoaded: false,
  now: 1_000,
};

const NO_ASKS: HistoryVerifyAsks = new Map();

test("FXO C6, RB9: the page asks for a verify when the history section could show, has no model, and native has not loaded the channel", () => {
  const step = historyVerifyStep(NO_ASKS, UNVERIFIED);
  assert.equal(step.ask, true);
  assert.deepEqual([...step.asks], [[CH_A, 1_000]]);
  assert.equal(NO_ASKS.size, 0, "the caller's map is not written");
  // RB9: a channel native has loaded is never asked for, whatever keeps
  // its model at `none`. Only an exact `false` is "not loaded".
  for (const nativeLoaded of [true, undefined, null, "false", 0]) {
    const loaded = historyVerifyStep(NO_ASKS, { ...UNVERIFIED, nativeLoaded });
    assert.equal(loaded.ask, false, String(nativeLoaded));
    assert.equal(loaded.asks, NO_ASKS, "and nothing is remembered");
  }
  // An unreadable clock still asks; the line then simply does not show.
  const odd = historyVerifyStep(NO_ASKS, { ...UNVERIFIED, now: "soon" });
  assert.equal(odd.ask, true);
  assert.deepEqual([...odd.asks], [[CH_A, 0]]);
});

test("FXO C6: never asks with the history flag off, for anyone but the owner, off a protected channel, or once the section shows", () => {
  const never: Partial<HistoryVerifyInput>[] = [
    { flag: false },
    { flag: undefined },
    { flag: "true" },
    { flag: 1 },
    { isOwner: false },
    { isOwner: undefined },
    { canAct: false },
    { canAct: "true" },
    { modelKind: "owner" },
    { modelKind: undefined },
    { channelId: "" },
    { channelId: undefined },
    { channelId: 5 },
  ];
  for (const over of never) {
    const step = historyVerifyStep(NO_ASKS, { ...UNVERIFIED, ...over });
    assert.equal(step.ask, false, JSON.stringify(over));
    assert.equal(step.asks, NO_ASKS, "nothing is remembered either");
    assert.equal(
      historyCheckingShown(new Map([[CH_A, 1_000]]), {
        ...UNVERIFIED,
        ...over,
      }),
      false,
      `no line: ${JSON.stringify(over)}`,
    );
  }
});

test("FXO C6: one ask per channel for as long as the page is mounted, never a loop", () => {
  let asks: HistoryVerifyAsks = NO_ASKS;
  let asked = 0;
  const run = (over: Partial<HistoryVerifyInput>) => {
    const step = historyVerifyStep(asks, { ...UNVERIFIED, ...over });
    asks = step.asks;
    if (step.ask) asked++;
    return step.ask;
  };
  // The effect runs again and again while nothing changes: one ask.
  for (let i = 0; i < 50; i++) run({ now: 1_000 + i * 1_000 });
  assert.equal(asked, 1);
  // The state loads but stays unverified, time passes: still one.
  for (let i = 0; i < 50; i++) run({ nativeLoaded: true, now: 1e6 + i });
  assert.equal(asked, 1);
  // It unloads again: this channel was asked for already.
  for (let i = 0; i < 10; i++) run({ nativeLoaded: false, now: 15e5 + i });
  assert.equal(asked, 1);
  // The section shows, then goes away again: no second ask.
  assert.equal(run({ modelKind: "owner" }), false);
  assert.equal(run({ modelKind: "none", now: 2e6 }), false);
  assert.equal(asked, 1);
  // Another channel in the same page: its own single ask.
  assert.equal(run({ channelId: CH_B, now: 3e6 }), true);
  for (let i = 0; i < 10; i++) run({ channelId: CH_B, now: 3e6 + i });
  assert.equal(asked, 2);
  // Back on the first channel: not again.
  for (let i = 0; i < 10; i++) run({ channelId: CH_A, now: 4e6 + i });
  assert.equal(asked, 2);
  assert.deepEqual(
    [...asks],
    [
      [CH_A, 1_000],
      [CH_B, 3e6],
    ],
    "the first ask's time is kept",
  );
});

test("FXO C6: historyCheckingShown is true only for an asked channel native has not loaded, at a time less than HISTORY_CHECK_LINE_MS after the ask", () => {
  const asks = historyVerifyStep(NO_ASKS, UNVERIFIED).asks;
  assert.equal(historyCheckingShown(asks, UNVERIFIED), true);
  // Not asked for: no line.
  assert.equal(historyCheckingShown(NO_ASKS, UNVERIFIED), false);
  assert.equal(
    historyCheckingShown(asks, { ...UNVERIFIED, channelId: CH_B }),
    false,
  );
  // Loaded (verified or not) is not "checking".
  for (const nativeLoaded of [true, undefined, null, "false"]) {
    assert.equal(
      historyCheckingShown(asks, { ...UNVERIFIED, nativeLoaded }),
      false,
      String(nativeLoaded),
    );
  }
  // The line ends: a refresh the bridge dropped must not read "Checking"
  // for good.
  const at = (now: unknown) =>
    historyCheckingShown(asks, { ...UNVERIFIED, now });
  assert.equal(at(1_000 + HISTORY_CHECK_LINE_MS - 1), true);
  assert.equal(at(1_000 + HISTORY_CHECK_LINE_MS), false);
  assert.equal(at(1_000 + 10 * HISTORY_CHECK_LINE_MS), false);
  // A clock that went back, or is unreadable: no line.
  assert.equal(at(999), false);
  for (const now of [undefined, null, "1000", Number.NaN, Infinity]) {
    assert.equal(at(now), false, String(now));
  }
  assert.ok(HISTORY_CHECK_LINE_MS > 0 && HISTORY_CHECK_LINE_MS <= 60_000);
});

test("FXO RB6: the wait for the page's timer is what is left of HISTORY_CHECK_LINE_MS since the ask, and the line is over exactly when that wait has passed", () => {
  const asks = historyVerifyStep(NO_ASKS, UNVERIFIED).asks;
  // At the ask: the whole time, never the page's 30 s tick.
  assert.equal(historyCheckWaitMs(asks, CH_A, 1_000), HISTORY_CHECK_LINE_MS);
  assert.equal(HISTORY_CHECK_LINE_MS, 20_000);
  // Later (the page came back to the channel): only what is left.
  assert.equal(
    historyCheckWaitMs(asks, CH_A, 1_001),
    HISTORY_CHECK_LINE_MS - 1,
  );
  assert.equal(
    historyCheckWaitMs(asks, CH_A, 1_000 + HISTORY_CHECK_LINE_MS - 1),
    1,
  );
  // Nothing to wait for: time is up, not asked for, an unusable input.
  assert.equal(
    historyCheckWaitMs(asks, CH_A, 1_000 + HISTORY_CHECK_LINE_MS),
    null,
  );
  assert.equal(historyCheckWaitMs(asks, CH_A, 9e9), null);
  assert.equal(historyCheckWaitMs(asks, CH_A, 999), null);
  assert.equal(historyCheckWaitMs(asks, CH_B, 1_000), null);
  assert.equal(historyCheckWaitMs(NO_ASKS, CH_A, 1_000), null);
  for (const now of [undefined, null, "1000", Number.NaN, Infinity]) {
    assert.equal(historyCheckWaitMs(asks, CH_A, now), null, String(now));
  }
  for (const id of [undefined, null, 5, {}]) {
    assert.equal(historyCheckWaitMs(asks, id, 1_000), null, String(id));
  }
  // The timer and the line agree at every point of the window: while a
  // wait is left the line shows, and at `now + wait` it does not.
  for (const waited of [0, 1, 7_500, HISTORY_CHECK_LINE_MS - 1]) {
    const now = 1_000 + waited;
    const wait = historyCheckWaitMs(asks, CH_A, now);
    assert.ok(wait !== null && wait > 0 && wait <= HISTORY_CHECK_LINE_MS);
    assert.equal(historyCheckingShown(asks, { ...UNVERIFIED, now }), true);
    assert.equal(
      historyCheckingShown(asks, { ...UNVERIFIED, now: now + wait }),
      false,
      `over after ${waited} + ${wait}`,
    );
    assert.equal(
      historyCheckingShown(asks, { ...UNVERIFIED, now: now + wait - 1 }),
      true,
    );
  }
});

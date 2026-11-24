// Spec for the history rules of the Protected channel settings page (S4
// lane U5; design 9.5, 4.9 "S4", plan O-5), run with Node's built-in runner
// from packages/client:
//   node --conditions=browser --test components/app/interface/settings/channel/protected/protectedHistorySettings.test.ts
//
// The page's wiring to these rules is scanned by
// `protectedSettings.scan.test.ts` (S28 to S31).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type HistorySectionInput,
  type HistorySectionModel,
  type ProtectDraft,
  historyFailureKind,
  historySectionModel,
  historyToggleClick,
  newProtectDraft,
  protectDraftStep,
  protectOpts,
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
  // In the section: shown beside native's state, kept or wiped.
  assert.deepEqual(owner({ serverWipe: { state: "requested" } }).progress, {
    kind: "requested",
  });
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

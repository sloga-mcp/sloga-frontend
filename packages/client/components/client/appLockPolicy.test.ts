// Unit spec for the app lock policy: run with Node's built-in runner:
//   node --conditions=browser --test components/client/appLockPolicy.test.ts
// Focus: a payload that cannot be read is locked, `locked` is false only
// when the payload says exactly that, the gate rules apply in their order,
// and a sign out or a boot without a session resets only on a phone that
// really reported its state.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { GateView } from "./appLockPolicy.ts";
import {
  ABSENT,
  FAIL_CLOSED,
  bootReconcile,
  gateView,
  readCode,
  readSnapshot,
  sessionEndPlan,
  shouldAutoPrompt,
} from "./appLockPolicy.ts";

const BOOLS = [false, true];

// A payload the plugin could really send
const GOOD = {
  enabled: true,
  locked: false,
  timeoutSec: 60,
  hideNotificationText: true,
  deviceSecure: true,
  autoDisabled: false,
};

// Everything that is not a boolean, as `locked` or `enabled` could arrive
const NOT_BOOLEAN: unknown[] = [
  undefined,
  null,
  0,
  1,
  "",
  "false",
  "true",
  NaN,
  {},
  [],
  [false],
  () => false,
];

test("the fail closed state is locked", () => {
  assert.deepEqual(FAIL_CLOSED, {
    enabled: true,
    locked: true,
    timeoutSec: 0,
    hideNotificationText: false,
    deviceSecure: true,
    autoDisabled: false,
  });
});

test("the absent state is all off", () => {
  assert.deepEqual(ABSENT, {
    enabled: false,
    locked: false,
    timeoutSec: 0,
    hideNotificationText: false,
    deviceSecure: false,
    autoDisabled: false,
  });
});

test("neither constant can be changed by a caller", () => {
  assert.throws(() => {
    FAIL_CLOSED.locked = false;
  }, TypeError);
  assert.throws(() => {
    ABSENT.locked = true;
  }, TypeError);
  assert.equal(FAIL_CLOSED.locked, true);
  assert.equal(ABSENT.locked, false);
});

test("a good payload is read as it is", () => {
  assert.deepEqual(readSnapshot(GOOD), GOOD);
  assert.deepEqual(readSnapshot({ ...GOOD, locked: true }), {
    ...GOOD,
    locked: true,
  });
  assert.deepEqual(
    readSnapshot({
      enabled: false,
      locked: false,
      timeoutSec: 900,
      hideNotificationText: false,
      deviceSecure: false,
      autoDisabled: true,
    }),
    {
      enabled: false,
      locked: false,
      timeoutSec: 900,
      hideNotificationText: false,
      deviceSecure: false,
      autoDisabled: true,
    },
  );
});

test("a payload that is not an object fails closed", () => {
  const samples: unknown[] = [
    undefined,
    null,
    false,
    true,
    0,
    1,
    "",
    "locked",
    '{"locked":false,"enabled":false}',
    Symbol("x"),
    () => GOOD,
  ];
  assert.ok(samples.length > 0);

  for (const raw of samples) {
    assert.equal(readSnapshot(raw), FAIL_CLOSED, String(raw));
  }
});

test("a payload whose locked is not a boolean fails closed", () => {
  assert.ok(NOT_BOOLEAN.length > 0);

  for (const locked of NOT_BOOLEAN) {
    assert.equal(
      readSnapshot({ ...GOOD, locked }),
      FAIL_CLOSED,
      String(locked),
    );
  }

  // Missing altogether
  assert.equal(readSnapshot({ enabled: false }), FAIL_CLOSED);
  assert.equal(readSnapshot({}), FAIL_CLOSED);
  assert.equal(readSnapshot([]), FAIL_CLOSED);
});

test("a payload whose enabled is not a boolean fails closed", () => {
  for (const enabled of NOT_BOOLEAN) {
    assert.equal(
      readSnapshot({ ...GOOD, enabled }),
      FAIL_CLOSED,
      String(enabled),
    );
  }

  // Even when it says unlocked
  assert.equal(readSnapshot({ locked: false }), FAIL_CLOSED);
});

test("locked reads false only when it is exactly false", () => {
  assert.equal(readSnapshot({ ...GOOD, locked: false }).locked, false);
  assert.equal(readSnapshot({ ...GOOD, locked: true }).locked, true);

  for (const locked of NOT_BOOLEAN) {
    assert.equal(readSnapshot({ ...GOOD, locked }).locked, true);
  }
  for (const enabled of NOT_BOOLEAN) {
    assert.equal(readSnapshot({ ...GOOD, enabled }).locked, true);
  }
});

test("a timeout outside 0, 60 and 900 becomes 0", () => {
  for (const timeoutSec of [0, 60, 900]) {
    assert.equal(readSnapshot({ ...GOOD, timeoutSec }).timeoutSec, timeoutSec);
  }

  for (const timeoutSec of [
    undefined,
    null,
    -1,
    1,
    59,
    61,
    300,
    899,
    901,
    3600,
    60.5,
    Infinity,
    NaN,
    "60",
    "900",
    true,
    [60],
    { sec: 60 },
  ]) {
    const read = readSnapshot({ ...GOOD, timeoutSec });
    assert.equal(read.timeoutSec, 0, String(timeoutSec));
    // A bad timeout does not throw the rest away
    assert.equal(read.locked, false);
    assert.equal(read.enabled, true);
  }

  const { timeoutSec: _dropped, ...without } = GOOD;
  assert.equal(readSnapshot(without).timeoutSec, 0);
});

test("the other flags are true only when exactly true", () => {
  const minimal = readSnapshot({ enabled: true, locked: false });
  assert.deepEqual(minimal, {
    enabled: true,
    locked: false,
    timeoutSec: 0,
    hideNotificationText: false,
    deviceSecure: false,
    autoDisabled: false,
  });

  for (const key of ["hideNotificationText", "deviceSecure", "autoDisabled"]) {
    assert.equal(
      readSnapshot({ ...GOOD, [key]: true })[key as "autoDisabled"],
      true,
      key,
    );
    for (const value of [false, 1, "true", null, undefined, {}]) {
      assert.equal(
        readSnapshot({ ...GOOD, [key]: value })[key as "autoDisabled"],
        false,
        `${key} ${String(value)}`,
      );
    }
  }
});

test("a known code is read from .code", () => {
  for (const code of ["NO_DEVICE_LOCK", "CANCELLED", "LOCKED", "FAILED"]) {
    assert.equal(readCode({ code }), code);
    assert.equal(readCode({ code, message: "something else" }), code);
    assert.equal(readCode(Object.assign(new Error("x"), { code })), code);
  }
});

test("a known code is read from .message when .code has none", () => {
  for (const code of ["NO_DEVICE_LOCK", "CANCELLED", "LOCKED", "FAILED"]) {
    assert.equal(readCode({ message: code }), code);
    assert.equal(readCode(new Error(code)), code);
    assert.equal(readCode({ code: "UNIMPLEMENTED", message: code }), code);
    assert.equal(readCode({ code: undefined, message: code }), code);
  }
});

test(".code is read before .message", () => {
  assert.equal(readCode({ code: "CANCELLED", message: "LOCKED" }), "CANCELLED");
  assert.equal(
    readCode({ code: "NO_DEVICE_LOCK", message: "CANCELLED" }),
    "NO_DEVICE_LOCK",
  );
});

test("a bare code string is that code", () => {
  for (const code of ["NO_DEVICE_LOCK", "CANCELLED", "LOCKED", "FAILED"]) {
    assert.equal(readCode(code), code);
  }
});

test("anything unknown is FAILED", () => {
  const samples: unknown[] = [
    undefined,
    null,
    0,
    1,
    true,
    "",
    "UNIMPLEMENTED",
    "cancelled",
    " CANCELLED",
    "CANCELLED: user backed out",
    {},
    [],
    ["CANCELLED"],
    new Error("boom"),
    { code: "UNIMPLEMENTED" },
    { code: "UNIMPLEMENTED", message: "AppLock is not implemented on web" },
    { code: "cancelled" },
    { code: 1, message: 2 },
    { code: null, message: null },
    { code: ["LOCKED"] },
    { message: "The user CANCELLED" },
    { errorMessage: "CANCELLED" },
    { data: { code: "CANCELLED" } },
  ];
  assert.ok(samples.length > 0);

  for (const error of samples) {
    assert.equal(readCode(error), "FAILED", JSON.stringify(error));
  }
});

test("off a phone there is never a gate", () => {
  let checked = 0;

  for (const ready of BOOLS) {
    for (const locked of BOOLS) {
      for (const hasSession of BOOLS) {
        for (const ending of BOOLS) {
          assert.equal(
            gateView({ phone: false, ready, locked, hasSession, ending }),
            "none",
          );
          checked++;
        }
      }
    }
  }

  // A loop that never ran would pass without checking anything
  assert.equal(checked, 16);
});

test("on a phone the gate rules apply in order", () => {
  // ready, locked, hasSession, ending
  const rows: [boolean, boolean, boolean, boolean, GateView][] = [
    // ending wins over everything else
    [false, false, false, true, "ending"],
    [false, false, true, true, "ending"],
    [false, true, false, true, "ending"],
    [false, true, true, true, "ending"],
    [true, false, false, true, "ending"],
    [true, false, true, true, "ending"],
    [true, true, false, true, "ending"],
    [true, true, true, true, "ending"],
    // then not ready is boot, whatever the rest says
    [false, false, false, false, "boot"],
    [false, false, true, false, "boot"],
    [false, true, false, false, "boot"],
    [false, true, true, false, "boot"],
    // then locked with a session is lock
    [true, true, true, false, "lock"],
    // locked with no session shows the sign-in page
    [true, true, false, false, "none"],
    // not locked
    [true, false, true, false, "none"],
    [true, false, false, false, "none"],
  ];

  // Every combination, each once
  assert.equal(new Set(rows.map((row) => row.slice(0, 4).join())).size, 16);

  for (const [ready, locked, hasSession, ending, view] of rows) {
    assert.equal(
      gateView({ phone: true, ready, locked, hasSession, ending }),
      view,
      JSON.stringify({ ready, locked, hasSession, ending }),
    );
  }
});

test("the prompt opens by itself only on a visible lock view, once per epoch", () => {
  assert.equal(
    shouldAutoPrompt({
      view: "lock",
      visible: true,
      promptedEpoch: 0,
      epoch: 1,
    }),
    true,
  );

  const views: GateView[] = ["none", "boot", "lock", "ending"];
  let checked = 0;
  let prompts = 0;

  for (const view of views) {
    for (const visible of BOOLS) {
      for (const [promptedEpoch, epoch] of [
        [0, 0],
        [3, 3],
        [0, 1],
        [2, 1],
        [-1, 0],
      ]) {
        const expected = view === "lock" && visible && promptedEpoch !== epoch;
        assert.equal(
          shouldAutoPrompt({ view, visible, promptedEpoch, epoch }),
          expected,
          JSON.stringify({ view, visible, promptedEpoch, epoch }),
        );
        checked++;
        if (expected) prompts++;
      }
    }
  }

  assert.equal(checked, 40);
  assert.equal(prompts, 3);
});

test("no view but lock ever prompts", () => {
  for (const view of ["none", "boot", "ending"] as GateView[]) {
    assert.equal(
      shouldAutoPrompt({ view, visible: true, promptedEpoch: 0, epoch: 1 }),
      false,
      view,
    );
  }
});

test("a hidden page never prompts", () => {
  assert.equal(
    shouldAutoPrompt({
      view: "lock",
      visible: false,
      promptedEpoch: 0,
      epoch: 1,
    }),
    false,
  );
});

test("an epoch that was already prompted does not prompt again", () => {
  assert.equal(
    shouldAutoPrompt({
      view: "lock",
      visible: true,
      promptedEpoch: 4,
      epoch: 4,
    }),
    false,
  );
  assert.equal(
    shouldAutoPrompt({
      view: "lock",
      visible: true,
      promptedEpoch: 4,
      epoch: 5,
    }),
    true,
  );
});

test("off a phone a session end does nothing", () => {
  assert.deepEqual(sessionEndPlan({ phone: false, wasLocked: false }), {
    reset: false,
    reload: false,
  });
  assert.deepEqual(sessionEndPlan({ phone: false, wasLocked: true }), {
    reset: false,
    reload: false,
  });
});

test("on a phone a session end resets, and reloads only if it was locked", () => {
  assert.deepEqual(sessionEndPlan({ phone: true, wasLocked: false }), {
    reset: true,
    reload: false,
  });
  assert.deepEqual(sessionEndPlan({ phone: true, wasLocked: true }), {
    reset: true,
    reload: true,
  });
});

test("boot resets only a lock the plugin reported with nobody signed in", () => {
  assert.equal(
    bootReconcile({
      ready: true,
      pluginOk: true,
      enabled: true,
      hasSession: false,
    }),
    "reset-reload",
  );

  let checked = 0;
  let resets = 0;

  for (const ready of BOOLS) {
    for (const pluginOk of BOOLS) {
      for (const enabled of BOOLS) {
        for (const hasSession of BOOLS) {
          const answer = bootReconcile({
            ready,
            pluginOk,
            enabled,
            hasSession,
          });
          assert.ok(answer === "none" || answer === "reset-reload");
          checked++;
          if (answer === "reset-reload") resets++;
        }
      }
    }
  }

  // One combination out of sixteen, the one above
  assert.equal(checked, 16);
  assert.equal(resets, 1);
});

test("each missing boot condition alone stops the reset", () => {
  const all = { ready: true, pluginOk: true, enabled: true, hasSession: false };

  assert.equal(bootReconcile({ ...all, ready: false }), "none");
  // A failed read reports the fail closed state, which is enabled
  assert.equal(bootReconcile({ ...all, pluginOk: false }), "none");
  assert.equal(bootReconcile({ ...all, enabled: false }), "none");
  assert.equal(bootReconcile({ ...all, hasSession: true }), "none");
});

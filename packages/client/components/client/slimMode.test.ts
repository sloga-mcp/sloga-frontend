// Unit spec for the Slim view resolver: run with Node's built-in runner from
// packages/client:
//   node --conditions=browser --test components/client/slimMode.test.ts
// Declared test count: 17 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: a staff account never gets Slim view, even in a locked build; a
// locked build is Slim whatever the setting says; outside the native apps
// the setting does nothing without the development override, and the
// override does nothing without the setting; the override is always off
// outside a development build, `slim_dev=0` in the URL beats the stored
// latch, and only the exact parameter with the exact value counts.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type SlimInput,
  resolveSlim,
  SLIM_DEV_STORAGE_KEY,
  slimDevOverrideFrom,
} from "./slimMode.ts";

/** A plain user in the native app with everything else off */
const BASE: SlimInput = {
  setting: false,
  nativeShell: true,
  locked: false,
  staff: false,
  devOverride: false,
};

/** Every combination of the five inputs (32) */
function everyInput(): SlimInput[] {
  const out: SlimInput[] = [];
  for (let bits = 0; bits < 32; bits++) {
    out.push({
      setting: (bits & 1) !== 0,
      nativeShell: (bits & 2) !== 0,
      locked: (bits & 4) !== 0,
      staff: (bits & 8) !== 0,
      devOverride: (bits & 16) !== 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// resolveSlim
// ---------------------------------------------------------------------------

test("the native app with the setting on is Slim, and off is not", () => {
  assert.equal(resolveSlim({ ...BASE, setting: true }), true);
  assert.equal(resolveSlim(BASE), false);
});

test("a staff account is never Slim, whatever else is on", () => {
  assert.equal(resolveSlim({ ...BASE, setting: true, staff: true }), false);
  assert.equal(
    resolveSlim({ ...BASE, setting: true, devOverride: true, staff: true }),
    false,
  );

  const staffInputs = everyInput().filter((input) => input.staff);
  assert.equal(staffInputs.length, 16);
  for (const input of staffInputs) {
    assert.equal(resolveSlim(input), false, JSON.stringify(input));
  }
});

test("staff beats a locked build", () => {
  assert.equal(resolveSlim({ ...BASE, locked: true, staff: true }), false);
  assert.equal(
    resolveSlim({
      setting: true,
      nativeShell: true,
      locked: true,
      staff: true,
      devOverride: true,
    }),
    false,
  );
});

test("a locked build is Slim with the setting off", () => {
  assert.equal(resolveSlim({ ...BASE, locked: true }), true);
  // Locked does not depend on the shell either
  assert.equal(
    resolveSlim({ ...BASE, locked: true, nativeShell: false }),
    true,
  );

  const lockedInputs = everyInput().filter(
    (input) => input.locked && !input.staff,
  );
  assert.equal(lockedInputs.length, 8);
  for (const input of lockedInputs) {
    assert.equal(resolveSlim(input), true, JSON.stringify(input));
  }
});

test("outside the native apps the setting alone does nothing", () => {
  assert.equal(
    resolveSlim({ ...BASE, setting: true, nativeShell: false }),
    false,
  );
});

test("the development override stands in for the native app", () => {
  assert.equal(
    resolveSlim({
      ...BASE,
      setting: true,
      nativeShell: false,
      devOverride: true,
    }),
    true,
  );
});

test("the development override needs the setting on", () => {
  assert.equal(
    resolveSlim({ ...BASE, nativeShell: false, devOverride: true }),
    false,
  );
  assert.equal(resolveSlim({ ...BASE, devOverride: true }), false);
});

test("the full table: exactly these 11 of 32 combinations are Slim", () => {
  const on = everyInput()
    .filter((input) => resolveSlim(input))
    .map(
      (input) =>
        (input.setting ? "S" : "-") +
        (input.nativeShell ? "N" : "-") +
        (input.locked ? "L" : "-") +
        (input.staff ? "T" : "-") +
        (input.devOverride ? "D" : "-"),
    )
    .sort();

  // S setting, N native shell, L locked, T staff, D development override.
  // Written out by hand, not derived from the rule, so a changed rule shows
  assert.deepEqual(
    on,
    [
      // Locked, not staff: all eight
      "--L--",
      "--L-D",
      "-NL--",
      "-NL-D",
      "S-L--",
      "S-L-D",
      "SNL--",
      "SNL-D",
      // Not locked, not staff: the setting plus a shell or the override
      "S---D",
      "SN---",
      "SN--D",
    ].sort(),
  );
});

test("the result is always a boolean", () => {
  for (const input of everyInput()) {
    assert.equal(typeof resolveSlim(input), "boolean", JSON.stringify(input));
  }
});

// ---------------------------------------------------------------------------
// slimDevOverrideFrom
// ---------------------------------------------------------------------------

test("the storage key is slim_dev", () => {
  assert.equal(SLIM_DEV_STORAGE_KEY, "slim_dev");
});

test("outside a development build the override is always off", () => {
  assert.equal(slimDevOverrideFrom(false, "?slim_dev=1", "1"), false);
  assert.equal(slimDevOverrideFrom(false, "?slim_dev=1", null), false);
  assert.equal(slimDevOverrideFrom(false, "", "1"), false);
  assert.equal(slimDevOverrideFrom(false, "?a=b&slim_dev=1", "1"), false);
  assert.equal(slimDevOverrideFrom(false, "", null), false);
});

test("slim_dev=1 in the URL turns the override on", () => {
  assert.equal(slimDevOverrideFrom(true, "?slim_dev=1", null), true);
  // A stale stored value does not get in the way
  assert.equal(slimDevOverrideFrom(true, "?slim_dev=1", "0"), true);
  assert.equal(slimDevOverrideFrom(true, "?slim_dev=1", "1"), true);
});

test("slim_dev=0 in the URL beats the stored latch", () => {
  assert.equal(slimDevOverrideFrom(true, "?slim_dev=0", "1"), false);
  assert.equal(slimDevOverrideFrom(true, "?slim_dev=0", null), false);
  assert.equal(slimDevOverrideFrom(true, "?a=b&slim_dev=0&c=d", "1"), false);
  // Off also wins when the URL says both
  assert.equal(slimDevOverrideFrom(true, "?slim_dev=1&slim_dev=0", "1"), false);
  assert.equal(slimDevOverrideFrom(true, "?slim_dev=0&slim_dev=1", ""), false);
});

test("with nothing in the URL only a stored 1 turns it on", () => {
  assert.equal(slimDevOverrideFrom(true, "", "1"), true);
  assert.equal(slimDevOverrideFrom(true, "?a=b", "1"), true);
  assert.equal(slimDevOverrideFrom(true, "", null), false);
  assert.equal(slimDevOverrideFrom(true, "?a=b", null), false);

  for (const stored of ["", "0", "true", "yes", " 1", "1 ", "11", "01"]) {
    assert.equal(slimDevOverrideFrom(true, "", stored), false, stored);
  }
});

test("the flag is found among other parameters", () => {
  assert.equal(slimDevOverrideFrom(true, "?a=b&slim_dev=1", null), true);
  assert.equal(slimDevOverrideFrom(true, "?slim_dev=1&a=b", null), true);
  assert.equal(slimDevOverrideFrom(true, "?a=b&slim_dev=1&c=d", null), true);
  assert.equal(slimDevOverrideFrom(true, "?a=&slim_dev=1&c", null), true);
});

test("a near miss in the URL does not turn it on", () => {
  for (const search of [
    "?xslim_dev=1",
    "?slim_dev=10",
    "?slim_dev=01",
    "?slim_dev=11",
    "?slim_dev",
    "?slim_dev=",
    "?slim_dev=true",
    "?slim_dev=on",
    "?slim_dev_x=1",
    "?slim_devx=1",
    "?SLIM_DEV=1",
    "?slim-dev=1",
    "?a=slim_dev=1",
    "?a=b;slim_dev=1",
    "?slim_dev=1x",
  ]) {
    assert.equal(slimDevOverrideFrom(true, search, null), false, search);
  }
});

test("a near miss in the URL does not turn a stored latch off", () => {
  for (const search of [
    "?xslim_dev=0",
    "?slim_dev=00",
    "?slim_dev=false",
    "?slim_dev=",
    "?slim_dev",
    "?SLIM_DEV=0",
    "?a=slim_dev=0",
    "?slim_dev=10",
  ]) {
    assert.equal(slimDevOverrideFrom(true, search, "1"), true, search);
  }
});

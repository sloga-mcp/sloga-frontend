// Unit spec for the conversation encryption badge (chat windows plan D5) —
// run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeBadge.test.ts
// Every input combination is checked against an explicit table, and the
// composer view against a verbatim copy of the pre-refactor
// `Composition.tsx` `e2eeMode`. The fail-closed rule: "encrypted" only ever
// comes from the native "encrypt" send mode.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ComposerE2EEMode,
  type E2EEBadge,
  type E2EEBadgeInput,
  type E2EESendMode,
  composerE2EEModeFor,
  e2eeBadgeFor,
} from "./e2eeBadge.ts";

const MODES: (E2EESendMode | undefined)[] = [
  undefined,
  "encrypt",
  "blocked",
  "plaintext",
  "peer_downgraded",
  "unconfirmed",
];
const BOOLS = [false, true];

/** Every input combination (6 modes x 2^4 flags = 96) */
function allInputs(): E2EEBadgeInput[] {
  const out: E2EEBadgeInput[] = [];
  for (const mode of MODES)
    for (const isGroup of BOOLS)
      for (const e2eeLoaded of BOOLS)
        for (const selfEnabled of BOOLS)
          for (const peerAdvertises of BOOLS)
            out.push({
              mode,
              isGroup,
              e2eeLoaded,
              selfEnabled,
              peerAdvertises,
            });
  return out;
}

/** "*" matches either value */
type W = boolean | "*";
type Row = [
  mode: E2EESendMode | "none",
  isGroup: W,
  loaded: W,
  self: W,
  peer: W,
  badge: E2EEBadge | null,
];

/** The D5 table, row for row as documented in e2eeBadge.ts */
const TABLE: Row[] = [
  ["encrypt", "*", "*", "*", "*", "encrypted"],
  ["blocked", "*", "*", "*", "*", "warning"],
  ["peer_downgraded", "*", "*", "*", "*", "warning"],
  ["unconfirmed", "*", "*", "*", "*", "warning"],
  ["plaintext", true, "*", "*", "*", "not_encrypted"],
  ["plaintext", false, false, "*", "*", null],
  ["plaintext", false, true, true, true, "pending"],
  ["plaintext", false, true, true, false, "not_encrypted"],
  ["plaintext", false, true, false, "*", "not_encrypted"],
  ["none", "*", false, "*", "*", null],
  ["none", "*", true, false, "*", "not_encrypted"],
  ["none", "*", true, true, "*", null],
];

const fits = (w: W, v: boolean) => w === "*" || w === v;

function rowsFor(i: E2EEBadgeInput): Row[] {
  return TABLE.filter(
    ([mode, isGroup, loaded, self, peer]) =>
      mode === (i.mode ?? "none") &&
      fits(isGroup, i.isGroup) &&
      fits(loaded, i.e2eeLoaded) &&
      fits(self, i.selfEnabled) &&
      fits(peer, i.peerAdvertises),
  );
}

const label = (i: E2EEBadgeInput) => JSON.stringify(i);

test("covers 96 input combinations", () => {
  assert.equal(allInputs().length, 96);
});

test("every combination matches exactly one table row and its badge", () => {
  for (const i of allInputs()) {
    const rows = rowsFor(i);
    assert.equal(rows.length, 1, `table rows for ${label(i)}`);
    assert.equal(e2eeBadgeFor(i), rows[0][5], label(i));
  }
});

test("fails closed: encrypted ONLY from the native encrypt mode", () => {
  for (const i of allInputs()) {
    assert.equal(
      e2eeBadgeFor(i) === "encrypted",
      i.mode === "encrypt",
      label(i),
    );
  }
});

test("blocked, peer_downgraded and unconfirmed are always a warning", () => {
  for (const i of allInputs()) {
    if (
      i.mode === "blocked" ||
      i.mode === "peer_downgraded" ||
      i.mode === "unconfirmed"
    ) {
      assert.equal(e2eeBadgeFor(i), "warning", label(i));
    }
  }
});

test("the peer's advertised opt-in alone never reaches encrypted", () => {
  for (const i of allInputs()) {
    if (i.mode === "encrypt") continue;
    assert.notEqual(
      e2eeBadgeFor({ ...i, peerAdvertises: true }),
      "encrypted",
      label(i),
    );
  }
});

test("E2EE known off on this device always gets an answer", () => {
  for (const i of allInputs()) {
    if (!i.e2eeLoaded || i.selfEnabled) continue;
    assert.notEqual(e2eeBadgeFor(i), null, label(i));
  }
});

/**
 * Verbatim logic of `Composition.tsx` `e2eeMode` before the refactor (with
 * the group fail-closed fix's "unconfirmed" pass-through), for a DM/group
 * with a resolved conversation id. `self` is its `selfE2EEEnabled`, which
 * reads false while the status is unloaded.
 */
function legacyComposer(
  mode: E2EESendMode | undefined,
  isGroup: boolean,
  self: boolean,
  peer: boolean,
): ComposerE2EEMode {
  if (
    mode === "encrypt" ||
    mode === "blocked" ||
    mode === "peer_downgraded" ||
    mode === "unconfirmed"
  )
    return mode;
  if (isGroup) return undefined;
  if (mode === "plaintext" && self) {
    return peer ? "pending" : "unencrypted";
  }
  return undefined;
}

test("composer view reproduces today's composer states on every input", () => {
  for (const i of allInputs()) {
    assert.equal(
      composerE2EEModeFor(i),
      legacyComposer(
        i.mode,
        i.isGroup,
        i.e2eeLoaded && i.selfEnabled,
        i.peerAdvertises,
      ),
      label(i),
    );
  }
});

test("composer view and badge agree on every input", () => {
  const expected: Record<string, (E2EEBadge | null)[]> = {
    encrypt: ["encrypted"],
    blocked: ["warning"],
    peer_downgraded: ["warning"],
    unconfirmed: ["warning"],
    pending: ["pending"],
    unencrypted: ["not_encrypted"],
    none: ["not_encrypted", null],
  };
  for (const i of allInputs()) {
    const composer = composerE2EEModeFor(i) ?? "none";
    assert.ok(
      expected[composer].includes(e2eeBadgeFor(i)),
      `${composer} vs ${e2eeBadgeFor(i)} for ${label(i)}`,
    );
  }
});

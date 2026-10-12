// Unit spec for the E2EE conversation-list bump - run with Node's built-in
// runner:
//   node --conditions=browser --test components/client/e2eeConversationBump.test.ts
// (pure function, so the browser condition is not load-bearing here - it is
// kept so one invocation can cover the reactive suites beside it.)
// Focus: only a decrypted text message bumps the conversation. A control
// message, a decrypt outcome that is not `message`, or one whose `control`
// key is missing or undefined (unknown, so fail closed) never bumps; nor does
// an outcome whose own id has no injected `text` row (absent, or a marker
// row - a text row under another id does not count). `own` is strictly
// `own_message === true` and never reopens; `hasAttachments` needs a
// non-empty attachments array on the matching row.
import assert from "node:assert/strict";
import { test } from "node:test";

import { decryptBump } from "./e2eeConversationBump.ts";

const ID = "01KYNKJDJSV1A4PSRQBKTAPT9X";
const OTHER = "01KYNKJDJSV1A4PSRQBKTAPT9Y";

/** A `text` history row, with an attachments array only when given one. */
const text = (id: string, attachments?: unknown[]) => ({
  id,
  kind: "text",
  ...(attachments ? { attachments } : {}),
});

test("(1) incoming text message: incoming, reopen true", () => {
  const r = decryptBump(
    { kind: "message", id: ID, own_message: false, control: null },
    [text(OTHER), text(ID)],
  );
  assert.deepEqual(r, {
    id: ID,
    origin: "incoming",
    hasAttachments: false,
    reopen: true,
  });
});

test("(2) own_message absent counts as incoming", () => {
  const r = decryptBump({ kind: "message", id: ID, control: null }, [text(ID)]);
  assert.equal(r?.origin, "incoming");
  assert.equal(r?.reopen, true);
});

test("(3) own_message true: own, reopen false", () => {
  const r = decryptBump(
    { kind: "message", id: ID, own_message: true, control: null },
    [text(ID)],
  );
  assert.deepEqual(r, {
    id: ID,
    origin: "own",
    hasAttachments: false,
    reopen: false,
  });
});

test("(4) a truthy non-boolean own_message is NOT own", () => {
  for (const own of ["yes", 1, {}]) {
    const r = decryptBump(
      { kind: "message", id: ID, own_message: own as never, control: null },
      [text(ID)],
    );
    const label = `own_message=${JSON.stringify(own)}`;
    assert.equal(r?.origin, "incoming", label);
    assert.equal(r?.reopen, true, label);
  }
});

test("(5) control non-null: null", () => {
  for (const control of ["group_enable", "roster_add", "downgrade", ""]) {
    const r = decryptBump(
      { kind: "message", id: ID, own_message: false, control },
      [text(ID)],
    );
    assert.equal(r, null, `control=${JSON.stringify(control)}`);
  }
});

test("(6) control key missing: null (fail closed)", () => {
  const r = decryptBump({ kind: "message", id: ID, own_message: false }, [
    text(ID),
  ]);
  assert.equal(r, null);
});

test("(7) control key present but undefined: null", () => {
  const r = decryptBump(
    { kind: "message", id: ID, own_message: false, control: undefined },
    [text(ID)],
  );
  assert.equal(r, null);
});

test("(8) kind other than message: null", () => {
  for (const kind of ["duplicate", "undecryptable", "Message", ""]) {
    const r = decryptBump({ kind, id: ID, control: null }, [text(ID)]);
    assert.equal(r, null, `kind=${JSON.stringify(kind)}`);
  }
});

test("(9) no row for the outcome id: null", () => {
  assert.equal(
    decryptBump({ kind: "message", id: ID, control: null }, [text(OTHER)]),
    null,
  );
  assert.equal(
    decryptBump({ kind: "message", id: ID, control: null }, []),
    null,
  );
});

test("(10) the matching row is a marker: null", () => {
  for (const kind of ["gap", "tampered", "identity_changed", "marker"]) {
    const r = decryptBump({ kind: "message", id: ID, control: null }, [
      { id: ID, kind },
    ]);
    assert.equal(r, null, `row kind=${JSON.stringify(kind)}`);
  }
});

test("(11) a text row under a DIFFERENT id does not rescue a marker row", () => {
  const r = decryptBump({ kind: "message", id: ID, control: null }, [
    { id: ID, kind: "gap" },
    text(OTHER),
  ]);
  assert.equal(r, null);
});

test("(12) hasAttachments needs a non-empty array on the matching row", () => {
  const base = { kind: "message", id: ID, control: null };
  assert.equal(decryptBump(base, [text(ID, [{}])])?.hasAttachments, true);
  assert.equal(decryptBump(base, [text(ID, [])])?.hasAttachments, false);
  assert.equal(decryptBump(base, [text(ID)])?.hasAttachments, false);
  assert.equal(
    decryptBump(base, [{ id: ID, kind: "text", attachments: "x" as never }])
      ?.hasAttachments,
    false,
  );
  // another row's attachments do not leak onto the matching row
  assert.equal(
    decryptBump(base, [text(OTHER, [{}]), text(ID)])?.hasAttachments,
    false,
  );
});

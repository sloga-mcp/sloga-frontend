// Unit spec for the report queue's provenance labels. Run with Node's
// built-in runner from packages/client:
//   node --test --conditions=browser components/modal/modals/reportProvenance.test.ts
// Declared test count: 8 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
import assert from "node:assert/strict";
import { test } from "node:test";

import { reportedAuthorOf, reporterCopyLabel } from "./reportProvenance.ts";

const reporter = (message: Record<string, unknown>) => ({
  content: { _type: "ReporterMessage", message, context: [] },
});

const server = (message: Record<string, unknown>) => ({
  content: {
    _type: "Message",
    prior_context: [],
    leading_context: [],
    message,
  },
});

const COPY = { id: "M1", channel: "C1", author: "U1", content: "hi" };
const SERVER = { _id: "M1", channel: "C1", author: "U1", content: "hi" };

test("a server copy with the same id verifies the reporter's copy", () => {
  const mine = reporter(COPY);
  assert.deepEqual(reporterCopyLabel(mine, [mine, server(SERVER)]), {
    unverified: false,
    markedEncrypted: false,
  });
});

test("no server copy: unverified", () => {
  const mine = reporter(COPY);
  assert.deepEqual(reporterCopyLabel(mine, [mine]), {
    unverified: true,
    markedEncrypted: false,
  });
});

test("no server copy and flagged encrypted: both labels", () => {
  const mine = reporter({ ...COPY, encrypted: true });
  assert.deepEqual(reporterCopyLabel(mine, [mine]), {
    unverified: true,
    markedEncrypted: true,
  });
});

test("a server copy wins over the encrypted flag", () => {
  const mine = reporter({ ...COPY, encrypted: true });
  assert.deepEqual(reporterCopyLabel(mine, [mine, server(SERVER)]), {
    unverified: false,
    markedEncrypted: false,
  });
});

test("only a literal true counts as the encrypted flag", () => {
  for (const encrypted of ["true", 1, false, null, undefined]) {
    const mine = reporter({ ...COPY, encrypted });
    assert.equal(
      reporterCopyLabel(mine, [mine]).markedEncrypted,
      false,
      String(encrypted),
    );
  }
});

test("a server copy of another message, or a copy with no id, does not verify", () => {
  const mine = reporter(COPY);
  const other = server({ ...SERVER, _id: "M2" });
  assert.equal(reporterCopyLabel(mine, [mine, other]).unverified, true);

  // The id is read from the server's `_id`, not a client-style `id`
  const wrongKey = server({ id: "M1", author: "U1" });
  assert.equal(reporterCopyLabel(mine, [mine, wrongKey]).unverified, true);

  for (const id of [undefined, "", 7]) {
    const blank = reporter({ ...COPY, id });
    const empty = server({ ...SERVER, _id: id });
    assert.equal(reporterCopyLabel(blank, [blank, empty]).unverified, true);
  }
});

test("other kinds of snapshot get no label", () => {
  for (const content of [
    { _type: "User", username: "x" },
    { _type: "Server", name: "x" },
    server(SERVER).content,
    null,
    undefined,
  ]) {
    assert.deepEqual(reporterCopyLabel({ content }, []), {
      unverified: false,
      markedEncrypted: false,
    });
  }
});

test("enforcement targets the server copy's author before the reporter's claim", () => {
  const claimed = reporter({ ...COPY, author: "FRAMED" });
  const real = server({ ...SERVER, author: "REAL" });
  assert.equal(reportedAuthorOf([claimed, real]), "REAL");
  assert.equal(reportedAuthorOf([real, claimed]), "REAL");
  assert.equal(reportedAuthorOf([claimed]), "FRAMED");
  assert.equal(reportedAuthorOf([{ content: { _type: "User" } }]), undefined);
  assert.equal(reportedAuthorOf([]), undefined);
});

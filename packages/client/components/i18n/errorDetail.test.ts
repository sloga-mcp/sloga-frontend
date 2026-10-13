// Unit spec for errorDetail. Run with Node's built-in runner from
// packages/client:
//   node --test --conditions=browser components/i18n/errorDetail.test.ts
// Declared test count: 4 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: error bodies no longer carry `location`, so the database error and
// the untranslated fallback must never print "undefined", and a body from an
// older server that still has a location must not show it either.
import assert from "node:assert/strict";
import { test } from "node:test";

import { databaseErrorDetail, untranslatedErrorText } from "./errorDetail.ts";

test("database error names the failed operation", () => {
  const body = {
    type: "DatabaseError",
    operation: "find_one",
    collection: "users",
  };
  assert.equal(databaseErrorDetail(body), "find_one");
});

test("database error without an operation falls back to the type", () => {
  assert.equal(databaseErrorDetail({ type: "DatabaseError" }), "DatabaseError");
  assert.equal(
    databaseErrorDetail({ type: "DatabaseError", operation: "" }),
    "DatabaseError",
  );
  assert.equal(
    databaseErrorDetail({ type: "DatabaseError", operation: 7 }),
    "DatabaseError",
  );
});

test("untranslated errors show only their type", () => {
  for (const type of ["UnknownUser", "UnknownServer", "ProxyError"]) {
    const text = untranslatedErrorText({ type });
    assert.equal(text, type);
    assert.ok(!text.includes("undefined"), text);
  }
});

test("a location from an older server is never shown", () => {
  const body = {
    type: "UnknownChannel",
    location: "crates/delta/src/util/reference.rs:73:20",
  };
  assert.equal(untranslatedErrorText(body), "UnknownChannel");
  const db = {
    type: "DatabaseError",
    operation: "update_one",
    location: "crates/core/database/src/models/users/ops/mongodb.rs:120:9",
  };
  assert.ok(!databaseErrorDetail(db).includes("crates/"));
});

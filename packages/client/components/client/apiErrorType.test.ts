// Unit spec for apiErrorType. Run with Node's built-in runner from
// packages/client:
//   node --test --conditions=browser components/client/apiErrorType.test.ts
// Declared test count: 4 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: `dmFailed` in popoutBridge picks the paused-DMs copy only when this
// returns "DirectMessagesPaused". stoat-api throws the response body as a
// JSON string, so that shape must read; a parsed body must read too; and
// nothing else (HTML from a proxy, an Error, a non-string type) may produce
// a type, so those keep the generic message.
import assert from "node:assert/strict";
import { test } from "node:test";

import { apiErrorType } from "./apiErrorType.ts";

test("reads the type from the JSON string stoat-api throws", () => {
  assert.equal(
    apiErrorType('{"type":"DirectMessagesPaused"}'),
    "DirectMessagesPaused",
  );
  assert.equal(
    apiErrorType('{"type":"MissingPermission","permission":"SendMessage"}'),
    "MissingPermission",
  );
});

test("reads the type from an already-parsed body", () => {
  assert.equal(
    apiErrorType({ type: "DirectMessagesPaused" }),
    "DirectMessagesPaused",
  );
  assert.equal(apiErrorType({ type: "BlockedByOther" }), "BlockedByOther");
});

test("strings that are not a JSON body have no type", () => {
  assert.equal(
    apiErrorType("<html><body>502 Bad Gateway</body></html>"),
    undefined,
  );
  assert.equal(apiErrorType("DirectMessagesPaused"), undefined);
  assert.equal(apiErrorType(""), undefined);
  assert.equal(apiErrorType('"DirectMessagesPaused"'), undefined);
  assert.equal(apiErrorType("null"), undefined);
});

test("anything else has no type", () => {
  assert.equal(
    apiErrorType(new Error("popout bridge: unknown user")),
    undefined,
  );
  assert.equal(apiErrorType(undefined), undefined);
  assert.equal(apiErrorType(null), undefined);
  assert.equal(apiErrorType(403), undefined);
  assert.equal(apiErrorType({}), undefined);
  assert.equal(apiErrorType({ type: 403 }), undefined);
  assert.equal(
    apiErrorType({ type: { type: "DirectMessagesPaused" } }),
    undefined,
  );
  assert.equal(apiErrorType('{"type":null}'), undefined);
});

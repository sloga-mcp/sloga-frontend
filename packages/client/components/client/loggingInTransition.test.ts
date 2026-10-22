// Unit spec for the LoggingIn transition table. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/client/loggingInTransition.test.ts
// Declared test count: 7 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: a fresh login whose socket fails must land in Disconnected (retried
// with backoff), not the error screen the login page used to render as a
// silent bounce back to the form. That is the regression row. The other rows
// pin the arms the controller already had, and "other" must stay unhandled so
// the controller logs it instead of moving. helloFailureError must read an
// API error type from both body shapes and turn everything else into
// "ConnectionFailed", never undefined.
import assert from "node:assert/strict";
import { test } from "node:test";

import { helloFailureError, loggingInTarget } from "./loggingInTransition.ts";

test("regression: a temporary failure while logging in is retried, not an error", () => {
  assert.equal(loggingInTarget("temporary-failure"), "disconnected");
});

test("the first socket Ready connects", () => {
  assert.equal(loggingInTarget("socket-connected"), "connected");
});

test("an account without a user goes to onboarding", () => {
  assert.equal(loggingInTarget("no-user"), "onboarding");
});

test("a permanent failure goes to the error screen", () => {
  assert.equal(loggingInTarget("permanent-failure"), "error");
});

test("any other event has no arm", () => {
  assert.equal(loggingInTarget("other"), undefined);
});

test("helloFailureError reads the API error type", () => {
  assert.equal(
    helloFailureError('{"type":"InvalidSession"}'),
    "InvalidSession",
  );
  assert.equal(helloFailureError({ type: "InvalidSession" }), "InvalidSession");
});

test("helloFailureError maps anything else to ConnectionFailed", () => {
  assert.equal(
    helloFailureError(new TypeError("Failed to fetch")),
    "ConnectionFailed",
  );
  assert.equal(
    helloFailureError("<html><body>502 Bad Gateway</body></html>"),
    "ConnectionFailed",
  );
  assert.equal(helloFailureError(undefined), "ConnectionFailed");
});

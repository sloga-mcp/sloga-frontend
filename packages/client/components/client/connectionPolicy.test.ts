// Unit spec for the connection and session policy. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/client/connectionPolicy.test.ts
// Declared test count: 19 tests (the runner also exits 0 when it finds no
// tests at all, so compare this against its pass count).
//
// Focus: dismissing the error screen may only consider dropping the session
// for an exact "InvalidSession", and only a REST probe answering HTTP 401
// confirms it (a network failure or any other status must keep the
// session). The loading spinner offers "Sign out" after enough failures OR a
// long wait, never once the client has loaded. A Client "error" event is
// sorted into a server Error frame, a socket Event, or anything else, which
// the controller re-raises.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SIGN_OUT_OFFER_AFTER_FAILURES,
  SIGN_OUT_OFFER_AFTER_MS,
  classifyClientError,
  dismissMayDropSession,
  offerSignOutWhileLoading,
  probeConfirmsRevoked,
} from "./connectionPolicy.ts";

test("the sign-out offer thresholds are pinned", () => {
  assert.equal(SIGN_OUT_OFFER_AFTER_FAILURES, 3);
  assert.equal(SIGN_OUT_OFFER_AFTER_MS, 20000);
});

test("dismissing InvalidSession may drop the session", () => {
  assert.equal(dismissMayDropSession("InvalidSession"), true);
});

test("dismissing with no permanent error keeps the session", () => {
  assert.equal(dismissMayDropSession(undefined), false);
});

test("dismissing ConnectionFailed keeps the session", () => {
  assert.equal(dismissMayDropSession("ConnectionFailed"), false);
});

test("dismissing InternalError keeps the session", () => {
  assert.equal(dismissMayDropSession("InternalError"), false);
});

test("dismissing a differently cased invalidsession keeps the session", () => {
  assert.equal(dismissMayDropSession("invalidsession"), false);
});

test("a probe answered with 401 confirms revocation", () => {
  assert.equal(probeConfirmsRevoked(401), true);
});

test("a probe answered with 200 does not confirm revocation", () => {
  assert.equal(probeConfirmsRevoked(200), false);
});

test("a probe answered with a server error does not confirm revocation", () => {
  assert.equal(probeConfirmsRevoked(500), false);
});

test("a probe that failed to fetch does not confirm revocation", () => {
  assert.equal(probeConfirmsRevoked(undefined), false);
});

test("a probe answered with another client or proxy status does not confirm revocation", () => {
  assert.equal(probeConfirmsRevoked(403), false);
  assert.equal(probeConfirmsRevoked(404), false);
  assert.equal(probeConfirmsRevoked(502), false);
});

test("no sign-out offer with no failures and no long wait", () => {
  assert.equal(offerSignOutWhileLoading(false, 0, false), false);
});

test("no sign-out offer below the failure threshold", () => {
  assert.equal(offerSignOutWhileLoading(false, 2, false), false);
});

test("the sign-out offer shows at the failure threshold", () => {
  assert.equal(offerSignOutWhileLoading(false, 3, false), true);
});

test("the sign-out offer shows after a long wait with no failures", () => {
  assert.equal(offerSignOutWhileLoading(false, 0, true), true);
});

test("no sign-out offer once the client has loaded", () => {
  assert.equal(offerSignOutWhileLoading(true, 10, true), false);
});

test("a DOM Event is a socket error", () => {
  assert.equal(classifyClientError(new Event("error")), "socket");
});

test("an Error frame from the server is a server error", () => {
  assert.equal(
    classifyClientError({ type: "Error", data: { type: "InvalidSession" } }),
    "server",
  );
});

test("an exception or a bare string is some other error", () => {
  assert.equal(classifyClientError(new Error("boom")), "other");
  assert.equal(classifyClientError("x"), "other");
  assert.equal(classifyClientError(null), "other");
});

// Unit spec for the screen-share cancel predicate — run with Node's built-in
// runner:
//   node --test components/rtc/screenShareCancel.test.ts   (Node >=23.6 strips types)
// Focus: both picker-cancel shapes stay quiet; real capture failures and
// anything else still surface.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isScreenShareCancel } from "./screenShareCancel.ts";

test("a browser picker cancel (NotAllowedError) is a cancel", () => {
  const error = new DOMException("Permission denied", "NotAllowedError");
  assert.equal(isScreenShareCancel(error), true);
});

test("the Electron shell's callback(null) shape is a cancel", () => {
  const error = new DOMException("Error starting capture", "AbortError");
  assert.equal(isScreenShareCancel(error), true);
});

test("a real capture failure still surfaces", () => {
  const error = new DOMException(
    "Could not start video source",
    "NotReadableError",
  );
  assert.equal(isScreenShareCancel(error), false);
});

test("an AbortError with any other text still surfaces", () => {
  // The name alone is not the contract — a track aborted mid-start for
  // another reason must still reach the user.
  const error = new DOMException("Starting videoinput failed", "AbortError");
  assert.equal(isScreenShareCancel(error), false);
});

test("non-errors are not cancels", () => {
  assert.equal(isScreenShareCancel(undefined), false);
  assert.equal(isScreenShareCancel("Error starting capture"), false);
  assert.equal(
    isScreenShareCancel({ message: "Error starting capture" }),
    false,
  );
});

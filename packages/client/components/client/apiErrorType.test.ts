// Unit spec for apiErrorType. Run with Node's built-in runner from
// packages/client:
//   node --test --conditions=browser components/client/apiErrorType.test.ts
// Declared test count: 9 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// The last five cover a write refused for not being encrypted. Known-bad
// control: against this module and `../i18n/errors.ts` as of d9dd3de2 all
// five fail.
//
// Focus: `dmFailed` in popoutBridge picks the paused-DMs copy only when this
// returns "DirectMessagesPaused". stoat-api throws the response body as a
// JSON string, so that shape must read; a parsed body must read too; and
// nothing else (HTML from a proxy, an Error, a non-string type) may produce
// a type, so those keep the generic message.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as underTest from "./apiErrorType.ts";

const { apiErrorType } = underTest;
// Read through the namespace so a module without it fails each spec below
// instead of failing to load
const encryptionRequiredSide = (error: unknown) =>
  underTest.encryptionRequiredSide(error);

/** Same shape as the error stoat.js throws when the app's guard refuses */
class EncryptedOnlyBlockedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "EncryptedOnlyBlockedError";
    this.reason = reason;
  }
}

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

test("an EncryptionRequired body gives its side", () => {
  for (const side of ["sender", "recipient", "group", "member"]) {
    const body = { type: "EncryptionRequired", side };
    assert.equal(encryptionRequiredSide(JSON.stringify(body)), side);
    assert.equal(encryptionRequiredSide(body), side);
    // The type itself reads as any other does
    assert.equal(apiErrorType(JSON.stringify(body)), "EncryptionRequired");
  }
});

test("the guard's error gives its reason", () => {
  for (const reason of ["sender", "recipient", "group", "setup", "open-app"]) {
    assert.equal(
      encryptionRequiredSide(new EncryptedOnlyBlockedError(reason)),
      reason,
    );
    // Matched by name, so one thrown in another window reads too
    assert.equal(
      encryptionRequiredSide({ name: "EncryptedOnlyBlockedError", reason }),
      reason,
    );
  }
});

test("an unknown or missing side is still a refusal", () => {
  for (const thrown of [
    '{"type":"EncryptionRequired"}',
    '{"type":"EncryptionRequired","side":"device"}',
    { type: "EncryptionRequired", side: 7 },
    { type: "EncryptionRequired", side: null },
    new EncryptedOnlyBlockedError("something-new"),
    new EncryptedOnlyBlockedError(""),
  ]) {
    assert.equal(encryptionRequiredSide(thrown), "sender");
  }
});

test("no other error is an encryption refusal", () => {
  for (const thrown of [
    '{"type":"DirectMessagesPaused"}',
    { type: "MissingPermission", side: "sender" },
    { side: "sender" },
    { reason: "sender" },
    new Error("EncryptionRequired"),
    new Error("recipient"),
    "EncryptionRequired",
    '"EncryptionRequired"',
    "<html><body>403 Forbidden</body></html>",
    { type: { type: "EncryptionRequired" } },
    undefined,
    null,
    403,
  ]) {
    assert.equal(encryptionRequiredSide(thrown), undefined);
  }
});

// `errors.ts` needs the lingui macro and stoat.js, so node cannot load it;
// its copy is pinned by text instead.
test("the errors mapper words every side, ahead of its other branches", () => {
  const source = readFileSync(
    new URL("../i18n/errors.ts", import.meta.url),
    "utf8",
  );

  const copy: [string[], string][] = [
    [["recipient"], "This person only accepts encrypted messages."],
    [
      ["sender"],
      "You only send encrypted messages. This chat is not encrypted yet.",
    ],
    [
      ["group"],
      "This group is encrypted. Send from a device where encryption is set up.",
    ],
    [
      ["member"],
      "This group is encrypted. Only people with encryption turned on can be added (up to 24).",
    ],
    [["open-app"], "Open the Sloga app to read and send encrypted chats."],
    [
      ["setup"],
      "Finish setting up encryption on this device to use your chats.",
    ],
    // The app's own refusal for a peer who may have turned the setting off;
    // read by `sendRefusalSide`, which knows this side
    [
      ["peer-changed"],
      "This person may no longer use Encrypted-only chats. Confirm to send this message.",
    ],
  ];

  const start = source.indexOf("sendRefusalSide(error)");
  assert.notEqual(start, -1, "the mapper never asks for the side");
  // The API-error branch would print the type, and the message pass-through
  // would print the guard's bare reason
  const apiBranch = source.indexOf("// handle Revolt API errors");
  const passThrough = source.indexOf("// pass-through pre-localised errors");
  assert.ok(apiBranch > start && passThrough > apiBranch);
  const block = source.slice(start, apiBranch);

  const named: string[] = [];
  for (const [sides, text] of copy) {
    // The cases for these sides, then the string, with no other case between
    const cases = sides.map((side) => `case "${side}":\\s*`).join("");
    const literal = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      block,
      new RegExp(`${cases}return t\`${literal}\`;`),
      `no copy for ${sides.join(" / ")}`,
    );
    named.push(...sides);
  }

  // Every side has copy, and the switch refuses to compile without one
  assert.deepEqual(
    [...named].sort(),
    [...underTest.ENCRYPTION_REQUIRED_SIDES, "peer-changed"].sort(),
  );
  assert.match(block, /const exhaustive: never = encryptionSide;/);
});

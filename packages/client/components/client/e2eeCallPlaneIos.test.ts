// How a native rejection on the Capacitor seam reaches the call plane (iOS
// call E2EE phase 2: plan D10, W3 MUST 3, ruling R14). Run with Node's
// built-in runner:
//   node --conditions=browser --test components/client/e2eeCallPlaneIos.test.ts
//
// `e2ee.ts` cannot be loaded under Node (Capacitor, Solid, stoat.js), so the
// rules live in the pure `e2eeCallPlaneIos.ts` and CapacitorTransport's
// `#rethrow` only calls it. Point `E2EE_CALL_PLANE_MODULE` at another copy of
// that module (an absolute path) to run these specs against it: that is how
// the known-bad controls are run.
//
// The reject strings are the iOS plugin's own (`Support.swift` E2eeReject,
// `E2eePlugin.swift`): every reject carries the core's error JSON as the
// message, so the `type` must come back out intact, for
// `callConfirmDowngrade` above all: `mlsCallSession` keys the R14 decision on
// `type === "declined"`, and a lost `type` would read a user's own decline as
// a failed dialog.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { protectorSendErrorCopy } from "./e2eeProtectorCopy.ts";
import { classifyEnvelopeError } from "./mlsEnvelopeClassify.ts";

type Module = typeof import("./e2eeCallPlaneIos.ts");

const MODULE_URL = process.env.E2EE_CALL_PLANE_MODULE
  ? new URL(`file://${process.env.E2EE_CALL_PLANE_MODULE}`)
  : new URL("./e2eeCallPlaneIos.ts", import.meta.url);
const mod: Module = await import(MODULE_URL.href);
const {
  CALL_PLANE_COMMANDS,
  CallProtectorLockedError,
  isCallPlaneCommand,
  nativeRejectError,
  parseNativeReject,
} = mod;

const IOS_SOURCES = new URL(
  "../../ios/App/SlogaE2ee/Sources/SlogaE2ee/",
  import.meta.url,
);

/** A Capacitor plugin rejection as the page sees it: an Error whose message is the reject string. */
function capacitorReject(message: string, code?: string): Error {
  const error = new Error(message) as Error & { code?: string };
  if (code !== undefined) error.code = code;
  return error;
}

/** The literal JSON of `static let <name> = E2eeReject(json: "...")` in Support.swift. */
function swiftRejectLiteral(name: string): string {
  const src = readFileSync(new URL("Support.swift", IOS_SOURCES), "utf8");
  const match = new RegExp(
    `static let ${name} = E2eeReject\\(json: "((?:[^"\\\\]|\\\\.)*)"\\)`,
  ).exec(src);
  assert.ok(match, `Support.swift has no E2eeReject literal named ${name}`);
  // A Swift string literal with only \" escapes is a JSON string body.
  return JSON.parse(`"${match[1]}"`) as string;
}

/** Every name the iOS command table routes `.call`, plus the dedicated confirm. */
function iosCallPlaneNames(): string[] {
  const src = readFileSync(new URL("E2eeCommands.swift", IOS_SOURCES), "utf8");
  const call = [...src.matchAll(/\("(e2ee_[a-z0-9_]+)", \.call\)/g)].map(
    (m) => m[1],
  );
  const dedicated = [
    ...src.matchAll(/\("(e2ee_[a-z0-9_]+)", \.dedicated\("([A-Za-z]+)"\)\)/g),
  ]
    .filter((m) => m[2] === "callConfirmDowngrade")
    .map((m) => m[1]);
  return [...call, ...dedicated].sort();
}

const LOCKED = '{"type":"protector_locked"}';

test("every callConfirmDowngrade reject the iOS plugin can produce keeps its type", () => {
  const declined = swiftRejectLiteral("declined");
  const unarmed = swiftRejectLiteral("cryptoFailure");
  assert.equal(declined, '{"type":"declined"}');
  assert.equal(unarmed, '{"type":"crypto_failure"}');
  const cases: [string, Record<string, unknown>][] = [
    [declined, { type: "declined" }],
    // armedOrReject: the guard never armed the plugin.
    [unarmed, { type: "crypto_failure" }],
    // validated(): each of the three required arguments.
    [
      '{"type":"invalid_argument","field":"groupId"}',
      { type: "invalid_argument", field: "groupId" },
    ],
    [
      '{"type":"invalid_argument","field":"sfuParticipants"}',
      { type: "invalid_argument", field: "sfuParticipants" },
    ],
    [
      '{"type":"invalid_argument","field":"displayNames"}',
      { type: "invalid_argument", field: "displayNames" },
    ],
    // A locked phone while the dialog's engine call opens the store.
    [LOCKED, { type: "protector_locked" }],
  ];
  for (const [message, want] of cases) {
    const got = nativeRejectError(
      "e2ee_call_confirm_downgrade",
      capacitorReject(message),
      "ios",
    ) as { type?: unknown };
    assert.equal(got.type, want.type, message);
    if (want.type !== "protector_locked") assert.deepEqual(got, want, message);
  }
});

test("a declined confirm stays a plain object, so the session's R14 check reads it as the user's answer", () => {
  const got = nativeRejectError(
    "e2ee_call_confirm_downgrade",
    capacitorReject('{"type":"declined"}'),
    "ios",
  );
  assert.equal(Object.prototype.toString.call(got), "[object Object]");
  assert.equal((got as { type?: unknown }).type, "declined");
});

test("parseNativeReject: typed JSON comes back as the object; anything else is the original error", () => {
  const typed = parseNativeReject(
    capacitorReject('{"type":"mls_epoch_gap","expected":3,"got":5}'),
  );
  assert.deepEqual(typed, { type: "mls_epoch_gap", expected: 3, got: 5 });

  const notJson = capacitorReject(
    '"E2ee.callConfirmDowngrade()" is not implemented on ios',
    "UNIMPLEMENTED",
  );
  assert.equal(parseNativeReject(notJson), notJson);
  const brokenJson = capacitorReject("{not json");
  assert.equal(parseNativeReject(brokenJson), brokenJson);
  const untyped = capacitorReject('{"field":"groupId"}');
  assert.equal(parseNativeReject(untyped), untyped);
  const array = capacitorReject('[{"type":"declined"}]');
  assert.equal(parseNativeReject(array), array);
  const nullJson = capacitorReject("null");
  assert.equal(parseNativeReject(nullJson), nullJson);
  const oddMessage = { message: 42 };
  assert.equal(parseNativeReject(oddMessage), oddMessage);
  assert.equal(parseNativeReject(null), null);
  assert.equal(parseNativeReject("declined"), "declined");
});

test("a call-plane command rejected protector_locked becomes the typed, readable CallProtectorLockedError", () => {
  for (const command of [
    "e2ee_call_create",
    "e2ee_call_process",
    "e2ee_call_commit_won",
    "e2ee_call_frame_keys",
    "e2ee_mls_publish_key_packages",
  ]) {
    const got = nativeRejectError(command, capacitorReject(LOCKED), "ios");
    assert.ok(got instanceof CallProtectorLockedError, command);
    assert.ok(got instanceof Error, command);
    const err = got as InstanceType<typeof CallProtectorLockedError>;
    assert.equal(err.type, "protector_locked", command);
    assert.equal(err.name, "CallProtectorLockedError", command);
    assert.equal(
      err.message,
      protectorSendErrorCopy({ type: "protector_locked" }, "ios"),
      command,
    );
    assert.ok(err.message.length > 0 && !err.message.includes("{"), command);
  }
});

test("the mapped error keeps the locked-phone envelope rule: never acked, never dropped", () => {
  const err = nativeRejectError(
    "e2ee_call_process",
    capacitorReject(LOCKED),
    "ios",
  );
  const disp = classifyEnvelopeError(err);
  assert.equal(disp.kind, "error");
  assert.equal(disp.ack, false);
});

test("a text-plane command keeps the plain protector_locked object its send copy needs", () => {
  for (const command of [
    "e2ee_encrypt",
    "e2ee_decrypt",
    "e2ee_encrypt_group",
    "e2ee_attachment_prepare",
    "e2ee_status",
    undefined,
  ]) {
    const got = nativeRejectError(command, capacitorReject(LOCKED), "ios");
    assert.ok(!(got instanceof Error), String(command));
    assert.deepEqual(got, { type: "protector_locked" }, String(command));
    // The text send sites read this copy; an Error would make it null.
    assert.notEqual(protectorSendErrorCopy(got, "ios"), null, String(command));
  }
});

test("only protector_locked is mapped: plain protector and every other call-plane type pass through", () => {
  for (const message of [
    '{"type":"protector"}',
    '{"type":"mls_group_not_found"}',
    '{"type":"mls_epoch_gap","expected":1,"got":2}',
    '{"type":"crypto_failure"}',
  ]) {
    const got = nativeRejectError(
      "e2ee_call_process",
      capacitorReject(message),
      "ios",
    );
    assert.ok(!(got instanceof Error), message);
    assert.deepEqual(got, JSON.parse(message), message);
  }
  const raw = capacitorReject("transport gone");
  assert.equal(nativeRejectError("e2ee_call_create", raw, "ios"), raw);
});

test("the call-plane set is exactly the iOS table's .call names plus the dedicated confirm", () => {
  const want = iosCallPlaneNames();
  assert.equal(want.length, 23, `E2eeCommands.swift yields ${want.length}`);
  assert.deepEqual([...CALL_PLANE_COMMANDS].sort(), want);
  for (const name of want) assert.equal(isCallPlaneCommand(name), true, name);
  for (const name of [
    "e2ee_mls_group_kind",
    "e2ee_text_process",
    "e2ee_wipe",
    "e2ee_downgrade",
    "",
    "E2EE_CALL_CREATE",
  ]) {
    assert.equal(isCallPlaneCommand(name), false, name);
  }
});

/**
 * Run with:
 *
 *     node --conditions=browser --test components/i18n/protectedErrors.test.ts
 *
 * The protected-channel arms of `useError` (the `errors.ts` string chain,
 * S2 W4-5 lane L9), run for real:
 *
 *  E1 `ProtectedChannelResecuring`: only `reason === "owner_device_lost"`
 *     gets the owner-device copy; any other reason, or none, keeps the
 *     re-securing copy;
 *  E2 `RemovalReasonRequired` (S2 D40) gets the reason copy;
 *  E3 `ProtectedClientOutdated` (OR-4): the update copy only when `min` is a
 *     positive safe integer; any other body gets the generic copy;
 *  E4 `InSlowmode` (OR-21): never the protected "re-secured too many times"
 *     copy here (that is the owner's successor create, in the protected
 *     UI); the generic copy;
 *  E5 `DeviceCapReached` keeps the seat copy ("This member already has");
 *     the capacity screen's "This device can't open #channel yet" comes from
 *     the shield's own join refusal, never from this chain;
 *  E6 each of them is the text (so the msgid) `protectedCopy.ts` gives the
 *     protected UI for the same error;
 *  E7 each of those msgids is an active entry of the en catalog, msgstr =
 *     msgid (a msgid missing from the catalog renders as its hash).
 *
 * `errors.ts` imports the lingui Solid macro, `@lingui/core` and stoat.js,
 * which only load inside the build. A module hook swaps them for stand-ins:
 * a `t` that fills in the values, an `en` locale and an empty `API`
 * namespace (errors.ts reads it as types only). The asserted text is the
 * source text with its values, not a catalog lookup; a msgid missing from
 * the catalog is the lingui gate's. `PROTECTED_ERRORS_FILE=<path>` loads
 * another copy of errors.ts (a known-bad control); it must fail.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const ERRORS_URL = process.env.PROTECTED_ERRORS_FILE
  ? pathToFileURL(process.env.PROTECTED_ERRORS_FILE).href
  : new URL("./errors.ts", import.meta.url).href;
const ERROR_DETAIL_URL = new URL("./errorDetail.ts", import.meta.url).href;
const COPY_URL = new URL("../client/protectedCopy.ts", import.meta.url).href;

const T_SOURCE = `function t(first, ...values) {
  if (Array.isArray(first) && "raw" in first) {
    return first.reduce(
      (out, part, i) => out + part + (i < values.length ? String(values[i]) : ""),
      "",
    );
  }
  if (first !== null && typeof first === "object" && typeof first.message === "string") {
    return first.message;
  }
  throw new Error("unexpected t() call");
}`;

const STUBS: Record<string, string> = {
  "protectederrors-test:solid-macro": `${T_SOURCE}
export function useLingui() { return { t }; }`,
  "protectederrors-test:core-macro": `export ${T_SOURCE}`,
  "protectederrors-test:core": `export const i18n = { locale: "en" };`,
  "protectederrors-test:stoat": `export const API = {};`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === ERRORS_URL) {
      if (specifier === "@lingui-solid/solid/macro") {
        return { url: "protectederrors-test:solid-macro", shortCircuit: true };
      }
      if (specifier === "@lingui/core") {
        return { url: "protectederrors-test:core", shortCircuit: true };
      }
      if (specifier === "stoat.js") {
        return { url: "protectederrors-test:stoat", shortCircuit: true };
      }
      if (specifier === "./errorDetail") {
        return { url: ERROR_DETAIL_URL, shortCircuit: true };
      }
    }
    if (context.parentURL === COPY_URL && specifier === "@lingui/core/macro") {
      return { url: "protectederrors-test:core-macro", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (Object.prototype.hasOwnProperty.call(STUBS, url)) {
      return { format: "module", shortCircuit: true, source: STUBS[url] };
    }
    return nextLoad(url, context);
  },
});

const { useError }: typeof import("./errors.ts") = await import(ERRORS_URL);
const { noticeCopy }: typeof import("../client/protectedCopy.ts") =
  await import(COPY_URL);

const translate = useError();

const RESECURING = "Re-securing this channel…";
const OWNER_DEVICE_LOST =
  "The owner's signing device was signed out. Messages are paused until the owner signs in on another device.";
const REASON_REQUIRED =
  "This member is protected from removal without a reason. Add a reason to continue.";
const OUTDATED = "Update Sloga to use this protected channel.";
const RESECURED_TOO_OFTEN =
  "This channel was re-secured too many times today. Try again later.";
const DEVICE_CAP = "This member already has 3 devices in this channel.";
const DEVICE_CAP_NO_MAX =
  "This member already has the maximum number of devices in this channel.";
/** The typed switch's `default` arm: a type with no copy of its own. */
const generic = (type: string) => `Uncaught Stoat error: ${type}`;

test("E1 ProtectedChannelResecuring: only owner_device_lost changes the copy", () => {
  assert.equal(
    translate({
      type: "ProtectedChannelResecuring",
      reason: "owner_device_lost",
    }),
    OWNER_DEVICE_LOST,
  );
  // as a JSON string too (login-style callers pass the raw body)
  assert.equal(
    translate(
      '{"type":"ProtectedChannelResecuring","reason":"owner_device_lost"}',
    ),
    OWNER_DEVICE_LOST,
  );
  for (const reason of [
    "pending_removal",
    "stale_seat_list",
    "OWNER_DEVICE_LOST",
    " owner_device_lost",
    "",
    7,
    null,
    true,
    ["owner_device_lost"],
  ]) {
    assert.equal(
      translate({ type: "ProtectedChannelResecuring", reason }),
      RESECURING,
      JSON.stringify(reason),
    );
  }
  assert.equal(translate({ type: "ProtectedChannelResecuring" }), RESECURING);
});

test("E2 RemovalReasonRequired gets the D40 reason copy", () => {
  assert.equal(translate({ type: "RemovalReasonRequired" }), REASON_REQUIRED);
  assert.equal(translate('{"type":"RemovalReasonRequired"}'), REASON_REQUIRED);
  // unknown extra fields change nothing
  assert.equal(
    translate({ type: "RemovalReasonRequired", reason: "x", max: 3 }),
    REASON_REQUIRED,
  );
});

test("E3 ProtectedClientOutdated: the update copy only for a positive safe integer min", () => {
  for (const min of [1, 2, 3, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      translate({ type: "ProtectedClientOutdated", min }),
      OUTDATED,
      String(min),
    );
  }
  for (const min of [
    0,
    -1,
    1.5,
    "2",
    null,
    true,
    [2],
    {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
  ]) {
    assert.equal(
      translate({ type: "ProtectedClientOutdated", min }),
      generic("ProtectedClientOutdated"),
      String(min),
    );
  }
  assert.equal(
    translate({ type: "ProtectedClientOutdated" }),
    generic("ProtectedClientOutdated"),
  );
});

test("E4 InSlowmode keeps the generic copy here, never the protected wording (OR-21)", () => {
  for (const body of [
    { type: "InSlowmode", retry_after: 3600 },
    { type: "InSlowmode", retry_after: 5 },
    { type: "InSlowmode" },
  ]) {
    const text = translate(body);
    assert.notEqual(text, RESECURED_TOO_OFTEN);
    assert.equal(text, generic("InSlowmode"), JSON.stringify(body));
  }
});

test("E5 DeviceCapReached keeps the seat copy, never the capacity screen's", () => {
  assert.equal(translate({ type: "DeviceCapReached", max: 3 }), DEVICE_CAP);
  for (const max of [undefined, -1, 1.5, "3", null]) {
    assert.equal(
      translate({ type: "DeviceCapReached", max }),
      DEVICE_CAP_NO_MAX,
      String(max),
    );
  }
  for (const body of [
    { type: "DeviceCapReached", max: 3 },
    { type: "DeviceCapReached" },
  ]) {
    assert.ok(!translate(body).startsWith("This device can't open"));
  }
});

test("E6 the same text (msgid) as protectedCopy gives the protected UI", () => {
  const pairs: [unknown, string][] = [
    [
      { type: "ProtectedChannelResecuring", reason: "owner_device_lost" },
      noticeCopy("owner_device_lost"),
    ],
    [{ type: "ProtectedChannelResecuring" }, noticeCopy("resecuring")],
    [{ type: "RemovalReasonRequired" }, noticeCopy("removal_reason_required")],
    [
      { type: "ProtectedClientOutdated", min: 2 },
      noticeCopy("client_outdated"),
    ],
    [{ type: "DeviceCapReached", max: 3 }, noticeCopy("device_cap_reached", 3)],
    [{ type: "DeviceCapReached" }, noticeCopy("device_cap_reached")],
  ];
  for (const [body, copy] of pairs) {
    assert.equal(translate(body), copy, JSON.stringify(body));
  }
  assert.notEqual(
    translate({ type: "InSlowmode", retry_after: 5 }),
    noticeCopy("resecured_too_often"),
  );
});

test("E7 every msgid of these arms is in the en catalog", () => {
  const en = readFileSync(
    new URL("./catalogs/en/messages.po", import.meta.url),
    "utf8",
  );
  for (const msgid of [
    RESECURING,
    OWNER_DEVICE_LOST,
    REASON_REQUIRED,
    OUTDATED,
    "This member already has {max} devices in this channel.",
    DEVICE_CAP_NO_MAX,
  ]) {
    const entry = `\nmsgid "${msgid}"\nmsgstr "${msgid}"\n`;
    assert.equal(en.split(entry).length - 1, 1, msgid);
  }
});

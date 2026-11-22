// Unit spec for the reason shown for a refused watch-together write. Run
// from packages/client:
//   node --test --conditions=browser \
//     components/ui/components/features/voice/watch/watchRefusal.test.ts
// Declared test count: 3 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// `WATCH_REFUSAL_TS=<path>` loads another copy of the module (for failing
// controls).
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  type PlainWriteInput,
  guardReason,
} from "../../../../../client/encryptedOnlyPolicy.ts";

import type * as Module from "./watchRefusal.ts";

const { watchRefusalReason } = (await import(
  process.env.WATCH_REFUSAL_TS
    ? pathToFileURL(resolve(process.env.WATCH_REFUSAL_TS)).href
    : "./watchRefusal.ts"
)) as typeof Module;

const base: PlainWriteInput = {
  latched: false,
  channel: "dm",
  peerFlag: "absent",
  peerRemembered: false,
  groupMarked: false,
  groupRemembered: false,
  device: "ready",
  encrypted: false,
  advert: "enforced",
};

test("an EncryptionRequired refusal says the policy's reason, not always the sender's", () => {
  const cases: [Partial<PlainWriteInput>, string][] = [
    [{ peerFlag: "on" }, "recipient"],
    [{ peerRemembered: true, peerFlag: "off" }, "peer-changed"],
    [{ channel: "group", groupMarked: true }, "group"],
    [{ latched: true }, "sender"],
    [{ latched: true, device: "web" }, "open-app"],
    [{ latched: true, device: "not-set-up" }, "setup"],
  ];
  for (const [over, reason] of cases) {
    const input = { ...base, ...over };
    assert.equal(
      watchRefusalReason("EncryptionRequired", input),
      reason,
      JSON.stringify(over),
    );
    // The same answer the SDK's guard gets for a watch write
    assert.equal(reason, guardReason("watch", input));
  }
});

test("no reason when the policy names none: the error's own words are shown", () => {
  assert.equal(watchRefusalReason("EncryptionRequired", base), null);
  assert.equal(
    watchRefusalReason("EncryptionRequired", { ...base, channel: "server" }),
    null,
  );
  assert.equal(watchRefusalReason("EncryptionRequired", undefined), null);
});

test("any other error is left alone", () => {
  const latched = { ...base, latched: true };
  for (const type of [
    undefined,
    "",
    "NotInVoiceChannel",
    "MissingPermission",
  ]) {
    assert.equal(watchRefusalReason(type, latched), null, String(type));
  }
});

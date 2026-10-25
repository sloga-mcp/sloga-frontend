// Specs for the Prot settings deep link (`?prot=success|cancel`, the Stripe
// return URL of a Prot purchase). Run with Node's built-in runner:
//   node --conditions=browser --test src/lib/deepLinks.prot.test.ts
//
// Pure: no DOM, no client. Only the two exact outcomes may reach settings,
// and a Prot link must never be read as a Cipher one (or the other way).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  PROT_RETURNS,
  cipherSettingsContext,
  loginReturnPath,
  parseProtReturn,
  protSettingsContext,
} from "./deepLinks.ts";

test("the Prot checkout outcomes are exactly success and cancel", () => {
  assert.deepEqual([...PROT_RETURNS], ["success", "cancel"]);
});

test("each valid Prot checkout outcome is parsed", () => {
  assert.equal(parseProtReturn("?prot=success"), "success");
  assert.equal(parseProtReturn("?prot=cancel"), "cancel");
  assert.equal(parseProtReturn("prot=success"), "success");
  assert.equal(parseProtReturn("?a=1&prot=cancel&b=2"), "cancel");
});

test("junk Prot checkout outcomes are ignored", () => {
  for (const search of [
    "",
    "?",
    "?prot=",
    "?prot=Success",
    "?prot=SUCCESS",
    "?prot=succeeded",
    "?prot=success%20",
    "?prot=failed",
    "?prot=__proto__",
    "?prot=constructor",
    "?PROT=success",
    "?prots=success",
    "?cipher=success",
    "?prot=https://evil.com",
  ]) {
    assert.equal(parseProtReturn(search), undefined, search);
  }
});

test("only the first prot value counts", () => {
  assert.equal(parseProtReturn("?prot=junk&prot=success"), undefined);
  assert.equal(parseProtReturn("?prot=cancel&prot=junk"), "cancel");
});

test("the Prot settings context opens the Prot page with the outcome", () => {
  assert.deepEqual(protSettingsContext("?prot=success"), {
    page: "prot",
    checkout: "success",
  });
  assert.deepEqual(protSettingsContext("?prot=cancel"), {
    page: "prot",
    checkout: "cancel",
  });
});

test("no Prot settings context without a valid prot param", () => {
  for (const search of [
    "",
    "?stream_complete=abc&stream_platform=twitch",
    "?prot=junk",
    "?prot=SUCCESS",
    "?cipher=success",
    "?cipher_tier=T149",
  ]) {
    assert.equal(protSettingsContext(search), undefined, search);
  }
});

test("Prot and Cipher links never read as each other", () => {
  // A Prot return carries no Cipher context ...
  assert.equal(cipherSettingsContext("?prot=success"), undefined);
  // ... and a URL with both still gives the Cipher context, which the
  // settings redirect checks first (Cipher links keep precedence)
  assert.deepEqual(cipherSettingsContext("?cipher=success&prot=cancel"), {
    page: "cipher",
    checkout: "success",
  });
});

test("the settings redirect reads a Prot link only without a Cipher one", () => {
  // Source level: index.tsx is a .tsx reaching Solid and the router, which
  // no unit runner loads. A Cipher link keeps its behavior (store builds
  // included); a Prot link opens at once, never through the channel wait.
  const index = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
  assert.match(
    index,
    /const prot = cipher\s*\?\s*undefined\s*:\s*protSettingsContext\(window\.location\.search\);/,
  );
  assert.match(
    index,
    /if \(action !== "wait"\) \{(?:\s*\/\/[^\n]*)*\s*openSettings\(action === "open" \? cipher : prot\);/,
  );
  // The wait path only ever opens the Cipher context
  assert.match(index, /if \(allowed\) decide\(cipher\);/);
  assert.doesNotMatch(index, /decide\(prot\)/);
});

test("the Prot return survives the login redirect", () => {
  assert.equal(
    loginReturnPath("/settings", "?prot=success"),
    "/settings?prot=success",
  );
  assert.equal(
    loginReturnPath("/settings/", "?prot=cancel"),
    "/settings/?prot=cancel",
  );
});

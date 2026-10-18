// Specs for the Cipher settings deep link and the post-login return path.
// Run with Node's built-in runner:
//   node --conditions=browser --test src/lib/deepLinks.test.ts
//
// Pure: no DOM, no client. A tier outside the three literals must never
// reach settings, and the stored login return path must never resolve to
// another origin.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CIPHER_RETURNS,
  CIPHER_TIERS,
  MAX_RETURN_SEARCH_LENGTH,
  cipherSettingsContext,
  loginReturnPath,
  parseCipherReturn,
  parseCipherTier,
} from "./deepLinks.ts";

test("the tier list is exactly the three Cipher tiers", () => {
  assert.deepEqual([...CIPHER_TIERS], ["T99", "T149", "T299"]);
});

test("each valid tier is parsed", () => {
  assert.equal(parseCipherTier("?cipher_tier=T99"), "T99");
  assert.equal(parseCipherTier("?cipher_tier=T149"), "T149");
  assert.equal(parseCipherTier("?cipher_tier=T299"), "T299");
});

test("the tier is found without a leading ? and beside other params", () => {
  assert.equal(parseCipherTier("cipher_tier=T149"), "T149");
  assert.equal(parseCipherTier("?a=1&cipher_tier=T299&b=2"), "T299");
});

test("junk, other casing and near misses are ignored", () => {
  for (const search of [
    "",
    "?",
    "?cipher_tier=",
    "?cipher_tier=t149",
    "?cipher_tier=T150",
    "?cipher_tier=T149%20",
    "?cipher_tier=T149x",
    "?cipher_tier=149",
    "?cipher_tier=T99,T149",
    "?cipher_tier=__proto__",
    "?cipher_tier=constructor",
    "?CIPHER_TIER=T149",
    "?tier=T149",
    "?cipher_tier=https://evil.com",
  ]) {
    assert.equal(parseCipherTier(search), undefined, search);
  }
});

test("only the first cipher_tier value counts", () => {
  assert.equal(
    parseCipherTier("?cipher_tier=junk&cipher_tier=T149"),
    undefined,
  );
  assert.equal(parseCipherTier("?cipher_tier=T99&cipher_tier=junk"), "T99");
});

test("the checkout outcomes are exactly success and cancel", () => {
  assert.deepEqual([...CIPHER_RETURNS], ["success", "cancel"]);
});

test("each valid checkout outcome is parsed", () => {
  assert.equal(parseCipherReturn("?cipher=success"), "success");
  assert.equal(parseCipherReturn("?cipher=cancel"), "cancel");
  assert.equal(parseCipherReturn("cipher=success"), "success");
});

test("junk checkout outcomes are ignored", () => {
  for (const search of [
    "",
    "?cipher=",
    "?cipher=Success",
    "?cipher=SUCCESS",
    "?cipher=succeeded",
    "?cipher=success%20",
    "?cipher=failed",
    "?cipher=T149",
    "?cipher=__proto__",
    "?cipher_tier=success",
    "?CIPHER=success",
  ]) {
    assert.equal(parseCipherReturn(search), undefined, search);
  }
  assert.equal(parseCipherReturn("?cipher=junk&cipher=success"), undefined);
});

test("the settings context carries only the valid params", () => {
  assert.deepEqual(cipherSettingsContext("?cipher_tier=T149"), {
    page: "cipher",
    tier: "T149",
  });
  assert.deepEqual(cipherSettingsContext("?cipher=success"), {
    page: "cipher",
    checkout: "success",
  });
  assert.deepEqual(cipherSettingsContext("?cipher=cancel&cipher_tier=T299"), {
    page: "cipher",
    tier: "T299",
    checkout: "cancel",
  });
  assert.deepEqual(cipherSettingsContext("?cipher_tier=T99&cipher=junk"), {
    page: "cipher",
    tier: "T99",
  });
  assert.deepEqual(cipherSettingsContext("?cipher_tier=junk&cipher=success"), {
    page: "cipher",
    checkout: "success",
  });
});

test("no settings context without a valid Cipher param", () => {
  for (const search of [
    "",
    "?stream_complete=abc&stream_platform=twitch",
    "?cipher_tier=junk&cipher=junk",
    "?cipher=SUCCESS",
  ]) {
    assert.equal(cipherSettingsContext(search), undefined, search);
  }
});

test("the Stripe return survives the login redirect", () => {
  assert.equal(
    loginReturnPath("/settings", "?cipher=success"),
    "/settings?cipher=success",
  );
});

test("the deep link survives the login redirect", () => {
  assert.equal(
    loginReturnPath("/settings", "?cipher_tier=T149"),
    "/settings?cipher_tier=T149",
  );
  assert.equal(
    loginReturnPath("/settings/", "?cipher_tier=T99"),
    "/settings/?cipher_tier=T99",
  );
});

test("settings without a query string is unchanged", () => {
  assert.equal(loginReturnPath("/settings", ""), "/settings");
  assert.equal(loginReturnPath("/settings", "?"), "/settings");
});

test("other paths keep the old pathname-only behavior", () => {
  assert.equal(loginReturnPath("/", ""), "/");
  assert.equal(loginReturnPath("/friends", "?x=1"), "/friends");
  assert.equal(
    loginReturnPath("/server/01ABC/channel/01DEF", "?cipher_tier=T149"),
    "/server/01ABC/channel/01DEF",
  );
  // The invite parsers need the bare path: `/invite/:code` with a query
  // string attached would lose the invite at signup.
  assert.equal(loginReturnPath("/invite/abc", "?fbclid=1"), "/invite/abc");
});

test("a protocol-relative or absolute path falls back to /", () => {
  for (const pathname of [
    "//evil.com",
    "//evil.com/settings",
    "https://evil.com",
    "https://evil.com/settings",
    "/\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "\\\\evil.com",
    "javascript:alert(1)",
    "evil.com",
    "",
  ]) {
    assert.equal(loginReturnPath(pathname, "?cipher_tier=T149"), "/", pathname);
  }
});

test("a query string cannot change the path or the origin", () => {
  assert.equal(loginReturnPath("/settings", "//evil.com"), "/settings");
  assert.equal(loginReturnPath("/settings", "https://evil.com"), "/settings");
  assert.equal(loginReturnPath("/settings", "#x"), "/settings");
  // A URL inside a query value is just a value; the result stays a path.
  assert.equal(
    loginReturnPath("/settings", "?next=//evil.com"),
    "/settings?next=//evil.com",
  );
});

test("an oversized query string is dropped, not truncated", () => {
  const long = "?cipher_tier=T149&pad=" + "a".repeat(MAX_RETURN_SEARCH_LENGTH);
  assert.equal(loginReturnPath("/settings", long), "/settings");
});

test("every result resolves to the current origin", () => {
  const base = "https://app.example";
  const pathnames = [
    "/settings",
    "/settings/",
    "//evil.com",
    "/\\evil.com",
    "/\t/evil.com",
    "https://evil.com",
    "/friends",
  ];
  const searches = ["", "?cipher_tier=T149", "//evil.com", "?a=//evil.com"];
  for (const pathname of pathnames) {
    for (const search of searches) {
      const result = loginReturnPath(pathname, search);
      assert.ok(result.startsWith("/"), `${pathname} ${search}`);
      assert.equal(new URL(result, base).origin, base, `${pathname} ${search}`);
    }
  }
});

// Unit spec for the streaming-channel link allowlist — run with Node's
// built-in runner:
//   node --test --conditions=browser components/client/channelUrlAllowlist.test.ts
// (pure, zero-import module, so the browser condition is not load-bearing
// here — it is kept so one invocation can cover the suites beside it.)
//
// Focus: this gate is the last thing between an attacker-chosen string and an
// `href`. `handle`, `display_name` and `live_title` on a `UserConnection` are
// arbitrary UTF-8 relayed from Twitch / YouTube / Kick, and `connectionUrl`
// (streamConnections.ts:26-40) interpolates `handle` into a URL unescaped, so
// the rejections below are the contract — not the happy paths.
//
// The `blob:` case is the reason this file exists: an origin-only gate admits
// `blob:https://twitch.tv/x`, because a blob URL inherits the origin of its
// inner URL and `new URL(...).origin` reports `"https://twitch.tv"`. Deleting
// the scheme check from channelUrlAllowlist.ts fails exactly that case and
// nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";

import { allowedChannelUrl } from "./channelUrlAllowlist.ts";

/** Inputs that must never reach an `href`, and why each one is here. */
const REJECTED: [candidate: string, reason: string][] = [
  ["javascript:alert(1)", "script scheme"],
  ["JavaScript:alert(1)", "script scheme, mixed case"],
  ["data:text/html,<script>alert(1)</script>", "data scheme"],
  ["vbscript:msgbox(1)", "legacy script scheme"],
  ["blob:https://twitch.tv/abc", "blob inherits the inner URL's origin"],
  ["http://twitch.tv/foo", "right host, wrong scheme"],
  ["https://www.twitch.tv/foo", "www. is a different host"],
  ["https://twitch.tv:8443/foo", "a port makes it a different origin"],
  ["https://twitch.tv.evil.example/foo", "suffix-confusion host"],
  ["https://evil.example/twitch.tv", "allowlisted host in the path only"],
  ["https://evil.example/?next=https://twitch.tv/foo", "open-redirect shape"],
  // `URL.origin` EXCLUDES userinfo, so these pass an origin-only check while
  // a browser's hover target reads as `evil.example` to the user. Navigation
  // does land on twitch.tv, so this is a spoof, not an origin escape — but
  // the gate's stated job is to hold for a future platform whose URL comes
  // from data, and under that threat model it is a gap.
  ["https://evil.example@twitch.tv/x", "userinfo spoofs the visible host"],
  ["https://user:pass@twitch.tv/x", "userinfo with a password"],
  ["//evil.example/foo", "protocol-relative, unparseable standalone"],
  ["not a url at all", "junk"],
  ["", "empty"],
];

for (const [candidate, reason] of REJECTED) {
  test(`rejects ${JSON.stringify(candidate)} (${reason})`, () => {
    assert.equal(
      allowedChannelUrl(candidate),
      undefined,
      `${JSON.stringify(candidate)} was NOT rejected`,
    );
  });
}

test("admits the three real platform origins", () => {
  assert.equal(
    allowedChannelUrl("https://twitch.tv/foo"),
    "https://twitch.tv/foo",
  );
  assert.equal(
    allowedChannelUrl("https://youtube.com/@foo"),
    "https://youtube.com/@foo",
  );
  assert.equal(
    allowedChannelUrl("https://kick.com/foo"),
    "https://kick.com/foo",
  );
});

test("admits a YouTube channel-id path", () => {
  assert.equal(
    allowedChannelUrl("https://youtube.com/channel/UC123"),
    "https://youtube.com/channel/UC123",
  );
});

test("a hostile path on an allowlisted origin stays on that origin", () => {
  // These are reachable today: `connectionUrl` hard-codes scheme + host, so a
  // hostile handle lands in the path. That is harmless, and the gate must not
  // reject it — over-rejecting would silently drop real streamers' links.
  for (const candidate of [
    "https://twitch.tv/evil.com",
    "https://twitch.tv/foo@evil.com",
    "https://twitch.tv//evil.example/foo",
    "https://twitch.tv/foo?x=1#y",
  ]) {
    const allowed = allowedChannelUrl(candidate);
    assert.ok(allowed, `expected ${JSON.stringify(candidate)} to be allowed`);
    assert.equal(new URL(allowed).origin, "https://twitch.tv");
  }
});

test("returns the parser's normalized href, not the input string", () => {
  // Tabs and newlines are stripped by the URL parser; the value handed back
  // must be the parsed one, so what is validated is what reaches the href.
  assert.equal(
    allowedChannelUrl("https://twitch.tv/fo\to\n"),
    "https://twitch.tv/foo",
  );
});

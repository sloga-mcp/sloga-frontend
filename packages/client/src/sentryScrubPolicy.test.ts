// Unit spec for the Sentry breadcrumb scrub — run with Node's built-in runner:
//   node --test src/sentryScrubPolicy.test.ts   (Node >=23.6 strips types)
// Focus: an rtc diagnostic never reaches the wire whole, the auth-flow tokens
// and the OAuth code never reach it at all, identifiers are redacted while the
// route shape survives, and ordinary breadcrumbs are left alone.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REDACTED,
  REDACTED_ID,
  RTC_DIAGNOSTIC_PREFIXES,
  isRtcDiagnosticBreadcrumb,
  scrubBreadcrumb,
  scrubUrl,
} from "./sentryScrubPolicy.ts";

const consoleCrumb = (message: string, ...args: unknown[]) => ({
  category: "console",
  level: "log",
  message,
  data: { arguments: args.length ? args : [message], logger: "console" },
});

test("every rtc diagnostic family is dropped, not scrubbed", () => {
  for (const prefix of RTC_DIAGNOSTIC_PREFIXES) {
    const crumb = consoleCrumb(`${prefix} something happened`);
    assert.equal(isRtcDiagnosticBreadcrumb(crumb), true, prefix);
    assert.equal(scrubBreadcrumb(crumb), null, prefix);
  }
});

test("the real diagnostic lines that carry identities are dropped", () => {
  // The lines the reviewer named: a member identity, a witness roster with a
  // device per peer, and `<identity>@<keyIndex>` pairs.
  const lines = [
    "[mls] removing stale leaf for rejoin: 01ARZ3NDEKTSV4RRFFQ69G5FAV:01BX5ZZKBKACTAV9WEVGEMMVRY",
    "[mls] loud latch held",
    "[mls] removing 01ARZ3NDEKTSV4RRFFQ69G5FAV:01BX5ZZKBKACTAV9WEVGEMMVRY:screen: desync",
    "[e2ee] call roster reconcile: 2 of 5",
    "[rtc] could not add a track to the recording",
  ];
  for (const line of lines) {
    assert.equal(scrubBreadcrumb(consoleCrumb(line)), null, line);
  }
});

test("a dropped diagnostic takes its structured arguments with it", () => {
  // The heal probe logs a peers[] array as a second argument. `message` is the
  // joined form, but `data.arguments` keeps the live objects — dropping the
  // whole breadcrumb is what keeps those off the wire.
  const crumb = consoleCrumb(
    "[mls] loud latch held [object Object]",
    "[mls] loud latch held",
    {
      peers: [
        { device: "01ARZ3NDEKTSV4RRFFQ69G5FAV:01BX5ZZKBKACTAV9WEVGEMMVRY" },
      ],
      uncoveredMissingKeys: ["01ARZ3NDEKTSV4RRFFQ69G5FAV@3"],
    },
  );
  assert.equal(scrubBreadcrumb(crumb), null);
});

test("a prefixed first argument is caught even if message does not lead with it", () => {
  // Defence in depth: the SDK builds `message` by joining the arguments, so a
  // prefixed first argument always lands at the head today. The filter does
  // not rest on that.
  const crumb = {
    category: "console",
    message: "",
    data: { arguments: ["[mls] admit abandoned"], logger: "console" },
  };
  assert.equal(scrubBreadcrumb(crumb), null);
});

test("leading whitespace does not smuggle a diagnostic through", () => {
  assert.equal(scrubBreadcrumb(consoleCrumb("  [mls] indented")), null);
});

test("ordinary console breadcrumbs are kept", () => {
  for (const line of [
    "OAuth login failed:",
    "a line that merely mentions [mls] halfway through",
    "[notifications] permission granted",
    "[lifecycle] transition",
  ]) {
    const crumb = consoleCrumb(line);
    assert.equal(isRtcDiagnosticBreadcrumb(crumb), false, line);
    assert.notEqual(scrubBreadcrumb(crumb), null, line);
  }
});

test("a non-console breadcrumb is never treated as a diagnostic", () => {
  // Only the console integration is in scope; an rtc-shaped message arriving
  // on some other category is not what this filter is for.
  const crumb = { category: "ui.click", message: "[mls] not a console line" };
  assert.equal(isRtcDiagnosticBreadcrumb(crumb), false);
  assert.notEqual(scrubBreadcrumb(crumb), null);
});

test("auth-flow tokens are redacted, never the route that carried them", () => {
  assert.equal(
    scrubUrl("https://app.sloga.gg/login/reset/s3cret-reset-token"),
    `https://app.sloga.gg/login/reset/${REDACTED}`,
  );
  assert.equal(scrubUrl("/login/verify/abc123"), `/login/verify/${REDACTED}`);
  assert.equal(scrubUrl("/login/delete/abc123"), `/login/delete/${REDACTED}`);
  assert.equal(scrubUrl("/invite/Xy7Qm2"), `/invite/${REDACTED}`);
  assert.equal(scrubUrl("/bot/Xy7Qm2"), `/bot/${REDACTED}`);
  assert.equal(scrubUrl("/login/create/Xy7Qm2"), `/login/create/${REDACTED}`);
});

test("the OAuth authorization code never survives the query strip", () => {
  const url =
    "https://app.sloga.gg/login/oauth?code=live-authorization-code&state=xyz";
  const scrubbed = scrubUrl(url);
  assert.equal(scrubbed, `https://app.sloga.gg/login/oauth?${REDACTED}`);
  assert.ok(!scrubbed.includes("live-authorization-code"));
});

test("query strings and fragments go whole, with a marker left behind", () => {
  // User-typed text lives here too (the Jellyfin browser's SearchTerm).
  assert.equal(
    scrubUrl("/api/Users/x/Items?SearchTerm=something+private&Limit=100"),
    `/api/Users/x/Items?${REDACTED}`,
  );
  assert.equal(scrubUrl("/somewhere#fragment"), `/somewhere#${REDACTED}`);
  // A URL that never had a query keeps no marker.
  assert.equal(scrubUrl("/api/users/@me"), "/api/users/@me");
});

test("ULID identifiers are redacted and the route shape survives", () => {
  assert.equal(
    scrubUrl(
      "https://app.sloga.gg/api/channels/01ARZ3NDEKTSV4RRFFQ69G5FAV/messages",
    ),
    `https://app.sloga.gg/api/channels/${REDACTED_ID}/messages`,
  );
  // Several in one path, including the message id.
  assert.equal(
    scrubUrl(
      "/server/01ARZ3NDEKTSV4RRFFQ69G5FAV/channel/01BX5ZZKBKACTAV9WEVGEMMVRY/01CWKZ0000000000000000000A",
    ),
    `/server/${REDACTED_ID}/channel/${REDACTED_ID}/${REDACTED_ID}`,
  );
});

test("the host and ordinary path words are not mistaken for identifiers", () => {
  assert.equal(
    scrubUrl("https://app.sloga.gg/api/users/@me/settings"),
    "https://app.sloga.gg/api/users/@me/settings",
  );
  // 25 and 27 characters are not ULIDs.
  assert.equal(
    scrubUrl("/api/x/ABCDEFGHIJKLMNOPQRSTUVWXY"),
    "/api/x/ABCDEFGHIJKLMNOPQRSTUVWXY",
  );
  assert.equal(
    scrubUrl("/api/x/ABCDEFGHIJKLMNOPQRSTUVWXYZ0"),
    "/api/x/ABCDEFGHIJKLMNOPQRSTUVWXYZ0",
  );
});

test("fetch and xhr breadcrumbs are scrubbed on data.url", () => {
  const crumb = {
    category: "fetch",
    type: "http",
    data: {
      method: "GET",
      url: "https://app.sloga.gg/api/channels/01ARZ3NDEKTSV4RRFFQ69G5FAV/messages?limit=50",
      status_code: 200,
    },
  };
  const out = scrubBreadcrumb(crumb);
  assert.equal(
    out?.data.url,
    `https://app.sloga.gg/api/channels/${REDACTED_ID}/messages?${REDACTED}`,
  );
  // Everything else about the request survives — that is what makes the trail
  // worth reading.
  assert.equal(out?.data.method, "GET");
  assert.equal(out?.data.status_code, 200);
  assert.equal(out?.category, "fetch");
});

test("navigation breadcrumbs are scrubbed on both ends", () => {
  const crumb = {
    category: "navigation",
    data: {
      from: "/login/auth",
      to: "/login/reset/s3cret",
    },
  };
  const out = scrubBreadcrumb(crumb);
  assert.equal(out?.data.from, "/login/auth");
  assert.equal(out?.data.to, `/login/reset/${REDACTED}`);
});

test("the SDK's breadcrumb object is never mutated", () => {
  const data = { url: "/api/channels/01ARZ3NDEKTSV4RRFFQ69G5FAV" };
  const crumb = { category: "fetch", data };
  const out = scrubBreadcrumb(crumb);
  assert.equal(data.url, "/api/channels/01ARZ3NDEKTSV4RRFFQ69G5FAV");
  assert.notEqual(out?.data, data);
});

test("breadcrumbs with no data, or no URL in it, pass through untouched", () => {
  const bare = { category: "ui.click", message: "button" };
  assert.equal(scrubBreadcrumb(bare), bare);
  const noUrl = { category: "ui.click", data: { target: "button#send" } };
  assert.equal(scrubBreadcrumb(noUrl), noUrl);
});

test("a non-string url field is left alone rather than coerced", () => {
  const crumb = { category: "fetch", data: { url: undefined, method: "GET" } };
  assert.equal(scrubBreadcrumb(crumb), crumb);
});

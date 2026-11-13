// Unit spec for the Slim view route policy: run with Node's built-in runner:
//   node --conditions=browser --test components/client/slimRoutePolicy.test.ts
// Focus: the block list matches whole first segments only, the root,
// /settings and /friends are never redirected (Slim view can always be
// turned off), and following a redirect can never loop.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SLIM_ROOT,
  slimAllowsChannel,
  slimIsInviteLike,
  slimIsRoot,
  slimRedirectFor,
} from "./slimRoutePolicy.ts";

// Kept as its own list on purpose: the spec must not read the block list
// out of the module it is checking
const BLOCKED = ["server", "discover", "streamers", "invite", "bot", "dev"];

// Every shape a blocked path can arrive in
const SHAPES: ((segment: string) => string)[] = [
  (s) => `/${s}`,
  (s) => `/${s}/`,
  (s) => `/${s}/anything`,
  (s) => `/${s}/anything/`,
  (s) => `/${s}/a/b/c`,
  (s) => `/${s}?query=1`,
  (s) => `/${s}#hash`,
  (s) => `/${s}/?query=1`,
  (s) => `/${s}/anything?query=1#hash`,
  (s) => `/${s}/anything/#hash?not=query`,
];

// The routes src/index.tsx actually declares under these segments
const REAL_BLOCKED_ROUTES = [
  "/server/01SERVER",
  "/server/01SERVER/channel/01CHANNEL",
  "/server/01SERVER/channel/01CHANNEL/01MESSAGE",
  "/server/01SERVER/events",
  "/discover",
  "/discover/servers",
  "/discover/server/01SERVER",
  "/streamers",
  "/invite/abcDEF12",
  "/bot/01BOT",
  "/dev",
];

const BLOCKED_SAMPLES = [
  ...BLOCKED.flatMap((segment) => SHAPES.map((shape) => shape(segment))),
  ...REAL_BLOCKED_ROUTES,
];

// Paths that only look like a blocked one
const NEAR_MISSES = [
  // server
  "/servers",
  "/servers-x",
  "/server-x",
  "/serverless/x",
  "/serve",
  // discover
  "/discovery",
  "/discover-x",
  "/discovered/servers",
  "/discove",
  // streamers
  "/streamers-x",
  "/streamersx/y",
  "/streamer",
  // invite
  "/invited",
  "/invites/abc",
  "/invite-x/abc",
  "/invit",
  // bot
  "/botany",
  "/bots",
  "/bot-x/abc",
  "/bo",
  // dev
  "/developer",
  "/devtools",
  "/dev-x",
  "/de",
  // a blocked word anywhere but the first segment
  "/channel/server",
  "/channel/01CHANNEL/invite",
  "/friends/server/x",
  "/settings/dev",
  "/x/discover",
  "/login/bot/x",
];

// What Slim view must always leave alone
const NEVER_REDIRECTED = [
  "/",
  "",
  "/settings",
  "/settings/",
  "/settings/anything",
  "/settings?cipher=success",
  "/settings#hash",
  "/friends",
  "/friends/",
  "/friends?tab=online",
  "/channel/abc",
  "/channel/abc/01MESSAGE",
  "/pwa",
  "/r/code",
  "/login",
  "/login/auth",
  "/login/create/abc",
  "/login/reset/token",
  "/friends-popout",
  "/voice-overlay",
  "/some/unknown/path",
  "?query=1",
  "#hash",
  "/?query=1",
  "/#hash",
];

test("the Slim root is the app root", () => {
  assert.equal(SLIM_ROOT, "/");
});

test("every blocked prefix redirects to the Slim root, in every shape", () => {
  // A loop over an empty list would pass without checking anything
  assert.equal(
    BLOCKED_SAMPLES.length,
    BLOCKED.length * SHAPES.length + REAL_BLOCKED_ROUTES.length,
  );
  assert.ok(BLOCKED_SAMPLES.length >= 60);

  for (const path of BLOCKED_SAMPLES) {
    assert.equal(slimRedirectFor(path), SLIM_ROOT, path);
  }
});

test("a near-miss of a blocked prefix is not blocked", () => {
  assert.ok(NEAR_MISSES.length >= 4 * BLOCKED.length);

  for (const path of NEAR_MISSES) {
    assert.equal(slimRedirectFor(path), null, path);
  }
});

test("the root, settings, friends and chats are never redirected", () => {
  assert.ok(NEVER_REDIRECTED.length > 0);

  for (const path of NEVER_REDIRECTED) {
    assert.equal(slimRedirectFor(path), null, JSON.stringify(path));
  }
});

test("what follows ? or # never decides the answer", () => {
  for (const path of [
    "/friends?next=/server/x",
    "/settings#/invite/abc",
    "/?server",
    "/#/server/x",
    "/channel/abc?from=/discover",
    "?/server/x",
    "#/server/x",
  ]) {
    assert.equal(slimRedirectFor(path), null, path);
  }

  // ...and cannot hide a blocked path either
  for (const path of [
    "/server/x?next=/friends",
    "/invite/abc#/settings",
    "/dev?/",
  ]) {
    assert.equal(slimRedirectFor(path), SLIM_ROOT, path);
  }
});

test("paths the router would send to a blocked route are blocked too", () => {
  // @solidjs/router lower-cases static segments and skips empty ones, so
  // each of these opens the same page as its plain spelling
  for (const path of [
    "/Server/01SERVER",
    "/SERVER",
    "/Discover/servers",
    "/Streamers",
    "/Invite/abc",
    "/BOT/01BOT",
    "/Dev",
    "//server/01SERVER",
    "///invite/abc",
    "/server//01SERVER",
  ]) {
    assert.equal(slimRedirectFor(path), SLIM_ROOT, path);
  }

  // Case folding must not catch the allowed pages
  for (const path of ["/Settings", "/FRIENDS", "/Channel/abc", "//settings"]) {
    assert.equal(slimRedirectFor(path), null, path);
  }
});

test("following a redirect never loops", () => {
  for (const path of BLOCKED_SAMPLES) {
    const target = slimRedirectFor(path);
    assert.notEqual(target, null, path);
    assert.equal(slimRedirectFor(target!), null, path);
  }

  assert.equal(slimRedirectFor(SLIM_ROOT), null);
});

test("the Slim root is the only redirect target there is", () => {
  for (const path of [
    ...BLOCKED_SAMPLES,
    ...NEAR_MISSES,
    ...NEVER_REDIRECTED,
  ]) {
    const target = slimRedirectFor(path);
    assert.ok(target === null || target === SLIM_ROOT, path);
  }
});

test("a channel with no server is allowed", () => {
  // DM, group, Saved Notes
  assert.equal(slimAllowsChannel({}), true);
  assert.equal(slimAllowsChannel({ serverId: undefined }), true);
  assert.equal(slimAllowsChannel({ serverId: null }), true);
  assert.equal(slimAllowsChannel({ serverId: "" }), true);
});

test("a server channel is not allowed", () => {
  assert.equal(slimAllowsChannel({ serverId: "01SERVER" }), false);
  assert.equal(slimAllowsChannel({ serverId: "0" }), false);
  assert.equal(slimAllowsChannel({ serverId: " " }), false);
});

test("a channel that is not loaded yet is allowed for now", () => {
  assert.equal(slimAllowsChannel(undefined), true);
});

test("an invite path is invite-like", () => {
  for (const path of [
    "/invite",
    "/invite/",
    "/invite/abcDEF12",
    "/invite/abcDEF12/",
    "/invite/abcDEF12?query=1#hash",
    "/Invite/abcDEF12",
    "//invite/abcDEF12",
  ]) {
    assert.equal(slimIsInviteLike(path), true, path);
    // The notice is only for a path that was blocked
    assert.equal(slimRedirectFor(path), SLIM_ROOT, path);
  }
});

test("nothing else is invite-like", () => {
  for (const path of [
    "/",
    "",
    "/invited",
    "/invites/abc",
    "/invit",
    "/bot/abc",
    "/server/01SERVER",
    "/server/01SERVER/invite",
    "/channel/abc/invite",
    "/friends?next=/invite/abc",
    "/settings#/invite/abc",
    "/login/create/abc",
    "/r/code",
  ]) {
    assert.equal(slimIsInviteLike(path), false, JSON.stringify(path));
  }
});

test("the root and /app are the Slim view root screen", () => {
  for (const path of ["/", "", "//", "/app", "/app/", "/App", "/app?x=1#y"]) {
    assert.equal(slimIsRoot(path), true, JSON.stringify(path));
    assert.equal(slimRedirectFor(path), null, JSON.stringify(path));
  }
});

test("no other path is the Slim view root screen", () => {
  for (const path of [
    "/apps",
    "/application",
    "/settings",
    "/friends",
    "/channel/abc",
    "/server/01SERVER",
    "/friends?next=/app",
  ]) {
    assert.equal(slimIsRoot(path), false, JSON.stringify(path));
  }
});

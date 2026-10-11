// Unit spec for the auth form's captcha decision. Run it with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/auth/src/flows/captchaDecision.test.ts
// Declared test count: 16 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
// Focus: nothing is decided before the server answers, a native shell never
// gets the widget and hands off only when the server asks, the web uses the
// server's key over the build-time one, and "enabled without a key" never
// turns into a submit without a token.
import assert from "node:assert/strict";
import { test } from "node:test";

import { decideCaptcha } from "./captchaDecision.ts";

/** Obviously fake sitekeys; never put a real one in a fixture. */
const SERVER_KEY = "10000000-ffff-ffff-ffff-000000000001";
const BUILD_KEY = "20000000-ffff-ffff-ffff-000000000002";

const ON = { enabled: true, key: SERVER_KEY };
const ON_NO_KEY = { enabled: true };
const OFF = { enabled: false };

test("web: still loading while the server has not answered", () => {
  assert.deepEqual(
    decideCaptcha({
      native: false,
      server: undefined,
      buildTimeKey: BUILD_KEY,
    }),
    { kind: "loading" },
  );
});

test("native: still loading while the server has not answered", () => {
  assert.deepEqual(
    decideCaptcha({
      native: true,
      server: undefined,
      handoffPath: "/login/create",
    }),
    { kind: "loading" },
  );
});

test("native + enabled + handoff path: hands off to the browser", () => {
  assert.deepEqual(
    decideCaptcha({ native: true, server: ON, handoffPath: "/login/create" }),
    { kind: "handoff", path: "/login/create" },
  );
});

test("native + enabled: the handoff keeps the full path (invite code)", () => {
  assert.deepEqual(
    decideCaptcha({
      native: true,
      server: ON,
      buildTimeKey: BUILD_KEY,
      handoffPath: "/login/create/abc123",
    }),
    { kind: "handoff", path: "/login/create/abc123" },
  );
});

test("native + enabled without a server key: still hands off", () => {
  assert.deepEqual(
    decideCaptcha({
      native: true,
      server: ON_NO_KEY,
      handoffPath: "/login/reset",
    }),
    { kind: "handoff", path: "/login/reset" },
  );
});

test("native + enabled without a handoff path: unavailable, no widget", () => {
  assert.deepEqual(
    decideCaptcha({ native: true, server: ON, buildTimeKey: BUILD_KEY }),
    { kind: "unavailable" },
  );
});

test("native + enabled with a relative handoff path: unavailable", () => {
  assert.deepEqual(
    decideCaptcha({ native: true, server: ON, handoffPath: "login/create" }),
    { kind: "unavailable" },
  );
});

test("native + disabled: no widget, even with a build-time key", () => {
  assert.deepEqual(
    decideCaptcha({
      native: true,
      server: OFF,
      buildTimeKey: BUILD_KEY,
      handoffPath: "/login/create",
    }),
    { kind: "none" },
  );
});

test("native + disabled without a build-time key: none", () => {
  assert.deepEqual(decideCaptcha({ native: true, server: OFF }), {
    kind: "none",
  });
});

test("web + enabled: widget with the server key", () => {
  assert.deepEqual(
    decideCaptcha({
      native: false,
      server: ON,
      handoffPath: "/login/create",
    }),
    { kind: "widget", sitekey: SERVER_KEY },
  );
});

test("web + enabled: the server key wins over the build-time key", () => {
  assert.deepEqual(
    decideCaptcha({ native: false, server: ON, buildTimeKey: BUILD_KEY }),
    { kind: "widget", sitekey: SERVER_KEY },
  );
});

test("web + enabled without a server key: unavailable", () => {
  assert.deepEqual(decideCaptcha({ native: false, server: ON_NO_KEY }), {
    kind: "unavailable",
  });
});

test("web + enabled without a server key ignores the build-time key", () => {
  assert.deepEqual(
    decideCaptcha({
      native: false,
      server: ON_NO_KEY,
      buildTimeKey: BUILD_KEY,
    }),
    { kind: "unavailable" },
  );
});

test("web + disabled with a build-time key: widget with that key", () => {
  assert.deepEqual(
    decideCaptcha({ native: false, server: OFF, buildTimeKey: BUILD_KEY }),
    { kind: "widget", sitekey: BUILD_KEY },
  );
});

test("web + disabled without a build-time key: none", () => {
  assert.deepEqual(
    decideCaptcha({
      native: false,
      server: OFF,
      handoffPath: "/login/create",
    }),
    { kind: "none" },
  );
});

test("web + disabled with an empty build-time key: none", () => {
  assert.deepEqual(
    decideCaptcha({ native: false, server: OFF, buildTimeKey: "" }),
    { kind: "none" },
  );
});

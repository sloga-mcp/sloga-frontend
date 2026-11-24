// Unit spec for the signed-out invite and Google sign-in rules. Run it with
// Node's built-in runner from packages/client:
//   node --test --conditions=browser components/auth/src/flows/pendingInvite.test.ts
// Declared test count: 12 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
// Focus: only a bare `/invite/:code` path yields a code, over-long codes are
// refused, and Google is offered only in a browser whose server turned it on.
import assert from "node:assert/strict";
import { test } from "node:test";

import { googleSignInOffered, pendingInviteCode } from "./pendingInvite.ts";

test("invite path yields its code", () => {
  assert.equal(pendingInviteCode("/invite/abc123"), "abc123");
});

test("trailing slash is accepted", () => {
  assert.equal(pendingInviteCode("/invite/abc123/"), "abc123");
});

test("no saved path yields nothing", () => {
  assert.equal(pendingInviteCode(undefined), undefined);
});

test("other paths yield nothing", () => {
  assert.equal(pendingInviteCode("/server/01ABC/channel/01DEF"), undefined);
  assert.equal(pendingInviteCode("/bot/abc123"), undefined);
  assert.equal(pendingInviteCode("/invite/"), undefined);
});

test("deeper or decorated invite paths yield nothing", () => {
  assert.equal(pendingInviteCode("/invite/abc/extra"), undefined);
  assert.equal(pendingInviteCode("/invite/abc?x=1"), undefined);
  assert.equal(pendingInviteCode("/x/invite/abc"), undefined);
});

test("code at the length limit is kept, one over is refused", () => {
  assert.equal(
    pendingInviteCode("/invite/" + "a".repeat(128)),
    "a".repeat(128),
  );
  assert.equal(pendingInviteCode("/invite/" + "a".repeat(129)), undefined);
});

test("browser with Google turned on is offered Google", () => {
  assert.equal(
    googleSignInOffered({}, { features: { oauth_google: true } }),
    true,
  );
});

test("Google turned off is not offered", () => {
  assert.equal(
    googleSignInOffered({}, { features: { oauth_google: false } }),
    false,
  );
});

test("missing or broken config is not offered", () => {
  assert.equal(googleSignInOffered({}, undefined), false);
  assert.equal(googleSignInOffered({}, null), false);
  assert.equal(googleSignInOffered({}, { features: {} }), false);
  assert.equal(googleSignInOffered({}, "oops"), false);
});

test("a truthy non-boolean flag is not offered", () => {
  assert.equal(
    googleSignInOffered({}, { features: { oauth_google: "yes" } }),
    false,
  );
});

test("desktop app is never offered Google", () => {
  assert.equal(
    googleSignInOffered(
      { __TAURI__: {} },
      { features: { oauth_google: true } },
    ),
    false,
  );
});

test("phone app is never offered Google, a Capacitor web build is", () => {
  const on = { features: { oauth_google: true } };
  assert.equal(
    googleSignInOffered({ Capacitor: { isNativePlatform: () => true } }, on),
    false,
  );
  assert.equal(
    googleSignInOffered({ Capacitor: { isNativePlatform: () => false } }, on),
    true,
  );
});

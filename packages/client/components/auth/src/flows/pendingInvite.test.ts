// Unit spec for the signed-out invite and Google sign-in rules. Run it with
// Node's built-in runner from packages/client:
//   node --test --conditions=browser components/auth/src/flows/pendingInvite.test.ts
// Declared test count: 11 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
// Focus: only a bare `/invite/:code` path yields a code, over-long codes are
// refused, and Google is offered only outside a native shell, when the
// server turned it on.
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
    googleSignInOffered(false, { features: { oauth_google: true } }),
    true,
  );
});

test("Google turned off is not offered", () => {
  assert.equal(
    googleSignInOffered(false, { features: { oauth_google: false } }),
    false,
  );
});

test("missing or broken config is not offered", () => {
  assert.equal(googleSignInOffered(false, undefined), false);
  assert.equal(googleSignInOffered(false, null), false);
  assert.equal(googleSignInOffered(false, { features: {} }), false);
  assert.equal(googleSignInOffered(false, "oops"), false);
});

test("a truthy non-boolean flag is not offered", () => {
  assert.equal(
    googleSignInOffered(false, { features: { oauth_google: "yes" } }),
    false,
  );
});

// Which shells count as native (Tauri, Electron, the phone apps) is
// `isNativeShell`'s job, covered in components/common/lib/appOrigin.test.ts
test("a native shell is never offered Google, even with it turned on", () => {
  assert.equal(
    googleSignInOffered(true, { features: { oauth_google: true } }),
    false,
  );
});

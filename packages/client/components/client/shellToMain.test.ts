// Unit spec for the shell-to-main validator and the web popout message
// validator. Run with Node's built-in runner from packages/client:
//   node --test --conditions=browser components/client/shellToMain.test.ts
// Declared test count: 16 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: `isShellToMain` is the only check between a shell bridge payload and
// the code that acts on it (navigate, send a quick reply, open a toast). Each
// kind is accepted in the exact JSON the Rust `ShellToMain` enum emits, and
// nothing looser: exact own keys only (no extras, no missing, no inherited, no
// `__proto__`), in-app paths that can't become protocol-relative, toast ids in
// the Rust `is_toast_id` alphabet, and reply text of 1..2000 UTF-16 units. The
// shells no longer carry `popoutOpenInMain`, so the shell validator rejects it.
// `chatWindowState` (Tauri, frameless chat windows) needs a chat window label
// (`friends-window` or `chat-` and 1..20 ASCII digits) and a real boolean.
// `mainFrameRevoked` (Tauri, main-titlebar plan C5) is exactly
// `{"kind":"mainFrameRevoked"}`: it carries nothing, so any other key fails.
//
// `validateWebPopoutMessage` is the payload half of the web popout's
// `postMessage` trust rule (the sender check stays in ShellBridgeWorker): the
// exact message type, a case-exact action and an uppercase Crockford ULID,
// the same checks the listener made inline before.
//
// Non-ASCII and control characters are built with fromCharCode /
// fromCodePoint so this file stays plain ASCII.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PopoutAction,
  POPOUT_ACTIONS,
  POPOUT_WEB_MESSAGE_TYPE,
  TOAST_ID_RE,
  ULID_RE,
  isPopoutAction,
  isShellToMain,
  validateWebPopoutMessage,
} from "./shellToMain.ts";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BACKSLASH = String.fromCharCode(92);
const GRIN = String.fromCodePoint(0x1f600); // two UTF-16 units

/** The retired shell kind, in the shape the shells used to send. */
const popout = (o: Record<string, unknown> = {}) => ({
  kind: "popoutOpenInMain",
  action: "dm",
  userId: ULID,
  ...o,
});
/** What the web popout posts to its opener (`popoutBridge`). */
const web = (o: Record<string, unknown> = {}) => ({
  type: POPOUT_WEB_MESSAGE_TYPE,
  action: "dm",
  userId: ULID,
  ...o,
});
const notify = (o: Record<string, unknown> = {}) => ({
  kind: "notificationOpen",
  path: "/channel/" + ULID,
  ...o,
});
const reply = (o: Record<string, unknown> = {}) => ({
  kind: "toastReply",
  toastId: ULID,
  text: "hi",
  ...o,
});
const open = (o: Record<string, unknown> = {}) => ({
  kind: "toastOpen",
  toastId: ULID,
  ...o,
});
const state = (o: Record<string, unknown> = {}) => ({
  kind: "chatWindowState",
  label: "chat-3",
  maximized: true,
  ...o,
});
const revoked = (o: Record<string, unknown> = {}) => ({
  kind: "mainFrameRevoked",
  ...o,
});
const MAKERS = [notify, reply, open, state, revoked];

test("exported constants: stateless regexes, actions, web message type", () => {
  for (const re of [ULID_RE, TOAST_ID_RE]) {
    assert.ok(re instanceof RegExp);
    assert.equal(re.flags, "");
  }
  assert.equal(ULID_RE.source, "^[0-9A-HJKMNP-TV-Z]{26}$");
  assert.equal(TOAST_ID_RE.source, "^[0-9A-Za-z_-]{1,64}$");
  const actions: PopoutAction[] = ["dm", "call", "video", "screenshare"];
  assert.deepEqual([...POPOUT_ACTIONS], actions);
  assert.equal(POPOUT_WEB_MESSAGE_TYPE, "sloga:popout-open-in-main");
});

test("accepts every shell kind in the exact Rust wire JSON", () => {
  for (const wire of [
    '{"kind":"notificationOpen","path":"/channel/01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    '{"kind":"toastReply","toastId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","text":"on my way"}',
    '{"kind":"toastOpen","toastId":"x_1-2"}',
    '{"kind":"toastOpen","toastId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    '{"kind":"chatWindowState","label":"chat-3","maximized":true}',
    '{"kind":"chatWindowState","label":"friends-window","maximized":false}',
    '{"kind":"mainFrameRevoked"}',
  ])
    assert.equal(isShellToMain(JSON.parse(wire)), true, wire);
});

test("main frame revoked: exactly the kind, nothing riding along", () => {
  assert.equal(isShellToMain(revoked()), true);
  for (const wire of [
    '{"kind":"mainFrameRevoked","x":1}',
    '{"kind":"mainFrameRevoked","label":"main"}',
    '{"kind":"mainFrameRevoked","revoked":true}',
    '{"kind":"mainFrameRevoked","frameless":false}',
    '{"kind":"mainFrameRevoked","__proto__":{"x":1}}',
    '{"kind":"main_frame_revoked"}',
    '{"kind":"MainFrameRevoked"}',
    '{"kind":"mainframerevoked"}',
    '{"kind":"mainFrameRevoked "}',
    '{"MainFrameRevoked":null}',
    '"MainFrameRevoked"',
    '["mainFrameRevoked"]',
  ])
    assert.equal(isShellToMain(JSON.parse(wire)), false, wire);
  assert.equal(isShellToMain(revoked({ extra: undefined })), false);
  assert.equal(
    isShellToMain(Object.create(revoked())),
    false,
    "inherited kind",
  );
});

test("shell transport rejects the retired popoutOpenInMain kind", () => {
  for (const wire of [
    '{"kind":"popoutOpenInMain","action":"screenshare","userId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    '{"kind":"popoutOpenInMain","action":"dm","userId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
  ])
    assert.equal(isShellToMain(JSON.parse(wire)), false, wire);
  for (const action of POPOUT_ACTIONS) {
    assert.equal(isShellToMain(popout({ action })), false, action);
    // Nor does the web shape get through the shell door.
    assert.equal(isShellToMain(web({ action })), false, action);
    assert.equal(isShellToMain({ ...web({ action }), ...popout() }), false);
  }
});

test("web popout message: accepts the popout's own shape, every action", () => {
  for (const action of POPOUT_ACTIONS) {
    const data = web({ action });
    const result = validateWebPopoutMessage(data);
    assert.deepEqual(result, { action, userId: ULID }, action);
    assert.notEqual(result, data);
  }
  // Exactly what arrives after structured clone of the popout's message.
  const wire = JSON.parse(
    '{"type":"sloga:popout-open-in-main","action":"call","userId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
  );
  assert.deepEqual(validateWebPopoutMessage(wire), {
    action: "call",
    userId: ULID,
  });
  // Like the inline listener it replaces, extra keys are ignored, and they
  // never reach the result.
  assert.deepEqual(validateWebPopoutMessage(web({ extra: 1 })), {
    action: "dm",
    userId: ULID,
  });
});

test("popout actions: the four, case-exact", () => {
  for (const action of POPOUT_ACTIONS) {
    assert.equal(isPopoutAction(action), true, action);
    assert.notEqual(validateWebPopoutMessage(web({ action })), null, action);
  }
  for (const bad of [
    "screenShare",
    "ScreenShare",
    "DM",
    "Call",
    "VIDEO",
    " dm",
    "dm ",
    "",
    "message",
    "toString",
    "constructor",
    undefined,
    null,
    0,
    ["dm"],
    { toString: () => "dm" },
  ]) {
    assert.equal(isPopoutAction(bad), false, String(bad));
    assert.equal(validateWebPopoutMessage(web({ action: bad })), null);
  }
  const noAction: Record<string, unknown> = web();
  delete noAction.action;
  assert.equal(validateWebPopoutMessage(noAction), null);
});

test("popout user ids: uppercase Crockford ULIDs only", () => {
  for (const good of ["0".repeat(26), "Z".repeat(26)])
    assert.deepEqual(validateWebPopoutMessage(web({ userId: good })), {
      action: "dm",
      userId: good,
    });
  for (const bad of [
    ULID.toLowerCase(),
    "01arZ3NDEKTSV4RRFFQ69G5FAV",
    ULID.slice(0, 25),
    ULID + "0",
    "",
    // I, L, O and U are outside Crockford base32.
    "I" + ULID.slice(1),
    "L" + ULID.slice(1),
    "O" + ULID.slice(1),
    "U" + ULID.slice(1),
    " " + ULID.slice(1),
    ULID.slice(0, 25) + "\n",
    undefined,
    null,
    26,
    [ULID],
  ])
    assert.equal(
      validateWebPopoutMessage(web({ userId: bad })),
      null,
      String(bad),
    );
  const noUser: Record<string, unknown> = web();
  delete noUser.userId;
  assert.equal(validateWebPopoutMessage(noUser), null);
});

test("web popout message: wrong type and non-object payloads rejected", () => {
  for (const type of [
    "sloga:popout-open-in-main ",
    " sloga:popout-open-in-main",
    "SLOGA:POPOUT-OPEN-IN-MAIN",
    "sloga:popout-open-in-mai",
    "popoutOpenInMain",
    "",
    undefined,
    null,
    1,
    [POPOUT_WEB_MESSAGE_TYPE],
  ])
    assert.equal(validateWebPopoutMessage(web({ type })), null, String(type));
  const noType: Record<string, unknown> = web();
  delete noType.type;
  assert.equal(validateWebPopoutMessage(noType), null);
  // The retired shell shape carries `kind`, not `type`.
  assert.equal(validateWebPopoutMessage(popout()), null);
  for (const value of [
    null,
    undefined,
    POPOUT_WEB_MESSAGE_TYPE,
    JSON.stringify(web()),
    1,
    true,
    {},
  ])
    assert.equal(validateWebPopoutMessage(value), null, String(value));
});

test("notification paths: in-app only, bounded, no control chars", () => {
  for (const good of [
    "/",
    "/channel/" + ULID,
    "/server/" + ULID + "/channel/" + ULID,
    "/x?y=1#z",
    "/" + "a".repeat(2047),
  ])
    assert.equal(isShellToMain(notify({ path: good })), true, good);
  const bad: unknown[] = [
    "//x",
    "//evil.example/channel/x",
    BACKSLASH + "x",
    "/" + BACKSLASH + "x",
    "/channel" + BACKSLASH + "x",
    "",
    "channel/x",
    "https://evil.example/",
    "javascript:alert(1)",
    " /channel/x",
    "/" + "a".repeat(2048),
    undefined,
    null,
    1,
    ["/"],
  ];
  for (const code of [0, 9, 10, 13, 0x1b, 0x1f, 0x7f])
    bad.push("/channel/" + String.fromCharCode(code) + "x");
  for (const path of bad)
    assert.equal(
      isShellToMain(notify({ path })),
      false,
      JSON.stringify(path) ?? String(path),
    );
});

test("toast ids: the Rust is_toast_id alphabet, 1..64", () => {
  for (const good of [
    ULID,
    "x_1-2",
    "a",
    "0",
    "_",
    "-",
    "abc-DEF_123",
    ULID.toLowerCase(),
    "a".repeat(64),
  ]) {
    assert.equal(isShellToMain(open({ toastId: good })), true, good);
    assert.equal(isShellToMain(reply({ toastId: good })), true, good);
  }
  for (const bad of [
    "",
    ".",
    "..",
    " ",
    "abc def",
    "abc\n",
    "abc" + String.fromCharCode(0),
    "abc.def",
    "abc/def",
    "abc" + BACKSLASH + "def",
    "abc+def",
    "abc=",
    "abc:def",
    "<abc>",
    "caf" + String.fromCharCode(0xe9),
    String.fromCharCode(0xff21), // fullwidth A
    "a" + GRIN,
    "a".repeat(65),
    String.fromCharCode(0xe9).repeat(32),
  ]) {
    assert.equal(isShellToMain(open({ toastId: bad })), false, bad);
    assert.equal(isShellToMain(reply({ toastId: bad })), false, bad);
  }
  for (const bad of [undefined, null, 1, ["a"], { a: 1 }, true])
    for (const make of [open, reply])
      assert.equal(isShellToMain(make({ toastId: bad })), false, String(bad));
});

test("reply text: 1..2000 UTF-16 units, strings only", () => {
  assert.equal(isShellToMain(reply({ text: "x" })), true);
  assert.equal(isShellToMain(reply({ text: GRIN })), true);
  assert.equal(isShellToMain(reply({ text: "x".repeat(2000) })), true);
  // 1000 emoji = 2000 UTF-16 units (1000 code points): in. One more: out.
  assert.equal(isShellToMain(reply({ text: GRIN.repeat(1000) })), true);
  assert.equal(isShellToMain(reply({ text: GRIN.repeat(1000) + "x" })), false);
  assert.equal(isShellToMain(reply({ text: "x" + GRIN.repeat(1000) })), false);
  assert.equal(isShellToMain(reply({ text: "" })), false);
  assert.equal(isShellToMain(reply({ text: "x".repeat(2001) })), false);
  for (const bad of [
    undefined,
    null,
    5,
    ["hi"],
    { toString: () => "hi" },
    true,
  ])
    assert.equal(isShellToMain(reply({ text: bad })), false, String(bad));
});

test("exact own keys: extra, missing, inherited and __proto__ rejected", () => {
  for (const make of MAKERS) {
    const good = make();
    assert.equal(isShellToMain(good), true, good.kind);
    assert.equal(isShellToMain(make({ extra: 1 })), false, good.kind);
    assert.equal(isShellToMain(make({ extra: undefined })), false, good.kind);

    // Each required key missing in turn, both absent and moved onto the
    // prototype (a validator reading `in` or for..in would see it there).
    for (const key of Object.keys(good)) {
      const rest: Record<string, unknown> = { ...good };
      delete rest[key];
      assert.equal(isShellToMain(rest), false, `${good.kind} -${key}`);

      const value = good[key as keyof typeof good];
      const inherited = Object.assign(Object.create({ [key]: value }), rest);
      assert.equal(isShellToMain(inherited), false, `${good.kind} ^${key}`);
    }

    // JSON.parse makes `__proto__` an OWN key, as a hostile bridge would.
    const proto = JSON.parse(
      JSON.stringify(good).replace(/}$/, ',"__proto__":{"x":1}}'),
    );
    assert.ok(Object.keys(proto).includes("__proto__"));
    assert.equal(isShellToMain(proto), false, `${good.kind} __proto__`);
  }

  // Keys borrowed from another kind.
  assert.equal(isShellToMain(reply({ channelId: ULID })), false);
  assert.equal(isShellToMain(open({ text: "hi" })), false);
  assert.equal(isShellToMain(open({ path: "/channel/x" })), false);
  assert.equal(isShellToMain(notify({ toastId: ULID })), false);
  assert.equal(isShellToMain(state({ toastId: ULID })), false);
  assert.equal(isShellToMain(open({ maximized: true })), false);
});

test("chat window state labels: friends-window or chat- and 1..20 digits", async () => {
  // Looked up on the module, so a build without it fails here alone.
  const { CHAT_WINDOW_LABEL_RE: re } = (await import("./shellToMain.ts")) as {
    CHAT_WINDOW_LABEL_RE?: RegExp;
  };
  assert.ok(re instanceof RegExp, "no CHAT_WINDOW_LABEL_RE");
  assert.equal(re.flags, "");
  assert.equal(re.source, "^(friends-window|chat-[0-9]{1,20})$");

  for (const good of [
    "friends-window",
    "chat-0",
    "chat-1",
    "chat-3",
    "chat-" + "9".repeat(20),
  ]) {
    assert.equal(re.test(good), true, good);
    for (const maximized of [true, false])
      assert.equal(isShellToMain(state({ label: good, maximized })), true);
  }
  for (const bad of [
    "",
    "main",
    "chat",
    "chat-",
    "chat-1a",
    "chat-a",
    "chat--1",
    "chat-+1",
    "chat-1 ",
    " chat-1",
    "chat-1\n",
    "Chat-1",
    "CHAT-1",
    "chat_1",
    "chat1",
    "chat-" + "1".repeat(21),
    "chat-" + String.fromCharCode(0x0661), // Arabic-Indic one
    "friends-window2",
    "friends-window ",
    "friends",
    "Friends-window",
    "friends-window-1",
    "xfriends-window",
    "voice-overlay",
    "chat-1/../main",
  ]) {
    assert.equal(re.test(bad), false, JSON.stringify(bad));
    assert.equal(
      isShellToMain(state({ label: bad })),
      false,
      JSON.stringify(bad),
    );
  }
  for (const bad of [
    undefined,
    null,
    1,
    ["chat-1"],
    { toString: () => "chat-1" },
  ])
    assert.equal(isShellToMain(state({ label: bad })), false, String(bad));
  // Stateless: a `g` flag would fail alternate calls through lastIndex.
  for (let i = 0; i < 3; i++) assert.equal(re.test("chat-1"), true);
});

test("chat window state: maximized is a boolean, nothing looser", () => {
  for (const bad of [
    "true",
    "false",
    1,
    0,
    null,
    undefined,
    [true],
    {},
    { valueOf: () => true },
  ])
    assert.equal(
      isShellToMain(state({ maximized: bad })),
      false,
      JSON.stringify(bad) ?? String(bad),
    );
  // The wire spelling only: no snake case, no `state` / `value` aliases.
  for (const wire of [
    '{"kind":"chatWindowState","label":"chat-3","is_maximized":true}',
    '{"kind":"chatWindowState","label":"chat-3","value":true}',
    '{"kind":"chat_window_state","label":"chat-3","maximized":true}',
    '{"kind":"ChatWindowState","label":"chat-3","maximized":true}',
    '{"kind":"chatWindowState","label":"chat-3","maximized":true,"minimized":false}',
    '{"kind":"chatWindowState","label":"chat-3"}',
    '{"kind":"chatWindowState","maximized":true}',
  ])
    assert.equal(isShellToMain(JSON.parse(wire)), false, wire);
});

test("unknown kinds and non-object payloads rejected", () => {
  for (const kind of [
    "ToastReply",
    "toast_reply",
    "toastreply",
    "toastOpen ",
    "PopoutOpenInMain",
    "notification_open",
    "",
    undefined,
    null,
    1,
  ])
    assert.equal(isShellToMain({ ...reply(), kind }), false, String(kind));
  for (const value of [null, undefined, "x", 1, true, [], [reply()], () => 1])
    assert.equal(isShellToMain(value), false, String(value));
});

test("validation is stateless and leaves the payload untouched", () => {
  const payload = reply({ text: "x".repeat(2001) });
  const before = JSON.stringify(payload);
  assert.equal(isShellToMain(payload), false);
  assert.equal(JSON.stringify(payload), before);
  // A `g` flag would make alternate calls fail through lastIndex drift.
  for (let i = 0; i < 3; i++) {
    assert.equal(TOAST_ID_RE.test(ULID), true);
    assert.equal(ULID_RE.test(ULID), true);
  }
});

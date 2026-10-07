// Unit spec for the shell-to-main validator. Run with Node's built-in runner
// from packages/client:
//   node --test --conditions=browser components/client/shellToMain.test.ts
// Declared test count: 10 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: `isShellToMain` is the only check between a shell bridge payload and
// the code that acts on it (open a DM, start a call, navigate, send a quick
// reply). Each kind is accepted in the exact JSON the Rust `ShellToMain` enum
// emits, and nothing looser: exact own keys only (no extras, no missing, no
// inherited, no `__proto__`), case-exact actions, uppercase Crockford ULIDs,
// in-app paths that can't become protocol-relative, toast ids in the Rust
// `is_toast_id` alphabet, and reply text of 1..2000 UTF-16 units.
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
} from "./shellToMain.ts";

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BACKSLASH = String.fromCharCode(92);
const GRIN = String.fromCodePoint(0x1f600); // two UTF-16 units

const popout = (o: Record<string, unknown> = {}) => ({
  kind: "popoutOpenInMain",
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
const MAKERS = [popout, notify, reply, open];

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

test("accepts every kind in the exact Rust wire JSON", () => {
  for (const wire of [
    '{"kind":"popoutOpenInMain","action":"screenshare","userId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    '{"kind":"popoutOpenInMain","action":"dm","userId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    '{"kind":"notificationOpen","path":"/channel/01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    '{"kind":"toastReply","toastId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","text":"on my way"}',
    '{"kind":"toastOpen","toastId":"x_1-2"}',
    '{"kind":"toastOpen","toastId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
  ])
    assert.equal(isShellToMain(JSON.parse(wire)), true, wire);
});

test("popout actions: the four, case-exact", () => {
  for (const action of POPOUT_ACTIONS) {
    assert.equal(isPopoutAction(action), true, action);
    assert.equal(isShellToMain(popout({ action })), true, action);
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
    assert.equal(isShellToMain(popout({ action: bad })), false, String(bad));
  }
});

test("popout user ids: uppercase Crockford ULIDs only", () => {
  assert.equal(isShellToMain(popout({ userId: "0".repeat(26) })), true);
  assert.equal(isShellToMain(popout({ userId: "Z".repeat(26) })), true);
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
    assert.equal(isShellToMain(popout({ userId: bad })), false, String(bad));
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
  assert.equal(isShellToMain(popout({ path: "/" })), false);
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

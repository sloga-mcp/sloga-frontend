// Unit spec for the Sloga toast's rules — run with Node's built-in runner
// from packages/client:
//   node --conditions=browser --test components/client/toastPolicy.test.ts
// Declared test count: 27 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: only a Windows Tauri window or an Electron shell answering exactly
// "window" gets a Sloga toast, any sign of Electron rules out the protected
// one, only a DM or group gets one, only the protected one is `sloga_toast`,
// and only an exact { ok: true } envelope counts as shown; a reply is sent only while everything that offered the reply box
// still holds (the sweep checks no fact undoes another's denial); a toast
// belongs to the account it was shown to and is dropped for anyone else,
// including when the account changes while it goes up; a failed send maps to
// the right message for every rate-limit shape stoat-api throws; and nothing
// reaches the shell that it would refuse (length caps, surrogate pairs,
// avatar types and size).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { DmPreviewMode } from "./notificationPreviewPolicy.ts";
import {
  type ReplyFacts,
  type ToastEntry,
  type ToastRequest,
  type ToastShowDeps,
  avatarDataUrl,
  bytesToBase64,
  classifySendError,
  entryForSession,
  envelopeOk,
  evictOldest,
  MAX_AVATAR_DATA_URL_LENGTH,
  MAX_TOAST_BODY_LENGTH,
  MAX_TOAST_NAME_LENGTH,
  MAX_TOASTS,
  replyAllowed,
  showToast,
  toastSupportFor,
  toastSurfaceFor,
  truncateForToast,
} from "./toastPolicy.ts";

const entry = (channelId: string, userId = "u1"): ToastEntry => ({
  channelId,
  messageId: "m",
  allowReply: true,
  userId,
});

// ---- eviction

test("evictOldest: the cap is the shell's three", () => {
  assert.equal(MAX_TOASTS, 3);
});

test("evictOldest drops the oldest past the cap and reports them", () => {
  const m = new Map<string, ToastEntry>();
  for (const id of ["a", "b", "c"]) m.set(id, entry(id));
  assert.deepEqual(evictOldest(m), []);
  m.set("d", entry("d"));
  assert.deepEqual(evictOldest(m), ["a"]);
  assert.deepEqual([...m.keys()], ["b", "c", "d"]);
  m.set("e", entry("e"));
  m.set("f", entry("f"));
  assert.deepEqual(evictOldest(m), ["b", "c"]);
  assert.deepEqual([...m.keys()], ["d", "e", "f"]);
});

// ---- the reply re-check

const ok: ReplyFacts = {
  allowReply: true,
  channelType: "DirectMessage",
  mode: "full_reply",
  override: undefined,
  screensharing: false,
  streamerMode: false,
  rcActive: false,
  canSendMessage: true,
  recipientRelationship: "Friend",
};

test("replyAllowed: the baseline DM and group are allowed", () => {
  assert.equal(replyAllowed(ok), true);
  assert.equal(replyAllowed({ ...ok, recipientRelationship: "None" }), true);
  assert.equal(
    replyAllowed({
      ...ok,
      channelType: "Group",
      recipientRelationship: undefined,
    }),
    true,
  );
  assert.equal(
    replyAllowed({ ...ok, mode: "off", override: "full_reply" }),
    true,
  );
});

test("replyAllowed: every single fact that closes the reply box denies it", () => {
  const denials: Partial<ReplyFacts>[] = [
    { allowReply: false },
    { channelType: undefined },
    { channelType: "TextChannel" },
    { channelType: "SavedMessages" },
    { mode: "sender" },
    { mode: "off" },
    { override: "sender" },
    { override: "off" },
    { mode: "bogus" as DmPreviewMode },
    { override: "bogus" as DmPreviewMode },
    { screensharing: true },
    { streamerMode: true },
    { rcActive: true },
    { canSendMessage: false },
    { recipientRelationship: "Blocked" },
    { recipientRelationship: "BlockedOther" },
    { recipientRelationship: undefined },
  ];
  for (const denial of denials)
    assert.equal(
      replyAllowed({ ...ok, ...denial }),
      false,
      JSON.stringify(denial),
    );
});

test("replyAllowed: no denial is ever undone by another fact (sweep)", () => {
  const bools = [true, false];
  const relationships = ["Friend", "Blocked", "BlockedOther", undefined];
  const modes = ["full_reply", "sender", "off"] as const;
  const overrides = [undefined, ...modes];
  const types = ["DirectMessage", "Group", "TextChannel", undefined];
  let cases = 0;
  for (const allowReply of bools)
    for (const screensharing of bools)
      for (const streamerMode of bools)
        for (const rcActive of bools)
          for (const canSendMessage of bools)
            for (const recipientRelationship of relationships)
              for (const mode of modes)
                for (const override of overrides)
                  for (const channelType of types) {
                    const facts: ReplyFacts = {
                      allowReply,
                      screensharing,
                      streamerMode,
                      rcActive,
                      canSendMessage,
                      recipientRelationship,
                      mode,
                      override,
                      channelType,
                    };
                    const expected =
                      allowReply &&
                      !screensharing &&
                      !streamerMode &&
                      !rcActive &&
                      canSendMessage &&
                      (override ?? mode) === "full_reply" &&
                      (channelType === "Group" ||
                        (channelType === "DirectMessage" &&
                          recipientRelationship === "Friend"));
                    assert.equal(
                      replyAllowed(facts),
                      expected,
                      JSON.stringify(facts),
                    );
                    cases++;
                  }
  assert.equal(cases, 2 ** 5 * 4 * 3 * 4 * 4);
});

// ---- send errors

test("classifySendError: E2EE by name, ahead of anything else", () => {
  const error = new Error("peer identity changed");
  error.name = "E2EESendError";
  assert.equal(classifySendError(error), "e2ee");
  assert.equal(
    classifySendError({ name: "E2EESendError", status: 429 }),
    "e2ee",
  );
});

test("classifySendError: rate limits in every shape stoat-api can throw", () => {
  for (const error of [
    { status: 429 },
    '{"retry_after":1234}',
    '{"type":"InSlowmode","retry_after":5}',
    '{"type":"InSlowmode"}',
    { type: "InSlowmode", retry_after: 5 },
    { retry_after: 0 },
    '{"error":{"code":429,"reason":"Too Many Requests"}}',
    { error: { code: 429 } },
    "<!DOCTYPE html><title>429 Too Many Requests</title>",
  ])
    assert.equal(
      classifySendError(error),
      "ratelimited",
      String(JSON.stringify(error)),
    );
});

test("classifySendError: everything else is other", () => {
  for (const error of [
    new Error("network"),
    '{"type":"MissingPermission"}',
    '{"retry_after":"soon"}',
    "500 Internal Server Error",
    "<html>Too Many Cooks</html>",
    "Too Many Requests",
    "429",
    "null",
    null,
    undefined,
    42,
    "",
    { status: 500 },
    { error: { code: 500 } },
    { name: "E2EESendErrorX" },
  ])
    assert.equal(
      classifySendError(error),
      "other",
      String(JSON.stringify(error)),
    );
});

// ---- avatars

test("bytesToBase64 matches Buffer across chunk boundaries", () => {
  for (const n of [0, 1, 2, 3, 0x7fff, 0x8000, 0x8001, 100_003]) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 0xff);
    assert.equal(
      bytesToBase64(bytes),
      Buffer.from(bytes).toString("base64"),
      String(n),
    );
  }
});

test("avatarDataUrl: each allowed type, with the exact lowercase prefix", () => {
  const bytes = new Uint8Array([1, 2, 3, 250, 251]);
  const base64 = Buffer.from(bytes).toString("base64");
  for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
    assert.equal(avatarDataUrl(type, bytes), `data:${type};base64,${base64}`);
    assert.equal(
      avatarDataUrl(` ${type.toUpperCase()}; charset=binary`, bytes),
      `data:${type};base64,${base64}`,
    );
  }
});

test("avatarDataUrl: any other type, or no bytes, is null", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  for (const type of [
    "image/svg+xml",
    "text/html",
    "",
    "image/png+evil",
    "image/pngx",
    "ximage/png",
    "image",
    "application/octet-stream",
    "image/png,text/html",
  ])
    assert.equal(avatarDataUrl(type, bytes), null, type);
  assert.equal(avatarDataUrl("image/png", new Uint8Array(0)), null);
});

test("avatarDataUrl: the whole data URL fits the shell's cap, or it is null", () => {
  assert.equal(MAX_AVATAR_DATA_URL_LENGTH, 300_000);
  // "data:image/png;base64," is 22 characters; base64 is 4 per 3 bytes.
  const fits = Math.floor((MAX_AVATAR_DATA_URL_LENGTH - 22) / 4) * 3;
  const url = avatarDataUrl("image/png", new Uint8Array(fits));
  assert.ok(url !== null && url.length <= MAX_AVATAR_DATA_URL_LENGTH);
  assert.equal(avatarDataUrl("image/png", new Uint8Array(fits + 1)), null);
  assert.equal(
    avatarDataUrl("image/png", new Uint8Array(MAX_AVATAR_DATA_URL_LENGTH + 1)),
    null,
  );
});

// ---- truncation

test("truncateForToast: within the cap is untouched, past it ends in one ellipsis", () => {
  assert.equal(MAX_TOAST_NAME_LENGTH, 200);
  assert.equal(MAX_TOAST_BODY_LENGTH, 4000);
  for (const n of [0, 1, 199, 200]) {
    const value = "a".repeat(n);
    assert.equal(truncateForToast(value, 200), value, String(n));
  }
  for (const n of [201, 202, 5000]) {
    const out = truncateForToast("a".repeat(n), 200);
    assert.equal(out, "a".repeat(199) + "…", String(n));
  }
  const body = truncateForToast("b".repeat(4001), MAX_TOAST_BODY_LENGTH);
  assert.equal(body, "b".repeat(3999) + "…");
  assert.equal(truncateForToast("ab", 1), "…");
});

test("truncateForToast: never splits a surrogate pair at the cut", () => {
  const emoji = "\u{1F600}"; // two UTF-16 units
  for (const max of [MAX_TOAST_NAME_LENGTH, MAX_TOAST_BODY_LENGTH]) {
    // The pair straddles the cut: it goes whole.
    const straddle = "a".repeat(max - 2) + emoji + "zzz";
    assert.equal(truncateForToast(straddle, max), "a".repeat(max - 2) + "…");
    // The pair ends exactly where the cut falls: it stays whole.
    const kept = "a".repeat(max - 3) + emoji + "zzz";
    assert.equal(
      truncateForToast(kept, max),
      "a".repeat(max - 3) + emoji + "…",
    );
  }
  for (const max of [200, 201, 4000]) {
    for (const lead of [0, 1]) {
      const out = truncateForToast("x".repeat(lead) + emoji.repeat(3000), max);
      assert.ok(out.length <= max, `${max}/${lead}`);
      assert.ok(out.isWellFormed(), `${max}/${lead}`);
      assert.ok(out.endsWith("…"), `${max}/${lead}`);
    }
  }
});

// ---- session ownership

test("entryForSession: the same user gets the entry and it stays", () => {
  const m = new Map<string, ToastEntry>([["t", entry("c")]]);
  assert.deepEqual(entryForSession(m, "t", "u1"), entry("c"));
  assert.equal(m.has("t"), true);
  assert.equal(entryForSession(m, "unknown", "u1"), undefined);
  assert.equal(m.size, 1);
});

test("entryForSession: another user, or nobody, gets nothing and the entry is dropped", () => {
  for (const who of ["u2", undefined, "", "U1"]) {
    const m = new Map<string, ToastEntry>([
      ["t", entry("c")],
      ["k", entry("d")],
    ]);
    assert.equal(entryForSession(m, "t", who), undefined, String(who));
    assert.equal(m.has("t"), false, String(who));
    assert.equal(m.has("k"), true, String(who));
  }
});

// ---- showing a toast

const request: ToastRequest = {
  channelId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  messageId: "01HYYYYYYYYYYYYYYYYYYYYYYY",
  title: "t".repeat(250),
  sender: "Alice",
  body: "b".repeat(4500),
  avatarUrl: "https://example.invalid/a.png",
  allowReply: true,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake app: `user` is who is signed in; each call is recorded. */
function fakeDeps(options: {
  avatar?: Promise<string | null>;
  show?: () => Promise<boolean>;
  clear?: () => Promise<unknown>;
}): {
  deps: ToastShowDeps;
  calls: { command: string; args: Record<string, unknown> }[];
  fetched: string[];
  session: { user: string | undefined };
} {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const fetched: string[] = [];
  const session: { user: string | undefined } = { user: "u1" };
  let next = 0;
  const deps: ToastShowDeps = {
    currentUserId: () => session.user,
    mintId: () => `id${next++}`,
    fetchAvatar(url) {
      fetched.push(url);
      return options.avatar ?? Promise.resolve("data:image/png;base64,AQID");
    },
    show(payload) {
      calls.push({ command: "show", args: { ...payload } });
      return options.show ? options.show() : Promise.resolve(true);
    },
    clear(channelId) {
      calls.push({ command: "clear", args: { channelId } });
      return options.clear ? options.clear() : Promise.resolve(undefined);
    },
    strings: () => ({
      replyPlaceholder: "R",
      send: "S",
      dismiss: "D",
      sending: "G",
    }),
  };
  return { deps, calls, fetched, session };
}

test("showToast: the payload is what the shell accepts, and the entry is this user's", async () => {
  const m = new Map<string, ToastEntry>();
  const { deps, calls, fetched } = fakeDeps({});
  assert.equal(await showToast(m, request, deps), true);
  assert.deepEqual(fetched, [request.avatarUrl]);
  assert.deepEqual(calls, [
    {
      command: "show",
      args: {
        id: "id0",
        channelId: request.channelId,
        title: "t".repeat(199) + "…",
        sender: "Alice",
        body: "b".repeat(3999) + "…",
        avatarDataUrl: "data:image/png;base64,AQID",
        allowReply: true,
        strings: {
          replyPlaceholder: "R",
          send: "S",
          dismiss: "D",
          sending: "G",
        },
      },
    },
  ]);
  assert.deepEqual(m.get("id0"), {
    channelId: request.channelId,
    messageId: request.messageId,
    allowReply: true,
    userId: "u1",
  });

  // No body, no avatar URL: both go as null, and no fetch is made.
  const { deps: bare, calls: bareCalls, fetched: none } = fakeDeps({});
  assert.equal(
    await showToast(m, { ...request, body: null, avatarUrl: null }, bare),
    true,
  );
  const payload = bareCalls[0].args;
  assert.equal(payload.body, null);
  assert.equal(payload.avatarDataUrl, null);
  assert.deepEqual(none, []);
});

test("showToast: nobody signed in shows nothing", async () => {
  const m = new Map<string, ToastEntry>();
  const { deps, calls, session } = fakeDeps({});
  session.user = undefined;
  assert.equal(await showToast(m, request, deps), false);
  assert.equal(calls.length, 0);
  assert.equal(m.size, 0);
});

test("showToast: a refused toast leaves no entry and costs no older one", async () => {
  const m = new Map<string, ToastEntry>();
  for (const id of ["a", "b", "c"]) m.set(id, entry(id));
  const { deps } = fakeDeps({
    show: () => Promise.reject(new Error("suppressed")),
  });
  assert.equal(await showToast(m, request, deps), false);
  assert.deepEqual([...m.keys()], ["a", "b", "c"]);

  // Accepted: recorded before the shell answers, oldest evicted after.
  const show = deferred<boolean>();
  const { deps: later } = fakeDeps({ show: () => show.promise });
  const pending = showToast(m, request, later);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...m.keys()], ["a", "b", "c", "id0"]);
  show.resolve(true);
  assert.equal(await pending, true);
  assert.deepEqual([...m.keys()], ["b", "c", "id0"]);
});

test("showToast: an account change during the avatar fetch shows nothing", async () => {
  for (const next of [undefined, "u2"]) {
    const m = new Map<string, ToastEntry>();
    const avatar = deferred<string | null>();
    const { deps, calls, session } = fakeDeps({ avatar: avatar.promise });
    const pending = showToast(m, request, deps);
    session.user = next;
    avatar.resolve(null);
    assert.equal(await pending, false, String(next));
    assert.equal(calls.length, 0, String(next));
    assert.equal(m.size, 0, String(next));
  }
});

test("showToast: an account change while the shell takes it takes it down again", async () => {
  for (const next of [undefined, "u2"]) {
    const m = new Map<string, ToastEntry>([["old", entry("x")]]);
    const show = deferred<boolean>();
    const { deps, calls, session } = fakeDeps({
      show: () => show.promise,
      // A failed clear must not surface as an unhandled rejection.
      clear: () => Promise.reject(new Error("gone")),
    });
    const pending = showToast(m, request, deps);
    await new Promise((resolve) => setImmediate(resolve));
    session.user = next;
    show.resolve(true);
    assert.equal(await pending, false, String(next));
    assert.deepEqual(
      calls.map((call) => call.command),
      ["show", "clear"],
      String(next),
    );
    assert.deepEqual(calls[1].args, { channelId: request.channelId });
    assert.deepEqual([...m.keys()], ["old"], String(next));
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test("showToast: a shell answering false is a refusal, like a rejection", async () => {
  const m = new Map<string, ToastEntry>();
  for (const id of ["a", "b", "c"]) m.set(id, entry(id));
  const { deps, calls } = fakeDeps({ show: () => Promise.resolve(false) });
  assert.equal(await showToast(m, request, deps), false);
  assert.deepEqual([...m.keys()], ["a", "b", "c"]);
  assert.deepEqual(
    calls.map((call) => call.command),
    ["show"],
  );
});

// ---- which shell draws it

const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

test("toastSupportFor: only a Windows Tauri window is protected", () => {
  assert.equal(
    toastSupportFor({
      tauri: true,
      userAgent: WINDOWS_UA,
      electronShell: false,
      electronCapability: undefined,
    }),
    "protected",
  );
  // Tauri off Windows, and Windows without Tauri (the web app), draw none.
  assert.equal(
    toastSupportFor({
      tauri: true,
      userAgent: LINUX_UA,
      electronShell: false,
      electronCapability: undefined,
    }),
    null,
  );
  assert.equal(
    toastSupportFor({
      tauri: false,
      userAgent: WINDOWS_UA,
      electronShell: false,
      electronCapability: undefined,
    }),
    null,
  );
});

test("toastSupportFor: Electron is unprotected only on an exact window answer", () => {
  assert.equal(
    toastSupportFor({
      tauri: false,
      userAgent: LINUX_UA,
      electronShell: true,
      electronCapability: { mode: "window", reason: "x11" },
    }),
    "unprotected",
  );
  for (const answer of [
    { mode: "os", reason: "wayland" },
    { mode: "Window", reason: "x11" },
    { reason: "x11" },
    "window",
    null,
    undefined,
    42,
  ]) {
    assert.equal(
      toastSupportFor({
        tauri: false,
        userAgent: LINUX_UA,
        electronShell: true,
        electronCapability: answer,
      }),
      null,
      JSON.stringify(answer) ?? "undefined",
    );
  }
});

test("toastSupportFor: any sign of Electron rules out the protected toast", () => {
  const facts = (electronShell: boolean, electronCapability: unknown) =>
    toastSupportFor({
      tauri: true,
      userAgent: WINDOWS_UA,
      electronShell,
      electronCapability,
    });
  // A Tauri global beside an Electron bridge never claims "protected": the
  // Electron toast is what would draw it, and it is in every capture.
  assert.equal(facts(true, { mode: "window", reason: "x11" }), "unprotected");
  assert.equal(facts(true, { mode: "os", reason: "wayland" }), null);
  // The bridge without a toast, or one whose capability() threw.
  assert.equal(facts(true, undefined), null);
  assert.equal(facts(true, null), null);
  // An answer from a bridge is evidence of one, even unflagged.
  assert.equal(facts(false, { mode: "window" }), "unprotected");
  assert.equal(facts(false, { mode: "os" }), null);
  assert.equal(facts(false, null), null);
  // Tauri alone on Windows is the protected toast.
  assert.equal(facts(false, undefined), "protected");
});

test("toastSurfaceFor: DMs and groups only, on exactly the shell's surface", () => {
  const supports = ["protected", "unprotected", null] as const;
  const expected: Record<string, (string | null)[]> = {
    DirectMessage: ["sloga_toast", "sloga_toast_unprotected", null],
    Group: ["sloga_toast", "sloga_toast_unprotected", null],
    TextChannel: [null, null, null],
    VoiceChannel: [null, null, null],
    SavedMessages: [null, null, null],
    Forum: [null, null, null],
    Thread: [null, null, null],
    directmessage: [null, null, null],
    "": [null, null, null],
  };
  for (const [channelType, row] of Object.entries(expected)) {
    supports.forEach((support, index) => {
      assert.equal(
        toastSurfaceFor(channelType, support),
        row[index],
        `${channelType} × ${support}`,
      );
    });
  }
  // Anything but the two exact answers is no Sloga toast.
  for (const support of ["Protected", "window", "", undefined]) {
    assert.equal(
      toastSurfaceFor("DirectMessage", support as never),
      null,
      String(support),
    );
  }
});

test("envelopeOk: only { ok: true } counts as shown", () => {
  assert.equal(envelopeOk({ ok: true }), true);
  for (const envelope of [
    { ok: false, err: "suppressed" },
    { ok: false, err: "unsupported" },
    { ok: false, err: "invalid" },
    { ok: false, err: "not_ready" },
    { ok: "true" },
    { ok: 1 },
    {},
    true,
    "ok",
    null,
    undefined,
  ]) {
    assert.equal(
      envelopeOk(envelope),
      false,
      JSON.stringify(envelope) ?? "undefined",
    );
  }
});

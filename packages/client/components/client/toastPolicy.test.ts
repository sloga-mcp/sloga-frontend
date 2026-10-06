// Unit spec for the Sloga toast's rules — run with Node's built-in runner
// from packages/client:
//   node --conditions=browser --test components/client/toastPolicy.test.ts
// Declared test count: 35 (compare against the runner's pass count, since the
// runner also exits 0 when it finds no tests at all).
// Focus: only a Windows Tauri window or an Electron shell answering exactly
// "window" gets a Sloga toast, any sign of Electron rules out the protected
// one, only a DM or group gets one, only the protected one is `sloga_toast`,
// and only an exact { ok: true } envelope counts as shown; a reply is sent only while everything that offered the reply box
// still holds (the sweep checks no fact undoes another's denial); a toast
// belongs to the account it was shown to and is dropped for anyone else,
// including when the account changes while it goes up; a failed send maps to
// the right message for every rate-limit shape stoat-api throws; a reply
// settles as sent, failed or timed out (timer cleared, a late rejection
// caught) and each maps to its message; and nothing reaches the shell that it
// would refuse (length caps on every string, surrogate pairs, avatar types and
// size).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { DmPreviewMode } from "./notificationPreviewPolicy.ts";
import {
  type ReplyFacts,
  type ReplyOutcome,
  type ToastEntry,
  type ToastRequest,
  type ToastShowDeps,
  type ToastStrings,
  avatarDataUrl,
  bytesToBase64,
  capToastStrings,
  classifySendError,
  entryForSession,
  envelopeOk,
  evictOldest,
  MAX_AVATAR_DATA_URL_LENGTH,
  MAX_TOAST_BODY_LENGTH,
  MAX_TOAST_NAME_LENGTH,
  MAX_TOASTS,
  REPLY_TIMEOUT_MS,
  replyAllowed,
  replyErrorFor,
  showToast,
  toastSupportFor,
  toastSurfaceFor,
  truncateForToast,
  withReplyTimeout,
} from "./toastPolicy.ts";

const entry = (channelId: string, userId = "u1"): ToastEntry => ({
  channelId,
  messageId: "m",
  allowReply: true,
  userId,
});

// ---- eviction

test("evictOldest: the cap reaches far past the three cards on screen", () => {
  // The page keeps a card being typed in through newer toasts and never tells
  // us what it dismissed, so its entry has to outlive many of them.
  assert.equal(MAX_TOASTS, 32);
});

test("evictOldest drops the oldest past the cap and reports them", () => {
  const m = new Map<string, ToastEntry>();
  for (const id of ["a", "b", "c"]) m.set(id, entry(id));
  assert.deepEqual(evictOldest(m, 3), []);
  m.set("d", entry("d"));
  assert.deepEqual(evictOldest(m, 3), ["a"]);
  assert.deepEqual([...m.keys()], ["b", "c", "d"]);
  m.set("e", entry("e"));
  m.set("f", entry("f"));
  assert.deepEqual(evictOldest(m, 3), ["b", "c"]);
  assert.deepEqual([...m.keys()], ["d", "e", "f"]);
});

test("evictOldest: by default only past MAX_TOASTS", () => {
  const m = new Map<string, ToastEntry>();
  for (let i = 0; i < MAX_TOASTS; i++) m.set(`t${i}`, entry(`t${i}`));
  assert.deepEqual(evictOldest(m), []);
  assert.equal(m.size, MAX_TOASTS);
  m.set("new", entry("new"));
  assert.deepEqual(evictOldest(m), ["t0"]);
  assert.equal(m.size, MAX_TOASTS);
  assert.equal(m.has("t1"), true);
  assert.equal(m.has("new"), true);
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

// ---- reply outcome

/** Timers that only fire when told to; records every set and clear. */
function fakeTimers(): {
  timers: { set: typeof setTimeout; clear: typeof clearTimeout };
  pending: Map<number, () => void>;
  delays: number[];
  cleared: number[];
  fire(): void;
} {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  const cleared: number[] = [];
  let next = 1;
  const set = (callback: () => void, ms?: number): number => {
    const id = next++;
    delays.push(ms ?? 0);
    pending.set(id, callback);
    return id;
  };
  const clear = (id?: number): void => {
    if (id === undefined) return;
    cleared.push(id);
    pending.delete(id);
  };
  return {
    timers: {
      set: set as unknown as typeof setTimeout,
      clear: clear as unknown as typeof clearTimeout,
    },
    pending,
    delays,
    cleared,
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("withReplyTimeout: a send that settles first wins, and its timer is cleared", async () => {
  assert.equal(REPLY_TIMEOUT_MS, 30_000);

  const sent = fakeTimers();
  assert.deepEqual(
    await withReplyTimeout(Promise.resolve("m"), REPLY_TIMEOUT_MS, sent.timers),
    { kind: "sent" },
  );
  assert.deepEqual(sent.delays, [REPLY_TIMEOUT_MS]);
  assert.deepEqual(sent.cleared, [1]);
  assert.equal(sent.pending.size, 0);

  const error = new Error("network");
  const failed = fakeTimers();
  const outcome = await withReplyTimeout(
    Promise.reject(error),
    REPLY_TIMEOUT_MS,
    failed.timers,
  );
  assert.equal(outcome.kind, "failed");
  assert.equal((outcome as { error: unknown }).error, error);
  assert.deepEqual(failed.cleared, [1]);
  assert.equal(failed.pending.size, 0);

  // A send that settles later, still inside the window, also clears it.
  const later = deferred<string>();
  const slow = fakeTimers();
  const pending = withReplyTimeout(later.promise, 500, slow.timers);
  await settle();
  assert.deepEqual(slow.delays, [500]);
  assert.equal(slow.pending.size, 1);
  later.resolve("m");
  assert.deepEqual(await pending, { kind: "sent" });
  assert.equal(slow.pending.size, 0);
});

test("withReplyTimeout: a send that never settles times out, and late ones go nowhere", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const late of ["resolve", "reject"] as const) {
      const send = deferred<string>();
      const fake = fakeTimers();
      const pending = withReplyTimeout(
        send.promise,
        REPLY_TIMEOUT_MS,
        fake.timers,
      );
      let done = false;
      void pending.then(() => (done = true));
      await settle();
      assert.equal(done, false, late);
      fake.fire();
      assert.deepEqual(await pending, { kind: "timeout" }, late);

      // The send settles after the card stopped waiting: the outcome stays a
      // timeout, and a rejection surfaces nowhere.
      if (late === "resolve") send.resolve("m");
      else send.reject(new Error("late"));
      await settle();
      await settle();
      assert.deepEqual(await pending, { kind: "timeout" }, late);
    }
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("withReplyTimeout: the default timers really fire", async () => {
  const never = new Promise<never>(() => {});
  assert.deepEqual(await withReplyTimeout(never, 1), { kind: "timeout" });
  assert.deepEqual(await withReplyTimeout(Promise.resolve(1), 60_000), {
    kind: "sent",
  });
});

test("replyErrorFor: sent is no error, a timeout is not confirmed", () => {
  assert.equal(replyErrorFor({ kind: "sent" }), null);
  assert.equal(replyErrorFor({ kind: "timeout" }), "notConfirmed");
  // Anything unrecognized is never taken for sent.
  for (const kind of ["bogus", "Sent", "", undefined])
    assert.equal(
      replyErrorFor({ kind } as unknown as ReplyOutcome),
      "notConfirmed",
      String(kind),
    );
});

test("replyErrorFor: a failed send maps through classifySendError", () => {
  const e2ee = new Error("peer identity changed");
  e2ee.name = "E2EESendError";
  const cases: [unknown, string][] = [
    [e2ee, "review"],
    [{ name: "E2EESendError", status: 429 }, "review"],
    [{ status: 429 }, "slowDown"],
    ['{"type":"InSlowmode"}', "slowDown"],
    ['{"retry_after":1234}', "slowDown"],
    ["<!DOCTYPE html><title>429 Too Many Requests</title>", "slowDown"],
    [new Error("network"), "couldNotSend"],
    ['{"type":"MissingPermission"}', "couldNotSend"],
    [undefined, "couldNotSend"],
    [null, "couldNotSend"],
  ];
  for (const [error, expected] of cases)
    assert.equal(
      replyErrorFor({ kind: "failed", error }),
      expected,
      String(JSON.stringify(error)),
    );
});

// ---- the toast's own strings

const strings: ToastStrings = {
  replyPlaceholder: "R",
  send: "S",
  dismiss: "D",
  sending: "G",
  couldNotSend: "C",
};

test("capToastStrings: short strings are untouched, every long one is cut", () => {
  assert.deepEqual(capToastStrings(strings), strings);
  const keys = Object.keys(strings) as (keyof ToastStrings)[];
  assert.deepEqual([...keys].sort(), [
    "couldNotSend",
    "dismiss",
    "replyPlaceholder",
    "send",
    "sending",
  ]);
  for (const key of keys) {
    // Only this key is long: it alone is cut, to exactly the cap.
    const exact = capToastStrings({ ...strings, [key]: "x".repeat(100) });
    assert.equal(exact[key], "x".repeat(100), key);
    const long = capToastStrings({ ...strings, [key]: "x".repeat(250) });
    assert.deepEqual(long, { ...strings, [key]: "x".repeat(99) + "…" }, key);
  }
  const all = capToastStrings(
    Object.fromEntries(keys.map((key) => [key, key.repeat(50)])) as never,
    20,
  );
  for (const key of keys) {
    assert.equal(all[key], key.repeat(50).slice(0, 19) + "…", key);
  }
  // Nothing but the five keys reaches the shell.
  const extra = capToastStrings({ ...strings, title: "x" } as never);
  assert.deepEqual(extra, strings);
});

test("capToastStrings: never splits a surrogate pair", () => {
  const emoji = String.fromCodePoint(0x1f600); // two UTF-16 units
  const keys = Object.keys(strings) as (keyof ToastStrings)[];
  for (const max of [99, 100, 101]) {
    for (const lead of [0, 1, 2]) {
      const value = "x".repeat(lead) + emoji.repeat(80);
      const out = capToastStrings(
        Object.fromEntries(keys.map((key) => [key, value])) as never,
        max,
      );
      for (const key of keys) {
        const label = `${key} ${max}/${lead}`;
        assert.ok(out[key].length <= max, label);
        assert.ok(out[key].isWellFormed(), label);
        assert.ok(out[key].endsWith("…"), label);
      }
    }
  }
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
    strings: () => ({ ...strings }),
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
          couldNotSend: "C",
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
  const full = Array.from({ length: MAX_TOASTS }, (_, i) => `t${i}`);
  for (const id of full) m.set(id, entry(id));
  const { deps } = fakeDeps({
    show: () => Promise.reject(new Error("suppressed")),
  });
  assert.equal(await showToast(m, request, deps), false);
  assert.deepEqual([...m.keys()], full);

  // Accepted: recorded before the shell answers, oldest evicted after.
  const show = deferred<boolean>();
  const { deps: later } = fakeDeps({ show: () => show.promise });
  const pending = showToast(m, request, later);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...m.keys()], [...full, "id0"]);
  show.resolve(true);
  assert.equal(await pending, true);
  assert.deepEqual([...m.keys()], [...full.slice(1), "id0"]);
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

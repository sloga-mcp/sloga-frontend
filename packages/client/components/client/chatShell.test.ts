// Unit spec for the chat-window shell bridge. Run with Node's built-in runner
// from packages/client:
//   node --test --conditions=browser components/client/chatShell.test.ts
// Declared test count: 19 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: whatever a shell hands back (or throws), each verb resolves exactly
// one `ShellResult` envelope and never rejects; the Tauri commands and the
// Electron verbs get exactly the arguments the shells' contracts name; Tauri
// wins when both bridges are present; and with no shell every verb answers
// `unsupported`. The fake `window` is installed on globalThis per test: the
// module reads it on every call.
//
// The capability probe caches for the life of the module, so its tests each
// load a fresh copy (`freshShell`, a query-string import Node keys as a new
// module) rather than sharing the static import's cache.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createComputed, createRoot } from "solid-js";

import type * as ChatShell from "./chatShell.ts";
import { arm, focusMain, saveBounds, setPin, supported } from "./chatShell.ts";

type Discard = (label: string) => Promise<unknown>;
let discardFn: Discard | undefined;

/**
 * `discard` looked up on the (same, cached) module rather than imported by
 * name, so a module without it (the known-bad control) still loads and only
 * its own specs fail. `discard()` below is async, so it turns a synchronous
 * throw into a rejection; the no-throw spec calls `loadDiscard()`'s function
 * directly.
 */
async function loadDiscard(): Promise<Discard> {
  const shell = (await import("./chatShell.ts")) as { discard?: Discard };
  assert.equal(typeof shell.discard, "function", "chatShell has no discard");
  return (discardFn = shell.discard!);
}

async function discard(label: string): Promise<unknown> {
  return (discardFn ?? (await loadDiscard()))(label);
}

type Call = { cmd: string; args: unknown };

const g = globalThis as { window?: unknown };

afterEach(() => {
  delete g.window;
});

/** A Tauri global whose invoke answers through `answer`, recording calls. */
function fakeTauri(answer: (cmd: string, args: unknown) => unknown) {
  const calls: Call[] = [];
  const invoke = (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    return answer(cmd, args);
  };
  return { calls, global: { core: { invoke } } };
}

/** An Electron `chatWindows` bridge whose verbs answer through `answer`. */
function fakeElectron(answer: (verb: string, args: unknown[]) => unknown) {
  const calls: { verb: string; args: unknown[] }[] = [];
  const verb =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ verb: name, args });
      return answer(name, args);
    };
  return {
    calls,
    bridge: {
      arm: verb("arm"),
      pin: verb("pin"),
      bounds: verb("bounds"),
      focusMain: verb("focusMain"),
    },
  };
}

async function allFour() {
  return [
    await arm("chat"),
    await setPin("chat-1", true),
    await saveBounds("chat-1"),
    await focusMain(),
  ];
}

test("no shell: unsupported everywhere, never a rejection", async () => {
  assert.equal(supported(), false);
  for (const result of await allFour()) {
    assert.deepEqual(result, { ok: false, err: "unsupported" });
  }

  // A window with no shell globals, and a Tauri global without a usable
  // invoke (no capability file), read the same.
  for (const win of [{}, { __TAURI__: {} }, { slogaShell: { name: "x" } }]) {
    g.window = win;
    assert.equal(supported(), false);
    for (const result of await allFour()) {
      assert.deepEqual(result, { ok: false, err: "unsupported" });
    }
  }
});

test("tauri: exact commands and args, label passed through", async () => {
  const tauri = fakeTauri((cmd) =>
    Promise.resolve(cmd === "chat_window_arm" ? "chat-7" : null),
  );
  g.window = { __TAURI__: tauri.global };
  assert.equal(supported(), true);

  assert.deepEqual(await arm("friends"), { ok: true, label: "chat-7" });
  assert.deepEqual(await setPin("chat-7", true), { ok: true });
  assert.deepEqual(await setPin("chat-7", false), { ok: true });
  assert.deepEqual(await saveBounds("chat-7"), { ok: true });
  assert.deepEqual(await focusMain(), { ok: true });
  assert.deepEqual(tauri.calls, [
    { cmd: "chat_window_arm", args: { kind: "friends" } },
    { cmd: "chat_window_pin", args: { label: "chat-7", on: true } },
    { cmd: "chat_window_pin", args: { label: "chat-7", on: false } },
    { cmd: "chat_window_bounds", args: { label: "chat-7" } },
    { cmd: "chat_window_focus_main", args: undefined },
  ]);
});

test("tauri: a non-string or empty label is invalid", async () => {
  for (const label of [undefined, null, "", 7, { label: "chat-1" }]) {
    g.window = { __TAURI__: fakeTauri(() => Promise.resolve(label)).global };
    assert.deepEqual(await arm("chat"), { ok: false, err: "invalid" });
  }
});

test("tauri: rejections and synchronous throws become { ok: false, err }", async () => {
  const cases: [() => unknown, string][] = [
    [() => Promise.reject("exists"), "exists"],
    [() => Promise.reject(new Error("not main")), "not main"],
    [() => Promise.reject(""), "failed"],
    [() => Promise.reject({ code: 1 }), "failed"],
    [() => Promise.reject(undefined), "failed"],
    [
      () => {
        throw new Error("sync");
      },
      "sync",
    ],
  ];
  for (const [answer, err] of cases) {
    g.window = { __TAURI__: fakeTauri(answer).global };
    for (const result of await allFour()) {
      assert.deepEqual(result, { ok: false, err });
    }
  }
});

test("tauri is preferred when both bridges are present", async () => {
  const tauri = fakeTauri(() => Promise.resolve("chat-1"));
  const electron = fakeElectron(() => Promise.resolve({ ok: true }));
  g.window = {
    __TAURI__: tauri.global,
    slogaShell: { chatWindows: electron.bridge },
  };
  await allFour();
  assert.equal(tauri.calls.length, 4);
  assert.equal(electron.calls.length, 0);
});

test("electron: exact verbs and args, envelopes rebuilt", async () => {
  const electron = fakeElectron((verb) =>
    Promise.resolve(
      verb === "arm"
        ? { ok: true, label: "friends-window", extra: "dropped" }
        : { ok: true, extra: "dropped" },
    ),
  );
  g.window = { slogaShell: { chatWindows: electron.bridge } };
  assert.equal(supported(), true);

  assert.deepEqual(await arm("friends"), {
    ok: true,
    label: "friends-window",
  });
  assert.deepEqual(await setPin("friends-window", true), { ok: true });
  assert.deepEqual(await saveBounds("friends-window"), { ok: true });
  assert.deepEqual(await focusMain(), { ok: true });
  assert.deepEqual(electron.calls, [
    { verb: "arm", args: ["friends"] },
    { verb: "pin", args: ["friends-window", true] },
    { verb: "bounds", args: ["friends-window"] },
    { verb: "focusMain", args: [] },
  ]);
});

test("electron: refusals pass through, malformed envelopes are invalid", async () => {
  g.window = {
    slogaShell: {
      chatWindows: fakeElectron(() =>
        Promise.resolve({ ok: false, err: "exists", extra: 1 }),
      ).bridge,
    },
  };
  for (const result of await allFour()) {
    assert.deepEqual(result, { ok: false, err: "exists" });
  }

  const malformed = [
    undefined,
    null,
    "ok",
    {},
    { ok: "true" },
    { ok: 1, label: "chat-1" },
    { ok: false },
    { ok: false, err: "" },
    { ok: false, err: 7 },
  ];
  for (const envelope of malformed) {
    g.window = {
      slogaShell: {
        chatWindows: fakeElectron(() => Promise.resolve(envelope)).bridge,
      },
    };
    for (const result of await allFour()) {
      assert.deepEqual(result, { ok: false, err: "invalid" }, String(envelope));
    }
  }

  // `{ ok: true }` without a usable label is a success for the void verbs,
  // never for arm.
  for (const label of [undefined, "", 3]) {
    g.window = {
      slogaShell: {
        chatWindows: fakeElectron(() => Promise.resolve({ ok: true, label }))
          .bridge,
      },
    };
    assert.deepEqual(await arm("chat"), { ok: false, err: "invalid" });
    assert.deepEqual(await focusMain(), { ok: true });
  }
});

test("electron: rejections, throws and missing verbs never escape", async () => {
  g.window = {
    slogaShell: {
      chatWindows: fakeElectron(() => Promise.reject(new Error("ipc down")))
        .bridge,
    },
  };
  for (const result of await allFour()) {
    assert.deepEqual(result, { ok: false, err: "ipc down" });
  }

  g.window = {
    slogaShell: {
      chatWindows: fakeElectron(() => {
        throw "sync";
      }).bridge,
    },
  };
  for (const result of await allFour()) {
    assert.deepEqual(result, { ok: false, err: "sync" });
  }

  // An older preload with only some verbs: the rest are unsupported.
  const partial = fakeElectron(() => Promise.resolve({ ok: true }));
  g.window = {
    slogaShell: { chatWindows: { focusMain: partial.bridge.focusMain } },
  };
  assert.equal(supported(), true);
  assert.deepEqual(await arm("chat"), { ok: false, err: "unsupported" });
  assert.deepEqual(await setPin("chat-1", true), {
    ok: false,
    err: "unsupported",
  });
  assert.deepEqual(await saveBounds("chat-1"), {
    ok: false,
    err: "unsupported",
  });
  assert.deepEqual(await focusMain(), { ok: true });
});

test("arm refuses an unknown kind without asking the shell", async () => {
  const tauri = fakeTauri(() => Promise.resolve("chat-1"));
  g.window = { __TAURI__: tauri.global };
  for (const kind of ["", "Chat", "popout", undefined]) {
    assert.deepEqual(await arm(kind as "chat"), { ok: false, err: "invalid" });
  }
  assert.equal(tauri.calls.length, 0);
});

test("discard, tauri: chat_window_discard with the label, envelope back", async () => {
  const tauri = fakeTauri(() => Promise.resolve(null));
  g.window = { __TAURI__: tauri.global };
  assert.deepEqual(await discard("chat-3"), { ok: true });
  assert.deepEqual(tauri.calls, [
    { cmd: "chat_window_discard", args: { label: "chat-3" } },
  ]);

  const cases: [() => unknown, string][] = [
    [() => Promise.reject("not main"), "not main"],
    [() => Promise.reject(new Error("bad label")), "bad label"],
    [() => Promise.reject(undefined), "failed"],
    [
      () => {
        throw new Error("sync");
      },
      "sync",
    ],
  ];
  for (const [answer, err] of cases) {
    g.window = { __TAURI__: fakeTauri(answer).global };
    assert.deepEqual(await discard("chat-3"), { ok: false, err });
  }
});

test("discard, electron: ok without a round trip", async () => {
  const electron = fakeElectron(() => Promise.reject(new Error("called")));
  g.window = { slogaShell: { chatWindows: electron.bridge } };
  assert.deepEqual(await discard("chat-3"), { ok: true });
  // Even a preload with none of the verbs: there is nothing to undo.
  g.window = { slogaShell: { chatWindows: {} } };
  assert.deepEqual(await discard("chat-3"), { ok: true });
  assert.equal(electron.calls.length, 0);
});

test("discard: tauri is preferred when both bridges are present", async () => {
  const tauri = fakeTauri(() => Promise.reject("not main"));
  const electron = fakeElectron(() => Promise.resolve({ ok: true }));
  g.window = {
    __TAURI__: tauri.global,
    slogaShell: { chatWindows: electron.bridge },
  };
  assert.deepEqual(await discard("chat-3"), { ok: false, err: "not main" });
  assert.equal(tauri.calls.length, 1);
  assert.equal(electron.calls.length, 0);
});

test("discard, no shell: unsupported; a throwing global never escapes", async () => {
  assert.deepEqual(await discard("chat-3"), {
    ok: false,
    err: "unsupported",
  });
  for (const win of [{}, { __TAURI__: {} }, { slogaShell: { name: "x" } }]) {
    g.window = win;
    assert.deepEqual(await discard("chat-3"), {
      ok: false,
      err: "unsupported",
    });
  }

  g.window = {
    get slogaShell() {
      throw new Error("preload torn down");
    },
  };
  const direct = await loadDiscard();
  let result: unknown;
  assert.doesNotThrow(() => {
    result = direct("chat-3");
  });
  assert.deepEqual(await result, { ok: false, err: "preload torn down" });
});

let fresh = 0;

/** A copy of the module with its own probe cache. */
async function freshShell(): Promise<typeof ChatShell> {
  fresh += 1;
  return (await import(`./chatShell.ts?probe=${fresh}`)) as typeof ChatShell;
}

test("probe, electron: the preload's arm decides, with no IPC", async () => {
  const electron = fakeElectron(() => Promise.resolve({ ok: true }));
  g.window = { slogaShell: { chatWindows: electron.bridge } };
  const shell = await freshShell();

  assert.equal(shell.chatWindowsAvailable(), undefined);
  const first = shell.probeChatWindows();
  const second = shell.probeChatWindows();
  assert.equal(first, second);
  assert.equal(await first, true);
  assert.equal(shell.chatWindowsAvailable(), true);
  assert.equal(shell.probeChatWindows(), first);
  assert.equal(electron.calls.length, 0);
});

test("probe, electron: no usable arm, no shell, or a throw, is false", async () => {
  const windows = [
    undefined,
    {},
    { __TAURI__: {} },
    { slogaShell: {} },
    { slogaShell: { chatWindows: {} } },
    { slogaShell: { chatWindows: { arm: "yes", focusMain: () => {} } } },
    {
      get slogaShell() {
        throw new Error("preload torn down");
      },
    },
  ];
  for (const [index, win] of windows.entries()) {
    if (win === undefined) delete g.window;
    else g.window = win;
    const shell = await freshShell();
    assert.equal(await shell.probeChatWindows(), false, String(index));
    assert.equal(shell.chatWindowsAvailable(), false);
  }
});

test("probe, tauri: one chat_window_probe shared by every caller", async () => {
  let settle!: (value: unknown) => void;
  const tauri = fakeTauri(() => new Promise((resolve) => (settle = resolve)));
  g.window = { __TAURI__: tauri.global };
  const shell = await freshShell();

  const callers = [
    shell.probeChatWindows(),
    shell.probeChatWindows(),
    shell.probeChatWindows(),
  ];
  // Let the probe reach the bridge before answering.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(shell.chatWindowsAvailable(), undefined);
  settle(null);
  assert.deepEqual(await Promise.all(callers), [true, true, true]);
  assert.equal(shell.chatWindowsAvailable(), true);
  await shell.probeChatWindows();
  // The probe runs at boot, so it must never raise the main window.
  assert.deepEqual(tauri.calls, [
    { cmd: "chat_window_probe", args: undefined },
  ]);
  assert.ok(!tauri.calls.some((c) => c.cmd === "chat_window_focus_main"));
});

test("probe, tauri: a refusal or a throw caches false for the session", async () => {
  const answers: (() => unknown)[] = [
    // An older shell without the command, and an ACL refusal.
    () => Promise.reject("command chat_window_probe not found"),
    () =>
      Promise.reject(
        "chat_window_probe not allowed. Command not found in any capability",
      ),
    () => Promise.reject(new Error("not main")),
    () => {
      throw new Error("sync");
    },
  ];
  for (const answer of answers) {
    const tauri = fakeTauri(answer);
    g.window = { __TAURI__: tauri.global };
    const shell = await freshShell();
    assert.equal(await shell.probeChatWindows(), false);
    assert.equal(shell.chatWindowsAvailable(), false);

    // A shell that would now answer is not asked again.
    const working = fakeTauri(() => Promise.resolve(null));
    g.window = { __TAURI__: working.global };
    assert.equal(await shell.probeChatWindows(), false);
    assert.equal(tauri.calls.length, 1);
    assert.equal(working.calls.length, 0);
  }
});

test("probe: tauri is preferred when both bridges are present", async () => {
  const tauri = fakeTauri(() => Promise.reject("no such command"));
  const electron = fakeElectron(() => Promise.resolve({ ok: true }));
  g.window = {
    __TAURI__: tauri.global,
    slogaShell: { chatWindows: electron.bridge },
  };
  const shell = await freshShell();
  assert.equal(await shell.probeChatWindows(), false);
  assert.equal(tauri.calls.length, 1);
  assert.equal(electron.calls.length, 0);
});

test("probe: chatWindowsAvailable is reactive", async () => {
  g.window = {
    slogaShell: { chatWindows: fakeElectron(() => undefined).bridge },
  };
  const shell = await freshShell();
  const seen: (boolean | undefined)[] = [];
  const dispose = createRoot((dispose) => {
    createComputed(() => seen.push(shell.chatWindowsAvailable()));
    return dispose;
  });
  await shell.probeChatWindows();
  dispose();
  assert.deepEqual(seen, [undefined, true]);
});

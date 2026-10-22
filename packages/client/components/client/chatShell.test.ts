// Unit spec for the chat-window shell bridge. Run with Node's built-in runner
// from packages/client:
//   node --test --conditions=browser components/client/chatShell.test.ts
// Declared test count: 36 (the runner also exits 0 when it finds no tests at
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
//
// Frameless title bars (plan C1, C2, C3, C5, C6, audit M1): the Tauri arm
// carries `frameless: true` only after a probe that answered exactly a plain
// object with `frameless === true`, and reports `buttons` then. The arm runs
// that probe itself when it is the first caller (Wave 1 audit MINOR-2), so
// the opt-in never depends on who probed first; the Electron
// arm always passes `{ frame: "custom" }` and reports `inset` only for that
// reply (an older preload answers without `frame`: `native`).
// `minimize` / `toggleMaximize` are Tauri-only and never reject.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createComputed, createRoot } from "solid-js";

import type * as ChatShell from "./chatShell.ts";
import { arm, focusMain, saveBounds, supported } from "./chatShell.ts";

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
      bounds: verb("bounds"),
      focusMain: verb("focusMain"),
    },
  };
}

let fresh = 0;

/** A copy of the module with its own probe cache. */
async function freshShell(): Promise<typeof ChatShell> {
  fresh += 1;
  return (await import(`./chatShell.ts?probe=${fresh}`)) as typeof ChatShell;
}

async function allThree() {
  return [await arm("chat"), await saveBounds("chat-1"), await focusMain()];
}

test("no shell: unsupported everywhere, never a rejection", async () => {
  assert.equal(supported(), false);
  for (const result of await allThree()) {
    assert.deepEqual(result, { ok: false, err: "unsupported" });
  }

  // A window with no shell globals, and a Tauri global without a usable
  // invoke (no capability file), read the same.
  for (const win of [{}, { __TAURI__: {} }, { slogaShell: { name: "x" } }]) {
    g.window = win;
    assert.equal(supported(), false);
    for (const result of await allThree()) {
      assert.deepEqual(result, { ok: false, err: "unsupported" });
    }
  }
});

test("tauri: exact commands and args, label passed through", async () => {
  const tauri = fakeTauri((cmd) =>
    Promise.resolve(cmd === "chat_window_arm" ? "chat-7" : null),
  );
  g.window = { __TAURI__: tauri.global };
  // A copy with no cached probe, so the probe call below is this test's.
  const shell = await freshShell();
  assert.equal(shell.supported(), true);

  // The first arm runs the probe itself; an older shell's `null` answer
  // does not opt in.
  assert.deepEqual(await shell.arm("friends"), {
    ok: true,
    label: "chat-7",
    frame: "native",
  });
  assert.deepEqual(await shell.saveBounds("chat-7"), { ok: true });
  assert.deepEqual(await shell.focusMain(), { ok: true });
  assert.deepEqual(tauri.calls, [
    { cmd: "chat_window_probe", args: undefined },
    { cmd: "chat_window_arm", args: { kind: "friends" } },
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
    for (const result of await allThree()) {
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
  await allThree();
  // The arm may run the probe first (once per module), also on Tauri.
  const cmds = tauri.calls.map((c) => c.cmd);
  assert.deepEqual(
    cmds.filter((cmd) => cmd !== "chat_window_probe"),
    ["chat_window_arm", "chat_window_bounds", "chat_window_focus_main"],
  );
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
    frame: "native",
  });
  assert.deepEqual(await saveBounds("friends-window"), { ok: true });
  assert.deepEqual(await focusMain(), { ok: true });
  assert.deepEqual(electron.calls, [
    { verb: "arm", args: ["friends", { frame: "custom" }] },
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
  for (const result of await allThree()) {
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
    for (const result of await allThree()) {
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
  for (const result of await allThree()) {
    assert.deepEqual(result, { ok: false, err: "ipc down" });
  }

  g.window = {
    slogaShell: {
      chatWindows: fakeElectron(() => {
        throw "sync";
      }).bridge,
    },
  };
  for (const result of await allThree()) {
    assert.deepEqual(result, { ok: false, err: "sync" });
  }

  // An older preload with only some verbs: the rest are unsupported.
  const partial = fakeElectron(() => Promise.resolve({ ok: true }));
  g.window = {
    slogaShell: { chatWindows: { focusMain: partial.bridge.focusMain } },
  };
  assert.equal(supported(), true);
  assert.deepEqual(await arm("chat"), { ok: false, err: "unsupported" });
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

/** `closeWindow`, looked up on the module for the same reason as `discard`. */
async function loadCloseWindow(): Promise<Discard> {
  const shell = (await import("./chatShell.ts")) as { closeWindow?: Discard };
  assert.equal(typeof shell.closeWindow, "function", "no closeWindow");
  return shell.closeWindow!;
}

async function closeWindow(label: string): Promise<unknown> {
  return (await loadCloseWindow())(label);
}

test("closeWindow, tauri: saves the bounds, then destroys by label", async () => {
  const tauri = fakeTauri(() => Promise.resolve(null));
  g.window = { __TAURI__: tauri.global };
  assert.deepEqual(await closeWindow("chat-4"), { ok: true });
  assert.deepEqual(tauri.calls, [
    { cmd: "chat_window_bounds", args: { label: "chat-4" } },
    { cmd: "chat_window_discard", args: { label: "chat-4" } },
  ]);
});

test("closeWindow, tauri: a failed save still destroys; the destroy's answer comes back", async () => {
  const saveFails = fakeTauri((cmd) =>
    cmd === "chat_window_bounds"
      ? Promise.reject("no such window")
      : Promise.resolve(null),
  );
  g.window = { __TAURI__: saveFails.global };
  assert.deepEqual(await closeWindow("friends-window"), { ok: true });
  assert.deepEqual(
    saveFails.calls.map((c) => c.cmd),
    ["chat_window_bounds", "chat_window_discard"],
  );

  const syncThrow = fakeTauri((cmd) => {
    if (cmd === "chat_window_bounds") throw new Error("sync");
    return Promise.reject("not a chat window");
  });
  g.window = { __TAURI__: syncThrow.global };
  assert.deepEqual(await closeWindow("chat-4"), {
    ok: false,
    err: "not a chat window",
  });
  assert.equal(syncThrow.calls.length, 2);
});

test("closeWindow, electron: ok without a round trip; tauri preferred", async () => {
  const electron = fakeElectron(() => Promise.reject(new Error("called")));
  g.window = { slogaShell: { chatWindows: electron.bridge } };
  assert.deepEqual(await closeWindow("chat-4"), { ok: true });
  assert.equal(electron.calls.length, 0);

  const tauri = fakeTauri(() => Promise.resolve(null));
  g.window = {
    __TAURI__: tauri.global,
    slogaShell: { chatWindows: electron.bridge },
  };
  assert.deepEqual(await closeWindow("chat-4"), { ok: true });
  assert.equal(tauri.calls.length, 2);
  assert.equal(electron.calls.length, 0);
});

test("closeWindow, no shell: unsupported; a throwing global never escapes", async () => {
  for (const win of [undefined, {}, { __TAURI__: {} }, { slogaShell: {} }]) {
    if (win === undefined) delete g.window;
    else g.window = win;
    assert.deepEqual(await closeWindow("chat-4"), {
      ok: false,
      err: "unsupported",
    });
  }

  g.window = {
    get slogaShell() {
      throw new Error("preload torn down");
    },
  };
  const direct = await loadCloseWindow();
  let result: unknown;
  assert.doesNotThrow(() => {
    result = direct("chat-4");
  });
  assert.deepEqual(await result, { ok: false, err: "preload torn down" });
});

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

/* Frameless title bars ---------------------------------------------------- */

type Verbs = {
  minimize?: (label: string) => Promise<unknown>;
  toggleMaximize?: (label: string) => Promise<unknown>;
  isFramelessProbeAnswer?: (answer: unknown) => boolean;
};

/**
 * A verb looked up on the (same, cached) module, like `discard`: a module
 * without it still loads, and only the specs that need it fail.
 */
async function verb<K extends keyof Verbs>(
  name: K,
): Promise<NonNullable<Verbs[K]>> {
  const shell = (await import("./chatShell.ts")) as Verbs;
  assert.equal(typeof shell[name], "function", `chatShell has no ${name}`);
  return shell[name]!;
}

class FramelessAnswer {
  frameless = true;
}

/** Probe answers, and whether each one opts the arm in (audit M1). */
const PROBE_ANSWERS: [string, unknown, boolean][] = [
  ["the new shell", { frameless: true }, true],
  ["the new shell, a later key added", { frameless: true, snap: true }, true],
  ["parsed wire JSON", JSON.parse('{"frameless":true}'), true],
  [
    "a null-prototype object",
    Object.assign(Object.create(null), { frameless: true }),
    true,
  ],
  ["an older shell (unit)", null, false],
  ["undefined", undefined, false],
  ["empty object", {}, false],
  ["frameless false (macOS / Linux build)", { frameless: false }, false],
  ['frameless "true"', { frameless: "true" }, false],
  ["frameless 1", { frameless: 1 }, false],
  ["frameless null", { frameless: null }, false],
  ["a string", "x", false],
  ['the string "frameless"', "frameless", false],
  ["true", true, false],
  ["a number", 1, false],
  ["an array", [true], false],
  ["an array carrying the key", Object.assign([], { frameless: true }), false],
  ["inherited frameless", Object.create({ frameless: true }), false],
  ["a class instance", new FramelessAnswer(), false],
  ["a function", Object.assign(() => 1, { frameless: true }), false],
];

test("probe answer: only a plain object whose own frameless is true opts in", async () => {
  const isFrameless = await verb("isFramelessProbeAnswer");
  for (const [name, answer, expected] of PROBE_ANSWERS) {
    assert.equal(isFrameless(answer), expected, name);
  }
});

test("arm, tauri: the probe answer decides the opt-in; exact invoke args both ways", async () => {
  for (const [name, answer, frameless] of PROBE_ANSWERS) {
    const tauri = fakeTauri((cmd) =>
      Promise.resolve(cmd === "chat_window_probe" ? answer : "chat-9"),
    );
    g.window = { __TAURI__: tauri.global };
    const shell = await freshShell();
    // Any answer at all means the shell has the commands.
    assert.equal(await shell.probeChatWindows(), true, name);

    assert.deepEqual(
      await shell.arm("chat"),
      { ok: true, label: "chat-9", frame: frameless ? "buttons" : "native" },
      name,
    );
    assert.deepEqual(
      tauri.calls,
      [
        { cmd: "chat_window_probe", args: undefined },
        {
          cmd: "chat_window_arm",
          args: frameless
            ? { kind: "chat", frameless: true }
            : { kind: "chat" },
        },
      ],
      name,
    );
  }
});

test("arm, tauri: a first arm probes itself and opts in on { frameless: true }", async () => {
  // Nobody has probed this module copy; the arm is the first call.
  const tauri = fakeTauri((cmd) =>
    Promise.resolve(
      cmd === "chat_window_probe" ? { frameless: true } : "chat-8",
    ),
  );
  g.window = { __TAURI__: tauri.global };
  const shell = await freshShell();
  assert.deepEqual(await shell.arm("chat"), {
    ok: true,
    label: "chat-8",
    frame: "buttons",
  });
  assert.deepEqual(tauri.calls, [
    { cmd: "chat_window_probe", args: undefined },
    { cmd: "chat_window_arm", args: { kind: "chat", frameless: true } },
  ]);
  // The arm's probe is the cached one: no second probe, by a later arm or a
  // later caller, and its answer is published.
  assert.equal(shell.chatWindowsAvailable(), true);
  assert.equal(await shell.probeChatWindows(), true);
  assert.deepEqual(await shell.arm("friends"), {
    ok: true,
    label: "chat-8",
    frame: "buttons",
  });
  assert.deepEqual(
    tauri.calls.map((c) => c.cmd),
    ["chat_window_probe", "chat_window_arm", "chat_window_arm"],
  );
});

test("arm, tauri: an older shell's probe, or a failed one, never opts in", async () => {
  // An older shell answers the probe `null`; the arm the probe ran for is
  // plain.
  const older = fakeTauri((cmd) =>
    Promise.resolve(cmd === "chat_window_probe" ? null : "chat-2"),
  );
  g.window = { __TAURI__: older.global };
  let shell = await freshShell();
  assert.deepEqual(await shell.arm("friends"), {
    ok: true,
    label: "chat-2",
    frame: "native",
  });
  assert.deepEqual(older.calls, [
    { cmd: "chat_window_probe", args: undefined },
    { cmd: "chat_window_arm", args: { kind: "friends" } },
  ]);

  // A probe that failed reads as unavailable; an arm made anyway is plain.
  const failed = fakeTauri((cmd) =>
    cmd === "chat_window_probe"
      ? Promise.reject("command chat_window_probe not found")
      : Promise.resolve("chat-3"),
  );
  g.window = { __TAURI__: failed.global };
  shell = await freshShell();
  assert.equal(await shell.probeChatWindows(), false);
  assert.deepEqual(await shell.arm("chat"), {
    ok: true,
    label: "chat-3",
    frame: "native",
  });
  assert.deepEqual(failed.calls[1], {
    cmd: "chat_window_arm",
    args: { kind: "chat" },
  });
});

test("arm, tauri: waits for a probe still in flight", async () => {
  let settle!: (value: unknown) => void;
  const tauri = fakeTauri((cmd) =>
    cmd === "chat_window_probe"
      ? new Promise((resolve) => (settle = resolve))
      : Promise.resolve("chat-5"),
  );
  g.window = { __TAURI__: tauri.global };
  const shell = await freshShell();
  void shell.probeChatWindows();
  const armed = shell.arm("chat");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    tauri.calls.map((c) => c.cmd),
    ["chat_window_probe"],
    "armed before the probe answered",
  );
  settle({ frameless: true });
  assert.deepEqual(await armed, {
    ok: true,
    label: "chat-5",
    frame: "buttons",
  });
  assert.deepEqual(tauri.calls[1], {
    cmd: "chat_window_arm",
    args: { kind: "chat", frameless: true },
  });
});

test("arm, tauri: an opted-in arm still reports refusals and bad labels", async () => {
  const cases: [() => Promise<unknown>, unknown][] = [
    [() => Promise.reject("exists"), { ok: false, err: "exists" }],
    [() => Promise.reject(undefined), { ok: false, err: "failed" }],
    [() => Promise.resolve(""), { ok: false, err: "invalid" }],
    [() => Promise.resolve(null), { ok: false, err: "invalid" }],
    [() => Promise.resolve({ label: "chat-1" }), { ok: false, err: "invalid" }],
  ];
  for (const [answer, expected] of cases) {
    const tauri = fakeTauri((cmd) =>
      cmd === "chat_window_probe"
        ? Promise.resolve({ frameless: true })
        : answer(),
    );
    g.window = { __TAURI__: tauri.global };
    const shell = await freshShell();
    await shell.probeChatWindows();
    assert.deepEqual(await shell.arm("chat"), expected);
    assert.deepEqual(tauri.calls[1].args, { kind: "chat", frameless: true });
  }
});

test("arm, electron: asks for a custom frame; only an inset reply is inset", async () => {
  const replies: [unknown, string][] = [
    ["inset", "inset"],
    ["native", "native"],
    // An older preload drops the option and answers without `frame`.
    [undefined, "native"],
    // Electron never builds a frameless window with its own buttons.
    ["buttons", "native"],
    ["INSET", "native"],
    [" inset", "native"],
    [null, "native"],
    [1, "native"],
    [{ frame: "inset" }, "native"],
  ];
  for (const [frame, expected] of replies) {
    const electron = fakeElectron(() =>
      Promise.resolve(
        frame === undefined
          ? { ok: true, label: "chat-4" }
          : { ok: true, label: "chat-4", frame },
      ),
    );
    g.window = { slogaShell: { chatWindows: electron.bridge } };
    assert.deepEqual(
      await arm("chat"),
      { ok: true, label: "chat-4", frame: expected },
      String(frame),
    );
    assert.deepEqual(electron.calls, [
      { verb: "arm", args: ["chat", { frame: "custom" }] },
    ]);
  }

  // A fresh options object each time: the preload cannot keep and edit one.
  const electron = fakeElectron(() =>
    Promise.resolve({ ok: true, label: "chat-4" }),
  );
  g.window = { slogaShell: { chatWindows: electron.bridge } };
  await arm("chat");
  await arm("friends");
  assert.notEqual(electron.calls[0].args[1], electron.calls[1].args[1]);
});

test("arm, electron: a refusal or a malformed envelope ignores frame", async () => {
  const invalid = { ok: false, err: "invalid" };
  const cases: [unknown, unknown][] = [
    [
      { ok: false, err: "exists", frame: "inset" },
      { ok: false, err: "exists" },
    ],
    [{ ok: true, frame: "inset" }, invalid],
    [{ ok: true, label: "", frame: "inset" }, invalid],
    [{ ok: "true", label: "chat-1", frame: "inset" }, invalid],
    [{ frame: "inset" }, invalid],
    ["inset", invalid],
    [null, invalid],
  ];
  for (const [envelope, expected] of cases) {
    g.window = {
      slogaShell: {
        chatWindows: fakeElectron(() => Promise.resolve(envelope)).bridge,
      },
    };
    assert.deepEqual(await arm("chat"), expected, JSON.stringify(envelope));
  }
});

test("arm: a throwing global never escapes", async () => {
  const throwing = [
    {
      get slogaShell() {
        throw new Error("preload torn down");
      },
    },
    {
      get __TAURI__() {
        throw new Error("tauri torn down");
      },
    },
  ];
  const errs: unknown[] = [];
  for (const win of throwing) {
    g.window = win;
    let result: unknown;
    assert.doesNotThrow(() => {
      result = arm("chat");
    });
    errs.push(await result);
  }
  assert.deepEqual(errs, [
    { ok: false, err: "preload torn down" },
    { ok: false, err: "tauri torn down" },
  ]);
});

test("minimize, tauri: chat_window_minimize with the label, envelope back", async () => {
  const minimize = await verb("minimize");
  const tauri = fakeTauri(() => Promise.resolve(null));
  g.window = { __TAURI__: tauri.global };
  assert.deepEqual(await minimize("chat-3"), { ok: true });
  assert.deepEqual(await minimize("friends-window"), { ok: true });
  assert.deepEqual(tauri.calls, [
    { cmd: "chat_window_minimize", args: { label: "chat-3" } },
    { cmd: "chat_window_minimize", args: { label: "friends-window" } },
  ]);
});

test("toggleMaximize, tauri: the new state comes back; a non-boolean is invalid", async () => {
  const toggleMaximize = await verb("toggleMaximize");
  for (const state of [true, false]) {
    const tauri = fakeTauri(() => Promise.resolve(state));
    g.window = { __TAURI__: tauri.global };
    assert.deepEqual(await toggleMaximize("chat-3"), {
      ok: true,
      maximized: state,
    });
    assert.deepEqual(tauri.calls, [
      { cmd: "chat_window_toggle_maximize", args: { label: "chat-3" } },
    ]);
  }
  const bad = [null, undefined, "true", 1, 0, {}, { maximized: true }, [true]];
  for (const answer of bad) {
    g.window = { __TAURI__: fakeTauri(() => Promise.resolve(answer)).global };
    assert.deepEqual(
      await toggleMaximize("chat-3"),
      { ok: false, err: "invalid" },
      JSON.stringify(answer) ?? String(answer),
    );
  }
});

test("minimize and toggleMaximize: electron and no shell are unsupported, no calls", async () => {
  const minimize = await verb("minimize");
  const toggleMaximize = await verb("toggleMaximize");
  const unsupported = { ok: false, err: "unsupported" };
  const electron = fakeElectron(() => Promise.resolve({ ok: true }));
  const windows = [
    undefined,
    {},
    { __TAURI__: {} },
    { slogaShell: { name: "x" } },
    { slogaShell: { chatWindows: electron.bridge } },
  ];
  for (const win of windows) {
    if (win === undefined) delete g.window;
    else g.window = win;
    assert.deepEqual(await minimize("chat-1"), unsupported);
    assert.deepEqual(await toggleMaximize("chat-1"), unsupported);
  }
  assert.equal(electron.calls.length, 0);

  // Tauri wins when both bridges are present.
  const tauri = fakeTauri(() => Promise.resolve(true));
  g.window = {
    __TAURI__: tauri.global,
    slogaShell: { chatWindows: electron.bridge },
  };
  assert.deepEqual(await minimize("chat-1"), { ok: true });
  assert.deepEqual(await toggleMaximize("chat-1"), {
    ok: true,
    maximized: true,
  });
  assert.equal(tauri.calls.length, 2);
  assert.equal(electron.calls.length, 0);
});

test("minimize and toggleMaximize: rejections and throws never escape", async () => {
  const minimize = await verb("minimize");
  const toggleMaximize = await verb("toggleMaximize");
  const cases: [() => unknown, string][] = [
    [() => Promise.reject("no such window"), "no such window"],
    [() => Promise.reject(new Error("not main")), "not main"],
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
    assert.deepEqual(await minimize("chat-1"), { ok: false, err });
    assert.deepEqual(await toggleMaximize("chat-1"), { ok: false, err });
  }

  g.window = {
    get __TAURI__() {
      throw new Error("tauri torn down");
    },
  };
  for (const fn of [minimize, toggleMaximize]) {
    let result: unknown;
    assert.doesNotThrow(() => {
      result = fn("chat-1");
    });
    assert.deepEqual(await result, { ok: false, err: "tauri torn down" });
  }
});

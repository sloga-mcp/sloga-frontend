// Unit spec for the main window's title bar bridge. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/client/mainShell.test.ts
// Declared test count: 23 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus (main-titlebar plan M3, M5, M10, C1-C5, C8, C9): the page draws its
// bar only on a claim answer of EXACTLY `{ frameless: true, maximized }`
// (Tauri) or `slogaShell.windowFrame.main === "inset"` (Electron); anything
// else, any rejection or throw, is `native`, and `probe` never rejects. A
// revoke (the shell's push, or a failing call while the bar is drawn) makes
// main `native` for the rest of the page, wins over a claim still in flight,
// and a failure-driven one asks the shell to release the frame; a failing
// claim never does (there was no frame to give back). Maximized comes only
// from the shell (claim, toggle reply, state pull) and an older answer never
// overwrites a newer one. The Electron `windowFrameState` pushes are
// validated exactly, routed per label into chatWindowFrame's fullscreen map,
// shared by every holder through one shell subscription, and win over the
// seeding pull of main's state.
//
// The module keeps state for the page's life, so each test loads a fresh
// copy (`fresh`, a query-string import Node keys as a new module). The fake
// `window` is installed on globalThis per test: the module reads it on every
// call. chatWindowFrame is shared by every copy, so its labels are reset
// after each test.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createComputed, createRoot } from "solid-js";

import * as frame from "../chatWindows/chatWindowFrame.ts";

import type * as MainShell from "./mainShell.ts";

type Call = { cmd: string; args: unknown };

const g = globalThis as { window?: unknown };
const RESET_LABELS = ["main", "chat-1", "chat-2", "friends-window"];

let warnings: unknown[][] = [];
const realWarn = console.warn;

beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]) => void warnings.push(args);
});

afterEach(() => {
  console.warn = realWarn;
  delete g.window;
  for (const label of RESET_LABELS) frame.forgetWindow(label);
});

let copies = 0;

/** A copy of the module with its own state. */
async function fresh(): Promise<typeof MainShell> {
  copies += 1;
  return (await import(`./mainShell.ts?copy=${copies}`)) as typeof MainShell;
}

/** Let every pending promise chain (and fire-and-forget call) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A Tauri window whose invoke answers through `answer`, recording calls. */
function tauri(answer: (cmd: string, args: unknown) => unknown): Call[] {
  const calls: Call[] = [];
  g.window = {
    __TAURI__: {
      core: {
        invoke: (cmd: string, args?: unknown) => {
          calls.push({ cmd, args });
          return answer(cmd, args);
        },
      },
    },
  };
  return calls;
}

/** A Tauri shell that built main frameless, otherwise answering `rest`. */
function framelessTauri(
  rest: (cmd: string, args: unknown) => unknown = () => Promise.resolve(null),
  maximized = false,
): Call[] {
  return tauri((cmd, args) =>
    cmd === "main_window_claim_frame"
      ? Promise.resolve({ frameless: true, maximized })
      : rest(cmd, args),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Every value `read` yields, starting with the current one, until disposed. */
function watch<T>(read: () => T): { seen: T[]; dispose: () => void } {
  const seen: T[] = [];
  const dispose = createRoot((dispose) => {
    createComputed(() => seen.push(read()));
    return dispose;
  });
  return { seen, dispose };
}

const cmds = (calls: Call[]) => calls.map((call) => call.cmd);

/** `seen` without consecutive repeats. */
function distinct<T>(seen: T[]): T[] {
  return seen.filter(
    (value, i) =>
      i === 0 || JSON.stringify(value) !== JSON.stringify(seen[i - 1]),
  );
}

/* ------------------------------------------------------------------------ */

test("parseClaimAnswer: exactly { frameless, maximized }, both booleans", async () => {
  const { parseClaimAnswer: parse } = await fresh();
  assert.deepEqual(parse({ frameless: true, maximized: false }), {
    frameless: true,
    maximized: false,
  });
  assert.deepEqual(parse({ maximized: true, frameless: false }), {
    frameless: false,
    maximized: true,
  });
  assert.deepEqual(
    parse(JSON.parse('{"frameless":true,"maximized":true}')),
    { frameless: true, maximized: true },
    "the wire JSON",
  );
  const bare = Object.assign(Object.create(null), {
    frameless: true,
    maximized: false,
  });
  assert.deepEqual(parse(bare), { frameless: true, maximized: false });

  for (const bad of [
    { frameless: true, maximized: false, x: 1 },
    { frameless: true, maximized: false, extra: undefined },
    { frameless: true },
    { maximized: false },
    {},
    { frameless: "true", maximized: false },
    { frameless: 1, maximized: false },
    { frameless: true, maximized: null },
    { frameless: true, maximized: "false" },
    JSON.parse('{"frameless":true,"maximized":false,"__proto__":{"x":1}}'),
    Object.assign(Object.create({ maximized: false }), { frameless: true }),
    Object.assign(Object.create({ inherited: 1 }), {
      frameless: true,
      maximized: false,
    }),
    [true, false],
    null,
    undefined,
    true,
    "frameless",
    1,
  ])
    assert.equal(parse(bad), null, JSON.stringify(bad) ?? String(bad));
});

test("parseStateAnswer, parseFrameStateReply: exact shapes only", async () => {
  const shell = await fresh();
  assert.equal(shell.parseStateAnswer({ maximized: true }), true);
  assert.equal(shell.parseStateAnswer({ maximized: false }), false);
  for (const bad of [
    { maximized: true, fullscreen: false },
    { maximized: "true" },
    { maximized: 1 },
    {},
    null,
    true,
    [true],
  ])
    assert.equal(shell.parseStateAnswer(bad), null, JSON.stringify(bad));

  assert.equal(
    shell.parseFrameStateReply({ ok: true, fullscreen: true }),
    true,
  );
  assert.equal(
    shell.parseFrameStateReply({ ok: true, fullscreen: false }),
    false,
  );
  for (const bad of [
    { ok: false, err: "unsupported" },
    { ok: true },
    { ok: true, fullscreen: "true" },
    { ok: "true", fullscreen: true },
    { ok: false, fullscreen: true },
    { ok: true, fullscreen: true, label: "main" },
    null,
    undefined,
    true,
  ])
    assert.equal(
      shell.parseFrameStateReply(bad),
      null,
      JSON.stringify(bad) ?? String(bad),
    );
});

test("isWindowFrameState: the exact push, main or a chat window label", async () => {
  const { isWindowFrameState: ok, isFrameLabel } = await fresh();
  const push = (o: Record<string, unknown> = {}) => ({
    kind: "windowFrameState",
    label: "main",
    fullscreen: true,
    ...o,
  });
  for (const label of ["main", "friends-window", "chat-1", "chat-42"])
    for (const fullscreen of [true, false]) {
      assert.equal(ok(push({ label, fullscreen })), true, label);
      assert.equal(isFrameLabel(label), true, label);
    }
  assert.equal(
    ok(
      JSON.parse(
        '{"kind":"windowFrameState","label":"chat-3","fullscreen":false}',
      ),
    ),
    true,
  );
  for (const label of [
    "Main",
    "main ",
    "MAIN",
    "",
    "voice-overlay",
    "chat-",
    "chat-a",
    "friends",
    "main-window",
    undefined,
    null,
    1,
    ["main"],
  ]) {
    assert.equal(ok(push({ label })), false, String(label));
    assert.equal(isFrameLabel(label), false, String(label));
  }
  for (const bad of [
    push({ fullscreen: "true" }),
    push({ fullscreen: 1 }),
    push({ fullscreen: null }),
    push({ kind: "chatWindowState" }),
    push({ kind: "windowframestate" }),
    push({ extra: 1 }),
    push({ maximized: true }),
    { kind: "windowFrameState", label: "main" },
    { label: "main", fullscreen: true },
    JSON.parse(
      '{"kind":"windowFrameState","label":"main","fullscreen":true,"__proto__":{}}',
    ),
    Object.assign(Object.create({ fullscreen: true }), {
      kind: "windowFrameState",
      label: "main",
    }),
    null,
    undefined,
    "windowFrameState",
    [push()],
  ])
    assert.equal(ok(bad), false, JSON.stringify(bad) ?? String(bad));
});

test("probe: no shell, web, or a Tauri global without invoke is native", async () => {
  for (const win of [
    undefined,
    {},
    { __TAURI__: {} },
    { __TAURI__: { core: {} } },
    { slogaShell: { name: "x" } },
  ]) {
    if (win === undefined) delete g.window;
    else g.window = win;
    const shell = await fresh();
    assert.equal(await shell.probe(), "native", JSON.stringify(win));
    assert.equal(shell.mainFrame(), "native");
    assert.equal(shell.mainFrameRevoked(), false);
    assert.equal(await shell.systemFrame(), null);
  }
});

test("probe (Tauri): buttons only on exactly { frameless: true, maximized }", async () => {
  const calls = framelessTauri(undefined, true);
  const shell = await fresh();
  assert.equal(await shell.probe(), "buttons");
  assert.equal(shell.mainFrame(), "buttons");
  assert.equal(shell.mainMaximized(), true, "maximized not seeded");
  assert.equal(shell.mainFrameRevoked(), false);
  // Exactly the claim, with no arguments, once however many ask.
  assert.equal(await shell.probe(), "buttons");
  assert.deepEqual(calls, [
    { cmd: "main_window_claim_frame", args: undefined },
  ]);
});

test("probe (Tauri): a claim answer with an extra key is native, never buttons", async () => {
  const calls = tauri(() =>
    Promise.resolve({ frameless: true, maximized: false, x: 1 }),
  );
  const shell = await fresh();
  assert.equal(await shell.probe(), "native");
  assert.equal(shell.mainFrame(), "native");
  await flush();
  // No frame was ever drawn, so there is nothing to release.
  assert.deepEqual(cmds(calls), ["main_window_claim_frame"]);
});

test("probe (Tauri): every other answer, rejection or throw is native", async () => {
  const answers: [string, () => unknown, boolean][] = [
    // [why, answer, counts as a failure (revoked)]
    [
      "frameless false",
      () => Promise.resolve({ frameless: false, maximized: false }),
      false,
    ],
    [
      "older shell: command not found",
      () => Promise.reject("command main_window_claim_frame not found"),
      true,
    ],
    [
      "ACL refused",
      () => Promise.reject(new Error("not allowed by ACL")),
      true,
    ],
    [
      "synchronous throw",
      () => {
        throw new Error("boom");
      },
      true,
    ],
    ["null", () => Promise.resolve(null), true],
    ["frameless only", () => Promise.resolve({ frameless: true }), true],
    ["string", () => Promise.resolve("buttons"), true],
    ["true", () => Promise.resolve(true), true],
  ];
  for (const [why, answer, failure] of answers) {
    const calls = tauri(answer);
    const shell = await fresh();
    assert.equal(await shell.probe(), "native", why);
    assert.equal(shell.mainFrameRevoked(), failure, why);
    assert.equal(shell.mainMaximized(), false, why);
    await flush();
    assert.deepEqual(cmds(calls), ["main_window_claim_frame"], why);
  }
});

test('probe (Electron): inset only for windowFrame.main === "inset"', async () => {
  g.window = { slogaShell: { windowFrame: { main: "inset" } } };
  let shell = await fresh();
  assert.equal(await shell.probe(), "inset");
  assert.equal(shell.mainFrame(), "inset");

  const throwing = {};
  Object.defineProperty(throwing, "main", {
    get() {
      throw new Error("broken preload");
    },
  });
  for (const windowFrame of [
    { main: "native" },
    { main: "Inset" },
    { main: "inset " },
    { main: true },
    { main: ["inset"] },
    {},
    null,
    "inset",
    undefined,
    throwing,
  ]) {
    g.window = { slogaShell: { windowFrame } };
    shell = await fresh();
    assert.equal(await shell.probe(), "native", String(windowFrame));
  }
  // No windowFrame at all: an older preload.
  g.window = { slogaShell: { name: "electron", chatWindows: {} } };
  shell = await fresh();
  assert.equal(await shell.probe(), "native");
});

test("probe: Tauri wins when both bridges are present", async () => {
  const calls = tauri(() =>
    Promise.resolve({ frameless: false, maximized: false }),
  );
  (g.window as Record<string, unknown>).slogaShell = {
    windowFrame: { main: "inset" },
  };
  const shell = await fresh();
  assert.equal(await shell.probe(), "native");
  assert.deepEqual(cmds(calls), ["main_window_claim_frame"]);
});

test("revoke: sticks for the page, reactively, whatever is asked after", async () => {
  const calls = framelessTauri();
  const shell = await fresh();
  const seen = watch(() => shell.mainFrame());
  assert.equal(await shell.probe(), "buttons");
  shell.noteRevoked();
  assert.equal(shell.mainFrame(), "native");
  assert.equal(shell.mainFrameRevoked(), true);
  // A later probe, toggle, pull or minimize changes nothing and calls nothing.
  assert.equal(await shell.probe(), "native");
  assert.equal(await shell.toggleMaximize(), false);
  assert.equal(await shell.refreshState(), false);
  assert.equal(await shell.minimize(), false);
  assert.equal(await shell.close(), false);
  shell.noteRevoked();
  assert.equal(shell.mainFrame(), "native");
  seen.dispose();
  assert.deepEqual(seen.seen, ["native", "buttons", "native"]);
  assert.deepEqual(cmds(calls), ["main_window_claim_frame"]);

  // Revoked before anyone probed: no claim is ever sent.
  const early = framelessTauri();
  const late = await fresh();
  late.noteRevoked();
  assert.equal(await late.probe(), "native");
  assert.deepEqual(early, []);
});

test("revoke: one that lands while the claim is in flight wins", async () => {
  const claim = deferred<unknown>();
  const calls = tauri(() => claim.promise);
  const shell = await fresh();
  const pending = shell.probe();
  // Really in flight: the claim has gone out and not been answered.
  await flush();
  assert.deepEqual(cmds(calls), ["main_window_claim_frame"]);
  shell.noteRevoked();
  claim.resolve({ frameless: true, maximized: true });
  assert.equal(await pending, "native");
  assert.equal(shell.mainFrame(), "native");
  assert.equal(shell.mainMaximized(), false);
});

test("toggleMaximize: the shell's new state, and only a boolean", async () => {
  const answers = [true, false];
  const calls = framelessTauri((cmd) =>
    cmd === "main_window_toggle_maximize"
      ? Promise.resolve(answers.shift())
      : Promise.resolve(null),
  );
  const shell = await fresh();
  await shell.probe();
  const seen = watch(() => shell.mainMaximized());
  assert.equal(await shell.toggleMaximize(), true);
  assert.equal(shell.mainMaximized(), true);
  assert.equal(await shell.toggleMaximize(), true);
  assert.equal(shell.mainMaximized(), false);
  seen.dispose();
  assert.deepEqual(seen.seen, [false, true, false]);
  assert.deepEqual(calls.slice(1), [
    { cmd: "main_window_toggle_maximize", args: undefined },
    { cmd: "main_window_toggle_maximize", args: undefined },
  ]);
});

test("a failing call while the bar is drawn revokes and releases the frame", async () => {
  const cases: [
    string,
    (shell: typeof MainShell) => Promise<boolean>,
    unknown,
  ][] = [
    ["main_window_toggle_maximize", (s) => s.toggleMaximize(), "maximized"],
    ["main_window_toggle_maximize", (s) => s.toggleMaximize(), null],
    ["main_window_state", (s) => s.refreshState(), { maximized: "yes" }],
    ["main_window_state", (s) => s.refreshState(), { maximized: true, x: 1 }],
    ["main_window_minimize", (s) => s.minimize(), true],
    ["main_window_close", (s) => s.close(), { ok: true }],
  ];
  for (const [cmd, act, bad] of cases) {
    for (const mode of ["reject", "garbled"] as const) {
      const calls = framelessTauri((called) =>
        called === cmd
          ? mode === "reject"
            ? Promise.reject(new Error("revoked"))
            : Promise.resolve(bad)
          : Promise.resolve(null),
      );
      const shell = await fresh();
      assert.equal(await shell.probe(), "buttons");
      assert.equal(await act(shell), false, `${cmd} ${mode}`);
      assert.equal(shell.mainFrame(), "native", `${cmd} ${mode}`);
      assert.equal(shell.mainFrameRevoked(), true, `${cmd} ${mode}`);
      await flush();
      assert.deepEqual(
        cmds(calls),
        ["main_window_claim_frame", cmd, "main_window_release_frame"],
        `${cmd} ${mode}`,
      );
    }
  }
});

test("refreshState: pulls main_window_state; an older answer never wins", async () => {
  const toggle = deferred<unknown>();
  const state = deferred<unknown>();
  const calls = framelessTauri((cmd) =>
    cmd === "main_window_toggle_maximize" ? toggle.promise : state.promise,
  );
  const shell = await fresh();
  await shell.probe();
  // Toggle sent first, then the resize pull; the pull answers first.
  const toggled = shell.toggleMaximize();
  const pulled = shell.refreshState();
  state.resolve({ maximized: false });
  assert.equal(await pulled, true);
  assert.equal(shell.mainMaximized(), false);
  toggle.resolve(true);
  assert.equal(await toggled, true);
  assert.equal(shell.mainMaximized(), false, "the older toggle reply won");
  assert.deepEqual(calls.slice(1), [
    { cmd: "main_window_toggle_maximize", args: undefined },
    { cmd: "main_window_state", args: undefined },
  ]);
});

test("refreshState: applies the pulled state; native frames pull nothing", async () => {
  const calls = framelessTauri(() => Promise.resolve({ maximized: true }));
  const shell = await fresh();
  await shell.probe();
  assert.equal(await shell.refreshState(), true);
  assert.equal(shell.mainMaximized(), true);
  assert.equal(shell.mainFrame(), "buttons");

  g.window = { slogaShell: { windowFrame: { main: "inset" } } };
  const inset = await fresh();
  await inset.probe();
  assert.equal(await inset.refreshState(), false);
  assert.equal(await inset.minimize(), false);
  assert.equal(inset.mainFrame(), "inset", "a no-op revoked an inset frame");
  assert.deepEqual(cmds(calls), [
    "main_window_claim_frame",
    "main_window_state",
  ]);
});

test("minimize and close: exact commands, no args, the bar stays", async () => {
  const calls = framelessTauri();
  const shell = await fresh();
  await shell.probe();
  assert.equal(await shell.minimize(), true);
  assert.equal(await shell.close(), true);
  assert.equal(shell.mainFrame(), "buttons");
  assert.deepEqual(calls.slice(1), [
    { cmd: "main_window_minimize", args: undefined },
    { cmd: "main_window_close", args: undefined },
  ]);
});

test("release: native once the shell confirms; a failed release keeps the bar", async () => {
  let calls = framelessTauri();
  let shell = await fresh();
  await shell.probe();
  assert.equal(await shell.release(), true);
  assert.equal(shell.mainFrame(), "native");
  assert.equal(shell.mainFrameRevoked(), true);
  assert.deepEqual(calls.slice(1), [
    { cmd: "main_window_release_frame", args: undefined },
  ]);

  calls = framelessTauri(() => Promise.reject(new Error("nope")));
  shell = await fresh();
  await shell.probe();
  assert.equal(await shell.release(), false);
  assert.equal(shell.mainFrame(), "buttons");
  assert.equal(shell.mainFrameRevoked(), false);
  assert.deepEqual(cmds(calls), [
    "main_window_claim_frame",
    "main_window_release_frame",
  ]);
});

test("systemFrame / setSystemFrame: booleans only; anything else is unsupported", async () => {
  const calls = tauri((cmd) =>
    cmd === "main_window_system_frame"
      ? Promise.resolve(true)
      : Promise.resolve(null),
  );
  let shell = await fresh();
  assert.equal(await shell.systemFrame(), true);
  assert.equal(await shell.setSystemFrame(false), true);
  assert.equal(await shell.setSystemFrame("yes" as unknown as boolean), false);
  assert.deepEqual(calls, [
    { cmd: "main_window_system_frame", args: undefined },
    { cmd: "main_window_set_system_frame", args: { on: false } },
  ]);
  // Neither touches the frame.
  assert.equal(shell.mainFrameRevoked(), false);

  for (const answer of [
    () => Promise.resolve("true"),
    () => Promise.resolve(null),
    () => Promise.resolve({ systemFrame: true }),
    () => Promise.reject(new Error("not allowed by ACL")),
    () => {
      throw new Error("boom");
    },
  ]) {
    tauri(answer);
    shell = await fresh();
    assert.equal(await shell.systemFrame(), null);
  }
  tauri(() => Promise.reject(new Error("not allowed by ACL")));
  shell = await fresh();
  assert.equal(await shell.setSystemFrame(true), false);
  tauri(() => Promise.resolve(false));
  shell = await fresh();
  assert.equal(await shell.setSystemFrame(true), false, "a non-null answer");

  g.window = { slogaShell: { windowFrame: { main: "inset" } } };
  shell = await fresh();
  assert.equal(await shell.systemFrame(), null);
  assert.equal(await shell.setSystemFrame(true), false);
});

test("watchResize: one pull after resize settles; the stop drops it", async (t) => {
  const calls = framelessTauri(() => Promise.resolve({ maximized: true }));
  const shell = await fresh();
  await shell.probe();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const listeners = new Set<() => void>();
  const target = {
    addEventListener: (type: string, fn: () => void) => {
      assert.equal(type, "resize");
      listeners.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      assert.equal(type, "resize");
      listeners.delete(fn);
    },
  } as unknown as Window;
  const fire = () => listeners.forEach((fn) => fn());

  const stop = shell.watchResize(target);
  assert.equal(listeners.size, 1);
  fire();
  t.mock.timers.tick(shell.RESIZE_SETTLE_MS - 1);
  fire();
  t.mock.timers.tick(shell.RESIZE_SETTLE_MS - 1);
  assert.deepEqual(cmds(calls), ["main_window_claim_frame"], "pulled early");
  t.mock.timers.tick(1);
  t.mock.timers.reset();
  await flush();
  assert.deepEqual(cmds(calls), [
    "main_window_claim_frame",
    "main_window_state",
  ]);
  assert.equal(shell.mainMaximized(), true);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  fire();
  stop();
  stop();
  assert.equal(listeners.size, 0);
  t.mock.timers.tick(shell.RESIZE_SETTLE_MS * 2);
  t.mock.timers.reset();
  await flush();
  assert.equal(calls.length, 2, "a stopped watch still pulled");
});

/** An Electron windowFrame bridge with a recorded onState and state. */
function electronFrame(main: unknown = "inset", stateReply?: () => unknown) {
  const subs = new Set<(payload: unknown) => void>();
  let subscribes = 0;
  let unsubscribes = 0;
  const stateCalls: unknown[] = [];
  const windowFrame = {
    main,
    state: (label: string) => {
      stateCalls.push(label);
      return stateReply
        ? stateReply()
        : Promise.resolve({ ok: true, fullscreen: false });
    },
    onState: (cb: (payload: unknown) => void) => {
      subscribes += 1;
      subs.add(cb);
      return () => {
        unsubscribes += 1;
        subs.delete(cb);
      };
    },
  };
  g.window = { slogaShell: { windowFrame } };
  return {
    push: (payload: unknown) => subs.forEach((cb) => cb(payload)),
    counts: () => ({ subscribes, unsubscribes, live: subs.size }),
    stateCalls,
  };
}

const framePush = (label: string, fullscreen: boolean) => ({
  kind: "windowFrameState",
  label,
  fullscreen,
});

test("watchWindowFrameState: routes per label into the fullscreen map, reactively", async () => {
  const bridge = electronFrame();
  const shell = await fresh();
  await shell.probe();
  const main = watch(() => shell.mainFullscreen());
  const layout = watch(() => frame.titleBarLayout("inset", "chat-1").style);
  const stop = shell.watchWindowFrameState();
  await flush();

  bridge.push(framePush("main", true));
  assert.equal(shell.mainFullscreen(), true);
  assert.equal(frame.windowFullscreen("chat-1"), false);
  bridge.push(framePush("chat-1", true));
  assert.equal(frame.windowFullscreen("chat-1"), true);
  assert.equal(frame.windowFullscreen("friends-window"), false);
  bridge.push(framePush("main", false));
  assert.equal(shell.mainFullscreen(), false);

  // Anything not exactly the push is dropped, and logged by kind only.
  const before = warnings.length;
  for (const bad of [
    framePush("Main", true),
    { ...framePush("chat-2", true), extra: 1 },
    { kind: "windowFrameState", label: "chat-2", fullscreen: "true" },
    { kind: "chatWindowState", label: "chat-2", maximized: true },
    null,
    "windowFrameState",
  ])
    bridge.push(bad);
  assert.equal(frame.windowFullscreen("chat-2"), false);
  assert.equal(warnings.length - before, 6);

  stop();
  main.dispose();
  layout.dispose();
  // Readers re-run on any window's change; the values they see are right.
  assert.deepEqual(distinct(main.seen), [false, true, false]);
  assert.deepEqual(distinct(layout.seen), [
    { "padding-left": frame.MAC_INSET_PADDING },
    undefined,
  ]);
});

test("watchWindowFrameState: one shell subscription for every holder", async () => {
  const bridge = electronFrame();
  const shell = await fresh();
  const counts = (subscribes: number, unsubscribes: number, live: number) =>
    assert.deepEqual(bridge.counts(), { subscribes, unsubscribes, live });
  const first = shell.watchWindowFrameState();
  const second = shell.watchWindowFrameState();
  counts(1, 0, 1);
  first();
  first();
  counts(1, 0, 1);
  bridge.push(framePush("chat-1", true));
  assert.equal(
    frame.windowFullscreen("chat-1"),
    true,
    "the last holder lost it",
  );
  second();
  counts(1, 1, 0);
  // A new holder subscribes again.
  const third = shell.watchWindowFrameState();
  counts(2, 1, 1);
  third();
});

test("watchWindowFrameState: a no-op without a usable onState", async () => {
  const throwing = {
    main: "inset",
    onState: () => {
      throw new Error("broken preload");
    },
  };
  for (const win of [
    undefined,
    {},
    { slogaShell: {} },
    { slogaShell: { windowFrame: { main: "inset" } } },
    { slogaShell: { windowFrame: { main: "inset", onState: true } } },
    { slogaShell: { windowFrame: throwing } },
  ]) {
    if (win === undefined) delete g.window;
    else g.window = win;
    const shell = await fresh();
    const stop = shell.watchWindowFrameState();
    assert.equal(typeof stop, "function");
    stop();
    stop();
  }
});

test('watchWindowFrameState: seeds main from state("main"); a push wins', async () => {
  // A reload while fullscreen: the seed reads it.
  let bridge = electronFrame("inset", () =>
    Promise.resolve({ ok: true, fullscreen: true }),
  );
  let shell = await fresh();
  let stop = shell.watchWindowFrameState();
  await flush();
  assert.deepEqual(bridge.stateCalls, ["main"]);
  assert.equal(shell.mainFullscreen(), true);
  stop();
  frame.forgetWindow("main");

  // The push lands before the seed's answer: the push wins.
  const reply = deferred<unknown>();
  bridge = electronFrame("inset", () => reply.promise);
  shell = await fresh();
  stop = shell.watchWindowFrameState();
  bridge.push(framePush("main", false));
  reply.resolve({ ok: true, fullscreen: true });
  await flush();
  assert.equal(shell.mainFullscreen(), false, "an older seed overwrote a push");
  stop();

  // An error envelope, a garbled reply or a rejection seeds nothing; a
  // native main is not asked at all.
  for (const answer of [
    () => Promise.resolve({ ok: false, err: "unsupported" }),
    () => Promise.resolve({ ok: true, fullscreen: "yes" }),
    () => Promise.reject(new Error("gone")),
    () => {
      throw new Error("boom");
    },
  ]) {
    electronFrame("inset", answer);
    shell = await fresh();
    stop = shell.watchWindowFrameState();
    await flush();
    assert.equal(shell.mainFullscreen(), false);
    stop();
  }
  bridge = electronFrame("native");
  shell = await fresh();
  stop = shell.watchWindowFrameState();
  await flush();
  assert.deepEqual(bridge.stateCalls, []);
  stop();

  // A throwing `main` getter seeds nothing and leaks no subscription.
  const subs = { on: 0, off: 0 };
  const broken = {
    state: () => Promise.resolve({ ok: true, fullscreen: true }),
    onState: () => {
      subs.on += 1;
      return () => {
        subs.off += 1;
      };
    },
  };
  Object.defineProperty(broken, "main", {
    get() {
      throw new Error("broken preload");
    },
  });
  g.window = { slogaShell: { windowFrame: broken } };
  shell = await fresh();
  stop = shell.watchWindowFrameState();
  await flush();
  assert.equal(shell.mainFullscreen(), false);
  stop();
  assert.deepEqual(subs, { on: 1, off: 1 });
});

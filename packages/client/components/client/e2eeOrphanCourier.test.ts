// Behavior of the backup refresh courier against the REAL `E2EEBridge`: the
// iOS orphaned recovery bundle (audit M2, Stage 6 fixes MAJOR-1, MINOR-2,
// MINOR-3), and the refresh that also runs on Electron after a claim and on
// main-window focus (at most hourly), never on Tauri while its backup
// commands are sync and engine-locked, never on Android, and never marks an
// upload the server did not store (on any transport: the desktop courier,
// the Android and iOS create and rotate dialogs, the refresh).
//
// e2ee.ts cannot be imported under `node --test` directly (extensionless
// sibling imports, bare packages that need a browser), so this bundles it
// with esbuild, stubs the bare packages, and drives a real bridge on a fake
// native layer (the iOS/Android `E2ee` plugin, `__TAURI__` or
// `slogaShell.e2ee`), a fake client and a stubbed `fetch`. Every assertion
// counts native takes (`e2ee_backup_refresh_if_due`), backup PUTs and
// `e2ee_backup_mark_uploaded` calls.
//
// The stubbed `PUT /e2ee/backup` answers like the real route: 200 with
// `{ generation }`, the sent one when stored, the stored one when the sent
// one is stale.
//
// A desktop create or rotate waits for its recovery window's courier, and
// any courier failure rejects it with the words `useError` in
// `../i18n/errors.ts` shows (bundled the same way, lingui stubbed to plain
// English): a backup the server did not keep has its own words, anything
// else (413, 429, 5xx, network, a native take that threw) and the 15-minute
// wait running out the generic ones. The console gets the error's name
// only. A background refresh only logs. `refreshBackupIfDue()` refuses by
// itself on Tauri, Android, the website and a window that is not the main
// one.
//
// `E2EE_COURIER_TS` swaps in another e2ee.ts (resolved against THIS
// directory) and `E2EE_COURIER_ERRORS_TS` another errors.ts, which is how
// the fail-first control runs these tests against the pre-fix source.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCE =
  process.env.E2EE_COURIER_TS ||
  fileURLToPath(new URL("./e2ee.ts", import.meta.url));
const ERRORS_SOURCE =
  process.env.E2EE_COURIER_ERRORS_TS ||
  fileURLToPath(new URL("../i18n/errors.ts", import.meta.url));
const I18N_DIR = fileURLToPath(new URL("../i18n/", import.meta.url));

const NOT_STORED_WORDS =
  "Sloga's servers kept a different backup. Delete the backup in" +
  " Settings > Encryption, then make a new recovery code.";

const UPLOAD_FAILED_WORDS = "Your backup did not reach Sloga. Try again.";

const HOUR = 60 * 60 * 1000;

/** The bridge's `RECOVERY_WAIT_MS`: how long a desktop create waits. */
const RECOVERY_WAIT_MS = 15 * 60 * 1000;

/** Planted in every failure body and message: it must never be logged. */
const SENTINEL = "SENTINEL-BODY-7f3a";

type Listener = () => void;

/** The fake native layer every bridge in a test shares (process-lifetime). */
class FakePlugin {
  listeners = new Set<Listener>();
  removed = 0;
  /** Commands seen, in order. */
  calls: string[] = [];
  /** Takes running right now, and the most ever at once. */
  inFlight = 0;
  maxInFlight = 0;
  /** Resolvers for held takes, oldest first. */
  held: ((bundle: unknown) => void)[] = [];
  /** When true, every take waits for `release`. */
  hold = false;
  /** Bundles the next takes return when not held (then null: not due). */
  due: unknown[] = [];
  /** Bundles the next `e2ee_backup_take_pending_upload` calls return. */
  pending: unknown[] = [];
  /** When true, `e2ee_backup_take_pending_upload` throws. */
  takeThrows = false;
  /** Desktop shell event listeners (`__TAURI__.event` / `slogaShell.e2ee.on`). */
  events = new Map<string, Set<(payload: unknown) => void>>();

  on(name: string, fn: (payload: unknown) => void) {
    const set = this.events.get(name) ?? new Set();
    set.add(fn);
    this.events.set(name, set);
    return () => set.delete(fn);
  }

  /** The desktop shell delivers `name` to every listener. */
  emit(name: string, payload: unknown) {
    for (const fn of [...(this.events.get(name) ?? [])]) fn(payload);
  }

  addListener(name: string, fn: Listener) {
    assert.equal(name, "backupBundleWaiting");
    this.listeners.add(fn);
    return Promise.resolve({
      remove: async () => {
        if (this.listeners.delete(fn)) this.removed++;
      },
    });
  }

  /** Native fires the event to every listener, in registration order. */
  fire() {
    for (const fn of [...this.listeners]) fn();
  }

  async call(args: { __cmd: string }) {
    this.calls.push(args.__cmd);
    if (args.__cmd === "e2ee_backup_refresh_if_due") {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      try {
        const bundle = this.hold
          ? await new Promise((resolve) => this.held.push(resolve))
          : (this.due.shift() ?? null);
        return { json: JSON.stringify(bundle) };
      } finally {
        this.inFlight--;
      }
    }
    if (args.__cmd === "e2ee_backup_mark_uploaded") return { json: "null" };
    // The desktop recovery window opens; its outcome comes later as an event
    if (args.__cmd === "e2ee_backup_open_recovery") return { json: "null" };
    if (args.__cmd === "e2ee_backup_take_pending_upload") {
      if (this.takeThrows) {
        throw Object.assign(new Error(`take failed ${SENTINEL}`), {
          name: "TakeFailed",
        });
      }
      return { json: JSON.stringify(this.pending.shift() ?? null) };
    }
    throw new Error(`unstubbed command ${args.__cmd}`);
  }

  /** The Android dialog / iOS sheet mints a code and hands back the bundle. */
  async backupCreate() {
    this.calls.push("backupCreate");
    return { json: JSON.stringify(BUNDLE) };
  }

  async backupRotate() {
    this.calls.push("backupRotate");
    return { json: JSON.stringify(BUNDLE) };
  }

  release(bundle: unknown) {
    const next = this.held.shift();
    assert.ok(next, "no take is waiting");
    next(bundle);
  }

  takes() {
    return this.calls.filter((c) => c === "e2ee_backup_refresh_if_due").length;
  }

  marks() {
    return this.calls.filter((c) => c === "e2ee_backup_mark_uploaded").length;
  }
}

const BUNDLE = { header: "h", ciphertext: "c", generation: 7 };

type Bridge = {
  status: Map<string, unknown>;
  onEvent(event: { type: string; accepted?: boolean }): void;
  dispose?: () => Promise<void>;
  refreshBackupIfDue(): Promise<void>;
  backupText: Map<string, { truncated: string | null }>;
  createRecoveryCode(): Promise<void>;
  rotateRecoveryCode(): Promise<void>;
};
type BridgeCtor = new (client: unknown) => Bridge;
type EsbuildHook = (
  options: { filter: RegExp; namespace?: string },
  callback: (args: { path: string }) => unknown,
) => void;
type Shell = "ios" | "android" | "web" | "tauri" | "electron";
type FakeWindow = EventTarget & Record<string, unknown>;

let plugin: FakePlugin;
let puts: number[] = [];
/** When set, the server echoes this generation instead of the sent one. */
let storedGeneration: number | null = null;
/** When set, `PUT /e2ee/backup` answers (or throws) with this instead. */
let putAnswer: (() => Response) | null = null;
/** What `Capacitor.getPlatform()` answers. */
let capacitorPlatform = "ios";
let E2EEBridge: BridgeCtor;
/** The same module loaded as the popout document (not the main window). */
let PopoutBridge: BridgeCtor;
/** `useError()` from errors.ts, lingui stubbed to plain English. */
let describeError: (error: unknown) => string;
let outDir: string;
const realNow = Date.now;

before(async () => {
  const require = createRequire(import.meta.url);
  const esbuild = createRequire(require.resolve("vite"))("esbuild");
  const bundled = await esbuild.build({
    stdin: {
      contents: readFileSync(SOURCE, "utf8"),
      resolveDir: HERE,
      sourcefile: "e2ee.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
    plugins: [
      {
        name: "stub-bare-packages",
        setup(build: { onResolve: EsbuildHook; onLoad: EsbuildHook }) {
          build.onResolve({ filter: /^[^./]/ }, (a: { path: string }) => ({
            path: a.path,
            namespace: "stub",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "stub" },
            (a: { path: string }) => {
              if (a.path === "@capacitor/core") {
                return {
                  contents:
                    "export const Capacitor = globalThis.__courierStub.Capacitor;" +
                    "export const registerPlugin = () => globalThis.__courierStub.plugin();",
                  loader: "js",
                };
              }
              if (a.path === "@solid-primitives/map") {
                return {
                  contents: "export class ReactiveMap extends Map {}",
                  loader: "js",
                };
              }
              // Anything else: a CJS proxy whose every member is a no-op
              // function (callable and constructible).
              return {
                contents:
                  "const fn = function () { return fn; };" +
                  "module.exports = new Proxy({}, { get: (_, k) =>" +
                  " k === '__esModule' ? false : fn });",
                loader: "js",
              };
            },
          );
        },
      },
    ],
  });
  outDir = mkdtempSync(join(tmpdir(), "e2ee-courier-"));
  const file = join(outDir, "e2ee.mjs");
  writeFileSync(file, bundled.outputFiles[0].text);

  const g = globalThis as Record<string, unknown>;
  // popout.ts reads `window.location.pathname` at module scope: the main
  // window, so the bridge's main-window flag is true.
  g.window = newWindow();
  g.__courierStub = {
    Capacitor: {
      getPlatform: () => capacitorPlatform,
      isNativePlatform: () => capacitorPlatform !== "web",
      isPluginAvailable: () => true,
    },
    plugin: () => plugin,
  };
  g.fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "PUT" && url.endsWith("/e2ee/backup")) {
      const sent = (JSON.parse(init.body ?? "{}") as { generation: number })
        .generation;
      puts.push(sent);
      if (putAnswer) return putAnswer();
      return new Response(
        JSON.stringify({ generation: storedGeneration ?? sent }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 500 });
  };
  ({ E2EEBridge } = (await import(pathToFileURL(file).href)) as {
    E2EEBridge: BridgeCtor;
  });
  // popout.ts reads the path once, at module scope: a second instance of
  // the module, loaded under the popout path, is a non-main document.
  g.window = newWindow("/friends-popout");
  ({ E2EEBridge: PopoutBridge } = (await import(
    `${pathToFileURL(file).href}?popout`
  )) as { E2EEBridge: BridgeCtor });
  g.window = newWindow();

  const errors = await esbuild.build({
    stdin: {
      contents: readFileSync(ERRORS_SOURCE, "utf8"),
      resolveDir: I18N_DIR,
      sourcefile: "errors.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
    plugins: [
      {
        name: "stub-errors-imports",
        setup(build: { onResolve: EsbuildHook; onLoad: EsbuildHook }) {
          build.onResolve({ filter: /^[^./]/ }, (a: { path: string }) => ({
            path: a.path,
            namespace: "stub",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "stub" },
            (a: { path: string }) => {
              const stubs: Record<string, string> = {
                // The macro's `t` as a plain template: the English msgid
                "@lingui-solid/solid/macro":
                  "export const useLingui = () => ({ t: (s, ...v) =>" +
                  " s.reduce((a, x, i) => a + x + (i < v.length ? v[i] : ''), '') });",
                "@lingui/core": "export const i18n = { locale: 'en' };",
                "@revolt/state/stores/draftSendError":
                  "export const FIRST_FILE_NEEDS_TEXT_SEND_ERROR = 'FirstFileNeedsText';" +
                  "export const sendRefusalSide = () => undefined;",
              };
              return {
                contents: stubs[a.path] ?? "export const API = {};",
                loader: "js",
              };
            },
          );
        },
      },
    ],
  });
  const errorsFile = join(outDir, "errors.mjs");
  writeFileSync(errorsFile, errors.outputFiles[0].text);
  const { useError } = (await import(pathToFileURL(errorsFile).href)) as {
    useError: () => (error: unknown) => string;
  };
  describeError = useError();
});

after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

afterEach(() => {
  Date.now = realNow;
});

/**
 * A main window: an event target with a location, which counts the "focus"
 * listeners attached to it (`focusListeners`).
 */
function newWindow(path = "/"): FakeWindow {
  const target = new EventTarget();
  const focus = new Set<unknown>();
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  return Object.assign(target, {
    location: new URL(path, "http://localhost/"),
    focusListeners: () => focus.size,
    addEventListener(type: string, fn: EventListener) {
      if (type === "focus") focus.add(fn);
      add(type, fn);
    },
    removeEventListener(type: string, fn: EventListener) {
      if (type === "focus") focus.delete(fn);
      remove(type, fn);
    },
  }) as unknown as FakeWindow;
}

function focusListeners(): number {
  return (win().focusListeners as () => number)();
}

function win(): FakeWindow {
  return (globalThis as Record<string, unknown>).window as FakeWindow;
}

function focusMain() {
  win().dispatchEvent(new Event("focus"));
}

/**
 * A fresh native layer and window for `shell`. The desktop fakes forward to
 * THIS test's plugin, so a bridge left over from another test never reaches
 * it.
 */
function fresh(shell: Shell = "ios") {
  const p = new FakePlugin();
  plugin = p;
  puts = [];
  storedGeneration = null;
  putAnswer = null;
  capacitorPlatform = shell === "tauri" || shell === "electron" ? "web" : shell;
  const w = newWindow();
  (globalThis as Record<string, unknown>).window = w;
  if (shell === "tauri") {
    w.__TAURI__ = {
      core: {
        invoke: async (command: string, args?: Record<string, unknown>) =>
          JSON.parse((await p.call({ __cmd: command, ...args })).json),
      },
      event: {
        listen: async (name: string, fn: (e: { payload: unknown }) => void) =>
          p.on(name, (payload) => fn({ payload })),
      },
    };
  } else if (shell === "electron") {
    w.slogaShell = {
      name: "test",
      platform: "linux",
      e2ee: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          try {
            const { json } = await p.call({ __cmd: command, ...args });
            return { ok: JSON.parse(json) };
          } catch (err) {
            return { err };
          }
        },
        on: (name: string, fn: (payload: unknown) => void) => p.on(name, fn),
      },
    };
  }
}

function fakeClient() {
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  return {
    user: { id: "01USER" },
    sessionId: "01SESSION",
    authenticationHeader: ["X-Session-Token", "token"],
    options: { baseURL: "http://test.invalid" },
    events: { send() {} },
    on(name: string, fn: (...a: unknown[]) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    emit(name: string) {
      for (const fn of handlers.get(name) ?? []) fn();
    },
  };
}

/** Let every queued promise and timer-0 continuation run. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A bridge on the shared plugin, enabled, published and claimed. */
async function claimedBridge(
  deviceId: string | null = "01DEVICE",
  Ctor: BridgeCtor = E2EEBridge,
) {
  const client = fakeClient();
  const bridge = new Ctor(client);
  bridge.status.set("state", {
    enabled: true,
    published: true,
    device_id: deviceId,
    claimed: false,
  });
  bridge.onEvent({ type: "E2EEClaimResult", accepted: true });
  await settle();
  return { bridge, client };
}

// ---- iOS: the kept recovery bundle -----------------------------------------

test("dispose: a disposed bridge removes its listener and ignores a late event", async () => {
  fresh();
  const { bridge } = await claimedBridge();
  assert.equal(plugin.listeners.size, 1);
  const late = [...plugin.listeners][0];
  plugin.calls = [];

  assert.equal(
    typeof bridge.dispose,
    "function",
    "E2EEBridge has no dispose()",
  );
  await bridge.dispose!();
  await bridge.dispose!(); // idempotent, never throws
  assert.equal(plugin.listeners.size, 0, "listener still registered");
  assert.equal(plugin.removed, 1);

  // An event already in flight when the listener went away.
  late();
  await settle();
  assert.equal(plugin.takes(), 0, "a disposed bridge took the bundle");
  assert.equal(puts.length, 0);
});

test("dispose: only the live bridge takes the bundle after a client swap", async () => {
  fresh();
  const { bridge: stale } = await claimedBridge();
  await stale.dispose?.();
  await claimedBridge();
  plugin.calls = [];
  plugin.hold = true;

  plugin.fire();
  await settle();
  assert.equal(plugin.takes(), 1, "want exactly one take, by the live bridge");
  plugin.release(BUNDLE);
  await settle();
  assert.equal(puts.length, 1);
});

test("single flight: overlapping triggers take one at a time, then once more", async () => {
  fresh();
  await claimedBridge();
  plugin.calls = [];
  plugin.hold = true;

  plugin.fire();
  await settle();
  assert.equal(plugin.takes(), 1);
  plugin.fire();
  plugin.fire();
  await settle();
  assert.equal(plugin.takes(), 1, "a second take started while one ran");

  plugin.release(BUNDLE);
  await settle();
  assert.equal(puts.length, 1);
  assert.equal(plugin.takes(), 2, "the mid-run trigger was lost");
  plugin.release(null);
  await settle();

  assert.equal(plugin.takes(), 2, "coalesced triggers ran more than once");
  assert.equal(plugin.maxInFlight, 1);
  assert.deepEqual(plugin.calls, [
    "e2ee_backup_refresh_if_due",
    "e2ee_backup_mark_uploaded",
    "e2ee_backup_refresh_if_due",
  ]);
});

test("no device_id: the bundle is never taken when it cannot be PUT", async () => {
  fresh();
  await claimedBridge(null);
  plugin.fire();
  await settle();
  assert.equal(
    plugin.takes(),
    0,
    "took a bundle with no device_id to PUT under",
  );
});

test("disconnected: no take while the socket is down", async () => {
  fresh();
  const { client } = await claimedBridge();
  plugin.calls = [];
  client.emit("disconnected");
  plugin.fire();
  await settle();
  assert.equal(plugin.takes(), 0, "took a bundle on a dropped session");
});

test("control: a claimed, connected bridge does take and PUT", async () => {
  fresh();
  await claimedBridge();
  plugin.calls = [];
  plugin.hold = true;
  plugin.fire();
  await settle();
  plugin.release(BUNDLE);
  await settle();
  assert.equal(plugin.takes(), 1);
  assert.equal(puts.length, 1);
});

// ---- Which shells refresh after a claim -------------------------------------

for (const shell of ["electron", "ios"] as const) {
  test(`${shell}: an accepted claim runs the due check and uploads a due backup`, async () => {
    fresh(shell);
    plugin.due = [BUNDLE];
    await claimedBridge();
    assert.equal(plugin.takes(), 1, "no due check after the claim");
    assert.deepEqual(puts, [7]);
    assert.equal(plugin.marks(), 1);
  });
}

// Tauri: `e2ee_backup_refresh_if_due` is a sync, engine-locked command on
// the main thread until the sloga-desktop follow-up makes it async.
for (const shell of ["tauri", "android", "web"] as const) {
  test(`${shell}: no due check after a claim, and none on focus`, async () => {
    let now = 1_000_000;
    Date.now = () => now;
    fresh(shell);
    plugin.due = [BUNDLE];
    await claimedBridge();
    focusMain();
    await settle();
    now += 2 * HOUR;
    focusMain();
    await settle();
    assert.equal(plugin.takes(), 0, `${shell} asked native for a refresh`);
    assert.equal(puts.length, 0);
    assert.equal(focusListeners(), 0, `${shell} listens for focus`);
  });
}

test("electron: no due check before the claim is accepted", async () => {
  fresh("electron");
  plugin.due = [BUNDLE];
  const bridge = new E2EEBridge(fakeClient());
  bridge.status.set("state", {
    enabled: true,
    published: true,
    device_id: "01DEVICE",
    claimed: false,
  });
  focusMain();
  bridge.onEvent({ type: "E2EEClaimResult", accepted: false });
  await settle();
  focusMain();
  await settle();
  assert.equal(plugin.takes(), 0, "took before an accepted claim");
});

// ---- Main-window focus, at most hourly --------------------------------------

for (const shell of ["electron"] as const) {
  test(`${shell}: main-window focus re-checks at most once an hour`, async () => {
    let now = 1_000_000;
    Date.now = () => now;
    fresh(shell);
    await claimedBridge();
    assert.equal(plugin.takes(), 1, "the claim's check");

    now += HOUR - 1;
    focusMain();
    await settle();
    assert.equal(plugin.takes(), 1, "focus re-checked inside the hour");

    now += 1;
    plugin.due = [BUNDLE];
    focusMain();
    await settle();
    assert.equal(plugin.takes(), 2, "focus did not re-check after an hour");
    assert.deepEqual(puts, [7]);

    focusMain();
    focusMain();
    await settle();
    assert.equal(plugin.takes(), 2, "back-to-back focus re-checked again");
  });
}

test("focus: a refused guard neither asks native nor uses up the hour", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  fresh("electron");
  const { bridge } = await claimedBridge();
  assert.equal(plugin.takes(), 1);
  const on = bridge.status.get("state") as Record<string, unknown>;
  now += HOUR;
  bridge.status.set("state", { ...on, published: false });
  focusMain();
  await settle();
  assert.equal(plugin.takes(), 1, "took for an unpublished device");
  bridge.status.set("state", on);
  focusMain();
  await settle();
  assert.equal(plugin.takes(), 2, "the refused focus used up the hour");
});

test("focus: a disposed bridge stops listening", async () => {
  let now = 1_000_000;
  Date.now = () => now;
  fresh("electron");
  const { bridge } = await claimedBridge();
  assert.equal(plugin.takes(), 1);
  assert.equal(focusListeners(), 1, "want one focus listener per bridge");
  await bridge.dispose!();
  await bridge.dispose!();
  assert.equal(focusListeners(), 0, "dispose left the focus listener");
  now += 2 * HOUR;
  focusMain();
  await settle();
  assert.equal(plugin.takes(), 1, "a disposed bridge re-checked on focus");
});

// ---- The server's echoed generation ----------------------------------------

for (const shell of ["electron", "ios"] as const) {
  test(`${shell}: an echoed generation other than the one sent is not marked, and not retried`, async () => {
    let now = 1_000_000;
    Date.now = () => now;
    fresh(shell);
    storedGeneration = 9;
    plugin.due = [BUNDLE];
    await claimedBridge();
    assert.equal(plugin.takes(), 1);
    assert.deepEqual(puts, [7], "want one PUT of the due bundle");
    assert.equal(plugin.marks(), 0, "a refused upload was marked uploaded");

    // Nothing runs again by itself, and a later trigger asks native, which
    // says not due (the refresh already reset its clock): no second PUT.
    await settle();
    assert.equal(plugin.takes(), 1, "the courier retried on its own");
    now += HOUR;
    focusMain();
    await settle();
    assert.deepEqual(puts, [7], "the refused bundle was PUT again");
    assert.equal(plugin.marks(), 0);
  });
}

test("echo: a missing generation in the answer is not marked", async () => {
  fresh("electron");
  const g = globalThis as Record<string, unknown>;
  const realFetch = g.fetch;
  g.fetch = async (url: string, init: { method: string }) => {
    if (init.method === "PUT" && url.endsWith("/e2ee/backup")) {
      puts.push(0);
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: 500 });
  };
  try {
    plugin.due = [BUNDLE];
    await claimedBridge();
    assert.equal(puts.length, 1);
    assert.equal(plugin.marks(), 0, "an answer with no echo was marked");
  } finally {
    g.fetch = realFetch;
  }
});

test("echo control: the matching echo is marked with the sent generation", async () => {
  fresh("electron");
  plugin.due = [BUNDLE];
  await claimedBridge();
  assert.deepEqual(puts, [7]);
  assert.equal(plugin.marks(), 1);
});

// Protected channels S4 (design 8.5): the text section's `truncated` of the
// bundle the server kept is what the settings card reads.
test("backup text: a kept upload records the bundle's text_truncated, null without a text section", async () => {
  for (const [extra, truncated] of [
    [{ text_truncated: "none" }, "none"],
    [{ text_truncated: "oldest" }, "oldest"],
    [{ text_truncated: "all" }, "all"],
    [{}, null],
    [{ text_truncated: "everything" }, null],
  ] as const) {
    fresh("electron");
    plugin.due = [{ ...BUNDLE, ...extra }];
    const { bridge } = await claimedBridge();
    assert.deepEqual(puts, [7]);
    assert.deepEqual(bridge.backupText.get("state"), { truncated });
  }
});

test("backup text: an upload the server did not keep records nothing", async () => {
  fresh("electron");
  storedGeneration = 9;
  plugin.due = [{ ...BUNDLE, text_truncated: "all" }];
  const { bridge } = await claimedBridge();
  assert.deepEqual(puts, [7]);
  assert.equal(plugin.marks(), 0);
  assert.equal(bridge.backupText.has("state"), false);
});

// The echo check on the other transports (final audit B, code 8): every
// upload goes through `#putBackup`, so a create or rotate on Android or iOS
// that the server did not keep now rejects instead of resolving, and the
// iOS kept bundle is not marked either.

/** Run a create or rotate to its end; the rejection, or undefined. */
async function recoveryOutcome(
  bridge: Bridge,
  mode: "create" | "rotate",
): Promise<unknown> {
  const run =
    mode === "create"
      ? bridge.createRecoveryCode()
      : bridge.rotateRecoveryCode();
  return run.then(
    () => undefined,
    (error: unknown) => error ?? new Error("rejected with nothing"),
  );
}

for (const shell of ["android", "ios"] as const) {
  for (const mode of ["create", "rotate"] as const) {
    const dialog = mode === "create" ? "backupCreate" : "backupRotate";
    test(`${shell} ${mode}: a backup the server did not keep rejects, unmarked`, async () => {
      fresh(shell);
      const { bridge } = await claimedBridge();
      plugin.calls = [];
      storedGeneration = 9;
      const error = await recoveryOutcome(bridge, mode);
      assert.deepEqual(
        plugin.calls.filter((c) => c === dialog),
        [dialog],
      );
      assert.deepEqual(puts, [7], "want one PUT of the dialog's bundle");
      assert.equal(plugin.marks(), 0, "a refused upload was marked uploaded");
      assert.equal(
        (error as { name?: unknown } | undefined)?.name,
        "BackupNotStoredError",
        `${shell} ${mode} did not reject with the not-stored error`,
      );
      assert.equal(describeError(error), NOT_STORED_WORDS);
    });

    test(`${shell} ${mode} control: a kept backup resolves and is marked`, async () => {
      fresh(shell);
      const { bridge } = await claimedBridge();
      plugin.calls = [];
      const error = await recoveryOutcome(bridge, mode);
      assert.equal(error, undefined);
      assert.deepEqual(
        plugin.calls.filter((c) => c === dialog),
        [dialog],
      );
      assert.deepEqual(puts, [7]);
      assert.equal(plugin.marks(), 1);
    });
  }
}

test("ios: a kept bundle the server did not keep is not marked", async () => {
  fresh("ios");
  await claimedBridge();
  plugin.calls = [];
  storedGeneration = 9;
  plugin.due = [BUNDLE];
  plugin.fire();
  await settle();
  assert.equal(plugin.takes(), 1);
  assert.deepEqual(puts, [7]);
  assert.equal(plugin.marks(), 0, "a refused kept bundle was marked uploaded");
});

test("ios control: a kept bundle the server kept is marked", async () => {
  fresh("ios");
  await claimedBridge();
  plugin.calls = [];
  plugin.due = [BUNDLE];
  plugin.fire();
  await settle();
  assert.deepEqual(puts, [7]);
  assert.equal(plugin.marks(), 1);
});

// ---- A backup the server did not keep: shown only when the user asked ----

/**
 * Run `fn` with console.error captured; returns the backup lines it logged
 * (the fake native layer leaves other housekeeping logging too).
 */
async function capturingErrors(fn: () => Promise<void>): Promise<unknown[][]> {
  const seen: unknown[][] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void seen.push(args);
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return seen.filter(
    (args) =>
      typeof args[0] === "string" && args[0].startsWith("[e2ee] backup"),
  );
}

/** Start a desktop create or rotate; it settles only after the courier. */
function startRecovery(bridge: Bridge, mode: "create" | "rotate") {
  const run =
    mode === "create"
      ? bridge.createRecoveryCode()
      : bridge.rotateRecoveryCode();
  const state: { done: boolean; error?: unknown } = { done: false };
  run.then(
    () => void (state.done = true),
    (error: unknown) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

/** Let queued work run until `done()` or `ms` of real time pass. */
async function settleUntil(done: () => boolean, ms = 5000) {
  const end = realNow() + ms;
  await settle();
  while (!done() && realNow() < end) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await settle();
}

/**
 * Courier failures other than a backup the server did not keep. Each body
 * or message carries `SENTINEL`, which the log must never show.
 */
const UPLOAD_FAILURES: { label: string; arm: () => void }[] = [
  {
    label: "a 413",
    arm: () => {
      putAnswer = () =>
        new Response(JSON.stringify({ type: "PayloadTooLarge", SENTINEL }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        });
    },
  },
  {
    label: "a 429 that outlasts the retries",
    arm: () => {
      putAnswer = () =>
        new Response(SENTINEL, {
          status: 429,
          headers: { "X-RateLimit-Reset-After": "0" },
        });
    },
  },
  {
    label: "a 500",
    arm: () => {
      putAnswer = () => new Response(SENTINEL, { status: 500 });
    },
  },
  {
    label: "a network failure",
    arm: () => {
      putAnswer = () => {
        throw new TypeError(`Failed to fetch ${SENTINEL}`);
      };
    },
  },
  {
    label: "a native take that threw",
    arm: () => {
      plugin.takeThrows = true;
    },
  },
];

test("useError: the not-stored error shows its own words, never the log text", () => {
  const error = Object.assign(
    new Error("The server did not store this backup generation"),
    { name: "BackupNotStoredError" },
  );
  assert.equal(describeError(error), NOT_STORED_WORDS);
});

test("useError: the upload-failed error shows the generic words, never the log text", () => {
  const error = Object.assign(new Error("The backup upload did not complete"), {
    name: "BackupUploadFailedError",
  });
  assert.equal(describeError(error), UPLOAD_FAILED_WORDS);
});

for (const shell of ["tauri", "electron"] as const) {
  for (const mode of ["create", "rotate"] as const) {
    test(`${shell} ${mode}: a backup the server did not keep rejects with the words`, async () => {
      fresh(shell);
      const { bridge } = await claimedBridge();
      plugin.calls = [];
      storedGeneration = 9;
      plugin.pending = [BUNDLE];

      const run = startRecovery(bridge, mode);
      await settle();
      assert.equal(
        run.done,
        false,
        `${mode} returned before the window's outcome`,
      );
      assert.ok(plugin.calls.includes("e2ee_backup_open_recovery"));

      const logged = await capturingErrors(async () => {
        plugin.emit("e2ee:recovery-complete", mode);
        await settle();
      });
      assert.equal(run.done, true, `${mode} still waiting after the courier`);
      assert.deepEqual(puts, [7]);
      assert.equal(plugin.marks(), 0, "a refused upload was marked uploaded");
      assert.equal(
        (run.error as { name?: unknown } | undefined)?.name,
        "BackupNotStoredError",
        `${mode} did not reject with the not-stored error`,
      );
      assert.equal(describeError(run.error), NOT_STORED_WORDS);
      assert.deepEqual(
        logged,
        [["[e2ee] backup courier failed:", "BackupNotStoredError"]],
        "the courier failure is logged by name only",
      );
    });
  }

  for (const mode of ["create", "rotate"] as const) {
    for (const failure of UPLOAD_FAILURES) {
      test(`${shell} ${mode}: ${failure.label} rejects with the generic words`, async () => {
        fresh(shell);
        const { bridge } = await claimedBridge();
        plugin.calls = [];
        plugin.pending = [BUNDLE];
        failure.arm();

        const run = startRecovery(bridge, mode);
        await settle();
        assert.equal(run.done, false, `${mode} returned before the outcome`);

        const logged = await capturingErrors(async () => {
          plugin.emit("e2ee:recovery-complete", mode);
          await settleUntil(() => run.done);
        });
        assert.equal(run.done, true, `${mode} still waiting after the courier`);
        assert.equal(plugin.marks(), 0, "a failed upload was marked uploaded");
        assert.equal(
          (run.error as { name?: unknown } | undefined)?.name,
          "BackupUploadFailedError",
          `${mode} did not reject with the upload-failed error: ${String(run.error)}`,
        );
        assert.equal(describeError(run.error), UPLOAD_FAILED_WORDS);
        assert.equal(logged.length, 1, "want one courier log line");
        assert.equal(logged[0][0], "[e2ee] backup courier failed:");
        assert.equal(logged[0].length, 2, "the log carries more than a name");
        assert.equal(typeof logged[0][1], "string");
        assert.ok(
          !JSON.stringify(logged).includes(SENTINEL),
          `the log leaked the failure body: ${JSON.stringify(logged)}`,
        );
      });
    }

    test(`${shell} ${mode}: no outcome within the wait rejects with the generic words`, async () => {
      fresh(shell);
      const { bridge } = await claimedBridge();
      const realSetTimeout = globalThis.setTimeout;
      let expire: (() => void) | null = null;
      globalThis.setTimeout = ((
        fn: () => void,
        ms?: number,
        ...rest: unknown[]
      ) => {
        if (ms === RECOVERY_WAIT_MS) {
          expire = fn;
          return realSetTimeout(() => {}, 0);
        }
        return realSetTimeout(fn, ms, ...rest);
      }) as typeof setTimeout;
      try {
        const run = startRecovery(bridge, mode);
        await settle();
        assert.ok(expire, "no recovery wait timer was armed");
        assert.equal(run.done, false);
        (expire as () => void)();
        await settle();
        assert.equal(
          run.done,
          true,
          "the expired wait left the caller waiting",
        );
        assert.equal(
          (run.error as { name?: unknown } | undefined)?.name,
          "BackupUploadFailedError",
          "the expired wait did not reject with the upload-failed error",
        );
        assert.equal(describeError(run.error), UPLOAD_FAILED_WORDS);
        assert.equal(puts.length, 0);
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
    });
  }

  test(`${shell} create control: a kept backup resolves and is marked`, async () => {
    fresh(shell);
    const { bridge } = await claimedBridge();
    plugin.pending = [BUNDLE];
    const run = startRecovery(bridge, "create");
    await settle();
    assert.equal(run.done, false);
    plugin.emit("e2ee:recovery-complete", "create");
    await settle();
    assert.equal(run.done, true);
    assert.equal(run.error, undefined);
    assert.deepEqual(puts, [7]);
    assert.equal(plugin.marks(), 1);
  });

  test(`${shell} create: a cancelled window resolves without a PUT`, async () => {
    fresh(shell);
    const { bridge } = await claimedBridge();
    const run = startRecovery(bridge, "create");
    await settle();
    plugin.emit("e2ee:recovery-complete", "cancel");
    await settle();
    assert.equal(run.done, true);
    assert.equal(run.error, undefined);
    assert.equal(puts.length, 0);
  });
}

test("tauri create: dispose ends the wait without an error", async () => {
  fresh("tauri");
  const { bridge } = await claimedBridge();
  const run = startRecovery(bridge, "create");
  await settle();
  assert.equal(run.done, false);
  await bridge.dispose!();
  await settle();
  assert.equal(run.done, true, "a disposed bridge left the caller waiting");
  assert.equal(run.error, undefined);
});

test("electron: a background refresh the server did not keep only logs its name", async () => {
  fresh("electron");
  storedGeneration = 9;
  plugin.due = [BUNDLE];
  const logged = await capturingErrors(async () => {
    await claimedBridge();
  });
  assert.deepEqual(puts, [7]);
  assert.equal(plugin.marks(), 0);
  assert.deepEqual(logged, [
    ["[e2ee] backup refresh failed:", "BackupNotStoredError"],
  ]);
});

// ---- refreshBackupIfDue() refuses by itself ---------------------------------

for (const shell of ["tauri", "android", "web"] as const) {
  test(`${shell}: a direct refreshBackupIfDue() never asks native`, async () => {
    fresh(shell);
    const { bridge } = await claimedBridge();
    plugin.calls = [];
    plugin.due = [BUNDLE];
    await bridge.refreshBackupIfDue();
    await settle();
    assert.equal(plugin.takes(), 0, `${shell} asked native for a refresh`);
    assert.equal(puts.length, 0);
  });
}

for (const shell of ["tauri", "electron"] as const) {
  test(`${shell} popout: a direct refreshBackupIfDue() never asks native`, async () => {
    fresh(shell);
    const { bridge } = await claimedBridge("01DEVICE", PopoutBridge);
    plugin.calls = [];
    plugin.due = [BUNDLE];
    await bridge.refreshBackupIfDue();
    await settle();
    assert.equal(plugin.takes(), 0, "a non-main window asked native");
    assert.equal(puts.length, 0);
  });
}

test("control: a direct refreshBackupIfDue() in the electron main window takes", async () => {
  fresh("electron");
  const { bridge } = await claimedBridge();
  plugin.calls = [];
  plugin.due = [BUNDLE];
  await bridge.refreshBackupIfDue();
  assert.equal(plugin.takes(), 1);
  assert.deepEqual(puts, [7]);
});

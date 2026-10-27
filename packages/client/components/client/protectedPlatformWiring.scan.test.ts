// Source-scan spec for the S7 platform wiring in `e2ee.ts` (lane C3, plan D9 /
// D10, RR-1, RR-2, RR-6, Step 0 fold 1). `e2ee.ts` cannot load under Node
// (Solid, the native bridge, stoat.js), so the decisions live in the pure
// `protectedPlatform.ts` (lane C4, spec'd there) and this spec pins that the
// bridge CALLS them, and calls them with the right facts:
//
//  W1  the wiring members (transport kind, structural input, structural,
//      `structuralShell`, capability, bridge start, flag fetch, probe,
//      timeout, last-known flag, platform log, owner record) are lifted out
//      of the source with their types stripped and RUN against stub
//      transports and the REAL `protectedPlatform.ts` /
//      `protectedChannelsFlag.ts`;
//  W2  `#checkStoreOwner` is lifted and RUN: its W4 latch is unchanged and
//      it records `{unknown}` / `{known, owner}` for the A8 check;
//  W3  source shape for what cannot run here: `#onReady` awaits the bridge
//      start before anything else, both route helpers AND `!hold` into
//      `indexReady`, the port maps `#textInvoke` errors, the flag is written
//      only through `reduceFlag`, the Capacitor dialog routes and plugin
//      entries, and `ProtectedUiApi.structuralShell`.
//
// Run: node --test --conditions=browser components/client/protectedPlatformWiring.scan.test.ts
// `PROTECTED_PLATFORM_WIRING_TS=<path>` scans another copy of `e2ee.ts`
// (mutation controls); `PROTECTED_PLATFORM_WIRING_TYPES=<path>` another copy
// of `protectedTextTypes.ts`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test as nodeTest } from "node:test";

import { fetchProtectedChannelsFlag } from "./protectedChannelsFlag.ts";
import {
  PROTECTED_PLATFORM_MARKER,
  protectedPlatformTag,
  reduceFlag,
  storeOwnerAllows,
  structuralState,
} from "./protectedPlatform.ts";

/**
 * Every test is bounded: a mutated wiring whose start never settles (the
 * stub deadlines only fire when a test fires them) must fail, not hang.
 */
function test(name: string, fn: () => void | Promise<void>): void {
  nodeTest(name, { timeout: 10_000 }, fn);
}

const FILE =
  process.env.PROTECTED_PLATFORM_WIRING_TS ||
  new URL("./e2ee.ts", import.meta.url);
const SRC = readFileSync(FILE, "utf8");
const TYPES_FILE =
  process.env.PROTECTED_PLATFORM_WIRING_TYPES ||
  new URL("./protectedTextTypes.ts", import.meta.url);
const TYPES = readFileSync(TYPES_FILE, "utf8");

// ---- Source helpers (the same shapes as protectedSeam.scan.test.ts) --------

/**
 * Index just past the `}` matching the `{` at `open`, skipping strings,
 * template literals and comments (good enough for this file's style).
 */
function matchBrace(src: string, open: number): number {
  assert.equal(src[open], "{", "matchBrace: not at a brace");
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return src.length;
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === "\\") i++;
      }
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("matchBrace: unbalanced");
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/**
 * The body (braces included) of the member declared by `head`. `head` must
 * cover any return type that contains a brace.
 */
function member(src: string, head: RegExp): string {
  const m = head.exec(src);
  assert.ok(m, `member not found: ${head}`);
  let i = m.index + m[0].length;
  let parens = count(m[0], "(") - count(m[0], ")");
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    if (src[i] === ")") parens--;
    if (src[i] === "{" && parens === 0) break;
  }
  return src.slice(i, matchBrace(src, i));
}

/** The full declaration (head + body) of the member `head` names. */
function memberDecl(src: string, head: RegExp): string {
  const m = head.exec(src);
  assert.ok(m, `member not found: ${head}`);
  const body = member(src, head);
  const start = m.index + (m[0].length - m[0].trimStart().length);
  return src.slice(start, src.indexOf(body, m.index) + body.length);
}

/** One class field declaration line, by name. */
function field(src: string, name: string): string {
  const m = new RegExp(`\\n {2}((?:readonly )?${name}\\b[^\\n]*;)`).exec(src);
  assert.ok(m, `field not found: ${name}`);
  return m[1];
}

/** Strip `//` and block comments (strings kept) for statement checks. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ---- W1/W2 harness: the real wiring members, run ----------------------------

const FIELDS = [
  "#ptServerFlag",
  "#ptProbe",
  "#ptStoreOwner",
  "#ptPlatformVersion",
  "#ptStart",
  "#ptPlatformLogged",
  "#ptStartTimeoutMs",
];

const MEMBERS = [
  /\n {2}#protectedTransportKind\(\): ShellTransportKind /,
  /\n {2}#protectedPlatformInput\(\): StructuralInput /,
  /\n {2}#protectedPlatformState\(\): \{ structural: boolean; hold: boolean \} /,
  /\n {2}#protectedStructural\(\): boolean /,
  /\n {2}structuralShell\(\): boolean /,
  /\n {2}protectedTextCapable\(\): boolean /,
  /\n {2}#protectedNoteStoreOwner\(/,
  /\n {2}#protectedPlatformChanged\(\): void /,
  /\n {2}#protectedPlatformStart\(\): Promise<void> \| null /,
  /\n {2}async #protectedPlatformDecide\(\): Promise<void> /,
  /\n {2}async #protectedFlagFetch\(\): Promise<FlagEvent> /,
  /\n {2}async #protectedAndroidProbe\(\): Promise<AndroidProbe> /,
  /\n {2}#protectedWithin</,
  /\n {2}#protectedFlagKey\(/,
  /\n {2}#protectedFlagLastKnown\(/,
  /\n {2}#protectedFlagRemember\(/,
  /\n {2}#protectedPlatformLog\(\): void /,
  /\n {2}async #checkStoreOwner\(retry = false\): Promise<void> /,
];

type Deferred<T> = {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Shell = "tauri" | "electron" | "android" | "ios" | "web";

interface Env {
  shell: Shell;
  /** `slogaShell.e2ee.protectedText` (Electron only). */
  protectedText?: unknown;
  popout?: boolean;
  overlay?: boolean;
  userId?: string | null;
  /** `client.api.get("/")`. */
  fetch?: () => Promise<unknown>;
  /** The plugin's `textCapability()`. */
  probe?: () => Promise<unknown>;
  /** `#invoke("e2ee_store_owner")`. */
  storeOwner?: () => Promise<unknown>;
  /** localStorage contents; `throws` makes every access throw. */
  storage?: Map<string, string> | "throws";
}

interface Bridge {
  status: Map<string, unknown>;
  storeOwnedByAnotherAccount: Map<string, number>;
  deviceOwnedElsewhere: Map<string, number>;
  raised: number;
  structural(): boolean;
  state(): { structural: boolean; hold: boolean };
  input(): Record<string, unknown>;
  structuralShell(): boolean;
  protectedTextCapable(): boolean;
  start(): Promise<void> | null;
  checkOwner(): Promise<void>;
  noteOwner(check: unknown): void;
  /** W4 A-1: a successful owner read happened (`#storeOwnerUnread` clear). */
  readOk(): void;
  unread(): boolean;
  owner(): unknown;
  flag(): string;
  probe(): unknown;
  version(): number | undefined;
  log(): void;
}

interface Rig {
  bridge: Bridge;
  info: string[];
  errors: unknown[][];
  fetches: number;
  probes: number;
  timers: { ms: number; fire(): void; cleared: boolean }[];
  storage: Map<string, string> | "throws";
  /** Fire every pending (uncleared) timer. */
  fireTimers(): void;
}

function rig(env: Env): Rig {
  const info: string[] = [];
  const errors: unknown[][] = [];
  const timers: Rig["timers"] = [];
  const storage = env.storage ?? new Map<string, string>();
  const r = {
    info,
    errors,
    fetches: 0,
    probes: 0,
    timers,
    storage,
    fireTimers() {
      for (const t of timers) if (!t.cleared) t.fire();
    },
  } as Rig;

  const fieldDecls = FIELDS.map((name) => field(SRC, name));
  const members = MEMBERS.map((head) => memberDecl(SRC, head));
  const ts = `class Bridge {
  #transport;
  #client;
  status = new Map();
  storeOwnedByAnotherAccount = new Map();
  deviceOwnedElsewhere = new Map();
  raised = 0;
  constructor(transport, client) {
    this.#transport = transport;
    this.#client = client;
  }
  async #invoke(cmd) {
    if (cmd !== "e2ee_store_owner") throw new Error("unexpected " + cmd);
    return env.storeOwner ? env.storeOwner() : null;
  }
  #raiseStoreOwnedByAnotherAccount() { this.raised++; }
  // W4 S1-final A-1 (merge re-anchor): its read state, retries and boot gate.
  #storeOwnerUnread = true;
  #storeOwnerRetries = 0;
  #storeOwnerRetryTimer = null;
  #scheduleStoreOwnerRetry() {}
  #protectedBootManager() {}
  readOk() { this.#storeOwnerUnread = false; }
  unread() { return this.#storeOwnerUnread; }
  structural() { return this.#protectedStructural(); }
  state() { return this.#protectedPlatformState(); }
  input() { return this.#protectedPlatformInput(); }
  start() { return this.#protectedPlatformStart(); }
  checkOwner() { return this.#checkStoreOwner(); }
  noteOwner(check) { this.#protectedNoteStoreOwner(check); }
  owner() { return this.#ptStoreOwner; }
  flag() { return this.#ptServerFlag; }
  probe() { return this.#ptProbe; }
  version() { return this.#ptPlatformVersion.get("state"); }
  log() { this.#protectedPlatformLog(); }
  ${fieldDecls.join("\n  ")}
  ${members.join("\n  ")}
}`;
  // Plain JS (no types): the stubs and the construction.
  const js = `
class TauriTransport {}
class ElectronTransport {}
class CapacitorTransport {
  textCapability() { rig.probes++; return env.probe ? env.probe() : new Promise(() => {}); }
}
const transport =
  env.shell === "tauri" ? new TauriTransport()
  : env.shell === "electron" ? new ElectronTransport()
  : new CapacitorTransport();
const client = {
  user: env.userId === null ? undefined : { id: env.userId ?? "U1" },
  api: {
    get(path) {
      if (path !== "/") throw new Error("unexpected path " + path);
      rig.fetches++;
      return env.fetch ? env.fetch() : new Promise(() => {});
    },
  },
};
return new Bridge(transport, client);`;

  const capacitor = {
    isNativePlatform: () => env.shell === "android" || env.shell === "ios",
    getPlatform: () =>
      env.shell === "android" ? "android" : env.shell === "ios" ? "ios" : "web",
  };
  const win =
    env.shell === "electron"
      ? {
          slogaShell: {
            e2ee:
              "protectedText" in env
                ? { protectedText: env.protectedText }
                : {},
          },
        }
      : {};
  const fakeGlobal = {
    get localStorage() {
      if (storage === "throws") throw new Error("storage denied");
      return {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, v),
      };
    },
  };
  const fakeSetTimeout = (fn: () => void, ms: number) => {
    const t = { ms, cleared: false, fire: fn };
    timers.push(t);
    return timers.length;
  };
  const fakeClearTimeout = (id: number) => {
    if (timers[id - 1]) timers[id - 1].cleared = true;
  };
  const fakeConsole = {
    info: (line: string) => info.push(line),
    error: (...a: unknown[]) => errors.push(a),
    warn: (...a: unknown[]) => errors.push(a),
  };
  const bridge = new Function(
    "env",
    "rig",
    "Capacitor",
    "window",
    "IS_POPOUT_WINDOW",
    "IS_OVERLAY_WINDOW",
    "ReactiveMap",
    "structuralState",
    "reduceFlag",
    "storeOwnerAllows",
    "protectedPlatformTag",
    "fetchProtectedChannelsFlag",
    "errorName",
    "console",
    "globalThis",
    "setTimeout",
    "clearTimeout",
    `${stripTypeScriptTypes(ts)}\n${js}`,
  )(
    env,
    r,
    capacitor,
    win,
    env.popout ?? false,
    env.overlay ?? false,
    Map,
    structuralState,
    reduceFlag,
    storeOwnerAllows,
    protectedPlatformTag,
    fetchProtectedChannelsFlag,
    String,
    fakeConsole,
    fakeGlobal,
    fakeSetTimeout,
    fakeClearTimeout,
  ) as Bridge;
  r.bridge = bridge;
  return r;
}

/** Let every queued microtask and promise reaction run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const ROOT_ON = {
  features: { protected_channels: { enabled: true, default_device_cap: 0 } },
};
const ROOT_OFF = {
  features: { protected_channels: { enabled: false, default_device_cap: 0 } },
};
const PROBE_OK = { protocol: 1, listenerBridge: true };

/** A finished start: flag answered `root`, probe answered `probe`. */
async function started(env: Env): Promise<Rig> {
  const r = rig(env);
  const p = r.bridge.start();
  if (p) await p;
  return r;
}

function enable(b: Bridge): void {
  b.status.set("state", { enabled: true, device_id: "D1" });
  // W4 A-1 (S13 pins it): no text plane before a successful owner read.
  b.readOk();
}

// ---- W1 structural, as the bridge feeds it -----------------------------------

test("W1: the transport kind and the input carry the right facts per shell", () => {
  const t = rig({ shell: "tauri" }).bridge.input();
  assert.deepEqual(
    { ...t, flag: undefined },
    {
      transport: "tauri",
      platform: "",
      electronProtocol: undefined,
      androidProbe: null,
      popout: false,
      overlay: false,
      flag: undefined,
    },
  );
  const e = rig({ shell: "electron", protectedText: 1 }).bridge.input();
  assert.equal(e.transport, "electron");
  assert.equal(e.platform, "");
  assert.equal(e.electronProtocol, 1);
  assert.equal(e.androidProbe, null);
  const a = rig({ shell: "android" }).bridge.input();
  assert.equal(a.transport, "capacitor");
  assert.equal(a.platform, "android");
  assert.deepEqual(a.androidProbe, { state: "pending" }, "pending until asked");
  const i = rig({ shell: "ios" }).bridge.input();
  assert.equal(i.transport, "capacitor");
  assert.equal(i.platform, "ios");
  assert.equal(i.androidProbe, null, "no probe off Android");
  assert.equal(rig({ shell: "web" }).bridge.input().transport, "web");
  assert.equal(
    rig({ shell: "electron", protectedText: "1" }).bridge.input()
      .electronProtocol,
    undefined,
    "only a number is a protocol",
  );
  assert.equal(
    rig({ shell: "electron" }).bridge.input().electronProtocol,
    undefined,
  );
  const p = rig({ shell: "tauri", popout: true, overlay: true }).bridge.input();
  assert.equal(p.popout, true);
  assert.equal(p.overlay, true);
});

test("W1: Tauri stays structural and never holds; the flag is not consulted", async () => {
  const r = rig({ shell: "tauri" });
  assert.deepEqual(r.bridge.state(), { structural: true, hold: false });
  assert.equal(r.bridge.start(), null, "Tauri awaits nothing new");
  assert.equal(r.fetches, 0, "no flag fetch on Tauri");
  assert.deepEqual(r.bridge.state(), { structural: true, hold: false });
  assert.equal(r.bridge.structuralShell(), true);
  for (const flag of ["popout", "overlay"] as const) {
    const w = rig({ shell: "tauri", [flag]: true });
    assert.equal(w.bridge.structural(), false, `${flag} is never structural`);
    assert.equal(w.bridge.start(), null);
  }
});

test("W1: iOS, web and an Electron shell without protocol 1 are closed and never start", async () => {
  for (const env of [
    { shell: "ios" },
    { shell: "web" },
    { shell: "electron" },
    { shell: "electron", protectedText: 2 },
    { shell: "electron", protectedText: "1" },
    { shell: "android", popout: true },
  ] as Env[]) {
    const r = rig({
      ...env,
      fetch: async () => ROOT_ON,
      probe: async () => PROBE_OK,
    });
    const label = JSON.stringify(env);
    assert.deepEqual(
      r.bridge.state(),
      { structural: false, hold: false },
      label,
    );
    assert.equal(r.bridge.start(), null, `${label}: nothing to settle`);
    assert.equal(r.fetches + r.probes, 0, `${label}: nothing asked`);
    assert.equal(r.bridge.structural(), false, label);
    assert.equal(r.bridge.structuralShell(), false, label);
  }
});

test("W1: Electron protocol 1 holds until the flag is settled, then follows it", async () => {
  const root = deferred<unknown>();
  const r = rig({
    shell: "electron",
    protectedText: 1,
    fetch: () => root.promise,
  });
  assert.deepEqual(r.bridge.state(), { structural: true, hold: true });
  const p = r.bridge.start();
  assert.ok(p, "a start to await");
  assert.equal(r.bridge.start(), p, "one start per bridge");
  assert.equal(r.fetches, 1, "fetched once, independently of capability");
  assert.equal(r.probes, 0, "no Android probe on Electron");
  assert.deepEqual(r.bridge.state(), { structural: true, hold: true });
  root.resolve(ROOT_ON);
  await p;
  assert.deepEqual(r.bridge.state(), { structural: true, hold: false });
  assert.equal(r.bridge.flag(), "on");
  assert.equal(r.bridge.structuralShell(), true);
  assert.equal(r.fetches, 1);
});

test("W1: Android holds while the probe is pending, then follows probe and flag", async () => {
  const probe = deferred<unknown>();
  const r = rig({
    shell: "android",
    fetch: async () => ROOT_ON,
    probe: () => probe.promise,
  });
  assert.deepEqual(
    r.bridge.state(),
    { structural: true, hold: true },
    "pending",
  );
  const p = r.bridge.start();
  assert.ok(p);
  await settle();
  assert.equal(r.probes, 1, "probed once");
  assert.deepEqual(
    r.bridge.state(),
    { structural: true, hold: true },
    "still pending",
  );
  probe.resolve(PROBE_OK);
  await p;
  assert.deepEqual(r.bridge.probe(), { state: "ok", value: PROBE_OK });
  assert.deepEqual(r.bridge.state(), { structural: true, hold: false });

  for (const [answer, why] of [
    [{ protocol: 1, listenerBridge: false }, "legacy bridge"],
    [{ protocol: 2, listenerBridge: true }, "protocol 2"],
    [null, "no answer"],
  ] as const) {
    const x = await started({
      shell: "android",
      fetch: async () => ROOT_ON,
      probe: async () => answer,
    });
    assert.deepEqual(x.bridge.state(), { structural: false, hold: false }, why);
  }
  const rejected = await started({
    shell: "android",
    fetch: async () => ROOT_ON,
    probe: async () => {
      throw { type: "unavailable" };
    },
  });
  assert.deepEqual(rejected.bridge.probe(), { state: "failed" });
  assert.equal(rejected.bridge.structural(), false, "a failed probe is closed");
});

test("W1: a probe that never answers fails at the 5 s deadline; so does the flag", async () => {
  const r = rig({ shell: "android" }); // fetch and probe never settle
  const p = r.bridge.start();
  assert.ok(p);
  await settle();
  assert.deepEqual(
    r.timers.map((t) => t.ms),
    [5000, 5000],
    "one 5 s deadline each for the flag and the probe",
  );
  assert.deepEqual(r.bridge.state(), { structural: true, hold: true });
  r.fireTimers();
  await p;
  assert.deepEqual(r.bridge.probe(), { state: "failed" });
  assert.equal(r.bridge.flag(), "off", "a timeout with no last-known is off");
  assert.deepEqual(r.bridge.state(), { structural: false, hold: false });
  assert.ok(
    r.timers.every((t) => t.cleared),
    "deadlines cleared",
  );
});

// ---- W1 the flag: tri-state, seeded, sticky, reduced only by reduceFlag ------

test("W1: the flag is seeded from this account's last-known value", async () => {
  const storage = new Map([["protected-flag:U1", "on"]]);
  const root = deferred<unknown>();
  const r = rig({
    shell: "electron",
    protectedText: 1,
    storage,
    fetch: () => root.promise,
  });
  const p = r.bridge.start();
  assert.equal(r.bridge.flag(), "on", "seeded before the fetch answers");
  root.reject(new Error("offline"));
  await p;
  assert.equal(r.bridge.flag(), "on", "a failed fetch keeps a known on");
  assert.deepEqual(r.bridge.state(), { structural: true, hold: false });
  // Another account's value is not this account's.
  const other = await started({
    shell: "electron",
    protectedText: 1,
    userId: "U2",
    storage: new Map([["protected-flag:U1", "on"]]),
    fetch: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(other.bridge.flag(), "off");
});

test("W1: a failed fetch with no last-known ends off, never a hold for the bridge's life", async () => {
  const r = await started({
    shell: "electron",
    protectedText: 1,
    fetch: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(r.bridge.flag(), "off");
  assert.deepEqual(r.bridge.state(), { structural: false, hold: false });
  assert.equal(
    r.storage instanceof Map && r.storage.size,
    0,
    "a failure is not persisted",
  );
});

test("W1: a successful off replaces a seeded on, and is persisted", async () => {
  const storage = new Map([["protected-flag:U1", "on"]]);
  const r = await started({
    shell: "electron",
    protectedText: 1,
    storage,
    fetch: async () => ROOT_OFF,
  });
  assert.equal(r.bridge.flag(), "off");
  assert.equal(storage.get("protected-flag:U1"), "off");
  assert.deepEqual(r.bridge.state(), { structural: false, hold: false });
  const on = await started({
    shell: "android",
    fetch: async () => ROOT_ON,
    probe: async () => PROBE_OK,
  });
  assert.equal(
    on.storage instanceof Map && on.storage.get("protected-flag:U1"),
    "on",
  );
});

test("W1: a malformed answer is an answer (off); a timed-out seed on stays on", async () => {
  const bad = await started({
    shell: "electron",
    protectedText: 1,
    fetch: async () => "<html>",
  });
  assert.equal(bad.bridge.flag(), "off");
  const r = rig({
    shell: "electron",
    protectedText: 1,
    storage: new Map([["protected-flag:U1", "on"]]),
  });
  const p = r.bridge.start();
  await settle();
  r.fireTimers();
  await p;
  assert.equal(r.bridge.flag(), "on", "timeout keeps a known value");
});

test("W1: unreadable storage seeds nothing and never throws", async () => {
  const r = await started({
    shell: "electron",
    protectedText: 1,
    storage: "throws",
    fetch: async () => ROOT_ON,
  });
  assert.equal(r.bridge.flag(), "on");
  assert.deepEqual(r.errors, [], "nothing logged as a failure");
});

test("W1: one [protected] platform line per bridge, starting with the marker", async () => {
  const t = rig({ shell: "tauri" });
  t.bridge.start();
  t.bridge.start();
  assert.equal(t.info.length, 1);
  assert.ok(t.info[0].startsWith(`[protected] ${PROTECTED_PLATFORM_MARKER} `));
  assert.match(t.info[0], /transport=tauri .*structural=true hold=false$/);
  const a = rig({
    shell: "android",
    fetch: async () => ROOT_ON,
    probe: async () => PROBE_OK,
  });
  const p = a.bridge.start();
  assert.equal(a.info.length, 0, "logged once settled, not before");
  await p;
  a.bridge.start();
  assert.equal(a.info.length, 1);
  assert.match(
    a.info[0],
    /probe=ok\/protocol=1\/listener=true .*flag=on structural=true hold=false$/,
  );
  assert.ok(!a.info[0].includes("U1"), "no user id in the line");
  // The guard itself: a second log request is a no-op.
  a.bridge.log();
  t.bridge.log();
  assert.equal(a.info.length, 1, "guarded (Android)");
  assert.equal(t.info.length, 1, "guarded (Tauri)");
});

test("W1: nothing is capable while the platform is on hold", async () => {
  const probe = deferred<unknown>();
  const root = deferred<unknown>();
  for (const [why, r, settle] of [
    [
      "Android, probe pending",
      rig({
        shell: "android",
        fetch: async () => ROOT_ON,
        probe: () => probe.promise,
      }),
      () => probe.resolve(PROBE_OK),
    ],
    [
      "Electron, flag unknown",
      rig({ shell: "electron", protectedText: 1, fetch: () => root.promise }),
      () => root.resolve(ROOT_ON),
    ],
  ] as const) {
    const b = r.bridge;
    enable(b);
    b.noteOwner({ state: "known", owner: "U1" });
    const p = b.start();
    assert.ok(p);
    assert.deepEqual(b.state(), { structural: true, hold: true }, why);
    assert.equal(b.structuralShell(), true, `${why}: still a structural shell`);
    assert.equal(
      b.protectedTextCapable(),
      false,
      `${why}: not capable on hold`,
    );
    settle();
    await p;
    assert.equal(
      b.protectedTextCapable(),
      true,
      `${why}: capable once settled`,
    );
  }
});

test("W1: settling bumps the reactive version so UI readers re-evaluate", async () => {
  const r = rig({
    shell: "electron",
    protectedText: 1,
    fetch: async () => ROOT_ON,
  });
  const before = r.bridge.version();
  await r.bridge.start();
  assert.notEqual(r.bridge.version(), before);
  const v = r.bridge.version();
  r.bridge.noteOwner({ state: "known", owner: null });
  assert.notEqual(r.bridge.version(), v);
});

// ---- W1 capability: the A8 store-owner term -----------------------------------

test("W1: Electron and Android need a completed owner check: this account or no owner", async () => {
  for (const env of [
    { shell: "electron", protectedText: 1, fetch: async () => ROOT_ON },
    {
      shell: "android",
      fetch: async () => ROOT_ON,
      probe: async () => PROBE_OK,
    },
  ] as Env[]) {
    const r = await started(env);
    const b = r.bridge;
    enable(b);
    assert.equal(
      b.protectedTextCapable(),
      false,
      `${env.shell}: owner unknown → not capable`,
    );
    b.noteOwner({ state: "known", owner: null });
    assert.equal(b.protectedTextCapable(), true, `${env.shell}: fresh store`);
    b.noteOwner({ state: "known", owner: "U1" });
    assert.equal(b.protectedTextCapable(), true, `${env.shell}: own store`);
    b.noteOwner({ state: "known", owner: "U2" });
    assert.equal(
      b.protectedTextCapable(),
      false,
      `${env.shell}: foreign store`,
    );
    b.noteOwner({ state: "unknown" });
    assert.equal(
      b.protectedTextCapable(),
      false,
      `${env.shell}: unknown again`,
    );
  }
});

test("W1: Tauri keeps W4's latch (unknown is capable); every shell needs a user and live status", async () => {
  const t = rig({ shell: "tauri" }).bridge;
  assert.equal(t.protectedTextCapable(), false, "no status");
  enable(t);
  assert.equal(t.protectedTextCapable(), true, "unknown owner: W4 behaviour");
  t.noteOwner({ state: "known", owner: "U2" });
  assert.equal(t.protectedTextCapable(), false);
  t.noteOwner({ state: "known", owner: null });
  t.storeOwnedByAnotherAccount.set("state", 1);
  assert.equal(t.protectedTextCapable(), false, "the W4 latch still refuses");
  t.storeOwnedByAnotherAccount.delete("state");
  t.deviceOwnedElsewhere.set("state", 1);
  assert.equal(t.protectedTextCapable(), false);
  t.deviceOwnedElsewhere.delete("state");
  t.status.set("state", { enabled: true, device_id: null });
  assert.equal(t.protectedTextCapable(), false, "no device id");
  const anon = rig({ shell: "tauri", userId: null }).bridge;
  enable(anon);
  assert.equal(anon.protectedTextCapable(), false, "no signed-in user");
  const e = (
    await started({
      shell: "electron",
      protectedText: 1,
      userId: null,
      fetch: async () => ROOT_ON,
    })
  ).bridge;
  enable(e);
  e.noteOwner({ state: "known", owner: null });
  assert.equal(e.protectedTextCapable(), false, "Electron: no signed-in user");
});

test("W1: a closed shell is never capable, whatever its status", async () => {
  for (const env of [
    { shell: "ios" },
    { shell: "web" },
    { shell: "electron", protectedText: 1, fetch: async () => ROOT_OFF },
    {
      shell: "android",
      fetch: async () => ROOT_ON,
      probe: async () => ({ protocol: 1, listenerBridge: false }),
    },
  ] as Env[]) {
    const b = (await started(env)).bridge;
    enable(b);
    b.noteOwner({ state: "known", owner: "U1" });
    assert.equal(b.protectedTextCapable(), false, JSON.stringify(env));
  }
});

// ---- W2 #checkStoreOwner, run --------------------------------------------------

test("W2: #checkStoreOwner records the A8 state; its W4 latch is unchanged", async () => {
  const cases: [string, () => Promise<unknown>, unknown, number][] = [
    [
      "no accessor",
      async () => {
        throw new Error("no command");
      },
      { state: "unknown" },
      0,
    ],
    ["no MLS row", async () => null, { state: "known", owner: null }, 0],
    ["empty answer", async () => "", { state: "unknown" }, 0],
    ["undefined answer", async () => undefined, { state: "unknown" }, 0],
    ["own store", async () => "U1", { state: "known", owner: "U1" }, 0],
    ["foreign store", async () => "U2", { state: "known", owner: "U2" }, 1],
  ];
  for (const [why, storeOwner, want, raised] of cases) {
    const b = rig({ shell: "electron", protectedText: 1, storeOwner }).bridge;
    b.storeOwnedByAnotherAccount.set("state", 7);
    await b.checkOwner();
    assert.deepEqual(b.owner(), want, why);
    assert.equal(
      b.unread(),
      why === "no accessor",
      `${why}: W4 A-1 read state`,
    );
    assert.equal(b.raised, raised, `${why}: latch raise`);
    assert.equal(
      b.storeOwnedByAnotherAccount.has("state"),
      why !== "own store",
      `${why}: only a matching owner clears the W4 latch`,
    );
  }
  // No signed-in user: nothing asked, nothing recorded.
  const anon = rig({
    shell: "electron",
    userId: null,
    storeOwner: async () => "U1",
  }).bridge;
  await anon.checkOwner();
  assert.deepEqual(anon.owner(), { state: "unknown" });
});

test("W2: #checkStoreOwner keeps W4's final lines; the A8 record precedes them", () => {
  const body = stripComments(
    member(
      SRC,
      /\n {2}async #checkStoreOwner\(retry = false\): Promise<void> /,
    ),
  );
  assert.match(
    body,
    /const userId = this\.#client\.user\?\.id;\s*if \(!userId\) return;/,
  );
  assert.match(
    body,
    /owner = await this\.#invoke<string \| null>\("e2ee_store_owner"\);/,
  );
  assert.match(
    body,
    /\} catch \{\s*this\.#storeOwnerUnread = true;\s*this\.#protectedNoteStoreOwner\(\{ state: "unknown" \}\);\s*this\.#scheduleStoreOwnerRetry\(\);\s*return;\s*\}/,
  );
  assert.match(
    body,
    /if \(owner && owner !== userId\) \{\s*this\.#raiseStoreOwnedByAnotherAccount\(\);\s*return;\s*\}\s*if \(owner\) \{\s*this\.storeOwnedByAnotherAccount\.delete\("state"\);\s*\}\s*if \(wasUnread\) this\.#protectedBootManager\(\);\s*\}$/,
  );
  const record = body.lastIndexOf("#protectedNoteStoreOwner(");
  assert.ok(
    record > body.indexOf("this.#storeOwnerUnread = false;") &&
      record < body.indexOf("if (owner && owner !== userId)"),
    "recorded after a successful read, before the latch decision",
  );
});

test("W2: the store-gone paths record a fresh store (unprovisioned connect, wipe)", () => {
  const onReady = stripComments(
    member(SRC, /\n {2}async #onReady\(\): Promise<void> /),
  );
  assert.match(
    onReady,
    /this\.storeOwnedByAnotherAccount\.delete\("state"\);\s*this\.#protectedNoteStoreOwner\(\{ state: "known", owner: null \}\);/,
    "unprovisioned branch",
  );
  const disable = stripComments(
    member(
      SRC,
      /\n {2}async disable\(\s*mfaTicketToken: string,\s*\): Promise<\{ revokeFailed: boolean; deviceId\?: string \}> /,
    ),
  );
  assert.match(
    disable,
    /this\.storeOwnedByAnotherAccount\.delete\("state"\);\s*this\.#protectedNoteStoreOwner\(\{ state: "known", owner: null \}\);/,
    "wipe",
  );
  // Every W4 latch clear is paired with an owner record.
  assert.equal(
    count(SRC, 'this.storeOwnedByAnotherAccount.delete("state");'),
    3,
  );
  assert.equal(
    count(SRC, "this.#protectedNoteStoreOwner("),
    4,
    "throw, answer, unprovisioned, wipe",
  );
  assert.equal(
    count(SRC, "this.#ptStoreOwner = "),
    1,
    "written only by #protectedNoteStoreOwner",
  );
});

// ---- W3 source shape for what cannot run here ----------------------------------

test("W3: #onReady settles the bridge start before anything else (probe awaited)", () => {
  const onReady = stripComments(
    member(SRC, /\n {2}async #onReady\(\): Promise<void> /),
  );
  assert.match(
    onReady,
    /^\{\s*try \{\s*const platformStart = this\.#protectedPlatformStart\(\);\s*if \(platformStart\) await platformStart;\s*const provisioned = await this\.#isProvisioned\(\);/,
    "the first statements of the try",
  );
  const start = onReady.indexOf("await platformStart;");
  for (const later of [
    "#checkStoreOwner()",
    "refreshStatus()",
    '"E2EERequestChallenge"',
  ]) {
    assert.ok(onReady.indexOf(later) > start, `awaited before ${later}`);
  }
  assert.equal(
    count(SRC, "#protectedPlatformStart("),
    2,
    "declaration + #onReady",
  );
  assert.equal(
    count(SRC, "#protectedPlatformDecide("),
    2,
    "declaration + the start",
  );
});

test("W3: both route helpers take structural from structuralState and AND !hold into indexReady", () => {
  for (const head of [
    /\n {2}#protectedRouteEnvelope\(/,
    /\n {2}#protectedRouteJoinRequest\(/,
  ]) {
    const body = stripComments(member(SRC, head));
    assert.match(
      body,
      /const platform = this\.#protectedPlatformState\(\);\s*const route = routeMls\(\{\s*structural: platform\.structural,\s*indexReady: this\.#ptIndex\.ready && !platform\.hold,/,
      `${head}`,
    );
  }
  assert.equal(count(SRC, "indexReady:"), 2, "no other routeMls input");
  assert.equal(count(SRC, "routeMls({"), 2);
});

test("W3: structural, structuralShell and the state go through structuralState only", () => {
  const norm = (s: string) => stripComments(s).replace(/\s+/g, " ").trim();
  assert.equal(
    norm(member(SRC, /\n {2}#protectedStructural\(\): boolean /)),
    "{ return this.#protectedPlatformState().structural; }",
  );
  assert.equal(
    norm(member(SRC, /\n {2}structuralShell\(\): boolean /)),
    "{ return this.#protectedStructural(); }",
  );
  assert.equal(
    norm(
      member(
        SRC,
        /\n {2}#protectedPlatformState\(\): \{ structural: boolean; hold: boolean \} /,
      ),
    ),
    "{ return structuralState(this.#protectedPlatformInput()); }",
  );
  const capable = stripComments(
    member(SRC, /\n {2}protectedTextCapable\(\): boolean /),
  );
  assert.match(
    capable,
    /storeOwnerAllows\(\s*this\.#protectedTransportKind\(\),\s*this\.#ptStoreOwner,\s*userId,\s*\)/,
  );
  for (const name of [
    "structuralState",
    "reduceFlag",
    "storeOwnerAllows",
    "mapTextInvokeError",
    "protectedPlatformTag",
  ]) {
    assert.match(
      SRC,
      new RegExp(`\\n  ${name},\\n[\\s\\S]*?\\} from "\\./protectedPlatform";`),
      `${name} imported`,
    );
  }
});

test("W3: the server flag is written only through reduceFlag", () => {
  const writes = [...SRC.matchAll(/this\.#ptServerFlag = ([^;]*)/g)];
  assert.ok(writes.length >= 3, "seed, answer, deadline");
  for (const w of writes) {
    assert.match(w[1], /^reduceFlag\(this\.#ptServerFlag, /, `write: ${w[0]}`);
  }
  assert.equal(
    field(SRC, "#ptServerFlag"),
    '#ptServerFlag: FlagState = "unknown";',
  );
});

test("W3: #textInvoke errors reach the manager through mapTextInvokeError", () => {
  const port = stripComments(member(SRC, /\n {2}#protectedPort\(/));
  assert.match(
    port,
    /invoke: <C extends TextCommand>\(cmd: C, args: TextCommandArgs\[C\]\) =>\s*this\.#textInvoke\(cmd, args\)\.catch\(\(error: unknown\) => \{\s*throw mapTextInvokeError\(cmd, error\);\s*\}\),/,
  );
  assert.equal(
    count(SRC, "this.#textInvoke("),
    1,
    "the port is #textInvoke's only caller",
  );
});

test("W3: CapacitorTransport routes the 3 dialog commands to their plugin methods", () => {
  const open = SRC.indexOf(
    "class CapacitorTransport implements NativeTransport {",
  );
  assert.ok(open >= 0);
  const brace = SRC.indexOf("{", open);
  const cls = SRC.slice(brace, matchBrace(SRC, brace));
  const invoke = member(cls, /\n {2}async invoke<T>\(/);
  const routes: [string, string][] = [
    ["e2ee_text_seat_list_sign", "textSeatListSign"],
    ["e2ee_text_owner_confirm_change", "textOwnerConfirmChange"],
    ["e2ee_text_owner_handover_sign", "textOwnerHandoverSign"],
  ];
  for (const [cmd, method] of routes) {
    const re = new RegExp(
      `if \\(command === "${cmd}"\\) \\{\\s*const \\{ json \\} = await this\\.#plugin\\.${method}\\(\\s*\\(args as Record<string, unknown>\\) \\?\\? \\{\\},\\s*\\);\\s*return JSON\\.parse\\(json\\) as T;\\s*\\}`,
    );
    assert.match(invoke, re, `${cmd} → ${method}`);
    assert.ok(
      invoke.search(re) < invoke.indexOf("this.#plugin.call("),
      `${cmd} before call()`,
    );
    assert.equal(count(cls, `this.#plugin.${method}(`), 1);
  }
  const textLits = [
    ...cls.matchAll(/"e2ee_text_\w+"|"e2ee_mls_group_kind"/g),
  ].map((m) => m[0]);
  assert.deepEqual(
    textLits,
    routes.map(([c]) => `"${c}"`),
    "no other text command in the transport",
  );
  assert.match(
    cls,
    /async textCapability\(\): Promise<AndroidTextCapability> \{\s*try \{\s*return await this\.#plugin\.textCapability\(\);\s*\} catch \(error\) \{\s*this\.#rethrow\(error\);\s*\}\s*\}/,
  );
  const plugin = SRC.slice(SRC.indexOf("type E2eeCapacitorPlugin = {"), open);
  for (const [, method] of routes) {
    assert.match(
      plugin,
      new RegExp(
        `\\n {2}${method}\\(\\s*options: Record<string, unknown>,?\\s*\\): Promise<\\{ json: string \\}>;`,
      ),
      `plugin entry ${method}`,
    );
  }
  assert.match(
    plugin,
    /\n {2}textCapability\(\): Promise<AndroidTextCapability>;/,
  );
});

test("W3: the Electron flag is read from slogaShell.e2ee.protectedText, typed as a number", () => {
  const shell = SRC.slice(
    SRC.indexOf("export type SlogaShellGlobal = {"),
    SRC.indexOf("class ElectronTransport"),
  );
  assert.match(shell, /\n {4}protectedText\?: number;/);
  assert.equal([...SRC.matchAll(/\.protectedText\b/g)].length, 1, "one reader");
  assert.equal(
    field(SRC, "#ptStartTimeoutMs"),
    "readonly #ptStartTimeoutMs = 5_000;",
  );
});

test("W3: ProtectedUiApi exposes structuralShell(): boolean", () => {
  const open = TYPES.indexOf("export interface ProtectedUiApi {");
  assert.ok(open >= 0);
  const brace = TYPES.indexOf("{", open);
  const api = TYPES.slice(brace, matchBrace(TYPES, brace));
  assert.match(api, /\n {2}structuralShell\(\): boolean;/);
  assert.match(api, /\n {2}protectedTextCapable\(\): boolean;/);
});

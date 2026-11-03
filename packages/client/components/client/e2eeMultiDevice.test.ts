// Multi-device restore (plan e2ee-multi-device-restore D3-D8, W3 contract
// R0-R12) against the REAL `E2EEBridge`.
//
// Bundled with esbuild the way `e2eeOrphanCourier.test.ts` does it (e2ee.ts
// cannot load under `node --test` directly), then driven on a fake Android
// `E2ee` plugin (`call`, `wipe`, `splitBegin`, `backupRestore`), a fake
// Tauri global for the desktop recovery courier, a fake client that records
// `events.send` and `user.edit`, and a stubbed `fetch`. Every native command,
// HTTP request, socket send and profile edit lands in ONE ordered log, so the
// ordering rules (begin -> PUT -> commit -> claim; DELETE before the flag
// edit) are read straight off it.
//
// `E2EE_MULTI_TS` swaps in another e2ee.ts (resolved against THIS
// directory): the fail-first controls run this file against the 144297ab
// source and against deliberately broken copies.
//
// Run: node --test --conditions=browser components/client/e2eeMultiDevice.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCE =
  process.env.E2EE_MULTI_TS ||
  fileURLToPath(new URL("./e2ee.ts", import.meta.url));
/** The shared-device modal, scanned for its post-split offer. */
const SHARED_TSX =
  process.env.E2EE_SHARED_TSX ||
  fileURLToPath(
    new URL("../modal/modals/E2EEDeviceShared.tsx", import.meta.url),
  );
const EN_CATALOG = fileURLToPath(
  new URL("../i18n/catalogs/en/messages.po", import.meta.url),
);

const USER = "01USER";
const DEV = "01DEVICE";
const NEW = "01NEWDEVICE";
const TWIN_NEW = "01TWINNEW";
const SHARED_KEY = `sloga.e2ee.deviceShared.v1:${USER}:${DEV}`;

type Json = Record<string, unknown>;
type Status = {
  enabled: boolean;
  published: boolean;
  device_id: string | null;
  protocol_version: number;
};

/** One ordered record of everything the bridge did to the outside world. */
let log: string[] = [];
/** Bodies and headers of every HTTP request, in order. */
let requests: { method: string; path: string; headers: Json; body: unknown }[];

/** The fake native engine shared by both transports. */
class Native {
  provisioned = true;
  status: Status = {
    enabled: true,
    published: true,
    device_id: DEV,
    protocol_version: 1,
  };
  /** Per-command overrides: return a value or throw. */
  handlers = new Map<string, (args: Json) => unknown>();
  /** When set, `e2ee_split_commit` waits for `releaseCommit()`. */
  holdCommit = false;
  #commitGate: (() => void) | null = null;
  commitFailures = 0;

  async run(cmd: string, args: Json): Promise<unknown> {
    log.push(`cmd:${cmd}`);
    const handler = this.handlers.get(cmd);
    if (handler) return handler(args);
    switch (cmd) {
      case "e2ee_is_provisioned":
        return this.provisioned;
      case "e2ee_store_owner":
        return USER;
      case "e2ee_status":
        return { ...this.status };
      case "e2ee_sign_claim":
        return "signature";
      case "e2ee_enable":
        return {
          device_id: this.status.device_id ?? DEV,
          protocol_version: 1,
        };
      case "e2ee_mark_published":
        this.status.published = true;
        return null;
      case "e2ee_reconcile_devices":
        return { revoked: [], changed: [], new_devices: [] };
      case "e2ee_split_begin":
        return splitPayload();
      case "e2ee_split_commit":
        if (this.holdCommit) {
          await new Promise<void>((resolve) => (this.#commitGate = resolve));
        }
        if (this.commitFailures > 0) {
          this.commitFailures--;
          throw { type: "storage" };
        }
        this.status.device_id = NEW;
        this.status.published = true;
        return null;
      case "e2ee_wipe":
        this.provisioned = false;
        this.status = {
          enabled: false,
          published: false,
          device_id: null,
          protocol_version: 1,
        };
        return null;
      case "e2ee_downgraded_conversations":
        return [];
      default:
        return null;
    }
  }

  releaseCommit() {
    const gate = this.#commitGate;
    assert.ok(gate, "no commit is waiting");
    this.#commitGate = null;
    this.holdCommit = false;
    gate();
  }
}

function splitPayload(): Json {
  return {
    device_id: NEW,
    protocol_version: 1,
    split_from: DEV,
    split_proof: "proof",
  };
}

/** The Android plugin surface the Capacitor transport calls. */
class FakePlugin {
  splitBegins = 0;
  /** Replace to make `splitBegin` reject (declined, busy, old shell). */
  splitBeginError: unknown = null;
  /** What `backupRestore` resolves with. */
  restoreResult: unknown = null;

  async call(args: { __cmd: string } & Json) {
    const { __cmd, ...rest } = args;
    try {
      return { json: JSON.stringify((await native.run(__cmd, rest)) ?? null) };
    } catch (error) {
      throw new Error(JSON.stringify(error));
    }
  }
  async wipe() {
    try {
      await native.run("e2ee_wipe", {});
    } catch (error) {
      throw new Error(JSON.stringify(error));
    }
    return { json: "null" };
  }
  async splitBegin(args: Json) {
    this.splitBegins++;
    log.push("cmd:e2ee_split_begin");
    if (this.splitBeginError) throw this.splitBeginError;
    assert.equal(typeof args.sessionId, "string", "sessionId passed");
    return { json: JSON.stringify(splitPayload()) };
  }
  async backupRestore() {
    log.push("cmd:backup_restore_dialog");
    return { json: JSON.stringify(this.restoreResult) };
  }
  async addListener() {
    return { remove: async () => {} };
  }
}

type Bridge = {
  status: Map<string, Status & { claimed: boolean }>;
  publishPending: Map<string, Json>;
  deviceShared: Map<string, Json>;
  deviceRemoved: Map<string, Json>;
  ownDeviceAdded: Map<string, Json>;
  splitSupported: Map<string, boolean>;
  reenrollNeeded: Map<string, boolean>;
  onEvent(event: Json): void;
  enable(token: string): Promise<void>;
  finishSetup(token: string): Promise<void>;
  splitDevice(reauth: () => Promise<string | undefined>): Promise<Json>;
  disable(token: string): Promise<Json>;
  retryDeviceRevoke(id: string, token: string): Promise<Json>;
  restoreFromBackup(token: string): Promise<number>;
  removeDevice(
    id: string,
    opts: { deleteBackup: boolean },
    reauth: () => Promise<string | undefined>,
  ): Promise<Json>;
  listOwnDevices(): Promise<Json[]>;
  startOverAsNewDevice(
    reauth: () => Promise<string | undefined>,
  ): Promise<string>;
  dismissDeviceShared(): void;
  disablePreflight(): "shared" | null;
  registerMlsSink(sink: (event: unknown) => void): () => void;
  dispose(): Promise<void>;
};
type BridgeCtor = new (client: unknown) => Bridge;
type EsbuildHook = (
  options: { filter: RegExp; namespace?: string },
  callback: (args: { path: string }) => unknown,
) => void;

let native: Native;
let plugin: FakePlugin;
let storage: Map<string, string>;
/** Server answers, by `METHOD path`; anything else is a 500. */
let routes: Map<string, () => Response>;
let E2EEBridge: BridgeCtor;
let outDir: string;
let tauriListeners: Map<string, (event: { payload: unknown }) => void>;
/** Every bridge a test built, disposed after it (no timer outlives a test). */
let bridges: Bridge[] = [];

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
                    "export const Capacitor = globalThis.__multiStub.Capacitor;" +
                    "export const registerPlugin = () => globalThis.__multiStub.plugin();",
                  loader: "js",
                };
              }
              if (a.path === "@solid-primitives/map") {
                return {
                  contents: "export class ReactiveMap extends Map {}",
                  loader: "js",
                };
              }
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
  outDir = mkdtempSync(join(tmpdir(), "e2ee-multi-"));
  const file = join(outDir, "e2ee.mjs");
  writeFileSync(file, bundled.outputFiles[0].text);

  const g = globalThis as Record<string, unknown>;
  g.window ??= { location: new URL("http://localhost/") };
  g.__multiStub = {
    Capacitor: {
      getPlatform: () => "android",
      isNativePlatform: () => true,
      isPluginAvailable: () => true,
    },
    plugin: () => plugin,
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => ({
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    }),
  });
  g.fetch = async (url: string, init: RequestInit) => {
    const path = url.replace("http://test.invalid", "");
    const method = init.method ?? "GET";
    log.push(`${method} ${path}`);
    requests.push({
      method,
      path,
      headers: (init.headers ?? {}) as Json,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const route = routes.get(`${method} ${path}`);
    return route ? route() : new Response("{}", { status: 500 });
  };
  ({ E2EEBridge } = (await import(pathToFileURL(file).href)) as {
    E2EEBridge: BridgeCtor;
  });
});

after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const quiet = { error: console.error, warn: console.warn };
beforeEach(() => {
  native = new Native();
  plugin = new FakePlugin();
  storage = new Map();
  log = [];
  requests = [];
  tauriListeners = new Map();
  delete (globalThis.window as unknown as Json).__TAURI__;
  routes = new Map([
    [`GET /e2ee/devices/${USER}`, () => json([own(DEV)])],
    ["PUT /e2ee/keys", () => new Response(null, { status: 204 })],
  ]);
  console.error = () => {};
  console.warn = () => {};
});
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.dispose();
});
after(() => {
  console.error = quiet.error;
  console.warn = quiet.warn;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function own(deviceId: string, extra: Json = {}): Json {
  return { device_id: deviceId, one_time_key_count: 50, ...extra };
}

function fakeClient(rootConfig: unknown = splitAdvert()) {
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  const user = {
    id: USER,
    e2eeEnabled: true,
    edits: [] as Json[],
    async edit(patch: Json) {
      log.push(`edit:${JSON.stringify(patch)}`);
      this.edits.push(patch);
    },
  };
  const sent: Json[] = [];
  return {
    user,
    sessionId: "01SESSION",
    authenticationHeader: ["X-Session-Token", "token"],
    options: { baseURL: "http://test.invalid" },
    channels: new Map(),
    sent,
    events: {
      send(event: Json) {
        log.push(`send:${event.type}:${event.device_id ?? ""}`);
        sent.push(event);
      },
    },
    api: {
      root: rootConfig,
      async get(path: string) {
        log.push(`api:GET ${path}`);
        if (this.root instanceof Error) throw this.root;
        return this.root;
      },
    },
    on(name: string, fn: (...a: unknown[]) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    emit(name: string) {
      for (const fn of handlers.get(name) ?? []) fn();
    },
  };
}

function splitAdvert(): Json {
  return { features: { e2ee: { split_from: true } } };
}

/** Let queued promises run; immune to mocked `setTimeout`. */
async function settle() {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
}

/** A bridge whose first `ready` has run. */
async function readyBridge(rootConfig?: unknown) {
  const client = fakeClient(rootConfig);
  const bridge = new E2EEBridge(client);
  bridges.push(bridge);
  client.emit("ready");
  await settle();
  return { bridge, client };
}

/** Claim sends for `deviceId` in `client.sent`. */
function challenges(client: { sent: Json[] }, deviceId?: string): number {
  return client.sent.filter(
    (e) =>
      e.type === "E2EERequestChallenge" &&
      (deviceId === undefined || e.device_id === deviceId),
  ).length;
}

function refused(bridge: Bridge, reason?: string) {
  bridge.onEvent({
    type: "E2EEClaimResult",
    device_id: DEV,
    accepted: false,
    ...(reason === undefined ? {} : { reason }),
  });
}

function nativeCalls(cmd: string): number {
  return log.filter((l) => l === `cmd:${cmd}`).length;
}

// ---- reason:* (R3) ----------------------------------------------------------

test("reason:held_elsewhere - one retry after 160 s, then deviceShared, no more", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { bridge, client } = await readyBridge();
    assert.equal(challenges(client, DEV), 1, "the ready claim");
    log = [];

    refused(bridge, "held_elsewhere");
    await settle();
    assert.equal(challenges(client, DEV), 1, "no immediate retry");
    assert.ok(
      !log.some((l) => l.startsWith("GET /e2ee/devices")),
      "no presence check on a held_elsewhere refusal",
    );
    mock.timers.tick(159_999);
    await settle();
    assert.equal(challenges(client, DEV), 1, "not before 160 s");
    mock.timers.tick(1);
    await settle();
    assert.equal(challenges(client, DEV), 2, "exactly one retry at 160 s");
    assert.equal(bridge.deviceShared.has("state"), false, "not after strike 1");

    refused(bridge, "held_elsewhere");
    await settle();
    assert.equal(bridge.deviceShared.get("state")?.via, "held_elsewhere");
    assert.equal(JSON.parse(storage.get(SHARED_KEY)!).via, "held_elsewhere");
    mock.timers.tick(600_000);
    await settle();
    assert.equal(challenges(client, DEV), 2, "no retry after strike 2");
    assert.equal(nativeCalls("e2ee_backup_rederive_republish"), 0);
  } finally {
    mock.timers.reset();
  }
});

test("reason:held_elsewhere - a ready resets the strikes and clears the timer", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { bridge, client } = await readyBridge();
    refused(bridge, "held_elsewhere");
    await settle();
    client.emit("ready");
    await settle();
    const afterReady = challenges(client, DEV);
    mock.timers.tick(200_000);
    await settle();
    assert.equal(challenges(client, DEV), afterReady, "the old timer is gone");
    refused(bridge, "held_elsewhere");
    await settle();
    assert.equal(bridge.deviceShared.has("state"), false, "strike 1 again");
  } finally {
    mock.timers.reset();
  }
});

test("reason:removed - deviceRemoved, no rederive, no reenrollNeeded", async () => {
  routes.set(`GET /e2ee/devices/${USER}`, () => json([]));
  native.handlers.set("e2ee_backup_rederive_republish", () => ({
    device_id: DEV,
  }));
  const { bridge } = await readyBridge();
  refused(bridge, "removed");
  await settle();
  assert.equal(bridge.deviceRemoved.get("state")?.deviceId, DEV);
  assert.equal(nativeCalls("e2ee_backup_rederive_republish"), 0);
  assert.equal(bridge.reenrollNeeded.has("state"), false);
  assert.equal(bridge.publishPending.has("state"), false);
});

test("reason:none - the legacy rejected-claim path is unchanged", async () => {
  for (const reason of [undefined, "something_else"]) {
    native = new Native();
    log = [];
    routes.set(`GET /e2ee/devices/${USER}`, () => json([]));
    native.handlers.set("e2ee_backup_rederive_republish", () => ({
      device_id: DEV,
    }));
    const { bridge } = await readyBridge();
    refused(bridge, reason);
    await settle();
    assert.equal(nativeCalls("e2ee_backup_rederive_republish"), 1, reason);
    assert.equal(bridge.reenrollNeeded.get("state"), true, reason);
    assert.equal(bridge.deviceRemoved.has("state"), false, reason);
    assert.equal(bridge.deviceShared.has("state"), false, reason);
  }
});

/** Refuse `held_elsewhere` and let it land. */
async function heldElsewhere(bridge: Bridge) {
  refused(bridge, "held_elsewhere");
  await settle();
}

test("reason:held_elsewhere across reconnects - inside 150 s of the first is not shared; at 150 s it is", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { bridge, client } = await readyBridge();
    await heldElsewhere(bridge); // +0, the first
    mock.timers.tick(30_000);
    client.emit("ready");
    await settle();
    mock.timers.tick(10_000);
    await heldElsewhere(bridge); // +40 s, after a reconnect
    assert.equal(bridge.deviceShared.has("state"), false, "+40 s");
    for (const step of [50_000, 50_000]) {
      mock.timers.tick(step);
      client.emit("ready");
      await settle();
    }
    await heldElsewhere(bridge); // +140 s
    assert.equal(bridge.deviceShared.has("state"), false, "+140 s");
    mock.timers.tick(10_000);
    client.emit("ready");
    await settle();
    await heldElsewhere(bridge); // +150 s
    assert.equal(bridge.deviceShared.get("state")?.via, "held_elsewhere");
    assert.equal(JSON.parse(storage.get(SHARED_KEY)!).via, "held_elsewhere");
  } finally {
    mock.timers.reset();
  }
});

test("reason:held_elsewhere across reloads - a new bridge on the same storage counts the first refusal", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const first = await readyBridge();
    await heldElsewhere(first.bridge);
    await first.bridge.dispose();
    mock.timers.tick(40_000);
    const second = await readyBridge();
    await heldElsewhere(second.bridge);
    assert.equal(second.bridge.deviceShared.has("state"), false, "+40 s");
    await second.bridge.dispose();
    mock.timers.tick(110_000);
    const third = await readyBridge();
    await heldElsewhere(third.bridge);
    assert.equal(third.bridge.deviceShared.get("state")?.via, "held_elsewhere");
  } finally {
    mock.timers.reset();
  }
});

test("reason:held_elsewhere - an accepted claim in between starts the count over", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const { bridge, client } = await readyBridge();
    await heldElsewhere(bridge);
    mock.timers.tick(60_000);
    bridge.onEvent({ type: "E2EEClaimResult", device_id: DEV, accepted: true });
    await settle();
    assert.equal(
      storage.has(`sloga.e2ee.heldStrike.v1:${USER}:${DEV}`),
      false,
      "first strike cleared",
    );
    mock.timers.tick(100_000);
    client.emit("ready");
    await settle();
    await heldElsewhere(bridge); // +160 s: a new first
    assert.equal(bridge.deviceShared.has("state"), false);
  } finally {
    mock.timers.reset();
  }
});

test("reason:held_elsewhere - dismiss and wipe forget the first refusal", async () => {
  const key = `sloga.e2ee.heldStrike.v1:${USER}:${DEV}`;
  const { bridge } = await readyBridge();
  await heldElsewhere(bridge);
  assert.ok(storage.has(key), "persisted");
  bridge.dismissDeviceShared();
  assert.equal(storage.has(key), false, "dismiss");
  await heldElsewhere(bridge);
  // disable() refuses a shared install, so the wipe here is start-over's
  assert.equal(
    await bridge.startOverAsNewDevice(async () => undefined),
    "wiped",
  );
  assert.equal(storage.has(key), false, "wipe");
});

test("ui:split-done - the done view offers this device's recovery code, skippable, with existing msgids", () => {
  const tsx = readFileSync(SHARED_TSX, "utf8");
  const start = tsx.indexOf("done()\n          ?");
  assert.ok(start >= 0, "the done branch of the actions");
  const done = tsx.slice(start, tsx.indexOf("\n          : [", start));
  assert.match(
    done,
    /<Trans>Create a recovery code for this device<\/Trans>[\s\S]*\?\.createRecoveryCode\(\)\s*\.catch\(\(error\) => showError\(error\)\)/,
  );
  assert.match(done, /<Trans>Skip for now<\/Trans>/);
  const po = readFileSync(EN_CATALOG, "utf8");
  for (const id of ["Create a recovery code for this device", "Skip for now"]) {
    assert.ok(po.includes(`msgid "${id}"`), `${id} is an existing msgid`);
  }
});

// ---- deviceShared (R4, R6) ----------------------------------------------------

test("deviceShared: a new bridge on the same storage restores it", async () => {
  storage.set(SHARED_KEY, JSON.stringify({ via: "diverged", at: 7 }));
  storage.set(
    `sloga.e2ee.deviceShared.v1:${USER}:OTHER`,
    JSON.stringify({ via: "held_elsewhere", at: 1 }),
  );
  const { bridge } = await readyBridge();
  assert.deepEqual(bridge.deviceShared.get("state"), {
    via: "diverged",
    at: 7,
  });
});

test("deviceShared: a self reconcile reporting divergence raises it", async () => {
  native.handlers.set("e2ee_reconcile_devices", () => ({
    revoked: [],
    changed: [],
    new_devices: [],
    own_device_diverged: true,
  }));
  const { bridge } = await readyBridge();
  bridge.onEvent({ type: "E2EEClaimResult", device_id: DEV, accepted: true });
  await settle();
  assert.equal(bridge.deviceShared.get("state")?.via, "diverged");
  assert.ok(storage.has(SHARED_KEY));
});

test("deviceShared: our twin's split event clears it, re-claims, reconciles, replenishes, and is surfaced", async () => {
  storage.set(SHARED_KEY, JSON.stringify({ via: "held_elsewhere", at: 3 }));
  routes.set(`GET /e2ee/devices/${USER}`, () =>
    json([own(DEV), own(TWIN_NEW, { session_name: "Laptop" })]),
  );
  const { bridge, client } = await readyBridge();
  assert.ok(bridge.deviceShared.has("state"));
  const before = challenges(client, DEV);
  log = [];

  bridge.onEvent({
    type: "E2EEDeviceCreate",
    user_id: USER,
    device_id: TWIN_NEW,
    split_from: DEV,
  });
  await settle();
  assert.equal(bridge.deviceShared.has("state"), false, "cleared");
  assert.equal(storage.has(SHARED_KEY), false, "cleared in storage");
  assert.equal(challenges(client, DEV), before + 1, "re-claimed at once");
  const reconcile = log.indexOf("cmd:e2ee_reconcile_devices");
  const replenish = log.indexOf("cmd:e2ee_replenish");
  assert.ok(
    reconcile >= 0 && replenish > reconcile,
    "reconcile, then replenish",
  );
  assert.deepEqual(
    { ...bridge.ownDeviceAdded.get(TWIN_NEW), at: 0 },
    { deviceId: TWIN_NEW, splitFrom: DEV, sessionName: "Laptop", at: 0 },
    "the twin's split is surfaced (split toast)",
  );
});

test("deviceShared: our own split ECHO neither clears nor claims nor toasts", async () => {
  storage.set(SHARED_KEY, JSON.stringify({ via: "held_elsewhere", at: 3 }));
  const { bridge, client } = await readyBridge();
  native.holdCommit = true;
  const split = bridge.splitDevice(async () => "ticket");
  await settle();
  assert.ok(log.includes("PUT /e2ee/keys"), "published, commit held");
  const before = client.sent.length;

  // The server echoes the split to our private topic before the commit
  bridge.onEvent({
    type: "E2EEDeviceCreate",
    user_id: USER,
    device_id: NEW,
    split_from: DEV,
  });
  await settle();
  assert.equal(client.sent.length, before, "no claim on the echo");
  assert.equal(bridge.ownDeviceAdded.size, 0, "no toast for our own split");
  assert.equal(bridge.deviceShared.get("state")?.via, "held_elsewhere");

  native.releaseCommit();
  assert.equal((await split).kind, "split");
});

test("deviceShared: a late echo of a split whose commit failed changes nothing", async () => {
  storage.set(SHARED_KEY, JSON.stringify({ via: "held_elsewhere", at: 3 }));
  const { bridge, client } = await readyBridge();
  native.commitFailures = 3;
  await assert.rejects(bridge.splitDevice(async () => "ticket"));
  await settle();
  const before = client.sent.length;

  bridge.onEvent({
    type: "E2EEDeviceCreate",
    user_id: USER,
    device_id: NEW,
    split_from: DEV,
  });
  await settle();
  assert.equal(client.sent.length, before, "no claim");
  assert.equal(bridge.deviceShared.get("state")?.via, "held_elsewhere");
  assert.ok(storage.has(SHARED_KEY), "still stored");
  assert.equal(bridge.ownDeviceAdded.size, 0);
});

test("deviceShared: our own enable echo is not another device", async () => {
  native.status = {
    enabled: true,
    published: false,
    device_id: DEV,
    protocol_version: 1,
  };
  const { bridge } = await readyBridge();
  await bridge.finishSetup("ticket");
  bridge.onEvent({ type: "E2EEDeviceCreate", user_id: USER, device_id: DEV });
  await settle();
  assert.equal(bridge.ownDeviceAdded.size, 0);
});

test("deviceShared: another own device is surfaced with its session name", async () => {
  routes.set(`GET /e2ee/devices/${USER}`, () =>
    json([own(DEV), own("01PHONE", { session_name: "Phone" })]),
  );
  const { bridge, client } = await readyBridge();
  const before = challenges(client);
  bridge.onEvent({
    type: "E2EEDeviceCreate",
    user_id: USER,
    device_id: "01PHONE",
  });
  await settle();
  const entry = bridge.ownDeviceAdded.get("01PHONE");
  assert.equal(entry?.splitFrom, null);
  assert.equal(entry?.sessionName, "Phone");
  assert.equal(challenges(client), before, "no re-claim");
});

test("deviceShared: dismiss clears memory and storage; a new refusal raises it again", async () => {
  storage.set(SHARED_KEY, JSON.stringify({ via: "held_elsewhere", at: 3 }));
  const { bridge } = await readyBridge();
  bridge.dismissDeviceShared();
  assert.equal(bridge.deviceShared.has("state"), false);
  assert.equal(storage.has(SHARED_KEY), false);
  refused(bridge, "held_elsewhere");
  refused(bridge, "held_elsewhere");
  await settle();
  assert.equal(bridge.deviceShared.get("state")?.via, "held_elsewhere");
});

// ---- capability (R9) ----------------------------------------------------------

test("capability: without the advert the split is unavailable and never begins", async () => {
  for (const config of [{}, { features: { e2ee: { split_from: false } } }]) {
    plugin = new FakePlugin();
    const { bridge } = await readyBridge(config);
    assert.equal(bridge.splitSupported.get("state"), false);
    const result = await bridge.splitDevice(async () => "ticket");
    assert.deepEqual(result, { kind: "unavailable" });
    assert.equal(plugin.splitBegins, 0, "e2ee_split_begin never invoked");
  }
});

test("capability: a failed probe stays unknown and retries; a success is kept for the bridge", async () => {
  const { bridge, client } = await readyBridge(new Error("offline"));
  assert.equal(bridge.splitSupported.has("state"), false, "unknown = hidden");
  client.api.root = splitAdvert();
  client.emit("ready");
  await settle();
  assert.equal(bridge.splitSupported.get("state"), true, "retried on ready");
  client.api.root = {};
  client.emit("ready");
  await settle();
  assert.equal(bridge.splitSupported.get("state"), true, "not re-probed");
});

// ---- split:* (R5) ---------------------------------------------------------------

test("split:order - begin, PUT (split_from + split_proof + MFA), commit, claim new", async () => {
  storage.set(SHARED_KEY, JSON.stringify({ via: "held_elsewhere", at: 3 }));
  const { bridge, client } = await readyBridge();
  log = [];
  const result = await bridge.splitDevice(async () => "ticket");
  await settle();
  assert.deepEqual(result, {
    kind: "split",
    deviceId: NEW,
    previousDeviceId: DEV,
  });
  const seq = log.filter((l) =>
    [
      "cmd:e2ee_split_begin",
      "PUT /e2ee/keys",
      "cmd:e2ee_split_commit",
      `send:E2EERequestChallenge:${NEW}`,
    ].includes(l),
  );
  assert.deepEqual(seq, [
    "cmd:e2ee_split_begin",
    "PUT /e2ee/keys",
    "cmd:e2ee_split_commit",
    `send:E2EERequestChallenge:${NEW}`,
  ]);
  const put = requests.find((r) => r.method === "PUT")!;
  assert.equal((put.body as Json).split_from, DEV);
  assert.equal((put.body as Json).split_proof, "proof");
  assert.equal(put.headers["X-MFA-Ticket"], "ticket");
  assert.equal(nativeCalls("e2ee_split_discard"), 0);
  assert.equal(bridge.status.get("state")?.device_id, NEW);
  assert.equal(bridge.deviceShared.has("state"), false, "split clears it");
  assert.equal(storage.has(SHARED_KEY), false);
  assert.equal(challenges(client, DEV), 1, "only the ready claim for old");
});

test("split:hold - a ready and a challenge between PUT and commit send no claim and no proof", async () => {
  const { bridge, client } = await readyBridge();
  native.holdCommit = true;
  const split = bridge.splitDevice(async () => "ticket");
  await settle();
  assert.ok(log.includes("PUT /e2ee/keys"));
  log = [];
  const before = client.sent.length;

  client.emit("ready"); // a reconnect mid-split
  bridge.onEvent({ type: "E2EEChallenge", nonce: "n1" });
  await settle();
  assert.equal(client.sent.length, before, "nothing sent mid-split");
  assert.equal(nativeCalls("e2ee_sign_claim"), 0, "no proof signed");
  assert.equal(
    nativeCalls("e2ee_split_discard"),
    0,
    "a ready mid-split keeps this page's own stage",
  );

  native.releaseCommit();
  assert.equal((await split).kind, "split");
  await settle();
  assert.deepEqual(
    client.sent.slice(before).map((e) => `${e.type}:${e.device_id}`),
    [`E2EERequestChallenge:${NEW}`],
    "after the commit: one claim, for the new device",
  );
});

test("split:put-error - discard, claim old at once, rethrow", async () => {
  routes.set("PUT /e2ee/keys", () => json({ type: "InternalError" }, 500));
  const { bridge, client } = await readyBridge();
  log = [];
  await assert.rejects(
    bridge.splitDevice(async () => "ticket"),
    /PUT \/e2ee\/keys failed: 500$/,
  );
  assert.equal(nativeCalls("e2ee_split_discard"), 1);
  assert.equal(nativeCalls("e2ee_split_commit"), 0);
  assert.ok(log.includes(`send:E2EERequestChallenge:${DEV}`), "old re-claimed");
  assert.ok(
    log.indexOf("PUT /e2ee/keys") <
      log.indexOf(`send:E2EERequestChallenge:${DEV}`),
  );
  assert.equal(challenges(client, NEW), 0);
  assert.equal(bridge.deviceRemoved.has("state"), false);
});

test("split:put-removed - E2EEDeviceRemoved on the split publish does not mark the OLD device removed", async () => {
  routes.set("PUT /e2ee/keys", () => json({ type: "E2EEDeviceRemoved" }, 403));
  const { bridge, client } = await readyBridge();
  log = [];
  const before = challenges(client, DEV);
  await assert.rejects(
    bridge.splitDevice(async () => "ticket"),
    (error: Error & { type?: string; status?: number }) =>
      error.type === "E2EEDeviceRemoved" &&
      error.status === 403 &&
      error.message === "E2EE API PUT /e2ee/keys failed: 403",
  );
  assert.equal(bridge.deviceRemoved.has("state"), false, "old id not removed");
  assert.equal(nativeCalls("e2ee_split_discard"), 1, "stage discarded");
  assert.equal(challenges(client, DEV), before + 1, "old device re-claimed");
});

test("split:commit-fails-3x - three commits, discard, claim old, rethrow", async () => {
  native.commitFailures = 3;
  const { bridge, client } = await readyBridge();
  log = [];
  await assert.rejects(bridge.splitDevice(async () => "ticket"));
  assert.equal(nativeCalls("e2ee_split_commit"), 3);
  assert.equal(nativeCalls("e2ee_split_discard"), 1);
  assert.ok(
    log.lastIndexOf("cmd:e2ee_split_commit") <
      log.indexOf(`send:E2EERequestChallenge:${DEV}`),
  );
  assert.equal(challenges(client, NEW), 0);
  assert.equal(bridge.status.get("state")?.device_id, DEV);
});

test("split:commit-fails-2x - the third try commits", async () => {
  native.commitFailures = 2;
  const { bridge } = await readyBridge();
  log = [];
  assert.equal((await bridge.splitDevice(async () => "ticket")).kind, "split");
  assert.equal(nativeCalls("e2ee_split_commit"), 3);
  assert.equal(nativeCalls("e2ee_split_discard"), 0);
});

test("split:no-publish - declined, busy, cancelled and an old shell never PUT", async () => {
  const cases: [string, unknown, () => Promise<string | undefined>][] = [
    [
      "declined",
      new Error(JSON.stringify({ type: "declined" })),
      async () => "t",
    ],
    ["busy", new Error(JSON.stringify({ type: "busy" })), async () => "t"],
    ["cancelled", null, async () => undefined],
    [
      "unavailable",
      new TypeError("splitBegin is not a function"),
      async () => "t",
    ],
  ];
  for (const [kind, error, reauth] of cases) {
    native = new Native();
    plugin = new FakePlugin();
    plugin.splitBeginError = error;
    requests = [];
    const { bridge, client } = await readyBridge();
    log = [];
    const before = challenges(client, DEV);
    assert.deepEqual(await bridge.splitDevice(reauth), { kind }, kind);
    assert.equal(
      requests.filter((r) => r.method === "PUT").length,
      0,
      `${kind}: no PUT`,
    );
    assert.equal(nativeCalls("e2ee_split_commit"), 0, kind);
    assert.equal(
      nativeCalls("e2ee_split_discard"),
      1,
      `${kind}: any end after a begin drops a stage that may be left`,
    );
    assert.equal(challenges(client, DEV), before, `${kind}: no extra claim`);
    // A later split is not stuck behind the ended one
    plugin.splitBeginError = null;
    assert.equal((await bridge.splitDevice(async () => "t")).kind, "split");
  }
});

test("split:other-error - an unknown native error rethrows and ends the split", async () => {
  plugin.splitBeginError = new Error(JSON.stringify({ type: "storage" }));
  const { bridge } = await readyBridge();
  await assert.rejects(bridge.splitDevice(async () => "t"));
  plugin.splitBeginError = null;
  assert.equal((await bridge.splitDevice(async () => "t")).kind, "split");
});

test("split:stale-stage - a ready drops a stage left by an earlier page, before any claim", async () => {
  const { client } = await readyBridge();
  const discard = log.indexOf("cmd:e2ee_split_discard");
  const claim = log.indexOf(`send:E2EERequestChallenge:${DEV}`);
  assert.ok(discard >= 0, "discarded on ready");
  assert.ok(discard < claim, log.join(" | "));
  assert.equal(challenges(client, DEV), 1);
});

test("split:stale-stage - an old shell without the command still claims", async () => {
  native.handlers.set("e2ee_split_discard", () => {
    throw new TypeError("e2ee.splitDiscard is not a function");
  });
  const { client } = await readyBridge();
  assert.equal(challenges(client, DEV), 1);
});

test("split:in-call - refused with no native prompt while a call session is active", async () => {
  const { bridge } = await readyBridge();
  const unregister = bridge.registerMlsSink(() => {});
  log = [];
  assert.deepEqual(await bridge.splitDevice(async () => "t"), {
    kind: "in_call",
  });
  assert.equal(plugin.splitBegins, 0, "no begin, so no native prompt");
  assert.equal(log.length, 0, "nothing native, nothing sent");
  unregister();
  assert.equal((await bridge.splitDevice(async () => "t")).kind, "split");
});

test("split:tail-throws - the new device is still claimed and the split ends", async () => {
  const { bridge, client } = await readyBridge();
  const status = bridge.status;
  const realSet = status.set.bind(status);
  native.handlers.set("e2ee_split_commit", () => {
    native.status.device_id = NEW;
    // Every status write in the post-commit housekeeping throws
    status.set = () => {
      throw new Error("housekeeping");
    };
    return null;
  });
  const result = await bridge.splitDevice(async () => "ticket");
  status.set = realSet;
  assert.equal(result.kind, "split");
  assert.equal(challenges(client, NEW), 1, "claimed the new device");
  // A later split is not refused as "already splitting"
  native.handlers.delete("e2ee_split_commit");
  native.status.device_id = DEV;
  realSet("state", { ...native.status, claimed: true });
  assert.equal(
    (await bridge.splitDevice(async () => "t")).kind,
    "split",
    "#split was cleared",
  );
});

test("split:commit-landed - a commit reported failed but landed is committed, the old id never re-claimed", async () => {
  native.handlers.set("e2ee_split_commit", () => {
    native.status.device_id = NEW;
    throw { type: "storage" };
  });
  const { bridge, client } = await readyBridge();
  log = [];
  const before = challenges(client, DEV);
  const result = await bridge.splitDevice(async () => "ticket");
  assert.equal(result.kind, "split");
  assert.equal(nativeCalls("e2ee_split_commit"), 1, "no retry once landed");
  assert.equal(nativeCalls("e2ee_split_discard"), 0);
  assert.equal(challenges(client, DEV), before, "old id not re-claimed");
  assert.equal(challenges(client, NEW), 1);
});

// ---- publishPending:* (R1, R2, D3) ----------------------------------------------

function unpublished() {
  native.status = {
    enabled: true,
    published: false,
    device_id: DEV,
    protocol_version: 1,
  };
}

test("publishPending:resume - an unpublished store is pending, unclaimed, unadvertised", async () => {
  unpublished();
  const client = fakeClient();
  client.user.e2eeEnabled = false;
  const bridge = new E2EEBridge(client);
  bridges.push(bridge);
  client.emit("ready");
  await settle();
  assert.equal(bridge.publishPending.get("state")?.via, "resume");
  assert.equal(bridge.publishPending.get("state")?.sourceDeviceId, null);
  assert.equal(challenges(client), 0, "no claim before publish");
  assert.equal(client.user.edits.length, 0, "no opt-in advertisement");
});

test("publishPending:failed-publish - a refused finishSetup leaves it; a new bridge re-raises it", async () => {
  unpublished();
  routes.set("PUT /e2ee/keys", () => json({ type: "InvalidCredentials" }, 401));
  const { bridge } = await readyBridge();
  await assert.rejects(bridge.finishSetup("ticket"));
  assert.ok(bridge.publishPending.has("state"), "still pending");

  const { bridge: second, client } = await readyBridge();
  assert.equal(second.publishPending.get("state")?.via, "resume");
  assert.equal(challenges(client), 0);
});

test("publishPending:finishSetup - PUT with the ticket, mark_published, cleared, claim", async () => {
  unpublished();
  const { bridge, client } = await readyBridge();
  log = [];
  await bridge.finishSetup("ticket");
  await settle();
  const put = requests.find((r) => r.method === "PUT")!;
  assert.equal(put.headers["X-MFA-Ticket"], "ticket");
  assert.ok(
    log.indexOf("PUT /e2ee/keys") < log.indexOf("cmd:e2ee_mark_published"),
  );
  assert.equal(bridge.publishPending.has("state"), false);
  assert.equal(challenges(client, DEV), 1, "claimed after publishing");
});

test("publishPending:removed - a first publish refused as removed raises deviceRemoved", async () => {
  unpublished();
  routes.set("PUT /e2ee/keys", () => json({ type: "E2EEDeviceRemoved" }, 403));
  const { bridge } = await readyBridge();
  await assert.rejects(bridge.finishSetup("ticket"));
  assert.equal(bridge.deviceRemoved.get("state")?.deviceId, DEV);
  assert.equal(bridge.publishPending.has("state"), false);
});

test("publishPending:restore-dialog - null and a RestoreReport are pending and unclaimed", async () => {
  routes.set("GET /e2ee/backup", () =>
    json({ backups: [{ header: "h", ciphertext: "c", generation: 1 }] }),
  );
  for (const [result, source] of [
    [null, null],
    [{ new_device_id: DEV, device_id: "01SOURCE" }, "01SOURCE"],
  ] as const) {
    native = new Native();
    native.provisioned = false;
    plugin = new FakePlugin();
    const { bridge, client } = await readyBridge();
    plugin.restoreResult = result;
    unpublished();
    assert.equal(await bridge.restoreFromBackup("ticket"), 1);
    await settle();
    assert.deepEqual(
      {
        via: bridge.publishPending.get("state")?.via,
        source: bridge.publishPending.get("state")?.sourceDeviceId,
      },
      { via: "restore", source },
    );
    assert.equal(challenges(client), 0, "no claim before publish");
  }
});

test("publishPending:restore-dialog-legacy - an older shell's republish keeps the §6.4 path", async () => {
  routes.set("GET /e2ee/backup", () =>
    json({ backups: [{ header: "h", ciphertext: "c", generation: 1 }] }),
  );
  native.provisioned = false;
  const { bridge, client } = await readyBridge();
  plugin.restoreResult = { device_id: DEV, one_time_keys: [] };
  native.provisioned = true;
  await bridge.restoreFromBackup("ticket");
  await settle();
  assert.equal(bridge.publishPending.has("state"), false);
  assert.equal(challenges(client, DEV), 1, "claimed");
  requests = [];
  bridge.onEvent({ type: "E2EEClaimResult", device_id: DEV, accepted: true });
  await settle();
  const put = requests.find((r) => r.method === "PUT");
  assert.equal(
    (put?.body as Json | undefined)?.replace_one_time_keys,
    true,
    "the stashed republish drains after the claim",
  );
});

test("publishPending:restore-courier - desktop: a null take is pending and unclaimed; a payload claims", async () => {
  routes.set("GET /e2ee/backup", () =>
    json({ backups: [{ header: "h", ciphertext: "c", generation: 1 }] }),
  );
  for (const [take, published] of [
    [null, false],
    [null, true],
    [{ device_id: DEV }, true],
  ] as const) {
    native = new Native();
    native.provisioned = false;
    tauriListeners = new Map();
    (globalThis.window as unknown as Json).__TAURI__ = {
      core: {
        invoke: (cmd: string, args?: Json) => native.run(cmd, args ?? {}),
      },
      event: {
        listen: async (
          name: string,
          fn: (event: { payload: unknown }) => void,
        ) => {
          tauriListeners.set(name, fn);
          return () => {};
        },
      },
    };
    native.handlers.set("e2ee_backup_take_pending_republish", () => take);
    const { bridge, client } = await readyBridge();
    await bridge.restoreFromBackup("ticket");
    if (!published) unpublished();
    else native.provisioned = true;
    const listener = tauriListeners.get("e2ee:recovery-complete");
    assert.ok(listener, "courier subscribed");
    listener({ payload: "restore" });
    await settle();
    if (!published) {
      assert.equal(bridge.publishPending.get("state")?.via, "restore");
      assert.equal(challenges(client), 0, "no claim before publish");
    } else if (take === null) {
      assert.equal(bridge.publishPending.has("state"), false);
      assert.equal(challenges(client, DEV), 1, "a published store claims");
    } else {
      assert.equal(bridge.publishPending.has("state"), false);
      assert.equal(challenges(client, DEV), 1, "legacy restore claims");
    }
    await bridge.dispose();
  }
  delete (globalThis.window as unknown as Json).__TAURI__;
});

// ---- disable:* (R8) ------------------------------------------------------------

function revokeAnswer(response: () => Response) {
  routes.set(`DELETE /e2ee/keys/${DEV}`, response);
}

function flagEdits(): number {
  return log.filter((l) => l === 'edit:{"e2ee_enabled":false}').length;
}

test("disable:remaining-1 - the opt-in flag stays", async () => {
  revokeAnswer(() => json({ remaining_devices: 1 }));
  const { bridge } = await readyBridge();
  const result = await bridge.disable("ticket");
  assert.equal(result.remainingDevices, 1);
  assert.equal(result.revokeFailed, false);
  assert.equal(flagEdits(), 0);
});

test("disable:500-and-204 - a failed or count-less revoke keeps the flag", async () => {
  for (const [response, failed] of [
    [() => json({ type: "InternalError" }, 500), true],
    [() => new Response(null, { status: 204 }), false],
    [() => json({ remaining_devices: -1 }), false],
  ] as const) {
    native = new Native();
    log = [];
    revokeAnswer(response);
    const { bridge } = await readyBridge();
    const result = await bridge.disable("ticket");
    assert.equal(result.remainingDevices, null);
    assert.equal(result.revokeFailed, failed);
    assert.equal(flagEdits(), 0);
  }
});

test("disable:remaining-0 - the flag clears, after the DELETE", async () => {
  revokeAnswer(() => json({ remaining_devices: 0 }));
  const { bridge } = await readyBridge();
  log = [];
  const result = await bridge.disable("ticket");
  assert.equal(result.remainingDevices, 0);
  assert.equal(flagEdits(), 1);
  const wipe = log.indexOf("cmd:e2ee_wipe");
  const del = log.indexOf(`DELETE /e2ee/keys/${DEV}`);
  const edit = log.indexOf('edit:{"e2ee_enabled":false}');
  assert.ok(wipe >= 0 && wipe < del && del < edit, log.join(" | "));
});

test("disable:declined - a refused wipe changes nothing", async () => {
  native.handlers.set("e2ee_wipe", () => {
    throw { type: "declined" };
  });
  const { bridge } = await readyBridge();
  await assert.rejects(bridge.disable("ticket"));
  assert.equal(log.filter((l) => l.startsWith("DELETE")).length, 0);
  assert.equal(bridge.status.get("state")?.device_id, DEV);
});

test("wipe - deviceShared goes with the wiped device", async () => {
  // disable() refuses a shared install, so the wipe here is start-over's
  storage.set(SHARED_KEY, JSON.stringify({ via: "diverged", at: 1 }));
  const { bridge } = await readyBridge();
  assert.equal(
    await bridge.startOverAsNewDevice(async () => undefined),
    "wiped",
  );
  assert.equal(bridge.deviceShared.has("state"), false);
  assert.equal(storage.has(SHARED_KEY), false);
});

test("retryDeviceRevoke - the flag clears only at 0; a 404 is success with no count", async () => {
  for (const [response, remaining, edits] of [
    [() => json({ remaining_devices: 0 }), 0, 1],
    [() => json({ remaining_devices: 2 }), 2, 0],
    [() => json({ type: "NotFound" }, 404), null, 0],
  ] as const) {
    log = [];
    revokeAnswer(response);
    const { bridge } = await readyBridge();
    const result = await bridge.retryDeviceRevoke(DEV, "ticket");
    assert.deepEqual(result, { remainingDevices: remaining });
    assert.equal(flagEdits(), edits);
  }
});

test("disable:no-count - an empty own listing clears the flag; any other answer keeps it", async () => {
  for (const [name, revoke, listing, edits, failed] of [
    [
      "204 + []",
      () => new Response(null, { status: 204 }),
      () => json([]),
      1,
      false,
    ],
    [
      "404 + []",
      () => json({ type: "NotFound" }, 404),
      () => json([]),
      1,
      false,
    ],
    [
      "204 + listing 500",
      () => new Response(null, { status: 204 }),
      () => json({}, 500),
      0,
      false,
    ],
    [
      "204 + non-array",
      () => new Response(null, { status: 204 }),
      () => json({}),
      0,
      false,
    ],
    [
      "500 + []",
      () => json({ type: "InternalError" }, 500),
      () => json([]),
      0,
      true,
    ],
  ] as const) {
    native = new Native();
    revokeAnswer(revoke);
    const { bridge } = await readyBridge();
    routes.set(`GET /e2ee/devices/${USER}`, listing);
    log = [];
    const result = await bridge.disable("ticket");
    assert.equal(flagEdits(), edits, name);
    assert.equal(result.revokeFailed, failed, name);
    routes.set(`GET /e2ee/devices/${USER}`, () => json([own(DEV)]));
  }
});

test("retryDeviceRevoke:no-count - a 404 with an empty own listing clears the flag", async () => {
  revokeAnswer(() => json({ type: "NotFound" }, 404));
  const { bridge } = await readyBridge();
  routes.set(`GET /e2ee/devices/${USER}`, () => json([]));
  log = [];
  assert.deepEqual(await bridge.retryDeviceRevoke(DEV, "ticket"), {
    remainingDevices: null,
  });
  assert.equal(flagEdits(), 1);
});

// ---- devices, removal, start over (R7, R11, R12) --------------------------------

test("listOwnDevices - this device first", async () => {
  routes.set(`GET /e2ee/devices/${USER}`, () =>
    json([
      own("01A", { created_at: "2026-01-01T00:00:00Z" }),
      own(DEV, { created_at: "2025-01-01T00:00:00Z" }),
    ]),
  );
  const { bridge } = await readyBridge();
  const views = await bridge.listOwnDevices();
  assert.deepEqual(
    views.map((v) => [v.deviceId, v.isThisDevice]),
    [
      [DEV, true],
      ["01A", false],
    ],
  );
});

test("removeDevice - two prompts, two tickets; a dismissed second keeps the backup", async () => {
  routes.set("DELETE /e2ee/keys/01A", () => json({ remaining_devices: 1 }));
  routes.set(
    "DELETE /e2ee/backup/01A",
    () => new Response(null, { status: 204 }),
  );
  const { bridge } = await readyBridge();
  const tickets = ["t1", "t2"];
  let result = await bridge.removeDevice(
    "01A",
    { deleteBackup: true },
    async () => tickets.shift(),
  );
  assert.deepEqual(result, { remainingDevices: 1, backupDeleted: true });
  const dels = requests.filter((r) => r.method === "DELETE");
  assert.deepEqual(
    dels.map((r) => [r.path, r.headers["X-MFA-Ticket"]]),
    [
      ["/e2ee/keys/01A", "t1"],
      ["/e2ee/backup/01A", "t2"],
    ],
  );
  requests = [];
  const once = ["t3"];
  result = await bridge.removeDevice("01A", { deleteBackup: true }, async () =>
    once.shift(),
  );
  assert.deepEqual(result, { remainingDevices: 1, backupDeleted: false });
  await assert.rejects(
    bridge.removeDevice(DEV, { deleteBackup: false }, async () => "t"),
    /disable/,
  );
});

test("startOverAsNewDevice - wipe, clear deviceRemoved, enable with the ticket", async () => {
  const { bridge } = await readyBridge();
  refused(bridge, "removed");
  await settle();
  assert.ok(bridge.deviceRemoved.has("state"));
  native.handlers.set("e2ee_enable", () => {
    native.provisioned = true;
    native.status = {
      enabled: true,
      published: false,
      device_id: "01FRESH",
      protocol_version: 1,
    };
    return { device_id: "01FRESH" };
  });
  log = [];
  assert.equal(
    await bridge.startOverAsNewDevice(async () => "ticket"),
    "enabled",
  );
  assert.equal(bridge.deviceRemoved.has("state"), false);
  assert.ok(log.indexOf("cmd:e2ee_wipe") < log.indexOf("PUT /e2ee/keys"));
  assert.equal(
    log.filter((l) => l.startsWith("DELETE")).length,
    0,
    "no revoke",
  );
  assert.equal(flagEdits(), 0, "flag untouched");
});

test("startOverAsNewDevice - declined and dismissed", async () => {
  const { bridge } = await readyBridge();
  native.handlers.set("e2ee_wipe", () => {
    throw { type: "declined" };
  });
  assert.equal(await bridge.startOverAsNewDevice(async () => "t"), "declined");
  native.handlers.delete("e2ee_wipe");
  assert.equal(
    await bridge.startOverAsNewDevice(async () => undefined),
    "wiped",
  );
  assert.equal(requests.filter((r) => r.method === "PUT").length, 0);
});

// ---- disable:twin (an install sharing its device is never wiped) ----------

const ERRORS_TS =
  process.env.E2EE_ERRORS_TS ||
  fileURLToPath(new URL("../i18n/errors.ts", import.meta.url));
const DISABLE_TSX =
  process.env.E2EE_DISABLE_TSX ||
  fileURLToPath(new URL("../modal/modals/E2EEDisable.tsx", import.meta.url));
const HELD_COPY =
  "This app shares its encryption identity with another of your apps. Turning encryption off here would turn it off there too. Make this app a separate device instead. Don't recognize the other app? Change your password, then remove it in Settings > Encryption on a device you trust.";
const HELD_KEY = `sloga.e2ee.heldStrike.v1:${USER}:${DEV}`;

function deletes(): number {
  return log.filter((l) => l.startsWith("DELETE")).length;
}

test("disable:shared - deviceShared raised: no wipe, no DELETE, no flag edit", async () => {
  storage.set(SHARED_KEY, JSON.stringify({ via: "held_elsewhere", at: 3 }));
  revokeAnswer(() => json({ remaining_devices: 0 }));
  const { bridge } = await readyBridge();
  log = [];
  assert.deepEqual(await bridge.disable("ticket"), { kind: "shared" });
  assert.equal(nativeCalls("e2ee_wipe"), 0, "not wiped");
  assert.equal(deletes(), 0, "not revoked");
  assert.equal(flagEdits(), 0);
  assert.ok(bridge.deviceShared.has("state"), "still offered the split");
});

test("disable:shared - a persisted first held_elsewhere refusal alone is enough", async () => {
  storage.set(HELD_KEY, JSON.stringify({ at: 5 }));
  revokeAnswer(() => json({ remaining_devices: 0 }));
  const { bridge } = await readyBridge();
  assert.equal(bridge.deviceShared.has("state"), false);
  log = [];
  assert.deepEqual(await bridge.disable("ticket"), { kind: "shared" });
  assert.equal(nativeCalls("e2ee_wipe"), 0);
  assert.equal(deletes(), 0);
});

test("disable:shared - this connection's refusal counts after Not now; a later accepted connection does not", async () => {
  revokeAnswer(() => json({ remaining_devices: 1 }));
  const { bridge, client } = await readyBridge();
  await heldElsewhere(bridge);
  bridge.dismissDeviceShared();
  assert.equal(storage.has(HELD_KEY), false, "Not now cleared the record");
  log = [];
  assert.deepEqual(await bridge.disable("ticket"), { kind: "shared" });
  assert.equal(nativeCalls("e2ee_wipe"), 0);

  client.emit("ready");
  await settle();
  bridge.onEvent({ type: "E2EEClaimResult", device_id: DEV, accepted: true });
  await settle();
  log = [];
  const result = await bridge.disable("ticket");
  assert.equal(result.kind, "disabled");
  assert.equal(nativeCalls("e2ee_wipe"), 1, "an ordinary disable again");
});

test("disable:held-elsewhere - a refused revoke after the wipe keeps the flag and routes to start fresh", async () => {
  revokeAnswer(() => json({ type: "E2EEDeviceHeldElsewhere" }, 403));
  const { bridge } = await readyBridge();
  routes.set(`GET /e2ee/devices/${USER}`, () => json([]));
  log = [];
  assert.deepEqual(await bridge.disable("ticket"), {
    kind: "held_elsewhere",
    deviceId: DEV,
  });
  assert.equal(nativeCalls("e2ee_wipe"), 1, "the wipe had already run");
  assert.equal(deletes(), 1);
  assert.equal(flagEdits(), 0, "the account flag is kept");
  assert.ok(
    !log.includes(`GET /e2ee/devices/${USER}`),
    "no listing fallback for a refused revoke",
  );
});

test("disable:normal - an unshared install still wipes, revokes and reports disabled", async () => {
  revokeAnswer(() => json({ remaining_devices: 0 }));
  const { bridge } = await readyBridge();
  log = [];
  const result = await bridge.disable("ticket");
  assert.deepEqual(result, {
    kind: "disabled",
    revokeFailed: false,
    deviceId: DEV,
    remainingDevices: 0,
  });
  assert.equal(nativeCalls("e2ee_wipe"), 1);
  assert.equal(flagEdits(), 1);
});

test("removeDevice - a held-elsewhere refusal surfaces with its type", async () => {
  routes.set("DELETE /e2ee/keys/01A", () =>
    json({ type: "E2EEDeviceHeldElsewhere" }, 403),
  );
  const { bridge } = await readyBridge();
  await assert.rejects(
    bridge.removeDevice("01A", { deleteBackup: false }, async () => "t"),
    (error: { type?: string }) => error.type === "E2EEDeviceHeldElsewhere",
  );
});

test("errors:held-elsewhere - mapped on the string chain before the typed switch", () => {
  const src = readFileSync(ERRORS_TS, "utf8");
  const at = src.indexOf('if (errType === "E2EEDeviceHeldElsewhere")');
  const typed = src.indexOf("switch (err.type)");
  assert.ok(at >= 0, "mapped");
  assert.ok(typed > at, "before the typed switch");
  assert.equal(src.includes('case "E2EEDeviceHeldElsewhere"'), false);
  assert.ok(
    src.slice(at, at + 600).includes("return t`" + HELD_COPY + "`"),
    "with the copy",
  );
});

test("ui:disable - shared opens the split, held_elsewhere opens start fresh, with the copy", () => {
  const src = readFileSync(DISABLE_TSX, "utf8");
  assert.match(
    src,
    /case "shared":\s*case "held_elsewhere":\s*setTwin\(result\.kind\);/,
  );
  assert.match(
    src,
    /twin\(\) === "shared"[\s\S]*?openModal\(\{ type: "e2ee_device_shared" \}\)/,
  );
  assert.match(
    src,
    /twin\(\) === "held_elsewhere"[\s\S]*?openModal\(\{ type: "e2ee_enable", offerRestore: true \}\)/,
  );
  assert.ok(src.includes("{t`" + HELD_COPY + "`}"), "the errors.ts msgid");
  assert.ok(
    src
      .replace(/\s+/g, " ")
      .includes(
        "This app was sharing encryption with another of your apps, which keeps working. Set this app up again as a new device.",
      ),
    "the start-fresh copy",
  );
});

// ---- disablePreflight: refused before any password prompt ------------------

const BANNER_TSX =
  process.env.E2EE_BANNER_TSX ||
  fileURLToPath(
    new URL(
      "../ui/components/features/voice/callCard/VoiceCallDowngradeBanner.tsx",
      import.meta.url,
    ),
  );

/** Source from `head` to the `}` closing its body (strings/comments skipped). */
function liftBlock(src: string, head: string): string {
  const start = src.indexOf(head);
  assert.ok(start >= 0, `found: ${head}`);
  let depth = 0;
  for (let i = src.indexOf("{", start + head.length - 1); i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; src[i] !== c; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced: ${head}`);
}

/** Run a lifted UI handler on stubs; returns what it asked for. */
async function runHandler(
  code: string,
  name: string,
  preflight: "shared" | null,
  overrides: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  const e2ee = {
    disablePreflight: () => {
      calls.push("preflight");
      return preflight;
    },
    disable: async () => {
      calls.push("disable");
      return { kind: "disabled", revokeFailed: false, remainingDevices: 1 };
    },
    ...(overrides.e2ee as object | undefined),
  };
  const stubs: Record<string, unknown> = {
    client: () => ({
      account: {
        mfa: async () => {
          calls.push("mfa");
          return {};
        },
      },
    }),
    mfaFlow: async () => {
      calls.push("mfaFlow");
      return { token: "ticket" };
    },
    openModal: (m: { type: string }) => calls.push(`open:${m.type}`),
    setTwin: (v: string) => calls.push(`twin:${v}`),
    setBusy: () => {},
    setDone: () => calls.push("done"),
    setFailedDeviceId: (v: unknown) => calls.push(`failed:${String(v)}`),
    showError: (e: unknown) => calls.push(`error:${String(e)}`),
    props: { onClose: () => {} },
    resetting: () => false,
    setResetting: () => {},
    ...overrides,
    e2ee,
  };
  const js = stripTypeScriptTypes(code);
  const fn = new Function(...Object.keys(stubs), `${js}\nreturn ${name};`)(
    ...Object.values(stubs),
  ) as () => Promise<void>;
  await fn();
  return calls;
}

test("disablePreflight - the three shared conditions answer shared, an unshared install null", async () => {
  const fresh = await readyBridge();
  assert.equal(
    (
      fresh.bridge as unknown as { disablePreflight(): unknown }
    ).disablePreflight(),
    null,
  );

  const check = async (name: string, bridge: Bridge) => {
    log = [];
    const pre = (
      bridge as unknown as { disablePreflight(): unknown }
    ).disablePreflight();
    assert.equal(pre, "shared", name);
    assert.equal(log.length, 0, `${name}: nothing native, nothing sent`);
    assert.deepEqual(await bridge.disable("ticket"), { kind: "shared" }, name);
  };

  storage.set(SHARED_KEY, JSON.stringify({ via: "diverged", at: 1 }));
  await check("deviceShared", (await readyBridge()).bridge);
  storage.clear();
  storage.set(HELD_KEY, JSON.stringify({ at: 5 }));
  await check("persisted first strike", (await readyBridge()).bridge);
  storage.clear();
  const refusedNow = (await readyBridge()).bridge;
  await heldElsewhere(refusedNow);
  refusedNow.dismissDeviceShared();
  await check("this connection's refusal", refusedNow);
});

test("ui:disable-preflight - a shared install is refused before the password prompt", async () => {
  const code = liftBlock(
    readFileSync(DISABLE_TSX, "utf8"),
    "async function disable() {",
  );
  const shared = await runHandler(code, "disable", "shared");
  assert.ok(
    !shared.includes("mfa") && !shared.includes("mfaFlow"),
    shared.join(),
  );
  assert.ok(!shared.includes("disable"), "never reached disable()");
  assert.ok(shared.includes("twin:shared"), "shows the split offer");
  const normal = await runHandler(code, "disable", null);
  assert.deepEqual(
    normal.filter((c) => c !== "preflight"),
    ["mfa", "mfaFlow", "disable", "done"],
  );
});

test("ui:banner-preflight - the call banner's reset is refused before the password prompt", async () => {
  const code = liftBlock(
    readFileSync(BANNER_TSX, "utf8"),
    "const resetDevice = async () => {",
  ).replace(/^const resetDevice = /, "var resetDevice = ");
  const shared = await runHandler(code, "resetDevice", "shared");
  assert.ok(
    !shared.includes("mfa") && !shared.includes("mfaFlow"),
    shared.join(),
  );
  assert.ok(shared.includes("open:e2ee_device_shared"));
  const normal = await runHandler(code, "resetDevice", null);
  assert.ok(normal.includes("mfa") && normal.includes("disable"));
});

// ---- the sticky "was shared" record -----------------------------------------

const WAS_KEY = `sloga.e2ee.wasShared.v1:${USER}:${DEV}`;

/** Two refusals on one connection: `deviceShared` is raised. */
async function raiseShared(bridge: Bridge) {
  await heldElsewhere(bridge);
  await heldElsewhere(bridge);
  assert.equal(bridge.deviceShared.get("state")?.via, "held_elsewhere");
}

/** A new connection whose claim the server accepts. */
async function acceptedConnection(
  bridge: Bridge,
  client: { emit(n: string): void },
) {
  client.emit("ready");
  await settle();
  bridge.onEvent({ type: "E2EEClaimResult", device_id: DEV, accepted: true });
  await settle();
}

test("wasShared - Not now and a later accepted claim still refuse disable()", async () => {
  revokeAnswer(() => json({ remaining_devices: 1 }));
  const { bridge, client } = await readyBridge();
  await raiseShared(bridge);
  assert.ok(storage.has(WAS_KEY), "recorded when raised");
  bridge.dismissDeviceShared();
  await acceptedConnection(bridge, client);
  assert.equal(bridge.deviceShared.has("state"), false);
  assert.equal(storage.has(HELD_KEY), false);
  assert.equal(bridge.disablePreflight(), "shared");
  log = [];
  assert.deepEqual(await bridge.disable("ticket"), { kind: "shared" });
  assert.equal(nativeCalls("e2ee_wipe"), 0);
  assert.equal(deletes(), 0);
});

test("wasShared - survives a reload of the page", async () => {
  const first = await readyBridge();
  await raiseShared(first.bridge);
  first.bridge.dismissDeviceShared();
  const second = await readyBridge();
  second.bridge.onEvent({
    type: "E2EEClaimResult",
    device_id: DEV,
    accepted: true,
  });
  await settle();
  assert.equal(second.bridge.disablePreflight(), "shared");
});

test("wasShared - a single first refusal does not set it", async () => {
  const { bridge, client } = await readyBridge();
  await heldElsewhere(bridge);
  assert.equal(storage.has(WAS_KEY), false);
  bridge.dismissDeviceShared();
  await acceptedConnection(bridge, client);
  assert.equal(bridge.disablePreflight(), null);
});

test("wasShared - our own split ends it", async () => {
  const { bridge, client } = await readyBridge();
  await raiseShared(bridge);
  await acceptedConnection(bridge, client);
  assert.equal((await bridge.splitDevice(async () => "ticket")).kind, "split");
  assert.equal(storage.has(WAS_KEY), false);
  await settle();
  bridge.onEvent({ type: "E2EEClaimResult", device_id: NEW, accepted: true });
  await settle();
  assert.equal(bridge.disablePreflight(), null, "the new device is not shared");
});

test("wasShared - the twin's split event naming us ends it", async () => {
  const { bridge, client } = await readyBridge();
  await raiseShared(bridge);
  bridge.onEvent({
    type: "E2EEDeviceCreate",
    user_id: USER,
    device_id: TWIN_NEW,
    split_from: DEV,
  });
  await settle();
  assert.equal(storage.has(WAS_KEY), false);
  await acceptedConnection(bridge, client);
  assert.equal(bridge.disablePreflight(), null);
});

test("wasShared - a wipe ends it", async () => {
  const { bridge } = await readyBridge();
  await raiseShared(bridge);
  assert.equal(
    await bridge.startOverAsNewDevice(async () => undefined),
    "wiped",
  );
  assert.equal(storage.has(WAS_KEY), false);
});

test("retryDeviceRevoke - a held-elsewhere refusal surfaces with its type and keeps the flag", async () => {
  revokeAnswer(() => json({ type: "E2EEDeviceHeldElsewhere" }, 403));
  const { bridge } = await readyBridge();
  routes.set(`GET /e2ee/devices/${USER}`, () => json([]));
  log = [];
  await assert.rejects(
    bridge.retryDeviceRevoke(DEV, "ticket"),
    (error: { type?: string }) => error.type === "E2EEDeviceHeldElsewhere",
  );
  assert.equal(flagEdits(), 0);
});

test("ui:retry-held-elsewhere - a refused retry routes to start fresh, not another retry", async () => {
  const code = liftBlock(
    readFileSync(DISABLE_TSX, "utf8"),
    "async function retryRevoke() {",
  );
  const calls = await runHandler(code, "retryRevoke", null, {
    failedDeviceId: () => DEV,
    e2ee: {
      retryDeviceRevoke: async () => {
        throw Object.assign(new Error("E2EE API DELETE failed: 403"), {
          type: "E2EEDeviceHeldElsewhere",
        });
      },
    },
  });
  assert.ok(calls.includes("twin:held_elsewhere"), calls.join());
  assert.ok(calls.includes("failed:undefined"), "the retry offer goes");
  assert.ok(!calls.some((c) => c.startsWith("error:")), "no error toast");
  const other = await runHandler(code, "retryRevoke", null, {
    failedDeviceId: () => DEV,
    e2ee: {
      retryDeviceRevoke: async () => {
        throw new Error("E2EE API DELETE failed: 500");
      },
    },
  });
  assert.ok(
    other.some((c) => c.startsWith("error:")),
    "other errors still show",
  );
  assert.ok(!other.includes("twin:held_elsewhere"));
});

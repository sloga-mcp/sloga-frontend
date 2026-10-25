// Behavior of the iOS orphaned recovery-bundle courier (audit M2, Stage 6
// fixes MAJOR-1, MINOR-2, MINOR-3), against the REAL `E2EEBridge`.
//
// e2ee.ts cannot be imported under `node --test` directly (extensionless
// sibling imports, bare packages that need a browser), so this bundles it
// with esbuild, stubs the bare packages, and drives a real bridge on a fake
// iOS `E2ee` plugin, a fake client and a stubbed `fetch`. Every assertion
// counts native takes (`e2ee_backup_refresh_if_due`) and backup PUTs.
//
// `E2EE_COURIER_TS` swaps in another e2ee.ts (resolved against THIS
// directory), which is how the fail-first control runs these tests against
// the pre-fix source.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCE =
  process.env.E2EE_COURIER_TS ||
  fileURLToPath(new URL("./e2ee.ts", import.meta.url));

type Listener = () => void;

/** The fake iOS plugin every bridge in a test shares (process-lifetime). */
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
          : null;
        return { json: JSON.stringify(bundle) };
      } finally {
        this.inFlight--;
      }
    }
    if (args.__cmd === "e2ee_backup_mark_uploaded") return { json: "null" };
    throw new Error(`unstubbed command ${args.__cmd}`);
  }

  release(bundle: unknown) {
    const next = this.held.shift();
    assert.ok(next, "no take is waiting");
    next(bundle);
  }

  takes() {
    return this.calls.filter((c) => c === "e2ee_backup_refresh_if_due").length;
  }
}

const BUNDLE = { header: "h", ciphertext: "c", generation: 7 };

type Bridge = {
  status: Map<string, unknown>;
  onEvent(event: { type: string; accepted?: boolean }): void;
  dispose?: () => Promise<void>;
};
type BridgeCtor = new (client: unknown) => Bridge;
type EsbuildHook = (
  options: { filter: RegExp; namespace?: string },
  callback: (args: { path: string }) => unknown,
) => void;

let plugin: FakePlugin;
let puts: string[] = [];
let E2EEBridge: BridgeCtor;
let outDir: string;

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
  // popout.ts reads `window.location.pathname` at module scope.
  g.window ??= { location: new URL("http://localhost/") };
  g.__courierStub = {
    Capacitor: {
      getPlatform: () => "ios",
      isNativePlatform: () => true,
      isPluginAvailable: () => true,
    },
    plugin: () => plugin,
  };
  g.fetch = async (url: string, init: { method: string }) => {
    if (init.method === "PUT" && url.endsWith("/e2ee/backup")) {
      puts.push(url);
      return new Response(null, { status: 204 });
    }
    return new Response("{}", { status: 500 });
  };
  ({ E2EEBridge } = (await import(pathToFileURL(file).href)) as {
    E2EEBridge: BridgeCtor;
  });
});

after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

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
async function claimedBridge(deviceId: string | null = "01DEVICE") {
  const client = fakeClient();
  const bridge = new E2EEBridge(client);
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

function fresh() {
  plugin = new FakePlugin();
  puts = [];
}

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

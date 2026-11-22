// Unit spec for the server's advertised ring length (Slim M2). Run with
// Node's built-in runner from packages/client:
//   node --test --conditions=browser components/rtc/serverRingLength.test.ts
// Focus: the value comes only from a raw `GET /` answer
// (`features.livekit.call_ring_duration`, backend `routes/root.rs`); a failed,
// slow or malformed answer never throws, never invents a value and never
// clears one the server gave; the accessor is reactive; the controller asks
// on every connect; and nothing reads the length from `client.configuration`
// (a local stub that never carries it). The backend shape is checked against
// the backend worktree source when present (override with `M2_BACKEND_DIR`;
// it skips, loudly, when absent).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createComputed, createRoot } from "solid-js";
import type { Client } from "stoat.js";

import {
  type RootConfigApi,
  createServerRingLength,
  loadServerCallRingSecs,
  parseCallRingSecs,
  serverCallRingSecs,
} from "./serverRingLength.ts";

// Compile-time: the real SDK client's `api` satisfies the narrow type.
export const _sdkApiFits: RootConfigApi = null as unknown as Client["api"];

/** A root config as the server sends it, with `livekit` set to `livekit`. */
function root(livekit: unknown): unknown {
  return {
    revolt: "0.8.0",
    features: {
      email: false,
      livekit,
      protected_channels: { enabled: false, default_device_cap: 0 },
    },
    ws: "wss://example.invalid/events",
  };
}

/** A fake `api` whose `GET /` runs `answer`; records every path asked. */
function fakeApi(answer: () => Promise<unknown>) {
  const paths: string[] = [];
  const api: RootConfigApi = {
    get(path) {
      paths.push(path);
      return answer();
    },
  };
  return { api, paths };
}

/** A promise with its resolve exposed. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// ---- parser -----------------------------------------------------------------

test("a well-formed advert gives its seconds, extra keys tolerated", () => {
  assert.equal(
    parseCallRingSecs(
      root({ enabled: true, nodes: [], call_ring_duration: 45 }),
    ),
    45,
  );
  assert.equal(parseCallRingSecs(root({ call_ring_duration: 30 })), 30);
  assert.equal(parseCallRingSecs(root({ call_ring_duration: 45.5 })), 45.5);
});

test("the range is left to ringDurationMs: any finite number passes", () => {
  // `ringDurationMs` owns the 5 to 120 s window and the 45 s fallback.
  for (const secs of [0, -3, 1, 600]) {
    assert.equal(parseCallRingSecs(root({ call_ring_duration: secs })), secs);
  }
});

test("a missing or malformed advert is undefined", () => {
  const malformed: unknown[] = [
    undefined,
    null,
    "",
    45,
    [],
    {},
    { features: null },
    { features: [] },
    { features: { livekit: null } },
    { features: { livekit: [] } },
    { features: { call_ring_duration: 45 } },
    { call_ring_duration: 45 },
    root({}),
    root({ enabled: true, nodes: [] }),
    root({ call_ring_duration: "45" }),
    root({ call_ring_duration: null }),
    root({ call_ring_duration: true }),
    root({ call_ring_duration: [45] }),
    root({ call_ring_duration: { secs: 45 } }),
    root({ call_ring_duration: Number.NaN }),
    root({ call_ring_duration: Number.POSITIVE_INFINITY }),
    root({ call_ring_duration: Number.NEGATIVE_INFINITY }),
  ];
  for (const body of malformed) {
    assert.equal(parseCallRingSecs(body), undefined, JSON.stringify(body));
  }
});

// ---- store ------------------------------------------------------------------

test("undefined before any answer; an answer sets it from GET /", async () => {
  const store = createServerRingLength();
  assert.equal(store.secs(), undefined);
  const { api, paths } = fakeApi(async () => root({ call_ring_duration: 60 }));
  await store.load(api);
  assert.equal(store.secs(), 60);
  assert.deepEqual(paths, ["/"]);
});

test("a failed request never rejects and never invents a value", async () => {
  const store = createServerRingLength();
  const failures: Array<() => Promise<void>> = [
    () => store.load(fakeApi(() => Promise.reject(new Error("offline"))).api),
    () => store.load(fakeApi(() => Promise.reject("Not Found")).api),
    () =>
      store.load({
        get() {
          throw new TypeError("thrown synchronously");
        },
      }),
    () => store.load(null as unknown as RootConfigApi),
  ];
  for (const fail of failures) {
    await assert.doesNotReject(fail());
    assert.equal(store.secs(), undefined);
  }
});

test("a body whose parse throws still never rejects", async () => {
  const store = createServerRingLength();
  await store.load(fakeApi(async () => root({ call_ring_duration: 30 })).api);
  const hostile = {
    get features(): unknown {
      throw new Error("hostile getter");
    },
  };
  await assert.doesNotReject(store.load(fakeApi(async () => hostile).api));
  assert.equal(store.secs(), 30);
});

test("a failed request keeps the value the server already gave", async () => {
  const store = createServerRingLength();
  await store.load(fakeApi(async () => root({ call_ring_duration: 30 })).api);
  await store.load(fakeApi(() => Promise.reject(new Error("offline"))).api);
  assert.equal(store.secs(), 30);
});

test("an answer without the advert clears it (server stopped sending)", async () => {
  const store = createServerRingLength();
  await store.load(fakeApi(async () => root({ call_ring_duration: 30 })).api);
  await store.load(fakeApi(async () => root({ enabled: true })).api);
  assert.equal(store.secs(), undefined);
});

test("a newer answer replaces the value", async () => {
  const store = createServerRingLength();
  await store.load(fakeApi(async () => root({ call_ring_duration: 30 })).api);
  await store.load(fakeApi(async () => root({ call_ring_duration: 90 })).api);
  assert.equal(store.secs(), 90);
});

test("one request at a time: a load while one is pending joins it", async () => {
  const store = createServerRingLength();
  const gate = deferred<unknown>();
  const { api, paths } = fakeApi(() => gate.promise);
  const first = store.load(api);
  const second = store.load(api);
  assert.equal(first, second);
  gate.resolve(root({ call_ring_duration: 20 }));
  await Promise.all([first, second]);
  assert.equal(paths.length, 1);
  assert.equal(store.secs(), 20);
  // Once settled, the next load asks again.
  await store.load(api);
  assert.equal(paths.length, 2);
});

test(
  "a request that hangs past the deadline counts as failed; its late answer is dropped",
  { timeout: 5_000 },
  async () => {
    const store = createServerRingLength(20);
    const hung = deferred<unknown>();
    await store.load(fakeApi(() => hung.promise).api);
    assert.equal(store.secs(), undefined);
    // The deadline freed the slot: a new load asks again.
    await store.load(fakeApi(async () => root({ call_ring_duration: 30 })).api);
    assert.equal(store.secs(), 30);
    hung.resolve(root({ call_ring_duration: 99 }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.secs(), 30);
  },
);

test("the accessor is reactive", async () => {
  const store = createServerRingLength();
  const seen: Array<number | undefined> = [];
  await createRoot(async (dispose) => {
    createComputed(() => seen.push(store.secs()));
    await store.load(fakeApi(async () => root({ call_ring_duration: 75 })).api);
    dispose();
  });
  assert.deepEqual(seen, [undefined, 75]);
});

test("the module's own accessor and loader share one store", async () => {
  assert.equal(serverCallRingSecs(), undefined);
  await loadServerCallRingSecs(
    fakeApi(async () => root({ call_ring_duration: 50 })).api,
  );
  assert.equal(serverCallRingSecs(), 50);
});

// ---- wiring -----------------------------------------------------------------

const CLIENT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function source(relative: string): string {
  return readFileSync(join(CLIENT_ROOT, relative), "utf8");
}

test("the controller asks on every connect, without awaiting", () => {
  const src = source("components/client/Controller.ts");
  const start = src.indexOf("case State.Connected:");
  assert.ok(start >= 0, "no `case State.Connected:` in Controller.ts");
  const arm = src.slice(start, src.indexOf("break;", start));
  assert.ok(
    arm.includes("void loadServerCallRingSecs(this.client.api);"),
    "the State.Connected arm does not call loadServerCallRingSecs",
  );
  assert.equal(src.split("loadServerCallRingSecs(").length - 1, 1);
});

test("the ringtone reads the length through ringDurationMs", () => {
  const src = source("components/client/Sounds.tsx");
  assert.equal(src.split("ringDurationMs(serverCallRingSecs())").length - 1, 1);
});

test("nothing reads call_ring_duration except this module", () => {
  const skip = new Set(["node_modules", "dist", "styled-system", "android"]);
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name === "catalogs") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        entry.name !== "serverRingLength.ts" &&
        readFileSync(path, "utf8").includes("call_ring_duration")
      ) {
        hits.push(path.slice(CLIENT_ROOT.length));
      }
    }
  };
  for (const top of ["components", "src"]) walk(join(CLIENT_ROOT, top));
  assert.deepEqual(
    hits,
    [],
    "read the length as ringDurationMs(serverCallRingSecs()) instead",
  );
});

test("backend: root.rs still sends features.livekit.call_ring_duration", (t) => {
  const dir = process.env.M2_BACKEND_DIR || "/home/mcp/be-call-ring";
  const file = join(dir, "crates/delta/src/routes/root.rs");
  if (!existsSync(file)) {
    t.skip(`backend source not found at ${file}; shape NOT checked`);
    return;
  }
  const src = readFileSync(file, "utf8");
  const voice = src.match(/pub struct VoiceFeature \{([\s\S]*?)\n\}/);
  assert.ok(voice, "no `pub struct VoiceFeature` in root.rs");
  assert.match(voice[1], /\n\s*pub call_ring_duration: usize,/);
  assert.doesNotMatch(voice[1], /serde\(\s*rename/);
  const features = src.match(/pub struct RevoltFeatures \{([\s\S]*?)\n\}/);
  assert.ok(features, "no `pub struct RevoltFeatures` in root.rs");
  assert.match(features[1], /\n\s*pub livekit: VoiceFeature,/);
  assert.doesNotMatch(src, /rename_all/);
});

// Unit spec for the Protected channels feature advert (W4 lane A6) — run
// with Node's built-in runner from packages/client:
//   node --test --conditions=browser components/client/protectedChannelsFlag.test.ts
// Focus: the flag fails closed. Only a well-formed advert
// (`features.protected_channels = { enabled: bool, default_device_cap: u32 }`,
// backend `routes/root.rs`) may turn it on; every malformed, missing or
// failed answer is `{ enabled: false, defaultDeviceCap: null }`, and the
// fetch never rejects. The backend shape is pinned ALWAYS against the in-repo
// fixture `__fixtures__/protected/backend-protected-channels-flag.json`
// (copied from backend `routes/root.rs`); an extra test checks that fixture
// against the backend worktree source when it is present (override with
// `W4_BACKEND_DIR`; it skips, loudly, when absent).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Client } from "stoat.js";

import {
  type ProtectedFlagClient,
  fetchProtectedChannelsFlag,
  parseProtectedChannelsFeature,
} from "./protectedChannelsFlag.ts";

const OFF = { enabled: false, defaultDeviceCap: null };

// Compile-time: the real SDK client satisfies the narrow parameter type.
export const _sdkClientFits: ProtectedFlagClient = null as unknown as Client;

/** A fake client whose `GET /` answers `body` and records the paths asked. */
function fakeClient(answer: () => Promise<unknown>) {
  const paths: string[] = [];
  const client: ProtectedFlagClient = {
    api: {
      get(path) {
        paths.push(path);
        return answer();
      },
    },
  };
  return { client, paths };
}

function root(protectedChannels: unknown): unknown {
  return {
    revolt: "0.8.0",
    features: { email: false, protected_channels: protectedChannels },
    ws: "wss://example.invalid/events",
  };
}

test("well-formed advert parses both fields", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({ enabled: true, default_device_cap: 7 }),
    { enabled: true, defaultDeviceCap: 7 },
  );
  assert.deepEqual(
    parseProtectedChannelsFeature({ enabled: false, default_device_cap: 5 }),
    { enabled: false, defaultDeviceCap: 5 },
  );
});

test("device cap 0 (unlimited) is kept as 0, not unknown", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({ enabled: true, default_device_cap: 0 }),
    { enabled: true, defaultDeviceCap: 0 },
  );
});

test("u32 bounds: max accepted, one above refused", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 4_294_967_295,
    }),
    { enabled: true, defaultDeviceCap: 4_294_967_295 },
  );
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 4_294_967_296,
    }),
    OFF,
  );
});

test("unknown extra keys are tolerated", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 3,
      future_field: { x: 1 },
    }),
    { enabled: true, defaultDeviceCap: 3 },
  );
});

test("malformed advert values are all off", () => {
  const cases: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["true", true],
    ["string", "enabled"],
    ["number", 1],
    ["array", [true, 5]],
    ["empty object", {}],
    ["enabled missing", { default_device_cap: 5 }],
    ["enabled null", { enabled: null, default_device_cap: 5 }],
    ["enabled string", { enabled: "true", default_device_cap: 5 }],
    ["enabled number", { enabled: 1, default_device_cap: 5 }],
    ["enabled object", { enabled: {}, default_device_cap: 5 }],
    ["cap missing", { enabled: true }],
    ["cap null", { enabled: true, default_device_cap: null }],
    ["cap string", { enabled: true, default_device_cap: "5" }],
    ["cap negative", { enabled: true, default_device_cap: -1 }],
    ["cap fraction", { enabled: true, default_device_cap: 1.5 }],
    ["cap NaN", { enabled: true, default_device_cap: Number.NaN }],
    ["cap Infinity", { enabled: true, default_device_cap: Infinity }],
    ["cap bigint", { enabled: true, default_device_cap: 5n }],
  ];
  for (const [name, raw] of cases) {
    assert.deepEqual(parseProtectedChannelsFeature(raw), OFF, name);
  }
});

test("each call returns a fresh object", () => {
  const a = parseProtectedChannelsFeature(null);
  a.enabled = true;
  assert.deepEqual(parseProtectedChannelsFeature(null), OFF);
});

test("fetch asks GET / once and parses the advert", async () => {
  const { client, paths } = fakeClient(async () =>
    root({ enabled: true, default_device_cap: 7 }),
  );
  assert.deepEqual(await fetchProtectedChannelsFlag(client), {
    enabled: true,
    defaultDeviceCap: 7,
  });
  assert.deepEqual(paths, ["/"]);
});

test("fetch: missing or malformed body is off", async () => {
  const bodies: [string, unknown][] = [
    ["null body", null],
    ["string body", "ok"],
    ["array body", [root({ enabled: true, default_device_cap: 7 })]],
    ["no features", { revolt: "0.8.0" }],
    ["features null", { features: null }],
    ["features array", { features: [] }],
    ["no protected_channels (older server)", { features: { email: true } }],
    ["protected_channels malformed", root({ enabled: "yes" })],
  ];
  for (const [name, body] of bodies) {
    const { client } = fakeClient(async () => body);
    assert.deepEqual(await fetchProtectedChannelsFlag(client), OFF, name);
  }
});

test("fetch: a failed request is off and never rejects", async () => {
  const rejecting = fakeClient(() => Promise.reject(new Error("503")));
  assert.deepEqual(await fetchProtectedChannelsFlag(rejecting.client), OFF);

  const throwing: ProtectedFlagClient = {
    api: {
      get() {
        throw new TypeError("network");
      },
    },
  };
  assert.deepEqual(await fetchProtectedChannelsFlag(throwing), OFF);
});

/** The backend advert shape, copied in-repo from `root.rs` (always present). */
const BACKEND = JSON.parse(
  readFileSync(
    new URL(
      "./__fixtures__/protected/backend-protected-channels-flag.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { advert_path: string[]; struct_fields: string[] };

test("pinned backend advert shape drives the parser", async () => {
  assert.deepEqual(BACKEND.struct_fields, [
    "enabled: bool",
    "default_device_cap: u32",
  ]);
  const [enabledKey, capKey] = BACKEND.struct_fields.map(
    (f) => f.split(": ")[0],
  );
  const advert = { [enabledKey]: true, [capKey]: 3 };
  assert.deepEqual(parseProtectedChannelsFeature(advert), {
    enabled: true,
    defaultDeviceCap: 3,
  });
  // each key is load-bearing: dropping either one fails closed
  for (const key of [enabledKey, capKey]) {
    const partial: Record<string, unknown> = { ...advert };
    delete partial[key];
    assert.deepEqual(parseProtectedChannelsFeature(partial), OFF, key);
  }
  // and the fetch reads it at the backend's path (`features.protected_channels`)
  assert.deepEqual(BACKEND.advert_path, ["features", "protected_channels"]);
  const body = BACKEND.advert_path.reduceRight<unknown>(
    (inner, key) => ({ [key]: inner }),
    advert,
  );
  const { client } = fakeClient(() => Promise.resolve(body));
  assert.deepEqual(await fetchProtectedChannelsFlag(client), {
    enabled: true,
    defaultDeviceCap: 3,
  });
});

test("the backend fixture matches the backend source", (t) => {
  const dir = process.env.W4_BACKEND_DIR ?? "/home/mcp/wt-protected-be";
  const file = join(dir, "crates/delta/src/routes/root.rs");
  if (!existsSync(file)) {
    t.skip(`backend source absent: ${file}`);
    return;
  }
  const src = readFileSync(file, "utf8");
  const struct = src.match(
    /pub struct ProtectedChannelsFeature \{([\s\S]*?)\n\}/,
  );
  assert.ok(struct, "ProtectedChannelsFeature struct not found");
  const fields = [...struct[1].matchAll(/pub (\w+): (\w+),/g)].map(
    (m) => `${m[1]}: ${m[2]}`,
  );
  assert.deepEqual(fields, BACKEND.struct_fields);
  assert.match(
    src,
    /pub protected_channels: ProtectedChannelsFeature,/,
    "RevoltFeatures.protected_channels",
  );
  assert.match(src, /pub features: RevoltFeatures,/, "RevoltConfig.features");
});

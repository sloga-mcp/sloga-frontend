// Unit spec for the Protected channels feature advert (W4 lane A6) — run
// with Node's built-in runner from packages/client:
//   node --test --conditions=browser components/client/protectedChannelsFlag.test.ts
// Focus: the flag fails closed. Only a well-formed advert
// (`features.protected_channels = { enabled: bool, default_device_cap: u32,
// formats_v2: bool }`, backend `routes/root.rs`) may turn it on; every
// malformed, missing or failed answer is all off, and the fetch never
// rejects. The backend shape is pinned ALWAYS against the in-repo fixture
// `__fixtures__/protected/backend-protected-channels-flag.json` (copied from
// the S2 backend `routes/root.rs`); an extra test checks that fixture against
// the backend source when it is present (`SLOGA_BACKEND_DIR`, then
// `W4_BACKEND_DIR`, then the W4 gate's S2 copy; it skips, loudly, when absent).
// S2 (OR-12): `formats_v2` is parsed on its own. Only `true` is true;
// absent (an S1 server) or malformed is false and never changes `enabled`
// or the cap. Its backend shape is checked against `SLOGA_BACKEND_DIR` (the
// S2 backend tree; skips, loudly, when unset).
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

const OFF = { enabled: false, defaultDeviceCap: null, formatsV2: false };

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
    { enabled: true, defaultDeviceCap: 7, formatsV2: false },
  );
  assert.deepEqual(
    parseProtectedChannelsFeature({ enabled: false, default_device_cap: 5 }),
    { enabled: false, defaultDeviceCap: 5, formatsV2: false },
  );
});

test("device cap 0 (unlimited) is kept as 0, not unknown", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({ enabled: true, default_device_cap: 0 }),
    { enabled: true, defaultDeviceCap: 0, formatsV2: false },
  );
});

test("u32 bounds: max accepted, one above refused", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 4_294_967_295,
    }),
    { enabled: true, defaultDeviceCap: 4_294_967_295, formatsV2: false },
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
    { enabled: true, defaultDeviceCap: 3, formatsV2: false },
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

/** `formats_v2` values that are not the boolean `true` (nor `false`). */
const MALFORMED_FORMATS_V2: [string, unknown][] = [
  ["string true", "true"],
  ["string false", "false"],
  ["number 1", 1],
  ["number 0", 0],
  ["null", null],
  ["object", {}],
  ["object with value", { value: true }],
  ["array", [true]],
];

test("S2 formats_v2: true is true, with enabled and the cap untouched", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 7,
      formats_v2: true,
    }),
    { enabled: true, defaultDeviceCap: 7, formatsV2: true },
  );
  // the server advertises formats_v2 as configured, even with growth off
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: false,
      default_device_cap: 5,
      formats_v2: true,
    }),
    { enabled: false, defaultDeviceCap: 5, formatsV2: true },
  );
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 0,
      formats_v2: false,
    }),
    { enabled: true, defaultDeviceCap: 0, formatsV2: false },
  );
});

test("S2 formats_v2 absent (an S1 server) is false", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({ enabled: true, default_device_cap: 7 }),
    { enabled: true, defaultDeviceCap: 7, formatsV2: false },
  );
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 7,
      formats_v2: undefined,
    }),
    { enabled: true, defaultDeviceCap: 7, formatsV2: false },
  );
});

test("S2 formats_v2 malformed is false and never turns enabled off", () => {
  for (const [name, value] of MALFORMED_FORMATS_V2) {
    assert.deepEqual(
      parseProtectedChannelsFeature({
        enabled: true,
        default_device_cap: 7,
        formats_v2: value,
      }),
      { enabled: true, defaultDeviceCap: 7, formatsV2: false },
      `enabled on, ${name}`,
    );
    assert.deepEqual(
      parseProtectedChannelsFeature({
        enabled: false,
        default_device_cap: 5,
        formats_v2: value,
      }),
      { enabled: false, defaultDeviceCap: 5, formatsV2: false },
      `enabled off, ${name}`,
    );
  }
});

test("S2 an S1 root parses byte-identically, apart from formatsV2: false", async () => {
  // The S1 parser's output (W4-0 base) serialized, plus the one new key last.
  const s1: [string, unknown, string][] = [
    [
      "on",
      { enabled: true, default_device_cap: 7 },
      '{"enabled":true,"defaultDeviceCap":7,"formatsV2":false}',
    ],
    [
      "off",
      { enabled: false, default_device_cap: 5 },
      '{"enabled":false,"defaultDeviceCap":5,"formatsV2":false}',
    ],
    [
      "unlimited",
      { enabled: true, default_device_cap: 0 },
      '{"enabled":true,"defaultDeviceCap":0,"formatsV2":false}',
    ],
    [
      "malformed",
      { enabled: "yes", default_device_cap: 5 },
      '{"enabled":false,"defaultDeviceCap":null,"formatsV2":false}',
    ],
  ];
  for (const [name, advert, json] of s1) {
    assert.equal(
      JSON.stringify(parseProtectedChannelsFeature(advert)),
      json,
      `parse ${name}`,
    );
    const { client } = fakeClient(async () => root(advert));
    assert.equal(
      JSON.stringify(await fetchProtectedChannelsFlag(client)),
      json,
      `fetch ${name}`,
    );
  }
});

test("S2 formats_v2 changes only formatsV2, and a malformed advert stays off", () => {
  const adverts: [string, unknown][] = [
    ["on", { enabled: true, default_device_cap: 7 }],
    ["off", { enabled: false, default_device_cap: 5 }],
    ["cap missing", { enabled: true }],
    ["cap string", { enabled: true, default_device_cap: "5" }],
    ["enabled string", { enabled: "true", default_device_cap: 5 }],
    ["enabled missing", { default_device_cap: 5 }],
  ];
  const values: [string, unknown][] = [
    ["true", true],
    ["false", false],
    ...MALFORMED_FORMATS_V2,
  ];
  for (const [aName, advert] of adverts) {
    const base = parseProtectedChannelsFeature(advert);
    const wellFormed = base.defaultDeviceCap !== null;
    for (const [vName, value] of values) {
      const got = parseProtectedChannelsFeature({
        ...(advert as object),
        formats_v2: value,
      });
      const label = `${aName}, formats_v2 ${vName}`;
      assert.equal(got.enabled, base.enabled, `enabled: ${label}`);
      assert.equal(
        got.defaultDeviceCap,
        base.defaultDeviceCap,
        `cap: ${label}`,
      );
      assert.equal(
        got.formatsV2,
        wellFormed && value === true,
        `formatsV2: ${label}`,
      );
    }
  }
});

test("S2 fetch reads formats_v2 inside features.protected_channels only", async () => {
  const on = fakeClient(async () =>
    root({ enabled: true, default_device_cap: 3, formats_v2: true }),
  );
  assert.deepEqual(await fetchProtectedChannelsFlag(on.client), {
    enabled: true,
    defaultDeviceCap: 3,
    formatsV2: true,
  });
  // the key one level up (beside protected_channels) is not the advert
  const misplaced = fakeClient(async () => ({
    features: {
      formats_v2: true,
      protected_channels: { enabled: true, default_device_cap: 3 },
    },
  }));
  assert.deepEqual(await fetchProtectedChannelsFlag(misplaced.client), {
    enabled: true,
    defaultDeviceCap: 3,
    formatsV2: false,
  });
});

test("fetch asks GET / once and parses the advert", async () => {
  const { client, paths } = fakeClient(async () =>
    root({ enabled: true, default_device_cap: 7 }),
  );
  assert.deepEqual(await fetchProtectedChannelsFlag(client), {
    enabled: true,
    defaultDeviceCap: 7,
    formatsV2: false,
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
    "formats_v2: bool",
  ]);
  const [enabledKey, capKey, formatsKey] = BACKEND.struct_fields.map(
    (f) => f.split(": ")[0],
  );
  const advert = { [enabledKey]: true, [capKey]: 3, [formatsKey]: true };
  assert.deepEqual(parseProtectedChannelsFeature(advert), {
    enabled: true,
    defaultDeviceCap: 3,
    formatsV2: true,
  });
  // enabled and the cap are load-bearing: dropping either one fails closed
  for (const key of [enabledKey, capKey]) {
    const partial: Record<string, unknown> = { ...advert };
    delete partial[key];
    assert.deepEqual(parseProtectedChannelsFeature(partial), OFF, key);
  }
  // formats_v2 is not (OR-12): dropping it leaves enabled on, formatsV2 false
  const noFormats: Record<string, unknown> = { ...advert };
  delete noFormats[formatsKey];
  assert.deepEqual(parseProtectedChannelsFeature(noFormats), {
    enabled: true,
    defaultDeviceCap: 3,
    formatsV2: false,
  });
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
    formatsV2: true,
  });
});

test("the backend fixture matches the backend source", (t) => {
  // The gates' S2 tree first; never the S1 backend worktree.
  const dir =
    process.env.SLOGA_BACKEND_DIR ??
    process.env.W4_BACKEND_DIR ??
    "/home/mcp/pc-logs/s2/w4/be-74390c37";
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

test("S2 backend source: formats_v2 is a bool inside protected_channels", (t) => {
  const dir = process.env.SLOGA_BACKEND_DIR;
  if (!dir) {
    t.skip("backend cross-check not run: set SLOGA_BACKEND_DIR (S2 backend)");
    return;
  }
  const file = join(dir, "crates/delta/src/routes/root.rs");
  assert.ok(existsSync(file), `SLOGA_BACKEND_DIR is not a backend: ${file}`);
  const src = readFileSync(file, "utf8");
  // the struct, with its attribute lines: no serde renaming anywhere in it
  const struct = src.match(
    /((?:#\[[^\n]*\]\n)*)pub struct ProtectedChannelsFeature \{([\s\S]*?)\n\}/,
  );
  assert.ok(struct, "ProtectedChannelsFeature struct not found");
  assert.doesNotMatch(struct[0], /serde/, "no serde attribute on the struct");
  const fields = [...struct[2].matchAll(/pub (\w+): (\w+),/g)].map(
    (m) => `${m[1]}: ${m[2]}`,
  );
  assert.deepEqual(fields, [
    "enabled: bool",
    "default_device_cap: u32",
    "formats_v2: bool",
  ]);
  // advertised under `features.protected_channels`, as configured
  const advert = src.match(
    /protected_channels: ProtectedChannelsFeature \{([\s\S]*?)\n\s*\},/,
  );
  assert.ok(advert, "the protected_channels advert literal not found");
  assert.match(
    advert[1],
    /\bformats_v2: config\.features\.protected_channels\.formats_v2,/,
  );
  assert.match(
    src,
    /\n {4}pub protected_channels: ProtectedChannelsFeature,/,
    "RevoltFeatures.protected_channels",
  );
});

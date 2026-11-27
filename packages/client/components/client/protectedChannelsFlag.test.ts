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
// `W4_BACKEND_DIR`, then the S4 gate's backend copy; it skips, loudly, when
// absent). The fixture still carries the S2 struct; the two fields the S4
// backend appends are named here (`S4_STRUCT_FIELDS`).
// S2 (OR-12): `formats_v2` is parsed on its own. Only `true` is true;
// absent (an S1 server) or malformed is false and never changes `enabled`
// or the cap. Its backend shape is checked against `SLOGA_BACKEND_DIR` (the
// backend tree; skips, loudly, when unset).
// S4 (R-W4-9): `history_setting` is strict the same way and moves no other
// field, but `historySetting` is true only with `enabled` and `formatsV2`
// both true (a history setting is a v2 list field). `ios` is not read.
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

const OFF = {
  enabled: false,
  defaultDeviceCap: null,
  formatsV2: false,
  historySetting: false,
};

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
    {
      enabled: true,
      defaultDeviceCap: 7,
      formatsV2: false,
      historySetting: false,
    },
  );
  assert.deepEqual(
    parseProtectedChannelsFeature({ enabled: false, default_device_cap: 5 }),
    {
      enabled: false,
      defaultDeviceCap: 5,
      formatsV2: false,
      historySetting: false,
    },
  );
});

test("device cap 0 (unlimited) is kept as 0, not unknown", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({ enabled: true, default_device_cap: 0 }),
    {
      enabled: true,
      defaultDeviceCap: 0,
      formatsV2: false,
      historySetting: false,
    },
  );
});

test("u32 bounds: max accepted, one above refused", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 4_294_967_295,
    }),
    {
      enabled: true,
      defaultDeviceCap: 4_294_967_295,
      formatsV2: false,
      historySetting: false,
    },
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
    {
      enabled: true,
      defaultDeviceCap: 3,
      formatsV2: false,
      historySetting: false,
    },
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
    {
      enabled: true,
      defaultDeviceCap: 7,
      formatsV2: true,
      historySetting: false,
    },
  );
  // the server advertises formats_v2 as configured, even with growth off
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: false,
      default_device_cap: 5,
      formats_v2: true,
    }),
    {
      enabled: false,
      defaultDeviceCap: 5,
      formatsV2: true,
      historySetting: false,
    },
  );
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 0,
      formats_v2: false,
    }),
    {
      enabled: true,
      defaultDeviceCap: 0,
      formatsV2: false,
      historySetting: false,
    },
  );
});

test("S2 formats_v2 absent (an S1 server) is false", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({ enabled: true, default_device_cap: 7 }),
    {
      enabled: true,
      defaultDeviceCap: 7,
      formatsV2: false,
      historySetting: false,
    },
  );
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 7,
      formats_v2: undefined,
    }),
    {
      enabled: true,
      defaultDeviceCap: 7,
      formatsV2: false,
      historySetting: false,
    },
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
      {
        enabled: true,
        defaultDeviceCap: 7,
        formatsV2: false,
        historySetting: false,
      },
      `enabled on, ${name}`,
    );
    assert.deepEqual(
      parseProtectedChannelsFeature({
        enabled: false,
        default_device_cap: 5,
        formats_v2: value,
      }),
      {
        enabled: false,
        defaultDeviceCap: 5,
        formatsV2: false,
        historySetting: false,
      },
      `enabled off, ${name}`,
    );
  }
});

test("S2 an S1 root parses byte-identically, apart from formatsV2: false", async () => {
  // The S1 parser's output (W4-0 base) serialized, plus the S2 key and then
  // the S4 key, last.
  const s1: [string, unknown, string][] = [
    [
      "on",
      { enabled: true, default_device_cap: 7 },
      '{"enabled":true,"defaultDeviceCap":7,"formatsV2":false,"historySetting":false}',
    ],
    [
      "off",
      { enabled: false, default_device_cap: 5 },
      '{"enabled":false,"defaultDeviceCap":5,"formatsV2":false,"historySetting":false}',
    ],
    [
      "unlimited",
      { enabled: true, default_device_cap: 0 },
      '{"enabled":true,"defaultDeviceCap":0,"formatsV2":false,"historySetting":false}',
    ],
    [
      "malformed",
      { enabled: "yes", default_device_cap: 5 },
      '{"enabled":false,"defaultDeviceCap":null,"formatsV2":false,"historySetting":false}',
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
    historySetting: false,
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
    historySetting: false,
  });
});

/** `history_setting` values that are not the boolean `true`. */
const NOT_TRUE_HISTORY: [string, unknown][] = [
  ["absent", undefined],
  ["false", false],
  ["string true", "true"],
  ["string false", "false"],
  ["number 1", 1],
  ["number 0", 0],
  ["null", null],
  ["object", {}],
  ["object with value", { value: true }],
  ["array", [true]],
];

/** Runs `body` with `console.warn` captured, and gives back the lines. */
async function captureWarnings(body: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.warn = original;
  }
  return lines;
}

let freshModules = 0;

/** A new instance of the module, so its log-once state starts clean. */
async function freshFlagModule(): Promise<
  typeof import("./protectedChannelsFlag.ts")
> {
  freshModules += 1;
  const specifier = `./protectedChannelsFlag.ts?fresh=${freshModules}`;
  return (await import(
    specifier
  )) as typeof import("./protectedChannelsFlag.ts");
}

test("S4 history_setting: true is true with enabled and formats_v2 on", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 7,
      formats_v2: true,
      history_setting: true,
    }),
    {
      enabled: true,
      defaultDeviceCap: 7,
      formatsV2: true,
      historySetting: true,
    },
  );
  // the unlimited cap and the key order make no difference
  assert.deepEqual(
    parseProtectedChannelsFeature({
      history_setting: true,
      ios: false,
      formats_v2: true,
      default_device_cap: 0,
      enabled: true,
    }),
    {
      enabled: true,
      defaultDeviceCap: 0,
      formatsV2: true,
      historySetting: true,
    },
  );
});

test("S4 history_setting absent, false or malformed is false", () => {
  for (const [name, value] of NOT_TRUE_HISTORY) {
    assert.deepEqual(
      parseProtectedChannelsFeature({
        enabled: true,
        default_device_cap: 7,
        formats_v2: true,
        history_setting: value,
      }),
      {
        enabled: true,
        defaultDeviceCap: 7,
        formatsV2: true,
        historySetting: false,
      },
      name,
    );
  }
  // a server before S4 sends no such key at all
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 7,
      formats_v2: true,
    }),
    {
      enabled: true,
      defaultDeviceCap: 7,
      formatsV2: true,
      historySetting: false,
    },
  );
});

test("S4 history_setting stays false while enabled is false", () => {
  // the server advertises history_setting as configured, even with growth off
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: false,
      default_device_cap: 5,
      formats_v2: true,
      history_setting: true,
    }),
    {
      enabled: false,
      defaultDeviceCap: 5,
      formatsV2: true,
      historySetting: false,
    },
  );
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: false,
      default_device_cap: 5,
      history_setting: true,
    }),
    {
      enabled: false,
      defaultDeviceCap: 5,
      formatsV2: false,
      historySetting: false,
    },
  );
});

test("S4 history_setting is forced false while formats_v2 is off", async () => {
  const offs: [string, unknown][] = [
    ["absent", undefined],
    ["false", false],
    ...MALFORMED_FORMATS_V2,
  ];
  await captureWarnings(() => {
    for (const [name, value] of offs) {
      assert.deepEqual(
        parseProtectedChannelsFeature({
          enabled: true,
          default_device_cap: 7,
          formats_v2: value,
          history_setting: true,
        }),
        {
          enabled: true,
          defaultDeviceCap: 7,
          formatsV2: false,
          historySetting: false,
        },
        `formats_v2 ${name}`,
      );
    }
  });
});

test("S4 history_setting never moves enabled, the cap or formatsV2", async () => {
  const adverts: [string, Record<string, unknown>][] = [
    ["on", { enabled: true, default_device_cap: 7 }],
    ["on, v2", { enabled: true, default_device_cap: 7, formats_v2: true }],
    [
      "unlimited, v2",
      { enabled: true, default_device_cap: 0, formats_v2: true },
    ],
    ["off", { enabled: false, default_device_cap: 5 }],
    ["off, v2", { enabled: false, default_device_cap: 5, formats_v2: true }],
    ["cap missing", { enabled: true, formats_v2: true }],
    [
      "cap string",
      { enabled: true, default_device_cap: "5", formats_v2: true },
    ],
    ["enabled string", { enabled: "true", default_device_cap: 5 }],
    ["enabled missing", { default_device_cap: 5, formats_v2: true }],
  ];
  const values: [string, unknown][] = [["true", true], ...NOT_TRUE_HISTORY];
  let checked = 0;
  await captureWarnings(() => {
    for (const [aName, advert] of adverts) {
      const base = parseProtectedChannelsFeature(advert);
      assert.equal(base.historySetting, false, `base: ${aName}`);
      for (const [vName, value] of values) {
        const got = parseProtectedChannelsFeature({
          ...advert,
          history_setting: value,
        });
        const label = `${aName}, history_setting ${vName}`;
        assert.equal(got.enabled, base.enabled, `enabled: ${label}`);
        assert.equal(
          got.defaultDeviceCap,
          base.defaultDeviceCap,
          `cap: ${label}`,
        );
        assert.equal(got.formatsV2, base.formatsV2, `formatsV2: ${label}`);
        assert.equal(
          got.historySetting,
          value === true && base.enabled && base.formatsV2,
          `historySetting: ${label}`,
        );
        checked += 1;
      }
    }
  });
  assert.equal(checked, 9 * 11);
});

test("S4 a non-object block or a malformed advert keeps historySetting false", () => {
  const cases: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
    ["true", true],
    ["string", "history_setting"],
    ["number", 1],
    ["array", [{ history_setting: true }]],
    ["only the key", { history_setting: true }],
    ["enabled missing", { default_device_cap: 5, history_setting: true }],
    [
      "enabled string",
      {
        enabled: "true",
        default_device_cap: 5,
        formats_v2: true,
        history_setting: true,
      },
    ],
    ["cap missing", { enabled: true, formats_v2: true, history_setting: true }],
    [
      "cap negative",
      {
        enabled: true,
        default_device_cap: -1,
        formats_v2: true,
        history_setting: true,
      },
    ],
  ];
  for (const [name, raw] of cases) {
    assert.deepEqual(parseProtectedChannelsFeature(raw), OFF, name);
  }
});

test("S4 the wire key is history_setting, never historySetting", () => {
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 7,
      formats_v2: true,
      historySetting: true,
    }),
    {
      enabled: true,
      defaultDeviceCap: 7,
      formatsV2: true,
      historySetting: false,
    },
  );
  // and the iPhone switch beside it is not the history setting
  assert.deepEqual(
    parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 7,
      formats_v2: true,
      ios: true,
    }),
    {
      enabled: true,
      defaultDeviceCap: 7,
      formatsV2: true,
      historySetting: false,
    },
  );
});

test("S4 history_setting without formats_v2 is logged once", async () => {
  const noV2 = { enabled: true, default_device_cap: 7, history_setting: true };
  const fresh = await freshFlagModule();
  assert.notEqual(
    fresh.parseProtectedChannelsFeature,
    parseProtectedChannelsFeature,
    "a new module instance",
  );
  const lines = await captureWarnings(async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal(
        fresh.parseProtectedChannelsFeature(noV2).historySetting,
        false,
      );
    }
    const { client } = fakeClient(async () => root(noV2));
    const fetched = await fresh.fetchProtectedChannelsFlag(client);
    assert.equal(fetched.historySetting, false);
  });
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0], /^\[protected\] /);
  assert.match(lines[0], /history_setting/);
  assert.match(lines[0], /formats_v2/);

  // nothing to say when the advert is usable, off, or simply has no history
  const quiet = await freshFlagModule();
  const silent = await captureWarnings(() => {
    quiet.parseProtectedChannelsFeature({ ...noV2, formats_v2: true });
    quiet.parseProtectedChannelsFeature({ ...noV2, history_setting: false });
    quiet.parseProtectedChannelsFeature({ ...noV2, history_setting: "true" });
    quiet.parseProtectedChannelsFeature({
      enabled: true,
      default_device_cap: 7,
    });
    quiet.parseProtectedChannelsFeature({ ...noV2, default_device_cap: "7" });
    quiet.parseProtectedChannelsFeature(null);
  });
  assert.deepEqual(silent, []);
});

test("S4 fetch reads history_setting inside features.protected_channels only", async () => {
  const on = fakeClient(async () =>
    root({
      enabled: true,
      default_device_cap: 3,
      formats_v2: true,
      history_setting: true,
    }),
  );
  assert.deepEqual(await fetchProtectedChannelsFlag(on.client), {
    enabled: true,
    defaultDeviceCap: 3,
    formatsV2: true,
    historySetting: true,
  });
  // the key one level up (beside protected_channels) is not the advert
  const misplaced = fakeClient(async () => ({
    features: {
      history_setting: true,
      protected_channels: {
        enabled: true,
        default_device_cap: 3,
        formats_v2: true,
      },
    },
  }));
  assert.deepEqual(await fetchProtectedChannelsFlag(misplaced.client), {
    enabled: true,
    defaultDeviceCap: 3,
    formatsV2: true,
    historySetting: false,
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
    historySetting: false,
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

/**
 * What the S4 backend (2efca34c) appends to the struct after the fixture's
 * three S2 fields, in struct order. `ios` is advertised but never read here.
 */
const S4_STRUCT_FIELDS = ["history_setting: bool", "ios: bool"];

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
    historySetting: false,
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
    historySetting: false,
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
    historySetting: false,
  });
  // S4: the history key, by the backend's name, at the same path
  const historyKey = S4_STRUCT_FIELDS[0].split(": ")[0];
  assert.equal(historyKey, "history_setting");
  const withHistory = { ...advert, [historyKey]: true };
  const on = {
    enabled: true,
    defaultDeviceCap: 3,
    formatsV2: true,
    historySetting: true,
  };
  assert.deepEqual(parseProtectedChannelsFeature(withHistory), on);
  const historyBody = BACKEND.advert_path.reduceRight<unknown>(
    (inner, key) => ({ [key]: inner }),
    withHistory,
  );
  const history = fakeClient(() => Promise.resolve(historyBody));
  assert.deepEqual(await fetchProtectedChannelsFlag(history.client), on);
});

test("the backend fixture matches the backend source", (t) => {
  // The gates' S4 tree first; never an S1 or S2 backend worktree.
  const dir =
    process.env.SLOGA_BACKEND_DIR ??
    process.env.W4_BACKEND_DIR ??
    "/home/mcp/pc-logs/s4/w4/be-2efca34c";
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
  // exact, in order: the fixture's S2 fields, then the two S4 ones
  assert.deepEqual(fields, [...BACKEND.struct_fields, ...S4_STRUCT_FIELDS]);
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
    t.skip("backend cross-check not run: set SLOGA_BACKEND_DIR (S4 backend)");
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
    "history_setting: bool",
    "ios: bool",
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

test("S4 backend source: history_setting is a bool, advertised as configured", (t) => {
  const dir = process.env.SLOGA_BACKEND_DIR;
  if (!dir) {
    t.skip("backend cross-check not run: set SLOGA_BACKEND_DIR (S4 backend)");
    return;
  }
  const file = join(dir, "crates/delta/src/routes/root.rs");
  assert.ok(existsSync(file), `SLOGA_BACKEND_DIR is not a backend: ${file}`);
  const src = readFileSync(file, "utf8");
  const struct = src.match(
    /pub struct ProtectedChannelsFeature \{([\s\S]*?)\n\}/,
  );
  assert.ok(struct, "ProtectedChannelsFeature struct not found");
  const keys = [...struct[1].matchAll(/pub (\w+): (\w+),/g)].map((m) => m[1]);
  assert.deepEqual(keys, [
    "enabled",
    "default_device_cap",
    "formats_v2",
    "history_setting",
    "ios",
  ]);
  assert.match(struct[1], /\n {4}pub history_setting: bool,/);
  const advert = src.match(
    /protected_channels: ProtectedChannelsFeature \{([\s\S]*?)\n\s*\},/,
  );
  assert.ok(advert, "the protected_channels advert literal not found");
  // the plain configured value: the server ties it to neither `enabled` nor
  // `formats_v2`, which is why the parser has to combine the three itself
  assert.match(
    advert[1],
    /\bhistory_setting: config\.features\.protected_channels\.history_setting,/,
  );
  assert.doesNotMatch(advert[1], /history_setting[^,]*&&/);
  assert.doesNotMatch(advert[1], /&&[^,]*history_setting/);
});

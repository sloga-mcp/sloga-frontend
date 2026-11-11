// Unit spec for the Protected channels platform gate (S7 lane C4). Run with
// Node's built-in runner from packages/client:
//   node --test --conditions=browser components/client/protectedPlatform.test.ts
// Focus: the plan D9 matrix. Tauri keeps W4's behaviour (the flag is not
// consulted); Electron and Android run the text plane only with protocol 1,
// (Android) the WebMessageListener bridge, and the server flag; an unknown
// flag or a pending Android probe HOLDS (structural, index not ready) and
// never hands envelopes to the call path; iOS, web, popout and overlay are
// closed. The flag reducer is sticky on failed refreshes only (RR-1, Final
// scoped look 4/5). The store owner fails closed on UNKNOWN off Tauri (Step 0
// fold 1). `unavailable` from the 3 dialog commands is `busy` (D7).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type AndroidProbe,
  type FlagEvent,
  type FlagState,
  type ShellTransportKind,
  type StoreOwnerCheck,
  type StructuralInput,
  PROTECTED_PLATFORM_MARKER,
  mapTextInvokeError,
  protectedPlatformTag,
  reduceFlag,
  storeOwnerAllows,
  structuralState,
} from "./protectedPlatform.ts";
import { TEXT_COMMANDS } from "./protectedTextTypes.ts";

const T = { structural: true, hold: false };
const F = { structural: false, hold: false };
const HOLD = { structural: true, hold: true };

const FLAGS: readonly FlagState[] = ["on", "off", "unknown"];
const TRANSPORTS: readonly ShellTransportKind[] = [
  "tauri",
  "electron",
  "capacitor",
  "web",
];

const OK: AndroidProbe = {
  state: "ok",
  value: { protocol: 1, listenerBridge: true },
};
const PROBES: readonly (AndroidProbe | null)[] = [
  null,
  { state: "pending" },
  { state: "failed" },
  OK,
  { state: "ok", value: { protocol: 1, listenerBridge: false } },
  { state: "ok", value: { protocol: 0, listenerBridge: true } },
  { state: "ok", value: { protocol: 2, listenerBridge: true } },
];
const ELECTRON_PROTOCOLS: readonly (number | undefined)[] = [
  undefined,
  0,
  1,
  2,
  1.5,
  Number.NaN,
];

function tauri(over: Partial<StructuralInput> = {}): StructuralInput {
  return {
    transport: "tauri",
    platform: "",
    electronProtocol: undefined,
    androidProbe: null,
    popout: false,
    overlay: false,
    flag: "unknown",
    ...over,
  };
}

function electron(over: Partial<StructuralInput> = {}): StructuralInput {
  return {
    transport: "electron",
    platform: "",
    electronProtocol: 1,
    androidProbe: null,
    popout: false,
    overlay: false,
    flag: "on",
    ...over,
  };
}

function android(over: Partial<StructuralInput> = {}): StructuralInput {
  return {
    transport: "capacitor",
    platform: "android",
    electronProtocol: undefined,
    androidProbe: OK,
    popout: false,
    overlay: false,
    flag: "on",
    ...over,
  };
}

/** Every combination of the inputs. */
function* everyInput(): Generator<StructuralInput> {
  const bools = [false, true];
  for (const transport of TRANSPORTS)
    for (const platform of ["", "android", "ios", "web"])
      for (const electronProtocol of ELECTRON_PROTOCOLS)
        for (const androidProbe of PROBES)
          for (const popout of bools)
            for (const overlay of bools)
              for (const flag of FLAGS)
                yield {
                  transport,
                  platform,
                  electronProtocol,
                  androidProbe,
                  popout,
                  overlay,
                  flag,
                };
}

// ---------------------------------------------------------------------------
// structuralState: the plan D9 matrix rows
// ---------------------------------------------------------------------------

test("D9 Tauri main window: structural, never held, flag not consulted", () => {
  for (const flag of FLAGS)
    for (const androidProbe of PROBES)
      for (const electronProtocol of ELECTRON_PROTOCOLS)
        assert.deepEqual(
          structuralState(tauri({ flag, androidProbe, electronProtocol })),
          T,
          `tauri flag=${flag}`,
        );
});

test("D9 Electron protocol 1 + flag on: structural", () => {
  assert.deepEqual(structuralState(electron()), T);
});

test("D9 Electron without the protectedText flag (no protocol): closed", () => {
  for (const flag of FLAGS)
    assert.deepEqual(
      structuralState(electron({ electronProtocol: undefined, flag })),
      F,
      `flag=${flag}`,
    );
});

test("D9 Electron protocol 2 (or any value other than 1): closed", () => {
  for (const electronProtocol of [0, 2, 1.5, Number.NaN, -1])
    for (const flag of FLAGS)
      assert.deepEqual(
        structuralState(electron({ electronProtocol, flag })),
        F,
        `protocol=${electronProtocol} flag=${flag}`,
      );
  // A string "1" from an untyped bridge is not the number 1.
  assert.deepEqual(
    structuralState(
      electron({ electronProtocol: "1" as unknown as number, flag: "on" }),
    ),
    F,
  );
});

test("D9 Electron flag not advertised (off): closed", () => {
  assert.deepEqual(structuralState(electron({ flag: "off" })), F);
});

test("D9 Electron flag unknown: hold (structural, index not ready)", () => {
  assert.deepEqual(structuralState(electron({ flag: "unknown" })), HOLD);
});

test("D9 Android capability ok + flag on: structural", () => {
  assert.deepEqual(structuralState(android()), T);
});

test("D9 Android flag unknown: hold", () => {
  assert.deepEqual(structuralState(android({ flag: "unknown" })), HOLD);
});

test("D9 Android flag off: closed", () => {
  assert.deepEqual(structuralState(android({ flag: "off" })), F);
});

test("D9 Android legacy bridge (no WebMessageListener): closed", () => {
  for (const flag of FLAGS)
    assert.deepEqual(
      structuralState(
        android({
          androidProbe: {
            state: "ok",
            value: { protocol: 1, listenerBridge: false },
          },
          flag,
        }),
      ),
      F,
      `flag=${flag}`,
    );
  // A truthy non-boolean from an untyped bridge is not `true`.
  assert.deepEqual(
    structuralState(
      android({
        androidProbe: {
          state: "ok",
          value: { protocol: 1, listenerBridge: 1 as unknown as boolean },
        },
      }),
    ),
    F,
  );
});

test("D9 Android protocol other than 1: closed", () => {
  for (const protocol of [0, 2, -1, 1.5, Number.NaN])
    for (const flag of FLAGS)
      assert.deepEqual(
        structuralState(
          android({
            androidProbe: {
              state: "ok",
              value: { protocol, listenerBridge: true },
            },
            flag,
          }),
        ),
        F,
        `protocol=${protocol} flag=${flag}`,
      );
});

test("D9 Android probe pending: hold, never the call path", () => {
  for (const flag of FLAGS)
    assert.deepEqual(
      structuralState(android({ androidProbe: { state: "pending" }, flag })),
      HOLD,
      `flag=${flag}`,
    );
});

test("D9 Android probe failed or absent: closed", () => {
  for (const androidProbe of [{ state: "failed" } as const, null])
    for (const flag of FLAGS)
      assert.deepEqual(
        structuralState(android({ androidProbe, flag })),
        F,
        `probe=${JSON.stringify(androidProbe)} flag=${flag}`,
      );
});

test("D9 iOS: closed for every probe and flag", () => {
  for (const androidProbe of PROBES)
    for (const flag of FLAGS)
      assert.deepEqual(
        structuralState(android({ platform: "ios", androidProbe, flag })),
        F,
        `probe=${JSON.stringify(androidProbe)} flag=${flag}`,
      );
});

test("D9 web: closed for every input", () => {
  for (const i of everyInput()) {
    if (i.transport !== "web") continue;
    assert.deepEqual(structuralState(i), F, JSON.stringify(i));
  }
});

test("D9 popout / overlay: closed on every transport", () => {
  let n = 0;
  for (const i of everyInput()) {
    if (!i.popout && !i.overlay) continue;
    n++;
    assert.deepEqual(structuralState(i), F, JSON.stringify(i));
  }
  assert.ok(n > 0);
});

test("D9 an unexpected runtime transport, probe state or flag is closed", () => {
  assert.deepEqual(
    structuralState(
      tauri({ transport: "ios" as unknown as ShellTransportKind }),
    ),
    F,
  );
  assert.deepEqual(
    structuralState(
      android({ androidProbe: { state: "bogus" } as unknown as AndroidProbe }),
    ),
    F,
  );
  assert.deepEqual(
    structuralState(
      android({ androidProbe: { state: "ok" } as unknown as AndroidProbe }),
    ),
    F,
  );
  for (const flag of ["", "true", "ON"])
    for (const i of [electron(), android()])
      assert.deepEqual(
        structuralState({ ...i, flag: flag as FlagState }),
        F,
        `${i.transport} flag=${JSON.stringify(flag)}`,
      );
});

test("D9 every input agrees with the plan's predicate; hold implies structural", () => {
  let n = 0;
  for (const i of everyInput()) {
    n++;
    const p = i.androidProbe;
    const okNative =
      p?.state === "ok" &&
      p.value.protocol === 1 &&
      p.value.listenerBridge === true;
    const structural =
      !i.popout &&
      !i.overlay &&
      (i.transport === "tauri" ||
        (i.transport === "electron" &&
          i.electronProtocol === 1 &&
          i.flag !== "off") ||
        (i.transport === "capacitor" &&
          i.platform === "android" &&
          (p?.state === "pending" || (okNative && i.flag !== "off"))));
    // The Android probe is read on Capacitor only.
    const hold =
      structural &&
      i.transport !== "tauri" &&
      ((i.transport === "capacitor" && p?.state === "pending") ||
        i.flag === "unknown");
    const got = structuralState(i);
    assert.deepEqual(got, { structural, hold }, JSON.stringify(i));
    if (got.hold) assert.equal(got.structural, true);
  }
  assert.equal(n, 4 * 4 * 6 * 7 * 2 * 2 * 3);
});

test("structuralState returns a fresh object each call", () => {
  const a = structuralState(tauri());
  const b = structuralState(tauri());
  assert.notEqual(a, b);
  a.structural = false;
  assert.deepEqual(structuralState(tauri()), T);
});

// ---------------------------------------------------------------------------
// reduceFlag (RR-1)
// ---------------------------------------------------------------------------

/** [prev, event, next]: every state against every event. */
const FLAG_TABLE: readonly [FlagState, FlagEvent, FlagState][] = [
  ["unknown", { kind: "seed", value: null }, "unknown"],
  ["on", { kind: "seed", value: null }, "unknown"],
  ["off", { kind: "seed", value: null }, "unknown"],
  ["unknown", { kind: "seed", value: "on" }, "on"],
  ["on", { kind: "seed", value: "on" }, "on"],
  ["off", { kind: "seed", value: "on" }, "on"],
  ["unknown", { kind: "seed", value: "off" }, "off"],
  ["on", { kind: "seed", value: "off" }, "off"],
  ["off", { kind: "seed", value: "off" }, "off"],
  ["unknown", { kind: "fetch_ok", enabled: true }, "on"],
  ["on", { kind: "fetch_ok", enabled: true }, "on"],
  ["off", { kind: "fetch_ok", enabled: true }, "on"],
  ["unknown", { kind: "fetch_ok", enabled: false }, "off"],
  ["on", { kind: "fetch_ok", enabled: false }, "off"],
  ["off", { kind: "fetch_ok", enabled: false }, "off"],
  ["unknown", { kind: "fetch_failed" }, "unknown"],
  ["on", { kind: "fetch_failed" }, "on"],
  ["off", { kind: "fetch_failed" }, "off"],
  ["unknown", { kind: "timeout" }, "off"],
  ["on", { kind: "timeout" }, "on"],
  ["off", { kind: "timeout" }, "off"],
];

test("reduceFlag: every state x event transition", () => {
  assert.equal(FLAG_TABLE.length, 3 * 7);
  for (const [prev, ev, next] of FLAG_TABLE)
    assert.equal(reduceFlag(prev, ev), next, `${prev} + ${JSON.stringify(ev)}`);
});

test("reduceFlag: a fetch failure after a known on stays on", () => {
  let s = reduceFlag("unknown", { kind: "seed", value: "on" });
  s = reduceFlag(s, { kind: "fetch_failed" });
  assert.equal(s, "on");
  s = reduceFlag(s, { kind: "timeout" });
  assert.equal(s, "on");
  // and from a fetched on, not only a seeded one
  s = reduceFlag("unknown", { kind: "fetch_ok", enabled: true });
  s = reduceFlag(s, { kind: "fetch_failed" });
  assert.equal(s, "on");
  assert.deepEqual(structuralState(electron({ flag: s })), T);
});

test("reduceFlag: timeout with no last-known value is off", () => {
  let s = reduceFlag("unknown", { kind: "seed", value: null });
  assert.equal(s, "unknown");
  s = reduceFlag(s, { kind: "fetch_failed" });
  assert.equal(s, "unknown");
  s = reduceFlag(s, { kind: "timeout" });
  assert.equal(s, "off");
  assert.deepEqual(structuralState(android({ flag: s })), F);
});

test("reduceFlag: a successful off replaces a seeded on", () => {
  let s = reduceFlag("unknown", { kind: "seed", value: "on" });
  s = reduceFlag(s, { kind: "fetch_ok", enabled: false });
  assert.equal(s, "off");
  assert.deepEqual(structuralState(electron({ flag: s })), F);
});

test("reduceFlag: a seed outside on/off, or a non-boolean enabled, fails closed", () => {
  for (const value of ["true", "ON", "", undefined, 1])
    assert.equal(
      reduceFlag("on", {
        kind: "seed",
        value: value as unknown as "on",
      }),
      "unknown",
      `seed ${JSON.stringify(value)}`,
    );
  for (const enabled of ["true", 1, null, undefined])
    assert.equal(
      reduceFlag("unknown", {
        kind: "fetch_ok",
        enabled: enabled as unknown as boolean,
      }),
      "off",
      `enabled ${JSON.stringify(enabled)}`,
    );
});

// ---------------------------------------------------------------------------
// storeOwnerAllows (Step 0 fold 1, A8)
// ---------------------------------------------------------------------------

const SELF = "01SELF";
const OTHER = "01OTHER";
const UNKNOWN: StoreOwnerCheck = { state: "unknown" };
const FRESH: StoreOwnerCheck = { state: "known", owner: null };
const MINE: StoreOwnerCheck = { state: "known", owner: SELF };
const FOREIGN: StoreOwnerCheck = { state: "known", owner: OTHER };

test("storeOwnerAllows: Android owner unknown is not capable", () => {
  assert.equal(storeOwnerAllows("capacitor", UNKNOWN, SELF), false);
  assert.equal(storeOwnerAllows("capacitor", UNKNOWN, null), false);
});

test("storeOwnerAllows: Android owner foreign is not capable", () => {
  assert.equal(storeOwnerAllows("capacitor", FOREIGN, SELF), false);
  assert.equal(storeOwnerAllows("capacitor", FOREIGN, null), false);
});

test("storeOwnerAllows: Android owner self or null (fresh store) is capable", () => {
  assert.equal(storeOwnerAllows("capacitor", MINE, SELF), true);
  assert.equal(storeOwnerAllows("capacitor", FRESH, SELF), true);
});

test("storeOwnerAllows: Electron matches Android (unknown and foreign F, self or null T)", () => {
  assert.equal(storeOwnerAllows("electron", UNKNOWN, SELF), false);
  assert.equal(storeOwnerAllows("electron", FOREIGN, SELF), false);
  assert.equal(storeOwnerAllows("electron", MINE, SELF), true);
  assert.equal(storeOwnerAllows("electron", FRESH, SELF), true);
});

test("storeOwnerAllows: Tauri keeps W4's latch (only a known foreign owner refuses)", () => {
  assert.equal(storeOwnerAllows("tauri", UNKNOWN, SELF), true);
  assert.equal(storeOwnerAllows("tauri", FRESH, SELF), true);
  assert.equal(storeOwnerAllows("tauri", MINE, SELF), true);
  assert.equal(storeOwnerAllows("tauri", FOREIGN, SELF), false);
});

test("storeOwnerAllows: web is never allowed", () => {
  for (const check of [UNKNOWN, FRESH, MINE, FOREIGN])
    for (const userId of [SELF, null])
      assert.equal(storeOwnerAllows("web", check, userId), false);
});

test("storeOwnerAllows: the full transport x check x user matrix", () => {
  const checks: readonly [string, StoreOwnerCheck][] = [
    ["unknown", UNKNOWN],
    ["fresh", FRESH],
    ["mine", MINE],
    ["foreign", FOREIGN],
  ];
  // expected[transport][check][userId SELF, userId null]
  const expected: Record<
    ShellTransportKind,
    Record<string, [boolean, boolean]>
  > = {
    tauri: {
      unknown: [true, true],
      fresh: [true, true],
      mine: [true, false],
      foreign: [false, false],
    },
    electron: {
      unknown: [false, false],
      fresh: [true, true],
      mine: [true, false],
      foreign: [false, false],
    },
    capacitor: {
      unknown: [false, false],
      fresh: [true, true],
      mine: [true, false],
      foreign: [false, false],
    },
    web: {
      unknown: [false, false],
      fresh: [false, false],
      mine: [false, false],
      foreign: [false, false],
    },
  };
  for (const transport of TRANSPORTS)
    for (const [name, check] of checks) {
      const [withSelf, withNull] = expected[transport][name];
      assert.equal(
        storeOwnerAllows(transport, check, SELF),
        withSelf,
        `${transport} ${name} self`,
      );
      assert.equal(
        storeOwnerAllows(transport, check, null),
        withNull,
        `${transport} ${name} null`,
      );
    }
  assert.equal(
    storeOwnerAllows("ios" as unknown as ShellTransportKind, MINE, SELF),
    false,
  );
});

// ---------------------------------------------------------------------------
// mapTextInvokeError (D7)
// ---------------------------------------------------------------------------

const DIALOG = [
  "e2ee_text_seat_list_sign",
  "e2ee_text_owner_confirm_change",
  "e2ee_text_owner_handover_sign",
] as const;

test("mapTextInvokeError: the dialog commands are text commands", () => {
  for (const cmd of DIALOG)
    assert.ok((TEXT_COMMANDS as readonly string[]).includes(cmd), cmd);
});

test("mapTextInvokeError: unavailable from a dialog command is busy", () => {
  for (const cmd of DIALOG) {
    assert.deepEqual(mapTextInvokeError(cmd, { type: "unavailable" }), {
      type: "busy",
    });
    // Extra fields do not survive: the caller sees exactly `busy`.
    assert.deepEqual(
      mapTextInvokeError(cmd, { type: "unavailable", detail: "x" }),
      { type: "busy" },
    );
  }
});

test("mapTextInvokeError: other errors from a dialog command pass through unchanged", () => {
  const others: unknown[] = [
    { type: "busy" },
    { type: "declined" },
    { type: "not_enabled" },
    { type: "Unavailable" },
    { source: "client", reason: "not_capable" },
    { reason: "unavailable" },
    "unavailable",
    '{"type":"unavailable"}',
    new Error("unavailable"),
    null,
    undefined,
    42,
  ];
  for (const cmd of DIALOG)
    for (const err of others)
      assert.equal(mapTextInvokeError(cmd, err), err, `${cmd} ${String(err)}`);
});

test("mapTextInvokeError: unavailable from any other command passes through unchanged", () => {
  const cmds = [
    ...TEXT_COMMANDS.filter((c) => !(DIALOG as readonly string[]).includes(c)),
    "e2ee_store_owner",
    "e2ee_text_seat_list_sign ",
    "E2EE_TEXT_SEAT_LIST_SIGN",
    "",
  ];
  assert.ok(cmds.length >= 17);
  for (const cmd of cmds) {
    const err = { type: "unavailable" };
    assert.equal(mapTextInvokeError(cmd, err), err, cmd);
  }
});

// ---------------------------------------------------------------------------
// protectedPlatformTag + purity
// ---------------------------------------------------------------------------

test("protectedPlatformTag starts with the marker literal", () => {
  assert.equal(PROTECTED_PLATFORM_MARKER, "sloga:s7-protected-platform:v1");
  for (const i of [
    tauri(),
    electron(),
    android(),
    android({ platform: "ios" }),
  ])
    assert.ok(
      protectedPlatformTag(i).startsWith("sloga:s7-protected-platform:v1 "),
      protectedPlatformTag(i),
    );
});

test("protectedPlatformTag reports the facts and the verdict", () => {
  const tag = protectedPlatformTag(android({ flag: "unknown" }));
  assert.equal(
    tag,
    "sloga:s7-protected-platform:v1 transport=capacitor platform=android" +
      " electronProtocol=undefined probe=ok/protocol=1/listener=true" +
      " popout=false overlay=false flag=unknown structural=true hold=true",
  );
  const e = protectedPlatformTag(electron({ flag: "off" }));
  assert.ok(e.includes(" transport=electron "), e);
  assert.ok(e.includes(" platform=- "), e);
  assert.ok(e.endsWith(" structural=false hold=false"), e);
  for (const i of everyInput())
    assert.ok(!protectedPlatformTag(i).includes("\n"), JSON.stringify(i));
});

test("the module is pure: no imports", () => {
  const src = readFileSync(
    new URL("./protectedPlatform.ts", import.meta.url),
    "utf8",
  );
  const imports = src
    .split("\n")
    .filter((line) => /^\s*(import|export\s.*\sfrom\s)/.test(line));
  assert.deepEqual(imports, []);
  assert.ok(!/\brequire\(|\bimport\(/.test(src));
});

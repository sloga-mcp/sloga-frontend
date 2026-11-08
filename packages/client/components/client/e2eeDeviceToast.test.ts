// Spec for the multi-device client wiring (plan D3, D5, D7, D8; W3 lane
// L-IDX):
//
//  T1  `takeNewDeviceToasts` yields each new own device once, by device id;
//  T2  a non-empty `splitFrom` selects the split toast, anything else the
//      "Not you?" warning; the session name is cleaned and capped;
//  T3  the worker's copy is verbatim, the named and unnamed warnings and the
//      split line each from its own toast kind, and it shows through the
//      snackbar only, once per entry;
//  T4  `src/Interface.tsx` mounts the worker once, beside
//      `<NotificationsWorker />`;
//  M1  `index.tsx` opens `e2ee_finish_setup` on `publishPending`,
//      `e2ee_device_shared` only on `via: "held_elsewhere"`, and
//      `e2ee_device_removed` on `deviceRemoved`, each once per episode;
//  E1  `errors.ts` maps `E2EEDeviceRemoved` on the string chain, ahead of the
//      typed switch;
//  C1  every new msgid resolves in the English catalog (a missing one renders
//      its hash).
//
// The worker and `index.tsx` cannot load under Node (Solid JSX, lingui
// macros), so they are read as text; where a rule is a decision, the snippet
// is lifted out, its types stripped, and run with stubs.
//
// Run: node --test --conditions=browser components/client/e2eeDeviceToast.test.ts
// Controls scan another copy: `E2EE_DEVICE_TOAST_MODULE`, `_WORKER`, `_INDEX`,
// `_INTERFACE`, `_ERRORS`, `_CATALOG` (paths).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const env = process.env;

const mod = (await import(
  env.E2EE_DEVICE_TOAST_MODULE
    ? pathToFileURL(env.E2EE_DEVICE_TOAST_MODULE).href
    : "./e2eeDeviceToast.ts"
)) as typeof import("./e2eeDeviceToast.ts");
const { TOAST_SESSION_NAME_MAX, deviceToastFor, takeNewDeviceToasts } = mod;
const { toastSessionName } = mod;

function source(override: string | undefined, relative: string): string {
  return readFileSync(override || new URL(relative, import.meta.url), "utf8");
}

const WORKER = source(
  env.E2EE_DEVICE_TOAST_WORKER,
  "./E2EEDeviceToastWorker.tsx",
);
const INDEX = source(env.E2EE_DEVICE_TOAST_INDEX, "./index.tsx");
const INTERFACE = source(
  env.E2EE_DEVICE_TOAST_INTERFACE,
  "../../src/Interface.tsx",
);
const ERRORS = source(env.E2EE_DEVICE_TOAST_ERRORS, "../i18n/errors.ts");

// ---- Copy (contract §5 and §7 Q4, Q5; verbatim) --------------------------------

const SPLIT = "Your other app became a separate device.";
const NAMED =
  "Encryption was set up on another of your devices ({sessionName}). Not you? Remove it in Settings > Encryption, change your password, then log out other sessions.";
const UNNAMED =
  "Encryption was set up on another of your devices. Not you? Remove it in Settings > Encryption, change your password, then log out other sessions.";
const REMOVED = "This device was removed from your account's encryption.";

// ---- Source helpers ------------------------------------------------------------

/** The text from `start` up to (not including) `end`; `start` exactly once. */
function between(src: string, start: string, end: string): string {
  const count = src.split(start).length - 1;
  assert.equal(count, 1, `expected exactly one ${JSON.stringify(start)}`);
  const from = src.indexOf(start);
  const to = src.indexOf(end, from + start.length);
  assert.ok(to > from, `no ${JSON.stringify(end)} after ${start}`);
  return src.slice(from, to);
}

/** Run TypeScript `code` as a function body over `scope`. */
function run(code: string, scope: Record<string, unknown>): unknown {
  // Wrapped first: the stripper parses a module, where `return` is invalid
  const js = stripTypeScriptTypes(`function __body() {\n${code}\n}`);
  return new Function(...Object.keys(scope), `${js}\nreturn __body();`)(
    ...Object.values(scope),
  );
}

/** The lingui `t` macro as a plain template tag, placeholders kept named. */
const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
  String.raw({ raw: strings }, ...values);

type Entry = { splitFrom: string | null; sessionName: string | null };

// ---- T1: each device once --------------------------------------------------------

test("T1 takeNewDeviceToasts yields each device id once", () => {
  const shown = new Set<string>();
  const a: [string, Entry] = [
    "devA",
    { splitFrom: null, sessionName: "Pixel" },
  ];
  const b: [string, Entry] = ["devB", { splitFrom: "devX", sessionName: null }];

  assert.deepEqual(takeNewDeviceToasts(shown, [a]), [
    { kind: "added", sessionName: "Pixel" },
  ]);
  assert.deepEqual(takeNewDeviceToasts(shown, [a]), [], "the same entry again");
  assert.deepEqual(
    takeNewDeviceToasts(shown, [a, b]),
    [{ kind: "split" }],
    "only the new device, in map order",
  );
  assert.deepEqual(takeNewDeviceToasts(shown, []), [], "a cleared map");
  assert.deepEqual(
    takeNewDeviceToasts(shown, [
      ["devA", { splitFrom: null, sessionName: "Renamed" }],
    ]),
    [],
    "a device id shows once, whatever its entry later holds",
  );
  assert.deepEqual([...shown], ["devA", "devB"]);

  const fresh = new Set<string>();
  assert.equal(
    takeNewDeviceToasts(fresh, [a, b]).length,
    2,
    "a new shown set (a new bridge) starts clear",
  );
});

// ---- T2: split vs warning, session name --------------------------------------------

test("T2 only a non-empty splitFrom selects the split toast", () => {
  assert.deepEqual(deviceToastFor({ splitFrom: "old", sessionName: "Mac" }), {
    kind: "split",
  });
  assert.deepEqual(deviceToastFor({ splitFrom: null, sessionName: "Mac" }), {
    kind: "added",
    sessionName: "Mac",
  });
  assert.deepEqual(deviceToastFor({ splitFrom: "", sessionName: null }), {
    kind: "added",
    sessionName: null,
  });
  assert.deepEqual(
    deviceToastFor({
      splitFrom: undefined as unknown as null,
      sessionName: null,
    }),
    { kind: "added", sessionName: null },
  );
});

test("T2 the session name is cleaned, capped, and null when blank", () => {
  assert.equal(toastSessionName(null), null);
  assert.equal(toastSessionName(undefined), null);
  assert.equal(toastSessionName(""), null);
  assert.equal(toastSessionName("  \n\t "), null);
  assert.equal(
    toastSessionName("  Chrome \n on   Windows "),
    "Chrome on Windows",
  );

  const rlo = String.fromCodePoint(0x202e);
  const isolate = String.fromCodePoint(0x2066);
  const zwsp = String.fromCodePoint(0x200b);
  const bom = String.fromCodePoint(0xfeff);
  const c1 = String.fromCodePoint(0x85);
  assert.equal(
    toastSessionName(`${rlo}Fire${zwsp}fox${isolate}${bom}${c1}`),
    "Firefox",
  );
  assert.equal(toastSessionName(`${rlo}${zwsp}`), null, "only hidden chars");

  const long = "x".repeat(TOAST_SESSION_NAME_MAX + 10);
  const capped = toastSessionName(long)!;
  assert.equal(Array.from(capped).length, TOAST_SESSION_NAME_MAX);
  assert.ok(capped.endsWith("…"));
  const exact = "y".repeat(TOAST_SESSION_NAME_MAX);
  assert.equal(toastSessionName(exact), exact, "at the cap, uncut");
  // Code points, not UTF-16 units: an astral name is not split in half
  const astral = String.fromCodePoint(0x1f600).repeat(TOAST_SESSION_NAME_MAX);
  assert.equal(toastSessionName(astral), astral);

  assert.deepEqual(deviceToastFor({ splitFrom: null, sessionName: zwsp }), {
    kind: "added",
    sessionName: null,
  });
});

// ---- T3: the worker's copy and wiring ------------------------------------------------

/** `deviceToastCopy` from the worker, run with the `t` stub. */
function copyFor(toast: unknown): string {
  const fn =
    between(WORKER, "  function deviceToastCopy(", "\n  }\n") + "\n  }";
  const copy = run(`${fn}\nreturn deviceToastCopy;`, { t }) as (
    toast: unknown,
  ) => string;
  return copy(toast);
}

test("T3 each toast kind gets its own verbatim copy", () => {
  assert.equal(copyFor({ kind: "split" }), SPLIT);
  assert.equal(
    copyFor({ kind: "added", sessionName: "Pixel 9" }),
    NAMED.replace("{sessionName}", "Pixel 9"),
  );
  assert.equal(copyFor({ kind: "added", sessionName: null }), UNNAMED);
  // As lingui extracts them: the named copy's placeholder is `sessionName`
  for (const copy of [SPLIT, UNNAMED]) {
    assert.ok(WORKER.includes(`t\`${copy}\``), `missing t\`${copy}\``);
  }
  assert.ok(
    WORKER.includes(`t\`${NAMED.replace("{sessionName}", "${sessionName}")}\``),
    "the named copy interpolates `sessionName`",
  );
  assert.doesNotMatch(WORKER, /security warning/i);
});

test("T3 the worker shows each entry once, through the snackbar", () => {
  assert.match(
    WORKER,
    /\nimport \{ type DeviceToast, takeNewDeviceToasts \} from "\.\/e2eeDeviceToast";\n/,
    "the decisions are the spec'd module's",
  );
  assert.match(
    WORKER,
    /\nconst shownDeviceToasts = new WeakMap<object, Set<string>>\(\);\n/,
    "shown devices survive a remount (module scope), per bridge",
  );
  const effect = between(
    WORKER,
    "    const added = e2ee?.ownDeviceAdded;",
    "\n  return null;",
  );
  assert.match(
    effect,
    /const fresh = takeNewDeviceToasts\(shown, added\.entries\(\)\);/,
  );
  assert.match(effect, /shownDeviceToasts\.get\(e2ee\)/);
  assert.match(effect, /shownDeviceToasts\.set\(e2ee, shown\)/);
  assert.equal(WORKER.split("snackbar.show(").length - 1, 1, "one snackbar");
  const show = between(effect, "snackbar.show({", "});");
  assert.match(show, /message: deviceToastCopy\(toast\),/);
  assert.doesNotMatch(show, /deviceId|splitFrom|\bid\b/, "no ids on screen");
});

// ---- T4: mounted once ------------------------------------------------------------

test("T4 Interface.tsx mounts the worker once, beside NotificationsWorker", () => {
  assert.equal(INTERFACE.split("<E2EEDeviceToastWorker />").length - 1, 1);
  assert.match(
    INTERFACE,
    /\n {8}<NotificationsWorker \/>\n {8}<E2EEDeviceToastWorker \/>\n/,
  );
  assert.match(
    INTERFACE,
    /\nimport \{ E2EEDeviceToastWorker \} from "@revolt\/client\/E2EEDeviceToastWorker";\n/,
  );
});

// ---- M1: auto-open modals, once per episode ------------------------------------------

/** A reactive-map stand-in: `get("state")` only. */
function stateMap(value: () => unknown) {
  return { get: (key: string) => (key === "state" ? value() : undefined) };
}

/**
 * The `index.tsx` effect guarded by `flag`, run against stubs.
 * @returns A step function: run the effect once, return what it opened
 */
function autoOpen(flag: string, bridge: Record<string, unknown>) {
  const block =
    between(INDEX, `  let ${flag} = false;\n`, "\n  });\n") + "\n  });";
  const effects: (() => void)[] = [];
  const opened: unknown[] = [];
  const session = { loggedIn: true };
  run(`${block}\nreturn null;`, {
    createEffect: (fn: () => void) => effects.push(fn),
    controller: { isLoggedIn: () => session.loggedIn },
    currentE2EE: () => bridge,
    openModal: (modal: unknown) => opened.push(modal),
  });
  assert.equal(effects.length, 1, `one effect for ${flag}`);
  return {
    session,
    step(): unknown[] {
      opened.length = 0;
      effects[0]();
      return [...opened];
    },
  };
}

test("M1 publishPending opens e2ee_finish_setup once per episode", () => {
  let state: unknown = undefined;
  const bridge = { publishPending: stateMap(() => state) };
  const e = autoOpen("offeredFinishSetup", bridge);
  assert.deepEqual(e.step(), [], "nothing pending");
  state = { via: "restore", sourceDeviceId: null, at: 1 };
  assert.deepEqual(e.step(), [{ type: "e2ee_finish_setup" }]);
  state = { via: "resume", sourceDeviceId: null, at: 2 };
  assert.deepEqual(e.step(), [], "re-raised within the episode");
  state = undefined;
  assert.deepEqual(e.step(), []);
  state = { via: "resume", sourceDeviceId: null, at: 3 };
  assert.deepEqual(e.step(), [{ type: "e2ee_finish_setup" }], "new episode");
  e.session.loggedIn = false;
  assert.deepEqual(e.step(), []);
  e.session.loggedIn = true;
  assert.deepEqual(e.step(), [{ type: "e2ee_finish_setup" }], "new session");
});

test("M1 deviceShared opens e2ee_device_shared only for held_elsewhere", () => {
  let state: unknown = undefined;
  const bridge = { deviceShared: stateMap(() => state) };
  const e = autoOpen("offeredDeviceShared", bridge);
  state = { via: "diverged", at: 1 };
  assert.deepEqual(e.step(), [], "divergence is a Settings card only");
  state = { via: "held_elsewhere", at: 2 };
  assert.deepEqual(e.step(), [{ type: "e2ee_device_shared" }]);
  assert.deepEqual(e.step(), [], "once per episode");
  state = undefined; // "Not now"
  assert.deepEqual(e.step(), []);
  state = { via: "held_elsewhere", at: 3 };
  assert.deepEqual(e.step(), [{ type: "e2ee_device_shared" }], "refused again");
  assert.equal(INDEX.split('"e2ee_device_shared"').length - 1, 1);
});

test("M1 deviceRemoved opens e2ee_device_removed once per episode", () => {
  let state: unknown = undefined;
  const bridge = { deviceRemoved: stateMap(() => state) };
  const e = autoOpen("offeredDeviceRemoved", bridge);
  assert.deepEqual(e.step(), []);
  state = { deviceId: "d1", at: 1 };
  assert.deepEqual(e.step(), [{ type: "e2ee_device_removed" }]);
  state = { deviceId: "d1", at: 2 };
  assert.deepEqual(e.step(), []);
  state = undefined;
  assert.deepEqual(e.step(), []);
  state = { deviceId: "d1", at: 3 };
  assert.deepEqual(e.step(), [{ type: "e2ee_device_removed" }]);
});

test("M1 no bridge opens nothing", () => {
  for (const flag of [
    "offeredFinishSetup",
    "offeredDeviceShared",
    "offeredDeviceRemoved",
  ]) {
    const block =
      between(INDEX, `  let ${flag} = false;\n`, "\n  });\n") + "\n  });";
    const opened: unknown[] = [];
    run(`${block}\nreturn null;`, {
      createEffect: (fn: () => void) => fn(),
      controller: { isLoggedIn: () => true },
      currentE2EE: () => undefined,
      openModal: (modal: unknown) => opened.push(modal),
    });
    assert.deepEqual(opened, [], flag);
  }
});

// ---- E1: the error type -------------------------------------------------------------

test("E1 errors.ts maps E2EEDeviceRemoved on the string chain", () => {
  const mapped = ERRORS.match(
    /if \(errType === "E2EEDeviceRemoved"\)\s*return t`([^`]*)`;/,
  );
  assert.equal(mapped?.[1], REMOVED);
  assert.ok(
    ERRORS.indexOf('"E2EEDeviceRemoved"') < ERRORS.indexOf("switch (err.type)"),
    "ahead of the typed switch",
  );
  assert.doesNotMatch(ERRORS, /case "E2EEDeviceRemoved"/);
});

// ---- C1: the catalog resolves the copy --------------------------------------------

test("C1 every new msgid is in the English catalog", () => {
  const en = source(
    env.E2EE_DEVICE_TOAST_CATALOG,
    "../i18n/catalogs/en/messages.po",
  );
  for (const copy of [SPLIT, NAMED, UNNAMED, REMOVED]) {
    assert.ok(
      en.includes(`msgid "${copy}"\nmsgstr "${copy}"\n`),
      `missing from catalogs/en/messages.po: ${copy}`,
    );
  }
});

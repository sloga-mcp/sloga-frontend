// Behaviour pins for the pure platform rules in `e2eePlatform.ts` that the
// iOS call E2EE work added (plan D6/D8, C4, W3 MUST 1): the iOS readiness
// rule and the one shell predicate. The older phase-1 pins stay in
// `e2eeIosGate.test.ts`.
//
// Also the backup refresh rules: which shells refresh the key backup by
// themselves (Tauri, Electron, iOS; never Android or the web, never outside
// the main window) and the hourly focus throttle. Those rows are checked
// against in-suite mutants of the module too.
//
// `E2EE_PLATFORM_MODULE` points the spec at another copy of the module, so
// a mutated copy can be shown to fail it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const MODULE_URL = process.env.E2EE_PLATFORM_MODULE
  ? pathToFileURL(process.env.E2EE_PLATFORM_MODULE)
  : new URL("./e2eePlatform.ts", import.meta.url);

const mod = (await import(
  MODULE_URL.href
)) as typeof import("./e2eePlatform.ts");
const {
  iosMediaE2EEReady,
  mediaE2EEPlatformSupported,
  platformMediaE2EESupported,
  shellMediaE2EESupported,
} = mod;

type Input = Parameters<typeof iosMediaE2EEReady>[0];

/** Every term present: the one input that may read true. */
const READY: Input = {
  capsMediaE2EE: true,
  pluginPresent: true,
  scriptTransform: true,
  probe: "pass",
};

/** Runs `fn` with `globalThis.window` set to `win`, then restores it. */
function withWindow<T>(win: object, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const had = "window" in g;
  const previous = g.window;
  g.window = win;
  try {
    return fn();
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
}

test("iosMediaE2EEReady: caps flag + plugin + script transform + probe pass = true", () => {
  assert.equal(iosMediaE2EEReady({ ...READY }), true);
});

test("iosMediaE2EEReady: only the literal true caps flag counts", () => {
  const notTrue: unknown[] = [
    undefined,
    null,
    false,
    0,
    1,
    "true",
    "yes",
    {},
    [true],
    new Boolean(true),
    () => true,
  ];
  for (const capsMediaE2EE of notTrue) {
    assert.equal(
      iosMediaE2EEReady({ ...READY, capsMediaE2EE }),
      false,
      `caps ${String(capsMediaE2EE)}`,
    );
  }
});

test("iosMediaE2EEReady: no E2ee plugin = false even with the caps flag", () => {
  assert.equal(iosMediaE2EEReady({ ...READY, pluginPresent: false }), false);
});

test("iosMediaE2EEReady: no RTCRtpScriptTransform (iOS 15.0-15.3) = false", () => {
  assert.equal(iosMediaE2EEReady({ ...READY, scriptTransform: false }), false);
});

test("iosMediaE2EEReady: a pending or failed probe = false", () => {
  assert.equal(iosMediaE2EEReady({ ...READY, probe: "pending" }), false);
  assert.equal(iosMediaE2EEReady({ ...READY, probe: "fail" }), false);
  for (const probe of ["", "PASS", "passed", undefined]) {
    assert.equal(
      iosMediaE2EEReady({ ...READY, probe: probe as Input["probe"] }),
      false,
      `probe ${String(probe)}`,
    );
  }
});

test("iosMediaE2EEReady: a truthy non-boolean plugin or transform term = false", () => {
  for (const v of [1, "true", {}]) {
    assert.equal(
      iosMediaE2EEReady({ ...READY, pluginPresent: v as unknown as boolean }),
      false,
    );
    assert.equal(
      iosMediaE2EEReady({ ...READY, scriptTransform: v as unknown as boolean }),
      false,
    );
  }
});

test("iosMediaE2EEReady: true for exactly one combination of the four terms", () => {
  const trues: string[] = [];
  let count = 0;
  for (const capsMediaE2EE of [undefined, false, true, 1]) {
    for (const pluginPresent of [false, true]) {
      for (const scriptTransform of [false, true]) {
        for (const probe of ["pending", "pass", "fail"] as const) {
          count += 1;
          const input = {
            capsMediaE2EE,
            pluginPresent,
            scriptTransform,
            probe,
          };
          if (iosMediaE2EEReady(input)) trues.push(JSON.stringify(input));
        }
      }
    }
  }
  assert.equal(count, 48);
  assert.deepEqual(trues, [
    JSON.stringify({
      capsMediaE2EE: true,
      pluginPresent: true,
      scriptTransform: true,
      probe: "pass",
    }),
  ]);
});

test("shellMediaE2EESupported: true only with all three shell terms", () => {
  const trues: string[] = [];
  for (const e2eeSupported of [false, true]) {
    for (const nativeE2EEAvailable of [false, true]) {
      for (const bridgePlatformSupported of [false, true]) {
        const input = {
          e2eeSupported,
          nativeE2EEAvailable,
          bridgePlatformSupported,
        };
        if (shellMediaE2EESupported(input)) trues.push(JSON.stringify(input));
      }
    }
  }
  assert.deepEqual(trues, [
    JSON.stringify({
      e2eeSupported: true,
      nativeE2EEAvailable: true,
      bridgePlatformSupported: true,
    }),
  ]);
});

test("shellMediaE2EESupported: a truthy non-boolean term = false", () => {
  const base = {
    e2eeSupported: true,
    nativeE2EEAvailable: true,
    bridgePlatformSupported: true,
  };
  for (const key of Object.keys(base) as (keyof typeof base)[]) {
    assert.equal(
      shellMediaE2EESupported({ ...base, [key]: 1 as unknown as boolean }),
      false,
      key,
    );
  }
});

test("iOS chain: the readiness answer is what the shell predicate sees", () => {
  // On iOS (no slogaShell) the bridge's platform term is
  // mediaE2EEPlatformSupported(keyPush), and keyPush is iosMediaE2EEReady.
  withWindow({}, () => {
    for (const probe of ["pending", "pass", "fail"] as const) {
      const keyPush = iosMediaE2EEReady({ ...READY, probe });
      const shell = shellMediaE2EESupported({
        e2eeSupported: true,
        nativeE2EEAvailable: true,
        bridgePlatformSupported: mediaE2EEPlatformSupported(keyPush),
      });
      assert.equal(shell, probe === "pass", probe);
    }
  });
});

test("mediaE2EEPlatformSupported / platformMediaE2EESupported keep their behaviour", () => {
  withWindow({}, () => {
    assert.equal(platformMediaE2EESupported(), true);
    assert.equal(mediaE2EEPlatformSupported(false), false);
    assert.equal(mediaE2EEPlatformSupported(true), true);
  });
  withWindow({ slogaShell: {} }, () => {
    assert.equal(platformMediaE2EESupported(), false);
    assert.equal(mediaE2EEPlatformSupported(true), false);
  });
  withWindow({ slogaShell: { e2ee: { mediaE2EE: 1 } } }, () => {
    assert.equal(platformMediaE2EESupported(), false);
  });
  withWindow({ slogaShell: { e2ee: { mediaE2EE: true } } }, () => {
    assert.equal(platformMediaE2EESupported(), true);
    assert.equal(mediaE2EEPlatformSupported(true), true);
    assert.equal(mediaE2EEPlatformSupported(false), false);
  });
});

test("e2eePlatform.ts stays pure: no imports, no require", () => {
  const src = readFileSync(MODULE_URL, "utf8");
  assert.doesNotMatch(src, /^\s*import[\s{*"']/m);
  assert.doesNotMatch(src, /\bimport\s*\(/);
  assert.doesNotMatch(src, /\brequire\s*\(/);
});

// ---- Backup refresh: which shells, and how often on focus ------------------

type Module = typeof import("./e2eePlatform.ts");
type RefreshInput = Parameters<Module["shellRefreshesBackup"]>[0];

const HOUR = 60 * 60 * 1000;

/** [label, input, expected]: every shell and platform the bridge can see. */
const REFRESH_ROWS: [string, RefreshInput, boolean][] = [
  [
    "Tauri main window",
    { shell: "tauri", capacitorPlatform: "web", mainWindow: true },
    true,
  ],
  [
    "Electron main window",
    { shell: "electron", capacitorPlatform: "web", mainWindow: true },
    true,
  ],
  [
    "iOS",
    { shell: "capacitor", capacitorPlatform: "ios", mainWindow: true },
    true,
  ],
  [
    "Android",
    { shell: "capacitor", capacitorPlatform: "android", mainWindow: true },
    false,
  ],
  [
    "web",
    { shell: "capacitor", capacitorPlatform: "web", mainWindow: true },
    false,
  ],
  [
    "Android under a Tauri shell value",
    { shell: "tauri", capacitorPlatform: "android", mainWindow: true },
    false,
  ],
  [
    "Android under an Electron shell value",
    { shell: "electron", capacitorPlatform: "android", mainWindow: true },
    false,
  ],
  [
    "Tauri, not the main window",
    { shell: "tauri", capacitorPlatform: "web", mainWindow: false },
    false,
  ],
  [
    "Electron, not the main window",
    { shell: "electron", capacitorPlatform: "web", mainWindow: false },
    false,
  ],
  [
    "iOS, not the main window",
    { shell: "capacitor", capacitorPlatform: "ios", mainWindow: false },
    false,
  ],
  [
    "Tauri, main window flag 1",
    {
      shell: "tauri",
      capacitorPlatform: "web",
      mainWindow: 1 as unknown as boolean,
    },
    false,
  ],
  [
    "unknown shell",
    { shell: "", capacitorPlatform: "web", mainWindow: true },
    false,
  ],
  [
    "shell spelled Tauri",
    { shell: "Tauri", capacitorPlatform: "web", mainWindow: true },
    false,
  ],
  [
    "Capacitor platform IOS",
    { shell: "capacitor", capacitorPlatform: "IOS", mainWindow: true },
    false,
  ],
  [
    "Capacitor platform electron",
    { shell: "capacitor", capacitorPlatform: "electron", mainWindow: true },
    false,
  ],
  [
    "Capacitor platform empty",
    { shell: "capacitor", capacitorPlatform: "", mainWindow: true },
    false,
  ],
];

/** [label, lastAt, now, expected] for the focus throttle. */
const FOCUS_ROWS: [string, number | null, number, boolean][] = [
  ["first focus on this bridge", null, 5, true],
  ["right after a check", 1_000, 1_000, false],
  ["one ms short of an hour", 1_000, 1_000 + HOUR - 1, false],
  ["exactly an hour", 1_000, 1_000 + HOUR, true],
  ["over an hour", 1_000, 1_000 + 3 * HOUR, true],
  ["the clock went backwards", 10 * HOUR, 9 * HOUR, true],
];

/** Every row `m` gets wrong, labelled. */
function refreshFailures(m: Module): string[] {
  const out: string[] = [];
  for (const [label, input, want] of REFRESH_ROWS) {
    const got = m.shellRefreshesBackup({ ...input });
    if (got !== want) out.push(`refresh ${label}: ${got}, want ${want}`);
  }
  for (const [label, lastAt, now, want] of FOCUS_ROWS) {
    const got = m.backupRefreshFocusDue(lastAt, now);
    if (got !== want) out.push(`focus ${label}: ${got}, want ${want}`);
  }
  if (m.BACKUP_REFRESH_FOCUS_MS !== HOUR) {
    out.push(`focus interval ${m.BACKUP_REFRESH_FOCUS_MS}, want ${HOUR}`);
  }
  return out;
}

test("shellRefreshesBackup: Tauri, Electron and iOS refresh in the main window", () => {
  for (const [label, input, want] of REFRESH_ROWS) {
    if (want) assert.equal(mod.shellRefreshesBackup(input), true, label);
  }
});

test("shellRefreshesBackup: Android and the web never refresh", () => {
  for (const [label, input] of REFRESH_ROWS) {
    if (input.capacitorPlatform === "android" || label === "web") {
      assert.equal(mod.shellRefreshesBackup(input), false, label);
    }
  }
});

test("shellRefreshesBackup: never outside the main window, and only a literal true counts", () => {
  for (const [label, input] of REFRESH_ROWS) {
    if (input.mainWindow !== true) {
      assert.equal(mod.shellRefreshesBackup(input), false, label);
    }
  }
});

test("shellRefreshesBackup: unknown shells and platforms fail closed", () => {
  assert.deepEqual(
    refreshFailures(mod).filter((f) => f.startsWith("refresh ")),
    [],
  );
});

test("backupRefreshFocusDue: the first focus is due, then at most once an hour", () => {
  assert.equal(mod.BACKUP_REFRESH_FOCUS_MS, HOUR);
  assert.deepEqual(
    refreshFailures(mod).filter((f) => !f.startsWith("refresh ")),
    [],
  );
});

/**
 * The module under test with `swaps` applied (exact, unique snippets),
 * type-stripped and imported from a data: URL: no file is written.
 */
async function moduleCopy(swaps: [string, string][]): Promise<Module> {
  let src = readFileSync(MODULE_URL, "utf8");
  for (const [from, to] of swaps) {
    assert.equal(src.split(from).length, 2, `swap not unique: ${from}`);
    src = src.replace(from, to);
  }
  const js = stripTypeScriptTypes(src);
  return (await import(
    `data:text/javascript,${encodeURIComponent(js)}`
  )) as Module;
}

/** Mutants of the backup refresh rules, and the row each must fail. */
const REFRESH_MUTANTS: {
  label: string;
  swap: [string, string];
  kills: RegExp;
}[] = [
  {
    label: "the Android rule dropped",
    swap: ['  if (input.capacitorPlatform === "android") return false;\n', ""],
    kills: /^refresh Android under a Tauri shell value: true/,
  },
  {
    label: "the main window ignored",
    swap: ["  if (input.mainWindow !== true) return false;\n", ""],
    kills: /^refresh Tauri, not the main window: true/,
  },
  {
    label: "the main window read truthy",
    swap: ["input.mainWindow !== true", "!input.mainWindow"],
    kills: /^refresh Tauri, main window flag 1: true/,
  },
  {
    label: "every Capacitor platform refreshes",
    swap: [
      'input.shell === "capacitor" && input.capacitorPlatform === "ios"',
      'input.shell === "capacitor"',
    ],
    kills: /^refresh web: true/,
  },
  {
    label: "Electron left out",
    swap: [
      'input.shell === "tauri" || input.shell === "electron"',
      'input.shell === "tauri"',
    ],
    kills: /^refresh Electron main window: false/,
  },
  {
    label: "no throttle",
    swap: ["now < lastAt || now - lastAt >= BACKUP_REFRESH_FOCUS_MS", "true"],
    kills: /^focus right after a check: true/,
  },
  {
    label: "the hour boundary excluded",
    swap: [
      "now - lastAt >= BACKUP_REFRESH_FOCUS_MS",
      "now - lastAt > BACKUP_REFRESH_FOCUS_MS",
    ],
    kills: /^focus exactly an hour: false/,
  },
  {
    label: "a backwards clock blocks the check",
    swap: ["now < lastAt || ", ""],
    kills: /^focus the clock went backwards: false/,
  },
];

test("backup refresh mutation harness: the unmutated module, loaded the same way, passes every row", async () => {
  assert.deepEqual(refreshFailures(await moduleCopy([])), []);
});

for (const { label, swap, kills } of REFRESH_MUTANTS) {
  test(`backup refresh mutation: ${label} fails its row`, async () => {
    const found = refreshFailures(await moduleCopy([swap]));
    assert.ok(
      found.some((f) => kills.test(f)),
      `${label}: want ${kills}, got ${JSON.stringify(found, null, 2)}`,
    );
  });
}

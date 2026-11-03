// Behaviour pins for the pure platform rules in `e2eePlatform.ts` that the
// iOS call E2EE work added (plan D6/D8, C4, W3 MUST 1): the iOS readiness
// rule and the one shell predicate. The older phase-1 pins stay in
// `e2eeIosGate.test.ts`.
//
// `E2EE_PLATFORM_MODULE` points the spec at another copy of the module, so
// a mutated copy can be shown to fail it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

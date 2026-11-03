// Gate G10's iOS spec (plan ios-e2ee-messaging-port D7 + D10 G10), rewritten
// for iOS call E2EE phase 2, Wave 3 (plan ios-call-e2ee-phase2 D6 + D8, §10
// step 2, contract C-W3-8). Run with Node's built-in runner:
//   node --conditions=browser --test components/client/e2eeIosGate.test.ts
//
// Phase 1 kept calls on iPhone plaintext with one pin: G3 required
// `CapacitorTransport.keyPushAvailable()` to be android-only, and the
// behaviour rows and the chain test asserted that iOS reads false. Phase 2
// W3 is the audited unpin step (plan §10 step 2), so those "iOS must stay
// plaintext" pins are REMOVED here, on purpose, and replaced by the rule
// that decides iOS now. On iOS `platformMediaE2EESupported()` is still TRUE
// (no `slogaShell`), so `mediaE2EEPlatformSupported(keyPush)` is exactly the
// iOS key push, and that key push is `iosMediaE2EEReady(...)` over four
// terms, each failing closed: the build's caps flag
// (`window.__slogaIosCaps?.mediaE2EE`, literal `true` only; a phase-1 or
// Release build says nothing or false), the E2ee plugin, a WebKit with
// `RTCRtpScriptTransform` (iOS 15.0-15.3 has none) and the app-start D8
// worker probe having PASSED ("pending" and "fail" read no). The bridge
// feeds that one answer to the KeyPackage prepublish and, through
// `shellMediaE2EESupported`, to both `shellSupported` (rtc/state.tsx) and
// the prejoin copy (`useCallPrejoinMode.ts`), so an iOS device without all
// four terms neither builds an "encrypted" Room, nor stocks the KeyPackage
// directory, nor tells the user a call will be encrypted.
//
// `e2eePlatform.ts`, `e2eeProtectorCopy.ts`, `rtc/workerProbe.ts` and
// `rtc/e2eeDeviceReadiness.ts` load under Node and are tested by behaviour.
// The iOS rows compose them the way the callers do (pinned lexically by G3,
// G8, P1-P4 and C1), and each behaviour row is checked against in-suite
// mutants of `e2eePlatform.ts` ("flag ignored", "plugin dropped", "probe
// dropped", ...), so a green matrix is never one that cannot fail.
// `e2ee.ts`, `rtc/state.tsx`, `useCallPrejoinMode.ts`, `Controller.ts` and
// `Encryption.tsx` do not load (Solid, Capacitor, stoat.js, livekit), so
// their wiring is pinned by reading the sources. Point
// `E2EE_IOS_GATE_PLATFORM`, `E2EE_IOS_GATE_TS`, `E2EE_IOS_GATE_STATE`,
// `E2EE_IOS_GATE_PREJOIN`, `E2EE_IOS_GATE_SETTINGS`,
// `E2EE_IOS_GATE_CONTROLLER` (files) and
// `E2EE_IOS_GATE_COMPONENTS` (a components root) at other copies to check
// those instead (the known-bad control: the 7de02a68 files, whose
// e2eePlatform.ts lacks the iOS rule, whose e2ee.ts keeps the android-only
// key push (G3, G9) and whose prejoin copy is the second, unpinned predicate
// (P1, P3)).
//
// The state.tsx pins written against the CONTRACT shape (C-W3-8:
// `shellSupported` calls `shellMediaE2EESupported` with the prejoin copy's
// shell inputs, then folds in the toggle; R21: the server's iOS switch goes
// to readiness as its own `pausedByServer` input) sit in their own
// `describe("L3t: ...")` block at the end. They were written red before L3t
// rewired state.tsx and went green with it.
//
// Stage 5 fix round F (D14, R9 was wrong): the switch is fetched from
// `GET /` (`client.configuration` is a stub) and passed RAW (absent reads
// ON). The prejoin copy and Settings apply it through the one helper
// `callMediaE2EEOffered(shell, sw)`; state.tsx never does (R21: folded into
// `shellSupported`, a paused iPhone would read "unsupported", the forbidden
// copy). Pinned by P3 + P5-P7, S0-S4 and C4-C5, and by a behaviour row.
//
// The TS lexer is the one in e2eeDecryptSelf.scan.test.ts (that file exports
// nothing), plus one change for .tsx: a quote right after a letter or digit
// is JSX text (`aren't`), not a string opener. Comments are stripped before
// every check; a file whose braces do not balance after masking fails its
// "0" rule (G0, C0, D0, E0) rather than being scoped wrongly.
//
// e2ee.ts:
//   G0. The file lexes to balanced braces.
//   G1. Exactly one `class CapacitorTransport`, and no other
//       `class Capacitor*Transport` (C4: one class, per-platform values).
//   G2. Its only top-level `nativeBlobTransfer` is
//       `readonly nativeBlobTransfer = true;`.
//   G3. Its one `keyPushAvailable()` body is exactly
//       `const platform = Capacitor.getPlatform(); return (Capacitor.isNativePlatform() &&
//       (platform === "android" || (platform === "ios" && iosMediaE2EEReady({
//       capsMediaE2EE: (window as SlogaIosCapsWindow).__slogaIosCaps?.mediaE2EE,
//       pluginPresent: Capacitor.isPluginAvailable("E2ee"),
//       scriptTransform: typeof RTCRtpScriptTransform !== "undefined",
//       probe: workerProbeResult() }))));`
//       (plan D6 + D8): each of the four `iosMediaE2EEReady` terms is also
//       checked by name, so "flag ignored", "plugin dropped", "transform
//       dropped" and "probe dropped" each say which; `iosMediaE2EEReady(` is
//       called once in the file; `workerProbeResult` is imported unaliased
//       from `../rtc/workerProbe` and not defined here.
//   G4. Its only top-level `clipboardImageInWebview` is
//       `readonly clipboardImageInWebview = capacitorClipboardImageInWebview(Capacitor.getPlatform());`.
//   G5. Its one `attachmentUrl(messageId, idx)` body is exactly
//       `return capacitorAttachmentUrl(Capacitor.getPlatform(), messageId, idx);`
//       and no string in the class names `e2ee-att`.
//   G6. `function nativeE2EEAvailable` (one) ends with
//       `return capacitorNativeE2EE(Capacitor.isNativePlatform(), Capacitor.getPlatform(), (x) => Capacitor.isPluginAvailable(x));`,
//       calls `capacitorNativeE2EE(` once and compares no
//       `Capacitor.getPlatform()` itself.
//   G7. `#prepublishMlsKeyPackages` (one) starts with
//       `if (!this.mediaE2EEPlatformSupported()) return;` and still holds
//       `if (!this.#callsEnabled()) return;`.
//   G8. `class E2EEBridge` (one) has one `mediaE2EEPlatformSupported()`
//       returning `mediaE2EEPlatformSupported(this.nativeKeyPushAvailable())`
//       and one `nativeKeyPushAvailable()` returning
//       `this.#transport.keyPushAvailable()`.
//   G9. One source: the six Capacitor/media helpers (incl.
//       `iosMediaE2EEReady`) are imported unaliased from `./e2eePlatform`,
//       and e2ee.ts defines none of the eight e2eePlatform functions itself.
//   F1. Every `new E2EESendError(` whose message is "Encryption status could
//       not be verified. ..." and that sits in a `catch` (same function) binds
//       the error and reads
//       `protectorSendErrorCopy(<the binding>, Capacitor.getPlatform()) ?? "<the old text>"`,
//       the old text being one of the two existing messages, kind "native".
//   F2. There are exactly PROTECTOR_SITES such catch sites (L4a wired 6).
//   R1-R7: the iOS orphaned recovery bundle (audit M2). A recovery sheet
//   that outlives its page keeps the minted bundle for the next
//   `e2ee_backup_refresh_if_due`, and only the webview sends that command.
//   R1. CapacitorTransport's one `subscribeBackupBundleWaiting` member is
//       `readonly subscribeBackupBundleWaiting =
//       capacitorCouriersOrphanedRecovery(Capacitor.getPlatform()) ? <fn> :
//       undefined;` (absent off iOS, so Android never subscribes; never a
//       method, which every platform would have).
//   R2. CapacitorTransport calls `addListener("backupBundleWaiting", ...)`
//       once, inside that member, as exactly
//       `addListener("backupBundleWaiting", () => callback())` (the payload
//       is dropped), and names the event nowhere else.
//   R3. E2EEBridge calls `subscribeBackupBundleWaiting(` once, as
//       `this.#backupBundleWaiting = this.#transport.subscribeBackupBundleWaiting(`
//       inside `#watchOrphanedBackup` (one), whose body starts with
//       `if (this.#backupBundleWaiting) return;`; its one argument is a
//       no-parameter arrow that only does `void this.#courierOrphanedBackup()`;
//       and `this.#watchOrphanedBackup();` is called once, as a statement of
//       the constructor (once per bridge).
//   R4. `#onClaimResult` (one) ends with
//       `if (this.#transport.subscribeBackupBundleWaiting) { await this.#courierOrphanedBackup(); }`
//       (braces optional): the last statement, so after the
//       `#replenish()` housekeeping and outside its try.
//   R5. `this.#courierOrphanedBackup(` is called exactly twice (R3, R4).
//   R6. `#courierOrphanedBackup` (one) is exactly
//       `const s = this.status.get("state"); if (<terms>) return;
//       try { await this.refreshBackupIfDue(); } catch (e) { ... }`, the
//       `||` terms including `!this.#client.user?.id`, `!s?.enabled`,
//       `!s?.published` (the core opens, so provisions, the store on any
//       engine call) and `this.#claimAccepted !== true` (this connection's
//       accepted claim: the backup PUT needs a device-bound session and the
//       native take always clears, so a take before the claim could lose
//       the bundle); the catch does not throw and uses its binding only as
//       `errorName(e)`.
//   R7. `.refreshBackupIfDue(` is called once, inside the courier, and
//       "e2ee_backup_refresh_if_due" appears once, inside
//       `refreshBackupIfDue()`.
// useCallPrejoinMode.ts (the prejoin copy; plan D6, C-W3-8):
//   P0. The file lexes to balanced braces.
//   P1. `shellMediaE2EESupported` is imported unaliased from e2eePlatform
//       and not defined here, `isE2EESupported` comes from livekit-client,
//       and the file calls no `platformMediaE2EESupported(`,
//       `nativeKeyPushAvailable(` or `iosMediaE2EEReady(` of its own.
//       The three switch helpers (`callMediaE2EEOffered`,
//       `fetchIosCallSwitchValue`, `iosCallSwitch`) are imported unaliased
//       from `@revolt/rtc/iosCallSwitch` and not defined here.
//   P2. `const wouldEncrypt =` (one) is a pure `&&` chain.
//   P3. Its first term is exactly `callMediaE2EEOffered(SHELL_CALL, sw)`,
//       SHELL_CALL being `shellMediaE2EESupported({ e2eeSupported:
//       isE2EESupported(), nativeE2EEAvailable: nativeE2EEAvailable(),
//       bridgePlatformSupported: !!bridge?.mediaE2EEPlatformSupported() })`
//       (the shell argument is named separately: "prejoin copy diverges").
//   P4. Then exactly the device and toggle terms, as before W3:
//       `!!bridge?.status.get("state")?.published`, `input.e2eeCallsEnabled`.
//   P5. `const sw =` (one) is exactly `iosCallSwitch({ platform:
//       Capacitor.getPlatform(), serverValue: Capacitor.getPlatform() ===
//       "ios" ? await fetchIosCallSwitchValue({ fetchRoot: () =>
//       client().api.get("/"), setTimeout, clearTimeout }) : undefined })`.
//   P6. The switch is applied ONLY through `callMediaE2EEOffered`: every
//       `iosCallSwitch(` verdict (and its binding) is that helper's second
//       argument and is read nowhere else.
//   P7. RAW: no `serverValue` key or `...SwitchValue`/`...SwitchFetch`
//       assignment holds `!!`, `Boolean(`, `??`, `||`, `&&`, a comparison
//       with true/false or `configuration`; every `iosCallSwitch(` takes
//       `{ platform: Capacitor.getPlatform(), serverValue }`; every
//       `fetchIosCallSwitchValue(` reads `() => client().api.get("/")`.
// settings/user/Encryption.tsx (the Settings call row; fix round F6):
//   S0. The file lexes to balanced braces.
//   S1. The three switch helpers, as P1.
//   S2. The switch is applied only through `callMediaE2EEOffered`, as P6.
//   S3. RAW, as P7.
//   S4. The one `iosCallSwitch(` reads `<signal>()?.serverValue`, whose one
//       setter call is `fetchIosCallSwitchValue(...).then((serverValue) =>
//       set<Signal>({ serverValue }))`: the fetched value, untouched.
// rtc/state.tsx:
//   C0. The file lexes to balanced braces.
//   C1. (L3t) `const shellSupported =` (one) is a pure `&&` chain of exactly
//       SHELL_CALL (the prejoin copy's first term, character for character)
//       and `this.#settings.e2eeCallsEnabled`.
//   C2. state.tsx defines no `platformMediaE2EESupported` and re-exports it
//       from `../client/e2eePlatform` (one source).
//   C3. (L3t) `shellMediaE2EESupported` is imported unaliased from
//       e2eePlatform and not defined in state.tsx.
//   C4. (R21) state.tsx names no `callMediaE2EEOffered`; its one
//       `callEncryptionReadiness({...})` takes `shellSupported` itself and
//       `pausedByServer: iosCallSwitch({ platform: Capacitor.getPlatform(),
//       serverValue: <raw value> }) === "off"`.
//   C5. RAW, as P7.
// Controller.ts:
//   D0. The file lexes to balanced braces.
//   D1. `Capacitor` is imported from `@capacitor/core`.
//   D2. "Sloga for iOS" appears once, as `friendly_name = "Sloga for iOS";`.
//   D3. That assignment sits directly in the then-block of
//       `if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios")`.
//   D4. That block is followed by `else if (browser)`: iOS is decided before
//       the web/UA branch.
// components/** (W2 carry-in: the core OPENS, so provisions, the store on
// `e2ee_backup_status`, so the webview may ask only once E2EE is on):
//   E0. Every file with a hit lexes to balanced braces.
//   E1. `e2ee_backup_status` appears once, inside `backupStatus()`'s body.
//   E2. `backupStatus(` appears un-dotted once, as the method in
//       client/e2ee.ts (a bare call through a destructured alias, or a
//       second definition, is a second hit and fails).
//   E3. At least one `.backupStatus(` call exists, none by bracket access,
//       and each call's enclosing function starts with
//       `if (... || !enabled() ...) return`, where the nearest `enabled` in
//       scope is
//       `const enabled = () => { const s = <x>.status.get("state"); return !!s?.enabled && !!s?.published; };`.
//
// The scanners are checked against inline fixtures first (a conforming file
// passes; each mutation fails exactly its own rule), so a green scan is never
// a scanner that cannot fail.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { callEncryptionReadiness } from "../rtc/e2eeDeviceReadiness.ts";
import {
  callMediaE2EEOffered,
  fetchIosCallSwitchValue,
  iosCallSwitch,
} from "../rtc/iosCallSwitch.ts";
import {
  resetWorkerProbeForTest,
  runWorkerProbe,
  workerProbeResult,
} from "../rtc/workerProbe.ts";
import { protectorSendErrorCopy } from "./e2eeProtectorCopy.ts";

type Platform = typeof import("./e2eePlatform.ts");

/** The e2eePlatform.ts under test (loaded, so a control copy can be swapped in). */
const PLATFORM_FILE = process.env.E2EE_IOS_GATE_PLATFORM
  ? pathToFileURL(process.env.E2EE_IOS_GATE_PLATFORM)
  : new URL("./e2eePlatform.ts", import.meta.url);
const e2eePlatform = (await import(PLATFORM_FILE.href)) as Platform;
const {
  capacitorAttachmentUrl,
  capacitorClipboardImageInWebview,
  capacitorCouriersOrphanedRecovery,
  capacitorNativeE2EE,
  mediaE2EEPlatformSupported,
  platformMediaE2EESupported,
} = e2eePlatform;

const TS_FILE =
  process.env.E2EE_IOS_GATE_TS || new URL("./e2ee.ts", import.meta.url);
const STATE_FILE =
  process.env.E2EE_IOS_GATE_STATE ||
  new URL("../rtc/state.tsx", import.meta.url);
const PREJOIN_FILE =
  process.env.E2EE_IOS_GATE_PREJOIN ||
  new URL(
    "../ui/components/features/voice/useCallPrejoinMode.ts",
    import.meta.url,
  );
const SETTINGS_FILE =
  process.env.E2EE_IOS_GATE_SETTINGS ||
  new URL("../app/interface/settings/user/Encryption.tsx", import.meta.url);
const CONTROLLER_FILE =
  process.env.E2EE_IOS_GATE_CONTROLLER ||
  new URL("./Controller.ts", import.meta.url);
const COMPONENTS_DIR =
  process.env.E2EE_IOS_GATE_COMPONENTS ||
  fileURLToPath(new URL("../", import.meta.url));

/** The catch sites L4a wired to the protector copy (F2). */
const PROTECTOR_SITES = 6;

// ---- A. Behavior: e2eePlatform.ts -------------------------------------------

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

const ID = "01JB0000000000000000000000";

test("capacitorNativeE2EE: iOS needs the plugin named exactly E2ee", () => {
  const asked: string[] = [];
  const probe = (answer: (name: string) => boolean) => (name: string) => {
    asked.push(name);
    return answer(name);
  };
  assert.equal(
    capacitorNativeE2EE(
      true,
      "ios",
      probe(() => false),
    ),
    false,
  );
  assert.equal(
    capacitorNativeE2EE(
      true,
      "ios",
      probe((name) => name === "E2ee"),
    ),
    true,
  );
  assert.equal(
    capacitorNativeE2EE(
      true,
      "ios",
      probe((name) => name === "e2ee" || name === "E2EE"),
    ),
    false,
  );
  assert.deepEqual(asked, ["E2ee", "E2ee", "E2ee"]);
});

test("capacitorNativeE2EE: Android is native regardless of the plugin probe", () => {
  assert.equal(
    capacitorNativeE2EE(true, "android", () => false),
    true,
  );
  assert.equal(
    capacitorNativeE2EE(true, "android", () => true),
    true,
  );
});

test("capacitorNativeE2EE: web, empty and unknown platforms have none", () => {
  for (const platform of ["web", "", "electron", "IOS", "Android"]) {
    assert.equal(
      capacitorNativeE2EE(true, platform, () => true),
      false,
      platform,
    );
  }
});

test("capacitorNativeE2EE: not native means no native E2EE on every platform", () => {
  for (const platform of ["ios", "android", "web", ""]) {
    assert.equal(
      capacitorNativeE2EE(false, platform, () => true),
      false,
      platform,
    );
  }
});

test("capacitorAttachmentUrl: iOS uses the e2ee-att scheme (C3), Android the same-origin path", () => {
  assert.equal(capacitorAttachmentUrl("ios", ID, 3), `e2ee-att://att/${ID}/3`);
  assert.equal(capacitorAttachmentUrl("android", ID, 0), `/_e2ee-att/${ID}/0`);
});

test("capacitorClipboardImageInWebview: only Android copies in the webview", () => {
  assert.equal(capacitorClipboardImageInWebview("ios"), false);
  assert.equal(capacitorClipboardImageInWebview("android"), true);
  for (const platform of ["web", "", "electron", "IOS", "Android"]) {
    assert.equal(capacitorClipboardImageInWebview(platform), false, platform);
  }
});

test("capacitorCouriersOrphanedRecovery: only iOS couriers a kept recovery bundle (audit M2)", () => {
  assert.equal(capacitorCouriersOrphanedRecovery("ios"), true);
  for (const platform of ["android", "web", "", "IOS", "electron"]) {
    assert.equal(capacitorCouriersOrphanedRecovery(platform), false, platform);
  }
});

test("media gate (D6): on iOS the platform term is TRUE, so the iOS key push alone decides", () => {
  // A Capacitor iOS webview: no `slogaShell`, no `__TAURI__`.
  withWindow({}, () => {
    assert.equal(platformMediaE2EESupported(), true);
    // So `mediaE2EEPlatformSupported` is exactly the key push, which on iOS
    // is `iosMediaE2EEReady(...)` (G3): the four terms below decide.
    assert.equal(mediaE2EEPlatformSupported(false), false);
    assert.equal(mediaE2EEPlatformSupported(true), true);
  });
});

test("media predicate per platform: Tauri, Android, a ready iOS and audited Electron arm; unaudited Electron never does", () => {
  const rows: [string, object, boolean, boolean][] = [
    // [label, window, keyPushAvailable, expected]
    ["Windows Tauri", { __TAURI__: { core: {} } }, true, true],
    ["Android", {}, true, true],
    ["iOS, iosMediaE2EEReady false", {}, false, false],
    ["iOS, iosMediaE2EEReady true", {}, true, true],
    ["web (no bridge)", {}, false, false],
    [
      "Linux Electron, audited",
      { slogaShell: { e2ee: { mediaE2EE: true } } },
      true,
      true,
    ],
    [
      "audited Electron, no key push",
      { slogaShell: { e2ee: { mediaE2EE: true } } },
      false,
      false,
    ],
    ["Electron, unaudited", { slogaShell: { e2ee: {} } }, true, false],
    ["Electron, older shell", { slogaShell: {} }, true, false],
    [
      "Electron, truthy non-true flag",
      { slogaShell: { e2ee: { mediaE2EE: "true" } } },
      true,
      false,
    ],
  ];
  for (const [label, win, keyPush, expected] of rows) {
    withWindow(win, () => {
      assert.equal(mediaE2EEPlatformSupported(keyPush), expected, label);
    });
  }
  withWindow({ slogaShell: { e2ee: {} } }, () => {
    assert.equal(platformMediaE2EESupported(), false, "unaudited Electron");
  });
  withWindow({ slogaShell: { e2ee: { mediaE2EE: true } } }, () => {
    assert.equal(platformMediaE2EESupported(), true, "audited Electron");
  });
});

// ---- B. Behaviour: the iOS call-E2EE chain (plan D6 + D8, C-W3-8) ----------

/** One iOS build and device, as the callers read it. */
interface IosDevice {
  /** `window.__slogaIosCaps?.mediaE2EE` (C4); undefined on a phase-1 build. */
  caps: unknown;
  /** `Capacitor.isPluginAvailable("E2ee")`. */
  plugin: boolean;
  /** `typeof RTCRtpScriptTransform !== "undefined"`. */
  scriptTransform: boolean;
  /** `workerProbeResult()`, the cached D8 probe. */
  probe: "pending" | "pass" | "fail";
  /**
   * Whether livekit's `isE2EESupported()` would still say yes without a
   * script transform (insertable streams). Real WebKit has none; a row sets
   * it so the iOS rule alone has to refuse a transform-less engine.
   */
  insertableStreams?: boolean;
}

interface IosAnswer {
  keyPush: boolean;
  prepublish: boolean;
  shellSupported: boolean;
  readiness: string;
}

/**
 * What an iOS device answers, composed exactly as the callers compose it:
 * `CapacitorTransport.keyPushAvailable()` on native iOS (G3),
 * `E2EEBridge.mediaE2EEPlatformSupported()` (G8; it is also the KeyPackage
 * prepublish gate, G7), `nativeE2EEAvailable()` (G6), the one shell
 * predicate (P3, C1) with "Encrypt my calls" on, and the readiness the call
 * chrome reads (C-W3-9; switch on, device not owned elsewhere).
 */
function iosAnswer(p: Platform, d: IosDevice): IosAnswer {
  return withWindow({}, () => {
    const keyPush = p.iosMediaE2EEReady({
      capsMediaE2EE: d.caps,
      pluginPresent: d.plugin,
      scriptTransform: d.scriptTransform,
      probe: d.probe,
    });
    const prepublish = p.mediaE2EEPlatformSupported(keyPush);
    const shellSupported = p.shellMediaE2EESupported({
      e2eeSupported: d.scriptTransform || d.insertableStreams === true,
      nativeE2EEAvailable: p.capacitorNativeE2EE(
        true,
        "ios",
        (name) => d.plugin && name === "E2ee",
      ),
      bridgePlatformSupported: prepublish,
    });
    const readiness = callEncryptionReadiness({
      shellSupported,
      status: undefined,
      deviceOwnedElsewhere: false,
      pausedByServer: false,
    });
    return { keyPush, prepublish, shellSupported, readiness };
  });
}

const READY_DEVICE: IosDevice = {
  caps: true,
  plugin: true,
  scriptTransform: true,
  probe: "pass",
};

type IosGroup = "ready" | "caps" | "plugin" | "transform" | "probe";

const IOS_ROWS: { group: IosGroup; label: string; device: IosDevice }[] = [
  { group: "ready", label: "a ready build and device", device: READY_DEVICE },
  {
    group: "caps",
    label: "a phase-1 build (no caps object)",
    device: { ...READY_DEVICE, caps: undefined },
  },
  {
    group: "caps",
    label: "a Release build (caps flag false)",
    device: { ...READY_DEVICE, caps: false },
  },
  {
    group: "caps",
    label: 'caps flag "true" (a string)',
    device: { ...READY_DEVICE, caps: "true" },
  },
  { group: "caps", label: "caps flag 1", device: { ...READY_DEVICE, caps: 1 } },
  {
    group: "caps",
    label: "caps flag an object",
    device: { ...READY_DEVICE, caps: { mediaE2EE: true } },
  },
  {
    group: "plugin",
    label: "no E2ee plugin",
    device: { ...READY_DEVICE, plugin: false },
  },
  {
    group: "transform",
    label: "no RTCRtpScriptTransform, insertable streams claimed",
    device: {
      ...READY_DEVICE,
      scriptTransform: false,
      insertableStreams: true,
    },
  },
  {
    group: "transform",
    label: "no RTCRtpScriptTransform (iOS 15.0-15.3)",
    device: { ...READY_DEVICE, scriptTransform: false },
  },
  {
    group: "probe",
    label: "probe pending",
    device: { ...READY_DEVICE, probe: "pending" },
  },
  {
    group: "probe",
    label: "probe failed",
    device: { ...READY_DEVICE, probe: "fail" },
  },
];

/**
 * Every way the rows in `groups` (all rows when omitted) differ from the
 * rule: only the ready row may arm anything, and every other row reads no
 * key push, no prepublish, no shell support and `unsupported`.
 */
function iosMatrixFailures(p: Platform, groups?: IosGroup[]): string[] {
  const out: string[] = [];
  for (const { group, label, device } of IOS_ROWS) {
    if (groups && !groups.includes(group)) continue;
    const ready = group === "ready";
    const want: IosAnswer = {
      keyPush: ready,
      prepublish: ready,
      shellSupported: ready,
      readiness: ready ? "ready" : "unsupported",
    };
    let got: IosAnswer;
    try {
      got = iosAnswer(p, device);
    } catch (error) {
      out.push(`${label}: threw ${String(error)}`);
      continue;
    }
    for (const key of Object.keys(want) as (keyof IosAnswer)[]) {
      if (got[key] !== want[key]) {
        out.push(
          `${label}: ${key} is ${String(got[key])}, want ${String(want[key])}`,
        );
      }
    }
  }
  return out;
}

test("iOS: caps flag + plugin + script transform + probe pass = key push, prepublish, shell support and readiness ready", () => {
  assert.deepEqual(iosMatrixFailures(e2eePlatform, ["ready"]), []);
});

test("iOS: without the caps flag (a phase-1 or Release build), or with any non-true flag, nothing arms and the call is unsupported", () => {
  assert.deepEqual(iosMatrixFailures(e2eePlatform, ["caps"]), []);
});

test("iOS: without the E2ee plugin nothing arms and the call is unsupported", () => {
  assert.deepEqual(iosMatrixFailures(e2eePlatform, ["plugin"]), []);
});

test("iOS: without RTCRtpScriptTransform nothing arms and the call is unsupported, even where insertable streams are claimed", () => {
  assert.deepEqual(iosMatrixFailures(e2eePlatform, ["transform"]), []);
});

test("iOS: a pending or failed D8 probe arms nothing and the call is unsupported", () => {
  assert.deepEqual(iosMatrixFailures(e2eePlatform, ["probe"]), []);
});

/** A probe worker that answers `init` with livekit's ack and one heartbeat. */
function answeringWorker(rte: string) {
  const listeners: ((ev: { data?: unknown }) => void)[] = [];
  return {
    postMessage(m: unknown) {
      if ((m as { kind?: unknown } | null)?.kind !== "init") return;
      for (const f of [...listeners]) {
        f({ data: { kind: "initAck", data: {} } });
        f({ data: { kind: "slogaDecodeWitness", data: { rte } } });
      }
    },
    addEventListener(
      type: "message" | "error",
      f: (ev: { data?: unknown }) => void,
    ) {
      if (type === "message") listeners.push(f);
    },
    terminate() {},
  };
}

test("iOS (D8): the real probe cache feeds the predicate: unsupported until a probe passes, ready only after it does, unsupported after a fail", async () => {
  const readiness = () =>
    iosAnswer(e2eePlatform, { ...READY_DEVICE, probe: workerProbeResult() })
      .readiness;
  const deps = (rte: string) => ({
    makeWorker: () => answeringWorker(rte),
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  resetWorkerProbeForTest();
  try {
    assert.equal(workerProbeResult(), "pending");
    assert.equal(readiness(), "unsupported", "before any probe settled");
    assert.equal(await runWorkerProbe(deps("function")), "pass");
    assert.equal(readiness(), "ready", "after a passed probe");
    resetWorkerProbeForTest();
    assert.equal(await runWorkerProbe(deps("undefined")), "fail");
    assert.equal(readiness(), "unsupported", "after a failed probe");
  } finally {
    resetWorkerProbeForTest();
  }
});

/**
 * The module under test, with `swaps` applied (exact, unique snippets),
 * type-stripped and imported from a data: URL: no file is written.
 */
async function platformCopy(swaps: [string, string][]): Promise<Platform> {
  const src = swapped(readFileSync(PLATFORM_FILE, "utf8"), swaps);
  const js = stripTypeScriptTypes(src);
  return (await import(
    `data:text/javascript,${encodeURIComponent(js)}`
  )) as Platform;
}

/** Behaviour mutants of e2eePlatform.ts, and the iOS row each must fail. */
const PLATFORM_MUTANTS: {
  label: string;
  swap: [string, string];
  kills: RegExp;
}[] = [
  {
    label: "flag ignored",
    swap: ["input.capsMediaE2EE === true", "true"],
    kills: /^a phase-1 build \(no caps object\): keyPush is true/,
  },
  {
    label: "flag read as truthy",
    swap: ["input.capsMediaE2EE === true", "!!input.capsMediaE2EE"],
    kills: /^caps flag "true" \(a string\): keyPush is true/,
  },
  {
    label: "plugin dropped",
    swap: ["input.pluginPresent === true", "true"],
    kills: /^no E2ee plugin: keyPush is true/,
  },
  {
    label: "script transform dropped",
    swap: ["input.scriptTransform === true", "true"],
    kills:
      /^no RTCRtpScriptTransform, insertable streams claimed: shellSupported is true/,
  },
  {
    label: "probe dropped",
    swap: ['input.probe === "pass"', "true"],
    kills: /^probe failed: keyPush is true/,
  },
  {
    label: "a pending probe read as a pass",
    swap: ['input.probe === "pass"', 'input.probe !== "fail"'],
    kills: /^probe pending: keyPush is true/,
  },
  {
    label: "key push dropped from the media predicate",
    swap: [
      "return keyPushAvailable && platformMediaE2EESupported();",
      "return platformMediaE2EESupported();",
    ],
    kills: /^a phase-1 build \(no caps object\): prepublish is true/,
  },
  {
    label: "the bridge term dropped from the shell predicate",
    swap: ["input.bridgePlatformSupported === true", "true"],
    kills: /^probe pending: shellSupported is true/,
  },
];

test("behaviour mutation harness: the unmutated module, loaded the same way, passes every iOS row", async () => {
  assert.deepEqual(iosMatrixFailures(await platformCopy([])), []);
});

for (const { label, swap, kills } of PLATFORM_MUTANTS) {
  test(`behaviour mutation (e2eePlatform.ts): ${label} fails its iOS row`, async () => {
    const found = iosMatrixFailures(await platformCopy([swap]));
    assert.ok(
      found.some((f) => kills.test(f)),
      `${label}: want ${kills}, got ${JSON.stringify(found, null, 2)}`,
    );
  });
}

// ---- Shared helpers ---------------------------------------------------------

interface Masked {
  /** Comments and string contents blanked. */
  code: string;
  /** Comments blanked; string contents kept. */
  text: string;
}

const squash = (s: string) => s.replace(/\s+/g, "");
/** Squashed, with a trailing comma before a closing bracket dropped. */
const norm = (s: string) => squash(s).replace(/,(?=[)\]}])/g, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function lineOf(src: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

/** Index of the bracket closing the one at `open` (masked code), or throw. */
function matchClose(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const close = pairs[code[open]];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === code[open]) depth++;
    else if (code[i] === close && --depth === 0) return i;
  }
  throw new Error(`unbalanced ${code[open]} at ${open}`);
}

/** Index of the bracket opening the one at `close` (masked code), or throw. */
function matchOpen(code: string, close: number): number {
  const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  const open = pairs[code[close]];
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === code[close]) depth++;
    else if (code[i] === open && --depth === 0) return i;
  }
  throw new Error(`unbalanced ${code[close]} at ${close}`);
}

/**
 * The top-level comma-separated items between the bracket at `open` and its
 * match: brackets are matched on `m.code`, items are sliced from `m.text`
 * (string contents kept) and normalized.
 */
function items(m: Masked, open: number): string[] {
  const close = matchClose(m.code, open);
  const out: string[] = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = m.code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(m.code, i);
    else if (c === ",") {
      out.push(m.text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(m.text.slice(start, close));
  return out.map(norm).filter((a) => a !== "");
}

/** The top-level `op`-separated parts of `[from, to)`, normalized. */
function splitTop(m: Masked, from: number, to: number, op: string): string[] {
  const out: string[] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    const c = m.code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(m.code, i);
    else if (m.code.startsWith(op, i)) {
      out.push(m.text.slice(start, i));
      start = i + op.length;
      i += op.length - 1;
    }
  }
  out.push(m.text.slice(start, to));
  return out.map(norm).filter((a) => a !== "");
}

function skipWs(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i])) i++;
  return i;
}

/** Index of the last non-space character at or before `i`. */
function skipBack(code: string, i: number): number {
  while (i >= 0 && /\s/.test(code[i])) i--;
  return i;
}

/** Index of the `;` ending the statement that runs from `from`, or -1. */
function stmtEnd(code: string, from: number): number {
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(code, i);
    else if (c === ";") return i;
    else if (c === ")" || c === "]" || c === "}") return -1;
  }
  return -1;
}

/** The identifier ending just before index `i` (masked code), or "". */
function wordBefore(code: string, i: number): string {
  let j = skipBack(code, i - 1);
  const end = j + 1;
  while (j >= 0 && /[\w$#]/.test(code[j])) j--;
  return code.slice(j + 1, end);
}

/** `{` positions enclosing index `at` (masked code), innermost last. */
function enclosingBlocks(code: string, at: number): number[] {
  const stack: number[] = [];
  for (let i = 0; i < at; i++) {
    if (code[i] === "{") stack.push(i);
    else if (code[i] === "}") stack.pop();
  }
  return stack;
}

const CONTROL_WORDS = new Set(["if", "for", "while", "switch", "catch"]);

/**
 * Whether the `{` at `open` starts a function body: `=> {`, or
 * `name(...) {` / `name(...): T {` with `name` not a control keyword.
 */
function isFunctionBody(code: string, open: number): boolean {
  const before = code.slice(Math.max(0, open - 400), open);
  if (/=>\s*$/.test(before)) return true;
  const sig = /\)\s*(?::[^(){};=]*)?$/.exec(before);
  if (!sig) return false;
  const paren = matchOpen(code, open - before.length + sig.index);
  const word = wordBefore(code, paren);
  return word !== "" && !CONTROL_WORDS.has(word);
}

/**
 * When the `{` at `open` is a catch body: its binding ("" when it binds
 * nothing). Otherwise null.
 */
function catchBinding(code: string, open: number): string | null {
  const j = skipBack(code, open - 1);
  if (wordBefore(code, j + 1) === "catch") return "";
  if (code[j] !== ")") return null;
  const paren = matchOpen(code, j);
  if (wordBefore(code, paren) !== "catch") return null;
  const binding = /^\(\s*([\w$]+)/.exec(code.slice(paren, j + 1));
  return binding ? binding[1] : "";
}

/** `[open, close]` of each `class NAME` body. */
function classBodies(code: string, name: string): [number, number][] {
  const out: [number, number][] = [];
  for (const hit of code.matchAll(
    new RegExp(`\\bclass\\s+${escapeRe(name)}(?![\\w$])`, "g"),
  )) {
    const open = code.indexOf("{", hit.index!);
    if (open >= 0) out.push([open, matchClose(code, open)]);
  }
  return out;
}

/**
 * Where `name` appears at the top level of the class body `[open, close]`
 * (bracket depth 0, not after a `.`): its member declarations.
 */
function topLevelHits(
  code: string,
  open: number,
  close: number,
  name: string,
): number[] {
  const re = new RegExp(`(?<![.\\w$#])${escapeRe(name)}(?![\\w$])`, "g");
  const out: number[] = [];
  let depth = 0;
  let at = open + 1;
  for (const hit of code.slice(open + 1, close).matchAll(re)) {
    const index = open + 1 + hit.index!;
    for (; at < index; at++) {
      if ("({[".includes(code[at])) depth++;
      else if (")}]".includes(code[at])) depth--;
    }
    if (depth === 0) out.push(index);
  }
  return out;
}

/** The body `[open, close]` of the method named at `at`, or null. */
function methodBodyAt(
  code: string,
  at: number,
  name: string,
): [number, number] | null {
  const paren = skipWs(code, at + name.length);
  if (code[paren] !== "(") return null;
  const params = matchClose(code, paren);
  const open = code.indexOf("{", params);
  if (open < 0) return null;
  if (!/^\s*(?::[^(){};=]*)?$/.test(code.slice(params + 1, open))) return null;
  return [open, matchClose(code, open)];
}

/** `[open, close]` of the body of each definition of private method `#name`. */
function privateMethodBodies(code: string, name: string): [number, number][] {
  const def = new RegExp(
    `(?<!\\.\\s*)#${escapeRe(name)}\\s*(?:<[^()]*>)?\\s*\\(`,
    "g",
  );
  const out: [number, number][] = [];
  for (const hit of code.matchAll(def)) {
    const params = matchClose(code, hit.index! + hit[0].length - 1);
    const open = code.indexOf("{", params);
    if (open >= 0) out.push([open, matchClose(code, open)]);
  }
  return out;
}

/** The class statement holding the top-level member at `at`, normalized. */
function memberStatement(m: Masked, at: number): string {
  let start = at;
  while (start > 0 && !/[;{}]/.test(m.code[start - 1])) start--;
  const end = stmtEnd(m.code, at);
  return end < 0 ? "" : norm(m.text.slice(start, end + 1));
}

/** Whether the braces of the masked code balance. */
function balanced(code: string): boolean {
  let depth = 0;
  for (const c of code) {
    if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

// ---- TypeScript lexer (as in e2eeDecryptSelf.scan.test.ts) -----------------

const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "void",
  "delete",
  "throw",
  "new",
  "yield",
  "await",
  "instanceof",
]);

/**
 * Blanks comments and literal contents with spaces (newlines kept), so every
 * index in the result is the same index in `src`. A quote right after a
 * letter or digit is JSX text (`aren't`), not a string opener.
 */
function maskTs(src: string): Masked {
  const code = src.split("");
  const text = src.split("");
  const n = src.length;
  const blank = (arr: string[], i: number) => {
    if (arr[i] !== "\n") arr[i] = " ";
  };

  const prevSignificant = (i: number): number => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    return j;
  };

  const regexAllowed = (i: number): boolean => {
    const j = prevSignificant(i);
    if (j < 0) return true;
    const c = code[j];
    if (/[\w$]/.test(c)) {
      let k = j;
      while (k >= 0 && /[\w$]/.test(code[k])) k--;
      return REGEX_KEYWORDS.has(code.slice(k + 1, j + 1).join(""));
    }
    return !/[)\]"'`]/.test(c);
  };

  /** Scans code from `i`; returns the index of an unmatched `}` or `n`. */
  const scanCode = (start: number, untilBrace: boolean): number => {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const next = src[i + 1];
      if (c === "/" && next === "/") {
        while (i < n && src[i] !== "\n") {
          blank(code, i);
          blank(text, i);
          i++;
        }
        continue;
      }
      if (c === "/" && next === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end < 0 ? n : end + 2;
        for (; i < stop; i++) {
          blank(code, i);
          blank(text, i);
        }
        continue;
      }
      if ((c === '"' || c === "'") && !/[A-Za-z0-9]/.test(src[i - 1] ?? "")) {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== "\n") {
          if (src[j] === "\\") blank(code, j++);
          blank(code, j++);
        }
        i = j + 1;
        continue;
      }
      if (c === "`") {
        let j = i + 1;
        while (j < n && src[j] !== "`") {
          if (src[j] === "\\") {
            blank(code, j++);
            blank(code, j++);
          } else if (src[j] === "$" && src[j + 1] === "{") {
            j = scanCode(j + 2, true) + 1;
          } else {
            blank(code, j++);
          }
        }
        i = j + 1;
        continue;
      }
      // `</Tag>` and `/>` close JSX; they never open a regex.
      const jsxSlash = next === ">" || code[prevSignificant(i)] === "<";
      if (c === "/" && !jsxSlash && regexAllowed(i)) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") {
            j += 2;
            continue;
          }
          if (src[j] === "[") inClass = true;
          else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) break;
          j++;
        }
        if (j < n && src[j] === "/") {
          for (let k = i + 1; k < j; k++) blank(code, k);
          i = j + 1;
          while (i < n && /[a-z]/.test(src[i])) i++;
          continue;
        }
      }
      if (c === "{") depth++;
      if (c === "}") {
        if (untilBrace && depth === 0) return i;
        depth--;
      }
      i++;
    }
    return n;
  };

  scanCode(0, false);
  return { code: code.join(""), text: text.join("") };
}

// ---- e2ee.ts rules: the transport, the gate and the prepublish (G) ---------

/** The four `iosMediaE2EEReady` terms, normalized (plan D6 + D8, G3). */
const IOS_READY_TERMS: [string, string, string][] = [
  // [property, value, what dropping it is]
  [
    "capsMediaE2EE",
    "(windowasSlogaIosCapsWindow).__slogaIosCaps?.mediaE2EE",
    "the build's caps flag ignored",
  ],
  ["pluginPresent", 'Capacitor.isPluginAvailable("E2ee")', "plugin dropped"],
  [
    "scriptTransform",
    'typeofRTCRtpScriptTransform!=="undefined"',
    "the RTCRtpScriptTransform check dropped",
  ],
  ["probe", "workerProbeResult()", "the D8 probe dropped"],
];
const IOS_READY_CALL = `iosMediaE2EEReady({${IOS_READY_TERMS.map(
  ([key, value]) => `${key}:${value}`,
).join(",")}})`;
const KEY_PUSH_BODY =
  "constplatform=Capacitor.getPlatform();" +
  'return(Capacitor.isNativePlatform()&&(platform==="android"||' +
  `(platform==="ios"&&${IOS_READY_CALL})));`;
const PROBE_IMPORT =
  /\bimport\s*\{([^}]*)\}\s*from\s*["']\.\.\/rtc\/workerProbe(?:\.ts)?["']/g;
const CLIPBOARD_DECL =
  "readonlyclipboardImageInWebview=capacitorClipboardImageInWebview(Capacitor.getPlatform());";
const ATTACHMENT_BODY =
  "returncapacitorAttachmentUrl(Capacitor.getPlatform(),messageId,idx);";
const NATIVE_RETURN =
  /returncapacitorNativeE2EE\(Capacitor\.isNativePlatform\(\),Capacitor\.getPlatform\(\),(?:\(([\w$]+)\)|([\w$]+))=>Capacitor\.isPluginAvailable\((?:\1|\2)\)\);$/;
const PREPUBLISH_GATE = "if(!this.mediaE2EEPlatformSupported())return;";
const CALLS_GATE = "if(!this.#callsEnabled())return;";
const BRIDGE_MEDIA_BODY =
  "returnmediaE2EEPlatformSupported(this.nativeKeyPushAvailable());";
const BRIDGE_KEY_PUSH_BODY = "returnthis.#transport.keyPushAvailable();";
const PLATFORM_IMPORTS = [
  "capacitorAttachmentUrl",
  "capacitorClipboardImageInWebview",
  "capacitorCouriersOrphanedRecovery",
  "capacitorNativeE2EE",
  "iosMediaE2EEReady",
  "mediaE2EEPlatformSupported",
];
const PLATFORM_FUNCTIONS = [
  ...PLATFORM_IMPORTS,
  "platformMediaE2EESupported",
  "shellMediaE2EESupported",
];

/** Index of the one top-level `name` member of a class body, or a violation. */
function oneMember(
  m: Masked,
  body: [number, number],
  name: string,
): number | string {
  const hits = topLevelHits(m.code, body[0], body[1], name);
  return hits.length === 1
    ? hits[0]
    : `${hits.length} top-level \`${name}\` members, want 1`;
}

function transportViolations(src: string, m: Masked): string[] {
  const out: string[] = [];

  // G1: one class, not split per platform.
  const names = [
    ...m.code.matchAll(/\bclass\s+(Capacitor[\w$]*Transport)(?![\w$])/g),
  ].map((h) => h[1]);
  const bodies = classBodies(m.code, "CapacitorTransport");
  if (bodies.length !== 1 || names.length !== 1) {
    out.push(
      `G1 ${bodies.length} \`class CapacitorTransport\`, Capacitor transport` +
        ` classes ${JSON.stringify(names)}; want exactly CapacitorTransport`,
    );
  }
  if (bodies.length !== 1) return out;
  const body = bodies[0];
  const line = lineOf(src, body[0]);

  // G2: nativeBlobTransfer = true.
  const blob = oneMember(m, body, "nativeBlobTransfer");
  if (typeof blob === "string") out.push(`G2 line ${line}: ${blob}`);
  else if (memberStatement(m, blob) !== "readonlynativeBlobTransfer=true;") {
    out.push(
      `G2 line ${lineOf(src, blob)}: \`${memberStatement(m, blob)}\`, want` +
        " readonly nativeBlobTransfer = true;",
    );
  }

  // G3: keyPushAvailable() is android, or iOS with all four ready terms.
  const keyPush = oneMember(m, body, "keyPushAvailable");
  if (typeof keyPush === "string") out.push(`G3 line ${line}: ${keyPush}`);
  else {
    const at = methodBodyAt(m.code, keyPush, "keyPushAvailable");
    const got = at ? norm(m.text.slice(at[0] + 1, at[1])) : "";
    const where = `G3 line ${lineOf(src, keyPush)}`;
    if (got !== KEY_PUSH_BODY) {
      out.push(
        `${where}: keyPushAvailable() is \`${got}\`, want` +
          ` \`${KEY_PUSH_BODY}\` (android, or iOS only when iosMediaE2EEReady)`,
      );
    }
    // Name the dropped term, so a red run says which one.
    const calls = at
      ? hitsOf(m.code.slice(at[0], at[1]), /\biosMediaE2EEReady\s*\(/g)
      : [];
    if (calls.length !== 1) {
      out.push(
        `${where}: iosMediaE2EEReady( called ${calls.length} times in` +
          " keyPushAvailable(), want 1",
      );
    } else {
      const paren = m.code.indexOf("(", at![0] + calls[0]);
      const brace = skipWs(m.code, paren + 1);
      const terms = new Map<string, string>();
      if (m.code[brace] === "{") {
        for (const item of items(m, brace)) {
          const colon = item.indexOf(":");
          if (colon < 0) terms.set(item, item);
          else terms.set(item.slice(0, colon), item.slice(colon + 1));
        }
      }
      for (const [key, value, what] of IOS_READY_TERMS) {
        const term = terms.get(key);
        if (term !== value) {
          out.push(
            `${where}: iosMediaE2EEReady's ${key} is \`${term ?? "missing"}\`,` +
              ` want \`${value}\` (${what})`,
          );
        }
      }
    }
  }

  // G4: clipboardImageInWebview from e2eePlatform.
  const clip = oneMember(m, body, "clipboardImageInWebview");
  if (typeof clip === "string") out.push(`G4 line ${line}: ${clip}`);
  else if (memberStatement(m, clip) !== CLIPBOARD_DECL) {
    out.push(
      `G4 line ${lineOf(src, clip)}: \`${memberStatement(m, clip)}\`, want` +
        ` \`${CLIPBOARD_DECL}\``,
    );
  }

  // G5: attachmentUrl from e2eePlatform; no URL literal in the class.
  const url = oneMember(m, body, "attachmentUrl");
  if (typeof url === "string") out.push(`G5 line ${line}: ${url}`);
  else {
    const at = methodBodyAt(m.code, url, "attachmentUrl");
    const got = at ? norm(m.text.slice(at[0] + 1, at[1])) : "";
    if (got !== ATTACHMENT_BODY) {
      out.push(
        `G5 line ${lineOf(src, url)}: attachmentUrl() is \`${got}\`, want` +
          ` \`${ATTACHMENT_BODY}\``,
      );
    }
  }
  const classText = m.text.slice(body[0], body[1]);
  for (const hit of classText.matchAll(/e2ee-att/g)) {
    out.push(
      `G5 line ${lineOf(src, body[0] + hit.index!)}: a hard-coded e2ee-att` +
        " URL in CapacitorTransport",
    );
  }
  return out;
}

function gateViolations(src: string, m: Masked): string[] {
  const out: string[] = [];

  // G6: nativeE2EEAvailable defers the Capacitor answer.
  const defs = [...m.code.matchAll(/\bfunction\s+nativeE2EEAvailable\s*\(/g)];
  if (defs.length !== 1) {
    out.push(`G6 function nativeE2EEAvailable defined ${defs.length} times`);
  } else {
    const at = defs[0].index!;
    const params = matchClose(m.code, at + defs[0][0].length - 1);
    const open = m.code.indexOf("{", params);
    const body = norm(m.text.slice(open + 1, matchClose(m.code, open)));
    const line = lineOf(src, at);
    if (!NATIVE_RETURN.test(body)) {
      out.push(
        `G6 line ${line}: nativeE2EEAvailable does not end with return` +
          " capacitorNativeE2EE(isNativePlatform, getPlatform, name =>" +
          " Capacitor.isPluginAvailable(name))",
      );
    }
    if (body.split("capacitorNativeE2EE(").length !== 2) {
      out.push(`G6 line ${line}: capacitorNativeE2EE( is not called once`);
    }
    if (/Capacitor\.getPlatform\(\)[!=]==/.test(body)) {
      out.push(
        `G6 line ${line}: nativeE2EEAvailable compares Capacitor.getPlatform()` +
          " itself instead of leaving it to capacitorNativeE2EE",
      );
    }
  }

  // G7: the prepublish platform gate comes first.
  const pre = privateMethodBodies(m.code, "prepublishMlsKeyPackages");
  if (pre.length !== 1) {
    out.push(`G7 #prepublishMlsKeyPackages defined ${pre.length} times`);
  } else {
    const [open, close] = pre[0];
    const body = norm(m.text.slice(open + 1, close));
    const line = lineOf(src, open);
    if (!body.startsWith(PREPUBLISH_GATE)) {
      out.push(
        `G7 line ${line}: #prepublishMlsKeyPackages does not start with` +
          " if (!this.mediaE2EEPlatformSupported()) return;",
      );
    }
    if (!body.includes(CALLS_GATE)) {
      out.push(
        `G7 line ${line}: #prepublishMlsKeyPackages lost` +
          " if (!this.#callsEnabled()) return;",
      );
    }
  }

  // G8: the bridge's one predicate.
  const bridges = classBodies(m.code, "E2EEBridge");
  if (bridges.length !== 1) {
    out.push(`G8 class E2EEBridge defined ${bridges.length} times`);
  } else {
    const rows: [string, string][] = [
      ["mediaE2EEPlatformSupported", BRIDGE_MEDIA_BODY],
      ["nativeKeyPushAvailable", BRIDGE_KEY_PUSH_BODY],
    ];
    for (const [name, want] of rows) {
      const hit = oneMember(m, bridges[0], name);
      if (typeof hit === "string") {
        out.push(`G8 E2EEBridge: ${hit}`);
        continue;
      }
      const at = methodBodyAt(m.code, hit, name);
      const got = at ? norm(m.text.slice(at[0] + 1, at[1])) : "";
      if (got !== want) {
        out.push(
          `G8 line ${lineOf(src, hit)}: ${name}() is \`${got}\`, want \`${want}\``,
        );
      }
    }
  }

  // G9: one source for the platform rules.
  const imported = new Set<string>();
  const from =
    /\bimport\s*\{([^}]*)\}\s*from\s*["']\.\/e2eePlatform(?:\.ts)?["']/g;
  for (const hit of m.text.matchAll(from)) {
    for (const name of hit[1].split(",")) imported.add(squash(name));
  }
  for (const name of PLATFORM_IMPORTS) {
    if (!imported.has(name)) {
      out.push(`G9 ${name} is not imported (unaliased) from ./e2eePlatform`);
    }
  }
  for (const name of PLATFORM_FUNCTIONS) {
    const local = new RegExp(
      `\\b(?:function|const|let|var)\\s+${name}(?![\\w$])`,
    );
    if (local.test(m.code)) out.push(`G9 e2ee.ts defines ${name} itself`);
  }

  // G3 (file-wide): one iOS ready call, and the probe answer is the real cache.
  // (A definition is G9's to report, not a second caller.)
  const readyCalls = hitsOf(
    m.code,
    /(?<!\bfunction\s+)\biosMediaE2EEReady\s*\(/g,
  );
  if (readyCalls.length !== 1) {
    out.push(
      `G3 iosMediaE2EEReady( is called ${readyCalls.length} times in e2ee.ts,` +
        " want once (in CapacitorTransport.keyPushAvailable)",
    );
  }
  if (
    ![...m.text.matchAll(PROBE_IMPORT)].some((h) =>
      h[1].split(",").map(squash).includes("workerProbeResult"),
    )
  ) {
    out.push(
      "G3 workerProbeResult is not imported (unaliased) from ../rtc/workerProbe",
    );
  }
  if (
    /\b(?:function|const|let|var)\s+workerProbeResult(?![\w$])/.test(m.code)
  ) {
    out.push("G3 e2ee.ts defines workerProbeResult itself");
  }
  return out;
}

// ---- e2ee.ts rules: the protector copy on unverifiable status (F) ----------

const STATUS_TEXT = "Encryptionstatuscouldnotbeverified.";
const STATUS_FALLBACKS = [
  '"Encryptionstatuscouldnotbeverified.ThemessagewasNOTsent."',
  '"Encryptionstatuscouldnotbeverified.Nothingwassent."',
];

function protectorViolations(
  src: string,
  m: Masked,
  expectedSites: number,
): string[] {
  const out: string[] = [];
  let sites = 0;
  for (const hit of m.code.matchAll(/\bnew\s+E2EESendError\s*\(/g)) {
    const paren = hit.index! + hit[0].length - 1;
    const args = items(m, paren);
    if (!args[0]?.includes(STATUS_TEXT)) continue;
    // The nearest catch body, without leaving the function.
    let binding: string | null = null;
    for (const open of enclosingBlocks(m.code, hit.index!).reverse()) {
      binding = catchBinding(m.code, open);
      if (binding !== null || isFunctionBody(m.code, open)) break;
    }
    if (binding === null) continue;
    sites++;
    const line = lineOf(src, hit.index!);
    if (binding === "") {
      out.push(
        `F1 line ${line}: the catch binds no error, so the protector copy` +
          " cannot read it",
      );
      continue;
    }
    const want = new RegExp(
      `^protectorSendErrorCopy\\(${escapeRe(binding)},Capacitor\\.getPlatform\\(\\)\\)\\?\\?(.*)$`,
    );
    const got = want.exec(args[0]);
    if (!got || !STATUS_FALLBACKS.includes(got[1])) {
      out.push(
        `F1 line ${line}: message is \`${args[0]}\`, want` +
          ` protectorSendErrorCopy(${binding}, Capacitor.getPlatform()) ??` +
          " the existing text",
      );
    }
    if (args.length !== 2 || args[1] !== '"native"') {
      out.push(`F1 line ${line}: kind is ${JSON.stringify(args.slice(1))}`);
    }
  }
  if (sites !== expectedSites) {
    out.push(
      `F2 ${sites} unverifiable-status E2EESendError sites in a catch,` +
        ` want ${expectedSites}`,
    );
  }
  return out;
}

// ---- e2ee.ts rules: the iOS orphaned recovery bundle (R) -------------------

const BUNDLE_EVENT = '"backupBundleWaiting"';
const ORPHAN_MEMBER =
  /^readonlysubscribeBackupBundleWaiting=capacitorCouriersOrphanedRecovery\(Capacitor\.getPlatform\(\)\)\?.+:undefined;$/;
const ORPHAN_LISTENER = [BUNDLE_EVENT, "()=>callback()"];
const WATCH_GUARD = "if(this.#backupBundleWaiting)return;";
const WATCH_HELD =
  "this.#backupBundleWaiting=this.#transport.subscribeBackupBundleWaiting(";
const WATCH_CALLBACKS = [
  "()=>{voidthis.#courierOrphanedBackup();}",
  "()=>voidthis.#courierOrphanedBackup()",
];
const WATCH_CALL = "this.#watchOrphanedBackup();";
const CLAIM_TAILS = [
  "if(this.#transport.subscribeBackupBundleWaiting){awaitthis.#courierOrphanedBackup();}",
  "if(this.#transport.subscribeBackupBundleWaiting)awaitthis.#courierOrphanedBackup();",
];
const COURIER_BODY =
  /^const([\w$]+)=this\.status\.get\("state"\);if\((.+?)\)return;try\{awaitthis\.refreshBackupIfDue\(\);\}catch\(([\w$]+)\)\{(.*)\}$/;
const REFRESH_COMMAND = /["'`]e2ee_backup_refresh_if_due["'`]/g;

/** Index where the statement holding index `at` starts (masked code). */
function stmtStart(code: string, at: number): number {
  let start = at;
  while (start > 0 && !/[;{}]/.test(code[start - 1])) start--;
  return skipWs(code, start);
}

/** The whole statement holding index `at`, normalized ("" if unended). */
function statementAt(m: Masked, at: number): string {
  const start = stmtStart(m.code, at);
  const end = stmtEnd(m.code, start);
  return end < 0 ? "" : norm(m.text.slice(start, end + 1));
}

/** Indices of each match of `re` (global) in the masked code. */
function hitsOf(code: string, re: RegExp): number[] {
  return [...code.matchAll(re)].map((h) => h.index!);
}

const within = (range: [number, number] | null, at: number) =>
  range !== null && range[0] < at && at < range[1];

/**
 * The body `[open, close]` of a method whose name ends at `after` (masked
 * code), or null when no parameter list follows. Unlike `methodBodyAt`, the
 * return type may hold parens, arrows and object types.
 */
function methodRangeAfter(
  code: string,
  after: number,
): [number, number] | null {
  let i = skipWs(code, after);
  if (code[i] !== "(") return null;
  for (i = matchClose(code, i) + 1; i < code.length; i++) {
    const c = code[i];
    if (c === "{") {
      // `{` after `:`, `|`, `&`, `<` or `,` opens an object type.
      if (!/[:|&<,]/.test(code[skipBack(code, i - 1)])) {
        return [i, matchClose(code, i)];
      }
      i = matchClose(code, i);
    } else if (c === "(" || c === "[") i = matchClose(code, i);
    else if (c === ";" || (c === "=" && code[i + 1] !== ">")) return null;
  }
  return null;
}

function orphanTransportViolations(src: string, m: Masked): string[] {
  const out: string[] = [];
  const bodies = classBodies(m.code, "CapacitorTransport");
  if (bodies.length !== 1) return out; // G1 reports it
  const body = bodies[0];
  const line = lineOf(src, body[0]);

  // R1: a property that is undefined off iOS, never a method.
  let range: [number, number] | null = null;
  const member = oneMember(m, body, "subscribeBackupBundleWaiting");
  if (typeof member === "string") out.push(`R1 line ${line}: ${member}`);
  else {
    const method = methodRangeAfter(
      m.code,
      member + "subscribeBackupBundleWaiting".length,
    );
    const end = stmtEnd(m.code, member);
    range = method ?? (end < 0 ? null : [member, end]);
    const stmt = method ? "a method" : memberStatement(m, member);
    if (method || !ORPHAN_MEMBER.test(stmt)) {
      out.push(
        `R1 line ${lineOf(src, member)}: subscribeBackupBundleWaiting is` +
          ` \`${stmt}\`, want readonly subscribeBackupBundleWaiting =` +
          " capacitorCouriersOrphanedRecovery(Capacitor.getPlatform()) ?" +
          " <listener> : undefined; (absent off iOS)",
      );
    }
  }

  // R2: one listener, for exactly this event, payload dropped.
  const listeners = hitsOf(
    m.code.slice(body[0], body[1]),
    /\.\s*addListener\s*\(/g,
  )
    .map((i) => m.code.indexOf("(", body[0] + i))
    .filter((paren) => items(m, paren)[0] === BUNDLE_EVENT);
  if (listeners.length !== 1) {
    out.push(
      `R2 line ${line}: ${listeners.length} addListener(${BUNDLE_EVENT})` +
        " calls in CapacitorTransport, want 1",
    );
  } else {
    const paren = listeners[0];
    const args = items(m, paren);
    if (JSON.stringify(args) !== JSON.stringify(ORPHAN_LISTENER)) {
      out.push(
        `R2 line ${lineOf(src, paren)}: the listener is` +
          ` \`addListener(${args.join(",")})\`, want` +
          ` addListener(${BUNDLE_EVENT}, () => callback()) (payload dropped)`,
      );
    }
    if (typeof member !== "string" && !within(range, paren)) {
      out.push(
        `R2 line ${lineOf(src, paren)}: the listener is outside` +
          " subscribeBackupBundleWaiting",
      );
    }
  }
  const named = m.text
    .slice(body[0], body[1])
    .match(/["'`]backupBundleWaiting["'`]/g);
  if ((named?.length ?? 0) !== 1) {
    out.push(
      `R2 line ${line}: ${BUNDLE_EVENT} is named ${named?.length ?? 0}` +
        " times in CapacitorTransport, want 1",
    );
  }
  return out;
}

function orphanBridgeViolations(src: string, m: Masked): string[] {
  const out: string[] = [];
  const bridges = classBodies(m.code, "E2EEBridge");
  if (bridges.length !== 1) return out; // G8 reports it
  const bridge = bridges[0];

  // R3: one held subscription, set up once from the constructor.
  const watch = privateMethodBodies(m.code, "watchOrphanedBackup");
  if (watch.length !== 1) {
    out.push(`R3 #watchOrphanedBackup defined ${watch.length} times`);
  } else if (!norm(m.text.slice(watch[0][0] + 1)).startsWith(WATCH_GUARD)) {
    out.push(
      `R3 line ${lineOf(src, watch[0][0])}: #watchOrphanedBackup does not` +
        " start with if (this.#backupBundleWaiting) return;",
    );
  }
  const subs = hitsOf(
    m.code,
    /\bsubscribeBackupBundleWaiting\s*(?:\?\.\s*)?\(/g,
  ).filter((i) => within(bridge, i));
  if (subs.length !== 1) {
    out.push(
      `R3 ${subs.length} subscribeBackupBundleWaiting( calls in E2EEBridge,` +
        " want 1",
    );
  } else {
    const at = subs[0];
    const paren = m.code.indexOf("(", at);
    const line = lineOf(src, at);
    if (watch.length === 1 && !within(watch[0], at)) {
      out.push(
        `R3 line ${line}: the subscription is not in #watchOrphanedBackup`,
      );
    }
    const head = norm(m.text.slice(stmtStart(m.code, at), paren + 1));
    if (head !== WATCH_HELD) {
      out.push(
        `R3 line ${line}: \`${head}\` does not hold the subscription in` +
          " this.#backupBundleWaiting",
      );
    }
    const args = items(m, paren);
    if (args.length !== 1 || !WATCH_CALLBACKS.includes(args[0])) {
      out.push(
        `R3 line ${line}: the callback is \`${args.join(",")}\`, want` +
          " () => { void this.#courierOrphanedBackup(); } (no payload)",
      );
    }
  }
  const ctor = oneMember(m, bridge, "constructor");
  const ctorBody =
    typeof ctor === "string" ? null : methodBodyAt(m.code, ctor, "constructor");
  const watchCalls = hitsOf(m.code, /\bthis\s*\.\s*#watchOrphanedBackup\s*\(/g);
  if (
    watchCalls.length !== 1 ||
    !within(ctorBody, watchCalls[0]) ||
    enclosingBlocks(m.code, watchCalls[0]).at(-1) !== ctorBody?.[0] ||
    statementAt(m, watchCalls[0]) !== WATCH_CALL
  ) {
    out.push(
      `R3 this.#watchOrphanedBackup( called ${watchCalls.length} times; want` +
        " once, as a statement of the E2EEBridge constructor",
    );
  }

  // R4: the post-claim fallback ends the successful-claim path.
  const claim = privateMethodBodies(m.code, "onClaimResult");
  if (claim.length !== 1) {
    out.push(`R4 #onClaimResult defined ${claim.length} times`);
  } else {
    const body = norm(m.text.slice(claim[0][0] + 1, claim[0][1]));
    if (!CLAIM_TAILS.some((t) => body.endsWith(t))) {
      out.push(
        `R4 line ${lineOf(src, claim[0][0])}: #onClaimResult does not end` +
          " with if (this.#transport.subscribeBackupBundleWaiting) await" +
          " this.#courierOrphanedBackup();",
      );
    }
  }

  // R5: two callers, the event and the claim.
  const courierCalls = hitsOf(
    m.code,
    /\bthis\s*\.\s*#courierOrphanedBackup\s*\(/g,
  );
  if (courierCalls.length !== 2) {
    out.push(
      `R5 this.#courierOrphanedBackup( called ${courierCalls.length} times,` +
        " want 2 (the event and the claim)",
    );
  }

  // R6: guarded before any native call; best effort.
  const courier = privateMethodBodies(m.code, "courierOrphanedBackup");
  if (courier.length !== 1) {
    out.push(`R6 #courierOrphanedBackup defined ${courier.length} times`);
  } else {
    const line = lineOf(src, courier[0][0]);
    const body = norm(m.text.slice(courier[0][0] + 1, courier[0][1]));
    const shape = COURIER_BODY.exec(body);
    if (!shape) {
      out.push(
        `R6 line ${line}: #courierOrphanedBackup is \`${body}\`, want const s` +
          ' = this.status.get("state"); if (...) return; try { await' +
          " this.refreshBackupIfDue(); } catch (e) { ... }",
      );
    } else {
      const [, s, cond, binding] = shape;
      const terms = cond.split("||");
      const needs: [string, string[]][] = [
        ["user", ["!this.#client.user?.id"]],
        ["enabled", [`!${s}?.enabled`, `!${s}.enabled`]],
        ["published", [`!${s}?.published`, `!${s}.published`]],
        ["the accepted claim", ["this.#claimAccepted!==true"]],
      ];
      for (const [what, forms] of needs) {
        if (!forms.some((f) => terms.includes(f))) {
          out.push(`R6 line ${line}: the guard does not check ${what}`);
        }
      }
      // The handler from the masked code: strings blanked, spacing kept.
      const [open, close] = courier[0];
      const head = /\bcatch\s*\(\s*[\w$]+\s*\)\s*\{/.exec(
        m.code.slice(open, close),
      )!;
      const brace = open + head.index + head[0].length - 1;
      const handler = m.code.slice(brace + 1, matchClose(m.code, brace));
      const b = escapeRe(binding);
      const named = new RegExp(`\\berrorName\\s*\\(\\s*${b}\\s*\\)`, "g");
      if (/\bthrow\b/.test(handler)) {
        out.push(`R6 line ${line}: the catch throws`);
      }
      if (!named.test(handler)) {
        out.push(
          `R6 line ${line}: the catch does not log errorName(${binding})`,
        );
      } else if (
        new RegExp(`(?<![\\w$.#])${b}(?![\\w$])`).test(
          handler.replace(named, ""),
        )
      ) {
        out.push(
          `R6 line ${line}: the catch uses ${binding} beyond errorName(${binding})`,
        );
      }
    }
  }

  // R7: refreshBackupIfDue has one caller, the courier.
  const refreshCalls = hitsOf(m.code, /\.\s*refreshBackupIfDue\s*\(/g);
  if (
    refreshCalls.length !== 1 ||
    courier.length !== 1 ||
    !within(courier[0], refreshCalls[0])
  ) {
    out.push(
      `R7 .refreshBackupIfDue( called ${refreshCalls.length} times; want` +
        " once, inside #courierOrphanedBackup",
    );
  }
  const refresh = oneMember(m, bridge, "refreshBackupIfDue");
  const refreshBody =
    typeof refresh === "string"
      ? null
      : methodBodyAt(m.code, refresh, "refreshBackupIfDue");
  const commands = hitsOf(m.text, REFRESH_COMMAND);
  if (commands.length !== 1 || !within(refreshBody, commands[0])) {
    out.push(
      `R7 "e2ee_backup_refresh_if_due" appears ${commands.length} times;` +
        " want once, inside refreshBackupIfDue()",
    );
  }
  return out;
}

function tsViolations(src: string, expectedSites: number): string[] {
  const m = maskTs(src);
  return [
    ...(balanced(m.code) ? [] : ["G0 e2ee.ts does not lex to balanced braces"]),
    ...transportViolations(src, m),
    ...gateViolations(src, m),
    ...protectorViolations(src, m, expectedSites),
    ...orphanTransportViolations(src, m),
    ...orphanBridgeViolations(src, m),
  ];
}

// ---- rtc/state.tsx rules (C) ------------------------------------------------

/**
 * THE shell predicate call (plan D6, C-W3-8), normalized: the prejoin
 * copy's first `wouldEncrypt` term (P3) and, once L3t lands,
 * `shellSupported`'s first term (C1), character for character.
 */
const SHELL_CALL =
  "shellMediaE2EESupported({e2eeSupported:isE2EESupported()," +
  "nativeE2EEAvailable:nativeE2EEAvailable()," +
  "bridgePlatformSupported:!!bridge?.mediaE2EEPlatformSupported()})";
const STATE_TOGGLE = "this.#settings.e2eeCallsEnabled";
const PREJOIN_DEVICE_TERMS = [
  '!!bridge?.status.get("state")?.published',
  "input.e2eeCallsEnabled",
];
/** Calls that would make a copy its own, second predicate. */
const OWN_PLATFORM_CALLS = [
  "platformMediaE2EESupported(",
  "nativeKeyPushAvailable(",
  "iosMediaE2EEReady(",
];
/** `import { ... } from` the alias, or the one relative path that resolves. */
const platformImport = (relative: string) =>
  new RegExp(
    `\\bimport\\s*\\{([^}]*)\\}\\s*from\\s*["'](?:@revolt/client|${escapeRe(relative)})/e2eePlatform(?:\\.ts)?["']`,
    "g",
  );
/** From rtc/state.tsx. */
const STATE_PLATFORM_IMPORT = platformImport("../client");
/** From ui/components/features/voice/useCallPrejoinMode.ts. */
const PREJOIN_PLATFORM_IMPORT = platformImport("../../../../client");

/** Whether `name` is imported unaliased by an import matching `re`. */
function importsName(m: Masked, re: RegExp, name: string): boolean {
  return [...m.text.matchAll(re)].some((h) =>
    h[1].split(",").map(squash).includes(name),
  );
}

// ---- The server's iOS switch (D14, Stage 5 fix round F, R21) ---------------

/** The prejoin copy's switch binding and its first `wouldEncrypt` term (P3). */
const PREJOIN_SWITCH_NAME = "sw";
const PREJOIN_FIRST = `callMediaE2EEOffered(${SHELL_CALL},${PREJOIN_SWITCH_NAME})`;
/** `const sw = ...` in the prejoin copy, normalized (P5). */
const PREJOIN_SWITCH =
  "iosCallSwitch({platform:Capacitor.getPlatform(),serverValue:" +
  'Capacitor.getPlatform()==="ios"?awaitfetchIosCallSwitchValue({' +
  'fetchRoot:()=>client().api.get("/"),setTimeout,clearTimeout}):undefined})';
/** The three switch helpers the prejoin copy and Settings import. */
const SWITCH_HELPERS = [
  "callMediaE2EEOffered",
  "fetchIosCallSwitchValue",
  "iosCallSwitch",
];
/** From the prejoin hook and the Settings card (both four levels deep). */
const SWITCH_IMPORT =
  /\bimport\s*\{([^}]*)\}\s*from\s*["'](?:@revolt\/rtc|\.\.\/\.\.\/\.\.\/\.\.\/rtc)\/iosCallSwitch(?:\.ts)?["']/g;
/**
 * What turns the RAW server value into something else before
 * `iosCallSwitch` reads it: absent must read ON, so `!!x`, `Boolean(x)`,
 * `x ?? false`, `x || false`, `x === true` (all fold absent into OFF or flip
 * the rule) and `client.configuration` (a local stub, Stage 5 B1) are banned.
 */
const COERCION =
  /!!|^!|\bBoolean\(|\?\?|\|\||&&|[!=]==?(?:true|false)(?![\w$])|\bconfiguration\b/;
/** `GET /`, the only place the switch is read from (never a stub). */
const FETCH_ROOT = /^\(\)=>(?:this\.getClient|client)\(\)\.api\.get\("\/"\)$/;
/** state.tsx's readiness input for the switch (R21), normalized. */
const PAUSED_BY_SERVER =
  /^pausedByServer:iosCallSwitch\(\{platform:Capacitor\.getPlatform\(\),serverValue:[\w$]+\}\)==="off"$/;

/** Index of the top-level `,` `;` or closing bracket ending the expression at `from`. */
function exprEnd(code: string, from: number): number {
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") i = matchClose(code, i);
    else if (",;)]}".includes(c)) return i;
  }
  return code.length;
}

/** The arguments of `expr` when it is exactly one call of `name`, else null. */
function callArgsOf(expr: string, name: string): string[] | null {
  if (!expr.startsWith(`${name}(`)) return null;
  const mm = maskTs(expr);
  let close: number;
  try {
    close = matchClose(mm.code, name.length);
  } catch {
    return null;
  }
  return close === expr.length - 1 ? items(mm, name.length) : null;
}

/** Calls of `name` (not its definition), as the index of each `(`. */
function callParens(code: string, name: string): number[] {
  const re = new RegExp(`(?<!\\bfunction\\s+)\\b${name}\\s*\\(`, "g");
  return hitsOf(code, re).map((at) => code.indexOf("(", at));
}

/** `key -> value` of the object literal argument at `paren`, or null. */
function objectArg(m: Masked, paren: number): Map<string, string> | null {
  const brace = skipWs(m.code, paren + 1);
  if (m.code[brace] !== "{") return null;
  const out = new Map<string, string>();
  for (const item of items(m, brace)) {
    const colon = item.indexOf(":");
    if (colon < 0) out.set(item, item);
    else out.set(item.slice(0, colon), item.slice(colon + 1));
  }
  return out;
}

/**
 * The server value reaches `iosCallSwitch` RAW (rule `rule`): every
 * `serverValue` object key and every `...SwitchValue` / `...SwitchFetch`
 * assignment is free of COERCION, every `iosCallSwitch(` call takes exactly
 * `{ platform, serverValue }` with the real platform, and every
 * `fetchIosCallSwitchValue(` reads `GET /`.
 */
function switchRawViolations(
  rule: string,
  file: string,
  src: string,
  m: Masked,
): string[] {
  const out: string[] = [];
  const raw = (at: number, what: string, value: string) => {
    if (COERCION.test(value)) {
      out.push(
        `${rule} ${file} line ${lineOf(src, at)}: ${what} is \`${value}\`;` +
          " the server value must reach iosCallSwitch RAW (no !!, Boolean()," +
          " ?? false, comparisons or client.configuration: absent reads ON)",
      );
    }
  };
  for (const hit of m.code.matchAll(/(?<=[{,]\s*)serverValue\s*:/g)) {
    const from = hit.index! + hit[0].length;
    raw(
      hit.index!,
      "serverValue",
      norm(m.text.slice(from, exprEnd(m.code, from))),
    );
  }
  for (const hit of m.code.matchAll(
    /\b([\w$]*[sS]witch(?:Value|Fetch))\s*=(?![=>])/g,
  )) {
    const from = hit.index! + hit[0].length;
    raw(hit.index!, hit[1], norm(m.text.slice(from, exprEnd(m.code, from))));
  }
  const localPlatform = squash(m.code).includes(
    "constplatform=Capacitor.getPlatform();",
  );
  for (const paren of callParens(m.code, "iosCallSwitch")) {
    const line = lineOf(src, paren);
    const arg = objectArg(m, paren);
    const keys = arg ? [...arg.keys()].sort().join(",") : "";
    if (!arg || keys !== "platform,serverValue") {
      out.push(
        `${rule} ${file} line ${line}: iosCallSwitch( takes \`${keys}\`,` +
          " want { platform, serverValue }",
      );
      continue;
    }
    const platform = arg.get("platform");
    if (
      platform !== "Capacitor.getPlatform()" &&
      !(platform === "platform" && localPlatform)
    ) {
      out.push(
        `${rule} ${file} line ${line}: iosCallSwitch's platform is` +
          ` \`${platform}\`, want Capacitor.getPlatform()`,
      );
    }
  }
  for (const paren of callParens(m.code, "fetchIosCallSwitchValue")) {
    const root = objectArg(m, paren)?.get("fetchRoot");
    if (!root || !FETCH_ROOT.test(root)) {
      out.push(
        `${rule} ${file} line ${lineOf(src, paren)}: fetchRoot is` +
          ` \`${root ?? "missing"}\`, want () => client().api.get("/") (GET /,` +
          " never client.configuration)",
      );
    }
  }
  return out;
}

/**
 * The switch is applied ONLY through `callMediaE2EEOffered` (rule `rule`):
 * at least one call, each with two arguments whose second is an
 * `iosCallSwitch(...)` verdict inline or a `const` bound to one, and every
 * `iosCallSwitch(` call (and its binding) used there and nowhere else.
 */
function switchOfferedViolations(
  rule: string,
  file: string,
  src: string,
  m: Masked,
): string[] {
  const out: string[] = [];
  const offered = callParens(m.code, "callMediaE2EEOffered");
  if (offered.length === 0) {
    out.push(
      `${rule} ${file} never calls callMediaE2EEOffered(: the server switch` +
        " is not applied through the one helper",
    );
  }
  const covered = new Set<number>();
  const bound = new Map<string, number>();
  for (const paren of offered) {
    const args = items(m, paren);
    const line = lineOf(src, paren);
    if (args.length !== 2) {
      out.push(
        `${rule} ${file} line ${line}: callMediaE2EEOffered takes` +
          ` ${args.length} arguments, want (shell, switch)`,
      );
      continue;
    }
    if (args[1].startsWith("iosCallSwitch(")) {
      for (const p of callParens(m.code, "iosCallSwitch")) {
        if (paren < p && p < matchClose(m.code, paren)) covered.add(p);
      }
    } else if (/^[\w$]+$/.test(args[1])) {
      bound.set(args[1], (bound.get(args[1]) ?? 0) + 1);
    } else {
      out.push(
        `${rule} ${file} line ${line}: callMediaE2EEOffered's switch is` +
          ` \`${args[1]}\`, want an iosCallSwitch(...) verdict`,
      );
    }
  }
  for (const [name, uses] of bound) {
    const decls = [
      ...m.code.matchAll(
        new RegExp(
          `\\bconst\\s+${escapeRe(name)}\\s*=\\s*iosCallSwitch\\s*\\(`,
          "g",
        ),
      ),
    ];
    if (decls.length !== 1) {
      out.push(
        `${rule} ${file}: ${name} is not one const bound to iosCallSwitch(...)`,
      );
      continue;
    }
    covered.add(m.code.indexOf("(", decls[0].index! + decls[0][0].length - 1));
    const all = hitsOf(
      m.code,
      new RegExp(`(?<![.\\w$#])${escapeRe(name)}(?![\\w$])`, "g"),
    ).length;
    if (all - 1 !== uses) {
      out.push(
        `${rule} ${file} line ${lineOf(src, decls[0].index!)}: the switch` +
          ` ${name} is read ${all - 1 - uses} times outside` +
          " callMediaE2EEOffered (applied by hand)",
      );
    }
  }
  for (const paren of callParens(m.code, "iosCallSwitch")) {
    if (!covered.has(paren)) {
      out.push(
        `${rule} ${file} line ${lineOf(src, paren)}: iosCallSwitch( outside` +
          " callMediaE2EEOffered (the switch applied by hand)",
      );
    }
  }
  return out;
}

/** The three switch helpers imported unaliased, defined nowhere locally. */
function switchImportViolations(rule: string, file: string, m: Masked) {
  const out: string[] = [];
  for (const name of SWITCH_HELPERS) {
    if (!importsName(m, SWITCH_IMPORT, name)) {
      out.push(
        `${rule} ${name} is not imported (unaliased) from` +
          ` @revolt/rtc/iosCallSwitch in ${file}`,
      );
    }
    if (
      new RegExp(`\\b(?:function|const|let|var)\\s+${name}(?![\\w$])`).test(
        m.code,
      )
    ) {
      out.push(`${rule} ${file} defines ${name} itself`);
    }
  }
  return out;
}

/**
 * The top-level `&&` terms of the one `const <name> =` initializer, or the
 * violations (rule `rule`) that stop it being read: not exactly one
 * declaration, no end, or a top-level `||` / `??`.
 */
function andTerms(
  src: string,
  m: Masked,
  rule: string,
  name: string,
): { terms: string[]; line: number } | string[] {
  const decls = [
    ...m.code.matchAll(new RegExp(`\\bconst\\s+${name}\\s*=`, "g")),
  ];
  if (decls.length !== 1) {
    return [`${rule} const ${name} declared ${decls.length} times, want 1`];
  }
  const from = decls[0].index! + decls[0][0].length;
  const end = stmtEnd(m.code, from);
  const line = lineOf(src, from);
  if (end < 0)
    return [`${rule} line ${line}: ${name}'s initializer has no end`];
  const out: string[] = [];
  for (const op of ["||", "??"]) {
    if (splitTop(m, from, end, op).length > 1) {
      out.push(`${rule} line ${line}: a top-level ${op} in ${name}`);
    }
  }
  return out.length > 0 ? out : { terms: splitTop(m, from, end, "&&"), line };
}

/** The first `&&` term of `const <name> =` in `src`, or "" (cross-file check). */
function firstTerm(src: string, name: string): string {
  const got = andTerms(src, maskTs(src), "-", name);
  return Array.isArray(got) ? "" : (got.terms[0] ?? "");
}

function stateViolations(src: string): string[] {
  const m = maskTs(src);
  const out: string[] = [];
  if (!balanced(m.code)) {
    out.push("C0 state.tsx does not lex to balanced braces");
  }

  // C1 (L3t): the one shell predicate, then the toggle, nothing else.
  const got = andTerms(src, m, "C1", "shellSupported");
  if (Array.isArray(got)) out.push(...got);
  else {
    const want = [SHELL_CALL, STATE_TOGGLE];
    if (JSON.stringify(got.terms) !== JSON.stringify(want)) {
      out.push(
        `C1 line ${got.line}: shellSupported is ${JSON.stringify(got.terms)},` +
          ` want ${JSON.stringify(want)} (the one shell predicate the prejoin` +
          " copy calls, then the toggle; anything else and the prejoin copy" +
          " diverges)",
      );
    }
  }

  // C3 (L3t): that predicate comes from e2eePlatform.
  if (!importsName(m, STATE_PLATFORM_IMPORT, "shellMediaE2EESupported")) {
    out.push(
      "C3 shellMediaE2EESupported is not imported (unaliased) from e2eePlatform",
    );
  }
  if (
    /\b(?:function|const|let|var)\s+shellMediaE2EESupported(?![\w$])/.test(
      m.code,
    )
  ) {
    out.push("C3 state.tsx defines shellMediaE2EESupported itself");
  }

  // C4 (R21): the switch goes to readiness as its own input, never folded
  // into the shell term (folded, a paused iPhone reads "unsupported").
  if (/\bcallMediaE2EEOffered\b/.test(m.code)) {
    out.push(
      "C4 state.tsx names callMediaE2EEOffered (R21: that helper is for the" +
        " prejoin and Settings copy; readiness takes shellSupported and" +
        " pausedByServer separately)",
    );
  }
  // The bare call with an input object (not `this.callEncryptionReadiness()`).
  const readinessCalls = hitsOf(
    m.code,
    /(?<!\.\s*)\bcallEncryptionReadiness\s*\(\s*\{/g,
  ).map((at) => m.code.indexOf("(", at));
  if (readinessCalls.length !== 1) {
    out.push(
      `C4 callEncryptionReadiness({...}) is called ${readinessCalls.length}` +
        " times in state.tsx, want 1",
    );
  } else {
    const line = lineOf(src, readinessCalls[0]);
    const brace = skipWs(m.code, readinessCalls[0] + 1);
    const inputs = m.code[brace] === "{" ? items(m, brace) : [];
    if (!inputs.includes("shellSupported")) {
      out.push(
        `C4 line ${line}: callEncryptionReadiness's shellSupported is not the` +
          " shell term itself (`shellSupported`)",
      );
    }
    const paused = inputs.filter((i) => i.startsWith("pausedByServer"));
    if (paused.length !== 1 || !PAUSED_BY_SERVER.test(paused[0])) {
      out.push(
        `C4 line ${line}: pausedByServer is \`${paused.join(",")}\`, want` +
          " iosCallSwitch({ platform: Capacitor.getPlatform(), serverValue:" +
          ' <raw value> }) === "off"',
      );
    }
  }

  // C5: the server value reaches the switch raw.
  out.push(...switchRawViolations("C5", "state.tsx", src, m));

  // C2: the rule lives in e2eePlatform only.
  if (
    /\b(?:function|const|let|var)\s+platformMediaE2EESupported(?![\w$])/.test(
      m.code,
    )
  ) {
    out.push("C2 state.tsx defines platformMediaE2EESupported itself");
  }
  const reexport =
    /\bexport\s*\{([^}]*)\}\s*from\s*["']\.\.\/client\/e2eePlatform(?:\.ts)?["']/g;
  if (
    ![...m.text.matchAll(reexport)].some((h) =>
      h[1].split(",").map(squash).includes("platformMediaE2EESupported"),
    )
  ) {
    out.push(
      'C2 no export { platformMediaE2EESupported } from "../client/e2eePlatform"',
    );
  }
  return out;
}

// ---- useCallPrejoinMode.ts rules: the prejoin copy (P) ---------------------

function prejoinViolations(src: string): string[] {
  const m = maskTs(src);
  const out: string[] = [];
  if (!balanced(m.code)) {
    out.push("P0 useCallPrejoinMode.ts does not lex to balanced braces");
  }

  // P1: the one predicate, imported; no platform rule of its own.
  if (!importsName(m, PREJOIN_PLATFORM_IMPORT, "shellMediaE2EESupported")) {
    out.push(
      "P1 shellMediaE2EESupported is not imported (unaliased) from e2eePlatform",
    );
  }
  if (
    /\b(?:function|const|let|var)\s+shellMediaE2EESupported(?![\w$])/.test(
      m.code,
    )
  ) {
    out.push("P1 useCallPrejoinMode.ts defines shellMediaE2EESupported itself");
  }
  const livekit = /\bimport\s*\{([^}]*)\}\s*from\s*["']livekit-client["']/g;
  if (!importsName(m, livekit, "isE2EESupported")) {
    out.push(
      "P1 isE2EESupported is not imported (unaliased) from livekit-client",
    );
  }
  const code = squash(m.code);
  for (const call of OWN_PLATFORM_CALLS) {
    if (code.includes(call)) {
      out.push(
        `P1 useCallPrejoinMode.ts calls ${call}) itself: a second predicate` +
          " beside the shared one (the prejoin copy diverges)",
      );
    }
  }

  out.push(...switchImportViolations("P1", "useCallPrejoinMode.ts", m));

  // P5: the switch is read once, raw, from GET / on iOS only.
  const swDecls = [
    ...m.code.matchAll(
      new RegExp(`\\bconst\\s+${PREJOIN_SWITCH_NAME}\\s*=`, "g"),
    ),
  ];
  if (swDecls.length !== 1) {
    out.push(
      `P5 const ${PREJOIN_SWITCH_NAME} declared ${swDecls.length} times, want 1`,
    );
  } else {
    const from = swDecls[0].index! + swDecls[0][0].length;
    const init = norm(m.text.slice(from, exprEnd(m.code, from)));
    if (init !== PREJOIN_SWITCH) {
      out.push(
        `P5 line ${lineOf(src, from)}: ${PREJOIN_SWITCH_NAME} is \`${init}\`,` +
          ` want \`${PREJOIN_SWITCH}\``,
      );
    }
  }

  // P6, P7: applied only through callMediaE2EEOffered, and never coerced.
  out.push(...switchOfferedViolations("P6", "useCallPrejoinMode.ts", src, m));
  out.push(...switchRawViolations("P7", "useCallPrejoinMode.ts", src, m));

  // P2-P4: wouldEncrypt is the one predicate with the switch applied, then
  // the device and toggle.
  const got = andTerms(src, m, "P2", "wouldEncrypt");
  if (Array.isArray(got)) {
    out.push(...got);
    return out;
  }
  const [first, ...rest] = got.terms;
  const offered = callArgsOf(first ?? "", "callMediaE2EEOffered");
  if (!offered) {
    out.push(
      `P3 line ${got.line}: wouldEncrypt starts with \`${first ?? ""}\`,` +
        ` want \`${PREJOIN_FIRST}\` (the shell predicate state.tsx calls,` +
        " with the server switch applied through callMediaE2EEOffered)",
    );
  } else {
    if (offered[0] !== SHELL_CALL) {
      out.push(
        `P3 line ${got.line}: callMediaE2EEOffered's shell argument is` +
          ` \`${offered[0] ?? ""}\`, want \`${SHELL_CALL}\` (the predicate` +
          " state.tsx calls; anything else and the prejoin copy diverges)",
      );
    }
    if (offered.length !== 2 || offered[1] !== PREJOIN_SWITCH_NAME) {
      out.push(
        `P3 line ${got.line}: callMediaE2EEOffered's switch argument is` +
          ` \`${offered.slice(1).join(",")}\`, want \`${PREJOIN_SWITCH_NAME}\``,
      );
    }
  }
  if (JSON.stringify(rest) !== JSON.stringify(PREJOIN_DEVICE_TERMS)) {
    out.push(
      `P4 line ${got.line}: wouldEncrypt's device and toggle terms are` +
        ` ${JSON.stringify(rest)}, want ${JSON.stringify(PREJOIN_DEVICE_TERMS)}`,
    );
  }
  return out;
}

/** The shell argument the prejoin copy hands `callMediaE2EEOffered`, or "". */
function prejoinShellArg(src: string): string {
  const first = firstTerm(src, "wouldEncrypt");
  return callArgsOf(first, "callMediaE2EEOffered")?.[0] ?? first;
}

// ---- Settings Encryption.tsx rules: the call row (S) -----------------------

function settingsViolations(src: string): string[] {
  const m = maskTs(src);
  const out: string[] = [];
  if (!balanced(m.code)) {
    out.push("S0 Encryption.tsx does not lex to balanced braces");
  }

  // S1: the switch helpers, imported.
  out.push(...switchImportViolations("S1", "Encryption.tsx", m));

  // S2, S3: applied only through callMediaE2EEOffered, and never coerced.
  out.push(...switchOfferedViolations("S2", "Encryption.tsx", src, m));
  out.push(...switchRawViolations("S3", "Encryption.tsx", src, m));

  // S4: what the switch reads is the fetched value, untouched on the way:
  // `iosCallSwitch({ ..., serverValue: <signal>()?.serverValue })`, whose
  // one setter is `.then((serverValue) => set<Signal>({ serverValue }))`
  // directly on a fetchIosCallSwitchValue(...) call.
  const switches = callParens(m.code, "iosCallSwitch");
  if (switches.length !== 1) {
    out.push(`S4 iosCallSwitch( called ${switches.length} times, want 1`);
    return out;
  }
  const line = lineOf(src, switches[0]);
  const value = objectArg(m, switches[0])?.get("serverValue") ?? "";
  const signal = /^([\w$]+)\(\)\?\.serverValue$/.exec(value)?.[1];
  if (!signal) {
    out.push(
      `S4 line ${line}: the switch reads \`${value}\`, want` +
        " <signal>()?.serverValue (the fetched value, held as read)",
    );
    return out;
  }
  const setter = `set${signal[0].toUpperCase()}${signal.slice(1)}`;
  const setterCalls = callParens(m.code, setter);
  const fed = callParens(m.code, "fetchIosCallSwitchValue").some((paren) => {
    const then = skipWs(m.code, matchClose(m.code, paren) + 1);
    if (!/^\.\s*then\s*\(/.test(m.code.slice(then, then + 20))) return false;
    const args = items(m, m.code.indexOf("(", then));
    return (
      args.length === 1 && args[0] === `(serverValue)=>${setter}({serverValue})`
    );
  });
  if (setterCalls.length !== 1 || !fed) {
    out.push(
      `S4 line ${line}: ${setter}( is called ${setterCalls.length} times; want` +
        ` once, as fetchIosCallSwitchValue(...).then((serverValue) =>` +
        ` ${setter}({ serverValue }))`,
    );
  }
  return out;
}

// ---- Controller.ts rules (D) ------------------------------------------------

const IOS_CONDITION =
  'Capacitor.isNativePlatform()&&Capacitor.getPlatform()==="ios"';

function controllerViolations(src: string): string[] {
  const m = maskTs(src);
  const out: string[] = [];
  if (!balanced(m.code)) {
    out.push("D0 Controller.ts does not lex to balanced braces");
  }

  // D1
  const imports = /\bimport\s*\{([^}]*)\}\s*from\s*["']@capacitor\/core["']/g;
  if (
    ![...m.text.matchAll(imports)].some((h) =>
      h[1].split(",").map(squash).includes("Capacitor"),
    )
  ) {
    out.push("D1 Controller.ts does not import Capacitor from @capacitor/core");
  }

  // D2
  const names = [...m.text.matchAll(/["'`]Sloga for iOS["'`]/g)];
  const assigns = [
    ...m.text.matchAll(/\bfriendly_name\s*=\s*["'`]Sloga for iOS["'`]\s*;/g),
  ];
  if (names.length !== 1 || assigns.length !== 1) {
    out.push(
      `D2 "Sloga for iOS" appears ${names.length} times, assigned to` +
        ` friendly_name ${assigns.length} times; want 1 and 1`,
    );
    return out;
  }
  const at = assigns[0].index!;
  const line = lineOf(src, at);

  // D3: directly under the iOS-native condition.
  const blocks = enclosingBlocks(m.code, at);
  const inner = blocks[blocks.length - 1] ?? -1;
  const close = inner < 0 ? -1 : skipBack(m.code, inner - 1);
  let thenClose = -1;
  if (close >= 0 && m.code[close] === ")") {
    const open = matchOpen(m.code, close);
    if (
      wordBefore(m.code, open) === "if" &&
      norm(m.text.slice(open + 1, close)) === IOS_CONDITION
    ) {
      thenClose = matchClose(m.code, inner);
    }
  }
  if (thenClose < 0) {
    out.push(
      `D3 line ${line}: "Sloga for iOS" is not assigned directly under` +
        ` if (${IOS_CONDITION})`,
    );
    return out;
  }

  // D4: the web/UA branch comes after it.
  const next = skipWs(m.code, thenClose + 1);
  if (!/^else\s+if\s*\(\s*browser\s*\)/.test(m.code.slice(next, next + 40))) {
    out.push(
      `D4 line ${line}: the iOS branch is not followed by else if (browser),` +
        " so it is not decided before the web/UA name",
    );
  }
  return out;
}

// ---- components/** rules: backup_status gating (E) --------------------------

interface Source {
  path: string;
  src: string;
}

const BACKUP_COMMAND = "e2ee_backup_status";
const ENABLED_DEF =
  /^constenabled=\(\)=>\{const([\w$]+)=[\w$]+\??\.status\.get\("state"\);return!!\1\?\.enabled&&!!\1\?\.published;\};$/;

/** E3 for one `.backupStatus(` call at `at`: a violation, or null. */
function backupGuardViolation(f: Source, m: Masked, at: number): string | null {
  const where = `${f.path}:${lineOf(f.src, at)}`;
  const fns = enclosingBlocks(m.code, at).filter((o) =>
    isFunctionBody(m.code, o),
  );
  if (fns.length === 0) return `E3 ${where}: backupStatus() outside a function`;
  const body = fns[fns.length - 1];
  const first = skipWs(m.code, body + 1);
  const head = /^if\s*\(/.exec(m.code.slice(first, first + 20));
  if (!head) {
    return `E3 ${where}: the enclosing function does not start with an if guard`;
  }
  const paren = first + head[0].length - 1;
  const parenClose = matchClose(m.code, paren);
  if (!/^\s*\{?\s*return\b[^;]*;/.test(m.code.slice(parenClose + 1))) {
    return `E3 ${where}: the first if does not return`;
  }
  const terms = splitTop(m, paren + 1, parenClose, "||");
  if (!terms.includes("!enabled()")) {
    return `E3 ${where}: the guard ${JSON.stringify(terms)} does not test !enabled()`;
  }
  // The nearest `const enabled` declared at the top of an enclosing function.
  for (let k = fns.length - 1; k >= 0; k--) {
    const open = fns[k];
    const close = matchClose(m.code, open);
    const decl = [
      ...m.code.slice(open, close).matchAll(/\bconst\s+enabled\s*=/g),
    ]
      .map((h) => open + h.index!)
      .find((d) => enclosingBlocks(m.code, d).at(-1) === open);
    if (decl === undefined) continue;
    const stmt = norm(m.text.slice(decl, stmtEnd(m.code, decl) + 1));
    return ENABLED_DEF.test(stmt)
      ? null
      : `E3 ${where}: enabled is \`${stmt}\`, not state.enabled && state.published`;
  }
  return `E3 ${where}: no enabled() in scope of the guard`;
}

function backupViolations(files: Source[]): string[] {
  const out: string[] = [];
  const defs: { f: Source; m: Masked; at: number }[] = [];
  const commands: { f: Source; at: number }[] = [];
  let calls = 0;
  for (const f of files) {
    if (!f.src.includes("backupStatus") && !f.src.includes(BACKUP_COMMAND)) {
      continue;
    }
    const m = maskTs(f.src);
    if (!balanced(m.code)) {
      out.push(`E0 ${f.path} does not lex to balanced braces`);
      continue;
    }
    for (const hit of m.text.matchAll(new RegExp(BACKUP_COMMAND, "g"))) {
      commands.push({ f, at: hit.index! });
    }
    for (const hit of m.code.matchAll(/(?<![.\w$#])backupStatus\s*\(/g)) {
      defs.push({ f, m, at: hit.index! });
    }
    for (const hit of m.text.matchAll(/\[\s*["'`]backupStatus["'`]\s*\]/g)) {
      out.push(
        `E3 ${f.path}:${lineOf(f.src, hit.index!)}: backupStatus by bracket access`,
      );
    }
    for (const hit of m.code.matchAll(/\.\s*backupStatus\s*\(/g)) {
      calls++;
      const bad = backupGuardViolation(f, m, hit.index!);
      if (bad) out.push(bad);
    }
  }
  if (calls === 0) out.push("E3 no backupStatus() caller found");

  // E2: the one definition, in client/e2ee.ts.
  const bridgeDefs = defs.filter((d) => d.f.path.endsWith("client/e2ee.ts"));
  if (defs.length !== 1 || bridgeDefs.length !== 1) {
    out.push(
      `E2 backupStatus( defined (or called bare) at` +
        ` ${JSON.stringify(defs.map((d) => `${d.f.path}:${lineOf(d.f.src, d.at)}`))};` +
        " want one definition in client/e2ee.ts",
    );
  }
  const def = bridgeDefs.length === 1 ? bridgeDefs[0] : null;
  const body = def ? methodBodyAt(def.m.code, def.at, "backupStatus") : null;
  if (def && !body) {
    out.push("E2 backupStatus( in client/e2ee.ts is not a method");
  }

  // E1: the command only inside it.
  const inside = commands.filter(
    (c) => body !== null && c.f === def?.f && body[0] < c.at && c.at < body[1],
  );
  if (commands.length !== 1 || inside.length !== 1) {
    out.push(
      `E1 ${BACKUP_COMMAND} at` +
        ` ${JSON.stringify(commands.map((c) => `${c.f.path}:${lineOf(c.f.src, c.at)}`))};` +
        " want once, inside backupStatus()",
    );
  }
  return out;
}

/** Every non-test .ts/.tsx under `root`, path relative with `/`. */
function componentSources(root: string): Source[] {
  const out: Source[] = [];
  for (const file of readdirSync(root, { encoding: "utf8", recursive: true })) {
    const path = file.replaceAll("\\", "/");
    if (!/\.tsx?$/.test(path) || /\.(?:test|spec)\.tsx?$/.test(path)) continue;
    if (path.split("/").includes("node_modules")) continue;
    out.push({ path, src: readFileSync(`${root}/${path}`, "utf8") });
  }
  return out;
}

// ---- Fixtures: the scanners themselves must be able to fail -----------------

/** Applies each swap (an exact, unique snippet) to `src`. */
function swapped(src: string, swaps: [string, string][]): string {
  for (const [from, to] of swaps) {
    assert.equal(src.split(from).length, 2, `fixture swap: ${from}`);
    src = src.replace(from, to);
  }
  return src;
}

const ruleOf = (violation: string) => violation.split(" ")[0];

/**
 * Asserts that `found` holds a violation matching `expected`, and nothing
 * from any rule outside `rules`.
 */
function assertOnly(
  label: string,
  found: string[],
  rules: string[],
  expected: RegExp,
) {
  const dump = JSON.stringify(found, null, 2);
  assert.ok(
    found.some((v) => expected.test(v)),
    `${label}: expected ${expected}, got ${dump}`,
  );
  assert.deepEqual(
    found.filter((v) => !rules.includes(ruleOf(v))),
    [],
    `${label}: fired outside ${rules.join(", ")}: ${dump}`,
  );
}

interface Mutation {
  label: string;
  swaps: [string, string][];
  rules: string[];
  expected: RegExp;
}

/** A conforming e2ee.ts; it holds two protector sites. */
const TS_FIXTURE = `
import { Capacitor, registerPlugin } from "@capacitor/core";

import { workerProbeResult } from "../rtc/workerProbe";
import {
  capacitorAttachmentUrl,
  capacitorClipboardImageInWebview,
  capacitorCouriersOrphanedRecovery,
  capacitorNativeE2EE,
  iosMediaE2EEReady,
  mediaE2EEPlatformSupported,
} from "./e2eePlatform";
import { protectorSendErrorCopy } from "./e2eeProtectorCopy";
import { errorName } from "./e2eeSendSettle";

// A comment does not count: return Capacitor.getPlatform() === "android";
export function nativeE2EEAvailable(): boolean {
  if (IS_POPOUT_WINDOW || IS_OVERLAY_WINDOW) return false;
  if ((window as { slogaShell?: SlogaShellGlobal }).slogaShell?.e2ee)
    return true;
  return capacitorNativeE2EE(
    Capacitor.isNativePlatform(),
    Capacitor.getPlatform(),
    (name) => Capacitor.isPluginAvailable(name),
  );
}

class ElectronTransport implements NativeTransport {
  readonly nativeBlobTransfer = false;
  readonly clipboardImageInWebview = false;

  attachmentUrl(messageId: string, idx: number): string {
    return "e2ee-att://att/" + messageId + "/" + idx;
  }

  keyPushAvailable(): boolean {
    return true;
  }
}

class CapacitorTransport implements NativeTransport {
  readonly nativeBlobTransfer = true;
  // readonly clipboardImageInWebview = true;
  readonly clipboardImageInWebview = capacitorClipboardImageInWebview(
    Capacitor.getPlatform(),
  );
  #plugin = registerPlugin<E2eeCapacitorPlugin>("E2ee");

  // iOS only. A comment does not count: async subscribeBackupBundleWaiting() {}
  readonly subscribeBackupBundleWaiting = capacitorCouriersOrphanedRecovery(
    Capacitor.getPlatform(),
  )
    ? async (callback: () => void): Promise<() => void> => {
        const handle = await this.#plugin.addListener(
          "backupBundleWaiting",
          () => callback(),
        );
        return () => {
          void handle.remove();
        };
      }
    : undefined;

  async invoke<T>(command: string): Promise<T> {
    try {
      const { json } = await this.#plugin.call({ __cmd: command });
      return JSON.parse(json) as T;
    } catch (error) {
      this.#rethrow(error);
    }
  }

  attachmentUrl(messageId: string, idx: number): string {
    return capacitorAttachmentUrl(Capacitor.getPlatform(), messageId, idx);
  }

  keyPushAvailable(): boolean {
    // iOS only through iosMediaE2EEReady. A comment does not count:
    // return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
    const platform = Capacitor.getPlatform();
    return (
      Capacitor.isNativePlatform() &&
      (platform === "android" ||
        (platform === "ios" &&
          iosMediaE2EEReady({
            capsMediaE2EE: (window as SlogaIosCapsWindow).__slogaIosCaps
              ?.mediaE2EE,
            pluginPresent: Capacitor.isPluginAvailable("E2ee"),
            scriptTransform: typeof RTCRtpScriptTransform !== "undefined",
            probe: workerProbeResult(),
          })))
    );
  }

  async subscribeKeysChanged(
    callback: (event: { group_id: string; epoch: number }) => void,
  ): Promise<() => void> {
    const handle = await this.#plugin.addListener("callKeysChanged", callback);
    return () => {
      void handle.remove();
    };
  }
}

export class E2EEBridge implements E2EEAdapter {
  #backupBundleWaiting: Promise<() => void> | null = null;

  constructor(client: Client) {
    this.#client = client;
    this.#transport = createNativeTransport();
    // this.#watchOrphanedBackup(); in a comment does not count
    this.#watchOrphanedBackup();
  }

  async #onClaimResult(accepted: boolean): Promise<void> {
    if (!accepted) {
      console.error("[e2ee] device claim REJECTED");
      return;
    }
    try {
      await this.#reconcileDevices(this.#client.user!.id);
      await this.#replenish();
    } catch (error) {
      console.error("[e2ee] post-claim housekeeping failed", error);
    }

    if (this.#transport.subscribeBackupBundleWaiting) {
      await this.#courierOrphanedBackup();
    }
  }

  async refreshBackupIfDue(): Promise<void> {
    const selfId = this.#client.user?.id;
    if (!selfId) return;
    const bundle = await this.#invoke<BackupBundle | null>(
      "e2ee_backup_refresh_if_due",
      { userId: selfId },
    );
    if (bundle) await this.#putBackup(bundle);
  }

  #watchOrphanedBackup(): void {
    if (this.#backupBundleWaiting) return;
    if (!this.#transport.subscribeBackupBundleWaiting) return;
    this.#backupBundleWaiting = this.#transport
      .subscribeBackupBundleWaiting(() => {
        void this.#courierOrphanedBackup();
      })
      .catch((error: unknown) => {
        console.error("[e2ee] listener failed:", errorName(error));
        return () => {};
      });
  }

  async #courierOrphanedBackup(): Promise<void> {
    const state = this.status.get("state");
    if (
      !this.#client.user?.id ||
      !state?.enabled ||
      !state.published ||
      this.#claimAccepted !== true
    )
      return;
    try {
      await this.refreshBackupIfDue();
    } catch (error) {
      console.error("[e2ee] orphaned backup upload failed:", errorName(error));
    }
  }

  async sendDm(peerId: string): Promise<void> {
    let verdict: SendModeVerdict;
    try {
      verdict = await this.#invoke<SendModeVerdict>("e2ee_send_mode", {
        peerUserId: peerId,
      });
    } catch (error) {
      throw new E2EESendError(
        protectorSendErrorCopy(error, Capacitor.getPlatform()) ??
          "Encryption status could not be verified. The message was NOT sent.",
        "native",
      );
    }
    const gateError = this.#groupGateError(
      verdict,
      "Encryption status could not be verified. The message was NOT sent.",
    );
    if (gateError) throw gateError;
  }

  async sendGroup(conversationId: string): Promise<void> {
    let mode: SendMode;
    try {
      mode = await this.sendModeNow(conversationId);
    } catch (failure) {
      if (failure) {
        throw new E2EESendError(
          protectorSendErrorCopy(failure, Capacitor.getPlatform()) ??
            "Encryption status could not be verified. Nothing was sent.",
          "native",
        );
      }
      throw failure;
    }
    if (mode === "unknown") {
      throw new E2EESendError(
        "Encryption status could not be verified. Nothing was sent.",
        "native",
      );
    }
  }

  async #prepublishMlsKeyPackages(): Promise<void> {
    // Platform gate first (plan D7).
    if (!this.mediaE2EEPlatformSupported()) return;
    if (!this.#callsEnabled()) return;
    await this.mlsPutKeyPackages(await this.mlsPublishKeyPackages());
  }

  nativeKeyPushAvailable(): boolean {
    return this.#transport.keyPushAvailable();
  }

  mediaE2EEPlatformSupported(): boolean {
    return mediaE2EEPlatformSupported(this.nativeKeyPushAvailable());
  }
}
`;

const TS_FIXTURE_SITES = 2;

const KEY_PUSH_RETURN = `    const platform = Capacitor.getPlatform();
    return (
      Capacitor.isNativePlatform() &&
      (platform === "android" ||
        (platform === "ios" &&
          iosMediaE2EEReady({
            capsMediaE2EE: (window as SlogaIosCapsWindow).__slogaIosCaps
              ?.mediaE2EE,
            pluginPresent: Capacitor.isPluginAvailable("E2ee"),
            scriptTransform: typeof RTCRtpScriptTransform !== "undefined",
            probe: workerProbeResult(),
          })))
    );`;
const CAPS_TERM = `capsMediaE2EE: (window as SlogaIosCapsWindow).__slogaIosCaps
              ?.mediaE2EE,`;
const CLIPBOARD_INIT = `capacitorClipboardImageInWebview(
    Capacitor.getPlatform(),
  )`;
const NATIVE_TAIL = `  return capacitorNativeE2EE(
    Capacitor.isNativePlatform(),
    Capacitor.getPlatform(),
    (name) => Capacitor.isPluginAvailable(name),
  );`;
const BRIDGE_MEDIA_METHOD = `
  mediaE2EEPlatformSupported(): boolean {
    return mediaE2EEPlatformSupported(this.nativeKeyPushAvailable());
  }
`;
const DM_SITE = `    } catch (error) {
      throw new E2EESendError(
        protectorSendErrorCopy(error, Capacitor.getPlatform()) ??
          "Encryption status could not be verified. The message was NOT sent.",`;
const ORPHAN_GATE = `capacitorCouriersOrphanedRecovery(
    Capacitor.getPlatform(),
  )`;
const ORPHAN_MEMBER_SRC = `  readonly subscribeBackupBundleWaiting = capacitorCouriersOrphanedRecovery(
    Capacitor.getPlatform(),
  )
    ? async (callback: () => void): Promise<() => void> => {
        const handle = await this.#plugin.addListener(
          "backupBundleWaiting",
          () => callback(),
        );
        return () => {
          void handle.remove();
        };
      }
    : undefined;
`;
const ORPHAN_METHOD_SRC = `  async subscribeBackupBundleWaiting(
    callback: () => void,
  ): Promise<() => void> {
    const handle = await this.#plugin.addListener(
      "backupBundleWaiting",
      () => callback(),
    );
    return () => {
      void handle.remove();
    };
  }
`;
const CLAIM_COURIER = `
    if (this.#transport.subscribeBackupBundleWaiting) {
      await this.#courierOrphanedBackup();
    }
`;
const CLAIM_BEFORE = `    }
    if (this.#transport.subscribeBackupBundleWaiting) {
      await this.#courierOrphanedBackup();
    }
    try {
      await this.#reconcileDevices(`;
const COURIER_GUARD = `    if (
      !this.#client.user?.id ||
      !state?.enabled ||
      !state.published ||
      this.#claimAccepted !== true
    )
      return;
`;
const COURIER_LOG =
  '      console.error("[e2ee] orphaned backup upload failed:", errorName(error));\n';
const COURIER_TRY = `    try {
      await this.refreshBackupIfDue();
    } catch (error) {
${COURIER_LOG}    }
`;

const TS_MUTATIONS: Mutation[] = [
  {
    label: "the file does not lex to balanced braces",
    swaps: [
      [
        "this.nativeKeyPushAvailable());\n  }\n}\n",
        "this.nativeKeyPushAvailable());\n  }\n}\n\nconst broken = {\n",
      ],
    ],
    rules: ["G0"],
    expected: /G0 e2ee\.ts does not lex/,
  },
  {
    label: "CapacitorTransport split per platform",
    swaps: [
      [
        "export class E2EEBridge",
        "class CapacitorIosTransport extends CapacitorTransport {}\n\n" +
          "export class E2EEBridge",
      ],
    ],
    rules: ["G1"],
    expected: /CapacitorIosTransport/,
  },
  {
    label: "CapacitorTransport renamed",
    swaps: [["class CapacitorTransport", "class CapacitorAndroidTransport"]],
    rules: ["G1"],
    expected: /0 `class CapacitorTransport`/,
  },
  {
    label: "nativeBlobTransfer computed per platform",
    swaps: [
      [
        "readonly nativeBlobTransfer = true;",
        'readonly nativeBlobTransfer = Capacitor.getPlatform() === "android";',
      ],
    ],
    rules: ["G2"],
    expected: /want readonly nativeBlobTransfer = true/,
  },
  {
    label: "keyPushAvailable widened to every native platform",
    swaps: [['(platform === "android" ||', '(platform !== "web" ||']],
    rules: ["G3"],
    expected: /keyPushAvailable\(\) is/,
  },
  {
    label: "the phase-1 android-only body (7de02a68)",
    swaps: [
      [
        KEY_PUSH_RETURN,
        "    return (\n" +
          '      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android"\n' +
          "    );",
      ],
    ],
    rules: ["G3"],
    expected: /iosMediaE2EEReady\( called 0 times in keyPushAvailable/,
  },
  {
    label: "iOS armed on the platform alone (the ready check bypassed)",
    swaps: [['(platform === "ios" &&', '(platform === "ios" ||']],
    rules: ["G3"],
    expected: /keyPushAvailable\(\) is .*android, or iOS only when/,
  },
  {
    label: "the ready check on every native platform (the iOS term dropped)",
    swaps: [['(platform === "ios" &&\n          ', "(\n          "]],
    rules: ["G3"],
    expected: /keyPushAvailable\(\) is/,
  },
  {
    label: "flag ignored (the caps term hard-coded true)",
    swaps: [[CAPS_TERM, "capsMediaE2EE: true,"]],
    rules: ["G3"],
    expected: /capsMediaE2EE is `true`.*caps flag ignored/,
  },
  {
    label: "flag read off the plugin instead of the caps global",
    swaps: [[CAPS_TERM, 'capsMediaE2EE: Capacitor.isPluginAvailable("E2ee"),']],
    rules: ["G3"],
    expected: /capsMediaE2EE is `Capacitor\.isPluginAvailable/,
  },
  {
    label: "plugin dropped",
    swaps: [
      [
        'pluginPresent: Capacitor.isPluginAvailable("E2ee"),',
        "pluginPresent: true,",
      ],
    ],
    rules: ["G3"],
    expected: /pluginPresent is `true`.*plugin dropped/,
  },
  {
    label: "plugin asked under another name",
    swaps: [['isPluginAvailable("E2ee"),\n', 'isPluginAvailable("e2ee"),\n']],
    rules: ["G3"],
    expected: /pluginPresent is `Capacitor\.isPluginAvailable\("e2ee"\)`/,
  },
  {
    label: "script transform dropped",
    swaps: [
      [
        'scriptTransform: typeof RTCRtpScriptTransform !== "undefined",',
        "scriptTransform: true,",
      ],
    ],
    rules: ["G3"],
    expected: /scriptTransform is `true`/,
  },
  {
    label: "probe dropped",
    swaps: [["probe: workerProbeResult(),", 'probe: "pass",']],
    rules: ["G3"],
    expected: /probe is `"pass"`.*the D8 probe dropped/,
  },
  {
    label: "a pending probe read as a pass",
    swaps: [
      [
        "probe: workerProbeResult(),",
        'probe: workerProbeResult() === "fail" ? "fail" : "pass",',
      ],
    ],
    rules: ["G3"],
    expected: /probe is `workerProbeResult\(\)==="fail"/,
  },
  {
    label: "a term missing from the ready call",
    swaps: [["            probe: workerProbeResult(),\n", ""]],
    rules: ["G3"],
    expected: /probe is `missing`/,
  },
  {
    label: "a second iosMediaE2EEReady caller",
    swaps: [
      [
        "    if (!this.mediaE2EEPlatformSupported()) return;\n",
        "    if (!this.mediaE2EEPlatformSupported()) return;\n" +
          "    if (iosMediaE2EEReady(caps)) return;\n",
      ],
    ],
    rules: ["G3"],
    expected: /called 2 times in e2ee\.ts/,
  },
  {
    label: "the probe answer imported from another module",
    swaps: [['from "../rtc/workerProbe";', 'from "./probeStub";']],
    rules: ["G3"],
    expected: /workerProbeResult is not imported/,
  },
  {
    label: "the probe answer imported under another name",
    swaps: [
      [
        "import { workerProbeResult } from",
        "import { workerProbeResult as probeAnswer } from",
      ],
    ],
    rules: ["G3"],
    expected: /workerProbeResult is not imported/,
  },
  {
    label: "a local probe answer",
    swaps: [
      [
        "class ElectronTransport implements NativeTransport {",
        'const workerProbeResult = () => "pass" as const;\n\n' +
          "class ElectronTransport implements NativeTransport {",
      ],
    ],
    rules: ["G3"],
    expected: /defines workerProbeResult itself/,
  },
  {
    label: "the iOS ready rule no longer imported",
    swaps: [["  iosMediaE2EEReady,\n", ""]],
    rules: ["G9"],
    expected: /iosMediaE2EEReady is not imported/,
  },
  {
    label: "a local copy of the iOS ready rule",
    swaps: [
      [
        "class ElectronTransport implements NativeTransport {",
        "function iosMediaE2EEReady(): boolean {\n  return true;\n}\n\n" +
          "class ElectronTransport implements NativeTransport {",
      ],
    ],
    rules: ["G9"],
    expected: /defines iosMediaE2EEReady itself/,
  },
  {
    label: "keyPushAvailable returns true, the old body left in a comment",
    swaps: [
      [
        KEY_PUSH_RETURN,
        "    // " +
          KEY_PUSH_RETURN.trim().replaceAll("\n", "\n    // ") +
          "\n    return true;",
      ],
    ],
    rules: ["G3"],
    expected: /is `returntrue;`/,
  },
  {
    label: "a second keyPushAvailable member",
    swaps: [
      [
        "  attachmentUrl(messageId: string, idx: number): string {\n" +
          "    return capacitorAttachmentUrl",
        "  keyPushAvailable = () => true;\n\n" +
          "  attachmentUrl(messageId: string, idx: number): string {\n" +
          "    return capacitorAttachmentUrl",
      ],
    ],
    rules: ["G3"],
    expected: /2 top-level `keyPushAvailable` members/,
  },
  {
    label: "clipboardImageInWebview hard-coded true (the 8821aac9 value)",
    swaps: [[CLIPBOARD_INIT, "true"]],
    rules: ["G4"],
    expected: /clipboardImageInWebview=true/,
  },
  {
    label: "clipboardImageInWebview asked for a fixed platform",
    swaps: [[CLIPBOARD_INIT, 'capacitorClipboardImageInWebview("android")']],
    rules: ["G4"],
    expected: /want `readonlyclipboardImageInWebview/,
  },
  {
    label: "attachmentUrl hard-codes the Android path (the 8821aac9 body)",
    swaps: [
      [
        "return capacitorAttachmentUrl(Capacitor.getPlatform(), messageId, idx);",
        'return "/_e2ee-att/" + messageId + "/" + idx;',
      ],
    ],
    rules: ["G5"],
    expected: /hard-coded e2ee-att URL/,
  },
  {
    label: "attachmentUrl asked for a fixed platform",
    swaps: [
      [
        "capacitorAttachmentUrl(Capacitor.getPlatform(), messageId, idx)",
        'capacitorAttachmentUrl("android", messageId, idx)',
      ],
    ],
    rules: ["G5"],
    expected: /attachmentUrl\(\) is/,
  },
  {
    label: "an e2ee-att literal elsewhere in the class",
    swaps: [
      [
        '  #plugin = registerPlugin<E2eeCapacitorPlugin>("E2ee");\n',
        '  #plugin = registerPlugin<E2eeCapacitorPlugin>("E2ee");\n' +
          '  #base = "/_e2ee-att/";\n',
      ],
    ],
    rules: ["G5"],
    expected: /hard-coded e2ee-att URL/,
  },
  {
    label: "nativeE2EEAvailable keeps the Android-only return (8821aac9)",
    swaps: [
      [
        NATIVE_TAIL,
        '  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";',
      ],
    ],
    rules: ["G6"],
    expected: /does not end with return capacitorNativeE2EE/,
  },
  {
    label: "the plugin probe stubbed to true",
    swaps: [["(name) => Capacitor.isPluginAvailable(name),", "() => true,"]],
    rules: ["G6"],
    expected: /does not end with return/,
  },
  {
    label: "an iOS short-circuit before the shared rule",
    swaps: [
      [
        NATIVE_TAIL,
        '  if (Capacitor.getPlatform() === "ios") return true;\n' + NATIVE_TAIL,
      ],
    ],
    rules: ["G6"],
    expected: /compares Capacitor\.getPlatform\(\) itself/,
  },
  {
    label: "the prepublish platform gate removed (8821aac9)",
    swaps: [["    if (!this.mediaE2EEPlatformSupported()) return;\n", ""]],
    rules: ["G7"],
    expected: /does not start with/,
  },
  {
    label: "the prepublish platform gate after the calls toggle",
    swaps: [
      [
        "    if (!this.mediaE2EEPlatformSupported()) return;\n" +
          "    if (!this.#callsEnabled()) return;\n",
        "    if (!this.#callsEnabled()) return;\n" +
          "    if (!this.mediaE2EEPlatformSupported()) return;\n",
      ],
    ],
    rules: ["G7"],
    expected: /does not start with/,
  },
  {
    label: "the prepublish platform gate only in a comment",
    swaps: [
      [
        "    if (!this.mediaE2EEPlatformSupported()) return;\n",
        "    // if (!this.mediaE2EEPlatformSupported()) return;\n",
      ],
    ],
    rules: ["G7"],
    expected: /does not start with/,
  },
  {
    label: "the prepublish gated on key push alone (MINOR 17)",
    swaps: [
      [
        "if (!this.mediaE2EEPlatformSupported()) return;",
        "if (!this.nativeKeyPushAvailable()) return;",
      ],
    ],
    rules: ["G7"],
    expected: /does not start with/,
  },
  {
    label: "the calls toggle dropped from the prepublish",
    swaps: [["    if (!this.#callsEnabled()) return;\n", ""]],
    rules: ["G7"],
    expected: /lost if \(!this\.#callsEnabled/,
  },
  {
    label: "the bridge predicate reads key push alone",
    swaps: [
      [
        "return mediaE2EEPlatformSupported(this.nativeKeyPushAvailable());",
        "return this.nativeKeyPushAvailable();",
      ],
    ],
    rules: ["G8"],
    expected: /mediaE2EEPlatformSupported\(\) is/,
  },
  {
    label: "the bridge predicate passes a constant",
    swaps: [
      [
        "mediaE2EEPlatformSupported(this.nativeKeyPushAvailable());",
        "mediaE2EEPlatformSupported(true);",
      ],
    ],
    rules: ["G8"],
    expected: /mediaE2EEPlatformSupported\(\) is/,
  },
  {
    label: "the bridge key push no longer asks the transport",
    swaps: [["return this.#transport.keyPushAvailable();", "return true;"]],
    rules: ["G8"],
    expected: /nativeKeyPushAvailable\(\) is/,
  },
  {
    label: "the bridge predicate missing (8821aac9)",
    swaps: [[BRIDGE_MEDIA_METHOD, ""]],
    rules: ["G8"],
    expected: /0 top-level `mediaE2EEPlatformSupported` members/,
  },
  {
    label: "the media predicate no longer imported",
    swaps: [
      [
        '  mediaE2EEPlatformSupported,\n} from "./e2eePlatform";',
        '} from "./e2eePlatform";',
      ],
    ],
    rules: ["G9"],
    expected: /mediaE2EEPlatformSupported is not imported/,
  },
  {
    label: "the media predicate imported under another name",
    swaps: [
      [
        '  mediaE2EEPlatformSupported,\n} from "./e2eePlatform";',
        '  mediaE2EEPlatformSupported as mediaGate,\n} from "./e2eePlatform";',
      ],
    ],
    rules: ["G9"],
    expected: /mediaE2EEPlatformSupported is not imported/,
  },
  {
    label: "a local copy of a platform rule",
    swaps: [
      [
        "class ElectronTransport implements NativeTransport {",
        "function platformMediaE2EESupported(): boolean {\n  return true;\n}\n\n" +
          "class ElectronTransport implements NativeTransport {",
      ],
    ],
    rules: ["G9"],
    expected: /defines platformMediaE2EESupported itself/,
  },
  {
    label: "a catch that binds nothing (the 8821aac9 shape)",
    swaps: [
      [
        DM_SITE,
        "    } catch {\n      throw new E2EESendError(\n" +
          '        "Encryption status could not be verified. The message was NOT sent.",',
      ],
    ],
    rules: ["F1"],
    expected: /binds no error/,
  },
  {
    label: "the protector copy reads something other than the caught error",
    swaps: [
      [
        "protectorSendErrorCopy(failure, Capacitor.getPlatform())",
        "protectorSendErrorCopy(this.#lastError, Capacitor.getPlatform())",
      ],
    ],
    rules: ["F1"],
    expected: /want protectorSendErrorCopy\(failure/,
  },
  {
    label: "the protector copy asked for a fixed platform",
    swaps: [
      [
        "protectorSendErrorCopy(error, Capacitor.getPlatform())",
        'protectorSendErrorCopy(error, "ios")',
      ],
    ],
    rules: ["F1"],
    expected: /want protectorSendErrorCopy\(error/,
  },
  {
    label: "the old text tried first",
    swaps: [
      [
        "        protectorSendErrorCopy(error, Capacitor.getPlatform()) ??\n" +
          '          "Encryption status could not be verified. The message was NOT sent.",',
        '        "Encryption status could not be verified. The message was NOT sent." ||\n' +
          "          protectorSendErrorCopy(error, Capacitor.getPlatform()),",
      ],
    ],
    rules: ["F1"],
    expected: /want protectorSendErrorCopy/,
  },
  {
    label: "the fallback text changed",
    swaps: [
      [
        '            "Encryption status could not be verified. Nothing was sent.",',
        '            "Encryption status could not be verified. Try again.",',
      ],
    ],
    rules: ["F1"],
    expected: /the existing text/,
  },
  {
    label: "the kind changed",
    swaps: [
      [
        '          "native",\n        );\n      }\n      throw failure;',
        '          "transport",\n        );\n      }\n      throw failure;',
      ],
    ],
    rules: ["F1"],
    expected: /kind is \["\\"transport\\""\]/,
  },
  {
    label: "a site moved out of its catch",
    swaps: [
      [
        "    } catch (failure) {\n      if (failure) {",
        "    } catch (failure) {\n      void failure;\n    }\n    {\n      if (failure) {",
      ],
    ],
    rules: ["F2"],
    expected: /1 unverifiable-status E2EESendError sites in a catch, want 2/,
  },
  {
    label: "a new unwired site",
    swaps: [
      [
        "    if (gateError) throw gateError;\n",
        "    if (gateError) throw gateError;\n    try {\n      await this.#recheck();\n" +
          "    } catch (again) {\n      throw new E2EESendError(\n" +
          '        "Encryption status could not be verified. Nothing was sent.",\n' +
          '        "native",\n      );\n    }\n',
      ],
    ],
    rules: ["F1", "F2"],
    expected: /F1 .*want protectorSendErrorCopy\(again/,
  },
  {
    label: "the orphan predicate no longer imported",
    swaps: [["  capacitorCouriersOrphanedRecovery,\n", ""]],
    rules: ["G9"],
    expected: /capacitorCouriersOrphanedRecovery is not imported/,
  },
  {
    label: "the bundle listener a plain method, so on every platform",
    swaps: [[ORPHAN_MEMBER_SRC, ORPHAN_METHOD_SRC]],
    rules: ["R1"],
    expected: /subscribeBackupBundleWaiting is `a method`/,
  },
  {
    label: "the bundle listener gated on a fixed platform",
    swaps: [[ORPHAN_GATE, 'capacitorCouriersOrphanedRecovery("ios")']],
    rules: ["R1"],
    expected: /R1 .*absent off iOS/,
  },
  {
    label: "the bundle listener gated on any native platform (Android too)",
    swaps: [[ORPHAN_GATE, "Capacitor.isNativePlatform()"]],
    rules: ["R1"],
    expected: /R1 .*absent off iOS/,
  },
  {
    label: "the bundle listener gate negated",
    swaps: [
      [
        "= capacitorCouriersOrphanedRecovery(",
        "= !capacitorCouriersOrphanedRecovery(",
      ],
    ],
    rules: ["R1"],
    expected: /R1 .*absent off iOS/,
  },
  {
    label: "a no-op listener off iOS instead of no member",
    swaps: [["    : undefined;\n", "    : async () => () => {};\n"]],
    rules: ["R1"],
    expected: /R1 .*absent off iOS/,
  },
  {
    label: "the listener on another event name",
    swaps: [['"backupBundleWaiting",', '"backupBundleReady",']],
    rules: ["R2"],
    expected: /0 addListener\("backupBundleWaiting"\) calls/,
  },
  {
    label: "the listener forwards the payload",
    swaps: [["() => callback(),", "(event: unknown) => callback(event),"]],
    rules: ["R2"],
    expected: /payload dropped/,
  },
  {
    label: "the callback handed straight to the plugin",
    swaps: [["() => callback(),", "callback,"]],
    rules: ["R2"],
    expected: /payload dropped/,
  },
  {
    label: "a second listener for the event",
    swaps: [
      [
        "  keyPushAvailable(): boolean {\n    // iOS only",
        "  async alsoWaiting(): Promise<void> {\n" +
          '    await this.#plugin.addListener("backupBundleWaiting", () => {});\n' +
          "  }\n\n  keyPushAvailable(): boolean {\n    // iOS only",
      ],
    ],
    rules: ["R2"],
    expected: /2 addListener\("backupBundleWaiting"\) calls/,
  },
  {
    label: "the bridge never subscribes (constructor call removed)",
    swaps: [["    this.#watchOrphanedBackup();\n", ""]],
    rules: ["R3"],
    expected: /#watchOrphanedBackup\( called 0 times/,
  },
  {
    label: "the bridge subscribes on every connect",
    swaps: [
      [
        "    this.#watchOrphanedBackup();\n",
        '    client.on("ready", () => this.#watchOrphanedBackup());\n',
      ],
    ],
    rules: ["R3"],
    expected: /once, as a statement of the E2EEBridge constructor/,
  },
  {
    label: "the once-guard dropped",
    swaps: [["    if (this.#backupBundleWaiting) return;\n", ""]],
    rules: ["R3"],
    expected: /does not start with if \(this\.#backupBundleWaiting\)/,
  },
  {
    label: "the subscription not held",
    swaps: [
      [
        "    this.#backupBundleWaiting = this.#transport\n",
        "    void this.#transport\n",
      ],
    ],
    rules: ["R3"],
    expected: /does not hold the subscription/,
  },
  {
    label: "the subscription outside #watchOrphanedBackup",
    swaps: [
      [
        "    if (this.#backupBundleWaiting) return;\n" +
          "    if (!this.#transport.subscribeBackupBundleWaiting) return;\n",
        "    if (this.#backupBundleWaiting) return;\n  }\n\n" +
          "  #listenLater(): void {\n" +
          "    if (!this.#transport.subscribeBackupBundleWaiting) return;\n",
      ],
    ],
    rules: ["R3"],
    expected: /the subscription is not in #watchOrphanedBackup/,
  },
  {
    label: "the event callback takes the payload",
    swaps: [
      [
        ".subscribeBackupBundleWaiting(() => {",
        ".subscribeBackupBundleWaiting((payload) => {",
      ],
    ],
    rules: ["R3"],
    expected: /\(no payload\)/,
  },
  {
    label: "the post-claim courier removed",
    swaps: [[CLAIM_COURIER, ""]],
    rules: ["R4", "R5"],
    expected: /R4 .*does not end with/,
  },
  {
    label: "the post-claim courier on every platform",
    swaps: [[CLAIM_COURIER, "\n    await this.#courierOrphanedBackup();\n"]],
    rules: ["R4"],
    expected: /R4 .*does not end with/,
  },
  {
    label: "the post-claim courier before the housekeeping",
    swaps: [
      [CLAIM_COURIER, "\n"],
      ["    }\n    try {\n      await this.#reconcileDevices(", CLAIM_BEFORE],
    ],
    rules: ["R4"],
    expected: /R4 .*does not end with/,
  },
  {
    label: "the post-claim courier inside the housekeeping try",
    swaps: [
      [CLAIM_COURIER, "\n"],
      [
        "      await this.#replenish();\n",
        "      await this.#replenish();\n" +
          "      if (this.#transport.subscribeBackupBundleWaiting) {\n" +
          "        await this.#courierOrphanedBackup();\n      }\n",
      ],
    ],
    rules: ["R4"],
    expected: /R4 .*does not end with/,
  },
  {
    label: "the post-claim courier on the rejected path",
    swaps: [
      [CLAIM_COURIER, "\n"],
      [
        '      console.error("[e2ee] device claim REJECTED");\n',
        '      console.error("[e2ee] device claim REJECTED");\n' +
          "      await this.#courierOrphanedBackup();\n",
      ],
    ],
    rules: ["R4"],
    expected: /R4 .*does not end with/,
  },
  {
    label: "a third courier call, on connect",
    swaps: [
      [
        "    this.#watchOrphanedBackup();\n",
        "    this.#watchOrphanedBackup();\n" +
          "    void this.#courierOrphanedBackup();\n",
      ],
    ],
    rules: ["R5"],
    expected: /called 3 times, want 2/,
  },
  {
    label: "the courier guard dropped",
    swaps: [[COURIER_GUARD, ""]],
    rules: ["R6"],
    expected: /R6 .*#courierOrphanedBackup is/,
  },
  {
    label: "the courier guard does not require published",
    swaps: [["      !state.published ||\n", ""]],
    rules: ["R6"],
    expected: /the guard does not check published/,
  },
  {
    label: "the courier does not wait for the accepted claim",
    swaps: [[" ||\n      this.#claimAccepted !== true\n", "\n"]],
    rules: ["R6"],
    expected: /the guard does not check the accepted claim/,
  },
  {
    label: "the courier lets a claim that has not landed (null) through",
    swaps: [
      ["this.#claimAccepted !== true\n", "this.#claimAccepted === false\n"],
    ],
    rules: ["R6"],
    expected: /the guard does not check the accepted claim/,
  },
  {
    label: "the courier guard does not require enabled",
    swaps: [["      !state?.enabled ||\n", "      !state ||\n"]],
    rules: ["R6"],
    expected: /the guard does not check enabled/,
  },
  {
    label: "the courier guard does not require a signed-in user",
    swaps: [["      !this.#client.user?.id ||\n", ""]],
    rules: ["R6"],
    expected: /the guard does not check user/,
  },
  {
    label: "the courier asks native before the guard",
    swaps: [
      [COURIER_GUARD, ""],
      [
        "    }\n  }\n\n  async sendDm(",
        "    }\n" + COURIER_GUARD + "  }\n\n  async sendDm(",
      ],
    ],
    rules: ["R6"],
    expected: /R6 .*#courierOrphanedBackup is/,
  },
  {
    label: "the courier does not catch",
    swaps: [[COURIER_TRY, "    await this.refreshBackupIfDue();\n"]],
    rules: ["R6"],
    expected: /R6 .*#courierOrphanedBackup is/,
  },
  {
    label: "the courier catch rethrows",
    swaps: [[COURIER_LOG, COURIER_LOG + "      throw error;\n"]],
    rules: ["R6"],
    expected: /the catch throws/,
  },
  {
    label: "the courier catch logs the raw error",
    swaps: [
      [
        COURIER_LOG,
        '      console.error("[e2ee] orphaned backup upload failed:", error);\n',
      ],
    ],
    rules: ["R6"],
    expected: /the catch does not log errorName\(error\)/,
  },
  {
    label: "a second refreshBackupIfDue caller",
    swaps: [
      [
        "    this.#watchOrphanedBackup();\n",
        "    this.#watchOrphanedBackup();\n    void this.refreshBackupIfDue();\n",
      ],
    ],
    rules: ["R7"],
    expected: /refreshBackupIfDue\( called 2 times/,
  },
  {
    label: "the refresh command sent outside refreshBackupIfDue",
    swaps: [
      [
        "    this.#watchOrphanedBackup();\n",
        "    this.#watchOrphanedBackup();\n" +
          '    void this.#invoke("e2ee_backup_refresh_if_due", {});\n',
      ],
    ],
    rules: ["R7"],
    expected: /"e2ee_backup_refresh_if_due" appears 2 times/,
  },
];

/** A conforming rtc/state.tsx excerpt, in the contract shape (C-W3-8, R21). */
const STATE_FIXTURE = `
import { Capacitor } from "@capacitor/core";
import { isE2EESupported } from "livekit-client";

import { nativeE2EEAvailable, type E2EEBridge } from "../client/e2ee";
import { shellMediaE2EESupported } from "../client/e2eePlatform";

export { platformMediaE2EESupported } from "../client/e2eePlatform";

import { fetchIosCallSwitchValue, iosCallSwitch } from "./iosCallSwitch";

class Voice {
  async #connect() {
    const iosSwitchFetch = IOS_WEBKIT
      ? fetchIosCallSwitchValue({
          fetchRoot: () => this.getClient().api.get("/"),
          setTimeout,
          clearTimeout,
        })
      : undefined;
    let iosSwitchValue: unknown;
    if (iosSwitchFetch) {
      iosSwitchValue = await iosSwitchFetch;
    }
    const bridge = this.getClient()?.e2ee as E2EEBridge | undefined;
    bridge?.setCallsEnabled(() => this.#settings.e2eeCallsEnabled);
    const shellSupported =
      // isE2EESupported() && nativeE2EEAvailable() && in a comment does not count
      shellMediaE2EESupported({
        e2eeSupported: isE2EESupported(),
        nativeE2EEAvailable: nativeE2EEAvailable(),
        bridgePlatformSupported: !!bridge?.mediaE2EEPlatformSupported(),
      }) &&
      this.#settings.e2eeCallsEnabled;
    // callMediaE2EEOffered(shellSupported, sw) in a comment does not count
    const readiness = callEncryptionReadiness({
      shellSupported,
      status: bridge?.status.get("state"),
      deviceOwnedElsewhere: false,
      pausedByServer:
        iosCallSwitch({
          platform: Capacitor.getPlatform(),
          serverValue: iosSwitchValue,
        }) === "off",
    });
    return <Chip>{shellSupported ? "on" : <Trans>Calls aren't encrypted</Trans>}</Chip>;
  }

  get readiness() {
    return this.callEncryptionReadiness();
  }
}
`;

const STATE_SHELL_CALL = `      shellMediaE2EESupported({
        e2eeSupported: isE2EESupported(),
        nativeE2EEAvailable: nativeE2EEAvailable(),
        bridgePlatformSupported: !!bridge?.mediaE2EEPlatformSupported(),
      }) &&
`;
const STATE_PAUSED = `      pausedByServer:
        iosCallSwitch({
          platform: Capacitor.getPlatform(),
          serverValue: iosSwitchValue,
        }) === "off",
`;

const STATE_MUTATIONS: Mutation[] = [
  {
    label: "the file does not lex to balanced braces",
    swaps: [
      [
        'export { platformMediaE2EESupported } from "../client/e2eePlatform";\n',
        'export { platformMediaE2EESupported } from "../client/e2eePlatform";\n' +
          "const broken = {\n",
      ],
    ],
    rules: ["C0"],
    expected: /C0 state\.tsx does not lex/,
  },
  {
    label:
      "the inline phase-1 terms, not the shared call (the 7de02a68 shape; the prejoin copy diverges)",
    swaps: [
      [
        STATE_SHELL_CALL,
        "      isE2EESupported() &&\n      nativeE2EEAvailable() &&\n" +
          "      !!bridge?.mediaE2EEPlatformSupported() &&\n",
      ],
    ],
    rules: ["C1"],
    expected: /C1 .*prejoin copy diverges/,
  },
  {
    label: "the two-term shellSupported (8821aac9)",
    swaps: [
      [
        STATE_SHELL_CALL,
        "      !!bridge?.nativeKeyPushAvailable() &&\n" +
          "      platformMediaE2EESupported() &&\n",
      ],
    ],
    rules: ["C1"],
    expected: /C1 .*want \["shellMediaE2EESupported/,
  },
  {
    label: "an own platform term beside the shared call",
    swaps: [
      [
        STATE_SHELL_CALL,
        STATE_SHELL_CALL + "      platformMediaE2EESupported() &&\n",
      ],
    ],
    rules: ["C1"],
    expected: /C1 .*platformMediaE2EESupported\(\)/,
  },
  {
    label:
      "isE2EESupported fed as a constant (the call diverges from the copy)",
    swaps: [["e2eeSupported: isE2EESupported(),", "e2eeSupported: true,"]],
    rules: ["C1"],
    expected: /C1 .*e2eeSupported:true/,
  },
  {
    label: "the bridge term read as key push alone",
    swaps: [
      [
        "bridgePlatformSupported: !!bridge?.mediaE2EEPlatformSupported(),",
        "bridgePlatformSupported: !!bridge?.nativeKeyPushAvailable(),",
      ],
    ],
    rules: ["C1"],
    expected: /C1 .*nativeKeyPushAvailable/,
  },
  {
    label: "a top-level || in shellSupported",
    swaps: [
      [
        "      }) &&\n      this.#settings",
        "      }) ||\n      this.#settings",
      ],
    ],
    rules: ["C1"],
    expected: /top-level \|\|/,
  },
  {
    label: "the toggle dropped",
    swaps: [
      ["      }) &&\n      this.#settings.e2eeCallsEnabled;", "      });"],
    ],
    rules: ["C1"],
    expected:
      /C1 .*shellSupported is \["shellMediaE2EESupported\([^"]*\)"\], want/,
  },
  {
    label: "the shared call only in a comment",
    swaps: [
      [STATE_SHELL_CALL, STATE_SHELL_CALL.replaceAll("      ", "      // ")],
    ],
    rules: ["C1"],
    expected: /C1 .*shellSupported is \["this\.#settings\.e2eeCallsEnabled"\]/,
  },
  {
    label: "the shell predicate imported under another name",
    swaps: [
      [
        'import { shellMediaE2EESupported } from "../client/e2eePlatform";',
        'import { shellMediaE2EESupported as shellGate } from "../client/e2eePlatform";',
      ],
    ],
    rules: ["C3"],
    expected: /C3 shellMediaE2EESupported is not imported/,
  },
  {
    label:
      "the shell predicate imported from a path that does not resolve to it",
    swaps: [
      [
        'import { shellMediaE2EESupported } from "../client/e2eePlatform";',
        'import { shellMediaE2EESupported } from "./e2eePlatform";',
      ],
    ],
    rules: ["C3"],
    expected: /C3 shellMediaE2EESupported is not imported/,
  },
  {
    label: "a local copy of the shell predicate",
    swaps: [
      [
        "class Voice {",
        "function shellMediaE2EESupported(): boolean {\n  return true;\n}\n\n" +
          "class Voice {",
      ],
    ],
    rules: ["C3"],
    expected: /C3 state\.tsx defines shellMediaE2EESupported itself/,
  },
  {
    label: "R21: the switch folded into shellSupported",
    swaps: [
      [
        STATE_SHELL_CALL,
        "      callMediaE2EEOffered(\n" +
          STATE_SHELL_CALL.replace("      }) &&\n", "      }),\n") +
          "        iosCallSwitch({\n" +
          "          platform: Capacitor.getPlatform(),\n" +
          "          serverValue: iosSwitchValue,\n" +
          "        }),\n      ) &&\n",
      ],
    ],
    rules: ["C1", "C4"],
    expected: /C4 state\.tsx names callMediaE2EEOffered/,
  },
  {
    label: "R21: readiness handed the combined offer as shellSupported",
    swaps: [
      [
        "      shellSupported,\n      status:",
        "      shellSupported: callMediaE2EEOffered(\n" +
          "        shellSupported,\n" +
          "        iosCallSwitch({ platform: Capacitor.getPlatform(), serverValue: iosSwitchValue }),\n" +
          "      ),\n      status:",
      ],
    ],
    rules: ["C4"],
    expected: /C4 .*shellSupported is not the shell term itself/,
  },
  {
    label: "R21: pausedByServer dropped (a paused iPhone would read ready)",
    swaps: [[STATE_PAUSED, ""]],
    rules: ["C4"],
    expected: /C4 .*pausedByServer is ``/,
  },
  {
    label: "R21: pausedByServer inverted",
    swaps: [['        }) === "off",', '        }) === "on",']],
    rules: ["C4"],
    expected: /C4 .*pausedByServer is `pausedByServer:/,
  },
  {
    label: "the switch read from client.configuration again (R9)",
    swaps: [
      [
        "          serverValue: iosSwitchValue,\n        }) ===",
        "          serverValue: this.getClient()?.configuration?.features.ios_call_e2ee,\n" +
          "        }) ===",
      ],
    ],
    rules: ["C4", "C5"],
    expected: /C5 .*serverValue is `this\.getClient\(\)\?\.configuration/,
  },
  {
    label: "the server value defaulted with ?? false",
    swaps: [
      [
        "          serverValue: iosSwitchValue,\n        }) ===",
        "          serverValue: iosSwitchValue ?? false,\n        }) ===",
      ],
    ],
    rules: ["C4", "C5"],
    expected: /C5 .*serverValue is `iosSwitchValue\?\?false`/,
  },
  {
    label: "the server value coerced on assignment",
    swaps: [
      [
        "iosSwitchValue = await iosSwitchFetch;",
        "iosSwitchValue = !!(await iosSwitchFetch);",
      ],
    ],
    rules: ["C5"],
    expected: /C5 .*iosSwitchValue is `!!\(awaitiosSwitchFetch\)`/,
  },
  {
    label: "the switch fetched from somewhere other than GET /",
    swaps: [
      [
        'fetchRoot: () => this.getClient().api.get("/"),',
        "fetchRoot: async () => this.getClient().configuration,",
      ],
    ],
    rules: ["C5"],
    expected: /C5 .*fetchRoot is `async\(\)=>/,
  },
  {
    label: "a local platformMediaE2EESupported again (8821aac9)",
    swaps: [
      [
        'export { platformMediaE2EESupported } from "../client/e2eePlatform";',
        "export function platformMediaE2EESupported(): boolean {\n" +
          '  return !("slogaShell" in window);\n}',
      ],
    ],
    rules: ["C2"],
    expected: /defines platformMediaE2EESupported itself/,
  },
  {
    label: "the re-export dropped",
    swaps: [
      [
        'export { platformMediaE2EESupported } from "../client/e2eePlatform";',
        "",
      ],
    ],
    rules: ["C2"],
    expected: /no export \{ platformMediaE2EESupported \}/,
  },
];

/** A conforming useCallPrejoinMode.ts excerpt (fix round F shape). */
const PREJOIN_FIXTURE = `
import { Capacitor } from "@capacitor/core";
import { isE2EESupported } from "livekit-client";
import { createResource } from "solid-js";

import type { E2EEBridge } from "@revolt/client";
import { nativeE2EEAvailable, useClient } from "@revolt/client";
import { shellMediaE2EESupported } from "@revolt/client/e2eePlatform";
import {
  callMediaE2EEOffered,
  fetchIosCallSwitchValue,
  iosCallSwitch,
} from "@revolt/rtc/iosCallSwitch";

export function useCallPrejoinMode(deps: () => unknown) {
  const client = useClient();
  const [resource] = createResource(deps, async (input) => {
    const bridge = client()?.e2ee as E2EEBridge | undefined;
    // platformMediaE2EESupported() && !!bridge?.nativeKeyPushAvailable() in
    // a comment does not count
    const sw = iosCallSwitch({
      platform: Capacitor.getPlatform(),
      serverValue:
        Capacitor.getPlatform() === "ios"
          ? await fetchIosCallSwitchValue({
              fetchRoot: () => client().api.get("/"),
              setTimeout,
              clearTimeout,
            })
          : undefined,
    });
    const wouldEncrypt =
      callMediaE2EEOffered(
        shellMediaE2EESupported({
          e2eeSupported: isE2EESupported(),
          nativeE2EEAvailable: nativeE2EEAvailable(),
          bridgePlatformSupported: !!bridge?.mediaE2EEPlatformSupported(),
        }),
        sw,
      ) &&
      !!bridge?.status.get("state")?.published &&
      input.e2eeCallsEnabled;
    return classify(null, wouldEncrypt);
  });
  return resource;
}
`;

const PREJOIN_SHELL = `        shellMediaE2EESupported({
          e2eeSupported: isE2EESupported(),
          nativeE2EEAvailable: nativeE2EEAvailable(),
          bridgePlatformSupported: !!bridge?.mediaE2EEPlatformSupported(),
        })`;
const PREJOIN_OFFERED = `      callMediaE2EEOffered(
${PREJOIN_SHELL},
        sw,
      ) &&
`;
const PREJOIN_SERVER = `      serverValue:
        Capacitor.getPlatform() === "ios"
          ? await fetchIosCallSwitchValue({
              fetchRoot: () => client().api.get("/"),
              setTimeout,
              clearTimeout,
            })
          : undefined,
`;

/** Each is a "prejoin copy diverges" from state.tsx, or a switch misuse. */
const PREJOIN_MUTATIONS: Mutation[] = [
  {
    label: "the file does not lex to balanced braces",
    swaps: [
      [
        'import { createResource } from "solid-js";\n',
        'import { createResource } from "solid-js";\nconst broken = {\n',
      ],
    ],
    rules: ["P0"],
    expected: /P0 useCallPrejoinMode\.ts does not lex/,
  },
  {
    label:
      "the 7de02a68 second predicate (platform + key push, no isE2EESupported)",
    swaps: [
      [
        PREJOIN_OFFERED,
        "      platformMediaE2EESupported() &&\n" +
          "      !!bridge?.nativeKeyPushAvailable() &&\n",
      ],
    ],
    rules: ["P1", "P3", "P4", "P6"],
    expected: /P3 .*wouldEncrypt starts with `platformMediaE2EESupported\(\)`/,
  },
  {
    label: "isE2EESupported dropped from the copy",
    swaps: [["e2eeSupported: isE2EESupported(),", "e2eeSupported: true,"]],
    rules: ["P3"],
    expected: /P3 .*shell argument is `.*e2eeSupported:true/,
  },
  {
    label: "the native layer dropped from the copy",
    swaps: [
      [
        "nativeE2EEAvailable: nativeE2EEAvailable(),",
        "nativeE2EEAvailable: true,",
      ],
    ],
    rules: ["P3"],
    expected: /P3 .*shell argument is `.*nativeE2EEAvailable:true/,
  },
  {
    label: "the bridge term read as key push alone",
    swaps: [
      [
        "bridgePlatformSupported: !!bridge?.mediaE2EEPlatformSupported(),",
        "bridgePlatformSupported: !!bridge?.nativeKeyPushAvailable(),",
      ],
    ],
    rules: ["P1", "P3"],
    expected: /P3 .*shell argument is `.*nativeKeyPushAvailable/,
  },
  {
    label: "the copy asks the iOS rule itself",
    swaps: [
      [PREJOIN_OFFERED, PREJOIN_OFFERED + "      iosMediaE2EEReady(caps) &&\n"],
    ],
    rules: ["P1", "P4"],
    expected: /P1 .*calls iosMediaE2EEReady\(\) itself/,
  },
  {
    label: "a top-level || in wouldEncrypt",
    swaps: [
      [
        '      !!bridge?.status.get("state")?.published &&\n',
        '      !!bridge?.status.get("state")?.published ||\n',
      ],
    ],
    rules: ["P2"],
    expected: /P2 .*top-level \|\| in wouldEncrypt/,
  },
  {
    label: "the shared call only in a comment",
    swaps: [
      [PREJOIN_OFFERED, PREJOIN_OFFERED.replaceAll("      ", "      // ")],
    ],
    rules: ["P3", "P4", "P6"],
    expected: /P3 .*wouldEncrypt starts with `!!bridge/,
  },
  {
    label: "the switch dropped (the bare shell call, the pre-fix-round shape)",
    swaps: [[PREJOIN_OFFERED, PREJOIN_SHELL.trimStart() + " &&\n"]],
    rules: ["P3", "P6"],
    expected: /P3 .*want `callMediaE2EEOffered\(/,
  },
  {
    label: "the switch applied by hand beside the helper",
    swaps: [[PREJOIN_OFFERED, PREJOIN_OFFERED + '      sw === "on" &&\n']],
    rules: ["P4", "P6"],
    expected: /P6 .*the switch sw is read 1 times outside callMediaE2EEOffered/,
  },
  {
    label: "the switch applied by hand instead of the helper",
    swaps: [
      [
        PREJOIN_OFFERED,
        "      " + PREJOIN_SHELL.trimStart() + ' &&\n      sw === "on" &&\n',
      ],
    ],
    rules: ["P3", "P4", "P6"],
    expected: /P6 .*never calls callMediaE2EEOffered/,
  },
  {
    label: "the switch and shell arguments swapped",
    swaps: [
      [
        PREJOIN_OFFERED,
        `      callMediaE2EEOffered(\n        sw,\n${PREJOIN_SHELL},\n      ) &&\n`,
      ],
    ],
    rules: ["P3", "P6"],
    expected: /P3 .*shell argument is `sw`/,
  },
  {
    label: "the server value coerced with !!",
    swaps: [
      [
        "? await fetchIosCallSwitchValue({",
        "? !!(await fetchIosCallSwitchValue({",
      ],
      [
        "            })\n          : undefined,",
        "            }))\n          : undefined,",
      ],
    ],
    rules: ["P5", "P7"],
    expected: /P7 .*serverValue is `.*!!\(awaitfetchIosCallSwitchValue/,
  },
  {
    label: "the server value coerced with Boolean()",
    swaps: [
      [
        "? await fetchIosCallSwitchValue({",
        "? Boolean(await fetchIosCallSwitchValue({",
      ],
      [
        "            })\n          : undefined,",
        "            }))\n          : undefined,",
      ],
    ],
    rules: ["P5", "P7"],
    expected: /P7 .*serverValue is `.*Boolean\(/,
  },
  {
    label: "the server value defaulted with ?? false",
    swaps: [
      [
        "      serverValue:\n        Capacitor",
        "      serverValue:\n        (Capacitor",
      ],
      ["          : undefined,\n", "          : undefined) ?? false,\n"],
    ],
    rules: ["P5", "P7"],
    expected: /P7 .*serverValue is `.*\?\?false`/,
  },
  {
    label: "the switch read from client.configuration again (R9)",
    swaps: [
      [
        PREJOIN_SERVER,
        "      serverValue: client().configuration?.features.ios_call_e2ee,\n",
      ],
    ],
    rules: ["P5", "P7"],
    expected: /P7 .*serverValue is `client\(\)\.configuration/,
  },
  {
    label: "the switch never fetched (serverValue hard-coded undefined)",
    swaps: [[PREJOIN_SERVER, "      serverValue: undefined,\n"]],
    rules: ["P5"],
    expected:
      /P5 .*sw is `iosCallSwitch\(\{platform:Capacitor\.getPlatform\(\),serverValue:undefined\}\)`/,
  },
  {
    label: "the switch fetched from somewhere other than GET /",
    swaps: [
      [
        'fetchRoot: () => client().api.get("/"),',
        "fetchRoot: async () => client().configuration,",
      ],
    ],
    rules: ["P5", "P7"],
    expected: /P7 .*fetchRoot is `async\(\)=>client\(\)\.configuration`/,
  },
  {
    label: "the switch asked for a fixed platform",
    swaps: [
      [
        "      platform: Capacitor.getPlatform(),\n      serverValue",
        '      platform: "android",\n      serverValue',
      ],
    ],
    rules: ["P5", "P7"],
    expected: /P7 .*iosCallSwitch's platform is `"android"`/,
  },
  {
    label: "the published term dropped",
    swaps: [['      !!bridge?.status.get("state")?.published &&\n', ""]],
    rules: ["P4"],
    expected: /P4 .*device and toggle terms are \["input\.e2eeCallsEnabled"\]/,
  },
  {
    label: "the toggle dropped",
    swaps: [["?.published &&\n      input.e2eeCallsEnabled;", "?.published;"]],
    rules: ["P4"],
    expected: /P4 .*published"\], want/,
  },
  {
    label: "the shell predicate imported under another name",
    swaps: [
      [
        'import { shellMediaE2EESupported } from "@revolt/client/e2eePlatform";',
        'import { shellMediaE2EESupported as shellGate } from "@revolt/client/e2eePlatform";',
      ],
    ],
    rules: ["P1"],
    expected: /P1 shellMediaE2EESupported is not imported/,
  },
  {
    label:
      "the shell predicate imported from a path that does not resolve to it",
    swaps: [
      ['from "@revolt/client/e2eePlatform";', 'from "../client/e2eePlatform";'],
    ],
    rules: ["P1"],
    expected: /P1 shellMediaE2EESupported is not imported/,
  },
  {
    label: "a switch helper imported under another name",
    swaps: [
      ["  callMediaE2EEOffered,\n", "  callMediaE2EEOffered as offered,\n"],
    ],
    rules: ["P1"],
    expected: /P1 callMediaE2EEOffered is not imported/,
  },
  {
    label: "a local copy of the shell predicate",
    swaps: [
      [
        "export function useCallPrejoinMode(",
        "function shellMediaE2EESupported(): boolean {\n  return true;\n}\n\n" +
          "export function useCallPrejoinMode(",
      ],
    ],
    rules: ["P1"],
    expected:
      /P1 useCallPrejoinMode\.ts defines shellMediaE2EESupported itself/,
  },
  {
    label: "isE2EESupported taken from somewhere other than livekit",
    swaps: [
      [
        'import { isE2EESupported } from "livekit-client";',
        'import { isE2EESupported } from "./shim";',
      ],
    ],
    rules: ["P1"],
    expected: /P1 isE2EESupported is not imported/,
  },
];

/** A conforming Settings Encryption.tsx call-row excerpt (fix round F). */
const SETTINGS_FIXTURE = `
import { Capacitor } from "@capacitor/core";
import { createSignal, onMount } from "solid-js";

import { useClient, useE2EE } from "@revolt/client";
import {
  callMediaE2EEOffered,
  fetchIosCallSwitchValue,
  iosCallSwitch,
} from "@revolt/rtc/iosCallSwitch";

function CallEncryptionRow() {
  const e2ee = useE2EE();
  const client = useClient();
  if (!e2ee) return null;
  const mediaCapable = () => e2ee.nativeKeyPushAvailable();
  const platform = Capacitor.getPlatform();
  const [switchRead, setSwitchRead] = createSignal<{ serverValue: unknown }>();
  onMount(() => {
    if (platform !== "ios") return;
    void fetchIosCallSwitchValue({
      fetchRoot: () => client().api.get("/"),
      setTimeout,
      clearTimeout,
    }).then((serverValue) => setSwitchRead({ serverValue }));
  });
  // iosCallSwitch(...) === "on" in a comment does not count
  const offered = () =>
    callMediaE2EEOffered(
      mediaCapable(),
      iosCallSwitch({ platform, serverValue: switchRead()?.serverValue }),
    );
  const pausedByServer = () => mediaCapable() && !offered();
  return <div>{offered() ? <Trans>Always on</Trans> : <Trans>Calls aren't encrypted</Trans>}</div>;
}
`;

const SETTINGS_OFFERED = `    callMediaE2EEOffered(
      mediaCapable(),
      iosCallSwitch({ platform, serverValue: switchRead()?.serverValue }),
    );`;

const SETTINGS_MUTATIONS: Mutation[] = [
  {
    label: "the file does not lex to balanced braces",
    swaps: [
      [
        'import { createSignal, onMount } from "solid-js";\n',
        'import { createSignal, onMount } from "solid-js";\nconst broken = {\n',
      ],
    ],
    rules: ["S0"],
    expected: /S0 Encryption\.tsx does not lex/,
  },
  {
    label: "the switch dropped (offered = capability alone)",
    swaps: [[SETTINGS_OFFERED, "    mediaCapable();"]],
    rules: ["S2", "S4"],
    expected: /S2 Encryption\.tsx never calls callMediaE2EEOffered/,
  },
  {
    label: "the switch compared by hand instead of the helper",
    swaps: [
      [
        SETTINGS_OFFERED,
        "    mediaCapable() &&\n" +
          '    iosCallSwitch({ platform, serverValue: switchRead()?.serverValue }) === "on";',
      ],
    ],
    rules: ["S2"],
    expected: /S2 .*never calls callMediaE2EEOffered/,
  },
  {
    label: "the switch verdict compared beside the helper",
    swaps: [
      [
        "  const pausedByServer = () => mediaCapable() && !offered();",
        "  const pausedByServer = () =>\n" +
          '    iosCallSwitch({ platform, serverValue: switchRead()?.serverValue }) === "off";',
      ],
    ],
    rules: ["S2", "S4"],
    expected: /S2 .*iosCallSwitch\( outside callMediaE2EEOffered/,
  },
  {
    label: "the server value coerced with !!",
    swaps: [
      [
        "serverValue: switchRead()?.serverValue",
        "serverValue: !!switchRead()?.serverValue",
      ],
    ],
    rules: ["S3", "S4"],
    expected: /S3 .*serverValue is `!!switchRead\(\)\?\.serverValue`/,
  },
  {
    label: "the server value defaulted with ?? false",
    swaps: [
      [
        "serverValue: switchRead()?.serverValue",
        "serverValue: switchRead()?.serverValue ?? false",
      ],
    ],
    rules: ["S3", "S4"],
    expected: /S3 .*serverValue is `switchRead\(\)\?\.serverValue\?\?false`/,
  },
  {
    label: "the fetched value coerced at the setter",
    swaps: [
      [
        "setSwitchRead({ serverValue })",
        "setSwitchRead({ serverValue: Boolean(serverValue) })",
      ],
    ],
    rules: ["S3", "S4"],
    expected: /S3 .*serverValue is `Boolean\(serverValue\)`/,
  },
  {
    label: "the switch read from client.configuration again (R9)",
    swaps: [
      [
        "serverValue: switchRead()?.serverValue",
        "serverValue: client().configuration?.features.ios_call_e2ee",
      ],
    ],
    rules: ["S3", "S4"],
    expected: /S3 .*serverValue is `client\(\)\.configuration/,
  },
  {
    label: "the switch never fed by the fetch",
    swaps: [[".then((serverValue) => setSwitchRead({ serverValue }))", ""]],
    rules: ["S4"],
    expected: /S4 .*setSwitchRead\( is called 0 times/,
  },
  {
    label: "the switch fetched from somewhere other than GET /",
    swaps: [
      [
        'fetchRoot: () => client().api.get("/"),',
        "fetchRoot: async () => client().configuration,",
      ],
    ],
    rules: ["S3"],
    expected: /S3 .*fetchRoot is `async\(\)=>client\(\)\.configuration`/,
  },
  {
    label: "the switch asked for a fixed platform",
    swaps: [
      [
        "iosCallSwitch({ platform, serverValue",
        'iosCallSwitch({ platform: "web", serverValue',
      ],
    ],
    rules: ["S3"],
    expected: /S3 .*iosCallSwitch's platform is `"web"`/,
  },
  {
    label: "a switch helper imported under another name",
    swaps: [["  iosCallSwitch,\n} from", "  iosCallSwitch as sw,\n} from"]],
    rules: ["S1"],
    expected: /S1 iosCallSwitch is not imported/,
  },
];

/** A conforming Controller.ts login excerpt. */
const CONTROLLER_FIXTURE = `
import { Capacitor } from "@capacitor/core";
import { detect } from "detect-browser";

export default class ClientController {
  async login(credentials: API.DataLogin, modals: ModalControllerExtended) {
    const browser = detect();
    let friendly_name;
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {
      // A native shell, not a browser.
      friendly_name = "Sloga for iOS";
    } else if (browser) {
      const { name, os } = browser as { name: string; os: string };
      friendly_name = "Sloga for Web (" + name + " on " + os + ")";
    } else {
      friendly_name = "Sloga for Web (Unknown Device)";
    }
    await this.completeLoginResponse(credentials, modals, friendly_name);
  }
}
`;

const IOS_BRANCH = `    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {
      // A native shell, not a browser.
      friendly_name = "Sloga for iOS";
    } else if (browser) {`;

const CONTROLLER_MUTATIONS: Mutation[] = [
  {
    label: "the file does not lex to balanced braces",
    swaps: [
      [
        'import { detect } from "detect-browser";\n',
        'import { detect } from "detect-browser";\nconst broken = {\n',
      ],
    ],
    rules: ["D0"],
    expected: /D0 Controller\.ts does not lex/,
  },
  {
    label: "Capacitor not imported (8821aac9)",
    swaps: [['import { Capacitor } from "@capacitor/core";\n', ""]],
    rules: ["D1"],
    expected: /does not import Capacitor/,
  },
  {
    label: "the iOS name changed to a web name",
    swaps: [['"Sloga for iOS"', '"Sloga for Web (iOS)"']],
    rules: ["D2"],
    expected: /appears 0 times/,
  },
  {
    label: "the name gated on the wrong platform",
    swaps: [
      [
        'Capacitor.getPlatform() === "ios"',
        'Capacitor.getPlatform() === "android"',
      ],
    ],
    rules: ["D3"],
    expected: /not assigned directly under/,
  },
  {
    label: "the name gated on the UA string instead of the native platform",
    swaps: [
      [
        'if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {',
        'if (Capacitor.isNativePlatform() && browser?.os === "iOS") {',
      ],
    ],
    rules: ["D3"],
    expected: /not assigned directly under/,
  },
  {
    label: "the name assigned in a nested block",
    swaps: [
      [
        '      friendly_name = "Sloga for iOS";\n',
        '      if (modals) {\n        friendly_name = "Sloga for iOS";\n      }\n',
      ],
    ],
    rules: ["D3"],
    expected: /not assigned directly under/,
  },
  {
    label: "the UA branch decided first",
    swaps: [
      [
        IOS_BRANCH,
        "    if (browser) {\n      friendly_name = String(browser);\n" +
          '    } else if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios") {\n' +
          '      friendly_name = "Sloga for iOS";\n    } else if (modals) {',
      ],
    ],
    rules: ["D4"],
    expected: /not followed by else if \(browser\)/,
  },
];

/** A conforming components tree: the bridge and the settings card. */
const BACKUP_BRIDGE = `
export class E2EEBridge {
  /** Backup status (\`e2ee_backup_status\` in a comment does not count). */
  async backupStatus(): Promise<BackupStatusView> {
    const local = await this.#invoke<{ exists: boolean }>("e2ee_backup_status");
    return { local };
  }
}
`;

const BACKUP_CARD = `
function EncryptionCard() {
  const e2ee = useE2EE();
  const enabled = () => !!e2ee?.status.get("state")?.enabled;
  return (
    <CategoryButton>
      {enabled() ? <Trans>It's on</Trans> : <Trans>Calls aren't here</Trans>}
    </CategoryButton>
  );
}

function RecoveryBackupCard() {
  const e2ee = useE2EE();
  if (!e2ee) return null;

  const enabled = () => {
    const state = e2ee.status.get("state");
    return !!state?.enabled && !!state?.published;
  };

  const [status, setStatus] = createSignal<BackupStatusView | undefined>();

  async function reload() {
    if (!e2ee || !enabled()) return;
    try {
      setStatus(await e2ee.backupStatus());
    } catch (error) {
      console.error("[e2ee] backup status failed", error);
    }
  }

  onMount(reload);
  return <div>{status()?.exists ? <Trans>Backed up</Trans> : null}</div>;
}
`;

const BRIDGE_PATH = "client/e2ee.ts";
const CARD_PATH = "app/interface/settings/user/Encryption.tsx";

function backupFixture(
  bridgeSwaps: [string, string][],
  cardSwaps: [string, string][],
): Source[] {
  return [
    { path: BRIDGE_PATH, src: swapped(BACKUP_BRIDGE, bridgeSwaps) },
    { path: CARD_PATH, src: swapped(BACKUP_CARD, cardSwaps) },
  ];
}

const BACKUP_MUTATIONS: (Mutation & { bridge?: boolean })[] = [
  {
    label: "the guard no longer tests enabled()",
    swaps: [
      ["    if (!e2ee || !enabled()) return;\n", "    if (!e2ee) return;\n"],
    ],
    rules: ["E3"],
    expected: /does not test !enabled\(\)/,
  },
  {
    label: "the guard only in a comment",
    swaps: [
      [
        "    if (!e2ee || !enabled()) return;\n",
        "    // if (!e2ee || !enabled()) return;\n",
      ],
    ],
    rules: ["E3"],
    expected: /does not start with an if guard/,
  },
  {
    label: "the guard after the call",
    swaps: [
      ["    if (!e2ee || !enabled()) return;\n    try {\n", "    try {\n"],
      [
        '      console.error("[e2ee] backup status failed", error);\n    }\n',
        '      console.error("[e2ee] backup status failed", error);\n    }\n' +
          "    if (!e2ee || !enabled()) return;\n",
      ],
    ],
    rules: ["E3"],
    expected: /does not start with an if guard/,
  },
  {
    label: "the guard does not return",
    swaps: [
      [
        "    if (!e2ee || !enabled()) return;\n",
        '    if (!e2ee || !enabled()) console.warn("off");\n',
      ],
    ],
    rules: ["E3"],
    expected: /does not return/,
  },
  {
    label: "enabled() no longer requires published",
    swaps: [
      [
        "    return !!state?.enabled && !!state?.published;\n",
        "    return !!state?.enabled;\n",
      ],
    ],
    rules: ["E3"],
    expected: /not state\.enabled && state\.published/,
  },
  {
    label: "only a non-enclosing enabled() left in the file",
    swaps: [
      [
        '  const enabled = () => {\n    const state = e2ee.status.get("state");\n' +
          "    return !!state?.enabled && !!state?.published;\n  };\n",
        "",
      ],
    ],
    rules: ["E3"],
    expected: /no enabled\(\) in scope/,
  },
  {
    label: "an unguarded second caller",
    swaps: [
      [
        "  onMount(reload);\n",
        "  onMount(reload);\n  onMount(async () => setStatus(await e2ee.backupStatus()));\n",
      ],
    ],
    rules: ["E3"],
    expected: /does not start with an if guard/,
  },
  {
    label: "a caller by bracket access",
    swaps: [
      [
        "  onMount(reload);\n",
        '  onMount(reload);\n  void e2ee["backupStatus"]();\n',
      ],
    ],
    rules: ["E3"],
    expected: /bracket access/,
  },
  {
    label: "no caller at all",
    swaps: [["      setStatus(await e2ee.backupStatus());\n", ""]],
    rules: ["E3"],
    expected: /no backupStatus\(\) caller found/,
  },
  {
    label: "the command invoked directly from the card",
    swaps: [
      [
        "  onMount(reload);\n",
        '  onMount(reload);\n  void invoke("e2ee_backup_status");\n',
      ],
    ],
    rules: ["E1"],
    expected: /E1 e2ee_backup_status at .*Encryption\.tsx/,
  },
  {
    label: "the command held outside backupStatus()",
    bridge: true,
    swaps: [
      [
        'this.#invoke<{ exists: boolean }>("e2ee_backup_status")',
        "this.#invoke<{ exists: boolean }>(BACKUP)",
      ],
      [
        "export class E2EEBridge {",
        'const BACKUP = "e2ee_backup_status";\n\nexport class E2EEBridge {',
      ],
    ],
    rules: ["E1"],
    expected: /want once, inside backupStatus\(\)/,
  },
  {
    label: "a second backupStatus definition",
    swaps: [
      [
        "function RecoveryBackupCard() {",
        "async function backupStatus() {\n  return null;\n}\n\n" +
          "function RecoveryBackupCard() {",
      ],
    ],
    rules: ["E2"],
    expected: /want one definition in client\/e2ee\.ts/,
  },
  {
    label: "the card does not lex to balanced braces",
    swaps: [
      ["  onMount(reload);\n", "  onMount(reload);\n  const broken = {\n"],
    ],
    rules: ["E0", "E1", "E2", "E3"],
    expected: /E0 .*Encryption\.tsx does not lex/,
  },
];

test("fixture: the conforming e2ee.ts passes", () => {
  assert.deepEqual(tsViolations(TS_FIXTURE, TS_FIXTURE_SITES), []);
});

test("fixture: the conforming state.tsx (the contract shape, R21) passes", () => {
  assert.deepEqual(stateViolations(STATE_FIXTURE), []);
});

test("fixture: the conforming useCallPrejoinMode.ts passes", () => {
  assert.deepEqual(prejoinViolations(PREJOIN_FIXTURE), []);
});

test("fixture: the conforming Settings Encryption.tsx passes", () => {
  assert.deepEqual(settingsViolations(SETTINGS_FIXTURE), []);
});

test("fixture: the state term and the prejoin's shell argument are the same shell call", () => {
  assert.equal(firstTerm(STATE_FIXTURE, "shellSupported"), SHELL_CALL);
  assert.equal(prejoinShellArg(PREJOIN_FIXTURE), SHELL_CALL);
  assert.equal(firstTerm(PREJOIN_FIXTURE, "wouldEncrypt"), PREJOIN_FIRST);
});

test("fixture: the conforming Controller.ts passes", () => {
  assert.deepEqual(controllerViolations(CONTROLLER_FIXTURE), []);
});

test("fixture: the conforming backup_status callers pass", () => {
  assert.deepEqual(backupViolations(backupFixture([], [])), []);
});

for (const { label, swaps, rules, expected } of TS_MUTATIONS) {
  test(`fixture mutation (e2ee.ts): ${label}`, () => {
    assertOnly(
      label,
      tsViolations(swapped(TS_FIXTURE, swaps), TS_FIXTURE_SITES),
      rules,
      expected,
    );
  });
}

for (const { label, swaps, rules, expected } of STATE_MUTATIONS) {
  test(`fixture mutation (state.tsx): ${label}`, () => {
    assertOnly(
      label,
      stateViolations(swapped(STATE_FIXTURE, swaps)),
      rules,
      expected,
    );
  });
}

for (const { label, swaps, rules, expected } of PREJOIN_MUTATIONS) {
  test(`fixture mutation (useCallPrejoinMode.ts): ${label}`, () => {
    assertOnly(
      label,
      prejoinViolations(swapped(PREJOIN_FIXTURE, swaps)),
      rules,
      expected,
    );
  });
}

for (const { label, swaps, rules, expected } of SETTINGS_MUTATIONS) {
  test(`fixture mutation (Settings Encryption.tsx): ${label}`, () => {
    assertOnly(
      label,
      settingsViolations(swapped(SETTINGS_FIXTURE, swaps)),
      rules,
      expected,
    );
  });
}

for (const { label, swaps, rules, expected } of CONTROLLER_MUTATIONS) {
  test(`fixture mutation (Controller.ts): ${label}`, () => {
    assertOnly(
      label,
      controllerViolations(swapped(CONTROLLER_FIXTURE, swaps)),
      rules,
      expected,
    );
  });
}

for (const { label, swaps, rules, expected, bridge } of BACKUP_MUTATIONS) {
  test(`fixture mutation (backup_status): ${label}`, () => {
    const files = bridge ? backupFixture(swaps, []) : backupFixture([], swaps);
    assertOnly(label, backupViolations(files), rules, expected);
  });
}

// ---- F. Behavior: the protector copy never offers a wipe ---------------------

test("protector copy: both tags give non-null copy that never offers wipe, reset, turn off or restore", () => {
  const forbidden =
    /wipe|reset|turn\s*off|disable|restore|recover|back\s*up|delete|erase/i;
  for (const type of ["protector", "protector_locked"]) {
    for (const platform of ["ios", "android", "web", "electron", ""]) {
      const copy = protectorSendErrorCopy({ type }, platform);
      assert.ok(copy, `${type}/${platform}: no copy`);
      assert.doesNotMatch(copy, forbidden, `${type}/${platform}`);
    }
  }
  assert.equal(protectorSendErrorCopy({ type: "storage" }, "ios"), null);
});

// ---- The real sources -------------------------------------------------------

const ruleFilter = (found: string[], rules: string[]) =>
  found.filter((v) => rules.includes(ruleOf(v)));

const realTs = () =>
  tsViolations(readFileSync(TS_FILE, "utf8"), PROTECTOR_SITES);

test("e2ee.ts: CapacitorTransport is one class, moves blobs natively, and its key push is android, or iOS only through iosMediaE2EEReady's four terms", () => {
  assert.deepEqual(ruleFilter(realTs(), ["G1", "G2", "G3"]), []);
});

test("e2ee.ts: the iOS clipboard and attachment URL come from e2eePlatform", () => {
  assert.deepEqual(ruleFilter(realTs(), ["G4", "G5"]), []);
});

test("e2ee.ts: nativeE2EEAvailable leaves Capacitor to capacitorNativeE2EE with the plugin probe", () => {
  assert.deepEqual(ruleFilter(realTs(), ["G6"]), []);
});

test("e2ee.ts: the KeyPackage prepublish is skipped first on a shell without the media predicate", () => {
  assert.deepEqual(ruleFilter(realTs(), ["G7", "G8"]), []);
});

test("e2ee.ts: the platform rules have one source, e2eePlatform", () => {
  assert.deepEqual(ruleFilter(realTs(), ["G9"]), []);
});

test(`e2ee.ts: all ${PROTECTOR_SITES} unverifiable-status catches try the protector copy first`, () => {
  assert.deepEqual(ruleFilter(realTs(), ["F1", "F2"]), []);
});

test("e2ee.ts: CapacitorTransport has the backupBundleWaiting listener only on iOS, and drops its payload", () => {
  assert.deepEqual(ruleFilter(realTs(), ["R1", "R2"]), []);
});

test("e2ee.ts: the bridge uploads an orphaned recovery bundle on the event and after a claim, guarded and best effort", () => {
  assert.deepEqual(ruleFilter(realTs(), ["R3", "R4", "R5", "R6", "R7"]), []);
});

test("e2ee.ts: the whole scan is clean (G0-G9, F1-F2, R1-R7; G0 = it lexed)", () => {
  assert.deepEqual(realTs(), []);
});

const realState = () => stateViolations(readFileSync(STATE_FILE, "utf8"));
const realPrejoin = () => prejoinViolations(readFileSync(PREJOIN_FILE, "utf8"));
const realSettings = () =>
  settingsViolations(readFileSync(SETTINGS_FILE, "utf8"));

test("state.tsx: it lexes, and platformMediaE2EESupported is re-exported from e2eePlatform, not defined (C0, C2)", () => {
  assert.deepEqual(ruleFilter(realState(), ["C0", "C2"]), []);
});

test("useCallPrejoinMode.ts: wouldEncrypt is the one shell predicate with the switch applied through callMediaE2EEOffered, then the device and toggle terms (P0-P4)", () => {
  assert.deepEqual(
    ruleFilter(realPrejoin(), ["P0", "P1", "P2", "P3", "P4"]),
    [],
  );
});

test("useCallPrejoinMode.ts: the server switch is fetched from GET /, applied only through callMediaE2EEOffered, and never coerced (P5-P7)", () => {
  assert.deepEqual(ruleFilter(realPrejoin(), ["P5", "P6", "P7"]), []);
});

test("Settings Encryption.tsx: the call row applies the fetched switch only through callMediaE2EEOffered, never coerced (S0-S4)", () => {
  assert.deepEqual(realSettings(), []);
});

test("Controller.ts: an iOS native login is named Sloga for iOS, decided before the web/UA name", () => {
  assert.deepEqual(
    controllerViolations(readFileSync(CONTROLLER_FILE, "utf8")),
    [],
  );
});

test("components: e2ee_backup_status is reached only behind enabled && published", () => {
  const files = componentSources(COMPONENTS_DIR);
  assert.ok(
    files.length > 50,
    `only ${files.length} sources under ${COMPONENTS_DIR}`,
  );
  assert.deepEqual(backupViolations(files), []);
});

test("iOS: the key push, the KeyPackage prepublish and the prejoin copy all read iosMediaE2EEReady (the D6 chain)", () => {
  // keyPushAvailable() is android, or iOS through iosMediaE2EEReady (G3);
  // the bridge feeds it into the one media predicate (G8, G9); the
  // prepublish is gated on that first (G7); the prejoin copy feeds the same
  // bridge answer to the one shell predicate (P1-P4). On an iOS window that
  // chain arms only for the one ready combination. state.tsx joins the chain
  // in the L3t block below.
  const chain = [
    ...ruleFilter(realTs(), ["G3", "G7", "G8", "G9"]),
    ...realPrejoin(),
  ];
  assert.deepEqual(chain, []);
  assert.deepEqual(iosMatrixFailures(e2eePlatform), []);
});

// ---- L3t: the state.tsx half of the chain -----------------------------------

// L3t: written against the CONTRACT shape (C-W3-8: state.tsx's
// `shellSupported` calls `shellMediaE2EESupported` with exactly the prejoin
// copy's shell inputs, then folds in `this.#settings.e2eeCallsEnabled`; R21:
// the server switch reaches readiness as its own `pausedByServer` input and
// never through `callMediaE2EEOffered`). Written red before L3t landed and
// shown to go green on a scratch copy in the contract shape; green since.
describe("L3t: state.tsx shellSupported calls the one shell predicate; the switch stays a separate readiness input (R21)", () => {
  test("state.tsx: shellSupported is shellMediaE2EESupported(...) && the toggle, imported from e2eePlatform (C1, C3)", () => {
    assert.deepEqual(ruleFilter(realState(), ["C1", "C3"]), []);
  });

  test("state.tsx and the prejoin copy call the shell predicate with the same inputs (prejoin copy diverges)", () => {
    const state = firstTerm(readFileSync(STATE_FILE, "utf8"), "shellSupported");
    const prejoin = prejoinShellArg(readFileSync(PREJOIN_FILE, "utf8"));
    assert.equal(prejoin, SHELL_CALL, "the prejoin copy's shell argument");
    assert.equal(state, prejoin, "state.tsx's first term vs the prejoin copy");
  });

  test("state.tsx: readiness gets the shell term and pausedByServer separately, never callMediaE2EEOffered, and the switch value stays raw (C4, C5; R21)", () => {
    assert.deepEqual(ruleFilter(realState(), ["C4", "C5"]), []);
  });
});

// ---- D14 behaviour: why the switch is a separate, raw input (R21) ----------

test("iOS (D14, R21): a paused switch reads paused with separate inputs, unsupported if folded; absent reads on, and a coerced absent would read off", () => {
  const shellSupported = iosAnswer(e2eePlatform, READY_DEVICE).shellSupported;
  assert.equal(shellSupported, true);
  const off = iosCallSwitch({ platform: "ios", serverValue: false });
  assert.equal(off, "off");
  const readiness = (shell: boolean, paused: boolean) =>
    callEncryptionReadiness({
      shellSupported: shell,
      status: undefined,
      deviceOwnedElsewhere: false,
      pausedByServer: paused,
    });
  // state.tsx (C4): its own copy, the loud paused state.
  assert.equal(readiness(shellSupported, off === "off"), "paused");
  // The prejoin and Settings offer (P3, S2): not offered.
  assert.equal(callMediaE2EEOffered(shellSupported, off), false);
  // Folded into the shell term (what C4 forbids): the forbidden copy.
  assert.equal(
    readiness(callMediaE2EEOffered(shellSupported, off), false),
    "unsupported",
  );
  // Raw (P7, S3, C5): absent or unreachable reads ON ...
  assert.equal(
    iosCallSwitch({ platform: "ios", serverValue: undefined }),
    "on",
  );
  assert.equal(callMediaE2EEOffered(shellSupported, "on"), true);
  // ... and a coerced absent (`!!undefined`, `undefined ?? false`) reads OFF.
  const absent: unknown = undefined;
  for (const coerced of [!!absent, absent ?? false, Boolean(absent)]) {
    assert.equal(
      iosCallSwitch({ platform: "ios", serverValue: coerced }),
      "off",
    );
  }
});

// ---- Settings card behaviour (fix round F6): the card's own logic, run ------

// The Settings call row (`CallEncryptionCard` in Encryption.tsx) cannot load
// under Node (Solid, lingui, the UI kit), and a text pin on its `when=`
// expressions proves shape, not behaviour. So its predicate block (from
// `const mediaCapable =` up to `const onClick =`) is lifted out of the real
// file, type-stripped and run against the real iosCallSwitch.ts with a fake
// Capacitor/bridge/client/Solid, and the card's `<Show when={...}>` tree
// (the outer gate and the description) is walked with those predicates to
// pick the copy the user would see. No file is written.

/** `[open, close]` of the body of `function name(`, masked code, or null. */
function functionBody(m: Masked, name: string): [number, number] | null {
  const hit = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(m.code);
  if (!hit) return null;
  const params = matchClose(m.code, hit.index + hit[0].length - 1);
  const open = m.code.indexOf("{", params);
  return open < 0 ? null : [open, matchClose(m.code, open)];
}

interface ShowNode {
  when: string;
  fallback: [number, number] | null;
  children: [number, number];
}

/** The `<Show when={...} fallback={...}>children</Show>` opening at `at`. */
function showNode(m: Masked, at: number): ShowNode {
  let when = "";
  let fallback: [number, number] | null = null;
  let i = at + "<Show".length;
  for (; i < m.code.length && m.code[i] !== ">"; i++) {
    if (m.code[i] !== "{") continue;
    const close = matchClose(m.code, i);
    const name = wordBefore(m.code, skipBack(m.code, i - 1));
    if (name === "when") when = m.text.slice(i + 1, close);
    else if (name === "fallback") fallback = [i + 1, close];
    i = close;
  }
  const start = i + 1;
  const tags = /<Show\b|<\/Show>/g;
  tags.lastIndex = start;
  let depth = 1;
  for (let hit = tags.exec(m.code); hit; hit = tags.exec(m.code)) {
    depth += hit[0] === "</Show>" ? -1 : 1;
    if (depth === 0) return { when, fallback, children: [start, hit.index] };
  }
  throw new Error(`unclosed <Show> at ${at}`);
}

/** The text the JSX in `[from, to)` renders, choosing each `<Show>` branch. */
function jsxChoice(
  m: Masked,
  from: number,
  to: number,
  ev: (expr: string) => unknown,
): string {
  const i = skipWs(m.code, from);
  if (m.code[i] === "{") {
    return jsxChoice(m, i + 1, matchClose(m.code, i), ev);
  }
  if (m.code.startsWith("<Show", i)) {
    const node = showNode(m, i);
    if (ev(node.when)) return jsxChoice(m, ...node.children, ev);
    return node.fallback ? jsxChoice(m, ...node.fallback, ev) : "";
  }
  if (m.code.startsWith("<Trans>", i)) {
    const end = m.code.indexOf("</Trans>", i);
    return m.text
      .slice(i + "<Trans>".length, end)
      .replace(/\s+/g, " ")
      .trim();
  }
  return m.text.slice(i, to).replace(/\s+/g, " ").trim();
}

interface SettingsCard {
  m: Masked;
  /** The outer `<Show when={...}>` the card returns. */
  gate: ShowNode;
  /** `description={...}`'s content range. */
  description: [number, number];
  build: (env: object) => (expr: string) => unknown;
}

/** The real card from `src`: its predicate block and its `<Show>` tree. */
async function loadSettingsCard(src: string): Promise<SettingsCard> {
  const m = maskTs(src);
  const body = functionBody(m, "CallEncryptionCard");
  assert.ok(body, "function CallEncryptionCard not found");
  const [open, close] = body;
  const at = (re: RegExp) => {
    re.lastIndex = open;
    const hit = re.exec(m.code);
    return hit && hit.index < close ? hit.index : -1;
  };
  const from = at(/\bconst\s+mediaCapable\s*=/g);
  const to = at(/\bconst\s+onClick\s*=/g);
  const ret = at(/\breturn\s*\(\s*<Show\b/g);
  const desc = at(/\bdescription=\{/g);
  assert.ok(
    from > 0 && from < to && to < ret && ret < desc,
    "the card's predicate block (mediaCapable .. onClick), return <Show> and description not found",
  );
  const logic = src.slice(from, stmtStart(m.code, to));
  const js = stripTypeScriptTypes(
    "export function build(env: any) {\n" +
      "  const { Capacitor, e2ee, client, onMount, createSignal, setTimeout," +
      " clearTimeout, callMediaE2EEOffered, fetchIosCallSwitchValue," +
      " iosCallSwitch } = env;\n" +
      `${logic}\n` +
      "  return (expr: string) => eval(expr);\n}\n",
  );
  const { build } = (await import(
    `data:text/javascript,${encodeURIComponent(js)}`
  )) as { build: SettingsCard["build"] };
  const brace = m.code.indexOf("{", desc);
  return {
    m,
    gate: showNode(m, m.code.indexOf("<Show", ret)),
    description: [brace + 1, matchClose(m.code, brace)],
    build,
  };
}

interface CardWorld {
  platform: string;
  capable: boolean;
  enrolled: boolean;
  root: () => Promise<unknown>;
}

/** One rendering of the card: the fake world, then what the user sees. */
function settingsCardRun(card: SettingsCard, o: CardWorld) {
  let value: unknown;
  let fetches = 0;
  const mounts: (() => void)[] = [];
  const ev = card.build({
    Capacitor: { getPlatform: () => o.platform },
    e2ee: {
      nativeKeyPushAvailable: () => o.capable,
      status: {
        get: () => ({ enabled: o.enrolled, published: o.enrolled }),
      },
    },
    client: () => ({
      api: {
        get: (path: string) => {
          fetches++;
          assert.equal(path, "/");
          return o.root();
        },
      },
    }),
    onMount: (f: () => void) => mounts.push(f),
    createSignal: () => [
      () => value,
      (v: unknown) => {
        value = v;
      },
    ],
    // The 3 s bound never fires here: every root below settles or is held.
    setTimeout: () => 0,
    clearTimeout: () => {},
    callMediaE2EEOffered,
    fetchIosCallSwitchValue,
    iosCallSwitch,
  });
  for (const f of mounts) f();
  const shown = () => Boolean(ev(card.gate.when));
  return {
    fetches: () => fetches,
    shown,
    copy: () =>
      shown() ? jsxChoice(card.m, ...card.description, ev) : "(hidden)",
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const rootSays = (v: unknown) => () =>
  Promise.resolve({ features: { ios_call_e2ee: v } });
const CARD_ON = /^Always on\./;
const CARD_PAUSED = /^Encrypted calls on iPhone are paused right now\./;
const CARD_SETUP = /^Set up secure device keys/;
const CARD_UNAVAILABLE = /^Encrypted calls aren't available on this device/;

test("Settings (F6): iOS while the switch is pending -> card hidden (no Always-on flash); shown once GET / answers", async () => {
  const card = await loadSettingsCard(readFileSync(SETTINGS_FILE, "utf8"));
  let answer: (body: unknown) => void = () => {};
  const run = settingsCardRun(card, {
    platform: "ios",
    capable: true,
    enrolled: true,
    root: () => new Promise((resolve) => (answer = resolve)),
  });
  await settle();
  assert.equal(run.fetches(), 1, "the card asks GET / on iOS");
  assert.equal(run.shown(), false, "hidden while the switch is pending");
  assert.equal(run.copy(), "(hidden)");
  answer({ features: { ios_call_e2ee: true } });
  await settle();
  assert.equal(run.shown(), true, "shown once the switch answered");
  assert.match(run.copy(), CARD_ON);
});

test("Settings (F6): iOS capable + switch off -> the paused copy, never setup or Always on", async () => {
  const card = await loadSettingsCard(readFileSync(SETTINGS_FILE, "utf8"));
  const ios = (capable: boolean, enrolled: boolean, sw: boolean) => ({
    platform: "ios",
    capable,
    enrolled,
    root: rootSays(sw),
  });
  const rows: [string, CardWorld, RegExp][] = [
    ["iOS, capable, enrolled, switch off", ios(true, true, false), CARD_PAUSED],
    [
      "iOS, capable, not enrolled, switch off",
      ios(true, false, false),
      CARD_PAUSED,
    ],
    // Controls: every other branch is reachable, so the rows above are a
    // choice the card makes, not the only copy the walk can produce.
    ["iOS, capable, enrolled, switch on", ios(true, true, true), CARD_ON],
    [
      "iOS, capable, not enrolled, switch on",
      ios(true, false, true),
      CARD_SETUP,
    ],
    ["iOS, not capable, switch off", ios(false, true, false), CARD_UNAVAILABLE],
    [
      "Android, capable, enrolled (no switch)",
      { ...ios(true, true, false), platform: "android" },
      CARD_ON,
    ],
  ];
  for (const [label, world, want] of rows) {
    const run = settingsCardRun(card, world);
    await settle();
    assert.equal(run.shown(), true, `${label}: shown`);
    assert.match(run.copy(), want, label);
    assert.equal(
      run.fetches(),
      world.platform === "ios" ? 1 : 0,
      `${label}: GET / asked on iOS only`,
    );
  }
});

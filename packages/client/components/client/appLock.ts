import { type Accessor, batch, createSignal, untrack } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

import {
  type AppLockCode,
  type AppLockSnapshot,
  type AppLockTimeout,
  ABSENT,
  FAIL_CLOSED,
  readCode,
  readSnapshot,
} from "./appLockPolicy";

/**
 * The native `AppLock` plugin (Android `AppLockPlugin.java` and its iOS twin).
 * Every result is typed `unknown` on purpose: nothing the shell sends is
 * trusted until `readSnapshot` or `readCode` has read it.
 */
type AppLockNative = {
  getState(): Promise<unknown>;
  enable(): Promise<unknown>;
  disable(): Promise<unknown>;
  authenticate(options: { auto: boolean }): Promise<unknown>;
  setTimeout(options: { sec: number }): Promise<unknown>;
  setHideNotificationText(options: { hide: boolean }): Promise<unknown>;
  gateShown(): Promise<unknown>;
  reset(): Promise<unknown>;
  addListener(
    event: "lockChanged",
    listener: (payload: unknown) => void,
  ): Promise<unknown>;
};

// Registered exactly like `SlogaBack` in `AndroidBackWorker.tsx`. A shell
// without the plugin rejects every call, which reads as locked below.
const AppLockNative = Capacitor.isNativePlatform()
  ? registerPlugin<AppLockNative>("AppLock")
  : undefined;

/**
 * Whether app lock exists on this device: the Android and iOS apps only.
 * @returns True in the phone apps
 */
export function appLockAvailable(): boolean {
  if (!Capacitor.isNativePlatform()) return false;
  const platform = Capacitor.getPlatform();
  return platform === "android" || platform === "ios";
}

// Fixed for the page load, so the signals below can start from it.
const PHONE = appLockAvailable();

// One set of signals for the whole page, so workers and plain functions can
// read the lock without a component. A phone starts locked and stays locked
// until the shell itself reports `locked: false`.
const [state, setState] = createSignal<AppLockSnapshot>(
  PHONE ? FAIL_CLOSED : ABSENT,
);
const [ready, setReady] = createSignal(!PHONE);
const [pluginOk, setPluginOk] = createSignal(false);
const [epoch, setEpoch] = createSignal(0);

/**
 * Whether the app is locked. On a phone this is true until the plugin says
 * `locked: false`; everywhere else it is always false.
 * @returns The locked flag
 */
export const appLocked: Accessor<boolean> = () => PHONE && state().locked;

/**
 * Whether the first `getState` has settled, either way. True at once off
 * phones.
 * @returns The ready flag
 */
export const appLockReady: Accessor<boolean> = ready;

/**
 * The last snapshot read from the plugin.
 * @returns The snapshot
 */
export const appLockState: Accessor<AppLockSnapshot> = state;

/**
 * Whether the last `getState` returned a well formed answer. False until the
 * first good answer, and always false off phones, where there is no plugin.
 * @returns The plugin health flag
 */
export const appLockPluginOk: Accessor<boolean> = pluginOk;

/**
 * Counts every time the lock screen has to be drawn again: each `lockChanged`
 * that reports locked, and each return to the foreground while still locked.
 * @returns The counter
 */
export const appLockEpoch: Accessor<number> = epoch;

// The one callback waiting for the next unlock, see `whenAppUnlocked`.
let parked: (() => void) | undefined;

/**
 * Runs and drops the parked callback. A throw in it is logged, so it cannot
 * turn a state read into a rejection.
 */
function runParked() {
  const run = parked;
  parked = undefined;
  if (!run) return;

  try {
    run();
  } catch (error) {
    console.error("[applock] parked action failed", error);
  }
}

/**
 * Stores one `getState` outcome. This is the only place `locked` can turn
 * false, and only with a snapshot `readSnapshot` produced from the shell.
 * @param snapshot Snapshot to store
 * @param ok Whether the shell answered with a well formed state
 */
function apply(snapshot: AppLockSnapshot, ok: boolean) {
  const wasLocked = untrack(state).locked;

  batch(() => {
    setState(snapshot);
    setPluginOk(ok);
    setReady(true);
  });

  if (wasLocked && !snapshot.locked) runParked();
}

/**
 * Whether a `getState` answer carries the two fields the lock depends on.
 * Checked here as well as in `readSnapshot` so a bad answer is also counted
 * as a plugin failure.
 * @param raw Answer from the shell
 * @returns True when both flags are booleans
 */
function wellFormed(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as { locked?: unknown; enabled?: unknown };
  return (
    typeof value.locked === "boolean" && typeof value.enabled === "boolean"
  );
}

/**
 * Asks the shell for its state. Never rejects: a call that fails, or an
 * answer that is not a state, reads as locked.
 * @param plugin The native plugin
 * @returns The snapshot and whether the shell really supplied it
 */
async function readNative(
  plugin: AppLockNative,
): Promise<{ snapshot: AppLockSnapshot; ok: boolean }> {
  try {
    const raw = await plugin.getState();
    if (!wellFormed(raw)) return { snapshot: FAIL_CLOSED, ok: false };
    return { snapshot: readSnapshot(raw), ok: true };
  } catch {
    return { snapshot: FAIL_CLOSED, ok: false };
  }
}

// Only the newest `getState` may write the signals. An older answer that
// arrives late could otherwise undo a lock that happened after it was asked.
let refreshSeq = 0;
let latestRefresh: Promise<AppLockSnapshot> = Promise.resolve(FAIL_CLOSED);

// The shell reports `autoDisabled` on one `getState` only and then forgets
// it. It is kept here until app lock is on again, so a later read, or a read
// that was overtaken, cannot lose the notice.
let autoDisabledLatch = false;
// The read that last cleared the latch. A read asked before it cannot set
// the latch again when its answer arrives late.
let latchClearedAt = 0;

/**
 * Reads the state from the shell and stores it. Never rejects; a failed read
 * stores the locked snapshot and clears `appLockPluginOk`. Off phones it
 * resolves the absent snapshot and touches nothing.
 * @returns The snapshot now in `appLockState`
 */
export function refreshAppLock(): Promise<AppLockSnapshot> {
  const plugin = AppLockNative;
  if (!PHONE || !plugin) return Promise.resolve(ABSENT);

  const mine = ++refreshSeq;
  const run = readNative(plugin).then((result) => {
    // Before the check below: an overtaken read has still used up the flag
    if (result.ok && result.snapshot.autoDisabled && mine > latchClearedAt) {
      autoDisabledLatch = true;
    }

    // Overtaken by a newer read: wait for that one instead
    if (mine !== refreshSeq) return latestRefresh;

    // A failed read says nothing about the latch, so it is left alone
    let snapshot = result.snapshot;
    if (result.ok && snapshot.enabled) {
      autoDisabledLatch = false;
      latchClearedAt = mine;
    } else if (result.ok && autoDisabledLatch && !snapshot.autoDisabled) {
      snapshot = { ...snapshot, autoDisabled: true };
    }

    apply(snapshot, result.ok);
    return snapshot;
  });

  latestRefresh = run;
  return run;
}

/**
 * Handles the shell's `lockChanged` event. A lock is taken at once, since
 * that is the safe direction. An unlock is never taken from the event: it is
 * read back through `getState`.
 * @param payload Event payload, `{ locked, enabled }`
 */
function onLockChanged(payload: unknown) {
  const unlocked =
    typeof payload === "object" &&
    payload !== null &&
    (payload as { locked?: unknown }).locked === false;

  if (!unlocked) {
    batch(() => {
      setState((prev) => (prev.locked ? prev : { ...prev, locked: true }));
      setEpoch((n) => n + 1);
    });
  }

  void refreshAppLock();
}

/**
 * Back in the foreground: read the state again, and if the app is still
 * locked ask for the lock screen to be drawn again.
 */
function onVisibilityChange() {
  if (document.visibilityState !== "visible") return;

  void refreshAppLock().then(() => {
    if (untrack(state).locked) setEpoch((n) => n + 1);
  });
}

let started = false;

/**
 * Starts app lock for this page. Safe to call more than once, and does
 * nothing at all off phones.
 *
 * Call it before the first render: it stamps `<html data-applock>` right
 * away so the page is hidden before the first paint, the same reason the
 * overlay window is stamped early in `src/index.tsx`.
 */
export function initAppLock(): void {
  const plugin = AppLockNative;
  if (started || !PHONE || !plugin) return;
  started = true;

  document.documentElement.dataset.applock = "1";
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Listen first, then read: the shell drops events sent before a listener
  // exists. If listening fails the read still runs, so the gate can settle.
  void Promise.resolve()
    .then(() => plugin.addListener("lockChanged", onLockChanged))
    .catch(() => undefined)
    .then(() => refreshAppLock());
}

/**
 * Asks the shell to unlock, then reads the state back. The shell's own
 * `{ unlocked }` answer is not trusted. Never rejects.
 * @param auto True for the prompt the lock screen opens by itself
 * @returns Whether the app is unlocked afterwards
 */
export async function unlockApp(auto: boolean): Promise<boolean> {
  const plugin = AppLockNative;
  if (!PHONE || !plugin) return true;

  try {
    await plugin.authenticate({ auto: auto === true });
  } catch {
    // The read below decides
  }

  const snapshot = await refreshAppLock();
  return !snapshot.locked;
}

/**
 * Runs one settings call and reads the state back whether or not it worked.
 * @param call The plugin call
 * @returns Resolves when done; rejects with an `AppLockCode` string
 */
async function act(call: (plugin: AppLockNative) => Promise<unknown>) {
  const plugin = AppLockNative;
  if (!PHONE || !plugin) return;

  let code: AppLockCode | undefined;
  try {
    await call(plugin);
  } catch (error) {
    code = safeCode(error);
  }

  await refreshAppLock();
  if (code) return Promise.reject<void>(code);
}

/**
 * `readCode`, with any throw of its own reading as `FAILED`.
 * @param error The rejection from the plugin
 * @returns The code
 */
function safeCode(error: unknown): AppLockCode {
  try {
    return readCode(error);
  } catch {
    return "FAILED";
  }
}

/**
 * Turns app lock on. The shell asks for the screen lock first.
 * @returns Resolves when on; rejects with an `AppLockCode` string
 */
export function enableAppLock(): Promise<void> {
  return act((plugin) => plugin.enable());
}

/**
 * Turns app lock off. The shell asks for the screen lock first.
 * @returns Resolves when off; rejects with an `AppLockCode` string
 */
export function disableAppLock(): Promise<void> {
  return act((plugin) => plugin.disable());
}

/**
 * Sets how long the app may be away before it locks.
 * @param sec 0, 60 or 900 seconds
 * @returns Resolves when saved; rejects with an `AppLockCode` string
 */
export function setAppLockTimeout(sec: AppLockTimeout): Promise<void> {
  // A select can hand back "60": the shell wants a plain integer
  const value = Number(sec);
  if (value !== 0 && value !== 60 && value !== 900) {
    const code: AppLockCode = "FAILED";
    return PHONE ? Promise.reject<void>(code) : Promise.resolve();
  }

  return act((plugin) => plugin.setTimeout({ sec: value }));
}

/**
 * Sets whether notifications hide the message text (Android).
 * @param hide True to hide the text
 * @returns Resolves when saved; rejects with an `AppLockCode` string
 */
export function setAppLockHideText(hide: boolean): Promise<void> {
  return act((plugin) =>
    plugin.setHideNotificationText({ hide: hide === true }),
  );
}

/**
 * Tells the shell the web lock screen (or the sign-in page) is painted, so it
 * can lift its own cover. Never throws and never rejects.
 */
export function appLockGateShown(): void {
  const plugin = AppLockNative;
  if (!PHONE || !plugin) return;

  try {
    void plugin.gateShown().catch(() => undefined);
  } catch {
    // The shell lifts its cover by itself after a few seconds
  }
}

/**
 * Clears app lock in the shell after the session ended. It does not unlock:
 * the shell stays locked until the page loads again. Never rejects.
 * @returns False if the plugin threw
 */
export async function resetAppLock(): Promise<boolean> {
  const plugin = AppLockNative;
  if (!PHONE || !plugin) return true;

  try {
    await plugin.reset();
  } catch {
    return false;
  }

  await refreshAppLock();
  return true;
}

/**
 * Runs an action that must not happen behind the lock screen, such as opening
 * the channel a notification points at. It runs now if the app is not locked.
 * Otherwise it is kept, replacing any earlier one, and runs once when the app
 * is next unlocked.
 * @param run The action
 */
export function whenAppUnlocked(run: () => void): void {
  if (!untrack(appLocked)) {
    run();
    return;
  }

  parked = run;
}

/**
 * Drops the action kept by `whenAppUnlocked`, if any.
 */
export function clearAppLockParked(): void {
  parked = undefined;
}

/**
 * The main window's own title bar, as far as the shell is concerned: whether
 * the shell built main without an OS title bar (so the page draws one), the
 * window's maximized and fullscreen state, and the verbs behind the bar's
 * buttons.
 *
 * - Tauri (Windows): main may be built frameless. The page asks with
 *   `main_window_claim_frame` and draws its bar (with minimize, maximize /
 *   restore and close) only on exactly `{ frameless: true, maximized }`. The
 *   shell can take the frame back (its watchdog, a release, a crashed page):
 *   it then pushes `mainFrameRevoked` (ShellBridgeWorker calls
 *   {@link noteRevoked}), and any `main_window_*` call that fails while the
 *   bar is drawn counts as a revoke too, as that push only reaches a page
 *   with ShellBridgeWorker mounted (not the login screen).
 * - Electron (macOS): `slogaShell.windowFrame.main === "inset"` means main
 *   was built with the hidden-inset title bar; the OS draws the traffic
 *   lights and the page keeps their corner clear, except in window
 *   fullscreen, which the shell pushes as `windowFrameState`
 *   ({@link watchWindowFrameState}).
 * - Everything else (web, Android, iOS, Linux, older shells, any answer this
 *   module cannot read) is `native`: the OS frame, and no bar of ours.
 *
 * Once revoked, main stays `native` for the rest of the page's life.
 *
 * Only the MAIN window's globals are read, as in chatShell. Kept free of
 * lingui and the app contexts so `node --test` can load it with fake
 * globals; the only Solid use is signals. Nothing here throws or rejects.
 */
import { createSignal } from "solid-js";

import {
  setWindowFullscreen,
  windowFullscreen,
} from "../chatWindows/chatWindowFrame.ts";
import { tauriInvoke } from "../common/lib/tauriInvoke.ts";

import { CHAT_WINDOW_LABEL_RE } from "./shellToMain.ts";

/**
 * How main's title bar is drawn:
 * - `buttons`: no OS title bar (Tauri, Windows); the page draws the bar and
 *   the window buttons.
 * - `inset`: macOS hidden-inset title bar (Electron); the page draws the bar
 *   around the OS traffic lights.
 * - `native`: the OS frame; nothing of ours.
 */
export type MainFrame = "buttons" | "inset" | "native";

/** Shell label of the main window in `windowFrameState` pushes. */
export const MAIN_LABEL = "main";

/** How long `resize` must settle before {@link watchResize} pulls the state. */
export const RESIZE_SETTLE_MS = 150;

/* ------------------------------------------------------------------------ *
 * Answer parsers (pure)
 * ------------------------------------------------------------------------ */

/** A plain object (as JSON or a structured clone makes) with exactly `keys`. */
function isPlainExact(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/**
 * A `main_window_claim_frame` answer: exactly `{ frameless, maximized }`,
 * both booleans. Null for anything else (an older shell's rejection never
 * gets here; a reply with an extra or missing key, or a wrong type, does).
 */
export function parseClaimAnswer(
  answer: unknown,
): { frameless: boolean; maximized: boolean } | null {
  if (!isPlainExact(answer, ["frameless", "maximized"])) return null;
  const { frameless, maximized } = answer as Record<string, unknown>;
  if (typeof frameless !== "boolean" || typeof maximized !== "boolean") {
    return null;
  }
  return { frameless, maximized };
}

/** A `main_window_state` answer: exactly `{ maximized: boolean }`, or null. */
export function parseStateAnswer(answer: unknown): boolean | null {
  if (!isPlainExact(answer, ["maximized"])) return null;
  const { maximized } = answer as Record<string, unknown>;
  return typeof maximized === "boolean" ? maximized : null;
}

/**
 * A `slogaShell.windowFrame.state(label)` reply: exactly
 * `{ ok: true, fullscreen: boolean }` is the state; an `{ ok: false, err }`
 * envelope, or anything else, is null.
 */
export function parseFrameStateReply(reply: unknown): boolean | null {
  if (!isPlainExact(reply, ["ok", "fullscreen"])) return null;
  const { ok, fullscreen } = reply as Record<string, unknown>;
  return ok === true && typeof fullscreen === "boolean" ? fullscreen : null;
}

/** A label the shell pushes window fullscreen for: main, or a chat window. */
export function isFrameLabel(label: unknown): label is string {
  return (
    typeof label === "string" &&
    (label === MAIN_LABEL || CHAT_WINDOW_LABEL_RE.test(label))
  );
}

export type WindowFrameState = {
  kind: "windowFrameState";
  label: string;
  fullscreen: boolean;
};

/**
 * Validate an untrusted `windowFrameState` push: exactly
 * `{ kind: "windowFrameState", label, fullscreen }`, a known label kind and
 * a real boolean.
 */
export function isWindowFrameState(value: unknown): value is WindowFrameState {
  if (!isPlainExact(value, ["kind", "label", "fullscreen"])) return false;
  const msg = value as Record<string, unknown>;
  return (
    msg.kind === "windowFrameState" &&
    isFrameLabel(msg.label) &&
    typeof msg.fullscreen === "boolean"
  );
}

/* ------------------------------------------------------------------------ *
 * Bridges
 * ------------------------------------------------------------------------ */

/**
 * The Electron preload's `slogaShell.windowFrame`, typed loosely on purpose:
 * an older or broken preload may hand back anything, so every part is
 * checked before use.
 */
interface WindowFrameBridge {
  main?: unknown;
  state?: (label: string) => unknown;
  onState?: (callback: (payload: unknown) => void) => unknown;
}

function electronWindowFrame(): WindowFrameBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as { slogaShell?: { windowFrame?: unknown } })
    .slogaShell?.windowFrame;
  return typeof bridge === "object" && bridge !== null
    ? (bridge as WindowFrameBridge)
    : undefined;
}

function errText(reason: unknown): string {
  if (typeof reason === "string" && reason) return reason.slice(0, 200);
  if (reason instanceof Error && reason.message) {
    return reason.message.slice(0, 200);
  }
  return "failed";
}

/**
 * Call the Tauri command `cmd`: its answer, or `{ failed }` when there is no
 * Tauri bridge or the call threw or rejected (an older shell without the
 * command, or the ACL refusing it).
 */
async function tauriCall(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<{ value: unknown } | { failed: string }> {
  try {
    const invoke = tauriInvoke();
    if (!invoke) return { failed: "unsupported" };
    return { value: await invoke<unknown>(cmd, args) };
  } catch (reason) {
    return { failed: errText(reason) };
  }
}

/* ------------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------------ */

const [frame, setFrame] = createSignal<MainFrame>("native");
const [maximized, setMaximized] = createSignal(false);
const [revoked, setRevoked] = createSignal(false);

/*
 * Maximized comes from three answers: the claim, our own toggle's reply and
 * the state pull on `resize`. They can settle out of order, so each request
 * takes a ticket when sent and its answer counts only if no later-sent
 * request's answer has landed already.
 */
let lastTicket = 0;
let appliedTicket = 0;

function nextTicket(): number {
  lastTicket += 1;
  return lastTicket;
}

function applyMaximized(ticket: number, value: boolean): void {
  if (ticket <= appliedTicket) return;
  appliedTicket = ticket;
  setMaximized(value);
}

/** How main's title bar is drawn now (reactive). `native` once revoked. */
export function mainFrame(): MainFrame {
  return revoked() ? "native" : frame();
}

/** Whether the shell last said main is maximized (reactive; `buttons` only). */
export function mainMaximized(): boolean {
  return maximized();
}

/**
 * Whether main is in macOS window fullscreen (reactive; Electron `inset`
 * only, from {@link watchWindowFrameState}). Not element fullscreen.
 */
export function mainFullscreen(): boolean {
  return windowFullscreen(MAIN_LABEL);
}

/** Whether the shell took main's frame back for this page (reactive). */
export function mainFrameRevoked(): boolean {
  return revoked();
}

/**
 * The shell took the frame back (`mainFrameRevoked`): main is `native` for
 * the rest of the page's life, whatever answer is still in flight.
 */
export function noteRevoked(): void {
  setRevoked(true);
  setFrame("native");
}

/**
 * A `main_window_*` call failed, or answered something unreadable. With the
 * bar drawn this is a revoke the page may not have been told about (the
 * push misses the login screen); the shell is asked to restore the OS frame
 * too, best effort, so the window is never left with no title bar at all
 * when the shell is still answering.
 */
function failed(cmd: string, why: string): void {
  console.warn("[main-shell]", cmd, "failed:", why);
  const wasLive = mainFrame() === "buttons";
  noteRevoked();
  if (wasLive) {
    void tauriCall("main_window_release_frame").then((result) => {
      if ("failed" in result) {
        console.warn("[main-shell] release after failure:", result.failed);
      }
    });
  }
}

/* ------------------------------------------------------------------------ *
 * Probe (claim)
 * ------------------------------------------------------------------------ */

let probed: Promise<void> | undefined;

async function probeNow(): Promise<void> {
  // Revoked before anyone probed: never claim a frame already given back.
  if (revoked()) return;
  if (tauriInvoke()) {
    const ticket = nextTicket();
    const result = await tauriCall("main_window_claim_frame");
    if ("failed" in result) return failed("claim", result.failed);
    const answer = parseClaimAnswer(result.value);
    if (!answer) return failed("claim", "invalid answer");
    // A revoke that landed while the claim was in flight wins.
    if (revoked() || !answer.frameless) return;
    applyMaximized(ticket, answer.maximized);
    setFrame("buttons");
    return;
  }

  try {
    if (electronWindowFrame()?.main === "inset" && !revoked()) {
      setFrame("inset");
    }
  } catch {
    // A throwing getter on a broken preload: the OS frame.
  }
}

/**
 * Ask the shell how main is framed and, on Tauri, claim the frame: answers
 * `buttons` only for a claim reply of exactly `{ frameless: true, maximized:
 * boolean }` (seeding {@link mainMaximized}), `inset` only for Electron's
 * `slogaShell.windowFrame.main === "inset"`, and `native` for everything
 * else, including any rejection. Runs once per page; later callers share it
 * and get the frame as it is when they ask (`native` after a revoke).
 * Never rejects.
 */
export function probe(): Promise<MainFrame> {
  probed ??= Promise.resolve().then(probeNow).catch(probeThrew);
  // The frame when the caller's turn comes, not when the probe settled.
  return probed.then(mainFrame);
}

function probeThrew(reason: unknown): void {
  failed("probe", errText(reason));
}

/* ------------------------------------------------------------------------ *
 * Buttons (Tauri)
 * ------------------------------------------------------------------------ */

/**
 * Run `cmd` for a drawn bar and read its answer with `read` (null:
 * unreadable). The answer, or null when there is no bar, the call failed or
 * the answer was unreadable; the last two revoke ({@link failed}).
 */
async function barVerb<T>(
  cmd: string,
  read: (value: unknown) => T | null,
): Promise<T | null> {
  if (mainFrame() !== "buttons") return null;
  const result = await tauriCall(cmd);
  if ("failed" in result) {
    failed(cmd, result.failed);
    return null;
  }
  const value = read(result.value);
  if (value === null) failed(cmd, "invalid answer");
  return value;
}

/** A command that answers nothing: `null` on the wire (unit in Rust). */
const readUnit = (value: unknown): true | null =>
  value === null || value === undefined ? true : null;

const readBool = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

/** Minimize main (`main_window_minimize`). `true` when the shell did. */
export async function minimize(): Promise<boolean> {
  return (await barVerb("main_window_minimize", readUnit)) === true;
}

/**
 * Hide main (`main_window_close`): the shell's close handler sends it to
 * the tray, exactly as the OS close button does. `true` when it answered.
 */
export async function close(): Promise<boolean> {
  return (await barVerb("main_window_close", readUnit)) === true;
}

/**
 * Maximize main, or restore it (`main_window_toggle_maximize`); the shell's
 * answer, the NEW state, becomes {@link mainMaximized}. `true` when the
 * shell answered.
 */
export async function toggleMaximize(): Promise<boolean> {
  const ticket = nextTicket();
  const next = await barVerb("main_window_toggle_maximize", readBool);
  if (next === null) return false;
  applyMaximized(ticket, next);
  return true;
}

/**
 * Pull main's maximized state (`main_window_state`), for changes the bar did
 * not make itself (snap, Win+arrows, a double-click on the bar). `true` when
 * the shell answered.
 */
export async function refreshState(): Promise<boolean> {
  const ticket = nextTicket();
  const value = await barVerb("main_window_state", parseStateAnswer);
  if (value === null) return false;
  applyMaximized(ticket, value);
  return true;
}

/**
 * {@link refreshState} after `target`'s `resize` events settle for
 * {@link RESIZE_SETTLE_MS}. Returns the stop.
 */
export function watchResize(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refreshState();
    }, RESIZE_SETTLE_MS);
  };
  target.addEventListener("resize", onResize);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    target.removeEventListener("resize", onResize);
  };
}

/**
 * Hand the frame back to the shell (`main_window_release_frame`): it
 * restores the OS title bar for the rest of the process. Main turns
 * `native` once the shell confirms; on a failure the bar stays, as the
 * window may still have no OS one. `true` when released.
 */
export async function release(): Promise<boolean> {
  const result = await tauriCall("main_window_release_frame");
  if ("failed" in result) {
    console.warn("[main-shell] release failed:", result.failed);
    return false;
  }
  noteRevoked();
  return true;
}

/* ------------------------------------------------------------------------ *
 * "Use the Windows title bar" setting (Tauri)
 * ------------------------------------------------------------------------ */

/**
 * Whether the user chose the Windows title bar (`main_window_system_frame`),
 * or null when this shell has no such setting (hide it).
 */
export async function systemFrame(): Promise<boolean | null> {
  const result = await tauriCall("main_window_system_frame");
  if ("failed" in result) return null;
  return typeof result.value === "boolean" ? result.value : null;
}

/**
 * Store the Windows title bar choice (`main_window_set_system_frame`); it
 * applies the next time the shell starts. `true` when stored.
 */
export async function setSystemFrame(on: boolean): Promise<boolean> {
  if (typeof on !== "boolean") return false;
  const result = await tauriCall("main_window_set_system_frame", { on });
  if ("failed" in result) {
    console.warn("[main-shell] set system frame failed:", result.failed);
    return false;
  }
  return readUnit(result.value) === true;
}

/* ------------------------------------------------------------------------ *
 * Window fullscreen pushes (Electron)
 * ------------------------------------------------------------------------ */

let watchers = 0;
let unsubscribeShell: (() => void) | undefined;
/** `windowFrameState` pushes for main so far; voids an older pull's answer. */
let mainPushes = 0;

function onFrameState(payload: unknown): void {
  if (!isWindowFrameState(payload)) {
    const kind = (payload as { kind?: unknown } | null)?.kind;
    console.warn(
      "[main-shell] dropped frame state",
      typeof kind === "string" ? kind.slice(0, 32) : typeof kind,
    );
    return;
  }
  if (payload.label === MAIN_LABEL) mainPushes += 1;
  setWindowFullscreen(payload.label, payload.fullscreen);
}

/** Main may already be fullscreen (a reload); ask once, a push wins. */
function seedMainFullscreen(bridge: WindowFrameBridge): void {
  const seen = mainPushes;
  void Promise.resolve()
    .then(() => {
      // Read in here: a throwing getter must not undo the subscription.
      if (bridge.main !== "inset" || typeof bridge.state !== "function") {
        return null;
      }
      return bridge.state(MAIN_LABEL);
    })
    .then(
      (reply) => {
        const value = parseFrameStateReply(reply);
        if (value !== null && mainPushes === seen) {
          setWindowFullscreen(MAIN_LABEL, value);
        }
      },
      () => {},
    );
}

/**
 * Keep the window fullscreen of main and the chat windows current from the
 * Electron shell's `windowFrameState` pushes: main's lands in
 * {@link mainFullscreen}, every window's in `windowFullscreen(label)`
 * (chatWindowFrame), which `titleBarLayout` reads. One shell subscription
 * however many callers hold one; the last stop drops it. Returns the stop.
 * A no-op without `slogaShell.windowFrame.onState`.
 */
export function watchWindowFrameState(): () => void {
  try {
    const bridge = electronWindowFrame();
    if (!bridge || typeof bridge.onState !== "function") return () => {};
    if (watchers === 0) {
      const off = bridge.onState(onFrameState);
      unsubscribeShell =
        typeof off === "function" ? (off as () => void) : undefined;
      seedMainFullscreen(bridge);
    }
  } catch (reason) {
    console.warn("[main-shell] frame state subscribe failed:", errText(reason));
    return () => {};
  }
  watchers += 1;
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    watchers -= 1;
    if (watchers > 0) return;
    const off = unsubscribeShell;
    unsubscribeShell = undefined;
    try {
      off?.();
    } catch {
      // A preload that throws on unsubscribe: nothing left to do.
    }
  };
}

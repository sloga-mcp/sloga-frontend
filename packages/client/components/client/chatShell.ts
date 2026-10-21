/**
 * The main window's bridge to the desktop shells' chat windows: arm the next
 * `window.open("about:blank")` so the shell builds it as a chat window,
 * remember where one sat, pull the main window forward, throw away a window
 * built for an arm main never got to use, finish closing one main closed, and
 * minimize or maximize a frameless one for its own title bar buttons.
 *
 * Windows (Tauri) and the Electron shell (macOS, Linux) take the same verbs
 * through different bridges; every answer comes back as one `ShellResult`
 * envelope, and nothing here throws.
 *
 * Only the MAIN window's globals are ever read. A chat window is rendered by
 * this realm into a child document, but the child has its own `__TAURI__`
 * (with no capability, so every call would ACL-fail) and no `slogaShell`;
 * asking it anything would read as supported and then fail. `window` in this
 * module is always main's, because main's code is what runs.
 *
 * Kept free of lingui and the app contexts so `node --test` can load it with
 * fake globals; the only Solid use is the signal behind
 * {@link chatWindowsAvailable}, which loads there too.
 */
import { createSignal } from "solid-js";

import { tauriInvoke } from "../common/lib/tauriInvoke.ts";

/** `Record<never, never>` is the contract's `{}`, spelled so lint accepts it. */
export type ShellResult<T = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; err: string };

export type ChatWindowKind = "friends" | "chat";

/**
 * What the shell built around a chat window, as {@link arm} reports it:
 * - `buttons`: no OS title bar (Tauri, Windows); the window draws its own bar
 *   with minimize, maximize and close.
 * - `inset`: macOS hidden-inset title bar (Electron); the OS draws the
 *   traffic lights and the window keeps their corner clear.
 * - `native`: the OS frame, as before. Web, older shells, and every answer
 *   this module cannot read land here.
 */
export type ChatWindowFrame = "buttons" | "inset" | "native";

/**
 * The Electron preload's `slogaShell.chatWindows`, main window only. Its
 * answers are typed `unknown` on purpose: an older or broken preload may hand
 * back anything, so each one is checked before it becomes a `ShellResult`.
 */
interface ChatWindowsBridge {
  arm?(kind: ChatWindowKind, opts?: { frame: "custom" }): Promise<unknown>;
  bounds?(label: string): Promise<unknown>;
  focusMain?(): Promise<unknown>;
}

const UNSUPPORTED = { ok: false, err: "unsupported" } as const;
const INVALID = { ok: false, err: "invalid" } as const;

function electronChatWindows(): ChatWindowsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as { slogaShell?: { chatWindows?: ChatWindowsBridge } })
    .slogaShell?.chatWindows;
}

/**
 * Whether this window's shell can make chat windows. On web (and Android)
 * there is no shell: `window.open` still gives a child window, just one the
 * browser places and the app cannot remember the position of.
 */
export function supported(): boolean {
  return !!tauriInvoke() || !!electronChatWindows();
}

/** A rejection as the `err` of an envelope: Tauri rejects with the Rust `Err` string. */
function errText(reason: unknown): string {
  if (typeof reason === "string" && reason) return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return "failed";
}

/** A Tauri command whose answer carries nothing: resolving is success. */
function tauriVoid(cmd: string, args?: Record<string, unknown>) {
  const invoke = tauriInvoke();
  if (!invoke) return undefined;
  // Wrapped so a synchronous throw from the bridge becomes a rejection too.
  return Promise.resolve()
    .then(() => invoke<unknown>(cmd, args))
    .then(
      (): ShellResult => ({ ok: true }),
      (reason): ShellResult => ({ ok: false, err: errText(reason) }),
    );
}

/**
 * An Electron bridge answer as a `ShellResult`. Only a real envelope counts:
 * `{ ok: true }` (with a non-empty `label` when `wantLabel`) or
 * `{ ok: false, err }` with a string `err`. Anything else is `invalid`.
 */
function fromEnvelope(
  envelope: unknown,
  wantLabel: boolean,
): ShellResult<{ label?: string }> {
  const value = envelope as { ok?: unknown; err?: unknown; label?: unknown };
  if (value?.ok === true) {
    if (!wantLabel) return { ok: true };
    return typeof value.label === "string" && value.label
      ? { ok: true, label: value.label }
      : INVALID;
  }
  if (value?.ok === false && typeof value.err === "string" && value.err) {
    return { ok: false, err: value.err };
  }
  return INVALID;
}

/** Call one Electron verb; a missing verb (an older preload) is unsupported. */
function electronCall(
  verb: keyof ChatWindowsBridge,
  args: unknown[],
  wantLabel: boolean,
): Promise<ShellResult<{ label?: string }>> | undefined {
  const bridge = electronChatWindows();
  if (!bridge) return undefined;
  const fn = bridge[verb] as
    | ((...args: unknown[]) => Promise<unknown>)
    | undefined;
  if (typeof fn !== "function") return Promise.resolve(UNSUPPORTED);
  return Promise.resolve()
    .then(() => fn.apply(bridge, args))
    .then(
      (envelope) => fromEnvelope(envelope, wantLabel),
      (reason): ShellResult => ({ ok: false, err: errText(reason) }),
    );
}

export type ArmResult = ShellResult<{ label: string; frame: ChatWindowFrame }>;

/**
 * Tell the shell the next `window.open("about:blank")` from this window is a
 * chat window of `kind`. The arm is short-lived and consumed by the first new
 * window, so open the window straight after this resolves.
 *
 * The frameless opt-in is decided here, so a new frontend on an old shell
 * keeps the OS frame and an old frontend on a new shell never gets a window
 * without controls:
 * - Tauri: `frameless: true` is sent only after {@link probeChatWindows}
 *   read `{ frameless: true }` from this shell (the arm runs the probe
 *   itself if none has run, and waits for one in flight); otherwise the arm
 *   is `{ kind }` exactly as before. An opted-in arm builds a `buttons`
 *   window.
 * - Electron: always asks for `{ frame: "custom" }`; the preload answers what
 *   it built. `frame: "inset"` is `inset`; anything else, or none (an older
 *   preload drops the second argument), is `native`.
 * @returns The label the shell will give that window, and its frame
 */
export function arm(kind: ChatWindowKind): Promise<ArmResult> {
  if (kind !== "friends" && kind !== "chat") return Promise.resolve(INVALID);
  // Wrapped so even a throwing global becomes an envelope.
  return Promise.resolve()
    .then(() => armNow(kind))
    .catch((reason): ArmResult => ({ ok: false, err: errText(reason) }));
}

async function armNow(kind: ChatWindowKind): Promise<ArmResult> {
  const invoke = tauriInvoke();
  if (invoke) {
    // Runs the probe if nobody has yet, else reuses its cached answer, so
    // the opt-in never depends on who asked first. It never rejects.
    await probeChatWindows();
    const frame: ChatWindowFrame = framelessSupported ? "buttons" : "native";
    const label = await invoke<unknown>(
      "chat_window_arm",
      frame === "buttons" ? { kind, frameless: true } : { kind },
    );
    return typeof label === "string" && label
      ? { ok: true, label, frame }
      : INVALID;
  }

  const bridge = electronChatWindows();
  if (!bridge) return UNSUPPORTED;
  if (typeof bridge.arm !== "function") return UNSUPPORTED;
  const envelope = await bridge.arm(kind, { frame: "custom" });
  const result = fromEnvelope(envelope, true);
  if (!result.ok) return result;
  // fromEnvelope answers ok only with a non-empty label when asked for one.
  const label = result.label as string;
  const inset = (envelope as { frame?: unknown }).frame === "inset";
  return { ok: true, label, frame: inset ? "inset" : "native" };
}

/** Save where the chat window `label` sits, for the next one of its kind. */
export function saveBounds(label: string): Promise<ShellResult> {
  return (
    tauriVoid("chat_window_bounds", { label }) ??
    electronCall("bounds", [label], false) ??
    Promise.resolve(UNSUPPORTED)
  );
}

/**
 * Show, unminimize and focus the main window. Calls, video and screen share
 * started from a chat window go through here first: their permission prompts
 * and pickers render in the main window.
 */
export function focusMain(): Promise<ShellResult> {
  return (
    tauriVoid("chat_window_focus_main") ??
    electronCall("focusMain", [], false) ??
    Promise.resolve(UNSUPPORTED)
  );
}

/**
 * Destroy the chat window `label` if the shell built one. Called when main's
 * `window.open` came back null after a successful arm: another frame's open
 * consumed the arm, so the window carrying `label` is not main's and nothing
 * renders into it. Tauri destroys it (`chat_window_discard`, main-only).
 * Electron needs nothing: it destroys a child that main's own frame did not
 * open as it is created, so this answers `{ ok: true }` without a round trip.
 */
export function discard(label: string): Promise<ShellResult> {
  // Wrapped so even a throwing global becomes an envelope: this runs on a
  // failure path whose caller must not have to guard it.
  return Promise.resolve()
    .then(
      (): Promise<ShellResult> | ShellResult =>
        tauriVoid("chat_window_discard", { label }) ??
        (electronChatWindows() ? { ok: true } : UNSUPPORTED),
    )
    .catch((reason): ShellResult => ({ ok: false, err: errText(reason) }));
}

/**
 * Finish closing the chat window `label` after main's `close()` on it.
 *
 * On Tauri that close only takes the webview down: wry answers WebView2's
 * `WindowCloseRequested` by destroying its own container inside the window,
 * so the native window stays open, blank and still titled. Its geometry is
 * saved first (`chat_window_bounds`; a destroy skips the save the titlebar X
 * gets), then it is destroyed by label (`chat_window_discard`, main-only).
 * A failed save still destroys. Electron closes a child that main closed by
 * itself, so this answers `{ ok: true }` without a round trip.
 */
export function closeWindow(label: string): Promise<ShellResult> {
  // Wrapped like discard: callers fire and forget this on a close path.
  return Promise.resolve()
    .then(async (): Promise<ShellResult> => {
      const saved = tauriVoid("chat_window_bounds", { label });
      if (!saved) return electronChatWindows() ? { ok: true } : UNSUPPORTED;
      await saved;
      return tauriVoid("chat_window_discard", { label }) ?? UNSUPPORTED;
    })
    .catch((reason): ShellResult => ({ ok: false, err: errText(reason) }));
}

/**
 * Minimize the chat window `label` (Tauri `chat_window_minimize`, main-only).
 * The frameless window's own minimize button lands here; Electron windows
 * keep OS controls, so it and web answer `unsupported`.
 */
export function minimize(label: string): Promise<ShellResult> {
  return Promise.resolve()
    .then(
      (): Promise<ShellResult> | ShellResult =>
        tauriVoid("chat_window_minimize", { label }) ?? UNSUPPORTED,
    )
    .catch((reason): ShellResult => ({ ok: false, err: errText(reason) }));
}

/**
 * Maximize the chat window `label`, or restore it if it is maximized (Tauri
 * `chat_window_toggle_maximize`, main-only). The shell answers the NEW state;
 * any answer that is not a boolean is `invalid`. Electron and web answer
 * `unsupported`. The shell also pushes the state as `chatWindowState` on
 * every change, which covers snaps and double-clicks this call never sees.
 */
export function toggleMaximize(
  label: string,
): Promise<ShellResult<{ maximized: boolean }>> {
  return Promise.resolve()
    .then(async (): Promise<ShellResult<{ maximized: boolean }>> => {
      const invoke = tauriInvoke();
      if (!invoke) return UNSUPPORTED;
      const maximized = await invoke<unknown>("chat_window_toggle_maximize", {
        label,
      });
      return typeof maximized === "boolean" ? { ok: true, maximized } : INVALID;
    })
    .catch(
      (reason): ShellResult<{ maximized: boolean }> => ({
        ok: false,
        err: errText(reason),
      }),
    );
}

/**
 * Whether a `chat_window_probe` answer says this shell builds frameless chat
 * windows: a plain object whose own `frameless` is exactly `true`. An older
 * shell answers `null`; `{}`, `{ frameless: false }`, a string, an array or
 * anything else keeps the OS frame.
 */
export function isFramelessProbeAnswer(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const proto = Object.getPrototypeOf(answer);
  if (proto !== Object.prototype && proto !== null) return false;
  return (
    Object.prototype.hasOwnProperty.call(answer, "frameless") &&
    (answer as { frameless?: unknown }).frameless === true
  );
}

const [available, setAvailable] = createSignal<boolean | undefined>();
let probe: Promise<boolean> | undefined;
/** Set once by a Tauri probe that read `{ frameless: true }`; see {@link arm}. */
let framelessSupported = false;

/**
 * Whether the shell really answers chat-window calls, as opposed to merely
 * exposing a bridge ({@link supported}): an older shell build has the Tauri
 * bridge but no `chat_window_*` commands, and an older preload has
 * `slogaShell` without a usable `chatWindows.arm`.
 *
 * Electron needs no round trip: the preload's verbs are present or not. Tauri
 * has no way to list commands, so the probe is one `chat_window_probe`, a
 * main-only command that does nothing. It must not be `focus_main`: the probe
 * runs at boot, and raising main then would pull a tray-started app forward.
 * Any rejection reads as unavailable, whether the command is missing (an
 * older shell) or the ACL refuses it. Tauri wins when both bridges are
 * present, as everywhere else.
 *
 * The Tauri answer also carries the frameless capability
 * ({@link isFramelessProbeAnswer}); an older shell answers `null`, which is
 * available without it.
 *
 * Runs once per session: concurrent callers share the same promise, and a
 * failure caches `false` until reload.
 */
export function probeChatWindows(): Promise<boolean> {
  probe ??= Promise.resolve()
    .then(async () => {
      const invoke = tauriInvoke();
      if (invoke) {
        const answer = await invoke<unknown>("chat_window_probe");
        framelessSupported = isFramelessProbeAnswer(answer);
        return true;
      }
      return typeof electronChatWindows()?.arm === "function";
    })
    .catch(() => false)
    .then((ok) => {
      setAvailable(ok);
      return ok;
    });
  return probe;
}

/**
 * The cached {@link probeChatWindows} answer, reactive; undefined until a
 * probe settles.
 */
export function chatWindowsAvailable(): boolean | undefined {
  return available();
}

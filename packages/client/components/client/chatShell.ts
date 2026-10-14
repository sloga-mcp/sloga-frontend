/**
 * The main window's bridge to the desktop shells' chat windows: arm the next
 * `window.open("about:blank")` so the shell builds it as a chat window, pin
 * one on top, remember where it sat, pull the main window forward, and throw
 * away a window built for an arm main never got to use.
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
 * The Electron preload's `slogaShell.chatWindows`, main window only. Its
 * answers are typed `unknown` on purpose: an older or broken preload may hand
 * back anything, so each one is checked before it becomes a `ShellResult`.
 */
interface ChatWindowsBridge {
  arm?(kind: ChatWindowKind): Promise<unknown>;
  pin?(label: string, on: boolean): Promise<unknown>;
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
 * browser places and the app cannot pin.
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

/**
 * Tell the shell the next `window.open("about:blank")` from this window is a
 * chat window of `kind`. The arm is short-lived and consumed by the first new
 * window, so open the window straight after this resolves.
 * @returns The label the shell will give that window
 */
export function arm(
  kind: ChatWindowKind,
): Promise<ShellResult<{ label: string }>> {
  if (kind !== "friends" && kind !== "chat") return Promise.resolve(INVALID);

  const invoke = tauriInvoke();
  if (invoke) {
    return Promise.resolve()
      .then(() => invoke<unknown>("chat_window_arm", { kind }))
      .then(
        (label): ShellResult<{ label: string }> =>
          typeof label === "string" && label ? { ok: true, label } : INVALID,
        (reason): ShellResult<{ label: string }> => ({
          ok: false,
          err: errText(reason),
        }),
      );
  }

  return (
    (electronCall("arm", [kind], true) as
      | Promise<ShellResult<{ label: string }>>
      | undefined) ?? Promise.resolve(UNSUPPORTED)
  );
}

/** Keep the chat window `label` above other windows, or stop. */
export function setPin(label: string, on: boolean): Promise<ShellResult> {
  return (
    tauriVoid("chat_window_pin", { label, on }) ??
    electronCall("pin", [label, on], false) ??
    Promise.resolve(UNSUPPORTED)
  );
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

const [available, setAvailable] = createSignal<boolean | undefined>();
let probe: Promise<boolean> | undefined;

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
 * Runs once per session: concurrent callers share the same promise, and a
 * failure caches `false` until reload.
 */
export function probeChatWindows(): Promise<boolean> {
  probe ??= Promise.resolve()
    .then(() => {
      const answer = tauriVoid("chat_window_probe");
      if (answer) return answer.then((result) => result.ok);
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

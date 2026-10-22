/**
 * The shell → main wire contract and its validator. Everything that arrives
 * over a shell bridge passes `isShellToMain` before anything acts on it, and
 * every web popout `postMessage` passes `validateWebPopoutMessage`.
 *
 * Kept free of imports so `node --test` can load it on its own; the rest of
 * `popoutBridge` pulls in Solid, lingui and the app contexts, which node
 * can't. `popoutBridge` re-exports what its callers use under the same names.
 */
export type PopoutAction = "dm" | "call" | "video" | "screenshare";

export const POPOUT_ACTIONS: readonly PopoutAction[] = [
  "dm",
  "call",
  "video",
  "screenshare",
];

export function isPopoutAction(value: unknown): value is PopoutAction {
  return (
    typeof value === "string" &&
    (POPOUT_ACTIONS as readonly string[]).includes(value)
  );
}

/** `type` of the web popout's `postMessage` to its opener. */
export const POPOUT_WEB_MESSAGE_TYPE = "sloga:popout-open-in-main";

/** A ULID (Crockford base32, 26 chars). No `g` flag: `test` stays stateless. */
export const ULID_RE: RegExp = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Validate an untrusted web popout `postMessage` payload. Checks the payload
 * only: the caller still has to confirm the sender is this app's own friends
 * popout. Desktop shells no longer carry this action; their friends window
 * opens conversations itself.
 */
export function validateWebPopoutMessage(
  data: unknown,
): { action: PopoutAction; userId: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as { type?: unknown; action?: unknown; userId?: unknown };
  if (msg.type !== POPOUT_WEB_MESSAGE_TYPE) return null;
  if (!isPopoutAction(msg.action)) return null;
  if (typeof msg.userId !== "string" || !ULID_RE.test(msg.userId)) return null;
  return { action: msg.action, userId: msg.userId };
}

/**
 * Shell → main messages (Tauri `ipc::Channel` payload AND Electron
 * `sloga:shell-to-main` payload). Mirrors the Rust `ShellToMain` enum
 * (`#[serde(tag = "kind", rename_all = "camelCase")]`).
 */
export type ShellToMain =
  | { kind: "notificationOpen"; path: string }
  | { kind: "toastReply"; toastId: string; text: string }
  | { kind: "toastOpen"; toastId: string }
  | { kind: "chatWindowState"; label: string; maximized: boolean };

/**
 * A chat window label the shells hand out: the friends window, or `chat-`
 * and a decimal counter (at most 20 digits, a u64). Defined here because
 * this module stays import-free; `chatWindowFrame` re-exports it. No `g`
 * flag: `test` stays stateless.
 */
export const CHAT_WINDOW_LABEL_RE: RegExp =
  /^(friends-window|chat-[0-9]{1,20})$/;

/**
 * A toast id the main window minted for the Sloga toast. Same rule as the
 * Rust `shell_bridge::is_toast_id`. No `g` flag: `test` stays stateless.
 */
export const TOAST_ID_RE: RegExp = /^[0-9A-Za-z_-]{1,64}$/;

/** Bounds an in-app path before it reaches the router. */
const MAX_PATH_LENGTH = 2048;

/** Quick-reply text cap in UTF-16 units, the same cap the shell enforces. */
const MAX_TOAST_REPLY_LENGTH = 2000;

/**
 * An in-app path the main window may navigate to: absolute ("/"), never
 * protocol-relative ("//host"), and free of backslashes and control
 * characters — URL parsing turns "/\host" into "//host".
 */
function isInAppPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PATH_LENGTH &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    // eslint-disable-next-line no-control-regex
    !/[\\\u0000-\u001f\u007f]/.test(value)
  );
}

/** Exactly these own keys, so a payload can't smuggle extra fields along. */
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/**
 * Validate an untrusted shell → main payload. Everything that arrives over a
 * shell bridge passes through here before anything acts on it.
 */
export function isShellToMain(value: unknown): value is ShellToMain {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const msg = value as Record<string, unknown>;
  switch (msg.kind) {
    case "notificationOpen":
      return hasExactKeys(msg, ["kind", "path"]) && isInAppPath(msg.path);
    case "toastReply":
      return (
        hasExactKeys(msg, ["kind", "toastId", "text"]) &&
        typeof msg.toastId === "string" &&
        TOAST_ID_RE.test(msg.toastId) &&
        typeof msg.text === "string" &&
        msg.text.length >= 1 &&
        msg.text.length <= MAX_TOAST_REPLY_LENGTH
      );
    case "toastOpen":
      return (
        hasExactKeys(msg, ["kind", "toastId"]) &&
        typeof msg.toastId === "string" &&
        TOAST_ID_RE.test(msg.toastId)
      );
    case "chatWindowState":
      return (
        hasExactKeys(msg, ["kind", "label", "maximized"]) &&
        typeof msg.label === "string" &&
        CHAT_WINDOW_LABEL_RE.test(msg.label) &&
        typeof msg.maximized === "boolean"
      );
    default:
      return false;
  }
}

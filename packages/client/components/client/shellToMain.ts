/**
 * The shell → main wire contract and its validator. Everything that arrives
 * over a shell bridge passes `isShellToMain` before anything acts on it.
 *
 * Kept free of imports so `node --test` can load it on its own; the rest of
 * `popoutBridge` pulls in Solid, lingui and the app contexts, which node
 * can't. `popoutBridge` re-exports everything here under the same names.
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
 * Shell → main messages (Tauri `ipc::Channel` payload AND Electron
 * `sloga:shell-to-main` payload). Mirrors the Rust `ShellToMain` enum
 * (`#[serde(tag = "kind", rename_all = "camelCase")]`).
 */
export type ShellToMain =
  | { kind: "popoutOpenInMain"; action: PopoutAction; userId: string }
  | { kind: "notificationOpen"; path: string }
  | { kind: "toastReply"; toastId: string; text: string }
  | { kind: "toastOpen"; toastId: string };

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
    case "popoutOpenInMain":
      return (
        hasExactKeys(msg, ["kind", "action", "userId"]) &&
        isPopoutAction(msg.action) &&
        typeof msg.userId === "string" &&
        ULID_RE.test(msg.userId)
      );
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
    default:
      return false;
  }
}

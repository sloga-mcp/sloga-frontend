/**
 * Message / call actions on a user, and the hand-off that lets the friends
 * popout run them in the main window.
 *
 * The popout cannot run them itself. A navigation inside it is bounced
 * straight back to `/friends-popout` (see `Interface`), and a call started
 * there joins from a window the E2EE engine treats as web — an UNENCRYPTED
 * call with no controls that can evict the main window's membership. So the
 * popout only forwards `{action, userId}`; the main window validates it
 * (`isShellToMain`, ShellBridgeWorker) and runs the same path a context menu
 * in the main window would.
 *
 * | shell    | popout → main                                          |
 * | -------- | ------------------------------------------------------ |
 * | Tauri    | `friends_popout_open_in_main` (label-checked in Rust)  |
 * | Electron | `slogaShell.popout.openInMain` (sender-checked in main) |
 * | Web      | `opener.postMessage` (origin + source checked in main)  |
 */
import { useLingui } from "@lingui-solid/solid/macro";
import { useNavigate } from "@solidjs/router";
import type { Channel } from "stoat.js";

import { CONFIGURATION, tauriInvoke } from "@revolt/common";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
// The file, not the `@revolt/ui` barrel: ProfileActions (inside
// components/ui) imports this module, and a barrel edge back into
// components/ui can reorder its module init into a TDZ blank page.
import { useSnackbar } from "@revolt/ui/components/design/Snackbar";

import { useClient } from ".";
import { IS_POPOUT_WINDOW } from "./popout";

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
  | { kind: "notificationOpen"; path: string };

/** Bounds an in-app path before it reaches the router. */
const MAX_PATH_LENGTH = 2048;

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
    default:
      return false;
  }
}

/**
 * Popout window only: hand the action to the main window. Never opens a DM
 * or touches voice here. Rejects when the action is malformed or no route to
 * the main window exists (older shell, closed opener).
 */
export async function forwardToMain(
  action: PopoutAction,
  userId: string,
): Promise<void> {
  if (!isPopoutAction(action) || !ULID_RE.test(userId))
    throw new Error("popout bridge: invalid action");

  const invoke = tauriInvoke();
  if (invoke) {
    await invoke("friends_popout_open_in_main", { action, userId });
    return;
  }

  // An Electron popout is a native window with no opener, so a shell whose
  // preload predates the bridge has no route at all — fail, don't fall back.
  if (window.slogaShell) {
    const popout = window.slogaShell.popout;
    if (typeof popout?.openInMain !== "function")
      throw new Error("popout bridge: shell has no openInMain");
    await popout.openInMain(action, userId);
    return;
  }

  const opener = window.opener as Window | null;
  if (!opener || opener.closed)
    throw new Error("popout bridge: main window is gone");
  opener.postMessage(
    { type: POPOUT_WEB_MESSAGE_TYPE, action, userId },
    location.origin,
  );
  try {
    // Browsers mostly refuse to raise another window; worth the try.
    opener.focus();
  } catch {
    // best effort
  }
}

/**
 * Message / call actions on a user. Call in component setup (it takes the
 * router, voice, state and snackbar contexts).
 *
 * `run` never rejects: failures surface as a snackbar, as the context menu
 * always has. It settles when the action has finished, so a caller closing
 * a menu should do that without awaiting it.
 */
export function useUserActions(): {
  run(action: PopoutAction, userId: string): Promise<void>;
} {
  const client = useClient();
  const navigate = useNavigate();
  const voice = useVoice();
  const state = useState();
  const snackbar = useSnackbar();
  const { t } = useLingui();

  /**
   * Surface an openDM failure — otherwise a denied DM reads as a dead button
   */
  function dmFailed(err: unknown) {
    console.error(err);
    snackbar.show({
      message: t`Couldn't open a conversation with this user.`,
    });
  }

  /**
   * Enter the DM channel; on phones the navigation happens in the content
   * pane, which may be slid off-screen behind the sidebar
   */
  function enterDm(channel: Channel) {
    navigate(channel.path);
    state.appDrawer()?.setShown(true);
  }

  async function runHere(action: PopoutAction, userId: string) {
    // Video and screen share are build-gated; their entries are hidden when
    // off, so only a forwarded action can get here.
    if (
      (action === "video" || action === "screenshare") &&
      !CONFIGURATION.ENABLE_VIDEO
    ) {
      console.warn(`[popoutBridge] ${action} is disabled in this build`);
      return;
    }

    try {
      const user = client().users.get(userId);
      if (!user) throw new Error("popout bridge: unknown user");

      // Every call entry is offered only for a user we can DM. The
      // forwarded path holds the same line rather than trusting the window
      // that sent it.
      if (
        action !== "dm" &&
        (user.self ||
          user.relationship === "Blocked" ||
          user.relationship === "BlockedOther")
      )
        throw new Error("popout bridge: user cannot be called");

      const channel = await user.openDM();
      enterDm(channel);

      switch (action) {
        case "dm":
          return;
        case "call":
          await voice.connect(channel);
          return;
        case "video":
          if (await voice.connect(channel)) await voice.toggleCamera();
          return;
        case "screenshare":
          if (await voice.connect(channel)) await voice.toggleScreenshare();
          return;
      }
    } catch (err) {
      dmFailed(err);
    }
  }

  async function run(action: PopoutAction, userId: string) {
    if (!IS_POPOUT_WINDOW) return runHere(action, userId);

    try {
      await forwardToMain(action, userId);
    } catch (err) {
      console.error(err);
      snackbar.show({
        message: t`Couldn't open this in the main Sloga window.`,
      });
    }
  }

  return { run };
}

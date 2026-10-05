import { type JSX, onCleanup, onMount } from "solid-js";

import { tauriInvoke } from "@revolt/common";
import { useNavigate } from "@revolt/routing";

import { useClient } from ".";
import {
  POPOUT_WEB_MESSAGE_TYPE,
  ULID_RE,
  isPopoutAction,
  isShellToMain,
  useUserActions,
} from "./popoutBridge";

/**
 * The parts of the Tauri global this worker touches, declared locally as the
 * other workers do. `invoke` comes from the shared `tauriInvoke` probe.
 */
type TauriChannel = {
  onmessage: (message: unknown) => void;
  /** Public from `@tauri-apps/api` 2.5.0; drops the window-held callback. */
  cleanupCallback?: () => void;
};

type TauriGlobal = {
  core?: { Channel?: new () => TauriChannel };
};

/**
 * Whether a `message` event came from this app's own friends popout. The
 * origin check alone would also pass any other same-origin window holding a
 * reference to this one, and `event.source` can be a MessagePort or a service
 * worker, neither of which has a `location`. Reading `location` off a window
 * that is not same-origin throws, which counts as a rejection.
 */
function fromFriendsPopout(event: MessageEvent): boolean {
  if (event.origin !== location.origin) return false;
  try {
    const source = event.source as Window | null;
    if (!source || source === window) return false;
    return (
      source.location.origin === location.origin &&
      source.location.pathname.startsWith("/friends-popout")
    );
  } catch {
    return false;
  }
}

/**
 * Receives what other windows ask the main window to do: a friends-popout
 * action (open a DM, start a call) and a click on a desktop notification.
 *
 * Mounted in the main window only. Every input is untrusted until
 * `isShellToMain` accepts it, whichever transport it came in on.
 *
 * - Tauri: a `tauri::ipc::Channel` this window registers with the shell. Only
 *   Rust can write to it; any webview holding `core:default` can emit events
 *   to `main`, so an event is not a trustworthy channel for these.
 * - Electron: the preload's `onShellToMain`, fed by the main process.
 * - Web: the popout's `opener.postMessage`, checked by `fromFriendsPopout`.
 */
export function ShellBridgeWorker(): JSX.Element | null {
  const client = useClient();
  const navigate = useNavigate();
  const actions = useUserActions();

  function handle(message: unknown) {
    if (!isShellToMain(message)) {
      // Log the kind only: a payload from a mismatched shell build would
      // otherwise vanish without a trace, and its fields are untrusted.
      const kind = (message as { kind?: unknown } | null)?.kind;
      console.warn(
        "[shell-bridge] dropped message",
        typeof kind === "string" ? kind.slice(0, 32) : typeof kind,
      );
      return;
    }

    switch (message.kind) {
      case "popoutOpenInMain": {
        // A user this session has never seen is not someone the popout
        // could have listed, so the request did not come from its UI.
        if (!client()?.users.get(message.userId)) return;
        actions
          .run(message.action, message.userId)
          .catch((error) => console.error("[shell-bridge]", error));
        return;
      }
      case "notificationOpen":
        navigate(message.path);
        return;
    }
  }

  // Tauri
  onMount(() => {
    const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__;
    if (!tauri) return;

    const invoke = tauriInvoke();
    const Channel = tauri.core?.Channel;
    if (!invoke || !Channel) return;

    // The handler goes on BEFORE the invoke: the Channel starts with a no-op
    // `onmessage` and delivers immediately, so anything sent in between would
    // be dropped.
    const channel = new Channel();
    channel.onmessage = handle;
    // No fallback to the old spoofable `notification_clicked` event. Tauri
    // checks the ACL before it looks the command up, so a shell without this
    // command answers "not allowed by ACL", never "not found", and a fallback
    // keyed on that could never fire. The shell and this frontend ship as a
    // bundled pair, so there is no older shell to serve. A failure here is a
    // build or capability mistake: keep it loud and closed.
    invoke("register_shell_bridge", { channel }).catch((error) =>
      console.error("[shell-bridge] register_shell_bridge failed", error),
    );

    onCleanup(() => {
      // The shell keeps its end until the next registration replaces it.
      channel.onmessage = () => {};
      channel.cleanupCallback?.();
    });
  });

  // Electron
  onMount(() => {
    const unsubscribe = window.slogaShell?.onShellToMain?.(handle);
    if (unsubscribe) onCleanup(unsubscribe);
  });

  // Web. Not gated on the platform: the checks below are the whole trust
  // rule, and a shell's popout has no opener to post from anyway.
  onMount(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | { type?: unknown; action?: unknown; userId?: unknown }
        | null
        | undefined;
      if (data?.type !== POPOUT_WEB_MESSAGE_TYPE) return;
      if (!isPopoutAction(data.action)) return;
      if (typeof data.userId !== "string" || !ULID_RE.test(data.userId)) return;
      if (!fromFriendsPopout(event)) return;

      handle({
        kind: "popoutOpenInMain",
        action: data.action,
        userId: data.userId,
      });
    };

    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
  });

  return null;
}

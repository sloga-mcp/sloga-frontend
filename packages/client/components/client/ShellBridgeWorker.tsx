import { type JSX, onCleanup, onMount } from "solid-js";

import { tauriInvoke } from "@revolt/common";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";

import { useClient, useClientLifecycle } from ".";
import { setWindowMaximized } from "../chatWindows/chatWindowFrame";
import { conversationIdFromPath } from "../chatWindows/dmLinks";
import { routeConversation } from "../chatWindows/openConversation";
import { noteRevoked } from "./mainShell";
import { isShellToMain } from "./shellToMain";
import { clearAllToasts, useToastShell } from "./toastShell";

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
 * Receives what the desktop shell asks the main window to do: a click on a
 * desktop notification, a reply typed into (or a click on) the Windows
 * shell's Sloga toast, a frameless chat window's maximized state, and the
 * shell taking main's own frame back.
 *
 * Mounted in the main window only. Every input is untrusted until
 * `isShellToMain` accepts it.
 *
 * - Tauri: a `tauri::ipc::Channel` this window registers with the shell. Only
 *   Rust can write to it; any webview holding `core:default` can emit events
 *   to `main`, so an event is not a trustworthy channel for these.
 * - Electron: the preload's `onShellToMain`, fed by the main process.
 *
 * The web friends popout, which used to post actions here, is retired, so
 * this window no longer listens for `postMessage` at all.
 */
export function ShellBridgeWorker(): JSX.Element | null {
  const client = useClient();
  const navigate = useNavigate();
  const state = useState();
  const toastShell = useToastShell();
  const { lifecycle } = useClientLifecycle();

  // Toasts belong to the session and the page that showed them. This
  // worker leaves with Interface when signing out lands on /login; the hook
  // fires earlier, while the old client is still alive. The mount clear is
  // for a reloaded page, which starts with an empty map while the shell
  // still shows the old page's toasts; it is queued ahead of the Tauri
  // registration below, so those toasts go before any reply can arrive.
  onCleanup(lifecycle.onSignOut(clearAllToasts));
  onMount(() => {
    clearAllToasts();
    onCleanup(clearAllToasts);
  });

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
      case "notificationOpen": {
        // Chat-windows mode opens a DM or group as a chat-window tab; server
        // channels, and channels this session doesn't know, open in main.
        const channelId = conversationIdFromPath(message.path);
        const channel = channelId ? client()?.channels.get(channelId) : null;
        if (channel?.type === "DirectMessage" || channel?.type === "Group")
          routeConversation(state, channel.id, () => navigate(message.path));
        else navigate(message.path);
        return;
      }
      // No `users.get` check: these name a toast id this window minted, and
      // toastShell resolves the channel from its own map, never the payload.
      case "toastReply":
        toastShell
          .handleReply(message.toastId, message.text)
          // The name only: the error may echo the reply text.
          .catch((error) =>
            console.error(
              "[shell-bridge] toast reply failed",
              error instanceof Error ? error.name : typeof error,
            ),
          );
        return;
      case "toastOpen":
        toastShell.handleOpen(message.toastId);
        return;
      // A frameless chat window's maximized state changed (Tauri only); its
      // title bar shows maximize or restore from this.
      case "chatWindowState":
        setWindowMaximized(message.label, message.maximized);
        return;
      // The Windows shell gave main its OS title bar back; ours goes, for
      // the rest of this page's life.
      case "mainFrameRevoked":
        noteRevoked();
        return;
      default: {
        // A kind added to `ShellToMain` without a case here fails to compile
        // instead of being silently ignored.
        const unhandled: never = message;
        console.warn(
          "[shell-bridge] unhandled kind",
          (unhandled as { kind: string }).kind,
        );
        return;
      }
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

  return null;
}

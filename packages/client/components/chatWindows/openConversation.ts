/**
 * Where "open this conversation" and "open friends" go. In chat-windows mode
 * on a desktop shell they become tabs in a chat window (or the friends
 * window); everywhere else, including the web, the caller's own navigation
 * runs exactly as before. The friends window itself needs only the shell, so
 * the Friends page can pop it out in either mode.
 *
 * Kept free of Solid components, lingui and the app contexts so `node --test`
 * can load it; `State` is a type-only import.
 */
import type { State } from "@revolt/state";

import * as chatShell from "../client/chatShell.ts";

import { openConversation, setFriendsOpen } from "./chatWindowsStore.ts";

/** The slice of `chatShell` the router reads. */
type ShellCaps = Pick<
  typeof chatShell,
  "supported" | "chatWindowsAvailable" | "probeChatWindows"
>;

let shell: ShellCaps = chatShell;
let probeStarted = false;

/**
 * Tests only: read `fake` instead of the real shell bridge (none restores
 * it), and forget that a probe was started.
 */
export function _setChatShell(fake?: ShellCaps): void {
  shell = fake ?? chatShell;
  probeStarted = false;
}

/**
 * This shell can make chat windows. Until its capability has been probed, a
 * shell that has the bridge counts as able, so routing works before settings
 * were ever opened; the first such read starts the probe (once, whichever
 * caller reads first), and later reads use its cached answer.
 */
function shellCanOpenWindows(): boolean {
  if (!shell.supported()) return false;

  const available = shell.chatWindowsAvailable();
  if (available === undefined && !probeStarted) {
    probeStarted = true;
    void shell.probeChatWindows();
  }
  return available !== false;
}

/**
 * Chat-windows mode is on: the device setting asks for it AND this shell can
 * make chat windows. The setting alone is not enough: with no shell (the web,
 * Android), or a shell too old to have the chat-window commands, conversations
 * keep opening in the main window.
 */
export function chatWindowsMode(state: State): boolean {
  if (state.settings.getValue("appearance:dm_windows") !== "chat_windows") {
    return false;
  }
  return shellCanOpenWindows();
}

/**
 * The friends window can open: a desktop shell that can make chat windows, in
 * either mode. False on the web and Android, which keep their own friends
 * popout or page.
 */
export function friendsWindowAvailable(): boolean {
  return shellCanOpenWindows();
}

/**
 * Show the friends window, or raise it when it is already open (the store
 * asks the host to focus it). Callers check {@link friendsWindowAvailable}
 * first; nothing here falls back.
 */
export function openFriendsWindow(): void {
  setFriendsOpen(true);
}

/**
 * Open `channelId` as a chat-window tab in chat-windows mode, otherwise run
 * `fallback` (today's navigation).
 */
export function routeConversation(
  state: State,
  channelId: string,
  fallback: () => void,
): void {
  if (chatWindowsMode(state)) openConversation(channelId);
  else fallback();
}

/**
 * Show the friends window in chat-windows mode, otherwise run `fallback`
 * (today's friends page).
 */
export function routeFriends(state: State, fallback: () => void): void {
  if (chatWindowsMode(state)) setFriendsOpen(true);
  else fallback();
}

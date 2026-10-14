/**
 * Whether the user is reading a conversation right now, the one test
 * NotificationsWorker uses to skip (or take back) a notification for it.
 * Kept free of Solid, the router and the DOM so `node --test` can load it;
 * the worker passes the live facts in.
 */

export type ConversationView = {
  /** The channel the main window's router shows, if any. */
  routeChannelId: string | undefined;
  /** Whether the main window's document holds focus. */
  mainFocused: boolean;
  /**
   * Channels shown in a chat window that holds focus (windowCtx's
   * `focusedConversations()`, which already leaves out unfocused ones).
   */
  chatWindowConversations: ReadonlySet<string>;
};

/**
 * Two places count as reading: the main window with the conversation open
 * and focused, or a focused chat window showing it. A chat window alone does
 * not make the main route count, nor the other way round: each is judged by
 * its own window's focus.
 */
export function isViewingConversation(
  channelId: string,
  view: ConversationView,
): boolean {
  return (
    (view.routeChannelId === channelId && view.mainFocused) ||
    view.chatWindowConversations.has(channelId)
  );
}

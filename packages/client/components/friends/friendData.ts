/**
 * Derived data the friends list and the group chats dock both read: which DM
 * belongs to which friend, what unread pill a conversation shows, who is in
 * game, and the group chats in recent-activity order.
 *
 * Free of lingui and the app contexts so `node --test` can load it with fake
 * clients (`friendData.test.ts`); the only runtime import is Solid's memo.
 * Callers hand in the client as an accessor (`useClient()`), so a client that
 * swaps under a logout or account switch is followed rather than captured.
 */
import { type Accessor, createMemo } from "solid-js";

import type { Channel, Client, User } from "stoat.js";

/** The unread pill a conversation shows; `count` 0 means draw a dot. */
export type ConversationUnread = { count: number; mention: boolean };

/**
 * Each DM keyed by the OTHER participant's user id.
 *
 * Keyed from `recipientIds` rather than `recipient`: `recipient` resolves
 * through the user cache, and a peer missing from it would drop out of the
 * map. Inactive (closed) DMs are kept, since a closed DM can still be unread.
 * Should two DMs ever name the same peer, the active one wins.
 */
export function createDmMap(
  client: Accessor<Client | undefined>,
): Accessor<Map<string, Channel>> {
  const dmMap = createMemo(() => {
    const map = new Map<string, Channel>();
    const c = client();
    const selfId = c?.user?.id;
    if (!c || !selfId) return map;

    for (const channel of c.channels.toList()) {
      if (channel.type !== "DirectMessage") continue;
      for (const userId of channel.recipientIds) {
        if (userId === selfId) continue;
        const existing = map.get(userId);
        if (!existing || (!existing.active && channel.active)) {
          map.set(userId, channel);
        }
      }
    }

    return map;
  });
  return dmMap;
}

/**
 * The pill for one conversation, or null when it should show none.
 *
 * A muted conversation shows nothing at all, mentions included: `unread` only
 * folds in the channel's exclusive mute, so `muted` is checked on its own.
 * A zero `unreadCount` on an unread channel means the server supplied no
 * count, so it stays 0 and the row draws a dot rather than a "0".
 */
export function conversationUnread(ch?: Channel): ConversationUnread | null {
  if (!ch || ch.muted || !ch.unread) return null;
  return {
    count: ch.unreadCount,
    mention: (ch.mentions?.size ?? 0) > 0,
  };
}

/** Whether the user is showing a game; `activity` is already gated on online. */
export function isInGame(u: User): boolean {
  return !!u.activity;
}

/**
 * Group chats, most recently active first.
 *
 * The same list `Ordering.orderedConversations` yields once filtered to
 * groups (it takes every group unconditionally, and DMs only when active).
 * Computed here rather than called because the store pulls in `State`, which
 * would stop this module loading under `node --test`.
 */
export function groupDms(
  client: Accessor<Client | undefined>,
): Accessor<Channel[]> {
  const groups = createMemo(() => {
    const c = client();
    if (!c) return [];
    return c.channels
      .toList()
      .filter((channel) => channel.type === "Group")
      .sort((a, b) => +b.updatedAt - +a.updatedAt);
  });
  return groups;
}

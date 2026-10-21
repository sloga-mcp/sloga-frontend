/**
 * Which channel a native DM conversation id may be shown in (`#dmChannel`,
 * `#syncRecent` and `#syncRecentConversation` in `e2ee.ts`) - pure and
 * dependency-free so `node --test` can load it (the house no-vitest split).
 *
 * Why this exists: native files rows about this account's own devices
 * (`device_added`, `device_readded`, `device_revoked`) under the note-to-self
 * conversation, whose id is the local user's own id. A DM lookup that asks
 * "which DM has this user as a recipient" matches EVERY DM for our own id,
 * because every DM contains us, so it returned whichever DM came first and
 * own-account rows were filed into another person's conversation. Our own id
 * therefore never names a DM or a group here. Those rows stay recorded
 * natively; they are not shown in a dedicated place yet.
 *
 * An unknown local user (or an empty id) counts as note-to-self: with no id
 * to compare against, nothing proves the conversation belongs to a peer, so
 * nothing is filed anywhere (fail closed).
 */

/** The channel fields the DM lookup reads. */
export type DmCandidate = {
  type: string;
  recipientIds: { has(id: string): boolean };
};

/**
 * Where a native DM conversation id resolves:
 * - `none`: note-to-self (or unknown); never shown in any DM or group.
 * - `existing`: the cached DM with that peer.
 * - `open`: no cached DM; the caller may open one with that user.
 */
export type DmResolution<C> =
  | { kind: "none" }
  | { kind: "existing"; channel: C }
  | { kind: "open" };

/**
 * Whether `conversationId` is the note-to-self conversation, or cannot be
 * told apart from it because the local user's id is unknown.
 */
export function isNoteToSelfConversation(
  conversationId: string,
  selfId: string | undefined,
): boolean {
  return !selfId || !conversationId || conversationId === selfId;
}

/**
 * Resolves a native DM conversation id (the peer's user id) against the
 * cached channels. Our own id resolves to `none` even though every DM
 * contains it, and only a `DirectMessage` channel can match, never a group
 * the peer is in.
 */
export function resolveDmConversation<C extends DmCandidate>(
  conversationId: string,
  selfId: string | undefined,
  channels: Iterable<C>,
): DmResolution<C> {
  if (isNoteToSelfConversation(conversationId, selfId)) {
    return { kind: "none" };
  }
  for (const channel of channels) {
    if (
      channel.type === "DirectMessage" &&
      channel.recipientIds.has(conversationId)
    ) {
      return { kind: "existing", channel };
    }
  }
  return { kind: "open" };
}

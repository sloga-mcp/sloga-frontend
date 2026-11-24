/**
 * MessageCache keeps a channel's Message objects when its view unmounts and
 * restores them on the next mount without fetching. stoat.js deletes messages
 * from `client.messages` when a server is left or deleted, and on bulk deletes,
 * which MessageCache never hears about. A restored Message whose store entry
 * is gone renders as an empty row.
 *
 * So an entry is only restorable while every message in it is still cached.
 * Otherwise this returns undefined and the caller fetches.
 *
 * An entry with no messages is not restorable either: a list that a delete
 * emptied has no row to page from, so restoring it would leave the pane
 * blank for good. The caller fetches instead; a channel that really is
 * empty answers with an empty page once and shows its start.
 */
export function restorableEntry<
  T extends { messages: readonly { id: string }[] },
>(entry: T | undefined, has: (id: string) => boolean): T | undefined {
  if (!entry || entry.messages.length === 0) return undefined;
  const live = entry.messages.every((message) => has(message.id));
  return live ? entry : undefined;
}

/**
 * MessageCache keeps a channel's Message objects when its view unmounts and
 * restores them on the next mount without fetching. stoat.js deletes messages
 * from `client.messages` when a server is left or deleted, and on bulk deletes,
 * which MessageCache never hears about. A restored Message whose store entry
 * is gone renders as an empty row.
 *
 * So an entry is only restorable while every message in it is still cached.
 * Otherwise this returns undefined and the caller fetches.
 */
export function restorableEntry<
  T extends { messages: readonly { id: string }[] },
>(entry: T | undefined, has: (id: string) => boolean): T | undefined {
  if (!entry) return undefined;
  const live = entry.messages.every((message) => has(message.id));
  return live ? entry : undefined;
}

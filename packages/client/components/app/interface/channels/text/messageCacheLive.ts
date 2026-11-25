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
 * An entry with no messages is restorable only when it holds the whole
 * channel (`atStart`): a channel or DM that really is empty restores as it
 * is, with no request. Without `atStart` a delete emptied a list that has
 * more history above it and no row left to page from, so restoring it would
 * leave the pane blank for good; the caller fetches instead.
 */
export function restorableEntry<
  T extends { messages: readonly { id: string }[]; atStart?: boolean },
>(entry: T | undefined, has: (id: string) => boolean): T | undefined {
  if (!entry) return undefined;
  if (entry.messages.length === 0 && entry.atStart !== true) return undefined;
  const live = entry.messages.every((message) => has(message.id));
  return live ? entry : undefined;
}

/**
 * The cached entry a list may restore. A protected or pinned list never
 * restores an entry with no messages, whatever the entry says about its
 * position: a wipe can empty a list whose `atStart` was set before the wipe,
 * and that list has to ask the server again. Any other list takes the entry
 * as the cache returned it.
 * @param entry Entry the cache returned, if any
 * @param protectedOrPinned `client.isProtectedChannel(id)`
 * @returns The entry, or undefined when the caller must fetch
 */
export function restorableForList<
  T extends { messages: readonly { id: string }[] },
>(entry: T | undefined, protectedOrPinned: boolean): T | undefined {
  if (!entry) return undefined;
  if (protectedOrPinned !== false && entry.messages.length === 0) {
    return undefined;
  }
  return entry;
}

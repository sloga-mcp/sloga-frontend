/**
 * Roots of the TanStack queries that cache a list of channels fetched under a
 * parent channel: a forum's posts (`["forum_posts", forumId, ...]`) and a text
 * channel's threads (`["threads", parentId, archived]`).
 */
export const CHANNEL_LIST_QUERY_ROOTS: ReadonlySet<string> = new Set([
  "forum_posts",
  "threads",
]);

/**
 * Keep only the channels that are still in the client's channel store.
 *
 * Leaving or losing a server sweeps its threads and forum posts out of
 * `client.channels`, but a cached query result still holds the old Channel
 * objects. Their getters read the emptied store entry, so the name and server
 * come back undefined until a refetch caches them again.
 * @param channels Channels from a cached query result
 * @param has Whether the client still caches a channel id
 * @returns The channels still cached, in their original order
 */
export function cachedChannels<T extends { id: string }>(
  channels: readonly T[],
  has: (id: string) => boolean,
): T[] {
  return channels.filter((channel) => has(channel.id));
}

/**
 * Whether a query caches a channel list under a channel of the given server,
 * so it should be dropped when that server is left or deleted.
 * @param queryKey Key of a cached query
 * @param serverId Server being left or deleted
 * @param serverOf Server a cached channel belongs to, if any
 * @returns Whether the query should be removed
 */
export function isServerChannelListQuery(
  queryKey: readonly unknown[],
  serverId: string,
  serverOf: (channelId: string) => string | undefined,
): boolean {
  const [root, parentId] = queryKey;
  return (
    typeof root === "string" &&
    CHANNEL_LIST_QUERY_ROOTS.has(root) &&
    typeof parentId === "string" &&
    serverOf(parentId) === serverId
  );
}

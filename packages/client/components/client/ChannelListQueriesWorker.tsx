import { createEffect, onCleanup } from "solid-js";

import { useQueryClient } from "@tanstack/solid-query";

import { isServerChannelListQuery } from "@revolt/common/lib/channelListQueries";

import { useClient } from ".";

/**
 * Drop cached forum post and thread lists of a server when it is left or
 * deleted.
 *
 * stoat.js sweeps that server's threads and forum posts out of
 * `client.channels`, but the cached lists keep their Channel objects for the
 * query's gcTime. Rejoining within that window would first show those emptied
 * objects (no name, no server) until the refetch lands; with the lists gone,
 * the views load from scratch instead.
 */
export function ChannelListQueriesWorker() {
  const client = useClient();
  const queryClient = useQueryClient();

  createEffect(() => {
    const c = client();

    // Emitted before the sweep, so the parent channels are still cached and
    // still say which server they belong to.
    const onServerGone = (server: { id: string }) =>
      queryClient.removeQueries({
        predicate: (query) =>
          isServerChannelListQuery(
            query.queryKey,
            server.id,
            (channelId) => c.channels.get(channelId)?.serverId,
          ),
      });

    c.addListener("serverLeave", onServerGone);
    c.addListener("serverDelete", onServerGone);
    onCleanup(() => {
      c.removeListener("serverLeave", onServerGone);
      c.removeListener("serverDelete", onServerGone);
    });
  });

  return null;
}

import { For, Show, Suspense, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { useQuery } from "@tanstack/solid-query";
import { API, Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { Message } from "@revolt/app";
import { useClient } from "@revolt/client";
import { searchCopy } from "@revolt/client/protectedCopy";
import { Button, CircularProgress, Row, Text } from "@revolt/ui";

/**
 * Message search sidebar
 */
export function TextSearchSidebar(props: {
  channel: Channel;
  query: Omit<API.DataMessageSearch, "include_users">;
}) {
  const client = useClient();
  const [sort, setSort] = createSignal<API.DataMessageSearch["sort"]>("Latest");

  /**
   * A text query on a Protected channel (server-flagged or pinned on this
   * device) never reaches the server (plan C15, design 7.4/7.5): the server
   * holds no readable text to search, and the query itself would leak. The
   * pinned listing (no `query`) still loads; its rows render through
   * `Message`, which shows the decrypted view or a marker, never the server
   * text (plan D22/D25).
   */
  const protectedTextQuery = () =>
    props.query.query !== undefined &&
    client().isProtectedChannel(props.channel.id);

  const query = useQuery(() => ({
    queryKey: ["search", props.channel.id, props.query, sort()],
    enabled: !protectedTextQuery(),
    queryFn: () =>
      protectedTextQuery()
        ? Promise.resolve([])
        : props.channel
            .searchWithUsers(
              props.query.sort
                ? props.query
                : {
                    ...props.query,
                    sort: sort(),
                  },
            )
            .then((result) => result.messages),
  }));

  return (
    <>
      <Show when={!props.query.sort && !protectedTextQuery()}>
        <Row justify="stretch">
          <Button
            group="connected-start"
            groupActive={sort() === "Relevance"}
            onPress={() => setSort("Relevance")}
          >
            <Trans>Relevance</Trans>
          </Button>
          <Button
            group="connected"
            groupActive={sort() === "Latest"}
            onPress={() => setSort("Latest")}
          >
            <Trans>Latest</Trans>
          </Button>
          <Button
            group="connected-end"
            groupActive={sort() === "Oldest"}
            onPress={() => setSort("Oldest")}
          >
            <Trans>Oldest</Trans>
          </Button>
        </Row>
      </Show>
      <Show
        when={!protectedTextQuery()}
        fallback={
          <ProtectedSearchNotice data-protected-search-notice>
            <Text class="body" size="medium">
              {searchCopy.textSearchUnavailable()}
            </Text>
          </ProtectedSearchNotice>
        }
      >
        <Suspense fallback={<CircularProgress />}>
          <For each={query.data}>
            {(message) => (
              <a href={message.path}>
                <Message message={message} isLink />
              </a>
            )}
          </For>
        </Suspense>
      </Show>
    </>
  );
}

/**
 * Shown in place of results for a text query on a Protected channel
 */
const ProtectedSearchNotice = styled("div", {
  base: {
    padding: "var(--gap-md)",
    color: "var(--md-sys-color-on-surface-variant)",
    textAlign: "center",
  },
});

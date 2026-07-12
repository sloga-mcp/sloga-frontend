import { For, Show, Suspense, createSignal, onCleanup } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { useQuery } from "@tanstack/solid-query";
import { Channel, HydratedChannel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { Button, CircularProgress, Row, Text } from "@revolt/ui";
import { Time } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * List of threads under a text channel (active / archived tabs)
 */
export function ThreadsListSidebar(props: { channel: Channel }) {
  const client = useClient();
  const { openModal } = useModals();
  const [archived, setArchived] = createSignal(false);

  const query = useQuery(() => ({
    queryKey: ["threads", props.channel.id, archived()],
    queryFn: () => props.channel.fetchThreads({ archived: archived() }),
  }));

  // Keep the list live: new threads and archive transitions arrive as
  // threadCreate / channelUpdate events
  const liveClient = client();

  /**
   * Refetch when a thread under this channel changes
   */
  function onThreadChange(channel: Channel) {
    if (channel.isThread && channel.parentChannelId === props.channel.id) {
      query.refetch();
    }
  }

  /**
   * Refetch when a thread under this channel is deleted — channelDelete
   * emits the hydrated snapshot, not a live Channel object
   */
  function onThreadDelete(channel: HydratedChannel) {
    if (
      channel.channelType === "Thread" &&
      channel.parentChannelId === props.channel.id
    ) {
      query.refetch();
    }
  }

  liveClient.on("threadCreate", onThreadChange);
  liveClient.on("channelUpdate", onThreadChange);
  liveClient.on("channelDelete", onThreadDelete);

  onCleanup(() => {
    liveClient.removeListener("threadCreate", onThreadChange);
    liveClient.removeListener("channelUpdate", onThreadChange);
    liveClient.removeListener("channelDelete", onThreadDelete);
  });

  return (
    <ListBase>
      <Row justify="stretch">
        <Button
          group="connected-start"
          groupActive={!archived()}
          onPress={() => setArchived(false)}
        >
          <Trans>Active</Trans>
        </Button>
        <Button
          group="connected-end"
          groupActive={archived()}
          onPress={() => setArchived(true)}
        >
          <Trans>Archived</Trans>
        </Button>
      </Row>

      <Show when={props.channel.havePermission("SendMessage")}>
        <Button
          size="sm"
          variant="text"
          onPress={() =>
            openModal({
              type: "create_thread",
              channel: props.channel,
            })
          }
        >
          <Trans>Create Thread</Trans>
        </Button>
      </Show>

      <Suspense fallback={<CircularProgress />}>
        <Show when={query.data?.length === 0}>
          <Text>
            <Show when={archived()} fallback={<Trans>No active threads</Trans>}>
              <Trans>No archived threads</Trans>
            </Show>
          </Text>
        </Show>
        <For each={query.data}>
          {(thread) => (
            <a href={thread.path}>
              <ThreadEntry>
                <Symbol size={18}>subdirectory_arrow_right</Symbol>
                <ThreadEntryDetails>
                  <Text class="label">{thread.name}</Text>
                  <Show when={thread.lastMessageAt}>
                    <Text class="label" size="small">
                      <Time format="relative" value={thread.lastMessageAt!} />
                    </Text>
                  </Show>
                </ThreadEntryDetails>
                <Show when={thread.unread}>
                  <UnreadDot />
                </Show>
              </ThreadEntry>
            </a>
          )}
        </For>
      </Suspense>
    </ListBase>
  );
}

/**
 * List container
 */
const ListBase = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    color: "var(--md-sys-color-on-surface)",
  },
});

/**
 * Individual thread entry
 */
const ThreadEntry = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    transition: "var(--transitions-fast) background",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
});

/**
 * Thread name and last activity
 */
const ThreadEntryDetails = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
});

/**
 * Unread indicator dot
 */
const UnreadDot = styled("div", {
  base: {
    width: "8px",
    height: "8px",
    flexShrink: 0,
    borderRadius: "var(--borderRadius-circle)",
    background: "var(--md-sys-color-primary)",
  },
});

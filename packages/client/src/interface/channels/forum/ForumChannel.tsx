import {
  For,
  Show,
  Suspense,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { useQuery } from "@tanstack/solid-query";
import { Channel, HydratedChannel, Message } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { Button, CircularProgress, Header, Row, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { ChannelHeader } from "../ChannelHeader";
import { ChannelPageProps } from "../ChannelPage";

import { PostCard } from "./PostCard";

/** Server page size for GET /posts */
const PAGE_SIZE = 50;

/**
 * Forum channel browse view: a card grid of posts with tag filtering,
 * sorting by latest activity or creation date, and cursor pagination
 */
export function ForumChannel(props: ChannelPageProps) {
  const client = useClient();
  const { openModal, showError } = useModals();

  const [sort, setSort] = createSignal<"latest_activity" | "creation_date">(
    props.channel.defaultSort === "CreationDate"
      ? "creation_date"
      : "latest_activity",
  );
  const [tag, setTag] = createSignal<string | undefined>(undefined);
  const [archived, setArchived] = createSignal(false);

  // Pages beyond the first, loaded through the `before` cursor.
  const [extraPosts, setExtraPosts] = createSignal<Channel[]>([]);
  const [extraStarters, setExtraStarters] = createSignal<Message[]>([]);
  const [exhausted, setExhausted] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);

  // Changing the filter/sort invalidates the loaded tail.
  createEffect(
    on([sort, tag, archived], () => {
      setExtraPosts([]);
      setExtraStarters([]);
      setExhausted(false);
    }),
  );

  const query = useQuery(() => ({
    queryKey: ["forum_posts", props.channel.id, sort(), tag(), archived()],
    queryFn: () =>
      props.channel.fetchPosts({
        sort: sort(),
        tag: tag(),
        archived: archived(),
        includeStarters: true,
      }),
  }));

  /**
   * Client-side mirror of the server's sort key so merged pages stay ordered
   */
  const sortKey = (post: Channel) =>
    sort() === "creation_date" ? post.id : (post.lastMessageId ?? post.id);

  // First page merged with cursor-loaded pages, deduplicated (a live refetch
  // of page one can overlap the tail) and re-sorted.
  const posts = createMemo(() => {
    const seen = new Set<string>();
    const merged: Channel[] = [];
    for (const post of [...(query.data?.posts ?? []), ...extraPosts()]) {
      if (!seen.has(post.id)) {
        seen.add(post.id);
        merged.push(post);
      }
    }
    return merged.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  });

  async function loadMore() {
    const tail = posts().at(-1);
    if (!tail || loadingMore()) return;
    setLoadingMore(true);
    try {
      const page = await props.channel.fetchPosts({
        sort: sort(),
        tag: tag(),
        archived: archived(),
        before: sortKey(tail),
        limit: PAGE_SIZE,
        includeStarters: true,
      });
      setExtraPosts((posts) => [...posts, ...page.posts]);
      setExtraStarters((starters) => [...starters, ...(page.starters ?? [])]);
      if (page.posts.length < PAGE_SIZE) setExhausted(true);
    } catch (error) {
      showError(error);
    } finally {
      setLoadingMore(false);
    }
  }

  const mayHaveMore = () =>
    !exhausted() && (query.data?.posts.length ?? 0) >= PAGE_SIZE;

  // Viewing the browse view reads the forum: acknowledge it so the sidebar
  // unread dot clears (posts keep their own per-thread unread state).
  createEffect(
    on(
      () => query.data && props.channel.unread,
      (unread) => {
        if (unread && document.hasFocus()) {
          props.channel.ack();
        }
      },
    ),
  );

  /**
   * Mark as read on re-focus while the browse view is open
   */
  function onFocus() {
    if (props.channel.unread) {
      props.channel.ack();
    }
  }

  document.addEventListener("focus", onFocus);
  onCleanup(() => document.removeEventListener("focus", onFocus));

  // Keep the grid live: new posts arrive as threadCreate, tag/archive edits
  // as channelUpdate, deletions as channelDelete, and replies (activity
  // bumps) as messageCreate on the post's own channel.
  const liveClient = client();

  /**
   * Refetch when a post under this forum changes, or the forum itself does
   */
  function onPostChange(channel: Channel) {
    if (
      channel.id === props.channel.id ||
      (channel.isThread && channel.parentChannelId === props.channel.id)
    ) {
      query.refetch();
    }
  }

  /**
   * Refetch when a post under this forum is deleted — channelDelete emits
   * the hydrated snapshot, not a live Channel object
   */
  function onPostDelete(channel: HydratedChannel) {
    if (
      channel.channelType === "Thread" &&
      channel.parentChannelId === props.channel.id
    ) {
      query.refetch();
    }
  }

  /**
   * Refetch when a reply lands in one of this forum's posts so the
   * activity sort and reply counts stay fresh
   */
  function onMessage(message: Message) {
    if (message.channel?.parentChannelId === props.channel.id) {
      query.refetch();
    }
  }

  liveClient.on("threadCreate", onPostChange);
  liveClient.on("channelUpdate", onPostChange);
  liveClient.on("channelDelete", onPostDelete);
  liveClient.on("messageCreate", onMessage);

  onCleanup(() => {
    liveClient.removeListener("threadCreate", onPostChange);
    liveClient.removeListener("channelUpdate", onPostChange);
    liveClient.removeListener("channelDelete", onPostDelete);
    liveClient.removeListener("messageCreate", onMessage);
  });

  /**
   * Starter message for a post (its id equals the post's id)
   */
  const starterFor = (post: Channel) =>
    query.data?.starters?.find((starter) => starter.id === post.id) ??
    extraStarters().find((starter) => starter.id === post.id);

  return (
    <Base>
      <Header placement="primary">
        <ChannelHeader channel={props.channel} />
      </Header>

      <Toolbar>
        <Row align gap="sm" wrap>
          <Button
            group="connected-start"
            groupActive={sort() === "latest_activity"}
            size="sm"
            onPress={() => setSort("latest_activity")}
          >
            <Trans>Latest activity</Trans>
          </Button>
          <Button
            group="connected-end"
            groupActive={sort() === "creation_date"}
            size="sm"
            onPress={() => setSort("creation_date")}
          >
            <Trans>Creation date</Trans>
          </Button>

          <Button
            size="sm"
            variant={archived() ? "filled" : "text"}
            onPress={() => setArchived((archived) => !archived)}
          >
            <Trans>Archived</Trans>
          </Button>

          <Grow />

          <Show when={props.channel.havePermission("SendMessage")}>
            <Button
              size="sm"
              onPress={() =>
                openModal({
                  type: "create_forum_post",
                  channel: props.channel,
                })
              }
            >
              <Symbol size={18}>add</Symbol> <Trans>New Post</Trans>
            </Button>
          </Show>
        </Row>

        <Show when={props.channel.tags.length}>
          <Row align gap="sm" wrap>
            <For each={props.channel.tags}>
              {(forumTag) => (
                <TagChip
                  selected={tag() === forumTag.id}
                  onClick={() =>
                    setTag((current) =>
                      current === forumTag.id ? undefined : forumTag.id,
                    )
                  }
                >
                  <Show when={forumTag.emoji}>{forumTag.emoji} </Show>
                  {forumTag.name}
                </TagChip>
              )}
            </For>
          </Row>
        </Show>
      </Toolbar>

      <Scroll>
        <Suspense fallback={<CircularProgress />}>
          <Show when={posts().length === 0 && !query.isLoading}>
            <Text>
              <Show when={archived()} fallback={<Trans>No posts yet</Trans>}>
                <Trans>No archived posts</Trans>
              </Show>
            </Text>
          </Show>
          <Grid>
            <For each={posts()}>
              {(post) => (
                <PostCard
                  post={post}
                  forum={props.channel}
                  starter={starterFor(post)}
                />
              )}
            </For>
          </Grid>
          <Show when={mayHaveMore()}>
            <LoadMoreRow>
              <Button
                size="sm"
                variant="text"
                isDisabled={loadingMore()}
                onPress={loadMore}
              >
                <Show when={!loadingMore()} fallback={<CircularProgress />}>
                  <Trans>Load more</Trans>
                </Show>
              </Button>
            </LoadMoreRow>
          </Show>
        </Suspense>
      </Scroll>
    </Base>
  );
}

const Base = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    color: "var(--md-sys-color-on-surface)",
  },
});

const Toolbar = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    padding: "var(--gap-md) var(--gap-lg)",
  },
});

const Grow = styled("div", {
  base: {
    flexGrow: 1,
  },
});

const TagChip = styled("button", {
  base: {
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    transition: "var(--transitions-fast) all",
    fontSize: "0.8125rem",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
    },
  },
  variants: {
    selected: {
      true: {
        background: "var(--md-sys-color-primary-container)",
        color: "var(--md-sys-color-on-primary-container)",
      },
    },
  },
});

const Scroll = styled("div", {
  base: {
    overflowY: "auto",
    flexGrow: 1,
    minHeight: 0,
    padding: "0 var(--gap-lg) var(--gap-lg)",
  },
});

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "var(--gap-md)",
    alignContent: "start",
  },
});

const LoadMoreRow = styled("div", {
  base: {
    display: "flex",
    justifyContent: "center",
    padding: "var(--gap-md)",
  },
});

import {
  For,
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQuery } from "@tanstack/solid-query";
import { Channel, HydratedChannel, Message } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import {
  ForumLayout,
  isForumLayout,
  resolveLayout,
} from "@revolt/common/lib/forumLayout";
import { TextWithEmoji } from "@revolt/markdown";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import { Button, CircularProgress, Header, Row, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import MdCheck from "@material-design-icons/svg/outlined/check.svg?component-solid";

import { ContextMenu, ContextMenuButton } from "@revolt/app/menus/ContextMenu";

import { ChannelHeader } from "../ChannelHeader";
import { ChannelPageProps } from "../ChannelPage";

import { PostCard } from "./PostCard";
import { PostRow } from "./PostRow";
import { PostTable } from "./PostTable";

/** Server page size for GET /posts */
const PAGE_SIZE = 50;

/**
 * How long live events are gathered before the post list refetches, so a
 * burst of replies or deletions costs one query (and one stats aggregation)
 * rather than one per event.
 */
const REFETCH_DELAY_MS = 1000;

/** Reply count and newest message of a post, as `GET /posts` reports them */
type PostStats = { replies: number; lastMessageId?: string };

/** The `sort` values `GET /posts` accepts. */
type SortMode = "latest_activity" | "creation_date" | "alphabetical";

/**
 * Map a forum's stored `default_sort` onto the query parameter
 * @param order Forum's configured default ordering
 */
function sortModeFor(order: string): SortMode {
  if (order === "CreationDate") return "creation_date";
  if (order === "Alphabetical") return "alphabetical";
  return "latest_activity";
}

/**
 * Name of a sort mode. Written as three literal `Trans` elements rather than
 * a lookup table so each label is a literal lingui msgid.
 */
function SortName(props: { mode: SortMode }) {
  return (
    <Switch fallback={<Trans>Latest activity</Trans>}>
      <Match when={props.mode === "creation_date"}>
        <Trans>Creation date</Trans>
      </Match>
      <Match when={props.mode === "alphabetical"}>
        <Trans>A-Z</Trans>
      </Match>
    </Switch>
  );
}

/**
 * Forum channel browse view: posts as cards (Modern), rows (Classic) or a
 * table (Classic+), with tag filtering, sorting by latest activity or
 * creation date, and cursor pagination
 */
export function ForumChannel(props: ChannelPageProps) {
  const client = useClient();
  const state = useState();
  const { openModal, showError } = useModals();
  const { t } = useLingui();

  /**
   * Name of a forum layout: the one place a layout maps to its label, used
   * for the layout button and inside the "forum's default" message. One
   * literal `t` per value so each label is a literal lingui msgid; the
   * `never` check fails the build if a layout is added without a label.
   * @param value Layout to name
   */
  const layoutLabel = (value: ForumLayout): string => {
    switch (value) {
      case "Modern":
        return t`Modern`;
      case "Classic":
        return t`Classic`;
      case "ClassicPlus":
        return t`Classic+`;
      default: {
        const exhaustive: never = value;
        return exhaustive;
      }
    }
  };

  /**
   * The reader's own pick for this forum (device-local), if it is one this
   * client can render. Undefined means the reader follows the forum's default.
   */
  const layoutOverride = (): ForumLayout | undefined => {
    const value = state.settings.getValue("forum:layout")?.[props.channel.id];
    return isForumLayout(value) ? value : undefined;
  };

  /**
   * The layout the reader gets by following the forum: its default as
   * moderators set it, else Modern
   */
  const forumDefaultLayout = (): ForumLayout =>
    resolveLayout(undefined, props.channel.defaultLayout);

  // The reader's own pick for this forum, else the forum's default as
  // moderators set it, else Modern.
  const layout = createMemo<ForumLayout>(() =>
    resolveLayout(layoutOverride(), props.channel.defaultLayout),
  );

  // Only the row and table layouts show reply counts and last repliers, so
  // only they ask the server for the per-post stats aggregation.
  const withStats = () => layout() !== "Modern";

  /**
   * Save a personal layout for this forum, keeping the picks for every
   * other forum
   * @param value Layout to use here from now on
   */
  function chooseLayout(value: ForumLayout) {
    state.settings.setValue("forum:layout", {
      ...state.settings.getValue("forum:layout"),
      [props.channel.id]: value,
    });
  }

  /**
   * Drop the personal layout for this forum so it follows the forum's
   * default again, keeping the picks for every other forum.
   *
   * Writes `undefined` for this forum rather than deleting the key from a
   * copy: the settings store merges an object written over an object, so a
   * key missing from the new value survives, while one set to `undefined` is
   * removed. The settings validator drops non-layout values on load anyway.
   */
  function followForumDefault() {
    state.settings.setValue("forum:layout", {
      ...state.settings.getValue("forum:layout"),
      [props.channel.id]: undefined,
    } as Record<string, ForumLayout>);
  }

  // Going straight from one forum to another reuses this component (the
  // channel page does not remount it), so each visit to a forum starts from
  // that forum's own filters, with the order it was configured with when the
  // reader opened it.
  const channelId = createMemo(() => props.channel.id);
  const visit = createMemo(
    on(channelId, () => ({
      defaultSort: sortModeFor(props.channel.defaultSort),
    })),
  );

  /** Filters the reader picked, tagged with the visit they were picked on */
  type Filters = {
    visit: ReturnType<typeof visit>;
    tag?: string;
    archived?: boolean;
    sort?: SortMode;
  };
  const [filters, setFilters] = createSignal<Filters>();

  // Filters picked on another visit read as unset. The query reads them
  // synchronously as the forum changes, so its first request for a newly
  // opened forum already carries that forum's defaults rather than the
  // previous forum's filters; returning to a forum also starts it afresh.
  const ownFilters = () => {
    const current = filters();
    return current?.visit === visit() ? current : undefined;
  };

  /**
   * Change some of the filters for the forum on screen
   * @param patch Filters to change; the rest keep their current value
   */
  function updateFilters(patch: Omit<Filters, "visit">) {
    setFilters({ ...ownFilters(), ...patch, visit: visit() });
  }

  // Memos, so a write to one filter does not notify readers of the others,
  // and picking the value already in effect notifies no one.
  const tag = createMemo(() => ownFilters()?.tag);
  const archived = createMemo(() => ownFilters()?.archived ?? false);
  const chosenSort = createMemo(
    () => ownFilters()?.sort ?? visit().defaultSort,
  );

  // A forum can impose its order on everyone. The server enforces it, so the
  // client must ask for the same thing rather than send a `sort` that comes
  // back ignored — otherwise the merged page order below would disagree with
  // the order the pages actually arrived in.
  const sort = createMemo<SortMode>(() =>
    props.channel.forceSort
      ? sortModeFor(props.channel.defaultSort)
      : chosenSort(),
  );

  // Pages beyond the first, loaded through the `before` cursor.
  const [extraPosts, setExtraPosts] = createSignal<Channel[]>([]);
  const [extraStarters, setExtraStarters] = createSignal<Message[]>([]);
  const [extraStats, setExtraStats] = createSignal<Map<string, PostStats>>(
    new Map(),
  );
  const [extraLastMessages, setExtraLastMessages] = createSignal<Message[]>([]);
  const [exhausted, setExhausted] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);

  // Bumped by every reset of the loaded tail. A "Load more" request that was
  // in flight across a reset fetched a page of the old forum, filter, sort or
  // layout, so it is dropped instead of appended to the new list.
  let generation = 0;

  /**
   * Forget every cursor-loaded page
   */
  function clearLoadedPages() {
    generation++;
    setExtraPosts([]);
    setExtraStarters([]);
    setExtraStats(new Map());
    setExtraLastMessages([]);
    setExhausted(false);
    // A page still in flight is dropped when it lands, so it no longer
    // blocks "Load more" for the new list.
    setLoadingMore(false);
  }

  // Changing the filter/sort invalidates the loaded tail, and so does
  // switching between the card view and a stats view (pages loaded without
  // stats would otherwise show no counts) or to another forum.
  createEffect(
    on([channelId, sort, tag, archived, withStats], () => clearLoadedPages()),
  );

  const query = useQuery(() => ({
    queryKey: [
      "forum_posts",
      props.channel.id,
      sort(),
      tag(),
      archived(),
      withStats(),
    ],
    queryFn: () =>
      props.channel.fetchPosts({
        sort: sort(),
        tag: tag(),
        archived: archived(),
        includeStarters: true,
        includeStats: withStats(),
        includeUsers: true,
      }),
  }));

  /**
   * Client-side mirror of the server's sort key so merged pages stay ordered.
   * The A-Z key mirrors `alphabetical_key` in the delta route exactly,
   * including the NUL tiebreaker on the post id — two posts can share a name.
   */
  const keyFor = (post: Channel, mode: SortMode) => {
    if (mode === "alphabetical")
      return `${post.name.toLowerCase()}\0${post.id}`;
    if (mode === "creation_date") return post.id;
    return post.lastMessageId ?? post.id;
  };

  const sortKey = (post: Channel) => keyFor(post, sort());

  // First page merged with cursor-loaded pages, deduplicated (a live refetch
  // of page one can overlap the tail) and re-sorted.
  const posts = createMemo(() => {
    // Read the mode once for the whole pass rather than per comparison: the
    // comparators below then hold no reactivity of their own, and the sort
    // cannot see the mode change halfway through its own ordering.
    const mode = sort();

    const seen = new Set<string>();
    const merged: Channel[] = [];
    for (const post of [...(query.data?.posts ?? []), ...extraPosts()]) {
      if (!seen.has(post.id)) {
        seen.add(post.id);
        merged.push(post);
      }
    }

    // A-Z reads ascending, and compares by code unit rather than with
    // `localeCompare`: the server orders raw UTF-8 bytes, and locale
    // collation treats the NUL tiebreaker as ignorable, which would order
    // same-named posts differently here than in the pages being merged.
    if (mode === "alphabetical") {
      return merged.sort((a, b) => {
        const left = keyFor(a, mode);
        const right = keyFor(b, mode);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    }

    return merged.sort((a, b) =>
      keyFor(b, mode).localeCompare(keyFor(a, mode)),
    );
  });

  async function loadMore() {
    const tail = posts().at(-1);
    if (!tail || loadingMore()) return;
    const started = generation;
    setLoadingMore(true);
    try {
      const page = await props.channel.fetchPosts({
        sort: sort(),
        tag: tag(),
        archived: archived(),
        // A-Z pages on the post's id, which the route resolves to the real
        // sort key server-side — the key itself embeds a NUL and cannot be
        // spelled in a query string. Every other order pages on the key.
        before: sort() === "alphabetical" ? tail.id : sortKey(tail),
        limit: PAGE_SIZE,
        includeStarters: true,
        includeStats: withStats(),
        includeUsers: true,
      });
      // The list was reset while this page was loading: it belongs to a
      // forum, filter, sort or layout that is no longer on screen.
      if (started !== generation) return;
      setExtraPosts((posts) => [...posts, ...page.posts]);
      setExtraStarters((starters) => [...starters, ...(page.starters ?? [])]);
      // Absent (not requested, no Read Message History, or an older server)
      // leaves the map alone, so those rows simply show no counts.
      const pageStats = page.stats;
      if (pageStats) {
        setExtraStats((stats) => new Map([...stats, ...pageStats]));
      }
      setExtraLastMessages((messages) => [
        ...messages,
        ...(page.lastMessages ?? []),
      ]);
      if (page.posts.length < PAGE_SIZE) setExhausted(true);
    } catch (error) {
      // A failed page for a list that has since been reset is as stale as a
      // successful one; only the current list's failures are shown.
      if (started === generation) showError(error);
    } finally {
      // After a reset the flag belongs to the new list (the reset cleared
      // it, and a newer request may have set it again).
      if (started === generation) setLoadingMore(false);
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

  // Keep the list live: new posts arrive as threadCreate, tag/archive edits
  // as channelUpdate, deletions as channelDelete, replies (activity bumps)
  // as messageCreate on the post's own channel, and removed replies as
  // messageDeleteId / messageDeleteBulk.
  const liveClient = client();

  // Every live trigger goes through one pending timer. The first event
  // schedules a refetch and later ones join it, so a burst costs one query;
  // the timer is not restarted per event, so a steady stream of replies
  // still refreshes the list once per window instead of never.
  let refetchTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Refetch the first page shortly, unless a refetch is already pending
   */
  function scheduleRefetch() {
    if (refetchTimer !== undefined) return;
    refetchTimer = setTimeout(() => {
      refetchTimer = undefined;
      void query.refetch();
    }, REFETCH_DELAY_MS);
  }

  /**
   * Drop the pending refetch, if any
   */
  function cancelRefetch() {
    clearTimeout(refetchTimer);
    refetchTimer = undefined;
  }

  // Going to another forum reuses this component, so a refetch still pending
  // from the previous forum would fire against the new one's query. Events
  // gathered for the old forum say nothing about the new one: drop them.
  createEffect(on(channelId, cancelRefetch, { defer: true }));

  onCleanup(cancelRefetch);

  /**
   * Whether a channel id names one of this forum's posts. Only posts the
   * client has cached can match, which covers every post on screen: the
   * list fetch caches each one.
   * @param channelId Channel the event happened in
   */
  function isOwnPost(channelId: string | undefined) {
    return (
      !!channelId &&
      liveClient.channels.get(channelId)?.parentChannelId === props.channel.id
    );
  }

  /**
   * Refetch when a post under this forum changes, or the forum itself does
   */
  function onPostChange(channel: Channel) {
    if (
      channel.id === props.channel.id ||
      (channel.isThread && channel.parentChannelId === props.channel.id)
    ) {
      scheduleRefetch();
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
      scheduleRefetch();
    }
  }

  /**
   * Refetch when a reply lands in one of this forum's posts so the
   * activity sort and reply counts stay fresh
   */
  function onMessage(message: Message) {
    if (message.channel?.parentChannelId === props.channel.id) {
      scheduleRefetch();
    }
  }

  /**
   * Refetch when any message in one of this forum's posts is deleted, cached
   * or not, so reply counts and last repliers drop it
   * @param _id Deleted message
   * @param channelId Channel it was deleted from
   */
  function onMessageDeleteId(_id: string, channelId: string) {
    if (isOwnPost(channelId)) scheduleRefetch();
  }

  /**
   * Refetch when messages in one of this forum's posts are deleted in bulk.
   * The channel is only present when the client has it cached.
   * @param _messages Deleted messages the client had cached
   * @param channel Channel they were deleted from, if cached
   */
  function onMessageDeleteBulk(_messages: unknown[], channel?: Channel) {
    if (isOwnPost(channel?.id)) scheduleRefetch();
  }

  onMount(() => {
    liveClient.on("threadCreate", onPostChange);
    liveClient.on("channelUpdate", onPostChange);
    liveClient.on("channelDelete", onPostDelete);
    liveClient.on("messageCreate", onMessage);
    liveClient.on("messageDeleteId", onMessageDeleteId);
    liveClient.on("messageDeleteBulk", onMessageDeleteBulk);
  });

  onCleanup(() => {
    liveClient.removeListener("threadCreate", onPostChange);
    liveClient.removeListener("channelUpdate", onPostChange);
    liveClient.removeListener("channelDelete", onPostDelete);
    liveClient.removeListener("messageCreate", onMessage);
    liveClient.removeListener("messageDeleteId", onMessageDeleteId);
    liveClient.removeListener("messageDeleteBulk", onMessageDeleteBulk);
  });

  /**
   * Starter message for a post (its id equals the post's id)
   */
  const starterFor = (post: Channel) =>
    query.data?.starters?.find((starter) => starter.id === post.id) ??
    extraStarters().find((starter) => starter.id === post.id);

  /**
   * Reply count and newest message id for a post: the first page's stats,
   * else a cursor-loaded page's. Undefined when the server sent none for it
   * (Modern view, no Read Message History, or an older server), which the
   * rows read as "hide the count".
   * @param post Post to look up
   */
  const statsFor = (post: Channel): PostStats | undefined =>
    query.data?.stats?.get(post.id) ?? extraStats().get(post.id);

  /**
   * Newest message in a post, as the stats name it
   * @param post Post to look up
   */
  const lastMessageFor = (post: Channel): Message | undefined => {
    const id = statsFor(post)?.lastMessageId;
    if (!id) return undefined;
    return (
      query.data?.lastMessages?.find((message) => message.id === id) ??
      extraLastMessages().find((message) => message.id === id) ??
      liveClient.messages.get(id)
    );
  };

  return (
    <Base>
      <Header placement="primary">
        <ChannelHeader channel={props.channel} />
      </Header>

      <Toolbar>
        <Row align gap="sm" wrap>
          {/* One "view" control rather than a button per mode. The toolbar
              also carries the tag filter and the archived toggle, and a row of
              one button per mode does not survive another mode being added. */}
          <Show
            when={!props.channel.forceSort}
            fallback={
              // The order is fixed for everyone, so this is a label rather
              // than a disabled menu: a control that opens and changes
              // nothing is worse than no control.
              <ForcedSort>
                <Symbol size={18}>lock</Symbol>
                <SortName mode={sort()} />
              </ForcedSort>
            }
          >
            <Button
              size="sm"
              variant="text"
              use:floating={{
                contextMenu: () => (
                  <ContextMenu>
                    <ContextMenuButton
                      onClick={() => updateFilters({ sort: "latest_activity" })}
                      actionIcon={
                        sort() === "latest_activity" ? MdCheck : undefined
                      }
                    >
                      <Trans>Latest activity</Trans>
                    </ContextMenuButton>
                    <ContextMenuButton
                      onClick={() => updateFilters({ sort: "creation_date" })}
                      actionIcon={
                        sort() === "creation_date" ? MdCheck : undefined
                      }
                    >
                      <Trans>Creation date</Trans>
                    </ContextMenuButton>
                    <ContextMenuButton
                      onClick={() => updateFilters({ sort: "alphabetical" })}
                      actionIcon={
                        sort() === "alphabetical" ? MdCheck : undefined
                      }
                    >
                      <Trans>A-Z</Trans>
                    </ContextMenuButton>
                  </ContextMenu>
                ),
                contextMenuHandler: "click",
              }}
            >
              <Symbol>sort</Symbol>
              <SortName mode={sort()} />
            </Button>
          </Show>

          <Button
            size="sm"
            variant="text"
            use:floating={{
              contextMenu: () => {
                // A plain identifier, so the layout name reaches translators
                // as a named placeholder inside one message.
                const name = layoutLabel(forumDefaultLayout());
                return (
                  <ContextMenu>
                    {/* Exactly one item is checked: this one while the reader
                        follows the forum, else their own pick below. */}
                    <ContextMenuButton
                      onClick={followForumDefault}
                      actionIcon={layoutOverride() ? undefined : MdCheck}
                    >
                      <Trans>Use the forum's default ({name})</Trans>
                    </ContextMenuButton>
                    <ContextMenuButton
                      onClick={() => chooseLayout("Modern")}
                      actionIcon={
                        layoutOverride() === "Modern" ? MdCheck : undefined
                      }
                    >
                      <Trans>Modern</Trans>
                    </ContextMenuButton>
                    <ContextMenuButton
                      onClick={() => chooseLayout("Classic")}
                      actionIcon={
                        layoutOverride() === "Classic" ? MdCheck : undefined
                      }
                    >
                      <Trans>Classic</Trans>
                    </ContextMenuButton>
                    <ContextMenuButton
                      onClick={() => chooseLayout("ClassicPlus")}
                      actionIcon={
                        layoutOverride() === "ClassicPlus" ? MdCheck : undefined
                      }
                    >
                      <Trans>Classic+</Trans>
                    </ContextMenuButton>
                  </ContextMenu>
                );
              },
              contextMenuHandler: "click",
            }}
          >
            <Symbol>view_list</Symbol>
            {layoutLabel(layout())}
          </Button>

          <Button
            size="sm"
            variant={archived() ? "filled" : "text"}
            onPress={() => updateFilters({ archived: !archived() })}
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
                    updateFilters({
                      tag: tag() === forumTag.id ? undefined : forumTag.id,
                    })
                  }
                >
                  <Show when={forumTag.emoji}>
                    <TextWithEmoji content={forumTag.emoji} />{" "}
                  </Show>
                  <TextWithEmoji content={forumTag.name} />
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
          <Switch
            fallback={
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
            }
          >
            <Match when={layout() === "Classic"}>
              <List>
                <For each={posts()}>
                  {(post) => (
                    <PostRow
                      post={post}
                      forum={props.channel}
                      stats={statsFor(post)}
                      lastMessage={lastMessageFor(post)}
                    />
                  )}
                </For>
              </List>
            </Match>
            <Match when={layout() === "ClassicPlus"}>
              {/* No header row over an empty forum: the empty-state text
                  above already says there is nothing to list. */}
              <Show when={posts().length > 0}>
                <PostTable
                  posts={posts()}
                  forum={props.channel}
                  statsFor={statsFor}
                  lastMessageFor={lastMessageFor}
                />
              </Show>
            </Match>
          </Switch>
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

const ForcedSort = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "0 8px",
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
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

    // On a phone the floating user bar is pinned over the bottom of every
    // screen (it belongs to the nav block, which there is a drawer the content
    // slides straight over). End padding on a scroller counts towards the
    // scroll extent, so the last row of posts can be scrolled clear of the bar
    // instead of ending underneath it.
    _phone: {
      paddingBlockEnd: "calc(var(--gap-lg) + var(--layout-height-user-footer))",
    },
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

const List = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
  },
});

const LoadMoreRow = styled("div", {
  base: {
    display: "flex",
    justifyContent: "center",
    padding: "var(--gap-md)",
  },
});

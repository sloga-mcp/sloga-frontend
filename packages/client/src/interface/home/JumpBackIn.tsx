import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import type { CalendarEvent, Channel, Client, Server } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Avatar, Time, Unreads, unreadTone } from "@revolt/ui";

import MdEvent from "@material-design-icons/svg/filled/event.svg?component-solid";
import MdGroup from "@material-design-icons/svg/filled/group.svg?component-solid";
import MdHeadsetMic from "@material-design-icons/svg/filled/headset_mic.svg?component-solid";
import MdMarkChatUnread from "@material-design-icons/svg/filled/mark_chat_unread.svg?component-solid";

import { routeConversation } from "../../../components/chatWindows/openConversation";

import {
  type OccurrenceRow,
  JUMP_EVENT_CACHE_MS,
  JUMP_EVENT_FETCH_LIMIT,
  JUMP_EVENT_SERVER_LIMIT,
  JUMP_EVENT_WINDOW_MS,
  collectEvents,
  eventLink,
  pickUnreads,
  pickUpcoming,
  pickVoiceRooms,
  upcomingRows,
} from "./homeHub";

/** How often Upcoming drops events that have started */
const CLOCK_INTERVAL = 60_000;

/**
 * Calendars fetched on an earlier visit to Home, reused for a few minutes so
 * going back and forth does not spend the calendar rate limit again. Kept per
 * client: signing out replaces the client, so one account never sees another
 * account's events, and the cached events always belong to a live store.
 */
const eventCache = new WeakMap<
  Client,
  { key: string; at: number; rows: OccurrenceRow<CalendarEvent>[] }
>();

/**
 * Clients whose server has no cross-server upcoming route. Once it has
 * answered that way, Home asks each server instead without trying the route
 * again. Kept per client for the same reason as the cache above.
 */
const upcomingRouteMissing = new WeakMap<Client, true>();

const Section = styled("section", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    minWidth: 0,
  },
});

const Heading = styled("h2", {
  base: {
    margin: 0,
    fontSize: "16px",
    fontWeight: 700,
    color: "var(--md-sys-color-on-surface)",
  },
});

/** Three cards in a row; one list on phones */
const Cards = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: "10px",

    "@media (max-width: 640px)": {
      display: "flex",
      flexDirection: "column",
      gap: 0,
      paddingBlock: "4px",
      borderRadius: "16px",
      background: "var(--md-sys-color-surface-container)",
    },
  },
});

const Card = styled("section", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    minWidth: 0,
    padding: "12px 8px 8px",
    borderRadius: "16px",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",

    "@media (max-width: 640px)": {
      padding: "8px 4px 4px",
      borderRadius: 0,
      background: "transparent",
    },
  },
});

const CardTitle = styled("h3", {
  base: {
    margin: "0 8px 4px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "12px",
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--md-sys-color-on-surface-variant)",

    "& svg": {
      width: "16px",
      height: "16px",
      flexShrink: 0,
      fill: "currentColor",
    },
  },
});

const List = styled("ul", {
  base: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    display: "flex",
    flexDirection: "column",
  },
});

const RowLink = styled("a", {
  base: {
    minHeight: "44px",
    padding: "6px 8px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    borderRadius: "10px",
    color: "inherit",
    textDecoration: "none",
    cursor: "pointer",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "-2px",
    },
  },
});

const RowText = styled("div", {
  base: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
});

const RowName = styled("span", {
  base: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "14px",
    fontWeight: 600,
  },
});

const RowMeta = styled("span", {
  base: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/** Friends in a call, overlapping */
const Faces = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,

    "& > * + *": { marginInlineStart: "-8px" },
  },
});

/** An unread server or conversation */
type UnreadItem =
  | {
      kind: "server";
      server: Server;
      unread: boolean;
      muted: boolean;
      mention: boolean;
    }
  | {
      kind: "conversation";
      channel: Channel;
      unread: boolean;
      muted: boolean;
      mention: boolean;
    };

/**
 * "Jump back in": unread servers and conversations, friends in voice, and
 * upcoming server events. Each card hides when it has nothing, and the
 * whole section hides when all three are empty.
 */
export function JumpBackIn() {
  const client = useClient();
  const state = useState();
  const voice = useVoice();

  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL);
    onCleanup(() => clearInterval(timer));
  });

  /** The rail's unread items: conversations first, then servers in order */
  const unreads = createMemo(() => {
    const c = client();
    if (!c) return [];
    const items: UnreadItem[] = [
      ...state.ordering.orderedConversations(c).map(
        (channel): UnreadItem => ({
          kind: "conversation",
          channel,
          unread: channel.unread,
          muted: false,
          // Every message in a DM or group is addressed to you
          mention: true,
        }),
      ),
      ...state.ordering.orderedServers(c).map(
        (server): UnreadItem => ({
          kind: "server",
          server,
          unread: server.unread,
          muted: state.notifications.isMuted(server),
          mention: server.mentions.length > 0,
        }),
      ),
    ];
    return pickUnreads(items);
  });

  /** Voice channels with friends in them */
  const rooms = createMemo(() => {
    const c = client();
    if (!c) return [];
    const friends = new Set(
      c.users
        .toList()
        .filter((user) => user.relationship === "Friend")
        .map((user) => user.id),
    );
    if (friends.size === 0) return [];

    const candidates = [];
    for (const channel of c.channels.values()) {
      if (channel.voiceParticipants.size === 0) continue;
      candidates.push({
        channel,
        channelId: channel.id,
        participantIds: [...channel.voiceParticipants.keys()],
      });
    }

    return pickVoiceRooms(candidates, friends, {
      viewerId: c.user?.id,
      currentChannelId: voice?.channel()?.id,
    });
  });

  /**
   * Every server the user is in, sorted, so joining or leaving any of them
   * asks again; undefined (nothing to ask) when there are none
   */
  const eventServers = createMemo(() => {
    const c = client();
    if (!c) return undefined;
    const ids = state.ordering
      .orderedServers(c)
      .map((server) => server.id)
      .sort();
    return ids.length > 0 ? ids.join(",") : undefined;
  });

  const [calendars] = createResource(eventServers, async (key) => {
    const c = client()!;
    const cached = eventCache.get(c);
    if (cached?.key === key && Date.now() - cached.at < JUMP_EVENT_CACHE_MS) {
      return cached.rows;
    }
    const from = Date.now();
    const to = from + JUMP_EVENT_WINDOW_MS;
    const rows = await upcomingRows<OccurrenceRow<CalendarEvent>>(
      upcomingRouteMissing.has(c)
        ? async () => undefined
        : async () => {
            const found = await c.calendarEvents.listUpcoming(
              from,
              to,
              JUMP_EVENT_FETCH_LIMIT,
            );
            if (found === undefined) upcomingRouteMissing.set(c, true);
            return found;
          },
      // Without the route, ask the first servers on the rail a few at a time
      () =>
        collectEvents(
          state.ordering
            .orderedServers(c)
            .slice(0, JUMP_EVENT_SERVER_LIMIT)
            .map((server) => server.id),
          (serverId) => c.calendarEvents.listForServer(serverId, from, to),
        ),
    );
    eventCache.set(c, { key, at: Date.now(), rows });
    return rows;
  });

  const upcoming = createMemo(() => {
    if (calendars.error) return [];
    const rows = calendars.latest ?? [];
    return pickUpcoming(
      rows.filter((row) => row.event.$exists),
      now(),
    );
  });

  const visible = () =>
    unreads().length > 0 || rooms().length > 0 || upcoming().length > 0;

  /** Open a DM or group the way the rail does (a chat window when enabled) */
  const routeLink = (event: MouseEvent, channelId: string) => {
    let routed = true;
    routeConversation(state, channelId, () => (routed = false));
    if (routed) event.preventDefault();
  };

  return (
    <Show when={visible()}>
      <Section aria-labelledby="home-jump-title">
        <Heading id="home-jump-title">
          <Trans>Jump back in</Trans>
        </Heading>
        <Cards>
          <Show when={unreads().length > 0}>
            <Card aria-labelledby="home-jump-unread">
              <CardTitle id="home-jump-unread">
                <MdMarkChatUnread />
                <Trans>Unread</Trans>
              </CardTitle>
              <List>
                <For each={unreads()}>
                  {(item) => (
                    <li>
                      <Switch>
                        <Match
                          when={
                            item.kind === "server" ? item.server : undefined
                          }
                        >
                          {(server) => (
                            <RowLink
                              href={state.layout.getLastActiveServerPath(
                                server().id,
                              )}
                            >
                              <Avatar
                                size={32}
                                src={
                                  server().animatedIconURL ?? server().iconURL
                                }
                                fallback={server().name}
                              />
                              <RowText>
                                <RowName>{server().name}</RowName>
                              </RowText>
                              <Unreads
                                size="18px"
                                count={server().unreadCount}
                                tone={unreadTone(
                                  server().mentions.length,
                                  server().unreadHasAttachments,
                                )}
                                unread
                              />
                            </RowLink>
                          )}
                        </Match>
                        <Match
                          when={
                            item.kind === "conversation"
                              ? item.channel
                              : undefined
                          }
                        >
                          {(channel) => (
                            <RowLink
                              href={`/channel/${channel().id}`}
                              onClick={(event) =>
                                routeLink(event, channel().id)
                              }
                            >
                              <Avatar
                                size={32}
                                src={channel().iconURL}
                                fallback={
                                  channel().type === "Group" ? (
                                    <MdGroup />
                                  ) : (
                                    (channel().name ??
                                    channel().recipient?.username)
                                  )
                                }
                              />
                              <RowText>
                                <RowName>{channel().displayName}</RowName>
                              </RowText>
                              <Unreads
                                size="18px"
                                count={channel().unreadCount}
                                tone="mention"
                                unread
                              />
                            </RowLink>
                          )}
                        </Match>
                      </Switch>
                    </li>
                  )}
                </For>
              </List>
            </Card>
          </Show>
          <Show when={rooms().length > 0}>
            <Card aria-labelledby="home-jump-voice">
              <CardTitle id="home-jump-voice">
                <MdHeadsetMic />
                <Trans>In voice now</Trans>
              </CardTitle>
              <List>
                <For each={rooms()}>
                  {(entry) => {
                    const channel = () => entry.room.channel;
                    const friends = () =>
                      entry.friendIds
                        .map((id) => client()!.users.get(id))
                        .filter((user) => user !== undefined);
                    return (
                      <li>
                        <RowLink
                          href={
                            channel().serverId
                              ? `/server/${channel().serverId}/channel/${channel().id}`
                              : `/channel/${channel().id}`
                          }
                          onClick={(event) => {
                            if (!channel().serverId) {
                              routeLink(event, channel().id);
                            }
                          }}
                        >
                          <Faces>
                            <For each={friends().slice(0, 3)}>
                              {(user) => (
                                <Avatar
                                  size={24}
                                  src={user.animatedAvatarURL ?? user.avatarURL}
                                  fallback={user.displayName}
                                />
                              )}
                            </For>
                          </Faces>
                          <RowText>
                            <RowName>
                              {friends()
                                .map((user) => user.displayName)
                                .join(", ")}
                            </RowName>
                            <RowMeta>
                              {[channel().displayName, channel().server?.name]
                                .filter(Boolean)
                                .join(" · ")}
                            </RowMeta>
                          </RowText>
                        </RowLink>
                      </li>
                    );
                  }}
                </For>
              </List>
            </Card>
          </Show>
          <Show when={upcoming().length > 0}>
            <Card aria-labelledby="home-jump-events">
              <CardTitle id="home-jump-events">
                <MdEvent />
                <Trans>Upcoming</Trans>
              </CardTitle>
              <List>
                <For each={upcoming()}>
                  {(entry) => (
                    <li>
                      <RowLink
                        href={eventLink(
                          entry.event.serverId,
                          entry.event.id,
                          entry.start,
                        )}
                      >
                        <Avatar
                          size={32}
                          src={
                            entry.event.server?.animatedIconURL ??
                            entry.event.server?.iconURL
                          }
                          fallback={entry.event.server?.name}
                        />
                        <RowText>
                          <RowName>{entry.event.title}</RowName>
                          <RowMeta>
                            <Time
                              format={entry.event.allDay ? "date" : "calendar"}
                              value={entry.start}
                            />
                            <Show when={entry.event.server?.name}>
                              {(name) => <> · {name()}</>}
                            </Show>
                          </RowMeta>
                        </RowText>
                      </RowLink>
                    </li>
                  )}
                </For>
              </List>
            </Card>
          </Show>
        </Cards>
      </Section>
    </Show>
  );
}

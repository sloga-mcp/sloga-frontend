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

import { useClient } from "@revolt/client";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { Avatar, Button, Time, Unreads, unreadTone } from "@revolt/ui";

import MdEvent from "@material-design-icons/svg/filled/event.svg?component-solid";
import MdGroup from "@material-design-icons/svg/filled/group.svg?component-solid";
import MdMarkChatUnread from "@material-design-icons/svg/filled/mark_chat_unread.svg?component-solid";

import { routeConversation } from "../../../components/chatWindows/openConversation";

import {
  Empty,
  List,
  Panel,
  PanelHead,
  PanelTitle,
  RowLink,
  RowMeta,
  RowName,
  RowText,
} from "./cardParts";
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
 * "Jump back in": unread servers and conversations, mentions first, using the
 * server rail's rule and badges. Says so when everything is read.
 */
export function UnreadBlock() {
  const client = useClient();
  const state = useState();

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

  /** Open a DM or group the way the rail does (a chat window when enabled) */
  const routeLink = (event: MouseEvent, channelId: string) => {
    let routed = true;
    routeConversation(state, channelId, () => (routed = false));
    if (routed) event.preventDefault();
  };

  return (
    <Panel aria-labelledby="home-unread-title">
      <PanelHead>
        <PanelTitle id="home-unread-title">
          <MdMarkChatUnread />
          <Trans>Jump back in</Trans>
        </PanelTitle>
      </PanelHead>
      <Show
        when={unreads().length > 0}
        fallback={
          <Empty>
            <span>
              <Trans>You're all caught up.</Trans>
            </span>
          </Empty>
        }
      >
        <List>
          <For each={unreads()}>
            {(item) => (
              <li>
                <Switch>
                  <Match
                    when={item.kind === "server" ? item.server : undefined}
                  >
                    {(server) => (
                      <RowLink
                        href={state.layout.getLastActiveServerPath(server().id)}
                      >
                        <Avatar
                          size={32}
                          src={server().animatedIconURL ?? server().iconURL}
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
                      item.kind === "conversation" ? item.channel : undefined
                    }
                  >
                    {(channel) => (
                      <RowLink
                        href={`/channel/${channel().id}`}
                        onClick={(event) => routeLink(event, channel().id)}
                      >
                        <Avatar
                          size={32}
                          src={channel().iconURL}
                          fallback={
                            channel().type === "Group" ? (
                              <MdGroup />
                            ) : (
                              (channel().name ?? channel().recipient?.username)
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
      </Show>
    </Panel>
  );
}

/**
 * Upcoming events across the user's servers: the next few in the next two
 * weeks, one per series. With none, offers to schedule one.
 */
export function UpcomingBlock() {
  const client = useClient();
  const state = useState();
  const navigate = useNavigate();

  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL);
    onCleanup(() => clearInterval(timer));
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

  /** Where "Schedule an event" goes: the first server on the rail */
  const scheduleServer = () => {
    const c = client();
    return c ? state.ordering.orderedServers(c)[0] : undefined;
  };

  return (
    <Panel aria-labelledby="home-upcoming-title">
      <PanelHead>
        <PanelTitle id="home-upcoming-title">
          <MdEvent />
          <Trans>Upcoming</Trans>
        </PanelTitle>
      </PanelHead>
      <Show
        when={upcoming().length > 0}
        fallback={
          <Show when={!calendars.loading}>
            <Empty>
              <span>
                <Trans>No events in the next two weeks.</Trans>
              </span>
              <Show when={scheduleServer()}>
                {(server) => (
                  <Button
                    variant="tonal"
                    size="sm"
                    onPress={() => navigate(`/server/${server().id}/events`)}
                  >
                    <Trans>Schedule an event</Trans>
                  </Button>
                )}
              </Show>
            </Empty>
          </Show>
        }
      >
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
      </Show>
    </Panel>
  );
}

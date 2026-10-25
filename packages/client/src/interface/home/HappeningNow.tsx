import { For, Show, createMemo } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useNavigate } from "@revolt/routing";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { Avatar, Button } from "@revolt/ui";

import MdGraphicEq from "@material-design-icons/svg/filled/graphic_eq.svg?component-solid";

import { routeConversation } from "../../../components/chatWindows/openConversation";
import { isChannelGatedForMember } from "../channels/memberGate";

import {
  Empty,
  Faces,
  List,
  Panel,
  PanelHead,
  PanelTitle,
  RowLink,
  RowMeta,
  RowName,
  RowText,
} from "./cardParts";
import { pickHappening } from "./homeHub";

/** Faces drawn per call before "+N" */
const FACE_LIMIT = 4;

const Room = styled("li", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    paddingInlineEnd: "6px",

    "& > a": { flex: 1, minWidth: 0 },
  },
});

const More = styled("span", {
  base: {
    width: "24px",
    height: "24px",
    display: "grid",
    placeItems: "center",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-highest)",
    fontSize: "11px",
    fontWeight: 700,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * "Happening now": calls with someone in them, in channels this client can
 * see (the same ones the sidebar shows), friends' calls first. Joining is a
 * button press, with the same checks the sidebar makes; with nobody in voice
 * it offers a voice channel to start one in.
 */
export function HappeningNow() {
  const client = useClient();
  const state = useState();
  const voice = useVoice();
  const navigate = useNavigate();
  const { t } = useLingui();

  /** Whether a mature gate stands between the viewer and this channel */
  const gated = (channel: Channel) =>
    isChannelGatedForMember(
      channel,
      (key) => state.layout.getSectionState(key, false),
      LAYOUT_SECTIONS.MATURE,
    );

  const rooms = createMemo(() => {
    const c = client();
    if (!c) return [];
    const friends = new Set(
      c.users
        .toList()
        .filter((user) => user.relationship === "Friend")
        .map((user) => user.id),
    );

    const candidates = [];
    for (const channel of c.channels.values()) {
      if (channel.voiceParticipants.size === 0) continue;
      // Who is in a gated call is that channel's content too (the sidebar
      // hides its roster until the gate is passed), so it stays off Home
      if (gated(channel)) continue;
      candidates.push({
        channel,
        channelId: channel.id,
        participantIds: [...channel.voiceParticipants.keys()],
      });
    }

    return pickHappening(candidates, friends, {
      viewerId: c.user?.id,
      currentChannelId: voice?.channel()?.id,
    });
  });

  /** A voice channel to start a call in: the first one on the rail the viewer may join */
  const hangout = createMemo(() => {
    const c = client();
    if (!c) return undefined;
    for (const server of state.ordering.orderedServers(c)) {
      const channel = server.channels.find(
        (entry) =>
          entry.isVoice && entry.havePermission("Connect") && !gated(entry),
      );
      if (channel) return channel;
    }
    return undefined;
  });

  const channelPath = (channel: Channel) =>
    channel.serverId
      ? `/server/${channel.serverId}/channel/${channel.id}`
      : `/channel/${channel.id}`;

  /** Open a DM or group the way the rail does (a chat window when enabled) */
  const routeLink = (event: MouseEvent, channel: Channel) => {
    if (channel.serverId) return;
    let routed = true;
    routeConversation(state, channel.id, () => (routed = false));
    if (routed) event.preventDefault();
  };

  /**
   * Whether Join may connect straight away. A DM or group call opens the
   * conversation instead, and so does a channel behind a gate, one the
   * viewer may not join, or one whose last join was refused.
   */
  const canJoin = (channel: Channel) =>
    !!channel.serverId &&
    !!channel.havePermission("Connect") &&
    !gated(channel) &&
    !voice?.joinBlocked(channel);

  return (
    <Panel aria-labelledby="home-happening-title">
      <PanelHead>
        <PanelTitle id="home-happening-title">
          <MdGraphicEq />
          <Trans>Happening now</Trans>
        </PanelTitle>
      </PanelHead>
      <Show
        when={rooms().length > 0}
        fallback={
          <Empty>
            <span>
              <Trans>Nobody's in voice right now.</Trans>
            </span>
            <Show when={hangout()} keyed>
              {(channel) => {
                // a plain identifier, so translators see a named placeholder
                const server = channel.server?.name ?? "";
                return (
                  <Button
                    variant="tonal"
                    size="sm"
                    onPress={() => navigate(channelPath(channel))}
                  >
                    <Trans>Start a hangout in {server}</Trans>
                  </Button>
                );
              }}
            </Show>
          </Empty>
        }
      >
        <List>
          <For each={rooms()}>
            {(entry) => {
              const channel = () => entry.room.channel;
              const people = () =>
                entry.people
                  .map((id) => client()!.users.get(id))
                  .filter((user) => user !== undefined);
              const sharer = () =>
                people().find(
                  (user) =>
                    channel()
                      .voiceParticipants.get(user.id)
                      ?.isScreensharing() === true,
                );
              const extra = () => entry.people.length - FACE_LIMIT;
              const joinLabel = () => {
                const name = channel().displayName;
                return t`Join ${name}`;
              };

              return (
                <Room>
                  <RowLink
                    href={channelPath(channel())}
                    onClick={(event) => routeLink(event, channel())}
                  >
                    <Faces>
                      <For each={people().slice(0, FACE_LIMIT)}>
                        {(user) => (
                          <Avatar
                            size={24}
                            src={user.animatedAvatarURL ?? user.avatarURL}
                            fallback={user.displayName}
                          />
                        )}
                      </For>
                      <Show when={extra() > 0}>
                        <More>+{extra()}</More>
                      </Show>
                    </Faces>
                    <RowText>
                      <RowName>
                        {[channel().displayName, channel().server?.name]
                          .filter(Boolean)
                          .join(" · ")}
                      </RowName>
                      <RowMeta>
                        <Show
                          when={sharer()}
                          fallback={people()
                            .map((user) => user.displayName)
                            .join(", ")}
                        >
                          {(user) => {
                            const name = user().displayName;
                            return (
                              <Trans>{name} is sharing their screen</Trans>
                            );
                          }}
                        </Show>
                      </RowMeta>
                    </RowText>
                  </RowLink>
                  <Show when={canJoin(channel())}>
                    <Button
                      variant="tonal"
                      size="sm"
                      aria-label={joinLabel()}
                      onPress={() => void voice?.connect(channel())}
                    >
                      <Trans>Join</Trans>
                    </Button>
                  </Show>
                </Room>
              );
            }}
          </For>
        </List>
      </Show>
    </Panel>
  );
}

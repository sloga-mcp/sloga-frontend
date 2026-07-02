import { Component, Match, Switch, createMemo } from "solid-js";

import { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { Navigate, useParams } from "@revolt/routing";

import { parseChannelPassword } from "../../lib/channelPassword";
import { AgeGate } from "./AgeGate";
import { PasswordGate } from "./PasswordGate";
import { TextChannel } from "./text/TextChannel";

/**
 * Channel layout
 */
const Base = styled("div", {
  base: {
    minWidth: 0,
    flexGrow: 1,
    display: "flex",
    position: "relative",
    flexDirection: "column",
  },
});

export interface ChannelPageProps {
  channel: Channel;
}

const TEXT_CHANNEL_TYPES: Channel["type"][] = [
  "TextChannel",
  "DirectMessage",
  "Group",
  "SavedMessages",
];

/**
 * Channel component
 */
export const ChannelPage: Component = () => {
  const params = useParams();
  const client = useClient();
  const channel = createMemo(() => client()!.channels.get(params.channel)!);

  return (
    <Base>
      <Switch fallback="Unknown channel type!">
        <Match when={!channel()}>
          <Navigate href={"../.."} />
        </Match>
        <Match when={TEXT_CHANNEL_TYPES.includes(channel()!.type)}>
          <AgeGate
            enabled={channel().mature}
            contentId={channel().id}
            contentName={"#" + channel().name}
            contentType="channel"
          >
            <PasswordGate
              passwordHash={parseChannelPassword(channel().description).passwordHash}
              channelId={channel().id}
              channelName={channel().name!}
            >
              <TextChannel channel={channel()} />
            </PasswordGate>
          </AgeGate>
        </Match>
        {/* <Match when={channel()!.type === "VoiceChannel"}>
            <Header placement="primary">
              <ChannelHeader channel={channel()} />
            </Header>
          </Match> */}
      </Switch>
    </Base>
  );
};

import {
  Component,
  Match,
  Switch,
  createMemo,
  createResource,
} from "solid-js";

import { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { Navigate, useParams } from "@revolt/routing";

import { parseChannelPassword } from "../../lib/channelPassword";
import { AgeGate } from "./AgeGate";
import { PasswordGate } from "./PasswordGate";
import { ForumChannel } from "./forum/ForumChannel";
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
  // threads reuse the entire TextChannel view (message pipeline reuse);
  // v1 is navigate-into-thread, the side-by-side panel is a follow-up
  "Thread",
];

/**
 * Channel component
 */
export const ChannelPage: Component = () => {
  const params = useParams();
  const client = useClient();
  const cached = createMemo(() => client()!.channels.get(params.channel));

  // Ready only includes JOINED threads, so a deep-link or reload into a
  // not-yet-joined thread misses the cache — try fetching it before
  // bouncing the user out of the channel.
  const [fetched] = createResource(
    () => (cached() ? undefined : params.channel),
    async (id) => {
      try {
        return await client()!.channels.fetch(id);
      } catch {
        return null;
      }
    },
  );

  const channel = () => cached() ?? fetched() ?? undefined;

  return (
    <Base>
      <Switch fallback="Unknown channel type!">
        <Match when={!channel() && fetched.loading}>{null}</Match>
        <Match when={!channel()}>
          <Navigate href={"../.."} />
        </Match>
        <Match when={TEXT_CHANNEL_TYPES.includes(channel()!.type)}>
          <AgeGate
            enabled={channel()!.mature}
            contentId={channel()!.id}
            contentName={"#" + channel()!.name}
            contentType="channel"
          >
            <PasswordGate
              passwordHash={
                parseChannelPassword(channel()!.description).passwordHash
              }
              channelId={channel()!.id}
              channelName={channel()!.name!}
            >
              <TextChannel channel={channel()!} />
            </PasswordGate>
          </AgeGate>
        </Match>
        <Match when={channel()!.type === "Forum"}>
          <AgeGate
            enabled={channel()!.mature}
            contentId={channel()!.id}
            contentName={"#" + channel()!.name}
            contentType="channel"
          >
            <PasswordGate
              passwordHash={
                parseChannelPassword(channel()!.description).passwordHash
              }
              channelId={channel()!.id}
              channelName={channel()!.name!}
            >
              <ForumChannel channel={channel()!} />
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

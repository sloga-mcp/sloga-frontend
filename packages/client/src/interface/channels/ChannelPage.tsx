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
import { SLIM_ROOT, slimAllowsChannel } from "@revolt/client/slimRoutePolicy";
import { useSlimMode } from "@revolt/client/useSlimMode";
import { Navigate, useParams } from "@revolt/routing";

import { parseChannelPassword } from "../../lib/channelPassword";
import { AgeGate } from "./AgeGate";
import { PasswordGate } from "./PasswordGate";
import { SpoilerGate } from "./SpoilerGate";
import { gateSource } from "./channelGates";
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
  const slim = useSlimMode();
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

  // Slim view shows no server channel. The bare /channel/:id link, the one
  // push notifications open, can point at one, so the path cannot decide
  // this and the loaded channel has to. The answer comes from the server id
  // and not from `isVoice`, which is also true for a DM. A channel that is
  // still loading is allowed until it arrives.
  //
  // Staff are never in Slim view, and that is only known once the signed-in
  // user has loaded. Both routes that mount this page sit under `Interface`,
  // which renders its routed content only after the first load, so the
  // answer is settled before this can navigate.
  const slimBlocked = createMemo(() => slim() && !slimAllowsChannel(channel()));

  return (
    <Base>
      <Switch fallback="Unknown channel type!">
        <Match when={!channel() && fetched.loading}>{null}</Match>
        <Match when={!channel()}>
          <Navigate href={"../.."} />
        </Match>
        {/* Ahead of every channel kind below, so none of them (text, voice,
            thread, forum) mounts, fetches or joins a call for a channel
            Slim view hides. `Navigate` replaces the history entry, so Back
            does not return here. */}
        <Match when={slimBlocked()}>
          <Navigate href={SLIM_ROOT} />
        </Match>
        <Match when={TEXT_CHANNEL_TYPES.includes(channel()!.type)}>
          {/* A thread answers to its parent's gates (see gateSource). */}
          <AgeGate
            enabled={gateSource(channel()!).mature}
            contentName={"#" + channel()!.name}
          >
            <PasswordGate
              passwordHash={
                parseChannelPassword(gateSource(channel()!).description)
                  .passwordHash
              }
              channelId={gateSource(channel()!).id}
              channelName={gateSource(channel()!).name!}
            >
              <SpoilerGate
                enabled={gateSource(channel()!).isSpoiler}
                channelId={gateSource(channel()!).id}
                channelName={"#" + gateSource(channel()!).name}
              >
                <TextChannel channel={channel()!} />
              </SpoilerGate>
            </PasswordGate>
          </AgeGate>
        </Match>
        <Match when={channel()!.type === "Forum"}>
          <AgeGate
            enabled={channel()!.mature}
            contentName={"#" + channel()!.name}
          >
            <PasswordGate
              passwordHash={
                parseChannelPassword(channel()!.description).passwordHash
              }
              channelId={channel()!.id}
              channelName={channel()!.name!}
            >
              <SpoilerGate
                enabled={channel()!.isSpoiler}
                channelId={channel()!.id}
                channelName={"#" + channel()!.name}
              >
                <ForumChannel channel={channel()!} />
              </SpoilerGate>
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

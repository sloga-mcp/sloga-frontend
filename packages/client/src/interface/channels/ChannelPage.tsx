import {
  Component,
  Match,
  Show,
  Switch,
  createMemo,
  createResource,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { type ChatPanel, chatPanelFor } from "@revolt/client/encryptedOnlyChat";
import { buildPlainWriteInput } from "@revolt/client/encryptedOnlyGuard";
import { SLIM_ROOT, slimAllowsChannel } from "@revolt/client/slimRoutePolicy";
import { useSlimMode } from "@revolt/client/useSlimMode";
import { useModals } from "@revolt/modal";
import { Navigate, useParams } from "@revolt/routing";
import { Button, Header } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { parseChannelPassword } from "../../lib/channelPassword";
import { AgeGate } from "./AgeGate";
import { ChannelHeader } from "./ChannelHeader";
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

  // Encrypted-only chats: a latched account on the website, or on an app
  // where encryption is not set up, cannot read or write its direct
  // messages and groups here, so the whole chat is a panel saying why.
  const e2ee = useE2EE();
  const chatPanel = createMemo((): ChatPanel | null => {
    const current = channel();
    if (current?.type !== "DirectMessage" && current?.type !== "Group") {
      return null;
    }
    return chatPanelFor(
      buildPlainWriteInput(client()!, current),
      !e2ee || !!e2ee.status.get("state"),
    );
  });

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
        <Match when={chatPanel()}>
          {(panel) => (
            <EncryptedOnlyPanel channel={channel()!} panel={panel()} />
          )}
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

/**
 * The whole chat, for an Encrypted-only account that cannot read or write
 * it on this device. The header stays, so the chat can still be left or
 * called. An app where encryption is not set up offers the existing setup;
 * the website has nothing to offer.
 */
function EncryptedOnlyPanel(props: { channel: Channel; panel: ChatPanel }) {
  const e2ee = useE2EE();
  const { openModal } = useModals();

  // Keys that were never registered finish setup rather than starting over,
  // as in Settings > Encryption
  function turnOn() {
    openModal({
      type: e2ee?.publishPending.get("state")
        ? "e2ee_finish_setup"
        : "e2ee_enable",
    });
  }

  return (
    <>
      <Header placement="primary">
        <ChannelHeader channel={props.channel} />
      </Header>
      <PanelBody role="status">
        <Symbol size={40}>key</Symbol>
        <Switch>
          <Match when={props.panel === "open-app"}>
            <PanelText>
              <Trans>
                Open the Sloga app to read and send encrypted chats.
              </Trans>
            </PanelText>
          </Match>
          <Match when={props.panel === "setup"}>
            <PanelText>
              <Trans>
                Finish setting up encryption on this device to use your chats.
              </Trans>
            </PanelText>
            <Show when={e2ee}>
              <Button onPress={turnOn}>
                <Trans>Turn on encryption</Trans>
              </Button>
            </Show>
          </Match>
        </Switch>
      </PanelBody>
    </>
  );
}

/**
 * Centred column under the header
 */
const PanelBody = styled("div", {
  base: {
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-lg)",
    padding: "var(--gap-xl)",
    textAlign: "center",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * Panel sentence
 */
const PanelText = styled("p", {
  base: {
    maxWidth: "420px",
    margin: 0,
    fontSize: "1rem",
    color: "var(--md-sys-color-on-surface)",
  },
});

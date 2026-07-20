import { For, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { User } from "stoat.js";
import { styled } from "styled-system/jsx";

import { Text, typography } from "../../design";

import { ProfileCard } from "./ProfileCard";

/**
 * Linked streaming channels (Twitch / YouTube) with a LIVE pill while
 * the channel is streaming.
 */
export function ProfileConnections(props: { user: User }) {
  const connections = () => props.user.connections;

  /**
   * External channel URL for a connection (YouTube handle is "@custom"
   * or a raw channel id)
   */
  const url = (connection: (typeof props.user.connections)[number]) =>
    connection.platform === "Twitch"
      ? `https://twitch.tv/${connection.handle}`
      : connection.handle.startsWith("@")
        ? `https://youtube.com/${connection.handle}`
        : `https://youtube.com/channel/${connection.handle}`;

  return (
    <Show when={connections().length}>
      <ProfileCard>
        <Text class="title" size="large">
          <Trans>Channels</Trans>
        </Text>
        <For each={connections()}>
          {(connection) => (
            <Row>
              <ChannelLink
                href={url(connection)}
                target="_blank"
                rel="noreferrer"
              >
                {connection.platform === "Twitch" ? "Twitch" : "YouTube"}
                {" · "}
                {connection.display_name}
              </ChannelLink>
              <Show when={connection.live}>
                <LivePill>
                  <Trans>LIVE</Trans>
                </LivePill>
                <Show when={connection.live_title}>
                  <StreamTitle>{connection.live_title}</StreamTitle>
                </Show>
              </Show>
            </Row>
          )}
        </For>
      </ProfileCard>
    </Show>
  );
}

const Row = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
    minWidth: 0,
  },
});

const ChannelLink = styled("a", {
  base: {
    ...typography.raw(),
    color: "var(--md-sys-color-primary)",
    textDecoration: "none",
    userSelect: "text",

    "&:hover": {
      textDecoration: "underline",
    },
  },
});

const LivePill = styled("span", {
  base: {
    ...typography.raw({ class: "label", size: "small" }),
    background: "#e91916",
    color: "#fff",
    borderRadius: "var(--borderRadius-sm)",
    padding: "0 var(--gap-sm)",
    fontWeight: 700,
    textTransform: "uppercase",
    lineHeight: "1.4",
  },
});

const StreamTitle = styled("span", {
  base: {
    ...typography.raw({ class: "label" }),
    opacity: 0.8,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
});

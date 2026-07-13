import { For, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import type { Message } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useTime } from "@revolt/i18n";
import { Markdown } from "@revolt/markdown";
import { Attachment } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

interface Props {
  /**
   * Message carrying a forwarded snapshot
   */
  message: Message;
}

/**
 * Body of a forwarded message: a "Forwarded" header linking back to the
 * origin, plus the immutable server-copied snapshot (content and
 * attachment copies). Snapshot semantics — edits or deletion of the
 * original do not propagate, and the origin link may dangle if the
 * original was deleted.
 */
export function ForwardedMessage(props: Props) {
  const dayjs = useTime();
  const snapshot = () => props.message.forwarded!;

  /**
   * Path to the original message (the link can dangle if the origin —
   * or the viewer's access to it — has since gone away).
   */
  const originPath = () => {
    const { serverId, channelId, messageId } = snapshot();
    return serverId
      ? `/server/${serverId}/channel/${channelId}/${messageId}`
      : `/channel/${channelId}/${messageId}`;
  };

  return (
    <Container>
      <Header>
        <Symbol size={16}>forward</Symbol>
        <a href={originPath()}>
          <Trans>Forwarded</Trans>
        </a>
        <Origin>{dayjs(snapshot().originalSentAt).format("LLL")}</Origin>
      </Header>
      <Body>
        <Show when={snapshot().content}>
          <Markdown content={snapshot().content!} />
        </Show>
        <For each={snapshot().attachments}>
          {(attachment) => (
            <Attachment message={props.message} file={attachment} />
          )}
        </For>
      </Body>
    </Container>
  );
}

const Container = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    marginTop: "2px",
    paddingInlineStart: "12px",
    borderInlineStart: "3px solid var(--md-sys-color-outline-variant)",
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    fontSize: "0.75rem",
    fontWeight: "600",
    color: "var(--md-sys-color-on-surface-variant)",

    "& a": {
      color: "var(--md-sys-color-primary)",
      "&:hover": {
        textDecoration: "underline",
      },
    },
  },
});

const Origin = styled("span", {
  base: {
    fontWeight: "400",
    opacity: 0.8,
  },
});

const Body = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    overflowWrap: "anywhere",
  },
});

import { Show, onMount } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import type { Message } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * "used /cmd" attribution row shown above a bot's slash-command response.
 *
 * Only rendered for messages carrying the server-set `Interaction` flag +
 * `command_context` (both unforgeable — the regular send path rejects them),
 * so this attribution can be trusted.
 */
export function InteractionContext(props: { message: Message }) {
  const client = useClient();

  const context = () => props.message.commandContext;
  const invoker = () => {
    const id = context()?.user_id;
    return id ? client().users.get(id) : undefined;
  };

  // Fetch-on-miss so old history doesn't render a raw id (MessageReply
  // does the same for its referenced message).
  onMount(() => {
    const id = context()?.user_id;
    if (id && !invoker()) {
      client().users.fetch(id).catch(() => undefined);
    }
  });

  return (
    <Show when={context()}>
      <Base>
        <Symbol size={14}>terminal</Symbol>
        <Trans>
          <Invoker>{invoker()?.displayName ?? context()!.user_id}</Invoker>{" "}
          used <CommandName>/{context()!.command_name}</CommandName>
        </Trans>
      </Base>
    </Show>
  );
}

const Base = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    minWidth: 0,
    fontSize: "12px",
    color: "var(--md-sys-color-outline)",
    userSelect: "none",
  },
});

const Invoker = styled("span", {
  base: {
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const CommandName = styled("span", {
  base: {
    fontWeight: 600,
    color: "var(--md-sys-color-primary)",
  },
});

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useTime } from "@revolt/i18n";
import { useModals } from "@revolt/modal";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

interface Props {
  /**
   * Channel whose pending scheduled messages to show
   */
  channel: Channel;
}

/**
 * Collapsible "N scheduled" bar above the composer: the current user's own
 * pending scheduled messages in this channel (they are private — nobody
 * else ever sees them), with per-item cancel. Populated by a fetch on
 * mount and kept live by the `scheduledMessage*` events feeding
 * `client.scheduledMessages`. Failures surface via an error modal from
 * the client-level event hook.
 */
export function ScheduledMessagesBar(props: Props) {
  const { t } = useLingui();
  const client = useClient();
  const dayjs = useTime();
  const { showError } = useModals();

  const [expanded, setExpanded] = createSignal(false);

  // Refetch per channel (TextChannel is NOT remounted on channel switch,
  // so onMount would only ever run for the first channel opened).
  // Author-scoped server-side; refreshes rows that fired or were
  // cancelled while this client was away.
  createEffect(
    on(
      () => props.channel.id,
      () => {
        props.channel.fetchScheduledMessages().catch(() => {
          /* pending list is best-effort; scheduling itself still works */
        });
      },
    ),
  );

  const rows = createMemo(() =>
    [...client().scheduledMessages.values()]
      .filter(
        (row) => row.channel === props.channel.id && row.status === "Pending",
      )
      .sort((a, b) => a.scheduled_at - b.scheduled_at),
  );

  async function cancel(id: string) {
    try {
      await props.channel.cancelScheduledMessage(id);
    } catch (error) {
      showError(error);
    }
  }

  return (
    <Show when={rows().length > 0}>
      <Bar>
        <Summary type="button" onClick={() => setExpanded((value) => !value)}>
          <Symbol size={16}>schedule_send</Symbol>
          <span>{t`${rows().length} scheduled`}</span>
          <Symbol size={16}>
            {expanded() ? "expand_more" : "expand_less"}
          </Symbol>
        </Summary>
        <Show when={expanded()}>
          <List>
            <For each={rows()}>
              {(row) => (
                <Row>
                  <RowTime>
                    <Symbol size={14}>schedule</Symbol>
                    {dayjs(row.scheduled_at).format("lll")}
                  </RowTime>
                  <RowContent>{row.data.content}</RowContent>
                  <RowCancel
                    type="button"
                    title={t`Cancel scheduled message`}
                    onClick={() => void cancel(row._id)}
                  >
                    <Symbol size={16}>close</Symbol>
                  </RowCancel>
                </Row>
              )}
            </For>
            <Jitter>
              <Trans>Messages go out around their scheduled time.</Trans>
            </Jitter>
          </List>
        </Show>
      </Bar>
    </Show>
  );
}

const Bar = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    margin: "0 var(--gap-md)",
    borderRadius: "12px 12px 0 0",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    borderBottom: "none",
  },
});

const Summary = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "6px 12px",
    fontSize: "0.8125rem",
    fontWeight: "600",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",
    textAlign: "left",

    "& span:first-of-type": {
      flexGrow: 1,
    },
  },
});

const List = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "0 8px 8px",
    maxHeight: "200px",
    overflowY: "auto",
  },
});

const Row = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "6px 8px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container)",
    fontSize: "0.8125rem",
  },
});

const RowTime = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    flexShrink: 0,
    color: "var(--md-sys-color-primary)",
    fontVariantNumeric: "tabular-nums",
  },
});

const RowContent = styled("span", {
  base: {
    flexGrow: 1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: "var(--md-sys-color-on-surface)",
  },
});

const RowCancel = styled("button", {
  base: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: "24px",
    height: "24px",
    borderRadius: "50%",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",
    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
      color: "var(--md-sys-color-error)",
    },
  },
});

const Jitter = styled("span", {
  base: {
    padding: "4px 8px 0",
    fontSize: "0.7rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

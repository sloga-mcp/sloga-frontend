import { For, Show, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Modal to forward a message to another channel. The server copies an
 * immutable snapshot of the original (verifying this user can actually
 * read it) — later edits or deletion of the original do not propagate.
 */
export function ForwardMessageModal(
  props: DialogProps & Modals & { type: "forward_message" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { showError } = useModals();

  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<Channel | undefined>();
  const [pending, setPending] = createSignal(false);

  /**
   * Whether a channel is in an E2EE conversation (forwards are
   * server-mediated plaintext, so encrypted destinations are excluded —
   * same conversation-id rule as the composer: peer user id for DMs,
   * channel id for groups).
   */
  const isEncryptedDestination = (channel: Channel) => {
    const conversationId =
      channel.type === "DirectMessage" ? channel.recipient?.id : channel.id;
    if (!conversationId) return false;
    const mode = e2ee?.sendModes.get(conversationId);
    return (
      mode === "encrypt" || mode === "blocked" || mode === "peer_downgraded"
    );
  };

  const candidates = createMemo(() => {
    const search = query().toLowerCase();
    return [...client().channels.values()]
      .filter(
        (channel) =>
          ["TextChannel", "Group", "DirectMessage", "SavedMessages"].includes(
            channel.type,
          ) &&
          channel.havePermission("SendMessage") &&
          !isEncryptedDestination(channel),
      )
      .filter((channel) => {
        if (!search) return true;
        const label = channelLabel(channel).toLowerCase();
        return (
          label.includes(search) ||
          channel.server?.name?.toLowerCase().includes(search)
        );
      })
      .sort((a, b) => channelLabel(a).localeCompare(channelLabel(b)))
      .slice(0, 50);
  });

  function channelLabel(channel: Channel): string {
    if (channel.type === "SavedMessages") return t`Saved Notes`;
    return channel.displayName ?? channel.name ?? channel.id;
  }

  const previewText = () =>
    props.message.forwarded?.content ??
    props.message.content ??
    t`Attachments`;

  async function forward() {
    const destination = selected();
    if (!destination || pending()) return;
    setPending(true);
    try {
      await props.message.forwardTo(destination);
      props.onClose();
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Forward message</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Forward</Trans>,
          onClick: () => {
            void forward();
            return false;
          },
          isDisabled: !selected() || pending(),
        },
      ]}
      isDisabled={pending()}
    >
      <Column>
        <Preview>
          <Symbol size={16}>forward</Symbol>
          <PreviewText>{previewText()}</PreviewText>
        </Preview>

        <SearchInput
          value={query()}
          placeholder={t`Search for a channel or conversation…`}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />

        <Candidates>
          <For each={candidates()}>
            {(channel) => (
              <Candidate
                type="button"
                data-selected={selected()?.id === channel.id || undefined}
                onClick={() => setSelected(channel)}
              >
                <Symbol size={18}>
                  {channel.type === "TextChannel"
                    ? "tag"
                    : channel.type === "Group"
                      ? "group"
                      : channel.type === "SavedMessages"
                        ? "bookmark"
                        : "alternate_email"}
                </Symbol>
                <CandidateName>{channelLabel(channel)}</CandidateName>
                <Show when={channel.server}>
                  <CandidateServer>{channel.server!.name}</CandidateServer>
                </Show>
              </Candidate>
            )}
          </For>
          <Show when={candidates().length === 0}>
            <Empty>
              <Trans>No channels found</Trans>
            </Empty>
          </Show>
        </Candidates>

        <Hint>
          <Symbol size={16}>info</Symbol>
          <Trans>
            The forward keeps a copy of the message as it is right now —
            later edits or deletion of the original won't change it.
            Encrypted conversations can't receive forwards.
          </Trans>
        </Hint>
      </Column>
    </Dialog>
  );
}

const Preview = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    alignItems: "flex-start",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "0.85rem",
  },
});

const PreviewText = styled("span", {
  base: {
    maxHeight: "60px",
    overflow: "hidden",
    overflowWrap: "anywhere",
  },
});

const SearchInput = styled("input", {
  base: {
    padding: "10px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.9rem",
    "&:focus": {
      outline: "none",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const Candidates = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxHeight: "260px",
    overflowY: "auto",
  },
});

const Candidate = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "8px 10px",
    borderRadius: "8px",
    textAlign: "left",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
    "&[data-selected]": {
      background: "var(--md-sys-color-primary-container)",
      color: "var(--md-sys-color-on-primary-container)",
    },
  },
});

const CandidateName = styled("span", {
  base: {
    flexGrow: 1,
    fontSize: "0.9rem",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const CandidateServer = styled("span", {
  base: {
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
    whiteSpace: "nowrap",
  },
});

const Empty = styled("div", {
  base: {
    padding: "16px",
    textAlign: "center",
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Hint = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    alignItems: "flex-start",
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.8125rem",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

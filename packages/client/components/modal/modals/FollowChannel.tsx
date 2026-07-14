import { For, Show, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { Column, Dialog, DialogProps } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Modal to follow an announcement channel from a target channel in another
 * server. Creates a webhook in the chosen target channel; publishing an
 * announcement then fans a copy into it. Candidate targets are the text
 * channels where this user has `ManageWebhooks` (the target server keeps
 * full control via normal webhook settings).
 */
export function FollowChannelModal(
  props: DialogProps & Modals & { type: "follow_channel" },
) {
  const { t } = useLingui();
  const client = useClient();
  const { showError } = useModals();

  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<Channel | undefined>();
  const [pending, setPending] = createSignal(false);

  const candidates = createMemo(() => {
    const search = query().toLowerCase();
    return [...client().channels.values()]
      .filter(
        (channel) =>
          channel.type === "TextChannel" &&
          channel.id !== props.channel.id &&
          !!channel.server &&
          channel.havePermission("ManageWebhooks"),
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
    return channel.displayName ?? channel.name ?? channel.id;
  }

  async function follow() {
    const target = selected();
    if (!target || !target.server || pending()) return;
    setPending(true);
    try {
      await props.channel.follow(target.server.id, target.id);
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
      title={<Trans>Follow announcement channel</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Follow</Trans>,
          onClick: () => {
            void follow();
            return false;
          },
          isDisabled: !selected() || pending(),
        },
      ]}
      isDisabled={pending()}
    >
      <Column>
        <Preview>
          <Symbol size={16}>campaign</Symbol>
          <PreviewText>
            <Trans>
              New posts published in #
              {props.channel.name ?? props.channel.id} will appear in the
              channel you pick below.
            </Trans>
          </PreviewText>
        </Preview>

        <SearchInput
          value={query()}
          placeholder={t`Search for a channel to deliver into…`}
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
                <Symbol size={18}>tag</Symbol>
                <CandidateName>{channelLabel(channel)}</CandidateName>
                <Show when={channel.server}>
                  <CandidateServer>{channel.server!.name}</CandidateServer>
                </Show>
              </Candidate>
            )}
          </For>
          <Show when={candidates().length === 0}>
            <Empty>
              <Trans>
                No channels where you can manage webhooks. You need the Manage
                Webhooks permission on the destination channel.
              </Trans>
            </Empty>
          </Show>
        </Candidates>

        <Hint>
          <Symbol size={16}>info</Symbol>
          <Trans>
            Following creates a webhook in the destination channel. The
            destination server can stop the follow at any time by deleting
            that webhook.
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

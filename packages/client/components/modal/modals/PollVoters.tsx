import { For, Show, createResource, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { Avatar, Column, Dialog, DialogProps } from "@revolt/ui";

import { Modals } from "../types";

/**
 * Modal listing who voted for each answer of a poll. Only reachable by the
 * poll author / moderators — the server enforces the same gate.
 */
export function PollVotersModal(
  props: DialogProps & Modals & { type: "poll_voters" },
) {
  const poll = () => props.message.poll;
  const [answerId, setAnswerId] = createSignal(poll()?.answers[0]?.id ?? 0);

  // No catch: a failed fetch surfaces via `voters.error` below rather than
  // masquerading as "no votes".
  const [voters] = createResource(answerId, (answer) =>
    props.message.fetchPollVoters(answer),
  );

  const countFor = (id: number) =>
    props.message.pollState?.counts?.find((count) => count.answer_id === id)
      ?.count;

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Poll votes</Trans>}
      actions={[{ text: <Trans>Close</Trans> }]}
    >
      <Column>
        <AnswerRow>
          <For each={poll()?.answers ?? []}>
            {(answer) => (
              <AnswerChip
                type="button"
                selected={answerId() === answer.id}
                onClick={() => setAnswerId(answer.id)}
              >
                <Show when={answer.emoji}>{answer.emoji} </Show>
                {answer.text}
                <Show when={countFor(answer.id) !== undefined}>
                  <ChipCount>{countFor(answer.id)}</ChipCount>
                </Show>
              </AnswerChip>
            )}
          </For>
        </AnswerRow>

        <Show when={voters.error}>
          <Placeholder>
            <Trans>Could not load voters.</Trans>
          </Placeholder>
        </Show>
        <Show
          when={!voters.loading && !voters.error}
          fallback={
            <Show when={!voters.error}>
              <Placeholder>
                <Trans>Loading…</Trans>
              </Placeholder>
            </Show>
          }
        >
          <Show
            when={voters()?.length}
            fallback={
              <Placeholder>
                <Trans>No votes for this answer yet</Trans>
              </Placeholder>
            }
          >
            <Column gap="sm">
              <For each={voters()}>
                {(user) => (
                  <VoterRow>
                    <Avatar src={user.animatedAvatarURL} size={28} />
                    <span>{user.displayName}</span>
                  </VoterRow>
                )}
              </For>
            </Column>
          </Show>
        </Show>
      </Column>
    </Dialog>
  );
}

const AnswerRow = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const AnswerChip = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    fontSize: "0.8125rem",
    transition: "var(--transitions-fast) all",
  },
  variants: {
    selected: {
      true: {
        background: "var(--md-sys-color-primary-container)",
        color: "var(--md-sys-color-on-primary-container)",
      },
    },
  },
});

const ChipCount = styled("span", {
  base: {
    fontWeight: "700",
    opacity: 0.7,
  },
});

const VoterRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    fontSize: "0.9rem",
  },
});

const Placeholder = styled("div", {
  base: {
    padding: "12px 0",
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

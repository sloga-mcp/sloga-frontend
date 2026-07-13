import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Client, Message, PollData } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Poll message flag (bit 6). Server-assigned only: the regular send path
 * rejects client-supplied flag values above 7, so a message carrying this
 * bit (plus the embedded definition) is a guaranteed server-counted poll.
 */
export const FLAG_POLL = 1 << 6;

/**
 * Whether a message is a server-counted poll
 */
export function isPollMessage(
  flags: number,
  poll: unknown | undefined,
): boolean {
  return (flags & FLAG_POLL) === FLAG_POLL && !!poll;
}

/**
 * Coalesced poll-state hydration: PollMessage instances mounting in the
 * same tick (one page of messages) are batched into a single
 * `POST /channels/:id/polls/fetch` instead of one GET per poll (N+1).
 */
const hydrationQueues = new Map<
  string,
  { messages: Map<string, Message>; timer: ReturnType<typeof setTimeout> }
>();

function requestPollState(client: Client, message: Message) {
  const poll = message.poll;
  if (!poll || message.pollState?.hydrated) return;

  const channelId = message.channelId;
  let queue = hydrationQueues.get(channelId);
  if (!queue) {
    queue = {
      messages: new Map(),
      timer: setTimeout(() => {
        const batch = queue!;
        hydrationQueues.delete(channelId);

        const ids = [...batch.messages.keys()];
        client.channels
          .apiReq("POST", `/channels/${channelId}/polls/fetch`, {
            body: { ids },
          })
          .then((response) => {
            for (const data of response as PollData[]) {
              const target = [...batch.messages.values()].find(
                (candidate) => candidate.poll?.id === data._id,
              );
              target?.applyPollState(data);
            }
          })
          .catch(() => {
            /* cold-render hydration is best-effort; voting still works */
          });
      }, 50),
    };
    hydrationQueues.set(channelId, queue);
  }

  queue.messages.set(poll.id, message);
}

interface Props {
  /**
   * Poll message
   */
  message: Message;
}

/**
 * Interactive card for server-counted poll messages
 */
export function PollMessage(props: Props) {
  const client = useClient();
  const e2ee = useE2EE();
  const { t } = useLingui();
  const { openModal, showError } = useModals();

  const definition = () => props.message.poll!;
  const state = () => props.message.pollState;

  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));

  onMount(() => requestPollState(client(), props.message));

  // Multi-select ballots are staged locally until submitted
  const [staged, setStaged] = createSignal<number[]>([]);
  const [busy, setBusy] = createSignal(false);

  const isSelfAuthor = () => props.message.authorId === client().user?.id;
  const myVotes = () => state()?.myVotes ?? [];
  const hasVoted = () => myVotes().length > 0;
  const closed = () => state()?.closed ?? false;
  const expired = () => definition().expires_at <= now();

  /**
   * In an E2EE conversation a poll should not exist (the composer refuses
   * to create them); if one arrives anyway, show a notice, never a ballot.
   * The `sendModes` cache is keyed by the E2EE conversation id: the PEER
   * USER id for DMs, the channel id for groups (same rule as the composer).
   */
  const encryptedContext = () => {
    const channel = props.message.channel;
    if (!channel) return false;
    const conversationId =
      channel.type === "DirectMessage" ? channel.recipient?.id : channel.id;
    return (
      !!conversationId && e2ee?.sendModes.get(conversationId) === "encrypt"
    );
  };

  const canManage = () =>
    isSelfAuthor() ||
    props.message.channel?.havePermission("ManageMessages") === true;

  /**
   * Hidden-until-vote, mirrored client-side: results render only for
   * voters, the author, moderators (the server sends them counts too), or
   * once the poll closed. (The server omits counts for everyone else.)
   */
  const showResults = () =>
    (closed() || hasVoted() || isSelfAuthor() || canManage()) &&
    state()?.counts !== undefined;

  const totalSelections = createMemo(() =>
    (state()?.counts ?? []).reduce((sum, count) => sum + count.count, 0),
  );

  const countFor = (id: number) =>
    state()?.counts?.find((count) => count.answer_id === id)?.count ?? 0;

  const percentFor = (id: number) =>
    totalSelections() === 0
      ? 0
      : Math.round((countFor(id) / totalSelections()) * 100);

  const remainingLabel = () => {
    const remaining = definition().expires_at - now();
    if (remaining <= 0) return t`Closing…`;
    const minutes = Math.ceil(remaining / 60_000);
    if (minutes < 60) return t`${minutes}m left`;
    const hours = Math.ceil(minutes / 60);
    if (hours < 48) return t`${hours}h left`;
    return t`${Math.ceil(hours / 24)}d left`;
  };

  async function castBallot(answerIds: number[]) {
    if (busy() || closed() || expired()) return;
    setBusy(true);
    try {
      await props.message.votePoll(answerIds);
      setStaged([]);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  async function retract() {
    if (busy() || closed() || expired()) return;
    setBusy(true);
    try {
      await props.message.removePollVote();
      setStaged([]);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  function onAnswerClick(id: number) {
    if (closed() || expired() || encryptedContext()) return;

    if (definition().allow_multiselect) {
      // A cast ballot renders from myVotes — staging is only meaningful
      // before voting (or after retracting, which clears it)
      if (hasVoted()) return;
      setStaged((current) =>
        current.includes(id)
          ? current.filter((staged) => staged !== id)
          : [...current, id],
      );
    } else {
      // Single select: voting (or re-voting) is immediate
      if (!myVotes().includes(id)) void castBallot([id]);
    }
  }

  return (
    <Card>
      <Header>
        <Symbol size={18}>ballot</Symbol>
        <Question>{definition().question}</Question>
      </Header>

      <Show when={definition().allow_multiselect && !closed()}>
        <Hint>
          <Trans>Select one or more answers</Trans>
        </Hint>
      </Show>

      <Answers>
        <For each={definition().answers}>
          {(answer) => {
            const selected = () =>
              definition().allow_multiselect && !hasVoted()
                ? staged().includes(answer.id)
                : myVotes().includes(answer.id);

            return (
              <Answer
                type="button"
                disabled={closed() || expired() || encryptedContext() || busy()}
                data-selected={selected() || undefined}
                onClick={() => onAnswerClick(answer.id)}
              >
                <Show when={showResults()}>
                  <Bar style={{ width: `${percentFor(answer.id)}%` }} />
                </Show>
                <AnswerContent>
                  <Show
                    when={!closed() && !expired() && !encryptedContext()}
                  >
                    <SelectMark
                      data-multi={definition().allow_multiselect || undefined}
                      data-selected={selected() || undefined}
                    >
                      <Show when={selected()}>
                        <Symbol size={14}>check</Symbol>
                      </Show>
                    </SelectMark>
                  </Show>
                  <Show when={answer.emoji}>
                    <span>{answer.emoji}</span>
                  </Show>
                  <AnswerText>{answer.text}</AnswerText>
                  <Show when={showResults()}>
                    <Result>
                      <span>{countFor(answer.id)}</span>
                      <Percent>{percentFor(answer.id)}%</Percent>
                    </Result>
                  </Show>
                </AnswerContent>
              </Answer>
            );
          }}
        </For>
      </Answers>

      <Show when={encryptedContext()}>
        <Hint>
          <Trans>
            Polls are not available in encrypted conversations — votes are
            counted by the server.
          </Trans>
        </Hint>
      </Show>

      <Footer>
        <Switch
          fallback={
            <FooterInfo>
              <Symbol size={14}>schedule</Symbol> {remainingLabel()}
            </FooterInfo>
          }
        >
          <Match when={closed()}>
            <FinalBadge>
              <Symbol size={14}>how_to_vote</Symbol>{" "}
              <Trans>Final results</Trans>
            </FinalBadge>
          </Match>
        </Switch>

        <Show when={showResults()}>
          <FooterInfo>
            <Trans>{state()?.totalVotes ?? 0} votes</Trans>
          </FooterInfo>
        </Show>

        <Show when={!showResults() && !encryptedContext()}>
          <FooterInfo>
            <Trans>Vote to see results</Trans>
          </FooterInfo>
        </Show>

        <Spacer />

        <Show
          when={
            definition().allow_multiselect &&
            !hasVoted() &&
            staged().length > 0 &&
            !closed() &&
            !expired()
          }
        >
          <FooterAction
            type="button"
            disabled={busy()}
            onClick={() => void castBallot(staged())}
          >
            <Trans>Vote</Trans>
          </FooterAction>
        </Show>

        <Show when={hasVoted() && !closed() && !expired()}>
          <FooterAction type="button" disabled={busy()} onClick={retract}>
            <Trans>Remove vote</Trans>
          </FooterAction>
        </Show>

        <Show when={canManage()}>
          <FooterAction
            type="button"
            onClick={() =>
              openModal({ type: "poll_voters", message: props.message })
            }
          >
            <Trans>View votes</Trans>
          </FooterAction>
        </Show>
      </Footer>
    </Card>
  );
}

const Card = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "12px 14px",
    marginTop: "2px",
    width: "420px",
    maxWidth: "100%",
    borderRadius: "12px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--gap-sm)",
    color: "var(--md-sys-color-primary)",
  },
});

const Question = styled("span", {
  base: {
    fontWeight: "700",
    fontSize: "0.95rem",
    color: "var(--md-sys-color-on-surface)",
    overflowWrap: "anywhere",
  },
});

const Hint = styled("div", {
  base: {
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Answers = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
});

const Answer = styled("button", {
  base: {
    position: "relative",
    overflow: "hidden",
    textAlign: "left",
    padding: "0",
    borderRadius: "8px",
    border: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    "&:disabled": {
      cursor: "default",
    },
    "&[data-selected]": {
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const Bar = styled("div", {
  base: {
    position: "absolute",
    inset: "0 auto 0 0",
    background: "var(--md-sys-color-primary-container)",
    opacity: 0.55,
    transition: "width 0.3s ease",
  },
});

const AnswerContent = styled("div", {
  base: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 12px",
  },
});

const AnswerText = styled("span", {
  base: {
    flexGrow: 1,
    fontSize: "0.9rem",
    overflowWrap: "anywhere",
  },
});

const SelectMark = styled("span", {
  base: {
    width: "18px",
    height: "18px",
    flexShrink: 0,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    border: "2px solid var(--md-sys-color-outline)",
    color: "var(--md-sys-color-on-primary)",
    "&[data-multi]": {
      borderRadius: "5px",
    },
    "&[data-selected]": {
      background: "var(--md-sys-color-primary)",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const Result = styled("span", {
  base: {
    display: "flex",
    alignItems: "baseline",
    gap: "6px",
    fontSize: "0.8rem",
    fontVariantNumeric: "tabular-nums",
  },
});

const Percent = styled("span", {
  base: {
    fontWeight: "700",
    minWidth: "38px",
    textAlign: "right",
  },
});

const Footer = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const FooterInfo = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
});

const FinalBadge = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontWeight: "700",
    color: "var(--md-sys-color-primary)",
  },
});

const Spacer = styled("span", {
  base: {
    flexGrow: 1,
  },
});

const FooterAction = styled("button", {
  base: {
    padding: "4px 10px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-primary-container)",
    color: "var(--md-sys-color-on-primary-container)",
    fontWeight: "600",
    fontSize: "0.75rem",
    cursor: "pointer",
    "&:disabled": {
      opacity: 0.5,
      cursor: "default",
    },
  },
});

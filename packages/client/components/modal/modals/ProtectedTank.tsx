import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { i18n } from "@lingui/core";
import type { Client } from "stoat.js";
import { styled } from "styled-system/jsx";

import {
  type CipherApi,
  CipherClientError,
} from "@revolt/app/interface/settings/user/cipherCheckout";
import {
  formatLedgerTime,
  formatProt,
  parseProtFeature,
} from "@revolt/app/interface/settings/user/protWallet";
import { useClient } from "@revolt/client";
import { allowsProtSpending } from "@revolt/client/distribution";
import {
  type ProtContributorView,
  type ProtGoalView,
  type ProtTankStage,
  type ProtTankSummary,
  type ProtTankView,
  contributorLabel,
  deletePledge,
  fetchProtTank,
  parseProtTankFeature,
  withdrawOpen,
} from "@revolt/client/protTank";
import { noticeCopy, settingsCopy } from "@revolt/client/protectedCopy";
import CONFIGURATION from "@revolt/common/lib/env";
import { useError } from "@revolt/i18n/errors";
import { Avatar } from "@revolt/ui/components/design/Avatar";
import { Button } from "@revolt/ui/components/design/Button";
import { type DialogProps, Dialog } from "@revolt/ui/components/design/Dialog";
import { CircularProgress } from "@revolt/ui/components/design/LoadingProgress";
import { Column } from "@revolt/ui/components/layout/Column";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Headers for a request as the session user (as on the Prot settings page):
 * the `/prot` routes are newer than the generated stoat-api schema.
 */
function jsonHeaders(client: Client): Record<string, string> {
  const [header, token] = client.authenticationHeader;
  return { [header]: token, "Content-Type": "application/json" };
}

/** What the last read of the tank said */
type TankRead =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "tank"; view: ProtTankView };

/** Color family of the stage card */
type StageTone = "ok" | "warn" | "stop";

function stageTone(stage: ProtTankStage): StageTone {
  switch (stage) {
    case "Launching":
    case "Active":
      return "ok";
    case "Grace":
      return "warn";
    case "Frozen":
    case "Settling":
    case "Deleted":
    case "Terminated":
      return "stop";
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}

function stageIcon(stage: ProtTankStage): string {
  switch (stage) {
    case "Launching":
      return "rocket_launch";
    case "Active":
      return "verified_user";
    case "Grace":
      return "hourglass_bottom";
    case "Frozen":
      return "ac_unit";
    case "Settling":
      return "pending";
    case "Deleted":
      return "delete_forever";
    case "Terminated":
      return "block";
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}

/** Share of a goal's target pledged so far, 0..100 */
function goalPercent(goal: ProtGoalView): number {
  if (goal.target_prot <= 0) return 100;
  const share = (goal.pledged_total / goal.target_prot) * 100;
  return Math.max(0, Math.min(100, Math.floor(share)));
}

/** The caller's pledges to a goal that still hold Prot */
function yourHeldPledges(goal: ProtGoalView) {
  return goal.your_pledges.filter(
    (pledge) => pledge.state === "Held" && pledge.remaining > 0,
  );
}

/** What the caller still has pledged to a goal */
function yourHeldPledge(goal: ProtGoalView): number {
  return yourHeldPledges(goal).reduce(
    (sum, pledge) => sum + pledge.remaining,
    0,
  );
}

/**
 * The fuel tank of a Protected channel, for anyone who can see the channel:
 * its stage with the protected-until, grace and deletion dates (a deletion
 * date only when the server sent `deletes_at`), the tank balance (every
 * viewer sees it, owner answer 9), seats used out of the slot tier, the open
 * goals with their progress, and the contributors ("Anonymous" for a hidden
 * one, "Deleted user" for a deleted account; neither ever shows a user).
 *
 * The state is read from `GET /prot/channels/<id>/tank` on open, again on
 * every `ProtTankUpdate` for the channel, and after a top-up; the summary
 * goes through `client.setProtTank`, so the banner and the shield see the
 * same tank. `NotFound` means the channel has no tank (an admin-granted
 * channel, or one the caller can't see): `setProtTank(id, undefined)`.
 *
 * Every figure here is the server's. The spending entry points are "Top up"
 * and, on a Funding upgrade goal, "Pledge" (both to `prot_contribute`),
 * shown only where `allowsProtSpending()` is true (store builds, D5), Prot
 * is switched on, the advert offers a minimum contribution and the server
 * says this caller may contribute now. "Withdraw pledge" returns Prot, so it
 * shows in every build while Prot is on and the withdraw cutoff hasn't
 * passed (confirmed first). Balance, stage, goals and contributors show in
 * every build.
 */
export function ProtectedTankModal(
  props: DialogProps & Modals & { type: "prot_tank" },
) {
  const { t } = useLingui();
  const client = useClient();
  const modals = useModals();
  const err = useError();

  const api: CipherApi = {
    fetch: (url, init) => fetch(url, init),
    apiBase: CONFIGURATION.DEFAULT_API_URL,
    headers: () => jsonHeaders(client()),
  };

  const channelId = () => props.channel.id;

  // The upstream stoat-api config type has no `prot`
  const protAdvert = () =>
    (client().configuration?.features as { prot?: unknown } | undefined)?.prot;
  const protEnabled = createMemo(() => parseProtFeature(protAdvert()).enabled);
  const tankRules = createMemo(() => {
    const advert = protAdvert();
    return parseProtTankFeature(
      typeof advert === "object" && advert !== null
        ? (advert as { tank?: unknown }).tank
        : undefined,
    );
  });

  const [read, setRead] = createSignal<TankRead>({ kind: "loading" });
  const [error, setError] = createSignal<unknown>();
  const [loading, setLoading] = createSignal(false);

  // One read at a time; an event during a read asks for one more after it,
  // so a burst of updates costs at most two reads and the last one wins
  let unmounted = false;
  let inFlight = false;
  let again = false;
  onCleanup(() => {
    unmounted = true;
  });

  async function refresh() {
    if (unmounted) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    setLoading(true);
    const id = channelId();
    try {
      const view = await fetchProtTank(api, id);
      if (unmounted) return;
      if (view) {
        client().setProtTank(id, view.tank);
        setRead({ kind: "tank", view });
      } else {
        // NotFound: no tank (BR3)
        client().setProtTank(id, undefined);
        setRead({ kind: "none" });
      }
      setError(undefined);
    } catch (failure) {
      // Data first: a failed read keeps the last one on screen
      if (!unmounted) setError(failure);
    } finally {
      inFlight = false;
      if (!unmounted) setLoading(false);
      if (again && !unmounted) {
        again = false;
        void refresh();
      }
    }
  }

  onMount(() => void refresh());

  // Contributors, goals and seats come only with a read; the summary in the
  // event is laid over by the client store already
  createEffect(
    on(client, (current) => {
      const onUpdate = (updated: string) => {
        if (updated === channelId()) void refresh();
      };
      current.on("protTankUpdate", onUpdate);
      onCleanup(() => current.off("protTankUpdate", onUpdate));
    }),
  );

  const view = () => {
    const state = read();
    return state.kind === "tank" ? state.view : undefined;
  };

  /**
   * The tank as the client store holds it (newest of reads and events).
   * Gone from the store (a `ProtTankUpdate` without a tank) reads as no
   * tank while the follow-up read runs.
   */
  const summary = (): ProtTankSummary | undefined =>
    view() ? client().protTanks.get(channelId()) : undefined;

  /** The last read is about the tank the store holds (not a relaunched one) */
  const detail = () => {
    const current = summary();
    const last = view();
    return current && last && last.tank.tank_id === current.tank_id
      ? last
      : undefined;
  };

  const noTank = () =>
    read().kind === "none" || (read().kind === "tank" && !summary());

  const topUpOffered = () =>
    allowsProtSpending() &&
    protEnabled() &&
    tankRules().min_contribution > 0 &&
    detail()?.can_contribute === true;

  /**
   * The only `prot_contribute` open site in this panel. Store builds never
   * reach it (D5, S6 pin): the button is behind `topUpOffered()`, and this
   * checks `allowsProtSpending()` again.
   */
  function openTopUp() {
    if (!allowsProtSpending()) return;
    modals.openModal({
      type: "prot_contribute",
      target: { kind: "tank", channel: props.channel },
      onDone: () => void refresh(),
    });
  }

  /**
   * Pledging to an open upgrade goal of this tank. A hint only (the server
   * checks eligibility, the minimum and the purchase hold): Funding goals,
   * for a caller the server lets contribute to this tank.
   */
  const pledgeOffered = (goal: ProtGoalView) =>
    allowsProtSpending() &&
    protEnabled() &&
    tankRules().min_contribution > 0 &&
    detail()?.can_contribute === true &&
    goal.kind === "Upgrade" &&
    goal.state === "Funding";

  /**
   * The only other `prot_contribute` open site in this panel, gated like
   * {@link openTopUp}: behind `pledgeOffered(goal)` and checked again here.
   */
  function openPledge(goal: ProtGoalView) {
    if (!allowsProtSpending()) return;
    modals.openModal({
      type: "prot_contribute",
      target: { kind: "goal", goalId: goal.id, serverId: goal.server_id },
      onDone: () => void refresh(),
    });
  }

  // Ticks when a withdraw cutoff passes, so "Withdraw pledge" goes away
  const [clock, setClock] = createSignal(Date.now());
  createEffect(() => {
    const now = clock();
    let next = Infinity;
    for (const goal of detail()?.goals ?? []) {
      if (goal.withdraw_until >= now) {
        next = Math.min(next, goal.withdraw_until);
      }
    }
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.min(next - now + 1000, 2 ** 31 - 1),
    );
    onCleanup(() => clearTimeout(timer));
  });

  /**
   * Withdrawing returns Prot, so it is not behind `allowsProtSpending()`;
   * the route refuses it while Prot is switched off, so it needs that.
   */
  const withdrawOffered = (goal: ProtGoalView) =>
    protEnabled() && yourHeldPledge(goal) > 0 && withdrawOpen(goal, clock());

  // The goal whose withdraw is waiting for confirmation, the goal whose
  // withdraw is running, and the last refusal (by goal)
  const [confirming, setConfirming] = createSignal<string>();
  const [withdrawing, setWithdrawing] = createSignal<string>();
  const [goalError, setGoalError] = createSignal<{
    goalId: string;
    message: string;
  }>();

  function askWithdraw(goal: ProtGoalView) {
    setGoalError(undefined);
    setConfirming(goal.id);
  }

  /** Every held pledge of the caller to `goal`, then a fresh read */
  async function withdraw(goal: ProtGoalView) {
    if (withdrawing() !== undefined || !protEnabled()) return;
    if (!withdrawOpen(goal, Date.now())) {
      setClock(Date.now());
      setConfirming(undefined);
      return;
    }
    const pledges = yourHeldPledges(goal);
    if (pledges.length === 0) return;
    setWithdrawing(goal.id);
    setGoalError(undefined);
    try {
      for (const pledge of pledges) {
        await deletePledge(api, goal.id, pledge.id);
        if (unmounted) return;
      }
      setConfirming(undefined);
    } catch (failure) {
      if (!unmounted) {
        setGoalError({ goalId: goal.id, message: describeWithdraw(failure) });
      }
    } finally {
      if (!unmounted) setWithdrawing(undefined);
      // Whatever happened, show what the server now holds
      void refresh();
    }
  }

  // Names for contributor lines whose user isn't loaded yet
  const requested = new Set<string>();
  createEffect(() => {
    const lines = detail()?.contributors ?? [];
    const c = client();
    for (const line of lines) {
      const label = contributorLabel(line);
      if (label.kind !== "user") continue;
      if (requested.has(label.userId) || c.users.get(label.userId)) continue;
      requested.add(label.userId);
      c.users.fetch(label.userId).catch(() => {
        // the line falls back to the id; nothing else depends on it
      });
    }
  });

  // In the app locale, as on the Prot settings page
  function protAmount(value: number) {
    const amount = formatProt(value, i18n.locale);
    return t`${amount} Prot`;
  }

  function when(ms: number) {
    return formatLedgerTime(ms, i18n.locale);
  }

  function stageTitle(tank: ProtTankSummary): string {
    switch (tank.stage) {
      case "Launching":
        return t`Launching`;
      case "Active": {
        if (tank.protected_until === undefined) return t`Active`;
        const date = when(tank.protected_until);
        return t`Protected until ${date}`;
      }
      case "Grace":
        return t`Grace period`;
      case "Frozen":
        return t`Frozen`;
      case "Settling":
        return t`Closing`;
      case "Deleted":
        return t`Deleted`;
      case "Terminated":
        return t`Closed by Sloga`;
      default: {
        const exhaustive: never = tank.stage;
        return exhaustive;
      }
    }
  }

  function stageText(tank: ProtTankSummary): string | undefined {
    switch (tank.stage) {
      case "Launching":
        return t`This Protected channel's tank is being set up.`;
      case "Active":
        return undefined;
      case "Grace": {
        if (tank.grace_ends_at === undefined) return noticeCopy("tank_grace");
        const date = when(tank.grace_ends_at);
        return t`This Protected channel has run out of Prot. It keeps working until ${date}, but new members can't be added. Top it up to keep it active.`;
      }
      case "Frozen":
        return t`This Protected channel is frozen. You can read its history, but nothing can be sent until it's topped up.`;
      case "Settling":
        return t`This Protected channel is being closed.`;
      case "Deleted":
        return t`This Protected channel was deleted from Sloga's servers because it ran out of Prot.`;
      case "Terminated":
        return noticeCopy("tank_deleted");
      default: {
        const exhaustive: never = tank.stage;
        return exhaustive;
      }
    }
  }

  /** Only when the server promises a date (deletion enabled, NIT 32) */
  function deletionText(tank: ProtTankSummary): string | undefined {
    if (tank.deletes_at === undefined) return undefined;
    if (tank.stage !== "Grace" && tank.stage !== "Frozen") return undefined;
    const date = when(tank.deletes_at);
    return t`It may be deleted from Sloga's servers after ${date}.`;
  }

  function dailyCostLine(cost: number) {
    const amount = formatProt(cost, i18n.locale);
    return t`Uses ${amount} Prot a day`;
  }

  function pendingTierLine(tier: number) {
    return t`Moving to ${tier} seats once enough seats are free.`;
  }

  function goalTitle(goal: ProtGoalView): string {
    return goal.kind === "Upgrade" ? t`Upgrade goal` : t`Launch goal`;
  }

  function goalSeats(goal: ProtGoalView): string {
    const slots = goal.slots;
    return t`${slots} seats`;
  }

  function goalProgress(goal: ProtGoalView): string {
    const pledged = formatProt(goal.pledged_total, i18n.locale);
    const target = formatProt(goal.target_prot, i18n.locale);
    return t`${pledged} of ${target} Prot`;
  }

  function goalStatus(goal: ProtGoalView): string | undefined {
    switch (goal.state) {
      case "Funding": {
        const date = when(goal.deadline_at);
        return t`Ends ${date}`;
      }
      case "Funded":
        return t`Funded`;
      case "Launching":
        return t`Funded, waiting to launch`;
      default:
        return undefined;
    }
  }

  function yourPledgeLine(amount: number) {
    const pledged = formatProt(amount, i18n.locale);
    return t`You pledged ${pledged} Prot`;
  }

  function contributorName(line: ProtContributorView): string {
    const label = contributorLabel(line);
    switch (label.kind) {
      case "anonymous":
        return t({ message: "Anonymous", context: "Prot contributor" });
      case "deleted":
        return t({ message: "Deleted user", context: "Prot contributor" });
      case "user": {
        const c = client();
        const member = c.serverMembers.getByKey({
          server: props.channel.serverId,
          user: label.userId,
        });
        const user = c.users.get(label.userId);
        return member?.displayName ?? user?.displayName ?? label.userId;
      }
      default: {
        const exhaustive: never = label;
        return exhaustive;
      }
    }
  }

  function contributorAvatar(line: ProtContributorView): string | undefined {
    const label = contributorLabel(line);
    if (label.kind !== "user") return undefined;
    const c = client();
    const member = c.serverMembers.getByKey({
      server: props.channel.serverId,
      user: label.userId,
    });
    return (
      member?.animatedAvatarURL ?? c.users.get(label.userId)?.animatedAvatarURL
    );
  }

  function describeRead(failure: unknown): string {
    if (failure instanceof CipherClientError) {
      return failure.kind === "rateLimited"
        ? t`Slow down — try again in a moment`
        : t`This channel's funding couldn't be loaded. Try again in a moment.`;
    }
    return err(failure);
  }

  function describeWithdraw(failure: unknown): string {
    if (failure instanceof CipherClientError) {
      return failure.kind === "rateLimited"
        ? t`Slow down — try again in a moment`
        : t`Your pledge couldn't be withdrawn. Try again in a moment.`;
    }
    return err(failure);
  }

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={props.onClose}
      title={t`Protected channel funding`}
      actions={[{ text: <Trans>Close</Trans> }]}
    >
      <Column>
        <Description>
          <Trans>
            Prot is the credit that keeps Protected servers and channels
            running. This channel uses Prot from its tank each day.
          </Trans>
        </Description>

        <Switch>
          <Match when={summary()}>
            {(tank) => (
              <Column>
                <StageCard data-tone={stageTone(tank().stage)} role="status">
                  <Symbol size={22}>{stageIcon(tank().stage)}</Symbol>
                  <StageText>
                    <StageTitle>{stageTitle(tank())}</StageTitle>
                    <Show when={stageText(tank())}>
                      {(text) => <StageLine>{text()}</StageLine>}
                    </Show>
                    <Show when={deletionText(tank())}>
                      {(text) => <StageLine>{text()}</StageLine>}
                    </Show>
                  </StageText>
                </StageCard>

                <Figures>
                  <Figure>
                    <FigureLabel>
                      <Trans>Tank balance</Trans>
                    </FigureLabel>
                    <FigureValue>{protAmount(tank().balance)}</FigureValue>
                    <Show when={tank().daily_cost > 0}>
                      <FigureNote>
                        {dailyCostLine(tank().daily_cost)}
                      </FigureNote>
                    </Show>
                  </Figure>
                  <Figure>
                    <FigureLabel>
                      <Trans>Seats</Trans>
                    </FigureLabel>
                    <FigureValue>
                      <Show
                        when={detail()}
                        fallback={<CircularProgress size={16} />}
                      >
                        {(last) =>
                          settingsCopy.seatsUsed(
                            last().seats_used,
                            tank().slot_tier,
                          )
                        }
                      </Show>
                    </FigureValue>
                    <Show when={tank().pending_slot_tier}>
                      {(tier) => (
                        <FigureNote>{pendingTierLine(tier())}</FigureNote>
                      )}
                    </Show>
                  </Figure>
                  <Show when={(detail()?.you_contributed ?? 0) > 0}>
                    <Figure>
                      <FigureLabel>
                        <Trans>You contributed</Trans>
                      </FigureLabel>
                      <FigureValue>
                        {protAmount(detail()?.you_contributed ?? 0)}
                      </FigureValue>
                    </Figure>
                  </Show>
                </Figures>

                <Show when={topUpOffered()}>
                  <TopUp>
                    <Description>
                      {t`Contributing supports this server. It does not reserve a seat; the owner chooses members.`}
                    </Description>
                    <Button onPress={openTopUp}>
                      <Trans>Top up</Trans>
                    </Button>
                  </TopUp>
                </Show>

                <Show when={detail()?.goals.length}>
                  <Section>
                    <SectionTitle>
                      <Trans>Goals</Trans>
                    </SectionTitle>
                    <For each={detail()?.goals}>
                      {(goal) => (
                        <GoalCard>
                          <GoalHead>
                            <GoalName>{goalTitle(goal)}</GoalName>
                            <GoalNote>{goalSeats(goal)}</GoalNote>
                          </GoalHead>
                          <Track
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={goalPercent(goal)}
                            aria-valuetext={goalProgress(goal)}
                          >
                            <Fill style={{ width: `${goalPercent(goal)}%` }} />
                          </Track>
                          <GoalHead>
                            <GoalNote>{goalProgress(goal)}</GoalNote>
                            <Show when={goalStatus(goal)}>
                              {(status) => <GoalNote>{status()}</GoalNote>}
                            </Show>
                          </GoalHead>
                          <Show when={yourHeldPledge(goal) > 0}>
                            <GoalNote>
                              {yourPledgeLine(yourHeldPledge(goal))}
                            </GoalNote>
                          </Show>
                          <Show
                            when={
                              confirming() === goal.id && withdrawOffered(goal)
                            }
                            fallback={
                              <GoalActions>
                                <Show when={pledgeOffered(goal)}>
                                  <Button
                                    size="sm"
                                    onPress={() => openPledge(goal)}
                                  >
                                    <Trans>Pledge</Trans>
                                  </Button>
                                </Show>
                                <Show when={withdrawOffered(goal)}>
                                  <Button
                                    size="sm"
                                    variant="tonal"
                                    onPress={() => askWithdraw(goal)}
                                  >
                                    <Trans>Withdraw pledge</Trans>
                                  </Button>
                                </Show>
                              </GoalActions>
                            }
                          >
                            <GoalActions role="group">
                              <GoalNote>{t`Withdraw your pledge?`}</GoalNote>
                              <Button
                                size="sm"
                                variant="tonal"
                                isDisabled={withdrawing() !== undefined}
                                onPress={() => setConfirming(undefined)}
                              >
                                <Trans>Cancel</Trans>
                              </Button>
                              <Button
                                size="sm"
                                isDisabled={withdrawing() !== undefined}
                                onPress={() => void withdraw(goal)}
                              >
                                <Trans>Withdraw pledge</Trans>
                              </Button>
                            </GoalActions>
                          </Show>
                          <Show
                            when={
                              goalError()?.goalId === goal.id && goalError()
                            }
                          >
                            {(failure) => (
                              <Notice role="alert">
                                <span>{failure().message}</span>
                              </Notice>
                            )}
                          </Show>
                        </GoalCard>
                      )}
                    </For>
                  </Section>
                </Show>

                <Show when={detail()}>
                  {(last) => (
                    <Section>
                      <SectionTitle>
                        <Trans>Contributors</Trans>
                      </SectionTitle>
                      <Show
                        when={last().contributors.length}
                        fallback={
                          <Description>
                            <Trans>No contributions yet.</Trans>
                          </Description>
                        }
                      >
                        <Rows>
                          <For each={last().contributors}>
                            {(line) => (
                              <Row>
                                <Show
                                  when={contributorLabel(line).kind === "user"}
                                  fallback={
                                    <Placeholder aria-hidden="true">
                                      <Symbol size={18}>
                                        {line.deleted
                                          ? "person_off"
                                          : "visibility_off"}
                                      </Symbol>
                                    </Placeholder>
                                  }
                                >
                                  <Avatar
                                    src={contributorAvatar(line)}
                                    fallback={contributorName(line)}
                                    size={28}
                                  />
                                </Show>
                                <RowName>{contributorName(line)}</RowName>
                                <Show when={line.you}>
                                  <Badge>
                                    <Trans>You</Trans>
                                  </Badge>
                                </Show>
                                <RowAmount>{protAmount(line.amount)}</RowAmount>
                              </Row>
                            )}
                          </For>
                        </Rows>
                      </Show>
                    </Section>
                  )}
                </Show>
              </Column>
            )}
          </Match>
          <Match when={noTank()}>
            <Description>
              <Trans>This channel doesn't have a Prot tank.</Trans>
            </Description>
          </Match>
          <Match when={!error()}>
            <Empty>
              <CircularProgress size={32} />
            </Empty>
          </Match>
        </Switch>

        <Show when={error()}>
          <Notice role="alert">
            <span>{describeRead(error())}</span>
            <Button
              size="sm"
              variant="tonal"
              isDisabled={loading()}
              onPress={() => void refresh()}
            >
              <Trans>Try again</Trans>
            </Button>
          </Notice>
        </Show>
      </Column>
    </Dialog>
  );
}

const Description = styled("p", {
  base: {
    margin: 0,
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const StageCard = styled("div", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--gap-md)",
    padding: "var(--gap-md) var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    "&[data-tone=warn]": {
      background: "var(--md-sys-color-tertiary-container)",
      color: "var(--md-sys-color-on-tertiary-container)",
    },
    "&[data-tone=stop]": {
      background: "var(--md-sys-color-error-container)",
      color: "var(--md-sys-color-on-error-container)",
    },
  },
});

const StageText = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    minWidth: 0,
  },
});

const StageTitle = styled("span", {
  base: {
    fontWeight: 600,
  },
});

const StageLine = styled("span", {
  base: {
    fontSize: "0.85rem",
  },
});

const Figures = styled("div", {
  base: {
    display: "grid",
    gap: "var(--gap-md)",
    gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
  },
});

const Figure = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    padding: "var(--gap-md) var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const FigureLabel = styled("span", {
  base: {
    fontSize: "0.8rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const FigureValue = styled("span", {
  base: {
    fontWeight: 600,
  },
});

const FigureNote = styled("span", {
  base: {
    fontSize: "0.8rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const TopUp = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",
  },
});

const Section = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
  },
});

const SectionTitle = styled("span", {
  base: {
    fontWeight: 600,
    fontSize: "0.9rem",
  },
});

const GoalCard = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-md) var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const GoalHead = styled("div", {
  base: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "var(--gap-md)",
  },
});

const GoalActions = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "var(--gap-sm)",
    "&:empty": {
      display: "none",
    },
  },
});

const GoalName = styled("span", {
  base: {
    fontWeight: 600,
  },
});

const GoalNote = styled("span", {
  base: {
    fontSize: "0.8rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Track = styled("div", {
  base: {
    height: "6px",
    borderRadius: "3px",
    overflow: "hidden",
    background: "var(--md-sys-color-surface-container-highest)",
  },
});

const Fill = styled("div", {
  base: {
    height: "100%",
    background: "var(--md-sys-color-primary)",
  },
});

const Rows = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "260px",
    overflowY: "auto",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Row = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-sm) var(--gap-lg)",
    "&:not(:last-child)": {
      borderBottom: "1px solid var(--md-sys-color-outline-variant)",
    },
  },
});

const Placeholder = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "28px",
    height: "28px",
    borderRadius: "50%",
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const RowName = styled("span", {
  base: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const RowAmount = styled("span", {
  base: {
    fontVariantNumeric: "tabular-nums",
  },
});

const Badge = styled("span", {
  base: {
    fontSize: "0.75rem",
    padding: "2px 6px",
    borderRadius: "4px",
    background: "var(--md-sys-color-secondary-container)",
    color: "var(--md-sys-color-on-secondary-container)",
  },
});

const Notice = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
  },
});

const Empty = styled("div", {
  base: {
    display: "flex",
    justifyContent: "center",
    padding: "var(--gap-lg)",
  },
});

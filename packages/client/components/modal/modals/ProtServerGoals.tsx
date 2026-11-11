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
import type { Channel, Client } from "stoat.js";
import { styled } from "styled-system/jsx";
import { ulid } from "ulid";

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
  type ProtPledgeView,
  PROT_SLOT_TIERS,
  contributorLabel,
  deletePledge,
  fetchServerGoals,
  launchGoalPrice,
  parseProtTankFeature,
  postGoalCancel,
  postGoalLaunch,
  postLaunchGoal,
  tierDailyCost,
  withdrawOpen,
} from "@revolt/client/protTank";
import CONFIGURATION from "@revolt/common/lib/env";
import { useError } from "@revolt/i18n/errors";
import { Button } from "@revolt/ui/components/design/Button";
import { type DialogProps, Dialog } from "@revolt/ui/components/design/Dialog";
import { CircularProgress } from "@revolt/ui/components/design/LoadingProgress";
import { TextField } from "@revolt/ui/components/design/TextField";
import { Column } from "@revolt/ui/components/layout/Column";

import { useModals } from "..";
import { Modals } from "../types";

// prot-pure:begin
// The rules behind what this dialog offers. No imports: the spec
// (`components/app/interface/settings/channel/protected/protTankSettings.scan.test.ts`)
// cuts this region out and runs it. Every gate here only decides what is
// offered; the server checks the owner, self-serve, eligibility, the
// deadlines and the channel again.

/** Goal states that count as open (one open launch goal per server) */
export const OPEN_GOAL_STATES: readonly string[] = [
  "Funding",
  "Funded",
  "Launching",
];

export function isOpenGoal(goal: { state: string }): boolean {
  return OPEN_GOAL_STATES.includes(goal.state);
}

/** What decides the owner's write controls */
export type GoalWriteGate = {
  /** The caller is the server owner */
  isOwner: boolean;
  /** `features.prot.enabled`: every write needs it */
  enabled: boolean;
  /** `features.prot.self_serve_enabled`: goals and tiers need it (8.0) */
  selfServe: boolean;
  /** `allowsProtSpending()`: off in store builds (D5) */
  spending: boolean;
};

/**
 * The owner's writes: `manage` (cancel a goal, which only returns Prot)
 * needs Prot and self-serve on; `spend` (open or launch a goal) also needs
 * a build that may spend Prot.
 */
export function ownerGoalWrites(gate: GoalWriteGate): {
  manage: boolean;
  spend: boolean;
} {
  const manage =
    gate.isOwner === true && gate.enabled === true && gate.selfServe === true;
  return { manage, spend: manage && gate.spending === true };
}

/** "Open a launch goal" is offered only while none is open */
export function createLaunchGoalOffered(
  gate: GoalWriteGate,
  goals: readonly { state: string }[],
): boolean {
  return ownerGoalWrites(gate).spend && !goals.some(isOpenGoal);
}

/**
 * What the viewer may do with one launch goal at `nowMs`. Pledging is a
 * member action (no owner or self-serve check) but spends Prot; withdrawing
 * is decided per pledge by {@link withdrawablePledges}.
 */
export function launchGoalActions(
  goal: { state: string; deadline_at: number; launch_deadline_at?: number },
  nowMs: number,
  gate: GoalWriteGate,
  minContribution: number,
): { pledge: boolean; cancel: boolean; launch: boolean } {
  const owner = ownerGoalWrites(gate);
  return {
    pledge:
      gate.spending === true &&
      gate.enabled === true &&
      Number.isSafeInteger(minContribution) &&
      minContribution > 0 &&
      goal.state === "Funding" &&
      nowMs < goal.deadline_at,
    cancel: owner.manage && isOpenGoal(goal),
    launch:
      owner.spend &&
      goal.state === "Funded" &&
      typeof goal.launch_deadline_at === "number" &&
      nowMs <= goal.launch_deadline_at,
  };
}

/**
 * The viewer's pledges that a "Withdraw pledge" button is shown for: Held
 * with something left, while Prot is on and the goal's withdraw window is
 * open (`withdrawOpen`). Returning Prot is never spend-gated.
 */
export function withdrawablePledges<
  P extends { state: string; remaining: number },
>(pledges: readonly P[], enabled: boolean, windowOpen: boolean): P[] {
  if (enabled !== true || windowOpen !== true) return [];
  return pledges.filter(
    (pledge) => pledge.state === "Held" && pledge.remaining > 0,
  );
}

/** What the viewer still has held in a goal */
export function heldPledgeTotal(
  pledges: readonly { state: string; remaining: number }[],
): number {
  return pledges
    .filter((pledge) => pledge.state === "Held" && pledge.remaining > 0)
    .reduce((sum, pledge) => sum + pledge.remaining, 0);
}

/** A channel as the launch picker sees it */
export type LaunchChannelInput = {
  id: string;
  type: string;
  serverId: string | undefined;
  voice: boolean;
  announcement: boolean;
  protected: boolean;
  lastMessageId: string | undefined | null;
};

/**
 * Channels a funded launch goal can be launched on (8.6): text channels of
 * this server that are not protected, not voice, not announcement and have
 * no messages. The server checks all of it again, and that the channel has
 * no tank.
 */
export function launchableChannels<C extends LaunchChannelInput>(
  channels: readonly C[],
  serverId: string,
): C[] {
  return channels.filter(
    (channel) =>
      channel.type === "TextChannel" &&
      channel.serverId === serverId &&
      channel.voice !== true &&
      channel.announcement !== true &&
      channel.protected !== true &&
      !(
        typeof channel.lastMessageId === "string" &&
        channel.lastMessageId.length > 0
      ),
  );
}

/** A whole number typed into a field, or `null` */
export function parseWholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * One nonce per intent: a retry of the same request (same `key`) reuses
 * the nonce, so the server applies it once; a different request, or one
 * after `clear()`, gets a new one.
 */
export function createNonceKeeper(make: () => string): {
  nonceFor: (key: string) => string;
  clear: () => void;
} {
  let held: { key: string; nonce: string } | undefined;
  return {
    nonceFor(key: string): string {
      if (!held || held.key !== key) held = { key, nonce: make() };
      return held.nonce;
    },
    clear() {
      held = undefined;
    },
  };
}
// prot-pure:end

/**
 * Headers for a request as the session user (as on the Prot settings page):
 * the `/prot` routes are newer than the generated stoat-api schema.
 */
function jsonHeaders(client: Client): Record<string, string> {
  const [header, token] = client.authenticationHeader;
  return { [header]: token, "Content-Type": "application/json" };
}

/** Share of a goal's target pledged so far, 0..100 */
function goalPercent(goal: ProtGoalView): number {
  if (goal.target_prot <= 0) return 100;
  const share = (goal.pledged_total / goal.target_prot) * 100;
  return Math.max(0, Math.min(100, Math.floor(share)));
}

/** An inline confirm in progress */
type Confirming =
  | { kind: "cancel"; goalId: string }
  | { kind: "withdraw"; goalId: string; pledgeId: string }
  | { kind: "launch"; goalId: string };

/**
 * A server's launch goals (S5b, contracts 8.2-8.6, 16.3): members pool
 * Prot to fund a new Protected channel.
 *
 * Everyone who can see the server sees the open launch goals, their
 * progress, contributors ("Anonymous" for a hidden one, "Deleted user" for
 * a deleted account) and their own held pledge, in every build and while
 * Prot is switched off (reads stay open, owner answer 3).
 *
 * Members: "Pledge" (to `prot_contribute`) only where `allowsProtSpending()`
 * is true, Prot is on and the goal is Funding, with the seat notice next to
 * it; "Withdraw pledge" for a held pledge while the withdraw window is open
 * (it returns Prot, so every build).
 *
 * The owner, only while Prot and self-serve are both on (owner answer 1:
 * no goals before self-serve): "Open a launch goal" (one open per server,
 * owner answer 5) and "Launch" on an empty text channel, both behind
 * `allowsProtSpending()`; "Cancel goal" in every build (pledges go back).
 * With self-serve off the owner sees a note, never a button that fails.
 *
 * The server prices every goal; the target shown before creating is a
 * preview from the root advert.
 */
export function ProtServerGoalsModal(
  props: DialogProps & Modals & { type: "prot_server_goals" },
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

  const serverId = () => props.server.id;

  // The upstream stoat-api config type has no `prot`
  const protAdvert = () =>
    (client().configuration?.features as { prot?: unknown } | undefined)?.prot;
  const feature = createMemo(() => parseProtFeature(protAdvert()));
  const tankRules = createMemo(() => {
    const advert = protAdvert();
    return parseProtTankFeature(
      typeof advert === "object" && advert !== null
        ? (advert as { tank?: unknown }).tank
        : undefined,
    );
  });

  const isOwner = () =>
    !!client().user?.id && props.server.ownerId === client().user?.id;

  const gate = (): GoalWriteGate => ({
    isOwner: isOwner(),
    enabled: feature().enabled,
    selfServe: feature().self_serve_enabled,
    spending: allowsProtSpending(),
  });

  // Deadlines and withdraw windows pass while the dialog is open
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(clock));

  const [goals, setGoals] = createSignal<ProtGoalView[]>();
  const [readError, setReadError] = createSignal<unknown>();
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal<string>();
  const [confirming, setConfirming] = createSignal<Confirming>();
  const [launchChannel, setLaunchChannel] = createSignal<string>();

  // One read at a time; a request during a read asks for one more after it
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
    try {
      const list = await fetchServerGoals(api, serverId());
      if (unmounted) return;
      setGoals(list);
      setReadError(undefined);
    } catch (failure) {
      // Data first: a failed read keeps the last list on screen
      if (!unmounted) setReadError(failure);
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

  // A launch lands as a tank on one of this server's channels: read again
  createEffect(
    on(client, (current) => {
      const onUpdate = (channelId: string) => {
        if (current.channels.get(channelId)?.serverId === serverId()) {
          void refresh();
        }
      };
      current.on("protTankUpdate", onUpdate);
      onCleanup(() => current.off("protTankUpdate", onUpdate));
    }),
  );

  const list = () => goals() ?? [];

  const createOffered = () => createLaunchGoalOffered(gate(), list());
  const actionsFor = (goal: ProtGoalView) =>
    launchGoalActions(goal, now(), gate(), tankRules().min_contribution);
  const withdrawableFor = (goal: ProtGoalView) =>
    withdrawablePledges(
      goal.your_pledges,
      feature().enabled,
      withdrawOpen(goal, now()),
    );

  // ---- create form --------------------------------------------------------

  const createNonce = createNonceKeeper(() => ulid());
  const [pickedSlots, setPickedSlots] = createSignal<number>();
  const [daysText, setDaysText] = createSignal("");

  /** Tiers the advert prices; only these can be picked */
  const tierOptions = createMemo(() =>
    PROT_SLOT_TIERS.flatMap((tier) => {
      const cost = tierDailyCost(tankRules(), tier);
      return cost === null ? [] : [{ slots: tier, cost }];
    }),
  );

  const typedDays = () => parseWholeNumber(daysText());
  const daysProblem = () => {
    if (daysText().trim() === "") return false;
    const value = typedDays();
    const rules = tankRules();
    return (
      value === null ||
      value < rules.min_launch_goal_days ||
      value > rules.max_launch_goal_days
    );
  };
  const previewTarget = () => {
    const tier = pickedSlots();
    const value = typedDays();
    if (tier === undefined || value === null) return null;
    return launchGoalPrice(tankRules(), tier, value);
  };

  /**
   * The only launch-goal create site. Store builds never reach it (D5):
   * the form is behind `createOffered()`, and this checks again.
   */
  async function createGoal() {
    if (!allowsProtSpending()) return;
    if (!createOffered() || busy()) return;
    const tier = pickedSlots();
    const value = typedDays();
    if (tier === undefined || value === null || previewTarget() === null) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      await postLaunchGoal(api, serverId(), {
        slots: tier,
        days: value,
        nonce: createNonce.nonceFor(`${tier}:${value}`),
      });
      if (unmounted) return;
      createNonce.clear();
      setPickedSlots(undefined);
      setDaysText("");
    } catch (failure) {
      if (!unmounted) setActionError(describe(failure));
    } finally {
      if (!unmounted) {
        setBusy(false);
        void refresh();
      }
    }
  }

  // ---- goal actions -------------------------------------------------------

  /**
   * The only `prot_contribute` open site in this dialog. Store builds never
   * reach it (D5, S6 pin): the button is behind `actionsFor(goal).pledge`,
   * and this checks `allowsProtSpending()` again.
   */
  function openPledge(goal: ProtGoalView) {
    if (!allowsProtSpending()) return;
    if (!actionsFor(goal).pledge) return;
    modals.openModal({
      type: "prot_contribute",
      target: { kind: "goal", goalId: goal.id, serverId: goal.server_id },
      onDone: () => void refresh(),
    });
  }

  async function withdraw(goal: ProtGoalView, pledge: ProtPledgeView) {
    if (busy()) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await deletePledge(api, goal.id, pledge.id);
      if (unmounted) return;
      setConfirming(undefined);
    } catch (failure) {
      if (!unmounted) setActionError(describe(failure));
    } finally {
      if (!unmounted) {
        setBusy(false);
        void refresh();
      }
    }
  }

  async function cancelGoal(goal: ProtGoalView) {
    if (busy() || !actionsFor(goal).cancel) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await postGoalCancel(api, goal.id);
      if (unmounted) return;
      setConfirming(undefined);
    } catch (failure) {
      if (!unmounted) setActionError(describe(failure));
    } finally {
      if (!unmounted) {
        setBusy(false);
        void refresh();
      }
    }
  }

  /** Empty text channels of this server, for the launch picker */
  const launchable = createMemo(() =>
    launchableChannels(
      props.server.channels.map((channel: Channel) => ({
        channel,
        id: channel.id,
        type: channel.type,
        serverId: channel.serverId,
        voice: channel.isVoice,
        announcement: channel.isAnnouncement === true,
        protected: client().isProtectedChannel(channel.id) === true,
        lastMessageId: channel.lastMessageId ?? null,
      })),
      serverId(),
    ),
  );

  /**
   * The only launch site. Store builds never reach it (D5): the picker is
   * behind `actionsFor(goal).launch`, and this checks again.
   */
  async function launchGoal(goal: ProtGoalView) {
    if (!allowsProtSpending()) return;
    const channelId = launchChannel();
    if (busy() || !channelId || !actionsFor(goal).launch) return;
    if (!launchable().some((entry) => entry.id === channelId)) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await postGoalLaunch(api, goal.id, { channel_id: channelId });
      if (unmounted) return;
      setConfirming(undefined);
      setLaunchChannel(undefined);
    } catch (failure) {
      if (!unmounted) setActionError(describe(failure));
    } finally {
      if (!unmounted) {
        setBusy(false);
        void refresh();
      }
    }
  }

  // ---- copy ---------------------------------------------------------------

  function describe(failure: unknown): string {
    if (failure instanceof CipherClientError) {
      return failure.kind === "rateLimited"
        ? t`Slow down — try again in a moment`
        : t`Something went wrong. Try again in a moment.`;
    }
    return err(failure);
  }

  function describeRead(failure: unknown): string {
    if (failure instanceof CipherClientError) {
      return failure.kind === "rateLimited"
        ? t`Slow down — try again in a moment`
        : t`This server's launch goals couldn't be loaded. Try again in a moment.`;
    }
    return err(failure);
  }

  // In the app locale, as on the Prot settings page
  function protAmount(value: number) {
    const amount = formatProt(value, i18n.locale);
    return t`${amount} Prot`;
  }

  function when(ms: number) {
    return formatLedgerTime(ms, i18n.locale);
  }

  function seatsLine(count: number) {
    const slots = count;
    return t`${slots} seats`;
  }

  function daysLine(count: number) {
    const days = count;
    return t`${days} days`;
  }

  function perDay(cost: number) {
    const amount = formatProt(cost, i18n.locale);
    return t`${amount} Prot a day`;
  }

  function goalProgress(goal: ProtGoalView): string {
    const pledged = formatProt(goal.pledged_total, i18n.locale);
    const target = formatProt(goal.target_prot, i18n.locale);
    return t`${pledged} of ${target} Prot`;
  }

  function channelName(id: string | undefined): string {
    const name = (id && client().channels.get(id)?.name) || "";
    return name;
  }

  function goalStatus(goal: ProtGoalView): string | undefined {
    switch (goal.state) {
      case "Funding": {
        const date = when(goal.deadline_at);
        return t`Ends ${date}`;
      }
      case "Funded": {
        if (goal.launch_deadline_at === undefined) return t`Funded`;
        const date = when(goal.launch_deadline_at);
        return t`Funded. Launch it by ${date}.`;
      }
      case "Launching": {
        const name = channelName(goal.channel_id);
        return name
          ? t`Launched on #${name}. Protect the channel from its settings to finish.`
          : t`Funded, waiting to launch`;
      }
      default:
        return undefined;
    }
  }

  function yourPledgeLine(amount: number) {
    const pledged = formatProt(amount, i18n.locale);
    return t`You pledged ${pledged} Prot`;
  }

  function withdrawUntil(goal: ProtGoalView) {
    const date = when(goal.withdraw_until);
    return t`You can withdraw until ${date}.`;
  }

  function withdrawQuestion(pledge: ProtPledgeView) {
    const amount = formatProt(pledge.remaining, i18n.locale);
    return t`Withdraw your pledge of ${amount} Prot? It goes back to your wallet.`;
  }

  function targetLine(target: number) {
    const amount = formatProt(target, i18n.locale);
    return t`Target: ${amount} Prot`;
  }

  function daysRange() {
    const min = tankRules().min_launch_goal_days;
    const max = tankRules().max_launch_goal_days;
    return t`Choose from ${min} to ${max} days.`;
  }

  function fundingWindow() {
    const days = tankRules().launch_goal_deadline_days;
    return t`Members have ${days} days to fund it.`;
  }

  function launchOn(id: string) {
    const name = channelName(id);
    return t`Launch on #${name}`;
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
          server: serverId(),
          user: label.userId,
        });
        return (
          member?.displayName ??
          c.users.get(label.userId)?.displayName ??
          label.userId
        );
      }
      default: {
        const exhaustive: never = label;
        return exhaustive;
      }
    }
  }

  // Names for contributor lines whose user isn't loaded yet
  const requested = new Set<string>();
  createEffect(() => {
    const c = client();
    for (const goal of list()) {
      for (const line of goal.contributors) {
        const label = contributorLabel(line);
        if (label.kind !== "user") continue;
        if (requested.has(label.userId) || c.users.get(label.userId)) continue;
        requested.add(label.userId);
        c.users.fetch(label.userId).catch(() => {
          // the line falls back to the id; nothing else depends on it
        });
      }
    }
  });

  const isConfirming = (match: Confirming) => {
    const current = confirming();
    if (!current || current.kind !== match.kind) return false;
    if (current.goalId !== match.goalId) return false;
    return (
      current.kind !== "withdraw" ||
      (match.kind === "withdraw" && current.pledgeId === match.pledgeId)
    );
  };

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
            running. With a launch goal, members pool Prot to fund a new
            Protected channel on this server.
          </Trans>
        </Description>

        {/* The owner's write controls: a note instead while they can't work */}
        <Show when={isOwner()}>
          <Switch>
            <Match when={!feature().enabled}>
              <Description>
                <Trans>
                  Prot is switched off right now, so launch goals can't be
                  opened or changed.
                </Trans>
              </Description>
            </Match>
            <Match when={!feature().self_serve_enabled}>
              <Description>
                <Trans>Launch goals aren't available yet.</Trans>
              </Description>
            </Match>
          </Switch>
        </Show>

        <Show when={createOffered() && goals() !== undefined}>
          <Card>
            <CardTitle>
              <Trans>Open a launch goal</Trans>
            </CardTitle>
            <Show
              when={tierOptions().length && tankRules().min_launch_goal_days}
              fallback={
                <Note>
                  <Trans>Launch goals can't be opened right now.</Trans>
                </Note>
              }
            >
              <Note>
                <Trans>Seats</Trans>
              </Note>
              <Choices>
                <For each={tierOptions()}>
                  {(option) => (
                    <Choice
                      type="button"
                      aria-pressed={pickedSlots() === option.slots}
                      data-active={pickedSlots() === option.slots}
                      disabled={busy()}
                      onClick={() => setPickedSlots(option.slots)}
                    >
                      <span>{seatsLine(option.slots)}</span>
                      <ChoiceNote>{perDay(option.cost)}</ChoiceNote>
                    </Choice>
                  )}
                </For>
              </Choices>
              <TextField
                value={daysText()}
                label={t`Days`}
                inputmode="numeric"
                autocomplete="off"
                maxlength={6}
                onInput={(event) => setDaysText(event.currentTarget.value)}
              />
              <Note>{daysRange()}</Note>
              <Show when={previewTarget()}>
                {(target) => <CardTitle>{targetLine(target())}</CardTitle>}
              </Show>
              <Show when={tankRules().launch_goal_deadline_days > 0}>
                <Note>{fundingWindow()}</Note>
              </Show>
              <Actions>
                <Button
                  isDisabled={
                    busy() || daysProblem() || previewTarget() === null
                  }
                  onPress={() => void createGoal()}
                >
                  <Trans>Open launch goal</Trans>
                </Button>
              </Actions>
            </Show>
          </Card>
        </Show>

        <Show when={ownerGoalWrites(gate()).spend && list().some(isOpenGoal)}>
          <Note>
            <Trans>
              This server already has an open launch goal. Only one can be open
              at a time.
            </Trans>
          </Note>
        </Show>

        <Show when={actionError()}>
          {(message) => <ErrorNotice role="alert">{message()}</ErrorNotice>}
        </Show>

        <Switch>
          <Match when={goals()}>
            {(current) => (
              <Show
                when={current().length}
                fallback={
                  <Description>
                    <Trans>No open launch goals.</Trans>
                  </Description>
                }
              >
                <For each={current()}>
                  {(goal) => (
                    <Card>
                      <Head>
                        <CardTitle>
                          <Trans>Launch goal</Trans>
                        </CardTitle>
                        <Note>
                          {seatsLine(goal.slots)}
                          <Show when={goal.days}>
                            {(count) => <> · {daysLine(count())}</>}
                          </Show>
                        </Note>
                      </Head>
                      <Track
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={goalPercent(goal)}
                        aria-valuetext={goalProgress(goal)}
                      >
                        <Fill style={{ width: `${goalPercent(goal)}%` }} />
                      </Track>
                      <Head>
                        <Note>{goalProgress(goal)}</Note>
                        <Show when={goalStatus(goal)}>
                          {(status) => <Note>{status()}</Note>}
                        </Show>
                      </Head>

                      <Show when={heldPledgeTotal(goal.your_pledges) > 0}>
                        <Note>
                          {yourPledgeLine(heldPledgeTotal(goal.your_pledges))}
                        </Note>
                      </Show>

                      <Show when={goal.contributors.length}>
                        <Rows>
                          <For each={goal.contributors}>
                            {(line) => (
                              <Line>
                                <LineName>{contributorName(line)}</LineName>
                                <Show when={line.you}>
                                  <Badge>
                                    <Trans>You</Trans>
                                  </Badge>
                                </Show>
                                <span>{protAmount(line.amount)}</span>
                              </Line>
                            )}
                          </For>
                        </Rows>
                      </Show>

                      {/* Pledge: behind allowsProtSpending() (actionsFor), with
                          the seat notice next to it, never hidden */}
                      <Show when={actionsFor(goal).pledge}>
                        <Actions>
                          <Note>
                            {t`Contributing supports this server. It does not reserve a seat; the owner chooses members.`}
                          </Note>
                          <Button
                            isDisabled={busy()}
                            onPress={() => openPledge(goal)}
                          >
                            <Trans>Pledge</Trans>
                          </Button>
                        </Actions>
                      </Show>

                      {/* Withdraw: returns Prot, so every build */}
                      <For each={withdrawableFor(goal)}>
                        {(pledge) => (
                          <Show
                            when={isConfirming({
                              kind: "withdraw",
                              goalId: goal.id,
                              pledgeId: pledge.id,
                            })}
                            fallback={
                              <Actions>
                                <Note>{withdrawUntil(goal)}</Note>
                                <Button
                                  variant="tonal"
                                  isDisabled={busy()}
                                  onPress={() =>
                                    setConfirming({
                                      kind: "withdraw",
                                      goalId: goal.id,
                                      pledgeId: pledge.id,
                                    })
                                  }
                                >
                                  <Trans>Withdraw pledge</Trans>
                                </Button>
                              </Actions>
                            }
                          >
                            <Confirm>
                              <span>{withdrawQuestion(pledge)}</span>
                              <Actions>
                                <Button
                                  variant="text"
                                  isDisabled={busy()}
                                  onPress={() => setConfirming(undefined)}
                                >
                                  <Trans>Keep pledge</Trans>
                                </Button>
                                <Button
                                  isDisabled={busy()}
                                  onPress={() => void withdraw(goal, pledge)}
                                >
                                  <Trans>Withdraw pledge</Trans>
                                </Button>
                              </Actions>
                            </Confirm>
                          </Show>
                        )}
                      </For>

                      {/* Launch: behind allowsProtSpending() (actionsFor) */}
                      <Show when={actionsFor(goal).launch}>
                        <Show
                          when={isConfirming({
                            kind: "launch",
                            goalId: goal.id,
                          })}
                          fallback={
                            <Actions>
                              <Button
                                isDisabled={busy()}
                                onPress={() => {
                                  setLaunchChannel(undefined);
                                  setConfirming({
                                    kind: "launch",
                                    goalId: goal.id,
                                  });
                                }}
                              >
                                <Trans>Launch</Trans>
                              </Button>
                            </Actions>
                          }
                        >
                          <Confirm>
                            <span>
                              <Trans>
                                Pick an empty text channel to launch on. It
                                becomes a Protected channel once you protect it
                                from its settings.
                              </Trans>
                            </span>
                            <Show
                              when={launchable().length}
                              fallback={
                                <Note>
                                  <Trans>
                                    There's no empty text channel to launch on.
                                    Create a new text channel first.
                                  </Trans>
                                </Note>
                              }
                            >
                              <Choices>
                                <For each={launchable()}>
                                  {(entry) => (
                                    <Choice
                                      type="button"
                                      aria-pressed={
                                        launchChannel() === entry.id
                                      }
                                      data-active={launchChannel() === entry.id}
                                      disabled={busy()}
                                      onClick={() => setLaunchChannel(entry.id)}
                                    >
                                      <span>#{entry.channel.name}</span>
                                    </Choice>
                                  )}
                                </For>
                              </Choices>
                            </Show>
                            <Actions>
                              <Button
                                variant="text"
                                isDisabled={busy()}
                                onPress={() => setConfirming(undefined)}
                              >
                                <Trans>Not now</Trans>
                              </Button>
                              <Button
                                isDisabled={busy() || !launchChannel()}
                                onPress={() => void launchGoal(goal)}
                              >
                                {launchChannel()
                                  ? launchOn(launchChannel()!)
                                  : t`Launch`}
                              </Button>
                            </Actions>
                          </Confirm>
                        </Show>
                      </Show>

                      {/* Cancel: returns every pledge, so every build */}
                      <Show when={actionsFor(goal).cancel}>
                        <Show
                          when={isConfirming({
                            kind: "cancel",
                            goalId: goal.id,
                          })}
                          fallback={
                            <Actions>
                              <Button
                                variant="text"
                                isDisabled={busy()}
                                onPress={() =>
                                  setConfirming({
                                    kind: "cancel",
                                    goalId: goal.id,
                                  })
                                }
                              >
                                <Trans>Cancel goal</Trans>
                              </Button>
                            </Actions>
                          }
                        >
                          <Confirm>
                            <span>
                              <Trans>
                                Cancel this goal? Every pledge goes back to the
                                member who made it.
                              </Trans>
                            </span>
                            <Actions>
                              <Button
                                variant="text"
                                isDisabled={busy()}
                                onPress={() => setConfirming(undefined)}
                              >
                                <Trans>Keep goal</Trans>
                              </Button>
                              <Button
                                variant="_error"
                                isDisabled={busy()}
                                onPress={() => void cancelGoal(goal)}
                              >
                                <Trans>Cancel goal</Trans>
                              </Button>
                            </Actions>
                          </Confirm>
                        </Show>
                      </Show>
                    </Card>
                  )}
                </For>
              </Show>
            )}
          </Match>
          <Match when={!readError()}>
            <Empty>
              <CircularProgress size={32} />
            </Empty>
          </Match>
        </Switch>

        <Show when={readError()}>
          <ErrorNotice role="alert">
            <span>{describeRead(readError())}</span>
            <Button
              size="sm"
              variant="tonal"
              isDisabled={loading()}
              onPress={() => void refresh()}
            >
              <Trans>Try again</Trans>
            </Button>
          </ErrorNotice>
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

const Card = styled("div", {
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

const CardTitle = styled("span", {
  base: {
    fontWeight: 600,
  },
});

const Head = styled("div", {
  base: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "var(--gap-md)",
  },
});

const Note = styled("span", {
  base: {
    fontSize: "0.8rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Choices = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const Choice = styled("button", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "2px",
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    fontFamily: "inherit",
    fontSize: "0.85rem",
    cursor: "pointer",
    "&[data-active=true]": {
      borderColor: "var(--md-sys-color-primary)",
      background: "var(--md-sys-color-secondary-container)",
      color: "var(--md-sys-color-on-secondary-container)",
    },
    "&:disabled": {
      cursor: "default",
      opacity: 0.6,
    },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

const ChoiceNote = styled("span", {
  base: {
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: "var(--gap-md)",
  },
});

const Confirm = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-highest)",
    fontSize: "0.85rem",
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
    maxHeight: "180px",
    overflowY: "auto",
  },
});

const Line = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-xs) 0",
    fontSize: "0.85rem",
  },
});

const LineName = styled("span", {
  base: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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

const ErrorNotice = styled("div", {
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

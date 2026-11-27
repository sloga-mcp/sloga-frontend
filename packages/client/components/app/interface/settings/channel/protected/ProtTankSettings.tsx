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
  type ProtTankSummary,
  type ProtTankView,
  PROT_SLOT_TIERS,
  contributorLabel,
  fetchProtTank,
  parseProtTankFeature,
  postGoalCancel,
  postUpgradeGoal,
  putTier,
  upgradeGoalPrice,
} from "@revolt/client/protTank";
import { settingsCopy } from "@revolt/client/protectedCopy";
import CONFIGURATION from "@revolt/common/lib/env";
import { useError } from "@revolt/i18n/errors";
import { Button } from "@revolt/ui/components/design/Button";
import { CircularProgress } from "@revolt/ui/components/design/LoadingProgress";
import { Column } from "@revolt/ui/components/layout/Column";

// prot-pure:begin
// The rules behind what this page offers. No imports: the spec
// (`./protTankSettings.scan.test.ts`) cuts this region out and runs it.
// Every gate here only decides what is offered; the server checks the
// owner, self-serve, the stage, the seats in use and the price again.

/** What decides the owner's write controls */
export type TankWriteGate = {
  /** The caller is the server owner (the server said so, and so do we) */
  isOwner: boolean;
  /** `features.prot.enabled`: every write needs it */
  enabled: boolean;
  /** `features.prot.self_serve_enabled`: goals and tiers need it (8.0) */
  selfServe: boolean;
  /** `allowsProtSpending()`: off in store builds (D5) */
  spending: boolean;
};

/**
 * The owner's writes: `manage` (move to fewer seats, cancel a goal; neither
 * spends Prot) needs Prot and self-serve on; `spend` (move to more seats,
 * open an upgrade goal) also needs a build that may spend Prot.
 */
export function ownerTankWrites(gate: TankWriteGate): {
  manage: boolean;
  spend: boolean;
} {
  const manage =
    gate.isOwner === true && gate.enabled === true && gate.selfServe === true;
  return { manage, spend: manage && gate.spending === true };
}

/** The tank's open upgrade goal (Funding or Funded), if any (8.7) */
export function openUpgradeGoal<G extends { kind: string; state: string }>(
  goals: readonly G[],
): G | undefined {
  return goals.find(
    (goal) =>
      goal.kind === "Upgrade" &&
      (goal.state === "Funding" || goal.state === "Funded"),
  );
}

/** Cancel is offered on an open goal (pledges go back) */
export function goalCancelOffered(
  goal: { state: string },
  writes: { manage: boolean },
): boolean {
  return (
    writes.manage === true &&
    (goal.state === "Funding" ||
      goal.state === "Funded" ||
      goal.state === "Launching")
  );
}

export type TierChoice = {
  slots: number;
  cost: number;
  direction: "up" | "down";
};

/** The tank fields the tier rules read */
export type TierTank = {
  slotTier: number;
  pendingSlotTier?: number;
  stage: string;
  dailyCost: number;
  balance: number;
};

function tierCost(costs: Readonly<Record<string, number>>, slots: number) {
  const cost = costs[String(slots)];
  return Number.isSafeInteger(cost) && cost > 0 ? cost : null;
}

/**
 * The tiers the owner may move to (8.9): more seats only from Active and
 * only with `spend`; fewer seats from Active, Grace or Frozen with
 * `manage`. Neither the current tier nor a pending one is offered again,
 * nor a tier the advert has no cost for. `locked`: an upgrade goal is
 * open, so the tier can't move under it (the choices show, disabled).
 */
export function tierChoices(
  tank: TierTank,
  costs: Readonly<Record<string, number>>,
  tiers: readonly number[],
  writes: { manage: boolean; spend: boolean },
  upgradeGoalOpen: boolean,
): { choices: TierChoice[]; locked: boolean } {
  const choices: TierChoice[] = [];
  if (!writes.manage) return { choices, locked: false };
  for (const slots of tiers) {
    const cost = tierCost(costs, slots);
    if (cost === null || slots === tank.slotTier) continue;
    if (slots === tank.pendingSlotTier) continue;
    if (slots > tank.slotTier) {
      if (writes.spend && tank.stage === "Active") {
        choices.push({ slots, cost, direction: "up" });
      }
    } else if (
      tank.stage === "Active" ||
      tank.stage === "Grace" ||
      tank.stage === "Frozen"
    ) {
      choices.push({ slots, cost, direction: "down" });
    }
  }
  return { choices, locked: upgradeGoalOpen === true };
}

/**
 * Upgrade goals the owner may open (8.7): `spend`, an Active tank with no
 * pending tier and no open upgrade goal, a bigger tier with a cost, and at
 * least one whole day of Prot left (`needsDay` otherwise). The target is
 * the server's formula (`price`, protTank's `upgradeGoalPrice`); a tier it
 * prices at 0 is not offered.
 */
export function upgradeGoalChoices(
  tank: TierTank,
  costs: Readonly<Record<string, number>>,
  tiers: readonly number[],
  writes: { spend: boolean },
  upgradeGoalOpen: boolean,
  price: (oldCost: number, newCost: number, balance: number) => number,
):
  | { kind: "none" }
  | { kind: "needsDay" }
  | { kind: "offer"; choices: { slots: number; target: number }[] } {
  if (
    !writes.spend ||
    upgradeGoalOpen ||
    tank.stage !== "Active" ||
    tank.pendingSlotTier !== undefined
  ) {
    return { kind: "none" };
  }
  if (
    !(Number.isSafeInteger(tank.dailyCost) && tank.dailyCost > 0) ||
    Math.floor(tank.balance / tank.dailyCost) < 1
  ) {
    return { kind: "needsDay" };
  }
  const choices: { slots: number; target: number }[] = [];
  for (const slots of tiers) {
    if (slots <= tank.slotTier) continue;
    const cost = tierCost(costs, slots);
    if (cost === null) continue;
    const target = price(tank.dailyCost, cost, tank.balance);
    if (Number.isSafeInteger(target) && target > 0) {
      choices.push({ slots, target });
    }
  }
  return choices.length ? { kind: "offer", choices } : { kind: "none" };
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

function tierTankOf(tank: ProtTankSummary): TierTank {
  return {
    slotTier: tank.slot_tier,
    pendingSlotTier: tank.pending_slot_tier,
    stage: tank.stage,
    dailyCost: tank.daily_cost,
    balance: tank.balance,
  };
}

/** What the last read of the tank said */
type TankRead =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "tank"; view: ProtTankView };

/** An inline confirm in progress */
type Confirming =
  | { kind: "tier"; choice: TierChoice }
  | { kind: "upgrade"; slots: number; target: number }
  | { kind: "cancel"; goalId: string };

/**
 * The owner's Protection funding page for a channel's Prot tank (S5b,
 * contracts 8.7, 8.9, 16.3).
 *
 * Every viewer of the page sees the tank's stage and dates, its balance and
 * daily cost, seats used out of the tier (with a pending move to fewer
 * seats), its open goals with progress and the contributors ("Anonymous"
 * for a hidden one, "Deleted user" for a deleted account), in every build
 * and while Prot is switched off (reads stay open, owner answer 3).
 *
 * The owner's controls show only while Prot and self-serve are both on
 * (owner answer 1: no tier changes or goals before self-serve); otherwise
 * a note says why, never a button that fails:
 * - seats: fewer seats in every build (it lowers the cost; the server holds
 *   it pending while more members are seated or cooling down); more seats
 *   only behind `allowsProtSpending()`, since it charges the tank today.
 *   All tier choices are disabled while an upgrade goal is open;
 * - open an upgrade goal: behind `allowsProtSpending()` (D5);
 * - cancel a goal: every build (pledges go back).
 *
 * The state is read from `GET /prot/channels/<id>/tank` on open, after
 * every change and on every `ProtTankUpdate` for the channel; the summary
 * goes through `client.setProtTank`, so the banner and the shield see the
 * same tank. The server prices every change; a target shown before opening
 * a goal is a preview from the root advert.
 */
export function ProtTankSettings(props: { channel: Channel }) {
  const { t } = useLingui();
  const client = useClient();
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
  const feature = createMemo(() => parseProtFeature(protAdvert()));
  const tankRules = createMemo(() => {
    const advert = protAdvert();
    return parseProtTankFeature(
      typeof advert === "object" && advert !== null
        ? (advert as { tank?: unknown }).tank
        : undefined,
    );
  });

  const [read, setRead] = createSignal<TankRead>({ kind: "loading" });
  const [readError, setReadError] = createSignal<unknown>();
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal<string>();
  const [confirming, setConfirming] = createSignal<Confirming>();

  // One read at a time; an event during a read asks for one more after it
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
      setReadError(undefined);
    } catch (failure) {
      // Data first: a failed read keeps the last one on screen
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

  // Goals, contributors and seats come only with a read
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

  /** The tank as the client store holds it (newest of reads and events) */
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

  /** Both the server and the local server record say this is the owner */
  const isOwner = () => {
    const self = client().user?.id;
    return (
      detail()?.is_owner === true &&
      !!self &&
      props.channel.server?.ownerId === self
    );
  };

  const writes = () =>
    ownerTankWrites({
      isOwner: isOwner(),
      enabled: feature().enabled,
      selfServe: feature().self_serve_enabled,
      spending: allowsProtSpending(),
    });

  const upgradeOpen = () => !!openUpgradeGoal(detail()?.goals ?? []);

  const tiers = createMemo((): ReturnType<typeof tierChoices> => {
    const tank = summary();
    if (!tank) return { choices: [], locked: false };
    return tierChoices(
      tierTankOf(tank),
      tankRules().channel_daily_cost,
      PROT_SLOT_TIERS,
      writes(),
      upgradeOpen(),
    );
  });

  const upgradeGoals = createMemo((): ReturnType<typeof upgradeGoalChoices> => {
    const tank = summary();
    if (!tank || !detail()) return { kind: "none" };
    return upgradeGoalChoices(
      tierTankOf(tank),
      tankRules().channel_daily_cost,
      PROT_SLOT_TIERS,
      writes(),
      upgradeOpen(),
      upgradeGoalPrice,
    );
  });

  // ---- writes -------------------------------------------------------------

  const tierNonce = createNonceKeeper(() => ulid());
  const goalNonce = createNonceKeeper(() => ulid());

  /**
   * The only tier change site. A move to more seats charges the tank, so
   * store builds never reach it (D5): those choices are only offered with
   * `spend`, and this checks `allowsProtSpending()` again.
   */
  async function changeTier(choice: TierChoice) {
    if (choice.direction === "up" && !allowsProtSpending()) return;
    if (busy() || tiers().locked) return;
    if (!tiers().choices.some((entry) => entry.slots === choice.slots)) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const tank = await putTier(api, channelId(), {
        slots: choice.slots,
        nonce: tierNonce.nonceFor(`${choice.slots}`),
      });
      if (unmounted) return;
      tierNonce.clear();
      client().setProtTank(channelId(), tank);
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

  /**
   * The only upgrade-goal create site. Store builds never reach it (D5):
   * the choices are only offered with `spend`, and this checks again.
   */
  async function createUpgradeGoal(slots: number) {
    if (!allowsProtSpending()) return;
    const offer = upgradeGoals();
    if (busy() || offer.kind !== "offer") return;
    if (!offer.choices.some((entry) => entry.slots === slots)) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await postUpgradeGoal(api, channelId(), {
        slots,
        nonce: goalNonce.nonceFor(`${slots}`),
      });
      if (unmounted) return;
      goalNonce.clear();
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
    if (busy() || !goalCancelOffered(goal, writes())) return;
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
        : t`This channel's funding couldn't be loaded. Try again in a moment.`;
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

  function perDay(cost: number) {
    const amount = formatProt(cost, i18n.locale);
    return t`${amount} Prot a day`;
  }

  function dailyCostLine(cost: number) {
    const amount = formatProt(cost, i18n.locale);
    return t`Uses ${amount} Prot a day`;
  }

  function pendingTierLine(tier: number) {
    return t`Moving to ${tier} seats once enough seats are free.`;
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
      case "Grace": {
        if (tank.grace_ends_at === undefined) return undefined;
        const date = when(tank.grace_ends_at);
        return t`This Protected channel has run out of Prot. It keeps working until ${date}, but new members can't be added. Top it up to keep it active.`;
      }
      case "Frozen":
        return t`This Protected channel is frozen. You can read its history, but nothing can be sent until it's topped up.`;
      default:
        return undefined;
    }
  }

  /** Only when the server promises a date (deletion enabled, NIT 32) */
  function deletionText(tank: ProtTankSummary): string | undefined {
    if (tank.deletes_at === undefined) return undefined;
    if (tank.stage !== "Grace" && tank.stage !== "Frozen") return undefined;
    const date = when(tank.deletes_at);
    return t`It may be deleted from Sloga's servers after ${date}.`;
  }

  function tierQuestion(choice: TierChoice): string {
    const slots = choice.slots;
    const amount = formatProt(choice.cost, i18n.locale);
    return choice.direction === "up"
      ? t`Move to ${slots} seats? The tank pays the extra cost for the rest of today now, then ${amount} Prot a day.`
      : t`Move to ${slots} seats? The tank pays ${amount} Prot a day from the next day. If more members are seated or cooling down than that, the change waits until enough seats are free.`;
  }

  function targetLine(target: number) {
    const amount = formatProt(target, i18n.locale);
    return t`Target: ${amount} Prot`;
  }

  function upgradeQuestion(slots: number, target: number): string {
    const amount = formatProt(target, i18n.locale);
    return t`Open a goal for ${slots} seats with a target of ${amount} Prot?`;
  }

  function fundingWindow() {
    const days = tankRules().launch_goal_deadline_days;
    return t`Members have ${days} days to fund it.`;
  }

  function goalTitle(goal: ProtGoalView): string {
    return goal.kind === "Upgrade" ? t`Upgrade goal` : t`Launch goal`;
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

  const confirmingTier = (choice: TierChoice) => {
    const current = confirming();
    return current?.kind === "tier" && current.choice.slots === choice.slots;
  };

  const confirmingCancel = (goal: ProtGoalView) => {
    const current = confirming();
    return current?.kind === "cancel" && current.goalId === goal.id;
  };

  return (
    <Column gap="lg">
      <Description>
        <Trans>
          Prot is the credit that keeps Protected servers and channels running.
          Members fund this channel's tank, and the tank pays for its seats each
          day.
        </Trans>
      </Description>

      <Switch>
        <Match when={summary()}>
          {(tank) => (
            <Column gap="lg">
              <Card role="status">
                <CardTitle>{stageTitle(tank())}</CardTitle>
                <Show when={stageText(tank())}>
                  {(text) => <Note>{text()}</Note>}
                </Show>
                <Show when={deletionText(tank())}>
                  {(text) => <Note>{text()}</Note>}
                </Show>
              </Card>

              <Figures>
                <Card>
                  <Note>
                    <Trans>Tank balance</Trans>
                  </Note>
                  <CardTitle>{protAmount(tank().balance)}</CardTitle>
                  <Show when={tank().daily_cost > 0}>
                    <Note>{dailyCostLine(tank().daily_cost)}</Note>
                  </Show>
                </Card>
                <Card>
                  <Note>
                    <Trans>Seats</Trans>
                  </Note>
                  <CardTitle>
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
                  </CardTitle>
                  <Show when={tank().pending_slot_tier}>
                    {(tier) => <Note>{pendingTierLine(tier())}</Note>}
                  </Show>
                </Card>
              </Figures>

              {/* Why the owner has no controls: a note, never a dead button */}
              <Show when={detail()}>
                <Switch>
                  <Match when={!isOwner()}>
                    <Note>
                      <Trans>
                        Only the server owner can change the seats or open
                        goals.
                      </Trans>
                    </Note>
                  </Match>
                  <Match when={!feature().enabled}>
                    <Note>
                      <Trans>
                        Prot is switched off right now, so the seats and goals
                        can't be changed.
                      </Trans>
                    </Note>
                  </Match>
                  <Match when={!feature().self_serve_enabled}>
                    <Note>
                      <Trans>
                        Changing the seats and opening goals isn't available
                        yet.
                      </Trans>
                    </Note>
                  </Match>
                </Switch>
              </Show>

              <Show when={actionError()}>
                {(message) => (
                  <ErrorNotice role="alert">{message()}</ErrorNotice>
                )}
              </Show>

              {/* Seat tier: fewer seats with `manage`, more with `spend` */}
              <Show when={tiers().choices.length}>
                <Section>
                  <SectionTitle>
                    <Trans>Seat tier</Trans>
                  </SectionTitle>
                  <Note>
                    <Trans>Choose how many seats the tank pays for.</Trans>
                  </Note>
                  <Choices>
                    <For each={tiers().choices}>
                      {(choice) => (
                        <Choice
                          type="button"
                          aria-pressed={confirmingTier(choice)}
                          data-active={confirmingTier(choice)}
                          disabled={busy() || tiers().locked}
                          onClick={() =>
                            setConfirming({ kind: "tier", choice })
                          }
                        >
                          <span>{seatsLine(choice.slots)}</span>
                          <ChoiceNote>{perDay(choice.cost)}</ChoiceNote>
                        </Choice>
                      )}
                    </For>
                  </Choices>
                  <Show when={tiers().locked}>
                    <Note>
                      <Trans>
                        The seats can't change while an upgrade goal is open.
                      </Trans>
                    </Note>
                  </Show>
                  <Show
                    when={(() => {
                      const current = confirming();
                      return current?.kind === "tier" && !tiers().locked
                        ? current.choice
                        : undefined;
                    })()}
                  >
                    {(choice) => (
                      <Confirm>
                        <span>{tierQuestion(choice())}</span>
                        <Actions>
                          <Button
                            variant="text"
                            isDisabled={busy()}
                            onPress={() => setConfirming(undefined)}
                          >
                            <Trans>Not now</Trans>
                          </Button>
                          <Button
                            isDisabled={busy()}
                            onPress={() => void changeTier(choice())}
                          >
                            <Trans>Change seats</Trans>
                          </Button>
                        </Actions>
                      </Confirm>
                    )}
                  </Show>
                </Section>
              </Show>

              {/* Upgrade goal: only with `spend` (allowsProtSpending()) */}
              <Switch>
                <Match when={upgradeGoals().kind === "needsDay"}>
                  <Note>
                    <Trans>
                      An upgrade goal needs at least one full day of Prot in the
                      tank.
                    </Trans>
                  </Note>
                </Match>
                <Match
                  when={(() => {
                    const offer = upgradeGoals();
                    return offer.kind === "offer" ? offer.choices : undefined;
                  })()}
                >
                  {(choices) => (
                    <Section>
                      <SectionTitle>
                        <Trans>Upgrade goal</Trans>
                      </SectionTitle>
                      <Note>
                        <Trans>
                          Ask members to fund more seats. The target covers the
                          extra cost for the days of Prot the tank has left.
                        </Trans>
                      </Note>
                      <Choices>
                        <For each={choices()}>
                          {(choice) => (
                            <Choice
                              type="button"
                              aria-pressed={(() => {
                                const current = confirming();
                                return (
                                  current?.kind === "upgrade" &&
                                  current.slots === choice.slots
                                );
                              })()}
                              data-active={(() => {
                                const current = confirming();
                                return (
                                  current?.kind === "upgrade" &&
                                  current.slots === choice.slots
                                );
                              })()}
                              disabled={busy()}
                              onClick={() =>
                                setConfirming({
                                  kind: "upgrade",
                                  slots: choice.slots,
                                  target: choice.target,
                                })
                              }
                            >
                              <span>{seatsLine(choice.slots)}</span>
                              <ChoiceNote>
                                {targetLine(choice.target)}
                              </ChoiceNote>
                            </Choice>
                          )}
                        </For>
                      </Choices>
                      <Show
                        when={(() => {
                          const current = confirming();
                          return current?.kind === "upgrade"
                            ? current
                            : undefined;
                        })()}
                      >
                        {(pick) => (
                          <Confirm>
                            <span>
                              {upgradeQuestion(pick().slots, pick().target)}
                            </span>
                            <Show
                              when={tankRules().launch_goal_deadline_days > 0}
                            >
                              <span>{fundingWindow()}</span>
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
                                isDisabled={busy()}
                                onPress={() =>
                                  void createUpgradeGoal(pick().slots)
                                }
                              >
                                <Trans>Open upgrade goal</Trans>
                              </Button>
                            </Actions>
                          </Confirm>
                        )}
                      </Show>
                    </Section>
                  )}
                </Match>
              </Switch>

              <Show when={detail()?.goals.length}>
                <Section>
                  <SectionTitle>
                    <Trans>Goals</Trans>
                  </SectionTitle>
                  <For each={detail()?.goals}>
                    {(goal) => (
                      <Card>
                        <Head>
                          <CardTitle>{goalTitle(goal)}</CardTitle>
                          <Note>{seatsLine(goal.slots)}</Note>
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

                        {/* Cancel: returns every pledge, so every build */}
                        <Show when={goalCancelOffered(goal, writes())}>
                          <Show
                            when={confirmingCancel(goal)}
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
                                  Cancel this goal? Every pledge goes back to
                                  the member who made it.
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
                        <Note>
                          <Trans>No contributions yet.</Trans>
                        </Note>
                      }
                    >
                      <Rows>
                        <For each={last().contributors}>
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
                  </Section>
                )}
              </Show>
            </Column>
          )}
        </Match>
        <Match when={noTank()}>
          <Column>
            <Description>
              <Trans>This channel doesn't have a Prot tank.</Trans>
            </Description>
            <Note>
              <Trans>
                To fund a new Protected channel, open a launch goal from the
                server menu.
              </Trans>
            </Note>
          </Column>
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
  );
}

const Description = styled("p", {
  base: {
    margin: 0,
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Figures = styled("div", {
  base: {
    display: "grid",
    gap: "var(--gap-md)",
    gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
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
    maxHeight: "260px",
    overflowY: "auto",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Line = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-sm) var(--gap-lg)",
    fontSize: "0.85rem",
    "&:not(:last-child)": {
      borderBottom: "1px solid var(--md-sys-color-outline-variant)",
    },
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

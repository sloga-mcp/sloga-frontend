import {
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
import { ulid } from "ulid";

import {
  type CipherApi,
  CipherClientError,
} from "@revolt/app/interface/settings/user/cipherCheckout";
import {
  type ProtMe,
  fetchProtMe,
  formatProt,
  parseExactInput,
  parseProtFeature,
} from "@revolt/app/interface/settings/user/protWallet";
import { useClient } from "@revolt/client";
import { allowsProtSpending } from "@revolt/client/distribution";
import {
  type ProtGoalView,
  type ProtTankView,
  PROT_MAX_AMOUNT,
  PROT_SEAT_NOTICE_EN,
  contributionAmountProblem,
  fetchGoal,
  fetchProtTank,
  parseProtTankFeature,
  postContribute,
  postPledge,
  putContributorPrefs,
} from "@revolt/client/protTank";
import CONFIGURATION from "@revolt/common/lib/env";
import { useError } from "@revolt/i18n/errors";
import { Button } from "@revolt/ui/components/design/Button";
import { Checkbox } from "@revolt/ui/components/design/Checkbox";
import { type DialogProps, Dialog } from "@revolt/ui/components/design/Dialog";
import { CircularProgress } from "@revolt/ui/components/design/LoadingProgress";
import { useSnackbar } from "@revolt/ui/components/design/Snackbar";
import { Text } from "@revolt/ui/components/design/Text";
import { TextField } from "@revolt/ui/components/design/TextField";
import { Column } from "@revolt/ui/components/layout/Column";
import { Row } from "@revolt/ui/components/layout/Row";

import { Modals } from "../types";

/**
 * Headers for a JSON request as the session user (as on the Prot settings
 * page): the `/prot` routes are newer than the generated stoat-api schema,
 * and the typed client drops request bodies for routes it doesn't know.
 */
function jsonHeaders(client: Client): Record<string, string> {
  const [header, token] = client.authenticationHeader;
  return { [header]: token, "Content-Type": "application/json" };
}

/** What the dialog has read about its target */
type Loaded =
  | { kind: "tank"; view: ProtTankView }
  | { kind: "goal"; goal: ProtGoalView }
  | { kind: "missing" };

/**
 * Put Prot into a channel's tank (a top-up) or pledge it to a goal (S5b,
 * contracts 16.3 L6d).
 *
 * The seat notice is always shown, directly above the buttons, whatever
 * state the dialog is in: contributing supports the server and never
 * reserves a seat. The server's own copy (`notice` in every tank, goal and
 * contribution answer) wins when it differs from the pinned English text.
 *
 * Everything that spends Prot (the amount, the wallet figures, the confirm
 * button and the request) exists only where `allowsProtSpending()` is true
 * (D5: store builds have no in-app purchase yet). The submit path checks it
 * again, so an opener that forgets the gate still spends nothing.
 *
 * The server decides everything: eligibility, the minimum (a pledge that
 * completes its goal may be smaller), the purchase hold (D17), the tank's
 * stage and the goal's state. The checks here only decide what is offered.
 * Every attempt carries the same client nonce until one succeeds, so a
 * retry after a lost answer is answered with the stored result instead of
 * a second posting. An idempotency conflict (the lost attempt landed, then
 * the amount changed) also ends the nonce: the dialog says the earlier
 * attempt was added and stays open with a fresh one.
 *
 * Hide-name is one setting per server (`PUT /prot/servers/<id>/contributor`)
 * and is saved as soon as it is toggled; the confirm button waits for it.
 */
export function ProtContributeModal(
  props: DialogProps & Modals & { type: "prot_contribute" },
) {
  const { t } = useLingui();
  const client = useClient();
  const err = useError();
  const snackbar = useSnackbar();

  // The pinned props are fixed for the modal's life
  // eslint-disable-next-line solid/reactivity
  const target = props.target;
  const channelId = target.kind === "tank" ? target.channel.id : undefined;
  const serverId =
    (target.kind === "tank" ? target.channel.serverId : target.serverId) ||
    undefined;

  // The upstream stoat-api config type has no `prot`
  const rawProt = () =>
    (client().configuration?.features as { prot?: unknown } | undefined)?.prot;
  const enabled = createMemo(() => parseProtFeature(rawProt()).enabled);
  const tankFeature = createMemo(() =>
    parseProtTankFeature(
      (rawProt() as { tank?: unknown } | null | undefined)?.tank,
    ),
  );

  const api: CipherApi = {
    fetch: (url, init) => fetch(url, init),
    apiBase: CONFIGURATION.DEFAULT_API_URL,
    headers: () => jsonHeaders(client()),
  };

  // Set once the dialog is gone: late answers change nothing on screen
  let unmounted = false;
  onCleanup(() => {
    unmounted = true;
  });

  const [loaded, setLoaded] = createSignal<Loaded>();
  const [loadError, setLoadError] = createSignal<unknown>();
  let loadSeq = 0;

  async function loadTarget() {
    const seq = ++loadSeq;
    try {
      let next: Loaded;
      if (target.kind === "tank") {
        const view = await fetchProtTank(api, target.channel.id);
        // A REST read obeys the store's version rule (L6a)
        client().setProtTank(target.channel.id, view?.tank);
        next = view ? { kind: "tank", view } : { kind: "missing" };
      } else {
        try {
          next = { kind: "goal", goal: await fetchGoal(api, target.goalId) };
        } catch (error) {
          if ((error as { type?: unknown } | undefined)?.type !== "NotFound") {
            throw error;
          }
          next = { kind: "missing" };
        }
      }
      if (unmounted || seq !== loadSeq) return;
      setLoaded(next);
      setLoadError(undefined);
    } catch (error) {
      if (unmounted || seq !== loadSeq) return;
      // A failed refresh keeps what was read before
      setLoadError(error);
    }
  }

  const [wallet, setWallet] = createSignal<ProtMe>();
  const [walletError, setWalletError] = createSignal<unknown>();
  let walletSeq = 0;

  async function loadWallet() {
    if (!allowsProtSpending()) return;
    const seq = ++walletSeq;
    try {
      const me = await fetchProtMe(api);
      if (unmounted || seq !== walletSeq) return;
      setWallet(me);
      setWalletError(undefined);
    } catch (error) {
      if (unmounted || seq !== walletSeq) return;
      setWalletError(error);
    }
  }

  onMount(() => {
    void loadTarget();
    void loadWallet();
  });

  // The wallet moves on every posting (another tab, a purchase landing),
  // and the tank on every stage or balance change
  createEffect(
    on(client, (current) => {
      const onBalance = () => void loadWallet();
      const onTank = (id: string) => {
        if (id === channelId) void loadTarget();
      };
      current.on("protBalanceUpdate", onBalance);
      current.on("protTankUpdate", onTank);
      onCleanup(() => {
        current.off("protBalanceUpdate", onBalance);
        current.off("protTankUpdate", onTank);
      });
    }),
  );

  const targetState = (): ContributeTargetState => {
    const state = loaded();
    if (!state) return { kind: "loading" };
    if (state.kind === "missing") return { kind: "missing" };
    if (state.kind === "tank") {
      return {
        kind: "tank",
        stage: state.view.tank.stage,
        canContribute: state.view.can_contribute,
      };
    }
    return {
      kind: "goal",
      state: state.goal.state,
      deadlineAt: state.goal.deadline_at,
      open: goalOpen(state.goal),
    };
  };

  const block = () =>
    contributeBlock({
      spendingAllowed: allowsProtSpending(),
      enabled: enabled(),
      minContribution: tankFeature().min_contribution,
      target: targetState(),
      nowMs: Date.now(),
    });

  /** What a goal still needs, or undefined for a tank */
  const open = () => {
    const state = loaded();
    return state?.kind === "goal" ? goalOpen(state.goal) : undefined;
  };

  const [amountText, setAmountText] = createSignal("");
  const amount = () => parseExactInput(amountText());
  const entered = () => amountText().trim() !== "";
  const problem = () =>
    entered()
      ? contributionAmountProblem(
          amount(),
          tankFeature().min_contribution,
          open(),
        )
      : undefined;
  /** What the server will take: a pledge is capped at what the goal needs */
  const effective = () => {
    const need = open();
    return need !== undefined ? Math.min(amount(), need) : amount();
  };
  /** The two problems with their own line; a low amount shows the minimum */
  const shownProblem = () => {
    const kind = problem();
    return kind === "notInteger" || kind === "aboveMax" ? kind : undefined;
  };
  /** A goal needing less than the minimum takes any amount that completes it */
  const minimumApplies = () => {
    const need = open();
    return need === undefined || need >= tankFeature().min_contribution;
  };
  /** What a pledge over the goal's need is capped to, if it is */
  const capped = () => {
    const need = open();
    if (need === undefined || !entered() || problem() !== undefined) return;
    return amount() > need ? need : undefined;
  };

  const [hidden, setHidden] = createSignal<boolean | null>(null);
  const [prefTouched, setPrefTouched] = createSignal(false);
  const [prefSaving, setPrefSaving] = createSignal(false);

  // The caller's own line (marked `you`, also when hidden) tells the
  // current setting; without one it is not known, and the box starts clear
  createEffect(() => {
    const state = loaded();
    if (prefTouched() || !state || state.kind === "missing") return;
    const groups =
      state.kind === "tank"
        ? [
            state.view.contributors,
            ...state.view.goals.map((goal) => goal.contributors),
          ]
        : [state.goal.contributors];
    setHidden(ownHiddenPref(groups));
  });

  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // A neutral status line (an earlier attempt turned out to have landed)
  const [note, setNote] = createSignal<string | null>(null);
  // The nonce every attempt of this dialog carries until one succeeds (see
  // nextNonce); dropped only by a success answer
  let unsettled: NonceSlot | undefined;

  const canSubmit = () =>
    block() === null &&
    entered() &&
    problem() === undefined &&
    !submitting() &&
    !prefSaving();

  // In the app locale, as on the Prot settings page
  function protAmount(value: number) {
    const amount = formatProt(value, i18n.locale);
    return t`${amount} Prot`;
  }

  function heldLine(value: number) {
    const held = formatProt(value, i18n.locale);
    return t`${held} Prot on hold`;
  }

  function minimumLine() {
    const min = formatProt(tankFeature().min_contribution, i18n.locale);
    return t`The minimum is ${min} Prot.`;
  }

  function problemText(kind: "notInteger" | "aboveMax") {
    if (kind === "notInteger") return t`Enter a whole number of Prot.`;
    const max = formatProt(PROT_MAX_AMOUNT, i18n.locale);
    return t`The maximum is ${max} Prot.`;
  }

  function needLine(value: number) {
    const open = formatProt(value, i18n.locale);
    return t`This goal needs ${open} more Prot.`;
  }

  function cappedLine(value: number) {
    const open = formatProt(value, i18n.locale);
    return t`The goal needs only ${open} Prot, so that's what will be pledged.`;
  }

  /** D17: the hold length comes from the advert, never a fixed number */
  function holdLine(): string | undefined {
    const value = tankFeature().contribute_hold_hours;
    if (value <= 0) return undefined;
    const hours = formatProt(value, i18n.locale);
    return t`Prot bought in the last ${hours} hours can't be contributed yet.`;
  }

  function shortLine(needed: number, available: number) {
    const protNeeded = formatProt(needed, i18n.locale);
    const protAvailable = formatProt(available, i18n.locale);
    return t`You don't have enough Prot for this: it needs ${protNeeded} Prot and you have ${protAvailable}.`;
  }

  /** A preview from the last wallet read; the server decides */
  const walletLine = () => {
    const me = wallet();
    if (!me || !entered() || problem() !== undefined) return undefined;
    const hint = walletHint(effective(), me);
    if (hint === "short") return shortLine(effective(), me.balance);
    if (hint === "held") return holdLine();
    return undefined;
  };

  function seatNotice(): string {
    const state = loaded();
    const server =
      state?.kind === "tank"
        ? state.view.notice
        : state?.kind === "goal"
          ? state.goal.notice
          : PROT_SEAT_NOTICE_EN;
    // The server's copy is the binding one: if it ever differs from the
    // pinned text, show it as sent rather than a stale translation
    if (server !== PROT_SEAT_NOTICE_EN) return server;
    return t`Contributing supports this server. It does not reserve a seat; the owner chooses members.`;
  }

  function blockText(kind: ContributeBlock): string {
    switch (kind) {
      case "store":
        return t`Contributing isn't available in this version of Sloga.`;
      case "disabled":
        return t`Prot isn't available right now.`;
      case "closed":
        return target.kind === "goal"
          ? t`This goal is closed.`
          : t`This channel isn't taking contributions right now.`;
      case "notEligible":
        return t`You can't do this with Prot right now. If a payment on your account is disputed, try again once the dispute is resolved.`;
      case "loading":
      case null:
        return "";
      default: {
        const exhaustive: never = kind;
        return exhaustive;
      }
    }
  }

  function describeRead(error: unknown): string {
    if (error instanceof CipherClientError && error.kind === "rateLimited") {
      return t`Slow down — try again in a moment`;
    }
    if ((error as { type?: unknown } | undefined)?.type !== undefined) {
      return err(error);
    }
    return t`This couldn't be loaded. Try again in a moment.`;
  }

  function describeWallet(error: unknown): string {
    if (error instanceof CipherClientError && error.kind === "rateLimited") {
      return t`Slow down — try again in a moment`;
    }
    return t`Your Prot wallet couldn't be loaded. Try again in a moment.`;
  }

  /** A refusal or failure of the contribution or pledge itself */
  function describeSubmit(error: unknown): string {
    if (outcomeUnknown(error)) {
      return t`We couldn't confirm that this went through. Try again; it won't be counted twice.`;
    }
    if (error instanceof CipherClientError) {
      return t`Slow down — try again in a moment`;
    }
    if ((error as { type?: unknown }).type === "ProtHeldPurchase") {
      return holdLine() ?? err(error);
    }
    return err(error);
  }

  async function toggleHidden(next: boolean) {
    if (!serverId || prefSaving()) return;
    const before = hidden();
    setPrefTouched(true);
    setHidden(next);
    setPrefSaving(true);
    setError(null);
    try {
      await putContributorPrefs(api, serverId, { hidden: next });
    } catch (error) {
      if (unmounted) return;
      setHidden(before);
      setError(
        error instanceof CipherClientError
          ? t`Slow down — try again in a moment`
          : (error as { type?: unknown } | undefined)?.type !== undefined
            ? err(error)
            : t`Your name setting couldn't be saved. Try again in a moment.`,
      );
    } finally {
      if (!unmounted) setPrefSaving(false);
    }
  }

  function finish(message: string) {
    snackbar.show({ message });
    props.onDone?.();
    if (!unmounted) props.onClose();
  }

  async function submit() {
    // D5: nothing is spent in a store build, whatever opened this dialog
    if (!allowsProtSpending()) return;
    if (!canSubmit()) return;

    const value = amount();
    const slot = nextNonce(unsettled, value, () => ulid());
    unsettled = slot;
    setSubmitting(true);
    setError(null);
    setNote(null);

    try {
      if (target.kind === "tank") {
        const response = await postContribute(api, target.channel.id, {
          amount: value,
          nonce: slot.nonce,
        });
        unsettled = undefined;
        client().setProtTank(target.channel.id, response.tank);
        const amount = formatProt(value, i18n.locale);
        finish(
          response.already_applied
            ? t`This was already added earlier, so nothing more was taken from your wallet.`
            : t`Your contribution of ${amount} Prot was added.`,
        );
      } else {
        const response = await postPledge(api, target.goalId, {
          amount: value,
          nonce: slot.nonce,
        });
        unsettled = undefined;
        const amount = formatProt(response.pledge.amount, i18n.locale);
        finish(
          response.already_applied
            ? t`This was already added earlier, so nothing more was taken from your wallet.`
            : t`Your pledge of ${amount} Prot was added.`,
        );
      }
    } catch (error) {
      // The nonce stays: an earlier attempt with it may have landed, and a
      // refusal of this one does not say otherwise (see nextNonce). Only an
      // idempotency conflict says it did: the server holds an earlier
      // posting under this nonce with other details, so it is done with.
      const landed = landedEarlier(error);
      if (landed) unsettled = undefined;
      if (unmounted) return;
      if (landed) {
        // The earlier amount went in, not this one: say so, keep the dialog
        // open, and let the opener refresh what it shows
        setNote(
          t`This was already added earlier, so nothing more was taken from your wallet.`,
        );
        props.onDone?.();
      } else {
        setError(describeSubmit(error));
      }
      void loadWallet();
      void loadTarget();
    } finally {
      if (!unmounted) setSubmitting(false);
    }
  }

  /** Closing waits for a contribution in flight to settle */
  function close() {
    if (!submitting()) props.onClose();
  }

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={close}
      title={
        target.kind === "tank" ? <Trans>Top up</Trans> : <Trans>Pledge</Trans>
      }
      actions={[
        { text: <Trans>Cancel</Trans> },
        ...(allowsProtSpending()
          ? [
              {
                text:
                  target.kind === "tank" ? (
                    <Trans>Contribute</Trans>
                  ) : (
                    <Trans>Pledge</Trans>
                  ),
                onClick: () => {
                  void submit();
                  return false;
                },
                isDisabled: !canSubmit(),
              },
            ]
          : []),
      ]}
      isDisabled={submitting()}
    >
      <Column gap="lg">
        <Show when={target.kind === "tank" && target.channel.name}>
          {(name) => <Text class="title">{name()}</Text>}
        </Show>
        <Show when={target.kind === "goal"}>
          <Column gap="sm">
            <Text class="title">
              <Trans>Goal</Trans>
            </Text>
            <Show when={block() === null && open()}>
              {(need) => <Text class="label">{needLine(need())}</Text>}
            </Show>
          </Column>
        </Show>

        <Switch>
          <Match when={block() === "store"}>
            <Text class="label">{blockText("store")}</Text>
          </Match>
          <Match when={!loaded() && loadError()}>
            <Column>
              <Text class="label">{describeRead(loadError())}</Text>
              <Row>
                <Button size="sm" onPress={() => void loadTarget()}>
                  <Trans>Try again</Trans>
                </Button>
              </Row>
            </Column>
          </Match>
          <Match when={block() === "loading"}>
            <CircularProgress />
          </Match>
          <Match when={block() !== null}>
            <Text class="label">{blockText(block())}</Text>
          </Match>
          <Match when={block() === null}>
            <Column gap="md">
              <Switch>
                <Match when={wallet()}>
                  {(me) => (
                    <Column gap="sm">
                      <Text class="label">
                        <Trans>Your balance</Trans>
                      </Text>
                      <Text class="body">{protAmount(me().balance)}</Text>
                      <Show when={me().held > 0}>
                        <Text class="label">{heldLine(me().held)}</Text>
                      </Show>
                    </Column>
                  )}
                </Match>
                <Match when={walletError()}>
                  <Text class="label">{describeWallet(walletError())}</Text>
                </Match>
              </Switch>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <TextField
                  value={amountText()}
                  label={t`Amount of Prot`}
                  inputmode="numeric"
                  autocomplete="off"
                  maxlength={15}
                  disabled={submitting()}
                  onInput={(event) => {
                    setAmountText(event.currentTarget.value);
                    setError(null);
                    setNote(null);
                  }}
                />
              </form>

              <Switch>
                <Match when={shownProblem()}>
                  {(kind) => <Text class="label">{problemText(kind())}</Text>}
                </Match>
                <Match when={minimumApplies()}>
                  <Text class="label">{minimumLine()}</Text>
                </Match>
              </Switch>
              <Show when={capped()}>
                {(need) => <Text class="label">{cappedLine(need())}</Text>}
              </Show>
              <Show when={walletLine()}>
                {(line) => <Text class="label">{line()}</Text>}
              </Show>
            </Column>
          </Match>
        </Switch>

        {/* Not spending: shown in every build, while Prot is on (the save
            needs it on) */}
        <Show when={serverId && enabled()}>
          <Column gap="sm">
            <Checkbox
              checked={hidden() === true}
              disabled={prefSaving() || submitting()}
              onChange={(event) =>
                void toggleHidden(event.currentTarget.checked)
              }
            >
              <Trans>Hide my name</Trans>
            </Checkbox>
            <Text class="label">
              <Trans>
                Hidden contributors show as Anonymous to everyone, the server
                owner included. This applies to all your contributions and
                pledges on this server.
              </Trans>
            </Text>
          </Column>
        </Show>

        <Show when={note()}>
          {(message) => <NoteLine role="status">{message()}</NoteLine>}
        </Show>
        <Show when={error()}>
          {(message) => <ErrorLine role="alert">{message()}</ErrorLine>}
        </Show>

        <SeatNotice role="note">{seatNotice()}</SeatNotice>
      </Column>
    </Dialog>
  );
}

// prot-contribute-pure:begin
// Decisions loaded by `protContribute.scan.test.ts`: no imports.

/** What the dialog knows about its target, for {@link contributeBlock} */
type ContributeTargetState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "tank"; stage: string; canContribute: boolean }
  | { kind: "goal"; state: string; deadlineAt: number; open: number };

/**
 * Why nothing can be contributed right now, or `null` when the form is
 * offered:
 * - `store`: a store build (D5), checked first so nothing about spending
 *   shows there;
 * - `disabled`: Prot is switched off, or the advert has no usable minimum
 *   (an invalid tank config advertises `min_contribution: 0`, 16.5);
 * - `loading`: the target has not been read yet;
 * - `closed`: no tank (or no goal), a tank stage that takes no top-ups
 *   (only Active, Grace and Frozen do, 8.8), or a goal that is no longer
 *   Funding, is past its deadline or needs nothing more (8.3);
 * - `notEligible`: the server says this caller may not top up this tank
 *   now (`can_contribute`, D6).
 */
type ContributeBlock =
  | "store"
  | "disabled"
  | "loading"
  | "closed"
  | "notEligible"
  | null;

const TOP_UP_STAGES: readonly string[] = ["Active", "Grace", "Frozen"];

function contributeBlock(input: {
  spendingAllowed: boolean;
  enabled: boolean;
  minContribution: number;
  target: ContributeTargetState;
  nowMs: number;
}): ContributeBlock {
  if (input.spendingAllowed !== true) return "store";
  if (
    input.enabled !== true ||
    !Number.isSafeInteger(input.minContribution) ||
    input.minContribution <= 0
  ) {
    return "disabled";
  }
  const target = input.target;
  switch (target.kind) {
    case "loading":
      return "loading";
    case "missing":
      return "closed";
    case "tank":
      if (!TOP_UP_STAGES.includes(target.stage)) return "closed";
      return target.canContribute === true ? null : "notEligible";
    case "goal":
      if (
        target.state !== "Funding" ||
        !(input.nowMs < target.deadlineAt) ||
        !(target.open > 0)
      ) {
        return "closed";
      }
      return null;
    default:
      return "closed";
  }
}

/** What a goal still needs (target minus pledged), never below 0 */
function goalOpen(goal: {
  target_prot: number;
  pledged_total: number;
}): number {
  const open = goal.target_prot - goal.pledged_total;
  return Number.isSafeInteger(open) && open > 0 ? open : 0;
}

/** The nonce of an attempt, and the amount it was sent with */
type NonceSlot = { amount: number; nonce: string };

/**
 * The nonce for the next attempt. `unsettled` is the previous attempt of
 * this dialog, kept until one succeeds; its nonce is reused even if the
 * amount changed. Any earlier attempt whose answer was lost may have
 * landed, and a refusal of a later retry (a 429, Prot switched off) does
 * not say otherwise, so a fresh nonce could post twice. With the same one
 * the server answers a landed attempt with the stored result (or refuses a
 * different top-up as an idempotency conflict). A refused posting stores
 * no key (8.3, 8.8), so reusing the nonce after a refusal costs nothing.
 */
function nextNonce(
  unsettled: NonceSlot | undefined,
  amount: number,
  make: () => string,
): NonceSlot {
  if (unsettled && typeof unsettled.nonce === "string" && unsettled.nonce) {
    return { amount, nonce: unsettled.nonce };
  }
  return { amount, nonce: make() };
}

/**
 * Whether a failed contribution may still have been applied: anything but
 * an answer the server gave (an error body with a `type`, or a 429) is
 * unknown (a network failure, a gateway error without a body, a 200 this
 * client could not read).
 */
function outcomeUnknown(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  const value = error as { type?: unknown; kind?: unknown };
  if (typeof value.type === "string") return false;
  if (value.kind === "rateLimited") return false;
  return true;
}

/**
 * Whether a refusal says an earlier attempt with this nonce landed:
 * `ProtIdempotencyConflict` means the server already holds a posting under
 * the nonce with other details (the answer was lost, then the amount
 * changed). That nonce is spent, so it is dropped; keeping it would repeat
 * the conflict on every retry.
 */
function landedEarlier(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === "ProtIdempotencyConflict"
  );
}

/**
 * The caller's hide-name setting as the server shows it: the first line
 * marked `you` in any of the lists, or `null` when there is none (not
 * known; the box starts clear and nothing is sent until it is toggled).
 */
function ownHiddenPref(
  groups: readonly (readonly { you: boolean; hidden: boolean }[])[],
): boolean | null {
  for (const lines of groups) {
    for (const line of lines) {
      if (line.you === true) return line.hidden === true;
    }
  }
  return null;
}

/**
 * A preview of a wallet refusal for `amount` from the last wallet read:
 * `short` past the balance, `held` past what the purchase hold leaves
 * spendable (D17), else `null`. The server decides; this only explains.
 */
function walletHint(
  amount: number,
  me: { balance: number; held: number },
): "short" | "held" | null {
  if (!Number.isSafeInteger(amount) || amount < 1) return null;
  if (amount > me.balance) return "short";
  if (amount > me.balance - Math.max(0, me.held)) return "held";
  return null;
}
// prot-contribute-pure:end

/** Never hidden, never collapsed: no clamp, no overflow, no display rule */
const SeatNotice = styled("p", {
  base: {
    margin: 0,
    padding: "var(--gap-md) var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const NoteLine = styled("p", {
  base: {
    margin: 0,
    color: "var(--md-sys-color-on-surface)",
  },
});

const ErrorLine = styled("p", {
  base: {
    margin: 0,
    color: "var(--md-sys-color-error)",
  },
});

import { For, Match, Show, Switch, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import type {
  Client,
  DonationReward,
  DonationTier,
  SupporterClaimCode,
  SupporterClaimResult,
  SupporterSummary,
} from "stoat.js";

import { allowsDonationLinks, useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useError } from "@revolt/i18n";
import {
  Button,
  CategoryButton,
  Checkbox,
  CircularProgress,
  Column,
  Row,
  Text,
  TextField,
  useSnackbar,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { checkoutNeedsEmail } from "./cipherCheckout";

/** Longest transaction id the server accepts */
const MAX_TRANSACTION_ID = 64;

/**
 * Headers for a JSON request as the session user.
 *
 * The claim and preference routes use plain fetch: they are newer than the
 * generated stoat-api schema, and the typed client drops request bodies for
 * routes it doesn't know.
 */
function jsonHeaders(client: Client): Record<string, string> {
  const [header, token] = client.authenticationHeader;
  return { [header]: token, "Content-Type": "application/json" };
}

/**
 * Error for a failed request: the API's own error body when there is one,
 * so it can be translated, otherwise the HTTP status
 */
async function responseError(response: Response): Promise<unknown> {
  const body = (await response.json().catch(() => undefined)) as
    | { type?: unknown }
    | undefined;

  return typeof body?.type === "string"
    ? body
    : new Error(`${response.status} ${response.statusText}`.trim());
}

/**
 * Supporter settings: lifetime support, the perk ladder and linking Ko-fi
 * payments to the account. Nothing renders in store builds, which may not
 * link out to other payment methods.
 */
export function Supporter() {
  return (
    <Show when={allowsDonationLinks()}>
      <SupporterPage />
    </Show>
  );
}

function SupporterPage() {
  const client = useClient();
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const err = useError();
  const { t } = useLingui();

  // Keyed by user as well: the query cache outlives a sign-out, and the next
  // account must never be shown the previous one's support
  const queryKey = () => ["supporter", client().user?.id];

  const query = useQuery(() => ({
    queryKey: queryKey(),
    queryFn: () =>
      client().api.get(
        "/users/@me/supporter" as never,
      ) as unknown as Promise<SupporterSummary>,
  }));

  const [code, setCode] = createSignal<SupporterClaimCode>();
  const [fetchingCode, setFetchingCode] = createSignal(false);
  const [transactionId, setTransactionId] = createSignal("");
  const [claiming, setClaiming] = createSignal(false);
  const [savingBadges, setSavingBadges] = createSignal(false);

  const usd = (cents: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    }).format(cents / 100);

  const date = (ms: number) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(ms);

  const dateTime = (ms: number) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ms);

  function rewardLabel(reward: DonationReward): string {
    switch (reward) {
      case "SupporterBadge":
        return t`Supporter badge`;
      case "NameColour":
        return t`Name color`;
      case "NameFont":
        return t`Name font`;
      case "NameEffect":
        return t`Animated name effect`;
      case "PatronBadge":
        return t`Patron badge`;
      default:
        // A reward added on the server before this client knows about it
        return reward as string;
    }
  }

  function rewardIcon(reward: DonationReward): string {
    switch (reward) {
      case "NameColour":
        return "palette";
      case "NameFont":
        return "font_download";
      case "NameEffect":
        return "auto_awesome";
      default:
        return "workspace_premium";
    }
  }

  /** Only ever open an https page, whatever the server sent */
  const kofiUrl = () => {
    const url = query.data?.kofi_url;
    return url && /^https:\/\//i.test(url) ? url : undefined;
  };

  /** The next rung of the ladder, if any is left */
  const nextTier = (): DonationTier | undefined => {
    const summary = query.data;
    if (summary?.next_tier_cents === undefined) return;
    return summary.tiers?.find(
      (tier) => tier.cents === summary.next_tier_cents,
    );
  };

  function activeUntil(ms: number) {
    const until = date(ms);
    return t`Active until ${until}`;
  }

  function codeExpiry(ms: number) {
    const expires = dateTime(ms);
    return t`Expires ${expires}`;
  }

  function progress(summary: SupporterSummary, tier: DonationTier) {
    const remaining = usd(tier.cents - summary.lifetime_usd_cents);
    const reward = rewardLabel(tier.reward);
    return t`${remaining} more to unlock ${reward}`;
  }

  async function getCode() {
    if (fetchingCode()) return;
    setFetchingCode(true);

    try {
      setCode(
        await (client().api.post(
          "/users/@me/supporter/code" as never,
        ) as unknown as Promise<SupporterClaimCode>),
      );
    } catch (error) {
      snackbar.show({ message: err(error) });
    } finally {
      setFetchingCode(false);
    }
  }

  function copyCode(value: string) {
    // `navigator.clipboard` is missing outside secure contexts, so a
    // synchronous throw has to land in the same rejection handler
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => snackbar.show({ message: t`Copied!` }),
        () => snackbar.show({ message: t`Could not copy to the clipboard.` }),
      );
  }

  async function claim(event: Event) {
    event.preventDefault();
    const id = transactionId().trim();
    if (!id || id.length > MAX_TRANSACTION_ID || claiming()) return;
    setClaiming(true);

    try {
      const response = await fetch(
        `${CONFIGURATION.DEFAULT_API_URL}/users/@me/supporter/claim`,
        {
          method: "POST",
          headers: jsonHeaders(client()),
          body: JSON.stringify({ transaction_id: id }),
        },
      );

      if (!response.ok) throw await responseError(response);

      const result = (await response.json()) as SupporterClaimResult;
      setTransactionId("");

      if (result.outcome === "Claimed") {
        snackbar.show({
          message: t`Your support is now linked to your account. Thank you!`,
        });
        void query.refetch();
      } else {
        snackbar.show({ message: t`We'll review this claim.` });
      }
    } catch (error) {
      // Ko-fi hasn't told the server about this payment (yet)
      const notFound = (error as { type?: unknown })?.type === "NotFound";
      // A claim is matched on the account's email: with none, say so
      const needsEmail = !notFound && checkoutNeedsEmail(error);
      snackbar.show({
        message: notFound
          ? t`We haven't received that transaction yet. Try again in a few minutes.`
          : needsEmail
            ? t`Add an email address to your account first (Settings > Account).`
            : err(error),
      });
    } finally {
      setClaiming(false);
    }
  }

  async function setShowBadges(event: { currentTarget: { checked: boolean } }) {
    // Held before the await: the event is done with by the time it resolves
    const target = event.currentTarget;
    const show = target.checked;
    // The account the request is sent as, even if it signs out meanwhile
    const key = queryKey();
    setSavingBadges(true);

    try {
      const response = await fetch(
        `${CONFIGURATION.DEFAULT_API_URL}/users/@me/supporter`,
        {
          method: "PATCH",
          headers: jsonHeaders(client()),
          body: JSON.stringify({ show_badges: show }),
        },
      );

      if (!response.ok) throw await responseError(response);

      queryClient.setQueryData(
        key,
        (await response.json()) as SupporterSummary,
      );
    } catch (error) {
      // The cached value never changed, so the box has to be put back by hand
      target.checked = !show;
      snackbar.show({ message: err(error) });
    } finally {
      setSavingBadges(false);
    }
  }

  return (
    <Switch fallback={<CircularProgress />}>
      {/* Data first: a failed background refetch keeps the last summary */}
      <Match when={query.data}>
        {(summary) => (
          <Column gap="lg">
            <Text class="label">
              <Trans>
                Support Sloga on Ko-fi to unlock supporter perks. Perks are
                cosmetic: they change how your name and profile look, and
                nothing else.
              </Trans>
            </Text>

            <CategoryButton.Group>
              <CategoryButton
                icon={<Symbol size={22}>volunteer_activism</Symbol>}
                description={<Trans>Lifetime support</Trans>}
              >
                {usd(summary().lifetime_usd_cents)}
              </CategoryButton>
              <CategoryButton
                icon={<Symbol size={22}>event_repeat</Symbol>}
                description={
                  <Show
                    when={
                      summary().monthly_active
                        ? summary().monthly_until
                        : undefined
                    }
                    fallback={
                      <Trans>
                        A monthly Ko-fi membership adds a badge and name color
                        while it's active.
                      </Trans>
                    }
                  >
                    {(until) => activeUntil(until())}
                  </Show>
                }
              >
                <Trans>Monthly supporter</Trans>
              </CategoryButton>
              <Show
                when={
                  summary().next_tier_cents === undefined &&
                  summary().tiers?.length
                }
              >
                <CategoryButton icon={<Symbol size={22}>celebration</Symbol>}>
                  <Trans>
                    You've unlocked every supporter perk. Thank you!
                  </Trans>
                </CategoryButton>
              </Show>
              <Show when={nextTier()}>
                {(tier) => (
                  <CategoryButton
                    icon={<Symbol size={22}>trending_up</Symbol>}
                    description={<Trans>Next perk</Trans>}
                  >
                    {progress(summary(), tier())}
                  </CategoryButton>
                )}
              </Show>
            </CategoryButton.Group>

            <Show when={summary().tiers?.length}>
              <Column>
                <Text class="title">
                  <Trans>Supporter perks</Trans>
                </Text>
                <CategoryButton.Group>
                  <For each={summary().tiers}>
                    {(tier) => (
                      <CategoryButton
                        icon={
                          <Symbol size={22}>{rewardIcon(tier.reward)}</Symbol>
                        }
                        description={
                          <>
                            {usd(tier.cents)}
                            <Show
                              when={summary().lifetime_usd_cents >= tier.cents}
                            >
                              {" · "}
                              <Trans>Unlocked</Trans>
                            </Show>
                          </>
                        }
                        action={
                          <Symbol size={20}>
                            {summary().lifetime_usd_cents >= tier.cents
                              ? "check_circle"
                              : "lock"}
                          </Symbol>
                        }
                      >
                        {rewardLabel(tier.reward)}
                      </CategoryButton>
                    )}
                  </For>
                </CategoryButton.Group>
              </Column>
            </Show>

            <Column>
              <Text class="title">
                <Trans>Link your support</Trans>
              </Text>
              <Text class="label">
                <Trans>
                  Get your code, then paste it into the message when you support
                  Sloga on Ko-fi. The payment is added to your account
                  automatically.
                </Trans>
              </Text>
              <CategoryButton.Group>
                <Show
                  when={code()}
                  fallback={
                    <CategoryButton
                      icon={<Symbol size={22}>key</Symbol>}
                      description={
                        <Trans>Paste this code into your Ko-fi message</Trans>
                      }
                      action={
                        <Button
                          size="sm"
                          onPress={getCode}
                          isDisabled={fetchingCode()}
                        >
                          <Trans>Get my code</Trans>
                        </Button>
                      }
                    >
                      <Trans>Supporter code</Trans>
                    </CategoryButton>
                  }
                >
                  {(current) => (
                    <CategoryButton
                      icon={<Symbol size={22}>key</Symbol>}
                      description={
                        <>
                          <Trans>Paste this code into your Ko-fi message</Trans>
                          {" · "}
                          {codeExpiry(current().expires_at)}
                        </>
                      }
                      action="copy"
                      onClick={() => copyCode(current().code)}
                    >
                      {current().code}
                    </CategoryButton>
                  )}
                </Show>
              </CategoryButton.Group>
              <Show when={kofiUrl()}>
                {(url) => (
                  <Row>
                    <Button onPress={() => window.open(url(), "_blank")}>
                      <Trans>Support Sloga on Ko-fi</Trans>
                    </Button>
                  </Row>
                )}
              </Show>
            </Column>

            <form onSubmit={claim}>
              <Column>
                <Text class="title">
                  <Trans>Supported without a code?</Trans>
                </Text>
                <Text class="label">
                  <Trans>
                    Enter the transaction ID from your Ko-fi receipt. If the
                    payment came from your account's email address it's added
                    right away; otherwise we'll review it.
                  </Trans>
                </Text>
                <Row align>
                  <TextField
                    value={transactionId()}
                    maxlength={MAX_TRANSACTION_ID}
                    label={t`Ko-fi transaction ID`}
                    autocomplete="off"
                    onInput={(event) =>
                      setTransactionId(event.currentTarget.value)
                    }
                  />
                  <Button
                    size="sm"
                    type="submit"
                    isDisabled={!transactionId().trim() || claiming()}
                  >
                    <Trans>Claim</Trans>
                  </Button>
                </Row>
              </Column>
            </form>

            <Checkbox
              checked={!!summary().show_badges}
              disabled={savingBadges()}
              onChange={setShowBadges}
            >
              <Trans>Show supporter badges on my profile</Trans>
            </Checkbox>
          </Column>
        )}
      </Match>
      <Match when={query.isError}>
        <Column>
          <Text class="label">{err(query.error)}</Text>
          <Row>
            <Button size="sm" onPress={() => void query.refetch()}>
              <Trans>Retry</Trans>
            </Button>
          </Row>
        </Column>
      </Match>
    </Switch>
  );
}

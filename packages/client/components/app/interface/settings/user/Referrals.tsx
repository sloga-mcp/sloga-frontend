import { For, JSX, Match, Show, Switch } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQuery } from "@tanstack/solid-query";
import type { ReferralReward, ReferralSummary, ReferralTier } from "stoat.js";

import { allowsDonationLinks, useClient } from "@revolt/client";
import { useError } from "@revolt/i18n";
import { useState } from "@revolt/state";
import {
  Button,
  CategoryButton,
  CircularProgress,
  Column,
  Row,
  Text,
  useSnackbar,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useSettingsNavigation } from "../Settings";

/**
 * Referrals settings page: your referral code and link, how many friends
 * have joined through them, and the rewards on the referral ladder.
 */
export function Referrals() {
  const client = useClient();
  const err = useError();

  // Keyed by user as well: the query cache outlives a sign-out, and the next
  // account must never be shown the previous one's code
  const query = useQuery(() => ({
    queryKey: ["referrals", client().user?.id],
    queryFn: () =>
      client().api.get(
        "/users/@me/referrals" as never,
      ) as unknown as Promise<ReferralSummary>,
  }));

  return (
    <Column gap="lg">
      <Text class="label">
        <Trans>
          Invite friends to Sloga with your referral code or link. Each friend
          who sticks around brings you closer to the next reward.
        </Trans>
      </Text>

      <Switch fallback={<CircularProgress />}>
        <Match when={query.data}>
          {(summary) => <ReferralOverview summary={summary()} />}
        </Match>
        <Match when={query.isError}>
          <Column>
            <Text class="label">{err(query.error)}</Text>
            <Row>
              <Button
                size="sm"
                isDisabled={query.isFetching}
                onPress={() => query.refetch()}
              >
                <Trans>Try again</Trans>
              </Button>
            </Row>
          </Column>
        </Match>
      </Switch>

      <HowItWorks />

      <Show when={allowsDonationLinks()}>
        <SupporterLink />
      </Show>
    </Column>
  );
}

/**
 * Code, link, counts and ladder for a loaded summary
 */
function ReferralOverview(props: { summary: ReferralSummary }) {
  const { t } = useLingui();
  const snackbar = useSnackbar();
  const rewardLabel = useRewardLabel();

  // Android WebViews have no Web Share API; copying covers them
  const canShare = typeof navigator.share === "function";

  function notify(message: string) {
    snackbar.show({ message, placement: "bottom", closeable: true });
  }

  function copy(text: string, message: string) {
    // `navigator.clipboard` is missing outside secure contexts, so a
    // synchronous throw has to land in the same rejection handler
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => notify(message),
        () => notify(t`Could not copy to the clipboard.`),
      );
  }

  async function share() {
    try {
      await navigator.share({
        text: t`Join me on Sloga`,
        url: props.summary.link,
      });
    } catch (error) {
      // Dismissing the share sheet is not a failure
      if ((error as { name?: string } | undefined)?.name === "AbortError") {
        return;
      }

      copy(props.summary.link, t`Referral link copied to clipboard`);
    }
  }

  const tiers = () => props.summary.tiers ?? [];

  /**
   * Progress towards the next tier, or a note once every tier is reached
   */
  const nextRewardText = () => {
    const next = props.summary.next_tier;
    if (typeof next !== "number") {
      return tiers().length
        ? t`You've unlocked every reward. Thank you for spreading the word!`
        : undefined;
    }

    const tier = tiers().find((entry) => entry.count === next);
    const current = props.summary.qualified;
    if (!tier) return t`Next reward: ${current} of ${next}`;

    const reward = rewardLabel(tier.reward);
    return t`Next reward: ${reward} (${current} of ${next})`;
  };

  return (
    <Column gap="lg">
      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol size={22}>tag</Symbol>}
          description={<Trans>Your referral code</Trans>}
          action="copy"
          onClick={() =>
            copy(
              props.summary.display_code,
              t`Referral code copied to clipboard`,
            )
          }
        >
          {props.summary.display_code}
        </CategoryButton>
        <CategoryButton
          icon={<Symbol size={22}>link</Symbol>}
          description={<Trans>Your referral link</Trans>}
          action="copy"
          onClick={() =>
            copy(props.summary.link, t`Referral link copied to clipboard`)
          }
        >
          {props.summary.link}
        </CategoryButton>
        <Show when={canShare}>
          <CategoryButton
            icon={<Symbol size={22}>share</Symbol>}
            action="chevron"
            onClick={share}
          >
            <Trans>Share your referral link</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>

      <Column>
        <Text class="title" size="small">
          <Trans>Your referrals</Trans>
        </Text>
        <Row wrap gap="xl">
          <Count value={props.summary.qualified} color={SLOGA_GREEN}>
            <Trans>Qualified</Trans>
          </Count>
          <Count value={props.summary.pending} color={SLOGA_YELLOW}>
            <Trans>Pending</Trans>
          </Count>
          <Count value={props.summary.expired} color={SLOGA_RED}>
            <Trans>Expired</Trans>
          </Count>
        </Row>
        <Show when={nextRewardText()}>
          {(text) => <Text class="label">{text()}</Text>}
        </Show>
      </Column>

      <Show when={tiers().length}>
        <Column>
          <Text class="title" size="small">
            <Trans>Rewards</Trans>
          </Text>
          <CategoryButton.Group>
            <For each={tiers()}>
              {(tier) => (
                <TierRow tier={tier} qualified={props.summary.qualified} />
              )}
            </For>
          </CategoryButton.Group>
        </Column>
      </Show>
    </Column>
  );
}

/**
 * Sloga logo colors (sampled from assets/web/sloga-icon.png, same values as
 * the slogaball minigame), fixed so they do not shift with the theme
 */
const SLOGA_GREEN = "#27A163";
const SLOGA_YELLOW = "#E3CF1B";
const SLOGA_RED = "#CF2A27";

/**
 * One referral count with its label, tinted in a logo color
 */
function Count(props: { value: number; color: string; children: JSX.Element }) {
  const state = useState();

  // The logo yellow is unreadable on white (about 1.4:1), so light mode
  // darkens every tint to keep the labels above 4.5:1
  const color = () =>
    state.theme.activeTheme.darkMode
      ? props.color
      : `color-mix(in srgb, ${props.color} 55%, black)`;

  return (
    <Column gap="none" style={{ color: color() }}>
      <Text class="headline" size="small">
        {props.value}
      </Text>
      <Text class="label">{props.children}</Text>
    </Column>
  );
}

/**
 * One rung of the referral ladder
 */
function TierRow(props: { tier: ReferralTier; qualified: number }) {
  const { t } = useLingui();
  const rewardLabel = useRewardLabel();

  const unlocked = () => props.qualified >= props.tier.count;

  const status = () => {
    if (unlocked()) return t`Unlocked`;
    const remaining = props.tier.count - props.qualified;
    return t`${remaining} to go`;
  };

  return (
    <CategoryButton
      icon={<Symbol size={22}>{unlocked() ? "check_circle" : "lock"}</Symbol>}
      description={
        <Show when={props.tier.reward === "CustomBadge"} fallback={status()}>
          {status()}
          {" · "}
          <Trans>We'll contact you to design your badge.</Trans>
        </Show>
      }
      action={<Text class="label">{props.tier.count}</Text>}
    >
      {rewardLabel(props.tier.reward)}
    </CategoryButton>
  );
}

/**
 * When a referral counts, in brief
 */
function HowItWorks() {
  return (
    <Column>
      <Text class="title" size="small">
        <Trans>How it works</Trans>
      </Text>
      <Text class="label">
        <Trans>
          A friend who signs up with your code or link, or through one of your
          server invites, shows up as pending. The referral counts once they've
          used Sloga regularly for a week, chatting on several different days.
          Pending referrals expire after 60 days.
        </Trans>
      </Text>
    </Column>
  );
}

/**
 * Pointer to the Supporter page; only rendered where donation links are
 * allowed
 */
function SupporterLink() {
  const { navigate } = useSettingsNavigation();

  return (
    <CategoryButton.Group>
      <CategoryButton
        icon={<Symbol size={22}>volunteer_activism</Symbol>}
        description={<Trans>Supporters can unlock name styles too.</Trans>}
        action="chevron"
        onClick={() => navigate("supporter")}
      >
        <Trans>Support Sloga</Trans>
      </CategoryButton>
    </CategoryButton.Group>
  );
}

/**
 * Translate referral rewards; call during component setup
 */
function useRewardLabel() {
  const { t } = useLingui();

  return (reward: ReferralReward): string => {
    switch (reward) {
      case "Badge":
        return t`Recruiter badge`;
      case "NameColour":
        return t`Name color`;
      case "BetterBadge":
        return t`Elite recruiter badge`;
      case "NameFont":
        return t`Name font`;
      case "NameEffect":
        return t`Animated name effect`;
      case "UploadPerk":
        return t`10 GB uploads, large files kept 7 days`;
      case "CustomBadge":
        return t`Your own custom badge`;
      default:
        // A reward added on the server before this client knows about it
        return reward;
    }
  };
}

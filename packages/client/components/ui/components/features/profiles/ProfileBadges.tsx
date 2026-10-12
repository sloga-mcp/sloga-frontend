import { Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { User, UserBadges } from "stoat.js";
import { styled } from "styled-system/jsx";

import badgeActiveSupporter from "../../../../../scripts/assets_fallback/badges/active_supporter.svg";
import badgeJoke1 from "../../../../../scripts/assets_fallback/badges/amog.svg";
import badgeJoke2 from "../../../../../scripts/assets_fallback/badges/amorbus.svg";
import badgeDeveloper from "../../../../../scripts/assets_fallback/badges/developer.svg";
import badgeDisclosure from "../../../../../scripts/assets_fallback/badges/disclosure.svg";
import badgeEarlyAdopter from "../../../../../scripts/assets_fallback/badges/early_adopter.svg";
import badgeFounder from "../../../../../scripts/assets_fallback/badges/founder.svg";
import badgeFoundingStreamer from "../../../../../scripts/assets_fallback/badges/founding_streamer.svg";
import badgeModeration from "../../../../../scripts/assets_fallback/badges/moderation.svg";
import badgePatron from "../../../../../scripts/assets_fallback/badges/patron.svg";
import badgePaw from "../../../../../scripts/assets_fallback/badges/paw.svg";
import badgeRecruiter from "../../../../../scripts/assets_fallback/badges/recruiter.svg";
import badgeRecruiterElite from "../../../../../scripts/assets_fallback/badges/recruiter_elite.svg";
import badgeSupporter from "../../../../../scripts/assets_fallback/badges/supporter.svg";
import badgeTranslator from "../../../../../scripts/assets_fallback/badges/translator.svg";
import badgeWelcomed from "../../../../../scripts/assets_fallback/badges/welcomed.svg";
import { Text } from "../../design";

import { ProfileCard } from "./ProfileCard";

export function ProfileBadges(props: { user: User }) {
  const { t } = useLingui();

  return (
    <Show when={props.user.badges || props.user.customBadge}>
      <ProfileCard>
        <Text class="title" size="large">
          <Trans>Badges</Trans>
        </Text>

        <BadgeRow>
          <Show when={props.user.customBadge}>
            {(badge) => (
              <img
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: badge().label,
                  },
                }}
                src={badge().image.createFileURL()}
                alt=""
              />
            )}
          </Show>
          <Show when={props.user.badges & UserBadges.Founder}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Sloga Founder`,
                },
              }}
              src={badgeFounder}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Developer}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Sloga Developer`,
                },
              }}
              src={badgeDeveloper}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Supporter}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Donated to Sloga`,
                },
              }}
              src={badgeSupporter}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.ActiveSupporter}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Active Sloga supporter`,
                },
              }}
              src={badgeActiveSupporter}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Patron}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Sloga Patron`,
                },
              }}
              src={badgePatron}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Translator}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Helped translate Sloga`,
                },
              }}
              src={badgeTranslator}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.EarlyAdopter}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`One of the first 1000 users!`,
                },
              }}
              src={badgeEarlyAdopter}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.FoundingStreamer}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Founding Streamer`,
                },
              }}
              src={badgeFoundingStreamer}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Welcomed}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Joined Sloga through a friend`,
                },
              }}
              src={badgeWelcomed}
            />
          </Show>
          {/* Both bits are set at the elite tier; show only the higher one. */}
          <Show
            when={
              props.user.badges & UserBadges.Recruiter &&
              !(props.user.badges & UserBadges.RecruiterElite)
            }
          >
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Invited a friend to Sloga`,
                },
              }}
              src={badgeRecruiter}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.RecruiterElite}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Invited 5 friends to Sloga`,
                },
              }}
              src={badgeRecruiterElite}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.PlatformModeration}>
            <span
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Sloga Moderator`,
                },
              }}
            >
              <img src={badgeModeration} />
            </span>
          </Show>
          <Show when={props.user.badges & UserBadges.ResponsibleDisclosure}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`Responsibly disclosed security issues`,
                },
              }}
              src={badgeDisclosure}
            />
          </Show>
          <Show
            when={props.user.badges & UserBadges.ReservedRelevantJokeBadge1}
          >
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`irrelevant joke badge 1`,
                },
              }}
              src={badgeJoke1}
            />
          </Show>
          <Show
            when={props.user.badges & UserBadges.ReservedRelevantJokeBadge2}
          >
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: t`irrelevant joke badge 2`,
                },
              }}
              src={badgeJoke2}
            />
          </Show>
          <Show when={props.user.badges & UserBadges.Paw}>
            <img
              use:floating={{
                tooltip: {
                  placement: "top",
                  content: "🦊",
                },
              }}
              src={badgePaw}
            />
          </Show>
        </BadgeRow>
      </ProfileCard>
    </Show>
  );
}

const BadgeRow = styled("div", {
  base: {
    gap: "var(--gap-md)",
    display: "flex",
    flexWrap: "wrap",

    "& img, & svg": {
      width: "24px",
      height: "24px",
      aspectRatio: "1/1",
      objectFit: "contain",
    },
  },
});

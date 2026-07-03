import { Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { User } from "stoat.js";
import { styled } from "styled-system/jsx";

import { Text, typography } from "../../design";

import { ProfileCard } from "./ProfileCard";

export function ProfileStatus(props: { user: User }) {
  const { t } = useLingui();

  /**
   * Human-readable play duration, e.g. "for 2h 15m"
   */
  const playingFor = () => {
    const startedAt = props.user.activity?.started_at;
    if (!startedAt) return undefined;
    const minutes = Math.floor((Date.now() - +new Date(startedAt)) / 60_000);
    if (minutes < 1) return undefined;
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  };

  return (
    <>
      <Show when={props.user.activity}>
        <ProfileCard>
          <Text class="title" size="large">
            <Trans>Activity</Trans>
          </Text>
          <Status>
            <Show
              when={playingFor()}
              fallback={<Trans>Playing {props.user.activity!.name}</Trans>}
            >
              <Trans>
                Playing {props.user.activity!.name} for {playingFor()}
              </Trans>
            </Show>
          </Status>
        </ProfileCard>
      </Show>
      <Show when={props.user.status?.text}>
        <ProfileCard>
          <Text class="title" size="large">
            <Trans>Status</Trans>
          </Text>
          <Status>
            {props.user.statusMessage((s) =>
              s === "Online"
                ? t`Online`
                : s === "Busy"
                  ? t`Busy`
                  : s === "Focus"
                    ? t`Focus`
                    : s === "Idle"
                      ? t`Idle`
                      : t`Offline`,
            )}
          </Status>
        </ProfileCard>
      </Show>
    </>
  );
}

const Status = styled("span", {
  base: {
    ...typography.raw(),
    userSelect: "text",
  },
});

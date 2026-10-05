import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { User } from "stoat.js";
import { styled } from "styled-system/jsx";

import { Text, typography, usePresenceText } from "../../design";

import { ProfileCard } from "./ProfileCard";

export function ProfileStatus(props: { user: User }) {
  const presence = usePresenceText();

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
          <Status>{props.user.statusMessage(presence.label)}</Status>
        </ProfileCard>
      </Show>
    </>
  );
}

const Status = styled("span", {
  base: {
    ...typography.raw(),
    userSelect: "text",

    // These two tiles take ProfileCard's default `width: 1` variant, which is
    // a hard square (`overflow: hidden` + `aspect-ratio: 1/1`). A long status
    // used to run past the bottom edge and get sheared mid-line with no
    // visual signal at all, which reads as a rendering bug rather than as
    // truncation. Two lines is what fits the narrowest tile the 3-column
    // profile grid produces (~116px square on a 412px phone, leaving ~54px
    // under the 28px title), so the clamp engages before the square does and
    // the ellipsis carries the cut. This is width-driven, not breakpoint-
    // driven — a narrow desktop window gets the same tile and the same clamp.
    lineClamp: 2,
  },
});

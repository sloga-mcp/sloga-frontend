import { For, Show, splitProps } from "solid-js";
import {
  TrackLoop,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useTracks,
} from "solid-livekit-components";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { Track } from "livekit-client";
import { Channel, VoiceParticipant } from "stoat.js";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUser } from "@revolt/markdown/users";
import { InRoom } from "@revolt/rtc";

import { Avatar, Ripple, livePill, typography } from "../../design";
import { Row } from "../../layout";

import { participantUserId } from "./participantIdentity";

import { VoiceStatefulUserIcons } from "./VoiceStatefulUserIcons";

/**
 * Render a preview of users (or the active participants) for a given channel
 *
 * Designed for the server sidebar to be below channels
 */
export function VoiceChannelPreview(props: { channel: Channel }) {
  return (
    <InRoom
      channelId={props.channel.id}
      fallback={<VariantPreview channel={props.channel} />}
    >
      <VariantLive channel={props.channel} />
    </InRoom>
  );
}

/**
 * Use LiveKit as the source of truth for who is present
 *
 * Track state still comes from the channel roster — see `ParticipantLive`.
 */
function VariantLive(props: { channel: Channel }) {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );

  return (
    <Base>
      <TrackLoop tracks={tracks}>
        {() => <ParticipantLive channel={props.channel} />}
      </TrackLoop>
    </Base>
  );
}

/**
 * Use the API as the source of truth
 */
function VariantPreview(props: { channel: Channel }) {
  return (
    <Show when={props.channel.voiceParticipants.size}>
      <Base>
        <For each={[...props.channel.voiceParticipants.values()]}>
          {(participant) => <ParticipantPreview participant={participant} />}
        </For>
      </Base>
    </Show>
  );
}

/**
 * A screen-AUDIO-only share.
 *
 * The historical `screensharing` flag is set for both the screen video and the
 * screen audio track, so on its own it can mean "sharing" with nothing to look
 * at. Splitting the two is what lets the LIVE badge promise video and only
 * video; what is left over still deserves the quieter share glyph.
 */
function screenAudioOnly(state: VoiceParticipant | undefined) {
  return !!state && state.isScreensharing() && !state.isScreenVideo();
}

/**
 * Live variant of participant
 *
 * LiveKit supplies presence and the real-time speaking/mute signals, but camera
 * and screenshare are read from the channel roster: it is the same state
 * everyone outside the call sees, so the badges cannot say one thing in the
 * sidebar and another the moment you join.
 */
function ParticipantLive(props: { channel: Channel }) {
  const participant = useEnsureParticipant();

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  });

  const isSpeaking = useIsSpeaking(participant);

  const state = () =>
    props.channel.voiceParticipants.get(
      participantUserId(participant.identity),
    );

  return (
    <CommonUser
      userId={participant.identity}
      speaking={isSpeaking()}
      muted={isMuted()}
      deafened={false}
      camera={state()?.isCamera() ?? false}
      screenshare={screenAudioOnly(state())}
      sharingScreen={state()?.isScreenVideo() ?? false}
      watching={state()?.isWatching() ?? false}
      isLive
    />
  );
}

/**
 * Preview variant of participant
 */
function ParticipantPreview(props: { participant: VoiceParticipant }) {
  return (
    <CommonUser
      userId={props.participant.userId}
      speaking={false}
      muted={!props.participant.isPublishing()}
      deafened={!props.participant.isReceiving()}
      camera={props.participant.isCamera()}
      screenshare={screenAudioOnly(props.participant)}
      sharingScreen={props.participant.isScreenVideo()}
      watching={props.participant.isWatching()}
    />
  );
}

/**
 * Component used for both variants
 */
function CommonUser(props: {
  userId: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screenshare: boolean;
  /** In the channel's watch party (self-reported roster hint) */
  watching?: boolean;
  /** Screen VIDEO is live — this is what earns the LIVE badge */
  sharingScreen?: boolean;
  isLive?: boolean;
}) {
  const { t } = useLingui();

  const [iconProps, rest] = splitProps(props, [
    "muted",
    "deafened",
    "camera",
    "screenshare",
    "watching",
  ]);

  const user = useUser(() => participantUserId(rest.userId));

  return (
    <div
      class={previewUser({ speaking: rest.speaking })}
      use:floating={{
        userCard: {
          user: user().user!,
          member: user().member,
        },
        contextMenu: () => (
          <UserContextMenu
            user={user().user!}
            member={user().member}
            inVoice={rest.isLive}
          />
        ),
      }}
    >
      <Ripple />
      <Avatar size={24} src={user().avatar} fallback={user().username} />{" "}
      <NameRow>
        <PreviewUsername>{user().username}</PreviewUsername>
        <Show when={rest.sharingScreen}>
          {/* No thumbnail: call media is end-to-end encrypted, so nobody
              outside the call holds a key to the frames and the server never
              sees them at all. The badge says that video is live and what to
              do about it; it does not pretend to show what. */}
          <span
            class={livePill()}
            use:floating={{
              tooltip: {
                placement: "top",
                content: t`Sharing their screen — join to watch`,
              },
            }}
          >
            <Trans>LIVE</Trans>
          </span>
        </Show>
      </NameRow>
      <Row gap="sm">
        <VoiceStatefulUserIcons {...iconProps} userId={rest.userId} />
      </Row>
    </div>
  );
}

const Base = styled("div", {
  base: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",

    marginBlock: "var(--gap-sm)",
    marginInlineStart: "var(--gap-xl)",
    marginInlineEnd: "var(--gap-md)",

    color: "var(--md-sys-color-outline)",

    borderRadius: "var(--borderRadius-md)",
  },
});

const previewUser = cva({
  base: {
    padding: "var(--gap-sm)",
    position: "relative", // ... <Ripple />
    display: "flex",
    gap: "var(--gap-md)",
    alignItems: "center",
    borderRadius: "var(--borderRadius-md)",
  },
  variants: {
    speaking: {
      true: {
        color: "var(--md-sys-color-on-surface)",

        "& svg": {
          outlineOffset: "1px",
          outline: "2px solid var(--md-sys-color-primary)",
          borderRadius: "var(--borderRadius-circle)",
        },
      },
    },
  },
});

/**
 * Name and badge, hugging each other at the start of the row.
 *
 * This is the element that grows, not the username — otherwise the badge would
 * be shoved across the row to sit against the state icons instead of beside the
 * name it belongs to.
 */
const NameRow = styled("div", {
  base: {
    minWidth: 0,
    flexGrow: 1,
    display: "flex",
    alignItems: "center",
  },
});

const PreviewUsername = styled("span", {
  base: {
    ...typography.raw(),

    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

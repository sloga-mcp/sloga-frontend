import { createSignal, onCleanup, Show } from "solid-js";
import {
  TrackReference,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useTrackRefContext,
  VideoTrack,
} from "solid-livekit-components";

import { ConnectionQuality, ParticipantEvent, Track } from "livekit-client";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUser } from "@revolt/markdown/users";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Avatar } from "@revolt/ui/components/design";
import { Row } from "@revolt/ui/components/layout";
import { OverflowingText } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { participantUserId } from "../participantIdentity";
import { VoiceStatefulUserIcons } from "../VoiceStatefulUserIcons";

type TileProps = {
  focus?: boolean;
};

/**
 * Individual participant tile
 */
export function ParticipantTile(props: TileProps) {
  const voice = useVoice();
  const state = useState();
  const participant = useEnsureParticipant();
  const track = useTrackRefContext();
  const user = useUser(participantUserId(participant.identity));

  let videoRef: HTMLVideoElement | undefined;

  const [videoDims, setVideoDims] = createSignal<{
    height: number;
    width: number;
  }>({ height: 0, width: 0 });

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  });

  const isScreenShareAudioMuted = useIsMuted({
    participant,
    source: Track.Source.ScreenShareAudio,
  });

  const isRemoteScreenShareMuted = useIsMuted({
    participant,
    source: Track.Source.ScreenShare,
  });

  const isScreenShareAudioUserMuted = () =>
    state.voice.getScreenShareMuted(user().user!.id)
      ? "by-user"
      : isScreenShareAudioMuted() || false;

  const isVideoMuted = useIsMuted({
    participant,
    source: Track.Source.Camera,
  });

  const isVideo = () => !isVideoMuted();
  const isScreenShare = () => track.source === Track.Source.ScreenShare;
  const isSpeaking = useIsSpeaking(participant);

  const [quality, setQuality] = createSignal<ConnectionQuality>(
    participant.connectionQuality,
  );

  const onQualityChange = (q: ConnectionQuality) => setQuality(q);
  participant.on(ParticipantEvent.ConnectionQualityChanged, onQualityChange);
  onCleanup(() =>
    participant.off(ParticipantEvent.ConnectionQualityChanged, onQualityChange),
  );

  const qualityColor = () => {
    switch (quality()) {
      case ConnectionQuality.Excellent:
        return "#4caf50";
      case ConnectionQuality.Good:
        return "#cddc39";
      case ConnectionQuality.Poor:
        return "#ff9800";
      case ConnectionQuality.Lost:
        return "#f44336";
      default:
        return "#9e9e9e";
    }
  };

  const qualityMs = () => {
    switch (quality()) {
      case ConnectionQuality.Excellent:
        return "<50ms";
      case ConnectionQuality.Good:
        return "~150ms";
      case ConnectionQuality.Poor:
        return "~400ms";
      case ConnectionQuality.Lost:
        return "lost";
      default:
        return "—";
    }
  };

  const getHeight = () => {
    if (!props.focus || videoDims().height == 0) return {};
    // Calculate the aspect ratio
    const ratio = videoDims().width / videoDims().height;

    return ratio > 1
      ? { height: `min(var(--vc-w) / ${ratio}, 100%)` }
      : { height: "100%" };
  };

  return (
    <Show when={!isScreenShare() || !isRemoteScreenShareMuted()}>
      <div
        class={
          tile({
            speaking: !isScreenShare() && isSpeaking(),
            video: isVideo() || isScreenShare(),
            fullscreen: voice.fullscreen(),
            ...props,
          }) + (isScreenShare() ? " vc_tile group" : " vc_tile")
        }
        onClick={() => voice.toggleFocus(track)}
        use:floating={{
          // TODO: Conflicts with focusing, maybe only show if clicking name itself
          //   userCard: {
          //     user: user().user!,
          //     member: user().member,
          //   },
          contextMenu: () => (
            <UserContextMenu
              user={user().user!}
              member={user().member}
              inVoice={!isScreenShare()}
              isScreenshare={isScreenShare()}
            />
          ),
        }}
        style={{ ...getHeight() }}
      >
        <Show
          when={isVideo() || isScreenShare()}
          fallback={
            <AvatarOnly>
              <Avatar
                src={user().avatar}
                fallback={user().username}
                size={48}
                interactive={false}
              />
            </AvatarOnly>
          }
        >
          <VideoTrack
            style={{
              "grid-area": "1/1",
              "object-fit": "contain",
              width: "100%",
              height: "100%",
              overflow: "hidden",
            }}
            trackRef={track as TrackReference}
            manageSubscription={true}
            ref={videoRef}
            on:resize={() => {
              setVideoDims({
                height: videoRef?.videoHeight || 0,
                width: videoRef?.videoWidth || 0,
              });
            }}
          />
        </Show>
        <Overlay showOnHover={isScreenShare()}>
          <OverlayInner>
            <OverflowingText>{user().username}</OverflowingText>
            <Row gap="md">
              {/* Per-participant media-E2EE lock (slice 6.5 §4.4): MLS member
                  ⇒ lock (filled if user-verified, outline if not); SFU
                  participant absent from the verified roster ⇒ loud slashed
                  lock. Same iconography family as slice-5 chat verification.
                  Shown only on an E2EE call (a lock exists in the roster). */}
              <ParticipantLock
                identity={participant.identity}
                userId={participantUserId(participant.identity)}
              />
              {isScreenShare() ? (
                <Show when={isScreenShareAudioUserMuted()}>
                  <Symbol
                    size={18}
                    color={
                      isScreenShareAudioUserMuted() === "by-user"
                        ? "var(--md-sys-color-error)"
                        : undefined
                    }
                  >
                    no_sound
                  </Symbol>
                </Show>
              ) : (
                <VoiceStatefulUserIcons
                  userId={participantUserId(participant.identity)}
                  muted={isMuted()}
                  camera={isVideo()}
                />
              )}
            </Row>
          </OverlayInner>
          <PingBadge style={{ color: qualityColor() }}>
            <PingDot style={{ background: qualityColor() }} />
            {qualityMs()}
          </PingBadge>
        </Overlay>
      </div>
    </Show>
  );
}

export const tile = cva({
  base: {
    display: "grid",
    aspectRatio: "16/9",
    transition: "all .3s ease, width 0s, height 0s",
    borderRadius: "var(--borderRadius-lg)",
    width: "var(--vc-tile-width)",
    maxWidth: "calc(var(--vc-h) * 16 / 9)",
    cursor: "pointer",

    color: "var(--md-sys-color-on-surface)",
    background: "#0002",

    overflow: "hidden",
    outlineWidth: "3px",
    outlineStyle: "solid",
    outlineOffset: "-3px",
    outlineColor: "transparent",
  },
  variants: {
    speaking: {
      true: {
        outlineColor: "var(--md-sys-color-primary)",
      },
    },
    focus: {
      true: {
        width: "auto",
        maxWidth: "none",
      },
    },
    video: {
      true: {},
    },
    fullscreen: {
      true: {
        minWidth: "20%",
      },
    },
  },
  compoundVariants: [
    {
      video: [false],
      focus: [true],
      css: {
        height: "100%",
        maxHeight: "calc(var(--vc-w) * 9 / 16)",
      },
    },
    {
      video: [true],
      focus: [true],
      css: {
        aspectRatio: "auto",
      },
    },
  ],
});

const AvatarOnly = styled("div", {
  base: {
    gridArea: "1/1",
    display: "grid",
    placeItems: "center",
    overflow: "hidden",

    // TODO: Refactor the avatar component to be reactive later.
    "& > *": {
      width: "auto !important",
      height: "30% !important",
      minHeight: "48px",
    },
  },
});

const Overlay = styled("div", {
  base: {
    minWidth: 0,
    gridArea: "1/1",

    padding: "var(--gap-md) var(--gap-lg)",

    opacity: 1,
    display: "flex",
    alignItems: "end",
    flexDirection: "row",

    transition: "var(--transitions-fast) all",
    transitionTimingFunction: "ease",
  },
  variants: {
    showOnHover: {
      true: {
        opacity: 0,

        _groupHover: {
          opacity: 1,
        },
      },
      false: {
        opacity: 1,
      },
    },
  },
  defaultVariants: {
    showOnHover: false,
  },
});

const OverlayInner = styled("div", {
  base: {
    minWidth: 0,
    flexGrow: 1,

    display: "flex",
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",

    _first: {
      flexGrow: 1,
    },
  },
});

const PingBadge = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "10px",
    fontWeight: 600,
    padding: "2px 5px",
    borderRadius: "4px",
    background: "rgba(0,0,0,0.45)",
    flexShrink: 0,
    alignSelf: "flex-end",
    marginLeft: "var(--gap-sm)",
  },
});

const PingDot = styled("div", {
  base: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    flexShrink: 0,
  },
});

/**
 * Per-participant media-E2EE lock (slice 6.5 §4.4). Reads the session's
 * verified MLS roster + the non-enrolled set (native-computed) via the Voice
 * store. Renders nothing on a plain call (no lock in the roster).
 */
function ParticipantLock(props: { identity: string; userId: string }) {
  const voice = useVoice();

  const member = () =>
    voice
      .callRoster()
      .members.find((m) => `${m.user_id}:${m.device_id}` === props.identity);
  const nonEnrolled = () => voice.callNonEnrolled().includes(props.identity);

  return (
    <Show when={voice.callMode() && voice.callMode()!.kind !== "off"}>
      <Show
        when={member()}
        fallback={
          <Show when={nonEnrolled()}>
            <Symbol size={16} color="var(--md-sys-color-error)">
              no_encryption
            </Symbol>
          </Show>
        }
      >
        <Symbol
          size={16}
          color={
            member()!.user_verified
              ? "var(--md-sys-color-primary)"
              : "var(--md-sys-color-outline)"
          }
        >
          {member()!.user_verified ? "verified_user" : "lock"}
        </Symbol>
      </Show>
    </Show>
  );
}

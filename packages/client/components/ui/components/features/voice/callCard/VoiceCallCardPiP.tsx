import { createMemo, Show } from "solid-js";
import {
  TrackLoop,
  TrackReference,
  TrackReferenceOrPlaceholder,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useTrackRefContext,
  useTracks,
  VideoTrack,
} from "solid-livekit-components";

import { Track } from "livekit-client";
import { styled } from "styled-system/jsx";

import { useUser } from "@revolt/markdown/users";
import { useVoice } from "@revolt/rtc";
import { Avatar } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import {
  dropLegPlaceholders,
  isScreenLeg,
  participantUserId,
  stripLeg,
} from "../participantIdentity";

import { CameraEffectNotice } from "./CameraEffectNotice";
import { VoiceCallCardActions } from "./VoiceCallCardActions";
import { VoiceCallCardStatus } from "./VoiceCallCardStatus";

/**
 * How many people the PiP names before it folds the rest into a "+N" chip.
 *
 * ONE ROW is the constraint, not the count. The card is a fixed 300x170 and
 * `VoiceCallCardStatus pip` is absolutely positioned over its top-left
 * corner, so a roster that wrapped would either run under that glyph or push
 * the controls off the bottom edge. Four 56px columns plus the chip is what
 * fits across 300px once the card's own padding is taken out.
 */
const PIP_ROSTER_LIMIT = 4;

export function VoiceCallCardPiP() {
  const voice = useVoice();
  const allAudTracks = useTracks(
    [{ source: Track.Source.Microphone, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  // A screen leg never publishes a microphone, so `withPlaceholder` gives it a
  // phantom Microphone row — a second, permanently-muted avatar in the PiP
  // strip for someone already there (plan §6.2).
  const audTracks = createMemo(() => dropLegPlaceholders(allAudTracks()));

  const shownTracks = createMemo(() => audTracks().slice(0, PIP_ROSTER_LIMIT));
  const hiddenCount = () => audTracks().length - shownTracks().length;

  /**
   * Whether the PiP may draw this screen share as video (plan decision A).
   * `MiniVideo` is a `manageSubscription` VideoTrack, which SUBSCRIBES the
   * track the moment it is visible, so drawing an unwatched share here would
   * bypass the Watch gate; it gets the roster instead.
   *
   * Our own participant's share (a desktop sharing its own screen) is local
   * media with nothing to subscribe, so it is drawn.
   *
   * Our own device's screen leg is NEVER drawn, watched or not. It is a
   * separate SFU participant, so drawing it would subscribe the phone to its
   * own full-rate share: the download `ParticipantTile`'s `SelfLegPlaceholder`
   * exists to avoid, and one that `RoomAudioManager`'s explicit-unsubscribe
   * effect (`sharesToUnsubscribe`, which always drops a self leg) fights. Auto
   * focus already skips the leg, but a manual click on its tile still focuses
   * it. Compared by DEVICE, as `isSelfLeg` is in `ParticipantTile`: another
   * of our devices' legs is a remote share and still needs a Watch.
   */
  const isDrawableShare = (track: TrackReferenceOrPlaceholder) => {
    const identity = track.participant.identity;
    if (track.participant.isLocal) return true;
    if (
      isScreenLeg(identity) &&
      stripLeg(identity) === voice.room()?.localParticipant.identity
    )
      return false;
    return voice.isWatchingShare(identity);
  };

  const hasFocusVideo = () => {
    const track = voice.focusTrack();
    if (!track) return false;

    if (track.source === Track.Source.ScreenShare)
      return isDrawableShare(track);

    return !useIsMuted({
      participant: track.participant,
      source: Track.Source.Camera,
    })();
  };

  return (
    <MiniCard>
      <VoiceCallCardStatus pip />
      {/* The card has none of the full card's notices, but this one says
          why the camera just went off, so it is shown here too. */}
      <NoticeOverlay>
        <CameraEffectNotice />
      </NoticeOverlay>
      <Show when={!hasFocusVideo()} fallback={<MiniVideoTile />}>
        <Roster>
          <TrackLoop tracks={shownTracks}>{() => <ConnectedUser />}</TrackLoop>
          <Show when={hiddenCount() > 0}>
            <MoreChip>+{hiddenCount()}</MoreChip>
          </Show>
        </Roster>
      </Show>
      <VoiceCallCardActions size="xs" />
    </MiniCard>
  );
}

function ConnectedUser() {
  const participant = useEnsureParticipant();

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  });

  const isSpeaking = useIsSpeaking(participant);
  const user = useUser(participantUserId(participant.identity));

  return (
    <Member>
      <UserIcon speaking={isSpeaking()}>
        <Avatar size={28} src={user().avatar} fallback={user().username} />
      </UserIcon>
      {/* The mute state is a SIBLING of the avatar, never a layer over it.
          Drawn on top (the old behavior) it hid the very face that says who
          is muted, and a hidden avatar beside a visible one reads as a badge
          on the NEIGHBOR — every muted person looked like the person next to
          them. Stacked between the avatar and the name, at 12px, it can only
          mean the column it is in. */}
      <MuteSlot>
        <Show when={isMuted()}>
          <Symbol size={12} color="var(--md-sys-color-error)">
            mic_off
          </Symbol>
        </Show>
      </MuteSlot>
      <Name speaking={isSpeaking()}>{user().username}</Name>
    </Member>
  );
}

function MiniVideoTile() {
  const voice = useVoice();

  return (
    <TrackLoop tracks={() => [voice.focusTrack()!]}>
      {() => <MiniVideo />}
    </TrackLoop>
  );
}

function MiniVideo() {
  const track = useTrackRefContext();

  return (
    <VideoTrack
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        "border-radius": "inherit",
        "object-fit": "cover",
        overflow: "hidden",
      }}
      trackRef={track as TrackReference}
      manageSubscription={true}
    />
  );
}

/**
 * Holds the camera effect notice over the top of the card. Over it, not in
 * the column: the card is a fixed 300x170, and a notice in the flow would
 * push the controls, hang up among them, out of the bottom edge. Laid over
 * the top it covers the status glyph and part of the roster until it is
 * dismissed, and the controls stay where they are.
 *
 * Positioned against the float, as the status glyph and the video are, and
 * above the video, which comes later in the card. Empty, it has no height
 * and takes no clicks.
 */
const NoticeOverlay = styled("div", {
  base: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
  },
});

/**
 * The strip of people. Centered in whatever height is left between the status
 * glyph and the controls, and deliberately `nowrap` — see `PIP_ROSTER_LIMIT`.
 */
const Roster = styled("div", {
  base: {
    flexGrow: 1,
    minHeight: 0,
    width: "100%",

    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "nowrap",
    gap: "var(--gap-sm)",

    // Clears the absolutely-positioned status glyph in the top-left corner.
    paddingBlockStart: "var(--gap-l)",
  },
});

/** One person: avatar stacked over their name. */
const Member = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",

    width: "56px",
    minWidth: 0,
  },
});

const UserIcon = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,
    color: "#fffb",
  },
  variants: {
    speaking: {
      true: {
        // `Avatar` renders an <svg> root, so the ring goes on that rather
        // than on this wrapper — an outline here would sit a pixel out from
        // the circle on the corners.
        "& svg": {
          outlineOffset: "1px",
          outline: "2px solid var(--md-sys-color-primary)",
          borderRadius: "var(--borderRadius-circle)",
        },
      },
      false: {},
    },
  },
});

/**
 * The mute row, ALWAYS rendered — its height is reserved whether or not the
 * glyph is in it.
 *
 * Collapsing the row when someone is unmuted makes their column shorter than
 * a muted neighbor's, so the strip both misaligns and jumps every time anyone
 * touches their mic. A muted person is the one thing this card must not be
 * twitchy about. The height is one `Name` line, so a column is the same
 * 28 + 2 + 12 + 2 + 12 tall for everybody.
 */
const MuteSlot = styled("div", {
  base: {
    height: "12px",
    flexShrink: 0,

    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
});

/**
 * The truncating name line.
 *
 * 🔴 NOT `styled(OverflowingText, …)`, though it is the same three rules.
 * Composing `styled()` over another component EVALUATES that component at
 * module scope, and this module sits in an import cycle, so the reference
 * resolves in the temporal dead zone: the whole bundle dies on boot with
 * `ReferenceError: Cannot access 'xr' before initialization` and the app
 * renders a blank page. `ParticipantTile` gets away with `OverflowingText`
 * because it only names it INSIDE JSX, which is deferred past module init.
 * Caught by a preview build, 2026-09-22 — tsc, eslint and the production
 * build itself are all green on it.
 *
 * `width: 100%` is what makes it truncate at all: as a shrink-to-fit child of
 * a centered column its box is its content, so a long username grew the
 * column instead of ellipsizing inside it — over the neighbor, on a card with
 * no room to give.
 */
const Name = styled("div", {
  base: {
    width: "100%",
    textAlign: "center",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",

    fontSize: "0.625rem",
    lineHeight: "1.2",
    fontWeight: 600,
    color: "var(--md-sys-color-on-secondary-container)",
  },
  variants: {
    speaking: {
      true: {
        color: "var(--md-sys-color-primary)",
      },
      false: {},
    },
  },
});

/**
 * Stand-in for everyone past `PIP_ROSTER_LIMIT`.
 *
 * The bottom margin is the alignment, not spacing: it stands in for the two
 * lines this chip does not have (`MuteSlot` and `Name`, 12px each, plus the
 * two 2px column gaps), so that the roster's `center` alignment lands the
 * chip level with the AVATARS. `flex-start` cannot do it — the roster box is
 * much taller than one column, so that pins the chip to the top of the card
 * instead.
 */
const MoreChip = styled("div", {
  base: {
    display: "grid",
    placeItems: "center",
    alignSelf: "center",
    marginBlockEnd: "28px",
    flexShrink: 0,

    width: "28px",
    height: "28px",
    borderRadius: "var(--borderRadius-circle)",

    // Outlined rather than filled: the card is already
    // `secondary-container`, and every surface container in the Sloga dark
    // ramp is within a shade of it, so a fill alone leaves no chip visible at
    // all — just a number floating beside the avatars.
    background: "var(--md-sys-color-surface-container-highest)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "0.625rem",
    fontWeight: 600,
  },
});

const MiniCard = styled("div", {
  base: {
    userSelect: "none",

    pointerEvents: "all",
    width: "100%",
    height: "100%",

    display: "flex",
    alignItems: "center",
    flexDirection: "column",
    justifyContent: "end",

    gap: "var(--gap-sm)",
    padding: "var(--gap-md)",

    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-secondary-container)",
  },
});

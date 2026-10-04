import {
  For,
  Show,
  createMemo,
  onCleanup,
  splitProps,
  untrack,
} from "solid-js";
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
import { useClient } from "@revolt/client";
import { CONFIGURATION, useDevice } from "@revolt/common";
import { useUser } from "@revolt/markdown/users";
import { InRoom, useVoice } from "@revolt/rtc";
import {
  type DraggedVoiceParticipant,
  VOICE_MOVE_MIME,
  draggedVoiceParticipant,
  setDraggedVoiceParticipant,
} from "@revolt/rtc/voiceMoveDrag";
import { canDragParticipant } from "@revolt/rtc/voiceMovePolicy";

import { Avatar, Ripple, livePill, typography } from "../../design";
import { Row } from "../../layout";
import { DisplayName } from "../DisplayName";
import { isSlogaStaff } from "../legacy/Username";

import { dropLegPlaceholders, participantUserId } from "./participantIdentity";

import { VoiceStatefulUserIcons } from "./VoiceStatefulUserIcons";

/**
 * How long a row waits before asking for a member again after the last
 * request for it failed, so pointing at it again does not hammer the API.
 */
const MEMBER_RETRY_MS = 30_000;

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
  const allTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  // A screen leg publishes screen share and nothing else, so `withPlaceholder`
  // synthesizes a Camera placeholder for it — a duplicate avatar for someone
  // this list already shows via their primary (plan §6.2).
  const tracks = createMemo(() => dropLegPlaceholders(allTracks()));

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
          {(participant) => (
            <ParticipantPreview
              participant={participant}
              channel={props.channel}
            />
          )}
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
 * Use a copy of one participant row as the drag image.
 *
 * The browser's own image for the row is drawn over the row's bounds
 * including the pressed ripple, whose circle grows to the row's diagonal; the
 * clip that hides it on screen does not apply there, so the image came out as
 * a square slab of the channel list around the row and read as the whole
 * channel being dragged. The copy has no ripple and nothing around it.
 *
 * It sits exactly over the row, so the frame it may be painted for looks like
 * the row itself; some engines draw nothing for an element off screen.
 */
function setRowDragImage(event: DragEvent, row: HTMLElement) {
  if (!event.dataTransfer) return;

  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true) as HTMLElement;
  ghost.querySelectorAll("md-ripple").forEach((ripple) => ripple.remove());

  Object.assign(ghost.style, {
    position: "fixed",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    boxSizing: "border-box",
    color: getComputedStyle(row).color,
    background: "var(--md-sys-color-surface-container-high)",
    pointerEvents: "none",
  });

  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(
    ghost,
    event.clientX - rect.left,
    event.clientY - rect.top,
  );

  // the image is captured when `dragstart` returns
  setTimeout(() => ghost.remove());
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
      // Flag-gated so a deliberately-dark shell never renders a hint for a
      // feature it cannot join (the release-gate posture).
      watching={
        CONFIGURATION.ENABLE_WATCH_TOGETHER && (state()?.isWatching() ?? false)
      }
      serverId={props.channel.serverId}
      channel={props.channel}
      isLive
    />
  );
}

/**
 * Preview variant of participant
 */
function ParticipantPreview(props: {
  participant: VoiceParticipant;
  channel: Channel;
}) {
  return (
    <CommonUser
      serverId={props.channel.serverId}
      channel={props.channel}
      userId={props.participant.userId}
      speaking={false}
      muted={!props.participant.isPublishing()}
      deafened={!props.participant.isReceiving()}
      camera={props.participant.isCamera()}
      screenshare={screenAudioOnly(props.participant)}
      sharingScreen={props.participant.isScreenVideo()}
      watching={
        CONFIGURATION.ENABLE_WATCH_TOGETHER && props.participant.isWatching()
      }
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
  /** Server owning the previewed channel, for the server-mute badge */
  serverId?: string;
  /** The previewed voice channel: where a drag-to-move starts from */
  channel: Channel;
}) {
  const { t } = useLingui();
  const { isMobile } = useDevice();

  const [iconProps, rest] = splitProps(props, [
    "muted",
    "deafened",
    "camera",
    "screenshare",
    "watching",
  ]);

  const client = useClient();
  const voice = useVoice();
  const user = useUser(() => participantUserId(rest.userId));

  /**
   * This participant as a member of the channel's server (not the route's),
   * the source of their role color. Absent for DM and group calls.
   */
  const member = () =>
    rest.serverId
      ? client().serverMembers.getByKey({
          server: rest.serverId,
          user: participantUserId(rest.userId),
        })
      : undefined;

  const isSelf = () => participantUserId(rest.userId) === client().user?.id;

  /**
   * Whether THIS device is in the previewed call: the same check as
   * `inThisCall()` in `UserContextMenu`.
   */
  const inThisCall = () => {
    const current = voice.channel();
    return !!current && rest.channel.id === current.id;
  };

  /**
   * Whether we outrank this participant in the channel's server.
   *
   * A member the collection only knows as a partial has no roles yet, so its
   * `ranking` reads as the lowest possible and everyone would look superior
   * to it; an uncached one is unknown. Both count as NOT outranked, the same
   * caution as `moderation()` in `UserContextMenu`. This only decides whether
   * the row offers a drag: the server re-checks rank on the move itself.
   */
  const outranksTarget = () => {
    const serverId = rest.channel.serverId;
    const target = member();
    const actor = serverId ? client().servers.get(serverId)?.member : undefined;

    return (
      !!serverId &&
      !!target &&
      !!actor &&
      !client().serverMembers.isPartialByKey({
        server: serverId,
        user: participantUserId(rest.userId),
      }) &&
      target.inferiorTo(actor)
    );
  };

  /**
   * Whether this row can be dragged onto another voice channel. Never on
   * mobile (the menu covers it), and only for a server channel: a move is a
   * server-member edit.
   *
   * Our own row only from the device that is in that call, as the menu does:
   * a device-bound call can only be moved from that device's own session,
   * so from any other session the API refuses it.
   *
   * Never a bot's row: the API refuses to move a bot. A user not loaded yet
   * is not known to be one, so its row is offered and the drop reports the
   * server's refusal.
   */
  const canDrag = () =>
    !!rest.channel.serverId &&
    (!isSelf() || inThisCall()) &&
    canDragParticipant({
      isMobile,
      isSelf: isSelf(),
      canMoveMembersInSource: rest.channel.havePermission("MoveMembers"),
      outranksTarget: outranksTarget(),
      isBot: !!user().user?.bot,
    });

  /** A member request this row has in flight */
  let fetchingTarget = false;
  /** When this row's last member request failed, from `performance.now()` */
  let targetFailedAt: number | undefined;

  /**
   * Load an uncached (or partial) target when a moderator points at the row.
   *
   * Nothing in the voice path fills the member cache, so without this a
   * participant nobody has looked up yet can never be dragged. Asked on hover
   * rather than on render so a moderator browsing a busy server does not fire
   * one request per participant; the row becomes draggable when it lands,
   * because the collection is reactive. One request at a time, and none for
   * `MEMBER_RETRY_MS` after one failed.
   */
  function loadTarget() {
    const serverId = rest.channel.serverId;
    if (isMobile || !serverId || isSelf()) return;
    if (!rest.channel.havePermission("MoveMembers")) return;

    const userId = participantUserId(rest.userId);
    if (
      member() &&
      !client().serverMembers.isPartialByKey({ server: serverId, user: userId })
    )
      return;

    if (fetchingTarget) return;
    if (
      targetFailedAt !== undefined &&
      performance.now() - targetFailedAt < MEMBER_RETRY_MS
    )
      return;

    fetchingTarget = true;
    void client()
      .serverMembers.fetch(serverId, userId)
      .then(
        () => {
          targetFailedAt = undefined;
        },
        () => {
          /* a member we cannot read is one we cannot move; no drag is offered */
          targetFailedAt = performance.now();
        },
      )
      .finally(() => {
        fetchingTarget = false;
      });
  }

  /** The drag this row started, while it is in flight */
  let started: DraggedVoiceParticipant | undefined;

  /**
   * Start dragging this participant toward another voice channel.
   *
   * Stops propagation and NEVER calls `preventDefault()`: the channel row
   * this sits in is a svelte-dnd-action item whose `ondragstart` returns
   * false, which would cancel this drag the moment it reached it.
   *
   * Anything this row may not drag, such as an avatar image pulled by
   * someone without MoveMembers, is left to bubble on to that handler, which
   * cancels it exactly as it did before.
   */
  function onDragStart(event: DragEvent) {
    const serverId = rest.channel.serverId;
    if (!serverId || !event.dataTransfer || !canDrag()) return;

    const userId = participantUserId(rest.userId);
    event.dataTransfer.setData(VOICE_MOVE_MIME, userId);
    event.dataTransfer.effectAllowed = "move";

    started = { userId, fromChannelId: rest.channel.id, serverId };
    setDraggedVoiceParticipant(started);

    setRowDragImage(event, event.currentTarget as HTMLElement);
    event.stopPropagation();
  }

  function onDragEnd() {
    started = undefined;
    setDraggedVoiceParticipant(undefined);
  }

  // `dragend` never reaches a row that unmounted mid-drag (the member left or
  // was moved, or the preview swapped variants), so let go of our own drag
  // here; a newer drag started by another row is not ours to clear.
  onCleanup(() => {
    if (started && untrack(draggedVoiceParticipant) === started) {
      setDraggedVoiceParticipant(undefined);
    }
  });

  /**
   * Pressing a participant must never pick up the channel around it.
   *
   * svelte-dnd-action arms a channel drag from a `mousedown` listener on the
   * channel row, an ancestor of this one, so the press has to stop here,
   * for everyone, draggable or not. That also hides it from the listeners
   * that close menus and popovers on an outside press (`FloatingManager` and
   * friends listen on `document`/`window` in the bubble phase), so replay a
   * bare press to them: the same trick as `dismissFloatingElements`, but
   * bubbling, so the `window` listeners hear it too. The replay starts at
   * `document` and so never reaches the channel row.
   *
   * Native `on:` because Solid's delegated `onMouseDown` runs from `document`,
   * after the channel row's listener has already seen the press.
   */
  function onPress(event: MouseEvent) {
    event.stopPropagation();
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  }

  /**
   * The LIVE badge's hint: the steps left before this share is on screen.
   * Screen shares are opt-in, so even inside the call nothing plays until
   * Watch is pressed. None on our own row, and none once every share of
   * theirs is being watched. The watch set belongs to the call we are in,
   * so it is only consulted when this preview is of that call.
   */
  function liveTooltip() {
    if (isSelf()) return undefined;
    if (!rest.isLive) {
      return {
        placement: "top" as const,
        content: t`Join the call, then press Watch to see their screen`,
      };
    }

    const shares = voice.shareIdentitiesOf(participantUserId(rest.userId));
    if (
      shares.length > 0 &&
      shares.every((identity) => voice.isWatchingShare(identity))
    )
      return undefined;

    return {
      placement: "top" as const,
      content: t`Press Watch to see their screen`,
    };
  }

  return (
    <div
      class={previewUser({ speaking: rest.speaking })}
      draggable={canDrag()}
      on:mousedown={onPress}
      on:dragstart={onDragStart}
      on:dragend={onDragEnd}
      onMouseEnter={loadTarget}
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
            voiceChannel={rest.channel}
          />
        ),
      }}
    >
      <Ripple />
      <Avatar size={24} src={user().avatar} fallback={user().username} />{" "}
      <NameRow>
        <PreviewUsername>
          <DisplayName
            user={user().user}
            member={member()}
            name={
              member()?.displayName ??
              user().user?.displayName ??
              user().username
            }
            brand={isSlogaStaff(user().user)}
          />
        </PreviewUsername>
        <Show when={rest.sharingScreen}>
          {/* No thumbnail: call media is end-to-end encrypted, so nobody
              outside the call holds a key to the frames and the server never
              sees them at all. The badge says that video is live and what to
              do about it; it does not pretend to show what (`liveTooltip`). */}
          <span class={livePill()} use:floating={{ tooltip: liveTooltip() }}>
            <Trans>LIVE</Trans>
          </span>
        </Show>
      </NameRow>
      <Row gap="sm">
        <VoiceStatefulUserIcons
          {...iconProps}
          userId={rest.userId}
          serverId={rest.serverId}
        />
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

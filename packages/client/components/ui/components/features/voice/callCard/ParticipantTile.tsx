import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import {
  TrackReference,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useTrackRefContext,
  VideoTrack,
} from "solid-livekit-components";

import {
  type LocalTrack,
  ConnectionQuality,
  ParticipantEvent,
  Track,
} from "livekit-client";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useClient } from "@revolt/client";
import { useUser } from "@revolt/markdown/users";
import { useVoice } from "@revolt/rtc";
import { shareAudioBadge } from "@revolt/rtc/shareAudioBadge";
import { useState } from "@revolt/state";
import { Avatar } from "@revolt/ui/components/design";
import { Row } from "@revolt/ui/components/layout";
import { OverflowingText } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { DisplayName } from "../../DisplayName";
import { isSlogaStaff } from "../../legacy/Username";
import {
  isScreenLeg,
  participantUserId,
  stripLeg,
} from "../participantIdentity";
import { VoiceStatefulUserIcons } from "../VoiceStatefulUserIcons";

import { AnnotationCapture } from "./AnnotationCapture";
import { AnnotationLayer } from "./AnnotationLayer";
import { ParticipantCaption } from "./ParticipantCaption";
import { RemoteControlCapture } from "./RemoteControlCapture";

type TileProps = {
  focus?: boolean;
};

/** How long the "Ask for a turn" button stays in its confirmed "Asked" state
 *  before re-enabling. Long enough that it reads as sent and not spammable,
 *  short enough that a missed request can be re-raised within the same
 *  stream. */
const RE_ASK_COOLDOWN_MS = 30_000;

/**
 * Individual participant tile
 */
export function ParticipantTile(props: TileProps) {
  const { t } = useLingui();
  const voice = useVoice();
  const state = useState();
  const participant = useEnsureParticipant();
  const track = useTrackRefContext();
  const user = useUser(participantUserId(participant.identity));
  const client = useClient();

  /**
   * This participant as a member of the call's server (not the route's), the
   * source of their nickname and role color. Absent for DM and group calls.
   */
  const callMember = () => {
    const serverId = voice.channel()?.serverId;
    return serverId
      ? client().serverMembers.getByKey({
          server: serverId,
          user: participantUserId(participant.identity),
        })
      : undefined;
  };

  /** The name the tile shows: server nickname, display name, username. */
  const displayName = () =>
    callMember()?.displayName ?? user().user?.displayName ?? user().username;

  let videoRef: HTMLVideoElement | undefined;

  const [videoDims, setVideoDims] = createSignal<{
    height: number;
    width: number;
  }>({ height: 0, width: 0 });

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  });

  const isRemoteScreenShareMuted = useIsMuted({
    participant,
    source: Track.Source.ScreenShare,
  });

  /**
   * The share's audio badge (Android screen share slice 4, Design section 7).
   *
   * `hasAudioPub` comes from the publication itself, never `useIsMuted`:
   * components-core's observer answers `pub?.isMuted ?? true`, so a share with
   * no audio track read as "muted" and showed a mute the viewer could never
   * undo. `participant` is a plain livekit object, so the read is re-run on
   * `sharePubVersion()`, bumped on remote publish and unpublish and on every
   * mute and unmute.
   *
   * The per-user mute is keyed by USER id, the key the context menu writes and
   * `RoomAudioManager` reads, so the badge matches what is actually silenced.
   */
  const shareAudio = createMemo(() => {
    void voice.sharePubVersion();
    const pub = participant.getTrackPublication(Track.Source.ScreenShareAudio);
    return shareAudioBadge({
      hasAudioPub: pub !== undefined,
      pubMuted: pub?.isMuted ?? false,
      userMuted: state.voice.getScreenShareMuted(
        participantUserId(participant.identity),
      ),
    });
  });

  const isVideoMuted = useIsMuted({
    participant,
    source: Track.Source.Camera,
  });

  const isVideo = () => !isVideoMuted();
  const isScreenShare = () => track.source === Track.Source.ScreenShare;

  /**
   * Is this tile the screen share we are currently controlling? The capture
   * surface mounts only then — one live session, one surface, and never on
   * someone else's tile.
   */
  const controlling = () => {
    const session = voice.remoteControl.controlling();
    if (!session) return false;
    return participantUserId(participant.identity) === session.sharerId;
  };

  /**
   * Who is driving THIS screenshare, whoever they are — from the channel-wide
   * redacted `RemoteControlActive`/`Ended` map, so it covers sessions we are
   * not a party to (unlike `controlling()` above, which is only ever us).
   * This is the §2.2 "everyone can see whose turn it is" badge, and the
   * moderator-visibility surface.
   */
  const controlledBy = () => {
    if (!isScreenShare()) return undefined;
    const channelId = voice.channel()?.id;
    if (!channelId) return undefined;
    return voice
      .remoteControlSessions()
      .get(channelId)
      ?.get(participantUserId(participant.identity));
  };
  const controllerUser = useUser(() => controlledBy() ?? "");
  const isSpeaking = useIsSpeaking(participant);

  /**
   * "Ask for a turn" (pass-the-controller slice 2). Shown on someone ELSE's
   * screenshare when this client can actually take control — the same native
   * probe the inbound offer path uses, which also covers the
   * `ENABLE_REMOTE_CONTROL` release gate, so no separate config check here.
   * A request grants nothing; it relays a suggestion the streamer may act on.
   */
  const [rcSupported, setRcSupported] = createSignal(false);
  void voice.remoteControl.supported().then(setRcSupported);
  const [asked, setAsked] = createSignal(false);
  let reAskTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(reAskTimer));

  /**
   * My OWN device's screen leg (Android plan §6.3/§7.3).
   *
   * A leg is a separate SFU participant, so `participant.isLocal` is FALSE on
   * the very tile that shows the phone its own share — every "is this someone
   * else's?" gate below would answer yes. Left alone, the sharer would be
   * offered "ask for control" and "draw" on their own screen, and would lose
   * the sharer-side annotation banner that says who is drawing on it.
   *
   * Compared by DEVICE, not by user: another of my devices' legs is a genuine
   * remote share I may legitimately ask to control.
   */
  const isSelfLeg = () =>
    isScreenLeg(participant.identity) &&
    stripLeg(participant.identity) === voice.room()?.localParticipant.identity;
  /** This tile is mine — my participant, or my own device's screen leg. */
  const isOwnTile = () => participant.isLocal || isSelfLeg();

  /**
   * Click-to-watch (plan decision A). A REMOTE share, including another of
   * my own devices' shares, shows a Watch placeholder until this viewer
   * presses Watch; nothing that needs its video may exist before then. My
   * own share and my own device's leg are exempt: there is nothing to watch.
   */
  const isRemoteShare = () => isScreenShare() && !isOwnTile();
  /** A remote share this viewer is watching right now (reactive). */
  const watchingShare = () =>
    isRemoteShare() && voice.isWatchingShare(participant.identity);
  /** False only for a remote share that is not being watched. */
  const videoAllowed = () => !isRemoteShare() || watchingShare();

  const canAsk = () =>
    isScreenShare() &&
    !isOwnTile() &&
    watchingShare() &&
    // Never on a phone-share tile (plan §7.8): a leg is minted
    // `can_subscribe:false` and holds no session — it could neither see an
    // offer nor accept control, and sharer-side RC is desktop-only by the
    // release gate anyway. The identity IS the tell; no participant
    // attribute needed.
    !isScreenLeg(participant.identity) &&
    rcSupported() &&
    !controlling();

  async function askForTurn() {
    const sharerId = participantUserId(participant.identity);
    // Optimistic: flip to "asked" immediately so a double-click cannot fire a
    // second request. A real failure (not a 429, which MEANS "you asked too
    // often" and should stay asked) rolls it back so they can retry.
    setAsked(true);
    const status = await voice.requestControlTurn(sharerId);
    // 204 relayed; 429 means "asked too often" — both leave the button in its
    // asked state. Anything else (a real error, or the network failure that
    // surfaces as `undefined`) rolls back so they can try again.
    const ok = status === 204 || status === 429;
    if (!ok) {
      setAsked(false);
      return;
    }
    // Re-enable after a cooldown rather than locking for the whole stream: the
    // streamer may have missed the first raised hand (panel closed), and the
    // server's `control_request` bucket deliberately has headroom for a
    // re-ask. The cooldown keeps a heckler from spamming while still letting a
    // genuine second ask through.
    clearTimeout(reAskTimer);
    reAskTimer = setTimeout(() => setAsked(false), RE_ASK_COOLDOWN_MS);
  }

  /**
   * Screen-share annotation (tech-support mode §2). `canDraw` mirrors the
   * server-enforced consent: the draw affordance appears only while this
   * sharer's allowlist names us — and never while we are CONTROLLING this
   * share (the z20 RC capture surface keeps exclusive input). The server
   * refuses regardless; the mirror only drives the UI.
   */
  const [drawMode, setDrawMode] = createSignal(false);
  const sharerUserId = () => participantUserId(participant.identity);
  const canDraw = () =>
    isScreenShare() &&
    !isOwnTile() &&
    watchingShare() &&
    !controlling() &&
    voice.annotations.mayDraw(sharerUserId(), voice.annotations.localUserId);
  // Consent revoked (or the share/control state changed): leave draw mode
  // immediately — the surface must not sit armed over a tile it may no
  // longer draw on.
  createEffect(() => {
    if (!canDraw()) setDrawMode(false);
  });
  /** Sharer side: the DISTINCT annotators with live ink on MY OWN share —
   *  §2.4 says the sharer sees WHO, and a last-batch-wins name would
   *  mis-attribute concurrent helpers' ink to whoever flushed last. */
  const activeAnnotatorIds = () => {
    if (!isOwnTile() || !isScreenShare()) return [];
    // Keyed by the PRIMARY: the server resolves an annotation's
    // `target_identity` through the voice-identity mapping, which knows only
    // primaries, so ink aimed at a phone share arrives under the owner's
    // identity (plan §6.5).
    const batches = voice.annotations.batches.get(
      stripLeg(participant.identity),
    );
    if (!batches) return [];
    return [...new Set(batches.map((batch) => batch.annotatorId))];
  };
  const activeAnnotatorId = () => activeAnnotatorIds().at(0);
  const activeAnnotator = useUser(() => activeAnnotatorId() ?? "");
  /** Sharer side: is my allowlist non-empty (the revoke affordance gate)? */
  const hasAllowedAnnotators = () =>
    isOwnTile() &&
    isScreenShare() &&
    (voice.annotations.consent.get(voice.annotations.localUserId)?.length ??
      0) > 0;

  /**
   * Whether THIS tile's video publication is subscribed. Only consulted for
   * the controlled screenshare (it gates the capture surface below); every
   * tile still tracks it because the callback is also the mount-time report
   * of the current state, and a controlled tile can mount already
   * unsubscribed.
   */
  const [feedSubscribed, setFeedSubscribed] = createSignal(true);
  /**
   * An unwatched share mounts no `<VideoTrack>`, and unmounting one reports
   * nothing, so the last report (and the last frame size) would outlive a
   * Stop watching. Reset both: the feed counts as lost until a re-mounted
   * `<VideoTrack>` reports its own state, and a focused placeholder is not
   * sized to the video it no longer shows.
   */
  createEffect(() => {
    if (videoAllowed()) return;
    setFeedSubscribed(false);
    setVideoDims({ height: 0, width: 0 });
  });
  /** The feed is flowing AND this viewer may see it (click-to-watch). */
  const feedLive = () => videoAllowed() && feedSubscribed();

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

  /**
   * Real round-trip time to the SFU, in ms.
   *
   * RTT is a property of a peer connection, so the only one we can actually
   * measure is OUR OWN link to the server — a remote participant's RTT to the
   * SFU is not observable from this client. It is therefore polled only on the
   * local tile; remote tiles fall back to LiveKit's quality bucket (below).
   *
   * My own screen leg counts as mine, but it is a SEPARATE peer connection
   * owned by the native plugin and publishes no mic or camera, so the read
   * below finds no publication and leaves the badge on the quality bucket.
   * That is the honest answer: this client genuinely cannot measure the leg's
   * link, and claiming the WebView's RTT for it would be a fabricated number.
   */
  const [rttMs, setRttMs] = createSignal<number>();

  if (isOwnTile()) {
    const readRtt = async () => {
      const pub =
        participant.getTrackPublication(Track.Source.Microphone) ??
        participant.getTrackPublication(Track.Source.Camera);
      // `track` is typed as the abstract base here; only Local/RemoteTrack
      // expose the stats report.
      const track = pub?.track as LocalTrack | undefined;
      if (!track) return setRttMs(undefined);

      try {
        const report = await track.getRTCStatsReport();
        if (!report) return;

        // Prefer the nominated ICE candidate pair (transport-level RTT).
        // `remote-inbound-rtp.roundTripTime` is the RTCP-derived fallback for
        // browsers that don't surface candidate-pair stats off a sender — it is
        // what VoiceStatsOverlay already reads.
        let candidatePair: number | undefined;
        let remoteInbound: number | undefined;
        // The members below are real on the relevant stat types but absent
        // from the base `RTCStats` DOM lib type; widen to exactly those
        // rather than to `any`, so the typeof guards still mean something.
        type RttStat = RTCStats & {
          nominated?: boolean;
          currentRoundTripTime?: number;
          roundTripTime?: number;
        };
        report.forEach((stat: RTCStats) => {
          const r = stat as RttStat;
          if (
            r.type === "candidate-pair" &&
            r.nominated &&
            typeof r.currentRoundTripTime === "number"
          ) {
            candidatePair = r.currentRoundTripTime * 1000;
          } else if (
            r.type === "remote-inbound-rtp" &&
            typeof r.roundTripTime === "number"
          ) {
            remoteInbound = r.roundTripTime * 1000;
          }
        });

        const rtt = candidatePair ?? remoteInbound;
        setRttMs(rtt === undefined ? undefined : Math.round(rtt));
      } catch {
        // Stats unavailable on this browser/track — fall back to the bucket.
        setRttMs(undefined);
      }
    };

    readRtt();
    const timer = setInterval(readRtt, 3000);
    onCleanup(() => clearInterval(timer));
  }

  /**
   * Badge text: a measured number where one exists, otherwise LiveKit's
   * coarse quality bucket named as what it is. This deliberately no longer
   * prints a millisecond figure for remote participants — the previous
   * "<50ms"/"~150ms"/"~400ms" strings were hardcoded per bucket and were never
   * measurements of anything.
   */
  const qualityLabel = () => {
    const ms = rttMs();
    if (ms !== undefined) return `${ms}ms`;

    switch (quality()) {
      case ConnectionQuality.Excellent:
        return "Excellent";
      case ConnectionQuality.Good:
        return "Good";
      case ConnectionQuality.Poor:
        return "Poor";
      case ConnectionQuality.Lost:
        return "Lost";
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
            // A Watch placeholder sizes like an avatar tile, not a video.
            video: (isVideo() || isScreenShare()) && videoAllowed(),
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
              member={callMember()}
              inVoice={!isScreenShare()}
              isScreenshare={isScreenShare()}
            />
          ),
        }}
        style={{ ...getHeight() }}
      >
        <Show
          when={(isVideo() || isScreenShare()) && !isSelfLeg()}
          fallback={
            <Show
              when={isSelfLeg()}
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
              {/* The sharer's own phone never mounts a <VideoTrack> for its
                  own leg (plan §0.9/§7.3b): `manageSubscription` would
                  subscribe and download the full-rate stream just to show
                  the screen showing its screen. A placeholder with the stop
                  affordance is the whole tile. */}
              <SelfLegPlaceholder>
                <Symbol size={32}>screen_share</Symbol>
                <Trans>You're sharing your screen</Trans>
                <StopShareButton
                  onClick={(event: MouseEvent) => {
                    // The tile's own click toggles focus — stopping the
                    // share must not also rearrange the grid.
                    event.stopPropagation();
                    void voice.toggleScreenshare();
                  }}
                >
                  <Trans>Stop sharing</Trans>
                </StopShareButton>
              </SelfLegPlaceholder>
            </Show>
          }
        >
          {/* Click-to-watch (plan decision A): an unwatched remote share
              mounts NO <VideoTrack>. Its visibility observer would subscribe
              the stream the moment the tile is on screen, which is exactly
              what the viewer has not asked for. */}
          <Show
            when={videoAllowed()}
            fallback={
              <WatchPlaceholder>
                <Avatar
                  src={user().avatar}
                  fallback={user().username}
                  size={40}
                  interactive={false}
                />
                <WatchPlaceholderText>
                  <Trans>{displayName()} is sharing their screen</Trans>
                </WatchPlaceholderText>
                <WatchShareButton
                  type="button"
                  aria-label={t`Watch stream from ${displayName()}`}
                  onClick={(event: MouseEvent) => {
                    // The tile's own click toggles focus; watching must not
                    // also rearrange the grid.
                    event.stopPropagation();
                    voice.watchShare(participant.identity);
                  }}
                >
                  <Symbol size={16}>visibility</Symbol>
                  <Trans>Watch stream</Trans>
                </WatchShareButton>
              </WatchPlaceholder>
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
              /* `VideoTrack`'s visibility observer calls `setSubscribed(false)`
                 below 80% visibility after 3s, which FREEZES the last frame
                 with no `ended`, no `pause` and no `stalled` — so scrolling the
                 participant strip would leave a controller injecting against a
                 still image. An immediate hard auto-pause, controller-side, not
                 only a sharer-side concern. Wiring the callback here keeps the
                 `dist/`-shipped submodule untouched.

                 GATED on this tile being the controlled screenshare: the
                 callback is wired on EVERY tile's VideoTrack, so without the
                 gate any camera tile scrolling out of view in a 3+-person call
                 would kill the live capture — a tile can only ever speak for
                 its OWN feed. The stop itself rides the `feedSubscribed` gate
                 on the capture surface's `<Show>` below: unmounting runs the
                 surface's own generation-checked cleanup (release-all
                 included), and a resubscribe remounts it with a fresh capture
                 instead of leaving a dead surface that discards every event. */
              onSubscriptionStatusChanged={(subscribed: boolean) => {
                setFeedSubscribed(subscribed);
                if (!subscribed && isScreenShare() && controlling()) {
                  voice.remoteControl.onFeedLost("unsubscribed");
                }
              }}
              ref={videoRef}
              on:resize={() => {
                setVideoDims({
                  height: videoRef?.videoHeight || 0,
                  width: videoRef?.videoWidth || 0,
                });
              }}
            />
          </Show>
        </Show>
        <Overlay showOnHover={isScreenShare()}>
          <OverlayInner>
            <OverflowingText>
              <DisplayName
                user={user().user}
                member={callMember()}
                name={displayName()}
                brand={isSlogaStaff(user().user)}
              />
            </OverflowingText>
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
                <Switch>
                  {/* The viewer muted this sharer: red, as before slice 4. */}
                  <Match when={shareAudio() === "user-muted"}>
                    <Symbol size={18} color="var(--md-sys-color-error)">
                      no_sound
                    </Symbol>
                  </Match>
                  {/* The sharer muted their share audio: grey, as before. */}
                  <Match when={shareAudio() === "muted"}>
                    <Symbol size={18}>no_sound</Symbol>
                  </Match>
                  {/* No audio track at all. A different glyph from the mute
                      badges, so it does not read as a mute to undo, plus a
                      tooltip that says what it means. */}
                  <Match when={shareAudio() === "no-audio"}>
                    <Symbol
                      size={18}
                      use:floating={{
                        tooltip: {
                          placement: "top",
                          content: t`This screen share has no audio`,
                        },
                      }}
                    >
                      volume_mute
                    </Symbol>
                  </Match>
                </Switch>
              ) : (
                <VoiceStatefulUserIcons
                  userId={participantUserId(participant.identity)}
                  muted={isMuted()}
                  camera={isVideo()}
                  serverId={voice.channel()?.serverId}
                />
              )}
            </Row>
          </OverlayInner>
          <PingBadge style={{ color: qualityColor() }}>
            <PingDot style={{ background: qualityColor() }} />
            {qualityLabel()}
          </PingBadge>
        </Overlay>
        {/* AFTER `<Overlay>`, deliberately: a capture surface placed as a
            sibling before it is hit-test dead across the whole tile, because
            `Overlay` is `gridArea: "1/1"` with no `pointer-events: none` and
            no `z-index`. Mounted only while a session is armed on THIS
            participant's screenshare, so hover chrome and click-to-focus are
            untouched the rest of the time. `feedSubscribed` is part of the
            condition so losing the feed unmounts the surface (its cleanup
            releases everything held) and a resubscribe REMOUNTS it with a
            fresh capture — the surface can only ever capture against video
            that is actually flowing. `feedLive` also requires a remote share
            to be WATCHED, so a Watch placeholder never mounts a capture. */}
        <Show when={isScreenShare() && controlling() && feedLive()}>
          <RemoteControlCapture
            video={videoRef}
            videoDims={videoDims}
            sharerIdentity={participant.identity}
          />
        </Show>
        {/* Annotation ink (tech-support mode §2.5) — the SCREEN-SHARE branch
            on purpose: the whole feature draws on the shared screen, and the
            camera branch was the rev-2 review's whole-feature-defeating
            placement bug. Passive at z5 (the ParticipantCaption precedent):
            above video and hover chrome, below the z8 draw surface and the
            z20 RC capture, never intercepting a click. Renders on EVERY
            viewer's tile for this share, including the sharer's own.

            `stripLeg` because the SERVER resolves an annotation's
            `target_identity` through the voice-identity mapping, which knows
            only primaries — so ink aimed at a phone screen leg is stored under
            the owner's `user:device`, while this tile carries the leg's
            three-segment identity. Without the strip the lookup misses and ink
            never renders on a phone share at all (plan §6.5). Same reason on
            the capture surface below, whose batches must be addressed the way
            the server will key them. Not on a Watch placeholder: ink is
            positioned over the video, and there is none. */}
        <Show when={isScreenShare() && videoAllowed()}>
          <AnnotationLayer
            identity={stripLeg(participant.identity)}
            videoDims={videoDims}
          />
        </Show>
        {/* Draw surface — only while this sharer's server-enforced allowlist
            names us, draw mode is on, and no RC session holds the tile. */}
        <Show when={canDraw() && drawMode() && feedLive()}>
          <AnnotationCapture
            video={videoRef}
            videoDims={videoDims}
            sharerIdentity={stripLeg(participant.identity)}
            sharerUserId={sharerUserId()}
            onRefused={() => setDrawMode(false)}
          />
        </Show>
        {/* Sharer side (§2.4): who the server says is drawing on MY share,
            plus the ONE-ACTION revoke — the phishing backstop, deliberately
            a single always-there button rather than list management. Shown
            whenever my allowlist is non-empty, named whenever ink is live. */}
        <Show when={hasAllowedAnnotators()}>
          <DrawingBanner>
            <Symbol size={14}>stylus_note</Symbol>
            <OverflowingText>
              <Show
                when={activeAnnotatorIds().length > 1}
                fallback={
                  <Show
                    when={activeAnnotatorId()}
                    fallback={<Trans>People can draw on your screen</Trans>}
                  >
                    <Trans>
                      {activeAnnotator().username} is drawing on your screen
                    </Trans>
                  </Show>
                }
              >
                <Trans>Several people are drawing on your screen</Trans>
              </Show>
            </OverflowingText>
            <StopDrawingButton
              onClick={(e) => {
                e.stopPropagation();
                void voice.channel()?.revokeAnnotators();
              }}
            >
              <Trans>Stop all drawing</Trans>
            </StopDrawingButton>
          </DrawingBanner>
        </Show>
        {/* Channel-wide control indicator (§2.2). ALWAYS visible while a
            session is live on this share — unlike the hover chrome, because
            its whole job is that nobody has to hover to notice someone is
            driving. Suppressed for the active controller only: while WE are
            driving, the capture chrome already says so, and the badge would
            sit over the top-left of the very screen being driven (where the
            menus live). After `Overlay` so it stacks above the hover
            gradient; `pointer-events: none` (in the styles) keeps
            click-to-focus and the capture surface's hit-testing untouched. */}
        <Show when={controlledBy() && !controlling()}>
          <ControlledByBadge>
            <Symbol size={14}>arrow_selector_tool</Symbol>
            <OverflowingText>
              <Trans>Controlled by {controllerUser().username}</Trans>
            </OverflowingText>
          </ControlledByBadge>
        </Show>
        {/* Viewer actions on someone else's share — Draw and "Ask for a
            turn" — share ONE top-right stack. The tile's bottom edge is off
            limits: when a focused share fills the card, the card's own
            chrome (status bottom-left, actions bottom-center, theater and
            fullscreen bottom-right) occupies the same pixels, and a
            bottom-anchored chip lands exactly on the corner buttons. After
            `Overlay` so the stack sits above the hover gradient; the
            stack's zIndex clears the z8 draw surface so "Stop drawing"
            stays clickable mid-draw. Once asked, the turn button becomes a
            non-interactive confirmation — the streamer decides, and
            re-asking is rate-limited server-side anyway. Stop watching joins
            the stack on every watched remote share (plan decision A). */}
        <Show when={canDraw() || canAsk() || watchingShare()}>
          <TileCornerStack>
            <Show when={canDraw()}>
              <DrawToggleButton
                data-active={drawMode() ? "" : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  setDrawMode(!drawMode());
                }}
              >
                <Symbol size={14}>stylus_note</Symbol>
                <Show when={drawMode()} fallback={<Trans>Draw</Trans>}>
                  <Trans>Stop drawing</Trans>
                </Show>
              </DrawToggleButton>
            </Show>
            <Show when={canAsk()}>
              <AskTurnButton
                data-asked={asked() ? "" : undefined}
                disabled={asked()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!asked()) void askForTurn();
                }}
              >
                <Symbol size={14}>pan_tool</Symbol>
                <Show when={asked()} fallback={<Trans>Ask for a turn</Trans>}>
                  <Trans>Asked</Trans>
                </Show>
              </AskTurnButton>
            </Show>
            <Show when={watchingShare()}>
              <StopWatchingButton
                type="button"
                aria-label={t`Stop watching stream from ${displayName()}`}
                onClick={(event: MouseEvent) => {
                  // The tile's own click toggles focus; leave the grid alone.
                  event.stopPropagation();
                  voice.stopWatchingShare(participant.identity);
                }}
              >
                <Symbol size={14}>visibility_off</Symbol>
                <Trans>Stop watching</Trans>
              </StopWatchingButton>
            </Show>
          </TileCornerStack>
        </Show>
        <Show when={!isScreenShare()}>
          <ParticipantCaption identity={participant.identity} />
        </Show>
      </div>
    </Show>
  );
}

export const tile = cva({
  base: {
    display: "grid",
    /**
     * Pin the single stacking track to the tile instead of letting it size to
     * its content. Everything in here sits in cell 1/1 (video, avatar,
     * overlay), and the implicit track is `auto` — which grows to the video's
     * max-content height, `width / <source ratio>`. The `<video>`'s own
     * `height: 100%` then resolves against that grown track rather than the
     * tile, so it renders taller than the box and `overflow: hidden` clips the
     * bottom off the picture.
     *
     * Invisible whenever the tile is width-limited, because then the track and
     * the tile come out the same size. It only opens up once the tile is
     * HEIGHT-limited — `getHeight()`'s `min(…, 100%)` clamping, or a source
     * taller than the 16:9 box — and the gap is exactly
     * `width / ratio - height`. An ultrawide viewer is permanently in that
     * regime (a 21:9 report showed 163px of the shared desktop's taskbar cut
     * off; a 32:9 would lose four fifths of the frame), and a portrait phone
     * camera hits it on any monitor.
     *
     * `minmax(0, …)` is the load-bearing half: the `0` floor removes the
     * automatic minimum that otherwise lets the track grow past its container.
     */
    gridTemplateRows: "minmax(0, 1fr)",
    gridTemplateColumns: "minmax(0, 1fr)",
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

/** The sharer's own-leg tile (plan §7.3b): message + stop, no video. */
const SelfLegPlaceholder = styled("div", {
  base: {
    gridArea: "1/1",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-md)",
    overflow: "hidden",
    textAlign: "center",
    padding: "var(--gap-md)",
  },
});

const StopShareButton = styled("button", {
  base: {
    cursor: "pointer",
    padding: "var(--gap-sm) var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
  },
});

/**
 * An unwatched remote share (plan decision A): avatar, who is sharing, and
 * the Watch button. It shares grid cell 1/1 with `Overlay` but comes EARLIER
 * in the DOM (it is the `<Show>` fallback rendered before `<Overlay>`), and
 * `Overlay` is not click-through, so by source order alone `Overlay` would
 * paint on top and swallow the button's clicks. What lifts it is `zIndex: 1`:
 * a grid item with a non-`auto` z-index forms its own stacking context
 * without needing `position`, and `Overlay` has no z-index (at most it sits
 * at level 0, as a stacking context from its hover `opacity`), so the
 * placeholder stacks and hit-tests above it. It passes clicks through
 * everywhere else, so the tile's click-to-focus and context menu still work
 * around the button.
 */
const WatchPlaceholder = styled("div", {
  base: {
    gridArea: "1/1",
    zIndex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-md)",
    minWidth: 0,
    overflow: "hidden",
    textAlign: "center",
    padding: "var(--gap-md)",
    pointerEvents: "none",
  },
});

const WatchPlaceholderText = styled("span", {
  base: {
    maxWidth: "100%",
    overflow: "hidden",
    lineClamp: 2,
    overflowWrap: "anywhere",
  },
});

const WatchShareButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    flexShrink: 0,
    pointerEvents: "auto",
    cursor: "pointer",
    fontWeight: 600,
    padding: "var(--gap-sm) var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    border: "none",
    color: "var(--md-sys-color-on-primary)",
    background: "var(--md-sys-color-primary)",
  },
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

const ControlledByBadge = styled("div", {
  base: {
    gridArea: "1/1",
    justifySelf: "start",
    alignSelf: "start",
    margin: "var(--gap-md)",

    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: 0,
    maxWidth: "calc(100% - 2 * var(--gap-md))",

    fontSize: "10px",
    fontWeight: 600,
    padding: "2px 6px",
    borderRadius: "var(--borderRadius-full)",
    color: "#fff",
    background: "rgba(0,0,0,0.45)",

    pointerEvents: "none",
  },
});

const AskTurnButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",

    fontSize: "11px",
    fontWeight: 600,
    padding: "4px 8px",
    borderRadius: "var(--borderRadius-full)",
    border: "none",
    cursor: "pointer",
    color: "var(--md-sys-color-on-primary)",
    background: "var(--md-sys-color-primary)",

    "&[data-asked]": {
      cursor: "default",
      color: "var(--md-sys-color-on-surface-variant)",
      background: "rgba(0,0,0,0.45)",
    },
  },
});

/**
 * Top-right column holding the viewer's actions on a share (Draw, Ask for a
 * turn, Stop watching). Positioning lives HERE, not on the buttons — see the
 * usage comment for why the tile's bottom edge is off limits.
 */
const TileCornerStack = styled("div", {
  base: {
    gridArea: "1/1",
    justifySelf: "end",
    alignSelf: "start",
    margin: "var(--gap-md)",
    // Above the z8 draw surface so "Stop drawing" stays clickable mid-draw.
    zIndex: 9,

    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "6px",
    pointerEvents: "none",
    "& > *": { pointerEvents: "auto" },
  },
});

const DrawToggleButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",

    fontSize: "11px",
    fontWeight: 600,
    padding: "4px 8px",
    borderRadius: "var(--borderRadius-full)",
    border: "none",
    cursor: "pointer",
    color: "var(--md-sys-color-on-primary)",
    background: "var(--md-sys-color-primary)",

    "&[data-active]": {
      color: "#fff",
      background: "rgba(0,0,0,0.65)",
    },
  },
});

/** Stop watching a remote share (plan decision A), in `TileCornerStack`. */
const StopWatchingButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",

    fontSize: "11px",
    fontWeight: 600,
    padding: "4px 8px",
    borderRadius: "var(--borderRadius-full)",
    border: "none",
    cursor: "pointer",
    color: "#fff",
    background: "rgba(0,0,0,0.65)",
  },
});

const DrawingBanner = styled("div", {
  base: {
    gridArea: "1/1",
    justifySelf: "center",
    alignSelf: "start",
    margin: "var(--gap-md)",
    zIndex: 9,

    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
    maxWidth: "calc(100% - 2 * var(--gap-md))",

    fontSize: "11px",
    fontWeight: 600,
    padding: "4px 8px",
    borderRadius: "var(--borderRadius-full)",
    color: "#fff",
    background: "rgba(0,0,0,0.65)",
  },
});

const StopDrawingButton = styled("button", {
  base: {
    flexShrink: 0,
    fontSize: "11px",
    fontWeight: 700,
    padding: "2px 8px",
    borderRadius: "var(--borderRadius-full)",
    border: "none",
    cursor: "pointer",
    color: "var(--md-sys-color-on-error)",
    background: "var(--md-sys-color-error)",
  },
});

/**
 * Per-participant media-E2EE lock (slice 6.5 §4.4). Reads the session's
 * verified MLS roster + the non-enrolled set (native-computed) via the Voice
 * store. Renders nothing on a plain call (no lock in the roster).
 */
function ParticipantLock(props: { identity: string; userId: string }) {
  const voice = useVoice();

  // A screen leg (Android plan §6.3) holds no MLS leaf of its own — its key is
  // DERIVED from its owner's, so the owner's lock is the leg's lock. Matching
  // the raw three-segment identity finds nothing in the roster and the share
  // tile renders no badge at all: the one tile where "is this encrypted?" is
  // most asked would be the only one that never answers.
  const ownerIdentity = () => stripLeg(props.identity);

  const member = () =>
    voice
      .callRoster()
      .members.find((m) => `${m.user_id}:${m.device_id}` === ownerIdentity());
  // Both spellings, and the asymmetry is deliberate. A CANONICALIZED leg is
  // reported under its owner (`u:d`); a leg that stayed RAW — an orphan, or
  // one declaring plaintext in an encrypted call (§5.3 rule 2) — is reported
  // under its own identity, and that is precisely the leg that must show the
  // slashed lock.
  const nonEnrolled = () => {
    const set = voice.callNonEnrolled();
    return set.includes(props.identity) || set.includes(ownerIdentity());
  };

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

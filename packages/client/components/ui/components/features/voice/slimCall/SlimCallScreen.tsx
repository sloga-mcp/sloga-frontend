import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";

import { useLingui } from "@lingui-solid/solid/macro";
import { createResizeObserver } from "@solid-primitives/resize-observer";
import { TrackLoop } from "solid-livekit-components";
import { styled } from "styled-system/jsx";

import { useSlimMode } from "@revolt/client/useSlimMode";
import { useWindowCtx } from "@revolt/client/windowCtx";
import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import {
  InRoom,
  cameraBackgroundSupported,
  cameraToneSupported,
  faceFiltersSupported,
  useVoice,
} from "@revolt/rtc";
import {
  type CallAudioRoutes,
  getCallAudioRoutes,
  setCallAudioRoute,
} from "@revolt/rtc/callAudioRoute";
import { type CameraDevice, cameraFlipTarget } from "@revolt/rtc/cameraFlip";
import { Button, IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { CameraEffectNotice } from "../callCard/CameraEffectNotice";
import { ParticipantTile } from "../callCard/ParticipantTile";
import { VoiceCallAudioBlockedBanner } from "../callCard/VoiceCallAudioBlockedBanner";
import {
  VoiceCallCardStatus,
  VoiceCallEncryptionChip,
} from "../callCard/VoiceCallCardStatus";
import { VoiceCallDowngradeBanner } from "../callCard/VoiceCallDowngradeBanner";
import { VoiceCallRecordingBanner } from "../callCard/VoiceCallRecordingBanner";
import { VoiceCallRosterPanel } from "../callCard/VoiceCallRosterPanel";
import { VoiceCallWhisperBanner } from "../callCard/VoiceCallWhisperBanner";
import {
  hasLiveVideo,
  isMutedScreenShare,
  selectCallTiles,
} from "../callCard/callTileSelection";
import { participantUserId } from "../participantIdentity";
import {
  clampCornerPosition,
  isCornerDrag,
  nextSlimCallMinimised,
  slimCallShown,
  slimCallVideoLayout,
} from "./slimCallPolicy";
import { setSlimCallMinimised, slimCallMinimised } from "./slimCallView";

/**
 * The Slim view call screen: a direct message or group call, full screen.
 *
 * It is mounted once at app level and draws nothing until `slimCallShown`
 * says so. The call card asks `slimCallOwnsTiles` the same question with the
 * same four facts and draws nothing while the answer is yes, so the call is
 * always on exactly one of the two.
 *
 * This component also keeps the minimised flag honest. It is always mounted,
 * so it is the one place that sees every call start, end and change of
 * channel, and a new call always starts with the screen up.
 */
export function SlimCallScreen() {
  const slim = useSlimMode();
  const voice = useVoice();
  const floating = useWindowCtx().floatingMount();

  // `inCall` is true from the moment a call is being joined, not from the
  // moment it connects. The card reads it the same way, so one of the two
  // surfaces, and with it a way to hang up, is on screen while joining.
  const shown = createMemo(() =>
    slimCallShown({
      slim: slim(),
      inCall: !!voice.channel(),
      channelType: voice.channel()?.type,
      minimised: slimCallMinimised(),
    }),
  );

  let lastChannelId: string | undefined;
  createEffect(() => {
    const channelId = voice.channel()?.id;
    const minimised = untrack(slimCallMinimised);
    const next = nextSlimCallMinimised({
      minimised,
      inCall: channelId !== undefined,
      channelChanged: channelId !== lastChannelId,
    });
    lastChannelId = channelId;
    if (next !== minimised) setSlimCallMinimised(next);
  });

  // Rendered into the floating layer, next to the dialogs and menus, so its
  // place among them is decided by `zIndex` alone (see `Screen`).
  return (
    <Show when={shown()}>
      <Portal mount={floating}>
        <CallScreen />
      </Portal>
    </Show>
  );
}

/**
 * What the screen shows, top to bottom: who the call is with, the call's own
 * notices, the participants, the controls. They are stacked in the normal
 * flow, so the participants start below the notices and cannot be drawn over
 * them. The notices are the call card's own components, mounted the way the
 * card mounts them: no props, no condition, each deciding for itself whether
 * it has something to show.
 *
 * A direct video call (`Tiles` reports it) is laid out like a phone's own
 * video call instead: the picture runs from the top of the screen to the
 * bottom, and the top and bottom parts lie over it. They are drawn above the
 * picture, never under it, and the stage keeps clear of both by their
 * measured heights, so the tiles' own marks, the corner tile and the roster
 * panel all stay in the part of the picture nothing lies over.
 */
function CallScreen() {
  const voice = useVoice();
  const { t } = useLingui();

  const [video, setVideo] = createSignal(false);
  const [screen, setScreen] = createSignal<HTMLDivElement>();
  const [top, setTop] = createSignal<HTMLDivElement>();
  const [bottom, setBottom] = createSignal<HTMLDivElement>();

  // The heights of the two parts that lie over a video call's picture
  createResizeObserver(top, (_rect, el) =>
    screen()?.style.setProperty(
      "--slim-top",
      `${(el as HTMLElement).offsetHeight}px`,
    ),
  );
  createResizeObserver(bottom, (_rect, el) =>
    screen()?.style.setProperty(
      "--slim-bottom",
      `${(el as HTMLElement).offsetHeight}px`,
    ),
  );

  const title = () => {
    const channel = voice.channel();
    return channel?.recipient?.displayName ?? channel?.displayName ?? "";
  };

  return (
    <Screen ref={setScreen}>
      <Top ref={setTop} video={video()}>
        <Header video={video()}>
          <IconButton
            size="md"
            variant="standard"
            aria-label={t`Minimize call`}
            onPress={() => setSlimCallMinimised(true)}
          >
            <Symbol>keyboard_arrow_down</Symbol>
          </IconButton>
          <Title>{title()}</Title>
          <VoiceCallCardStatus />
        </Header>
        <Notices>
          <ChipRow video={video()}>
            <VoiceCallEncryptionChip />
          </ChipRow>
          <VoiceCallDowngradeBanner />
          <VoiceCallAudioBlockedBanner />
          <VoiceCallRecordingBanner />
          <VoiceCallWhisperBanner />
          {/* Last, so the notices above keep their places when it comes and
              goes. Here and not in a snackbar: this is the one place a call
              on this screen is sure to show it. */}
          <CameraEffectNotice />
        </Notices>
      </Top>
      <Stage video={video()}>
        <StageInner>
          {/* Opened by a press on the chip above. It lies over the tiles. */}
          <VoiceCallRosterPanel />
          <Tiles onVideo={setVideo} />
        </StageInner>
      </Stage>
      <Bottom ref={setBottom} video={video()}>
        <Controls />
      </Bottom>
    </Screen>
  );
}

/** Never more than three tiles across. */
const GRID_MAX_COLUMNS = 3;
/** The narrowest a tile gets before the grid scrolls instead. */
const GRID_MIN_TILE_WIDTH = 160;
/** `var(--gap-md)` in px. Only used to compare arrangements. */
const GRID_GAP = 8;
/** How much wider the tiles must get before fewer columns are taken. */
const GRID_NARROWER_MARGIN = 1.05;
/** The tile width used until the area has been measured. */
const TILE_FALLBACK_WIDTH = "min(100%, 250px)";
/** livekit-client `Track.Source.ScreenShare`, as `callTileSelection` reads it. */
const SCREEN_SHARE_SOURCE = "screen_share";
/** The closest a dragged corner tile gets to the edges of its area, in px. */
const CORNER_MARGIN = 8;

/**
 * The participants. Every tile is the call card's `ParticipantTile`, fed by
 * the same `TrackLoop` and the same `selectCallTiles` choice the card makes,
 * so a tile looks and behaves here as it does there (a press on one puts it
 * in the large box, a second press puts it back).
 *
 * Only the arrangement is this screen's own: the card's grid is sized for a
 * card in a channel page, this one for a whole phone or tablet screen. Every
 * participant gets a tile; the card's "hide participants without video"
 * setting is not applied, because this screen has no control to undo it.
 *
 * A direct call with a camera on is arranged like a phone's video call
 * instead (`slimCallVideoLayout`): the other side's picture fills the area
 * edge to edge and this device's own tile sits in the top right corner. A
 * press on the corner tile swaps the two, through the same focus the large
 * box uses. The corner tile can be dragged anywhere in the area, and hidden
 * and brought back; hiding it only takes it off this screen, the camera
 * keeps sending.
 */
function Tiles(props: { onVideo: (video: boolean) => void }) {
  const voice = useVoice();
  const { t } = useLingui();

  const [area, setArea] = createSignal<HTMLDivElement>();
  const [size, setSize] = createSignal({ width: 0, height: 0 });

  const [cornerHidden, setCornerHidden] = createSignal(false);
  /** Where the user dragged the corner tile to, and the tile's size then. */
  const [cornerAt, setCornerAt] = createSignal<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>();

  // The tiles size themselves from these two properties
  createResizeObserver(area, ({ width, height }) => {
    const el = area();
    if (!el) return;
    el.style.setProperty("--vc-w", `${width}px`);
    el.style.setProperty("--vc-h", `${height}px`);
    setSize({ width, height });
  });

  const selection = createMemo(() =>
    selectCallTiles(voice.vidTracks(), {
      hideNonVideo: false,
      isFocused: (track) => voice.isFocus(track),
      participantOf: (track) => participantUserId(track.participant.identity),
    }),
  );

  /** Everyone except the tile in the large box. */
  const gridTracks = () => selection().tiles;

  const focused = () => !!voice.focusTrack();

  /** Every tile the call has, the focused one included. */
  const allTracks = createMemo(() =>
    voice.vidTracks().filter((track) => !isMutedScreenShare(track)),
  );

  /** The two tiles of the video layout, or `undefined` for the plain one. */
  const videoLayout = createMemo(() => {
    const tracks = allTracks();
    const layout = slimCallVideoLayout({
      channelType: voice.channel()?.type,
      tiles: tracks.map((track) => ({
        own: track.participant.isLocal,
        liveVideo: hasLiveVideo(track),
        screenShare: (track.source as string) === SCREEN_SHARE_SOURCE,
        focused: voice.isFocus(track),
      })),
      cornerHidden: cornerHidden(),
    });
    return layout
      ? { main: tracks[layout.main], corner: tracks[layout.corner] }
      : undefined;
  });

  // The screen arranges its top and bottom parts around the answer
  createEffect(() => props.onVideo(!!videoLayout()));

  /**
   * Hide the corner tile, or bring it back. Either way a swap is undone
   * first: hidden, there is nothing to swap with, and the tile comes back as
   * this device's own picture.
   */
  function showCorner(show: boolean) {
    if (untrack(voice.focusId)) voice.toggleFocus();
    setCornerHidden(!show);
  }

  /** The corner tile's place once it has been dragged, kept inside the area. */
  const cornerStyle = () => {
    const at = cornerAt();
    if (!at) return undefined;
    const { width, height } = size();
    // The tile's size follows the area's, so after a turn of the phone it is
    // the size it has now that counts, not the one it had when dragged
    const { x, y } = clampCornerPosition({
      x: at.x,
      y: at.y,
      width: cornerEl?.offsetWidth || at.width,
      height: cornerEl?.offsetHeight || at.height,
      areaWidth: width,
      areaHeight: height,
      margin: CORNER_MARGIN,
    });
    return { left: `${x}px`, top: `${y}px`, right: "auto" };
  };

  // A drag of the corner tile. A press that stays put is left alone, and
  // reaches the tile as the press that swaps the two pictures; one that
  // travels moves the tile, and the click that ends it is swallowed.
  let drag:
    | {
        pointer: number;
        fromX: number;
        fromY: number;
        x: number;
        y: number;
        width: number;
        height: number;
        moved: boolean;
      }
    | undefined;
  let swallowClick = false;
  let cornerEl: HTMLDivElement | undefined;

  /**
   * The corner tile's own listeners, in the capture phase so they run
   * before anything inside the tile. Every new press starts clean: a drag by
   * finger ends without a click, and the click it was waiting to swallow
   * must not be the next press on the hide button.
   */
  function cornerMounted(el: HTMLDivElement) {
    cornerEl = el;
    el.addEventListener("pointerdown", () => (swallowClick = false), true);
    el.addEventListener("click", cornerClick, true);
  }

  function cornerDown(event: PointerEvent & { currentTarget: HTMLElement }) {
    const areaEl = area();
    if (!areaEl || (event.pointerType === "mouse" && event.button !== 0))
      return;
    const box = event.currentTarget.getBoundingClientRect();
    const areaBox = areaEl.getBoundingClientRect();
    swallowClick = false;
    drag = {
      pointer: event.pointerId,
      fromX: event.clientX,
      fromY: event.clientY,
      x: box.left - areaBox.left,
      y: box.top - areaBox.top,
      width: box.width,
      height: box.height,
      moved: false,
    };
  }

  function cornerMove(event: PointerEvent & { currentTarget: HTMLElement }) {
    if (!drag || drag.pointer !== event.pointerId) return;
    // A mouse button let go outside the tile: that press is over
    if (event.pointerType === "mouse" && event.buttons === 0) {
      drag = undefined;
      return;
    }
    const dx = event.clientX - drag.fromX;
    const dy = event.clientY - drag.fromY;
    if (!drag.moved) {
      if (!isCornerDrag(dx, dy)) return;
      drag.moved = true;
      swallowClick = true;
      try {
        // Keeps the moves coming when the finger outruns the tile
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone; the drag ends with it
      }
    }
    setCornerAt({
      x: drag.x + dx,
      y: drag.y + dy,
      width: drag.width,
      height: drag.height,
    });
  }

  function cornerUp(event: PointerEvent) {
    if (drag?.pointer === event.pointerId) drag = undefined;
  }

  /** In the capture phase, so the tile under the pointer never hears it. */
  function cornerClick(event: MouseEvent) {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  }

  // A swap is kept as the focus. When the video layout stops applying (both
  // cameras off, the other side gone) the focus goes with it, so the plain
  // grid comes back and not a large box nobody asked for.
  createEffect(
    on(
      () => !!videoLayout(),
      (applies, applied) => {
        if (applied && !applies && untrack(voice.focusId)) voice.toggleFocus();
      },
      { defer: true },
    ),
  );

  // The tile in the large box left the call: back to the plain grid. The
  // card does the same while it is the one drawing the tiles.
  createEffect(() => {
    if (voice.focusId() && !voice.focusTrack()) voice.toggleFocus();
  });

  /**
   * The width of one tile in the plain grid, as a CSS length. Every
   * arrangement from three columns down to one is tried, and the one that
   * makes the tiles widest while all rows still fit the height wins. On a
   * phone held upright that stacks the two sides of a direct call.
   */
  const tileWidth = () => {
    const count = gridTracks().length;
    const { width, height } = size();
    if (focused() || !count || !width || !height) return TILE_FALLBACK_WIDTH;

    let columns = 1,
      rows = count,
      best = 0;

    // Widest first, so a narrower arrangement has to beat it
    for (let c = Math.min(count, GRID_MAX_COLUMNS); c >= 1; c--) {
      const r = Math.ceil(count / c);
      const fit = Math.min(
        (width - (c - 1) * GRID_GAP) / c,
        Math.max(
          GRID_MIN_TILE_WIDTH,
          ((height - (r - 1) * GRID_GAP) / r) * (16 / 9),
        ),
      );

      if (fit > best * GRID_NARROWER_MARGIN) {
        best = fit;
        columns = c;
        rows = r;
      }
    }

    // The browser does the exact sum against the real gap. The 1px keeps a
    // width of exactly one third from wrapping a tile onto its own row.
    const gaps = (n: number) => (n > 1 ? ` - ${n - 1} * var(--gap-md)` : "");
    return (
      `min((100%${gaps(columns)} - 1px) / ${columns}, ` +
      `max(${GRID_MIN_TILE_WIDTH}px, (var(--vc-h)${gaps(rows)}) * 16 / 9 / ${rows}))`
    );
  };

  return (
    <TileArea
      ref={setArea}
      focused={focused() && !videoLayout()}
      video={!!videoLayout()}
    >
      <InRoom>
        <Show
          when={videoLayout()}
          fallback={
            <>
              <Show when={voice.focusTrack()}>
                <TrackLoop tracks={() => [voice.focusTrack()!]}>
                  {() => (
                    <FocusBox>
                      <ParticipantTile focus />
                    </FocusBox>
                  )}
                </TrackLoop>
              </Show>
              <Show when={gridTracks().length > 0}>
                <Grid
                  strip={focused()}
                  style={{ "--vc-tile-width": tileWidth() }}
                >
                  <TrackLoop tracks={gridTracks}>
                    {() => <ParticipantTile />}
                  </TrackLoop>
                </Grid>
              </Show>
            </>
          }
        >
          <TrackLoop tracks={() => [videoLayout()!.main]}>
            {() => (
              <VideoMain>
                <ParticipantTile />
              </VideoMain>
            )}
          </TrackLoop>
          <Show
            when={!cornerHidden()}
            fallback={
              <CornerShow
                type="button"
                aria-label={t`Camera Preview`}
                onClick={() => showCorner(true)}
              >
                <Symbol size={20}>picture_in_picture</Symbol>
              </CornerShow>
            }
          >
            <TrackLoop tracks={() => [videoLayout()!.corner]}>
              {() => (
                <VideoCorner
                  ref={cornerMounted}
                  style={cornerStyle()}
                  onPointerDown={cornerDown}
                  onPointerMove={cornerMove}
                  onPointerUp={cornerUp}
                  onPointerCancel={cornerUp}
                  onLostPointerCapture={cornerUp}
                >
                  <ParticipantTile />
                  <CornerHide
                    type="button"
                    aria-label={t`Hide`}
                    onPointerDown={(event: PointerEvent) =>
                      event.stopPropagation()
                    }
                    onClick={() => showCorner(false)}
                  >
                    <Symbol size={16}>visibility_off</Symbol>
                  </CornerHide>
                </VideoCorner>
              )}
            </TrackLoop>
          </Show>
        </Show>
      </InRoom>
    </TileArea>
  );
}

/**
 * The controls. Mute, camera and hang up do what the call card's buttons do,
 * with the card's labels: the same store calls, the same conditions. They are
 * written out here because the card exports its controls only as one whole
 * bar, sized for a pointer. Speaker and flip camera exist only here. Effects
 * opens the same panel the card's button opens.
 */
function Controls() {
  const voice = useVoice();
  const modals = useModals();
  const { t } = useLingui();

  const enableVideo = CONFIGURATION.ENABLE_VIDEO;

  const [routes, setRoutes] = createSignal<CallAudioRoutes>({
    supported: false,
  });
  const [flipTarget, setFlipTarget] = createSignal<CameraDevice>();
  const [flipBusy, setFlipBusy] = createSignal(false);
  const [routeBusy, setRouteBusy] = createSignal(false);

  // An answer that arrives after a newer question was asked, or after the
  // screen went away, is dropped.
  let alive = true,
    routeRead = 0,
    flipRead = 0;
  onCleanup(() => (alive = false));

  /** Ask the phone which output has the call sound. */
  async function readRoutes() {
    const read = ++routeRead;
    const answer = await getCallAudioRoutes();
    if (alive && read === routeRead) setRoutes(answer);
  }

  /** Ask which camera a flip would switch to, if any. */
  async function readFlipTarget() {
    const read = ++flipRead;
    const room = untrack(voice.room);
    const target =
      room && untrack(voice.video) ? await cameraFlipTarget(room) : undefined;
    if (alive && read === flipRead) setFlipTarget(target);
  }

  function refresh() {
    void readRoutes();
    void readFlipTarget();
  }

  // Both answers can change with the call, with the camera, and with what
  // the call is allowed to send, so each of those asks again.
  createEffect(
    on(
      [
        voice.room,
        voice.state,
        voice.video,
        () => voice.callBanner(),
        () => voice.callEncryptionChip(),
      ],
      refresh,
    ),
  );

  // A headset or a camera that was plugged in or taken away, and coming
  // back to the app after changing either in the system settings.
  const mediaDevices =
    typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (mediaDevices && typeof mediaDevices.addEventListener === "function") {
    mediaDevices.addEventListener("devicechange", refresh);
    onCleanup(() => mediaDevices.removeEventListener("devicechange", refresh));
  }
  document.addEventListener("visibilitychange", refresh);
  onCleanup(() => document.removeEventListener("visibilitychange", refresh));

  /**
   * Switch the call sound to the other output. What the button shows
   * afterwards is what the phone says is on, not what was asked for: a
   * refused switch leaves the button as it was.
   */
  async function toggleSpeaker() {
    if (routeBusy()) return;
    setRouteBusy(true);
    try {
      await setCallAudioRoute(
        routes().route === "speaker" ? "earpiece" : "speaker",
      );
      await readRoutes();
    } finally {
      setRouteBusy(false);
    }
  }

  /**
   * Flip to the other camera. The store does the switch, under the same
   * rules as every other change to what the call sends, and reports a
   * failure itself, so a refused flip shows nothing more here.
   */
  async function flip() {
    if (flipBusy()) return;
    setFlipBusy(true);
    try {
      await voice.flipCamera();
    } finally {
      setFlipBusy(false);
      void readFlipTarget();
    }
  }

  // Whether the effects panel has anything to offer on this device besides
  // its brightness slider. Where it has not (the iPhone app: no tone stage,
  // no backgrounds, no face filters) there is no Effects button. A device
  // does not change its answer, so it is asked once, here, and not on every
  // update of the bar.
  const effectsAvailable =
    cameraToneSupported() ||
    cameraBackgroundSupported() ||
    faceFiltersSupported();

  const effectsOpen = () => modals.isOpen("camera_effects");

  /** Open the effects panel, or close it if it is the one that is open. */
  function toggleEffects() {
    if (effectsOpen()) modals.removeOfType("camera_effects");
    else modals.openModal({ type: "camera_effects" });
  }

  return (
    <Bar>
      <IconButton
        size="md"
        variant={voice.microphone() ? "filled" : "tonal"}
        onPress={() => voice.toggleMute()}
        aria-label={
          voice.speakingPermission
            ? voice.microphone()
              ? t`Mute`
              : t`Unmute`
            : t`Missing permission`
        }
        isDisabled={!voice.speakingPermission}
      >
        <Show when={voice.microphone()} fallback={<Symbol>mic_off</Symbol>}>
          <Symbol>mic</Symbol>
        </Show>
      </IconButton>
      {/* Only where the phone can switch: the Android app, and not while a
          headset has the sound. */}
      <Show when={routes().supported}>
        <IconButton
          size="md"
          variant={routes().route === "speaker" ? "filled" : "tonal"}
          onPress={() => void toggleSpeaker()}
          aria-label={t`Speaker`}
          aria-pressed={routes().route === "speaker"}
          isDisabled={routeBusy()}
        >
          <Symbol>volume_up</Symbol>
        </IconButton>
      </Show>
      <IconButton
        size="md"
        variant={enableVideo && voice.video() ? "filled" : "tonal"}
        onPress={() => {
          if (enableVideo) voice.toggleCamera();
        }}
        aria-label={
          enableVideo
            ? voice.video()
              ? t`Stop camera`
              : t`Start camera`
            : t`Coming soon! 👀`
        }
        // Off while a press is still being carried out (a background effect
        // can take seconds to start): a second press would only queue the
        // opposite of the first.
        isDisabled={!enableVideo || voice.cameraPending()}
      >
        <Symbol>camera_video</Symbol>
      </IconButton>
      {/* Only while the camera is on and there is another camera to go to */}
      <Show when={voice.video() && flipTarget()}>
        <IconButton
          size="md"
          variant="tonal"
          onPress={() => void flip()}
          aria-label={t`Flip camera`}
          isDisabled={flipBusy() || voice.cameraPending()}
        >
          <Symbol>cameraswitch</Symbol>
        </IconButton>
      </Show>
      {/* Only while the camera is on: the panel changes the picture it
          sends. And only where the device can run at least one effect (see
          `effectsAvailable`). The wrapper carries the mark the panel looks
          for, so a press here while the panel is open is this button's to answer (it closes
          the panel) and not also the panel's "pressed outside". `IconButton`
          passes on only the attributes it knows, hence a wrapper, and
          `display: contents` keeps it out of the bar's layout. */}
      <Show when={effectsAvailable && voice.video()}>
        <span data-camera-effects-toggle style={{ display: "contents" }}>
          <IconButton
            size="md"
            variant={effectsOpen() ? "filled" : "tonal"}
            onPress={toggleEffects}
            aria-label={t`Effects`}
            aria-pressed={effectsOpen()}
          >
            <Symbol>wand_stars</Symbol>
          </IconButton>
        </span>
      </Show>
      <Button
        size="md"
        variant="_error"
        onPress={() => voice.disconnect()}
        aria-label={t`End call`}
      >
        <Symbol>call_end</Symbol>
      </Button>
    </Bar>
  );
}

const Screen = styled("div", {
  base: {
    // The same box as the app itself: inside the safe area, below a desktop
    // title bar.
    position: "fixed",
    top: "calc(env(safe-area-inset-top, 0px) + var(--titlebar-height, 0px))",
    left: "env(safe-area-inset-left, 0px)",
    right: "env(safe-area-inset-right, 0px)",
    bottom: "env(safe-area-inset-bottom, 0px)",

    // Over the app, the floating call card (10) and the transcript panel
    // (6). Under the settings page (100) and the dialogs (998), which the
    // call's own notices open, under the menus (999), and under the incoming
    // call popup (9999): a second call can ring while this one is up.
    zIndex: 50,

    display: "flex",
    flexDirection: "column",

    // A very short screen scrolls as a whole, and nothing is cut off
    overflowX: "hidden",
    overflowY: "auto",

    color: "var(--md-sys-color-on-surface)",
    background: "var(--md-sys-color-surface)",
  },
});

/**
 * The top part: who the call is with, and the call's notices. Over a video
 * call's picture it is drawn above the picture, on a dark fade.
 */
const Top = styled("div", {
  base: {
    flexShrink: 0,

    display: "flex",
    flexDirection: "column",
  },
  variants: {
    video: {
      true: {
        position: "relative",
        zIndex: 2,
        paddingBottom: "var(--gap-lg)",
        background: "linear-gradient(to bottom, #000000b3, #00000000)",
      },
      false: {},
    },
  },
});

/** The controls. Over a video call's picture they sit at its bottom edge. */
const Bottom = styled("div", {
  base: {
    flexShrink: 0,
  },
  variants: {
    video: {
      true: {
        position: "relative",
        zIndex: 2,
        // The stage is out of the flow, so nothing else pushes this down
        marginTop: "auto",
        paddingTop: "var(--gap-lg)",
        background: "linear-gradient(to top, #000000b3, #00000000)",
      },
      false: {},
    },
  },
});

const Header = styled("div", {
  base: {
    flexShrink: 0,

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-sm) var(--gap-md)",
  },
  variants: {
    video: {
      true: {
        // Light on the dark fade, whatever the theme. The notices below
        // keep the theme's colours and bring their own backgrounds.
        color: "#fff",
        textShadow: "0 1px 3px #000000b3",
        "--md-sys-color-on-surface": "#fff",
        "--md-sys-color-on-surface-variant": "#ffffffd9",
        "--md-sys-color-outline": "#ffffffb3",
      },
      false: {},
    },
  },
});

const Title = styled("div", {
  base: {
    flex: "1 1 0",
    minWidth: 0,

    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",

    fontSize: "1rem",
    fontWeight: 600,
  },
});

const Notices = styled("div", {
  base: {
    // Never squeezed: the participants below give way instead
    flexShrink: 0,

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "0 var(--gap-md)",
  },
});

const ChipRow = styled("div", {
  base: {
    display: "flex",
    justifyContent: "flex-start",

    // No row, and no gap for it, while there is nothing to say
    "&:empty": {
      display: "none",
    },
  },
  variants: {
    video: {
      true: {
        // The chip has no background of its own, and over a picture it
        // needs one to be read
        alignSelf: "flex-start",
        borderRadius: "var(--borderRadius-full)",
        background: "var(--md-sys-color-surface)",
      },
      false: {},
    },
  },
});

const Stage = styled("div", {
  base: {
    position: "relative",

    flex: "1 1 0",
    minHeight: 0,

    display: "flex",
    flexDirection: "column",
    padding: "var(--gap-md)",
  },
  variants: {
    /**
     * A direct video call: the stage is the whole screen, and what is in it
     * keeps clear of the top and bottom parts lying over it.
     */
    video: {
      true: {
        position: "absolute",
        inset: 0,
        // Its own layer, under the top and bottom parts: nothing in the
        // stage (the roster panel has a z-index) can be drawn over the
        // call's notices
        zIndex: 0,
        padding: 0,
        paddingTop: "var(--slim-top, 0px)",
        paddingBottom: "var(--slim-bottom, 0px)",
      },
      false: {},
    },
  },
});

/** The part of the stage nothing lies over. Anchors the roster panel. */
const StageInner = styled("div", {
  base: {
    position: "relative",

    flex: "1 1 0",
    minHeight: 0,

    display: "flex",
    flexDirection: "column",
  },
});

const TileArea = styled("div", {
  base: {
    position: "relative",
    flex: "1 1 0",
    minHeight: 0,

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",

    // The plain grid scrolls when there are more tiles than fit
    overflowX: "hidden",
    overflowY: "auto",
  },
  variants: {
    focused: {
      true: {
        // The large box takes the height; only the strip under it scrolls
        overflowY: "hidden",
      },
      false: {},
    },
    /** A direct video call: the picture runs past this area, to the edges. */
    video: {
      true: {
        gap: 0,
        overflowX: "visible",
        overflowY: "visible",
      },
      false: {},
    },
  },
});

/**
 * The tile that fills the screen in a direct video call. The tile and its
 * picture set their own size for a grid, inline, so the sizes here are
 * `!important`. The picture is cropped to fill, not letterboxed.
 *
 * The box reaches past its area, up under the screen's top part and down
 * under the controls, by their measured heights. The tile is padded by the
 * same heights, so its name, lock, mute and connection marks stay in the
 * part of the picture nothing lies over; only the picture itself runs the
 * whole way.
 */
const VideoMain = styled("div", {
  base: {
    position: "absolute",
    top: "calc(-1 * var(--slim-top, 0px))",
    bottom: "calc(-1 * var(--slim-bottom, 0px))",
    left: 0,
    right: 0,
    // Its own stacking context, so nothing inside the tile (a live caption
    // has a z-index) is drawn over the corner tile, and the picture's
    // negative z-index stays inside this box
    isolation: "isolate",
    background: "#000",

    "& .vc_tile": {
      position: "relative",
      width: "100% !important",
      maxWidth: "none !important",
      height: "100% !important",
      maxHeight: "none !important",
      aspectRatio: "auto !important",
      borderRadius: 0,
      paddingTop: "var(--slim-top, 0px)",
      paddingBottom: "var(--slim-bottom, 0px)",
      // The picture is behind the tile, so the tile must not tint it, and a
      // frame around the whole screen for "speaking" says nothing in a call
      // of two
      background: "transparent !important",
      outlineColor: "transparent !important",
      // Its marks are read against the picture, or against black while the
      // camera is off, so they are light whatever the theme
      color: "#fff",
      textShadow: "0 1px 3px #000000b3",
      "--md-sys-color-on-surface": "#fff",
      // The padding follows the notices at once, not in the tile's own time
      transition: "none !important",
    },
    "& video": {
      position: "absolute !important",
      inset: 0,
      zIndex: -1,
      width: "100% !important",
      height: "100% !important",
      objectFit: "cover !important",
    },
  },
});

/**
 * The other tile of a direct video call. It starts in the top right corner
 * (the top, because the large tile's name, lock, mute and connection marks
 * are along its bottom edge) and goes wherever the user drags it.
 */
const VideoCorner = styled("div", {
  base: {
    position: "absolute",
    top: "var(--gap-md)",
    right: "var(--gap-md)",
    zIndex: 1,

    // A finger on it drags it; the page under it does not scroll
    touchAction: "none",
    userSelect: "none",

    width: "clamp(88px, 28%, 150px)",
    aspectRatio: "3/4",
    // Never taller than the stage: a clipped picture stops being received
    maxHeight: "calc(100% - 2 * var(--gap-md))",

    borderRadius: "var(--borderRadius-lg)",
    overflow: "hidden",
    boxShadow: "0 2px 12px #0008",
    background: "var(--md-sys-color-surface-container-high)",

    "& .vc_tile": {
      width: "100% !important",
      maxWidth: "none !important",
      height: "100% !important",
      maxHeight: "none !important",
      aspectRatio: "auto !important",
    },
    "& video": {
      objectFit: "cover !important",
    },
  },
});

/** On the corner tile: takes it off the screen. */
const CornerHide = styled("button", {
  base: {
    position: "absolute",
    top: "4px",
    left: "4px",
    // Over everything the tile draws on itself
    zIndex: 10,

    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",

    border: "none",
    borderRadius: "var(--borderRadius-full)",
    cursor: "pointer",
    color: "#fff",
    background: "#00000099",
  },
});

/** Where the corner tile starts, while it is hidden: brings it back. */
const CornerShow = styled("button", {
  base: {
    position: "absolute",
    top: "var(--gap-md)",
    right: 0,
    zIndex: 1,

    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "44px",
    height: "44px",

    border: "none",
    borderRadius: "var(--borderRadius-full) 0 0 var(--borderRadius-full)",
    cursor: "pointer",
    color: "#fff",
    background: "#00000099",
  },
});

const Grid = styled("div", {
  base: {
    // `safe`, so a grid taller than the area starts at its top edge and all
    // of it can be scrolled to.
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "safe center",
    alignContent: "safe center",
    minHeight: "100%",
    gap: "var(--gap-md)",

    "& .vc_tile": {
      minWidth: 0,
    },
  },
  variants: {
    /** Everyone else, in one row under the large box. */
    strip: {
      true: {
        flexShrink: 0,
        flexWrap: "nowrap",
        justifyContent: "flex-start",
        alignContent: "normal",
        height: "clamp(96px, 22%, 160px)",
        minHeight: 0,

        overflowX: "auto",
        overflowY: "hidden",

        "& .vc_tile": {
          flexShrink: 0,
          width: "auto",
          height: "100%",
        },
      },
      false: {},
    },
  },
});

const FocusBox = styled("div", {
  base: {
    height: 0,
    flexGrow: 1,

    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    margin: "0 auto",
    maxWidth: "100%",
  },
});

const Bar = styled("div", {
  base: {
    flexShrink: 0,

    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-lg)",
    padding: "var(--gap-md) var(--gap-lg) var(--gap-lg)",
  },
});

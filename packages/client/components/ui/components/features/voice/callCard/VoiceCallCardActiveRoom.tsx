import { useLingui } from "@lingui-solid/solid/macro";
import { createResizeObserver } from "@solid-primitives/resize-observer";
import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import {
  type TrackReferenceOrPlaceholder,
  TrackLoop,
} from "solid-livekit-components";

import { Track } from "livekit-client";
import { styled } from "styled-system/jsx";

import { InRoom, useVoice } from "@revolt/rtc";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";
import { scrollableStyles } from "@revolt/ui/directives";

import { MinigameChip } from "../minigame/MinigameChip";
import { ParticipantTile, tile } from "./ParticipantTile";
import { VoiceCallAudioBlockedBanner } from "./VoiceCallAudioBlockedBanner";
import { VoiceCallCardActions } from "./VoiceCallCardActions";
import {
  VoiceCallCardStatus,
  VoiceCallEncryptionChip,
} from "./VoiceCallCardStatus";
import { VoiceCallDowngradeBanner } from "./VoiceCallDowngradeBanner";
import { VoiceCallRecordingBanner } from "./VoiceCallRecordingBanner";
import { VoiceCallWhisperBanner } from "./VoiceCallWhisperBanner";
import { VoiceCallRosterPanel } from "./VoiceCallRosterPanel";

/**
 * Call card (active)
 */
export function VoiceCallCardActiveRoom() {
  const voice = useVoice();

  return (
    <View immersive={voice.immersive()}>
      {/* The §3.4 downgrade banner + §4.4 loud chip must remain visible in
          theater/fullscreen too (FE-12) — they render OUTSIDE the chrome
          `<Show>` below, overlaid on the participant grid. In immersive mode
          the chip gets its own overlay copy (the controls-bar instance is
          hidden with the rest of the chrome).

          Both top strips live in ONE stack rather than each pinning itself to
          `top: 0`: a mixed-encryption call that is also being recorded shows
          both, and two independently-absolute strips would sit exactly on top
          of each other — hiding whichever lost. Downgrade goes first because
          it is the blocking one (audio is paused pending a decision); the
          recording notice is informational. */}
      <TopBanners>
        <VoiceCallDowngradeBanner />
        {/* Audio-blocked goes second: downgrade is a decision the user must
            make, audio-blocked is one click and self-clears. Both being up at
            once is real (join muted into a mixed call) and stacks fine. */}
        <VoiceCallAudioBlockedBanner />
        <VoiceCallRecordingBanner />
        <VoiceCallWhisperBanner />
      </TopBanners>
      <VoiceCallRosterPanel />
      {/* The transcript panel is NOT here — it lives in
          `<VoiceTranscriptPanel>` at app level, because it has to outlive both
          the call and this card. See the note in that file. */}
      <Show when={voice.immersive()}>
        <ImmersiveChipOverlay>
          <VoiceCallEncryptionChip />
        </ImmersiveChipOverlay>
      </Show>
      <Participants />
      {/* Dice-roll results flashed over the video (§ /roll → in-call overlay).
          Sits above the tiles in every mode (normal / fullscreen / theater). */}
      <DiceRollOverlay />
      {/* NOTE remote control's panels and its panic handler are NOT mounted
          here. They live in `<RemoteControlOverlays>` at app level
          (`src/Interface.tsx`), because every one of them is a way to STOP a
          live session and this component unmounts the moment the user browses
          to another channel. */}
      {/* Theater mode hides every control; the only chrome is the auto-dimming
          exit button overlaid on the selected window (Escape also exits). */}
      <Show when={!voice.immersive()} fallback={<ImmersiveExit />}>
        <VoiceCallControls>
          <VoiceCallControlHolder right>
            <VoiceCallTheater />
            <VoiceCallFullscreen />
          </VoiceCallControlHolder>
          <VoiceCallCardActions size="sm" />
          <VoiceCallControlHolder left overflow>
            <VoiceCallEncryptionChip />
            <VoiceCallCardStatus />
          </VoiceCallControlHolder>
        </VoiceCallControls>
      </Show>
    </View>
  );
}

function VoiceCallFullscreen() {
  const voice = useVoice();
  return (
    <IconButton
      size="sm"
      variant={"standard"}
      onPress={() => voice.toggleFullscreen()}
    >
      <Show when={voice.fullscreen()} fallback={<Symbol>fullscreen</Symbol>}>
        <Symbol>fullscreen_exit</Symbol>
      </Show>
    </IconButton>
  );
}

/**
 * Enter theater mode: only shown in fullscreen and only when there's a live
 * camera/screen-share to maximize. Picks the currently-focused window, or
 * auto-selects one if nothing is focused yet.
 */
function VoiceCallTheater() {
  const voice = useVoice();
  const { t } = useLingui();

  const hasVideo = () =>
    voice.vidTracks().some((tr) => "publication" in tr && tr.publication);

  return (
    <Show when={voice.fullscreen() && hasVideo()}>
      <IconButton
        size="sm"
        variant={"standard"}
        onPress={() => voice.toggleImmersive()}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`Maximize & hide participants`,
          },
        }}
      >
        <Symbol>open_in_full</Symbol>
      </IconButton>
    </Show>
  );
}

/** Auto-dimming control overlaid in theater mode to bring everyone back. */
function ImmersiveExit() {
  const voice = useVoice();
  const { t } = useLingui();

  return (
    <ImmersiveControls>
      <IconButton
        size="sm"
        variant={"standard"}
        onPress={() => voice.toggleImmersive(false)}
        use:floating={{
          tooltip: {
            placement: "bottom",
            content: t`Exit theater mode`,
          },
        }}
      >
        <Symbol>close_fullscreen</Symbol>
      </IconButton>
    </ImmersiveControls>
  );
}

const TILE_MIN_WIDTH = "250px",
  TILE_MIN_FOCUS_HEIGHT = "100px",
  /**
   * Width of the side column of other participants in the focus layout.
   *
   * Indirected through a custom property so the CONTROLLING case can narrow
   * it per-instance (see `narrowSidebar`) without a second recipe variant —
   * variant-vs-variant width precedence in a Panda recipe depends on
   * declaration order, which is a fragile thing to hang a layout on.
   */
  SIDEBAR_WIDTH = "var(--vc-sidebar-w, min(28%, 260px))",
  /**
   * The controlling column. Every pixel here is aim the controller loses, so
   * it is as narrow as still shows who is on the call: ~8% of a 1920 frame,
   * and 128px in the controller's own 640px float.
   */
  NARROW_SIDEBAR_WIDTH = "min(160px, 20%)",
  /** Card width it takes to earn a side column instead of a bottom strip. */
  SIDEBAR_MIN_CARD_WIDTH = 560,
  /**
   * Never more than three tiles across while they are big. It is a cap on the
   * arrangement we AIM for, not a hard one: the tiles are laid out by flex, so
   * once a crowd has shrunk them well under a third of the card the browser
   * packs more than three onto a row — which is what you want at that size.
   */
  GRID_MAX_COLUMNS = 3,
  /**
   * Smallest a tile may shrink to while filling the card. Past this the grid
   * scrolls instead of shrinking further — a wall of thumbnails too small to
   * make a face out in is worse than a scroll bar.
   */
  GRID_MIN_TILE_WIDTH = 160,
  /**
   * `var(--gap-md)` in px. Only used to CHOOSE an arrangement — the width
   * handed to the tiles is a `min()` the browser evaluates against the real
   * token, so this only has to be close enough to compare layouts.
   */
  GRID_GAP = 8,
  /**
   * How much bigger the tiles have to come out before a narrower arrangement
   * is taken. Two people in a landscape card is near enough a tie between
   * side-by-side and stacked (a 1080x640 card: 532px vs 555px), and stacking
   * two faces down the middle of a wide frame is not what "fill the window"
   * means to anyone looking at it.
   */
  GRID_NARROWER_MARGIN = 1.05;

/**
 * Show a grid of participants
 */
function Participants() {
  const voice = useVoice();
  const { t } = useLingui();

  // Modify this value to get test tracks
  const testTrackCount = 0;

  let callRef: HTMLDivElement | undefined;

  const [callWidth, setCallWidth] = createSignal(0);
  const [callHeight, setCallHeight] = createSignal(0);

  /** A real, unmuted feed rather than a camera-off placeholder. */
  const isLiveVideo = (t: TrackReferenceOrPlaceholder) =>
    "publication" in t && !!t.publication && !t.publication.isMuted;

  /**
   * The tracks that actually get a tile. Everyone in the call carries a camera
   * placeholder, but ParticipantTile drops a muted screen share — counting
   * those would size the grid around a tile that never renders.
   */
  const gridTracks = () =>
    voice
      .vidTracks()
      .filter((t) => t.source !== Track.Source.ScreenShare || isLiveVideo(t));

  /**
   * Fill the card with the tiles instead of pinning them to TILE_MIN_WIDTH:
   * nobody focused (both focus layouts size their own tiles) and at least one
   * live feed worth making big.
   */
  const fill = () => !voice.focusId() && gridTracks().some(isLiveVideo);

  /**
   * Focus layout: everyone else goes into a vertical column down the left and
   * the focused window (typically a screen share) takes all the room that
   * leaves — instead of the focused window sharing its height with a strip.
   *
   * Gated on the CARD's width rather than the viewport's: the card is narrow on
   * a phone, in the docked column and in the floating window, and a side column
   * there would leave the share a sliver. Below the threshold the strip layout
   * is kept as-is. Theater mode hides the others entirely, so it never applies.
   *
   * 🔴 IT NOW APPLIES WHILE CONTROLLING TOO, at a NARROW width — reversing the
   * original rule, because the live matrix (08-04) showed that rule cost the
   * controller more than it saved. It used to read "never while CONTROLLING,
   * at any width: every pixel the column takes is aim they lose." True of a
   * 260px column, but the layout it fell back to is the STRIP, which takes
   * `max(20%, 100px)` of the frame's HEIGHT — on a 1920x1275 frame that is
   * ~20% of the area against ~8% for a 160px column, and it leaves the share
   * letterboxed with dead space beside the tiles rather than filling. So the
   * suppression was spending more aim than the column ever did.
   *
   * The width comes down for the controlling case (`--vc-sidebar-w` below);
   * everything else about the layout is the one already shipped.
   */
  const sidebar = () =>
    !!voice.focusId() &&
    !voice.immersive() &&
    callWidth() >= SIDEBAR_MIN_CARD_WIDTH;

  /**
   * The controlling case of the column: same layout, narrower. `min(160px,
   * 20%)` so it stays usable in the controller's own 640px float (128px)
   * without eating a 1920px frame (160px, ~8%).
   */
  const narrowSidebar = () =>
    sidebar() && !!voice.remoteControl.controlling();

  /**
   * Theater mode WHILE CONTROLLING: the other participants become small
   * thumbnails floating top-left and the shared screen takes the whole
   * frame. The live matrix's finding — the default strip kept 20% of the
   * frame's height along the bottom and the share sat letterboxed beside
   * dead space — is the worst fit exactly here, where every pixel of the
   * tile is a remote desktop the controller is aiming a pointer into.
   *
   * Out of the flow (absolute) rather than a flex row, so the focus box
   * grows to the full frame. The thumbnails sit UNDER the capture surface's
   * `zIndex: 20` and are unclickable while controlling — the same standing
   * rule as every other overlay the surface covers; sizing and exit live on
   * the controller panel.
   */
  const controlOverlay = () =>
    voice.immersive() && !!voice.remoteControl.controlling();

  /**
   * Width of one tile, as a CSS length the tile recipe applies.
   *
   * With a camera or share live and nobody focused the tiles FILL the card:
   * every arrangement from three columns down to one is tried and whichever
   * makes the tiles biggest wins, bounded by the card's height so all the rows
   * fit without scrolling. That lands on 2x2 for four people rather than 3+1,
   * and on three columns of shrinking tiles from five up.
   *
   * A voice-only call keeps the fixed 250px tiles: those are an avatar on a
   * flat background, and blowing one up to half the card only makes the call
   * look emptier.
   *
   * The arrangement is picked here (it needs numbers), but the width itself is
   * handed over as a `min()` over `100%`/`--vc-h` so the browser does the
   * exact arithmetic against the real gap token. The 1px taken off the column
   * term is anti-rounding slack — a width that comes to exactly 100%/3 can
   * still wrap a tile onto its own line.
   */
  const tileWidth = () => {
    if (voice.focusId()) {
      const vidWidth = Math.round(
        100 / (voice.vidTracks().length + testTrackCount),
      );
      return `max(${TILE_MIN_WIDTH}, ${vidWidth}% - var(--gap-md))`;
    }

    const count = gridTracks().length + testTrackCount;
    if (!fill() || !count || !callWidth() || !callHeight())
      return TILE_MIN_WIDTH;

    let columns = 1,
      rows = count,
      best = 0;

    // Widest first, so a narrower arrangement has to actually beat it.
    for (let c = Math.min(count, GRID_MAX_COLUMNS); c >= 1; c--) {
      const r = Math.ceil(count / c);
      const width = Math.min(
        (callWidth() - (c - 1) * GRID_GAP) / c,
        Math.max(
          GRID_MIN_TILE_WIDTH,
          ((callHeight() - (r - 1) * GRID_GAP) / r) * (16 / 9),
        ),
      );

      if (width > best * GRID_NARROWER_MARGIN) {
        best = width;
        columns = c;
        rows = r;
      }
    }

    const gaps = (n: number) => (n > 1 ? ` - ${n - 1} * var(--gap-md)` : "");
    return (
      `min((100%${gaps(columns)} - 1px) / ${columns}, ` +
      `max(${GRID_MIN_TILE_WIDTH}px, (var(--vc-h)${gaps(rows)}) * 16 / 9 / ${rows}))`
    );
  };

  // Clear out any focus when the track that was focused is no longer available;
  // a vanished window also drops theater mode (nothing left to maximize).
  createEffect(() => {
    if (!voice.focusTrack()) {
      voice.toggleFocus();
      voice.toggleImmersive(false);
    }
  });

  onMount(() => {
    createResizeObserver(callRef, ({ width, height }, el) => {
      if (el === callRef) {
        el.style.setProperty("--vc-w", `${width}px`);
        el.style.setProperty("--vc-h", `${height}px`);
        setCallWidth(width);
        setCallHeight(height);
      }
    });
  });

  return (
    <Call
      ref={callRef}
      sidebar={sidebar()}
      class={voice.focusId() ? "" : scrollableStyles()}
    >
      <InRoom>
        <FocusedParticipant sidebar={sidebar()} />
        <Show when={voice.focusId() && !voice.immersive()}>
          <ShowBarButtonHolder sidebar={sidebar()}>
            <div style={{ "margin-bottom": "10px" }}>
              <IconButton
                size="xs"
                variant={"tonal"}
                onPress={() => voice.toggleShowBar()}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: voice.showBar() ? t`Hide Others` : t`Show Others`,
                  },
                }}
              >
                <Show
                  when={voice.showBar()}
                  fallback={
                    <Symbol>
                      {sidebar() ? "keyboard_arrow_right" : "keyboard_arrow_up"}
                    </Symbol>
                  }
                >
                  <Symbol>
                    {sidebar() ? "keyboard_arrow_left" : "keyboard_arrow_down"}
                  </Symbol>
                </Show>
              </IconButton>
            </div>
          </ShowBarButtonHolder>
        </Show>
        <Grid
          /* One layout variant at a time: the column and the strip set the same
             properties to different values, and a recipe merges its variants in
             declaration order — so letting both match would make the layout a
             function of which one is written first in the file. */
          focus={!!voice.focusId() && !sidebar() && !controlOverlay()}
          sidebar={sidebar()}
          overlay={controlOverlay()}
          fill={fill()}
          show={voice.showBar()}
          class={
            sidebar() || controlOverlay()
              ? scrollableStyles({ direction: "y" })
              : voice.focusId()
                ? scrollableStyles({ direction: "x" })
                : ""
          }
          style={{
            "--vc-tile-width": tileWidth(),
            ...(narrowSidebar()
              ? { "--vc-sidebar-w": NARROW_SIDEBAR_WIDTH }
              : {}),
          }}
        >
          <TrackLoop
            tracks={() => voice.vidTracks().filter((t) => !voice.isFocus(t))}
          >
            {() => <ParticipantTile />}
          </TrackLoop>
          <For each={Array(testTrackCount)}>
            {() => (
              <div
                class={tile({ fullscreen: voice.fullscreen() }) + " vc_tile"}
              />
            )}
          </For>
        </Grid>
      </InRoom>
      {/* "Play while you wait": only offered while ALONE in the call, and its
          overlay covers the participant AREA only — inside this relative
          container on purpose, so the controls bar below stays clickable
          mid-game and the card-level banners (z5/z6) stay on top. */}
      <MinigameChip />
    </Call>
  );
}

function FocusedParticipant(props: { sidebar: boolean }) {
  const voice = useVoice();

  const [focusEl, setFocusEl] = createSignal<HTMLDivElement>();
  const [focusSize, setFocusSize] = createSignal({ width: 0, height: 0 });

  createResizeObserver(focusEl, ({ width, height }) =>
    setFocusSize({ width, height }),
  );

  /**
   * Shadow the card-level `--vc-w`/`--vc-h` with the focus area's OWN size, so
   * the focused tile's aspect maths (ParticipantTile's `getHeight`) describes
   * the box it actually sits in. Without it the side column's width still
   * counts as available and the tile comes out taller than its video, which
   * letterboxes the picture inside the tile's own background.
   *
   * ONLY in the side-column layout, where flex gives this box a width of its
   * own (`flexBasis: 0` + `flexGrow`). In the strip layout the box hugs its
   * tile instead (auto margins, no definite width), so its width is partly a
   * function of the tile — feeding that back in as the tile's height input
   * would be circular. There the card-level values are already right.
   */
  createEffect(() => {
    const el = focusEl();
    if (!el) return;

    const { width, height } = focusSize();
    if (props.sidebar && width && height) {
      el.style.setProperty("--vc-w", `${width}px`);
      el.style.setProperty("--vc-h", `${height}px`);
    } else {
      el.style.removeProperty("--vc-w");
      el.style.removeProperty("--vc-h");
    }
  });

  return (
    <Show when={voice.focusTrack()}>
      <TrackLoop tracks={() => [voice.focusTrack()!]}>
        {() => (
          <FocusBox ref={setFocusEl} sidebar={props.sidebar}>
            <ParticipantTile focus />
          </FocusBox>
        )}
      </TrackLoop>
    </Show>
  );
}

/**
 * Transient dice-roll results overlaid on the call video. Reads the Voice
 * store's `diceRolls()` (populated when a server /roll lands in the channel
 * this call is in); each toast auto-removes after DICE_TOAST_MS. Purely
 * informational — `pointer-events: none`, so it never blocks the tiles.
 */
function DiceRollOverlay() {
  const voice = useVoice();

  return (
    <DiceOverlayHolder aria-live="polite">
      <For each={voice.diceRolls()}>
        {(roll) => (
          <DiceToast data-natural={roll.natural}>
            <Symbol size={20}>casino</Symbol>
            <DiceToastBody>
              <DiceToastHeadline>
                <DiceToastName>{roll.username}</DiceToastName> rolled a{" "}
                <DiceToastTotal data-natural={roll.natural}>
                  {roll.total}
                </DiceToastTotal>
              </DiceToastHeadline>
              <DiceToastMeta>
                {roll.notation}
                <Show when={roll.natural}>
                  {" · "}
                  {roll.natural === "crit" ? "Natural 20! 🎉" : "Natural 1"}
                </Show>
              </DiceToastMeta>
            </DiceToastBody>
          </DiceToast>
        )}
      </For>
    </DiceOverlayHolder>
  );
}

const View = styled("div", {
  base: {
    position: "relative",
    minHeight: 0,
    height: "100%",
    width: "100%",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
  },
  variants: {
    // Theater mode: drop the padding/gap so the selected window fills the frame.
    immersive: {
      true: {
        gap: 0,
        padding: 0,
      },
    },
  },
});

/**
 * Holder for the theater-mode exit button, pinned top-right over the maximized
 * window. Kept subtle so it doesn't distract, brightening to full on hover.
 */
const ImmersiveControls = styled("div", {
  base: {
    position: "absolute",
    top: "var(--gap-md)",
    right: "var(--gap-md)",
    zIndex: 4,

    opacity: 0.4,
    transition: "opacity .2s ease",
    _hover: {
      opacity: 1,
    },
  },
});

const VoiceCallControls = styled("div", {
  base: {
    display: "flex",
    flexShrink: "0",
    overflow: "hidden",
    flexDirection: "row-reverse",
  },
});

const VoiceCallControlHolder = styled("div", {
  base: {
    display: "flex",
    flex: "1",
    alignSelf: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
  },
  variants: {
    right: {
      true: {
        justifyContent: "flex-end",
      },
    },
    empty: {
      true: {
        gap: "0px",
        padding: "0px",
      },
    },
    left: {
      true: {
        justifyContent: "flex-start",
      },
    },
    overflow: {
      true: {
        overflow: "hidden",
      },
    },
  },
});

const ShowBarButtonHolder = styled("div", {
  base: {
    height: "0px",
    alignSelf: "center",
    overflow: "visible",
    display: "flex",
    flexDirection: "column-reverse",
  },
  variants: {
    /**
     * In the side-column layout the toggle comes out of the flow (it would
     * otherwise sit between the column and the video as a zero-height item)
     * and pins to the bottom-left corner, so it stays in the same place
     * whether the column is showing or collapsed.
     */
    sidebar: {
      true: {
        position: "absolute",
        left: "var(--gap-md)",
        bottom: "var(--gap-md)",
        zIndex: 3,
        height: "auto",
        alignSelf: "auto",
      },
    },
  },
});

const Call = styled("div", {
  base: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    flexGrow: 1,
    minHeight: 0,
  },
  variants: {
    // Others down the left, focused window filling what's left of the row.
    sidebar: {
      true: {
        flexDirection: "row",
        alignItems: "stretch",
        gap: "var(--gap-md)",
      },
    },
  },
});

const Grid = styled("div", {
  /**
   * No-one focused: a centred grid that wraps, filling the card. `safe` on both
   * centring keywords so a grid taller than the card starts at the top edge
   * instead of overflowing equally in both directions — half of it would be
   * unreachable above the scroll origin.
   *
   * Both focus layouts below turn this into a single line, so they each set
   * `flexWrap`/`minHeight` back themselves.
   */
  base: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "safe center",
    alignContent: "safe center",
    minHeight: "100%",
    gap: "var(--gap-md)",
  },

  variants: {
    focus: {
      true: {
        flexDirection: "column",
        flexWrap: "nowrap",
        // Held over from the base grid, which no longer sets it: without it
        // these tiles stretch to the full width instead of keeping the size
        // their aspect ratio gives them.
        alignItems: "flex-start",
        alignSelf: "stretch",
        width: "auto",
        height: `max(20%, ${TILE_MIN_FOCUS_HEIGHT})`,
        minHeight: 0,
        transition: "height .3s ease",

        "& .vc_tile": {
          width: "auto",
          height: "100%",
        },
      },
    },
    /**
     * The focus layout's side column: a scrolling vertical stack of everyone
     * else, pulled ahead of the focused window with `order` so it lands on the
     * left while the DOM keeps the focused track first.
     */
    sidebar: {
      true: {
        flexDirection: "column",
        flexWrap: "nowrap",
        order: -1,
        alignSelf: "stretch",
        alignItems: "stretch",
        // Top of the column down, not centred: the column scrolls, and a
        // centred overflow puts its first tile above the scroll origin.
        justifyContent: "flex-start",
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        height: "100%",
        minHeight: 0,
        transition: "width .3s ease",

        "& .vc_tile": {
          width: "100%",
          height: "auto",
          maxWidth: "none",
          // Tiles keep their 16:9 box and the column scrolls; without this
          // they would squash to share the card's height between them.
          flexShrink: 0,
        },
      },
    },
    /**
     * Theater mode while remote-controlling: small thumbnails pinned
     * top-left, OUT OF THE FLOW so the focused share takes the entire frame.
     * `zIndex: 3` — under `ImmersiveControls` (4) and the banner strip (5),
     * and under the capture surface's 20, so a remote click over a thumbnail
     * still reaches the shared desktop.
     */
    overlay: {
      true: {
        position: "absolute",
        top: "var(--gap-md)",
        left: "var(--gap-md)",
        zIndex: 3,
        flexDirection: "column",
        flexWrap: "nowrap",
        alignItems: "flex-start",
        justifyContent: "flex-start",
        width: "auto",
        minHeight: 0,
        maxHeight: "calc(100% - 2 * var(--gap-md))",
        gap: "var(--gap-sm)",

        "& .vc_tile": {
          width: "128px",
          height: "auto",
          minWidth: 0,
          maxWidth: "none",
          flexShrink: 0,
        },
      },
    },
    /**
     * Filling the card (no focus, someone's camera or share is live). The tile
     * width computed in `tileWidth` is doing all the work, so the fullscreen
     * tile's `minWidth: 20%` floor has to go: with enough people on screen it
     * would otherwise widen the tiles back out and fit five to a row instead
     * of three. Never set together with `focus`/`sidebar`, which own the tile
     * size in their own layouts.
     */
    fill: {
      true: {
        "& .vc_tile": {
          minWidth: 0,
        },
      },
    },
    // Hiding is per-layout (collapse the strip's height, the column's width),
    // so the styles live in the compound variants below.
    show: {
      false: {},
    },
  },
  /**
   * Hiding collapses whichever axis the active layout owns — so it depends on
   * both variants, which is why it lives here rather than in `show`. Clipping
   * the tiles is left to the scrollable class the JSX already applies (the
   * strip hides overflow-y, the column overflow-x).
   */
  compoundVariants: [
    {
      sidebar: [false],
      show: [false],
      css: {
        height: 0,
      },
    },
    {
      sidebar: [true],
      show: [false],
      css: {
        width: 0,
      },
    },
  ],
});

const FocusBox = styled("div", {
  base: {
    height: 0,
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    margin: "0 auto",
  },
  variants: {
    /**
     * In a row, `height: 0` would collapse the focus area — it grows along the
     * main axis now, so the height comes back and the auto margins go.
     * `flexBasis: 0` + `minWidth: 0` make the width purely flex-driven (exactly
     * the space the column leaves) rather than content-driven, which is what
     * lets it be measured and fed back as the tile's aspect input.
     */
    sidebar: {
      true: {
        height: "100%",
        flexBasis: 0,
        minWidth: 0,
        margin: 0,
      },
    },
  },
});

/**
 * The top-of-call strip stack: whole-call notices that must be seen in every
 * mode, in priority order, never overlapping each other.
 *
 * `pointerEvents: none` on the container with `auto` restored on its children
 * so the empty gap either side of a small chip does not swallow clicks meant
 * for the participant tiles underneath.
 */
const TopBanners = styled("div", {
  base: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",

    pointerEvents: "none",
    "& > *": {
      pointerEvents: "auto",
    },
  },
});

/**
 * Positions the encryption chip's immersive-mode copy (FE-12): theater mode
 * hides all chrome, but an amber/loud encryption state must stay visible.
 */
const ImmersiveChipOverlay = styled("div", {
  base: {
    position: "absolute",
    left: "var(--gap-md)",
    top: "var(--gap-md)",
    zIndex: 5,
  },
});

/** Top-centred stack that holds the transient dice-roll toasts. */
const DiceOverlayHolder = styled("div", {
  base: {
    position: "absolute",
    top: "var(--gap-md)",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 6,

    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--gap-sm)",

    // Informational only — never intercept clicks meant for the tiles/controls.
    pointerEvents: "none",
    maxWidth: "90%",
  },
});

/**
 * A single dice-roll toast. Snackbar-style (inverse surface) so it stays legible
 * over any camera/screen-share frame. `diceRollToast` runs the whole show — fade
 * in, hold ~3s, fade out — matched to DICE_TOAST_MS in rtc/state.tsx.
 */
const DiceToast = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 14px",
    borderRadius: "14px",

    background: "var(--md-sys-color-inverse-surface)",
    color: "var(--md-sys-color-inverse-on-surface)",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
    border: "1px solid transparent",

    // Full-lifecycle animation (enter → hold → exit); `both` keeps the final
    // (faded-out) frame until the node is unmounted.
    animation: "diceRollToast 3400ms ease both",

    "&[data-natural='crit']": {
      borderColor: "#3BA55D",
    },
    "&[data-natural='fumble']": {
      borderColor: "var(--md-sys-color-error)",
    },
  },
});

const DiceToastBody = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    lineHeight: 1.25,
  },
});

const DiceToastHeadline = styled("div", {
  base: {
    fontSize: "0.95rem",
  },
});

const DiceToastName = styled("span", {
  base: {
    fontWeight: "700",
  },
});

const DiceToastTotal = styled("span", {
  base: {
    fontWeight: "800",
    fontSize: "1.05rem",
    "&[data-natural='crit']": {
      color: "#3BA55D",
    },
    "&[data-natural='fumble']": {
      color: "var(--md-sys-color-error)",
    },
  },
});

const DiceToastMeta = styled("div", {
  base: {
    fontSize: "0.7rem",
    opacity: 0.7,
    fontFamily: "monospace",
  },
});

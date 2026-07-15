import { useLingui } from "@lingui-solid/solid/macro";
import { createResizeObserver } from "@solid-primitives/resize-observer";
import { createEffect, For, onMount, Show } from "solid-js";
import { TrackLoop } from "solid-livekit-components";
import { styled } from "styled-system/jsx";

import { InRoom, useVoice } from "@revolt/rtc";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";
import { scrollableStyles } from "@revolt/ui/directives";

import { ParticipantTile, tile } from "./ParticipantTile";
import { VoiceCallCardActions } from "./VoiceCallCardActions";
import {
  VoiceCallCardStatus,
  VoiceCallEncryptionChip,
} from "./VoiceCallCardStatus";
import { VoiceCallDowngradeBanner } from "./VoiceCallDowngradeBanner";
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
          hidden with the rest of the chrome). */}
      <VoiceCallDowngradeBanner />
      <VoiceCallRosterPanel />
      <Show when={voice.immersive()}>
        <ImmersiveChipOverlay>
          <VoiceCallEncryptionChip />
        </ImmersiveChipOverlay>
      </Show>
      <Participants />
      {/* Dice-roll results flashed over the video (§ /roll → in-call overlay).
          Sits above the tiles in every mode (normal / fullscreen / theater). */}
      <DiceRollOverlay />
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
  TILE_MIN_FOCUS_HEIGHT = "100px";

/**
 * Show a grid of participants
 */
function Participants() {
  const voice = useVoice();
  const { t } = useLingui();

  // Modify this value to get test tracks
  const testTrackCount = 0;

  let callRef: HTMLDivElement | undefined;

  const tileWidth = () => {
    if (!voice.focusId()) return TILE_MIN_WIDTH;

    const vidWidth = Math.round(
      100 / (voice.vidTracks().length + testTrackCount),
    );
    return `max(${TILE_MIN_WIDTH}, ${vidWidth}% - var(--gap-md))`;
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
      }
    });
  });

  return (
    <Call ref={callRef} class={voice.focusId() ? "" : scrollableStyles()}>
      <InRoom>
        <FocusedParticipant />
        <Show when={voice.focusId() && !voice.immersive()}>
          <ShowBarButtonHolder>
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
                  fallback={<Symbol>keyboard_arrow_up</Symbol>}
                >
                  <Symbol>keyboard_arrow_down</Symbol>
                </Show>
              </IconButton>
            </div>
          </ShowBarButtonHolder>
        </Show>
        <Grid
          focus={!!voice.focusId()}
          show={voice.showBar()}
          class={voice.focusId() ? scrollableStyles({ direction: "x" }) : ""}
          style={{ "--vc-tile-width": tileWidth() }}
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
    </Call>
  );
}

function FocusedParticipant() {
  const voice = useVoice();

  return (
    <Show when={voice.focusTrack()}>
      <TrackLoop tracks={() => [voice.focusTrack()!]}>
        {() => (
          <FocusBox>
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
});

const Grid = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexWrap: "nowrap",
    justifyContent: "flex-start",
    alignItems: "flex-start",
    alignSelf: "flex-start",
    minHeight: "auto",
    width: "fit-content",
    gap: "var(--gap-md)",
  },

  variants: {
    focus: {
      true: {
        flexDirection: "column",
        flexWrap: "nowrap",
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
    show: {
      false: {
        height: 0,
      },
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

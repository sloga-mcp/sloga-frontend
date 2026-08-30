import { useNavigate } from "@solidjs/router";
import { Show, createSignal, onCleanup } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { nativeScreenShareAvailable, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Button, IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";
import { VoiceCaptionsButton } from "./VoiceCaptionsButton";
import { VoiceDeviceSelector } from "./VoiceDeviceSelector";
import { VoiceGiveControlButton } from "./VoiceGiveControlButton";
import { VoiceRecordButton } from "./VoiceRecordButton";
import { VoiceSoundboardButton } from "./VoiceSoundboardButton";
import { VoiceStatsOverlay } from "./VoiceStatsOverlay";
import { VoiceTranscribeButton } from "./VoiceTranscribeButton";
import { VoiceWatchButton } from "./VoiceWatchButton";

export function VoiceCallCardActions(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const state = useState();
  const navigate = useNavigate();
  const { t } = useLingui();

  const enableVideo = CONFIGURATION.ENABLE_VIDEO;

  // The floating PiP card is a fixed 300px wide — only the essential controls
  // fit there. Secondary controls stay available on the full docked card.
  const compact = () => props.size === "xs";

  // Screen sharing goes through getDisplayMedia on web/desktop, or the native
  // MediaProjection screen leg on the Android shell (screen-leg plan §7.1).
  // A FUNCTION, not a const: the native probe is async, so this must react
  // when it lands rather than reading a stale false forever.
  const screenShareSupported = () =>
    (typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getDisplayMedia === "function") ||
    nativeScreenShareAvailable();

  // The docked bar keeps only the everyday controls visible — mic, camera,
  // camera settings, share (plus give-control while sharing), record, hang up.
  // Everything else starts hidden behind the More button and shows in a
  // floating panel while it is toggled open. Not persisted: every call starts
  // folded, which keeps the bar predictable and the panel one press away.
  const [extrasOpen, setExtrasOpen] = createSignal(false);
  let extrasEl: HTMLDivElement | undefined;

  function onPointerDown(event: PointerEvent) {
    if (extrasEl && !extrasEl.contains(event.target as Node)) {
      setExtrasOpen(false);
      document.removeEventListener("pointerdown", onPointerDown);
    }
  }

  function toggleExtras() {
    if (extrasOpen()) {
      setExtrasOpen(false);
      document.removeEventListener("pointerdown", onPointerDown);
    } else {
      setExtrasOpen(true);
      document.addEventListener("pointerdown", onPointerDown);
    }
  }

  onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));

  return (
    <Actions>
      <Show when={props.size === "xs"}>
        <IconButton
          variant="standard"
          size={props.size}
          onPress={() => {
            navigate(voice.channel()?.path ?? "");
            state.appDrawer()?.setShown(true);
          }}
          use:floating={{
            tooltip: {
              placement: "top",
              content: t`Return to voice channel`,
            },
          }}
        >
          <Symbol>arrow_top_left</Symbol>
        </IconButton>
      </Show>
      <IconButton
        size={props.size}
        variant={voice.microphone() ? "filled" : "tonal"}
        onPress={() => voice.toggleMute()}
        use:floating={{
          tooltip: {
            placement: "top",
            content: voice.speakingPermission
              ? voice.microphone()
                ? t`Mute`
                : t`Unmute`
              : t`Missing permission`,
          },
        }}
        isDisabled={!voice.speakingPermission}
      >
        <Show when={voice.microphone()} fallback={<Symbol>mic_off</Symbol>}>
          <Symbol>mic</Symbol>
        </Show>
      </IconButton>
      {/* Deafen lives in the extras panel on the docked card, but the PiP
          panel does not exist there — keep it inline on the PiP so a deafened
          user browsing other channels can still undeafen in one press. */}
      <Show when={compact()}>
        <DeafenButton size={props.size} />
      </Show>
      <IconButton
        size={props.size}
        variant={enableVideo && voice.video() ? "filled" : "tonal"}
        onPress={() => {
          if (enableVideo) voice.toggleCamera();
        }}
        use:floating={{
          tooltip: {
            placement: "top",
            content: enableVideo
              ? voice.video()
                ? t`Stop camera`
                : t`Start camera`
              : t`Coming soon! 👀`,
          },
        }}
        isDisabled={!enableVideo}
      >
        <Symbol>camera_video</Symbol>
      </IconButton>
      <Show when={!compact()}>
        <CameraSettingsButton size={props.size} />
      </Show>
      <IconButton
        size={props.size}
        variant={
          enableVideo && screenShareSupported() && voice.screenshare()
            ? "filled"
            : "tonal"
        }
        onPress={() => {
          if (enableVideo && screenShareSupported()) voice.toggleScreenshare();
        }}
        use:floating={{
          tooltip: {
            placement: "top",
            content: !enableVideo
              ? t`Coming soon! 👀`
              : !screenShareSupported()
                ? t`Screen sharing isn't supported on this device`
                : voice.screenshare()
                  ? t`Stop sharing`
                  : t`Share screen`,
          },
        }}
        isDisabled={!enableVideo || !screenShareSupported()}
      >
        <Show
          when={!enableVideo || !screenShareSupported() || voice.screenshare()}
          fallback={<Symbol>screen_share</Symbol>}
        >
          <Symbol>stop_screen_share</Symbol>
        </Show>
      </IconButton>
      {/* "Give control" sits on the sharer's own share, Teams-style, so it
          renders right beside the share button it acts on — it stays out of
          the extras panel on purpose. The component gates itself on
          `CONFIGURATION.ENABLE_VIDEO`, a native command probe, and an
          actually-live screenshare, so it simply is not there on a shell
          that cannot do it. */}
      <Show when={!compact()}>
        <VoiceGiveControlButton size={props.size} />
      </Show>
      {/* Recording stays on the bar rather than in the extras panel: its side
          effect is telling everyone in the call something, and the control
          that both starts and DISCLOSES that should never be hidden. Off the
          compact PiP card though — the 300px card only fits the essentials,
          and a consequential control is a poor candidate for a cramped row
          where it could be hit by accident. */}
      <Show when={!compact()}>
        <VoiceRecordButton size={props.size} />
      </Show>
      <Show when={!compact()}>
        <ExtrasAnchor ref={extrasEl}>
          <Show when={extrasOpen()}>
            <ExtrasPanel>
              <SecondaryControls size={props.size} />
            </ExtrasPanel>
          </Show>
          <IconButton
            size={props.size}
            variant={extrasOpen() ? "filled" : "tonal"}
            onPress={toggleExtras}
            use:floating={{
              tooltip: {
                placement: "top",
                content: t`More call controls`,
              },
            }}
          >
            <Symbol>more_horiz</Symbol>
          </IconButton>
        </ExtrasAnchor>
      </Show>
      <Button
        size={props.size}
        variant="_error"
        onPress={() => voice.disconnect()}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`End call`,
          },
        }}
      >
        <Symbol>call_end</Symbol>
      </Button>
    </Actions>
  );
}

/**
 * Deafen toggle. Renders inline on the compact PiP card and inside the extras
 * panel on the docked card.
 */
function DeafenButton(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const { t } = useLingui();

  return (
    <IconButton
      size={props.size}
      variant={voice.deafen() || !voice.listenPermission ? "tonal" : "filled"}
      onPress={() => voice.toggleDeafen()}
      use:floating={{
        tooltip: {
          placement: "top",
          content: voice.listenPermission
            ? voice.deafen()
              ? t`Undeafen`
              : t`Deafen`
            : t`Missing permission`,
        },
      }}
      isDisabled={!voice.listenPermission}
    >
      <Show
        when={voice.deafen() || !voice.listenPermission}
        fallback={<Symbol>headset</Symbol>}
      >
        <Symbol>headset_off</Symbol>
      </Show>
    </IconButton>
  );
}

/**
 * Opens the camera settings modal. Sits beside the camera toggle.
 */
function CameraSettingsButton(props: { size: "xs" | "sm" }) {
  const modals = useModals();
  const { t } = useLingui();

  return (
    <Show when={CONFIGURATION.ENABLE_VIDEO}>
      <IconButton
        size={props.size}
        variant="tonal"
        onPress={() => modals.openModal({ type: "camera_settings" })}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`Camera settings`,
          },
        }}
      >
        <Symbol>tune</Symbol>
      </IconButton>
    </Show>
  );
}

/**
 * The controls folded behind the More button on the docked call card: deafen,
 * soundboard, watch together, transcription, captions, device switcher and
 * stats. Never on the compact PiP card — the 300px card only fits the
 * essentials, and deafen (the one essential in this set) is rendered inline
 * there instead.
 */
function SecondaryControls(props: { size: "xs" | "sm" }) {
  const voice = useVoice();

  return (
    <>
      <DeafenButton size={props.size} />
      <Show
        when={
          voice.channel()?.serverId &&
          voice.channel()?.havePermission("UseSoundboard")
        }
      >
        <VoiceSoundboardButton size={props.size} />
      </Show>
      {/* Watch together: gates itself on the ENABLE_WATCH_TOGETHER flag +
          the UseWatchTogether bit via watchPolicy. */}
      <VoiceWatchButton size={props.size} />
      <VoiceTranscribeButton size={props.size} />
      <VoiceCaptionsButton size={props.size} />
      <VoiceDeviceSelector size={props.size} />
      <VoiceStatsOverlay size={props.size} />
    </>
  );
}

const Actions = styled("div", {
  base: {
    // Shrinkable on purpose: `maxWidth: 100%` alone only caps the bar at the
    // full controls-row width, so with non-empty side holders there was a
    // band of window widths where the row overflowed (and clipped) before
    // the bar ever hit its cap. Letting the bar shrink converts that
    // pressure into wrapping instead — the side holders have flex-basis 0,
    // so the shrink lands entirely here.
    flexShrink: 1,
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    zIndex: 2,

    display: "flex",
    width: "fit-content",
    // Never spill past the card (and off-screen) — wrap onto another row when
    // the available width can't fit every control.
    maxWidth: "100%",
    flexWrap: "wrap",
    justifyContent: "center",
    alignSelf: "center",

    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container)",
  },
});

// NOTE: intentionally NOT position:relative — same containing-block trick as
// VoiceDeviceSelector. The bar lives inside `VoiceCallControls` which has
// `overflow: hidden`; leaving this static lets the absolute panel resolve its
// containing block to the call Card above the clipping box. The wrapper still
// groups button + panel for click-outside detection.
const ExtrasAnchor = styled("div", {
  base: {
    display: "flex",
  },
});

const ExtrasPanel = styled("div", {
  base: {
    position: "absolute",
    // Fixed offset (not `100%`) because the containing block is the call
    // Card, not this wrapper — sit just above the controls bar.
    bottom: "64px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,

    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    maxWidth: "90%",

    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-highest)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
  },
});

import { useNavigate } from "@solidjs/router";
import { Show } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Button, IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";
import { VoiceStatsOverlay } from "./VoiceStatsOverlay";

export function VoiceCallCardActions(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const state = useState();
  const modals = useModals();
  const navigate = useNavigate();
  const { t } = useLingui();

  const enableVideo = CONFIGURATION.ENABLE_VIDEO;

  // Screen sharing goes through getDisplayMedia on web/desktop. Android WebView
  // has no getDisplayMedia (needs a native MediaProjection plugin), so gate the
  // button on the capability actually being present instead of throwing.
  const screenShareSupported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function";

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
      <Show when={enableVideo}>
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
      <IconButton
        size={props.size}
        variant={
          enableVideo && screenShareSupported && voice.screenshare()
            ? "filled"
            : "tonal"
        }
        onPress={() => {
          if (enableVideo && screenShareSupported) voice.toggleScreenshare();
        }}
        use:floating={{
          tooltip: {
            placement: "top",
            content: !enableVideo
              ? t`Coming soon! 👀`
              : !screenShareSupported
                ? t`Screen sharing isn't supported on this device`
                : voice.screenshare()
                  ? t`Stop sharing`
                  : t`Share screen`,
          },
        }}
        isDisabled={!enableVideo || !screenShareSupported}
      >
        <Show
          when={!enableVideo || !screenShareSupported || voice.screenshare()}
          fallback={<Symbol>stop_screen_share</Symbol>}
        >
          <Symbol>screen_share</Symbol>
        </Show>
      </IconButton>
      <VoiceStatsOverlay size={props.size} />
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

const Actions = styled("div", {
  base: {
    flexShrink: 0,
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    zIndex: 2,

    display: "flex",
    width: "fit-content",
    justifyContent: "center",
    alignSelf: "center",

    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container)",
  },
});

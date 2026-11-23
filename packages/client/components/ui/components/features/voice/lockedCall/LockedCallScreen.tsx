import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { CONFIGURATION } from "@revolt/common";
import { useVoice } from "@revolt/rtc";
import {
  type CallAudioRoutes,
  getCallAudioRoutes,
  setCallAudioRoute,
} from "@revolt/rtc/callAudioRoute";
import { Button, IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { VoiceCallAudioBlockedBanner } from "../callCard/VoiceCallAudioBlockedBanner";
import { VoiceCallEncryptionChip } from "../callCard/VoiceCallCardStatus";
import { VoiceCallDowngradeBanner } from "../callCard/VoiceCallDowngradeBanner";
import { VoiceCallRecordingBanner } from "../callCard/VoiceCallRecordingBanner";

/**
 * The call, as the app lock screen shows it: who it is with, the call's own
 * notices, and the few controls a call needs. No participants, no pictures,
 * and nothing that opens a page or a dialog, because none of those can be
 * seen until the app is unlocked.
 *
 * It is mounted inside the lock screen's layer and draws nothing without a
 * call. Like the other call surfaces it reads `voice.channel()`, which is set
 * from the moment a call is being joined, so a way to hang up is there while
 * joining.
 */
export function LockedCallScreen() {
  const voice = useVoice();

  return (
    <Show when={voice.channel()}>
      <CallSurface />
    </Show>
  );
}

/**
 * What the surface shows, top to bottom: the title, the notices, the
 * controls. The notices are the call card's own components (rule C11),
 * mounted the way the card mounts them: no props, no condition, each deciding
 * for itself whether it has something to show.
 */
function CallSurface() {
  const voice = useVoice();

  // The other side of a direct call, or the name of the group or channel.
  // Nothing else about the call is named here.
  const title = () => {
    const channel = voice.channel();
    return channel?.recipient?.displayName ?? channel?.displayName ?? "";
  };

  return (
    <Surface>
      <Title>{title()}</Title>
      {/* Shown, not pressed: the chip opens the roster panel and the banners
          open dialogs and settings, and none of those is on this screen. */}
      <Notices>
        <ChipRow>
          <VoiceCallEncryptionChip />
        </ChipRow>
        <VoiceCallDowngradeBanner />
        <VoiceCallAudioBlockedBanner />
        <VoiceCallRecordingBanner />
      </Notices>
      <Controls />
    </Surface>
  );
}

/**
 * The controls. Mute, speaker, camera and hang up do what the Slim view call
 * screen's buttons do, with its labels: the same store calls, the same
 * conditions. The camera can only be turned off from here, so its button is
 * there only while the camera is on.
 */
function Controls() {
  const voice = useVoice();
  const { t } = useLingui();

  const enableVideo = CONFIGURATION.ENABLE_VIDEO;

  const [routes, setRoutes] = createSignal<CallAudioRoutes>({
    supported: false,
  });
  const [routeBusy, setRouteBusy] = createSignal(false);

  // An answer that arrives after a newer question was asked, or after the
  // screen went away, is dropped.
  let alive = true,
    routeRead = 0;
  onCleanup(() => (alive = false));

  /** Ask the phone which output has the call sound. */
  async function readRoutes() {
    const read = ++routeRead;
    const answer = await getCallAudioRoutes();
    if (alive && read === routeRead) setRoutes(answer);
  }

  function refresh() {
    void readRoutes();
  }

  // The answer can change with the call and with what the call is allowed
  // to send, so each of those asks again.
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

  // A headset that was plugged in or taken away, and coming back to the app
  // after changing the output in the system settings.
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
      {/* Only while the camera is on: a press turns it off, and it cannot be
          turned back on until the app is unlocked. */}
      <Show when={enableVideo && voice.video()}>
        <IconButton
          size="md"
          variant="filled"
          onPress={() => voice.toggleCamera()}
          aria-label={t`Stop camera`}
        >
          <Symbol>camera_video</Symbol>
        </IconButton>
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

const Surface = styled("div", {
  base: {
    flexShrink: 0,
    width: "min(420px, 100%)",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",

    // Read against the lock screen's dark layer, as the ring's cover is
    color: "var(--md-sys-color-on-surface)",
  },
});

const Title = styled("div", {
  base: {
    maxWidth: "100%",

    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",

    fontSize: "1.5em",
    fontWeight: 600,
    textAlign: "center",
  },
});

const Notices = styled("div", {
  base: {
    flexShrink: 0,

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    textAlign: "start",

    // Nothing in here takes a press, whatever it sets for itself
    pointerEvents: "none",
    "& *": {
      pointerEvents: "none !important",
    },

    // No block, and no gap for it, while there is nothing to say
    "&:empty": {
      display: "none",
    },
  },
});

const ChipRow = styled("div", {
  base: {
    display: "flex",
    justifyContent: "center",

    // No row, and no gap for it, while there is nothing to say
    "&:empty": {
      display: "none",
    },
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
    padding: "var(--gap-md) 0",
  },
});

import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";
import { Button } from "@revolt/ui/components/design";

/**
 * "Click to enable audio" strip — the affordance for the autoplay gate.
 *
 * Under `webAudioMix` every remote participant plays through one shared
 * AudioContext, so a browser that suspends it (no user gesture yet, or sound
 * blocked for the site) silences the WHOLE call. The SDK's only automatic
 * rescue is `startAudio` on mic-publish, which never fires for a listener who
 * joined muted or has no microphone — this button is that user's way out.
 *
 * No debounce, unlike the downgrade banner: this state means the user hears
 * nothing at all, and livekit only emits the failure once playback has
 * actually been refused — there is no transient in/out to smooth over. The
 * banner self-clears via `AudioPlaybackStatusChanged` once playback succeeds,
 * however that happens (this button, or the SDK's own rescue).
 */
export function VoiceCallAudioBlockedBanner() {
  const voice = useVoice();

  return (
    <Show when={voice.audioPlaybackBlocked()}>
      <Banner>
        <Text>
          <Trans>
            Your browser is blocking this call's audio until you interact with
            the page.
          </Trans>
        </Text>
        <Actions>
          <Button
            size="sm"
            variant="text"
            onPress={() => void voice.startCallAudio()}
          >
            <Trans>Enable audio</Trans>
          </Button>
        </Actions>
      </Banner>
    </Show>
  );
}

// Same stacking contract as the other strips: positioning belongs to
// `<TopBanners>` in VoiceCallCardActiveRoom, so simultaneous banners stack
// instead of hiding one another. Tertiary (not error) colours: nothing is
// broken — the browser is waiting for a click, and this is the click.
const Banner = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-md)",

    padding: "var(--gap-md) var(--gap-lg)",
    background: "var(--md-sys-color-tertiary-container)",
    color: "var(--md-sys-color-on-tertiary-container)",
    borderRadius: "var(--borderRadius-lg) var(--borderRadius-lg) 0 0",
  },
});

const Text = styled("div", {
  base: {
    flex: 1,
    minWidth: "180px",
    fontSize: "0.8125rem",
    fontWeight: 500,
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    flexShrink: 0,

    // banner actions: dark app background + the banner's own text colour
    "& button": {
      background: "var(--md-sys-color-surface)",
      "--color": "currentColor",
    },
  },
});

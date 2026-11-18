import { type JSX, Show, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import type { CameraEffectNotice as CameraEffectNoticeKind } from "@revolt/rtc";
import { useVoice } from "@revolt/rtc";
import { Button } from "@revolt/ui/components/design";

/**
 * What each notice says. Keyed by the notice union, so a notice added to the
 * store without its text here does not compile.
 */
const NOTICE_TEXT: Record<CameraEffectNoticeKind, () => JSX.Element> = {
  "background-failed": () => (
    <Trans>
      Background effect could not start. Your camera was turned off.
    </Trans>
  ),
  "effect-failed": () => (
    <Trans>A camera effect could not start and was turned off.</Trans>
  ),
  "effect-slow": () => (
    <Trans>
      An effect was slowing your video and was turned off for this call.
    </Trans>
  ),
  "glam-slow": () => (
    <Trans>Glam was turned off to keep the video smooth.</Trans>
  ),
};

/**
 * Says that a camera effect could not start, and what was done about it.
 *
 * A background (blur or a picture) that cannot start turns the camera off
 * instead of sending the plain picture, so the user has to be told why the
 * camera went dark and given a way out: "Turn off background" drops the
 * background setting, after which the camera can be started again as usual.
 * Any other effect that cannot start is dropped and the camera keeps
 * sending, which only needs saying.
 *
 * It is drawn inside the call surfaces (the call card, its small floating
 * form and the Slim view call screen) and not as a snackbar: snackbars are
 * drawn in the floating layer, which is hidden while the call card is in
 * native fullscreen.
 *
 * Mounted with no props and no condition, like the other call notices: it
 * decides for itself whether it has something to show.
 */
export function CameraEffectNotice() {
  const voice = useVoice();
  const [busy, setBusy] = createSignal(false);

  async function turnOffBackground() {
    if (busy()) return;
    setBusy(true);
    try {
      await voice.turnOffCameraBackground();
    } catch (error) {
      // The store clears the notice only once the background is off, so after
      // a failure it is still up, still true, and the button works again.
      console.error("Could not turn off the camera background", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show when={voice.cameraEffectNotice()}>
      {(notice) => (
        // The region is mounted together with its text. Screen readers often
        // skip a "status" that arrives that way, and always read an "alert",
        // so the notice that the camera went off is the alert.
        <Banner
          role={notice() === "background-failed" ? "alert" : "status"}
          aria-live={notice() === "background-failed" ? "assertive" : "polite"}
          severe={notice() === "background-failed"}
        >
          <Text>{NOTICE_TEXT[notice()]()}</Text>
          <Actions>
            <Show when={notice() === "background-failed"}>
              <Button
                size="sm"
                variant="text"
                isDisabled={busy()}
                onPress={() => void turnOffBackground()}
              >
                <Trans>Turn off background</Trans>
              </Button>
            </Show>
            <Button
              size="sm"
              variant="text"
              onPress={() => voice.dismissCameraEffectNotice()}
            >
              <Trans>Dismiss</Trans>
            </Button>
          </Actions>
        </Banner>
      )}
    </Show>
  );
}

// Same shape as the other call strips, so it stacks with them wherever they
// are stacked. It wraps instead of truncating: on the 300px floating card
// the text takes the first row and the buttons the second.
const Banner = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--gap-sm) var(--gap-md)",

    padding: "var(--gap-md) var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg) var(--borderRadius-lg) 0 0",
  },
  variants: {
    /** The camera was turned off, against an effect that was only dropped. */
    severe: {
      true: {
        background: "var(--md-sys-color-error-container)",
        color: "var(--md-sys-color-on-error-container)",
      },
      false: {
        background: "var(--md-sys-color-tertiary-container)",
        color: "var(--md-sys-color-on-tertiary-container)",
      },
    },
  },
});

const Text = styled("div", {
  base: {
    flex: "1 1 160px",
    minWidth: 0,
    fontSize: "0.8125rem",
    fontWeight: 500,
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",

    // The app's own background under the banner's text color, as on the
    // other strips' buttons
    "& button": {
      background: "var(--md-sys-color-surface)",
      "--color": "currentColor",
    },
  },
});

import { Trans } from "@lingui-solid/solid/macro";
import { distributionChannel } from "@revolt/client";
import { useState } from "@revolt/state";
import { Button, Text } from "@revolt/ui";
import { Show, createSignal } from "solid-js";
import { styled } from "styled-system/jsx";
import AndroidPromo from "../scripts/assets_fallback/inapp-promotion/web/android-phone.png";

/**
 * Section ID used to persist permanent dismissal of the nag screen
 */
const ANDROID_NAG_DISMISS_KEY = "android-nag-dismissed";

/**
 * Sloga's Google Play listing. Chrome on Android hands this URL to the Play
 * Store app, so people never see the "file might be harmful" download prompt.
 */
const PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=gg.sloga.app";

/**
 * Self-hosted APKs, for phones without Google Play. These are the stable
 * redirects rather than version-pinned files, so releases do not strand old
 * clients on a dead link, and they are counted server-side.
 */
const APK_DOWNLOAD_URL = "https://sloga.gg/dl/android";
const GOOGLE_FREE_APK_DOWNLOAD_URL = "https://sloga.gg/dl/android-google-free";

/**
 * Whether the current device is running Android
 */
const isAndroid = () => /android/i.test(navigator.userAgent);

/**
 * Whether the origin of the request makes us eligible to show the nag screen
 */
const isEligibleOrigin = () => {
  const { hostname } = window.location;
  return (
    hostname === "localhost" ||
    hostname.endsWith(".sloga.gg") ||
    hostname === "sloga.gg"
  );
};

/**
 * Full screen nag encouraging Android users to install the native app
 */
export function AndroidNag() {
  const state = useState();

  const [dismissedThisSession, setDismissedThisSession] = createSignal(false);

  const permanentlyDismissed = () =>
    state.layout.getSectionState(ANDROID_NAG_DISMISS_KEY, false);

  const show = () =>
    // Browser only. Capacitor serves the packaged app from
    // https://localhost, which isEligibleOrigin() accepts, so without this
    // the banner would nag people inside the app to install the app.
    distributionChannel() === "web" &&
    isAndroid() &&
    isEligibleOrigin() &&
    !dismissedThisSession() &&
    !permanentlyDismissed();

  return (
    <Show when={show()}>
      <Base>
        <Hero>
          <img
            src={AndroidPromo}
            alt="Sloga on Android"
            width={450}
            height={512}
          />

          <Heading>
            <Text class="headline" size="large">
              <Trans>Sloga works best as an app</Trans>
            </Text>
          </Heading>

          <Copy>
            <Text class="body" size="large">
              <Trans>
                We are working hard on optimising our web app for mobile.
              </Trans>
            </Text>

            <Text class="body" size="large">
              <Trans>
                In the meantime, get the app for a faster, smoother experience
                designed for Android.
              </Trans>
            </Text>
          </Copy>
        </Hero>

        <Footer>
          <Button
            variant="filled"
            onPress={() => {
              window.open(PLAY_STORE_URL, "_blank", "noopener,noreferrer");
            }}
          >
            <Trans>Get it on Google Play</Trans>
          </Button>

          <AltInstall>
            <span>
              <Trans>Other ways to install:</Trans>
            </span>
            <span>
              <a
                href={APK_DOWNLOAD_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Trans>Download APK</Trans>
              </a>
              {" · "}
              <a
                href={GOOGLE_FREE_APK_DOWNLOAD_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Trans>Google-free APK</Trans>
              </a>
            </span>
          </AltInstall>

          <Button variant="text" onPress={() => setDismissedThisSession(true)}>
            <Trans>Continue in browser</Trans>
          </Button>

          <DismissLink
            onClick={() => {
              state.layout.setSectionState(ANDROID_NAG_DISMISS_KEY, true);
              setDismissedThisSession(true);
            }}
          >
            <Trans>Don't show this again</Trans>
          </DismissLink>
        </Footer>
      </Base>
    </Show>
  );
}

/**
 * Full screen container that sits above all other UI
 */
const Base = styled("div", {
  base: {
    position: "fixed",
    inset: 0,
    zIndex: "9999",

    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    textAlign: "center",
    padding: "var(--gap-xl) var(--gap-lg)",
    userSelect: "none",
    overflowY: "auto",

    color: "var(--md-sys-color-on-surface)",
    background: "var(--md-sys-color-surface)",
  },
});

/**
 * Hero region: large image and supporting copy, centred above the actions
 */
const Hero = styled("div", {
  base: {
    flex: "1",

    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-md)",

    // The width/height attributes reserve the box before the image loads;
    // these caps keep it from crowding out the copy on short screens.
    "& img": {
      width: "auto",
      height: "auto",
      maxWidth: "min(60vw, 240px)",
      maxHeight: "34vh",
      marginBottom: "var(--gap-md)",
    },
  },
});

/**
 * Headline, balanced so it doesn't leave a single orphan word on its own line
 */
const Heading = styled("div", {
  base: {
    textWrap: "balance",
  },
});

/**
 * Body copy, width-constrained and padded for readability
 */
const Copy = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",

    maxWidth: "42ch",
    paddingInline: "var(--gap-lg)",
    textWrap: "balance",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * Actions pinned to the bottom of the screen
 */
const Footer = styled("div", {
  base: {
    flexShrink: 0,

    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    width: "100%",
    maxWidth: "360px",
    gap: "var(--gap-md)",
    paddingTop: "var(--gap-lg)",
  },
});

/**
 * Direct APK links for phones without Google Play, kept quieter than the
 * Play button
 */
const AltInstall = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--gap-xs)",

    fontSize: "0.875rem",
    color: "var(--md-sys-color-on-surface-variant)",

    "& a": {
      color: "var(--md-sys-color-primary)",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
    },
  },
});

/**
 * De-emphasised control for permanently dismissing the nag screen
 */
const DismissLink = styled("button", {
  base: {
    appearance: "none",
    background: "none",
    border: "none",
    cursor: "pointer",

    marginTop: "var(--gap-sm)",
    padding: "var(--gap-sm)",

    font: "inherit",
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",

    _hover: {
      color: "var(--md-sys-color-on-surface)",
    },
  },
});

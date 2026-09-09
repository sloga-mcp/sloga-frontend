import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";

import AppleLogo from "./apple.svg?component-solid";
import googleLogo from "./google.svg";

/**
 * Third-party sign-in buttons.
 *
 * Both brands publish mandatory rules for their own button, and neither
 * leaves much room: the mark may not be recolored or cropped, the label
 * has to be one of a short list of approved strings, and the surface has
 * to be one of the documented light/dark pairs. So these are deliberately
 * NOT the app's `Button` — the MD3 palette (and the pinned #FF8A00 the
 * login form wraps its children in) would repaint them.
 *
 * Google: white #FFFFFF / border #747775 / text #1F1F1F on light,
 *   #131314 / #8E918F / #E3E3E3 on dark. 20px mark, 10px gap.
 * Apple: black button on a light page, white button on a dark one, with
 *   the mark matching the label color.
 *
 * Deviation worth knowing: Google's guidelines name Roboto Medium. Only
 * 400/700 Roboto is bundled (@fontsource, and only when the user picks it
 * as their theme font), so the label inherits the app font at weight 500
 * rather than pulling a whole extra face onto the login page.
 */
const BrandButton = styled("button", {
  base: {
    width: "100%",
    height: "40px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    padding: "0 12px",
    borderRadius: "20px",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 500,
    lineHeight: "20px",
    whiteSpace: "nowrap",
    transition: "filter .15s ease",
    _hover: { filter: "brightness(0.96)" },
    _active: { filter: "brightness(0.92)" },
  },
  variants: {
    brand: {
      googleLight: {
        background: "#FFFFFF",
        color: "#1F1F1F",
        border: "1px solid #747775",
      },
      googleDark: {
        background: "#131314",
        color: "#E3E3E3",
        border: "1px solid #8E918F",
      },
      appleLight: {
        background: "#000000",
        color: "#FFFFFF",
        border: "1px solid #000000",
      },
      appleDark: {
        background: "#FFFFFF",
        color: "#000000",
        border: "1px solid #FFFFFF",
      },
    },
  },
});

/**
 * The multicolor G, at the 20px the guidelines specify for a 40px button.
 * An <img> on purpose: an inlined component invites a later `fill` or
 * `currentColor` edit, which would be a brand violation.
 */
const GoogleMark = styled("img", {
  base: {
    width: "20px",
    height: "20px",
    flexShrink: 0,
  },
});

/**
 * The Apple mark takes the label's color, per Apple's black/white pair.
 * The glyph's own bounding box sits low, so nudge it up to optically
 * center against the cap height of the text beside it.
 */
const AppleMark = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,
    marginBlockStart: "-2px",
    "& svg": {
      width: "auto",
      height: "17px",
    },
  },
});

/**
 * "Continue with Google" — one of Google's approved strings, and the one
 * already in the translation catalogs.
 */
export function GoogleSignInButton(props: { onPress: () => void }) {
  const state = useState();

  return (
    <BrandButton
      type="button"
      brand={state.theme.activeTheme.darkMode ? "googleDark" : "googleLight"}
      onClick={() => props.onPress()}
    >
      <GoogleMark src={googleLogo} alt="" aria-hidden="true" />
      <Trans>Continue with Google</Trans>
    </BrandButton>
  );
}

/**
 * "Continue with Apple" — approved by Apple's HIG alongside "Sign in with
 * Apple"; paired with the Google label so neither reads as the primary.
 */
export function AppleSignInButton(props: { onPress: () => void }) {
  const state = useState();

  return (
    <BrandButton
      type="button"
      brand={state.theme.activeTheme.darkMode ? "appleDark" : "appleLight"}
      onClick={() => props.onPress()}
    >
      <AppleMark aria-hidden="true">
        <AppleLogo />
      </AppleMark>
      <Trans>Continue with Apple</Trans>
    </BrandButton>
  );
}

/**
 * "or" rule separating the password form from the third-party buttons
 */
const DividerRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    width: "100%",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "0.8em",

    "&::before, &::after": {
      content: '""',
      flex: 1,
      height: "1px",
      background: "var(--md-sys-color-outline-variant)",
    },
  },
});

export function OAuthDivider() {
  return (
    <DividerRow>
      <Trans>or</Trans>
    </DividerRow>
  );
}

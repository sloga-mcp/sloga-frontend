import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { i18n } from "@lingui/core";
import { styled } from "styled-system/jsx";

import { allowsDonationLinks } from "@revolt/client";
import { Button } from "@revolt/ui";

import { CipherLock } from "./CipherLock";
import { cipherPromoUrl, formatCount } from "./cipherPromo";

const GREEN = "#27A163";

/**
 * Open the Cipher page in the reader's language, in the system browser on the
 * desktop and Android shells (they route `_blank` there, as for Ko-fi).
 */
function openCipherPage() {
  window.open(cipherPromoUrl(i18n.locale), "_blank", "noopener");
}

/**
 * The blue "Become a Cipher" button. `bg` overrides the tonal background but
 * not its ink, so the ink is pinned to the same pairing Sign Up uses (7.28:1).
 */
function CipherButton() {
  return (
    <div
      style={{
        "--md-sys-color-on-secondary-container": "#04222E",
        display: "flex",
      }}
    >
      <Button variant="tonal" bg="#3BB8ED" onPress={openCipherPage}>
        <b>
          <Trans>Become a Cipher</Trans>
        </b>
      </Button>
    </div>
  );
}

const Panel = styled("section", {
  base: {
    position: "relative",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: "540px",
    maxHeight: "860px",
    padding: "44px 46px",
    borderRadius: "28px",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    isolation: "isolate",
  },
});

/**
 * The panel's text, layered above the decorative lock circle so a short
 * window never hides the stats behind it
 */
const Content = styled("div", {
  base: {
    position: "relative",
    zIndex: 1,
  },
});

const Kicker = styled("div", {
  base: {
    color: GREEN,
    fontWeight: 600,
    fontSize: "15px",
  },
});

const Title = styled("h2", {
  base: {
    margin: "10px 0 16px",
    fontWeight: 800,
    fontSize: "42px",
    lineHeight: 1.08,
    letterSpacing: "-0.02em",
    maxWidth: "13ch",
  },
});

const Lede = styled("p", {
  base: {
    margin: "0 0 24px",
    fontSize: "16px",
    lineHeight: 1.55,
    maxWidth: "42ch",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Stats = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    rowGap: "12px",
    margin: "0 0 28px",
  },
});

const Stat = styled("div", {
  base: {
    paddingRight: "22px",
    "&:not(:first-child)": {
      paddingLeft: "22px",
      borderLeft: "1px solid var(--md-sys-color-outline-variant)",
    },
  },
});

const StatValue = styled("div", {
  base: {
    fontWeight: 800,
    fontSize: "30px",
    lineHeight: 1.05,
  },
});

const StatLabel = styled("div", {
  base: {
    marginTop: "4px",
    fontSize: "13px",
    lineHeight: 1.35,
    maxWidth: "15ch",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Stage = styled("div", {
  base: {
    position: "absolute",
    right: "-36px",
    bottom: "-56px",
    width: "360px",
    height: "360px",
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    background: "var(--md-sys-color-surface-container-high)",
    pointerEvents: "none",

    "& svg": {
      width: "78%",
      height: "78%",
    },

    "@media (max-height: 820px)": {
      width: "260px",
      height: "260px",
      right: "-40px",
      bottom: "-80px",
    },
  },
});

const Banner = styled("section", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    padding: "16px",
    borderRadius: "20px",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const BannerRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
  },
});

const BannerTitle = styled("div", {
  base: {
    fontWeight: 800,
    fontSize: "17px",
    lineHeight: 1.2,
  },
});

const BannerText = styled("div", {
  base: {
    marginTop: "3px",
    fontSize: "13.5px",
    lineHeight: 1.4,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * Promotes Protected servers and channels and the Cipher founding supporters
 * on the auth screens. `panel` sits beside the login card on wide screens;
 * `banner` is the compact phone version above the logo.
 *
 * Store builds (Play, App Store) get the info-only text: no price, no Cipher
 * numbers and no link to the sale, under the same rule as the Ko-fi links.
 */
export function CipherPromo(props: { variant: "panel" | "banner" }) {
  const purchase = () => allowsDonationLinks();

  return (
    <Show
      when={props.variant === "panel"}
      fallback={
        <Banner>
          <BannerRow>
            <CipherLock size={56} />
            <div>
              <Kicker>
                <Trans>Coming soon</Trans>
              </Kicker>
              <BannerTitle>
                <Trans>Protected servers and channels</Trans>
              </BannerTitle>
              <BannerText>
                <Trans>End-to-end encryption, open source at launch.</Trans>
              </BannerText>
            </div>
          </BannerRow>
          <Show when={purchase()}>
            <CipherButton />
          </Show>
        </Banner>
      }
    >
      <Panel>
        <Content>
          <Kicker>
            <Trans>Coming soon</Trans>
          </Kicker>
          <Title>
            <Trans>Protected servers and channels</Trans>
          </Title>
          <Show
            when={purchase()}
            fallback={
              <Lede>
                <Trans>
                  End-to-end encryption for a whole server or a single channel.
                  Not even Sloga can read it, and the encryption code goes open
                  source on launch day.
                </Trans>
              </Lede>
            }
          >
            <Lede>
              <Trans>
                End-to-end encryption for a whole server or a single channel.
                The encryption code goes open source on launch day, and at 675
                Ciphers an outside firm audits it.
              </Trans>
            </Lede>
            <Stats>
              <Stat>
                <StatValue>{formatCount(1000, i18n.locale)}</StatValue>
                <StatLabel>
                  <Trans>numbered Cipher badges</Trans>
                </StatLabel>
              </Stat>
              <Stat>
                <StatValue style={{ color: GREEN }}>
                  {formatCount(675, i18n.locale)}
                </StatValue>
                <StatLabel>
                  <Trans>Ciphers fund the audit</Trans>
                </StatLabel>
              </Stat>
              <Stat>
                <StatValue>
                  <Trans>$99</Trans>
                </StatValue>
                <StatLabel>
                  <Trans>to become a Cipher</Trans>
                </StatLabel>
              </Stat>
            </Stats>
            <div>
              <CipherButton />
            </div>
          </Show>
        </Content>
        <Stage aria-hidden="true">
          <CipherLock size={280} />
        </Stage>
      </Panel>
    </Show>
  );
}

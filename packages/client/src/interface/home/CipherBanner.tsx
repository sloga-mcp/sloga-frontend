import {
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { i18n } from "@lingui/core";
import { styled } from "styled-system/jsx";

import { CipherLock } from "@revolt/auth/src/CipherLock";
import { formatCount } from "@revolt/auth/src/cipherPromo";
import { allowsDonationLinks, useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { Button, iconSize } from "@revolt/ui";

import {
  fetchCipherStats,
  parseUserCipher,
  saleStatus,
} from "../../../components/app/interface/settings/user/cipherCheckout";

import MdClose from "@material-design-icons/svg/filled/close.svg?component-solid";

import {
  CIPHER_BANNER_KEY,
  parseStoredTime,
  showCipherBanner,
} from "./homeHub";

const GREEN = "#27A163";

/** Ciphers that fund the outside audit (the same figure as the login promo) */
const AUDIT_AT = 675;

const Card = styled("section", {
  base: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "112px minmax(0, 1fr)",
    gridTemplateAreas: '"art title" "art body"',
    columnGap: "20px",
    rowGap: "6px",
    alignItems: "center",
    padding: "18px 20px",
    borderRadius: "20px",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",

    "@media (max-width: 640px)": {
      gridTemplateColumns: "56px minmax(0, 1fr)",
      gridTemplateAreas: '"art title" "body body"',
      columnGap: "12px",
      rowGap: "10px",
      padding: "14px",
    },
  },
});

/**
 * The lock's stage. `data-paused` freezes the loop while the banner is off
 * screen or the tab is hidden, so it does not animate for nobody.
 */
const Art = styled("div", {
  base: {
    gridArea: "art",
    alignSelf: "start",
    width: "112px",
    height: "112px",
    borderRadius: "16px",
    display: "grid",
    placeItems: "center",
    background: "var(--md-sys-color-surface-container-high)",

    "& svg": {
      width: "76%",
      height: "76%",
    },
    "&[data-paused] *": {
      animationPlayState: "paused !important",
    },

    "@media (max-width: 640px)": {
      alignSelf: "center",
      width: "56px",
      height: "56px",
      borderRadius: "12px",
    },
  },
});

const Title = styled("h2", {
  base: {
    gridArea: "title",
    alignSelf: "end",
    margin: 0,
    paddingRight: "28px",
    fontWeight: 800,
    fontSize: "22px",
    lineHeight: 1.15,
    letterSpacing: "-0.01em",

    "@media (max-width: 640px)": {
      alignSelf: "center",
      fontSize: "17px",
    },
  },
});

const Body = styled("div", {
  base: {
    gridArea: "body",
    alignSelf: "start",
    minWidth: 0,
  },
});

const Lede = styled("p", {
  base: {
    margin: "0 0 12px",
    fontSize: "14px",
    lineHeight: 1.5,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Stats = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    margin: "0 0 14px",
    paddingTop: "10px",
    borderTop: "1px solid var(--md-sys-color-outline-variant)",
  },
});

const Stat = styled("div", {
  base: {
    paddingRight: "12px",
    "&:not(:first-child)": {
      paddingLeft: "12px",
      borderLeft: "1px solid var(--md-sys-color-outline-variant)",
    },
  },
});

const StatValue = styled("div", {
  base: {
    fontWeight: 800,
    fontSize: "20px",
    lineHeight: 1.1,
  },
});

const StatLabel = styled("div", {
  base: {
    marginTop: "2px",
    fontSize: "12px",
    lineHeight: 1.3,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/** Pins the button's ink to the login promo's pairing; full width on phones */
const Action = styled("div", {
  base: {
    display: "flex",

    "@media (max-width: 640px)": {
      "& > *": {
        flex: 1,
      },
    },
  },
});

const Close = styled("button", {
  base: {
    position: "absolute",
    top: "8px",
    right: "8px",
    width: "32px",
    height: "32px",
    display: "grid",
    placeItems: "center",
    border: 0,
    borderRadius: "var(--borderRadius-full)",
    background: "transparent",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",

    "& svg": { fill: "currentColor" },
    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
    },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

function readHiddenAt(): number | undefined {
  try {
    return parseStoredTime(localStorage.getItem(CIPHER_BANNER_KEY));
  } catch {
    return undefined;
  }
}

/**
 * Whether the Cipher banner shows, the sale numbers it draws, and its
 * dismiss. Kept apart from the banner so Home can ask before it draws a
 * frame for it, and so moving the card does not fetch the counter again.
 */
export function createCipherBannerState() {
  const client = useClient();

  const [hiddenAt, setHiddenAt] = createSignal(readHiddenAt());

  // Public counter, read once per visit to Home. A failure hides the banner.
  const [stats] = createResource(
    () => (allowsDonationLinks() ? CONFIGURATION.DEFAULT_API_URL : undefined),
    (apiBase) =>
      fetchCipherStats({
        fetch: (url, init) => fetch(url, init),
        apiBase,
        headers: () => ({}),
      }).catch(() => undefined),
  );

  const visible = () =>
    showCipherBanner({
      allowsLinks: allowsDonationLinks(),
      sale: stats.error ? undefined : saleStatus(stats.latest),
      hasCipher: parseUserCipher(client()?.user?.cipher) !== undefined,
      hiddenAt: hiddenAt(),
      now: Date.now(),
    });

  function dismiss() {
    const now = Date.now();
    setHiddenAt(now);
    try {
      localStorage.setItem(CIPHER_BANNER_KEY, String(now));
    } catch {
      // Private mode: hidden for this visit only
    }
  }

  return { visible, dismiss, stats };
}

/**
 * Protected servers / Cipher banner at the top of Home, after the sloga.gg
 * popup. Shown only while the sale is open, to people without a Cipher
 * badge, in builds that may link to payments; the X hides it for two weeks.
 */
export function CipherBanner(props: {
  state: ReturnType<typeof createCipherBannerState>;
}) {
  const { openModal } = useModals();
  const { t } = useLingui();

  const stats = () => props.state.stats;

  return (
    <Show when={props.state.visible()}>
      <Card aria-labelledby="home-cipher-title">
        <Close
          type="button"
          aria-label={t`Hide for now`}
          onClick={() => props.state.dismiss()}
        >
          <MdClose {...iconSize(18)} />
        </Close>
        <LockStage />
        <Title id="home-cipher-title">
          <Trans>Protected servers are coming to Sloga</Trans>
        </Title>
        <Body>
          <Lede>
            <Trans>
              End-to-end encryption for a whole server or a single channel. We
              can't read any of it.
            </Trans>
          </Lede>
          <Stats>
            <Stat>
              <StatValue>
                {formatCount(stats().latest?.cap ?? 1000, i18n.locale)}
              </StatValue>
              <StatLabel>
                <Trans>numbered Cipher badges</Trans>
              </StatLabel>
            </Stat>
            <Stat>
              <StatValue style={{ color: GREEN }}>
                {formatCount(AUDIT_AT, i18n.locale)}
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
          <Action
            style={{ "--md-sys-color-on-secondary-container": "#04222E" }}
          >
            <Button
              variant="tonal"
              bg="#3BB8ED"
              onPress={() =>
                openModal({
                  type: "settings",
                  config: "user",
                  context: { page: "cipher" },
                })
              }
            >
              <b>
                <Trans>Become a Cipher</Trans>
              </b>
            </Button>
          </Action>
        </Body>
      </Card>
    </Show>
  );
}

/**
 * The looping lock, paused while it cannot be seen (tab hidden, or scrolled
 * out of view)
 */
function LockStage() {
  let ref: HTMLDivElement | undefined;
  const [onScreen, setOnScreen] = createSignal(true);
  const [tabVisible, setTabVisible] = createSignal(!document.hidden);

  onMount(() => {
    const onVisibility = () => setTabVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);

    let observer: IntersectionObserver | undefined;
    if (ref && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setOnScreen(entry.isIntersecting);
      });
      observer.observe(ref);
    }

    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    });
  });

  return (
    <Art
      ref={ref}
      aria-hidden="true"
      data-paused={onScreen() && tabVisible() ? undefined : ""}
    >
      <CipherLock size={84} />
    </Art>
  );
}

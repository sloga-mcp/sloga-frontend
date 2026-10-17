import { BiLogosGithub } from "solid-icons/bi";
import { JSX, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { Titlebar } from "@revolt/app/interface/desktop/Titlebar";
import { useLocation } from "@revolt/routing";
import { useState } from "@revolt/state";
import { IconButton, iconSize } from "@revolt/ui";

import MdDarkMode from "@material-design-icons/svg/filled/dark_mode.svg?component-solid";

import { CipherPromo } from "./CipherPromo";
import background from "./background.jpg";
import { FlowBase } from "./flows/Flow";
import bluesky from "./flows/bluesky.svg";

/**
 * Authentication page layout
 */
const Base = styled("div", {
  base: {
    width: "100%",
    height: "100%",
    padding: "40px 35px",

    userSelect: "none",
    overflowY: "scroll",

    color: "var(--md-sys-color-on-surface)",
    background: "var(--md-sys-color-surface)",
    // background: `var(--url)`,
    // backgroundPosition: "center",
    // backgroundRepeat: "no-repeat",
    // backgroundSize: "cover",

    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",

    mdDown: {
      padding: "30px 20px",
    },
  },
});

/**
 * Wide screens: the Cipher promo on the left, the flow on the right. Below
 * `lg` the promo column is dropped and the page is a single column again.
 */
const Layout = styled("div", {
  base: {
    flexGrow: 1,
    display: "grid",
    gridTemplateColumns: "minmax(440px, 600px) 1fr",
    gap: "32px",
    minHeight: "100%",

    lgDown: {
      display: "flex",
      flexDirection: "column",
    },
  },
});

/**
 * Column holding the Cipher promo panel
 */
const PromoSide = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",

    lgDown: {
      display: "none",
    },
  },
});

/**
 * Column holding the navigation bars and the flow card
 */
const MainSide = styled("div", {
  base: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    flexGrow: 1,
  },
});

/**
 * The compact Cipher banner above the card, on the first screen only, for
 * screens too narrow for the side panel. It sits outside FlowBase so the
 * card's height limit still fits the login and sign-up buttons.
 */
const NarrowBanner = styled("div", {
  base: {
    width: "100%",
    maxWidth: "360px",
    marginInline: "auto",
    marginTop: "20px",

    lg: {
      display: "none",
    },
  },
});

/**
 * Top and bottom navigation bars
 */
const Nav = styled("div", {
  base: {
    height: "32px",
    display: "flex",
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",

    textDecoration: "none",
  },
});

/**
 * Navigation items
 */
const NavItems = styled("div", {
  base: {
    gap: "10px",
    display: "flex",
    alignItems: "center",

    fontSize: "0.9em",
  },
  variants: {
    variant: {
      default: {
        "& > *": {
          textAlign: "center",
        },
      },
      stack: {
        md: {
          flexDirection: "column",
        },
      },
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

/**
 * Link with an icon inside
 */
const LinkWithIcon = styled("a", {
  base: { height: "24px" },
});

/**
 * Middot-like bullet
 */
const Bullet = styled("div", {
  base: {
    height: "5px",
    width: "5px",
    background: "grey",
    borderRadius: "50%",

    md: {
      display: "none",
    },
  },
});

/**
 * Authentication page
 */
export function AuthPage(props: { children: JSX.Element }) {
  const state = useState();
  const location = useLocation();
  const onHomeScreen = () => location.pathname.replace(/\/+$/, "") === "/login";

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
      }}
    >
      <Titlebar />
      <Base
        style={{ "--url": `url('${background}')` }}
        css={{ scrollbar: "hidden" }}
      >
        <Layout>
          <PromoSide>
            <CipherPromo variant="panel" />
          </PromoSide>
          <MainSide>
            <Nav>
              <div />
              <IconButton
                variant="tonal"
                onPress={() =>
                  state.theme.setMode(
                    state.theme.activeTheme.darkMode ? "light" : "dark",
                  )
                }
              >
                <MdDarkMode {...iconSize("24px")} />
              </IconButton>
            </Nav>
            <Show when={onHomeScreen()}>
              <NarrowBanner>
                <CipherPromo variant="banner" />
              </NarrowBanner>
            </Show>
            <FlowBase>{props.children}</FlowBase>
            <Nav />
          </MainSide>
        </Layout>
      </Base>
    </div>
  );
}

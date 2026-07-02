import { Match, Show, Switch } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { PublicChannelInvite } from "stoat.js";
import { css, cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { IS_DEV, useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import {
  Button,
  CategoryButton,
  Column,
  Header,
  iconSize,
  main,
} from "@revolt/ui";

import MdAddCircle from "@material-design-icons/svg/filled/add_circle.svg?component-solid";
import MdExplore from "@material-design-icons/svg/filled/explore.svg?component-solid";
import MdGroups3 from "@material-design-icons/svg/filled/groups_3.svg?component-solid";
import MdHome from "@material-design-icons/svg/filled/home.svg?component-solid";
import MdPayments from "@material-design-icons/svg/filled/payments.svg?component-solid";
import MdRateReview from "@material-design-icons/svg/filled/rate_review.svg?component-solid";
import MdSettings from "@material-design-icons/svg/filled/settings.svg?component-solid";

import { HeaderIcon } from "./common/CommonHeader";

/**
 * Base layout of the home page (i.e. the header/background)
 */
const Base = styled("div", {
  base: {
    width: "100%",
    display: "flex",
    flexDirection: "column",

    color: "var(--md-sys-color-on-surface)",
  },
});

/**
 * Layout of the content as a whole
 */
const content = cva({
  base: {
    ...main.raw(),

    padding: "48px 0",

    gap: "32px",
    alignItems: "center",
    justifyContent: "center",
  },
});

/**
 * Layout of the buttons
 */
const Buttons = styled("div", {
  base: {
    gap: "8px",
    padding: "8px",
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    borderRadius: "var(--borderRadius-lg)",

    color: "var(--md-sys-color-on-surface-variant)",
    background: "var(--md-sys-color-surface-variant)",
  },
});

/**
 * Make sure the columns are separated
 */
const SeparatedColumn = styled(Column, {
  base: {
    justifyContent: "stretch",
    marginInline: "0.25em",
    width: "260px",
    "& > *": {
      flexGrow: 1,
    },
  },
});

/**
 * Home page
 */
export function HomePage() {
  const { openModal } = useModals();
  const navigate = useNavigate();
  const client = useClient();

  // check if we're stoat.chat; if so, check if the user is in the Lounge
  const showLoungeButton = CONFIGURATION.IS_STOAT;
  const isInLounge =
    client()!.servers.get("01F7ZSBSFHQ8TA81725KQCSDDP") !== undefined;

  return (
    <Base>
      <Header placement="primary">
        <HeaderIcon>
          <MdHome {...iconSize(22)} />
        </HeaderIcon>
        <Trans>Home</Trans>
      </Header>
      <div use:scrollable={{ class: content() }}>
        <Column>
          <span
            class={css({
              fontSize: "48px",
              fontWeight: "700",
              letterSpacing: "-1px",
              color: "var(--md-sys-color-on-surface)",
            })}
          >
            Acutest
          </span>
        </Column>
        <Buttons>
          <SeparatedColumn>
            <div style={{"--md-sys-color-primary": "#00B2FF", "--md-sys-color-on-primary": "#ffffff"}}>
            <CategoryButton
              variant="filled"
              onClick={() =>
                openModal({
                  type: "create_group_or_server",
                  client: client()!,
                })
              }
              description={
                <Trans>
                  Invite all of your friends, some cool bots, and throw a big
                  party.
                </Trans>
              }
              icon={<MdAddCircle />}
            >
              <Trans>Create a group or server</Trans>
            </CategoryButton>
            </div>
            <Switch fallback={null}>
              <Match when={showLoungeButton && isInLounge}>
                <CategoryButton
                  onClick={() => navigate("/server/01F7ZSBSFHQ8TA81725KQCSDDP")}
                  description={
                    <Trans>
                      You can report issues and discuss improvements with us
                      directly here.
                    </Trans>
                  }
                  icon={<MdGroups3 />}
                >
                  <Trans>Go to the Acutest Lounge</Trans>
                </CategoryButton>
              </Match>
              <Match when={showLoungeButton && !isInLounge}>
                <CategoryButton
                  onClick={() => {
                    client()
                      .api.get("/invites/Testers")
                      .then((invite) =>
                        PublicChannelInvite.from(client(), invite),
                      )
                      .then((invite) => openModal({ type: "invite", invite }));
                  }}
                  description={
                    <Trans>
                      You can report issues and discuss improvements with us
                      directly here.
                    </Trans>
                  }
                  icon={<MdGroups3 />}
                >
                  <Trans>Join the Acutest Lounge</Trans>
                </CategoryButton>
              </Match>
            </Switch>
            <div style={{"--md-sys-color-primary": "#FF8A00", "--md-sys-color-on-primary": "#ffffff"}}>
            <CategoryButton
              variant="filled"
              onClick={() => window.open("https://ko-fi.com/stoatchat")}
              description={
                <Trans>Support the project by donating - thank you!</Trans>
              }
              icon={<MdPayments />}
            >
              <Trans>Donate to Acutest</Trans>
            </CategoryButton>
            </div>
          </SeparatedColumn>
          <SeparatedColumn>
            <Show when={CONFIGURATION.IS_STOAT}>
              <CategoryButton
                onClick={() => navigate("/discover")}
                description={
                  <Trans>
                    Find a community based on your hobbies or interests.
                  </Trans>
                }
                icon={<MdExplore />}
              >
                <Trans>Discover Acutest</Trans>
              </CategoryButton>
            </Show>
            <div style={{"--md-sys-color-primary": "#00B2FF", "--md-sys-color-on-primary": "#ffffff"}}>
            <CategoryButton
              variant="filled"
              onClick={() =>
                openModal({
                  type: "settings",
                  config: "user",
                  context: { page: "feedback" },
                })
              }
              description={
                <Trans>
                  Let us know how we can improve our app by giving us feedback.
                </Trans>
              }
              icon={<MdRateReview {...iconSize(22)} />}
            >
              <Trans>Give feedback on Acutest</Trans>
            </CategoryButton>
            </div>
            <div style={{"--md-sys-color-primary": "#00B2FF", "--md-sys-color-on-primary": "#ffffff"}}>
            <CategoryButton
              variant="filled"
              onClick={() => openModal({ type: "settings", config: "user" })}
              description={
                <Trans>
                  You can also click the gear icon in the bottom left.
                </Trans>
              }
              icon={<MdSettings />}
            >
              <Trans>Open settings</Trans>
            </CategoryButton>
            </div>
          </SeparatedColumn>
        </Buttons>
        <Show when={IS_DEV}>
          <Button bg="#FF8A00" onPress={() => navigate("/dev")}>
            Open Development Page
          </Button>
        </Show>
      </div>
    </Base>
  );
}

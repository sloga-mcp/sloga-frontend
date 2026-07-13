import { Match, Show, Switch, createSignal, onMount } from "solid-js";

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
  slogaBurstKeyframes,
} from "@revolt/ui";

import MdAddCircle from "@material-design-icons/svg/filled/add_circle.svg?component-solid";
import MdExplore from "@material-design-icons/svg/filled/explore.svg?component-solid";
import MdGroups3 from "@material-design-icons/svg/filled/groups_3.svg?component-solid";
import MdHome from "@material-design-icons/svg/filled/home.svg?component-solid";
import MdPayments from "@material-design-icons/svg/filled/payments.svg?component-solid";
import MdPersonAdd from "@material-design-icons/svg/filled/person_add.svg?component-solid";
import MdRateReview from "@material-design-icons/svg/filled/rate_review.svg?component-solid";
import MdReport from "@material-design-icons/svg/filled/report.svg?component-solid";
import MdSettings from "@material-design-icons/svg/filled/settings.svg?component-solid";

import { HeaderIcon } from "./common/CommonHeader";

// Satellite colors clockwise from the top, matching the brand mark.
const DOT_COLORS = [
  "#3BB8ED",
  "#F5870D",
  "#CF2A27",
  "#E3CF1B",
  "#3BB8ED",
  "#F5870D",
  "#2B2BD8",
  "#C05FC8",
];

/**
 * Geometry of the wordmark's "O" within the 258×96 viewBox: centre point, the
 * resting ring the satellites sit on (r=29), and the green core (r=10). The
 * satellites are drawn at the centre and pushed out to the ring by a transform,
 * exactly like the loader — so the same brand animation can drive them.
 */
const O = { cx: 115, cy: 55, ring: 29, core: 10 };

/** Length of one click-burst; long enough to read the spiral, short enough to feel like a flourish. */
const BURST_DURATION = "2400ms";

/**
 * Inject the wordmark's resting + burst styles once. The @keyframes are built
 * from the shared brand-motion curves (see slogaBurstKeyframes); the base rules
 * pin every satellite on the resting ring so the logo looks identical at rest,
 * and only `.playing` runs the one-shot spin.
 */
let wordmarkStylesInjected = false;
function ensureWordmarkStyles() {
  if (wordmarkStylesInjected || typeof document === "undefined") return;
  wordmarkStylesInjected = true;
  const el = document.createElement("style");
  el.setAttribute("data-sloga-wordmark", "");
  el.textContent = `
${slogaBurstKeyframes("sloga-wm", { core: O.core, ring: O.ring })}
.sloga-wm-ball {
  transform-box: view-box;
  transform-origin: ${O.cx}px ${O.cy}px;
  transform: rotate(var(--sloga-ball-angle)) translateY(-${O.ring}px);
}
.sloga-wm-core {
  transform-box: view-box;
  transform-origin: ${O.cx}px ${O.cy}px;
}
.sloga-wm-ball.playing {
  will-change: transform;
  animation: sloga-wm-ball ${BURST_DURATION} linear 1;
}
.sloga-wm-core.playing {
  animation: sloga-wm-core ${BURST_DURATION} linear 1;
}
@media (prefers-reduced-motion: reduce) {
  .sloga-wm-ball.playing, .sloga-wm-core.playing { animation: none; }
}`;
  document.head.appendChild(el);
}

/**
 * Sloga wordmark: the O is a circle of people around the online dot.
 *
 * Pass `interactive` to make it a little easter egg — clicking the wordmark
 * plays the brand's ball animation on the O (unwind into the core, gulp, burst
 * back out) without navigating anywhere. Off by default so the nav-link copy in
 * the sidebar stays a plain, static logo.
 */
export function SlogaWordmark(props: {
  height: number;
  color?: string;
  interactive?: boolean;
}) {
  const [playing, setPlaying] = createSignal(false);

  onMount(ensureWordmarkStyles);

  const play = () => {
    if (!props.interactive || playing()) return;
    // Respect users who'd rather not see motion.
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    setPlaying(true);
  };

  return (
    <svg
      viewBox="0 0 258 96"
      height={props.height}
      role="img"
      aria-label="Sloga"
      style={{ cursor: props.interactive ? "pointer" : undefined }}
      onClick={play}
    >
      <text
        x="0"
        y="72"
        font-size="82"
        font-weight="800"
        fill={props.color ?? "var(--md-sys-color-on-surface)"}
        font-family="inherit"
      >
        Sl
      </text>
      {DOT_COLORS.map((fill, i) => (
        <circle
          class="sloga-wm-ball"
          classList={{ playing: playing() }}
          cx={O.cx}
          cy={O.cy}
          r="8"
          fill={fill}
          style={{ "--sloga-ball-angle": `${i * 45}deg` }}
        />
      ))}
      <circle
        class="sloga-wm-core"
        classList={{ playing: playing() }}
        cx={O.cx}
        cy={O.cy}
        r="10"
        fill="#27A163"
        onAnimationEnd={() => setPlaying(false)}
      />
      <text
        x="158"
        y="72"
        font-size="82"
        font-weight="800"
        fill={props.color ?? "var(--md-sys-color-on-surface)"}
        font-family="inherit"
      >
        ga
      </text>
    </svg>
  );
}

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
          <SlogaWordmark height={64} interactive />
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
              <Trans>Start a Chat Room/Server</Trans>
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
                  <Trans>Go to the Sloga Lounge</Trans>
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
                  <Trans>Join the Sloga Lounge</Trans>
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
              <Trans>Donate to Sloga</Trans>
            </CategoryButton>
            </div>
          </SeparatedColumn>
          <SeparatedColumn>
            <div style={{"--md-sys-color-primary": "#00B2FF", "--md-sys-color-on-primary": "#ffffff"}}>
            <CategoryButton
              variant="filled"
              onClick={() => openModal({ type: "add_friend", client: client()! })}
              description={<Trans>Connect with someone by adding them as a friend.</Trans>}
              icon={<MdPersonAdd />}
            >
              <Trans>Add a Friend</Trans>
            </CategoryButton>
            </div>
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
                <Trans>Discover Sloga</Trans>
              </CategoryButton>
            </Show>
            <Show when={client()!.user?.privileged}>
              <CategoryButton
                onClick={() =>
                  openModal({ type: "report_queue", client: client()! })
                }
                description={
                  <Trans>Review and resolve open content reports.</Trans>
                }
                icon={<MdReport />}
              >
                <Trans>Report queue</Trans>
              </CategoryButton>
            </Show>
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
      </div>
    </Base>
  );
}

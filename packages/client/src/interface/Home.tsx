import {
  Match,
  Show,
  Switch,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { PublicChannelInvite } from "stoat.js";
import { css, cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { allowsDonationLinks, IS_DEV, useClient } from "@revolt/client";
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
import MdTravelExplore from "@material-design-icons/svg/filled/travel_explore.svg?component-solid";

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

/**
 * How often the moderation queue counts on the home tiles are refreshed. Only
 * privileged accounts poll at all, and only while the home screen is mounted
 * and visible; acting on a queue refreshes it immediately when the modal
 * closes, so this is just the backstop for items filed by someone else.
 */
const QUEUE_POLL_INTERVAL = 60_000;

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
      {/* eslint-disable-next-line solid/prefer-for -- DOT_COLORS is a
          module-level constant, so there is no reactive list to keep
          identity for; <For> would only add a wrapper. */}
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
 * Count of items still awaiting a decision, shown on the moderation tiles.
 * Hidden entirely at zero, so a badge only ever means "there is work here".
 */
const QueueBadge = styled("div", {
  base: {
    minWidth: "20px",
    height: "20px",
    padding: "0 6px",
    flexShrink: 0,

    display: "grid",
    placeItems: "center",

    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-error)",
    color: "var(--md-sys-color-on-error)",

    fontSize: "12px",
    fontWeight: 600,
    lineHeight: 1,
  },
});

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
  const { openModal, isOpen } = useModals();
  const { t } = useLingui();
  const navigate = useNavigate();
  const client = useClient();

  const isPrivileged = () => !!client()!.user?.privileged;

  /**
   * Pending counts for the two moderation queues.
   *
   * These hit the same routes the queue modals do — and for the same reason
   * they use fetch directly: stoat-api's typed client silently drops requests
   * to routes missing from its generated route tables. Each side is settled
   * independently so one failing route still leaves the other's badge correct;
   * a failed side reports `undefined`, which renders as no badge rather than a
   * misleading zero.
   */
  const [queues, { refetch: refetchQueues }] = createResource(
    () => (isPrivileged() ? client()! : undefined),
    async (c) => {
      const api = c.api as unknown as {
        baseURL: string;
        auth: Record<string, string>;
      };

      const get = async (path: string) => {
        const response = await fetch(api.baseURL + path, {
          headers: { ...api.auth },
        });
        if (!response.ok) throw await response.text();
        return response.json();
      };

      const [reports, listings] = await Promise.allSettled([
        get("/safety/reports"),
        get("/discover/requests"),
      ]);

      return {
        reports:
          reports.status === "fulfilled"
            ? (reports.value as { status: string }[]).filter(
                (report) => report.status === "Created",
              ).length
            : undefined,
        listings:
          listings.status === "fulfilled"
            ? ((listings.value as { servers?: unknown[] }).servers ?? []).length
            : undefined,
      };
    },
  );

  onMount(() => {
    const timer = setInterval(() => {
      // Don't poll a screen nobody is looking at.
      if (isPrivileged() && !document.hidden) refetchQueues();
    }, QUEUE_POLL_INTERVAL);

    onCleanup(() => clearInterval(timer));
  });

  // Refresh as soon as a queue modal closes, so clearing the last item drops
  // the badge right away instead of waiting out the poll.
  let queueModalWasOpen = false;
  createEffect(() => {
    const open = isOpen("report_queue") || isOpen("discovery_queue");
    if (queueModalWasOpen && !open) refetchQueues();
    queueModalWasOpen = open;
  });

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
            <div style={{"--md-sys-color-primary": "#00B2FF", "--md-sys-color-on-primary": "#05090F"}}>
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
            {/* Hidden in Play builds: linking out to donations is a Google
                Play payments-policy grey area and Sloga is not a registered
                nonprofit. Web, desktop and the sloga.gg APK still show it. */}
            <Show when={allowsDonationLinks()}>
            <div style={{"--md-sys-color-primary": "#FF8A00", "--md-sys-color-on-primary": "#05090F"}}>
            <CategoryButton
              variant="filled"
              onClick={() => window.open("https://ko-fi.com/slogatech")}
              description={
                <Trans>Support the project by donating - thank you!</Trans>
              }
              icon={<MdPayments />}
            >
              <Trans>Donate to Sloga</Trans>
            </CategoryButton>
            </div>
            </Show>
          </SeparatedColumn>
          <SeparatedColumn>
            <div style={{"--md-sys-color-primary": "#00B2FF", "--md-sys-color-on-primary": "#05090F"}}>
            <CategoryButton
              variant="filled"
              onClick={() => openModal({ type: "add_friend", client: client()! })}
              description={<Trans>Connect with someone by adding them as a friend.</Trans>}
              icon={<MdPersonAdd />}
            >
              <Trans>Add a Friend</Trans>
            </CategoryButton>
            </div>
            <div style={{"--md-sys-color-primary": "#27A163", "--md-sys-color-on-primary": "#05090F"}}>
            <CategoryButton
              variant="filled"
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
            </div>
            <Show when={client()!.user?.privileged}>
              <CategoryButton
                onClick={() =>
                  openModal({ type: "report_queue", client: client()! })
                }
                description={
                  <Trans>Review and resolve open content reports.</Trans>
                }
                icon={<MdReport />}
                action={
                  <Show when={queues()?.reports}>
                    {(count) => (
                      <QueueBadge
                        aria-label={t`${count()} reports awaiting review`}
                      >
                        {count()}
                      </QueueBadge>
                    )}
                  </Show>
                }
              >
                <Trans>Report queue</Trans>
              </CategoryButton>
              <CategoryButton
                onClick={() =>
                  openModal({ type: "discovery_queue", client: client()! })
                }
                description={
                  <Trans>
                    Approve or reject servers asking to be publicly listed.
                  </Trans>
                }
                icon={<MdTravelExplore />}
                action={
                  <Show when={queues()?.listings}>
                    {(count) => (
                      <QueueBadge
                        aria-label={t`${count()} listing requests awaiting review`}
                      >
                        {count()}
                      </QueueBadge>
                    )}
                  </Show>
                }
              >
                <Trans>Listing requests</Trans>
              </CategoryButton>
            </Show>
            <div style={{"--md-sys-color-primary": "#00B2FF", "--md-sys-color-on-primary": "#05090F"}}>
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

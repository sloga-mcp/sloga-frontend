import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useModals } from "@revolt/modal";
import {
  CategoryButton,
  Header,
  iconSize,
  main,
  slogaBurstKeyframes,
} from "@revolt/ui";

import MdHome from "@material-design-icons/svg/filled/home.svg?component-solid";
import MdReport from "@material-design-icons/svg/filled/report.svg?component-solid";
import MdTravelExplore from "@material-design-icons/svg/filled/travel_explore.svg?component-solid";

import { HeaderIcon } from "./common/CommonHeader";
import { CipherBanner } from "./home/CipherBanner";
import { isNewUser } from "./home/homeHub";
import { StreamerRow } from "./home/StreamerRow";
import { WelcomeTiles } from "./home/WelcomeTiles";
import { WhatsNewCard } from "./home/WhatsNewCard";

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
 * Count badge on a staff moderation tile: items still awaiting a decision.
 * Hidden entirely at zero, so a badge only ever means "there is something
 * here" and never shows a misleading 0.
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

    fontSize: "12px",
    fontWeight: 600,
    lineHeight: 1,

    background: "var(--md-sys-color-error)",
    color: "var(--md-sys-color-on-error)",
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
 * Scrolling area; the column inside it caps the line length on wide windows
 */
const content = cva({
  base: {
    ...main.raw(),

    padding: "24px 24px 48px",

    "@media (max-width: 640px)": {
      padding: "12px 12px 32px",
    },
  },
});

const Sections = styled("div", {
  base: {
    width: "100%",
    maxWidth: "780px",
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "20px",

    "@media (max-width: 640px)": {
      gap: "14px",
    },
  },
});

/**
 * Staff-only moderation queues
 */
const Staff = styled("section", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: "8px",
    padding: "8px",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-variant)",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * Home page: welcome tiles for new accounts, the Cipher banner, this
 * release's highlights, Founding Streamers, and the moderation queues for
 * staff. Everything else that used to sit here (settings, discover, support)
 * already has its own button in the app.
 */
export function HomePage() {
  const { openModal, isOpen } = useModals();
  const { t } = useLingui();
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

      // Ask the server for open reports only: automated anti-spam reports
      // grow the collection, so the unfiltered list keeps getting bigger.
      const [reports, listings] = await Promise.allSettled([
        get("/safety/reports?status=Created"),
        get("/discover/requests"),
      ]);

      // The Created filter below is kept as a guard in case the server
      // ignores the query parameter.
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

  /** No servers or no friends yet: lead with the first steps */
  const newUser = createMemo(() => {
    const c = client();
    if (!c) return false;
    return isNewUser(
      c.servers.toList().length,
      c.users.toList().filter((user) => user.relationship === "Friend").length,
    );
  });

  return (
    <Base>
      <Header placement="primary">
        <HeaderIcon>
          <MdHome {...iconSize(22)} />
        </HeaderIcon>
        <Trans>Home</Trans>
      </Header>
      <div use:scrollable={{ class: content() }}>
        <Sections>
          <Show when={newUser()}>
            <WelcomeTiles />
          </Show>
          <CipherBanner />
          <WhatsNewCard />
          <StreamerRow />
          <Show when={isPrivileged()}>
            <Staff aria-label={t`Moderation`}>
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
            </Staff>
          </Show>
        </Sections>
      </div>
    </Base>
  );
}

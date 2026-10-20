import {
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

import { Key } from "@solid-primitives/keyed";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { File as StoatFile } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import {
  type FoundingStreamer,
  fetchFoundingStreamers,
  sortStreamers,
  streamerChannelUrl,
} from "@revolt/client/foundingStreamers";
import { useNavigate } from "@revolt/routing";
import {
  Avatar,
  FOUNDING_STREAMER_COLOUR,
  iconSize,
  livePill,
} from "@revolt/ui";

import MdFlip from "@material-design-icons/svg/filled/flip_to_back.svg?component-solid";
import MdLiveTv from "@material-design-icons/svg/filled/live_tv.svg?component-solid";
import MdOpenInNew from "@material-design-icons/svg/filled/open_in_new.svg?component-solid";
import MdUndo from "@material-design-icons/svg/filled/undo.svg?component-solid";

import {
  HOME_STREAMER_LIMIT,
  primaryConnection,
  streamThumbnail,
} from "./homeHub";

/**
 * How often the row refetches while the tab is visible. Matches the
 * directory page, so the two age the same way; a live flag can still be a
 * couple of minutes behind (this poll, the server's cache and the platform
 * poller behind it).
 */
const STREAMER_POLL_INTERVAL = 60_000;

const TILE_HEIGHT = "168px";

const Section = styled("section", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    minWidth: 0,
  },
});

const Head = styled("div", {
  base: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "12px",
  },
});

const Heading = styled("h2", {
  base: {
    margin: 0,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "16px",
    fontWeight: 700,
    color: "var(--md-sys-color-on-surface)",

    "& svg": { fill: FOUNDING_STREAMER_COLOUR },
  },
});

const SeeAll = styled("button", {
  base: {
    padding: 0,
    border: 0,
    background: "none",
    font: "inherit",
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",

    "&:hover": { textDecoration: "underline" },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

/** A grid on wide screens, a swipe row on phones */
const Row = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
    gap: "10px",

    "@media (max-width: 640px)": {
      display: "flex",
      overflowX: "auto",
      scrollSnapType: "x mandatory",
      overscrollBehaviorX: "contain",
      marginInline: "-12px",
      paddingInline: "12px",
      scrollPaddingInline: "12px",
      scrollbarWidth: "none",

      "& > *": {
        flex: "0 0 132px",
        scrollSnapAlign: "start",
      },
    },
  },
});

const Tile = styled("div", {
  base: {
    position: "relative",
    height: TILE_HEIGHT,
    perspective: "800px",
  },
});

const Inner = styled("div", {
  base: {
    position: "relative",
    width: "100%",
    height: "100%",
    transformStyle: "preserve-3d",
    transition: "transform 0.5s cubic-bezier(0.3, 0.7, 0.3, 1)",

    "&[data-flipped]": { transform: "rotateY(180deg)" },

    "@media (prefers-reduced-motion: reduce)": {
      transition: "none",
    },
  },
});

const Face = styled("div", {
  base: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: "16px",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    backfaceVisibility: "hidden",
  },
  variants: {
    side: {
      front: {
        alignItems: "center",
        justifyContent: "center",
        gap: "2px",
        padding: "12px 10px",
        textAlign: "center",
      },
      back: {
        transform: "rotateY(180deg)",
      },
    },
  },
});

const Name = styled("div", {
  base: {
    marginTop: "6px",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "14px",
    fontWeight: 600,
    color: FOUNDING_STREAMER_COLOUR,
  },
});

const Meta = styled("div", {
  base: {
    fontSize: "12px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/** The Live pill as a link to the channel */
const LiveLink = styled("a", {
  base: {
    marginTop: "6px",
    textDecoration: "none",

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

const FlipButton = styled("button", {
  base: {
    position: "absolute",
    top: "6px",
    right: "6px",
    zIndex: 1,
    width: "28px",
    height: "28px",
    display: "grid",
    placeItems: "center",
    border: "1px solid var(--md-sys-color-outline-variant)",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",

    "& svg": { fill: "currentColor" },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

const Thumb = styled("div", {
  base: {
    position: "relative",
    flexShrink: 0,
    aspectRatio: "16 / 9",
    background: "var(--md-sys-color-surface-container-highest)",

    "& img": {
      width: "100%",
      height: "100%",
      objectFit: "cover",
      display: "block",
    },
  },
});

const BackText = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
    padding: "6px 10px 8px",
  },
});

const StreamTitle = styled("div", {
  base: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "12px",
    fontWeight: 600,
  },
});

const Watch = styled("a", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "12px",
    fontWeight: 600,
    color: "#3BB8ED",
    textDecoration: "none",

    "& svg": { fill: "currentColor" },
    "&:hover": { textDecoration: "underline" },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

/**
 * Founding Streamers on Home: avatar, name, platform and live state, live
 * first, with "See all" for the directory. A live tile whose channel comes
 * with a stream thumbnail gets a flip button that shows it. No server sends
 * thumbnails yet, so today no tile flips.
 *
 * Renders nothing until a load succeeds with at least one streamer.
 */
export function StreamerRow() {
  const client = useClient();
  const navigate = useNavigate();

  // Anonymous route; brand-new accounts are exactly who this row is for
  const [streamers, { refetch }] = createResource(
    () => client()?.options.baseURL,
    (baseURL) => fetchFoundingStreamers(baseURL),
  );

  onMount(() => {
    let lastFetch = Date.now();
    const poll = () => {
      lastFetch = Date.now();
      refetch();
    };

    const timer = setInterval(() => {
      if (!document.hidden) poll();
    }, STREAMER_POLL_INTERVAL);

    // Catch up when the tab comes back, throttled to the poll interval so
    // alt-tabbing cannot trip the route's rate limit
    const onVisibilityChange = () => {
      if (document.hidden) return;
      if (Date.now() - lastFetch < STREAMER_POLL_INTERVAL) return;
      poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    onCleanup(() => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    });
  });

  /**
   * `streamers.error` is the only accessor safe to read while errored
   * (`streamers()` and `.latest` throw then), and Home has no ErrorBoundary.
   * A failed poll keeps the previous list instead of emptying the row.
   */
  const tiles = createMemo<FoundingStreamer[]>(
    (prev) =>
      streamers.error
        ? prev
        : sortStreamers(streamers.latest ?? []).slice(0, HOME_STREAMER_LIMIT),
    [],
  );

  function avatarUrl(streamer: FoundingStreamer): string | undefined {
    const instance = client();
    if (!instance || !streamer.avatar) return undefined;
    // createFileURL, not previewUrl: only it checks the autumn flag
    return new StoatFile(
      instance,
      streamer.avatar as ConstructorParameters<typeof StoatFile>[1],
    ).createFileURL();
  }

  return (
    <Show when={tiles().length}>
      <Section aria-labelledby="home-streamers-title">
        <Head>
          <Heading id="home-streamers-title">
            <MdLiveTv {...iconSize(20)} />
            <Trans>Founding Streamers</Trans>
          </Heading>
          <SeeAll type="button" onClick={() => navigate("/streamers")}>
            <Trans>See all</Trans>
          </SeeAll>
        </Head>
        <Row>
          {/* Keyed by id: every poll parses fresh objects, and identity keying
              would rebuild every tile (and drop a flipped one) each minute */}
          <Key each={tiles()} by="_id">
            {(streamer) => (
              <StreamerTile
                streamer={streamer()}
                avatar={avatarUrl(streamer())}
              />
            )}
          </Key>
        </Row>
      </Section>
    </Show>
  );
}

/**
 * One streamer. Platform text (names, titles) is untrusted and only ever
 * rendered as text; links go through `streamerChannelUrl`.
 */
function StreamerTile(props: { streamer: FoundingStreamer; avatar?: string }) {
  const { t } = useLingui();
  const [flipped, setFlipped] = createSignal(false);

  const name = () => props.streamer.display_name || props.streamer.username;
  const connection = () => primaryConnection(props.streamer.connections);
  const live = () => connection()?.live === true;
  const href = () => {
    const c = connection();
    return c ? streamerChannelUrl(c) : undefined;
  };
  const thumbnail = () => streamThumbnail(connection());

  // A tile whose thumbnail goes away (stream ended) falls back to its front
  const showBack = () => flipped() && thumbnail() !== undefined;

  return (
    <Tile>
      <Inner data-flipped={showBack() ? "" : undefined}>
        <Face side="front" aria-hidden={showBack()}>
          <Show when={thumbnail()}>
            <FlipButton
              type="button"
              aria-label={t`Show what ${name()} is streaming`}
              onClick={() => setFlipped(true)}
              tabIndex={showBack() ? -1 : 0}
            >
              <MdFlip {...iconSize(16)} />
            </FlipButton>
          </Show>
          <Avatar size={44} src={props.avatar} fallback={name()} />
          <Name>{name()}</Name>
          <Meta>{connection()?.platform ?? ""}</Meta>
          <Show
            when={live() && href()}
            fallback={
              <Show
                when={live()}
                fallback={
                  <Meta style={{ "margin-top": "6px" }}>
                    <Trans>Offline</Trans>
                  </Meta>
                }
              >
                <span class={livePill()} style={{ "margin-top": "6px" }}>
                  <Trans>LIVE</Trans>
                </span>
              </Show>
            }
          >
            {(url) => (
              <LiveLink
                href={url()}
                target="_blank"
                rel="noreferrer"
                aria-label={t`Watch ${name()} live`}
              >
                <span class={livePill()} style={{ margin: 0 }}>
                  <Trans>LIVE</Trans>
                </span>
              </LiveLink>
            )}
          </Show>
        </Face>
        <Show when={thumbnail()}>
          {(src) => (
            <Face side="back" aria-hidden={!showBack()}>
              <FlipButton
                type="button"
                aria-label={t`Back to ${name()}`}
                onClick={() => setFlipped(false)}
                tabIndex={showBack() ? 0 : -1}
              >
                <MdUndo {...iconSize(16)} />
              </FlipButton>
              <Thumb>
                <img
                  src={src()}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              </Thumb>
              <BackText>
                <StreamTitle>{connection()?.live_title || name()}</StreamTitle>
                <Show when={href()}>
                  {(url) => (
                    <Watch
                      href={url()}
                      target="_blank"
                      rel="noreferrer"
                      tabIndex={showBack() ? 0 : -1}
                    >
                      <Trans>Watch on {connection()?.platform}</Trans>
                      <MdOpenInNew {...iconSize(14)} />
                    </Watch>
                  )}
                </Show>
              </BackText>
            </Face>
          )}
        </Show>
      </Inner>
    </Tile>
  );
}

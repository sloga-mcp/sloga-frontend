import {
  ErrorBoundary,
  Show,
  createMemo,
  createResource,
  onCleanup,
  onMount,
} from "solid-js";

import { Key } from "@solid-primitives/keyed";

import { Trans } from "@lingui-solid/solid/macro";
import { File as StoatFile } from "stoat.js";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import {
  type FoundingStreamer,
  fetchFoundingStreamers,
  sortStreamers,
  streamerChannelUrl,
} from "@revolt/client/foundingStreamers";
import {
  Avatar,
  Button,
  FOUNDING_STREAMER_COLOUR,
  Header,
  iconSize,
  livePill,
  main,
} from "@revolt/ui";

import MdLiveTv from "@material-design-icons/svg/filled/live_tv.svg?component-solid";

import { HeaderIcon } from "./common/CommonHeader";

/**
 * How often the directory is refetched while the tab is visible.
 *
 * Polling is load-bearing, not a nicety: a live flag only reaches this client
 * over the websocket for friends and for members of a shared server, so a
 * stranger's card would otherwise sit on whatever it showed at first paint.
 *
 * Matches `QUEUE_POLL_INTERVAL` in Home.tsx so the two background pollers age
 * the same way. It doubles as the throttle for the on-visible refetch below,
 * which keeps the directory route inside the same request budget however
 * often someone alt-tabs.
 */
const STREAMER_POLL_INTERVAL = 60_000;

/** One linked channel on a Founding Streamer's card */
type StreamerConnection = FoundingStreamer["connections"][number];

/**
 * Base layout of the streamers page
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

    gap: "var(--gap-lg)",
    padding: "var(--gap-lg)",
  },
});

/**
 * Intro copy, capped so it doesn't stretch across an ultrawide
 */
const Head = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    maxWidth: "640px",

    "& p": {
      margin: 0,
      color: "var(--md-sys-color-on-surface-variant)",
    },
  },
});

/**
 * Responsive card grid
 */
const Grid = styled("div", {
  base: {
    display: "grid",
    gap: "var(--gap-md)",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  },
});

/**
 * One streamer card.
 *
 * Unlike Discover's cards this is a plain div rather than a button: the card
 * itself carries no action, every action on it is a link out to a platform,
 * and nesting anchors inside a button is not valid markup.
 */
const Card = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    overflow: "hidden",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",

    color: "var(--md-sys-color-on-surface-variant)",
    background: "var(--md-sys-color-surface-variant)",
  },
});

const CardTitle = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    minWidth: 0,
    fontWeight: 600,

    "& span": {
      overflow: "hidden",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
    },
  },
});

const Rows = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    minWidth: 0,
  },
});

const Row = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
    minWidth: 0,
    fontSize: "0.9em",
  },
});

const Platform = styled("span", {
  base: {
    flexShrink: 0,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const ChannelLink = styled("a", {
  base: {
    color: "var(--md-sys-color-primary)",
    textDecoration: "none",
    userSelect: "text",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    minWidth: 0,

    "&:hover": {
      textDecoration: "underline",
    },
  },
});

/**
 * A channel whose URL the allowlist refused. Rendered as inert text so a
 * hostile handle can never become a destination.
 */
const ChannelName = styled("span", {
  base: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
});

const StreamTitle = styled("span", {
  base: {
    width: "100%",
    opacity: 0.8,
    fontSize: "0.9em",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
});

const Status = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "start",
    gap: "var(--gap-md)",

    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * Public Founding Streamers directory (`/streamers`).
 *
 * Every new account lands in the Welcome server and a Home tile points here,
 * so this is the shop window for the creators who brought their communities
 * over. Lists each of them with their linked Twitch / YouTube / Kick channels
 * and a LIVE pill for whichever channels are broadcasting, live ones first.
 *
 * Everything on a card that originates at a platform — `handle`,
 * `display_name`, `live_title` — is arbitrary UTF-8 relayed from Twitch,
 * YouTube or Kick and is therefore attacker-controlled. It is rendered as
 * text only, and a channel URL is never assembled here: `streamerChannelUrl`
 * owns that and origin-allowlists the result.
 */
export function FoundingStreamers() {
  const client = useClient();

  /**
   * The directory itself.
   *
   * Source-signal form on purpose: the component body runs before any JSX
   * exists, so it sits outside every ErrorBoundary, and a bare `client()!`
   * here would be an uncatchable throw if the page is ever mounted before the
   * client is ready. Solid skips the load entirely while the source is
   * undefined (`solid.cjs`: `if (lookup == null || lookup === false)`) and
   * starts it by itself once the client appears.
   */
  const [streamers, { refetch }] = createResource(
    () => client()?.options.baseURL,
    (baseURL) => fetchFoundingStreamers(baseURL),
  );

  /**
   * Refetch on a timer while the tab is visible, and once on becoming
   * visible again.
   *
   * Worst case a card is around 150s stale (this 60s poll, the server's 30s
   * cache, and the 60s platform poller behind it) — no copy on this page may
   * read as though the LIVE pill were real-time.
   */
  onMount(() => {
    let lastFetch = Date.now();

    const poll = () => {
      lastFetch = Date.now();
      refetch();
    };

    const timer = setInterval(() => {
      // Don't poll a screen nobody is looking at.
      if (!document.hidden) poll();
    }, STREAMER_POLL_INTERVAL);

    // Skipping the poll while hidden would otherwise make the copy above
    // false: a tab hidden for an hour comes back showing hour-old LIVE pills
    // and would keep them for up to another 60s.
    //
    // Throttled to the poll interval because there is no in-flight dedupe
    // across the network round trip: an unthrottled listener turns n
    // alt-tabs into n requests against an IP-rate-limited route, and tripping
    // that bucket is itself what puts the resource into the errored state.
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
   * The cards to render, live first.
   *
   * Two separate hazards are handled here, and neither guard may be dropped.
   *
   * First, `streamers.error` is the ONLY accessor that is safe to read while
   * the resource is errored. Both `streamers()` and `streamers.latest` THROW
   * in that state (solid-js 1.9.6, `solid.cjs:320` and `:382`: after a failed
   * load `loadEnd` clears `pr` and sets `resolved`, so the `!pr` guard stops
   * holding the throw back). This memo is created before the JSX, so an
   * unguarded read re-runs and throws first, aborting the update batch and
   * taking the error message down with it — leaving the page wedged on the
   * loading text forever.
   *
   * Second, the errored state must return the PREVIOUS value, not `[]`.
   * Solid keeps the last good value across a failure (`completeLoad` only
   * calls `setValue` when there is no error), so blanking the list would
   * throw away data that is still sitting in the resource: one dropped
   * request on a phone would wipe every rendered card for up to 60s.
   *
   * `sortStreamers` is pure — it sorts a copy — so the resource's own array
   * is never mutated here.
   */
  const cards = createMemo<FoundingStreamer[]>(
    (prev) => (streamers.error ? prev : sortStreamers(streamers.latest ?? [])),
    [],
  );

  /**
   * Avatar URL for a streamer.
   *
   * `createFileURL` rather than `previewUrl` because it is the only one of
   * the two that gates on the autumn feature flag (`File.ts:115-125`:
   * `if (!autumn?.enabled) return;`). `previewUrl` interpolates whatever is
   * there, so on a node with autumn configured-but-disabled it hands back a
   * URL that 404s — and any non-empty string satisfies Avatar's
   * `<Show when={props.src} keyed>`, so the initials fallback would never be
   * reached. The two build an identical string once the flag is on.
   *
   * The cast is needed because the directory route is not in the generated
   * schema, so `metadata` arrives typed `unknown`; File only reads it for
   * image dimensions.
   *
   * @param streamer Streamer whose avatar to resolve
   * @returns File URL, or undefined whenever initials should be shown instead
   */
  function avatarUrl(streamer: FoundingStreamer): string | undefined {
    const instance = client();
    if (!instance || !streamer.avatar) return undefined;

    return new StoatFile(
      instance,
      streamer.avatar as ConstructorParameters<typeof StoatFile>[1],
    ).createFileURL();
  }

  /**
   * Name to show on a card; not every account sets a display name.
   *
   * @param streamer Streamer to name
   * @returns Display name, falling back to the username
   */
  function name(streamer: FoundingStreamer): string {
    return streamer.display_name || streamer.username;
  }

  /**
   * Name to show for a linked channel; `display_name` can come back empty
   * from a platform, in which case the handle is all we have.
   *
   * @param connection Linked channel
   * @returns Channel name to render as text
   */
  function channelName(connection: StreamerConnection): string {
    return connection.display_name || connection.handle;
  }

  /**
   * Identity of a linked channel, for keying.
   *
   * A streamer can hold more than one channel on the same platform, so the
   * platform alone is not unique. Only ever used as a key — never parsed,
   * never used to build a URL.
   *
   * @param connection Linked channel
   * @returns Stable key for this channel
   */
  function connectionKey(connection: StreamerConnection): string {
    return `${connection.platform}/${connection.handle}`;
  }

  return (
    <Base>
      <Header placement="primary">
        <HeaderIcon>
          <MdLiveTv {...iconSize(22)} />
        </HeaderIcon>
        <Trans>Founding Streamers</Trans>
      </Header>
      {/*
        Belt and braces behind the guarded reads above. There is no other
        ErrorBoundary on the way to this page — the client has exactly one, in
        MyBots.tsx — so without this a throw anywhere in the subtree below
        propagates to the root and blanks the app.

        Placed inside Base and after Header on purpose: a crash then leaves
        the page chrome up, and with it HeaderIcon, which is the only way back
        to the sidebar on mobile.

        The fallback takes `reset` rather than being a static element: nothing
        else clears a tripped boundary for the lifetime of the mount, so
        without a retry control "Try again in a moment" would be advice the
        page makes impossible to follow.
      */}
      <ErrorBoundary
        fallback={(_error, reset) => (
          <div class={content()}>
            <Status>
              <Trans>
                Couldn't load the streamer list. Try again in a moment.
              </Trans>
              <Button
                variant="tonal"
                onPress={() => {
                  refetch();
                  reset();
                }}
              >
                <Trans>Try again</Trans>
              </Button>
            </Status>
          </div>
        )}
      >
        <div use:scrollable={{ class: content() }}>
          <Head>
            <p>
              <Trans>
                The creators who helped start Sloga. Follow them on Twitch,
                YouTube or Kick — channels that are broadcasting are marked LIVE
                and listed first. Live status can be a couple of minutes behind.
              </Trans>
            </p>
          </Head>

          {/*
            Resource state rather than `loading && !latest`. It covers the
            same first-load-only case, and two others besides: it never reads
            `.latest` (which throws while errored), and "unresolved" is the
            state this resource sits in while the client is still undefined,
            which would otherwise render no feedback at all.

            A retry after a failure is "refreshing", not "pending", so the
            loading text cannot co-render with the error text below.
          */}
          <Show
            when={
              streamers.state === "unresolved" || streamers.state === "pending"
            }
          >
            <Status>
              <Trans>Loading streamers…</Trans>
            </Status>
          </Show>

          {/*
            Narrowed to the case where there is genuinely nothing to show. A
            failed poll on top of good data keeps the cards (see the memo), so
            claiming the list failed to load would be a lie about data that is
            visibly on screen.
          */}
          <Show when={streamers.error && cards().length === 0}>
            <Status>
              <Trans>
                Couldn't load the streamer list. Try again in a moment.
              </Trans>
            </Status>
          </Show>

          {/* "ready" means a load actually succeeded, so this cannot fire
              while errored, still loading, or waiting on the client. */}
          <Show when={streamers.state === "ready" && cards().length === 0}>
            <Status>
              <Trans>
                No Founding Streamers are listed yet. Check back once the first
                creators have linked their channels.
              </Trans>
            </Status>
          </Show>

          <Grid>
            {/*
              Keyed, not <For>. Every poll parses fresh objects, so identity
              keying would dispose and rebuild all ~50 cards each minute —
              throwing a keyboard user back to the top of the document and
              destroying any text selection. Both lists are keyed: preserving
              the card but rebuilding its rows would lose focus just the same.
            */}
            <Key each={cards()} by="_id">
              {(streamer) => (
                <Card>
                  <CardTitle>
                    <Avatar
                      size={36}
                      src={avatarUrl(streamer())}
                      fallback={name(streamer())}
                    />
                    <span style={{ color: FOUNDING_STREAMER_COLOUR }}>
                      {name(streamer())}
                    </span>
                  </CardTitle>
                  <Rows>
                    <Key each={streamer().connections} by={connectionKey}>
                      {(connection) => (
                        <Row>
                          <Platform>{connection().platform}</Platform>
                          {/*
                            A real anchor, matching
                            ProfileConnections.tsx:29-33 and
                            Connections.tsx:163-167. Never window.open: the
                            Tauri shell silently drops it (the wry
                            on_new_window bug recorded at
                            callRecorder.ts:562-567).

                            OWED: nobody has driven these links on the desktop
                            shell or on Android yet. Until both legs are run,
                            "the links work" is a claim, not a result.
                          */}
                          <Show
                            when={streamerChannelUrl(connection())}
                            fallback={
                              <ChannelName>
                                {channelName(connection())}
                              </ChannelName>
                            }
                          >
                            {(href) => (
                              <ChannelLink
                                href={href()}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {channelName(connection())}
                              </ChannelLink>
                            )}
                          </Show>
                          <Show when={connection().live}>
                            <span class={livePill()}>
                              <Trans>LIVE</Trans>
                            </span>
                            <Show when={connection().live_title}>
                              <StreamTitle>
                                {connection().live_title}
                              </StreamTitle>
                            </Show>
                          </Show>
                        </Row>
                      )}
                    </Key>
                  </Rows>
                </Card>
              )}
            </Key>
          </Grid>
        </div>
      </ErrorBoundary>
    </Base>
  );
}

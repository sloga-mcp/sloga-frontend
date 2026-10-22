import { For, Show, createMemo, createResource, createSignal } from "solid-js";

import { Plural, Trans, useLingui } from "@lingui-solid/solid/macro";
import { type DiscoverableServerData, DiscoverableServer } from "stoat.js";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useModals } from "@revolt/modal";
import {
  Avatar,
  Button,
  Header,
  Ripple,
  TextField,
  iconSize,
  main,
} from "@revolt/ui";

import MdExplore from "@material-design-icons/svg/filled/explore.svg?component-solid";

import { HeaderIcon } from "./common/CommonHeader";
import {
  MAX_QUERY_LENGTH,
  fetchDiscoverPage as fetchPage,
} from "./discoverApi";

/**
 * Debounce applied to the search box before a request is sent, so a
 * fast typist doesn't burn through the public discover ratelimit bucket.
 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Base layout of the discover page
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
 * Intro copy + search box, capped so it doesn't stretch across an ultrawide
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
 * One server card: banner (or a tinted stand-in), then icon + name +
 * description + member count. Clicking anywhere opens the join prompt.
 */
const Card = styled("button", {
  base: {
    all: "unset",
    position: "relative",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    cursor: "pointer",
    textAlign: "start",
    borderRadius: "var(--borderRadius-lg)",

    color: "var(--md-sys-color-on-surface-variant)",
    background: "var(--md-sys-color-surface-variant)",

    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
    },
  },
});

const Banner = styled("div", {
  base: {
    height: "96px",
    backgroundSize: "cover",
    backgroundPosition: "center",
    background: "var(--md-sys-color-surface-container-highest)",
  },
});

const CardBody = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-md)",
  },
});

const CardTitle = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface)",

    "& span": {
      overflow: "hidden",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
    },
  },
});

const Description = styled("div", {
  base: {
    fontSize: "0.9em",
    lineClamp: 3,
  },
});

const Meta = styled("div", {
  base: {
    fontSize: "0.85em",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Status = styled("div", {
  base: {
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const More = styled("div", {
  base: {
    display: "flex",
    justifyContent: "center",
    paddingBlock: "var(--gap-md)",
  },
});

/**
 * Public server directory (`/discover`): the in-app twin of sloga.gg/discover.
 * Lists servers that opted in and were approved for listing; picking one
 * opens the same join prompt the website's "Open Sloga" buttons land on.
 */
export function Discover() {
  const { t } = useLingui();
  const client = useClient();
  const { openModal, showError } = useModals();

  const [rawQuery, setRawQuery] = createSignal("");
  const [query, setQuery] = createSignal("");
  let debounce: ReturnType<typeof setTimeout> | undefined;

  /**
   * Debounced query update; also resets pagination
   */
  function onInput(value: string) {
    setRawQuery(value);
    clearTimeout(debounce);
    debounce = setTimeout(() => setQuery(value.trim()), SEARCH_DEBOUNCE_MS);
  }

  // Extra pages appended by "Load more" for the CURRENT query
  const [extra, setExtra] = createSignal<DiscoverableServerData[]>([]);
  const [loadingMore, setLoadingMore] = createSignal(false);

  const [firstPage] = createResource(query, (q) => {
    setExtra([]);
    return fetchPage(client()!.options.baseURL, q, 0);
  });

  const cards = () => [...(firstPage()?.servers ?? []), ...extra()];
  const servers = createMemo(() =>
    cards().map((data) => new DiscoverableServer(client()!, data)),
  );
  const total = () => firstPage()?.total ?? cards().length;
  const hasMore = () => cards().length < total();

  /**
   * Fetch the next page for the current query
   */
  async function loadMore() {
    if (loadingMore()) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(
        client()!.options.baseURL,
        query(),
        cards().length,
      );
      setExtra((list) => [...list, ...page.servers]);
    } catch (error) {
      showError(error);
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Open the join prompt for a card
   */
  function open(server: DiscoverableServer) {
    openModal({ type: "discover_join", server });
  }

  return (
    <Base>
      <Header placement="primary">
        <HeaderIcon>
          <MdExplore {...iconSize(22)} />
        </HeaderIcon>
        <Trans>Discover</Trans>
      </Header>
      <div use:scrollable={{ class: content() }}>
        <Head>
          <p>
            <Trans>
              Public communities on Sloga. Servers appear here after their owner
              requests a listing and it is approved.
            </Trans>
          </p>
          <TextField
            value={rawQuery()}
            variant="filled"
            type="search"
            placeholder={t`Search communities…`}
            maxlength={MAX_QUERY_LENGTH}
            onInput={(e) => onInput(e.currentTarget.value)}
          />
        </Head>

        <Show when={firstPage.loading && !firstPage.latest}>
          <Status>
            <Trans>Loading communities…</Trans>
          </Status>
        </Show>

        <Show when={firstPage.error}>
          <Status>
            <Trans>Couldn't load the directory. Try again in a moment.</Trans>
          </Status>
        </Show>

        <Show when={firstPage() && cards().length === 0}>
          <Status>
            <Show
              when={query()}
              fallback={
                <Trans>
                  No communities are listed yet. Server owners can request a
                  listing from Server Settings → Overview.
                </Trans>
              }
            >
              <Trans>No communities match your search.</Trans>
            </Show>
          </Status>
        </Show>

        <Grid>
          <For each={servers()}>
            {(server) => (
              <Card onClick={() => open(server)}>
                <Ripple />
                <Banner
                  style={
                    server.banner
                      ? {
                          "background-image": `url(${server.banner.originalUrl})`,
                        }
                      : undefined
                  }
                />
                <CardBody>
                  <CardTitle>
                    <Avatar
                      size={36}
                      src={server.icon?.previewUrl}
                      fallback={server.name}
                    />
                    <span>{server.name}</span>
                  </CardTitle>
                  <Show when={server.description}>
                    <Description>{server.description}</Description>
                  </Show>
                  <Meta>
                    <Plural
                      value={server.memberCount}
                      one="# member"
                      other="# members"
                    />
                  </Meta>
                </CardBody>
              </Card>
            )}
          </For>
        </Grid>

        <Show when={hasMore()}>
          <More>
            <Button
              variant="tonal"
              isDisabled={loadingMore()}
              onPress={loadMore}
            >
              <Trans>Load more</Trans>
            </Button>
          </More>
        </Show>
      </div>
    </Base>
  );
}

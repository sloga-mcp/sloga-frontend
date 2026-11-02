import { For, Show, createMemo, createResource } from "solid-js";

import { Plural, Trans } from "@lingui-solid/solid/macro";
import {
  type Client,
  type DiscoverableServerData,
  DiscoverableServer,
} from "stoat.js";

import { useClient } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import { Avatar } from "@revolt/ui";

import MdExplore from "@material-design-icons/svg/filled/explore.svg?component-solid";

import { fetchDiscoverPage } from "../discoverApi";

import {
  List,
  Panel,
  PanelHead,
  PanelLink,
  PanelTitle,
  RowLink,
  RowMeta,
  RowName,
  RowText,
} from "./cardParts";
import { HOME_DISCOVER_CACHE_MS, pickDiscover } from "./homeHub";

/**
 * The directory's first page from an earlier visit, reused for a while so
 * Home does not spend the public discover rate limit on every visit. Kept per
 * client, like the other Home caches.
 */
const pageCache = new WeakMap<
  Client,
  { at: number; servers: DiscoverableServerData[] }
>();

/**
 * Read the directory's first page, from the cache when it is fresh
 * @param client Client
 */
async function directory(client: Client): Promise<DiscoverableServerData[]> {
  const cached = pageCache.get(client);
  if (cached && Date.now() - cached.at < HOME_DISCOVER_CACHE_MS) {
    return cached.servers;
  }
  const page = await fetchDiscoverPage(client.options.baseURL, "", 0);
  const servers = Array.isArray(page?.servers) ? page.servers : [];
  pageCache.set(client, { at: Date.now(), servers });
  return servers;
}

/**
 * State behind "Servers you might like": a few public servers the viewer is
 * not in. Kept apart from the card so Home can leave the card out when the
 * directory has nothing new to offer, or cannot be reached.
 * @param enabled Whether the card is switched on; nothing is fetched while off
 */
export function createDiscoverPicksState(enabled: () => boolean) {
  const client = useClient();

  const [page] = createResource(
    () => (enabled() ? client() : undefined),
    (c) => directory(c),
  );

  const picks = createMemo(() => {
    const c = client();
    if (!c || page.error) return [];
    const joined = new Set(c.servers.toList().map((server) => server.id));
    return pickDiscover(page.latest, joined).map(
      (data) => new DiscoverableServer(c, data),
    );
  });

  // First load only ("pending"; a refetch with a page already here is
  // "refreshing"). `state` never reads the value, so it cannot suspend.
  const loading = () => page.state === "pending";

  return { picks, loading };
}

/**
 * "Servers you might like": a few public servers from the directory that the
 * viewer is not in. A row opens the same join prompt as the Discover page.
 */
export function DiscoverPicks(props: {
  state: ReturnType<typeof createDiscoverPicksState>;
}) {
  const { openModal } = useModals();
  const navigate = useNavigate();

  return (
    <Panel aria-labelledby="home-discover-title">
      <PanelHead>
        <PanelTitle id="home-discover-title">
          <MdExplore />
          <Trans>Servers you might like</Trans>
        </PanelTitle>
        <PanelLink type="button" onClick={() => navigate("/discover")}>
          <Trans>Browse Discover</Trans>
        </PanelLink>
      </PanelHead>
      <List>
        <For each={props.state.picks()}>
          {(server) => (
            <li>
              <RowLink
                href="/discover"
                onClick={(event) => {
                  event.preventDefault();
                  openModal({ type: "discover_join", server });
                }}
              >
                <Avatar
                  size={36}
                  src={server.icon?.previewUrl}
                  fallback={server.name}
                />
                <RowText>
                  <RowName>{server.name}</RowName>
                  <RowMeta>
                    <Show
                      when={server.description}
                      fallback={
                        <Plural
                          value={server.memberCount}
                          one="# member"
                          other="# members"
                        />
                      }
                    >
                      {server.description}
                    </Show>
                  </RowMeta>
                </RowText>
              </RowLink>
            </li>
          )}
        </For>
      </List>
    </Panel>
  );
}

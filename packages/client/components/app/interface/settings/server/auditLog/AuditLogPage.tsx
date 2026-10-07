import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type {
  AuditLogAction,
  AuditLogEntryData,
  AuditLogPage as AuditLogPageData,
  AuditLogQuery,
  Server,
} from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useError } from "@revolt/i18n";
import { userInformation } from "@revolt/markdown/users";
import { useModals } from "@revolt/modal";
import {
  Button,
  CircularProgress,
  Column,
  FloatingSelect,
  Row,
  Text,
} from "@revolt/ui";
import { MenuItem } from "@revolt/ui/components/design/Menu";

import { type AuditUser, AuditEntryRow } from "./AuditEntryRow";
import { KNOWN_AUDIT_ACTIONS } from "./auditEntryModel";

/** Entries per page */
const PAGE_SIZE = 50;

/** Select value meaning "no filter" (the select cannot show an empty value) */
const ALL = "all";

/** A user as the audit log route returns them */
type PageUser = AuditLogPageData["users"][number];

/**
 * Server audit log: who did what, newest first, filterable by action and by
 * the member who took it.
 */
export function AuditLogPage(props: { server: Server }) {
  const { t } = useLingui();
  const client = useClient();
  const err = useError();
  const { showError } = useModals();

  const [action, setAction] = createSignal<AuditLogAction>();
  const [actorFilter, setActorFilter] = createSignal<string>();

  const [entries, setEntries] = createSignal<AuditLogEntryData[]>([]);
  const [users, setUsers] = createSignal<Map<string, PageUser>>(new Map());
  // Every actor seen in any loaded page, in first-seen order, so narrowing
  // the action filter does not shrink the actor list out from under the user
  const [seenActors, setSeenActors] = createSignal<string[]>([]);

  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<unknown>();
  const [exhausted, setExhausted] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);

  // One clock for every row's relative time, ticking once a minute
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    onCleanup(() => clearInterval(timer));
  });

  // Bumped by every reset of the list. A page that was in flight across a
  // reset belongs to the old filters (or server), so it is dropped when it
  // lands instead of being shown or appended.
  let generation = 0;

  /**
   * Build the query for a page, leaving out every unset key: the server
   * reads an empty `user=` as a filter on an empty actor id
   */
  function pageQuery(before?: string): AuditLogQuery {
    const query: AuditLogQuery = { limit: PAGE_SIZE };
    if (before) query.before = before;
    const selectedAction = action();
    if (selectedAction) query.action = selectedAction;
    const user = actorFilter();
    if (user) query.user = user;
    return query;
  }

  /**
   * Remember a page's users and actors
   */
  function absorb(page: AuditLogPageData) {
    // Entries written after the last tick would otherwise read "in a few
    // seconds" until the next one
    setNow(Date.now());

    setUsers((current) => {
      const next = new Map(current);
      for (const user of page.users) next.set(user._id, user);
      return next;
    });

    setSeenActors((current) => {
      const known = new Set(current);
      const added: string[] = [];
      for (const entry of page.entries) {
        if (entry.actor && !known.has(entry.actor)) {
          known.add(entry.actor);
          added.push(entry.actor);
        }
      }
      return added.length ? [...current, ...added] : current;
    });
  }

  /**
   * Drop everything loaded and fetch the first page for the current filters
   */
  async function loadFirstPage() {
    const started = ++generation;
    setEntries([]);
    setExhausted(false);
    setLoadingMore(false);
    setError(undefined);
    setLoading(true);

    try {
      const page = await props.server.fetchAuditLog(pageQuery());
      if (started !== generation) return;
      absorb(page);
      setEntries(page.entries);
      // The end of the log is an empty page, never a short one
      setExhausted(page.entries.length === 0);
    } catch (failure) {
      if (started === generation) setError(failure);
    } finally {
      if (started === generation) setLoading(false);
    }
  }

  /**
   * Fetch the page after the oldest entry on screen
   */
  async function loadMore() {
    const tail = entries().at(-1);
    if (!tail || loadingMore() || exhausted()) return;
    const started = generation;
    setLoadingMore(true);

    try {
      const page = await props.server.fetchAuditLog(pageQuery(tail._id));
      // The filters changed while this page was loading
      if (started !== generation) return;
      absorb(page);
      if (page.entries.length === 0) {
        setExhausted(true);
      } else {
        setEntries((current) => {
          const ids = new Set(current.map((entry) => entry._id));
          return [
            ...current,
            ...page.entries.filter((entry) => !ids.has(entry._id)),
          ];
        });
      }
    } catch (failure) {
      // A failure for a list that has since been reset is stale too
      if (started === generation) showError(failure);
    } finally {
      if (started === generation) setLoadingMore(false);
    }
  }

  // First page on mount, and again whenever a filter or the server changes
  createEffect(
    on([() => props.server.id, action, actorFilter], () => {
      void loadFirstPage();
    }),
  );

  /**
   * Resolve a user: the client's copy (hydrated from the page) with their
   * membership of this server, else the raw page user, else a deleted user
   */
  function resolveUser(id: string): AuditUser {
    const member = client().serverMembers.getByKey({
      server: props.server.id,
      user: id,
    });

    const user = client().users.get(id);
    if (user) {
      const info = userInformation(user, member);
      return { name: info.username, avatar: info.avatar, user, member };
    }

    const pageUser = users().get(id);
    if (pageUser) {
      return {
        name: pageUser.display_name ?? pageUser.username,
        member,
      };
    }

    return { name: t`Deleted User`, member };
  }

  /**
   * Human label for each action, for the action filter
   */
  function actionLabel(value: AuditLogAction) {
    switch (value) {
      case "member_kick":
        return t`Kick member`;
      case "member_ban_add":
        return t`Ban member`;
      case "member_ban_remove":
        return t`Unban member`;
      case "member_timeout":
        return t`Timeout member`;
      case "member_timeout_remove":
        return t`Remove timeout`;
      case "member_role_update":
        return t`Change member roles`;
      case "member_update":
        return t`Change member profile`;
      case "member_voice_update":
        return t`Change member voice permissions`;
      case "member_move":
        return t`Move member`;
      case "member_disconnect":
        return t`Disconnect member`;
      case "message_delete":
        return t`Delete message`;
      case "message_bulk_delete":
        return t`Bulk delete messages`;
      case "channel_create":
        return t`Create channel`;
      case "channel_update":
        return t`Change channel`;
      case "channel_delete":
        return t`Delete channel`;
      case "channel_overwrite_update":
        return t`Change channel permissions`;
      case "server_permissions_update":
        return t`Change server permissions`;
      case "role_create":
        return t`Create role`;
      case "role_update":
        return t`Change role`;
      case "role_delete":
        return t`Delete role`;
      case "role_ranks_update":
        return t`Reorder roles`;
      case "server_update":
        return t`Change server settings`;
      case "server_owner_transfer":
        return t`Transfer ownership`;
      default: {
        const _exhaustive: never = value;
        return String(value);
      }
    }
  }

  // The route's permission gate: a 403 for a viewer without View Audit Log
  const isForbidden = createMemo(
    () =>
      (error() as { type?: unknown } | undefined)?.type === "MissingPermission",
  );

  const filtered = () => !!action() || !!actorFilter();

  return (
    <Column gap="lg">
      <Filters>
        <FilterField>
          <FloatingSelect
            label={t`Action`}
            value={action() ?? ALL}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (!value) return;
              setAction(KNOWN_AUDIT_ACTIONS.find((known) => known === value));
            }}
          >
            <MenuItem value={ALL}>
              <Trans>All actions</Trans>
            </MenuItem>
            <For each={KNOWN_AUDIT_ACTIONS}>
              {(value) => (
                <MenuItem value={value}>{actionLabel(value)}</MenuItem>
              )}
            </For>
          </FloatingSelect>
        </FilterField>

        <FilterField>
          <FloatingSelect
            label={t`Performed by`}
            value={actorFilter() ?? ALL}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (!value) return;
              setActorFilter(value === ALL ? undefined : value);
            }}
          >
            <MenuItem value={ALL}>
              <Trans>Anyone</Trans>
            </MenuItem>
            <For each={seenActors()}>
              {(id) => <MenuItem value={id}>{resolveUser(id).name}</MenuItem>}
            </For>
          </FloatingSelect>
        </FilterField>
      </Filters>

      <Switch>
        <Match when={loading()}>
          <Row justify>
            <CircularProgress />
          </Row>
        </Match>

        <Match when={isForbidden()}>
          <Text class="label">
            <Trans>
              You need the View Audit Log permission to see this server's audit
              log.
            </Trans>
          </Text>
        </Match>

        <Match when={error() !== undefined}>
          <Column>
            <Text class="label">{err(error())}</Text>
            <Row>
              <Button size="sm" onPress={() => void loadFirstPage()}>
                <Trans>Try again</Trans>
              </Button>
            </Row>
          </Column>
        </Match>

        <Match when={entries().length === 0}>
          <Text class="label">
            <Show
              when={filtered()}
              fallback={<Trans>No audit log entries yet.</Trans>}
            >
              <Trans>No entries match these filters.</Trans>
            </Show>
          </Text>
        </Match>

        <Match when={entries().length > 0}>
          <Column gap="sm">
            <For each={entries()}>
              {(entry) => (
                <AuditEntryRow
                  entry={entry}
                  server={props.server}
                  resolveUser={resolveUser}
                  now={now}
                />
              )}
            </For>
          </Column>

          <Show when={!exhausted()}>
            <Row justify>
              <Button
                size="sm"
                variant="text"
                isDisabled={loadingMore()}
                onPress={() => void loadMore()}
              >
                <Show when={!loadingMore()} fallback={<CircularProgress />}>
                  <Trans>Load more</Trans>
                </Show>
              </Button>
            </Row>
          </Show>
        </Match>
      </Switch>
    </Column>
  );
}

const Filters = styled("div", {
  base: {
    display: "flex",
    gap: "12px",
    mdDown: {
      flexDirection: "column",
    },
  },
});

const FilterField = styled("div", {
  base: {
    flex: "1 1 0",
    minWidth: 0,
  },
});

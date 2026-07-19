import { For, Match, Switch, createResource, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { Server } from "stoat.js";
import { css } from "styled-system/css";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import {
  Avatar,
  Button,
  CategoryButton,
  CircularProgress,
  Column,
  Text,
} from "@revolt/ui";

interface CatalogBot {
  _id: string;
  username: string;
  avatar?: string;
  description?: string;
}

interface CatalogEntry {
  tagline?: string;
  bot: CatalogBot;
}

/**
 * Per-bot add-button state. Membership probes fail NEUTRAL ("unavailable"),
 * never open to an active Add — a transient probe error must not invite a
 * redundant invite call.
 */
type AddState = "probing" | "absent" | "added" | "busy" | "unavailable" | "error";

/**
 * Curated "Add apps" catalog for server settings — operator-hosted
 * first-party bots (Sloga Helper et al.), served from the config-driven
 * `GET /discover/apps` route. Section is ManageServer-gated to match the
 * backend invite permission.
 */
export function AppsList(props: { server: Server }) {
  const { t } = useLingui();
  const client = useClient();
  const [status, setStatus] = createSignal<Record<string, AddState>>({});

  function authHeaders(): Record<string, string> {
    const [key, value] = client().authenticationHeader;
    return { [key]: value };
  }

  const [apps] = createResource<CatalogEntry[]>(async () => {
    // Never throw: a rejected fetch would put the resource into error state
    // and crash the panel render — fail to the empty state instead.
    try {
      const res = await fetch(`${CONFIGURATION.DEFAULT_API_URL}/discover/apps`, {
        headers: authHeaders(),
      });
      if (!res.ok) return [];
      const body = await res.json();
      const entries: CatalogEntry[] = body.apps ?? [];
      void probeMembership(entries);
      return entries;
    } catch {
      return [];
    }
  });

  async function probeMembership(entries: CatalogEntry[]) {
    for (const entry of entries) {
      let next: AddState = "unavailable";
      try {
        const res = await fetch(
          `${CONFIGURATION.DEFAULT_API_URL}/servers/${props.server.id}/members/${entry.bot._id}`,
          { headers: authHeaders() },
        );
        if (res.ok) next = "added";
        else if (res.status === 404) next = "absent";
      } catch {
        // keep "unavailable"
      }
      setStatus((current) => ({ ...current, [entry.bot._id]: next }));
    }
  }

  async function addBot(botId: string) {
    setStatus((current) => ({ ...current, [botId]: "busy" }));
    let next: AddState = "error";
    try {
      const res = await fetch(
        `${CONFIGURATION.DEFAULT_API_URL}/bots/${botId}/invite`,
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ server: props.server.id }),
        },
      );
      if (res.ok) next = "added";
    } catch {
      // keep "error"
    }
    setStatus((current) => ({ ...current, [botId]: next }));
  }

  function action(bot: CatalogBot) {
    const state = status()[bot._id] ?? "probing";
    switch (state) {
      case "probing":
      case "busy":
        return <CircularProgress />;
      case "added":
        return (
          <Text class="label" size="small">
            <Trans>Added ✓</Trans>
          </Text>
        );
      case "unavailable":
        return (
          <Text class="label" size="small">
            <Trans>Unavailable</Trans>
          </Text>
        );
      case "error":
      case "absent":
        return (
          <Button size="sm" onPress={() => void addBot(bot._id)}>
            {state === "error" ? <Trans>Retry</Trans> : <Trans>Add</Trans>}
          </Button>
        );
    }
  }

  return (
    <Column gap="lg">
      <Text class="label">
        <Trans>
          Official apps hosted by Sloga. Adding one gives this server its
          slash commands — type / in any channel to use them.
        </Trans>
      </Text>

      <Column gap="sm">
        <Switch>
          <Match when={apps.loading}>
            <CircularProgress />
          </Match>
          <Match when={apps()?.length === 0}>
            <span>{t`No apps are available right now.`}</span>
          </Match>
          <Match when={apps()}>
            <For each={apps()}>
              {(entry) => (
                <CategoryButton
                  roundedIcon={false}
                  icon={
                    <Avatar
                      size={32}
                      src={
                        entry.bot.avatar
                          ? `${CONFIGURATION.DEFAULT_MEDIA_URL}/avatars/${entry.bot.avatar}`
                          : undefined
                      }
                      fallback={entry.bot.username}
                    />
                  }
                  description={
                    <Switch fallback={entry.tagline ?? entry.bot.description}>
                      <Match when={status()[entry.bot._id] === "error"}>
                        <Trans>Couldn't add the app — try again.</Trans>
                      </Match>
                    </Switch>
                  }
                  action={action(entry.bot)}
                >
                  <span class={css({ flex: 1 })}>
                    {entry.bot.username}{" "}
                    <Text class="label" size="small">
                      <Trans>Official</Trans>
                    </Text>
                  </span>
                </CategoryButton>
              )}
            </For>
          </Match>
        </Switch>
      </Column>
    </Column>
  );
}

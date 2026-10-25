import { For, Show, createMemo, createResource, untrack } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import type { Channel, Client, Message } from "stoat.js";

import { useClient } from "@revolt/client";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { Avatar, Time } from "@revolt/ui";

import MdAlternateEmail from "@material-design-icons/svg/filled/alternate_email.svg?component-solid";

import { isChannelGatedForMember } from "../channels/memberGate";

import {
  Empty,
  List,
  Panel,
  PanelHead,
  PanelTitle,
  RowLink,
  RowMeta,
  RowQuote,
  RowText,
} from "./cardParts";
import {
  HOME_MENTION_CONCURRENCY,
  mentionPreview,
  pickMentionIds,
} from "./homeHub";

/**
 * Mentioned messages fetched on an earlier visit, by id. Kept per client:
 * signing out replaces the client, so one account never sees another
 * account's messages.
 */
const messageCache = new WeakMap<Client, Map<string, Message>>();

/** One fetched mention */
type MentionRow = { channel: Channel; message: Message };

/**
 * Fetch the picked messages, a couple at a time, reusing ones fetched before.
 * A message that fails to load (deleted, no access) is left out.
 */
async function loadMentions(
  client: Client,
  picks: { channel: Channel; messageId: string }[],
): Promise<MentionRow[]> {
  let cache = messageCache.get(client);
  if (!cache) {
    cache = new Map();
    messageCache.set(client, cache);
  }

  const rows: (MentionRow | undefined)[] = new Array(picks.length);
  let next = 0;
  const worker = async () => {
    while (next < picks.length) {
      const index = next++;
      const { channel, messageId } = picks[index];
      try {
        const message =
          cache.get(messageId) ?? (await channel.fetchMessage(messageId));
        cache.set(messageId, message);
        rows[index] = { channel, message };
      } catch {
        // gone or not ours to read: skip it
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(HOME_MENTION_CONCURRENCY, picks.length) },
      worker,
    ),
  );
  return rows.filter((row) => row !== undefined);
}

/**
 * Unread messages in servers that mention the viewer, newest first. Direct
 * messages are not here: every one of them already shows in "Jump back in".
 * Muted servers and channels, and channels behind a gate, are left out.
 */
export function UnreadMentions() {
  const client = useClient();
  const state = useState();

  /** The newest mentions, as "channelId:messageId" so the fetch only reruns when they change */
  const picks = createMemo(() => {
    const c = client();
    if (!c) return [];

    const channels = new Map<string, Channel>();
    const candidates = [];
    for (const server of state.ordering.orderedServers(c)) {
      if (state.notifications.isMuted(server)) continue;
      for (const channel of server.channels) {
        const ids = channel.mentions;
        if (!ids || ids.size === 0 || channel.muted) continue;
        if (
          isChannelGatedForMember(
            channel,
            (key) => state.layout.getSectionState(key, false),
            LAYOUT_SECTIONS.MATURE,
          )
        ) {
          continue;
        }
        channels.set(channel.id, channel);
        candidates.push({ channelId: channel.id, messageIds: [...ids] });
      }
    }

    return pickMentionIds(candidates).map((pick) => ({
      channel: channels.get(pick.channelId)!,
      messageId: pick.messageId,
    }));
  });

  const key = createMemo(() =>
    picks()
      .map((pick) => pick.messageId)
      .join(","),
  );

  // Refetches only when the set of mentions changes; read untracked below so
  // unrelated store traffic cannot start another round of fetches
  const [mentions] = createResource(
    () => key() || false,
    () => loadMentions(untrack(client)!, untrack(picks)),
  );

  /** Rows still unread: reading a channel clears its mentions before the fetch reruns */
  const rows = createMemo(() => {
    if (mentions.error) return [];
    const unread = new Set(picks().map((pick) => pick.messageId));
    // Blocked authors stay out, as they do in chat and in notifications
    return (mentions.latest ?? []).filter(
      (row) =>
        unread.has(row.message.id) &&
        row.message.author?.relationship !== "Blocked",
    );
  });

  /**
   * The text a row shows. A message the E2EE layer owns never has its text
   * read here, so ciphertext can never reach the card.
   */
  const preview = (message: Message) => {
    if (client()?.e2ee?.isEncryptedMessage(message.id)) return undefined;
    return mentionPreview(message.content, {
      user: (id) => client()?.users.get(id)?.displayName,
      channel: (id) => client()?.channels.get(id)?.name,
    });
  };

  return (
    <Panel aria-labelledby="home-mentions-title">
      <PanelHead>
        <PanelTitle id="home-mentions-title">
          <MdAlternateEmail />
          <Trans>Mentions</Trans>
        </PanelTitle>
      </PanelHead>
      <Show
        when={rows().length > 0}
        fallback={
          <Show when={!mentions.loading}>
            <Empty>
              <span>
                <Trans>No new mentions.</Trans>
              </span>
            </Empty>
          </Show>
        }
      >
        <List>
          <For each={rows()}>
            {(row) => (
              <li>
                <RowLink
                  href={`/server/${row.channel.serverId}/channel/${row.channel.id}/${row.message.id}`}
                >
                  <Avatar
                    size={32}
                    src={row.message.animatedAvatarURL ?? row.message.avatarURL}
                    fallback={row.message.username}
                  />
                  <RowText>
                    <RowMeta>
                      {[
                        row.message.username,
                        row.channel.server?.name,
                        `#${row.channel.name}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      {" · "}
                      <Time format="relative" value={row.message.createdAt} />
                    </RowMeta>
                    <RowQuote>
                      {preview(row.message) ?? <Trans>Open to read</Trans>}
                    </RowQuote>
                  </RowText>
                </RowLink>
              </li>
            )}
          </For>
        </List>
      </Show>
    </Panel>
  );
}

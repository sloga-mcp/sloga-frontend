import { For, Show, createMemo, createResource, createSignal } from "solid-js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useState } from "@revolt/state";
import { Avatar, Ripple, TextField } from "@revolt/ui/components/design";

import {
  CompositionMediaPickerContext,
  compositionContent,
} from "./CompositionMediaPicker";
import { useContext } from "solid-js";

interface Sticker {
  id: string;
  server_id: string;
  creator_id: string;
  name: string;
  description?: string;
  file_id: string;
  format: string;
  nsfw?: boolean;
}

/**
 * Sticker picker for message composition
 */
export function StickerPicker() {
  const client = useClient();
  const state = useState();
  const { onMessage } = useContext(CompositionMediaPickerContext);

  const [filter, setFilter] = createSignal("");

  const servers = createMemo(() => state.ordering.orderedServers(client()));

  function getMediaUrl() {
    return client()?.configuration?.features.autumn.url ?? "";
  }

  function getStickerUrl(fileId: string) {
    return `${getMediaUrl()}/stickers/${fileId}`;
  }

  // Fetch stickers for all servers
  const [allServerStickers] = createResource(
    () => servers().map((s) => s.id),
    async (serverIds) => {
      const [key, value] = client().authenticationHeader;
      const results: Record<string, Sticker[]> = {};
      await Promise.all(
        serverIds.map(async (id) => {
          try {
            const res = await fetch(
              `${CONFIGURATION.DEFAULT_API_URL}/custom/server/${id}/stickers`,
              { headers: { [key]: value } },
            );
            if (res.ok) results[id] = await res.json();
            else results[id] = [];
          } catch {
            results[id] = [];
          }
        }),
      );
      return results;
    },
  );

  const filteredStickers = createMemo(() => {
    const data = allServerStickers();
    if (!data) return [];
    const filterText = filter().toLowerCase();
    const result: Array<{ sticker: Sticker; serverId: string }> = [];

    for (const server of servers()) {
      const stickers = data[server.id] ?? [];
      for (const sticker of stickers) {
        if (!filterText || sticker.name.toLowerCase().includes(filterText)) {
          result.push({ sticker, serverId: server.id });
        }
      }
    }

    return result;
  });

  function sendSticker(fileId: string) {
    onMessage(getStickerUrl(fileId));
  }

  return (
    <Stack>
      <TextField
        autoFocus
        variant="filled"
        placeholder="Search for stickers..."
        value={filter()}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }}
        onInput={(e) => setFilter(e.currentTarget.value)}
      />
      <div class={compositionContent()}>
        <StickerGrid>
          <Show
            when={filteredStickers().length > 0}
            fallback={
              <EmptyState>
                <span>No stickers available. Add stickers to your servers!</span>
              </EmptyState>
            }
          >
            <For each={servers()}>
              {(server) => {
                const serverStickers = createMemo(() =>
                  filteredStickers()
                    .filter((s) => s.serverId === server.id)
                    .map((s) => s.sticker),
                );
                return (
                  <Show when={serverStickers().length > 0}>
                    <ServerSection>
                      <ServerHeader>
                        <Avatar
                          size={20}
                          src={(server as any).animatedIconURL}
                          fallback={server.name}
                        />
                        <span>{server.name}</span>
                      </ServerHeader>
                      <StickerRow>
                        <For each={serverStickers()}>
                          {(sticker) => (
                            <StickerItem
                              onClick={() => sendSticker(sticker.file_id)}
                              title={sticker.name}
                            >
                              <Ripple />
                              <img
                                src={getStickerUrl(sticker.file_id)}
                                alt={sticker.name}
                                loading="lazy"
                              />
                            </StickerItem>
                          )}
                        </For>
                      </StickerRow>
                    </ServerSection>
                  </Show>
                );
              }}
            </For>
          </Show>
        </StickerGrid>
      </div>
    </Stack>
  );
}

const Stack = styled("div", {
  base: {
    minHeight: 0,
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    overflow: "hidden",
  },
});

const StickerGrid = styled("div", {
  base: {
    // fill the flex-sized wrapper so the grid actually overflows and
    // scrolls (without a height it grows to content and just gets clipped)
    height: "100%",
    overflowY: "auto",
    flexGrow: 1,
    padding: "0 var(--gap-md)",
    scrollbarColor: "var(--md-sys-color-primary) transparent",
    scrollbarWidth: "thin",
  },
});

const EmptyState = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "200px",
    color: "var(--md-sys-color-on-surface-variant)",
    textAlign: "center",
    padding: "var(--gap-lg)",
  },
});

const ServerSection = styled("div", {
  base: {
    marginBottom: "var(--gap-md)",
  },
});

const ServerHeader = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "var(--gap-xs) 0",
    fontWeight: "600",
    fontSize: "0.85em",
    color: "var(--md-sys-color-on-surface-variant)",
    marginBottom: "var(--gap-xs)",
  },
});

const StickerRow = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "var(--gap-sm)",
  },
});

const StickerItem = styled("div", {
  base: {
    position: "relative",
    cursor: "pointer",
    borderRadius: "var(--borderRadius-md)",
    overflow: "hidden",
    padding: "var(--gap-xs)",
    aspectRatio: "1",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },

    "& img": {
      width: "100%",
      height: "100%",
      objectFit: "contain",
    },
  },
});

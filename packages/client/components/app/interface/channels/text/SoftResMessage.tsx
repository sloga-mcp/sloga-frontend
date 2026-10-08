import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type {
  Client,
  Message,
  SoftResCatalogItemData,
  SoftResData,
  SoftResReserveData,
  WowClass,
} from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { serverActionsBlocked } from "./e2eeTranscriptTrust";
import {
  WOW_CLASS_COLORS,
  WOW_CLASS_NAMES,
  WOW_QUALITY_COLORS,
} from "./softresData";

/**
 * Soft-reserve message flag (bit 9). Server-assigned only: the regular
 * send path rejects client-supplied flag values above 7, so a message
 * carrying this bit (plus the embedded definition) is a guaranteed
 * server-authoritative sheet.
 */
export const FLAG_SOFTRES = 1 << 9;

/**
 * Master switch for the soft-reserve CREATION affordances (composer
 * button, `/softres` command, event-page create button). Flipped on
 * 2026-07-27 after the per-raid catalog verification pass (all 40 raids
 * audited against community sources; fixes landed in the backend
 * catalog generator).
 */
export const SOFTRES_CREATION_ENABLED = true;

/**
 * Whether a message is a server-authoritative soft-reserve sheet
 */
export function isSoftResMessage(
  flags: number,
  softres: unknown | undefined,
): boolean {
  return (flags & FLAG_SOFTRES) === FLAG_SOFTRES && !!softres;
}

/**
 * Coalesced sheet-state hydration: SoftResMessage instances mounting in
 * the same tick (one page of messages) are batched into a single
 * `POST /channels/:id/softres/fetch` instead of one GET per sheet (N+1).
 */
const hydrationQueues = new Map<
  string,
  { messages: Map<string, Message>; timer: ReturnType<typeof setTimeout> }
>();

function requestSoftResState(client: Client, message: Message) {
  const softres = message.softres;
  if (!softres || message.softresState?.hydrated) return;

  const channelId = message.channelId;
  let queue = hydrationQueues.get(channelId);
  if (!queue) {
    queue = {
      messages: new Map(),
      timer: setTimeout(() => {
        const batch = queue!;
        hydrationQueues.delete(channelId);

        // The bulk route caps ids at 25 per request — chunk beyond that
        // (a dedicated softres channel can render a >25-sheet page)
        const ids = [...batch.messages.keys()];
        for (let at = 0; at < ids.length; at += 25) {
          client.channels
            .apiReq("POST", `/channels/${channelId}/softres/fetch`, {
              body: { ids: ids.slice(at, at + 25) },
            })
            .then((response) => {
              for (const data of response as SoftResData[]) {
                const target = [...batch.messages.values()].find(
                  (candidate) => candidate.softres?.id === data._id,
                );
                target?.applySoftresState(data);
              }
            })
            .catch(() => {
              /* cold-render hydration is best-effort; reserving still works */
            });
        }
      }, 50),
    };
    hydrationQueues.set(channelId, queue);
  }

  queue.messages.set(softres.id, message);
}

interface Props {
  /**
   * Soft-reserve sheet message
   */
  message: Message;
}

/**
 * Interactive card for soft-reserve sheet messages
 */
export function SoftResMessage(props: Props) {
  const client = useClient();
  const e2ee = useE2EE();
  const { t } = useLingui();
  const { openModal, showError } = useModals();

  const state = () => props.message.softresState;
  /**
   * The embedded definition is a creation-time snapshot for cold render
   * only — settings edits leave it stale by design, so once state is
   * hydrated its fresh `definition` copy wins.
   */
  const definition = () => state()?.definition ?? props.message.softres!;

  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));

  onMount(() => requestSoftResState(client(), props.message));

  /**
   * 🔴 Hidden-sheet refetch contract: on hidden sheets the WS events
   * deliberately omit the gated fields AND the SDK clears/stales them
   * with no "refetch needed" flag — so privileged viewers (and anyone
   * whose own cross-session row may have changed) must refetch over REST
   * on EVERY SoftresReserveUpdate and SoftresSheetUpdate. Visible sheets
   * need nothing: the SDK merge is authoritative there.
   */
  let refetchTimer: ReturnType<typeof setTimeout> | undefined;
  const onSheetEvent = (message: Message) => {
    if (message.id !== props.message.id) return;
    if (!definition().hidden) return;
    // Coalesce bursts (a raid flipping reserves) into one refetch
    if (refetchTimer) return;
    refetchTimer = setTimeout(() => {
      refetchTimer = undefined;
      props.message.fetchSoftRes().catch(() => {
        /* transient — the next update retries */
      });
    }, 300);
  };
  // Capture the instance: a client swap between mount and cleanup would
  // otherwise leak the listeners
  const liveClient = client();
  onMount(() => {
    liveClient.on("softresReserveUpdate", onSheetEvent);
    liveClient.on("softresSheetUpdate", onSheetEvent);
  });
  onCleanup(() => {
    liveClient.removeListener("softresReserveUpdate", onSheetEvent);
    liveClient.removeListener("softresSheetUpdate", onSheetEvent);
    if (refetchTimer) clearTimeout(refetchTimer);
  });

  const [busy, setBusy] = createSignal(false);

  const isSelfCreator = () =>
    (state()?.creatorId ?? props.message.authorId) === client().user?.id;

  const canManage = () =>
    isSelfCreator() ||
    props.message.channel?.havePermission("ManageMessages") === true;

  /**
   * The card flips to locked CLIENT-SIDE when `locksAt` passes — no WS
   * event fires at event start (lazy lock; the server resolves the same
   * comparison on every read/write).
   */
  const locked = () => {
    const current = state();
    if (!current) return false;
    return (
      current.locked ||
      (current.locksAt !== undefined && now() >= current.locksAt)
    );
  };

  /**
   * Reservations are stored by the server, so they are withheld wherever
   * the shared conversation gate says new content must not leave the
   * device: encrypted, unknown while E2EE is on, or the composer's pending
   * state.
   */
  const encryptedContext = () =>
    serverActionsBlocked(e2ee, props.message.channel, client().user?.id);

  // ----- Catalog lookups (names for raid pills / item chips) ----------------

  const [catalog] = createResource(() => client().fetchSoftResCatalog());

  const raidName = (id: string) => {
    for (const edition of catalog()?.editions ?? []) {
      const raid = edition.raids.find((entry) => entry.id === id);
      if (raid) return raid.name;
    }
    return id;
  };

  /**
   * Merged loot table of the sheet's raids, to render item names for
   * reserve chips and the contested summary. Lazy + SDK-cached; until it
   * resolves items render as "#id".
   */
  const [itemIndex] = createResource(
    () => definition().raids.join(","),
    async (key) => {
      const responses = await Promise.all(
        key.split(",").map((raid) => client().fetchSoftResRaidItems(raid)),
      );
      const index = new Map<number, SoftResCatalogItemData>();
      for (const response of responses) {
        for (const item of response.items) {
          if (!index.has(item.id)) index.set(item.id, item);
        }
      }
      return index;
    },
  );

  const itemOf = (id: number) => itemIndex()?.get(id);

  /**
   * Contested items — every item at least two raiders want, most wanted
   * first (the strategic read a raid leader scans the card for). Only
   * renders when the server sent `item_counts` (hidden sheets omit it
   * for non-managers).
   */
  const contested = createMemo(() => {
    const counts = state()?.itemCounts;
    if (!counts) return undefined;
    return Object.entries(counts)
      .map(([id, count]) => ({ id: Number(id), count }))
      .filter((entry) => entry.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  });

  const locksInLabel = () => {
    const locksAt = state()?.locksAt;
    if (locksAt === undefined) return undefined;
    const remaining = locksAt - now();
    if (remaining <= 0) return undefined;
    const minutes = Math.ceil(remaining / 60_000);
    if (minutes < 60) return t`Locks in ${minutes}m`;
    const hours = Math.ceil(minutes / 60);
    if (hours < 48) return t`Locks in ${hours}h`;
    return t`Locks in ${Math.ceil(hours / 24)}d`;
  };

  async function toggleLock() {
    if (busy()) return;
    setBusy(true);
    try {
      await props.message.lockSoftRes(!locked());
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <Header>
        <Symbol size={18}>shield</Symbol>
        <Title>{definition().title}</Title>
        <Show when={locked()}>
          <LockBadge>
            <Symbol size={14}>lock</Symbol> <Trans>Locked</Trans>
          </LockBadge>
        </Show>
        <Show when={!locked() && locksInLabel()}>
          <LockHint>
            <Symbol size={14}>schedule</Symbol> {locksInLabel()}
          </LockHint>
        </Show>
      </Header>

      <Pills>
        <For each={definition().raids}>
          {(raid) => <RaidPill>{raidName(raid)}</RaidPill>}
        </For>
      </Pills>

      <Show when={definition().note}>
        <Note>{definition().note}</Note>
      </Show>

      <Show when={definition().hidden && !state()?.reserves}>
        <Hint>
          <Symbol size={14}>visibility_off</Symbol>
          <Trans>Reserves are hidden until the leader exports.</Trans>
        </Hint>
      </Show>

      <Show when={(definition().hard_reserves?.length ?? 0) > 0}>
        <Section>
          <SectionLabel>
            <Trans>Hard reserved</Trans>
          </SectionLabel>
          <ChipWrap>
            <For each={definition().hard_reserves}>
              {(hard) => (
                <ItemChip
                  style={{
                    color:
                      WOW_QUALITY_COLORS[itemOf(hard.item_id)?.quality ?? 4],
                  }}
                  title={hard.note}
                >
                  {itemOf(hard.item_id)?.name ?? `#${hard.item_id}`}
                  <ChipDetail>{hard.reserved_for}</ChipDetail>
                </ItemChip>
              )}
            </For>
          </ChipWrap>
        </Section>
      </Show>

      <Show when={contested() && contested()!.length > 0}>
        <Section>
          <SectionLabel>
            <Trans>Contested items</Trans>
          </SectionLabel>
          <ChipWrap>
            <For each={contested()}>
              {(entry) => (
                <ItemChip
                  style={{
                    color: WOW_QUALITY_COLORS[itemOf(entry.id)?.quality ?? 4],
                  }}
                >
                  {itemOf(entry.id)?.name ?? `#${entry.id}`}
                  <ChipDetail>
                    ×{entry.count}
                    <Show when={definition().per_item_cap}>
                      /{definition().per_item_cap}
                    </Show>
                  </ChipDetail>
                </ItemChip>
              )}
            </For>
          </ChipWrap>
        </Section>
      </Show>

      <Show when={state()?.myReserve}>
        {(mine) => (
          <Section>
            <SectionLabel>
              <Trans>Your reserve</Trans>
            </SectionLabel>
            <ReserveRow reserve={mine()} itemOf={itemOf} />
          </Section>
        )}
      </Show>

      <Show when={(state()?.reserves?.length ?? 0) > 0}>
        <Section>
          <SectionLabel>
            <Trans>Reserves</Trans>
          </SectionLabel>
          <ReserveList>
            <For each={state()?.reserves}>
              {(reserve) => <ReserveRow reserve={reserve} itemOf={itemOf} />}
            </For>
          </ReserveList>
        </Section>
      </Show>

      <Show when={encryptedContext()}>
        <Hint>
          <Trans>
            Soft-reserve sheets are not available in encrypted
            conversations — reserves are stored by the server.
          </Trans>
        </Hint>
      </Show>

      <Footer>
        <FooterInfo>
          <Symbol size={14}>group</Symbol>{" "}
          <Trans>{state()?.totalReserves ?? 0} reserved</Trans>
        </FooterInfo>

        <Spacer />

        <Show when={!encryptedContext()}>
          <Show when={!locked()}>
            {/* Hydration-gated: the picker seeds from myReserve, and the
                edit modal PATCHes full state — acting on the stale
                embedded snapshot could clobber server truth */}
            <FooterAction
              type="button"
              disabled={busy() || !state()?.hydrated}
              onClick={() =>
                openModal({
                  type: "softres_reserve",
                  message: props.message,
                })
              }
            >
              <Show when={state()?.myReserve} fallback={<Trans>Reserve</Trans>}>
                <Trans>Edit reserve</Trans>
              </Show>
            </FooterAction>
          </Show>

          <Show when={canManage()}>
            <FooterAction
              type="button"
              onClick={() =>
                openModal({
                  type: "softres_export",
                  message: props.message,
                })
              }
            >
              <Trans>Export</Trans>
            </FooterAction>
            <FooterAction
              type="button"
              disabled={busy() || !state()?.hydrated}
              onClick={toggleLock}
            >
              <Show when={locked()} fallback={<Trans>Lock</Trans>}>
                <Trans>Unlock</Trans>
              </Show>
            </FooterAction>
            <FooterAction
              type="button"
              disabled={!state()?.hydrated}
              onClick={() =>
                openModal({
                  type: "create_softres",
                  channel: props.message.channel,
                  editMessage: props.message,
                })
              }
            >
              <Trans>Settings</Trans>
            </FooterAction>
          </Show>
        </Show>
      </Footer>
    </Card>
  );
}

/**
 * One raider's reservation row: class-colored character name + their
 * quality-colored item picks.
 */
function ReserveRow(props: {
  reserve: SoftResReserveData;
  itemOf: (id: number) => SoftResCatalogItemData | undefined;
}) {
  const classOf = () => props.reserve.class as WowClass;
  return (
    <Row>
      <Character
        style={{ color: WOW_CLASS_COLORS[classOf()] }}
        title={WOW_CLASS_NAMES[classOf()]}
      >
        {props.reserve.character_name}
      </Character>
      <RowItems>
        <For each={props.reserve.items}>
          {(id) => (
            <ItemChip
              style={{
                color: WOW_QUALITY_COLORS[props.itemOf(id)?.quality ?? 4],
              }}
            >
              {props.itemOf(id)?.name ?? `#${id}`}
            </ItemChip>
          )}
        </For>
      </RowItems>
      <Show when={props.reserve.note}>
        <NoteIcon title={props.reserve.note}>
          <Symbol size={14}>sticky_note_2</Symbol>
        </NoteIcon>
      </Show>
    </Row>
  );
}

const Card = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "12px 14px",
    marginTop: "2px",
    width: "480px",
    maxWidth: "100%",
    borderRadius: "12px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    color: "var(--md-sys-color-primary)",
  },
});

const Title = styled("span", {
  base: {
    fontWeight: "700",
    fontSize: "0.95rem",
    color: "var(--md-sys-color-on-surface)",
    overflowWrap: "anywhere",
    flexGrow: 1,
  },
});

const LockBadge = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "0.75rem",
    fontWeight: "700",
    color: "var(--md-sys-color-error)",
    whiteSpace: "nowrap",
  },
});

const LockHint = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
    whiteSpace: "nowrap",
  },
});

const Pills = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
});

const RaidPill = styled("span", {
  base: {
    padding: "3px 10px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Note = styled("div", {
  base: {
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
    overflowWrap: "anywhere",
  },
});

const Hint = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Section = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
});

const SectionLabel = styled("span", {
  base: {
    fontSize: "0.7rem",
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const ChipWrap = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
  },
});

const ItemChip = styled("span", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 8px",
    borderRadius: "6px",
    background: "var(--md-sys-color-surface-container)",
    fontSize: "0.75rem",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

const ChipDetail = styled("span", {
  base: {
    color: "var(--md-sys-color-on-surface-variant)",
    fontVariantNumeric: "tabular-nums",
  },
});

const ReserveList = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    maxHeight: "240px",
    overflowY: "auto",
  },
});

const Row = styled("div", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "8px",
  },
});

const Character = styled("span", {
  base: {
    fontWeight: "600",
    fontSize: "0.8rem",
    minWidth: "90px",
    flexShrink: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const RowItems = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
    flexGrow: 1,
    minWidth: 0,
  },
});

const NoteIcon = styled("span", {
  base: {
    color: "var(--md-sys-color-on-surface-variant)",
    flexShrink: 0,
  },
});

const Footer = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
    flexWrap: "wrap",
  },
});

const FooterInfo = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
});

const Spacer = styled("span", {
  base: {
    flexGrow: 1,
  },
});

const FooterAction = styled("button", {
  base: {
    padding: "4px 10px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-primary-container)",
    color: "var(--md-sys-color-on-primary-container)",
    fontWeight: "600",
    fontSize: "0.75rem",
    cursor: "pointer",
    "&:disabled": {
      opacity: 0.5,
      cursor: "default",
    },
  },
});

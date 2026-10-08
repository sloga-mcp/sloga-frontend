import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { SoftResCatalogItemData, WowClass } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { Column, Dialog, DialogProps } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { serverActionsBlocked } from "../../app/interface/channels/text/e2eeTranscriptTrust";
import {
  WOW_CLASS_COLORS,
  WOW_CLASS_NAMES,
  WOW_QUALITY_COLORS,
  classesForEdition,
} from "../../app/interface/channels/text/softresData";
import { Modals } from "../types";

/** Last-used character name, restored across sheets and sessions */
const LAST_CHARACTER_KEY = "softres:last-character";

/** WoW character names are letters only, 2–12 (server-enforced) */
const NAME_RE = /^[A-Za-z]{2,12}$/;

/**
 * Item picker modal: set (or replace) the caller's reservation row on a
 * soft-reserve sheet. The server re-validates everything — this UI just
 * fails early where it can (name shape, class-vs-edition, pick count)
 * and surfaces the server's verdict where it can't (lock and cap races).
 */
export function SoftResReserveModal(
  props: DialogProps & Modals & { type: "softres_reserve" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { showError } = useModals();

  /**
   * The same conversation gate as the card's Reserve button. The card
   * stops new opens, but a modal opened before the conversation turned
   * encrypted (or pending) would still PUT the reservation, note included,
   * in plaintext. So it is re-checked at submit and closes the modal as
   * soon as it holds.
   */
  const actionsBlocked = () =>
    serverActionsBlocked(e2ee, props.message.channel, client().user?.id);
  createEffect(
    on(actionsBlocked, (blocked) => {
      if (blocked) props.onClose();
    }),
  );

  /** Hydrated definition wins over the embedded creation-time snapshot */
  const definition = () =>
    props.message.softresState?.definition ?? props.message.softres!;
  const myReserve = () => props.message.softresState?.myReserve;

  const [characterName, setCharacterName] = createSignal(
    myReserve()?.character_name ??
      localStorage.getItem(LAST_CHARACTER_KEY) ??
      "",
  );
  const [wowClass, setWowClass] = createSignal<WowClass | undefined>(
    myReserve()?.class,
  );
  const [items, setItems] = createSignal<number[]>(myReserve()?.items ?? []);
  const [note, setNote] = createSignal(myReserve()?.note ?? "");
  const [search, setSearch] = createSignal("");
  const [pending, setPending] = createSignal(false);

  /**
   * Never submit over unhydrated state: a PUT is a full row REPLACE, so
   * a picker opened before hydration (empty seeds) would silently wipe
   * the user's existing reserve. Submission is blocked until hydration,
   * and if it lands while the modal is open with untouched fields, the
   * seeds are refreshed from the (possibly existing) row.
   */
  const hydrated = () => props.message.softresState?.hydrated === true;
  const [dirty, setDirty] = createSignal(false);
  onMount(() => {
    if (!hydrated()) void props.message.fetchSoftRes().catch(() => undefined);
  });
  createEffect(
    on(hydrated, (isHydrated) => {
      if (!isHydrated || dirty()) return;
      const mine = myReserve();
      if (!mine) return;
      setCharacterName(mine.character_name);
      setWowClass(mine.class);
      setItems([...mine.items]);
      setNote(mine.note ?? "");
    }),
  );

  const maxItems = () => definition().reserves_per_user;
  const classes = () => classesForEdition(definition().edition);

  const hardReserved = createMemo(
    () => new Set(definition().hard_reserves?.map((hard) => hard.item_id)),
  );

  /** Merged loot table of the sheet's raids (lazy, SDK-cached) */
  const [loot] = createResource(
    () => definition().raids.join(","),
    async (key) => {
      const responses = await Promise.all(
        key.split(",").map((raid) => client().fetchSoftResRaidItems(raid)),
      );
      const seen = new Map<number, SoftResCatalogItemData>();
      for (const response of responses) {
        for (const item of response.items) {
          if (!seen.has(item.id)) seen.set(item.id, item);
        }
      }
      return [...seen.values()];
    },
  );

  const itemOf = (id: number) => (loot() ?? []).find((item) => item.id === id);

  /**
   * Whether the chosen class can use an item, when the sheet enforces
   * class restriction (unrestricted items have no class list).
   */
  const usableByClass = (item: SoftResCatalogItemData) => {
    if (!definition().class_restriction) return true;
    const allowed = item.allowable_classes;
    if (!allowed) return true;
    const chosen = wowClass();
    return !chosen || allowed.includes(chosen);
  };

  /**
   * Per-item cap check, best-effort from the last known counts. The
   * server excludes the writer's previous row (a replace frees its own
   * copies), so subtract those — but count the copies staged in THIS
   * picker, or duplicates could stage past the cap. Authoritative check
   * is server-side; a race surfaces as SoftResItemCapReached.
   */
  const capFull = (id: number) => {
    const cap = definition().per_item_cap;
    if (!cap) return false;
    const count = props.message.softresState?.itemCounts?.[String(id)] ?? 0;
    const mine = myReserve()?.items.filter((item) => item === id).length ?? 0;
    const staged = items().filter((item) => item === id).length;
    return count - mine + staged >= cap;
  };

  const matches = createMemo(() => {
    const query = search().trim().toLowerCase();
    const table = loot() ?? [];
    const filtered = query
      ? table.filter(
          (item) =>
            item.name.toLowerCase().includes(query) ||
            item.boss.toLowerCase().includes(query),
        )
      : table;
    return filtered.filter((item) => !hardReserved().has(item.id));
  });

  function toggleItem(item: SoftResCatalogItemData) {
    if (!usableByClass(item)) return;
    setDirty(true);
    setItems((current) => {
      const picked = current.includes(item.id);
      if (picked && !definition().allow_duplicates) {
        return current.filter((id) => id !== item.id);
      }
      // Everything below ADDS a copy (duplicates re-add): both caps apply
      if (current.length >= maxItems()) return current;
      if (capFull(item.id)) return current;
      return [...current, item.id];
    });
  }

  function removeItemAt(index: number) {
    setDirty(true);
    setItems((current) => current.filter((_, at) => at !== index));
  }

  const nameValid = () => NAME_RE.test(characterName().trim());

  const canSubmit = () =>
    !pending() &&
    hydrated() &&
    nameValid() &&
    !!wowClass() &&
    items().length >= 1 &&
    items().length <= maxItems();

  async function onSubmit() {
    if (actionsBlocked()) {
      props.onClose();
      return;
    }
    if (!canSubmit()) return;
    setPending(true);
    try {
      await props.message.reserveSoftRes({
        character_name: characterName().trim(),
        class: wowClass()!,
        items: items(),
        note: note().trim() || undefined,
      });
      localStorage.setItem(LAST_CHARACTER_KEY, characterName().trim());
      props.onClose();
    } catch (error) {
      showError(error);
      // A lock or cap race means our cached state is stale — refetch so
      // the card (and this modal's counts) reflect the server's reality.
      void props.message.fetchSoftRes().catch(() => undefined);
      if ((error as { type?: string })?.type === "SoftResLocked") {
        props.onClose();
      }
    } finally {
      setPending(false);
    }
  }

  async function onRetract() {
    if (pending()) return;
    setPending(true);
    try {
      await props.message.retractSoftRes();
      props.onClose();
    } catch (error) {
      showError(error);
      void props.message.fetchSoftRes().catch(() => undefined);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={definition().title}
      actions={[
        { text: <Trans>Close</Trans> },
        ...(myReserve()
          ? [
              {
                text: <Trans>Remove reserve</Trans>,
                onClick: () => {
                  void onRetract();
                  return false;
                },
              },
            ]
          : []),
        {
          text: myReserve() ? (
            <Trans>Update reserve</Trans>
          ) : (
            <Trans>Reserve</Trans>
          ),
          onClick: () => {
            void onSubmit();
            return false;
          },
          isDisabled: !canSubmit(),
        },
      ]}
      isDisabled={pending()}
    >
      <Column>
        <FieldRow>
          <NameInput
            value={characterName()}
            maxlength={12}
            placeholder={t`Character name`}
            data-invalid={
              (characterName().length > 0 && !nameValid()) || undefined
            }
            onInput={(event) => {
              setDirty(true);
              setCharacterName(event.currentTarget.value);
            }}
          />
        </FieldRow>
        <Show when={characterName().length > 0 && !nameValid()}>
          <Invalid>
            <Trans>Letters only, 2–12 characters (WoW name rules).</Trans>
          </Invalid>
        </Show>

        <ChipRow>
          <For each={classes()}>
            {(entry) => (
              <ClassChip
                type="button"
                data-selected={wowClass() === entry || undefined}
                style={{ "--class-color": WOW_CLASS_COLORS[entry] }}
                onClick={() => {
                  setDirty(true);
                  setWowClass(entry);
                }}
              >
                {WOW_CLASS_NAMES[entry]}
              </ClassChip>
            )}
          </For>
        </ChipRow>

        <Picked>
          <SectionLabel>
            <Trans>
              {items().length} of {maxItems()} picked
            </Trans>
          </SectionLabel>
          <ChipRow>
            <For each={items()}>
              {(id, index) => (
                <PickedChip
                  type="button"
                  style={{
                    color: WOW_QUALITY_COLORS[itemOf(id)?.quality ?? 4],
                  }}
                  onClick={() => removeItemAt(index())}
                >
                  {itemOf(id)?.name ?? `#${id}`}
                  <Symbol size={14}>close</Symbol>
                </PickedChip>
              )}
            </For>
            <Show when={items().length === 0}>
              <Empty>
                <Trans>Pick items from the list below.</Trans>
              </Empty>
            </Show>
          </ChipRow>
        </Picked>

        <SearchInput
          value={search()}
          placeholder={t`Search items or bosses…`}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />

        <ItemList>
          <Show when={loot.loading}>
            <Empty>
              <Trans>Loading loot table…</Trans>
            </Empty>
          </Show>
          <Show when={loot.error}>
            <Empty>
              <Trans>Could not load the loot table.</Trans>
            </Empty>
          </Show>
          <For each={matches()}>
            {(item) => {
              const picked = () => items().includes(item.id);
              // Clicking a picked item REMOVES it (always allowed) unless
              // duplicates are on, where a click adds another copy
              const blocked = () =>
                !usableByClass(item) ||
                (capFull(item.id) &&
                  (definition().allow_duplicates || !picked()));
              return (
                <ItemRow
                  type="button"
                  data-selected={picked() || undefined}
                  data-disabled={blocked() || undefined}
                  onClick={() => !blocked() && toggleItem(item)}
                >
                  <ItemName
                    style={{
                      color:
                        WOW_QUALITY_COLORS[item.quality] ??
                        "var(--md-sys-color-on-surface)",
                    }}
                  >
                    {item.name}
                  </ItemName>
                  <ItemBoss>{item.boss}</ItemBoss>
                  <Show
                    when={
                      props.message.softresState?.itemCounts?.[String(item.id)]
                    }
                  >
                    {(count) => (
                      <ItemCount data-full={capFull(item.id) || undefined}>
                        ×{count()}
                        <Show when={definition().per_item_cap}>
                          /{definition().per_item_cap}
                        </Show>
                      </ItemCount>
                    )}
                  </Show>
                </ItemRow>
              );
            }}
          </For>
          <Show when={!loot.loading && !loot.error && matches().length === 0}>
            <Empty>
              <Trans>No items match.</Trans>
            </Empty>
          </Show>
        </ItemList>

        <NoteInput
          value={note()}
          maxlength={200}
          placeholder={t`Note to the loot master (optional)`}
          onInput={(event) => {
            setDirty(true);
            setNote(event.currentTarget.value);
          }}
        />
      </Column>
    </Dialog>
  );
}

const FieldRow = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
  },
});

const inputBase = {
  padding: "10px 12px",
  borderRadius: "8px",
  background: "var(--md-sys-color-surface-container-high)",
  border: "1px solid var(--md-sys-color-outline-variant)",
  color: "var(--md-sys-color-on-surface)",
  fontSize: "0.9rem",
  "&:focus": {
    outline: "none",
    borderColor: "var(--md-sys-color-primary)",
  },
} as const;

const NameInput = styled("input", {
  base: {
    ...inputBase,
    flexGrow: 1,
    "&[data-invalid]": {
      borderColor: "var(--md-sys-color-error)",
    },
  },
});

const SearchInput = styled("input", {
  base: inputBase,
});

const NoteInput = styled("input", {
  base: inputBase,
});

const Invalid = styled("span", {
  base: {
    fontSize: "0.75rem",
    color: "var(--md-sys-color-error)",
  },
});

const ChipRow = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const ClassChip = styled("button", {
  base: {
    padding: "5px 10px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--class-color)",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: "600",
    border: "1px solid transparent",
    "&[data-selected]": {
      borderColor: "var(--class-color)",
      background: "var(--md-sys-color-surface-container)",
    },
  },
});

const Picked = styled("div", {
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

const PickedChip = styled("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "3px 8px",
    borderRadius: "6px",
    background: "var(--md-sys-color-surface-container)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    fontSize: "0.75rem",
    cursor: "pointer",
  },
});

const ItemList = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxHeight: "260px",
    overflowY: "auto",
  },
});

const ItemRow = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "6px 10px",
    borderRadius: "8px",
    textAlign: "left",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface)",
    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
    "&[data-selected]": {
      background: "var(--md-sys-color-surface-container)",
      outline: "1px solid var(--md-sys-color-primary)",
    },
    "&[data-disabled]": {
      opacity: 0.4,
      cursor: "not-allowed",
    },
  },
});

const ItemName = styled("span", {
  base: {
    flexGrow: 1,
    fontSize: "0.85rem",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const ItemBoss = styled("span", {
  base: {
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
});

const ItemCount = styled("span", {
  base: {
    fontSize: "0.75rem",
    fontVariantNumeric: "tabular-nums",
    color: "var(--md-sys-color-on-surface-variant)",
    flexShrink: 0,
    "&[data-full]": {
      color: "var(--md-sys-color-error)",
      fontWeight: "700",
    },
  },
});

const Empty = styled("span", {
  base: {
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "6px 2px",
  },
});

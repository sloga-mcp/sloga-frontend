import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
} from "solid-js";

import { createFormControl, createFormGroup } from "solid-forms";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type {
  Channel,
  HardReserveData,
  SoftResCatalogItemData,
} from "stoat.js";

import { styled } from "styled-system/jsx";

import { serverActionsBlocked } from "@revolt/app/interface/channels/text/e2eeTranscriptTrust";
import { useClient, useE2EE } from "@revolt/client";
import {
  Column,
  Dialog,
  DialogProps,
  Form2,
  IconButton,
  MenuItem,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

/** Server-enforced sheet limits */
const MAX_RAIDS = 4;
const MAX_HARD_RESERVES = 50;

/**
 * Modal to create a soft-reserve sheet in a channel. Edition-first picker
 * (softres.it convention): pick the game edition, then up to four of that
 * edition's raids — switching edition clears the raid selection and any
 * hard reserves (they reference edition-scoped item ids). The server
 * validates everything against its checked-in loot catalog and assembles
 * the sheet message authoritatively.
 *
 * `channel` may be absent when opened from a server-wide calendar event
 * (`channel: None` is common there) — a channel picker over the event's
 * server is offered instead.
 */
export function CreateSoftResModal(
  props: DialogProps & Modals & { type: "create_softres" },
) {
  const { t } = useLingui();
  const client = useClient();
  const e2ee = useE2EE();
  const { showError } = useModals();

  const [catalog] = createResource(() => client().fetchSoftResCatalog());

  /**
   * Edit mode: settings-edit of an existing sheet. Edition, raids and the
   * event link are immutable post-create (reserves reference them) — only
   * settings and hard reserves change. The hydrated definition wins over
   * the embedded creation-time snapshot, which settings edits leave stale.
   */
  const editDefinition = props.editMessage
    ? (props.editMessage.softresState?.definition ?? props.editMessage.softres)
    : undefined;
  const editing = editDefinition !== undefined;

  // The card gates Settings behind hydration, but kick a fetch anyway so
  // the Save guard (hydrated-only) can clear if another path got here
  if (props.editMessage && !props.editMessage.softresState?.hydrated) {
    void props.editMessage.fetchSoftRes().catch(() => undefined);
  }

  const group = createFormGroup({
    title: createFormControl(editDefinition?.title ?? "", { required: true }),
    note: createFormControl(editDefinition?.note ?? ""),
    reservesPerUser: createFormControl(
      String(editDefinition?.reserves_per_user ?? 1),
    ),
    perItemCap: createFormControl(
      editDefinition?.per_item_cap !== undefined
        ? String(editDefinition.per_item_cap)
        : "off",
    ),
  });

  const [edition, setEdition] = createSignal<string | undefined>(
    editDefinition?.edition,
  );
  const [raids, setRaids] = createSignal<string[]>(editDefinition?.raids ?? []);
  const [allowDuplicates, setAllowDuplicates] = createSignal(
    editDefinition?.allow_duplicates ?? false,
  );
  const [classRestriction, setClassRestriction] = createSignal(
    editDefinition?.class_restriction ?? false,
  );
  const [hidden, setHidden] = createSignal(editDefinition?.hidden ?? false);
  const [lockAtEventStart, setLockAtEventStart] = createSignal(
    editDefinition?.lock_at_event_start ?? false,
  );
  const [pending, setPending] = createSignal(false);

  // Channel picker fallback for server-wide events (no channel prop).
  const [pickedChannel, setPickedChannel] = createSignal<Channel | undefined>();
  const targetChannel = () => props.channel ?? pickedChannel();

  /**
   * Creating or editing a sheet sends its user content (title, note, hard
   * reserves) to the server in plaintext, outside the E2EE send path, so it
   * is withheld wherever the shared conversation gate says new content must
   * not leave the device. The entry points hide the action then, but this
   * modal may already be open when the conversation turns encrypted (or
   * pending) underneath it. Create mode has nothing to send until a channel
   * is chosen (server-wide events offer a picker), so it waits for one.
   */
  const actionsBlocked = () => {
    if (props.editMessage) {
      return serverActionsBlocked(
        e2ee,
        props.editMessage.channel,
        client().user?.id,
      );
    }
    const channel = targetChannel();
    return !!channel && serverActionsBlocked(e2ee, channel, client().user?.id);
  };

  // Close the modal as soon as the conversation turns encrypted. Stops
  // once `show` is false, so closing cannot retrigger it.
  createEffect(() => {
    if (props.show && actionsBlocked()) props.onClose();
  });

  const channelCandidates = createMemo(() => {
    if (props.channel) return [];
    const server = props.event?.server;
    if (!server) return [];
    return server.channels
      .filter(
        (channel) =>
          channel.type === "TextChannel" &&
          channel.havePermission("SendMessage"),
      )
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  });

  const editions = () => catalog()?.editions ?? [];
  const selectedEdition = () =>
    editions().find((entry) => entry.id === edition());

  /** Switching edition invalidates every edition-scoped selection */
  function pickEdition(id: string) {
    if (edition() === id) return;
    setEdition(id);
    setRaids([]);
    setHardReserves([]);
    setHardReserveSearch("");
  }

  function toggleRaid(id: string) {
    setRaids((current) => {
      if (current.includes(id)) {
        // Hard reserves may reference items of the removed raid — drop
        // any that no longer resolve once the selection shrinks.
        return current.filter((raid) => raid !== id);
      }
      return current.length >= MAX_RAIDS ? current : [...current, id];
    });
  }

  // ----- Hard reserves ------------------------------------------------------

  // Rows are id-keyed (names resolve from the lazily-fetched loot table)
  // so edit mode can prefill from the wire definition, which only carries
  // item ids.
  const [hardReserves, setHardReserves] = createSignal<
    { itemId: number; reservedFor: string; note: string }[]
  >(
    editDefinition?.hard_reserves?.map((hard) => ({
      itemId: hard.item_id,
      reservedFor: hard.reserved_for,
      note: hard.note ?? "",
    })) ?? [],
  );
  const [hardReserveSearch, setHardReserveSearch] = createSignal("");

  /**
   * Merged loot table of the selected raids, for the hard-reserve search
   * (deduped — shared boss tables repeat ids within an edition). Fetched
   * lazily per raid and cached SDK-side.
   */
  const [selectedItems] = createResource(
    () => raids().join(","),
    async (key) => {
      if (!key) return [];
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

  const itemLookup = createMemo(
    () => new Map((selectedItems() ?? []).map((item) => [item.id, item])),
  );

  const hardReserveMatches = createMemo(() => {
    const search = hardReserveSearch().trim().toLowerCase();
    if (!search) return [];
    const taken = new Set(hardReserves().map((row) => row.itemId));
    return (selectedItems() ?? [])
      .filter(
        (item) =>
          !taken.has(item.id) &&
          (item.name.toLowerCase().includes(search) ||
            item.boss.toLowerCase().includes(search)),
      )
      .slice(0, 25);
  });

  function addHardReserve(item: SoftResCatalogItemData) {
    if (hardReserves().length >= MAX_HARD_RESERVES) return;
    setHardReserves((current) => [
      ...current,
      { itemId: item.id, reservedFor: "", note: "" },
    ]);
    setHardReserveSearch("");
  }

  function updateHardReserve(
    index: number,
    patch: Partial<{ reservedFor: string; note: string }>,
  ) {
    setHardReserves((current) =>
      current.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );
  }

  function removeHardReserve(index: number) {
    setHardReserves((current) => current.filter((_, at) => at !== index));
  }

  // Raid deselection (or a catalog data-fix, in edit mode) may orphan
  // hard-reserve rows. `hard_reserves` is a FULL REPLACEMENT on the wire,
  // so orphans must never be silently filtered out of a submit — they
  // block Save and are marked in the list until the user removes them.
  const orphanedHardReserves = createMemo(() => {
    if (selectedItems() === undefined) return 0;
    return hardReserves().filter((row) => !itemLookup().has(row.itemId)).length;
  });

  // ----- Submission ---------------------------------------------------------

  const canSubmit = () =>
    !pending() &&
    (editing || (!!targetChannel() && !!edition() && raids().length > 0)) &&
    // Edit is a full-state PATCH — never save over the stale embedded
    // snapshot before hydration resolves the current definition
    (!editing || props.editMessage?.softresState?.hydrated === true) &&
    group.controls.title.value.trim().length > 0 &&
    // Never save while the loot table is still loading and rows exist,
    // and never with orphaned rows — `hard_reserves` is a full
    // replacement, so a silent drop would delete them server-side
    (hardReserves().length === 0 || selectedItems() !== undefined) &&
    orphanedHardReserves() === 0 &&
    hardReserves().every((row) => row.reservedFor.trim().length > 0);

  const [linkConflict, setLinkConflict] = createSignal(false);

  async function onSubmit() {
    // Re-checked here: the conversation may have turned encrypted after this
    // modal opened, and the request would carry the sheet in plaintext
    if (actionsBlocked()) {
      props.onClose();
      return;
    }
    if (!canSubmit()) return;
    setPending(true);
    setLinkConflict(false);
    try {
      const perItemCap = group.controls.perItemCap.value;
      const title = group.controls.title.value.trim();
      const note = group.controls.note.value.trim();
      const hard_reserves: HardReserveData[] = hardReserves().map((row) => ({
        item_id: row.itemId,
        reserved_for: row.reservedFor.trim(),
        note: row.note.trim() || undefined,
      }));

      if (editing) {
        // Full-state settings edit; absent-able fields go through `remove`
        const remove: ("PerItemCap" | "Note")[] = [];
        if (perItemCap === "off") remove.push("PerItemCap");
        if (!note) remove.push("Note");
        await props.editMessage!.editSoftRes({
          title,
          reserves_per_user: Number(group.controls.reservesPerUser.value),
          per_item_cap: perItemCap === "off" ? undefined : Number(perItemCap),
          allow_duplicates: allowDuplicates(),
          class_restriction: classRestriction(),
          hidden: hidden(),
          lock_at_event_start: lockAtEventStart(),
          note: note || undefined,
          hard_reserves,
          remove,
        });
        props.onClose();
        return;
      }

      const channel = targetChannel();
      if (!channel) return;
      const message = await channel.createSoftRes({
        title,
        edition: edition()!,
        raids: raids(),
        reserves_per_user: Number(group.controls.reservesPerUser.value),
        per_item_cap: perItemCap === "off" ? undefined : Number(perItemCap),
        allow_duplicates: allowDuplicates(),
        class_restriction: classRestriction(),
        hidden: hidden(),
        lock_at_event_start: props.event ? lockAtEventStart() : false,
        note: note || undefined,
        hard_reserves,
        event_id: props.event?.id,
      });
      props.callback?.(message);
      props.onClose();
    } catch (error) {
      if ((error as { type?: string })?.type === "SoftResEventAlreadyLinked") {
        setLinkConflict(true);
      } else {
        showError(error);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={
        editing ? (
          <Trans>Edit soft-reserve sheet</Trans>
        ) : (
          <Trans>Create soft-reserve sheet</Trans>
        )
      }
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: editing ? <Trans>Save</Trans> : <Trans>Create</Trans>,
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
        <Show when={props.event}>
          {(event) => (
            <EventChip>
              <Symbol size={16}>calendar_month</Symbol>
              <Trans>Linked to event: {event().title}</Trans>
            </EventChip>
          )}
        </Show>

        <Show when={linkConflict()}>
          <ErrorNotice>
            <Symbol size={16}>error</Symbol>
            <Trans>
              This event already has a soft-reserve sheet — each event can only
              have one.
            </Trans>
          </ErrorNotice>
        </Show>

        <Show when={!props.channel && props.event}>
          <Column gap="sm">
            <FieldLabel>
              <Trans>Post the sheet to</Trans>
            </FieldLabel>
            <ChipRow>
              <For each={channelCandidates()}>
                {(channel) => (
                  <Chip
                    type="button"
                    data-selected={
                      pickedChannel()?.id === channel.id || undefined
                    }
                    onClick={() => setPickedChannel(channel)}
                  >
                    <Symbol size={14}>tag</Symbol>
                    {channel.name}
                  </Chip>
                )}
              </For>
              <Show when={channelCandidates().length === 0}>
                <Empty>
                  <Trans>No channels where you can send messages.</Trans>
                </Empty>
              </Show>
            </ChipRow>
          </Column>
        </Show>

        <Form2.TextField
          minlength={1}
          maxlength={100}
          counter
          name="title"
          control={group.controls.title}
          label={t`Title`}
          placeholder={t`Friday raid night`}
        />

        <Show when={!editing}>
          <Column gap="sm">
            <FieldLabel>
              <Trans>Game edition</Trans>
            </FieldLabel>
            <ChipRow>
              <For each={editions()}>
                {(entry) => (
                  <Chip
                    type="button"
                    data-selected={edition() === entry.id || undefined}
                    onClick={() => pickEdition(entry.id)}
                  >
                    {entry.name}
                  </Chip>
                )}
              </For>
              <Show when={catalog.loading}>
                <Empty>
                  <Trans>Loading catalog…</Trans>
                </Empty>
              </Show>
              <Show when={catalog.error}>
                <Empty>
                  <Trans>Could not load the raid catalog.</Trans>
                </Empty>
              </Show>
            </ChipRow>
          </Column>

          <Show when={selectedEdition()}>
            {(entry) => (
              <Column gap="sm">
                <FieldLabel>
                  <Trans>Raids (up to {MAX_RAIDS})</Trans>
                </FieldLabel>
                <ChipRow>
                  <For each={entry().raids}>
                    {(raid) => (
                      <Chip
                        type="button"
                        data-selected={raids().includes(raid.id) || undefined}
                        data-disabled={
                          (!raids().includes(raid.id) &&
                            raids().length >= MAX_RAIDS) ||
                          undefined
                        }
                        onClick={() => toggleRaid(raid.id)}
                      >
                        {raid.name}
                      </Chip>
                    )}
                  </For>
                </ChipRow>
              </Column>
            )}
          </Show>
        </Show>

        {/* Edition and raids are immutable post-create — existing
            reserves reference them */}
        <Show when={editing}>
          <Column gap="sm">
            <FieldLabel>
              <Trans>Raids (fixed after creation)</Trans>
            </FieldLabel>
            <ChipRow>
              <For each={raids()}>
                {(raidId) => (
                  <Chip type="button" disabled data-disabled>
                    {selectedEdition()?.raids.find((raid) => raid.id === raidId)
                      ?.name ?? raidId}
                  </Chip>
                )}
              </For>
            </ChipRow>
          </Column>
        </Show>

        <Form2.Select
          label={t`Reserves per raider`}
          control={group.controls.reservesPerUser}
        >
          <Index each={Array.from({ length: 10 })}>
            {(_, index) => (
              <MenuItem value={String(index + 1)}>{index + 1}</MenuItem>
            )}
          </Index>
        </Form2.Select>

        <Form2.Select
          label={t`Raiders per item (cap)`}
          control={group.controls.perItemCap}
        >
          <MenuItem value="off">
            <Trans>No cap</Trans>
          </MenuItem>
          <Index each={Array.from({ length: 20 })}>
            {(_, index) => (
              <MenuItem value={String(index + 1)}>{index + 1}</MenuItem>
            )}
          </Index>
        </Form2.Select>

        <ToggleRow onClick={() => setAllowDuplicates((v) => !v)}>
          <ToggleBox data-checked={allowDuplicates() || undefined}>
            <Show when={allowDuplicates()}>
              <Symbol size={16}>check</Symbol>
            </Show>
          </ToggleBox>
          <Trans>Allow reserving the same item twice</Trans>
        </ToggleRow>

        <ToggleRow onClick={() => setClassRestriction((v) => !v)}>
          <ToggleBox data-checked={classRestriction() || undefined}>
            <Show when={classRestriction()}>
              <Symbol size={16}>check</Symbol>
            </Show>
          </ToggleBox>
          <Trans>Restrict items to classes that can use them</Trans>
        </ToggleRow>

        <ToggleRow onClick={() => setHidden((v) => !v)}>
          <ToggleBox data-checked={hidden() || undefined}>
            <Show when={hidden()}>
              <Symbol size={16}>check</Symbol>
            </Show>
          </ToggleBox>
          <Trans>Hide reserves until export (leaders still see them)</Trans>
        </ToggleRow>

        <Show
          when={
            editing
              ? !!props.editMessage?.softresState?.eventId
              : props.event && !props.event?.recurrence
          }
        >
          <ToggleRow onClick={() => setLockAtEventStart((v) => !v)}>
            <ToggleBox data-checked={lockAtEventStart() || undefined}>
              <Show when={lockAtEventStart()}>
                <Symbol size={16}>check</Symbol>
              </Show>
            </ToggleBox>
            <Trans>Lock the sheet when the event starts</Trans>
          </ToggleRow>
        </Show>

        <Form2.TextField
          maxlength={200}
          name="note"
          control={group.controls.note}
          label={t`Note (optional)`}
          placeholder={t`Shown on the sheet card`}
        />

        <Column gap="sm">
          <FieldLabel>
            <Trans>Hard reserves (optional)</Trans>
          </FieldLabel>
          <Hint>
            <Symbol size={16}>info</Symbol>
            <Trans>
              Items taken off the table before reserves open — raiders cannot
              soft-reserve them.
            </Trans>
          </Hint>

          <For each={hardReserves()}>
            {(row, index) => (
              <HardReserveRow>
                <HardReserveItem
                  data-quality={itemLookup().get(row.itemId)?.quality ?? 4}
                  data-orphan={
                    (selectedItems() !== undefined &&
                      !itemLookup().has(row.itemId)) ||
                    undefined
                  }
                >
                  {itemLookup().get(row.itemId)?.name ?? `#${row.itemId}`}
                </HardReserveItem>
                <SmallInput
                  value={row.reservedFor}
                  maxlength={50}
                  placeholder={t`Reserved for…`}
                  onInput={(event) =>
                    updateHardReserve(index(), {
                      reservedFor: event.currentTarget.value,
                    })
                  }
                />
                <SmallInput
                  value={row.note}
                  maxlength={200}
                  placeholder={t`Note`}
                  onInput={(event) =>
                    updateHardReserve(index(), {
                      note: event.currentTarget.value,
                    })
                  }
                />
                <IconButton onPress={() => removeHardReserve(index())}>
                  <Symbol>close</Symbol>
                </IconButton>
              </HardReserveRow>
            )}
          </For>

          <Show when={orphanedHardReserves() > 0}>
            <ErrorNotice>
              <Symbol size={16}>error</Symbol>
              <Trans>
                Some hard reserves are not in the selected raids' loot — remove
                them (or restore the raid) before saving.
              </Trans>
            </ErrorNotice>
          </Show>

          <Show
            when={
              raids().length > 0 && hardReserves().length < MAX_HARD_RESERVES
            }
          >
            <SearchInput
              value={hardReserveSearch()}
              placeholder={t`Search the selected raids' loot…`}
              onInput={(event) =>
                setHardReserveSearch(event.currentTarget.value)
              }
            />
            <Show when={hardReserveMatches().length > 0}>
              <Candidates>
                <For each={hardReserveMatches()}>
                  {(item) => (
                    <Candidate
                      type="button"
                      onClick={() => addHardReserve(item)}
                    >
                      <CandidateName data-quality={item.quality}>
                        {item.name}
                      </CandidateName>
                      <CandidateBoss>{item.boss}</CandidateBoss>
                    </Candidate>
                  )}
                </For>
              </Candidates>
            </Show>
          </Show>
        </Column>
      </Column>
    </Dialog>
  );
}

const FieldLabel = styled("span", {
  base: {
    fontSize: "0.8125rem",
    fontWeight: "600",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const EventChip = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    width: "fit-content",
    padding: "6px 12px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.8125rem",
  },
});

const ErrorNotice = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    alignItems: "flex-start",
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.8125rem",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
  },
});

const ChipRow = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const Chip = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "6px 12px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    fontSize: "0.8125rem",
    border: "1px solid transparent",
    "&[data-selected]": {
      background: "var(--md-sys-color-primary-container)",
      color: "var(--md-sys-color-on-primary-container)",
      borderColor: "var(--md-sys-color-primary)",
    },
    "&[data-disabled]": {
      opacity: 0.5,
      cursor: "not-allowed",
    },
  },
});

const ToggleRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    cursor: "pointer",
    userSelect: "none",
    fontSize: "0.9rem",
  },
});

const ToggleBox = styled("div", {
  base: {
    width: "20px",
    height: "20px",
    borderRadius: "6px",
    display: "grid",
    placeItems: "center",
    border: "2px solid var(--md-sys-color-outline)",
    color: "var(--md-sys-color-on-primary)",
    flexShrink: 0,
    "&[data-checked]": {
      background: "var(--md-sys-color-primary)",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const Hint = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    alignItems: "flex-start",
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.8125rem",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const SearchInput = styled("input", {
  base: {
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
  },
});

const SmallInput = styled("input", {
  base: {
    flexGrow: 1,
    minWidth: 0,
    padding: "8px 10px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.85rem",
    "&:focus": {
      outline: "none",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const HardReserveRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});

/** WoW quality colors (3 rare / 4 epic / 5 legendary) */
const qualityVariants = {
  base: {
    fontSize: "0.85rem",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "180px",
    flexShrink: 0,
    '&[data-quality="3"]': { color: "#0070dd" },
    '&[data-quality="4"]': { color: "#a335ee" },
    '&[data-quality="5"]': { color: "#ff8000" },
    // Unresolvable against the selected raids — blocks Save until removed
    "&[data-orphan]": {
      color: "var(--md-sys-color-error)",
      textDecoration: "line-through",
    },
  },
};

const HardReserveItem = styled("span", qualityVariants);

const Candidates = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxHeight: "200px",
    overflowY: "auto",
  },
});

const Candidate = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "6px 10px",
    borderRadius: "8px",
    textAlign: "left",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
  },
});

const CandidateName = styled("span", {
  base: {
    flexGrow: 1,
    fontSize: "0.85rem",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    '&[data-quality="3"]': { color: "#0070dd" },
    '&[data-quality="4"]': { color: "#a335ee" },
    '&[data-quality="5"]': { color: "#ff8000" },
  },
});

const CandidateBoss = styled("span", {
  base: {
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
    whiteSpace: "nowrap",
  },
});

const Empty = styled("span", {
  base: {
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

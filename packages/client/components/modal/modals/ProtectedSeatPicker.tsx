import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { ServerMember } from "stoat.js";
import { ProtectedChannelUnavailable } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import {
  errorUiCopy,
  noticeCopy,
  seatPickerCopy,
  settingsCopy,
} from "@revolt/client/protectedCopy";
import {
  type ProtectedErrorUi,
  protectedNoticeForError,
} from "@revolt/client/protectedShield";
import { useProtectedShield } from "@revolt/client/useProtectedChannel";
import { Avatar } from "@revolt/ui/components/design/Avatar";
import { type DialogProps, Dialog } from "@revolt/ui/components/design/Dialog";
import { CircularProgress } from "@revolt/ui/components/design/LoadingProgress";
import { Column } from "@revolt/ui/components/layout/Column";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { Modals } from "../types";

/** Rows shown for unseated members before the owner has to search. */
const UNSEATED_ROW_LIMIT = 100;

interface SeatRow {
  candidate: SeatCandidate;
  name: string;
  avatar?: string;
  /** Seated now but this client can't see ViewChannel for them. */
  withoutAccess: boolean;
}

/**
 * Protected channel seat picker (W4 lane C12, plan product choice 4).
 *
 * Lists the server members this client believes may be seated (not bots,
 * can view the channel); the server validates every seat (design 4.3 step
 * 5). The owner row is always checked and locked, current seats start
 * checked and may be removed, and `slotCap` caps the selection (null =
 * unknown: shown as unknown, never treated as 0 or unlimited). `current`
 * never holds a user the server removed (the page leaves them out, W4d);
 * `removed` and a refusal naming such users get the same treatment.
 *
 * Confirm hands the FULL new seat list (owner first) to `onConfirm`, which
 * signs and publishes it (D7 is the bridge's job; growth gets native's own
 * confirmation dialog, design 4.9). The modal stays open with a spinner
 * until that settles; a rejection shows its plan D17 notice, a native
 * `Declined` (the user cancelled native's dialog) shows nothing.
 */
export function ProtectedSeatPickerModal(
  props: DialogProps & Modals & { type: "protected_seat_picker" },
) {
  const { t } = useLingui();
  const client = useClient();
  const shield = useProtectedShield(() => props.channel.id);

  // The pinned props are fixed for the modal's life.
  // eslint-disable-next-line solid/reactivity
  const slotCap = seatCapOf(props.slotCap);

  const ownerId = () => props.channel.server?.ownerId ?? null;
  const viewerIsOwner = () => {
    const owner = ownerId();
    return owner !== null && client().user?.id === owner;
  };

  // W4d: users the server removed whom the signed list still names: the
  // page's `removed` prop at open, plus any a `SeatListNamesRemovedUsers`
  // refusal names later. Left off (never selected, unlisted, never in a
  // list), and a list without them counts as a change; nothing resubmits.
  const [dropped, setDropped] = createSignal<ReadonlySet<string>>(
    // eslint-disable-next-line solid/reactivity
    new Set(seatDroppedIds(props.removed, ownerId())),
  );
  const currentIds = createMemo(() => seatWithout(props.current, dropped()));
  const current = createMemo(() => new Set(currentIds()));

  const [selected, setSelected] = createSignal<ReadonlySet<string>>(
    // eslint-disable-next-line solid/reactivity
    seatInitialSelection(currentIds(), ownerId()),
  );
  const [query, setQuery] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [loaded, setLoaded] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(false);

  onMount(() => {
    const server = props.channel.server;
    if (!server) {
      setLoaded(true);
      return;
    }
    server
      .syncMembers()
      .catch(() => setLoadFailed(true))
      .finally(() => setLoaded(true));
  });

  /** Candidate facts for a member, as far as this client knows them. */
  function candidateOf(member: ServerMember): SeatCandidate | null {
    const user = member.user;
    if (!user) return null;
    return {
      id: user.id,
      bot: !!user.bot,
      privileged: user.privileged === true,
      canView: member.hasPermission(props.channel, "ViewChannel"),
    };
  }

  const rows = createMemo((): SeatRow[] => {
    const c = client();
    const owner = ownerId();
    const serverId = props.channel.serverId;
    const byId = new Map<string, SeatRow>();

    for (const member of c.serverMembers.filter(
      (m) => m.id.server === serverId,
    )) {
      const candidate = candidateOf(member);
      if (!candidate || !seatListed(candidate, current(), owner, dropped())) {
        continue;
      }
      byId.set(candidate.id, {
        candidate,
        name: member.displayName ?? candidate.id,
        avatar: member.animatedAvatarURL,
        withoutAccess:
          current().has(candidate.id) &&
          candidate.id !== owner &&
          !candidate.canView,
      });
    }

    // Seats whose member this client doesn't hold stay listed (and in the
    // returned list until the owner removes them): dropping them silently
    // would unseat people.
    for (const id of owner === null ? currentIds() : [owner, ...current()]) {
      if (byId.has(id)) continue;
      const user = c.users.get(id);
      byId.set(id, {
        candidate: {
          id,
          bot: !!user?.bot,
          privileged: user?.privileged === true,
          canView: false,
        },
        name: user?.displayName ?? id,
        avatar: user?.animatedAvatarURL,
        withoutAccess: id !== owner && loaded(),
      });
    }

    const seatedNow = current();
    const rank = (id: string) => (id === owner ? 0 : seatedNow.has(id) ? 1 : 2);
    return [...byId.values()].sort(
      (a, b) =>
        rank(a.candidate.id) - rank(b.candidate.id) ||
        a.name.localeCompare(b.name),
    );
  });

  const visible = createMemo(() => {
    const search = query().trim().toLowerCase();
    const matched = rows().filter((row) => {
      if (!search) return true;
      const username = client().users.get(row.candidate.id)?.username ?? "";
      return (
        row.name.toLowerCase().includes(search) ||
        username.toLowerCase().includes(search)
      );
    });
    const seated = matched.filter(
      (row) =>
        row.candidate.id === ownerId() || current().has(row.candidate.id),
    );
    const others = matched.filter(
      (row) =>
        row.candidate.id !== ownerId() && !current().has(row.candidate.id),
    );
    return {
      rows: [...seated, ...others.slice(0, UNSEATED_ROW_LIMIT)],
      truncated: others.length > UNSEATED_ROW_LIMIT,
    };
  });

  const used = () => {
    const owner = ownerId();
    return owner === null
      ? selected().size
      : seatFinalList(currentIds(), selected(), owner).length;
  };

  const blockOf = (row: SeatRow) =>
    seatToggleBlock(row.candidate, selected(), current(), ownerId(), slotCap);

  const canConfirm = () =>
    !pending() &&
    viewerIsOwner() &&
    seatCanConfirm(
      currentIds(),
      selected(),
      ownerId(),
      slotCap,
      dropped().size > 0,
    );

  function toggle(row: SeatRow) {
    if (pending() || blockOf(row) !== null) return;
    setSelected((prev) => seatToggled(prev, row.candidate.id));
    setError(null);
  }

  /** Plan D17 answer for a rejected `onConfirm`. */
  function errorUiOf(err: unknown): ProtectedErrorUi {
    if (
      err instanceof ProtectedChannelUnavailable ||
      (err instanceof Error && err.name === "ProtectedChannelUnavailable")
    ) {
      return {
        kind: "notice",
        notice:
          shield()?.notice === "enable_e2ee" ? "enable_e2ee" : "not_available",
        max: null,
        tag: "ProtectedChannelUnavailable",
      };
    }
    return protectedNoticeForError(err, { op: "owner" });
  }

  /** Display names for the refusal copy; null when not known here. */
  function displayNames(userIds: readonly string[]): (string | null)[] {
    const c = client();
    return userIds.map((id) => {
      const member = c.serverMembers.getByKey({
        server: props.channel.serverId,
        user: id,
      });
      return member?.displayName ?? c.users.get(id)?.displayName ?? null;
    });
  }

  // W4d N3: users left off are named before Confirm; fetch unknown ones.
  const requested = new Set<string>();
  createEffect(() => {
    const c = client();
    for (const id of dropped()) {
      if (requested.has(id) || c.users.get(id)) continue;
      requested.add(id);
      c.users.fetch(id).catch(() => {
        // the line falls back to the id; nothing else depends on it
      });
    }
  });

  /** W4d N3: NEW local msgid (catalog owed), same text as SeatList's. */
  const leftOffLine = (names: string) =>
    t`Will be left off the seat list: ${names}`;

  /** The disclosure above Confirm, or null when nobody is left off. */
  const leftOff = (): string | null => {
    const ids = [...dropped()];
    if (ids.length === 0) return null;
    return leftOffLine(seatLeftOffNames(ids, displayNames(ids)));
  };

  async function confirm() {
    const owner = ownerId();
    if (!canConfirm() || owner === null) return;
    setPending(true);
    setError(null);
    try {
      await props.onConfirm(seatFinalList(currentIds(), selected(), owner));
      props.onClose();
    } catch (err) {
      const ui = errorUiOf(err);
      // ids only (D16); `none` is native `Declined`: stay open, silently
      if (ui.kind !== "none") {
        console.error("[protected] seat change failed", { tag: ui.tag });
      }
      // W4d: deselect exactly the users the server named and keep them off
      // (the copy says they were left off); the owner confirms again.
      const removed = seatRefusalRemoved(ui, owner);
      if (removed.length > 0) {
        setDropped((prev) => new Set([...prev, ...removed]));
        setSelected((prev) => new Set(seatWithout(prev, removed)));
      }
      setError(errorUiCopy(ui, { removedUserNames: displayNames }));
    } finally {
      setPending(false);
    }
  }

  /** C16: local msgid (C0 has no counter for an unknown cap). */
  const unknownCapLine = (count: number) =>
    t`Seats used: ${count}. The seat limit isn't known yet.`;

  /** Closing waits for the publish to settle. */
  function close() {
    if (!pending()) props.onClose();
  }

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={close}
      title={seatPickerCopy.title()}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: seatPickerCopy.confirm(),
          onClick: () => {
            void confirm();
            return false;
          },
          isDisabled: !canConfirm(),
        },
      ]}
      isDisabled={pending()}
    >
      <Column>
        <Description>{seatPickerCopy.description()}</Description>

        <Show when={!viewerIsOwner()}>
          <Notice role="alert">{settingsCopy.ownerOnly()}</Notice>
        </Show>

        <Counter aria-live="polite">
          {slotCap === null ? (
            <span>{unknownCapLine(used())}</span>
          ) : (
            <>
              <span>{settingsCopy.seatsUsed(used(), slotCap)}</span>
              <span>
                {seatPickerCopy.seatsLeft(Math.max(0, slotCap - used()))}
              </span>
            </>
          )}
          <Show when={pending()}>
            <CircularProgress size={20} />
          </Show>
        </Counter>

        <SearchInput
          value={query()}
          placeholder={seatPickerCopy.searchPlaceholder()}
          aria-label={seatPickerCopy.searchPlaceholder()}
          onInput={(event) => setQuery(event.currentTarget.value)}
          disabled={pending()}
        />

        <Show when={loadFailed()}>
          <Notice role="alert">{noticeCopy("network_error")}</Notice>
        </Show>

        <Rows>
          <Show when={!loaded() && rows().length <= 1}>
            <Empty>
              <CircularProgress size={32} />
            </Empty>
          </Show>
          <For each={visible().rows}>
            {(row) => {
              const isOwner = () => row.candidate.id === ownerId();
              const checked = () =>
                isOwner() || selected().has(row.candidate.id);
              const block = () => blockOf(row);
              return (
                <SeatButton
                  type="button"
                  role="checkbox"
                  aria-checked={checked()}
                  aria-disabled={block() !== null || pending()}
                  data-blocked={block() !== null || undefined}
                  disabled={pending()}
                  onClick={() => toggle(row)}
                >
                  <Symbol size={20} fill={checked()}>
                    {checked() ? "check_box" : "check_box_outline_blank"}
                  </Symbol>
                  <Avatar src={row.avatar} fallback={row.name} size={24} />
                  <SeatText>
                    <SeatName>{row.name}</SeatName>
                    <Show when={block() === "staff"}>
                      <SeatNote>
                        {/* C16: local msgid */}
                        {t`Staff accounts can't be seated.`}
                      </SeatNote>
                    </Show>
                    <Show when={row.withoutAccess}>
                      <SeatNote>
                        {/* C16: local msgid */}
                        {t`Can't view this channel anymore.`}
                      </SeatNote>
                    </Show>
                  </SeatText>
                  <Show when={isOwner()}>
                    <Badge>{settingsCopy.ownerBadge()}</Badge>
                  </Show>
                </SeatButton>
              );
            }}
          </For>
          <Show when={loaded() && visible().rows.length === 0}>
            <Empty>{seatPickerCopy.noResults()}</Empty>
          </Show>
          <Show when={visible().truncated}>
            <Empty>
              {/* C16: local msgid */}
              {t`Search to find more members.`}
            </Empty>
          </Show>
        </Rows>

        <Show when={error()}>
          <Notice role="alert">{error()}</Notice>
        </Show>

        {/* W4d N3: right above Confirm, whenever anyone is left off. */}
        <Show when={leftOff()}>
          {(line) => (
            <LeftOff role="status" data-left-off>
              {line()}
            </LeftOff>
          )}
        </Show>
      </Column>
    </Dialog>
  );
}

// protected-pure:begin
// Seat rules, loaded by `protectedSeatPicker.scan.test.ts`: no imports.

/** What this client knows about one person, for the rules below. */
interface SeatCandidate {
  id: string;
  bot: boolean;
  /** Staff: the server refuses to seat them (design 4.3 step 5). */
  privileged: boolean;
  /** ViewChannel on this channel, per the client's permission calculus. */
  canView: boolean;
}

/** Why a row can't be toggled now; null when it can. */
type SeatBlock = "owner" | "bot" | "staff" | "no_access" | "cap";

/**
 * The cap as a count, or null when unknown. Null (and anything that isn't
 * a non-negative safe integer) is NEVER 0 and NEVER unlimited: it only
 * stops the client from enforcing a limit; the server still does.
 */
function seatCapOf(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** True when `count` seats leave no room under a known cap. */
function seatCapFull(count: number, slotCap: number | null): boolean {
  return slotCap !== null && count >= slotCap;
}

/** True when `count` seats are over a known cap. */
function seatCapExceeded(count: number, slotCap: number | null): boolean {
  return slotCap !== null && count > slotCap;
}

/**
 * Whether a row is listed: the owner and current seats always are; a user
 * a removed-users refusal named (`dropped`, W4d) never is, until a list
 * without them lands (re-adding is then an ordinary add).
 */
function seatListed(
  c: SeatCandidate,
  current: ReadonlySet<string>,
  ownerId: string | null,
  dropped: ReadonlySet<string> = new Set(),
): boolean {
  if (c.id === ownerId) return true;
  if (dropped.has(c.id)) return false;
  if (current.has(c.id)) return true;
  return !c.bot && c.canView;
}

/**
 * W4d N3: the names of the users left off, in order (`names[i]` for
 * `ids[i]`); an unresolved user shows as their id (the owner must see
 * everyone the list drops).
 */
function seatLeftOffNames(
  ids: readonly string[],
  names: readonly (string | null | undefined)[],
): string {
  return ids
    .map((id, i) => {
      const n = names[i];
      return typeof n === "string" && n.trim().length > 0 ? n : id;
    })
    .join(", ");
}

/** `ids` without any of `drop`, in order (W4d). */
function seatWithout(ids: Iterable<string>, drop: Iterable<string>): string[] {
  const gone = new Set(drop);
  return [...ids].filter((id) => !gone.has(id));
}

/**
 * W4d (W2 C1): the users a `SeatListNamesRemovedUsers` refusal names (the
 * `protectedNoticeForError` answer, kind `seat_list_names_removed_users`),
 * never the owner; empty for any other answer.
 */
function seatRefusalRemoved(ui: unknown, ownerId: string | null): string[] {
  if (typeof ui !== "object" || ui === null) return [];
  const u = ui as { kind?: unknown; notice?: unknown; users?: unknown };
  if (u.kind !== "notice" || u.notice !== "seat_list_names_removed_users") {
    return [];
  }
  return seatDroppedIds(u.users, ownerId);
}

/**
 * W4d: removed-user ids (the `removed` prop, a refusal's `users`): the
 * non-empty strings, deduplicated, never the owner; [] when not an array.
 */
function seatDroppedIds(ids: unknown, ownerId: string | null): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || id === ownerId) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The starting selection: the owner plus every current seat. */
function seatInitialSelection(
  current: readonly string[],
  ownerId: string | null,
): Set<string> {
  return new Set(ownerId === null ? current : [ownerId, ...current]);
}

/**
 * The full list handed to `onConfirm`: the owner first (always, even if
 * the selection lost it), then kept seats in their current order, then
 * additions in the order they were picked. No duplicates.
 */
function seatFinalList(
  current: readonly string[],
  selected: ReadonlySet<string>,
  ownerId: string,
): string[] {
  const out = [ownerId];
  for (const id of current) {
    if (selected.has(id) && !out.includes(id)) out.push(id);
  }
  for (const id of selected) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Why toggling `c` is refused. The owner row never toggles; removing a
 * seat always may; a NEW seat needs a listed, non-staff member who can
 * view the channel and room under a known cap. Re-checking a current seat
 * is not a new claim (design 4.3 step 5: ViewChannel only for new ones).
 */
function seatToggleBlock(
  c: SeatCandidate,
  selected: ReadonlySet<string>,
  current: ReadonlySet<string>,
  ownerId: string | null,
  slotCap: number | null,
): SeatBlock | null {
  if (ownerId === null || c.id === ownerId) return "owner";
  if (selected.has(c.id)) return null;
  if (!current.has(c.id)) {
    if (c.bot) return "bot";
    if (c.privileged) return "staff";
    if (!c.canView) return "no_access";
  }
  const count = seatFinalList([...current], selected, ownerId).length;
  return seatCapFull(count, slotCap) ? "cap" : null;
}

/** `selected` with `id` flipped (a new set). */
function seatToggled(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Whether Confirm may run: an owner is known, the list changed, and a list
 * that ADDS anyone fits a known cap. A removal-only list is never blocked
 * by the cap (an owner over a lowered cap must be able to shrink).
 * Genesis (`current` empty, the protect flow): any list within a known cap
 * may be confirmed, the owner-only list included (design 6.3 "Protect").
 * `cleanup` (W4d): a refusal named removed users the server's list still
 * holds, so the list without them is a change even when nothing else is.
 */
function seatCanConfirm(
  current: readonly string[],
  selected: ReadonlySet<string>,
  ownerId: string | null,
  slotCap: number | null,
  cleanup = false,
): boolean {
  if (ownerId === null) return false;
  const list = seatFinalList(current, selected, ownerId);
  if (current.length === 0) return !seatCapExceeded(list.length, slotCap);
  const before = new Set([ownerId, ...current]);
  const adds = list.some((id) => !before.has(id));
  if (!adds && list.length === before.size) return cleanup;
  return !(adds && seatCapExceeded(list.length, slotCap));
}
// protected-pure:end

const Description = styled("p", {
  base: {
    margin: 0,
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Counter = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Notice = styled("div", {
  base: {
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
  },
});

const LeftOff = styled("div", {
  base: {
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    background: "var(--md-sys-color-tertiary-container)",
    color: "var(--md-sys-color-on-tertiary-container)",
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

const Rows = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxHeight: "320px",
    overflowY: "auto",
  },
});

const SeatButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "8px 10px",
    borderRadius: "8px",
    textAlign: "left",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    "&:hover": {
      background: "var(--md-sys-color-surface-container-high)",
    },
    "&[data-blocked]": {
      cursor: "default",
      opacity: 0.6,
    },
  },
});

const SeatText = styled("span", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
});

const SeatName = styled("span", {
  base: {
    fontSize: "0.9rem",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const SeatNote = styled("span", {
  base: {
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Badge = styled("span", {
  base: {
    fontSize: "0.75rem",
    padding: "2px 8px",
    borderRadius: "999px",
    background: "var(--md-sys-color-secondary-container)",
    color: "var(--md-sys-color-on-secondary-container)",
  },
});

const Empty = styled("div", {
  base: {
    display: "flex",
    justifyContent: "center",
    padding: "16px",
    textAlign: "center",
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

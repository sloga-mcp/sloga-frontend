import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { noticeCopy, settingsCopy } from "@revolt/client/protectedCopy";
import {
  type SeatReleaseCause,
  seatReleasedRows,
  seatUntilText,
  seatUsedCount,
} from "@revolt/client/protectedSeatUiPolicy";
import type { ProtectedSeatsResponse } from "@revolt/client/protectedTextTypes";
import { Avatar } from "@revolt/ui/components/design/Avatar";
import { Button } from "@revolt/ui/components/design/Button";

export interface SeatListProps {
  channel: Channel;
  /** The last `GET .../seats` body (design 7.2). */
  seats: ProtectedSeatsResponse;
  /** The server owner, always seated, never removable here. */
  ownerId: string;
  /**
   * Users the server removed whom the signed list still names
   * (`serverRemovedSeatIds`, W4d): shown read-only, never as seated.
   */
  removed: readonly string[];
  /** Hide the per-row Remove (not capable, unknown device cap). */
  hideRemove: boolean;
  /** Disable Remove (a seat publish is in flight, D7). */
  disabled: boolean;
  onRemove: (userId: string) => void;
  /**
   * S2 D39: devices per user in the open Text group
   * (`seatDeviceCounts`); null when unknown (no device column, never 0).
   */
  deviceCounts: ReadonlyMap<string, number> | null;
  /**
   * S2 D39 "Update the list": sign the list without `removed`. Removal
   * only, so no native dialog and never blocked by the seat limit.
   */
  onUpdateList: () => void;
}

/**
 * Seat list of a Protected channel (W4 lane C11, design 7.2 and 6.4): who
 * is seated (owner first), seats the owner should take back because the
 * member can't view the channel anymore (`seated_without_access`, sent only
 * to the owner), released seats still counted until `cooldown_until`, and
 * the seat and device caps. A null cap is unknown, never 0 or unlimited.
 * Members the server removed whom the signed list still names (W4d) are
 * a separate read-only group, never seated rows.
 * S2 D39 (lane U9): released seats show their cause (owner reads carry
 * it) and count toward the seat limit; seated rows show their devices in
 * the open Text group; the removed group gets "Update the list".
 * Display only, apart from the per-row Remove and "Update the list" the
 * page wires up.
 */
export function SeatList(props: SeatListProps) {
  const { t } = useLingui();
  const client = useClient();

  /**
   * Display name and avatar, as the member list shows them. `known` is
   * null when this client can't name the user.
   */
  function person(userId: string) {
    const c = client();
    const member = c.serverMembers.getByKey({
      server: props.channel.serverId,
      user: userId,
    });
    const user = c.users.get(userId);
    const known = member?.displayName ?? user?.displayName ?? null;
    return {
      known,
      name: known ?? userId,
      avatar: member?.animatedAvatarURL ?? user?.animatedAvatarURL,
    };
  }

  /** S2 D39: released seats still cooling, with their cause (owner reads). */
  const released = createMemo(() => seatReleasedRows(props.seats.cooling));

  // Seated people this client has never loaded: fetch each once.
  const requested = new Set<string>();
  createEffect(() => {
    const c = client();
    const ids = [
      ...seatRows(props.seats.seats, props.ownerId).map((r) => r.userId),
      ...released().map((r) => r.userId),
      ...props.removed,
    ];
    for (const id of ids) {
      if (requested.has(id) || c.users.get(id)) continue;
      requested.add(id);
      c.users.fetch(id).catch(() => {
        // name falls back to the id; nothing else depends on it
      });
    }
  });

  const rows = () => seatRows(props.seats.seats, props.ownerId, props.removed);
  const slotCap = () => seatCount(props.seats.slot_cap);
  // S2 D39 cap clamp: the server's count is active + cooling (design 2.3).
  // Without it: the seated rows plus every released seat still cooling,
  // never the rows alone (a lower bound; the server still checks).
  const used = () =>
    seatCount(props.seats.seats_used) ??
    seatUsedCount(
      seatRows(props.seats.seats, props.ownerId).map((r) => r.userId),
      released().map((r) => r.userId),
    );
  const device = () => deviceCapLine(props.seats.device_cap);

  /**
   * S2 D39: a seated user's devices in the open Text group, or null when
   * the group's members aren't known (no column; never read as 0).
   */
  const devicesOf = (userId: string): { count: number } | null => {
    const counts = props.deviceCounts;
    if (counts === null) return null;
    const n = counts.get(userId);
    return { count: n === undefined ? 0 : n };
  };

  // ---- S2 D39 local msgids, the seat picker's texts (catalog owed, L9) ---

  /** A user this client can't name (never the id). */
  const unknownMember = () => t`Unknown member`;
  const releasedTitle = () => t`Released seats`;
  const untilLine = (until: string) =>
    t`Counts toward the seat limit until ${until}`;
  const noSeatsLine = (count: number) =>
    t`People on your signed list who no longer have seats: ${count}`;
  const updateListLabel = () => t`Update the list`;
  const devicesLine = (count: number) => t`Devices: ${count}`;

  /** Why a released seat was released; null when the read has no cause. */
  function causeLine(cause: SeatReleaseCause | null): string | null {
    switch (cause) {
      case null:
        return null;
      case "owner_unseat":
        return t`Removed from the seat list`;
      case "server_removal":
        return t`Removed from the server`;
      case "access_lost":
        return t`Lost access to this channel`;
      case "device_never_joined":
        return t`No device joined before the seat was released`;
      default: {
        const _exhaustive: never = cause;
        return null;
      }
    }
  }

  /** C16: local msgid, same text as the seat picker's (C12). */
  const unknownCapLine = (count: number) =>
    t`Seats used: ${count}. The seat limit isn't known yet.`;

  /** The row whose "Remove seat" awaits confirmation (W4c#4). */
  const [confirmId, setConfirmId] = createSignal<string | null>(null);

  /** C16: local msgid (W4c#4 unseat confirmation, design 6.3 / 7.2). */
  const removeConfirmLine = (name: string) =>
    t`Remove ${name}'s seat? They lose access to this channel on all their devices, and the released seat still counts toward the seat limit for 14 days.`;

  /** W4d N3: NEW local msgid (catalog owed), same text as the picker's. */
  const leftOffLine = (names: string) =>
    t`Will be left off the seat list: ${names}`;

  /** The confirm's disclosure for `target`: who else the list drops. */
  const leftOff = (target: string): string | null => {
    const ids = leftOffBesides(
      props.seats,
      props.ownerId,
      props.removed,
      target,
    );
    if (ids.length === 0) return null;
    return leftOffLine(ids.map((id) => person(id).name).join(", "));
  };

  return (
    <Wrapper>
      <Heading>{settingsCopy.seatsHeading()}</Heading>

      <Facts aria-live="polite">
        <span data-seat-cap={slotCap() === null ? "unknown" : "known"}>
          {slotCap() === null
            ? unknownCapLine(used())
            : settingsCopy.seatsUsed(used(), slotCap()!)}
        </span>
        <span data-device-cap={device().kind}>
          {(() => {
            const d = device();
            switch (d.kind) {
              case "max":
                return settingsCopy.deviceCap(d.max);
              case "unlimited":
                // C16: local msgid (0 = unlimited, design 4.1)
                return t`Each member can use any number of devices.`;
              case "unknown":
                // C16: local msgid (null = unknown, design 7.2)
                return t`The device limit isn't known yet.`;
              default: {
                const _exhaustive: never = d;
                return t`The device limit isn't known yet.`;
              }
            }
          })()}
        </span>
      </Facts>

      <Rows>
        <Show when={rows().length === 0}>
          <Empty>{settingsCopy.noSeats()}</Empty>
        </Show>
        <For each={rows()}>
          {(row) => {
            const who = () => person(row.userId);
            const line = (
              <Row data-without-access={row.withoutAccess || undefined}>
                <Avatar src={who().avatar} fallback={who().name} size={32} />
                <RowText>
                  <RowName>{who().name}</RowName>
                  <Show when={row.withoutAccess}>
                    <RowAlert>
                      {/* C16: local msgid, same text as C12's */}
                      {t`Can't view this channel anymore.`}
                    </RowAlert>
                  </Show>
                </RowText>
                {/* S2 D39: the seated user's devices in the group. */}
                <Show when={devicesOf(row.userId)}>
                  {(d) => (
                    <RowDevices data-devices>
                      {devicesLine(d().count)}
                    </RowDevices>
                  )}
                </Show>
                <Show when={row.owner}>
                  <Badge>{settingsCopy.ownerBadge()}</Badge>
                </Show>
                <Show
                  when={
                    !row.owner &&
                    !props.hideRemove &&
                    confirmId() !== row.userId
                  }
                >
                  <Button
                    size="sm"
                    variant={row.withoutAccess ? "_error" : "tonal"}
                    isDisabled={props.disabled}
                    onPress={() => setConfirmId(row.userId)}
                  >
                    {settingsCopy.removeSeat()}
                  </Button>
                </Show>
              </Row>
            );
            // Unseating removes every device of the member and the seat
            // keeps counting for 14 days: never on one click (W4c#4).
            const confirm = (
              <Show
                when={
                  !row.owner && !props.hideRemove && confirmId() === row.userId
                }
              >
                <Confirm role="group" data-remove-confirm={row.userId}>
                  <span>{removeConfirmLine(who().name)}</span>
                  <Show when={leftOff(row.userId)}>
                    {(line) => <span data-left-off>{line()}</span>}
                  </Show>
                  <Actions>
                    <Button
                      size="sm"
                      variant="text"
                      onPress={() => setConfirmId(null)}
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                    <Button
                      size="sm"
                      variant="_error"
                      isDisabled={props.disabled}
                      onPress={() => {
                        setConfirmId(null);
                        props.onRemove(row.userId);
                      }}
                    >
                      {settingsCopy.removeSeat()}
                    </Button>
                  </Actions>
                </Confirm>
              </Show>
            );
            return (
              <>
                {line}
                {confirm}
              </>
            );
          }}
        </For>
      </Rows>

      {/* W4d: removed by the server, still named by the signed list. Read
          only: no Remove, and left off every list this page submits. */}
      <Show when={props.removed.length > 0}>
        <RemovedNote role="status" data-server-removed-note>
          {noticeCopy("seat_list_names_removed_users")}
        </RemovedNote>
        <Rows>
          <For each={props.removed}>
            {(userId) => {
              const who = () => person(userId);
              return (
                <Row data-server-removed={userId}>
                  <Avatar src={who().avatar} fallback={who().name} size={32} />
                  <RowText>
                    <RowName>{who().name}</RowName>
                  </RowText>
                </Row>
              );
            }}
          </For>
        </Rows>
      </Show>

      {/* S2 D39: the signed list still names them. "Update the list" signs
          it without them: removal only (no native dialog, never blocked by
          the seat limit), hidden with the per-row Remove. */}
      <Show when={props.removed.length > 0}>
        <Callout role="status" data-update-list>
          <span>{noSeatsLine(props.removed.length)}</span>
          <Show when={!props.hideRemove}>
            <Button
              size="sm"
              variant="tonal"
              isDisabled={props.disabled}
              onPress={() => props.onUpdateList()}
            >
              {updateListLabel()}
            </Button>
          </Show>
        </Callout>
      </Show>

      {/* S2 D39: released seats count for 14 days (design 2.3), with why. */}
      <Show when={released().length > 0}>
        <SubHeading>{releasedTitle()}</SubHeading>
        <Rows>
          <For each={released()}>
            {(row) => {
              const who = () => person(row.userId);
              const name = () => who().known ?? unknownMember();
              return (
                <Row data-cooling>
                  <Avatar src={who().avatar} fallback={name()} size={32} />
                  <RowText>
                    <RowName>{name()}</RowName>
                    <Show when={causeLine(row.cause)}>
                      {(line) => <RowNote data-cause>{line()}</RowNote>}
                    </Show>
                    <RowNote>
                      {(() => {
                        const until = seatUntilText(row.until);
                        return until === null
                          ? // C16: local msgid
                            t`Counts as a used seat for 14 days after release.`
                          : untilLine(until);
                      })()}
                    </RowNote>
                  </RowText>
                </Row>
              );
            }}
          </For>
        </Rows>
      </Show>
    </Wrapper>
  );
}

// protected-pure:begin
// Seat list rules, loaded by `protectedSettings.scan.test.ts`: no imports.

/** One `seats[]` row of `GET .../seats` as far as these rules read it. */
interface SeatRowInput {
  user_id: unknown;
  seated_without_access?: unknown;
}

export interface SeatRowView {
  userId: string;
  owner: boolean;
  /** Owner-only server fact (design 6.4): highlight for unseating. */
  withoutAccess: boolean;
}

/**
 * A cap or count as a number, or null when unknown. Null (and anything
 * that isn't a non-negative safe integer) is NEVER 0 and NEVER unlimited.
 */
export function seatCount(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Seated rows, deduplicated, owner first, otherwise in server order. Users
 * in `removed` (`serverRemovedSeatIds`) are left out: they get their own
 * read-only group, even while a stale read still shows their seat.
 */
export function seatRows(
  seats: readonly SeatRowInput[] | unknown,
  ownerId: string,
  removed: readonly string[] = [],
): SeatRowView[] {
  if (!Array.isArray(seats)) return [];
  const seen = new Set<string>();
  const out: SeatRowView[] = [];
  for (const s of seats as SeatRowInput[]) {
    const id = s?.user_id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    if (id !== ownerId && removed.includes(id)) continue;
    seen.add(id);
    out.push({
      userId: id,
      owner: id === ownerId,
      withoutAccess: id !== ownerId && s.seated_without_access === true,
    });
  }
  return [...out.filter((r) => r.owner), ...out.filter((r) => !r.owner)];
}

export type DeviceCapLine =
  | { kind: "unknown" }
  | { kind: "unlimited" }
  | { kind: "max"; max: number };

/** The enforced device cap: null = unknown, 0 = unlimited (design 4.1). */
export function deviceCapLine(v: unknown): DeviceCapLine {
  const n = seatCount(v);
  if (n === null) return { kind: "unknown" };
  return n === 0 ? { kind: "unlimited" } : { kind: "max", max: n };
}

/** A user-facing date for an ISO 8601 time, or null when unreadable. */
export function formatUntil(iso: unknown): string | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

/**
 * Released seats still counted (design 7.2 `cooling`), for
 * `serverRemovedSeatIds`. The rendered "Released seats" rows come from the
 * shared policy's `seatReleasedRows` (S2 D39, with the cause).
 */
export function coolingRows(
  cooling: unknown,
): { userId: string; until: string | null }[] {
  if (!Array.isArray(cooling)) return [];
  const out: { userId: string; until: string | null }[] = [];
  for (const c of cooling as {
    user_id?: unknown;
    cooldown_until?: unknown;
  }[]) {
    if (typeof c?.user_id !== "string" || c.user_id.length === 0) continue;
    out.push({ userId: c.user_id, until: formatUntil(c.cooldown_until) });
  }
  return out;
}

/**
 * The seats of the signed list the server holds (`list.body`, design 4.1
 * `seats:` line), or null when absent or unreadable.
 */
export function listSeatIds(body: unknown): string[] | null {
  if (typeof body !== "string") return null;
  const line = body.split("\n").find((l) => l.startsWith("seats:"));
  if (line === undefined) return null;
  const ids = line.slice("seats:".length).split(",").filter(Boolean);
  return ids.length > 0 ? ids : null;
}

/**
 * The current seat ids a change starts from: the signed list's seats (what
 * native verified and signs the next version from), else the seat rows.
 */
export function currentSeatIds(r: {
  list?: { body?: unknown } | null;
  seats?: unknown;
}): string[] {
  const fromList = listSeatIds(r.list?.body);
  if (fromList !== null) return fromList;
  if (!Array.isArray(r.seats)) return [];
  const ids: string[] = [];
  for (const s of r.seats as SeatRowInput[]) {
    const id = s?.user_id;
    if (typeof id === "string" && id.length > 0 && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * W4d L-SET (W2 C1): the users the server removed (kick, ban, leaving the
 * server, account deletion) whom the signed list still names. A forced
 * release frees the seat but never edits the owner-signed list, and a seat
 * PUT still naming such a user is refused `SeatListNamesRemovedUsers`.
 * Only POSITIVE evidence counts (W4d N3): named by the list's `seats:`
 * line, not the owner (the signer is always seated), and either released
 * and cooling (in `cooling[]`, not in `seats[]`) or in `reported`, the ids
 * of such a refusal against this same list. Mere ABSENCE from `seats[]`
 * never counts: a server could omit a member from the owner's read alone
 * and have the owner sign them away. Such a user stays editable; if the
 * server really released them (an expired cooldown, say) the next save is
 * refused naming them. In list order. Empty without a readable list or
 * `seats` array: an unreadable read never leaves anyone off a list.
 */
export function serverRemovedSeatIds(
  r: { list?: { body?: unknown } | null; seats?: unknown; cooling?: unknown },
  ownerId: string,
  reported: readonly string[] = [],
): string[] {
  const listed = listSeatIds(r.list?.body);
  if (listed === null || !Array.isArray(r.seats)) return [];
  const active = new Set<string>();
  for (const s of r.seats as SeatRowInput[]) {
    if (typeof s?.user_id === "string") active.add(s.user_id);
  }
  const cooling = new Set(coolingRows(r.cooling).map((c) => c.userId));
  const out: string[] = [];
  for (const id of listed) {
    if (id === ownerId || out.includes(id)) continue;
    const released = cooling.has(id) && !active.has(id);
    if (released || reported.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The seat ids an owner change starts from (the picker's `current`, the
 * base of "Remove seat"): `currentSeatIds` without `removed`, so no list
 * this page submits names a user the server removed. Adding one back is
 * an ordinary add in the picker (growth, native's dialog).
 */
export function editableSeatIds(
  r: { list?: { body?: unknown } | null; seats?: unknown },
  removed: readonly string[],
): string[] {
  return currentSeatIds(r).filter((id) => !removed.includes(id));
}

/**
 * W4d N3 disclosure: who "Remove seat" for `target` leaves off the signed
 * list besides `target` (exactly what the page submits: the editable seats
 * without `target`), in list order. Empty when nothing else is dropped.
 */
export function leftOffBesides(
  r: { list?: { body?: unknown } | null; seats?: unknown },
  ownerId: string,
  removed: readonly string[],
  target: string,
): string[] {
  const next = seatsAfterRemoval(editableSeatIds(r, removed), ownerId, target);
  if (next === null) return [];
  return currentSeatIds(r).filter((id) => id !== target && !next.includes(id));
}

/** `ids` with the owner first and no duplicates (the signer is seated). */
export function ownerFirst(ids: readonly string[], ownerId: string): string[] {
  const out = [ownerId];
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0 && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/**
 * The list for "Remove seat": the current seats without `target`, owner
 * first. Null when `target` is the owner or isn't seated (nothing to do).
 */
export function seatsAfterRemoval(
  current: readonly string[],
  ownerId: string,
  target: string,
): string[] | null {
  if (target === ownerId || !current.includes(target)) return null;
  return ownerFirst(
    current.filter((id) => id !== target),
    ownerId,
  );
}
// protected-pure:end

const Wrapper = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
  },
});

const Heading = styled("h3", {
  base: {
    margin: 0,
    fontSize: "1rem",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface)",
  },
});

const SubHeading = styled("h4", {
  base: {
    margin: 0,
    fontSize: "0.9rem",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Facts = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Rows = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
});

const Row = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "8px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    "&[data-without-access]": {
      background: "var(--md-sys-color-error-container)",
      color: "var(--md-sys-color-on-error-container)",
    },
  },
});

const RowText = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
});

const RowName = styled("span", {
  base: {
    fontSize: "0.9rem",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const RowAlert = styled("span", {
  base: {
    fontSize: "0.8rem",
    fontWeight: 600,
  },
});

const RowNote = styled("span", {
  base: {
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const RowDevices = styled("span", {
  base: {
    flexShrink: 0,
    fontSize: "0.75rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Callout = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "8px",
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    background: "var(--md-sys-color-tertiary-container)",
    color: "var(--md-sys-color-on-tertiary-container)",
  },
});

const RemovedNote = styled("div", {
  base: {
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Confirm = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    border: "1px solid var(--md-sys-color-error)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-md)",
    justifyContent: "flex-end",
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
    padding: "12px",
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

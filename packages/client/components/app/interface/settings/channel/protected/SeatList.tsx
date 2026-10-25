import { For, Show, createEffect, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { settingsCopy } from "@revolt/client/protectedCopy";
import type { ProtectedSeatsResponse } from "@revolt/client/protectedTextTypes";
import { Avatar } from "@revolt/ui/components/design/Avatar";
import { Button } from "@revolt/ui/components/design/Button";

export interface SeatListProps {
  channel: Channel;
  /** The last `GET .../seats` body (design 7.2). */
  seats: ProtectedSeatsResponse;
  /** The server owner, always seated, never removable here. */
  ownerId: string;
  /** Hide the per-row Remove (not capable, unknown device cap). */
  hideRemove: boolean;
  /** Disable Remove (a seat publish is in flight, D7). */
  disabled: boolean;
  onRemove: (userId: string) => void;
}

/**
 * Seat list of a Protected channel (W4 lane C11, design 7.2 and 6.4): who
 * is seated (owner first), seats the owner should take back because the
 * member can't view the channel anymore (`seated_without_access`, sent only
 * to the owner), released seats still counted until `cooldown_until`, and
 * the seat and device caps. A null cap is unknown, never 0 or unlimited.
 * Display only, apart from the per-row Remove the page wires up.
 */
export function SeatList(props: SeatListProps) {
  const { t } = useLingui();
  const client = useClient();

  /** Display name and avatar, as the member list shows them. */
  function person(userId: string) {
    const c = client();
    const member = c.serverMembers.getByKey({
      server: props.channel.serverId,
      user: userId,
    });
    const user = c.users.get(userId);
    return {
      name: member?.displayName ?? user?.displayName ?? userId,
      avatar: member?.animatedAvatarURL ?? user?.animatedAvatarURL,
    };
  }

  // Seated people this client has never loaded: fetch each once.
  const requested = new Set<string>();
  createEffect(() => {
    const c = client();
    const ids = [
      ...seatRows(props.seats.seats, props.ownerId).map((r) => r.userId),
      ...coolingRows(props.seats.cooling).map((r) => r.userId),
    ];
    for (const id of ids) {
      if (requested.has(id) || c.users.get(id)) continue;
      requested.add(id);
      c.users.fetch(id).catch(() => {
        // name falls back to the id; nothing else depends on it
      });
    }
  });

  const rows = () => seatRows(props.seats.seats, props.ownerId);
  const cooling = () => coolingRows(props.seats.cooling);
  const slotCap = () => seatCount(props.seats.slot_cap);
  const used = () => seatsUsedOf(props.seats);
  const device = () => deviceCapLine(props.seats.device_cap);

  /** C16: local msgid, same text as the seat picker's (C12). */
  const unknownCapLine = (count: number) =>
    t`Seats used: ${count}. The seat limit isn't known yet.`;

  /** The row whose "Remove seat" awaits confirmation (W4c#4). */
  const [confirmId, setConfirmId] = createSignal<string | null>(null);

  /** C16: local msgid (W4c#4 unseat confirmation, design 6.3 / 7.2). */
  const removeConfirmLine = (name: string) =>
    t`Remove ${name}'s seat? They lose access to this channel on all their devices, and the released seat still counts toward the seat limit for 14 days.`;

  /** C16: local msgid (a released seat, design 7.2 `cooldown_until`). */
  const coolingUntilLine = (until: string) =>
    t`Counts as a used seat until ${until}.`;

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

      <Show when={cooling().length > 0}>
        <SubHeading>
          {/* C16: local msgid */}
          {t`Recently released seats`}
        </SubHeading>
        <Rows>
          <For each={cooling()}>
            {(row) => {
              const who = () => person(row.userId);
              return (
                <Row data-cooling>
                  <Avatar src={who().avatar} fallback={who().name} size={32} />
                  <RowText>
                    <RowName>{who().name}</RowName>
                    <RowNote>
                      {row.until === null
                        ? // C16: local msgid
                          t`Counts as a used seat for 14 days after release.`
                        : coolingUntilLine(row.until)}
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

/** Seated rows, deduplicated, owner first, otherwise in server order. */
export function seatRows(
  seats: readonly SeatRowInput[] | unknown,
  ownerId: string,
): SeatRowView[] {
  if (!Array.isArray(seats)) return [];
  const seen = new Set<string>();
  const out: SeatRowView[] = [];
  for (const s of seats as SeatRowInput[]) {
    const id = s?.user_id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({
      userId: id,
      owner: id === ownerId,
      withoutAccess: id !== ownerId && s.seated_without_access === true,
    });
  }
  return [...out.filter((r) => r.owner), ...out.filter((r) => !r.owner)];
}

/** Seats in use: the server's count, else the rows (never a cap). */
export function seatsUsedOf(r: {
  seats_used?: unknown;
  seats?: unknown;
}): number {
  return (
    seatCount(r.seats_used) ?? (Array.isArray(r.seats) ? r.seats.length : 0)
  );
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

/** Released seats still counted (design 7.2 `cooling`). */
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

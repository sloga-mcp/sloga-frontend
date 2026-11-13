import { For, Show, createMemo, createSignal, onMount } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";
import { ProtectedChannelUnavailable } from "stoat.js";

import { styled } from "styled-system/jsx";

import {
  listSeatIds,
  serverRemovedSeatIds,
} from "@revolt/app/interface/settings/channel/protected/SeatList";
import { useClient } from "@revolt/client";
import type { E2EEBridge, OwnDeviceView } from "@revolt/client/e2ee";
import { errorUiCopy, noticeCopy } from "@revolt/client/protectedCopy";
import {
  type ProtectedErrorUi,
  protectedNoticeForError,
} from "@revolt/client/protectedShield";
import {
  protectedUiOf,
  useProtectedShield,
} from "@revolt/client/useProtectedChannel";
import { useTime } from "@revolt/i18n/dayjs";
import { Button } from "@revolt/ui/components/design/Button";
import { type DialogProps, Dialog } from "@revolt/ui/components/design/Dialog";
import { CircularProgress } from "@revolt/ui/components/design/LoadingProgress";
import { Column } from "@revolt/ui/components/layout/Column";

/**
 * Props of the `protected_device_cap` modal (S2-D38). Exported for the
 * modal union in `types.ts`.
 */
export interface ProtectedDeviceCapProps {
  type: "protected_device_cap";
  /** The protected channel this device can't open (capacity `device_cap`). */
  channel: Channel;
}

/**
 * Protected channel device-cap screen (S2-D38, design 9.2): this device
 * can't open the channel because the account already has the channel's
 * maximum number of devices in it.
 *
 * Lists the account's own devices from the own E2EE device listing
 * (`listOwnDevices`, `GET /e2ee/devices/{self}`: unsigned display data,
 * nothing here decides trust). Rows show the session name, never an id. "Sign out that device"
 * deletes that device's session through stoat.js (`Session.delete`, the
 * Sessions settings page call); the server then removes its leaf. This
 * device and the device that signs the channel's member list are never
 * offered (OR-15: native refuses the signer anyway). "Try again" asks the
 * bridge to open the channel again (`protectedOpen`). The server owner also
 * gets "Raise the device limit": the same signed seats re-signed with the
 * entitlement's device cap; disabled while that cap is unknown (`null`),
 * and on any device but the one that signs the list (a line says so).
 */
export function ProtectedDeviceCapModal(
  props: DialogProps & ProtectedDeviceCapProps,
) {
  const { t } = useLingui();
  const client = useClient();
  const dayjs = useTime();
  const shield = useProtectedShield(() => props.channel.id);

  const bridge = () => client()?.e2ee as E2EEBridge | undefined;
  const ui = () => protectedUiOf(bridge());
  const snapshot = () => ui()?.seatsSnapshot(props.channel.id) ?? null;
  const selfId = () => client()?.user?.id ?? null;
  const currentSessionId = () => client()?.sessionId ?? null;

  const ownerId = () => props.channel.server?.ownerId ?? null;
  const viewerIsOwner = () => {
    const owner = ownerId();
    return owner !== null && selfId() === owner;
  };

  const [views, setViews] = createSignal<OwnDeviceView[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  /** The device whose sign-out waits for its confirm (comparison only). */
  const [confirmId, setConfirmId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  /**
   * The own listing (the bridge's read, with its 429 policy) and this
   * account's sessions (for `Session.delete`).
   */
  async function load() {
    const e2ee = bridge();
    if (!e2ee) {
      setLoadFailed(true);
      setLoaded(true);
      return;
    }
    setLoadFailed(false);
    try {
      const own = await e2ee.listOwnDevices();
      await client().sessions.fetch();
      setViews(own);
    } catch {
      console.error("[protected] own device listing failed");
      setLoadFailed(true);
    } finally {
      setLoaded(true);
    }
  }

  onMount(() => void load());

  /** This account's seat-list signing device, when it signs this list. */
  const signerDeviceId = () => {
    const list = snapshot()?.list;
    const me = selfId();
    return list && me !== null && list.signer_user_id === me
      ? list.signer_device_id
      : null;
  };

  /** This device signs the list: the only place a raise is signed (LOW-4). */
  const onSigningDevice = () =>
    deviceCapOnSigningDevice(signerDeviceId(), ui()?.selfDeviceId() ?? null);

  const rows = createMemo(() =>
    deviceCapRows(views(), {
      deviceId: ui()?.selfDeviceId() ?? null,
      sessionId: currentSessionId(),
      signerDeviceId: signerDeviceId(),
    }),
  );

  const removable = (row: DeviceCapRow) =>
    deviceCapRemovable(row, rows(), currentSessionId(), (id) =>
      client().sessions.has(id),
    );

  /** "Last seen …" for a row, or null when the time isn't known. */
  const lastSeen = (at: string | null): string | null => {
    if (at === null || Number.isNaN(Date.parse(at))) return null;
    const seenAgo = dayjs(at).fromNow();
    return t`Last seen ${seenAgo}`;
  };

  async function signOut(row: DeviceCapRow) {
    if (busy() || !removable(row)) return;
    const session =
      row.sessionId === null ? undefined : client().sessions.get(row.sessionId);
    if (!session || session.current) return;
    setBusy(true);
    setError(null);
    try {
      await session.delete();
      setConfirmId(null);
      await load();
    } catch {
      console.error("[protected] device sign-out failed");
      setError(t`Couldn't sign out that device. Try again.`);
    } finally {
      setBusy(false);
    }
  }

  /** The owner's "Raise the device limit" signing plan; null = disabled. */
  const raisePlan = createMemo(() => {
    const api = ui();
    const snap = snapshot();
    const owner = ownerId();
    if (!viewerIsOwner() || api === null || snap === null || owner === null) {
      return null;
    }
    if (!api.protectedTextCapable()) return null;
    if (!onSigningDevice()) return null;
    return deviceCapRaise({
      entitlement: snap.entitlement_device_cap,
      enforced: snap.device_cap,
      listed: listSeatIds(snap.list?.body),
      removed: serverRemovedSeatIds(snap, owner),
      ownerId: owner,
      pending: api.pendingSeats(props.channel.id) !== null,
    });
  });

  /** Plan D17 answer for a rejected owner change. */
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

  async function raise() {
    const plan = raisePlan();
    const api = ui();
    if (busy() || plan === null || api === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.setSeats(props.channel.id, plan.seats, plan.deviceCap);
    } catch (err) {
      const answer = errorUiOf(err);
      // ids only (D16); `none` is native `Declined`: stay open, silently
      if (answer.kind !== "none") {
        console.error("[protected] device limit raise failed", {
          tag: answer.tag,
        });
      }
      setError(
        errorUiCopy(answer, { removedUserNames: displayNames, failure: err }),
      );
      return;
    } finally {
      setBusy(false);
    }
    tryAgain();
  }

  /** "Try again": the bridge opens the channel again (D8 refresh + join). */
  function tryAgain() {
    // Open this modal only from an open channel: re-opening it is then a no-op.
    ui()?.protectedOpen(props.channel.id);
    props.onClose();
  }

  /** Closing waits for a sign-out or a raise to settle. */
  function close() {
    if (!busy()) props.onClose();
  }

  return (
    <Dialog
      minWidth={420}
      show={props.show}
      onClose={close}
      title={noticeCopy("capacity_device_cap", null, null, props.channel.name)}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Try again</Trans>,
          onClick: () => {
            tryAgain();
            return false;
          },
          isDisabled: busy(),
        },
      ]}
      isDisabled={busy()}
    >
      <Column>
        <Description>
          {t`Sign out one of your other devices to make room for this one, then try again.`}
        </Description>

        <Show when={loadFailed()}>
          <Notice role="alert">{noticeCopy("network_error")}</Notice>
        </Show>

        <Rows>
          <Show when={!loaded()}>
            <Empty>
              <CircularProgress size={32} />
            </Empty>
          </Show>
          <For each={rows()}>
            {(row) => {
              const name = () => deviceCapLabel(row) ?? t`Unnamed device`;
              const seen = () => lastSeen(row.lastSeenAt);
              const confirming = () => confirmId() === row.deviceId;
              return (
                <DeviceRow>
                  <DeviceLine>
                    <DeviceText>
                      <DeviceName>{name()}</DeviceName>
                      <Show when={row.thisDevice}>
                        <DeviceNote>
                          <Trans>This device</Trans>
                        </DeviceNote>
                      </Show>
                      <Show when={row.signing}>
                        <DeviceNote>
                          {t`Signs this channel's member list`}
                        </DeviceNote>
                      </Show>
                      <Show when={seen()}>
                        {(line) => <DeviceNote>{line()}</DeviceNote>}
                      </Show>
                    </DeviceText>
                    <Show when={removable(row) && !confirming()}>
                      <Button
                        size="sm"
                        variant="tonal"
                        isDisabled={busy()}
                        onPress={() => setConfirmId(row.deviceId)}
                      >
                        {t`Sign out that device`}
                      </Button>
                    </Show>
                  </DeviceLine>
                  <Show when={removable(row) && confirming()}>
                    <Confirm role="group">
                      <DeviceNote>
                        {t`That device will be signed out and will have to sign in again.`}
                      </DeviceNote>
                      <ConfirmActions>
                        <Button
                          size="sm"
                          variant="text"
                          isDisabled={busy()}
                          onPress={() => setConfirmId(null)}
                        >
                          <Trans>Cancel</Trans>
                        </Button>
                        <Button
                          size="sm"
                          variant="_error"
                          isDisabled={busy()}
                          onPress={() => void signOut(row)}
                        >
                          <Trans>Sign out</Trans>
                        </Button>
                      </ConfirmActions>
                    </Confirm>
                  </Show>
                </DeviceRow>
              );
            }}
          </For>
        </Rows>

        <Show when={viewerIsOwner()}>
          <OwnerLine>
            <Button
              size="sm"
              variant="tonal"
              isDisabled={busy() || raisePlan() === null}
              onPress={() => void raise()}
            >
              {t`Raise the device limit`}
            </Button>
            <Show when={busy()}>
              <CircularProgress size={20} />
            </Show>
          </OwnerLine>
          <Show when={!onSigningDevice()}>
            <Description>
              {t`Raise the limit from the device that signs this channel's member list.`}
            </Description>
          </Show>
        </Show>

        <Show when={error()}>
          <Notice role="alert">{error()}</Notice>
        </Show>
      </Column>
    </Dialog>
  );
}

// protected-pure:begin
// Device-cap rules, loaded by `protectedDeviceCap.scan.test.ts`: no imports.

/**
 * One own device as the device-cap screen shows it. `deviceId` and
 * `sessionId` are for comparisons and the sign-out call only: never
 * rendered (the label is the session name or fixed copy).
 */
interface DeviceCapRow {
  deviceId: string;
  /** The session the device is bound to; null when bound to none. */
  sessionId: string | null;
  sessionName: string | null;
  lastSeenAt: string | null;
  thisDevice: boolean;
  /** The device that signs this channel's member list. */
  signing: boolean;
}

/** A non-empty string field of a device view, else null. */
function deviceCapField(view: unknown, key: string): string | null {
  if (typeof view !== "object" || view === null) return null;
  const v = (view as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A cap as a count: a non-negative safe integer, else null (unknown). */
function deviceCapCount(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * The bridge's own-device views (`listOwnDevices`: `deviceId`,
 * `isThisDevice`, `sessionId`, `sessionName`, `lastSeenAt`) as rows: this
 * device first, then the signing device, then the rest in the bridge's
 * order. Views without a `deviceId` are dropped, and so is a repeated id. A
 * view bound to this session counts as this device even when its device id
 * differs; a session name without a session is ignored.
 */
function deviceCapRows(
  views: unknown,
  self: {
    deviceId: string | null;
    sessionId: string | null;
    signerDeviceId: string | null;
  },
): DeviceCapRow[] {
  if (!Array.isArray(views)) return [];
  const seen = new Set<string>();
  const rows: DeviceCapRow[] = [];
  for (const view of views) {
    const deviceId = deviceCapField(view, "deviceId");
    if (deviceId === null || seen.has(deviceId)) continue;
    seen.add(deviceId);
    const sessionId = deviceCapField(view, "sessionId");
    rows.push({
      deviceId,
      sessionId,
      sessionName:
        sessionId === null ? null : deviceCapField(view, "sessionName"),
      lastSeenAt: deviceCapField(view, "lastSeenAt"),
      thisDevice:
        (view as { isThisDevice?: unknown }).isThisDevice === true ||
        deviceId === self.deviceId ||
        (sessionId !== null && sessionId === self.sessionId),
      signing: deviceId === self.signerDeviceId,
    });
  }
  const rank = (r: DeviceCapRow) => (r.thisDevice ? 0 : r.signing ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b));
}

/**
 * Whether "Sign out that device" is offered for `row`: a device bound to a
 * live session of this account (`live`), never this device, never the
 * signing device, never the current session, and never a session this
 * device or the signing device is also bound to (deleting it would sign
 * them out too). Without a known current session nothing is offered.
 */
function deviceCapRemovable(
  row: DeviceCapRow,
  rows: readonly DeviceCapRow[],
  currentSessionId: string | null,
  live: (sessionId: string) => boolean,
): boolean {
  if (currentSessionId === null || row.thisDevice || row.signing) return false;
  if (row.sessionId === null || row.sessionId === currentSessionId) {
    return false;
  }
  for (const other of rows) {
    if (other === row || !(other.thisDevice || other.signing)) continue;
    if (other.sessionId === row.sessionId) return false;
  }
  return live(row.sessionId);
}

/**
 * Whether this device signs the channel's member list (audit LOW-4): the
 * signer is known (this account's list signer) and is this device. Two
 * unknowns (null) never match.
 */
function deviceCapOnSigningDevice(
  signerDeviceId: string | null,
  selfDeviceId: string | null,
): boolean {
  return signerDeviceId !== null && signerDeviceId === selfDeviceId;
}

/** The row's label: its session name, or null (the caller's fixed copy). */
function deviceCapLabel(row: DeviceCapRow): string | null {
  const name = row.sessionName === null ? "" : row.sessionName.trim();
  return name.length > 0 ? name : null;
}

/**
 * The owner's "Raise the device limit": the signed list's seats unchanged
 * (owner first) re-signed with the entitlement's device cap, or null when
 * the button is disabled.
 *
 * `entitlement` (`entitlement_device_cap`) null or invalid means no
 * entitlement: unknown, NEVER read as 0, so disabled. 0 is unlimited and
 * signs 0 (design 4.1: allowed only when the entitlement is 0). `enforced`
 * (`device_cap`, the cap the server enforces now) must be known and below
 * the target; already unlimited (0) has nothing to raise. Never a change
 * of seats: disabled without a readable signed list, while it names users
 * the server removed (that change belongs to the seat page, W4d N3) and
 * while a stored seat publish is pending (it would win, F3).
 */
function deviceCapRaise(i: {
  entitlement: unknown;
  enforced: unknown;
  listed: readonly string[] | null;
  removed: readonly string[];
  ownerId: string | null;
  pending: boolean;
}): { seats: string[]; deviceCap: number } | null {
  const ceiling = deviceCapCount(i.entitlement);
  if (ceiling === null) return null;
  const now = deviceCapCount(i.enforced);
  if (now === null || now === 0) return null;
  if (ceiling !== 0 && ceiling <= now) return null;
  if (i.ownerId === null || i.pending) return null;
  if (i.listed === null || i.removed.length > 0) return null;
  const seats = [i.ownerId];
  for (const id of i.listed) if (!seats.includes(id)) seats.push(id);
  return { seats, deviceCap: ceiling };
}
// protected-pure:end

const Description = styled("p", {
  base: {
    margin: 0,
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
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

const Rows = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    maxHeight: "320px",
    overflowY: "auto",
  },
});

const DeviceRow = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "8px 10px",
    borderRadius: "8px",
    color: "var(--md-sys-color-on-surface)",
  },
});

const DeviceLine = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});

const DeviceText = styled("span", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
});

const DeviceName = styled("span", {
  base: {
    fontSize: "0.9rem",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const DeviceNote = styled("span", {
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
  },
});

const ConfirmActions = styled("div", {
  base: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "var(--gap-sm)",
  },
});

const OwnerLine = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
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

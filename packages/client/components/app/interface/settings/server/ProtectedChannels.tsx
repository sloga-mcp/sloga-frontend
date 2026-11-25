import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import type { Server } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import type { E2EEBridge, OwnDeviceView } from "@revolt/client/e2ee";
import {
  errorUiCopy,
  noticeCopy,
  ownerKeyCopy,
  panelCopy,
  settingsCopy,
} from "@revolt/client/protectedCopy";
import { protectedNoticeForError } from "@revolt/client/protectedShield";
import { ownerKeyMoveTargets } from "@revolt/client/protectedTextOwner";
import type {
  ProtectedChannelView,
  ProtectedSeatsResponse,
} from "@revolt/client/protectedTextTypes";
import {
  protectedUiOf,
  structuralShellOf,
  tauriE2eeOffOf,
} from "@revolt/client/useProtectedChannel";
import { Button } from "@revolt/ui/components/design/Button";

/**
 * Server settings "Protected channels" page (S2-D42 [a], W4-3 lane U11).
 *
 * The server owner only (the same `server.ownerId === self` rule as
 * "Delete Server"), re-checked here so a stale page id never shows it to
 * anyone else. One row per channel this client holds protected: its name,
 * its seat usage from the bridge's last seats read (`seatsSnapshot`; no
 * request of its own), and "Recover ownership on this device" under the
 * pill's rule (design 6.3 "Owner signing device lost"). Native dialogs run
 * only from a button's click.
 *
 * S2-D42 "Move ownership key" (lane U11b; the 6.3 K0 -> K1 handover): the
 * handover is signed by the CURRENT signing device, so (planner ruling) the
 * action lives there as "Move ownership key to another device", with a
 * picker of this user's other devices by session name. It calls
 * `ui.moveOwnerKey` only (F5; the native dialog decides). On another own
 * device, or under a served authority, the row says why it can't move the
 * key here instead. The own device listing (`listOwnDevices`) is read once,
 * only while a served list names this user as its signer; it signs
 * nothing.
 */
export function ProtectedChannels(props: { server: Server }) {
  const { t } = useLingui();
  const client = useClient();

  const owner = () =>
    protectedChannelsOwner(props.server.ownerId, client()?.user?.id);
  const bridge = () => client()?.e2ee as E2EEBridge | undefined;
  const ui = () => protectedUiOf(bridge());
  const capable = () => ui()?.protectedTextCapable() === true;
  const tauriE2eeOff = () =>
    tauriE2eeOffOf({
      tauri: structuralShellOf(ui()),
      bridgePresent: !!bridge(),
      capable: capable(),
      status: bridge()?.status.get("state"),
    });
  const self = () => ({
    userId: client()?.user?.id,
    deviceId: bridge()?.status.get("state")?.device_id,
  });

  /** The server's channels this client holds protected, in server order. */
  const channels = () => {
    const c = client();
    if (!c) return [];
    return props.server.channels.filter((ch) => c.isProtectedChannel(ch.id));
  };

  const view = (channelId: string): ProtectedChannelView | null =>
    ui()?.protectedChannels.get(channelId) ?? null;
  const snapshot = (channelId: string): ProtectedSeatsResponse | null => {
    const api = ui();
    if (!api || typeof api.seatsSnapshot !== "function") return null;
    try {
      return api.seatsSnapshot(channelId);
    } catch {
      return null;
    }
  };

  const recoverOffered = (channelId: string) =>
    protectedChannelsRecoverOffered(view(channelId), self(), capable());

  /** This device's id from the bridge (comparisons only, never rendered). */
  const selfDeviceId = (): string | null => {
    const api = ui();
    if (!api || typeof api.selfDeviceId !== "function") return null;
    try {
      return api.selfDeviceId();
    } catch {
      return null;
    }
  };

  /**
   * S2-D42: this account's own device listing, for the move picker's
   * session names and the "on another device" line. Read only while a
   * served list names this user as its signer; a failed read offers
   * nothing (the ids are for comparisons only).
   */
  const ownListingWanted = createMemo(
    () =>
      capable() &&
      channels().some((ch) =>
        protectedChannelsSignedByUser(snapshot(ch.id), self().userId),
      ),
  );
  const [ownDevices, setOwnDevices] = createSignal<OwnDeviceView[] | null>(
    null,
  );
  createEffect(
    on(ownListingWanted, (wanted) => {
      if (!wanted) return;
      const e2ee = bridge();
      if (!e2ee || typeof e2ee.listOwnDevices !== "function") return;
      let live = true;
      onCleanup(() => {
        live = false;
      });
      e2ee.listOwnDevices().then(
        (devices) => {
          if (live) setOwnDevices(devices);
        },
        () => {
          console.warn("[protected] own device listing failed");
        },
      );
    }),
  );

  /** What the row offers for the channel's ownership key (pure rule). */
  const ownerKey = (channelId: string): ProtectedChannelsOwnerKey => {
    const own = ownDevices();
    return protectedChannelsOwnerKey({
      snapshot: snapshot(channelId),
      selfUserId: self().userId,
      selfDeviceId: selfDeviceId(),
      ownDevices: own,
      targets: ownerKeyMoveTargets(
        snapshot(channelId),
        selfDeviceId(),
        (own ?? []).map((d) => d.deviceId),
      ),
      capable: capable(),
      recoverOffered: recoverOffered(channelId),
    });
  };

  /** The picker's devices (session names), or null when not offered. */
  const moveTargets = (
    channelId: string,
  ): ProtectedChannelsMoveTarget[] | null => {
    const key = ownerKey(channelId);
    return key.kind === "move" ? key.targets : null;
  };

  /** Why this device can't move the key, where the row says so. */
  const ownerKeyLine = (channelId: string): string | null => {
    const kind = ownerKey(channelId).kind;
    switch (kind) {
      case "move":
      case "none":
        return null;
      case "on_other_device":
        return ownerKeyCopy.onOtherDevice();
      case "authority_held":
        return ownerKeyCopy.authorityHeld();
      default: {
        const _exhaustive: never = kind;
        return null;
      }
    }
  };

  const seatLine = (channelId: string): string | null => {
    const line = protectedChannelSeatLine(snapshot(channelId));
    const kind = line.kind;
    switch (kind) {
      case "of":
        return settingsCopy.seatsUsed(line.used, line.cap);
      case "unknown_cap": {
        const count = line.used;
        return t`Seats used: ${count}. The seat limit isn't known yet.`;
      }
      case "not_loaded":
        // Only where this device can open the channel at all.
        return capable() ? t`Open this channel to see its seats.` : null;
      default: {
        const _exhaustive: never = kind;
        return null;
      }
    }
  };

  const [busy, setBusy] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<{
    channelId: string;
    text: string;
  } | null>(null);
  const failureFor = (channelId: string) => {
    const f = failure();
    return f && f.channelId === channelId ? f.text : null;
  };

  /**
   * "Recover ownership on this device": from its button click only, and
   * only while the rule still offers it. Errors go through A2 + C0 (never
   * `error.message`); a cancelled native dialog maps to no copy.
   */
  async function recover(channelId: string) {
    if (busy() !== null || !owner() || !recoverOffered(channelId)) return;
    const api = ui();
    setFailure(null);
    if (!api || typeof api.recoverOwnership !== "function") {
      setFailure({ channelId, text: noticeCopy("not_available") });
      return;
    }
    setBusy(channelId);
    try {
      await api.recoverOwnership(channelId);
    } catch (err) {
      const answer = protectedNoticeForError(err, { op: "owner" });
      const text = errorUiCopy(answer, { failure: err });
      if (text) {
        console.error("[protected] recover ownership failed", {
          channelId,
          type: answer.tag,
        });
        setFailure({ channelId, text });
      }
    } finally {
      setBusy(null);
    }
  }

  /** The channel whose move picker is open (one at a time). */
  const [picking, setPicking] = createSignal<string | null>(null);

  function openPicker(channelId: string) {
    if (busy() !== null || moveTargets(channelId) === null) return;
    setFailure(null);
    setPicking(channelId);
  }

  /**
   * "Move ownership key to another device": from a picker row's click
   * only, and only while that device is still offered. `ui.moveOwnerKey`
   * signs behind its native dialog; errors as `recover`.
   */
  async function move(channelId: string, deviceId: string) {
    if (busy() !== null || !owner() || picking() !== channelId) return;
    const offered = moveTargets(channelId);
    if (!offered || !offered.some((d) => d.deviceId === deviceId)) return;
    const api = ui();
    setFailure(null);
    if (!api || typeof api.moveOwnerKey !== "function") {
      setFailure({ channelId, text: noticeCopy("not_available") });
      return;
    }
    setBusy(channelId);
    try {
      await api.moveOwnerKey(channelId, deviceId);
      setPicking(null);
    } catch (err) {
      const answer = protectedNoticeForError(err, { op: "owner" });
      const text = errorUiCopy(answer, { failure: err });
      if (text) {
        console.error("[protected] move ownership key failed", {
          channelId,
          type: answer.tag,
        });
        setFailure({ channelId, text });
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <Show when={owner()}>
      <Page>
        <Show when={!capable()}>
          <Info>
            {noticeCopy(tauriE2eeOff() ? "enable_e2ee" : "not_available")}
          </Info>
        </Show>
        <For each={channels()}>
          {(channel) => (
            <Row>
              <Name>{channel.name}</Name>
              <Show when={seatLine(channel.id)}>
                {(line) => <Line>{line()}</Line>}
              </Show>
              <Show when={recoverOffered(channel.id)}>
                <Line>{noticeCopy("owner_device_lost")}</Line>
                <div>
                  <Button
                    variant="filled"
                    isDisabled={busy() !== null}
                    onPress={() => void recover(channel.id)}
                  >
                    {panelCopy.recoverOwnership()}
                  </Button>
                </div>
              </Show>
              <Show when={moveTargets(channel.id)}>
                {(targets) => (
                  <Show
                    when={picking() === channel.id}
                    fallback={
                      <div>
                        <Button
                          variant="tonal"
                          isDisabled={busy() !== null}
                          onPress={() => openPicker(channel.id)}
                        >
                          {ownerKeyCopy.moveKey()}
                        </Button>
                      </div>
                    }
                  >
                    <Line>{ownerKeyCopy.choose()}</Line>
                    <Targets role="list">
                      <For each={targets()}>
                        {(target) => (
                          <div role="listitem">
                            <Button
                              variant="filled"
                              isDisabled={busy() !== null}
                              onPress={() =>
                                void move(channel.id, target.deviceId)
                              }
                            >
                              {target.name ?? ownerKeyCopy.unnamedDevice()}
                            </Button>
                          </div>
                        )}
                      </For>
                    </Targets>
                    <div>
                      <Button
                        variant="text"
                        isDisabled={busy() !== null}
                        onPress={() => setPicking(null)}
                      >
                        {ownerKeyCopy.cancel()}
                      </Button>
                    </div>
                  </Show>
                )}
              </Show>
              <Show when={ownerKeyLine(channel.id)}>
                {(line) => <Line>{line()}</Line>}
              </Show>
              <Show when={failureFor(channel.id)}>
                {(text) => <Failure role="alert">{text()}</Failure>}
              </Show>
            </Row>
          )}
        </For>
      </Page>
    </Show>
  );
}

// protected-pure:begin (loaded by protectedChannels.scan.test.ts; no imports)

/**
 * S2-D42: the page and its settings entry are the server owner's only
 * (`server.ownerId === self`, the "Delete Server" rule). An unknown owner
 * or self is never the owner.
 * @param ownerId The server's owner id
 * @param selfId This session's user id
 */
export function protectedChannelsOwner(
  ownerId: unknown,
  selfId: unknown,
): boolean {
  return (
    typeof ownerId === "string" &&
    ownerId.length > 0 &&
    typeof selfId === "string" &&
    ownerId === selfId
  );
}

/**
 * The settings entry: the owner, and only on a server with at least one
 * channel this client holds protected.
 */
export function protectedChannelsEntryShown(i: {
  ownerId: unknown;
  selfId: unknown;
  protectedCount: number;
}): boolean {
  return protectedChannelsOwner(i.ownerId, i.selfId) && i.protectedCount > 0;
}

/** A row's seat usage, from the bridge's last seats read. */
export type ProtectedChannelSeatLine =
  | { kind: "of"; used: number; cap: number }
  | { kind: "unknown_cap"; used: number }
  | { kind: "not_loaded" };

/**
 * Seats used of the slot cap (the pill's `pillSeats` rule, mirrored): a
 * missing or malformed `seats_used` is "not loaded"; a null or invalid cap
 * stays unknown, never 0 or unlimited.
 * @param snapshot `ui.seatsSnapshot(channelId)`
 */
export function protectedChannelSeatLine(
  snapshot: ProtectedSeatsResponse | null | undefined,
): ProtectedChannelSeatLine {
  if (!snapshot) return { kind: "not_loaded" };
  const used = snapshot.seats_used;
  if (typeof used !== "number" || !Number.isInteger(used) || used < 0) {
    return { kind: "not_loaded" };
  }
  const cap = snapshot.slot_cap;
  return typeof cap === "number" && Number.isInteger(cap) && cap >= 1
    ? { kind: "of", used, cap }
    : { kind: "unknown_cap", used };
}

/**
 * "Recover ownership on this device": the pill's `pillRecoverOffered`
 * rule, MIRRORED (the spec checks they agree): the owner's signing device
 * was signed out (`signer_lost`, cause `device_revoked`), this user IS that
 * owner, and this is ANOTHER device (never the lost one). And only where
 * this device runs the text plane (the pill's `full()`). Native's dialog
 * decides.
 * @param view The manager's channel view
 * @param self This session's user and E2EE device
 * @param capable `ui.protectedTextCapable()`
 */
export function protectedChannelsRecoverOffered(
  view: ProtectedChannelView | null | undefined,
  self: {
    userId: string | null | undefined;
    deviceId: string | null | undefined;
  },
  capable: boolean,
): boolean {
  if (capable !== true) return false;
  const lost: unknown = view?.serverGroup?.signer_lost ?? null;
  if (typeof lost !== "object" || lost === null) return false;
  const l = lost as { user_id?: unknown; device_id?: unknown; cause?: unknown };
  return (
    l.cause === "device_revoked" &&
    typeof self.userId === "string" &&
    self.userId.length > 0 &&
    typeof self.deviceId === "string" &&
    self.deviceId.length > 0 &&
    typeof l.user_id === "string" &&
    typeof l.device_id === "string" &&
    l.device_id.length > 0 &&
    l.user_id === self.userId &&
    l.device_id !== self.deviceId
  );
}

/**
 * The served list names `userId` as its signer (unverified server data:
 * it only decides whether to read the own device listing).
 * @param snapshot `ui.seatsSnapshot(channelId)`
 * @param userId This session's user id
 */
export function protectedChannelsSignedByUser(
  snapshot: { list?: { signer_user_id?: unknown } | null } | null | undefined,
  userId: string | null | undefined,
): boolean {
  const list = snapshot?.list ?? null;
  return (
    typeof list === "object" &&
    list !== null &&
    typeof userId === "string" &&
    userId.length > 0 &&
    list.signer_user_id === userId
  );
}

/** A move target: its id (comparisons only) and its session name. */
export type ProtectedChannelsMoveTarget = {
  deviceId: string;
  name: string | null;
};

/** What a row offers for the channel's ownership key (S2-D42). */
export type ProtectedChannelsOwnerKey =
  | { kind: "move"; targets: ProtectedChannelsMoveTarget[] }
  | { kind: "on_other_device" }
  | { kind: "authority_held" }
  | { kind: "none" };

/**
 * S2-D42 "Move ownership key to another device" (planner ruling: on the
 * signing device only, which signs the handover).
 * - `move`: F5's `ownerKeyMoveTargets` (passed in as `targets`) is
 *   non-empty; each target carries its session name from the own listing
 *   (blank = null, the page says "Unnamed device"), never an id to show.
 * - `authority_held`: this user signs the served list and it carries an
 *   authority (F5 refuses a handover there).
 * - `on_other_device`: this user signs the served list from ANOTHER of
 *   their devices, one still in the own listing.
 * - `none`: anything else, including no listing yet, not capable, another
 *   user's list, and while "Recover ownership" is offered (the signer was
 *   signed out; that action, not this line, applies).
 */
export function protectedChannelsOwnerKey(i: {
  snapshot:
    | {
        list?: {
          signer_user_id?: unknown;
          signer_device_id?: unknown;
          authority?: unknown;
        } | null;
      }
    | null
    | undefined;
  selfUserId: string | null | undefined;
  selfDeviceId: string | null | undefined;
  ownDevices:
    | readonly { deviceId: string; sessionName: string | null }[]
    | null;
  targets: readonly string[];
  capable: boolean;
  recoverOffered: boolean;
}): ProtectedChannelsOwnerKey {
  const none: ProtectedChannelsOwnerKey = { kind: "none" };
  if (i.capable !== true || i.recoverOffered !== false) return none;
  const list = i.snapshot?.list;
  if (!list || !protectedChannelsSignedByUser(i.snapshot, i.selfUserId)) {
    return none;
  }
  if (list.authority !== undefined && list.authority !== null) {
    return { kind: "authority_held" };
  }
  const own = i.ownDevices;
  const me = i.selfDeviceId;
  if (own === null || typeof me !== "string" || me.length === 0) return none;
  const targets: ProtectedChannelsMoveTarget[] = [];
  for (const id of i.targets) {
    const row = own.find((d) => d.deviceId === id);
    if (row === undefined || id === me) continue;
    const name =
      typeof row.sessionName === "string" ? row.sessionName.trim() : "";
    targets.push({ deviceId: id, name: name.length > 0 ? name : null });
  }
  if (targets.length > 0 && list.signer_device_id === me) {
    return { kind: "move", targets };
  }
  const signer = list.signer_device_id;
  return typeof signer === "string" &&
    signer.length > 0 &&
    signer !== me &&
    own.some((d) => d.deviceId === signer)
    ? { kind: "on_other_device" }
    : none;
}

// protected-pure:end

const Page = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-lg)",
  },
});

const Row = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Name = styled("div", {
  base: {
    fontWeight: 600,
    overflowWrap: "anywhere",
  },
});

const Line = styled("div", {
  base: {
    fontSize: "0.9rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Targets = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const Info = styled("div", {
  base: {
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Failure = styled("div", {
  base: {
    fontSize: "0.85rem",
    color: "var(--md-sys-color-error)",
  },
});

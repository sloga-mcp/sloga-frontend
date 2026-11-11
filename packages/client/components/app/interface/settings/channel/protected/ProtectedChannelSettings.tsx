import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel, Client } from "stoat.js";
import { ProtectedChannelUnavailable } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import type { E2EEBridge } from "@revolt/client/e2ee";
import {
  errorUiCopy,
  noticeCopy,
  settingsCopy,
} from "@revolt/client/protectedCopy";
import {
  type ProtectedErrorUi,
  protectedNoticeForError,
} from "@revolt/client/protectedShield";
import type { ProtectedSeatsResponse } from "@revolt/client/protectedTextTypes";
import {
  protectedUiOf,
  structuralShellOf,
  tauriE2eeOffOf,
} from "@revolt/client/useProtectedChannel";
import { useModals } from "@revolt/modal";
import { Button } from "@revolt/ui/components/design/Button";
import { CircularProgress } from "@revolt/ui/components/design/LoadingProgress";

import {
  SeatList,
  editableSeatIds,
  ownerFirst,
  seatCount,
  seatsAfterRemoval,
  serverRemovedSeatIds,
} from "./SeatList";

/**
 * Whether this client may see the "Protected channel" settings entry and
 * page for `channel` (product choice 4: the server owner only).
 */
export function protectedSettingsVisibleFor(
  channel: Channel,
  client: Client | undefined,
): boolean {
  return protectedSettingsEligible({
    type: channel.type,
    serverId: channel.serverId,
    voice: channel.isVoice,
    announcement: channel.isAnnouncement === true,
    protectedOrPinned: client?.isProtectedChannel(channel.id) === true,
    ownerId: channel.server?.ownerId,
    selfId: client?.user?.id,
  });
}

/** `{ source: "client", reason }` from the bridge's owner flows. */
function isClientReason(err: unknown, reason: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { source?: unknown }).source === "client" &&
    (err as { reason?: unknown }).reason === reason
  );
}

type RawSeats =
  | { key: string; state: "loading" | "failed" }
  | { key: string; state: "ok"; body: ProtectedSeatsResponse };

/**
 * Protected channel settings page (W4 lane C11; plan D7, D13, D17, product
 * choices 3 and 4; design 6.3 "Protect" / "Seat a member" / "Owner unseat",
 * 7.2, 6.4).
 *
 * Not protected: "Protect this channel" when the flag is on, this device
 * runs the text plane, the channel has no messages and an entitlement
 * exists; otherwise the reason. Protecting is one-way and says so.
 * Protected: the seat list, "Add seats" (growth, flag-gated) and per-row
 * "Remove seat" (an unseat after the row's inline confirm, W4c#4; native
 * shows no dialog for removals).
 * While a seat publish is unresolved both are disabled. No handover UI.
 *
 * Seats come from the bridge's last `GET .../seats` (`seatsSnapshot`).
 * When it has none (the channel isn't protected yet, or the bridge has not
 * opened it) the page reads `GET /channels/:id/seats` itself, read-only.
 */
export function ProtectedChannelSettings(props: { channel: Channel }) {
  const { t } = useLingui();
  const client = useClient();
  const { openModal } = useModals();

  // Re-checked here: a stale page id must never show a non-owner the page.
  const eligible = () => protectedSettingsVisibleFor(props.channel, client());
  const ownerId = () => props.channel.server?.ownerId ?? null;
  const isProtected = () =>
    client()?.isProtectedChannel(props.channel.id) === true;

  const bridge = () => client()?.e2ee as E2EEBridge | undefined;
  const ui = () => protectedUiOf(bridge());
  const capable = () => ui()?.protectedTextCapable() === true;
  const flag = () =>
    ui()?.protectedFlag() ?? { enabled: false, defaultDeviceCap: null };
  const view = () => ui()?.protectedChannels.get(props.channel.id) ?? null;
  const snapshot = () => ui()?.seatsSnapshot(props.channel.id) ?? null;
  // A structural shell with E2EE off (S7 D9 notice split; the B6 hooks' rule).
  const tauriE2eeOff = () =>
    tauriE2eeOffOf({
      tauri: structuralShellOf(ui()),
      bridgePresent: !!bridge(),
      capable: capable(),
      status: bridge()?.status.get("state"),
    });
  const hasMessages = () =>
    channelHasMessages(props.channel.lastMessageId ?? null);
  const selfPrivileged = () => client()?.user?.privileged === true;

  // ---- seat reads -------------------------------------------------------

  const [raw, setRaw] = createSignal<RawSeats | null>(null);
  let readGeneration = 0;

  /** Which raw read the page needs now; null = none. */
  const rawKey = createMemo((): string | null => {
    if (!eligible()) return null;
    const id = props.channel.id;
    if (isProtected()) return snapshot() === null ? `protected:${id}` : null;
    return protectReadWanted({
      flagEnabled: flag().enabled,
      capable: capable(),
      selfPrivileged: selfPrivileged(),
      hasMessages: hasMessages(),
    })
      ? `unprotected:${id}`
      : null;
  });

  /** The ONE raw request this page makes: a read-only seats GET. */
  async function fetchSeatsBody(): Promise<ProtectedSeatsResponse | null> {
    const body: unknown = await client().api.get(
      `/channels/${props.channel.id as ""}/seats` as never,
    );
    return parseSeatsBody(body);
  }

  async function readSeats(key: string) {
    const generation = ++readGeneration;
    setRaw({ key, state: "loading" });
    try {
      const parsed = await fetchSeatsBody();
      if (generation !== readGeneration) return;
      setRaw(
        parsed === null
          ? { key, state: "failed" }
          : { key, state: "ok", body: parsed },
      );
    } catch {
      if (generation === readGeneration) setRaw({ key, state: "failed" });
    }
  }

  /**
   * W4d: a seats read taken after a `SeatListNamesRemovedUsers` refusal,
   * over the bridge snapshot it was read against (`seatsOver`). The bridge
   * doesn't refresh after a refused publish; this read only shows the seat
   * rows as they are now. It never signs or submits anything.
   */
  const [fresh, setFresh] = createSignal<{
    basis: ProtectedSeatsResponse;
    body: ProtectedSeatsResponse;
  } | null>(null);
  let freshGeneration = 0;

  async function refreshSeatsAfterRefusal() {
    const basis = snapshot();
    if (!isProtected() || basis === null) {
      rereadSeats();
      return;
    }
    const generation = ++freshGeneration;
    try {
      const parsed = await fetchSeatsBody();
      if (generation !== freshGeneration || snapshot() !== basis) return;
      if (parsed !== null) setFresh({ basis, body: parsed });
    } catch {
      // the snapshot and the refusal's own ids still apply
    }
  }

  createEffect(
    on(rawKey, (key) => {
      if (key !== null) void readSeats(key);
    }),
  );

  /** Re-read after a change when the page reads seats itself. */
  function rereadSeats() {
    const key = rawKey();
    if (key !== null) void readSeats(key);
  }

  const rawFor = (): RawSeats | null => {
    const r = raw();
    return r !== null && r.key === rawKey() ? r : null;
  };

  const seats = (): ProtectedSeatsResponse | null => {
    const snap = snapshot();
    if (isProtected() && snap !== null) return seatsOver(snap, fresh());
    const r = rawFor();
    return r?.state === "ok" ? r.body : null;
  };

  /**
   * W4d: ids of the last `SeatListNamesRemovedUsers` refusal, tied to the
   * channel and the signed list body it was refused against.
   */
  const [refused, setRefused] = createSignal<RemovedRefusal | null>(null);

  /** Removed by the server, still on the signed list (W4d, W2 C1). */
  const removedIds = createMemo((): string[] => {
    const s = seats();
    const owner = ownerId();
    if (s === null || owner === null) return [];
    const reported = refusedFor(refused(), props.channel.id, s.list?.body);
    return serverRemovedSeatIds(s, owner, reported);
  });

  /** The seats a change starts from: never a server-removed user. */
  const editableIds = (): string[] => {
    const s = seats();
    return s === null ? [] : editableSeatIds(s, removedIds());
  };

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

  // ---- actions ----------------------------------------------------------

  const [pending, setPending] = createSignal<"protect" | "seats" | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);

  /** D7: an unresolved publish refuses signing; so does our own call. */
  const busy = () => view()?.publishInFlight === true || pending() !== null;

  /** Plan D17 answer for a rejected owner flow. */
  function errorUiOf(err: unknown): ProtectedErrorUi {
    if (
      err instanceof ProtectedChannelUnavailable ||
      (err instanceof Error && err.name === "ProtectedChannelUnavailable")
    ) {
      return {
        kind: "notice",
        notice: tauriE2eeOff() ? "enable_e2ee" : "not_available",
        max: null,
        tag: "ProtectedChannelUnavailable",
      };
    }
    return protectedNoticeForError(err, { op: "owner" });
  }

  /** Text for a failure; null for a native `Declined` (silent). */
  function errorText(err: unknown): string | null {
    // The bridge's own refusal while a publish runs: say what it is.
    if (isClientReason(err, "publish_in_flight")) {
      return settingsCopy.publishInFlight();
    }
    const ui = errorUiOf(err);
    if (ui.kind !== "none") {
      // ids only (D16)
      console.error("[protected] owner action failed", {
        channelId: props.channel.id,
        tag: ui.tag,
      });
    }
    return errorUiCopy(ui, { removedUserNames: displayNames });
  }

  /**
   * W4d: after a `SeatListNamesRemovedUsers` refusal, leave exactly those
   * users off the next list (the picker's `current`, "Remove seat") and
   * re-read the seats. Nothing is resubmitted: the owner saves again.
   */
  function noteRemovedRefusal(err: unknown, listBody: unknown) {
    const users = removedUsersOfRefusal(errorUiOf(err));
    if (users === null || typeof listBody !== "string") return;
    setRefused({ channelId: props.channel.id, listBody, users });
    void refreshSeatsAfterRefusal();
  }

  const availability = createMemo(() => {
    const r = rawFor();
    return protectAvailability({
      flagEnabled: flag().enabled,
      capable: capable(),
      tauriE2eeOff: tauriE2eeOff(),
      selfPrivileged: selfPrivileged(),
      hasMessages: hasMessages(),
      seats: r === null ? null : r.state === "ok" ? r.body : r.state,
      defaultDeviceCap: flag().defaultDeviceCap,
    });
  });

  /** The picker's `onConfirm` for the genesis list; rejects on failure. */
  async function runProtect(userIds: string[]): Promise<void> {
    const a = availability();
    const api = ui();
    const owner = ownerId();
    if (!a.ok || !api || owner === null || !eligible()) {
      throw new ProtectedChannelUnavailable();
    }
    setPending("protect");
    setError(null);
    setSaved(false);
    try {
      await api.protect(
        props.channel.id,
        ownerFirst(userIds, owner),
        a.deviceCap,
      );
    } catch (err) {
      setError(errorText(err));
      throw err;
    } finally {
      setPending(null);
    }
    rereadSeats();
  }

  function openProtectPicker() {
    const a = availability();
    setConfirming(false);
    if (!a.ok || busy() || !eligible()) return;
    openModal({
      type: "protected_seat_picker",
      channel: props.channel,
      current: [],
      slotCap: a.slotCap,
      onConfirm: runProtect,
    });
  }

  /** Device cap a seat change re-signs with: the enforced one, or none. */
  const seatsDeviceCap = () => seatCount(seats()?.device_cap);
  /** Removal is never flag-gated (D13); it needs a capable device. */
  const canChangeSeats = () =>
    eligible() &&
    isProtected() &&
    capable() &&
    seats() !== null &&
    seatsDeviceCap() !== null;
  /** Adding seats is growth: flag-gated (D13). */
  const canAddSeats = () => canChangeSeats() && flag().enabled === true;

  async function runSetSeats(
    userIds: string[],
    rethrow: boolean,
  ): Promise<void> {
    const api = ui();
    const owner = ownerId();
    const cap = seatsDeviceCap();
    if (!api || owner === null || cap === null || !canChangeSeats()) {
      if (rethrow) throw new ProtectedChannelUnavailable();
      return;
    }
    // The signed list this change was built from (W4d refusal scope).
    const listBody = seats()?.list?.body;
    setPending("seats");
    setError(null);
    setSaved(false);
    try {
      await api.setSeats(props.channel.id, ownerFirst(userIds, owner), cap);
      setSaved(true);
    } catch (err) {
      noteRemovedRefusal(err, listBody);
      setError(errorText(err));
      if (rethrow) throw err;
      return;
    } finally {
      setPending(null);
    }
    rereadSeats();
  }

  function openSeatPicker() {
    const s = seats();
    if (!s || busy() || !canAddSeats()) return;
    setSaved(false);
    openModal({
      type: "protected_seat_picker",
      channel: props.channel,
      // W4d: never a server-removed user (none pre-selected, none re-sent)
      current: editableIds(),
      slotCap: seatCount(s.slot_cap),
      // Rejects on failure so the picker shows the notice (C12 contract).
      onConfirm: (userIds) => runSetSeats(userIds, true),
      removed: removedIds(),
    });
  }

  /**
   * "Remove seat", called only from SeatList's inline confirm (W4c#4): one
   * owner unseat (design 6.3).
   */
  function removeSeat(userId: string) {
    const s = seats();
    const owner = ownerId();
    if (!s || owner === null || busy() || !canChangeSeats()) return;
    // W4d: from the editable seats, so a list still naming another
    // server-removed user is never submitted
    const next = seatsAfterRemoval(editableIds(), owner, userId);
    if (next === null) return;
    void runSetSeats(next, false);
  }

  /** Why "Protect this channel" isn't offered (C0 copy where it exists). */
  function blockCopy(block: ProtectBlock): string | null {
    switch (block) {
      case "not_available":
        return noticeCopy("not_available");
      case "enable_e2ee":
        return noticeCopy("enable_e2ee");
      case "flag_off":
        return noticeCopy("protected_channels_unavailable");
      case "staff_owner":
        // C16: local msgid, same text as C12's
        return t`Staff accounts can't be seated.`;
      case "has_messages":
        // C16: local msgid (protecting a channel with history is S4)
        return t`Only a channel without messages can be protected.`;
      case "loading":
        return null;
      case "load_failed":
        return noticeCopy("network_error");
      case "no_entitlement":
        // C16: local msgid
        return t`Protected channels aren't enabled for this channel yet.`;
      case "no_device_cap":
        // C16: local msgid, same text as SeatList's
        return t`The device limit isn't known yet.`;
      default: {
        const _exhaustive: never = block;
        return noticeCopy("protected_channels_unavailable");
      }
    }
  }

  /** The reason protecting isn't offered, or null when it is. */
  const protectBlock = (): ProtectBlock | null => {
    const a = availability();
    return a.ok ? null : a.block;
  };

  const unavailableNotice = () =>
    noticeCopy(tauriE2eeOff() ? "enable_e2ee" : "not_available");

  return (
    <Show
      when={eligible()}
      fallback={<Notice role="alert">{settingsCopy.ownerOnly()}</Notice>}
    >
      <Page>
        <Description>{settingsCopy.description()}</Description>

        <Switch>
          <Match when={!isProtected()}>
            <Section data-protected-page="unprotected">
              <Switch>
                <Match when={pending() === "protect"}>
                  <Progress aria-live="polite">
                    <CircularProgress size={20} />
                    <span>{settingsCopy.protecting()}</span>
                  </Progress>
                </Match>
                <Match when={protectBlock()}>
                  {(block) => (
                    <Show
                      when={blockCopy(block())}
                      fallback={<CircularProgress size={20} />}
                    >
                      {(text) => (
                        <Info data-protect-block={block()}>{text()}</Info>
                      )}
                    </Show>
                  )}
                </Match>
                <Match when={confirming()}>
                  <Confirm role="group">
                    <ConfirmTitle>
                      {settingsCopy.protectConfirmTitle()}
                    </ConfirmTitle>
                    <Warning>{settingsCopy.protectConfirmBody()}</Warning>
                    <Actions>
                      <Button
                        variant="text"
                        onPress={() => setConfirming(false)}
                      >
                        <Trans>Cancel</Trans>
                      </Button>
                      <Button
                        variant="filled"
                        isDisabled={busy()}
                        onPress={openProtectPicker}
                      >
                        <Trans>Continue</Trans>
                      </Button>
                    </Actions>
                  </Confirm>
                </Match>
                <Match when={availability().ok}>
                  {/* One-way (plan D1): said before the first click. */}
                  <Warning>{settingsCopy.protectConfirmBody()}</Warning>
                  <Actions>
                    <Button
                      variant="filled"
                      isDisabled={busy()}
                      onPress={() => setConfirming(true)}
                    >
                      {settingsCopy.protectButton()}
                    </Button>
                  </Actions>
                </Match>
              </Switch>
            </Section>
          </Match>

          <Match when={isProtected()}>
            <Section data-protected-page="protected">
              <Show when={!capable()}>
                <Info>{unavailableNotice()}</Info>
              </Show>

              <Show when={busy()}>
                <Progress aria-live="polite">
                  <CircularProgress size={20} />
                  <span>{settingsCopy.publishInFlight()}</span>
                </Progress>
              </Show>

              <Show
                when={seats()}
                fallback={
                  <Show
                    when={rawFor()?.state === "failed"}
                    fallback={<CircularProgress size={24} />}
                  >
                    <Notice role="alert">{noticeCopy("network_error")}</Notice>
                  </Show>
                }
              >
                {(s) => (
                  <>
                    <Show when={canAddSeats()}>
                      <Actions>
                        <Button
                          variant="filled"
                          isDisabled={busy()}
                          onPress={openSeatPicker}
                        >
                          {settingsCopy.addSeats()}
                        </Button>
                      </Actions>
                    </Show>
                    <SeatList
                      channel={props.channel}
                      seats={s()}
                      ownerId={ownerId()!}
                      removed={removedIds()}
                      hideRemove={!canChangeSeats()}
                      disabled={busy()}
                      onRemove={removeSeat}
                    />
                  </>
                )}
              </Show>
            </Section>
          </Match>
        </Switch>

        <Show when={saved() && !error()}>
          <Saved aria-live="polite">{settingsCopy.seatsSaved()}</Saved>
        </Show>
        <Show when={error()}>
          <Notice role="alert">{error()}</Notice>
        </Show>
      </Page>
    </Show>
  );
}

// protected-pure:begin
// Page rules, loaded by `protectedSettings.scan.test.ts`: no imports.

/**
 * Settings entry/page visibility (product choice 4): a server text channel
 * whose server owner is this user. Voice and announcement channels can't be
 * protected (design 7.2), so they get no page unless already protected or
 * pinned (the owner must still be able to unseat there).
 */
export function protectedSettingsEligible(i: {
  type: unknown;
  serverId: unknown;
  voice: unknown;
  announcement: unknown;
  protectedOrPinned: unknown;
  ownerId: unknown;
  selfId: unknown;
}): boolean {
  if (i.type !== "TextChannel") return false;
  if (typeof i.serverId !== "string" || i.serverId.length === 0) return false;
  if (typeof i.ownerId !== "string" || i.ownerId.length === 0) return false;
  if (i.selfId !== i.ownerId) return false;
  if (i.protectedOrPinned === true) return true;
  return i.voice !== true && i.announcement !== true;
}

/** "Has history" from the channel's `lastMessageId` (design 7.2). */
export function channelHasMessages(lastMessageId: unknown): boolean {
  return typeof lastMessageId === "string" && lastMessageId.length > 0;
}

/** A non-negative safe integer, else null (unknown; never 0). */
function capValue(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Device cap for the genesis list: the entitlement's ceiling from the seats
 * read, else the server's advertised default (D13). Never invented: null
 * when neither is known.
 */
export function deviceCapForProtect(
  entitlementDeviceCap: unknown,
  defaultDeviceCap: unknown,
): number | null {
  return capValue(entitlementDeviceCap) ?? capValue(defaultDeviceCap);
}

/** Whether the unprotected page needs a seats read (the entitlement). */
export function protectReadWanted(i: {
  flagEnabled: unknown;
  capable: unknown;
  selfPrivileged: unknown;
  hasMessages: unknown;
}): boolean {
  return (
    i.flagEnabled === true &&
    i.capable === true &&
    i.selfPrivileged !== true &&
    i.hasMessages !== true
  );
}

export type ProtectBlock =
  | "not_available"
  | "enable_e2ee"
  | "flag_off"
  | "staff_owner"
  | "has_messages"
  | "loading"
  | "load_failed"
  | "no_entitlement"
  | "no_device_cap";

/**
 * Whether "Protect this channel" is offered, and with which caps. The flag
 * (D13) gates it; so do capability (D3), a staff owner (refused, design
 * 7.2), history (S4) and the entitlement (`slot_cap` null = none).
 */
export function protectAvailability(i: {
  flagEnabled: unknown;
  capable: unknown;
  tauriE2eeOff: unknown;
  selfPrivileged: unknown;
  hasMessages: unknown;
  seats:
    | null
    | "loading"
    | "failed"
    | { slot_cap?: unknown; entitlement_device_cap?: unknown };
  defaultDeviceCap: unknown;
}):
  | { ok: true; slotCap: number; deviceCap: number }
  | { ok: false; block: ProtectBlock } {
  const block = (b: ProtectBlock) => ({ ok: false as const, block: b });
  if (i.capable !== true) {
    return block(i.tauriE2eeOff === true ? "enable_e2ee" : "not_available");
  }
  if (i.flagEnabled !== true) return block("flag_off");
  if (i.selfPrivileged === true) return block("staff_owner");
  if (i.hasMessages === true) return block("has_messages");
  if (i.seats === null || i.seats === "loading") return block("loading");
  if (i.seats === "failed" || typeof i.seats !== "object") {
    return block("load_failed");
  }
  const slotCap = capValue(i.seats.slot_cap);
  if (slotCap === null) return block("no_entitlement");
  const deviceCap = deviceCapForProtect(
    i.seats.entitlement_device_cap,
    i.defaultDeviceCap,
  );
  if (deviceCap === null) return block("no_device_cap");
  return { ok: true, slotCap, deviceCap };
}

/**
 * A raw `GET .../seats` body in the design 7.2 shape, or null. Only the
 * fields the page reads are checked; the caps stay nullable.
 */
export function parseSeatsBody(body: unknown): ProtectedSeatsResponse | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.seats) || !Array.isArray(b.cooling)) return null;
  if (
    b.list !== null &&
    (typeof b.list !== "object" || Array.isArray(b.list))
  ) {
    return null;
  }
  return body as ProtectedSeatsResponse;
}

/**
 * W4d: the seats the page shows and edits from. `fresh` (a read taken
 * after a refusal) is used only over the very snapshot it was read against
 * and only while it carries the same signed list body: it updates the seat
 * rows (a forced release never changes the list), never the list the
 * bridge verified. A newer bridge snapshot always wins.
 */
export function seatsOver<T extends { list?: { body?: unknown } | null }>(
  snap: T,
  fresh: { basis: unknown; body: T } | null,
): T {
  if (fresh === null || fresh.basis !== snap) return snap;
  const body = snap.list?.body;
  return typeof body === "string" && fresh.body.list?.body === body
    ? fresh.body
    : snap;
}

/** A `SeatListNamesRemovedUsers` refusal the page remembers (W4d). */
export interface RemovedRefusal {
  channelId: string;
  /** The signed list body the refused change was built from. */
  listBody: string;
  users: readonly string[];
}

/**
 * The remembered refusal's ids while it still applies: same channel, same
 * signed list (a newer list was built without them, or names them anew
 * as an ordinary add). Else none.
 */
export function refusedFor(
  r: RemovedRefusal | null,
  channelId: string,
  listBody: unknown,
): readonly string[] {
  if (r === null || r.channelId !== channelId) return [];
  return typeof listBody === "string" && r.listBody === listBody ? r.users : [];
}

/**
 * The user ids of a `SeatListNamesRemovedUsers` answer (a
 * `protectedNoticeForError` result, kind `seat_list_names_removed_users`),
 * or null for any other answer. Only ever leaves users off the next list;
 * it never resubmits.
 */
export function removedUsersOfRefusal(ui: unknown): string[] | null {
  if (typeof ui !== "object" || ui === null) return null;
  const u = ui as { kind?: unknown; notice?: unknown; users?: unknown };
  if (u.kind !== "notice" || u.notice !== "seat_list_names_removed_users") {
    return null;
  }
  if (!Array.isArray(u.users)) return [];
  return u.users.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}
// protected-pure:end

const Page = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-lg)",
  },
});

const Section = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
  },
});

const Description = styled("p", {
  base: {
    margin: 0,
    fontSize: "0.9rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Warning = styled("div", {
  base: {
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    background: "var(--md-sys-color-tertiary-container)",
    color: "var(--md-sys-color-on-tertiary-container)",
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

const Notice = styled("div", {
  base: {
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
  },
});

const Saved = styled("div", {
  base: {
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Progress = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Confirm = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
  },
});

const ConfirmTitle = styled("strong", {
  base: {
    fontSize: "0.95rem",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-md)",
    justifyContent: "flex-start",
  },
});

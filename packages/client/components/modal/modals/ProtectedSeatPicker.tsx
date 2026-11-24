import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
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
  panelCopy,
  reasonProblemCopy,
  seatPickerCopy,
  settingsCopy,
} from "@revolt/client/protectedCopy";
import {
  AUDIT_LOG_REASON_MAX_CHARS,
  reasonRefusal,
  validReason,
} from "@revolt/client/protectedRemovalReasonPolicy";
import {
  type SeatDiscardOutcome,
  type SeatReleaseCause,
  seatAdds,
  seatClientReason,
  seatDeviceCounts,
  seatDiscardOutcome,
  seatFailureBody,
  seatReasonRequired,
  seatReleasedRows,
  seatRemovalsWaiting,
  seatUntilText,
  seatUsedCount,
} from "@revolt/client/protectedSeatUiPolicy";
import {
  type ProtectedErrorUi,
  protectedNoticeForError,
} from "@revolt/client/protectedShield";
import { proposedOwnerDevices } from "@revolt/client/protectedTextOwner";
import type { ProtectedUiApi } from "@revolt/client/protectedTextTypes";
import {
  protectedUiOf,
  useProtectedShield,
} from "@revolt/client/useProtectedChannel";
import { Avatar } from "@revolt/ui/components/design/Avatar";
import { Button } from "@revolt/ui/components/design/Button";
import { type DialogProps, Dialog } from "@revolt/ui/components/design/Dialog";
import { CircularProgress } from "@revolt/ui/components/design/LoadingProgress";
import { Column } from "@revolt/ui/components/layout/Column";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { Modals } from "../types";

/** Rows shown for unseated members before the owner has to search. */
const UNSEATED_ROW_LIMIT = 100;

/** How often "Removal waiting" re-checks the age of pending removals. */
const REMOVAL_RECHECK_MS = 30_000;

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
 *
 * S2 (D39 / D40, lane U8), owner only, from the bridge's last seat read
 * and channel view: released seats with their cause (they still count
 * against the slot cap, so the counter and the cap clamp include them);
 * the "no longer have seats" banner with a removal-only "Update the list";
 * "Removal waiting" / "Finish now" for a pending removal older than 10
 * minutes; a device count per seated row; the revoked-owner-devices banner
 * (`proposedOwnerDevices` → `authoritySign`, one native dialog). A seat
 * change the server refused for its reason asks for one and re-sends the
 * SAME stored change with it (design 4.9: the stored publish wins, the
 * rows lock and the modal says so); "Discard this change" drops a stored
 * change only when the bridge proves the server never took it (F3).
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

  /** The bridge's protected surface (S2 reads and owner actions), or null. */
  const bridgeUi = () => protectedUiOf(client()?.e2ee);

  /**
   * One bridge read for render: `none` without a bridge surface, or when
   * the read throws (an older bridge lacking the method, say).
   */
  function readUi<T>(read: (api: ProtectedUiApi) => T, none: T): T {
    const api = bridgeUi();
    if (!api) return none;
    try {
      return read(api);
    } catch {
      return none;
    }
  }

  /** The manager's view of this channel (text group, native state). */
  const view = () => {
    const id = props.channel.id;
    return readUi((api) => api.protectedChannels.get(id) ?? null, null);
  };
  /** The last `GET .../seats` body the bridge holds. */
  const snapshot = () => {
    const id = props.channel.id;
    return readUi((api) => api.seatsSnapshot(id), null);
  };
  /** F3: this device's stored, unresolved seat publish, or null. */
  const stored = () => {
    const id = props.channel.id;
    return readUi((api) => api.pendingSeats(id), null);
  };

  // S2 D39: released seats still cooling (owner reads carry the cause).
  const released = createMemo(() => seatReleasedRows(snapshot()?.cooling));
  const cooling = createMemo(() => released().map((r) => r.userId));
  const coolingSet = createMemo(() => new Set(cooling()));

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
  /** A neutral outcome line (discard, finish now); never an error. */
  const [note, setNote] = createSignal<string | null>(null);

  // S2 D40: the unseat reason, asked for once the server refused a seat
  // change for it (or for a stored change already refused for it).
  const [reasonWanted, setReasonWanted] = createSignal(false);
  const [reason, setReason] = createSignal("");
  const [reasonProblem, setReasonProblem] = createSignal<string | null>(null);
  const askReason = () => reasonWanted() || stored()?.reasonRequired === true;

  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), REMOVAL_RECHECK_MS);
    onCleanup(() => clearInterval(timer));
  });

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

  // S2 D39 cap clamp: released seats still cooling count (design 2.3).
  const used = () => {
    const owner = ownerId();
    return owner === null
      ? selected().size
      : seatUsedCount(
          seatFinalList(currentIds(), selected(), owner),
          cooling(),
        );
  };

  const blockOf = (row: SeatRow) =>
    seatToggleBlock(
      row.candidate,
      selected(),
      current(),
      ownerId(),
      slotCap,
      coolingSet(),
    );

  // While a reason is asked for, Confirm re-sends the stored change (4.9).
  const canConfirm = () =>
    !pending() &&
    viewerIsOwner() &&
    (askReason() ||
      seatCanConfirm(
        currentIds(),
        selected(),
        ownerId(),
        slotCap,
        dropped().size > 0,
        cooling(),
      ));

  function toggle(row: SeatRow) {
    if (pending() || blockOf(row) !== null) return;
    // The stored change is re-sent as signed: picks here can't join it.
    if (askReason()) return;
    setSelected((prev) => seatToggled(prev, row.candidate.id));
    setError(null);
  }

  /** "Update the list": only for a removal-only change (no dialog, D39). */
  const canUpdateList = () => {
    const owner = ownerId();
    return (
      owner !== null &&
      !askReason() &&
      canConfirm() &&
      !seatAdds(currentIds(), selected(), owner)
    );
  };

  /** S2 D39: devices per seated user in the open Text group. */
  const deviceCounts = createMemo(() =>
    seatDeviceCounts(view()?.serverGroup?.members),
  );
  /** A seated row's device count; null when not seated or not known. */
  const devicesOf = (row: SeatRow): number | null => {
    const id = row.candidate.id;
    if (id !== ownerId() && !current().has(id)) return null;
    const counts = deviceCounts();
    return counts === null ? null : (counts.get(id) ?? 0);
  };

  /** S2 D39: pending removals waiting 10 minutes or more (owner only). */
  const waiting = createMemo(() =>
    viewerIsOwner()
      ? seatRemovalsWaiting(view()?.serverGroup?.pending_removals, now())
      : [],
  );
  const poisoned = () => view()?.native?.state === "poisoned";

  /** S2 (R27): the server reported revoked owner devices (owner reads). */
  const revoked = () => {
    const r = snapshot()?.revoked_owner_devices;
    return viewerIsOwner() && Array.isArray(r) && r.length > 0;
  };
  /** The owner devices to sign instead; null when this device can't. */
  const proposedDevices = createMemo(() => {
    if (!viewerIsOwner()) return null;
    const self = readUi((api) => api.selfDeviceId(), null);
    if (self === null) return null;
    try {
      return proposedOwnerDevices(snapshot(), self);
    } catch {
      // a malformed seat read offers nothing
      return null;
    }
  });

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

  // S2 D39: the released and waiting users are named too.
  createEffect(() => {
    const c = client();
    for (const id of [...cooling(), ...waiting()]) {
      if (requested.has(id) || c.users.get(id)) continue;
      requested.add(id);
      c.users.fetch(id).catch(() => {
        // the row reads "Unknown member"; nothing else depends on it
      });
    }
  });

  /** S2 D39 local msgid: a user this client can't name (never the id). */
  const unknownMember = () => t`Unknown member`;
  /** A display name for the S2 sections, never an id. */
  const nameOf = (id: string): string =>
    displayNames([id])[0] ?? unknownMember();

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
    // S2 D40: the reason is checked as the server will, before any send.
    let sendReason: string | null = null;
    if (askReason()) {
      const check = validReason(reason(), "header");
      if (!check.ok) {
        setReasonProblem(
          reasonProblemCopy(check.why, AUDIT_LOG_REASON_MAX_CHARS),
        );
        return;
      }
      sendReason = check.reason;
    }
    setReasonProblem(null);
    setNote(null);
    setPending(true);
    setError(null);
    try {
      const list = seatFinalList(currentIds(), selected(), owner);
      await (sendReason === null
        ? props.onConfirm(list)
        : setSeatsWithReason(list, sendReason));
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
      // S2 D40: the reason refusals come before the notice mapping. Both
      // leave the signed change stored (4.9) for a retry with a reason.
      if (reasonRefusal(seatFailureBody(err)) === "too_long") {
        setReasonWanted(true);
        setReasonProblem(
          reasonProblemCopy("too_long", AUDIT_LOG_REASON_MAX_CHARS),
        );
      } else if (seatReasonRequired(ui)) {
        setReasonWanted(true);
      } else if (seatClientReason(err) === "publish_not_persisted") {
        setError(notPersistedLine());
      } else {
        setError(
          errorUiCopy(ui, { removedUserNames: displayNames, failure: err }),
        );
      }
    } finally {
      setPending(false);
    }
  }

  /**
   * S2 D40: the seat PUT again, with the reason header. A stored change
   * the server refused for its reason IS this change: the bridge re-sends
   * it byte for byte and signs nothing (design 4.9), so `list` is used
   * only when no change is stored. The device cap is the enforced one, as
   * the settings page passes it.
   */
  async function setSeatsWithReason(list: string[], why: string) {
    const api = bridgeUi();
    const cap = seatCapOf(snapshot()?.device_cap);
    if (!api || cap === null) throw new ProtectedChannelUnavailable();
    await api.setSeats(props.channel.id, list, cap, why);
  }

  /** F3 "Discard this change": only what the server never took. */
  async function discard() {
    const api = bridgeUi();
    if (!api || pending()) return;
    setPending(true);
    setError(null);
    setNote(null);
    try {
      const outcome = seatDiscardOutcome(
        await api.cancelPendingSeats(props.channel.id),
      );
      if (outcome === "discarded" || outcome === "none") {
        setReasonWanted(false);
        setReason("");
        setReasonProblem(null);
      }
      setNote(discardLine(outcome));
    } catch (err) {
      setError(errorUiCopy(errorUiOf(err), { failure: err }));
    } finally {
      setPending(false);
    }
  }

  /** R27: re-sign the owner devices without the revoked ones. */
  async function resignDevices() {
    const api = bridgeUi();
    const devices = proposedDevices();
    if (!api || devices === null || pending()) return;
    setPending(true);
    setError(null);
    setNote(null);
    try {
      await api.authoritySign(props.channel.id, devices);
    } catch (err) {
      // `none` (native Declined) maps to null: nothing shown
      setError(errorUiCopy(errorUiOf(err), { failure: err }));
    } finally {
      setPending(false);
    }
  }

  /**
   * "Finish now": one manual refresh (`retryNow`, never the open's 60 s
   * loop) lets the removal duty commit the pending Removes (design 6.3).
   */
  function finishNow() {
    const api = bridgeUi();
    if (!api || pending()) return;
    api.retryNow(props.channel.id);
    setError(null);
    setNote(finishLine());
  }

  /** On a poisoned group "Finish now" can't help: re-create it (9.2). */
  async function recreate() {
    const api = bridgeUi();
    if (!api || pending()) return;
    setPending(true);
    setError(null);
    setNote(null);
    try {
      await api.recreateGroup(props.channel.id);
    } catch (err) {
      setError(errorUiCopy(errorUiOf(err), { failure: err }));
    } finally {
      setPending(false);
    }
  }

  // ---- S2 local msgids (catalog owed, L9) -------------------------------

  const releasedTitle = () => t`Released seats`;

  /** Why a released seat was released (owner reads only carry it). */
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

  const untilLine = (until: string) =>
    t`Counts toward the seat limit until ${until}`;
  const noSeatsLine = (count: number) =>
    t`People on your signed list who no longer have seats: ${count}`;
  const updateListLabel = () => t`Update the list`;
  const waitingTitle = () => t`Removal waiting`;
  const finishLabel = () => t`Finish now`;
  const finishLine = () => t`Trying the removal again…`;
  const devicesLine = (count: number) => t`Devices: ${count}`;
  const resignLabel = () => t`Re-sign signing devices`;
  const reasonLabel = () => t`Reason for the removal`;
  const discardLabel = () => t`Discard this change`;
  const storedLine = () =>
    t`An earlier change to the seats hasn't finished saving. Trying again sends that same change, exactly as it was.`;
  const lockedLine = () =>
    t`Seats you pick here aren't included. Discard the earlier change to make a different one.`;
  const cantDiscardLine = () =>
    t`This change can't be discarded now. The server may already have it.`;
  const maybeAcceptedLine = () =>
    t`The server may already have this change, so it can't be discarded.`;
  const notPersistedLine = () =>
    t`This change couldn't be stored on this device, so it wasn't sent. Try again.`;

  /** F3 outcome copy; an unreadable answer reads as "maybe accepted". */
  function discardLine(outcome: SeatDiscardOutcome): string {
    switch (outcome) {
      case "discarded":
        return t`The change was discarded.`;
      case "none":
        return t`There's no change waiting to be discarded.`;
      case "busy":
        return t`This change is being sent right now. Try again in a moment.`;
      case "maybe_accepted":
      case "unknown":
        return maybeAcceptedLine();
      default: {
        const _exhaustive: never = outcome;
        return maybeAcceptedLine();
      }
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

        {/* S2 R27: the server reports revoked owner devices (owner only). */}
        <Show when={revoked()}>
          <Alert role="alert" data-revoked-owner-devices>
            <span>{noticeCopy("revoked_owner_devices")}</span>
            <Show when={proposedDevices() !== null}>
              <Button
                size="xs"
                variant="tonal"
                isDisabled={pending()}
                onPress={() => void resignDevices()}
              >
                {resignLabel()}
              </Button>
            </Show>
          </Alert>
        </Show>

        {/* S2 D39: people the signed list names who no longer have seats. */}
        <Show when={viewerIsOwner() && dropped().size > 0}>
          <Callout role="status" data-update-list>
            <span>{noSeatsLine(dropped().size)}</span>
            <Show when={canUpdateList()}>
              <Button
                size="xs"
                variant="tonal"
                isDisabled={pending()}
                onPress={() => void confirm()}
              >
                {updateListLabel()}
              </Button>
            </Show>
          </Callout>
        </Show>

        {/* S2 D39: a pending removal 10 minutes old (design 6.3, 9.2). */}
        <Show when={waiting().length > 0}>
          <Callout role="status" data-removal-waiting>
            <SectionTitle>{waitingTitle()}</SectionTitle>
            <span>{waiting().map(nameOf).join(", ")}</span>
            <Show
              when={poisoned()}
              fallback={
                <Button
                  size="xs"
                  variant="tonal"
                  isDisabled={pending()}
                  onPress={finishNow}
                >
                  {finishLabel()}
                </Button>
              }
            >
              <Button
                size="xs"
                variant="tonal"
                isDisabled={pending()}
                onPress={() => void recreate()}
              >
                {panelCopy.recreateGroup()}
              </Button>
            </Show>
          </Callout>
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
                  aria-disabled={block() !== null || pending() || askReason()}
                  data-blocked={block() !== null || askReason() || undefined}
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
                  {/* S2 D39: the seated user's devices in the group. */}
                  <Show when={devicesOf(row) !== null}>
                    <SeatDevices data-devices>
                      {devicesLine(devicesOf(row) ?? 0)}
                    </SeatDevices>
                  </Show>
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

        {/* S2 D39: released seats still count for 14 days (design 2.3). */}
        <Show when={viewerIsOwner() && released().length > 0}>
          <Section data-released>
            <SectionTitle>{releasedTitle()}</SectionTitle>
            <For each={released()}>
              {(seat) => (
                <SectionRow>
                  <SeatName>{nameOf(seat.userId)}</SeatName>
                  <Show when={causeLine(seat.cause)}>
                    {(line) => <SeatNote>{line()}</SeatNote>}
                  </Show>
                  <Show when={seatUntilText(seat.until)}>
                    {(until) => <SeatNote>{untilLine(until())}</SeatNote>}
                  </Show>
                </SectionRow>
              )}
            </For>
          </Section>
        </Show>

        {/* F3 / D40: a stored change wins over the picks here (4.9). Not
            while a send runs: that send's own change is stored meanwhile. */}
        <Show
          when={
            viewerIsOwner() &&
            !pending() &&
            (stored() !== null || reasonWanted())
          }
        >
          <Callout role="status" data-stored-change>
            <span>{storedLine()}</span>
            <Show when={askReason()}>
              <span>{lockedLine()}</span>
            </Show>
            <Show when={stored()}>
              {(s) => (
                <>
                  <Button
                    size="xs"
                    variant="text"
                    isDisabled={pending() || s().discardable === false}
                    onPress={() => void discard()}
                  >
                    {discardLabel()}
                  </Button>
                  <Show when={s().discardable === false}>
                    <SeatNote>{cantDiscardLine()}</SeatNote>
                  </Show>
                </>
              )}
            </Show>
          </Callout>
        </Show>

        {/* S2 D40: the unseat reason, once the server asked for one. */}
        <Show when={viewerIsOwner() && askReason()}>
          <Section data-reason>
            <SeatNote>{noticeCopy("removal_reason_required")}</SeatNote>
            <ReasonInput
              value={reason()}
              placeholder={reasonLabel()}
              aria-label={reasonLabel()}
              aria-invalid={reasonProblem() !== null}
              disabled={pending()}
              onInput={(event) => {
                setReason(event.currentTarget.value);
                setReasonProblem(null);
              }}
            />
            <Show when={reasonProblem()}>
              {(problem) => <SeatNote role="alert">{problem()}</SeatNote>}
            </Show>
          </Section>
        </Show>

        <Show when={note()}>
          {(line) => <Status role="status">{line()}</Status>}
        </Show>

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
// Seat rules, loaded by `protectedSeatPicker.scan.test.ts`: no imports. The
// one outside name they use, `seatUsedCount`, is the shared policy's
// (`protectedSeatUiPolicy.ts`, imported above; the spec supplies it).

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
 * S2 D39: `cooling` seats count toward the cap, and re-seating a cooling
 * user takes no new slot (design 2.3).
 */
function seatToggleBlock(
  c: SeatCandidate,
  selected: ReadonlySet<string>,
  current: ReadonlySet<string>,
  ownerId: string | null,
  slotCap: number | null,
  cooling: ReadonlySet<string> = new Set(),
): SeatBlock | null {
  if (ownerId === null || c.id === ownerId) return "owner";
  if (selected.has(c.id)) return null;
  if (!current.has(c.id)) {
    if (c.bot) return "bot";
    if (c.privileged) return "staff";
    if (!c.canView) return "no_access";
  }
  if (cooling.has(c.id)) return null;
  const list = seatFinalList([...current], selected, ownerId);
  return seatCapFull(seatUsedCount(list, cooling), slotCap) ? "cap" : null;
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
 * S2 D39: the cap counts `cooling` seats the list doesn't re-seat.
 */
function seatCanConfirm(
  current: readonly string[],
  selected: ReadonlySet<string>,
  ownerId: string | null,
  slotCap: number | null,
  cleanup = false,
  cooling: readonly string[] = [],
): boolean {
  if (ownerId === null) return false;
  const list = seatFinalList(current, selected, ownerId);
  const used = seatUsedCount(list, cooling);
  if (current.length === 0) return !seatCapExceeded(used, slotCap);
  const before = new Set([ownerId, ...current]);
  const adds = list.some((id) => !before.has(id));
  if (!adds && list.length === before.size) return cleanup;
  return !(adds && seatCapExceeded(used, slotCap));
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

const Alert = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "8px",
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.85rem",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
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

const Status = styled("div", {
  base: {
    fontSize: "0.85rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Section = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
});

const SectionTitle = styled("span", {
  base: {
    fontSize: "0.85rem",
    fontWeight: 600,
  },
});

const SectionRow = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    padding: "4px 10px",
  },
});

const ReasonInput = styled("textarea", {
  base: {
    minHeight: "64px",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.9rem",
    resize: "vertical",
    "&:focus": {
      outline: "none",
      borderColor: "var(--md-sys-color-primary)",
    },
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

const SeatDevices = styled("span", {
  base: {
    flexShrink: 0,
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

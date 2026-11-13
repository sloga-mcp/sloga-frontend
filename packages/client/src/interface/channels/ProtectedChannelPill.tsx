import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import type { E2EEBridge } from "@revolt/client/e2ee";
import {
  type OwnerNoticeDisplay,
  errorUiCopy,
  noticeCopy,
  ownerNoticeCopy,
  panelCopy,
  shieldLabel,
} from "@revolt/client/protectedCopy";
import {
  type ResecureEscalation,
  resecureCause,
} from "@revolt/client/protectedResecurePolicy";
import {
  type ProtectedShieldState,
  protectedNoticeForError,
  shieldPresentation,
} from "@revolt/client/protectedShield";
import type {
  OwnerDeviceNotice,
  OwnerPinStatus,
  ProtectedChannelView,
  ProtectedSeatsResponse,
  ProtectedUiApi,
} from "@revolt/client/protectedTextTypes";
import {
  protectedUiOf,
  shouldRunOpenLifecycle,
  useProtectedShield,
} from "@revolt/client/useProtectedChannel";
import { useWindowCtx } from "@revolt/client/windowCtx";
import { type ModalRequest, useModals } from "@revolt/modal";
import { ProtectedShieldIcon } from "@revolt/ui/components/features/protected/ProtectedShieldIcon";

/**
 * Protected channel header pill and its click panel (W4 lane C3, plan D14,
 * D15, D21; product choices 2, 3, 5, 6; S2 W4-3 lane U2).
 *
 * Renders nothing for a channel that is neither server-protected nor pinned,
 * so a normal header is unchanged. The pill is state-colored; its click
 * panel shows the state line and notice, then (only on a capable device, in
 * a state with details) the encryption line, seat usage, the owner-pin
 * verification state, "Review owner change" (D15: only while a SAME-user
 * owner change is pending and the shield offers it; the click opens the D41
 * review screen, which alone runs the native dialog) and the
 * owner-device-only "Re-create the protected group" (D21). No handover UI
 * (choice 3). A device that cannot run the text plane, or whose client the
 * server refused as outdated, gets the explanation only.
 *
 * S2: the persistent owner alert (`native.owner_alert`, OR-9) is a banner at
 * the top of the panel plus a dot on the pill, never dismissed here; the
 * one-shot `ownerNotice` is shown with names only (never ids); a lost owner
 * signing device offers "Recover ownership on this device" on another device
 * of the owner; a long re-securing (D36) gets amber wording and at most one
 * action, never a state change.
 *
 * Reads only the read-only shield hook and the bridge's `ProtectedUiApi`;
 * no request is sent unless the user clicks an action, except one read of
 * this account's own device listing to name the device in an owner notice.
 * Imports are file paths and every `styled` call takes a string tag (an
 * imported component at module scope blanks the app).
 */

// --- pure: begin (loaded by protectedPill.scan.test.ts; the only runtime
// dependency is A2 `shieldPresentation`)

/**
 * D15 + choice 2: "Review owner change" is offered only while native holds
 * a pending signer of the SAME user and the change is pending (the manager
 * parked it, or native reports the pin as changed). A different user is
 * final in S1 (native's inform dialog), and an unknown signer gets no
 * button.
 * @param view The manager's channel view
 */
export function pillOwnerChangeReviewable(
  view: ProtectedChannelView | null | undefined,
): boolean {
  const pin = view?.native?.owner_pin ?? null;
  if (!pin || pin.pending_signer?.same_user !== true) return false;
  return view?.ownerChangePending === true || pin.status === "changed";
}

/**
 * S2 F1 (OR-10): Review is offered only when the D15 precondition holds AND
 * the shield offers it (`ShieldExplanation.reviewOffered`, read `=== true`):
 * an unlisted same-user signer is never offered Review.
 * @param view The manager's channel view
 * @param reviewOffered `shield().reviewOffered`
 */
export function pillReviewOffered(
  view: ProtectedChannelView | null | undefined,
  reviewOffered: unknown,
): boolean {
  return pillOwnerChangeReviewable(view) && reviewOffered === true;
}

/**
 * Seat usage from the last `GET .../seats`. A null, non-integer or
 * non-positive `slot_cap` is UNKNOWN (null), never 0 and never "unlimited"
 * (design #152). No snapshot, or a malformed count, shows no seat line.
 * @param snapshot `seatsSnapshot(channelId)`
 */
export function pillSeats(
  snapshot: ProtectedSeatsResponse | null | undefined,
): { used: number; cap: number | null } | null {
  if (!snapshot) return null;
  const used = snapshot.seats_used;
  if (typeof used !== "number" || !Number.isInteger(used) || used < 0) {
    return null;
  }
  const cap = snapshot.slot_cap;
  return {
    used,
    cap:
      typeof cap === "number" && Number.isInteger(cap) && cap >= 1 ? cap : null,
  };
}

/**
 * Owner-pin line. "Verified" needs the pin AND native's verification of the
 * owner's device (`owner_verified`); a first-sight pin is "not verified
 * yet". A changed pin shows the review line only while Review is offered
 * (`pillReviewOffered`); otherwise the state notice already explains it
 * (null = no line).
 * @param view The manager's channel view
 * @param reviewOffered `shield().reviewOffered`
 */
export function pillOwnerPin(
  view: ProtectedChannelView | null | undefined,
  reviewOffered: unknown,
): OwnerPinStatus | null {
  const pin = view?.native?.owner_pin ?? null;
  if (pin?.status === "pinned" && pin.owner_verified === true) return "pinned";
  if (pin?.status === "changed") {
    return pillReviewOffered(view, reviewOffered) ? "changed" : null;
  }
  return "unpinned";
}

/**
 * D21: the owner-device-only re-create is offered when the manager says the
 * group is stranded (`recreateAvailable`, every member wiped), or when the
 * D36 escalation of a group poisoned on the owner's device offers it, AND
 * this device signed the current seat list (re-checked here; native refuses
 * a non-signer anyway).
 * @param view The manager's channel view
 * @param self This session's user and E2EE device
 * @param escalated The D36 escalation's action is `recreate`
 */
export function pillRecreateOffered(
  view: ProtectedChannelView | null | undefined,
  self: {
    userId: string | null | undefined;
    deviceId: string | null | undefined;
  },
  escalated?: boolean,
): boolean {
  if (!view || (view.recreateAvailable !== true && escalated !== true)) {
    return false;
  }
  const list = view.native?.seat_list ?? null;
  return (
    !!self.userId &&
    !!self.deviceId &&
    list !== null &&
    list.signer_user_id === self.userId &&
    list.signer_device_id === self.deviceId
  );
}

/**
 * Whether the panel shows the details (encryption line, seats, owner pin,
 * owner actions) in this state. `not_available` on a capable device is the
 * S4 client-outdated refusal: the notice only. S5 states are reserved.
 * @param state The shield state
 */
export function pillShowsDetails(state: ProtectedShieldState): boolean {
  switch (state) {
    case "protected":
    case "resecuring":
    case "not_seated":
    case "unverified":
      return true;
    // S2 D35: read-only for this device; seat usage still explains a
    // full group and the owner keeps the owner lines.
    case "capacity":
      return true;
    case "not_available":
    case "grace":
    case "frozen":
      return false;
    default: {
      const _exhaustive: never = state;
      return false;
    }
  }
}

/**
 * S2-D38: the device-cap screen is offered only for the `capacity` state
 * with the `device_cap` reason (the shield's notice; a full group has no
 * device to sign out).
 * @param state The shield state
 * @param notice The shield's notice
 */
export function pillDeviceCapOffered(
  state: ProtectedShieldState | null | undefined,
  notice: string | null | undefined,
): boolean {
  return state === "capacity" && notice === "capacity_device_cap";
}

/**
 * S2 OR-9: the persistent owner alert native keeps on this device (kind
 * `dropped_this_device` only). Read from the view on every render; nothing
 * here can dismiss it.
 * @param view The manager's channel view
 */
export function pillOwnerAlert(
  view: ProtectedChannelView | null | undefined,
): boolean {
  const alert: unknown = view?.native?.owner_alert ?? null;
  return (
    typeof alert === "object" &&
    alert !== null &&
    (alert as { kind?: unknown }).kind === "dropped_this_device"
  );
}

/**
 * A display name fit to show: a trimmed non-empty string that is not the
 * id it names. Anything else is null (the copy then says "another device"
 * or "new members").
 * @param name The resolved name
 * @param id The id it was resolved from (compared, never returned)
 */
export function pillDisplayName(name: unknown, id: string): string | null {
  if (typeof name !== "string") return null;
  const s = name.trim();
  if (s.length === 0 || s === id.trim()) return null;
  return s;
}

/**
 * Display names for every seated user id, or null unless EVERY id resolved
 * to a real name (a partial list would read as the whole). Never an id.
 * @param ids The notice's `seated` user ids
 * @param userName Display name for a user id, or null
 */
export function pillSeatedNames(
  ids: unknown,
  userName: (userId: string) => string | null,
): string[] | null {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) return null;
    const name = pillDisplayName(userName(id), id);
    if (name === null) return null;
    out.push(name);
  }
  return out;
}

/**
 * The one-shot owner notice as display values for `ownerNoticeCopy`:
 * `device` is the other device's session name from this account's own
 * listing, `names` the seated users' display names; ids never leave here.
 * A `dropped_this_device` notice is not repeated while the alert shows it.
 * @param notice `view.ownerNotice`
 * @param ctx Channel display name, resolvers and whether the alert shows
 */
export function pillOwnerNoticeDisplay(
  notice: OwnerDeviceNotice | null | undefined,
  ctx: {
    channel: string | null;
    alertShown: boolean;
    deviceName: (deviceId: string) => string | null;
    userName: (userId: string) => string | null;
  },
): OwnerNoticeDisplay | null {
  if (typeof notice !== "object" || notice === null) return null;
  const deviceId =
    typeof notice.device_id === "string" ? notice.device_id : null;
  const device = () =>
    deviceId === null || deviceId.length === 0
      ? null
      : pillDisplayName(ctx.deviceName(deviceId), deviceId);
  const kind = notice.kind;
  switch (kind) {
    case "dropped_this_device":
      return ctx.alertShown ? null : { kind, channel: ctx.channel };
    case "changed_by_other":
      return { kind, device: device() };
    case "seated_by_other":
      return {
        kind,
        device: device(),
        names: pillSeatedNames(notice.seated, ctx.userName),
      };
    default: {
      const _exhaustive: never = kind;
      return null;
    }
  }
}

/**
 * The 9.2 copy for a lost owner signing device (`serverGroup.signer_lost`),
 * shown from the start (no timer); null without one or for an unknown
 * cause.
 * @param view The manager's channel view
 */
export function pillSignerLost(
  view: ProtectedChannelView | null | undefined,
): "owner_device_lost" | "owner_account_unavailable" | null {
  const lost: unknown = view?.serverGroup?.signer_lost ?? null;
  if (typeof lost !== "object" || lost === null) return null;
  const cause = (lost as { cause?: unknown }).cause;
  if (cause === "device_revoked") return "owner_device_lost";
  if (cause === "account_unavailable") return "owner_account_unavailable";
  return null;
}

/**
 * S2 (design 6.3): "Recover ownership on this device" only when the owner's
 * signing device was signed out (`signer_lost`, cause `device_revoked`),
 * this user IS that owner, and this is ANOTHER device (never the lost one).
 * Mirrors the manager's own check; native's dialog decides.
 * @param view The manager's channel view
 * @param self This session's user and E2EE device
 */
export function pillRecoverOffered(
  view: ProtectedChannelView | null | undefined,
  self: {
    userId: string | null | undefined;
    deviceId: string | null | undefined;
  },
): boolean {
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

/** What a long re-securing adds to the panel (D36); amber only. */
export type PillEscalation = {
  note: "slow" | "waiting_owner" | null;
  action: "retry_removal" | "rejoin" | "recreate" | null;
};

/**
 * S2-D36: the amber wording and the one action for an ESCALATED
 * re-securing, only while the shield is `resecuring`. It never changes the
 * state. A lost owner device is shown from the start by the signer-lost
 * line and the recover button, so it adds nothing here; waiting for a
 * member and "other" just go static.
 * @param state The shield state
 * @param r `resecureCause(ui.resecureInputs(id), now)`, or null
 */
export function pillEscalation(
  state: ProtectedShieldState | null | undefined,
  r: ResecureEscalation | null | undefined,
): PillEscalation {
  const none: PillEscalation = { note: null, action: null };
  if (state !== "resecuring" || !r || r.escalated !== true) return none;
  const cause = r.cause;
  switch (cause) {
    case "pending_removal":
      return {
        note: "slow",
        action: r.action === "retry_removal" ? "retry_removal" : null,
      };
    case "stale_group":
      return { note: "slow", action: r.action === "rejoin" ? "rejoin" : null };
    case "poisoned_owner":
      return {
        note: "slow",
        action: r.action === "recreate" ? "recreate" : null,
      };
    case "poisoned_member":
      return { note: "waiting_owner", action: null };
    case "owner_device_lost":
    case "owner_account_unavailable":
    case "waiting_for_member":
    case "other":
      return none;
    default: {
      const _exhaustive: never = cause;
      return none;
    }
  }
}

/**
 * D14 text tint: the state hue mixed 70% into the surface text color.
 * @param hueVar CSS variable NAME from `shieldPresentation`
 */
export function protectedTintColor(hueVar: string): string {
  return `color-mix(in srgb, var(${hueVar}) 70%, var(--md-sys-color-on-surface))`;
}

/**
 * D14 channel-name tint for the header (no unread state there, so the
 * state's `tintName` alone decides; never while re-securing, choice 5).
 * Undefined for a channel without a shield, so its header is unchanged.
 * @param state The shield state, or null without a shield
 */
export function protectedHeaderNameStyle(
  state: ProtectedShieldState | null | undefined,
): { color: string } | undefined {
  if (!state) return undefined;
  const p = shieldPresentation(state);
  return p.tintName ? { color: protectedTintColor(p.hueVar) } : undefined;
}

// --- pure: end

type PillOp = "recreate" | "recover";

interface Props {
  channel: Channel;
}

export function ProtectedChannelPill(props: Props) {
  const client = useClient();
  const { t } = useLingui();
  const shield = useProtectedShield(() => props.channel.id);
  const windowCtxId = useWindowCtx().id;
  const { openModal } = useModals();

  // Kept by the pill (the panel unmounts on close) and keyed by channel, so
  // a result never shows on another channel's header.
  const [busy, setBusy] = createSignal<{
    channelId: string;
    op: PillOp;
  } | null>(null);
  const [failure, setFailure] = createSignal<{
    channelId: string;
    text: string;
  } | null>(null);

  createEffect(
    on(
      () => props.channel.id,
      () => setFailure(null),
    ),
  );

  const ui = (): ProtectedUiApi | null => protectedUiOf(client()?.e2ee);

  const presentation = () => {
    const s = shield();
    return s
      ? shieldPresentation(s.state, {
          tauriE2eeOff: s.notice === "enable_e2ee",
        })
      : null;
  };

  /** The most specific notice for the state (explainShield), else A2's. */
  const notice = () => shield()?.notice ?? presentation()?.notice ?? null;

  /**
   * Non-throwing reads for the panel: it renders under the floating
   * manager, outside this Show, so it never reads the Show's narrowed
   * accessor (a stale read throws). The fallback only covers the instant
   * before the pill unmounts and is the fail-closed state.
   */
  const stateNow = () => shield()?.state ?? "unverified";
  const pillHue = () =>
    `var(${presentation()?.hueVar ?? "--sloga-protected-alert"})`;
  const tauriE2eeOff = () => shield()?.notice === "enable_e2ee";

  /** Full panel only where the text plane runs (D3); else explain only. */
  const full = () => shield()?.capable === true;
  /** And only in a state with details (not the client-outdated refusal). */
  const details = () => full() && pillShowsDetails(stateNow());

  /** The channel's display name for the copy; never its id. */
  const channelName = () => props.channel.name ?? null;

  const view = () => shield()?.view ?? null;
  const selfIds = () => ({
    userId: client()?.user?.id,
    deviceId: (client()?.e2ee as E2EEBridge | undefined)?.status.get("state")
      ?.device_id,
  });
  const reviewable = () =>
    full() && pillReviewOffered(view(), shield()?.reviewOffered);
  const ownerPin = () => pillOwnerPin(view(), shield()?.reviewOffered);
  const seats = () => {
    const api = ui();
    if (!api || typeof api.seatsSnapshot !== "function") return null;
    return pillSeats(api.seatsSnapshot(props.channel.id));
  };

  // S2-D36: the re-securing cause, re-evaluated when its escalation is due.
  // Only while the shield is `resecuring`; a throwing or absent bridge
  // read is "unknown" (no escalation).
  const [tick, setTick] = createSignal(Date.now());
  const resecure = createMemo((): ResecureEscalation | null => {
    if (stateNow() !== "resecuring") return null;
    const api = ui();
    if (!api || typeof api.resecureInputs !== "function") return null;
    let inputs: ReturnType<ProtectedUiApi["resecureInputs"]>;
    try {
      inputs = api.resecureInputs(props.channel.id);
    } catch {
      return null;
    }
    if (!inputs) return null;
    return resecureCause(inputs, Math.max(tick(), Date.now()));
  });
  createEffect(() => {
    const r = resecure();
    if (!r || r.escalated || r.escalateAtMs === null) return;
    const wait = Math.max(0, r.escalateAtMs - Date.now());
    const timer = setTimeout(() => setTick(Date.now()), wait + 1);
    onCleanup(() => clearTimeout(timer));
  });
  const escalation = () => pillEscalation(stateNow(), resecure());

  const recreateOffered = () =>
    full() &&
    pillRecreateOffered(view(), selfIds(), escalation().action === "recreate");
  const recoverOffered = () => full() && pillRecoverOffered(view(), selfIds());
  const signerLost = () => pillSignerLost(view());

  /**
   * "Retry removal" / "Rejoin" run one manual refresh (`retryNow`) that
   * retries the removal or the join. Kept to the window that runs the open
   * lifecycle, as before (the device-cap screen shares the gate).
   */
  const retryAllowed = () =>
    shouldRunOpenLifecycle({
      windowCtxId,
      channelType: props.channel.type,
      protectedOrPinned: true,
    });
  const retryAction = () => {
    const a = escalation().action;
    return (a === "retry_removal" || a === "rejoin") && retryAllowed()
      ? a
      : null;
  };

  /**
   * S2-D38: "Your devices" opens the device-cap screen, only from the pill
   * of the channel open in this window (the screen's "Try again" re-runs
   * that channel's open).
   */
  const deviceCapOffered = () =>
    full() &&
    retryAllowed() &&
    pillDeviceCapOffered(stateNow(), shield()?.notice);
  function openDeviceCap() {
    // L9: protected_device_cap (union member not registered yet; drop the
    // cast once `components/modal/types.ts` has it).
    openModal({
      type: "protected_device_cap",
      channel: props.channel,
    } as unknown as ModalRequest);
  }

  /**
   * S2 D41: "Review owner change" opens the owner-review screen (it runs
   * `confirmOwnerChange` and the native dialog); the pill never calls the
   * bridge for it. Only behind `reviewable()`.
   */
  function openOwnerReview() {
    // L9: protected_owner_review (union member not registered yet; drop the
    // cast once `components/modal/types.ts` has it).
    openModal({
      type: "protected_owner_review",
      channel: props.channel,
    } as unknown as ModalRequest);
  }

  /** S2 OR-9: the persistent alert; never dismissed by the pill. */
  const ownerAlert = () => pillOwnerAlert(view());

  // The other device's session NAME for an owner notice: this account's own
  // listing, read once per notice device (ids only for the lookup).
  const noticeDeviceId = createMemo((): string | null => {
    const n = view()?.ownerNotice ?? null;
    if (!n || n.kind === "dropped_this_device") return null;
    return typeof n.device_id === "string" && n.device_id.length > 0
      ? n.device_id
      : null;
  });
  const [ownDevice, setOwnDevice] = createSignal<{
    deviceId: string;
    name: string | null;
  } | null>(null);
  createEffect(
    on(noticeDeviceId, (deviceId) => {
      if (deviceId === null) return;
      const e2ee = client()?.e2ee as E2EEBridge | undefined;
      if (!e2ee || typeof e2ee.listOwnDevices !== "function") return;
      const channelId = props.channel.id;
      let live = true;
      onCleanup(() => {
        live = false;
      });
      e2ee.listOwnDevices().then(
        (devices) => {
          if (!live) return;
          const row = devices.find((d) => d.deviceId === deviceId);
          setOwnDevice({ deviceId, name: row?.sessionName ?? null });
        },
        () => {
          // The copy falls back to "another device"; ids only in the log.
          console.warn("[protected] own device listing failed", { channelId });
        },
      );
    }),
  );
  const deviceName = (deviceId: string): string | null => {
    const d = ownDevice();
    return d !== null && d.deviceId === deviceId ? d.name : null;
  };

  /** A server member's display name, else the user's; null when unknown. */
  const userName = (userId: string): string | null => {
    const c = client();
    if (!c) return null;
    const serverId = props.channel.server?.id;
    const member = serverId
      ? c.serverMembers.getByKey({ server: serverId, user: userId })
      : undefined;
    return member?.displayName ?? c.users.get(userId)?.displayName ?? null;
  };

  const ownerNoticeText = () => {
    const display = pillOwnerNoticeDisplay(view()?.ownerNotice, {
      channel: channelName(),
      alertShown: ownerAlert(),
      deviceName,
      userName,
    });
    return display === null ? null : ownerNoticeCopy(display);
  };

  /** D36 amber wording for an escalated re-securing. */
  const escalationText = () => {
    const note = escalation().note;
    switch (note) {
      case null:
        return null;
      case "slow":
        return t`Re-securing is taking longer than usual.`;
      case "waiting_owner": {
        const ownerId = props.channel.server?.ownerId;
        const owner = ownerId
          ? pillDisplayName(userName(ownerId), ownerId)
          : null;
        return owner === null
          ? t`Waiting for the channel owner…`
          : t`Waiting for ${owner}…`;
      }
      default: {
        const _exhaustive: never = note;
        return null;
      }
    }
  };

  const busyOp = () => {
    const b = busy();
    return b && b.channelId === props.channel.id ? b.op : null;
  };
  const failureText = () => {
    const f = failure();
    return f && f.channelId === props.channel.id ? f.text : null;
  };

  /**
   * Runs one owner action from its button click. Errors surface in the
   * panel through A2 + C0 (never `error.message`); native `declined` (the
   * user cancelled the dialog) maps to no copy and stays silent.
   */
  async function run(op: PillOp) {
    if (busy()) return;
    const channelId = props.channel.id;
    const api = ui();
    let action: ((channelId: string) => Promise<void>) | undefined;
    switch (op) {
      case "recreate":
        action = api?.recreateGroup;
        break;
      case "recover":
        action = api?.recoverOwnership;
        break;
      default: {
        const _exhaustive: never = op;
        action = undefined;
      }
    }
    setFailure(null);
    if (!api || typeof action !== "function") {
      setFailure({
        channelId,
        text: noticeCopy(tauriE2eeOff() ? "enable_e2ee" : "not_available"),
      });
      return;
    }
    setBusy({ channelId, op });
    try {
      await action.call(api, channelId);
    } catch (error) {
      const answer = protectedNoticeForError(error, { op: "owner" });
      const text = errorUiCopy(answer);
      if (text) {
        console.error("[protected] owner action failed", {
          channelId,
          op,
          type: answer.tag,
        });
        setFailure({ channelId, text });
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * D36 "Retry removal" / "Rejoin": no dialog and nothing signed; ONE
   * manual refresh (`retryNow`, never the open's 60 s loop) retries the
   * removal or the join. A missing bridge surface says so.
   */
  function retry() {
    const channelId = props.channel.id;
    const api = ui();
    setFailure(null);
    if (!api || typeof api.retryNow !== "function") {
      setFailure({
        channelId,
        text: noticeCopy(tauriE2eeOff() ? "enable_e2ee" : "not_available"),
      });
      return;
    }
    try {
      api.retryNow(channelId);
    } catch {
      console.error("[protected] retry failed", { channelId });
      setFailure({
        channelId,
        text: noticeCopy("protected_channels_unavailable"),
      });
    }
  }

  const seatsLine = (s: { used: number; cap: number | null }) => {
    if (s.cap !== null) return panelCopy.seatsUsed(s.used, s.cap);
    const used = s.used;
    // Local msgid for C16: the cap is unknown (null), so no "of {cap}".
    return t`Seats used: ${used}`;
  };

  return (
    <Show when={shield()}>
      {/* A NATIVE button: Solid applies `use:floating` only to native
          elements. On a styled() component it becomes a dead
          "use:floating" prop and the panel never opens. */}
      <button
        class={pillClass}
        type="button"
        aria-haspopup="dialog"
        data-protected-pill={stateNow()}
        data-protected-owner-alert={ownerAlert() ? "" : undefined}
        style={{ "--protected-pill-hue": pillHue() }}
        use:floating={{
          contextMenu: () => (
            <Panel
              role="dialog"
              aria-label={panelCopy.pill()}
              // The floating manager closes on any document mousedown or
              // click; keep the panel open for clicks inside it, so an
              // action's progress and error stay visible.
              onMouseDown={(e) => e.stopImmediatePropagation()}
              onClick={(e) => e.stopImmediatePropagation()}
            >
              <PanelState>
                <ProtectedShieldIcon
                  state={stateNow()}
                  tauriE2eeOff={tauriE2eeOff()}
                  size={20}
                />
                <span>{panelCopy.status(shieldLabel(stateNow()))}</span>
              </PanelState>
              <Show when={ownerAlert()}>
                <PanelAlert role="alert">
                  {ownerNoticeCopy({
                    kind: "dropped_this_device",
                    channel: channelName(),
                  })}
                </PanelAlert>
              </Show>
              <Show when={notice()}>
                {(kind) => (
                  <PanelNote>
                    {noticeCopy(kind(), null, null, channelName())}
                  </PanelNote>
                )}
              </Show>
              <Show when={escalationText()}>
                {(text) => <PanelEscalation>{text()}</PanelEscalation>}
              </Show>
              <Show when={ownerNoticeText()}>
                {(text) => <PanelNote>{text()}</PanelNote>}
              </Show>
              <Show when={details()}>
                <PanelLine>{panelCopy.encrypted()}</PanelLine>
                <Show when={seats()}>
                  {(seat) => <PanelLine>{seatsLine(seat())}</PanelLine>}
                </Show>
                <Show when={ownerPin()}>
                  {(pin) => <PanelLine>{panelCopy.ownerPin(pin())}</PanelLine>}
                </Show>
                <Show when={deviceCapOffered()}>
                  <PanelAction type="button" onClick={() => openDeviceCap()}>
                    {t`Your devices`}
                  </PanelAction>
                </Show>
                <Show when={signerLost()}>
                  {(kind) => <PanelNote>{noticeCopy(kind())}</PanelNote>}
                </Show>
                <Show when={recoverOffered()}>
                  <PanelAction
                    type="button"
                    disabled={busyOp() !== null}
                    onClick={() => void run("recover")}
                  >
                    {panelCopy.recoverOwnership()}
                  </PanelAction>
                </Show>
                <Show when={retryAction()}>
                  {(action) => (
                    <PanelAction
                      type="button"
                      disabled={busyOp() !== null}
                      onClick={() => retry()}
                    >
                      {action() === "rejoin" ? t`Rejoin` : t`Retry removal`}
                    </PanelAction>
                  )}
                </Show>
                <Show when={reviewable()}>
                  <PanelAction
                    type="button"
                    disabled={busyOp() !== null}
                    onClick={() => openOwnerReview()}
                  >
                    {panelCopy.reviewOwnerChange()}
                  </PanelAction>
                </Show>
                <Show when={recreateOffered()}>
                  {/* The hint explains a stranded group only (not D36). */}
                  {view()?.recreateAvailable === true && (
                    <PanelNote>{panelCopy.recreateGroupHint()}</PanelNote>
                  )}
                  <PanelAction
                    type="button"
                    disabled={busyOp() !== null}
                    onClick={() => void run("recreate")}
                  >
                    {busyOp() === "recreate"
                      ? panelCopy.recreatingGroup()
                      : panelCopy.recreateGroup()}
                  </PanelAction>
                </Show>
              </Show>
              <Show when={failureText()}>
                {(text) => <PanelError role="alert">{text()}</PanelError>}
              </Show>
            </Panel>
          ),
          contextMenuHandler: "click",
        }}
      >
        {shieldLabel(stateNow())}
        <Show when={ownerAlert()}>
          <span class={alertDotClass} aria-hidden="true" />
        </Show>
      </button>
    </Show>
  );
}

/**
 * State-colored pill (a class for a native button, see the render); the hue
 * arrives as `--protected-pill-hue`. Static: no animation, no transition
 * (D14).
 */
const pillClass = css({
  display: "inline-block",
  flexShrink: 0,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  marginInlineStart: "var(--gap-md)",
  padding: "2px var(--gap-md)",
  borderRadius: "var(--borderRadius-full)",
  border:
    "1px solid color-mix(in srgb, var(--protected-pill-hue) 45%, transparent)",
  background: "color-mix(in srgb, var(--protected-pill-hue) 14%, transparent)",
  color:
    "color-mix(in srgb, var(--protected-pill-hue) 70%, var(--md-sys-color-on-surface))",
  fontSize: "0.75rem",
  fontWeight: 600,
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  cursor: "pointer",
  animation: "none",
  transition: "none",
  // A narrow phone header shrinks the pill before the header icons.
  _phone: {
    flexShrink: 1,
  },
});

/** S2 OR-9: the owner-alert mark on the pill (the panel holds the text). */
const alertDotClass = css({
  display: "inline-block",
  width: "6px",
  height: "6px",
  marginInlineStart: "var(--gap-sm)",
  verticalAlign: "middle",
  borderRadius: "var(--borderRadius-full)",
  background: "var(--sloga-protected-alert)",
});

const Panel = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    minWidth: "240px",
    maxWidth: "320px",
    padding: "var(--gap-lg)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    boxShadow: "0 0 3px var(--md-sys-color-shadow)",
    fontSize: "0.875rem",
    lineHeight: 1.4,
  },
});

const PanelState = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    fontWeight: 600,
  },
});

const PanelLine = styled("div", {
  base: {},
});

const PanelNote = styled("div", {
  base: {
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/** S2 OR-9: persistent owner alert; no close control by design. */
const PanelAlert = styled("div", {
  base: {
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    borderInlineStart: "3px solid var(--sloga-protected-alert)",
    background:
      "color-mix(in srgb, var(--sloga-protected-alert) 12%, transparent)",
    color:
      "color-mix(in srgb, var(--sloga-protected-alert) 70%, var(--md-sys-color-on-surface))",
    fontWeight: 600,
  },
});

/** S2-D36 escalation wording: static amber, never the alert hue. */
const PanelEscalation = styled("div", {
  base: {
    color:
      "color-mix(in srgb, var(--sloga-protected-resecuring) 70%, var(--md-sys-color-on-surface))",
  },
});

const PanelError = styled("div", {
  base: {
    color: "var(--md-sys-color-error)",
  },
});

const PanelAction = styled("button", {
  base: {
    alignSelf: "flex-start",
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    border: "none",
    background: "var(--md-sys-color-secondary-container)",
    color: "var(--md-sys-color-on-secondary-container)",
    fontWeight: 600,
    cursor: "pointer",
    "&:disabled": {
      opacity: 0.6,
      cursor: "default",
    },
  },
});

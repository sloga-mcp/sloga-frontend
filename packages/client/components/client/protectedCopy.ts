/**
 * Protected channel copy (W4 lane C0).
 *
 * Every W4 user-facing string lives here, so UI lanes never mint their own
 * msgids. Each kind union from `protectedShield.ts` / `protectedTextTypes.ts`
 * is mapped exhaustively (`const _exhaustive: never`): a new kind fails tsc
 * here until it has copy.
 *
 * Strings use `t` from `@lingui/core/macro`, the precedent for non-component
 * code (`rtc/state.tsx`; see the `corePackage` note in `lingui.config.ts`),
 * so these plain functions work from workers, toasts and classes as well as
 * from JSX. Call them when rendering, never at module scope: the macro reads
 * the active locale at call time. Solid does not track it, so a locale switch
 * shows on the caller's next render.
 *
 * Copy follows the design 9.2 suggestions where one exists. Naming rule:
 * never "Protected" alone as a noun, always "Protected channel(s)". The only
 * values interpolated are display names, channel names and session names
 * (all from the caller) and counts; never ids, key material or message text.
 *
 * The macro cannot run outside the build. `protectedCopy.test.ts` loads this
 * file with a stand-in `t` (a module hook) and checks the decisions made
 * here (which copy a failure gets, which values fill it), not the catalog.
 * The error and state mapping it renders is spec'd in `protectedShield.test.ts`.
 */
import { t } from "@lingui/core/macro";

import type {
  AUDIT_LOG_REASON_MAX_CHARS,
  BAN_REASON_MAX_CHARS,
  RemovalReasonProblem,
} from "./protectedRemovalReasonPolicy";
import type {
  ProtectedErrorUi,
  ProtectedNoticeKind,
  ProtectedShieldState,
} from "./protectedShield";
import type {
  HistoryStop,
  OwnerNoticeKind,
  OwnerPinStatus,
  PreHistorySetting,
  ProtectedMarkerKind,
  ProtectedToastKind,
  TimelineMarker,
} from "./protectedTextTypes";

// ---------------------------------------------------------------------------
// Shared strings (one msgid each, reused by several exports below)
// ---------------------------------------------------------------------------

/** "Protected channel": shield label, pill, settings tab and page title. */
function protectedChannelCopy(): string {
  return t`Protected channel`;
}

/** Seat usage line: the settings page and the pill panel. */
function seatsUsedCopy(used: number, cap: number): string {
  return t`Seats used: ${used} of ${cap}`;
}

/** Design 9.2 catch-all, also the generic `unverified` notice. */
function verifyChannelFailedCopy(): string {
  return t`Something went wrong verifying this channel.`;
}

/** Marker `error`, also the marker fallback. */
function verifyMessageFailedCopy(): string {
  return t`Something went wrong verifying this message.`;
}

/**
 * Marker `sent_before_join`, also the history floor of a walk that stopped
 * `missing` or `genesis` (S4, design 9.2).
 */
function sentBeforeJoinCopy(): string {
  return t`Sent before this device joined.`;
}

/** `messageCopy.senderNotVerified`, also row note `sender_unverified`. */
function senderNotVerifiedCopy(): string {
  return t`The sender's device isn't verified on this device yet.`;
}

/** Label `unverified`, also the label fallback. */
function unverifiedLabelCopy(): string {
  return t({
    message: "Verification failed",
    comment: "Protected channel state",
  });
}

/** Owner pin `unpinned`, also the owner-pin fallback. */
function ownerPinUnverifiedCopy(): string {
  return t`The owner's device isn't verified on this device yet.`;
}

/** Notices `channel_full` and S2 `capacity_group_full` (design 9.2). */
function channelFullCopy(): string {
  return t`This protected channel is full.`;
}

/**
 * A seat publish is unresolved (D7): the settings page line and the S2
 * `publish_in_flight` client refusal.
 */
function publishInFlightCopy(): string {
  return t`Saving the member list. You can make more changes when this finishes.`;
}

/** A caller-supplied name, trimmed; null when absent or blank. */
function displayName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const s = name.trim();
  return s.length === 0 ? null : s;
}

/**
 * S2 alert `owner_device_dropped` (the `dropped_this_device` owner alert or
 * notice). `channelName` is the channel's display name, never its id.
 */
function ownerDeviceDroppedCopy(channelName: string | null): string {
  const channel = displayName(channelName);
  return channel === null
    ? t`This device can no longer sign this channel's member list. If you didn't do this, secure your account.`
    : t`This device can no longer sign #${channel}'s member list. If you didn't do this, secure your account.`;
}

// ---------------------------------------------------------------------------
// Channel notices (design 9.2, plan D17; `ProtectedNoticeKind` from A2)
// ---------------------------------------------------------------------------

/** Most display names a removed-users line lists inline. */
export const REMOVED_NAMES_LISTED_MAX = 5;

// `seat_list_names_removed_users` (W2 C1): the signed list still names users
// whose seat is no longer active. The refusal doesn't say why the seat went
// (server_removal, access_lost, device_never_joined; owner_unseat too, should
// a stale list name one), so the copy says only what holds for every release
// cause: they no longer have a seat. Never "removed from this server".

/**
 * The owner page's note over those users (`SeatList`, via `noticeCopy`).
 * Nothing failed: the page leaves them off every list it submits.
 */
function removedUsersNoteCopy(): string {
  return t`Some members no longer have a seat. They'll be left off the next seat list you save.`;
}

/**
 * A seat list PUT refused `SeatListNamesRemovedUsers`: nothing was saved
 * (also `errors.ts`).
 */
function removedUsersRefusedCopy(): string {
  return t`The seat list wasn't saved because it includes members who no longer have a seat.`;
}

/**
 * The refusal, naming the users only when the caller resolved every one of
 * them (a partial list would read as the whole) and there are few enough
 * to show (`namedList`); otherwise the generic refusal.
 */
function removedUsersRefusedNamedCopy(names: readonly string[] | null): string {
  const list = namedList(names);
  if (list === null) return removedUsersRefusedCopy();
  return t`The seat list wasn't saved because it includes members who no longer have a seat: ${list}`;
}

/**
 * FXP F-L6: the poisoned-group notice on a device holding no group of the
 * channel (`ctx.signingDevice === "no_group"`, signer or not): native
 * refused the group it was invited to (a leaf failed its checks, or a
 * Welcome or join step was refused), so it holds none and reads nothing.
 * It promises no retry and no owner action: a rejoin is paced and needs
 * the refused device gone, and none may ever come.
 */
function noGroupRefusedCopy(): string {
  return t`This channel's protected group failed a security check on this device, so this device hasn't joined it and can't read new messages here.`;
}

/**
 * Notice text for a channel-level kind. `max` is `ProtectedErrorUi.max`
 * (seat or device cap); null or absent falls back to copy without a count.
 * `_names` is ignored by every kind: the refusal that names users is
 * `errorUiCopy`'s, and the slot stays so positional callers keep
 * `channelName`. `channelName`: the channel's display name for
 * `capacity_device_cap` and `owner_device_dropped` (never its id); null or
 * blank reads "this channel". `ctx.signingDevice` (FXT2): this device signs
 * the channel's member list, so a poisoned group (`invalid_change`,
 * `replayed_change`) re-secures here on its own; absent or false is any
 * other device (the owner has to act). FXP F-L6: `"no_group"` is any device
 * holding no group (its own join was refused): it is never told to wait for
 * the owner, nor that it re-secures (`noGroupRefusedCopy`).
 */
export function noticeCopy(
  kind: ProtectedNoticeKind,
  max: number | null = null,
  _names: readonly string[] | null = null,
  channelName: string | null = null,
  ctx: { signingDevice?: boolean | "no_group" } = {},
): string {
  switch (kind) {
    // shield states
    case "resecuring":
      return t`Re-securing this channel…`;
    case "not_seated":
      return t`You don't have a seat in this protected channel. Ask the owner for a seat.`;
    case "not_available":
      return t`Protected channels aren't available here yet. They work in the main window of the Sloga app for Windows, Linux and Android.`;
    case "enable_e2ee":
      return t`Turn on end-to-end encryption on this device to use Protected channels.`;
    case "unverified":
      return verifyChannelFailedCopy();
    // S2 shield causes (D35, OR-4, 6d)
    case "capacity_device_cap": {
      const channel = displayName(channelName);
      return channel === null
        ? t`This device can't open this channel yet.`
        : t`This device can't open #${channel} yet.`;
    }
    case "capacity_group_full":
      return channelFullCopy();
    case "client_outdated":
      return t`Update Sloga to use this protected channel.`;
    case "waiting_for_member":
      return t`Waiting for a member to come online…`;
    // S2 owner signing device (9.2, OR-10)
    case "owner_device_lost":
      return t`The owner's signing device was signed out. Messages are paused until the owner signs in on another device.`;
    case "owner_account_unavailable":
      return t`The owner's account is unavailable. Messages are paused.`;
    case "owner_device_dropped":
      return ownerDeviceDroppedCopy(channelName);
    case "owner_changed_unlisted":
      return t`Your other device isn't on this channel's list of signing devices, so it can't take over. Sign from a listed device to add it.`;
    case "revoked_owner_devices":
      return t`A device that could sign this channel's member list was signed out or changed its key. Re-sign your signing devices.`;
    // specific `unverified` causes
    case "flag_stripped":
      return t`The server stopped marking this channel as protected. This device still treats it as a protected channel and won't send unencrypted messages here.`;
    case "seat_list_failed":
      return t`This channel's member list failed verification.`;
    case "off_list_member":
      return t`Someone in this channel isn't on the owner's member list.`;
    // F-L13 / FXT2: the poisoned-group state (shield step 3). Only the
    // device that signs the member list makes the successor group, and
    // automatically only when the group failed on THAT device (D21). On it
    // (`ctx.signingDevice`) the old re-securing line is true; anywhere else
    // nothing re-secures on its own: the owner has to re-create the group.
    // An operation refusal with these kinds reads `errorUiCopy`'s line.
    // FXP F-L6: a device holding no group has no owner to wait for and
    // nothing re-secures: it reads that the group failed its check.
    case "invalid_change":
      if (ctx.signingDevice === "no_group") return noGroupRefusedCopy();
      return ctx.signingDevice === true
        ? t`A member made an invalid change to this channel. Re-securing with a new group…`
        : t`A member made an invalid change to this channel, so this device can't read new messages here. The channel owner has to re-create the protected group from their device; that doesn't happen automatically.`;
    case "replayed_change":
      if (ctx.signingDevice === "no_group") return noGroupRefusedCopy();
      return ctx.signingDevice === true
        ? t`This channel received a replayed membership change. Re-securing with a new group…`
        : t`This channel received a replayed membership change, so this device can't read new messages here. The channel owner has to re-create the protected group from their device; that doesn't happen automatically.`;
    case "security_check_failed":
      return t`This channel's security check failed.`;
    case "owner_changed_review":
      return t`The owner of this channel is now signing from a different device.`;
    case "owner_changed_locked":
      return t`This channel's member list is now signed by a different person. This is not allowed and the channel has been locked.`;
    case "join_stalled":
      return t`This device couldn't finish joining this protected channel. Try opening the channel again later.`;
    // flows
    case "channel_full":
      return channelFullCopy();
    case "seat_cap_reached":
      return max === null
        ? t`All seats are in use. Released seats count for 14 days.`
        : t`All ${max} seats are in use. Released seats count for 14 days.`;
    case "device_cap_reached":
      return max === null
        ? t`This member already has the maximum number of devices in this channel.`
        : t`This member already has ${max} devices in this channel.`;
    case "not_owner":
      return t`Only the channel owner's device can change seats.`;
    case "seat_list_behind":
      return t`The member list changed since you last loaded it. Reloading…`;
    case "seat_list_names_removed_users":
      // The note; a refused save reads `errorUiCopy`'s refusal instead.
      return removedUsersNoteCopy();
    case "protect_failed":
      return t`This channel couldn't be protected.`;
    case "channel_protected":
      return t`Not available in protected channels.`;
    case "ownership_transfer_blocked":
      return t`Ownership can't be transferred while this server has protected channels.`;
    case "encryption_unavailable":
      return t`Encrypted messaging is unavailable right now.`;
    case "protected_channels_unavailable":
      return t`Protected channels are unavailable right now.`;
    case "send_refused":
      return t`This message couldn't be sent securely.`;
    case "maybe_unsent":
      return t`A message may not have been sent.`;
    case "network_error":
      return t`Couldn't reach the server. Check your connection and try again.`;
    // S2 flows
    case "removal_reason_required":
      return t`This member is protected from removal without a reason. Add a reason to continue.`;
    case "resecured_too_often":
      // OR-21: an owner-op InSlowmode (sent on the successor create).
      return t`This channel was re-secured too many times today. Try again later.`;
    case "handover_target_not_joined":
      // S2-D42: native `handover_target_invalid` on "Move ownership key".
      return t`That device hasn't joined this channel yet. Open the channel on it, then try again.`;
    // S2 client failure reasons (audit LOW-3); `client_outdated` is above.
    case "recovery_unavailable":
      // `recoverOwnership` preconditions: no lost signing device of this
      // user, this is that device, or no member list held here.
      return t`Ownership can't be recovered on this device right now.`;
    case "publish_in_flight":
      return publishInFlightCopy();
    case "invalid_reason":
      // `setSeats`: the removal reason failed the header check.
      return t`This reason can't be used. Check it and try again.`;
    case "create_predecessor_unknown":
      // D21 re-run of an unaccepted create: the group it replaces is gone.
      return t`This channel's group couldn't be re-created right now. Try again later.`;
    default: {
      const _exhaustive: never = kind;
      return verifyChannelFailedCopy();
    }
  }
}

// ---------------------------------------------------------------------------
// Owner-device notices (S2, design 4.4.1 rule 9; OR-9)
// ---------------------------------------------------------------------------

/**
 * An `OwnerDeviceNotice` (view `ownerNotice`) or native `owner_alert`,
 * resolved by the caller into display values. The copy layer never takes
 * the notice itself: its `device_id` and `seated` are ids. The caller maps
 * `device_id` to that device's session name from the own device listing
 * (null when unknown or unnamed: the copy says "another device") and
 * `seated` to display names (null unless every user resolved: the copy
 * says "new members"). `channel` is the channel's display name.
 */
export type OwnerNoticeDisplay =
  | { kind: "dropped_this_device"; channel: string | null }
  | { kind: "changed_by_other"; device: string | null }
  | {
      kind: "seated_by_other";
      device: string | null;
      names: readonly string[] | null;
    };

type OwnerNoticeDisplayKey = OwnerNoticeDisplay extends infer D
  ? D extends unknown
    ? keyof D
    : never
  : never;

// Compile-time pins: every native kind has a display shape, and no display
// shape carries an id field (`device_id`, `seated`, `user_id`).
const _ownerKindsCovered: [
  Exclude<OwnerNoticeKind, OwnerNoticeDisplay["kind"]>,
] extends [never]
  ? true
  : never = true;
const _ownerNoIdFields: [
  Extract<OwnerNoticeDisplayKey, "device_id" | "seated" | "user_id">,
] extends [never]
  ? true
  : never = true;

/** Display names listed inline; null when the list can't be shown whole. */
function namedList(names: readonly string[] | null): string | null {
  const shown = (names ?? []).map((n) => n.trim());
  if (
    shown.length === 0 ||
    shown.length > REMOVED_NAMES_LISTED_MAX ||
    shown.some((n) => n.length === 0)
  ) {
    return null;
  }
  return shown.join(", ");
}

/** Banner or notice text for an owner-device notice or alert. */
export function ownerNoticeCopy(n: OwnerNoticeDisplay): string {
  switch (n.kind) {
    case "dropped_this_device":
      return ownerDeviceDroppedCopy(n.channel);
    case "changed_by_other": {
      const device = displayName(n.device);
      return device === null
        ? t`Your signing devices were changed from another device. If you didn't do this, secure your account.`
        : t`Your signing devices were changed from ${device}. If you didn't do this, secure your account.`;
    }
    case "seated_by_other": {
      const device = displayName(n.device);
      const names = namedList(n.names);
      if (device === null) {
        return names === null
          ? t`Another of your devices seated new members. If you didn't do this, secure your account.`
          : t`Another of your devices seated ${names}. If you didn't do this, secure your account.`;
      }
      return names === null
        ? t`Your other device ${device} seated new members. If you didn't do this, secure your account.`
        : t`Your other device ${device} seated ${names}. If you didn't do this, secure your account.`;
    }
    default: {
      const _exhaustive: never = n;
      return verifyChannelFailedCopy();
    }
  }
}

// ---------------------------------------------------------------------------
// Message markers (design 9.2 / 9.3; `ProtectedMarkerKind` from A1)
// ---------------------------------------------------------------------------

/** Text rendered in place of a message body. */
export function markerCopy(kind: ProtectedMarkerKind): string {
  switch (kind) {
    case "sent_before_join":
      return sentBeforeJoinCopy();
    // S4: native's own record that this device was removed (gray).
    case "removed_self":
      return t`Sent after you were removed.`;
    case "unknown_key":
      return t`Sent with a key this device never had.`;
    case "decrypt_failed":
      return t`Couldn't decrypt this message.`;
    case "unverified_sender":
      return t`Couldn't verify the sender. This message may be forged.`;
    case "removed_sender":
      return t`Sent by someone who was removed from this channel.`;
    case "replay":
      return t`Duplicate message (replayed).`;
    case "malformed":
      return t`Unreadable message.`;
    case "unencrypted_row":
      return t`Unencrypted message in a protected channel. It did not come from a member's protected app.`;
    // S3-N0 (OR-19): a newer envelope version; grey, `v` never shown.
    case "unsupported_version":
      return t`Update Sloga to see this message.`;
    case "error":
      return verifyMessageFailedCopy();
    default: {
      const _exhaustive: never = kind;
      return verifyMessageFailedCopy();
    }
  }
}

// ---------------------------------------------------------------------------
// Timeline markers (plan D22; `TimelineMarker` from A1)
// ---------------------------------------------------------------------------

/**
 * The line at the history floor, by why the walk stopped (S4; design 9.2,
 * R-W4-16). `hidden` is the gray marker, `missing` and `genesis` read as the
 * S1 marker, the rest are the loud notices. `anchor_mismatch` is a refused
 * candidate like `invalid` (a `HistoryLinkInvalid` reason), so it reads that
 * line: only `unanchored` is tried again, and only it says so. A stop this
 * build doesn't know reads the catch-all, never a quiet marker.
 */
function historyFloorCopy(stop: HistoryStop): string {
  switch (stop) {
    case "hidden":
      return t`History from before you joined isn't shared here.`;
    case "missing":
    case "genesis":
      return sentBeforeJoinCopy();
    case "invalid":
    case "anchor_mismatch":
      return t`Earlier history couldn't be verified and wasn't loaded.`;
    case "conflict":
      return t`Two different versions of this channel's earlier history were offered, so earlier history wasn't loaded.`;
    case "unanchored":
      return t`Earlier history couldn't be confirmed yet. Sloga will try again later.`;
    default: {
      const _exhaustive: never = stop;
      return verifyChannelFailedCopy();
    }
  }
}

/**
 * A local timeline line; `name` is the member's display name (a history
 * floor names no one and ignores it). `opts.historyVisible`: the channel's
 * verified history setting is `visible`, so a new device reads earlier
 * messages too (S4, design 9.5); anything but `true` keeps the S1 line.
 */
export function timelineCopy(
  m: TimelineMarker,
  name: string,
  opts: { historyVisible?: boolean } = {},
): string {
  switch (m.kind) {
    case "new_device":
      return opts.historyVisible === true
        ? t`${name} added a new device. It can read this channel's history.`
        : t`${name} added a new device.`;
    case "forced_removal":
      return t`${name} was removed by the server and can't rejoin until the owner re-seats them.`;
    case "history_floor":
      return historyFloorCopy(m.stop);
    default: {
      const _exhaustive: never = m;
      return verifyChannelFailedCopy();
    }
  }
}

// ---------------------------------------------------------------------------
// Toasts (plan D22; `ProtectedToastKind` from A1)
// ---------------------------------------------------------------------------

/** Toast text raised through `port.notify` / the `protectedToast` map. */
export function toastCopy(kind: ProtectedToastKind): string {
  switch (kind) {
    case "unsolicited_welcome":
      return t`Blocked an unexpected invitation to a protected channel.`;
    // S2 (OR-9): one-shot, carries no kind; the channel view shows which
    // notice it was (`ownerNoticeCopy`).
    case "owner_notice":
      return t`Another of your devices changed a protected channel. Open the channel to see what changed.`;
    // S4, owner-user devices only. Neither says which channel or whose
    // link: a toast carries its kind and nothing else.
    case "history_mismatch":
      return t`History keys shared for a protected channel don't match. New members may not be able to read some earlier messages.`;
    case "history_too_large":
      return t`Some earlier history in a protected channel can't be shared with new members: too many people joined or left at once.`;
    default: {
      const _exhaustive: never = kind;
      return verifyChannelFailedCopy();
    }
  }
}

// ---------------------------------------------------------------------------
// Row notes, row states and the boundary divider (S4, design 9.3 / 9.5)
// ---------------------------------------------------------------------------

/** A note under a decrypted row (`rowNotes` in `protectedShield.ts`). */
export type RowNoteKind =
  | "sender_unverified"
  | "sender_unverified_history"
  | "timing_unverified"
  | "below_boundary";

/** Note text. None of them is green: each says what could not be checked. */
export function rowNoteCopy(kind: RowNoteKind): string {
  switch (kind) {
    case "sender_unverified":
      return senderNotVerifiedCopy();
    case "sender_unverified_history":
      return t`Sender couldn't be verified (history).`;
    case "timing_unverified":
      return t`Timing of this message can't be verified.`;
    case "below_boundary":
      return t`Listed among the earlier, unprotected messages.`;
    default: {
      const _exhaustive: never = kind;
      return verifyMessageFailedCopy();
    }
  }
}

/** A row that has no body to show yet. */
export type RowStateKind = "checking";

/**
 * `checking`: a row without `encrypted` while the channel's history state
 * isn't loaded or verified (design 9.5 arm 2). The catalog's existing
 * msgid, as "Decrypting" beside it is written (R-W4-27).
 */
export function rowStateCopy(kind: RowStateKind): string {
  switch (kind) {
    case "checking":
      return t`Checking…`;
    default: {
      const _exhaustive: never = kind;
      return verifyMessageFailedCopy();
    }
  }
}

/**
 * The permanent divider at the history boundary: under the newest earlier
 * message while they are kept, at the top of the channel after a wipe. The
 * wiped line says "removed from this channel": the signed list proves the
 * owner's request, not that a server finished deleting (R-W4-36).
 */
export function dividerCopy(preHistory: PreHistorySetting): string {
  switch (preHistory) {
    case "kept":
      return t`Messages above weren't protected`;
    case "wiped":
      return t`Earlier unprotected messages were removed from this channel.`;
    default: {
      const _exhaustive: never = preHistory;
      return verifyChannelFailedCopy();
    }
  }
}

/**
 * Display names for `ProtectedErrorUi.users`, index-aligned; null (or an
 * empty string, or the id itself) for a user the caller can't name.
 */
export type RemovedUserNames = (
  userIds: readonly string[],
) => readonly (string | null)[];

/**
 * `names` only when every reported user resolved to a real display name
 * (never an id): anything less gets the generic copy.
 */
function resolvedNames(
  ui: Extract<ProtectedErrorUi, { kind: "notice" }>,
  resolve: RemovedUserNames | undefined,
): string[] | null {
  const ids = ui.users ?? [];
  if (resolve === undefined || ids.length === 0) return null;
  const names = resolve(ids);
  if (!Array.isArray(names) || names.length !== ids.length) return null;
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const n = names[i];
    if (typeof n !== "string" || n.trim().length === 0) return null;
    if (n.trim() === ids[i]) return null;
    out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client failure reasons with copy of their own (S2)
// ---------------------------------------------------------------------------

/**
 * `TextFlowFailure` client reasons the shield leaves to its catch-all (they
 * are not in `PROTECTED_CLIENT_REASONS`) but that have a plain cause and a
 * plain next step. `errorUiCopy` shows them when given `opts.failure`.
 */
export const CLIENT_REASONS_WITH_COPY = [
  "authority_needs_v2",
  // S2-D42 `moveOwnerKey` refusals, all before any dialog.
  "handover_self_target",
  "handover_target_not_own",
  "not_signing_device",
  "authority_held",
  // S4 `protect` of a channel with messages: the boundary moved five times.
  "protect_busy",
  // S4 `protect` that went through with something left out (R-W4-35, B7).
  "protected_members_pending",
  "wipe_not_done",
] as const;

export type ClientReasonWithCopy = (typeof CLIENT_REASONS_WITH_COPY)[number];

/** Text for a client failure reason in `CLIENT_REASONS_WITH_COPY`. */
export function clientReasonCopy(reason: ClientReasonWithCopy): string {
  switch (reason) {
    // `signOwnerDevices` (design 4.10): an authority rides on a v2 seat list
    // only, and no v2 list is held while `formats_v2` is off. Refused before
    // any dialog; nothing was signed. Changing the seats first does not help
    // (the next list stays v1 while the flag is off), and once the flag is
    // on this same flow moves the list to v2 itself: so, try again later.
    case "authority_needs_v2":
      return t`This channel's member list uses an older format, so its signing devices can't be changed yet. Try again later.`;
    // S2-D42 "Move ownership key": the target is this device.
    case "handover_self_target":
      return t`Choose another of your devices to move the ownership key to.`;
    // The target is not in this account's own device listing.
    case "handover_target_not_own":
      return t`You can only move the ownership key to another of your own devices.`;
    // The served list does not verify as signed by this device.
    case "not_signing_device":
      return t`Only the device that holds this channel's ownership key can move it.`;
    // A served authority names the owner devices; a handover can't qualify.
    case "authority_held":
      return t`This channel names its owner devices. Update that list to move ownership instead.`;
    // The settings page's inline error, word for word (design 9.5).
    case "protect_busy":
      return historyErrorCopy("protect_busy");
    // The settings page's own lines, word for word.
    case "protected_members_pending":
      return protectedMembersPendingCopy();
    case "wipe_not_done":
      return protectedWipeNotDoneCopy();
    default: {
      const _exhaustive: never = reason;
      return verifyChannelFailedCopy();
    }
  }
}

/** The failure's reason when it is a client failure with copy here. */
function clientReasonOf(failure: unknown): ClientReasonWithCopy | null {
  if (typeof failure !== "object" || failure === null) return null;
  const f = failure as { source?: unknown; reason?: unknown };
  if (f.source !== "client" || typeof f.reason !== "string") return null;
  return (CLIENT_REASONS_WITH_COPY as readonly string[]).includes(f.reason)
    ? (f.reason as ClientReasonWithCopy)
    : null;
}

/**
 * Text for a `protectedNoticeForError` answer; null for `none` (the bridge
 * handled it, or the user cancelled a native dialog). `ui` is always a
 * refused operation, so `seat_list_names_removed_users` reads as a refused
 * save here (not `noticeCopy`'s note); `opts.removedUserNames` lets the
 * owner UI name its users. `opts.failure` is the failure `ui` was mapped
 * from: a client reason in `CLIENT_REASONS_WITH_COPY` replaces a notice's
 * text. A marker, toast or `none` is never replaced.
 */
export function errorUiCopy(
  ui: ProtectedErrorUi,
  opts: { removedUserNames?: RemovedUserNames; failure?: unknown } = {},
): string | null {
  switch (ui.kind) {
    case "notice": {
      const reason = clientReasonOf(opts.failure);
      if (reason !== null) return clientReasonCopy(reason);
      if (ui.notice === "seat_list_names_removed_users") {
        return removedUsersRefusedNamedCopy(
          resolvedNames(ui, opts.removedUserNames),
        );
      }
      // FXT2: here these kinds are an operation's refusal (a stage or an
      // owner op native refused), which poisons nothing: no claim about
      // reading messages, no re-secure.
      if (ui.notice === "invalid_change" || ui.notice === "replayed_change") {
        return t`This change was refused because it isn't valid for this channel.`;
      }
      return noticeCopy(ui.notice, ui.max);
    }
    case "marker":
      return markerCopy(ui.marker);
    case "toast":
      return toastCopy(ui.toast);
    case "none":
      return null;
    default: {
      const _exhaustive: never = ui;
      return verifyChannelFailedCopy();
    }
  }
}

// ---------------------------------------------------------------------------
// Shield labels (plan D14)
// ---------------------------------------------------------------------------

/** Short state name for the shield tooltip and the pill panel state line. */
export function shieldLabel(state: ProtectedShieldState): string {
  switch (state) {
    case "protected":
      return protectedChannelCopy();
    case "resecuring":
      return t({ message: "Re-securing", comment: "Protected channel state" });
    case "not_seated":
      return t({ message: "Not seated", comment: "Protected channel state" });
    // S2 D35: read-only, for either reason (device cap or a full group).
    case "capacity":
      return t({ message: "At capacity", comment: "Protected channel state" });
    case "not_available":
      return t`Not available on this device`;
    case "unverified":
      return unverifiedLabelCopy();
    // S5 reserved: typed and labelled, never produced in S1.
    case "grace":
      return t({ message: "Grace period", comment: "Protected channel state" });
    case "frozen":
      return t({ message: "Frozen", comment: "Protected channel state" });
    default: {
      const _exhaustive: never = state;
      return unverifiedLabelCopy();
    }
  }
}

// ---------------------------------------------------------------------------
// Header pill and info panel (lane C3, plan D14 / D15 / D21)
// ---------------------------------------------------------------------------

export const panelCopy = {
  /** The header pill text (the pill is state-coloured, the text is fixed). */
  pill: protectedChannelCopy,
  /** Panel state line, e.g. "Status: Re-securing". */
  status: (label: string): string => t`Status: ${label}`,
  /** Panel line under the state. */
  encrypted: (): string => t`Messages are end-to-end encrypted`,
  /** Seat usage line (same string as the settings page). */
  seatsUsed: seatsUsedCopy,
  /** Owner-pin verification state line. */
  ownerPin: (status: OwnerPinStatus): string => {
    switch (status) {
      case "pinned":
        return t`The owner's device is verified on this device.`;
      case "unpinned":
        return ownerPinUnverifiedCopy();
      case "changed":
        return t`The owner's device changed. Review the change before you trust this channel.`;
      default: {
        const _exhaustive: never = status;
        return ownerPinUnverifiedCopy();
      }
    }
  },
  /** D15 button; opens the native dialog only on this click. */
  reviewOwnerChange: (): string => t`Review owner change`,
  /** S2 D41: the owner-change review was declined; the channel stays locked. */
  ownerReviewStillLocked: (): string => t`Still locked.`,
  /** S2 D41 button: reopens the review (the native dialog, as D15). */
  reviewAgain: (): string => t`Review again`,
  /** S2 D41 button. */
  leaveChannel: (): string => t`Leave channel`,
  /** S2 owner-user action while the owner's signing device is lost (D42). */
  recoverOwnership: (): string => t`Recover ownership on this device`,
  /** D21 owner-only button. */
  recreateGroup: (): string => t`Re-create the protected group`,
  /** Explains when the D21 button appears. */
  recreateGroupHint: (): string =>
    t`Every member's device lost this channel's encrypted group. Re-create it so members can join again.`,
  /** Progress while the D21 re-create runs. */
  recreatingGroup: (): string => t`Re-creating the group…`,
};

// ---------------------------------------------------------------------------
// Owner settings page (lane C11, product choice 4)
// ---------------------------------------------------------------------------

/** An owner action on the settings page that failed with a cause (S4). */
export type HistorySettingsError =
  | "protect_busy"
  | "wipe_refused"
  | "clock_behind";

/** Inline error under the protect form or the wipe action. */
function historyErrorCopy(kind: HistorySettingsError): string {
  switch (kind) {
    // Five `ProtectHistoryMoved` in a row (design 4.9 "S4").
    case "protect_busy":
      return t`This channel is too busy to protect right now. Try again in a quiet moment.`;
    // The wipe route refused; the cause is never shown.
    case "wipe_refused":
      return t`Earlier messages couldn't be deleted right now.`;
    // Native `seat_list_invalid` with reason `future_boundary`: the newest
    // message id is ahead of this device's clock. Either side can be the
    // one that is off, so the line blames neither (R-W4-36).
    case "clock_behind":
      return t`The newest message's time is ahead of this device's clock. Check the date and time settings, or try again in a few minutes.`;
    default: {
      const _exhaustive: never = kind;
      return verifyChannelFailedCopy();
    }
  }
}

/**
 * `protect` rejected `protected_members_pending` (R-W4-35): the channel is
 * protected, the picked members are not on the list. Not an error of the
 * protect itself.
 */
function protectedMembersPendingCopy(): string {
  return t`This channel is now protected, with only you in it. The members you picked weren't added yet. You can add them below.`;
}

/**
 * `protect` rejected `wipe_not_done` (audit B7): the channel is protected
 * and the earlier messages are still there. It says nothing about the
 * members or about how to delete them now: neither is known here.
 */
function protectedWipeNotDoneCopy(): string {
  return t`This channel is now protected, but the earlier messages were not deleted.`;
}

export const settingsCopy = {
  /** Settings tab label and page title. */
  title: protectedChannelCopy,
  /** Page introduction. */
  description: (): string =>
    t`Messages in a protected channel are end-to-end encrypted. Only members you give a seat can read and send messages, on devices that support Protected channels.`,
  /** Primary button on an unprotected channel. */
  protectButton: (): string => t`Protect this channel`,
  /** Confirmation title before protecting. */
  protectConfirmTitle: (): string => t`Protect this channel?`,
  /** Confirmation body: protection is one-way (plan D1). */
  protectConfirmBody: (): string =>
    t`This can't be undone. A protected channel can't go back to a normal channel.`,
  /** Progress while the protect publish is unresolved (D7). */
  protecting: (): string => t`Protecting…`,
  /** Shown to anyone but the server owner (choice 4). */
  ownerOnly: (): string =>
    t`Only the server owner can manage this protected channel.`,
  /** Seat list heading. */
  seatsHeading: (): string =>
    t({ message: "Seats", comment: "Protected channel member seats" }),
  /** Seat usage line. */
  seatsUsed: seatsUsedCopy,
  /** Device cap line (display only in S1). */
  deviceCap: (max: number): string =>
    t`Each member can use up to ${max} devices.`,
  /** Opens the seat picker. */
  addSeats: (): string => t`Add seats`,
  /** Per-row action. */
  removeSeat: (): string => t`Remove seat`,
  /** Empty seat list. */
  noSeats: (): string => t`No one has a seat yet.`,
  /** Marks the owner's own row. */
  ownerBadge: (): string =>
    t({ message: "Owner", comment: "Protected channel seat list badge" }),
  /** Shown while a seat publish is unresolved (D7: signing is refused). */
  publishInFlight: publishInFlightCopy,
  /** After a verified seat change. */
  seatsSaved: (): string => t`Seats updated.`,
  /** Overview (C13): why the voice and announcement toggles are hidden. */
  typeTogglesHidden: (): string =>
    t`Voice and announcement settings aren't available for protected channels.`,
  // S4 history (design 9.5). The wipe and the hidden-to-visible
  // confirmations are native dialogs with native text; nothing here
  // confirms either.
  /** Above the protect button of a channel that already has messages. */
  protectWithHistory: (channelName: string | null): string => {
    const channel = displayName(channelName);
    return channel === null
      ? t`Messages already in this channel stay as they are, above a line that says they weren't protected. New messages are end-to-end encrypted.`
      : t`Messages already in #${channel} stay as they are, above a line that says they weren't protected. New messages are end-to-end encrypted.`;
  },
  /**
   * On the protect form of a channel that already has messages: the order
   * of the two steps (R-W4-35).
   */
  protectOrder: (): string =>
    t`The channel is protected first, with only you in it. The members you pick are added right after.`,
  /** After a protect whose member step did not go through. */
  membersPending: protectedMembersPendingCopy,
  /** After a protect that could not do the wipe that was ticked. */
  wipeNotDone: protectedWipeNotDoneCopy,
  /** Checkbox on the protect form (off by default). */
  deleteEarlierOption: (): string => t`Also delete the earlier messages`,
  /** What a wipe does, under the checkbox and the wipe action. */
  wipeDescription: (): string =>
    t`Earlier messages and their files will be deleted from Sloga's servers. This can't be undone. Copies on people's devices, forwards, crossposts and reports may remain.`,
  /** History visibility toggle label. */
  historyToggle: (): string => t`New members can read earlier messages`,
  /** Under the toggle while history is visible. */
  historyVisibleDescription: (): string =>
    t`People who join later can read messages sent while this is on, and so can a new device of anyone in the channel. Anyone in the channel can still share what they read.`,
  /**
   * Under the toggle while history is hidden. `earlierKept`: native holds
   * a boundary with the earlier messages kept, and those stay readable to
   * everyone in the channel whatever this setting says (R-W4-36).
   */
  historyHiddenDescription: (earlierKept: boolean): string =>
    earlierKept === true
      ? t`New members only see protected messages sent after they join. Messages from before this channel was protected stay readable to everyone in it.`
      : t`New members only see messages sent after they join.`,
  /** Shown to the owner before the toggle is turned on (plan O-5). */
  historyRemovalNote: (): string =>
    t`Removing someone doesn't take back what they already read. It stays on their devices.`,
  /** Wipe action on an already protected channel. */
  wipeButton: (): string => t`Delete the earlier unprotected messages`,
  /** The server's wipe state is `requested`. */
  wipeRequested: (): string =>
    t`The earlier messages are being deleted from Sloga's servers.`,
  /**
   * The server's wipe state is `done`. `count` is the server's number,
   * shown only when it is a whole number of 0 or more.
   */
  wipeDone: (count: number | null): string =>
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0
      ? t`Earlier messages deleted from Sloga's servers: ${count}`
      : t`Earlier messages were deleted from Sloga's servers.`,
  /** Inline error for a failed protect or wipe. */
  historyError: historyErrorCopy,
  /** The view's `historyWalk` is `retry_later`. */
  historyRetryLater: (): string =>
    t`Earlier history couldn't be loaded right now. Try again later.`,
};

// ---------------------------------------------------------------------------
// Server settings "Protected channels" page: owner key (S2-D42, lane U11b)
// ---------------------------------------------------------------------------

export const ownerKeyCopy = {
  /** Shown on the signing device only; opens the device picker. */
  moveKey: (): string => t`Move ownership key to another device`,
  /** Above the picker's device list. */
  choose: (): string =>
    t`Choose the device to move this channel's ownership key to.`,
  /** A picker row whose session has no name (never its id). */
  unnamedDevice: (): string => t`Unnamed device`,
  /** Closes the picker without signing anything. */
  cancel: (): string => t`Cancel`,
  /** This user's other device signs the list: the move starts there. */
  onOtherDevice: (): string =>
    t`This channel's ownership key is on another of your devices. Open this page on that device to move it.`,
  /** A served authority names the owner devices: no handover qualifies. */
  authorityHeld: (): string => clientReasonCopy("authority_held"),
};

// ---------------------------------------------------------------------------
// Seat picker modal (lane C12)
// ---------------------------------------------------------------------------

export const seatPickerCopy = {
  /** Modal title. */
  title: (): string => t`Give seats`,
  /** Modal description (choice 4: the server validates every seat). */
  description: (): string =>
    t`Only members who can view this channel are listed. The server checks every seat when you save.`,
  /** Search field placeholder. */
  searchPlaceholder: (): string => t`Search members`,
  /** No member matched the search. */
  noResults: (): string => t`No members found.`,
  /** Remaining seats under the cap. */
  seatsLeft: (left: number): string => t`Seats left: ${left}`,
  /** Confirm button. */
  confirm: (): string => t`Save seats`,
};

// ---------------------------------------------------------------------------
// Removal reason (S2-D40; kick, ban, unseat; `protectedRemovalReasonPolicy`)
// ---------------------------------------------------------------------------

/**
 * A removal reason cap, as the policy's constants type it: the audit header
 * (kick, unseat) or a ban body. Pass the constant, never a literal.
 */
export type RemovalReasonCap =
  | typeof AUDIT_LOG_REASON_MAX_CHARS
  | typeof BAN_REASON_MAX_CHARS;

/** `validReason` or `reasonRefusal` said `too_long`. */
export function reasonTooLongCopy(cap: RemovalReasonCap): string {
  return t`Use a shorter reason (up to ${cap} characters).`;
}

/** `validReason` said `empty`: nothing left once sanitized and trimmed. */
export function reasonEmptyCopy(): string {
  return t`Add a reason to continue.`;
}

/** Text for a `RemovalReasonProblem`; `cap` is the carrier's cap. */
export function reasonProblemCopy(
  why: RemovalReasonProblem,
  cap: RemovalReasonCap,
): string {
  switch (why) {
    case "empty":
      return reasonEmptyCopy();
    case "too_long":
      return reasonTooLongCopy(cap);
    default: {
      const _exhaustive: never = why;
      return reasonEmptyCopy();
    }
  }
}

/**
 * Shown before a kick or ban is pressed when a reason is required. The rule
 * is server-wide (any protected channel), never about the member, so this
 * is not the server refusal's `removal_reason_required` notice.
 */
export function removalReasonHintCopy(): string {
  return t`This server has protected channels, so removing someone needs a reason.`;
}

// ---------------------------------------------------------------------------
// Composer (lane C4) and drafts (lane C5)
// ---------------------------------------------------------------------------

export const composerCopy = {
  /** Composer placeholder in the `protected` state. */
  placeholder: (): string => t`Message (Protected channel)`,
  /** `not_seated` composer line (design 9.1). */
  askForSeat: (): string => t`Ask the owner for a seat.`,
  /** Under the disabled composer while re-securing: the draft is kept. */
  draftKept: (): string =>
    t`Your draft stays here until the channel is secure again.`,
  /** `unverified`: the composer is hidden under the loud banner. */
  sendingBlocked: (): string =>
    t`Sending is turned off until this channel is verified again.`,
  /** D9d/D9e: files refused before any upload (attachments are S3). */
  filesRefused: (): string => t`Files can't be sent in protected channels yet.`,
};

// ---------------------------------------------------------------------------
// Messages (lane C6), search (lane C15), notifications (lane C18)
// ---------------------------------------------------------------------------

export const messageCopy = {
  /** A row whose view is still `pending`. */
  pending: (): string => t`Decrypting…`,
  /** Informational: the view's `tsSkew` (design 9.2 `ts_skew`). */
  tsSkew: (): string => t`Sent time doesn't match.`,
  /** The view's `senderVerified` is false. */
  senderNotVerified: senderNotVerifiedCopy,
  /**
   * S2 (OR-20): an `ok` view with `filesUnsupported > 0`. No count and no
   * file names (S3 renders files); shown only when the count is above 0.
   */
  filesUnsupported: (): string =>
    t`This message has attachments. Update Sloga to see them.`,
};

export const searchCopy = {
  /** C15: text search can't read protected messages. */
  textSearchUnavailable: (): string =>
    t`Search can't look inside protected channel messages.`,
};

export const notificationCopy = {
  /** D25: a notification body for a protected row (never its text). */
  body: (): string => t`New message`,
};

// ---------------------------------------------------------------------------
// Key backup: the protected channel section (S4, design 8.5 / 9.5; R-W4-12)
// ---------------------------------------------------------------------------

/**
 * What a backup or a restore left out of the protected channel history.
 * `oldest` / `all`: the bundle's or report's `text_truncated`.
 * `skipped_partial` / `skipped_all`: the report's `text_skipped`, with and
 * without `text_truncated` beside it.
 */
export type BackupTextKind =
  | "oldest"
  | "all"
  | "skipped_partial"
  | "skipped_all";

/** A neutral line for the backup page; it never counts anything. */
export function backupTextCopy(kind: BackupTextKind): string {
  switch (kind) {
    case "oldest":
      return t`The oldest history from your protected channels didn't fit in this backup.`;
    case "all":
      return t`History from your protected channels didn't fit in this backup.`;
    case "skipped_partial":
      return t`Some history from your protected channels couldn't be restored.`;
    case "skipped_all":
      return t`None of the history from your protected channels could be restored.`;
    default: {
      const _exhaustive: never = kind;
      return verifyChannelFailedCopy();
    }
  }
}

/** The two general backup lines of design 9.5. */
export const backupNoteCopy = {
  /** Before a restore. */
  replacesOldDevice: (): string => t`Restoring replaces your old device.`,
  /** The protected channel section shares the backup's size limit. */
  textBudget: (): string =>
    t`History from protected channels uses up to 2 MB of your backup, so fewer direct messages may fit.`,
};

// ---------------------------------------------------------------------------
// Audit log (S4): `channel_protect`, `channel_history_wipe`
// ---------------------------------------------------------------------------

/** The S4 audit actions with copy here. */
export type AuditCopyAction = "channel_protect" | "channel_history_wipe";

/**
 * Display values for an audit row. `actor` and `channel` are display names
 * the caller resolved, never ids. `channel` is null when the caller cannot
 * name the channel (it was deleted, say): the sentence then keeps the fact
 * and names no channel. `wiped`: the protect entry's `changes.wiped` (only
 * `true` counts). `count`: the wipe job entry's number; the request entry
 * has none.
 */
export interface AuditCopyDetail {
  actor: string;
  channel: string | null;
  wiped?: boolean;
  count?: number | null;
}

/** Action filter label. */
export function auditActionLabel(action: AuditCopyAction): string {
  switch (action) {
    case "channel_protect":
      return t`Protect channel`;
    case "channel_history_wipe":
      return t`Delete earlier messages`;
    default: {
      const _exhaustive: never = action;
      return String(action);
    }
  }
}

/**
 * One sentence for an audit row. The boundary is never shown. A wipe entry
 * with a count is the job's own entry, so it names no one; without a usable
 * count it is the request. Without a channel name the same four sentences
 * say "a channel".
 */
export function auditCopy(
  action: AuditCopyAction,
  detail: AuditCopyDetail,
): string {
  const actor = detail.actor;
  const channel = displayName(detail.channel) === null ? null : detail.channel;
  switch (action) {
    case "channel_protect":
      if (channel === null) {
        return detail.wiped === true
          ? t`${actor} protected a channel and chose to delete its earlier messages`
          : t`${actor} protected a channel`;
      }
      return detail.wiped === true
        ? t`${actor} protected the channel ${channel} and chose to delete its earlier messages`
        : t`${actor} protected the channel ${channel}`;
    case "channel_history_wipe": {
      const count = detail.count;
      const counted =
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
      if (channel === null) {
        return counted
          ? t`The earlier messages in a channel were deleted (${count})`
          : t`${actor} started deleting the earlier messages in a channel`;
      }
      return counted
        ? t`The earlier messages in ${channel} were deleted (${count})`
        : t`${actor} started deleting the earlier messages in ${channel}`;
    }
    default: {
      const _exhaustive: never = action;
      return t`${actor} performed an action`;
    }
  }
}

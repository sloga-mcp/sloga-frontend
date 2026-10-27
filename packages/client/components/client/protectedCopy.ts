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
 * values interpolated are display names (from the caller) and counts; never
 * ids, key material or message text.
 *
 * The macro cannot run outside the build, so this file has no spec. The
 * error and state mapping it renders is spec'd in `protectedShield.test.ts`.
 */
import { t } from "@lingui/core/macro";

import type {
  ProtectedErrorUi,
  ProtectedNoticeKind,
  ProtectedShieldState,
} from "./protectedShield";
import type {
  OwnerPinStatus,
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

// ---------------------------------------------------------------------------
// Channel notices (design 9.2, plan D17; `ProtectedNoticeKind` from A2)
// ---------------------------------------------------------------------------

/** Most display names `seat_list_names_removed_users` lists inline. */
export const REMOVED_NAMES_LISTED_MAX = 5;

/** Generic `seat_list_names_removed_users` copy (also `errors.ts`). */
function removedUsersCopy(): string {
  return t`Some members were removed from this server and were left off the seat list.`;
}

/**
 * `seat_list_names_removed_users`: lists the display names only when the
 * caller resolved every reported user (a partial list would read as the
 * whole) and there are few enough to show; otherwise the generic copy.
 */
function removedUsersNamedCopy(names: readonly string[] | null): string {
  const shown = (names ?? []).map((n) => n.trim());
  if (
    shown.length === 0 ||
    shown.length > REMOVED_NAMES_LISTED_MAX ||
    shown.some((n) => n.length === 0)
  ) {
    return removedUsersCopy();
  }
  const list = shown.join(", ");
  return t`Members removed from this server and left off the seat list: ${list}`;
}

/**
 * Notice text for a channel-level kind. `max` is `ProtectedErrorUi.max`
 * (seat or device cap); null or absent falls back to copy without a count.
 * `names`: display names for `seat_list_names_removed_users` (from the
 * caller; never ids), ignored by every other kind.
 */
export function noticeCopy(
  kind: ProtectedNoticeKind,
  max: number | null = null,
  names: readonly string[] | null = null,
): string {
  switch (kind) {
    // shield states
    case "resecuring":
      return t`Re-securing this channel…`;
    case "not_seated":
      return t`You don't have a seat in this protected channel. Ask the owner for a seat.`;
    case "not_available":
      return t`Protected channels aren't available here yet. Open this channel in the main window of the Sloga desktop app.`;
    case "enable_e2ee":
      return t`Turn on end-to-end encryption on this device to use Protected channels.`;
    case "unverified":
      return verifyChannelFailedCopy();
    // specific `unverified` causes
    case "flag_stripped":
      return t`The server stopped marking this channel as protected. This device still treats it as a protected channel and won't send unencrypted messages here.`;
    case "seat_list_failed":
      return t`This channel's member list failed verification.`;
    case "off_list_member":
      return t`Someone in this channel isn't on the owner's member list.`;
    case "invalid_change":
      return t`A member made an invalid change to this channel. Re-securing with a new group…`;
    case "replayed_change":
      return t`This channel received a replayed membership change. Re-securing with a new group…`;
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
      return t`This protected channel is full.`;
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
      return removedUsersNamedCopy(names);
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
    default: {
      const _exhaustive: never = kind;
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
      return t`Sent before this device joined.`;
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

/** A local timeline line; `name` is the member's display name. */
export function timelineCopy(m: TimelineMarker, name: string): string {
  switch (m.kind) {
    case "new_device":
      return t`${name} added a new device.`;
    case "forced_removal":
      return t`${name} was removed by the server and can't rejoin until the owner re-seats them.`;
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
    default: {
      const _exhaustive: never = kind;
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

/**
 * Text for a `protectedNoticeForError` answer; null for `none` (the bridge
 * handled it, or the user cancelled a native dialog). `opts.removedUserNames`
 * lets the owner UI name the users of `seat_list_names_removed_users`.
 */
export function errorUiCopy(
  ui: ProtectedErrorUi,
  opts: { removedUserNames?: RemovedUserNames } = {},
): string | null {
  switch (ui.kind) {
    case "notice":
      return noticeCopy(
        ui.notice,
        ui.max,
        resolvedNames(ui, opts.removedUserNames),
      );
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
  publishInFlight: (): string =>
    t`Saving the member list. You can make more changes when this finishes.`,
  /** After a verified seat change. */
  seatsSaved: (): string => t`Seats updated.`,
  /** Overview (C13): why the voice and announcement toggles are hidden. */
  typeTogglesHidden: (): string =>
    t`Voice and announcement settings aren't available for protected channels.`,
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
  senderNotVerified: (): string =>
    t`The sender's device isn't verified on this device yet.`,
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

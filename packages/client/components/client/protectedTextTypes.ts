/**
 * Shared types for Protected channels (text plane), W4 lane A1.
 *
 * Every later W4 module (shield, policy, ids, router, manager, owner and
 * message flows, bridge seam, hooks, UI) imports its cross-file shapes from
 * here, so no lane mints its own copy of a native or server shape.
 *
 * Rules:
 * - Native mirrors follow the pinned native sources (`e2ee-core`
 *   `mls/text/types.rs` and `error.rs`; S1 copies in `/home/mcp/w4-notes/`,
 *   S2 at desktop 876c034, S4 at desktop b688f121): struct fields snake_case
 *   as named, enums snake_case, and every Rust `Option` arrives as `null`,
 *   so it is `T | null` here. The exception is the S2 and S4 fields native
 *   marks `skip_serializing_if` (omitted when `None`, so the S1 bytes are
 *   unchanged): those are optional keys.
 * - Command arguments follow Tauri's mapping: top-level argument names in
 *   camelCase, nested structs snake_case. An optional native parameter is
 *   `T | null` and always sent; never an omitted key.
 * - Type-only apart from the `as const` tables; no runtime imports. Loadable
 *   by `node --test --conditions=browser` (the spec pins the tables against
 *   the native sources).
 * - Nothing here holds key material. Logs carry ids only (plan D16).
 */
import type {
  MlsClaimedKeyPackage,
  MlsCommitInfo,
  MlsCreateGroupPayload,
  MlsEnvelope,
  MlsJoinIntentPayload,
  MlsJoinRequest,
  MlsMemberDevice,
  MlsPublishKeyPackages,
  MlsRemovedReason,
  MlsSubmitCommit,
} from "./e2ee";
import type { ResecureInputs } from "./protectedResecurePolicy";
import type { RowOps, WalkBatch } from "./protectedTextMessages";

export type { MlsRemovalReason, MlsRemovedReason } from "./e2ee";

// ---------------------------------------------------------------------------
// Compile-time helpers (types only)
// ---------------------------------------------------------------------------

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// ---------------------------------------------------------------------------
// Wire shapes shared with the server and native
// ---------------------------------------------------------------------------

/**
 * `Message.encrypted` (design 2.6; plan 4.1). Must stay structurally
 * identical to stoat.js `src/lib/protected.ts` `EncryptedPayload` (lane S1).
 * Passed to native verbatim; native refuses unknown fields.
 */
export interface EncryptedPayload {
  v: 1;
  group_id: string;
  epoch: number;
  sender_device_id: string;
  nonce: string;
  ciphertext: string;
  sig: string;
  franking?: unknown;
}

/**
 * The `POST /mls/groups` body `e2ee_text_group_create` returns: the call
 * payload plus `kind: "Text"` and `generation` (design 7.2). Couriered
 * verbatim: send the object as received, never rebuild it from these fields.
 */
export type TextCreateGroupPayload = MlsCreateGroupPayload & {
  kind: "Text";
  generation: number;
};

/**
 * The Text create body as POSTed: native's payload plus the client's text
 * protocol (S4 protocol floor, OR-3). Native never returns `protocol`; the
 * manager adds it to the object as received.
 */
export type TextCreateGroupBody = TextCreateGroupPayload & {
  protocol: number;
};

/**
 * The `/mls/groups/:id/join_intent` body as POSTed: native's signed intent
 * plus the client's text protocol (OR-3). `protocol` is not signed.
 */
export type TextJoinIntentBody = MlsJoinIntentPayload & { protocol: number };

/**
 * `SubmitMlsCommitPayload` from `_admit` / `_remove` / `_update`. Couriered
 * verbatim to `POST /mls/groups/:id/commits` (never rebuilt field by field).
 */
export type TextSubmitCommitPayload = MlsSubmitCommit;

/**
 * A stored commit (409 `Lost.winning`, gap-refetch row) with the declaration
 * W2 adds (design 8.1, W0-fix5). Plan D5 has B5 add the same optional field
 * to the TS `MlsCommitInfo`; this intersection stays compatible.
 */
export type TextCommitInfo = MlsCommitInfo & {
  rejoin_intents?: MlsJoinRequest[];
};

/**
 * The envelope as native `e2ee_text_process` takes it (`wire::MlsEnvelope`
 * with the four W0-fix4 declarations). Absent vectors mean empty; an absent
 * `committer` stays absent (native decides).
 */
export type TextWireEnvelope = MlsEnvelope & {
  committer?: MlsMemberDevice;
  added?: MlsMemberDevice[];
  removed?: MlsMemberDevice[];
  rejoin_intents?: MlsJoinRequest[];
};

/**
 * Plan D5 `TextEnvelope`: what the router hands the text manager. The
 * `recipientDeviceId` is routing metadata only and is stripped before
 * `e2ee_text_process` (pass a `TextWireEnvelope`).
 */
export type TextEnvelope = TextWireEnvelope & { recipientDeviceId: string };

// ---------------------------------------------------------------------------
// Native command results (design 8.3, `types.rs`)
// ---------------------------------------------------------------------------

/** `e2ee_text_group_create`. */
export interface TextGroupCreated {
  group_id: string;
  generation: number;
  payload: TextCreateGroupPayload;
}

/**
 * `e2ee_text_join` (W3 command-shape change, 2026-10-25): the signed intent
 * and the FRESH one-time KeyPackage native minted for it (one package, no
 * last resort). The manager PUTs `key_packages` to `/mls/key_packages` first
 * and only after its 2xx POSTs `intent` (never the whole object) to
 * `/mls/groups/:id/join_intent`. Both are couriered verbatim.
 */
export interface TextJoinIntent {
  intent: MlsJoinIntentPayload;
  key_packages: MlsPublishKeyPackages;
}

/** What `_process` / `_commit_won` did with an envelope. */
export type TextProcessKind = "welcome_joined" | "commit_applied" | "duplicate";

/** `e2ee_text_process` / `e2ee_text_commit_won`. */
export interface TextProcessOutcome {
  group_id: string;
  channel_id: string;
  kind: TextProcessKind;
  epoch: number;
  removed_self: boolean;
  added: MlsMemberDevice[];
  removed: MlsMemberDevice[];
  /** Added devices whose user already held a leaf. */
  new_devices: MlsMemberDevice[];
  /** Leaf users absent from the newest verified seat list after this epoch. */
  off_list: string[];
  /** Version adopted from the commit's embedded list; null when not newer. */
  seat_list_adopted: number | null;
  /** S2: owner-device alert raised by that adoption; absent when none. */
  owner_notice?: OwnerDeviceNotice;
  /**
   * S4 (design 3.14.6): the committer's history link for the won transition.
   * `_commit_won` only (never from `_process`); absent when none. PUT
   * verbatim, never rebuilt.
   */
  history_link?: HistoryLinkWire;
}

/** `e2ee_text_encrypt`. `nonce` is the cid native minted (plan D10). */
export interface TextEncrypted {
  nonce: string;
  encrypted: EncryptedPayload;
}

/** `e2ee_text_decrypt`. */
export interface TextDecrypted {
  message_id: string;
  channel_id: string;
  group_id: string;
  epoch: number;
  author_user_id: string;
  sender_device_id: string;
  cid: string;
  ts: number;
  text: string;
  replies: string[];
  sender_verified: boolean;
  ts_skew: boolean;
  /** One entry per file of a v2 envelope; `[]` for v1. Always present. */
  files: FileMeta[];
  /**
   * S4 (design 3.9 step 9): the removed-sender time clause rested on an
   * imported history row, so the timing is informational only (the grey
   * note). Always present from an S4 shell; an older shell sends no key, so
   * test `=== true`.
   */
  timing_unverified: boolean;
}

/**
 * A protected message's file as the UI sees it (S3 plan 2.3). Never a key,
 * blob reference or digest. S2 reports every file `failed`/`unsupported`.
 */
export interface FileMeta {
  /** Position in the envelope's `files`. */
  idx: number;
  name: string;
  mime: string;
  size: number;
  /** Native: `pending` | `ready` | `failed` | `expired` (a free string). */
  state: string;
  /** Set with `state: "failed"`; absent otherwise. */
  fail_reason?: string;
}

/** `e2ee_text_pending_commit` (null when nothing is staged). */
export interface PendingCommit {
  epoch: number;
  commit_b64: string;
}

/** Local group state; `none` is reported only. */
export type TextGroupState =
  | "none"
  | "joining"
  | "active"
  | "poisoned"
  | "left";

/** The send verdict (first failing condition, design 8.3 order). */
export type TextVerdict =
  | "ok"
  | "no_group"
  | "joining"
  | "not_seated"
  | "no_seat_list"
  | "roster_mismatch"
  | "owner_changed"
  | "poisoned";

/** One leaf of the held epoch. */
export interface TextMember {
  user_id: string;
  device_id: string;
  user_verified: boolean;
  on_signed_list: boolean;
  removed_locally: boolean;
}

/** The held verified seat list, without body or signature. */
export interface SeatListSummary {
  version: number;
  signer_user_id: string;
  signer_device_id: string;
  seats: string[];
  device_cap: number;
  issued_at: number;
}

export type OwnerPinStatus = "unpinned" | "pinned" | "changed";

export type PinSource =
  | "protect"
  | "first_sight"
  | "handover"
  | "confirmed"
  /** S2: a list signed by a device the held authority names. */
  | "owner_device";

/** The signer awaiting an owner-change confirmation (no key is returned). */
export interface PendingSignerInfo {
  user_id: string;
  device_id: string;
  same_user: boolean;
  verified: boolean;
}

/** `e2ee_text_owner_pin_state`. */
export interface OwnerPinState {
  channel_id: string;
  status: OwnerPinStatus;
  owner_user_id: string | null;
  owner_device_id: string | null;
  owner_verified: boolean;
  source: PinSource | null;
  pending_signer: PendingSignerInfo | null;
}

/** `e2ee_text_state`. */
export interface TextChannelState {
  channel_id: string;
  group_id: string | null;
  generation: number | null;
  epoch: number | null;
  state: TextGroupState;
  members: TextMember[];
  seat_list: SeatListSummary | null;
  owner_pin: OwnerPinState;
  self_seated: boolean;
  roster_matches_list: boolean;
  update_due: boolean;
  update_required: boolean;
  /**
   * `verdict: "no_group"` while `state` is `active` also means the held
   * group was superseded (S2).
   */
  verdict: TextVerdict;
  /**
   * S2: the persistent `dropped_this_device` alert (`device_id` is THIS
   * device); absent when none.
   */
  owner_alert?: OwnerDeviceNotice;
  // S4 (design 8.3 "S4"): each is absent when native holds none, so the S1
  // state is unchanged.
  /**
   * The lowest epoch held for the channel from any source, and why the
   * history walk stopped there (design 3.14.8).
   */
  history_floor?: HistoryFloor;
  /** The held list's `history` line (`hidden` for a v1 list). */
  history_setting?: HistorySetting;
  /** The channel's history boundary (a ULID, design 4.9 "S4"). */
  history_boundary?: string;
  /** The channel's local `pre_history` (S4-D14). */
  pre_history?: PreHistorySetting;
  /** `issued_at` of the earliest list ever verified for the channel, ms. */
  history_time_limit?: number;
}

export type SeatListStatus = "accepted" | "unchanged";

/** `e2ee_text_seat_list_verify`. */
export interface SeatListVerdict {
  status: SeatListStatus;
  version: number;
  seats: string[];
  device_cap: number;
  signer_user_id: string;
  signer_device_id: string;
  pinned_now: boolean;
  /** S2: owner-device alert raised by this adoption; absent when none. */
  owner_notice?: OwnerDeviceNotice;
}

/** S2 (design 4.4.1 rule 9): why an owner-user device is told. */
export type OwnerNoticeKind =
  | "dropped_this_device"
  | "changed_by_other"
  | "seated_by_other";

/** `owner_notice` / `owner_alert`. Ids only; the UI never renders them. */
export interface OwnerDeviceNotice {
  kind: OwnerNoticeKind;
  /** The other owner device that signed the adopted list. */
  device_id: string;
  /** User ids the list seated (`seated_by_other`); empty otherwise. */
  seated: string[];
}

/** `e2ee_text_seat_list_sign`. Persists nothing natively. */
export interface SignedSeatList {
  version: number;
  body: string;
  signature: string;
  signer_user_id: string;
  signer_device_id: string;
  /** S2, v2 lists only: the channel authority the body names. */
  authority?: SignedAuthority;
}

/**
 * S2 channel authority (design 2.4, 4.10): `e2ee_text_authority_sign`'s
 * result and a v2 list's `authority`.
 */
export interface SignedAuthority {
  body: string;
  signature: string;
}

/** Handover statement: `_owner_handover_sign` result, verify chain element. */
export interface SignedHandover {
  body: string;
  signature: string;
}

/** The `list` argument of `e2ee_text_seat_list_verify`. */
export interface SeatListInput {
  body: string;
  signature: string;
  signer_user_id: string;
  signer_device_id: string;
  /** S2, v2 lists only: the server's `list.authority`; absent when none. */
  authority?: SignedAuthority;
}

/** The `server_list` argument of `e2ee_text_seat_list_sign`. */
export interface ServerSeatList {
  version: number;
  body: string;
}

/** Dialog copy input (plan D24, note X4: a struct, not a tuple). */
export interface DisplayName {
  user_id: string;
  name: string;
}

/** `e2ee_mls_group_kind` (null: no local table knows the id). */
export type GroupKind = "call" | "text";

// ---------------------------------------------------------------------------
// History sharing (S4: design 3.14, 8.3 "S4"; `types.rs`, `wire.rs` and
// `error.rs` at desktop b688f121)
// ---------------------------------------------------------------------------

/** A list's `history` line (`TextChannelState.history_setting`). */
export type HistorySetting = "visible" | "hidden";

/** A genesis's `pre_history` line (`TextChannelState.pre_history`). */
export type PreHistorySetting = "kept" | "wiped";

/** Why the history walk stopped (design 3.14.7, 3.14.8). */
export type HistoryStop =
  | "hidden"
  | "missing"
  | "invalid"
  | "anchor_mismatch"
  | "conflict"
  | "unanchored"
  | "genesis";

/** Why `_history_link_build` built no link (design 3.14.6). */
export type HistoryBuildRefusal = "hidden" | "not_derived" | "too_large";

/** Why a history link candidate was refused (design 3.14.7, 8.4). */
export type HistoryLinkInvalidReason =
  | "aead"
  | "malformed"
  | "writer_not_member"
  | "bad_writer_sig"
  | "roster_identity_mismatch"
  | "roster_diff_mismatch"
  | "anchor_mismatch";

/**
 * One history link (design 3.14.5 "Wire"): the PUT body, each GET row, and
 * the native argument and result. Passed verbatim between the server and
 * native: send the object as received, never rebuild it from these fields.
 */
export interface HistoryLinkWire {
  /** The holder group G'. */
  group_id: string;
  /** The holder epoch e'. */
  epoch: number;
  /** G, the group whose keys the link carries. */
  prev_group_id: string;
  /** e, the epoch whose keys the link carries. */
  prev_epoch: number;
  nonce: string;
  ciphertext: string;
  writer_user_id: string;
  writer_device_id: string;
  signature: string;
}

/** One epoch of one group, as `HistoryImported` names it. */
export interface HistoryEpochRef {
  group_id: string;
  epoch: number;
}

/** `TextChannelState.history_floor`. `stopped` is always present. */
export interface HistoryFloor {
  group_id: string;
  epoch: number;
  stopped: HistoryStop | null;
}

/** `e2ee_text_history_link_build`. Writes nothing natively. */
export interface HistoryLinkBuilt {
  link: HistoryLinkWire | null;
  contest: boolean;
  /**
   * Writers of verified candidates whose content differs from this device's
   * (the owner notice). Ids only; the UI never renders them.
   */
  mismatched_writers: MlsMemberDevice[];
  refused: HistoryBuildRefusal | null;
}

/**
 * A stored message the history walk may open as evidence (design 3.14.7).
 * `encrypted` is the row's raw `encrypted`, passed through unparsed.
 */
export interface HistoryProbe {
  message_id: string;
  author_user_id: string;
  nonce: string;
  encrypted: EncryptedPayload;
}

/**
 * One holder of an `e2ee_text_history_import` page, highest holder first.
 * Native defaults the last three when absent (`serde(default)`), so they
 * are optional keys: an absent commit is `null`, absent probes are `[]`.
 */
export interface HistoryImportStep {
  holder_group_id: string;
  holder_epoch: number;
  candidates: HistoryLinkWire[];
  /** The stored commit into the holder epoch, when retained. */
  commit?: MlsCommitInfo | null;
  /** The stored commit of the epoch before it, when retained. */
  prev_commit?: MlsCommitInfo | null;
  /** At most 3 probes of the holder, from distinct authors. */
  probes?: HistoryProbe[];
}

/**
 * One refused candidate in `HistoryImported.refused`. The same shape as the
 * `history_link_invalid` native error; `group_id` / `epoch` name the HOLDER.
 */
export interface HistoryRefusal {
  type: "history_link_invalid";
  group_id: string;
  epoch: number;
  reason: HistoryLinkInvalidReason;
}

/** `e2ee_text_history_import`. */
export interface HistoryImported {
  session: string;
  need_more: boolean;
  imported: HistoryEpochRef[];
  floor: HistoryEpochRef | null;
  stopped: HistoryStop | null;
  refused: HistoryRefusal[];
}

// ---------------------------------------------------------------------------
// Commands (23: design 8.3 + W3 D12 `_mark_left` + W3 D7 `_pin_own_devices`
// + S2 `_authority_sign` + S4 `_history_link_build`, `_history_import`)
// ---------------------------------------------------------------------------

/** The text command allow-list (B5 `textInvoke` refuses anything else). */
export const TEXT_COMMANDS = [
  "e2ee_text_group_create",
  "e2ee_text_join",
  "e2ee_text_admit",
  "e2ee_text_process",
  "e2ee_text_commit_won",
  "e2ee_text_commit_lost",
  "e2ee_text_pending_commit",
  "e2ee_text_encrypt",
  "e2ee_text_decrypt",
  "e2ee_text_seat_list_sign",
  "e2ee_text_seat_list_verify",
  "e2ee_text_owner_pin_state",
  "e2ee_text_owner_confirm_change",
  "e2ee_text_owner_handover_sign",
  "e2ee_text_authority_sign",
  "e2ee_text_remove",
  "e2ee_text_update",
  "e2ee_text_state",
  "e2ee_text_mark_left",
  "e2ee_text_pin_own_devices",
  "e2ee_mls_group_kind",
  // S4, appended (the Android binding order at desktop b688f121)
  "e2ee_text_history_link_build",
  "e2ee_text_history_import",
] as const;

export type TextCommand = (typeof TEXT_COMMANDS)[number];

/** Why the bridge moves a group to `left` (`e2ee_text_mark_left`). */
export const TEXT_LEFT_REASONS = [
  "not_member",
  "not_found",
  "catch_up_failed",
] as const;

export type TextLeftReason = (typeof TEXT_LEFT_REASONS)[number];

/** Dialog copy arguments shared by the four dialog commands (W3 D16). */
export interface TextDialogCopyArgs {
  channelName: string | null;
  displayNames: DisplayName[];
}

/**
 * Per-command arguments (camelCase top level, snake_case nested). Every key
 * is always sent: an optional native parameter is `T | null`.
 */
export interface TextCommandArgs {
  /**
   * `recovery` / `supersedesGeneration` are the S2 recovery create (`false`
   * / null otherwise).
   */
  e2ee_text_group_create: {
    channelId: string;
    userId: string;
    supersedes: string | null;
    recovery: boolean;
    supersedesGeneration: number | null;
  };
  e2ee_text_join: {
    groupId: string;
    channelId: string;
    generation: number;
    userId: string;
  };
  e2ee_text_admit: {
    request: MlsJoinRequest;
    claimed: MlsClaimedKeyPackage;
  };
  /**
   * `envelope` WITHOUT `recipientDeviceId` (native may deny unknown keys).
   * `catchUpTip`: the server tip epoch while catching up; null when live.
   */
  e2ee_text_process: {
    envelope: TextWireEnvelope;
    userId: string;
    catchUpTip: number | null;
  };
  /**
   * `storedCommitB64` is the DS's stored string on a refetch path, our own
   * bytes only on a plain 2xx (plan D20). `rejoinIntents` is ALWAYS passed
   * (W3 2026-10-25: forced-removal memory depends on it): on a refetch path
   * the DS's `MlsCommitInfo.rejoin_intents` verbatim (absent = `[]`); on a
   * plain 2xx exactly the intents this device's commit carried (the
   * `_remove` `rejoinIntent`; `[]` for Adds and Updates).
   * `removedReasons` (S2) is ALWAYS passed too: the stored commit's
   * `removed_reasons` (absent = `[]`).
   */
  e2ee_text_commit_won: {
    groupId: string;
    wonEpoch: number;
    storedCommitB64: string;
    rejoinIntents: MlsJoinRequest[];
    removedReasons: MlsRemovedReason[];
  };
  e2ee_text_commit_lost: { groupId: string };
  e2ee_text_pending_commit: { groupId: string };
  e2ee_text_encrypt: {
    channelId: string;
    userId: string;
    text: string;
    replies: string[];
  };
  /** `nonce` is the message-level nonce (the cid), not `encrypted.nonce`. */
  e2ee_text_decrypt: {
    channelId: string;
    messageId: string;
    authorUserId: string;
    nonce: string;
    encrypted: EncryptedPayload;
    live: boolean;
  };
  /**
   * `serverList` null only when the server holds no list (genesis).
   * S2: `format` (null = native's choice), `authority` (null = none) and
   * `recovery` (a recovery list always gets the recovery dialog).
   * S4 (null = none, always sent): `history` on any v2 list, never with
   * `recovery`; `historyBoundary` (a ULID) on a v2 genesis only;
   * `preHistory` on a genesis or the wipe list (`wiped` gets the native
   * wipe dialog); `wipeCount` only labels that dialog.
   */
  e2ee_text_seat_list_sign: TextDialogCopyArgs & {
    channelId: string;
    userId: string;
    seats: string[];
    deviceCap: number;
    serverList: ServerSeatList | null;
    format: number | null;
    authority: SignedAuthority | null;
    recovery: boolean;
    history: HistorySetting | null;
    historyBoundary: string | null;
    preHistory: PreHistorySetting | null;
    wipeCount: number | null;
  };
  /** S2: ALWAYS a native dialog naming every owner device. */
  e2ee_text_authority_sign: TextDialogCopyArgs & {
    channelId: string;
    userId: string;
    ownerDevices: string[];
  };
  /**
   * `asOfEpoch` / `asOfGroupId` from `GET .../seats` (W3 D14, plan D24):
   * required by native whenever this device holds a group; null only when it
   * holds none (plan D26 first-sight verify). `asOfGeneration` (S2): the
   * server's `as_of_generation`, null when absent.
   */
  e2ee_text_seat_list_verify: {
    channelId: string;
    list: SeatListInput;
    handovers: SignedHandover[];
    serverOwnerId: string;
    asOfEpoch: number | null;
    asOfGroupId: string | null;
    asOfGeneration: number | null;
  };
  e2ee_text_owner_pin_state: { channelId: string };
  e2ee_text_owner_confirm_change: TextDialogCopyArgs & { channelId: string };
  e2ee_text_owner_handover_sign: TextDialogCopyArgs & {
    channelId: string;
    userId: string;
    toUserId: string;
    toDeviceId: string;
  };
  /**
   * `pendingRemovalUsers` from `GET .../text_group` `pending_removals`
   * (W3 D13). No `revokedDevices`: W3 D26 dropped it for S1.
   * `pendingDeviceTargets` (S2-D17a) is always sent, `[]` when none.
   */
  e2ee_text_remove: {
    groupId: string;
    targets: MlsMemberDevice[];
    rejoinIntent: MlsJoinRequest | null;
    pendingRemovalUsers: string[];
    pendingDeviceTargets: MlsMemberDevice[];
  };
  e2ee_text_update: { groupId: string };
  e2ee_text_state: { channelId: string };
  e2ee_text_mark_left: { groupId: string; reason: TextLeftReason };
  /**
   * W3 3a: `devices` is this user's COMPLETE signed device listing (the
   * bytes `#reconcileDevices` saw), passed through unparsed.
   */
  e2ee_text_pin_own_devices: { userId: string; devices: unknown[] };
  e2ee_mls_group_kind: { groupId: string };
  /**
   * S4: `epoch` is the holder epoch; `candidates` are the links the server
   * already holds for it (always sent, may be empty; at most 200).
   */
  e2ee_text_history_link_build: {
    groupId: string;
    epoch: number;
    candidates: HistoryLinkWire[];
  };
  /**
   * S4: `session` is null to start, then the id the previous call answered
   * (an unknown one starts fresh natively). A call is all or nothing.
   */
  e2ee_text_history_import: {
    groupId: string;
    session: string | null;
    steps: HistoryImportStep[];
  };
}

/** Per-command results. Rust `()` arrives as `null`. */
export interface TextCommandResult {
  e2ee_text_group_create: TextGroupCreated;
  e2ee_text_join: TextJoinIntent;
  e2ee_text_admit: TextSubmitCommitPayload;
  e2ee_text_process: TextProcessOutcome;
  e2ee_text_commit_won: TextProcessOutcome;
  e2ee_text_commit_lost: null;
  e2ee_text_pending_commit: PendingCommit | null;
  e2ee_text_encrypt: TextEncrypted;
  e2ee_text_decrypt: TextDecrypted;
  e2ee_text_seat_list_sign: SignedSeatList;
  e2ee_text_seat_list_verify: SeatListVerdict;
  e2ee_text_owner_pin_state: OwnerPinState;
  e2ee_text_owner_confirm_change: null;
  e2ee_text_owner_handover_sign: SignedHandover;
  e2ee_text_authority_sign: SignedAuthority;
  e2ee_text_remove: TextSubmitCommitPayload;
  e2ee_text_update: TextSubmitCommitPayload;
  e2ee_text_state: TextChannelState;
  e2ee_text_mark_left: null;
  /** Unspecified by the native plan; read nothing from it. */
  e2ee_text_pin_own_devices: unknown;
  e2ee_mls_group_kind: GroupKind | null;
  e2ee_text_history_link_build: HistoryLinkBuilt;
  e2ee_text_history_import: HistoryImported;
}

export type _TextCommandArgsComplete = Assert<
  Equal<TextCommand, keyof TextCommandArgs>
>;
export type _TextCommandResultComplete = Assert<
  Equal<TextCommand, keyof TextCommandResult>
>;

/** `true` when every key of `T` is required and never `undefined`. */
type AlwaysSent<T> = {
  [K in keyof T]-?: T extends Required<Pick<T, K>>
    ? undefined extends T[K]
      ? false
      : true
    : false;
}[keyof T];

/** No command argument is an optional key: each one is always sent. */
export type _TextCommandArgsAlwaysSent = Assert<
  Equal<
    { [C in TextCommand]: AlwaysSent<TextCommandArgs[C]> }[TextCommand],
    true
  >
>;

// ---------------------------------------------------------------------------
// Native errors (`error.rs`: serde tag `type`, variant names snake_case)
// ---------------------------------------------------------------------------

export type BundleRejection =
  | "malformed_key"
  | "bad_identity_signature"
  | "bad_fallback_signature"
  | "bad_one_time_key_signature"
  | "unsupported_protocol_version"
  | "wrong_user"
  | "malformed_device_id";

export type BackupRejection =
  | "malformed_framing"
  | "malformed_header"
  | "unsupported_version"
  | "unsupported_kdf"
  | "kdf_params_rejected"
  | "wrong_user"
  | "device_mismatch"
  | "unsupported_payload_version";

export type LeafRejection =
  | "malformed_credential"
  | "signature_key_mismatch"
  | "unknown_identity"
  | "binding_unverified"
  | "identity_changed"
  | "identity_key_mismatch"
  | "bad_binding_signature"
  | "unsupported_suite"
  | "illegal_mutation";

export type SeatListRejection =
  | "malformed"
  | "wrong_channel"
  | "unsorted"
  | "duplicate"
  | "signer_not_seated"
  | "signer_mismatch"
  | "too_many_seats"
  // S2
  | "immutable_changed"
  | "authority_invalid"
  // S4: `_seat_list_sign` only (a genesis boundary ahead of the local clock)
  | "future_boundary";

export type MalformedTextReason =
  | "structure"
  | "envelope"
  | "cid_mismatch"
  | "too_large";

/** Every native `Error` tag, in `error.rs` order (the spec pins it). */
export const NATIVE_ERROR_TAGS = [
  "not_enabled",
  "already_enabled",
  "not_published",
  "bundle_rejected",
  "peer_identity_changed",
  "needs_bundle",
  "peer_has_no_devices",
  "no_usable_devices",
  "mls_store_owned_by_another_account",
  "owner_of_record_unknown",
  "invalid_argument",
  "rc_peer_key_rejected",
  "rc_peer_key_reflected",
  "rc_session_replayed",
  "declined",
  "busy",
  "storage",
  "protector",
  "protector_locked",
  "store_corrupt",
  "unsupported_protocol_version",
  "crypto_failure",
  "attachment_digest_mismatch",
  "attachment_unavailable",
  "group_not_established",
  "fan_out_too_large",
  "peer_downgraded",
  "no_backup",
  "backup_code_mismatch",
  "backup_blob_rejected",
  "restore_incomplete",
  "store_already_provisioned",
  "mls",
  "mls_group_not_found",
  "mls_epoch_gap",
  "mls_unsolicited_welcome",
  "mls_welcome_context_mismatch",
  "mls_leaf_rejected",
  "mls_poisoned_epoch",
  "mls_not_published",
  "mls_stale_ctl",
  "mls_not_confirmed",
  "mls_call_full",
  // W3, design 8.4
  "unknown_epoch",
  "unknown_sender",
  "bad_sig",
  "not_seated",
  "roster_mismatch",
  "owner_changed",
  "signer_leaf_missing",
  "commit_declaration_mismatch",
  "not_owner",
  "seat_list_rollback",
  "seat_list_equivocation",
  "seat_list_behind",
  "seat_list_invalid",
  "removed_sender",
  "replay",
  "channel_mismatch",
  "already_member",
  "own_commit_mismatch",
  "duplicate_leaf",
  "replayed_rejoin_intent",
  "unexpected_mls_content",
  "update_required",
  "text_group_full",
  "malformed_text_payload",
  "wrong_group_kind",
  "identity_pin_required",
  "handover_target_invalid",
  // Appended in slice order (S2, S3, S4); the spec pins the order
  "catch_up_leaf_unresolvable",
  "unsupported_envelope_version",
  "history_link_invalid",
] as const;

export type NativeErrorTag = (typeof NATIVE_ERROR_TAGS)[number];

/**
 * The text-plane tags: every W3 variant (design 8.4 table plus W3's
 * `identity_pin_required` / `handover_target_invalid`, then the appended
 * S2 `catch_up_leaf_unresolvable` and S3-N0 `unsupported_envelope_version`)
 * and the existing
 * variants design 8.4 says apply to text groups. Plan D17's total mapping
 * must name each of these; any other `NativeErrorTag` (e.g. `busy`,
 * `storage`, `not_enabled`) and any untyped rejection go to the fail-closed
 * catch-all. The S4 `history_link_invalid` is NOT listed: native never
 * rejects a command with it (it only appears in `HistoryImported.refused`),
 * so a thrown one is unknown and fails closed.
 */
export const TEXT_NATIVE_ERROR_TAGS = [
  "unknown_epoch",
  "unknown_sender",
  "bad_sig",
  "not_seated",
  "roster_mismatch",
  "owner_changed",
  "signer_leaf_missing",
  "commit_declaration_mismatch",
  "not_owner",
  "seat_list_rollback",
  "seat_list_equivocation",
  "seat_list_behind",
  "seat_list_invalid",
  "removed_sender",
  "replay",
  "channel_mismatch",
  "already_member",
  "own_commit_mismatch",
  "duplicate_leaf",
  "replayed_rejoin_intent",
  "unexpected_mls_content",
  "update_required",
  "text_group_full",
  "malformed_text_payload",
  "wrong_group_kind",
  "identity_pin_required",
  "handover_target_invalid",
  "catch_up_leaf_unresolvable",
  "unsupported_envelope_version",
  // existing variants that apply to text groups (design 8.4)
  "mls_group_not_found",
  "mls_unsolicited_welcome",
  "mls_leaf_rejected",
  "mls_epoch_gap",
  "mls_poisoned_epoch",
  "declined",
] as const satisfies readonly NativeErrorTag[];

export type TextNativeErrorTag = (typeof TEXT_NATIVE_ERROR_TAGS)[number];

/** Every native error as it crosses IPC, field for field. */
export type NativeError =
  | { type: "not_enabled" }
  | { type: "already_enabled" }
  | { type: "not_published" }
  | {
      type: "bundle_rejected";
      user_id: string;
      device_id: string;
      reason: BundleRejection;
    }
  | { type: "peer_identity_changed"; user_id: string; device_ids: string[] }
  | { type: "needs_bundle"; user_id: string; device_ids: string[] }
  | { type: "peer_has_no_devices"; user_id: string }
  | { type: "no_usable_devices"; user_id: string }
  | {
      type: "mls_store_owned_by_another_account";
      owner_user_id: string;
      requested_user_id: string;
    }
  | { type: "owner_of_record_unknown" }
  | { type: "invalid_argument"; field: string }
  | { type: "rc_peer_key_rejected" }
  | { type: "rc_peer_key_reflected" }
  | { type: "rc_session_replayed" }
  | { type: "declined" }
  | { type: "busy" }
  | { type: "storage"; code: string }
  | { type: "protector" }
  /** Device locked (iOS): transient, retry after unlock; never a wipe. */
  | { type: "protector_locked" }
  | { type: "store_corrupt" }
  | { type: "unsupported_protocol_version"; version: number }
  | { type: "crypto_failure" }
  | { type: "attachment_digest_mismatch" }
  | { type: "attachment_unavailable"; state: string }
  | { type: "group_not_established"; conversation_id: string }
  | {
      type: "fan_out_too_large";
      members: number;
      envelopes: number;
      user_id: string | null;
    }
  | { type: "peer_downgraded"; user_id: string }
  | { type: "no_backup" }
  | { type: "backup_code_mismatch" }
  | { type: "backup_blob_rejected"; reason: BackupRejection }
  | { type: "restore_incomplete" }
  | { type: "store_already_provisioned" }
  | { type: "mls"; code: string }
  | { type: "mls_group_not_found"; group_id: string }
  | { type: "mls_epoch_gap"; group_id: string; expected: number; got: number }
  | { type: "mls_unsolicited_welcome"; group_id: string }
  | { type: "mls_welcome_context_mismatch" }
  | {
      type: "mls_leaf_rejected";
      user_id: string;
      device_id: string;
      reason: LeafRejection;
    }
  | { type: "mls_poisoned_epoch"; group_id: string; epoch: number }
  | { type: "mls_not_published" }
  | { type: "mls_stale_ctl"; group_id: string }
  | { type: "mls_not_confirmed"; group_id: string }
  | { type: "mls_call_full"; max: number }
  | {
      type: "unknown_epoch";
      group_id: string;
      epoch: number;
      oldest_held: number | null;
      current: number;
      /**
       * S4 (design 3.9 "S4"): the epoch falls after this device's recorded
       * removal from the group. An older shell sends no key, so test
       * `=== true` / `=== false`.
       */
      removed_self: boolean;
    }
  | {
      type: "unknown_sender";
      user_id: string;
      device_id: string;
      epoch: number;
    }
  | { type: "bad_sig"; user_id: string; device_id: string }
  | { type: "not_seated"; channel_id: string }
  | { type: "roster_mismatch"; group_id: string; users: string[] }
  | {
      type: "owner_changed";
      channel_id: string;
      signer_user_id: string;
      signer_device_id: string;
      same_user: boolean;
      verified: boolean;
    }
  | { type: "signer_leaf_missing"; channel_id: string }
  | { type: "commit_declaration_mismatch"; group_id: string; epoch: number }
  | { type: "not_owner"; channel_id: string }
  | {
      type: "seat_list_rollback";
      channel_id: string;
      have: number;
      got: number;
    }
  | { type: "seat_list_equivocation"; channel_id: string; version: number }
  | { type: "seat_list_behind"; channel_id: string; have: number; need: number }
  | {
      type: "seat_list_invalid";
      channel_id: string;
      reason: SeatListRejection;
    }
  | {
      type: "removed_sender";
      user_id: string;
      device_id: string;
      epoch: number;
    }
  | { type: "replay"; cid: string; first_message_id: string }
  | { type: "channel_mismatch"; group_id: string }
  | { type: "already_member"; group_id: string }
  | { type: "own_commit_mismatch"; group_id: string; epoch: number }
  | {
      type: "duplicate_leaf";
      group_id: string;
      user_id: string;
      device_id: string;
    }
  | {
      type: "replayed_rejoin_intent";
      group_id: string;
      user_id: string;
      device_id: string;
    }
  | { type: "unexpected_mls_content"; group_id: string }
  | { type: "update_required"; group_id: string }
  | { type: "text_group_full"; max: number }
  | { type: "malformed_text_payload"; reason: MalformedTextReason }
  | { type: "wrong_group_kind"; group_id: string }
  | { type: "identity_pin_required"; user_id: string; device_id: string }
  | { type: "handover_target_invalid"; channel_id: string }
  /** S2-D31: rolled back, not poisoned; mark `left` and rejoin. */
  | { type: "catch_up_leaf_unresolvable"; group_id: string; epoch: number }
  /** S3-N0: a newer format than this build reads; `v` is never shown. */
  | { type: "unsupported_envelope_version"; v: number }
  /**
   * S4: one refused history link CANDIDATE (`group_id` / `epoch` name the
   * holder). Never thrown: read it from `HistoryImported.refused`.
   */
  | HistoryRefusal;

/** Plan `TextNativeError`: the text-plane subset of `NativeError`. */
export type TextNativeError = Extract<
  NativeError,
  { type: TextNativeErrorTag }
>;

export type _NativeErrorTagsComplete = Assert<
  Equal<NativeError["type"], NativeErrorTag>
>;
export type _TextNativeErrorTagsComplete = Assert<
  Equal<TextNativeError["type"], TextNativeErrorTag>
>;

// ---------------------------------------------------------------------------
// Server REST shapes the text plane reads (design 7.2)
// ---------------------------------------------------------------------------

/** `GET /channels/:id/seats`. Null caps mean "unknown", never 0. */
export interface ProtectedSeatsResponse {
  /** null only for a channel that is not protected. */
  list:
    | (SeatListInput & {
        version: number;
        handovers: SignedHandover[];
      })
    | null;
  as_of_epoch: number | null;
  as_of_group_id: string | null;
  /** S2-D33: the open Text group's generation; absent without one. */
  as_of_generation?: number | null;
  entitlement_device_cap: number | null;
  slot_cap: number | null;
  device_cap: number | null;
  seats_used: number;
  seats: {
    user_id: string;
    seated_at: string;
    /** Present only when the caller is the server owner. */
    seated_without_access?: boolean;
  }[];
  cooling: {
    user_id: string;
    released_at: string;
    cooldown_until: string;
    /** S2: present only when the caller is the server owner. */
    cause?: SeatReleaseCause;
  }[];
  /**
   * S2 (R27), owner caller only: authority `owner_devices` with no
   * registered identity or a changed key. Absent = empty.
   */
  revoked_owner_devices?: string[];
}

/** S2: why a seat was released (`cooling[].cause`, design 2.3). */
export type SeatReleaseCause =
  | "owner_unseat"
  | "server_removal"
  | "access_lost"
  | "device_never_joined";

/** S2: one outstanding join intent (`text_group.join_requests`, 6.3). */
export interface ProtectedJoinRequestInfo {
  user_id: string;
  device_id: string;
  /** The signed generation (v2 lists); absent on an S1 intent. */
  generation?: number;
  key_package_ref: string;
  signature: string;
  /** The signed issue time in ms (v2 lists); absent on an S1 intent. */
  issued_at?: number;
  created_at: string;
  rejoin: boolean;
}

/** S2 (design 6.3, #222): why the current list's signer device is lost. */
export type SignerLostCause = "device_revoked" | "account_unavailable";

/** `GET /mls/channels/:id/text_group` (404 when no open Text group). */
export interface ProtectedTextGroupResponse {
  group_id: string;
  channel_id: string;
  generation: number;
  current_epoch: number;
  members: MlsMemberDevice[];
  pending_removals: { user_id: string; created_at: string }[];
  member_added: {
    user_id: string;
    device_id: string;
    epoch: number;
    at: string;
  }[];
  /** S2, seated callers only; absent = empty. */
  join_requests?: ProtectedJoinRequestInfo[];
  /** S2-D17a, seated callers only; absent = empty. */
  pending_device_removals?: {
    user_id: string;
    device_id: string;
    created_at: string;
  }[];
  /** S2-D17d, seated callers only; absent = none. */
  signer_lost?: {
    user_id: string;
    device_id: string;
    cause: SignerLostCause;
    at: string;
  };
}

/** Plan D13 flag (`GET /`); absent/malformed/failed is `enabled: false`. */
export interface ProtectedChannelsFlag {
  enabled: boolean;
  defaultDeviceCap: number | null;
  /** S2 `formats_v2`; absent/malformed is `false` and never turns `enabled` off. */
  formatsV2: boolean;
  /**
   * S4 `history_setting` (R-W4-9): absent/malformed is `false` and never
   * turns `enabled` off. While false the bridge writes no history link and
   * offers no boundary protect, no history toggle and no wipe.
   */
  historySetting: boolean;
}

// ---------------------------------------------------------------------------
// Courier (plan D6)
// ---------------------------------------------------------------------------

export type TextApiMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * The only extra header the courier sends (D40 / OR-14): the audit-log
 * reason, as stoat.js sends it (trimmed; blank = no header; otherwise
 * `encodeURIComponent`). The server caps it at 512 characters.
 */
export type TextApiHeaders = Readonly<Record<"X-Audit-Log-Reason", string>>;

/**
 * `bridge.textApi` answer. Never thrown for a non-2xx; only a network
 * failure or abort rejects.
 */
export interface TextApiResponse {
  status: number;
  resetAfterMs: number | null;
  body: unknown;
}

// ---------------------------------------------------------------------------
// Views (plan D22, D14) and markers
// ---------------------------------------------------------------------------

/**
 * Message marker kinds (design 9.2 rows that render in place of a body).
 * Lane A2 re-exports this type; it does not redefine it.
 */
export type ProtectedMarkerKind =
  | "sent_before_join" // UnknownEpoch, epoch < oldest_held (gray)
  | "removed_self" // S4 UnknownEpoch.removed_self: sent after removal (gray)
  | "unknown_key" // MlsGroupNotFound on decrypt (gray)
  | "decrypt_failed" // UnknownEpoch, epoch > current after one catch-up (red)
  | "unverified_sender" // UnknownSender, BadSig on a message (red)
  | "removed_sender" // RemovedSender (red)
  | "replay" // Replay (red)
  | "malformed" // MalformedTextPayload (red)
  | "unsupported_version" // S3-N0 UnsupportedEnvelopeVersion (gray)
  | "unencrypted_row" // no `encrypted` in a protected/pinned channel (red)
  | "error"; // any other or unknown error (red, fail closed)

/**
 * Plan D22, plus the S4 row arms (design 9.5): `plain` is a verified
 * pre-boundary row that renders as an ordinary message (its fields come from
 * the SDK's verified reveal, never from here); `checking` is a row with no
 * `encrypted` whose arm is not decided yet (it stays stripped).
 */
export type ProtectedMessageView =
  | { status: "pending" }
  | {
      status: "ok";
      text: string;
      replies: string[];
      senderVerified: boolean;
      tsSkew: boolean;
      cid: string;
      /** S2 (OR-20): files of a v2 envelope this build cannot show; 0 for v1. */
      filesUnsupported: number;
      /** S4: native `timing_unverified` (the grey note). */
      timingUnverified: boolean;
      /** S4: an encrypted row whose id is at or below the history boundary. */
      belowBoundary: boolean;
      /** S4: show the "(history)" sender note instead of the S1 one. */
      historySender: boolean;
    }
  | { status: "plain" }
  | { status: "checking" }
  | { status: "marker"; kind: ProtectedMarkerKind };

/** Local per-channel timeline markers from `TextProcessOutcome` (D22). */
export type TimelineMarker =
  | {
      kind: "new_device";
      channelId: string;
      groupId: string;
      epoch: number;
      userId: string;
      deviceId: string;
      atMs: number;
    }
  | {
      kind: "forced_removal";
      channelId: string;
      groupId: string;
      epoch: number;
      userId: string;
      atMs: number;
    }
  /** S4: where the history walk stopped (`groupId` / `epoch` = the floor). */
  | {
      kind: "history_floor";
      channelId: string;
      groupId: string;
      epoch: number;
      stop: HistoryStop;
      atMs: number;
    };

/**
 * An error tag a view records: a native tag, or `"unknown"` for a rejection
 * that is not a typed native error (fail closed downstream).
 */
export type ViewErrorTag = NativeErrorTag | "unknown";

/**
 * What the manager publishes per channel (`onView`). Carries the design 9.1
 * inputs the manager owns; the shield (A2) adds `serverProtected`,
 * `locallyPinned` and `capable` from the SDK and the bridge.
 */
export interface ProtectedChannelView {
  channelId: string;
  /** Tag of the last `_seat_list_verify` failure, null after a success. */
  seatListError: ViewErrorTag | null;
  /** Tag of the last join/process failure, null after a success. */
  groupError: ViewErrorTag | null;
  /** Latest `e2ee_text_state`; null while loading. */
  native: TextChannelState | null;
  /** Latest `GET .../text_group`; null when none or not fetched. */
  serverGroup: ProtectedTextGroupResponse | null;
  /** Latest `GET .../seats`; null when not fetched. */
  seats: ProtectedSeatsResponse | null;
  /**
   * `port.now()` when the verdict first became `roster_mismatch`, else null.
   * Consumers derive design 9.1 `rosterMismatchAgeMs` from it.
   */
  rosterMismatchSinceMs: number | null;
  signerLeafMissingRetries: number;
  welcomeRetriesExhausted: boolean;
  /** An owner-change envelope is parked awaiting "Review owner change". */
  ownerChangePending: boolean;
  /** Every member wiped: offer the owner "Re-create the protected group". */
  recreateAvailable: boolean;
  /** An unresolved seat publish exists (signing refused meanwhile, D7). */
  publishInFlight: boolean;
  /** An orphan send could not be confirmed (D10 `maybe_unsent`). */
  maybeUnsent: boolean;
  /** S2 D35: this device's join was refused for capacity; null otherwise. */
  capacity: { reason: "device_cap" | "group_full" } | null;
  /** S4 protocol floor: the server's `min`; null unless refused as outdated. */
  clientOutdated: number | null;
  /** S2: the last one-shot owner notice; null when none. */
  ownerNotice: OwnerDeviceNotice | null;
  /**
   * S2-D36 input: `port.now()` when this channel's shield entered
   * `resecuring`, null while it is not. The manager always sets it; optional
   * only so view literals written before S2 still compile. Read it through
   * `ProtectedUiApi.resecureInputs`.
   */
  resecuringSinceMs?: number | null;
  /**
   * OR-10: an owner change was confirmed on this device, yet the next verify
   * again named the same same-user signer device (not on the authority's
   * owner devices). "Review owner change" is not offered for it until the
   * list or the pin changes. The manager always sets it (see above).
   */
  ownerChangeUnlisted?: boolean;
  /**
   * S4: the channel's history walk. `retry_later`: it ended `unanchored` on
   * a session cap and runs again on the next backward paging that needs it.
   */
  historyWalk: "idle" | "running" | "retry_later";
}

/** Toasts the manager raises through `port.notify` (D22). */
export type ProtectedToastKind =
  | "unsolicited_welcome"
  | "owner_notice"
  /** S4: an owner-user device found a history link that differs from its own. */
  | "history_mismatch"
  /** S4: `_history_link_build` refused `too_large`. */
  | "history_too_large";

// ---------------------------------------------------------------------------
// Port (plan 4.3) and manager-facing types
// ---------------------------------------------------------------------------

/** Log ids only: group id, envelope id, error type. Never content. */
export type TextLogIds = Readonly<
  Record<string, string | number | boolean | null>
>;

/** What the port knows about a channel from the client cache. */
export interface ProtectedChannelInfo {
  channelId: string;
  name: string;
  serverId: string | null;
  serverOwnerId: string | null;
  serverProtected: boolean;
  locallyPinned: boolean;
}

/** A protected message row as the manager sees it (SDK-free). */
export interface ProtectedMessageRow {
  id: string;
  channelId: string;
  authorId: string;
  /** The message-level nonce (the cid); null when the server sent none. */
  nonce: string | null;
  /** null: the row carries no `encrypted` (marker `unencrypted_row`). */
  encrypted: EncryptedPayload | null;
}

/** The bridge-side port the manager drives everything through. */
export interface ProtectedTextPort {
  /** Refused by the bridge unless `protectedTextCapable()` (D3). */
  invoke<C extends TextCommand>(
    cmd: C,
    args: TextCommandArgs[C],
  ): Promise<TextCommandResult[C]>;
  /**
   * Pin OTHER users' devices via `e2ee_pin_call_identities` from a fresh
   * signed listing; `targets` are the device ids involved. Resolves with the
   * newly pinned device ids.
   */
  pinCallIdentities(userId: string, targets: string[]): Promise<string[]>;
  /**
   * This user's COMPLETE signed listing and a hash to detect changes.
   * F-R8: `force` asks for a fresh listing (never a cached one or a fetch
   * begun earlier); `want` names device ids it must list, else refetched.
   * The last listing served for either after the fetch failed carries
   * `stale: true` (and the bridge's `at`; the manager reads both if present).
   */
  ownDeviceListing(request?: {
    force?: boolean;
    want?: readonly string[];
  }): Promise<{ hash: string; listing: unknown[] }>;
  api(
    method: TextApiMethod,
    path: string,
    body?: unknown,
    headers?: TextApiHeaders,
  ): Promise<TextApiResponse>;
  /** Ack processed envelope ids (only after durable processing). */
  ack(ids: string[]): Promise<void>;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    ids: TextLogIds,
  ): void;
  readonly selfUserId: string;
  readonly selfDeviceId: string;
  channelInfo(channelId: string): ProtectedChannelInfo | null;
  /** Dialog copy for D24 (`display_names`); unknown users omitted. */
  displayNames(userIds: string[]): DisplayName[];
  /** localStorage wrapper (D7c, D10); every call is try/catch inside. */
  store: {
    get(key: string): string | null;
    /** false when the write failed (quota, disabled storage). */
    set(key: string, value: string): boolean;
    delete(key: string): void;
  };
  notify(kind: ProtectedToastKind): void;
  /**
   * Every stored key starting with `prefix` (localStorage scan, D10
   * orphans). Optional: a port without it makes the orphan scan log and
   * skip.
   */
  storeKeys?(prefix: string): string[];
  /**
   * Outbox keys owned by a live Draft outbox entry (never orphans). The
   * manager calls `.has()` on the answer. Throwing means "unknown": the
   * orphan scan logs and skips rather than treat a live entry as orphaned.
   */
  liveOutboxKeys?(): ReadonlySet<string>;
  /**
   * S2 (j): the root advert's `formats_v2` as the bridge holds it. Optional:
   * absent reads as false. The owner flows read it through their port to
   * pick `format: 2` (genesis, first list over a held v1); never inferred
   * from a server list.
   */
  formatsV2?(): boolean;
  /**
   * S4 (R-W4-9): the root advert's `history_setting` as the bridge holds
   * it. Optional: absent reads as false. While it is not `true` the manager
   * writes and reads no history link, runs no walk and refuses every
   * history owner call.
   */
  historySetting?(): boolean;
}

/** Why a refresh runs (D8, D26). */
export type TextRefreshReason =
  | "open"
  | "interval"
  | "commit"
  | "resecuring"
  | "start"
  | "owner_confirmed"
  | "send_refused"
  /** S2: a `ProtectedChannelChanged` event. */
  | "event"
  /** S2: the UI's one-off `retryNow` (no interval; never an open). */
  | "manual";

/** Per-channel state the manager exposes to the owner/message flows. */
export interface ManagerState {
  channelId: string;
  native: TextChannelState | null;
  seats: ProtectedSeatsResponse | null;
  serverGroup: ProtectedTextGroupResponse | null;
  publishInFlight: boolean;
  ownerChangePending: boolean;
}

/** What a flow rejects with (D17 maps it to a notice or marker). */
export type TextFlowFailure =
  | { source: "native"; error: NativeError }
  | { source: "server"; status: number; type: string | null; body: unknown }
  | { source: "transport" }
  | { source: "client"; reason: string };

/** Options for `GroupOps.removeDevices`. */
export interface RemoveDevicesOptions {
  /** The rejoin intent covering the single target (owner-device rule 2). */
  rejoinIntent: MlsJoinRequest | null;
}

/** Narrow interface B1 implements and B2/B4 consume (no cross-imports). */
export interface GroupOps {
  /** Resolves once the group is `active`; rejects with `TextFlowFailure`. */
  ensureJoined(channelId: string): Promise<void>;
  createGroup(
    channelId: string,
    supersedes: string | null,
  ): Promise<TextGroupCreated>;
  removeDevices(
    channelId: string,
    targets: MlsMemberDevice[],
    opts: RemoveDevicesOptions,
  ): Promise<void>;
  catchUp(channelId: string, toEpoch: number, groupId: string): Promise<void>;
  refresh(channelId: string, reason: TextRefreshReason): Promise<void>;
  stateOf(channelId: string): ManagerState | null;
}

/** A delivered protected send (D10): the server row for `getOrCreate`. */
export interface ProtectedSendOutcome {
  messageId: string;
  cid: string;
  /** The API message body, handed to the SDK unparsed. */
  raw: unknown;
}

/**
 * S2 F3: a channel's stored (unresolved) seat-list publish, for U8's
 * "Discard this change". `kind`: `owner_devices` for a `signOwnerDevices`
 * publish. `discardable`: `cancelPendingSeats` would discard it now (the
 * server never accepted these bytes).
 */
export interface PendingSeats {
  kind: "seats" | "owner_devices";
  reasonRequired: boolean;
  discardable: boolean;
}

/**
 * S2 F3: `cancelPendingSeats`. `none`: no stored seat publish; `busy`: an
 * owner flow on the channel is running; `maybe_accepted`: the server may
 * hold the bytes, so they stay and the next owner flow re-sends them.
 */
export type CancelPendingSeatsResult =
  | { discarded: true }
  | { discarded: false; why: "none" | "busy" | "maybe_accepted" };

/**
 * S2 (d) FX-R: what the manager hands `OwnerFlows.recoverOwnership`.
 * - `sign`: the `_seat_list_sign(recovery: true)` dialog, after the
 *   manager's own checks; called only when no recovery publish is stored.
 *   Answers native's raw result and the version of the server list it was
 *   signed over (the result must be that version + 1).
 * - `ensureLeaf`: creates the recovery successor when this device holds no
 *   leaf in the open group; runs before the first PUT of each attempt.
 * - `retryBudget`: re-sends (and re-reads) of a transient answer before the
 *   flow rejects; the stored bytes stay for the next call.
 */
export interface RecoveryPlan {
  retryBudget: number;
  sign(): Promise<{ signed: unknown; serverVersion: number }>;
  ensureLeaf(): Promise<void>;
}

/** B2 (`protectedTextOwner.ts`) signatures, injected by B5. */
export interface OwnerFlows {
  /**
   * `opts` (S4, R-W4-11, R-W4-23): `withHistory` protects a channel that
   * already has messages (a boundary genesis); `wipe` signs it
   * `pre_history: "wiped"`. Absent = the S1 protect.
   */
  protect(
    ops: GroupOps,
    port: ProtectedTextPort,
    channelId: string,
    seats: string[],
    deviceCap: number,
    opts?: { withHistory: boolean; wipe: boolean },
  ): Promise<void>;
  /**
   * S4 (design 6.3 "History setting"): sign and publish the next list with
   * `history: "visible" | "hidden"`. Optional only until the bridge's deps
   * literal lists it; the manager refuses `setHistoryVisible` without it.
   */
  setHistory?(
    ops: GroupOps,
    port: ProtectedTextPort,
    channelId: string,
    visible: boolean,
  ): Promise<void>;
  /**
   * S4 (design 4.9 "S4"): sign the one-change wipe list and POST it.
   * Optional for the same reason as `setHistory`.
   */
  wipeHistory?(
    ops: GroupOps,
    port: ProtectedTextPort,
    channelId: string,
  ): Promise<void>;
  /**
   * `reason` (S2 D40): the ALREADY-VALIDATED audit-log reason
   * (`validReason(s, "header").reason`), sent as `X-Audit-Log-Reason` on the
   * PUT of the stored signed bytes (never re-signed for it).
   */
  setSeats(
    ops: GroupOps,
    port: ProtectedTextPort,
    channelId: string,
    seats: string[],
    deviceCap: number,
    reason?: string,
  ): Promise<void>;
  /**
   * S2: `_authority_sign` naming `ownerDevices` (always a native dialog),
   * then `_seat_list_sign(authority)`, then the seat PUT.
   */
  signOwnerDevices(
    ops: GroupOps,
    port: ProtectedTextPort,
    channelId: string,
    ownerDevices: string[],
  ): Promise<void>;
  /**
   * S2-D42 (design 4.6): on the device that signed the served list only,
   * `_owner_handover_sign` to `toDeviceId`, another device of this user
   * (always a native dialog), then the next list this device signs over
   * the same seats, PUT with the statement as `handover`. A retry re-sends
   * the stored bytes and statement; nothing is signed again.
   */
  moveOwnerKey(
    ops: GroupOps,
    port: ProtectedTextPort,
    channelId: string,
    toDeviceId: string,
  ): Promise<void>;
  /** S2 F3: the stored seat publish (D7c store only), or null. */
  pendingSeats(port: ProtectedTextPort, channelId: string): PendingSeats | null;
  /**
   * S2 F3: drop the stored seat publish only if the server never accepted
   * it; never signs, never sends.
   */
  cancelPendingSeats(
    port: ProtectedTextPort,
    channelId: string,
  ): CancelPendingSeatsResult;
  /**
   * S2 (d) FX-R (design 6.3, 4.9, D7c): the recovery list as a stored
   * publish. A stored one is resumed (read back first, the SAME bytes, no
   * dialog); otherwise `plan.sign`, persist, `plan.ensureLeaf`, PUT. Only
   * the manager's `recoverOwnership` (a UI call) runs it.
   */
  recoverOwnership(
    ops: GroupOps,
    port: ProtectedTextPort,
    channelId: string,
    plan: RecoveryPlan,
  ): Promise<void>;
}

/** B4 (`protectedTextMessages.ts`) signatures, injected by B5. */
export interface MessageFlows {
  encryptAndSend(
    ops: GroupOps,
    port: ProtectedTextPort,
    channelId: string,
    text: string,
    replies: string[],
    silent: boolean,
    key: string,
  ): Promise<ProtectedSendOutcome>;
  /**
   * S4: `ops` may also carry the history lookups and the walk
   * (`HistoryOps`); `opts.batch` is the `decryptHistory` call the row
   * belongs to.
   */
  decryptRow(
    ops: RowOps,
    port: ProtectedTextPort,
    row: ProtectedMessageRow,
    live: boolean,
    opts?: { batch?: WalkBatch },
  ): Promise<ProtectedMessageView>;
  markerForError(err: unknown): ProtectedMarkerKind;
}

export interface ProtectedTextManagerCallbacks {
  onView(channelId: string, v: ProtectedChannelView): void;
  onMessageView(messageId: string, v: ProtectedMessageView): void;
  onTimelineMarker(channelId: string, m: TimelineMarker): void;
  /**
   * S4 (R-W4-4): the channel's history policy as native holds it. `verified`
   * false means "not known": the bridge reveals nothing and plaintext rows
   * stay stripped.
   */
  onHistoryPolicy(
    channelId: string,
    p: {
      verified: boolean;
      boundary: string | null;
      preHistory: PreHistorySetting | null;
      timeLimit: number | null;
    },
  ): void;
}

export interface ProtectedTextManagerDeps {
  owner: OwnerFlows;
  messages: MessageFlows;
  /**
   * S4 (design 8.5 "Refresh"): ask the bridge for a backup refresh; a no-op
   * unless native finds one due.
   */
  requestBackupRefresh(): void;
}

/** The manager's public surface (plan 4.3, RC NEW-8a). */
export interface ProtectedTextManagerApi {
  start(): Promise<void>;
  dispose(): void;
  onEnvelope(env: TextEnvelope): void;
  onJoinRequest(req: MlsJoinRequest, rejoin: boolean): void;
  onMessage(row: ProtectedMessageRow, live: boolean): void;
  decryptHistory(channelId: string, rows: ProtectedMessageRow[]): void;
  open(channelId: string): Promise<void>;
  close(channelId: string): void;
  flagStripped(channelId: string): void;
  channelProtected(channelId: string): void;
  confirmOwnerChange(channelId: string): Promise<void>;
  recreateGroup(channelId: string): Promise<void>;
  /**
   * `opts` (S4): see `OwnerFlows.protect`. With history opts set it is
   * refused while `port.historySetting()` is not true.
   */
  protect(
    channelId: string,
    seats: string[],
    deviceCap: number,
    opts?: { withHistory: boolean; wipe: boolean },
  ): Promise<void>;
  /**
   * S4: `OwnerFlows.setHistory`, then this device's self-Update when the
   * setting changed (design 6.3). Refused while the history flag is off.
   */
  setHistoryVisible(channelId: string, visible: boolean): Promise<void>;
  /**
   * S4: `OwnerFlows.wipeHistory`. Only this call starts a wipe; refused
   * while the history flag is off.
   */
  wipeHistory(channelId: string): Promise<void>;
  /**
   * S4: start (or join) the channel's history walk from the native
   * `history_floor`. Nothing while the history flag is off. Never a
   * security input.
   */
  walkHistory(channelId: string): void;
  /** `reason`: see `OwnerFlows.setSeats`; re-validated before it is sent. */
  setSeats(
    channelId: string,
    seats: string[],
    deviceCap: number,
    reason?: string,
  ): Promise<void>;
  /** S2: `OwnerFlows.signOwnerDevices`, with the publish bookkeeping. */
  authoritySign(channelId: string, ownerDevices: string[]): Promise<void>;
  /** S2-D42: `OwnerFlows.moveOwnerKey`, with the publish bookkeeping. */
  moveOwnerKey(channelId: string, toDeviceId: string): Promise<void>;
  /**
   * S2 (design 6.3 "Owner signing device lost"): only on another device of
   * the `signer_lost` user, and only when the UI calls it (never automatic).
   */
  recoverOwnership(channelId: string): Promise<void>;
  /** S2 F3: `OwnerFlows.pendingSeats` (pass-through). */
  pendingSeats(channelId: string): PendingSeats | null;
  /** S2 F3: `OwnerFlows.cancelPendingSeats` (pass-through). */
  cancelPendingSeats(channelId: string): CancelPendingSeatsResult;
  send(
    channelId: string,
    text: string,
    replies: string[],
    silent: boolean,
    key: string,
  ): Promise<ProtectedSendOutcome>;
  /**
   * S2 (design 7.5): a `ProtectedChannelChanged` refetch hint, `scope` as
   * received (unknown items are the manager's to ignore). Never a security
   * input.
   */
  onChannelChanged(channelId: string, scope: readonly string[]): void;
  /**
   * S2: one `refresh(id, "manual")` of a channel this manager holds; no
   * interval, dropped while a refresh of it is in flight. Never a security
   * input.
   */
  retryNow(channelId: string): void;
}

/** `new ProtectedTextManager(port, cb, deps)`. */
export type ProtectedTextManagerCtor = new (
  port: ProtectedTextPort,
  cb: ProtectedTextManagerCallbacks,
  deps: ProtectedTextManagerDeps,
) => ProtectedTextManagerApi;

// ---------------------------------------------------------------------------
// Bridge methods the UI calls (plan 4.3)
// ---------------------------------------------------------------------------

/**
 * The maps are the bridge's ReactiveMaps, typed read-only here so this
 * module stays free of Solid.
 */
export interface ProtectedUiApi {
  protectedTextCapable(): boolean;
  /**
   * S7 D9: a shell that runs the text plane once E2EE is on (the Tauri main
   * window; Electron and Android per their native capability and the server
   * flag). Picks `enable_e2ee` over `not_available` for an E2EE-off device.
   */
  structuralShell(): boolean;
  protectedOpen(channelId: string): void;
  protectedClose(channelId: string): void;
  /**
   * S2: one refresh of a channel, now, for a UI retry (D36 "Retry removal"
   * / "Rejoin", D39 "Finish now"). Unlike `protectedOpen` it never starts
   * the 60 s loop; dropped while a refresh of the channel runs and for a
   * channel the manager doesn't hold. Never a security input.
   */
  retryNow(channelId: string): void;
  /**
   * `opts` (S4, R-W4-11): `withHistory` protects a channel that already has
   * messages (a boundary genesis); `wipe` signs it `pre_history: "wiped"`
   * (the confirmation is the native dialog). Absent = the S1 protect.
   */
  protect(
    channelId: string,
    seats: string[],
    deviceCap: number,
    opts?: { withHistory: boolean; wipe: boolean },
  ): Promise<void>;
  /** S4: sign the next list with `history: "visible" | "hidden"`. */
  setHistoryVisible(channelId: string, visible: boolean): Promise<void>;
  /**
   * S4: sign the one-change wipe list (`pre_history: "wiped"`) and ask the
   * server to wipe. The only confirmation is the native dialog.
   */
  wipeHistory(channelId: string): Promise<void>;
  /** S4: start (or retry) the channel's history walk; never a security input. */
  walkHistory(channelId: string): void;
  /**
   * `reason` (S2 D40): the unseat reason, validated by the caller with
   * `validReason(s, "header")`; checked again before it is sent.
   */
  setSeats(
    channelId: string,
    seats: string[],
    deviceCap: number,
    reason?: string,
  ): Promise<void>;
  confirmOwnerChange(channelId: string): Promise<void>;
  recreateGroup(channelId: string): Promise<void>;
  /**
   * S2: re-sign the channel authority naming `ownerDevices` (native dialog),
   * then the seat list carrying it.
   */
  authoritySign(channelId: string, ownerDevices: string[]): Promise<void>;
  /**
   * S2-D42 "Move ownership key": hand the owner key from this device (it
   * must have signed the served list) to `toDeviceId`, another device of
   * this user, behind a native dialog. Offer only
   * `ownerKeyMoveTargets(seatsSnapshot(id), selfDeviceId(), own device
   * ids)`; show session names, never ids. Client refusals (reason):
   * `handover_self_target`, `handover_target_not_own`,
   * `not_signing_device`, `authority_held`.
   */
  moveOwnerKey(channelId: string, toDeviceId: string): Promise<void>;
  /**
   * S2 (design 6.3): recover ownership on this device after the signer
   * device was lost. Never automatic: only this call starts it.
   */
  recoverOwnership(channelId: string): Promise<void>;
  /**
   * S2 F3: the channel's stored (unresolved) seat-list publish, or null.
   * U8 offers "Discard this change" while it is non-null (enabled when
   * `discardable`). Reactive through the channel's view.
   */
  pendingSeats(channelId: string): PendingSeats | null;
  /**
   * S2 F3: discard that publish ONLY if the server never accepted it; a
   * publish it may have accepted is kept (`maybe_accepted`). Never signs.
   */
  cancelPendingSeats(channelId: string): Promise<CancelPendingSeatsResult>;
  /**
   * S2-D36: the channel's view plus the three inputs it does not carry,
   * ready for `resecureCause`; null while the manager has no view of it.
   */
  resecureInputs(channelId: string): ResecureInputs | null;
  /**
   * This device's id (E2EE status), or null while unknown. For comparisons
   * only (e.g. `proposedOwnerDevices(seatsSnapshot(id), selfDeviceId())`);
   * never rendered.
   */
  selfDeviceId(): string | null;
  /** The last `GET .../seats` body, or null. */
  seatsSnapshot(channelId: string): ProtectedSeatsResponse | null;
  protectedFlag(): ProtectedChannelsFlag;
  readonly protectedChannels: ReadonlyMap<string, ProtectedChannelView>;
  readonly protectedViews: ReadonlyMap<string, ProtectedMessageView>;
  readonly protectedTimelineMarkers: ReadonlyMap<
    string,
    readonly TimelineMarker[]
  >;
}

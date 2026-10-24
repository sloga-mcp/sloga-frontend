/**
 * Shared types for Protected channels (text plane), W4 lane A1.
 *
 * Every later W4 module (shield, policy, ids, router, manager, owner and
 * message flows, bridge seam, hooks, UI) imports its cross-file shapes from
 * here, so no lane mints its own copy of a native or server shape.
 *
 * Rules:
 * - Native mirrors follow the pinned native sources (`e2ee-core`
 *   `mls/text/types.rs` and `error.rs`, copies in `/home/mcp/w4-notes/`):
 *   struct fields snake_case as named, enums snake_case, and every Rust
 *   `Option` arrives as `null` (no `skip_serializing_if` on these structs),
 *   so it is `T | null` here, never an optional key.
 * - Command arguments follow Tauri's mapping: top-level argument names in
 *   camelCase, nested structs snake_case.
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
  MlsSubmitCommit,
} from "./e2ee";

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

export type PinSource = "protect" | "first_sight" | "handover" | "confirmed";

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
  verdict: TextVerdict;
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
}

/** `e2ee_text_seat_list_sign`. Persists nothing natively. */
export interface SignedSeatList {
  version: number;
  body: string;
  signature: string;
  signer_user_id: string;
  signer_device_id: string;
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
// Commands (20: design 8.3 + W3 D12 `_mark_left` + W3 D7 `_pin_own_devices`)
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
  "e2ee_text_remove",
  "e2ee_text_update",
  "e2ee_text_state",
  "e2ee_text_mark_left",
  "e2ee_text_pin_own_devices",
  "e2ee_mls_group_kind",
] as const;

export type TextCommand = (typeof TEXT_COMMANDS)[number];

/** Why the bridge moves a group to `left` (`e2ee_text_mark_left`). */
export const TEXT_LEFT_REASONS = [
  "not_member",
  "not_found",
  "catch_up_failed",
] as const;

export type TextLeftReason = (typeof TEXT_LEFT_REASONS)[number];

/** Dialog copy arguments shared by the three dialog commands (W3 D16). */
export interface TextDialogCopyArgs {
  channelName: string | null;
  displayNames: DisplayName[];
}

/** Per-command arguments (camelCase top level, snake_case nested). */
export interface TextCommandArgs {
  e2ee_text_group_create: {
    channelId: string;
    userId: string;
    supersedes: string | null;
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
  /** `envelope` WITHOUT `recipientDeviceId` (native may deny unknown keys). */
  e2ee_text_process: { envelope: TextWireEnvelope; userId: string };
  /**
   * `storedCommitB64` is the DS's stored string on a refetch path, our own
   * bytes only on a plain 2xx (plan D20). `rejoinIntents` (W3 D11, plan D24)
   * comes from `MlsCommitInfo`; `[]` on the 2xx path.
   */
  e2ee_text_commit_won: {
    groupId: string;
    wonEpoch: number;
    storedCommitB64: string;
    rejoinIntents: MlsJoinRequest[];
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
  /** `serverList` null only when the server holds no list (genesis). */
  e2ee_text_seat_list_sign: TextDialogCopyArgs & {
    channelId: string;
    userId: string;
    seats: string[];
    deviceCap: number;
    serverList: ServerSeatList | null;
  };
  /**
   * `asOfEpoch` / `asOfGroupId` from `GET .../seats` (W3 D14, plan D24):
   * required by native whenever this device holds a group; null only when it
   * holds none (plan D26 first-sight verify).
   */
  e2ee_text_seat_list_verify: {
    channelId: string;
    list: SeatListInput;
    handovers: SignedHandover[];
    serverOwnerId: string;
    asOfEpoch: number | null;
    asOfGroupId: string | null;
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
   */
  e2ee_text_remove: {
    groupId: string;
    targets: MlsMemberDevice[];
    rejoinIntent: MlsJoinRequest | null;
    pendingRemovalUsers: string[];
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
}

/** Per-command results. Rust `()` arrives as `null`. */
export interface TextCommandResult {
  e2ee_text_group_create: TextGroupCreated;
  e2ee_text_join: MlsJoinIntentPayload;
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
  e2ee_text_remove: TextSubmitCommitPayload;
  e2ee_text_update: TextSubmitCommitPayload;
  e2ee_text_state: TextChannelState;
  e2ee_text_mark_left: null;
  /** Unspecified by the native plan; read nothing from it. */
  e2ee_text_pin_own_devices: unknown;
  e2ee_mls_group_kind: GroupKind | null;
}

export type _TextCommandArgsComplete = Assert<
  Equal<TextCommand, keyof TextCommandArgs>
>;
export type _TextCommandResultComplete = Assert<
  Equal<TextCommand, keyof TextCommandResult>
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
  | "too_many_seats";

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
] as const;

export type NativeErrorTag = (typeof NATIVE_ERROR_TAGS)[number];

/**
 * The text-plane tags: every W3 variant (design 8.4 table plus W3's
 * `identity_pin_required` / `handover_target_invalid`) and the existing
 * variants design 8.4 says apply to text groups. Plan D17's total mapping
 * must name each of these; any other `NativeErrorTag` (e.g. `busy`,
 * `storage`, `not_enabled`) and any untyped rejection go to the fail-closed
 * catch-all.
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
  | { type: "handover_target_invalid"; channel_id: string };

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
  cooling: { user_id: string; released_at: string; cooldown_until: string }[];
}

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
}

/** Plan D13 flag (`GET /`); absent/malformed/failed is `enabled: false`. */
export interface ProtectedChannelsFlag {
  enabled: boolean;
  defaultDeviceCap: number | null;
}

// ---------------------------------------------------------------------------
// Courier (plan D6)
// ---------------------------------------------------------------------------

export type TextApiMethod = "GET" | "POST" | "PUT" | "DELETE";

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
  | "unknown_key" // MlsGroupNotFound on decrypt (gray)
  | "decrypt_failed" // UnknownEpoch, epoch > current after one catch-up (red)
  | "unverified_sender" // UnknownSender, BadSig on a message (red)
  | "removed_sender" // RemovedSender (red)
  | "replay" // Replay (red)
  | "malformed" // MalformedTextPayload (red)
  | "unencrypted_row" // no `encrypted` in a protected/pinned channel (red)
  | "error"; // any other or unknown error (red, fail closed)

/** Plan D22, verbatim. */
export type ProtectedMessageView =
  | { status: "pending" }
  | {
      status: "ok";
      text: string;
      replies: string[];
      senderVerified: boolean;
      tsSkew: boolean;
      cid: string;
    }
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
}

/** Toasts the manager raises through `port.notify` (D22). */
export type ProtectedToastKind = "unsolicited_welcome";

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
  /** This user's COMPLETE signed listing and a hash to detect changes. */
  ownDeviceListing(): Promise<{ hash: string; listing: unknown[] }>;
  api(
    method: TextApiMethod,
    path: string,
    body?: unknown,
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
}

/** Why a refresh runs (D8, D26). */
export type TextRefreshReason =
  | "open"
  | "interval"
  | "commit"
  | "resecuring"
  | "start"
  | "owner_confirmed"
  | "send_refused";

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

/** B2 (`protectedTextOwner.ts`) signatures, injected by B5. */
export interface OwnerFlows {
  protect(
    ops: GroupOps,
    port: ProtectedTextPort,
    channelId: string,
    seats: string[],
    deviceCap: number,
  ): Promise<void>;
  setSeats(
    ops: GroupOps,
    port: ProtectedTextPort,
    channelId: string,
    seats: string[],
    deviceCap: number,
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
  decryptRow(
    ops: GroupOps,
    port: ProtectedTextPort,
    row: ProtectedMessageRow,
    live: boolean,
  ): Promise<ProtectedMessageView>;
  markerForError(err: unknown): ProtectedMarkerKind;
}

export interface ProtectedTextManagerCallbacks {
  onView(channelId: string, v: ProtectedChannelView): void;
  onMessageView(messageId: string, v: ProtectedMessageView): void;
  onTimelineMarker(channelId: string, m: TimelineMarker): void;
}

export interface ProtectedTextManagerDeps {
  owner: OwnerFlows;
  messages: MessageFlows;
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
  protect(channelId: string, seats: string[], deviceCap: number): Promise<void>;
  setSeats(
    channelId: string,
    seats: string[],
    deviceCap: number,
  ): Promise<void>;
  send(
    channelId: string,
    text: string,
    replies: string[],
    silent: boolean,
    key: string,
  ): Promise<ProtectedSendOutcome>;
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
  protectedOpen(channelId: string): void;
  protectedClose(channelId: string): void;
  protect(channelId: string, seats: string[], deviceCap: number): Promise<void>;
  setSeats(
    channelId: string,
    seats: string[],
    deviceCap: number,
  ): Promise<void>;
  confirmOwnerChange(channelId: string): Promise<void>;
  recreateGroup(channelId: string): Promise<void>;
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

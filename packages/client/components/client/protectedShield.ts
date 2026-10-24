/**
 * Protected channel shield, notices and hidden actions (W4 lane A2).
 *
 * Pure (no Solid, livekit or lingui) so `node --test` can load it. Copy is
 * not here: this module returns kinds and ids, and `protectedCopy.ts` (C0)
 * maps each kind to a lingui string.
 *
 * - `computeShieldState` / `explainShield`: design 9.1, first match wins,
 *   steps 1-9 including 6c, 6d and 6e. GREEN (`protected`) comes only from
 *   step 8, which needs the native verdict `ok`; it is never derived from a
 *   server field, and never shown while any leaf is off the signed list or
 *   locally removed.
 * - `shieldPresentation`: plan D14 glyph, hue variable, name tint, composer
 *   mode and default notice per state.
 * - `protectedNoticeForError`: plan D17, total over every text-plane native
 *   tag (a `Record` keyed by `TextNativeErrorTag`, so a new tag fails tsc),
 *   every design 7.6 server type and the D17 extras; anything else fails
 *   closed (red marker for a message, `unverified` otherwise).
 * - `protectedActionsBlocked`: plan D11.
 *
 * Nothing here holds key material or message text.
 */
import type {
  NativeErrorTag,
  ProtectedChannelView,
  ProtectedMarkerKind,
  ProtectedTextGroupResponse,
  ProtectedToastKind,
  TextChannelState,
  TextNativeErrorTag,
  ViewErrorTag,
} from "./protectedTextTypes";
import { NATIVE_ERROR_TAGS } from "./protectedTextTypes.ts";

/** Defined by lane A1; re-exported, never redefined (W4a-1 ruling 3). */
export type { ProtectedMarkerKind } from "./protectedTextTypes";

// ---------------------------------------------------------------------------
// Shield state (design 9.1)
// ---------------------------------------------------------------------------

export const PROTECTED_SHIELD_STATES = [
  "protected",
  "resecuring",
  "not_seated",
  "not_available",
  "unverified",
  "grace",
  "frozen",
] as const;

/**
 * `grace` and `frozen` are reserved for S5: typed and presented, never
 * produced in S1.
 */
export type ProtectedShieldState = (typeof PROTECTED_SHIELD_STATES)[number];

/** Grace window for `native.verdict == "roster_mismatch"` (9.1 step 6). */
export const ROSTER_MISMATCH_UNVERIFIED_MS = 60_000;

/** The join-retry budget for `SignerLeafMissing` (9.1 step 6c). */
export const SIGNER_LEAF_MISSING_UNVERIFIED_RETRIES = 3;

/** Step 3: a `seatListError` in this set is `unverified`. */
export const SHIELD_LOUD_SEAT_LIST_ERRORS = [
  "bad_sig",
  "owner_changed",
  "seat_list_rollback",
  "seat_list_equivocation",
  "seat_list_invalid",
] as const satisfies readonly NativeErrorTag[];

/** Step 3: a `groupError` in this set is `unverified`. */
export const SHIELD_LOUD_GROUP_ERRORS = [
  "channel_mismatch",
  "roster_mismatch",
  "mls_leaf_rejected",
  "owner_changed",
  "seat_list_equivocation",
  "wrong_group_kind",
  "bad_sig",
  "seat_list_invalid",
  "text_group_full",
  "not_owner",
  "commit_declaration_mismatch",
  "duplicate_leaf",
  "replayed_rejoin_intent",
] as const satisfies readonly NativeErrorTag[];

/** Step 6e: never `unverified` by themselves; they fall through. */
export const SHIELD_FALL_THROUGH_GROUP_ERRORS = [
  "own_commit_mismatch",
  "already_member",
  "unexpected_mls_content",
] as const satisfies readonly NativeErrorTag[];

/**
 * Step 3b (fail closed, design 9.2 catch-all and plan D17): a `groupError`
 * outside step 3, step 6e and this set is `unverified`. These are the tags
 * design 9.2 / plan D24 map to `resecuring` or "unchanged" for a
 * channel-level call; the later steps decide from the native verdict.
 */
export const SHIELD_BENIGN_GROUP_ERRORS = [
  ...SHIELD_FALL_THROUGH_GROUP_ERRORS,
  "unknown_epoch",
  "not_seated",
  "signer_leaf_missing",
  "update_required",
  "mls_group_not_found",
  "mls_epoch_gap",
  "mls_poisoned_epoch",
  "mls_unsolicited_welcome",
  "seat_list_behind",
  "declined",
] as const satisfies readonly NativeErrorTag[];

/** Step 3b for `seatListError` (D24: gap refetch, join path, behind). */
export const SHIELD_BENIGN_SEAT_LIST_ERRORS = [
  "not_seated",
  "mls_epoch_gap",
  "mls_group_not_found",
  "seat_list_behind",
  "declined",
] as const satisfies readonly NativeErrorTag[];

/** The design 9.1 inputs plus `capable` per plan D3. */
export interface ShieldInputs {
  serverProtected: boolean;
  /** The SDK's one-way local pin (`client.protectedPins`). */
  locallyPinned: boolean;
  /**
   * Plan D3 `protectedTextCapable()`: Tauri transport, not a popout or
   * overlay window, E2EE provisioned and enabled, store and device owned by
   * this account. Anything but `true` is `not_available`.
   */
  capable: boolean;
  seatListError: ViewErrorTag | null;
  groupError: ViewErrorTag | null;
  native: TextChannelState | null;
  serverGroup: ProtectedTextGroupResponse | null;
  /** How long the verdict has been `roster_mismatch` (0 otherwise). */
  rosterMismatchAgeMs: number;
  signerLeafMissingRetries: number;
  welcomeRetriesExhausted: boolean;
  /** Notice only (never the state): D3 `enable_e2ee` vs `not_available`. */
  tauriE2eeOff?: boolean;
  /** Notice only (never the state): D15 "Review owner change" is offered. */
  ownerChangePending?: boolean;
}

/** Which design 9.1 step decided (`3b` is the fail-closed error catch-all). */
export type ShieldStep =
  | "1"
  | "2"
  | "3"
  | "3b"
  | "4"
  | "5"
  | "6"
  | "6c"
  | "6d"
  | "7"
  | "8"
  | "9";

export interface ShieldExplanation {
  state: ProtectedShieldState;
  step: ShieldStep;
  /** The most specific notice for this state; null only for `protected`. */
  notice: ProtectedNoticeKind | null;
}

const has = (list: readonly string[], tag: string | null): boolean =>
  tag !== null && list.includes(tag);

/**
 * Green additionally needs a self-consistent native state (defence in
 * depth over the verdict): an `ok` verdict that disagrees with its own
 * members, seat or pin fields is step 9, never green.
 */
function nativeConsistentlyOk(n: TextChannelState): boolean {
  return (
    n.verdict === "ok" &&
    n.state === "active" &&
    n.self_seated === true &&
    n.roster_matches_list === true &&
    n.owner_pin?.status !== "changed" &&
    Array.isArray(n.members) &&
    n.members.every(
      (m) => m.on_signed_list === true && m.removed_locally !== true,
    )
  );
}

/** Step 7's server-side terms; malformed or non-finite values count. */
function serverSaysResecuring(
  n: TextChannelState,
  g: ProtectedTextGroupResponse | null,
): boolean {
  if (!g) return false;
  if (!Array.isArray(g.pending_removals) || g.pending_removals.length > 0) {
    return true;
  }
  if (n.group_id !== g.group_id) return true;
  // `!(a >= b)` so a null or NaN epoch counts as behind.
  return !((n.epoch ?? Number.NaN) >= g.current_epoch);
}

function ownerChangeNotice(i: ShieldInputs): ProtectedNoticeKind {
  const signer = i.native?.owner_pin?.pending_signer ?? null;
  if (i.ownerChangePending === true || signer?.same_user === true) {
    return "owner_changed_review";
  }
  if (signer !== null && signer.same_user === false) {
    return "owner_changed_locked";
  }
  return "unverified";
}

/** The step 3 notice: the most specific cause, seat list first. */
function loudNotice(i: ShieldInputs): ProtectedNoticeKind {
  const s = i.seatListError;
  const g = i.groupError;
  if (
    s === "owner_changed" ||
    g === "owner_changed" ||
    i.native?.verdict === "owner_changed"
  ) {
    return ownerChangeNotice(i);
  }
  if (has(SHIELD_LOUD_SEAT_LIST_ERRORS, s)) return "seat_list_failed";
  switch (g) {
    case "bad_sig":
    case "seat_list_invalid":
    case "seat_list_equivocation":
      return "seat_list_failed";
    case "channel_mismatch":
    case "wrong_group_kind":
      return "security_check_failed";
    case "replayed_rejoin_intent":
      return "replayed_change";
    default:
      return "invalid_change";
  }
}

/**
 * Design 9.1 with the step that decided and the notice to show. Returns
 * null for a channel that is neither server-protected nor pinned (no
 * shield).
 */
export function explainShield(i: ShieldInputs): ShieldExplanation | null {
  const serverProtected = i.serverProtected === true;
  const pinned = i.locallyPinned === true;
  if (!serverProtected && !pinned) return null;

  // 1. The server stripped a flag this device saw.
  if (pinned && !serverProtected) {
    return { state: "unverified", step: "1", notice: "flag_stripped" };
  }
  // 2. No usable native text plane here (plan D3).
  if (i.capable !== true) {
    return {
      state: "not_available",
      step: "2",
      notice: i.tauriE2eeOff === true ? "enable_e2ee" : "not_available",
    };
  }
  // 3. Verification failed or the server contradicted a pin.
  if (
    has(SHIELD_LOUD_SEAT_LIST_ERRORS, i.seatListError) ||
    has(SHIELD_LOUD_GROUP_ERRORS, i.groupError) ||
    i.native?.verdict === "owner_changed"
  ) {
    return { state: "unverified", step: "3", notice: loudNotice(i) };
  }
  // 3b. Any other error tag (incl. "unknown") fails closed.
  if (
    (i.seatListError !== null &&
      !has(SHIELD_BENIGN_SEAT_LIST_ERRORS, i.seatListError)) ||
    (i.groupError !== null && !has(SHIELD_BENIGN_GROUP_ERRORS, i.groupError))
  ) {
    return { state: "unverified", step: "3b", notice: "unverified" };
  }
  const n = i.native;
  // 4. Still loading.
  if (!n) {
    return { state: "resecuring", step: "4", notice: "resecuring" };
  }
  // 5.
  if (n.verdict === "not_seated") {
    return { state: "not_seated", step: "5", notice: "not_seated" };
  }
  // 6. An off-list leaf: brief during a legitimate unseat, hostile after.
  if (n.verdict === "roster_mismatch") {
    return i.rosterMismatchAgeMs < ROSTER_MISMATCH_UNVERIFIED_MS
      ? { state: "resecuring", step: "6", notice: "resecuring" }
      : { state: "unverified", step: "6", notice: "off_list_member" };
  }
  // 6c. `!(x < budget)` so a non-finite count fails closed.
  if (!(i.signerLeafMissingRetries < SIGNER_LEAF_MISSING_UNVERIFIED_RETRIES)) {
    return { state: "unverified", step: "6c", notice: "join_stalled" };
  }
  // 6d. The R5 stranded Welcome is never an endless `resecuring`.
  if (i.welcomeRetriesExhausted === true) {
    return { state: "unverified", step: "6d", notice: "join_stalled" };
  }
  // 6e. `own_commit_mismatch`, `already_member`, `unexpected_mls_content`
  // fell through step 3 / 3b on purpose (SHIELD_BENIGN_GROUP_ERRORS).
  // 7.
  if (
    n.verdict === "no_group" ||
    n.verdict === "joining" ||
    n.verdict === "poisoned" ||
    n.verdict === "no_seat_list" ||
    serverSaysResecuring(n, i.serverGroup)
  ) {
    return { state: "resecuring", step: "7", notice: "resecuring" };
  }
  // 8. The ONLY source of green.
  if (nativeConsistentlyOk(n)) {
    return { state: "protected", step: "8", notice: null };
  }
  // 9. Fail closed.
  return { state: "unverified", step: "9", notice: "unverified" };
}

/** Design 9.1 state; null when the channel has no shield. */
export function computeShieldState(
  i: ShieldInputs,
): ProtectedShieldState | null {
  return explainShield(i)?.state ?? null;
}

/**
 * Builds `ShieldInputs` from the manager's view (plan D22) and the
 * SDK/bridge flags. `rosterMismatchSinceMs` becomes an age at `nowMs`; a
 * clock that went backwards reads as age 0. A null view is "loading".
 */
export function shieldInputsFromView(
  view: ProtectedChannelView | null | undefined,
  flags: {
    serverProtected: boolean;
    locallyPinned: boolean;
    capable: boolean;
    tauriE2eeOff?: boolean;
  },
  nowMs: number,
): ShieldInputs {
  const since = view?.rosterMismatchSinceMs ?? null;
  return {
    serverProtected: flags.serverProtected,
    locallyPinned: flags.locallyPinned,
    capable: flags.capable,
    tauriE2eeOff: flags.tauriE2eeOff,
    seatListError: view?.seatListError ?? null,
    groupError: view?.groupError ?? null,
    native: view?.native ?? null,
    serverGroup: view?.serverGroup ?? null,
    rosterMismatchAgeMs: since === null ? 0 : Math.max(0, nowMs - since),
    signerLeafMissingRetries: view?.signerLeafMissingRetries ?? 0,
    welcomeRetriesExhausted: view?.welcomeRetriesExhausted ?? false,
    ownerChangePending: view?.ownerChangePending ?? false,
  };
}

// ---------------------------------------------------------------------------
// Presentation (plan D14)
// ---------------------------------------------------------------------------

/** Material symbols (0.36) names. */
export type ProtectedShieldGlyph =
  | "verified_user"
  | "shield"
  | "remove_moderator"
  | "gpp_bad";

/** CSS custom properties defined once in `LoadTheme.tsx` (lane C14). */
export type ProtectedHueVar =
  | "--sloga-protected-ok"
  | "--sloga-protected-resecuring"
  | "--sloga-protected-alert"
  | "--sloga-protected-unavailable"
  | "--sloga-protected-grace"
  | "--sloga-protected-frozen";

/** `enabled` only in `protected` (design 9.1). */
export type ProtectedComposerMode = "enabled" | "disabled" | "hidden";

export interface ShieldPresentation {
  glyph: ProtectedShieldGlyph;
  /** The variable NAME; render as `var(<hueVar>)`. */
  hueVar: ProtectedHueVar;
  /**
   * The state allows tinting the channel NAME. The caller also requires
   * attention `normal` (D14, F9: resecuring never tints).
   */
  tintName: boolean;
  composer: ProtectedComposerMode;
  /** The state's default notice; `explainShield` may be more specific. */
  notice: ProtectedNoticeKind | null;
}

export function shieldPresentation(
  state: ProtectedShieldState,
  opts: { tauriE2eeOff?: boolean } = {},
): ShieldPresentation {
  switch (state) {
    case "protected":
      return {
        glyph: "verified_user",
        hueVar: "--sloga-protected-ok",
        tintName: true,
        composer: "enabled",
        notice: null,
      };
    case "resecuring":
      return {
        glyph: "shield",
        hueVar: "--sloga-protected-resecuring",
        tintName: false,
        composer: "disabled",
        notice: "resecuring",
      };
    case "not_seated":
      return {
        glyph: "shield",
        hueVar: "--sloga-protected-unavailable",
        tintName: false,
        composer: "hidden",
        notice: "not_seated",
      };
    case "not_available":
      return {
        glyph: "remove_moderator",
        hueVar: "--sloga-protected-unavailable",
        tintName: true,
        composer: "hidden",
        notice: opts.tauriE2eeOff === true ? "enable_e2ee" : "not_available",
      };
    case "unverified":
      return {
        glyph: "gpp_bad",
        hueVar: "--sloga-protected-alert",
        tintName: true,
        composer: "hidden",
        notice: "unverified",
      };
    // S5 reserved: read-only until S5 defines them.
    case "grace":
      return {
        glyph: "verified_user",
        hueVar: "--sloga-protected-grace",
        tintName: false,
        composer: "hidden",
        notice: "not_available",
      };
    case "frozen":
      return {
        glyph: "shield",
        hueVar: "--sloga-protected-frozen",
        tintName: false,
        composer: "hidden",
        notice: "not_available",
      };
    default: {
      const _x: never = state;
      throw new Error(`unknown protected shield state ${String(_x)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Notices and error mapping (design 9.2, plan D17)
// ---------------------------------------------------------------------------

/** Every channel-level notice C0 must give copy to. */
export const PROTECTED_NOTICE_KINDS = [
  // shield states
  "resecuring",
  "not_seated",
  "not_available",
  "enable_e2ee",
  "unverified",
  // specific `unverified` causes
  "flag_stripped",
  "seat_list_failed",
  "off_list_member",
  "invalid_change",
  "replayed_change",
  "security_check_failed",
  "owner_changed_review",
  "owner_changed_locked",
  "join_stalled",
  // flows
  "channel_full",
  "seat_cap_reached",
  "device_cap_reached",
  "not_owner",
  "seat_list_behind",
  "protect_failed",
  "channel_protected",
  "ownership_transfer_blocked",
  "encryption_unavailable",
  "protected_channels_unavailable",
  "send_refused",
  "maybe_unsent",
  "network_error",
] as const;

export type ProtectedNoticeKind = (typeof PROTECTED_NOTICE_KINDS)[number];

/**
 * Where the failure surfaced:
 * - `message`: decrypting a row (answers with a marker);
 * - `channel`: join / process / verify / state (channel-level);
 * - `send`: `_encrypt` or the protected POST;
 * - `owner`: protect, seats, owner-change confirm, re-create;
 * - `action`: a server action refused on a protected channel;
 * - `transfer`: a server ownership-transfer request.
 */
export type ProtectedErrorOp =
  | "message"
  | "channel"
  | "send"
  | "owner"
  | "action"
  | "transfer";

export interface ProtectedErrorContext {
  op: ProtectedErrorOp;
  /** `message` + `unknown_epoch` ahead of `current`: one catch-up ran. */
  catchUpDone?: boolean;
}

/**
 * - `notice`: show this notice (`max` fills `{max}`, null when absent);
 * - `marker`: render this marker instead of the message body;
 * - `toast`: raise this toast;
 * - `none`: no UI; the bridge handles it (retry, catch-up, ack + drop) or
 *   the user cancelled a native dialog.
 * `tag` is the matched native tag / server type, or `"unknown"` for the
 * catch-all; for logs (ids only).
 */
export type ProtectedErrorUi =
  | {
      kind: "notice";
      notice: ProtectedNoticeKind;
      max: number | null;
      tag: string;
    }
  | { kind: "marker"; marker: ProtectedMarkerKind; tag: string }
  | { kind: "toast"; toast: ProtectedToastKind; tag: string }
  | { kind: "none"; tag: string };

type Fields = Readonly<Record<string, unknown>>;
type Rule = (f: Fields, ctx: ProtectedErrorContext) => ProtectedErrorUi;

const notice = (
  n: ProtectedNoticeKind,
  tag: string,
  max: number | null = null,
): ProtectedErrorUi => ({ kind: "notice", notice: n, max, tag });
const marker = (m: ProtectedMarkerKind, tag: string): ProtectedErrorUi => ({
  kind: "marker",
  marker: m,
  tag,
});
const none = (tag: string): ProtectedErrorUi => ({ kind: "none", tag });

/** A non-negative safe integer, else null. */
function count(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** The fail-closed answer for anything unmapped. */
function catchAll(ctx: ProtectedErrorContext): ProtectedErrorUi {
  return ctx.op === "message"
    ? marker("error", "unknown")
    : notice("unverified", "unknown");
}

/** Message rows: everything not listed is the red `error` marker. */
function onMessage(
  tag: TextNativeErrorTag,
  f: Fields,
  ctx: ProtectedErrorContext,
) {
  switch (tag) {
    case "unknown_epoch": {
      const epoch = count(f.epoch);
      const oldest = count(f.oldest_held);
      const current = count(f.current);
      if (epoch !== null && oldest !== null && epoch < oldest) {
        return marker("sent_before_join", tag);
      }
      if (epoch !== null && current !== null && epoch > current) {
        return ctx.catchUpDone === true
          ? marker("decrypt_failed", tag)
          : none(tag);
      }
      return marker("decrypt_failed", tag);
    }
    case "unknown_sender":
    case "bad_sig":
      return marker("unverified_sender", tag);
    case "removed_sender":
      return marker("removed_sender", tag);
    case "replay":
      return marker("replay", tag);
    case "malformed_text_payload":
      return marker("malformed", tag);
    case "mls_group_not_found":
      return marker("unknown_key", tag);
    default:
      return marker("error", tag);
  }
}

const resecuring: Rule = () => notice("resecuring", "");

/**
 * Plan D17 over every text-plane native tag, for every op but `message`.
 * Keyed by `TextNativeErrorTag`: a tag added to A1 without a rule here
 * fails tsc.
 */
const NATIVE_RULES: Record<TextNativeErrorTag, Rule> = {
  unknown_epoch: resecuring,
  unknown_sender: () => notice("unverified", ""),
  bad_sig: () => notice("seat_list_failed", ""),
  not_seated: () => notice("not_seated", ""),
  roster_mismatch: (_f, c) =>
    notice(c.op === "send" ? "resecuring" : "invalid_change", ""),
  // A malformed `same_user` claims neither dialog: generic, fail closed.
  owner_changed: (f) =>
    notice(
      f.same_user === true
        ? "owner_changed_review"
        : f.same_user === false
          ? "owner_changed_locked"
          : "unverified",
      "",
    ),
  signer_leaf_missing: resecuring,
  commit_declaration_mismatch: () => notice("invalid_change", ""),
  not_owner: (_f, c) =>
    notice(c.op === "channel" ? "invalid_change" : "not_owner", ""),
  seat_list_rollback: () => notice("seat_list_failed", ""),
  seat_list_equivocation: () => notice("seat_list_failed", ""),
  seat_list_behind: () => notice("seat_list_behind", ""),
  seat_list_invalid: () => notice("seat_list_failed", ""),
  removed_sender: () => notice("unverified", ""),
  replay: () => notice("unverified", ""),
  channel_mismatch: () => notice("security_check_failed", ""),
  already_member: () => none(""),
  own_commit_mismatch: resecuring,
  duplicate_leaf: () => notice("invalid_change", ""),
  replayed_rejoin_intent: () => notice("replayed_change", ""),
  unexpected_mls_content: () => none(""),
  // Transparent (the bridge commits `_update` and retries once); a send
  // that still fails keeps its draft under the re-securing notice.
  update_required: (_f, c) =>
    c.op === "send" ? notice("resecuring", "") : none(""),
  text_group_full: (f) => notice("channel_full", "", count(f.max)),
  malformed_text_payload: (_f, c) =>
    notice(c.op === "send" ? "send_refused" : "unverified", ""),
  wrong_group_kind: () => notice("security_check_failed", ""),
  // Retried once after a pin (D18); a second one is a bounded failure.
  identity_pin_required: () => notice("unverified", ""),
  // Handover UI is S2; an S1 caller fails closed.
  handover_target_invalid: () => notice("unverified", ""),
  mls_group_not_found: resecuring,
  mls_unsolicited_welcome: () => ({
    kind: "toast",
    toast: "unsolicited_welcome",
    tag: "",
  }),
  mls_leaf_rejected: () => notice("invalid_change", ""),
  mls_epoch_gap: resecuring,
  mls_poisoned_epoch: resecuring,
  declined: () => none(""),
};

/** Design 7.6 server types plus the D17 extras (PascalCase on the wire). */
export const PROTECTED_SERVER_ERROR_TYPES = [
  "ProtectedChannelResecuring",
  "NotSeated",
  "SeatCapReached",
  "ChannelProtected",
  "ProtectedFieldRefused",
  "DeviceCapReached",
  "DuplicateNonce",
  "FeatureDisabled",
  "MlsCallFull",
] as const;

export type ProtectedServerErrorType =
  (typeof PROTECTED_SERVER_ERROR_TYPES)[number];

const SERVER_RULES: Record<ProtectedServerErrorType, Rule> = {
  ProtectedChannelResecuring: () => notice("resecuring", ""),
  NotSeated: () => notice("not_seated", ""),
  SeatCapReached: (f) => notice("seat_cap_reached", "", count(f.max)),
  ChannelProtected: (_f, c) =>
    notice(
      c.op === "transfer" ? "ownership_transfer_blocked" : "channel_protected",
      "",
    ),
  ProtectedFieldRefused: () => notice("send_refused", ""),
  DeviceCapReached: (f) => notice("device_cap_reached", "", count(f.max)),
  // Possibly delivered: the bridge refetch-confirms first (D10); reaching
  // the UI means that stayed unresolved. Never re-encrypted, never plain.
  DuplicateNonce: () => notice("maybe_unsent", ""),
  FeatureDisabled: (f, c) => {
    if (f.feature === "e2ee") return notice("encryption_unavailable", "");
    if (f.feature === "protected_channels") {
      return notice("protected_channels_unavailable", "");
    }
    return catchAll(c);
  },
  // Reused by the server for the Text 100-leaf cap (design 7.6).
  MlsCallFull: (f) => notice("channel_full", "", count(f.max)),
};

/** `TextFlowFailure.source === "client"` reasons that carry a notice. */
export const PROTECTED_CLIENT_REASONS = [
  "protect_failed",
  "maybe_unsent",
] as const satisfies readonly ProtectedNoticeKind[];

const isRecord = (v: unknown): v is Fields =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const own = <T extends string>(
  table: Readonly<Record<T, unknown>>,
  k: string,
): k is T => Object.prototype.hasOwnProperty.call(table, k);

const isNativeTag = (t: unknown): t is NativeErrorTag =>
  typeof t === "string" && (NATIVE_ERROR_TAGS as readonly string[]).includes(t);

function withTag(ui: ProtectedErrorUi, tag: string): ProtectedErrorUi {
  return ui.tag === "" ? { ...ui, tag } : ui;
}

function mapNative(e: Fields, ctx: ProtectedErrorContext): ProtectedErrorUi {
  const tag = e.type;
  if (!isNativeTag(tag) || !own(NATIVE_RULES, tag)) return catchAll(ctx);
  if (ctx.op === "message") return onMessage(tag, e, ctx);
  return withTag(NATIVE_RULES[tag](e, ctx), tag);
}

function mapServer(
  type: unknown,
  f: Fields,
  ctx: ProtectedErrorContext,
): ProtectedErrorUi {
  if (typeof type !== "string" || !own(SERVER_RULES, type)) {
    return catchAll(ctx);
  }
  if (ctx.op === "message") return marker("error", type);
  return withTag(SERVER_RULES[type](f, ctx), type);
}

/**
 * Plan D17, total. Accepts a `TextFlowFailure`, a bare native error
 * (`{type: <snake_case tag>, ...}`) or a bare server error body
 * (`{type: <PascalCase type>, ...}`). Anything else, any tag outside the
 * text plane (e.g. `busy`, `storage`) and any unlisted server type fails
 * closed: red `error` marker for `message`, `unverified` otherwise.
 */
export function protectedNoticeForError(
  err: unknown,
  ctx: ProtectedErrorContext,
): ProtectedErrorUi {
  if (!isRecord(err)) return catchAll(ctx);
  switch (err.source) {
    case "native":
      return isRecord(err.error) ? mapNative(err.error, ctx) : catchAll(ctx);
    case "server": {
      const body = isRecord(err.body) ? err.body : {};
      return mapServer(err.type ?? body.type, body, ctx);
    }
    case "transport":
      return ctx.op === "message"
        ? marker("error", "transport")
        : notice("network_error", "transport");
    case "client": {
      const reason = err.reason;
      if (
        ctx.op !== "message" &&
        typeof reason === "string" &&
        (PROTECTED_CLIENT_REASONS as readonly string[]).includes(reason)
      ) {
        return notice(reason as ProtectedNoticeKind, "client");
      }
      return catchAll(ctx);
    }
    case undefined:
      break;
    default:
      return catchAll(ctx);
  }
  if (typeof err.type !== "string") return catchAll(ctx);
  return isNativeTag(err.type)
    ? mapNative(err, ctx)
    : mapServer(err.type, err, ctx);
}

// ---------------------------------------------------------------------------
// Hidden actions (plan D11, D9c)
// ---------------------------------------------------------------------------

/** Hidden on protected or pinned channels. */
export const PROTECTED_HIDDEN_ACTIONS = [
  "edit",
  "forward",
  "publish",
  "create_thread",
  "report",
  "poll",
  "schedule",
  "roll",
  "softres",
  "game_lookup",
  "webhooks",
  "slash_commands",
  "stickers",
  "gif",
  "dice",
  "attachments",
  "camera",
  "voice_message",
  "disappearing_timer",
  "timelock",
  "channel_type_toggles",
] as const;

/** Kept: they act on real ids or stay inside the ciphertext. */
export const PROTECTED_KEPT_ACTIONS = [
  "reply",
  "react",
  "pin",
  "delete",
  "copy",
  "mark_unread",
] as const;

export type ProtectedAction =
  | (typeof PROTECTED_HIDDEN_ACTIONS)[number]
  | (typeof PROTECTED_KEPT_ACTIONS)[number];

/**
 * Whether `action` is hidden. On a protected or pinned channel only the
 * kept list is allowed; an unrecognised action (untyped caller) is hidden.
 */
export function protectedActionsBlocked(
  isProtectedOrPinned: boolean,
  action: ProtectedAction,
): boolean {
  if (isProtectedOrPinned !== true) return false;
  return !(PROTECTED_KEPT_ACTIONS as readonly string[]).includes(action);
}

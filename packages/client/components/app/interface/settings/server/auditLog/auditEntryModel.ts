/**
 * Audit log entries: what each entry is about, for the audit log page.
 *
 * Follows the pinned action table: every action names what kind of object
 * its `target` is (a user, a channel, a role, a permission target, or
 * nothing). An action this build does not know (including the literal
 * `"unknown"` that the server decodes newer actions to) still produces a
 * descriptor, so the page can render a generic row instead of failing.
 *
 * No runtime imports, so the module loads under node's native TypeScript
 * type-stripping. Nothing here is translated; the page owns the copy.
 */
import type {
  AuditCopyAction,
  AuditCopyDetail,
} from "@revolt/client/protectedCopy";
import type {
  AuditLogAction,
  AuditLogChangeData,
  AuditLogEntryData,
  AuditValue,
} from "stoat.js";

/**
 * What an entry's `target` id refers to.
 *
 * `permission_target` is a role id, or `"default"` for the default
 * permissions.
 */
export type AuditTargetKind =
  | "user"
  | "channel"
  | "role"
  | "permission_target"
  | "none";

/**
 * What the two protected channel entries say, read strictly from the wire
 * (backend `v0::AuditLogAction`):
 *
 * - `channel_protect`: `channel` is the channel, `changes` are `boundary`
 *   (a message id, never shown, so it is not kept here) and `wiped`.
 * - `channel_history_wipe`: two separate entries. The owner's request has an
 *   actor and no changes (`count: null`); the entry the wipe job writes when
 *   it is done has no actor and one `count` change.
 *
 * `channel` is the channel id; the page resolves the name.
 */
export type AuditProtectedDetail =
  | { action: "channel_protect"; channel: string; wiped: boolean }
  | { action: "channel_history_wipe"; channel: string; count: number | null };

/** How the audit log page should present one entry */
export type AuditEntryDescriptor = {
  /** The action, or `"unknown"` for any action this build does not know */
  kind: AuditLogAction | "unknown";
  /** What the entry's `target` id refers to */
  targetKind: AuditTargetKind;
  /** The entry's changes; an absent list is empty */
  changes: AuditLogChangeData[];
  /** How many objects the action affected (bulk actions only) */
  count?: number;
  /**
   * `channel_protect` / `channel_history_wipe` only: what the entry says.
   * Absent when the entry could not be read, and the page then shows the
   * generic sentence rather than guess whether anything was deleted.
   */
  protectedDetail?: AuditProtectedDetail;
  /** True when the action is not one this build knows */
  unknown: boolean;
};

const ACTIONS = [
  "member_kick",
  "member_ban_add",
  "member_ban_remove",
  "member_timeout",
  "member_timeout_remove",
  "member_role_update",
  "member_update",
  "member_voice_update",
  "member_move",
  "member_disconnect",
  "message_delete",
  "message_bulk_delete",
  "channel_create",
  "channel_update",
  "channel_delete",
  "channel_overwrite_update",
  "server_permissions_update",
  "role_create",
  "role_update",
  "role_delete",
  "role_ranks_update",
  "server_update",
  "server_owner_transfer",
  "channel_protect",
  "channel_history_wipe",
] as const satisfies readonly AuditLogAction[];

// Compile-time guard that `ACTIONS` is exactly the SDK's `AuditLogAction`:
// `satisfies` above rejects an entry that is not an action, and this fails to
// type-check if an action is missing from the list.
type _MissingAction = Exclude<AuditLogAction, (typeof ACTIONS)[number]>;
const _allActionsListed: [_MissingAction] extends [never] ? true : false = true;

/**
 * Every action this build knows, in the backend's declaration order.
 *
 * A local list rather than the SDK's runtime `AUDIT_LOG_ACTIONS`, so this
 * module has no runtime imports.
 */
export const KNOWN_AUDIT_ACTIONS: readonly AuditLogAction[] = ACTIONS;

const CHANNEL_GROUP_TAIL: readonly AuditLogAction[] = [
  "channel_protect",
  "channel_history_wipe",
];

/**
 * The actions in the order the action filter lists them: the known actions,
 * with the two protected channel actions moved up to the end of the channel
 * group (after `channel_overwrite_update`).
 */
export const AUDIT_FILTER_ACTIONS: readonly AuditLogAction[] = ACTIONS.filter(
  (action) => !CHANNEL_GROUP_TAIL.includes(action),
).flatMap((action) =>
  action === "channel_overwrite_update"
    ? [action, ...CHANNEL_GROUP_TAIL]
    : [action],
);

/** Target kind per action. A `Record` over the union, so a missing or extra
 * action is a type error. */
const TARGET_KIND: Record<AuditLogAction, AuditTargetKind> = {
  member_kick: "user",
  member_ban_add: "user",
  member_ban_remove: "user",
  member_timeout: "user",
  member_timeout_remove: "user",
  member_role_update: "user",
  member_update: "user",
  member_voice_update: "user",
  member_move: "user",
  member_disconnect: "user",
  message_delete: "user",
  message_bulk_delete: "none",
  channel_create: "channel",
  channel_update: "channel",
  channel_delete: "channel",
  channel_overwrite_update: "permission_target",
  server_permissions_update: "permission_target",
  role_create: "role",
  role_update: "role",
  role_delete: "role",
  role_ranks_update: "none",
  server_update: "none",
  server_owner_transfer: "user",
  // Both name their channel in `channel` and send no `target`
  channel_protect: "none",
  channel_history_wipe: "none",
};

// A Set rather than an `in` / index check on `TARGET_KIND`, so an action
// string such as "constructor" or "__proto__" never reads the prototype.
const KNOWN = new Set<string>(ACTIONS);

function isKnownAction(action: string): action is AuditLogAction {
  return KNOWN.has(action);
}

/**
 * Describe an audit log entry: its action, what its target refers to, and
 * its changes. Never throws for an action it does not know.
 */
export function describeAuditEntry(
  entry: AuditLogEntryData,
): AuditEntryDescriptor {
  const known = typeof entry.action === "string" && isKnownAction(entry.action);
  const descriptor: AuditEntryDescriptor = {
    kind: known ? (entry.action as AuditLogAction) : "unknown",
    targetKind: known ? TARGET_KIND[entry.action as AuditLogAction] : "none",
    changes: Array.isArray(entry.changes) ? entry.changes : [],
    unknown: !known,
  };
  if (isProtectedAction(descriptor.kind)) {
    // Everything these entries carry is read into `protectedDetail`. The raw
    // changes are dropped so the details block never lists the boundary
    // message id, or a `wiped` / `count` value that could not be read.
    descriptor.changes = [];
    const detail = readProtectedDetail(descriptor.kind, entry);
    if (detail) descriptor.protectedDetail = detail;
    return descriptor;
  }
  if (typeof entry.count === "number") descriptor.count = entry.count;
  return descriptor;
}

function isProtectedAction(kind: string): kind is AuditCopyAction {
  return kind === "channel_protect" || kind === "channel_history_wipe";
}

/**
 * The changes of an entry by key, or undefined if the list is not one this
 * build can read: not a list, an item that is not a change, a key outside
 * `allowed`, or a key that comes twice.
 */
function changesByKey(
  changes: unknown,
  allowed: readonly string[],
): Map<string, AuditLogChangeData> | undefined {
  const byKey = new Map<string, AuditLogChangeData>();
  if (changes === undefined) return byKey;
  if (!Array.isArray(changes)) return undefined;
  for (const change of changes as unknown[]) {
    if (typeof change !== "object" || change === null) return undefined;
    const key = (change as { key?: unknown }).key;
    if (typeof key !== "string" || !allowed.includes(key)) return undefined;
    if (byKey.has(key)) return undefined;
    byKey.set(key, change as AuditLogChangeData);
  }
  return byKey;
}

/** The `new` value of a new-only change; undefined if there is an `old` */
function newOnly(change: AuditLogChangeData): unknown {
  return change.old === undefined ? change.new : undefined;
}

/**
 * Read a protected channel entry. Undefined for anything that is not exactly
 * one of the shapes the server writes: there is no safe guess between "the
 * earlier messages were kept" and "they were deleted".
 */
function readProtectedDetail(
  action: AuditCopyAction,
  entry: AuditLogEntryData,
): AuditProtectedDetail | undefined {
  const channel: unknown = entry.channel;
  if (typeof channel !== "string" || channel === "") return undefined;
  // Neither entry has a target or a top-level count
  if (entry.target !== undefined || entry.count !== undefined) return undefined;
  const hasActor = typeof entry.actor === "string" && entry.actor !== "";

  switch (action) {
    case "channel_protect": {
      if (!hasActor) return undefined;
      const changes = changesByKey(entry.changes, ["boundary", "wiped"]);
      const wiped = changes?.get("wiped");
      if (!changes || !wiped) return undefined;

      const value = newOnly(wiped) as { type?: unknown; value?: unknown };
      if (value?.type !== "Bool" || typeof value.value !== "boolean") {
        return undefined;
      }

      // The boundary is checked for its shape only and then left behind
      const boundary = changes.get("boundary");
      if (boundary) {
        if (boundary.old !== undefined) return undefined;
        const id = boundary.new as { type?: unknown; value?: unknown };
        if (
          id !== undefined &&
          (id?.type !== "String" || typeof id.value !== "string")
        ) {
          return undefined;
        }
      }

      return { action, channel, wiped: value.value === true };
    }
    case "channel_history_wipe": {
      const changes = changesByKey(entry.changes, ["count"]);
      if (!changes) return undefined;

      const counted = changes.get("count");
      if (!counted) {
        // The request: someone asked, nothing is counted yet
        return hasActor ? { action, channel, count: null } : undefined;
      }

      const value = newOnly(counted) as { type?: unknown; value?: unknown };
      if (
        value?.type !== "Int" ||
        typeof value.value !== "number" ||
        !Number.isSafeInteger(value.value) ||
        value.value < 0
      ) {
        return undefined;
      }
      return { action, channel, count: value.value };
    }
    default: {
      const _exhaustive: never = action;
      return undefined;
    }
  }
}

/**
 * What to pass to `auditCopy` for a protected channel entry, or null when
 * the page must show the generic sentence instead: the entry could not be
 * read, or the channel has no name the client can resolve (the channel id
 * is never passed as a name).
 *
 * `wiped` is passed for the protect entry only and `count` for the wipe
 * entry only.
 */
export function protectedAuditCopyArgs(
  detail: AuditProtectedDetail | undefined,
  names: { actor: string; channel: string | undefined },
): { action: AuditCopyAction; detail: AuditCopyDetail } | null {
  if (!detail) return null;
  const actor = names.actor;
  const channel = names.channel;
  if (typeof actor !== "string" || actor === "") return null;
  if (typeof channel !== "string" || channel === "") return null;
  if (channel === detail.channel) return null;

  switch (detail.action) {
    case "channel_protect":
      return {
        action: "channel_protect",
        detail: { actor, channel, wiped: detail.wiped === true },
      };
    case "channel_history_wipe":
      return {
        action: "channel_history_wipe",
        detail: { actor, channel, count: detail.count },
      };
    default: {
      const _exhaustive: never = detail;
      return null;
    }
  }
}

/**
 * Plain, untranslated rendering of a value for the "changes" list: String
 * as-is, Int in decimal, Bool as "true"/"false", StringList comma-joined.
 * An absent value (or a value type this build does not know) is "".
 */
export function auditValueText(value: AuditValue | undefined): string {
  if (!value) return "";
  switch (value.type) {
    case "String":
      return typeof value.value === "string" ? value.value : "";
    case "Int":
      // Integers through BigInt so a large i64 never prints as "1e+21"
      return Number.isInteger(value.value)
        ? BigInt(value.value).toString()
        : String(value.value);
    case "Bool":
      return value.value ? "true" : "false";
    case "StringList":
      return Array.isArray(value.value) ? value.value.join(", ") : "";
    default: {
      const _exhaustive: never = value;
      return "";
    }
  }
}

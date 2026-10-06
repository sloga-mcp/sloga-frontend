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
  if (typeof entry.count === "number") descriptor.count = entry.count;
  return descriptor;
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

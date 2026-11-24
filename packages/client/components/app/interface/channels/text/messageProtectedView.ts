// What a Protected channel row shows (design 9.3, 9.5), decided from the
// bridge's view of the row. Pure, so `messageProtectedView.test.ts` can run
// it under Node; `Message.tsx` only renders the answer.
//
// The ordinary message path (server content, embeds, attachments, replies)
// is reached for exactly one answer, `ordinary`: a `plain` view (9.5 arm 3)
// of a row that carries no `encrypted` and still has something to show.
// Every other view, no view, and a status this build does not know keep the
// row's server-set fields off the screen.
import type { RowNote } from "../../../../client/protectedShield.ts";
import { okViewNotes } from "../../../../client/protectedTextMessages.ts";
import type {
  ProtectedMarkerKind,
  ProtectedMessageView,
} from "../../../../client/protectedTextTypes.ts";

/** The `ok` arm of the decrypted view. */
export type ProtectedOkView = Extract<ProtectedMessageView, { status: "ok" }>;

/** Shown in place of a body by `ProtectedMessageMarker`. */
export type ProtectedRowMarker =
  | ProtectedMarkerKind
  | "pending"
  | "not_available";

/** A view sorted by what it may show, before the row itself is looked at. */
export type ProtectedViewClass =
  | { kind: "ok"; view: ProtectedOkView }
  | { kind: "plain" }
  | { kind: "checking" }
  | { kind: "marker"; marker: ProtectedRowMarker };

/** What a Protected channel row renders as its body. */
export type ProtectedRowBody =
  | { kind: "ordinary" }
  | { kind: "ok"; view: ProtectedOkView }
  | { kind: "checking" }
  | { kind: "marker"; marker: ProtectedRowMarker };

/** The fields of the SDK row this module reads. */
export interface PlainRowFields {
  encrypted?: unknown;
  content?: unknown;
  attachments?: unknown;
  systemMessage?: unknown;
  embeds?: unknown;
  forwarded?: unknown;
  poll?: unknown;
  softres?: unknown;
  components?: unknown;
}

/** How a row stands against the list that renders it. */
export type ProtectedRowScope = "open" | "protected" | "foreign";

/**
 * Whether a row is a Protected channel row, decided by the LIST's channel
 * as well as the row's own (audit A1). `protected`: the row carries
 * `encrypted`, or the list's channel or the row's own channel is protected
 * or pinned. `foreign`: such a row that names another channel than the list
 * it is shown in; it never shows a body. `open`: an ordinary row. Without a
 * list (search, the report dialog) only the row's own channel is known.
 * `rowHeld` / `listHeld`: `client.isProtectedChannel` of the row's own
 * channel and of the list's; any truthy answer counts (fails closed), and
 * `listHeld` is ignored without a list.
 */
export function protectedRowScope(i: {
  encrypted: unknown;
  rowChannelId: string | undefined;
  listChannelId: string | undefined;
  rowHeld: boolean;
  listHeld: boolean;
}): ProtectedRowScope {
  const inList = i.listChannelId !== undefined;
  const guarded =
    i.encrypted !== undefined || !!i.rowHeld || (inList && !!i.listHeld);
  if (!guarded) return "open";
  return inList && i.rowChannelId !== i.listChannelId ? "foreign" : "protected";
}

/**
 * Whether a legacy reply preview may show its target. On a Protected row
 * only a target of the list's own channel is shown; any other row shows
 * whatever target is cached, as before.
 */
export function replyTargetShown(i: {
  protectedRow: boolean;
  listChannelId: string | undefined;
  targetChannelId: string | undefined;
}): boolean {
  if (i.protectedRow === false) return true;
  return (
    typeof i.listChannelId === "string" && i.targetChannelId === i.listChannelId
  );
}

/**
 * Sort a view. No view yet waits: `pending`, or `not_available` on a device
 * with no protected text plane (it would never decrypt). A marker view
 * without a usable kind and an unknown status are the red `error` marker.
 */
export function protectedViewClass(
  view: ProtectedMessageView | null | undefined,
  capable: boolean,
): ProtectedViewClass {
  const waiting: ProtectedViewClass = {
    kind: "marker",
    marker: capable === true ? "pending" : "not_available",
  };
  if (!view) return waiting;
  switch (view.status) {
    case "ok":
      return { kind: "ok", view };
    case "marker": {
      // Read as unknown: a view that breaks the type still fails closed.
      const kind: unknown = view.kind;
      return {
        kind: "marker",
        marker:
          typeof kind === "string" && kind !== ""
            ? (kind as ProtectedMarkerKind)
            : "error",
      };
    }
    case "pending":
      return waiting;
    case "plain":
      return { kind: "plain" };
    case "checking":
      return { kind: "checking" };
    default: {
      const _exhaustive: never = view;
      return { kind: "marker", marker: "error" };
    }
  }
}

/** A non-empty array. */
function filled(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** An object (never an array, a string or a flag). */
function present(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a row may render as an ordinary message once its view is `plain`.
 * It holds any of these fields only because the SDK's verified reveal put
 * them back: content, attachments, a system message, embeds, a forwarded
 * snapshot, a poll, a soft-reserve sheet or components. A row with none of
 * them (the reveal is gone, e.g. after a reload) has nothing to show. A row
 * carrying `encrypted` is never plain.
 */
export function plainRenderable(
  message: PlainRowFields | null | undefined,
): boolean {
  if (!message) return false;
  if (message.encrypted !== undefined) return false;
  if (typeof message.content === "string" && message.content.length > 0) {
    return true;
  }
  return (
    filled(message.attachments) ||
    filled(message.embeds) ||
    filled(message.components) ||
    present(message.systemMessage) ||
    present(message.forwarded) ||
    present(message.poll) ||
    present(message.softres)
  );
}

/**
 * The body of a Protected channel row. `ordinary` only for a `plain` view
 * of a renderable row; a `plain` view of an empty row is the checking line.
 * A foreign row (`protectedRowScope`) is the red `error` marker whatever its
 * view says; anything but a literal `false` counts as foreign.
 */
export function protectedRowBody(
  view: ProtectedMessageView | null | undefined,
  capable: boolean,
  message: PlainRowFields | null | undefined,
  foreign: boolean,
): ProtectedRowBody {
  if (foreign !== false) return { kind: "marker", marker: "error" };
  const sorted = protectedViewClass(view, capable);
  if (sorted.kind !== "plain") return sorted;
  return plainRenderable(message) ? { kind: "ordinary" } : { kind: "checking" };
}

/**
 * The notes under an `ok` view, in display order, each at most once. They
 * are the bridge's (`okViewNotes`); nothing here reads the view's flags.
 */
export function protectedRowNotes(view: ProtectedOkView): RowNote[] {
  return okViewNotes(view);
}

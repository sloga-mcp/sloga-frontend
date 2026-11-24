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

/**
 * Whether a row may render as an ordinary message once its view is `plain`.
 * It has content or attachments only because the SDK's verified reveal put
 * them back; a row with neither (the reveal is gone, e.g. after a reload)
 * has nothing to show. A row carrying `encrypted` is never plain.
 */
export function plainRenderable(
  message: PlainRowFields | null | undefined,
): boolean {
  if (!message) return false;
  if (message.encrypted !== undefined) return false;
  if (typeof message.content === "string" && message.content.length > 0) {
    return true;
  }
  return Array.isArray(message.attachments) && message.attachments.length > 0;
}

/**
 * The body of a Protected channel row. `ordinary` only for a `plain` view
 * of a renderable row; a `plain` view of an empty row is the checking line.
 */
export function protectedRowBody(
  view: ProtectedMessageView | null | undefined,
  capable: boolean,
  message: PlainRowFields | null | undefined,
): ProtectedRowBody {
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

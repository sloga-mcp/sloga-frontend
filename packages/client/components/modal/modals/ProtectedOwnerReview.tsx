import { For, Show, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import {
  errorUiCopy,
  noticeCopy,
  panelCopy,
} from "@revolt/client/protectedCopy";
import { protectedNoticeForError } from "@revolt/client/protectedShield";
import {
  protectedUiOf,
  useProtectedShield,
} from "@revolt/client/useProtectedChannel";
import { useNavigate } from "@revolt/routing";
import {
  type DialogAction,
  type DialogProps,
  Dialog,
} from "@revolt/ui/components/design/Dialog";

/**
 * Props of the `protected_owner_review` modal (S2-D41). Exported for the
 * modal union in `types.ts`.
 */
export interface ProtectedOwnerReviewProps {
  type: "protected_owner_review";
  /** The protected channel whose owner change is under review. */
  channel: Channel;
}

/**
 * Owner-change review (S2-D41, OR-10; W4-3 lane U7).
 *
 * Opened by the header pill's "Review owner change" in place of calling
 * `confirmOwnerChange` itself. Native is the gate: the webview shows copy
 * only, and the native `e2ee_text_owner_confirm_change` dialog opens only
 * from this modal's own button click (D15). No safety number, key or id is
 * rendered here; D15 never showed one in the webview either.
 *
 * Whether the review may be offered comes from the shield alone (F1
 * `reviewOffered`, read `=== true`), never from an error mapping. A
 * same-user signer that a confirm cannot settle (OR-10: not on the
 * channel's signing devices) gets its copy and no review button. After a
 * native Declined the channel stays locked: "Still locked." with "Review
 * again" and "Leave channel" (D41). "Leave channel" only navigates away
 * from the channel; it removes nothing.
 */
export function ProtectedOwnerReviewModal(
  props: DialogProps & ProtectedOwnerReviewProps,
) {
  const client = useClient();
  const navigate = useNavigate();
  const shield = useProtectedShield(() => props.channel.id);

  const [pending, setPending] = createSignal(false);
  const [declined, setDeclined] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);

  const ui = () => protectedUiOf(client()?.e2ee);

  /** OR-10, from the view flag or the shield's notice. */
  const unlisted = () => {
    const s = shield();
    return ownerReviewUnlisted(s?.view, s?.notice);
  };

  const panel = () =>
    ownerReviewPanel({
      unlisted: unlisted(),
      reviewOffered: shield()?.reviewOffered,
      declined: declined(),
    });

  /** Body lines; copy functions only. */
  const lines = (): string[] => {
    const p = panel();
    switch (p.kind) {
      case "review":
        return [
          noticeCopy("owner_changed_review"),
          panelCopy.ownerPin("changed"),
        ];
      case "declined":
        return [
          panelCopy.ownerReviewStillLocked(),
          panelCopy.ownerPin("changed"),
        ];
      case "unlisted":
        return [noticeCopy("owner_changed_unlisted")];
      case "settled": {
        const notice = shield()?.notice ?? null;
        return notice === null ? [] : [noticeCopy(notice)];
      }
      default: {
        const _exhaustive: never = p.kind;
        return [];
      }
    }
  };

  /**
   * D15 / D41: the native dialog, only from this click and only while the
   * shield offers the review. A Declined keeps the channel locked; any
   * other failure shows its plan D17 copy (never `error.message`).
   */
  async function review() {
    if (pending() || !panel().confirm) return;
    const channelId = props.channel.id;
    const api = ui();
    setFailure(null);
    if (!api) {
      setFailure(
        noticeCopy(
          shield()?.notice === "enable_e2ee" ? "enable_e2ee" : "not_available",
        ),
      );
      return;
    }
    setPending(true);
    try {
      await api.confirmOwnerChange(channelId);
      setDeclined(false);
      // The bridge re-verified before resolving. OR-10: a signer the
      // confirm could not settle stays open on its copy.
      if (!unlisted()) props.onClose();
    } catch (err) {
      if (ownerReviewDeclined(err)) {
        setDeclined(true);
      } else {
        const answer = protectedNoticeForError(err, { op: "owner" });
        // ids only (D16)
        console.error("[protected] owner review failed", { type: answer.tag });
        setFailure(errorUiCopy(answer, { failure: err }));
      }
    } finally {
      setPending(false);
    }
  }

  /** D41 "Leave channel": navigate away; nothing is removed or signed. */
  function leave() {
    const serverId = props.channel.serverId;
    navigate(serverId ? `/server/${serverId}` : "/app");
  }

  /** Closing waits for the native dialog to settle. */
  function close() {
    if (!pending()) props.onClose();
  }

  const actions = (): DialogAction[] => {
    const p = panel();
    const list: DialogAction[] = [];
    if (!(p.leave && p.confirm)) {
      list.push({
        text:
          p.kind === "review" ? <Trans>Cancel</Trans> : <Trans>Close</Trans>,
      });
    }
    if (p.leave) {
      list.push({ text: panelCopy.leaveChannel(), onClick: leave });
    }
    if (p.confirm) {
      list.push({
        text:
          p.kind === "declined"
            ? panelCopy.reviewAgain()
            : panelCopy.reviewOwnerChange(),
        onClick: () => {
          void review();
          return false;
        },
        isDisabled: pending(),
      });
    }
    return list;
  };

  return (
    <Dialog
      minWidth={360}
      show={props.show}
      onClose={close}
      title={panelCopy.reviewOwnerChange()}
      actions={actions()}
      isDisabled={pending()}
    >
      <Body role="status" data-owner-review={panel().kind}>
        <For each={lines()}>{(line) => <Line>{line}</Line>}</For>
        <Show when={failure()}>
          {(text) => <Failure role="alert">{text()}</Failure>}
        </Show>
      </Body>
    </Dialog>
  );
}

// protected-pure:begin (no imports: protectedOwnerReview.scan.test.ts runs
// this region under Node)

/** Which panel the review modal shows. */
export type OwnerReviewPanelKind =
  | "review"
  | "declined"
  | "unlisted"
  | "settled";

export interface OwnerReviewPanel {
  kind: OwnerReviewPanelKind;
  /** The review button ("Review owner change" / "Review again"). */
  confirm: boolean;
  /** "Leave channel" (D41). */
  leave: boolean;
}

/**
 * OR-10: the same-user signer is not on the channel's signing devices, so
 * a confirm cannot settle it. The view's flag or the shield's notice.
 * @param view The manager's channel view
 * @param notice The shield's notice
 */
export function ownerReviewUnlisted(view: unknown, notice: unknown): boolean {
  if (notice === "owner_changed_unlisted") return true;
  return (
    typeof view === "object" &&
    view !== null &&
    (view as { ownerChangeUnlisted?: unknown }).ownerChangeUnlisted === true
  );
}

/**
 * The panel. The review is offered only when the shield says so (F1
 * `reviewOffered === true`) and the signer is not unlisted; unlisted wins
 * over everything. "Still locked." needs a Declined AND a review still on
 * offer: a change settled meanwhile is not called locked.
 * @param i `unlisted` (OR-10), the shield's `reviewOffered`, and whether
 *   the last native dialog was declined
 */
export function ownerReviewPanel(i: {
  unlisted: boolean;
  reviewOffered: unknown;
  declined: boolean;
}): OwnerReviewPanel {
  if (i.unlisted === true) {
    return { kind: "unlisted", confirm: false, leave: true };
  }
  if (i.reviewOffered !== true) {
    return { kind: "settled", confirm: false, leave: false };
  }
  if (i.declined === true) {
    return { kind: "declined", confirm: true, leave: true };
  }
  return { kind: "review", confirm: true, leave: false };
}

/**
 * Native `declined` (the user cancelled the dialog), as a flow failure
 * (`{source: "native", error: {type}}`) or a bare native error.
 * @param err Rejection from `confirmOwnerChange`
 */
export function ownerReviewDeclined(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { source?: unknown; error?: unknown; type?: unknown };
  if (e.source === "native") {
    const n = e.error;
    return (
      typeof n === "object" &&
      n !== null &&
      (n as { type?: unknown }).type === "declined"
    );
  }
  return e.source === undefined && e.type === "declined";
}

// protected-pure:end

const Body = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
  },
});

const Line = styled("p", {
  base: {
    margin: 0,
  },
});

const Failure = styled("p", {
  base: {
    margin: 0,
    color: "var(--md-sys-color-error)",
  },
});

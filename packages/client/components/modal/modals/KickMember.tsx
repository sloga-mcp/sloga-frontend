import { createFormControl } from "solid-forms";
import { Show, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useMutation } from "@tanstack/solid-query";
import { styled } from "styled-system/jsx";

import {
  noticeCopy,
  reasonProblemCopy,
  removalReasonHintCopy,
} from "@revolt/client/protectedCopy";
import {
  type RemovalReasonProblem,
  AUDIT_LOG_REASON_MAX_CHARS,
  reasonRefusal,
  removalReasonRequired,
  validReason,
} from "@revolt/client/protectedRemovalReasonPolicy";
import { Avatar, Column, Dialog, DialogProps, Form2, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Kick a server member, recording a reason in the audit log. The reason is
 * required in a server with a protected channel (S2-D40): the local check
 * is advisory (the cache may lack channels the moderator cannot view), so
 * the server's `RemovalReasonRequired` answer also makes it required.
 */
export function KickMemberModal(
  props: DialogProps & Modals & { type: "kick_member" },
) {
  const { t } = useLingui();
  const { showError } = useModals();

  const reason = createFormControl("");

  // Set by the server's `RemovalReasonRequired`; never cleared while open.
  const [serverRequired, setServerRequired] = createSignal(false);
  const required = createMemo(
    () =>
      serverRequired() ||
      removalReasonRequired(
        (props.member.server?.channels ?? []).map((c) => ({
          protected: c.isProtected,
        })),
      ),
  );

  // Our own copy for a reason problem; never server text.
  const [problem, setProblem] = createSignal<string | null>(null);

  /** Reason problems first, then the generic error mapping. */
  function showKickError(error: unknown) {
    const failure = kickFailure(error, reasonRefusal);
    switch (failure) {
      case "too_long":
        setProblem(reasonProblemCopy("too_long", AUDIT_LOG_REASON_MAX_CHARS));
        return;
      case "reason_required":
        setServerRequired(true);
        setProblem(noticeCopy("removal_reason_required"));
        return;
      case "other":
        showError(error);
        return;
      default: {
        const _exhaustive: never = failure;
        showError(error);
      }
    }
  }

  const kick = useMutation(() => ({
    mutationFn: (options: { reason: string } | undefined) =>
      props.member.kick(options),
    // The server can report an error after the member was already removed
    // (the voice eviction failed), so only surface it; the member list
    // follows the server's events either way.
    onError: showKickError,
  }));

  // `kick.isPending` only flips once the query notifier flushes, so a second
  // press landing before then would start a second kick. This flag is set
  // synchronously on the first press.
  const [submitting, setSubmitting] = createSignal(false);

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Kick Member</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Kick</Trans>,
          onClick: () => {
            if (submitting()) return false;
            setProblem(null);
            const plan = kickPlan(reason.value, required(), validReason);
            if (!plan.send) {
              setProblem(
                reasonProblemCopy(plan.problem, AUDIT_LOG_REASON_MAX_CHARS),
              );
              return false;
            }
            setSubmitting(true);
            return kick
              .mutateAsync(plan.options)
              .finally(() => setSubmitting(false));
          },
        },
      ]}
      isDisabled={submitting() || kick.isPending}
    >
      <Column align>
        <Avatar src={props.member.user?.animatedAvatarURL} size={64} />
        <Text>
          <Trans>You are about to kick {props.member.user?.username}</Trans>
        </Text>
        <Form2.TextField
          maxlength={AUDIT_LOG_REASON_MAX_CHARS}
          counter
          name="reason"
          control={reason}
          label={t`Reason`}
          placeholder={t`User broke a certain rule…`}
        />
        <Show
          when={problem()}
          fallback={
            <Show when={required()}>
              <Hint>{removalReasonHintCopy()}</Hint>
            </Show>
          }
        >
          {(text) => <Problem role="alert">{text()}</Problem>}
        </Show>
      </Column>
    </Dialog>
  );
}

// protected-pure:begin (no imports: kickMember.scan.test.ts runs this region
// under Node)

/** What a Kick press does: send, with the sanitized reason or none, or not. */
type KickPlan =
  | { send: true; options: { reason: string } | undefined }
  | { send: false; problem: RemovalReasonProblem };

/**
 * Check the typed reason the way the server will (`validReason`, header
 * carrier). A valid reason is sent as `validReason` returned it, never the
 * raw input; a blank one is sent as none unless a reason is required.
 */
function kickPlan(
  raw: string,
  required: boolean,
  validate: typeof validReason,
): KickPlan {
  const check = validate(raw, "header");
  if (check.ok) return { send: true, options: { reason: check.reason } };
  if (check.why === "empty" && !required) {
    return { send: true, options: undefined };
  }
  return { send: false, problem: check.why };
}

/** How a failed kick is shown: our reason copy, or the generic mapping. */
type KickFailure = "too_long" | "reason_required" | "other";

/**
 * Classify a failed kick. `refusal` (`reasonRefusal`) is asked first, so an
 * over-long reason never reaches the generic copy. stoat.js throws the raw
 * body text; a parsed body is accepted too.
 */
function kickFailure(
  error: unknown,
  refusal: typeof reasonRefusal,
): KickFailure {
  if (refusal(error) === "too_long") return "too_long";
  let body = error;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return "other";
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "other";
  }
  return (body as { type?: unknown }).type === "RemovalReasonRequired"
    ? "reason_required"
    : "other";
}

// protected-pure:end

const Hint = styled("div", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Problem = styled("div", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-error)",
  },
});

import { createFormControl, createFormGroup } from "solid-forms";
import { Show, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import {
  noticeCopy,
  reasonProblemCopy,
  removalReasonHintCopy,
} from "@revolt/client/protectedCopy";
import {
  type RemovalReasonProblem,
  BAN_REASON_MAX_CHARS,
  reasonRefusal,
  removalReasonRequired,
  validReason,
} from "@revolt/client/protectedRemovalReasonPolicy";
import {
  Avatar,
  Column,
  Dialog,
  DialogProps,
  Form2,
  MenuItem,
  Text,
} from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Ban a server member with a reason, sent as the ban body's `reason` (the
 * server records it in the audit log; no reason header). The reason is
 * required in a server with a protected channel (S2-D40): the local check
 * is advisory (the cache may lack channels the moderator cannot view), so
 * the server's `RemovalReasonRequired` answer also makes it required.
 */
export function BanMemberModal(
  props: DialogProps & Modals & { type: "ban_member" },
) {
  const { t } = useLingui();
  const { showError } = useModals();

  const group = createFormGroup({
    reason: createFormControl(""),
    deleteMessageSeconds: createFormControl("0"),
  });

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
  function showBanError(error: unknown) {
    const failure = banFailure(error, reasonRefusal);
    switch (failure) {
      case "too_long":
        setProblem(reasonProblemCopy("too_long", BAN_REASON_MAX_CHARS));
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

  // ban() awaits the request, so the dialog stays open for the round trip.
  // The Ban action calls onSubmit directly rather than through the form's
  // submit handler, so group.isPending never covers it; this flag does, and
  // also stops Enter from starting a second ban while one is in flight.
  const [banning, setBanning] = createSignal(false);

  async function onSubmit() {
    if (banning()) return;
    setProblem(null);
    const plan = banPlan(group.controls.reason.value, required(), validReason);
    if (!plan.send) {
      setProblem(reasonProblemCopy(plan.problem, BAN_REASON_MAX_CHARS));
      return;
    }
    setBanning(true);

    try {
      await props.member.ban({
        reason: plan.reason,
        delete_message_seconds: Number(
          group.controls.deleteMessageSeconds.value,
        ),
      });

      props.onClose();
    } catch (error) {
      showBanError(error);
    } finally {
      setBanning(false);
    }
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Ban Member</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Ban</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: banning() || !Form2.canSubmit(group),
        },
      ]}
      isDisabled={group.isPending || banning()}
    >
      <form onSubmit={submit}>
        <Column align>
          <Avatar src={props.member.user?.animatedAvatarURL} size={64} />
          <Text>
            <Trans>You are about to ban {props.member.user?.username}</Trans>
          </Text>
          <Form2.TextField
            maxlength={BAN_REASON_MAX_CHARS}
            counter
            name="reason"
            control={group.controls.reason}
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
          <Form2.Select
            label={t`Delete Message History`}
            control={group.controls.deleteMessageSeconds}
          >
            <MenuItem value="0">
              <Trans>Don't delete messages</Trans>
            </MenuItem>
            <MenuItem value="3600">
              <Trans>1 hour</Trans>
            </MenuItem>
            <MenuItem value="21600">
              <Trans>6 hours</Trans>
            </MenuItem>
            <MenuItem value="86400">
              <Trans>1 day</Trans>
            </MenuItem>
            <MenuItem value="259200">
              <Trans>3 days</Trans>
            </MenuItem>
            <MenuItem value="604800">
              <Trans>7 days</Trans>
            </MenuItem>
          </Form2.Select>
        </Column>
      </form>
    </Dialog>
  );
}

// protected-pure:begin (no imports: banMember.scan.test.ts runs this region
// under Node)

/** What a Ban press does: send, with the sanitized reason or none, or not. */
type BanPlan =
  | { send: true; reason: string | undefined }
  | { send: false; problem: RemovalReasonProblem };

/**
 * Check the typed reason the way the server will (`validReason`, ban body
 * carrier, 1024). A valid reason is sent as `validReason` returned it, never
 * the raw input; a blank one is sent as none unless a reason is required.
 */
function banPlan(
  raw: string,
  required: boolean,
  validate: typeof validReason,
): BanPlan {
  const check = validate(raw, "ban_body");
  if (check.ok) return { send: true, reason: check.reason };
  if (check.why === "empty" && !required) {
    return { send: true, reason: undefined };
  }
  return { send: false, problem: check.why };
}

/** How a failed ban is shown: our reason copy, or the generic mapping. */
type BanFailure = "too_long" | "reason_required" | "other";

/**
 * Classify a failed ban. `refusal` (`reasonRefusal`) is asked first, so an
 * over-long reason never reaches the generic copy. stoat.js throws the raw
 * body text; a parsed body is accepted too.
 *
 * The ban body's own over-long refusal is the body validator's
 * `FailedValidation` (its error text, not `AuditLogReasonTooLong`), which
 * `refusal` does not name and which is shown generically: the local 1024
 * check counts the sanitized reason that is sent, as the server does, so it
 * is not reached from here.
 */
function banFailure(error: unknown, refusal: typeof reasonRefusal): BanFailure {
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

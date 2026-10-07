import { createFormControl } from "solid-forms";
import { createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useMutation } from "@tanstack/solid-query";

import { Avatar, Column, Dialog, DialogProps, Form2, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Kick a server member, optionally recording a reason in the audit log
 */
export function KickMemberModal(
  props: DialogProps & Modals & { type: "kick_member" },
) {
  const { t } = useLingui();
  const { showError } = useModals();

  const reason = createFormControl("");

  const kick = useMutation(() => ({
    mutationFn: () => {
      const value = reason.value.trim();
      return value ? props.member.kick({ reason: value }) : props.member.kick();
    },
    // The server can report an error after the member was already removed
    // (the voice eviction failed), so only surface it; the member list
    // follows the server's events either way.
    onError: showError,
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
            setSubmitting(true);
            return kick.mutateAsync().finally(() => setSubmitting(false));
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
          maxlength={512}
          counter
          name="reason"
          control={reason}
          label={t`Reason`}
          placeholder={t`User broke a certain rule…`}
        />
      </Column>
    </Dialog>
  );
}

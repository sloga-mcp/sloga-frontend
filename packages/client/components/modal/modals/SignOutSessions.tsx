import { Trans } from "@lingui-solid/solid/macro";
import { useMutation } from "@tanstack/solid-query";

import { Dialog, DialogProps } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Modal to sign out of all other sessions.
 *
 * `DELETE /auth/session/all` is MFA-gated server-side (a destructive action),
 * so we re-auth via `mfaFlow` first and pass the validated ticket token —
 * without it the request 401s. Mirrors the re-auth in the E2EE disable / wipe
 * flows.
 */
export function SignOutSessionsModal(
  props: DialogProps & Modals & { type: "sign_out_sessions" },
) {
  const { mfaFlow, showError } = useModals();

  const signOutSessions = useMutation(() => ({
    mutationFn: async () => {
      // Prove account ownership; the server requires this ticket to revoke
      // other sessions.
      const mfa = await props.client.account.mfa();
      const ticket = await mfaFlow(mfa);
      // User backed out of the re-auth prompt — do nothing.
      if (!ticket) return;
      await props.client.sessions.deleteAll(false, ticket.token);
    },
    onSuccess: () => props.onClose(),
    onError: showError,
  }));

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Are you sure you want to clear your sessions?</Trans>}
      isDisabled={signOutSessions.isPending}
      actions={[
        {
          text: <Trans>Cancel</Trans>,
          onClick: () => {
            props.onClose();
            return false;
          },
        },
        {
          text: <Trans>Accept</Trans>,
          onClick: () => {
            void signOutSessions.mutateAsync();
            return false;
          },
          isDisabled: signOutSessions.isPending,
        },
      ]}
    >
      <Trans>You cannot undo this action.</Trans>
    </Dialog>
  );
}

import { Match, Switch, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { useMutation } from "@tanstack/solid-query";

import { Avatar, Column, Dialog, DialogProps, Text } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Confirm removing a friend or blocking a user. Failures open the error
 * modal and leave this dialog open.
 */
export function ConfirmRelationshipModal(
  props: DialogProps & Modals & { type: "unfriend_user" | "block_user" },
) {
  const { showError } = useModals();

  const change = useMutation(() => ({
    mutationFn: () =>
      props.type === "block_user"
        ? props.user.blockUser()
        : props.user.removeFriend(),
    onError: showError,
  }));

  // Same double-press guard as KickMember: `isPending` flips a tick late
  const [submitting, setSubmitting] = createSignal(false);

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={
        props.type === "block_user" ? (
          <Trans>Block user</Trans>
        ) : (
          <Trans>Remove friend</Trans>
        )
      }
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text:
            props.type === "block_user" ? (
              <Trans>Block</Trans>
            ) : (
              <Trans>Remove</Trans>
            ),
          destructive: true,
          onClick: () => {
            if (submitting()) return false;
            setSubmitting(true);
            return change.mutateAsync().finally(() => setSubmitting(false));
          },
        },
      ]}
      isDisabled={submitting() || change.isPending}
    >
      <Column align>
        <Avatar
          src={props.user.animatedAvatarURL}
          fallback={props.user.displayName}
          size={64}
        />
        <Text>
          <Switch>
            <Match when={props.type === "block_user"}>
              <Trans>
                Block {props.user.displayName}? They'll be removed from your
                friends and can't send you direct messages.
              </Trans>
            </Match>
            <Match when={props.type === "unfriend_user"}>
              <Trans>Remove {props.user.displayName} from your friends?</Trans>
            </Match>
          </Switch>
        </Text>
      </Column>
    </Dialog>
  );
}

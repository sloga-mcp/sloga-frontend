import { createFormControl, createFormGroup } from "solid-forms";
import { createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

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
 * Time out a server member for a preset duration, with an optional reason
 */
export function TimeoutMemberModal(
  props: DialogProps & Modals & { type: "timeout_member" },
) {
  const { t } = useLingui();
  const { showError } = useModals();

  const group = createFormGroup({
    durationSeconds: createFormControl("60"),
    reason: createFormControl(""),
  });

  // Set synchronously on the first submit so a second click or Enter press
  // cannot send another request while the first is still in flight. Both the
  // dialog action and the form's Enter key route through onSubmit.
  const [pending, setPending] = createSignal(false);

  async function onSubmit() {
    if (pending()) return;
    setPending(true);

    try {
      const seconds = Number(group.controls.durationSeconds.value);
      const reason = group.controls.reason.value.trim();

      await props.member.edit(
        { timeout: new Date(Date.now() + seconds * 1000).toISOString() },
        reason ? { reason } : undefined,
      );

      props.onClose();
    } catch (error) {
      // The server can reject AFTER the timeout was written (the voice
      // eviction failed). Show the error as-is; the member's state is
      // updated by the ServerMemberUpdate event either way.
      showError(error);
    } finally {
      setPending(false);
    }
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Timeout Member</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Timeout</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: pending() || !Form2.canSubmit(group),
        },
      ]}
      isDisabled={pending() || group.isPending}
    >
      <form onSubmit={submit}>
        <Column align>
          <Avatar src={props.member.user?.animatedAvatarURL} size={64} />
          <Text>
            <Trans>
              You are about to time out {props.member.user?.username}. Until the
              timeout ends, they can read channels but cannot send messages,
              react, or join voice. If they are in a voice channel, they will be
              disconnected.
            </Trans>
          </Text>
          <Form2.Select
            label={t`Duration`}
            control={group.controls.durationSeconds}
          >
            <MenuItem value="60">
              <Trans>60 seconds</Trans>
            </MenuItem>
            <MenuItem value="300">
              <Trans>5 minutes</Trans>
            </MenuItem>
            <MenuItem value="600">
              <Trans>10 minutes</Trans>
            </MenuItem>
            <MenuItem value="3600">
              <Trans>1 hour</Trans>
            </MenuItem>
            <MenuItem value="86400">
              <Trans>1 day</Trans>
            </MenuItem>
            <MenuItem value="604800">
              <Trans>1 week</Trans>
            </MenuItem>
          </Form2.Select>
          <Form2.TextField
            maxlength={512}
            counter
            name="reason"
            control={group.controls.reason}
            label={t`Reason`}
            placeholder={t`User broke a certain rule…`}
          />
        </Column>
      </form>
    </Dialog>
  );
}

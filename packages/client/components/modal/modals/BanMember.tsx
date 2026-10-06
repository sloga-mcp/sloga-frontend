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
 * Ban a server member with reason
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

  // ban() awaits the request, so the dialog stays open for the round trip.
  // The Ban action calls onSubmit directly rather than through the form's
  // submit handler, so group.isPending never covers it; this flag does, and
  // also stops Enter from starting a second ban while one is in flight.
  const [banning, setBanning] = createSignal(false);

  async function onSubmit() {
    if (banning()) return;
    setBanning(true);

    try {
      const reason = group.controls.reason.value.trim();

      await props.member.ban({
        reason: reason || undefined,
        delete_message_seconds: Number(
          group.controls.deleteMessageSeconds.value,
        ),
      });

      props.onClose();
    } catch (error) {
      showError(error);
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
            maxlength={1024}
            counter
            name="reason"
            control={group.controls.reason}
            label={t`Reason`}
            placeholder={t`User broke a certain rule…`}
          />
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

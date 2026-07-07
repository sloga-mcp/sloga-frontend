import { createFormControl, createFormGroup } from "solid-forms";

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
 * Suspend a user from the platform (privileged accounts only)
 */
export function SuspendUserModal(
  props: DialogProps & Modals & { type: "suspend_user" },
) {
  const { t } = useLingui();
  const { showError } = useModals();

  const group = createFormGroup({
    reason: createFormControl(""),
    durationDays: createFormControl("0"),
  });

  async function onSubmit() {
    try {
      const durationDays = Number(group.controls.durationDays.value);
      const reason = group.controls.reason.value.trim();

      // stoat-api's typed client silently drops the body of requests to
      // routes missing from its generated route tables, so go through
      // fetch instead — otherwise duration and reason never reach the
      // server and every suspension becomes indefinite.
      const api = props.client.api as unknown as {
        baseURL: string;
        auth: Record<string, string>;
      };

      const response = await fetch(
        `${api.baseURL}/safety/users/${props.user.id}/suspend`,
        {
          method: "POST",
          headers: { ...api.auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            duration_days: durationDays > 0 ? durationDays : undefined,
            reason: reason ? [reason] : undefined,
          }),
        },
      );

      if (!response.ok) throw await response.text();

      props.onClose();
    } catch (error) {
      showError(error);
    }
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Suspend User From Platform</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Suspend</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !Form2.canSubmit(group),
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column align>
          <Avatar src={props.user.animatedAvatarURL} size={64} />
          <Text>
            <Trans>
              You are about to suspend {props.user.username} from the entire
              platform. Their account will be disabled and all of their
              sessions will be revoked.
            </Trans>
          </Text>
          <Form2.Select
            label={t`Duration`}
            control={group.controls.durationDays}
          >
            <MenuItem value="0">
              <Trans>Indefinite</Trans>
            </MenuItem>
            <MenuItem value="1">
              <Trans>1 day</Trans>
            </MenuItem>
            <MenuItem value="3">
              <Trans>3 days</Trans>
            </MenuItem>
            <MenuItem value="7">
              <Trans>7 days</Trans>
            </MenuItem>
            <MenuItem value="30">
              <Trans>30 days</Trans>
            </MenuItem>
          </Form2.Select>
          <Form2.TextField
            maxlength={1024}
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

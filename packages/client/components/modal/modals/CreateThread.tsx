import { createFormControl, createFormGroup } from "solid-forms";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useNavigate } from "@revolt/routing";
import { Column, Dialog, DialogProps, Form2, MenuItem } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Modal to create a new thread under a text channel, optionally anchored
 * to an existing message
 */
export function CreateThreadModal(
  props: DialogProps & Modals & { type: "create_thread" },
) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { showError } = useModals();

  const group = createFormGroup({
    name: createFormControl(
      // prefill from the anchor message's content, within the name limit
      (props.message?.content ?? "").slice(0, 32).trim(),
      { required: true },
    ),
    autoArchiveMinutes: createFormControl("1440"),
  });

  async function onSubmit() {
    try {
      const thread = await props.channel.createThread(
        {
          name: group.controls.name.value,
          auto_archive_minutes: Number(
            group.controls.autoArchiveMinutes.value,
          ),
        },
        props.message?.id,
      );

      navigate(thread.path);
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
      title={<Trans>Create thread</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Create</Trans>,
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
        <Column>
          <Form2.TextField
            minlength={1}
            maxlength={32}
            counter
            name="name"
            control={group.controls.name}
            label={t`Thread Name`}
          />

          <Form2.Select
            label={t`Auto-archive after inactivity`}
            control={group.controls.autoArchiveMinutes}
          >
            <MenuItem value="60">
              <Trans>1 hour</Trans>
            </MenuItem>
            <MenuItem value="1440">
              <Trans>24 hours</Trans>
            </MenuItem>
            <MenuItem value="4320">
              <Trans>3 days</Trans>
            </MenuItem>
            <MenuItem value="10080">
              <Trans>7 days</Trans>
            </MenuItem>
          </Form2.Select>
        </Column>
      </form>
    </Dialog>
  );
}

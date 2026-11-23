import { createFormControl, createFormGroup } from "solid-forms";
import { Show, onCleanup } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import {
  PASSKEY_NAME_MAX,
  passkeyNameProblem,
} from "@revolt/app/interface/settings/user/account/passkeyRules";
import { Column, Dialog, DialogProps, Form2, Text } from "@revolt/ui";

import { Modals } from "../types";

/**
 * Name a new passkey, or rename one. The name is checked here, before any
 * request is made with it.
 */
export function PasskeyNameModal(
  props: DialogProps & Modals & { type: "passkey_name" },
) {
  const { t } = useLingui();

  const group = createFormGroup({
    // eslint-disable-next-line solid/reactivity
    name: createFormControl(props.name, { required: true }),
  });

  // Answer exactly once; a dismissal answers with nothing
  let settled = false;
  onCleanup(() => {
    if (!settled) {
      settled = true;
      props.callback();
    }
  });

  const problem = () => passkeyNameProblem(group.controls.name.value);

  function onSubmit() {
    if (problem()) return;

    settled = true;
    props.callback(group.controls.name.value.trim());
    props.onClose();
  }

  // Not `Form2.useSubmitHandler`: it resets the field after every attempt,
  // which would wipe a name that only needs shortening
  function submit(event: Event) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={
        <Show when={props.rename} fallback={<Trans>Name this passkey</Trans>}>
          <Trans>Rename passkey</Trans>
        </Show>
      }
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: (
            <Show when={props.rename} fallback={<Trans>Continue</Trans>}>
              <Trans>Rename</Trans>
            </Show>
          ),
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !!problem(),
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
          <Show when={!props.rename}>
            <Text>
              <Trans>A name helps you tell your passkeys apart.</Trans>
            </Text>
          </Show>
          <Form2.TextField
            name="name"
            maxlength={PASSKEY_NAME_MAX}
            control={group.controls.name}
            label={t`Name`}
          />
          <Show when={problem() === "long"}>
            <Text>
              <Trans>Use 1 to 64 characters.</Trans>
            </Text>
          </Show>
          <Show when={problem() === "control"}>
            <Text>
              <Trans>That name cannot be used.</Trans>
            </Text>
          </Show>
        </Column>
      </form>
    </Dialog>
  );
}

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { createFormControl, createFormGroup } from "solid-forms";

import { AndroidScreenShareTierName } from "@revolt/state/stores/Voice";
import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";

import { Modals } from "../types";

/**
 * The phone share sheet (screen-leg plan §7.6): pick a tier, start the share.
 *
 * Deliberately NOT `screen_share_settings` (wants a live track for preview —
 * the native leg has none the WebView can see, §0.9) and NOT
 * `screen_share_picker` (wants desktop capture sources — the OS chooser that
 * follows this sheet is where Android picks a screen/app). Confirming here
 * leads to the system consent dialog, which re-asks on every share by OS
 * rule; the copy sets that expectation so the double prompt reads as designed
 * rather than broken.
 */
export function AndroidScreenShareSheetModal(
  props: DialogProps & Modals & { type: "android_screen_share_sheet" },
) {
  const { t } = useLingui();

  const group = createFormGroup({
    tier: createFormControl<AndroidScreenShareTierName>(props.initialTier, {
      required: true,
    }),
  });

  const tierLabel = (name: AndroidScreenShareTierName) => {
    switch (name) {
      case "dataSaver":
        return t`Data saver`;
      case "high":
        return t`High quality`;
      default:
        return t`Standard`;
    }
  };

  function onSubmit() {
    props.callback(group.controls.tier.value);
    props.onClose();
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    <Dialog
      show={props.show}
      onClose={() => {
        props.onCancel();
        props.onClose();
      }}
      title={t`Share your screen`}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Continue</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
        },
      ]}
    >
      <form onSubmit={submit}>
        <Column>
          <Form2.ButtonGroup
            control={group.controls.tier}
            buttonDefinitions={props.tiers.map((tier) => ({
              children: (
                <Column gap="none">
                  <span>{tierLabel(tier.name)}</span>
                  <small>
                    {tier.longSide}p · {tier.fps} fps
                  </small>
                </Column>
              ),
              value: tier.name,
            }))}
          />
          <small>
            <Trans>
              Android will ask you to confirm every time you start sharing.
            </Trans>
          </small>
          <small>
            <Trans>
              Sharing stops if the call stops being end-to-end encrypted or your
              connection changes.
            </Trans>
          </small>
        </Column>
      </form>
    </Dialog>
  );
}

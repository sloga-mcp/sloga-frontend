import { For, Show, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { styled } from "styled-system/jsx";

import { E2EESendError } from "@revolt/client";
import {
  MAX_TIMELOCK_HORIZON_MS,
  MAX_TIMELOCK_PLAINTEXT_BYTES,
  encryptTimelockMessage,
  timelockPlaintextBytes,
} from "@revolt/common";
import { useState } from "@revolt/state";
import { Column, Dialog, DialogProps } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

/** Encrypting to a round that lands mid-encryption helps nobody. */
const MIN_LEAD_MS = 60_000;

/**
 * Modal to seal the channel's current draft as a timelocked message: the
 * draft is encrypted ON THIS DEVICE against the drand randomness beacon so it
 * cannot be decrypted — by anyone, including us — until the chosen time, then
 * sent through the normal message path as ordinary content.
 */
export function TimelockComposeModal(
  props: DialogProps & Modals & { type: "timelock_compose" },
) {
  const { t } = useLingui();
  const state = useState();
  const { openModal, showError } = useModals();

  const [pending, setPending] = createSignal(false);
  const [custom, setCustom] = createSignal<string>("");
  const [presetMs, setPresetMs] = createSignal<number | undefined>(
    24 * 60 * 60 * 1000,
  );

  const presets: { label: string; offsetMs: number }[] = [
    { label: t`In 1 hour`, offsetMs: 60 * 60 * 1000 },
    { label: t`In 24 hours`, offsetMs: 24 * 60 * 60 * 1000 },
    { label: t`In a week`, offsetMs: 7 * 24 * 60 * 60 * 1000 },
    { label: t`In 30 days`, offsetMs: 30 * 24 * 60 * 60 * 1000 },
    { label: t`In a year`, offsetMs: 365 * 24 * 60 * 60 * 1000 },
  ];

  const draft = () => state.draft.getDraft(props.channel.id);

  /** Resolve the chosen preset / custom input to an absolute instant */
  const unlockAt = (): number | undefined => {
    if (custom()) {
      const instant = new Date(custom()).getTime();
      return Number.isNaN(instant) ? undefined : instant;
    }
    const offset = presetMs();
    return offset === undefined ? undefined : Date.now() + offset;
  };

  const validWindow = () => {
    const instant = unlockAt();
    return (
      instant !== undefined &&
      instant >= Date.now() + MIN_LEAD_MS &&
      instant <= Date.now() + MAX_TIMELOCK_HORIZON_MS
    );
  };

  const tooLong = () =>
    timelockPlaintextBytes(draft().content?.trim() ?? "") >
    MAX_TIMELOCK_PLAINTEXT_BYTES;

  const canSeal = () =>
    !pending() && !!draft().content?.trim() && !tooLong() && validWindow();

  async function seal() {
    if (!canSeal()) return;
    setPending(true);
    try {
      const content = await encryptTimelockMessage(
        draft().content!.trim(),
        new Date(unlockAt()!),
      );
      await props.channel.sendMessage({
        content,
        replies: draft().replies,
      });

      // Mirror a successful send: the composed text has left the composer.
      state.draft.setDraft(props.channel.id, { content: "", replies: [] });
      props.onClose();
    } catch (error) {
      // A group this device cannot confirm is unencrypted refuses the send
      // before anything leaves the device. Ask for consent; the draft stays
      // and nothing is resent automatically.
      if (
        error instanceof E2EESendError &&
        (error.kind === "group_unconfirmed" ||
          error.kind === "group_unestablished")
      ) {
        openModal({
          type: "e2ee_group_plaintext_confirm",
          channelId: props.channel.id,
        });
      } else {
        showError(error);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Timelock message</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Seal & send</Trans>,
          onClick: () => {
            void seal();
            return false;
          },
          isDisabled: !canSeal(),
        },
      ]}
      isDisabled={pending()}
    >
      <Column>
        <Preview>
          <Symbol size={16}>lock_clock</Symbol>
          <PreviewText>
            {draft().content?.trim() || t`Your draft is empty`}
          </PreviewText>
        </Preview>

        <Options>
          <For each={presets}>
            {(preset) => (
              <Option
                type="button"
                data-selected={
                  (!custom() && presetMs() === preset.offsetMs) || undefined
                }
                onClick={() => {
                  setCustom("");
                  setPresetMs(preset.offsetMs);
                }}
              >
                {preset.label}
              </Option>
            )}
          </For>
        </Options>

        <FieldLabel>
          <Trans>Or pick a time</Trans>
        </FieldLabel>
        <TimeInput
          type="datetime-local"
          value={custom()}
          onInput={(event) => setCustom(event.currentTarget.value)}
        />

        <Show when={custom() && !validWindow()}>
          <Warning>
            <Symbol size={16}>error</Symbol>
            <Trans>Pick a time between 1 minute and 5 years from now.</Trans>
          </Warning>
        </Show>

        <Show when={tooLong()}>
          <Warning>
            <Symbol size={16}>error</Symbol>
            <Trans>This message is too long to timelock.</Trans>
          </Warning>
        </Show>

        <Hint>
          <Symbol size={16}>encrypted</Symbol>
          <Trans>
            Sealed on your device using timelock encryption against the drand
            randomness beacon. Nobody — not the recipients, not the server, not
            even you — can open it before the chosen time. It unlocks for
            everyone at once.
          </Trans>
        </Hint>
      </Column>
    </Dialog>
  );
}

const Preview = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    alignItems: "flex-start",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "0.85rem",
  },
});

const PreviewText = styled("span", {
  base: {
    maxHeight: "60px",
    overflow: "hidden",
    overflowWrap: "anywhere",
  },
});

const Options = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const Option = styled("button", {
  base: {
    padding: "6px 12px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.8125rem",
    cursor: "pointer",
    "&[data-selected]": {
      background: "var(--md-sys-color-primary-container)",
      borderColor: "var(--md-sys-color-primary)",
      color: "var(--md-sys-color-on-primary-container)",
    },
  },
});

const FieldLabel = styled("span", {
  base: {
    fontSize: "0.8125rem",
    fontWeight: "600",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const TimeInput = styled("input", {
  base: {
    padding: "10px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.9rem",
    colorScheme: "dark light",
    "&:focus": {
      outline: "none",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const Warning = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    alignItems: "center",
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-error)",
  },
});

const Hint = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    alignItems: "flex-start",
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "0.8125rem",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

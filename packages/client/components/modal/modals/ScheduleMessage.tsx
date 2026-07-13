import { For, Show, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import { Column, Dialog, DialogProps } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

/** Server-enforced delivery window */
const MIN_LEAD_MS = 30_000;
const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Modal to schedule the channel's current draft for later delivery. The
 * payload is stored server-side (plaintext) and sent through the normal
 * message path when due, with roughly half a minute of jitter.
 */
export function ScheduleMessageModal(
  props: DialogProps & Modals & { type: "schedule_message" },
) {
  const { t } = useLingui();
  const state = useState();
  const { showError } = useModals();

  const [pending, setPending] = createSignal(false);
  const [custom, setCustom] = createSignal<string>("");
  const [presetMs, setPresetMs] = createSignal<number | undefined>(
    60 * 60 * 1000,
  );

  const presets: { label: string; offsetMs: number }[] = [
    { label: t`In 30 minutes`, offsetMs: 30 * 60 * 1000 },
    { label: t`In 1 hour`, offsetMs: 60 * 60 * 1000 },
    { label: t`In 4 hours`, offsetMs: 4 * 60 * 60 * 1000 },
    { label: t`Tomorrow at 9:00`, offsetMs: -1 },
    { label: t`In a week`, offsetMs: 7 * 24 * 60 * 60 * 1000 },
  ];

  const draft = () => state.draft.getDraft(props.channel.id);

  /** Resolve the chosen preset / custom input to an absolute instant */
  const scheduledAt = (): number | undefined => {
    if (custom()) {
      const instant = new Date(custom()).getTime();
      return Number.isNaN(instant) ? undefined : instant;
    }

    const offset = presetMs();
    if (offset === undefined) return undefined;
    if (offset === -1) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      return tomorrow.getTime();
    }
    return Date.now() + offset;
  };

  const validWindow = () => {
    const instant = scheduledAt();
    return (
      instant !== undefined &&
      instant >= Date.now() + MIN_LEAD_MS &&
      instant <= Date.now() + MAX_HORIZON_MS
    );
  };

  const canSchedule = () =>
    !pending() && !!draft().content?.trim() && validWindow();

  async function schedule() {
    if (!canSchedule()) return;
    setPending(true);
    try {
      await props.channel.scheduleMessage(
        {
          content: draft().content,
          replies: draft().replies,
        },
        scheduledAt()!,
      );

      // Mirror a successful send: the composed text has left the composer
      // (attachments are blocked at the entry point, so files are kept).
      state.draft.setDraft(props.channel.id, { content: "", replies: [] });
      props.onClose();
    } catch (error) {
      showError(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Send later</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Schedule</Trans>,
          onClick: () => {
            void schedule();
            return false;
          },
          isDisabled: !canSchedule(),
        },
      ]}
      isDisabled={pending()}
    >
      <Column>
        <Preview>
          <Symbol size={16}>schedule_send</Symbol>
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
            <Trans>
              Pick a time between 30 seconds and 30 days from now.
            </Trans>
          </Warning>
        </Show>

        <Hint>
          <Symbol size={16}>info</Symbol>
          <Trans>
            The message is stored on the server and sent around the chosen
            time. You can cancel it from the channel until it goes out.
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

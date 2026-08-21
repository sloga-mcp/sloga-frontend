import { Index, Show, createEffect, createSignal, onCleanup } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { submitModal } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { Column, Dialog, DialogProps } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * A form a bot asked this user to fill in.
 *
 * The fields are entirely bot-defined, so nothing here is hardcoded — the
 * shape arrives with the `interactionModalOpen` event. Every constraint is
 * re-checked server-side against the stored definition, so the validation
 * below is purely to save the user a round-trip.
 */
export function BotInteractionModal(
  props: DialogProps & Modals & { type: "bot_interaction_modal" },
) {
  const { t } = useLingui();
  const client = useClient();
  const modals = useModals();

  const [values, setValues] = createSignal<Record<string, string>>(
    Object.fromEntries(
      props.modal.inputs.map((input) => [input.custom_id, input.value ?? ""]),
    ),
  );
  const [pending, setPending] = createSignal(false);

  function setValue(customId: string, value: string) {
    setValues((current) => ({ ...current, [customId]: value }));
  }

  // Count characters, not UTF-16 units, to match how the server measures —
  // otherwise an emoji would cost two against the bot's stated limit.
  const lengthOf = (value: string) => [...value].length;

  function fieldError(customId: string): string | undefined {
    const input = props.modal.inputs.find(
      (entry) => entry.custom_id === customId,
    );
    if (!input) return undefined;

    const value = values()[customId] ?? "";
    if (input.required && !value.trim()) return t`Required`;

    const length = lengthOf(value);
    if (input.max_length && length > input.max_length) {
      return t`Too long`;
    }
    // An omitted optional field is absent, not short.
    if (value && input.min_length && length < input.min_length) {
      return t`Too short`;
    }
    return undefined;
  }

  const canSubmit = () =>
    !pending() &&
    props.modal.inputs.every((input) => !fieldError(input.custom_id));

  // Hold the dialog open while the submission is in flight: it is single-use
  // server-side, so a dismissal mid-request loses the user's typing with no
  // way to send it again.
  let lockToken: string | undefined;
  createEffect(() => {
    if (pending() && !lockToken) {
      lockToken = modals.lockDismiss();
    } else if (!pending() && lockToken) {
      modals.unlockDismiss(lockToken);
      lockToken = undefined;
    }
  });
  onCleanup(() => {
    if (lockToken) modals.unlockDismiss(lockToken);
  });

  function guardedClose() {
    if (pending()) return;
    props.onClose();
  }

  async function onSubmit() {
    if (!canSubmit()) return;
    setPending(true);
    try {
      await submitModal(client(), props.interactionId, values());
      props.onClose();
    } catch (error) {
      const type = (error as { type?: string })?.type;
      modals.showError(
        type === "BotOffline"
          ? t`That bot is currently offline — try again once it reconnects.`
          : type === "InteractionExpired"
            ? t`This form has expired.`
            : type === "InteractionAlreadyResponded"
              ? t`This form has already been submitted.`
              : error,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={guardedClose}
      title={props.modal.title}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Submit</Trans>,
          onClick: () => {
            void onSubmit();
            return false;
          },
          isDisabled: !canSubmit(),
        },
      ]}
      isDisabled={pending()}
    >
      <Column>
        {/* Index (not For): the values mutate on every keystroke, and For
            keys rows by value — it would destroy and recreate the input
            node each letter, dropping focus. */}
        <Index each={props.modal.inputs}>
          {(input) => (
            <Column gap="sm">
              <FieldLabel>
                {input().label}
                <Show when={input().required}>
                  <Required aria-hidden="true">*</Required>
                </Show>
              </FieldLabel>

              <Show
                when={input().style === "Paragraph"}
                fallback={
                  <FieldInput
                    value={values()[input().custom_id] ?? ""}
                    maxlength={input().max_length}
                    placeholder={input().placeholder}
                    disabled={pending()}
                    onInput={(event) =>
                      setValue(input().custom_id, event.currentTarget.value)
                    }
                  />
                }
              >
                <FieldTextArea
                  value={values()[input().custom_id] ?? ""}
                  maxlength={input().max_length}
                  placeholder={input().placeholder}
                  disabled={pending()}
                  rows={4}
                  onInput={(event) =>
                    setValue(input().custom_id, event.currentTarget.value)
                  }
                />
              </Show>

              <Show when={fieldError(input().custom_id)}>
                {(error) => <FieldError>{error()}</FieldError>}
              </Show>
            </Column>
          )}
        </Index>
      </Column>
    </Dialog>
  );
}

const FieldLabel = styled("span", {
  base: {
    display: "flex",
    gap: "2px",
    fontSize: "0.8125rem",
    fontWeight: "600",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Required = styled("span", {
  base: {
    color: "var(--md-sys-color-error)",
  },
});

const FieldError = styled("small", {
  base: {
    color: "var(--md-sys-color-error)",
  },
});

const FieldInput = styled("input", {
  base: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.9rem",
    "&:focus": {
      outline: "none",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const FieldTextArea = styled("textarea", {
  base: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "var(--md-sys-color-surface-container-high)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.9rem",
    fontFamily: "inherit",
    resize: "vertical",
    "&:focus": {
      outline: "none",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

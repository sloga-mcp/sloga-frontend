import { For, Show, createSignal } from "solid-js";

import { createFormControl, createFormGroup } from "solid-forms";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { Column, Dialog, DialogProps, Form2, IconButton, MenuItem } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { useModals } from "..";
import { Modals } from "../types";

/** Server-enforced answer limits */
const MIN_ANSWERS = 2;
const MAX_ANSWERS = 10;

/**
 * Modal to create a poll in a channel. The server assembles the message
 * and counts votes authoritatively; results stay hidden until you vote.
 */
export function CreatePollModal(
  props: DialogProps & Modals & { type: "create_poll" },
) {
  const { t } = useLingui();
  const { showError } = useModals();

  const group = createFormGroup({
    question: createFormControl("", { required: true }),
    duration: createFormControl("24"),
  });

  const [answers, setAnswers] = createSignal<string[]>(["", ""]);
  const [multiselect, setMultiselect] = createSignal(false);
  const [pending, setPending] = createSignal(false);

  function setAnswer(index: number, value: string) {
    setAnswers((current) =>
      current.map((answer, i) => (i === index ? value : answer)),
    );
  }

  function addAnswer() {
    setAnswers((current) =>
      current.length >= MAX_ANSWERS ? current : [...current, ""],
    );
  }

  function removeAnswer(index: number) {
    setAnswers((current) =>
      current.length <= MIN_ANSWERS
        ? current
        : current.filter((_, i) => i !== index),
    );
  }

  const validAnswers = () =>
    answers()
      .map((answer) => answer.trim())
      .filter((answer) => answer.length > 0);

  const canSubmit = () =>
    !pending() &&
    group.controls.question.value.trim().length > 0 &&
    validAnswers().length >= MIN_ANSWERS &&
    // No blank rows in between — every present row must be filled
    validAnswers().length === answers().length;

  async function onSubmit() {
    if (!canSubmit()) return;
    setPending(true);
    try {
      await props.channel.createPoll({
        question: group.controls.question.value.trim(),
        answers: validAnswers().map((text) => ({ text })),
        allow_multiselect: multiselect(),
        duration_hours: Number(group.controls.duration.value),
      });
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
      title={<Trans>Create poll</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Create</Trans>,
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
        <Form2.TextField
          minlength={1}
          maxlength={300}
          counter
          name="question"
          control={group.controls.question}
          label={t`Question`}
        />

        <Column gap="sm">
          <FieldLabel>
            <Trans>Answers</Trans>
          </FieldLabel>
          <For each={answers()}>
            {(answer, index) => (
              <AnswerRow>
                <AnswerInput
                  value={answer}
                  maxlength={100}
                  placeholder={t`Answer ${index() + 1}`}
                  onInput={(event) =>
                    setAnswer(index(), event.currentTarget.value)
                  }
                />
                <Show when={answers().length > MIN_ANSWERS}>
                  <IconButton onPress={() => removeAnswer(index())}>
                    <Symbol>close</Symbol>
                  </IconButton>
                </Show>
              </AnswerRow>
            )}
          </For>
          <Show when={answers().length < MAX_ANSWERS}>
            <AddAnswer type="button" onClick={addAnswer}>
              <Symbol>add</Symbol> <Trans>Add answer</Trans>
            </AddAnswer>
          </Show>
        </Column>

        <ToggleRow onClick={() => setMultiselect((v) => !v)}>
          <ToggleBox data-checked={multiselect() || undefined}>
            <Show when={multiselect()}>
              <Symbol size={16}>check</Symbol>
            </Show>
          </ToggleBox>
          <Trans>Allow multiple answers</Trans>
        </ToggleRow>

        <Form2.Select label={t`Poll duration`} control={group.controls.duration}>
          <MenuItem value="1">
            <Trans>1 hour</Trans>
          </MenuItem>
          <MenuItem value="4">
            <Trans>4 hours</Trans>
          </MenuItem>
          <MenuItem value="8">
            <Trans>8 hours</Trans>
          </MenuItem>
          <MenuItem value="24">
            <Trans>24 hours</Trans>
          </MenuItem>
          <MenuItem value="72">
            <Trans>3 days</Trans>
          </MenuItem>
          <MenuItem value="168">
            <Trans>1 week</Trans>
          </MenuItem>
          <MenuItem value="336">
            <Trans>2 weeks</Trans>
          </MenuItem>
          <MenuItem value="768">
            <Trans>32 days</Trans>
          </MenuItem>
        </Form2.Select>

        <Show
          when={
            props.channel.type === "DirectMessage" ||
            props.channel.type === "Group"
          }
        >
          <Notice>
            <Symbol size={16}>info</Symbol>
            <Trans>
              Polls are counted by the server and are never end-to-end
              encrypted — the question, answers and votes are visible to it.
            </Trans>
          </Notice>
        </Show>
      </Column>
    </Dialog>
  );
}

const FieldLabel = styled("span", {
  base: {
    fontSize: "0.8125rem",
    fontWeight: "600",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const AnswerRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});

const AnswerInput = styled("input", {
  base: {
    flexGrow: 1,
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

const AddAnswer = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    width: "fit-content",
    padding: "6px 12px",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    fontSize: "0.8125rem",
  },
});

const ToggleRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    cursor: "pointer",
    userSelect: "none",
    fontSize: "0.9rem",
  },
});

const ToggleBox = styled("div", {
  base: {
    width: "20px",
    height: "20px",
    borderRadius: "6px",
    display: "grid",
    placeItems: "center",
    border: "2px solid var(--md-sys-color-outline)",
    color: "var(--md-sys-color-on-primary)",
    flexShrink: 0,
    "&[data-checked]": {
      background: "var(--md-sys-color-primary)",
      borderColor: "var(--md-sys-color-primary)",
    },
  },
});

const Notice = styled("div", {
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

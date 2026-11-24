import { createFormControl, createFormGroup } from "solid-forms";
import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onMount,
} from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { Client, Message as MessageI, Server, User } from "stoat.js";
import { cva } from "styled-system/css";

import { Message } from "@revolt/app";
import {
  Avatar,
  Column,
  Dialog,
  DialogProps,
  Form2,
  Initials,
  MenuItem,
  Radio2,
  Text,
} from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import {
  type ContentReportReason,
  type ReportReason,
  type TakedownForm,
  type UserReportReason,
  reportReasons,
  takedownBody,
  takedownFormState,
  takedownReportsEnabled,
} from "./reportReasons";

/**
 * Public page explaining Take It Down requests
 */
const TAKE_IT_DOWN_URL = "https://sloga.gg/legal/take-it-down.html";

/**
 * Number of cached messages included either side of the reported message
 */
const SNAPSHOT_CONTEXT_RADIUS = 5;

/**
 * Copy of a message as seen on the reporter's device.
 *
 * For an end-to-end encrypted message the `content` is the decrypted
 * plaintext the reporter's device holds locally — the server relayed only
 * ciphertext and cannot produce it. `encrypted: true` tells the safety team
 * the plaintext was attached BY THE REPORTER (provenance matters: it was
 * never server-visible), satisfying slice 3's reporter-side plaintext
 * attach requirement. Encrypted-ness comes from the native bridge's trusted
 * record, NEVER a message flag (which the server could forge to mislabel a
 * plaintext message as encrypted).
 */
function snapshotOf(client: Client, message: MessageI) {
  const encrypted = client.e2ee?.isEncryptedMessage(message.id) ?? false;
  return {
    id: message.id,
    channel: message.channelId,
    author: message.authorId ?? "",
    content: message.content,
    ...(encrypted ? { encrypted: true } : {}),
  };
}

/**
 * Build the reporter-side snapshot of a message and its surrounding context
 * from the local message cache. The report carries the content as seen by
 * the reporter, so reporting keeps working for conversations the server
 * cannot read (end-to-end encrypted DMs) — the decrypted plaintext is
 * attached from the reporter's local store, never from the server.
 */
function buildMessageSnapshot(client: Client, message: MessageI) {
  const nearby = client.messages
    .filter(
      (entry) =>
        entry.channelId === message.channelId &&
        entry.id !== message.id &&
        !entry.systemMessage,
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const before = nearby
    .filter((entry) => entry.id < message.id)
    .slice(-SNAPSHOT_CONTEXT_RADIUS);
  const after = nearby
    .filter((entry) => entry.id > message.id)
    .slice(0, SNAPSHOT_CONTEXT_RADIUS);

  return {
    message: snapshotOf(client, message),
    context: [...before, ...after].map((entry) => snapshotOf(client, entry)),
  };
}

/**
 * Modal to report content
 */
export function ReportContentModal(
  props: DialogProps & Modals & { type: "report_content" },
) {
  const { t } = useLingui();
  const { showError } = useModals();

  const strings: Record<ReportReason, string> = {
    Illegal: t`Content breaks one or more laws`,
    IllegalGoods: t`Drugs or illegal goods`,
    IllegalExtortion: t`Extortion or blackmail`,
    IllegalPornography: t`Revenge or underage pornography`,
    NonConsensualIntimateImage: t`Intimate image shared without consent`,
    ChildSexualAbuseMaterial: t`Child sexual abuse material`,
    IllegalHacking: t`Illegal hacking or cracking`,
    ExtremeViolence: t`Extreme violence, gore or animal cruelty`,
    PromotesHarm: t`Promotes harm`,
    UnsolicitedSpam: t`Unsolicited advertising or spam`,
    Raid: t`Raid or spam attack`,
    SpamAbuse: t`Spam or similar platform abuse`,
    ScamsFraud: t`Scams or fraud`,
    Malware: t`Malware or phishing`,
    Harassment: t`Harassment or cyberbullying`,
    NoneSpecified: t`Other`,

    InappropriateProfile: t`User's profile has inappropriate content`,
    Impersonation: t`Impersonation`,
    BanEvasion: t`Ban evasion`,
    Underage: t`Not of minimum age to use the platform`,
  };

  const group = createFormGroup({
    category: createFormControl("", { required: true }),
    detail: createFormControl(""),

    // Take It Down request, only sent with the intimate image reason. No
    // role is picked for the reporter: a bystander has their own choice.
    role: createFormControl(""),
    authorityNote: createFormControl(""),
    signature: createFormControl(""),
    signatureAck: createFormControl(false),
    statementAck: createFormControl(false),
    email: createFormControl(""),
    extra: createFormControl(""),
  });

  const [takedownEnabled, setTakedownEnabled] = createSignal(false);

  // Offer the Take It Down reasons only when the server says it takes them;
  // until then (and on an older server, or any failure) the list is the one
  // from before they existed. The dialog never waits for this.
  onMount(() => {
    const client = props.client;
    takedownReportsEnabled(client.options.baseURL, () =>
      // `/takedown/config` is not part of the upstream API typings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client.api.get as any)("/takedown/config"),
    ).then(setTakedownEnabled);
  });

  const reasons = createMemo(() =>
    reportReasons(
      props.target instanceof User ? "user" : "content",
      takedownEnabled(),
      group.controls.category.value,
    ),
  );

  /**
   * Whether the reported message is end-to-end encrypted, judged by the
   * native bridge's record, never by a message flag
   */
  const encryptedTarget =
    // eslint-disable-next-line solid/reactivity
    props.target instanceof MessageI &&
    // eslint-disable-next-line solid/reactivity
    (props.client.e2ee?.isEncryptedMessage(props.target.id) ?? false);

  const [sending, setSending] = createSignal(false);
  const [filed, setFiled] = createSignal(false);

  const intimateImage = () =>
    group.controls.category.value === "NonConsensualIntimateImage";

  const takedownForm = (): TakedownForm => ({
    role: group.controls.role.value,
    authorityNote: group.controls.authorityNote.value,
    signature: group.controls.signature.value,
    signatureAck: group.controls.signatureAck.value,
    statementAck: group.controls.statementAck.value,
    email: group.controls.email.value,
    extra: group.controls.extra.value,
  });

  /**
   * A role must be picked; the person shown or someone acting for them also
   * signs, ticks both boxes and gives a valid email if any
   */
  const takedownState = () =>
    takedownFormState(group.controls.category.value, takedownForm());

  const filingRole = () =>
    group.controls.role.value === "Depicted" ||
    group.controls.role.value === "Authorized";

  const [emailBlurred, setEmailBlurred] = createSignal(false);

  const canReport = () =>
    Form2.canSubmit(group) && !sending() && takedownState().ready;

  async function onSubmit() {
    // Both the Report button and Enter in a field land here (the latter
    // with the group already pending, so not `canReport`); a second press
    // while sending would file a second request
    const state = takedownState();
    if (sending() || !state.ready) return;
    setSending(true);

    try {
      const category = group.controls.category.value;
      const detail = group.controls.detail.value;

      if (!category || (category === "NoneSpecified" && !detail)) {
        throw new Error("NoReasonProvided");
      }

      const takedown = state.filesTakedown
        ? takedownBody(takedownForm())
        : undefined;

      // Reporter-side snapshot: attach the reported message (or the
      // supporting context message for user reports) as seen locally
      const snapshotTarget =
        props.target instanceof MessageI
          ? props.target
          : props.target instanceof User
            ? props.contextMessage
            : undefined;

      // `message_snapshot` is not part of the upstream API typings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (props.client.api.post as any)("/safety/report", {
        content:
          props.target instanceof User
            ? {
                type: "User",
                id: props.target.id,
                report_reason: category as UserReportReason,
                message_id: props.contextMessage?.id,
              }
            : props.target instanceof Server
              ? {
                  type: "Server",
                  id: props.target.id,
                  report_reason: category as ContentReportReason,
                }
              : {
                  type: "Message",
                  id: props.target.id,
                  report_reason: category as ContentReportReason,
                },
        additional_context: detail,
        message_snapshot: snapshotTarget
          ? buildMessageSnapshot(props.client, snapshotTarget)
          : undefined,
        takedown,
      });

      if (takedown) {
        // Stay open to say what happens next
        setFiled(true);
      } else {
        props.onClose();
      }
    } catch (error) {
      showError(error);
    } finally {
      setSending(false);
    }
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={
        <Switch>
          <Match when={filed()}>
            <Trans>Report sent</Trans>
          </Match>
          <Match when={props.target instanceof User}>
            <Trans>Tell us what's wrong with this user</Trans>
          </Match>
          <Match when={props.target instanceof Server}>
            <Trans>Tell us what's wrong with this server</Trans>
          </Match>
          <Match when={props.target instanceof MessageI}>
            <Trans>Tell us what's wrong with this message</Trans>
          </Match>
        </Switch>
      }
      actions={
        filed()
          ? [{ text: <Trans>Close</Trans> }]
          : [
              { text: <Trans>Cancel</Trans> },
              {
                text: <Trans>Report</Trans>,
                onClick: () => {
                  onSubmit();
                  return false;
                },
                isDisabled: !canReport(),
              },
            ]
      }
      isDisabled={group.isPending || sending()}
    >
      <Show
        when={!filed()}
        fallback={
          <Text>
            <Trans>
              A person reviews your report within 48 hours. We'll email you to
              confirm we got it.
            </Trans>
          </Text>
        }
      >
        <form onSubmit={submit}>
          <Column>
            <div class={contentContainer()}>
              {props.target instanceof User ? (
                <Column align>
                  <Avatar src={props.target.animatedAvatarURL} size={64} />
                  {props.target.displayName}
                </Column>
              ) : props.target instanceof Server ? (
                <Column align>
                  <Avatar
                    src={props.target.animatedIconURL}
                    fallback={<Initials input={props.target.name} />}
                    size={64}
                  />
                  {props.target.name}
                </Column>
              ) : (
                <Message message={props.target as never} />
              )}
            </div>

            <Form2.Select
              label={t`Reason for report`}
              control={group.controls.category}
            >
              <MenuItem>
                <Trans>Please select a reason</Trans>
              </MenuItem>
              <For each={reasons()}>
                {(value) => <MenuItem value={value}>{strings[value]}</MenuItem>}
              </For>
            </Form2.Select>

            <Show
              when={
                group.controls.category.value === "ChildSexualAbuseMaterial"
              }
            >
              <Text>
                <Trans>
                  If a child is in immediate danger, contact your local
                  emergency services.
                </Trans>
              </Text>
            </Show>

            <Show when={encryptedTarget}>
              <Text>
                <Trans>
                  This message is end-to-end encrypted, so Sloga can't see it. A
                  person reviews what you send us and can act on the sender's
                  account, but we can't remove copies from people's devices.
                </Trans>
              </Text>
            </Show>

            {/* TODO: use TextEditor? */}
            <Form2.TextField
              name="detail"
              control={group.controls.detail}
              label={t`Give us some detail`}
              maxlength={1000}
            />

            <Show when={intimateImage()}>
              <div class={stackedOptions()}>
                <Form2.Radio control={group.controls.role}>
                  <Radio2.Option value="Depicted">
                    <Trans>I am the person shown</Trans>
                  </Radio2.Option>
                  <Radio2.Option value="Authorized">
                    <Trans>
                      I am authorized to act for the person shown (for example a
                      parent, guardian or lawyer)
                    </Trans>
                  </Radio2.Option>
                  <Radio2.Option value="Bystander">
                    <Trans>I'm not the person shown or acting for them</Trans>
                  </Radio2.Option>
                </Form2.Radio>
              </div>

              <Show when={group.controls.role.value === "Bystander"}>
                <Text>
                  <Trans>
                    The person shown, or someone acting for them, can file a
                    Take It Down request. The link below explains how.
                  </Trans>
                </Text>
              </Show>

              <Show when={filingRole()}>
                <Text>
                  <Trans>
                    This also asks us to remove the image under the Take It Down
                    Act.
                  </Trans>
                </Text>

                <Show when={group.controls.role.value === "Authorized"}>
                  <Form2.TextField
                    name="authority_note"
                    control={group.controls.authorityNote}
                    label={t`How are you authorized? (optional)`}
                    maxlength={1000}
                  />
                </Show>

                <Form2.TextField
                  name="signature"
                  control={group.controls.signature}
                  label={t`Your full name (your signature)`}
                  autocomplete="name"
                  maxlength={200}
                />
                <Form2.Checkbox
                  name="signature_ack"
                  control={group.controls.signatureAck}
                >
                  <Trans>Typing my name here counts as my signature.</Trans>
                </Form2.Checkbox>
                <Form2.Checkbox
                  name="statement_ack"
                  control={group.controls.statementAck}
                >
                  <Trans>
                    The person shown has a good faith belief that the image(s)
                    described were published without their consent.
                  </Trans>
                </Form2.Checkbox>

                <Form2.TextField
                  name="email"
                  type="email"
                  control={group.controls.email}
                  label={t`Contact email (optional)`}
                  helper={t`Leave empty to use your account email`}
                  autocomplete="email"
                  maxlength={254}
                  onBlur={() => setEmailBlurred(true)}
                />
                <Show when={emailBlurred() && !takedownState().emailValid}>
                  <span class={fieldError()}>
                    <Trans>
                      Enter a valid email address, or leave it empty.
                    </Trans>
                  </span>
                </Show>
                <Form2.TextField
                  name="extra"
                  control={group.controls.extra}
                  label={t`Anything else that helps us understand what happened (optional)`}
                  autosize
                  maxlength={4000}
                />
              </Show>

              <a href={TAKE_IT_DOWN_URL} target="_blank" rel="noreferrer">
                <Trans>How removal requests work</Trans>
              </a>
            </Show>
          </Column>
        </form>
      </Show>
    </Dialog>
  );
}

const contentContainer = cva({
  base: {
    maxWidth: "100%",
    maxHeight: "80vh",
    overflowY: "hidden",
    "& > div": {
      marginTop: "0 !important",
      pointerEvents: "none",
      userSelect: "none",
    },
  },
});

/**
 * One radio option per line; the labels are too long to sit side by side
 */
const stackedOptions = cva({
  base: {
    "& mdui-radio": {
      display: "flex",
    },
  },
});

const fieldError = cva({
  base: {
    color: "var(--md-sys-color-error)",
  },
});

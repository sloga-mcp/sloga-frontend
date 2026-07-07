import { createFormControl, createFormGroup } from "solid-forms";
import { For, Match, Switch } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { API, Client, Message as MessageI, Server, User } from "stoat.js";
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
} from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

const CONTENT_REPORT_REASONS: API.ContentReportReason[] = [
  "Illegal",
  "IllegalGoods",
  "IllegalExtortion",
  "IllegalPornography",
  "IllegalHacking",
  "ExtremeViolence",
  "PromotesHarm",
  "UnsolicitedSpam",
  "Raid",
  "SpamAbuse",
  "ScamsFraud",
  "Malware",
  "Harassment",
  "NoneSpecified",
];

const USER_REPORT_REASONS: API.UserReportReason[] = [
  "UnsolicitedSpam",
  "SpamAbuse",
  "InappropriateProfile",
  "Impersonation",
  "BanEvasion",
  "Underage",
  "NoneSpecified",
];

/**
 * Number of cached messages included either side of the reported message
 */
const SNAPSHOT_CONTEXT_RADIUS = 5;

/**
 * Copy of a message as seen on the reporter's device
 */
function snapshotOf(message: MessageI) {
  return {
    id: message.id,
    channel: message.channelId,
    author: message.authorId ?? "",
    content: message.content,
  };
}

/**
 * Build the reporter-side snapshot of a message and its surrounding context
 * from the local message cache. The report carries the content as seen by
 * the reporter, so reporting keeps working for conversations the server
 * cannot read (end-to-end encrypted DMs).
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
    message: snapshotOf(message),
    context: [...before, ...after].map(snapshotOf),
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

  const strings: Record<
    API.ContentReportReason | API.UserReportReason,
    string
  > = {
    Illegal: t`Content breaks one or more laws`,
    IllegalGoods: t`Drugs or illegal goods`,
    IllegalExtortion: t`Extortion or blackmail`,
    IllegalPornography: t`Revenge or underage pornography`,
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
  });

  const reasons =
    // eslint-disable-next-line solid/reactivity
    props.target instanceof User ? USER_REPORT_REASONS : CONTENT_REPORT_REASONS;

  async function onSubmit() {
    try {
      const category = group.controls.category.value;
      const detail = group.controls.detail.value;

      if (!category || (category === "NoneSpecified" && !detail)) {
        throw new Error("NoReasonProvided");
      }

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
                report_reason: category as API.UserReportReason,
                message_id: props.contextMessage?.id,
              }
            : props.target instanceof Server
              ? {
                  type: "Server",
                  id: props.target.id,
                  report_reason: category as API.ContentReportReason,
                }
              : {
                  type: "Message",
                  id: props.target.id,
                  report_reason: category as API.ContentReportReason,
                },
        additional_context: detail,
        message_snapshot: snapshotTarget
          ? buildMessageSnapshot(props.client, snapshotTarget)
          : undefined,
      });
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
      title={
        <Switch>
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
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Report</Trans>,
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
            <For each={reasons}>
              {(value) => <MenuItem value={value}>{strings[value]}</MenuItem>}
            </For>
          </Form2.Select>

          {/* TODO: use TextEditor? */}
          <Form2.TextField
            name="detail"
            control={group.controls.detail}
            label={t`Give us some detail`}
          />
        </Column>
      </form>
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

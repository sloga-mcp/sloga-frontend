import { For, Match, Show, Switch } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import type { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient, useUser } from "@revolt/client";
import { noticeCopy } from "@revolt/client/protectedCopy";
import { Markdown } from "@revolt/markdown";
import { userInformation } from "@revolt/markdown/users";
import { useState } from "@revolt/state";
import type { UnsentMessage } from "@revolt/state/stores/Draft";
import { DM_PAUSED_SEND_ERROR } from "@revolt/state/stores/draftSendError";
import {
  Avatar,
  MessageContainer,
  MessageReply,
  SizedContent,
  Text,
  isSlogaStaff,
  typography,
} from "@revolt/ui";
import { DisplayName } from "@revolt/ui/components/features/DisplayName";

import { DraftMessageContextMenu } from "../../../menus/DraftMessageContextMenu";

interface Props {
  draft: UnsentMessage;
  channel: Channel;
  tail?: boolean;
}

/**
 * Unsent message preview
 */
export function DraftMessage(props: Props) {
  const { t } = useLingui();
  const user = useUser();
  const state = useState();
  const client = useClient();
  const userInfo = () => userInformation(user(), props.channel.server?.member);

  return (
    <MessageContainer
      tail={
        props.tail && (!props.draft.replies || props.draft.replies.length === 0)
      }
      avatar={<Avatar src={userInfo().avatar} size={36} />}
      timestamp={
        props.draft.status === "sending" ? (
          <Trans>Sending...</Trans>
        ) : props.draft.status === "failed" ? (
          <Trans>Failed to send</Trans>
        ) : (
          <Trans>Unsent message</Trans>
        )
      }
      sendStatus={props.draft.status === "sending" ? "sending" : "failed"}
      username={
        <span class={typography({ class: "label", size: "large" })}>
          <DisplayName
            user={user()}
            member={props.channel.server?.member}
            name={userInfo().username}
            brand={isSlogaStaff(user())}
            animate
          />
        </span>
      }
      header={
        <For each={props.draft.replies}>
          {(reply) => (
            <MessageReply
              message={client().messages.get(reply.id)}
              mention={reply.mention}
            />
          )}
        </For>
      }
      contextMenu={() => (
        <DraftMessageContextMenu draft={props.draft} channel={props.channel} />
      )}
      compact={state.settings.getValue("appearance:compact_mode")}
    >
      <BreakText>
        <Markdown content={props.draft.content!} />
      </BreakText>
      <For each={props.draft.files}>
        {(id) => {
          const file = state.draft.getFile(id);

          return (
            <>
              {/* Not wrapped in <Trans> on purpose: the catalogs can't be
                  resynced right now and a missing msgid renders as a raw
                  hash. */}
              <Text class="label">
                {props.draft.status !== "sending"
                  ? file.autumnId
                    ? `\`${file.file.name}\` uploaded`
                    : `\`${file.file.name}\` was not uploaded`
                  : file.uploadProcessing[0]()
                    ? `Processing \`${file.file.name}\` on the server...`
                    : `Uploading file \`${file.file.name}\`... ${(
                        file.uploadProgress[0]() * 100
                      ).toFixed()}%`}
              </Text>
              <Switch>
                <Match when={file.dimensions}>
                  <SizedContent
                    width={file.dimensions![0]}
                    height={file.dimensions![1]}
                  >
                    <img src={file.dataUri} />
                  </SizedContent>
                </Match>
              </Switch>
            </>
          );
        }}
      </For>
      <Show when={props.draft.status === "failed" && props.draft.error}>
        {/* Server reasons stay untranslated for the same reason as the upload
            label above. A paused sender gets a marker instead, which is
            swapped for translated copy here. */}
        <SendError>
          {props.draft.error === DM_PAUSED_SEND_ERROR
            ? t`Your messages to people who aren't your friends are paused while our team reviews your account. You can still message your friends.`
            : props.draft.error}
        </SendError>
      </Show>
      {/* A protected send stores a notice kind, never error text */}
      <Show
        when={props.draft.status === "failed" && props.draft.protectedNotice}
      >
        {(kind) => (
          <SendError>
            {noticeCopy(kind(), props.draft.protectedNoticeMax ?? null)}
          </SendError>
        )}
      </Show>
    </MessageContainer>
  );
}

/**
 * Reason the last send attempt failed
 */
const SendError = styled("div", {
  base: {
    color: "var(--md-sys-color-error)",
    fontSize: "0.875em",
    wordBreak: "break-word",
  },
});

/**
 * Break all text and prevent overflow from math blocks
 */
const BreakText = styled("div", {
  base: {
    wordBreak: "break-word",

    "& .math": {
      overflowX: "auto",
      overflowY: "hidden",
      maxHeight: "100vh",
    },
  },
});

import { Accessor, For, Match, Show, Switch } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { File, Message } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient, useE2EE, useUser } from "@revolt/client";
import { CustomEmoji, UnicodeEmoji } from "@revolt/markdown/emoji";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import { canCopyImageToClipboard, copyImageToClipboard } from "@revolt/ui";
import { MediaPickerProps } from "@revolt/ui/components/features/messaging/composition/picker/CompositionMediaPicker";

import MdBadge from "@material-design-icons/svg/outlined/badge.svg?component-solid";
import MdCampaign from "@material-design-icons/svg/outlined/campaign.svg?component-solid";
import MdContentCopy from "@material-design-icons/svg/outlined/content_copy.svg?component-solid";
import MdDelete from "@material-design-icons/svg/outlined/delete.svg?component-solid";
import MdDeleteSweep from "@material-design-icons/svg/outlined/delete_sweep.svg?component-solid";
import MdDownload from "@material-design-icons/svg/outlined/download.svg?component-solid";
import MdEdit from "@material-design-icons/svg/outlined/edit.svg?component-solid";
import MdEmojiEmotions from "@material-design-icons/svg/outlined/emoji_emotions.svg?component-solid";
import MdForum from "@material-design-icons/svg/outlined/forum.svg?component-solid";
import MdForward from "@material-design-icons/svg/outlined/forward.svg?component-solid";
import MdLink from "@material-design-icons/svg/outlined/link.svg?component-solid";
import MdHowToVote from "@material-design-icons/svg/outlined/how_to_vote.svg?component-solid";
import MdImage from "@material-design-icons/svg/outlined/image.svg?component-solid";
import MdMarkChatUnread from "@material-design-icons/svg/outlined/mark_chat_unread.svg?component-solid";
import MdOpenInNew from "@material-design-icons/svg/outlined/open_in_new.svg?component-solid";
import MdPin from "@material-design-icons/svg/outlined/pin_invoke.svg?component-solid";
import MdReply from "@material-design-icons/svg/outlined/reply.svg?component-solid";
import MdReport from "@material-design-icons/svg/outlined/report.svg?component-solid";
import MdShare from "@material-design-icons/svg/outlined/share.svg?component-solid";

import MdSentimentContent from "@material-symbols/svg-400/outlined/sentiment_content.svg?component-solid";

import {
  ContextMenu,
  ContextMenuButton,
  ContextMenuDivider,
  ContextMenuSubMenu,
} from "./ContextMenu";

/**
 * One-click reactions shown across the top of the menu. These are the exact
 * strings the emoji picker sends (see emojiMapping.json): the heart is a bare
 * U+2764 with no U+FE0F, so a quick heart lands on the same reaction as a
 * picked one instead of starting a second, visually identical one.
 */
const QUICK_REACTIONS = [
  "\u{1F44D}", // thumbs-up
  "\u{1F44E}", // thumbs-down
  "❤", // red-heart
  "\u{1F642}", // slightly-happy
  "\u{1F641}", // frown
];

const QuickReactionRow = styled("div", {
  base: {
    display: "flex",
    justifyContent: "space-between",
    gap: "var(--gap-sm)",
    padding: "var(--gap-xs) var(--gap-md)",
  },
});

const QuickReactionButton = styled("button", {
  base: {
    display: "grid",
    placeItems: "center",
    width: "36px",
    height: "36px",
    padding: 0,
    border: "none",
    borderRadius: "var(--borderRadius-full)",
    background: "transparent",
    cursor: "pointer",
    "--emoji-size": "22px",

    "&:hover": {
      background:
        "color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)",
    },
  },
  variants: {
    active: {
      true: {
        background: "var(--md-sys-color-primary-container)",
        "&:hover": {
          background: "var(--md-sys-color-primary-container)",
        },
      },
    },
  },
});

/**
 * Context menu for messages
 */
export function MessageContextMenu(props: {
  message?: Message;
  reactPicker?: Accessor<MediaPickerProps | undefined>;
  file?: File;
  /**
   * A decrypted E2EE attachment. It has no `File` and no shareable URL —
   * it renders from the shell's `e2ee-att` protocol — so it gets Copy
   * image and Save only. "Open file" and "Copy file link" are deliberately
   * absent: that URL is meaningless outside this app and putting it on the
   * clipboard would leak the message id for nothing.
   */
  encryptedFile?: {
    isImage: boolean;
    copyImage: () => void;
    save: () => void;
  };
  link?: string;
}) {
  const user = useUser();
  const state = useState();
  const client = useClient();
  const e2ee = useE2EE();
  const { t } = useLingui();
  const { openModal, showError } = useModals();

  /**
   * Whether this is a locally-decrypted E2EE message. It never existed on
   * the server, so every action that references its id there (edit,
   * delete, reactions, pins, threads, acks) is a dead end, and an edit or
   * reaction would carry plaintext out of the conversation.
   */
  const isEncrypted = () => !!e2ee?.isEncryptedMessage(props.message!.id);

  /**
   * Whether the message can be forwarded: needs server-side substance
   * (content or attachments), and never system messages, polls (state
   * wouldn't travel), ephemerals, or locally-decrypted E2EE messages
   * (their server-side form is useless ciphertext — nothing to forward).
   */
  const canForward = () =>
    !props.message!.isEphemeral &&
    !props.message!.systemMessage &&
    !props.message!.isPoll &&
    !e2ee?.isEncryptedMessage(props.message!.id) &&
    (!!props.message!.content ||
      !!props.message!.attachments?.length ||
      props.message!.isForwarded);

  /**
   * Whether this message can be published (crossposted): it lives in an
   * announcement channel, hasn't already been published, isn't itself a
   * delivered crosspost copy, isn't a system/ephemeral/E2EE message, and the
   * user may publish it (SendMessage for their own, ManageMessages for
   * others').
   */
  const canPublish = () => {
    const message = props.message!;
    const channel = message.channel;
    if (
      !channel?.isAnnouncement ||
      message.isCrossposted ||
      message.isCrosspost ||
      message.systemMessage ||
      message.isEphemeral ||
      e2ee?.isEncryptedMessage(message.id)
    ) {
      return false;
    }
    const isAuthor = message.authorId === user()?.id;
    return channel.havePermission(
      isAuthor ? "SendMessage" : "ManageMessages",
    );
  };

  /**
   * Publish (crosspost) this message into every follower channel. The
   * "Published" state flips via the resulting MessageUpdate.
   */
  async function publish() {
    try {
      await props.message!.publish();
    } catch (error) {
      showError(error);
    }
  }

  /**
   * Whether this message takes reactions at all: ephemerals and E2EE
   * messages have no server-side existence to react to.
   */
  const canReact = () =>
    !props.message!.isEphemeral &&
    !isEncrypted() &&
    !!props.message!.channel?.havePermission("React");

  /**
   * Quick reactions this message will accept. A message that restricts
   * reactions to its own list refuses anything else server-side, so those
   * are left out rather than offered and rejected.
   */
  const quickReactions = () => {
    const interactions = props.message!.interactions;
    return interactions?.restrict_reactions
      ? QUICK_REACTIONS.filter((emoji) =>
          interactions.reactions?.includes(emoji),
        )
      : QUICK_REACTIONS;
  };

  /**
   * Whether the current user has already reacted with this emoji
   */
  const hasReacted = (emoji: string) =>
    !!props.message!.reactions.get(emoji)?.has(user()!.id);

  /**
   * Toggle a quick reaction, same as clicking it in the reaction bar
   */
  function toggleQuickReaction(emoji: string) {
    (hasReacted(emoji)
      ? props.message!.unreact(emoji)
      : props.message!.react(emoji)
    ).catch(showError);
  }

  /**
   * Reply to this message
   */
  function reply() {
    state.draft.addReply(props.message!, user()!.id);
  }

  /**
   * Mark message as unread
   */
  function markAsUnread() {
    props.message!.ack(true, false, true);
  }

  /**
   * Copy message contents to clipboard
   */
  function copyText() {
    navigator.clipboard.writeText(props.message!.content);
  }

  /**
   * Report the message
   */
  function report() {
    openModal({
      type: "report_content",
      target: props.message!,
      client: client(),
    });
  }

  /**
   * Delete the message
   */
  function deleteMessage(ev: MouseEvent) {
    if (ev.shiftKey) {
      props.message!.delete();
    } else {
      openModal({
        type: "delete_message",
        message: props.message!,
      });
    }
  }

  /**
   * Copy message link to clipboard
   */
  function copyMessageLink() {
    navigator.clipboard.writeText(
      `${location.origin}${
        props.message!.server ? `/server/${props.message!.server?.id}` : ""
      }/channel/${props.message!.channelId}/${props.message!.id}`,
    );
  }

  /**
   * Copy message id to clipboard
   */
  function copyId() {
    navigator.clipboard.writeText(props.message!.id);
  }

  /**
   * Opens the file preview in a new tab
   */
  function openFile() {
    window.open(props.file?.originalUrl, "_blank");
  }

  /**
   * Copies the link to the original url of the file
   */
  function copyFileLink() {
    navigator.clipboard.writeText(props.file?.originalUrl ?? "");
  }

  /**
   * Whether the attached file is an image this engine can put on the
   * clipboard — the pixels themselves, as opposed to its link.
   */
  const canCopyImage = () =>
    props.file?.metadata.type === "Image" && canCopyImageToClipboard();

  /**
   * Copies the image itself to the clipboard
   */
  function copyImage() {
    copyImageToClipboard(props.file!.originalUrl).catch((error) => {
      console.error("[clipboard] copy image failed", error);
      showError(new Error(t`Could not copy this image to the clipboard.`));
    });
  }

  function copyLink() {
    navigator.clipboard.writeText(props.link ?? "");
  }

  return (
    <ContextMenu>
      <Show when={props.message && canReact() && quickReactions().length}>
        <QuickReactionRow>
          <For each={quickReactions()}>
            {(emoji) => (
              <QuickReactionButton
                type="button"
                aria-label={emoji}
                aria-pressed={hasReacted(emoji)}
                active={hasReacted(emoji)}
                onClick={() => toggleQuickReaction(emoji)}
              >
                <UnicodeEmoji emoji={emoji} />
              </QuickReactionButton>
            )}
          </For>
        </QuickReactionRow>

        <ContextMenuDivider />
      </Show>
      <Show when={props.file}>
        <ContextMenuButton icon={MdOpenInNew} onClick={openFile}>
          <Trans>Open file</Trans>
        </ContextMenuButton>
        <Show when={canCopyImage()}>
          <ContextMenuButton icon={MdImage} onClick={copyImage}>
            <Trans>Copy image</Trans>
          </ContextMenuButton>
        </Show>
        <ContextMenuButton icon={MdLink} onClick={copyFileLink}>
          <Trans>Copy file link</Trans>
        </ContextMenuButton>
        <a
          target="_blank"
          download={props.file?.filename}
          href={props.file?.originalUrl}
        >
          <ContextMenuButton icon={MdDownload}>
            <Trans>Save file</Trans>
          </ContextMenuButton>
        </a>

        <ContextMenuDivider />
      </Show>
      <Show when={props.encryptedFile}>
        <Show when={props.encryptedFile!.isImage}>
          <ContextMenuButton
            icon={MdImage}
            onClick={() => props.encryptedFile!.copyImage()}
          >
            <Trans>Copy image</Trans>
          </ContextMenuButton>
        </Show>
        <ContextMenuButton
          icon={MdDownload}
          onClick={() => props.encryptedFile!.save()}
        >
          <Trans>Save file</Trans>
        </ContextMenuButton>

        <ContextMenuDivider />
      </Show>
      <Show when={props.link}>
        <ContextMenuButton icon={MdLink} onClick={copyLink}>
          <Trans>Copy link</Trans>
        </ContextMenuButton>

        <ContextMenuDivider />
      </Show>
      <Show when={props.message}>
        {/* Ephemeral messages have no server-side existence: every action
            that references their id on the server (reply anchors, threads,
            acks, reactions, pins, deletion, reports) is a guaranteed dead
            end, so those items are hidden. Dismiss lives on the message
            banner itself. */}
        <Show
          when={
            !props.message!.isEphemeral &&
            props.message!.channel?.havePermission("SendMessage")
          }
        >
          <ContextMenuButton icon={MdReply} onClick={reply}>
            <Trans>Reply</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={canForward()}>
          <ContextMenuButton
            icon={MdForward}
            onClick={() =>
              openModal({
                type: "forward_message",
                message: props.message!,
              })
            }
          >
            <Trans>Forward</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={canPublish()}>
          <ContextMenuButton icon={MdCampaign} onClick={publish}>
            <Trans>Publish</Trans>
          </ContextMenuButton>
        </Show>
        <Show
          when={
            !props.message!.isEphemeral &&
            !isEncrypted() &&
            props.message!.channel?.type === "TextChannel" &&
            props.message!.channel?.havePermission("SendMessage") &&
            !props.message!.thread
          }
        >
          <ContextMenuButton
            icon={MdForum}
            onClick={() =>
              openModal({
                type: "create_thread",
                channel: props.message!.channel!,
                message: props.message!,
              })
            }
          >
            <Trans>Create thread</Trans>
          </ContextMenuButton>
        </Show>
        <Show when={!props.message!.isEphemeral && !isEncrypted()}>
          <ContextMenuButton icon={MdMarkChatUnread} onClick={markAsUnread}>
            <Trans>Mark as unread</Trans>
          </ContextMenuButton>
        </Show>
        <ContextMenuButton icon={MdContentCopy} onClick={copyText}>
          <Trans>Copy text</Trans>
        </ContextMenuButton>

        <ContextMenuDivider />

        <Show
          when={
            !props.message!.isEphemeral &&
            !isEncrypted() &&
            props.reactPicker &&
            props.message?.channel?.havePermission("React")
          }
        >
          <ContextMenuButton
            icon={MdEmojiEmotions}
            onClick={(e) => props.reactPicker!()?.onClickEmoji(e)}
          >
            <Trans>React</Trans>
          </ContextMenuButton>
        </Show>

        <Show
          when={
            props.message!.author?.self &&
            !isEncrypted() &&
            props.message!.channel?.havePermission("SendMessage")
          }
        >
          <ContextMenuButton
            icon={MdEdit}
            onClick={() => state.draft.setEditingMessage(props.message!)}
          >
            <Trans>Edit message</Trans>
          </ContextMenuButton>
        </Show>
        <Show
          when={
            !props.message!.isEphemeral &&
            !isEncrypted() &&
            (props.message!.channel?.type === "DirectMessage" ||
              props.message!.channel?.havePermission("ManageMessages"))
          }
        >
          <ContextMenuButton
            icon={MdPin}
            onClick={() => {
              if (props.message!.pinned) {
                props.message!.unpin().catch(showError);
              } else {
                props.message!.pin().catch(showError);
              }
            }}
          >
            <Switch fallback={<Trans>Pin message</Trans>}>
              <Match when={props.message!.pinned}>
                <Trans>Unpin message</Trans>
              </Match>
            </Switch>
          </ContextMenuButton>
        </Show>
        <Show
          when={
            props.message!.isPoll &&
            !props.message!.pollState?.closed &&
            (props.message!.author?.self ||
              props.message!.channel?.havePermission("ManageMessages"))
          }
        >
          <ContextMenuButton
            icon={MdHowToVote}
            onClick={() => props.message!.endPoll().catch(showError)}
          >
            <Trans>End poll now</Trans>
          </ContextMenuButton>
        </Show>
        <Show
          when={
            props.message!.reactions.size &&
            !isEncrypted() &&
            props.message!.channel?.havePermission("ManageMessages")
          }
        >
          <ContextMenuSubMenu
            icon={MdDeleteSweep}
            onClick={() => props.message!.clearReactions()}
            destructive
            buttonContent={<Trans>Remove reaction</Trans>}
          >
            <For each={[...props.message!.reactions.keys()]}>
              {(key) => (
                <ContextMenuButton
                  onClick={() => props.message!.unreact(key, true)}
                >
                  <Switch fallback={<UnicodeEmoji emoji={key} />}>
                    <Match when={key.length === 26}>
                      <CustomEmoji id={key} />
                    </Match>
                  </Switch>
                </ContextMenuButton>
              )}
            </For>
          </ContextMenuSubMenu>
        </Show>
        <Show
          when={
            props.message!.reactions.size &&
            !isEncrypted() &&
            props.message!.channel?.havePermission("ManageMessages")
          }
        >
          <ContextMenuButton
            symbol={MdSentimentContent}
            onClick={() => props.message!.clearReactions()}
            destructive
          >
            <Trans>Remove all reactions</Trans>
          </ContextMenuButton>
        </Show>
        <Show
          when={
            !props.message!.isEphemeral &&
            !isEncrypted() &&
            (props.message!.author?.self ||
              props.message!.channel?.havePermission("ManageMessages"))
          }
        >
          <ContextMenuButton
            icon={MdDelete}
            onClick={deleteMessage}
            destructive
          >
            <Trans>Delete message</Trans>
          </ContextMenuButton>
        </Show>
        <Show
          when={
            !props.message!.isEphemeral &&
            !props.message!.author?.self &&
            !props.message!.systemMessage
          }
        >
          <ContextMenuButton icon={MdReport} onClick={report} destructive>
            <Trans>Report message</Trans>
          </ContextMenuButton>
        </Show>
        <ContextMenuDivider />
        <ContextMenuButton icon={MdShare} onClick={copyMessageLink}>
          <Trans>Copy message link</Trans>
        </ContextMenuButton>
        <Show when={state.settings.getValue("advanced:copy_id")}>
          <ContextMenuButton icon={MdBadge} onClick={copyId}>
            <Trans>Copy message ID</Trans>
          </ContextMenuButton>
        </Show>
      </Show>
    </ContextMenu>
  );
}

import { Match, Switch, createEffect } from "solid-js";

import { useMutation } from "@tanstack/solid-query";
import { Message } from "stoat.js";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClient, useE2EE } from "@revolt/client";
import { KeybindAction, createKeybind } from "@revolt/keybinds";
import { unicodeEmojiPackPrefix } from "@revolt/markdown/emoji/UnicodeEmoji";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import { Text } from "@revolt/ui";
import { TextEditor2 } from "@revolt/ui/components/features/texteditor/TextEditor2";
import { expandTrailingEmoticon } from "@revolt/ui/components/features/texteditor/emoticonExpansion";
import { useSearchSpace } from "@revolt/ui/components/utils/autoComplete";

import { serverActionsBlocked } from "./e2eeTranscriptTrust";

export function EditMessage(props: { message: Message }) {
  const state = useState();
  const client = useClient();
  const e2ee = useE2EE();
  const { openModal, isOpen, pop } = useModals();

  /**
   * Whether an edit would send new content to the server where it must not:
   * a local E2EE row, or a conversation that is (or may be) encrypted now
   */
  const blocked = () =>
    !!e2ee?.isEncryptedMessage(props.message.id) ||
    serverActionsBlocked(e2ee, props.message.channel, client().user?.id);

  // Close the editor as soon as the conversation turns encrypted. Only
  // writes the draft, never reads the editing id, so it cannot loop.
  createEffect(() => {
    if (blocked()) state.draft.setEditingMessage(undefined);
  });

  /**
   * Close the editor and explain why, if the edit may no longer be sent
   * @returns Whether the edit is blocked
   */
  function closeIfBlocked() {
    if (!blocked()) return false;
    state.draft.setEditingMessage(undefined);
    openModal({ type: "error2", error: { type: "CannotEditMessage" } });
    return true;
  }

  const initialValue = [state.draft.editingMessageContent || ""] as const;

  const change = useMutation(() => ({
    mutationFn: (content: string) => props.message.edit({ content }),
    onSuccess() {
      state.draft.setEditingMessage(undefined);
    },
    onError(error) {
      openModal({ type: "error2", error });
    },
  }));

  function saveMessage() {
    const content = state.draft.editingMessageContent;

    if (content?.length) {
      state.draft._setNodeReplacement?.(["_focus"]); // focus message box
      if (content === props.message.content) {
        return;
      }

      // Same as sending: an emoticon typed at the very end never got the space
      // that expands one in the editor. Covers enter and the save link alike.
      // Expanded after the unchanged-message check, so opening an old message
      // that ends in ":D" and saving it untouched still saves nothing.
      if (closeIfBlocked()) return;
      change.mutate(
        state.settings.getValue("appearance:expand_emoticons")
          ? expandTrailingEmoticon(
              content,
              unicodeEmojiPackPrefix(
                state.settings.getValue("appearance:unicode_emoji") as string,
              ),
            )
          : content,
      );
    } else if (isOpen("delete_message")) {
      // Edit-to-empty deletes; when blocked, close instead (Delete stays
      // in the message menu).
      if (closeIfBlocked()) return;
      void props.message.delete();
      pop();
    } else {
      openModal({
        type: "delete_message",
        message: props.message,
      });
    }
  }

  createKeybind(KeybindAction.CHAT_CANCEL_EDITING, () => {
    state.draft.setEditingMessage(undefined);
    state.draft._setNodeReplacement?.(["_focus"]); // focus message box
  });

  const searchSpace = useSearchSpace(() => props.message, client);

  return (
    <>
      <EditorBox class={css({ flexGrow: 1 })}>
        <TextEditor2
          autoFocus
          onComplete={saveMessage}
          onChange={state.draft.setEditingMessageContent}
          initialValue={initialValue}
          autoCompleteSearchSpace={searchSpace}
        />
      </EditorBox>

      <Switch
        fallback={
          <Text size="small">
            escape to{" "}
            <Action onClick={() => state.draft.setEditingMessage(undefined)}>
              cancel
            </Action>{" "}
            &middot; enter to <Action onClick={saveMessage}>save</Action>
          </Text>
        }
      >
        <Match when={change.isPending}>
          <Text size="small">Saving message...</Text>
        </Match>
      </Switch>
    </>
  );
}

const EditorBox = styled("div", {
  base: {
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface-container)",
    borderRadius: "var(--borderRadius-sm)",
    padding: "var(--gap-md)",
  },
});

const Action = styled("span", {
  base: {
    fontWeight: 600,
    cursor: "pointer",
    color: "var(--md-sys-color-primary)",
  },
});

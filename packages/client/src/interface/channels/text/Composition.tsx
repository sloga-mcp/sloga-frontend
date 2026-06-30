import { createCountdownFromNow } from "@solid-primitives/date";
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { Channel } from "stoat.js";

import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { CONFIGURATION, debounce } from "@revolt/common";
import { Keybind, KeybindAction, createKeybind } from "@revolt/keybinds";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  CompositionMediaPicker,
  FileCarousel,
  FileDropAnywhereCollector,
  FilePasteCollector,
  IconButton,
  MessageBox,
  MessageReplyPreview,
  Tooltip,
  humanFileSize,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";
import { useSearchSpace } from "@revolt/ui/components/utils/autoComplete";
import { UserSlowmodes } from "stoat.js/lib/events/v1";

interface Props {
  /**
   * Channel to compose for
   */
  channel: Channel;

  /**
   * Notify parent component when a message is sent
   */
  onMessageSend?: () => void;
}

/**
 * Message composition engine
 */
export function MessageComposition(props: Props) {
  const state = useState();
  const { t } = useLingui();
  const client = useClient();
  const { openModal } = useModals();

  const currentSlowmode = (): UserSlowmodes | undefined => {
    return client().userSlowmodes.get(props.channel.id);
  };
  const countdownForEntry = createMemo(() => {
    const entry = currentSlowmode();
    if (!entry) return;
    const receivedAt = entry.receivedAt ?? Date.now();
    // Add 100 ms here so the countdown has a bit to render
    const targetTs = receivedAt + 100 + entry.retry_after * 1000;
    return createCountdownFromNow(targetTs);
  });

  const isSlowmodeExempt = (): boolean => {
    return props.channel.havePermission("BypassSlowmode");
  };

  const cooldownRemaining = createMemo(() => {
    if (!props.channel.slowmode || isSlowmodeExempt()) return 0;

    const cd = countdownForEntry();
    if (!cd) return 0;

    const [store] = cd;

    const h = store.hours ?? 0;
    const m = store.minutes ?? 0;
    const s = store.seconds ?? 0;

    const totalSeconds = h * 3600 + m * 60 + s;
    return totalSeconds > 0 ? totalSeconds : 0;
  });

  const slowmodeText = createMemo(() => {
    const s = cooldownRemaining();
    if (!s) return "";

    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
    }
    return `${m}:${sec.toString().padStart(2, "0")}`;
  });

  const slowmodeWaitTime = createMemo(() => {
    const s = props.channel.slowmode;
    if (!s) return "";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    if (h > 0 && m === 0 && sec === 0)
      return h === 1 ? t`1 hour` : t`${h} hours`;
    if (m > 0 && sec === 0 && h === 0)
      return m === 1 ? t`1 minute` : t`${m} minutes`;

    const parts = [];
    if (h > 0) parts.push(h === 1 ? t`1 hour` : t`${h} hours`);
    if (m > 0) parts.push(m === 1 ? t`1 minute` : t`${m} minutes`);
    if (sec > 0) parts.push(sec === 1 ? t`1 second` : t`${sec} seconds`);
    return parts.join(" ");
  });

  createKeybind(KeybindAction.CHAT_JUMP_END, () =>
    setNodeReplacement(["_focus"]),
  );

  createKeybind(KeybindAction.CHAT_FOCUS_COMPOSITION, () =>
    setNodeReplacement(["_focus"]),
  );

  /**
   * Get the draft for the current channel
   * @returns Draft
   */
  function draft() {
    return state.draft.getDraft(props.channel.id);
  }

  const messageLength = () => draft().content?.length ?? 0;

  const maxMessageLength = () => {
    const cl = client();
    return cl.configured()
      ? (cl.configuration?.features.limits.default.message_length ?? 2000)
      : 2000;
  };

  const isAlmostTooLong = () => messageLength() > maxMessageLength() - 200;

  const wayTooLong = () => messageLength() > maxMessageLength() + 9999;

  // Whether the send button should be active/clickable
  const canSend = createMemo(() => {
    const draftContent = draft()?.content ?? "";
    const draftFiles = draft()?.files ?? [];

    const tooLong = messageLength() > maxMessageLength();

    const isSlowmode = currentSlowmode();

    return (
      !tooLong &&
      (draftContent.trim().length > 0 || draftFiles.length > 0) &&
      !isSlowmode
    );
  });

  // TEMP
  function currentValue() {
    return draft()?.content ?? "";
  }

  const [initialValue, setInitialValue] = createSignal([
    currentValue(),
  ] as const);

  const [nodeReplacement, setNodeReplacement] =
    createSignal<readonly [string | "_focus"]>();

  // bind this composition instance to the global node replacement signal
  state.draft._setNodeReplacement = setNodeReplacement;
  onCleanup(() => (state.draft._setNodeReplacement = undefined));

  createEffect(
    on(
      () => props.channel,
      () => setInitialValue([currentValue()]),
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => currentValue(),
      (value) => {
        if (value === "") {
          setInitialValue([""]);
        }
      },
      { defer: true },
    ),
  );
  // END TEMP

  /**
   * Keep track of last time we sent a typing packet
   */
  let isTyping: number | undefined = undefined;

  /**
   * Send typing packet
   */
  function startTyping() {
    if (typeof isTyping === "number" && +new Date() < isTyping) return;

    const ws = client()!.events;
    if (ws.state() === 2) {
      isTyping = +new Date() + 2500;
      ws.send({
        type: "BeginTyping",
        channel: props.channel.id,
      });
    }
  }

  /**
   * Send stop typing packet
   */
  function stopTyping() {
    if (isTyping) {
      const ws = client()!.events;
      if (ws.state() === 2) {
        isTyping = undefined;
        ws.send({
          type: "EndTyping",
          channel: props.channel.id,
        });
      }
    }
  }

  /**
   * Stop typing after some time
   */
  const delayedStopTyping = debounce(stopTyping, 1000); // eslint-disable-line solid/reactivity

  /**
   * Send a message using the current draft
   * @param useContent Content to send
   */
  async function sendMessage(useContent?: unknown) {
    if (!canSend() && typeof useContent !== "string") {
      return;
    } else if (currentSlowmode()) {
      return;
    }
    stopTyping();
    props.onMessageSend?.();

    // Schedule disappearing message deletion
    const timer = disappearOption().seconds;
    if (timer !== null) {
      const channelId = props.channel.id;
      const userId = client()!.user!.id;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onMsg = (message: any) => {
        if (message.channelId === channelId && message.authorId === userId) {
          client().removeListener("messageCreate", onMsg);
          setTimeout(() => { try { message.delete(); } catch {} }, timer * 1000);
        }
      };
      client().on("messageCreate", onMsg);
      setTimeout(() => client().removeListener("messageCreate", onMsg), 15000);
    }

    if (typeof useContent === "string") {
      const currentDraft = draft();
      if (
        currentDraft?.replies?.length &&
        !currentDraft.content &&
        !currentDraft.files?.length
      ) {
        state.draft.setDraft(props.channel.id, {
          ...currentDraft,
          content: useContent,
        });
        return state.draft.sendDraft(client(), props.channel);
      }
      return props.channel.sendMessage(useContent);
    }

    state.draft.sendDraft(client(), props.channel);
  }

  /**
   * Shorthand for updating the draft
   */
  function setContent(content: string) {
    state.draft.setDraft(props.channel.id, { content });
    startTyping();
  }

  /**
   * Handle files being added to the draft.
   * @param files List of files
   */
  function onFiles(files: File[]) {
    const rejectedFiles: File[] = [];
    const validFiles: File[] = [];

    const maxSize = client().configured()
      ? (client().configuration?.features.limits.default.file_upload_size_limits
          .attachments ?? CONFIGURATION.MAX_FILE_SIZE)
      : CONFIGURATION.MAX_FILE_SIZE;

    for (const file of files) {
      if (file.size > maxSize) {
        console.log("File too large:", file);
        rejectedFiles.push(file);
      } else {
        validFiles.push(file);
      }
    }

    if (rejectedFiles.length > 0) {
      const maxSizeFormatted = humanFileSize(maxSize);

      if (rejectedFiles.length === 1) {
        const file = rejectedFiles[0];
        const fileSize = humanFileSize(file.size);
        const error = new Error(
          t`The file "${file.name}" (${fileSize}) exceeds the maximum size limit of ${maxSizeFormatted}.`,
        );
        error.name = "File too large";
        openModal({
          type: "error2",
          error,
        });
      } else {
        const error = new Error(
          t`${rejectedFiles.length} files exceed the maximum size limit of ${maxSizeFormatted} and were not uploaded.`,
        );
        error.name = "Files too large";
        openModal({
          type: "error2",
          error,
        });
      }
    }

    for (const file of validFiles) {
      state.draft.addFile(props.channel.id, file);
    }
  }

  /**
   * Add a file to the message
   */
  function addFile() {
    const input = document.createElement("input");
    input.accept = "*";
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";

    input.addEventListener("change", async (e) => {
      // Get all attached files
      const files = (e.currentTarget as HTMLInputElement)?.files;

      // Remove element from DOM
      input.remove();

      // Skip execution if no files specified
      if (!files) return;
      onFiles([...files]);
    });

    // iOS requires us to append the file input
    // to DOM to allow us to add any images
    document.body.appendChild(input);
    input.click();
  }

  /**
   * Remove a file by its ID
   * @param fileId File ID
   */
  function removeFile(fileId: string) {
    state.draft.removeFile(props.channel.id, fileId);
  }

  const searchSpace = useSearchSpace(() => props.channel, client);

  // Disappearing messages
  const DISAPPEAR_OPTIONS: { label: string; seconds: number | null }[] = [
    { label: "Off", seconds: null },
    { label: "5s", seconds: 5 },
    { label: "30s", seconds: 30 },
    { label: "1m", seconds: 60 },
    { label: "5m", seconds: 300 },
    { label: "1h", seconds: 3600 },
  ];
  const [disappearIdx, setDisappearIdx] = createSignal(0);
  const disappearOption = () => DISAPPEAR_OPTIONS[disappearIdx()];
  const [showDisappearMenu, setShowDisappearMenu] = createSignal(false);

  function toggleDisappearMenu() {
    setShowDisappearMenu((v) => !v);
  }

  function selectDisappear(idx: number) {
    setDisappearIdx(idx);
    setShowDisappearMenu(false);
  }

  function disappearTooltipText() {
    return disappearOption().seconds === null
      ? t`Disappearing messages: Off`
      : t`Messages disappear after ${disappearOption().label}`;
  }

  return (
    <>
      <Show when={props.channel.slowmode}>
        <SlowmodeContainer>
          <Tooltip
            content={t`Members can send one message every ${slowmodeWaitTime()}.`}
            placement="top"
          >
            <SlowmodeRow>
              <Symbol style={{ "font-size": "1rem" }}>schedule</Symbol>
              <SlowmodeText>
                <Switch fallback={t`Slowmode is enabled.`}>
                  <Match when={isSlowmodeExempt()}>{t`Slowmode Immune`}</Match>
                  <Match when={cooldownRemaining() > 0}>{slowmodeText()}</Match>
                </Switch>
              </SlowmodeText>
            </SlowmodeRow>
          </Tooltip>
        </SlowmodeContainer>
      </Show>
      <Show when={state.draft.hasAdditionalElements(props.channel.id)}>
        <Keybind
          keybind={KeybindAction.CHAT_REMOVE_COMPOSITION_ELEMENT}
          onPressed={() => state.draft.popFromDraft(props.channel.id)}
        />
      </Show>
      <FileCarousel
        files={draft().files ?? []}
        getFile={state.draft.getFile}
        addFile={addFile}
        removeFile={removeFile}
      />
      <For each={draft().replies ?? []}>
        {(reply) => {
          const message = client()!.messages.get(reply.id);

          /**
           * Toggle mention on reply
           */
          function toggle() {
            state.draft.toggleReplyMention(props.channel.id, reply.id);
          }

          /**
           * Dismiss a reply
           */
          function dismiss() {
            state.draft.removeReply(props.channel.id, reply.id);
          }

          return (
            <MessageReplyPreview
              message={message}
              mention={reply.mention}
              toggle={toggle}
              dismiss={dismiss}
              self={message?.authorId === client()!.user!.id}
            />
          );
        }}
      </For>
      <MessageBox
        initialValue={initialValue()}
        nodeReplacement={nodeReplacement()}
        onSendMessage={() => sendMessage()}
        onTyping={delayedStopTyping}
        onEditLastMessage={() => state.draft.setEditingMessage(true)}
        content={draft()?.content ?? ""}
        setContent={setContent}
        actionsStart={
          <Show
            when={props.channel.havePermission("UploadFiles")}
            fallback={<MessageBox.InlineIcon size="short" />}
          >
            <MessageBox.InlineIcon>
              <IconButton onPress={addFile}>
                <Symbol>add</Symbol>
              </IconButton>
            </MessageBox.InlineIcon>
          </Show>
        }
        actionsEnd={
          <MessageBox.ActionContainer column>
            <Show when={isAlmostTooLong()}>
              <MessageBox.FloatingAction
                size="normal"
                error={messageLength() > maxMessageLength()}
              >
                {wayTooLong()
                  ? "Too Long"
                  : maxMessageLength() - messageLength()}
              </MessageBox.FloatingAction>
            </Show>
            <MessageBox.ActionContainer>
              <MessageBox.InlineIcon>
                <div style={{ position: "relative" }}>
                  <Tooltip
                    content={disappearTooltipText()}
                    placement="top"
                  >
                    <div style={{ display: "flex", "flex-direction": "column", "align-items": "center" }}>
                      <IconButton
                        onPress={toggleDisappearMenu}
                        style={disappearOption().seconds !== null ? { color: "#FF6B00" } : {}}
                      >
                        <Symbol>
                          {disappearOption().seconds === null ? "timer_off" : "timer"}
                        </Symbol>
                      </IconButton>
                      <Show when={disappearOption().seconds !== null}>
                        <span style={{ "font-size": "0.6em", "line-height": "1", "margin-top": "-4px", color: "#FF6B00", "font-weight": "600", "pointer-events": "none" }}>
                          {disappearOption().label}
                        </span>
                      </Show>
                    </div>
                  </Tooltip>
                  <Show when={showDisappearMenu()}>
                    <div
                      style={{
                        position: "fixed",
                        inset: "0",
                        "z-index": "999",
                      }}
                      onClick={() => setShowDisappearMenu(false)}
                    />
                    <div
                      style={{
                        position: "absolute",
                        bottom: "calc(100% + 8px)",
                        right: "0",
                        "z-index": "1000",
                        background: "var(--md-sys-color-surface-container-high)",
                        "border-radius": "12px",
                        padding: "8px 0",
                        "min-width": "160px",
                        "box-shadow": "0 4px 20px rgba(0,0,0,0.4)",
                        border: "1px solid var(--md-sys-color-outline-variant)",
                      }}
                    >
                      <div style={{ padding: "4px 12px 8px", "font-size": "0.75em", opacity: "0.6", "font-weight": "600", "letter-spacing": "0.05em", "text-transform": "uppercase" }}>
                        Disappear after
                      </div>
                      <For each={DISAPPEAR_OPTIONS}>
                        {(opt, i) => (
                          <div
                            onClick={() => selectDisappear(i())}
                            style={{
                              display: "flex",
                              "align-items": "center",
                              gap: "10px",
                              padding: "8px 16px",
                              cursor: "pointer",
                              background: disappearIdx() === i() ? "var(--md-sys-color-primary-container)" : "transparent",
                              color: disappearIdx() === i() ? "var(--md-sys-color-on-primary-container)" : "inherit",
                              "font-size": "0.9em",
                            }}
                          >
                            <div style={{
                              width: "16px",
                              height: "16px",
                              "border-radius": "50%",
                              border: `2px solid ${disappearIdx() === i() ? "#FF6B00" : "var(--md-sys-color-outline)"}`,
                              background: disappearIdx() === i() ? "#FF6B00" : "transparent",
                              "flex-shrink": "0",
                            }} />
                            {opt.label}
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </MessageBox.InlineIcon>
              <CompositionMediaPicker
                onMessage={sendMessage}
                onTextReplacement={(text) => setNodeReplacement([text])}
              >
                {(triggerProps) => (
                  <>
                    <Show when={!canSend()}>
                      <MessageBox.InlineIcon>
                        <IconButton onPress={triggerProps.onClickGif}>
                          <Symbol>gif</Symbol>
                        </IconButton>
                      </MessageBox.InlineIcon>
                    </Show>
                    <MessageBox.InlineIcon>
                      <IconButton onPress={triggerProps.onClickEmoji}>
                        <Symbol>emoticon</Symbol>
                      </IconButton>
                    </MessageBox.InlineIcon>
                    <MessageBox.InlineIcon>
                      <IconButton onPress={triggerProps.onClickSticker}>
                        <Symbol>note_stack</Symbol>
                      </IconButton>
                    </MessageBox.InlineIcon>
                    <div ref={triggerProps.ref} />
                  </>
                )}
              </CompositionMediaPicker>
            </MessageBox.ActionContainer>
          </MessageBox.ActionContainer>
        }
        placeholder={
          props.channel.type === "SavedMessages"
            ? t`Save to your notes`
            : props.channel.type === "DirectMessage"
              ? t`Message ${props.channel.recipient?.username}`
              : t`Message ${props.channel.name}`
        }
        sendingAllowed={props.channel.havePermission("SendMessage")}
        autoCompleteSearchSpace={searchSpace}
        updateDraftSelection={(start, end) =>
          state.draft.setSelection(props.channel.id, start, end)
        }
        hasActionsAppend={
          state.settings.getValue("appearance:show_send_button") || false
        }
        actionsAppend={
          <Show when={state.settings.getValue("appearance:show_send_button")}>
            <IconButton
              _compositionSendMessage
              size="sm"
              variant={canSend() ? "filled" : "tonal"}
              shape="square"
              isDisabled={!canSend()}
              onPress={sendMessage}
            >
              <span
                style={{
                  display: "inline-block",
                  transform: "rotate(90deg)",
                  "font-weight": "700",
                  "font-size": "1.1em",
                  "line-height": "1",
                }}
              >
                A
              </span>
            </IconButton>
          </Show>
        }
      />
      <FilePasteCollector onFiles={onFiles} />
      <FileDropAnywhereCollector onFiles={onFiles} />
    </>
  );
}

const SlowmodeContainer = styled("div", {
  base: {
    display: "flex",
    justifyContent: "flex-end",
    padding: "0 12px 6px 0",
  },
});

const SlowmodeRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});

const SlowmodeText = styled("span", {
  base: {
    fontSize: "0.75rem",
    fontWeight: "600",
  },
});

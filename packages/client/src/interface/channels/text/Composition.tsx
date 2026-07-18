import { createCountdownFromNow } from "@solid-primitives/date";
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { Channel } from "stoat.js";
import type { ApplicationCommandData, Message } from "stoat.js";

import { styled } from "styled-system/jsx";

import { E2EESendError, useClient, useE2EE, useSound } from "@revolt/client";
import { CONFIGURATION, debounce, useDevice } from "@revolt/common";
import { Keybind, KeybindAction, createKeybind } from "@revolt/keybinds";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  CameraMessageButton,
  CompositionMediaPicker,
  FileCarousel,
  FileDropAnywhereCollector,
  FilePasteCollector,
  IconButton,
  MessageBox,
  MessageReplyPreview,
  Tooltip,
  VoiceMessageButton,
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
  const e2ee = useE2EE();
  const sound = useSound();
  const { openModal } = useModals();
  const { layout } = useDevice();

  /**
   * On phones and tablets the composer splits into two bars (see MessageBox);
   * the bottom bar always carries a send button since there's no reliable
   * enter-to-send on touch keyboards.
   */
  const isStackedLayout = () => layout() !== "desktop";
  const showSendButton = () =>
    isStackedLayout() ||
    state.settings.getValue("appearance:show_send_button");

  /**
   * E2EE send mode for this conversation (DMs only). Reflects the native
   * layer's local-truth decision — "encrypted", "blocked" (identity change
   * pending acceptance), or undefined for plaintext/non-DM/web.
   */
  const peerUserId = createMemo(() =>
    props.channel.type === "DirectMessage"
      ? props.channel.recipient?.id
      : undefined,
  );

  /**
   * The E2EE conversation id — the peer user id for DMs, the channel id for
   * encrypted group DMs (slice 5). The `sendModes` cache is keyed by this.
   */
  const conversationId = createMemo(() =>
    props.channel.type === "DirectMessage"
      ? props.channel.recipient?.id
      : props.channel.type === "Group"
        ? props.channel.id
        : undefined,
  );
  const isGroup = createMemo(() => props.channel.type === "Group");
  /** Whether E2EE is enabled + published on THIS device */
  const selfE2EEEnabled = createMemo(() => {
    const s = e2ee?.status.get("state");
    return !!s?.enabled && !!s?.published;
  });

  /** Whether the DM peer advertises E2EE opt-in (server discovery hint) */
  const peerE2EEEnabled = createMemo(
    () => !!props.channel.recipient?.e2eeEnabled,
  );

  /**
   * Composer indicator state (DMs only). "encrypt" is the ONLY state derived
   * from real local truth (pinned keys + sticky marker) — it stays green
   * whether the peer is online or offline, and never downgrades. The others
   * are honest hints about a not-yet-encrypted conversation:
   * - "encrypt"     → encryption established → green closed lock
   * - "pending"     → both sides opted in but no session yet; it starts on
   *                   the first message → neutral lock-clock (NOT green,
   *                   because a server could lie about the peer's opt-in)
   * - "unencrypted" → THIS device is on but the peer has NOT opted in →
   *                   red open lock (a genuine mismatch)
   * - "blocked"     → peer identity change pending acceptance → amber warning
   * - undefined     → neither side is using E2EE (or non-DM) → no indicator
   */
  const e2eeMode = createMemo(() => {
    const conv = conversationId();
    if (!conv) return undefined;
    const mode = e2ee?.sendModes.get(conv);
    if (mode === "encrypt" || mode === "blocked") return mode;
    // Groups have no per-peer advertise hint — an unencrypted group shows no
    // indicator (encryption is opt-in via the group's Security settings).
    if (isGroup()) return undefined;
    // A plaintext DM only warrants an indicator when THIS device is opted in
    // — otherwise the user isn't using encryption and needs no nag.
    // Distinguish "peer is set up, just not established yet" from "peer
    // hasn't turned encryption on at all".
    if (mode === "plaintext" && selfE2EEEnabled()) {
      return peerE2EEEnabled() ? "pending" : "unencrypted";
    }
    return undefined;
  });

  /** Material symbol for the current indicator state */
  const e2eeIcon = () => {
    switch (e2eeMode()) {
      case "blocked":
        return "gpp_maybe";
      case "pending":
        return "lock_clock";
      case "unencrypted":
        return "lock_open";
      default:
        return "lock";
    }
  };

  /**
   * A plaintext group this device could turn encryption on for (slice 5).
   * The only entry point to group E2EE — shown as an affordance next to the
   * composer. Groups have no per-peer advertise hint, so this appears
   * whenever this device is E2EE-capable and the group is not yet encrypted.
   */
  const groupCanEnable = createMemo(
    () =>
      isGroup() &&
      selfE2EEEnabled() &&
      e2ee?.sendModes.get(props.channel.id) === "plaintext",
  );

  // `currentSlowmode` must be declared BEFORE `pollAllowed`: the latter's
  // createMemo evaluates eagerly and reads `currentSlowmode()`, so declaring
  // it afterwards is a temporal-dead-zone ReferenceError that crashes
  // MessageComposition and blanks every channel pane.
  const currentSlowmode = (): UserSlowmodes | undefined => {
    return client().userSlowmodes.get(props.channel.id);
  };

  /**
   * Polls are server-counted plaintext by construction, so the composer
   * fails closed for encrypted (or blocked) conversations — this client-side
   * gate is the E2EE enforcement point, mirroring message_send (the server
   * cannot reliably know a conversation's encryption state).
   */
  const pollAllowed = createMemo(
    () =>
      ["TextChannel", "Thread", "Group", "DirectMessage"].includes(
        props.channel.type,
      ) &&
      props.channel.havePermission("SendMessage") &&
      e2eeMode() !== "encrypt" &&
      e2eeMode() !== "blocked" &&
      // Slowmode: creating a poll sends a message, so the affordance hides
      // during an active cooldown (server enforces regardless)
      !currentSlowmode(),
  );

  /**
   * Scheduled messages are stored on the server as plaintext until they
   * fire, so the composer fails closed for encrypted (or blocked)
   * conversations — same client-side E2EE enforcement point as polls.
   * Attachments are not supported for scheduling (v1: text and replies).
   */
  const scheduleAllowed = createMemo(
    () =>
      ["TextChannel", "Thread", "Group", "DirectMessage"].includes(
        props.channel.type,
      ) &&
      props.channel.havePermission("SendMessage") &&
      e2eeMode() !== "encrypt" &&
      e2eeMode() !== "blocked",
  );

  // Prime the send-mode cache when the conversation opens so the indicator
  // is correct before the first send
  createEffect(
    on(peerUserId, (peer) => {
      if (peer && e2ee) {
        void e2ee.primeSendMode(peer);
        // Device-lifecycle fixes §1: DM-open device reconcile (TTL-
        // guarded) — events alone strand a peer's new device when missed.
        e2ee.reconcilePeerOnOpen(peer);
      }
    }),
  );

  // Groups: prime the send-mode cache (drives the indicator + the "Encrypt
  // this group" affordance), then reconcile the displayed roster against the
  // pinned one (announces added-but-unpinned members, drops departed).
  createEffect(
    on(
      () => (isGroup() ? props.channel.id : undefined),
      (id) => {
        if (id && e2ee) {
          void e2ee.primeGroupMode(id);
          void e2ee.groupReconcile(props.channel);
        }
      },
    ),
  );

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
   * Send a dice roll via the server-authoritative roll endpoint.
   *
   * The server parses the notation, rolls with its own RNG and sends the
   * result message carrying the DiceRoll flag — results cannot be spoofed
   * by clients. Uses raw fetch: the generated typed client drops bodies
   * for routes missing from its tables.
   */
  async function sendRoll(notation: string) {
    if (props.channel.type !== "TextChannel") {
      openModal({
        type: "error2",
        error: t`Dice rolls are only available in server channels.`,
      });
      return;
    }

    try {
      const c = client();
      const [authHeader, authValue] = c.authenticationHeader;
      const response = await fetch(
        `${c.options.baseURL}/channels/${props.channel.id}/roll`,
        {
          method: "POST",
          headers: {
            [authHeader]: authValue,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ notation }),
        },
      );

      if (!response.ok) {
        let detail = "";
        try {
          const data = await response.json();
          detail = data?.error ?? data?.type ?? "";
        } catch {
          /* no body */
        }
        throw new Error(detail || t`Dice roll failed (${response.status})`);
      }

      // Success — clear the /roll command from the draft
      state.draft.setDraft(props.channel.id, { content: "" });
      sound.playSound("messageSent");
      props.onMessageSend?.();
    } catch (error) {
      openModal({
        type: "error2",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Parse the argument string of a slash invocation into option values.
   *
   * Accepts `name:value` tokens (values may be double-quoted to contain
   * spaces). As a convenience, when the command has exactly one required
   * option and the input contains no `name:` tokens, the whole remainder
   * becomes that option's value (`/say hello world`).
   */
  function parseCommandOptions(
    command: ApplicationCommandData,
    args: string,
  ): Record<string, string> {
    const options: Record<string, string> = {};
    const trimmed = args.trim();
    if (!trimmed) return options;

    const tokenRe = /([\w-]+):(?:"([^"]*)"|(\S*))/g;
    let match: RegExpExecArray | null;
    let sawToken = false;
    while ((match = tokenRe.exec(trimmed))) {
      sawToken = true;
      options[match[1]] = match[2] ?? match[3] ?? "";
    }

    if (!sawToken) {
      const required = (command.options ?? []).filter((o) => o.required);
      const target = required[0] ?? (command.options ?? [])[0];
      if (target) options[target.name] = trimmed;
    }

    return options;
  }

  // "Waiting for the bot" indicator after invoking a slash command —
  // cleared when the response message arrives (correlated by interaction
  // id via `command_context`) or after a 15s timeout.
  const [pendingInvoke, setPendingInvoke] = createSignal<{
    id: string;
    command: string;
  } | null>(null);
  let pendingInvokeTimer: number | undefined;

  function clearPendingInvoke() {
    if (pendingInvokeTimer) window.clearTimeout(pendingInvokeTimer);
    pendingInvokeTimer = undefined;
    setPendingInvoke(null);
  }

  const onInteractionResponse = (message: Message) => {
    const pending = pendingInvoke();
    if (
      pending &&
      message.channelId === props.channel.id &&
      message.commandContext?.id === pending.id
    ) {
      clearPendingInvoke();
    }
  };
  client().addListener("messageCreate", onInteractionResponse);
  onCleanup(() => {
    client().removeListener("messageCreate", onInteractionResponse);
    if (pendingInvokeTimer) window.clearTimeout(pendingInvokeTimer);
  });

  /**
   * Invoke a slash command via the interactions endpoint. The bot's reply
   * arrives as a regular message carrying the unforgeable `command_context`.
   */
  async function sendInteraction(
    command: ApplicationCommandData,
    args: string,
  ) {
    // Fail closed: never route command text into an encrypted or blocked
    // conversation as plaintext, and never invoke interactions there either.
    // Like the plaintext send path, this awaits the AUTHORITATIVE native
    // verdict (an awaited round-trip, not the cached indicator, which can
    // lag right after app launch); a native error also fails closed.
    if (
      e2ee &&
      (props.channel.type === "DirectMessage" || props.channel.type === "Group")
    ) {
      let mode: "encrypt" | "blocked" | "plaintext" | null;
      try {
        mode = await e2ee.sendModeNowFor(props.channel);
      } catch {
        openModal({
          type: "error2",
          error: t`Encryption status could not be verified. Nothing was sent.`,
        });
        return;
      }
      if (mode === "encrypt" || mode === "blocked") {
        openModal({
          type: "error2",
          error: t`Slash commands are unavailable in encrypted conversations.`,
        });
        return;
      }
    }

    try {
      const interactionId = await props.channel.createInteraction(
        command._id,
        parseCommandOptions(command, args),
      );

      // Success — clear the invocation from the draft and show the
      // waiting indicator until the bot's reply lands
      state.draft.setDraft(props.channel.id, { content: "" });
      sound.playSound("messageSent");
      props.onMessageSend?.();

      clearPendingInvoke();
      setPendingInvoke({ id: interactionId, command: command.name });
      pendingInvokeTimer = window.setTimeout(() => {
        clearPendingInvoke();
        openModal({
          type: "error2",
          error: t`The bot did not respond in time.`,
        });
      }, 15_000);
    } catch (error) {
      const type = (error as { type?: string })?.type;
      openModal({
        type: "error2",
        error:
          type === "BotOffline"
            ? t`That bot is currently offline — try again once it reconnects.`
            : type === "InSlowmode"
              ? t`You are in slowmode, wait before invoking commands.`
              : new Error(
                  type ?? (error instanceof Error ? error.message : String(error)),
                ),
      });
    }
  }

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

    // Intercept the /roll command — it becomes a server-side dice roll,
    // never a plain message
    const rawContent =
      typeof useContent === "string" ? useContent : currentValue();
    const trimmed = rawContent.trim();
    if (/^\/roll(\s|$)/i.test(trimmed)) {
      await sendRoll(trimmed.slice(5).trim() || "1d20");
      return;
    }

    // Intercept registered slash commands (/roll keeps precedence above).
    // Unknown /words fall through and send as plain text.
    const slash = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
    if (slash) {
      const command = availableCommands().find(
        (candidate) => candidate.name === slash[1].toLowerCase(),
      );
      if (command) {
        await sendInteraction(command, slash[2] ?? "");
        return;
      }
    }

    // E2EE pre-send guard: a blocked conversation (peer identity change
    // pending acceptance) routes to the identity modal instead of a raw
    // error. The mode is read from the NATIVE layer authoritatively (an
    // awaited round-trip, not the cached indicator). This is UX only —
    // the fail-closed security gate is `prepareDraftAttachments` inside
    // sendDraft (attachments now ride the encrypted path, slice 3.5).
    const peer = peerUserId();
    if (peer && e2ee) {
      let mode: "encrypt" | "blocked" | "plaintext";
      try {
        mode = await e2ee.sendModeNow(peer);
      } catch {
        // Native layer unreachable: fail closed
        openModal({
          type: "error2",
          error: t`Encryption status could not be verified. Nothing was sent.`,
        });
        return;
      }

      if (mode === "blocked") {
        // Distinguish a peer identity change (accept flow) from a peer
        // downgrade (confirm-plaintext flow, slice 5) via the group/peer
        // state — both surface as "blocked" to the composer.
        openModal({
          type: "e2ee_identity_change",
          peerUserId: peer,
        });
        return;
      }
    }

    stopTyping();
    sound.playSound("messageSent");
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

    try {
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
          return await state.draft.sendDraft(client(), props.channel);
        }
        return await props.channel.sendMessage(useContent);
      }

      await state.draft.sendDraft(client(), props.channel);
    } catch (error) {
      // An encrypt-mode send that could not be delivered is a HARD error —
      // the message was NOT sent in plaintext. Surface it and restore the
      // draft so the user does not lose their text.
      if (error instanceof E2EESendError) {
        openModal({ type: "error2", error: error.message });
        return;
      }
      throw error;
    }
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

  const baseSearchSpace = useSearchSpace(() => props.channel, client);

  /**
   * Slash commands invocable in this channel. Fetched lazily per channel;
   * EMPTY (facet hidden, fail-closed) in encrypted or blocked conversations
   * — interactions never get a plaintext fallback inside E2EE — and in
   * DMs / saved messages, which the server structurally rejects anyway.
   */
  const [availableCommands] = createResource(
    () =>
      [props.channel.id, props.channel.type, e2eeMode()] as [
        string,
        string,
        string | undefined,
      ],
    async ([, type, mode]) => {
      if (mode === "encrypt" || mode === "blocked") return [];
      if (type !== "TextChannel" && type !== "Thread" && type !== "Group")
        return [];
      try {
        return await props.channel.fetchCommands();
      } catch {
        // Older servers (404) or transient failures: no picker, no error.
        return [];
      }
    },
    { initialValue: [] },
  );

  const searchSpace = createMemo(() => ({
    ...baseSearchSpace(),
    commands: availableCommands(),
  }));

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

  // Dice roller (server text channels only)
  const DICE_OPTIONS = [4, 6, 8, 10, 12, 20, 100];
  const [showDiceMenu, setShowDiceMenu] = createSignal(false);
  const [diceQty, setDiceQty] = createSignal(1);
  const [diceMod, setDiceMod] = createSignal(0);
  const [diceAdv, setDiceAdv] = createSignal<"none" | "adv" | "dis">("none");

  /**
   * Compose dice notation from the picker state and roll it.
   * Advantage/disadvantage only applies to a single d20 (2d20kh1 / 2d20kl1).
   */
  function rollFromPicker(sides: number) {
    let notation: string;
    if (sides === 20 && diceQty() === 1 && diceAdv() !== "none") {
      notation = diceAdv() === "adv" ? "2d20kh1" : "2d20kl1";
    } else {
      notation = `${diceQty()}d${sides}`;
    }
    const mod = diceMod();
    if (mod !== 0) notation += mod > 0 ? `+${mod}` : `${mod}`;
    setShowDiceMenu(false);
    void sendRoll(notation);
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
      <Show when={pendingInvoke()}>
        <SlowmodeContainer>
          <SlowmodeRow>
            <Symbol style={{ "font-size": "1rem" }}>hourglass_top</Symbol>
            <SlowmodeText>
              {t`Waiting for /${pendingInvoke()!.command} to respond…`}
            </SlowmodeText>
          </SlowmodeRow>
        </SlowmodeContainer>
      </Show>
      <Show when={e2eeMode()}>
        <E2EEIndicator
          data-mode={e2eeMode()}
          onClick={() => {
            if (e2eeMode() === "blocked" && peerUserId()) {
              openModal({
                type: "e2ee_identity_change",
                peerUserId: peerUserId()!,
              });
            } else if (e2eeMode() === "encrypt" && peerUserId()) {
              // Green lock → the safety-number verification screen (slice 5).
              // Groups verify per member via the member list, not here.
              openModal({ type: "e2ee_verify", peerUserId: peerUserId()! });
            }
          }}
        >
          <Symbol style={{ "font-size": "1rem" }}>{e2eeIcon()}</Symbol>
          <span>
            <Switch>
              <Match when={e2eeMode() === "encrypt"}>
                {t`Messages to this conversation are end-to-end encrypted.`}
              </Match>
              <Match when={e2eeMode() === "pending"}>
                {t`Encryption will start once a message is sent.`}
              </Match>
              <Match when={e2eeMode() === "unencrypted"}>
                {t`Not encrypted — the other person hasn't turned on encryption.`}
              </Match>
              <Match when={e2eeMode() === "blocked"}>
                {t`This contact's security identity changed — review before sending.`}
              </Match>
            </Switch>
          </span>
        </E2EEIndicator>
      </Show>
      <Show when={groupCanEnable()}>
        <E2EEIndicator
          data-mode="pending"
          onClick={() =>
            openModal({
              type: "e2ee_enable_group",
              channelId: props.channel.id,
            })
          }
        >
          <Symbol style={{ "font-size": "1rem" }}>lock_open</Symbol>
          <span>{t`Turn on end-to-end encryption for this group.`}</span>
        </E2EEIndicator>
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
                        style={disappearOption().seconds !== null ? { color: "#FF8A00" } : {}}
                      >
                        <Symbol>
                          {disappearOption().seconds === null ? "timer_off" : "timer"}
                        </Symbol>
                      </IconButton>
                      <Show when={disappearOption().seconds !== null}>
                        <span style={{ "font-size": "0.6em", "line-height": "1", "margin-top": "-4px", color: "#FF8A00", "font-weight": "600", "pointer-events": "none" }}>
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
                              border: `2px solid ${disappearIdx() === i() ? "#FF8A00" : "var(--md-sys-color-outline)"}`,
                              background: disappearIdx() === i() ? "#FF8A00" : "transparent",
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
              <Show when={props.channel.type === "TextChannel"}>
                <MessageBox.InlineIcon>
                  <div style={{ position: "relative" }}>
                    <Tooltip content={t`Roll dice`} placement="top">
                      <IconButton onPress={() => setShowDiceMenu((v) => !v)}>
                        <Symbol>casino</Symbol>
                      </IconButton>
                    </Tooltip>
                    <Show when={showDiceMenu()}>
                      <div
                        style={{
                          position: "fixed",
                          inset: "0",
                          "z-index": "999",
                        }}
                        onClick={() => setShowDiceMenu(false)}
                      />
                      <div
                        style={{
                          position: "absolute",
                          bottom: "calc(100% + 8px)",
                          right: "0",
                          "z-index": "1000",
                          background: "var(--md-sys-color-surface-container-high)",
                          "border-radius": "12px",
                          padding: "12px",
                          "min-width": "240px",
                          "box-shadow": "0 4px 20px rgba(0,0,0,0.4)",
                          border: "1px solid var(--md-sys-color-outline-variant)",
                        }}
                      >
                        <div style={{ padding: "0 0 8px", "font-size": "0.75em", opacity: "0.6", "font-weight": "600", "letter-spacing": "0.05em", "text-transform": "uppercase" }}>
                          {t`Roll dice`}
                        </div>
                        {/* advantage / disadvantage (single d20 only) */}
                        <div style={{ display: "flex", gap: "4px", "padding-bottom": "8px" }}>
                          <For each={[
                            { key: "none", label: t`Normal` },
                            { key: "adv", label: t`Advantage` },
                            { key: "dis", label: t`Disadvantage` },
                          ] as const}>
                            {(opt) => (
                              <div
                                onClick={() => setDiceAdv(opt.key)}
                                style={{
                                  flex: "1",
                                  "text-align": "center",
                                  padding: "4px 6px",
                                  "border-radius": "8px",
                                  cursor: "pointer",
                                  "font-size": "0.75em",
                                  "font-weight": "600",
                                  background: diceAdv() === opt.key ? "var(--md-sys-color-primary-container)" : "transparent",
                                  color: diceAdv() === opt.key ? "var(--md-sys-color-on-primary-container)" : "inherit",
                                  border: "1px solid var(--md-sys-color-outline-variant)",
                                }}
                              >
                                {opt.label}
                              </div>
                            )}
                          </For>
                        </div>
                        {/* quantity + modifier steppers */}
                        <div style={{ display: "flex", gap: "12px", "padding-bottom": "8px", "font-size": "0.85em" }}>
                          <div style={{ flex: "1", display: "flex", "align-items": "center", gap: "6px" }}>
                            <span style={{ opacity: "0.7" }}>{t`Dice`}</span>
                            <IconButton size="sm" onPress={() => setDiceQty((q) => Math.max(1, q - 1))}>
                              <Symbol>remove</Symbol>
                            </IconButton>
                            <span style={{ "min-width": "2ch", "text-align": "center", "font-weight": "600" }}>{diceQty()}</span>
                            <IconButton size="sm" onPress={() => setDiceQty((q) => Math.min(20, q + 1))}>
                              <Symbol>add</Symbol>
                            </IconButton>
                          </div>
                          <div style={{ flex: "1", display: "flex", "align-items": "center", gap: "6px" }}>
                            <span style={{ opacity: "0.7" }}>{t`Mod`}</span>
                            <IconButton size="sm" onPress={() => setDiceMod((m) => Math.max(-99, m - 1))}>
                              <Symbol>remove</Symbol>
                            </IconButton>
                            <span style={{ "min-width": "3ch", "text-align": "center", "font-weight": "600" }}>
                              {diceMod() > 0 ? `+${diceMod()}` : diceMod()}
                            </span>
                            <IconButton size="sm" onPress={() => setDiceMod((m) => Math.min(99, m + 1))}>
                              <Symbol>add</Symbol>
                            </IconButton>
                          </div>
                        </div>
                        {/* die buttons — click to roll */}
                        <div style={{ display: "grid", "grid-template-columns": "repeat(4, 1fr)", gap: "6px" }}>
                          <For each={DICE_OPTIONS}>
                            {(sides) => (
                              <div
                                onClick={() => rollFromPicker(sides)}
                                style={{
                                  "text-align": "center",
                                  padding: "8px 4px",
                                  "border-radius": "8px",
                                  cursor: "pointer",
                                  "font-weight": "700",
                                  "font-size": "0.85em",
                                  background: "var(--md-sys-color-primary-container)",
                                  color: "var(--md-sys-color-on-primary-container)",
                                }}
                              >
                                d{sides}
                              </div>
                            )}
                          </For>
                        </div>
                        <div style={{ padding: "8px 0 0", "font-size": "0.7em", opacity: "0.5" }}>
                          {t`Or type /roll 2d6+3 in chat`}
                        </div>
                      </div>
                    </Show>
                  </div>
                </MessageBox.InlineIcon>
              </Show>
              <Show when={pollAllowed()}>
                <MessageBox.InlineIcon>
                  <Tooltip content={t`Create poll`} placement="top">
                    <IconButton
                      onPress={() =>
                        openModal({
                          type: "create_poll",
                          channel: props.channel,
                        })
                      }
                    >
                      <Symbol>ballot</Symbol>
                    </IconButton>
                  </Tooltip>
                </MessageBox.InlineIcon>
              </Show>
              <CompositionMediaPicker
                onMessage={sendMessage}
                onTextReplacement={(text) => setNodeReplacement([text])}
              >
                {(triggerProps) => (
                  <>
                    <MessageBox.InlineIcon>
                      <IconButton onPress={triggerProps.onClickSticker}>
                        <Symbol>note_stack</Symbol>
                      </IconButton>
                    </MessageBox.InlineIcon>
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
                    <div ref={triggerProps.ref} />
                  </>
                )}
              </CompositionMediaPicker>
              <Show when={props.channel.havePermission("UploadFiles")}>
                <MessageBox.InlineIcon>
                  <CameraMessageButton
                    onFile={(file) => onFiles([file])}
                    onError={(error) => openModal({ type: "error2", error })}
                  />
                </MessageBox.InlineIcon>
                <MessageBox.InlineIcon>
                  <VoiceMessageButton
                    onFile={(file) => onFiles([file])}
                    onError={(error) => openModal({ type: "error2", error })}
                  />
                </MessageBox.InlineIcon>
              </Show>
              <Show when={scheduleAllowed()}>
                <MessageBox.InlineIcon>
                  <Tooltip
                    content={
                      draft()?.files?.length
                        ? t`Scheduling does not support attachments yet`
                        : !draft()?.content?.trim()
                          ? t`Write a message first, then schedule it`
                          : t`Send later`
                    }
                    placement="top"
                  >
                    <IconButton
                      isDisabled={
                        !!draft()?.files?.length || !draft()?.content?.trim()
                      }
                      onPress={() =>
                        openModal({
                          type: "schedule_message",
                          channel: props.channel,
                        })
                      }
                    >
                      <Symbol>schedule_send</Symbol>
                    </IconButton>
                  </Tooltip>
                </MessageBox.InlineIcon>
              </Show>
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
        sendingAllowed={
          props.channel.havePermission("SendMessage") &&
          // Archived/locked threads are read-only unless the user can manage
          // the parent channel (mirrors the server-side write-lock).
          (!(props.channel.archived || props.channel.locked) ||
            props.channel.havePermission("ManageChannel"))
        }
        autoCompleteSearchSpace={searchSpace}
        updateDraftSelection={(start, end) =>
          state.draft.setSelection(props.channel.id, start, end)
        }
        hasActionsAppend={showSendButton() || false}
        actionsAppend={
          <Show when={showSendButton()}>
            <IconButton
              _compositionSendMessage
              size="sm"
              variant="tonal"
              shape="square"
              isDisabled={!canSend()}
              onPress={sendMessage}
              // Logo-styled send button: a dark Sloga-navy chip with an
              // orange rim and a Discord-style send arrow in the logo ball's
              // blue. Brand colours light up only when a send is possible;
              // disabled falls back to a muted slate look.
              style={{
                width: "56px",
                background: "#101823",
                "box-shadow": `inset 0 0 0 2px ${
                  canSend() ? "#F5870D" : "#2a3547"
                }`,
              }}
            >
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Discord-style paper-plane send arrow, in the logo ball's blue */}
                <path
                  d="M22 2 L15 22 L11 13 L2 9 Z"
                  fill={canSend() ? "#3BB8ED" : "#3a4759"}
                />
                {/* fold crease, cut in the chip colour */}
                <path
                  d="M22 2 L11 13"
                  stroke="#101823"
                  stroke-width="1.3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
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

/**
 * Composer encryption indicator. Green lock for an encrypted conversation;
 * amber warning (clickable) when a peer identity change is blocking sends.
 */
const E2EEIndicator = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "4px 12px",
    fontSize: "0.75rem",
    fontWeight: "600",
    // encrypted (default): green
    color: "#3BA55D",
    // both opted in, encryption not yet established: neutral (informational)
    "&[data-mode='pending']": {
      color: "var(--md-sys-color-primary)",
    },
    // this device is opted in but the peer is not: red
    "&[data-mode='unencrypted']": {
      color: "var(--md-sys-color-error)",
    },
    // peer identity change pending acceptance: amber, clickable
    "&[data-mode='blocked']": {
      color: "#FF8A00",
      cursor: "pointer",
    },
  },
});

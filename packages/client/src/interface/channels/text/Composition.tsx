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
  onMount,
} from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import type { ApplicationCommandData, Message } from "stoat.js";
import {
  Channel,
  ProtectedChannelUnavailable,
  ProtectedFieldRefusedClient,
} from "stoat.js";

import { styled } from "styled-system/jsx";

import { SOFTRES_CREATION_ENABLED } from "@revolt/app";
import { serverActionsBlocked } from "@revolt/app/interface/channels/text/e2eeTranscriptTrust";
import type { E2EEBridge } from "@revolt/client";
import { E2EESendError, useClient, useE2EE, useSound } from "@revolt/client";
import { composerE2EEModeFor } from "@revolt/client/e2eeBadge";
import {
  composerCopy,
  errorUiCopy,
  markerCopy,
  messageCopy,
  noticeCopy,
  panelCopy,
} from "@revolt/client/protectedCopy";
import { isProtectedSendError } from "@revolt/client/protectedSendError";
import {
  type ProtectedAction,
  type ProtectedComposerMode,
  type ProtectedErrorUi,
  type ProtectedNoticeKind,
  protectedActionsBlocked,
  protectedNoticeForError,
  shieldPresentation,
} from "@revolt/client/protectedShield";
import type { ProtectedChannelView } from "@revolt/client/protectedTextTypes";
import {
  protectedUiOf,
  useProtectedMessage,
  useProtectedShield,
} from "@revolt/client/useProtectedChannel";
import { useWindowCtx } from "@revolt/client/windowCtx";
import { CONFIGURATION, debounce, useDevice } from "@revolt/common";
import { pickUploadLimit } from "@revolt/common/lib/uploadLimit";
import { useTime } from "@revolt/i18n";
import { Keybind, KeybindAction, createKeybind } from "@revolt/keybinds";
import { unicodeEmojiPackPrefix } from "@revolt/markdown/emoji/UnicodeEmoji";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import { ALLOWED_IMAGE_TYPES } from "@revolt/state/stores/Draft";
import {
  CameraMessageButton,
  ComposerPopover,
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
import { ProtectedShieldIcon } from "@revolt/ui/components/features/protected/ProtectedShieldIcon";
import { expandTrailingEmoticon } from "@revolt/ui/components/features/texteditor/emoticonExpansion";
import { Symbol } from "@revolt/ui/components/utils/Symbol";
import { useSearchSpace } from "@revolt/ui/components/utils/autoComplete";
import { UserSlowmodes } from "stoat.js/lib/events/v1";

import { createTimedOutUntil } from "../../../lib/timedOut";

import { GameLookupPicker } from "./GameLookupPicker";
import {
  type GameCommand,
  type GameLookupOutcome,
  type GameLookupResult,
  isPrivateConversation,
  parseGameCommand,
  runGameLookup,
} from "./gameLookup";

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
   * Window this composer renders in: the main window, or a chat window whose
   * document differs from the global `document`
   */
  const windowCtx = useWindowCtx();

  /**
   * On phones and tablets the composer splits into two bars (see MessageBox);
   * the bottom bar always carries a send button since there's no reliable
   * enter-to-send on touch keyboards.
   */
  const isStackedLayout = () => layout() !== "desktop";
  const showSendButton = () =>
    isStackedLayout() || state.settings.getValue("appearance:show_send_button");

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
   * - "unconfirmed" → groups only: this device has no group state and cannot
   *                   show the group is unencrypted → amber warning; sends
   *                   wait for an explicit plaintext confirmation
   * - undefined     → neither side is using E2EE (or non-DM) → no indicator
   *
   * Derived from the shared encryption badge (`e2eeBadge.ts`) so this and
   * the chat-window badge cannot disagree; its spec pins it to the logic
   * that lived here before.
   */
  const e2eeMode = createMemo(() => {
    const conv = conversationId();
    if (!conv) return undefined;
    return composerE2EEModeFor({
      mode: e2ee?.sendModes.get(conv),
      isGroup: isGroup(),
      selfEnabled: selfE2EEEnabled(),
      peerAdvertises: peerE2EEEnabled(),
      // Known off with no native layer; `selfE2EEEnabled` reads this same
      // status, so it can only be true once this is
      e2eeLoaded: !e2ee || !!e2ee.status.get("state"),
    });
  });

  /** Material symbol for the current indicator state */
  const e2eeIcon = () => {
    switch (e2eeMode()) {
      case "blocked":
      case "unconfirmed":
        return "gpp_maybe";
      case "peer_downgraded":
        return "lock_open";
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
   * An "unconfirmed" group (no group state on this device, plaintext not
   * proven) is offered it too.
   */
  const groupCanEnable = createMemo(() => {
    if (!isGroup() || !selfE2EEEnabled()) return false;
    const mode = e2ee?.sendModes.get(props.channel.id);
    return mode === "plaintext" || mode === "unconfirmed";
  });

  // `currentSlowmode` must be declared BEFORE `pollAllowed`: the latter's
  // createMemo evaluates eagerly and reads `currentSlowmode()`, so declaring
  // it afterwards is a temporal-dead-zone ReferenceError that crashes
  // MessageComposition and blanks every channel pane.
  const currentSlowmode = (): UserSlowmodes | undefined => {
    return client().userSlowmodes.get(props.channel.id);
  };

  /**
   * Protected channel (plan D9c, D11): the server reports it protected or
   * this device pinned it. A predicate of its own on purpose:
   * `plaintextFeaturesBlocked` is false without E2EE and for every server
   * channel. Independent of `e2ee`, so the web hides the same actions.
   * Declared before `pollAllowed`, which reads it eagerly (see above).
   */
  const protectedChannel = createMemo(() =>
    client().isProtectedChannel(props.channel.id),
  );

  /**
   * Whether a composer action is hidden here (plan D11)
   * @param action Action
   */
  const protectedHides = (action: ProtectedAction) =>
    protectedActionsBlocked(protectedChannel(), action);

  /**
   * Design 9.1 shield, read-only (the open lifecycle is mounted once in
   * `TextChannel.tsx`)
   */
  const protectedShield = useProtectedShield(() => props.channel.id);

  /**
   * Composer mode on a protected channel (design 9.1): `enabled` only in
   * the `protected` state. A shield that is still loading, or missing for a
   * channel the SDK holds protected, is `disabled` (fail closed). Undefined
   * for every other channel.
   */
  const protectedComposer = createMemo<ProtectedComposerMode | undefined>(
    () => {
      if (!protectedChannel()) return undefined;
      const shield = protectedShield();
      return shield ? shieldPresentation(shield.state).composer : "disabled";
    },
  );

  /**
   * The most specific notice for the shield; a loading shield is
   * re-securing
   */
  const protectedNotice = (): ProtectedNoticeKind => {
    const shield = protectedShield();
    if (!shield) return "resecuring";
    return (
      shield.notice ?? shieldPresentation(shield.state).notice ?? "unverified"
    );
  };

  /**
   * Whether features that put new plaintext on the server (polls, scheduled
   * messages, the disappearing timer, slash commands) are withheld here.
   * The trust module decides this for every send mode, so an "unconfirmed"
   * group, a mode that has not loaded yet, and any mode added later fail
   * closed instead of slipping past a list of known encrypted modes. Server
   * channels, threads and web are never blocked. The "unconfirmed" check is
   * a second key on this composer's own reading of the same cache.
   * Declared before `pollAllowed`, which reads it eagerly (see above).
   */
  const plaintextFeaturesBlocked = createMemo(
    () =>
      serverActionsBlocked(e2ee, props.channel, client().user?.id) ||
      e2eeMode() === "unconfirmed",
  );

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
      !plaintextFeaturesBlocked() &&
      !protectedHides("poll") &&
      e2eeMode() !== "encrypt" &&
      e2eeMode() !== "blocked" &&
      // Peer downgraded but this side hasn't consented to plaintext yet —
      // polls are stored plaintext server-side, so fail closed like blocked
      e2eeMode() !== "peer_downgraded" &&
      // Slowmode: creating a poll sends a message, so the affordance hides
      // during an active cooldown (server enforces regardless)
      !currentSlowmode(),
  );

  /**
   * Soft-reserve sheets are server-authoritative plaintext exactly like
   * polls, so they share the poll gate (E2EE fail-closed + slowmode) —
   * plus the feature-wide creation switch, which keeps the affordance
   * dark until the loot catalog verification pass is done.
   */
  const softresAllowed = createMemo(
    () =>
      SOFTRES_CREATION_ENABLED && !protectedHides("softres") && pollAllowed(),
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
      !plaintextFeaturesBlocked() &&
      !protectedHides("schedule") &&
      e2eeMode() !== "encrypt" &&
      e2eeMode() !== "blocked" &&
      e2eeMode() !== "peer_downgraded",
  );

  /**
   * The disappearing-message timer is hidden in encrypted (or blocked, or
   * peer-downgraded) conversations. It deletes by watching for our own
   * message to come back and deleting it later from this tab, and that never
   * takes effect under E2EE: the timer showed as armed while the message
   * stayed. Hidden until disappearing messages exist for E2EE for real.
   */
  const disappearAllowed = createMemo(
    () =>
      !plaintextFeaturesBlocked() &&
      !protectedHides("disappearing_timer") &&
      e2eeMode() !== "encrypt" &&
      e2eeMode() !== "blocked" &&
      e2eeMode() !== "peer_downgraded",
  );

  /**
   * Timelocked messages are sealed ON DEVICE before they ever leave the
   * composer, so unlike polls/scheduling there is no plaintext-on-server
   * concern and no E2EE exclusion: the sealed content rides the normal send
   * path (and through message E2EE, where active) as ordinary text. Hidden
   * on a protected channel all the same (plan D11).
   */
  const timelockAllowed = createMemo(
    () =>
      ["TextChannel", "Thread", "Group", "DirectMessage"].includes(
        props.channel.type,
      ) &&
      props.channel.havePermission("SendMessage") &&
      !protectedHides("timelock") &&
      !currentSlowmode(),
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

  const dayjs = useTime();

  /**
   * The viewer's active timeout in this server, re-evaluated when it expires.
   * DMs and groups have no server member, so this is always undefined there.
   */
  const timedOutUntil = createTimedOutUntil(() => props.channel.server?.member);

  /**
   * Whether the viewer may type in this channel at all.
   *
   * Reads the timeout tick so the composer comes back on its own when a
   * timeout lapses: the SDK permission check compares the timeout against a
   * `new Date()` taken at call time, and nothing re-runs it at the expiry.
   */
  const sendingAllowed = () => {
    timedOutUntil();
    // Design 9.1: on a protected channel the composer exists only in the
    // `protected` state; every other state shows its notice instead
    const protectedMode = protectedComposer();
    if (protectedMode !== undefined && protectedMode !== "enabled") {
      return false;
    }
    return (
      props.channel.havePermission("SendMessage") &&
      // Archived/locked threads are read-only unless the user can manage
      // the parent channel (mirrors the server-side write-lock).
      (!(props.channel.archived || props.channel.locked) ||
        props.channel.havePermission("ManageChannel"))
    );
  };

  /**
   * Composer notice on a protected channel whose shield is not `protected`
   * (design 9.1): re-securing (the draft is kept), no seat, not available
   * on this device (or E2EE off on this desktop, product choice 6), or
   * verification failed (the loud banner above names the cause).
   */
  const protectedBlockedText = (): string | undefined => {
    const mode = protectedComposer();
    if (mode === undefined || mode === "enabled") return undefined;
    if (mode === "disabled") {
      const notice = noticeCopy(protectedNotice());
      return draft().content?.trim()
        ? `${notice} ${composerCopy.draftKept()}`
        : notice;
    }
    return protectedShield()?.state === "unverified"
      ? composerCopy.sendingBlocked()
      : noticeCopy(protectedNotice());
  };

  /**
   * Composer notice while the viewer is timed out, in place of the generic
   * no-permission text. A protected channel's notice comes first.
   */
  const blockedText = () => {
    const protectedText = protectedBlockedText();
    if (protectedText) {
      return protectedText;
    }

    const until = timedOutUntil();
    if (!until) {
      return undefined;
    }

    const time = dayjs(until).format("lll");
    return t`You are timed out until ${time}`;
  };

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

  /**
   * Empty markers rendered either side of the message box. MessageBox takes
   * no ref and swaps its root element between layouts, so "inside the
   * composer" means "between the markers"
   */
  let composerStart: HTMLSpanElement | undefined;
  let composerEnd: HTMLSpanElement | undefined;

  function isInComposer(node: Node | null) {
    if (!node || !composerStart || !composerEnd) return false;
    return (
      !!(
        composerStart.compareDocumentPosition(node) &
        Node.DOCUMENT_POSITION_FOLLOWING
      ) &&
      !!(
        composerEnd.compareDocumentPosition(node) &
        Node.DOCUMENT_POSITION_PRECEDING
      )
    );
  }

  // Focus anywhere in the message box marks this composer as the one
  // mentions go to. The listener sits on the markers' parent (the channel
  // pane), which outlives MessageBox's layout swaps, rather than on the
  // document, where other composers' focus would also arrive.
  onMount(() => {
    const parent = composerStart?.parentElement;
    if (!parent) return;

    const onFocusIn = (event: FocusEvent) => {
      if (isInComposer(event.target as Node | null)) {
        state.draft.noteComposerFocus(props.channel.id, windowCtx.id);
      }
    };

    parent.addEventListener("focusin", onFocusIn);
    onCleanup(() => parent.removeEventListener("focusin", onFocusIn));
  });

  // Register this composer for its channel so replies, edits and mentions
  // reach it. The channel prop can change while mounted, so re-register on
  // change; the unregister removes only this registration, not a composer
  // another window mounted since.
  createEffect(
    on(
      () => props.channel.id,
      (channelId) => {
        onCleanup(
          state.draft.registerNodeReplacement(channelId, setNodeReplacement),
        );

        // A focused composer that switches channel won't see a new focus
        // event, so the last-focused channel would still name the old one
        if (isInComposer(windowCtx.doc.activeElement)) {
          state.draft.noteComposerFocus(channelId, windowCtx.id);
        }
      },
    ),
  );

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
    // Second key behind the hidden dice menu and the sendMessage guard: a
    // roll is a server-written plaintext message (plan D11)
    if (protectedHides("roll")) {
      openModal({
        type: "error2",
        error: new Error(noticeCopy("channel_protected")),
      });
      return;
    }

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
   * Game lookups (`/game`, `/wowitem`, `/champion`): a short status line
   * above the composer, and the open result picker, if any. Both close when
   * the draft is edited or the channel changes, so they never describe text
   * that is no longer there.
   */
  const [lookupNotice, setLookupNotice] = createSignal<string | null>(null);
  const [lookupPending, setLookupPending] = createSignal(false);
  const [gameResults, setGameResults] = createSignal<GameLookupResult[] | null>(
    null,
  );
  const draftText = createMemo(() => currentValue());

  createEffect(
    on(
      [draftText, () => props.channel.id],
      () => {
        setLookupNotice(null);
        setGameResults(null);
      },
      { defer: true },
    ),
  );

  /**
   * Run a game lookup command and open the picker on its results.
   *
   * The privacy gate inside `runGameLookup` (copied from `sendInteraction`)
   * fails closed: a DM or group is looked up only when the native layer says
   * it is exactly plaintext, and a refused lookup makes no request. Either
   * way the command is never sent as a message, and the draft stays.
   * Uses raw fetch like `sendRoll`.
   */
  async function runGameCommand(command: GameCommand) {
    if (lookupPending()) return;

    const channel = props.channel;
    const draftAtStart = currentValue();
    setGameResults(null);
    setLookupNotice(null);
    setLookupPending(true);

    let outcome: GameLookupOutcome;
    try {
      const c = client();
      outcome = await runGameLookup({
        channelType: channel.type,
        getSendMode: e2ee ? () => e2ee.sendModeNowFor(channel) : undefined,
        fetchImpl: (input, init) => fetch(input, init),
        baseURL: c.options.baseURL,
        authHeader: c.authenticationHeader,
        command,
      });
    } catch {
      outcome = { kind: "failed" };
    }
    setLookupPending(false);

    // The user moved on while the lookup ran: drop the answer
    if (props.channel.id !== channel.id || currentValue() !== draftAtStart) {
      return;
    }

    switch (outcome.kind) {
      case "denied":
        setLookupNotice(
          e2ee && isPrivateConversation(channel.type)
            ? t`Game lookup isn't available in encrypted chats.`
            : t`Game lookup isn't available in this conversation.`,
        );
        break;
      case "empty-query":
        setLookupNotice(t`Type a name to look up after the command.`);
        break;
      case "results":
        if (outcome.results.length) {
          setGameResults(outcome.results);
        } else {
          const query = command.query;
          setLookupNotice(t`No results for “${query}”.`);
        }
        break;
      case "busy":
        setLookupNotice(t`Too many lookups, try again in a moment.`);
        break;
      case "disabled":
        setLookupNotice(t`That lookup isn't available right now.`);
        break;
      case "failed":
        setLookupNotice(t`Lookup failed. Try again.`);
        break;
    }
  }

  /**
   * Send the picked result's URL as an ordinary message, through the normal
   * send path (replies, E2EE pre-send guard, slowmode, outbox); the embed
   * pipeline draws the card. The command text is put back if nothing was
   * sent, so the draft is cleared only by a successful send.
   */
  async function pickGameResult(result: GameLookupResult) {
    setGameResults(null);

    const channelId = props.channel.id;
    const command = draft().content ?? "";
    state.draft.setDraft(channelId, { ...draft(), content: result.url });

    /**
     * `sendDraft` takes the draft as its first step, so the URL still being
     * in the draft means the send stopped before that
     */
    const restoreIfUnsent = () => {
      const current = state.draft.getDraft(channelId);
      if (current.content === result.url) {
        state.draft.setDraft(channelId, { ...current, content: command });
      }
    };

    try {
      await sendMessage();
    } catch (error) {
      restoreIfUnsent();
      openModal({
        type: "error2",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    restoreIfUnsent();
    setNodeReplacement(["_focus"]);
  }

  /**
   * Close the picker without sending; the draft was never changed
   */
  function cancelGameLookup() {
    setGameResults(null);
    setNodeReplacement(["_focus"]);
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
    // lag right after app launch); a native error also fails closed. Only a
    // proven "plaintext" lets the interaction through; an "unconfirmed"
    // group asks for the plaintext confirmation first.
    if (
      e2ee &&
      (props.channel.type === "DirectMessage" || props.channel.type === "Group")
    ) {
      const target = props.channel;
      let mode: Awaited<ReturnType<E2EEBridge["sendModeNowFor"]>>;
      try {
        mode = await e2ee.sendModeNowFor(target, { proof: true });
      } catch {
        openModal({
          type: "error2",
          error: t`Encryption status could not be verified. Nothing was sent.`,
        });
        return;
      }
      if (mode === "unconfirmed" && target.type === "Group") {
        openModal({
          type: "e2ee_group_plaintext_confirm",
          channelId: target.id,
        });
        return;
      }
      if (
        (mode !== null && mode !== "plaintext") ||
        plaintextFeaturesBlocked()
      ) {
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
                  type ??
                    (error instanceof Error ? error.message : String(error)),
                ),
      });
    }
  }

  /**
   * Send a message using the current draft
   * @param useContent Content to send
   */
  async function sendMessage(useContent?: unknown) {
    // Protected channel guard, FIRST (plan D9c): nothing below runs for a
    // protected or pinned channel. `/roll`, game lookups, `/softres`, bot
    // slash commands and the disappearing timer would each put text or
    // metadata on the server outside the encryption.
    if (client().isProtectedChannel(props.channel.id)) {
      return sendProtectedMessage(useContent);
    }

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

    // Intercept game lookups (/game, /wowitem, /champion): the text is a
    // search, never a plain message, whether or not the gate lets it run
    const gameCommand = parseGameCommand(trimmed);
    if (gameCommand) {
      await runGameCommand(gameCommand);
      return;
    }

    // Intercept /softres — the command opens the create modal, no message
    // is sent (and the draft is cleared so the command text doesn't linger)
    if (/^\/softres(\s|$)/i.test(trimmed)) {
      if (softresAllowed()) {
        state.draft.setDraft(props.channel.id, { content: "" });
        openModal({ type: "create_softres", channel: props.channel });
        return;
      }
      // Feature dark (or context disallows): fall through, sends as text
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

    // This is a plain message, so expand an emoticon it ends on: the editor
    // only expands the ones a space was typed after, and the last thing typed
    // before sending never gets one. Written back to the draft because that is
    // what sendDraft reads, which also covers the send button and phone taps.
    if (typeof useContent !== "string") {
      expandDraftEmoticon(rawContent);
    }

    // E2EE pre-send guard: a blocked conversation (peer identity change
    // pending acceptance) routes to the identity modal instead of a raw
    // error. The mode is read from the NATIVE layer authoritatively (an
    // awaited round-trip, not the cached indicator). This is UX only —
    // the fail-closed security gate is `prepareDraftAttachments` inside
    // sendDraft (attachments now ride the encrypted path, slice 3.5).
    const peer = peerUserId();
    if (peer && e2ee) {
      let mode: Awaited<ReturnType<E2EEBridge["sendModeNow"]>>;
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
        // Peer identity change — cleared only by explicit acceptance.
        openModal({
          type: "e2ee_identity_change",
          peerUserId: peer,
        });
        return;
      }
      if (mode === "peer_downgraded") {
        // Peer turned encryption off — cleared only through
        // confirmPeerDowngrade (accept plaintext / keep encrypted), the
        // dialog-gated core exit (design §5.2). Routing this to the
        // identity modal was the gate-sitting bug-5 dead-end.
        openModal({
          type: "e2ee_peer_downgrade",
          channelId: props.channel.id,
          peerUserId: peer,
        });
        return;
      }
    }

    // Group pre-send guard, the group half of the guard above. A group this
    // device holds no state for comes back "unconfirmed" unless the device
    // listings prove nobody in it uses E2EE; that send waits for an explicit
    // plaintext confirmation. This runs BEFORE sendDraft pops the draft, so
    // the text and files stay put while the dialog is open. The throws
    // inside the e2ee send path stay as the backstop. This protects an
    // honest server and local state loss; a malicious server can still pass
    // the proof for a fresh device.
    if (e2ee && isGroup()) {
      const group = props.channel;
      let mode: Awaited<ReturnType<E2EEBridge["sendModeNowFor"]>>;
      try {
        mode = await e2ee.sendModeNowFor(group, { proof: true });
      } catch {
        // Native layer unreachable: fail closed
        openModal({
          type: "error2",
          error: t`Encryption status could not be verified. Nothing was sent.`,
        });
        return;
      }

      // The proof can take seconds. If the composer moved to another
      // channel meanwhile, sending now would pop and send THAT channel's
      // draft on this group's verdict, so send nothing; this group's draft
      // is still there.
      if (props.channel.id !== group.id) return;

      if (mode === "unconfirmed") {
        openModal({
          type: "e2ee_group_plaintext_confirm",
          channelId: group.id,
        });
        return;
      }
    }

    // Disappearing-message timer. Re-checked here, not only by hiding the
    // icon: a timer picked while the conversation was plaintext must not arm
    // once it has become encrypted. The indicator mode is a cache, and for a
    // group it stays unset if priming failed, so ask the native layer
    // authoritatively (only when a timer is set; plain sends skip the
    // round-trip). An unverifiable mode does not arm, and neither does an
    // "unconfirmed" group: only "plaintext" (or a non-E2EE channel) arms.
    let timer = disappearAllowed() ? disappearOption().seconds : null;
    if (
      timer !== null &&
      e2ee &&
      (props.channel.type === "DirectMessage" || props.channel.type === "Group")
    ) {
      try {
        const mode = await e2ee.sendModeNowFor(props.channel, { proof: true });
        if (mode !== null && mode !== "plaintext") timer = null;
      } catch {
        timer = null;
      }
    }

    stopTyping();
    sound.playSound("messageSent");
    props.onMessageSend?.();

    // Schedule disappearing message deletion
    if (timer !== null) {
      const channelId = props.channel.id;
      const userId = client()!.user!.id;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onMsg = (message: any) => {
        if (message.channelId === channelId && message.authorId === userId) {
          client().removeListener("messageCreate", onMsg);
          setTimeout(() => {
            try {
              void message.delete().catch(() => undefined);
            } catch {
              // Best-effort self-destruct: the message may already be gone.
            }
          }, timer * 1000);
        }
      };
      client().on("messageCreate", onMsg);
      setTimeout(() => client().removeListener("messageCreate", onMsg), 15000);
    }

    // The channel this send targets, kept for the error routing below
    const sendChannel = props.channel;
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
        // The backstop in the group send path refused a group that still
        // needs the plaintext confirmation: route it to that dialog.
        if (
          (error.kind === "group_unconfirmed" ||
            error.kind === "group_unestablished") &&
          sendChannel.type === "Group"
        ) {
          openModal({
            type: "e2ee_group_plaintext_confirm",
            channelId: sendChannel.id,
          });
          return;
        }
        openModal({ type: "error2", error: error.message });
        return;
      }
      throw error;
    }
  }

  /**
   * Expand an emoticon the draft ends on, written back to the draft (see
   * the plain send path for why)
   * @param rawContent Draft text
   */
  function expandDraftEmoticon(rawContent: string) {
    if (!state.settings.getValue("appearance:expand_emoticons")) return;
    const expanded = expandTrailingEmoticon(
      rawContent,
      unicodeEmojiPackPrefix(
        state.settings.getValue("appearance:unicode_emoji") as string,
      ),
    );
    if (expanded !== rawContent) {
      state.draft.setDraft(props.channel.id, {
        ...draft(),
        content: expanded,
      });
    }
  }

  /**
   * The ONLY send path on a protected or pinned channel (plan D9c, D10):
   * the draft's text through `sendDraft`, whose protected outbox (lane C5)
   * reaches the SDK protected arm. No command interception, no timer, no
   * files, no picker content. A refusal is shown through
   * `protectedNoticeForError`, never `error.message`; putting the draft
   * text back is `sendDraft`'s job and is not repeated here.
   * @param useContent Picker content (a GIF or sticker URL), refused
   */
  async function sendProtectedMessage(useContent: unknown) {
    // Design 9.1: sending only in the `protected` state. Every other state
    // already shows its notice in place of the editor.
    if (protectedComposer() !== "enabled") return;

    // GIFs and stickers are hidden here (D11); a stray picker send is
    // refused, never sent
    if (typeof useContent === "string") {
      openModal({
        type: "error2",
        error: new Error(noticeCopy("channel_protected")),
      });
      return;
    }

    if (!canSend() || currentSlowmode()) return;

    // Files are refused before anything is taken from the draft or
    // uploaded (D9d/e); the guard inside sendDraft is the backstop
    if (draft().files?.length) {
      openModal({
        type: "error2",
        error: new Error(composerCopy.filesRefused()),
      });
      return;
    }

    expandDraftEmoticon(currentValue());

    stopTyping();
    sound.playSound("messageSent");
    props.onMessageSend?.();

    try {
      await state.draft.sendDraft(client(), props.channel);
    } catch (error) {
      openModal({
        type: "error2",
        error: new Error(protectedSendErrorText(error)),
      });
    }
  }

  /**
   * Copy for a rejected protected send (plan D17). The bridge wraps every
   * failure in one `ProtectedSendError` whose `failure` is the cause;
   * without a bridge (web) the SDK throws `ProtectedChannelUnavailable`
   * itself, and sendDraft refuses a draft with files as
   * `ProtectedFieldRefusedClient("attachments")` (lane C5). A cause with no
   * copy (`none`) still fails loudly.
   * @param error Rejection from sendDraft
   */
  function protectedSendErrorText(error: unknown): string {
    const cause = isProtectedSendError(error) ? error.failure : error;
    if (isFilesRefusal(cause)) return composerCopy.filesRefused();
    return (
      errorUiCopy(protectedSendErrorUi(cause, protectedNotice())) ??
      noticeCopy("send_refused")
    );
  }

  /**
   * Native owner-change dialog in flight (D15); blocks a second click
   */
  const [reviewingOwnerChange, setReviewingOwnerChange] = createSignal(false);

  /**
   * Plan D15 "Review owner change": opens native's dialog, ONLY from the
   * banner button's click. A cancel (`declined`) maps to no copy and stays
   * silent; any other failure shows its notice.
   */
  async function reviewOwnerChange() {
    if (reviewingOwnerChange()) return;
    const channelId = props.channel.id;
    const ui = protectedUiOf(client().e2ee);
    setReviewingOwnerChange(true);
    try {
      if (!ui) throw new ProtectedChannelUnavailable();
      await ui.confirmOwnerChange(channelId);
    } catch (error) {
      const text = errorUiCopy(protectedOwnerErrorUi(error, protectedNotice()));
      if (text) openModal({ type: "error2", error: new Error(text) });
    } finally {
      setReviewingOwnerChange(false);
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
   * Largest attachment this conversation will accept right now.
   *
   * E2EE conversations must clamp small: native encrypt/decrypt is one-shot
   * and whole-buffer, capped at 20 MiB in e2ee-core (mirrored just under by
   * E2EE_MAX_ATTACHMENT_SIZE), and chunked uploads are plaintext-only for
   * now. The server's E2EE blob route is not the binding limit.
   * Fail closed: "pending"/"blocked"/"peer_downgraded"/"unconfirmed" can
   * still resolve to an encrypted send, so they get the small cap too — only
   * a definitively-plaintext conversation may admit large files.
   *
   * Plaintext conversations clamp to the server limit that applies to this
   * account (the upload perk, the new-account tier, or the default): files
   * above CHUNKED_UPLOAD_THRESHOLD take the chunked path, whose sub-100 MB
   * parts clear the CDN wall that used to cap everything at
   * MAX_UPLOAD_REQUEST_SIZE. The server enforces the same tiers, so a stale
   * perk here only changes what the picker admits.
   *
   * Every path that puts bytes into the draft must consult this — not just
   * the picker. The image editor re-encodes what it exports, so an edit can
   * land above the cap even though the original was under it.
   * @returns Maximum attachment size in bytes
   */
  function attachmentSizeLimit() {
    const serverLimit = client().configured()
      ? (pickUploadLimit(
          client().configuration,
          client().user,
          "attachments",
        ) ?? CONFIGURATION.MAX_FILE_SIZE)
      : CONFIGURATION.MAX_FILE_SIZE;

    const maybeEncrypted =
      e2eeMode() === "encrypt" ||
      e2eeMode() === "blocked" ||
      e2eeMode() === "pending" ||
      e2eeMode() === "peer_downgraded" ||
      e2eeMode() === "unconfirmed";

    return maybeEncrypted
      ? Math.min(serverLimit, CONFIGURATION.E2EE_MAX_ATTACHMENT_SIZE)
      : serverLimit;
  }

  /**
   * Handle files being added to the draft.
   * @param files List of files
   */
  function onFiles(files: File[]) {
    if (refuseProtectedFiles()) return;

    const rejectedFiles: File[] = [];
    const validFiles: File[] = [];
    const maxSize = attachmentSizeLimit();

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
   * Protected channels take no files yet (plan D9; attachments are S3).
   * Every entry point is hidden there; this is the composer's second key.
   * @returns Whether the files were refused
   */
  function refuseProtectedFiles() {
    if (!protectedHides("attachments")) return false;
    openModal({
      type: "error2",
      error: new Error(composerCopy.filesRefused()),
    });
    return true;
  }

  /**
   * Add a file to the message
   */
  function addFile() {
    if (refuseProtectedFiles()) return;

    // In a chat window the picker must open over that window, so the input
    // lives in its document
    const doc = windowCtx.doc;
    const input = doc.createElement("input");
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
    doc.body.appendChild(input);
    input.click();
  }

  /**
   * Remove a file by its ID
   * @param fileId File ID
   */
  function removeFile(fileId: string) {
    state.draft.removeFile(props.channel.id, fileId);
  }

  /**
   * Open the image editor for a pending attachment
   * @param fileId File ID
   */
  function editFile(fileId: string) {
    const entry = state.draft.getFile(fileId);
    if (!entry || !ALLOWED_IMAGE_TYPES.includes(entry.file.type)) return;
    // the editor flattens to a still frame; don't silently kill animations
    if (entry.file.type === "image/gif") return;

    openModal({
      type: "image_editor",
      file: entry.file,
      onSave: (file) => {
        // The editor re-encodes on export, so its output can be LARGER than
        // the file that was admitted at pick time — a PNG re-encode of a
        // photo especially. Re-check here or an over-cap edit sails past the
        // picker's guard and only fails at send (and the cap is much smaller
        // in an encrypted conversation).
        const maxSize = attachmentSizeLimit();
        if (file.size > maxSize) {
          const fileSize = humanFileSize(file.size);
          const maxSizeFormatted = humanFileSize(maxSize);
          const error = new Error(
            t`The edited image (${fileSize}) exceeds the maximum size limit of ${maxSizeFormatted}. Crop it smaller, or close the editor to send the original.`,
          );
          error.name = "File too large";
          openModal({ type: "error2", error });
          return false;
        }

        state.draft.replaceFile(props.channel.id, fileId, file);
        return true;
      },
    });
  }

  const baseSearchSpace = useSearchSpace(() => props.channel, client);

  /**
   * Slash commands invocable in this channel. Fetched lazily per channel;
   * EMPTY (facet hidden, fail-closed) in encrypted or blocked conversations
   * — interactions never get a plaintext fallback inside E2EE — and in
   * DMs / saved messages, which the server structurally rejects anyway.
   * The same goes for any conversation the trust gate withholds plaintext
   * features from, an "unconfirmed" group included, and for a protected
   * channel (plan D11; not even fetched).
   */
  const [availableCommands] = createResource(
    () =>
      [
        props.channel.id,
        props.channel.type,
        e2eeMode(),
        plaintextFeaturesBlocked(),
        protectedHides("slash_commands"),
      ] as [string, string, string | undefined, boolean, boolean],
    async ([, type, mode, blocked, protectedHidden]) => {
      if (
        protectedHidden ||
        blocked ||
        mode === "encrypt" ||
        mode === "blocked" ||
        mode === "peer_downgraded"
      )
        return [];
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

  // A conversation that turns encrypted drops any timer that was picked, so
  // it does not quietly come back if the conversation later goes plaintext.
  createEffect(() => {
    if (!disappearAllowed()) {
      setDisappearIdx(0);
      setShowDisappearMenu(false);
    }
  });

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

  // Extra composer actions (poll, soft-reserve, stickers, GIF) live in a
  // slide-out tray that stays collapsed until toggled — see actionsEnd
  const [showMoreActions, setShowMoreActions] = createSignal(false);

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
            } else if (e2eeMode() === "peer_downgraded") {
              // Groups reach the confirm flow through this banner too —
              // confirmPeerDowngrade keys on the channel id there, no peer
              // needed (frontend review HIGH-2).
              openModal({
                type: "e2ee_peer_downgrade",
                channelId: props.channel.id,
                peerUserId: peerUserId(),
              });
            } else if (e2eeMode() === "unconfirmed" && isGroup()) {
              // The same plaintext confirmation a send in this group asks for
              openModal({
                type: "e2ee_group_plaintext_confirm",
                channelId: props.channel.id,
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
              <Match when={e2eeMode() === "peer_downgraded"}>
                {t`Encryption was turned off — choose how to continue.`}
              </Match>
              <Match when={e2eeMode() === "unconfirmed"}>
                {t`This device can't confirm this group is unencrypted — review before sending.`}
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
      <Show
        when={protectedChannel() && protectedShield()?.state === "unverified"}
      >
        <ProtectedBanner role="status">
          <ProtectedShieldIcon state="unverified" size={16} />
          <span>{noticeCopy(protectedNotice())}</span>
          <Show when={ownerChangeReviewable(protectedShield()?.view)}>
            <ProtectedBannerAction
              type="button"
              disabled={reviewingOwnerChange()}
              onClick={() => void reviewOwnerChange()}
            >
              {panelCopy.reviewOwnerChange()}
            </ProtectedBannerAction>
          </Show>
        </ProtectedBanner>
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
        editFile={editFile}
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

          // Protected: the decrypted text, never the row's server text
          return (
            <Show
              when={protectedChannel()}
              fallback={
                <MessageReplyPreview
                  message={message}
                  mention={reply.mention}
                  toggle={toggle}
                  dismiss={dismiss}
                  self={message?.authorId === client()!.user!.id}
                />
              }
            >
              <ProtectedReplyPreview
                messageId={reply.id}
                message={message}
                dismiss={dismiss}
              />
            </Show>
          );
        }}
      </For>
      <Show when={lookupPending() || lookupNotice()}>
        <LookupNotice role="status">
          <Symbol style={{ "font-size": "1rem" }}>
            {lookupPending() ? "hourglass_top" : "info"}
          </Symbol>
          <span>{lookupPending() ? t`Looking up…` : lookupNotice()}</span>
        </LookupNotice>
      </Show>
      <Show when={gameResults()}>
        {(results) => (
          <GameLookupPicker
            results={results()}
            onPick={(result) => void pickGameResult(result)}
            onCancel={cancelGameLookup}
          />
        )}
      </Show>
      <span ref={composerStart} hidden />
      <MessageBox
        tone={
          protectedChannel()
            ? "protected"
            : e2eeMode() === "encrypt"
              ? "encrypted"
              : "plain"
        }
        initialValue={initialValue()}
        nodeReplacement={nodeReplacement()}
        onSendMessage={() => sendMessage()}
        onTyping={delayedStopTyping}
        onEditLastMessage={() => {
          // Edits are refused on a protected channel (plan D11)
          if (protectedHides("edit")) return;
          state.draft.setEditingMessage(true, props.channel.id);
        }}
        content={draft()?.content ?? ""}
        setContent={setContent}
        actionsStart={
          <Switch fallback={<MessageBox.InlineIcon size="short" />}>
            <Match when={protectedChannel()}>
              <MessageBox.InlineIcon>
                <ProtectedComposerShield>
                  <ProtectedShieldIcon
                    state={protectedShield()?.state ?? "resecuring"}
                  />
                </ProtectedComposerShield>
              </MessageBox.InlineIcon>
            </Match>
            <Match
              when={
                props.channel.havePermission("UploadFiles") &&
                !protectedHides("attachments")
              }
            >
              <MessageBox.InlineIcon>
                <IconButton onPress={addFile}>
                  <Symbol>add</Symbol>
                </IconButton>
              </MessageBox.InlineIcon>
            </Match>
          </Switch>
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
              {/* Every action in the tray is hidden on a protected channel */}
              <Show when={!protectedChannel()}>
                <MessageBox.InlineIcon>
                  <Tooltip
                    content={
                      showMoreActions() ? t`Fewer options` : t`More options`
                    }
                    placement="top"
                  >
                    <IconButton onPress={() => setShowMoreActions((v) => !v)}>
                      <Symbol>
                        {showMoreActions() ? "chevron_left" : "chevron_right"}
                      </Symbol>
                    </IconButton>
                  </Tooltip>
                </MessageBox.InlineIcon>
              </Show>
              <CompositionMediaPicker
                onMessage={sendMessage}
                onTextReplacement={(text) => setNodeReplacement([text])}
                // Protected: the picker offers emoji only, no GIF or
                // sticker tab (plan D11)
                emojiOnly={protectedHides("gif") || protectedHides("stickers")}
              >
                {(triggerProps) => (
                  <>
                    {/* Slide-out tray: extra actions stay collapsed until
                        the chevron toggle reveals them */}
                    <div
                      style={{
                        display: "flex",
                        "align-items": "center",
                        overflow: "hidden",
                        "max-width": showMoreActions() ? "288px" : "0px",
                        opacity: showMoreActions() ? "1" : "0",
                        transition: "max-width 0.25s ease, opacity 0.2s ease",
                      }}
                    >
                      <Show
                        when={
                          props.channel.type === "TextChannel" &&
                          !protectedHides("dice")
                        }
                      >
                        <MessageBox.InlineIcon>
                          <ComposerPopover
                            open={showDiceMenu()}
                            onDismiss={() => setShowDiceMenu(false)}
                            panel={
                              <div
                                style={{
                                  background:
                                    "var(--md-sys-color-surface-container-high)",
                                  "border-radius": "12px",
                                  padding: "12px",
                                  "min-width": "240px",
                                  "box-shadow": "0 4px 20px rgba(0,0,0,0.4)",
                                  border:
                                    "1px solid var(--md-sys-color-outline-variant)",
                                }}
                              >
                                <div
                                  style={{
                                    padding: "0 0 8px",
                                    "font-size": "0.75em",
                                    opacity: "0.6",
                                    "font-weight": "600",
                                    "letter-spacing": "0.05em",
                                    "text-transform": "uppercase",
                                  }}
                                >
                                  {t`Roll dice`}
                                </div>
                                {/* advantage / disadvantage (single d20 only) */}
                                <div
                                  style={{
                                    display: "flex",
                                    gap: "4px",
                                    "padding-bottom": "8px",
                                  }}
                                >
                                  <For
                                    each={
                                      [
                                        { key: "none", label: t`Normal` },
                                        { key: "adv", label: t`Advantage` },
                                        { key: "dis", label: t`Disadvantage` },
                                      ] as const
                                    }
                                  >
                                    {(opt) => (
                                      <div
                                        onClick={() => setDiceAdv(opt.key)}
                                        style={{
                                          flex: "1",
                                          "text-align": "center",
                                          padding: "8px 6px",
                                          "border-radius": "8px",
                                          cursor: "pointer",
                                          "font-size": "0.75em",
                                          "font-weight": "600",
                                          background:
                                            diceAdv() === opt.key
                                              ? "var(--md-sys-color-primary-container)"
                                              : "transparent",
                                          color:
                                            diceAdv() === opt.key
                                              ? "var(--md-sys-color-on-primary-container)"
                                              : "inherit",
                                          border:
                                            "1px solid var(--md-sys-color-outline-variant)",
                                        }}
                                      >
                                        {opt.label}
                                      </div>
                                    )}
                                  </For>
                                </div>
                                {/* quantity + modifier steppers */}
                                <div
                                  style={{
                                    display: "flex",
                                    gap: "12px",
                                    "padding-bottom": "8px",
                                    "font-size": "0.85em",
                                  }}
                                >
                                  <div
                                    style={{
                                      flex: "1",
                                      display: "flex",
                                      "align-items": "center",
                                      gap: "6px",
                                    }}
                                  >
                                    <span
                                      style={{ opacity: "0.7" }}
                                    >{t`Dice`}</span>
                                    <IconButton
                                      size="sm"
                                      onPress={() =>
                                        setDiceQty((q) => Math.max(1, q - 1))
                                      }
                                    >
                                      <Symbol>remove</Symbol>
                                    </IconButton>
                                    <span
                                      style={{
                                        "min-width": "2ch",
                                        "text-align": "center",
                                        "font-weight": "600",
                                      }}
                                    >
                                      {diceQty()}
                                    </span>
                                    <IconButton
                                      size="sm"
                                      onPress={() =>
                                        setDiceQty((q) => Math.min(20, q + 1))
                                      }
                                    >
                                      <Symbol>add</Symbol>
                                    </IconButton>
                                  </div>
                                  <div
                                    style={{
                                      flex: "1",
                                      display: "flex",
                                      "align-items": "center",
                                      gap: "6px",
                                    }}
                                  >
                                    <span
                                      style={{ opacity: "0.7" }}
                                    >{t`Mod`}</span>
                                    <IconButton
                                      size="sm"
                                      onPress={() =>
                                        setDiceMod((m) => Math.max(-99, m - 1))
                                      }
                                    >
                                      <Symbol>remove</Symbol>
                                    </IconButton>
                                    <span
                                      style={{
                                        "min-width": "3ch",
                                        "text-align": "center",
                                        "font-weight": "600",
                                      }}
                                    >
                                      {diceMod() > 0
                                        ? `+${diceMod()}`
                                        : diceMod()}
                                    </span>
                                    <IconButton
                                      size="sm"
                                      onPress={() =>
                                        setDiceMod((m) => Math.min(99, m + 1))
                                      }
                                    >
                                      <Symbol>add</Symbol>
                                    </IconButton>
                                  </div>
                                </div>
                                {/* die buttons — click to roll */}
                                <div
                                  style={{
                                    display: "grid",
                                    "grid-template-columns": "repeat(4, 1fr)",
                                    gap: "6px",
                                  }}
                                >
                                  <For each={DICE_OPTIONS}>
                                    {(sides) => (
                                      <div
                                        onClick={() => rollFromPicker(sides)}
                                        style={{
                                          "text-align": "center",
                                          padding: "12px 4px",
                                          "border-radius": "8px",
                                          cursor: "pointer",
                                          "font-weight": "700",
                                          "font-size": "0.85em",
                                          background:
                                            "var(--md-sys-color-primary-container)",
                                          color:
                                            "var(--md-sys-color-on-primary-container)",
                                        }}
                                      >
                                        d{sides}
                                      </div>
                                    )}
                                  </For>
                                </div>
                                <div
                                  style={{
                                    padding: "8px 0 0",
                                    "font-size": "0.7em",
                                    opacity: "0.5",
                                  }}
                                >
                                  {t`Or type /roll 2d6+3 in chat`}
                                </div>
                              </div>
                            }
                          >
                            <Tooltip content={t`Roll dice`} placement="top">
                              <IconButton
                                onPress={() => setShowDiceMenu((v) => !v)}
                              >
                                <Symbol>casino</Symbol>
                              </IconButton>
                            </Tooltip>
                          </ComposerPopover>
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
                      <Show when={softresAllowed()}>
                        <MessageBox.InlineIcon>
                          <Tooltip
                            content={t`Create soft-reserve sheet`}
                            placement="top"
                          >
                            <IconButton
                              onPress={() =>
                                openModal({
                                  type: "create_softres",
                                  channel: props.channel,
                                })
                              }
                            >
                              <Symbol>shield</Symbol>
                            </IconButton>
                          </Tooltip>
                        </MessageBox.InlineIcon>
                      </Show>
                      <Show when={timelockAllowed()}>
                        <MessageBox.InlineIcon>
                          <Tooltip
                            content={t`Timelock message`}
                            placement="top"
                          >
                            <IconButton
                              onPress={() =>
                                openModal({
                                  type: "timelock_compose",
                                  channel: props.channel,
                                })
                              }
                            >
                              <Symbol>lock_clock</Symbol>
                            </IconButton>
                          </Tooltip>
                        </MessageBox.InlineIcon>
                      </Show>
                      <Show when={!protectedHides("stickers")}>
                        <MessageBox.InlineIcon>
                          <IconButton onPress={triggerProps.onClickSticker}>
                            <Symbol>note_stack</Symbol>
                          </IconButton>
                        </MessageBox.InlineIcon>
                      </Show>
                      <Show when={!canSend() && !protectedHides("gif")}>
                        <MessageBox.InlineIcon>
                          <IconButton onPress={triggerProps.onClickGif}>
                            <Symbol>gif</Symbol>
                          </IconButton>
                        </MessageBox.InlineIcon>
                      </Show>
                    </div>
                    <MessageBox.InlineIcon>
                      <IconButton onPress={triggerProps.onClickEmoji}>
                        <Symbol>emoticon</Symbol>
                      </IconButton>
                    </MessageBox.InlineIcon>
                    <div ref={triggerProps.ref} />
                  </>
                )}
              </CompositionMediaPicker>
              <Show when={disappearAllowed()}>
                <MessageBox.InlineIcon>
                  <ComposerPopover
                    open={showDisappearMenu()}
                    onDismiss={() => setShowDisappearMenu(false)}
                    panel={
                      <div
                        style={{
                          background:
                            "var(--md-sys-color-surface-container-high)",
                          "border-radius": "12px",
                          padding: "8px 0",
                          "min-width": "160px",
                          "box-shadow": "0 4px 20px rgba(0,0,0,0.4)",
                          border:
                            "1px solid var(--md-sys-color-outline-variant)",
                        }}
                      >
                        <div
                          style={{
                            padding: "4px 12px 8px",
                            "font-size": "0.75em",
                            opacity: "0.6",
                            "font-weight": "600",
                            "letter-spacing": "0.05em",
                            "text-transform": "uppercase",
                          }}
                        >
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
                                padding: "12px 16px",
                                cursor: "pointer",
                                background:
                                  disappearIdx() === i()
                                    ? "var(--md-sys-color-primary-container)"
                                    : "transparent",
                                color:
                                  disappearIdx() === i()
                                    ? "var(--md-sys-color-on-primary-container)"
                                    : "inherit",
                                "font-size": "0.9em",
                              }}
                            >
                              <div
                                style={{
                                  width: "16px",
                                  height: "16px",
                                  "border-radius": "50%",
                                  border: `2px solid ${disappearIdx() === i() ? "#FF8A00" : "var(--md-sys-color-outline)"}`,
                                  background:
                                    disappearIdx() === i()
                                      ? "#FF8A00"
                                      : "transparent",
                                  "flex-shrink": "0",
                                }}
                              />
                              {opt.label}
                            </div>
                          )}
                        </For>
                      </div>
                    }
                  >
                    <Tooltip content={disappearTooltipText()} placement="top">
                      <div
                        style={{
                          display: "flex",
                          "flex-direction": "column",
                          "align-items": "center",
                        }}
                      >
                        <IconButton
                          onPress={toggleDisappearMenu}
                          style={
                            disappearOption().seconds !== null
                              ? { color: "#FF8A00" }
                              : {}
                          }
                        >
                          <Symbol>
                            {disappearOption().seconds === null
                              ? "timer_off"
                              : "timer"}
                          </Symbol>
                        </IconButton>
                        <Show when={disappearOption().seconds !== null}>
                          <span
                            style={{
                              "font-size": "0.6em",
                              "line-height": "1",
                              "margin-top": "-4px",
                              color: "#FF8A00",
                              "font-weight": "600",
                              "pointer-events": "none",
                            }}
                          >
                            {disappearOption().label}
                          </span>
                        </Show>
                      </div>
                    </Tooltip>
                  </ComposerPopover>
                </MessageBox.InlineIcon>
              </Show>
              <Show
                when={
                  props.channel.havePermission("UploadFiles") &&
                  !protectedHides("camera") &&
                  !protectedHides("voice_message")
                }
              >
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
          protectedChannel()
            ? composerCopy.placeholder()
            : props.channel.type === "SavedMessages"
              ? t`Save to your notes`
              : props.channel.type === "DirectMessage"
                ? t`Message ${props.channel.recipient?.username}`
                : t`Message ${props.channel.name}`
        }
        sendingAllowed={sendingAllowed()}
        blockedText={blockedText()}
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
              <svg
                width="30"
                height="30"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
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
      <span ref={composerEnd} hidden />
      {/* Inactive on a protected channel (plan D9): no file is collected */}
      <FilePasteCollector
        onFiles={onFiles}
        ctx={windowCtx}
        active={() => !protectedHides("attachments")}
      />
      <FileDropAnywhereCollector
        onFiles={onFiles}
        ctx={windowCtx}
        active={() => !protectedHides("attachments")}
      />
    </>
  );
}

/**
 * Whether `error` is an instance of `cls`, also across realms by the
 * `name` the SDK sets (a literal: minified class names differ)
 * @param error Value
 * @param cls Error class
 * @param name The class's `error.name`
 */
function isErrorClass(
  error: unknown,
  cls: typeof ProtectedChannelUnavailable | typeof ProtectedFieldRefusedClient,
  name: "ProtectedChannelUnavailable" | "ProtectedFieldRefusedClient",
): boolean {
  return (
    error instanceof cls || (error instanceof Error && error.name === name)
  );
}

/**
 * Whether a protected send was refused for carrying files (D9d/e;
 * attachments are S3): expected, not a client defect
 * @param cause The `ProtectedSendError` failure, or the bare rejection
 */
function isFilesRefusal(cause: unknown): boolean {
  if (
    !isErrorClass(
      cause,
      ProtectedFieldRefusedClient,
      "ProtectedFieldRefusedClient",
    )
  ) {
    return false;
  }
  const field = (cause as { field?: unknown }).field;
  return field === "attachments" || field === "e2eeAttachments";
}

/**
 * Plan D17 answer for the cause of a rejected protected send. The two SDK
 * refusals are not `TextFlowFailure`s, so they are mapped here; everything
 * else goes through `protectedNoticeForError`, which fails closed.
 * @param cause The `ProtectedSendError` failure, or the bare rejection
 * @param shieldNotice The shield's current notice (D3 `enable_e2ee`)
 */
function protectedSendErrorUi(
  cause: unknown,
  shieldNotice: ProtectedNoticeKind,
): ProtectedErrorUi {
  if (
    isErrorClass(
      cause,
      ProtectedChannelUnavailable,
      "ProtectedChannelUnavailable",
    )
  ) {
    return {
      kind: "notice",
      notice: shieldNotice === "enable_e2ee" ? "enable_e2ee" : "not_available",
      max: null,
      tag: "ProtectedChannelUnavailable",
    };
  }
  if (
    isErrorClass(
      cause,
      ProtectedFieldRefusedClient,
      "ProtectedFieldRefusedClient",
    )
  ) {
    // Files are handled by `isFilesRefusal`; any other refused field is a
    // client defect (D10): this composer never sends one
    console.error("[protected] send refused a field", {
      field: (cause as { field?: unknown }).field,
    });
    return protectedNoticeForError(
      { type: "ProtectedFieldRefused" },
      { op: "send" },
    );
  }
  return protectedNoticeForError(cause, { op: "send" });
}

/**
 * Plan D17 answer for a failed D15 owner-change review. Native `declined`
 * (the user cancelled) maps to `none`, which shows nothing.
 * @param error Rejection from `confirmOwnerChange`
 * @param shieldNotice The shield's current notice (D3 `enable_e2ee`)
 */
function protectedOwnerErrorUi(
  error: unknown,
  shieldNotice: ProtectedNoticeKind,
): ProtectedErrorUi {
  if (
    isErrorClass(
      error,
      ProtectedChannelUnavailable,
      "ProtectedChannelUnavailable",
    )
  ) {
    return protectedSendErrorUi(error, shieldNotice);
  }
  return protectedNoticeForError(error, { op: "owner" });
}

/**
 * Whether the D15 "Review owner change" button may show. The SAME condition
 * as the header pill (C3 `pillOwnerChangeReviewable`): native holds a
 * pending signer of the SAME user (`same_user: true`) AND the change is
 * pending (the manager parked it, or the pin status is `changed`). A
 * different user is final in S1, and an unknown signer gets no button.
 * @param view The manager's channel view
 */
function ownerChangeReviewable(
  view: ProtectedChannelView | null | undefined,
): boolean {
  const pin = view?.native?.owner_pin ?? null;
  if (!pin || pin.pending_signer?.same_user !== true) return false;
  return view?.ownerChangePending === true || pin.status === "changed";
}

/**
 * Composer reply preview on a protected channel (plan D22, D25): the
 * target's DECRYPTED text from the bridge view, its marker, or the pending
 * line; never the SDK row's server text. No mention toggle: the encrypted
 * send cannot carry a reply mention yet, and mentions are stripped.
 * @param props Reply target and dismiss handler
 */
function ProtectedReplyPreview(props: {
  messageId: string;
  message?: Message;
  dismiss: () => void;
}) {
  const { t } = useLingui();
  const view = useProtectedMessage(() => props.messageId);

  const text = () => {
    const v = view();
    if (!v || v.status === "pending") return messageCopy.pending();
    if (v.status === "marker") return markerCopy(v.kind);
    const flat = v.text.replace(/\n/g, " ");
    return flat.length > 128 ? flat.slice(0, 128) + "..." : flat;
  };

  return (
    <ProtectedReplyBase data-protected-reply={view()?.status ?? "pending"}>
      <ProtectedReplyLabel>{t`Replying to`}</ProtectedReplyLabel>
      <ProtectedReplyBody>
        <Show
          when={props.message?.author?.relationship !== "Blocked"}
          fallback={t`Blocked User`}
        >
          <Show when={props.message?.username}>
            {(name) => <ProtectedReplyAuthor>{name()}</ProtectedReplyAuthor>}
          </Show>
          <ProtectedReplyText>{text()}</ProtectedReplyText>
        </Show>
      </ProtectedReplyBody>
      <ProtectedReplyDismiss onClick={props.dismiss}>
        <Symbol size={16} fill>
          cancel
        </Symbol>
      </ProtectedReplyDismiss>
    </ProtectedReplyBase>
  );
}

const ProtectedReplyBase = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    fontSize: "0.8em",
    userSelect: "none",
    marginBlockEnd: "var(--gap-md)",
    padding: "var(--gap-md) var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-primary-container)",
    color: "var(--md-sys-color-on-primary-container)",
  },
});

const ProtectedReplyLabel = styled("span", {
  base: {
    flexShrink: 0,
  },
});

const ProtectedReplyBody = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
  },
});

const ProtectedReplyAuthor = styled("span", {
  base: {
    flexShrink: 0,
    fontWeight: "600",
  },
});

const ProtectedReplyText = styled("span", {
  base: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});

const ProtectedReplyDismiss = styled("a", {
  base: {
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
    "&:hover": {
      filter: "brightness(1.2)",
    },
  },
});

/**
 * "Review owner change" in the unverified banner (D15)
 */
const ProtectedBannerAction = styled("button", {
  base: {
    marginInlineStart: "auto",
    flexShrink: 0,
    padding: "2px 8px",
    borderRadius: "var(--borderRadius-md)",
    border: "1px solid currentColor",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
    "&:disabled": {
      opacity: 0.6,
      cursor: "default",
    },
  },
});

/**
 * Loud banner above the composer while a protected channel is unverified
 * (design 9.1). Text tint per the shield hue (plan D14).
 */
const ProtectedBanner = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "4px 12px",
    fontSize: "0.75rem",
    fontWeight: "600",
    color:
      "color-mix(in srgb, var(--sloga-protected-alert) 70%, var(--md-sys-color-on-surface))",
  },
});

/**
 * The faint static shield where the attach button sits on other channels
 */
const ProtectedComposerShield = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    minHeight: "40px",
    fontSize: "20px",
    opacity: 0.6,
  },
});

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
 * Status line for game lookups (searching, no results, refused, failed)
 */
const LookupNotice = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "4px 12px",
    fontSize: "0.75rem",
    fontWeight: "600",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * Composer encryption indicator. Green lock for an encrypted conversation;
 * amber warning (clickable) when a peer identity change is blocking sends,
 * or when a group's sends wait on a plaintext confirmation.
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
    // group sends wait on a plaintext confirmation: amber, clickable
    "&[data-mode='unconfirmed']": {
      color: "#FF8A00",
      cursor: "pointer",
    },
  },
});

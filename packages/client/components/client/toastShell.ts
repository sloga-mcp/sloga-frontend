/**
 * The main window's half of the desktop shells' Sloga toast: what it asks the
 * shell to draw, and what it does with a reply typed into it. The Windows
 * (Tauri) shell and the Electron shell (Linux X11, macOS) take the same toast
 * through different bridges; everything here goes through `toastHost`.
 *
 * The toast window is a separate, unprivileged page. It never learns which
 * channel a toast belongs to; it only hands back the id this window minted, so
 * the channel a reply goes to is always the one recorded here at show time.
 * Everything that made the reply box appear is checked again when the reply
 * arrives, because the toast can sit on screen while a share starts, a block
 * lands or the setting changes.
 */
import { useLingui } from "@lingui-solid/solid/macro";
import { ulid } from "ulid";

import { tauriInvoke } from "@revolt/common";
import { useNavigate } from "@revolt/routing";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { streamerModeActive } from "@revolt/state/streamer";

import { useClient } from ".";
import { DM_PREVIEW_DEFAULT } from "./notificationPreviewPolicy";
import {
  type ReplyError,
  type ToastEntry,
  type ToastPayload,
  type ToastRequest,
  type ToastSupport,
  type ToastSurface,
  AVATAR_FETCH_TIMEOUT_MS,
  avatarDataUrl,
  capToastStrings,
  entryForSession,
  envelopeOk,
  MAX_AVATAR_DATA_URL_LENGTH,
  REPLY_TIMEOUT_MS,
  replyAllowed,
  replyErrorFor,
  showToast,
  toastSupportFor,
  withReplyTimeout,
} from "./toastPolicy";

export type { ToastRequest, ToastSupport, ToastSurface } from "./toastPolicy";

/** The Electron shell's toast bridge, when this window has one. */
function electronToast() {
  if (typeof window === "undefined") return undefined;
  return window.slogaShell?.toast;
}

/**
 * Which Sloga toast this window's shell can draw: `protected` (Windows, kept
 * out of screen capture), `unprotected` (Electron on Linux X11 or macOS), or
 * null for none, when notifications go to the OS.
 */
export function toastSupported(): ToastSupport | null {
  let electronCapability: unknown;
  try {
    electronCapability = electronToast()?.capability?.();
  } catch {
    // A bridge that throws has not said "window".
    electronCapability = undefined;
  }
  return toastSupportFor({
    tauri: !!tauriInvoke(),
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    electronShell: typeof window !== "undefined" && "slogaShell" in window,
    electronCapability,
  });
}

/** One shell's toast bridge. Only `show` answers; the rest are best effort. */
interface ToastHost {
  /** @returns false when the shell refused it */
  show(payload: ToastPayload): Promise<boolean>;
  /** Take down the toasts for a conversation, or every one for null. */
  clear(channelId: string | null): Promise<void>;
  /** Tell the toast how its reply went; null error is success. */
  replyResult(id: string, error: string | null): Promise<void>;
  /** The OS's own entries for a conversation (Action Center on Windows). */
  clearNotifications(channelId: string): void;
}

/**
 * The bridge for the toast `toastSupported` finds, or undefined. Given a
 * surface, only that surface's bridge: the toast's text was decided for it,
 * so a shell that now answers differently draws nothing rather than draw that
 * text where it was never allowed.
 */
function toastHost(surface?: ToastSurface): ToastHost | undefined {
  const support = toastSupported();
  const invoke = tauriInvoke();
  if (
    support === "protected" &&
    invoke &&
    (surface === undefined || surface === "sloga_toast")
  ) {
    return {
      show: (payload) =>
        invoke("toast_show", { payload }).then(
          () => true,
          () => false,
        ),
      clear: (channelId) =>
        invoke<void>("toast_clear", { channelId }).catch(() => {}),
      replyResult: (id, error) =>
        invoke<void>("toast_reply_result", {
          id,
          ok: error === null,
          error,
        }).catch(() => {}),
      clearNotifications: (channelId) => {
        invoke("clear_channel_notifications", { channelId }).catch(() => {});
      },
    };
  }

  const toast = electronToast();
  if (
    support === "unprotected" &&
    toast &&
    (surface === undefined || surface === "sloga_toast_unprotected")
  ) {
    // The bridge answers show with an envelope and swallows its own errors
    // on the rest; a synchronous throw (a mangled argument) is caught here
    // so it cannot escape a best-effort call.
    return {
      show: (payload) =>
        Promise.resolve()
          .then(() => toast.show(payload))
          .then(envelopeOk, () => false),
      clear: async (channelId) => {
        try {
          if (channelId === null) toast.clear();
          else toast.clear(channelId);
        } catch {
          // best effort
        }
      },
      replyResult: async (id, error) => {
        try {
          toast.replyResult(id, error === null, error ?? undefined);
        } catch {
          // best effort
        }
      },
      // Electron keeps no OS entries of its own for these.
      clearNotifications: () => {},
    };
  }

  return undefined;
}

/**
 * Every toast this window has up, by the id it minted. Module-level so
 * NotificationsWorker (which shows them) and ShellBridgeWorker (which receives
 * the replies) share one.
 */
const toasts = new Map<string, ToastEntry>();

/**
 * Toasts whose reply is being sent, so a repeated submit cannot send twice.
 * An id stays here until its send settles, even after the toast was told the
 * send timed out: the message may still go out.
 */
const sending = new Set<string>();

/**
 * Forget every toast and take down whatever the shell still shows. For a
 * session ending, and for a fresh page: the map does not survive a reload,
 * but the shell's toasts do, and a reply to one would find nothing here.
 */
export function clearAllToasts(): void {
  toasts.clear();
  void toastHost()?.clear(null);
}

/**
 * Fetch an avatar for the toast. Anything slow, large or unexpected is null:
 * the toast is worth more on time than with a picture.
 */
async function fetchAvatar(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVATAR_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("Content-Length"));
    if (declared > MAX_AVATAR_DATA_URL_LENGTH) return null;
    const blob = await response.blob();
    if (blob.size > MAX_AVATAR_DATA_URL_LENGTH) return null;
    return avatarDataUrl(blob.type, new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Show toasts in the shell's toast window and act on what comes back from it.
 * Must be called during component setup.
 */
export function useToastShell(): {
  show(request: ToastRequest, surface: ToastSurface): Promise<boolean>;
  handleReply(toastId: string, text: string): Promise<void>;
  handleOpen(toastId: string): void;
  clearChannel(channelId: string): void;
} {
  const state = useState();
  const client = useClient();
  const navigate = useNavigate();
  const voice = useVoice();
  const { t } = useLingui();

  /**
   * Show one toast on the surface its content was decided for.
   * @returns false when the shell refused it (Focus Assist, a fullscreen app,
   * an older shell) or no longer draws that surface, so the caller can hand
   * it to the OS instead; also when the account changed while it went up
   */
  async function show(
    request: ToastRequest,
    surface: ToastSurface,
  ): Promise<boolean> {
    const host = toastHost(surface);
    if (!host) return false;

    return showToast(toasts, request, {
      currentUserId: () => client()?.user?.id,
      mintId: () => ulid(),
      fetchAvatar,
      show: (payload) => host.show(payload),
      clear: (channelId) => host.clear(channelId),
      // Capped here: the shell refuses a toast whose strings run long, and a
      // long translation must not cost the toast.
      strings: () =>
        capToastStrings({
          replyPlaceholder: t`Reply…`,
          send: t`Send`,
          dismiss: t`Dismiss`,
          sending: t`Sending…`,
          couldNotSend: t`Couldn't send. Open Sloga to retry.`,
        }),
    });
  }

  /** Tell the toast how its reply went. The shell may be gone; that is fine. */
  function replyResult(id: string, error: string | null): Promise<void> {
    return toastHost()?.replyResult(id, error) ?? Promise.resolve();
  }

  /** What a toast says about a reply that did not go, in the user's language. */
  function replyErrorText(error: ReplyError): string {
    switch (error) {
      case "openToReply":
        return t`Open Sloga to reply`;
      case "review":
        return t`Open the conversation to review`;
      case "slowDown":
        return t`Slow down — try again in a moment`;
      case "couldNotSend":
        return t`Couldn't send. Open Sloga to retry.`;
      case "notConfirmed":
        // Not "failed": the message may still arrive.
        return t`Couldn't confirm it sent. Open Sloga to check.`;
    }
  }

  /**
   * Start sending a reply typed into a toast, if everything that put the
   * reply box up still holds.
   * @returns The send, or null when the reply may not go from the toast
   */
  function startReply(
    entry: ToastEntry,
    text: string,
  ): Promise<unknown> | null {
    const channel = client()?.channels.get(entry.channelId);
    const allowed =
      !!channel &&
      text.trim().length > 0 &&
      replyAllowed({
        allowReply: entry.allowReply,
        channelType: channel.type,
        mode:
          state.settings.getValue("notifications:dm_preview") ??
          DM_PREVIEW_DEFAULT,
        override: state.settings.getValue(
          "notifications:dm_preview_overrides",
        )?.[entry.channelId],
        screensharing: voice.screenshare(),
        streamerMode: streamerModeActive(state.settings),
        // A pending offer counts, as it does for the toast itself.
        rcActive: !!voice.remoteControl.sharing(),
        canSendMessage: channel.havePermission("SendMessage"),
        recipientRelationship: channel.recipient?.relationship,
      });
    if (!channel || !allowed) return null;

    // Straight to the channel, never through Draft: the composer's draft for
    // this conversation is the user's and must not be sent or cleared. The
    // E2EE choke point inside sendMessage still decides how it goes out.
    // A fresh idempotency key per attempt: the server remembers a key even
    // when the send then fails, so reusing one would refuse a real retry.
    return channel.sendMessage({ content: text }, ulid());
  }

  /**
   * The reply went. Only the card replied to goes (the ok result removes it
   * in the shell). Other cards from this conversation stay: the user may be
   * typing in one, and clearing them would empty the stack and hand the
   * foreground back mid-sentence. Action Center can go now.
   */
  async function replied(toastId: string, channelId: string): Promise<void> {
    // Forgotten before anything is awaited, so a retry from the card while
    // the result is on its way finds nothing to send.
    toasts.delete(toastId);
    await replyResult(toastId, null);
    toastHost()?.clearNotifications(channelId);
  }

  /**
   * A reply typed into one of our toasts. The channel comes from our own
   * record, never from anything the toast sent.
   *
   * The toast hears back within REPLY_TIMEOUT_MS. A send still going then is
   * not abandoned: its id stays in `sending` until it settles, so a retry
   * cannot post the message twice (each attempt carries a fresh idempotency
   * key, so the server would take both). If it lands after all, the toast is
   * told nothing more: an ok result takes the card down in the shell, and the
   * user may be typing in it again. The card keeps its "couldn't confirm"
   * until it is closed, and this window forgets it, so a retry from it is
   * "Open Sloga to reply" and sends nothing.
   */
  async function handleReply(toastId: string, text: string): Promise<void> {
    // Another submit while a send for this toast has not settled, even one the
    // toast was already told timed out: answer it, and send nothing.
    if (sending.has(toastId)) {
      await replyResult(toastId, replyErrorText("notConfirmed"));
      return;
    }

    const entry = entryForSession(toasts, toastId, client()?.user?.id);
    if (!entry) {
      // Unknown to this page (it reloaded, or the toast was evicted) or shown
      // to another account: answer anyway, or the card sits on "Sending…".
      await replyResult(toastId, replyErrorText("openToReply"));
      return;
    }

    let attempt: Promise<unknown> | null;
    try {
      attempt = startReply(entry, text);
    } catch {
      // A check that threw has not confirmed anything.
      attempt = null;
    }
    if (!attempt) {
      await replyResult(toastId, replyErrorText("openToReply"));
      return;
    }

    sending.add(toastId);
    const outcome = withReplyTimeout(attempt, REPLY_TIMEOUT_MS);
    // Out of `sending` when the send itself settles, never on the timeout.
    attempt.then(
      () => {
        // A success in time is answered below, which forgets the toast first.
        // One after the timeout sends no result (see above); the toast is
        // forgotten here, before the id leaves `sending`, so no retry ever
        // finds it sendable. Only Action Center goes, as for a success in
        // time; the toasts themselves stay.
        void outcome.then((settled) => {
          if (settled.kind === "timeout") {
            toasts.delete(toastId);
            toastHost()?.clearNotifications(entry.channelId);
          }
          sending.delete(toastId);
        });
      },
      () => {
        // A failure after the timeout says nothing more: the toast already
        // has its error.
        sending.delete(toastId);
      },
    );

    const error = replyErrorFor(await outcome);
    if (error === null) await replied(toastId, entry.channelId);
    else await replyResult(toastId, replyErrorText(error));
  }

  /** A click on one of our toasts. The shell has already raised the window. */
  function handleOpen(toastId: string): void {
    const entry = entryForSession(toasts, toastId, client()?.user?.id);
    if (!entry) return;
    toasts.delete(toastId);
    navigate(
      client()?.channels.get(entry.channelId)?.path ??
        `/channel/${entry.channelId}`,
    );
  }

  /**
   * Retire every notification for a conversation: our toasts for it and the
   * entries the OS keeps in Action Center.
   */
  function clearChannel(channelId: string): void {
    for (const [id, entry] of toasts) {
      if (entry.channelId === channelId) toasts.delete(id);
    }
    const host = toastHost();
    if (!host) return;
    void host.clear(channelId);
    host.clearNotifications(channelId);
  }

  return { show, handleReply, handleOpen, clearChannel };
}

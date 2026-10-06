/**
 * The rules behind the desktop shells' Sloga toast, kept free of Solid,
 * lingui and the client so `node --test` can load them: which shell can draw
 * one, who may still reply, how long a reply may take and what a failed one
 * tells the user, which toast belongs to whom, and what the shell will accept.
 * toastShell.ts wires them to the running app.
 */
import {
  type DmPreviewMode,
  type NotificationSurface,
  decidePreview,
} from "./notificationPreviewPolicy.ts";

/**
 * Toast entries kept for replies, newest last. An entry is metadata only (no
 * message text), and the toast page dismisses older cards itself without
 * telling us, keeping one the user is typing in or sending from. So this
 * reaches far past the three cards on screen: a kept card must outlive many
 * newer toasts. A reply to a card older than this gets "Open Sloga to reply".
 */
export const MAX_TOASTS = 32;

/** The shell drops an avatar data URL longer than this. */
export const MAX_AVATAR_DATA_URL_LENGTH = 300_000;

/** Past this the toast goes up without an avatar rather than wait for one. */
export const AVATAR_FETCH_TIMEOUT_MS = 1_500;

/** The shell refuses a toast whose title or sender is longer than this. */
export const MAX_TOAST_NAME_LENGTH = 200;

/** The shell refuses a toast whose body is longer than this. */
export const MAX_TOAST_BODY_LENGTH = 4_000;

/** The image types the shell accepts in an avatar data URL. */
const AVATAR_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/**
 * The Sloga toast a shell can draw. `protected` is the Windows shell's, kept
 * out of screen capture; `unprotected` is the Electron shell's (Linux X11,
 * macOS), which nothing there can keep out of a capture.
 */
export type ToastSupport = "protected" | "unprotected";

/** What decides which toast, if any, this window's shell can draw. */
export interface ToastShellFacts {
  /** A Tauri window allowed to call the shell (`tauriInvoke()`). */
  tauri: boolean;
  userAgent: string;
  /**
   * `slogaShell` is on the window: the Electron preload's bridge, with or
   * without a toast on it. The marker of an Electron window, as it is for
   * the OS notification surface.
   */
  electronShell: boolean;
  /**
   * What the Electron shell's `slogaShell.toast.capability()` answered;
   * undefined when there is no such bridge, or it threw.
   */
  electronCapability: unknown;
}

/**
 * Which toast this window's shell can draw, or null for none. An older
 * Windows shell has no toast commands; its `toast_show` rejects and the
 * caller falls back to the OS toast. On Electron only an exact "window"
 * answer counts: a Wayland session, an older shell and anything malformed all
 * keep the OS notification.
 *
 * Any sign of Electron (the bridge, or an answer from it) rules out the
 * protected toast, whatever else the window carries: the protected surface
 * may show decrypted text, and Electron's toast is in every screen capture.
 */
export function toastSupportFor(facts: ToastShellFacts): ToastSupport | null {
  if (facts.electronShell || facts.electronCapability !== undefined) {
    const mode = (facts.electronCapability as { mode?: unknown } | null)?.mode;
    return mode === "window" ? "unprotected" : null;
  }
  return facts.tauri && /Windows/i.test(facts.userAgent) ? "protected" : null;
}

/** The surfaces our own toast window goes up on. */
export type ToastSurface = Extract<
  NotificationSurface,
  "sloga_toast" | "sloga_toast_unprotected"
>;

/**
 * The surface a Sloga toast for this conversation goes up on, or null when
 * it goes to the OS. Only direct messages and group chats, which is what the
 * setting promises; server channels keep the OS notification. Only the
 * protected toast is `sloga_toast`, the surface that may show an encrypted
 * message's text, and the toast shell is then asked for exactly this surface.
 */
export function toastSurfaceFor(
  channelType: string,
  support: ToastSupport | null,
): ToastSurface | null {
  if (channelType !== "DirectMessage" && channelType !== "Group") return null;
  if (support === "protected") return "sloga_toast";
  if (support === "unprotected") return "sloga_toast_unprotected";
  return null;
}

/**
 * Whether the Electron shell took a toast. Its bridge answers with an
 * envelope rather than rejecting (contextBridge mangles a rejection), so only
 * `{ ok: true }` counts; "suppressed", "unsupported", "invalid", "not_ready"
 * and anything malformed are a refusal.
 */
export function envelopeOk(envelope: unknown): boolean {
  return (envelope as { ok?: unknown } | null)?.ok === true;
}

export interface ToastEntry {
  channelId: string;
  messageId: string;
  allowReply: boolean;
  /** Who was signed in when the toast went up. */
  userId: string;
}

/**
 * Cut `value` to at most `max` UTF-16 units, marking the cut with an ellipsis
 * so a shortened name does not pass for the whole one. Never splits a
 * surrogate pair: the shell counts characters, and half a pair is not one.
 */
export function truncateForToast(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

/**
 * The entry for a toast id, if it is still this session's. One shown to
 * another account (a sign-out the page outlived) is dropped and never
 * returned, so it can neither send nor navigate as whoever is signed in now.
 */
export function entryForSession(
  toasts: Map<string, ToastEntry>,
  toastId: string,
  userId: string | undefined,
): ToastEntry | undefined {
  const entry = toasts.get(toastId);
  if (!entry) return undefined;
  if (userId === undefined || entry.userId !== userId) {
    toasts.delete(toastId);
    return undefined;
  }
  return entry;
}

/**
 * Drop the oldest entries past `max`. A `Map` iterates in insertion order, so
 * the first keys are the oldest.
 * @returns The ids dropped
 */
export function evictOldest(
  toasts: Map<string, ToastEntry>,
  max: number = MAX_TOASTS,
): string[] {
  const dropped: string[] = [];
  for (const id of toasts.keys()) {
    if (toasts.size <= max) break;
    toasts.delete(id);
    dropped.push(id);
  }
  return dropped;
}

/** What a reply is checked against when it arrives. */
export interface ReplyFacts {
  /** Whether the toast was shown with a reply box. */
  allowReply: boolean;
  /** The stoat.js `channel.type`, or undefined when the channel is gone. */
  channelType: string | undefined;
  mode: DmPreviewMode;
  override: DmPreviewMode | undefined;
  screensharing: boolean;
  streamerMode: boolean;
  rcActive: boolean;
  /** `channel.havePermission("SendMessage")`. */
  canSendMessage: boolean;
  /**
   * The other user's `relationship` in a direct message; undefined when they
   * are not in the cache (and for groups, which have no single recipient).
   */
  recipientRelationship: string | undefined;
}

/**
 * Whether a reply that just arrived may still be sent. The same policy that
 * offered the reply box is asked again, so "Show message + quick reply" being
 * turned off, a share starting or Streamer Mode coming on all close it.
 * Anything this cannot confirm counts as no.
 */
export function replyAllowed(facts: ReplyFacts): boolean {
  if (!facts.allowReply || facts.channelType === undefined) return false;

  const decision = decidePreview({
    mode: facts.mode,
    override: facts.override,
    // On this surface only the content rules read this, never the reply rule;
    // true is the value that can only take something away. The unprotected
    // toast's own E2EE rule (no reply) was applied when it went up and is in
    // `allowReply`.
    isE2EE: true,
    surface: "sloga_toast",
    screensharing: facts.screensharing,
    streamerMode: facts.streamerMode,
    rcActive: facts.rcActive,
    channelType: facts.channelType,
  });
  if (!decision.allowReply) return false;

  if (!facts.canSendMessage) return false;

  if (facts.channelType === "DirectMessage") {
    // Either side's block stops the send, and a recipient we cannot see is a
    // block we cannot rule out.
    const relationship = facts.recipientRelationship;
    if (
      relationship === undefined ||
      relationship === "Blocked" ||
      relationship === "BlockedOther"
    )
      return false;
  }

  return true;
}

export type SendFailure = "e2ee" | "ratelimited" | "other";

/**
 * Sort a rejected `channel.sendMessage` into what the toast can tell the
 * user. stoat-api throws the raw response body as a string and drops the
 * status, so a rate limit is recognized from what its body says: the limiter's
 * `retry_after`, the `InSlowmode` error, or Rocket's own 429 page.
 */
export function classifySendError(error: unknown): SendFailure {
  // By name, as Draft does: an `instanceof` would pull e2ee.ts in here.
  if ((error as { name?: unknown } | null)?.name === "E2EESendError")
    return "e2ee";

  if ((error as { status?: unknown } | null)?.status === 429)
    return "ratelimited";

  let body: unknown = error;
  if (typeof error === "string") {
    try {
      body = JSON.parse(error);
    } catch {
      return /\b429\b/.test(error) && /too many requests/i.test(error)
        ? "ratelimited"
        : "other";
    }
  }

  if (typeof body === "object" && body !== null) {
    const record = body as {
      type?: unknown;
      retry_after?: unknown;
      error?: { code?: unknown };
    };
    if (
      record.type === "InSlowmode" ||
      typeof record.retry_after === "number" ||
      record.error?.code === 429
    )
      return "ratelimited";
  }

  return "other";
}

/** How long a reply from a toast may take before the card stops waiting. */
export const REPLY_TIMEOUT_MS = 30_000;

/** How a reply's send ended, as far as the toast is concerned. */
export type ReplyOutcome =
  | { kind: "sent" }
  | { kind: "failed"; error: unknown }
  | { kind: "timeout" };

/**
 * Wait for a reply's send, but no longer than `ms`. Never rejects. A timeout
 * is not a failure: the send may still go through, so the caller must not
 * offer a second one while this one is unsettled. A rejection after the
 * timeout is caught here and goes nowhere.
 */
export function withReplyTimeout<T>(
  attempt: Promise<T>,
  ms: number,
  timers?: { set: typeof setTimeout; clear: typeof clearTimeout },
): Promise<ReplyOutcome> {
  // Called detached: the browser's own timers throw on any other `this`.
  const set = timers?.set ?? setTimeout;
  const clear = timers?.clear ?? clearTimeout;
  return new Promise<ReplyOutcome>((resolve) => {
    const timer = set(() => resolve({ kind: "timeout" }), ms);
    attempt.then(
      () => {
        clear(timer);
        resolve({ kind: "sent" });
      },
      (error: unknown) => {
        clear(timer);
        resolve({ kind: "failed", error });
      },
    );
  });
}

/**
 * Which message the toast shows for a reply. `openToReply` is the caller's,
 * for a reply that was never sent; a send's own outcome never maps to it.
 */
export type ReplyError =
  | "openToReply"
  | "review"
  | "slowDown"
  | "couldNotSend"
  | "notConfirmed";

/**
 * The message for a reply's outcome, or null when it was sent. A timeout is
 * "not confirmed" rather than failed, since the message may still arrive, and
 * anything unrecognized counts as that too, never as sent.
 */
export function replyErrorFor(outcome: ReplyOutcome): ReplyError | null {
  if (outcome.kind === "sent") return null;
  if (outcome.kind === "failed") {
    switch (classifySendError(outcome.error)) {
      case "e2ee":
        return "review";
      case "ratelimited":
        return "slowDown";
      default:
        return "couldNotSend";
    }
  }
  return "notConfirmed";
}

/** Standard base64 of `bytes`, in chunks so a large image cannot blow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/**
 * The avatar as a data URL the shell will keep, or null. The type is reduced
 * to its lowercase essence because the shell matches the prefix exactly.
 */
export function avatarDataUrl(
  contentType: string,
  bytes: Uint8Array,
): string | null {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!AVATAR_TYPES.includes(type) || bytes.length === 0) return null;
  // Base64 only grows the payload, so this skips encoding a hopeless one.
  if (bytes.length > MAX_AVATAR_DATA_URL_LENGTH) return null;
  const url = `data:${type};base64,${bytesToBase64(bytes)}`;
  return url.length <= MAX_AVATAR_DATA_URL_LENGTH ? url : null;
}

export interface ToastRequest {
  channelId: string;
  messageId: string;
  title: string;
  sender: string;
  body: string | null;
  avatarUrl: string | null;
  allowReply: boolean;
}

/** The toast's own controls, already in the user's language. */
export interface ToastStrings {
  replyPlaceholder: string;
  send: string;
  dismiss: string;
  sending: string;
  /** What the card shows for a failed reply when nothing better is known. */
  couldNotSend: string;
}

/**
 * The toast's strings cut to what the shell accepts: it refuses the whole
 * toast over one string longer than `max`, and a long translation must not
 * cost it. Built key by key, so nothing but these keys reaches the shell
 * (Electron refuses any other).
 */
export function capToastStrings(s: ToastStrings, max = 100): ToastStrings {
  return {
    replyPlaceholder: truncateForToast(s.replyPlaceholder, max),
    send: truncateForToast(s.send, max),
    dismiss: truncateForToast(s.dismiss, max),
    sending: truncateForToast(s.sending, max),
    couldNotSend: truncateForToast(s.couldNotSend, max),
  };
}

/** One toast as the shell takes it; both shells validate the same shape. */
export interface ToastPayload {
  id: string;
  channelId: string;
  title: string;
  sender: string;
  body: string | null;
  avatarDataUrl: string | null;
  allowReply: boolean;
  strings: ToastStrings;
}

/** What showing a toast needs from the running app. */
export interface ToastShowDeps {
  /** Who is signed in right now; undefined once nobody is. */
  currentUserId(): string | undefined;
  /** A fresh toast id. */
  mintId(): string;
  fetchAvatar(url: string): Promise<string | null>;
  /** Hand the toast to the shell; false (or a rejection) when it refused. */
  show(payload: ToastPayload): Promise<boolean>;
  /** Take down every toast the shell has up for a conversation. */
  clear(channelId: string): Promise<unknown>;
  strings(): ToastStrings;
}

/**
 * Hand one toast to the shell and record it in `toasts`.
 *
 * The avatar fetch and the shell's wait for its toast page can each take
 * seconds, and the user can sign out in that time. The account is checked
 * again after each, so one account's message (decrypted, possibly) never
 * lands on the login screen or in front of the next account.
 * @returns false when it was not shown, so the caller can hand it to the OS
 */
export async function showToast(
  toasts: Map<string, ToastEntry>,
  request: ToastRequest,
  deps: ToastShowDeps,
): Promise<boolean> {
  const userId = deps.currentUserId();
  if (!userId) return false;

  const id = deps.mintId();
  const avatar = request.avatarUrl
    ? await deps.fetchAvatar(request.avatarUrl)
    : null;

  if (deps.currentUserId() !== userId) return false;

  // Recorded before the shell has it: a reply can arrive before the show
  // resolves.
  toasts.set(id, {
    channelId: request.channelId,
    messageId: request.messageId,
    allowReply: request.allowReply,
    userId,
  });

  let shown: boolean;
  try {
    shown = await deps.show({
      id,
      channelId: request.channelId,
      // Cut here rather than refused there: a long group or server name
      // would otherwise cost the toast.
      title: truncateForToast(request.title, MAX_TOAST_NAME_LENGTH),
      sender: truncateForToast(request.sender, MAX_TOAST_NAME_LENGTH),
      body:
        request.body === null
          ? null
          : truncateForToast(request.body, MAX_TOAST_BODY_LENGTH),
      avatarDataUrl: avatar,
      allowReply: request.allowReply,
      strings: deps.strings(),
    });
  } catch {
    shown = false;
  }
  if (!shown) {
    toasts.delete(id);
    return false;
  }

  if (deps.currentUserId() !== userId) {
    // It went up after the session ended: take it straight down again.
    toasts.delete(id);
    deps.clear(request.channelId).catch(() => {});
    return false;
  }

  // Only now: a refused toast must not cost an older one its entry here.
  evictOldest(toasts);
  return true;
}

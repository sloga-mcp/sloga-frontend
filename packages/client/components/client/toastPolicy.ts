/**
 * The rules behind the Windows shell's Sloga toast, kept free of Solid,
 * lingui and the client so `node --test` can load them: who may still reply,
 * what a failed send tells the user, which toast belongs to whom, and what the
 * shell will accept. toastShell.ts wires them to the running app.
 */
import {
  type DmPreviewMode,
  decidePreview,
} from "./notificationPreviewPolicy.ts";

/** Toasts the shell stacks at once; it drops the oldest past this, as we do. */
export const MAX_TOASTS = 3;

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
    // Only the content rules read this, never the reply rule; true is the
    // value that can only take something away.
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
}

/** What showing a toast needs from the running app. */
export interface ToastShowDeps {
  /** Who is signed in right now; undefined once nobody is. */
  currentUserId(): string | undefined;
  /** A fresh toast id. */
  mintId(): string;
  fetchAvatar(url: string): Promise<string | null>;
  invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
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

  // Recorded before the shell has it: a reply can arrive before
  // `toast_show` resolves.
  toasts.set(id, {
    channelId: request.channelId,
    messageId: request.messageId,
    allowReply: request.allowReply,
    userId,
  });

  try {
    await deps.invoke("toast_show", {
      payload: {
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
      },
    });
  } catch {
    toasts.delete(id);
    return false;
  }

  if (deps.currentUserId() !== userId) {
    // It went up after the session ended: take it straight down again.
    toasts.delete(id);
    deps
      .invoke("toast_clear", { channelId: request.channelId })
      .catch(() => {});
    return false;
  }

  // Only now: the shell drops its oldest when it takes this one, and a
  // refused toast must not cost an older one its entry here.
  evictOldest(toasts);
  return true;
}

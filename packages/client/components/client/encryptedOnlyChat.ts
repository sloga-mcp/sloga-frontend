/**
 * Encrypted-only chats: what the chat page shows. Pure, so `node --test`
 * loads it (`encryptedOnlyChat.test.ts`): every fact is passed in, and the
 * decisions come from the policy (`encryptedOnlyPolicy.ts`), never from a
 * second copy of its rules.
 *
 * - `chatPanelFor`: the whole chat is replaced by a panel on the website or
 *   on an app where encryption is not set up, for an account whose latch is
 *   on.
 * - `plainGroupUnderLatch`: a group that is not encrypted, for an account
 *   whose latch is on. It is read-only and labelled "Not encrypted".
 * - `notEncryptedRow`: an unencrypted message newer than the latch carries
 *   the "Not encrypted" label.
 * - `refusalErrorOf` and `draftRowActions`: a failed outbox entry, read back
 *   for its words and its menu.
 */
import {
  FIRST_FILE_NEEDS_TEXT_SEND_ERROR,
  canRetrySendAsIs,
  encryptionRequiredSendError,
} from "../state/stores/draftSendError.ts";

import { ENCRYPTED_ONLY_BLOCKED_ERROR_NAME } from "./apiErrorType.ts";
import {
  type PlainWriteInput,
  decidePlainWrite,
  reasonFor,
} from "./encryptedOnlyPolicy.ts";

/** Why the whole chat is replaced by a panel. */
export type ChatPanel = "open-app" | "setup";

/**
 * Whether the whole chat is replaced by a panel, and why.
 * @param input The policy input for the chat
 * @param statusKnown This device's encryption status has been read (always
 * true on the website). Until then an app reads as not set up, so a device
 * that is ready would flash the panel; the chat is shown instead, and its
 * sends stay refused by the guard.
 * @returns The panel, or `null` to show the chat
 */
export function chatPanelFor(
  input: PlainWriteInput,
  statusKnown: boolean,
): ChatPanel | null {
  if (input.channel !== "dm" && input.channel !== "group") return null;

  switch (decidePlainWrite(input)) {
    case "block-open-app":
      return "open-app";
    case "block-setup":
      return statusKnown ? "setup" : null;
    default:
      return null;
  }
}

/**
 * A group that is not encrypted, seen by an account whose latch is on: the
 * policy refuses a send there for the sender's own setting. A group that is
 * marked, remembered or sends encrypted is not one, and neither is any chat
 * on a device that cannot write at all (the panel covers that).
 * @param input The policy input for the chat
 * @returns Whether the group is read-only for this account
 */
export function plainGroupUnderLatch(input: PlainWriteInput): boolean {
  if (input.channel !== "group") return false;

  const decision = decidePlainWrite(input);
  return decision === "block-group" && reasonFor(decision, input) === "sender";
}

/** The facts about one message row. */
export type RowFacts = {
  /** When this device set the latch; `null` while the latch is off */
  latchedAt: number | null;
  /** The message is in a direct message or a group */
  conversation: boolean;
  /** This device decrypted the message */
  encrypted: boolean;
  /** A line the server wrote ("X was added"), not message content */
  system: boolean;
  /** When the message was sent, in milliseconds */
  createdAtMs: number;
};

/**
 * Whether a message row carries the "Not encrypted" label: under the latch,
 * an unencrypted message in a direct message or group, sent after the latch
 * was set. A time that cannot be read counts as newer.
 * @param row The facts
 * @returns Whether to label it
 */
export function notEncryptedRow(row: RowFacts): boolean {
  if (row.latchedAt === null || !row.conversation) return false;
  if (row.encrypted || row.system) return false;
  if (!Number.isFinite(row.createdAtMs)) return true;
  return row.createdAtMs >= row.latchedAt;
}

/**
 * A stored refusal marker as a value the app's error words read (`useError`
 * in `i18n/errors.ts`): the guard's error shape, which carries every side,
 * including the app's own `peer-changed`.
 * @param stored The outbox entry's `error`
 * @returns The value to translate, or `undefined` when the entry was not
 * refused for not being encrypted
 */
export function refusalErrorOf(
  stored: string | undefined,
): { name: string; reason: string } | undefined {
  const refusal = encryptionRequiredSendError(stored);
  if (!refusal) return undefined;
  return { name: ENCRYPTED_ONLY_BLOCKED_ERROR_NAME, reason: refusal.side };
}

/**
 * Which actions a failed outbox entry offers.
 * @param stored The entry's `error`
 * @returns `retry`: it may be sent again unchanged; `refused`: it was
 * refused before it could go out (not encrypted, or files waiting for a
 * text message), so removing it cancels a message nobody received
 */
export function draftRowActions(stored: string | undefined): {
  retry: boolean;
  refused: boolean;
} {
  return {
    retry: canRetrySendAsIs(stored),
    refused:
      stored === FIRST_FILE_NEEDS_TEXT_SEND_ERROR ||
      encryptionRequiredSendError(stored) !== undefined,
  };
}

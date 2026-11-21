/**
 * Encrypted-only chats in the composer: what it shows in place of the
 * editor when the policy (`encryptedOnlyPolicy.ts`) refuses a send here, and
 * which button it offers. Pure, so `node --test` loads it
 * (`encryptedOnlyComposer.test.ts`). `Composition.tsx` turns the notice into
 * words and runs the action.
 *
 * The block is a hint shown before anyone types. The send path decides for
 * real (the encryption bridge, the plain write guard, the server), so where
 * this device's cache cannot tell yet whether the next send goes out
 * encrypted, nothing is blocked here and the send path answers instead:
 * - the device status has not loaded (it would read as "not set up" and
 *   offer setup to someone who has it);
 * - this device can encrypt and the conversation's mode is unknown, or is
 *   one the send path handles itself (`blocked` asks to review the
 *   identity change, `unconfirmed` asks about the group);
 * - a direct message that is unencrypted so far, with a peer who has
 *   encryption on: the next text message is the one that encrypts it.
 *
 * A send refused for a peer who may have left Encrypted-only stays in the
 * outbox as a failed entry with its marker. `failedRowSend` and
 * `peerChangedKeys` read those entries for the row menu and the composer's
 * "Send anyway", so the offer outlives a channel switch and a reload.
 */
import type { PlainWriteKind } from "stoat.js";

import type { E2EESendMode } from "../../../../components/client/e2eeBadge.ts";
import {
  type BlockReason,
  type DeviceState,
  type PlainWriteInput,
  decideForKind,
  reasonFor,
} from "../../../../components/client/encryptedOnlyPolicy.ts";
import {
  PEER_CHANGED_SIDE,
  canRetrySendAsIs,
  encryptionRequiredSendError,
} from "../../../../components/state/stores/draftSendError.ts";

/** What this device's cache says about the conversation. */
export type ComposerView = {
  /** The bridge's send mode for the conversation; unset until primed */
  mode: E2EESendMode | undefined;
  /** This device's encryption status is known (always, without a bridge) */
  statusLoaded: boolean;
  /** The direct message peer has encryption on (the server's hint) */
  peerOptedIn: boolean;
};

/**
 * Which words the composer shows. The reasons, plus the existing-group case
 * (a group without the mark, refused for this account's own setting) and a
 * marked group this device can encrypt (`group-enable`, the words of the
 * "Turn on encryption" button it comes with).
 */
export type ComposerNotice =
  | Exclude<BlockReason, "sender">
  | "sender-dm"
  | "group-not-encrypted"
  | "group-enable";

/** The button offered with the notice. */
export type ComposerAction =
  /** Set up encryption on this device (the existing enable flow) */
  | "enable-device"
  /** Encrypt this group from this device (the existing group flow) */
  | "enable-group"
  /** Confirm a peer who may have left Encrypted-only, then send */
  | "send-anyway";

/** A refused send, as the composer shows it. */
export type ComposerBlock = {
  reason: BlockReason;
  notice: ComposerNotice;
  action: ComposerAction | null;
};

/**
 * Whether the next send from this device may go out encrypted, as far as
 * the cache can tell. See the top of this file.
 * @param input The policy facts
 * @param view The conversation as cached here
 * @returns True when the send path, not the composer, has to decide
 */
export function sendMayEncrypt(
  input: PlainWriteInput,
  view: ComposerView,
): boolean {
  if (input.device !== "ready") return false;

  switch (view.mode) {
    case undefined:
    case "encrypt":
    case "blocked":
    case "unconfirmed":
      return true;
    case "plaintext":
      return (
        input.channel === "dm" &&
        (view.peerOptedIn || input.peerFlag === "on" || input.peerRemembered)
      );
    case "peer_downgraded":
      return false;
    default: {
      const exhaustive: never = view.mode;
      void exhaustive;
      return false;
    }
  }
}

/**
 * The words for a refusal reason in this kind of conversation.
 * @param reason Why
 * @param channel Where
 * @param action The button shown with the words, if any: the words for a
 * group with "Turn on encryption" name that step
 * @returns The notice
 */
export function noticeFor(
  reason: BlockReason,
  channel: PlainWriteInput["channel"],
  action: ComposerAction | null = null,
): ComposerNotice {
  if (action === "enable-group") return "group-enable";
  if (reason !== "sender") return reason;
  return channel === "group" ? "group-not-encrypted" : "sender-dm";
}

/**
 * A block for a reason, with its button and the words that go with it.
 * @param reason Why
 * @param input The policy facts
 * @param mode The conversation's send mode
 * @param withGroupEnable Offer "Turn on encryption" for the group; false
 * for writes that have no encrypted form, which it would not let through
 */
function blockOf(
  reason: BlockReason,
  input: PlainWriteInput,
  mode: E2EESendMode | undefined,
  withGroupEnable = true,
): ComposerBlock {
  let action = actionFor(reason, input.device, mode);
  if (action === "enable-group" && !withGroupEnable) action = null;
  return { reason, notice: noticeFor(reason, input.channel, action), action };
}

/**
 * The button for a refusal reason on this device.
 * @param reason Why
 * @param device This device
 * @param mode The conversation's send mode
 * @returns The action, or `null` for none
 */
export function actionFor(
  reason: BlockReason,
  device: DeviceState,
  mode: E2EESendMode | undefined,
): ComposerAction | null {
  switch (reason) {
    case "setup":
      return "enable-device";
    case "recipient":
      // The person writing to an Encrypted-only account, on an app
      return device === "not-set-up" ? "enable-device" : null;
    case "group":
      if (device === "not-set-up") return "enable-device";
      // A marked group whose encryption was never set up
      return device === "ready" && mode === "plaintext" ? "enable-group" : null;
    case "peer-changed":
      return "send-anyway";
    case "sender":
    case "open-app":
      return null;
    default: {
      const exhaustive: never = reason;
      void exhaustive;
      return null;
    }
  }
}

/**
 * What the composer shows in place of the editor, if anything.
 * @param input The policy facts (`buildPlainWriteInput`)
 * @param view The conversation as cached here
 * @returns The block, or `null` to leave the editor open
 */
export function composerBlockFor(
  input: PlainWriteInput,
  view: ComposerView,
): ComposerBlock | null {
  if (input.channel !== "dm" && input.channel !== "group") return null;
  if (!view.statusLoaded) return null;

  const facts = sendMayEncrypt(input, view)
    ? { ...input, encrypted: true }
    : input;
  const reason = reasonFor(decideForKind("send", facts), facts);
  if (!reason) return null;

  return blockOf(reason, input, view.mode);
}

/**
 * A write other than a send (a slash command, a roll) that the policy
 * refuses here, as the composer shows it. These have no encrypted form, so
 * the cache's send mode does not matter, and encrypting the group would not
 * let them through: no "Turn on encryption" for the group.
 * @param kind What would be written
 * @param input The policy facts (`buildPlainWriteInput`)
 * @param view The conversation as cached here
 * @returns The block, or `null` when the write may go
 */
export function kindBlockFor(
  kind: Exclude<PlainWriteKind, "send">,
  input: PlainWriteInput,
  view: ComposerView,
): ComposerBlock | null {
  const decision = decideForKind(kind, input);
  if (decision === "allow-plain") return null;

  // A refusal with no reason still refuses, with the sender's words
  const reason = reasonFor(decision, input) ?? "sender";
  return blockOf(reason, input, view.mode, false);
}

const REASONS: Record<BlockReason, true> = {
  sender: true,
  recipient: true,
  group: true,
  setup: true,
  "open-app": true,
  "peer-changed": true,
};

/**
 * A refusal that came back from a write (the guard, the bridge or the
 * server), as the composer shows it.
 * @param side The refusal's side or reason
 * @param input The policy facts now
 * @param view The conversation as cached here
 * @returns The block, or `null` for a side the composer has no words for
 * (`member`, or one added later): the caller shows the general error text
 */
export function refusalBlock(
  side: string,
  input: PlainWriteInput,
  view: ComposerView,
): ComposerBlock | null {
  if (!Object.prototype.hasOwnProperty.call(REASONS, side)) return null;
  return blockOf(side as BlockReason, input, view.mode);
}

/**
 * What this device's cache says about a conversation: the bridge's send
 * modes and status, read by the caller. One builder for the composer and
 * the dialogs that send from it.
 * @param e2ee The encryption bridge, if this window has one
 * @param channel The conversation
 * @param peerId The direct message peer, if any
 * @param peerOptedIn The peer has encryption on (the server's hint)
 * @returns The view
 */
export function composerViewFor(
  e2ee:
    | {
        sendModes: { get(key: string): E2EESendMode | undefined };
        status: { get(key: "state"): unknown };
      }
    | null
    | undefined,
  channel: { type: string; id: string },
  peerId: string | undefined,
  peerOptedIn: boolean,
): ComposerView {
  const key =
    channel.type === "DirectMessage"
      ? peerId
      : channel.type === "Group"
        ? channel.id
        : undefined;
  return {
    mode: key ? e2ee?.sendModes.get(key) : undefined,
    statusLoaded: !e2ee || !!e2ee.status.get("state"),
    peerOptedIn,
  };
}

// ---- Failed entries ------------------------------------------------------------

/** An outbox entry, as far as the composer and the row menu read it. */
export type OutboxRow = {
  idempotencyKey: string;
  status: string;
  error?: string;
};

/**
 * How a failed or unsent entry may be sent again.
 * - `send-anyway`: refused for a peer who may have left Encrypted-only; the
 *   user confirms the peer, then it is sent again. A plain retry would be
 *   refused the same way, so it is not offered.
 * - `retry`: sent again as it is; every check runs again.
 * - `null`: not as it is (files waiting for a text message).
 * Under the latch nothing confirms a peer, so such an entry is retried and
 * refused for the latch, which its row then says.
 * @param stored The entry's `error`
 * @param latched The account's latch is on here
 * @returns The offer
 */
export function failedRowSend(
  stored: string | undefined,
  latched: boolean,
): "send-anyway" | "retry" | null {
  if (!canRetrySendAsIs(stored)) return null;
  if (
    !latched &&
    encryptionRequiredSendError(stored)?.side === PEER_CHANGED_SIDE
  ) {
    return "send-anyway";
  }
  return "retry";
}

/**
 * The failed entries the composer's "Send anyway" confirms and sends again:
 * those refused for a peer who may have left Encrypted-only. The composer
 * shows its notice while there are any.
 * @param rows The channel's outbox
 * @param latched The account's latch is on here
 * @returns Their keys, in outbox order
 */
export function peerChangedKeys(
  rows: readonly OutboxRow[],
  latched: boolean,
): string[] {
  return rows
    .filter(
      (row) =>
        row.status === "failed" &&
        failedRowSend(row.error, latched) === "send-anyway",
    )
    .map((row) => row.idempotencyKey);
}

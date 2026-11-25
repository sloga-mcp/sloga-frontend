/**
 * Encrypted-only chats: the one decision of what a write into a conversation
 * may do. Pure: every fact is passed in and nothing is read from the app,
 * storage or the browser, so `node --test` loads it directly
 * (`encryptedOnlyPolicy.test.ts`). The latch and the memory of peers and
 * groups come from `encryptedOnlyLatch.ts`.
 *
 * Decision table for a send. The first matching row wins. "encrypted" means
 * the adapter says this send goes out encrypted AND this device is ready;
 * a device that is not ready never counts as encrypted.
 *
 * | channel      | condition                                  | decision             | reason       |
 * |--------------|--------------------------------------------|----------------------|--------------|
 * | saved        | any                                        | allow-plain          |              |
 * | server       | any                                        | allow-plain          |              |
 * | dm, group    | encrypted                                  | send-encrypted       |              |
 * | dm, group    | latch on, website                          | block-open-app       | open-app     |
 * | dm, group    | latch on, encryption not set up here       | block-setup          | setup        |
 * | dm           | latch on                                   | block-peer           | sender       |
 * | dm           | peer flag on                               | block-peer           | recipient    |
 * | dm           | peer remembered, flag absent or off        | confirm-peer-changed | peer-changed |
 * | dm           | otherwise                                  | allow-plain          |              |
 * | group        | marked or remembered (latch on or off)     | block-group          | group        |
 * | group        | latch on, not marked, not remembered       | block-group          | sender       |
 * | group        | otherwise                                  | allow-plain          |              |
 *
 * The reasons match the server's refusal: a direct message is refused for
 * the sender's own setting before the recipient's, a group for its mark
 * before the sender's setting. `peer-changed` has no server side: the peer
 * may have left the setting, and only the user can confirm one send. Only an
 * explicit off makes the app say the peer turned it off; that notice is not
 * this module's business.
 *
 * The server's advert (`features.e2ee.only`) is part of the input and decides
 * nothing: an absent advert, or enforcement switched off, never lifts the
 * latch or a remembered peer or group. It only decides whether the settings
 * card is shown, which is not this module's business.
 *
 * Every other kind of write (edit, forward, schedule, poll, soft reserve,
 * interaction, roll, upload, captions, watch) has no encrypted form. It is
 * allowed exactly when an unencrypted send would be `allow-plain`, so a
 * conversation where nobody asked for Encrypted-only keeps today's behaviour
 * even when it happens to be encrypted.
 */
import type { PlainWriteKind } from "stoat.js";

import { MAX_E2EE_GROUP_MEMBERS } from "./groupInclude.ts";

/**
 * The most members an encrypted group can have. The same number as the
 * server's `E2EE_GROUP_MAX` and the native core's cap.
 */
export const E2EE_GROUP_MAX = MAX_E2EE_GROUP_MEMBERS;

/** What a write may do. */
export type Decision =
  | "send-encrypted"
  | "block-setup"
  | "block-open-app"
  | "block-peer"
  | "block-group"
  | "confirm-peer-changed"
  | "allow-plain";

/** The reason carried by `EncryptedOnlyBlockedError`. */
export type BlockReason =
  | "sender"
  | "recipient"
  | "group"
  | "setup"
  | "open-app"
  | "peer-changed";

/**
 * Where the write goes: a direct message, a group, Saved Notes, or any
 * channel of a server.
 */
export type ChannelKind = "dm" | "group" | "saved" | "server";

/**
 * The peer's `e2ee_only` as this device last heard it: on, explicitly turned
 * off (an update that said `false`), or never stated.
 */
export type PeerFlag = "on" | "off" | "absent";

/**
 * This device: encryption is set up and usable, it is an app where encryption
 * was never set up, or it cannot encrypt at all (the website).
 */
export type DeviceState = "ready" | "not-set-up" | "web";

/** What the server advertises about the feature. Decides nothing here. */
export type Advert = "absent" | "enforced" | "not-enforced";

/** The facts a decision is made from. */
export type PlainWriteInput = {
  /** This account's latch on this device */
  latched: boolean;
  /** Where the write goes */
  channel: ChannelKind;
  /** The direct message peer's flag (ignored outside a direct message) */
  peerFlag: PeerFlag;
  /** The peer was once seen as Encrypted-only */
  peerRemembered: boolean;
  /** The group carries the encrypted-only mark (ignored outside a group) */
  groupMarked: boolean;
  /** The group was once seen with the mark */
  groupRemembered: boolean;
  /** This device */
  device: DeviceState;
  /** The adapter's verdict: this send goes out encrypted */
  encrypted: boolean;
  /** The server's advert */
  advert: Advert;
};

/**
 * Decide what a send into a conversation may do. See the table at the top of
 * this file.
 * @param input The facts
 * @returns The decision
 */
export function decidePlainWrite(input: PlainWriteInput): Decision {
  if (input.channel === "saved" || input.channel === "server") {
    return "allow-plain";
  }

  if (input.encrypted === true && input.device === "ready") {
    return "send-encrypted";
  }

  if (input.latched) {
    if (input.device === "web") return "block-open-app";
    if (input.device !== "ready") return "block-setup";
    return input.channel === "group" ? "block-group" : "block-peer";
  }

  if (input.channel === "group") {
    return input.groupMarked || input.groupRemembered
      ? "block-group"
      : "allow-plain";
  }

  // A direct message, and anything unknown is held to the same rules
  if (input.peerFlag === "on") return "block-peer";
  if (input.peerRemembered) return "confirm-peer-changed";

  return "allow-plain";
}

/** A remembered peer whose flag is no longer on, with the latch off. */
function peerChanged(input: PlainWriteInput): boolean {
  return !input.latched && input.peerRemembered && input.peerFlag !== "on";
}

/**
 * The reason to refuse with, for a decision made from `input`.
 * @param decision The decision
 * @param input The facts it was made from
 * @returns The reason, or `null` when the decision refuses nothing
 * (`confirm-peer-changed` refuses until the user confirmed). A kind other
 * than a send that is refused for a changed peer (`block-peer` from
 * `decideForKind`) carries `peer-changed` too, never `recipient`.
 */
export function reasonFor(
  decision: Decision,
  input: PlainWriteInput,
): BlockReason | null {
  switch (decision) {
    case "send-encrypted":
    case "allow-plain":
      return null;
    case "block-setup":
      return "setup";
    case "block-open-app":
      return "open-app";
    case "block-peer":
      if (input.latched) return "sender";
      return peerChanged(input) ? "peer-changed" : "recipient";
    case "confirm-peer-changed":
      return "peer-changed";
    case "block-group":
      return input.groupMarked || input.groupRemembered ? "group" : "sender";
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

const KINDS: Record<PlainWriteKind, true> = {
  send: true,
  edit: true,
  forward: true,
  schedule: true,
  poll: true,
  softres: true,
  interaction: true,
  roll: true,
  upload: true,
  captions: true,
  watch: true,
};

/** Every kind of write except a send. None has an encrypted form. */
export const NON_SEND_KINDS = (Object.keys(KINDS) as PlainWriteKind[]).filter(
  (kind) => kind !== "send",
) as readonly Exclude<PlainWriteKind, "send">[];

/**
 * Decide what a write of the given kind may do. A send follows the table.
 * Any other kind is `allow-plain` only where an unencrypted send would be,
 * and is otherwise blocked with the decision that send would get
 * (`block-peer` in place of the confirmation, which only a send can ask for;
 * its reason stays `peer-changed`).
 * @param kind What is about to be written
 * @param input The facts
 * @returns The decision; never `send-encrypted` or `confirm-peer-changed`
 * for a kind other than `send`
 */
export function decideForKind(
  kind: PlainWriteKind,
  input: PlainWriteInput,
): Decision {
  if (kind === "send") return decidePlainWrite(input);

  const plain = decidePlainWrite({ ...input, encrypted: false });
  return plain === "confirm-peer-changed" ? "block-peer" : plain;
}

/**
 * For the plain write guard: the reason to refuse an unencrypted write of
 * any kind, or `null` to let it through. The guard only runs for a write
 * that is about to go out unencrypted, so the adapter's verdict is not
 * consulted; a send still waiting for the user's confirmation is refused
 * with `peer-changed`.
 * @param kind What is about to be written
 * @param input The facts
 * @returns The reason, or `null`
 */
export function guardReason(
  kind: PlainWriteKind,
  input: PlainWriteInput,
): BlockReason | null {
  const plain: PlainWriteInput = { ...input, encrypted: false };
  return reasonFor(decideForKind(kind, plain), plain);
}

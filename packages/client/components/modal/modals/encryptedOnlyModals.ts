/**
 * Encrypted-only chats: the decisions the dialogs make from the policy
 * (`encryptedOnlyPolicy.ts`). Pure, so `node --test` loads it
 * (`encryptedOnlyModals.test.ts`); the dialogs gather the facts with
 * `buildPlainWriteInput` and the user cache.
 */
import type { PlainWriteKind } from "stoat.js";

import {
  type BlockReason,
  type Decision,
  type DeviceState,
  type PlainWriteInput,
  E2EE_GROUP_MAX,
  decideForKind,
  reasonFor,
} from "../../client/encryptedOnlyPolicy.ts";

/**
 * Whether a dialog may offer a way to make a conversation unencrypted
 * (accept a peer's downgrade, turn encryption off, allow a group to go
 * unencrypted). Never under the latch, and never where an unencrypted send
 * would be refused anyway. A remembered peer still gets the choice: the
 * send itself asks for the confirmation.
 * @param latched This account's latch on this device
 * @param plainDecision What an unencrypted send into the conversation would
 * get (`decidePlainWrite` with `encrypted: false`), or `null` when the
 * conversation is not known here
 * @returns Whether the choice is offered
 */
export function offersPlaintextExit(
  latched: boolean,
  plainDecision: Decision | null,
): boolean {
  if (latched) return false;
  return (
    plainDecision === null ||
    plainDecision === "allow-plain" ||
    plainDecision === "confirm-peer-changed"
  );
}

/**
 * Whether a dialog has to refuse a write. A send still waiting for the
 * user's confirmation counts: only the composer can ask for it.
 * @param decision From `decideForKind`
 * @returns Whether it is refused
 */
export function blocksWrite(decision: Decision): boolean {
  return decision !== "allow-plain" && decision !== "send-encrypted";
}

/**
 * Why a dialog refuses a write of this kind, for the words it shows.
 * @param kind What the dialog is about to write
 * @param facts From `buildPlainWriteInput`
 * @returns The reason, or `null` when the write may go ahead
 */
export function writeRefusal(
  kind: PlainWriteKind,
  facts: PlainWriteInput,
): BlockReason | null {
  const decision = decideForKind(kind, facts);
  if (!blocksWrite(decision)) return null;
  return reasonFor(decision, facts) ?? "sender";
}

/**
 * Whether a group carries the mark, or was once seen with it on this
 * device.
 * @param facts From `buildPlainWriteInput`
 * @returns Whether it is held to the encrypted group rules
 */
export function groupIsMarked(facts: PlainWriteInput): boolean {
  return (
    facts.channel === "group" && (facts.groupMarked || facts.groupRemembered)
  );
}

/** What the dialogs know about someone who may join a group. */
export type Candidate = {
  /** User id */
  id: string;
  /** Has encryption turned on (the account's `e2ee_enabled`) */
  encrypted: boolean;
  /** Is Encrypted-only */
  encryptedOnly: boolean;
  /** Is a bot */
  bot: boolean;
};

/**
 * Whether a new group will be marked: its creator or anyone picked is
 * Encrypted-only. The same rule as the server's.
 * @param creatorOnly The creator is Encrypted-only (the latch, or the
 * account's flag)
 * @param members Everyone picked
 * @returns Whether it will be marked
 */
export function newGroupMarked(
  creatorOnly: boolean,
  members: readonly Candidate[],
): boolean {
  return creatorOnly || members.some((member) => member.encryptedOnly);
}

/** Someone who cannot be in an encrypted group. */
function lacksEncryption(member: Candidate): boolean {
  return !member.encrypted || member.bot;
}

/** Why a group cannot be created, or a member not be added. */
export type GroupRefusal =
  | "too_many"
  | "no_encryption"
  | "recipient"
  | "setup"
  | "open-app";

/**
 * The server's side for a group refusal, so the dialogs show the same
 * words as when the server refuses (`useError`).
 * @param refusal Why
 * @returns The side
 */
export function refusalSide(
  refusal: GroupRefusal,
): "member" | "recipient" | "setup" | "open-app" {
  switch (refusal) {
    case "too_many":
    case "no_encryption":
      return "member";
    case "recipient":
    case "setup":
    case "open-app":
      return refusal;
    default: {
      const exhaustive: never = refusal;
      return exhaustive;
    }
  }
}

/**
 * Whether a new group can be created as picked.
 * A marked group needs this device to encrypt (it runs the enable step
 * right after), at most `E2EE_GROUP_MAX` people with the creator, and
 * encryption on for everyone picked; bots never qualify.
 * @param input Whether it will be marked, this device, everyone picked
 * @returns The refusal (or `null`) and the ids picked without encryption,
 * which a marked group lists whatever else refuses
 */
export function checkNewGroup(input: {
  marked: boolean;
  device: DeviceState;
  members: readonly Candidate[];
}): { refusal: GroupRefusal | null; withoutEncryption: string[] } {
  if (!input.marked) return { refusal: null, withoutEncryption: [] };

  const withoutEncryption = input.members
    .filter(lacksEncryption)
    .map((member) => member.id);

  let refusal: GroupRefusal | null = null;
  if (input.device === "web") refusal = "open-app";
  else if (input.device !== "ready") refusal = "setup";
  else if (input.members.length + 1 > E2EE_GROUP_MAX) refusal = "too_many";
  else if (withoutEncryption.length) refusal = "no_encryption";

  return { refusal, withoutEncryption };
}

/**
 * How many more people a group can take under the encrypted group rules.
 * @param marked The group is marked
 * @param groupSize Members now, this account included
 * @returns The number left; unlimited for a group that is not marked
 */
export function roomLeft(marked: boolean, groupSize: number): number {
  if (!marked) return Number.POSITIVE_INFINITY;
  return Math.max(0, E2EE_GROUP_MAX - groupSize);
}

/**
 * Whether one person can be added to an existing group. A marked group
 * takes only people with encryption on, up to `E2EE_GROUP_MAX`; a group
 * that is not marked never takes an Encrypted-only person.
 * @param input The group's mark and size, and the person
 * @returns The refusal, or `null`
 */
export function addRefusal(input: {
  marked: boolean;
  groupSize: number;
  member: Candidate;
}): GroupRefusal | null {
  if (!input.marked) return input.member.encryptedOnly ? "recipient" : null;
  if (roomLeft(true, input.groupSize) < 1) return "too_many";
  return lacksEncryption(input.member) ? "no_encryption" : null;
}

/**
 * Encrypted-only chats: the decisions behind the settings card, the setup
 * and the leave flow. Pure: every fact is passed in, so `node --test` loads
 * it directly (`encryptedOnlySetup.test.ts`).
 */
import {
  type PlainWriteInput,
  decidePlainWrite,
} from "../../client/encryptedOnlyPolicy.ts";

/** What the server advertises under `features.e2ee.only`. */
export type OnlyAdvert = {
  /** The setting can be turned on */
  available: boolean;
  /** The server refuses unencrypted writes */
  enforced: boolean;
};

/**
 * Read the advert from the server's root document (`GET /`).
 * @param root The document, as the server sent it
 * @returns The advert, or `null` when the server does not know the feature
 */
export function parseOnlyAdvert(root: unknown): OnlyAdvert | null {
  if (typeof root !== "object" || root === null) return null;
  const features = (root as { features?: unknown }).features;
  if (typeof features !== "object" || features === null) return null;
  const e2ee = (features as { e2ee?: unknown }).e2ee;
  if (typeof e2ee !== "object" || e2ee === null) return null;
  const only = (e2ee as { only?: unknown }).only;
  if (typeof only !== "object" || only === null) return null;

  return {
    available: (only as { available?: unknown }).available === true,
    enforced: (only as { enforced?: unknown }).enforced === true,
  };
}

/** What the Encrypted-only card on the settings pages shows. */
export type OnlyCardState =
  | "hidden"
  | "unavailable"
  | "off"
  | "on"
  | "turned-off-elsewhere";

/**
 * Pick the card's state.
 * @param input.advert The advert; `null` or `undefined` (not known yet)
 * hides the card
 * @param input.userKnown This account's user object is loaded
 * @param input.latched This device's latch for the account
 * @param input.serverOn The server's flag for the account
 * @param input.settingUp The setup is open: it sets the latch before the
 * server answers, which is not a turn-off elsewhere
 * @returns The state
 */
export function onlyCardState(input: {
  advert: OnlyAdvert | null | undefined;
  userKnown: boolean;
  latched: boolean;
  serverOn: boolean;
  settingUp?: boolean;
}): OnlyCardState {
  if (!input.advert || !input.userKnown) return "hidden";
  // The server never clears the latch: this device keeps refusing until
  // the user turns it off here too
  if (input.latched && !input.serverOn && input.settingUp !== true) {
    return "turned-off-elsewhere";
  }
  if (input.serverOn) return "on";
  return input.advert.available ? "off" : "unavailable";
}

/** This device's native backup status, as `backupStatus()` reports it. */
export type BackupSnapshot = {
  exists: boolean;
  generation: number;
  uploadedGeneration: number;
  serverHasBackup: boolean;
  /** Seconds; set by a create or rotate only (a refresh keeps it) */
  createdAt: number;
};

/**
 * Whether a recovery code was made during this setup and its backup reached
 * the server. A backup that existed before the setup started never counts,
 * nor does a restored one (its time is the source device's), nor one whose
 * newest generation was not uploaded (a cancelled dialog).
 * @param status Status read after the create or rotate
 * @param runStartedAt When this setup opened, in seconds
 * @returns Whether the recovery step is done
 */
export function recoveryCodeMadeThisRun(
  status: BackupSnapshot | undefined,
  runStartedAt: number,
): boolean {
  if (!status || status.exists !== true) return false;
  if (!Number.isFinite(status.createdAt)) return false;
  if (!Number.isFinite(runStartedAt) || status.createdAt < runStartedAt) {
    return false;
  }
  if (!(status.generation > 0)) return false;
  if (!(status.uploadedGeneration >= status.generation)) return false;
  return status.serverHasBackup === true;
}

/** Why turning the setting on cannot start, checked before the ticket. */
export type TurnOnBlock = "unavailable" | "device";

/**
 * Check the advert and the device before asking for a ticket (the server
 * burns the ticket before it reads the request).
 * @param input.advert The advert as fetched just now
 * @param input.deviceReady Encryption is set up and registered here
 * @returns The block, or `null` to go ahead
 */
export function turnOnPrecheck(input: {
  advert: OnlyAdvert | null | undefined;
  deviceReady: boolean;
}): TurnOnBlock | null {
  if (!input.advert || !input.advert.available) return "unavailable";
  if (!input.deviceReady) return "device";
  return null;
}

/**
 * After turning the setting on failed: clear the latch only when the server
 * is known to have it off. Kept when it was on before this setup, when the
 * result is unknown, or when this account's user object says on.
 * @param latchWasOn The latch was on before this setup set it
 * @param serverOn What the server says now; `undefined` when it could not
 * be read (the route may have gone through)
 * @param userFlagOn `client.user.e2eeOnly` is true right now
 * @returns Whether to keep the latch
 */
export function keepLatchAfterFailure(
  latchWasOn: boolean,
  serverOn: boolean | undefined,
  userFlagOn: boolean,
): boolean {
  return latchWasOn || userFlagOn || serverOn !== false;
}

/**
 * The groups to leave once the setting is on: the ticked ones that are still
 * listed as unencrypted right now. A ticked group that has left the list
 * (it turned out to be encrypted, or is gone) is kept.
 * @param ticked Ids the user ticked
 * @param listed Ids of the groups listed as unencrypted now
 * @returns Ids to leave, in ticked order
 */
export function groupsToLeave(
  ticked: Iterable<string>,
  listed: Iterable<string>,
): string[] {
  const still = new Set(listed);
  return [...new Set(ticked)].filter((id) => still.has(id));
}

/**
 * Whether a group is one the user was already in that stays unencrypted:
 * not marked, not remembered as marked, and not known to send encrypted
 * from this device. Under the latch such a group is read-only.
 * @param input The policy input for the group
 * @returns Whether to list it in the setup
 */
export function isUnencryptedGroup(input: PlainWriteInput): boolean {
  if (input.channel !== "group") return false;
  if (input.groupMarked || input.groupRemembered) return false;
  return decidePlainWrite({ ...input, latched: true }) !== "send-encrypted";
}

/** The kind of failure from the turn-on or turn-off route. */
export type RouteFailure = "unavailable" | "device" | "ticket" | "other";

/**
 * Sort a failure from `PUT /e2ee/only` by what the user can do about it.
 * @param error What the request rejected with
 * @returns The kind
 */
export function classifyRouteFailure(error: unknown): RouteFailure {
  const type =
    typeof error === "object" && error !== null
      ? (error as { type?: unknown }).type
      : undefined;
  switch (type) {
    case "FeatureDisabled":
      return "unavailable";
    case "NotAuthenticated":
      return "device";
    case "InvalidToken":
      return "ticket";
    default:
      return "other";
  }
}

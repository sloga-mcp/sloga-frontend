/**
 * Encrypted-only chats: when to offer "Encrypt this group" on the read-only
 * group banner and "Share invite" in the composer and on the settings card,
 * and how the invite is shared. Pure, so `node --test` loads it
 * (`encryptedOnlyInvite.test.ts`); the callers gather the facts with
 * `buildPlainWriteInput` and the user cache, and supply the words.
 */
import { plainGroupUnderLatch } from "../../../../client/encryptedOnlyChat.ts";
import {
  type BlockReason,
  type PlainWriteInput,
  E2EE_GROUP_MAX,
} from "../../../../client/encryptedOnlyPolicy.ts";
import type { OnlyCardState } from "../../../../modal/modals/encryptedOnlySetup.ts";

/** Another member of a group, as this device's cache knows them. */
export type GroupMember = {
  /** Has encryption turned on (the account's `e2ee_enabled`) */
  encrypted: boolean;
  /** Is a bot */
  bot: boolean;
};

/**
 * Whether the read-only banner of a group offers "Encrypt this group": the
 * group is read-only for this account's own setting, this device can
 * encrypt, the group has at most `E2EE_GROUP_MAX` members counting this
 * account, every other member has encryption on and none is a bot, and the
 * group is not known to have webhooks.
 * @param input The policy facts for the group (`buildPlainWriteInput`)
 * @param others Every other member; one this device does not know yet is
 * passed as without encryption, so the button stays hidden
 * @param webhooksKnown Whether this device knows the group has a webhook;
 * asked last, so a caller only reads its sources when it matters
 * @returns Whether to offer it
 */
export function offersEncryptGroup(
  input: PlainWriteInput,
  others: readonly GroupMember[],
  webhooksKnown: () => boolean,
): boolean {
  if (!plainGroupUnderLatch(input) || input.device !== "ready") return false;
  if (others.length < 1 || others.length + 1 > E2EE_GROUP_MAX) return false;
  if (!others.every((member) => member.encrypted && !member.bot)) return false;
  return !webhooksKnown();
}

/**
 * Whether the composer block offers "Share invite": this account's own
 * message is refused in a direct message on a device that can encrypt, for
 * a peer who does not have encryption on and is not a bot. A block that
 * already has a button keeps it.
 * @param block The composer block, if any
 * @param input The policy facts (`buildPlainWriteInput`)
 * @param peerOptedIn The peer has encryption on (the server's hint)
 * @param peerIsBot The peer is a bot, which cannot turn encryption on
 * @returns Whether to offer it
 */
export function composerOffersInvite(
  block: { reason: BlockReason; action: unknown } | null | undefined,
  input: PlainWriteInput,
  peerOptedIn: boolean,
  peerIsBot: boolean,
): boolean {
  if (!block || block.action !== null || block.reason !== "sender") {
    return false;
  }
  if (peerIsBot) return false;
  return (
    input.latched &&
    input.channel === "dm" &&
    input.device === "ready" &&
    !peerOptedIn
  );
}

/**
 * Whether the Encrypted-only card offers "Share invite": while the account
 * has the setting on. Not once it was turned off elsewhere, where the
 * invite's "only delivers encrypted direct messages" would no longer be true.
 * @param state The card's state (`onlyCardState`)
 * @returns Whether to offer it
 */
export function cardOffersInvite(state: OnlyCardState): boolean {
  return state === "on";
}

/** The ways this window can share text. */
export type ShareDeps = {
  /** The system share sheet (`navigator.share`), where it exists */
  share?: (data: { text: string }) => Promise<void>;
  /** Copy to the clipboard, where it exists */
  copy?: (text: string) => Promise<void>;
};

/** What happened to the invite. */
export type ShareOutcome = "shared" | "dismissed" | "copied" | "failed";

/**
 * Share the invite text: the share sheet where there is one, else the
 * clipboard. Closing the sheet is not a failure. The sheet is opened before
 * anything is awaited, as browsers only open it straight from a tap.
 * @param text The invite
 * @param deps The ways to share
 * @returns What happened
 */
export async function shareInviteText(
  text: string,
  deps: ShareDeps,
): Promise<ShareOutcome> {
  if (deps.share) {
    try {
      await deps.share({ text });
      return "shared";
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === "AbortError") {
        return "dismissed";
      }
      // A sheet that refused (no handler, not allowed): copy instead
    }
  }

  const copy = deps.copy;
  if (!copy) return "failed";
  try {
    // A synchronous throw lands here too
    await Promise.resolve().then(() => copy(text));
    return "copied";
  } catch {
    return "failed";
  }
}

/**
 * The toast for an outcome: only a copy is confirmed, and a failure said.
 * @param outcome What happened
 * @returns Which toast, or `null` for none
 */
export function inviteToastFor(
  outcome: ShareOutcome,
): "copied" | "failed" | null {
  return outcome === "copied" || outcome === "failed" ? outcome : null;
}

/** The part of a window the invite uses. */
export type ShareWindow = {
  navigator?: {
    share?: (data: { text: string }) => Promise<void>;
    clipboard?: { writeText?: (text: string) => Promise<void> };
  };
};

/**
 * The share sheet and clipboard of one window. Both need that window: the
 * sheet opens only from a tap in it, and the clipboard only writes while
 * its document has focus. There is no native share plugin in the apps:
 * Android's web view has no share sheet, so it copies.
 * @param win The window
 * @returns The ways to share
 */
export function windowShareDeps(
  win: ShareWindow | null | undefined,
): ShareDeps {
  const nav = win?.navigator;
  if (!nav) return {};
  const clipboard = nav.clipboard;
  return {
    share:
      typeof nav.share === "function" ? (data) => nav.share!(data) : undefined,
    copy:
      typeof clipboard?.writeText === "function"
        ? (text) => clipboard.writeText!(text)
        : undefined,
  };
}

/**
 * The share sheet and clipboard of the global window.
 * @returns The ways to share
 */
export function browserShareDeps(): ShareDeps {
  if (typeof navigator === "undefined") return {};
  return windowShareDeps({ navigator } as ShareWindow);
}

/**
 * How to share from the window a tap came from: that window's sheet and
 * clipboard, and a toast only where the snackbar shows in that same window,
 * never one behind it.
 * @param clickWin The window the tap came from
 * @param snackbarWin The window the snackbar shows in, if there is one
 * @returns The ways to share, and whether a toast may show
 */
export function inviteShareIn<W extends ShareWindow>(
  clickWin: W,
  snackbarWin: W | undefined,
): { deps: ShareDeps; toast: boolean } {
  return {
    deps: windowShareDeps(clickWin),
    toast: snackbarWin !== undefined && snackbarWin === clickWin,
  };
}

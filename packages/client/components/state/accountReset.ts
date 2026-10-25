/**
 * Keep one account's device-local data away from the next account to sign
 * in on the same device.
 *
 * The friend stores, the theme, their sync revisions and the chat-window
 * layout are
 * stored per device, not per account. The synced stores record the account
 * they belong to (`Sync.owner`), and `SyncWorker` checks it against every
 * new session before any sync runs. A different account gets them reset.
 *
 * The check runs at sign-in, not sign-out, so it holds however the last
 * session ended: logout, revocation, a remember-me-off relaunch or a crash.
 * Signing out and back in as the same account keeps everything, including
 * edits still waiting to upload.
 *
 * Kept free of Solid components and the app contexts so `node --test` can
 * load it (`./accountReset.test.ts`).
 */
import localforage from "localforage";

import { resetChatWindows } from "../chatWindows/chatWindowsStore";

import type { State } from ".";

/**
 * Synchronised stores holding one account's own data: its friend lists, its
 * Home layout, and the theme, which follows the account since it synchronises
 *
 * The other synced stores (ordering, notifications, release notes) are not
 * reset.
 */
const ACCOUNT_KEYS = [
  "friends",
  "friend-groups",
  "home-layout",
  "theme",
] as const;

type PersistedKey = (typeof ACCOUNT_KEYS)[number] | "sync";

/**
 * Write keys to disk now instead of after State's write delay
 *
 * localforage writes run in call order. A switch writes `sync` with the
 * revisions cleared and the old owner, then the reset data, then `sync` with
 * the new owner, so a crash at any point leaves either the old owner (the
 * next sign-in resets again) or no revisions (the next sync adopts the remote
 * copy), never default data under a live revision.
 * @param state State
 * @param keys Keys to write
 */
function persistNow(state: State, keys: PersistedKey[]) {
  for (const key of keys) {
    localforage
      .setItem(key, JSON.parse(JSON.stringify(state.get(key))))
      .catch((err) => console.error("Failed to write", key, err));
  }
}

/**
 * Drop everything this device holds for the account that last used it
 *
 * Resets the friend stores and the theme to their defaults with no revision
 * and nothing queued for upload, so the next account's first sync adopts its
 * own remote copy, and closes and forgets the chat windows. The theme is not
 * seeded from the reset default (`Sync.initialSync`), so an account with no
 * theme of its own keeps the default.
 * @param state State
 */
export function resetAccountLocalState(state: State) {
  state.sync.forget([...ACCOUNT_KEYS]);
  state.sync.reset([...ACCOUNT_KEYS]);
  // the cleared revisions reach disk before the data, still under the old
  // owner; the new owner is written last, by ensureAccountOwner
  persistNow(state, ["sync"]);
  persistNow(state, [...ACCOUNT_KEYS]);
  resetChatWindows();
}

/**
 * Make sure the device-local account data belongs to the account signing in
 *
 * Call before the session's first sync and before any of its sync events.
 * - a different account owns the data: reset it, then record the new owner
 * - no owner recorded (first sign-in since owners were added): record it
 * - the same account: nothing
 * @param state State
 * @param userId Id of the account signing in
 * @returns Whether the data now belongs to `userId`; false (and nothing
 *   changed) without a user id, and the caller must not sync
 * @throws When the reset fails, before the new owner is recorded, so the
 *   next session tries again; the caller must not sync
 */
export function ensureAccountOwner(
  state: State,
  userId: string | undefined,
): boolean {
  if (typeof userId !== "string" || userId.length === 0) return false;

  const owner = state.sync.owner;
  if (owner === userId) return true;

  if (owner) resetAccountLocalState(state);

  state.sync.setOwner(userId);
  persistNow(state, ["sync"]);
  return true;
}

/**
 * Whether a State write of `key` may reach disk from this window
 *
 * The friends popout is a second State over the same IndexedDB that never
 * syncs (`SyncWorker` returns early there) and never checks the owner. Its
 * copy of the synced stores and of `sync` is whatever it hydrated at boot,
 * so after one account signs out and another signs in, a write from a popout
 * still open from the first session would put that account's friends and
 * its owner back on disk. Its edits to those keys stay in memory, as they
 * never synced before either; the main window owns them on disk.
 * @param key Store key being written
 * @param isPopout Whether this window is the friends popout
 * @param syncedKeys Every synchronised store key (`Sync`'s revision map)
 * @returns False for `sync` and the synchronised keys in the popout
 */
export function shouldPersistKey(
  key: string,
  isPopout: boolean,
  syncedKeys: readonly string[],
): boolean {
  if (!isPopout) return true;
  return key !== "sync" && !syncedKeys.includes(key);
}

/**
 * Encrypted-only chats: the per-account latch this device keeps, and its
 * memory of peers and groups once seen as Encrypted-only.
 *
 * Storage (`localStorage`, one set of keys per account):
 * - `e2ee-only:<userId>`: absent, or the string "1" while the latch is on.
 * - `e2ee-only-at:<userId>`: when this device set the latch, in milliseconds
 *   as a decimal string. A sibling key, so the latch value itself stays "1".
 * - `e2ee-only-seen:<userId>`: a JSON list of peer user ids and group channel
 *   ids.
 *
 * Rules:
 * - The server saying "on" sets the latch. The server saying "off", or
 *   saying nothing, never clears it. Only `clearLatch` does, and only the
 *   leave flow calls that, after the route succeeded.
 * - Nothing here throws. Storage that is missing or throws is treated as
 *   empty for reads and ignored for writes, and a value this page already
 *   knows keeps holding: once the latch was set or read as on it stays on for
 *   the life of the page, whatever storage says later. Another window that
 *   leaves therefore does not unlatch this one; it has to call `clearLatch`
 *   itself or reload.
 * - A fresh page with unreadable storage has no latch until the server says
 *   "on" again.
 *
 * Every read tracks one signal, so a read inside a Solid computation re-runs
 * when the latch or the memory changes on this page.
 */
import { createSignal } from "solid-js";

/** What the latch key holds while the latch is on. */
export const LATCH_ON = "1";

/**
 * Storage key of the latch.
 * @param userId Account
 * @returns Key
 */
export function latchKey(userId: string): string {
  return `e2ee-only:${userId}`;
}

/**
 * Storage key of the time the latch was set.
 * @param userId Account
 * @returns Key
 */
export function latchedAtKey(userId: string): string {
  return `e2ee-only-at:${userId}`;
}

/**
 * Storage key of the remembered peers and groups.
 * @param userId Account
 * @returns Key
 */
export function seenKey(userId: string): string {
  return `e2ee-only-seen:${userId}`;
}

/** What this page knows for one account, apart from storage. */
type Mirror = {
  /** The latch was set or read as on; holds until `clearLatch` */
  on: boolean;
  /** When the latch was set, once known */
  at: number | null;
  /** `clearLatch` could not remove the latch key; retried on reads */
  clearPending: boolean;
  /** The last list read from or written to storage */
  seen: string[];
  /** Ids remembered that could not be written */
  pendingSeen: Set<string>;
  /** Ids forgotten that could not be written */
  pendingForget: Set<string>;
};

const mirrors = new Map<string, Mirror>();

function mirror(userId: string): Mirror {
  let entry = mirrors.get(userId);
  if (!entry) {
    entry = {
      on: false,
      at: null,
      clearPending: false,
      seen: [],
      pendingSeen: new Set(),
      pendingForget: new Set(),
    };
    mirrors.set(userId, entry);
  }
  return entry;
}

/** Created on first use, so loading this module does nothing. */
let version: ReturnType<typeof createSignal<number>> | undefined;

function versionSignal() {
  return (version ??= createSignal(0));
}

/**
 * Tracked read that changes whenever a latch or the memory changes on this
 * page. Every read in this module calls it already.
 * @returns A counter
 */
export function latchVersion(): number {
  return versionSignal()[0]();
}

function changed(): void {
  versionSignal()[1]((value) => value + 1);
}

/** `undefined` when storage is missing or the read threw. */
function read(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function resolveLatched(userId: string): boolean {
  const entry = mirror(userId);
  if (entry.on) return true;
  if (read(latchKey(userId)) !== LATCH_ON) return false;

  if (entry.clearPending) {
    // Left on this page, but the key could not be removed then
    if (remove(latchKey(userId))) {
      remove(latchedAtKey(userId));
      entry.clearPending = false;
    }
    return false;
  }

  entry.on = true;
  return true;
}

/**
 * Whether the latch is on for this account on this device.
 * @param userId Account
 * @returns Whether it is on
 */
export function isLatched(userId: string | undefined): boolean {
  latchVersion();
  if (!userId) return false;
  return resolveLatched(userId);
}

/**
 * When this device set the latch, for labelling unencrypted messages that
 * arrived after it.
 * @param userId Account
 * @returns `null` while the latch is off; 0 when it is on but the time is
 * unknown, so every unencrypted message counts as newer
 */
export function latchedAt(userId: string | undefined): number | null {
  latchVersion();
  if (!userId || !resolveLatched(userId)) return null;

  const entry = mirror(userId);
  if (entry.at !== null) return entry.at;

  const stored = read(latchedAtKey(userId));
  const at = typeof stored === "string" && stored !== "" ? Number(stored) : NaN;
  if (!Number.isFinite(at) || at < 0) return 0;

  entry.at = at;
  return at;
}

/**
 * Turn the latch on. Call it before the route that turns the setting on. A
 * latch that is already on keeps its time.
 * @param userId Account
 * @param now Current time in milliseconds
 */
export function setLatch(
  userId: string | undefined,
  now: number = Date.now(),
): void {
  if (!userId) return;

  const entry = mirror(userId);
  const wasOn = resolveLatched(userId);
  entry.on = true;
  entry.clearPending = false;

  if (!wasOn) entry.at = now;

  // Written even when already on: an earlier write may have failed
  if (entry.at !== null) write(latchedAtKey(userId), String(entry.at));
  write(latchKey(userId), LATCH_ON);
  if (!wasOn) changed();
}

/**
 * Turn the latch off. Only the leave flow calls this, after the route
 * succeeded. The memory of peers and groups is kept.
 * @param userId Account
 */
export function clearLatch(userId: string | undefined): void {
  if (!userId) return;

  const entry = mirror(userId);
  entry.on = false;
  entry.at = null;
  entry.clearPending = !remove(latchKey(userId));
  remove(latchedAtKey(userId));
  changed();
}

/**
 * Feed what the server says about this account's own setting. `true` sets
 * the latch; `false` or nothing changes nothing.
 * @param userId Account
 * @param value The server's `e2ee_only` for this account
 * @param now Current time in milliseconds
 * @returns Whether the latch is on while the server does not say "on" (the
 * setting was turned off on another device)
 */
export function noteServerFlag(
  userId: string | undefined,
  value: boolean | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!userId) return false;

  if (value === true) {
    setLatch(userId, now);
    return false;
  }

  return resolveLatched(userId);
}

function parseSeen(raw: string | null | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return [];

  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(
      (id): id is string => typeof id === "string" && id !== "",
    );
  } catch {
    return [];
  }
}

/** Storage (or the last known list), plus and minus what never got written. */
function resolveSeen(userId: string): Set<string> {
  const entry = mirror(userId);
  const stored = parseSeen(read(seenKey(userId)));
  if (stored) entry.seen = stored;

  const ids = new Set(entry.seen);
  for (const id of entry.pendingSeen) ids.add(id);
  for (const id of entry.pendingForget) ids.delete(id);
  return ids;
}

/** Write the whole list; on success nothing is pending any more. */
function storeSeen(userId: string, ids: Set<string>): boolean {
  const entry = mirror(userId);
  const list = [...ids];
  if (!write(seenKey(userId), JSON.stringify(list))) return false;

  entry.seen = list;
  entry.pendingSeen.clear();
  entry.pendingForget.clear();
  return true;
}

/**
 * The peers and groups remembered as Encrypted-only.
 * @param userId Account
 * @returns Peer user ids and group channel ids
 */
export function seenIds(userId: string | undefined): string[] {
  latchVersion();
  if (!userId) return [];
  return [...resolveSeen(userId)];
}

/**
 * Whether a peer or group was once seen as Encrypted-only.
 * @param userId Account
 * @param id Peer user id or group channel id
 * @returns Whether it is remembered
 */
export function isSeen(
  userId: string | undefined,
  id: string | undefined,
): boolean {
  latchVersion();
  if (!userId || !id) return false;
  return resolveSeen(userId).has(id);
}

/**
 * Remember a peer or group as Encrypted-only.
 * @param userId Account
 * @param id Peer user id or group channel id
 */
export function rememberSeen(
  userId: string | undefined,
  id: string | undefined,
): void {
  if (!userId || !id) return;

  const entry = mirror(userId);
  const ids = resolveSeen(userId);
  const known = ids.has(id);
  if (known && !entry.pendingSeen.size && !entry.pendingForget.size) return;

  ids.add(id);
  entry.pendingForget.delete(id);
  if (!storeSeen(userId, ids)) entry.pendingSeen.add(id);
  if (!known) changed();
}

/**
 * Forget one peer or group. Used when the user confirms a send after that
 * peer explicitly turned the setting off.
 * @param userId Account
 * @param id Peer user id or group channel id
 */
export function forgetSeen(
  userId: string | undefined,
  id: string | undefined,
): void {
  if (!userId || !id) return;

  const entry = mirror(userId);
  const ids = resolveSeen(userId);
  const known = ids.has(id);
  if (!known && !entry.pendingSeen.size && !entry.pendingForget.size) return;

  ids.delete(id);
  entry.pendingSeen.delete(id);
  if (!storeSeen(userId, ids)) entry.pendingForget.add(id);
  if (known) changed();
}

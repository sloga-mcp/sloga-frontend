/**
 * The list of people and group chats the phone may name when a call rings.
 *
 * The push that makes an Android phone ring carries only account and channel
 * ids, never a name, so the push service never learns who is calling. To show
 * "Alice is calling" the app hands its native side this list while it runs.
 * Native keeps it in app-private storage and looks the caller up when a ring
 * arrives.
 *
 * Pure on purpose, and deliberately free of imports, so `node --test` can load
 * it (`callContacts.test.ts`). It only builds the list from plain data.
 * Reading the client's stores and handing the result to native is the
 * caller's job.
 *
 * The list holds names, and so does its key. Both belong in memory and in the
 * native store only, never in a log, an error report or web storage.
 */

/** One person the phone may name: their id, their name and a photo link. */
export type CallContactUser = { id: string; name: string; avatar?: string };

/** One named group chat. */
export type CallContactChannel = { id: string; name: string };

/** Everything handed to native in one go. */
export type CallContacts = {
  users: CallContactUser[];
  channels: CallContactChannel[];
};

/*
 * The native store checks every entry again on the way in and drops what
 * breaks one of its limits. The limits below are the store's own, applied
 * here first, so the list this module builds is one the store keeps whole.
 * A caller that skips an unchanged list (see `callContactsKey`) is then never
 * woken by a change the store would have thrown away.
 */

/** The most people one list holds. The native store applies the same cap. */
export const CALL_CONTACTS_MAX_USERS = 2000;

/** The most group chats one list holds. The native store has the same cap. */
export const CALL_CONTACTS_MAX_CHANNELS = 500;

/**
 * The longest name one list holds, counted in UTF-16 units. That is the unit
 * the native store counts in, so a name cut here is never cut again there.
 */
export const CALL_CONTACT_NAME_MAX = 64;

/**
 * The longest id an entry may have, in UTF-16 units. A real id is 26 long.
 * The native store leaves out a person or group chat with a longer one.
 */
export const CALL_CONTACT_ID_MAX = 64;

/**
 * The longest photo link an entry may carry, in UTF-16 units. The native
 * store drops a longer one and keeps the person.
 */
export const CALL_CONTACT_AVATAR_MAX = 2048;

/** How a photo link has to start. Something has to follow it as well. */
const AVATAR_PREFIX = "https://";

/**
 * Whether an id is one the native store accepts: text, not empty and at most
 * `CALL_CONTACT_ID_MAX` long. An id is never trimmed or cut, because a
 * changed id would name somebody else.
 */
function usableId(id: unknown): id is string {
  return (
    typeof id === "string" && id !== "" && id.length <= CALL_CONTACT_ID_MAX
  );
}

/**
 * Whether the UTF-16 unit at `index` comes off the end of a name.
 *
 * That is everything JavaScript's `trim` removes and also everything up to
 * U+0020, which is what the native store's trim removes. Neither set holds
 * the other: only JavaScript removes a no-break space, and only the store
 * removes a control character such as U+0001.
 */
function isTrimmedAt(text: string, index: number): boolean {
  return text.charCodeAt(index) <= 0x20 || text.charAt(index).trim() === "";
}

/** `text` without the units `isTrimmedAt` names at its start and its end. */
function trimEnds(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isTrimmedAt(text, start)) start += 1;
  while (end > start && isTrimmedAt(text, end - 1)) end -= 1;
  return text.slice(start, end);
}

/**
 * A name as the ring may show it: trimmed and cut to `CALL_CONTACT_NAME_MAX`,
 * or `undefined` when nothing is left.
 *
 * The result is a name the native store keeps exactly as it is. The store
 * trims a name, cuts it and then drops a last unit that is the first half of
 * a surrogate pair, so an emoji that straddles the limit goes whole instead
 * of leaving half a character behind. A name that none of those three steps
 * would change is what this returns.
 *
 * Anything that is not a string counts as no name, because a user the client
 * has only partly loaded has none yet.
 */
function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let name = trimEnds(raw).slice(0, CALL_CONTACT_NAME_MAX);
  for (;;) {
    // The store trims only before its cut, so what the cut exposes goes here.
    let next = trimEnds(name);
    const last = next.charCodeAt(next.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) next = next.slice(0, -1);
    if (next === name) break;
    name = next;
  }
  return name === "" ? undefined : name;
}

/**
 * A photo link the ring may load, or `undefined`.
 *
 * Only an absolute `https://` link is kept. Native fetches the photo by
 * itself, possibly while the phone is locked, so a plain `http://` link, a
 * `data:` or `javascript:` value and a relative path are all dropped, and the
 * ring then shows no photo. The check is exact on purpose: a link with other
 * casing or leading whitespace is dropped as well.
 *
 * The native store also drops a link that is nothing but `https://` and one
 * longer than `CALL_CONTACT_AVATAR_MAX`, so both are dropped here.
 */
function cleanAvatar(raw: unknown): string | undefined {
  return typeof raw === "string" &&
    raw.startsWith(AVATAR_PREFIX) &&
    raw.length > AVATAR_PREFIX.length &&
    raw.length <= CALL_CONTACT_AVATAR_MAX
    ? raw
    : undefined;
}

/** A conversation's last activity, with anything unusable sorting as oldest. */
function recency(lastActiveAt: unknown): number {
  return typeof lastActiveAt === "number" && Number.isFinite(lastActiveAt)
    ? lastActiveAt
    : -Infinity;
}

/**
 * Sorts conversations most recently active first. Two with the same time are
 * ordered by id, so the result does not depend on the order the caller's
 * store happened to list them in.
 */
function byRecency(
  a: { id: string; lastActiveAt: number },
  b: { id: string; lastActiveAt: number },
): number {
  const aTime = recency(a.lastActiveAt);
  const bTime = recency(b.lastActiveAt);
  if (aTime !== bTime) return aTime > bTime ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the list from the signed-in user's conversations and friends.
 *
 * People come first from the conversations, most recently active
 * conversation first and in the order each one lists its members, and then
 * from the friends in the order given. So when the cap cuts the list, the
 * people most likely to call are the ones kept. Each person appears once, at
 * the first place they turn up. The signed-in user is never listed.
 *
 * A person is skipped when `users` has no entry for them, when their name is
 * empty after trimming, or when their id is empty or longer than
 * `CALL_CONTACT_ID_MAX`. A skipped person does not count towards the cap. A
 * photo link is kept only when it is an `https://` link of a usable length
 * (see `cleanAvatar`), and the `avatar` key is absent otherwise.
 *
 * `channels` holds the group chats that have a name, in the same order, at
 * most `CALL_CONTACTS_MAX_CHANNELS` of them. The same id rule applies. A
 * direct message is never listed there: its ring is named after the person.
 *
 * Every limit here is one the native store applies as well, so the store
 * keeps the whole list unchanged.
 *
 * The same input always gives the same output, and the input is not changed.
 */
export function buildCallContacts(input: {
  selfId: string;
  conversations: {
    id: string;
    type: "DirectMessage" | "Group";
    name?: string;
    memberIds: string[];
    lastActiveAt: number;
  }[];
  friendIds: string[];
  users: Record<string, { name: string; avatar?: string } | undefined>;
}): CallContacts {
  // `filter` copies, so sorting leaves the caller's array alone. A type other
  // than the two below cannot ring, so such an entry contributes nothing even
  // if one is passed in by mistake.
  const ordered = input.conversations
    .filter(
      (conversation) =>
        conversation.type === "DirectMessage" || conversation.type === "Group",
    )
    .sort(byRecency);

  const users: CallContactUser[] = [];
  const listed = new Set<string>();

  const add = (id: string) => {
    if (users.length >= CALL_CONTACTS_MAX_USERS) return;
    if (!usableId(id) || id === input.selfId) return;
    if (listed.has(id)) return;
    // An own-property check, so an id such as "constructor" cannot pick up
    // something inherited from the object's prototype.
    if (!Object.prototype.hasOwnProperty.call(input.users, id)) return;
    const known = input.users[id];
    const name = cleanName(known?.name);
    if (name === undefined) return;
    listed.add(id);
    const avatar = cleanAvatar(known?.avatar);
    users.push(avatar === undefined ? { id, name } : { id, name, avatar });
  };

  for (const conversation of ordered) {
    for (const id of conversation.memberIds) add(id);
  }
  for (const id of input.friendIds) add(id);

  const channels: CallContactChannel[] = [];
  const listedChannels = new Set<string>();
  for (const conversation of ordered) {
    if (channels.length >= CALL_CONTACTS_MAX_CHANNELS) break;
    if (conversation.type !== "Group") continue;
    const id = conversation.id;
    if (!usableId(id) || listedChannels.has(id)) continue;
    const name = cleanName(conversation.name);
    if (name === undefined) continue;
    listedChannels.add(id);
    channels.push({ id, name });
  }

  return { users, channels };
}

/**
 * Stable string of a list, so a caller can skip sending an unchanged one.
 *
 * Two lists get the same key exactly when they hold the same people and
 * groups, with the same names and photo links, in the same order. The fields
 * are read by name and written as JSON, so the key does not depend on the
 * order an object's keys were set in, and no name can be mistaken for a
 * separator.
 */
export function callContactsKey(list: CallContacts): string {
  return JSON.stringify([
    list.users.map((user) => [user.id, user.name, user.avatar ?? null]),
    list.channels.map((channel) => [channel.id, channel.name]),
  ]);
}

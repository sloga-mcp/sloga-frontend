// Unit spec for the call contact list builder. Run with Node's built-in runner:
//   node --conditions=browser --test components/client/callContacts.test.ts
// Declared test count: 33 (compare this against the runner's pass count, since
// the runner also exits 0 when it finds no tests at all).
// Focus: the list never names the signed-in user, names each person once at
// the first place they turn up, puts the most recently active conversation's
// members first and friends after, and stops at the cap. A name is trimmed and
// cut, and a photo link survives only when it is an https link. Group chats
// are listed only when they have a name, and a direct message never is. The
// key is equal for equal lists and changes with a name, a photo or the order.
// The phone's store (CallContactStore.java) has limits of its own on ids,
// photo links, names and the number of group chats. The builder applies the
// same ones, so the store keeps a built list whole and the key does not move
// when only something the store drops has changed.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CallContacts,
  buildCallContacts,
  CALL_CONTACT_AVATAR_MAX,
  CALL_CONTACT_ID_MAX,
  CALL_CONTACT_NAME_MAX,
  CALL_CONTACTS_MAX_CHANNELS,
  CALL_CONTACTS_MAX_USERS,
  callContactsKey,
} from "./callContacts.ts";

type BuildInput = Parameters<typeof buildCallContacts>[0];
type Conversation = BuildInput["conversations"][number];

/** The signed-in user's id in every fixture. */
const SELF = "self";

/** The start of a photo link the builder keeps. The host is obviously fake. */
const PHOTO = "https://media.example.invalid/avatars/";

/** A direct message between the signed-in user and one other person. */
function dm(id: string, other: string, lastActiveAt: number): Conversation {
  return { id, type: "DirectMessage", memberIds: [SELF, other], lastActiveAt };
}

/** A group chat holding the signed-in user and the others, named or not. */
function group(
  id: string,
  others: string[],
  lastActiveAt: number,
  name?: string,
): Conversation {
  const conversation: Conversation = {
    id,
    type: "Group",
    memberIds: [SELF, ...others],
    lastActiveAt,
  };
  if (name !== undefined) conversation.name = name;
  return conversation;
}

/** A `users` record that knows each id under the name "Name <id>". */
function known(...ids: string[]): BuildInput["users"] {
  const users: BuildInput["users"] = {};
  for (const id of ids) users[id] = { name: `Name ${id}` };
  return users;
}

/** Runs the builder with empty defaults for whatever the test leaves out. */
function build(partial: Partial<BuildInput>): CallContacts {
  return buildCallContacts({
    selfId: SELF,
    conversations: [],
    friendIds: [],
    users: {},
    ...partial,
  });
}

/** The people of a list, as ids in order. */
function ids(list: CallContacts): string[] {
  return list.users.map((user) => user.id);
}

/** The name the builder gives one friend whose stored name is `raw`. */
function nameFor(raw: string): string | undefined {
  return build({ friendIds: ["p"], users: { p: { name: raw } } }).users.at(0)
    ?.name;
}

/** Freezes a value all the way down, so any write to it throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// The odd characters below are made from their numbers, so this file holds no
// escape that an editor could turn into the character itself.

/** A control character. The store's trim removes it, JavaScript's does not. */
const CTRL = String.fromCharCode(0x01);

/** The last control character before the space, trimmed the same way. */
const CTRL_LAST = String.fromCharCode(0x1f);

/** A no-break space. JavaScript's trim removes it, the store's does not. */
const NBSP = String.fromCharCode(0xa0);

/** A whole emoji, which is two UTF-16 units. */
const EMOJI = String.fromCodePoint(0x1f600);

/** The first unit of that emoji by itself, as a cut can leave it. */
const HALF = EMOJI.charAt(0);

/** A name as `nameOf` in CallContactStore.java stores it. */
function storeName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Java's `trim` removes every unit up to U+0020 from both ends.
  let start = 0;
  let end = raw.length;
  while (start < end && raw.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && raw.charCodeAt(end - 1) <= 0x20) end -= 1;
  let name = raw.slice(start, end).slice(0, 64);
  const last = name.charCodeAt(name.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) name = name.slice(0, -1);
  return name === "" ? undefined : name;
}

/** Whether `idOf` in CallContactStore.java accepts an id. */
function storeTakesId(id: unknown): boolean {
  return typeof id === "string" && id !== "" && id.length <= 64;
}

/** Whether `isHttpsUrl` in CallContactStore.java accepts a photo link. */
function storeTakesAvatar(avatar: unknown): avatar is string {
  return (
    typeof avatar === "string" &&
    avatar.startsWith("https://") &&
    avatar.length > "https://".length &&
    avatar.length <= 2048
  );
}

/**
 * What the phone's store keeps of a list, written from `putUsers` and
 * `putChannels` in CallContactStore.java. The numbers are typed out again
 * instead of taken from the builder, so a wrong constant there shows up here.
 */
function storeKeeps(list: CallContacts): CallContacts {
  const users: CallContacts["users"] = [];
  const seenUsers = new Set<string>();
  for (const user of list.users) {
    if (seenUsers.size >= 2000) break;
    const name = storeName(user.name);
    if (!storeTakesId(user.id) || name === undefined) continue;
    if (seenUsers.has(user.id)) continue;
    seenUsers.add(user.id);
    users.push(
      storeTakesAvatar(user.avatar)
        ? { id: user.id, name, avatar: user.avatar }
        : { id: user.id, name },
    );
  }

  const channels: CallContacts["channels"] = [];
  const seenChannels = new Set<string>();
  for (const channel of list.channels) {
    if (seenChannels.size >= 500) break;
    const name = storeName(channel.name);
    if (!storeTakesId(channel.id) || name === undefined) continue;
    if (seenChannels.has(channel.id)) continue;
    seenChannels.add(channel.id);
    channels.push({ id: channel.id, name });
  }

  return { users, channels };
}

/** An input that exercises ordering, duplicates, skips and both list halves. */
function sampleInput(): BuildInput {
  return {
    selfId: SELF,
    conversations: [
      group("g-old", ["alice", "bob"], 10, "Old crew"),
      dm("d-new", "carol", 40),
      group("g-mid", ["bob", "dave", "ghost"], 30, "  Mid crew  "),
      dm("d-tie-b", "erin", 20),
      dm("d-tie-a", "frank", 20),
      group("g-none", ["alice"], 5),
    ],
    friendIds: ["frank", "grace", SELF, "alice"],
    users: {
      [SELF]: { name: "Me", avatar: `${PHOTO}self` },
      alice: { name: "  Alice  ", avatar: `${PHOTO}alice` },
      bob: { name: "Bob", avatar: "http://media.example.invalid/avatars/bob" },
      carol: { name: "Carol" },
      dave: { name: "   " },
      erin: { name: "Erin" },
      frank: { name: "Frank" },
      grace: { name: "Grace", avatar: `${PHOTO}grace` },
      ghost: undefined,
    },
  };
}

test("constants: the cap and the name limit are the agreed values", () => {
  assert.equal(CALL_CONTACTS_MAX_USERS, 2000);
  assert.equal(CALL_CONTACT_NAME_MAX, 64);
  // The same numbers as MAX_CHANNELS, ID_MAX and AVATAR_MAX in the store.
  assert.equal(CALL_CONTACTS_MAX_CHANNELS, 500);
  assert.equal(CALL_CONTACT_ID_MAX, 64);
  assert.equal(CALL_CONTACT_AVATAR_MAX, 2048);
});

test("self: the signed-in user is never listed", () => {
  const out = build({
    conversations: [
      dm("d1", "alice", 30),
      group("g1", ["bob", SELF], 20, "Team"),
    ],
    friendIds: [SELF, "carol"],
    users: known(SELF, "alice", "bob", "carol"),
  });
  assert.deepEqual(ids(out), ["alice", "bob", "carol"]);

  // Nobody else at all: the list is empty, not a list of one.
  const alone = build({
    conversations: [
      { id: "d2", type: "DirectMessage", memberIds: [SELF], lastActiveAt: 1 },
    ],
    friendIds: [SELF],
    users: known(SELF),
  });
  assert.deepEqual(alone.users, []);
});

test("duplicates: a person appears once, at the first place they turn up", () => {
  const out = build({
    conversations: [
      group("g-old", ["alice", "bob", "alice"], 10, "Old"),
      dm("d-new", "bob", 30),
      group("g-mid", ["carol", "bob", "alice"], 20, "Mid"),
    ],
    friendIds: ["alice", "dave", "carol", "dave"],
    users: known("alice", "bob", "carol", "dave"),
  });
  // Bob from the newest chat, Carol and Alice from the next one, and only
  // Dave is left for the friends to add.
  assert.deepEqual(ids(out), ["bob", "carol", "alice", "dave"]);
  assert.equal(new Set(ids(out)).size, out.users.length);
});

test("order: the most recently active conversation's members first, friends after", () => {
  const out = build({
    // Listed oldest first, so the builder has to do the ordering.
    conversations: [
      dm("d1", "old", 100),
      group("g1", ["mid-a", "mid-b"], 200, "Mid"),
      dm("d2", "new", 300),
    ],
    friendIds: ["friend-b", "friend-a"],
    users: known("old", "mid-a", "mid-b", "new", "friend-a", "friend-b"),
  });
  assert.deepEqual(ids(out), [
    "new",
    "mid-a",
    "mid-b",
    "old",
    "friend-b",
    "friend-a",
  ]);
});

test("order: equal times fall back to the conversation id, unusable times go last", () => {
  const a = dm("chan-a", "alice", 50);
  const b = dm("chan-b", "bob", 50);
  for (const conversations of [
    [a, b],
    [b, a],
  ]) {
    const out = build({ conversations, users: known("alice", "bob") });
    assert.deepEqual(ids(out), ["alice", "bob"]);
  }

  const out = build({
    conversations: [
      dm("n1", "nan", Number.NaN),
      dm("i1", "inf", Number.POSITIVE_INFINITY),
      dm("z1", "zero", 0),
      dm("m1", "minus", -5),
    ],
    users: known("nan", "inf", "zero", "minus"),
  });
  assert.deepEqual(ids(out), ["zero", "minus", "inf", "nan"]);
});

test("unknown people: an id with no entry in users is skipped", () => {
  const users = known("alice");
  users.ghost = undefined;
  const out = build({
    conversations: [group("g1", ["missing", "ghost", "alice", ""], 10, "Team")],
    // The last four exist on every object's prototype, and must not be
    // mistaken for entries.
    friendIds: [
      "nobody",
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ],
    users,
  });
  assert.deepEqual(out.users, [{ id: "alice", name: "Name alice" }]);
});

test("ids: a person whose id is over the limit is left out", () => {
  const fits = "u".repeat(CALL_CONTACT_ID_MAX);
  const over = "w".repeat(CALL_CONTACT_ID_MAX + 1);
  const farOver = "z".repeat(500);
  const out = build({
    conversations: [group("g1", ["alice", over, fits], 10, "Team")],
    friendIds: [farOver, "bob"],
    // Everyone has an entry, so the id is the only reason to leave one out.
    users: known("alice", over, fits, farOver, "bob"),
  });
  assert.deepEqual(ids(out), ["alice", fits, "bob"]);
  // An id is never cut to fit, because a shorter id would be somebody else.
  assert.equal(
    ids(out).some((id) => id.startsWith("w") || id.startsWith("z")),
    false,
  );
});

test("ids: a group chat whose id is over the limit is left out, its members stay", () => {
  const fits = "g".repeat(CALL_CONTACT_ID_MAX);
  const over = "h".repeat(CALL_CONTACT_ID_MAX + 1);
  const out = build({
    conversations: [
      group(over, ["alice"], 30, "Too long"),
      group(fits, ["bob"], 20, "Fits"),
    ],
    users: known("alice", "bob"),
  });
  assert.deepEqual(out.channels, [{ id: fits, name: "Fits" }]);
  assert.deepEqual(ids(out), ["alice", "bob"]);
});

test("names: trimmed at both ends, inner spacing kept", () => {
  assert.equal(nameFor("  Alice  "), "Alice");
  assert.equal(nameFor("\n\tBob\u00a0"), "Bob");
  assert.equal(nameFor("Mary  Ann"), "Mary  Ann");
});

test("names: cut to the limit", () => {
  const max = CALL_CONTACT_NAME_MAX;
  assert.equal(nameFor("x".repeat(max)), "x".repeat(max));
  assert.equal(nameFor("x".repeat(max + 1)), "x".repeat(max));
  assert.equal(nameFor("x".repeat(500)), "x".repeat(max));
  // Trimmed first, so outer whitespace does not use up the limit.
  assert.equal(nameFor("  " + "y".repeat(max + 6) + "  "), "y".repeat(max));
  // The cut can land in whitespace, which is trimmed off again.
  assert.equal(nameFor("a" + " ".repeat(max + 6) + "b"), "a");
  // An emoji that straddles the limit is dropped whole.
  assert.equal(
    nameFor("a".repeat(max - 1) + "\u{1f600}tail"),
    "a".repeat(max - 1),
  );
  // One that ends exactly on the limit is kept whole.
  const fits = nameFor("a".repeat(max - 2) + "\u{1f600}tail");
  assert.equal(fits, "a".repeat(max - 2) + "\u{1f600}");
  assert.equal(fits?.length, max);
});

test("names: an empty name skips the person", () => {
  for (const raw of ["", "   ", "\n\t \u00a0"]) {
    assert.equal(nameFor(raw), undefined, JSON.stringify(raw));
  }
  // A partly loaded user can reach the builder with no name at all.
  assert.equal(nameFor(undefined as unknown as string), undefined);
  assert.equal(nameFor(42 as unknown as string), undefined);

  // The skipped person does not stop the ones after them.
  const out = build({
    conversations: [group("g1", ["blank", "alice"], 10, "Team")],
    friendIds: ["blank", "bob"],
    users: { ...known("alice", "bob"), blank: { name: "  " } },
  });
  assert.deepEqual(ids(out), ["alice", "bob"]);
});

test("names: what the phone's store trims is trimmed here too", () => {
  // A control character is not whitespace to JavaScript, but the store's
  // trim removes every unit up to U+0020.
  assert.equal(nameFor(CTRL + "Alice" + CTRL_LAST), "Alice");
  assert.equal(nameFor(String.fromCharCode(0) + "Bob" + CTRL), "Bob");
  // Mixed with what only JavaScript trims, in either order.
  assert.equal(nameFor(NBSP + CTRL + " Carol " + CTRL + NBSP), "Carol");
  assert.equal(nameFor(CTRL + NBSP + "Dave" + NBSP + CTRL), "Dave");
  // Inside a name it is left alone, as the store leaves it.
  assert.equal(nameFor("Mary" + CTRL + "Ann"), "Mary" + CTRL + "Ann");
  // Trimmed before the cut, so it does not use up the limit.
  assert.equal(
    nameFor(CTRL.repeat(10) + "y".repeat(CALL_CONTACT_NAME_MAX) + CTRL),
    "y".repeat(CALL_CONTACT_NAME_MAX),
  );
  // Nothing else in the name is no name, and the person is skipped.
  for (const raw of [CTRL, CTRL + CTRL_LAST, CTRL + " " + NBSP + CTRL]) {
    assert.equal(nameFor(raw), undefined, JSON.stringify(raw));
  }
});

test("names: trimmed again after the cut, by the store's rule as well", () => {
  const max = CALL_CONTACT_NAME_MAX;
  // The cut lands in a run the store's trim would remove.
  assert.equal(nameFor("a" + CTRL.repeat(max + 6) + "b"), "a");
  assert.equal(nameFor("a" + (" " + CTRL + NBSP).repeat(max) + "b"), "a");
  // A straddling emoji goes whole, and the space in front of it goes too.
  assert.equal(
    nameFor("a".repeat(max - 2) + " " + EMOJI + "tail"),
    "a".repeat(max - 2),
  );
});

test("names: half an emoji left at the end is dropped", () => {
  // The store drops it from any name, not only from one that was cut.
  assert.equal(nameFor("abc" + HALF), "abc");
  // What that exposes is trimmed, and the same again until nothing changes.
  assert.equal(nameFor("abc " + HALF), "abc");
  assert.equal(nameFor("abc" + HALF + " " + HALF + CTRL), "abc");
  assert.equal(nameFor(HALF), undefined);
  // A whole emoji at the end stays, and so does a second half by itself.
  assert.equal(nameFor("abc" + EMOJI), "abc" + EMOJI);
  assert.equal(nameFor("abc" + EMOJI.charAt(1)), "abc" + EMOJI.charAt(1));
});

test("avatar: kept only for an https link", () => {
  const kept = [`${PHOTO}a1`, `${PHOTO}a1/original?v=2`];
  for (const avatar of kept) {
    const out = build({
      friendIds: ["p"],
      users: { p: { name: "Pat", avatar } },
    });
    assert.deepEqual(out.users, [{ id: "p", name: "Pat", avatar }], avatar);
  }

  const dropped: unknown[] = [
    "http://media.example.invalid/avatars/a1",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "/avatars/a1",
    "avatars/a1",
    "./avatars/a1",
    "//media.example.invalid/avatars/a1",
    "",
    " https://media.example.invalid/avatars/a1",
    "HTTPS://media.example.invalid/avatars/a1",
    "https:/media.example.invalid/avatars/a1",
    "https:media.example.invalid/avatars/a1",
    "blob:https://app.example.invalid/1234",
    "file:///sdcard/a1.png",
    "content://media/external/images/1",
    "ftp://media.example.invalid/avatars/a1",
    undefined,
    null,
    42,
  ];
  for (const avatar of dropped) {
    const out = build({
      friendIds: ["p"],
      users: { p: { name: "Pat", avatar: avatar as string } },
    });
    // The person stays, without a photo, and the key is gone rather than
    // set to undefined.
    assert.deepEqual(out.users, [{ id: "p", name: "Pat" }], String(avatar));
    assert.deepEqual(Object.keys(out.users.at(0) ?? {}), ["id", "name"]);
  }
});

test("avatar: a link over the length limit is dropped and the person stays", () => {
  const fits = PHOTO + "a".repeat(CALL_CONTACT_AVATAR_MAX - PHOTO.length);
  assert.equal(fits.length, CALL_CONTACT_AVATAR_MAX);
  const out = build({
    friendIds: ["p", "q", "r"],
    users: {
      p: { name: "Pat", avatar: fits },
      q: { name: "Quinn", avatar: fits + "a" },
      r: { name: "Rae", avatar: PHOTO + "a".repeat(10_000) },
    },
  });
  assert.deepEqual(out.users, [
    { id: "p", name: "Pat", avatar: fits },
    { id: "q", name: "Quinn" },
    { id: "r", name: "Rae" },
  ]);
  // The key is gone rather than set to undefined, and nothing is cut to fit.
  assert.deepEqual(Object.keys(out.users.at(1) ?? {}), ["id", "name"]);
  assert.deepEqual(Object.keys(out.users.at(2) ?? {}), ["id", "name"]);
});

test("avatar: https:// with nothing after it is dropped", () => {
  const out = build({
    friendIds: ["p", "q"],
    users: {
      p: { name: "Pat", avatar: "https://" },
      q: { name: "Quinn", avatar: "https://x" },
    },
  });
  assert.deepEqual(out.users, [
    { id: "p", name: "Pat" },
    { id: "q", name: "Quinn", avatar: "https://x" },
  ]);
  assert.deepEqual(Object.keys(out.users.at(0) ?? {}), ["id", "name"]);
});

test("cap: 2 500 people in, the first 2 000 by order out", () => {
  const users: BuildInput["users"] = {};
  const conversations: Conversation[] = [];
  const friendIds: string[] = [];
  // 15 groups of 100 people. A higher number is more recently active, and
  // they are listed oldest first so the builder has to do the ordering.
  for (let g = 0; g < 15; g++) {
    const members: string[] = [];
    for (let m = 0; m < 100; m++) {
      const id = `g${g}-m${m}`;
      members.push(id);
      users[id] = { name: `Member ${id}` };
    }
    conversations.push(group(`group-${g}`, members, 1_000 + g, `Group ${g}`));
  }
  for (let f = 0; f < 1_000; f++) {
    const id = `friend-${f}`;
    friendIds.push(id);
    users[id] = { name: `Friend ${f}` };
  }
  assert.equal(Object.keys(users).length, 2_500);

  const expected: string[] = [];
  for (let g = 14; g >= 0; g--) {
    for (let m = 0; m < 100; m++) expected.push(`g${g}-m${m}`);
  }
  expected.push(...friendIds);
  assert.equal(expected.length, 2_500);

  const out = build({ conversations, friendIds, users });
  assert.equal(out.users.length, CALL_CONTACTS_MAX_USERS);
  assert.deepEqual(ids(out), expected.slice(0, 2_000));
  // All 1 500 group members made it, then the first 500 friends.
  assert.equal(out.users.at(-1)?.id, "friend-499");
  // The cap is on people. It does not cut the group chats.
  assert.equal(out.channels.length, 15);
});

test("cap: it can land inside a conversation and leave no room for friends", () => {
  const users: BuildInput["users"] = {};
  const conversations: Conversation[] = [];
  // 20 groups of 150 people, a higher number being more recently active.
  for (let g = 0; g < 20; g++) {
    const members: string[] = [];
    for (let m = 0; m < 150; m++) {
      const id = `g${g}-m${m}`;
      members.push(id);
      users[id] = { name: `Member ${id}` };
    }
    conversations.push(group(`group-${g}`, members, 1_000 + g, `Group ${g}`));
  }
  const friendIds = ["friend-0", "friend-1"];
  for (const id of friendIds) users[id] = { name: `Name ${id}` };
  assert.equal(Object.keys(users).length, 3_002);

  const expected: string[] = [];
  for (let g = 19; g >= 0; g--) {
    for (let m = 0; m < 150; m++) expected.push(`g${g}-m${m}`);
  }

  const out = build({ conversations, friendIds, users });
  assert.equal(out.users.length, CALL_CONTACTS_MAX_USERS);
  assert.deepEqual(ids(out), expected.slice(0, 2_000));
  // The 13 newest groups hold 1 950 people, so the cut falls inside the
  // 14th: its 50th member is the last one in.
  assert.equal(out.users.at(-1)?.id, "g6-m49");
  assert.equal(
    ids(out).some((id) => id.startsWith("friend-")),
    false,
  );
});

test("cap: a skipped person does not use up a place", () => {
  const users: BuildInput["users"] = {};
  const friendIds: string[] = [];
  const listed: string[] = [];
  // Every third friend is unknown, which leaves 2 200 who can be listed.
  for (let f = 0; f < 3_300; f++) {
    const id = `friend-${f}`;
    friendIds.push(id);
    if (f % 3 === 0) continue;
    users[id] = { name: `Friend ${f}` };
    listed.push(id);
  }
  assert.equal(listed.length, 2_200);

  const out = build({ friendIds, users });
  assert.equal(out.users.length, CALL_CONTACTS_MAX_USERS);
  assert.deepEqual(ids(out), listed.slice(0, 2_000));
});

test("cap: a person left out for their id does not use up a place", () => {
  const users: BuildInput["users"] = {};
  const friendIds: string[] = [];
  const listed: string[] = [];
  // Every third friend has an id over the limit, which leaves 2 200 others.
  // All of them are known, so the id is the only reason to leave one out.
  for (let f = 0; f < 3_300; f++) {
    const tooLong = f % 3 === 0;
    const id = tooLong ? `${"x".repeat(CALL_CONTACT_ID_MAX)}-${f}` : `id-${f}`;
    friendIds.push(id);
    users[id] = { name: `Friend ${f}` };
    if (!tooLong) listed.push(id);
  }
  assert.equal(listed.length, 2_200);

  const out = build({ friendIds, users });
  assert.equal(out.users.length, CALL_CONTACTS_MAX_USERS);
  assert.deepEqual(ids(out), listed.slice(0, 2_000));
});

test("cap: 600 named group chats in, the first 500 by order out", () => {
  const conversations: Conversation[] = [];
  const members: string[] = [];
  // A higher number is more recently active, and they are listed oldest
  // first so the builder has to do the ordering.
  for (let g = 0; g < 600; g++) {
    members.push(`member-${g}`);
    conversations.push(
      group(`group-${g}`, [`member-${g}`], 1_000 + g, `Group ${g}`),
    );
  }
  const expected: string[] = [];
  for (let g = 599; g >= 100; g--) expected.push(`group-${g}`);

  const out = build({ conversations, users: known(...members) });
  assert.equal(out.channels.length, CALL_CONTACTS_MAX_CHANNELS);
  assert.deepEqual(
    out.channels.map((channel) => channel.id),
    expected,
  );
  // The cap is on group chats. The people of all 600 are still listed.
  assert.equal(out.users.length, 600);

  // A group chat that is left out anyway does not use up a place. Of every
  // three here one has no name and one has an id over the limit, which
  // leaves 600 that can be listed. These are passed in newest first.
  const mixed: Conversation[] = [];
  const listed: string[] = [];
  for (let g = 0; g < 1_800; g++) {
    const kind = g % 3;
    const id =
      kind === 1 ? `${"x".repeat(CALL_CONTACT_ID_MAX)}-${g}` : `g-${g}`;
    mixed.push(group(id, [], 9_000 - g, kind === 0 ? undefined : `Group ${g}`));
    if (kind === 2) listed.push(id);
  }
  assert.equal(listed.length, 600);
  const cut = build({ conversations: mixed });
  assert.deepEqual(
    cut.channels.map((channel) => channel.id),
    listed.slice(0, 500),
  );
});

test("channels: named groups only, most recently active first", () => {
  const out = build({
    conversations: [
      group("g-old", ["alice"], 10, "  Old crew  "),
      dm("d1", "bob", 40),
      group("g-new", ["carol"], 30, "New crew"),
      group("g-blank", ["dave"], 20, "   "),
      group("g-none", ["erin"], 25),
      group("g-long", ["frank"], 5, "n".repeat(100)),
    ],
    users: known("alice", "bob", "carol", "dave", "erin", "frank"),
  });
  assert.deepEqual(out.channels, [
    { id: "g-new", name: "New crew" },
    { id: "g-old", name: "Old crew" },
    { id: "g-long", name: "n".repeat(CALL_CONTACT_NAME_MAX) },
  ]);
  // A group without a name still contributes its members.
  assert.deepEqual(ids(out), [
    "bob",
    "carol",
    "erin",
    "dave",
    "alice",
    "frank",
  ]);
});

test("channels: a direct message never appears, even when it carries a name", () => {
  const named: Conversation = { ...dm("d1", "alice", 10), name: "Alice" };
  const out = build({
    conversations: [named, dm("d2", "bob", 5)],
    users: known("alice", "bob"),
  });
  assert.deepEqual(out.channels, []);
  assert.deepEqual(ids(out), ["alice", "bob"]);
});

test("channels: an empty id is skipped and a repeated id is listed once", () => {
  const out = build({
    conversations: [
      group("", ["alice"], 30, "No id"),
      group("g1", ["bob"], 20, "First"),
      group("g1", ["carol"], 10, "Second"),
    ],
    users: known("alice", "bob", "carol"),
  });
  assert.deepEqual(out.channels, [{ id: "g1", name: "First" }]);
  assert.deepEqual(ids(out), ["alice", "bob", "carol"]);
});

test("conversations: a type that cannot ring contributes nothing", () => {
  const serverChannel = {
    id: "t1",
    type: "TextChannel",
    name: "general",
    memberIds: ["alice"],
    lastActiveAt: 99,
  } as unknown as Conversation;
  const out = build({
    conversations: [serverChannel, dm("d1", "bob", 1)],
    users: known("alice", "bob"),
  });
  assert.deepEqual(ids(out), ["bob"]);
  assert.deepEqual(out.channels, []);
});

test("determinism: the same input twice gives equal output and is left untouched", () => {
  const input = sampleInput();
  const before = structuredClone(input);

  const first = buildCallContacts(input);
  const second = buildCallContacts(input);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.users, second.users);
  assert.deepEqual(input, before);

  // The whole expected list, so the order itself is pinned here too.
  assert.deepEqual(first, {
    users: [
      { id: "carol", name: "Carol" },
      { id: "bob", name: "Bob" },
      { id: "frank", name: "Frank" },
      { id: "erin", name: "Erin" },
      { id: "alice", name: "Alice", avatar: `${PHOTO}alice` },
      { id: "grace", name: "Grace", avatar: `${PHOTO}grace` },
    ],
    channels: [
      { id: "g-mid", name: "Mid crew" },
      { id: "g-old", name: "Old crew" },
    ],
  });

  // A frozen input makes any write to it throw, including an in-place sort.
  const frozen = deepFreeze(structuredClone(before));
  assert.deepEqual(buildCallContacts(frozen), first);
});

test("determinism: the order the conversations are passed in does not matter", () => {
  const input = sampleInput();
  const reversed: BuildInput = {
    ...input,
    conversations: [...input.conversations].reverse(),
  };
  assert.deepEqual(buildCallContacts(reversed), buildCallContacts(input));
});

test("store: the phone keeps a built list exactly as it was sent", () => {
  // The model of the store has to refuse things, or agreeing with it would
  // show nothing. Each entry here breaks one of the store's rules.
  const refused = storeKeeps({
    users: [
      { id: "i".repeat(65), name: "Long id" },
      { id: "a", name: `${CTRL}Alice `, avatar: "https://" },
      { id: "b", name: `Bob${HALF}`, avatar: PHOTO + "b".repeat(2_048) },
      { id: "c", name: CTRL },
      { id: "a", name: "Alice again" },
    ],
    channels: [
      { id: "h".repeat(65), name: "Long id" },
      { id: "g", name: "n".repeat(70) },
    ],
  });
  assert.deepEqual(refused, {
    users: [
      { id: "a", name: "Alice" },
      { id: "b", name: "Bob" },
    ],
    channels: [{ id: "g", name: "n".repeat(64) }],
  });

  // Names that are awkward at an end, before the cut or after it.
  const awkward = [
    "  Alice  ",
    `${CTRL}Alice${CTRL_LAST}`,
    `${NBSP}${CTRL} Alice ${CTRL}${NBSP}`,
    `Alice${HALF}`,
    `Alice ${HALF}`,
    `Alice${HALF} ${HALF}${CTRL}`,
    `Alice${NBSP}${HALF}`,
    `${EMOJI}Alice${EMOJI}`,
    "x".repeat(200),
    `a${" ".repeat(70)}b`,
    `a${CTRL.repeat(70)}b`,
    `a${NBSP.repeat(70)}b`,
    `a${(" " + CTRL + NBSP + HALF).repeat(40)}b`,
    "a".repeat(63) + EMOJI + "tail",
    "a".repeat(62) + EMOJI + "tail",
    "a".repeat(62) + " " + EMOJI + "tail",
    "a".repeat(62) + CTRL + EMOJI + "tail",
    "a".repeat(61) + HALF + CTRL + EMOJI + "tail",
    `${CTRL.repeat(30)}${"y".repeat(80)}${CTRL.repeat(30)}`,
    CTRL,
    NBSP,
    HALF,
    "",
  ];
  let named = 0;
  for (const raw of awkward) {
    const name = nameFor(raw);
    if (name === undefined) continue;
    named += 1;
    assert.equal(storeName(name), name, JSON.stringify(raw));
  }
  assert.equal(named, awkward.length - 4);

  // The same names in a whole list, with ids and photo links the store
  // would refuse mixed in.
  const photos = [
    `${PHOTO}ok`,
    "https://",
    PHOTO + "p".repeat(3_000),
    "http://media.example.invalid/avatars/plain",
    PHOTO + "p".repeat(CALL_CONTACT_AVATAR_MAX - PHOTO.length),
  ];
  const users: BuildInput["users"] = {};
  const friendIds: string[] = [];
  const conversations: Conversation[] = [];
  awkward.forEach((raw, index) => {
    const id = index % 7 === 3 ? `${"x".repeat(64)}-${index}` : `p${index}`;
    users[id] = { name: raw, avatar: photos[index % photos.length] };
    friendIds.push(id);
    const groupId =
      index % 5 === 2 ? `${"y".repeat(64)}-${index}` : `g${index}`;
    conversations.push(group(groupId, [id], index, raw));
  });
  const out = build({ conversations, friendIds, users });
  assert.equal(out.users.length > 10, true);
  assert.equal(out.channels.length > 10, true);
  assert.equal(
    out.users.some((user) => user.avatar !== undefined),
    true,
  );
  assert.deepEqual(storeKeeps(out), out);

  const sample = buildCallContacts(sampleInput());
  assert.deepEqual(storeKeeps(sample), sample);
});

test("key: equal lists give equal keys", () => {
  const first = buildCallContacts(sampleInput());
  const second = buildCallContacts(sampleInput());
  assert.notEqual(first, second);
  assert.equal(typeof callContactsKey(first), "string");
  assert.equal(callContactsKey(first), callContactsKey(second));
  assert.equal(callContactsKey(first), callContactsKey(first));

  const empty: CallContacts = { users: [], channels: [] };
  assert.equal(
    callContactsKey(empty),
    callContactsKey({ users: [], channels: [] }),
  );
  assert.notEqual(callContactsKey(empty), callContactsKey(first));
});

test("key: a changed name, photo or order gives a different key", () => {
  const alice = { id: "a", name: "Alice", avatar: `${PHOTO}a` };
  const bob = { id: "b", name: "Bob" };
  const team = { id: "g1", name: "Team" };
  const crew = { id: "g2", name: "Crew" };
  const users = [alice, bob];
  const channels = [team, crew];

  const changed: [string, CallContacts][] = [
    ["a name", { users: [{ ...alice, name: "Alicia" }, bob], channels }],
    ["a photo", { users: [{ ...alice, avatar: `${PHOTO}a2` }, bob], channels }],
    ["a photo removed", { users: [{ id: "a", name: "Alice" }, bob], channels }],
    [
      "a photo added",
      { users: [alice, { ...bob, avatar: `${PHOTO}b` }], channels },
    ],
    ["the order of people", { users: [bob, alice], channels }],
    ["a person's id", { users: [alice, { ...bob, id: "c" }], channels }],
    ["a person removed", { users: [alice], channels }],
    [
      "a person added",
      { users: [alice, bob, { id: "c", name: "Cy" }], channels },
    ],
    ["a group's name", { users, channels: [{ ...team, name: "Squad" }, crew] }],
    ["the order of groups", { users, channels: [crew, team] }],
    ["a group removed", { users, channels: [team] }],
  ];

  const baseKey = callContactsKey({ users, channels });
  const keys = new Set([baseKey]);
  for (const [what, list] of changed) {
    const key = callContactsKey(list);
    assert.notEqual(key, baseKey, what);
    keys.add(key);
  }
  // Every change is also told apart from every other one.
  assert.equal(keys.size, changed.length + 1);
});

test("key: object key order does not matter, and fields cannot run together", () => {
  const plain: CallContacts = {
    users: [{ id: "a", name: "Alice", avatar: `${PHOTO}a` }],
    channels: [{ id: "g1", name: "Team" }],
  };
  const shuffled: CallContacts = {
    channels: [{ name: "Team", id: "g1" }],
    users: [{ avatar: `${PHOTO}a`, name: "Alice", id: "a" }],
  };
  assert.equal(callContactsKey(shuffled), callContactsKey(plain));

  // A photo key set to undefined reads the same as no photo key.
  assert.equal(
    callContactsKey({
      users: [{ id: "b", name: "Bob", avatar: undefined }],
      channels: [],
    }),
    callContactsKey({ users: [{ id: "b", name: "Bob" }], channels: [] }),
  );

  // Text moved from one field to its neighbour is a different list.
  assert.notEqual(
    callContactsKey({ users: [{ id: "a,b", name: "c" }], channels: [] }),
    callContactsKey({ users: [{ id: "a", name: "b,c" }], channels: [] }),
  );
  assert.notEqual(
    callContactsKey({
      users: [{ id: "a", name: 'b"],["c","d' }],
      channels: [],
    }),
    callContactsKey({
      users: [
        { id: "a", name: "b" },
        { id: "c", name: "d" },
      ],
      channels: [],
    }),
  );
  // A person is not mistaken for a group with the same id and name.
  assert.notEqual(
    callContactsKey({ users: [{ id: "x", name: "X" }], channels: [] }),
    callContactsKey({ users: [], channels: [{ id: "x", name: "X" }] }),
  );
});

test("key: unchanged when only something the phone's store drops has changed", () => {
  const longPhoto = (fill: string) =>
    PHOTO + fill.repeat(CALL_CONTACT_AVATAR_MAX);
  const longId = "x".repeat(CALL_CONTACT_ID_MAX + 1);
  const longGroupId = "y".repeat(CALL_CONTACT_ID_MAX + 1);

  /** The key of one fixed input, with the named fields swapped. */
  const keyFor = (change: {
    photo?: string;
    alice?: string;
    stranger?: string;
    crew?: string;
  }) =>
    callContactsKey(
      build({
        conversations: [
          group("g1", ["alice", longId], 20, "Team"),
          group(longGroupId, ["bob"], 10, change.crew ?? "Crew"),
        ],
        friendIds: ["carol"],
        users: {
          alice: {
            name: change.alice ?? "Alice",
            avatar: change.photo ?? longPhoto("a"),
          },
          [longId]: { name: change.stranger ?? "Stranger" },
          bob: { name: "Bob", avatar: `${PHOTO}bob` },
          carol: { name: "Carol" },
        },
      }),
    );
  const base = keyFor({});

  const same: [string, string][] = [
    ["one over-long photo for another", keyFor({ photo: longPhoto("b") })],
    ["an over-long photo for a bare https://", keyFor({ photo: "https://" })],
    [
      "an over-long photo for an http link",
      keyFor({ photo: "http://media.example.invalid/avatars/alice" }),
    ],
    [
      "the name of a person whose id is too long",
      keyFor({ stranger: "Somebody else" }),
    ],
    [
      "the name of a group chat whose id is too long",
      keyFor({ crew: "Other crew" }),
    ],
    [
      "control characters around a name",
      keyFor({ alice: `${CTRL}Alice${CTRL_LAST}` }),
    ],
    ["whitespace around a name", keyFor({ alice: `${NBSP} Alice ` })],
    ["half an emoji after a name", keyFor({ alice: `Alice${HALF}` })],
  ];
  for (const [what, key] of same) assert.equal(key, base, what);

  // The same list with none of the dropped things in the input at all.
  const plain = build({
    conversations: [
      group("g1", ["alice"], 20, "Team"),
      group("g2", ["bob"], 10),
    ],
    friendIds: ["carol"],
    users: {
      alice: { name: "Alice" },
      bob: { name: "Bob", avatar: `${PHOTO}bob` },
      carol: { name: "Carol" },
    },
  });
  assert.equal(callContactsKey(plain), base);

  // The key still moves when something the store keeps has changed.
  const different: [string, string][] = [
    ["a photo the store keeps", keyFor({ photo: `${PHOTO}alice` })],
    ["a name the store keeps", keyFor({ alice: "Alicia" })],
  ];
  for (const [what, key] of different) assert.notEqual(key, base, what);
});

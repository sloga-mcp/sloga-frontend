// Unit spec for the friends list's derived data. Run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/friends/friendData.test.ts
// Declared test count: 12 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: the unread pill (muted hides everything, a zero count is a dot, the
// mention flag), the DM map keyed by the peer and never by us, and the group
// list's filter and recency order. `--conditions=browser` matters: Solid's
// server build never re-runs a memo, so the reactivity tests would pass there
// for the wrong reason or fail for no reason.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createRoot, createSignal } from "solid-js";

import type { Channel, Client, User } from "stoat.js";

import {
  conversationUnread,
  createDmMap,
  groupDms,
  isInGame,
} from "./friendData.ts";

type FakeChannel = {
  id: string;
  type: string;
  active?: boolean;
  recipientIds?: Set<string>;
  unread?: boolean;
  unreadCount?: number;
  muted?: boolean;
  mentions?: Set<string>;
  updatedAt?: Date;
};

const SELF = "self";

function ch(over: FakeChannel): Channel {
  return {
    active: true,
    recipientIds: new Set<string>(),
    unread: false,
    unreadCount: 0,
    muted: false,
    updatedAt: new Date(0),
    ...over,
  } as unknown as Channel;
}

function dm(id: string, peer: string, over: Partial<FakeChannel> = {}) {
  return ch({
    id,
    type: "DirectMessage",
    recipientIds: new Set([SELF, peer]),
    ...over,
  });
}

/** `null` = signed out; `undefined` would hit the default instead. */
function client(channels: Channel[], selfId: string | null = SELF) {
  return {
    user: selfId ? { id: selfId } : undefined,
    channels: { toList: () => [...channels] },
  } as unknown as Client;
}

/** Runs `fn` inside a root so memos are owned, then disposes it. */
function inRoot<T>(fn: () => T): T {
  return createRoot((dispose) => {
    try {
      return fn();
    } finally {
      dispose();
    }
  });
}

test("conversationUnread: no channel, or nothing unread, shows no pill", () => {
  assert.equal(conversationUnread(undefined), null);
  assert.equal(
    conversationUnread(ch({ id: "a", type: "DirectMessage" })),
    null,
  );
});

test("conversationUnread: muted hides the pill even with a mention", () => {
  const muted = ch({
    id: "a",
    type: "DirectMessage",
    unread: true,
    unreadCount: 5,
    muted: true,
    mentions: new Set(["m1"]),
  });
  assert.equal(conversationUnread(muted), null);
});

test("conversationUnread: an unread channel with count 0 is a dot, not hidden", () => {
  const dot = ch({ id: "a", type: "Group", unread: true, unreadCount: 0 });
  assert.deepEqual(conversationUnread(dot), { count: 0, mention: false });
});

test("conversationUnread: count and mention flag pass through", () => {
  const counted = ch({
    id: "a",
    type: "DirectMessage",
    unread: true,
    unreadCount: 100,
    mentions: new Set(["m1"]),
  });
  assert.deepEqual(conversationUnread(counted), { count: 100, mention: true });

  const emptyMentions = ch({
    id: "b",
    type: "DirectMessage",
    unread: true,
    unreadCount: 3,
    mentions: new Set(),
  });
  assert.deepEqual(conversationUnread(emptyMentions), {
    count: 3,
    mention: false,
  });
});

test("conversationUnread: missing mentions set reads as no mention", () => {
  const noSet = ch({
    id: "a",
    type: "DirectMessage",
    unread: true,
    unreadCount: 2,
  });
  assert.deepEqual(conversationUnread(noSet), { count: 2, mention: false });
});

test("isInGame: true only with an activity", () => {
  assert.equal(
    isInGame({ activity: { name: "Factorio" } } as unknown as User),
    true,
  );
  assert.equal(isInGame({ activity: undefined } as unknown as User), false);
});

test("createDmMap: keys each DM by the peer, never by us", () => {
  const a = dm("dm-a", "alice");
  const b = dm("dm-b", "bob", { active: false });
  const map = inRoot(() =>
    createDmMap(() =>
      client([
        a,
        b,
        ch({ id: "g", type: "Group", recipientIds: new Set([SELF, "carol"]) }),
        ch({ id: "s", type: "SavedMessages", recipientIds: new Set([SELF]) }),
        ch({ id: "t", type: "TextChannel" }),
      ]),
    )(),
  );

  assert.deepEqual([...map.keys()].sort(), ["alice", "bob"]);
  assert.equal(map.get("alice"), a);
  // A closed DM can still be unread, so it stays in the map.
  assert.equal(map.get("bob"), b);
  assert.equal(map.has(SELF), false);
  assert.equal(map.has("carol"), false);
});

test("createDmMap: an active DM wins over a closed one for the same peer", () => {
  const closed = dm("dm-1", "alice", { active: false });
  const open = dm("dm-2", "alice", { active: true });
  for (const order of [
    [closed, open],
    [open, closed],
  ]) {
    const map = inRoot(() => createDmMap(() => client(order))());
    assert.equal(map.get("alice"), open);
  }
});

test("createDmMap: no client or no signed-in user gives an empty map", () => {
  inRoot(() => {
    assert.equal(createDmMap(() => undefined)().size, 0);
    assert.equal(
      createDmMap(() => client([dm("dm-a", "alice")], null))().size,
      0,
    );
  });
});

test("createDmMap: follows a client swap", () => {
  createRoot((dispose) => {
    const [current, setCurrent] = createSignal<Client | undefined>(
      client([dm("dm-a", "alice")]),
    );
    const map = createDmMap(current);
    assert.deepEqual([...map().keys()], ["alice"]);

    setCurrent(client([dm("dm-b", "bob")]));
    assert.deepEqual([...map().keys()], ["bob"]);

    setCurrent(undefined);
    assert.equal(map().size, 0);
    dispose();
  });
});

test("groupDms: only groups, most recently active first", () => {
  const old = ch({ id: "g-old", type: "Group", updatedAt: new Date(1_000) });
  const mid = ch({ id: "g-mid", type: "Group", updatedAt: new Date(5_000) });
  const recent = ch({ id: "g-new", type: "Group", updatedAt: new Date(9_000) });
  const list = inRoot(() =>
    groupDms(() =>
      client([
        mid,
        dm("dm-a", "alice", { updatedAt: new Date(99_000) }),
        old,
        ch({ id: "t", type: "TextChannel", updatedAt: new Date(50_000) }),
        recent,
      ]),
    )(),
  );

  assert.deepEqual(
    list.map((c) => c.id),
    ["g-new", "g-mid", "g-old"],
  );
});

test("groupDms: empty without a client, and follows a client swap", () => {
  createRoot((dispose) => {
    const [current, setCurrent] = createSignal<Client | undefined>(undefined);
    // groupDms tracks the accessor inside its own memo; the lint rule only
    // recognises `create*` names as doing that.
    // eslint-disable-next-line solid/reactivity
    const list = groupDms(current);
    assert.deepEqual(list(), []);

    setCurrent(client([ch({ id: "g", type: "Group" })]));
    assert.deepEqual(
      list().map((c) => c.id),
      ["g"],
    );
    dispose();
  });
});

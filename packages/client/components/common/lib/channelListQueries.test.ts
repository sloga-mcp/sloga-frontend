// Unit spec for the cached channel-list guards, run with Node's built-in
// runner from packages/client:
//   node --conditions=browser --test components/common/lib/channelListQueries.test.ts
//
// stoat.js sweeps a left or deleted server's threads and forum posts out of
// `client.channels`, while the TanStack lists ("forum_posts", "threads") keep
// the old Channel objects for their gcTime. Those objects read an emptied
// store entry: `name` is undefined, and an A-Z forum threw on
// `post.name.toLowerCase()`. `cachedChannels` drops them from a list, and
// `isServerChannelListQuery` picks the lists to remove when a server goes.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHANNEL_LIST_QUERY_ROOTS,
  cachedChannels,
  isServerChannelListQuery,
} from "./channelListQueries.ts";

/**
 * A stand-in for the client's channel store, and Channel-like objects whose
 * getters read it by id, the way stoat.js Channel getters read the store.
 */
function storeOf(entries: Record<string, { name: string; server?: string }>) {
  const store = new Map(Object.entries(entries));
  const channel = (id: string) => ({
    id,
    get name() {
      return store.get(id)?.name as string;
    },
  });
  return { store, channel };
}

test("only channels still in the store are kept, in order, as the same objects", () => {
  const { store, channel } = storeOf({
    a: { name: "Alpha" },
    b: { name: "Bravo" },
    c: { name: "Charlie" },
  });
  const list = [channel("c"), channel("a"), channel("b")];
  store.delete("a");

  const kept = cachedChannels(list, (id) => store.has(id));

  assert.deepEqual(
    kept.map((post) => post.id),
    ["c", "b"],
  );
  assert.equal(kept[0], list[0]);
  assert.equal(kept[1], list[2]);
});

test("a fully cached list keeps every channel, and an empty list stays empty", () => {
  const { store, channel } = storeOf({ a: { name: "A" }, b: { name: "B" } });
  const list = [channel("a"), channel("b")];

  assert.deepEqual(
    cachedChannels(list, (id) => store.has(id)),
    list,
  );
  assert.deepEqual(
    cachedChannels([], () => true),
    [],
  );
});

test("the input list is not modified", () => {
  const list = [{ id: "a" }, { id: "b" }];
  cachedChannels(list, () => false);
  assert.deepEqual(list, [{ id: "a" }, { id: "b" }]);
});

test("an A-Z sort over the filtered posts of a swept server does not throw", () => {
  const { store, channel } = storeOf({
    p1: { name: "Zeta" },
    p2: { name: "alpha" },
    p3: { name: "Mid" },
  });
  const cachedPage = [channel("p1"), channel("p2"), channel("p3")];

  // The server is left, its posts are swept, and it is rejoined: only p3 has
  // been cached again so far.
  store.clear();
  store.set("p3", { name: "Mid" });

  const keyFor = (post: { id: string; name: string }) =>
    `${post.name.toLowerCase()}\0${post.id}`;

  assert.throws(() => cachedPage.map(keyFor), TypeError);
  assert.deepEqual(
    cachedChannels(cachedPage, (id) => store.has(id)).map(keyFor),
    ["mid\0p3"],
  );
});

test("forum post and thread lists under the server's channels are selected", () => {
  const servers: Record<string, string> = {
    forum: "S1",
    text: "S1",
    other: "S2",
  };
  const serverOf = (id: string) => servers[id];

  assert.equal(
    isServerChannelListQuery(
      ["forum_posts", "forum", "alphabetical", undefined, false, true],
      "S1",
      serverOf,
    ),
    true,
  );
  assert.equal(
    isServerChannelListQuery(["threads", "text", false], "S1", serverOf),
    true,
  );
  assert.equal(
    isServerChannelListQuery(["threads", "text", true], "S1", serverOf),
    true,
  );
});

test("lists under another server, a DM or an uncached channel are kept", () => {
  const servers: Record<string, string | undefined> = {
    forum: "S1",
    other: "S2",
    group: undefined,
  };
  const lookup = (id: string) => servers[id];

  assert.equal(
    isServerChannelListQuery(["forum_posts", "other"], "S1", lookup),
    false,
  );
  // A group's threads: the parent belongs to no server
  assert.equal(
    isServerChannelListQuery(["threads", "group", false], "S1", lookup),
    false,
  );
  assert.equal(
    isServerChannelListQuery(["threads", "gone", false], "S1", lookup),
    false,
  );
});

test("queries with another root or a malformed key are kept", () => {
  const serverOf = () => "S1";

  for (const key of [
    ["bans", "S1"],
    ["server_invites", "S1"],
    ["forum_posts"],
    ["threads", undefined, false],
    ["threads", 42],
    [{ root: "threads" }, "text"],
    [],
  ]) {
    assert.equal(
      isServerChannelListQuery(key, "S1", serverOf),
      false,
      JSON.stringify(key),
    );
  }
});

test("the roots are exactly the two channel-list query roots", () => {
  assert.deepEqual([...CHANNEL_LIST_QUERY_ROOTS].sort(), [
    "forum_posts",
    "threads",
  ]);
});

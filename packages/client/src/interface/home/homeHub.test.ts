// Unit spec for the Home page decisions — run with Node's built-in runner:
//   node --conditions=browser --test src/interface/home/homeHub.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CIPHER_BANNER_SNOOZE_MS,
  collectEvents,
  eventLink,
  fetchInOrder,
  HAPPENING_ROOM_LIMIT,
  HOME_DISCOVER_LIMIT,
  HOME_FRIEND_LIMIT,
  HOME_MENTION_LIMIT,
  HOME_MENTION_SCAN_LIMIT,
  isNewUser,
  JUMP_EVENT_LIMIT,
  JUMP_UNREAD_LIMIT,
  MENTION_PREVIEW_LENGTH,
  mentionPreview,
  parseEventLink,
  parseStoredTime,
  pickDiscover,
  pickHappening,
  pickMentionIds,
  pickOnlineFriends,
  pickUnreads,
  pickUpcoming,
  primaryConnection,
  releaseOf,
  showCipherBanner,
  showWhatsNew,
  streamThumbnail,
  upcomingRows,
} from "./homeHub.ts";

const NOW = 1_800_000_000_000;
const open = {
  allowsLinks: true,
  sale: "open" as const,
  hasCipher: false,
  hiddenAt: undefined,
  now: NOW,
};

test("the Cipher banner shows for a non-member while the sale is open", () => {
  assert.equal(showCipherBanner(open), true);
});

test("the Cipher banner hides unless every condition holds", () => {
  assert.equal(showCipherBanner({ ...open, allowsLinks: false }), false);
  assert.equal(showCipherBanner({ ...open, sale: undefined }), false);
  assert.equal(showCipherBanner({ ...open, sale: "closed" }), false);
  assert.equal(showCipherBanner({ ...open, sale: "soldOut" }), false);
  assert.equal(showCipherBanner({ ...open, hasCipher: true }), false);
});

test("dismissing the Cipher banner hides it for the snooze window", () => {
  const hidden = (ago: number) =>
    showCipherBanner({ ...open, hiddenAt: NOW - ago });
  assert.equal(hidden(0), false);
  assert.equal(hidden(CIPHER_BANNER_SNOOZE_MS - 1), false);
  assert.equal(hidden(CIPHER_BANNER_SNOOZE_MS), true);
  assert.equal(CIPHER_BANNER_SNOOZE_MS, 14 * 24 * 60 * 60 * 1000);
});

test("a dismissal stamped in the future counts as just now", () => {
  assert.equal(
    showCipherBanner({ ...open, hiddenAt: NOW + 10 * CIPHER_BANNER_SNOOZE_MS }),
    false,
  );
});

test("stored timestamps must be positive whole numbers", () => {
  assert.equal(parseStoredTime("1800000000000"), 1_800_000_000_000);
  for (const raw of [
    null,
    undefined,
    "",
    "0",
    "-5",
    "1.5",
    "abc",
    "1e9",
    " 12",
  ]) {
    assert.equal(parseStoredTime(raw), undefined, String(raw));
  }
  assert.equal(parseStoredTime("9".repeat(30)), undefined);
});

test("versions map to their release", () => {
  assert.equal(releaseOf("0.69.0"), "0.69");
  assert.equal(releaseOf("0.69.3"), "0.69");
  assert.equal(releaseOf("0.69"), "0.69");
  assert.equal(releaseOf("0.69.0-rc.1"), "0.69");
  assert.equal(releaseOf("1.02.0"), "1.2");
  for (const v of ["", undefined, "v0.69.0", "latest", "0", "0.69.0.1"]) {
    assert.equal(releaseOf(v), undefined, String(v));
  }
});

test("What's New shows in its own release until dismissed", () => {
  const card = (appVersion: string, dismissed?: string | null) =>
    showWhatsNew({ appVersion, highlightsRelease: "0.69", dismissed });
  assert.equal(card("0.69.0"), true);
  assert.equal(card("0.69.2", null), true);
  assert.equal(card("0.69.0", "0.68"), true);
  assert.equal(card("0.69.1", "0.69"), false);
  assert.equal(card("0.68.0"), false);
  assert.equal(card("0.70.0"), false);
  assert.equal(card("garbage"), false);
});

test("the welcome tiles are for accounts with no servers or no friends", () => {
  assert.equal(isNewUser(0, 0), true);
  assert.equal(isNewUser(0, 4), true);
  assert.equal(isNewUser(3, 0), true);
  assert.equal(isNewUser(3, 4), false);
});

test("a tile is about the first live channel, else the first channel", () => {
  const a = { platform: "Twitch" };
  const b = { platform: "YouTube", live: true };
  const c = { platform: "Kick", live: true };
  assert.equal(primaryConnection([a, b, c]), b);
  assert.equal(primaryConnection([a, { platform: "Kick", live: false }]), a);
  assert.equal(primaryConnection([]), undefined);
  assert.equal(primaryConnection(undefined), undefined);
});

test("no thumbnail field means no back face", () => {
  assert.equal(streamThumbnail(undefined), undefined);
  assert.equal(streamThumbnail({ platform: "Twitch", live: true }), undefined);
});

test("thumbnails load only from platform CDNs over https while live", () => {
  const live = (live_thumbnail: unknown, live = true) =>
    streamThumbnail({ platform: "Twitch", live, live_thumbnail });

  assert.equal(
    live("https://static-cdn.jtvnw.net/previews-ttv/live_user_x-440x248.jpg"),
    "https://static-cdn.jtvnw.net/previews-ttv/live_user_x-440x248.jpg",
  );
  assert.equal(
    live("https://i.ytimg.com/vi/abc/hqdefault_live.jpg"),
    "https://i.ytimg.com/vi/abc/hqdefault_live.jpg",
  );
  assert.equal(
    live("https://static-cdn.jtvnw.net/x.jpg", false),
    undefined,
    "offline",
  );

  for (const bad of [
    "http://static-cdn.jtvnw.net/x.jpg",
    "https://evil.example/x.jpg",
    "https://static-cdn.jtvnw.net.evil.example/x.jpg",
    "https://user:pw@static-cdn.jtvnw.net/x.jpg",
    "https://static-cdn.jtvnw.net:8443/x.jpg",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "//static-cdn.jtvnw.net/x.jpg",
    "not a url",
    "https://static-cdn.jtvnw.net/" + "a".repeat(2100),
    42,
    null,
    {},
  ]) {
    assert.equal(live(bad), undefined, String(bad).slice(0, 60));
  }
});

const unread = (
  id: string,
  overrides: Partial<{ unread: boolean; muted: boolean; mention: boolean }>,
) => ({ id, unread: true, muted: false, mention: false, ...overrides });

test("Unread lists the rail's unread items, mentions first, then rail order", () => {
  const picked = pickUnreads([
    unread("dm", { mention: true }),
    unread("quiet", {}),
    unread("read", { unread: false }),
    unread("muted", { muted: true, mention: true }),
    unread("pinged", { mention: true }),
    unread("later", {}),
  ]);
  assert.deepEqual(
    picked.map((item) => item.id),
    ["dm", "pinged", "quiet", "later"],
  );
});

test("Unread stops at its limit", () => {
  const many = Array.from({ length: 9 }, (_, i) => unread(`s${i}`, {}));
  assert.equal(pickUnreads(many).length, JUMP_UNREAD_LIMIT);
  assert.equal(JUMP_UNREAD_LIMIT, 4);
  assert.deepEqual(pickUnreads([]), []);
});

test("Happening now lists rooms with friends first, then the busiest", () => {
  const friends = new Set(["alice", "bob", "cara", "me"]);
  const rooms = [
    { channelId: "one", participantIds: ["alice", "stranger"] },
    { channelId: "crowd", participantIds: ["s1", "s2", "s3"] },
    { channelId: "two", participantIds: ["bob", "cara", "me"] },
    { channelId: "quiet", participantIds: ["s4"] },
    { channelId: "empty", participantIds: [] },
  ];
  const picked = pickHappening(rooms, friends, { viewerId: "me" });
  assert.deepEqual(
    picked.map((entry) => [
      entry.room.channelId,
      entry.friendIds,
      entry.people.length,
    ]),
    [
      ["two", ["bob", "cara"], 2],
      ["one", ["alice"], 2],
      ["crowd", [], 3],
      ["quiet", [], 1],
    ],
  );
});

test("Happening now leaves out the viewer and the call they are in", () => {
  const friends = new Set(["alice", "me"]);
  const rooms = [
    { channelId: "mine", participantIds: ["alice", "me"] },
    { channelId: "alone", participantIds: ["me"] },
  ];
  assert.deepEqual(
    pickHappening(rooms, friends, {
      viewerId: "me",
      currentChannelId: "mine",
    }),
    [],
  );
});

test("Happening now stops at its limit", () => {
  const rooms = Array.from({ length: 9 }, (_, i) => ({
    channelId: `c${i}`,
    participantIds: ["alice"],
  }));
  assert.equal(pickHappening(rooms, new Set()).length, HAPPENING_ROOM_LIMIT);
  assert.equal(HAPPENING_ROOM_LIMIT, 6);
});

const ulid = (n: number) => `01J${String(n).padStart(23, "0")}`;

test("Mentions are the newest across channels, each once", () => {
  const picked = pickMentionIds([
    { channelId: "a", messageIds: [ulid(1), ulid(5), "not-an-id", ulid(5)] },
    { channelId: "b", messageIds: new Set([ulid(3), ulid(9)]) },
  ]);
  assert.deepEqual(picked, [
    { channelId: "b", messageId: ulid(9) },
    { channelId: "a", messageId: ulid(5) },
    { channelId: "b", messageId: ulid(3) },
    { channelId: "a", messageId: ulid(1) },
  ]);
});

test("Mentions stop at their limit", () => {
  const ids = Array.from({ length: 12 }, (_, i) => ulid(i + 1));
  const picked = pickMentionIds([{ channelId: "a", messageIds: ids }]);
  assert.equal(picked.length, HOME_MENTION_LIMIT);
  assert.equal(picked[0].messageId, ulid(12));
});

test("a mention preview is one line of plain text with names written out", () => {
  const user = ulid(7);
  const channel = ulid(8);
  assert.equal(
    mentionPreview(`hey <@${user}>\n\ncheck <#${channel}> :${ulid(2)}:`, {
      user: (id) => (id === user ? "Velvetfly" : undefined),
      channel: () => "general",
    }),
    "hey @Velvetfly check #general :emoji:",
  );
  assert.equal(mentionPreview(`<@${user}>`), "@user");
  assert.equal(mentionPreview("   "), undefined);
  assert.equal(mentionPreview(undefined), undefined);
  assert.equal(mentionPreview({ text: "x" }), undefined);
});

test("a long mention preview is cut without splitting an emoji", () => {
  const long = "😀".repeat(MENTION_PREVIEW_LENGTH + 10);
  const preview = mentionPreview(long)!;
  assert.equal(Array.from(preview).length, MENTION_PREVIEW_LENGTH);
  assert.ok(preview.endsWith("…"));
  // whole emoji only: a cut inside one would leave half a surrogate pair
  assert.equal(preview.slice(0, -1), "😀".repeat(MENTION_PREVIEW_LENGTH - 1));
});

test("Friends online lists friends in calls, then playing, then the rest", () => {
  const friend = (
    id: string,
    name: string,
    inVoice = false,
    playing = false,
  ) => ({ id, name, inVoice, playing });
  const picked = pickOnlineFriends([
    friend("1", "zed"),
    friend("2", "Amy", false, true),
    friend("3", "bob", true),
    friend("4", "alex"),
    friend("5", "Cy", true, true),
  ]);
  assert.deepEqual(
    picked.map((entry) => entry.name),
    ["bob", "Cy", "Amy", "alex", "zed"],
  );
  const many = Array.from({ length: 20 }, (_, i) => friend(String(i), `f${i}`));
  assert.equal(pickOnlineFriends(many).length, HOME_FRIEND_LIMIT);
});

test("suggestions leave out joined servers, duplicates and bad ids", () => {
  const servers = [
    { _id: "a" },
    { _id: "joined" },
    { _id: 4 },
    { _id: "a" },
    { _id: "b" },
    { _id: "c" },
    { _id: "d" },
  ];
  assert.deepEqual(
    pickDiscover(servers, new Set(["joined"])).map((server) => server._id),
    ["a", "b", "c"],
  );
  assert.equal(HOME_DISCOVER_LIMIT, 3);
  assert.deepEqual(pickDiscover(undefined, new Set()), []);
});

const event = (id: string, cancelled = false) => ({ id, cancelled });

test("Upcoming shows the soonest events that have not started", () => {
  const picked = pickUpcoming(
    [
      { event: event("later"), occurrences: [NOW + 3000] },
      { event: event("past"), occurrences: [NOW - 1] },
      { event: event("soon"), occurrences: [NOW + 1000] },
      { event: event("off", true), occurrences: [NOW + 10] },
      { event: event("now"), occurrences: [NOW] },
      { event: event("last"), occurrences: [NOW + 9000] },
    ],
    NOW,
  );
  assert.deepEqual(
    picked.map((entry) => [entry.event.id, entry.start]),
    [
      ["now", NOW],
      ["soon", NOW + 1000],
      ["later", NOW + 3000],
    ],
  );
  assert.equal(JUMP_EVENT_LIMIT, 3);
});

test("Upcoming shows a repeating event once, at its next occurrence", () => {
  const picked = pickUpcoming(
    [
      {
        event: event("daily"),
        occurrences: [NOW - 1000, NOW + 5000, NOW + 2000, Number.NaN],
      },
      { event: event("weekly"), occurrences: [NOW + 9000] },
    ],
    NOW,
  );
  assert.deepEqual(
    picked.map((entry) => [entry.event.id, entry.start]),
    [
      ["daily", NOW + 2000],
      ["weekly", NOW + 9000],
    ],
  );
});

test("calendars are fetched a few at a time and failures are skipped", async () => {
  let inFlight = 0;
  let most = 0;
  const asked: string[] = [];
  const rows = await collectEvents(
    ["a", "b", "c", "a", "d"],
    async (id) => {
      asked.push(id);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      if (id === "b") throw { type: "NotFound" };
      return [{ event: event(id), occurrences: [NOW] }];
    },
    2,
  );
  assert.deepEqual(asked, ["a", "b", "c", "d"]);
  assert.equal(most, 2);
  assert.deepEqual(rows.map((row) => row.event.id).sort(), ["a", "c", "d"]);
});

test("events switched off stops asking other servers", async () => {
  const asked: string[] = [];
  const rows = await collectEvents(
    ["a", "b", "c", "d"],
    async (id) => {
      asked.push(id);
      throw { type: "FeatureDisabled" };
    },
    1,
  );
  assert.deepEqual(asked, ["a"]);
  assert.deepEqual(rows, []);
  assert.deepEqual(await collectEvents([], async () => []), []);
});

/** A fan-out that counts its calls */
function countingFanOut(rows: string[]) {
  const counter = { calls: 0 };
  const fanOut = async () => {
    counter.calls++;
    return rows;
  };
  return { counter, fanOut };
}

/** Asserts the route's failure comes back out and nothing fell back */
async function assertRethrows(failure: unknown) {
  const { counter, fanOut } = countingFanOut(["fan"]);
  await assert.rejects(
    upcomingRows<string>(async () => {
      throw failure;
    }, fanOut),
    (error) => {
      assert.deepEqual(error, failure);
      return true;
    },
  );
  assert.equal(counter.calls, 0);
}

test("Upcoming uses the cross-server route's rows when it answers", async () => {
  const { counter, fanOut } = countingFanOut(["fan"]);
  assert.deepEqual(await upcomingRows(async () => ["a", "b"], fanOut), [
    "a",
    "b",
  ]);
  assert.deepEqual(await upcomingRows(async () => [], fanOut), []);
  assert.equal(counter.calls, 0);
});

test("Upcoming falls back to asking each server when the route is missing", async () => {
  const { counter, fanOut } = countingFanOut(["fan"]);
  assert.deepEqual(await upcomingRows(async () => undefined, fanOut), ["fan"]);
  assert.equal(counter.calls, 1);
});

test("Upcoming shows nothing when events are switched off", async () => {
  const { counter, fanOut } = countingFanOut(["fan"]);
  const rows = await upcomingRows<string>(async () => {
    throw { type: "FeatureDisabled" };
  }, fanOut);
  assert.deepEqual(rows, []);
  assert.equal(counter.calls, 0);
});

test("Upcoming rethrows a rate limit without falling back", async () => {
  await assertRethrows({ retry_after: 5000 });
});

test("Upcoming rethrows an HTML error page without falling back", async () => {
  await assertRethrows(
    "<!DOCTYPE html><html><body>401 Unauthorized</body></html>",
  );
});

test("Upcoming rethrows other typed and untyped failures", async () => {
  await assertRethrows({ type: "NotFound" });
  await assertRethrows({ type: "InternalError" });
  await assertRethrows(null);
});

const EVENT_ID = "01JAXQ7ZK3M5N8P2R4T6V8W0YZ";

test("event links round-trip through the calendar's query", () => {
  const link = eventLink("01JAXQ7ZK3M5N8P2R4T6V8W0SV", EVENT_ID, NOW);
  assert.equal(
    link,
    `/server/01JAXQ7ZK3M5N8P2R4T6V8W0SV/events?event=${EVENT_ID}&at=${NOW}`,
  );
  const query = Object.fromEntries(new URL(link, "https://x").searchParams);
  assert.deepEqual(parseEventLink(query), { eventId: EVENT_ID, start: NOW });
});

test("a calendar query without a usable event id opens nothing", () => {
  assert.deepEqual(parseEventLink({ event: EVENT_ID }), {
    eventId: EVENT_ID,
    start: undefined,
  });
  assert.deepEqual(parseEventLink({ event: EVENT_ID, at: "-5" }), {
    eventId: EVENT_ID,
    start: undefined,
  });
  for (const bad of [
    {},
    { event: "" },
    { event: "not-an-id" },
    { event: EVENT_ID.toLowerCase() },
    { event: [EVENT_ID] },
    { event: `${EVENT_ID}/x` },
  ]) {
    assert.equal(parseEventLink(bad), undefined, JSON.stringify(bad));
  }
});

/** A fetch that settles on the next tick, logging which indexes it was asked for */
function slowFetch<T>(values: (T | undefined | Error)[], asked: number[]) {
  return async (index: number) => {
    asked.push(index);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const value = values[index];
    if (value instanceof Error) throw value;
    return value;
  };
}

test("fetchInOrder keeps list order and skips failures", async () => {
  const asked: number[] = [];
  const got = await fetchInOrder(
    5,
    slowFetch(["a", new Error("gone"), undefined, "d", "e"], asked),
    { want: 10, keep: () => true, concurrency: 2 },
  );
  assert.deepEqual(got, ["a", "d", "e"]);
  assert.deepEqual(
    [...asked].sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
  );
});

test("fetchInOrder stops once enough are kept", async () => {
  const values = ["a", "b", "c", "d", "e", "f", "g", "h"];

  const one: number[] = [];
  const serial = await fetchInOrder(values.length, slowFetch(values, one), {
    want: 3,
    keep: () => true,
    concurrency: 1,
  });
  assert.deepEqual(serial, ["a", "b", "c"]);
  assert.deepEqual(one, [0, 1, 2]);

  // at most concurrency - 1 extra fetches
  const two: number[] = [];
  const parallel = await fetchInOrder(values.length, slowFetch(values, two), {
    want: 3,
    keep: () => true,
    concurrency: 2,
  });
  assert.ok(two.length >= 3 && two.length <= 4, `asked ${two}`);
  assert.deepEqual(parallel.slice(0, 3), ["a", "b", "c"]);
});

test("fetchInOrder reads further to replace items it does not keep", async () => {
  // A blocked author's mention must not take one of the card's rows
  const values = ["x1", "a", "x2", "b", "c", "d"];
  const asked: number[] = [];
  const got = await fetchInOrder(values.length, slowFetch(values, asked), {
    want: 3,
    keep: (value) => !value.startsWith("x"),
    concurrency: 1,
  });
  assert.deepEqual(
    got.filter((value) => !value.startsWith("x")),
    ["a", "b", "c"],
  );
  assert.deepEqual(asked, [0, 1, 2, 3, 4]);
});

test("fetchInOrder with nothing to fetch asks for nothing", async () => {
  const asked: number[] = [];
  assert.deepEqual(
    await fetchInOrder(0, slowFetch([], asked), {
      want: 5,
      keep: () => true,
      concurrency: 2,
    }),
    [],
  );
  assert.deepEqual(asked, []);
});

test("the Mentions card reads past its row count to fill blocked rows", () => {
  assert.ok(HOME_MENTION_SCAN_LIMIT > HOME_MENTION_LIMIT);
});

test("fetchInOrder keeps the earliest items when one fetch is slow", async () => {
  // "c" is slow; the other worker reads past it while it is in flight, but
  // the rows kept are still the first three in list order
  const values = ["a", "b", "c", "x1", "x2", "d", "e"];
  const asked: number[] = [];
  const got = await fetchInOrder(
    values.length,
    async (index) => {
      asked.push(index);
      await new Promise((resolve) => setTimeout(resolve, index === 2 ? 30 : 1));
      return values[index];
    },
    { want: 3, keep: (value) => !value.startsWith("x"), concurrency: 2 },
  );
  assert.deepEqual(got.filter((value) => !value.startsWith("x")).slice(0, 3), [
    "a",
    "b",
    "c",
  ]);
  assert.ok(asked.length < values.length, `asked ${asked}`);
});

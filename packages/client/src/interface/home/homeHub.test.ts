// Unit spec for the Home page decisions — run with Node's built-in runner:
//   node --conditions=browser --test src/interface/home/homeHub.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CIPHER_BANNER_SNOOZE_MS,
  collectEvents,
  eventLink,
  isNewUser,
  JUMP_EVENT_LIMIT,
  JUMP_UNREAD_LIMIT,
  JUMP_VOICE_LIMIT,
  parseEventLink,
  parseStoredTime,
  pickUnreads,
  pickUpcoming,
  pickVoiceRooms,
  primaryConnection,
  releaseOf,
  showCipherBanner,
  showWhatsNew,
  streamThumbnail,
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

test("In voice lists rooms with friends, busiest first", () => {
  const friends = new Set(["alice", "bob", "cara", "me"]);
  const rooms = [
    { channelId: "one", participantIds: ["alice", "stranger"] },
    { channelId: "strangers", participantIds: ["stranger"] },
    { channelId: "two", participantIds: ["bob", "cara", "me"] },
    { channelId: "empty", participantIds: [] },
  ];
  const picked = pickVoiceRooms(rooms, friends, { viewerId: "me" });
  assert.deepEqual(
    picked.map((entry) => [entry.room.channelId, entry.friendIds]),
    [
      ["two", ["bob", "cara"]],
      ["one", ["alice"]],
    ],
  );
});

test("In voice leaves out the viewer and the call they are in", () => {
  const friends = new Set(["alice", "me"]);
  const rooms = [
    { channelId: "mine", participantIds: ["alice", "me"] },
    { channelId: "alone", participantIds: ["me"] },
  ];
  assert.deepEqual(
    pickVoiceRooms(rooms, friends, {
      viewerId: "me",
      currentChannelId: "mine",
    }),
    [],
  );
});

test("In voice stops at its limit", () => {
  const rooms = Array.from({ length: 7 }, (_, i) => ({
    channelId: `c${i}`,
    participantIds: ["alice"],
  }));
  assert.equal(
    pickVoiceRooms(rooms, new Set(["alice"])).length,
    JUMP_VOICE_LIMIT,
  );
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

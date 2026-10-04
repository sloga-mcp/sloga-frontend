// Unit spec for silent messages ("@silent ") — run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/client/silentMessage.test.ts
// Declared test count: 5 (the runner also exits 0 when it finds no tests at
// all, so compare this against its pass count).
//
// Focus: a silent send goes out with flag mask 1 and the prefix stripped; a
// received message reads as suppressed exactly when mask 1 is set, and the
// mention bits next to it never do; a silent message still counts toward the
// unread and mention badges; and NotificationsWorker's onMessage returns on a
// suppressed message before it reaches the sound or the popup. The server
// skips push for silent messages and sends none to an online user, so that
// popup would be the only alert an online user gets.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client } from "stoat.js";

// Valid 26-character Crockford ULIDs. Message ids share one prefix and end in
// a zero-padded decimal counter, so MSG(n) sorts by n.
const ME = "01J9QCRE7M0000000000000001";
const OTHER = "01J9QCRE7M0000000000000002";
const SERVER = "01J9QCRE7M00000000000000S1";
const CHANNEL = "01J9QCRE7M00000000000000C1";
const MSG = (n: number) => `01J9QCRE7N${String(n).padStart(16, "0")}`;

/** A preset node configuration, so the constructor never fetches `GET /`
 * (tests must not touch the network). */
const CONFIG = {
  revolt: "test",
  features: {
    autumn: { enabled: false, url: "" },
    january: { enabled: false, url: "" },
  },
  ws: "ws://127.0.0.1:9",
  app: "",
  vapid: "",
  build: {},
};

/** A client with one text channel whose tail is MSG(9), read up to MSG(9). */
function setup() {
  const client = new Client(
    { syncUnreads: true, autoReconnect: false },
    CONFIG as never,
  );
  client.user = client.users.getOrCreate(ME, {
    _id: ME,
    username: "me",
    discriminator: "0001",
    relationship: "User",
    online: true,
  } as never);

  const channel = client.channels.getOrCreate(CHANNEL, {
    _id: CHANNEL,
    channel_type: "TextChannel",
    server: SERVER,
    name: "general",
    last_message_id: MSG(9),
  } as never);

  client.channelUnreads.getOrCreate(CHANNEL, {
    _id: { channel: CHANNEL, user: ME },
    last_id: MSG(9),
    mentions: [],
  });
  client.channelUnreads.updateUnderlyingObject(CHANNEL, "unreadCount", 0);

  return { client, channel };
}

/** A `Message` event from another user arriving over the WebSocket. */
function wsMessage(
  client: Client,
  id: string,
  extra: Record<string, unknown> = {},
) {
  client.events.emit("event", {
    type: "Message",
    _id: id,
    channel: CHANNEL,
    author: OTHER,
    content: `message ${id}`,
    ...extra,
  } as never);
  const message = client.messages.get(id);
  assert.ok(message, "the event cached the message");
  return message;
}

test("an @silent send strips the prefix and sets flag mask 1", async () => {
  const { client, channel } = setup();
  const bodies: unknown[] = [];
  (client.api as { post: unknown }).post = (_path: string, body: unknown) => {
    bodies.push(body);
    return Promise.resolve({
      _id: MSG(10),
      channel: CHANNEL,
      author: ME,
      content: "quiet",
      flags: 1,
    });
  };

  await channel.sendMessage("@silent quiet");
  assert.equal(bodies.length, 1);
  const body = bodies[0] as { content?: string; flags?: number };
  assert.equal(body.content, "quiet");
  assert.equal(body.flags, 1);
});

test("a plain send carries no silent flag", async () => {
  const { client, channel } = setup();
  const bodies: unknown[] = [];
  (client.api as { post: unknown }).post = (_path: string, body: unknown) => {
    bodies.push(body);
    return Promise.resolve({
      _id: MSG(10),
      channel: CHANNEL,
      author: ME,
      content: "loud",
    });
  };

  await channel.sendMessage("loud");
  const body = bodies[0] as { content?: string; flags?: number };
  assert.equal(body.content, "loud");
  assert.equal((body.flags ?? 0) & 1, 0);
});

test("isSuppressed reads mask 1 and nothing else", () => {
  const { client } = setup();
  const cases: [number | undefined, boolean][] = [
    [undefined, false],
    [0, false],
    [1, true],
    // The server's MentionsEveryone (bit 2) and MentionsOnline (bit 3)
    [4, false],
    [8, false],
    [1 | 4, true],
    [1 | 8, true],
  ];
  cases.forEach(([flags, suppressed], i) => {
    const message = wsMessage(
      client,
      MSG(10 + i),
      flags === undefined ? {} : { flags },
    );
    assert.equal(message.isSuppressed, suppressed, `flags=${flags}`);
  });
});

test("a silent message still counts toward the unread and mention badges", () => {
  const { client, channel } = setup();
  const message = wsMessage(client, MSG(10), { flags: 1, mentions: [ME] });

  assert.equal(message.isSuppressed, true);
  assert.equal(message.mentioned, true);
  assert.equal(channel.unread, true);
  assert.equal(channel.unreadCount, 1);
  assert.equal(channel.mentions?.size, 1);
});

test("NotificationsWorker's onMessage returns on a suppressed message before the sound and the popup", () => {
  const source = readFileSync(
    new URL("./NotificationsWorker.tsx", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function onMessage(message: Message) {");
  assert.ok(start >= 0, "onMessage exists");
  const end = source.indexOf("\n  function ", start + 1);
  assert.ok(end > start, "onMessage has an end");
  const body = source.slice(start, end);

  const guard = body.indexOf("if (message.isSuppressed) return;");
  const playSound = body.indexOf('sound.playSound("message")');
  const popup = body.indexOf("showNotification(");
  assert.ok(guard >= 0, "onMessage checks isSuppressed");
  assert.ok(playSound >= 0, "onMessage plays the message sound");
  assert.ok(popup >= 0, "onMessage shows the popup");
  assert.ok(guard < playSound, "the guard runs before the sound");
  assert.ok(guard < popup, "the guard runs before the popup");
});

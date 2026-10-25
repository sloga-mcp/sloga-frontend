// Unit spec for the Protected channels message flows (W4 lane B4) — run
// with Node's built-in runner:
//   node --test --conditions=browser components/client/protectedTextMessages.test.ts
// Focus (plan 7 "messages"): never plaintext; same stored bytes on retry;
// unknown-outcome refetch before any re-encrypt; DuplicateNonce refetch;
// row without `encrypted` → marker; own send returns the server row for
// `getOrCreate` + `noteOwnMessage`; decrypt markers and the one catch-up;
// startup orphans confirmed, never re-sent. The plan 7 named mutation
// controls in this module each have a test marked "control:".
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  _resetMessageFlowsForTest,
  CONFIRM_PAGE_LIMIT,
  decryptRow,
  encryptAndSend,
  markerForError,
  parseSendStoreKey,
  SEND_ATTEMPTS_PER_CALL,
  sendStoreKey,
} from "./protectedTextMessages.ts";
import { confirmAfterId } from "./protectedTextPolicy.ts";
import type {
  GroupOps,
  MessageFlows,
  ProtectedMessageRow,
  ProtectedTextPort,
  TextApiResponse,
} from "./protectedTextTypes.ts";

// Compile-time: the exports are exactly what B5 wires as `deps.messages`.
const _messageFlows: MessageFlows = {
  encryptAndSend,
  decryptRow,
  markerForError,
};
void _messageFlows;

const CH = "01CHANNEL0000000000000000A";
const ME = "01USERME000000000000000000";
const MY_DEV = "aa".repeat(16);
const BOB = "01USERBOB00000000000000000";
const CID1 = "01JA0000000000000000000MSG";
const CID2 = "01JA0000000000000000001MSG";
const KEY = "01DRAFTKEY0000000000000000";
const SECRET = "attack at dawn";
const MSG_PATH = `/channels/${CH}/messages`;

type Reply = TextApiResponse | "transport";
type Call = { method: string; path: string; body: unknown };

const res = (
  status: number,
  body: unknown = null,
  resetAfterMs: number | null = null,
): TextApiResponse => ({ status, body, resetAfterMs });

const payload = (cid: string) => ({
  v: 1,
  group_id: "g0",
  epoch: 3,
  sender_device_id: MY_DEV,
  nonce: `aead-${cid}`,
  ciphertext: `ct-${cid}`,
  sig: `sig-${cid}`,
});

const row = (id: string, cid: string, author = ME) => ({
  _id: id,
  channel: CH,
  author,
  nonce: cid,
  encrypted: payload(cid),
});

interface H {
  port: ProtectedTextPort;
  ops: GroupOps;
  calls: Call[];
  events: string[];
  store: Map<string, string>;
  logs: unknown[][];
  sleeps: number[];
  encrypts: Record<string, unknown>[];
  decrypts: Record<string, unknown>[];
}

function harness(o: {
  post?: Reply[];
  get?: Reply[] | ((path: string) => Reply);
  cids?: string[];
  encrypt?: (args: Record<string, unknown>, n: number) => unknown;
  decrypt?: (args: Record<string, unknown>, n: number) => unknown;
  catchUp?: () => Promise<void>;
  /** Native refuses `update_required` until `ensureJoined` commits it. */
  updateRequired?: boolean;
}): H {
  let updatePending = o.updateRequired === true;
  const h = {
    calls: [] as Call[],
    events: [] as string[],
    store: new Map<string, string>(),
    logs: [] as unknown[][],
    sleeps: [] as number[],
    encrypts: [] as Record<string, unknown>[],
    decrypts: [] as Record<string, unknown>[],
  };
  const cids = [...(o.cids ?? [CID1, CID2])];
  const posts = [...(o.post ?? [])];
  const gets = Array.isArray(o.get) ? [...o.get] : null;
  const next = (q: Reply[]) => (q.length > 1 ? q.shift() : q[0]);
  const port: ProtectedTextPort = {
    async invoke(cmd, args) {
      const a = args as Record<string, unknown>;
      if (cmd === "e2ee_text_encrypt") {
        h.encrypts.push(a);
        h.events.push("encrypt");
        if (o.encrypt) return o.encrypt(a, h.encrypts.length) as never;
        if (updatePending) throw { type: "update_required", group_id: "g0" };
        const cid = cids.shift()!;
        return { nonce: cid, encrypted: payload(cid) } as never;
      }
      if (cmd === "e2ee_text_decrypt") {
        h.decrypts.push(a);
        if (o.decrypt) return (await o.decrypt(a, h.decrypts.length)) as never;
      }
      throw { type: "invalid_argument", field: cmd };
    },
    async pinCallIdentities() {
      return [];
    },
    async ownDeviceListing() {
      return { hash: "h", listing: [] };
    },
    async api(method, path, body) {
      h.calls.push({ method, path, body });
      h.events.push(`${method} ${path.split("?")[0]}`);
      let r: Reply | undefined;
      if (method === "POST") r = next(posts);
      else if (typeof o.get === "function") r = o.get(path);
      else if (gets) r = next(gets);
      if (r === undefined) throw new Error(`unscripted ${method} ${path}`);
      if (r === "transport") throw new Error("network");
      return r;
    },
    async ack() {},
    now: () => 0,
    async sleep(ms) {
      h.sleeps.push(ms);
    },
    log(level, msg, ids) {
      h.logs.push([level, msg, ids]);
    },
    selfUserId: ME,
    selfDeviceId: MY_DEV,
    channelInfo: () => null,
    displayNames: () => [],
    store: {
      get: (k) => h.store.get(k) ?? null,
      set: (k, v) => {
        h.store.set(k, v);
        h.events.push("store");
        return true;
      },
      delete: (k) => void h.store.delete(k),
    },
    notify() {},
  };
  const ops: GroupOps = {
    // B1 contract: resolves once the group is active and a due/required
    // `_update` commit has LANDED. `refresh` below commits nothing.
    async ensureJoined() {
      if (updatePending) {
        updatePending = false;
        h.events.push("ensureJoined (Update committed)");
      } else {
        h.events.push("ensureJoined");
      }
    },
    async createGroup() {
      throw new Error("unused");
    },
    async removeDevices() {},
    async catchUp(ch, toEpoch, groupId) {
      h.events.push(`catchUp ${ch} ${toEpoch} ${groupId}`);
      if (o.catchUp) await o.catchUp();
    },
    async refresh(ch, reason) {
      h.events.push(`refresh ${reason}`);
    },
    stateOf: () => null,
  };
  return { ...h, port, ops };
}

const send = (h: H, silent = false) =>
  encryptAndSend(h.ops, h.port, CH, SECRET, ["01REPLY"], silent, KEY);
const posts = (h: H) => h.calls.filter((c) => c.method === "POST");
const gets = (h: H) => h.calls.filter((c) => c.method === "GET");
const STORE_KEY = sendStoreKey(ME, CH, KEY);

beforeEach(() => _resetMessageFlowsForTest());

// ---------------------------------------------------------------------------
// encryptAndSend
// ---------------------------------------------------------------------------

test("own send: encrypt, persist before the POST, allowlisted body, server row returned for getOrCreate + noteOwnMessage", async () => {
  const server = row("01MSG1", CID1);
  const h = harness({ post: [res(200, server)] });
  const out = await send(h);
  assert.deepEqual(out, { messageId: "01MSG1", cid: CID1, raw: server });
  assert.deepEqual(h.encrypts[0], {
    channelId: CH,
    userId: ME,
    text: SECRET,
    replies: ["01REPLY"],
  });
  assert.deepEqual(h.events.slice(0, 3), [
    "encrypt",
    "store",
    `POST ${MSG_PATH}`,
  ]);
  assert.deepEqual(posts(h)[0].body, { nonce: CID1, encrypted: payload(CID1) });
  assert.equal(h.store.size, 0, "delivered → stored entry deleted");
});

test("never plaintext: the text reaches only e2ee_text_encrypt (no request, store or log carries it)", async () => {
  const h = harness({
    post: ["transport", res(500), res(200, row("01MSG1", CID1))],
  });
  await send(h, true);
  const body = posts(h)[0].body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["encrypted", "flags", "nonce"]);
  assert.equal(body.flags, 1, "silent is flags 1, nothing else");
  for (const c of h.calls) {
    assert.ok(!JSON.stringify(c).includes(SECRET), `request ${c.path}`);
    assert.ok(
      !JSON.stringify(c).includes("01REPLY"),
      "replies stay inside the ciphertext",
    );
  }
  assert.ok(!JSON.stringify(h.logs).includes(SECRET));
  assert.ok(![...h.store.values()].some((v) => v.includes(SECRET)));
});

test("never plaintext: an encrypt failure sends nothing at all", async () => {
  const h = harness({
    encrypt: () => {
      throw { type: "not_seated", channel_id: CH };
    },
  });
  await assert.rejects(
    send(h),
    (e: { source: string; error: { type: string } }) =>
      e.source === "native" && e.error.type === "not_seated",
  );
  assert.equal(h.calls.length, 0);
  assert.equal(h.store.size, 0);
});

test("same stored bytes on retry: transport errors re-send identical bytes, never re-encrypt", async () => {
  const h = harness({
    post: ["transport", "transport", res(200, row("01MSG1", CID1))],
  });
  await send(h);
  const p = posts(h);
  assert.equal(p.length, 3);
  assert.ok(
    p.every((c) => JSON.stringify(c.body) === JSON.stringify(p[0].body)),
  );
  assert.equal(h.encrypts.length, 1);
  assert.deepEqual(h.sleeps, [250, 500]);
});

test("same stored bytes across calls: an exhausted call keeps the entry; the outbox retry reuses it and confirms first", async () => {
  const h = harness({ post: ["transport"] });
  await assert.rejects(send(h), { source: "transport" });
  assert.equal(posts(h).length, SEND_ATTEMPTS_PER_CALL);
  const stored = h.store.get(STORE_KEY);
  assert.ok(stored, "unknown outcome → entry kept");

  // Same key, next call: no encrypt; the answer DuplicateNonce confirms.
  const h2 = harness({
    post: [res(409, { type: "DuplicateNonce" })],
    get: [res(200, [row("01MSG1", CID1)])],
  });
  h2.store.set(STORE_KEY, stored!);
  const out = await send(h2);
  assert.equal(h2.encrypts.length, 0, "never re-encrypted");
  assert.deepEqual(posts(h2)[0].body, posts(h)[0].body, "SAME bytes");
  assert.equal(out.messageId, "01MSG1");
  assert.equal(h2.store.size, 0);
});

test("control: a refusal after an unknown outcome confirms by refetch before any re-encrypt", async () => {
  // transport (unknown) → 409 Resecuring → confirm GET → absent → refresh →
  // ONE re-encrypt → 200.
  const h = harness({
    post: [
      "transport",
      res(409, { type: "ProtectedChannelResecuring", reason: "stale_epoch" }),
      res(200, row("01MSG2", CID2)),
    ],
    get: [res(200, [])],
  });
  const out = await send(h);
  const order = h.events.filter((e) => e !== "store");
  assert.deepEqual(order, [
    "encrypt",
    `POST ${MSG_PATH}`,
    `POST ${MSG_PATH}`,
    `GET ${MSG_PATH}`,
    "refresh resecuring",
    "encrypt",
    `POST ${MSG_PATH}`,
  ]);
  assert.equal(out.cid, CID2);
  assert.equal((posts(h)[2].body as { nonce: string }).nonce, CID2);
});

test("unknown outcome then Resecuring, but the row exists: delivered, no re-encrypt", async () => {
  const h = harness({
    post: [
      "transport",
      res(409, { type: "ProtectedChannelResecuring", reason: "stale_epoch" }),
    ],
    get: [res(200, [row("01MSGX", CID2, ME), row("01MSG1", CID1, ME)])],
  });
  const out = await send(h);
  assert.equal(out.messageId, "01MSG1");
  assert.equal(h.encrypts.length, 1);
  assert.equal(posts(h).length, 2);
});

test("confirm query: after = cid time − 5 min, sort=Latest, limit = pageLimit; pages with before=", async () => {
  const full = Array.from({ length: CONFIRM_PAGE_LIMIT }, (_, i) =>
    row(`01MSGZ${String(i).padStart(20, "0")}`, CID2, BOB),
  );
  const h = harness({
    post: [res(409, { type: "DuplicateNonce" })],
    get: [res(200, full), res(200, [row("01MSG1", CID1)])],
  });
  await send(h);
  const g = gets(h);
  assert.equal(g.length, 2);
  const after = confirmAfterId(CID1);
  assert.equal(
    g[0].path,
    `${MSG_PATH}?after=${after}&sort=Latest&limit=${CONFIRM_PAGE_LIMIT}`,
  );
  assert.ok(g[1].path.endsWith(`&before=${full[0]._id}`));
});

test("control: DuplicateNonce never re-encrypts (absent row → maybe_unsent)", async () => {
  const h = harness({
    post: [res(409, { type: "DuplicateNonce" })],
    get: [res(200, [row("01MSGB", CID1, BOB)])],
  });
  await assert.rejects(send(h), { source: "client", reason: "maybe_unsent" });
  assert.equal(h.encrypts.length, 1);
  assert.equal(posts(h).length, 1);
  assert.equal(gets(h).length, 1, "refetch-confirmed first");
  assert.equal(h.store.size, 0);
});

test("a failed confirm (403/5xx/transport) is never 'absent': the entry stays", async () => {
  const h = harness({
    post: [res(409, { type: "DuplicateNonce" })],
    get: [res(403), res(503), "transport"],
  });
  await assert.rejects(send(h), { source: "transport" });
  assert.equal(h.encrypts.length, 1);
  assert.ok(h.store.get(STORE_KEY), "outcome still unknown");
});

test("Resecuring with no earlier unknown outcome: refresh, ONE re-encrypt replacing the entry; a second one refuses", async () => {
  const resec = res(409, {
    type: "ProtectedChannelResecuring",
    reason: "pending_removal",
  });
  const h = harness({ post: [resec, resec] });
  let storedAtSecondPost: string | null = null;
  const api = h.port.api;
  h.port.api = async (m, p, b) => {
    if (m === "POST" && posts(h).length === 1) {
      storedAtSecondPost = h.store.get(STORE_KEY) ?? null;
    }
    return api(m, p, b);
  };
  await assert.rejects(send(h), {
    source: "server",
    status: 409,
    type: "ProtectedChannelResecuring",
  });
  assert.equal(h.encrypts.length, 2);
  assert.equal(gets(h).length, 0, "known failure: no confirm needed");
  assert.equal(JSON.parse(storedAtSecondPost!).nonce, CID2);
  assert.equal(h.store.size, 0);
});

test("ProtectedFieldRefused: refused, never retried, logged as a client defect", async () => {
  const h = harness({
    post: [res(400, { type: "ProtectedFieldRefused", field: "flags" })],
  });
  await assert.rejects(send(h), {
    source: "server",
    type: "ProtectedFieldRefused",
  });
  assert.equal(posts(h).length, 1);
  assert.ok(
    h.logs.some(
      (l) => l[0] === "error" && String(l[1]).startsWith("[protected]"),
    ),
  );
  assert.equal(h.store.size, 0);
});

test("FeatureDisabled{e2ee}: refused (draft stays with the caller), entry deleted", async () => {
  const h = harness({
    post: [res(400, { type: "FeatureDisabled", feature: "e2ee" })],
  });
  await assert.rejects(
    send(h),
    (e: { source: string; body: { feature: string } }) =>
      e.source === "server" && e.body.feature === "e2ee",
  );
  assert.equal(h.store.size, 0);
});

test("429: the same bytes after the stated delay", async () => {
  const h = harness({
    post: [res(429, { retry_after: 700 }, 700), res(200, row("01MSG1", CID1))],
  });
  await send(h);
  assert.equal(posts(h).length, 2);
  assert.deepEqual(posts(h)[0].body, posts(h)[1].body);
  assert.deepEqual(h.sleeps, [700]);
});

test("control: update_required awaits the Update commit (ensureJoined) before the ONE re-encrypt", async () => {
  // B1 contract: `ensureJoined` resolves only after the `_update` commit
  // landed; `refresh` merely schedules work. The fake models exactly that,
  // so retrying after `refresh` hits update_required again and fails.
  const h = harness({
    post: [res(200, row("01MSG1", CID1))],
    updateRequired: true,
  });
  const out = await send(h);
  assert.equal(out.cid, CID1);
  assert.deepEqual(h.events.slice(0, 4), [
    "encrypt",
    "ensureJoined (Update committed)",
    "encrypt",
    "store",
  ]);
  assert.ok(!h.events.some((e) => e.startsWith("refresh")));

  const h2 = harness({
    encrypt: () => {
      throw { type: "update_required", group_id: "g0" };
    },
  });
  await assert.rejects(send(h2));
  assert.equal(h2.encrypts.length, 2, "retried ONCE, then refused");
  assert.equal(h2.calls.length, 0);
});

test("a 2xx without a readable row is not adopted: confirmed through the same bytes", async () => {
  const h = harness({
    post: [res(200, "garbage"), res(409, { type: "DuplicateNonce" })],
    get: [res(200, [row("01MSG1", CID1)])],
  });
  const out = await send(h);
  assert.equal(out.messageId, "01MSG1");
  assert.equal(h.encrypts.length, 1);
});

test("send store keys round-trip per user", () => {
  assert.equal(STORE_KEY, `protected-send:${ME}:${CH}:${KEY}`);
  assert.deepEqual(parseSendStoreKey(STORE_KEY, ME), {
    channelId: CH,
    key: KEY,
  });
  assert.equal(parseSendStoreKey(STORE_KEY, BOB), null);
  assert.equal(parseSendStoreKey(`protected-send:${ME}:${CH}`, ME), null);
});

// ---------------------------------------------------------------------------
// decryptRow / markerForError
// ---------------------------------------------------------------------------

const prow = (
  over: Partial<ProtectedMessageRow> = {},
): ProtectedMessageRow => ({
  id: "01MSG1",
  channelId: CH,
  authorId: BOB,
  nonce: CID1,
  encrypted: payload(CID1) as ProtectedMessageRow["encrypted"],
  ...over,
});

const decrypted = (over: Record<string, unknown> = {}) => ({
  message_id: "01MSG1",
  channel_id: CH,
  group_id: "g0",
  epoch: 3,
  author_user_id: BOB,
  sender_device_id: "bb",
  cid: CID1,
  ts: 1,
  text: "hello",
  replies: ["01R"],
  sender_verified: true,
  ts_skew: false,
  ...over,
});

test("control: a row without `encrypted` is the unencrypted_row marker, never native, never content", async () => {
  const h = harness({ decrypt: () => decrypted() });
  const v = await decryptRow(h.ops, h.port, prow({ encrypted: null }), true);
  assert.deepEqual(v, { status: "marker", kind: "unencrypted_row" });
  assert.equal(h.decrypts.length, 0);
});

test("decrypt ok → view from native only; args carry the message-level nonce and live", async () => {
  const h = harness({ decrypt: () => decrypted() });
  const v = await decryptRow(h.ops, h.port, prow(), false);
  assert.deepEqual(v, {
    status: "ok",
    text: "hello",
    replies: ["01R"],
    senderVerified: true,
    tsSkew: false,
    cid: CID1,
  });
  assert.deepEqual(h.decrypts[0], {
    channelId: CH,
    messageId: "01MSG1",
    authorUserId: BOB,
    nonce: CID1,
    encrypted: payload(CID1),
    live: false,
  });
});

test("decrypt: a result for another message/cid/author fails closed", async () => {
  for (const over of [
    { message_id: "x" },
    { cid: CID2 },
    { author_user_id: ME },
  ]) {
    const h = harness({ decrypt: () => decrypted(over) });
    assert.deepEqual(await decryptRow(h.ops, h.port, prow(), true), {
      status: "marker",
      kind: "error",
    });
  }
});

test("decrypt: a row without a nonce is malformed, never native", async () => {
  const h = harness({ decrypt: () => decrypted() });
  const v = await decryptRow(h.ops, h.port, prow({ nonce: null }), true);
  assert.deepEqual(v, { status: "marker", kind: "malformed" });
  assert.equal(h.decrypts.length, 0);
});

test("UnknownEpoch ahead of current: catch up to that epoch, retry once; still unknown → decrypt_failed", async () => {
  const ahead = {
    type: "unknown_epoch",
    group_id: "g0",
    epoch: 9,
    oldest_held: 1,
    current: 5,
  };
  const h = harness({
    decrypt: (_a, n) => {
      if (n === 1) throw ahead;
      return decrypted();
    },
  });
  const v = await decryptRow(h.ops, h.port, prow(), true);
  assert.equal(v.status, "ok");
  assert.ok(h.events.includes(`catchUp ${CH} 9 g0`));

  const h2 = harness({
    decrypt: () => {
      throw ahead;
    },
  });
  assert.deepEqual(await decryptRow(h2.ops, h2.port, prow(), true), {
    status: "marker",
    kind: "decrypt_failed",
  });
  assert.equal(h2.decrypts.length, 2);

  const h3 = harness({
    decrypt: () => {
      throw ahead;
    },
    catchUp: async () => {
      throw { source: "transport" };
    },
  });
  assert.deepEqual(await decryptRow(h3.ops, h3.port, prow(), true), {
    status: "marker",
    kind: "decrypt_failed",
  });
});

test("UnknownEpoch before this device joined: gray marker, no catch-up", async () => {
  const h = harness({
    decrypt: () => {
      throw {
        type: "unknown_epoch",
        group_id: "g0",
        epoch: 1,
        oldest_held: 4,
        current: 6,
      };
    },
  });
  assert.deepEqual(await decryptRow(h.ops, h.port, prow(), false), {
    status: "marker",
    kind: "sent_before_join",
  });
  assert.ok(!h.events.some((e) => e.startsWith("catchUp")));
});

test("dedupe by id: the POST answer and the live event of the same row share one native decrypt", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    decrypt: async () => {
      await gate;
      return decrypted();
    },
  });
  const a = decryptRow(h.ops, h.port, prow(), true);
  const b = decryptRow(h.ops, h.port, prow(), true);
  // A concurrent history decrypt is NOT merged into the live one: native's
  // live-only removed-sender rule must still run for the live call.
  const c = decryptRow(h.ops, h.port, prow(), false);
  release();
  assert.deepEqual(await a, await b);
  await c;
  assert.equal(h.decrypts.length, 2);
  assert.deepEqual(
    h.decrypts.map((d) => d.live),
    [true, false],
  );
  await decryptRow(h.ops, h.port, prow(), true);
  assert.equal(h.decrypts.length, 3, "a later decrypt runs again");
});

test("decryptRow never rejects; logs carry ids only", async () => {
  const h = harness({
    decrypt: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(await decryptRow(h.ops, h.port, prow(), true), {
    status: "marker",
    kind: "error",
  });
  assert.ok(!JSON.stringify(h.logs).includes("ct-"));
});

test("markerForError: design 9.2 message rows, fail closed for anything else", () => {
  const n = (error: Record<string, unknown>) => ({ source: "native", error });
  assert.equal(
    markerForError(n({ type: "bad_sig", user_id: "u", device_id: "d" })),
    "unverified_sender",
  );
  assert.equal(
    markerForError({
      type: "unknown_sender",
      user_id: "u",
      device_id: "d",
      epoch: 1,
    }),
    "unverified_sender",
  );
  assert.equal(markerForError(n({ type: "removed_sender" })), "removed_sender");
  assert.equal(
    markerForError(n({ type: "replay", cid: CID1, first_message_id: "x" })),
    "replay",
  );
  assert.equal(
    markerForError(n({ type: "malformed_text_payload", reason: "structure" })),
    "malformed",
  );
  assert.equal(
    markerForError(n({ type: "mls_group_not_found", group_id: "g" })),
    "unknown_key",
  );
  assert.equal(
    markerForError(
      n({
        type: "unknown_epoch",
        group_id: "g",
        epoch: 9,
        oldest_held: 1,
        current: 5,
      }),
    ),
    "decrypt_failed",
  );
  assert.equal(markerForError(n({ type: "busy" })), "error");
  assert.equal(markerForError({ source: "transport" }), "error");
  assert.equal(markerForError("nonsense"), "error");
  assert.equal(markerForError(null), "error");
});

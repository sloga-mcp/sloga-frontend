// Unit spec for the Protected channels message flows (W4 lane B4) — run
// with Node's built-in runner:
//   node --test --conditions=browser components/client/protectedTextMessages.test.ts
// Focus (plan 7 "messages"): never plaintext; same stored bytes on retry;
// unknown-outcome refetch before any re-encrypt; DuplicateNonce refetch;
// row without `encrypted` → marker; own send returns the server row for
// `getOrCreate` + `noteOwnMessage`; decrypt markers and the one catch-up;
// startup orphans confirmed, never re-sent. The plan 7 named mutation
// controls in this module each have a test marked "control:". W4d (lane
// L-MGR): a row is the own send only when it binds (X#4, C-X4);
// `not_member` is refused without a retry (X#5, C-X5b). S2-W4 (lane L2x):
// `files` is checked and counted, never shown (OR-20); a newer envelope is
// the grey `unsupported_version` marker (OR-19). S4-W4 (lane L2x): a row
// without `encrypted` goes through the row policy with the manager's history
// ops; the ok view's three S4 keys; the history walk for a missing epoch.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { ulidTimeMs } from "./protectedRowPolicy.ts";
import {
  type HistoryOps,
  type RowOps,
  type WalkAnswer,
  _resetMessageFlowsForTest,
  CONFIRM_PAGE_LIMIT,
  decidePlainRow,
  decryptRow,
  encryptAndSend,
  markerForError,
  newWalkBatch,
  okViewNotes,
  parseSendStoreKey,
  plainRowInput,
  redecide,
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
  TextChannelState,
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

test("W4d X#4 (C-X4): a 2xx or confirm row naming another message is never adopted as the own send", async () => {
  // The DS answers 2xx with someone else's payload under its id, then a
  // confirm page holds our nonce in another channel and under another
  // author: none of those is this send; the bound row is.
  const forged2xx = { ...row("01FORGED", CID1), encrypted: payload(CID2) };
  const h = harness({
    post: [res(200, forged2xx), res(409, { type: "DuplicateNonce" })],
    get: [
      res(200, [
        { ...row("01WRONGCH", CID1), channel: "01CHANNEL0000000000000000B" },
        row("01WRONGAU", CID1, BOB),
        row("01MSG1", CID1),
      ]),
    ],
  });
  const out = await send(h);
  assert.equal(out.messageId, "01MSG1");
  assert.equal(h.encrypts.length, 1, "never re-encrypted");
  assert.deepEqual(posts(h)[0].body, posts(h)[1].body, "SAME bytes");
  assert.equal(h.store.size, 0);

  // Only forged rows: never delivered; DuplicateNonce absent → maybe_unsent.
  const h2 = harness({
    post: [res(200, forged2xx), res(409, { type: "DuplicateNonce" })],
    get: [res(200, [forged2xx])],
  });
  await assert.rejects(send(h2), { source: "client", reason: "maybe_unsent" });
});

test("W4d X#5 (C-X5b): Resecuring not_member is refused at once: no refresh, no re-encrypt, the reason reaches the manager", async () => {
  const h = harness({
    post: [
      res(409, { type: "ProtectedChannelResecuring", reason: "not_member" }),
    ],
  });
  await assert.rejects(
    send(h),
    (e: { source: string; type: string; body: { reason: string } }) =>
      e.source === "server" &&
      e.type === "ProtectedChannelResecuring" &&
      e.body.reason === "not_member",
  );
  assert.equal(h.encrypts.length, 1);
  assert.equal(posts(h).length, 1);
  assert.ok(!h.events.some((e) => e.startsWith("refresh")));
  assert.equal(h.store.size, 0);
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
  // Always serialized by native (876c034 `TextDecrypted.files`).
  files: [],
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
    filesUnsupported: 0,
    timingUnverified: false,
    belowBoundary: false,
    historySender: false,
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

// ---------------------------------------------------------------------------
// S2-W4 L2x: v2 files (OR-20) and the S3-N0 grey marker (OR-19)
// ---------------------------------------------------------------------------

const FILE_NAME = "quarterly-plan.pdf";
const FILE_MIME = "application/x-plan";

/** Native S2's `FileMeta` (876c034 `unsupported_files`). */
const fileMeta = (idx: number, over: Record<string, unknown> = {}) => ({
  idx,
  name: `${idx}-${FILE_NAME}`,
  mime: FILE_MIME,
  size: 12_345 + idx,
  state: "failed",
  fail_reason: "unsupported",
  ...over,
});

/** `fileMeta(0)` without one key. */
const without = (key: string) => {
  const f: Record<string, unknown> = fileMeta(0);
  delete f[key];
  return f;
};

/** A file in another native state: no `fail_reason`, as native omits it. */
const inState = (idx: number, state: string) => {
  const f: Record<string, unknown> = fileMeta(idx, { state });
  delete f.fail_reason;
  return f;
};

const OK_VIEW = {
  status: "ok",
  text: "hello",
  replies: ["01R"],
  senderVerified: true,
  tsSkew: false,
  cid: CID1,
  // S4: false without the history ops and without native's timing flag
  timingUnverified: false,
  belowBoundary: false,
  historySender: false,
};

const ERROR_VIEW = { status: "marker", kind: "error" };

const MISMATCH_LOG = [
  "error",
  "[protected] decrypt result mismatch",
  { messageId: "01MSG1", channelId: CH },
];

async function decryptFiles(files: unknown, omit = false) {
  const d: Record<string, unknown> = decrypted({ files });
  if (omit) delete d.files;
  const h = harness({ decrypt: () => d });
  const v = await decryptRow(h.ops, h.port, prow(), true);
  return { h, v };
}

test("S2 files: an empty files array gives filesUnsupported 0", async () => {
  const { h, v } = await decryptFiles([]);
  assert.deepEqual(v, { ...OK_VIEW, filesUnsupported: 0 });
  assert.deepEqual(h.logs, []);
});

test("S2 files: two failed/unsupported files give filesUnsupported 2, with no name, mime or size on the view or in the logs", async () => {
  const { h, v } = await decryptFiles([fileMeta(0), fileMeta(1)]);
  assert.deepEqual(v, { ...OK_VIEW, filesUnsupported: 2 });
  const out = JSON.stringify([v, h.logs]);
  for (const leak of [FILE_NAME, FILE_MIME, "12345", "12346"]) {
    assert.ok(!out.includes(leak), leak);
  }
});

test("S2 files: every file counts whatever its native state (S2 shows none)", async () => {
  const { v } = await decryptFiles([
    inState(0, "ready"),
    inState(1, "pending"),
    inState(2, "expired"),
    fileMeta(3, { fail_reason: "too_large" }),
  ]);
  assert.deepEqual(v, { ...OK_VIEW, filesUnsupported: 4 });
});

test("S2 files: a file element that is not FileMeta-shaped is the red error marker, never dropped or counted", async () => {
  const bad: unknown[] = [
    without("idx"),
    without("name"),
    without("mime"),
    without("size"),
    without("state"),
    fileMeta(0, { idx: "0" }),
    fileMeta(0, { idx: -1 }),
    fileMeta(0, { idx: 1.5 }),
    fileMeta(0, { idx: null }),
    fileMeta(0, { name: 7 }),
    fileMeta(0, { mime: null }),
    fileMeta(0, { size: "12345" }),
    fileMeta(0, { size: -1 }),
    fileMeta(0, { size: 2 ** 53 }),
    fileMeta(0, { state: 1 }),
    fileMeta(0, { state: null }),
    fileMeta(0, { fail_reason: null }),
    fileMeta(0, { fail_reason: 3 }),
    null,
    "file",
    0,
    [fileMeta(0)],
  ];
  for (const b of bad) {
    _resetMessageFlowsForTest();
    const { h, v } = await decryptFiles([fileMeta(1), b]);
    assert.deepEqual(v, ERROR_VIEW, JSON.stringify(b));
    assert.deepEqual(h.logs, [MISMATCH_LOG], JSON.stringify(b));
  }
});

test("S2 files: files absent or not an array is the red error marker (native 876c034 always serializes it)", async () => {
  const absent = await decryptFiles(undefined, true);
  assert.deepEqual(absent.v, ERROR_VIEW);
  assert.deepEqual(absent.h.logs, [MISMATCH_LOG]);
  for (const files of [null, {}, "files", 0, { 0: fileMeta(0), length: 1 }]) {
    _resetMessageFlowsForTest();
    const { h, v } = await decryptFiles(files);
    assert.deepEqual(v, ERROR_VIEW, JSON.stringify(files));
    assert.deepEqual(h.logs, [MISMATCH_LOG], JSON.stringify(files));
  }
});

test("S3-N0 (OR-19): a newer envelope version is the grey unsupported_version marker end to end, never error or malformed, v never shown", async () => {
  const tagOnly = {
    messageId: "01MSG1",
    channelId: CH,
    tag: "unsupported_envelope_version",
  };
  for (const ver of [3, 255]) {
    _resetMessageFlowsForTest();
    const h = harness({
      decrypt: () => {
        throw { type: "unsupported_envelope_version", v: ver };
      },
    });
    const view = await decryptRow(h.ops, h.port, prow(), true);
    assert.deepEqual(view, { status: "marker", kind: "unsupported_version" });
    assert.equal(h.decrypts.length, 1, "no retry");
    assert.ok(!h.events.some((e) => e.startsWith("catchUp")));
    assert.deepEqual(h.logs, [["warn", "[protected] decrypt failed", tagOnly]]);
  }
  // The same answer after the one catch-up.
  _resetMessageFlowsForTest();
  const h2 = harness({
    decrypt: (_a, n) => {
      if (n === 1) {
        throw {
          type: "unknown_epoch",
          group_id: "g0",
          epoch: 9,
          oldest_held: 1,
          current: 5,
        };
      }
      throw { type: "unsupported_envelope_version", v: 3 };
    },
  });
  assert.deepEqual(await decryptRow(h2.ops, h2.port, prow(), true), {
    status: "marker",
    kind: "unsupported_version",
  });
  // Both shapes the manager hands `markerForError`.
  const v3 = { type: "unsupported_envelope_version", v: 3 };
  assert.equal(markerForError(v3), "unsupported_version");
  assert.equal(
    markerForError({ source: "native", error: v3 }),
    "unsupported_version",
  );
});

// ---------------------------------------------------------------------------
// S4-W4 L2x: the row policy in the decrypt path, the ok notes, the walk
// ---------------------------------------------------------------------------

const ulid = (tail: string) => `01JA${"0".repeat(19)}${tail}`;
const BOUNDARY = ulid("BND");
const BELOW = ulid("AAA");
const ABOVE = ulid("CCC");
/** The three ids share their time part, so one limit fits them all. */
const LIMIT = ulidTimeMs(BOUNDARY)!;

/** A verified `e2ee_text_state` whose list keeps the pre-protect history. */
const nativeState = (over: Record<string, unknown> = {}) =>
  ({
    channel_id: CH,
    group_id: "g0",
    generation: 1,
    epoch: 6,
    state: "active",
    members: [],
    seat_list: {
      version: 2,
      signer_user_id: ME,
      signer_device_id: MY_DEV,
      seats: [ME, BOB],
      device_cap: 0,
      issued_at: LIMIT,
    },
    owner_pin: {
      channel_id: CH,
      status: "pinned",
      owner_user_id: ME,
      owner_device_id: MY_DEV,
      owner_verified: true,
      source: "protect",
      pending_signer: null,
    },
    self_seated: true,
    roster_matches_list: true,
    update_due: false,
    update_required: false,
    verdict: "ok",
    history_boundary: BOUNDARY,
    pre_history: "kept",
    history_time_limit: LIMIT,
    ...over,
  }) as unknown as TextChannelState;

interface S4Script {
  state?: TextChannelState | null;
  pin?: { boundary: string; wiped: boolean } | null;
  seatListError?: string | null;
  pre?: { conflicted: boolean; wiped: boolean };
  fromWalk?: (groupId: string, epoch: number) => unknown;
  predecessor?: (groupId: string) => unknown;
  walk?: (n: number) => unknown;
}

/** `h.ops` plus every S4 member, as the manager passes them. */
function s4(h: H, o: S4Script = {}) {
  const walks: string[] = [];
  const ops: RowOps & HistoryOps = {
    ...h.ops,
    pinHistory: () =>
      o.pin === undefined ? { boundary: BOUNDARY, wiped: false } : o.pin,
    nativeState: () => (o.state === undefined ? nativeState() : o.state),
    seatListError: () => o.seatListError ?? null,
    preHistoryState: () => o.pre ?? { conflicted: false, wiped: false },
    epochFromWalk: (g, e) => (o.fromWalk?.(g, e) ?? false) as boolean,
    knownPredecessor: (_ch, g) => (o.predecessor?.(g) ?? false) as boolean,
    async requestWalk(ch, g, e) {
      walks.push(`${ch} ${g} ${e}`);
      h.events.push(`walk ${g} ${e}`);
      if (!o.walk) throw new Error("unscripted walk");
      return (await o.walk(walks.length)) as WalkAnswer;
    },
  };
  return { ops, walks };
}

const PLAIN = { status: "plain" };
const CHECKING = { status: "checking" };
const RED = { status: "marker", kind: "unencrypted_row" };
const PENDING = { status: "pending" };
const mark = (kind: string) => ({ status: "marker", kind });

/** A row without `encrypted`, as a pre-protect message arrives. */
const plainRow = (id = BELOW) => prow({ id, nonce: null, encrypted: null });

const unknownEpoch = (
  epoch: number,
  oldest: number | null,
  current: number,
  over: Record<string, unknown> = {},
) => ({
  type: "unknown_epoch",
  group_id: "g0",
  epoch,
  oldest_held: oldest,
  current,
  removed_self: false,
  ...over,
});

/** Native refuses the first `times` decrypts of each message, then opens it. */
function failFirst(err: unknown, times = 1) {
  const seen = new Map<string, number>();
  return (a: Record<string, unknown>) => {
    const id = a.messageId as string;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n <= times) throw err;
    return decrypted({ message_id: id });
  };
}

const refuse = (err: unknown) => () => {
  throw err;
};

const catchUps = (h: H) => h.events.filter((e) => e.startsWith("catchUp"));

async function plainView(o: S4Script, id = BELOW) {
  _resetMessageFlowsForTest();
  const h = harness({ decrypt: () => decrypted() });
  const { ops } = s4(h, o);
  const v = await decryptRow(ops, h.port, plainRow(id), false);
  assert.equal(h.decrypts.length, 0, "a row without encrypted is never native");
  return v;
}

test("S4 plain row: a verified pre-boundary row is plain, with no native call", async () => {
  assert.deepEqual(await plainView({}), PLAIN);
  assert.deepEqual(await plainView({ pin: null }), PLAIN);
  assert.deepEqual(await plainView({}, BOUNDARY), PLAIN);
  // Live or fetched makes no difference to the arm (R-W4-17: the SDK keeps
  // a live row stripped; plain only allows the ordinary rendering).
  const h = harness({ decrypt: () => decrypted() });
  assert.deepEqual(
    await decryptRow(s4(h).ops, h.port, plainRow(), true),
    PLAIN,
  );
  assert.equal(h.decrypts.length, 0);
  assert.deepEqual(h.logs, []);
});

test("S4 plain row: a missing, throwing or unreadable lookup is the red marker", async () => {
  const lookups = [
    "pinHistory",
    "nativeState",
    "seatListError",
    "preHistoryState",
  ] as const;
  const run = async (change: (ops: Record<string, unknown>) => void) => {
    _resetMessageFlowsForTest();
    const h = harness({ decrypt: () => decrypted() });
    const ops = s4(h).ops as unknown as Record<string, unknown>;
    change(ops);
    const v = await decryptRow(
      ops as unknown as RowOps,
      h.port,
      plainRow(),
      false,
    );
    assert.equal(h.decrypts.length, 0);
    return v;
  };
  // Nothing changed: the same row is plain, so each red below is the change.
  assert.deepEqual(await run(() => undefined), PLAIN);
  for (const name of lookups) {
    assert.deepEqual(await run((ops) => delete ops[name]), RED, name);
    assert.deepEqual(
      await run((ops) => {
        ops[name] = refuse(new Error("lookup"));
      }),
      RED,
      `${name} throws`,
    );
  }
  const unreadable: [string, unknown][] = [
    ["pinHistory", undefined],
    ["pinHistory", "pin"],
    ["pinHistory", { boundary: 1, wiped: false }],
    ["pinHistory", { boundary: BOUNDARY }],
    ["pinHistory", { boundary: BOUNDARY, wiped: "false" }],
    ["nativeState", undefined],
    ["nativeState", "state"],
    ["nativeState", [nativeState()]],
    ["seatListError", undefined],
    ["seatListError", 0],
    ["seatListError", false],
    ["preHistoryState", undefined],
    ["preHistoryState", null],
    ["preHistoryState", {}],
    ["preHistoryState", { conflicted: false }],
    ["preHistoryState", { conflicted: "no", wiped: false }],
    ["preHistoryState", { conflicted: false, wiped: 0 }],
  ];
  for (const [name, answer] of unreadable) {
    assert.deepEqual(
      await run((ops) => (ops[name] = () => answer)),
      RED,
      `${name} ${JSON.stringify(answer)}`,
    );
  }
  // No S4 member at all (the manager before S4).
  const h = harness({ decrypt: () => decrypted() });
  assert.deepEqual(await decryptRow(h.ops, h.port, plainRow(), false), RED);
  assert.equal(plainRowInput(h.ops, CH, BELOW), null);
  assert.equal(decidePlainRow(null), "red");
});

test("S4 plain row: no native state is checking, and redecide asks again once it is verified", async () => {
  const v = await plainView({ state: null });
  assert.deepEqual(v, CHECKING);
  const h = harness({});
  const loading = plainRowInput(s4(h, { state: null }).ops, CH, BELOW);
  const verified = plainRowInput(s4(h).ops, CH, BELOW);
  assert.equal(redecide(v, loading), false, "nothing changed yet");
  assert.equal(redecide(v, verified), true);
  assert.deepEqual(await plainView({}), PLAIN);
  // Verified, but the row is above the boundary: asked again, and red.
  const above = plainRowInput(s4(h).ops, CH, ABOVE);
  assert.equal(redecide(v, above), true);
  assert.deepEqual(await plainView({}, ABOVE), RED);
});

test("S4 plain row: an unverified native state is checking, never plain", async () => {
  const unverified: S4Script[] = [
    { state: nativeState({ verdict: "owner_changed" }) },
    { state: nativeState({ verdict: "a_newer_verdict" }) },
    { state: nativeState({ seat_list: null }) },
    { seatListError: "bad_sig" },
    { seatListError: "" },
  ];
  for (const o of unverified) {
    assert.deepEqual(await plainView(o), CHECKING, JSON.stringify(o));
    const h = harness({});
    assert.equal(
      decidePlainRow(plainRowInput(s4(h, o).ops, CH, BELOW)),
      "checking",
    );
  }
});

test("S4 plain row: each clause of the policy that fails is the red marker", async () => {
  const state = (over: Record<string, unknown>) => ({
    state: nativeState(over),
  });
  const cases: [string, S4Script, string][] = [
    ["above the boundary", {}, ABOVE],
    ["a malformed id", {}, "01MSG1"],
    ["natively wiped", state({ pre_history: "wiped" }), BELOW],
    ["no pre_history", state({ pre_history: undefined }), BELOW],
    ["no boundary", state({ history_boundary: undefined }), BELOW],
    ["pin wiped", { pin: { boundary: BOUNDARY, wiped: true } }, BELOW],
    ["pin mismatch", { pin: { boundary: ABOVE, wiped: false } }, BELOW],
    ["after the limit", state({ history_time_limit: LIMIT - 1 }), BELOW],
    ["no limit", state({ history_time_limit: undefined }), BELOW],
  ];
  for (const [name, o, id] of cases) {
    assert.deepEqual(await plainView(o, id), RED, name);
  }
});

test("S4 plain row: a conflicted channel is red, also while the state is loading", async () => {
  const pre = { conflicted: true, wiped: false };
  assert.deepEqual(await plainView({ pre }), RED);
  assert.deepEqual(await plainView({ pre, state: null }), RED);
  assert.deepEqual(await plainView({ pre, pin: null }), RED);
});

test("S4 plain row: a channel the server says was wiped is red, also while the state is loading", async () => {
  const pre = { conflicted: false, wiped: true };
  assert.deepEqual(await plainView({ pre }), RED);
  assert.deepEqual(await plainView({ pre, state: null }), RED);
  assert.deepEqual(await plainView({ pre, pin: null }), RED);
});

test("S4 encrypted row: decrypts whatever the policy inputs are, flagged at or below the boundary", async () => {
  const run = async (o: S4Script | null, id: string) => {
    _resetMessageFlowsForTest();
    const h = harness({ decrypt: () => decrypted({ message_id: id }) });
    const ops = o === null ? h.ops : s4(h, o).ops;
    const v = await decryptRow(ops, h.port, prow({ id }), false);
    assert.equal(v.status, "ok", JSON.stringify(o));
    assert.equal(h.decrypts.length, 1);
    return (v as { belowBoundary: boolean }).belowBoundary;
  };
  assert.equal(await run({}, BELOW), true);
  assert.equal(await run({}, BOUNDARY), true);
  assert.equal(await run({}, ABOVE), false);
  assert.equal(await run({}, "01MSG1"), false, "a malformed id is not below");
  // The flag needs the verified boundary; the decrypt needs nothing.
  const never: (S4Script | null)[] = [
    null,
    { state: null },
    { state: nativeState({ verdict: "owner_changed" }) },
    { state: nativeState({ seat_list: null }) },
    { seatListError: "bad_sig" },
    { state: nativeState({ history_boundary: undefined }) },
  ];
  for (const o of never) assert.equal(await run(o, BELOW), false);
  // What turns a row without encrypted red leaves an encrypted one alone.
  const still: S4Script[] = [
    { pre: { conflicted: true, wiped: false } },
    { pre: { conflicted: false, wiped: true } },
    { pin: { boundary: BOUNDARY, wiped: true } },
    { state: nativeState({ pre_history: "wiped" }) },
  ];
  for (const o of still) assert.equal(await run(o, BELOW), true);
});

test("S4 ok view: timingUnverified and historySender, a literal true only", async () => {
  const run = async (over: Record<string, unknown>, o: S4Script | null) => {
    _resetMessageFlowsForTest();
    const h = harness({ decrypt: () => decrypted(over) });
    const ops = o === null ? h.ops : s4(h, o).ops;
    const v = await decryptRow(ops, h.port, prow(), false);
    assert.equal(v.status, "ok");
    const ok = v as { timingUnverified: boolean; historySender: boolean };
    return [ok.timingUnverified, ok.historySender];
  };
  assert.deepEqual(await run({}, {}), [false, false]);
  assert.deepEqual(await run({ timing_unverified: true }, {}), [true, true]);
  assert.deepEqual(await run({ timing_unverified: true }, null), [true, true]);
  for (const junk of [false, "true", 1, null, {}]) {
    assert.deepEqual(await run({ timing_unverified: junk }, {}), [
      false,
      false,
    ]);
  }
  // The epoch native decrypted under came from this session's walk.
  const asked: unknown[][] = [];
  const fromWalk = (g: string, e: number) => {
    asked.push([g, e]);
    return g === "g0" && e === 3;
  };
  assert.deepEqual(await run({}, { fromWalk }), [false, true]);
  assert.deepEqual(asked, [["g0", 3]]);
  assert.deepEqual(await run({ epoch: 4 }, { fromWalk }), [false, false]);
  assert.deepEqual(await run({}, { fromWalk: () => "yes" }), [false, false]);
  assert.deepEqual(await run({}, { fromWalk: refuse(new Error("lookup")) }), [
    false,
    false,
  ]);
  asked.length = 0;
  assert.deepEqual(await run({ group_id: 7 }, { fromWalk }), [false, false]);
  assert.deepEqual(await run({ epoch: -1 }, { fromWalk }), [false, false]);
  assert.deepEqual(asked, [], "an unreadable group or epoch is never asked");
});

test("S4 okViewNotes: the notes of an ok view through the shield", () => {
  const view = (over: Record<string, boolean>) =>
    ({
      status: "ok",
      text: "",
      replies: [],
      senderVerified: true,
      tsSkew: false,
      cid: CID1,
      filesUnsupported: 0,
      timingUnverified: false,
      belowBoundary: false,
      historySender: false,
      ...over,
    }) as Parameters<typeof okViewNotes>[0];
  assert.deepEqual(okViewNotes(view({})), []);
  assert.deepEqual(okViewNotes(view({ senderVerified: false })), [
    "sender_unverified",
  ]);
  assert.deepEqual(
    okViewNotes(view({ senderVerified: false, historySender: true })),
    ["sender_unverified_history"],
  );
  assert.deepEqual(okViewNotes(view({ historySender: true })), []);
  assert.deepEqual(
    okViewNotes(
      view({
        timingUnverified: true,
        historySender: true,
        belowBoundary: true,
      }),
    ),
    ["timing_unverified", "below_boundary"],
  );
  assert.deepEqual(okViewNotes(view({ belowBoundary: true })), [
    "below_boundary",
  ]);
});

test("S4 redecide: checking and plain follow the decision, red only ever turns plain, ok only gains the note", async () => {
  const h = harness({});
  const at = (o: S4Script, id = BELOW) => plainRowInput(s4(h, o).ops, CH, id);
  const verified = at({});
  const loading = at({ state: null });
  const unverified = at({ seatListError: "bad_sig" });
  const pinWiped = at({ pin: { boundary: BOUNDARY, wiped: true } });
  const serverWiped = at({ pre: { conflicted: false, wiped: true } });
  const conflicted = at({ pre: { conflicted: true, wiped: false } });
  const above = at({}, ABOVE);
  const view = (v: unknown) => v as Parameters<typeof redecide>[0];

  assert.equal(redecide(view(CHECKING), verified), true);
  assert.equal(redecide(view(CHECKING), above), true);
  assert.equal(redecide(view(CHECKING), null), true);
  assert.equal(redecide(view(CHECKING), loading), false);
  assert.equal(redecide(view(CHECKING), unverified), false);

  assert.equal(redecide(view(PLAIN), verified), false);
  const noLongerPlain = [
    pinWiped,
    serverWiped,
    conflicted,
    loading,
    unverified,
    above,
    null,
  ];
  for (const i of noLongerPlain) {
    assert.equal(redecide(view(PLAIN), i), true);
  }

  assert.equal(redecide(view(RED), verified), true);
  for (const i of [loading, unverified, above, pinWiped, conflicted, null]) {
    assert.equal(redecide(view(RED), i), false, "red never leaves unverified");
  }
  // A wipe turns a plain view red when it is computed again.
  assert.deepEqual(
    await plainView({ pre: { conflicted: false, wiped: true } }),
    RED,
  );
  assert.deepEqual(
    await plainView({ pin: { boundary: BOUNDARY, wiped: true } }),
    RED,
  );

  for (const v of [PENDING, mark("decrypt_failed"), mark("sent_before_join")]) {
    for (const i of [verified, loading, null]) {
      assert.equal(redecide(view(v), i), false);
    }
  }

  const ok = (belowBoundary: boolean) =>
    view({ ...OK_VIEW, filesUnsupported: 0, belowBoundary });
  assert.equal(redecide(ok(false), verified), true);
  assert.equal(redecide(ok(true), verified), false);
  assert.equal(redecide(ok(false), above), false);
  for (const i of [loading, unverified, null]) {
    assert.equal(redecide(ok(false), i), false);
    assert.equal(redecide(ok(true), i), false, "the note is never taken back");
  }
});

test("S4 removed_self: the gray marker with no walk, no catch-up and no retry", async () => {
  const errors = [
    unknownEpoch(2, 4, 6, { removed_self: true }),
    unknownEpoch(5, 4, 6, { removed_self: true }),
    // the shape that would otherwise catch up
    unknownEpoch(9, 4, 6, { removed_self: true }),
    unknownEpoch(9, null, -1, { removed_self: true }),
  ];
  for (const err of errors) {
    for (const withS4 of [true, false]) {
      _resetMessageFlowsForTest();
      const h = harness({ decrypt: refuse(err) });
      const x = s4(h, { walk: () => "imported" });
      const v = await decryptRow(withS4 ? x.ops : h.ops, h.port, prow(), false);
      assert.deepEqual(v, mark("removed_self"), JSON.stringify(err));
      assert.deepEqual(x.walks, [], "never a walk");
      assert.deepEqual(catchUps(h), [], "never a catch-up");
      assert.equal(h.decrypts.length, 1, "never a retry");
    }
  }
});

const batchRows = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    prow({ id: ulid(String(i).padStart(3, "0")) }),
  );

test("S4 walk: 20 rows of one epoch in one batch share one walk request", async () => {
  const h = harness({ decrypt: failFirst(unknownEpoch(2, 4, 6)) });
  const x = s4(h, { walk: () => "imported" });
  const batch = newWalkBatch();
  for (const row of batchRows(20)) {
    // one after the other, as the manager's decryptHistory runs them
    const v = await decryptRow(x.ops, h.port, row, false, { batch });
    assert.equal(v.status, "ok");
  }
  assert.deepEqual(x.walks, [`${CH} g0 2`]);
  assert.equal(h.decrypts.length, 40, "each row: one refusal, one retry");
  assert.deepEqual(catchUps(h), []);
  // Another epoch of the same batch is its own request.
  const h2 = harness({ decrypt: failFirst(unknownEpoch(3, 4, 6)) });
  const other = prow({ id: ulid("ZZZ") });
  await decryptRow(x.ops, h2.port, other, false, { batch });
  assert.deepEqual(x.walks, [`${CH} g0 2`, `${CH} g0 3`]);
});

test("S4 walk: rows decrypted at the same time share the request in flight; later ones ask again", async () => {
  let release!: (a: string) => void;
  const gate = new Promise<string>((r) => (release = r));
  const h = harness({ decrypt: failFirst(unknownEpoch(2, 4, 6)) });
  const x = s4(h, { walk: (n) => (n === 1 ? gate : "imported") });
  const all = Promise.all(
    batchRows(20).map((row) => decryptRow(x.ops, h.port, row, false)),
  );
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(x.walks.length, 1, "one request while it is in flight");
  release("imported");
  assert.ok((await all).every((v) => v.status === "ok"));
  assert.equal(x.walks.length, 1);
  // Outside a batch nothing is remembered once the request settled.
  const late = prow({ id: ulid("ZZZ") });
  await decryptRow(x.ops, h.port, late, false);
  assert.equal(x.walks.length, 2);
});

test("S4 walk: imported retries the decrypt exactly once", async () => {
  // The key came: the retry opens the row, and its sender note is the
  // history one because the epoch is from the walk.
  const h = harness({ decrypt: failFirst(unknownEpoch(2, 4, 6)) });
  const x = s4(h, { walk: () => "imported", fromWalk: () => true });
  const v = await decryptRow(x.ops, h.port, prow(), false);
  assert.deepEqual(v, {
    ...OK_VIEW,
    filesUnsupported: 0,
    historySender: true,
  });
  assert.equal(h.decrypts.length, 2);
  assert.deepEqual(x.walks, [`${CH} g0 2`]);
  assert.deepEqual(catchUps(h), []);

  // Imported, yet this epoch is still missing: one retry, one walk, and the
  // final marker. Native would open the row on the sixth try.
  _resetMessageFlowsForTest();
  const h2 = harness({ decrypt: failFirst(unknownEpoch(2, 4, 6), 5) });
  const x2 = s4(h2, { walk: () => "imported" });
  assert.deepEqual(
    await decryptRow(x2.ops, h2.port, prow(), false),
    mark("sent_before_join"),
  );
  assert.equal(h2.decrypts.length, 2, "exactly one retry");
  assert.equal(x2.walks.length, 1, "exactly one walk request");

  // The retry fails for another reason: that reason's marker.
  _resetMessageFlowsForTest();
  const h3 = harness({
    decrypt: (_a, n) => {
      if (n === 1) throw unknownEpoch(2, 4, 6);
      throw { type: "bad_sig", user_id: BOB, device_id: "bb" };
    },
  });
  const x3 = s4(h3, { walk: () => "imported" });
  assert.deepEqual(
    await decryptRow(x3.ops, h3.port, prow(), false),
    mark("unverified_sender"),
  );
  assert.equal(h3.decrypts.length, 2);
});

test("S4 walk: retry_later is pending, never a marker", async () => {
  const h = harness({ decrypt: failFirst(unknownEpoch(2, 4, 6)) });
  const x = s4(h, { walk: () => "retry_later" });
  const batch = newWalkBatch();
  for (const row of batchRows(3)) {
    const v = await decryptRow(x.ops, h.port, row, false, { batch });
    assert.deepEqual(v, PENDING);
  }
  assert.equal(x.walks.length, 1);
  assert.equal(h.decrypts.length, 3, "no retry before the walk has a result");
  assert.deepEqual(catchUps(h), []);
  // Inside the held run it is pending as well, not red and not gray.
  _resetMessageFlowsForTest();
  const h2 = harness({ decrypt: failFirst(unknownEpoch(5, 4, 6)) });
  const x2 = s4(h2, { walk: () => "retry_later" });
  assert.deepEqual(await decryptRow(x2.ops, h2.port, prow(), true), PENDING);
});

const NOT_FOUND = { type: "mls_group_not_found", group_id: "gOld" };
const FLOOR_OLD = { group_id: "gOld", epoch: 7, stopped: null };

/** [name, native error, script, walk request, marker once the walk ended] */
const WALK_ENDS: [string, unknown, S4Script, string, string][] = [
  ["below the held run", unknownEpoch(2, 4, 6), {}, "g0 2", "sent_before_join"],
  ["inside the held run", unknownEpoch(5, 4, 6), {}, "g0 5", "decrypt_failed"],
  ["at its oldest epoch", unknownEpoch(4, 4, 6), {}, "g0 4", "decrypt_failed"],
  ["nothing held", unknownEpoch(5, null, 6), {}, "g0 5", "decrypt_failed"],
  [
    "a predecessor never held",
    unknownEpoch(3, null, -1, { group_id: "gOld" }),
    { state: nativeState({ history_floor: FLOOR_OLD }) },
    "gOld 3",
    "sent_before_join",
  ],
  [
    "a left group above its last epoch",
    unknownEpoch(9, 4, 6),
    { state: nativeState({ state: "left" }) },
    "g0 9",
    "decrypt_failed",
  ],
  [
    "a predecessor native has no group for",
    NOT_FOUND,
    { predecessor: (g) => g === "gOld" },
    "gOld 3",
    "unknown_key",
  ],
];

test("S4 walk: floor keeps the before-join line only below the held run", async () => {
  for (const [name, err, o, request, kind] of WALK_ENDS) {
    for (const answer of ["floor", "imported"]) {
      _resetMessageFlowsForTest();
      const h = harness({ decrypt: refuse(err) });
      const x = s4(h, { ...o, walk: () => answer });
      const v = await decryptRow(x.ops, h.port, prow(), false);
      assert.deepEqual(v, mark(kind), `${name} (${answer})`);
      assert.deepEqual(x.walks, [`${CH} ${request}`], name);
      assert.deepEqual(catchUps(h), [], name);
      // floor: nothing to retry; imported: the one retry
      assert.equal(h.decrypts.length, answer === "floor" ? 1 : 2, name);
    }
  }
});

test("S4 walk not started: a key missing inside the held run is red, never the before-join line", async () => {
  const cases: [unknown, string][] = [
    [unknownEpoch(2, 4, 6), "sent_before_join"],
    [unknownEpoch(5, 4, 6), "decrypt_failed"],
    [unknownEpoch(4, 4, 6), "decrypt_failed"],
    [unknownEpoch(5, null, 6), "decrypt_failed"],
    [unknownEpoch(5, undefined as never, 6), "decrypt_failed"],
    [unknownEpoch(6, 4, 6), "decrypt_failed"],
  ];
  for (const [err, kind] of cases) {
    assert.equal(markerForError(err), kind, JSON.stringify(err));
    assert.equal(markerForError({ source: "native", error: err }), kind);
    for (const withS4 of [true, false]) {
      _resetMessageFlowsForTest();
      const h = harness({ decrypt: refuse(err) });
      // every S4 member but the walk itself
      const ops: RowOps = { ...s4(h).ops, requestWalk: undefined };
      const v = await decryptRow(withS4 ? ops : h.ops, h.port, prow(), false);
      assert.deepEqual(v, mark(kind), JSON.stringify(err));
      assert.equal(h.decrypts.length, 1);
      assert.deepEqual(catchUps(h), []);
    }
  }
});

test("S4 walk: a rejected or unreadable walk answer is the red error marker", async () => {
  const answers: (() => unknown)[] = [
    refuse(new Error("walk")),
    () => Promise.reject({ source: "transport" }),
    () => "done",
    () => undefined,
    () => true,
  ];
  for (const walk of answers) {
    _resetMessageFlowsForTest();
    const h = harness({ decrypt: failFirst(unknownEpoch(2, 4, 6)) });
    const x = s4(h, { walk });
    const v = await decryptRow(x.ops, h.port, prow(), false);
    assert.deepEqual(v, mark("error"));
    assert.equal(h.decrypts.length, 1, "no retry on an answer nobody gave");
    assert.equal(x.walks.length, 1);
    assert.deepEqual(h.logs[0], [
      "error",
      "[protected] history walk request failed",
      { channelId: CH },
    ]);
  }
});

test("S4 catch-up: the S1 path is unchanged with the history ops present (snapshot of calls)", async () => {
  const ahead = unknownEpoch(9, 1, 5);
  const transport = async () => {
    throw { source: "transport" };
  };
  const caughtUp = `catchUp ${CH} 9 g0`;
  /** [name, harness script, view, native decrypts] */
  const scripts: [
    string,
    () => Parameters<typeof harness>[0],
    unknown,
    number,
  ][] = [
    [
      "caught up",
      () => ({ decrypt: failFirst(ahead) }),
      { ...OK_VIEW, filesUnsupported: 0 },
      2,
    ],
    [
      "still unknown",
      () => ({ decrypt: refuse(ahead) }),
      mark("decrypt_failed"),
      2,
    ],
    [
      "catch-up fails",
      () => ({ decrypt: refuse(ahead), catchUp: transport }),
      mark("decrypt_failed"),
      1,
    ],
  ];
  // The channel's own active group, a state that is not loaded, and no S4
  // member at all: the same calls, logs and view each time.
  const variants: (S4Script | null)[] = [
    { state: nativeState({ epoch: 5 }) },
    { state: null },
    null,
  ];
  for (const [name, script, view, decrypts] of scripts) {
    const snapshots: unknown[] = [];
    for (const o of variants) {
      _resetMessageFlowsForTest();
      const h = harness(script());
      const x = s4(h, { ...(o ?? {}), walk: () => "imported" });
      const ops = o === null ? h.ops : x.ops;
      const v = await decryptRow(ops, h.port, prow(), true);
      assert.deepEqual(x.walks, [], name);
      assert.deepEqual(v, view, name);
      assert.equal(h.decrypts.length, decrypts, name);
      assert.deepEqual(h.events, [caughtUp], name);
      snapshots.push([v, h.events, h.decrypts, h.logs]);
    }
    assert.deepEqual(snapshots[0], snapshots[2], name);
    assert.deepEqual(snapshots[1], snapshots[2], name);
  }
});

test("S4 walk: a closed or left group above its last held epoch walks; a group nobody vouches for never does", async () => {
  const above = unknownEpoch(9, 4, 6);
  const foreign = unknownEpoch(3, null, -1, { group_id: "gX" });
  const run = async (err: unknown, o: S4Script) => {
    _resetMessageFlowsForTest();
    const h = harness({ decrypt: refuse(err) });
    const x = s4(h, { ...o, walk: () => "floor" });
    await decryptRow(x.ops, h.port, prow(), false);
    return { walks: x.walks, catchUps: catchUps(h) };
  };
  for (const state of [
    nativeState({ state: "left" }),
    nativeState({ verdict: "no_group" }),
  ]) {
    assert.deepEqual(await run(above, { state }), {
      walks: [`${CH} g0 9`],
      catchUps: [],
    });
  }
  // A group named by the row alone: the S1 catch-up, never a walk.
  const s1 = { walks: [], catchUps: [`catchUp ${CH} 3 gX`] };
  assert.deepEqual(await run(foreign, {}), s1);
  assert.deepEqual(await run(foreign, { predecessor: () => "yes" }), s1);
  assert.deepEqual(
    await run(foreign, { state: nativeState({ history_floor: FLOOR_OLD }) }),
    s1,
  );
  assert.deepEqual(
    await run(foreign, { predecessor: refuse(new Error("lookup")) }),
    s1,
  );
  // The manager vouches for it, or native's floor sits in it: a walk.
  const walked = { walks: [`${CH} gX 3`], catchUps: [] };
  assert.deepEqual(
    await run(foreign, { predecessor: (g) => g === "gX" }),
    walked,
  );
  const floor = { group_id: "gX", epoch: 7, stopped: null };
  assert.deepEqual(
    await run(foreign, { state: nativeState({ history_floor: floor }) }),
    walked,
  );
  // The channel's own group is never its own predecessor.
  const ownFloor = { group_id: "g0", epoch: 2, stopped: null };
  assert.deepEqual(
    await run(above, {
      state: nativeState({ history_floor: ownFloor }),
      predecessor: () => true,
    }),
    { walks: [], catchUps: [`catchUp ${CH} 9 g0`] },
  );
});

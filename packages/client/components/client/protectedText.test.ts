// Unit spec for the Protected channels text-plane manager (W4 lane B1) —
// run with Node's built-in runner:
//   node --test --conditions=browser components/client/protectedText.test.ts
// Every flow runs over a FAKE port: a virtual clock (`advance`), a scripted
// native (`handlers`, per-channel `TextChannelState`) and a scripted courier
// (`routes`). Plan 7 manager flows: protect → genesis create → seat → admit
// → message; unseat; pending-removal Remove by a non-owner; recovery (lost
// response, Lost{self}, refusal-raced-own-insert, 404, access refusal);
// owner change parks + confirm re-verifies + reprocesses; IdentityPinRequired
// retry once; D24 verify answers; UnexpectedMlsContent ack+drop; join retries
// cancelled on Welcome and by member_added; _update after Welcome; flag
// stripped → unverified; ChannelDelete keeps state. Named controls:
// [RC NEW-5] refetched own row with different bytes, [RC NEW-6] orphan
// protected-send entries at start, [RC NEW-7] never-seated unopened channel.
// W3 command shapes (2026-10-25, lane F1): `_join` returns
// `{intent, key_packages}`; the package is PUT before the intent alone is
// posted (429/5xx retried, other 4xx never posts); every `_commit_won`
// carries `rejoinIntents` (plain win: this commit's; refetch: the DS's).
// Controls C-F1a/b/c target the tests named "F1 ...". W4d (lane L-MGR, the
// tests named "W4d ..."): sticky loud groupError (X#1), resume of a
// persisted stage (X#2), no false rollback (X#3), own-send binding and the
// native own view (X#4), not_member (X#5), member_added before every join
// (X#6), parked dedupe (X#9), un-strip (F#3), commit cap refusals. S7 C9
// (the tests named "C9 protector ..."): the protector back-off (EL-F7,
// AND-F13); controls: gate bypassed, and protector surfaced to the flows.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MlsJoinRequest, MlsMemberDevice } from "./e2ee";
import {
  computeShieldState,
  protectedNoticeForError,
  shieldInputsFromView,
} from "./protectedShield.ts";
import {
  type ProtectedTextPortExtensions,
  FIRST_SIGHT_PER_MINUTE,
  HOLD_RETRY_BUDGET,
  KEY_PACKAGE_PUT_429_BUDGET,
  ProtectedTextManager,
  REFETCH_403_PARK_BUDGET,
  STALE_SEATS_REFETCH_BUDGET,
  STICKY_GROUP_ERRORS,
  WON_ROW_READ_BUDGET,
} from "./protectedText.ts";
import { textGroupId } from "./protectedTextIds.ts";
import { JOIN_RETRIES } from "./protectedTextPolicy.ts";
import type {
  MessageFlows,
  OwnerFlows,
  PendingCommit,
  ProtectedChannelView,
  ProtectedMessageView,
  ProtectedTextManagerCtor,
  ProtectedTextManagerDeps,
  ProtectedTextPort,
  TextApiResponse,
  TextChannelState,
  TextCommand,
  TextCommandArgs,
  TextCommandResult,
  TextEnvelope,
  TextJoinIntent,
  TextLogIds,
  TextMember,
  TextProcessOutcome,
  TextSubmitCommitPayload,
  TimelineMarker,
} from "./protectedTextTypes";

// Compile-time: the class satisfies the pinned A1 constructor (RC NEW-8a).
const _ctor: ProtectedTextManagerCtor = ProtectedTextManager;
void _ctor;

const CH = "01J9Z3K4M5N6P7Q8R9S0T1V2W3";
const SELF = "USELF";
const DEV = "dev-self";
const OWNER = "UOWNER";
const OWNER_DEV = "dev-owner";
const PEER = "UPEER";
const PEER_DEV = "dev-peer";
const G0 = await textGroupId(CH, 0);
const G1 = await textGroupId(CH, 1);
const CID1 = "01J9Z3K4M5N6P7Q8R9S0T1V2W5";
const CID2 = "01J9Z3K4M5N6P7Q8R9S0T1V2W6";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function mem(user_id: string, device_id: string): TextMember {
  return {
    user_id,
    device_id,
    user_verified: true,
    on_signed_list: true,
    removed_locally: false,
  };
}

function st(over: Partial<TextChannelState> = {}): TextChannelState {
  return {
    channel_id: CH,
    group_id: G0,
    generation: 0,
    epoch: 3,
    state: "active",
    members: [mem(SELF, DEV), mem(OWNER, OWNER_DEV), mem(PEER, PEER_DEV)],
    seat_list: {
      version: 1,
      signer_user_id: OWNER,
      signer_device_id: OWNER_DEV,
      seats: [OWNER, PEER, SELF],
      device_cap: 5,
      issued_at: 0,
    },
    owner_pin: {
      channel_id: CH,
      status: "pinned",
      owner_user_id: OWNER,
      owner_device_id: OWNER_DEV,
      owner_verified: true,
      source: "first_sight",
      pending_signer: null,
    },
    self_seated: true,
    roster_matches_list: true,
    update_due: false,
    update_required: false,
    verdict: "ok",
    ...over,
  };
}

/** A channel this device holds no group for and holds no list for. */
function noGroup(ch: string, over: Partial<TextChannelState> = {}) {
  return st({
    channel_id: ch,
    group_id: null,
    generation: null,
    epoch: null,
    state: "none",
    members: [],
    seat_list: null,
    self_seated: false,
    verdict: "no_seat_list",
    ...over,
  });
}

function seatsBody(over: Record<string, unknown> = {}) {
  return {
    list: {
      version: 1,
      body: "sloga-seat-list-v1\n...",
      signature: "SIG",
      signer_user_id: OWNER,
      signer_device_id: OWNER_DEV,
      handovers: [],
    },
    as_of_epoch: 3,
    as_of_group_id: G0,
    entitlement_device_cap: 5,
    slot_cap: 10,
    device_cap: 5,
    seats_used: 3,
    seats: [OWNER, PEER, SELF].map((user_id) => ({ user_id, seated_at: "" })),
    cooling: [],
    ...over,
  };
}

function groupBody(over: Record<string, unknown> = {}) {
  return {
    group_id: G0,
    channel_id: CH,
    generation: 0,
    current_epoch: 3,
    members: [
      { user_id: SELF, device_id: DEV },
      { user_id: OWNER, device_id: OWNER_DEV },
      { user_id: PEER, device_id: PEER_DEV },
    ],
    pending_removals: [],
    member_added: [],
    ...over,
  };
}

function outcome(over: Partial<TextProcessOutcome> = {}): TextProcessOutcome {
  return {
    group_id: G0,
    channel_id: CH,
    kind: "commit_applied",
    epoch: 4,
    removed_self: false,
    added: [],
    removed: [],
    new_devices: [],
    off_list: [],
    seat_list_adopted: null,
    ...over,
  };
}

function commitPayload(epoch: number, commit: string): TextSubmitCommitPayload {
  return { device_id: DEV, epoch, commit, welcome: null };
}

function envelope(id: string, epoch: number, over: Partial<TextEnvelope> = {}) {
  const env: TextEnvelope = {
    id,
    content_type: "mls_commit",
    group_id: G0,
    epoch,
    ciphertext: "CT",
    committer: { user_id: OWNER, device_id: OWNER_DEV },
    added: [],
    removed: [],
    rejoin_intents: [],
    recipientDeviceId: DEV,
    ...over,
  };
  return env;
}

function ownRow(epoch: number, commit: string) {
  return {
    group_id: G0,
    epoch,
    committer: { user_id: SELF, device_id: DEV },
    commit,
    added: [],
    removed: [],
  };
}

function ok(body: unknown, status = 200): TextApiResponse {
  return { status, resetAfterMs: null, body };
}

/** The `encrypted` payload of the fake own send. */
const SENT_PAYLOAD = {
  v: 1 as const,
  group_id: G0,
  epoch: 3,
  sender_device_id: DEV,
  nonce: "AEAD",
  ciphertext: "CT",
  sig: "SIG",
};

/** The server row a delivered own send answers (B4 checked the binding). */
function sentRow(ch = CH, over: Record<string, unknown> = {}) {
  return {
    _id: "MSENT",
    channel: ch,
    author: SELF,
    nonce: CID1,
    encrypted: SENT_PAYLOAD,
    ...over,
  };
}

/** `_join`'s n-th answer: a fresh one-time package per intent (W3). */
function joinIntent(n: number): TextJoinIntent {
  const ref = `KPR-${n}`;
  return {
    intent: { device_id: DEV, key_package_ref: ref, signature: `JSIG-${n}` },
    key_packages: {
      device_id: DEV,
      mls_signature_key: "MSK-SELF",
      binding_signature: "BS-SELF",
      key_packages: [{ key_package_ref: ref, key_package: `KP-${n}` }],
    },
  };
}

/** A fanned-out join intent (the `MlsJoinRequested` shape). */
function joinRequest(signature: string): MlsJoinRequest {
  return {
    group_id: G0,
    channel_id: CH,
    user_id: PEER,
    device_id: PEER_DEV,
    key_package_ref: "KPR-PEER",
    signature,
  };
}

// ---------------------------------------------------------------------------
// Fake port
// ---------------------------------------------------------------------------

type Handlers = {
  [C in TextCommand]?: (
    args: TextCommandArgs[C],
  ) => TextCommandResult[C] | Promise<TextCommandResult[C]>;
};

type Route = (
  method: string,
  path: string,
  body: unknown,
) => TextApiResponse | "transport" | undefined;

interface Sleep {
  at: number;
  resolve: () => void;
}

/**
 * Settle pending work. The manager's `#register` awaits A4's id index,
 * whose 64 `crypto.subtle.digest` calls complete on libuv's threadpool in
 * REAL time (not the virtual clock); under host load a microtask/immediate
 * flush alone can finish first and make a test flaky or hang. So each round
 * also awaits a batch of our own digests: the threadpool queue is FIFO, so
 * they finish after the digests queued before them.
 */
async function flush(): Promise<void> {
  const one = new Uint8Array(1);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 60; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }
    await Promise.all(
      Array.from({ length: 8 }, () => crypto.subtle.digest("SHA-256", one)),
    );
  }
  for (let i = 0; i < 60; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

class Env implements ProtectedTextPort, ProtectedTextPortExtensions {
  readonly selfUserId = SELF;
  readonly selfDeviceId = DEV;
  clock = 1_700_000_000_000;
  sleeps: Sleep[] = [];
  states = new Map<string, TextChannelState>([[CH, st()]]);
  invokes: { cmd: TextCommand; args: unknown }[] = [];
  handlers: Handlers;
  apiCalls: { method: string; path: string; body: unknown }[] = [];
  routes: Route[] = [];
  acks: string[] = [];
  logs: { level: string; msg: string; ids: TextLogIds }[] = [];
  pins: { userId: string; targets: string[] }[] = [];
  notified: string[] = [];
  listingHash = "h1";
  storeMap = new Map<string, string>();
  liveKeys = new Set<string>();
  outboxThrows = false;
  seats: Record<string, unknown> | null = seatsBody();
  group: Record<string, unknown> | null = groupBody();
  pending: PendingCommit | null = null;
  views = new Map<string, ProtectedChannelView>();
  msgViews = new Map<string, ProtectedMessageView>();
  markers: TimelineMarker[] = [];
  decrypts: string[] = [];
  decryptCalls: { id: string; live: boolean }[] = [];
  sends: string[] = [];
  joins = 0;
  /** Native commands and courier calls, in call order. */
  trace: string[] = [];
  /** Commit rows the fake DS stored on a 2xx (served by the refetch GET). */
  rows: {
    group_id: string;
    epoch: number;
    committer: MlsMemberDevice;
    commit: string;
    added: MlsMemberDevice[];
    removed: MlsMemberDevice[];
    rejoin_intents?: MlsJoinRequest[];
  }[] = [];
  /** The DS's own `rejoin_intents` for the rows it stores (null: absent). */
  dsRejoin: MlsJoinRequest[] | null = null;
  /** Overrides the stored `commit` string (RC NEW-5 on a plain win). */
  storedCommit: string | null = null;

  constructor() {
    this.handlers = defaultHandlers(this);
  }

  state(ch = CH): TextChannelState {
    let s = this.states.get(ch);
    if (!s) {
      s = noGroup(ch);
      this.states.set(ch, s);
    }
    return s;
  }

  calls<C extends TextCommand>(cmd: C): TextCommandArgs[C][] {
    return this.invokes
      .filter((i) => i.cmd === cmd)
      .map((i) => i.args as TextCommandArgs[C]);
  }

  api$(method: string, re: RegExp) {
    return this.apiCalls.filter((c) => c.method === method && re.test(c.path));
  }

  invoke<C extends TextCommand>(
    cmd: C,
    args: TextCommandArgs[C],
  ): Promise<TextCommandResult[C]> {
    this.invokes.push({ cmd, args: structuredClone(args) });
    this.trace.push(cmd);
    const h = this.handlers[cmd] as
      | ((a: TextCommandArgs[C]) => TextCommandResult[C])
      | undefined;
    if (!h) {
      return Promise.reject({ type: "invalid_argument", field: cmd });
    }
    return Promise.resolve().then(() => h(args));
  }

  async pinCallIdentities(userId: string, targets: string[]) {
    this.pins.push({ userId, targets });
    return targets;
  }

  async ownDeviceListing() {
    return { hash: this.listingHash, listing: [{ device_id: DEV }] };
  }

  async api(method: string, path: string, body?: unknown) {
    this.apiCalls.push({ method, path, body: structuredClone(body) });
    this.trace.push(`${method} ${path}`);
    for (const r of [...this.routes, defaultRoute(this)]) {
      const a = r(method, path, body);
      if (a === "transport") throw new Error("network");
      if (a !== undefined) return a;
    }
    return ok({ type: "NotFound" }, 404);
  }

  async ack(ids: string[]) {
    this.acks.push(...ids);
  }

  now() {
    return this.clock;
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const s: Sleep = { at: this.clock + ms, resolve };
      this.sleeps.push(s);
      signal.addEventListener(
        "abort",
        () => {
          const i = this.sleeps.indexOf(s);
          if (i >= 0) this.sleeps.splice(i, 1);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  }

  log(
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    ids: TextLogIds,
  ) {
    this.logs.push({ level, msg, ids });
  }

  channelInfo(channelId: string) {
    return {
      channelId,
      name: "general",
      serverId: "SERVER",
      serverOwnerId: OWNER,
      serverProtected: true,
      locallyPinned: true,
    };
  }

  displayNames(userIds: string[]) {
    return userIds.map((user_id) => ({ user_id, name: `name-${user_id}` }));
  }

  store = {
    get: (k: string) => this.storeMap.get(k) ?? null,
    set: (k: string, v: string) => {
      this.storeMap.set(k, v);
      return true;
    },
    delete: (k: string) => {
      this.storeMap.delete(k);
    },
  };

  storeKeys(prefix: string) {
    return [...this.storeMap.keys()].filter((k) => k.startsWith(prefix));
  }

  liveOutboxKeys() {
    if (this.outboxThrows) throw new Error("outbox not loaded");
    return this.liveKeys;
  }

  notify(kind: "unsolicited_welcome") {
    this.notified.push(kind);
  }

  /** Advance the virtual clock, resolving due sleeps in order. */
  async advance(ms: number): Promise<void> {
    const target = this.clock + ms;
    for (;;) {
      await flush();
      this.sleeps.sort((a, b) => a.at - b.at);
      const next = this.sleeps[0];
      if (!next || next.at > target) break;
      this.sleeps.shift();
      this.clock = Math.max(this.clock, next.at);
      next.resolve();
    }
    this.clock = target;
    await flush();
  }

  shield(
    ch = CH,
    flags: { serverProtected?: boolean; locallyPinned?: boolean } = {},
  ) {
    return computeShieldState(
      shieldInputsFromView(
        this.views.get(ch),
        {
          serverProtected: flags.serverProtected ?? true,
          locallyPinned: flags.locallyPinned ?? true,
          capable: true,
        },
        this.clock,
      ),
    );
  }
}

function defaultHandlers(env: Env): Handlers {
  const stage = (p: TextSubmitCommitPayload) => {
    env.pending = { epoch: p.epoch, commit_b64: p.commit };
    return p;
  };
  return {
    e2ee_text_state: (a) => structuredClone(env.state(a.channelId)),
    e2ee_text_seat_list_verify: () => ({
      status: "accepted",
      version: 1,
      seats: [OWNER, PEER, SELF],
      device_cap: 5,
      signer_user_id: OWNER,
      signer_device_id: OWNER_DEV,
      pinned_now: false,
    }),
    e2ee_text_pin_own_devices: () => null,
    e2ee_mls_group_kind: () => "text",
    e2ee_text_process: (a) => {
      const s = env.state();
      s.epoch = a.envelope.epoch;
      return outcome({
        epoch: a.envelope.epoch,
        group_id: a.envelope.group_id,
      });
    },
    e2ee_text_update: () =>
      stage(commitPayload((env.state().epoch ?? 0) + 1, "UPD")),
    e2ee_text_remove: () =>
      stage(commitPayload((env.state().epoch ?? 0) + 1, "REM")),
    e2ee_text_admit: () => ({
      ...stage(commitPayload((env.state().epoch ?? 0) + 1, "ADM")),
      welcome: "WEL",
      added: [{ user_id: PEER, device_id: "dev-new" }],
    }),
    e2ee_text_commit_won: (a) => {
      const s = env.state();
      s.epoch = a.wonEpoch;
      s.update_due = false;
      s.update_required = false;
      env.pending = null;
      return outcome({ epoch: a.wonEpoch, group_id: a.groupId });
    },
    e2ee_text_commit_lost: () => {
      env.pending = null;
      return null;
    },
    e2ee_text_pending_commit: () => env.pending,
    e2ee_text_join: () => joinIntent(++env.joins),
    e2ee_text_mark_left: () => {
      const s = env.state();
      s.state = "left";
      s.verdict = "no_group";
      return null;
    },
    e2ee_text_group_create: (a) => {
      const generation = a.supersedes ? 1 : 0;
      const group_id = generation ? G1 : G0;
      env.states.set(
        a.channelId,
        st({
          channel_id: a.channelId,
          group_id,
          generation,
          epoch: 0,
          members: [mem(SELF, DEV)],
          seat_list: {
            version: 1,
            signer_user_id: SELF,
            signer_device_id: DEV,
            seats: [SELF],
            device_cap: 5,
            issued_at: 0,
          },
        }),
      );
      return {
        group_id,
        generation,
        payload: {
          group_id,
          channel_id: a.channelId,
          device_id: DEV,
          supersedes: a.supersedes,
          kind: "Text",
          generation,
        },
      };
    },
    e2ee_text_owner_confirm_change: () => null,
  };
}

function defaultRoute(env: Env): Route {
  return (method, path, body) => {
    if (method === "GET" && /^\/channels\/[^/]+\/seats$/.test(path)) {
      return env.seats ? ok(env.seats) : ok({ type: "NotFound" }, 404);
    }
    if (method === "GET" && /^\/mls\/channels\/[^/]+\/text_group$/.test(path)) {
      return env.group ? ok(env.group) : ok({ type: "NotFound" }, 404);
    }
    if (method === "POST" && /^\/mls\/groups\/[0-9a-f]+\/commits$/.test(path)) {
      // A bare `Won`; the DS keeps the row (with ITS rejoin_intents).
      const b = body as TextSubmitCommitPayload;
      const group_id = path.split("/")[3];
      if (
        !env.rows.some((r) => r.group_id === group_id && r.epoch === b.epoch)
      ) {
        env.rows.push({
          group_id,
          epoch: b.epoch,
          committer: { user_id: SELF, device_id: b.device_id },
          commit: env.storedCommit ?? b.commit,
          added: b.added ?? [],
          removed: b.removed ?? [],
          ...(env.dsRejoin ? { rejoin_intents: env.dsRejoin } : {}),
        });
      }
      return ok({ result: "Won" });
    }
    if (method === "GET" && /\/commits\?from_epoch=/.test(path)) {
      const group_id = path.split("/")[3];
      const from = Number(path.split("from_epoch=")[1]);
      const commits = env.rows.filter(
        (r) => r.group_id === group_id && r.epoch >= from,
      );
      return ok({ commits, current_epoch: 3 });
    }
    if (method === "POST" && /\/join_intent$/.test(path)) return ok(null, 204);
    if (method === "PUT" && path === "/mls/key_packages") {
      return ok({ key_package_count: 1 });
    }
    if (method === "POST" && path === "/mls/key_packages/claim") {
      const t = (body as { targets: MlsMemberDevice[] }).targets[0];
      return ok({
        results: [
          {
            ...t,
            status: "Claimed",
            key_package_ref: "KPR2",
            key_package: "KP",
            mls_signature_key: "MSK",
            binding_signature: "BS",
            reused: false,
          },
        ],
      });
    }
    if (method === "POST" && path === "/mls/groups") {
      return ok({ result: "Created" });
    }
    if (method === "GET" && /^\/channels\/[^/]+\/messages\?/.test(path)) {
      return ok([]);
    }
    return undefined;
  };
}

function fakeDeps(
  env: Env,
  over: { owner?: Partial<OwnerFlows>; messages?: Partial<MessageFlows> } = {},
): ProtectedTextManagerDeps {
  return {
    owner: {
      protect: async () => undefined,
      setSeats: async () => undefined,
      ...over.owner,
    },
    messages: {
      encryptAndSend: async (_ops, _port, ch, text) => {
        env.sends.push(text);
        return { messageId: "MSENT", cid: CID1, raw: sentRow(ch) };
      },
      decryptRow: async (_ops, _port, row, live) => {
        env.decrypts.push(row.id);
        env.decryptCalls.push({ id: row.id, live });
        return {
          status: "ok",
          text: "decrypted",
          replies: [],
          senderVerified: true,
          tsSkew: false,
          cid: row.nonce ?? "",
        };
      },
      markerForError: () => "error",
      ...over.messages,
    },
  };
}

function make(env: Env, deps?: ProtectedTextManagerDeps) {
  return new ProtectedTextManager(
    env,
    {
      onView: (ch, v) => env.views.set(ch, v),
      onMessageView: (id, v) => env.msgViews.set(id, v),
      onTimelineMarker: (_ch, m) => env.markers.push(m),
    },
    deps ?? fakeDeps(env),
  );
}

const silence = (p: Promise<unknown>) => {
  p.catch(() => undefined);
  return p;
};

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

test("protect → genesis create → seat → admit → message", async () => {
  const env = new Env();
  env.states.set(CH, noGroup(CH));
  env.group = null;
  let inFlightSeen = false;
  const deps = fakeDeps(env, {
    owner: {
      protect: async (ops, _port, ch) => {
        inFlightSeen = ops.stateOf(ch)?.publishInFlight === true;
        env.group = groupBody({
          current_epoch: 0,
          members: [{ user_id: SELF, device_id: DEV }],
        });
        await ops.createGroup(ch, null);
      },
    },
  });
  const m = make(env, deps);
  await m.protect(CH, [SELF, PEER], 5);
  await env.advance(0);
  assert.equal(inFlightSeen, true, "publishInFlight during the publish");
  assert.equal(env.views.get(CH)?.publishInFlight, false);
  const create = env.calls("e2ee_text_group_create");
  assert.deepEqual(create[0], {
    channelId: CH,
    userId: SELF,
    supersedes: null,
  });
  const post = env.api$("POST", /^\/mls\/groups$/);
  assert.equal(post.length, 1);
  assert.equal((post[0].body as { kind: string }).kind, "Text");
  assert.equal((post[0].body as { generation: number }).generation, 0);

  // Seat + admit: a seated member's join intent is admitted.
  env.seats = seatsBody({ as_of_epoch: 0 });
  env.group = groupBody({ current_epoch: 0 });
  const req: MlsJoinRequest = {
    group_id: G0,
    channel_id: CH,
    user_id: PEER,
    device_id: PEER_DEV,
    key_package_ref: "KPR",
    signature: "S",
  };
  m.onJoinRequest(req, false);
  await env.advance(0);
  const claim = env.api$("POST", /claim$/);
  assert.equal(claim.length, 1);
  assert.deepEqual(env.pins.at(-1), { userId: PEER, targets: [PEER_DEV] });
  const admit = env.calls("e2ee_text_admit")[0];
  assert.equal(admit.claimed.key_package_ref, "KPR2");
  assert.equal("status" in admit.claimed, false, "flattened claim");
  const commit = env.api$("POST", /\/commits$/).at(-1);
  assert.equal((commit?.body as { commit: string }).commit, "ADM");
  assert.equal((commit?.body as { welcome: string }).welcome, "WEL");
  const won = env.calls("e2ee_text_commit_won").at(-1);
  assert.deepEqual(won, {
    groupId: G0,
    wonEpoch: 1,
    storedCommitB64: "ADM",
    rejoinIntents: [],
  });

  // Message: live row decrypted through B4. The own send's view comes from
  // ONE native decrypt of the delivered row (live: false; W4d X#4 replaced
  // the typed-plaintext view), and its live echo is served from that view.
  m.onMessage(
    { id: "M1", channelId: CH, authorId: PEER, nonce: CID2, encrypted: null },
    true,
  );
  await env.advance(0);
  assert.equal(env.msgViews.get("M1")?.status, "ok");
  const out = await m.send(CH, "hello", [], false, "k1");
  assert.equal(out.messageId, "MSENT");
  const own = env.msgViews.get("MSENT");
  assert.ok(own?.status === "ok" && own.text === "decrypted", "native view");
  assert.deepEqual(
    env.decryptCalls.filter((c) => c.id === "MSENT"),
    [{ id: "MSENT", live: false }],
  );
  m.onMessage(
    {
      id: "MSENT",
      channelId: CH,
      authorId: SELF,
      nonce: CID1,
      encrypted: SENT_PAYLOAD,
    },
    true,
  );
  await env.advance(0);
  assert.equal(
    env.decrypts.filter((id) => id === "MSENT").length,
    1,
    "own echo deduped",
  );
  m.dispose();
});

test("unseat: removeDevices passes pending_removal_users and commits", async () => {
  const env = new Env();
  env.group = groupBody({
    pending_removals: [{ user_id: PEER, created_at: "" }],
  });
  env.states.set(
    CH,
    st({
      members: [mem(OWNER, OWNER_DEV), mem(PEER, PEER_DEV), mem(SELF, DEV)],
    }),
  );
  const m = make(env);
  await m.refresh(CH, "open");
  await m.removeDevices(CH, [{ user_id: PEER, device_id: PEER_DEV }], {
    rejoinIntent: null,
  });
  const rm = env.calls("e2ee_text_remove")[0];
  assert.deepEqual(rm, {
    groupId: G0,
    targets: [{ user_id: PEER, device_id: PEER_DEV }],
    rejoinIntent: null,
    pendingRemovalUsers: [PEER],
  });
  assert.equal(
    env.calls("e2ee_text_commit_won").at(-1)?.storedCommitB64,
    "REM",
  );
  assert.deepEqual(
    env.calls("e2ee_text_commit_won").at(-1)?.rejoinIntents,
    [],
    "a Remove without an intent carries none",
  );
  m.dispose();
});

test("pending-removal Remove by a non-owner (rule 4a), staggered", async () => {
  const env = new Env();
  env.group = groupBody({
    pending_removals: [{ user_id: PEER, created_at: "" }],
  });
  // self is leaf 1 → 2 s stagger; PEER holds two devices.
  env.states.set(
    CH,
    st({
      members: [
        mem(OWNER, OWNER_DEV),
        mem(SELF, DEV),
        mem(PEER, PEER_DEV),
        mem(PEER, "dev-peer-2"),
      ],
    }),
  );
  const m = make(env);
  await m.refresh(CH, "interval");
  await env.advance(1_999);
  assert.equal(env.calls("e2ee_text_remove").length, 0, "staggered");
  await env.advance(1);
  const rm = env.calls("e2ee_text_remove");
  assert.equal(rm.length, 1);
  assert.deepEqual(rm[0].targets, [
    { user_id: PEER, device_id: PEER_DEV },
    { user_id: PEER, device_id: "dev-peer-2" },
  ]);
  assert.deepEqual(rm[0].pendingRemovalUsers, [PEER]);
  assert.equal(rm[0].rejoinIntent, null);
  m.dispose();
});

/**
 * Drive one remove whose submit is scripted by `routes`. Returns the
 * remove's promise WRAPPED, so a caller asserts before awaiting it.
 */
async function scriptedRemove(env: Env, m: ProtectedTextManager) {
  await m.refresh(CH, "open");
  const p = silence(
    m.removeDevices(CH, [{ user_id: PEER, device_id: PEER_DEV }], {
      rejoinIntent: null,
    }),
  );
  await env.advance(120_000);
  return { p };
}

test("recovery: lost response fetches {group}:{epoch} first → won", async () => {
  const env = new Env();
  let posts = 0;
  env.routes.push((method, path) => {
    if (method === "POST" && path.endsWith("/commits")) {
      posts++;
      return "transport";
    }
    if (method === "GET" && path.includes("from_epoch=4")) {
      return ok({ commits: [ownRow(4, "REM")], current_epoch: 4 });
    }
    return undefined;
  });
  const m = make(env);
  const { p } = await scriptedRemove(env, m);
  await p;
  assert.equal(posts, 1, "never resubmitted without fetching");
  assert.ok(env.api$("GET", /from_epoch=4/).length >= 1);
  assert.equal(env.calls("e2ee_text_commit_won")[0].storedCommitB64, "REM");
  assert.equal(env.calls("e2ee_text_commit_lost").length, 0);
  m.dispose();
});

test("recovery: Lost{self} is confirmed by refetch → won", async () => {
  const env = new Env();
  env.routes.push((method, path) => {
    if (method === "POST" && path.endsWith("/commits")) {
      return ok({ result: "Lost", winning: ownRow(4, "REM") }, 409);
    }
    if (method === "GET" && path.includes("from_epoch=4")) {
      return ok({ commits: [ownRow(4, "REM")], current_epoch: 4 });
    }
    return undefined;
  });
  const m = make(env);
  const { p } = await scriptedRemove(env, m);
  await p;
  assert.ok(env.api$("GET", /from_epoch=4/).length >= 1);
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  m.dispose();
});

test("recovery: a refusal that raced our own insert → won", async () => {
  const env = new Env();
  env.routes.push((method, path) => {
    if (method === "POST" && path.endsWith("/commits")) {
      return ok(
        { type: "ProtectedChannelResecuring", reason: "stale_seat_list" },
        409,
      );
    }
    if (method === "GET" && path.includes("from_epoch=4")) {
      return ok({ commits: [ownRow(4, "REM")], current_epoch: 4 });
    }
    return undefined;
  });
  const m = make(env);
  const { p } = await scriptedRemove(env, m);
  await p;
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  assert.equal(env.calls("e2ee_text_commit_lost").length, 0);
  m.dispose();
});

test("recovery: 404 on resubmit → mark_left(not_found) → rejoin", async () => {
  const env = new Env();
  let posts = 0;
  env.routes.push((method, path) => {
    if (method === "POST" && path.endsWith("/commits")) {
      posts++;
      return posts === 1 ? ok({ type: "DatabaseError" }, 503) : ok({}, 404);
    }
    return undefined; // refetch: absent → resubmit identical bytes
  });
  const m = make(env);
  await assert.rejects((await scriptedRemove(env, m)).p);
  assert.equal(posts, 2);
  const bodies = env.api$("POST", /\/commits$/).map((c) => c.body);
  assert.deepEqual(bodies[0], bodies[1], "identical bytes on resubmit");
  assert.deepEqual(env.calls("e2ee_text_mark_left"), [
    { groupId: G0, reason: "not_found" },
  ]);
  assert.ok(env.calls("e2ee_text_join").length >= 1, "rejoin path");
  assert.equal(env.calls("e2ee_text_join")[0].groupId, G0);
  m.dispose();
});

test("recovery: access refusal on a resubmit → mark_left(not_member)", async () => {
  const env = new Env();
  let posts = 0;
  env.routes.push((method, path) => {
    if (method === "POST" && path.endsWith("/commits")) {
      posts++;
      return posts === 1 ? "transport" : ok({ type: "NotSeated" }, 403);
    }
    return undefined;
  });
  const m = make(env);
  await assert.rejects((await scriptedRemove(env, m)).p);
  assert.deepEqual(env.calls("e2ee_text_mark_left")[0], {
    groupId: G0,
    reason: "not_member",
  });
  assert.equal(env.calls("e2ee_text_commit_lost").length, 0);
  m.dispose();
});

test("control RC NEW-5: refetched own row with different bytes → _commit_won with the DS string, never _commit_lost", async () => {
  const env = new Env();
  env.routes.push((method, path) => {
    if (method === "POST" && path.endsWith("/commits")) return "transport";
    if (method === "GET" && path.includes("from_epoch=4")) {
      return ok({ commits: [ownRow(4, "OTHER-BYTES")], current_epoch: 4 });
    }
    return undefined;
  });
  env.handlers.e2ee_text_commit_won = () => {
    // Native wipes the group (state left) before answering the mismatch.
    env.state().state = "left";
    env.state().verdict = "no_group";
    throw { type: "own_commit_mismatch", group_id: G0, epoch: 4 };
  };
  const m = make(env);
  await assert.rejects((await scriptedRemove(env, m)).p);
  const won = env.calls("e2ee_text_commit_won");
  assert.equal(won.length, 1);
  assert.equal(won[0].storedCommitB64, "OTHER-BYTES");
  assert.equal(env.calls("e2ee_text_commit_lost").length, 0);
  assert.ok(env.calls("e2ee_text_join").length >= 1, "left → rejoin");
  m.dispose();
});

test("binding: a first-submit 403 on the refetch parks the commit, resumed on the next refresh", async () => {
  const env = new Env();
  let refetchAllowed = false;
  env.routes.push((method, path) => {
    if (method === "POST" && path.endsWith("/commits")) return "transport";
    if (method === "GET" && path.includes("from_epoch=4")) {
      return refetchAllowed
        ? ok({ commits: [ownRow(4, "REM")], current_epoch: 4 })
        : ok({ type: "MissingPermission" }, 403);
    }
    return undefined;
  });
  const m = make(env);
  const { p } = await scriptedRemove(env, m);
  const gets = env.api$("GET", /from_epoch=4/).length;
  assert.equal(gets, REFETCH_403_PARK_BUDGET, "bounded, then parked");
  await env.advance(600_000);
  assert.equal(env.api$("GET", /from_epoch=4/).length, gets, "no retry loop");
  assert.equal(env.calls("e2ee_text_mark_left").length, 0, "never wiped");
  assert.equal(env.calls("e2ee_text_commit_lost").length, 0);
  await assert.rejects(
    p,
    (e: { reason?: string }) => e.reason === "commit_parked",
  );
  refetchAllowed = true;
  await m.refresh(CH, "interval");
  await env.advance(1_000);
  assert.equal(env.calls("e2ee_text_commit_won").length, 1, "resumed");
  m.dispose();
});

test("owner change parks (unacked) + confirm re-verifies + reprocesses in order", async () => {
  const env = new Env();
  let blocked = true;
  env.handlers.e2ee_text_process = (a) => {
    if (blocked) {
      throw {
        type: "owner_changed",
        channel_id: CH,
        signer_user_id: OWNER,
        signer_device_id: "dev-owner-2",
        same_user: true,
        verified: true,
      };
    }
    env.state().epoch = a.envelope.epoch;
    return outcome({ epoch: a.envelope.epoch });
  };
  const m = make(env);
  m.channelProtected(CH);
  await env.advance(0);
  m.onEnvelope(envelope("E1", 4));
  m.onEnvelope(envelope("E2", 5));
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_process").length, 1, "E2 parked behind");
  assert.deepEqual(env.acks, []);
  assert.equal(env.views.get(CH)?.ownerChangePending, true);
  assert.equal(env.shield(), "unverified");
  blocked = false;
  const verifiesBefore = env.calls("e2ee_text_seat_list_verify").length;
  await m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_owner_confirm_change").length, 1);
  assert.deepEqual(env.calls("e2ee_text_owner_confirm_change")[0], {
    channelId: CH,
    channelName: "general",
    displayNames: [],
  });
  assert.ok(
    env.calls("e2ee_text_seat_list_verify").length > verifiesBefore,
    "re-verified",
  );
  const order = env.invokes.map((i) => i.cmd);
  const confirmAt = order.indexOf("e2ee_text_owner_confirm_change");
  const reprocessAt = order.indexOf("e2ee_text_process", confirmAt);
  const verifyAt = order.indexOf("e2ee_text_seat_list_verify", confirmAt);
  assert.ok(
    verifyAt > confirmAt && verifyAt < reprocessAt,
    "verify runs before the parked envelope is reprocessed",
  );
  assert.deepEqual(
    env.calls("e2ee_text_process").map((a) => a.envelope.id),
    ["E1", "E1", "E2"],
  );
  assert.deepEqual(env.acks, ["E1", "E2"]);
  assert.equal(env.views.get(CH)?.ownerChangePending, false);
  m.dispose();
});

test("IdentityPinRequired: pin that user's listing, retry ONCE", async () => {
  const env = new Env();
  let n = 0;
  env.handlers.e2ee_text_process = (a) => {
    n++;
    if (n === 1) {
      throw { type: "identity_pin_required", user_id: PEER, device_id: "dX" };
    }
    return outcome({ epoch: a.envelope.epoch });
  };
  const m = make(env);
  m.channelProtected(CH);
  await env.advance(0);
  m.onEnvelope(envelope("E1", 4));
  await env.advance(0);
  assert.deepEqual(env.pins, [{ userId: PEER, targets: ["dX"] }]);
  assert.equal(n, 2);
  assert.deepEqual(env.acks, ["E1"]);

  // A second IdentityPinRequired is not retried again in the same pass.
  env.handlers.e2ee_text_process = () => {
    n++;
    throw { type: "identity_pin_required", user_id: SELF, device_id: "dY" };
  };
  n = 0;
  const pinOwnBefore = env.calls("e2ee_text_pin_own_devices").length;
  m.onEnvelope(envelope("E2", 5));
  await env.advance(0);
  assert.equal(n, 2, "one retry only");
  assert.ok(
    env.calls("e2ee_text_pin_own_devices").length > pinOwnBefore,
    "own user → own-device pin",
  );
  assert.equal(env.acks.includes("E2"), false);
  assert.equal(env.views.get(CH)?.groupError ?? null, null);
  m.dispose();
});

test("control: D24 verify passes as_of_* from GET .../seats", async () => {
  const env = new Env();
  const m = make(env);
  await m.refresh(CH, "open");
  const v = env.calls("e2ee_text_seat_list_verify")[0];
  assert.equal(v.asOfEpoch, 3);
  assert.equal(v.asOfGroupId, G0);
  assert.equal(v.serverOwnerId, OWNER);
  m.dispose();
});

test("D24: MlsEpochGap → gap refetch to as_of_epoch, re-verify ONCE; synth ids never acked", async () => {
  const env = new Env();
  env.seats = seatsBody({ as_of_epoch: 5 });
  let verifies = 0;
  env.handlers.e2ee_text_seat_list_verify = () => {
    verifies++;
    if (verifies === 1) {
      throw { type: "mls_epoch_gap", group_id: G0, expected: 4, got: 5 };
    }
    return {
      status: "accepted",
      version: 1,
      seats: [],
      device_cap: 5,
      signer_user_id: OWNER,
      signer_device_id: OWNER_DEV,
      pinned_now: false,
    };
  };
  const row = (epoch: number) => ({
    group_id: G0,
    epoch,
    committer: { user_id: OWNER, device_id: OWNER_DEV },
    commit: `C${epoch}`,
    added: [],
    removed: [],
  });
  env.routes.push((method, path) => {
    if (method === "GET" && path.includes("from_epoch=4")) {
      return ok({ commits: [row(4), row(5)], current_epoch: 5 });
    }
    return undefined;
  });
  const m = make(env);
  await m.refresh(CH, "open");
  // First verify refused (gap), the re-verify after catch-up accepted; a
  // coalesced post-commit refresh pass may verify once more.
  assert.ok(verifies >= 2);
  const processed = env.calls("e2ee_text_process").map((a) => a.envelope);
  assert.deepEqual(
    processed.map((e) => e.epoch),
    [4, 5],
  );
  assert.ok(processed.every((e) => e.committer !== undefined));
  assert.equal(env.acks.length, 0, "text-synth ids are never acked");
  assert.equal(env.views.get(CH)?.seatListError, null);
  m.dispose();
});

test("D24: MlsGroupNotFound → join path; SeatListBehind kept; ChannelMismatch loud", async () => {
  const env = new Env();
  env.group = groupBody({ group_id: G1, generation: 1, current_epoch: 0 });
  env.handlers.e2ee_text_seat_list_verify = () => {
    throw { type: "mls_group_not_found", group_id: G1 };
  };
  const m = make(env);
  await m.refresh(CH, "open");
  await env.advance(0);
  assert.equal(env.views.get(CH)?.seatListError, "mls_group_not_found");
  const joins = env.calls("e2ee_text_join");
  assert.ok(joins.length >= 1);
  assert.equal(joins[0].groupId, G1);
  assert.equal(joins[0].generation, 1);
  m.dispose();

  const env2 = new Env();
  env2.handlers.e2ee_text_seat_list_verify = () => {
    throw { type: "seat_list_behind", channel_id: CH, have: 3, need: 2 };
  };
  const m2 = make(env2);
  await m2.refresh(CH, "open");
  assert.equal(env2.views.get(CH)?.seatListError, "seat_list_behind");
  assert.equal(env2.calls("e2ee_text_mark_left").length, 0, "held state kept");
  m2.dispose();

  const env3 = new Env();
  env3.handlers.e2ee_text_seat_list_verify = () => {
    throw { type: "channel_mismatch", group_id: G0 };
  };
  const m3 = make(env3);
  await m3.refresh(CH, "open");
  assert.equal(env3.shield(), "unverified");
  m3.dispose();
});

test("UnexpectedMlsContent: ack + drop + loud log (ids only); shield not loud", async () => {
  const env = new Env();
  env.handlers.e2ee_text_process = () => {
    throw { type: "unexpected_mls_content", group_id: G0 };
  };
  const m = make(env);
  await m.refresh(CH, "open");
  m.onEnvelope(envelope("E1", 4));
  await env.advance(0);
  assert.deepEqual(env.acks, ["E1"]);
  const line = env.logs.find((l) => l.msg === "[protected] unexpected content");
  assert.equal(line?.level, "error");
  assert.deepEqual(line?.ids, { groupId: G0, envelopeId: "E1" });
  assert.equal(env.calls("e2ee_text_process").length, 1, "never retried");
  assert.equal(env.shield(), "protected");
  m.dispose();
});

test("binding: busy and message-level tags never become groupError", async () => {
  const env = new Env();
  let tag = "busy";
  env.handlers.e2ee_text_process = () => {
    throw { type: tag, group_id: G0, epoch: 9, oldest_held: 0, current: 3 };
  };
  const m = make(env);
  await m.refresh(CH, "open");
  m.onEnvelope(envelope("E1", 4));
  await env.advance(0);
  assert.equal(env.views.get(CH)?.groupError, null);
  assert.deepEqual(env.acks, [], "busy holds, unacked");
  tag = "unknown_epoch";
  m.onEnvelope(envelope("E2", 4));
  await env.advance(0);
  assert.equal(env.views.get(CH)?.groupError, null);
  assert.equal(env.shield(), "protected");
  m.dispose();
});

test("envelopes: wire form to native, dedup by id, wrong group kind refused unacked", async () => {
  const env = new Env();
  const m = make(env);
  await m.refresh(CH, "open");
  m.onEnvelope(envelope("E1", 4));
  m.onEnvelope(envelope("E1", 4));
  await env.advance(0);
  const p = env.calls("e2ee_text_process");
  assert.equal(p.length, 1, "deduped");
  assert.equal("recipientDeviceId" in p[0].envelope, false);
  assert.equal(p[0].userId, SELF);
  m.onEnvelope(envelope("E1", 4));
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_process").length, 1, "seen id ignored");

  env.handlers.e2ee_mls_group_kind = () => "call";
  m.onEnvelope(envelope("E9", 5));
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_process").length, 1, "never processed");
  assert.equal(env.acks.includes("E9"), false);
  assert.equal(env.views.get(CH)?.groupError, "wrong_group_kind");
  assert.equal(env.shield(), "unverified");
  m.dispose();
});

test("MlsUnsolicitedWelcome → acked, red toast", async () => {
  const env = new Env();
  env.handlers.e2ee_text_process = () => {
    throw { type: "mls_unsolicited_welcome", group_id: G0 };
  };
  const m = make(env);
  m.channelProtected(CH);
  await env.advance(0);
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.deepEqual(env.notified, ["unsolicited_welcome"]);
  assert.deepEqual(env.acks, ["W1"]);
  assert.equal(
    env.calls("e2ee_mls_group_kind").length,
    0,
    "Welcome: native intent check",
  );
  m.dispose();
});

function joiningEnv() {
  const env = new Env();
  env.states.set(
    CH,
    noGroup(CH, {
      self_seated: true,
      verdict: "no_group",
      seat_list: st().seat_list,
    }),
  );
  return env;
}

test("join: a processed Welcome cancels retries; _update right after (W4-3)", async () => {
  const env = joiningEnv();
  env.handlers.e2ee_text_process = (a) => {
    // W4-3: commit the Update at once; do not wait for a refresh to read
    // `update_due` (left false here so only the prompt path can commit).
    env.states.set(CH, st({ epoch: 4 }));
    return outcome({
      kind: "welcome_joined",
      epoch: 4,
      group_id: a.envelope.group_id,
    });
  };
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(env.api$("POST", /join_intent$/).length, 1);
  assert.deepEqual(env.calls("e2ee_text_join")[0], {
    groupId: G0,
    channelId: CH,
    generation: 0,
    userId: SELF,
  });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  await p;
  await env.advance(120_000);
  assert.equal(env.api$("POST", /join_intent$/).length, 1, "retries cancelled");
  assert.ok(env.calls("e2ee_text_update").length >= 1, "_update after Welcome");
  assert.equal(
    (env.api$("POST", /\/commits$/)[0]?.body as { commit: string }).commit,
    "UPD",
  );
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, false);
  m.dispose();
});

test("join: member_added at/after our intent stops the retries", async () => {
  const env = joiningEnv();
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({
    member_added: [{ user_id: SELF, device_id: DEV, epoch: 4, at: "" }],
  });
  await env.advance(200_000);
  assert.equal(env.api$("POST", /join_intent$/).length, 1);
  await assert.rejects(
    p,
    (e: { reason?: string }) => e.reason === "welcome_pending",
  );
  // W4d X#6 (was `false`): the bounded Welcome window ran out, so the join
  // is stalled LOUD (9.1 6d) instead of being restarted by the next refresh.
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, true);
  assert.equal(env.shield(), "unverified");
  m.dispose();
});

test("join: retries exhausted → welcomeRetriesExhausted → unverified (6d)", async () => {
  const env = joiningEnv();
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(200_000);
  await assert.rejects(
    p,
    (e: { reason?: string }) => e.reason === "join_stalled",
  );
  assert.equal(env.api$("POST", /join_intent$/).length, 1 + JOIN_RETRIES);
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, true);
  assert.equal(env.shield(), "unverified");
  m.dispose();
});

/** The join's PUT /mls/key_packages and POST join_intent calls, in order. */
function joinTraffic(env: Env) {
  return env.apiCalls.filter(
    (c) =>
      (c.method === "PUT" && c.path === "/mls/key_packages") ||
      (c.method === "POST" && /\/join_intent$/.test(c.path)),
  );
}

test("F1 join: PUT exactly key_packages BEFORE posting the intent alone, fresh _join per attempt", async () => {
  const env = joiningEnv();
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(0);
  const first = joinTraffic(env);
  assert.deepEqual(
    first.map((c) => c.method),
    ["PUT", "POST"],
    "the package is published before the intent",
  );
  assert.deepEqual(first[0].body, joinIntent(1).key_packages);
  assert.equal(first[1].path, `/mls/groups/${G0}/join_intent`);
  assert.deepEqual(first[1].body, joinIntent(1).intent, "the intent alone");
  await env.advance(200_000);
  await assert.rejects(p);
  assert.equal(env.calls("e2ee_text_join").length, 1 + JOIN_RETRIES);
  const expected = Array.from({ length: 1 + JOIN_RETRIES }, (_, i) => [
    ["PUT", joinIntent(i + 1).key_packages],
    ["POST", joinIntent(i + 1).intent],
  ]).flat();
  assert.deepEqual(
    joinTraffic(env).map((c) => [c.method, c.body]),
    expected,
    "each attempt PUTs its own fresh package, then posts its own intent",
  );
  m.dispose();
});

test("F1 join: a 429 PUT is waited out and re-PUT; 5xx/transport retry with a fresh _join; no intent before a 2xx PUT", async () => {
  const env = joiningEnv();
  const answers: (TextApiResponse | "transport")[] = [
    { status: 429, resetAfterMs: 1_500, body: { type: "RateLimited" } },
    ok({ type: "InternalError" }, 503),
    "transport",
  ];
  env.routes.push((method, path) =>
    method === "PUT" && path === "/mls/key_packages"
      ? answers.shift()
      : undefined,
  );
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(env.api$("PUT", /^\/mls\/key_packages$/).length, 1);
  await env.advance(1_499);
  assert.equal(
    env.api$("PUT", /^\/mls\/key_packages$/).length,
    1,
    "Retry-After honored",
  );
  // 429 → same body re-PUT → 503 → backoff, `_join` #2 → transport →
  // backoff, `_join` #3 → 2xx → intent #3 (all inside the 10 s window).
  await env.advance(5_001);
  const t = joinTraffic(env);
  assert.deepEqual(
    t.map((c) => [c.method, c.body]),
    [
      ["PUT", joinIntent(1).key_packages],
      ["PUT", joinIntent(1).key_packages],
      ["PUT", joinIntent(2).key_packages],
      ["PUT", joinIntent(3).key_packages],
      ["POST", joinIntent(3).intent],
    ],
  );
  assert.equal(env.calls("e2ee_text_join").length, 3);
  m.dispose();
  await p.catch(() => undefined);
});

test("F1 join: a non-429 4xx PUT fails the attempt and never posts the intent", async () => {
  const env = joiningEnv();
  env.routes.push((method, path) =>
    method === "PUT" && path === "/mls/key_packages"
      ? ok({ type: "FailedValidation", error: "x" }, 400)
      : undefined,
  );
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(60_000);
  await assert.rejects(
    p,
    (e: { source?: string; status?: number }) =>
      e.source === "server" && e.status === 400,
  );
  assert.equal(env.api$("PUT", /^\/mls\/key_packages$/).length, 1);
  assert.equal(env.api$("POST", /join_intent$/).length, 0);
  assert.equal(env.calls("e2ee_text_join").length, 1);
  m.dispose();
});

test("F1 join: PUT 5xx and 429 retries are bounded; no intent is ever posted", async () => {
  for (const answer of [
    ok({ type: "InternalError" }, 503),
    { status: 429, resetAfterMs: 1_500, body: { type: "RateLimited" } },
  ]) {
    const env = joiningEnv();
    env.routes.push((method, path) =>
      method === "PUT" && path === "/mls/key_packages" ? answer : undefined,
    );
    const m = make(env);
    const p = silence(m.ensureJoined(CH));
    await env.advance(600_000);
    await assert.rejects(
      p,
      (e: { source?: string; status?: number }) =>
        e.source === "server" && e.status === answer.status,
    );
    const perAttempt =
      answer.status === 429 ? 1 + KEY_PACKAGE_PUT_429_BUDGET : 1;
    assert.equal(env.calls("e2ee_text_join").length, 1 + JOIN_RETRIES);
    assert.equal(
      env.api$("PUT", /^\/mls\/key_packages$/).length,
      perAttempt * (1 + JOIN_RETRIES),
    );
    assert.equal(env.api$("POST", /join_intent$/).length, 0);
    assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, false);
    m.dispose();
  }
});

/** A remove of PEER's device carrying `rejoinIntent`, scripted by `routes`. */
async function removeWith(
  env: Env,
  m: ProtectedTextManager,
  rejoinIntent: MlsJoinRequest | null,
) {
  await m.refresh(CH, "open");
  const p = silence(
    m.removeDevices(CH, [{ user_id: PEER, device_id: PEER_DEV }], {
      rejoinIntent,
    }),
  );
  await env.advance(120_000);
  await p;
}

/** Index in `env.trace` of the first entry matching `re`. */
function at(env: Env, re: RegExp): number {
  return env.trace.findIndex((t) => re.test(t));
}

test("F1 commit_won: a plain 2xx win reads the stored row and passes the SERVER's rejoin_intents and commit", async () => {
  // Rule 6 from a fanned-out rejoin request (the #admit path); the DS
  // recorded a DIFFERENT (newer) intent of that device than ours.
  const env = new Env();
  const ours = joinRequest("OURS");
  const ds = joinRequest("DS-STORED");
  env.dsRejoin = [ds];
  const m = make(env);
  await m.refresh(CH, "open");
  m.onJoinRequest(ours, true);
  await env.advance(10_000);
  assert.deepEqual(env.calls("e2ee_text_remove")[0]?.rejoinIntent, ours);
  assert.deepEqual(env.calls("e2ee_text_commit_won"), [
    { groupId: G0, wonEpoch: 4, storedCommitB64: "REM", rejoinIntents: [ds] },
  ]);
  const read = at(env, /^GET \/mls\/groups\/[0-9a-f]+\/commits\?from_epoch=4$/);
  assert.ok(read > at(env, /^POST .*\/commits$/), "read after the 2xx");
  assert.ok(read < at(env, /^e2ee_text_commit_won$/), "read before won");
  m.dispose();

  // The DS stored NO intents for this Remove (another rule applied): `[]`,
  // never the intent this device gave `_remove`; and the stored string,
  // not our bytes, is what native compares (RC NEW-5).
  const env2 = new Env();
  env2.storedCommit = "DS-BYTES";
  const m2 = make(env2);
  await removeWith(env2, m2, ours);
  assert.deepEqual(env2.calls("e2ee_text_commit_won"), [
    {
      groupId: G0,
      wonEpoch: 4,
      storedCommitB64: "DS-BYTES",
      rejoinIntents: [],
    },
  ]);
  m2.dispose();

  // Unknown outcome, absent row, identical resubmit answered 2xx: the row
  // is read again before won.
  const env3 = new Env();
  env3.dsRejoin = [ds];
  let posts = 0;
  env3.routes.push((method, path) =>
    method === "POST" && path.endsWith("/commits") && ++posts === 1
      ? "transport"
      : undefined,
  );
  const m3 = make(env3);
  await removeWith(env3, m3, ours);
  assert.equal(posts, 2, "resubmitted");
  assert.deepEqual(env3.calls("e2ee_text_commit_won")[0]?.rejoinIntents, [ds]);
  m3.dispose();
});

test("F1 commit_won: the stored-row read retries transport/429/5xx/missing and never calls won early; parks after its budget", async () => {
  const env = new Env();
  env.dsRejoin = [joinRequest("DS-STORED")];
  const answers: (TextApiResponse | "transport")[] = [
    "transport",
    { status: 429, resetAfterMs: 2_000, body: { type: "RateLimited" } },
    ok({ type: "InternalError" }, 503),
    ok({ commits: [], current_epoch: 4 }), // a missing row after a 2xx
  ];
  env.routes.push((method, path) =>
    method === "GET" && path.includes("from_epoch=4")
      ? answers.shift()
      : undefined,
  );
  const m = make(env);
  await m.refresh(CH, "open");
  const p = silence(
    m.removeDevices(CH, [{ user_id: PEER, device_id: PEER_DEV }], {
      rejoinIntent: null,
    }),
  );
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_commit_won").length, 0, "not early");
  await env.advance(120_000);
  await p;
  const reads = env.api$("GET", /from_epoch=4$/).length;
  assert.equal(reads, 5, "four failed reads, then the row");
  assert.equal(env.api$("POST", /\/commits$/).length, 1, "never resubmitted");
  assert.equal(env.calls("e2ee_text_commit_lost").length, 0);
  assert.deepEqual(
    env.calls("e2ee_text_commit_won")[0]?.rejoinIntents,
    env.dsRejoin,
  );
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] won row missing" &&
        JSON.stringify(l.ids) === JSON.stringify({ groupId: G0, epoch: 4 }),
    ),
    "missing row logged with ids only",
  );
  m.dispose();

  // Never readable: parked (stage kept, no won/lost/resubmit), resumed by
  // the next refresh as a plain win that reads the row again.
  const env2 = new Env();
  let readable = false;
  env2.routes.push((method, path) =>
    method === "GET" && path.includes("from_epoch=4") && !readable
      ? ok({ type: "InternalError" }, 503)
      : undefined,
  );
  const m2 = make(env2);
  await m2.refresh(CH, "open");
  const p2 = silence(
    m2.removeDevices(CH, [{ user_id: PEER, device_id: PEER_DEV }], {
      rejoinIntent: null,
    }),
  );
  await env2.advance(600_000);
  await assert.rejects(
    p2,
    (e: { reason?: string }) => e.reason === "commit_parked",
  );
  assert.equal(env2.api$("GET", /from_epoch=4$/).length, WON_ROW_READ_BUDGET);
  assert.equal(env2.calls("e2ee_text_commit_won").length, 0);
  assert.equal(env2.calls("e2ee_text_commit_lost").length, 0);
  assert.equal(env2.calls("e2ee_text_mark_left").length, 0);
  assert.equal(env2.api$("POST", /\/commits$/).length, 1);
  readable = true;
  await m2.refresh(CH, "interval");
  await env2.advance(1_000);
  assert.equal(env2.calls("e2ee_text_commit_won").length, 1, "resumed");
  assert.equal(env2.api$("POST", /\/commits$/).length, 1, "still no resubmit");
  m2.dispose();
});

test("F1 R2: a successor created locally but never accepted is re-created, not joined", async () => {
  const signer = {
    ...st().seat_list!,
    signer_user_id: SELF,
    signer_device_id: DEV,
  };
  // Native holds G1 exactly as `_group_create(supersedes: G0)` left it; the
  // server still names the old G0 as open.
  const untouched = (group_id: string, generation: number) =>
    st({
      group_id,
      generation,
      epoch: 0,
      members: [mem(SELF, DEV)],
      seat_list: signer,
    });
  const env = new Env();
  env.states.set(CH, untouched(G1, 1));
  const m = make(env);
  await m.refresh(CH, "open");
  await env.advance(1_000);
  assert.deepEqual(env.calls("e2ee_text_group_create"), [
    { channelId: CH, userId: SELF, supersedes: G0 },
  ]);
  const post = env.api$("POST", /^\/mls\/groups$/);
  assert.equal(post.length, 1);
  assert.equal((post[0].body as { group_id: string }).group_id, G1);
  assert.equal(
    env.calls("e2ee_text_join").length,
    0,
    "no ChannelMismatch join",
  );
  // The server still shows G0: once per session, never a loop.
  await m.refresh(CH, "interval");
  await env.advance(1_000);
  assert.equal(env.calls("e2ee_text_group_create").length, 1);
  // ensureJoined (open/send) takes the same re-create, never `_join`.
  await assert.doesNotReject(m.ensureJoined(CH));
  assert.equal(env.calls("e2ee_text_join").length, 0);
  m.dispose();

  // Genesis: native holds an untouched G0, the server definitively has none.
  const env2 = new Env();
  env2.group = null;
  env2.states.set(CH, untouched(G0, 0));
  const m2 = make(env2);
  await m2.refresh(CH, "open");
  await env2.advance(1_000);
  assert.deepEqual(env2.calls("e2ee_text_group_create"), [
    { channelId: CH, userId: SELF, supersedes: null },
  ]);
  m2.dispose();

  // Not applicable: the server accepted it; a staged commit; not the
  // signer; a server answer that is unknown (never read as absent).
  for (const setup of [
    (e: Env) => {
      e.group = groupBody({ group_id: G1, generation: 1, current_epoch: 0 });
    },
    (e: Env) => {
      e.pending = { epoch: 1, commit_b64: "STAGED" };
    },
    (e: Env) => {
      e.states.set(CH, { ...untouched(G1, 1), seat_list: st().seat_list });
    },
    (e: Env) => {
      e.routes.push((method, path) =>
        method === "GET" && path.endsWith("/text_group")
          ? "transport"
          : undefined,
      );
    },
  ]) {
    const e = new Env();
    e.states.set(CH, untouched(G1, 1));
    setup(e);
    const mm = make(e);
    await mm.refresh(CH, "open");
    await e.advance(1_000);
    assert.equal(e.api$("POST", /^\/mls\/groups$/).length, 0);
    mm.dispose();
  }
});

test("F1 commit_won: Lost{self} and refetched rows pass the DS's rejoin_intents verbatim", async () => {
  const ours = joinRequest("OURS");
  const ds = joinRequest("DS-STORED");
  const env = new Env();
  env.routes.push((method, path) => {
    if (method === "POST" && path.endsWith("/commits")) {
      return ok({ result: "Lost", winning: ownRow(4, "REM") }, 409);
    }
    if (method === "GET" && path.includes("from_epoch=4")) {
      return ok({
        commits: [{ ...ownRow(4, "REM"), rejoin_intents: [ds] }],
        current_epoch: 4,
      });
    }
    return undefined;
  });
  const m = make(env);
  await removeWith(env, m, ours);
  assert.deepEqual(env.calls("e2ee_text_commit_won"), [
    { groupId: G0, wonEpoch: 4, storedCommitB64: "REM", rejoinIntents: [ds] },
  ]);
  m.dispose();

  // A refetched own row without `rejoin_intents` (absent = empty): `[]`,
  // never this device's own guess.
  const env2 = new Env();
  env2.routes.push((method, path) => {
    if (method === "POST" && path.endsWith("/commits")) return "transport";
    if (method === "GET" && path.includes("from_epoch=4")) {
      return ok({ commits: [ownRow(4, "REM")], current_epoch: 4 });
    }
    return undefined;
  });
  const m2 = make(env2);
  await removeWith(env2, m2, ours);
  assert.deepEqual(env2.calls("e2ee_text_commit_won")[0]?.rejoinIntents, []);
  m2.dispose();
});

test("flag stripped → unverified; sends refused before any encrypt", async () => {
  const env = new Env();
  const m = make(env);
  await m.refresh(CH, "open");
  m.flagStripped(CH);
  await env.advance(0);
  assert.equal(env.shield(CH, { serverProtected: false }), "unverified");
  await assert.rejects(
    m.send(CH, "x", [], false, "k"),
    (e: { reason?: string }) => e.reason === "flag_stripped",
  );
  assert.deepEqual(env.sends, []);
  m.dispose();
});

test("ChannelDelete (close) keeps state; only the refresh timer goes", async () => {
  const env = new Env();
  const m = make(env);
  await m.open(CH);
  await env.advance(60_000);
  const seatsGets = env.api$("GET", /\/seats$/).length;
  assert.ok(seatsGets >= 2, "60 s refresh while open");
  m.close(CH);
  await env.advance(300_000);
  assert.equal(env.api$("GET", /\/seats$/).length, seatsGets);
  assert.equal(env.calls("e2ee_text_mark_left").length, 0);
  assert.ok(m.stateOf(CH)?.native !== null);
  assert.equal(env.views.get(CH)?.native?.group_id, G0);
  m.dispose();
});

/** A confirm-page row bound to a stored orphan `{nonce: CID1, encrypted: {}}`. */
function orphanRow(over: Record<string, unknown> = {}) {
  return {
    _id: "MX",
    channel: CH,
    author: SELF,
    nonce: CID1,
    encrypted: {},
    ...over,
  };
}

test("control RC NEW-6: orphan protected-send entries are resolved at start", async () => {
  const env = new Env();
  const key = (k: string) => `protected-send:${SELF}:${CH}:${k}`;
  env.storeMap.set(key("k1"), JSON.stringify({ nonce: CID1, encrypted: {} }));
  env.storeMap.set(key("k2"), JSON.stringify({ nonce: CID2, encrypted: {} }));
  env.storeMap.set(key("k3"), JSON.stringify({ nonce: CID2, encrypted: {} }));
  env.storeMap.set(`protected-send:UOTHER:${CH}:k4`, "{}");
  env.liveKeys.add("k3");
  env.routes.push((method, path) => {
    if (method === "GET" && path.startsWith(`/channels/${CH}/messages?`)) {
      return ok([orphanRow()]);
    }
    return undefined;
  });
  const m = make(env);
  await m.start();
  await env.advance(10_000);
  assert.equal(env.storeMap.has(key("k1")), false, "found → deleted");
  assert.equal(env.storeMap.has(key("k2")), false, "absent → deleted");
  assert.equal(env.storeMap.has(key("k3")), true, "live outbox owns it");
  assert.equal(env.storeMap.has(`protected-send:UOTHER:${CH}:k4`), true);
  assert.equal(env.views.get(CH)?.maybeUnsent, true);
  const q = env.api$("GET", /\/messages\?/);
  assert.ok(
    q.every((c) => /sort=Latest/.test(c.path) && /limit=100/.test(c.path)),
  );
  assert.equal(env.sends.length, 0, "never re-sent");
  m.dispose();
});

test("orphans: a port without storeKeys logs an error (never silent)", async () => {
  const env = new Env();
  const port = Object.assign(Object.create(Object.getPrototypeOf(env)), env);
  Object.defineProperty(port, "storeKeys", { value: undefined });
  const m = make(port as Env);
  await m.start();
  await env.advance(0);
  assert.ok(
    (port as Env).logs.some(
      (l) => l.level === "error" && /orphan scan unavailable/.test(l.msg),
    ),
  );
  m.dispose();
});

test("control RC NEW-7: a never-seated unopened channel shows not_seated, not resecuring", async () => {
  const env = new Env();
  env.states.set(CH, noGroup(CH));
  env.handlers.e2ee_text_seat_list_verify = (a) => {
    env.states.set(
      a.channelId,
      noGroup(a.channelId, {
        seat_list: st().seat_list,
        verdict: "not_seated",
      }),
    );
    return {
      status: "accepted",
      version: 1,
      seats: [OWNER, PEER],
      device_cap: 5,
      signer_user_id: OWNER,
      signer_device_id: OWNER_DEV,
      pinned_now: true,
    };
  };
  const m = make(env);
  m.channelProtected(CH);
  await m.start();
  await env.advance(1_000);
  const v = env.calls("e2ee_text_seat_list_verify")[0];
  assert.equal(v.asOfEpoch, null, "no group held: no as_of_*");
  assert.equal(v.asOfGroupId, null);
  assert.equal(env.shield(), "not_seated");
  assert.equal(env.calls("e2ee_text_join").length, 0, "no auto-join at start");
  m.dispose();
});

test("D26: first-sight verifies are staggered 500 ms, at most 20 per minute", async () => {
  const env = new Env();
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const ids = Array.from(
    { length: FIRST_SIGHT_PER_MINUTE + 5 },
    (_, i) =>
      `01J9Z3K4M5N6P7Q8R9S0T1V2${chars[1 + Math.floor(i / 32)]}${chars[i % 32]}`,
  );
  for (const id of ids) env.states.set(id, noGroup(id));
  env.states.delete(CH);
  const m = make(env);
  for (const id of ids) m.channelProtected(id);
  await env.advance(0);
  await m.start();
  await env.advance(0);
  assert.equal(env.api$("GET", /\/seats$/).length, 1);
  await env.advance(10_000);
  assert.equal(env.api$("GET", /\/seats$/).length, FIRST_SIGHT_PER_MINUTE);
  await env.advance(55_000);
  assert.equal(env.api$("GET", /\/seats$/).length, ids.length);
  m.dispose();
});

test("D21: poisoned + this device signed the list → successor; crash → genesis", async () => {
  const env = new Env();
  const signer = {
    ...st().seat_list!,
    signer_user_id: SELF,
    signer_device_id: DEV,
  };
  env.states.set(
    CH,
    st({ state: "poisoned", verdict: "poisoned", seat_list: signer }),
  );
  const m = make(env);
  await m.refresh(CH, "open");
  await env.advance(0);
  assert.deepEqual(env.calls("e2ee_text_group_create")[0], {
    channelId: CH,
    userId: SELF,
    supersedes: G0,
  });
  m.dispose();

  const env2 = new Env();
  env2.group = null;
  env2.states.set(
    CH,
    noGroup(CH, { seat_list: signer, self_seated: true, verdict: "no_group" }),
  );
  const m2 = make(env2);
  await m2.refresh(CH, "open");
  await env2.advance(0);
  assert.deepEqual(env2.calls("e2ee_text_group_create")[0]?.supersedes, null);
  m2.dispose();

  // A 409 Conflict naming the derived id counts as created.
  const env3 = new Env();
  env3.routes.push((method, path) =>
    method === "POST" && path === "/mls/groups"
      ? ok({ result: "Conflict", open_group_id: G0, channel_id: CH }, 409)
      : undefined,
  );
  const m3 = make(env3);
  const created = await m3.createGroup(CH, null);
  assert.equal(created.group_id, G0);
  m3.dispose();
});

test("timeline markers: new devices and a server-forced removal", async () => {
  const env = new Env();
  env.group = groupBody({
    pending_removals: [{ user_id: PEER, created_at: "" }],
  });
  // self at leaf 2: the rule-4a stagger (4 s) is not reached in this test.
  env.states.set(
    CH,
    st({
      members: [mem(OWNER, OWNER_DEV), mem(PEER, PEER_DEV), mem(SELF, DEV)],
    }),
  );
  env.handlers.e2ee_text_process = () =>
    outcome({
      new_devices: [{ user_id: OWNER, device_id: "dev-owner-2" }],
      removed: [{ user_id: PEER, device_id: PEER_DEV }],
    });
  const m = make(env);
  await m.refresh(CH, "open");
  m.onEnvelope(envelope("E1", 4));
  await env.advance(0);
  assert.deepEqual(
    env.markers.map((k) => [k.kind, k.userId]),
    [
      ["new_device", OWNER],
      ["forced_removal", PEER],
    ],
  );
  m.dispose();
});

test("dispose: later envelopes and requests do nothing", async () => {
  const env = new Env();
  const m = make(env);
  m.dispose();
  m.onEnvelope(envelope("E1", 4));
  await env.advance(1_000);
  assert.equal(env.calls("e2ee_text_process").length, 0);
  await assert.rejects(m.refresh(CH, "open"));
});

function gate() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

function row(id: string) {
  return {
    id,
    channelId: CH,
    authorId: PEER,
    nonce: CID2,
    encrypted: null,
  };
}

test("M1: ensureJoined AWAITS an in-flight Update before resolving", async () => {
  const env = new Env();
  env.state().update_required = true;
  const g = gate();
  let updates = 0;
  env.handlers.e2ee_text_update = () => {
    updates++;
    env.pending = { epoch: 4, commit_b64: "UPD" };
    return commitPayload(4, "UPD");
  };
  // Hold the Update in its SUBMIT (outside the channel lane), where a
  // second caller's state read is not serialized behind it.
  const api = env.api.bind(env);
  env.api = async (method: string, path: string, body?: unknown) => {
    if (method === "POST" && path.endsWith("/commits")) await g.promise;
    return api(method, path, body);
  };
  const m = make(env);
  await m.refresh(CH, "open"); // starts the background Update (held)
  await env.advance(0);
  assert.equal(updates, 1);
  let joined = false;
  const p = m.ensureJoined(CH).then(() => {
    joined = true;
  });
  await env.advance(0);
  assert.equal(joined, false, "waits for the in-flight Update");
  g.release();
  await env.advance(0);
  await p;
  assert.equal(joined, true);
  assert.equal(updates, 1, "the in-flight Update served both callers");
  assert.equal(env.state().update_required, false);
  m.dispose();
});

test("L2: a history decrypt in flight never swallows the live one", async () => {
  const env = new Env();
  const lives: boolean[] = [];
  const g = gate();
  const deps = fakeDeps(env, {
    messages: {
      decryptRow: async (_ops, _port, r, live) => {
        lives.push(live);
        if (!live) await g.promise;
        return {
          status: "ok",
          text: live ? "live" : "history",
          replies: [],
          senderVerified: true,
          tsSkew: false,
          cid: r.nonce ?? "",
        };
      },
    },
  });
  const m = make(env, deps);
  m.onMessage(row("M1"), false);
  await env.advance(0);
  m.onMessage(row("M1"), true);
  await env.advance(0);
  assert.deepEqual(lives, [false, true], "the live decrypt ran");
  g.release();
  await env.advance(0);
  const v = env.msgViews.get("M1");
  assert.ok(v?.status === "ok" && v.text === "live", "late history ignored");
  m.onMessage(row("M1"), true);
  m.onMessage(row("M1"), false);
  await env.advance(0);
  assert.equal(lives.length, 2, "both answered from the live cache");
  m.dispose();
});

test("forget(ids): deleted messages drop views and dedupe state", async () => {
  const env = new Env();
  const g = gate();
  const deps = fakeDeps(env, {
    messages: {
      decryptRow: async (_ops, _port, r) => {
        env.decrypts.push(r.id);
        if (r.id === "M2") await g.promise;
        return {
          status: "ok",
          text: "t",
          replies: [],
          senderVerified: true,
          tsSkew: false,
          cid: r.nonce ?? "",
        };
      },
    },
  });
  const m = make(env, deps);
  m.onMessage(row("M1"), true);
  m.onMessage(row("M2"), true);
  await env.advance(0);
  assert.equal(env.msgViews.get("M1")?.status, "ok");
  assert.equal(env.msgViews.get("M2")?.status, "pending");
  m.forget(["M1", "M2"]);
  g.release();
  await env.advance(0);
  assert.equal(
    env.msgViews.get("M2")?.status,
    "pending",
    "an in-flight decrypt of a deleted row is discarded",
  );
  const seen = new Map(env.msgViews);
  m.onMessage(row("M1"), true);
  await env.advance(0);
  assert.deepEqual(env.decrypts, ["M1", "M2"], "no re-decrypt");
  assert.deepEqual(env.msgViews, seen, "no view re-emitted");
  m.dispose();
});

test("rescanOrphans: skipped while the outbox throws, then resolves the orphan exactly once", async () => {
  const env = new Env();
  const k = `protected-send:${SELF}:${CH}:k1`;
  env.storeMap.set(k, JSON.stringify({ nonce: CID1, encrypted: {} }));
  env.outboxThrows = true;
  env.routes.push((method, path) =>
    method === "GET" && path.startsWith(`/channels/${CH}/messages?`)
      ? ok([orphanRow()])
      : undefined,
  );
  const m = make(env);
  await m.start();
  await env.advance(1_000);
  const confirms = () => env.api$("GET", /\/messages\?/).length;
  assert.equal(confirms(), 0, "skipped while the outbox is not loaded");
  assert.equal(env.storeMap.has(k), true);
  env.outboxThrows = false;
  const a = m.rescanOrphans();
  const b = m.rescanOrphans();
  await env.advance(1_000);
  await Promise.all([a, b]);
  assert.equal(confirms(), 1, "serialized: confirmed once");
  assert.equal(env.storeMap.has(k), false);
  m.dispose();
  await m.rescanOrphans();
  assert.equal(confirms(), 1, "no-op after dispose");
});

// ---------------------------------------------------------------------------
// W4d fix round (lane L-MGR). Named controls C-X1 ... C-F3 and C-MGRcap each
// turn the test carrying their name red (literal patches on temp copies;
// the c3381567 base fails them too; see the lane report).
// ---------------------------------------------------------------------------

function processScript(
  env: Env,
  script: Record<string, () => TextProcessOutcome>,
) {
  env.handlers.e2ee_text_process = (a) => {
    const f = script[a.envelope.id];
    if (!f) throw { type: "storage" };
    return f();
  };
}

const fail = (type: string) => () => {
  throw { type, group_id: G0 };
};

/** A seated user's join intent from a device not yet in the group. */
function newDeviceRequest(signature: string): MlsJoinRequest {
  return { ...joinRequest(signature), device_id: "dev-peer-new" };
}

test("W4d X#1 (C-X1): a loud poisoned-path groupError is sticky per group until a higher-generation welcome_joined", async () => {
  assert.ok(STICKY_GROUP_ERRORS.includes("commit_declaration_mismatch"));
  assert.equal(STICKY_GROUP_ERRORS.includes("owner_changed"), false);
  for (const tag of STICKY_GROUP_ERRORS) {
    const env = new Env();
    processScript(env, {
      E1: fail(tag),
      E2: fail("mls_poisoned_epoch"),
      E3: () => outcome({ epoch: 4 }),
      E4: () => outcome({ kind: "duplicate", epoch: 4 }),
      W0: () => outcome({ kind: "welcome_joined", epoch: 4 }),
      W1: () => outcome({ kind: "welcome_joined", group_id: G1, epoch: 0 }),
    });
    const m = make(env);
    await m.refresh(CH, "open");
    const step = async (id: string, over: Partial<TextEnvelope> = {}) => {
      m.onEnvelope(envelope(id, 4, over));
      await env.advance(0);
      return env.views.get(CH)?.groupError ?? null;
    };
    assert.equal(await step("E1"), tag, tag);
    assert.equal(env.shield(), "unverified", tag);
    // Benign tag, applied commit, duplicate, same-generation welcome: kept.
    assert.equal(await step("E2"), tag, `${tag}: mls_poisoned_epoch`);
    assert.equal(await step("E3"), tag, `${tag}: commit_applied`);
    assert.equal(await step("E4"), tag, `${tag}: duplicate`);
    const w0 = { content_type: "mls_welcome" as const };
    assert.equal(await step("W0", w0), tag, `${tag}: same generation`);
    assert.equal(env.shield(), "unverified", `${tag}: still loud`);
    // Successor joined (generation 1 > 0): cleared.
    const w1 = { content_type: "mls_welcome" as const, group_id: G1 };
    assert.equal(await step("W1", w1), null, `${tag}: successor`);
    m.dispose();
  }

  // A benign tag alone is still recorded and cleared as before.
  const env2 = new Env();
  processScript(env2, {
    E1: fail("mls_poisoned_epoch"),
    E2: () => outcome({ epoch: 4 }),
  });
  const m2 = make(env2);
  await m2.refresh(CH, "open");
  m2.onEnvelope(envelope("E1", 4));
  await env2.advance(0);
  assert.equal(env2.views.get(CH)?.groupError, "mls_poisoned_epoch");
  m2.onEnvelope(envelope("E2", 4));
  await env2.advance(0);
  assert.equal(env2.views.get(CH)?.groupError, null);
  m2.dispose();

  // This device's own successor create (D21) accepted: cleared too.
  const env3 = new Env();
  processScript(env3, { E1: fail("duplicate_leaf") });
  const m3 = make(env3);
  await m3.refresh(CH, "open");
  m3.onEnvelope(envelope("E1", 4));
  await env3.advance(0);
  assert.equal(env3.views.get(CH)?.groupError, "duplicate_leaf");
  await m3.createGroup(CH, G0);
  await env3.advance(0);
  assert.equal(env3.views.get(CH)?.groupError, null);
  m3.dispose();
});

test("W4d X#2 (C-X2a): a persisted own commit stage is resumed at seed (restart / rebuild), row fetched first", async () => {
  const env = new Env();
  env.pending = { epoch: 4, commit_b64: "PERSISTED" };
  env.rows.push({ ...ownRow(4, "PERSISTED"), rejoin_intents: [] });
  const m = make(env);
  m.channelProtected(CH);
  await env.advance(0);
  await m.start();
  await env.advance(1_000);
  assert.deepEqual(env.calls("e2ee_text_commit_won"), [
    {
      groupId: G0,
      wonEpoch: 4,
      storedCommitB64: "PERSISTED",
      rejoinIntents: [],
    },
  ]);
  assert.equal(env.api$("POST", /\/commits$/).length, 0, "row existed");
  const fetched = at(env, /^GET \/mls\/groups\/[0-9a-f]+\/commits\?/);
  const seats = at(env, /^GET \/channels\/[^/]+\/seats$/);
  assert.ok(fetched >= 0, "fetched {group}:{epoch} first");
  assert.ok(seats < 0 || fetched < seats, "from the seed, not a refresh");
  assert.equal(env.calls("e2ee_text_commit_lost").length, 0);
  m.dispose();

  // Another committer's row at that epoch: lost, the winner processed.
  const env2 = new Env();
  env2.pending = { epoch: 4, commit_b64: "PERSISTED" };
  env2.rows.push({
    ...ownRow(4, "THEIRS"),
    committer: { user_id: OWNER, device_id: OWNER_DEV },
  });
  const m2 = make(env2);
  m2.channelProtected(CH);
  await env2.advance(0);
  await m2.start();
  await env2.advance(1_000);
  assert.equal(env2.calls("e2ee_text_commit_won").length, 0);
  assert.equal(env2.calls("e2ee_text_commit_lost").length, 1);
  assert.equal(env2.calls("e2ee_text_process")[0]?.envelope.epoch, 4);
  m2.dispose();
});

/** The N1 store key of this device's persisted stage body for `group`. */
const stageKey = (group = G0) => `protected-stage:${SELF}:${group}`;

/** A running manager stages an Add whose outcome stays unknown (parked). */
async function parkedAdd(env: Env, allowed: { now: boolean }) {
  env.routes.push((method, path) => {
    if (method === "POST" && path.endsWith("/commits")) {
      return allowed.now ? undefined : "transport";
    }
    if (method === "GET" && path.includes("from_epoch=4") && !allowed.now) {
      return ok({ type: "MissingPermission" }, 403);
    }
    return undefined;
  });
  const m = make(env);
  await m.refresh(CH, "open");
  m.onJoinRequest(newDeviceRequest("S"), false);
  await env.advance(600_000);
  assert.equal(env.api$("POST", /\/commits$/).length, 1, "parked");
  return m;
}

test("W4d X#2 (C-X2b): an absent row resubmits the IDENTICAL persisted FULL body, never a re-stage; one resume per group", async () => {
  // The parked Add of a running manager: resumed with its full body.
  const env2 = new Env();
  const allowed = { now: false };
  const m2 = await parkedAdd(env2, allowed);
  const first = env2.api$("POST", /\/commits$/)[0].body;
  assert.deepEqual(
    JSON.parse(env2.storeMap.get(stageKey()) ?? "null"),
    first,
    "N1: the full body is persisted before the POST",
  );
  allowed.now = true;
  await m2.refresh(CH, "interval");
  await env2.advance(1_000);
  const bodies = env2.api$("POST", /\/commits$/).map((c) => c.body);
  assert.equal(bodies.length, 2, "absent → resubmitted");
  assert.deepEqual(bodies[1], first, "identical, welcome included");
  assert.equal((bodies[1] as { welcome: string }).welcome, "WEL");
  assert.deepEqual((bodies[1] as { added: unknown }).added, [
    { user_id: PEER, device_id: "dev-new" },
  ]);
  assert.equal(env2.calls("e2ee_text_commit_won").length, 1);
  assert.equal(env2.storeMap.has(stageKey()), false, "resolved → dropped");
  m2.dispose();

  // Restart mid-Add (a NEW manager, the store kept): the persisted full
  // body is resubmitted, never re-staged and never bare.
  const env4 = new Env();
  const allowed4 = { now: false };
  const old = await parkedAdd(env4, allowed4);
  const sent = env4.api$("POST", /\/commits$/)[0].body;
  old.dispose();
  allowed4.now = true;
  const m4 = make(env4);
  m4.channelProtected(CH);
  await env4.advance(0);
  await m4.start();
  await env4.advance(1_000);
  const after = env4.api$("POST", /\/commits$/).map((c) => c.body);
  assert.equal(after.length, 2, "one resubmit after the restart");
  assert.deepEqual(after[1], sent, "the persisted FULL body");
  assert.equal(env4.calls("e2ee_text_admit").length, 1, "never re-staged");
  assert.equal(env4.calls("e2ee_text_commit_won").length, 1);
  m4.dispose();

  // A resume in flight (its row fetch held) blocks a second one: two loops
  // for one stage would double-submit and double-merge.
  const env3 = new Env();
  env3.pending = { epoch: 4, commit_b64: "PERSISTED" };
  env3.storeMap.set(
    stageKey(),
    JSON.stringify({ device_id: DEV, epoch: 4, commit: "PERSISTED" }),
  );
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let refetches = 0;
  const api = env3.api.bind(env3);
  env3.api = async (method: string, path: string, body?: unknown) => {
    if (method === "GET" && path.includes("from_epoch=4")) {
      refetches++;
      await held;
    }
    return api(method, path, body);
  };
  const m3 = make(env3);
  m3.channelProtected(CH);
  await env3.advance(0);
  await m3.start();
  await env3.advance(0);
  await m3.refresh(CH, "interval");
  await m3.refresh(CH, "open");
  await env3.advance(0);
  assert.equal(refetches, 1, "a second resume never starts");
  release();
  await env3.advance(1_000);
  assert.equal(env3.api$("POST", /\/commits$/).length, 1, "one resubmit");
  assert.equal(env3.calls("e2ee_text_update").length, 0, "never re-staged");
  assert.equal(
    env3.calls("e2ee_text_commit_won")[0]?.storedCommitB64,
    "PERSISTED",
  );
  m3.dispose();
});

test("W4d N1 (C-N1a): a stage without its persisted full body is NEVER resubmitted bare: own row → won, absent → _commit_lost", async () => {
  // Restart mid-Add, no full body (or one for another stage), row absent.
  for (const stored of [
    null,
    { device_id: DEV, epoch: 3, commit: "ADM" },
    { device_id: DEV, epoch: 4, commit: "OTHER-BYTES" },
  ]) {
    const env = new Env();
    env.pending = { epoch: 4, commit_b64: "ADM" };
    if (stored) env.storeMap.set(stageKey(), JSON.stringify(stored));
    const m = make(env);
    m.channelProtected(CH);
    await env.advance(0);
    await m.start();
    await env.advance(1_000);
    const label = JSON.stringify(stored);
    assert.equal(env.api$("POST", /\/commits$/).length, 0, `no POST ${label}`);
    assert.ok(env.api$("GET", /from_epoch=4$/).length >= 1, "fetched first");
    assert.equal(env.calls("e2ee_text_commit_lost").length, 1, label);
    assert.equal(env.calls("e2ee_text_commit_won").length, 0, label);
    assert.equal(env.calls("e2ee_text_mark_left").length, 0, label);
    assert.ok(env.api$("GET", /\/seats$/).length >= 1, "refresh re-derives");
    m.dispose();
  }

  // Restart mid-Add, no full body, own row present: won with the DS string.
  const env2 = new Env();
  env2.pending = { epoch: 4, commit_b64: "ADM" };
  env2.rows.push({
    ...ownRow(4, "ADM"),
    added: [{ user_id: PEER, device_id: "dev-new" }],
  });
  const m2 = make(env2);
  m2.channelProtected(CH);
  await env2.advance(0);
  await m2.start();
  await env2.advance(1_000);
  assert.deepEqual(env2.calls("e2ee_text_commit_won"), [
    { groupId: G0, wonEpoch: 4, storedCommitB64: "ADM", rejoinIntents: [] },
  ]);
  assert.equal(env2.api$("POST", /\/commits$/).length, 0);
  m2.dispose();
});

test("W4d N4 (C-N4): while a resume holds the group, no routine commit or staging flow re-stages over the pending stage", async () => {
  const env = new Env();
  env.pending = { epoch: 4, commit_b64: "PERSISTED" };
  env.rows.push({ ...ownRow(4, "PERSISTED"), rejoin_intents: [] });
  env.storeMap.set(
    stageKey(),
    JSON.stringify({ device_id: DEV, epoch: 4, commit: "PERSISTED" }),
  );
  // Routine work a refresh would start: an Update is due and the server
  // is ahead (a catch-up would merge another epoch under our stage).
  env.state().update_due = true;
  env.group = groupBody({ current_epoch: 5 });
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let fetches4 = 0;
  const api = env.api.bind(env);
  env.api = async (method: string, path: string, body?: unknown) => {
    if (method === "GET" && path.includes("from_epoch=4")) {
      fetches4++;
      await held;
    }
    return api(method, path, body);
  };
  const m = make(env);
  m.channelProtected(CH);
  await env.advance(0);
  await m.start();
  await env.advance(0);
  await m.refresh(CH, "interval");
  const removal = silence(
    m.removeDevices(CH, [{ user_id: PEER, device_id: PEER_DEV }], {
      rejoinIntent: null,
    }),
  );
  await env.advance(5_000);
  assert.equal(fetches4, 1, "only the resume's row fetch (no catch-up)");
  assert.equal(env.calls("e2ee_text_update").length, 0, "no Update staged");
  assert.equal(env.calls("e2ee_text_remove").length, 0, "Remove waits");
  release();
  await env.advance(5_000);
  await removal;
  assert.deepEqual(
    env.calls("e2ee_text_commit_won")[0],
    {
      groupId: G0,
      wonEpoch: 4,
      storedCommitB64: "PERSISTED",
      rejoinIntents: [],
    },
    "the resumed stage won",
  );
  const order = env.invokes.map((i) => i.cmd);
  assert.ok(
    order.indexOf("e2ee_text_remove") > order.indexOf("e2ee_text_commit_won"),
    "the Remove is staged only after the resume resolved",
  );
  assert.equal(env.calls("e2ee_text_update").length, 0, "no stale Update");
  m.dispose();
});

test("W4d X#3 (C-X3): no false loud seat_list_rollback from a stale snapshot; a real one stays loud", async () => {
  const accepted = {
    status: "accepted" as const,
    version: 1,
    seats: [OWNER, PEER, SELF],
    device_cap: 5,
    signer_user_id: OWNER,
    signer_device_id: OWNER_DEV,
    pinned_now: false,
  };
  const rollback = {
    type: "seat_list_rollback",
    channel_id: CH,
    held: 2,
    got: 1,
  };
  const seatsQueue = (env: Env, q: (number | "fail")[]) => {
    env.routes.push((method, path) => {
      if (method !== "GET" || !/^\/channels\/[^/]+\/seats$/.test(path)) {
        return undefined;
      }
      const next = q.length > 1 ? q.shift() : q[0];
      return next === "fail"
        ? ok({ type: "InternalError" }, 503)
        : ok(seatsBody({ as_of_epoch: next }));
    });
  };
  // Native adopted a newer list at epoch 5: an older snapshot "rolls back".
  const staleVerify = (env: Env) => {
    env.handlers.e2ee_text_seat_list_verify = (a) => {
      const held = env.state().epoch ?? 0;
      if (a.asOfEpoch !== null && a.asOfEpoch < held) throw rollback;
      return accepted;
    };
  };

  // (a) The GET failed this pass: the old snapshot is never re-verified.
  const env = new Env();
  staleVerify(env);
  const q: (number | "fail")[] = [3];
  seatsQueue(env, q);
  const m = make(env);
  await m.refresh(CH, "open");
  const verifies = env.calls("e2ee_text_seat_list_verify").length;
  assert.ok(verifies >= 1);
  env.state().epoch = 5;
  q.splice(0, q.length, "fail");
  await m.refresh(CH, "interval");
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_seat_list_verify").length, verifies);
  assert.equal(env.views.get(CH)?.seatListError, null);
  m.dispose();

  // (b) A stale snapshot (as_of 3 < held 5): re-GET, the fresh one passes.
  const env2 = new Env();
  env2.state().epoch = 5;
  env2.group = groupBody({ current_epoch: 5 });
  staleVerify(env2);
  seatsQueue(env2, [3, 5]);
  const m2 = make(env2);
  await m2.refresh(CH, "open");
  assert.equal(env2.views.get(CH)?.seatListError, null);
  assert.equal(env2.api$("GET", /\/seats$/).length, 2, "one re-GET");
  assert.equal(env2.shield(), "protected");
  m2.dispose();

  // (b') Always stale: bounded re-GETs, the tag is never recorded.
  const env3 = new Env();
  env3.state().epoch = 5;
  env3.group = groupBody({ current_epoch: 5 });
  staleVerify(env3);
  seatsQueue(env3, [3]);
  const m3 = make(env3);
  await m3.refresh(CH, "open");
  assert.equal(
    env3.api$("GET", /\/seats$/).length,
    1 + STALE_SEATS_REFETCH_BUDGET,
  );
  assert.equal(env3.views.get(CH)?.seatListError, null);
  assert.equal(env3.shield(), "protected");
  m3.dispose();

  // (c) A rollback at the held epoch is real: loud.
  const env4 = new Env();
  env4.handlers.e2ee_text_seat_list_verify = () => {
    throw rollback;
  };
  const m4 = make(env4);
  await m4.refresh(CH, "open");
  assert.equal(env4.views.get(CH)?.seatListError, "seat_list_rollback");
  assert.equal(env4.shield(), "unverified");
  m4.dispose();
});

test("W4d X#4 (C-X4): the own view is native's decrypt of a BOUND row; an id with a view keeps it; never the typed text", async () => {
  // An id that already has a view (the server pointed our send at another
  // message): that view is re-emitted, nothing is decrypted or replaced.
  const env = new Env();
  const m = make(env);
  m.onMessage(
    {
      id: "MSENT",
      channelId: CH,
      authorId: PEER,
      nonce: CID2,
      encrypted: SENT_PAYLOAD,
    },
    true,
  );
  await env.advance(0);
  assert.equal(env.decrypts.length, 1);
  await m.send(CH, "typed secret", [], false, "k1");
  await env.advance(0);
  assert.equal(env.decrypts.length, 1, "no decrypt over an existing view");
  const v = env.msgViews.get("MSENT");
  assert.ok(v?.status === "ok" && v.cid === CID2, "the earlier view kept");
  assert.ok(
    ![...env.msgViews.values()].some(
      (x) => x.status === "ok" && x.text === "typed secret",
    ),
    "the typed text never becomes a view",
  );
  m.dispose();

  // A delivered outcome whose row does not bind: no view at all (loud log).
  for (const over of [
    { channel: "01J9Z3K4M5N6P7Q8R9S0T1V2ZZ" },
    { author: PEER },
    { nonce: CID2 },
    { _id: "MOTHER" },
    { encrypted: null },
  ]) {
    const e = new Env();
    const mm = make(
      e,
      fakeDeps(e, {
        messages: {
          encryptAndSend: async () => ({
            messageId: "MSENT",
            cid: CID1,
            raw: sentRow(CH, over),
          }),
        },
      }),
    );
    await mm.send(CH, "typed secret", [], false, "k1");
    await e.advance(0);
    assert.equal(e.msgViews.has("MSENT"), false, JSON.stringify(over));
    assert.equal(e.decrypts.length, 0);
    assert.ok(
      e.logs.some(
        (l) =>
          l.level === "error" && l.msg === "[protected] own send row unbound",
      ),
    );
    mm.dispose();
  }

  // Orphan confirm (refetch path): an unbound row is not "delivered".
  const env2 = new Env();
  const key = `protected-send:${SELF}:${CH}:k1`;
  env2.storeMap.set(key, JSON.stringify({ nonce: CID1, encrypted: {} }));
  env2.routes.push((method, path) =>
    method === "GET" && path.startsWith(`/channels/${CH}/messages?`)
      ? ok([orphanRow({ encrypted: { forged: true } })])
      : undefined,
  );
  const m2 = make(env2);
  await m2.start();
  await env2.advance(10_000);
  assert.equal(env2.views.get(CH)?.maybeUnsent, true, "absent, never adopted");
  m2.dispose();
});

test("W4d X#5 (C-X5a): a commit refused not_member → _mark_left(not_member) → rejoin", async () => {
  const env = new Env();
  env.routes.push((method, path) =>
    method === "POST" && path.endsWith("/commits")
      ? ok({ type: "ProtectedChannelResecuring", reason: "not_member" }, 409)
      : undefined,
  );
  const m = make(env);
  await assert.rejects((await scriptedRemove(env, m)).p);
  assert.deepEqual(env.calls("e2ee_text_mark_left"), [
    { groupId: G0, reason: "not_member" },
  ]);
  assert.ok(env.calls("e2ee_text_join").length >= 1, "rejoin path");
  assert.equal(env.calls("e2ee_text_commit_lost").length, 0);
  m.dispose();
});

test("W4d X#5 (C-X5b): a send refused not_member → _mark_left(not_member) → rejoin", async () => {
  const env = new Env();
  const refusal = {
    source: "server",
    status: 409,
    type: "ProtectedChannelResecuring",
    body: { type: "ProtectedChannelResecuring", reason: "not_member" },
  };
  const m = make(
    env,
    fakeDeps(env, {
      messages: {
        encryptAndSend: async () => {
          throw refusal;
        },
      },
    }),
  );
  await m.refresh(CH, "open");
  await assert.rejects(m.send(CH, "x", [], false, "k"), (e) => e === refusal);
  await env.advance(1_000);
  assert.deepEqual(env.calls("e2ee_text_mark_left"), [
    { groupId: G0, reason: "not_member" },
  ]);
  assert.ok(env.calls("e2ee_text_join").length >= 1, "rejoin path");
  m.dispose();

  // Any other refusal reason never wipes.
  const env2 = new Env();
  const m2 = make(
    env2,
    fakeDeps(env2, {
      messages: {
        encryptAndSend: async () => {
          throw { ...refusal, body: { reason: "stale_epoch" } };
        },
      },
    }),
  );
  await m2.refresh(CH, "open");
  await assert.rejects(m2.send(CH, "x", [], false, "k"));
  await env2.advance(1_000);
  assert.equal(env2.calls("e2ee_text_mark_left").length, 0);
  m2.dispose();
});

test("W4d X#6 (C-X6): member_added suppresses EVERY _join; the bounded window ends loud, never a restarted join", async () => {
  const env = joiningEnv();
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_join").length, 1);
  env.group = groupBody({
    member_added: [{ user_id: SELF, device_id: DEV, epoch: 4, at: "" }],
  });
  await env.advance(200_000);
  await assert.rejects(p);
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, true);
  // Later triggers (a rejoin verdict, a refresh, a manual reopen) never
  // send another intent while member_added shows this device.
  const again = silence(m.ensureJoined(CH));
  await env.advance(200_000);
  await assert.rejects(again);
  await m.refresh(CH, "interval");
  await m.open(CH);
  await env.advance(200_000);
  assert.equal(env.calls("e2ee_text_join").length, 1, "no second _join");
  assert.equal(env.api$("POST", /join_intent$/).length, 1);
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, true);
  assert.equal(env.shield(), "unverified");
  m.dispose();
});

test("W4d X#9: a parked owner-change commit is not duplicated by later refreshes", async () => {
  const env = new Env();
  env.group = groupBody({ current_epoch: 4 });
  let blocked = true;
  env.handlers.e2ee_text_process = (a) => {
    if (blocked) {
      throw {
        type: "owner_changed",
        channel_id: CH,
        signer_user_id: OWNER,
        signer_device_id: "dev-owner-2",
        same_user: true,
        verified: true,
      };
    }
    env.state().epoch = a.envelope.epoch;
    return outcome({ epoch: a.envelope.epoch });
  };
  const row4 = {
    group_id: G0,
    epoch: 4,
    committer: { user_id: OWNER, device_id: OWNER_DEV },
    commit: "C4",
    added: [],
    removed: [],
  };
  env.routes.push((method, path) =>
    method === "GET" && path.includes("from_epoch=4")
      ? ok({ commits: [row4], current_epoch: 4 })
      : undefined,
  );
  const m = make(env);
  for (let i = 0; i < 3; i++) {
    await m.refresh(CH, "interval");
    await env.advance(1_000);
  }
  const epoch4 = () =>
    env.calls("e2ee_text_process").filter((a) => a.envelope.epoch === 4).length;
  assert.equal(epoch4(), 1, "parked once, never re-read");
  assert.equal(env.views.get(CH)?.ownerChangePending, true);
  blocked = false;
  await m.confirmOwnerChange(CH);
  await env.advance(1_000);
  assert.equal(epoch4(), 2, "reprocessed exactly once");
  m.dispose();
});

test("W4d F#3 (C-F3): strip → re-protect clears the latch: sends and admissions run again", async () => {
  const env = new Env();
  const m = make(env);
  m.channelProtected(CH);
  await m.start();
  await env.advance(0);
  m.flagStripped(CH);
  await env.advance(0);
  await assert.rejects(
    m.send(CH, "x", [], false, "k"),
    (e: { reason?: string }) => e.reason === "flag_stripped",
  );
  m.onJoinRequest(newDeviceRequest("S1"), false);
  await env.advance(10_000);
  assert.equal(env.api$("POST", /claim$/).length, 0, "stripped: no admit");
  // The bridge forwards the un-strip as a re-protect.
  m.channelProtected(CH);
  await env.advance(0);
  const out = await m.send(CH, "x", [], false, "k2");
  assert.equal(out.messageId, "MSENT");
  assert.deepEqual(env.sends, ["x"]);
  m.onJoinRequest(newDeviceRequest("S2"), false);
  await env.advance(10_000);
  assert.equal(env.api$("POST", /claim$/).length, 1, "admits again");
  assert.equal(env.shield(CH, { serverProtected: true }), "protected");
  assert.ok(
    env.logs.some((l) => l.msg === "[protected] flag restored"),
    "re-seeded",
  );
  m.dispose();
});

test("W4d cap (C-MGRcap): DeviceCapReached / MlsCallFull on a commit: _commit_lost, no retry, typed (not 'unknown'), never loud", async () => {
  for (const [type, kind] of [
    ["DeviceCapReached", "device_cap_reached"],
    ["MlsCallFull", "channel_full"],
  ] as const) {
    // Owner path (removeDevices / B2): the typed refusal reaches the caller.
    const env = new Env();
    env.routes.push((method, path) =>
      method === "POST" && path.endsWith("/commits")
        ? ok({ type, max: 5 }, 400)
        : undefined,
    );
    const m = make(env);
    const { p } = await scriptedRemove(env, m);
    let caught: unknown = null;
    await p.catch((e: unknown) => {
      caught = e;
    });
    assert.deepEqual(caught, {
      source: "server",
      status: 400,
      type,
      body: { type, max: 5 },
    });
    const ui = protectedNoticeForError(caught, { op: "channel" });
    assert.ok(ui.kind === "notice" && ui.notice === kind, `${type} notice`);
    assert.equal(env.calls("e2ee_text_commit_lost").length, 1, "stage dropped");
    assert.equal(env.api$("POST", /\/commits$/).length, 1, "never retried");
    assert.equal(env.calls("e2ee_text_mark_left").length, 0);
    assert.equal(env.views.get(CH)?.groupError ?? null, null, "never loud");
    assert.equal(env.shield(), "protected");
    m.dispose();

    // Admitter path: one Add, dropped, never re-staged, logged with the type.
    const env2 = new Env();
    env2.routes.push((method, path) =>
      method === "POST" && path.endsWith("/commits")
        ? ok({ type, max: 5 }, 400)
        : undefined,
    );
    const m2 = make(env2);
    await m2.refresh(CH, "open");
    m2.onJoinRequest(newDeviceRequest("S"), false);
    await env2.advance(10_000);
    assert.equal(env2.calls("e2ee_text_admit").length, 1, "no re-stage");
    assert.equal(env2.calls("e2ee_text_commit_lost").length, 1);
    assert.ok(
      env2.logs.some(
        (l) => l.msg === "[protected] admission failed" && l.ids.type === type,
      ),
    );
    assert.equal(env2.shield(), "protected");
    m2.dispose();
  }
});

test("W4d: unknown extra commit fields (W2 advisory removed_reasons) are tolerated and never reach native", async () => {
  const env = new Env();
  env.group = groupBody({ current_epoch: 4 });
  env.routes.push((method, path) =>
    method === "GET" && path.includes("from_epoch=4")
      ? ok({
          commits: [
            {
              group_id: G0,
              epoch: 4,
              committer: { user_id: OWNER, device_id: OWNER_DEV },
              commit: "C4",
              added: [],
              removed: [{ user_id: PEER, device_id: PEER_DEV }],
              removed_reasons: [{ user_id: PEER, reason: "unseated" }],
            },
          ],
          current_epoch: 4,
        })
      : undefined,
  );
  const m = make(env);
  await m.refresh(CH, "open");
  await env.advance(1_000);
  const processed = env.calls("e2ee_text_process");
  assert.equal(processed.length, 1, "the row was processed");
  assert.equal("removed_reasons" in processed[0].envelope, false);
  m.dispose();
});

// ---------------------------------------------------------------------------
// S7 C9: protector back-off (EL-F7 Linux keyring, AND-F13 Android Keystore)
// ---------------------------------------------------------------------------

/**
 * Every scripted native command answers `{ type: "protector" }` while
 * `locked()`: the store cannot be opened. `refused` counts those answers,
 * i.e. the unlock prompts a real keyring would have raised; `byCmd` splits
 * them per command.
 */
function protectorLock(env: Env, locked: () => boolean) {
  const lock = { refused: 0, byCmd: new Map<string, number>() };
  const handlers = env.handlers as Record<string, (a: unknown) => unknown>;
  for (const cmd of Object.keys(handlers)) {
    const h = handlers[cmd];
    handlers[cmd] = (a) => {
      if (locked()) {
        lock.refused += 1;
        lock.byCmd.set(cmd, (lock.byCmd.get(cmd) ?? 0) + 1);
        throw { type: "protector" };
      }
      return h(a);
    };
  }
  return lock;
}

/** B4's decrypt reduced to its port use: any native error is a red marker. */
function nativeDecryptDeps(env: Env): ProtectedTextManagerDeps {
  env.handlers.e2ee_text_decrypt = (a) => ({
    message_id: a.messageId,
    channel_id: a.channelId,
    group_id: G0,
    epoch: 3,
    author_user_id: a.authorUserId,
    sender_device_id: PEER_DEV,
    cid: a.nonce,
    ts: env.clock,
    text: "decrypted",
    replies: [],
    sender_verified: true,
    ts_skew: false,
  });
  return fakeDeps(env, {
    messages: {
      decryptRow: async (_ops, port, row, live) => {
        try {
          const d = await port.invoke("e2ee_text_decrypt", {
            channelId: row.channelId,
            messageId: row.id,
            authorUserId: row.authorId,
            nonce: row.nonce ?? "",
            encrypted: SENT_PAYLOAD,
            live,
          });
          return {
            status: "ok",
            text: d.text,
            replies: d.replies,
            senderVerified: d.sender_verified,
            tsSkew: d.ts_skew,
            cid: d.cid,
          };
        } catch {
          return { status: "marker", kind: "error" };
        }
      },
    },
  });
}

function peerRow(i: number) {
  return {
    id: `MP${i}`,
    channelId: CH,
    authorId: PEER,
    nonce: CID2,
    encrypted: SENT_PAYLOAD,
  };
}

/** The back-off windows: 2 s doubling, capped at 60 s. */
const PROTECTOR_WINDOWS = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];

test("C9 protector: a locked store holds every text command, one probe per back-off window (EL-F7)", async () => {
  const env = new Env();
  const deps = nativeDecryptDeps(env);
  let locked = true;
  const lock = protectorLock(env, () => locked);
  const m = make(env, deps);
  void silence(m.start());
  await env.advance(0);
  // The first command (own-device pins) was refused; nothing else ran.
  assert.equal(lock.refused, 1);
  assert.equal(env.invokes.length, 1);
  // A burst of passive work: an open channel, two envelopes, 20 messages.
  void silence(m.open(CH));
  await env.advance(0);
  m.onEnvelope(envelope("E1", 4));
  m.onEnvelope(envelope("E2", 5));
  for (let i = 0; i < 20; i++) m.onMessage(peerRow(i), true);
  await env.advance(0);
  assert.equal(env.invokes.length, 1, "nothing issued inside the window");
  for (const w of PROTECTOR_WINDOWS) {
    const before: number = env.invokes.length;
    await env.advance(w - 1);
    assert.equal(env.invokes.length, before, `nothing before ${w} ms`);
    await env.advance(1);
    assert.equal(env.invokes.length, before + 1, `ONE probe after ${w} ms`);
  }
  assert.equal(lock.refused, 1 + PROTECTOR_WINDOWS.length);
  // Held, not failed: never a leave or wipe, nothing acked, no groupError,
  // the shield at its loading `resecuring`, every message still pending.
  assert.equal(env.calls("e2ee_text_mark_left").length, 0);
  assert.deepEqual(env.acks, []);
  assert.equal(env.views.get(CH)?.groupError ?? null, null);
  assert.equal(env.views.get(CH)?.native ?? null, null);
  assert.equal(env.shield(), "resecuring");
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(env.msgViews.get(`MP${i}`), { status: "pending" });
  }
  const held = env.logs.filter(
    (l) => l.msg === "[protected] protector refused, text commands held",
  );
  assert.equal(held.length, 1 + PROTECTOR_WINDOWS.length, "one per escalation");
  assert.equal(held[0].level, "warn");
  // Unlocked: the next probe succeeds, the gate reopens, everything runs.
  locked = false;
  await env.advance(60_000);
  assert.equal(lock.refused, 1 + PROTECTOR_WINDOWS.length);
  for (let i = 0; i < 20; i++) {
    assert.equal(env.msgViews.get(`MP${i}`)?.status, "ok", `MP${i}`);
  }
  assert.equal(
    env.calls("e2ee_text_decrypt").length,
    20 + (lock.byCmd.get("e2ee_text_decrypt") ?? 0),
    "each message decrypted once; earlier decrypts were refused probes",
  );
  assert.deepEqual([...env.acks].sort(), ["E1", "E2"]);
  assert.equal(env.shield(), "protected");
  assert.ok(
    env.logs.some((l) => l.msg === "[protected] protector back-off cleared"),
  );
  m.dispose();
});

test("C9 protector: the first success resets the back-off; a later refusal starts again at 2 s", async () => {
  const env = new Env();
  const deps = nativeDecryptDeps(env);
  let locked = false;
  const lock = protectorLock(env, () => locked);
  const m = make(env, deps);
  await m.refresh(CH, "open");
  await env.advance(0);
  locked = true;
  m.onMessage(peerRow(0), true);
  await env.advance(0);
  assert.equal(lock.refused, 1);
  await env.advance(2_000);
  assert.equal(lock.refused, 2);
  await env.advance(4_000);
  assert.equal(lock.refused, 3);
  assert.deepEqual(env.msgViews.get("MP0"), { status: "pending" });
  locked = false;
  await env.advance(8_000);
  assert.equal(env.msgViews.get("MP0")?.status, "ok");
  // Reset: the next refusal waits 2 s again, not 16 s.
  locked = true;
  m.onMessage(peerRow(1), true);
  await env.advance(0);
  assert.equal(lock.refused, 4);
  await env.advance(1_999);
  assert.equal(lock.refused, 4);
  await env.advance(1);
  assert.equal(lock.refused, 5, "the window restarted at 2 s");
  locked = false;
  await env.advance(4_000);
  assert.equal(env.msgViews.get("MP1")?.status, "ok");
  m.dispose();
});

test("C9 protector: a refused _process is held unacked past the hold budget, never left, never a groupError (AND-F13)", async () => {
  const env = new Env();
  const m = make(env);
  await m.refresh(CH, "open");
  await env.advance(0);
  assert.equal(env.shield(), "protected");
  let locked = true;
  const lock = protectorLock(env, () => locked);
  m.onEnvelope(envelope("E1", 4));
  await env.advance(0);
  assert.equal(lock.refused, 1);
  // Long enough that a surfaced refusal would exhaust HOLD_RETRY_BUDGET:
  // each retry of a commit costs two commands (group kind, then process).
  const windows = [...PROTECTOR_WINDOWS, ...Array<number>(8).fill(60_000)];
  assert.ok(windows.length > 2 * (HOLD_RETRY_BUDGET + 1));
  await env.advance(windows.reduce((a, b) => a + b, 0));
  assert.equal(lock.refused, 1 + windows.length, "one probe per window");
  assert.deepEqual(env.acks, []);
  assert.equal(env.calls("e2ee_text_mark_left").length, 0);
  assert.equal(env.calls("e2ee_text_join").length, 0);
  assert.equal(env.views.get(CH)?.groupError, null);
  assert.equal(env.shield(), "protected", "a refusal never changes the view");
  assert.equal(
    env.logs.some((l) => l.msg === "[protected] envelope left unacked"),
    false,
  );
  locked = false;
  await env.advance(60_000);
  assert.deepEqual(env.acks, ["E1"], "processed and acked once");
  assert.equal(env.calls("e2ee_text_mark_left").length, 0);
  assert.equal(env.shield(), "protected");
  m.dispose();
});

test("W4e O1 (C-O1): protected while OPEN → the join starts at once; while closed → nothing until open", async () => {
  // Open before it is protected: no list, not seated, nothing to join.
  const env = new Env();
  env.states.set(CH, noGroup(CH));
  const m = make(env);
  await m.start();
  await m.open(CH);
  await env.advance(1_000);
  assert.equal(env.calls("e2ee_text_join").length, 0);
  // Protected and seated (verified list) while still open: the bridge
  // forwards the protect, and the join runs without a re-open or 60 s tick.
  env.states.set(
    CH,
    noGroup(CH, {
      self_seated: true,
      verdict: "no_group",
      seat_list: st().seat_list,
    }),
  );
  m.channelProtected(CH);
  await env.advance(1_000);
  assert.equal(env.calls("e2ee_text_join").length, 1, "join without re-open");
  assert.equal(env.api$("POST", /join_intent$/).length, 1);
  // A second forward (or an open in flight) never starts a second join.
  m.channelProtected(CH);
  void m.open(CH);
  await env.advance(1_000);
  assert.equal(env.calls("e2ee_text_join").length, 1, "idempotent");
  m.dispose();

  // Closed when protected: nothing until it is opened.
  const env2 = joiningEnv();
  const m2 = make(env2);
  await m2.start();
  m2.channelProtected(CH);
  await env2.advance(1_000);
  assert.equal(env2.calls("e2ee_text_join").length, 0, "closed: no join");
  await m2.open(CH);
  await env2.advance(1_000);
  assert.equal(env2.calls("e2ee_text_join").length, 1, "joins on open");
  m2.dispose();
});

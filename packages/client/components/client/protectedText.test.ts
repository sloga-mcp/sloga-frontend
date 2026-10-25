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
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MlsJoinRequest, MlsMemberDevice } from "./e2ee";
import { computeShieldState, shieldInputsFromView } from "./protectedShield.ts";
import {
  type ProtectedTextPortExtensions,
  FIRST_SIGHT_PER_MINUTE,
  ProtectedTextManager,
  REFETCH_403_PARK_BUDGET,
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
  sends: string[] = [];

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
    e2ee_text_join: () => ({
      device_id: DEV,
      key_package_ref: "KPR",
      signature: "JSIG",
    }),
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
      return ok({ result: "Won" });
    }
    if (method === "GET" && /\/commits\?from_epoch=/.test(path)) {
      return ok({ commits: [], current_epoch: 3 });
    }
    if (method === "POST" && /\/join_intent$/.test(path)) return ok(null, 204);
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
      encryptAndSend: async (_ops, _port, _ch, text) => {
        env.sends.push(text);
        return { messageId: "MSENT", cid: CID1, raw: { _id: "MSENT" } };
      },
      decryptRow: async (_ops, _port, row) => {
        env.decrypts.push(row.id);
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

  // Message: live row decrypted through B4; own send uses typed text.
  m.onMessage(
    { id: "M1", channelId: CH, authorId: PEER, nonce: CID2, encrypted: null },
    true,
  );
  await env.advance(0);
  assert.equal(env.msgViews.get("M1")?.status, "ok");
  const out = await m.send(CH, "hello", [], false, "k1");
  assert.equal(out.messageId, "MSENT");
  const own = env.msgViews.get("MSENT");
  assert.ok(own?.status === "ok" && own.text === "hello");
  m.onMessage(
    {
      id: "MSENT",
      channelId: CH,
      authorId: SELF,
      nonce: CID1,
      encrypted: null,
    },
    true,
  );
  await env.advance(0);
  assert.equal(env.decrypts.includes("MSENT"), false, "own echo deduped");
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
  await assert.rejects(p);
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, false);
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
      return ok([{ _id: "MX", author: SELF, nonce: CID1 }]);
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
      ? ok([{ _id: "MX", author: SELF, nonce: CID1 }])
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

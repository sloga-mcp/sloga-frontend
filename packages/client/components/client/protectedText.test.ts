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
  type OwnListingRequest,
  OwnListingCache,
} from "./protectedOwnListing.ts";
import { TEXT_PROTOCOL } from "./protectedPlatform.ts";
import { validReason } from "./protectedRemovalReasonPolicy.ts";
import {
  computeShieldState,
  explainShield,
  protectedNoticeForError,
  shieldInputsFromView,
} from "./protectedShield.ts";
import {
  type ProtectedTextPortExtensions,
  CHANNEL_CHANGED_COALESCE_MS,
  FIRST_SIGHT_PER_MINUTE,
  HOLD_RETRY_BUDGET,
  JOIN_ADMIT_WINDOW_MS,
  joinIntentHeld,
  KEY_PACKAGE_PUT_429_BUDGET,
  PROTECTED_RECOVERY_REFUSED_KEY_PREFIX,
  PROTECTED_REFUSAL_PACE_KEY_PREFIX,
  ProtectedTextManager,
  RECOVERY_PUT_RETRY_BUDGET,
  recoverySeats,
  REFETCH_403_PARK_BUDGET,
  STALE_SEATS_REFETCH_BUDGET,
  STICKY_GROUP_ERRORS,
  WON_ROW_READ_BUDGET,
} from "./protectedText.ts";
import { textGroupId } from "./protectedTextIds.ts";
import {
  _resetOwnerFlowsForTest,
  publishStoreKey,
  recoverOwnership,
} from "./protectedTextOwner.ts";
import {
  JOIN_RETRIES,
  joinRebroadcastDelayMs,
  REFUSAL_PACE_BASE_MS,
  SIGNER_LEAF_MISSING_BUDGET,
  WELCOME_FETCH_AFTER_MS,
  WELCOME_PIN_DEVICES_MAX,
} from "./protectedTextPolicy.ts";
import type {
  MessageFlows,
  OwnerDeviceNotice,
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

/** The join_intent POST body: native's intent plus the S2 protocol (a). */
function intentBody(n: number) {
  return { ...joinIntent(n).intent, protocol: TEXT_PROTOCOL };
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
    removed_reasons?: unknown;
  }[] = [];
  /** The DS's own `rejoin_intents` for the rows it stores (null: absent). */
  dsRejoin: MlsJoinRequest[] | null = null;
  /** Overrides the stored `commit` string (RC NEW-5 on a plain win). */
  storedCommit: string | null = null;
  /** The DS's `removed_reasons` for the rows it stores (undefined: absent). */
  dsLabels: unknown = undefined;
  /** `onGroupReported` calls (S2 h), also traced as `reported <id>`. */
  reported: [string, string, number][] = [];

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
    // FXP (round 4): native records the signer of an `owner_changed` it
    // answers (`_process`, `_seat_list_verify`) as its pending signer, and
    // a confirm clears it. m4-4: on the channel the call names (its
    // `channelId`, or for `_process` the channel holding its group).
    const ch = this.channelOf(args);
    return Promise.resolve()
      .then(() => h(args))
      .then(
        (r) => {
          if (cmd === "e2ee_text_owner_confirm_change") {
            this.state(ch).owner_pin.pending_signer = null;
          }
          return r;
        },
        (err: unknown) => {
          const e = err as Record<string, unknown> | null;
          if (
            (cmd === "e2ee_text_process" ||
              cmd === "e2ee_text_seat_list_verify") &&
            e?.type === "owner_changed"
          ) {
            this.state(ch).owner_pin.pending_signer = {
              user_id: String(e.signer_user_id),
              device_id: String(e.signer_device_id),
              same_user: e.same_user === true,
              verified: e.verified === true,
            };
          }
          throw err;
        },
      );
  }

  /**
   * m4-4: the channel a native call names: its `channelId`, or for
   * `_process` (which names a group) the channel whose state holds the
   * envelope's group; CH otherwise.
   */
  channelOf(args: unknown): string {
    const a = args as {
      channelId?: unknown;
      envelope?: { group_id?: unknown };
    } | null;
    if (typeof a?.channelId === "string") return a.channelId;
    const gid = a?.envelope?.group_id;
    for (const [ch, s] of this.states) {
      if (gid !== undefined && s.group_id === gid) return ch;
    }
    return CH;
  }

  async pinCallIdentities(userId: string, targets: string[]) {
    this.pins.push({ userId, targets });
    return targets;
  }

  async ownDeviceListing(
    _request?: OwnListingRequest,
  ): Promise<{ hash: string; listing: unknown[] }> {
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

  notify(kind: string) {
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

  /** The shield's state and notice (design 9.1 with the deciding step). */
  explain(ch = CH) {
    const e = explainShield(
      shieldInputsFromView(
        this.views.get(ch),
        { serverProtected: true, locallyPinned: true, capable: true },
        this.clock,
      ),
    );
    return e ? { state: e.state, notice: e.notice } : null;
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
    // m4-4: native refuses a confirm with nothing pending (InvalidArgument).
    e2ee_text_owner_confirm_change: (a) => {
      if (env.state(a.channelId).owner_pin.pending_signer == null) {
        throw { type: "invalid_argument", field: "pending_signer" };
      }
      return null;
    },
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
          ...(env.dsLabels !== undefined
            ? { removed_reasons: env.dsLabels }
            : {}),
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
      signOwnerDevices: async () => undefined,
      moveOwnerKey: async () => undefined,
      pendingSeats: () => null,
      cancelPendingSeats: () => ({ discarded: false, why: "none" }),
      // FX-R: the real flow (pure; it drives this manager and the fake port).
      recoverOwnership,
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
          filesUnsupported: 0,
          timingUnverified: false,
          belowBoundary: false,
          historySender: false,
        };
      },
      markerForError: () => "error",
      ...over.messages,
    },
    requestBackupRefresh: () => undefined,
  };
}

function make(env: Env, deps?: ProtectedTextManagerDeps) {
  return new ProtectedTextManager(
    env,
    {
      onView: (ch, v) => env.views.set(ch, v),
      onMessageView: (id, v) => env.msgViews.set(id, v),
      onTimelineMarker: (_ch, m) => env.markers.push(m),
      onHistoryPolicy: () => undefined,
      onGroupReported: (ch: string, groupId: string, generation: number) => {
        env.reported.push([ch, groupId, generation]);
        env.trace.push(`reported ${groupId}`);
      },
    } as ConstructorParameters<typeof ProtectedTextManager>[1],
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
    recovery: false,
    supersedesGeneration: null,
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
    removedReasons: [],
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
    pendingDeviceTargets: [],
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

/** The stored-Welcome route answering `answer` (S2-D29, FX-J). */
function welcomeRoute(answer: () => TextApiResponse | "transport"): Route {
  return (method, path) =>
    method === "GET" && /^\/mls\/groups\/[0-9a-f]+\/welcome\?/.test(path)
      ? answer()
      : undefined;
}

/** The stored-Welcome GETs so far. */
function welcomeGets(env: Env) {
  return env.api$("GET", /^\/mls\/groups\/[0-9a-f]+\/welcome\?/);
}

/** Intents posted so far (each one `_join` + PUT + POST). */
function intents(env: Env) {
  return env.api$("POST", /join_intent$/).length;
}

/**
 * FX-J2: the virtual time (ms after `from`) of every intent POST from now
 * on, as the courier saw it.
 */
function intentTimes(env: Env, from = env.clock): number[] {
  const times: number[] = [];
  env.routes.push((method, path) => {
    if (method === "POST" && /join_intent$/.test(path)) {
      times.push(env.clock - from);
    }
    return undefined;
  });
  return times;
}

/**
 * The stored Welcome GETs of one fetch with a 5xx / transport answer: the
 * first plus `WELCOME_FETCH_RETRY_BUDGET` (3) re-sends, 250 + 500 + 1000 ms.
 */
const UNAVAILABLE_FETCH_GETS = 4;
const UNAVAILABLE_FETCH_MS = 1_750;

test("join: member_added at/after our intent holds the intents while that Add's Welcome path runs; after its one fetch (here unavailable) the re-broadcast resumes on the backoff and the shield waits for a member (S2 6d)", async () => {
  const env = joiningEnv();
  // FX-J: the stored Welcome stays unavailable (5xx). FX-J2 NEW-1: that
  // Add's ONE fetch gives up; the Add is done and the joiner re-broadcasts
  // its intent on the backoff (it never waits on that Add alone).
  env.routes.push(welcomeRoute(() => ok({ type: "InternalError" }, 503)));
  const m = make(env);
  const times = intentTimes(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({
    member_added: [{ user_id: SELF, device_id: DEV, epoch: 4, at: "" }],
  });
  // W4d X#6: no second intent while that Add's Welcome path runs (the
  // first wait, 20 s for the Welcome, then the one fetch).
  const pathEnds =
    joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS + UNAVAILABLE_FETCH_MS;
  await env.advance(pathEnds - 1);
  assert.equal(intents(env), 1);
  await env.advance(1);
  assert.equal(intents(env), 2, "the re-broadcast after the one fetch");
  await env.advance(200_000 - pathEnds);
  assert.deepEqual(times, [
    0,
    pathEnds,
    pathEnds + 20_000,
    pathEnds + 60_000,
    pathEnds + 140_000,
  ]);
  // S2-D28: the join is not given up: stalled (9.1 6d) and still armed.
  // S2 6d: silence is not a verified failure: `resecuring`, "Waiting for a
  // member to come online", never `unverified`.
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, true);
  assert.deepEqual(env.explain(), {
    state: "resecuring",
    notice: "waiting_for_member",
  });
  assert.equal(welcomeGets(env).length, UNAVAILABLE_FETCH_GETS, "one fetch");
  assert.equal(env.sleeps.length, 1, "the join timer is still armed");
  await env.advance(3_600_000);
  assert.equal(
    welcomeGets(env).length,
    UNAVAILABLE_FETCH_GETS,
    "that Add is never fetched again",
  );
  m.dispose();
});

test("join: past JOIN_RETRIES unanswered intents → welcomeRetriesExhausted → resecuring, waiting for a member (S2 6d); the joiner keeps re-broadcasting with backoff, its timer armed", async () => {
  const env = joiningEnv();
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  // 1 + JOIN_RETRIES intents at 0, 10, 30, 70 s; the next wait (80 s) ends
  // at 150 s: past the first retries.
  let t = 0;
  for (let i = 0; i <= JOIN_RETRIES; i++) t += joinRebroadcastDelayMs(i);
  await env.advance(t - 1);
  assert.equal(intents(env), 1 + JOIN_RETRIES);
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, false);
  await env.advance(1);
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, true);
  // S2 6d: no Welcome is silence, never a verified failure.
  assert.deepEqual(env.explain(), {
    state: "resecuring",
    notice: "waiting_for_member",
  });
  // ... while the joiner is still working: the next intent went out and
  // exactly one timer waits for the next re-broadcast.
  assert.equal(intents(env), 2 + JOIN_RETRIES);
  const next = joinRebroadcastDelayMs(JOIN_RETRIES + 1);
  assert.deepEqual(
    env.sleeps.map((s) => s.at - env.clock),
    [next],
    "one join timer, armed for the next re-broadcast",
  );
  await env.advance(next);
  assert.equal(intents(env), 3 + JOIN_RETRIES);
  assert.deepEqual(env.explain(), {
    state: "resecuring",
    notice: "waiting_for_member",
  });
  m.dispose();
  await env.advance(0);
  assert.equal(env.sleeps.length, 0, "dispose clears the join timer");
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
  assert.deepEqual(
    first[1].body,
    intentBody(1),
    "the intent alone (+ protocol)",
  );
  // FX-J (S2-D28): the first 1 + JOIN_RETRIES attempts, by the backoff.
  let t = 0;
  for (let i = 0; i < JOIN_RETRIES; i++) t += joinRebroadcastDelayMs(i);
  await env.advance(t);
  assert.equal(env.calls("e2ee_text_join").length, 1 + JOIN_RETRIES);
  const expected = Array.from({ length: 1 + JOIN_RETRIES }, (_, i) => [
    ["PUT", joinIntent(i + 1).key_packages],
    ["POST", intentBody(i + 1)],
  ]).flat();
  assert.deepEqual(
    joinTraffic(env).map((c) => [c.method, c.body]),
    expected,
    "each attempt PUTs its own fresh package, then posts its own intent",
  );
  m.dispose();
  await p.catch(() => undefined);
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
      ["POST", intentBody(3)],
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
    {
      groupId: G0,
      wonEpoch: 4,
      storedCommitB64: "REM",
      rejoinIntents: [ds],
      removedReasons: [],
    },
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
      removedReasons: [],
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
    {
      channelId: CH,
      userId: SELF,
      supersedes: G0,
      recovery: false,
      supersedesGeneration: null,
    },
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
    {
      channelId: CH,
      userId: SELF,
      supersedes: null,
      recovery: false,
      supersedesGeneration: null,
    },
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
    {
      groupId: G0,
      wonEpoch: 4,
      storedCommitB64: "REM",
      rejoinIntents: [ds],
      removedReasons: [],
    },
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
    recovery: false,
    supersedesGeneration: null,
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
    env.markers.map((k) => [
      k.kind,
      k.kind === "history_floor" ? null : k.userId,
    ]),
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
          filesUnsupported: 0,
          timingUnverified: false,
          belowBoundary: false,
          historySender: false,
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
          filesUnsupported: 0,
          timingUnverified: false,
          belowBoundary: false,
          historySender: false,
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
      removedReasons: [],
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
    {
      groupId: G0,
      wonEpoch: 4,
      storedCommitB64: "ADM",
      rejoinIntents: [],
      removedReasons: [],
    },
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
      removedReasons: [],
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

test("W4d X#6 (C-X6): member_added suppresses every _join while that Add's Welcome is due; once its one fetch ran, later triggers join the running join and the intents follow the backoff (S2 6d), never a restarted join", async () => {
  const env = joiningEnv();
  // FX-J: the stored Welcome stays unavailable (transport). FX-J2 NEW-1:
  // after that Add's ONE fetch the joiner re-broadcasts on the backoff.
  env.routes.push(welcomeRoute(() => "transport"));
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_join").length, 1);
  env.group = groupBody({
    member_added: [{ user_id: SELF, device_id: DEV, epoch: 4, at: "" }],
  });
  const pathEnds =
    joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS + UNAVAILABLE_FETCH_MS;
  await env.advance(pathEnds - 1);
  assert.equal(env.calls("e2ee_text_join").length, 1, "none while due");
  // Re-broadcasts at pathEnds, +20 s, +40 s, +80 s: five intents by 200 s.
  await env.advance(200_000 - (pathEnds - 1));
  assert.equal(intents(env), 5);
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, true);
  // Later triggers (a rejoin verdict, a refresh) join the running join:
  // no intent at once (S2-D28: never a second join run).
  silence(m.ensureJoined(CH));
  await m.refresh(CH, "interval");
  await env.advance(0);
  assert.equal(intents(env), 5, "no extra intent at once");
  assert.equal(env.sleeps.length, 1, "one join timer");
  // A manual reopen restarts the backoff: the pending wait ends 10 s on.
  await m.open(CH);
  await env.advance(joinRebroadcastDelayMs(0) - 1);
  assert.equal(intents(env), 5);
  await env.advance(1);
  assert.equal(intents(env), 6);
  assert.equal(env.calls("e2ee_text_join").length, 6, "one _join per intent");
  assert.equal(welcomeGets(env).length, UNAVAILABLE_FETCH_GETS, "one fetch");
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, true);
  // S2 6d: `resecuring` "Waiting for a member", never `unverified`.
  assert.deepEqual(env.explain(), {
    state: "resecuring",
    notice: "waiting_for_member",
  });
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

test("S2 removed_reasons (was W4d advisory): a label without device_id makes the commit row malformed and it never reaches native; well-formed labels, unknown reasons included, reach native verbatim", async () => {
  const rowWith = (removed_reasons: unknown) =>
    ok({
      commits: [
        {
          group_id: G0,
          epoch: 4,
          committer: { user_id: OWNER, device_id: OWNER_DEV },
          commit: "C4",
          added: [],
          removed: [{ user_id: PEER, device_id: PEER_DEV }],
          removed_reasons,
        },
      ],
      current_epoch: 4,
    });
  // S2 (L1r): a reason without device_id is a malformed envelope.
  const env = new Env();
  env.group = groupBody({ current_epoch: 4 });
  env.routes.push((method, path) =>
    method === "GET" && path.includes("from_epoch=4")
      ? rowWith([{ user_id: PEER, reason: "unseated" }])
      : undefined,
  );
  const m = make(env);
  await m.refresh(CH, "open");
  await env.advance(1_000);
  assert.equal(env.calls("e2ee_text_process").length, 0, "never processed");
  assert.ok(
    env.logs.some((l) => l.msg === "[protected] catch-up row malformed"),
    "logged as malformed (ids only)",
  );
  m.dispose();

  // Well-formed: carried verbatim (an unknown reason passes; native maps it).
  const labels = [
    { user_id: PEER, device_id: PEER_DEV, reason: "off_list" },
    { user_id: PEER, device_id: "dev-old", reason: "from_the_future" },
  ];
  const env2 = new Env();
  env2.group = groupBody({ current_epoch: 4 });
  env2.routes.push((method, path) =>
    method === "GET" && path.includes("from_epoch=4")
      ? rowWith(labels)
      : undefined,
  );
  const m2 = make(env2);
  await m2.refresh(CH, "open");
  await env2.advance(1_000);
  const processed = env2.calls("e2ee_text_process");
  assert.equal(processed.length, 1, "the row was processed");
  assert.deepEqual(processed[0].envelope.removed_reasons, labels);
  m2.dispose();
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
    files: [],
    timing_unverified: false,
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
            filesUnsupported: 0,
            timingUnverified: false,
            belowBoundary: false,
            historySender: false,
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

// ---------------------------------------------------------------------------
// S2-W4 lane L2m: the manager's S2 items (a)-(j) and inherited rules. Tests
// named "S2 ..." are the targets of /home/mcp/pc-logs/s2/w4/ctl/L2m.
// ---------------------------------------------------------------------------

test("S2 (a): the join intent and the Text create carry the shell protocol (TEXT_PROTOCOL) beside native's payload as received", async () => {
  assert.equal(TEXT_PROTOCOL, 2);
  const env = joiningEnv();
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(0);
  const post = env.api$("POST", /join_intent$/);
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].body, { ...joinIntent(1).intent, protocol: 2 });
  m.dispose();
  await p.catch(() => undefined);

  const env2 = new Env();
  env2.states.set(CH, noGroup(CH));
  env2.group = null;
  const m2 = make(
    env2,
    fakeDeps(env2, {
      owner: {
        protect: async (ops, _port, ch) => {
          await ops.createGroup(ch, null);
        },
      },
    }),
  );
  await m2.protect(CH, [SELF], 5);
  const create = env2.api$("POST", /^\/mls\/groups$/);
  assert.equal(create.length, 1);
  assert.deepEqual(create[0].body, {
    group_id: G0,
    channel_id: CH,
    device_id: DEV,
    supersedes: null,
    kind: "Text",
    generation: 0,
    protocol: 2,
  });
  m2.dispose();
});

test("S2 (a) OR-4: ProtectedClientOutdated on the join intent sets clientOutdated = min (not_available, client_outdated); no further intent or create until reload", async () => {
  const env = joiningEnv();
  env.routes.push((method, path) =>
    method === "POST" && /join_intent$/.test(path)
      ? ok({ type: "ProtectedClientOutdated", min: 3 }, 400)
      : undefined,
  );
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(0);
  await assert.rejects(
    p,
    (e: { source?: string; type?: string }) =>
      e.source === "server" && e.type === "ProtectedClientOutdated",
  );
  assert.equal(env.views.get(CH)?.clientOutdated, 3);
  assert.deepEqual(env.explain(), {
    state: "not_available",
    notice: "client_outdated",
  });
  await m.refresh(CH, "interval");
  await m.open(CH);
  await env.advance(600_000);
  await assert.rejects(
    m.ensureJoined(CH),
    (e: { reason?: string }) => e.reason === "client_outdated",
  );
  await assert.rejects(
    m.createGroup(CH, null),
    (e: { reason?: string }) => e.reason === "client_outdated",
  );
  assert.equal(env.api$("POST", /join_intent$/).length, 1, "never retried");
  assert.equal(env.api$("POST", /^\/mls\/groups$/).length, 0);
  assert.equal(env.calls("e2ee_text_group_create").length, 0);
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, false);
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] client outdated for this channel" &&
        JSON.stringify(l.ids) === JSON.stringify({ channelId: CH }),
    ),
    "logged with ids only",
  );
  m.dispose();
});

test("S2 (b): catchUpTip is the page's server tip only for commits a catch-up fetched; a live envelope gets null", async () => {
  const env = new Env();
  env.group = groupBody({ current_epoch: 5 });
  const row = (epoch: number) => ({
    group_id: G0,
    epoch,
    committer: { user_id: OWNER, device_id: OWNER_DEV },
    commit: "C" + epoch,
    added: [],
    removed: [],
  });
  env.routes.push((method, path) =>
    method === "GET" && path.endsWith("from_epoch=4")
      ? ok({ commits: [row(4), row(5)], current_epoch: 5 })
      : undefined,
  );
  const m = make(env);
  await m.refresh(CH, "open");
  await env.advance(1_000);
  assert.deepEqual(
    env.calls("e2ee_text_process").map((a) => [a.envelope.epoch, a.catchUpTip]),
    [
      [4, 5],
      [5, 5],
    ],
  );
  m.onEnvelope(envelope("LIVE6", 6));
  await env.advance(1_000);
  const live = env
    .calls("e2ee_text_process")
    .filter((a) => a.envelope.id === "LIVE6");
  assert.equal(live.length, 1);
  assert.equal(live[0].catchUpTip, null);
  m.dispose();
});

test("S2 (b): verify gets the server's as_of_generation (null when absent); _remove gets pending devices minus self and the list signer (rule 3a duty)", async () => {
  const env = new Env();
  env.seats = seatsBody({ as_of_generation: 0 });
  const m = make(env);
  await m.refresh(CH, "open");
  assert.equal(
    env.calls("e2ee_text_seat_list_verify").at(-1)?.asOfGeneration,
    0,
  );
  env.seats = seatsBody();
  await m.refresh(CH, "interval");
  assert.equal(
    env.calls("e2ee_text_seat_list_verify").at(-1)?.asOfGeneration,
    null,
  );
  m.dispose();

  const env2 = new Env();
  env2.group = groupBody({
    pending_device_removals: [
      { user_id: PEER, device_id: PEER_DEV, created_at: "" },
      { user_id: SELF, device_id: DEV, created_at: "" },
      { user_id: OWNER, device_id: OWNER_DEV, created_at: "" },
      { user_id: PEER, device_id: "dev-gone", created_at: "" },
    ],
  });
  const won = env2.handlers.e2ee_text_commit_won!;
  env2.handlers.e2ee_text_commit_won = (a) => {
    const s = env2.state();
    s.members = s.members.filter((x) => x.device_id !== PEER_DEV);
    return won(a);
  };
  const m2 = make(env2);
  await m2.refresh(CH, "open");
  await env2.advance(10_000);
  const rm = env2.calls("e2ee_text_remove");
  assert.equal(rm.length, 1);
  assert.deepEqual(rm[0].targets, [{ user_id: PEER, device_id: PEER_DEV }]);
  assert.deepEqual(rm[0].pendingDeviceTargets, [
    { user_id: PEER, device_id: PEER_DEV },
    { user_id: PEER, device_id: "dev-gone" },
  ]);
  assert.deepEqual(rm[0].pendingRemovalUsers, []);
  m2.dispose();
});

test("S2 (c): a superseded group (active, verdict no_group) is not held: ensureJoined takes the join path to the server's successor", async () => {
  const env = new Env();
  env.states.set(CH, st({ verdict: "no_group" }));
  env.group = groupBody({ group_id: G1, generation: 1, current_epoch: 0 });
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.deepEqual(env.calls("e2ee_text_join")[0], {
    groupId: G1,
    channelId: CH,
    generation: 1,
    userId: SELF,
  });
  assert.equal(
    env.api$("POST", /join_intent$/)[0]?.path,
    "/mls/groups/" + G1 + "/join_intent",
  );
  m.dispose();
  await p.catch(() => undefined);
});

test("S2 (c) D1: re-running an unaccepted create names the server's open group at generation - 1 as supersedes, never a derived or held id", async () => {
  const GX = "ab".repeat(32);
  const GS = "cd".repeat(32);
  const signer = {
    ...st().seat_list!,
    signer_user_id: SELF,
    signer_device_id: DEV,
  };
  const untouched = () =>
    st({
      group_id: GX,
      generation: 70,
      epoch: 0,
      members: [mem(SELF, DEV)],
      seat_list: signer,
    });
  const env = new Env();
  env.states.set(CH, untouched());
  env.group = groupBody({ group_id: GS, generation: 69 });
  env.handlers.e2ee_text_group_create = (a) => ({
    group_id: GX,
    generation: 70,
    payload: {
      group_id: GX,
      channel_id: a.channelId,
      device_id: DEV,
      supersedes: a.supersedes,
      kind: "Text",
      generation: 70,
    },
  });
  const m = make(env);
  await m.refresh(CH, "open");
  await env.advance(1_000);
  assert.deepEqual(env.calls("e2ee_text_group_create"), [
    {
      channelId: CH,
      userId: SELF,
      supersedes: GS,
      recovery: false,
      supersedesGeneration: null,
    },
  ]);
  m.dispose();

  // The server does not hold generation - 1: nothing is re-run or guessed.
  const env2 = new Env();
  env2.states.set(CH, untouched());
  env2.group = groupBody({ group_id: GS, generation: 60 });
  const m2 = make(env2);
  await m2.refresh(CH, "open");
  await env2.advance(1_000);
  assert.equal(env2.calls("e2ee_text_group_create").length, 0);
  assert.ok(
    env2.logs.some(
      (l) => l.msg === "[protected] unaccepted group: predecessor unknown",
    ),
  );
  m2.dispose();
});

test("S2 (d) recovery: only the UI call recovers; sign(recovery) FIRST, then the successor create (no leaf in the open group), then the seat PUT of the same bytes (design 6.3, 213)", async () => {
  const LOST = "dev-lost";
  const lostList = {
    ...st().seat_list!,
    signer_user_id: SELF,
    signer_device_id: LOST,
  };
  const signerLost = {
    user_id: SELF,
    device_id: LOST,
    cause: "device_revoked",
    at: "",
  };
  const signed = {
    version: 2,
    body: "sloga-seat-list-v2\nR",
    signature: "RSIG",
    signer_user_id: SELF,
    signer_device_id: DEV,
    authority: { body: "AUTH", signature: "ASIG" },
  };
  const env = new Env();
  env.states.set(CH, st({ seat_list: lostList }));
  env.group = groupBody({
    members: [
      { user_id: OWNER, device_id: OWNER_DEV },
      { user_id: PEER, device_id: PEER_DEV },
    ],
    signer_lost: signerLost,
  });
  env.handlers.e2ee_text_seat_list_sign = () => signed;
  env.routes.push((method, path) =>
    method === "PUT" && path === "/channels/" + CH + "/seats"
      ? ok(seatsBody())
      : undefined,
  );
  const m = make(env);
  await m.refresh(CH, "open");
  await m.refresh(CH, "interval");
  await env.advance(120_000);
  assert.equal(env.calls("e2ee_text_seat_list_sign").length, 0, "never auto");
  assert.equal(env.calls("e2ee_text_group_create").length, 0);
  assert.equal(env.api$("PUT", /\/seats$/).length, 0);

  await m.recoverOwnership(CH);
  const sign = env.calls("e2ee_text_seat_list_sign");
  assert.equal(sign.length, 1);
  assert.equal(sign[0].recovery, true);
  assert.equal(sign[0].format, null);
  assert.equal(sign[0].authority, null);
  assert.deepEqual(sign[0].serverList, {
    version: 1,
    body: seatsBody().list.body,
  });
  assert.deepEqual(sign[0].seats, lostList.seats);
  assert.equal(sign[0].deviceCap, lostList.device_cap);
  assert.deepEqual(env.calls("e2ee_text_group_create"), [
    {
      channelId: CH,
      userId: SELF,
      supersedes: G0,
      recovery: true,
      supersedesGeneration: 0,
    },
  ]);
  const put = env.api$("PUT", /\/seats$/);
  assert.equal(put.length, 1);
  assert.deepEqual(put[0].body, {
    body: signed.body,
    signature: signed.signature,
    signer_device_id: DEV,
    authority: signed.authority,
  });
  const order = [
    "e2ee_text_seat_list_sign",
    "e2ee_text_group_create",
    "POST /mls/groups",
    "PUT /channels/" + CH + "/seats",
  ].map((t) => env.trace.indexOf(t));
  assert.ok(
    order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])),
    "sign, create, POST, PUT: " + order.join(","),
  );
  m.dispose();

  // Holding a leaf in the open group: no successor, just the PUT.
  const env3 = new Env();
  env3.states.set(CH, st({ seat_list: lostList }));
  env3.group = groupBody({ signer_lost: signerLost });
  env3.handlers.e2ee_text_seat_list_sign = () => signed;
  env3.routes.push((method, path) =>
    method === "PUT" && path === "/channels/" + CH + "/seats"
      ? ok(seatsBody())
      : undefined,
  );
  const m3 = make(env3);
  await m3.recoverOwnership(CH);
  assert.equal(env3.calls("e2ee_text_group_create").length, 0);
  assert.equal(env3.api$("PUT", /\/seats$/).length, 1);
  m3.dispose();

  // The lost device is this one, or nothing was lost: never available.
  for (const lost of [{ ...signerLost, device_id: DEV }, undefined]) {
    const env2 = new Env();
    env2.group = groupBody(lost ? { signer_lost: lost } : {});
    const m2 = make(env2);
    await assert.rejects(
      m2.recoverOwnership(CH),
      (e: { reason?: string }) => e.reason === "recovery_unavailable",
    );
    assert.equal(env2.calls("e2ee_text_seat_list_sign").length, 0);
    m2.dispose();
  }
});

test("S2 (e): catch_up_leaf_unresolvable: _mark_left(catch_up_failed) BEFORE the rejoin's _join; resecuring, never a sticky loud tag", async () => {
  const env = new Env();
  const m = make(env);
  await m.refresh(CH, "open");
  env.handlers.e2ee_text_process = () => {
    throw { type: "catch_up_leaf_unresolvable", group_id: G0, epoch: 4 };
  };
  m.onEnvelope(envelope("E4", 4));
  await env.advance(1_000);
  assert.deepEqual(env.calls("e2ee_text_mark_left"), [
    { groupId: G0, reason: "catch_up_failed" },
  ]);
  const left = env.trace.indexOf("e2ee_text_mark_left");
  const join = env.trace.indexOf("e2ee_text_join");
  assert.ok(left >= 0 && join > left, "mark_left, then the rejoin's _join");
  assert.ok(env.acks.includes("E4"), "acked");
  assert.equal(env.views.get(CH)?.groupError, "catch_up_leaf_unresolvable");
  assert.notEqual(env.shield(), "unverified");
  assert.equal(
    (STICKY_GROUP_ERRORS as readonly string[]).includes(
      "catch_up_leaf_unresolvable",
    ),
    false,
  );
  m.dispose();
});

test("S2 (f): DeviceCapReached on the join intent: capacity (device_cap), never a Welcome retry; only an open or ProtectedChannelChanged retries; the event clears it and rejoins", async () => {
  const env = joiningEnv();
  let full = true;
  env.routes.push((method, path) =>
    full && method === "POST" && /join_intent$/.test(path)
      ? ok({ type: "DeviceCapReached", max: 5 }, 400)
      : undefined,
  );
  const m = make(env);
  const p = silence(m.ensureJoined(CH));
  await env.advance(0);
  await assert.rejects(
    p,
    (e: { type?: string }) => e.type === "DeviceCapReached",
  );
  assert.deepEqual(env.views.get(CH)?.capacity, { reason: "device_cap" });
  assert.deepEqual(env.explain(), {
    state: "capacity",
    notice: "capacity_device_cap",
  });
  await m.refresh(CH, "interval");
  await env.advance(300_000);
  assert.equal(env.api$("POST", /join_intent$/).length, 1, "no auto retry");
  // An open is the manual retry ("Try again"): refused again, never 6d.
  await m.open(CH);
  await env.advance(0);
  m.close(CH);
  assert.equal(env.api$("POST", /join_intent$/).length, 2);
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, false);
  assert.deepEqual(env.views.get(CH)?.capacity, { reason: "device_cap" });
  // The cap was raised: the event clears capacity and the join runs.
  full = false;
  m.onChannelChanged(CH, ["seats"]);
  assert.equal(env.views.get(CH)?.capacity, null, "cleared by the event");
  await env.advance(CHANNEL_CHANGED_COALESCE_MS);
  assert.equal(env.api$("POST", /join_intent$/).length, 3, "rejoined");
  m.dispose();
});

test("S2 (g): ProtectedChannelChanged: a burst costs ONE refresh after the coalesce window; unknown scope items and unknown channels are ignored", async () => {
  const env = new Env();
  const m = make(env);
  await m.refresh(CH, "open");
  await env.advance(0);
  const seatsGets = () => env.api$("GET", /^\/channels\/[^/]+\/seats$/).length;
  const before = seatsGets();
  for (let i = 0; i < 5; i++) m.onChannelChanged(CH, ["seats", "text_group"]);
  m.onChannelChanged(CH, ["from_the_future"]);
  m.onChannelChanged("01J9Z3K4M5N6P7Q8R9S0T1V2XX", ["seats"]);
  await env.advance(CHANNEL_CHANGED_COALESCE_MS - 1);
  assert.equal(seatsGets(), before, "nothing inside the window");
  await env.advance(1);
  assert.equal(seatsGets(), before + 1, "one refresh for the burst");
  await env.advance(10_000);
  assert.equal(seatsGets(), before + 1);
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(CHANNEL_CHANGED_COALESCE_MS);
  assert.equal(seatsGets(), before + 2, "a later event is a new burst");
  m.dispose();
});

test("S2 retryNow: ONE manual refresh, never the open interval; held channels only", async () => {
  const env = new Env();
  const m = make(env);
  await m.refresh(CH, "interval");
  await env.advance(0);
  const seatsGets = () => env.api$("GET", /^\/channels\/[^/]+\/seats$/).length;
  const before = seatsGets();
  m.retryNow(CH);
  await env.advance(0);
  assert.equal(seatsGets(), before + 1, "one refresh now");
  // no loop: nothing more however long the channel stays untouched
  await env.advance(10 * 60_000);
  assert.equal(seatsGets(), before + 1, "no interval started");
  assert.equal(env.sleeps.length, 0, "no timer left behind");
  // a channel the manager doesn't hold is ignored (no register, no GET)
  m.retryNow("01J9Z3K4M5N6P7Q8R9S0T1V2XX");
  await env.advance(0);
  assert.equal(
    env.api$("GET", /01J9Z3K4M5N6P7Q8R9S0T1V2XX/).length,
    0,
    "unknown channel",
  );
  // each later click is one more refresh
  m.retryNow(CH);
  await env.advance(0);
  assert.equal(seatsGets(), before + 2);
  m.dispose();
});

test("S2 retryNow: dropped while a refresh of the channel is in flight, and a double click is one refresh", async () => {
  const env = new Env();
  const m = make(env);
  await m.refresh(CH, "interval");
  await env.advance(0);
  const seatsGets = () => env.api$("GET", /^\/channels\/[^/]+\/seats$/).length;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let hold = true;
  env.routes.push((method, path, body) => {
    if (!hold || method !== "GET" || !/^\/channels\/[^/]+\/seats$/.test(path)) {
      return undefined;
    }
    hold = false;
    return gate.then(() =>
      defaultRoute(env)(method, path, body),
    ) as unknown as ReturnType<Route>;
  });
  const before = seatsGets();
  const running = m.refresh(CH, "interval");
  await flush();
  assert.equal(seatsGets(), before + 1, "the refresh waits on its GET");
  m.retryNow(CH);
  m.retryNow(CH);
  release();
  await running;
  await env.advance(0);
  assert.equal(seatsGets(), before + 1, "no second pass queued behind it");
  // settled: a double click in one tick is still ONE refresh
  m.retryNow(CH);
  m.retryNow(CH);
  await env.advance(0);
  assert.equal(seatsGets(), before + 2, "one refresh for the double click");
  m.dispose();
});

test("S2 (h): a server-reported id (non-v1, g > 63) is indexed in both indexes BEFORE the _join, and its Welcome lands in this channel", async () => {
  const GX = "ef".repeat(32);
  const env = joiningEnv();
  env.group = groupBody({ group_id: GX, generation: 70 });
  env.handlers.e2ee_text_process = (a) => {
    env.states.set(CH, st({ group_id: GX, generation: 70, epoch: 4 }));
    return outcome({
      kind: "welcome_joined",
      epoch: 4,
      group_id: a.envelope.group_id,
    });
  };
  const m = make(env);
  const p = m.ensureJoined(CH);
  await env.advance(0);
  assert.deepEqual(
    env.reported.find((r) => r[1] === GX),
    [CH, GX, 70],
  );
  const reported = env.trace.indexOf("reported " + GX);
  const joined = env.trace.indexOf("e2ee_text_join");
  assert.ok(reported >= 0 && joined > reported, "indexed before the join");
  assert.equal(env.calls("e2ee_text_join")[0]?.groupId, GX);
  m.onEnvelope(
    envelope("W70", 4, { content_type: "mls_welcome", group_id: GX }),
  );
  await env.advance(0);
  await p;
  assert.equal(env.views.get(CH)?.native?.group_id, GX);
  m.dispose();
});

test("S2 (h): a malformed reported id is logged and skipped; one mapped elsewhere is logged without ids and never re-routed", async () => {
  const env = new Env();
  // G0 is generation 0 of CH: native claiming generation 5 conflicts.
  env.states.set(CH, st({ generation: 5 }));
  env.group = groupBody({ group_id: "NOT-HEX", generation: 1 });
  const m = make(env);
  await m.refresh(CH, "open");
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] reported group id malformed" &&
        JSON.stringify(l.ids) ===
          JSON.stringify({ channelId: CH, source: "text_group" }),
    ),
  );
  const conflicts = env.logs.filter(
    (l) => l.msg === "[protected] reported group id conflict",
  );
  assert.ok(conflicts.length >= 1);
  assert.ok(
    conflicts.every(
      (l) => JSON.stringify(l.ids) === JSON.stringify({ source: "state" }),
    ),
    "no ids in a conflict log",
  );
  assert.deepEqual(
    env.reported.filter((r) => r[1] === "NOT-HEX" || r[2] === 5),
    [],
  );
  m.dispose();
});

test("S2 (i): owner_notice of a verify verdict or a process outcome sets view.ownerNotice and raises ONE owner_notice toast each; owner_alert is read from native state only; a malformed notice raises nothing", async () => {
  const env = new Env();
  const notice1: OwnerDeviceNotice = {
    kind: "changed_by_other",
    device_id: "dev-other",
    seated: [],
  };
  let withNotice = true;
  env.handlers.e2ee_text_seat_list_verify = () => ({
    status: "accepted",
    version: 1,
    seats: [OWNER, PEER, SELF],
    device_cap: 5,
    signer_user_id: OWNER,
    signer_device_id: OWNER_DEV,
    pinned_now: false,
    ...(withNotice ? { owner_notice: notice1 } : {}),
  });
  const m = make(env);
  await m.refresh(CH, "open");
  withNotice = false;
  assert.deepEqual(env.views.get(CH)?.ownerNotice, notice1);
  assert.deepEqual(env.notified, ["owner_notice"]);
  await m.refresh(CH, "interval");
  assert.deepEqual(env.notified, ["owner_notice"], "one-shot");
  assert.deepEqual(env.views.get(CH)?.ownerNotice, notice1, "the last one");
  const notice2: OwnerDeviceNotice = {
    kind: "seated_by_other",
    device_id: "dev-other",
    seated: [PEER],
  };
  env.handlers.e2ee_text_process = (a) =>
    outcome({ epoch: a.envelope.epoch, owner_notice: notice2 });
  m.onEnvelope(envelope("E4", 4));
  await env.advance(1_000);
  assert.deepEqual(env.views.get(CH)?.ownerNotice, notice2);
  assert.deepEqual(env.notified, ["owner_notice", "owner_notice"]);
  env.handlers.e2ee_text_process = (a) =>
    outcome({
      epoch: a.envelope.epoch,
      owner_notice: { kind: "bogus" } as unknown as OwnerDeviceNotice,
    });
  m.onEnvelope(envelope("E5", 5));
  await env.advance(1_000);
  assert.equal(env.notified.length, 2, "a malformed notice raises nothing");
  assert.ok(
    env.logs.some((l) => l.msg === "[protected] owner notice malformed"),
  );
  const alert: OwnerDeviceNotice = {
    kind: "dropped_this_device",
    device_id: DEV,
    seated: [],
  };
  env.states.set(CH, st({ epoch: 5, owner_alert: alert }));
  await m.refresh(CH, "interval");
  assert.deepEqual(env.views.get(CH)?.native?.owner_alert, alert);
  assert.equal(env.notified.length, 2, "an alert is not a toast");
  m.dispose();
});

test("S2 OR-10: a confirm that resolves but whose next verify is again owner_changed{same_user} for that device withholds Review for it until the list or pin changes", async () => {
  const OWNER2 = "dev-owner-2";
  const env = new Env();
  env.states.set(
    CH,
    st({
      verdict: "owner_changed",
      owner_pin: {
        ...st().owner_pin,
        status: "changed",
        pending_signer: {
          user_id: OWNER,
          device_id: OWNER2,
          same_user: true,
          verified: true,
        },
      },
    }),
  );
  env.handlers.e2ee_text_seat_list_verify = () => {
    throw {
      type: "owner_changed",
      channel_id: CH,
      signer_user_id: OWNER,
      signer_device_id: OWNER2,
      same_user: true,
      verified: true,
    };
  };
  const m = make(env);
  await m.refresh(CH, "open");
  assert.equal(env.views.get(CH)?.ownerChangePending, true);
  assert.equal(env.views.get(CH)?.ownerChangeUnlisted, false, "no confirm yet");
  await m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.equal(env.views.get(CH)?.ownerChangeUnlisted, true);
  await m.refresh(CH, "interval");
  assert.equal(env.views.get(CH)?.ownerChangeUnlisted, true, "kept");
  // A new list (version 2) offers Review again.
  env.seats = seatsBody({
    list: { ...seatsBody().list, version: 2, signature: "SIG2" },
  });
  await m.refresh(CH, "interval");
  assert.equal(env.views.get(CH)?.ownerChangeUnlisted, false);
  m.dispose();
});

test("S2 OR-5: a plain 2xx that removed devices reads the stored row through the won-row read and passes ITS labels to _commit_won; malformed labels park it, never []", async () => {
  const labels = [{ user_id: PEER, device_id: PEER_DEV, reason: "off_list" }];
  const removing = (env: Env) => {
    env.handlers.e2ee_text_remove = () => {
      const p = {
        ...commitPayload((env.state().epoch ?? 0) + 1, "REM"),
        removed: [{ user_id: PEER, device_id: PEER_DEV }],
      };
      env.pending = { epoch: p.epoch, commit_b64: p.commit };
      return p;
    };
  };
  const env = new Env();
  removing(env);
  env.dsLabels = labels;
  const m = make(env);
  await removeWith(env, m, null);
  assert.deepEqual(
    env.calls("e2ee_text_commit_won")[0]?.removedReasons,
    labels,
  );
  m.dispose();

  const env2 = new Env();
  removing(env2);
  env2.dsLabels = [{ user_id: PEER, reason: "off_list" }];
  const m2 = make(env2);
  await m2.refresh(CH, "open");
  const p = silence(
    m2.removeDevices(CH, [{ user_id: PEER, device_id: PEER_DEV }], {
      rejoinIntent: null,
    }),
  );
  await env2.advance(600_000);
  await assert.rejects(
    p,
    (e: { reason?: string }) => e.reason === "commit_parked",
  );
  assert.equal(env2.calls("e2ee_text_commit_won").length, 0);
  assert.equal(env2.api$("GET", /from_epoch=4$/).length, WON_ROW_READ_BUDGET);
  assert.ok(
    env2.logs.some(
      (l) =>
        l.msg === "[protected] won row labels malformed" &&
        JSON.stringify(l.ids) === JSON.stringify({ groupId: G0, epoch: 4 }),
    ),
  );
  m2.dispose();
});

test("S2-D36 input: resecuringSinceMs is stamped when the shield enters resecuring, kept while it stays, cleared when it leaves", async () => {
  const env = new Env();
  const m = make(env);
  await m.refresh(CH, "open");
  assert.equal(env.shield(), "protected");
  assert.equal(env.views.get(CH)?.resecuringSinceMs, null);
  env.group = groupBody({ current_epoch: 4 });
  const t0 = env.clock;
  await m.refresh(CH, "interval");
  assert.equal(env.shield(), "resecuring");
  assert.equal(env.views.get(CH)?.resecuringSinceMs, t0);
  await env.advance(30_000);
  await m.refresh(CH, "interval");
  assert.equal(env.views.get(CH)?.resecuringSinceMs, t0, "kept");
  env.group = groupBody();
  await m.refresh(CH, "interval");
  assert.equal(env.shield(), "protected");
  assert.equal(env.views.get(CH)?.resecuringSinceMs, null);
  m.dispose();
});

test("S2 D40: setSeats re-validates the reason (header rule) and hands the owner flow the sanitized value; an invalid one is refused first; authoritySign runs signOwnerDevices with the publish bookkeeping", async () => {
  const env = new Env();
  const seen: unknown[][] = [];
  let inFlight = false;
  const m = make(
    env,
    fakeDeps(env, {
      owner: {
        setSeats: async (...a: unknown[]) => {
          seen.push(a.slice(2));
        },
        signOwnerDevices: async (ops, _port, ch, devices) => {
          inFlight = ops.stateOf(ch)?.publishInFlight === true;
          seen.push(["sign", ch, devices]);
        },
      },
    }),
  );
  const raw = "  Spam " + String.fromCharCode(7);
  const clean = validReason(raw, "header");
  assert.ok(clean.ok);
  await m.setSeats(CH, [OWNER, SELF], 5);
  await m.setSeats(CH, [OWNER], 5, raw);
  for (const bad of ["   ", "x".repeat(513)]) {
    await assert.rejects(
      m.setSeats(CH, [OWNER], 5, bad),
      (e: { reason?: string }) => e.reason === "invalid_reason",
    );
  }
  assert.deepEqual(seen, [
    [CH, [OWNER, SELF], 5],
    [CH, [OWNER], 5, clean.ok ? clean.reason : null],
  ]);
  await m.authoritySign(CH, [OWNER_DEV, "dev-owner-2"]);
  assert.equal(inFlight, true);
  assert.deepEqual(seen.at(-1), ["sign", CH, [OWNER_DEV, "dev-owner-2"]]);
  assert.equal(env.views.get(CH)?.publishInFlight, false);
  m.dispose();
});

test("S2 F5: moveOwnerKey hands the owner flow the channel, the flow port and the target under the publish bookkeeping; a refusal reaches the caller", async () => {
  const env = new Env();
  const seen: unknown[][] = [];
  const inFlight: boolean[] = [];
  let refuse = false;
  const m = make(
    env,
    fakeDeps(env, {
      owner: {
        moveOwnerKey: async (ops, port, ch, to) => {
          inFlight.push(ops.stateOf(ch)?.publishInFlight === true);
          seen.push([ch, to, port.selfUserId]);
          if (refuse) throw { source: "client", reason: "not_signing_device" };
        },
      },
    }),
  );
  await m.moveOwnerKey(CH, "dev-owner-2");
  assert.deepEqual(seen, [[CH, "dev-owner-2", SELF]]);
  assert.equal(env.views.get(CH)?.publishInFlight, false);
  refuse = true;
  await assert.rejects(m.moveOwnerKey(CH, "dev-owner-3"), {
    source: "client",
    reason: "not_signing_device",
  });
  assert.deepEqual(seen.at(-1), [CH, "dev-owner-3", SELF]);
  assert.deepEqual(inFlight, [true, true]);
  assert.equal(env.views.get(CH)?.publishInFlight, false);
  m.dispose();
});

test("S2 F3: pendingSeats / cancelPendingSeats pass the channel and the flow port to the owner flows and return their answer; a discard re-emits the view", async () => {
  const env = new Env();
  const seen: unknown[][] = [];
  const pending = {
    kind: "owner_devices" as const,
    reasonRequired: true,
    discardable: true,
  };
  let answer: { discarded: true } | { discarded: false; why: "busy" } = {
    discarded: false,
    why: "busy",
  };
  const m = make(
    env,
    fakeDeps(env, {
      owner: {
        pendingSeats: (port, ch) => {
          seen.push(["pending", ch, port.selfUserId]);
          return pending;
        },
        cancelPendingSeats: (port, ch) => {
          seen.push(["cancel", ch, port.selfUserId]);
          return answer;
        },
      },
    }),
  );
  await m.refresh(CH, "open");
  assert.equal(m.pendingSeats(CH), pending);
  let emitted = 0;
  const views = env.views;
  const set = views.set.bind(views);
  views.set = (k, v) => {
    if (k === CH) emitted++;
    return set(k, v);
  };
  assert.deepEqual(m.cancelPendingSeats(CH), { discarded: false, why: "busy" });
  assert.equal(emitted, 0, "nothing discarded: no new view");
  answer = { discarded: true };
  assert.deepEqual(m.cancelPendingSeats(CH), { discarded: true });
  assert.equal(emitted, 1, "the discard re-emits the view");
  assert.deepEqual(seen, [
    ["pending", CH, SELF],
    ["cancel", CH, SELF],
    ["cancel", CH, SELF],
  ]);
  m.dispose();
});

test("Inherited L1s: InSlowmode on key_packages/claim holds admissions into that group until its retry_after; never a notice", async () => {
  const env = new Env();
  let claims = 0;
  env.routes.push((method, path) =>
    method === "POST" && path === "/mls/key_packages/claim" && ++claims === 1
      ? ok({ type: "InSlowmode", retry_after: 60 }, 429)
      : undefined,
  );
  const fresh = (signature: string) => ({
    ...joinRequest(signature),
    device_id: "dev-new",
  });
  const m = make(env);
  await m.refresh(CH, "open");
  m.onJoinRequest(fresh("A"), false);
  await env.advance(1_000);
  assert.equal(claims, 1);
  m.onJoinRequest(fresh("B"), false);
  await env.advance(30_000);
  assert.equal(claims, 1, "held inside retry_after");
  assert.equal(env.calls("e2ee_text_admit").length, 0);
  await env.advance(30_000);
  m.onJoinRequest(fresh("C"), false);
  await env.advance(1_000);
  assert.equal(claims, 2, "claimed after retry_after");
  assert.equal(env.calls("e2ee_text_admit").length, 1);
  assert.deepEqual(env.notified, []);
  m.dispose();
});

// ---------------------------------------------------------------------------
// S2-W4 fix lane FX-J: async Text join (S2-D28 re-broadcast + stored
// intents, S2-D29 stored Welcomes) and LOW-2. Tests named "FXJ ..." are the
// targets of /home/mcp/pc-logs/s2/w4/ctl/FXJ.
// ---------------------------------------------------------------------------

/** `member_added` listing this device at `epoch`. */
function addedAt(epoch: number) {
  return [{ user_id: SELF, device_id: DEV, epoch, at: "" }];
}

/** A stored join intent row (`text_group.join_requests`). */
function storedRequest(device_id: string, over: Record<string, unknown> = {}) {
  return {
    user_id: PEER,
    device_id,
    key_package_ref: `KPR-${device_id}`,
    signature: `SIG-${device_id}`,
    created_at: "2026-11-12T00:00:00Z",
    rejoin: false,
    ...over,
  };
}

/** A won Add puts the added devices in the roster, as native reports it. */
function rosterGrowsOnWin(env: Env) {
  env.handlers.e2ee_text_commit_won = (a) => {
    const s = env.state();
    s.epoch = a.wonEpoch;
    const row = env.rows.find(
      (r) => r.group_id === a.groupId && r.epoch === a.wonEpoch,
    );
    for (const d of row?.added ?? []) {
      s.members = [...s.members, mem(d.user_id, d.device_id)];
    }
    env.pending = null;
    return outcome({ epoch: a.wonEpoch, group_id: a.groupId });
  };
}

/** The device ids of every KeyPackage claim so far. */
function claimedDevices(env: Env) {
  return env
    .api$("POST", /claim$/)
    .map(
      (c) => (c.body as { targets: MlsMemberDevice[] }).targets[0].device_id,
    );
}

test("FXJ D28: the joiner re-broadcasts with backoff, 10 s doubling and held at 15 min, never giving up on silence", async () => {
  const env = joiningEnv();
  const m = make(env);
  let settled = false;
  m.ensureJoined(CH).then(
    () => (settled = true),
    () => (settled = true),
  );
  await env.advance(0);
  assert.equal(intents(env), 1);
  const waits = [
    10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 900_000, 900_000,
    900_000,
  ];
  for (let i = 0; i < waits.length; i++) {
    assert.deepEqual(
      env.sleeps.map((s) => s.at - env.clock),
      [waits[i]],
      `wait ${i}: one timer`,
    );
    await env.advance(waits[i] - 1);
    assert.equal(intents(env), i + 1, `not before ${waits[i]} ms`);
    await env.advance(1);
    assert.equal(intents(env), i + 2, `re-broadcast ${i + 1}`);
  }
  assert.equal(settled, false, "silence never ends the join");
  assert.equal(env.views.get(CH)?.welcomeRetriesExhausted, true);
  assert.deepEqual(env.explain(), {
    state: "resecuring",
    notice: "waiting_for_member",
  });
  m.dispose();
});

test("FXJ D28: one join timer per channel: ProtectedChannelChanged and open restart the backoff (the pending wait cut to its first step, never an extra intent at once), a Welcome clears the timer, dispose leaves none", async () => {
  const env = joiningEnv();
  env.handlers.e2ee_text_process = (a) => {
    env.states.set(CH, st({ epoch: 4 }));
    return outcome({
      kind: "welcome_joined",
      epoch: 4,
      group_id: a.envelope.group_id,
    });
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await env.advance(10_000 + 20_000 + 40_000);
  assert.equal(intents(env), 4);
  const pending = () =>
    env.sleeps.map((s) => s.at - env.clock).sort((a, b) => a - b);
  assert.deepEqual(pending(), [80_000]);
  m.onChannelChanged(CH, ["seats"]);
  await env.advance(CHANNEL_CHANGED_COALESCE_MS);
  assert.equal(intents(env), 4, "no extra intent at once");
  assert.deepEqual(pending(), [10_000], "the 80 s wait is cut to 10 s");
  await env.advance(10_000);
  assert.equal(intents(env), 5);
  assert.deepEqual(pending(), [10_000], "the backoff restarted");
  await env.advance(10_000);
  assert.equal(intents(env), 6);
  assert.deepEqual(pending(), [20_000]);
  await env.advance(5_000);
  await m.open(CH);
  await env.advance(0);
  assert.equal(intents(env), 6, "an open joins the running join");
  assert.deepEqual(pending(), [10_000, 60_000], "the join timer + interval");
  await env.advance(10_000);
  assert.equal(intents(env), 7, "the manual retry, 10 s on");
  assert.deepEqual(pending(), [10_000, 50_000]);
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(env.views.get(CH)?.native?.group_id, G0);
  assert.deepEqual(pending(), [50_000], "the Welcome cleared the join timer");
  m.dispose();
  await env.advance(0);
  assert.equal(env.sleeps.length, 0, "dispose leaves no timer");
});

test("FXJ D28: the re-broadcast stops when this device is unseated and on a verified failure (a loud error on the group it joins), which a refresh never restarts", async () => {
  // Settlement read through flags (never awaited: a join that wrongly keeps
  // going must fail this test, not hang it).
  const ended = (p: Promise<void>) => {
    const s: { done: boolean; err: unknown } = { done: false, err: null };
    p.then(
      () => (s.done = true),
      (e: unknown) => {
        s.done = true;
        s.err = e;
      },
    );
    return s;
  };
  const env = joiningEnv();
  const m = make(env);
  const p = ended(m.ensureJoined(CH));
  await env.advance(0);
  env.states.set(
    CH,
    noGroup(CH, {
      self_seated: false,
      verdict: "not_seated",
      seat_list: st().seat_list,
    }),
  );
  await env.advance(10_000);
  assert.equal(p.done, true, "unseated: the join ended");
  assert.deepEqual(p.err, {
    source: "native",
    error: { type: "not_seated", channel_id: CH },
  });
  await env.advance(3_600_000);
  assert.equal(intents(env), 1, "unseated: no further intent");
  assert.equal(env.sleeps.length, 0, "no timer left behind");
  m.dispose();

  const env2 = joiningEnv();
  processScript(env2, { E1: fail("commit_declaration_mismatch") });
  const m2 = make(env2);
  const p2 = ended(m2.ensureJoined(CH));
  await env2.advance(0);
  m2.onEnvelope(envelope("E1", 4));
  await env2.advance(10_000);
  assert.equal(p2.done, true, "a verified failure: the join ended");
  assert.deepEqual(p2.err, { source: "client", reason: "join_failed" });
  await m2.refresh(CH, "interval");
  await m2.open(CH);
  await env2.advance(3_600_000);
  assert.equal(intents(env2), 1, "a verified failure: no further intent");
  assert.equal(env2.shield(), "unverified");
  m2.dispose();
});

test("FXJ D29: member_added shows this device and no Welcome comes in 20 s: the stored Welcome of the server's current group is fetched once and goes to native's Welcome path, its synthetic id never acked", async () => {
  const env = joiningEnv();
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 4, welcome: "V0VMQ09NRQ" })),
  );
  env.handlers.e2ee_text_process = (a) => {
    env.states.set(CH, st({ epoch: 4 }));
    return outcome({
      kind: "welcome_joined",
      epoch: 4,
      group_id: a.envelope.group_id,
    });
  };
  const m = make(env);
  let joined = false;
  m.ensureJoined(CH).then(
    () => (joined = true),
    () => undefined,
  );
  await env.advance(0);
  env.group = groupBody({ member_added: addedAt(4) });
  // The first re-broadcast wait ends and the refresh sees the Add.
  await env.advance(joinRebroadcastDelayMs(0));
  await env.advance(WELCOME_FETCH_AFTER_MS - 1);
  assert.equal(welcomeGets(env).length, 0, "not before 20 s");
  await env.advance(1);
  assert.deepEqual(
    welcomeGets(env).map((c) => c.path),
    [`/mls/groups/${G0}/welcome?device_id=${DEV}`],
  );
  assert.equal(joined, true, "joined by that Welcome");
  assert.deepEqual(
    env.calls("e2ee_text_process").map((c) => c.envelope),
    [
      {
        id: `text-synth:welcome:${G0}:4`,
        content_type: "mls_welcome",
        group_id: G0,
        epoch: 4,
        ciphertext: "V0VMQ09NRQ",
      },
    ],
    "native's Welcome path, the bytes as served",
  );
  assert.deepEqual(env.acks, [], "a synthetic id is never acked");
  assert.equal(intents(env), 1, "no second intent");
  assert.equal(env.views.get(CH)?.native?.group_id, G0);
  await env.advance(600_000);
  assert.equal(welcomeGets(env).length, 1, "fetched once");
  m.dispose();
});

/**
 * FX-J2 NEW-1: the intent times (s) of a join whose first Add's ONE
 * Welcome path ends 30 s in (10 s wait + 20 s for the Welcome, an
 * immediate answer), with no later Add: the re-broadcast at once, then on
 * the backoff (20 s, 40 s, ... held at 15 min).
 */
const DONE_AT_30S_INTENTS_S = [
  0, 30, 50, 90, 170, 330, 650, 1290, 2190, 3090, 3990,
];

test("FXJ D29: a stored Welcome naming another group never reaches native; one native refuses joins nothing; that Add is fetched once and the joiner re-broadcasts its intent on the backoff (FX-J2 NEW-1)", async () => {
  const env = joiningEnv();
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G1, epoch: 4, welcome: "V0VM" })),
  );
  const m = make(env);
  const times = intentTimes(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ member_added: addedAt(4) });
  await env.advance(joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS - 1);
  assert.equal(intents(env), 1, "no intent while the Welcome is due");
  await env.advance(1);
  assert.equal(welcomeGets(env).length, 1);
  assert.equal(env.calls("e2ee_text_process").length, 0, "never to native");
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] stored welcome unavailable" &&
        l.ids.why === "wrong_group",
    ),
  );
  assert.equal(intents(env), 2, "that Add is done: the re-broadcast");
  await env.advance(4_000_000 - 30_000);
  assert.deepEqual(
    times.map((t) => t / 1_000),
    DONE_AT_30S_INTENTS_S,
    "on the backoff, never a tight loop",
  );
  assert.equal(welcomeGets(env).length, 1, "never fetched again");
  assert.equal(env.calls("e2ee_text_process").length, 0);
  m.dispose();

  const env2 = joiningEnv();
  env2.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 4, welcome: "V0VM" })),
  );
  env2.handlers.e2ee_text_process = () => {
    throw { type: "signer_leaf_missing", group_id: G0 };
  };
  const m2 = make(env2);
  const times2 = intentTimes(env2);
  let settled = false;
  m2.ensureJoined(CH).then(
    () => (settled = true),
    () => (settled = true),
  );
  await env2.advance(0);
  env2.group = groupBody({ member_added: addedAt(4) });
  await env2.advance(joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS);
  assert.equal(env2.calls("e2ee_text_process").length, 1, "native decided");
  assert.equal(settled, false, "nothing joined");
  assert.notEqual(env2.views.get(CH)?.native?.state, "active");
  assert.equal(env2.views.get(CH)?.signerLeafMissingRetries, 1, "6c counted");
  assert.equal(intents(env2), 2, "the rejoin path");
  await env2.advance(4_000_000 - 30_000);
  assert.deepEqual(
    times2.map((t) => t / 1_000),
    DONE_AT_30S_INTENTS_S,
  );
  assert.equal(welcomeGets(env2).length, 1, "not fetched again for that Add");
  assert.equal(env2.calls("e2ee_text_process").length, 1);
  assert.equal(settled, false, "silence never ends the join");
  m2.dispose();
});

test("FXJ D29: a 404 for the stored Welcome is that Add's ONE fetch and sends the rejoin intent; the joiner keeps re-broadcasting on the backoff while the server shows that Add, never refetching it; a new Add is a new fetch (FX-J2 NEW-1)", async () => {
  // The default courier answers the welcome GET 404 (unknown group).
  const env = joiningEnv();
  const m = make(env);
  const times = intentTimes(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ member_added: addedAt(4) });
  await env.advance(joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS);
  assert.equal(welcomeGets(env).length, 1);
  assert.equal(intents(env), 2, "the rejoin intent");
  assert.ok(
    env.logs.some((l) => l.msg === "[protected] stored welcome not found"),
  );
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] stored welcome path done: rejoin intent" &&
        l.ids.why === "rejoin",
    ),
  );
  // The existing intent path: a fresh `_join`, its package, then the intent.
  assert.equal(env.calls("e2ee_text_join").length, 2);
  assert.deepEqual(env.api$("POST", /join_intent$/)[1].body, intentBody(2));
  // The server still shows that Add: each re-broadcast refreshes the stored
  // intent (and its live MlsJoinRequested), on the backoff.
  await env.advance(3_600_000 - 30_000);
  assert.deepEqual(
    times.map((t) => t / 1_000),
    DONE_AT_30S_INTENTS_S.filter((s) => s < 3_600),
  );
  assert.equal(welcomeGets(env).length, 1, "never a refetch of that Add");
  assert.deepEqual(env.explain(), {
    state: "resecuring",
    notice: "waiting_for_member",
  });
  // Members acted on the rejoin: a new Add, again without a Welcome. The
  // event cuts the pending wait to 10 s (the first event reset).
  env.group = groupBody({ current_epoch: 6, member_added: addedAt(6) });
  m.onChannelChanged(CH, ["text_group"]);
  const before = intents(env);
  await env.advance(
    CHANNEL_CHANGED_COALESCE_MS +
      joinRebroadcastDelayMs(0) +
      WELCOME_FETCH_AFTER_MS -
      1,
  );
  assert.equal(intents(env), before, "none while the new Add's Welcome is due");
  await env.advance(1);
  assert.equal(welcomeGets(env).length, 2, "a new Add is a new fetch");
  assert.equal(intents(env), before + 1, "with its own rejoin");
  m.dispose();
});

test("FXJ D28: members admit from stored join_requests on open and on the 60 s refresh through the live handler: the seat check, a device already in the group skipped, a malformed entry dropped whole", async () => {
  const env = new Env();
  rosterGrowsOnWin(env);
  env.group = groupBody({
    join_requests: [
      storedRequest("dev-new", { generation: 0, issued_at: 1_700_000_000_000 }),
      storedRequest("dev-bad", { issued_at: 1.5 }),
      storedRequest("dev-x", { user_id: "USTRANGER" }),
      storedRequest(OWNER_DEV, { user_id: OWNER }),
    ],
  });
  const m = make(env);
  await m.open(CH);
  await env.advance(1_000);
  assert.deepEqual(claimedDevices(env), ["dev-new"]);
  assert.deepEqual(
    env.calls("e2ee_text_admit").map((a) => a.request),
    [
      {
        group_id: G0,
        channel_id: CH,
        user_id: PEER,
        device_id: "dev-new",
        key_package_ref: "KPR-dev-new",
        signature: "SIG-dev-new",
        generation: 0,
        issued_at: 1_700_000_000_000,
      },
    ],
    "the live request shape: no created_at, no rejoin key",
  );
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] malformed stored join requests dropped" &&
        l.ids.count === 1,
    ),
  );
  assert.ok(
    env.logs.some(
      (l) => l.msg === "[protected] join request from an unseated user",
    ),
    "the seat check ran for the stranger",
  );
  // The 60 s refresh admits what was stored since; dev-new is in the group.
  env.group = groupBody({
    join_requests: [storedRequest("dev-new"), storedRequest("dev-later")],
  });
  await env.advance(60_000);
  assert.deepEqual(claimedDevices(env), ["dev-new", "dev-later"]);
  // A commit refresh does not sweep (only STORED_ADMIT_REASONS do).
  env.group = groupBody({ join_requests: [storedRequest("dev-commit")] });
  await m.refresh(CH, "commit");
  await env.advance(1_000);
  assert.deepEqual(claimedDevices(env), ["dev-new", "dev-later"]);
  m.dispose();
});

test("FXJ D28: a stored intent that is also live is admitted once", async () => {
  const env = new Env();
  rosterGrowsOnWin(env);
  env.group = groupBody({ join_requests: [storedRequest("dev-new")] });
  const m = make(env);
  await m.refresh(CH, "commit");
  await env.advance(0);
  m.onJoinRequest(
    {
      ...joinRequest("SIG-dev-new"),
      device_id: "dev-new",
      key_package_ref: "KPR-dev-new",
    },
    false,
  );
  await m.refresh(CH, "interval");
  await env.advance(1_000);
  await m.refresh(CH, "interval");
  await env.advance(1_000);
  assert.deepEqual(claimedDevices(env), ["dev-new"]);
  assert.equal(env.calls("e2ee_text_admit").length, 1);
  m.dispose();
});

test("FXJ LOW-2: an outcome naming an unregistered channel is dropped and logged, never routed by its group id; native's generation of a joined group decides a sticky clear", async () => {
  const OTHER = "01J9Z3K4M5N6P7Q8R9S0T1V2XX";
  const env = new Env();
  processScript(env, {
    W: () => outcome({ kind: "welcome_joined", channel_id: OTHER, epoch: 4 }),
  });
  const m = make(env);
  await m.refresh(CH, "commit");
  await env.advance(1_000);
  const before = env.trace.length;
  m.onEnvelope(envelope("W", 4, { content_type: "mls_welcome" }));
  await env.advance(1_000);
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] outcome for an unregistered channel dropped" &&
        l.ids.channelId === OTHER &&
        l.ids.groupId === G0,
    ),
  );
  assert.deepEqual(
    env.trace.slice(before),
    ["e2ee_text_process"],
    "nothing ran for the group's channel",
  );
  m.dispose();

  // The server reported GX first (generation 5); native joins it at 0.
  const GX = "ab".repeat(32);
  const tag = "commit_declaration_mismatch";
  const env2 = new Env();
  env2.group = null;
  env2.seats = seatsBody({ as_of_group_id: GX, as_of_generation: 5 });
  const joined = (generation: number, epoch: number) => () => {
    env2.states.set(CH, st({ group_id: GX, generation, epoch }));
    return outcome({ kind: "welcome_joined", group_id: GX, epoch });
  };
  // FX-R: W1 at epoch 3. The fixture keeps GX for both generations, and
  // W0's prompt Update already takes native to GX epoch 2, so a GX Welcome
  // at 2 is a copy native holds (acked and dropped, addition 5).
  processScript(env2, { E1: fail(tag), W0: joined(0, 1), W1: joined(1, 3) });
  const m2 = make(env2);
  await m2.refresh(CH, "commit");
  await env2.advance(0);
  m2.onEnvelope(envelope("E1", 4));
  await env2.advance(0);
  assert.equal(env2.views.get(CH)?.groupError, tag);
  const w = { content_type: "mls_welcome" as const, group_id: GX };
  m2.onEnvelope(envelope("W0", 1, w));
  await env2.advance(0);
  assert.equal(
    env2.views.get(CH)?.groupError,
    tag,
    "native says generation 0: kept, whatever the server reported first",
  );
  m2.onEnvelope(envelope("W1", 3, w));
  await env2.advance(0);
  assert.equal(env2.views.get(CH)?.groupError, null, "native says 1: cleared");
  m2.dispose();
});

// ---------------------------------------------------------------------------
// FX-R: recovery same bytes (MEDIUM-1, manager side); duplicate Welcome
// ---------------------------------------------------------------------------

/** Settlement read through flags: a call that wrongly hangs fails, never stalls. */
function settledOf(p: Promise<unknown>) {
  const s: { done: boolean; err: unknown } = { done: false, err: undefined };
  p.then(
    () => (s.done = true),
    (e: unknown) => {
      s.done = true;
      s.err = e;
    },
  );
  return s;
}

test("FXR recovery (manager): a failed recovery keeps the signed list; the next click re-sends the SAME bytes with no second dialog or successor; every call, a failed one too, ends in a refresh", async () => {
  _resetOwnerFlowsForTest();
  const LOST = "dev-lost";
  const lostList = {
    ...st().seat_list!,
    signer_user_id: SELF,
    signer_device_id: LOST,
  };
  const signerLost = {
    user_id: SELF,
    device_id: LOST,
    cause: "device_revoked",
    at: "",
  };
  const signed = {
    version: 2,
    body: "sloga-seat-list-v1\nR",
    signature: "RSIG",
    signer_user_id: SELF,
    signer_device_id: DEV,
  };
  const env = new Env();
  env.states.set(CH, st({ seat_list: lostList }));
  env.group = groupBody({
    members: [
      { user_id: OWNER, device_id: OWNER_DEV },
      { user_id: PEER, device_id: PEER_DEV },
    ],
    signer_lost: signerLost,
  });
  env.handlers.e2ee_text_seat_list_sign = () => signed;
  let failing = RECOVERY_PUT_RETRY_BUDGET + 1;
  env.routes.push((method, path) => {
    if (method === "POST" && path === "/mls/groups") {
      // The server opens the successor with this device's leaf.
      env.group = groupBody({
        group_id: G1,
        generation: 1,
        members: [{ user_id: SELF, device_id: DEV }],
        signer_lost: signerLost,
      });
      return undefined;
    }
    if (method === "PUT" && path === "/channels/" + CH + "/seats") {
      return failing-- > 0
        ? ok({ type: "InternalError" }, 503)
        : ok(seatsBody());
    }
    return undefined;
  });
  const PUT = "PUT /channels/" + CH + "/seats";
  const GROUP_GET = "GET /mls/channels/" + CH + "/text_group";
  const refreshedAfterLastPut = () =>
    env.trace.indexOf(GROUP_GET, env.trace.lastIndexOf(PUT)) >= 0;
  const m = make(env);
  await m.refresh(CH, "open");

  const first = settledOf(m.recoverOwnership(CH));
  await env.advance(3_600_000);
  assert.equal(first.done, true, "the first call ended");
  assert.equal((first.err as { status?: number })?.status, 503);
  const puts1 = env.api$("PUT", /\/seats$/);
  assert.equal(puts1.length, RECOVERY_PUT_RETRY_BUDGET + 1);
  assert.equal(env.calls("e2ee_text_seat_list_sign").length, 1);
  assert.equal(env.calls("e2ee_text_group_create").length, 1);
  const kept = env.storeMap.get(publishStoreKey(SELF, CH));
  assert.ok(kept, "the signed list stays stored");
  assert.equal(JSON.parse(kept).recovery, true);
  assert.ok(refreshedAfterLastPut(), "a failed call still ends in a refresh");
  assert.equal(env.views.get(CH)?.publishInFlight, false);

  const second = settledOf(m.recoverOwnership(CH));
  await env.advance(60_000);
  assert.equal(second.done, true, "the second call ended");
  assert.equal(second.err, undefined);
  assert.equal(
    env.calls("e2ee_text_seat_list_sign").length,
    1,
    "no 2nd dialog",
  );
  assert.equal(env.calls("e2ee_text_group_create").length, 1, "no 2nd create");
  const puts2 = env.api$("PUT", /\/seats$/);
  assert.equal(puts2.length, RECOVERY_PUT_RETRY_BUDGET + 2);
  for (const p of puts2) assert.deepEqual(p.body, puts1[0].body, "SAME bytes");
  assert.equal(env.storeMap.has(publishStoreKey(SELF, CH)), false, "resolved");
  assert.ok(refreshedAfterLastPut(), "and the success too");
  m.dispose();
  _resetOwnerFlowsForTest();
});

test("FXR: the mailbox copy of a Welcome already processed from the stored fetch is acked and dropped: no native call, no toast", async () => {
  const env = joiningEnv();
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 4, welcome: "V0VMQ09NRQ" })),
  );
  let refuse = false;
  env.handlers.e2ee_text_process = (a) => {
    // Native refuses a second copy of the same Welcome as unsolicited.
    if (refuse) throw { type: "mls_unsolicited_welcome", group_id: G0 };
    env.states.set(CH, st({ epoch: 4 }));
    return outcome({
      kind: "welcome_joined",
      epoch: 4,
      group_id: a.envelope.group_id,
    });
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ member_added: addedAt(4) });
  await env.advance(joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS);
  assert.equal(welcomeGets(env).length, 1);
  assert.equal(env.calls("e2ee_text_process").length, 1, "the fetched copy");
  assert.equal(env.views.get(CH)?.native?.group_id, G0);
  refuse = true;
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_process").length, 1, "never to native");
  assert.deepEqual(env.notified, [], "no red toast");
  assert.equal(env.acks.filter((id) => id === "W1").length, 1, "acked");
  assert.ok(
    env.logs.some((l) => l.msg === "[protected] duplicate welcome dropped"),
  );
  m.dispose();
});

test("FXR: only a Welcome for the group native holds, active, at or past its epoch is dropped; another group, a later epoch or a group not held still reaches native (refusal and toast as before)", async () => {
  const refuse: Handlers["e2ee_text_process"] = (a) => {
    throw { type: "mls_unsolicited_welcome", group_id: a.envelope.group_id };
  };
  const welcome = { content_type: "mls_welcome" as const };
  const processed = (env: Env) =>
    env.calls("e2ee_text_process").map((c) => c.envelope.id);

  // Native holds G0, active, at epoch 3 (the default state).
  const env = new Env();
  env.handlers.e2ee_text_process = refuse;
  const m = make(env);
  await m.refresh(CH, "commit");
  await env.advance(0);
  m.onEnvelope(envelope("W3", 3, welcome));
  m.onEnvelope(envelope("W2", 2, welcome));
  await env.advance(0);
  assert.deepEqual(processed(env), [], "at or below the held epoch");
  assert.deepEqual(env.notified, []);
  assert.deepEqual([...env.acks].sort(), ["W2", "W3"]);
  m.onEnvelope(envelope("W4", 4, welcome));
  m.onEnvelope(envelope("WG1", 0, { ...welcome, group_id: G1 }));
  await env.advance(0);
  assert.deepEqual(processed(env).sort(), ["W4", "WG1"], "native decides");
  assert.deepEqual(env.notified, [
    "unsolicited_welcome",
    "unsolicited_welcome",
  ]);
  m.dispose();

  // The group is no longer held (left): native decides.
  const env2 = new Env();
  env2.states.set(CH, st({ state: "left", verdict: "no_group" }));
  env2.handlers.e2ee_text_process = refuse;
  const m2 = make(env2);
  await m2.refresh(CH, "commit");
  await env2.advance(0);
  m2.onEnvelope(envelope("WL", 3, welcome));
  await env2.advance(0);
  assert.deepEqual(processed(env2), ["WL"]);
  assert.deepEqual(env2.notified, ["unsolicited_welcome"]);
  m2.dispose();
});

// ---------------------------------------------------------------------------
// S2-W4 fix lane FX-J2 (re-review NEW-1, NEW-2, NEW-3, NEW-5). Tests named
// "FXJ2 ..." are the targets of /home/mcp/pc-logs/s2/w4/ctl/FXJ2.
// ---------------------------------------------------------------------------

/** Settlement read through flags (a join that wrongly goes on never hangs). */
function endedOf(p: Promise<unknown>) {
  const s: { done: boolean; err: unknown } = { done: false, err: null };
  p.then(
    () => (s.done = true),
    (e: unknown) => {
      s.done = true;
      s.err = e;
    },
  );
  return s;
}

test("FXJ2 NEW-1: a fetched Welcome native discards with signer_leaf_missing counts toward 6c; each rejoin brings a new Add and its one fetch; at the budget the join ends in the verified red", async () => {
  const env = joiningEnv();
  let epoch = 4;
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch, welcome: "V0VM" })),
  );
  env.handlers.e2ee_text_process = () => {
    throw { type: "signer_leaf_missing", group_id: G0 };
  };
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ member_added: addedAt(4) });
  // 10 s wait, 20 s for the Welcome, the fetch: discarded, the rejoin.
  await env.advance(30_000);
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 1);
  assert.equal(intents(env), 2);
  // Members acted on it: a new Add (20 s backoff, 20 s for the Welcome).
  epoch = 6;
  env.group = groupBody({ current_epoch: 6, member_added: addedAt(6) });
  await env.advance(40_000);
  assert.equal(welcomeGets(env).length, 2);
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 2);
  assert.equal(intents(env), 3);
  assert.equal(p.done, false, "below the budget the join goes on");
  epoch = 8;
  env.group = groupBody({ current_epoch: 8, member_added: addedAt(8) });
  await env.advance(60_000);
  assert.equal(welcomeGets(env).length, 3);
  assert.equal(
    env.views.get(CH)?.signerLeafMissingRetries,
    SIGNER_LEAF_MISSING_BUDGET,
  );
  assert.equal(p.done, true, "the verified failure ends the join");
  assert.deepEqual(p.err, { source: "client", reason: "join_failed" });
  assert.equal(env.shield(), "unverified", "9.1 6c");
  await m.refresh(CH, "interval");
  await env.advance(3_600_000);
  assert.equal(intents(env), 3, "no intent after the verified red");
  assert.equal(welcomeGets(env).length, 3);
  m.dispose();
});

test("FXJ2 NEW-1: a busy native on a fetched Welcome (a synthetic hold is never retried) takes the rejoin path, never counted toward 6c; the next Add's Welcome joins", async () => {
  const env = joiningEnv();
  let epoch = 4;
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch, welcome: "V0VM" })),
  );
  let busy = true;
  env.handlers.e2ee_text_process = (a) => {
    if (busy) {
      busy = false;
      throw { type: "busy" };
    }
    env.states.set(CH, st({ epoch: a.envelope.epoch }));
    return outcome({
      kind: "welcome_joined",
      epoch: a.envelope.epoch,
      group_id: a.envelope.group_id,
    });
  };
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ member_added: addedAt(4) });
  await env.advance(30_000);
  assert.equal(env.calls("e2ee_text_process").length, 1, "native was busy");
  assert.equal(intents(env), 2, "the rejoin path, not stranded");
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 0, "not 6c");
  assert.equal(p.done, false);
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] stored welcome path done: rejoin intent" &&
        l.ids.why === "held",
    ),
  );
  epoch = 6;
  env.group = groupBody({ current_epoch: 6, member_added: addedAt(6) });
  await env.advance(40_000);
  assert.equal(welcomeGets(env).length, 2, "the new Add's one fetch");
  assert.equal(p.done, true);
  assert.equal(p.err, null, "joined");
  assert.equal(env.views.get(CH)?.native?.group_id, G0);
  assert.equal(env.views.get(CH)?.native?.state, "active");
  assert.equal(intents(env), 2);
  m.dispose();
});

test("FXJ2 NEW-2: a storm of ProtectedChannelChanged restarts the join backoff at most once per 15 min window; a busy or hostile server never holds the joiner at the first step", async () => {
  const env = joiningEnv();
  const m = make(env);
  const times = intentTimes(env);
  silence(m.ensureJoined(CH));
  await env.advance(1_000);
  // An event every 5 s for 30 min (each coalesced 250 ms).
  for (let i = 0; i < 360; i++) {
    m.onChannelChanged(CH, ["seats"]);
    await env.advance(5_000);
  }
  // The first event (1.25 s) restarts the backoff; the next one honoured
  // is 15 min later (901.25 s), which cuts the pending 640 s wait.
  assert.deepEqual(
    times,
    [
      0, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 911_250,
      921_250, 941_250, 981_250, 1_061_250, 1_221_250, 1_541_250,
    ],
  );
  m.dispose();
});

test("FXJ2 NEW-2: fabricated member_added epochs on every event never buy a rejoin or a stored-Welcome fetch faster than the backoff", async () => {
  const env = joiningEnv();
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(1_000);
  for (let i = 0; i < 360; i++) {
    const e = 4 + i;
    env.group = groupBody({ current_epoch: e, member_added: addedAt(e) });
    m.onChannelChanged(CH, ["text_group"]);
    await env.advance(5_000);
  }
  // The plain backoff allows 15 intents in this window (the storm test
  // above); a new Add each time buys neither more intents nor a fetch per
  // event: after one Add's path, a newer Add waits a backoff step first.
  assert.ok(intents(env) <= 15, `intents ${intents(env)}`);
  const fetches = welcomeGets(env).length;
  assert.ok(fetches <= 15, `fetches ${fetches}`);
  assert.ok(fetches >= 1, "the Welcome path still runs");
  m.dispose();
});

test("FXJ2 NEW-3: a stored request native _admit refuses is never claimed again from the stored list this session; a busy answer is claimed again; a new KeyPackage ref is a new request", async () => {
  const env = new Env();
  env.handlers.e2ee_text_admit = () => {
    throw { type: "mls_leaf_rejected", reason: "bad_binding_signature" };
  };
  env.group = groupBody({ join_requests: [storedRequest("dev-bad")] });
  const m = make(env);
  await m.open(CH);
  await env.advance(1_000);
  assert.deepEqual(claimedDevices(env), ["dev-bad"]);
  assert.equal(env.calls("e2ee_text_admit").length, 1);
  // Two 60 s sweeps: the refused request is skipped (no claim burned).
  await env.advance(120_000);
  assert.deepEqual(claimedDevices(env), ["dev-bad"], "never claimed again");
  assert.equal(env.calls("e2ee_text_admit").length, 1);
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] refused stored join requests skipped" &&
        l.ids.count === 1,
    ),
  );
  // A re-broadcast mints a new KeyPackage: a new request.
  env.group = groupBody({
    join_requests: [
      storedRequest("dev-bad", { key_package_ref: "KPR-dev-bad-2" }),
    ],
  });
  await env.advance(60_000);
  assert.deepEqual(claimedDevices(env), ["dev-bad", "dev-bad"]);
  m.dispose();

  const env2 = new Env();
  rosterGrowsOnWin(env2);
  const admit = env2.handlers.e2ee_text_admit!;
  let busy = true;
  env2.handlers.e2ee_text_admit = (a) => {
    if (busy) {
      busy = false;
      throw { type: "busy" };
    }
    return admit(a);
  };
  env2.group = groupBody({ join_requests: [storedRequest("dev-new")] });
  const m2 = make(env2);
  await m2.open(CH);
  await env2.advance(61_000);
  assert.deepEqual(
    claimedDevices(env2),
    ["dev-new", "dev-new"],
    "busy is not a refusal",
  );
  assert.equal(env2.calls("e2ee_text_admit").length, 2);
  await env2.advance(60_000);
  assert.deepEqual(claimedDevices(env2), ["dev-new", "dev-new"], "admitted");
  m2.dispose();
});

test("FXJ2 NEW-5: a stored-admit refresh that coalesces into a running commit refresh re-runs with the stored-admit reason (a reconnect sweep is never absorbed)", async () => {
  const env = new Env();
  rosterGrowsOnWin(env);
  env.group = groupBody({ join_requests: [storedRequest("dev-new")] });
  const verify = env.handlers.e2ee_text_seat_list_verify!;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let gated = true;
  env.handlers.e2ee_text_seat_list_verify = async (a) => {
    if (gated) await gate;
    return verify(a);
  };
  const m = make(env);
  const running = m.refresh(CH, "commit");
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_seat_list_verify").length, 1, "running");
  const reconnect = m.refresh(CH, "interval");
  await env.advance(0);
  gated = false;
  release();
  await running;
  await reconnect;
  await env.advance(1_000);
  assert.ok(env.calls("e2ee_text_seat_list_verify").length >= 2, "re-run");
  assert.deepEqual(claimedDevices(env), ["dev-new"], "the re-run admitted");
  m.dispose();
});

// ---------------------------------------------------------------------------
// S2 final audit fix lane FXF (MAJOR: the 6c budget is bound to its group
// and signer and starts over on an open or a retryNow; MINOR: a parked
// Welcome keeps its Add pending). Tests named "FXF ..." are the targets of
// /home/mcp/pc-logs/s2/w4/ctl/FXF.
// ---------------------------------------------------------------------------

const OWNER_DEV2 = "dev-owner-2";

/** Native's D15 answer while a same-user signer change is unconfirmed. */
const OWNER_CHANGED = {
  type: "owner_changed",
  channel_id: CH,
  signer_user_id: OWNER,
  signer_device_id: OWNER_DEV2,
  same_user: true,
  verified: true,
};

/**
 * FXF: drives a joiner into the 9.1 6c red on G0 (the FXJ2 NEW-1 path:
 * three fetched Welcomes discarded with `signer_leaf_missing`, as native
 * step 8 answers when the list signer resolves to Revoked). A Welcome for
 * any other group goes to `other`.
 */
async function reachSixC(env: Env, other?: Handlers["e2ee_text_process"]) {
  let epoch = 4;
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch, welcome: "V0VM" })),
  );
  env.handlers.e2ee_text_process = (a) => {
    if (a.envelope.group_id === G0) {
      throw { type: "signer_leaf_missing", group_id: G0 };
    }
    if (other) return other(a);
    env.states.set(
      CH,
      st({ group_id: G1, generation: 1, epoch: a.envelope.epoch }),
    );
    return outcome({
      kind: "welcome_joined",
      epoch: a.envelope.epoch,
      group_id: a.envelope.group_id,
    });
  };
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  for (const e of [4, 6, 8]) {
    epoch = e;
    env.group = groupBody({ current_epoch: e, member_added: addedAt(e) });
    await env.advance(5 * 60_000);
  }
  assert.equal(
    env.views.get(CH)?.signerLeafMissingRetries,
    SIGNER_LEAF_MISSING_BUDGET,
  );
  assert.deepEqual(p.err, { source: "client", reason: "join_failed" });
  assert.equal(env.shield(), "unverified");
  assert.equal(env.explain()?.notice, "join_stalled", "9.1 6c");
  return m;
}

/** The group id each intent so far was posted to. */
function intentGroups(env: Env) {
  return env.api$("POST", /join_intent$/).map((c) => c.path.split("/")[3]);
}

test("FXF 6c: the verified red is bound to the group it was spent on: a successor group appears, the joiner leaves the red and joins it without a restart", async () => {
  const env = joiningEnv();
  const m = await reachSixC(env);
  const before = intents(env);
  // The owner recovered: the server names a successor (generation 1).
  env.group = groupBody({
    group_id: G1,
    generation: 1,
    current_epoch: 0,
    members: [{ user_id: OWNER, device_id: OWNER_DEV }],
  });
  await m.refresh(CH, "interval");
  await env.advance(0);
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 0, "reset");
  assert.notEqual(env.explain()?.notice, "join_stalled");
  assert.equal(intents(env), before + 1, "the successor is joined");
  assert.equal(intentGroups(env).at(-1), G1);
  m.onEnvelope(
    envelope("W1", 1, { content_type: "mls_welcome", group_id: G1 }),
  );
  await env.advance(0);
  assert.equal(env.views.get(CH)?.native?.group_id, G1);
  assert.equal(env.views.get(CH)?.native?.state, "active");
  assert.notEqual(env.shield(), "unverified");
  m.dispose();
});

test("FXF 6c: a background refresh (the interval, ProtectedChannelChanged) keeps the verified red and sends nothing; reopening the channel starts the budget and the join over; three more failures on the same group are red again", async () => {
  const env = joiningEnv();
  const m = await reachSixC(env);
  const before = intents(env);
  await m.refresh(CH, "interval");
  m.onChannelChanged(CH, ["seats", "text_group"]);
  await env.advance(3_600_000);
  assert.equal(intents(env), before, "no intent after the verified red");
  assert.equal(
    env.views.get(CH)?.signerLeafMissingRetries,
    SIGNER_LEAF_MISSING_BUDGET,
  );
  assert.equal(env.explain()?.notice, "join_stalled", "still red");
  // "Try opening the channel again": the open starts it over.
  await m.open(CH);
  await env.advance(0);
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 0);
  assert.notEqual(env.explain()?.notice, "join_stalled");
  assert.equal(intents(env), before + 1, "the join restarts");
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] join stall budget reset" && l.ids.why === "open",
    ),
  );
  // The red is still reachable on the same group (the 60 s interval runs).
  for (const e of [10, 12, 14]) {
    env.group = groupBody({ current_epoch: e, member_added: addedAt(e) });
    await env.advance(5 * 60_000);
  }
  assert.equal(
    env.views.get(CH)?.signerLeafMissingRetries,
    SIGNER_LEAF_MISSING_BUDGET,
  );
  assert.equal(env.explain()?.notice, "join_stalled", "red again");
  const after = intents(env);
  await env.advance(3_600_000);
  assert.equal(intents(env), after, "and it ends the join again");
  m.dispose();
});

test("FXF 6c: a manual retry (retryNow) starts the budget and the join over after the verified red", async () => {
  const env = joiningEnv();
  const m = await reachSixC(env);
  const before = intents(env);
  m.retryNow(CH);
  await env.advance(0);
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 0);
  assert.notEqual(env.explain()?.notice, "join_stalled");
  assert.equal(intents(env), before + 1, "the join restarts");
  assert.equal(intentGroups(env).at(-1), G0);
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] join stall budget reset" &&
        l.ids.why === "manual",
    ),
  );
  m.dispose();
});

test("FXF 6c (S2-D17d): the list signer is revoked and the joiner goes red; the owner recovers (a successor group, a list from the new signer device); the owner change is confirmed; the joiner joins without a restart and never re-broadcasts while the Welcome waits for the confirm", async () => {
  const env = joiningEnv();
  let confirmed = false;
  const newList = {
    ...st().seat_list!,
    version: 2,
    signer_device_id: OWNER_DEV2,
  };
  // Simulated native: a G1 Welcome parks (D15) until the confirm.
  const m = await reachSixC(env, (a) => {
    if (!confirmed) throw OWNER_CHANGED;
    env.states.set(
      CH,
      st({
        group_id: G1,
        generation: 1,
        epoch: a.envelope.epoch,
        seat_list: newList,
      }),
    );
    return outcome({
      kind: "welcome_joined",
      epoch: a.envelope.epoch,
      group_id: a.envelope.group_id,
    });
  });
  // Simulated recovery (FXR, owner side): successor G1, list v2 signed by
  // the owner's new device; this device's native has not adopted it yet.
  env.group = groupBody({
    group_id: G1,
    generation: 1,
    current_epoch: 0,
    members: [{ user_id: OWNER, device_id: OWNER_DEV2 }],
  });
  env.seats = seatsBody({
    list: {
      ...seatsBody().list,
      version: 2,
      signature: "SIG2",
      signer_device_id: OWNER_DEV2,
    },
    as_of_group_id: G1,
    as_of_epoch: 0,
  });
  env.handlers.e2ee_text_seat_list_verify = () => {
    if (!confirmed) throw OWNER_CHANGED;
    return {
      status: "accepted",
      version: 2,
      seats: [OWNER, PEER, SELF],
      device_cap: 5,
      signer_user_id: OWNER,
      signer_device_id: OWNER_DEV2,
      pinned_now: false,
    };
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    env.state().seat_list = newList;
    return null;
  };
  m.onChannelChanged(CH, ["seats", "text_group"]);
  await env.advance(1_000);
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 0, "new group");
  assert.notEqual(env.explain()?.notice, "join_stalled");
  assert.equal(env.views.get(CH)?.ownerChangePending, true);
  assert.equal(intentGroups(env).at(-1), G1, "joins the successor");
  // The new signer device admits it; its Welcome parks behind the change.
  env.group = groupBody({
    group_id: G1,
    generation: 1,
    current_epoch: 1,
    members: [{ user_id: OWNER, device_id: OWNER_DEV2 }],
    member_added: addedAt(1),
  });
  m.onEnvelope(
    envelope("W1", 1, { content_type: "mls_welcome", group_id: G1 }),
  );
  await env.advance(0);
  const parkedAt = intents(env);
  const fetches = welcomeGets(env).length;
  await env.advance(6 * 3_600_000);
  assert.equal(intents(env), parkedAt, "no re-broadcast while parked");
  assert.equal(welcomeGets(env).length, fetches, "no fetch while parked");
  assert.equal(env.acks.includes("W1"), false, "parked, unacked");
  await m.confirmOwnerChange(CH);
  await env.advance(15_000);
  assert.equal(env.views.get(CH)?.native?.group_id, G1);
  assert.equal(env.views.get(CH)?.native?.state, "active");
  assert.equal(env.views.get(CH)?.ownerChangePending, false);
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 0);
  assert.notEqual(env.shield(), "unverified");
  assert.equal(intents(env), parkedAt, "joined from the parked Welcome");
  m.dispose();
});

test("FXF parked Welcome: a stored Welcome parked behind an owner change keeps its Add pending: no intent re-broadcast, no second fetch, nothing re-parked, until the confirm joins it", async () => {
  const env = joiningEnv();
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 4, welcome: "V0VM" })),
  );
  let confirmed = false;
  env.handlers.e2ee_text_process = (a) => {
    if (!confirmed) throw OWNER_CHANGED;
    env.states.set(CH, st({ epoch: a.envelope.epoch }));
    return outcome({
      kind: "welcome_joined",
      epoch: a.envelope.epoch,
      group_id: a.envelope.group_id,
    });
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    return null;
  };
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ member_added: addedAt(4) });
  // 10 s wait, 20 s for the Welcome, the fetch: parked.
  await env.advance(30_000);
  assert.equal(welcomeGets(env).length, 1);
  assert.equal(env.calls("e2ee_text_process").length, 1, "parked");
  assert.equal(env.views.get(CH)?.ownerChangePending, true);
  assert.equal(intents(env), 1, "the Add is pending: no rejoin intent");
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg ===
          "[protected] stored welcome parked: join waits for the owner change" &&
        l.ids.why === "parked",
    ),
  );
  await env.advance(24 * 3_600_000);
  assert.equal(intents(env), 1, "no re-broadcast while parked");
  assert.equal(welcomeGets(env).length, 1, "no second fetch");
  assert.equal(
    env.calls("e2ee_text_process").length,
    1,
    "nothing re-processed or re-parked",
  );
  assert.equal(p.done, false, "the join waits");
  await m.confirmOwnerChange(CH);
  await env.advance(0);
  const ids = env.calls("e2ee_text_process").map((c) => c.envelope.id);
  assert.equal(ids.length, 2, "the parked Welcome, once more");
  assert.equal(ids[1], ids[0]);
  assert.ok(ids[0].endsWith(`welcome:${G0}:4`), ids[0]);
  assert.equal(p.done, true);
  assert.equal(p.err, null, "joined");
  assert.equal(env.views.get(CH)?.native?.state, "active");
  assert.equal(intents(env), 1);
  m.dispose();
});

test("FXF parked Welcome: after the confirm only the latest parked Welcome for the server's current group reaches native; older ones and another group's are acked and dropped, never replayed", async () => {
  const env = joiningEnv();
  env.group = groupBody({ group_id: G1, generation: 1, current_epoch: 5 });
  let confirmed = false;
  env.handlers.e2ee_text_process = (a) => {
    if (!confirmed) throw OWNER_CHANGED;
    if (a.envelope.content_type === "mls_welcome") {
      env.states.set(
        CH,
        st({ group_id: G1, generation: 1, epoch: a.envelope.epoch }),
      );
      return outcome({
        kind: "welcome_joined",
        epoch: a.envelope.epoch,
        group_id: a.envelope.group_id,
      });
    }
    return outcome({ epoch: a.envelope.epoch, group_id: a.envelope.group_id });
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    return null;
  };
  const m = make(env);
  await m.refresh(CH, "commit");
  await env.advance(0);
  const welcome = { content_type: "mls_welcome" as const };
  m.onEnvelope(envelope("WA", 4, { ...welcome, group_id: G0 }));
  await env.advance(0);
  m.onEnvelope(envelope("WB", 2, { ...welcome, group_id: G1 }));
  m.onEnvelope(envelope("WC", 5, { ...welcome, group_id: G1 }));
  m.onEnvelope(envelope("C6", 6, { group_id: G1 }));
  await env.advance(0);
  const processed = () =>
    env.calls("e2ee_text_process").map((c) => c.envelope.id);
  assert.deepEqual(processed(), ["WA"], "the rest parked behind it");
  assert.equal(env.acks.length, 0, "parked, unacked");
  await m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.deepEqual(processed(), ["WA", "WC", "C6"], "WA and WB never again");
  assert.ok(env.acks.includes("WA") && env.acks.includes("WB"), "dropped");
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] stale parked welcomes dropped" &&
        l.ids.count === 2,
    ),
  );
  assert.equal(env.views.get(CH)?.native?.group_id, G1);
  // A redelivery of a dropped Welcome is a duplicate (never to native).
  m.onEnvelope(envelope("WB", 2, { ...welcome, group_id: G1 }));
  await env.advance(0);
  assert.deepEqual(processed(), ["WA", "WC", "C6"]);
  m.dispose();
});

test("FXF parked Welcome: a confirm whose replayed Welcome does not join (signer_leaf_missing, counted toward 6c) wakes the waiting join: its rejoin intent goes out within one backoff step, with no second fetch for that Add", async () => {
  const env = joiningEnv();
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 4, welcome: "V0VM" })),
  );
  let confirmed = false;
  env.handlers.e2ee_text_process = () => {
    if (!confirmed) throw OWNER_CHANGED;
    throw { type: "signer_leaf_missing", group_id: G0 };
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    return null;
  };
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ member_added: addedAt(4) });
  await env.advance(30_000);
  assert.equal(env.calls("e2ee_text_process").length, 1, "parked");
  // Long enough for the join's wait to reach the 15 min cap.
  await env.advance(2 * 3_600_000);
  assert.equal(intents(env), 1);
  await m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_process").length, 2, "replayed once");
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 1, "6c counted");
  await env.advance(joinRebroadcastDelayMs(0));
  assert.equal(intents(env), 2, "the rejoin within one step");
  assert.equal(welcomeGets(env).length, 1, "that Add is never fetched again");
  assert.equal(p.done, false, "below the budget the join goes on");
  m.dispose();
});

test("FXF 6c: the list signer this device holds changes on the same group (an owner change confirmed, a recovery list adopted): the budget starts over and the joiner joins again", async () => {
  const env = joiningEnv();
  const m = await reachSixC(env);
  const before = intents(env);
  // Native adopted a list from the owner's new signer device.
  env.state().seat_list = {
    ...st().seat_list!,
    version: 2,
    signer_device_id: OWNER_DEV2,
  };
  await m.refresh(CH, "interval");
  await env.advance(0);
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 0, "reset");
  assert.notEqual(env.explain()?.notice, "join_stalled");
  assert.equal(intents(env), before + 1, "the join restarts");
  assert.equal(intentGroups(env).at(-1), G0, "on the same group");
  m.dispose();
});

test("FXF 6c: a Welcome discarded with signer_leaf_missing for a group the server no longer names is not counted; one for the server's current group is", async () => {
  const env = joiningEnv();
  env.group = groupBody({ group_id: G1, generation: 1, current_epoch: 0 });
  env.handlers.e2ee_text_process = (a) => {
    throw { type: "signer_leaf_missing", group_id: a.envelope.group_id };
  };
  const m = make(env);
  await m.refresh(CH, "commit");
  await env.advance(0);
  const welcome = { content_type: "mls_welcome" as const };
  m.onEnvelope(envelope("WOLD", 4, { ...welcome, group_id: G0 }));
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_process").length, 1);
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 0, "old group");
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg ===
        "[protected] signer_leaf_missing for an old group not counted",
    ),
  );
  m.onEnvelope(envelope("WNEW", 1, { ...welcome, group_id: G1 }));
  await env.advance(0);
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 1, "current");
  m.dispose();
});

// ---------------------------------------------------------------------------
// S2 live-leg fix lane FXL (F-L4b: the member-side verify carries the
// server's `list.authority`; F-L4: a recovery list leaves off the users the
// server released since). Tests named "FXL ..." are the targets of
// /home/mcp/pc-logs/s2/w4/ctl/FXL.
// ---------------------------------------------------------------------------

/** A v2 list body naming an authority (its `authority:` line). */
const AUTH_BODY_LINE = "\nauthority:" + "a".repeat(64);
const SERVED_AUTH = {
  body: "sloga-channel-authority-v1\nR",
  signature: "ASIG",
};

/**
 * F-L4b, native's rule as the live leg showed it: a body naming an
 * authority verifies only WITH it (else `authority_invalid`); with it, a
 * signer other than `heldSigner` is the 4.7 same-user owner change.
 */
function authorityVerify(env: Env, heldSigner: string) {
  const accepted = defaultHandlers(env).e2ee_text_seat_list_verify!;
  return (a: TextCommandArgs["e2ee_text_seat_list_verify"]) => {
    if (
      a.list.body.includes(AUTH_BODY_LINE) &&
      a.list.authority === undefined
    ) {
      throw {
        type: "seat_list_invalid",
        channel_id: a.channelId,
        reason: "authority_invalid",
      };
    }
    if (a.list.signer_device_id !== heldSigner) {
      throw {
        type: "owner_changed",
        channel_id: a.channelId,
        signer_user_id: a.list.signer_user_id,
        signer_device_id: a.list.signer_device_id,
        same_user: true,
        verified: true,
      };
    }
    return accepted(a);
  };
}

/** The recovery list the server serves: another device of the owner. */
function servedRecoveryList(over: Record<string, unknown> = {}) {
  return {
    version: 2,
    body: "sloga-seat-list-v2" + AUTH_BODY_LINE + "\nR",
    signature: "RSIG",
    signer_user_id: OWNER,
    signer_device_id: OWNER_DEV2,
    authority: SERVED_AUTH,
    handovers: [],
    ...over,
  };
}

test("FXL F-L4b: a member holding the old signer's list verifies a recovery list from another device of the owner WITH the server's authority: the owner-change review, never seat_list_invalid", async () => {
  const env = new Env();
  env.handlers.e2ee_text_seat_list_verify = authorityVerify(env, OWNER_DEV);
  const m = make(env);
  await m.refresh(CH, "open");
  assert.equal(
    env.views.get(CH)?.seatListError,
    null,
    "the held list verifies",
  );
  assert.equal(env.views.get(CH)?.ownerChangePending, false);

  env.seats = seatsBody({ list: servedRecoveryList() });
  await m.refresh(CH, "interval");
  const v = env.calls("e2ee_text_seat_list_verify").at(-1)!;
  assert.deepEqual(v.list, {
    body: servedRecoveryList().body,
    signature: "RSIG",
    signer_user_id: OWNER,
    signer_device_id: OWNER_DEV2,
    authority: SERVED_AUTH,
  });
  const view = env.views.get(CH);
  assert.equal(view?.ownerChangePending, true, "the review is offered");
  assert.equal(view?.seatListError, "owner_changed");
  assert.equal(env.explain()?.notice, "owner_changed_review");
  assert.equal(
    env.logs.some((l) => l.msg.includes("authority malformed")),
    false,
  );
  m.dispose();
});

test("FXL F-L4b: the served authority reaches verify as its two string fields only; absent or null is omitted; a malformed one is omitted and logged, and a body naming an authority then fails loud", async () => {
  const env = new Env();
  env.handlers.e2ee_text_seat_list_verify = authorityVerify(env, OWNER_DEV);
  const m = make(env);
  const last = () => env.calls("e2ee_text_seat_list_verify").at(-1)!;

  // Extra fields on the served object are never passed through.
  env.seats = seatsBody({
    list: servedRecoveryList({
      signer_device_id: OWNER_DEV,
      authority: { ...SERVED_AUTH, extra: "x" },
    }),
  });
  await m.refresh(CH, "open");
  assert.deepEqual(last().list.authority, SERVED_AUTH);
  assert.equal(env.views.get(CH)?.seatListError, null);

  // Absent and null: no `authority` key at all (S1 shape unchanged).
  for (const authority of [undefined, null]) {
    const list: Record<string, unknown> = {
      ...seatsBody().list,
      authority,
    };
    if (authority === undefined) delete list.authority;
    env.seats = seatsBody({ list });
    await m.refresh(CH, "interval");
    assert.equal("authority" in last().list, false, String(authority));
    assert.equal(env.views.get(CH)?.seatListError, null);
  }
  assert.equal(
    env.logs.some((l) => l.msg.includes("authority malformed")),
    false,
  );

  // Malformed: omitted (never the served object), logged, and native's
  // refusal of a body naming an authority is the loud red.
  for (const authority of [{ body: 5, signature: "S" }, "AUTH", ["A", "S"]]) {
    env.seats = seatsBody({ list: servedRecoveryList({ authority }) });
    await m.refresh(CH, "interval");
    assert.equal("authority" in last().list, false, JSON.stringify(authority));
    assert.equal(env.views.get(CH)?.seatListError, "seat_list_invalid");
  }
  assert.ok(
    env.logs.some(
      (l) =>
        l.level === "warn" &&
        l.msg.includes("seat list authority malformed: omitted"),
    ),
  );
  m.dispose();
});

const FXL_LOST = "dev-lost";
const FXL_NEW = "UNEW";

/**
 * F-L4: this user's list signer device was lost; the held list seats
 * OWNER, PEER and this user (the signer user). The mock DS keeps the
 * stored list (= the held one) and answers a recovery PUT by
 * `seat_list_removed_users`: 400 `SeatListNamesRemovedUsers` when the
 * list names a user (not the signer) of the stored list with no active
 * seat; else 200 and the landed list is what `GET .../seats` serves.
 */
function recoveryEnv(active: string[], opts: { cooling?: string[] } = {}) {
  const env = new Env();
  // FXT M1: by default a held user the server does not seat is cooling (a
  // positive release); `cooling` names exactly who is.
  const coolingIds =
    opts.cooling ?? [OWNER, PEER, SELF].filter((u) => !active.includes(u));
  const coolingRows = coolingIds.map((user_id) => ({
    user_id,
    released_at: "",
    cooldown_until: "",
    cause: "access_lost",
  }));
  const lostList = {
    ...st().seat_list!,
    signer_user_id: SELF,
    signer_device_id: FXL_LOST,
  };
  env.states.set(CH, st({ seat_list: lostList }));
  env.seats = seatsBody({
    list: {
      ...seatsBody().list,
      signer_user_id: SELF,
      signer_device_id: FXL_LOST,
    },
    seats: active.map((user_id) => ({ user_id, seated_at: "" })),
    cooling: coolingRows,
  });
  env.group = groupBody({
    signer_lost: {
      user_id: SELF,
      device_id: FXL_LOST,
      cause: "device_revoked",
      at: "",
    },
  });
  // Signed over the served version (the owner flow checks version + 1).
  const signed = (seats: string[], version = 2) => ({
    version,
    body: "sloga-seat-list-v2" + AUTH_BODY_LINE + "\n" + seats.join(","),
    signature: "RSIG",
    signer_user_id: SELF,
    signer_device_id: DEV,
    authority: SERVED_AUTH,
  });
  env.handlers.e2ee_text_seat_list_sign = (a) =>
    signed(a.seats, (a.serverList?.version ?? 1) + 1);
  const puts: { status: number; seats: string[] }[] = [];
  env.routes.push((method, path, body) => {
    if (method !== "PUT" || path !== "/channels/" + CH + "/seats") {
      return undefined;
    }
    const b = body as { body: string; signature: string };
    const seats = b.body.split("\n").at(-1)!.split(",");
    const served = (env.seats as { list: { version: number } }).list.version;
    const seated = (
      (env.seats as { seats: { user_id: string }[] }).seats ?? []
    ).map((s) => s.user_id);
    const removed = seats.filter(
      (u) => u !== SELF && lostList.seats.includes(u) && !seated.includes(u),
    );
    if (removed.length > 0) {
      puts.push({ status: 400, seats });
      return ok({ type: "SeatListNamesRemovedUsers", users: removed }, 400);
    }
    puts.push({ status: 200, seats });
    env.seats = seatsBody({
      ...env.seats,
      list: { ...signed(seats, served + 1), handovers: [] },
    });
    return ok(env.seats);
  });
  return { env, lostList, puts };
}

test("FXL F-L4: a recovery after a server-side release signs the held seats minus the released user, always this user, and the PUT lands (the mock DS refuses a list naming a released user)", async () => {
  // PEER released (access_lost): the server lists OWNER and this user.
  const { env, puts } = recoveryEnv([OWNER, SELF]);
  const m = make(env);
  await m.recoverOwnership(CH);
  const sign = env.calls("e2ee_text_seat_list_sign");
  assert.equal(sign.length, 1);
  assert.deepEqual(sign[0].seats, [OWNER, SELF]);
  assert.equal(sign[0].deviceCap, 5, "the held cap");
  assert.deepEqual(
    sign[0].displayNames.map((d) => d.user_id),
    [OWNER, SELF],
  );
  assert.deepEqual(puts, [{ status: 200, seats: [OWNER, SELF] }]);
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg.includes("recovery list leaves released users off") &&
        l.ids.count === 1,
    ),
  );
  m.dispose();

  // A snapshot that reports this user released too (cooling, not seated):
  // this user is still signed.
  const r2 = recoveryEnv([OWNER]);
  const m2 = make(r2.env);
  await m2.recoverOwnership(CH);
  assert.deepEqual(r2.env.calls("e2ee_text_seat_list_sign")[0].seats, [
    OWNER,
    SELF,
  ]);
  assert.deepEqual(r2.puts, [{ status: 200, seats: [OWNER, SELF] }]);
  m2.dispose();

  // Nobody released: the held seats verbatim, no log line.
  const r3 = recoveryEnv([OWNER, PEER, SELF]);
  const m3 = make(r3.env);
  await m3.recoverOwnership(CH);
  assert.deepEqual(
    r3.env.calls("e2ee_text_seat_list_sign")[0].seats,
    r3.lostList.seats,
  );
  assert.deepEqual(r3.puts, [{ status: 200, seats: r3.lostList.seats }]);
  assert.equal(
    r3.env.logs.some((l) => l.msg.includes("leaves released users off")),
    false,
  );
  m3.dispose();
});

test("FXL F-L4: a user the server lists as seated but the held list does not name is never added to the recovery list; a malformed seats entry refuses the recovery before any dialog", async () => {
  const { env, puts } = recoveryEnv([OWNER, FXL_NEW, SELF]);
  const m = make(env);
  await m.recoverOwnership(CH);
  const seats = env.calls("e2ee_text_seat_list_sign")[0].seats;
  assert.deepEqual(seats, [OWNER, SELF]);
  assert.equal(seats.includes(FXL_NEW), false, "never grown by the server");
  assert.deepEqual(puts, [{ status: 200, seats: [OWNER, SELF] }]);
  m.dispose();

  const bad = recoveryEnv([OWNER, SELF]);
  bad.env.seats = {
    ...bad.env.seats,
    seats: [{ user_id: OWNER, seated_at: "" }, { user_id: 7 }],
  };
  const mb = make(bad.env);
  await assert.rejects(
    mb.recoverOwnership(CH),
    (e: { reason?: string }) => e.reason === "recovery_unavailable",
  );
  assert.equal(bad.env.calls("e2ee_text_seat_list_sign").length, 0);
  assert.deepEqual(bad.puts, []);
  mb.dispose();
});

test("FXL F-L4b: the recoverer re-verifies its own recovery list after the PUT lands WITH the server's authority, never seat_list_invalid", async () => {
  const { env, puts } = recoveryEnv([OWNER, SELF]);
  // FXT M2: native as it is (`seat_list.rs` `authority_acceptance`, live
  // A2): the recoverer's own landed list is the same-user owner change of
  // ITS OWN device until the native confirm.
  const native = faithfulRecoveryNative(env);
  const m = make(env);
  await m.recoverOwnership(CH);
  await env.advance(0);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].status, 200);
  assert.ok(native.ownerChanged() > 0, "native raised the review first");
  const own = env
    .calls("e2ee_text_seat_list_verify")
    .filter((v) => v.list.signer_device_id === DEV);
  assert.ok(own.length > 0, "its own list is verified after the PUT");
  for (const v of own) assert.deepEqual(v.list.authority, SERVED_AUTH);
  assert.equal(env.calls("e2ee_text_owner_confirm_change").length, 1);
  const view = env.views.get(CH);
  assert.equal(view?.seatListError, null);
  assert.equal(view?.ownerChangePending, false);
  assert.equal(view?.ownerChangeUnlisted, false);
  m.dispose();
});

// ---------------------------------------------------------------------------
// S2 live-leg fix lane FXT. F-L13: a join run's first intent waits while
// this device's stored intent may be being admitted, so "Try again" (an
// open) or a retry never races that admit into a rejoin eviction (native
// then poisons the group on this device). M1: a recovery leaves a held
// user off on positive evidence only. M2: the recoverer's own landed list
// is native's same-user owner change; the call resolves and the native
// confirm is asked. Tests named "FXT ..." are the targets of
// /home/mcp/pc-logs/s2/w4/ctl/FXT.
// ---------------------------------------------------------------------------

/** This device's own intent as `text_group.join_requests` stores it. */
function ownStored(ref = "KPR-OLD") {
  return {
    user_id: SELF,
    device_id: DEV,
    key_package_ref: ref,
    signature: "JSIG-OLD",
    created_at: "",
    rejoin: false,
  };
}

/** A Welcome for G0 joins this device at epoch 4. */
function welcomeJoins(env: Env) {
  env.handlers.e2ee_text_process = (a) => {
    env.states.set(CH, st({ epoch: 4 }));
    return outcome({
      kind: "welcome_joined",
      epoch: 4,
      group_id: a.envelope.group_id,
    });
  };
}

test("FXT F-L13 joinIntentHeld: held while the own stored intent is inside the admit window; released after it; never for a clock before it or not finite", () => {
  const at = 1_000_000;
  const held = (o: Partial<Parameters<typeof joinIntentHeld>[0]>) =>
    joinIntentHeld({
      ownIntentStored: true,
      sinceMs: at,
      nowMs: at,
      ...o,
    });
  assert.equal(held({}), true);
  assert.equal(held({ nowMs: at + JOIN_ADMIT_WINDOW_MS - 1 }), true);
  assert.equal(held({ nowMs: at + JOIN_ADMIT_WINDOW_MS }), false);
  assert.equal(held({ ownIntentStored: false }), false);
  assert.equal(held({ sinceMs: null }), false);
  assert.equal(held({ nowMs: at - 1 }), false, "a clock before the start");
  assert.equal(held({ nowMs: Number.NaN }), false);
});

test("FXT F-L13: Try again (an open) or a retry while this device's stored intent may be admitted sends no intent; the admit's Welcome joins it and no intent ever races it", async () => {
  const env = joiningEnv();
  // The stored intent of an earlier session (or one this device sent while
  // over the cap was freed): a member can admit it at any moment.
  env.group = groupBody({ join_requests: [ownStored()] });
  welcomeJoins(env);
  const m = make(env);
  await m.open(CH);
  await env.advance(0);
  m.retryNow(CH);
  await env.advance(0);
  assert.equal(intents(env), 0, "no intent while the stored one may land");
  assert.ok(
    env.logs.some((l) => l.msg.includes("join intent held")),
    "the hold is logged",
  );
  await env.advance(8_000);
  assert.equal(intents(env), 0);
  // A member admits the STORED intent: the Add lands, the Welcome arrives.
  env.group = groupBody({
    current_epoch: 4,
    member_added: [{ user_id: SELF, device_id: DEV, epoch: 4, at: "" }],
  });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(env.state().state, "active");
  await env.advance(JOIN_ADMIT_WINDOW_MS * 3);
  assert.equal(intents(env), 0, "nothing raced the admit");
  m.close(CH);
  m.dispose();
});

test("FXT F-L13: the hold releases once the admit window passes with no Add: the run then sends its intent", async () => {
  const env = joiningEnv();
  env.group = groupBody({ join_requests: [ownStored()] });
  const m = make(env);
  const times = intentTimes(env);
  await m.open(CH);
  await env.advance(JOIN_ADMIT_WINDOW_MS - 1);
  assert.equal(intents(env), 0);
  await env.advance(1);
  assert.equal(intents(env), 1, "released: the window passed with no Add");
  assert.deepEqual(times, [JOIN_ADMIT_WINDOW_MS]);
  m.close(CH);
  m.dispose();
});

test("FXT F-L13: an Add of this device already landed and no intent sent this session: its Welcome path runs before any intent, and the stored Welcome joins it", async () => {
  const env = joiningEnv();
  // FXT2: native as an earlier session's `_join` left it (lifecycle.rs
  // sets `joining`): its intent is outstanding, so the stored Welcome can
  // be processed. A `left`/`none` device never takes this path (MAJOR-1).
  env.states.set(
    CH,
    st({ state: "joining", verdict: "joining", epoch: null, members: [] }),
  );
  env.group = groupBody({
    current_epoch: 4,
    member_added: [{ user_id: SELF, device_id: DEV, epoch: 4, at: "" }],
  });
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 4, welcome: "WEL" })),
  );
  welcomeJoins(env);
  const m = make(env);
  await m.open(CH);
  await env.advance(WELCOME_FETCH_AFTER_MS - 1);
  assert.equal(intents(env), 0);
  assert.equal(welcomeGets(env).length, 0);
  await env.advance(1);
  assert.equal(welcomeGets(env).length, 1, "the stored Welcome of that Add");
  assert.equal(env.state().state, "active");
  await env.advance(120_000);
  assert.equal(
    intents(env),
    0,
    "no intent: it would read as a rejoin and evict the fresh leaf",
  );
  m.close(CH);
  m.dispose();
});

/** The fake DS keeps each accepted intent (one row per device). */
function storesOwnIntents(env: Env) {
  env.routes.push((method, path, body) => {
    if (method === "POST" && /join_intent$/.test(path)) {
      const b = body as { key_package_ref: string };
      env.group = groupBody({ join_requests: [ownStored(b.key_package_ref)] });
    }
    return undefined;
  });
}

test("FXT F-L13: an open during a running join keeps its backoff while this device's intent may be admitted (the next re-broadcast is not brought forward)", async () => {
  const env = joiningEnv();
  storesOwnIntents(env);
  const m = make(env);
  const times = intentTimes(env);
  silence(m.ensureJoined(CH));
  // S2-D28 steps 10, 20, 40, 80, 160 s, each at least the admit window.
  await env.advance(260_000);
  assert.deepEqual(times, [0, 60_000, 120_000, 180_000, 260_000]);
  await env.advance(1_000);
  await m.open(CH);
  await env.advance(200_000);
  assert.deepEqual(
    times,
    [0, 60_000, 120_000, 180_000, 260_000, 420_000],
    "the S2-D28 step (160 s), not brought forward by the open",
  );
  m.close(CH);
  m.dispose();
});

test("FXT M1 recoverySeats: only positive evidence leaves a held user off (cooling and not seated, or a refusal over this version); absence keeps; this user always; never an addition; malformed reads refuse", () => {
  const held = [OWNER, PEER, SELF];
  const seats = (...ids: string[]) => ids.map((user_id) => ({ user_id }));
  const cool = (...ids: string[]) => ids.map((user_id) => ({ user_id }));
  const run = (snap: { seats?: unknown; cooling?: unknown }, refused = []) =>
    recoverySeats(held, snap, SELF, refused);
  assert.deepEqual(run({ seats: seats(OWNER, SELF) }), held, "absence keeps");
  assert.deepEqual(run({ seats: seats(OWNER, SELF), cooling: cool(PEER) }), [
    OWNER,
    SELF,
  ]);
  assert.deepEqual(
    run({ seats: seats(OWNER, PEER, SELF), cooling: cool(PEER) }),
    held,
    "seated wins over cooling",
  );
  assert.deepEqual(
    recoverySeats(held, { seats: seats(OWNER, SELF) }, SELF, [PEER]),
    [OWNER, SELF],
    "a refusal over this version",
  );
  assert.deepEqual(
    recoverySeats(held, { seats: [], cooling: cool(SELF) }, SELF, [SELF]),
    held,
    "this user always",
  );
  assert.deepEqual(
    run({ seats: seats(OWNER, PEER, SELF, FXL_NEW) }),
    held,
    "never added",
  );
  assert.equal(run({ seats: "x" }), null);
  assert.equal(run({ seats: seats(OWNER), cooling: "x" }), null);
  assert.equal(run({ seats: seats(OWNER), cooling: [{ user_id: 7 }] }), null);
  assert.deepEqual(run({ seats: seats(OWNER, SELF), cooling: null }), held);
});

test("FXT M1: a held user the server neither seats nor lists as cooling is KEPT; after the server refuses naming them, the next Recover (after a reload) drops exactly them and lands", async () => {
  const { env, puts } = recoveryEnv([OWNER, SELF], { cooling: [] });
  const key = PROTECTED_RECOVERY_REFUSED_KEY_PREFIX + SELF + ":" + CH;
  const m = make(env);
  await assert.rejects(
    m.recoverOwnership(CH),
    (e: { type?: string }) => e.type === "SeatListNamesRemovedUsers",
  );
  const sign = () => env.calls("e2ee_text_seat_list_sign");
  assert.deepEqual(sign()[0].seats, [OWNER, PEER, SELF], "absence keeps");
  assert.deepEqual(puts, [{ status: 400, seats: [OWNER, PEER, SELF] }]);
  assert.deepEqual(JSON.parse(env.storeMap.get(key)!), {
    v: 1,
    version: 1,
    users: [PEER],
  });
  m.dispose();
  // A reload: the new manager reads the persisted refusal.
  const m2 = make(env);
  await m2.recoverOwnership(CH);
  assert.deepEqual(sign()[1].seats, [OWNER, SELF]);
  assert.deepEqual(puts[1], { status: 200, seats: [OWNER, SELF] });
  assert.equal(env.storeMap.has(key), false, "spent once recovery resolved");
  m2.dispose();
});

test("FXT M1: refusal ids are bound to the served list version they were refused over: another version keeps the user until refused over it", async () => {
  const { env, puts } = recoveryEnv([OWNER, SELF], { cooling: [] });
  const m = make(env);
  const refusedRemoved = (e: { type?: string }) =>
    e.type === "SeatListNamesRemovedUsers";
  await assert.rejects(m.recoverOwnership(CH), refusedRemoved);
  // Another list is served now (version 4): the v1 refusal says nothing.
  const s = env.seats as { list: Record<string, unknown> };
  env.seats = { ...env.seats, list: { ...s.list, version: 4 } };
  await assert.rejects(m.recoverOwnership(CH), refusedRemoved);
  const sign = () => env.calls("e2ee_text_seat_list_sign");
  assert.deepEqual(sign()[1].seats, [OWNER, PEER, SELF]);
  assert.equal(sign()[1].serverList?.version, 4);
  await m.recoverOwnership(CH);
  assert.deepEqual(sign()[2].seats, [OWNER, SELF]);
  assert.deepEqual(
    puts.map((p) => p.status),
    [400, 400, 200],
  );
  m.dispose();
});

/**
 * FXT M2: native's verify for the recoverer (`seat_list.rs`
 * `authority_acceptance`; live A2): its pin is the lost device and the
 * recovery authority names only this device, so a list this device signed
 * is `owner_changed { same_user, signer_device_id: DEV }` until
 * `_owner_confirm_change`, then it verifies. A body naming an authority
 * without it is `authority_invalid`; the lost device's held list verifies.
 */
function faithfulRecoveryNative(env: Env) {
  let confirmed = false;
  let ownerChanged = 0;
  const accepted = defaultHandlers(env).e2ee_text_seat_list_verify!;
  env.handlers.e2ee_text_seat_list_verify = (a) => {
    if (
      a.list.body.includes(AUTH_BODY_LINE) &&
      a.list.authority === undefined
    ) {
      throw {
        type: "seat_list_invalid",
        channel_id: a.channelId,
        reason: "authority_invalid",
      };
    }
    if (a.list.signer_device_id !== DEV) return accepted(a);
    const s = env.state();
    if (!confirmed) {
      ownerChanged += 1;
      s.owner_pin = {
        ...s.owner_pin!,
        status: "changed",
        pending_signer: {
          user_id: SELF,
          device_id: DEV,
          same_user: true,
          verified: true,
        },
      };
      throw {
        type: "owner_changed",
        channel_id: a.channelId,
        signer_user_id: SELF,
        signer_device_id: DEV,
        same_user: true,
        verified: true,
      };
    }
    const seats = a.list.body.split("\n").at(-1)!.split(",");
    s.seat_list = {
      ...s.seat_list!,
      version: 2,
      signer_user_id: SELF,
      signer_device_id: DEV,
      seats,
    };
    s.owner_pin = {
      ...s.owner_pin!,
      status: "pinned",
      owner_user_id: SELF,
      owner_device_id: DEV,
      pending_signer: null,
    };
    return {
      status: "accepted",
      version: 2,
      seats,
      device_cap: 5,
      signer_user_id: SELF,
      signer_device_id: DEV,
      pinned_now: true,
    };
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    return null;
  };
  return { ownerChanged: () => ownerChanged };
}

test("FXT M2: a landed recovery whose re-verify is native's same-user change of THIS device resolves; the native confirm is requested only after it, and the re-verify with the authority settles", async () => {
  const { env, puts } = recoveryEnv([OWNER, SELF]);
  const native = faithfulRecoveryNative(env);
  let confirmDuringCall = false;
  let inCall = true;
  const confirm = env.handlers.e2ee_text_owner_confirm_change!;
  env.handlers.e2ee_text_owner_confirm_change = (a) => {
    confirmDuringCall ||= inCall;
    return confirm(a);
  };
  const m = make(env);
  await m.recoverOwnership(CH);
  inCall = false;
  assert.deepEqual(puts, [{ status: 200, seats: [OWNER, SELF] }]);
  assert.ok(native.ownerChanged() > 0);
  await env.advance(0);
  const confirms = env.calls("e2ee_text_owner_confirm_change");
  assert.equal(confirms.length, 1, "the NATIVE dialog is the consent");
  assert.equal(confirms[0].channelId, CH);
  assert.equal(confirmDuringCall, false, "after the call resolved");
  const last = env.calls("e2ee_text_seat_list_verify").at(-1)!;
  assert.equal(last.list.signer_device_id, DEV);
  assert.deepEqual(last.list.authority, SERVED_AUTH);
  const view = env.views.get(CH);
  assert.equal(view?.ownerChangePending, false);
  assert.equal(view?.seatListError, null);
  assert.equal(view?.ownerChangeUnlisted, false);
  assert.equal(
    env.logs.some((l) => l.msg.includes("own owner change to confirm")),
    true,
  );
  m.dispose();
});

test("FXT M2: the user cancels the native confirm: the recovery still resolved and the channel stays in Review owner change", async () => {
  const { env } = recoveryEnv([OWNER, SELF]);
  faithfulRecoveryNative(env);
  env.handlers.e2ee_text_owner_confirm_change = () => {
    throw { type: "declined" };
  };
  const m = make(env);
  await m.recoverOwnership(CH);
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_owner_confirm_change").length, 1);
  const view = env.views.get(CH);
  assert.equal(view?.ownerChangePending, true);
  assert.equal(view?.seatListError, "owner_changed");
  assert.equal(env.explain()?.notice, "owner_changed_review");
  m.dispose();
});

test("FXT M2: a landed recovery whose re-verify names ANOTHER device as the new signer is still a failure and asks no confirm", async () => {
  const { env, puts } = recoveryEnv([OWNER, SELF]);
  env.handlers.e2ee_text_seat_list_verify = (a) => {
    if (a.list.signer_device_id === FXL_LOST) {
      return defaultHandlers(env).e2ee_text_seat_list_verify!(a);
    }
    throw {
      type: "owner_changed",
      channel_id: a.channelId,
      signer_user_id: SELF,
      signer_device_id: "dev-other",
      same_user: true,
      verified: true,
    };
  };
  const m = make(env);
  await assert.rejects(
    m.recoverOwnership(CH),
    (e: { source?: string; error?: { type?: string } }) =>
      e.source === "native" && e.error?.type === "owner_changed",
  );
  assert.equal(puts.length, 1);
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_owner_confirm_change").length, 0);
  m.dispose();
});

test("FXT M2: a member's confirm of a recovery list from another device of the owner carries the authority and settles", async () => {
  const env = new Env();
  let confirmed = false;
  const accepted = defaultHandlers(env).e2ee_text_seat_list_verify!;
  env.handlers.e2ee_text_seat_list_verify = (a) => {
    if (
      a.list.body.includes(AUTH_BODY_LINE) &&
      a.list.authority === undefined
    ) {
      throw {
        type: "seat_list_invalid",
        channel_id: a.channelId,
        reason: "authority_invalid",
      };
    }
    if (a.list.signer_device_id !== OWNER_DEV2) return accepted(a);
    if (!confirmed) {
      throw {
        type: "owner_changed",
        channel_id: a.channelId,
        signer_user_id: OWNER,
        signer_device_id: OWNER_DEV2,
        same_user: true,
        verified: true,
      };
    }
    return { ...accepted(a), version: 2, signer_device_id: OWNER_DEV2 };
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    return null;
  };
  env.seats = seatsBody({ list: servedRecoveryList() });
  const m = make(env);
  await m.refresh(CH, "open");
  assert.equal(env.views.get(CH)?.ownerChangePending, true);
  await m.confirmOwnerChange(CH);
  assert.equal(env.calls("e2ee_text_owner_confirm_change").length, 1);
  const last = env.calls("e2ee_text_seat_list_verify").at(-1)!;
  assert.equal(last.list.signer_device_id, OWNER_DEV2);
  assert.deepEqual(last.list.authority, SERVED_AUTH);
  const view = env.views.get(CH);
  assert.equal(view?.ownerChangePending, false);
  assert.equal(view?.seatListError, null);
  assert.equal(view?.ownerChangeUnlisted, false);
  m.dispose();
});

// ---------------------------------------------------------------------------
// S2 live-leg fix lane FXT2 (re-review MAJOR-1, MAJOR-2, MINOR-6). Tests
// named "FXT2 ..." are targets of /home/mcp/pc-logs/s2/w4/ctl/FXT.
// ---------------------------------------------------------------------------

/** This device's member_added entry as a real server keeps it. */
const OWN_ADDED = (epoch: number) => ({
  user_id: SELF,
  device_id: DEV,
  epoch,
  at: "",
});

const unsolicited = () => {
  throw { type: "mls_unsolicited_welcome", group_id: G0 };
};

test("FXT2 MAJOR-1: a device the server still lists as a member (its member_added entry) but native has left sends its rejoin intent at once: no stored-Welcome wait, no unsolicited toast", async () => {
  const env = new Env();
  env.states.set(CH, st({ state: "left", verdict: "no_group" }));
  env.group = groupBody({ member_added: [OWN_ADDED(2)] });
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 2, welcome: "OLD" })),
  );
  env.handlers.e2ee_text_process = unsolicited;
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 1, "the rejoin intent at once");
  await env.advance(60_000);
  assert.equal(welcomeGets(env).length, 0, "no old Welcome fetched");
  assert.deepEqual(env.notified, [], "no false invitation alarm");
  m.dispose();
});

test("FXT2 MAJOR-1: an Add a mailbox Welcome handled is done once the device holds the group: after a later wipe it rejoins at once, never taking that Add's stored-Welcome path", async () => {
  const env = joiningEnv();
  welcomeJoins(env);
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 4, welcome: "OLD" })),
  );
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 1);
  env.group = groupBody({ current_epoch: 4, member_added: [OWN_ADDED(4)] });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(env.state().state, "active");
  // The leaf is later wiped locally; the server still lists the device.
  env.states.set(CH, st({ state: "left", verdict: "no_group", epoch: 4 }));
  env.handlers.e2ee_text_process = unsolicited;
  silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 2, "the rejoin intent at once");
  await env.advance(60_000);
  assert.equal(welcomeGets(env).length, 0);
  assert.deepEqual(env.notified, []);
  m.dispose();
});

test("FXT2 F-L13: the run's own re-broadcasts also wait while its stored intent is inside the admit window", async () => {
  const env = joiningEnv();
  storesOwnIntents(env);
  const m = make(env);
  const times = intentTimes(env);
  silence(m.ensureJoined(CH));
  await env.advance(300_000);
  assert.deepEqual(times, [0, 60_000, 120_000, 180_000, 260_000]);
  m.dispose();
});

test("FXT2 F-L13: an Add of this device landing between the run's last read and its next POST stops that POST; the Welcome joins it", async () => {
  const env = joiningEnv();
  welcomeJoins(env);
  let puts = 0;
  env.routes.push((method, path) => {
    if (method === "PUT" && path === "/mls/key_packages" && ++puts === 2) {
      // A member's admit of intent 1 commits while intent 2 is minted.
      env.group = groupBody({ current_epoch: 4, member_added: [OWN_ADDED(4)] });
    }
    return undefined;
  });
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 1);
  await env.advance(10_000);
  assert.equal(puts, 2, "the next intent was minted");
  assert.equal(intents(env), 1, "but never posted");
  assert.ok(
    env.logs.some((l) => l.msg.includes("join intent not posted: an Add")),
  );
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(env.state().state, "active");
  await env.advance(300_000);
  assert.equal(intents(env), 1);
  m.dispose();
});

test("FXT2 F-L13: native holding the group when the next intent is ready stops that POST and the run", async () => {
  const env = joiningEnv();
  let puts = 0;
  env.routes.push((method, path) => {
    if (method === "PUT" && path === "/mls/key_packages" && ++puts === 2) {
      env.states.set(CH, st({ epoch: 4 }));
    }
    return undefined;
  });
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await env.advance(10_000);
  assert.equal(puts, 2);
  assert.equal(intents(env), 1, "never posted while it holds the group");
  await env.advance(300_000);
  assert.equal(intents(env), 1);
  m.dispose();
});

test("FXT2 F-L13: an unread text_group right before the POST skips that intent (no blind POST); the next step posts", async () => {
  const env = joiningEnv();
  let puts = 0;
  let failNext = false;
  env.routes.push((method, path) => {
    if (method === "PUT" && path === "/mls/key_packages" && ++puts === 2) {
      failNext = true;
    }
    if (failNext && method === "GET" && /text_group$/.test(path)) {
      failNext = false;
      return ok({ type: "InternalError" }, 503);
    }
    return undefined;
  });
  const m = make(env);
  const times = intentTimes(env);
  silence(m.ensureJoined(CH));
  await env.advance(40_000);
  assert.deepEqual(times, [0, 30_000], "10 s skipped, then 20 s later");
  assert.ok(
    env.logs.some((l) => l.msg.includes("join intent not posted: text_group")),
  );
  m.dispose();
});

test("FXT2 M2: native's own-device owner change while the served list is NOT this device's (the PUT did not land) is still a failure, and no confirm is asked", async () => {
  const { env } = recoveryEnv([OWNER, SELF]);
  let putAnswered = false;
  env.routes.unshift((method, path) => {
    if (method === "PUT" && path === "/channels/" + CH + "/seats") {
      putAnswered = true;
      return ok({});
    }
    return undefined;
  });
  const accepted = defaultHandlers(env).e2ee_text_seat_list_verify!;
  env.handlers.e2ee_text_seat_list_verify = (a) => {
    if (!putAnswered) return accepted(a);
    throw {
      type: "owner_changed",
      channel_id: a.channelId,
      signer_user_id: SELF,
      signer_device_id: DEV,
      same_user: true,
      verified: true,
    };
  };
  const m = make(env);
  await assert.rejects(
    m.recoverOwnership(CH),
    (e: { source?: string; error?: { type?: string } }) =>
      e.source === "native" && e.error?.type === "owner_changed",
  );
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_owner_confirm_change").length, 0);
  m.dispose();
});

test("FXT2 M1: a refusal of resumed recovery bytes this call did not sign records nothing (only a list this call signed can name who to leave off)", async () => {
  const { env, puts } = recoveryEnv([OWNER, SELF], { cooling: [] });
  const signed = {
    version: 2,
    body:
      "sloga-seat-list-v2" +
      AUTH_BODY_LINE +
      "\n" +
      [OWNER, PEER, SELF].join(","),
    signature: "RSIG",
    signer_user_id: SELF,
    signer_device_id: DEV,
    authority: SERVED_AUTH,
  };
  env.storeMap.set(
    publishStoreKey(SELF, CH),
    JSON.stringify({
      v: 1,
      op: "seats",
      signed,
      recovery: true,
      answer: "sent",
    }),
  );
  const m = make(env);
  await assert.rejects(
    m.recoverOwnership(CH),
    (e: { type?: string }) => e.type === "SeatListNamesRemovedUsers",
  );
  assert.equal(env.calls("e2ee_text_seat_list_sign").length, 0, "resumed");
  assert.deepEqual(puts, [{ status: 400, seats: [OWNER, PEER, SELF] }]);
  assert.equal(
    env.storeMap.has(PROTECTED_RECOVERY_REFUSED_KEY_PREFIX + SELF + ":" + CH),
    false,
  );
  m.dispose();
});

test("FXT2 M1: when the store refuses the refusal record, the in-memory copy still drops exactly the refused user on the next Recover", async () => {
  const { env, puts } = recoveryEnv([OWNER, SELF], { cooling: [] });
  const key = PROTECTED_RECOVERY_REFUSED_KEY_PREFIX + SELF + ":" + CH;
  const set = env.store.set;
  env.store.set = (k: string, v: string) => (k === key ? false : set(k, v));
  const m = make(env);
  await assert.rejects(
    m.recoverOwnership(CH),
    (e: { type?: string }) => e.type === "SeatListNamesRemovedUsers",
  );
  assert.equal(env.storeMap.has(key), false);
  assert.ok(
    env.logs.some(
      (l) =>
        l.level === "warn" &&
        l.msg.includes("recovery refused for released users"),
    ),
  );
  await m.recoverOwnership(CH);
  assert.deepEqual(env.calls("e2ee_text_seat_list_sign")[1].seats, [
    OWNER,
    SELF,
  ]);
  assert.deepEqual(
    puts.map((p) => p.status),
    [400, 200],
  );
  m.dispose();
});

// ---------------------------------------------------------------------------
// S2 live-leg fix lane FXP: F-L6 (a Welcome pins each unpinned device once;
// a refused Welcome's rejoin is paced by time, persisted, and for a hard
// refusal needs the refused device gone from the server's member list; its
// red alarm stays until native accepts the group) and F-L7 (no intent while
// this device's Welcome waits on an owner change, on native's real
// signer_leaf_missing + pending_signer shape). Tests named "FXP ..." are the
// targets of /home/mcp/pc-logs/s2/w4/ctl/FXP.
// ---------------------------------------------------------------------------

/** Native's D5 refusal naming one unpinned device of PEER. */
function pinRequired(device_id: string) {
  return { type: "identity_pin_required", user_id: PEER, device_id };
}

/** Native's leaf rejection of a Welcome (`reason` as `LeafRejection`). */
function leafRejected(reason: string) {
  return {
    type: "mls_leaf_rejected",
    user_id: PEER,
    device_id: "dX",
    reason,
  };
}

/** The Welcome `a` joins this device into its group at its epoch. */
function welcomeJoinedAt(env: Env, a: TextCommandArgs["e2ee_text_process"]) {
  env.states.set(
    CH,
    st({ group_id: a.envelope.group_id, epoch: a.envelope.epoch }),
  );
  return outcome({
    kind: "welcome_joined",
    epoch: a.envelope.epoch,
    group_id: a.envelope.group_id,
  });
}

/** Native `_join` as lifecycle.rs leaves the row: `joining`. */
function joinSetsJoining(env: Env) {
  const join = env.handlers.e2ee_text_join!;
  env.handlers.e2ee_text_join = (a) => {
    const s = env.state();
    s.state = "joining";
    s.verdict = "joining";
    return join(a);
  };
}

/**
 * `_seat_list_verify` answers D15 `owner_changed` until `confirmed()`, and
 * native records the pending signer meanwhile (`owner_pin.pending_signer`;
 * the confirm or an adopted list clears it).
 */
function ownerChangeUntil(env: Env, confirmed: () => boolean) {
  const verify = env.handlers.e2ee_text_seat_list_verify!;
  env.handlers.e2ee_text_seat_list_verify = (a) => {
    const pin = env.state().owner_pin;
    if (!confirmed()) {
      pin.pending_signer = {
        user_id: OWNER,
        device_id: OWNER_DEV2,
        same_user: true,
        verified: true,
      };
      throw OWNER_CHANGED;
    }
    pin.pending_signer = null;
    return verify(a);
  };
}

test("FXP F-L6: a Welcome whose roster holds two unpinned devices (two refusals naming different devices) pins each once and joins in the same pass", async () => {
  const env = joiningEnv();
  const named = ["dA", "dB"];
  let n = 0;
  env.handlers.e2ee_text_process = (a) => {
    n++;
    if (n <= named.length) throw pinRequired(named[n - 1]);
    return welcomeJoinedAt(env, a);
  };
  const m = make(env);
  m.channelProtected(CH);
  await env.advance(0);
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.deepEqual(env.pins, [
    { userId: PEER, targets: ["dA"] },
    { userId: PEER, targets: ["dB"] },
  ]);
  assert.equal(n, 3, "each device pinned once, then joined");
  assert.deepEqual(env.acks, ["W1"]);
  assert.equal(env.views.get(CH)?.native?.state, "active");
  assert.equal(env.views.get(CH)?.groupError ?? null, null);
  m.dispose();
});

test("FXP F-L6: a Welcome naming the same device twice ends that pass (its pin did not take); fresh names stop at the leaf cap; a commit retries once whatever device the next refusal names (D28)", async () => {
  const env = joiningEnv();
  // A loop breaker no bounded retry reaches (an unbounded one would spin).
  const LOOP = 3 * WELCOME_PIN_DEVICES_MAX;
  let n = 0;
  const refuse = (device: (i: number) => string) => () => {
    n++;
    if (n > LOOP) throw { type: "busy" };
    throw pinRequired(device(n));
  };
  env.handlers.e2ee_text_process = refuse(() => "dA");
  const m = make(env);
  m.channelProtected(CH);
  await env.advance(0);
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(n, 2, "pinned once, retried once, then held");
  assert.deepEqual(env.pins, [{ userId: PEER, targets: ["dA"] }]);
  assert.equal(env.acks.includes("W1"), false, "held, unacked");
  // Native names a fresh device on every refusal: the cap ends the pass.
  n = 0;
  env.pins = [];
  env.handlers.e2ee_text_process = refuse((i) => `dW${i}`);
  m.onEnvelope(envelope("W2", 5, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(n, WELCOME_PIN_DEVICES_MAX + 1);
  assert.equal(env.pins.length, WELCOME_PIN_DEVICES_MAX);
  // A commit: one retry, whatever device the second refusal names.
  n = 0;
  env.pins = [];
  env.handlers.e2ee_text_process = refuse((i) => `dC${i}`);
  m.onEnvelope(envelope("C6", 6));
  await env.advance(0);
  assert.equal(n, 2, "a commit is retried once (D28)");
  assert.deepEqual(env.pins, [{ userId: PEER, targets: ["dC1"] }]);
  m.dispose();
});

/** The refused device ("dX" of PEER) as the server's member list holds it. */
const LISTED = [
  { user_id: SELF, device_id: DEV },
  { user_id: OWNER, device_id: OWNER_DEV },
  { user_id: PEER, device_id: PEER_DEV },
  { user_id: PEER, device_id: "dX" },
];

/** Every pin of a peer's device fails in transport (a fetch error). */
function pinsFailInTransport(env: Env) {
  env.pinCallIdentities = async (userId: string, targets: string[]) => {
    env.pins.push({ userId, targets });
    throw new TypeError("Failed to fetch");
  };
}

/** Native's step-8 answer: the held list's signer holds no leaf. */
const SLM = { type: "signer_leaf_missing", channel_id: CH };

/** The pending signer native records for an unconfirmed owner change. */
const PENDING = {
  user_id: OWNER,
  device_id: OWNER_DEV2,
  same_user: true,
  verified: true,
};

/** A Welcome for this device's Add at `epoch` (the refused device listed). */
async function refusedAt(
  env: Env,
  m: ProtectedTextManager,
  epoch: number,
  id: string,
) {
  env.group = groupBody({
    current_epoch: epoch,
    member_added: addedAt(epoch),
    members: LISTED,
  });
  m.onEnvelope(envelope(id, epoch, { content_type: "mls_welcome" }));
  await env.advance(joinRebroadcastDelayMs(0));
}

/** The stored pace record of CH (parsed), [] when none. */
function storedPace(env: Env) {
  const raw = env.storeMap.get(
    `${PROTECTED_REFUSAL_PACE_KEY_PREFIX}${SELF}:${CH}`,
  );
  const v = raw
    ? (JSON.parse(raw) as { entries: { groupId: string }[] })
    : null;
  return v?.entries ?? [];
}

test("FXP F-L6 MJ-1/M2: a Welcome refused for unknown_identity (its pin failed in transport) gets ONE paced rejoin at the run's next commit refresh, never fetching the refused Welcome; the red stays through it; a second refusal waits for the window whatever the trigger; native accepting ends the alarm and the pace", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  pinsFailInTransport(env);
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 4, welcome: "V0VM" })),
  );
  let answer: "refuse" | "join" = "refuse";
  env.handlers.e2ee_text_process = (a) => {
    if (answer === "refuse") throw leafRejected("unknown_identity");
    return welcomeJoinedAt(env, a);
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 1);
  env.group = groupBody({
    current_epoch: 4,
    member_added: addedAt(4),
    members: LISTED,
  });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(
    env.calls("e2ee_text_process").length,
    1,
    "its pin failed in transport: no second pass",
  );
  assert.deepEqual(env.pins, [{ userId: PEER, targets: ["dX"] }]);
  assert.equal(env.shield(), "unverified");
  await env.advance(joinRebroadcastDelayMs(0));
  assert.equal(intents(env), 2, "the commit refresh's one paced rejoin");
  assert.equal(welcomeGets(env).length, 0, "the refused Welcome is done");
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] refused welcome: join unblocked" &&
        l.ids.step === "rejoin" &&
        l.ids.retryable === true,
    ),
  );
  assert.equal(env.shield(), "unverified", "M2: red through the rejoin");
  // The re-Add's Welcome is refused again: nothing inside the window.
  await refusedAt(env, m, 6, "W2");
  m.retryNow(CH);
  await env.advance(0);
  await m.open(CH);
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(60_000);
  assert.equal(intents(env), 2, "inside the window: no trigger grants");
  await env.advance(REFUSAL_PACE_BASE_MS);
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(1_000);
  assert.equal(intents(env), 3, "past the window: an event refresh grants");
  // Native accepts the next one: the alarm and the pace of G0 are over.
  answer = "join";
  env.group = groupBody({
    current_epoch: 8,
    member_added: addedAt(8),
    members: LISTED,
  });
  m.onEnvelope(envelope("W3", 8, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(env.views.get(CH)?.native?.state, "active");
  assert.notEqual(env.shield(), "unverified");
  assert.equal(env.views.get(CH)?.groupError ?? null, null);
  assert.deepEqual(storedPace(env), [], "m-c: reset on the join");
  m.close(CH);
  m.dispose();
});

test("FXP F-L6 MJ-1: a Welcome refused for unknown_identity after a pin that answered is processed once more in the same pass: it joins when the pin took; refused again it is retryable (paced at once), never hard", async () => {
  for (const takes of [true, false]) {
    const env = joiningEnv();
    joinSetsJoining(env);
    let n = 0;
    env.handlers.e2ee_text_process = (a) => {
      n++;
      if (n === 1 || !takes) throw leafRejected("unknown_identity");
      return welcomeJoinedAt(env, a);
    };
    const m = make(env);
    silence(m.ensureJoined(CH));
    await env.advance(0);
    env.group = groupBody({
      current_epoch: 4,
      member_added: addedAt(4),
      members: LISTED,
    });
    m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
    await env.advance(0);
    assert.deepEqual(env.pins, [{ userId: PEER, targets: ["dX"] }]);
    assert.equal(n, 2, "processed once more after the pin");
    if (takes) {
      assert.equal(env.views.get(CH)?.native?.state, "active");
      assert.notEqual(env.shield(), "unverified");
      assert.equal(intents(env), 1);
    } else {
      assert.equal(env.shield(), "unverified");
      await env.advance(joinRebroadcastDelayMs(0));
      assert.equal(intents(env), 2, "retryable: paced, though listed");
    }
    m.dispose();
  }
});

test("FXP F-L6 MJ-1: a hard refusal (identity_changed) gets no rejoin at the refused epoch while the member list holds the device, whatever the trigger; once the group moved past it ONE paced rejoin goes out though listed; a device gone from the list is rejoined at once", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  env.handlers.e2ee_text_process = () => {
    throw leafRejected("identity_changed");
  };
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  assert.deepEqual(p.err, { source: "client", reason: "join_failed" });
  assert.equal(env.calls("e2ee_text_process").length, 1, "no second pass");
  await m.open(CH);
  m.retryNow(CH);
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(3_600_000);
  assert.equal(intents(env), 1, "the refused epoch, still listed");
  env.group = groupBody({
    current_epoch: 9,
    member_added: addedAt(4),
    members: LISTED,
  });
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(1_000);
  assert.equal(intents(env), 2, "moved on: paced, though listed");
  assert.equal(env.shield(), "unverified", "the alarm stays");
  m.close(CH);
  m.dispose();

  const env2 = joiningEnv();
  joinSetsJoining(env2);
  env2.handlers.e2ee_text_process = () => {
    throw leafRejected("identity_changed");
  };
  const m2 = make(env2);
  silence(m2.ensureJoined(CH));
  await env2.advance(0);
  // The member list no longer holds the refused device: at once.
  env2.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
  m2.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env2.advance(joinRebroadcastDelayMs(0));
  assert.equal(intents(env2), 2, "gone from the list: at once");
  m2.dispose();
});

test("FXP F-L6 MJ-1: Try again (retryNow) evaluates the refused Welcome's rejoin under the same pace", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  env.handlers.e2ee_text_process = () => {
    throw leafRejected("identity_changed");
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  assert.equal(intents(env), 1);
  // The group moved on; nothing refreshed it yet.
  env.group = groupBody({
    current_epoch: 9,
    member_added: addedAt(4),
    members: LISTED,
  });
  m.retryNow(CH);
  await env.advance(0);
  assert.equal(intents(env), 2, "Try again grants");
  await refusedAt(env, m, 11, "W2");
  env.group = groupBody({
    current_epoch: 12,
    member_added: addedAt(11),
    members: LISTED,
  });
  m.retryNow(CH);
  await env.advance(0);
  assert.equal(intents(env), 2, "inside the window Try again grants nothing");
  m.dispose();
});

test("FXP F-L6 M1a/m-a: the pace and the alarm survive a reload: the reloaded device shows the refusal red, keeps the join blocked and fetches nothing inside the window; past it an open grants; the window doubles per grant", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  pinsFailInTransport(env);
  let epoch = 4;
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch, welcome: "V0VM" })),
  );
  env.handlers.e2ee_text_process = () => {
    throw leafRejected("unknown_identity");
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  assert.equal(intents(env), 2, "the first grant");
  epoch = 6;
  await refusedAt(env, m, 6, "W2");
  assert.equal(intents(env), 2);
  assert.ok(storedPace(env).length > 0, "persisted");
  m.close(CH);
  m.dispose();
  // A reload: a new manager over the same store.
  const m2 = make(env);
  await m2.open(CH);
  await env.advance(WELCOME_FETCH_AFTER_MS);
  assert.equal(env.shield(), "unverified", "m-a: the alarm is back");
  assert.equal(welcomeGets(env).length, 0, "blocked: nothing fetched");
  assert.equal(intents(env), 2, "the pace survived the reload");
  await env.advance(REFUSAL_PACE_BASE_MS);
  await m2.open(CH);
  await env.advance(0);
  assert.equal(intents(env), 3, "past the window: an open grants");
  epoch = 8;
  await refusedAt(env, m2, 8, "W3");
  await env.advance(REFUSAL_PACE_BASE_MS);
  await m2.open(CH);
  await env.advance(0);
  assert.equal(intents(env), 3, "the second window is doubled");
  await env.advance(REFUSAL_PACE_BASE_MS);
  await m2.open(CH);
  await env.advance(0);
  assert.equal(intents(env), 4);
  m2.close(CH);
  m2.dispose();
});

test("FXP F-L6 m-d: with every store write failing the pace holds in memory: a second refusal inside the window gets nothing", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  pinsFailInTransport(env);
  env.store.set = () => false;
  env.handlers.e2ee_text_process = () => {
    throw leafRejected("unknown_identity");
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  assert.equal(intents(env), 2, "the first grant");
  await refusedAt(env, m, 6, "W2");
  await m.open(CH);
  await env.advance(60_000);
  assert.equal(intents(env), 2, "the memory copy paces it");
  assert.equal(storedPace(env).length, 0, "nothing was stored");
  m.close(CH);
  m.dispose();
});

test("FXP F-L6 m-d: the stored pace merged with the memory one keeps the stricter: a grant whose write failed still doubles the window", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  pinsFailInTransport(env);
  const write = env.store.set;
  let failing = false;
  env.store.set = (k: string, v: string) => (failing ? false : write(k, v));
  env.handlers.e2ee_text_process = () => {
    throw leafRejected("unknown_identity");
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  assert.equal(intents(env), 2, "grant 1, stored");
  failing = true;
  await refusedAt(env, m, 6, "W2");
  await env.advance(REFUSAL_PACE_BASE_MS);
  await m.open(CH);
  await env.advance(0);
  assert.equal(intents(env), 3, "grant 2, in memory only");
  await refusedAt(env, m, 8, "W3");
  await env.advance(REFUSAL_PACE_BASE_MS + 60_000);
  await m.open(CH);
  await env.advance(0);
  assert.equal(intents(env), 3, "the doubled window of grant 2 holds");
  m.close(CH);
  m.dispose();
});

test("FXP F-L6 m-c: a stored grant stamped in the future is clamped to now once read: the window runs from then, never from that future time", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  pinsFailInTransport(env);
  env.storeMap.set(
    `${PROTECTED_REFUSAL_PACE_KEY_PREFIX}${SELF}:${CH}`,
    JSON.stringify({
      v: 2,
      entries: [
        {
          groupId: G0,
          userId: PEER,
          deviceId: "dX",
          epoch: 2,
          reason: "unknown_identity",
          grants: 1,
          atMs: env.clock + 10 * 86_400_000,
        },
      ],
    }),
  );
  env.handlers.e2ee_text_process = () => {
    throw leafRejected("unknown_identity");
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  // m4-3 (round 5): the stored refusal of the current group restores the
  // block at once (no Add needed), so even the first intent is paced; it
  // was 1 here through round 4 (no Add shown: no block).
  assert.equal(intents(env), 0, "the clamped window runs from now");
  await env.advance(REFUSAL_PACE_BASE_MS);
  await m.open(CH);
  await env.advance(0);
  assert.equal(intents(env), 1, "and ends a window later");
  m.close(CH);
  m.dispose();
});

test("FXP F-L6 m1: a refused Welcome whose Add is no longer the latest (a member re-added this device since) is never rejoined: the block lifts for the newer Add's Welcome path, which joins, with no intent", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  let epoch = 4;
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch, welcome: "V0VM" })),
  );
  env.handlers.e2ee_text_process = (a) => {
    if (a.envelope.epoch === 4) throw leafRejected("identity_changed");
    return welcomeJoinedAt(env, a);
  };
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  assert.deepEqual(p.err, { source: "client", reason: "join_failed" });
  // Re-added at epoch 6; its mailbox copy never came.
  epoch = 6;
  env.group = groupBody({
    current_epoch: 6,
    member_added: addedAt(6),
    members: LISTED,
  });
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(WELCOME_FETCH_AFTER_MS + 1_000);
  assert.equal(welcomeGets(env).length, 1, "the newer Add's stored Welcome");
  assert.equal(env.views.get(CH)?.native?.state, "active");
  assert.equal(intents(env), 1, "no rejoin evicted the fresh leaf");
  assert.ok(env.logs.some((l) => l.ids.step === "newer_add"));
  m.dispose();
});

test("FXP F-L6 MJ-2: a newer Add whose Welcome path ends without a join (404) restores the block and is judged under the same pace: lying member_added entries never buy more intents than the pace allows", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  env.handlers.e2ee_text_process = () => {
    throw leafRejected("identity_changed");
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  const lie = async (e: number) => {
    env.group = groupBody({
      current_epoch: e,
      member_added: addedAt(e),
      members: LISTED,
    });
    m.onChannelChanged(CH, ["text_group"]);
    await env.advance(WELCOME_FETCH_AFTER_MS + joinRebroadcastDelayMs(0));
  };
  await lie(6);
  assert.equal(welcomeGets(env).length, 1);
  assert.equal(intents(env), 2, "its 404, then the first paced grant");
  // The members' re-Add of that intent is refused again.
  await refusedAt(env, m, 7, "W2");
  await lie(9);
  await lie(11);
  assert.equal(welcomeGets(env).length, 3, "each newer Add's one fetch");
  assert.equal(intents(env), 2, "no intent past the pace");
  assert.equal(env.shield(), "unverified");
  m.dispose();
});

test("FXP F-L6: a later refusal of another kind on the same group (duplicate_leaf) keeps the join blocked and shown: no trigger grants for the older leaf refusal", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  pinsFailInTransport(env);
  env.handlers.e2ee_text_process = (a) => {
    if (a.envelope.id === "W1") throw leafRejected("unknown_identity");
    throw { type: "duplicate_leaf", group_id: G0 };
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({
    current_epoch: 4,
    member_added: addedAt(4),
    members: LISTED,
  });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  m.onEnvelope(envelope("W1b", 4, { content_type: "mls_welcome" }));
  await env.advance(10_000);
  assert.equal(env.views.get(CH)?.groupError, "duplicate_leaf");
  await m.open(CH);
  await env.advance(3_600_000);
  assert.equal(intents(env), 1);
  assert.equal(env.views.get(CH)?.groupError, "duplicate_leaf", "shown");
  m.close(CH);
  m.dispose();
});

test("FXP F-L7: a joiner's Welcome native discards for signer_leaf_missing while an owner change is pending waits parked: no rejoin intent, no stored fetch, nothing counted toward 6c; the confirm joins it with that ONE Add", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  let confirmed = false;
  ownerChangeUntil(env, () => confirmed);
  env.handlers.e2ee_text_process = (a) => {
    // Native step 8 reads the HELD list, whose signer's leaf is gone.
    if (!confirmed) throw SLM;
    return welcomeJoinedAt(env, a);
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    return null;
  };
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 1);
  assert.equal(env.views.get(CH)?.ownerChangePending, true);
  env.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(env.acks.includes("W1"), false, "parked, unacked");
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 0, "not 6c");
  await env.advance(6 * 3_600_000);
  assert.equal(intents(env), 1, "no rejoin while it waits");
  assert.equal(welcomeGets(env).length, 0, "no stored fetch either");
  assert.equal(p.done, false);
  await m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.equal(p.done, true);
  assert.equal(p.err, null, "joined from the parked Welcome");
  assert.equal(env.views.get(CH)?.native?.state, "active");
  assert.equal(intents(env), 1, "one Add");
  // m-e: later the leaf is lost while another owner change is pending: the
  // Add this device already joined from never holds its rejoin.
  env.states.set(CH, st({ state: "left", verdict: "no_group", epoch: 4 }));
  confirmed = false;
  silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 2, "the rejoin goes out at once");
  m.dispose();
});

test("FXP F-L7 m4: a Welcome native discards for signer_leaf_missing while the next intent is being minted, with native holding a pending signer by then, parks and stops that POST; the confirm joins it", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  let confirmed = false;
  env.handlers.e2ee_text_process = (a) => {
    if (!confirmed) throw SLM;
    return welcomeJoinedAt(env, a);
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    env.state().owner_pin.pending_signer = null;
    return null;
  };
  const late: { m: ProtectedTextManager | null } = { m: null };
  let puts = 0;
  env.routes.push((method, path) => {
    if (method === "PUT" && path === "/mls/key_packages" && ++puts === 2) {
      // The owner change reached native, then the Add's mailbox Welcome.
      env.state().owner_pin.pending_signer = { ...PENDING };
      late.m?.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
    }
    return undefined;
  });
  const m = make(env);
  late.m = m;
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 1);
  // A member admits intent 1; its stored Welcome is not served (404):
  // that Add's path is done and the next intent is minted.
  env.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
  await env.advance(joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS);
  assert.equal(welcomeGets(env).length, 1);
  assert.equal(puts, 2, "the next intent was minted");
  assert.equal(intents(env), 1, "but never posted");
  assert.equal(env.acks.includes("W1"), false, "parked");
  assert.ok(
    env.logs.some((l) =>
      l.msg.includes("join intent not posted: an owner change is pending"),
    ),
  );
  await env.advance(6 * 3_600_000);
  assert.equal(intents(env), 1, "held while parked");
  await m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.equal(p.done, true);
  assert.equal(p.err, null, "joined");
  assert.equal(intents(env), 1);
  m.dispose();
});

test("FXP F-L7 m4: a join step that resumes while the confirm replays the parked signer_leaf_missing Welcome stays held (no _join, no KeyPackage minted); the replayed Welcome joins it", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 4, welcome: "V0VM" })),
  );
  let confirmed = false;
  ownerChangeUntil(env, () => confirmed);
  env.handlers.e2ee_text_process = (a) => {
    if (!confirmed) throw SLM;
    return welcomeJoinedAt(env, a);
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    return null;
  };
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
  // 10 s wait, 20 s for the Welcome, the fetch: parked.
  await env.advance(30_000);
  assert.equal(env.calls("e2ee_text_process").length, 1, "parked");
  // The confirm's re-verify is slow: the join's next step coalesces with
  // it and resumes right after the confirm took the Welcome out of the
  // parked list to replay it.
  const gate: { release: (() => void) | null } = { release: null };
  const verify = env.handlers.e2ee_text_seat_list_verify!;
  env.handlers.e2ee_text_seat_list_verify = async (a) => {
    if (gate.release === null) {
      await new Promise<void>((r) => (gate.release = r));
    }
    return verify(a);
  };
  const joins = env.calls("e2ee_text_join").length;
  const puts = env.api$("PUT", /^\/mls\/key_packages$/).length;
  const confirm = m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.ok(gate.release !== null, "the confirm's verify is pending");
  await env.advance(20 * 60_000);
  gate.release!();
  await confirm;
  await env.advance(0);
  assert.equal(p.done, true);
  assert.equal(p.err, null, "joined from the replayed Welcome");
  assert.equal(env.calls("e2ee_text_join").length, joins, "no _join raced it");
  assert.equal(
    env.api$("PUT", /^\/mls\/key_packages$/).length,
    puts,
    "no KeyPackage minted",
  );
  assert.equal(intents(env), 1);
  m.dispose();
});

test("FXP F-L7 m4: a parked signer_leaf_missing Welcome the confirm drops as stale (the server moved to another group) while native asks again: the new group's Add has its stored Welcome parked the same way, and no intent or KeyPackage goes out", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  // OR-10: the confirm resolves, the next verify is owner_changed again.
  ownerChangeUntil(env, () => false);
  env.handlers.e2ee_text_process = () => {
    throw SLM;
  };
  env.handlers.e2ee_text_owner_confirm_change = () => null;
  env.routes.push((method, path) => {
    const m = /^\/mls\/groups\/([0-9a-f]+)\/welcome\?/.exec(path);
    if (method !== "GET" || !m) return undefined;
    return ok({ group_id: m[1], epoch: m[1] === G1 ? 5 : 4, welcome: "V0VM" });
  });
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 1);
  m.onEnvelope(envelope("W0", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(env.acks.includes("W0"), false, "parked");
  // The server moved to G1, where an Add of this device landed.
  env.group = groupBody({
    group_id: G1,
    generation: 1,
    current_epoch: 5,
    member_added: addedAt(5),
  });
  await m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.ok(env.acks.includes("W0"), "the stale parked Welcome is dropped");
  await env.advance(6 * 3_600_000);
  assert.equal(welcomeGets(env).length, 1, "the G1 Add's stored Welcome");
  assert.equal(intents(env), 1, "no intent while that Add waits");
  assert.equal(env.calls("e2ee_text_join").length, 1);
  assert.equal(env.api$("PUT", /^\/mls\/key_packages$/).length, 1);
  assert.equal(p.done, false);
  m.dispose();
});

test("FXP F-L7 m3: a Welcome native discarded for signer_leaf_missing before the owner change was known holds that Add's intents once native holds a pending signer (no KeyPackage minted); the confirm releases it (the Add, with no Welcome left, gets its rejoin), and so does the server's group moving on", async () => {
  const held = async (env: Env, flags: { pending: boolean }) => {
    joinSetsJoining(env);
    env.handlers.e2ee_text_process = () => {
      throw SLM;
    };
    const m = make(env);
    silence(m.ensureJoined(CH));
    await env.advance(0);
    env.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
    m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
    await env.advance(0);
    assert.ok(env.acks.includes("W1"), "no owner change yet: discarded");
    flags.pending = true;
    // Its stored Welcome is gone (404): the Add's path ends; it waits.
    await env.advance(3_600_000);
    assert.equal(welcomeGets(env).length, 1);
    assert.equal(intents(env), 1, "held");
    assert.equal(env.calls("e2ee_text_join").length, 1, "nothing minted");
    return m;
  };
  const env = joiningEnv();
  const f = { pending: false, confirmed: false };
  ownerChangeUntil(env, () => !f.pending || f.confirmed);
  env.handlers.e2ee_text_owner_confirm_change = () => {
    f.confirmed = true;
    return null;
  };
  const m = await held(env, f);
  await m.confirmOwnerChange(CH);
  await env.advance(joinRebroadcastDelayMs(0));
  assert.equal(intents(env), 2, "released by the confirm");
  m.dispose();

  const env2 = joiningEnv();
  const f2 = { pending: false };
  ownerChangeUntil(env2, () => !f2.pending);
  const m2 = await held(env2, f2);
  // A successor group without this device: nothing waits on that Add.
  env2.group = groupBody({
    group_id: G1,
    generation: 1,
    current_epoch: 0,
    members: [{ user_id: OWNER, device_id: OWNER_DEV }],
  });
  await env2.advance(16 * 60_000);
  assert.equal(intents(env2), 2, "released by the group move");
  assert.equal(intentGroups(env2).at(-1), G1);
  m2.dispose();
});

test("FXP F-L7 m5: a confirm whose replayed signer_leaf_missing Welcome is discarded again (no pending signer any more) ends the replay window: the rejoin that Add still needs goes out", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  let confirmed = false;
  ownerChangeUntil(env, () => confirmed);
  env.handlers.e2ee_text_process = () => {
    throw SLM;
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    return null;
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(3_600_000);
  assert.equal(intents(env), 1, "parked");
  await m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_process").length, 2, "replayed once");
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 1, "6c counted");
  await env.advance(joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS);
  assert.equal(intents(env), 2, "the rejoin goes out");
  m.dispose();
});

test("FXP F-L7 m5: a signer_leaf_missing Welcome for a group the server no longer names is never parked, even with an owner change pending: acked, and nothing queues behind it", async () => {
  const env = joiningEnv();
  ownerChangeUntil(env, () => false);
  env.group = groupBody({ group_id: G1, generation: 1, current_epoch: 0 });
  env.handlers.e2ee_text_process = (a) => {
    if (a.envelope.content_type === "mls_welcome") throw SLM;
    return outcome({ epoch: a.envelope.epoch, group_id: a.envelope.group_id });
  };
  const m = make(env);
  await m.refresh(CH, "commit");
  await env.advance(0);
  m.onEnvelope(
    envelope("W0", 4, { content_type: "mls_welcome", group_id: G0 }),
  );
  await env.advance(0);
  assert.ok(env.acks.includes("W0"), "acked: not parked");
  m.onEnvelope(envelope("C1", 1, { group_id: G1 }));
  await env.advance(0);
  assert.deepEqual(
    env.calls("e2ee_text_process").map((c) => c.envelope.id),
    ["W0", "C1"],
    "nothing parked behind it",
  );
  m.dispose();
});

test("FXP F-L7 m5: the owner change is native's pending signer: the manager's flag left set without one neither parks a signer_leaf_missing Welcome nor holds the intent", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  // Verify answers owner_changed (the manager's flag); then native adopts
  // a list without a confirm: no pending signer, the flag left set.
  const verify = env.handlers.e2ee_text_seat_list_verify!;
  let adopted = false;
  env.handlers.e2ee_text_seat_list_verify = (a) => {
    if (!adopted) throw OWNER_CHANGED;
    env.state().owner_pin.pending_signer = null;
    return verify(a);
  };
  env.handlers.e2ee_text_process = () => {
    throw SLM;
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  adopted = true;
  await m.refresh(CH, "interval");
  assert.equal(env.views.get(CH)?.ownerChangePending, true, "left set");
  assert.equal(env.views.get(CH)?.native?.owner_pin.pending_signer, null);
  env.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.ok(env.acks.includes("W1"), "discarded, not parked");
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 1);
  await env.advance(joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS);
  assert.equal(intents(env), 2, "the rejoin goes out");
  m.dispose();
});

test("FXP F-L7: a left device with an older Add and an owner change pending still sends its rejoin intent at once (an Add older than its intent is not held)", async () => {
  const env = new Env();
  joinSetsJoining(env);
  env.states.set(CH, st({ state: "left", verdict: "no_group" }));
  env.group = groupBody({ member_added: [OWN_ADDED(2)] });
  ownerChangeUntil(env, () => false);
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 1, "the rejoin intent at once");
  m.dispose();
});

test("FXP F-L6: after a reload the Add's stored Welcome, refused again for unknown_identity while the pin of that device fails in transport, starts its rejoin on that path (no open needed beyond the reload's)", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  pinsFailInTransport(env);
  // Native as an earlier session's `_join` left it (the reload).
  env.states.set(
    CH,
    st({ state: "joining", verdict: "joining", epoch: null, members: [] }),
  );
  env.group = groupBody({
    current_epoch: 4,
    member_added: addedAt(4),
    members: LISTED,
  });
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G0, epoch: 4, welcome: "V0VM" })),
  );
  env.handlers.e2ee_text_process = () => {
    throw leafRejected("unknown_identity");
  };
  const m = make(env);
  await m.open(CH);
  await env.advance(WELCOME_FETCH_AFTER_MS);
  assert.equal(welcomeGets(env).length, 1, "that Add's stored Welcome");
  assert.equal(intents(env), 1, "its rejoin intent");
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg === "[protected] refused welcome: join unblocked" &&
        l.ids.why === "stored",
    ),
  );
  assert.equal(env.shield(), "unverified", "the alarm stays");
  m.close(CH);
  m.dispose();
});

test("FXP F-L6 M2: a refused Welcome's alarm also ends when this device joins the channel's successor group by Welcome (the refused group superseded)", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  env.handlers.e2ee_text_process = (a) => {
    if (a.envelope.group_id === G0) throw leafRejected("identity_changed");
    env.states.set(
      CH,
      st({ group_id: G1, generation: 1, epoch: a.envelope.epoch }),
    );
    return outcome({
      kind: "welcome_joined",
      epoch: a.envelope.epoch,
      group_id: G1,
    });
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({
    current_epoch: 4,
    member_added: addedAt(4),
    members: LISTED,
  });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(10_000);
  assert.equal(env.shield(), "unverified");
  env.group = groupBody({
    group_id: G1,
    generation: 1,
    current_epoch: 1,
    member_added: addedAt(1),
  });
  m.onEnvelope(
    envelope("W2", 1, { content_type: "mls_welcome", group_id: G1 }),
  );
  await env.advance(0);
  assert.equal(env.views.get(CH)?.native?.group_id, G1);
  assert.notEqual(env.shield(), "unverified", "the alarm is over");
  m.dispose();
});

test("FXP F-L7 MJ-3: a Welcome parked for signer_leaf_missing is replayed as soon as a state read shows native settled the owner change without a confirm (a list adopted): it joins, the manager's flag clears, no intent", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  let adopted = false;
  ownerChangeUntil(env, () => adopted);
  env.handlers.e2ee_text_process = (a) => {
    if (!adopted) throw SLM;
    return welcomeJoinedAt(env, a);
  };
  const m = make(env);
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(3_600_000);
  assert.equal(env.acks.includes("W1"), false, "parked");
  assert.equal(p.done, false);
  // The owner signed its devices: native adopts the list, no confirm.
  adopted = true;
  m.onChannelChanged(CH, ["seats"]);
  await env.advance(1_000);
  assert.equal(p.done, true);
  assert.equal(p.err, null, "joined from the parked Welcome");
  assert.equal(env.views.get(CH)?.native?.state, "active");
  assert.equal(env.views.get(CH)?.ownerChangePending, false);
  assert.equal(env.calls("e2ee_text_owner_confirm_change").length, 0);
  assert.equal(intents(env), 1);
  m.dispose();
});

test("FXP F-L7 MJ-3: another user's pending signer (never confirmable) parks nothing: a signer_leaf_missing Welcome takes the S1 handling (discarded, counted toward 6c) and the intents are not held", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  env.handlers.e2ee_text_seat_list_verify = () => {
    env.state().owner_pin.pending_signer = { ...PENDING, same_user: false };
    throw { ...OWNER_CHANGED, same_user: false };
  };
  env.handlers.e2ee_text_process = () => {
    throw SLM;
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  env.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.ok(env.acks.includes("W1"), "discarded, not parked");
  assert.equal(env.views.get(CH)?.signerLeafMissingRetries, 1);
  await env.advance(joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS);
  assert.equal(intents(env), 2, "not held");
  m.dispose();
});

test("FXP F-L6 MJ-1: an own device's pin reports a stale cached listing (served after a failed fetch) as transport, so a Welcome refused for unknown_identity gets no second pass; a fresh listing answers and it is processed once more", async () => {
  // The bridge serves its cache while younger than 60 s, so an entry 60 s
  // old or older came after a failed fetch.
  for (const [age, stale] of [
    [10 * 60_000, true],
    [60_000, true],
    [1_000, false],
  ] as const) {
    const env = joiningEnv();
    joinSetsJoining(env);
    env.ownDeviceListing = async () => {
      const own = {
        hash: "h1",
        listing: [{ device_id: DEV }],
        at: env.clock - age,
      };
      return own;
    };
    env.handlers.e2ee_text_process = () => {
      throw {
        type: "mls_leaf_rejected",
        user_id: SELF,
        device_id: "dOwn",
        reason: "unknown_identity",
      };
    };
    const m = make(env);
    silence(m.ensureJoined(CH));
    await env.advance(0);
    env.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
    m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
    await env.advance(0);
    assert.equal(
      env.calls("e2ee_text_process").length,
      stale ? 1 : 2,
      stale ? "transport: no second pass" : "answered: once more",
    );
    m.dispose();
  }
});

/**
 * F-R8: the bridge's own-listing cache (`OwnListingCache`, as `e2ee.ts`
 * wires it) over a scripted `GET /e2ee/devices/{self}`: `server` is the
 * listed device ids, `fetches` counts the GETs, and while `hold` is set
 * each GET waits for its `releases[i]()`.
 */
class OwnListingRig {
  t = 1_700_000_000_000;
  server = [DEV];
  fetches = 0;
  fail = false;
  hold = false;
  releases: (() => void)[] = [];
  life: object = {};
  readonly cache: OwnListingCache;

  constructor(now?: () => number) {
    this.cache = new OwnListingCache(now ?? (() => this.t), () => this.life);
  }

  readonly load = async () => {
    this.fetches++;
    const listing = this.server.map((device_id) => ({ device_id }));
    if (this.hold) await new Promise<void>((r) => this.releases.push(r));
    if (this.fail) throw new Error("network");
    return { hash: JSON.stringify(listing), listing };
  };

  get(request?: OwnListingRequest) {
    return this.cache.get(this.load, request);
  }
}

/** One macrotask: a flight's fetch (a microtask after its start) began. */
const tick = () => new Promise<void>((r) => setImmediate(r));

function listedIds(own: { listing: unknown[] }): unknown[] {
  return own.listing.map((row) => (row as { device_id?: unknown }).device_id);
}

const A3 = "dev-a3";

test("F-R8: a new own device registered after the cache filled gets pinned on the first forced attempt; no poison, no successor", async () => {
  const env = new Env();
  const rig = new OwnListingRig(() => env.clock);
  env.ownDeviceListing = (request?: OwnListingRequest) => rig.get(request);
  // The cache filled; A3 registers 1 s later (well inside the 60 s).
  await env.ownDeviceListing();
  env.clock += 1_000;
  rig.server = [DEV, A3];
  // Native applies the commit adding A3 only once A3 is pinned.
  let refusals = 0;
  const pinsAfterRefusal: unknown[][] = [];
  env.handlers.e2ee_text_pin_own_devices = (a) => {
    if (refusals > 0) pinsAfterRefusal.push(listedIds({ listing: a.devices }));
    return null;
  };
  env.handlers.e2ee_text_process = (a) => {
    if (!pinsAfterRefusal.some((ids) => ids.includes(A3))) {
      refusals++;
      throw { type: "identity_pin_required", user_id: SELF, device_id: A3 };
    }
    return outcome({ epoch: a.envelope.epoch });
  };
  const m = make(env);
  m.channelProtected(CH);
  await env.advance(0);
  m.onEnvelope(
    envelope("E1", 4, { added: [{ user_id: SELF, device_id: A3 }] }),
  );
  await env.advance(0);

  // (a) The pin native asked for carries A3 on its FIRST forced call.
  assert.equal(refusals, 1, "native asked for one pin");
  assert.deepEqual(
    pinsAfterRefusal[0],
    [DEV, A3],
    "the first forced pin lists A3 despite a 1 s old cache without it",
  );
  assert.equal(rig.fetches, 2, "one fresh GET, for the forced pin");
  assert.deepEqual(
    listedIds(await env.ownDeviceListing()),
    [DEV, A3],
    "the forced answer refreshed the cache",
  );
  assert.equal(rig.fetches, 2);
  // No poison, no successor: the commit applies on the retry.
  assert.equal(env.calls("e2ee_text_process").length, 2);
  assert.deepEqual(env.acks, ["E1"]);
  assert.equal(env.views.get(CH)?.groupError ?? null, null, "no poison");
  assert.equal(env.calls("e2ee_text_group_create").length, 0, "no successor");
  m.dispose();
});

test("F-R8 (a): a forced own listing is fetched afresh inside the 60 s, never taken from the cache or from a flight begun before it was asked; later requests share it and it refreshes the cache", async () => {
  const rig = new OwnListingRig();
  const first = await rig.get();
  rig.t += 1_000;
  assert.equal(await rig.get(), first, "unforced inside 60 s: the cache");
  assert.equal(rig.fetches, 1);
  rig.server = [DEV, A3];
  const forced = await rig.get({ force: true });
  assert.equal(rig.fetches, 2, "forced: a fresh GET inside the 60 s");
  assert.deepEqual(listedIds(forced), [DEV, A3]);
  assert.equal(await rig.get(), forced, "the forced answer is cached");
  assert.equal(rig.fetches, 2);

  // A flight begun before the force (the cache past 60 s) is not handed
  // back; a request after the force shares the forced flight.
  rig.t += 60_000;
  rig.hold = true;
  const early = rig.get();
  await tick();
  rig.server = [DEV, A3, "dev-a4"];
  const late = rig.get({ force: true });
  const joined = rig.get();
  await tick();
  assert.equal(rig.fetches, 4, "the force did not join the earlier flight");
  // The forced GET answers first; the earlier one settling after it never
  // replaces the newer answer in the cache.
  rig.releases[1]();
  assert.deepEqual(listedIds(await late), [DEV, A3, "dev-a4"]);
  assert.equal(await joined, await late);
  rig.releases[0]();
  assert.deepEqual(listedIds(await early), [DEV, A3]);
  rig.hold = false;
  assert.equal(await rig.get(), await late, "the newer answer stays cached");
  assert.equal(rig.fetches, 4);
});

test("F-R8 (b): an unforced request for a device the cached listing lacks refetches; one the cache lists is served from it", async () => {
  const rig = new OwnListingRig();
  const first = await rig.get();
  rig.t += 1_000;
  rig.server = [DEV, A3];
  assert.equal(await rig.get({ want: [DEV] }), first, "a listed want");
  assert.equal(rig.fetches, 1);
  const wanted = await rig.get({ want: [A3] });
  assert.equal(rig.fetches, 2, "a missing want refetches inside the 60 s");
  assert.deepEqual(listedIds(wanted), [DEV, A3]);
  assert.equal(await rig.get({ want: [A3] }), wanted, "now cached");
  assert.equal(rig.fetches, 2);
});

test("F-R8: failure behaviour: a failed fetch still answers the cached entry (its `at` as it was), marked stale for a force or want request; no cache rethrows; an answer across a dispose is not cached", async () => {
  const rig = new OwnListingRig();
  const first = await rig.get();
  const at = first.at;
  rig.t += 1_000;
  rig.fail = true;
  assert.deepEqual(await rig.get({ force: true }), { ...first, stale: true });
  assert.deepEqual(await rig.get({ want: [A3] }), { ...first, stale: true });
  // An unforced request (the cache past 60 s) gets the entry as before.
  rig.t += 60_000;
  assert.equal(await rig.get(), first);
  assert.equal(first.at, at);
  assert.equal(first.stale, undefined);
  assert.equal(rig.fetches, 4);
  rig.cache.clear();
  await assert.rejects(rig.get({ force: true }));
  rig.fail = false;
  rig.hold = true;
  const across = rig.get();
  await tick();
  rig.life = {};
  rig.releases[0]();
  await across;
  rig.hold = false;
  assert.notEqual(await rig.get(), await across, "not cached across lives");
});

test("F-R8: force and want requests made in the same tick share ONE fetch; a forced request made after a fetch began gets a new one", async () => {
  const rig = new OwnListingRig();
  await rig.get();
  rig.t += 1_000;
  rig.server = [DEV, A3];
  const same = await Promise.all([
    rig.get({ force: true }),
    rig.get({ force: true }),
    rig.get({ want: [A3] }),
  ]);
  assert.equal(rig.fetches, 2, "one fetch for the three");
  assert.deepEqual(listedIds(same[0]), [DEV, A3]);
  assert.equal(same[1], same[0]);
  assert.equal(same[2], same[0]);

  rig.hold = true;
  const early = rig.get({ force: true });
  await tick();
  assert.equal(rig.fetches, 3, "its fetch began");
  rig.server = [DEV, A3, "dev-a4"];
  const late = rig.get({ force: true });
  await tick();
  assert.equal(rig.fetches, 4, "a force after the fetch began: a new one");
  rig.releases[1]();
  rig.releases[0]();
  assert.deepEqual(listedIds(await late), [DEV, A3, "dev-a4"]);
  assert.deepEqual(listedIds(await early), [DEV, A3]);
});

test("F-R8: an own pin whose forced fetch fails inside the 60 s reports transport (the stale fallback), so a Welcome refused for unknown_identity gets no second pass; a fetch that answers does", async () => {
  for (const fail of [true, false]) {
    const env = joiningEnv();
    joinSetsJoining(env);
    const rig = new OwnListingRig(() => env.clock);
    env.ownDeviceListing = (request?: OwnListingRequest) => rig.get(request);
    await env.ownDeviceListing();
    env.clock += 1_000;
    rig.fail = fail;
    env.handlers.e2ee_text_process = () => {
      throw {
        type: "mls_leaf_rejected",
        user_id: SELF,
        device_id: A3,
        reason: "unknown_identity",
      };
    };
    const m = make(env);
    silence(m.ensureJoined(CH));
    await env.advance(0);
    env.group = groupBody({ current_epoch: 4, member_added: addedAt(4) });
    m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
    await env.advance(0);
    assert.equal(rig.fetches, 2, `fail=${fail}: the forced fetch ran`);
    assert.equal(
      env.calls("e2ee_text_process").length,
      fail ? 1 : 2,
      fail ? "transport: no second pass" : "answered: once more",
    );
    m.dispose();
  }
});

test("FXP F-L6 M2: a member's re-Add that native accepts ends the refusal's alarm and its join block, with no grant", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  env.handlers.e2ee_text_process = (a) => {
    if (a.envelope.epoch === 4) throw leafRejected("identity_changed");
    return welcomeJoinedAt(env, a);
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  assert.equal(env.shield(), "unverified");
  assert.equal(intents(env), 1, "no grant");
  env.group = groupBody({
    current_epoch: 6,
    member_added: addedAt(6),
    members: LISTED,
  });
  m.onEnvelope(envelope("W2", 6, { content_type: "mls_welcome" }));
  await env.advance(0);
  assert.equal(env.views.get(CH)?.native?.state, "active");
  assert.notEqual(env.shield(), "unverified", "alarm and block over");
  assert.equal(env.views.get(CH)?.groupError ?? null, null);
  m.dispose();
});

test("FXP F-L7 m5: a successor's Welcome queued behind a parked owner_changed commit and replayed by the confirm keeps the join held while the replay runs (no _join, no KeyPackage minted); it joins", async () => {
  const env = new Env();
  let confirmed = false;
  ownerChangeUntil(env, () => confirmed);
  const gateW: { release: (() => void) | null } = { release: null };
  env.handlers.e2ee_text_process = async (a) => {
    if (!confirmed) throw OWNER_CHANGED;
    if (a.envelope.content_type === "mls_welcome") {
      // The replayed Welcome is slow (a native lock).
      await new Promise<void>((r) => (gateW.release = r));
      env.states.set(
        CH,
        st({ group_id: G1, generation: 1, epoch: a.envelope.epoch }),
      );
      return outcome({
        kind: "welcome_joined",
        epoch: a.envelope.epoch,
        group_id: G1,
      });
    }
    return outcome({ epoch: a.envelope.epoch, group_id: a.envelope.group_id });
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    confirmed = true;
    return null;
  };
  // This device holds G0; the server's group is the successor G1.
  env.group = groupBody({ group_id: G1, generation: 1, current_epoch: 0 });
  const m = make(env);
  await m.refresh(CH, "commit");
  const p = endedOf(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intentGroups(env).at(-1), G1);
  env.group = groupBody({
    group_id: G1,
    generation: 1,
    current_epoch: 1,
    member_added: addedAt(1),
  });
  // A commit of G0 parks behind the owner change (D15); the Add's stored
  // Welcome of G1, fetched by its path, queues behind it.
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G1, epoch: 1, welcome: "V0VM" })),
  );
  m.onEnvelope(envelope("C4", 4));
  await env.advance(3_600_000);
  assert.equal(welcomeGets(env).length, 1, "that Add's path ran: parked");
  assert.equal(intents(env), 1, "held while parked");
  // The confirm's re-verify is slow: the join's next step coalesces with it
  // and resumes while the confirm's replay of W1 is still running.
  const gateV: { release: (() => void) | null } = { release: null };
  const verify = env.handlers.e2ee_text_seat_list_verify!;
  env.handlers.e2ee_text_seat_list_verify = async (a) => {
    if (gateV.release === null) {
      await new Promise<void>((r) => (gateV.release = r));
    }
    return verify(a);
  };
  const joins = env.calls("e2ee_text_join").length;
  const puts = env.api$("PUT", /^\/mls\/key_packages$/).length;
  const confirm = m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.ok(gateV.release !== null, "the confirm's verify is pending");
  await env.advance(20 * 60_000);
  gateV.release!();
  await env.advance(0);
  assert.ok(gateW.release !== null, "the replay of W1 is running");
  await env.advance(20 * 60_000);
  gateW.release!();
  await confirm;
  await env.advance(0);
  assert.equal(p.done, true);
  assert.equal(p.err, null, "joined from the replayed Welcome");
  assert.equal(env.views.get(CH)?.native?.group_id, G1);
  assert.equal(env.calls("e2ee_text_join").length, joins, "no _join raced it");
  assert.equal(
    env.api$("PUT", /^\/mls\/key_packages$/).length,
    puts,
    "no KeyPackage minted",
  );
  m.dispose();
});

test("FXP F-L6 MJ-2b: a newer Add below the epoch of this device's last intent (its Welcome path never runs) lifts nothing: across many refreshes at most one intent per pace window", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  env.handlers.e2ee_text_process = () => {
    throw leafRejected("identity_changed");
  };
  // The server reports a high epoch when this device sends its intent.
  env.group = groupBody({ current_epoch: 20, members: LISTED });
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  assert.equal(intents(env), 1);
  const added = (e: number) =>
    groupBody({ current_epoch: 20, member_added: addedAt(e), members: LISTED });
  env.group = added(4);
  m.onEnvelope(envelope("W1", 4, { content_type: "mls_welcome" }));
  await env.advance(joinRebroadcastDelayMs(0));
  assert.equal(intents(env), 2, "hard, moved on: the first paced grant");
  env.group = added(5);
  m.onEnvelope(envelope("W2", 5, { content_type: "mls_welcome" }));
  await env.advance(joinRebroadcastDelayMs(0));
  // Fake newer Adds, each below 20: no path runs for them.
  for (let e = 6; e <= 12; e++) {
    env.group = added(e);
    m.onChannelChanged(CH, ["text_group"]);
    await env.advance(5_000);
  }
  assert.equal(welcomeGets(env).length, 0, "no path ran");
  assert.equal(intents(env), 2, "no intent past the pace");
  m.dispose();
});

test("FXP F-L6 MJ-2b: after a reload with a newer Add than the refused one the block is restored and that Add is paced: its 404 path ends in no intent inside the window", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  pinsFailInTransport(env);
  env.handlers.e2ee_text_process = () => {
    throw leafRejected("unknown_identity");
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  assert.equal(intents(env), 2, "the first grant");
  await refusedAt(env, m, 6, "W2");
  m.dispose();
  // A newer Add the reloaded device never saw a Welcome for.
  env.group = groupBody({
    current_epoch: 8,
    member_added: addedAt(8),
    members: LISTED,
  });
  const m2 = make(env);
  await m2.open(CH);
  await env.advance(WELCOME_FETCH_AFTER_MS + 60_000);
  assert.equal(env.shield(), "unverified", "the block and alarm are back");
  assert.equal(welcomeGets(env).length, 1, "that Add's one path (404)");
  assert.equal(intents(env), 2, "paced: no intent in the window");
  m2.close(CH);
  m2.dispose();
});

test("FXP F-L6 m3-2: a second refused device of the same group starts from the group's pace: two refused devices give one immediate grant, not two", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  pinsFailInTransport(env);
  let device = "dX";
  env.handlers.e2ee_text_process = () => {
    throw { ...leafRejected("unknown_identity"), device_id: device };
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  await refusedAt(env, m, 4, "W1");
  assert.equal(intents(env), 2, "one immediate grant");
  device = "dY";
  await refusedAt(env, m, 6, "W2");
  m.onChannelChanged(CH, ["text_group"]);
  // A grant's intent leaves on the join backoff: look for 10 min, still
  // inside the first grant's 15 min window.
  await env.advance(10 * 60_000);
  assert.equal(intents(env), 2, "the new device inherits the window");
  m.dispose();
});

test("FXP F-L6 m4-2: refused devices alternating X, Y, X get one grant per pace window: the group's pace, never a device's own laxer one", async () => {
  const env = joiningEnv();
  joinSetsJoining(env);
  pinsFailInTransport(env);
  let device = "dX";
  env.handlers.e2ee_text_process = () => {
    throw { ...leafRejected("unknown_identity"), device_id: device };
  };
  const m = make(env);
  silence(m.ensureJoined(CH));
  await env.advance(0);
  // Window 1 (15 min from the first grant).
  await refusedAt(env, m, 4, "W1");
  assert.equal(intents(env), 2, "window 1: the grant");
  device = "dY";
  await refusedAt(env, m, 6, "W2");
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(10 * 60_000);
  assert.equal(intents(env), 2, "window 1: Y gets none");
  // Window 2 (30 min from the second grant).
  await env.advance(6 * 60_000);
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(1_000);
  const second = intents(env);
  assert.ok(second > 2, "window 2: the grant");
  device = "dX";
  await refusedAt(env, m, 8, "W3");
  const afterX = intents(env);
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(20 * 60_000);
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(1_000);
  assert.equal(intents(env), afterX, "window 2: X again gets none");
  // Window 3.
  await env.advance(11 * 60_000);
  m.onChannelChanged(CH, ["text_group"]);
  await env.advance(1_000);
  assert.ok(intents(env) > afterX, "window 3: the grant");
  m.dispose();
});

test("FXP F-L6 m4-3: after a reload the block is restored whatever Add of this device the server shows (none, or one older than the refused Welcome): paced, no intent inside the window", async () => {
  for (const [label, hidden] of [
    ["no Add", []],
    ["an older Add", addedAt(2)],
  ] as const) {
    const env = joiningEnv();
    joinSetsJoining(env);
    pinsFailInTransport(env);
    env.handlers.e2ee_text_process = () => {
      throw leafRejected("unknown_identity");
    };
    const m = make(env);
    silence(m.ensureJoined(CH));
    await env.advance(0);
    await refusedAt(env, m, 4, "W1");
    assert.equal(intents(env), 2, `${label}: the first grant`);
    await refusedAt(env, m, 6, "W2");
    m.dispose();
    env.group = groupBody({
      current_epoch: 8,
      member_added: hidden,
      members: LISTED,
    });
    const m2 = make(env);
    await m2.open(CH);
    await env.advance(WELCOME_FETCH_AFTER_MS + 60_000);
    assert.equal(env.shield(), "unverified", `${label}: blocked, alarm`);
    assert.equal(intents(env), 2, `${label}: paced, no intent`);
    m2.close(CH);
    m2.dispose();
  }
});

test("FXP F-L7 m3-1: a confirm whose replay re-parks the owner_changed commit (a second same-user signer) keeps the Welcome queued behind it; once native adopts a list without a confirm, both are replayed and the Welcome joins", async () => {
  const env = new Env();
  // 0: before the confirm; 1: a second signer after it; 2: list adopted.
  let phase = 0;
  env.handlers.e2ee_text_process = (a) => {
    if (phase === 0) throw OWNER_CHANGED;
    if (phase === 1) throw { ...OWNER_CHANGED, signer_device_id: "dev-o3" };
    if (a.envelope.content_type === "mls_welcome") {
      env.states.set(
        CH,
        st({ group_id: G1, generation: 1, epoch: a.envelope.epoch }),
      );
      return outcome({
        kind: "welcome_joined",
        epoch: a.envelope.epoch,
        group_id: G1,
      });
    }
    return outcome({ epoch: a.envelope.epoch, group_id: a.envelope.group_id });
  };
  env.handlers.e2ee_text_owner_confirm_change = () => {
    phase = 1;
    return null;
  };
  env.group = groupBody({
    group_id: G1,
    generation: 1,
    current_epoch: 1,
    member_added: addedAt(1),
  });
  const m = make(env);
  await m.refresh(CH, "commit");
  m.onEnvelope(envelope("C4", 4));
  await env.advance(0);
  m.onEnvelope(
    envelope("W1", 1, { content_type: "mls_welcome", group_id: G1 }),
  );
  await env.advance(0);
  const ids = () => env.calls("e2ee_text_process").map((c) => c.envelope.id);
  assert.deepEqual(ids(), ["C4"], "W1 queued behind C4");
  await m.confirmOwnerChange(CH);
  await env.advance(0);
  assert.deepEqual(ids(), ["C4", "C4"], "C4 re-parked, W1 pushed back");
  // Native adopts a list: no pending signer, no confirm.
  phase = 2;
  env.state().owner_pin.pending_signer = null;
  m.onChannelChanged(CH, ["seats"]);
  await env.advance(1_000);
  assert.deepEqual(ids(), ["C4", "C4", "C4", "W1"], "both replayed");
  assert.equal(env.views.get(CH)?.native?.group_id, G1);
  assert.equal(env.views.get(CH)?.native?.state, "active");
  m.dispose();
});

test("FXP F-L7 m4-1: a Welcome parked behind a commit parked for another user's owner change (no same-user pending signer: nothing here settles it) ends the join loudly: no intent across refreshes, opens and a day, the owner-change notice shown", async () => {
  const env = new Env();
  env.handlers.e2ee_text_process = () => {
    throw { ...OWNER_CHANGED, same_user: false };
  };
  env.group = groupBody({
    group_id: G1,
    generation: 1,
    current_epoch: 1,
    member_added: addedAt(1),
  });
  env.routes.push(
    welcomeRoute(() => ok({ group_id: G1, epoch: 1, welcome: "V0VM" })),
  );
  const m = make(env);
  await m.refresh(CH, "commit");
  m.onEnvelope(envelope("C4", 4));
  await env.advance(joinRebroadcastDelayMs(0) + WELCOME_FETCH_AFTER_MS);
  assert.equal(welcomeGets(env).length, 1, "the Add's Welcome, parked");
  assert.equal(
    env.state().owner_pin.pending_signer?.same_user,
    false,
    "another user's pending signer",
  );
  const before = intents(env);
  for (let i = 0; i < 6; i++) {
    await m.refresh(CH, i % 2 === 0 ? "commit" : "open");
    m.onChannelChanged(CH, ["text_group"]);
    await env.advance(10 * 60_000);
  }
  await env.advance(24 * 3_600_000);
  assert.equal(intents(env), before, "no intent while the park stands");
  assert.equal(welcomeGets(env).length, 1, "no second fetch");
  assert.equal(env.views.get(CH)?.groupError, "owner_changed");
  assert.deepEqual(env.explain(), {
    state: "unverified",
    notice: "owner_changed_review",
  });
  assert.ok(
    env.logs.some(
      (l) =>
        l.msg ===
        "[protected] join ended: welcome parked behind an owner change",
    ),
  );
  m.dispose();
});

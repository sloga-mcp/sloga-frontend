// Spec for the S4 history side of the Protected channels text-plane manager
// (W4 lane L2m): the link PUTs (committer, successor creator, member duty,
// catch-up pass), the owner's contest check, the walk behind
// `HistoryOps.requestWalk`, the history policy callback, the owner calls
// and the backup refresh count. Run with Node's built-in runner:
//   node --test --conditions=browser components/client/protectedTextHistory.test.ts
// Everything runs over a FAKE port: a virtual clock (`advance`), a scripted
// native (`handlers`), a scripted courier (`routes`) with a small history
// link store, and the REAL message flow `decryptRow` (B4) so the walk is
// asked for exactly the way production asks. Nothing here talks to a
// server. The flag-off test is the counterpart of protectedText.test.ts,
// whose port has no `historySetting` at all.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MlsMemberDevice } from "./e2ee";
import type { OwnListingRequest } from "./protectedOwnListing.ts";
import { historyFloorNotice } from "./protectedShield.ts";
import {
  type ProtectedTextHistoryDeps,
  type ProtectedTextPortExtensions,
  BACKUP_REFRESH_EPOCHS,
  HISTORY_LINK_PAGE,
  HISTORY_LINK_PAGE_ONE,
  ProtectedTextManager,
} from "./protectedText.ts";
import { textGroupId } from "./protectedTextIds.ts";
import {
  _resetMessageFlowsForTest,
  decryptRow,
  markerForError,
} from "./protectedTextMessages.ts";
import { recoverOwnership } from "./protectedTextOwner.ts";
import type {
  HistoryImported,
  HistoryLinkBuilt,
  HistoryLinkWire,
  MessageFlows,
  OwnerFlows,
  PendingCommit,
  ProtectedChannelView,
  ProtectedMessageRow,
  ProtectedMessageView,
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

const CH = "01J9Z3K4M5N6P7Q8R9S0T1V2W3";
const SELF = "USELF";
const DEV = "dev-self";
const OWNER = "UOWNER";
const OWNER_DEV = "dev-owner";
const PEER = "UPEER";
const PEER_DEV = "dev-peer";
const G0 = await textGroupId(CH, 0);
const G1 = await textGroupId(CH, 1);

/** ULIDs around a history boundary (the first ten characters are the time). */
const BOUNDARY = "01J9Z3K4M50000000000000000";
const BELOW = "01J9Z3K4M40000000000000000";

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

function ok(body: unknown, status = 200): TextApiResponse {
  return { status, resetAfterMs: null, body };
}

/** A history link: holder (group, epoch) carrying the keys of `prev`. */
function link(
  group_id: string,
  epoch: number,
  prev_group_id = group_id,
  prev_epoch = epoch - 1,
  writer: MlsMemberDevice = { user_id: OWNER, device_id: OWNER_DEV },
): HistoryLinkWire {
  return {
    group_id,
    epoch,
    prev_group_id,
    prev_epoch,
    nonce: `N-${epoch}`,
    ciphertext: `LINK-${group_id.slice(0, 4)}-${epoch}`,
    writer_user_id: writer.user_id,
    writer_device_id: writer.device_id,
    signature: `S-${epoch}`,
  };
}

/** An encrypted message row of `epoch` in `group`. */
function row(id: string, epoch: number, group = G0, author = PEER) {
  const r: ProtectedMessageRow = {
    id,
    channelId: CH,
    authorId: author,
    nonce: `CID-${id}`,
    encrypted: {
      v: 1,
      group_id: group,
      epoch,
      sender_device_id: PEER_DEV,
      nonce: "AEAD",
      ciphertext: "CT",
      sig: "SIG",
    },
  };
  return r;
}

/** A pre-protect row: no `encrypted`. */
function plainRow(id: string) {
  const r: ProtectedMessageRow = {
    id,
    channelId: CH,
    authorId: PEER,
    nonce: null,
    encrypted: null,
  };
  return r;
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
  ms: number;
  resolve: () => void;
}

/** See protectedText.test.ts `flush`: the id index digests run in real time. */
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
  /** The server's `history_setting` advert. */
  flag = true;
  serverOwner = OWNER;
  clock = 1_700_000_000_000;
  sleeps: Sleep[] = [];
  states = new Map<string, TextChannelState>([[CH, st()]]);
  invokes: { cmd: TextCommand; args: unknown }[] = [];
  handlers: Handlers;
  apiCalls: {
    method: string;
    path: string;
    body: unknown;
    /** The body object itself, as the manager handed it over. */
    raw: unknown;
    at: number;
  }[] = [];
  routes: Route[] = [];
  logs: { level: string; msg: string; ids: TextLogIds }[] = [];
  notified: string[] = [];
  storeMap = new Map<string, string>();
  seats: Record<string, unknown> | null = seatsBody();
  group: Record<string, unknown> | null = groupBody();
  pending: PendingCommit | null = null;
  views = new Map<string, ProtectedChannelView>();
  /** Every `historyWalk` value `onView` carried, without repeats. */
  walkStates: string[] = [];
  msgViews = new Map<string, ProtectedMessageView>();
  markers: TimelineMarker[] = [];
  policies: { channelId: string; p: unknown }[] = [];
  backupRefreshes = 0;
  /** Stored commit rows (served by `GET .../commits?from_epoch=`). */
  rows: Record<string, unknown>[] = [];
  /** The server's stored history links. */
  links: HistoryLinkWire[] = [];
  /** The most rows the fake server puts on one link page. */
  pageCap = 200;
  /** Scripted answers of the next link PUTs (default: 204, stored). */
  putAnswers: (TextApiResponse | "transport")[] = [];
  /** `group:epoch` native holds message keys for. */
  held = new Set<string>();
  /** The last epoch of a group, for `unknown_epoch.current`. */
  tops = new Map<string, number>();
  /** `_history_link_build`: the answer for a holder (default: its link). */
  build: (groupId: string, epoch: number) => HistoryLinkBuilt = (g, e) => ({
    link: link(g, e, g, e - 1, { user_id: SELF, device_id: DEV }),
    contest: false,
    mismatched_writers: [],
    refused: null,
  });
  /** `_commit_won`: the committer's link (null: none). */
  wonLink: ((epoch: number) => HistoryLinkWire) | null = (e) =>
    link(G0, e, G0, e - 1, { user_id: SELF, device_id: DEV });
  wonKind: TextProcessOutcome["kind"] = "commit_applied";
  /** `_history_import`: held until it resolves. */
  importGate: Promise<void> | null = null;
  /** `_history_import`: rejects with this. */
  importFail: unknown = null;
  /** `_history_import`: the stop native names where the links end. */
  stop = "missing";

  constructor() {
    _resetMessageFlowsForTest();
    this.handlers = defaultHandlers(this);
    for (let e = 0; e <= 3; e++) this.held.add(`${G0}:${e}`);
  }

  historySetting(): boolean {
    return this.flag;
  }

  state(ch = CH): TextChannelState {
    const s = this.states.get(ch);
    assert.ok(s, "state");
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

  linkGets() {
    return this.api$("GET", /\/history_links\?/);
  }

  linkPuts() {
    return this.api$("PUT", /\/history_links\//);
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

  async pinCallIdentities(_userId: string, targets: string[]) {
    return targets;
  }

  async ownDeviceListing(
    _request?: OwnListingRequest,
  ): Promise<{ hash: string; listing: unknown[] }> {
    return { hash: "h1", listing: [{ device_id: DEV }] };
  }

  async api(method: string, path: string, body?: unknown) {
    this.apiCalls.push({
      method,
      path,
      body: structuredClone(body),
      raw: body,
      at: this.clock,
    });
    for (const r of [...this.routes, defaultRoute(this)]) {
      const a = r(method, path, body);
      if (a === "transport") throw new Error("network");
      if (a !== undefined) return a;
    }
    return ok({ type: "NotFound" }, 404);
  }

  async ack() {
    return undefined;
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
      const s: Sleep = { at: this.clock + ms, ms, resolve };
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

  logged(level: string, re: RegExp) {
    return this.logs.filter((l) => l.level === level && re.test(l.msg));
  }

  channelInfo(channelId: string) {
    return {
      channelId,
      name: "general",
      serverId: "SERVER",
      serverOwnerId: this.serverOwner,
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
    return new Set<string>();
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

  /** This device is a device of the channel's owner. */
  ownerDevice() {
    this.serverOwner = SELF;
    const s = this.state();
    s.owner_pin = {
      ...s.owner_pin,
      owner_user_id: SELF,
      owner_device_id: DEV,
    };
    assert.ok(s.seat_list);
    s.seat_list = {
      ...s.seat_list,
      signer_user_id: SELF,
      signer_device_id: DEV,
    };
    assert.ok(this.seats);
    this.seats = seatsBody({
      list: {
        version: 1,
        body: "sloga-seat-list-v1\n...",
        signature: "SIG",
        signer_user_id: SELF,
        signer_device_id: DEV,
        handovers: [],
      },
    });
  }

  /** Self at leaf `index` of the held roster (the D19 stagger). */
  leaf(index: number) {
    const others = [mem(OWNER, OWNER_DEV), mem(PEER, PEER_DEV)];
    others.splice(index, 0, mem(SELF, DEV));
    this.state().members = others;
  }
}

function defaultHandlers(env: Env): Handlers {
  const stage = (p: TextSubmitCommitPayload) => {
    env.pending = { epoch: p.epoch, commit_b64: p.commit };
    return p;
  };
  const next = () => (env.state().epoch ?? 0) + 1;
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
      env.held.add(`${a.envelope.group_id}:${a.envelope.epoch}`);
      return outcome({
        epoch: a.envelope.epoch,
        group_id: a.envelope.group_id,
      });
    },
    e2ee_text_update: () =>
      stage({ device_id: DEV, epoch: next(), commit: "UPD", welcome: null }),
    e2ee_text_remove: () =>
      stage({ device_id: DEV, epoch: next(), commit: "REM", welcome: null }),
    e2ee_text_commit_won: (a) => {
      const s = env.state();
      s.epoch = a.wonEpoch;
      s.update_due = false;
      s.update_required = false;
      env.pending = null;
      env.held.add(`${a.groupId}:${a.wonEpoch}`);
      const out = outcome({
        epoch: a.wonEpoch,
        group_id: a.groupId,
        kind: env.wonKind,
      });
      if (env.wonLink) out.history_link = env.wonLink(a.wonEpoch);
      return out;
    },
    e2ee_text_commit_lost: () => {
      env.pending = null;
      return null;
    },
    e2ee_text_pending_commit: () => env.pending,
    e2ee_text_mark_left: () => null,
    e2ee_text_group_create: (a) => {
      const generation = a.supersedes ? 1 : 0;
      const group_id = generation ? G1 : G0;
      env.states.set(
        a.channelId,
        st({ group_id, generation, epoch: 0, members: [mem(SELF, DEV)] }),
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
    e2ee_text_history_link_build: (a) => env.build(a.groupId, a.epoch),
    e2ee_text_history_import: async (a) => {
      if (env.importGate) await env.importGate;
      if (env.importFail !== null) throw env.importFail;
      // One holder after the other, highest first: its first candidate
      // brings the keys of the epoch it names; a holder without a link is
      // where the walk stops.
      const imported: HistoryImported["imported"] = [];
      const s = env.state();
      for (const step of a.steps) {
        const c = step.candidates[0];
        if (!c) {
          const floor = {
            group_id: step.holder_group_id,
            epoch: step.holder_epoch,
          };
          s.history_floor = { ...floor, stopped: env.stop as "missing" };
          return {
            session: "SESSION",
            need_more: false,
            imported,
            floor,
            stopped: env.stop as "missing",
            refused: [],
          };
        }
        env.held.add(`${c.prev_group_id}:${c.prev_epoch}`);
        imported.push({ group_id: c.prev_group_id, epoch: c.prev_epoch });
        s.history_floor = {
          group_id: c.prev_group_id,
          epoch: c.prev_epoch,
          stopped: null,
        };
      }
      return {
        session: "SESSION",
        need_more: true,
        imported,
        floor: null,
        stopped: null,
        refused: [],
      };
    },
    e2ee_text_decrypt: (a) => {
      const e = a.encrypted;
      if (!env.held.has(`${e.group_id}:${e.epoch}`)) {
        throw {
          type: "unknown_epoch",
          group_id: e.group_id,
          epoch: e.epoch,
          current: env.tops.get(e.group_id) ?? env.state().epoch ?? 0,
          removed_self: false,
        };
      }
      return {
        message_id: a.messageId,
        channel_id: a.channelId,
        group_id: e.group_id,
        epoch: e.epoch,
        author_user_id: a.authorUserId,
        sender_device_id: e.sender_device_id,
        cid: a.nonce,
        ts: 0,
        text: `text of ${a.messageId}`,
        replies: [],
        sender_verified: true,
        ts_skew: false,
        files: [],
        timing_unverified: false,
      };
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
      const b = body as TextSubmitCommitPayload;
      const group_id = path.split("/")[3];
      env.rows.push({
        group_id,
        epoch: b.epoch,
        committer: { user_id: SELF, device_id: b.device_id },
        commit: b.commit,
        added: b.added ?? [],
        removed: b.removed ?? [],
      });
      return ok({ result: "Won" });
    }
    if (method === "GET" && /\/commits\?from_epoch=/.test(path)) {
      const group_id = path.split("/")[3];
      const from = Number(path.split("from_epoch=")[1]);
      const commits = env.rows.filter(
        (r) => r.group_id === group_id && (r.epoch as number) >= from,
      );
      return ok({ commits, current_epoch: env.tops.get(group_id) ?? 3 });
    }
    const page =
      /^\/mls\/groups\/([^/]+)\/history_links\?(?:before=(\d+)&)?limit=(\d+)$/.exec(
        path,
      );
    if (method === "GET" && page) {
      const [, group_id, before, limit] = page;
      const cap = Math.min(Number(limit), env.pageCap);
      const below = env.links
        .filter(
          (l) =>
            l.group_id === group_id &&
            (before === undefined || l.epoch < Number(before)),
        )
        .sort((a, b) => b.epoch - a.epoch);
      // Newest holder first, and an epoch's candidates are never split.
      const links: HistoryLinkWire[] = [];
      for (const l of below) {
        if (links.length >= cap && links[links.length - 1].epoch !== l.epoch) {
          break;
        }
        links.push(l);
      }
      return ok({ links });
    }
    if (
      method === "PUT" &&
      /\/history_links\/\d+(\?contest=true)?$/.test(path)
    ) {
      const scripted = env.putAnswers.shift();
      if (scripted !== undefined) return scripted;
      env.links.push(body as HistoryLinkWire);
      return ok(null, 204);
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

type Deps = ProtectedTextManagerDeps & Partial<ProtectedTextHistoryDeps>;

function fakeDeps(
  env: Env,
  over: {
    owner?: Partial<OwnerFlows>;
    messages?: Partial<MessageFlows>;
    history?: Partial<ProtectedTextHistoryDeps>;
  } = {},
): Deps {
  return {
    owner: {
      protect: async () => undefined,
      setSeats: async () => undefined,
      signOwnerDevices: async () => undefined,
      moveOwnerKey: async () => undefined,
      pendingSeats: () => null,
      cancelPendingSeats: () => ({ discarded: false, why: "none" }),
      recoverOwnership,
      setHistory: async () => undefined,
      wipeHistory: async () => undefined,
      ...over.owner,
    },
    messages: {
      encryptAndSend: async () => {
        throw new Error("no send in this spec");
      },
      // The real row flow: it is what asks the manager for a walk.
      decryptRow,
      markerForError,
      ...over.messages,
    },
    requestBackupRefresh: () => {
      env.backupRefreshes += 1;
    },
    pinHistory: () => null,
    preHistoryState: () => ({ conflicted: false, wiped: false }),
    ...over.history,
  };
}

function make(env: Env, deps?: ProtectedTextManagerDeps) {
  return new ProtectedTextManager(
    env,
    {
      onView: (ch, v) => {
        env.views.set(ch, v);
        if (env.walkStates.at(-1) !== v.historyWalk) {
          env.walkStates.push(v.historyWalk);
        }
      },
      onMessageView: (id, v) => env.msgViews.set(id, v),
      onTimelineMarker: (_ch, m) => env.markers.push(m),
      onHistoryPolicy: (channelId, p) =>
        env.policies.push({ channelId, p: structuredClone(p) }),
      onGroupReported: () => undefined,
    } as ConstructorParameters<typeof ProtectedTextManager>[1],
    deps ?? fakeDeps(env),
  );
}

/** A manager with the channel's state read once. */
async function ready(env: Env, deps?: ProtectedTextManagerDeps) {
  const m = make(env, deps);
  await m.refresh(CH, "open");
  await env.advance(0);
  return m;
}

/** One commit of this device that the server accepts (a Remove of PEER). */
function removePeer(m: ProtectedTextManager) {
  return m.removeDevices(CH, [{ user_id: PEER, device_id: PEER_DEV }], {
    rejoinIntent: null,
  });
}

/**
 * `removePeer`, settled without the clock moving: a commit that waited for
 * anything timed (a link PUT's backoff) fails here instead of hanging.
 */
async function commit(m: ProtectedTextManager) {
  let settled = false;
  const done = removePeer(m).then(() => {
    settled = true;
  });
  done.catch(() => undefined);
  await flush();
  assert.equal(settled, true, "the commit settled without the clock");
  await done;
}

function floors(env: Env) {
  return env.markers.flatMap((m) =>
    m.kind === "history_floor" ? [[m.groupId, m.epoch, m.stop]] : [],
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * The channel holds G0 at epoch 20 with message keys down to epoch 10; the
 * server stores links for the holders `from..to` (each brings the epoch
 * below it).
 */
function shallow(env: Env, from = 10, to = 6) {
  env.states.set(
    CH,
    st({
      epoch: 20,
      history_floor: { group_id: G0, epoch: 10, stopped: null },
    }),
  );
  env.group = groupBody({ current_epoch: 20 });
  env.seats = seatsBody({ as_of_epoch: 20 });
  env.tops.set(G0, 20);
  env.held.clear();
  for (let e = 10; e <= 20; e++) env.held.add(`${G0}:${e}`);
  for (let e = from; e >= to; e--) env.links.push(link(G0, e));
}

const imports = (env: Env) => env.calls("e2ee_text_history_import");

// ---------------------------------------------------------------------------
// Links out: the committer (design 3.14.6 step 1)
// ---------------------------------------------------------------------------

test("committer: the link of a won commit is PUT as native returned it", async () => {
  const env = new Env();
  const sent = link(G0, 4, G0, 3, { user_id: SELF, device_id: DEV });
  env.wonLink = () => sent;
  const m = await ready(env);
  await commit(m);
  await env.advance(0);
  const puts = env.linkPuts();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, `/mls/groups/${G0}/history_links/4`);
  assert.equal(puts[0].raw, sent, "the object native returned, not a copy");
  assert.deepEqual(puts[0].body, sent);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  m.dispose();
});

test("committer: a duplicate won answer still PUTs its link, and owes no member duty", async () => {
  const env = new Env();
  env.wonKind = "duplicate";
  env.leaf(1);
  const m = await ready(env);
  await commit(m);
  await env.advance(10_000);
  assert.equal(env.linkPuts().length, 1);
  assert.equal(env.linkPuts()[0].path, `/mls/groups/${G0}/history_links/4`);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  assert.equal(env.linkGets().length, 0);
  m.dispose();
});

test("committer: the commit path does not wait for the PUT and is unchanged when the PUT fails", async () => {
  const env = new Env();
  env.putAnswers = Array.from({ length: 20 }, () => "transport" as const);
  const m = await ready(env);
  let done = false;
  let failed: unknown = null;
  void removePeer(m).then(
    () => {
      done = true;
    },
    (e: unknown) => {
      failed = e;
    },
  );
  // No clock: the first PUT has failed and its retry waits 2 s.
  await flush();
  assert.equal(failed, null);
  assert.equal(done, true, "the commit settled while the PUT is retried");
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  assert.equal(env.state().epoch, 4);
  assert.equal(env.linkPuts().length, 1);
  await env.advance(120_000);
  // 6 attempts (waits of 2, 4, 8, 16, 32 s), all with the same object.
  const puts = env.linkPuts();
  assert.equal(puts.length, 6);
  assert.ok(puts.every((p) => p.raw === puts[0].raw));
  assert.equal(env.logged("error", /history link PUT refused/).length, 1);
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  assert.equal(env.calls("e2ee_text_commit_lost").length, 0);
  m.dispose();
});

test("link PUT: a 503 is retried with identical bytes after 2 s and 4 s", async () => {
  const env = new Env();
  env.putAnswers = [ok({ type: "InternalError" }, 503), ok(null, 503)];
  const m = await ready(env);
  await commit(m);
  await env.advance(0);
  assert.equal(env.linkPuts().length, 1);
  await env.advance(1_999);
  assert.equal(env.linkPuts().length, 1);
  await env.advance(1);
  assert.equal(env.linkPuts().length, 2);
  await env.advance(3_999);
  assert.equal(env.linkPuts().length, 2);
  await env.advance(1);
  const puts = env.linkPuts();
  assert.equal(puts.length, 3);
  assert.deepEqual(
    puts.map((p) => p.at - puts[0].at),
    [0, 2_000, 6_000],
  );
  assert.ok(
    puts.every((p) => p.raw === puts[0].raw && p.path === puts[0].path),
  );
  assert.deepEqual(puts[1].body, puts[0].body);
  assert.deepEqual(puts[2].body, puts[0].body);
  await env.advance(120_000);
  assert.equal(env.linkPuts().length, 3, "a 204 ends it");
  m.dispose();
});

test("link PUT: HistoryLinkExists is done and never retried", async () => {
  const env = new Env();
  env.putAnswers = [ok({ type: "HistoryLinkExists" }, 409)];
  const m = await ready(env);
  await commit(m);
  await env.advance(120_000);
  assert.equal(env.linkPuts().length, 1);
  assert.equal(env.logged("error", /history link/).length, 0);
  m.dispose();
});

/** A PUT answered `answer` ends the session's link writes. */
async function stopsLinks(answer: TextApiResponse) {
  const env = new Env();
  env.putAnswers = [answer];
  env.leaf(1);
  const m = await ready(env);
  await commit(m);
  await env.advance(120_000);
  assert.equal(env.linkPuts().length, 1, "not retried");
  assert.equal(
    env.logged("warn", /history links stopped/).length +
      env.logged("error", /history links stopped/).length,
    1,
  );
  // A second own commit and a member duty: nothing is built or sent.
  await commit(m);
  m.onEnvelope(envelope("E6", 6));
  await env.advance(120_000);
  assert.equal(env.calls("e2ee_text_process").length, 1);
  assert.equal(env.linkPuts().length, 1);
  assert.equal(env.linkGets().length, 0);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  m.dispose();
}

test("link PUT: disabled stops every link write of the session", () =>
  stopsLinks(
    ok({ type: "FeatureDisabled", feature: "protected_history" }, 403),
  ));

test("link PUT: outdated stops every link write of the session", () =>
  stopsLinks(ok({ type: "ProtectedClientOutdated" }, 426)));

// ---------------------------------------------------------------------------
// Links out: the member duty (R-W4-8) and the build answer (L1k)
// ---------------------------------------------------------------------------

test("member duty: after the leaf stagger, the holder's candidates, the build, then the PUT", async () => {
  const env = new Env();
  env.leaf(2);
  const stored = link(G0, 4);
  env.links.push(stored, link(G0, 3), link(G0, 2));
  const built = link(G0, 4, G0, 3, { user_id: SELF, device_id: DEV });
  env.build = () => ({
    link: built,
    contest: false,
    mismatched_writers: [],
    refused: null,
  });
  const m = await ready(env);
  m.onEnvelope(envelope("E4", 4));
  await env.advance(3_999);
  assert.equal(env.linkGets().length, 0, "staggered by the leaf index");
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  await env.advance(1);
  assert.deepEqual(
    env.linkGets().map((c) => c.path),
    [`/mls/groups/${G0}/history_links?before=5&limit=${HISTORY_LINK_PAGE_ONE}`],
  );
  // Only the holder's own candidates reach native, as the server sent them.
  assert.deepEqual(env.calls("e2ee_text_history_link_build"), [
    { groupId: G0, epoch: 4, candidates: [stored] },
  ]);
  const puts = env.linkPuts();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, `/mls/groups/${G0}/history_links/4`);
  assert.equal(puts[0].raw, built);
  m.dispose();
});

/** A processed commit whose outcome is `over` owes no link. */
async function owesNothing(over: Partial<TextProcessOutcome>) {
  const env = new Env();
  env.wonLink = null;
  env.handlers.e2ee_text_process = (a) => {
    env.state().epoch = a.envelope.epoch;
    return outcome({ epoch: a.envelope.epoch, ...over });
  };
  const m = await ready(env);
  m.onEnvelope(envelope("E4", 4));
  await env.advance(30_000);
  assert.equal(env.calls("e2ee_text_process").length, 1);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  assert.equal(env.linkGets().length, 0);
  assert.equal(env.linkPuts().length, 0);
  m.dispose();
}

test("member duty: none for welcome_joined", () =>
  owesNothing({ kind: "welcome_joined" }));

test("member duty: none for duplicate", () =>
  owesNothing({ kind: "duplicate" }));

test("member duty: none for removed_self", () =>
  owesNothing({ removed_self: true }));

test("member duty: a link native refused is never PUT", async () => {
  for (const refused of ["hidden", "not_derived", "too_large"] as const) {
    const env = new Env();
    env.build = (g, e) => ({
      link: link(g, e),
      contest: false,
      mismatched_writers: [],
      refused,
    });
    const m = await ready(env);
    m.onEnvelope(envelope("E4", 4));
    await env.advance(30_000);
    assert.equal(env.calls("e2ee_text_history_link_build").length, 1);
    assert.equal(env.linkPuts().length, 0, refused);
    m.dispose();
  }
});

test("member duty: a contest PUT carries the query and is logged loud", async () => {
  const env = new Env();
  env.build = (g, e) => ({
    link: link(g, e, g, e - 1, { user_id: SELF, device_id: DEV }),
    contest: true,
    mismatched_writers: [],
    refused: null,
  });
  const m = await ready(env);
  m.onEnvelope(envelope("E4", 4));
  await env.advance(0);
  assert.deepEqual(
    env.linkPuts().map((p) => p.path),
    [`/mls/groups/${G0}/history_links/4?contest=true`],
  );
  assert.equal(env.logged("error", /history link contested/).length, 1);
  m.dispose();
});

test("member duty: dropped when the group was left before the stagger ended", async () => {
  const env = new Env();
  env.leaf(2);
  const m = await ready(env);
  m.onEnvelope(envelope("E4", 4));
  await env.advance(1_000);
  env.state().state = "left";
  await m.refresh(CH, "manual");
  await env.advance(10_000);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  assert.equal(env.linkPuts().length, 0);
  m.dispose();
});

test("catch-up of 450 epochs: one pass, 200 builds, newest first, after one stagger", async () => {
  const env = new Env();
  env.leaf(1);
  env.tops.set(G0, 453);
  for (let e = 4; e <= 453; e++) {
    env.rows.push({
      group_id: G0,
      epoch: e,
      committer: { user_id: OWNER, device_id: OWNER_DEV },
      commit: `C${e}`,
      added: [],
      removed: [],
    });
  }
  const m = await ready(env);
  await m.catchUp(CH, 453, G0);
  await flush();
  assert.equal(env.calls("e2ee_text_process").length, 450);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  await env.advance(1_999);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  await env.advance(1);
  const builds = env.calls("e2ee_text_history_link_build");
  assert.equal(builds.length, 200);
  assert.deepEqual(
    builds.map((b) => b.epoch),
    Array.from({ length: 200 }, (_, i) => 453 - i),
  );
  assert.ok(builds.every((b) => b.groupId === G0));
  assert.equal(env.linkPuts().length, 200);
  const left = env.logged("info", /older holders left/);
  assert.equal(left.length, 1);
  assert.equal(left[0].ids.count, 250);
  await env.advance(60_000);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 200);
  m.dispose();
});

test("successor: the creator builds the bridge link for holder 0 with no candidates", async () => {
  const env = new Env();
  const m = await ready(env);
  env.build = (g, e) => ({
    link: link(g, e, G0, 3, { user_id: SELF, device_id: DEV }),
    contest: false,
    mismatched_writers: [],
    refused: null,
  });
  await m.createGroup(CH, G0);
  await env.advance(0);
  assert.deepEqual(env.calls("e2ee_text_history_link_build"), [
    { groupId: G1, epoch: 0, candidates: [] },
  ]);
  assert.deepEqual(
    env.linkPuts().map((p) => p.path),
    [`/mls/groups/${G1}/history_links/0`],
  );
  m.dispose();
});

// ---------------------------------------------------------------------------
// The owner's notices (design 3.14.6 step 3; L1s `historyOwnerNotice`)
// ---------------------------------------------------------------------------

function contested(env: Env) {
  env.links.push(link(G0, 3), link(G0, 2));
  env.build = () => ({
    link: null,
    contest: false,
    mismatched_writers: [{ user_id: PEER, device_id: PEER_DEV }],
    refused: null,
  });
}

test("scope history on an owner device: the stored links are checked and ONE toast is raised", async () => {
  const env = new Env();
  env.ownerDevice();
  contested(env);
  const m = await ready(env);
  m.onChannelChanged(CH, ["history"]);
  await env.advance(0);
  assert.deepEqual(
    env.calls("e2ee_text_history_link_build").map((b) => b.epoch),
    [3, 2],
  );
  assert.deepEqual(env.notified, ["history_mismatch"]);
  assert.equal(env.linkPuts().length, 0, "the check writes nothing");
  // The same holders again: no second toast in this session.
  m.onChannelChanged(CH, ["history"]);
  await env.advance(0);
  assert.deepEqual(env.notified, ["history_mismatch"]);
  // Nothing of it names a writer.
  assert.ok(!JSON.stringify(env.logs).includes(PEER_DEV));
  m.dispose();
});

test("scope history on a member device: no check, no toast", async () => {
  const env = new Env();
  contested(env);
  const m = await ready(env);
  m.onChannelChanged(CH, ["history"]);
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  assert.equal(env.linkGets().length, 0);
  // A member's own duty that meets a mismatch stays quiet as well.
  m.onEnvelope(envelope("E4", 4));
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 1);
  assert.deepEqual(env.notified, []);
  m.dispose();
});

test("too_large: a toast on an owner device only, once per holder", async () => {
  for (const owner of [true, false]) {
    const env = new Env();
    if (owner) env.ownerDevice();
    env.build = () => ({
      link: null,
      contest: false,
      mismatched_writers: [],
      refused: "too_large",
    });
    const m = await ready(env);
    m.onEnvelope(envelope("E4", 4));
    await env.advance(0);
    assert.deepEqual(env.notified, owner ? ["history_too_large"] : []);
    assert.equal(env.linkPuts().length, 0);
    m.dispose();
  }
});

// ---------------------------------------------------------------------------
// The flag (R-W4-9)
// ---------------------------------------------------------------------------

test("flag off: no link PUT, no link GET, no build, no walk, no policy callback, no backup refresh, no history owner call", async () => {
  const env = new Env();
  env.flag = false;
  shallowOff(env);
  // An owner device at leaf 1: every history path would have work to do.
  env.ownerDevice();
  env.leaf(1);
  const rowCalls: unknown[][] = [];
  const owner = { protect: 0, setHistory: 0, wipeHistory: 0 };
  const deps = fakeDeps(env, {
    owner: {
      protect: async () => {
        owner.protect += 1;
      },
      setHistory: async () => {
        owner.setHistory += 1;
      },
      wipeHistory: async () => {
        owner.wipeHistory += 1;
      },
    },
    messages: {
      decryptRow: (...args) => {
        rowCalls.push(args);
        return decryptRow(...args);
      },
    },
  });
  const m = await ready(env, deps);
  // An own commit whose answer carries a link, a member's commit, a
  // catch-up of 25 epochs, a contest hint, a walk request, a missing epoch.
  await commit(m);
  m.onEnvelope(envelope("E22", 22));
  await env.advance(10_000);
  for (let e = 23; e <= 47; e++) {
    env.rows.push({
      group_id: G0,
      epoch: e,
      committer: { user_id: OWNER, device_id: OWNER_DEV },
      commit: `C${e}`,
      added: [],
      removed: [],
    });
  }
  env.tops.set(G0, 47);
  await m.catchUp(CH, 47, G0);
  m.onChannelChanged(CH, ["history"]);
  m.walkHistory(CH);
  m.decryptHistory(CH, [row("R7", 7), plainRow(BELOW)]);
  await env.advance(120_000);

  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  assert.equal(env.calls("e2ee_text_process").length, 26);
  assert.equal(env.linkPuts().length, 0);
  assert.equal(env.linkGets().length, 0);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  assert.equal(imports(env).length, 0);
  assert.equal(env.api$("GET", /\/history_links/).length, 0);
  assert.deepEqual(env.policies, []);
  assert.equal(env.backupRefreshes, 0);
  assert.deepEqual(env.notified, []);
  assert.deepEqual(floors(env), []);
  assert.deepEqual(env.walkStates, ["idle"]);
  // The rows are decided as in S2: the manager itself is the flow's ops
  // (it carries no history lookup and no walk), with no fifth argument.
  assert.equal(rowCalls.length, 2);
  for (const args of rowCalls) {
    assert.equal(args.length, 4);
    assert.equal(args[0], m);
    assert.equal((args[0] as { requestWalk?: unknown }).requestWalk, undefined);
  }
  const missing = env.msgViews.get("R7");
  assert.equal(missing?.status, "marker");
  assert.deepEqual(env.msgViews.get(BELOW), {
    status: "marker",
    kind: "unencrypted_row",
  });

  // The history owner calls are refused before any flow runs.
  const off = { source: "client", reason: "history_setting_off" };
  await assert.rejects(
    m.protect(CH, [SELF], 5, { withHistory: true, wipe: false }),
    (e) => (assert.deepEqual(e, off), true),
  );
  await assert.rejects(
    m.protect(CH, [SELF], 5, { withHistory: false, wipe: true }),
    (e) => (assert.deepEqual(e, off), true),
  );
  await assert.rejects(
    m.setHistoryVisible(CH, true),
    (e) => (assert.deepEqual(e, off), true),
  );
  await assert.rejects(
    m.wipeHistory(CH),
    (e) => (assert.deepEqual(e, off), true),
  );
  assert.deepEqual(owner, { protect: 0, setHistory: 0, wipeHistory: 0 });
  // The S2 protect still runs, with the five arguments it always had.
  let protectArgs = 0;
  deps.owner.protect = async (...args: unknown[]) => {
    protectArgs = args.length;
  };
  await m.protect(CH, [SELF], 5);
  assert.equal(protectArgs, 5);
  m.dispose();
});

/** `shallow` for the flag-off test: links exist, so a walk WOULD find them. */
function shallowOff(env: Env) {
  shallow(env);
  env.links.push(link(G0, 21), link(G0, 20));
}

test("flag turned off mid-session: the next duty and the next walk request do nothing", async () => {
  const env = new Env();
  shallow(env);
  const m = await ready(env);
  env.flag = false;
  m.onEnvelope(envelope("E21", 21));
  m.walkHistory(CH);
  await env.advance(30_000);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  assert.equal(env.linkGets().length, 0);
  assert.equal(imports(env).length, 0);
  m.dispose();
});

// ---------------------------------------------------------------------------
// The walk (design 3.14.8; L1w `runWalk`, B4 `HistoryOps.requestWalk`)
// ---------------------------------------------------------------------------

test("walk: across two link pages and one bridge hop, then the rows decrypt", async () => {
  const env = new Env();
  // The channel is on its second group: G1 at epoch 6, keys held down to
  // epoch 2. G0 ended at epoch 9; none of its keys are held.
  env.states.set(
    CH,
    st({
      group_id: G1,
      generation: 1,
      epoch: 6,
      history_floor: { group_id: G1, epoch: 2, stopped: null },
    }),
  );
  env.group = groupBody({ group_id: G1, generation: 1, current_epoch: 6 });
  env.seats = seatsBody({ as_of_group_id: G1, as_of_epoch: 6 });
  env.tops.set(G0, 9);
  env.tops.set(G1, 6);
  env.held.clear();
  for (let e = 2; e <= 6; e++) env.held.add(`${G1}:${e}`);
  env.links.push(
    link(G1, 2),
    link(G1, 1),
    link(G1, 0, G0, 9),
    link(G0, 9),
    link(G0, 8),
    link(G0, 7),
    link(G0, 6),
  );
  env.pageCap = 3;
  const m = await ready(env);
  m.decryptHistory(CH, [row("R7", 7), row("R4", 4)]);
  await env.advance(0);

  // One session: started once, continued with the id native answered.
  const calls = imports(env);
  assert.ok(calls.length >= 3, `import calls: ${calls.length}`);
  assert.equal(calls.filter((c) => c.session === null).length, 1);
  assert.ok(calls.slice(1).every((c) => c.session === "SESSION"));
  assert.ok(
    calls.every((c) => c.groupId === G1),
    "the starting group",
  );
  assert.deepEqual(
    calls.flatMap((c) =>
      c.steps.map(
        (s) => `${s.holder_group_id === G1 ? "G1" : "G0"}:${s.holder_epoch}`,
      ),
    ),
    ["G1:2", "G1:1", "G1:0", "G0:9", "G0:8", "G0:7", "G0:6", "G0:5"],
  );
  // The candidates went to native as the server sent them.
  assert.deepEqual(calls[0].steps[0].candidates, [link(G1, 2)]);
  // Two pages of G0's links, the second below the lowest holder of the first.
  const g0Pages = env.linkGets().filter((c) => c.path.includes(G0));
  assert.deepEqual(
    g0Pages.map((c) => c.path.split("?")[1]),
    [
      `before=10&limit=${HISTORY_LINK_PAGE}`,
      `before=7&limit=${HISTORY_LINK_PAGE}`,
      `before=6&limit=${HISTORY_LINK_PAGE}`,
    ],
  );
  // The walk stopped where the links end: one floor marker.
  assert.deepEqual(floors(env), [[G0, 5, "missing"]]);
  assert.deepEqual(env.walkStates, ["idle", "running", "idle"]);
  // The row of an imported epoch decrypts, with the history sender note;
  // the row below the floor is a marker and cost no second walk.
  const r7 = env.msgViews.get("R7");
  assert.ok(r7?.status === "ok", JSON.stringify(r7));
  assert.equal(r7.text, "text of R7");
  assert.equal(r7.historySender, true);
  assert.equal(env.msgViews.get("R4")?.status, "marker");
  assert.equal(imports(env).filter((c) => c.session === null).length, 1);
  m.dispose();
});

test("walk: two requests share one session", async () => {
  const env = new Env();
  shallow(env);
  const gate = deferred();
  env.importGate = gate.promise;
  const m = await ready(env);
  // Two rows of different missing epochs, asked for separately.
  m.onMessage(row("R7", 7), false);
  m.onMessage(row("R6", 6), false);
  await flush();
  assert.equal(imports(env).length, 1, "one walk is running");
  assert.equal(env.views.get(CH)?.historyWalk, "running");
  assert.deepEqual(env.msgViews.get("R7"), { status: "pending" });
  gate.resolve();
  await env.advance(0);
  assert.equal(imports(env).filter((c) => c.session === null).length, 1);
  assert.equal(env.msgViews.get("R7")?.status, "ok");
  assert.equal(env.msgViews.get("R6")?.status, "ok");
  assert.equal(env.views.get(CH)?.historyWalk, "idle");
  m.dispose();
});

test("walk: the floor marker is replaced by a lower one, and not repeated", async () => {
  const env = new Env();
  shallow(env, 10, 9);
  const m = await ready(env);
  m.decryptHistory(CH, [row("R7", 7)]);
  await env.advance(0);
  assert.deepEqual(floors(env), [[G0, 8, "missing"]]);
  assert.equal(env.msgViews.get("R7")?.status, "marker");
  // Another member wrote the missing links; the user asks again.
  env.links.push(link(G0, 8), link(G0, 7), link(G0, 6));
  m.walkHistory(CH);
  await env.advance(0);
  assert.deepEqual(floors(env), [
    [G0, 8, "missing"],
    [G0, 5, "missing"],
  ]);
  // The row whose epoch arrived is decrypted again without being asked.
  assert.equal(env.msgViews.get("R7")?.status, "ok");
  // The same stop again raises no third marker.
  m.walkHistory(CH);
  await env.advance(0);
  assert.equal(floors(env).length, 2);
  m.dispose();
});

test("walk: a row left pending is not final and is decrypted again when a walk result arrives", async () => {
  const env = new Env();
  shallow(env);
  env.importFail = { type: "internal", message: "bridge down" };
  const m = await ready(env);
  m.decryptHistory(CH, [row("R7", 7)]);
  await env.advance(0);
  assert.deepEqual(env.msgViews.get("R7"), { status: "pending" });
  assert.equal(env.views.get(CH)?.historyWalk, "retry_later");
  assert.deepEqual(floors(env), [], "nothing final: no floor marker");
  // Asked again: not answered from a cache, the row goes to native again.
  const before = env.calls("e2ee_text_decrypt").length;
  m.decryptHistory(CH, [row("R7", 7)]);
  await env.advance(0);
  assert.ok(env.calls("e2ee_text_decrypt").length > before);
  assert.deepEqual(env.msgViews.get("R7"), { status: "pending" });
  // No timer retries it: an hour later nothing more was asked of native.
  const walks = imports(env).length;
  await env.advance(3_600_000);
  assert.equal(imports(env).length, walks);
  // The bridge is back and the user retries: the pending row follows.
  env.importFail = null;
  m.walkHistory(CH);
  await env.advance(0);
  assert.equal(env.msgViews.get("R7")?.status, "ok");
  assert.equal(env.views.get(CH)?.historyWalk, "idle");
  m.dispose();
});

test("walk: a stop this build does not know is passed on and reads loud", async () => {
  const env = new Env();
  shallow(env, 10, 9);
  env.stop = "brand_new_stop";
  const m = await ready(env);
  m.decryptHistory(CH, [row("R7", 7)]);
  await env.advance(0);
  assert.deepEqual(floors(env), [[G0, 8, "brand_new_stop"]]);
  const marker = env.markers.find((x) => x.kind === "history_floor");
  assert.ok(marker && marker.kind === "history_floor");
  assert.equal(historyFloorNotice(marker.stop).tone, "loud");
  const stopped = env.logged("error", /history walk stopped/);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].ids.loud, true);
  assert.equal(env.msgViews.get("R7")?.status, "marker");
  m.dispose();
});

test("walk: probes are the loaded rows of the holder, at most 3, one per author", async () => {
  const env = new Env();
  shallow(env);
  const m = await ready(env);
  // Loaded rows of the start holder (epoch 10): 4 authors, one twice.
  m.decryptHistory(CH, [
    row("P1", 10, G0, "UA"),
    row("P2", 10, G0, "UA"),
    row("P3", 10, G0, "UB"),
    row("P4", 10, G0, "UC"),
    row("P5", 10, G0, "UD"),
    row("R7", 7),
  ]);
  await env.advance(0);
  const first = imports(env)[0].steps[0];
  assert.equal(first.holder_epoch, 10);
  assert.deepEqual(
    (first.probes ?? []).map((p) => [p.message_id, p.author_user_id]),
    [
      ["P1", "UA"],
      ["P3", "UB"],
      ["P4", "UC"],
    ],
  );
  m.dispose();
});

// ---------------------------------------------------------------------------
// Timers (dispose, channel removal)
// ---------------------------------------------------------------------------

test("timers: a duty stagger and a PUT backoff are cleared on dispose", async () => {
  const env = new Env();
  env.leaf(2);
  env.putAnswers = [ok(null, 503)];
  const m = await ready(env);
  await commit(m);
  m.onEnvelope(envelope("E5", 5));
  await flush();
  assert.ok(
    env.sleeps.some((s) => s.ms === 2_000),
    "PUT backoff armed",
  );
  assert.ok(
    env.sleeps.some((s) => s.ms === 4_000),
    "duty stagger armed",
  );
  const puts = env.linkPuts().length;
  m.dispose();
  await flush();
  assert.deepEqual(env.sleeps, []);
  await env.advance(120_000);
  assert.equal(env.linkPuts().length, puts);
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
});

test("timers: a duty stagger, a PUT backoff and a walk end when the channel leaves the protected set", async () => {
  const env = new Env();
  shallow(env);
  env.leaf(2);
  env.putAnswers = [ok(null, 503)];
  const gate = deferred();
  env.importGate = gate.promise;
  const m = await ready(env);
  await commit(m);
  m.onEnvelope(envelope("E22", 22));
  m.onMessage(row("R7", 7), false);
  await flush();
  assert.ok(env.sleeps.some((s) => s.ms === 2_000));
  assert.ok(env.sleeps.some((s) => s.ms === 4_000));
  assert.equal(imports(env).length, 1);
  const puts = env.linkPuts().length;
  const gets = env.linkGets().length;
  m.flagStripped(CH);
  await flush();
  assert.ok(!env.sleeps.some((s) => s.ms === 2_000), "backoff cleared");
  assert.ok(!env.sleeps.some((s) => s.ms === 4_000), "stagger cleared");
  gate.resolve();
  await env.advance(120_000);
  assert.equal(env.linkPuts().length, puts);
  assert.equal(env.linkGets().length, gets, "the walk fetched nothing more");
  assert.equal(env.calls("e2ee_text_history_link_build").length, 0);
  m.dispose();
});

// ---------------------------------------------------------------------------
// The policy callback (R-W4-4) and the row views
// ---------------------------------------------------------------------------

const POLICY = {
  history_boundary: BOUNDARY,
  pre_history: "kept" as const,
  history_time_limit: Number.MAX_SAFE_INTEGER,
};

test("policy: reported once per change, from a verified state", async () => {
  const env = new Env();
  Object.assign(env.state(), POLICY);
  const m = await ready(env);
  await m.refresh(CH, "manual");
  await m.refresh(CH, "manual");
  assert.deepEqual(env.policies, [
    {
      channelId: CH,
      p: {
        verified: true,
        boundary: BOUNDARY,
        preHistory: "kept",
        timeLimit: Number.MAX_SAFE_INTEGER,
      },
    },
  ]);
  env.state().history_time_limit = 5;
  await m.refresh(CH, "manual");
  assert.equal(env.policies.length, 2);
  assert.deepEqual(env.policies[1].p, {
    verified: true,
    boundary: BOUNDARY,
    preHistory: "kept",
    timeLimit: 5,
  });
  await m.refresh(CH, "manual");
  assert.equal(env.policies.length, 2);
  m.dispose();
});

test("policy: a state that is loading, missing, errored or only behind reports nothing", async () => {
  // The read fails: nothing at all.
  {
    const env = new Env();
    env.handlers.e2ee_text_state = () => {
      throw { type: "internal", message: "locked" };
    };
    const m = await ready(env);
    assert.deepEqual(env.policies, []);
    m.dispose();
  }
  // No list held (joining, rejoining): nothing, in particular no
  // `verified: false`.
  {
    const env = new Env();
    Object.assign(env.state(), POLICY, {
      seat_list: null,
      verdict: "no_seat_list",
    });
    const m = await ready(env);
    assert.deepEqual(env.policies, []);
    m.dispose();
  }
  // A verdict this build does not know: nothing.
  {
    const env = new Env();
    Object.assign(env.state(), POLICY, { verdict: "brand_new_verdict" });
    const m = await ready(env);
    assert.deepEqual(env.policies, []);
    m.dispose();
  }
  // Verified first; then the list verify fails for a reason that is not
  // one of the loud ones, and later the state read fails: the verified
  // report stands, no `verified: false` follows.
  {
    const env = new Env();
    Object.assign(env.state(), POLICY);
    const m = await ready(env);
    assert.equal(env.policies.length, 1);
    env.handlers.e2ee_text_seat_list_verify = () => {
      throw { type: "seat_list_behind" };
    };
    await m.refresh(CH, "manual");
    await env.advance(0);
    env.handlers.e2ee_text_state = () => {
      throw { type: "internal", message: "locked" };
    };
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(env.policies.length, 1);
    assert.equal((env.policies[0].p as { verified: boolean }).verified, true);
    m.dispose();
  }
});

test("policy: unverified is reported only when native says so, and the rows follow", async () => {
  // The verdict is owner_changed.
  {
    const env = new Env();
    Object.assign(env.state(), POLICY);
    const m = await ready(env);
    m.decryptHistory(CH, [plainRow(BELOW)]);
    await env.advance(0);
    assert.deepEqual(env.msgViews.get(BELOW), { status: "plain" });
    env.state().verdict = "owner_changed";
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(env.policies.length, 2);
    assert.deepEqual(env.policies[1].p, {
      verified: false,
      boundary: BOUNDARY,
      preHistory: "kept",
      timeLimit: Number.MAX_SAFE_INTEGER,
    });
    // The row view was decided again on the same state: no longer plain.
    assert.deepEqual(env.msgViews.get(BELOW), { status: "checking" });
    m.dispose();
  }
  // The list verify answers one of the loud refusals.
  {
    const env = new Env();
    Object.assign(env.state(), POLICY);
    const m = await ready(env);
    assert.equal(env.policies.length, 1);
    env.handlers.e2ee_text_seat_list_verify = () => {
      throw { type: "bad_sig" };
    };
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(env.policies.length, 2);
    assert.equal((env.policies[1].p as { verified: boolean }).verified, false);
    m.dispose();
  }
});

test("rows: the pre-history latches are read through the deps and unknown means red", async () => {
  // With the dep: a kept pre-protect row below the boundary is plain.
  {
    const env = new Env();
    Object.assign(env.state(), POLICY);
    const m = await ready(env);
    m.decryptHistory(CH, [plainRow(BELOW)]);
    await env.advance(0);
    assert.deepEqual(env.msgViews.get(BELOW), { status: "plain" });
    assert.equal(env.calls("e2ee_text_decrypt").length, 0);
    m.dispose();
  }
  // The SDK says the reveal conflicted: red.
  {
    const env = new Env();
    Object.assign(env.state(), POLICY);
    const m = await ready(
      env,
      fakeDeps(env, {
        history: {
          preHistoryState: () => ({ conflicted: true, wiped: false }),
        },
      }),
    );
    m.decryptHistory(CH, [plainRow(BELOW)]);
    await env.advance(0);
    assert.deepEqual(env.msgViews.get(BELOW), {
      status: "marker",
      kind: "unencrypted_row",
    });
    m.dispose();
  }
  // Without the dep nothing is known about the latches: red, logged once.
  {
    const env = new Env();
    Object.assign(env.state(), POLICY);
    const deps = fakeDeps(env);
    delete (deps as Partial<ProtectedTextHistoryDeps>).preHistoryState;
    const m = await ready(env, deps);
    m.decryptHistory(CH, [plainRow(BELOW)]);
    await env.advance(0);
    assert.deepEqual(env.msgViews.get(BELOW), {
      status: "marker",
      kind: "unencrypted_row",
    });
    assert.equal(
      env.logged("error", /pre-history state unavailable/).length,
      1,
    );
    m.dispose();
  }
});

// ---------------------------------------------------------------------------
// Owner calls (R-W4-11) and the backup refresh (design 8.5)
// ---------------------------------------------------------------------------

test("protect with history opts: the opts reach the flow as given and no wipe is started", async () => {
  const env = new Env();
  const seen: unknown[][] = [];
  let wipes = 0;
  const deps = fakeDeps(env, {
    owner: {
      protect: async (...args: unknown[]) => {
        seen.push(args);
      },
      wipeHistory: async () => {
        wipes += 1;
      },
    },
  });
  const m = await ready(env, deps);
  const opts = { withHistory: true, wipe: false };
  await m.protect(CH, [SELF], 5, opts);
  await m.setHistoryVisible(CH, false);
  await env.advance(0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 6);
  assert.equal(seen[0][5], opts);
  assert.equal(wipes, 0, "only wipeHistory starts a wipe");
  await m.wipeHistory(CH);
  assert.equal(wipes, 1);
  m.dispose();
});

test("owner calls: a failure is passed on unchanged, placed by historyOwnerNotice, and the state is re-read", async () => {
  const cases = [
    [
      "protect_busy",
      (m: ProtectedTextManager) =>
        m.protect(CH, [SELF], 5, { withHistory: true, wipe: false }),
    ],
    [
      "clock_behind",
      (m: ProtectedTextManager) =>
        m.protect(CH, [SELF], 5, { withHistory: true, wipe: true }),
    ],
    ["wipe_refused", (m: ProtectedTextManager) => m.wipeHistory(CH)],
    [
      "protect_busy",
      (m: ProtectedTextManager) => m.setHistoryVisible(CH, true),
    ],
  ] as const;
  for (const [reason, call] of cases) {
    const env = new Env();
    const failure = { source: "client", reason };
    const fail = async () => {
      throw failure;
    };
    const m = await ready(
      env,
      fakeDeps(env, {
        owner: { protect: fail, setHistory: fail, wipeHistory: fail },
      }),
    );
    const reads = env.calls("e2ee_text_state").length;
    const fetches = env.api$("GET", /\/seats$/).length;
    await assert.rejects(call(m), (e) => e === failure);
    await env.advance(0);
    // All three are inline errors of the settings page: no toast.
    assert.deepEqual(env.notified, [], reason);
    assert.ok(env.calls("e2ee_text_state").length > reads, "state re-read");
    assert.ok(env.api$("GET", /\/seats$/).length > fetches, "refreshed");
    assert.equal(env.views.get(CH)?.publishInFlight, false);
    m.dispose();
  }
});

test("owner calls: without the bridge's flows the history calls are refused", async () => {
  const env = new Env();
  const deps = fakeDeps(env);
  delete deps.owner.setHistory;
  delete deps.owner.wipeHistory;
  const m = await ready(env, deps);
  const gone = { source: "client", reason: "history_unavailable" };
  await assert.rejects(
    m.setHistoryVisible(CH, true),
    (e) => (assert.deepEqual(e, gone), true),
  );
  await assert.rejects(
    m.wipeHistory(CH),
    (e) => (assert.deepEqual(e, gone), true),
  );
  m.dispose();
});

test("history setting: a change is followed by this device's own Update, no change by none", async () => {
  const env = new Env();
  env.wonLink = null;
  env.state().history_setting = "hidden";
  const m = await ready(
    env,
    fakeDeps(env, {
      owner: {
        setHistory: async (_ops, _port, _ch, visible) => {
          env.state().history_setting = visible ? "visible" : "hidden";
        },
      },
    }),
  );
  await m.setHistoryVisible(CH, true);
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_update").length, 1);
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  await m.setHistoryVisible(CH, true);
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_update").length, 1, "already visible");
  m.dispose();
});

test("backup refresh: asked once every 20 new epochs, a duplicate does not count", async () => {
  const env = new Env();
  env.build = () => ({
    link: null,
    contest: false,
    mismatched_writers: [],
    refused: "hidden",
  });
  assert.equal(BACKUP_REFRESH_EPOCHS, 20);
  const m = await ready(env);
  for (let e = 4; e <= 22; e++) {
    m.onEnvelope(envelope(`E${e}`, e));
    await env.advance(0);
  }
  assert.equal(env.calls("e2ee_text_process").length, 19);
  assert.equal(env.backupRefreshes, 0);
  env.handlers.e2ee_text_process = (a) =>
    outcome({ epoch: a.envelope.epoch, kind: "duplicate" });
  m.onEnvelope(envelope("E22b", 22));
  await env.advance(0);
  assert.equal(env.backupRefreshes, 0, "a duplicate is not a new epoch");
  env.handlers.e2ee_text_process = (a) => {
    env.state().epoch = a.envelope.epoch;
    return outcome({ epoch: a.envelope.epoch });
  };
  m.onEnvelope(envelope("E23", 23));
  await env.advance(0);
  assert.equal(env.backupRefreshes, 1);
  m.dispose();
});

test("logs: no link ciphertext, nonce or signature and no message text reaches the log", async () => {
  const env = new Env();
  shallow(env);
  env.ownerDevice();
  env.build = (g, e) => ({
    link: link(g, e, g, e - 1, { user_id: SELF, device_id: DEV }),
    contest: true,
    mismatched_writers: [{ user_id: PEER, device_id: PEER_DEV }],
    refused: null,
  });
  env.putAnswers = [ok(null, 503), ok({ type: "Nope" }, 400)];
  const m = await ready(env);
  await commit(m);
  m.onEnvelope(envelope("E22", 22));
  m.onChannelChanged(CH, ["history"]);
  m.decryptHistory(CH, [row("R7", 7), row("R1", 1)]);
  await env.advance(120_000);
  assert.ok(env.linkPuts().length >= 2);
  assert.ok(imports(env).length >= 1);
  const text = JSON.stringify(env.logs);
  for (const secret of ["LINK-", "N-", "S-", "text of", "AEAD", "CT"]) {
    assert.ok(!text.includes(`"${secret}`), `log holds ${secret}`);
  }
  for (const l of env.logs) {
    for (const v of Object.values(l.ids)) {
      assert.ok(
        ["string", "number", "boolean"].includes(typeof v) || v === null,
        `${l.msg}: an id that is not a scalar`,
      );
    }
  }
  m.dispose();
});

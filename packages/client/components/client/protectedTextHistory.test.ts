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
// server. The flag-off tests are the counterpart of protectedText.test.ts,
// whose port has no `historySetting` at all. The flag gates writes and new
// activity only (R-W4-31): the policy callback and the row decisions are
// asserted in every flag state.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MlsMemberDevice } from "./e2ee";
import type { OwnListingRequest } from "./protectedOwnListing.ts";
import { ulidTimeMs } from "./protectedRowPolicy.ts";
import { historyFloorNotice } from "./protectedShield.ts";
import {
  type ProtectedTextHistoryDeps,
  type ProtectedTextPortExtensions,
  BACKUP_REFRESH_EPOCHS,
  HISTORY_LINK_PAGE,
  HISTORY_LINK_PAGE_ONE,
  HISTORY_UPDATE_TRIES,
  PROTECTED_HISTORY_EPOCH_KEY_PREFIX,
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

/** A ULID whose time is `ms` (the floor marker is placed by a row's time). */
function ulidAt(ms: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  let v = ms;
  for (let i = 0; i < 10; i++) {
    time = alphabet[v % 32] + time;
    v = Math.floor(v / 32);
  }
  return `${time}0000000000000000`;
}

/**
 * Row times start here, years before the fake clock (1.7e12), so a marker
 * placed at the clock cannot pass for one placed by a row.
 */
const T0 = 1_600_000_000_000;
const at = (n: number) => ulidAt(T0 + n);

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
  /**
   * `unknown_epoch.oldest_held` per group (native: the first epoch of the
   * current membership run, or null). A group without an entry sends no
   * such field, as an older shell does.
   */
  oldest = new Map<string, number | null>();
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
      // Native starts a session only at an epoch it holds (history.rs
      // `start_session`): any other start holder is refused.
      const start = a.steps[0];
      if (
        a.session === null &&
        start &&
        !env.held.has(`${start.holder_group_id}:${start.holder_epoch}`)
      ) {
        throw { type: "invalid_argument", field: "holder_epoch" };
      }
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
          ...(env.oldest.has(e.group_id)
            ? { oldest_held: env.oldest.get(e.group_id) }
            : {}),
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

/** `atMs` of every floor marker raised, in order. */
function floorAts(env: Env) {
  return env.markers.flatMap((m) =>
    m.kind === "history_floor" ? [m.atMs] : [],
  );
}

const builds = (env: Env) => env.calls("e2ee_text_history_link_build").length;

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
// The flag (R-W4-9, R-W4-31): it gates writes and new activity, never the
// read side
// ---------------------------------------------------------------------------

test("flag off: no link PUT, no link GET, no build, no walk, no backup refresh, no history owner call; the policy and the rows still follow native", async () => {
  const env = new Env();
  env.flag = false;
  shallowOff(env);
  Object.assign(env.state(), POLICY);
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
  assert.equal(env.backupRefreshes, 0);
  assert.deepEqual(env.notified, []);
  assert.deepEqual(floors(env), []);
  assert.deepEqual(env.walkStates, ["idle"]);
  // No own Update bookkeeping either: nothing was stored for it.
  assert.deepEqual(env.storeKeys(PROTECTED_HISTORY_EPOCH_KEY_PREFIX), []);
  // R-W4-31: the read side does not look at the flag. The verified policy
  // native holds was reported (once: nothing about it changed) ...
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
  // ... and the rows are decided by the full row policy: the flow gets the
  // history ops (never the bare manager) and the walk batch.
  assert.equal(rowCalls.length, 2);
  for (const args of rowCalls) {
    assert.equal(args.length, 5);
    assert.notEqual(args[0], m);
    const ops = args[0] as Record<string, unknown>;
    for (const op of [
      "pinHistory",
      "nativeState",
      "seatListError",
      "preHistoryState",
      "epochFromWalk",
      "requestWalk",
    ]) {
      assert.equal(typeof ops[op], "function", op);
    }
  }
  // A missing epoch gets its final marker (no walk may run, so the row
  // does not wait for one), and the kept pre-protect row is plain, not red.
  assert.equal(env.msgViews.get("R7")?.status, "marker");
  assert.deepEqual(env.msgViews.get(BELOW), { status: "plain" });

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

test("flag turned off mid-session: the next duty and the next walk request do nothing, a row waits for no walk, and a withdrawal still goes out", async () => {
  // `off: false` is the control: the same steps with the flag left on DO
  // build, fetch and walk, so the zeros below are the flag's doing.
  for (const off of [false, true]) {
    const env = new Env();
    shallow(env);
    Object.assign(env.state(), POLICY);
    const m = await ready(env);
    m.decryptHistory(CH, [plainRow(BELOW)]);
    await env.advance(0);
    assert.deepEqual(env.msgViews.get(BELOW), { status: "plain" });
    assert.equal(env.policies.length, 1);
    if (off) env.flag = false;
    m.onEnvelope(envelope("E21", 21));
    m.walkHistory(CH);
    m.decryptHistory(CH, [row("R7", 7)]);
    await env.advance(30_000);
    if (off) {
      assert.equal(builds(env), 0);
      assert.equal(env.linkGets().length, 0);
      assert.equal(imports(env).length, 0);
      // The row is final (its S2 marker): it is not left waiting for a
      // walk that may not run.
      assert.equal(env.msgViews.get("R7")?.status, "marker");
      assert.deepEqual(env.walkStates, ["idle"]);
    } else {
      assert.equal(builds(env), 1);
      assert.ok(env.linkGets().length >= 2, "the duty's and the walk's GETs");
      assert.ok(imports(env).length >= 1);
      assert.equal(env.msgViews.get("R7")?.status, "ok");
    }
    // Turning the flag off reported nothing by itself ...
    assert.equal(env.policies.length, 1);
    assert.deepEqual(env.msgViews.get(BELOW), { status: "plain" });
    // ... and native's withdrawal goes out whatever the flag says: the
    // unverified policy is reported and the cached plain view is decided
    // again.
    env.state().verdict = "owner_changed";
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(env.policies.length, 2, `off=${off}`);
    assert.deepEqual(env.policies[1].p, {
      verified: false,
      boundary: BOUNDARY,
      preHistory: "kept",
      timeLimit: Number.MAX_SAFE_INTEGER,
    });
    assert.deepEqual(env.msgViews.get(BELOW), { status: "checking" });
    m.dispose();
  }
});

/** What native can report that takes a reveal back, and the policy it gives. */
const WITHDRAWALS: [
  string,
  (env: Env) => void,
  { verified: boolean; preHistory: "kept" | "wiped" },
][] = [
  [
    "owner_changed",
    (env) => {
      env.state().verdict = "owner_changed";
    },
    { verified: false, preHistory: "kept" },
  ],
  [
    "a loud verify failure",
    (env) => {
      env.handlers.e2ee_text_seat_list_verify = () => {
        throw { type: "bad_sig" };
      };
    },
    { verified: false, preHistory: "kept" },
  ],
  [
    "wiped",
    (env) => {
      env.state().pre_history = "wiped";
    },
    { verified: true, preHistory: "wiped" },
  ],
];

test("withdrawal (R-W4-31): in every flag state native's owner_changed, loud verify failure or wipe is reported and the cached plain view is decided again", async () => {
  // [the flag at the reveal, the flag at the withdrawal]
  const flagStates: [boolean, boolean][] = [
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ];
  for (const [before, after] of flagStates) {
    for (const [name, withdraw, want] of WITHDRAWALS) {
      const label = `${name}, flag ${before} -> ${after}`;
      const env = new Env();
      env.flag = before;
      Object.assign(env.state(), POLICY);
      const m = await ready(env);
      m.decryptHistory(CH, [plainRow(BELOW)]);
      await env.advance(0);
      // The reveal: a verified policy, a plain row.
      assert.equal(env.policies.length, 1, label);
      assert.equal(
        (env.policies[0].p as { verified: boolean }).verified,
        true,
        label,
      );
      assert.deepEqual(env.msgViews.get(BELOW), { status: "plain" }, label);
      // The flag alone (a failed fetch stores it as off) reports nothing
      // and decides no row again.
      env.flag = after;
      await m.refresh(CH, "manual");
      await env.advance(0);
      assert.equal(env.policies.length, 1, `${label}: the flag reported`);
      assert.deepEqual(env.msgViews.get(BELOW), { status: "plain" }, label);
      // Native withdraws.
      withdraw(env);
      await m.refresh(CH, "manual");
      await env.advance(0);
      assert.equal(env.policies.length, 2, `${label}: not reported`);
      assert.deepEqual(
        env.policies[1].p,
        {
          verified: want.verified,
          boundary: BOUNDARY,
          preHistory: want.preHistory,
          timeLimit: Number.MAX_SAFE_INTEGER,
        },
        label,
      );
      const view = env.msgViews.get(BELOW);
      assert.notEqual(view?.status, "plain", `${label}: still plain`);
      assert.deepEqual(
        view,
        want.preHistory === "wiped"
          ? { status: "marker", kind: "unencrypted_row" }
          : { status: "checking" },
        label,
      );
      // A row asked for now is decided the same way.
      m.decryptHistory(CH, [plainRow(BELOW)]);
      await env.advance(0);
      assert.notEqual(env.msgViews.get(BELOW)?.status, "plain", label);
      m.dispose();
    }
  }
});

test("policy, flag off: a state that is loading, missing or errored still reports nothing", async () => {
  // The read fails.
  {
    const env = new Env();
    env.flag = false;
    env.handlers.e2ee_text_state = () => {
      throw { type: "internal", message: "locked" };
    };
    const m = await ready(env);
    m.decryptHistory(CH, [plainRow(BELOW)]);
    await env.advance(0);
    assert.deepEqual(env.policies, []);
    assert.notEqual(env.msgViews.get(BELOW)?.status, "plain");
    m.dispose();
  }
  // No list held, and a verdict this build does not know.
  for (const over of [
    { seat_list: null, verdict: "no_seat_list" },
    { verdict: "brand_new_verdict" },
  ]) {
    const env = new Env();
    env.flag = false;
    Object.assign(env.state(), POLICY, over);
    const m = await ready(env);
    m.decryptHistory(CH, [plainRow(BELOW)]);
    await env.advance(0);
    assert.deepEqual(env.policies, [], JSON.stringify(over));
    assert.notEqual(env.msgViews.get(BELOW)?.status, "plain");
    m.dispose();
  }
  // A verify failure that is not one of the loud ones, then a failed read:
  // the verified report stands, nothing is withdrawn.
  {
    const env = new Env();
    env.flag = false;
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

test("A8: the flag turned off during a duty's stagger: no link GET and no build after the wait", async () => {
  for (const off of [false, true]) {
    const env = new Env();
    env.leaf(2);
    const m = await ready(env);
    m.onEnvelope(envelope("E4", 4));
    await flush();
    assert.ok(
      env.sleeps.some((s) => s.ms === 4_000),
      "the stagger is running",
    );
    assert.equal(env.linkGets().length, 0);
    if (off) env.flag = false;
    await env.advance(10_000);
    assert.equal(env.linkGets().length, off ? 0 : 1, `off=${off}`);
    assert.equal(builds(env), off ? 0 : 1, `off=${off}`);
    m.dispose();
  }
});

test("A8: the flag turned off while the owner check reads the state: no link GET", async () => {
  for (const off of [false, true]) {
    const env = new Env();
    env.ownerDevice();
    contested(env);
    const m = await ready(env);
    const gate = deferred();
    const read = env.handlers.e2ee_text_state;
    assert.ok(read);
    env.handlers.e2ee_text_state = async (a) => {
      await gate.promise;
      return read(a);
    };
    m.onChannelChanged(CH, ["history"]);
    await flush();
    assert.equal(env.linkGets().length, 0);
    if (off) env.flag = false;
    env.handlers.e2ee_text_state = read;
    gate.resolve();
    await env.advance(0);
    assert.equal(env.linkGets().length, off ? 0 : 1, `off=${off}`);
    assert.equal(builds(env), off ? 0 : 2, `off=${off}`);
    assert.deepEqual(env.notified, off ? [] : ["history_mismatch"]);
    m.dispose();
  }
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
  const R7 = at(7_000);
  const R4 = at(4_000);
  m.decryptHistory(CH, [row(R7, 7), row(R4, 4)]);
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
  // The walk stopped where the links end: one floor marker, placed 1 ms
  // after the loaded row below the floor (R-W4-32).
  assert.deepEqual(floors(env), [[G0, 5, "missing"]]);
  assert.deepEqual(floorAts(env), [T0 + 4_001]);
  assert.deepEqual(env.walkStates, ["idle", "running", "idle"]);
  // The row of an imported epoch decrypts, with the history sender note;
  // the row below the floor is a marker and cost no second walk.
  const r7 = env.msgViews.get(R7);
  assert.ok(r7?.status === "ok", JSON.stringify(r7));
  assert.equal(r7.text, `text of ${R7}`);
  assert.equal(r7.historySender, true);
  assert.equal(env.msgViews.get(R4)?.status, "marker");
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
  const R7 = at(7_000);
  const R4 = at(4_000);
  m.decryptHistory(CH, [row(R7, 7)]);
  await env.advance(0);
  assert.deepEqual(floors(env), [[G0, 8, "missing"]]);
  assert.deepEqual(floorAts(env), [T0 + 7_001]);
  assert.equal(env.msgViews.get(R7)?.status, "marker");
  // Another member wrote the missing links; the user asks again.
  env.links.push(link(G0, 8), link(G0, 7), link(G0, 6));
  m.walkHistory(CH);
  await env.advance(0);
  // The row whose epoch arrived is decrypted again without being asked.
  assert.equal(env.msgViews.get(R7)?.status, "ok");
  // The floor is epoch 5 now, and no loaded row is at or below it: the
  // lower marker is not raised yet (R-W4-32) ...
  assert.deepEqual(floors(env), [[G0, 8, "missing"]]);
  // ... it is as soon as such a row is loaded, placed by that row.
  m.decryptHistory(CH, [row(R4, 4)]);
  await env.advance(0);
  assert.deepEqual(floors(env), [
    [G0, 8, "missing"],
    [G0, 5, "missing"],
  ]);
  assert.deepEqual(floorAts(env), [T0 + 7_001, T0 + 4_001]);
  assert.equal(env.msgViews.get(R4)?.status, "marker");
  // The same stop again raises no third marker.
  m.walkHistory(CH);
  await env.advance(0);
  assert.equal(floors(env).length, 2);
  m.dispose();
});

test("floor marker (R-W4-32): 1 ms after the newest loaded row at or below the floor epoch, never at the clock", async () => {
  const env = new Env();
  shallow(env, 10, 9);
  const m = await ready(env);
  // Loaded: a row above the floor (epoch 12), one AT it (epoch 8, readable
  // after the walk) and two below it. R-W4-39: the readable row counts for
  // nothing; the newest row native REFUSED at or below the floor is E7.
  const E12 = at(12_000);
  const E8 = at(8_000);
  const E7 = at(7_000);
  const E6 = at(6_000);
  m.decryptHistory(CH, [row(E12, 12), row(E8, 8), row(E7, 7), row(E6, 6)]);
  await env.advance(0);
  assert.equal(env.msgViews.get(E8)?.status, "ok");
  assert.deepEqual(floors(env), [[G0, 8, "missing"]], "raised once");
  const marker = env.markers.find((x) => x.kind === "history_floor");
  assert.ok(marker && marker.kind === "history_floor");
  assert.equal(marker.atMs, T0 + 7_001);
  assert.equal(marker.atMs, (ulidTimeMs(E7) ?? Number.NaN) + 1);
  // Not the wall clock (the base bug: it sorted under the newest message),
  // and below the readable rows.
  assert.notEqual(marker.atMs, env.clock);
  assert.ok(marker.atMs < (ulidTimeMs(E12) ?? 0));
  assert.ok(marker.atMs < (ulidTimeMs(E8) ?? 0));
  assert.ok(marker.atMs > (ulidTimeMs(E6) ?? Number.POSITIVE_INFINITY));
  m.dispose();
});

test("floor marker (R-W4-39): a row native refuses AT the floor epoch counts, by the epoch native named", async () => {
  const env = new Env();
  // No link stored at all: the walk stops at the holder it starts from.
  shallow(env, 9, 10);
  const m = await ready(env);
  m.decryptHistory(CH, [row(at(7_000), 7)]);
  await env.advance(0);
  assert.deepEqual(floors(env), [[G0, 10, "missing"]]);
  assert.deepEqual(floorAts(env), [T0 + 7_001]);
  // Native does not hold the floor epoch's key (any more): its refusal
  // names epoch 10, the floor itself.
  env.held.delete(`${G0}:10`);
  m.onMessage(row(at(7_600), 10), false);
  await env.advance(0);
  assert.equal(env.msgViews.get(at(7_600))?.status, "marker");
  assert.deepEqual(floorAts(env), [T0 + 7_001, T0 + 7_601]);
  m.dispose();
});

test("floor marker (R-W4-39): placed by native's refusal, never by the row's own group and epoch", async () => {
  const env = new Env();
  shallow(env, 10, 9);
  const m = await ready(env);
  m.decryptHistory(CH, [row(at(12_000), 12), row(at(7_000), 7)]);
  await env.advance(0);
  assert.deepEqual(floorAts(env), [T0 + 7_001]);
  // Rows that CLAIM a group or an epoch below the floor and a later id
  // (still older than every readable row, so only this rule keeps them
  // out), but that native does not refuse for a missing key: a refusal of
  // another kind, and a row native decrypts whatever its wire epoch says.
  const inner = env.handlers.e2ee_text_decrypt;
  assert.ok(inner);
  env.handlers.e2ee_text_decrypt = (a) => {
    if (a.messageId === at(8_000)) {
      throw { type: "unknown_sender", user_id: PEER, device_id: "x", epoch: 2 };
    }
    if (a.messageId === at(8_100)) {
      throw { type: "internal", message: "no" };
    }
    if (a.messageId === at(8_200)) {
      return inner({
        ...a,
        encrypted: { ...a.encrypted, group_id: G0, epoch: 12 },
      });
    }
    return inner(a);
  };
  const unknownGroup = "f".repeat(64);
  m.decryptHistory(CH, [
    row(at(8_000), 2),
    row(at(8_100), 1, unknownGroup),
    row(at(8_200), 3),
  ]);
  await env.advance(0);
  assert.equal(env.msgViews.get(at(8_200))?.status, "ok");
  assert.equal(env.msgViews.get(at(8_000))?.status, "marker");
  assert.equal(env.msgViews.get(at(8_100))?.status, "marker");
  assert.deepEqual(floorAts(env), [T0 + 7_001], "the wire places nothing");
  m.dispose();
});

test("floor marker (R-W4-39): never above the oldest row native decrypted; a made-up row with a late id cannot pin it under the newest messages", async () => {
  const env = new Env();
  shallow(env, 10, 9);
  const m = await ready(env);
  const OK12 = at(12_000);
  m.decryptHistory(CH, [row(OK12, 12), row(at(7_000), 7)]);
  await env.advance(0);
  assert.deepEqual(floorAts(env), [T0 + 7_001]);
  // The server makes up rows native really refuses for a missing key (an
  // unknown group, an epoch below the floor), dated after every message.
  const unknownGroup = "f".repeat(64);
  const inner = env.handlers.e2ee_text_decrypt;
  assert.ok(inner);
  env.handlers.e2ee_text_decrypt = (a) => {
    if (a.encrypted.group_id === unknownGroup) {
      throw { type: "mls_group_not_found", group_id: unknownGroup };
    }
    return inner(a);
  };
  m.decryptHistory(CH, [
    row(at(90_000), 1, unknownGroup),
    row(at(91_000), 2),
    row(at(12_000 + 1), 3),
  ]);
  m.onMessage(row(at(95_000), 1), false);
  await env.advance(0);
  assert.equal(env.msgViews.get(at(91_000))?.status, "marker");
  assert.deepEqual(floorAts(env), [T0 + 7_001], "not moved above OK12");
  for (const atMs of floorAts(env)) {
    assert.ok(atMs <= (ulidTimeMs(OK12) ?? 0));
  }
  // Below the oldest readable row a refused row still moves it, and an
  // unknown group counts there too.
  m.onMessage(row(at(9_000), 1, unknownGroup), false);
  await env.advance(0);
  assert.deepEqual(floorAts(env), [T0 + 7_001, T0 + 9_001]);
  // An older readable row arrives under the raised marker: the marker is
  // placed again, below it.
  m.onMessage(row(at(8_500), 11), false);
  await env.advance(0);
  assert.equal(env.msgViews.get(at(8_500))?.status, "ok");
  assert.deepEqual(floorAts(env), [T0 + 7_001, T0 + 9_001, T0 + 7_001]);
  m.dispose();
});

test("floor marker (R-W4-39): with no row native refused below the oldest readable row, nothing is raised", async () => {
  const env = new Env();
  shallow(env, 10, 9);
  const m = await ready(env);
  m.walkHistory(CH);
  await env.advance(0);
  assert.equal(env.state().history_floor?.epoch, 8);
  m.decryptHistory(CH, [row(at(5_000), 12), row(at(6_000), 7)]);
  await env.advance(0);
  assert.equal(env.msgViews.get(at(6_000))?.status, "marker");
  assert.deepEqual(floors(env), []);
  m.dispose();
});

test("floor marker (R-W4-32): not raised while no row at or below the floor is loaded, raised when one is, moved by a newer one", async () => {
  const env = new Env();
  shallow(env, 10, 9);
  const m = await ready(env);
  // The user's walk stops at epoch 8 with no row loaded at all.
  m.walkHistory(CH);
  await env.advance(0);
  assert.ok(imports(env).length >= 1, "the walk ran");
  assert.equal(env.state().history_floor?.epoch, 8, "and stopped at 8");
  assert.equal(env.views.get(CH)?.historyWalk, "idle");
  assert.deepEqual(floors(env), [], "no row to place it by");
  // Rows above the floor, a row whose id is no ULID, and a pre-protect row
  // place nothing.
  m.decryptHistory(CH, [row(at(12_000), 12), row("R5", 5), plainRow(BELOW)]);
  await env.advance(0);
  assert.deepEqual(floors(env), []);
  // A row below the floor arrives: the marker is raised, by that row.
  m.decryptHistory(CH, [row(at(5_000), 5)]);
  await env.advance(0);
  assert.deepEqual(floors(env), [[G0, 8, "missing"]]);
  assert.deepEqual(floorAts(env), [T0 + 5_001]);
  // A page of newer rows at or below the floor: raised again, once for
  // the page, by the newest of them.
  m.decryptHistory(CH, [
    row(at(6_000), 6),
    row(at(7_500), 7),
    row(at(7_000), 7),
  ]);
  await env.advance(0);
  assert.deepEqual(floorAts(env), [T0 + 5_001, T0 + 7_501]);
  // Older rows, and the same rows again, move nothing.
  m.decryptHistory(CH, [row(at(3_000), 3), row(at(7_500), 7)]);
  m.onMessage(row(at(2_000), 2), false);
  await env.advance(0);
  assert.equal(floorAts(env).length, 2);
  // A single newer row (not a page) moves it too.
  m.onMessage(row(at(7_800), 7), false);
  await env.advance(0);
  assert.deepEqual(floorAts(env), [T0 + 5_001, T0 + 7_501, T0 + 7_801]);
  // R-W4-39: a newer row of the floor epoch that native decrypts does not.
  m.onMessage(row(at(7_900), 8), false);
  await env.advance(0);
  assert.equal(env.msgViews.get(at(7_900))?.status, "ok");
  assert.equal(floorAts(env).length, 3);
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
  m.decryptHistory(CH, [row(at(7_000), 7)]);
  await env.advance(0);
  assert.deepEqual(floors(env), [[G0, 8, "brand_new_stop"]]);
  const marker = env.markers.find((x) => x.kind === "history_floor");
  assert.ok(marker && marker.kind === "history_floor");
  assert.equal(historyFloorNotice(marker.stop).tone, "loud");
  const stopped = env.logged("error", /history walk stopped/);
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].ids.loud, true);
  assert.equal(env.msgViews.get(at(7_000))?.status, "marker");
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

test("walk: probes never come from the writers of the step above (through the real walk)", async () => {
  // One call with every step, and one call per step (a page per holder).
  for (const pageCap of [200, 1]) {
    const env = new Env();
    shallow(env, 0, 1);
    env.pageCap = pageCap;
    // Holder 10's link (it carries epoch 9's keys) was written by UA,
    // holder 9's by UB, holder 8's by UC. Holder 7 has none: the stop.
    env.links.push(
      link(G0, 10, G0, 9, { user_id: "UA", device_id: "dA" }),
      link(G0, 9, G0, 8, { user_id: "UB", device_id: "dB" }),
      link(G0, 8, G0, 7, { user_id: "UC", device_id: "dC" }),
    );
    const m = await ready(env);
    m.decryptHistory(CH, [
      row("A10", 10, G0, "UA"),
      row("B10", 10, G0, "UB"),
      row("A09", 9, G0, "UA"),
      row("B09", 9, G0, "UB"),
      row("C09", 9, G0, "UC"),
      row("A08", 8, G0, "UA"),
      row("B08", 8, G0, "UB"),
      row("C08", 8, G0, "UC"),
      row("A07", 7, G0, "UA"),
      row("C07", 7, G0, "UC"),
    ]);
    await env.advance(0);
    const calls = imports(env);
    // With one holder per page the steps are spread over several calls,
    // so the writers are carried from one call to the next.
    if (pageCap === 1) assert.ok(calls.length >= 3, `calls: ${calls.length}`);
    const steps = calls.flatMap((c) => c.steps);
    assert.deepEqual(
      steps.map((s) => s.holder_epoch),
      [10, 9, 8, 7],
    );
    const authors = (holder: number) =>
      (steps.find((s) => s.holder_epoch === holder)?.probes ?? [])
        .map((p) => p.author_user_id)
        .sort();
    const label = `page cap ${pageCap}`;
    // The first step: nobody wrote a link above it.
    assert.deepEqual(authors(10), ["UA", "UB"], label);
    // UA wrote the link that carried epoch 9's keys: never a probe there.
    assert.deepEqual(authors(9), ["UB", "UC"], label);
    // UB wrote the one that carried epoch 8's.
    assert.deepEqual(authors(8), ["UA", "UC"], label);
    // UC wrote the one that carried epoch 7's.
    assert.deepEqual(authors(7), ["UA"], label);
    m.dispose();
  }
});

/**
 * The device joined G0 at epoch 40 (now 50): nothing below 40 is held, and
 * native reports no floor (there was no walk yet). `oldest_held` is 40.
 * The server stores links for the holders 40 down to `linksDownTo`.
 */
function joinedLate(env: Env, linksDownTo = 21) {
  env.states.set(CH, st({ epoch: 50 }));
  env.group = groupBody({ current_epoch: 50 });
  env.seats = seatsBody({ as_of_epoch: 50 });
  env.tops.set(G0, 50);
  env.held.clear();
  for (let e = 40; e <= 50; e++) env.held.add(`${G0}:${e}`);
  env.oldest.set(G0, 40);
  for (let e = 40; e >= linksDownTo; e--) env.links.push(link(G0, e));
}

test("walk start (A4): a missing epoch far below the join epoch starts at oldest_held, with no floor and with an older run's floor", async () => {
  for (const olderRun of [false, true]) {
    const env = new Env();
    joinedLate(env);
    if (olderRun) {
      // An earlier membership (epochs 2 to 10) is still held, and native
      // keeps that run's floor: the gap 11 to 39 lies ABOVE the floor.
      env.state().history_floor = {
        group_id: G0,
        epoch: 2,
        stopped: "missing",
      };
      for (let e = 2; e <= 10; e++) env.held.add(`${G0}:${e}`);
    }
    const label = `older run: ${olderRun}`;
    const m = await ready(env);
    m.decryptHistory(CH, [row("R25", 25)]);
    await env.advance(0);
    const calls = imports(env);
    assert.ok(calls.length >= 1, label);
    // 15 epochs below the join epoch: the base guess (26, then up to 29)
    // never met a held epoch.
    assert.equal(calls[0].steps[0].holder_epoch, 40, label);
    assert.equal(calls[0].steps[0].holder_group_id, G0, label);
    assert.equal(
      calls.filter((c) => c.session === null).length,
      1,
      `${label}: one session start, none refused`,
    );
    assert.equal(env.logged("warn", /start holder refused/).length, 0, label);
    assert.equal(env.msgViews.get("R25")?.status, "ok", label);
    assert.equal(env.views.get(CH)?.historyWalk, "idle", label);
    m.dispose();
  }
});

test("walk start (A4): a miss below the floor still starts at the floor, and a hole inside the held run one above it", async () => {
  // Below the floor: the floor wins over oldest_held.
  {
    const env = new Env();
    shallow(env);
    env.oldest.set(G0, 15);
    const m = await ready(env);
    m.decryptHistory(CH, [row("R7", 7)]);
    await env.advance(0);
    assert.equal(imports(env)[0].steps[0].holder_epoch, 10);
    assert.equal(env.msgViews.get("R7")?.status, "ok");
    m.dispose();
  }
  // A hole at epoch 45, above oldest_held (40): the guess is 46.
  {
    const env = new Env();
    joinedLate(env);
    env.held.delete(`${G0}:45`);
    env.links.push(link(G0, 46));
    const m = await ready(env);
    m.decryptHistory(CH, [row("R45", 45)]);
    await env.advance(0);
    assert.equal(imports(env)[0].steps[0].holder_epoch, 46);
    m.dispose();
  }
  // No oldest_held at all (an older shell): the guess, as before.
  {
    const env = new Env();
    joinedLate(env);
    env.oldest.clear();
    const m = await ready(env);
    m.decryptHistory(CH, [row("R38", 38)]);
    await env.advance(0);
    assert.deepEqual(
      imports(env)
        .filter((c) => c.session === null)
        .map((c) => c.steps[0].holder_epoch),
      [39, 40],
    );
    assert.equal(env.msgViews.get("R38")?.status, "ok");
    m.dispose();
  }
});

test("walkHistory (C4): after a walk that ended retry_later it starts again from the gap, not only from the floor", async () => {
  const env = new Env();
  joinedLate(env);
  env.importFail = { type: "internal", message: "bridge down" };
  const m = await ready(env);
  m.decryptHistory(CH, [row("R25", 25)]);
  await env.advance(0);
  assert.deepEqual(env.msgViews.get("R25"), { status: "pending" });
  assert.equal(env.views.get(CH)?.historyWalk, "retry_later");
  // Native reports no floor: a retry "from the floor" has nowhere to start.
  assert.equal(env.state().history_floor, undefined);
  const before = imports(env).length;
  assert.equal(before, 1);
  // The bridge is back; the list asks once (FXU: on initial load).
  env.importFail = null;
  m.walkHistory(CH);
  await env.advance(0);
  const retry = imports(env)[before];
  assert.ok(retry, "the retry reached native");
  assert.equal(retry.session, null);
  assert.equal(retry.steps[0].holder_epoch, 40, "from the gap's start");
  assert.equal(env.msgViews.get("R25")?.status, "ok");
  assert.equal(env.views.get(CH)?.historyWalk, "idle");
  // Idle again: a further call starts from the floor native reports now.
  const floor = env.state().history_floor;
  assert.ok(floor);
  const then = imports(env).length;
  m.walkHistory(CH);
  await env.advance(0);
  assert.equal(imports(env)[then].steps[0].holder_epoch, floor.epoch);
  m.dispose();
});

test("older shell (R-W4-33): a missing import command latches history off; before-join rows get their marker, not the hourglass", async () => {
  const answers: unknown[] = [
    "Command e2ee_text_history_import not found",
    "Command e2ee_text_history_import not allowed by ACL",
    new TypeError("native.e2eeTextHistoryImport is not a function"),
    { type: "invalid_argument", field: "command" },
    { type: "invalid_argument", field: "name" },
    { code: "UNIMPLEMENTED" },
  ];
  for (const answer of answers) {
    const label = JSON.stringify(answer) ?? String(answer);
    const env = new Env();
    shallow(env);
    env.oldest.set(G0, 10);
    env.importFail = answer;
    const m = await ready(env);
    m.decryptHistory(CH, [row("R7", 7)]);
    await env.advance(0);
    assert.equal(imports(env).length, 1, label);
    // Final, and the S2 gray marker: not `pending` (the hourglass).
    assert.deepEqual(
      env.msgViews.get("R7"),
      { status: "marker", kind: "sent_before_join" },
      label,
    );
    assert.equal(env.views.get(CH)?.historyWalk, "idle", label);
    assert.ok(!env.walkStates.includes("retry_later"), label);
    assert.deepEqual(floors(env), [], label);
    assert.equal(env.logged("error", /history command missing/).length, 1);
    // Off for the session: the next page, the user's retry and a member
    // duty start nothing.
    const gets = env.linkGets().length;
    m.decryptHistory(CH, [row("R6", 6)]);
    m.walkHistory(CH);
    m.onEnvelope(envelope("E21", 21));
    await env.advance(30_000);
    assert.equal(imports(env).length, 1, `${label}: a second walk`);
    assert.equal(env.linkGets().length, gets, `${label}: a link GET`);
    assert.equal(builds(env), 0, `${label}: a link build`);
    assert.deepEqual(
      env.msgViews.get("R6"),
      { status: "marker", kind: "sent_before_join" },
      label,
    );
    assert.equal(env.logged("error", /history command missing/).length, 1);
    m.dispose();
  }
});

test("older shell (RA4): a TypeError that names no missing command is a retry, never the latch", async () => {
  for (const answer of [
    new TypeError("Failed to fetch"),
    new TypeError("Cannot read properties of undefined (reading 'invoke')"),
  ]) {
    const label = answer.message;
    const env = new Env();
    shallow(env);
    env.oldest.set(G0, 10);
    env.importFail = answer;
    const m = await ready(env);
    m.decryptHistory(CH, [row("R7", 7)]);
    await env.advance(0);
    assert.equal(imports(env).length, 1, label);
    // Not final: the row waits, and the walk may run again.
    assert.deepEqual(env.msgViews.get("R7"), { status: "pending" }, label);
    assert.equal(env.views.get(CH)?.historyWalk, "retry_later", label);
    assert.equal(env.logged("error", /history command missing/).length, 0);
    env.importFail = null;
    m.walkHistory(CH);
    await env.advance(0);
    assert.equal(env.msgViews.get("R7")?.status, "ok", label);
    m.dispose();
  }
  // The link build: logged, and the next duty builds again.
  const env = new Env();
  shallow(env);
  env.oldest.set(G0, 10);
  env.handlers.e2ee_text_history_link_build = () => {
    throw new TypeError("Failed to fetch");
  };
  const m = await ready(env);
  m.onEnvelope(envelope("E21", 21));
  await env.advance(30_000);
  m.onEnvelope(envelope("E22", 22));
  await env.advance(30_000);
  assert.equal(builds(env), 2, "the second duty still builds");
  assert.equal(env.logged("error", /history command missing/).length, 0);
  m.dispose();
});

test("older shell (FT8): a not found that names no history command is a retry, never the latch", async () => {
  for (const answer of [
    "group not found",
    "Command e2ee_text_decrypt not found",
    new Error("session not found"),
    { message: "Unimplemented method" },
    new TypeError("window.__TAURI__.invoke is not a function"),
  ]) {
    const label = JSON.stringify(answer) ?? String(answer);
    const env = new Env();
    shallow(env);
    env.oldest.set(G0, 10);
    env.importFail = answer;
    const m = await ready(env);
    m.decryptHistory(CH, [row("R7", 7)]);
    await env.advance(0);
    assert.equal(imports(env).length, 1, label);
    // Not final: the row waits, and the walk may run again.
    assert.deepEqual(env.msgViews.get("R7"), { status: "pending" }, label);
    assert.equal(env.views.get(CH)?.historyWalk, "retry_later", label);
    assert.equal(env.logged("error", /history command missing/).length, 0);
    env.importFail = null;
    m.walkHistory(CH);
    await env.advance(0);
    assert.equal(env.msgViews.get("R7")?.status, "ok", label);
    m.dispose();
  }
  // The link build: logged, and the next duty builds again.
  const env = new Env();
  shallow(env);
  env.oldest.set(G0, 10);
  env.handlers.e2ee_text_history_link_build = () => {
    throw "group not found";
  };
  const m = await ready(env);
  m.onEnvelope(envelope("E21", 21));
  await env.advance(30_000);
  m.onEnvelope(envelope("E22", 22));
  await env.advance(30_000);
  assert.equal(builds(env), 2, "the second duty still builds");
  assert.equal(env.logged("error", /history command missing/).length, 0);
  m.dispose();
});

test("older shell (R-W4-33): a row an earlier walk left pending is settled by the latch, and a transient failure is no latch", async () => {
  const env = new Env();
  shallow(env);
  env.oldest.set(G0, 10);
  // A transient failure first: retry_later, the row waits, nothing latched.
  env.importFail = { type: "internal", message: "bridge down" };
  const m = await ready(env);
  m.decryptHistory(CH, [row("R7", 7)]);
  await env.advance(0);
  assert.deepEqual(env.msgViews.get("R7"), { status: "pending" });
  assert.equal(env.views.get(CH)?.historyWalk, "retry_later");
  assert.equal(env.logged("error", /history command missing/).length, 0);
  // Then the shell answers "no such command" to the next page's walk.
  env.importFail = "command e2ee_text_history_import not found";
  m.decryptHistory(CH, [row("R6", 6)]);
  await env.advance(0);
  assert.equal(imports(env).length, 2);
  for (const id of ["R7", "R6"]) {
    assert.deepEqual(
      env.msgViews.get(id),
      { status: "marker", kind: "sent_before_join" },
      id,
    );
  }
  assert.equal(env.views.get(CH)?.historyWalk, "idle");
  m.dispose();
});

test("older shell (R-W4-33): a missing link build command latches history off too", async () => {
  const env = new Env();
  shallow(env);
  env.oldest.set(G0, 10);
  env.handlers.e2ee_text_history_link_build = () => {
    throw "command e2ee_text_history_link_build not found";
  };
  const m = await ready(env);
  m.onEnvelope(envelope("E21", 21));
  await env.advance(0);
  assert.equal(builds(env), 1);
  assert.equal(env.logged("error", /history command missing/).length, 1);
  const gets = env.linkGets().length;
  // No further build, no link GET, no walk; an own commit's link is not
  // PUT either.
  m.onEnvelope(envelope("E22", 22));
  m.decryptHistory(CH, [row("R7", 7)]);
  m.walkHistory(CH);
  await commit(m);
  await env.advance(30_000);
  assert.equal(builds(env), 1);
  assert.equal(env.linkGets().length, gets);
  assert.equal(imports(env).length, 0);
  assert.equal(env.linkPuts().length, 0);
  assert.deepEqual(env.msgViews.get("R7"), {
    status: "marker",
    kind: "sent_before_join",
  });
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
  // "From a verified state": the same lines on a state that holds no list
  // report nothing, however often it is read.
  const list = env.state().seat_list;
  Object.assign(env.state(), POLICY, {
    seat_list: null,
    verdict: "no_seat_list",
  });
  const m = await ready(env);
  await m.refresh(CH, "manual");
  await env.advance(0);
  assert.deepEqual(env.policies, []);
  // The list is held and verified: reported, once.
  Object.assign(env.state(), { seat_list: list, verdict: "ok" });
  await m.refresh(CH, "manual");
  await m.refresh(CH, "manual");
  await env.advance(0);
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
  // "Once per change": each of the lines, changed alone, is one report;
  // reading the same state again is none.
  const changes: [Partial<TextChannelState>, Record<string, unknown>][] = [
    [{ history_time_limit: 5 }, { timeLimit: 5 }],
    [{ pre_history: "wiped" }, { preHistory: "wiped" }],
    [{ history_boundary: BELOW }, { boundary: BELOW }],
  ];
  let want: Record<string, unknown> = {
    verified: true,
    boundary: BOUNDARY,
    preHistory: "kept",
    timeLimit: Number.MAX_SAFE_INTEGER,
  };
  let count = 1;
  for (const [over, changed] of changes) {
    Object.assign(env.state(), over);
    want = { ...want, ...changed };
    count += 1;
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(env.policies.length, count, JSON.stringify(over));
    const sent = env.policies as { p: unknown }[];
    assert.deepEqual(sent[count - 1].p, want);
    await m.refresh(CH, "manual");
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(env.policies.length, count, "the same state again");
  }
  // A change that is no part of the policy (the epoch, the flag) is none.
  env.state().epoch = 4;
  env.flag = false;
  await m.refresh(CH, "manual");
  await env.advance(0);
  assert.equal(env.policies.length, count);
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

/**
 * An owner device (the signer of the held list) whose list says `hidden`.
 * With the `breaker`: an Update loop fails the test instead of hanging it.
 */
function ownerHidden(env: Env) {
  env.wonLink = null;
  env.ownerDevice();
  env.state().history_setting = "hidden";
  breaker(env);
}

/** The owner flow's effect: native now holds a list with the asked line. */
function flipDeps(env: Env, then?: () => void) {
  return fakeDeps(env, {
    owner: {
      setHistory: async (_ops, _port, _ch, visible) => {
        env.state().history_setting = visible ? "visible" : "hidden";
        then?.();
      },
    },
  });
}

const updates = (env: Env) => env.calls("e2ee_text_update").length;

/**
 * Cuts a runaway. Everything here runs on microtasks, so a real Update
 * loop would hang the run instead of failing it: at the 50th Update the
 * flag goes off (an own Update needs it), the loop ends and the count
 * assertion fails.
 */
function breaker(env: Env) {
  const inner = env.handlers.e2ee_text_update;
  assert.ok(inner);
  let count = 0;
  env.handlers.e2ee_text_update = (a) => {
    count += 1;
    if (count >= 50) env.flag = false;
    return inner(a);
  };
}

test("history setting: a change is followed by this device's own Update, no change by none", async () => {
  const env = new Env();
  ownerHidden(env);
  const m = await ready(env, flipDeps(env));
  await m.setHistoryVisible(CH, true);
  await env.advance(0);
  assert.equal(updates(env), 1);
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  assert.equal(env.state().epoch, 4, "the Update moved the epoch");
  await m.setHistoryVisible(CH, true);
  await env.advance(0);
  assert.equal(updates(env), 1, "already visible");
  // And back: another change, another Update.
  await m.setHistoryVisible(CH, false);
  await env.advance(0);
  assert.equal(updates(env), 2);
  m.dispose();
});

test("own Update (B6): issued when the flow rejects after its list landed", async () => {
  const env = new Env();
  ownerHidden(env);
  const failure = { source: "client", reason: "protect_busy" };
  const m = await ready(
    env,
    flipDeps(env, () => {
      throw failure;
    }),
  );
  await assert.rejects(m.setHistoryVisible(CH, true), (e) => e === failure);
  await env.advance(0);
  assert.equal(env.state().history_setting, "visible", "the list landed");
  assert.equal(updates(env), 1);
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  m.dispose();
});

test("own Update (B6): issued from the state read when a stored publish lands outside setHistoryVisible", async () => {
  const env = new Env();
  ownerHidden(env);
  const m = await ready(env);
  assert.equal(updates(env), 0);
  // Another owner action of this device finished the stored history list:
  // native holds it, nobody called setHistoryVisible.
  env.state().history_setting = "visible";
  await m.refresh(CH, "commit");
  await env.advance(0);
  assert.equal(updates(env), 1);
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  m.dispose();
});

test("own Update (B6): a change that landed just before a restart is followed up by the next session, once", async () => {
  const env = new Env();
  ownerHidden(env);
  const key = `${PROTECTED_HISTORY_EPOCH_KEY_PREFIX}${SELF}:${CH}`;
  const first = await ready(env);
  // The line the epoch began under is stored: ids and the setting only.
  assert.deepEqual(JSON.parse(env.storeMap.get(key) ?? "null"), {
    g: G0,
    s: "hidden",
  });
  // The list lands and the app dies before any state read saw it.
  first.dispose();
  env.state().history_setting = "visible";
  assert.equal(updates(env), 0);
  // The next session, over the same storage: the same epoch, another line.
  const second = await ready(env);
  await env.advance(0);
  assert.equal(updates(env), 1);
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  assert.deepEqual(JSON.parse(env.storeMap.get(key) ?? "null"), {
    g: G0,
    s: "visible",
  });
  second.dispose();
  // A third session finds nothing owed.
  const third = await ready(env);
  await env.advance(0);
  assert.equal(updates(env), 1);
  third.dispose();
});

test("own Update (R-W4-41): never loops: at most 3 attempts per state, one per later state read, none after it landed", async () => {
  assert.equal(HISTORY_UPDATE_TRIES, 3);
  // The Update fails every time: one attempt per state read, three in
  // all, however often the state is read after that.
  {
    const env = new Env();
    ownerHidden(env);
    env.handlers.e2ee_text_update = () => {
      throw { type: "internal", message: "no" };
    };
    breaker(env);
    const m = await ready(env);
    env.state().history_setting = "visible";
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(updates(env), 1, "the first attempt");
    // No timer retries it: only a later state read does.
    await env.advance(3_600_000);
    assert.equal(updates(env), 1, "no retry without a state read");
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(updates(env), 2, "retried on the next state read");
    for (let i = 0; i < 6; i++) {
      await m.refresh(CH, "manual");
      await env.advance(0);
    }
    await env.advance(3_600_000);
    assert.equal(updates(env), 3, "three attempts for this state, no more");
    // Another member's commit moves the epoch: the new epoch began under
    // the new line, nothing is owed any more.
    env.state().epoch = 4;
    for (let i = 0; i < 3; i++) {
      await m.refresh(CH, "manual");
      await env.advance(0);
    }
    assert.equal(updates(env), 3);
    // The line changes back within this epoch: another state, its own
    // three attempts, not more.
    env.state().history_setting = "hidden";
    for (let i = 0; i < 6; i++) {
      await m.refresh(CH, "manual");
      await env.advance(0);
    }
    assert.equal(updates(env), 6);
    m.dispose();
  }
  // A retry that lands ends it.
  {
    const env = new Env();
    ownerHidden(env);
    const inner = env.handlers.e2ee_text_update;
    assert.ok(inner);
    let fail = true;
    env.handlers.e2ee_text_update = (a) => {
      if (fail) throw { type: "internal", message: "no" };
      return inner(a);
    };
    breaker(env);
    const m = await ready(env);
    env.state().history_setting = "visible";
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(updates(env), 1);
    assert.equal(env.calls("e2ee_text_commit_won").length, 0);
    fail = false;
    for (let i = 0; i < 4; i++) {
      await m.refresh(CH, "manual");
      await env.advance(0);
    }
    assert.equal(updates(env), 2, "the retry");
    assert.equal(env.calls("e2ee_text_commit_won").length, 1, "landed");
    m.dispose();
  }
  // The Update lands: its own state reads start no second one.
  {
    const env = new Env();
    ownerHidden(env);
    breaker(env);
    const m = await ready(env);
    env.state().history_setting = "visible";
    for (let i = 0; i < 5; i++) {
      await m.refresh(CH, "manual");
      await env.advance(0);
    }
    await env.advance(3_600_000);
    assert.equal(updates(env), 1);
    assert.equal(env.calls("e2ee_text_commit_won").length, 1);
    m.dispose();
  }
});

test("own Update (B6): only the device that signed the list, only an owner device, only while the flag is on, nothing after dispose", async () => {
  // Another device of the owner signed the list.
  {
    const env = new Env();
    ownerHidden(env);
    const list = env.state().seat_list;
    assert.ok(list);
    env.state().seat_list = { ...list, signer_device_id: "dev-other" };
    const m = await ready(env);
    env.state().history_setting = "visible";
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(updates(env), 0, "not the signer");
    m.dispose();
  }
  // A member's device.
  {
    const env = new Env();
    env.wonLink = null;
    env.state().history_setting = "hidden";
    const m = await ready(env);
    env.state().history_setting = "visible";
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(updates(env), 0, "not an owner device");
    assert.deepEqual(env.storeKeys(PROTECTED_HISTORY_EPOCH_KEY_PREFIX), []);
    m.dispose();
  }
  // The flag off: an Update is a write. It follows once the flag is on.
  {
    const env = new Env();
    ownerHidden(env);
    const m = await ready(env);
    env.flag = false;
    env.state().history_setting = "visible";
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(updates(env), 0, "flag off");
    env.flag = true;
    await m.refresh(CH, "manual");
    await env.advance(0);
    assert.equal(updates(env), 1, "flag on again");
    m.dispose();
  }
  // Disposed before the state read that would have seen the change.
  {
    const env = new Env();
    ownerHidden(env);
    const m = await ready(env);
    m.dispose();
    env.state().history_setting = "visible";
    await env.advance(3_600_000);
    assert.equal(updates(env), 0);
  }
});

test("own Update (R-W4-41): an epoch first read while the flag is off is on record under the line it began with", async () => {
  const env = new Env();
  ownerHidden(env);
  const m = await ready(env);
  // The flag reads off (a failed fetch) while another member's commit
  // moves the epoch; the list still says hidden.
  env.flag = false;
  env.state().epoch = 4;
  await m.refresh(CH, "manual");
  await env.advance(0);
  // The list changes within that epoch, then the flag is back.
  env.state().history_setting = "visible";
  await m.refresh(CH, "manual");
  await env.advance(0);
  assert.equal(updates(env), 0, "flag off: no write");
  env.flag = true;
  await m.refresh(CH, "manual");
  await env.advance(0);
  assert.equal(updates(env), 1, "epoch 4 began under hidden: owed");
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  m.dispose();
});

test("own Update (R-W4-41): the stored line is rewritten for a new group, and nothing is stored while the flag is off", async () => {
  const env = new Env();
  ownerHidden(env);
  const key = `${PROTECTED_HISTORY_EPOCH_KEY_PREFIX}${SELF}:${CH}`;
  const m = await ready(env);
  assert.deepEqual(JSON.parse(env.storeMap.get(key) ?? "null"), {
    g: G0,
    s: "hidden",
  });
  // The channel moves to its successor group under the same line.
  const s = env.state();
  s.group_id = G1;
  s.generation = 1;
  s.epoch = 0;
  env.group = groupBody({ group_id: G1, generation: 1, current_epoch: 0 });
  env.seats = seatsBody({
    as_of_group_id: G1,
    as_of_epoch: 0,
    list: {
      version: 1,
      body: "sloga-seat-list-v1\n...",
      signature: "SIG",
      signer_user_id: SELF,
      signer_device_id: DEV,
      handovers: [],
    },
  });
  await m.refresh(CH, "manual");
  await env.advance(0);
  assert.equal(env.state().group_id, G1, "still the successor");
  assert.deepEqual(JSON.parse(env.storeMap.get(key) ?? "null"), {
    g: G1,
    s: "hidden",
  });
  assert.equal(updates(env), 0);
  m.dispose();
  // Flag off from the start: the line is kept in memory only.
  const off = new Env();
  ownerHidden(off);
  off.flag = false;
  const m2 = await ready(off);
  await m2.refresh(CH, "manual");
  await off.advance(0);
  assert.deepEqual(off.storeKeys(PROTECTED_HISTORY_EPOCH_KEY_PREFIX), []);
  m2.dispose();
});

test("own Update (RB4): not started, and not counted, behind another Update in flight", async () => {
  const env = new Env();
  ownerHidden(env);
  // The server holds the commit POST of the first Update until released.
  const post = deferred();
  let hold = true;
  const held: string[] = [];
  const api = env.api.bind(env);
  env.api = async (method: string, path: string, body?: unknown) => {
    const waits = hold && method === "POST" && /\/commits$/.test(path);
    if (waits) {
      hold = false;
      held.push(path);
    }
    const answer = await api(method, path, body);
    if (waits) await post.promise;
    return answer;
  };
  const m = await ready(env);
  // An Update native requires is in flight (the join path commits it) ...
  env.state().update_required = true;
  const joined = m.ensureJoined(CH);
  joined.catch(() => undefined);
  await flush();
  assert.equal(updates(env), 1, "the required Update is in flight");
  assert.equal(held.length, 1, "its commit POST is held");
  // ... when the list changes. State reads behind it start nothing.
  env.state().history_setting = "visible";
  const reads = env.calls("e2ee_text_state").length;
  for (let i = 0; i < 3; i++) {
    void m.refresh(CH, "manual");
    await flush();
  }
  assert.ok(env.calls("e2ee_text_state").length > reads, "the state was read");
  assert.equal(updates(env), 1, "nothing started behind it");
  // The Update lands: its epoch began under the new line, nothing is owed.
  post.resolve();
  await joined.catch(() => undefined);
  await env.advance(0);
  await m.refresh(CH, "manual");
  await env.advance(0);
  assert.equal(env.calls("e2ee_text_commit_won").length, 1);
  assert.equal(env.state().epoch, 4);
  assert.equal(updates(env), 1, "no second Update");
  assert.deepEqual(
    env.logs
      .filter((l) => /history setting changed: own update/.test(l.msg))
      .map((l) => l.ids.attempt),
    [],
    "the reads behind the other Update counted for nothing",
  );
  m.dispose();
});

test("stored history line (RA5): forgetChannel deletes one channel's, forgetHistoryLines every line of this user and no other key", async () => {
  const env = new Env();
  ownerHidden(env);
  const mine = `${PROTECTED_HISTORY_EPOCH_KEY_PREFIX}${SELF}:`;
  const key = `${mine}${CH}`;
  // Lines an earlier session left: channels this manager does not hold,
  // another user's, and a key of another kind.
  const other = `${PROTECTED_HISTORY_EPOCH_KEY_PREFIX}UOTHER:${CH}`;
  const unrelated = `protected-send:${SELF}:${CH}:k`;
  env.storeMap.set(`${mine}GONE1`, JSON.stringify({ g: G0, s: "hidden" }));
  env.storeMap.set(`${mine}GONE2`, JSON.stringify({ g: G0, s: "visible" }));
  env.storeMap.set(other, JSON.stringify({ g: G0, s: "hidden" }));
  env.storeMap.set(unrelated, "x");
  const m = await ready(env);
  assert.ok(env.storeMap.has(key), "this session's line");
  // One channel, held or not.
  m.forgetChannel("GONE1");
  assert.equal(env.storeMap.has(`${mine}GONE1`), false);
  assert.ok(env.storeMap.has(key) && env.storeMap.has(`${mine}GONE2`));
  m.forgetChannel(CH);
  assert.equal(env.storeMap.has(key), false);
  // A channel that is still there gets its line back on the next read.
  await m.refresh(CH, "manual");
  await env.advance(0);
  assert.ok(env.storeMap.has(key));
  // Sign-out: every line of this user, nothing else, and none after it.
  m.forgetHistoryLines();
  assert.deepEqual(env.storeKeys(mine), []);
  assert.ok(env.storeMap.has(other), "another user's line");
  assert.equal(env.storeMap.get(unrelated), "x");
  env.state().epoch = 4;
  await m.refresh(CH, "manual");
  await env.advance(0);
  assert.deepEqual(env.storeKeys(mine), [], "nothing stored after sign-out");
  m.dispose();
  m.forgetHistoryLines();
  assert.deepEqual(env.storeKeys(mine), []);
  // A port without the key scan: the lines of the channels held.
  const bare = new Env();
  ownerHidden(bare);
  const m2 = await ready(bare);
  Object.defineProperty(bare, "storeKeys", { value: undefined });
  assert.ok(bare.storeMap.has(key));
  m2.forgetHistoryLines();
  assert.equal(bare.storeMap.has(key), false);
  m2.dispose();
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

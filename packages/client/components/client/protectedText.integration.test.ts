// Integration spec (W4b audit M5): the REAL manager (B1) with the REAL owner
// (B2) and message (B4) flows as deps, over a fake port — run with:
//   node --test --conditions=browser components/client/protectedText.integration.test.ts
// 1. send → native `update_required` → the manager commits the Update (one
//    already in flight is AWAITED, audit M1) → B4 retries the encrypt once →
//    the POST carries only the protected allowlist.
// 2. protect → genesis: B2 signs, PUTs, reads back, verifies (the self-pin)
//    and asks the manager to create generation 0, which it registers.
// Control: revert the M1 fix (an in-flight Update makes `#commitUpdate`
// return early) → test 1 FAILS.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ProtectedTextManager } from "./protectedText.ts";
import { textGroupId } from "./protectedTextIds.ts";
import {
  _resetMessageFlowsForTest,
  decryptRow,
  encryptAndSend,
  markerForError,
} from "./protectedTextMessages.ts";
import {
  _resetOwnerFlowsForTest,
  protect,
  setSeats,
} from "./protectedTextOwner.ts";
import type {
  PendingCommit,
  ProtectedChannelView,
  ProtectedMessageView,
  ProtectedTextManagerDeps,
  ProtectedTextPort,
  TextApiResponse,
  TextChannelState,
  TextCommand,
  TextCommandArgs,
  TextCommandResult,
  TextLogIds,
  TextSubmitCommitPayload,
} from "./protectedTextTypes";

const CH = "01J9Z3K4M5N6P7Q8R9S0T1V2W3";
const SELF = "USELF";
const DEV = "dev-self";
const PEER = "UPEER";
const G0 = await textGroupId(CH, 0);
const CID = "01J9Z3K4M5N6P7Q8R9S0T1V2W7";

const DEPS: ProtectedTextManagerDeps = {
  owner: { protect, setSeats },
  messages: { encryptAndSend, decryptRow, markerForError },
};

function ok(body: unknown, status = 200): TextApiResponse {
  return { status, resetAfterMs: null, body };
}

function state(over: Partial<TextChannelState> = {}): TextChannelState {
  return {
    channel_id: CH,
    group_id: G0,
    generation: 0,
    epoch: 3,
    state: "active",
    members: [
      {
        user_id: SELF,
        device_id: DEV,
        user_verified: true,
        on_signed_list: true,
        removed_locally: false,
      },
    ],
    seat_list: {
      version: 1,
      signer_user_id: SELF,
      signer_device_id: DEV,
      seats: [SELF],
      device_cap: 5,
      issued_at: 0,
    },
    owner_pin: {
      channel_id: CH,
      status: "pinned",
      owner_user_id: SELF,
      owner_device_id: DEV,
      owner_verified: true,
      source: "protect",
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

type Handlers = {
  [C in TextCommand]?: (
    args: TextCommandArgs[C],
  ) => TextCommandResult[C] | Promise<TextCommandResult[C]>;
};
type Route = (m: string, p: string, b: unknown) => TextApiResponse | undefined;

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

class Port implements ProtectedTextPort {
  readonly selfUserId = SELF;
  readonly selfDeviceId = DEV;
  clock = 1_700_000_000_000;
  sleeps: { at: number; resolve: () => void }[] = [];
  nat: TextChannelState = state();
  pending: PendingCommit | null = null;
  handlers: Handlers = {};
  routes: Route[] = [];
  invokes: { cmd: TextCommand; args: unknown }[] = [];
  apiCalls: { method: string; path: string; body: unknown }[] = [];
  storeMap = new Map<string, string>();
  views = new Map<string, ProtectedChannelView>();
  msgViews = new Map<string, ProtectedMessageView>();

  invoke<C extends TextCommand>(
    cmd: C,
    args: TextCommandArgs[C],
  ): Promise<TextCommandResult[C]> {
    this.invokes.push({ cmd, args: structuredClone(args) });
    const h = this.handlers[cmd] as
      | ((a: TextCommandArgs[C]) => TextCommandResult[C])
      | undefined;
    if (!h) return Promise.reject({ type: "invalid_argument", field: cmd });
    return Promise.resolve().then(() => h(args));
  }
  async pinCallIdentities(_u: string, targets: string[]) {
    return targets;
  }
  async ownDeviceListing() {
    return { hash: "h", listing: [] };
  }
  async api(method: string, path: string, body?: unknown) {
    this.apiCalls.push({ method, path, body: structuredClone(body) });
    for (const r of this.routes) {
      const a = r(method, path, body);
      if (a) return a;
    }
    return ok({ type: "NotFound" }, 404);
  }
  async ack() {}
  now() {
    return this.clock;
  }
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      const s = { at: this.clock + ms, resolve };
      this.sleeps.push(s);
      signal.addEventListener("abort", () => {
        this.sleeps = this.sleeps.filter((x) => x !== s);
        reject(new Error("aborted"));
      });
    });
  }
  log(_l: string, _m: string, _i: TextLogIds) {}
  channelInfo(channelId: string) {
    return {
      channelId,
      name: "general",
      serverId: "S",
      serverOwnerId: SELF,
      serverProtected: true,
      locallyPinned: true,
    };
  }
  displayNames() {
    return [];
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
  notify() {}

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

  cmds(): TextCommand[] {
    return this.invokes.map((i) => i.cmd);
  }
}

function make(port: Port) {
  _resetOwnerFlowsForTest();
  _resetMessageFlowsForTest();
  return new ProtectedTextManager(
    port,
    {
      onView: (ch, v) => port.views.set(ch, v),
      onMessageView: (id, v) => port.msgViews.set(id, v),
      onTimelineMarker: () => undefined,
    },
    DEPS,
  );
}

/** Native + server answers shared by both flows. */
function baseline(port: Port) {
  port.handlers.e2ee_text_state = () => structuredClone(port.nat);
  port.handlers.e2ee_text_pin_own_devices = () => null;
  port.handlers.e2ee_mls_group_kind = () => "text";
  port.handlers.e2ee_text_pending_commit = () => port.pending;
  port.handlers.e2ee_text_commit_won = (a) => {
    port.nat.epoch = a.wonEpoch;
    port.nat.update_due = false;
    port.nat.update_required = false;
    port.pending = null;
    return {
      group_id: a.groupId,
      channel_id: CH,
      kind: "commit_applied",
      epoch: a.wonEpoch,
      removed_self: false,
      added: [],
      removed: [],
      new_devices: [],
      off_list: [],
      seat_list_adopted: null,
    };
  };
  port.handlers.e2ee_text_seat_list_verify = (a) => ({
    status: "accepted",
    version: 1,
    seats: [SELF],
    device_cap: 5,
    signer_user_id: a.list.signer_user_id,
    signer_device_id: a.list.signer_device_id,
    pinned_now: true,
  });
  // The DS answers a bare `Won` and keeps the row; the manager reads it
  // back before `_commit_won` (W3 2026-10-25, lane F1 follow-up).
  const rows: { group_id: string; epoch: number; [k: string]: unknown }[] = [];
  port.routes.push((m, p, b) => {
    if (m === "POST" && /^\/mls\/groups\/[0-9a-f]+\/commits$/.test(p)) {
      const c = b as TextSubmitCommitPayload;
      rows.push({
        group_id: p.split("/")[3],
        epoch: c.epoch,
        committer: { user_id: SELF, device_id: c.device_id },
        commit: c.commit,
        added: [],
        removed: [],
      });
      return ok({ result: "Won" });
    }
    if (m === "GET" && /\/commits\?from_epoch=/.test(p)) {
      const from = Number(p.split("from_epoch=")[1]);
      const group_id = p.split("/")[3];
      return ok({
        commits: rows.filter((r) => r.group_id === group_id && r.epoch >= from),
        current_epoch: port.nat.epoch ?? 0,
      });
    }
    if (m === "GET" && p === `/mls/channels/${CH}/text_group`) {
      return ok({
        group_id: G0,
        channel_id: CH,
        generation: 0,
        current_epoch: port.nat.epoch ?? 0,
        members: [{ user_id: SELF, device_id: DEV }],
        pending_removals: [],
        member_added: [],
      });
    }
    return undefined;
  });
}

const LIST = {
  version: 1,
  body: "sloga-seat-list-v1\nGENESIS",
  signature: "GSIG",
  signer_user_id: SELF,
  signer_device_id: DEV,
};

test("send → update_required → in-flight Update awaited → retry encrypts once and posts", async () => {
  const port = new Port();
  baseline(port);
  port.nat = state({ update_required: true });
  port.routes.push((m, p) =>
    m === "GET" && p === `/channels/${CH}/seats`
      ? ok({
          list: { ...LIST, handovers: [] },
          as_of_epoch: port.nat.epoch,
          as_of_group_id: G0,
          seats: [{ user_id: SELF, seated_at: "" }],
          cooling: [],
          seats_used: 1,
          device_cap: 5,
          slot_cap: 10,
          entitlement_device_cap: 5,
        })
      : undefined,
  );
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  port.handlers.e2ee_text_update = (): TextSubmitCommitPayload => {
    port.pending = { epoch: 4, commit_b64: "UPD" };
    return { device_id: DEV, epoch: 4, commit: "UPD", welcome: null };
  };
  // The Update is in flight in its SUBMIT (outside the channel lane) while
  // the send arrives, so nothing but the M1 await makes the send wait.
  const api = port.api.bind(port);
  port.api = async (method: string, path: string, body?: unknown) => {
    if (method === "POST" && /\/mls\/groups\/[0-9a-f]+\/commits$/.test(path)) {
      await held;
    }
    return api(method, path, body);
  };
  port.handlers.e2ee_text_encrypt = () => {
    if (port.nat.update_required) {
      throw { type: "update_required", group_id: G0 };
    }
    return {
      nonce: CID,
      encrypted: {
        v: 1,
        group_id: G0,
        epoch: port.nat.epoch ?? 0,
        sender_device_id: DEV,
        nonce: "N",
        ciphertext: "CT",
        sig: "SG",
      },
    };
  };
  port.routes.push((m, p, b) =>
    m === "POST" && p === `/channels/${CH}/messages`
      ? ok({ _id: "MSG1", author: SELF, channel: CH, ...(b as object) })
      : undefined,
  );
  const m = make(port);
  await m.refresh(CH, "open"); // the refresh starts the (held) Update
  await port.advance(0);
  const sent = m.send(CH, "hello", [], false, "outbox-1");
  sent.catch(() => undefined);
  await port.advance(0);
  release();
  await port.advance(0);
  const out = await sent;
  assert.equal(out.messageId, "MSG1");
  assert.equal(out.cid, CID);
  const encrypts = port.cmds().filter((c) => c === "e2ee_text_encrypt");
  assert.equal(encrypts.length, 2, "one refused encrypt + one retry");
  const order = port.cmds();
  const won = order.indexOf("e2ee_text_commit_won");
  assert.ok(won > 0 && won < order.lastIndexOf("e2ee_text_encrypt"));
  assert.equal(
    order.filter((c) => c === "e2ee_text_update").length,
    1,
    "a single Update served the refresh and the send",
  );
  const posts = port.apiCalls.filter(
    (c) => c.method === "POST" && c.path === `/channels/${CH}/messages`,
  );
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0].body as object).sort(), [
    "encrypted",
    "nonce",
  ]);
  const v = port.msgViews.get("MSG1");
  assert.ok(v?.status === "ok" && v.text === "hello");
  assert.equal([...port.storeMap.keys()].length, 0, "stored send cleared");
  m.dispose();
});

test("protect → genesis end to end (real B2): sign, PUT, read back, verify, create g0", async () => {
  const port = new Port();
  baseline(port);
  port.nat = state({
    group_id: null,
    generation: null,
    epoch: null,
    state: "none",
    members: [],
    seat_list: null,
    self_seated: false,
    verdict: "no_seat_list",
  });
  let protectedNow = false;
  let groupOpen = false;
  port.handlers.e2ee_text_seat_list_sign = (a) => {
    assert.equal(a.serverList, null, "genesis");
    assert.deepEqual(a.seats, [SELF, PEER]);
    return { ...LIST };
  };
  port.handlers.e2ee_text_group_create = (a) => {
    port.nat = state({ epoch: 0 });
    return {
      group_id: G0,
      generation: 0,
      payload: {
        group_id: G0,
        channel_id: a.channelId,
        device_id: DEV,
        supersedes: a.supersedes,
        kind: "Text",
        generation: 0,
      },
    };
  };
  port.routes.unshift((m, p) => {
    if (m === "GET" && p === `/channels/${CH}/seats`) {
      return ok({
        list: protectedNow ? { ...LIST, handovers: [] } : null,
        as_of_epoch: groupOpen ? 0 : null,
        as_of_group_id: groupOpen ? G0 : null,
        seats: [],
        cooling: [],
        seats_used: 0,
        device_cap: null,
        slot_cap: 10,
        entitlement_device_cap: 5,
      });
    }
    if (m === "PUT" && p === `/channels/${CH}/protect`) {
      protectedNow = true;
      return ok({ _id: CH, protected: true });
    }
    if (m === "GET" && p === `/channels/${CH}`) {
      return ok({ _id: CH, protected: protectedNow });
    }
    if (m === "POST" && p === "/mls/groups") {
      groupOpen = true;
      return ok({ result: "Created" });
    }
    if (m === "GET" && p === `/mls/channels/${CH}/text_group` && !groupOpen) {
      return ok({ type: "NotFound" }, 404);
    }
    return undefined;
  });
  const m = make(port);
  await m.protect(CH, [PEER], 5);
  await port.advance(0);
  const put = port.apiCalls.find((c) => c.method === "PUT");
  assert.deepEqual(put?.body, {
    seat_list: {
      body: LIST.body,
      signature: LIST.signature,
      signer_device_id: DEV,
    },
  });
  const verify = port.invokes.find(
    (i) => i.cmd === "e2ee_text_seat_list_verify",
  )?.args as TextCommandArgs["e2ee_text_seat_list_verify"];
  assert.equal(verify.list.signer_user_id, SELF);
  assert.equal(verify.asOfGroupId, null, "no group yet at the self-pin");
  const create = port.invokes.filter((i) => i.cmd === "e2ee_text_group_create");
  assert.equal(create.length, 1);
  assert.deepEqual(create[0].args, {
    channelId: CH,
    userId: SELF,
    supersedes: null,
  });
  const posts = port.apiCalls.filter(
    (c) => c.method === "POST" && c.path === "/mls/groups",
  );
  assert.equal(posts.length, 1);
  const view = port.views.get(CH);
  assert.equal(view?.native?.group_id, G0, "manager holds the new group");
  assert.equal(view?.publishInFlight, false);
  assert.equal(
    [...port.storeMap.keys()].some((k) => k.startsWith("protected-publish:")),
    false,
    "D7c entry cleared once resolved",
  );
  m.dispose();
});

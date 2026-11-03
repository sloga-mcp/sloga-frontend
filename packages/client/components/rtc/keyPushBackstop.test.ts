// Unit spec for the post-resolve key-push backstop (iOS call E2EE phase 2,
// ruling R4, W3 MUST 5). Run with Node's built-in runner:
//   node --test --conditions=browser components/rtc/keyPushBackstop.test.ts
// On iOS core emits `callKeysChanged` BEFORE the command resolves. After an
// epoch-advancing command resolves, the backstop must see that a push for
// THAT group reached the outcome epoch, otherwise pull keys itself, and go
// loud when the outcome carries no usable epoch.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type KeyPushBackstop,
  backstopBridge,
  createKeyPushBackstop,
  keyPushArrivesBeforeResolve,
  outcomeEpoch,
} from "./keyPushBackstop.ts";

const GROUP = "a".repeat(64);
const OTHER = "b".repeat(64);

// Result shapes as e2ee-core serializes them (`mls/mod.rs`): `removed` and
// `ctl` are omitted when empty (`skip_serializing_if`).
const CREATED = {
  group_id: GROUP,
  payload: { group_id: GROUP, channel_id: "chan", device_id: "dev" },
};
function processOutcome(kind: string, epoch: unknown, extra = {}) {
  return { group_id: GROUP, kind, epoch, removed_self: false, ...extra };
}

/** A backstop whose deps record every call. */
function harness(pull?: (groupId: string, epoch: number) => void) {
  const pulls: Array<[string, number]> = [];
  const lost: Array<[string, number]> = [];
  const backstop = createKeyPushBackstop({
    pull: (groupId, epoch) => {
      pulls.push([groupId, epoch]);
      pull?.(groupId, epoch);
    },
    onLost: (groupId, epoch) => lost.push([groupId, epoch]),
  });
  return { backstop, pulls, lost };
}

test("keyPushArrivesBeforeResolve: iOS only", () => {
  assert.equal(keyPushArrivesBeforeResolve("ios"), true);
  for (const platform of ["android", "web", "electron", "tauri", "", "iOS"]) {
    assert.equal(keyPushArrivesBeforeResolve(platform), false, platform);
  }
});

test("outcomeEpoch create: a well-formed MlsCallCreated is epoch 0", () => {
  assert.equal(outcomeEpoch("create", CREATED), 0);
  // No `epoch` field exists on the shape; one smuggled in is not read.
  assert.equal(outcomeEpoch("create", { ...CREATED, epoch: 9 }), 0);
});

test("outcomeEpoch create: an unreadable result is undefined (loud)", () => {
  for (const bad of [
    undefined,
    null,
    "created",
    {},
    { payload: CREATED.payload },
    { ...CREATED, group_id: "" },
    { ...CREATED, group_id: 7 },
  ]) {
    assert.equal(outcomeEpoch("create", bad), undefined, JSON.stringify(bad));
  }
});

test("outcomeEpoch process: welcome_joined / commit_applied give the epoch", () => {
  assert.equal(outcomeEpoch("process", processOutcome("welcome_joined", 3)), 3);
  assert.equal(outcomeEpoch("process", processOutcome("commit_applied", 7)), 7);
  assert.equal(outcomeEpoch("process", processOutcome("commit_applied", 0)), 0);
  const remove = processOutcome("commit_applied", 4, {
    removed_self: true,
    removed: [{ user_id: "u", device_id: "d" }],
  });
  assert.equal(outcomeEpoch("process", remove), 4);
});

test("outcomeEpoch process: duplicate / ctl_received are null (no advance)", () => {
  assert.equal(outcomeEpoch("process", processOutcome("duplicate", 3)), null);
  const ctl = processOutcome("ctl_received", 3, {
    ctl: { sender_user_id: "u", sender_device_id: "d", payload: "{}" },
  });
  assert.equal(outcomeEpoch("process", ctl), null);
  // Not advancing, so a missing epoch there is still nothing to check.
  assert.equal(
    outcomeEpoch("process", { group_id: GROUP, kind: "duplicate" }),
    null,
  );
});

test("outcomeEpoch process: an advancing kind without a usable epoch is undefined", () => {
  for (const kind of ["welcome_joined", "commit_applied"]) {
    for (const epoch of [undefined, null, "3", NaN, Infinity, -1, 1.5]) {
      assert.equal(
        outcomeEpoch("process", processOutcome(kind, epoch)),
        undefined,
        `${kind} ${String(epoch)}`,
      );
    }
  }
});

test("outcomeEpoch process: an unknown, missing or non-object outcome is undefined", () => {
  assert.equal(
    outcomeEpoch("process", processOutcome("epoch_moved", 3)),
    undefined,
  );
  assert.equal(
    outcomeEpoch("process", { group_id: GROUP, epoch: 3 }),
    undefined,
  );
  for (const bad of [undefined, null, 3, "commit_applied"]) {
    assert.equal(outcomeEpoch("process", bad), undefined, String(bad));
  }
});

test("outcomeEpoch commitWon: always an advance", () => {
  assert.equal(
    outcomeEpoch("commitWon", processOutcome("commit_applied", 2)),
    2,
  );
  for (const bad of [
    undefined,
    null,
    processOutcome("commit_applied", undefined),
    processOutcome("commit_applied", NaN),
    processOutcome("commit_applied", -1),
  ]) {
    assert.equal(outcomeEpoch("commitWon", bad), undefined);
  }
});

test("afterResolve: no push for the epoch -> pull with that group and epoch", () => {
  const { backstop, pulls, lost } = harness();
  backstop.afterResolve(GROUP, 3);
  assert.deepEqual(pulls, [[GROUP, 3]]);
  assert.deepEqual(lost, []);
});

test("afterResolve: a push older than the outcome epoch still pulls", () => {
  const { backstop, pulls, lost } = harness();
  backstop.notePush(GROUP, 2);
  backstop.afterResolve(GROUP, 3);
  assert.deepEqual(pulls, [[GROUP, 3]]);
  assert.deepEqual(lost, []);
});

test("afterResolve: a push that reached the epoch (or past it) -> nothing", () => {
  const { backstop, pulls, lost } = harness();
  backstop.notePush(GROUP, 3);
  backstop.afterResolve(GROUP, 3);
  backstop.notePush(GROUP, 6);
  backstop.afterResolve(GROUP, 5);
  assert.deepEqual(pulls, []);
  assert.deepEqual(lost, []);
});

test("notePush: a reordered lower push never lowers what was reached", () => {
  const { backstop, pulls } = harness();
  backstop.notePush(GROUP, 7);
  backstop.notePush(GROUP, 3);
  backstop.afterResolve(GROUP, 7);
  assert.deepEqual(pulls, []);
});

test("afterResolve: a push for ANOTHER group does not count", () => {
  const { backstop, pulls, lost } = harness();
  backstop.notePush(OTHER, 9);
  backstop.afterResolve(GROUP, 1);
  assert.deepEqual(pulls, [[GROUP, 1]]);
  assert.deepEqual(lost, []);
  // ...and the other group's own check still sees its push.
  backstop.afterResolve(OTHER, 9);
  assert.deepEqual(pulls, [[GROUP, 1]]);
});

test("notePush: a push with no usable epoch proves nothing", () => {
  for (const epoch of [NaN, Infinity, -1, 1.5]) {
    const { backstop, pulls } = harness();
    backstop.notePush(GROUP, epoch);
    backstop.afterResolve(GROUP, 5);
    assert.deepEqual(pulls, [[GROUP, 5]], String(epoch));
  }
});

test("afterResolve: no usable epoch -> onLost, never a pull or a silent pass", () => {
  const { backstop, pulls, lost } = harness();
  backstop.notePush(GROUP, 100);
  backstop.afterResolve(GROUP, undefined);
  for (const epoch of [NaN, Infinity, -1, 1.5]) {
    backstop.afterResolve(GROUP, epoch);
  }
  assert.deepEqual(pulls, []);
  assert.equal(lost.length, 5);
  assert.equal(lost[0][0], GROUP);
  assert.ok(Number.isNaN(lost[0][1]), "a missing epoch is reported as NaN");
  assert.deepEqual(
    lost.slice(1).map(([groupId]) => groupId),
    [GROUP, GROUP, GROUP, GROUP],
  );
});

test("afterResolve: an empty group id -> onLost", () => {
  const { backstop, pulls, lost } = harness();
  backstop.afterResolve("", 2);
  assert.deepEqual(pulls, []);
  assert.deepEqual(lost, [["", 2]]);
});

test("afterResolve: a pull that throws goes loud", () => {
  const { backstop, pulls, lost } = harness(() => {
    throw new Error("pull failed");
  });
  backstop.afterResolve(GROUP, 4);
  assert.deepEqual(pulls, [[GROUP, 4]]);
  assert.deepEqual(lost, [[GROUP, 4]]);
});

test("afterResolve: a pull whose promise rejects goes loud", async () => {
  const pulls: Array<[string, number]> = [];
  const lost: Array<[string, number]> = [];
  const backstop = createKeyPushBackstop({
    pull: async (groupId, epoch) => {
      pulls.push([groupId, epoch]);
      throw new Error("pull failed");
    },
    onLost: (groupId, epoch) => lost.push([groupId, epoch]),
  });
  backstop.afterResolve(GROUP, 4);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(pulls, [[GROUP, 4]]);
  assert.deepEqual(lost, [[GROUP, 4]]);
});

test("afterResolve: a pull whose promise resolves is not loud", async () => {
  const lost: Array<[string, number]> = [];
  const backstop = createKeyPushBackstop({
    pull: async () => undefined,
    onLost: (groupId, epoch) => lost.push([groupId, epoch]),
  });
  backstop.afterResolve(GROUP, 4);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(lost, []);
});

test("reset: pushes seen before it no longer count", () => {
  const { backstop, pulls } = harness();
  backstop.notePush(GROUP, 5);
  backstop.reset();
  backstop.afterResolve(GROUP, 5);
  assert.deepEqual(pulls, [[GROUP, 5]]);
});

test("iOS order end to end: push lands first, then the outcome resolves", () => {
  const { backstop, pulls, lost } = harness();
  // A delivered push for a commit, then its outcome: nothing to do.
  backstop.notePush(GROUP, 1);
  backstop.afterResolve(
    GROUP,
    outcomeEpoch("process", processOutcome("commit_applied", 1)) as number,
  );
  // The next commit's push is lost: the outcome alone triggers the pull.
  backstop.afterResolve(
    GROUP,
    outcomeEpoch("commitWon", processOutcome("commit_applied", 2)) as number,
  );
  assert.deepEqual(pulls, [[GROUP, 2]]);
  assert.deepEqual(lost, []);
});

// ---- backstopBridge: the session's bridge view (R12) -----------------------

const BOOM = new Error("native refused");
const PROBE = Symbol("probe");

type Reply = { ok: unknown } | { err: unknown } | { throws: unknown };

/** A base class with its own #private state. */
class FakeBase {
  #base = "base-secret";
  baseSecret(): string {
    return this.#base;
  }
  shadowed(): string {
    return `base:${this.#base}`;
  }
}

/**
 * A stand-in for E2EEBridge: every member reads a #private field, so a call
 * whose `this` is not the real instance throws a TypeError.
 */
class FakeBridge extends FakeBase {
  #secret = "secret";
  #mode = "initial";
  readonly label = "own-field";
  readonly calls: Array<[string, unknown[]]> = [];
  readonly replies = new Map<string, Reply>();

  #reply(name: string, args: unknown[]): Promise<unknown> {
    if (this.#secret !== "secret") throw new Error("unreachable");
    this.calls.push([name, args]);
    const reply = this.replies.get(name);
    if (!reply) throw new Error(`no reply set for ${name}`);
    if ("throws" in reply) throw reply.throws;
    return "err" in reply
      ? Promise.reject(reply.err)
      : Promise.resolve(reply.ok);
  }
  callCreate(channelId: string, userId: string, supersedes?: string) {
    return this.#reply("callCreate", [channelId, userId, supersedes]);
  }
  callCommitWon(groupId: string, wonEpoch: number) {
    return this.#reply("callCommitWon", [groupId, wonEpoch]);
  }
  processEnvelope(envelope: unknown, userId: string) {
    return this.#reply("processEnvelope", [envelope, userId]);
  }
  callFrameKeys(groupId: string) {
    return this.#reply("callFrameKeys", [groupId]);
  }
  shadowed(): string {
    return `sub:${this.#secret}`;
  }
  self(): this {
    if (this.#secret !== "secret") throw new Error("unreachable");
    return this;
  }
  get mode(): string {
    return this.#mode;
  }
  set mode(value: string) {
    this.#mode = value;
  }
  [PROBE](): string {
    return this.#secret;
  }
}

/** A backstop that records `afterResolve` and refuses everything else. */
function recordingBackstop() {
  const resolved: Array<[string, number | undefined]> = [];
  const backstop: KeyPushBackstop = {
    notePush: () => assert.fail("the view never notes a push"),
    afterResolve: (groupId, epoch) => resolved.push([groupId, epoch]),
    reset: () => assert.fail("the view never resets the backstop"),
  };
  return { backstop, resolved };
}

function setup() {
  const bridge = new FakeBridge();
  const { backstop, resolved } = recordingBackstop();
  const queue: Array<() => void> = [];
  const view = backstopBridge(bridge, backstop, {
    defer: (f) => queue.push(f),
  });
  const flush = () => {
    for (const f of queue.splice(0)) f();
  };
  return { bridge, view, resolved, queue, flush };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("backstopBridge: other members reach the real instance (#private reads work)", async () => {
  const { bridge, view, resolved, queue } = setup();
  bridge.replies.set("callFrameKeys", { ok: "keys" });
  assert.equal(await view.callFrameKeys(GROUP), "keys");
  // Bound, so even a detached call keeps the real `this`.
  const { callFrameKeys } = view;
  assert.equal(await callFrameKeys(GROUP), "keys");
  assert.equal(view.baseSecret(), "base-secret");
  assert.equal(view.shadowed(), "sub:secret", "the nearest member wins");
  assert.equal(view.self(), bridge);
  assert.equal(view[PROBE](), "secret", "symbol-keyed members too");
  assert.equal(view.label, "own-field", "own fields via the prototype link");
  assert.equal(view.mode, "initial");
  view.mode = "changed";
  assert.equal(bridge.mode, "changed", "a setter writes the real instance");
  assert.deepEqual(resolved, []);
  assert.equal(queue.length, 0, "an unwrapped member never defers");
});

test("backstopBridge: the real bridge itself is left untouched", async () => {
  const { bridge, view, queue } = setup();
  assert.notEqual(view, bridge);
  assert.equal(bridge.callCreate, FakeBridge.prototype.callCreate);
  assert.equal(Object.hasOwn(bridge, "callCreate"), false);
  bridge.replies.set("callCreate", { ok: CREATED });
  await bridge.callCreate("chan", "user");
  assert.equal(queue.length, 0);
});

test("backstopBridge callCreate: same args, same value, afterResolve(payload.group_id, 0) deferred", async () => {
  const { bridge, view, resolved, queue, flush } = setup();
  // R12: the group is the payload's (the field the session adopts).
  const created = { ...CREATED, group_id: OTHER };
  bridge.replies.set("callCreate", { ok: created });
  const out = await view.callCreate("chan", "user", undefined);
  assert.equal(out, created);
  assert.deepEqual(bridge.calls, [["callCreate", ["chan", "user", undefined]]]);
  assert.deepEqual(resolved, [], "nothing runs before the deferral");
  assert.equal(queue.length, 1);
  flush();
  assert.deepEqual(resolved, [[GROUP, 0]]);
});

test("backstopBridge callCreate: no readable payload group -> the empty group (loud)", async () => {
  const { bridge, view, resolved, flush } = setup();
  bridge.replies.set("callCreate", { ok: { group_id: GROUP, payload: {} } });
  await view.callCreate("chan", "user");
  flush();
  assert.deepEqual(resolved, [["", 0]]);
});

test("backstopBridge callCommitWon: the group is the ARGUMENT, the epoch the outcome's", async () => {
  const { bridge, view, resolved, flush } = setup();
  const outcome = { ...processOutcome("commit_applied", 2), group_id: OTHER };
  bridge.replies.set("callCommitWon", { ok: outcome });
  const out = await view.callCommitWon(GROUP, 2);
  assert.equal(out, outcome);
  assert.deepEqual(bridge.calls, [["callCommitWon", [GROUP, 2]]]);
  flush();
  assert.deepEqual(resolved, [[GROUP, 2]]);
});

test("backstopBridge callCommitWon: no usable epoch -> afterResolve(group, undefined)", async () => {
  const { bridge, view, resolved, flush } = setup();
  bridge.replies.set("callCommitWon", {
    ok: processOutcome("commit_applied", undefined),
  });
  await view.callCommitWon(GROUP, 2);
  flush();
  assert.deepEqual(resolved, [[GROUP, undefined]]);
});

test("backstopBridge processEnvelope: a processed advance -> the outcome's group and epoch", async () => {
  const { bridge, view, resolved, flush } = setup();
  const disp = {
    kind: "processed",
    outcome: { ...processOutcome("commit_applied", 5), group_id: OTHER },
    ack: true,
  };
  bridge.replies.set("processEnvelope", { ok: disp });
  const envelope = { group_id: OTHER };
  assert.equal(await view.processEnvelope(envelope, "user"), disp);
  assert.deepEqual(bridge.calls, [["processEnvelope", [envelope, "user"]]]);
  flush();
  assert.deepEqual(resolved, [[OTHER, 5]]);
});

test("backstopBridge processEnvelope: a processed advance without an epoch is checked (loud)", async () => {
  const { bridge, view, resolved, flush } = setup();
  bridge.replies.set("processEnvelope", {
    ok: { kind: "processed", outcome: processOutcome("welcome_joined", NaN) },
  });
  await view.processEnvelope({}, "user");
  flush();
  assert.deepEqual(resolved, [[GROUP, undefined]]);
});

test("backstopBridge processEnvelope: no advance, or not processed -> nothing deferred", async () => {
  for (const disp of [
    { kind: "processed", outcome: processOutcome("duplicate", 5), ack: true },
    { kind: "processed", outcome: processOutcome("ctl_received", 5) },
    { kind: "park", expected: 4, got: 6, ack: false },
    { kind: "drop", reason: "poisoned", loud: true, ack: true },
    { kind: "error", error: BOOM, ack: false },
  ]) {
    const { bridge, view, resolved, queue } = setup();
    bridge.replies.set("processEnvelope", { ok: disp });
    assert.equal(await view.processEnvelope({}, "user"), disp);
    assert.equal(queue.length, 0, disp.kind);
    assert.deepEqual(resolved, []);
  }
});

test("backstopBridge: a rejection passes through unchanged and never reaches the backstop", async () => {
  const cases: Array<[string, (v: FakeBridge) => Promise<unknown>]> = [
    ["callCreate", (v) => v.callCreate("chan", "user")],
    ["callCommitWon", (v) => v.callCommitWon(GROUP, 2)],
    ["processEnvelope", (v) => v.processEnvelope({}, "user")],
  ];
  for (const [name, call] of cases) {
    for (const reply of [{ err: BOOM }, { throws: BOOM }]) {
      const { bridge, view, resolved, queue } = setup();
      bridge.replies.set(name, reply);
      // A synchronous throw by the real method still becomes a rejection.
      const pending = call(view);
      await assert.rejects(pending, (error) => error === BOOM);
      await tick();
      assert.equal(queue.length, 0, `${name} ${Object.keys(reply)[0]}`);
      assert.deepEqual(resolved, []);
    }
  }
});

test("backstopBridge: nothing is deferred before the real command resolves", async () => {
  const { bridge, view, queue } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  bridge.replies.set("callCommitWon", {
    ok: gate.then(() => processOutcome("commit_applied", 3)),
  });
  const pending = view.callCommitWon(GROUP, 3);
  await tick();
  assert.equal(queue.length, 0);
  release();
  await pending;
  assert.equal(queue.length, 1);
});

test("backstopBridge: with a macrotask defer the session records its state before the pull", async () => {
  const bridge = new FakeBridge();
  let sessionMemo = "unset";
  const seen: Array<[string, number, string]> = [];
  const backstop = createKeyPushBackstop({
    pull: (groupId, epoch) => {
      seen.push([groupId, epoch, sessionMemo]);
    },
    onLost: () => assert.fail("not lost"),
  });
  const view = backstopBridge(bridge, backstop, {
    defer: (f) => setTimeout(f, 0),
  });
  bridge.replies.set("callCommitWon", {
    ok: processOutcome("commit_applied", 3),
  });
  await view.callCommitWon(GROUP, 3);
  sessionMemo = "recorded"; // the session's own bookkeeping after its await
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [[GROUP, 3, "recorded"]]);
});

test("backstopBridge + backstop: a push that landed first means no pull; a lost one pulls", async () => {
  const bridge = new FakeBridge();
  const pulls: Array<[string, number]> = [];
  const backstop = createKeyPushBackstop({
    pull: (groupId, epoch) => {
      pulls.push([groupId, epoch]);
    },
    onLost: () => assert.fail("not lost"),
  });
  const queue: Array<() => void> = [];
  const view = backstopBridge(bridge, backstop, {
    defer: (f) => queue.push(f),
  });
  backstop.notePush(GROUP, 3); // iOS: the push lands before the resolve
  bridge.replies.set("callCommitWon", {
    ok: processOutcome("commit_applied", 3),
  });
  await view.callCommitWon(GROUP, 3);
  bridge.replies.set("processEnvelope", {
    ok: { kind: "processed", outcome: processOutcome("commit_applied", 4) },
  });
  await view.processEnvelope({}, "user"); // epoch 4's push was lost
  for (const f of queue.splice(0)) f();
  assert.deepEqual(pulls, [[GROUP, 4]]);
});

test("backstopBridge: a bridge without a wrapped command does not grow one", () => {
  class PartialBridge {
    #secret = "s";
    callCreate() {
      return Promise.resolve(this.#secret);
    }
  }
  const { backstop } = recordingBackstop();
  const view = backstopBridge(new PartialBridge(), backstop, {
    defer: () => assert.fail("never deferred"),
  });
  assert.equal("callCommitWon" in view, false);
  assert.equal("processEnvelope" in view, false);
  assert.equal(typeof view.callCreate, "function");
});

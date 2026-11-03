// Specs for the WebKit sender hold (plan D7) — run with Node's built-in
// runner:
//   node --test --conditions=browser components/rtc/webkitSenderHold.test.ts
//
// One posture throughout: on a script-transform engine (iOS WebKit) a sender
// with no transform sends PLAINTEXT, so a local publication stays paused until
// the worker has said, for every sender, "transform attached", the local
// identity is enabled, and the worker has said "local key installed". Each
// spec below is a way that hold could release early:
//
//   transform   — resume before `slogaTransformAttached` for a sender.
//   simulcast   — a second (simulcastCodecs) sender with no ack. This is the
//                 SFU-quality-update case: a publication whose sender list
//                 GREW (an h264 backup sender) must go back to held.
//   enable      — resume before the worker's `enable` reply: the worker
//                 passes frames through unencrypted while not enabled.
//   key         — resume before `slogaSetKeyAck` for the CURRENT local key,
//                 including a stale ack for an earlier key at a reused index
//                 (livekit indexes are `epoch mod 16`).
//   ok:false    — a failed import is an ack, but not a yes.
//   timeout     — a key ack that never comes must resolve `false`, or the
//                 caller's "local key installed" claim hangs instead of
//                 failing loud.
//   chromium    — the hold must never touch a non-script-transform engine.
import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";

import {
  type SenderHoldInput,
  type WebkitHoldState,
  type WebkitHoldTrack,
  createWorkerAckTracker,
  isScriptTransformEngine,
  KEY_ACK_TIMEOUT_MS,
  parseSlogaWorkerAck,
  senderHoldVerdict,
  WEBKIT_HOLD_BOUND_MS,
  webkitHoldInputs,
  webkitHoldOverdue,
  webkitHoldReleased,
  webkitSenderTrackIds,
} from "./webkitSenderHold.ts";

/**
 * Every spec gets a hard timeout. A `waitKeyAck` that never settles is
 * exactly the defect the timeout specs exist to catch, and without this a
 * module with that defect HANGS the run instead of failing it.
 */
const test = (name: string, fn: () => void | Promise<void>) =>
  nodeTest(name, { timeout: 2_000 }, fn);

// --- fixtures -----------------------------------------------------------------

const setKeyAck = (identity: unknown, keyIndex: unknown, ok: unknown) => ({
  kind: "slogaSetKeyAck",
  data: { identity, keyIndex, ok },
});

const attachedAck = (trackId: unknown, kind: unknown) => ({
  kind: "slogaTransformAttached",
  data: { trackId, kind },
});

/**
 * Manual timers. Each fake REFUSES a `this` other than undefined/globalThis,
 * the way a browser's `setTimeout` throws "Illegal invocation" when it is
 * called as a method of the deps bag (`deps.setTimeout(...)`). Production
 * passes the globals straight in, so a module calling them bound would throw
 * on the device and pass here without this check.
 */
interface FakeTimers {
  deps: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  pending: Map<number, { fn: () => void; ms: number }>;
  cleared: number[];
  fireAll(): void;
}

function fakeTimers(): FakeTimers {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const cleared: number[] = [];
  const unbound = (self: unknown) => {
    if (self !== undefined && self !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
  };
  return {
    pending,
    cleared,
    deps: {
      setTimeout: function (this: unknown, fn: () => void, ms: number) {
        unbound(this);
        const handle = next++;
        pending.set(handle, { fn, ms });
        return handle;
      },
      clearTimeout: function (this: unknown, handle: unknown) {
        unbound(this);
        cleared.push(handle as number);
        pending.delete(handle as number);
      },
    },
    fireAll() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, timer] of due) timer.fn();
    },
  };
}

/** Lets any `.then` chained on an already-settled promise run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Settled state of a promise without awaiting it forever. */
async function state<T>(
  promise: Promise<T>,
): Promise<{ settled: false } | { settled: true; value: T }> {
  let out: { settled: false } | { settled: true; value: T } = {
    settled: false,
  };
  promise.then((value) => {
    out = { settled: true, value };
  });
  await flush();
  return out;
}

/** An iPhone publication with every term satisfied. */
const ready = (over: Partial<SenderHoldInput> = {}): SenderHoldInput => ({
  scriptTransformEngine: true,
  senderTrackIds: ["TR_cam"],
  attached: () => true,
  localIdentityEnabled: true,
  localKey: { identity: "jeff", keyIndex: 3 },
  keyAcked: () => true,
  ...over,
});

// --- isScriptTransformEngine --------------------------------------------------

test("only iOS is a script-transform engine", () => {
  assert.equal(isScriptTransformEngine("ios"), true);
  for (const platform of ["android", "web", "electron", "tauri", "", "IOS"]) {
    assert.equal(isScriptTransformEngine(platform), false, platform);
  }
});

// --- parseSlogaWorkerAck ------------------------------------------------------

test("a well-formed setKey ack parses", () => {
  assert.deepEqual(parseSlogaWorkerAck(setKeyAck("jeff", 3, true)), {
    kind: "setKeyAck",
    identity: "jeff",
    keyIndex: 3,
    ok: true,
  });
  assert.deepEqual(parseSlogaWorkerAck(setKeyAck("jeff", 0, false)), {
    kind: "setKeyAck",
    identity: "jeff",
    keyIndex: 0,
    ok: false,
  });
});

test("a well-formed transform ack parses, direction preserved", () => {
  assert.deepEqual(parseSlogaWorkerAck(attachedAck("TR_cam", "encode")), {
    kind: "transformAttached",
    trackId: "TR_cam",
    dir: "encode",
  });
  assert.deepEqual(parseSlogaWorkerAck(attachedAck("TR_cam", "decode")), {
    kind: "transformAttached",
    trackId: "TR_cam",
    dir: "decode",
  });
});

test("🔴 a setKey ack whose `ok` is not strictly boolean is not an ack", () => {
  // `"false"` and `1` are truthy: a loose read would turn a failed import or
  // a skewed worker into "local key installed".
  for (const ok of ["true", "false", 1, 0, null, undefined]) {
    assert.equal(parseSlogaWorkerAck(setKeyAck("jeff", 3, ok)), undefined);
  }
});

test("a setKey ack with a bad identity or index is not an ack", () => {
  for (const identity of ["", 7, null, undefined, {}]) {
    assert.equal(
      parseSlogaWorkerAck(setKeyAck(identity, 3, true)),
      undefined,
      String(identity),
    );
  }
  for (const keyIndex of [-1, 1.5, NaN, Infinity, "3", null, undefined]) {
    assert.equal(
      parseSlogaWorkerAck(setKeyAck("jeff", keyIndex, true)),
      undefined,
      String(keyIndex),
    );
  }
});

test("a transform ack with a bad trackId or direction is not an ack", () => {
  for (const trackId of ["", 5, null, undefined]) {
    assert.equal(
      parseSlogaWorkerAck(attachedAck(trackId, "encode")),
      undefined,
    );
  }
  for (const dir of ["both", "Encode", "", undefined, 1]) {
    assert.equal(parseSlogaWorkerAck(attachedAck("TR_cam", dir)), undefined);
  }
});

test("livekit's own messages and garbage are not acks", () => {
  const notAcks: unknown[] = [
    undefined,
    null,
    "slogaSetKeyAck",
    42,
    [],
    {},
    { kind: "slogaSetKeyAck" },
    { kind: "slogaSetKeyAck", data: null },
    { kind: "slogaSetKeyAck", data: [] },
    { kind: "slogaTransformAttached", data: "TR_cam" },
    // livekit's page<->worker kinds carry look-alike payloads.
    { kind: "setKey", data: { participantIdentity: "jeff", keyIndex: 3 } },
    { kind: "enable", data: { participantIdentity: "jeff", enabled: true } },
    { kind: "initAck", data: { enabled: true } },
    { kind: "slogaDecodeWitness", data: { participants: [] } },
    // right fields, flat instead of in the `{kind, data}` envelope.
    { kind: "slogaSetKeyAck", identity: "jeff", keyIndex: 3, ok: true },
  ];
  for (const data of notAcks) {
    assert.equal(parseSlogaWorkerAck(data), undefined, JSON.stringify(data));
  }
});

test("the parsed ack carries only its named fields", () => {
  // Nothing the worker adds rides along into page state — in particular not
  // anything key-shaped.
  const parsed = parseSlogaWorkerAck({
    kind: "slogaSetKeyAck",
    data: { identity: "jeff", keyIndex: 3, ok: true, key: new Uint8Array(16) },
  });
  assert.deepEqual(Object.keys(parsed ?? {}).sort(), [
    "identity",
    "keyIndex",
    "kind",
    "ok",
  ]);
});

// --- the tracker: transforms --------------------------------------------------

test("a sender is not attached until its ENCODE transform is acked", () => {
  const t = createWorkerAckTracker(fakeTimers().deps);
  assert.equal(t.attached("TR_cam"), false);
  t.onMessage(attachedAck("TR_cam", "encode"));
  assert.equal(t.attached("TR_cam"), true);
  assert.equal(t.attached("TR_mic"), false);
});

test("🔴 a DECODE transform ack does not attach a sender", () => {
  // The receive side of the same id says nothing about what this device
  // sends.
  const t = createWorkerAckTracker(fakeTimers().deps);
  t.onMessage(attachedAck("TR_cam", "decode"));
  assert.equal(t.attached("TR_cam"), false);
});

test("malformed transform acks are ignored, and never throw", () => {
  const t = createWorkerAckTracker(fakeTimers().deps);
  t.onMessage(attachedAck("TR_cam", "both"));
  t.onMessage(null);
  t.onMessage("slogaTransformAttached");
  t.onMessage({ kind: "slogaTransformAttached", trackId: "TR_cam" });
  assert.equal(t.attached("TR_cam"), false);
});

test("🔴 a republished sender with the same trackId is held until its OWN ack", () => {
  // livekit's transform trackId is the `mediaStreamID`, which a republish
  // keeps. The old sender's ack says nothing about the new sender: until the
  // worker acks the new transform, WebKit would send it in plaintext.
  const t = createWorkerAckTracker(fakeTimers().deps);
  t.onMessage(attachedAck("TR_cam", "encode"));
  const input = () =>
    ready({ senderTrackIds: ["TR_cam"], attached: t.attached });
  assert.deepEqual(senderHoldVerdict(input()), { release: true });

  t.forgetTrack("TR_cam");
  assert.equal(t.attached("TR_cam"), false);
  assert.deepEqual(senderHoldVerdict(input()), {
    release: false,
    reason: "transform_unacked",
  });
  // A decode ack for the id does not stand in for the new encode ack.
  t.onMessage(attachedAck("TR_cam", "decode"));
  assert.equal(t.attached("TR_cam"), false);

  t.onMessage(attachedAck("TR_cam", "encode"));
  assert.deepEqual(senderHoldVerdict(input()), { release: true });
});

test("forgetTrack touches only that track, and is a no-op for an unknown one", () => {
  const t = createWorkerAckTracker(fakeTimers().deps);
  t.onMessage(attachedAck("TR_cam", "encode"));
  t.onMessage(attachedAck("TR_mic", "encode"));
  t.onMessage(setKeyAck("jeff", 3, true));
  t.forgetTrack("TR_cam");
  t.forgetTrack("TR_never");
  t.forgetTrack("");
  assert.equal(t.attached("TR_cam"), false);
  assert.equal(t.attached("TR_mic"), true);
  assert.equal(t.keyAcked("jeff", 3), true);
});

// --- the tracker: keys --------------------------------------------------------

test("an ok:true ack marks the key acked, for that identity and index only", () => {
  const t = createWorkerAckTracker(fakeTimers().deps);
  assert.equal(t.keyAcked("jeff", 3), false);
  t.onMessage(setKeyAck("jeff", 3, true));
  assert.equal(t.keyAcked("jeff", 3), true);
  assert.equal(t.keyAcked("jeff", 4), false);
  assert.equal(t.keyAcked("velvetfly", 3), false);
});

test("🔴 an ok:false ack does not mark the key acked", () => {
  const t = createWorkerAckTracker(fakeTimers().deps);
  t.onMessage(setKeyAck("jeff", 3, false));
  assert.equal(t.keyAcked("jeff", 3), false);
});

test("🔴 a later ok:false withdraws an earlier ok:true", () => {
  // The latest word from the worker about that slot is the truth: the import
  // that replaced it failed.
  const t = createWorkerAckTracker(fakeTimers().deps);
  t.onMessage(setKeyAck("jeff", 3, true));
  t.onMessage(setKeyAck("jeff", 3, false));
  assert.equal(t.keyAcked("jeff", 3), false);
});

test("identity/index pairs do not collide through a separator", () => {
  const t = createWorkerAckTracker(fakeTimers().deps);
  t.onMessage(setKeyAck("jeff-1", 2, true));
  assert.equal(t.keyAcked("jeff", 12), false);
  assert.equal(t.keyAcked("jeff-1", 2), true);
});

// --- the tracker: waitKeyAck --------------------------------------------------

test("waitKeyAck resolves true on the ok ack and clears its timer", async () => {
  const timers = fakeTimers();
  const t = createWorkerAckTracker(timers.deps);
  const wait = t.waitKeyAck("jeff", 3);
  assert.deepEqual(await state(wait), { settled: false });
  t.onMessage(setKeyAck("jeff", 3, true));
  assert.equal(await wait, true);
  assert.equal(timers.pending.size, 0);
  assert.equal(timers.cleared.length, 1);
});

test("🔴 waitKeyAck resolves false on an ok:false ack", async () => {
  const timers = fakeTimers();
  const t = createWorkerAckTracker(timers.deps);
  const wait = t.waitKeyAck("jeff", 3);
  t.onMessage(setKeyAck("jeff", 3, false));
  assert.equal(await wait, false);
  assert.equal(timers.pending.size, 0);
});

test("🔴 waitKeyAck resolves false when no ack arrives in time", async () => {
  const timers = fakeTimers();
  const t = createWorkerAckTracker(timers.deps);
  const wait = t.waitKeyAck("jeff", 3);
  assert.equal(timers.pending.size, 1);
  assert.deepEqual(
    [...timers.pending.values()].map((p) => p.ms),
    [KEY_ACK_TIMEOUT_MS],
  );
  timers.fireAll();
  assert.equal(await wait, false);
  // A late ack after the timeout cannot un-fail the caller's claim.
  t.onMessage(setKeyAck("jeff", 3, true));
  assert.equal(await wait, false);
});

test("the default key-ack timeout is 5 s, and timeoutMs overrides it", () => {
  assert.equal(KEY_ACK_TIMEOUT_MS, 5_000);
  const timers = fakeTimers();
  const t = createWorkerAckTracker({ ...timers.deps, timeoutMs: 250 });
  void t.waitKeyAck("jeff", 3);
  assert.deepEqual(
    [...timers.pending.values()].map((p) => p.ms),
    [250],
  );
});

test("🔴 a timeout that could never fire is refused at construction", () => {
  // A wait that never times out turns a lost ack into a call that hangs in
  // "installing" instead of going loud.
  const timers = fakeTimers();
  for (const timeoutMs of [0, -1, NaN, Infinity, 2 ** 31]) {
    assert.throws(
      () => createWorkerAckTracker({ ...timers.deps, timeoutMs }),
      RangeError,
      String(timeoutMs),
    );
  }
});

test("an ack for another identity or index does not resolve the wait", async () => {
  const timers = fakeTimers();
  const t = createWorkerAckTracker(timers.deps);
  const wait = t.waitKeyAck("jeff", 3);
  t.onMessage(setKeyAck("jeff", 4, true));
  t.onMessage(setKeyAck("velvetfly", 3, true));
  t.onMessage(attachedAck("TR_cam", "encode"));
  assert.deepEqual(await state(wait), { settled: false });
  timers.fireAll();
  assert.equal(await wait, false);
});

test("🔴 a stale ack for an earlier key at a reused index does not satisfy a new wait", async () => {
  // livekit's key index is `epoch mod 16`, so epoch 19 reuses epoch 3's slot.
  // The ok:true from epoch 3 says nothing about epoch 19's key; releasing on
  // it would encrypt under a key this device should no longer hold.
  const timers = fakeTimers();
  const t = createWorkerAckTracker(timers.deps);
  t.onMessage(setKeyAck("jeff", 3, true));
  const wait = t.waitKeyAck("jeff", 3);
  assert.deepEqual(await state(wait), { settled: false });
  // While the new key is unconfirmed, the hold reads it as unacked too.
  assert.equal(t.keyAcked("jeff", 3), false);
  t.onMessage(setKeyAck("jeff", 3, true));
  assert.equal(await wait, true);
  assert.equal(t.keyAcked("jeff", 3), true);
});

test("concurrent waits on one key all resolve on its ack", async () => {
  const timers = fakeTimers();
  const t = createWorkerAckTracker(timers.deps);
  const a = t.waitKeyAck("jeff", 3);
  const b = t.waitKeyAck("jeff", 3);
  t.onMessage(setKeyAck("jeff", 3, true));
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(timers.pending.size, 0);
});

test("a wait for an identity/index no ack can carry resolves false at once", async () => {
  const timers = fakeTimers();
  const t = createWorkerAckTracker(timers.deps);
  assert.equal(await t.waitKeyAck("", 3), false);
  assert.equal(await t.waitKeyAck("jeff", -1), false);
  assert.equal(await t.waitKeyAck("jeff", 1.5), false);
  assert.equal(timers.pending.size, 0);
});

// --- the tracker: reset -------------------------------------------------------

test("🔴 reset resolves pending waits false and forgets every ack", async () => {
  const timers = fakeTimers();
  const t = createWorkerAckTracker(timers.deps);
  t.onMessage(attachedAck("TR_cam", "encode"));
  t.onMessage(setKeyAck("jeff", 2, true));
  const wait = t.waitKeyAck("jeff", 3);
  t.reset();
  assert.equal(await wait, false);
  assert.equal(timers.pending.size, 0);
  assert.equal(t.attached("TR_cam"), false);
  assert.equal(t.keyAcked("jeff", 2), false);
  // Still usable for the next worker.
  const next = t.waitKeyAck("jeff", 3);
  t.onMessage(setKeyAck("jeff", 3, true));
  assert.equal(await next, true);
});

// --- senderHoldVerdict --------------------------------------------------------

test("a fully confirmed iPhone publication releases", () => {
  assert.deepEqual(senderHoldVerdict(ready()), { release: true });
});

test("Chromium engines always release, whatever the acks say", () => {
  assert.deepEqual(
    senderHoldVerdict({
      scriptTransformEngine: false,
      senderTrackIds: [],
      attached: () => false,
      localIdentityEnabled: false,
      localKey: undefined,
      keyAcked: () => false,
    }),
    { release: true },
  );
});

test("🔴 a non-boolean engine flag holds rather than releasing", () => {
  // A wiring slip that passes `undefined` must not read as "not WebKit".
  const input = ready({
    scriptTransformEngine: undefined as unknown as boolean,
    attached: () => false,
  });
  assert.equal(senderHoldVerdict(input).release, false);
});

test("a publication with no senders yet is held", () => {
  assert.deepEqual(senderHoldVerdict(ready({ senderTrackIds: [] })), {
    release: false,
    reason: "no_senders",
  });
});

test("🔴 resume before the transform ack is refused", () => {
  assert.deepEqual(senderHoldVerdict(ready({ attached: () => false })), {
    release: false,
    reason: "transform_unacked",
  });
});

test("🔴 a second (simulcastCodecs) sender without an ack is refused", () => {
  const acked = new Set(["TR_cam"]);
  assert.deepEqual(
    senderHoldVerdict(
      ready({
        senderTrackIds: ["TR_cam", "TR_cam_h264"],
        attached: (id) => acked.has(id),
      }),
    ),
    { release: false, reason: "transform_unacked" },
  );
  // Order does not matter: the unacked one first, too.
  assert.deepEqual(
    senderHoldVerdict(
      ready({
        senderTrackIds: ["TR_cam_h264", "TR_cam"],
        attached: (id) => acked.has(id),
      }),
    ),
    { release: false, reason: "transform_unacked" },
  );
});

test("🔴 an SFU quality update that grows the sender list re-holds a released publication", () => {
  // Plan D7 gap 1: a SubscribedQualityUpdate requesting h264 makes livekit
  // create an additional-codec sender outside LocalSenderCreated. The patch
  // refuses it; this is the second wall — the hold never releases a
  // publication whose sender list grew without an ack for the new sender.
  const acked = new Set(["TR_cam"]);
  const before = ready({ attached: (id) => acked.has(id) });
  assert.deepEqual(senderHoldVerdict(before), { release: true });
  const grown = { ...before, senderTrackIds: ["TR_cam", "TR_cam_h264"] };
  assert.deepEqual(senderHoldVerdict(grown), {
    release: false,
    reason: "transform_unacked",
  });
  acked.add("TR_cam_h264");
  assert.deepEqual(senderHoldVerdict(grown), { release: true });
});

test("🔴 resume before the worker enabled the local identity is refused", () => {
  assert.deepEqual(senderHoldVerdict(ready({ localIdentityEnabled: false })), {
    release: false,
    reason: "not_enabled",
  });
  assert.deepEqual(
    senderHoldVerdict(
      ready({ localIdentityEnabled: "yes" as unknown as boolean }),
    ),
    { release: false, reason: "not_enabled" },
  );
});

test("🔴 resume before the local key ack is refused", () => {
  assert.deepEqual(senderHoldVerdict(ready({ keyAcked: () => false })), {
    release: false,
    reason: "key_unacked",
  });
  assert.deepEqual(senderHoldVerdict(ready({ localKey: undefined })), {
    release: false,
    reason: "key_unacked",
  });
});

test("the key check asks about the CURRENT local key", () => {
  const asked: Array<[string, number]> = [];
  const verdict = senderHoldVerdict(
    ready({
      localKey: { identity: "jeff", keyIndex: 7 },
      keyAcked: (identity, keyIndex) => {
        asked.push([identity, keyIndex]);
        return identity === "jeff" && keyIndex === 7;
      },
    }),
  );
  assert.deepEqual(verdict, { release: true });
  assert.deepEqual(asked, [["jeff", 7]]);
});

test("🔴 an ack predicate that throws holds rather than releasing", () => {
  const boom = () => {
    throw new Error("half-disposed room");
  };
  assert.deepEqual(senderHoldVerdict(ready({ attached: boom })), {
    release: false,
    reason: "transform_unacked",
  });
  assert.deepEqual(senderHoldVerdict(ready({ keyAcked: boom })), {
    release: false,
    reason: "key_unacked",
  });
});

// --- tracker + verdict, the way state.tsx wires them ---------------------------

test("🔴 the hold releases only once transform, enable and key acks all landed", async () => {
  const timers = fakeTimers();
  const t = createWorkerAckTracker(timers.deps);
  let enabled = false;
  const input = (): SenderHoldInput => ({
    scriptTransformEngine: true,
    senderTrackIds: ["TR_cam", "TR_cam_vp9"],
    attached: t.attached,
    localIdentityEnabled: enabled,
    localKey: { identity: "jeff", keyIndex: 3 },
    keyAcked: t.keyAcked,
  });

  assert.equal(senderHoldVerdict(input()).release, false);
  t.onMessage(attachedAck("TR_cam", "encode"));
  assert.deepEqual(senderHoldVerdict(input()), {
    release: false,
    reason: "transform_unacked",
  });
  t.onMessage(attachedAck("TR_cam_vp9", "encode"));
  assert.deepEqual(senderHoldVerdict(input()), {
    release: false,
    reason: "not_enabled",
  });
  enabled = true;
  const wait = t.waitKeyAck("jeff", 3);
  assert.deepEqual(senderHoldVerdict(input()), {
    release: false,
    reason: "key_unacked",
  });
  t.onMessage(setKeyAck("jeff", 3, false));
  assert.equal(await wait, false);
  assert.deepEqual(senderHoldVerdict(input()), {
    release: false,
    reason: "key_unacked",
  });
  t.onMessage(setKeyAck("jeff", 3, true));
  assert.deepEqual(senderHoldVerdict(input()), { release: true });
});

// --- webkitHoldInputs: the review's assembly (state.tsx `#reviewWebkitHold`) --

const track = (
  mediaStreamID: string,
  over: Partial<WebkitHoldTrack<string>> = {},
): WebkitHoldTrack<string> => ({
  ref: mediaStreamID,
  mediaStreamID,
  ended: false,
  codecSenders: [],
  ...over,
});

/** A connected iPhone with a mic and a camera listed and every term acked. */
const roomState = (
  over: Partial<WebkitHoldState<string>> = {},
): WebkitHoldState<string> => ({
  scriptTransformEngine: true,
  localIdentity: "jeff:dev1",
  publications: [track("TR_mic"), track("TR_cam")],
  born: [],
  providerKeys: [
    { participantIdentity: "velvetfly:dev9", keyIndex: 2 },
    { participantIdentity: "jeff:dev1", keyIndex: 3 },
  ],
  workerEnabled: new Map([["jeff:dev1", true]]),
  attached: () => true,
  keyAcked: () => true,
  ...over,
});

const verdicts = (state: WebkitHoldState<string>) =>
  webkitHoldInputs(state).inputs.map(senderHoldVerdict);

test("sender ids: the mediaStreamID, then one id per additional-codec sender", () => {
  assert.deepEqual(webkitSenderTrackIds(undefined), []);
  assert.deepEqual(webkitSenderTrackIds(track("TR_cam")), ["TR_cam"]);
  assert.deepEqual(
    webkitSenderTrackIds(track("TR_cam", { codecSenders: ["h264", "av1"] })),
    ["TR_cam", "TR_cam#codec:h264", "TR_cam#codec:av1"],
  );
});

test("one hold input per listed publication, then per born-unlisted sender", () => {
  const { inputs } = webkitHoldInputs(roomState({ born: [track("TR_share")] }));
  assert.deepEqual(
    inputs.map((i) => i.senderTrackIds),
    [["TR_mic"], ["TR_cam"], ["TR_share"]],
  );
  for (const input of inputs) {
    assert.equal(input.scriptTransformEngine, true);
    assert.equal(input.localIdentityEnabled, true);
    assert.deepEqual(input.localKey, { identity: "jeff:dev1", keyIndex: 3 });
  }
  assert.equal(webkitHoldReleased(inputs), true);
});

test("🔴 a born sender that is not listed yet is judged too", () => {
  // A sender that exists but has no publication yet can still send. A review
  // that only walked publications would release over it.
  const acked = new Set(["TR_mic", "TR_cam"]);
  const state = roomState({
    born: [track("TR_share")],
    attached: (id) => acked.has(id),
  });
  assert.equal(webkitHoldReleased(webkitHoldInputs(state).inputs), false);
  assert.deepEqual(verdicts(state)[2], {
    release: false,
    reason: "transform_unacked",
  });
});

test("🔴 an ENDED born sender is pruned (and reported for pruning)", () => {
  const ended = track("TR_old", { ended: true });
  const state = roomState({
    born: [ended, track("TR_share")],
    attached: (id) => id !== "TR_old",
  });
  const { inputs, endedBorn } = webkitHoldInputs(state);
  assert.deepEqual(endedBorn, ["TR_old"]);
  assert.deepEqual(
    inputs.map((i) => i.senderTrackIds),
    [["TR_mic"], ["TR_cam"], ["TR_share"]],
  );
  assert.equal(webkitHoldReleased(inputs), true);
});

test("🔴 an ended LISTED publication is still judged (only born is pruned)", () => {
  // Reproduces the inline review exactly: pruning applies to `born` only.
  const state = roomState({
    publications: [track("TR_mic", { ended: true })],
    attached: () => false,
  });
  const { inputs, endedBorn } = webkitHoldInputs(state);
  assert.deepEqual(endedBorn, []);
  assert.deepEqual(inputs.map(senderHoldVerdict), [
    { release: false, reason: "transform_unacked" },
  ]);
});

test("🔴 a publication with no track is held (no_senders), not skipped", () => {
  const state = roomState({ publications: [undefined, track("TR_cam")] });
  assert.deepEqual(verdicts(state)[0], {
    release: false,
    reason: "no_senders",
  });
  assert.equal(webkitHoldReleased(webkitHoldInputs(state).inputs), false);
});

test("🔴 an additional-codec sender is held even if an ack names its id", () => {
  // The id `TR_cam#codec:h264` is minted here; no worker transform exists
  // for such a sender (livekit makes it outside LocalSenderCreated). An ack
  // that happens to carry the string must not release it.
  const state = roomState({
    publications: [track("TR_cam", { codecSenders: ["h264"] })],
    attached: () => true,
  });
  assert.deepEqual(verdicts(state), [
    { release: false, reason: "transform_unacked" },
  ]);
  // Without the extra sender the same acks release.
  assert.deepEqual(verdicts(roomState({ publications: [track("TR_cam")] })), [
    { release: true },
  ]);
});

test("🔴 the local key is the LAST provider entry for the EXACT local identity", () => {
  const asked: Array<[string, number]> = [];
  const state = roomState({
    providerKeys: [
      { participantIdentity: "jeff:dev1", keyIndex: 2 },
      { participantIdentity: "jeff:dev1:screen", keyIndex: 9 },
      { participantIdentity: "jeff:dev1", keyIndex: 3 },
      { participantIdentity: "velvetfly:dev9", keyIndex: 4 },
    ],
    keyAcked: (identity, keyIndex) => {
      asked.push([identity, keyIndex]);
      return identity === "jeff:dev1" && keyIndex === 3;
    },
  });
  const { inputs } = webkitHoldInputs(state);
  assert.deepEqual(inputs[0].localKey, { identity: "jeff:dev1", keyIndex: 3 });
  assert.equal(webkitHoldReleased(inputs), true);
  assert.ok(asked.every(([id, ix]) => id === "jeff:dev1" && ix === 3));
});

test("🔴 no provider, or no local entry, means no local key: held", () => {
  for (const providerKeys of [
    undefined,
    [],
    [{ participantIdentity: "velvetfly:dev9", keyIndex: 3 }],
    [{ participantIdentity: "jeff:dev1:screen", keyIndex: 3 }],
  ]) {
    const state = roomState({ providerKeys });
    assert.equal(
      webkitHoldInputs(state).inputs[0].localKey,
      undefined,
      JSON.stringify(providerKeys),
    );
    assert.deepEqual(verdicts(state)[0], {
      release: false,
      reason: "key_unacked",
    });
  }
});

test("🔴 enabled is the worker's reply for the LOCAL identity, strictly true", () => {
  for (const workerEnabled of [
    new Map<string, boolean>(),
    new Map([["jeff:dev1", false]]),
    new Map([["velvetfly:dev9", true]]),
  ]) {
    assert.deepEqual(verdicts(roomState({ workerEnabled }))[0], {
      release: false,
      reason: "not_enabled",
    });
  }
});

test("the engine flag passes through, so Chromium inputs always release", () => {
  const state = roomState({
    scriptTransformEngine: false,
    attached: () => false,
    keyAcked: () => false,
    workerEnabled: new Map(),
  });
  assert.equal(webkitHoldReleased(webkitHoldInputs(state).inputs), true);
});

test("the release is ALL of the inputs, and an empty room releases", () => {
  const acked = new Set(["TR_mic"]);
  const state = roomState({ attached: (id) => acked.has(id) });
  assert.equal(webkitHoldReleased(webkitHoldInputs(state).inputs), false);
  acked.add("TR_cam");
  assert.equal(webkitHoldReleased(webkitHoldInputs(state).inputs), true);
  // Nothing listed and nothing born: nothing can send, so the review releases;
  // the NEXT sender re-asserts the hold at its birth.
  assert.equal(
    webkitHoldReleased(
      webkitHoldInputs(roomState({ publications: [], born: [] })).inputs,
    ),
    true,
  );
  assert.equal(webkitHoldReleased([]), true);
});

test("the review's input is the tracker's own predicates, unbound", () => {
  const timers = fakeTimers();
  const t = createWorkerAckTracker(timers.deps);
  const state = roomState({
    publications: [track("TR_cam")],
    attached: t.attached,
    keyAcked: t.keyAcked,
  });
  assert.equal(webkitHoldReleased(webkitHoldInputs(state).inputs), false);
  t.onMessage(attachedAck("TR_cam", "encode"));
  t.onMessage(setKeyAck("jeff:dev1", 3, true));
  assert.equal(webkitHoldReleased(webkitHoldInputs(state).inputs), true);
});

// --- webkitHoldOverdue: the hold's bound ---------------------------------------

test("the hold's bound is the key-ack timeout", () => {
  assert.equal(WEBKIT_HOLD_BOUND_MS, KEY_ACK_TIMEOUT_MS);
});

test("🔴 a hold held for the bound on a connected Room is overdue", () => {
  // Unbounded, a never-acked sender silences the iPhone for the rest of the
  // call behind a chip that can read green.
  const at = 10_000;
  assert.equal(
    webkitHoldOverdue({
      heldSinceMs: at,
      nowMs: at + WEBKIT_HOLD_BOUND_MS - 1,
      roomConnected: true,
    }),
    false,
  );
  assert.equal(
    webkitHoldOverdue({
      heldSinceMs: at,
      nowMs: at + WEBKIT_HOLD_BOUND_MS,
      roomConnected: true,
    }),
    true,
  );
  assert.equal(
    webkitHoldOverdue({
      heldSinceMs: at,
      nowMs: at + 60 * WEBKIT_HOLD_BOUND_MS,
      roomConnected: true,
    }),
    true,
  );
});

test("🔴 never overdue while the Room is not connected", () => {
  for (const roomConnected of [false, undefined as unknown as boolean]) {
    assert.equal(
      webkitHoldOverdue({
        heldSinceMs: 0,
        nowMs: 60 * WEBKIT_HOLD_BOUND_MS,
        roomConnected,
      }),
      false,
    );
  }
});

test("🔴 an unreadable clock on a connected Room is overdue, not exempt", () => {
  // NaN compares false with everything, so a naive `now - since >= bound`
  // would never fire: the unbounded hold back through a broken input.
  for (const [heldSinceMs, nowMs] of [
    [NaN, 10_000],
    [0, NaN],
    [Infinity, 10_000],
    [0, Infinity],
  ]) {
    assert.equal(
      webkitHoldOverdue({ heldSinceMs, nowMs, roomConnected: true }),
      true,
      `${heldSinceMs} ${nowMs}`,
    );
  }
});

test("a clock that reads before the hold began is not overdue", () => {
  assert.equal(
    webkitHoldOverdue({
      heldSinceMs: 10_000,
      nowMs: 9_000,
      roomConnected: true,
    }),
    false,
  );
});

// Session-level specs for the loud-latch heal (`MlsCallSession`), driven
// through the real join ladder with a fake bridge, installer and media
// binding under fake timers.
//   node --test --conditions=browser components/rtc/mlsCallSession.heal.test.ts
// Two behaviors the media-E2EE review asked to see proven at the session
// level rather than in the pure ledger spec:
//   - e2163ead (MED): the heal probe's install reference is taken BEFORE the
//     installer runs, so an InvalidKey landing between the installer's
//     per-entry awaits holds the latch (and the same rejoin WITHOUT that
//     error heals — the positive control, or the hold proves nothing);
//   - de4879c2 (H1): a joiner that heard a peer's frames before its Welcome
//     (MissingKey at epoch E) installs E+1 first with `previous: []`; that
//     install supersedes the missing key PER SENDER, so a later latch can
//     still heal once the peer left, or re-added with all-new tracks.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { type TestContext, test } from "node:test";

import type {
  E2EEBridge,
  EnvelopeDisposition,
  MlsCallCreated,
  MlsCallState,
  MlsEnvelope,
  MlsFrameKey,
  MlsFrameKeys,
  MlsHttpResult,
  MlsJoinIntentPayload,
  MlsMemberDevice,
  MlsProcessOutcome,
  MlsSessionSink,
  ResponseCreateMlsGroup,
} from "@revolt/client";

import type {
  KeyInstaller,
  MediaEncryptionState,
  MlsCallSession,
  MlsMediaBinding,
} from "./mlsCallSession.ts";

// The session imports its siblings without extensions (Vite resolves them);
// Node's ESM loader does not, so a bare relative specifier gets `.ts`
// appended before the default resolution runs. Type-only imports (the
// `@revolt/client` alias) are stripped and never reach the loader.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Not a `.ts` sibling — let the default resolution report it.
      }
    }
    return nextResolve(specifier, context);
  },
});

const { MlsCallSession: Session } = await import("./mlsCallSession.ts");

// ---- Fakes -----------------------------------------------------------------

const SELF: MlsMemberDevice = { user_id: "alice", device_id: "devA" };
const PEER: MlsMemberDevice = { user_id: "bob", device_id: "devB" };
const GROUP = "group-1";
/** The heal settle (`LOUD_HEAL_SETTLE_MS` = `RESECURE_ESCALATE_MS`). */
const HEAL_SETTLE_MS = 10_000;

const identityOf = (m: MlsMemberDevice) => `${m.user_id}:${m.device_id}`;
const SELF_ID = identityOf(SELF);
const PEER_ID = identityOf(PEER);

type BridgeStubs = { [K in keyof E2EEBridge]?: E2EEBridge[K] };

/** A bridge that throws on any method the ladder touches without a stub. */
function fakeBridge(stubs: BridgeStubs): E2EEBridge {
  return new Proxy({} as E2EEBridge, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      const stub = stubs[prop as keyof E2EEBridge];
      if (!stub) throw new Error(`bridge.${String(prop)} is not stubbed`);
      return stub;
    },
  });
}

interface EncryptionStateCall {
  state: MediaEncryptionState;
  error: unknown;
}

/**
 * The mutable call the session runs against: the MLS roster, the SFU set,
 * each participant's track SIDs, the group epoch, and the envelope outcomes
 * the fake `processEnvelope` answers with.
 */
class World {
  roster: MlsMemberDevice[] = [SELF, PEER];
  sfu: string[] = [SELF_ID, PEER_ID];
  sids = new Map<string, string[]>([[PEER_ID, ["TR_old"]]]);
  epoch = 0;
  /** The keys the previous install answered with (`previous` of the next). */
  #lastKeys: MlsFrameKey[] | null = null;
  sink: MlsSessionSink | null = null;
  outcomes = new Map<string, MlsProcessOutcome>();
  states: EncryptionStateCall[] = [];
  modes: string[] = [];
  bridgeCalls: string[] = [];
  /** Injected by the fake installer between its two awaits, once. */
  midInstallError: Error | null = null;
  /** The Room's `Connected` state as the binding reports it. */
  connected = true;
  session!: MlsCallSession;

  readonly role: "creator" | "joiner";
  readonly channelId: string;

  constructor(role: "creator" | "joiner", channelId: string) {
    this.role = role;
    this.channelId = channelId;
  }

  frameKeys(): MlsFrameKeys {
    const keys = this.roster.map((m) => ({
      livekit_identity: identityOf(m),
      user_id: m.user_id,
      device_id: m.device_id,
      key_index: this.epoch % 16,
      epoch: this.epoch,
      frame_key_b64: `key-${this.epoch}`,
    }));
    const previous = this.#lastKeys ?? [];
    this.#lastKeys = keys;
    return { group_id: GROUP, epoch: this.epoch, keys, previous };
  }

  callState(): MlsCallState {
    return {
      group_id: GROUP,
      channel_id: this.channelId,
      epoch: this.epoch,
      state: "active",
      members: this.roster.map((m) => ({ ...m, user_verified: true })),
    };
  }

  /** Hand the session one inbound envelope with a scripted native outcome. */
  #deliver(
    contentType: string,
    kind: MlsProcessOutcome["kind"],
    epoch: number,
    removed: MlsMemberDevice[],
  ): void {
    const envelope: MlsEnvelope = {
      id: `env-${kind}-${epoch}`,
      content_type: contentType,
      group_id: GROUP,
      epoch,
      ciphertext: "",
    };
    this.outcomes.set(envelope.id, {
      group_id: GROUP,
      kind,
      epoch,
      removed_self: false,
      removed,
    });
    this.epoch = epoch;
    assert.ok(this.sink, "the session registered no sink");
    this.sink({
      kind: "envelope",
      envelope,
      recipientDeviceId: SELF.device_id,
    });
  }

  /** The admitter's Welcome lands (the joiner's ladder resolves on it). */
  async welcome(epoch: number): Promise<void> {
    this.#deliver("mls_welcome", "welcome_joined", epoch, []);
    await flush();
  }

  /**
   * A commit for `epoch` lands and native fires keys-changed for it: the
   * drain records the inbound memo, then the rotation seam installs.
   */
  async commit(epoch: number, removed: MlsMemberDevice[] = []): Promise<void> {
    this.#deliver("mls_commit", "commit_applied", epoch, removed);
    await flush();
    await this.session.onLocalKeysChanged(GROUP, epoch);
    await flush();
  }

  clearsSince(index: number): EncryptionStateCall[] {
    return this.states.slice(index).filter((s) => s.state === "clear");
  }
}

/**
 * An installer that, like `MlsKeyProvider.#install`, posts entries and awaits
 * between them — and can raise an InvalidKey in that gap, exactly once.
 */
function fakeInstaller(world: World): KeyInstaller {
  const install = async () => {
    await Promise.resolve(); // first entry posted, awaiting importKey
    const error = world.midInstallError;
    if (error) {
      world.midInstallError = null;
      world.session.noteEncryptionError(error);
    }
    await Promise.resolve(); // second entry
  };
  return {
    applyKeys: install,
    applyRemoteKeys: install,
    applyLocalKey: install,
  };
}

function fakeMedia(world: World): MlsMediaBinding {
  return {
    installer: fakeInstaller(world),
    localIdentity: () => SELF_ID,
    sfuParticipants: () => [...world.sfu],
    participantTrackSids: (identity) => world.sids.get(identity) ?? [],
    sfuConnected: () => world.connected,
    onEncryptionState: (state, error) => world.states.push({ state, error }),
    onCallModeChanged: (mode) => world.modes.push(mode.kind),
    setEncryptionEnabled: async () => {},
  };
}

/** Every bridge method the join ladder + rotation seam + reconcile need. */
function bridgeFor(world: World): E2EEBridge {
  const record =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      world.bridgeCalls.push(name);
      return fn(...args);
    };
  const stubs: BridgeStubs = {
    registerMlsSink: record("registerMlsSink", (sink) => {
      world.sink = sink;
      return () => {
        world.sink = null;
      };
    }),
    // Above the low-water mark: nothing to publish, no MFA prompt.
    mlsReplenish: record("mlsReplenish", async () => null),
    callCreate: record(
      "callCreate",
      async (channelId, _userId): Promise<MlsCallCreated> => {
        const group_id = world.role === "creator" ? GROUP : "orphan-0";
        return {
          group_id,
          payload: {
            group_id,
            channel_id: channelId,
            device_id: SELF.device_id,
          },
        };
      },
    ),
    mlsCreateGroup: record(
      "mlsCreateGroup",
      async (): Promise<MlsHttpResult<ResponseCreateMlsGroup>> =>
        world.role === "creator"
          ? { kind: "ok", body: { result: "Created" } }
          : {
              kind: "conflict",
              body: {
                result: "Conflict",
                open_group_id: GROUP,
                channel_id: world.channelId,
              },
            },
    ),
    callLocalGroups: record("callLocalGroups", async () => []),
    callLeaveCleanup: record("callLeaveCleanup", async () => {}),
    callState: record("callState", async () => world.callState()),
    callFrameKeys: record("callFrameKeys", async () => world.frameKeys()),
    // Joiner pre-pin: no local group before the Welcome (the session
    // tolerates the throw and pins from the SFU set).
    callRosterIdentities: record("callRosterIdentities", async () => {
      throw new Error("mls_group_not_found");
    }),
    reconcileCallRoster: record("reconcileCallRoster", async () => []),
    callJoinIntent: record(
      "callJoinIntent",
      async (): Promise<MlsJoinIntentPayload> => ({
        device_id: SELF.device_id,
        key_package_ref: "kp-ref",
        signature: "sig",
      }),
    ),
    mlsJoinIntent: record(
      "mlsJoinIntent",
      async (): Promise<MlsHttpResult<void>> => ({
        kind: "ok",
        body: undefined,
      }),
    ),
    processEnvelope: record(
      "processEnvelope",
      async (envelope): Promise<EnvelopeDisposition> => {
        const outcome = world.outcomes.get(envelope.id);
        assert.ok(outcome, `no scripted outcome for envelope ${envelope.id}`);
        return { kind: "processed", outcome, ack: true };
      },
    ),
    ackEnvelopes: record("ackEnvelopes", () => {}),
  };
  return fakeBridge(stubs);
}

// ---- Clock + scheduling helpers ---------------------------------------------

/** Drain every settled promise chain (setImmediate is left real). */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Advance the fake clock in small steps, draining continuations between. */
async function advance(t: TestContext, ms: number): Promise<void> {
  const step = 250;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    t.mock.timers.tick(Math.min(step, ms - elapsed));
    await flush();
  }
}

/**
 * Fake timers do not move `performance.now()`, which stamps both the heal
 * probe's install reference and the error ledger. A counter that advances on
 * every read gives the two a strict order without depending on the real
 * clock's resolution.
 */
function fakePerformanceNow(t: TestContext): void {
  const original = performance.now;
  let clock = 0;
  Object.defineProperty(performance, "now", {
    value: () => ++clock,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    Object.defineProperty(performance, "now", {
      value: original,
      configurable: true,
      writable: true,
    });
  });
}

// ---- Scenario drivers --------------------------------------------------------

function newWorld(
  t: TestContext,
  role: "creator" | "joiner",
  channelId: string,
): World {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1_000_000,
  });
  fakePerformanceNow(t);
  const world = new World(role, channelId);
  world.session = new Session({
    bridge: bridgeFor(world),
    userId: SELF.user_id,
    deviceId: SELF.device_id,
    channelId,
  });
  world.session.bindMedia(fakeMedia(world));
  t.after(() => world.session.dispose());
  return world;
}

/** Creator: create → active → epoch 0 installed → enabled → `e2ee`. */
async function bringUpCreator(t: TestContext, world: World): Promise<void> {
  void world.session.start();
  await flush();
  await advance(t, 1); // the detached establish (group action) runs
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.callMode().kind, "e2ee");
}

/**
 * Joiner: create-race 409 → join intent → (optionally a pre-Welcome error)
 * → Welcome at `epoch` → first install at `epoch` with `previous: []` →
 * enabled → `e2ee`.
 */
async function bringUpJoiner(
  t: TestContext,
  world: World,
  epoch: number,
  beforeWelcome?: () => void,
): Promise<void> {
  void world.session.start();
  await flush();
  await advance(t, 1); // the establish runs up to the Welcome wait
  assert.equal(world.session.state(), "starting");
  assert.ok(world.bridgeCalls.includes("mlsJoinIntent"), "no intent broadcast");
  beforeWelcome?.();
  await world.welcome(epoch);
  assert.equal(world.session.state(), "active");
  await world.session.onLocalKeysChanged(GROUP, epoch);
  await flush();
  assert.equal(world.session.callMode().kind, "e2ee");
}

/** An InvalidKey outside every rotation window: the media latch goes loud. */
async function latchLoud(t: TestContext, world: World): Promise<Error> {
  await advance(t, 3_000); // past the immediate-install rotation settle (2 s)
  const before = world.states.length;
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.states.slice(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
  return error;
}

/** The peer leaves the SFU and the group: a Remove epoch installs. */
async function peerLeaves(world: World, epoch: number): Promise<void> {
  world.sfu = [SELF_ID];
  world.roster = [SELF];
  world.sids.delete(PEER_ID);
  await world.commit(epoch, [PEER]);
  await world.session.reconcileNow(); // the roster diff observes the removal
  await flush();
}

/** The peer re-adds with all-new tracks: an Add epoch installs. */
async function peerRejoins(
  world: World,
  epoch: number,
  sids: string[],
): Promise<void> {
  world.sfu = [SELF_ID, PEER_ID];
  world.roster = [SELF, PEER];
  world.sids.set(PEER_ID, sids);
  await world.commit(epoch);
  await world.session.reconcileNow(); // the roster diff observes the re-Add
  await flush();
}

/**
 * The reviewer's rejoin recipe: latch loud, watch the peer leave and re-add
 * under a new epoch with all-new track SIDs, optionally with an InvalidKey
 * raised BETWEEN the installer's awaits during the Add epoch's install, then
 * wait out the settle (+ the Add-grace and re-arm windows, generously).
 */
async function rejoinAfterLatch(
  t: TestContext,
  world: World,
  firstEpoch: number,
  midInstallError: boolean,
): Promise<{ latched: Error; clears: EncryptionStateCall[] }> {
  const latched = await latchLoud(t, world);
  const sinceLatch = world.states.length;
  await advance(t, 1_000);
  await peerLeaves(world, firstEpoch);
  await advance(t, 1_000);
  if (midInstallError) {
    world.midInstallError = new Error("InvalidKey: Decryption failed: y");
  }
  await peerRejoins(world, firstEpoch + 1, ["TR_new"]);
  assert.equal(world.midInstallError, null, "the mid-install error fired");
  await advance(t, HEAL_SETTLE_MS * 3);
  return { latched, clears: world.clearsSince(sinceLatch) };
}

// ---- Specs -----------------------------------------------------------------

test("creator: an InvalidKey between the installer's awaits holds the latch through the peer's rejoin", async (t) => {
  const world = newWorld(t, "creator", "ch-hold");
  await bringUpCreator(t, world);
  const { clears } = await rejoinAfterLatch(t, world, 1, true);
  assert.deepEqual(clears, []);
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("creator (positive control): the same rejoin without the mid-install error heals", async (t) => {
  const world = newWorld(t, "creator", "ch-heal");
  await bringUpCreator(t, world);
  const { latched, clears } = await rejoinAfterLatch(t, world, 1, false);
  assert.deepEqual(clears, [{ state: "clear", error: latched }]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("joiner (H1): a pre-Welcome missing key is superseded by the first install, so the latch heals once the peer left", async (t) => {
  const world = newWorld(t, "joiner", "ch-joiner-left");
  // The peer's frames at epoch 4 reach the worker before we hold any key;
  // the first install after the Welcome is epoch 5 with `previous: []`.
  await bringUpJoiner(t, world, 5, () => {
    const before = world.states.length;
    world.session.noteEncryptionError(
      new Error(
        `MissingKey: missing key at index 4 for participant ${PEER_ID}`,
      ),
    );
    assert.equal(world.states[before]?.state, "resecuring");
  });
  const latched = await latchLoud(t, world);
  const sinceLatch = world.states.length;
  await advance(t, 1_000);
  await peerLeaves(world, 6);
  await advance(t, HEAL_SETTLE_MS * 2);
  assert.deepEqual(world.clearsSince(sinceLatch), [
    { state: "clear", error: latched },
  ]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("joiner (H1): the superseded missing key does not hold a later rejoin heal while the peer is present", async (t) => {
  const world = newWorld(t, "joiner", "ch-joiner-rejoin");
  await bringUpJoiner(t, world, 5, () => {
    world.session.noteEncryptionError(
      new Error(
        `MissingKey: missing key at index 4 for participant ${PEER_ID}`,
      ),
    );
  });
  const { latched, clears } = await rejoinAfterLatch(t, world, 6, false);
  assert.deepEqual(clears, [{ state: "clear", error: latched }]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("creator: a reconnect spanning both probe firings holds, and the Room coming back re-arms the heal", async (t) => {
  const world = newWorld(t, "creator", "ch-reconnect");
  await bringUpCreator(t, world);
  const latched = await latchLoud(t, world);
  const sinceLatch = world.states.length;
  await advance(t, 1_000);
  await peerLeaves(world, 1); // the absent-peer heal is armed (10 s settle)
  // The Room drops into a reconnect before the settle fires and stays there
  // through the probe AND its one bounded retry: nothing may be judged while
  // every remote reads as absent.
  world.connected = false;
  await advance(t, HEAL_SETTLE_MS * 3);
  assert.deepEqual(world.clearsSince(sinceLatch), []);
  assert.equal(world.session.callMode().kind, "negotiating");
  // Back to Connected: without the re-arm the latch would stay red until
  // the next epoch (second re-review of the ledger).
  world.connected = true;
  world.session.noteSfuReconnected();
  await advance(t, HEAL_SETTLE_MS + 1_000);
  assert.deepEqual(world.clearsSince(sinceLatch), [
    { state: "clear", error: latched },
  ]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("creator: a PRESENT witness holds across a reconnect (its SIDs persist; the re-arm proves nothing about it)", async (t) => {
  const world = newWorld(t, "creator", "ch-reconnect-present");
  await bringUpCreator(t, world);
  await latchLoud(t, world);
  const sinceLatch = world.states.length;
  // A new epoch without the peer ever leaving (a third member's churn).
  await advance(t, 1_000);
  await world.commit(1);
  await world.session.reconcileNow();
  await flush();
  world.connected = false;
  await advance(t, HEAL_SETTLE_MS * 3);
  world.connected = true;
  world.session.noteSfuReconnected();
  await advance(t, HEAL_SETTLE_MS * 2);
  assert.deepEqual(world.clearsSince(sinceLatch), []);
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("creator: a witness re-added just before a reconnect heals only after a full settle once the Room is back", async (t) => {
  const world = newWorld(t, "creator", "ch-reconnect-readd");
  await bringUpCreator(t, world);
  const latched = await latchLoud(t, world);
  const sinceLatch = world.states.length;
  await advance(t, 1_000);
  await peerLeaves(world, 1);
  await advance(t, 1_000);
  await peerRejoins(world, 2, ["TR_new"]); // the settle is armed from here
  await advance(t, 2_000);
  world.connected = false; // the reconnect starts inside the settle
  await advance(t, HEAL_SETTLE_MS * 3);
  assert.deepEqual(world.clearsSince(sinceLatch), []);
  world.connected = true;
  world.session.noteSfuReconnected();
  await advance(t, HEAL_SETTLE_MS - 1_000);
  assert.deepEqual(world.clearsSince(sinceLatch), []); // not before the settle
  await advance(t, 2_000);
  assert.deepEqual(world.clearsSince(sinceLatch), [
    { state: "clear", error: latched },
  ]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

/** The peer loses its MLS leaf but stays in the SFU: what every member observes
 *  when someone rejoins and ANOTHER member serves the stale-leaf removal. */
async function peerLosesLeafStaysConnected(world: World): Promise<void> {
  world.roster = [SELF];
  await world.session.reconcileNow();
  await flush();
}

const MISSING_FROM_PEER = () =>
  new Error(`MissingKey: missing key at index 9 for participant ${PEER_ID}`);

test("🔴 leg 3a: a bystander's missing key while a membership change is in flight does NOT latch", async (t) => {
  const world = newWorld(t, "creator", "ch-joinrace");
  await bringUpCreator(t, world);
  await advance(t, 3_000); // past the install's rotation settle
  await peerLosesLeafStaysConnected(world);
  const before = world.states.length;
  // The peer that served the change installed first and the SFU carries its
  // new-index frames at once; our commit has not arrived, so the worker
  // raises MissingKey for an index we do not hold.
  world.session.noteEncryptionError(MISSING_FROM_PEER());
  await flush();
  const seen = world.states.slice(before).map((s) => s.state);
  assert.equal(seen.includes("loud"), false, JSON.stringify(seen));
  assert.equal(seen.includes("resecuring"), true, JSON.stringify(seen));
});

test("🔴 …and the same error with NO membership change in flight still latches at once", async (t) => {
  const world = newWorld(t, "creator", "ch-joinrace-control");
  await bringUpCreator(t, world);
  await advance(t, 3_000);
  const before = world.states.length;
  world.session.noteEncryptionError(MISSING_FROM_PEER());
  await flush();
  const seen = world.states.slice(before).map((s) => s.state);
  assert.equal(seen.includes("loud"), true, JSON.stringify(seen));
});

test("🔴 the bystander's re-securing is answered by the install, not left to escalate", async (t) => {
  const world = newWorld(t, "creator", "ch-joinrace-clear");
  await bringUpCreator(t, world);
  await advance(t, 3_000);
  await peerLosesLeafStaysConnected(world);
  world.session.noteEncryptionError(MISSING_FROM_PEER());
  await flush();
  // The commit arrives: the epoch installs, which fills the index the error
  // named. Without that clear the escalation would latch loud at 10 s.
  world.roster = [SELF, PEER];
  await world.commit(1);
  await world.session.reconcileNow();
  await flush();
  const before = world.states.length;
  await advance(t, HEAL_SETTLE_MS * 2);
  const seen = world.states.slice(before).map((s) => s.state);
  assert.equal(seen.includes("loud"), false, JSON.stringify(seen));
  assert.equal(world.session.callMode().kind, "e2ee");
});

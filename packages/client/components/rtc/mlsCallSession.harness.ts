// Test-only support for the session-level `MlsCallSession` specs
// (`mlsCallSession.heal.test.ts`, `mlsCallSession.joinrace.test.ts`). Nothing
// in the app imports this file.
//
// The world drives the REAL join ladder, rotation seam and reconcile against a
// fake bridge, installer and media binding under fake timers: a Proxy bridge
// that throws on any method a path touches without a stub, an installer that
// posts entries and awaits between them (and can raise in that gap), and a
// binding that records every media-plane state change.
//
// Its roster is N members, not two. The 2-party world could not express the
// failure the 2026-09-07 legs found: the member that SERVES a membership
// change commits and installs first, so it is structurally never behind — only
// a NON-SERVING bystander races, and with two members the rejoiner and the
// only remote are the same device, which collapses the two roles into one.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { TestContext } from "node:test";

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

// ---- The cast ---------------------------------------------------------------

export const SELF: MlsMemberDevice = { user_id: "alice", device_id: "devA" };
export const PEER: MlsMemberDevice = { user_id: "bob", device_id: "devB" };
/** The third member — the BYSTANDER seat, which only a 3+ party call has. */
export const THIRD: MlsMemberDevice = { user_id: "carol", device_id: "devC" };
export const GROUP = "group-1";
/** The heal settle (`LOUD_HEAL_SETTLE_MS` = `RESECURE_ESCALATE_MS`). */
export const HEAL_SETTLE_MS = 10_000;
/** The join-race hold's bound (`JOIN_RACE_DEFER_MS` = `MEMBERSHIP_OBSERVED_MS`). */
export const JOIN_RACE_DEFER_MS = 20_000;
/** `LEAVE_GRACE_MS` — after this the grace entry is DELETED and the Remove runs. */
export const LEAVE_GRACE_MS = 10_000;

export const identityOf = (m: MlsMemberDevice) => `${m.user_id}:${m.device_id}`;
export const SELF_ID = identityOf(SELF);
export const PEER_ID = identityOf(PEER);
export const THIRD_ID = identityOf(THIRD);

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

export interface EncryptionStateCall {
  state: MediaEncryptionState;
  error: unknown;
}

/**
 * The mutable call the session runs against: the MLS roster, the SFU set,
 * each participant's track SIDs, the group epoch, and the envelope outcomes
 * the fake `processEnvelope` answers with.
 */
export class World {
  roster: MlsMemberDevice[] = [SELF, PEER];
  sfu: string[] = [SELF_ID, PEER_ID];
  sids = new Map<string, string[]>([[PEER_ID, ["TR_old"]]]);
  epoch = 0;
  /** The keys the previous install answered with (`previous` of the next). */
  #lastKeys: MlsFrameKey[] | null = null;
  sink: MlsSessionSink | null = null;
  outcomes = new Map<string, MlsProcessOutcome>();
  states: EncryptionStateCall[] = [];
  /** Every `onMediaHold` edge, in order — the chip's amber while a hold is open. */
  holds: boolean[] = [];
  modes: string[] = [];
  bridgeCalls: string[] = [];
  /** Injected by the fake installer between its two awaits, once. */
  midInstallError: Error | null = null;
  /** The Room's `Connected` state as the binding reports it. */
  connected = true;
  /**
   * Whether the binding implements `onMediaHold` — the chip's amber. A
   * binding without it must never get a deferred verdict: the amber is the
   * only thing separating a deferral from an invisible green.
   */
  holdsSupported = true;
  session!: MlsCallSession;

  readonly role: "creator" | "joiner";
  readonly channelId: string;

  constructor(role: "creator" | "joiner", channelId: string) {
    this.role = role;
    this.channelId = channelId;
  }

  /** Seat a third member: the bystander role a 2-party world cannot express. */
  withThird(sids: string[] = ["TR_c_old"]): this {
    this.roster = [...this.roster, THIRD];
    this.sfu = [...this.sfu, THIRD_ID];
    this.sids.set(THIRD_ID, sids);
    return this;
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

  loudSince(index: number): EncryptionStateCall[] {
    return this.states.slice(index).filter((s) => s.state === "loud");
  }

  /** The key index a sender publishes at for `epoch` (`epoch mod 16`). */
  indexAt(epoch: number): number {
    return epoch % 16;
  }

  /** The worker's decode-path missing key: the one shape that names its pair. */
  missingKey(identity: string, epoch: number): Error {
    return new Error(
      `MissingKey: missing key at index ${this.indexAt(epoch)} for participant ${identity}`,
    );
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
    ...(world.holdsSupported
      ? { onMediaHold: (active: boolean) => world.holds.push(active) }
      : {}),
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
export async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Advance the fake clock in small steps, draining continuations between. */
export async function advance(t: TestContext, ms: number): Promise<void> {
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

export function newWorld(
  t: TestContext,
  role: "creator" | "joiner",
  channelId: string,
  seat?: (world: World) => void,
): World {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1_000_000,
  });
  fakePerformanceNow(t);
  const world = new World(role, channelId);
  seat?.(world); // seat extra members BEFORE the ladder reads the roster
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
export async function bringUpCreator(
  t: TestContext,
  world: World,
): Promise<void> {
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
export async function bringUpJoiner(
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
export async function latchLoud(t: TestContext, world: World): Promise<Error> {
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
export async function peerLeaves(world: World, epoch: number): Promise<void> {
  world.sfu = world.sfu.filter((id) => id !== PEER_ID);
  world.roster = world.roster.filter((m) => m !== PEER);
  world.sids.delete(PEER_ID);
  await world.commit(epoch, [PEER]);
  await world.session.reconcileNow(); // the roster diff observes the removal
  await flush();
}

/** The peer re-adds with all-new tracks: an Add epoch installs. */
export async function peerRejoins(
  world: World,
  epoch: number,
  sids: string[],
): Promise<void> {
  if (!world.sfu.includes(PEER_ID)) world.sfu = [...world.sfu, PEER_ID];
  if (!world.roster.includes(PEER)) world.roster = [...world.roster, PEER];
  world.sids.set(PEER_ID, sids);
  await world.commit(epoch);
  await world.session.reconcileNow(); // the roster diff observes the re-Add
  await flush();
}

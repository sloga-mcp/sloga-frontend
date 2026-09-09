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

import { chipStateFrom } from "./chipInputs.ts";
import {
  type LocalPublicationEncryption,
  ENCRYPTION_TYPE_GCM,
} from "./localPublicationEncryption.ts";
import {
  type ChipState,
  type DecodeWitness,
  DECODE_WITNESS_UNAVAILABLE,
  summarizeDecodeWitness,
} from "./mlsCallModePolicy.ts";
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
  /**
   * The media-plane state changes and the amber edges INTERLEAVED, in the
   * order the session emitted them. `state.tsx` writes `callEncryptionError`
   * and `callMediaHold` in separate, unbatched Solid setters, so the order
   * matters: between dropping the amber and reporting loud the chip has
   * neither and computes a green, which an effect or a live-leg sampler can
   * read even though no paint happens between them.
   */
  events: string[] = [];
  /** The same stream WITH payloads, for `chip()`. */
  journal: (
    | { kind: "state"; state: MediaEncryptionState; error: unknown }
    | { kind: "hold"; active: boolean }
  )[] = [];
  modes: string[] = [];
  bridgeCalls: string[] = [];
  /** Injected by the fake installer between its two awaits, once. */
  midInstallError: Error | null = null;
  /** The Room's `Connected` state as the binding reports it. */
  connected = true;
  /**
   * Local publications as the SFU has them on record — the LOCAL-DECLARATION
   * seam (`#assertLocalDeclarations`). Without it that whole path is vacuous,
   * so no spec could arm a `control` escalation, which is exactly how a
   * control-token defect reached a fourth review unnoticed.
   */
  localPublications: LocalPublicationEncryption[] = [];
  /** Track SIDs the session asked to be republished, in order. */
  republished: string[][] = [];
  /**
   * When set, the fake republish awaits this before flipping to GCM — the
   * window in which a `control` escalation is PENDING, which is where the
   * escalation's cancel token has to hold.
   */
  republishGate: Promise<void> | null = null;
  /** Open that window; the returned function closes it. */
  holdRepublish(): () => void {
    let release!: () => void;
    this.republishGate = new Promise<void>((r) => (release = r));
    return () => {
      this.republishGate = null;
      release();
    };
  }
  /** Declare one local publication to the SFU as NONE (the unmute shape). */
  declarePlaintext(trackSid = "TR_local"): void {
    this.localPublications = [{ trackSid, encryption: 0 }];
  }
  /**
   * Whether the binding implements `onMediaHold` — the chip's amber. A
   * binding without it must never get a deferred verdict: the amber is the
   * only thing separating a deferral from an invisible green.
   */
  holdsSupported = true;

  /**
   * Gate (d) — the senders whose frames the worker is currently DROPPING at an
   * index this device silenced. Empty by default: an ordinary healthy call has
   * nothing being discarded, and a spec that wants gate (d) to bite says so
   * with `dropFrames()`.
   *
   * The opposite default to `observedEncrypted`, which is modelled all-true
   * because it is the SFU's DECLARATION and structurally cannot witness this
   * class. The decode witness is a LOCAL measurement of frames that actually
   * arrived, so for a healthy call it genuinely holds.
   */
  #dropping: string[] = [];
  /** Whether the worker's heartbeat is arriving at all (fail-closed when not). */
  witnessAvailable = true;

  /** The worker is dropping these senders' frames at a silenced index. */
  dropFrames(...identities: string[]): void {
    for (const identity of identities) {
      // The witness is built from the SFU set, so naming somebody who is not
      // in it would silently model NO drops — a spec that reads green for the
      // wrong reason.
      assert.ok(
        this.sfu.includes(identity),
        `dropFrames(${identity}): not in the SFU set, so it owes no witness`,
      );
    }
    this.#dropping = identities;
  }

  /** The worker's heartbeat stopped — the patch is missing, or the worker died. */
  loseWitness(): void {
    this.witnessAvailable = false;
  }

  /**
   * Gate (d)'s input, built by handing a modelled worker window to the REAL
   * `summarizeDecodeWitness`.
   *
   * 🔴 It used to hand-build the `DecodeWitness` result instead, which meant
   * the reducer every one of these specs depends on was never exercised by
   * them — a second implementation of the thing under test, agreeing with
   * itself. Same shape as the chip assembly below.
   */
  decodeWitness(): DecodeWitness {
    if (!this.witnessAvailable) return DECODE_WITNESS_UNAVAILABLE;
    const remotes = this.sfu.filter((id) => id !== SELF_ID);
    return summarizeDecodeWitness(
      remotes.map((identity) => {
        const dropped = this.#dropping.includes(identity) ? 10 : 0;
        return { identity, indexes: [{ keyIndex: 1, seen: 10, dropped }] };
      }),
    );
  }

  /**
   * Roster members this device has NOT verified (gate c). Empty by default:
   * the ladders these specs drive are about the media plane, and an
   * unverified member is a separate axis. It exists so the axis is
   * EXPRESSIBLE — the harness used to hardcode every member verified, so no
   * spec could state a gate-(c) hold even if it wanted one.
   */
  unverified = new Set<string>();

  /** Mark roster members unverified for gate (c). */
  markUnverified(...identities: string[]): void {
    for (const identity of identities) this.unverified.add(identity);
  }

  /**
   * Participants LiveKit has reported no encryption status for (gate b).
   *
   * 🔴 Empty by default, and `observedEncryption` otherwise answers TRUE for
   * everyone, because that is the SFU's DECLARATION and a peer whose frames
   * this device cannot decrypt still reports encrypted — which is exactly why
   * gate (b) cannot see the media plane and gate (d) exists.
   *
   * It is an axis at all because routing the harness through the real
   * assembly was only half the fix: the assembly now includes SELF in
   * `publishingIdentities` as production does, but with every identity
   * hardcoded observed-true, "our own publication is not observed encrypted"
   * — the desktop 0.57.0 defect — was still inexpressible here.
   */
  unobserved = new Set<string>();

  /** LiveKit has vouched for nothing about these identities. */
  markUnobserved(...identities: string[]): void {
    for (const identity of identities) this.unobserved.add(identity);
  }
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

  /**
   * The chip the USER reads — `state.tsx`'s latch protocol replayed over the
   * media-plane callbacks, then the real `chipState`.
   *
   * Every other accessor here reports what the session SAID. Five of the six
   * defects six review rounds found lived in the gap between that and what the
   * chip shows, and none of them was visible to a spec asserting on the
   * callback stream: `state.tsx` latches `prev ?? error` and clears on object
   * IDENTITY, so a `loud` under an existing latch is a no-op and a following
   * `clear` of the superseded error wipes the signal outright.
   *
   * `observedEncryption` is modelled as ALL TRUE on purpose. It is the SFU's
   * declaration, not a decrypt: a peer whose frames this device cannot decrypt
   * still reports encrypted, which is exactly why gate (b) cannot see any of
   * this and why the media plane has to.
   *
   * 🔴 It goes through the REAL `chipStateFrom`. It used to hand-build the
   * `ChipInputs` literal, and that copy had drifted: it excluded SELF from
   * `publishingIdentities` entirely, where production includes the local
   * participant and excludes only our OWN screen leg — so no spec here could
   * express "our own publication is not observed encrypted", and every gate-(b)
   * assertion in these suites was evidence about a second implementation. The
   * whole point of the `chipInputs` extraction was that there be exactly one.
   */
  chip(): ChipState {
    let latchedError: unknown;
    let mediaHold = false;
    for (const entry of this.journal) {
      if (entry.kind === "hold") {
        mediaHold = entry.active;
      } else if (entry.state === "loud" && entry.error !== undefined) {
        latchedError = latchedError ?? entry.error;
      } else if (entry.state === "clear" && entry.error !== undefined) {
        if (latchedError === entry.error) latchedError = undefined;
      }
    }
    const mode = this.session.callMode();
    const sessionState = this.session.state();
    return chipStateFrom({
      hasSession: () => true,
      sessionState: () => sessionState,
      mode: () => mode,
      mediaHold: () => mediaHold,
      latchedError: () => latchedError !== undefined,
      rosterVerified: () =>
        this.roster.map((m) => !this.unverified.has(identityOf(m))),
      channelHasOpenGroup: () => true,
      capableAndEnabled: () => true,
      decodeWitness: () => this.decodeWitness(),
      observedEncryption: (identity) =>
        this.unobserved.has(identity) ? undefined : true,
      // Every SFU participant publishes one track, INCLUDING self. The
      // production assembly excludes only our own screen leg, and these
      // ladders have none.
      room: () => ({
        localIdentity: SELF_ID,
        participants: this.sfu.map((identity) => ({
          identity,
          publicationCount: 1,
        })),
        localPublications: [...this.localPublications],
      }),
    });
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
    localPublications: () => [...world.localPublications],
    republishLocalPublications: async (trackSids) => {
      world.republished.push([...trackSids]);
      if (world.republishGate) await world.republishGate;
      // The republish comes up GCM, as the real seam's does.
      world.localPublications = world.localPublications.map((p) =>
        trackSids.includes(p.trackSid)
          ? { ...p, encryption: ENCRYPTION_TYPE_GCM }
          : p,
      );
    },
    resumePublishing: async () => {},
    onEncryptionState: (state, error) => {
      world.states.push({ state, error });
      world.events.push(`state:${state}`);
      world.journal.push({ kind: "state", state, error });
    },
    ...(world.holdsSupported
      ? {
          onMediaHold: (active: boolean) => {
            world.holds.push(active);
            world.events.push(`hold:${active}`);
            world.journal.push({ kind: "hold", active });
          },
        }
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
    // The ghost-divergence timer fires 30 s after a member is seen in the MLS
    // roster but not in the SFU set, and stages a Remove. Specs that run past
    // that (a suspended hold outliving its bound) would otherwise die on an
    // unstubbed method. `mls_group_not_found` is the shape the session already
    // treats as a benign no-op — another member's Remove won the race — so the
    // ghost path runs to completion without deciding anything.
    callRemove: record("callRemove", async () => {
      throw Object.assign(new Error("mls_group_not_found"), {
        type: "mls_group_not_found",
      });
    }),
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
  // Tracks the FAKE timer clock (which mocks `Date`), plus a strictly
  // increasing sub-millisecond tiebreaker so two reads in one tick still
  // order — the ledger's install reference depends on that. Returning a bare
  // counter instead would make every elapsed-time measurement read as zero,
  // and the hold's banked budget is one.
  const base = Date.now();
  let tick = 0;
  Object.defineProperty(performance, "now", {
    value: () => Date.now() - base + ++tick * 1e-6,
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

// Session-level specs for the late-drain guard (`MlsCallSession`), on the
// shared world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.drainfail.test.ts
//
// The defect (L14c, 2026-09-26): a page that restarts wipes its group and
// re-intents, and its mailbox drains LATE. The stale Welcome sealed to the
// earlier intent is adopted at an old epoch, the session goes green on it,
// and the Remove behind it gap-refetches into the DS's 404, a rejection that
// escaped the drain: publishing at epoch 1 with the group at epoch 4, no
// latch, no error. Four groups here:
//   - A: a gap refetch that fails. A 404 is the DS saying this device is not
//     a member: re-secure now and rejoin fresh (A1). Anything else is a
//     FAILED refetch: the envelope stays unacked and is retried, counted
//     against the park bound, which escalates (A2, A3). On the rebase path the
//     submit's own catch still decides a transient failure (A4) and a 404
//     rejoins (A4b). A refetch that settles after its group was replaced acts
//     on nothing (A5).
//   - B: the drain's per-envelope backstop. One throwing step never stops the
//     batch and never escapes (B1); a step that keeps throwing ends loud at
//     the retry cap (B2); a throw after the envelope was acked cannot be
//     replayed, so it ends loud at once (B3).
//   - C: the Welcome currency check. An adopted Welcome goes active only on
//     the DS's word that it is current (C4), or once the commits since are
//     applied and native agrees (C1) — and never under a key a member those
//     commits removed still holds (C1r). Not current → discard and rejoin
//     (C1b, C2, C2b). A DS that does not answer → backoff, then LOUD, never a
//     rejoin (C3, C3b, C6). The check acts on nothing once its session or its
//     generation moved under it (C7, C7b, C8), and owns a re-securing while it
//     runs (C9). The creator path never asks (C5).
//   - R and E: the catch-up's own key install (fix pass 1). Native's
//     keys-changed push racing that install never turns it red (R1a–R1c,
//     LDA-M1); nothing is green while the install is pending (C1r+). The
//     check never goes green after a 404 its own catch-up met (E1), while OUR
//     send key is still an older epoch's (E2), on a session that already
//     failed (E3), or past a synthetic commit it could not apply (E4). A
//     dispose during the check's backoff lets the check finish (N1).
//   - D1: the L14c fleet scenario itself, with the mailbox the late drain
//     delivers captured and re-injected by the spec.
//
// "Never green at a stale epoch" is SAMPLED over the whole run, not read off
// the end state: a gate monitor records every moment the publish gate
// empties (the session releasing its last reason) and the state after every
// clock step, each with the native epoch and the epoch of the last frame
// keys fetched for an install.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type {
  MlsCommitInfo,
  MlsEnvelope,
  MlsMemberDevice,
  MlsProcessOutcome,
  MlsSinkEvent,
} from "@revolt/client";

import {
  E2EERateLimitError,
  E2EERequestTimeoutError,
} from "../client/e2eeRatelimitPolicy.ts";

import {
  type World,
  advance,
  bringUpCreator,
  bringUpJoiner,
  flush,
  GROUP,
  groupNotFound,
  identityOf,
  LEAVE_GRACE_MS,
  newFleet,
  newWorld,
  PEER,
  PEER_ID,
  SELF,
  SELF_ID,
  SUBMIT_TIMEOUT_MS,
  THIRD,
  THIRD_ID,
} from "./mlsCallSession.harness.ts";
import type { PublishGateReason } from "./mlsCallSession.ts";
import { WELCOME_CURRENCY_BACKOFF_MS } from "./mlsRefetchPolicy.ts";

// ---- The session's bounds, mirrored -----------------------------------------
//
// None of these is exported by `mlsCallSession.ts`, so each is copied here
// under its own name; a change there has to be made here too.

/** `WELCOME_CURRENCY_DEADLINE_MS` = `SUBMIT_TIMEOUT_MS` (LDP-M3). */
const CURRENCY_DEADLINE_MS = SUBMIT_TIMEOUT_MS;
/** `ENCRYPTION_UNCONFIRMED`: the curated latch error (LDP-n2). */
const ENCRYPTION_UNCONFIRMED = "This call's encryption could not be confirmed";
/** `MAX_PARK_ATTEMPTS`: gap refetches before the drain escalates. */
const MAX_PARK_ATTEMPTS = 8;
/** `MAX_ENVELOPE_RETRIES`: a throwing step's retries before it latches. */
const MAX_ENVELOPE_RETRIES = 5;
/** `RETRY_DELAY_MS`: the backoff before a retried envelope re-drains. */
const RETRY_DELAY_MS = 500;
/** `JOINER_RETRY_MS`: the join ladder's wait for a Welcome per intent. */
const JOINER_RETRY_MS = 10_000;
/** `ADD_GRACE_MS`: how long an Add-driven epoch defers our send key. */
const ADD_GRACE_MS = 2_000;
/** The harness's own `advance` step, used for sampling between ticks. */
const STEP_MS = 250;

// ---- What the DS and native answer ------------------------------------------

/** The exact path `mlsFetchCommits` requests (e2ee.ts `mlsFetchCommits`). */
function commitsPath(groupId: string, fromEpoch: number): string {
  return `/mls/groups/${groupId}/commits?from_epoch=${fromEpoch}`;
}

/**
 * What `#apiMls` throws for a status it maps to no outcome (every non-2xx on
 * this route but a 400 `FeatureDisabled`), byte-for-byte its final throw.
 */
function dsFailure(groupId: string, fromEpoch: number, status: number): Error {
  return new Error(
    `E2EE MLS GET ${commitsPath(groupId, fromEpoch)} failed: ${status}`,
  );
}

/** The transport's exhausted-retries 429 on the refetch. */
function rateLimited(groupId: string, fromEpoch: number): E2EERateLimitError {
  return new E2EERateLimitError(
    "GET",
    commitsPath(groupId, fromEpoch),
    30_000,
    3,
  );
}

/** The transport's 45 s per-request deadline on the refetch. */
function timedOut(groupId: string, fromEpoch: number): E2EERequestTimeoutError {
  return new E2EERequestTimeoutError(
    "GET",
    commitsPath(groupId, fromEpoch),
    45_000,
  );
}

/** Native's `MlsEpochGap`, as it crosses IPC (e2ee-core `Error`). */
function epochGap(expected: number, got: number): Error {
  return Object.assign(new Error("mls_epoch_gap"), {
    type: "mls_epoch_gap",
    group_id: GROUP,
    expected,
    got,
  });
}

/** One GROUP commit as the DS stores it. */
function commitAt(
  epoch: number,
  { removed = [] }: { removed?: MlsMemberDevice[] } = {},
): MlsCommitInfo {
  return {
    group_id: GROUP,
    epoch,
    committer: PEER,
    commit: `commit-${epoch}`,
    added: [],
    removed,
  };
}

/** The id `#synthEnvelope` gives a commit fed inline from a DS answer. */
function synthId(epoch: number): string {
  return `mls-synth:${GROUP}:${epoch}`;
}

/**
 * The one-seat world's native `processEnvelope`, scripted per envelope id
 * (`World.outcomes`), with what the harness's plain map cannot say:
 *   - `applies`: native APPLIES the commit when it processes it — GROUP's
 *     epoch moves, a removed member leaves its roster, and keys-changed for
 *     the epoch fires AFTER the call returns, as the fleet's native does
 *     (`keysChanged` in the harness);
 *   - `rejectOnce`: the IPC call itself rejects, the one way a drain step can
 *     throw without a bug in the session;
 *   - `onProcess`: a hook run as native takes the envelope.
 */
class ScriptedNative extends Map<string, MlsProcessOutcome> {
  readonly #world: World;
  readonly #rejections = new Map<string, number>();
  readonly #hooks = new Map<string, () => void>();

  constructor(world: World) {
    super();
    this.#world = world;
  }

  /**
   * Native applies the GROUP commit `envelopeId` at `epoch`, removing
   * `removed` (this device itself when `removedSelf`) from its roster.
   * `pushesKeys: false` leaves the epoch's keys-changed to the spec, which
   * delivers it at a moment it picks (`World.pushKeysChanged`).
   */
  applies(
    envelopeId: string,
    epoch: number,
    {
      removedSelf = false,
      removed = [],
      pushesKeys = true,
    }: {
      removedSelf?: boolean;
      removed?: MlsMemberDevice[];
      pushesKeys?: boolean;
    } = {},
  ): void {
    const world = this.#world;
    const gone = removedSelf ? [world.me, ...removed] : removed;
    this.set(envelopeId, {
      group_id: GROUP,
      kind: "commit_applied",
      epoch,
      removed_self: removedSelf,
      removed: gone,
    });
    this.#hooks.set(envelopeId, () => {
      world.epoch = epoch;
      const ids = gone.map(identityOf);
      world.roster = world.roster.filter((m) => !ids.includes(identityOf(m)));
      if (pushesKeys) {
        setImmediate(() => void world.session.onLocalKeysChanged(GROUP, epoch));
      }
    });
  }

  /** The next `times` processings of `envelopeId` reject (IPC failure). */
  rejectOnce(envelopeId: string, times = 1): void {
    this.#rejections.set(envelopeId, times);
  }

  /** Run `hook` when native takes `envelopeId` (after any `applies` hook). */
  onProcess(envelopeId: string, hook: () => void): void {
    const applied = this.#hooks.get(envelopeId);
    this.#hooks.set(envelopeId, () => {
      applied?.();
      hook();
    });
  }

  get(envelopeId: string): MlsProcessOutcome | undefined {
    const left = this.#rejections.get(envelopeId) ?? 0;
    if (left > 0) {
      this.#rejections.set(envelopeId, left - 1);
      throw new Error("e2ee_call_process: IPC call failed");
    }
    this.#hooks.get(envelopeId)?.();
    return super.get(envelopeId);
  }
}

/** Seat a `ScriptedNative` as the world's `processEnvelope` script. */
function scriptNative(world: World): ScriptedNative {
  const native = new ScriptedNative(world);
  world.outcomes = native;
  return native;
}

/** Hand the session one envelope, as the DS push does. */
function push(world: World, envelope: MlsEnvelope): void {
  assert.ok(world.sink, "the session registered no sink");
  world.sink({
    kind: "envelope",
    envelope,
    recipientDeviceId: world.me.device_id,
  });
}

/** A GROUP commit envelope at `epoch`, with its own id. */
function commitEnvelope(id: string, epoch: number): MlsEnvelope {
  return {
    id,
    content_type: "mls_commit",
    group_id: GROUP,
    epoch,
    ciphertext: `commit-${epoch}`,
  };
}

/** A GROUP Welcome envelope at `epoch`, with its own id. */
function welcomeEnvelope(id: string, epoch: number): MlsEnvelope {
  return {
    id,
    content_type: "mls_welcome",
    group_id: GROUP,
    epoch,
    ciphertext: `welcome-${epoch}`,
  };
}

// ---- Observation ------------------------------------------------------------

/** How many times the session called bridge method `name`. */
function calls(world: World, name: string): number {
  return world.bridgeCalls.filter((n) => n === name).length;
}

/** Every `loud` error the media-plane callback reported, in order. */
function louds(world: World): unknown[] {
  return world.journal.flatMap((entry) =>
    entry.kind === "state" && entry.state === "loud" ? [entry.error] : [],
  );
}

/** The session's console, captured (and kept off the runner's output). */
function consoleLog(t: TestContext): {
  errors: () => string[];
  warns: () => string[];
  infos: () => string[];
} {
  const spies = {
    error: t.mock.method(console, "error", () => {}),
    warn: t.mock.method(console, "warn", () => {}),
    info: t.mock.method(console, "info", () => {}),
  };
  const lines = (level: keyof typeof spies) => () =>
    spies[level].mock.calls.map((c) => String(c.arguments[0]));
  return {
    errors: lines("error"),
    warns: lines("warn"),
    infos: lines("info"),
  };
}

/** How many of `lines` start with `prefix`. */
function count(lines: string[], prefix: string): number {
  return lines.filter((line) => line.startsWith(prefix)).length;
}

/** One reading of what this device shows and sends. */
interface Reading {
  /** Fake-clock time of the reading. */
  at: number;
  /** Where it was taken: a clock step, or the gate emptying. */
  via: "sample" | "gate-empty";
  publishing: boolean;
  state: string;
  mode: string;
  chip: string;
  /** Native's epoch for the group (the seat's own row in a fleet). */
  epoch: number;
  /** The epoch of the last frame keys fetched for an install. */
  keyEpoch: number | null;
  /** The epoch the DS holds the group at, when the reading was taken. */
  current: number;
  /** The oldest key epoch no removed member holds (see `monitor`). */
  keyFloor: number;
}

/**
 * The publish gate with a tripwire: `resumePublishing` deletes a reason from
 * it, and the delete that EMPTIES it is the moment publishing flows.
 */
class WatchedGate extends Set<PublishGateReason> {
  onEmpty: (() => void) | null = null;

  delete(reason: PublishGateReason): boolean {
    const had = super.delete(reason);
    if (had && this.size === 0) this.onEmpty?.();
    return had;
  }
}

/**
 * Watch `world`'s gate from now on, against `current()` — the epoch the DS
 * holds the group at. A green (publishing, mode `e2ee`, or a green chip) is
 * STALE when native's epoch is not that epoch, or when the keys fetched for
 * the last install predate `keyFloor()`: the last epoch that REMOVED a
 * member, whose key the removed member does not hold. Keys older than the
 * current epoch but not older than that Remove are what the Add-grace
 * deliberately publishes on, so they are not stale. By default the floor is
 * the current epoch itself.
 */
function monitor(
  world: World,
  current: () => number,
  keyFloor: () => number = current,
): {
  readings: Reading[];
  sample: () => void;
  staleGreens: () => Reading[];
  opened: () => boolean;
} {
  const readings: Reading[] = [];
  const read = (via: Reading["via"]): Reading => ({
    at: Date.now(),
    via,
    publishing: world.publishing(),
    state: world.session.state(),
    mode: world.session.callMode().kind,
    chip: world.chip(),
    epoch: world.localEpoch,
    keyEpoch: world.native.lastKeys?.[0]?.epoch ?? null,
    current: current(),
    keyFloor: keyFloor(),
  });
  const gate = new WatchedGate(world.gate);
  gate.onEmpty = () => readings.push(read("gate-empty"));
  world.gate = gate;
  const green = (r: Reading) =>
    r.publishing ||
    r.mode === "e2ee" ||
    r.chip === "e2ee" ||
    r.chip === "e2ee_unverified";
  return {
    readings,
    sample: () => void readings.push(read("sample")),
    staleGreens: () =>
      readings.filter(
        (r) =>
          green(r) &&
          (r.epoch !== r.current ||
            r.keyEpoch === null ||
            r.keyEpoch < r.keyFloor),
      ),
    opened: () => readings.some((r) => r.via === "gate-empty"),
  };
}

/** Advance `ms` in harness steps, taking a reading after every one. */
async function sampled(
  t: TestContext,
  ms: number,
  watch: { sample: () => void },
): Promise<void> {
  watch.sample();
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
    await advance(t, Math.min(STEP_MS, ms - elapsed));
    watch.sample();
  }
}

/** A reading's fields that matter to "held", for a readable failure. */
function heldView(readings: Reading[]): string[] {
  return readings
    .filter((r) => r.publishing)
    .map((r) => `${r.via}@${r.at}: ${r.state}/${r.mode} epoch ${r.epoch}`);
}

// ---- Drivers ----------------------------------------------------------------

/** The joiner's `start()`, run up to its first intent (as `bringUpJoiner`). */
async function startJoiner(t: TestContext, world: World): Promise<void> {
  void world.session.start();
  await flush();
  await advance(t, 1);
  assert.equal(world.session.state(), "starting");
  assert.equal(calls(world, "mlsJoinIntent"), 1, "no intent broadcast");
}

/** Native's keys-changed for the adopted group, as `state.tsx` routes it. */
async function keysChanged(world: World, epoch: number): Promise<void> {
  await world.session.onLocalKeysChanged(GROUP, epoch);
  await flush();
}

/**
 * The drain's gap refetch: a GROUP commit at `got` that native parks as an
 * epoch gap from `world.epoch + 1`. Returns the envelope, unpushed.
 */
function gapEnvelope(world: World, id: string, got: number): MlsEnvelope {
  const envelope = commitEnvelope(id, got);
  world.rejections.set(id, epochGap(world.epoch + 1, got));
  return envelope;
}

// ---- A: a gap refetch that fails ---------------------------------------------

test("A1 — a gap refetch the DS answers 404 re-secures at once, holds the gate and rejoins fresh; the envelope is never acked", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-a1");
  const log = consoleLog(t);
  await bringUpJoiner(t, world, 1);
  assert.equal(world.publishing(), true, "the bring-up never published");
  const acks = calls(world, "ackEnvelopes");
  const intents = calls(world, "mlsJoinIntent");
  const fetches = calls(world, "mlsFetchCommits"); // the Welcome's check

  world.failGapRefetchOnce(dsFailure(GROUP, 2, 404));
  push(world, gapEnvelope(world, "env-gap-3", 3));
  await flush();

  // Taken, and answered in the same drain step: re-securing, the gate held.
  assert.equal(world.gapRefetchFailure, null, "the 404 was never delivered");
  assert.equal(calls(world, "mlsFetchCommits"), fetches + 1);
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.publishing(), false, "a 404 left the gate open");
  assert.equal(
    calls(world, "ackEnvelopes"),
    acks,
    "the gap envelope was acked",
  );
  assert.equal(
    count(log.warns(), "[mls] gap refetch: not a member of the call group"),
    1,
  );

  // The rejoin is scheduled, not run inline: it leave-cleans GROUP and
  // broadcasts a fresh intent. Held throughout.
  const watch = monitor(world, () => 4);
  await sampled(t, 2_000, watch);
  assert.deepEqual(world.leaveCleanups.slice(-2), [GROUP, "orphan-0"]);
  assert.equal(calls(world, "mlsJoinIntent"), intents + 1, "no fresh intent");
  assert.equal(world.session.state(), "resecuring");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
  assert.deepEqual(louds(world), [], "a 404 latched loud");

  // The fresh Welcome ends it green, at the DS's epoch.
  await world.welcome(4);
  assert.equal(world.session.state(), "active");
  await keysChanged(world, 4);
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.publishing(), true);
  assert.deepEqual(watch.staleGreens(), []);
  assert.equal(calls(world, "ackEnvelopes") > acks, true);
});

/**
 * A2/A3's shape: `failures` answer the gap refetch one after another; each
 * leaves the envelope unacked and re-drained after `RETRY_DELAY_MS`, and the
 * drain escalates to a fresh rejoin once the park bound is spent.
 */
async function refetchFailsUntilEscalation(
  t: TestContext,
  world: World,
  failures: ((fromEpoch: number) => void)[],
): Promise<void> {
  assert.equal(failures.length, MAX_PARK_ATTEMPTS);
  const acks = calls(world, "ackEnvelopes");
  const fetches = calls(world, "mlsFetchCommits");
  const intents = calls(world, "mlsJoinIntent");
  const envelope = gapEnvelope(world, "env-gap-4", 4);
  const from = world.epoch + 1;

  failures[0](from);
  push(world, envelope);
  await flush();
  for (let attempt = 1; attempt <= MAX_PARK_ATTEMPTS; attempt++) {
    assert.equal(
      calls(world, "mlsFetchCommits"),
      fetches + attempt,
      `refetch ${attempt} never ran`,
    );
    assert.equal(world.gapRefetchFailure, null, `failure ${attempt} not taken`);
    assert.equal(world.fetchCommitsAnswer, null, `answer ${attempt} not taken`);
    assert.equal(calls(world, "ackEnvelopes"), acks, "a failed refetch acked");
    assert.equal(world.session.state(), "active", "escalated early");
    if (attempt < MAX_PARK_ATTEMPTS) failures[attempt](from);
    await advance(t, RETRY_DELAY_MS);
  }
  // The ninth drain of the envelope finds the park bound spent: no ninth
  // refetch, a desync escalation, a scheduled fresh rejoin.
  await advance(t, 1);
  assert.equal(calls(world, "mlsFetchCommits"), fetches + MAX_PARK_ATTEMPTS);
  const mailbox = world.session.metrics().mailbox;
  assert.equal(mailbox.gapRefetches, MAX_PARK_ATTEMPTS);
  assert.equal(mailbox.desyncEscalations, 1);
  assert.equal(calls(world, "ackEnvelopes"), acks, "the envelope was acked");
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.publishing(), false, "the escalation left the gate open");
  assert.ok(world.leaveCleanups.includes(GROUP), "GROUP was never wiped");
  assert.equal(calls(world, "mlsJoinIntent"), intents + 1, "no fresh intent");
  assert.deepEqual(louds(world), []);
}

test("A2 — a gap refetch the DS answers 500 is a FAILED refetch: unacked, retried, counted, and the park bound escalates to a rejoin", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-a2");
  const log = consoleLog(t);
  await bringUpJoiner(t, world, 1);
  await refetchFailsUntilEscalation(
    t,
    world,
    Array.from(
      { length: MAX_PARK_ATTEMPTS },
      () => (from: number) =>
        world.failGapRefetchOnce(dsFailure(GROUP, from, 500)),
    ),
  );
  assert.equal(
    count(log.warns(), "[mls] gap refetch failed"),
    MAX_PARK_ATTEMPTS,
  );
  assert.equal(count(log.errors(), "[mls] drain step threw"), 0);
});

test("A3 — a timeout, an exhausted 429 and an `ok` that stops short of current_epoch are each a failed refetch, counted to the same escalation", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-a3");
  const log = consoleLog(t);
  await bringUpJoiner(t, world, 1);
  const short = (from: number) => {
    // LDP-m3: the DS lists nothing from `from`, yet says the group is at 4.
    world.fetchCommitsAnswer = {
      groupId: GROUP,
      fromEpoch: from,
      result: { kind: "ok", body: { commits: [], current_epoch: 4 } },
    };
  };
  await refetchFailsUntilEscalation(t, world, [
    (from) => world.failGapRefetchOnce(timedOut(GROUP, from)),
    (from) => world.failGapRefetchOnce(rateLimited(GROUP, from)),
    short,
    (from) => world.failGapRefetchOnce(timedOut(GROUP, from)),
    short,
    (from) => world.failGapRefetchOnce(rateLimited(GROUP, from)),
    (from) => world.failGapRefetchOnce(timedOut(GROUP, from)),
    short,
  ]);
  assert.equal(
    count(log.warns(), "[mls] gap refetch failed"),
    MAX_PARK_ATTEMPTS,
  );
});

/**
 * A creator at epoch 0 admits THIRD, and the DS answers the submit `Lost` to
 * PEER's epoch-1 commit: the `lost` arm rebases INLINE, under the submit's
 * lock, and its gap refetch from epoch 2 meets `failure`.
 */
async function rebaseRefetchFails(
  t: TestContext,
  world: World,
  failure: Error,
): Promise<{ creates: number; held: boolean }> {
  const native = scriptNative(world);
  await bringUpCreator(t, world);
  await advance(t, 3_000); // past the bring-up's rotation settle (2 s)
  const creates = calls(world, "callCreate");
  world.answerSubmitOnce({
    kind: "conflict",
    body: { result: "Lost", winning: commitAt(1) },
  });
  native.applies(synthId(1), 1);
  world.failGapRefetchOnce(failure);
  await world.joinRequest(THIRD);
  await advance(t, 1);
  assert.equal(world.submits(), 1, "the admit never submitted");
  assert.equal(world.submitAnswer, null, "the Lost was never delivered");
  assert.equal(world.gapRefetchFailure, null, "the refetch never failed");
  assert.equal(calls(world, "mlsFetchCommits"), 1);
  assert.equal(world.session.state(), "resecuring");
  const held = !world.publishing();
  // Whatever it scheduled runs as a group action (a 404's rejoin is deferred
  // one task first, `#resecureAndRejoin`).
  await advance(t, 1);
  await advance(t, 1);
  return { creates, held };
}

test("A4 — on the rebase path a transient refetch failure still ends in the submit's catch: re-securing and a re-establish, as before", async (t) => {
  const world = newWorld(t, "creator", "ch-drainfail-a4");
  const log = consoleLog(t);
  // Not asserted: the gate. The submit catch re-secures without dropping the
  // mode, so publishing continues until its re-establish runs one task later
  // — unchanged by the guard, like every `#scheduleReestablish` hand-off.
  const { creates } = await rebaseRefetchFails(
    t,
    world,
    dsFailure(GROUP, 2, 503),
  );
  assert.equal(
    count(log.errors(), "[mls] commit staging failed, re-securing"),
    1,
  );
  assert.equal(count(log.errors(), "[mls] drain step threw"), 0);
  assert.equal(world.session.state(), "active", "the re-establish never ran");
  assert.equal(calls(world, "callCreate"), creates + 1);
  assert.ok(world.leaveCleanups.includes(GROUP));
  assert.deepEqual(louds(world), []);
});

test("A4b — on the rebase path a 404 re-secures and schedules the fresh rejoin itself; the submit's catch never sees it", async (t) => {
  const world = newWorld(t, "creator", "ch-drainfail-a4b");
  const log = consoleLog(t);
  const { creates, held } = await rebaseRefetchFails(
    t,
    world,
    dsFailure(GROUP, 2, 404),
  );
  assert.equal(held, true, "the 404 left the gate open until the rejoin");
  assert.equal(
    count(log.warns(), "[mls] gap refetch: not a member of the call group"),
    1,
  );
  assert.equal(
    count(log.errors(), "[mls] commit staging failed, re-securing"),
    0,
  );
  // One rejoin, the one the 404 scheduled — nothing dropped a second.
  assert.equal(calls(world, "callCreate"), creates + 1);
  assert.equal(count(log.warns(), "[mls] group action dropped"), 0);
  assert.equal(world.session.state(), "active");
  assert.deepEqual(louds(world), []);
});

test("A5 — a gap refetch that settles after its group was replaced acts on nothing: the old group's envelope is not retried into the new one", async (t) => {
  const world = newWorld(t, "creator", "ch-drainfail-a5");
  const log = consoleLog(t);
  await bringUpCreator(t, world);
  await advance(t, 3_000);
  const creates = calls(world, "callCreate");

  // A Remove of this device, then a gap envelope held in its refetch.
  await world.removedSelf(1);
  const releaseRefetch = world.holdGapRefetch();
  push(world, gapEnvelope(world, "env-gap-3", 3));
  await flush();
  assert.equal(calls(world, "mlsFetchCommits"), 1, "the refetch never ran");

  // The removal runs as a group action and replaces GROUP; its leave-clean
  // is held, so the session has no group while the refetch settles.
  const releaseLeave = world.holdLeaveCleanup();
  await advance(t, 1);
  assert.equal(world.session.groupId(), null);
  world.failGapRefetchOnce(dsFailure(GROUP, 2, 500));
  releaseRefetch();
  await flush();
  assert.equal(world.gapRefetchFailure, null, "the failure was never taken");
  assert.equal(count(log.warns(), "[mls] gap refetch failed"), 0);

  releaseLeave();
  await flush();
  await advance(t, 1);
  assert.equal(calls(world, "callCreate"), creates + 1, "no re-establish");
  assert.equal(world.session.state(), "active");
  // A retried envelope would re-drain here, into the NEW group, and refetch
  // again (an unscripted fetch fails the spec).
  await advance(t, 5 * RETRY_DELAY_MS);
  assert.equal(calls(world, "mlsFetchCommits"), 1);
  assert.deepEqual(louds(world), []);
});

// ---- B: the drain's backstop ---------------------------------------------------

test("B1 — one throwing drain step neither stops its batch nor escapes: the rest applies now, the envelope re-drains after the backoff", async (t) => {
  const world = newWorld(t, "creator", "ch-drainfail-b1");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await bringUpCreator(t, world);
  await advance(t, 3_000);
  const acks = calls(world, "ackEnvelopes");
  const processed = calls(world, "processEnvelope");

  native.applies("env-b1-1", 1);
  native.applies("env-b1-2", 2);
  native.rejectOnce("env-b1-1");
  push(world, commitEnvelope("env-b1-1", 1));
  push(world, commitEnvelope("env-b1-2", 2));
  await flush();

  // Both were drained in the one batch; only the second acked.
  assert.equal(calls(world, "processEnvelope"), processed + 2);
  assert.equal(calls(world, "ackEnvelopes"), acks + 1);
  assert.equal(world.epoch, 2, "the batch stopped at the throw");
  assert.equal(count(log.errors(), "[mls] drain step threw"), 1);
  assert.equal(world.session.state(), "active");
  assert.deepEqual(louds(world), []);

  // The thrown one is retried after the backoff, and acked.
  await advance(t, RETRY_DELAY_MS);
  assert.equal(calls(world, "processEnvelope"), processed + 3);
  assert.equal(calls(world, "ackEnvelopes"), acks + 2);
  assert.deepEqual(louds(world), []);
});

test("B2 — a step that keeps throwing latches loud at the retry cap with the curated error, and is never acked", async (t) => {
  const world = newWorld(t, "creator", "ch-drainfail-b2");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await bringUpCreator(t, world);
  await advance(t, 3_000);
  const acks = calls(world, "ackEnvelopes");
  const processed = calls(world, "processEnvelope");

  native.applies("env-b2", 1);
  native.rejectOnce("env-b2", Number.POSITIVE_INFINITY);
  push(world, commitEnvelope("env-b2", 1));
  await flush();
  for (let attempt = 1; attempt < MAX_ENVELOPE_RETRIES; attempt++) {
    assert.deepEqual(louds(world), [], `loud after ${attempt} throws`);
    await advance(t, RETRY_DELAY_MS);
  }
  assert.equal(
    calls(world, "processEnvelope"),
    processed + MAX_ENVELOPE_RETRIES,
  );
  assert.equal(
    count(log.errors(), "[mls] drain step threw"),
    MAX_ENVELOPE_RETRIES,
  );
  const [loud] = louds(world);
  assert.ok(loud instanceof Error);
  assert.equal(loud.message, ENCRYPTION_UNCONFIRMED);
  assert.equal(world.terminalLoud(), true);
  assert.equal(world.publishing(), false, "a loud drain left the gate open");
  assert.equal(calls(world, "ackEnvelopes"), acks, "the envelope was acked");

  // Latched: no sixth attempt.
  await advance(t, 5 * RETRY_DELAY_MS);
  assert.equal(
    calls(world, "processEnvelope"),
    processed + MAX_ENVELOPE_RETRIES,
  );
});

test("B3 — a throw after the Welcome was acked and its pending record set latches loud at once, is never retried, and the check still runs once", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-b3");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 1);
  const acks = calls(world, "ackEnvelopes");

  // A Welcome whose outcome native reports malformed: `#onEpochAdvanced`
  // adopts it (the pending record is set) and then throws on `removed`.
  native.set("env-b3-welcome", {
    group_id: GROUP,
    kind: "welcome_joined",
    epoch: 1,
    removed_self: false,
    removed: [null] as unknown as MlsMemberDevice[],
  });
  world.epoch = 1;
  push(world, welcomeEnvelope("env-b3-welcome", 1));
  await flush();

  assert.equal(calls(world, "ackEnvelopes"), acks + 1, "the Welcome was acked");
  assert.equal(count(log.errors(), "[mls] drain step threw"), 1);
  const [loud] = louds(world);
  assert.ok(loud instanceof Error, "the post-ack throw did not latch");
  assert.equal(loud.message, ENCRYPTION_UNCONFIRMED);
  assert.equal(world.terminalLoud(), true);
  assert.equal(calls(world, "mlsFetchCommits"), 1, "the check did not run");

  await keysChanged(world, 1);
  await sampled(t, 3 * RETRY_DELAY_MS, watch);
  assert.equal(calls(world, "processEnvelope"), 1, "the Welcome was retried");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));

  // The record was cleared: a later envelope runs no second check (an
  // unscripted fetch fails the spec).
  native.applies("env-b3-commit", 2);
  push(world, commitEnvelope("env-b3-commit", 2));
  await flush();
  assert.equal(calls(world, "mlsFetchCommits"), 1);
});

// ---- C: the Welcome currency check --------------------------------------------

test("C1 — a stale Welcome the DS answers with the commits since: held through the check, the commits apply, and it goes green only at the DS's epoch", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c1");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  // No commit since the Welcome removed anyone: the Welcome's own key is not
  // one a removed member holds (the floor), native's epoch must be 4.
  const watch = monitor(
    world,
    () => 4,
    () => 1,
  );
  for (const epoch of [2, 3, 4]) native.applies(synthId(epoch), epoch);
  world.fetchCommitsAnswer = {
    groupId: GROUP,
    fromEpoch: 2,
    result: {
      kind: "ok",
      body: {
        commits: [commitAt(2), commitAt(3), commitAt(4)],
        current_epoch: 4,
      },
    },
  };
  const release = world.holdGapRefetch();

  // Adopted at epoch 1; native fires keys-changed for it. Nothing is green.
  await world.welcome(1);
  assert.equal(calls(world, "mlsFetchCommits"), 1, "no currency check");
  await keysChanged(world, 1);
  await sampled(t, 2_000, watch);
  assert.notEqual(world.session.state(), "active");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));

  release();
  await flush();
  await sampled(t, 2_000, watch);
  assert.equal(world.fetchCommitsAnswer, null, "the answer was never taken");
  assert.equal(world.epoch, 4);
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.publishing(), true);
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 1);
  assert.deepEqual(watch.staleGreens(), []);
  assert.ok(watch.opened(), "the gate never opened");
  assert.equal(
    world.native.lastKeys?.[0]?.epoch,
    4,
    "the keys never caught up",
  );
  assert.deepEqual(louds(world), []);
});

test("C1r — a catch-up whose commits REMOVE a member never opens the gate under a key the removed member holds", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c1r", (w) => {
    w.withThird();
  });
  const native = scriptNative(world);
  consoleLog(t);
  await startJoiner(t, world);
  // THIRD is removed at epoch 3: from then on, a key older than epoch 3 is
  // one THIRD holds (locked decision 3).
  const watch = monitor(
    world,
    () => 4,
    () => 3,
  );
  native.applies(synthId(2), 2);
  native.applies(synthId(3), 3, { removed: [THIRD] });
  native.applies(synthId(4), 4);
  world.fetchCommitsAnswer = {
    groupId: GROUP,
    fromEpoch: 2,
    result: {
      kind: "ok",
      body: {
        commits: [commitAt(2), commitAt(3, { removed: [THIRD] }), commitAt(4)],
        current_epoch: 4,
      },
    },
  };
  const release = world.holdGapRefetch();
  await world.welcome(1);
  await keysChanged(world, 1);
  // THIRD left the call, which is why it was removed: no mix to pause for.
  world.sfu = world.sfu.filter((id) => id !== THIRD_ID);
  world.sids.delete(THIRD_ID);

  release();
  await flush();
  await sampled(t, 3_000, watch);
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(
    world.native.lastKeys?.[0]?.epoch,
    4,
    "the keys never caught up",
  );
  assert.ok(watch.opened(), "the gate never opened");
  assert.deepEqual(watch.staleGreens(), []);
});

test("C1b — a catch-up that does not land natively is not current: discarded, rejoined, never green", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c1b");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 3);
  const intents = calls(world, "mlsJoinIntent");
  // Native processes the DS's two commits, but its epoch never reaches 3:
  // the second is a duplicate of what it already holds.
  native.applies(synthId(2), 2);
  native.set(synthId(3), {
    group_id: GROUP,
    kind: "duplicate",
    epoch: 2,
    removed_self: false,
    removed: [],
  });
  world.fetchCommitsAnswer = {
    groupId: GROUP,
    fromEpoch: 2,
    result: {
      kind: "ok",
      body: { commits: [commitAt(2), commitAt(3)], current_epoch: 3 },
    },
  };

  await world.welcome(1);
  await keysChanged(world, 1);
  assert.equal(world.fetchCommitsAnswer, null, "the answer was never taken");
  assert.equal(world.session.state(), "resecuring");
  assert.equal(
    count(log.warns(), "[mls] welcome currency: rejoining fresh"),
    1,
  );
  await sampled(t, 2_000, watch);
  assert.ok(world.leaveCleanups.includes(GROUP), "the adoption was kept");
  assert.equal(calls(world, "mlsJoinIntent"), intents + 1, "no fresh intent");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
  assert.deepEqual(louds(world), []);
});

/**
 * C2/C2b's shape: the check's answer is not "current" and not a catch-up,
 * so the adoption is discarded and a fresh rejoin runs; never green before
 * the fresh Welcome, which then confirms current at `freshEpoch`.
 */
async function currencyRejoins(
  t: TestContext,
  world: World,
  answer: () => void,
): Promise<void> {
  const log = consoleLog(t);
  await startJoiner(t, world);
  // The DS's group is at 3: where the rejoin's own Welcome seats this device.
  const watch = monitor(world, () => 3);
  const intents = calls(world, "mlsJoinIntent");
  answer();

  await world.welcome(1);
  await keysChanged(world, 1);
  assert.equal(calls(world, "mlsFetchCommits"), 1, "no currency check");
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(
    count(log.warns(), "[mls] welcome currency: rejoining fresh"),
    1,
  );
  await sampled(t, 2_000, watch);
  assert.ok(world.leaveCleanups.includes(GROUP), "the adoption was kept");
  assert.equal(calls(world, "mlsJoinIntent"), intents + 1, "no fresh intent");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
  assert.notEqual(world.session.state(), "plaintext");
  assert.deepEqual(louds(world), []);

  // The rejoin's own Welcome, at the DS's epoch, confirms current.
  await world.welcome(3);
  assert.equal(world.session.state(), "active");
  await keysChanged(world, 3);
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(calls(world, "mlsFetchCommits"), 2);
  assert.ok(watch.opened(), "the gate never opened");
  assert.deepEqual(watch.staleGreens(), []);
}

test("C2 — a stale Welcome the DS answers 404 is discarded: never green, a scheduled fresh rejoin", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c2");
  await currencyRejoins(t, world, () =>
    world.failGapRefetchOnce(dsFailure(GROUP, 2, 404)),
  );
});

test("C2b — `feature_disabled` on the currency check rejoins fresh; it never drops the call to plaintext", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c2b");
  await currencyRejoins(t, world, () => {
    world.fetchCommitsAnswer = {
      groupId: GROUP,
      fromEpoch: 2,
      result: { kind: "feature_disabled" },
    };
  });
  assert.equal(world.modes.includes("off"), false);
});

test("C3 — a currency check that fails transiently backs off 1 s, then 2 s, held throughout, and goes green once the DS answers", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c3");
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 1);
  const intents = calls(world, "mlsJoinIntent");
  assert.deepEqual([...WELCOME_CURRENCY_BACKOFF_MS], [1_000, 2_000, 4_000]);

  world.failGapRefetchOnce(dsFailure(GROUP, 2, 500));
  await world.welcome(1);
  await keysChanged(world, 1);
  assert.equal(calls(world, "mlsFetchCommits"), 1);
  world.failGapRefetchOnce(timedOut(GROUP, 2));

  await sampled(t, 750, watch);
  assert.equal(calls(world, "mlsFetchCommits"), 1, "retried before 1 s");
  await sampled(t, 250, watch);
  assert.equal(calls(world, "mlsFetchCommits"), 2, "no retry at 1 s");
  assert.equal(world.gapRefetchFailure, null);
  await sampled(t, 1_750, watch);
  assert.equal(calls(world, "mlsFetchCommits"), 2, "retried before 2 s more");
  assert.notEqual(world.session.state(), "active");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
  await sampled(t, 250, watch);
  assert.equal(calls(world, "mlsFetchCommits"), 3, "no retry at 3 s");

  // The third attempt took the default answer: current.
  assert.equal(world.session.state(), "active");
  await flush();
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.publishing(), true);
  assert.equal(count(log.warns(), "[mls] welcome currency check failed"), 2);
  assert.equal(calls(world, "mlsJoinIntent"), intents, "a transient rejoined");
  assert.deepEqual(watch.staleGreens(), []);
  assert.deepEqual(louds(world), []);
});

test("C3b — a currency check the DS keeps rate-limiting ends LOUD after four fetches (1 + 2 + 4 s), with the curated error, and never rejoins", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c3b");
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 1);
  const intents = calls(world, "mlsJoinIntent");
  const leaves = world.leaveCleanups.length;

  world.failGapRefetchOnce(rateLimited(GROUP, 2));
  await world.welcome(1);
  await keysChanged(world, 1);
  for (const [attempt, wait] of WELCOME_CURRENCY_BACKOFF_MS.entries()) {
    assert.equal(calls(world, "mlsFetchCommits"), attempt + 1);
    assert.equal(world.gapRefetchFailure, null, `429 ${attempt + 1} not taken`);
    assert.deepEqual(louds(world), [], `loud after ${attempt + 1} fetches`);
    world.failGapRefetchOnce(rateLimited(GROUP, 2));
    await sampled(t, wait, watch);
  }
  assert.equal(calls(world, "mlsFetchCommits"), 4);
  assert.equal(world.gapRefetchFailure, null, "the fourth 429 was not taken");
  const [loud] = louds(world);
  assert.ok(loud instanceof Error, "exhausted retries did not latch");
  assert.equal(loud.message, ENCRYPTION_UNCONFIRMED);
  assert.equal(loud.message.includes(GROUP), false);
  assert.equal(world.terminalLoud(), true);
  assert.equal(count(log.errors(), "[mls] welcome currency not confirmed"), 1);

  // Never a rejoin: no wipe, no fresh intent — and no fifth fetch.
  await sampled(t, 20_000, watch);
  assert.equal(world.leaveCleanups.length, leaves, "a transient rejoined");
  assert.equal(calls(world, "mlsJoinIntent"), intents, "a transient rejoined");
  assert.equal(calls(world, "mlsFetchCommits"), 4);
  assert.notEqual(world.session.state(), "active");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
});

test("C4 — a current Welcome goes green after exactly one GET, of the epoch after it, and a later commit asks nothing", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c4");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => world.epoch);

  const release = world.holdGapRefetch();
  await world.welcome(3);
  await keysChanged(world, 3);
  assert.equal(calls(world, "mlsFetchCommits"), 1);
  await sampled(t, 1_000, watch);
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
  assert.notEqual(world.session.state(), "active");

  // The harness's default answers ONLY GROUP from epoch 4; anything else
  // fails the spec.
  release();
  await flush();
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.publishing(), true);
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 1);

  native.applies("env-c4-commit", 4);
  push(world, commitEnvelope("env-c4-commit", 4));
  await flush();
  await sampled(t, 2_000, watch);
  assert.equal(calls(world, "mlsFetchCommits"), 1);
  assert.deepEqual(watch.staleGreens(), []);
});

test("C5 — the creator path asks the DS nothing and reaches green in the same step as before", async (t) => {
  const world = newWorld(t, "creator", "ch-drainfail-c5");
  const native = scriptNative(world);
  await bringUpCreator(t, world); // active and `e2ee` within one advance
  // The same calls, in the same order, as before the check existed.
  assert.deepEqual(
    [...world.bridgeCalls],
    [
      "registerMlsSink",
      "mlsReplenish",
      "callCreate",
      "mlsCreateGroup",
      "callLocalGroups",
      "callState",
      "callFrameKeys",
      "callState",
    ],
  );
  native.applies("env-c5-commit", 1);
  push(world, commitEnvelope("env-c5-commit", 1));
  await flush();
  await advance(t, 30_000);
  assert.equal(calls(world, "mlsFetchCommits"), 0);
  assert.equal(world.session.callMode().kind, "e2ee");
});

// ---- The check's own bounds ---------------------------------------------------

test("C6 — a currency check the DS never answers ends LOUD at its 10 s deadline with the curated error; the late answer changes nothing", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c6");
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 1);
  const release = world.holdGapRefetch();

  await world.welcome(1);
  await keysChanged(world, 1);
  await sampled(t, CURRENCY_DEADLINE_MS - STEP_MS, watch);
  assert.deepEqual(louds(world), [], "loud before the deadline");
  await sampled(t, STEP_MS, watch);
  const [loud] = louds(world);
  assert.ok(loud instanceof Error, "the deadline did not latch");
  assert.equal(loud.message, ENCRYPTION_UNCONFIRMED);
  assert.equal(loud.message.includes(GROUP), false);
  assert.equal(world.terminalLoud(), true);
  assert.equal(count(log.errors(), "[mls] welcome currency not confirmed"), 1);

  // The DS answers "current" at last: the check already gave up.
  release();
  await flush();
  await sampled(t, 5_000, watch);
  assert.equal(calls(world, "mlsFetchCommits"), 1);
  assert.notEqual(world.session.state(), "active");
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 0);
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
  assert.equal(louds(world).length, 1);
});

test("C7 — dispose while the currency fetch is in flight: the answer lands on a closed session and does nothing", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c7");
  const log = consoleLog(t);
  await startJoiner(t, world);
  const release = world.holdGapRefetch();
  await world.welcome(1);
  await keysChanged(world, 1);
  const states = world.states.length;

  world.session.dispose();
  // Past the teardown's own leave-clean, the closed session calls nothing.
  const bridge = world.bridgeCalls.length;
  release();
  await flush();
  await advance(t, 2 * CURRENCY_DEADLINE_MS);
  assert.equal(world.session.state(), "closed");
  assert.deepEqual(world.bridgeCalls.slice(bridge), []);
  assert.deepEqual(world.states.slice(states), []);
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 0);
  assert.equal(count(log.warns(), "[mls] welcome currency"), 0);
  assert.equal(count(log.errors(), "[mls] welcome currency"), 0);
  assert.equal(calls(world, "mlsFetchCommits"), 1);
  assert.equal(world.publishing(), false);
});

test("C7b — dispose during the currency check's backoff: no retry, no verdict", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c7b");
  const log = consoleLog(t);
  await startJoiner(t, world);
  world.failGapRefetchOnce(dsFailure(GROUP, 2, 502));
  await world.welcome(1);
  await advance(t, 500);
  assert.equal(calls(world, "mlsFetchCommits"), 1);
  const states = world.states.length;

  world.session.dispose();
  const bridge = world.bridgeCalls.length;
  await advance(t, 2 * CURRENCY_DEADLINE_MS);
  assert.equal(world.session.state(), "closed");
  assert.equal(calls(world, "mlsFetchCommits"), 1, "retried after dispose");
  assert.deepEqual(world.bridgeCalls.slice(bridge), []);
  assert.deepEqual(world.states.slice(states), []);
  assert.equal(count(log.errors(), "[mls] welcome currency not confirmed"), 0);
});

test("C8 — a check whose establish generation was superseded under it acts on nothing; the new generation's Welcome decides", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c8");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 4);
  const intents = calls(world, "mlsJoinIntent");

  // The DS lists two commits since the Welcome: the first removes this
  // device. Native applies it (evicted: out of its own roster), and the
  // drain's removed-self arm schedules `#onRemovedSelf`; the second commit
  // is held in native, so that group action runs while the check is still
  // in flight — and rejoins, which is a new establish generation.
  native.applies(synthId(2), 2, { removedSelf: true });
  const second: { release?: () => void } = {};
  native.onProcess(synthId(2), () => {
    second.release = world.holdProcessEnvelope();
  });
  world.rejections.set(synthId(3), groupNotFound(GROUP));
  world.fetchCommitsAnswer = {
    groupId: GROUP,
    fromEpoch: 2,
    result: {
      kind: "ok",
      body: {
        commits: [commitAt(2, { removed: [SELF] }), commitAt(3)],
        current_epoch: 3,
      },
    },
  };
  await world.welcome(1);
  await keysChanged(world, 1);
  const release = second.release;
  assert.ok(release, "the second commit was never held");
  await sampled(t, 1_000, watch);
  assert.ok(world.leaveCleanups.includes(GROUP), "the removal never ran");
  assert.equal(calls(world, "mlsJoinIntent"), intents + 1, "no new generation");

  release();
  await flush();
  await sampled(t, 1_000, watch);
  // The old generation's check stopped: no verdict of its own.
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 0);
  assert.equal(count(log.warns(), "[mls] welcome currency"), 0);
  assert.equal(count(log.errors(), "[mls] welcome currency"), 0);
  assert.equal(world.session.state(), "resecuring");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));

  // The new generation's Welcome confirms current, and goes green.
  world.roster = [SELF, PEER];
  await world.welcome(4);
  assert.equal(world.session.state(), "active");
  await keysChanged(world, 4);
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.deepEqual(watch.staleGreens(), []);
  assert.deepEqual(louds(world), []);
});

test("C9 — a currency check in flight OWNS a re-securing: the backstop waits for it, and its answer ends green", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c9");
  const log = consoleLog(t);
  await bringUpJoiner(t, world, 1);

  // A 404 re-secures (arming the 10 s backstop) and rejoins; the rejoin's
  // Welcome lands 5 s later, and its check is held.
  world.failGapRefetchOnce(dsFailure(GROUP, 2, 404));
  push(world, gapEnvelope(world, "env-gap-3", 3));
  await flush();
  assert.equal(world.session.state(), "resecuring");
  await advance(t, 5_000);
  const watch = monitor(world, () => 4);
  const release = world.holdGapRefetch();
  await world.welcome(4);
  await keysChanged(world, 4);

  // Past the backstop's bound (10 s from the re-secure), short of the
  // check's own deadline (10 s from the Welcome): only the check owns it.
  await sampled(t, 7_000, watch);
  assert.equal(count(log.errors(), "[mls] re-securing backstop fired"), 0);
  assert.deepEqual(louds(world), [], "the backstop fired on a check in flight");
  assert.equal(world.session.state(), "resecuring");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));

  release();
  await flush();
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.publishing(), true);
  assert.deepEqual(watch.staleGreens(), []);
  assert.deepEqual(louds(world), []);
});

// ---- R and E: the catch-up's own install -------------------------------------

/**
 * C1's stale Welcome, not yet delivered: the DS lists commits 2, 3 and 4
 * since it and holds the group at 4, and native applies each. Only
 * `removeAt`'s commit removes anyone (THIRD); commit 4 is an Add otherwise.
 * `specPushes4`: native's keys-changed(4) is the spec's to deliver, once.
 */
function scriptCatchUp(
  world: World,
  native: ScriptedNative,
  {
    removeAt,
    specPushes4 = false,
  }: { removeAt?: number; specPushes4?: boolean } = {},
): void {
  const commits: MlsCommitInfo[] = [];
  for (const epoch of [2, 3, 4]) {
    const removed = epoch === removeAt ? [THIRD] : [];
    const pushesKeys = !(specPushes4 && epoch === 4);
    native.applies(synthId(epoch), epoch, { removed, pushesKeys });
    commits.push(commitAt(epoch, { removed }));
  }
  world.fetchCommitsAnswer = {
    groupId: GROUP,
    fromEpoch: 2,
    result: { kind: "ok", body: { commits, current_epoch: 4 } },
  };
}

/**
 * The Welcome at 1, adopted with its currency fetch held, and native's
 * keys-changed for it: epoch 1's send key is the one installed. Returns the
 * fetch's release.
 */
async function adoptHeld(world: World): Promise<() => void> {
  const release = world.holdGapRefetch();
  await world.welcome(1);
  await keysChanged(world, 1);
  assert.equal(calls(world, "mlsFetchCommits"), 1, "no currency check");
  assert.notEqual(world.session.state(), "active");
  return release;
}

/**
 * LDA-M1's moment: native's keys-changed(4), delivered as the check reads
 * native state right after its catch-up applied commit 4, while the memo that
 * commit left still says "an Add at 4". The push classifies as Add-grace:
 * remote keys now, OUR send key deferred behind a grace timer. `before` runs
 * first, in the same moment.
 */
function pushAtStateRead(
  world: World,
  before: () => void = () => {},
): { fired: () => boolean } {
  let fired = false;
  const arm = (): void =>
    world.beforeNextCall("callState", () => {
      if (world.epoch !== 4) return arm();
      fired = true;
      before();
      void world.pushKeysChanged(4);
    });
  arm();
  return { fired: () => fired };
}

/** The key installs entered since `from`, as `method@epoch`. */
function installsSince(world: World, from: number): string[] {
  return world.keyInstalls
    .slice(from)
    .map(({ method, epoch }) => `${method}@${epoch}`);
}

/**
 * R1's verdict: green at 4 under epoch 4's keys, never loud, and still so
 * once any Add-grace the push scheduled has fired.
 */
async function assertRaceGreen(
  t: TestContext,
  world: World,
  log: ReturnType<typeof consoleLog>,
  watch: ReturnType<typeof monitor>,
): Promise<void> {
  const latched = louds(world).map((e) => (e instanceof Error ? e.message : e));
  assert.deepEqual(latched, [], "the race latched loud");
  assert.equal(count(log.errors(), "[mls] welcome currency not confirmed"), 0);
  assert.equal(world.session.state(), "active", "the race held it non-active");
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.publishing(), true);
  assert.equal(world.native.lastKeys?.[0]?.epoch, 4);
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 1);
  await sampled(t, ADD_GRACE_MS + 1_000, watch);
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.deepEqual(louds(world), []);
  assert.ok(watch.opened(), "the gate never opened");
  assert.deepEqual(watch.staleGreens(), []);
}

test("R1a — LDA-M1: native's keys-changed(4) lands after the catch-up's last commit (an Add) and before the check's install: green at 4, never loud", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-r1a");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 4);
  scriptCatchUp(world, native, { specPushes4: true });
  const release = await adoptHeld(world);
  const installs = world.keyInstalls.length;
  const push = pushAtStateRead(world);

  release();
  await flush();
  assert.equal(push.fired(), true, "the push never landed at the state read");
  // The race is live: the push took the Add-grace path (remote keys only),
  // the check's own install the immediate one, both at 4.
  const entered = installsSince(world, installs);
  assert.ok(entered.includes("applyRemoteKeys@4"), entered.join(", "));
  assert.ok(entered.includes("applyKeys@4"), entered.join(", "));
  await assertRaceGreen(t, world, log, watch);
  // The push's grace did fire, after the verdict: the red it once caused.
  assert.ok(installsSince(world, installs).includes("applyLocalKey@4"));
});

test("R1b — LDA-M1 with both installs held: the push's Add-grace is scheduled only after the check's install ran; released, green at 4, never loud", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-r1b");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 4);
  scriptCatchUp(world, native, { specPushes4: true });
  const release = await adoptHeld(world);
  const installs = world.keyInstalls.length;
  const push = pushAtStateRead(world);
  const releaseInstall = world.holdKeyInstall();

  release();
  await flush();
  assert.equal(push.fired(), true, "the push never landed at the state read");
  // Both are pending: the push's remote-only install and the check's own.
  const entered = installsSince(world, installs);
  assert.ok(entered.includes("applyRemoteKeys@4"), entered.join(", "));
  assert.ok(entered.includes("applyKeys@4"), entered.join(", "));
  assert.notEqual(
    world.session.state(),
    "active",
    "active on a pending install",
  );
  assert.equal(
    world.publishing(),
    false,
    "the gate opened on a pending install",
  );

  releaseInstall();
  await flush();
  await assertRaceGreen(t, world, log, watch);
  assert.ok(installsSince(world, installs).includes("applyLocalKey@4"));
});

test("R1c — a keys-changed(4) pushed while the check's install is held (after its memo clear) installs at 4 too; released, green at 4, never loud", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-r1c");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 4);
  scriptCatchUp(world, native, { specPushes4: true });
  const release = await adoptHeld(world);
  const releaseInstall = world.holdKeyInstall();
  release();
  await flush();
  assert.ok(installsSince(world, 0).includes("applyKeys@4"), "never held");

  const installs = world.keyInstalls.length;
  const pushed = world.pushKeysChanged(4);
  await flush();
  assert.deepEqual(installsSince(world, installs), ["applyKeys@4"]);
  assert.notEqual(
    world.session.state(),
    "active",
    "active on a pending install",
  );
  assert.equal(
    world.publishing(),
    false,
    "the gate opened on a pending install",
  );

  releaseInstall();
  await pushed;
  await flush();
  await assertRaceGreen(t, world, log, watch);
});

test("C1r+ — while the catch-up's own key install is pending the session is not active and the gate stays held; it goes green once the install lands (LDA-m1)", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-c1r-held", (w) => {
    w.withThird();
  });
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  // As C1r: THIRD is removed at 3, so a key older than 3 is one it holds.
  const watch = monitor(
    world,
    () => 4,
    () => 3,
  );
  scriptCatchUp(world, native, { removeAt: 3 });
  const release = await adoptHeld(world);
  world.sfu = world.sfu.filter((id) => id !== THIRD_ID);
  world.sids.delete(THIRD_ID);
  const installs = world.keyInstalls.length;
  const releaseInstall = world.holdKeyInstall();

  release();
  await flush();
  // Every commit applied, native agreed, and the check's install at 4 is
  // PENDING: the send key installed is still epoch 1's, which THIRD holds.
  assert.equal(world.epoch, 4, "the catch-up did not apply");
  const entered = installsSince(world, installs);
  assert.equal(entered[0], "applyKeys@4", entered.join(", "));
  await sampled(t, 2_000, watch);
  assert.notEqual(world.session.state(), "active", "active before the install");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 0);
  assert.deepEqual(louds(world), []);

  releaseInstall();
  await flush();
  await sampled(t, 1_000, watch);
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.publishing(), true);
  assert.equal(world.native.lastKeys?.[0]?.epoch, 4);
  assert.ok(watch.opened(), "the gate never opened");
  assert.deepEqual(watch.staleGreens(), []);
  assert.deepEqual(louds(world), []);
});

/**
 * E1/E4's catch-up: native takes commit 2 as a duplicate (its epoch stays
 * 1), so it parks commit 3 as a gap from 2 and the drain refetches from 2
 * INSIDE the check; `refetch` scripts that nested refetch's answer as native
 * takes commit 2 (after the check's own fetch was answered). Native then
 * applies commit 4 whatever happened, so native alone would call the
 * catch-up landed: only the nested refetch's handling decides.
 */
function scriptNestedRefetch(
  world: World,
  native: ScriptedNative,
  refetch: () => void,
): void {
  native.set(synthId(2), {
    group_id: GROUP,
    kind: "duplicate",
    epoch: 1,
    removed_self: false,
    removed: [],
  });
  native.onProcess(synthId(2), refetch);
  world.rejections.set(synthId(3), epochGap(2, 3));
  native.applies(synthId(4), 4);
  world.fetchCommitsAnswer = {
    groupId: GROUP,
    fromEpoch: 2,
    result: {
      kind: "ok",
      body: {
        commits: [commitAt(2), commitAt(3), commitAt(4)],
        current_epoch: 4,
      },
    },
  };
}

test("E1 — a 404 met by the check's OWN catch-up ends the check: never green, even with native at the DS's epoch; the fresh rejoin decides", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-e1");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 4);
  const intents = calls(world, "mlsJoinIntent");
  scriptNestedRefetch(world, native, () =>
    world.failGapRefetchOnce(dsFailure(GROUP, 2, 404)),
  );
  const release = await adoptHeld(world);

  release();
  await flush();
  assert.equal(world.gapRefetchFailure, null, "the 404 was never delivered");
  assert.equal(calls(world, "mlsFetchCommits"), 2, "no nested refetch");
  assert.equal(
    count(log.warns(), "[mls] gap refetch: not a member of the call group"),
    1,
  );
  // The check stopped at the 404: commit 4 was never fed, nothing confirmed.
  assert.equal(world.epoch, 1, "the check fed commits past its own 404");
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 0);
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.session.callMode().kind, "negotiating");

  await sampled(t, 2_000, watch);
  assert.ok(world.leaveCleanups.includes(GROUP), "the adoption was kept");
  assert.equal(calls(world, "mlsJoinIntent"), intents + 1, "no fresh intent");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
  assert.deepEqual(louds(world), []);

  // The rejoin's own Welcome, at the DS's epoch, confirms current.
  await world.welcome(4);
  assert.equal(world.session.state(), "active");
  await keysChanged(world, 4);
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.ok(watch.opened(), "the gate never opened");
  assert.deepEqual(watch.staleGreens(), []);
});

test("E2 — LDA-M1's race where the check's own send-key install FAILS: the push's remote-only install moved the counter, our send key is still epoch 1's — never active, never publishing, loud with the curated error", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-e2");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 4);
  scriptCatchUp(world, native, { specPushes4: true });
  const release = await adoptHeld(world);
  const installs = world.keyInstalls.length;
  const push = pushAtStateRead(world, () =>
    world.failLocalKeyOnce(new Error("key install failed: worker unavailable")),
  );

  release();
  await flush();
  assert.equal(push.fired(), true, "the push never landed at the state read");
  assert.equal(
    world.localKeyFailure,
    null,
    "the local-key failure was not taken",
  );
  // Only the push's remote half entered: our send key never moved off 1.
  assert.deepEqual(installsSince(world, installs).slice(0, 1), [
    "applyRemoteKeys@4",
  ]);
  assert.equal(
    installsSince(world, installs).includes("applyKeys@4"),
    false,
    "a local install at 4 landed",
  );
  assert.notEqual(
    world.session.state(),
    "active",
    "active on epoch 1's send key",
  );
  assert.equal(world.publishing(), false, "published under epoch 1's key");
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 0);
  assert.equal(count(log.errors(), "[mls] welcome currency not confirmed"), 1);
  const loud = louds(world).at(-1);
  assert.ok(loud instanceof Error, "the failed install did not latch");
  assert.equal(loud.message, ENCRYPTION_UNCONFIRMED);
  assert.equal(world.terminalLoud(), true);

  // The push's deferred send-key install fires later; nothing revives the
  // check's verdict.
  await sampled(t, ADD_GRACE_MS + 1_000, watch);
  assert.notEqual(world.session.state(), "active", "revived by the grace");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
});

test("E3 — a Welcome adopted after the session FAILED runs no check and never revives it", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-e3");
  const log = consoleLog(t);
  await startJoiner(t, world);
  // The second intent's signing fails: loud, `failed`, the join target kept.
  world.failCallJoinIntentOnce(new Error("callJoinIntent: native error"));
  await advance(t, JOINER_RETRY_MS);
  assert.equal(world.callJoinIntentFailure, null, "the failure was not taken");
  assert.equal(world.session.state(), "failed");
  assert.equal(world.session.groupId(), GROUP);
  const watch = monitor(world, () => 1);
  const loudsBefore = louds(world).length;

  // The first intent's Welcome drains late, and is adopted natively.
  await world.welcome(1);
  await keysChanged(world, 1);
  assert.equal(count(log.infos(), "[mls] welcome adopted"), 1);
  await sampled(t, CURRENCY_DEADLINE_MS + STEP_MS, watch);
  assert.equal(calls(world, "mlsFetchCommits"), 0, "a failed session asked");
  assert.equal(world.session.state(), "failed");
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 0);
  assert.equal(count(log.errors(), "[mls] welcome currency"), 0);
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
  assert.equal(louds(world).length, loudsBefore, "a second latch");
});

test("E4 — a synthetic commit in the check's catch-up whose own refetch fails transiently fails the CHECK: loud, never re-queued, never green", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-e4");
  const native = scriptNative(world);
  const log = consoleLog(t);
  await startJoiner(t, world);
  const watch = monitor(world, () => 4);
  const intents = calls(world, "mlsJoinIntent");
  scriptNestedRefetch(world, native, () =>
    world.failGapRefetchOnce(dsFailure(GROUP, 2, 503)),
  );
  const release = await adoptHeld(world);

  release();
  await flush();
  assert.equal(world.gapRefetchFailure, null, "the 503 was never delivered");
  assert.equal(calls(world, "mlsFetchCommits"), 2, "no nested refetch");
  // Handed back to the check, not retried as a mailbox envelope.
  assert.equal(
    count(log.warns(), "[mls] gap refetch failed"),
    0,
    "retried as a mailbox envelope",
  );
  assert.equal(count(log.errors(), "[mls] welcome currency check threw"), 1);
  assert.equal(world.epoch, 1, "the check fed commits past the failure");
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 0);
  const [loud] = louds(world);
  assert.ok(loud instanceof Error, "the failed catch-up did not latch");
  assert.equal(loud.message, ENCRYPTION_UNCONFIRMED);
  assert.equal(world.terminalLoud(), true);

  // No re-drain of the synthetic (its refetch again would be unscripted,
  // which fails the spec), no rejoin.
  const processed = calls(world, "processEnvelope");
  await sampled(t, 5 * RETRY_DELAY_MS, watch);
  assert.equal(calls(world, "processEnvelope"), processed, "re-queued");
  assert.equal(calls(world, "mlsFetchCommits"), 2);
  assert.equal(calls(world, "mlsJoinIntent"), intents, "a transient rejoined");
  assert.notEqual(world.session.state(), "active");
  assert.equal(watch.opened(), false, heldView(watch.readings).join("\n"));
});

test("N1 — dispose during the check's backoff wakes the check: it finishes on the closed session (its deadline is cleared after dispose) and acts on nothing (LDA-n1)", async (t) => {
  const world = newWorld(t, "joiner", "ch-drainfail-n1");
  const log = consoleLog(t);
  await startJoiner(t, world);
  world.failGapRefetchOnce(dsFailure(GROUP, 2, 502));

  // The check's deadline timer, as the Welcome's check arms it. The spies
  // wrap the fake clock's own functions and are restored before the test
  // ends, so the harness's clock teardown finds its own.
  const armed = t.mock.method(globalThis, "setTimeout");
  try {
    await world.welcome(1);
  } finally {
    armed.mock.restore();
  }
  const deadlines: unknown[] = armed.mock.calls
    .filter((call) => call.arguments[1] === CURRENCY_DEADLINE_MS)
    .map((call) => call.result);
  assert.equal(deadlines.length, 1, "no single deadline armed");
  await advance(t, 500);
  assert.equal(calls(world, "mlsFetchCommits"), 1, "not in its backoff");
  const states = world.states.length;

  const cleared = t.mock.method(globalThis, "clearTimeout");
  let afterDispose: unknown[];
  try {
    world.session.dispose();
    const during = cleared.mock.calls.length;
    await flush();
    afterDispose = cleared.mock.calls
      .slice(during)
      .map((call) => call.arguments[0]);
  } finally {
    cleared.mock.restore();
  }
  // The check's `finally` ran AFTER dispose returned: woken, not stranded.
  assert.equal(
    afterDispose.filter((timer) => deadlines.includes(timer)).length,
    1,
    "the check never settled after dispose",
  );

  const bridge = world.bridgeCalls.length;
  await advance(t, 2 * CURRENCY_DEADLINE_MS);
  assert.equal(world.session.state(), "closed");
  assert.equal(calls(world, "mlsFetchCommits"), 1, "retried after dispose");
  assert.deepEqual(world.bridgeCalls.slice(bridge), []);
  assert.deepEqual(world.states.slice(states), []);
  assert.equal(count(log.errors(), "[mls] welcome currency"), 0);
  assert.equal(count(log.infos(), "[mls] welcome confirmed current"), 0);
});

// ---- D1: the L14c fleet scenario ----------------------------------------------

test("D1 — L14c: a restarted page whose mailbox drains late, a stale Welcome first, never goes green at the stale epoch and rejoins", async (t) => {
  const channel = "ch-drainfail-d1";
  const fleet = newFleet(t, [SELF, PEER, THIRD], channel);
  await fleet.bringUp();
  await advance(t, 20_000);
  const log = consoleLog(t);
  const self = fleet.seat(SELF);
  const peer = fleet.seat(PEER);
  const third = fleet.seat(THIRD);

  // PEER's and THIRD's pages die; SELF removes THIRD (epoch 3). PEER is
  // offline, so the Remove waits in its mailbox, and so does a Welcome for
  // epoch 1 that the DS re-delivers (the stale one).
  peer.pageDeath();
  third.pageDeath();
  self.sfu = self.sfu.filter((id) => id !== THIRD_ID);
  self.sids.delete(THIRD_ID);
  self.session.onParticipantLeft(THIRD_ID);
  await flush();
  await advance(t, LEAVE_GRACE_MS + 1_000);
  assert.equal(fleet.ds.epoch, 3);
  fleet.ds.deliver(
    {
      id: "stale-welcome",
      content_type: "mls_welcome",
      group_id: GROUP,
      epoch: 1,
      ciphertext: "welcome-1",
    },
    [PEER],
  );
  // The harness's pre-sink buffer dies with the page; the spec keeps the
  // mailbox itself, as the DS does.
  const mailbox: MlsSinkEvent[] = peer.preSinkBuffer.filter(
    (e) => e.kind === "envelope",
  );
  assert.deepEqual(
    mailbox.map((e) => (e.kind === "envelope" ? e.envelope.epoch : -1)),
    [3, 1],
  );

  // A new page starts, and its WebSocket is not up yet: it wipes, re-intents
  // (flagged `rejoin`), and SELF removes PEER's stale leaf (epoch 4) — every
  // push to PEER meanwhile goes to the mailbox, not the page.
  const offline: MlsSinkEvent[] = [];
  const down = t.mock.method(peer, "receive", (event: MlsSinkEvent) => {
    if (event.kind === "envelope") offline.push(event);
  });
  await fleet.wipeRejoin(PEER);
  const watch = monitor(peer, () => fleet.ds.epoch);
  for (let waited = 0; fleet.ds.epoch < 4 && waited < 5_000; ) {
    await advance(t, STEP_MS);
    waited += STEP_MS;
    watch.sample();
  }
  assert.equal(fleet.ds.epoch, 4, "SELF never removed PEER's stale leaf");
  assert.deepEqual(fleet.ds.members.map(identityOf), [SELF_ID]);
  assert.equal(peer.session.state(), "starting");

  // The socket comes up: the mailbox drains, oldest first — the Remove of
  // THIRD, the stale Welcome, the Remove of PEER.
  down.mock.restore();
  const drained = [...mailbox, ...offline];
  assert.deepEqual(
    drained.map((e) => (e.kind === "envelope" ? e.envelope.epoch : -1)),
    [3, 1, 4],
  );
  for (const event of drained) peer.receive(event);
  await flush();
  // The stale Welcome WAS adopted natively (the scenario is live), and the
  // check refused it.
  assert.equal(count(log.infos(), "[mls] welcome adopted"), 1);
  assert.equal(
    count(log.warns(), "[mls] welcome currency: rejoining fresh"),
    1,
  );
  assert.notEqual(peer.session.state(), "active");

  // Whatever happens next, sampled: PEER rejoins through the admit path.
  await sampled(t, 60_000, watch);
  assert.deepEqual(watch.staleGreens(), []);
  assert.equal(peer.session.state(), "active");
  assert.equal(peer.session.callMode().kind, "e2ee");
  assert.equal(peer.localEpoch, fleet.ds.epoch);
  assert.deepEqual(fleet.ds.members.map(identityOf), [SELF_ID, PEER_ID]);
  assert.deepEqual(peer.localRoster.map(identityOf), [SELF_ID, PEER_ID]);
  assert.ok(watch.opened(), "PEER never published again");
  assert.deepEqual(louds(peer), []);
});

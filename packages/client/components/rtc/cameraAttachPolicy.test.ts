// Unit spec for the camera processor attach policy and its driver.
//   node --test --conditions=browser components/rtc/cameraAttachPolicy.test.ts
// Focus: which sender operations a plan issues, that a tune is never blocked
// by a held publish gate while every sender operation is deferred under one,
// and the driver's privacy hold: a wanted background takes the hold before
// the gate is consulted, keeps it while deferred, and gives it up only after
// the background is verified active. A background that cannot be made active
// mutes the camera first, then tears down, then releases. The decision and
// the driver live in a dependency-free module precisely so these rules are
// reachable by `node --test` and by `scripts/rtc-mutations.py`; the wiring in
// `state.tsx` is live-only.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CameraApplyResult,
  type CameraAttachAction,
  type CameraAttachDeps,
  type CameraOccupant,
  type CameraOpGuard,
  type CameraPlan,
  type CameraSenderOp,
  CameraAttachDriver,
  cameraAttachAction,
  cameraNeedsHold,
  planCameraOps,
} from "./cameraAttachPolicy.ts";

const OCCUPANTS: readonly CameraOccupant[] = [
  "none",
  "background",
  "face",
  "brightness-fallback",
];
const BOOLS = [false, true] as const;

const SET: readonly CameraSenderOp[] = ["setProcessor"];
const STOP: readonly CameraSenderOp[] = ["stopProcessor"];
const SWAP: readonly CameraSenderOp[] = ["stopProcessor", "setProcessor"];

const plan = (over: Partial<CameraPlan> = {}): CameraPlan => ({
  current: "none",
  wanted: "none",
  backgroundUnresolved: false,
  active: false,
  ...over,
});

// ---- planCameraOps ---------------------------------------------------------

// Every (current, wanted) pair, written out by hand. The first spec proves it
// is complete and duplicate-free before reading it.
const OPS_TABLE: ReadonlyArray<
  readonly [CameraOccupant, CameraOccupant, readonly CameraSenderOp[]]
> = [
  ["none", "none", []],
  ["none", "background", SET],
  ["none", "face", SET],
  ["none", "brightness-fallback", SET],
  ["background", "none", STOP],
  ["background", "background", []],
  ["background", "face", SWAP],
  ["background", "brightness-fallback", SWAP],
  ["face", "none", STOP],
  ["face", "background", SWAP],
  ["face", "face", []],
  ["face", "brightness-fallback", SWAP],
  ["brightness-fallback", "none", STOP],
  ["brightness-fallback", "background", SWAP],
  ["brightness-fallback", "face", SWAP],
  ["brightness-fallback", "brightness-fallback", []],
];

test("planCameraOps: every current/wanted pair", () => {
  assert.equal(OPS_TABLE.length, 16);
  assert.equal(new Set(OPS_TABLE.map(([c, w]) => `${c}>${w}`)).size, 16);
  for (const [current, wanted, want] of OPS_TABLE) {
    for (const active of BOOLS) {
      assert.deepEqual(
        planCameraOps(plan({ current, wanted, active })),
        want,
        `${current}>${wanted} active=${active}`,
      );
    }
  }
});

test("planCameraOps: an unresolved background issues no sender op", () => {
  for (const current of OCCUPANTS) {
    for (const wanted of OCCUPANTS) {
      for (const active of BOOLS) {
        assert.deepEqual(
          planCameraOps(
            plan({ current, wanted, active, backgroundUnresolved: true }),
          ),
          [],
          `${current}>${wanted} active=${active}`,
        );
      }
    }
  }
});

test("planCameraOps: a swap stops before it sets", () => {
  // The order is what makes a swap transit RAW inside LiveKit. The driver's
  // hold does not prevent that transit.
  assert.deepEqual(
    planCameraOps(plan({ current: "face", wanted: "background" })),
    ["stopProcessor", "setProcessor"],
  );
});

// ---- cameraAttachAction ----------------------------------------------------

type ActionInput = Parameters<typeof cameraAttachAction>[0];

// (ops empty?, hasOccupant, gateHeld) in binary order.
const ACTION_TABLE: ReadonlyArray<
  readonly [boolean, boolean, boolean, CameraAttachAction]
> = [
  [true, false, false, "none"],
  [true, false, true, "none"],
  [true, true, false, "tune"],
  [true, true, true, "tune"],
  [false, false, false, "apply"],
  [false, false, true, "defer"],
  [false, true, false, "apply"],
  [false, true, true, "defer"],
];

const NON_EMPTY_OPS = [SET, STOP, SWAP];

test("cameraAttachAction: the four arms over every input", () => {
  assert.equal(ACTION_TABLE.length, 8);
  assert.equal(
    new Set(ACTION_TABLE.map(([e, o, g]) => `${e}/${o}/${g}`)).size,
    8,
  );
  for (const [empty, hasOccupant, gateHeld, want] of ACTION_TABLE) {
    for (const ops of empty ? [[]] : NON_EMPTY_OPS) {
      assert.equal(
        cameraAttachAction({ ops, hasOccupant, gateHeld }),
        want,
        `${ops.join("+") || "no-ops"}/${hasOccupant}/${gateHeld}`,
      );
    }
  }
});

test("cameraAttachAction: a tune is never blocked by a held gate", () => {
  // Arm order: the tune arm sits above the gate arm.
  assert.equal(
    cameraAttachAction({ ops: [], hasOccupant: true, gateHeld: true }),
    "tune",
  );
});

test("cameraAttachAction: empty ops never defer", () => {
  // Arm order: the "none" arm sits above the gate arm too, or the gate edge
  // would run an apply nobody asked for.
  for (const hasOccupant of BOOLS) {
    assert.notEqual(
      cameraAttachAction({ ops: [], hasOccupant, gateHeld: true }),
      "defer",
    );
  }
  assert.equal(
    cameraAttachAction({ ops: [], hasOccupant: false, gateHeld: true }),
    "none",
  );
});

test("cameraAttachAction: any sender op under a held gate defers", () => {
  const inputs: ActionInput[] = NON_EMPTY_OPS.flatMap((ops) =>
    BOOLS.map((hasOccupant) => ({ ops, hasOccupant, gateHeld: true })),
  );
  assert.equal(inputs.length, 6);
  for (const input of inputs) {
    assert.equal(cameraAttachAction(input), "defer", input.ops.join("+"));
  }
});

test("cameraAttachAction: apply only with sender ops and an empty gate", () => {
  const all: ActionInput[] = [[], ...NON_EMPTY_OPS].flatMap((ops) =>
    BOOLS.flatMap((hasOccupant) =>
      BOOLS.map((gateHeld) => ({ ops, hasOccupant, gateHeld })),
    ),
  );
  assert.equal(all.length, 16);
  const applies = all.filter((i) => cameraAttachAction(i) === "apply");
  assert.equal(applies.length, 6);
  for (const i of applies) {
    assert.equal(i.gateHeld, false);
    assert.notEqual(i.ops.length, 0);
  }
});

// ---- cameraNeedsHold -------------------------------------------------------

test("cameraNeedsHold: the truth table over all 64 plans", () => {
  const all: CameraPlan[] = OCCUPANTS.flatMap((current) =>
    OCCUPANTS.flatMap((wanted) =>
      BOOLS.flatMap((active) =>
        BOOLS.map((backgroundUnresolved) => ({
          current,
          wanted,
          active,
          backgroundUnresolved,
        })),
      ),
    ),
  );
  assert.equal(all.length, 64);
  const wantsBackground = all.filter((p) => p.wanted === "background");
  assert.equal(wantsBackground.length, 16);
  // Never for any other want, whatever else is true.
  for (const p of all) {
    if (p.wanted !== "background") {
      assert.equal(cameraNeedsHold(p), false, JSON.stringify(p));
    }
  }
  // With a background wanted, exactly ONE plan is safe to leave unheld: a
  // resolved background that is attached and live.
  assert.deepEqual(
    wantsBackground.filter((p) => !cameraNeedsHold(p)),
    [
      {
        current: "background",
        wanted: "background",
        active: true,
        backgroundUnresolved: false,
      },
    ],
  );
});

test("cameraNeedsHold: each way a wanted background is not yet safe", () => {
  const safe = plan({
    current: "background",
    wanted: "background",
    active: true,
  });
  assert.equal(cameraNeedsHold(safe), false);
  assert.equal(cameraNeedsHold({ ...safe, active: false }), true);
  assert.equal(cameraNeedsHold({ ...safe, backgroundUnresolved: true }), true);
  for (const current of ["none", "face", "brightness-fallback"] as const) {
    assert.equal(cameraNeedsHold({ ...safe, current }), true, current);
  }
});

// ---- The driver ------------------------------------------------------------

interface FakeTrack {
  name: string;
  /** What sits in the processor slot. */
  occupant: CameraOccupant;
  /** The occupant's processed track is live. */
  active: boolean;
  /** Under the privacy hold. */
  held: boolean;
}

type DepName =
  | "plan"
  | "apply"
  | "setHold:true"
  | "setHold:false"
  | "muteCamera"
  | "teardown";

interface World {
  /** Every dep call and simulated sender op, in order. */
  log: string[];
  track: FakeTrack | undefined;
  gate: boolean;
  muted: boolean;
  wanted: CameraOccupant;
  unresolved: boolean;
  /** The fake apply reports this failure instead of touching the slot. */
  applyFails: "background" | "face" | "brightness" | undefined;
  /** The fake apply attaches, but the processed track is not live. */
  inactiveAfterApply: boolean;
  /** Deps that reject while listed. */
  rejects: Set<DepName>;
  /** Run inside the named dep, after it logged and before it settles. */
  onPlan: (() => void | Promise<void>) | undefined;
  onSetHold: (() => void | Promise<void>) | undefined;
  onApply: (() => void | Promise<void>) | undefined;
  /** Run inside the fake apply between a swap's stop and its set. */
  onBetweenOps: (() => void | Promise<void>) | undefined;
  /**
   * What the fake apply acts on INSTEAD of its snapshot: a controller whose
   * view moved on after the plan was read. Undefined means the snapshot.
   */
  applySees: CameraOccupant | undefined;
  /** True while the fake apply runs; its guard asks are not logged. */
  inApply: boolean;
  /** Every snapshot `plan` handed out and every one `apply` was handed. */
  planned: Snapshot[];
  applied: Snapshot[];
  /** The guard's answer on entry to each apply. */
  guardOnEntry: boolean[];
}

/** The settings as `plan` read them. */
interface Snapshot {
  wanted: CameraOccupant;
}

const cam = (over: Partial<FakeTrack> = {}): FakeTrack => ({
  name: "cam",
  occupant: "none",
  active: false,
  held: false,
  ...over,
});

const world = (over: Partial<World> = {}): World => ({
  log: [],
  track: cam(),
  gate: false,
  muted: false,
  wanted: "none",
  unresolved: false,
  applyFails: undefined,
  inactiveAfterApply: false,
  rejects: new Set(),
  onPlan: undefined,
  onSetHold: undefined,
  onApply: undefined,
  onBetweenOps: undefined,
  applySees: undefined,
  inApply: false,
  planned: [],
  applied: [],
  guardOnEntry: [],
  ...over,
});

const APPLY_ERROR = new Error("apply reported a failure");
const rejection = (name: DepName) => new Error(`rejected: ${name}`);

/** Log suffix for any track that is not the default camera. */
const tag = (t: FakeTrack) => (t.name === "cam" ? "" : `@${t.name}`);

const REFUSED: CameraApplyResult = {
  ok: false,
  failed: "gate",
  error: undefined,
};

/**
 * The simulated controller. Like the real one it works from the snapshot
 * and asks the guard synchronously before EACH sender op; a refusal is
 * logged as `guard:refused` and nothing is issued for that op.
 */
async function fakeApply(
  w: World,
  t: FakeTrack,
  snapshot: Snapshot,
  guard: CameraOpGuard,
): Promise<CameraApplyResult> {
  w.guardOnEntry.push(guard.maySenderOp());
  await w.onApply?.();
  if (w.rejects.has("apply")) throw rejection("apply");
  if (w.applyFails) {
    return { ok: false, failed: w.applyFails, error: APPLY_ERROR };
  }
  const wanted = w.applySees ?? snapshot.wanted;
  if (t.occupant !== wanted) {
    if (t.occupant !== "none") {
      if (!guard.maySenderOp()) {
        w.log.push("guard:refused");
        return REFUSED;
      }
      w.log.push("stopProcessor");
      t.occupant = "none";
      t.active = false;
    }
    await w.onBetweenOps?.();
    if (wanted !== "none") {
      if (!guard.maySenderOp()) {
        w.log.push("guard:refused");
        return REFUSED;
      }
      w.log.push("setProcessor");
      t.occupant = wanted;
    }
  }
  t.active = t.occupant !== "none" && !w.inactiveAfterApply;
  return { ok: true, occupant: t.occupant, active: t.active };
}

function depsFor(w: World): CameraAttachDeps<FakeTrack, Snapshot> {
  return {
    gateHeld() {
      // The driver's own read is logged; the guard's asks from inside apply
      // show up as the sender op they allowed or as `guard:refused`.
      if (!w.inApply) w.log.push("gateHeld");
      return w.gate;
    },
    track: () => w.track,
    async plan(t) {
      w.log.push(`plan${tag(t)}`);
      await w.onPlan?.();
      if (w.rejects.has("plan")) throw rejection("plan");
      const snapshot: Snapshot = { wanted: w.wanted };
      w.planned.push(snapshot);
      return {
        plan: {
          current: t.occupant,
          wanted: snapshot.wanted,
          backgroundUnresolved: w.unresolved,
          active: t.occupant !== "none" && t.active,
        },
        snapshot,
      };
    },
    async apply(t, snapshot, guard) {
      w.log.push(`apply${tag(t)}`);
      w.applied.push(snapshot);
      w.inApply = true;
      try {
        return await fakeApply(w, t, snapshot, guard);
      } finally {
        w.inApply = false;
      }
    },
    async setHold(t, held) {
      w.log.push(`setHold:${held}${tag(t)}`);
      await w.onSetHold?.();
      if (w.rejects.has(`setHold:${held}`)) throw rejection(`setHold:${held}`);
      t.held = held;
    },
    async muteCamera() {
      w.log.push("muteCamera");
      if (w.rejects.has("muteCamera")) throw rejection("muteCamera");
      w.muted = true;
    },
    async teardown(t) {
      w.log.push(`teardown${tag(t)}`);
      if (w.rejects.has("teardown")) throw rejection("teardown");
      t.occupant = "none";
      t.active = false;
    },
  };
}

const driverFor = (w: World) =>
  new CameraAttachDriver<FakeTrack, Snapshot>(depsFor(w));

const senderOps = (log: readonly string[]) =>
  log.filter((op) => op === "setProcessor" || op === "stopProcessor");

/** Take the log so far and start a fresh one. */
const drain = (w: World) => w.log.splice(0, w.log.length);

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("driver: no camera track does nothing", async () => {
  const w = world({ track: undefined, wanted: "background" });
  assert.deepEqual(await driverFor(w).sync(), { kind: "none" });
  assert.deepEqual(w.log, []);
});

test("driver: nothing wanted and nothing attached is a no-op", async () => {
  for (const gate of BOOLS) {
    const w = world({ gate });
    assert.deepEqual(await driverFor(w).sync(), { kind: "none" });
    assert.deepEqual(w.log, ["plan", "gateHeld"]);
  }
});

test("driver: a tune under a held gate applies with zero sender ops", async () => {
  for (const occupant of ["face", "brightness-fallback"] as const) {
    const w = world({
      gate: true,
      wanted: occupant,
      track: cam({ occupant, active: true }),
    });
    assert.deepEqual(await driverFor(w).sync(), { kind: "tuned" });
    assert.deepEqual(w.log, ["plan", "gateHeld", "apply"]);
    assert.deepEqual(senderOps(w.log), []);
  }
});

test("driver: tuning an active background takes no hold", async () => {
  for (const gate of BOOLS) {
    const w = world({
      gate,
      wanted: "background",
      track: cam({ occupant: "background", active: true }),
    });
    assert.deepEqual(await driverFor(w).sync(), { kind: "tuned" });
    assert.deepEqual(w.log, ["plan", "gateHeld", "apply"]);
  }
});

test("driver: any sender op under a held gate defers and never applies", async () => {
  const cases: ReadonlyArray<readonly [CameraOccupant, CameraOccupant]> = [
    ["none", "face"],
    ["none", "brightness-fallback"],
    ["face", "none"],
    ["background", "none"],
    ["face", "brightness-fallback"],
    ["background", "face"],
  ];
  for (const [occupant, wanted] of cases) {
    const w = world({
      gate: true,
      wanted,
      track: cam({ occupant, active: true }),
    });
    assert.deepEqual(await driverFor(w).sync(), { kind: "deferred" });
    assert.deepEqual(w.log, ["plan", "gateHeld"], `${occupant}>${wanted}`);
    assert.equal(w.track?.occupant, occupant);
  }
});

test("driver: a wanted background takes the hold before the gate is read and keeps it while deferred", async () => {
  for (const occupant of ["none", "face", "brightness-fallback"] as const) {
    const w = world({
      gate: true,
      wanted: "background",
      track: cam({ occupant, active: true }),
    });
    const driver = driverFor(w);
    assert.deepEqual(await driver.sync(), { kind: "deferred" });
    assert.deepEqual(w.log, ["plan", "setHold:true", "gateHeld"], occupant);
    assert.equal(w.track?.held, true);
    assert.equal(w.muted, false);
    // Still deferred, still held, on every further pass under the gate.
    drain(w);
    assert.deepEqual(await driver.sync(), { kind: "deferred" });
    assert.deepEqual(w.log, ["plan", "setHold:true", "gateHeld"]);
    assert.equal(w.track?.held, true);
  }
});

test("driver: a background attach releases the hold only after an active result", async () => {
  const w = world({ wanted: "background" });
  assert.deepEqual(await driverFor(w).sync(), { kind: "applied" });
  assert.deepEqual(w.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    "setProcessor",
    "setHold:false",
  ]);
  assert.equal(w.track?.held, false);
  assert.equal(w.muted, false);
});

test("driver: a swap into a background holds until the background is active", async () => {
  const w = world({
    wanted: "background",
    track: cam({ occupant: "face", active: true }),
  });
  assert.deepEqual(await driverFor(w).sync(), { kind: "applied" });
  assert.deepEqual(w.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    "stopProcessor",
    "setProcessor",
    "setHold:false",
  ]);
});

test("driver: an attached but dead background is re-applied under the hold", async () => {
  const w = world({
    wanted: "background",
    track: cam({ occupant: "background", active: false }),
  });
  assert.deepEqual(await driverFor(w).sync(), { kind: "tuned" });
  assert.deepEqual(w.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    "setHold:false",
  ]);
});

test("driver: a background that is not active after apply fails closed, mute first", async () => {
  const w = world({ wanted: "background", inactiveAfterApply: true });
  const out = await driverFor(w).sync();
  assert.equal(out.kind, "failed-closed");
  assert.equal(out.kind === "failed-closed" && out.muted, true);
  assert.deepEqual(w.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    "setProcessor",
    "muteCamera",
    "teardown",
    "setHold:false",
  ]);
  assert.equal(w.muted, true);
  assert.equal(w.track?.occupant, "none");
  assert.equal(w.track?.held, false);
});

test("driver: a background turned off while apply runs releases the hold without a mute", async () => {
  // The plan wanted a background and took the hold; the controller's view
  // had moved on by the time apply ran. Not a background failure.
  const cases: ReadonlyArray<
    readonly [CameraOccupant, CameraOccupant, readonly string[]]
  > = [
    ["none", "none", []],
    ["none", "face", ["setProcessor"]],
    ["face", "none", ["stopProcessor"]],
  ];
  for (const [occupant, changedTo, ops] of cases) {
    const w = world({
      wanted: "background",
      track: cam({ occupant, active: true }),
    });
    w.onApply = () => {
      w.applySees = changedTo;
    };
    assert.deepEqual(await driverFor(w).sync(), { kind: "applied" });
    assert.deepEqual(
      w.log,
      ["plan", "setHold:true", "gateHeld", "apply", ...ops, "setHold:false"],
      `${occupant}>${changedTo}`,
    );
    assert.equal(w.muted, false);
    assert.equal(w.track?.held, false);
    assert.equal(w.track?.occupant, changedTo);
  }
});

test("driver: a live background that comes back not active fails closed without a hold taken", async () => {
  // The plan saw an attached, live background and took no hold. A result
  // that says it is no longer live is a background failure all the same.
  const w = world({
    wanted: "background",
    inactiveAfterApply: true,
    track: cam({ occupant: "background", active: true }),
  });
  const out = await driverFor(w).sync();
  assert.equal(out.kind, "failed-closed");
  assert.equal(out.kind === "failed-closed" && out.muted, true);
  assert.deepEqual(w.log, [
    "plan",
    "gateHeld",
    "apply",
    "muteCamera",
    "teardown",
    "setHold:false",
  ]);
  assert.equal(w.muted, true);
});

// ---- The op-time guard -----------------------------------------------------

test("guard: a tune can never issue a sender op, whatever apply finds", async () => {
  for (const gate of BOOLS) {
    // The audit probe. The plan reads background over background (a tune);
    // the controller's view flips to "none" while the hold is being taken,
    // so its apply wants a stopProcessor. The guard refuses it.
    const w = world({
      gate,
      wanted: "background",
      track: cam({ occupant: "background", active: false }),
    });
    w.onSetHold = () => {
      w.applySees = "none";
    };
    const driver = driverFor(w);
    assert.deepEqual(await driver.sync(), { kind: "deferred" }, `${gate}`);
    assert.deepEqual(w.log, [
      "plan",
      "setHold:true",
      "gateHeld",
      "apply",
      "guard:refused",
    ]);
    assert.deepEqual(senderOps(w.log), []);
    assert.deepEqual(w.guardOnEntry, [false]);
    assert.equal(w.track?.occupant, "background");
    // Deferred, so the hold stays and nothing is muted.
    assert.equal(w.track?.held, true);
    assert.equal(w.muted, false);

    // The same from a live background, which takes no hold.
    const live = world({
      gate,
      wanted: "background",
      track: cam({ occupant: "background", active: true }),
    });
    live.onPlan = () => {
      live.applySees = "none";
    };
    assert.deepEqual(await driverFor(live).sync(), { kind: "deferred" });
    assert.deepEqual(live.log, ["plan", "gateHeld", "apply", "guard:refused"]);
    assert.deepEqual(senderOps(live.log), []);
    assert.equal(live.track?.occupant, "background");
  }
});

test("guard: the pass after a refused tune re-plans and detaches as an apply", async () => {
  const w = world({
    wanted: "background",
    track: cam({ occupant: "background", active: false }),
  });
  w.onSetHold = () => {
    w.applySees = "none";
  };
  const driver = driverFor(w);
  assert.deepEqual(await driver.sync(), { kind: "deferred" });
  drain(w);

  // The settings really are "none" now, and the plan reads them.
  w.onSetHold = undefined;
  w.applySees = undefined;
  w.wanted = "none";
  assert.deepEqual(await driver.sync(), { kind: "applied" });
  assert.deepEqual(w.log, [
    "plan",
    "gateHeld",
    "apply",
    "stopProcessor",
    "setHold:false",
  ]);
  assert.equal(w.track?.held, false);
});

test("guard: a gate that fills during apply refuses the op and defers", async () => {
  // Before the only op of an attach.
  const face = world({ wanted: "face" });
  face.onApply = () => {
    face.gate = true;
  };
  assert.deepEqual(await driverFor(face).sync(), { kind: "deferred" });
  assert.deepEqual(face.log, ["plan", "gateHeld", "apply", "guard:refused"]);
  // True when apply started, false by the time the op was due.
  assert.deepEqual(face.guardOnEntry, [true]);
  assert.equal(face.track?.occupant, "none");

  // The same for a background: deferred, the hold stays, nothing is muted.
  const bg = world({ wanted: "background" });
  bg.onApply = () => {
    bg.gate = true;
  };
  assert.deepEqual(await driverFor(bg).sync(), { kind: "deferred" });
  assert.deepEqual(bg.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    "guard:refused",
  ]);
  assert.equal(bg.track?.held, true);
  assert.equal(bg.muted, false);

  // Between the two ops of a swap: the guard is asked again for the second.
  const swap = world({
    wanted: "background",
    track: cam({ occupant: "face", active: true }),
  });
  swap.onBetweenOps = () => {
    swap.gate = true;
  };
  assert.deepEqual(await driverFor(swap).sync(), { kind: "deferred" });
  assert.deepEqual(swap.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    "stopProcessor",
    "guard:refused",
  ]);
  assert.equal(swap.track?.held, true);
  assert.equal(swap.muted, false);
});

test("guard: true for an apply under an empty gate, false for every tune", async () => {
  const attach = world({ wanted: "face" });
  assert.deepEqual(await driverFor(attach).sync(), { kind: "applied" });
  assert.deepEqual(attach.guardOnEntry, [true]);
  assert.deepEqual(senderOps(attach.log), ["setProcessor"]);

  for (const gate of BOOLS) {
    const tune = world({
      gate,
      wanted: "face",
      track: cam({ occupant: "face", active: true }),
    });
    assert.deepEqual(await driverFor(tune).sync(), { kind: "tuned" });
    assert.deepEqual(tune.guardOnEntry, [false], `${gate}`);
  }
});

test("driver: apply is handed the snapshot its plan read", async () => {
  const w = world({ wanted: "background" });
  // The live settings move on after the plan; apply still gets the plan's.
  w.onSetHold = () => {
    w.wanted = "none";
  };
  assert.deepEqual(await driverFor(w).sync(), { kind: "applied" });
  assert.equal(w.planned.length, 1);
  assert.equal(w.applied.length, 1);
  assert.equal(w.applied[0], w.planned[0]);
  assert.deepEqual(w.applied[0], { wanted: "background" });
  assert.equal(w.track?.occupant, "background");
});

test("driver: a track replaced during apply is never muted for the old one", async () => {
  const failures: ReadonlyArray<Partial<World>> = [
    { applyFails: "background" },
    { inactiveAfterApply: true },
    { rejects: new Set<DepName>(["apply"]) },
  ];
  for (const failure of failures) {
    const old = cam({ name: "old" });
    const next = cam({ name: "next" });
    const w = world({ wanted: "background", track: old, ...failure });
    w.onApply = () => {
      w.track = next;
    };
    assert.deepEqual(await driverFor(w).sync(), { kind: "none" });
    // The old track's hold is dropped; no mute, no teardown.
    assert.deepEqual(w.log.slice(0, 4), [
      "plan@old",
      "setHold:true@old",
      "gateHeld",
      "apply@old",
    ]);
    assert.equal(w.log.at(-1), "setHold:false@old");
    assert.equal(w.log.includes("muteCamera"), false);
    assert.equal(w.log.includes("teardown@old"), false);
    assert.equal(w.muted, false);
    assert.equal(old.held, false);
    assert.equal(next.held, false);
  }
});

test("driver: a reported background failure is muteCamera, teardown, setHold(false), in that order", async () => {
  const w = world({ wanted: "background", applyFails: "background" });
  assert.deepEqual(await driverFor(w).sync(), {
    kind: "failed-closed",
    error: APPLY_ERROR,
    muted: true,
  });
  assert.deepEqual(w.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    "muteCamera",
    "teardown",
    "setHold:false",
  ]);
  assert.equal(w.muted, true);
});

test("driver: a background failure while tuning an active background fails closed too", async () => {
  const w = world({
    wanted: "background",
    applyFails: "background",
    track: cam({ occupant: "background", active: true }),
  });
  assert.deepEqual(await driverFor(w).sync(), {
    kind: "failed-closed",
    error: APPLY_ERROR,
    muted: true,
  });
  assert.deepEqual(w.log, [
    "plan",
    "gateHeld",
    "apply",
    "muteCamera",
    "teardown",
    "setHold:false",
  ]);
});

test("driver: an unresolved background fails closed without calling apply", async () => {
  for (const gate of BOOLS) {
    for (const occupant of ["none", "background", "face"] as const) {
      const w = world({
        gate,
        wanted: "background",
        unresolved: true,
        track: cam({ occupant, active: true }),
      });
      const out = await driverFor(w).sync();
      assert.equal(out.kind, "failed-closed", `${occupant}/${gate}`);
      assert.deepEqual(w.log, [
        "plan",
        "setHold:true",
        "gateHeld",
        "muteCamera",
        "teardown",
        "setHold:false",
      ]);
      assert.equal(w.muted, true);
      assert.equal(w.track?.held, false);
    }
  }
});

test("driver: a face or brightness failure fails open with no mute and no hold", async () => {
  const cases = [
    ["face", "face"],
    ["brightness-fallback", "brightness"],
  ] as const;
  for (const [wanted, failed] of cases) {
    const w = world({ wanted, applyFails: failed });
    assert.deepEqual(await driverFor(w).sync(), {
      kind: "failed-open",
      failed,
      error: APPLY_ERROR,
    });
    assert.deepEqual(w.log, ["plan", "gateHeld", "apply"]);
    assert.equal(w.muted, false);
    assert.equal(w.track?.held, false);
  }
});

test("driver: a gate that fills between plan and apply defers", async () => {
  // Filled while the plan is being read.
  const a = world({ wanted: "face" });
  a.onPlan = () => {
    a.gate = true;
  };
  assert.deepEqual(await driverFor(a).sync(), { kind: "deferred" });
  assert.deepEqual(a.log, ["plan", "gateHeld"]);

  // Filled while the hold is being taken: the last await before the read.
  const b = world({ wanted: "background" });
  b.onSetHold = () => {
    b.gate = true;
  };
  assert.deepEqual(await driverFor(b).sync(), { kind: "deferred" });
  assert.deepEqual(b.log, ["plan", "setHold:true", "gateHeld"]);
  assert.equal(b.track?.held, true);
});

test("driver: a track that changes under the plan does nothing", async () => {
  const w = world({ wanted: "background" });
  const next = cam({ name: "next" });
  w.onPlan = () => {
    w.track = next;
  };
  assert.deepEqual(await driverFor(w).sync(), { kind: "none" });
  assert.deepEqual(w.log, ["plan"]);
  assert.equal(next.held, false);
});

test("driver: a stale track releases the old hold and does nothing else", async () => {
  const old = cam({ name: "old" });
  const w = world({ gate: true, wanted: "background", track: old });
  const driver = driverFor(w);
  assert.deepEqual(await driver.sync(), { kind: "deferred" });
  assert.equal(old.held, true);
  drain(w);

  // Replaced while the next pass is planning.
  const next = cam({ name: "next" });
  w.onPlan = () => {
    w.track = next;
  };
  assert.deepEqual(await driver.sync(), { kind: "none" });
  assert.deepEqual(w.log, ["plan@old", "setHold:false@old"]);
  assert.equal(old.held, false);
  assert.equal(next.held, false);
});

test("driver: a hold on a replaced track is released on that track, then the new one is decided", async () => {
  const old = cam({ name: "old" });
  const w = world({ gate: true, wanted: "background", track: old });
  const driver = driverFor(w);
  assert.deepEqual(await driver.sync(), { kind: "deferred" });
  drain(w);

  const next = cam({ name: "next" });
  w.track = next;
  assert.deepEqual(await driver.sync(), { kind: "deferred" });
  assert.deepEqual(w.log, [
    "setHold:false@old",
    "plan@next",
    "setHold:true@next",
    "gateHeld",
  ]);
  assert.equal(old.held, false);
  assert.equal(next.held, true);
});

test("driver: a hold on a track that went away is released", async () => {
  const old = cam({ name: "old" });
  const w = world({ gate: true, wanted: "background", track: old });
  const driver = driverFor(w);
  assert.deepEqual(await driver.sync(), { kind: "deferred" });
  drain(w);

  w.track = undefined;
  assert.deepEqual(await driver.sync(), { kind: "none" });
  assert.deepEqual(w.log, ["setHold:false@old"]);
  assert.equal(old.held, false);
  // Released once, not on every later pass.
  drain(w);
  assert.deepEqual(await driver.sync(), { kind: "none" });
  assert.deepEqual(w.log, []);
});

test("driver: two overlapping sync() calls serialize and the second re-decides", async () => {
  const w = world({ wanted: "face" });
  let open: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    open = resolve;
  });
  w.onPlan = () => {
    w.onPlan = undefined;
    return blocked;
  };
  const driver = driverFor(w);
  const first = driver.sync();
  const second = driver.sync();
  await tick();
  // The second call has not started: one plan, not two.
  assert.deepEqual(w.log, ["plan"]);
  open();
  assert.deepEqual(await first, { kind: "applied" });
  // It read the slot the first call left, so it tunes instead of attaching
  // a second time.
  assert.deepEqual(await second, { kind: "tuned" });
  assert.deepEqual(w.log, [
    "plan",
    "gateHeld",
    "apply",
    "setProcessor",
    "plan",
    "gateHeld",
    "apply",
  ]);
});

test("driver: a re-run after a deferred call applies exactly once", async () => {
  const w = world({ gate: true, wanted: "background" });
  const driver = driverFor(w);
  assert.deepEqual(await driver.sync(), { kind: "deferred" });
  assert.deepEqual(senderOps(w.log), []);
  drain(w);

  // The gate's 1→0 edge.
  w.gate = false;
  assert.deepEqual(await driver.sync(), { kind: "applied" });
  assert.deepEqual(w.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    "setProcessor",
    "setHold:false",
  ]);
  assert.equal(w.track?.held, false);
  drain(w);

  // Nothing was queued: a further pass only tunes.
  assert.deepEqual(await driver.sync(), { kind: "tuned" });
  assert.deepEqual(w.log, ["plan", "gateHeld", "apply"]);
});

test("driver: a hold left by a dropped background want is released", async () => {
  // Wanted none: nothing to do, the hold goes.
  const a = world({ gate: true, wanted: "background" });
  const da = driverFor(a);
  assert.deepEqual(await da.sync(), { kind: "deferred" });
  drain(a);
  a.wanted = "none";
  assert.deepEqual(await da.sync(), { kind: "none" });
  assert.deepEqual(a.log, ["plan", "gateHeld", "setHold:false"]);
  assert.equal(a.track?.held, false);

  // Wanted a face filter instead, gate still held: deferred, hold untouched.
  const b = world({ gate: true, wanted: "background" });
  const db = driverFor(b);
  assert.deepEqual(await db.sync(), { kind: "deferred" });
  drain(b);
  b.wanted = "face";
  assert.deepEqual(await db.sync(), { kind: "deferred" });
  assert.deepEqual(b.log, ["plan", "gateHeld"]);
  assert.equal(b.track?.held, true);
  drain(b);
  // Gate empty: the face filter lands, then the leftover hold goes.
  b.gate = false;
  assert.deepEqual(await db.sync(), { kind: "applied" });
  assert.deepEqual(b.log, [
    "plan",
    "gateHeld",
    "apply",
    "setProcessor",
    "setHold:false",
  ]);
  drain(b);

  // The same, with the face filter failing open: raw is the fallback, so
  // the leftover hold still goes.
  const c = world({ gate: true, wanted: "background" });
  const dc = driverFor(c);
  assert.deepEqual(await dc.sync(), { kind: "deferred" });
  drain(c);
  c.wanted = "face";
  c.gate = false;
  c.applyFails = "face";
  assert.equal((await dc.sync()).kind, "failed-open");
  assert.deepEqual(c.log, ["plan", "gateHeld", "apply", "setHold:false"]);
  assert.equal(c.muted, false);
});

// ---- Rejecting deps --------------------------------------------------------

const FAIL_CLOSED_TAIL = ["muteCamera", "teardown", "setHold:false"];

/** The pass after a rejection: the chain is not wedged and re-decides. */
async function recovers(
  w: World,
  driver: CameraAttachDriver<FakeTrack, Snapshot>,
) {
  w.rejects.clear();
  w.muted = false;
  drain(w);
  assert.deepEqual(await driver.sync(), { kind: "applied" });
  assert.equal(w.track?.held, false);
  assert.equal(w.track?.occupant, w.wanted);
}

test("rejecting plan fails closed and does not wedge the next call", async () => {
  // Whether a background is wanted is unknown, so it is treated as wanted,
  // whatever the settings would have said.
  for (const wanted of ["background", "face", "none"] as const) {
    const w = world({ wanted, rejects: new Set<DepName>(["plan"]) });
    const driver = driverFor(w);
    const out = await driver.sync();
    assert.equal(out.kind, "failed-closed", wanted);
    assert.deepEqual(w.log, ["plan", ...FAIL_CLOSED_TAIL]);
    assert.equal(w.muted, true);
    if (wanted !== "none") await recovers(w, driver);
  }
});

test("rejecting setHold(true) fails closed and does not wedge the next call", async () => {
  const w = world({
    wanted: "background",
    rejects: new Set<DepName>(["setHold:true"]),
  });
  const driver = driverFor(w);
  const out = await driver.sync();
  assert.equal(out.kind, "failed-closed");
  // The gate is never consulted and apply never runs.
  assert.deepEqual(w.log, ["plan", "setHold:true", ...FAIL_CLOSED_TAIL]);
  assert.equal(w.muted, true);
  await recovers(w, driver);
});

test("rejecting apply fails closed for a background and open otherwise", async () => {
  const bg = world({
    wanted: "background",
    rejects: new Set<DepName>(["apply"]),
  });
  const driver = driverFor(bg);
  assert.equal((await driver.sync()).kind, "failed-closed");
  assert.deepEqual(bg.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    ...FAIL_CLOSED_TAIL,
  ]);
  assert.equal(bg.muted, true);
  await recovers(bg, driver);

  // A background that is attached and live takes no hold, and still fails
  // closed when its tune rejects.
  const tuned = world({
    wanted: "background",
    track: cam({ occupant: "background", active: true }),
    rejects: new Set<DepName>(["apply"]),
  });
  assert.equal((await driverFor(tuned).sync()).kind, "failed-closed");
  assert.deepEqual(tuned.log, [
    "plan",
    "gateHeld",
    "apply",
    ...FAIL_CLOSED_TAIL,
  ]);

  const open = [
    ["face", "face"],
    ["brightness-fallback", "brightness"],
  ] as const;
  for (const [wanted, failed] of open) {
    const w = world({ wanted, rejects: new Set<DepName>(["apply"]) });
    const d = driverFor(w);
    const out = await d.sync();
    assert.equal(out.kind, "failed-open");
    assert.equal(out.kind === "failed-open" && out.failed, failed);
    assert.deepEqual(w.log, ["plan", "gateHeld", "apply"]);
    assert.equal(w.muted, false);
    await recovers(w, d);
  }

  // A rejected detach (nothing wanted) leaves the raw camera running.
  const detach = world({
    wanted: "none",
    track: cam({ occupant: "face", active: true }),
    rejects: new Set<DepName>(["apply"]),
  });
  const out = await driverFor(detach).sync();
  assert.equal(out.kind === "failed-open" && out.failed, "brightness");
  assert.equal(detach.muted, false);
});

test("rejecting muteCamera tears nothing down and keeps the camera held", async () => {
  const w = world({
    wanted: "background",
    applyFails: "background",
    rejects: new Set<DepName>(["muteCamera"]),
  });
  const driver = driverFor(w);
  // `muted: false`: the caller must not tell the user the camera is off.
  assert.deepEqual(await driver.sync(), {
    kind: "failed-closed",
    error: APPLY_ERROR,
    muted: false,
  });
  // No teardown and no release: a detach or a resume on an unmuted camera
  // would put raw video on the sender.
  assert.deepEqual(w.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    "muteCamera",
    "setHold:true",
  ]);
  assert.equal(w.muted, false);
  assert.equal(w.track?.held, true);

  // The same from a pass that had taken no hold: it takes one now.
  const tuned = world({
    wanted: "background",
    applyFails: "background",
    track: cam({ occupant: "background", active: true }),
    rejects: new Set<DepName>(["muteCamera"]),
  });
  assert.deepEqual(await driverFor(tuned).sync(), {
    kind: "failed-closed",
    error: APPLY_ERROR,
    muted: false,
  });
  assert.deepEqual(tuned.log, [
    "plan",
    "gateHeld",
    "apply",
    "muteCamera",
    "setHold:true",
  ]);
  assert.equal(tuned.track?.held, true);

  // Not wedged: the next pass retries the whole sequence, and this time the
  // mute lands.
  w.rejects.clear();
  drain(w);
  assert.deepEqual(await driver.sync(), {
    kind: "failed-closed",
    error: APPLY_ERROR,
    muted: true,
  });
  assert.deepEqual(w.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    ...FAIL_CLOSED_TAIL,
  ]);
  assert.equal(w.muted, true);
  assert.equal(w.track?.held, false);
  w.applyFails = undefined;
  await recovers(w, driver);
});

test("rejecting teardown still releases the hold on the muted camera", async () => {
  const w = world({
    wanted: "background",
    applyFails: "background",
    rejects: new Set<DepName>(["teardown"]),
  });
  const driver = driverFor(w);
  assert.equal((await driver.sync()).kind, "failed-closed");
  assert.deepEqual(w.log, [
    "plan",
    "setHold:true",
    "gateHeld",
    "apply",
    ...FAIL_CLOSED_TAIL,
  ]);
  assert.equal(w.muted, true);
  assert.equal(w.track?.held, false);
  w.applyFails = undefined;
  await recovers(w, driver);
});

test("rejecting setHold(false) is retried by the next call", async () => {
  const w = world({
    wanted: "background",
    rejects: new Set<DepName>(["setHold:false"]),
  });
  const driver = driverFor(w);
  // The background did land and is active; only the release failed.
  assert.deepEqual(await driver.sync(), { kind: "applied" });
  assert.equal(w.track?.held, true);
  assert.equal(w.track?.active, true);

  w.rejects.clear();
  drain(w);
  assert.deepEqual(await driver.sync(), { kind: "tuned" });
  assert.deepEqual(w.log, ["plan", "gateHeld", "apply", "setHold:false"]);
  assert.equal(w.track?.held, false);

  // Released once: a further pass has nothing left to release.
  drain(w);
  assert.deepEqual(await driver.sync(), { kind: "tuned" });
  assert.deepEqual(w.log, ["plan", "gateHeld", "apply"]);
});

test("a throwing track() rejects that call only", async () => {
  const w = world({ wanted: "face" });
  const deps = depsFor(w);
  let boom = true;
  const driver = new CameraAttachDriver<FakeTrack, Snapshot>({
    ...deps,
    track() {
      if (boom) throw new Error("track() threw");
      return w.track;
    },
  });
  await assert.rejects(driver.sync(), /track\(\) threw/);
  boom = false;
  assert.deepEqual(await driver.sync(), { kind: "applied" });
});

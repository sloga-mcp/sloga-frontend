// Session-level specs for a shell that refuses the in-app plaintext fallback
// (`confirmFallbackAllowed: false`, iOS: W3 MUST 3) and for the decode
// witness's escalation (`noteWitnessEscalated`), on the shared world in
// `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.iosconfirm.test.ts
//
// On iOS nothing can arm the native announce gate except the native confirm
// dialog, and a `declined` from it also covers a dialog that could not be
// shown at all. So `confirmPlaintext` there must never reach
// `confirmLocalPlaintext`: every rejection keeps the gate paused, and every
// one but a decline is a loud, readable failure.
//
// The value reaches the session through the harness's
// `confirmFallbackAllowed` option (default `true`). The CONTROL spec passes
// `true` and shows today's fallback, so the option is proven to be what
// decides the routing; the missing-dep spec shows that a caller which omits
// it gets the refusal (fail closed), never the fallback.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import {
  type EncryptionStateCall,
  type World,
  advance,
  bringUpCreator,
  flush,
  newWorld,
  SELF_ID,
} from "./mlsCallSession.harness.ts";

/** The curated latch error (`ENCRYPTION_UNCONFIRMED` in the session). */
const ENCRYPTION_UNCONFIRMED = "This call's encryption could not be confirmed";
/** A bare (device-less) SFU identity: non-enrolled on sight, so `mixed`. */
const DAVE = "dave";
const MIX_NAMES: Record<string, string> = { [DAVE]: "Dave" };

/** An iOS seat: the shell passes `confirmFallbackAllowed: false`. */
function iosWorld(t: TestContext, channelId: string): World {
  return newWorld(t, "creator", channelId, undefined, {
    confirmFallbackAllowed: false,
  });
}

/** Count `confirmLocalPlaintext` calls made through the session object. */
function spyLocalConfirm(world: World): () => number {
  const original = world.session.confirmLocalPlaintext.bind(world.session);
  let calls = 0;
  world.session.confirmLocalPlaintext = () => {
    calls++;
    return original();
  };
  return () => calls;
}

/** Seat a bare identity and reconcile: T1 `mixed`, with its pause held. */
async function declareMix(world: World): Promise<void> {
  world.sfu = [...world.sfu, DAVE];
  world.sids.set(DAVE, ["TR_d"]);
  await world.session.reconcileNow();
  await flush();
  assert.equal(world.session.callMode().kind, "mixed");
  assert.equal(world.publishing(), false);
}

function loudsSince(world: World, index: number): EncryptionStateCall[] {
  return world.states.slice(index).filter((s) => s.state === "loud");
}

/**
 * One loud with the curated error and `origin`, and a chip that reads it. A
 * latch taken while `mixed` keeps the mode (`loudModeFallback` folds only
 * `e2ee`), so the mixed banner and its pause clause stay; the chip is what
 * turns red there. Where the mode folds, the latched banner must render too.
 */
function assertUnconfirmedLatch(
  world: World,
  index: number,
  origin: "control" | "media",
): void {
  const louds = loudsSince(world, index);
  assert.equal(louds.length, 1, `expected one loud, got ${louds.length}`);
  assert.equal((louds[0].error as Error).message, ENCRYPTION_UNCONFIRMED);
  assert.equal(louds[0].meta?.origin, origin);
  const chip = world.chip();
  assert.ok(
    chip === "not_encrypted" || chip === "cannot_verify",
    `the chip reads ${chip} over a latch`,
  );
  if (world.session.callMode().kind !== "mixed") {
    assert.equal(world.terminalLoud(), true, "no latched banner");
  }
}

// ---- confirmFallbackAllowed: false -------------------------------------------

test("🔴 iOS: a dialog that fails for any reason but a decline keeps the pause and latches loud, never the in-app confirm", async (t) => {
  const world = iosWorld(t, "ch-ios-ipc");
  await bringUpCreator(t, world);
  await declareMix(world);
  const localConfirms = spyLocalConfirm(world);
  const before = world.states.length;

  world.failConfirmDowngradeOnce(new Error("ipc"));
  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1, "the dialog was not attempted");
  assert.equal(localConfirms(), 0, "the in-app confirm was reached");
  assert.notEqual(world.session.callMode().kind, "interlude");
  assert.equal(world.publishing(), false, "the failure released publishing");
  assertUnconfirmedLatch(world, before, "control");

  // The escape still asks the native dialog again, and an Ok there works.
  assert.equal(world.session.confirmReachable(), true);
  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 2);
  assert.equal(localConfirms(), 0);
  assert.deepEqual(world.session.callMode(), {
    kind: "interlude",
    localConfirmed: true,
    confirmedVia: "native",
  });
});

test("🔴 iOS: a decline (which there also means 'could not be shown') keeps the pause, with no latch", async (t) => {
  const world = iosWorld(t, "ch-ios-declined");
  await bringUpCreator(t, world);
  await declareMix(world);
  const localConfirms = spyLocalConfirm(world);
  const gateBefore = [...world.gate];
  const before = world.states.length;

  world.declineDowngradeOnce();
  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1);
  assert.equal(localConfirms(), 0);
  assert.equal(world.session.callMode().kind, "mixed");
  assert.deepEqual([...world.gate], gateBefore, "a decline moved the gate");
  assert.equal(world.publishing(), false);
  assert.deepEqual(loudsSince(world, before), []);
});

test("🔴 iOS: with no usable group there is no dialog and no in-app confirm: the pause holds and the call goes loud", async (t) => {
  const world = iosWorld(t, "ch-ios-nogroup");
  await bringUpCreator(t, world);
  await declareMix(world);
  // A group action scheduled and not yet run (its 0 ms timer is on the fake
  // clock): `hasUsableGroup()` is false while the call is still `mixed`,
  // unlatched, with the escape on screen.
  await world.removedSelf(1);
  assert.equal(world.session.hasUsableGroup(), false);
  assert.equal(world.session.confirmReachable(), true);
  const localConfirms = spyLocalConfirm(world);
  const before = world.states.length;

  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 0, "a dialog with no group");
  assert.equal(localConfirms(), 0, "the in-app confirm was reached");
  assert.notEqual(world.session.callMode().kind, "interlude");
  assert.equal(world.publishing(), false);
  assertUnconfirmedLatch(world, before, "control");
});

test("🔴 iOS: at a latched no-group terminus the escape asks nothing and releases nothing", async (t) => {
  const world = iosWorld(t, "ch-ios-terminus");
  await bringUpCreator(t, world);
  // Removed while gone from the SFU, then the backstop's control latch.
  world.sfu = world.sfu.filter((id) => id !== SELF_ID);
  await world.removedSelf(1);
  await advance(t, 1);
  await advance(t, 11_000);
  assert.equal(world.session.groupId(), null);
  assert.equal(world.terminalLoud(), true);
  assert.equal(world.session.confirmReachable(), true);
  const localConfirms = spyLocalConfirm(world);
  const before = world.states.length;

  await world.session.confirmPlaintext({});
  await flush();
  assert.equal(world.confirmDowngrades(), 0);
  assert.equal(localConfirms(), 0, "the in-app confirm was reached");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.publishing(), false);
  assert.deepEqual(world.states.slice(before), [], "the latch was re-badged");
  assert.equal(world.terminalLoud(), true);
});

test("iOS: under an existing media latch a refused confirm adds nothing (no control upgrade)", async (t) => {
  const world = iosWorld(t, "ch-ios-latched");
  await bringUpCreator(t, world);
  await advance(t, 3_000);
  world.session.noteEncryptionError(
    new Error("InvalidKey: Decryption failed: x"),
  );
  await flush();
  const before = world.states.length;
  const localConfirms = spyLocalConfirm(world);

  world.failConfirmDowngradeOnce(new Error("ipc"));
  await world.session.confirmPlaintext({});
  await flush();
  assert.equal(localConfirms(), 0);
  assert.deepEqual(world.states.slice(before), [], "the latch was re-badged");
  assert.equal(world.publishing(), false);
});

test("CONTROL: the same seam passing `true` keeps today's fallback (an IPC failure reaches the in-app confirm)", async (t) => {
  const world = newWorld(t, "creator", "ch-ios-control", undefined, {
    confirmFallbackAllowed: true,
  });
  await bringUpCreator(t, world);
  await declareMix(world);
  const localConfirms = spyLocalConfirm(world);

  world.failConfirmDowngradeOnce(new Error("ipc"));
  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(localConfirms(), 1);
  assert.deepEqual(world.session.callMode(), {
    kind: "interlude",
    localConfirmed: true,
    confirmedVia: "app",
  });
  assert.equal(world.publishing(), true);
});

test("🔴 a caller that OMITS confirmFallbackAllowed gets the refusal, never the fallback (fails closed)", async (t) => {
  // An untyped construction site: the dep reaches the session as undefined.
  const world = newWorld(t, "creator", "ch-ios-missing", (w) => {
    w.confirmFallbackAllowed = undefined as unknown as boolean;
  });
  await bringUpCreator(t, world);
  await declareMix(world);
  const localConfirms = spyLocalConfirm(world);
  const before = world.states.length;

  world.failConfirmDowngradeOnce(new Error("ipc"));
  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(
    localConfirms(),
    0,
    "a missing dep fell back to the in-app confirm",
  );
  assert.notEqual(world.session.callMode().kind, "interlude");
  assert.equal(world.publishing(), false);
  assertUnconfirmedLatch(world, before, "control");
});

// ---- noteWitnessEscalated ----------------------------------------------------

test("🔴 noteWitnessEscalated latches the loud media verdict and holds the gate", async (t) => {
  const world = newWorld(t, "creator", "ch-witness");
  await bringUpCreator(t, world);
  await advance(t, 3_000);
  const escalated = (
    world.session as unknown as { noteWitnessEscalated?: () => void }
  ).noteWitnessEscalated;
  assert.equal(typeof escalated, "function", "noteWitnessEscalated missing");
  const before = world.states.length;

  world.session.noteWitnessEscalated();
  await flush();
  assertUnconfirmedLatch(world, before, "media");
  assert.equal(loudsSince(world, before)[0].meta?.mediaKeyed, true);
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.publishing(), false, "the banner's pause claim is false");

  // Idempotent: a second report adds nothing.
  const after = world.states.length;
  world.session.noteWitnessEscalated();
  await flush();
  assert.deepEqual(world.states.slice(after), []);
});

test("noteWitnessEscalated on a disposed session reports nothing", async (t) => {
  const world = newWorld(t, "creator", "ch-witness-closed");
  await bringUpCreator(t, world);
  world.session.dispose();
  await flush();
  const before = world.states.length;
  (
    world.session as unknown as { noteWitnessEscalated?: () => void }
  ).noteWitnessEscalated?.();
  await flush();
  assert.deepEqual(loudsSince(world, before), []);
});

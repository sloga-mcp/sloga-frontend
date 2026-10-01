// The screen leg's admit grace, as `mlsCallSession.ts` wires it — run with
// Node's built-in runner, from packages/client:
//   node --test --conditions=browser components/rtc/mlsCallSession.leggrace.test.ts
//
// A leg is billed against the per-call admit-grace ledger like any joiner,
// but it never sends a join request. So before this fix a phone that shared
// enough times ran out of budget (each share start billed its own
// connect→publish gap against a ledger that lives for the whole call), and a
// leg slower than one window to publish lapsed straight into non-enrolled.
// Either way the share self-stopped and every viewer went red. The decisions
// live in `mlsAdmitGracePolicy.ts` (`admitGraceLedgerResets`,
// `shouldRearmAdmitGrace`, `legOwnerPresent`), where their own specs hold
// them. This file holds the session to CALLING them, two ways:
//
//  - SOURCE PINS over `mlsCallSession.ts`, matched as TEXT after `codeOf`
//    (`sourcePins.harness.ts`), for the inputs each call is handed and the
//    order of the settle loop (bill THEN reset). They have the limits
//    `stateWiring.test.ts` lists: the same text in dead code satisfies a pin,
//    and an equivalent rewrite (a renamed local, braces around a one-line
//    `if`) breaks one. Changing one of these sites on purpose means changing
//    its pin here too.
//  - BEHAVIOR through the real session on the `mlsCallSession.harness.ts`
//    world. The harness's binding implements neither leg accessor, so this
//    file adds both (`encryptedLegs`, `unpublishedLegs`) by wrapping
//    `bindMedia` for each test (restored when the test ends), and a spec
//    moves a leg through join, publish and leave by hand.
//
// "Loud" here is the leg reported non-enrolled now, OR the call flipping to
// `mixed` at any point since the spec's mark. Non-enrolled alone is not a
// stable witness: once the call is `mixed`, rule 2(b) is off and the leg
// folds onto its owner, so it drops out of the non-enrolled set while the
// call stays red.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type TestContext, test } from "node:test";

import {
  type World,
  advance,
  bringUpCreator,
  flush,
  newWorld,
  PEER_ID,
  SELF_ID,
  THIRD,
  THIRD_ID,
} from "./mlsCallSession.harness.ts";
import type { MlsMediaBinding } from "./mlsCallSession.ts";
import {
  argumentsOf,
  assertLexesInSync,
  bodiesAfter,
  codeOf,
  countWired,
  wiredAsserter,
  wiredAt,
} from "./sourcePins.harness.ts";

// After the harness, whose loader hook resolves the session's extensionless
// sibling imports.
const { MlsCallSession } = await import("./mlsCallSession.ts");

// ---- Source pins ------------------------------------------------------------

const SESSION_SOURCE = readFileSync(
  new URL("./mlsCallSession.ts", import.meta.url),
  "utf8",
);
const SESSION_CODE = codeOf(SESSION_SOURCE);

/** `snippet` must appear exactly once in mlsCallSession.ts's code. */
const assertWired = wiredAsserter("mlsCallSession.ts", SESSION_CODE);

/** The inside of the ONE block or argument list `head` opens in `code`. */
function bodyAfter(what: string, code: string, head: string): string {
  const bodies = bodiesAfter(code, head);
  assert.equal(
    bodies.length,
    1,
    `${what} must contain this exactly once, found ${bodies.length}:\n` +
      codeOf(head),
  );
  return bodies[0];
}

/** Where `snippet` occurs ONCE in `code`, which must hold it exactly once. */
function onceAt(what: string, code: string, snippet: string): number {
  const found = wiredAt(code, snippet);
  assert.equal(
    found.length,
    1,
    `${what} must contain this exactly once, found ${found.length}:\n` +
      codeOf(snippet),
  );
  return found[0];
}

/**
 * How many `{` are open at `at` in `code` (the inside of a block, put through
 * `codeOf`), skipping strings the way `codeOf` reads them. 0 is the block's
 * own top level.
 */
function braceDepthAt(code: string, at: number): number {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") j++;
        j++;
      }
      i = j;
    } else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
}

/** The names `import { ... } from "<module>"` brings in. */
function importedFrom(module: string): string[] {
  const tail = `}from${JSON.stringify(module)}`;
  const end = onceAt("mlsCallSession.ts", SESSION_CODE, tail);
  const start = SESSION_CODE.lastIndexOf("import{", end);
  assert.ok(start !== -1, `no import opens before ${tail}`);
  return argumentsOf(SESSION_CODE.slice(start + "import{".length, end));
}

/** `#reconcileOnce`'s body: every roster reconcile runs through it. */
function reconcileOnceBody(): string {
  return bodyAfter(
    "mlsCallSession.ts",
    SESSION_CODE,
    `async #reconcileOnce(): Promise<RosterReconcileResult | null> {`,
  );
}

/** The settle loop over every open admit-grace window, inside `#reconcileOnce`. */
function settleLoopBody(): string {
  return bodyAfter(
    "#reconcileOnce",
    reconcileOnceBody(),
    `for (const [identity, entry] of this.#admitGrace) {`,
  );
}

/** `#onAdmitGraceExpiry`'s body: a window's timer ran out. */
function expiryBody(): string {
  return bodyAfter(
    "mlsCallSession.ts",
    SESSION_CODE,
    `#onAdmitGraceExpiry(identity: string): void {`,
  );
}

test("mlsCallSession.ts lexes in sync, so a pin cannot pass on a misread file", () => {
  assertLexesInSync("mlsCallSession.ts", SESSION_SOURCE, SESSION_CODE, 500);
});

test("the three leg decisions are imported from the policy leaf, and isScreenLeg from the identity grammar", () => {
  const policy = importedFrom("./mlsAdmitGracePolicy");
  for (const name of [
    "admitGraceLedgerResets",
    "legOwnerPresent",
    "shouldRearmAdmitGrace",
  ])
    assert.ok(policy.includes(name), `${name} is not imported: ${policy}`);
  assert.ok(
    importedFrom(
      "../ui/components/features/voice/participantIdentity",
    ).includes("isScreenLeg"),
    "isScreenLeg is not imported from participantIdentity",
  );
});

test("each leg decision has exactly one call site", () => {
  for (const call of [
    "admitGraceLedgerResets(",
    "shouldRearmAdmitGrace(",
    "legOwnerPresent(",
  ])
    assert.equal(
      countWired(SESSION_CODE, call),
      1,
      `mlsCallSession.ts must call ${call}...) exactly once`,
    );
});

test("🔴 the settle loop bills the stretch THEN resets the ledger (C-a)", () => {
  const loop = settleLoopBody();
  const bill = onceAt(
    "the settle loop",
    loop,
    `if (settled.billMs > 0) this.#billAdmitGrace(identity, settled.billMs);`,
  );
  const reset = onceAt(
    "the settle loop",
    loop,
    `if (admitGraceLedgerResets({ isLeg, legPublished: seenPublished }))
      this.#admitGraceUsed.delete(identity);`,
  );
  // Reversed, the stretch just billed survives the reset, and every share
  // start still costs its connect→publish gap.
  assert.ok(bill < reset, "the ledger is reset BEFORE the stretch is billed");
  // Both at the loop's own top level: neither one is skipped by a condition
  // the other is not.
  assert.equal(braceDepthAt(loop, bill), 0, "the billing is nested");
  assert.equal(braceDepthAt(loop, reset), 0, "the reset is nested");
  // The ledger has ONE delete in the whole file: no other path forgives.
  assert.equal(
    countWired(SESSION_CODE, "this.#admitGraceUsed.delete("),
    1,
    "the admit-grace ledger is deleted from somewhere else",
  );
});

test("🔴 the reset touches the ledger only: never a window's timer or deadline, never an arm (C-c)", () => {
  const loop = settleLoopBody();
  for (const forbidden of [
    "entry.deadline=",
    "entry.expiresAt=",
    "entry.timer=",
    "#armAdmitGrace(",
    "#rearmAdmitGrace(",
    "#refreshAdmitGrace(",
    "#admitGrace.delete(",
  ])
    assert.equal(
      countWired(loop, forbidden),
      0,
      `the settle loop must not contain ${forbidden}`,
    );
});

test("🔴 seenPublished fails CLOSED: absent accessor, absent from the SFU, or unwitnessed in e2ee forgives nothing (C-b)", () => {
  const reconcile = reconcileOnceBody();
  const loopHead = onceAt(
    "#reconcileOnce",
    reconcile,
    `for (const [identity, entry] of this.#admitGrace) {`,
  );
  // The inputs, read once per reconcile and before the loop. An ABSENT
  // `unpublishedLegs` accessor stays `undefined`: no `?? []`, which would
  // read every leg as published and forgive it.
  for (const input of [
    `const sfuNow = new Set(media.sfuParticipants());`,
    `const unpublishedLegs = media.unpublishedLegs?.();`,
    `const encryptedLegs = new Set(media.encryptedLegs?.() ?? []);`,
    `const e2ee = this.#callMode.kind === "e2ee";`,
  ])
    assert.ok(
      onceAt("#reconcileOnce", reconcile, input) < loopHead,
      `read after the settle loop opens: ${input}`,
    );
  onceAt(
    "the settle loop",
    settleLoopBody(),
    `const seenPublished =
      isLeg &&
      unpublishedLegs !== undefined &&
      sfuNow.has(identity) &&
      !unpublishedLegs.includes(identity) &&
      (!e2ee || encryptedLegs.has(identity));`,
  );
});

test("🔴 isLeg is the 3-segment isScreenLeg grammar at both sites, never a suffix match (C-f)", () => {
  const isLeg = `const isLeg = isScreenLeg(identity);`;
  assert.equal(countWired(SESSION_CODE, isLeg), 2, `${isLeg} at 2 sites`);
  onceAt("the settle loop", settleLoopBody(), isLeg);
  onceAt("#onAdmitGraceExpiry", expiryBody(), isLeg);
  assert.equal(
    countWired(SESSION_CODE, `.endsWith(":screen")`),
    0,
    "a leg is recognized by suffix somewhere",
  );
});

test("🔴 the expiry re-arms a leg only while it is unpublished with its owner present, a primary only while its admit is in progress (C-d, C-e)", () => {
  const expiry = expiryBody();
  // C-d: only an identity with an OPEN window is asked about.
  const guard = onceAt("#onAdmitGraceExpiry", expiry, `if (!entry) return;`);
  // An absent accessor reads the leg as published, so it never re-arms.
  const unpublished = onceAt(
    "#onAdmitGraceExpiry",
    expiry,
    `const unpublished =
      isLeg && (media?.unpublishedLegs?.() ?? []).includes(identity);`,
  );
  const decide = onceAt(
    "#onAdmitGraceExpiry",
    expiry,
    `const stillEnrolling = shouldRearmAdmitGrace({`,
  );
  const rearm = onceAt(
    "#onAdmitGraceExpiry",
    expiry,
    `if (this.#rearmAdmitGrace(identity, entry, stillEnrolling)) return;`,
  );
  const close = onceAt(
    "#onAdmitGraceExpiry",
    expiry,
    `this.#closeAdmitGrace(identity, entry);`,
  );
  assert.ok(guard < unpublished, "the leg inputs are read before the guard");
  assert.ok(unpublished < decide && decide < rearm && rearm < close);

  const input = bodyAfter(
    "#onAdmitGraceExpiry",
    expiry,
    `shouldRearmAdmitGrace(`,
  );
  // A leg sends no join request: its admit is never "in progress", so the
  // primary's signal must not reach the leg branch.
  for (const property of [
    `isLeg,`,
    `admitInProgress: isLeg ? false : this.#admitInProgress(identity),`,
    `legPublished: !unpublished,`,
    `legOwnerPresent: isLeg && media !== null && legOwnerPresent(`,
  ])
    onceAt("shouldRearmAdmitGrace's input", input, property);
  // The owner check reads the RAW SFU set and counts this device (the
  // sharer's own leg is the most legitimate leg there is).
  assert.deepEqual(
    argumentsOf(bodyAfter("#onAdmitGraceExpiry", expiry, `legOwnerPresent(`)),
    ["identity", "media.sfuParticipants()", `media.localIdentity()??""`],
  );
});

test("🔴 the expiry no longer re-arms on the primary-only admit signal", () => {
  assert.equal(
    countWired(
      SESSION_CODE,
      `this.#rearmAdmitGrace(identity, entry, this.#admitInProgress(identity))`,
    ),
    0,
    "the pre-fix expiry re-arm is back",
  );
  assertWired(
    "the expiry re-arm",
    `if (this.#rearmAdmitGrace(identity, entry, stillEnrolling)) return;`,
  );
});

test("#refreshAdmitGrace is unchanged: the caller's event is the evidence (C-e)", () => {
  assert.equal(
    bodyAfter(
      "mlsCallSession.ts",
      SESSION_CODE,
      `#refreshAdmitGrace(identity: string): void {`,
    ),
    codeOf(
      `const entry = this.#admitGrace.get(identity);
      if (!entry) return;
      this.#rearmAdmitGrace(identity, entry, true)`,
    ),
  );
});

// ---- Behavior ---------------------------------------------------------------

/** What one test's leg accessors report. */
interface LegView {
  unpublished: Set<string>;
  encrypted: Set<string>;
  /** Whether the binding HAS an `unpublishedLegs` accessor right now. */
  unpublishedAccessor: boolean;
}

/** A one-seat call plus the leg view its binding reads. */
interface LegCall {
  world: World;
  legs: LegView;
}

/**
 * Give every binding the session is handed during this test both leg
 * accessors, reading `legs` (the harness's binding implements neither).
 * `unpublishedLegs` is a getter, so a spec can take the accessor away and put
 * it back. The original `bindMedia` is restored when the test ends.
 */
function wrapLegAccessors(t: TestContext, legs: LegView): void {
  const original = MlsCallSession.prototype.bindMedia;
  MlsCallSession.prototype.bindMedia = function (
    this: InstanceType<typeof MlsCallSession>,
    media: MlsMediaBinding,
  ): void {
    media.encryptedLegs = () => [...legs.encrypted];
    Object.defineProperty(media, "unpublishedLegs", {
      configurable: true,
      enumerable: true,
      get: () =>
        legs.unpublishedAccessor ? () => [...legs.unpublished] : undefined,
    });
    original.call(this, media);
  };
  t.after(() => {
    MlsCallSession.prototype.bindMedia = original;
  });
}

/** `bindMedia` as the module defines it, before any test wraps it. */
const ORIGINAL_BIND_MEDIA = MlsCallSession.prototype.bindMedia;

/** The sharer's OWN leg: its owner is this device (`localIdentity`). */
const OWN_LEG = `${SELF_ID}:screen`;
/** The peer's leg: its owner is a remote primary. */
const PEER_LEG = `${PEER_ID}:screen`;

/** A creator's call with `SELF` and `PEER`, settled in `e2ee`. */
async function soloCall(
  t: TestContext,
  channelId: string,
  { unpublishedAccessor = true }: { unpublishedAccessor?: boolean } = {},
): Promise<LegCall> {
  const legs: LegView = {
    unpublished: new Set(),
    encrypted: new Set(),
    unpublishedAccessor,
  };
  wrapLegAccessors(t, legs);
  const world = newWorld(t, "creator", channelId);
  await bringUpCreator(t, world);
  await world.session.reconcileNow();
  await flush();
  await advance(t, 3_000);
  assert.equal(world.session.callMode().kind, "e2ee");
  return { world, legs };
}

/** A leg connects to the SFU with nothing published yet. */
async function legJoins({ world, legs }: LegCall, leg: string): Promise<void> {
  legs.unpublished.add(leg);
  legs.encrypted.delete(leg);
  world.sfu = [...world.sfu, leg];
  world.session.onParticipantJoined(leg);
  await flush();
  await world.session.reconcileNow();
  await flush();
}

/**
 * The leg publishes; `witnessed` says whether its publication is seen
 * encrypted (rule 2(b)). One reconcile observes it.
 */
async function legPublishes(
  { world, legs }: LegCall,
  leg: string,
  witnessed = true,
): Promise<void> {
  legs.unpublished.delete(leg);
  if (witnessed) legs.encrypted.add(leg);
  await world.session.reconcileNow();
  await flush();
}

/** The leg disconnects (the share stopped). */
async function legLeaves({ world, legs }: LegCall, leg: string): Promise<void> {
  legs.unpublished.delete(leg);
  legs.encrypted.delete(leg);
  world.sfu = world.sfu.filter((id) => id !== leg);
  world.session.onParticipantLeft(leg);
  await flush();
}

/** See the header: non-enrolled now, or `mixed` at any point since `mark`. */
async function loud(
  world: World,
  identity: string,
  mark: number,
): Promise<boolean> {
  await world.session.reconcileNow();
  await flush();
  return (
    world.session.nonEnrolled().includes(identity) ||
    world.modes.slice(mark).includes("mixed")
  );
}

/**
 * The leg's NEXT share after a 30 s connect whose spent grace must NOT have
 * been forgiven: rejoin, and it has 30 s of budget left, not a fresh 60 s.
 * Quiet at 25 s, loud by 45 s.
 */
async function nextShareHasOnly30sLeft(
  t: TestContext,
  call: LegCall,
  leg: string,
  why: string,
): Promise<void> {
  const { world } = call;
  await advance(t, 11_000);
  assert.equal(world.session.callMode().kind, "e2ee");
  const mark = world.modes.length;
  await legJoins(call, leg);
  await advance(t, 25_000);
  assert.equal(
    await loud(world, leg, mark),
    false,
    "the next share lapsed inside the 30 s it had left",
  );
  await advance(t, 20_000);
  assert.equal(await loud(world, leg, mark), true, why);
}

test("🔴 E2-2: 25 share start/stop cycles of the sharer's own leg never exhaust its grace", async (t) => {
  const call = await soloCall(t, "ch-leggrace-cycles");
  const { world } = call;
  const mark = world.modes.length;
  // 25 × 4 s of connect→publish is 100 s, well past the 60 s per-call
  // ceiling: without the reset on publish, a cycle in the teens goes loud.
  for (let cycle = 1; cycle <= 25; cycle++) {
    await legJoins(call, OWN_LEG);
    await advance(t, 4_000);
    assert.equal(
      await loud(world, OWN_LEG, mark),
      false,
      `cycle ${cycle}: the leg went loud before it published`,
    );
    await legPublishes(call, OWN_LEG);
    assert.equal(
      await loud(world, OWN_LEG, mark),
      false,
      `cycle ${cycle}: the leg went loud after it published`,
    );
    await advance(t, 1_000);
    await legLeaves(call, OWN_LEG);
    await advance(t, 11_000);
  }
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.deepEqual(world.modes.slice(mark), [], "the call mode moved");
});

test("🔴 E2-3: a slow leg (unpublished, its owner this device) re-arms past its first window and still lapses at the 60 s cap", async (t) => {
  const call = await soloCall(t, "ch-leggrace-slow");
  const { world } = call;
  const mark = world.modes.length;
  await legJoins(call, OWN_LEG);
  // The first window is 14 s (10 s base + 2 primaries × 2 s stagger).
  await advance(t, 30_000);
  assert.equal(
    await loud(world, OWN_LEG, mark),
    false,
    "the slow leg lapsed at its first window",
  );
  await advance(t, 32_000);
  assert.equal(
    await loud(world, OWN_LEG, mark),
    true,
    "a leg that never publishes outlived the 60 s cap",
  );
});

test("🔴 C-a: the stretch billed at publish is forgiven, so the next share gets the full budget", async (t) => {
  const call = await soloCall(t, "ch-leggrace-forgive");
  const { world } = call;
  const mark = world.modes.length;
  await legJoins(call, OWN_LEG);
  await advance(t, 30_000);
  assert.equal(
    await loud(world, OWN_LEG, mark),
    false,
    "the first connect lapsed",
  );
  // The publish reconcile settles (bills) the 30 s and resets the ledger in
  // the same pass; the leg leaves before any later reconcile could reset it.
  await legPublishes(call, OWN_LEG);
  await legLeaves(call, OWN_LEG);
  await advance(t, 11_000);
  await legJoins(call, OWN_LEG);
  // 45 s fits a fresh 60 s budget, not the 30 s left had the stretch stuck.
  await advance(t, 45_000);
  assert.equal(
    await loud(world, OWN_LEG, mark),
    false,
    "the second connect lapsed: the first stretch was not forgiven",
  );
});

// The forgiveness is fail-closed: each spec below reaches the reconcile that
// settles a 30 s connect with ONE of `seenPublished`'s conjuncts false and
// the rest true, so only that conjunct stands between the leg and a reset.
// The leg leaves right after it, before any later reconcile could look again,
// and its next share must find the 30 s still spent.

test("🔴 C-b: a publication nothing witnessed encrypted (e2ee) forgives nothing", async (t) => {
  const call = await soloCall(t, "ch-leggrace-unwitnessed");
  const { world } = call;
  const mark = world.modes.length;
  await legJoins(call, OWN_LEG);
  await advance(t, 30_000);
  assert.equal(await loud(world, OWN_LEG, mark), false, "the connect lapsed");
  // Published, in the SFU, listed nowhere as unpublished, but NOT in
  // `encryptedLegs`. Rule 2(b) declares the mix in this very reconcile
  // (the settle loop reads the call mode before the reconcile moves it).
  await legPublishes(call, OWN_LEG, false);
  await legLeaves(call, OWN_LEG);
  assert.ok(
    world.modes.slice(mark).includes("mixed"),
    "an unwitnessed leg publication did not declare the mix",
  );
  // The mix clears once the leg is gone: the re-upgrade hysteresis is 15 s.
  await advance(t, 20_000);
  await nextShareHasOnly30sLeft(
    t,
    call,
    OWN_LEG,
    "an unwitnessed publication forgave the leg's spent grace",
  );
});

test("🔴 C-b: a leg already gone from the SFU set forgives nothing, even with a stale encrypted witness", async (t) => {
  const call = await soloCall(t, "ch-leggrace-gone");
  const { world, legs } = call;
  const mark = world.modes.length;
  await legJoins(call, OWN_LEG);
  await advance(t, 30_000);
  assert.equal(await loud(world, OWN_LEG, mark), false, "the connect lapsed");
  // The leg dropped out of the SFU set before its leave event, and the only
  // thing still vouching for it is an encrypted witness that outlived it.
  world.sfu = world.sfu.filter((id) => id !== OWN_LEG);
  legs.unpublished.delete(OWN_LEG);
  legs.encrypted.add(OWN_LEG);
  await world.session.reconcileNow();
  await flush();
  await legLeaves(call, OWN_LEG);
  await nextShareHasOnly30sLeft(
    t,
    call,
    OWN_LEG,
    "a leg absent from the SFU set was forgiven its spent grace",
  );
});

test("🔴 C-b: a binding without an unpublishedLegs accessor at the settle forgives nothing", async (t) => {
  const call = await soloCall(t, "ch-leggrace-no-accessor-at-settle");
  const { world, legs } = call;
  const mark = world.modes.length;
  await legJoins(call, OWN_LEG);
  await advance(t, 30_000);
  assert.equal(await loud(world, OWN_LEG, mark), false, "the connect lapsed");
  // Witnessed encrypted and in the SFU, but the binding cannot say whether
  // it is published. Absent must not read as "published".
  legs.unpublishedAccessor = false;
  await legPublishes(call, OWN_LEG);
  await legLeaves(call, OWN_LEG);
  legs.unpublishedAccessor = true;
  await nextShareHasOnly30sLeft(
    t,
    call,
    OWN_LEG,
    "an absent unpublishedLegs accessor was read as published",
  );
});

test("with no unpublishedLegs accessor at all, an unpublished leg gets no grace, so it has no budget to spend", async (t) => {
  const call = await soloCall(t, "ch-leggrace-no-accessor", {
    unpublishedAccessor: false,
  });
  const { world } = call;
  const mark = world.modes.length;
  await legJoins(call, OWN_LEG);
  assert.equal(
    await loud(world, OWN_LEG, mark),
    true,
    "an unpublished leg was graced with no accessor to say it is unpublished",
  );
});

test("🔴 an orphan leg (its owner gone when its window expires) is not re-armed: it lapses at the first expiry", async (t) => {
  const call = await soloCall(t, "ch-leggrace-orphan");
  const { world } = call;
  const mark = world.modes.length;
  await legJoins(call, PEER_LEG);
  assert.equal(
    await loud(world, PEER_LEG, mark),
    false,
    "the peer's leg went loud while its owner was present",
  );
  // The owner drops out of the SFU set across the expiry (14 s after the
  // leg joined), with no leave event and no reconcile of its own: only the
  // expiry's owner check can see it. It is back before the next look.
  await advance(t, 13_000);
  const present = world.sfu;
  world.sfu = present.filter((id) => id !== PEER_ID);
  await advance(t, 1_500);
  world.sfu = present;
  assert.equal(
    await loud(world, PEER_LEG, mark),
    true,
    "an orphan leg's window re-armed at its expiry",
  );
});

test("🔴 a primary nothing is admitting lapses at its first expiry (C-e)", async (t) => {
  const { world } = await soloCall(t, "ch-leggrace-primary-idle");
  const mark = world.modes.length;
  world.sfu = [...world.sfu, THIRD_ID];
  world.session.onParticipantJoined(THIRD_ID);
  await flush();
  // The window is 16 s (10 s base + 3 primaries × 2 s stagger).
  await advance(t, 15_000);
  assert.equal(
    await loud(world, THIRD_ID, mark),
    false,
    "the joiner went loud inside its window",
  );
  await advance(t, 2_000);
  assert.equal(
    await loud(world, THIRD_ID, mark),
    true,
    "a joiner with no admit in progress was re-armed",
  );
});

test("🔴 a primary whose admit is in flight re-arms past its first expiry (C-e)", async (t) => {
  const { world } = await soloCall(t, "ch-leggrace-primary-admit");
  const mark = world.modes.length;
  world.sfu = [...world.sfu, THIRD_ID];
  world.session.onParticipantJoined(THIRD_ID);
  await flush();
  // Its join request reaches this device, whose admit starts by fetching the
  // joiner's signed listing. Held, the admit stays scheduled (in progress)
  // until the spec releases it.
  const release = world.holdReconcileRoster();
  t.after(release);
  await world.joinRequest(THIRD);
  await advance(t, 30_000);
  assert.equal(
    await loud(world, THIRD_ID, mark),
    false,
    "a joiner whose admit was in flight lapsed at its first window",
  );
  await advance(t, 32_000);
  assert.equal(
    await loud(world, THIRD_ID, mark),
    true,
    "a joiner whose admit never finished outlived the 60 s cap",
  );
});

test("every wrap of bindMedia was restored: nothing leaks past its test", () => {
  assert.equal(MlsCallSession.prototype.bindMedia, ORIGINAL_BIND_MEDIA);
});

// The screen leg in the E2EE call roster, as `mlsCallSession.ts` wires it —
// run with Node's built-in runner, from packages/client:
//   node --test --conditions=browser components/rtc/mlsCallSession.leggrace.test.ts
//
// A screen leg (`<user>:<device>:screen`) never sends a join request. The
// session still opens an admit-grace window when one connects, re-arms it
// while the leg is unpublished with its owner present, bills it against the
// per-call ledger and forgives that ledger once the leg is seen published.
// The decisions live in `mlsAdmitGracePolicy.ts` (`admitGraceLedgerResets`,
// `shouldRearmAdmitGrace`, `legOwnerPresent`), where their own specs hold
// them. Since C6 (`reconcileRoster` in `mlsRosterPolicy.ts`) none of that
// decides a leg's verdict: a leg is never `pending`, and an unfolded leg
// with ZERO publications whose owner is present (or is this device) is
// INERT, in neither `nonEnrolled` nor `pending`, windowed or not. Every
// other unfolded leg is loud at once: one with a publication nothing
// witnessed encrypted, an ORPHAN (its owner absent), and one the binding
// cannot vouch for as unpublished (no `unpublishedLegs` accessor). The leg
// machinery stays in the session until a follow-up retires it, so this file
// holds the session two ways:
//
//  - SOURCE PINS over `mlsCallSession.ts`, matched as TEXT after `codeOf`
//    (`sourcePins.harness.ts`), for the inputs each call is handed and the
//    order of the settle loop (bill THEN reset). They have the limits
//    `stateWiring.test.ts` lists: the same text in dead code satisfies a pin,
//    and an equivalent rewrite (a renamed local, braces around a one-line
//    `if`) breaks one. Changing one of these sites on purpose means changing
//    its pin here too. For a leg's ledger they are now the ONLY guard in this
//    file: no verdict reads that ledger, so no behavior spec can see it.
//  - BEHAVIOR through the real session on the `mlsCallSession.harness.ts`
//    world. The harness's binding implements neither leg accessor, so this
//    file adds both (`encryptedLegs`, `unpublishedLegs`) by wrapping
//    `bindMedia` for each test (restored when the test ends), and a spec
//    moves a leg through join, publish, a server-forced unpublish and leave
//    by hand. The leg specs pin C6 end to end: the join→publish gap and a
//    server-forced unpublish (F-W3-2: a Video revoke or an AFK designation
//    leaves the leg in the room with nothing published and no window) are
//    quiet for the sharer's own leg and for a peer's; a plaintext
//    publication, an orphan and a binding with no accessor stay loud. The
//    primary specs (C-e) still exercise the window itself. What C6 made
//    vacuous is listed under "Weakened assertions" below, never dropped
//    silently.
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
 * The server force-unpublishes the leg (F-W3-2: a moderator's Video revoke,
 * or an AFK designation, pushes the leg a grant without publish and the SFU
 * drops its only track). The leg stays in the SFU set with ZERO
 * publications, so it leaves `encryptedLegs` (livekit's `isEncrypted` needs
 * a publication) and joins `unpublishedLegs`. One reconcile observes it.
 */
async function legForceUnpublished(
  { world, legs }: LegCall,
  leg: string,
): Promise<void> {
  assert.ok(world.sfu.includes(leg), `${leg} is not in the SFU set`);
  legs.encrypted.delete(leg);
  legs.unpublished.add(leg);
  await world.session.reconcileNow();
  await flush();
}

/** What a spec reads "since": the call mode and publish-gate history. */
interface Marks {
  mark: number;
  gateMark: number;
  gate: string[];
}

/**
 * The leg joins, publishes encrypted (it folds onto its owner, and its
 * window closes at the first expiry: a published leg is never re-armed),
 * then the call runs well past that window AND the 60 s per-call cap, so no
 * admit grace covers the leg any more. Returns the marks taken after.
 */
async function publishedLongAgo(
  t: TestContext,
  call: LegCall,
  leg: string,
): Promise<Marks> {
  const { world } = call;
  await legJoins(call, leg);
  await advance(t, 2_000);
  await legPublishes(call, leg);
  await advance(t, 75_000);
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.ok(
    !world.session.nonEnrolled().includes(leg),
    "the published leg was non-enrolled before the unpublish",
  );
  return {
    mark: world.modes.length,
    gateMark: world.gateLog.length,
    gate: [...world.gate].sort(),
  };
}

/**
 * F-W3-2 for one leg: published long ago, then force-unpublished, it stays
 * INERT through 12 s of reconciles (one a second, on top of the session's
 * own 5 s tick): never non-enrolled, never pending, the call never leaves
 * `e2ee`, the publish gate gains no reason, and the session's own
 * enable/resume precondition still holds.
 */
async function forcedUnpublishIsInert(
  t: TestContext,
  channelId: string,
  leg: string,
): Promise<void> {
  const call = await soloCall(t, channelId);
  const { world } = call;
  const { mark, gateMark, gate } = await publishedLongAgo(t, call, leg);
  await legForceUnpublished(call, leg);
  // Checked every second, not only at the end: once the call is `mixed`,
  // rule 2(b) is off and the leg folds, so a later reconcile no longer
  // names it (the header's "loud").
  assert.deepEqual(world.modes.slice(mark), [], "the unpublish moved the mode");
  for (let second = 1; second <= 12; second++) {
    await advance(t, 1_000);
    const result = await world.session.reconcileNow();
    await flush();
    assert.ok(result, `${second} s after the unpublish: no reconcile ran`);
    assert.ok(
      !result.nonEnrolled.includes(leg),
      `${second} s after the unpublish: the leg was reported non-enrolled`,
    );
    assert.deepEqual(
      world.modes.slice(mark),
      [],
      `${second} s after the unpublish: the call mode moved`,
    );
    // Pending is not loud, but it is not consistent either: it would hold
    // enable, resume, re-upgrade and heal for as long as the SFU kept the
    // leg in the room (the rejected "A2" mechanism).
    assert.ok(
      !result.pending.includes(leg),
      `${second} s after the unpublish: the leg was reported pending`,
    );
  }
  assert.ok(world.sfu.includes(leg), "the leg left the SFU set");
  assert.equal(await loud(world, leg, mark), false, "the leg went loud");
  assert.deepEqual(world.modes.slice(mark), [], "the call mode moved");
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.deepEqual(
    world.gateLog.slice(gateMark).filter((edge) => edge.startsWith("+")),
    [],
    "a publish-gate pause reason was added",
  );
  assert.deepEqual([...world.gate].sort(), gate, "the publish gate moved");
  // Both lists empty: what enable/resume wait on.
  assert.equal(
    await world.session.rosterConsistent(),
    true,
    "the force-unpublished leg holds the roster inconsistent",
  );
}

// ---- Weakened assertions (wave 4, C6) ---------------------------------------
//
// C6 left a leg's admit-grace windows and ledger deciding no verdict, so
// every spec that proved them THROUGH a leg's verdict lost its proof. Each
// is recorded here:
//
//  - E2-3 used to prove a liveness bound: a leg that never publishes is
//    re-armed past its first window but goes loud at the 60 s cap. Under C6
//    an unpublished leg with its owner present is inert for as long as it
//    stays that way, so the bound is gone by design (residual R9). The only
//    bound left is native: the plugin's revoke/unpublish teardown (C8,
//    `ScreenSharePlugin.kt`), which nothing here can observe, and which
//    v0.64 builds lack. RESTATED below to the new contract (quiet past the
//    cap, never pending). The re-arm decision itself is still held by
//    `mlsAdmitGracePolicy.test.ts` ("an unpublished leg with its owner
//    present re-arms (E2-3)", "a slow leg re-arms while unpublished and
//    lapses once published (E2-3)") and by the expiry source pin above
//    (C-d, C-e).
//  - The three C-b specs used to prove that each conjunct of `seenPublished`
//    (an e2ee witness; presence in the SFU set; an `unpublishedLegs`
//    accessor at all) stands alone between a leg and a ledger reset, by
//    showing the leg's NEXT share lapsing with only 30 s of budget left
//    (their helper `nextShareHasOnly30sLeft` is gone with them). Under C6
//    that next share's unpublished gap is inert whatever the ledger holds,
//    so the ledger cannot be seen through a verdict and none of the three
//    can go red here. The conjuncts stay held as TEXT by "seenPublished
//    fails CLOSED ... (C-b)" above, and the reset decision by
//    `mlsAdmitGracePolicy.test.ts` ("a published leg's ledger resets", "an
//    unpublished leg keeps its spent grace", "a published plaintext leg is
//    neither forgiven nor re-armed"). Per spec:
//     - the e2ee witness: RESTATED to what is still true. A publication
//       nothing witnessed encrypted is loud at once, inside the leg's open
//       window, and again on its next share.
//     - presence in the SFU set: DELETED. A leg gone from the SFU set is not
//       reconciled at all, so no behavior is left to restate; the text pin
//       above is its only replacement.
//     - the accessor: RESTATED. With no `unpublishedLegs` accessor, a
//       force-unpublished leg is loud: C6's inertness rests on the binding
//       vouching for zero publications. The join-time spec ("with no
//       unpublishedLegs accessor at all ...") is kept beside it.
//  - E2-2 and C-a keep their assertions but not their premise. They were
//    written to prove the ledger reset on publish (E2-2's 25 cycles exceed
//    the 60 s ceiling; C-a's second share needs a forgiven 30 s), and under
//    C6 they pass with no reset at all. What they pin now is that the own
//    leg's join→publish gap is quiet however often, and however slowly, it
//    repeats: both go red at once if C6's skip is lost, since a leg is never
//    `pending`. The reset itself: the "bills THEN resets" source pin above
//    and `mlsAdmitGracePolicy.test.ts` ("a phone that shares over and over
//    never runs out of grace (E2-2)").
//
// The roster decision these specs drive end to end is held directly by
// `rosterReconcile.test.ts` (an unpublished leg whose owner is present, or
// is this device, is in neither list, windowed or not; an orphan, a bare
// leg and a published-plaintext leg stay non-enrolled).

test("🔴 F-W3-2: the sharer's OWN leg, force-unpublished long after it published, stays in the room quiet: never non-enrolled or pending, no mixed, no pause", async (t) => {
  await forcedUnpublishIsInert(t, "ch-leggrace-fw32-own", OWN_LEG);
});

test("🔴 F-W3-2: a PEER's leg (its owner enrolled and present), force-unpublished long after it published, stays in the room quiet", async (t) => {
  await forcedUnpublishIsInert(t, "ch-leggrace-fw32-peer", PEER_LEG);
});

test("🔴 E2-2: 25 share start/stop cycles of the sharer's own leg never go loud", async (t) => {
  const call = await soloCall(t, "ch-leggrace-cycles");
  const { world } = call;
  const mark = world.modes.length;
  // 25 × 4 s of connect→publish is 100 s, well past the 60 s per-call
  // ceiling. Written for the ledger reset on publish; under C6 the gap is
  // inert and the ledger decides nothing (see "Weakened assertions").
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

// RESTATED under C6 (see "Weakened assertions"): it used to go loud at the
// 60 s cap.
test("🔴 E2-3: a slow leg (unpublished, its owner this device) is inert past its first window and past the 60 s cap: never loud, never pending", async (t) => {
  const call = await soloCall(t, "ch-leggrace-slow");
  const { world } = call;
  const mark = world.modes.length;
  await legJoins(call, OWN_LEG);
  // The first window is 14 s (10 s base + 2 primaries × 2 s stagger).
  await advance(t, 30_000);
  assert.equal(
    await loud(world, OWN_LEG, mark),
    false,
    "the slow leg went loud past its first window",
  );
  await advance(t, 32_000);
  assert.equal(
    await loud(world, OWN_LEG, mark),
    false,
    "the slow leg went loud past the 60 s cap",
  );
  const result = await world.session.reconcileNow();
  await flush();
  assert.ok(result, "no reconcile ran");
  assert.ok(!result.pending.includes(OWN_LEG), "the slow leg is pending");
  assert.equal(
    await world.session.rosterConsistent(),
    true,
    "the slow leg holds the roster inconsistent",
  );
  assert.deepEqual(world.modes.slice(mark), [], "the call mode moved");
});

test("🔴 C-a: a second slow share after a slow first one is quiet too, whatever the first left in the ledger", async (t) => {
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
  // Written for the forgiveness: the publish reconcile settles (bills) the
  // 30 s and resets the ledger in the same pass, and the leg leaves before
  // any later reconcile could reset it. Under C6 the second connect is
  // inert whatever the ledger holds (see "Weakened assertions").
  await legPublishes(call, OWN_LEG);
  await legLeaves(call, OWN_LEG);
  await advance(t, 11_000);
  await legJoins(call, OWN_LEG);
  // 45 s: past the 30 s a stuck stretch would have left.
  await advance(t, 45_000);
  assert.equal(
    await loud(world, OWN_LEG, mark),
    false,
    "the second connect went loud",
  );
});

// RESTATED under C6 (see "Weakened assertions"): it used to prove the e2ee
// witness alone kept the ledger from resetting.
test("🔴 C-b: a leg publication nothing witnessed encrypted (e2ee) is loud at once, inside the leg's open window, and again on its next share", async (t) => {
  const call = await soloCall(t, "ch-leggrace-unwitnessed");
  const { world } = call;
  const mark = world.modes.length;
  await legJoins(call, OWN_LEG);
  await advance(t, 30_000);
  assert.equal(
    await loud(world, OWN_LEG, mark),
    false,
    "the unpublished leg went loud",
  );
  // Published, in the SFU, listed nowhere as unpublished, but NOT in
  // `encryptedLegs`, while its window is still open (re-armed while it sat
  // unpublished with its owner present). A leg is never `pending`, so rule
  // 2(b) declares the mix in this very reconcile.
  await legPublishes(call, OWN_LEG, false);
  assert.ok(
    world.modes.slice(mark).includes("mixed"),
    "an unwitnessed leg publication did not declare the mix",
  );
  await legLeaves(call, OWN_LEG);
  // The mix clears once the leg is gone: the re-upgrade hysteresis is 15 s.
  await advance(t, 31_000);
  assert.equal(world.session.callMode().kind, "e2ee");
  // The next share: its unpublished gap is inert whatever the first share
  // left in the ledger, and its plaintext publication is loud again.
  const next = world.modes.length;
  await legJoins(call, OWN_LEG);
  await advance(t, 25_000);
  assert.equal(
    await loud(world, OWN_LEG, next),
    false,
    "the next share's unpublished gap went loud",
  );
  await legPublishes(call, OWN_LEG, false);
  assert.ok(
    world.modes.slice(next).includes("mixed"),
    "the next share's unwitnessed publication did not declare the mix",
  );
});

// C-b "a leg already gone from the SFU set forgives nothing, even with a
// stale encrypted witness": DELETED under C6, see "Weakened assertions".

// RESTATED under C6 (see "Weakened assertions"): it used to prove an absent
// accessor at the settle kept the ledger from resetting.
test("🔴 C-b: a force-unpublished leg the binding cannot vouch for (no unpublishedLegs accessor) is loud", async (t) => {
  const call = await soloCall(t, "ch-leggrace-no-accessor-at-settle");
  const { world, legs } = call;
  const { mark } = await publishedLongAgo(t, call, OWN_LEG);
  // F-W3-2's world, but the binding can no longer say the leg has nothing
  // published. Absent must not read as "unpublished": the session hands the
  // policy `[]`, and an unfolded leg with nothing vouching for it is loud.
  legs.unpublishedAccessor = false;
  await legForceUnpublished(call, OWN_LEG);
  assert.equal(
    await loud(world, OWN_LEG, mark),
    true,
    "an absent unpublishedLegs accessor was read as unpublished",
  );
});

// Unchanged by C6. Still loud because the session hands the policy
// `media.unpublishedLegs?.() ?? []`: with no accessor nothing vouches for
// the leg's zero publications, so C6's skip never applies and a leg is
// never pending.
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

// Why the orphan is still loud under C6 (re-derived in wave 4). The window
// no longer decides the verdict; the roster policy does, on every
// reconcile. With its owner absent from the RAW SFU set (and not this
// device) the leg fails rule 2(a) and stays unfolded, it is not in the MLS
// group, it is device-qualified, and it FAILS C6's owner test, so it is not
// inert; a leg is never `pending`, so it lands in `nonEnrolled` and the
// call goes `mixed`. The 1.5 s gap below holds exactly ONE reconcile
// (measured: the session's 5 s tick lands either side of it): the one the
// expiry kicks after it CLOSES the window (`#onAdmitGraceExpiry` →
// `reconcileNow`). A re-arm returns before that reconcile, so this spec
// also still pins that the expiry closes an orphan's window rather than
// re-arming it, but the verdict is C6's. The owner is back before the final
// look, where the leg is inert again, so "loud" there is the `mixed` already
// declared (the header's witness); the check inside the gap shows which
// reconcile declared it.
test("🔴 an orphan leg (its owner gone when its window expires) is loud: the expiry closes its window and the reconcile it kicks reports it non-enrolled", async (t) => {
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
  // expiry's reconcile can see it. It is back before the next look.
  await advance(t, 13_000);
  const present = world.sfu;
  world.sfu = present.filter((id) => id !== PEER_ID);
  await advance(t, 1_500);
  assert.ok(
    world.session.nonEnrolled().includes(PEER_LEG),
    "no reconcile inside the owner's absence reported the orphan non-enrolled",
  );
  world.sfu = present;
  assert.equal(
    await loud(world, PEER_LEG, mark),
    true,
    "an orphan leg's window re-armed at its expiry",
  );
});

/** The session's periodic reconcile tick, read from its source (private there). */
const RECONCILE_INTERVAL_MS = (() => {
  const found = /const RECONCILE_INTERVAL_MS = ([\d_]+);/.exec(SESSION_SOURCE);
  assert.ok(
    found,
    "mlsCallSession.ts no longer declares RECONCILE_INTERVAL_MS",
  );
  return Number(found[1].replaceAll("_", ""));
})();

/**
 * The session-level guard for §5.4 orphan loudness, independent of any admit
 * window. The spec above holds the orphan only through the ONE reconcile its
 * window's expiry kicks inside a 1.5 s gap, which is a timing artifact. Here
 * the leg's window closed long ago (`publishedLongAgo`), no join event opens
 * another, and nothing but the session's own periodic tick reconciles: the
 * owner leaves the SFU set (no leave event) and stays gone across at least
 * two ticks. The leg must be reported non-enrolled and the call must go and
 * stay `mixed`. Once `mixed`, rule 2(b) is off, but an orphan fails rule 2(a)
 * and never folds, so non-enrolled stays a stable witness here. The same
 * unpublished leg with its owner present is the F-W3-2 peer spec above, inert.
 */
async function orphanStaysLoud(
  t: TestContext,
  channelId: string,
  publication: "none" | "encrypted" | "plaintext",
): Promise<void> {
  const call = await soloCall(t, channelId);
  const { world, legs } = call;
  const { mark } = await publishedLongAgo(t, call, PEER_LEG);
  const session = world.session;
  const reconcileNow = session.reconcileNow;
  let reconciles = 0;
  session.reconcileNow = function (this: typeof session) {
    reconciles++;
    return reconcileNow.call(this);
  };
  // No reconcile of the spec's own from here on: only the tick can see this.
  if (publication !== "encrypted") legs.encrypted.delete(PEER_LEG);
  if (publication === "none") legs.unpublished.add(PEER_LEG);
  world.sfu = world.sfu.filter((id) => id !== PEER_ID);
  await advance(t, 2 * RECONCILE_INTERVAL_MS + 1_000);
  assert.ok(reconciles >= 2, `only ${reconciles} periodic reconcile(s) ran`);
  assert.ok(world.sfu.includes(PEER_LEG), "the leg left the SFU set");
  assert.ok(
    session.nonEnrolled().includes(PEER_LEG),
    "the periodic tick did not report the orphan leg non-enrolled",
  );
  assert.ok(
    world.modes.slice(mark).includes("mixed"),
    "the orphan leg did not declare the mix",
  );
  assert.equal(session.callMode().kind, "mixed");
  // And it stays loud on the next tick.
  const before = reconciles;
  await advance(t, RECONCILE_INTERVAL_MS);
  assert.ok(reconciles > before, "no periodic reconcile ran on the next tick");
  assert.ok(
    session.nonEnrolled().includes(PEER_LEG),
    "the orphan leg was not non-enrolled on the next tick",
  );
  assert.equal(session.callMode().kind, "mixed", "the call left mixed");
}

test("🔴 §5.4 steady state: an UNPUBLISHED orphan leg, its owner gone across two periodic ticks and no window open, is non-enrolled and the call stays mixed", async (t) => {
  await orphanStaysLoud(t, "ch-leggrace-orphan-steady-unpublished", "none");
});

// Rule 2(a) alone makes this one loud: the leg's publication is witnessed
// encrypted, so only its absent owner keeps it from folding.
test("🔴 §5.4 steady state: an orphan leg publishing ENCRYPTED, its owner gone across two periodic ticks, is non-enrolled and the call stays mixed", async (t) => {
  await orphanStaysLoud(t, "ch-leggrace-orphan-steady-encrypted", "encrypted");
});

test("§5.4 steady state: an orphan leg publishing plaintext, its owner gone across two periodic ticks, is non-enrolled and the call stays mixed", async (t) => {
  await orphanStaysLoud(t, "ch-leggrace-orphan-steady-plaintext", "plaintext");
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

// Source pins for `state.tsx`'s voice-move, chip and Android screen-leg wiring
// — run with Node's built-in runner, from packages/client:
//   node --test --conditions=browser components/rtc/stateWiring.test.ts
// `node --test` cannot load `state.tsx` (Solid JSX, livekit), so the decisions
// live in `voiceMovePolicy.ts`, `chipInputs.ts` and `androidLegStartPolicy.ts`,
// where their own specs hold them, and this file holds `state.tsx` to CALLING
// them with the right inputs.
// Each pin is one load-bearing statement, matched as TEXT after `codeOf`
// (`sourcePins.harness.ts`): comments and whitespace are ignored, so a
// commented-out copy never satisfies a pin and a prettier reflow never breaks
// one. `rtc-mutations.py` proves each pin kills its wiring mutation (the
// `state-*` entries).
//
// Known limits, the same as `screenShareWatchPolicy.test.ts`'s pins:
//  - the same text put in dead code (`if (false) { ... }`) still satisfies a
//    pin;
//  - parentheses prettier adds or removes, and a statement rewritten into an
//    equivalent form (braces around a one-line `if`, a renamed local), break
//    a pin without changing behavior. Changing one of these sites on purpose
//    means changing its pin here too;
//  - the lexer does not read regex literals or JSX text (see the harness); the
//    first test fails on the usual sign that one made it lose its place (a
//    quoted string running across a line, or a comment kept).
// Removing logs and editing comments never breaks a pin; adding a statement
// inside a pinned span does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  argumentsOf,
  assertLexesInSync,
  assertLogsOnly,
  bodiesAfter,
  closerOf,
  codeOf,
  consoleCallsIn,
  countWired,
  isStringLiteral,
  wiredAsserter,
  wiredAt,
} from "./sourcePins.harness.ts";

const STATE_SOURCE = readFileSync(
  new URL("./state.tsx", import.meta.url),
  "utf8",
);
const STATE_CODE = codeOf(STATE_SOURCE);

/** `snippet` must appear exactly once in state.tsx's code. */
const assertWired = wiredAsserter("state.tsx", STATE_CODE);

/** The inside of the ONE block or argument list `head` opens. */
function bodyAfter(code: string, head: string): string {
  const bodies = bodiesAfter(code, head);
  assert.equal(
    bodies.length,
    1,
    `state.tsx must contain this exactly once, found ${bodies.length}:\n` +
      codeOf(head),
  );
  return bodies[0];
}

/**
 * The ONE body `head` opens, give or take the parentheses prettier wraps a
 * long `return` in.
 */
function bodyOf(head: string): string {
  return bodyAfter(STATE_CODE, head).replace(/^return\((.*)\)$/s, "return$1");
}

/** Where `snippet` first occurs in `code`, which must hold it. */
function firstAt(what: string, code: string, snippet: string): number {
  const [at] = wiredAt(code, snippet);
  assert.ok(at !== undefined, `${what}: ${codeOf(snippet)}`);
  return at;
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

/** `#handleVoiceMove`'s body: the one handler for a server-ordered move. */
function handleMove(): string {
  return bodyAfter(
    STATE_CODE,
    `async #handleVoiceMove(move: VoiceMoveRequest): Promise<void> {`,
  );
}

/** `connect()`'s body. */
function connectBody(): string {
  return bodyAfter(
    STATE_CODE,
    `async connect(
      channel: Channel,
      auth?: { url: string; token: string },
      opts?: {
        movePreConnectBudgetMs?: number;
        rejoinAttempt?: boolean;
        moveLatchBypass?: boolean;
      },
    ): Promise<boolean> {`,
  );
}

/** `#connectAttempt`'s body, where M3 and the Room dial live. */
function connectAttempt(): string {
  return bodyAfter(
    STATE_CODE,
    `async #connectAttempt(
      channel: Channel,
      auth?: { url: string; token: string },
      opts?: {
        movePreConnectBudgetMs?: number;
        rejoinAttempt?: boolean;
        moveLatchBypass?: boolean;
      },
      bypassedRefusal?: JoinRefusalReason,
    ): Promise<boolean> {`,
  );
}

/**
 * Every write to a variable named `auth` in `code` (put through `codeOf`), a
 * declaration of a new one included, as the text of the write up to its
 * first `;` or `(`.
 */
function authWritesIn(code: string): string[] {
  return [
    ...code.matchAll(
      /(?<![\w$.#])((?:const|let|var)?auth)(\?\?=|\|\|=|&&=|=(?![=>]))/g,
    ),
  ].map((m) => {
    const rest = code.slice(m.index + m[0].length).match(/^[^;(]*\(?/);
    return m[0] + (rest?.[0] ?? "");
  });
}

test("source pin: state.tsx lexes in sync, and its comments are stripped", () => {
  assertLexesInSync("state.tsx", STATE_SOURCE, STATE_CODE, 100);
});

test("source pin: a pin's trimmed , or ; still ends it", () => {
  const needle = `track.setSubscribed(true);`;
  // The file's `;` is gone when a `}` follows, and kept before a statement.
  for (const code of [
    `for (const track of ts) { track.setSubscribed(true); }`,
    `track.setSubscribed(true); next();`,
    `track.setSubscribed(true)`,
    `f(track.setSubscribed(true))`,
  ])
    assert.equal(countWired(codeOf(code), needle), 1, code);
  // Anything appended to the expression is not the pinned statement.
  for (const code of [
    `track.setSubscribed(true) || true;`,
    `track.setSubscribed(true).then(next);`,
    `track.setSubscribed(true)[0];`,
  ])
    assert.equal(countWired(codeOf(code), needle), 0, code);
  assert.equal(
    countWired(codeOf(`id = p.identity.split(":")[0];`), `id = p.identity;`),
    0,
  );
  // The same for a trimmed `,` in an object literal.
  assert.equal(countWired(codeOf(`f({ a, b })`), `a,`), 1);
  assert.equal(countWired(codeOf(`f({ a: g(), b })`), `a,`), 0);
  // A needle ending in anything else is not anchored, and counts do not
  // overlap.
  assert.equal(countWired(codeOf(`g(1) || f(2)`), `g(`), 1);
  assert.equal(countWired(`aaaa`, `aa`), 2);
  assert.deepEqual(wiredAt(codeOf(`x; a; a,b`), `a;`), [2, 4]);
});

test("source pin: the block reader skips strings and stops at its own closer", () => {
  const code = codeOf(`run(() => { a("}"); if (x) { b(")"); } c(); }); g();`);
  assert.deepEqual(bodiesAfter(code, `run(() => {`), [
    codeOf(`a("}"); if (x) { b(")"); } c()`),
  ]);
  assert.deepEqual(bodiesAfter(code, `run(`), [
    codeOf(`() => { a("}"); if (x) { b(")"); } c(); }`),
  ]);
  assert.deepEqual(bodiesAfter(code, `h(`), []);
  // A head is matched as text, so it also matches inside a longer name.
  assert.equal(bodiesAfter(code, `n(`).length, 1);
});

test("source pin: the log reader sees every argument, and only a fixed string passes", () => {
  const code = codeOf(
    `console.warn("a, b", err); f(console.error); console.info(\`x\${y}\`);
    console.debug('ok', \`fine\`, g(1, [2, 3]));`,
  );
  assert.deepEqual(
    consoleCallsIn(code).map(({ args }) => args),
    [[`"a, b"`, `err`], ["`x${y}`"], [`'ok'`, "`fine`", `g(1,[2,3])`]],
  );
  assert.deepEqual(argumentsOf(``), []);
  assert.deepEqual(
    [`"a"`, `'b'`, "`c`", "`$d`", "`${e}`", `err`, `"a"+err`, `""`].map(
      isStringLiteral,
    ),
    [true, true, true, true, false, false, false, true],
  );
  assertLogsOnly("fixed", codeOf(`console.warn("[rtc] a", 'b');`));
  assertLogsOnly("allowed", codeOf(`console.warn("k:", kind);`), ["kind"]);
  for (const bad of [
    `console.warn("a", err);`,
    `console.warn(\`a \${err}\`);`,
    `p.catch(console.error);`,
    `console.warn("k:", kind, err);`,
  ])
    assert.throws(
      () => assertLogsOnly("bad", codeOf(bad), ["kind"]),
      assert.AssertionError,
      bad,
    );
});

test("source pin: the auth-write reader sees writes and declarations, not reads", () => {
  assert.deepEqual(
    authWritesIn(
      codeOf(`if (!auth) { auth = await channel.joinCall(node); }
      const x = auth !== undefined; y = !!auth && auth.token;
      case "join": auth = undefined; break;
      const auth = other; auth ??= z(); preMintedAuth = 1; o.auth = 2;
      const f = (auth) => auth;`),
    ),
    [
      `auth=awaitchannel.joinCall(`,
      `auth=undefined`,
      `constauth=other`,
      `auth??=z(`,
    ],
  );
});

test("source pin (F1): #handleVoiceMove obeys a token only through moveTokenUsable, for THIS connection's last identity", () => {
  const handler = handleMove();
  const verdict = `const forThisConnection = moveTokenUsable({
    token: move.token,
    expectedIdentity: this.#lastLocalIdentity ?? "",
    to: move.to,
  });`;
  assertWired("the token verdict", verdict);
  assert.equal(countWired(handler, verdict), 1, "the verdict, in the handler");
  assert.equal(countWired(handler, `moveTokenUsable(`), 1, "its only call");
  // Handed to the decision, and read nowhere else: declared once, read once.
  const decide = `const decision = moveDecision(`;
  const world = bodyAfter(handler, decide);
  assert.equal(
    countWired(world, `tokenForThisConnection: forThisConnection,`),
    1,
    "the verdict, in moveDecision's world",
  );
  assert.equal(countWired(STATE_CODE, `forThisConnection`), 2);
  // In that order: the verdict is computed from the event's own token, and
  // the decision reads it before anything is torn down or joined.
  const at = (snippet: string) => firstAt("#handleVoiceMove", handler, snippet);
  assert.ok(at(verdict) < at(decide));
  assert.ok(at(decide) < at(`this.#rejoinSeq++;`));
  assert.ok(at(decide) < at(`this.disconnect();`));
  assert.ok(at(decide) < at(`this.connect(`));
  // voice-move's own addressing rules are retired (D3): nothing else decides
  // a move with its own inputs, or on its own clock.
  for (const retired of [
    `shouldObeyMove(`,
    `moveTokenForConnection(`,
    `#lastDisconnect`,
    `#followMove`,
  ])
    assert.equal(countWired(STATE_CODE, retired), 0, retired);
});

test("source pin (F1): #lastLocalIdentity is written only by the connected listener, under its generation", () => {
  const connected = bodyAfter(
    STATE_CODE,
    `room.addListener("connected", () => {`,
  );
  assert.equal(
    countWired(
      connected,
      `if (gen === this.#connectGen)
        this.#lastLocalIdentity = room.localParticipant.identity;`,
    ),
    1,
    "the generation-guarded write in the connected listener",
  );
  // Every write in the file, compound assignments included; `===` and `!==`
  // are reads.
  const writes = STATE_CODE.match(/#lastLocalIdentity(\?\?|\|\||&&)?=(?!=)/g);
  assert.equal(writes?.length, 1, "writes of #lastLocalIdentity");
});

// F4 (M3 dropped a move token that a refusal latch was bypassed for). The
// latch is read through `#refusalLatchHolds`, never `joinBlocked`: here
// `connect()` has already set `joinPending` to this channel, so
// `joinBlocked(channel)` answers "in-flight" and `answer_latch` would be
// unreachable.
const AUTH_DECISION = `const authDecision = moveAuthDecision({
  hasAuth: !!auth,
  tokenUsable:
    !!auth &&
    moveTokenUsable({
      token: auth.token,
      expectedIdentity: !selfUserId
        ? ""
        : e2eeDeviceId
          ? \`\${selfUserId}:\${e2eeDeviceId}\`
          : selfUserId,
      to: channel.id,
    }),
  latchStillRefused:
    bypassedRefusal !== undefined && this.#refusalLatchHolds(channel),
});`;
const AUTH_SWITCH = `switch (authDecision) {
  case "use":
    break;
  case "join":
    auth = undefined;
    preConnectDeadlineAt = undefined;
    break;
  case "answer_latch":
    if (gen !== this.#connectGen) return false;
    this.disconnect();
    this.onErr(new Error(this.#joinRefusalText(channel, bypassedRefusal!)));
    return false;
  default:`;

test("source pin (F4): the decision after M3 reads the latch through #refusalLatchHolds", () => {
  assertWired("the decision after M3", AUTH_DECISION);
  const args = bodyAfter(STATE_CODE, `const authDecision = moveAuthDecision(`);
  assert.equal(
    countWired(args, `joinBlocked(`),
    0,
    "joinBlocked in the decision",
  );
  assert.equal(countWired(args, `#joinRefusals`), 0, "the raw latch map");
  // And the helper asks with NO in-flight channel: its whole body.
  assert.equal(
    bodyOf(`#refusalLatchHolds(channel: Channel): boolean {`),
    codeOf(`return this.#joinBlockedWith(channel, undefined) === "refused"`),
    "the latch read",
  );
  assert.equal(countWired(STATE_CODE, `moveAuthDecision(`), 1);
});

test("source pin (D1): joinBlocked passes the attempt in flight, and #joinBlockedWith passes on what it is given", () => {
  // The other two ends of the latch read above. A `#joinBlockedWith` that
  // looked the attempt up itself would answer "in-flight" to F4 again, making
  // `answer_latch` unreachable; a public `joinBlocked` passing `undefined`
  // would leave every join affordance live while its attempt is in flight.
  // Whole bodies, so nothing can be appended to either.
  assert.equal(
    bodyOf(`joinBlocked(channel: Channel): JoinBlockedReason | undefined {`),
    codeOf(`return this.#joinBlockedWith(channel, this.joinPending())`),
    "joinBlocked",
  );
  assert.equal(
    bodyOf(`#joinBlockedWith(
      channel: Channel,
      inFlightChannelId: string | undefined,
    ): JoinBlockedReason | undefined {`),
    codeOf(`const latch = this.#joinRefusals().get(channel.id);
    return joinBlockedReason({
      channelId: channel.id,
      now: Date.now(),
      channelVersion: this.#channelVersions.get(channel.id) ?? 0,
      inFlightChannelId,
      latch,
      superseded: refusalSuperseded(latch, this.#deviceRefusedAt()),
    })`),
    "#joinBlockedWith",
  );
  assert.equal(countWired(STATE_CODE, `joinBlockedReason(`), 1);
});

test("source pin (F4): answer_latch leaves, answers from the latch and never joins", () => {
  // Contiguous with the decision, so nothing runs between them, and the arm
  // ends in `return false` right before `default`, so it cannot fall through
  // to the join below.
  assertWired("the decision, then its switch", AUTH_DECISION + AUTH_SWITCH);
});

test("source pin (S1): connect() steps past a latch only for a move token and an allowed reason", () => {
  const latchCheck = `const refusal = this.#joinRefusals().get(channel.id);
    const latchedReason =
      refusal && this.joinBlocked(channel) === "refused"
        ? refusal.reason
        : undefined;
    if (
      latchedReason !== undefined &&
      !(
        auth &&
        opts?.moveLatchBypass &&
        moveBypassesRefusalLatch(latchedReason)
      )
    ) {
      this.onErr(new Error(this.#joinRefusalText(channel, latchedReason)));
      return false;
    }`;
  assertWired("the latch check", latchCheck);
  // Answered before anything is torn down: the check comes ahead of
  // connect()'s leave, with no leave in front of it. (The drop-marker and
  // nonce clears sit between the two on purpose; see connect().)
  const connect = connectBody();
  const checkAt = firstAt("connect()", connect, latchCheck);
  assert.ok(checkAt < firstAt("connect()", connect, `this.disconnect();`));
  assert.equal(countWired(connect.slice(0, checkAt), `disconnect(`), 0);
  // The bypassed reason reaches #connectAttempt, which is what F4 reads.
  assertWired(
    "the attempt",
    `return await this.#connectAttempt(channel, auth, opts, latchedReason);`,
  );
  // The one caller that asks for the bypass: the move handler's token arm,
  // with the event's own URL and token, under the move budget.
  const tokenArm = `attempt = this.connect(
    destination,
    { url: decision.url, token: decision.token },
    {
      movePreConnectBudgetMs: MOVE_PRECONNECT_BUDGET_MS,
      moveLatchBypass: true,
    },
  );`;
  assertWired("the move's token arm", tokenArm);
  assert.equal(countWired(handleMove(), tokenArm), 1, "in #handleVoiceMove");
  assert.equal(countWired(STATE_CODE, `moveLatchBypass:`), 1);
});

test("source pin (F2): the chip's remote publications go through chipPublicationsOf", () => {
  assertWired(
    "the remote participants",
    `...[...room.remoteParticipants.values()].map((p) => ({
      identity: p.identity,
      publicationCount: p.trackPublications.size,
      publications: chipPublicationsOf(p.trackPublications.values()),
    })),`,
  );
  assert.equal(countWired(STATE_CODE, `chipPublicationsOf(`), 1);
});

test("source pin (F2): a subscription change and a reconnect both bump the chip's publication version", () => {
  assertWired(
    "the subscription listener",
    `room.addListener("trackSubscriptionStatusChanged", () => {
      if (this.room() !== room) return;
      this.#setChipPublicationsVersion((v) => v + 1);
    });`,
  );
  const bump = `this.#setChipPublicationsVersion((v) => v + 1);`;
  const reconnected = bodiesAfter(
    STATE_CODE,
    `room.addListener("reconnected", () => {`,
  ).filter(
    (body) => countWired(body, `if (this.room() !== room) return;`) === 1,
  );
  assert.equal(reconnected.length, 1, "the room-guarded reconnected listener");
  assert.equal(countWired(reconnected[0], bump), 1, "its bump");
});

test("source pin (F2): callEncryptionChip() reads the publication version before deriving", () => {
  const chip = bodyAfter(STATE_CODE, `callEncryptionChip(): ChipState {`);
  const [at] = wiredAt(chip, `this.#chipPublicationsVersion();`);
  assert.ok(at !== undefined, "the version read");
  assert.ok(at < chip.indexOf(codeOf(`return chipStateFrom({`)), "its order");
});

test("source pin: the move event's name is checked against the SDK's events, and its one listener calls the one handler", () => {
  assertWired(
    "the event name",
    `const VOICE_MOVE_REQUESTED = "voiceMoveRequested" satisfies keyof Events;`,
  );
  assertWired(
    "the listener",
    `const handler = (move: VoiceMoveRequest) =>
      void this.#handleVoiceMove(move);
    client.addListener(VOICE_MOVE_REQUESTED, handler);
    onCleanup(() => client.removeListener(VOICE_MOVE_REQUESTED, handler));`,
  );
  // No second, unchecked spelling of the name, and not the name AFK's dead
  // listener subscribed to (FE1-1): the SDK never emits that one.
  assert.equal(countWired(STATE_CODE, `"voiceMoveRequested"`), 1);
  assert.equal(countWired(STATE_CODE, `"userMoveVoiceChannel"`), 0);
  assert.equal(countWired(STATE_CODE, `.addListener(VOICE_MOVE_REQUESTED`), 1);
  assert.equal(countWired(STATE_CODE, `this.#handleVoiceMove(`), 1);
});

// FE2A-1 (FE0-3). A destination behind an age, password or spoiler check this
// member has not passed on this device is never joined by a move, and never
// put on the call card either: the card's Rejoin is an ordinary join that
// would walk past the check.
test("source pin (FE2A-1): a move into a gated channel leaves, says so once, and is never joined or carded", () => {
  const handler = handleMove();
  const failLoud = bodyAfter(handler, `if (decision.action === "fail-loud") {`);
  assert.ok(
    failLoud.startsWith(codeOf(`this.disconnect();`)),
    "fail-loud leaves the old call before anything else",
  );
  const head = `if (decision.reason === "gated-destination") {`;
  assert.equal(countWired(STATE_CODE, head), 1, "the gated block");
  const gatedBlock = bodyAfter(failLoud, head);
  assert.equal(countWired(gatedBlock, `this.onErr(`), 1, "its one notice");
  // The drop marker and the S-a record are retired, as `moved-elsewhere`
  // does, so a repeat of the event cannot re-run the arm.
  for (const clear of [
    `this.#lastInvoluntaryChannelId = undefined;`,
    `this.#lastInvoluntaryLeftAt = undefined;`,
    `this.#lastInvoluntaryConnNonce = undefined;`,
    `this.#replacedConnNonce = undefined;`,
    `this.#replacedLeftAt = undefined;`,
  ])
    assert.equal(countWired(gatedBlock, clear), 1, clear);
  assert.equal(countWired(gatedBlock, `#setChannel(`), 0, "a card");
  assert.equal(countWired(gatedBlock, `.connect(`), 0, "a join");
  assert.match(gatedBlock, /[;}]return$/, "the block ends in `return;`");
  // Ahead of every card the handler asserts, the fail-loud card first.
  assert.ok(
    firstAt("#handleVoiceMove", handler, head) <
      firstAt("#handleVoiceMove", handler, `this.#setChannel(destination);`),
    "the gated block comes before the first this.#setChannel(destination)",
  );
});

test("source pin (FE2A-1): the member gate refuses until VoiceContext wires the real one, synchronously", () => {
  // Fail closed: a `Voice` whose gate was never wired refuses every move.
  assertWired(
    "the default gate",
    `#memberGate: (channel: Channel) => boolean = () => true;`,
  );
  assert.equal(
    bodyOf(`setMemberGate(gate: (channel: Channel) => boolean): void {`),
    codeOf(`this.#memberGate = gate`),
    "the setter",
  );
  const writes = STATE_CODE.match(/#memberGate(\?\?|\|\||&&)?=(?!=)/g);
  assert.equal(writes?.length, 1, "writes of #memberGate past its default");
  // Right after the Voice is built, not in an effect: nothing can deliver a
  // move before it. The layout is read inside the closure, per move.
  assertWired(
    "the gate wiring",
    `const voice = new Voice(state.voice, modals, sound, (serverId) =>
      entranceSoundFor(state.settings, serverId),
    );
    voice.setMemberGate((channel) =>
      isChannelGatedForMember(
        channel,
        (key) => state.layout.getSectionState(key, false),
        LAYOUT_SECTIONS.MATURE,
      ),
    );`,
  );
  assert.equal(countWired(STATE_CODE, `setMemberGate(`), 2, "defined, called");
  // The handler asks it once, about the destination, and hands the answer to
  // the decision.
  const handler = handleMove();
  assert.equal(
    countWired(
      handler,
      `const gated = destination !== undefined && this.#memberGate(destination);`,
    ),
    1,
    "the gate question",
  );
  assert.equal(countWired(STATE_CODE, `this.#memberGate(`), 1);
  assert.equal(
    countWired(
      bodyAfter(handler, `const decision = moveDecision(`),
      `destinationGated: gated,`,
    ),
    1,
    "the answer, in moveDecision's world",
  );
});

// SEC5-1 (FE2A-4). A pre-minted token is dialled only if M3 kept it: M3 is
// the one keep/drop point, and every other path is tokenless.
test("source pin (SEC5-1): the one Room dial uses an auth that has been through M3", () => {
  const attempt = connectAttempt();
  const dial = `room.connect(auth.url, auth.token`;
  assert.equal(countWired(STATE_CODE, dial), 1, "the dial");
  assert.equal(countWired(STATE_CODE, `.connect(auth.url`), 1, "any dial");
  const switchHead = `switch (authDecision) {`;
  assert.equal(countWired(attempt, switchHead), 1, "M3's switch");
  const switchAt = firstAt("#connectAttempt", attempt, switchHead);
  const switchEnd = closerOf(attempt, switchAt + codeOf(switchHead).length - 1);
  assert.ok(
    firstAt("#connectAttempt", attempt, dial) > switchEnd,
    "the dial comes after M3's switch",
  );
  // `auth` is written twice: dropped inside M3's switch, or minted by the
  // join route. Nothing else hands the dial a token, a new local included.
  assert.deepEqual(authWritesIn(attempt), [
    `auth=undefined`,
    `auth=awaitchannel.joinCall(`,
  ]);
  assert.equal(
    countWired(attempt.slice(switchAt, switchEnd), `auth = undefined;`),
    1,
    "the drop, inside the switch",
  );
  // M3 decides once, unconditionally: a `const` at the method's top level
  // cannot sit under an `if`.
  assert.equal(countWired(STATE_CODE, `moveAuthDecision(`), 1);
  const decideAt = firstAt(
    "#connectAttempt",
    attempt,
    `const authDecision = moveAuthDecision(`,
  );
  assert.equal(braceDepthAt(attempt, decideAt), 0, "moveAuthDecision's depth");
});

test("source pin (SEC5-1): M3's join arm drops the token with its clock, and preMintedAuth is read after M3", () => {
  const attempt = connectAttempt();
  const switchHead = `switch (authDecision) {`;
  const switchAt = firstAt("#connectAttempt", attempt, switchHead);
  const switchEnd = closerOf(attempt, switchAt + codeOf(switchHead).length - 1);
  // A dropped token takes its budget with it: the attempt then mints its own
  // token after setup, like any other join.
  assert.equal(
    countWired(
      attempt.slice(switchAt, switchEnd),
      `case "join":
        auth = undefined;
        preConnectDeadlineAt = undefined;
        break;`,
    ),
    1,
    "M3's join arm",
  );
  const preMinted = `const preMintedAuth = auth !== undefined;`;
  assertWired("preMintedAuth", preMinted);
  const declaredAt = firstAt("#connectAttempt", attempt, preMinted);
  assert.ok(declaredAt > switchEnd, "preMintedAuth is taken after M3");
  assert.equal(
    attempt.indexOf("preMintedAuth"),
    declaredAt + "const".length,
    "nothing reads preMintedAuth above its declaration",
  );
});

test("source pin: the tokenless arm and the D5 retry are plain joins", () => {
  // No budget, no latch bypass and no rejoin flag: without a token nothing is
  // ticking and there is nothing to bypass a latch with.
  const handler = handleMove();
  const plain = `this.connect(destination);`;
  assert.equal(countWired(STATE_CODE, plain), 2, "plain joins in the file");
  assert.equal(countWired(handler, plain), 2, "plain joins in the handler");
  assert.equal(
    countWired(
      handler,
      `} else {
        attempt = this.connect(destination);
      }`,
    ),
    1,
    "the tokenless arm",
  );
  const retry = `try {
    joined = await this.connect(destination);
  } catch {`;
  assert.equal(countWired(handler, retry), 1, "the D5 retry");
  // The retry follows the token arm only.
  assert.equal(
    bodiesAfter(handler, `if (decision.action === "move") {`).filter(
      (body) => countWired(body, retry) === 1,
    ).length,
    1,
    "the retry, under the token arm's test",
  );
  // Three joins in all: the token arm, the tokenless arm, the retry.
  assert.equal(countWired(handler, `this.connect(`), 3);
});

test("source pin (FE2A-12): #handleVoiceMove logs fixed strings only", () => {
  // The event carries a live SFU credential, and a LiveKit error can quote
  // the signal URL, which carries it as `access_token=`.
  assertLogsOnly("#handleVoiceMove", handleMove());
});

/** `#toggleAndroidScreenShare`'s body: the one Android screen-leg start. */
function androidLegStart(): string {
  return bodyAfter(STATE_CODE, `async #toggleAndroidScreenShare(room: Room) {`);
}

// 🔴 SECURITY (C6, wave-4a e2ee #2). Under the inert-leg rule this filter
// alone decides which screen legs the roster holds out of BOTH lists while
// their owner is present. Anything wider (`|| !p.isEncrypted`, `size <= 1`,
// no `isScreenLeg`) hides a participant that publishes plaintext from the
// E2EE roster for as long as it stays, so the binding is pinned whole and its
// filter callback is compared whole: nothing can be added to either.
test("source pin (C9): unpublishedLegs is exactly the screen legs with zero publications", () => {
  assertWired(
    "the unpublishedLegs binding",
    `unpublishedLegs: () =>
      [...room.remoteParticipants.values()]
        .filter(
          (p) => isScreenLeg(p.identity) && p.trackPublications.size === 0,
        )
        .map((p) => p.identity),`,
  );
  assert.equal(
    bodyAfter(
      STATE_CODE,
      `unpublishedLegs: () => [...room.remoteParticipants.values()].filter(`,
    ),
    codeOf(`(p) => isScreenLeg(p.identity) && p.trackPublications.size === 0`),
    "the filter callback, whole",
  );
  assert.equal(countWired(STATE_CODE, `unpublishedLegs:`), 1, "one binding");
});

// 🔴 SECURITY (wave-4b e2ee F2). The sibling of `unpublishedLegs` in the same
// binding: a leg listed here is FOLDED onto its owner, lent the owner's
// enrollment. Only the leg's own declaration that it publishes encrypted
// (`isEncrypted`: at least one publication, every one encrypted) earns that.
// Widened (`&& p.isEncrypted` dropped, an `||`, no `isScreenLeg`), a leg that
// publishes plaintext is folded away instead of reported, so the binding is
// pinned whole and its filter callback compared whole.
test("source pin (C9): encryptedLegs is exactly the screen legs that declare encryption", () => {
  assertWired(
    "the encryptedLegs binding",
    `encryptedLegs: () =>
      [...room.remoteParticipants.values()]
        .filter((p) => isScreenLeg(p.identity) && p.isEncrypted)
        .map((p) => p.identity),`,
  );
  assert.equal(
    bodyAfter(
      STATE_CODE,
      `encryptedLegs: () => [...room.remoteParticipants.values()].filter(`,
    ),
    codeOf(`(p) => isScreenLeg(p.identity) && p.isEncrypted`),
    "the filter callback, whole",
  );
  assert.equal(countWired(STATE_CODE, `encryptedLegs:`), 1, "one binding");
});

// 🔴 SECURITY (wave-4b e2ee F2). The roster's universe: everyone the SFU
// shows, this device included. A participant left out here is never judged
// at all, so a leg (or anyone) filtered out could publish plaintext with no
// roster reaction. The array is pinned whole: nothing can be filtered from
// it or appended to it.
test("source pin (C9): sfuParticipants is every SFU participant, screen legs included", () => {
  assertWired(
    "the sfuParticipants binding",
    `sfuParticipants: () => [
      room.localParticipant.identity,
      ...[...room.remoteParticipants.values()].map((p) => p.identity),
    ],`,
  );
  assert.equal(countWired(STATE_CODE, `sfuParticipants:`), 1, "one binding");
});

// 🔴 (C6, wave-4a e2ee #3). An inert leg is judged by its publications the
// moment it has one. This reconcile bounds the inert → published-plaintext
// transition to the publish itself instead of the next periodic tick, so it
// runs on every publication, unconditionally.
test("source pin (C9): every trackPublished kicks a roster reconcile", () => {
  assert.equal(
    countWired(STATE_CODE, `room.addListener("trackPublished"`),
    1,
    "one trackPublished listener",
  );
  const listener = bodyAfter(
    STATE_CODE,
    `room.addListener("trackPublished", (pub, participant) => {`,
  );
  const kick = `void this.#mlsSession?.reconcileNow();`;
  assert.equal(countWired(listener, kick), 1, "the reconcile kick");
  const at = firstAt("the trackPublished listener", listener, kick);
  assert.equal(braceDepthAt(listener, at), 0, "at the listener's top level");
  assert.ok(
    at === 0 || ";}".includes(listener[at - 1]),
    "a statement of its own, not the tail of an unbraced `if`",
  );
  // (wave-4b e2ee F3) Nothing can leave the listener ahead of the kick: it
  // opens with the chip's version bump and then the kick, so no guard (a
  // screen-leg early `return`, a stale-room check) can sit in front of it.
  assert.ok(
    listener.startsWith(
      codeOf(`this.#setCallParticipantsVersion((v) => v + 1);
        ${kick}`),
    ),
    "the kick is the listener's second statement, after the version bump",
  );
});

// C9 (R7). A publish-gate pulse stops the Android leg one-way, and now says
// so. The notice is sampled BEFORE the stop bumps the generation, which is
// the whole single-fire argument: a tap or a hang-up that got there first
// has already bumped it, and a second reason during the teardown reads the
// stop in flight. Sampled after the stop, `startingFor` never matches the
// generation and the gate-start notice is lost.
test("source pin (C9): #pauseGate samples gateStopNotice before it stops the leg, and toasts from it", () => {
  const gate = bodyAfter(
    STATE_CODE,
    `async #pauseGate(room: Room, reason: PublishGateReason): Promise<void> {`,
  );
  const sample = `const notice = gateStopNotice({
    startingFor: this.#androidLegStartingFor,
    currentGeneration: this.#androidLegGeneration,
    active: !!this.#androidLeg?.active(),
    stopInFlight: !!this.#androidLeg?.stopping(),
    roomConnected: room.state === ConnectionState.Connected,
  });`;
  const stop = `void this.#stopAndroidLeg();`;
  const toast = `if (notice === "gate-start") this.onErr(new Error(LEG_GATE_START_NOTICE));
    else if (notice === "gate-share")
      this.onErr(new Error(LEG_GATE_SHARE_NOTICE));`;
  assert.equal(countWired(gate, sample), 1, "the sample, whole");
  assert.equal(countWired(gate, `#stopAndroidLeg(`), 1, "the one stop");
  assert.equal(countWired(gate, toast), 1, "the toast");
  const at = (snippet: string) => firstAt("#pauseGate", gate, snippet);
  assert.ok(
    at(`if (this.room() !== room) return;`) < at(sample),
    "sampled after the stale-room guard",
  );
  assert.ok(at(sample) < at(stop), "sampled before the stop");
  assert.ok(at(stop) < at(toast), "toasted after the stop");
  // (wave-4b e2ee F4) Shown only once the primary's pause sweep has run: the
  // method ENDS with the stop, the awaited sweep, then the toast, so the
  // toast cannot overtake the await and nothing runs after it.
  const sweep = `await this.#applyPublishGate(room);`;
  assert.equal(countWired(gate, `#applyPublishGate(`), 1, "the one sweep");
  assert.ok(at(sweep) < at(toast), "toasted after the sweep");
  assert.ok(
    gate.endsWith(codeOf(stop + sweep + toast).replace(/;$/, "")),
    "#pauseGate ends: the stop, the awaited sweep, the toast",
  );
  assert.equal(braceDepthAt(gate, at(sample)), 0, "the sample's depth");
  assert.equal(countWired(STATE_CODE, `gateStopNotice(`), 1, "its only call");
});

// C9 (wave-4 audit #3). The tier sheet is user-paced. A gate reason added
// while it is open cancelled no attempt (none had claimed), so without a
// second look the user goes through the OS consent dialog for a share that
// then dies at its first stale check. The refusal runs before the sheet and
// AGAIN once it closes, with nothing awaited between that re-check and the
// claim (any later reason reaches the claimed attempt through `#pauseGate`).
test("source pin (C9): the leg start refuses before the tier sheet, and again between the sheet and the claim", () => {
  const start = androidLegStart();
  const refusal = `if (this.#androidLegRefusedNow(mode)) {
    this.onErr(new Error(SHARE_UNAVAILABLE_NOW));
    return;
  }`;
  const refusals = wiredAt(start, refusal);
  assert.equal(refusals.length, 2, "the two refusals");
  const [beforeSheet, afterSheet] = refusals;
  const at = (snippet: string) =>
    firstAt("#toggleAndroidScreenShare", start, snippet);
  const claim = at(`const generation = ++this.#androidLegGeneration;`);
  assert.ok(
    beforeSheet < at(`this.openModal({ type: "android_screen_share_sheet"`),
    "the first refusal comes before the tier sheet",
  );
  assert.ok(
    at(`if (!tier) return;`) < afterSheet,
    "the second comes after the sheet resolves",
  );
  assert.ok(afterSheet < claim, "and before the claim");
  assert.equal(braceDepthAt(start, afterSheet), 0, "the re-check's depth");
  assert.equal(
    countWired(start.slice(afterSheet, claim), `await`),
    0,
    "nothing awaits between the re-check and the claim",
  );
  // What both refusals ask: the gate, and under E2EE an active session with
  // a leg send key.
  assert.equal(
    bodyOf(`#androidLegRefusedNow(mode: CallMode | undefined): boolean {`),
    codeOf(`return this.#publishGate.size > 0 ||
      (mode?.kind === "e2ee" &&
        (this.#mlsSession?.state() !== "active" ||
          !this.#mlsKeyProvider?.lastLocalScreenKey()))`),
    "#androidLegRefusedNow",
  );
  assert.equal(countWired(STATE_CODE, `this.#androidLegRefusedNow(`), 2);
});

// C9 (wave-4 audit #3). Every stale exit of a claimed start tears down AND
// reports a gate reason held since before the claim (`staleExitNotice`),
// read BEFORE the stop bumps the generation: read after it, every exit reads
// as cancelled and stays silent. A bare `#stopAndroidLeg()` at any one exit
// is the silent abort R7 closed.
test("source pin (C9): every stale exit of the leg start goes through #exitStaleAndroidLegStart", () => {
  const start = androidLegStart();
  const check = `if (this.#androidLegStale(generation, room)) {`;
  const checks = countWired(start, check);
  assert.equal(checks, 3, "after consent, after the token mint, after connect");
  assert.equal(
    countWired(
      start,
      `${check}
        await this.#exitStaleAndroidLegStart(generation, room);
        return;
      }`,
    ),
    checks,
    "each stale check exits through the helper",
  );
  assert.equal(countWired(start, `this.#exitStaleAndroidLegStart(`), checks);
  assert.equal(countWired(STATE_CODE, `this.#androidLegStale(`), checks);
  assert.equal(
    countWired(STATE_CODE, `this.#exitStaleAndroidLegStart(`),
    checks,
  );
  assert.equal(
    bodyOf(`async #exitStaleAndroidLegStart(
      generation: number,
      room: Room,
    ): Promise<void> {`),
    codeOf(`const notice = staleExitNotice(this.#androidLegWorld(generation, room));
    await this.#stopAndroidLeg();
    if (notice === "gate-start") this.onErr(new Error(LEG_GATE_START_NOTICE))`),
    "the helper reads its notice before it stops",
  );
  assert.equal(countWired(STATE_CODE, `staleExitNotice(`), 1, "its only call");
});

// C9 (C7, C8, wave-4 audits #5 and #7, wave-4a code #3). A native stop and a
// connect a revoke cancelled are read by ONE rule, `nativeStopNotice`: a
// revoke is silent when the primary lost publishing too (its own AFK or
// moderator-mute toast explains), and `inAfkChannel` closes the race where
// the leg's revoke lands before the primary's. An inline mapping, or a
// constant in place of either read, double-toasts or names the wrong cause;
// and the mapper's `NO_LEG_NOTICE` ("no notice") must never reach `onErr`.
// (wave-4b e2ee F6) The revoke is an EXACT match: every other failed connect
// is `connect_failed: <the native message>`, and a substring match would
// silence any of those that happened to contain it.
test("source pin (C9): a native stop and a revoked connect both go through nativeStopNotice", () => {
  const primary = `{
    canPublish: this.room()?.localParticipant.permissions?.canPublish,
    inAfkChannel: this.isAfkChannel,
  }`;
  const stopped = bodyAfter(STATE_CODE, `leg.onStopped = (reason) => {`);
  assert.equal(
    countWired(
      stopped,
      `const text = this.#legStopNoticeMessage(
        nativeStopNotice(reason, ${primary}),
      );
      if (text !== undefined) this.onErr(new Error(text));`,
    ),
    1,
    "onStopped's notice",
  );
  assert.equal(countWired(stopped, `this.onErr(`), 1, "onStopped's one toast");
  const mapper = bodyAfter(
    STATE_CODE,
    `#androidScreenShareError(error: unknown): unknown {`,
  );
  const revoked = `if (message === "connect_failed: revoked") {
    const text = this.#legStopNoticeMessage(
      nativeStopNotice("revoked", ${primary}),
    );
    return text === undefined ? NO_LEG_NOTICE : new Error(text);
  }`;
  assert.equal(countWired(mapper, revoked), 1, "the revoked-connect mapping");
  // The revoke text is read in one place, by that exact comparison.
  assert.equal(
    countWired(STATE_CODE, `"connect_failed: revoked"`),
    1,
    "one read of the revoke text",
  );
  assert.ok(
    firstAt("#androidScreenShareError", mapper, revoked) <
      firstAt("#androidScreenShareError", mapper, `switch (type) {`),
    "mapped before the pass-through",
  );
  assert.equal(countWired(STATE_CODE, `nativeStopNotice(`), 2, "its two calls");
  // The start's catch skips the toast on the mapper's "no notice" marker,
  // and on nothing else (a rejection whose value is `undefined` included).
  assert.equal(
    countWired(
      androidLegStart(),
      `const wasCancelled = this.#androidLegCancelled(generation, room);
      await this.#stopAndroidLeg();
      if (!wasCancelled) {
        const notice = this.#androidScreenShareError(error);
        if (notice !== NO_LEG_NOTICE) this.onErr(notice);
      }`,
    ),
    1,
    "the catch",
  );
  assert.equal(countWired(STATE_CODE, `this.#androidScreenShareError(`), 1);
  // `none` is silence, and a revoke has its own copy.
  const copy = bodyAfter(
    STATE_CODE,
    `#legStopNoticeMessage(notice: LegStopNotice): string | undefined {`,
  );
  for (const arm of [
    `case "none": return undefined;`,
    `case "revoked": return LEG_REVOKED_NOTICE;`,
  ])
    assert.equal(countWired(copy, arm), 1, arm);
});

// (wave-4b code #4) The start's catch is silenced by ONE value, a marker only
// the revoke branch returns, not `undefined`, which the mapper's pass-through
// hands back for an `undefined` rejection. Declared once and used exactly
// three times in code (the declaration, the revoke's return and the catch's
// comparison, both pinned whole above), so no other path can silence a toast.
test("source pin (C9): NO_LEG_NOTICE is declared once and used only by the revoke and the catch", () => {
  assertWired("the marker", `const NO_LEG_NOTICE = Symbol("no-leg-notice");`);
  assert.equal(countWired(STATE_CODE, `NO_LEG_NOTICE`), 3, "its three uses");
  const mapper = bodyAfter(
    STATE_CODE,
    `#androidScreenShareError(error: unknown): unknown {`,
  );
  assert.equal(countWired(mapper, `NO_LEG_NOTICE`), 1, "the one return");
  assert.equal(
    countWired(androidLegStart(), `NO_LEG_NOTICE`),
    1,
    "the one comparison",
  );
});

// 🔴 SECURITY (wave-4b e2ee F1, decision 10). A leg that cannot take the
// current epoch's key must not keep publishing under the old one, so both
// key-fence catches stop it UNCONDITIONALLY. `spoken` is read BEFORE the stop
// (a leg already stopping, or no longer active, was ended by something that
// said why or chose silence), and only that skips the toast; a stop that
// FAILED (the leg still `active()` after it) is reported regardless. Each
// catch is compared whole, so the stop cannot be dropped, put under an `if`
// or moved behind the toast, and the toast condition cannot be narrowed.
const LEG_KEY_FENCE_CATCH = `const spoken = leg.stopping() || !leg.active();
  await this.#stopAndroidLeg();
  if (!spoken || leg.active())
    this.onErr(
      new Error(
        "Your screen share stopped because it could no longer be encrypted.",
      ),
    )`;

test("source pin (C9): both leg key-fence catches stop the leg unconditionally, then toast unless already spoken for", () => {
  const catches = {
    "the rotation listener": bodyAfter(
      STATE_CODE,
      `provider.onLocalScreenKey = async (key) => {`,
    ),
    "#syncLegKeyAfterConnect": bodyAfter(
      STATE_CODE,
      `async #syncLegKeyAfterConnect(
        leg: AndroidScreenLeg,
        connectedWith: LegE2EEKey | undefined,
      ): Promise<void> {`,
    ),
  };
  for (const [what, body] of Object.entries(catches))
    assert.deepEqual(
      bodiesAfter(body, `} catch {`),
      [codeOf(LEG_KEY_FENCE_CATCH)],
      `${what}: its one catch, whole`,
    );
  assert.equal(
    countWired(STATE_CODE, LEG_KEY_FENCE_CATCH),
    2,
    "exactly two, one in each",
  );
});

// (wave-4b code #2) The copy every leg notice reaches the user through, whole:
// a silenced `connection` or `encryption` arm, a swapped constant or text, or
// a `default` that stops being exhaustive fails here.
test("source pin (C9): #legStopNoticeMessage maps every notice to its own copy", () => {
  assert.equal(
    bodyOf(
      `#legStopNoticeMessage(notice: LegStopNotice): string | undefined {`,
    ),
    codeOf(`switch (notice) {
      case "none":
        return undefined;
      case "connection":
        return "Your screen share ended because the connection changed. Share again when you're ready.";
      case "encryption":
        return "Your screen share stopped because it could no longer be encrypted.";
      case "revoked":
        return LEG_REVOKED_NOTICE;
      case "gate-start":
        return LEG_GATE_START_NOTICE;
      case "gate-share":
        return LEG_GATE_SHARE_NOTICE;
      default: {
        const unknownNotice: never = notice;
        void unknownNotice;
        return undefined;
      }
    }`),
    "the switch, whole",
  );
});

// 🔴 SECURITY (wave-4b-fix2, decision 7 / E2-5). The key-fence catches above
// act only once a push FAILS; these pins hold the pushes themselves. A
// rotation that lands while the leg is still connecting is dropped by the
// listener (the leg is not `active()` yet), and this call is what re-reads the
// provider's key once `connect()` resolves and pushes it. Dropped, the share
// stays on a key a member removed by that rotation still holds. It ends the
// try, right after the post-connect stale exit, at the try's top level.
test("source pin (C9): the leg start ends its try by syncing the leg's key, right after the post-connect stale exit", () => {
  const start = androidLegStart();
  const tryHead = `try {`;
  assert.equal(countWired(start, tryHead), 1, "the start's one try");
  const tryAt = firstAt("#toggleAndroidScreenShare", start, tryHead);
  const tryEnd = closerOf(start, tryAt + codeOf(tryHead).length - 1);
  const body = start.slice(tryAt + codeOf(tryHead).length, tryEnd);
  assert.ok(
    start.startsWith(codeOf(`} catch (error) {`), tryEnd),
    "the try's own catch follows it",
  );
  const staleExit = `if (this.#androidLegStale(generation, room)) {
    await this.#exitStaleAndroidLegStart(generation, room);
    return;
  }`;
  const sync = `await this.#syncLegKeyAfterConnect(activeLeg, e2eeKey);`;
  const exits = wiredAt(body, staleExit);
  assert.equal(exits.length, 3, "the three stale exits, inside the try");
  assert.ok(
    firstAt("the try", body, `await activeLeg.connect(`) < exits[2],
    "the third stale exit follows connect()",
  );
  const tail = codeOf(staleExit + sync).replace(/;$/, "");
  assert.ok(
    body.endsWith(tail),
    "the try ends: the post-connect stale exit, then the key sync",
  );
  assert.equal(
    exits[2],
    body.length - tail.length,
    "the stale exit it follows is the third",
  );
  assert.equal(
    braceDepthAt(body, body.length - codeOf(sync).length + 1),
    0,
    "the sync's depth",
  );
  assert.equal(countWired(STATE_CODE, sync), 1, "the one awaited sync");
  assert.equal(
    countWired(STATE_CODE, `this.#syncLegKeyAfterConnect(`),
    1,
    "its only call",
  );
});

// 🔴 SECURITY (wave-4b-fix2, decision 7 / E2-5). The sync, whole: the only
// early return is "nothing moved" (`none`), a key from a superseded group
// (`stop`) throws into the key-fence catch, and every other answer is pushed
// and awaited. A guard that skips the push, or an un-awaited push, leaves the
// share on the key the start connected with.
test("source pin (C9): #syncLegKeyAfterConnect pushes every moved key, awaited, and fails closed otherwise", () => {
  assert.equal(
    bodyOf(`async #syncLegKeyAfterConnect(
      leg: AndroidScreenLeg,
      connectedWith: LegE2EEKey | undefined,
    ): Promise<void> {`),
    codeOf(`const action = keyActionAfterConnect(
      connectedWith,
      this.#mlsKeyProvider?.lastLocalScreenKey(),
    );
    if (action.kind === "none") return;
    try {
      if (action.kind === "stop")
        throw new Error("screen leg key is from a different group");
      await leg.setFrameKey(action.key);
    } catch {
      ${LEG_KEY_FENCE_CATCH};
    }`),
    "#syncLegKeyAfterConnect, whole",
  );
  assert.equal(
    countWired(STATE_CODE, `keyActionAfterConnect(`),
    1,
    "its only call",
  );
});

// 🔴 SECURITY (wave-4b-fix2, decision 7 / E2-5). The rotation push, whole: a
// Remove-driven rotation re-keys a LIVE leg here, so the guard returns only
// for a leg that is not `active()` (inverted, or widened to skip a leg that is
// `stopping()`, a live share keeps the old key), the push is awaited (else
// `applyLocalKey` reports the rotation installed before the phone has it, and
// a failure never reaches the catch), and it carries the key's epoch and
// group (the push fence).
test("source pin (C9): the rotation listener pushes every rotation into a live leg, awaited and fenced", () => {
  assertWired(
    "the listener, on the call's key provider",
    `const provider = this.#mlsKeyProvider;
    provider.onLocalScreenKey = async (key) => {`,
  );
  assert.equal(
    bodyAfter(STATE_CODE, `provider.onLocalScreenKey = async (key) => {`),
    codeOf(`const leg = this.#androidLeg;
    if (!leg?.active()) return;
    try {
      await leg.setFrameKey({
        keyB64: key.keyB64,
        keyIndex: key.keyIndex,
        epoch: key.epoch,
        groupId: key.groupId,
      });
    } catch {
      ${LEG_KEY_FENCE_CATCH};
    }`),
    "the rotation listener, whole",
  );
  assert.equal(
    countWired(STATE_CODE, `.onLocalScreenKey =`),
    1,
    "one listener",
  );
  assert.equal(
    countWired(STATE_CODE, `.setFrameKey(`),
    2,
    "the two key pushes: the rotation and the sync",
  );
});

// 🔴 SECURITY (wave-4b-fix3). THE binding read of the leg's send key, whole.
// Skipping the `e2ee` branch, or dropping the session's `active` check or the
// current-group check, starts a share in an encrypted call in plaintext or on
// a superseded group's key; a swapped field in the literal hands native the
// wrong key. The refusal stops the leg (consent is already taken) and says so.
const LEG_KEY_READ = `let e2eeKey: LegE2EEKey | undefined;
  if (mode?.kind === "e2ee") {
    const key = this.#mlsKeyProvider?.lastLocalScreenKey();
    if (
      this.#mlsSession?.state() !== "active" ||
      !key ||
      key.groupId !== this.#mlsSession.groupId()
    ) {
      await this.#stopAndroidLeg();
      this.onErr(new Error(SHARE_UNAVAILABLE_NOW));
      return;
    }
    e2eeKey = {
      keyB64: key.keyB64,
      keyIndex: key.keyIndex,
      epoch: key.epoch,
      groupId: key.groupId,
    };
  }`;

// 🔴 SECURITY (wave-4b-fix3). What the leg connects with, and everything after
// it: the bound key reaches `connect()` (`e2ee: undefined` is a plaintext
// share), and nothing runs between the connect and the post-connect stale
// exit and key sync (an early `return` there skips the sync, leaving the
// share on the key it connected with).
const LEG_CONNECT_TAIL = `await activeLeg.connect({
    url: auth.url,
    token: auth.token,
    tier,
    e2ee: e2eeKey,
  });
  if (this.#androidLegStale(generation, room)) {
    await this.#exitStaleAndroidLegStart(generation, room);
    return;
  }
  await this.#syncLegKeyAfterConnect(activeLeg, e2eeKey);`;

test("source pin (C9): the leg start's binding key read is whole: E2EE branch, active session, current group, every field", () => {
  const start = androidLegStart();
  assertWired("the binding key read", LEG_KEY_READ);
  assert.equal(countWired(start, LEG_KEY_READ), 1, "in the leg start");
  // The branch's input is the call's own mode, read once at the top level.
  const mode = `const mode = this.callMode();`;
  assert.equal(countWired(start, mode), 1, "the mode read");
  assert.equal(
    braceDepthAt(start, firstAt("#toggleAndroidScreenShare", start, mode)),
    0,
    "the mode read's depth",
  );
  // `e2eeKey` is named four times in the file, all here: the declaration,
  // the one write, the connect and the sync. Nothing else can overwrite it.
  const uses = (code: string) => code.match(/e2eeKey(?![\w$])/g)?.length;
  assert.equal(uses(STATE_CODE), 4, "e2eeKey in the file");
  assert.equal(uses(start), 4, "e2eeKey in the leg start");
});

test("source pin (C9): the leg start's try ends: the key read, connect with that key, the stale exit, the sync", () => {
  const start = androidLegStart();
  const tryHead = `try {`;
  assert.equal(countWired(start, tryHead), 1, "the start's one try");
  const tryAt = firstAt("#toggleAndroidScreenShare", start, tryHead);
  const tryEnd = closerOf(start, tryAt + codeOf(tryHead).length - 1);
  const body = start.slice(tryAt + codeOf(tryHead).length, tryEnd);
  // Contiguous, at the try's top level, to the try's last token: nothing
  // between the read and the connect, nor between the connect and the sync.
  assert.ok(
    body.endsWith(codeOf(LEG_KEY_READ + LEG_CONNECT_TAIL).replace(/;$/, "")),
    "the try ends: the key read, connect, the stale exit, the sync",
  );
  assert.equal(
    bodyAfter(start, `await activeLeg.connect(`),
    codeOf(`{ url: auth.url, token: auth.token, tier, e2ee: e2eeKey }`),
    "connect()'s argument, whole",
  );
  assert.equal(
    countWired(STATE_CODE, `activeLeg.connect(`),
    1,
    "the leg's one connect",
  );
});

// 🔴 SECURITY (wave-4b-fix3). The rotation listener lives on the ONE provider
// the call builds, wired the moment it is built, unconditionally: gated on
// `nativeScreenShareAvailable()` (an async probe) a call joined before the
// probe landed had no listener for its whole life, and a provider rebuilt
// after the wiring would leave the listener on an orphan. The try that builds
// it is pinned at both ends (the listener's body is pinned whole above).
test("source pin (C9): the call's key provider is built once and wired at once, unconditionally", () => {
  const wiring = `this.#mlsKeyProvider = new MlsKeyProvider();
    const provider = this.#mlsKeyProvider;
    provider.onLocalScreenKey = async (key) => {`;
  assertWired("the provider and its listener", wiring);
  const tryBody = bodyAfter(STATE_CODE, `if (e2eeCapable) { try {`);
  assert.ok(
    tryBody.startsWith(codeOf(wiring)),
    "the e2eeCapable try opens with the wiring, at its top level",
  );
  const listenerEnd = closerOf(tryBody, codeOf(wiring).length - 1);
  assert.equal(
    tryBody.slice(listenerEnd + 1),
    codeOf(`; this.#e2eeWorker = new E2EEWorker();`).replace(/;$/, ""),
    "after the listener, only the worker",
  );
  assert.equal(countWired(STATE_CODE, `new MlsKeyProvider(`), 1, "one build");
  // Every write of the field, in file order: the build, then the two
  // teardowns (the build's own catch and the call's teardown).
  assert.deepEqual(
    [
      ...STATE_CODE.matchAll(
        /(?:[\w$]+\.)?#mlsKeyProvider(?:\?\?|\|\||&&)?=(?![=>])[^;}]*/g,
      ),
    ].map((m) => m[0]),
    [
      `this.#mlsKeyProvider=newMlsKeyProvider()`,
      `this.#mlsKeyProvider=undefined`,
      `this.#mlsKeyProvider=undefined`,
    ],
    "the writes of #mlsKeyProvider",
  );
});

// The three leg notices say exactly what the plan's copy says: a swapped or
// reworded text fails here (the switch above only names the constants).
test("source pin (C9): the leg notice constants hold the plan's copy", () => {
  for (const [what, decl] of [
    [
      "gate-start",
      `const LEG_GATE_START_NOTICE =
        "Your screen share didn't start because the call is re-securing or paused. Try again in a moment.";`,
    ],
    [
      "gate-share",
      `const LEG_GATE_SHARE_NOTICE =
        "Your screen share stopped because the call is re-securing or paused. Share again in a moment.";`,
    ],
    [
      "revoked",
      `const LEG_REVOKED_NOTICE =
        "Your screen share ended because you no longer have permission to share video in this channel.";`,
    ],
  ])
    assertWired(what, decl);
});

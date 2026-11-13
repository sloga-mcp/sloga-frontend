// Specs for the voice auto-rejoin policy — run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/voiceRejoinPolicy.test.ts
//
// These pin the decisions that stranded a call on "Disconnected" forever on a
// healthy network (observed live 2026-08-22). The subtle one is the deny-list
// DIRECTION: an unrecognised reason must recover, because the reason that
// actually killed that call — STATE_MISMATCH, from LiveKit's connection
// reconcile watchdog rather than from its retry policy — is exactly the kind
// of code an allow-list would have omitted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DisconnectReason } from "livekit-client";

import { classifyJoinRefusal } from "./joinRefusalPolicy.ts";
import {
  isRejoinPreempted,
  MAX_REJOIN_ATTEMPTS,
  NO_REJOIN_DISCONNECT_REASONS,
  REJOIN_DELAYS_MS,
  rejoinDelayMs,
  shouldAutoRejoin,
  totalRejoinWindowMs,
} from "./voiceRejoinPolicy.ts";

const world = (over: Partial<Parameters<typeof shouldAutoRejoin>[0]> = {}) => ({
  state: "CONNECTED",
  reason: DisconnectReason.STATE_MISMATCH as DisconnectReason | undefined,
  ...over,
});

// --- what must recover -----------------------------------------------------

test("STATE_MISMATCH rejoins — the reason that caused the original wedge", () => {
  // The watchdog's terminal path: 3 failed transport probes 4 s apart, then
  // handleDisconnect(STATE_MISMATCH). It never enters the retry policy, so
  // nothing below the app recovers this on its own.
  assert.equal(shouldAutoRejoin(world()), true);
});

test("a missing reason rejoins", () => {
  // The SDK omits a reason on some transport closes. From a call the user was
  // mid-way through, "no reason given" is a dead socket far more often than a
  // deliberate ending.
  assert.equal(shouldAutoRejoin(world({ reason: undefined })), true);
});

test("server-side deaths the user did not ask for rejoin", () => {
  for (const reason of [
    DisconnectReason.SERVER_SHUTDOWN,
    DisconnectReason.SIGNAL_CLOSE,
    DisconnectReason.MIGRATION,
    DisconnectReason.JOIN_FAILURE,
  ])
    assert.equal(shouldAutoRejoin(world({ reason })), true, String(reason));
});

test("an UNKNOWN future reason rejoins — the deny-list points this way on purpose", () => {
  // An allow-list would silently stop recovering the day LiveKit adds a code.
  // 9999 stands in for that future value.
  assert.equal(
    shouldAutoRejoin(world({ reason: 9999 as DisconnectReason })),
    true,
  );
});

// --- what must NOT recover -------------------------------------------------

test("every deliberate ending stays disconnected", () => {
  for (const reason of NO_REJOIN_DISCONNECT_REASONS)
    assert.equal(shouldAutoRejoin(world({ reason })), false, String(reason));
});

test("a hang-up does not rejoin", () => {
  assert.equal(
    shouldAutoRejoin(world({ reason: DisconnectReason.CLIENT_INITIATED })),
    false,
  );
});

test("being kicked does not rejoin", () => {
  // Rejoining a removal would fight a moderator, and land the user back in a
  // room they were just ejected from.
  assert.equal(
    shouldAutoRejoin(world({ reason: DisconnectReason.PARTICIPANT_REMOVED })),
    false,
  );
});

test("a join from another device does not rejoin — it would fight for the identity", () => {
  assert.equal(
    shouldAutoRejoin(world({ reason: DisconnectReason.DUPLICATE_IDENTITY })),
    false,
  );
});

test("a closed or deleted room does not rejoin", () => {
  assert.equal(
    shouldAutoRejoin(world({ reason: DisconnectReason.ROOM_CLOSED })),
    false,
  );
  assert.equal(
    shouldAutoRejoin(world({ reason: DisconnectReason.ROOM_DELETED })),
    false,
  );
});

// --- the CONNECTED gate ----------------------------------------------------

test("a FAILING INITIAL JOIN is never rejoined, whatever the reason", () => {
  // A join that never succeeds also emits `disconnected`. Looping on it would
  // retry a call the user never got into, and swallow the error that
  // connect()'s catch exists to surface.
  for (const state of ["CONNECTING", "READY", "DISCONNECTED", "RECONNECTING"])
    assert.equal(shouldAutoRejoin(world({ state })), false, state);
});

test("only a call the user was actually IN is recovered", () => {
  assert.equal(shouldAutoRejoin(world({ state: "CONNECTED" })), true);
  assert.equal(shouldAutoRejoin(world({ state: "READY" })), false);
});

// --- backoff ---------------------------------------------------------------

test("backoff follows the schedule, then repeats its last value", () => {
  REJOIN_DELAYS_MS.forEach((expected, i) =>
    assert.equal(rejoinDelayMs(i), expected),
  );
  const last = REJOIN_DELAYS_MS[REJOIN_DELAYS_MS.length - 1];
  assert.equal(rejoinDelayMs(REJOIN_DELAYS_MS.length), last);
  assert.equal(rejoinDelayMs(REJOIN_DELAYS_MS.length + 50), last);
});

test("backoff never returns undefined past the end of the table", () => {
  // The loop makes MAX_REJOIN_ATTEMPTS attempts against a shorter schedule, so
  // an unclamped index would hand setTimeout an undefined delay and collapse
  // the backoff to zero — a retry storm rather than a wait.
  for (let attempt = 0; attempt < MAX_REJOIN_ATTEMPTS; attempt++) {
    const delay = rejoinDelayMs(attempt);
    assert.equal(typeof delay, "number");
    assert.ok(delay > 0, `attempt ${attempt} produced ${delay}`);
  }
});

test("backoff is monotonic — no attempt waits less than the one before", () => {
  for (let attempt = 1; attempt < MAX_REJOIN_ATTEMPTS; attempt++)
    assert.ok(
      rejoinDelayMs(attempt) >= rejoinDelayMs(attempt - 1),
      `attempt ${attempt} waits less than ${attempt - 1}`,
    );
});

test("a negative attempt clamps to the first delay rather than the last", () => {
  assert.equal(rejoinDelayMs(-1), REJOIN_DELAYS_MS[0]);
});

// --- the bound -------------------------------------------------------------

test("the loop is bounded, so the card becomes actionable instead of spinning", () => {
  assert.ok(MAX_REJOIN_ATTEMPTS > 0);
  assert.ok(Number.isFinite(MAX_REJOIN_ATTEMPTS));
});

test("the whole window stays inside a couple of minutes", () => {
  // How long a user stares at "Reconnecting" before they get a Rejoin button.
  // A product bound, deliberately assertable: editing the schedule upward
  // should fail here rather than quietly stretching the wait.
  const total = totalRejoinWindowMs();
  assert.equal(total, 1_000 + 2_000 + 4_000 + 8_000 + 15_000 + 30_000 * 3);
  assert.ok(
    total <= 150_000,
    `rejoin window grew to ${total} ms — is that still acceptable to stare at?`,
  );
});

// --- S-b: a rejoin the server turned away ----------------------------------
//
// The loop's attempts carry `rejoin: true`, and for those delta answers
// `AlreadyConnected` when the user's call is live in another channel instead
// of force-disconnecting it. The seat this protects is one a move carried
// elsewhere while this session was deaf to the event.

test("AlreadyConnected is a pre-empted rejoin", () => {
  assert.equal(isRejoinPreempted({ type: "AlreadyConnected" }), true);
});

test("fields beside the type do not change the answer", () => {
  assert.equal(
    isRejoinPreempted({ type: "AlreadyConnected", location: "voice_join.rs" }),
    true,
  );
});

test("every other join_call answer is not a pre-empted rejoin", () => {
  // The terminal refusals, the outage, and near-misses of the one type that
  // counts: a sloppy match here would end a loop that should keep trying.
  for (const type of [
    "NotAVoiceChannel",
    "MissingPermission",
    "CannotJoinCall",
    "IsBot",
    "FailedValidation",
    "UnknownNode",
    "LiveKitUnavailable",
    "FeatureDisabled",
    "NotInVoiceChannel",
    "alreadyconnected",
    "AlreadyConnected ",
    "",
  ])
    assert.equal(isRejoinPreempted({ type }), false, JSON.stringify(type));
});

test("anything that is not an API error body is not a pre-empted rejoin", () => {
  // A network failure, a LiveKit error or an empty rejection is a transport
  // problem the loop exists to retry through, never "carried on elsewhere".
  for (const [label, error] of [
    ["null", null],
    ["undefined", undefined],
    ["the bare type string", "AlreadyConnected"],
    ["an Error whose message is the type", new Error("AlreadyConnected")],
    ["a fetch TypeError", new TypeError("Failed to fetch")],
    ["an empty object", {}],
    ["an undefined type", { type: undefined }],
    ["a null type", { type: null }],
    ["a number", 42],
    ["a boxed String type", { type: new String("AlreadyConnected") }],
    ["the type in an array", { type: ["AlreadyConnected"] }],
    ["a nested body", { data: { type: "AlreadyConnected" } }],
  ] as const)
    assert.equal(isRejoinPreempted(error), false, label);
});

test("the type is read exactly the way classifyJoinRefusal reads it", () => {
  // Both functions look at the same rejection from `channel.joinCall`. If
  // the two readings drift apart, one error shape can be a terminal refusal
  // to one reader and invisible to the other. Each shape wraps
  // `AlreadyConnected` for this reader and a terminal type for the other,
  // and the two answers must match.
  const shapes: [string, (type: string) => unknown][] = [
    ["the bare body", (type) => ({ type })],
    ["a body with more fields", (type) => ({ type, location: "here" })],
    ["a frozen body", (type) => Object.freeze({ type })],
    ["a type on the prototype", (type) => Object.create({ type })],
    [
      "a type behind a getter",
      (type) => ({
        get type() {
          return type;
        },
      }),
    ],
    [
      "an Error carrying a type",
      (type) => Object.assign(new Error("join_call failed"), { type }),
    ],
    ["the type string on its own", (type) => type],
    ["an Error whose message is the type", (type) => new Error(type)],
    ["a boxed String type", (type) => ({ type: new String(type) })],
    ["the type in an array", (type) => ({ type: [type] })],
    ["a nested body", (type) => ({ data: { type } })],
    ["null", () => null],
    ["undefined", () => undefined],
  ];
  let agreedYes = 0;
  let agreedNo = 0;
  for (const [label, wrap] of shapes) {
    const refusal = classifyJoinRefusal(wrap("CannotJoinCall"));
    const preempted = isRejoinPreempted(wrap("AlreadyConnected"));
    assert.equal(
      preempted,
      refusal === "CannotJoinCall",
      `${label}: isRejoinPreempted says ${preempted}, classifyJoinRefusal says ${String(refusal)}`,
    );
    if (preempted) agreedYes++;
    else agreedNo++;
  }
  // Not vacuous in either direction.
  assert.ok(agreedYes > 0 && agreedNo > 0, `${agreedYes} yes, ${agreedNo} no`);
});

test("🔴 AlreadyConnected is NOT a terminal join refusal", () => {
  // A terminal refusal latches the channel for 30 s: `connect()` answers
  // every join to it from the latch, without asking the server. After a
  // pre-empted rejoin, the user's deliberate return to that channel is an
  // ordinary join (no `rejoin` flag) that the server lets through, and the
  // latch would refuse it before it was sent. `connect()` latches exactly
  // what `classifyJoinRefusal` names, so it must name nothing here, in any
  // of the shapes a rejection can take.
  assert.equal(classifyJoinRefusal({ type: "AlreadyConnected" }), undefined);
  assert.equal(
    classifyJoinRefusal(
      Object.assign(new Error("join_call failed"), {
        type: "AlreadyConnected",
      }),
    ),
    undefined,
  );
  assert.equal(
    classifyJoinRefusal({ type: "AlreadyConnected", feature: "media_e2ee" }),
    undefined,
  );
  // And the answer that must not latch is the answer that ends the loop.
  assert.equal(isRejoinPreempted({ type: "AlreadyConnected" }), true);
});

// --- S-b wiring, read from source ------------------------------------------
//
// Three edits in three files carry the flag, and each can be undone by one
// token with tsc, the suite and the build all still green: the 5th argument
// becomes `undefined`, the preempt branch is deleted (the loop then retries
// eight times and leaves a Rejoin card whose force-join kicks the moved
// seat), or stoat.js renames the body key (delta reads `rejoin` and the
// attempt goes back to force-disconnecting). Each source is read INSIDE the
// test that needs it, so a missing file (an uninitialized stoat.js
// submodule) fails that one test with a message naming the cause, and the
// pure cases above still run. It is a failure, never a skip: an unread
// source is an unchecked contract.

const STATE_URL = new URL("./state.tsx", import.meta.url);
const STOAT_CHANNEL_URL = new URL(
  "../../../stoat.js/src/classes/Channel.ts",
  import.meta.url,
);

/**
 * Crude comment stripper, the same shape `movePolicy.test.ts` uses: the scans
 * read code, not the prose that explains it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The balanced `{…}` or `(…)` group that opens at `source[openAt]`, including
 * both delimiters, or `""` if it never closes. Copied from
 * `movePolicy.test.ts` rather than imported, so this spec does not depend on
 * another spec. It does not know about strings, so it is only pointed at
 * spans with no brace or paren inside a string literal.
 */
function balancedGroup(source: string, openAt: number): string {
  const open = source[openAt];
  const close = open === "{" ? "}" : open === "(" ? ")" : undefined;
  if (close === undefined) return "";
  let depth = 0;
  for (let i = openAt; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0)
      return source.slice(openAt, i + 1);
  }
  return "";
}

/** Whitespace runs collapsed to one space, ends trimmed. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The top-level, comma-separated items of a `(…)` group from
 * `balancedGroup`, whitespace-squashed, trailing comma dropped. Commas
 * nested in `()`, `[]` or `{}` stay inside their item. As crude as
 * `balancedGroup`, and pointed only at spans with no comma or bracket inside
 * a string.
 */
function topLevelItems(group: string): string[] {
  const inner = group.slice(1, -1);
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  items.push(inner.slice(start));
  const squashed = items.map(squash);
  if (squashed.length > 0 && squashed[squashed.length - 1] === "")
    squashed.pop();
  return squashed;
}

/** `url`'s text, comments stripped; throws a message naming the file. */
function readCode(url: URL, hint: string): string {
  let source: string;
  try {
    source = readFileSync(url, "utf8");
  } catch (error) {
    throw new Error(
      `cannot read ${url.pathname} (${(error as Error).message}). ${hint} This contract is unchecked until then.`,
    );
  }
  return stripComments(source);
}

let stateCodeMemo: string | undefined;
function stateCode(): string {
  stateCodeMemo ??= readCode(STATE_URL, "state.tsx is the voice store.");
  return stateCodeMemo;
}

let stoatChannelCodeMemo: string | undefined;
function stoatChannelCode(): string {
  stoatChannelCodeMemo ??= readCode(
    STOAT_CHANNEL_URL,
    "The stoat.js submodule is not checked out: run `git submodule update --init packages/stoat.js`.",
  );
  return stoatChannelCodeMemo;
}

/**
 * A class method's whole text, from its header to the first line that is
 * exactly a two-space-indented `}` (the method's own close, as in
 * `movePolicy.test.ts`'s `#handleVoiceMove` scan), or `""`.
 */
function methodText(code: string, header: string): string {
  const at = code.indexOf(header);
  if (at < 0) return "";
  const end = code.indexOf("\n  }\n", at);
  return end < 0 ? "" : code.slice(at, end + 5);
}

test("🔴 #connectAttempt passes opts?.rejoinAttempt to joinCall as its 5th argument", () => {
  // stoat.js's `joinCall` is positional:
  // (node, forceDisconnect, recipients, deviceId, rejoin).
  const body = methodText(stateCode(), "async #connectAttempt(");
  assert.ok(
    body.includes("++this.#connectGen"),
    "no #connectAttempt body found in state.tsx — the scan below would read nothing",
  );
  const calls = [...body.matchAll(/\.joinCall\(/g)];
  assert.equal(
    calls.length,
    1,
    `expected 1 joinCall( in #connectAttempt, saw ${calls.length}`,
  );
  const call = calls[0];
  const args = topLevelItems(
    balancedGroup(body, (call.index ?? 0) + call[0].length - 1),
  );
  assert.equal(
    args.length,
    5,
    `joinCall( in #connectAttempt passes ${args.length} arguments ${JSON.stringify(args)}; the 5th is rejoin`,
  );
  assert.equal(args[4], "opts?.rejoinAttempt");
});

test("🔴 the rejoin flag is raised by the auto-rejoin loop and nowhere else", () => {
  // The rest of the wire behind the 5th argument: `connect()` hands its
  // `opts` on unchanged (third, ahead of the latched refusal a move token
  // stepped past), and the only `rejoinAttempt: true` in the store is the
  // loop's own attempt. A second one would send `rejoin: true` on a join the
  // user asked for, and a deliberate return would be turned away.
  const code = stateCode();
  const connect = methodText(code, "async connect(");
  assert.ok(
    connect.includes("this.#connectAttempt("),
    "no connect() body calling #connectAttempt found in state.tsx",
  );
  assert.ok(
    squash(connect).includes(
      "return await this.#connectAttempt(channel, auth, opts, latchedReason);",
    ),
    "connect() no longer hands its own opts to #connectAttempt",
  );
  assert.equal(
    (connect.match(/this\.#connectAttempt\(/g) ?? []).length,
    1,
    "connect() calls #connectAttempt more than once — the scan above cannot say which call carries opts",
  );
  const raised = code.match(/\brejoinAttempt: true\b/g) ?? [];
  assert.equal(
    raised.length,
    1,
    `expected exactly 1 rejoinAttempt: true in state.tsx, saw ${raised.length}`,
  );
  const loop = methodText(code, "async #autoRejoin(");
  assert.ok(
    squash(loop).includes(
      "await this.connect(channel, undefined, { rejoinAttempt: true });",
    ),
    "#autoRejoin does not pass { rejoinAttempt: true } to connect()",
  );
});

/**
 * The branch `#autoRejoin`'s catch takes on a pre-empted rejoin: the braced
 * block (or single statement) after the first non-negated
 * `if (…isRejoinPreempted(<caught>)…)`, unsquashed. `arm` is `undefined`
 * when there is no such guard; the assertions are the callers'.
 */
function preemptArm(): { arm: string | undefined; guardCall: string } {
  const body = methodText(stateCode(), "async #autoRejoin(");
  assert.ok(
    body.includes("rejoinDelayMs("),
    "no #autoRejoin body found in state.tsx — the scan below would read nothing",
  );
  const caught = /\bcatch \((\w+)\) \{/.exec(body);
  assert.ok(caught, "#autoRejoin has no `catch (error) {` block");
  const catchBlock = balancedGroup(body, caught.index + caught[0].length - 1);
  const guardCall = `isRejoinPreempted(${caught[1]})`;
  for (const m of catchBlock.matchAll(/\bif \(/g)) {
    const openAt = (m.index ?? 0) + m[0].length - 1;
    const condition = balancedGroup(catchBlock, openAt);
    const at = condition.indexOf(guardCall);
    if (at < 0 || condition[at - 1] === "!") continue;
    const rest = catchBlock.slice(openAt + condition.length).trimStart();
    return {
      arm: rest.startsWith("{")
        ? balancedGroup(rest, 0)
        : rest.slice(0, rest.indexOf(";") + 1),
      guardCall,
    };
  }
  return { arm: undefined, guardCall };
}

/** The braced pre-empt branch, asserted present; for the scans of its body. */
function preemptBlock(): string {
  const { arm, guardCall } = preemptArm();
  assert.ok(
    arm !== undefined && arm.startsWith("{") && arm.endsWith("}"),
    `#autoRejoin's catch has no braced if (…${guardCall}…) { … } branch — the scan below would read nothing`,
  );
  return arm;
}

/**
 * `block` with every `if (…) …` removed, together with its `else` chain,
 * braced or not. What is left is the branch's UNCONDITIONAL code: a
 * statement that only runs when some nested condition holds (the canceled-
 * loop early return, the snackbar-or-modal choice) does not count as
 * something the branch always does. Arrow bodies such as `batch(() => { … })`
 * are kept, because `batch` runs them synchronously.
 */
function withoutConditionals(block: string): string {
  let out = block;
  for (;;) {
    const m = /\bif \(/.exec(out);
    if (!m) return out;
    const condOpen = m.index + m[0].length - 1;
    let end = condOpen + balancedGroup(out, condOpen).length;
    for (;;) {
      const at =
        end + (out.slice(end).length - out.slice(end).trimStart().length);
      if (out[at] === "{") {
        end = at + balancedGroup(out, at).length;
      } else {
        const semi = out.indexOf(";", at);
        end = semi < 0 ? out.length : semi + 1;
      }
      const elseMatch = /^\s*else\b\s*/.exec(out.slice(end));
      if (!elseMatch) break;
      end += elseMatch[0].length;
      if (out.startsWith("if (", end))
        end += 3 + balancedGroup(out, end + 3).length;
    }
    out = out.slice(0, m.index) + out.slice(end);
  }
}

test("🔴 #autoRejoin's catch returns on isRejoinPreempted before the retry path", () => {
  // Everything after the catch is the retry: re-assert RECONNECTING, then
  // back off and dial again. The pre-empted answer must leave the loop from
  // inside the catch, on the error it caught.
  const { arm: raw, guardCall } = preemptArm();
  assert.ok(
    raw !== undefined,
    `#autoRejoin's catch has no if (…${guardCall}…) guard`,
  );
  const arm = squash(raw);
  assert.ok(
    arm.startsWith("{")
      ? /\breturn\b[^;{}]*;\s*\}$/.test(arm)
      : /^return\b/.test(arm),
    `the ${guardCall} arm does not end in a return, so the loop falls through to the retry: ${arm}`,
  );
});

test("🔴 a canceled loop's pre-empted answer changes nothing", () => {
  // `connect()` can throw after the loop was canceled: a hang-up, or a
  // join the user started meanwhile, bumped `#rejoinSeq`. Clearing the
  // channel or showing the notice then would act on the user's NEW call.
  // So the branch's first statement is the same cancellation check the loop
  // makes after every await, ahead of every side effect.
  const block = squash(preemptBlock());
  assert.match(
    block,
    /^\{ if \(seq !== this\.#rejoinSeq\) (return;|\{ return; \})/,
    `the pre-empt branch does not open with the cancellation check: ${block}`,
  );
});

test("🔴 the pre-empted call ends DISCONNECTED, never RECONNECTING", () => {
  const always = squash(withoutConditionals(preemptBlock()));
  assert.ok(
    always.includes('this.#setState("DISCONNECTED");'),
    `the pre-empt branch does not always set DISCONNECTED: ${always}`,
  );
  assert.ok(
    !always.includes('"RECONNECTING"'),
    "the pre-empt branch sets RECONNECTING — the card would promise a retry the loop will not make",
  );
});

test("🔴 the pre-empted call clears its channel, so no Rejoin card is left", () => {
  // The Rejoin card renders from DISCONNECTED with the channel still set,
  // and its button is a force-join that kicks the seat the move carried
  // elsewhere. `#setChannel()` with no argument clears it.
  const always = squash(withoutConditionals(preemptBlock()));
  assert.match(
    always,
    /this\.#setChannel\(\);/,
    `the pre-empt branch does not always clear the channel: ${always}`,
  );
  assert.ok(
    !/this\.#setChannel\(\s*[^\s)]/.test(always),
    `the pre-empt branch re-asserts a channel: ${always}`,
  );
});

test("🔴 the pre-empted notice is a SNACKBAR, and `onErr` is only the fallback", () => {
  // The same shape as the moved-elsewhere arm (`movePolicy.test.ts`): this
  // may be an idle desktop whose user carried on from a phone on purpose,
  // and a modal would sit on its screen as if something had failed. The
  // modal is only for a `Voice` built with no snackbar controller.
  const block = preemptBlock();
  assert.ok(
    squash(block).includes("const notice = t`"),
    "the pre-empt branch no longer builds its notice as a lingui `t` string",
  );
  const branch = /if \(this\.#snackbar\) \{/.exec(block);
  assert.ok(
    branch,
    "the pre-empt branch has no `if (this.#snackbar) {` — the notice has no snackbar path",
  );
  const thenAt = branch.index + branch[0].length - 1;
  const thenBlock = balancedGroup(block, thenAt);
  assert.equal(
    squash(thenBlock),
    "{ this.#snackbar.show({ message: notice, autoCloseDelay: 8000, closeable: true, messageLine: 2, }); }",
    "the snackbar branch no longer makes exactly FE-W's closeable, self-closing call",
  );
  const afterThen = block.slice(thenAt + thenBlock.length);
  const elseMatch = /^\s*else\s*\{/.exec(afterThen);
  assert.ok(
    elseMatch,
    "the `if (this.#snackbar)` branch has no `else { … }` — with no controller the notice is never shown",
  );
  const elseBlock = balancedGroup(afterThen, elseMatch[0].length - 1);
  const onErrs = block.split("this.onErr(").length - 1;
  const onErrsInElse = elseBlock.split("this.onErr(").length - 1;
  assert.ok(
    onErrsInElse >= 1,
    "the `else` fallback does not call `this.onErr(` — with no controller the user is told nothing",
  );
  assert.equal(
    onErrs,
    onErrsInElse,
    `the pre-empt branch calls \`this.onErr(\` ${onErrs} times but only ${onErrsInElse} in the \`else\` — a seat WITH a snackbar gets the modal`,
  );
  assert.ok(
    !block.includes("openModal("),
    "the pre-empt branch opens a modal directly",
  );
});

test("🔴 the pre-empted call retires all three drop-marker fields (P2-19)", () => {
  // Otherwise the move event, arriving late, still finds this session
  // "addressed" and runs the moved-elsewhere arm on top of this branch: the
  // user is told twice. The same three the moved-elsewhere arm clears.
  const always = squash(withoutConditionals(preemptBlock()));
  for (const field of [
    "#lastInvoluntaryChannelId",
    "#lastInvoluntaryLeftAt",
    "#lastInvoluntaryConnNonce",
  ])
    assert.ok(
      always.includes(`this.${field} = undefined;`),
      `the pre-empt branch does not always clear ${field}: ${always}`,
    );
});

test("🔴 stoat.js joinCall takes rejoin 5th and sends it as the body key `rejoin`", () => {
  const body = methodText(stoatChannelCode(), "async joinCall(");
  assert.ok(body.length > 0, "no joinCall method found in stoat.js Channel.ts");
  const params = topLevelItems(balancedGroup(body, body.indexOf("(")));
  // Six since the ring options were added: `rejoin` stays 5th, and the 6th is
  // the options object that carries `answer` and `video`. A new positional
  // parameter in front of either would silently shift what callers send.
  assert.equal(
    params.length,
    6,
    `stoat.js joinCall takes ${params.length} parameters ${JSON.stringify(params)}; the 5th is rejoin, the 6th the ring options`,
  );
  assert.equal(params[4], "rejoin?: boolean");
  assert.equal(params[5], "opts?: { answer?: boolean; video?: boolean }");
  const post = /\.api\.post\(/.exec(body);
  assert.ok(post, "stoat.js joinCall no longer posts through client.api.post");
  const postArgs = topLevelItems(
    balancedGroup(body, post.index + post[0].length - 1),
  );
  assert.ok(
    (postArgs[1] ?? "").includes("...(rejoin ? { rejoin: true } : {})"),
    `the join_call body does not spread ...(rejoin ? { rejoin: true } : {}): ${postArgs[1]}`,
  );
});

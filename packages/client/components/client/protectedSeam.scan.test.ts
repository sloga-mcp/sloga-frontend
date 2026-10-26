// Source-scan spec for the Protected channels seam in `e2ee.ts` (W4 lane B5,
// plan 4.3 / §7). `e2ee.ts` cannot load under Node (Solid, the native
// bridge, stoat.js), so this reads it as text and pins the wiring rules:
//
//  S1  placement: every seam member sits in the BEGIN/END block right after
//      `mlsClaimKeyPackage` and before `mlsCreateGroup` (PA#10);
//  S2  `routeMls` runs BEFORE `#deliverMlsEnvelope` / `#mlsSink` in all three
//      MLS event arms, and a ctl never reaches the text manager;
//  S3  the pre-index buffer is cleared at every `#mlsBuffer.clear()` site;
//  S4  protected ids never enter `#encryptedIds`;
//  S5  `textInvoke` is the only text-command path and refuses unless
//      `protectedTextCapable()` (and outside `TEXT_COMMANDS`);
//  S6  no edit to `NativeTransport` or any transport class (the region is
//      byte-identical to origin/main 1dcdd1b4);
//  S7  `markReady()` runs on EVERY `#onReady`, capable or not (W4a audit);
//  S8  the manager is built only once `status.device_id` is known; seeding
//      uses `Promise.allSettled`; `port.sleep` rejects after dispose;
//      dispose on the wipe and ownership paths; the D12 gate; no
//      `Idempotency-Key` and no draft-guard resolver in the seam.
//  S10 (W4c#2) decrypt requests that arrive before a manager exists are
//      held (Tauri main window only), bounded, deduped by id (live wins),
//      replayed in arrival order once `start()` settles, and cleared on
//      dispose. The hold logic is lifted out of the source and RUN.
//  S11 (W4d F#3) a strip the manager was handed is undone: a later
//      `onChannelProtected` (SDK latch clear) hands the channel over again,
//      once; forwarding stays deduped otherwise. The two hooks and
//      `#protectedForward` are lifted out of the source and RUN.
//
// Run: node --test --conditions=browser components/client/protectedSeam.scan.test.ts
// `PROTECTED_SEAM_TS=<path>` scans another copy (named controls; the
// 4363b406 e2ee.ts is the known-bad baseline and fails S1-S8).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

import {
  isProtectedSendError,
  ProtectedSendError,
  toProtectedSendError,
} from "./protectedSendError.ts";
import { TEXT_COMMANDS } from "./protectedTextTypes.ts";

const FILE =
  process.env.PROTECTED_SEAM_TS || new URL("./e2ee.ts", import.meta.url);
const SRC = readFileSync(FILE, "utf8");

/**
 * sha256 of the transport region (`interface NativeTransport` up to
 * `function resumeRecordStorage`) in `git show origin/main:<this file>` at
 * origin/main 1dcdd1b4 (v0.69.1). W4 never edits it, so the working copy
 * must match main byte for byte. Re-pinned after the main merge: main's iOS
 * work changed the region, so the W4a checkpoint 4363b406 value
 * (f34aa475...) no longer applies. Re-pin it ONLY from main, never from
 * this branch.
 */
const TRANSPORT_REGION_SHA256 =
  "f1d615dfa4dc5de12ac3af97ac1c68ff4023f109a9a9bcbd62afede7ed9b5909";

/**
 * `#encryptedIds.add(` call sites at 4363b406 and at origin/main 1dcdd1b4;
 * the seam adds none.
 */
const ENCRYPTED_IDS_ADD_SITES = 2;

/**
 * `#mlsBuffer.clear()` sites at 4363b406 (plan D4) and at origin/main
 * 1dcdd1b4.
 */
const MLS_BUFFER_CLEAR_SITES = 4;

// ---- Source helpers ---------------------------------------------------------

/**
 * Index just past the `}` matching the `{` at `open`, skipping strings,
 * template literals and comments (good enough for this file's style).
 */
function matchBrace(src: string, open: number): number {
  assert.equal(src[open], "{", "matchBrace: not at a brace");
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return src.length;
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === "\\") i++;
      }
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("matchBrace: unbalanced");
}

/** The body (braces included) of the class member declared by `head`. */
function member(src: string, head: RegExp): string {
  const m = head.exec(src);
  assert.ok(m, `member not found: ${head}`);
  // The body brace: the first "{" after the closing ")" of the parameters
  // (and after any return type).
  let i = m.index + m[0].length;
  let parens = count(m[0], "(") - count(m[0], ")");
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    if (src[i] === ")") parens--;
    if (src[i] === "{" && parens === 0) break;
  }
  return src.slice(i, matchBrace(src, i));
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** Strip `//` and block comments (strings kept) for statement checks. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const BEGIN = "// BEGIN protected seam";
const END = "// END protected seam";

function seamBlock(): string {
  const b = SRC.indexOf(BEGIN);
  const e = SRC.indexOf(END);
  assert.ok(b >= 0 && e > b, "S1: BEGIN/END protected seam markers present");
  return SRC.slice(b, e);
}

/** The seam block without comments (code only). */
function seamCode(): string {
  return stripComments(seamBlock());
}

function caseSegment(body: string, label: string): string {
  const start = body.indexOf(label);
  assert.ok(start >= 0, `case not found: ${label}`);
  const next = body.indexOf('\n      case "', start + label.length);
  return body.slice(start, next < 0 ? body.length : next);
}

// ---- S1 placement -----------------------------------------------------------

test("S1: the seam block sits right after mlsClaimKeyPackage, before mlsCreateGroup", () => {
  const claim = SRC.indexOf("\n  mlsClaimKeyPackage(");
  const create = SRC.indexOf("\n  mlsCreateGroup(");
  assert.ok(claim >= 0 && create > claim, "anchors present");
  const claimEnd = matchBrace(SRC, SRC.indexOf("{", SRC.indexOf(")", claim)));
  const b = SRC.indexOf(BEGIN);
  const e = SRC.indexOf(END);
  assert.ok(b > claimEnd && e > b && e < create, "block between the anchors");
  // Nothing but the block's banner between mlsClaimKeyPackage and BEGIN.
  const gap = SRC.slice(claimEnd, b);
  assert.match(gap, /^\s*\/\/ =+\s*$/, "block starts right after the claim");
});

test("S1: every seam member is declared inside the block", () => {
  const block = seamBlock();
  const outside = SRC.replace(block, "");
  const decl =
    /^ {2}(?:readonly |static |async |get )*(#pt\w+|#protected\w+|#textInvoke|textApi|protectedTextCapable|protectedFlag|protectedOpen|protectedClose|seatsSnapshot|disposeProtected|setProtectedOutboxKeys|handleProtectedSend|onProtectedMessage|decryptProtectedHistory|onProtectedFlagStripped|onChannelProtected|protectedChannels|protectedViews|protectedTimelineMarkers|protectedToast|protectedUi)\b(?=\s*[(<=:])/gm;
  const inBlock = [...block.matchAll(decl)].map((m) => m[1]);
  const elsewhere = [...outside.matchAll(decl)].map((m) => m[1]);
  assert.deepEqual(elsewhere, [], "no seam member outside the block");
  for (const name of [
    "#ptIndex",
    "#ptPreIndex",
    "#textInvoke",
    "textApi",
    "protectedTextCapable",
    "#protectedOnReady",
    "#protectedRouteEnvelope",
    "#protectedRouteJoinRequest",
    "handleProtectedSend",
    "onChannelProtected",
  ]) {
    assert.ok(inBlock.includes(name), `declared in the block: ${name}`);
  }
});

// ---- S2 routing before the call path ----------------------------------------

test("S2: routeMls runs before #deliverMlsEnvelope / #mlsSink in all three arms", () => {
  const onEvent = member(SRC, /\n {2}onEvent\(event: E2EEServerEvent\): void /);
  // E2EEMessage (mailbox drain) and MlsCommit|MlsWelcome|MlsCtl: the call
  // delivery is reached only when the route answered "call".
  const guarded =
    /if \(\s*sinkEvent &&\s*this\.#protectedRouteEnvelope\([^;{}]*\)\s*===\s*"call"\s*\) \{\s*this\.#deliverMlsEnvelope\(sinkEvent\);\s*\}/;
  // (`case "MlsCommit":` and `case "MlsWelcome":` fall through to the
  // `case "MlsCtl"` body.)
  for (const label of ['case "E2EEMessage"', 'case "MlsCtl"']) {
    const seg = caseSegment(onEvent, label);
    assert.match(seg, guarded, `${label}: delivery guarded by the route`);
    assert.equal(count(seg, "#deliverMlsEnvelope("), 1, `${label}: one call`);
    assert.ok(
      seg.indexOf("#protectedRouteEnvelope(") <
        seg.indexOf("#deliverMlsEnvelope("),
      `${label}: routed first`,
    );
  }
  // MlsJoinRequested: routed first, the call sink only on "call".
  const join = caseSegment(onEvent, 'case "MlsJoinRequested"');
  assert.match(
    join,
    /if \(this\.#protectedRouteJoinRequest\(request, rejoin\) !== "call"\) \{\s*break;\s*\}\s*this\.#mlsSink\?\.\(/,
    "join request: routed before the call sink",
  );
  assert.equal(count(join, "#mlsSink"), 1, "join request: one sink call");
  // No other call-path delivery anywhere in onEvent.
  assert.equal(count(onEvent, "#deliverMlsEnvelope("), 2);
  assert.equal(count(onEvent, "#mlsSink"), 1);
});

test("S2: both route helpers evaluate routeMls; a ctl never reaches text", () => {
  const env = member(SRC, /\n {2}#protectedRouteEnvelope\(/);
  const ctl = env.indexOf('"mls_ctl"');
  const route = env.indexOf("routeMls(");
  assert.ok(ctl >= 0 && route > ctl, "ctl short-circuit precedes routeMls");
  assert.match(
    env.slice(0, route),
    /if \(contentType === "mls_ctl" \|\| event\.content_type === "mls_ctl"\) \{\s*return "call";\s*\}/,
    "a ctl (either type source) goes to the call path",
  );
  assert.match(env, /kind: "envelope"/);
  const text = env.indexOf('case "text"');
  assert.ok(text > route, "text arm present");
  assert.equal(count(env, "textSinkEnvelope("), 1);
  assert.ok(env.indexOf("textSinkEnvelope(") > text, "builder only for text");
  assert.equal(count(env, ".onEnvelope("), 1);
  assert.match(env, /case "pre_index_hold":\s*this\.#ptPreIndex\.push\(/);

  const join = member(SRC, /\n {2}#protectedRouteJoinRequest\(/);
  assert.match(join, /routeMls\(\{[\s\S]*kind: "join_request"/);
  assert.match(join, /recipientDeviceId: null/);
  assert.doesNotMatch(join, /#ptPreIndex/, "join requests are never held");
});

// ---- S3 pre-index buffer cleared with #mlsBuffer ------------------------------

test("S3: the pre-index buffer is cleared at every #mlsBuffer.clear() site", () => {
  const clears = [...SRC.matchAll(/this\.#mlsBuffer\.clear\(\);/g)];
  assert.equal(clears.length, MLS_BUFFER_CLEAR_SITES, "four clear sites");
  for (const m of clears) {
    const after = SRC.slice(m.index! + m[0].length, m.index! + 200);
    assert.match(
      after,
      /^\s*this\.#ptPreIndex\.clear\(\);/,
      `pre-index cleared right after the clear at offset ${m.index}`,
    );
  }
  // Nowhere else drains or clears it except the flush.
  assert.equal(count(SRC, "#ptPreIndex.clear()"), MLS_BUFFER_CLEAR_SITES);
  assert.equal(count(SRC, "#ptPreIndex.drain()"), 1);
});

// ---- S4 #encryptedIds untouched --------------------------------------------

test("S4: protected ids never enter #encryptedIds", () => {
  const block = seamCode();
  assert.equal(count(block, "#encryptedIds"), 0, "no #encryptedIds in seam");
  for (const t of ["trustEncryptedId", "adoptTrustedRow", "#seedOnly"]) {
    assert.equal(count(block, t), 0, `no ${t} in seam`);
  }
  assert.equal(
    count(SRC, "#encryptedIds.add("),
    ENCRYPTED_IDS_ADD_SITES,
    "no new #encryptedIds.add site",
  );
});

// ---- S5 textInvoke ------------------------------------------------------------

test("S5: textInvoke is allow-listed and refuses unless protectedTextCapable()", () => {
  const body = stripComments(member(SRC, /\n {2}#textInvoke</));
  const allow = body.indexOf("TEXT_COMMANDS");
  const guard = body.indexOf("if (!this.protectedTextCapable())");
  const call = body.indexOf("this.#invoke");
  assert.ok(allow >= 0, "allow-list checked");
  assert.ok(guard >= 0, "capability checked");
  assert.ok(call > guard && call > allow, "native reached only after both");
  assert.match(
    body.slice(guard),
    /^if \(!this\.protectedTextCapable\(\)\) \{\s*return Promise\.reject\(/,
    "not capable → rejected",
  );
  // The port's invoke is textInvoke; no text command literal elsewhere.
  const port = member(SRC, /\n {2}#protectedPort\(/);
  assert.match(
    port,
    /invoke: <C extends TextCommand>\([^)]*\) =>\s*this\.#textInvoke\(cmd, args\)/,
  );
  // W4d L-IOSGATE: the names are literals now (iOS gate G6-fe-dynamic), but
  // only inside textInvoke: each one is a case label plus its own #invoke.
  const textLit = /"e2ee_text_\w+"|"e2ee_mls_group_kind"/g;
  const raw = member(SRC, /\n {2}#textInvoke</);
  assert.ok(SRC.includes(raw), "textInvoke lifted verbatim");
  assert.equal(
    [...SRC.replace(raw, "").matchAll(textLit)].length,
    0,
    "no text command named outside textInvoke",
  );
  assert.equal(
    [...body.matchAll(textLit)].length,
    2 * TEXT_COMMANDS.length,
    "one case label and one #invoke per text command, nothing else",
  );
  for (const name of TEXT_COMMANDS) {
    assert.equal(
      count(
        body,
        `case "${name}":\n        return this.#invoke<Out>("${name}", a);`,
      ),
      1,
      `${name} has exactly one arm, invoking its own name`,
    );
  }
  assert.equal(count(body, "this.#invoke"), TEXT_COMMANDS.length);
  assert.match(
    body,
    /default: \{\s*const _exhaustive: never = command;\s*return Promise\.reject\(\{ source: "client", reason: "not_allowed" \}\);\s*\}/,
    "the default is a never check that refuses",
  );
});

test("S5: protectedTextCapable is the Tauri main window with live status (D3)", () => {
  const structural = member(SRC, /\n {2}#protectedStructural\(\)/);
  assert.match(structural, /this\.#transport instanceof TauriTransport/);
  assert.match(structural, /!IS_POPOUT_WINDOW/);
  assert.match(structural, /!IS_OVERLAY_WINDOW/);
  assert.doesNotMatch(structural, /status/, "structural has no status terms");
  const capable = member(SRC, /\n {2}protectedTextCapable\(\): boolean /);
  for (const term of [
    "this.#protectedStructural()",
    "status?.enabled === true",
    "status.device_id",
    'this.storeOwnedByAnotherAccount.has("state")',
    'this.deviceOwnedElsewhere.has("state")',
  ]) {
    assert.ok(capable.includes(term), `capable reads ${term}`);
  }
});

// ---- S6 transports untouched ----------------------------------------------------

test("S6: NativeTransport and the transport classes are unchanged", () => {
  const start = SRC.indexOf("interface NativeTransport {");
  const end = SRC.indexOf("function resumeRecordStorage");
  assert.ok(start >= 0 && end > start, "transport region present");
  const sha = createHash("sha256").update(SRC.slice(start, end)).digest("hex");
  assert.equal(
    sha,
    TRANSPORT_REGION_SHA256,
    "transport region byte-identical to origin/main 1dcdd1b4",
  );
});

// ---- S7 markReady on every #onReady ---------------------------------------------

test("S7: #onReady always ends in #protectedOnReady (finally, unconditional)", () => {
  const onReady = member(SRC, /\n {2}async #onReady\(\): Promise<void> /);
  const fin = onReady.lastIndexOf("finally {");
  assert.ok(fin >= 0, "#onReady has a finally");
  const finBody = stripComments(
    onReady.slice(fin + 8, matchBrace(onReady, fin + 8)),
  );
  assert.match(
    finBody,
    /^\{\s*void this\.#protectedOnReady\(\);\s*\}$/,
    "the finally only (and always) runs the seam's ready step",
  );
});

test("S7: markReady() runs in a finally, unconditionally, after seeding", () => {
  const body = member(SRC, /\n {2}async #protectedOnReady\(\): Promise<void> /);
  const tryAt = body.indexOf("try {");
  const fin = body.lastIndexOf("finally {");
  assert.ok(tryAt >= 0 && fin > tryAt, "try/finally present");
  const tryBody = body.slice(tryAt, fin);
  assert.match(tryBody, /await Promise\.allSettled\(/, "seeding awaited");
  assert.ok(
    tryBody.indexOf("Promise.allSettled") <
      tryBody.indexOf("#protectedEnsureManager()"),
    "seeded before the manager is built",
  );
  const finBody = stripComments(body.slice(fin + 8, matchBrace(body, fin + 8)));
  assert.match(
    finBody,
    /^\{\s*this\.#ptIndex\.markReady\(\);\s*this\.#protectedFlushPreIndex\(\);\s*\}$/,
    "markReady is the first statement of the finally, under no condition",
  );
  assert.equal(count(SRC, ".markReady()"), 1, "markReady called exactly once");
});

// ---- S8 the rest of the binding notes ---------------------------------------------

test("S8: the manager is built only once status.device_id is known (and capable)", () => {
  const key = member(SRC, /\n {2}#protectedManagerKeyNow\(\)/);
  assert.match(key, /this\.protectedTextCapable\(\)/);
  assert.match(key, /device_id/);
  const ensure = stripComments(
    member(SRC, /\n {2}#protectedEnsureManager\(\): void /),
  );
  assert.match(
    ensure,
    /if \(!key \|\| !userId \|\| !deviceId\) return;[\s\S]*new ProtectedTextManager\(/,
  );
  assert.match(ensure, /owner: \{ protect, setSeats \}/);
  assert.match(
    ensure,
    /messages: \{ encryptAndSend, decryptRow, markerForError \}/,
  );
});

test("S8: port.sleep rejects on the manager's lifetime; dispose aborts it", () => {
  const port = member(SRC, /\n {2}#protectedPort\(/);
  assert.match(port, /if \(signal\.aborted \|\| life\.aborted\) \{\s*reject\(/);
  assert.match(port, /life\.addEventListener\("abort", onAbort/);
  const dispose = member(SRC, /\n {2}#protectedDispose\(\): void /);
  assert.match(dispose, /this\.#ptLife\?\.abort\(\);/);
  assert.match(dispose, /manager\.dispose\(\);/);
  // Dispose on the wipe (disable) and both ownership paths.
  assert.equal(count(SRC, 'await this.#invoke("e2ee_wipe");'), 1);
  assert.match(
    SRC,
    /await this\.#invoke\("e2ee_wipe"\);[\s\S]*?this\.#mlsBuffer\.clear\(\);\s*this\.#ptPreIndex\.clear\(\);\s*this\.#protectedDispose\(\);/,
    "disable (wipe) disposes the manager",
  );
  assert.match(
    member(SRC, /\n {2}#raiseStoreOwnedByAnotherAccount\(\): void /),
    /this\.#protectedDispose\(\);/,
  );
  assert.match(
    member(SRC, /\n {2}#noteDevicePresence\(/),
    /this\.#protectedDispose\(\);/,
  );
});

test("S8: onChannelProtected is deduped per manager; seeding is allSettled", () => {
  const fwd = member(
    SRC,
    /\n {2}#protectedForward\(channelId: string\): void /,
  );
  assert.match(fwd, /this\.#ptForwarded\.has\(channelId\)\) return;/);
  assert.match(
    member(SRC, /\n {2}onChannelProtected\(channelId: string\): void /),
    /this\.#protectedForward\(channelId\)/,
  );
});

test("S8 (W4d F#9, iOS G7): the text manager starts at each prepublish caller, not inside it", () => {
  // F#9: a shell whose call-plane media predicate is false still starts its
  // protected text plane, so the start cannot sit behind the prepublish's
  // platform gate; G7 needs that gate to stay the prepublish's first
  // statement, so the start lives at the callers.
  const pre = stripComments(
    member(SRC, /\n {2}async #prepublishMlsKeyPackages\(\)/),
  );
  assert.match(
    pre,
    /^\{\s*if \(!this\.mediaE2EEPlatformSupported\(\)\) return;/,
    "the platform gate is the prepublish's first statement",
  );
  assert.equal(count(pre, "#protectedEnsureManager"), 0, "no start inside");
  const calls = count(SRC, "this.#prepublishMlsKeyPackages()");
  assert.equal(calls, 2, "two prepublish callers (enable, re-enroll)");
  assert.equal(
    [
      ...SRC.matchAll(
        /\n {4}this\.#protectedEnsureManager\(\);\n {4}void this\.#prepublishMlsKeyPackages\(\);\n/g,
      ),
    ].length,
    calls,
    "each caller starts the manager on the line before the prepublish",
  );
});

test("S8: D12 gate, no Idempotency-Key, no draft-guard resolver", () => {
  // `!callsEnabled && !protectedWanted`, nested so the calls gate keeps the
  // statement iOS gate G7 pins (W4d L-IOSGATE).
  assert.match(
    stripComments(member(SRC, /\n {2}async #prepublishMlsKeyPackages\(\)/)),
    /if \(!this\.#protectedKeyPackagesWanted\(\)\) \{\s*if \(!this\.#callsEnabled\(\)\) return;\s*\}\s*try \{/,
  );
  const block = seamCode();
  assert.equal(count(block, "Idempotency-Key"), 0);
  assert.equal(count(SRC, "setProtectedChannelResolver"), 0);
  // The send body carries only content, reply ids and flags 0/1.
  const send = member(SRC, /\n {2}async handleProtectedSend\(/);
  assert.match(
    send,
    /if \(field === "content" \|\| field === "replies" \|\| field === "flags"\) \{\s*continue;/,
  );
  assert.match(send, /if \(flags !== 0 && flags !== 1\)/);
  // Rows map `?? null`, never undefined.
  const row = member(SRC, /\n {2}#protectedRow\(/);
  assert.match(row, /nonce: message\.nonce \?\? null/);
  assert.match(row, /encrypted: message\.encrypted \?\? null/);
});

// ---- S9 W4b audit fix round -----------------------------------------------------

test("S9 (M2): every handleProtectedSend rejection is ONE ProtectedSendError", () => {
  const send = stripComments(member(SRC, /\n {2}async handleProtectedSend\(/));
  // The whole body is one try whose catch wraps and rethrows.
  assert.match(send, /^\{\s*try \{/, "the body starts with try");
  assert.match(
    send,
    /\} catch \(error\) \{\s*throw toProtectedSendError\(error\);\s*\}\s*\}$/,
    "the catch wraps every failure and is the last statement",
  );
  assert.equal(count(send, "E2EESendError"), 0, "no developer-string error");
  assert.match(send, /throw new ProtectedFieldRefusedClient\(/, "D9b refusal");
  assert.match(send, /throw new ProtectedChannelUnavailable\(\)/);
  // Reply mention flags are validated, not silently mis-shaped.
  assert.match(
    send,
    /r\.mention !== undefined && typeof r\.mention !== "boolean"/,
  );
});

test("S9 (M2): ProtectedSendError carries the cause; wrapping is idempotent", () => {
  const failure = { source: "transport" };
  const e = new ProtectedSendError(failure);
  assert.ok(e instanceof Error);
  assert.equal(e.name, "ProtectedSendError");
  assert.equal(e.message, "ProtectedSendError", "no display copy in .message");
  assert.equal(e.failure, failure);
  assert.equal(toProtectedSendError(e), e, "never double-wrapped");
  const cause = new Error("x");
  const wrapped = toProtectedSendError(cause);
  assert.ok(wrapped instanceof ProtectedSendError);
  assert.equal(wrapped.failure, cause);
  assert.ok(isProtectedSendError(wrapped));
  assert.ok(!isProtectedSendError(cause));
  assert.ok(!isProtectedSendError({ name: "ProtectedSendError", failure }));
});

test("S9 (M4): setting the outbox accessor re-runs the orphan scan", () => {
  const set = member(SRC, /\n {2}setProtectedOutboxKeys\(/);
  assert.match(set, /this\.#ptOutboxKeys = accessor;/);
  assert.match(set, /manager\.rescanOrphans\(\);/);
});

test("S9 (d): deletes drop views; subscribed once, from #protectedOnReady", () => {
  const ready = member(
    SRC,
    /\n {2}async #protectedOnReady\(\): Promise<void> /,
  );
  assert.match(ready, /this\.#protectedSubscribeDeletes\(\);/);
  const sub = member(SRC, /\n {2}#protectedSubscribeDeletes\(\): void /);
  assert.match(
    sub,
    /if \(this\.#ptDeletesSubscribed\) return;\s*this\.#ptDeletesSubscribed = true;/,
  );
  assert.match(sub, /"messageDeleteId"/);
  assert.match(sub, /"messageDeleteBulk"/);
  assert.equal(
    count(SRC, 'this.#client.on("messageDeleteId"'),
    1,
    "one subscription",
  );
  const forget = member(SRC, /\n {2}#protectedForget\(/);
  assert.match(forget, /this\.protectedViews\.delete\(id\)/);
  assert.match(forget, /this\.#ptManager\?\.forget\(ids\)/);
});

test("S9 (L1): after seeding every indexed channel is forwarded (deduped)", () => {
  const ready = stripComments(
    member(SRC, /\n {2}async #protectedOnReady\(\): Promise<void> /),
  );
  assert.match(
    ready,
    /this\.#protectedEnsureManager\(\);\s*for \(const channelId of this\.#ptIndexed\) \{\s*this\.#protectedForward\(channelId\);\s*\}/,
  );
});

test("S9 (M3 support): disposeProtected is idempotent and final", () => {
  const dispose = member(SRC, /\n {2}disposeProtected\(\): void /);
  assert.match(
    dispose,
    /this\.#ptSignedOut = true;\s*this\.#protectedDispose\(\);/,
  );
  const ensure = member(SRC, /\n {2}#protectedEnsureManager\(\): void /);
  assert.match(
    ensure,
    /if \(this\.#ptManager \|\| this\.#ptSignedOut\) return;/,
  );
  const inner = member(SRC, /\n {2}#protectedDispose\(\): void /);
  assert.match(inner, /this\.#ptLife\?\.abort\(\);/, "null-safe abort");
  assert.match(inner, /if \(manager\) \{/, "null-safe manager dispose");
});

test("S9 (F#5): E2EEBridge.dispose() calls disposeProtected() before any return", () => {
  const body = stripComments(
    member(SRC, /\n {2}async dispose\(\): Promise<void> /),
  );
  const call = body.indexOf("this.disposeProtected();");
  const firstReturn = body.search(/\breturn\b/);
  assert.ok(call >= 0, "dispose() stops the text manager");
  assert.equal(count(body, "this.disposeProtected();"), 1, "called once");
  assert.ok(
    firstReturn < 0 || call < firstReturn,
    "called ahead of dispose()'s first return (the iOS early return)",
  );
});

// ---- S10 W4c#2 hold + replay of early decrypt requests ----------------------

/** The full declaration (head + body) of the class member `head` names. */
function memberDecl(src: string, head: RegExp): string {
  const m = head.exec(src);
  assert.ok(m, `member not found: ${head}`);
  const body = member(src, head);
  const start = m.index + (m[0].length - m[0].trimStart().length);
  return src.slice(start, src.indexOf(body, m.index) + body.length);
}

const PENDING_DECL = /\n {2}readonly #ptPending = new Map<[\s\S]*?>\(\);/;
const PENDING_MAX_DECL = /\n {2}readonly #ptPendingMax = (\d+);/;

type Row = {
  id: string;
  channelId: string;
  authorId: string;
  nonce: string | null;
  encrypted: unknown;
};
type Call = ["live", string] | ["history", string, string[]];
type Harness = {
  setManager(m: unknown): void;
  setStructural(v: boolean): void;
  signOut(): void;
  pending(): [string, boolean][];
  replay(m: unknown): void;
  onProtectedMessage(message: unknown): void;
  decryptProtectedHistory(channel: unknown, messages: unknown[]): void;
};

/**
 * A class holding the seam's REAL hold members (`#ptPending`, its bound,
 * `#protectedHoldRequests`, `#protectedEnqueue`, `#protectedReplayPending`,
 * the two hooks, `#protectedRow`), lifted from the scanned source with
 * their types stripped, plus stubs for the rest of the bridge.
 */
function harness(warn: unknown[][] = []): Harness {
  const pending = PENDING_DECL.exec(SRC);
  const max = PENDING_MAX_DECL.exec(SRC);
  assert.ok(pending && max, "S10: #ptPending and #ptPendingMax declared");
  const members = [
    /\n {2}#protectedRow\(/,
    /\n {2}onProtectedMessage\(/,
    /\n {2}decryptProtectedHistory\(/,
    /\n {2}#protectedHoldRequests\(\): boolean /,
    /\n {2}#protectedEnqueue\(/,
    /\n {2}#protectedReplayPending\(/,
  ].map((head) => memberDecl(SRC, head));
  const ts = `class Harness {
  #ptManager = null;
  #ptSignedOut = false;
  #structural = true;
  ${pending[0].trim()}
  ${max[0].trim()}
  #protectedStructural() { return this.#structural; }
  setManager(m) { this.#ptManager = m; }
  setStructural(v) { this.#structural = v; }
  signOut() { this.#ptSignedOut = true; }
  pending() { return [...this.#ptPending.values()].map((e) => [e.row.id, e.live]); }
  replay(m) { this.#protectedReplayPending(m); }
  ${members.join("\n  ")}
}`;
  const Cls = new Function(
    "errorName",
    "console",
    `${stripTypeScriptTypes(ts)}\nreturn Harness;`,
  )(String, { warn: (...a: unknown[]) => warn.push(a), error: () => {} });
  return new Cls() as Harness;
}

function msg(id: string, channelId = "C1"): Row {
  return { id, channelId, authorId: "U", nonce: null, encrypted: "CT" };
}

function recorder(): { calls: Call[]; manager: unknown } {
  const calls: Call[] = [];
  return {
    calls,
    manager: {
      onMessage: (row: Row, live: boolean) => {
        assert.equal(live, true, "replayed through onMessage only when live");
        calls.push(["live", row.id]);
      },
      decryptHistory: (channelId: string, rows: Row[]) =>
        calls.push(["history", channelId, rows.map((r) => r.id)]),
    },
  };
}

test("S10: a request with no manager is held, not dropped; live wins a dedupe", () => {
  const h = harness();
  h.decryptProtectedHistory({ id: "C1" }, [msg("a"), msg("b"), msg("x", "C2")]);
  h.onProtectedMessage(msg("c"));
  h.onProtectedMessage(msg("b")); // live supersedes the held history row
  h.decryptProtectedHistory({ id: "C1" }, [msg("c"), msg("a")]); // dupes
  h.onProtectedMessage(msg("c")); // live dupe
  assert.deepEqual(h.pending(), [
    ["a", false],
    ["c", true],
    ["b", true],
  ]);
});

test("S10: the hold is bounded; the oldest go, logged by id only", () => {
  const warn: unknown[][] = [];
  const h = harness(warn);
  const max = Number(PENDING_MAX_DECL.exec(SRC)![1]);
  assert.ok(max >= 100 && max <= 5000, `bound is sane: ${max}`);
  const rows = Array.from({ length: max + 50 }, (_, i) => msg(`m${i}`));
  h.decryptProtectedHistory({ id: "C1" }, rows);
  const held = h.pending();
  assert.equal(held.length, max, "never more than the bound");
  assert.equal(held[0][0], "m50", "the oldest 50 were dropped");
  assert.equal(held[max - 1][0], `m${max + 49}`);
  assert.equal(warn.length, 1, "one log per enqueue");
  assert.match(String(warn[0][0]), /^\[protected\] /);
  const detail = JSON.stringify(warn[0].slice(1));
  assert.ok(detail.includes('"count":50'), "counts the drops");
  assert.ok(detail.includes('"m0"'), "names dropped ids");
  assert.ok(!detail.includes("CT"), "never logs a row body");
});

test("S10: replay hands every held request over in arrival order", () => {
  const h = harness();
  h.decryptProtectedHistory({ id: "C1" }, [msg("a"), msg("b")]);
  h.decryptProtectedHistory({ id: "C2" }, [msg("x", "C2")]);
  h.onProtectedMessage(msg("c"));
  h.decryptProtectedHistory({ id: "C1" }, [msg("d")]);
  const { calls, manager } = recorder();
  h.replay(manager); // not the current manager: nothing moves
  assert.deepEqual(calls, []);
  assert.equal(h.pending().length, 5, "kept for the current manager");
  h.setManager(manager);
  h.replay(manager);
  assert.deepEqual(calls, [
    ["history", "C1", ["a", "b"]],
    ["history", "C2", ["x"]],
    ["live", "c"],
    ["history", "C1", ["d"]],
  ]);
  assert.deepEqual(h.pending(), [], "the hold is empty after replay");
  // With a manager, requests go straight to it.
  h.onProtectedMessage(msg("e"));
  h.decryptProtectedHistory({ id: "C1" }, [msg("f")]);
  assert.deepEqual(calls.slice(4), [
    ["live", "e"],
    ["history", "C1", ["f"]],
  ]);
  assert.deepEqual(h.pending(), []);
});

test("S10: a non-capable shell holds nothing; neither does a signed-out bridge", () => {
  const h = harness();
  h.onProtectedMessage(msg("a"));
  h.setStructural(false); // web / Electron / Android / iOS / popout
  h.onProtectedMessage(msg("b"));
  h.decryptProtectedHistory({ id: "C1" }, [msg("c")]);
  assert.deepEqual(h.pending(), [], "nothing held, the old entry cleared");
  const s = harness();
  s.signOut();
  s.onProtectedMessage(msg("a"));
  s.decryptProtectedHistory({ id: "C1" }, [msg("b")]);
  assert.deepEqual(s.pending(), []);
});

test("S10: replay is wired to start() settling (both arms) for that manager", () => {
  const ensure = stripComments(
    member(SRC, /\n {2}#protectedEnsureManager\(\): void /),
  );
  assert.match(
    ensure,
    /this\.#ptManager = manager;[\s\S]*const started = manager;\s*started\.start\(\)\.then\(\s*\(\) => this\.#protectedReplayPending\(started\),\s*\(error: unknown\) => \{[^}]*this\.#protectedReplayPending\(started\);\s*\},\s*\);/,
    "replay after start() resolves, and after it rejects",
  );
  assert.equal(count(SRC, "#protectedReplayPending("), 3, "decl + two arms");
  const replay = stripComments(member(SRC, /\n {2}#protectedReplayPending\(/));
  assert.match(
    replay,
    /^\{\s*if \(this\.#ptManager !== manager\) return;\s*const held = \[\.\.\.this\.#ptPending\.values\(\)\];\s*this\.#ptPending\.clear\(\);/,
    "only the current manager drains the hold",
  );
});

test("S10: the hold is cleared on dispose (wipe, latches, sign-out) and on delete", () => {
  const dispose = member(SRC, /\n {2}#protectedDispose\(\): void /);
  assert.match(dispose, /this\.#ptPending\.clear\(\);/, "dispose clears it");
  // disposeProtected (sign-out) and the wipe / latch paths all reach it (S8).
  assert.match(
    member(SRC, /\n {2}disposeProtected\(\): void /),
    /this\.#protectedDispose\(\);/,
  );
  const forget = member(SRC, /\n {2}#protectedForget\(/);
  assert.match(forget, /this\.#ptPending\.delete\(id\);/, "deleted ids go");
  // Writers: one set (enqueue); clears: dispose, non-capable, replay.
  assert.equal(count(SRC, "#ptPending.set("), 1);
  assert.equal(count(SRC, "#ptPending.clear()"), 3);
  const hold = stripComments(
    member(SRC, /\n {2}#protectedHoldRequests\(\): boolean /),
  );
  assert.match(
    hold,
    /^\{\s*if \(!this\.#protectedStructural\(\) \|\| this\.#ptSignedOut\) \{\s*this\.#ptPending\.clear\(\);\s*return false;\s*\}\s*return this\.#ptManager === null;\s*\}$/,
  );
});

// ---- S11 W4d F#3 un-strip re-forward -----------------------------------------

const FORWARDED_DECL = /\n {2}readonly #ptForwarded = new Set<string>\(\);/;
const STRIPPED_DECL = /\n {2}readonly #ptStripped = new Set<string>\(\);/;

type Hand = ["protected", string] | ["stripped", string];
type StripHarness = {
  /** The SDK latch (`client.isProtectedFlagStripped`). */
  sdk: Set<string>;
  /** Channels `#protectedIndex` cannot index. */
  unindexable: Set<string>;
  /** `#protectedEnsureManager`'s hand-over (S11 pins its two clears). */
  build(m: unknown): void;
  /** `#protectedDispose`'s bookkeeping (S11 pins its two clears). */
  drop(): void;
  stripped(): string[];
  onProtectedFlagStripped(channelId: string): void;
  onChannelProtected(channelId: string): void;
};

/**
 * A class holding the seam's REAL `#ptForwarded` / `#ptStripped`,
 * `#protectedForward` and the two SDK hooks, lifted from the scanned source
 * with their types stripped. `#protectedIndex` is an async stub (indexes
 * every channel not in `unindexable`), so hook callbacks run a tick later,
 * in event order, as with the real per-channel index promise.
 */
function stripHarness(): StripHarness {
  const forwarded = FORWARDED_DECL.exec(SRC);
  const stripped = STRIPPED_DECL.exec(SRC);
  assert.ok(
    forwarded && stripped,
    "S11: #ptForwarded and #ptStripped declared",
  );
  const members = [
    /\n {2}#protectedForward\(channelId: string\): void /,
    /\n {2}onProtectedFlagStripped\(channelId: string\): void /,
    /\n {2}onChannelProtected\(channelId: string\): void /,
  ].map((head) => memberDecl(SRC, head));
  const ts = `class StripHarness {
  #ptManager = null;
  readonly #ptIndexed = new Set();
  sdk = new Set();
  unindexable = new Set();
  #client = { isProtectedFlagStripped: (id) => this.sdk.has(id) };
  ${forwarded[0].trim()}
  ${stripped[0].trim()}
  async #protectedIndex(channelId) {
    await null;
    if (this.unindexable.has(channelId)) return false;
    this.#ptIndexed.add(channelId);
    return true;
  }
  build(m) {
    this.#ptManager = m;
    this.#ptForwarded.clear();
    this.#ptStripped.clear();
    for (const channelId of this.#ptIndexed) this.#protectedForward(channelId);
  }
  drop() {
    this.#ptManager = null;
    this.#ptForwarded.clear();
    this.#ptStripped.clear();
  }
  stripped() { return [...this.#ptStripped]; }
  ${members.join("\n  ")}
}`;
  const Cls = new Function(
    `${stripTypeScriptTypes(ts)}\nreturn StripHarness;`,
  )();
  return new Cls() as StripHarness;
}

function handRecorder(): { hands: Hand[]; manager: unknown } {
  const hands: Hand[] = [];
  return {
    hands,
    manager: {
      channelProtected: (id: string) => hands.push(["protected", id]),
      flagStripped: (id: string) => hands.push(["stripped", id]),
    },
  };
}

/** Let every pending hook callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** SDK `applyProtectedFlag`: set or clear the latch, then fire the hook. */
async function strip(h: StripHarness, id: string): Promise<void> {
  h.sdk.add(id);
  h.onProtectedFlagStripped(id);
  await settle();
}

async function reprotect(h: StripHarness, id: string): Promise<void> {
  h.sdk.delete(id);
  h.onChannelProtected(id);
  await settle();
}

test("S11 (F#3): strip then re-protect hands the channel over again", async () => {
  const h = stripHarness();
  const { hands, manager } = handRecorder();
  h.build(manager);
  await reprotect(h, "C1"); // first sight
  assert.deepEqual(hands, [["protected", "C1"]]);
  await reprotect(h, "C1"); // a later Ready: deduped
  assert.deepEqual(hands, [["protected", "C1"]], "idempotent while unstripped");
  await strip(h, "C1");
  assert.deepEqual(hands.slice(1), [["stripped", "C1"]]);
  assert.deepEqual(h.stripped(), ["C1"]);
  await reprotect(h, "C1"); // un-strip: forwarded again
  assert.deepEqual(hands.slice(2), [["protected", "C1"]]);
  assert.deepEqual(h.stripped(), [], "the tracked strip is cleared");
  await reprotect(h, "C1"); // and deduped again afterwards
  assert.equal(hands.length, 3, "one re-forward per un-strip");
  await strip(h, "C1"); // a second cycle works the same way
  await reprotect(h, "C1");
  assert.deepEqual(hands.slice(3), [
    ["stripped", "C1"],
    ["protected", "C1"],
  ]);
});

test("S11 (F#3): a strip handed over with the first forward is undone too", async () => {
  const h = stripHarness();
  // Seen before any manager: nothing is handed over, no strip tracked.
  h.sdk.add("C1");
  h.onProtectedFlagStripped("C1");
  h.onChannelProtected("C2");
  await settle();
  assert.deepEqual(h.stripped(), [], "no manager, nothing tracked");
  const { hands, manager } = handRecorder();
  h.build(manager); // #protectedEnsureManager hands over every indexed id
  assert.deepEqual(hands, [
    ["protected", "C1"],
    ["stripped", "C1"],
    ["protected", "C2"],
  ]);
  assert.deepEqual(h.stripped(), ["C1"]);
  await reprotect(h, "C1");
  assert.deepEqual(hands.slice(3), [["protected", "C1"]]);
  await reprotect(h, "C2");
  assert.equal(hands.length, 4, "C2 was never stripped: still deduped");
});

test("S11 (F#3): event order wins; a newer strip keeps the latch", async () => {
  const h = stripHarness();
  const { hands, manager } = handRecorder();
  h.build(manager);
  await reprotect(h, "C1");
  // Strip, re-protect, strip again, all before any callback ran.
  h.sdk.add("C1");
  h.onProtectedFlagStripped("C1");
  h.sdk.delete("C1");
  h.onChannelProtected("C1");
  h.sdk.add("C1");
  h.onProtectedFlagStripped("C1");
  await settle();
  assert.deepEqual(hands.slice(1), [
    ["stripped", "C1"],
    ["stripped", "C1"],
  ]);
  assert.deepEqual(h.stripped(), ["C1"], "still latched, as the SDK is");
  await reprotect(h, "C1");
  assert.deepEqual(hands.slice(3), [["protected", "C1"]]);
});

test("S11 (F#3): a rebuilt manager starts clear; unindexed ids never move", async () => {
  const h = stripHarness();
  const first = handRecorder();
  h.build(first.manager);
  await reprotect(h, "C1");
  await strip(h, "C1");
  h.drop(); // #protectedDispose
  assert.deepEqual(h.stripped(), []);
  h.sdk.delete("C1"); // un-stripped while no manager exists
  h.onChannelProtected("C1");
  await settle();
  const second = handRecorder();
  h.build(second.manager);
  assert.deepEqual(second.hands, [["protected", "C1"]], "fresh, unlatched");
  await reprotect(h, "C1");
  assert.equal(second.hands.length, 1, "nothing to undo on the new manager");
  assert.equal(first.hands.length, 2, "the old manager got nothing more");
  h.unindexable.add("C9");
  await strip(h, "C9");
  await reprotect(h, "C9");
  assert.equal(second.hands.length, 1, "an unindexed channel is never handed");
});

test("S11 (F#3): the strip set is cleared with #ptForwarded, written only here", () => {
  const pair = /this\.#ptForwarded\.clear\(\);\s*this\.#ptStripped\.clear\(\);/;
  assert.match(
    member(SRC, /\n {2}#protectedEnsureManager\(\): void /),
    pair,
    "a new manager starts with no tracked strip",
  );
  assert.match(
    member(SRC, /\n {2}#protectedDispose\(\): void /),
    pair,
    "dispose drops the tracked strips",
  );
  assert.equal(count(SRC, "#ptForwarded.clear()"), 2);
  assert.equal(count(SRC, "#ptStripped.clear()"), 2);
  // Added where a strip is handed over (forward, strip hook); dropped only
  // by the re-protect in onChannelProtected.
  assert.equal(count(SRC, "#ptStripped.add("), 2);
  assert.equal(count(SRC, "#ptStripped.delete("), 1);
  assert.equal(
    count(SRC, ".flagStripped("),
    2,
    "every strip hand-over tracked",
  );
});

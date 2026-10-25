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
//  S6  no edit to `NativeTransport` or any transport class;
//  S7  `markReady()` runs on EVERY `#onReady`, capable or not (W4a audit);
//  S8  the manager is built only once `status.device_id` is known; seeding
//      uses `Promise.allSettled`; `port.sleep` rejects after dispose;
//      dispose on the wipe and ownership paths; the D12 gate; no
//      `Idempotency-Key` and no draft-guard resolver in the seam.
//
// Run: node --test --conditions=browser components/client/protectedSeam.scan.test.ts
// `PROTECTED_SEAM_TS=<path>` scans another copy (named controls; the
// 4363b406 e2ee.ts is the known-bad baseline and fails S1-S8).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  isProtectedSendError,
  ProtectedSendError,
  toProtectedSendError,
} from "./protectedSendError.ts";

const FILE =
  process.env.PROTECTED_SEAM_TS || new URL("./e2ee.ts", import.meta.url);
const SRC = readFileSync(FILE, "utf8");

/**
 * sha256 of the transport region (`interface NativeTransport` up to
 * `function resumeRecordStorage`) at the W4a checkpoint 4363b406.
 */
const TRANSPORT_REGION_SHA256 =
  "f34aa475d3bc2c8dd58e32d0042d3ef8d48b0d00e4a4d0e1902038903c798677";

/** `#encryptedIds.add(` call sites at 4363b406; the seam adds none. */
const ENCRYPTED_IDS_ADD_SITES = 2;

/** `#mlsBuffer.clear()` sites at 4363b406 (plan D4: 1701/1898/2199/5863). */
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
  assert.equal(
    [...SRC.matchAll(/"e2ee_text_\w+"|"e2ee_mls_group_kind"/g)].length,
    0,
    "no text command named outside the typed manager",
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
  assert.equal(sha, TRANSPORT_REGION_SHA256, "transport region byte-identical");
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

test("S8: D12 gate, no Idempotency-Key, no draft-guard resolver", () => {
  assert.match(
    member(SRC, /\n {2}async #prepublishMlsKeyPackages\(\)/),
    /if \(!this\.#callsEnabled\(\) && !this\.#protectedKeyPackagesWanted\(\)\) return;/,
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
